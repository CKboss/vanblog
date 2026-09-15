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
      rm -rf "${VTMP}"
    done
  fi
fi

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
