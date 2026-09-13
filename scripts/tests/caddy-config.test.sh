#!/usr/bin/env bash
# scripts/caddyConfig.js 的单元测试 + entrypoint 的自适应逻辑契约。
#
# 背景：Caddy 2.11 把 on-demand TLS 的 `ask` 换成了 `permission` 模块，
# 用旧写法 caddy 会拒绝加载**整份**配置（"cannot be enabled without a permission module"），
# 结果就是 HTTPS 全废、只能靠降级配置跑 HTTP。镜像里的 caddy 是 apk 装的、版本会漂，
# 所以不猜版本：两种形式都生成，让 caddy 自己 validate 挑。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="${ROOT}/scripts/caddyConfig.js"
TEMPLATE="${ROOT}/caddyTemplate.json"
FALLBACK="${ROOT}/caddyFallbackTemplate.json"
ENTRY="${ROOT}/entrypoint.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }

NODE_BIN=""
for cand in "${ROOT}/.tools/node20/bin/node" node; do
  if command -v "${cand}" >/dev/null 2>&1; then NODE_BIN="${cand}"; break; fi
done
if [[ -z "${NODE_BIN}" ]]; then
  echo "NOTE: 没有 node，跳过 caddyConfig.js 的测试"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

echo "== caddyConfig.js =="

run_helper() { # mode email -> stdout
  "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" "$1" "$2"
}

# --- permission 形式（Caddy ≥2.11）---
OUT="$(run_helper permission 'me@example.com')"
assert_eq "$(printf '%s' "${OUT}" | "${NODE_BIN}" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const od=JSON.parse(s).apps.tls.automation.on_demand;
  console.log(JSON.stringify(od));
});')" '{"permission":{"module":"http","endpoint":"http://127.0.0.1:3000/api/admin/caddy/ask"}}' \
  "permission 模式产出 caddy 2.11 认的结构（module=http + endpoint）"

# --- ask 形式（老 caddy）---
assert_eq "$(run_helper ask 'me@example.com' | "${NODE_BIN}" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const od=JSON.parse(s).apps.tls.automation.on_demand;
  console.log(JSON.stringify(od));
});')" '{"ask":"http://127.0.0.1:3000/api/admin/caddy/ask"}' \
  "ask 模式产出老版本 caddy 认的结构"

# --- 两种模式都必须是合法 JSON，且路由数量与模板一致 ---
for m in permission ask; do
  RES="$(run_helper "${m}" 'me@example.com' | "${NODE_BIN}" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const c=JSON.parse(s);
  const t=require("fs").readFileSync(process.argv[1],"utf8");
  const n0=JSON.parse(t).apps.http.servers.srv0.routes.length;
  console.log(c.apps.http.servers.srv0.routes.length===n0 ? "ok" : "routes-mismatch");
});' "${TEMPLATE}")"
  assert_eq "${RES}" "ok" "${m} 模式：输出是合法 JSON 且路由数与模板一致"
done

# --- 邮箱替换是在对象上做的，不是文本替换 ---
assert_eq "$(run_helper permission 'a&b@x.com' | grep -o 'a&b@x.com' | head -1)" "a&b@x.com" \
  "邮箱里的 & 原样保留（sed 会把它展开成整个匹配）"
assert_eq "$(run_helper permission 'a"b@x.com' >/dev/null 2>&1; echo $?)" "0" \
  "邮箱里有引号也不会把 JSON 写坏（退出码 0）"
run_helper permission 'a"b@x.com' | "${NODE_BIN}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{JSON.parse(s);console.log("ok")})' \
  | grep -q ok && pass "带引号的邮箱产出的仍是合法 JSON" || fail "带引号的邮箱产出的不是合法 JSON"
assert_eq "$(run_helper permission '' | grep -c 'VAN_BLOG_EMAIL')" "0" \
  "空邮箱也会把占位符换掉（caddy 的 acme issuer 允许没有联系邮箱）"

# --- 参数校验 ---
"${NODE_BIN}" "${HELPER}" >/dev/null 2>&1
assert_eq "$?" "2" "参数不对时退出码 2（不会静默产出空配置）"
"${NODE_BIN}" "${HELPER}" "${TEMPLATE}" bogus 'a@b.c' >/dev/null 2>&1
assert_eq "$?" "2" "未知模式被拒绝"

# --- 降级模板也能被处理（它没有 apps.tls，不该报错）---
"${NODE_BIN}" "${HELPER}" "${FALLBACK}" permission 'me@example.com' | "${NODE_BIN}" -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);console.log(c.apps.tls?"has-tls":"no-tls")})' \
  | grep -q "no-tls" && pass "降级模板（无 apps.tls）也能正常处理" \
  || fail "降级模板处理出错"

echo "== entrypoint 的自适应逻辑 =="
ENTRY_CODE="$(sed 's|^[[:space:]]*#.*||' "${ENTRY}")"
if printf '%s' "${ENTRY_CODE}" | grep -q "for MODE in permission ask"; then
  pass "两种形式都会试（不按版本号猜）"
else
  fail "没有遍历 permission/ask 两种形式"
fi
if printf '%s' "${ENTRY_CODE}" | grep -q "caddyConfig.js"; then
  pass "用 caddyConfig.js 生成配置（而不是文本 sed）"
else
  fail "没有用 caddyConfig.js 生成配置"
fi
if printf '%s' "${ENTRY_CODE}" | grep -q -- "--adapter json"; then
  fail "又加回了 --adapter json（这个 caddy 不认，会让主配置永远校验失败）"
else
  pass "validate 没有画蛇添足地指定 --adapter"
fi
if printf '%s' "${ENTRY_CODE}" | grep -q "caddy validate --config /app/caddy.json"; then
  pass "每种形式都先 validate 再 start"
else
  fail "没有先 validate 就 start"
fi
if grep -q "COPY ./scripts/caddyConfig.js /app/caddyConfig.js" "${ROOT}/Dockerfile"; then
  pass "Dockerfile 把 caddyConfig.js 拷进了镜像"
else
  fail "Dockerfile 没有 COPY caddyConfig.js，entrypoint 会找不到它"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
