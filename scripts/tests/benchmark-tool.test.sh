#!/usr/bin/env bash
# 压测工具自己的守卫：失败分类、预热不许卡死、C10K 分阶段、内核计数器增量的诚实性、向后兼容。
#
# 为什么需要它（这一节是全部理由，别删）：
#   `scripts/benchmark/loadtest.cjs` 是 docs/advanced/benchmark.md 里每一个数字的来源。它曾经有两个
#   **把失败吞掉**的缺陷，都是在定位 C10K 问题时才暴露的：
#     1) 预热循环里是裸 `http.get(...).on('error', res)`，**没有超时** —— 只要有一条路径挂着不响应
#        （服务端 hang、被限流后连接被挂住、上游 dial 超时），Promise 永不 resolve，整个压测
#        **永久卡死、一行结果都不打印**。表现出来像"压测器坏了"，实际是被测端的问题，
#        而那恰恰是最该被大声报出来的一类失败。
#     2) C10K 的建连阶段 `s.once('timeout', () => s.destroy())` **不计数** —— 超时的连接既不算成功
#        也不算失败，`connected + countErr()` 永远到不了目标，整段白等 60 秒兜底，而这些连接从
#        统计里彻底消失。建连超时恰恰是 listen backlog 溢出最典型的信号。
#   同时，"失败=N" 这一个数字里混着四种指向完全不同根因的东西（非 2xx 状态码 / 建连阶段超时 /
#   建连阶段被重置 / 客户端临时端口耗尽），不拆开就无从下手。所以分类字段一旦存在，就必须
#   **永远存在** —— 这个文件就是防它被改回笼统计数的。
#
# ⚠️ 这个测试会起自己的假服务器（127.0.0.1 的随机高位端口，结束必须关掉），
#    **绝不**碰 18080（可能在跑的站点）、18097、18107（别人的压测栈）。
# ⚠️ 不起容器、不联网、不装依赖、不打真实站点：全部用本地假服务器与合成快照。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOADTEST="${ROOT}/scripts/benchmark/loadtest.cjs"
MEASURE="${ROOT}/scripts/benchmark/measure.sh"

PASS=0
FAIL=0
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
note() { echo "NOTE: $*"; }

echo "== 压测工具：失败分类 / 预热不卡死 / C10K 分阶段 / 计数器诚实性 / 向后兼容 =="

for f in "$LOADTEST" "$MEASURE"; do
  if [[ ! -f "$f" ]]; then
    fail "缺文件：$f"
    echo
    echo "passed=${PASS} failed=${FAIL}"
    exit 1
  fi
done

# --- node：与 measure.sh 同一套挑法（取版本号最大的那份，不是 glob 的第一个）---
NODE=""
for cand in $(ls -d "${ROOT}"/.tools/node*/bin/node 2>/dev/null | sort -V); do
  [[ -x "$cand" ]] && NODE="$cand"
done
[[ -z "$NODE" ]] && NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  note "没有 node，跳过（这个测试的所有断言都要真跑压测器）"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  note "没有 python3，跳过（变异对照要用它做精确替换）"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/vb-bench-tool.XXXXXX")"
FAKE_PID=""
P502=""
PHANG=""
PDEAD=""

cleanup() {
  if [[ -n "$FAKE_PID" ]] && kill -0 "$FAKE_PID" 2>/dev/null; then
    kill "$FAKE_PID" 2>/dev/null
    # 给它一点时间真正退出，否则"没留监听"那条断言会读到还在关的 socket
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$FAKE_PID" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$FAKE_PID" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 断言助手（先自查尺子，再用尺子量别人）
# ---------------------------------------------------------------------------
assert_has() { # assert_has <说明> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else
    fail "$1（没找到「$3」）"
    printf '%s\n' "$2" | sed -n '1,12p' | sed 's/^/      | /'
  fi
}
assert_lacks() { # assert_lacks <说明> <haystack> <needle>
  if printf '%s' "$2" | grep -qF -- "$3"; then
    fail "$1（居然找到了「$3」）"
    printf '%s\n' "$2" | grep -F -- "$3" | head -3 | sed 's/^/      | /'
  else pass "$1"; fi
}
assert_rc() { # assert_rc <说明> <期望> <实际>
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1（期望 rc=$2，实际 rc=$3）"; fi
}

# 尺子自查：assert_has / assert_lacks 必须真的能分辨"有"与"没有"。
# ⚠️ 这一步不是仪式 —— 本仓库出过"断言匹配到自己的解释性注释"和"heredoc 参数写错位置导致
# 检查从未执行"两类事故，恒真的断言比没有断言更糟。
SELF_OUT=$'甲 http_502=3 乙\n丙 connect_err_ECONNREFUSED=1'
assert_has "（尺子自查）assert_has 能找到存在的子串" "$SELF_OUT" "http_502=3"
assert_lacks "（尺子自查）assert_lacks 能确认不存在的子串" "$SELF_OUT" "http_503"
if printf '%s' "$SELF_OUT" | grep -qF -- "根本不存在的形状"; then
  fail "（尺子自查失败）grep -F 恒真 ⇒ 上面所有 assert_has 都是装饰"
else
  pass "（尺子自查）grep -F 不是恒真的"
fi

# ---------------------------------------------------------------------------
# 假服务器：三种形状（502 / 挂起 / 死端口），全部绑 127.0.0.1 的随机高位端口
# ---------------------------------------------------------------------------
cat > "${WORK}/fake.cjs" <<'FAKE'
const http = require('http');
const net = require('net');

// 502：反代连不上上游时的形状（caddy 日志会是 `dial tcp …: i/o timeout`）
const s502 = http.createServer((q, r) => { r.writeHead(502, { 'content-type': 'text/plain' }); r.end('bad gateway'); });
// 挂起：接受连接但永不响应（服务端 hang / 连接被挂住）
const sHang = http.createServer(() => { /* 故意不响应 */ });
// 🔴 「收了请求但不响应就干净关闭」：这正是本轮 C10K 静默无输出的成因形状 ——
//    对端 FIN 时客户端**不会**收到 'error'，socket 已关所以也不会再触发 'timeout'，
//    于是这条请求永远不结算；旧代码的兜底计时器又是 unref 的 ⇒ node 静默退出、退出码 0、
//    一行结果都不打印（报告里只剩一行"请求路径: …"，看着像"这个目标没问题"）。
//    ⚠️ 必须**等到请求字节再关**：若在 accept 后立刻 destroy，'close' 可能在建连阶段就触发，
//    那时请求阶段的监听器还没挂上 ⇒ 测不到目标路径（会退化成"未归类"而不是这个桶）。
const sClose = net.createServer((c) => { c.once('data', () => { c.destroy(); }); });

// 死端口：先绑一个拿到端口再关掉，比硬编码一个"应该没人用"的端口可靠；
// 关掉之后还要**真的连一次**确认是 ECONNREFUSED（万一被别的进程抢了就得换一个）。
function findDeadPort(tries, cb) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    probe.close(() => {
      const c = net.connect(port, '127.0.0.1');
      c.once('error', (e) => {
        if (e.code === 'ECONNREFUSED') return cb(port);
        if (tries > 0) return findDeadPort(tries - 1, cb);
        cb(0);
      });
      c.once('connect', () => { c.destroy(); if (tries > 0) return findDeadPort(tries - 1, cb); cb(0); });
    });
  });
}

findDeadPort(10, (deadPort) => {
  s502.listen(0, '127.0.0.1', () => {
    const p1 = s502.address().port;
    sHang.listen(0, '127.0.0.1', () => {
      const p2 = sHang.address().port;
      sClose.listen(0, '127.0.0.1', () => {
        const p3 = sClose.address().port;
        process.stdout.write(`PORTS ${p1} ${p2} ${p3} ${deadPort}\n`);
      });
    });
  });
});
FAKE

"$NODE" "${WORK}/fake.cjs" > "${WORK}/ports" 2>"${WORK}/fake.err" &
FAKE_PID=$!
for _ in $(seq 1 100); do
  grep -q '^PORTS ' "${WORK}/ports" 2>/dev/null && break
  kill -0 "$FAKE_PID" 2>/dev/null || break
  sleep 0.1
done
if ! grep -q '^PORTS ' "${WORK}/ports" 2>/dev/null; then
  fail "假服务器起不来（$(head -c 200 "${WORK}/fake.err" 2>/dev/null)）"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 1
fi
read -r _tag P502 PHANG PCLOSE PDEAD < "${WORK}/ports"

if [[ -z "${P502:-}" || -z "${PHANG:-}" || -z "${PCLOSE:-}" || -z "${PDEAD:-}" || "$PDEAD" == "0" ]]; then
  fail "拿不到四个端口（PORTS ${P502:-?} ${PHANG:-?} ${PCLOSE:-?} ${PDEAD:-?}）"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 1
fi
# ⚠️ 硬约束：绝不打到别人在用的端口上（站长可能在跑站点，别的代理可能在压测）
for p in "$P502" "$PHANG" "$PCLOSE" "$PDEAD"; do
  case "$p" in
    18080|18097|18107|80|443) fail "假服务器端口撞上了不该碰的端口：$p" ;;
  esac
done
pass "四个假服务器端口都是随机高位端口（${P502} / ${PHANG} / ${PCLOSE} / ${PDEAD}），不碰 18080/18097/18107"

# 端口活性自查：502 与挂起必须活着，死端口必须被拒。
# ⚠️ 这同时是"结束不留监听"那条断言的**反证** —— 尺子得先能量出"活着"，
# 后面量"已经死了"才有意义。
probe_port() { # probe_port <port> → 打印 ALIVE / REFUSED / OTHER:<code>
  "$NODE" -e '
const net = require("net");
const c = net.connect(Number(process.argv[1]), "127.0.0.1");
const t = setTimeout(() => { console.log("OTHER:timeout"); process.exit(0); }, 3000);
c.once("connect", () => { clearTimeout(t); console.log("ALIVE"); c.destroy(); process.exit(0); });
c.once("error", (e) => { clearTimeout(t); console.log(e.code === "ECONNREFUSED" ? "REFUSED" : "OTHER:" + e.code); process.exit(0); });
' "$1" 2>/dev/null
}
ALIVE502="$(probe_port "$P502")"
ALIVEHANG="$(probe_port "$PHANG")"
DEADST="$(probe_port "$PDEAD")"
if [[ "$ALIVE502" == "ALIVE" && "$ALIVEHANG" == "ALIVE" && "$DEADST" == "REFUSED" ]]; then
  pass "（反证）端口活性尺子有效：502 与挂起是 ALIVE，死端口是 REFUSED"
else
  fail "端口活性前提不成立（502=${ALIVE502} 挂起=${ALIVEHANG} 死端口=${DEADST}）⇒ 后面的分类断言都不可信"
fi

# 跑压测器：<文件> <硬超时秒> <参数...>；结果放 OUT，退出码放 RC（124 = 被硬超时杀掉）
OUT=""
RC=0
run_lt() {
  local f="$1"; local t="$2"; shift 2
  OUT="$(timeout "$t" "$NODE" "$f" "$@" 2>&1)"
  RC=$?
}

# ---------------------------------------------------------------------------
echo
echo "-- 1. 失败分类：四种形状必须落到四个不同的桶 --"
# ---------------------------------------------------------------------------
run_lt "$LOADTEST" 60 --base "http://127.0.0.1:${P502}" --profile home --c 5 --n 10 --timeout 3000
assert_rc "502 那一轮正常结束（不是被硬超时杀掉）" 0 "$RC"
assert_has "非 2xx 按状态码分桶：http_502=10" "$OUT" "http_502=10"
assert_has "分类行给出总数/成功/失败/未归类" "$OUT" "[分类] 并发 5 总=10 成功=0 失败=10 未归类=0"
assert_lacks "502 没有被记成成功" "$OUT" "成功=10"
# ⚠️ 成功路径也要打印分类（只打印错误就看不出总数对不对）——这是明确要求，单独钉一条
run_lt "$LOADTEST" 60 --base "http://127.0.0.1:${P502}" --profile home --c 2 --n 4 --timeout 3000
assert_has "成功路径也打印分类行（不是只有出错才打）" "$OUT" "[分类] 并发 2 总=4"

run_lt "$LOADTEST" 60 --base "http://127.0.0.1:${PDEAD}" --profile home --c 3 --n 6 --timeout 3000
assert_rc "拒连那一轮正常结束" 0 "$RC"
assert_has "建连阶段被拒：connect_err_ECONNREFUSED=6" "$OUT" "connect_err_ECONNREFUSED=6"
assert_lacks "拒连没有被误记成请求阶段失败" "$OUT" "request_err_ECONNREFUSED"

run_lt "$LOADTEST" 60 --base "http://127.0.0.1:${PHANG}" --profile home --c 2 --n 3 --timeout 1000 --warmup-timeout 1000
assert_rc "挂起那一轮正常结束（客户端超时后自己收场）" 0 "$RC"
assert_has "请求阶段客户端超时：request_err_CLIENT_TIMEOUT=3" "$OUT" "request_err_CLIENT_TIMEOUT=3"
assert_lacks "客户端自己的超时没有被混进内核 ETIMEDOUT" "$OUT" "request_err_ETIMEDOUT"

# ---------------------------------------------------------------------------
echo
echo "-- 2. 预热不许永久卡住（这是既有 bug，卡死时一行结果都不打印）--"
# ---------------------------------------------------------------------------
START=$(date +%s)
run_lt "$LOADTEST" 25 --base "http://127.0.0.1:${PHANG}" --profile home --c 2 --n 2 --timeout 1000 --warmup-timeout 1500
ELAPSED=$(( $(date +%s) - START ))
if [[ "$RC" == "124" ]]; then
  fail "预热把整个压测卡死了（25 秒硬超时被触发）—— 这正是旧代码的形状：裸 http.get 没有超时"
else
  pass "面对挂着不响应的路径，压测器自己在 ${ELAPSED}s 内收场（硬超时没被触发）"
fi
assert_has "预热超时被明确报出来" "$OUT" "[预热异常]"
assert_has "预热异常里点名了 CLIENT_TIMEOUT" "$OUT" "CLIENT_TIMEOUT"
assert_has "预热行说明了总路径数与正常数" "$OUT" "预热：1 条路径，正常 0 条"
assert_has "预热不通时提醒别把数字当容量结论" "$OUT" "别当成容量结论"
if [[ "$ELAPSED" -gt 20 ]]; then
  fail "虽然没卡死，但花了 ${ELAPSED}s（--warmup-timeout 1500 应当在 2-3s 内返回）⇒ 超时没真正生效"
else
  pass "预热超时的量级正确（${ELAPSED}s ≤ 20s，与 --warmup-timeout 1500 相符）"
fi

# ---------------------------------------------------------------------------
echo
echo "-- 3. C10K：建连阶段与请求阶段必须分开报 --"
# ---------------------------------------------------------------------------
C10K_START=$(date +%s)
run_lt "$LOADTEST" 90 --base "http://127.0.0.1:${P502}" --profile c10k --hold 40 --path / --timeout 3000
C10K_ELAPSED=$(( $(date +%s) - C10K_START ))
assert_rc "C10K 打 502 正常结束" 0 "$RC"
# ⚠️ 不光要"跑完"，还要"跑完就退出"：两个兜底 `setTimeout(resolve, 60000/90000)` 如果
#    不 clearTimeout + unref，活儿 1 秒干完、进程却要吊满 90 秒 —— measure.sh 每个 C10K
#    目标白等 90 秒（两个目标 3 分钟），而外层超时比它短的人会拿到 rc=124，
#    把"跑完了"误读成"失败了"。40 条连接根本用不了 30 秒，所以这个上限很宽松。
if [[ "$C10K_ELAPSED" -lt 30 ]]; then
  pass "C10K 跑完立刻退出（${C10K_ELAPSED}s，没有吊在兜底计时器上）"
else
  fail "C10K 跑完却花了 ${C10K_ELAPSED}s ⇒ 兜底计时器没有被 clearTimeout/unref，进程被吊住了"
fi
assert_has "C10K 建连阶段单独成块" "$OUT" "[分类] 建连阶段 总=40 成功=40 失败=0 未归类=0"
assert_has "C10K 请求阶段单独成块" "$OUT" "[分类] 请求阶段 总=40 成功=0 失败=40 未归类=0"
assert_has "C10K 请求阶段的失败按状态码分桶" "$OUT" "http_502=40"
# 顺序也是契约：建连在前、请求在后（读报告的人是按这个顺序推理的）
if [[ "$(printf '%s\n' "$OUT" | grep -n '建连阶段' | head -1 | cut -d: -f1)" -lt \
      "$(printf '%s\n' "$OUT" | grep -n '请求阶段' | head -1 | cut -d: -f1)" ]]; then
  pass "两个阶段的先后顺序是「建连 → 请求」"
else
  fail "两个阶段的顺序不对（读报告时会把上游问题误读成内核问题）"
fi
# 历史行必须还在（口径不变）
assert_has "C10K 历史行「目标连接数」仍在" "$OUT" "目标连接数     : 40"
assert_has "C10K 历史行「连接上发请求 : 200=N 失败=M」口径未变" "$OUT" "连接上发请求   : 200=0 失败=40"

run_lt "$LOADTEST" 90 --base "http://127.0.0.1:${PDEAD}" --profile c10k --hold 40 --path / --timeout 3000
assert_rc "C10K 打死端口正常结束" 0 "$RC"
assert_has "打死端口时建连阶段全部失败并给出错误码" "$OUT" "connect_err_ECONNREFUSED=40"
assert_has "打死端口时请求阶段总=0（一条都没发出去）" "$OUT" "[分类] 请求阶段 总=0"
assert_has "请求阶段一条都没有时明说，而不是留空" "$OUT" "（一个都没完成）"
assert_has "历史行「建连错误」仍在" "$OUT" '建连错误       : {"ECONNREFUSED":40}'

# ---------------------------------------------------------------------------
echo
echo "-- 4. kdelta：内核计数器增量的诚实性（绝不把"采不到"打成 0）--"
# ---------------------------------------------------------------------------
# 从 measure.sh 里把函数抽出来单独跑：整脚本一执行就会去打真实站点，
# 而这个测试不许碰任何真站点。抽取范围到 C10K_GREP 那行为止（那是函数区的末尾）。
sed -n '/^kget() {/,/^C10K_GREP=/p' "$MEASURE" | sed '$d' > "${WORK}/kfuncs.sh"
if [[ ! -s "${WORK}/kfuncs.sh" ]]; then
  fail "从 measure.sh 抽不出 kget/kfacts/kdelta 函数区（文件结构变了？抽取范围要跟着改）"
else
  pass "能从 measure.sh 抽出计数器函数区（$(wc -l < "${WORK}/kfuncs.sh") 行）"
fi
cat > "${WORK}/kd-driver.sh" <<'DRV'
emit() { printf '%s\n' "$*"; }
# shellcheck source=/dev/null
. "$KFUNCS"
kdelta "$1" "$2" "$3"
DRV

cat > "${WORK}/before" <<'EOF'
TcpExt.ListenOverflows=100
TcpExt.ListenDrops=100
Tcp.AttemptFails=5
TcpExt.SomeFutureCounter=7
sockstat.TCP.tw=3
EOF
cat > "${WORK}/after" <<'EOF'
TcpExt.ListenOverflows=3845
TcpExt.ListenDrops=3845
Tcp.AttemptFails=5
TcpExt.SomeFutureCounter=999
sockstat.TCP.tw=3
EOF
KD="$(KFUNCS="${WORK}/kfuncs.sh" bash "${WORK}/kd-driver.sh" "测试段" "${WORK}/before" "${WORK}/after" 2>&1)"
assert_has "有增量就打出 Δ（含前后值）" "$KD" "TcpExt.ListenOverflows: 100 → 3845  **Δ=3745**"
assert_has "Δ=0 也照打（「没涨」本身就是排除 backlog 的证据）" "$KD" "Tcp.AttemptFails: 5 → 5  Δ=0"
assert_has "快照里没有的字段打「未采集到」" "$KD" "TcpExt.TCPBacklogDrop: 未采集到"
assert_lacks "采不到的字段**绝不**打成 0（0 会被读成「没有溢出」，是最坏的假阴性）" "$KD" "TCPBacklogDrop: 0"
assert_has "白名单之外也涨了的计数器会被列出来（防内核改字段名后白名单过时）" "$KD" "（白名单外）TcpExt.SomeFutureCounter: 7 → 999"

cat > "${WORK}/unavail" <<'EOF'
__unavailable=容器 exec 不可用（容器名不对？rootless 没导出 XDG_RUNTIME_DIR/HOME？）
EOF
KDU="$(KFUNCS="${WORK}/kfuncs.sh" bash "${WORK}/kd-driver.sh" "拿不到快照" "${WORK}/before" "${WORK}/unavail" 2>&1)"
assert_has "整份快照拿不到时明说原因" "$KDU" "未采集到（容器 exec 不可用"
assert_lacks "拿不到快照时不会伪造一堆 0" "$KDU" "Δ=0"

# kfacts：静态事实与"backlog 读不到"的诚实声明
cat > "${WORK}/facts" <<'EOF'
ulimit.nofile_soft=1048576
sysctl.somaxconn=4096
sysctl.tcp_abort_on_overflow=0
ss=未采集到（容器内没有 ss）
proc_tcp.listening_port_80=1
proc_tcp.listening_port_3000=1
EOF
KF="$(KFUNCS="${WORK}/kfuncs.sh" bash -c 'emit(){ printf "%s\n" "$*"; }; . "$1"; kfacts "$2"' _ "${WORK}/kfuncs.sh" "${WORK}/facts" 2>&1)"
assert_has "kfacts 打出容器内实际 fd 上限（压测脚手架不套 compose 的 nofile，必须实测）" "$KF" "ulimit.nofile_soft = 1048576"
assert_has "kfacts 逐个列出监听端口（一行一键才解析得对）" "$KF" "容器内监听端口：80 3000"
assert_has "kfacts 明说 backlog 读不到、并给出为什么" "$KF" "accept 队列深度 / backlog 上限：未采集到（容器内没有 ss）"
assert_lacks "kfacts 不会输出「backlog=0」这种假读数" "$KF" "queue_cur_backlog"

# ---------------------------------------------------------------------------
echo
echo "-- 5. 向后兼容：旧参数、旧退出码、历史数据行的列序与含义 --"
# ---------------------------------------------------------------------------
bash "$MEASURE" --help > "${WORK}/help.out" 2>&1
assert_rc "--help 退 0" 0 "$?"
assert_has "--help 打的是注释块（含失败分类那一节）" "$(cat "${WORK}/help.out")" "失败分类"
assert_lacks "--help 不会把代码行当帮助打出来（旧写法写死 2,30p 就会）" "$(cat "${WORK}/help.out")" "set -uo pipefail"
bash "$MEASURE" --definitely-not-an-arg > /dev/null 2>&1
assert_rc "未知参数退 2（口径未变）" 2 "$?"

# 历史数据行：列数、列序、含义。这是"历史表格可逐列对照"的唯一保证。
run_lt "$LOADTEST" 60 --base "http://127.0.0.1:${P502}" --profile home --c 7 --n 200 --timeout 3000
ROW="$(printf '%s\n' "$OUT" | grep -E '^ *[0-9]+ \|' | head -1)"
if [[ -z "$ROW" ]]; then
  fail "找不到历史数据行（`^ *数字 |` 形状）⇒ measure.sh 的 grep 会什么都抓不到"
else
  SHAPE="$(printf '%s\n' "$ROW" | awk -F'|' '
    { for (i = 1; i <= NF; i++) { g = $i; gsub(/^ +| +$/, "", g); f[i] = g }
      mono = ((f[5]+0 <= f[6]+0) && (f[6]+0 <= f[7]+0) && (f[7]+0 <= f[8]+0)) ? "mono" : "NOTmono"
      printf "cols=%d c=%s n=%s %s\n", NF, f[1], f[2], mono }')"
  assert_has "数据行仍是 11 列（并发|完成|秒|rps|p50|p95|p99|max|Mbps|状态码|socket 错误）" "$SHAPE" "cols=11"
  assert_has "第 1 列是并发数（--c 7）" "$SHAPE" "c=7"
  assert_has "第 2 列是完成数（--n 200）" "$SHAPE" "n=200"
  assert_has "第 5-8 列满足 p50 ≤ p95 ≤ p99 ≤ max（列序没被打乱）" "$SHAPE" "mono"
  assert_lacks "列序检查不是恒真的（这一轮的输出确实有区分度）" "$SHAPE" "NOTmono"
fi
assert_has "表头文字一字未改" "$OUT" "并发 | 完成 | 秒 | rps | p50 | p95 | p99 | max | Mbps | 状态码 | socket 错误"

# measure.sh 的过滤白名单：既要放行历史数据行，也要放行新增的分类行 ——
# 少写一个分支就会**静默丢掉**新字段（报告看着正常，信息却没了），所以两边都钉。
PG="$(grep -m1 "^PASS_GREP=" "$MEASURE" | sed "s/^PASS_GREP='//; s/'$//")"
CG="$(grep -m1 "^C10K_GREP=" "$MEASURE" | sed "s/^C10K_GREP='//; s/'$//")"
if [[ -z "$PG" || -z "$CG" ]]; then
  fail "从 measure.sh 抽不出 PASS_GREP / C10K_GREP（变量名变了？这里要跟着改）"
else
  for sample in "${ROW:-    7 |  200 |  0.5 |  1.0 |  1 |  2 |  3 |  4 |  0.1 | 200:200 | -}" \
                "  [分类] 并发 7 总=200 成功=200 失败=0 未归类=0" \
                "  [明细] ok=200" \
                "  [警告] 3 个请求既没有状态码也没有错误码" \
                "  [预热异常] /→http_502" \
                "  预热：9 条路径，正常 9 条（超时上限 20000ms）"; do
    if printf '%s\n' "$sample" | grep -qE "$PG"; then
      pass "PASS_GREP 放行：$(printf '%s' "$sample" | cut -c1-34)…"
    else
      fail "PASS_GREP **漏掉了**这一行（它会从报告里静默消失）：$sample"
    fi
  done
  for sample in "并发 | 完成 | 秒 | rps | p50 | p95 | p99 | max | Mbps | 状态码 | socket 错误" \
                "压测机网络事实  临时端口范围=32768 60999" \
                "  路径配比：/×1"; do
    if printf '%s\n' "$sample" | grep -qE "$PG"; then
      fail "PASS_GREP 误抓了非数据行（报告里会多出一行噪音）：$sample"
    else
      pass "PASS_GREP 不误抓：$(printf '%s' "$sample" | cut -c1-34)…"
    fi
  done
  for sample in "  目标连接数     : 40" "  成功建立       : 40（用时 0.0s）" \
                "  连接上发请求   : 200=0 失败=40（用时 0.0s）" '  建连错误       : {"ECONNREFUSED":40}' \
                "  [分类] 建连阶段 总=40 成功=40 失败=0 未归类=0" "  [明细] http_502=40"; do
    if printf '%s\n' "$sample" | grep -qE "$CG"; then
      pass "C10K_GREP 放行：$(printf '%s' "$sample" | cut -c1-34)…"
    else
      fail "C10K_GREP **漏掉了**这一行：$sample"
    fi
  done
fi

# ---------------------------------------------------------------------------
echo
echo "-- 6. 变异对照：把修复改回去，上面的断言必须变红 --"
# ---------------------------------------------------------------------------
# ⚠️ 用 python3 做精确替换而不是 sed：被替换的文本里有反引号、`${}` 与中文，
#    sed 的转义规则会让"替换没生效"变成静默的（那样变异对照就是恒绿的装饰）。
#    锚点不唯一时直接报错退出，绝不"随便替换一处"。
# 一次 python 调用同时做两件事：生成变异文件 + 报告每个锚点是否唯一。
# ⚠️ 锚点不唯一（0 次或多次）时**必须报 FAIL**：替换没生效的变异对照是恒绿的装饰，
#    比没有对照更糟（它让人以为这条断言被验证过）。
python3 - "$LOADTEST" "$MEASURE" "$WORK" > "${WORK}/anchors.txt" <<'MUTPY'
import sys, os
loadtest, measure, work = sys.argv[1:4]
lt = open(loadtest, encoding='utf-8').read()
ms = open(measure, encoding='utf-8').read()

MUTS = [
  ("m1_statusbucket", lt,
   "  return code >= 200 && code < 400 ? 'ok' : `http_${code}`;",
   "  return 'failed';"),
  ("m2_warmup_no_timeout", lt,
   "      rq.setTimeout(WARM_TIMEOUT, () => { rq.destroy(); res({ path: item.path, error: 'CLIENT_TIMEOUT' }); });\n",
   ""),
  ("m3_c10k_merge_phases", lt,
   "    printClassification('请求阶段', r.counters, r.connected);\n",
   ""),
  ("m5_swap_p50_p95", lt,
   "${String(Math.round(r.p50)).padStart(4)} | ${String(Math.round(r.p95)).padStart(4)}",
   "${String(Math.round(r.p95)).padStart(4)} | ${String(Math.round(r.p50)).padStart(4)}"),
  ("m7_c10k_connect_timeout_untracked", lt,
   "        connectErrors.CLIENT_TIMEOUT = (connectErrors.CLIENT_TIMEOUT || 0) + 1;\n        bump(connectCounters, 'connect_err_CLIENT_TIMEOUT');\n",
   ""),
  ("m4_kget_zero", ms,
   "  printf '%s' \"${v:-未采集到}\"",
   "  printf '%s' \"${v:-0}\""),
  ("m6_passgrep_drops_class", ms,
   "PASS_GREP='^ *[0-9]+ \\||\\[分类\\]|\\[明细\\]|\\[警告\\]|\\[预热异常\\]|^ *预热：'",
   "PASS_GREP='^ *[0-9]+ \\|'"),
]
for name, src, old, new in MUTS:
    n = src.count(old)
    if n != 1:
        print("ANCHOR-BAD %s count=%d" % (name, n))
        continue
    open(os.path.join(work, name + ".mut"), 'w', encoding='utf-8').write(src.replace(old, new, 1))
    print("ANCHOR-OK %s" % name)
MUTPY
while read -r tag name rest; do
  if [[ "$tag" == "ANCHOR-BAD" ]]; then
    fail "（反证失败）变异锚点不唯一：$name $rest ⇒ 替换没生效，这条变异对照恒绿"
  fi
done < "${WORK}/anchors.txt"
ANCHOR_OK="$(grep -c '^ANCHOR-OK' "${WORK}/anchors.txt" 2>/dev/null || echo 0)"
if [[ "${ANCHOR_OK}" -eq 7 ]]; then
  pass "7 条变异的锚点全部唯一命中（变异对照不是恒绿的）"
else
  fail "只有 ${ANCHOR_OK}/7 条变异锚点命中 ⇒ 有变异没生效"
fi

mut_run() { # mut_run <变异文件> <硬超时> <参数...>
  local f="$1" t="$2"; shift 2
  OUT="$(timeout "$t" "$NODE" "$f" "$@" 2>&1)"; RC=$?
}

if [[ -f "${WORK}/m1_statusbucket.mut" ]]; then
  mut_run "${WORK}/m1_statusbucket.mut" 60 --base "http://127.0.0.1:${P502}" --profile home --c 5 --n 10 --timeout 3000
  if printf '%s' "$OUT" | grep -qF "http_502=10"; then
    fail "（反证失败）把 statusBucket 改成笼统 'failed' 后仍能读到 http_502 ⇒ 第 1 节那条断言是恒真的"
  else
    pass "（反证）把分类改回笼统计数后，http_502 断言确实变红"
  fi
fi

if [[ -f "${WORK}/m2_warmup_no_timeout.mut" ]]; then
  mut_run "${WORK}/m2_warmup_no_timeout.mut" 12 --base "http://127.0.0.1:${PHANG}" --profile home --c 2 --n 2 --timeout 1000 --warmup-timeout 1500
  if [[ "$RC" == "124" ]]; then
    pass "（反证）去掉预热超时后，压测器确实永久卡死（12s 硬超时被触发）⇒ 第 2 节那条断言不是装饰"
  else
    fail "（反证失败）去掉预热超时后仍然自己收场（rc=${RC}）⇒ 要么变异没生效，要么卡死另有原因"
  fi
fi

if [[ -f "${WORK}/m3_c10k_merge_phases.mut" ]]; then
  mut_run "${WORK}/m3_c10k_merge_phases.mut" 90 --base "http://127.0.0.1:${P502}" --profile c10k --hold 20 --path / --timeout 3000
  if printf '%s' "$OUT" | grep -qF "[分类] 请求阶段"; then
    fail "（反证失败）删掉请求阶段的分类打印后它还在 ⇒ 第 3 节那条断言是恒真的"
  else
    pass "（反证）删掉请求阶段分类后，「两阶段分开报」断言确实变红"
  fi
fi

if [[ -f "${WORK}/m5_swap_p50_p95.mut" ]]; then
  mut_run "${WORK}/m5_swap_p50_p95.mut" 60 --base "http://127.0.0.1:${P502}" --profile home --c 7 --n 200 --timeout 3000
  MROW="$(printf '%s\n' "$OUT" | grep -E '^ *[0-9]+ \|' | head -1)"
  MSHAPE="$(printf '%s\n' "$MROW" | awk -F'|' '
    { for (i = 1; i <= NF; i++) { g = $i; gsub(/^ +| +$/, "", g); f[i] = g }
      printf "%s\n", ((f[5]+0 <= f[6]+0) && (f[6]+0 <= f[7]+0) && (f[7]+0 <= f[8]+0)) ? "mono" : "NOTmono" }')"
  if [[ "$MSHAPE" == "NOTmono" ]]; then
    pass "（反证）把 p50/p95 两列对调后，列序断言确实变红（这条能抓住"改了列序但列数不变"）"
  else
    note "（反证不确定）对调 p50/p95 后仍单调 —— 这一轮样本的 p50 与 p95 恰好相等，重跑一次通常就能分辨"
  fi
fi

if [[ -f "${WORK}/m7_c10k_connect_timeout_untracked.mut" ]]; then
  # 这条是源码级对照：建连超时很难在测试里稳定造出来（要一个真丢 SYN 的内核），
  # 所以退一步钉住"计数调用必须存在"。⚠️ 先证明尺子在原文件上量得到，
  # 否则 0 < 0 这类比较会假绿。
  # ⚠️ 不要写 `grep -c … || echo 0`：grep -c 在**零命中时也打印 0** 并返回非零，
  #    于是 `|| echo 0` 会再追加一个 0，变量变成 "0\n0"，后面的 [[ -lt ]] 直接语法错。
  #    （这条 bug 是本测试自己第一版跑出来的，留在这儿当注释免得再犯。）
  N_ORIG="$(grep -c "connect_err_CLIENT_TIMEOUT" "$LOADTEST" 2>/dev/null)"; N_ORIG="${N_ORIG:-0}"
  N_MUT="$(grep -c "connect_err_CLIENT_TIMEOUT" "${WORK}/m7_c10k_connect_timeout_untracked.mut" 2>/dev/null)"; N_MUT="${N_MUT:-0}"
  if [[ "${N_ORIG}" -eq 0 ]]; then
    fail "（反证失败）原文件里根本没有 connect_err_CLIENT_TIMEOUT ⇒ 这条对照量的是空气"
  elif [[ "${N_MUT}" -lt "${N_ORIG}" ]]; then
    pass "（反证）删掉建连超时计数后出现次数 ${N_ORIG} → ${N_MUT}（旧代码正是这样把失败吞掉的）"
  else
    fail "（反证失败）删掉建连超时计数后出现次数没变（${N_ORIG} → ${N_MUT}）⇒ 变异没生效"
  fi
fi

if [[ -f "${WORK}/m4_kget_zero.mut" ]]; then
  sed -n '/^kget() {/,/^C10K_GREP=/p' "${WORK}/m4_kget_zero.mut" | sed '$d' > "${WORK}/kfuncs-mut.sh"
  KDM="$(KFUNCS="${WORK}/kfuncs-mut.sh" bash "${WORK}/kd-driver.sh" "测试段" "${WORK}/before" "${WORK}/after" 2>&1)"
  if printf '%s' "$KDM" | grep -qF "TCPBacklogDrop: 未采集到"; then
    fail "（反证失败）把「未采集到」改成 0 之后仍然打印「未采集到」⇒ 第 4 节那条断言是恒真的"
  else
    pass "（反证）把「未采集到」改成 0 后，诚实性断言确实变红（假读数 0 会被当成「没有溢出」）"
  fi
fi

if [[ -f "${WORK}/m6_passgrep_drops_class.mut" ]]; then
  MPG="$(grep -m1 "^PASS_GREP=" "${WORK}/m6_passgrep_drops_class.mut" | sed "s/^PASS_GREP='//; s/'$//")"
  if printf '%s\n' "  [分类] 并发 7 总=200" | grep -qE "$MPG"; then
    fail "（反证失败）白名单删掉分类分支后仍能匹配 ⇒ 第 5 节那组放行断言是恒真的"
  else
    pass "（反证）白名单少写一个分支时，「静默丢字段」确实被抓住"
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "-- 7. C10K：静默无输出必须被判失败；「对端不响应就关闭」必须结算成独立桶 --"
# ---------------------------------------------------------------------------
# 为什么必须有这一节：本轮 `/api/public/meta` 的 C10K 在完整协议下**两次**只打印了一行
# 「请求路径: …」就没了下文，而 measure.sh 的退出码是 0、报告里也没有任何提示 ⇒
# 读报告的人（包括父代理）会把它当成"这个目标没问题"或"服务端扛不住"，两种都错。
# 真因是两层的：①loadtest 里对端**干净关闭**（FIN）的 socket 永不结算（'data' 等不到
# \r\n\r\n、'error' 不触发、socket 已关所以 'timeout' 也不触发），Promise 永不 resolve；
# ②两个兜底计时器是 unref 的 ⇒ 事件循环一空，node **静默退出且退出码 0**；
# ③measure.sh 又把子进程输出经 `grep -E "$C10K_GREP"` 过滤，崩溃/异常行不在白名单里 ⇒ 被整段丢掉，
#   而且管道后的 `$?` 是 while 的，**拿不到子进程真实退出码**。
# 三层各自都要有断言，否则修了一层另外两层还能把同一个事故再藏一次。

# --- 8.1 loadtest：对端收了请求就关闭 ⇒ 必须结算成 request_err_CLOSED_NO_RESPONSE 并照常出结果 ---
run_lt "$LOADTEST" 90 --base "http://127.0.0.1:${PCLOSE}" --profile c10k --hold 20 --path / --timeout 3000
assert_rc "C10K 打「收请求后不响应即关闭」的服务端能正常结束（不是静默退出）" 0 "$RC"
assert_has "结果行照常打印（旧代码这里会一行都不打印）" "$OUT" "目标连接数     : 20"
assert_has "「连接上发请求」这一行也在" "$OUT" "连接上发请求"
assert_has "对端不响应就关闭 ⇒ 落进独立桶 request_err_CLOSED_NO_RESPONSE" "$OUT" "request_err_CLOSED_NO_RESPONSE=20"
assert_has "20 条连接全部有归属（未归类=0）⇒ 没有连接从统计里消失" "$OUT" "未归类=0"
assert_lacks "这一形状不该被误记成客户端超时" "$OUT" "request_err_CLIENT_TIMEOUT"
# ⚠️ 正对照：桶不是"什么都往里装"。打 502 服务端必须落进 http_502 而**不是** CLOSED_NO_RESPONSE。
run_lt "$LOADTEST" 90 --base "http://127.0.0.1:${P502}" --profile c10k --hold 20 --path / --timeout 3000
assert_has "（正对照）502 服务端 ⇒ 落进 http_502 桶" "$OUT" "http_502=20"
assert_lacks "（正对照）502 服务端**不会**落进 CLOSED_NO_RESPONSE ⇒ 那个桶是特定形状，不是兜底" "$OUT" "request_err_CLOSED_NO_RESPONSE"

# --- 8.2 结构性：两个兜底计时器不许 unref（但仍必须 clearTimeout）---
C10K_FN="$(awk '/^async function runC10K/,/^const LATENCY_PATHS/' "$LOADTEST")"
if [[ -z "$C10K_FN" ]]; then
  fail "从 loadtest.cjs 抽不出 runC10K 函数区（函数名/边界变了 ⇒ 这里的抽取范围要跟着改）"
else
  C10K_CODE="$(printf '%s\n' "$C10K_FN" | strip_comments_js 2>/dev/null || printf '%s\n' "$C10K_FN" | grep -av '^[[:space:]]*//')"
  if printf '%s\n' "$C10K_CODE" | grep -aq '\.unref('; then
    fail "runC10K 里仍有 .unref() ⇒ 所有 socket 被对端关掉后事件循环一空，node 会静默退出、一行结果都不打印"
  else
    pass "runC10K 的两个兜底计时器都没有 unref（剥注释后判定，避免匹配到解释性注释）"
  fi
  assert_has 'clearTimeout 仍在（不 unref 之后靠它避免「跑完还吊着」）' "$C10K_CODE" "clearTimeout(guardConnect)"
  assert_has "请求阶段的 clearTimeout 也在" "$C10K_CODE" "clearTimeout(guardRequest)"
  # 反证：用**合成样本**证明这把尺子真能量到 .unref(。
  # ⚠️ 不能拿源文件的注释当反证 —— 修完之后注释里已经不含 `.unref(` 这个字面量
  #    （只写「不要 unref」），那样反证会恒失败，而恒失败的反证和恒真的断言一样没用。
  if printf '%s\n' 'if (typeof guardConnect.unref === "function") guardConnect.unref();' | grep -aq '\.unref('; then
    pass "（反证）合成样本里的 .unref( 会被这把尺子检出 ⇒ 上面那条「没有 unref」不是恒真"
  else
    fail "（反证失败）连合成样本都检不出 .unref( ⇒ 上面那条断言是恒真的空断言"
  fi
fi

# --- 8.3 结构性：measure.sh 的 C10K 环节不许再用「管道进 grep」的形状 ---
MEAS_CODE="$(grep -av '^[[:space:]]*#' "$MEASURE")"
if printf '%s\n' "$MEAS_CODE" | grep -aqF '| grep -E "$C10K_GREP" | while'; then
  fail "measure.sh 的 C10K 环节仍是「子进程 2>&1 | grep | while」⇒ 崩溃行会被白名单吞掉、且拿不到真实退出码"
else
  pass "measure.sh 的 C10K 环节已不再把子进程输出直接管道进 grep"
fi
assert_has "改成先落盘再过滤（原始输出可查）" "$MEAS_CODE" '> "$raw" 2>&1'
assert_has "取子进程的**真实**退出码" "$MEAS_CODE" 'rc=$?'
assert_has "必需行之一：目标连接数" "$MEAS_CODE" "目标连接数"
assert_has "必需行之二：连接上发请求" "$MEAS_CODE" "连接上发请求"
assert_has "未产出结果时非 0 退出（exit 2）" "$MEAS_CODE" 'exit 2'
# 反证：旧形状必须能被上面那把尺子抓到（否则「已不再管道进 grep」是恒真）
if printf '%s\n' 'x | grep -E "$C10K_GREP" | while read' | grep -aqF '| grep -E "$C10K_GREP" | while'; then
  pass "（反证）旧的管道形状确实会被检出 ⇒ 上面那条不是恒真"
else
  fail "（反证失败）旧管道形状检不出来 ⇒ 尺子无效"
fi

# --- 8.4 行为级：measure.sh 遇到「子进程只打印表头就退出 0」必须判失败并退出 2 ---
# 手法：把 measure.sh 复制到一棵假的仓库树里（ROOT 由 $0 推导），配一个**桩 loadtest**，
#      这样不需要真站点、也不会碰生产脚本。桩有两种：只打表头（=事故形状）与打全结果（=正对照）。
FAKEROOT="${WORK}/fakeroot"
mkdir -p "${FAKEROOT}/scripts/benchmark"
cp "$MEASURE" "${FAKEROOT}/scripts/benchmark/measure.sh"
ln -sfn "${ROOT}/.tools" "${FAKEROOT}/.tools" 2>/dev/null || true
FAKE_MEASURE="${FAKEROOT}/scripts/benchmark/measure.sh"
STUB="${FAKEROOT}/scripts/benchmark/loadtest.cjs"

# (a) 事故形状：只打印表头三行就 exit 0（正是本轮 /api/public/meta 的表现）
cat > "$STUB" <<'STUBA'
console.log('压测目标 stub-silent-exit  profile=c10k');
console.log('  请求路径: /api/public/meta');
process.exit(0);
STUBA
bash "$FAKE_MEASURE" --base "http://127.0.0.1:${PDEAD}" --no-kcounters --no-load \
  --latency-n 1 --sweep-c 5 --sweep-n 5 --static-n 5 --c10k 100 \
  --out "${WORK}/fail.md" > "${WORK}/fail.out" 2>&1
FAIL_RC=$?
if [[ "$FAIL_RC" -eq 2 ]]; then
  pass "子进程只打表头就退出 0 ⇒ measure.sh 以退出码 2 报失败（不再静默通过）"
else
  fail "子进程只打表头就退出 0，但 measure.sh 退出码是 ${FAIL_RC}（期望 2）⇒ 静默失败仍会被吞掉"
fi
assert_has "报告里明确写出「未产出可用结果 ⇒ 判为失败，不是跳过」" "$(cat "${WORK}/fail.md" 2>/dev/null)" "未产出可用结果"
assert_has "报告里给出子进程真实退出码" "$(cat "${WORK}/fail.md" 2>/dev/null)" "子进程退出码=0"
assert_has "报告里指出缺了哪两行必需行" "$(cat "${WORK}/fail.md" 2>/dev/null)" "目标连接数=缺"
assert_has "把**未过滤**的原始输出尾部吐出来（旧写法就是把它吞了）" "$(cat "${WORK}/fail.md" 2>/dev/null)" "未经白名单过滤"
# ⚠️ 上面那条只钉了"标签"：把真正吐原始输出的那行 `tail` 删掉也不会红
#    （变异对照 M2 第一次实测就是 NOT_RED，正是这么发现的）。
#    所以再钉一条：**桩子进程打印过的独有内容真的出现在报告里** ——
#    只有 `tail -n 20 "$raw"` 真的执行了，`stub-silent-exit` 才可能出现。
# ⚠️ 断言必须带 `    | ` 前缀：桩子进程的那两行**也会**从第 1 节（单请求延迟）漏进报告，
#    所以只断言"内容出现过"是**不够**的 —— 变异掉 tail 那行之后它照样能命中（M2 第二次仍 NOT_RED
#    就是这么发现的）。带上前缀才只可能来自 C10K 失败分支的原始输出回吐。
assert_has "原始输出的**内容**真的进了报告（带 | 前缀，只可能来自失败分支的回吐）" "$(cat "${WORK}/fail.md" 2>/dev/null)" "| 压测目标 stub-silent-exit"
assert_has "保留原始输出文件路径供排查" "$(cat "${WORK}/fail.md" 2>/dev/null)" "完整原始输出保留在"

# (b) 正对照：桩打印完整结果 ⇒ 必须退出 0 且**不**出现失败横幅
cat > "$STUB" <<'STUBB'
console.log('压测目标 stub  profile=c10k');
console.log('  请求路径: /api/public/meta');
console.log('== C10K ==');
console.log('  目标连接数     : 100');
console.log('  成功建立       : 100（用时 0.1s）');
console.log('  连接上发请求   : 200=100 失败=0（用时 0.1s）');
console.log('  [分类] 建连阶段 总=100 成功=100 失败=0 未归类=0');
console.log('  [明细] ok=100');
process.exit(0);
STUBB
bash "$FAKE_MEASURE" --base "http://127.0.0.1:${PDEAD}" --no-kcounters --no-load \
  --latency-n 1 --sweep-c 5 --sweep-n 5 --static-n 5 --c10k 100 \
  --out "${WORK}/ok.md" > "${WORK}/ok.out" 2>&1
OK_RC=$?
if [[ "$OK_RC" -eq 0 ]]; then
  pass '（正对照）子进程产出完整结果 ⇒ 退出码 0（不是「永远报 2」）'
else
  fail "（正对照失败）子进程产出完整结果却退出 ${OK_RC} ⇒ 上面那条 exit 2 可能是恒真"
fi
assert_has "（正对照）正常结果行被原样透传进报告" "$(cat "${WORK}/ok.md" 2>/dev/null)" "连接上发请求   : 200=100 失败=0"
assert_lacks "（正对照）正常情况下不出现失败横幅" "$(cat "${WORK}/ok.md" 2>/dev/null)" "未产出可用结果"

# --- 8.5 --c10k 的语义必须在 --help 里写清（本轮有人把它当成"保持秒数"，只压了 30 条连接）---
HELP="$(bash "$MEASURE" --help 2>&1)"
assert_has "--help 写明 --c10k 的 N 是**目标连接数**" "$HELP" "N 是**目标连接数**"
assert_has '--help 写明它不是「保持多少秒」' "$HELP" '**不是**"保持多少秒"'
assert_has '--help 写明同义写法 --c10k-conns' "$HELP" '--c10k-conns'


# ---------------------------------------------------------------------------
echo
echo "-- 8. 收尾：不留任何监听 --"
# ---------------------------------------------------------------------------
if kill -0 "$FAKE_PID" 2>/dev/null; then
  BEFORE_KILL="$(probe_port "$P502")"
  kill "$FAKE_PID" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$FAKE_PID" 2>/dev/null || break; sleep 0.2; done
  FAKE_PID=""
  if [[ "$BEFORE_KILL" == "ALIVE" ]]; then
    pass "（反证）关掉之前 502 端口确实是 ALIVE ⇒ 下面那条「已经死了」不是恒真"
  else
    fail "（反证失败）关掉之前 502 端口就不是 ALIVE（${BEFORE_KILL}）⇒ 假服务器可能早就死了，前面的断言都可疑"
  fi
  AFTER1="$(probe_port "$P502")"
  AFTER2="$(probe_port "$PHANG")"
  AFTER3="$(probe_port "$PCLOSE")"
  if [[ "$AFTER1" == "REFUSED" && "$AFTER2" == "REFUSED" && "$AFTER3" == "REFUSED" ]]; then
    pass "测试结束不留监听（三个假服务器端口都已 REFUSED）"
  else
    fail "测试结束仍有监听（502=${AFTER1} 挂起=${AFTER2} 关闭=${AFTER3}）⇒ 会干扰后面在同一台机器上的实测"
  fi
else
  fail "假服务器进程在测试结束前就没了（前面的断言可能是在没有服务的情况下跑的）"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
