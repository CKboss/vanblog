#!/usr/bin/env bash
# caddy 配置的性能相关约定：HTTP/2、HTTP/3(QUIC)、上游连接池、订阅源 rewrite。
#
# 背景：有人问"caddy 里用的还是不是 HTTP/1.1"。实际上 Caddy v2 在 TLS 监听上
# **默认就启用 h1+h2**，明文 :80 才是 1.1；而 **HTTP/3 默认是关的**，必须显式写
# `protocols: ["h1","h2","h3"]`，而且 QUIC 跑在 UDP 上 —— 编排文件不映射 443/udp
# 的话，浏览器永远只能用到 HTTP/2。
#
# 另一件事：所有反代都走两个本地上游（server:3000 / website:3001），Go 的
# `MaxIdleConnsPerHost` 默认只有 2，并发一上来就不停地开关上游连接，所以显式配了连接池。
#
# 顺带钉住一个真实存在的 bug：`/atom.xml` 那条路由的 rewrite 是从 `/feed.xml` 复制来的，
# find 写成了 `/feed.xml`，于是永远匹配不上，`/atom.xml` 直接 404（`/feed.xml` 却是好的，
# 所以很难被发现）。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="${ROOT}/caddyTemplate.json"
FALLBACK="${ROOT}/caddyFallbackTemplate.json"
COMPOSE="${ROOT}/docker-compose/docker-compose-template.yml"
SCRIPT="${ROOT}/scripts/vanblog.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
  echo "NOTE: 没有 python3，跳过"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

echo "== caddy：HTTP/2、HTTP/3、上游连接池、订阅源 rewrite =="

check_templates() {
  local py="$1"
  local label="$2"
  local out
  out="$(python3 -c "${py}" "${TEMPLATE}" "${FALLBACK}" 2>&1)"
  if [[ "${out}" == "OK" ]]; then
    pass "${label}"
  else
    fail "${label}（${out}）"
  fi
}

# ---------- 1) HTTP/3 的 protocols 只钉在 :443 那个 server 上 ----------
# ⚠️ 实测 caddy 2.11.4：不写 protocols 时 TLS 监听默认就是 ["h1","h2","h3"] 并且已经在发
#    alt-svc: h3。所以这条断言的意义是"钉住默认值"，不是"打开功能"；
#    真正让访客用上 HTTP/3 的是编排文件里的 UDP 443 映射（见第 4 条）。
check_templates '
import json, sys
bad = []
for p in sys.argv[1:3]:
    d = json.load(open(p, encoding="utf-8"))
    srv = d["apps"]["http"]["servers"]
    s0, s1 = srv.get("srv0", {}), srv.get("srv1", {})
    if s0.get("protocols") != ["h1", "h2", "h3"]:
        bad.append("%s: srv0.protocols=%r" % (p, s0.get("protocols")))
    if "protocols" in s1:
        bad.append("%s: srv1（明文 :80）不该开 h3，protocols=%r" % (p, s1.get("protocols")))
print("OK" if not bad else "; ".join(bad))
' "两份模板的 :443 都显式钉住 h1/h2/h3（caddy 默认就是这三个，写出来是防将来默认值变），明文 :80 没有"

# ---------- 2) 上游连接池只加在两个热点上游上 ----------
check_templates '
import json, sys
HOT = {"127.0.0.1:3000", "127.0.0.1:3001"}
bad = []
for p in sys.argv[1:3]:
    d = json.load(open(p, encoding="utf-8"))
    hot_n = waline_n = waline_with_tp = 0
    def walk(routes):
        global hot_n, waline_n, waline_with_tp
        for r in routes:
            for h in r.get("handle", []):
                if h.get("handler") == "reverse_proxy":
                    dial = (h.get("upstreams") or [{}])[0].get("dial", "")
                    tp = h.get("transport")
                    if dial in HOT:
                        hot_n += 1
                        if not tp or tp.get("protocol") != "http":
                            bad.append("%s: %s 没有 http transport" % (p, dial))
                            continue
                        ka = tp.get("keep_alive") or {}
                        if ka.get("max_idle_conns_per_host", 0) < 16:
                            bad.append("%s: %s 的 max_idle_conns_per_host 太小（Go 默认只有 2）" % (p, dial))
                        if ka.get("idle_timeout") != 60_000_000_000:
                            bad.append("%s: %s 的 idle_timeout 不是 60s（纳秒）" % (p, dial))
                        if tp.get("versions") != ["1.1"]:
                            bad.append("%s: %s 的上游版本不是 1.1（Nest/Next 不支持 h2c）" % (p, dial))
                    elif dial == "127.0.0.1:8360":
                        waline_n += 1
                        if tp:
                            waline_with_tp += 1
                        if not h.get("trusted_proxies"):
                            bad.append("%s: waline 上游丢了 trusted_proxies" % p)
                if h.get("handler") == "subroute":
                    for sr in h.get("routes", []):
                        walk([sr])
    for s in d["apps"]["http"]["servers"].values():
        walk(s["routes"])
    if hot_n < 20:
        bad.append("%s: 只给 %d 个热点上游配了连接池（应该覆盖两个 server 的全部条目）" % (p, hot_n))
    if waline_n and waline_with_tp == waline_n:
        bad.append("%s: waline 上游也被加了连接池（低流量，保持原样以便读配置）" % p)
print("OK" if not bad else "; ".join(bad[:4]))
' "热点上游（:3000/:3001）配了连接池，waline 上游保持原样且没丢 trusted_proxies"

# ---------- 3) 订阅源 rewrite：/atom.xml 曾经被写成 /feed.xml ----------
check_templates '
import json, sys
EXPECT = {
    "/feed.xml": "/rss/feed.xml",
    "/atom.xml": "/rss/atom.xml",
    "/feed.json": "/rss/feed.json",
}
bad = []
for p in sys.argv[1:3]:
    d = json.load(open(p, encoding="utf-8"))
    for name, s in d["apps"]["http"]["servers"].items():
        for r in s["routes"]:
            m = (r.get("match") or [{}])[0].get("path")
            if not m or m[0] not in EXPECT:
                continue
            found = None
            for h in r.get("handle", []):
                if h.get("handler") == "subroute":
                    for sr in h.get("routes", []):
                        for hh in sr.get("handle", []):
                            if hh.get("handler") == "rewrite":
                                for it in hh.get("uri_substring", []):
                                    found = (it.get("find"), it.get("replace"))
            want = (m[0], EXPECT[m[0]])
            if found != want:
                bad.append("%s %s %s: rewrite=%r 应为 %r" % (p, name, m[0], found, want))
print("OK" if not bad else "; ".join(bad[:4]))
' "/feed.xml、/atom.xml、/feed.json 三条 rewrite 的 find 都与路由路径一致"

# ---------- 3.5) 全局安全响应头（前台页面以前一个都没有）----------
check_templates '
import json, sys
WANT = {
    "X-Content-Type-Options": ["nosniff"],
    "Referrer-Policy": ["strict-origin-when-cross-origin"],
    "X-Frame-Options": ["SAMEORIGIN"],
}
bad = []
for p in sys.argv[1:3]:
    d = json.load(open(p, encoding="utf-8"))
    for name, s in d["apps"]["http"]["servers"].items():
        r0 = s["routes"][0]
        if r0.get("match"):
            bad.append("%s %s: route[0] 应该是无 matcher 的全局路由" % (p, name))
            continue
        hs = [h for h in r0.get("handle", []) if h.get("handler") == "headers"]
        if not hs:
            bad.append("%s %s: 全局路由里没有 headers 处理器" % (p, name))
            continue
        resp = hs[0].get("response") or {}
        got = resp.get("set") or {}
        for k, v in WANT.items():
            if got.get(k) != v:
                bad.append("%s %s: %s = %r（应为 %r）" % (p, name, k, got.get(k), v))
        if "Permissions-Policy" not in got:
            bad.append("%s %s: 缺 Permissions-Policy" % (p, name))
        # deferred 很关键：不然反代回来的响应和 caddy 自己的 5xx 都不会带上这些头
        if not resp.get("deferred"):
            bad.append("%s %s: headers 没有 deferred:true" % (p, name))
        if "Server" not in (resp.get("delete") or []):
            bad.append("%s %s: 没有 delete Server 头" % (p, name))
        # 原来的 /admin* 缓存头不能被顶掉
        admin_cache = 0
        # ⚠️ /admin* 的 headers 处理器在 **subroute 里面**，内层路由自己没有 match，
        #    所以要把外层的路径一路带下去，否则永远数不到（第一版就是这么误报的）。
        def walk(routes, outer=None):
            global admin_cache
            for r in routes:
                m = (r.get("match") or [{}])[0].get("path") or outer
                for h in r.get("handle", []):
                    if h.get("handler") == "headers" and m and any("admin" in x for x in m):
                        if (h.get("response") or {}).get("set", {}).get("Cache-Control"):
                            admin_cache += 1
                    if h.get("handler") == "subroute":
                        walk(h.get("routes", []), m)
        walk(s["routes"])
        if admin_cache < 2:
            bad.append("%s %s: /admin* 与 /api/admin* 的 Cache-Control 头少了（%d）" % (p, name, admin_cache))
print("OK" if not bad else "; ".join(bad[:4]))
' "两份模板的所有 server 都全局下发安全响应头（deferred + delete Server），且没顶掉 /admin* 的缓存头"

# ---------- 3.6) 图床图片由 caddy 直接发（不再穿过 Node）----------
check_templates '
import json, sys
IMG = ["/static/img/*.webp", "/static/img/thumb/*.webp"]
bad = []
for p in sys.argv[1:3]:
    d = json.load(open(p, encoding="utf-8"))
    for name, s in d["apps"]["http"]["servers"].items():
        routes = s["routes"]
        img_idx = proxy_idx = None
        for i, r in enumerate(routes):
            paths = (r.get("match") or [{}])[0].get("path") or []
            if any(x.startswith("/static/img/") for x in paths):
                img_idx = i
                hs = [h for h in (r.get("handle") or [])]
                if not hs or hs[0].get("handler") != "subroute":
                    bad.append("%s %s: /static/img 路由不是 subroute" % (p, name)); continue
                inner = [h.get("handler") for h in hs[0]["routes"][0]["handle"]]
                if inner != ["headers", "vars", "file_server"]:
                    bad.append("%s %s: 处理器链是 %r，应为 headers/vars/file_server" % (p, name, inner))
                hdr = hs[0]["routes"][0]["handle"][0]["response"]["set"].get("Cache-Control")
                if not hdr or "max-age=3600" not in hdr[0] or "stale-while-revalidate=604800" not in hdr[0]:
                    bad.append("%s %s: 缓存头与 server 原来发的不一致：%r" % (p, name, hdr))
                if hs[0]["routes"][0]["handle"][1].get("root") != "/app":
                    bad.append("%s %s: file_server 的 root 不是 /app" % (p, name))
                for want in IMG:
                    if want not in paths:
                        bad.append("%s %s: 少了 %s" % (p, name, want))
                # 只允许图片扩展名：附件/自定义页面/导出目录必须继续走 server
                # （那边有 nosniff、强制下载、匿名 403 等安全逻辑）
                for x in paths:
                    if not any(x.endswith(e) for e in (".webp",".png",".jpg",".jpeg",".gif",".avif",".ico")):
                        bad.append("%s %s: 匹配了非图片扩展名 %s" % (p, name, x))
                if any("/static/file" in x or "/static/export" in x or "/static/tmp" in x for x in paths):
                    bad.append("%s %s: 绝不能直服 file/export/tmp 目录" % (p, name))
            if paths == ["/static/*"]:
                proxy_idx = i
        if img_idx is None:
            bad.append("%s %s: 没有 /static/img 直服路由" % (p, name))
        if proxy_idx is None:
            bad.append("%s %s: 原来的 /static/* 反代路由不见了" % (p, name))
        elif img_idx is not None and img_idx > proxy_idx:
            bad.append("%s %s: 直服路由(%d)必须排在 /static/* 反代(%d)之前，否则永远匹配不到"
                       % (p, name, img_idx, proxy_idx))
print("OK" if not bad else "; ".join(bad[:4]))
' "两份模板都由 caddy 直发图床图片（只认图片扩展名、缓存头与 server 一致、排在 /static/* 反代之前）"

# ---------- 4) 编排文件要映射 UDP 443，否则浏览器用不上 HTTP/3 ----------
if grep -qE '^[[:space:]]*-[[:space:]]*vanblog_https_port:443/udp[[:space:]]*$' "${COMPOSE}"; then
  pass "编排模板映射了 vanblog_https_port:443/udp（QUIC 用）"
else
  fail "编排模板没有映射 443/udp，HTTP/3 永远用不上"
fi
if grep -qE '^[[:space:]]*-[[:space:]]*vanblog_https_port:443[[:space:]]*$' "${COMPOSE}"; then
  pass "TCP 443 的映射还在（UDP 是额外一条，不是替换）"
else
  fail "TCP 443 的映射丢了"
fi
if grep -q "HTTP/3" "${COMPOSE}"; then
  pass "编排模板里写清了这条 UDP 是干什么的（以及不放行也不会坏）"
else
  fail "编排模板没解释 UDP 端口的用途"
fi

# ---------- 5) 脚本能读出 HTTPS 端口并判断 QUIC 是否可用 ----------
for fn in get_compose_https_port compose_has_quic_port; do
  if grep -q "^${fn}()" "${SCRIPT}"; then
    pass "脚本里有 ${fn}"
  else
    fail "脚本里没有 ${fn}"
  fi
done
if grep -q "HTTP/3" "${SCRIPT}"; then
  pass "status 会告诉用户 HTTP/3 可不可用"
else
  fail "status 没提 HTTP/3"
fi

# 真跑一遍：用模板生成一份编排文件，确认端口解析没被新加的 UDP 行带偏
TMP="$(mktemp -d)"
mkdir -p "${TMP}/vb"
sed -e 's/vanblog_http_port/18080/g' \
  -e 's/vanblog_https_port/18443/g' \
  -e 's/vanblog_image/img/' \
  -e 's|vanblog_data_path|/tmp/data|' \
  -e 's/vanblog_mongo_image/mongo:7.0/' \
  -e 's/vanblog_email/a@b.c/' \
  "${COMPOSE}" >"${TMP}/vb/docker-compose.yaml"
GOT="$(VANBLOG_SKIP_MAIN=1 VANBLOG_BASE_PATH="${TMP}/vb" bash -c \
  "source '${SCRIPT}' >/dev/null 2>&1; echo \"\$(get_compose_http_port)|\$(get_compose_https_port)|\$(compose_has_quic_port && echo udp || echo noudp)\"")"
if [[ "${GOT}" == "18080|18443|udp" ]]; then
  pass "端口解析没被 UDP 那行带偏（得到 ${GOT}）"
else
  fail "端口解析结果不对：'${GOT}'，应为 '18080|18443|udp'"
fi
rm -rf "${TMP}"

# ---------- 6) 有 caddy 二进制就用它真校验一遍 ----------
CADDY_BIN=""
for cand in caddy /tmp/caddybin/caddy; do
  if command -v "${cand}" >/dev/null 2>&1; then CADDY_BIN="${cand}"; break; fi
done
if [[ -z "${CADDY_BIN}" ]]; then
  echo "NOTE: 本机没有 caddy 二进制，跳过 validate（CI/容器里由 entrypoint 校验）"
else
  NODE_BIN=""
  for cand in "${ROOT}/.tools/node20/bin/node" node; do
    if command -v "${cand}" >/dev/null 2>&1; then NODE_BIN="${cand}"; break; fi
  done
  if [[ -n "${NODE_BIN}" ]]; then
    for tpl in "${TEMPLATE}" "${FALLBACK}"; do
      VTMP="$(mktemp -d)"
      "${NODE_BIN}" "${ROOT}/scripts/caddyConfig.js" "${tpl}" permission admin@example.com >"${VTMP}/gen.json" 2>/dev/null
      python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
d.pop('logging',None)   # 本机没有 /var/log 写权限
json.dump(d,open(sys.argv[2],'w'),ensure_ascii=False)
" "${VTMP}/gen.json" "${VTMP}/nolog.json"
      if "${CADDY_BIN}" validate --config "${VTMP}/nolog.json" >/dev/null 2>&1; then
        pass "caddy validate 通过：$(basename "${tpl}")（permission 模式）"
      else
        fail "caddy validate 不通过：$(basename "${tpl}")"
      fi

      # ⚠️ 上面那份把 logging 整段 pop 掉了（本机没有 /var/log 写权限），所以**日志相关
      #    改动从来没被 caddy 校验过**。这里把 filename 重写到临时目录后连 logging 一起验：
      #    Caddy 对模块配置是**严格解码**的，writer 上多一个它不认识的字段就会
      #    `json: unknown field` ⇒ 整份配置被拒 ⇒ entrypoint 退回**降级模板**
      #    （自签证书、无 on-demand TLS）。也就是说"加个日志滚动参数"这种小改动，
      #    写错字段名的后果是 HTTPS 静默降级，必须真的 validate 一遍。
      python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
for lg in (d.get('logging',{}).get('logs') or {}).values():
    w=lg.get('writer') or {}
    if w.get('filename'):
        w['filename']=sys.argv[2]+'/'+w['filename'].replace('/','_')
json.dump(d,open(sys.argv[3],'w',encoding='utf-8'),ensure_ascii=False)
" "${VTMP}/gen.json" "${VTMP}" "${VTMP}/withlog.json"
      if "${CADDY_BIN}" validate --config "${VTMP}/withlog.json" >/dev/null 2>&1; then
        pass "caddy validate 通过（含 logging 段）：$(basename "${tpl}")"
      else
        fail "caddy validate 不通过（含 logging 段）：$(basename "${tpl}")：$("${CADDY_BIN}" validate --config "${VTMP}/withlog.json" 2>&1 | grep -i 'error' | head -1)"
      fi

      # 关闭访问日志后的形状（writer 换成 discard）也必须能 validate：
      # 只留 {"output":"discard"}，残留 filename/roll_* 会被严格解码拒掉。
      VANBLOG_CADDY_ACCESS_LOG=false "${NODE_BIN}" "${ROOT}/scripts/caddyConfig.js" "${tpl}" permission admin@example.com >"${VTMP}/gen-off.json" 2>/dev/null
      python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
for lg in (d.get('logging',{}).get('logs') or {}).values():
    w=lg.get('writer') or {}
    if w.get('filename'):
        w['filename']=sys.argv[2]+'/'+w['filename'].replace('/','_')
json.dump(d,open(sys.argv[3],'w',encoding='utf-8'),ensure_ascii=False)
" "${VTMP}/gen-off.json" "${VTMP}" "${VTMP}/withlog-off.json"
      if "${CADDY_BIN}" validate --config "${VTMP}/withlog-off.json" >/dev/null 2>&1; then
        pass "caddy validate 通过（访问日志关闭 = discard writer）：$(basename "${tpl}")"
      else
        fail "caddy validate 不通过（访问日志关闭）：$(basename "${tpl}")：$("${CADDY_BIN}" validate --config "${VTMP}/withlog-off.json" 2>&1 | grep -i 'error' | head -1)"
      fi

      # 反证：discard writer 上残留 file 专有字段时，validate 必须失败。
      # 没有这条，上面"关闭访问日志"的 PASS 可能只是因为 caddy 根本没在看 logging。
      python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
d['logging']['logs']['log0']['writer']={'output':'discard','filename':'/tmp/x.log','roll_size_mb':100}
json.dump(d,open(sys.argv[2],'w',encoding='utf-8'),ensure_ascii=False)
" "${VTMP}/withlog-off.json" "${VTMP}/bad.json"
      if "${CADDY_BIN}" validate --config "${VTMP}/bad.json" >/dev/null 2>&1; then
        fail "（反证失败）discard writer 上残留 filename/roll_size_mb 时 caddy 居然通过了 —— 那说明本机 caddy 不是严格解码，caddyConfig.js 里那条注释与'整体替换 writer'的做法需要重新评估"
      else
        pass "（反证）discard writer 上残留 file 字段会被 caddy 拒掉 ⇒ 关闭访问日志时必须整体替换 writer 对象"
      fi
      rm -rf "${VTMP}"
    done
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 超时 / 头大小上限 / 上游连接池 / 日志滚动（敌意环境下的连接层防线）
#
# ⚠️ 这一节全部**解析 JSON 读值**，不 grep 子串：grep 只能证明"这几个字出现过"，
#    证明不了"值是多少"，也证明不了"没有出现"。
# ─────────────────────────────────────────────────────────────────────────────
echo "== 超时与连接层 =="

# Node 侧的 keepAliveTimeout 默认值（跨文件不变量：caddy 的空闲超时必须比它短，
# 否则就是 main.ts 注释里记过的那个偶发 ECONNRESET/502 竞态）
NODE_MAIN="${ROOT}/packages/server/src/main.ts"
NODE_KA="$(python3 -c "
import re,sys
t=open(sys.argv[1],encoding='utf-8').read()
m=re.search(r\"VANBLOG_KEEP_ALIVE_TIMEOUT_MS'\s*,\s*(\d+)\", t)
print(m.group(1) if m else '')
" "${NODE_MAIN}" 2>/dev/null)"
if [[ -z "${NODE_KA}" ]]; then
  fail "读不到 Node 的 keepAliveTimeout 默认值（${NODE_MAIN} 里的 VANBLOG_KEEP_ALIVE_TIMEOUT_MS）—— 跨文件不变量无法校验，请更新这条守卫的正则而不是删掉它"
else
  pass "读到 Node keepAliveTimeout 默认值 = ${NODE_KA}ms（下面用它校验 caddy 侧必须更短）"
fi

for tpl in "${TEMPLATE}" "${FALLBACK}"; do
  base="$(basename "${tpl}")"
  RES="$(NODE_KA="${NODE_KA:-0}" python3 - "${tpl}" <<'PY'
import json, os, sys

NS = 1_000_000_000
d = json.load(open(sys.argv[1], encoding='utf-8'))
node_ka_ms = int(os.environ.get('NODE_KA') or 0)
bad = []
ok = []

servers = d['apps']['http']['servers']
for sname, s in servers.items():
    listen = ','.join(s.get('listen') or [])

    # 1) read_header_timeout：slowloris 的主要防线（Caddy 默认 1 分钟）
    rh = s.get('read_header_timeout')
    if rh != 10 * NS:
        bad.append('%s/%s read_header_timeout=%r（要 10s=10000000000）' % (sname, listen, rh))
    else:
        ok.append('read_header_timeout=10s')

    # 2) idle_timeout：必须显式设，且必须 < Node 的 keepAliveTimeout
    it = s.get('idle_timeout')
    if it is None:
        bad.append('%s/%s 缺 idle_timeout（Caddy 默认 5 分钟，攻击者可长期停空闲连接）' % (sname, listen))
    elif it >= node_ka_ms * 1_000_000:
        # ⚠️ 单位：node_ka_ms 是**毫秒**，it 是**纳秒** ⇒ 乘 1e6，不是乘 NS(1e9)。
        #    这里曾经写成 `node_ka_ms * NS`，阈值被放大 1000 倍（65000 秒），
        #    于是"把 idle_timeout 抬到 120s"这个变异对照**居然是绿的** —— 一条看似
        #    在跨文件校验不变量、实际恒真的断言。变异对照就是用来抓这种东西的。
        bad.append('%s/%s idle_timeout=%dns 不小于 Node keepAliveTimeout=%dms（会复现 ECONNRESET/502 竞态）'
                   % (sname, listen, it, node_ka_ms))
    else:
        ok.append('idle_timeout=%ds<node%dms' % (it // NS, node_ka_ms))

    # 3) max_header_bytes：必须显式设且远小于 Go 默认的 1MB
    mhb = s.get('max_header_bytes')
    if mhb is None:
        bad.append('%s/%s 缺 max_header_bytes（Go 默认 1MB ⇒ 一万条连接就是 10GB 级内存放大）' % (sname, listen))
    elif mhb >= 1024 * 1024:
        bad.append('%s/%s max_header_bytes=%d 没有比 Go 默认(1MB)更严' % (sname, listen, mhb))
    else:
        ok.append('max_header_bytes=%d' % mhb)

    # 4) ⚠️ read_timeout / write_timeout 必须**不存在**。
    #    同一个 server 上挂着匿名的整站恢复上传（8GiB）、图片(50MB)与附件(200MB)，
    #    以及整站备份下载。设了有限值就会把大恢复/大下载切断 —— 这是"看起来更安全、
    #    实际上把灾难恢复弄坏"的典型，所以钉成"不许出现"。
    for k in ('read_timeout', 'write_timeout'):
        if k in s:
            bad.append('%s/%s 出现了 %s=%r —— 会切断 8GiB 整站恢复上传与大文件下载，必须删掉'
                       % (sname, listen, k, s[k]))
    ok.append('无 read_timeout/write_timeout')

    # 5) ⚠️ 不许写成 Caddyfile 那种 {"timeouts": {...}} 包装对象：Caddy 的 JSON 里
    #    超时是 server 上的**扁平字段**，写成包装对象会因未知字段被严格解码拒绝 ⇒
    #    entrypoint validate 失败 ⇒ 退回降级模板（自签证书、无 on-demand TLS）。
    if 'timeouts' in s:
        bad.append('%s/%s 出现了 timeouts 包装对象（Caddy JSON 里超时是扁平字段，这份配置会被 validate 拒掉）'
                   % (sname, listen))

    # 6) 热点上游（:3000/:3001）的连接池必须够大；waline(:8360) 保持无 transport（见上一节）
    hot = []
    def walk(o):
        if isinstance(o, dict):
            if o.get('handler') == 'reverse_proxy':
                ups = [u.get('dial', '') for u in (o.get('upstreams') or [])]
                if any(u.endswith(':3000') or u.endswith(':3001') for u in ups):
                    ka = ((o.get('transport') or {}).get('keep_alive') or {})
                    hot.append((ka.get('max_idle_conns'), ka.get('max_idle_conns_per_host')))
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(s.get('routes'))
    if len(hot) < 10:
        bad.append('%s 只找到 %d 个热点反代块（应该 14 个）' % (sname, len(hot)))
    for mic, miph in hot:
        if not mic or mic < 1024:
            bad.append('%s 热点上游 max_idle_conns=%r 太小（要 >=1024，原值 64 会让高并发后连接全关）' % (sname, mic))
        if not miph or miph < 512:
            bad.append('%s 热点上游 max_idle_conns_per_host=%r 太小（要 >=512，原值 32 是 TIME_WAIT 暴涨的根因）' % (sname, miph))
    if hot and not bad:
        ok.append('热点池=%d/%d' % hot[0])

# 7) 日志滚动：显式写出 Caddy 的默认值（100MB/10 份/90 天），并限制 writer 只用
#    "历史悠久"的字段 —— 镜像里的 caddy 是 apk 装的、版本会漂，而 Caddy 对模块配置是
#    **严格解码**：多一个旧版不认识的字段，整份配置就会被拒 ⇒ 退回降级模板。
ALLOWED_WRITER_KEYS = {
    'output', 'filename', 'roll_size_mb', 'roll_keep', 'roll_keep_days',
    'roll_local_time', 'roll_gzip', 'roll_interval',
}
for name, lg in (d.get('logging', {}).get('logs') or {}).items():
    w = lg.get('writer') or {}
    if w.get('output') != 'file':
        continue
    unknown = set(w) - ALLOWED_WRITER_KEYS
    if unknown:
        bad.append('logger %s 的 writer 含有较新/未知字段 %s —— 旧版 caddy 严格解码会整份拒绝，'
                   '请先确认镜像里的 caddy 版本支持再放行' % (name, sorted(unknown)))
    for k, want in (('roll_size_mb', 100), ('roll_keep', 10), ('roll_keep_days', 90)):
        if w.get(k) != want:
            bad.append('logger %s 的 %s=%r（要显式写 %d，否则随 caddy 版本默认值漂移）'
                       % (name, k, w.get(k), want))
ok.append('日志滚动 100MB/10/90d 已显式钉住')

print('OK:' + '; '.join(sorted(set(ok))) if not bad else 'BAD:' + '; '.join(bad[:6]))
PY
)"
  case "${RES}" in
    OK:*)  pass "${base}：${RES#OK:}" ;;
    BAD:*) fail "${base}：${RES#BAD:}" ;;
    *)     fail "${base}：超时/连接池检查没有产出结果（脚本本身坏了？）：${RES}" ;;
  esac
done

# 反证：把 read_header_timeout 改回 Caddy 默认（=删掉）时，上面的检查必须报 BAD。
# ⚠️ 没有这条，上面那些断言可能恒真（例如 python 脚本静默失败但输出被当成 OK）。
MUT="$(mktemp -d)"
python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
for s in d['apps']['http']['servers'].values():
    s.pop('read_header_timeout',None)
    s['read_timeout']=10000000000   # 同时犯两个错：删掉 read_header、加上 read_timeout
json.dump(d,open(sys.argv[2],'w',encoding='utf-8'),ensure_ascii=False)
" "${TEMPLATE}" "${MUT}/mutated.json"
MUTRES="$(NODE_KA="${NODE_KA:-0}" python3 - "${MUT}/mutated.json" <<'PY'
import json, os, sys
NS=1_000_000_000
d=json.load(open(sys.argv[1],encoding='utf-8'))
bad=[]
for sname,s in d['apps']['http']['servers'].items():
    if s.get('read_header_timeout') != 10*NS: bad.append('read_header_timeout')
    if 'read_timeout' in s: bad.append('read_timeout 出现了')
print('DETECTED' if bad else 'MISSED')
PY
)"
if [[ "${MUTRES}" == "DETECTED" ]]; then
  pass "（反证）删掉 read_header_timeout 并加上 read_timeout 后，检查器确实报错 —— 上面那些断言不是恒真"
else
  fail "（反证失败）把配置改坏后检查器仍然放行（得到 '${MUTRES}'）⇒ 上面那节断言是恒真的，等于没有守卫"
fi
rm -rf "${MUT}"

# ---------- HSTS max-age 可配置：真 caddy validate + 产出值核对 ----------
# ⚠️ 为什么必须真 validate：Caddy 对模块配置是**严格解码**的，headers handler 里写错一个
#    字段名，整份配置就会被拒 ⇒ entrypoint 退回**降级模板**（自签证书、无 on-demand TLS）。
#    也就是说"把 max-age 做成可配置"这种小改动，写错的后果是 **HTTPS 静默降级**。
CADDY_BIN_HSTS=""
for cand in caddy /tmp/caddybin/caddy; do
  command -v "${cand}" >/dev/null 2>&1 && CADDY_BIN_HSTS="${cand}" && break
done
NODE_BIN_HSTS=""
for cand in "${ROOT}/.tools/node20/bin/node" node; do
  command -v "${cand}" >/dev/null 2>&1 && NODE_BIN_HSTS="${cand}" && break
done
if [[ -z "${CADDY_BIN_HSTS}" || -z "${NODE_BIN_HSTS}" ]]; then
  echo "NOTE: 没有 caddy 二进制或 node，跳过 HSTS 的 validate 环节"
else
  HTMP="$(mktemp -d)"
  # 值 -> 期望的 srv0 HSTS 头（'none' = 不下发）
  for spec in "__unset__:max-age=31536000" "0:none" "86400:max-age=86400" "63072000:max-age=63072000" "315360000:max-age=63072000"; do
    HV="${spec%%:*}"
    WANT="${spec#*:}"
    if [[ "${HV}" == "__unset__" ]]; then
      env -u VANBLOG_HSTS_MAX_AGE "${NODE_BIN_HSTS}" "${ROOT}/scripts/caddyConfig.js" "${TEMPLATE}" permission admin@example.com >"${HTMP}/g.json" 2>/dev/null
    else
      VANBLOG_HSTS_MAX_AGE="${HV}" "${NODE_BIN_HSTS}" "${ROOT}/scripts/caddyConfig.js" "${TEMPLATE}" permission admin@example.com >"${HTMP}/g.json" 2>/dev/null
    fi
    # 把日志文件重写到临时目录（本机没有 /var/log 写权限），保留 logging 段一起校验
    python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
for lg in (d.get('logging',{}).get('logs') or {}).values():
    w=lg.get('writer') or {}
    if w.get('filename'): w['filename']=sys.argv[2]+'/'+w['filename'].replace('/','_')
json.dump(d,open(sys.argv[3],'w',encoding='utf-8'),ensure_ascii=False)" "${HTMP}/g.json" "${HTMP}" "${HTMP}/v.json"
    # ① 真 caddy validate
    if "${CADDY_BIN_HSTS}" validate --config "${HTMP}/v.json" >/dev/null 2>&1; then
      pass "caddy validate 通过：VANBLOG_HSTS_MAX_AGE='${HV}' 生成的配置合法（不会触发降级模板）"
    else
      fail "caddy validate 不通过：VANBLOG_HSTS_MAX_AGE='${HV}'：$("${CADDY_BIN_HSTS}" validate --config "${HTMP}/v.json" 2>&1 | grep -i error | head -1)"
    fi
    # ② 产出值核对（解析 JSON，不 grep 子串）
    GOT="$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
srv=d['apps']['http']['servers']
def hsts(name):
    for r in (srv.get(name) or {}).get('routes') or []:
        for h in r.get('handle') or []:
            if h.get('handler')=='headers':
                for op in ('set','add'):
                    bag=(h.get('response') or {}).get(op) or {}
                    if 'Strict-Transport-Security' in bag:
                        v=bag['Strict-Transport-Security']
                        return '; '.join(v) if isinstance(v,list) else str(v)
    return 'none'
print('srv0=%s srv1=%s' % (hsts('srv0'), hsts('srv1')))" "${HTMP}/g.json")"
    if [[ "${GOT}" == "srv0=${WANT} srv1=none" ]]; then
      pass "VANBLOG_HSTS_MAX_AGE='${HV}' ⇒ srv0(${WANT})、srv1 不下发"
    else
      fail "VANBLOG_HSTS_MAX_AGE='${HV}' 的产出不对：得到 '${GOT}'，应为 'srv0=${WANT} srv1=none'"
    fi
  done
  # ③ 降级模板设了变量也不该长出 HSTS，且仍然 validate 通过
  VANBLOG_HSTS_MAX_AGE=86400 "${NODE_BIN_HSTS}" "${ROOT}/scripts/caddyConfig.js" "${FALLBACK}" permission admin@example.com >"${HTMP}/f.json" 2>/dev/null
  FB_GOT="$(grep -c 'Strict-Transport-Security' "${HTMP}/f.json")"
  if [[ "${FB_GOT}" == "0" ]]; then
    pass "降级模板即使设了 VANBLOG_HSTS_MAX_AGE 也不会长出 HSTS（生成器只改已存在的键、绝不新建）"
  else
    fail "降级模板出现了 HSTS（${FB_GOT} 处）—— 自签证书路径上钉 HSTS 会把站长锁在站外"
  fi
  python3 -c "
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
for lg in (d.get('logging',{}).get('logs') or {}).values():
    w=lg.get('writer') or {}
    if w.get('filename'): w['filename']=sys.argv[2]+'/'+w['filename'].replace('/','_')
json.dump(d,open(sys.argv[3],'w',encoding='utf-8'),ensure_ascii=False)" "${HTMP}/f.json" "${HTMP}" "${HTMP}/fv.json"
  if "${CADDY_BIN_HSTS}" validate --config "${HTMP}/fv.json" >/dev/null 2>&1; then
    pass "caddy validate 通过：降级模板（设了 HSTS 变量）仍然合法"
  else
    fail "caddy validate 不通过：降级模板（设了 HSTS 变量）"
  fi
  rm -rf "${HTMP}"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
