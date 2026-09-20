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

# ---------- 6) 重启风暴熔断：连续快速崩溃后，退出前要退避 ----------
# ⚠️ 参数调小以便测试在 1 秒内跑完；默认值是窗口 10 分钟 / 阈值 5 次 / 退避 5s 起封顶 5 分钟。
STORM_LOG="${WORK}/case-storm/log"
STORM_SRV="${WORK}/case-storm/server"
mkdir -p "${STORM_LOG}" "${STORM_SRV}"
cat >"${STORM_SRV}/main.js" <<'JS'
process.exit(9);
JS
run_storm() {
  local t0 t1
  t0=$(date +%s%3N)
  VAN_BLOG_SERVER_CWD="${STORM_SRV}" VAN_BLOG_LOG="${STORM_LOG}" \
    VANBLOG_MAX_FAST_CRASHES=3 VANBLOG_CRASH_BACKOFF_BASE_MS=300 \
    VANBLOG_CRASH_BACKOFF_MAX_MS=2000 VANBLOG_FAST_CRASH_MS=60000 \
    "${NODE_BIN}" "${START_JS}" >>"${WORK}/case-storm.out" 2>&1
  STORM_RC=$?
  t1=$(date +%s%3N)
  STORM_MS=$((t1 - t0))
}

run_storm; MS1=${STORM_MS}; RC1=${STORM_RC}
run_storm; MS2=${STORM_MS}
run_storm; MS3=${STORM_MS}; RC3=${STORM_RC}
run_storm; MS4=${STORM_MS}

if [[ ${MS3} -ge 250 ]]; then
  pass "第 3 次快速崩溃后退出前退避了（${MS3}ms ≥ 250ms，阈值 3 次）"
else
  fail "第 3 次快速崩溃没有退避（只用了 ${MS3}ms）"
fi
if [[ ${MS4} -gt ${MS3} ]]; then
  pass "第 4 次退避更长（指数：${MS4}ms > ${MS3}ms）"
else
  fail "第 4 次退避没有增长（${MS4}ms vs ${MS3}ms）—— 指数退避失效"
fi
if [[ ${MS1} -lt 250 ]]; then
  pass "⚠️ 反证：阈值之前的崩溃**不**退避（第 1 次只用 ${MS1}ms）—— 否则偶发崩溃也会被拖慢"
else
  fail "阈值之前就退避了（第 1 次用了 ${MS1}ms）：正常的单次崩溃不该被拖慢"
fi
assert_eq "${RC3}" "9" "退避期间仍然透传子进程的退出码（编排层要靠它判断）"
assert_contains "$(cat "${WORK}/case-storm.out")" "重启风暴熔断" "熔断时打了明确的 FATAL 说明"
assert_contains "$(cat "${WORK}/case-storm.out")" "请查**上面第一条**错误" "说明了熔断只降速、要去看第一条错误"
assert_contains "$(cat "${WORK}/case-storm.out")" "doctor" "给了可照做的下一步命令"
if [[ -f "${STORM_LOG}/vanblog-crash-state.json" ]]; then
  pass "崩溃计数存在日志目录（= 挂载卷）里，所以跨容器重建仍然有效"
else
  fail "没找到崩溃计数状态文件（应存在 ${STORM_LOG}/vanblog-crash-state.json）"
fi

# ---------- 7) 一次足够长的健康运行会清零计数 ----------
HEALTHY_LOG="${WORK}/case-healthy/log"
HEALTHY_SRV="${WORK}/case-healthy/server"
mkdir -p "${HEALTHY_LOG}" "${HEALTHY_SRV}"
# 先制造 3 次快速崩溃（与上面同一套参数，但用独立的日志目录）
cat >"${HEALTHY_SRV}/main.js" <<'JS'
process.exit(9);
JS
for _ in 1 2 3; do
  VAN_BLOG_SERVER_CWD="${HEALTHY_SRV}" VAN_BLOG_LOG="${HEALTHY_LOG}" \
    VANBLOG_MAX_FAST_CRASHES=3 VANBLOG_CRASH_BACKOFF_BASE_MS=200 VANBLOG_FAST_CRASH_MS=400 \
    "${NODE_BIN}" "${START_JS}" >>"${WORK}/case-healthy.out" 2>&1
done
# 再来一次"活得够久"的运行：FAST_CRASH_MS=400，子进程活 700ms
cat >"${HEALTHY_SRV}/main.js" <<'JS'
setTimeout(() => process.exit(0), 700);
JS
VAN_BLOG_SERVER_CWD="${HEALTHY_SRV}" VAN_BLOG_LOG="${HEALTHY_LOG}" \
  VANBLOG_MAX_FAST_CRASHES=3 VANBLOG_CRASH_BACKOFF_BASE_MS=200 VANBLOG_FAST_CRASH_MS=400 \
  "${NODE_BIN}" "${START_JS}" >>"${WORK}/case-healthy.out" 2>&1
assert_contains "$(cat "${WORK}/case-healthy.out")" "视为已恢复正常" "健康运行后说明了计数被清零"
if grep -q '"fastCrashes":\[\]' "${HEALTHY_LOG}/vanblog-crash-state.json"; then
  pass "状态文件里的计数确实被清空（不是只打了日志）"
else
  fail "健康运行后计数没有清零：$(cat "${HEALTHY_LOG}/vanblog-crash-state.json")"
fi
# 清零之后再崩一次，不应该退避
cat >"${HEALTHY_SRV}/main.js" <<'JS'
process.exit(9);
JS
H0=$(date +%s%3N)
VAN_BLOG_SERVER_CWD="${HEALTHY_SRV}" VAN_BLOG_LOG="${HEALTHY_LOG}" \
  VANBLOG_MAX_FAST_CRASHES=3 VANBLOG_CRASH_BACKOFF_BASE_MS=200 VANBLOG_FAST_CRASH_MS=400 \
  "${NODE_BIN}" "${START_JS}" >>"${WORK}/case-healthy.out" 2>&1
H1=$(date +%s%3N)
if [[ $((H1 - H0)) -lt 180 ]]; then
  pass "清零后的第一次崩溃不退避（$((H1 - H0))ms）—— 否则一次历史故障会永久拖慢之后的偶发崩溃"
else
  fail "清零后仍然退避（$((H1 - H0))ms）"
fi

# ---------- 8) 源码层面的不变式（熔断相关） ----------
if printf '%s' "${START_CODE}" | grep -q "crashBackoffBaseMs \* 2 \*\*"; then
  pass "退避用指数计算"
else
  fail "找不到指数退避的计算（crashBackoffBaseMs * 2 **）"
fi
if printf '%s' "${START_CODE}" | grep -q "Math.min(Math.max(0, Math.floor(raw)), crashBackoffMaxMs)"; then
  pass "退避有封顶且防溢出（2^n 变 Infinity 传进 setTimeout 会**立刻**触发，退避就没了）"
else
  fail "退避没有封顶/防溢出"
fi
# ⚠️ 剥注释后再断言"不存在"：文件头注释里正好解释了为什么**不能** unref。
if printf '%s' "${START_CODE}" | grep -qE "timer\.unref\(\)"; then
  fail "退避定时器被 unref 了：事件循环没有别的工作时进程会提前自然退出（且退出码变 0，编排层不再重拉）"
else
  pass "退避定时器没有被 unref（否则进程会在退避结束前自然退出，熔断形同不存在）"
fi
if printf '%s' "${START_CODE}" | grep -q "writeCrashState"; then
  pass "崩溃计数会落盘（跨容器重建有效）"
else
  fail "崩溃计数没有落盘"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
