#!/usr/bin/env bash
# scripts/start.js 的行为测试（容器主进程：信号转发、子进程退出、日志轮转）。
#
# 这一层以前完全没被测过，而它的三个毛病都只在生产容器里显现：
# server 崩了容器还"Up"（restart 策略永远不介入）、docker stop 的 SIGTERM 收不到
# （子进程被硬杀，正在写的备份/上传被截断）、/var/log 里的 stdio 日志无限增长。
# start.js 现在把 server 目录、日志上限、优雅退出超时都开成了环境变量，所以能在容器外真跑。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
START_JS="${ROOT}/scripts/start.js"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_contains() { if printf '%s' "$1" | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }

NODE_BIN=""
for cand in "${ROOT}/.tools/node20/bin/node" node; do
  if command -v "${cand}" >/dev/null 2>&1; then NODE_BIN="${cand}"; break; fi
done
if [[ -z "${NODE_BIN}" ]]; then
  echo "NOTE: 没有 node，跳过 start.js 的行为测试"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# ---------- 1) 子进程退出 → 主进程必须跟着退出（否则容器"Up"但没服务） ----------
mkdir -p "${WORK}/case1/server" "${WORK}/case1/log"
cat >"${WORK}/case1/server/main.js" <<'JS'
setTimeout(() => process.exit(7), 200);
JS
VAN_BLOG_SERVER_CWD="${WORK}/case1/server" VAN_BLOG_LOG="${WORK}/case1/log" \
  "${NODE_BIN}" "${START_JS}" >"${WORK}/case1.out" 2>&1
rc=$?
assert_eq "${rc}" "7" "子进程退出码 7 时主进程也以 7 退出（容器会被 restart 策略拉起）"
assert_contains "$(cat "${WORK}/case1.out")" "server 进程已退出" "退出时说明了原因"

# ---------- 2) SIGTERM → 转发给子进程，等它收尾后一起退出 ----------
mkdir -p "${WORK}/case2/server" "${WORK}/case2/log"
cat >"${WORK}/case2/server/main.js" <<'JS'
process.on('SIGTERM', () => {
  require('fs').appendFileSync(process.env.MARKER, 'child-got-sigterm\n');
  setTimeout(() => process.exit(0), 150);   // 模拟收尾：关连接、flush
});
setInterval(() => {}, 1000);
JS
export MARKER="${WORK}/case2.marker"
VAN_BLOG_SERVER_CWD="${WORK}/case2/server" VAN_BLOG_LOG="${WORK}/case2/log" \
  "${NODE_BIN}" "${START_JS}" >"${WORK}/case2.out" 2>&1 &
parent=$!
sleep 1
kill -TERM "${parent}" 2>/dev/null
wait "${parent}"
rc=$?
assert_eq "${rc}" "0" "收到 SIGTERM 后主进程正常退出（0）"
assert_contains "$(cat "${MARKER}" 2>/dev/null)" "child-got-sigterm" "SIGTERM 被转发给了子进程（以前只处理 SIGINT，docker stop 等于硬杀）"
assert_contains "$(cat "${WORK}/case2.out")" "优雅退出" "日志里说明了在等子进程收尾"
unset MARKER

# ---------- 3) 子进程赖着不走 → 超时后强制退出，别让 docker 等满宽限期 ----------
mkdir -p "${WORK}/case3/server" "${WORK}/case3/log"
cat >"${WORK}/case3/server/main.js" <<'JS'
process.on('SIGTERM', () => {});   // 故意不退
setInterval(() => {}, 1000);
JS
start_ts=$(date +%s)
VAN_BLOG_SERVER_CWD="${WORK}/case3/server" VAN_BLOG_LOG="${WORK}/case3/log" \
  VAN_BLOG_SHUTDOWN_TIMEOUT_MS=700 \
  "${NODE_BIN}" "${START_JS}" >"${WORK}/case3.out" 2>&1 &
parent=$!
sleep 1
kill -TERM "${parent}" 2>/dev/null
wait "${parent}"
rc=$?
end_ts=$(date +%s)
assert_eq "${rc}" "1" "子进程不退出时主进程以 1 强制结束"
assert_contains "$(cat "${WORK}/case3.out")" "强制结束" "强制结束时说清楚了"
if (( end_ts - start_ts <= 10 )); then
  pass "强制退出发生在超时之后而不是等满 docker 的 10s 宽限期"
else
  fail "退出耗时 $((end_ts - start_ts))s，超时机制可能没生效"
fi

# ---------- 4) stdio 日志轮转（/var/log 是挂到宿主机数据目录的卷，不能无限涨） ----------
mkdir -p "${WORK}/case4/server" "${WORK}/case4/log"
cat >"${WORK}/case4/server/main.js" <<'JS'
let n = 0;
const t = setInterval(() => {
  process.stdout.write('x'.repeat(2000) + '\n');
  if (++n >= 40) { clearInterval(t); process.exit(0); }
}, 5);
JS
VAN_BLOG_SERVER_CWD="${WORK}/case4/server" VAN_BLOG_LOG="${WORK}/case4/log" \
  VAN_BLOG_STDIO_LOG_MAX_BYTES=20000 \
  "${NODE_BIN}" "${START_JS}" >/dev/null 2>&1
if [[ -f "${WORK}/case4/log/vanblog-stdio.log.old" ]]; then
  pass "超过上限后轮转出 vanblog-stdio.log.old"
else
  fail "没有轮转：日志会一直追加，最终写满数据卷"
fi
if [[ -f "${WORK}/case4/log/vanblog-stdio.log" ]]; then
  pass "轮转后仍在写 vanblog-stdio.log（后台「查看日志」读的就是这个文件）"
else
  fail "轮转把 vanblog-stdio.log 弄没了，后台「查看日志」会读不到系统日志"
fi
size=$(wc -c <"${WORK}/case4/log/vanblog-stdio.log")
if (( size < 60000 )); then
  pass "当前日志文件被控制在上限附近（${size}B < 60000B）"
else
  fail "当前日志文件仍有 ${size}B，轮转没起作用"
fi

# ---------- 5) 源码层面的不变式 ----------
assert_contains "$(cat "${START_JS}")" "process.on('SIGTERM'" "处理 SIGTERM（docker stop 用的就是它）"
assert_contains "$(cat "${START_JS}")" "ctx.kill('SIGTERM')" "用 ctx.kill 转发信号"
# ⚠️ 断言前先剥注释：start.js 的文件头注释里正好引用了旧写法 `process.kill(-ctx.pid, ...)`
#    来解释为什么不能那么写，不剥就会自己匹配自己（这个坑本仓库已经踩过三次）。
START_CODE="$(sed 's#^\s*//.*##; s#^\s*\*.*##' "${START_JS}")"
if printf '%s' "${START_CODE}" | grep -qF "process.kill(-ctx.pid"; then
  fail "又用回了 process.kill(-pid)：子进程没有独立进程组，这会抛 ESRCH"
else
  pass "没有再用 process.kill(-pid)（子进程没有独立进程组，那种写法会抛 ESRCH）"
fi
assert_contains "$(cat "${START_JS}")" "vanblog-stdio.log" "仍然写 vanblog-stdio.log（log.provider.ts 要读）"

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
