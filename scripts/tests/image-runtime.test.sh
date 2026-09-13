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

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
