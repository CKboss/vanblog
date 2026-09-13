#!/usr/bin/env bash
# 只在「构建出来的镜像」里才会暴露的两类问题：
#
# 1) **幻影依赖**（phantom dependency）：代码 import 了一个没写进 package.json 的包。
#    本地开发常常"碰巧能跑"（pnpm 的 hoist 目录、编辑器缓存、别的包顺带装了它），
#    但镜像里的 node_modules 是从 server_builder 直接 COPY 过来的严格布局，
#    于是启动即崩。真实事故：
#      Error: Cannot find module 'multer'
#      Require stack: /app/server/controller/admin/backup/backup.controller.js
#    `multer` 只被 @nestjs/platform-express 间接依赖，代码里却直接 import 了它。
#
# 2) **caddy 配置模板与新版 Caddy 不兼容**：模板里 `tls.issuance.zerossl` 带了 `email` 字段，
#    而 Alpine 仓库里较新的 Caddy 已经把这个字段去掉了，于是
#      Error: loading initial config: … tls.issuance.zerossl: json: unknown field "email"
#      Error: caddy process exited with error: exit status 1
#    —— caddy 起不来 = 整个容器没有 HTTP 入口（80/443 全挂），比 server 崩了更难查。
#    `apk add caddy` 装的是"当时的最新版"，所以这类漂移会在**重新构建镜像时**突然出现。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCKERFILE="${ROOT}/Dockerfile"
PY=$(command -v python3 || command -v python)

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }

TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

# ---------- 1) 幻影依赖扫描 ----------
"${PY}" - "${ROOT}" >"${TMP}" <<'PYCHECK'
import json, os, re, sys

root = sys.argv[1]

# Node 的内建模块（不用声明依赖）
BUILTINS = set("""assert async_hooks buffer child_process cluster console constants crypto dgram
diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks
process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty
url util v8 vm worker_threads zlib""".split())
BUILTINS |= {"node:" + b for b in list(BUILTINS)}

# import x from 'y' / export … from 'y' / require('y')
PAT = re.compile(r"""(?:^|\n)\s*(?:import[^'"]*?from|export[^'"]*?from|require\()\s*['"]([^'"./][^'"]*)['"]""")
SKIP_DIRS = {"node_modules", "dist", ".umi", ".umi-production", ".next",
             "tests", "__tests__", "coverage", "build", ".turbo"}
ASSET_EXT = (".css", ".less", ".scss", ".svg", ".png", ".jpg", ".json", ".md", ".woff", ".woff2")


def strip_comments(text):
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    return re.sub(r"(^|\n)\s*//[^\n]*", r"\1", text)


total = 0
for pkg in ["server", "website", "admin", "cli", "waline"]:
    manifest = os.path.join(root, "packages", pkg, "package.json")
    if not os.path.exists(manifest):
        continue
    with open(manifest, encoding="utf-8") as fh:
        data = json.load(fh)
    declared = set(data.get("dependencies") or {}) | set(data.get("devDependencies") or {})

    used = {}
    base = os.path.join(root, "packages", pkg)
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if not name.endswith((".ts", ".tsx", ".js", ".jsx")):
                continue
            full = os.path.join(dirpath, name)
            try:
                text = strip_comments(open(full, encoding="utf-8", errors="replace").read())
            except OSError:
                continue
            for m in PAT.finditer(text):
                spec = m.group(1)
                if spec.endswith(ASSET_EXT):
                    continue
                parts = spec.split("/")
                mod = "/".join(parts[:2]) if spec.startswith("@") else parts[0]
                used.setdefault(mod, set()).add(os.path.relpath(full, root))

    for mod in sorted(used):
        if mod in declared or mod in BUILTINS:
            continue
        # 路径别名与 umi 运行时注入的模块，不是 npm 包
        if mod in ("src", "umi", "@/", "@@/exports") or mod.startswith("@/") or mod.startswith("src/"):
            continue
        if mod.startswith("virtual:") or mod.startswith("~"):
            continue
        total += 1
        example = sorted(used[mod])[0]
        print("bad packages/%s 直接 import 了未声明的依赖 %r（例：%s）" % (pkg, mod, example))

if total == 0:
    print("ok 五个包里没有幻影依赖（import 的裸包名都在各自 package.json 里）")
PYCHECK

while read -r status rest; do
  case "${status}" in
    ok) pass "${rest}" ;;
    bad) fail "${rest}" ;;
    "") ;;
    *) fail "无法解析的扫描输出：${status} ${rest}" ;;
  esac
done <"${TMP}"

# ---------- 2) caddy 模板 ----------
CADDY="${ROOT}/caddyTemplate.json"
if [[ ! -f "${CADDY}" ]]; then
  fail "找不到 caddyTemplate.json"
else
  TMP2="$(mktemp)"
  "${PY}" - "${CADDY}" >"${TMP2}" <<'PYCADDY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as fh:
    raw = fh.read()


def out(ok, msg):
    print(("ok " if ok else "bad ") + msg)


try:
    data = json.loads(raw)
except Exception as exc:  # noqa: BLE001
    out(False, "caddyTemplate.json 不是合法 JSON：%s" % exc)
    raise SystemExit(0)

tls = data.get("apps", {}).get("tls", {}).get("automation", {})
policies = tls.get("policies") or []
issuers = [i for p in policies for i in (p.get("issuers") or [])]
modules = [i.get("module") for i in issuers]

# 新版 Caddy 的 tls.issuance.zerossl 已经没有 email 字段，带着它配置会**加载失败**，
# 结果是 caddy 进程退出、容器没有 80/443 入口（比 server 崩了更难查）。
out("zerossl" not in modules,
    "issuers 里没有 zerossl（新版 Caddy 不认它的 email 字段，会让整份配置加载失败）")
out("acme" in modules, "issuers 里有 acme（Let's Encrypt），on-demand HTTPS 才能签出证书")
out(all(i.get("email") for i in issuers if i.get("module") == "acme"),
    "acme issuer 带着 email 占位（entrypoint 会把 VAN_BLOG_EMAIL 替换掉）")
ask = (tls.get("on_demand") or {}).get("ask")
out(bool(ask), "on_demand.ask 还在（没有它就等于放开任意域名的按需证书）")
out(bool(policies and policies[0].get("on_demand") is True), "automation policy 仍是 on_demand")
if ask:
    print("ok on_demand.ask = %s" % ask)
PYCADDY
  while read -r status rest; do
    case "${status}" in
      ok) pass "${rest}" ;;
      bad) fail "${rest}" ;;
      "") ;;
      *) fail "无法解析的 caddy 检查输出：${status} ${rest}" ;;
    esac
  done <"${TMP2}"
  rm -f "${TMP2}"
fi

# ---------- 3) 镜像里 server 的依赖是从 server_builder 拷来的，multer 必须在声明里 ----------
if grep -q '"multer"' "${ROOT}/packages/server/package.json"; then
  pass "packages/server 显式声明了 multer（备份恢复上传用 diskStorage）"
else
  fail "packages/server 没有声明 multer —— 镜像里会 Cannot find module 'multer'"
fi
if grep -qE '^\s+multer:' "${ROOT}/pnpm-lock.yaml"; then
  pass "pnpm-lock.yaml 里有 multer（server_builder 走 --frozen-lockfile 也能装上）"
else
  fail "pnpm-lock.yaml 里没有 multer"
fi


# ---------- 4) 容器入口：caddy 起不来时要降级，不能让容器"在跑但没监听" ----------
ENTRY="${ROOT}/entrypoint.sh"
FALLBACK="${ROOT}/caddyFallbackTemplate.json"

if sh -n "${ENTRY}" 2>/dev/null; then
  pass "entrypoint.sh 语法正确（sh -n）"
else
  fail "entrypoint.sh 语法错误"
fi
# 不能用 set -e：caddy 失败时要降级继续，否则 restart:always 会变成崩溃循环
if grep -qE '^\s*set -e' "${ENTRY}"; then
  fail "entrypoint.sh 用了 set -e（caddy 失败会直接让容器退出，变成崩溃循环）"
else
  pass "entrypoint.sh 没有 set -e（caddy 失败可以降级继续）"
fi
grep -q 'caddy validate --config /app/caddy.json' "${ENTRY}" \
  && pass "先 caddy validate 再 start（配置不兼容时能提前发现）" \
  || fail "没有先 validate 就 start：配置错了只会看到 caddy 退出"
# ⚠️ `--adapter json` 在镜像里的 caddy 上是 `unrecognized config adapter`，
#    加了它主配置永远校验失败、每次都降级成无 TLS（实测踩过）
# ⚠️ 剥掉注释再断言：entrypoint 的注释里正好写着"不要加 --adapter json"，
#    不剥就会自己匹配自己（本仓库第七次踩这个坑）
ENTRY_CODE="$(sed 's|^[[:space:]]*#.*||' "${ENTRY}")"
if printf '%s' "${ENTRY_CODE}" | grep -q -- '--adapter json'; then
  fail "entrypoint 又加回了 --adapter json（这个 caddy 不认，会让主配置永远校验失败）"
else
  pass "caddy validate 没有画蛇添足地指定 --adapter json"
fi
# Next 13 standalone 用 HOSTNAME 决定监听地址；容器里那是容器 ID，只绑那个 IP → caddy 反代 502
WPROV="${ROOT}/packages/server/src/provider/website/website.provider.ts"
if grep -q "HOSTNAME: process.env.VANBLOG_WEBSITE_HOST || '0.0.0.0'" "${WPROV}"; then
  pass "前台子进程显式绑 HOSTNAME=0.0.0.0（否则 caddy 反代 127.0.0.1:3001 会 502，前台整站打不开）"
else
  fail "前台子进程没有显式绑 HOSTNAME：容器里 Next 只监听容器 ID 那个地址，前台会 502"
fi
grep -q 'caddyFallbackTemplate.json' "${ENTRY}" \
  && pass "主配置失败时降级到 caddyFallbackTemplate.json" \
  || fail "缺少降级路径：caddy 配置一旦不兼容，容器就没有任何监听"
grep -qE '^exec node start.js' "${ENTRY}" \
  && pass "用 exec 启动 node（PID 1 能直接收到 SIGTERM，docker stop 不会等满 10s 再 SIGKILL）" \
  || fail "node 不是 exec 启动的：docker stop 会硬杀，正在写的备份/上传会被截断"
grep -q 'vanblog_email' "${ENTRY}" \
  && pass "会识别没被替换的 EMAIL 占位符（否则 caddy 拿非法邮箱去注册 ACME）" \
  || fail "没有处理 EMAIL 占位符 vanblog_email"
grep -q 's|VAN_BLOG_EMAIL|' "${ENTRY}" \
  && pass "替换 EMAIL 用 | 当 sed 分隔符（地址里有 / 或 & 也不会写坏配置）" \
  || fail "替换 EMAIL 的 sed 分隔符不是 |"

if [[ -f "${FALLBACK}" ]]; then
  pass "仓库里有 caddyFallbackTemplate.json"
  TMP3="$(mktemp)"
  "${PY}" - "${ROOT}/caddyTemplate.json" "${FALLBACK}" >"${TMP3}" <<'PYFB'
import json, sys
main = json.load(open(sys.argv[1], encoding="utf-8"))
fb = json.load(open(sys.argv[2], encoding="utf-8"))
bad = []
if "tls" in fb.get("apps", {}):
    bad.append("降级模板里还有 apps.tls（那正是最容易随 Caddy 版本漂移而失效的部分）")
m_routes = main["apps"]["http"]["servers"]["srv0"]["routes"]
f_routes = fb["apps"]["http"]["servers"]["srv0"]["routes"]
if len(m_routes) != len(f_routes):
    bad.append("降级模板的路由数(%d)与主模板(%d)不一致，会少代理一些路径"
               % (len(f_routes), len(m_routes)))
listens = [tuple(s.get("listen") or []) for s in fb["apps"]["http"]["servers"].values()]
if (":80",) not in listens:
    bad.append("降级模板没有监听 :80")
if not any(":443" in l for l in listens):
    bad.append("降级模板没有监听 :443（自签证书也比没有强）")
if bad:
    for b in bad:
        print("bad " + b)
else:
    print("ok 降级模板：无 apps.tls、路由与主模板一致(%d 条)、同时监听 80/443" % len(f_routes))
PYFB
  while read -r st rest; do
    case "${st}" in
      ok) pass "${rest}" ;;
      bad) fail "${rest}" ;;
      "") ;;
      *) fail "无法解析的降级模板检查输出：${st} ${rest}" ;;
    esac
  done <"${TMP3}"
  rm -f "${TMP3}"
else
  fail "缺少 caddyFallbackTemplate.json"
fi

# 降级模板必须真的进镜像，否则 entrypoint 里的兜底是空的
if grep -qE '^COPY caddyFallbackTemplate\.json /app/caddyFallbackTemplate\.json$' "${DOCKERFILE}"; then
  pass "Dockerfile 把降级模板拷进了镜像"
else
  fail "Dockerfile 没有 COPY caddyFallbackTemplate.json，entrypoint 的兜底会落空"
fi

# ---------- 5) 健康检查与端口声明 ----------
if grep -qE '^EXPOSE 443$' "${DOCKERFILE}"; then
  pass "EXPOSE 443（caddy 确实监听 443，只声明 80 会误导）"
else
  fail "Dockerfile 没有 EXPOSE 443"
fi
if grep -qE '^HEALTHCHECK ' "${DOCKERFILE}"; then
  pass "有 HEALTHCHECK（前面两次事故都会表现为 unhealthy，而不是"容器在跑但打不开"）"
  # 探的必须是 caddy 的 80（覆盖整条请求路径），不是 server 的 3000
  if grep -A6 '^HEALTHCHECK ' "${DOCKERFILE}" | grep -q "port:80"; then
    pass "HEALTHCHECK 探 caddy 的 80 端口（覆盖 caddy → server/前台/后台 整条链路）"
  else
    fail "HEALTHCHECK 没有探 80 端口：caddy 挂了也检查不出来"
  fi
  if grep -A6 '^HEALTHCHECK ' "${DOCKERFILE}" | grep -q "start-period"; then
    pass "HEALTHCHECK 给了 start-period（小机器冷启动慢，不然一起来就 unhealthy）"
  else
    fail "HEALTHCHECK 没有 start-period"
  fi
  # 镜像里没有 curl，检查命令只能用 node
  if grep -A6 '^HEALTHCHECK ' "${DOCKERFILE}" | grep -qE '\bcurl\b'; then
    fail "HEALTHCHECK 用了 curl，但镜像里没装 curl（会永远 unhealthy）"
  else
    pass "HEALTHCHECK 没有依赖镜像里不存在的 curl"
  fi
else
  fail "Dockerfile 没有 HEALTHCHECK"
fi

# ---------- 6) compose 文件：日志上限、启动顺序、镜像 ----------
# Docker 默认的 json-file 驱动会把容器 stdout 无限期留着，跑几个月能把宿主机
# /var/lib/docker 那个分区写满（和数据卷不在一起，很多人根本想不到去查）。
for cf in "${ROOT}/docker-compose/docker-compose-template.yml" "${ROOT}/docker-compose/docker-compose.yml"; do
  name="$(basename "${cf}")"
  if "${PY}" - "${cf}" <<'PYCOMPOSE'
import sys
try:
    import yaml
except ImportError:
    print("skip")
    raise SystemExit(0)
data = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
svcs = data.get("services") or {}
bad = []
if "vanblog" not in svcs or "mongo" not in svcs:
    bad.append("缺少 vanblog 或 mongo 服务")
for name, svc in svcs.items():
    log = svc.get("logging") or {}
    opts = log.get("options") or {}
    if log.get("driver") != "json-file" or not opts.get("max-size") or not opts.get("max-file"):
        bad.append("%s 没有 json-file + max-size/max-file（容器日志会无限增长写满磁盘）" % name)
if "mongo" not in (svcs.get("vanblog", {}).get("depends_on") or []):
    bad.append("vanblog 没有 depends_on: mongo（首次启动会在连不上库时反复重启）")
for b in bad:
    print("bad " + b)
if not bad:
    print("ok 两个服务都有日志上限，vanblog depends_on mongo")
PYCOMPOSE
  then :; fi
done >"${TMP}.compose" 2>&1
while read -r status rest; do
  case "${status}" in
    ok) pass "compose：${rest}" ;;
    bad) fail "compose：${rest}" ;;
    skip) echo "NOTE: 没有 pyyaml，跳过 compose 结构检查" ;;
    "") ;;
    *) fail "无法解析的 compose 检查输出：${status} ${rest}" ;;
  esac
done <"${TMP}.compose"
rm -f "${TMP}.compose"

# 模板里的占位符必须都还在（脚本的 sed 靠它们）
for ph in vanblog_image vanblog_email vanblog_data_path vanblog_http_port vanblog_https_port; do
  if grep -q "${ph}" "${ROOT}/docker-compose/docker-compose-template.yml"; then
    pass "模板保留占位符 ${ph}"
  else
    fail "模板里 ${ph} 占位符不见了，脚本的 sed 会失效"
  fi
done


# ---------- 7) 容器运行时的几处加固（部署审计 2026-09）----------
# caddy 的 admin API 以前监听 0.0.0.0:2019：同一 compose 网络里的任何容器
# （或 host 网络模式下宿主机上的任何进程）都能改写全部路由与 TLS 配置。
for cf in "${ROOT}/caddyTemplate.json" "${ROOT}/caddyFallbackTemplate.json"; do
  if grep -qF '"admin":{"listen":"127.0.0.1:2019"}' "${cf}"; then
    pass "$(basename "${cf}")：caddy admin API 只监听回环"
  else
    fail "$(basename "${cf}")：caddy admin API 没有收敛到 127.0.0.1:2019"
  fi
done

# 镜像默认 EMAIL 不能是上游作者的邮箱：没设 EMAIL 的用户会拿它去注册 Let's Encrypt 账户
if grep -qF 'ENV EMAIL=""' "${DOCKERFILE}"; then
  pass "镜像默认 EMAIL 为空（不会拿上游作者的邮箱去注册 ACME 账户）"
else
  fail "镜像里仍然烘焙了非空的默认 EMAIL"
fi
if grep -qF 'vanblog@mereith.com' "${DOCKERFILE}"; then
  fail "Dockerfile 里还留着上游作者的邮箱"
else
  pass "Dockerfile 里没有上游作者的邮箱"
fi

# server 必须处理 SIGTERM：docker stop 发的就是它，只接 SIGINT 等于每次停容器都被 SIGKILL
MAIN_TS="${ROOT}/packages/server/src/main.ts"
if grep -qF "process.on('SIGTERM'" "${MAIN_TS}"; then
  pass "main.ts 处理 SIGTERM（docker stop / 更新 / 升级不再等满宽限期后被硬杀）"
else
  fail "main.ts 没有处理 SIGTERM"
fi
if grep -qF "process.on('SIGINT'" "${MAIN_TS}"; then
  pass "main.ts 仍然处理 SIGINT"
else
  fail "main.ts 丢了 SIGINT 处理"
fi

# waline 崩溃后要能自己起来（前台进程一直有这个行为，waline 没有 → 评论静默 502）
WALINE_TS="${ROOT}/packages/server/src/provider/waline/waline.provider.ts"
if grep -qF "scheduleRestart" "${WALINE_TS}"; then
  pass "waline 退出后会自动重启"
else
  fail "waline 退出后不会重启：评论会一直 502，而容器看起来是正常的"
fi
if grep -qF "restartAttempts >= 5" "${WALINE_TS}"; then
  pass "waline 自动重启有次数上限（不会崩溃循环刷日志）"
else
  fail "waline 自动重启没有次数上限"
fi
if grep -qF "this.stopping = true" "${WALINE_TS}"; then
  pass "主动 stop 时不会再自动重启"
else
  fail "主动 stop 之后还会被自动重启"
fi

# 启动时第一次连库要重试：compose 的 depends_on 只保证启动顺序，不保证 mongod 已可连接
JWT_TS="${ROOT}/packages/server/src/utils/initJwt.ts"
if grep -qF "attempt <= 10" "${JWT_TS}" || grep -qF "attempt < 10" "${JWT_TS}"; then
  pass "initJwt 连不上 MongoDB 时会重试（否则首次启动就是崩溃循环）"
else
  fail "initJwt 仍然只连一次：首次启动遇到慢 mongod 会直接崩溃循环"
fi

# 「忘记密码」的恢复密钥写在挂载到宿主机的 /var/log 下，必须 0600
INIT_TS="${ROOT}/packages/server/src/provider/init/init.provider.ts"
if grep -qF "mode: 0o600" "${INIT_TS}"; then
  pass "restore.key 以 0600 写入（/var/log 是宿主机挂载卷，0644 等于谁都能读）"
else
  fail "restore.key 没有收紧权限"
fi


# ---------- 8) 基础镜像版本：不许再用已 EOL 的 node:18 ----------
# Node 18 在 2025-04 就 EOL 了（不再有安全更新）。升到 20 是"和开发环境对齐"的最小一步：
# 本机 node v20.19.5 上 server 610 用例、admin umi build、website next build 全部验证过，
# 且 sharp 0.32.6 有 Node 20 的 prebuild（NODE_MODULE_VERSION 115）。
# 不能直接上 22/24：Node 23 移除了 util.isObject（@nestjs/cli 9 在用），
# 而 sharp 0.32.6 没有 Node 22（127）的 prebuild、runner 阶段又没装 vips-dev。
if grep -qE '^FROM node:18' "${DOCKERFILE}"; then
  fail "Dockerfile 里还有 node:18（2025-04 已 EOL，无安全更新）"
else
  pass "Dockerfile 里没有 node:18"
fi
node20_stages=$(grep -cE '^FROM node:20(-alpine)? AS ' "${DOCKERFILE}")
if [[ "${node20_stages}" -ge 4 ]]; then
  pass "四个 stage 都用 node:20（${node20_stages} 处）"
else
  fail "node:20 的 stage 只有 ${node20_stages} 个，应该至少 4 个"
fi
if grep -qE '^FROM node:(2[2-9]|[3-9][0-9])' "${DOCKERFILE}"; then
  fail "Dockerfile 用了 node:22+：@nestjs/cli 9 需要 util.isObject（Node 23 移除），且 sharp 0.32.6 没有对应 prebuild"
else
  pass "没有贸然升到 node:22+（nestjs-cli 与 sharp 都还没跟上）"
fi
if grep -q 'util.isObject' "${DOCKERFILE}" || grep -q 'sharp 0.32.6' "${DOCKERFILE}"; then
  pass "Dockerfile 里记录了不能升 22/24 的原因"
else
  fail "Dockerfile 没有说明为什么停在 node:20（下一个人会顺手升上去然后构建失败）"
fi

# ---------- 9) mongo 版本：模板用占位符，脚本按"有没有数据"决定 ----------
TEMPLATE="${ROOT}/docker-compose/docker-compose-template.yml"
if grep -q 'image: vanblog_mongo_image' "${TEMPLATE}"; then
  pass "编排模板里 mongo 是占位符（版本由脚本决定，而不是写死一个 EOL 版本）"
else
  fail "编排模板里 mongo 不是占位符 vanblog_mongo_image"
fi
if grep -qE 'image: mongo:4\.4' "${TEMPLATE}"; then
  fail "模板里还写死着 mongo:4.4（2024-02 就 EOL 了）"
else
  pass "模板里没有写死的 mongo:4.4"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
