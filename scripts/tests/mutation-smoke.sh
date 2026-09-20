#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# mutation-smoke.sh —— 把本仓库一直**手工**做的"变异对照"制度化成可执行脚本
#
# ## 为什么要有它
# 本仓库每一轮修复都要求做变异对照：把修复改回去 → 守卫必须红 → 还原 → 绿。
# 它已经多次抓出**空断言**（守卫看着绿、其实抓不到任何东西）。但靠人手工做，
# 覆盖率就取决于当轮谁记得做。这个脚本把它变成一条命令。
#
# ## 🔴🔴 跑之前必读 🔴🔴
# **这个脚本会临时修改仓库里的源文件。** 所以：
#   1. 跑它的时候**不要有任何别的测试 / 构建 / 代理在跑**（它们会读到被变异的文件，
#      得到无法解释的失败；反过来它们的改动也会让本脚本的"起点干净"检查失败）。
#   2. 脚本自带互斥锁与"检测到并发测试进程就中止"的预检；可以用
#      `MUTATION_SMOKE_ALLOW_BUSY=1` 强制越过第二道（**不建议**）。
#   3. 结束时工作树必须与开始时**逐字节一致**。脚本用 sha256 + 副本还原 + `trap EXIT`
#      兜底，并在最后用 `git status --porcelain` 复核；任何一处不一致都非 0 退出。
#
# ## 判据（三条，都是踩过坑换来的）
#   - **RED 的定义是"红的条数相对基线增加"**，不是"存在红"。曾经有过一次变异对照
#     与基线同为 17/1，被误读成"守卫有效"。所以每条变异都先在**未变异**状态跑一次
#     目标 spec 记基线，变异后再跑，比较 failed 是否**增加**。
#   - **`Tests: 0 total` 不是红，是 INCONCLUSIVE**：变异体编译不过时套件根本跑不起来，
#     那不是"守卫抓住了变异"。已知陷阱：`if (false && …)` 这种短路形状在 TS 里会让
#     控制流收窄失效而编译不过 —— 所以本表**不使用**这种变异形状。
#   - **还原必须从副本还原并校验 sha256**，不能"重新读文件再比较"（那种写法恒真）。
#     曾经因此把变异残留在工作树里，污染了后续所有对照。
#
# ## 用法
#   bash scripts/tests/mutation-smoke.sh              # 跑全部
#   bash scripts/tests/mutation-smoke.sh --list       # 只列表，不跑
#   bash scripts/tests/mutation-smoke.sh --only M03   # 只跑某几条（可重复/逗号分隔）
#   bash scripts/tests/mutation-smoke.sh --preflight  # 只做预检（唯一性/干净/锁），不变异
#
# ## 输出
#   每条一行人类可读结果（含它保护的那条安全性质），末尾两行机器可读：
#     MUTATION: total=N red=N inconclusive=N notred=N skipped=N
#     passed=<red+skipped_ok> failed=<inconclusive+notred+还原失败>
#   ⚠️ `passed=/failed=` 是本仓库所有守卫的统一格式，父级汇总循环按 `^passed=` 解析。
#   退出码：0 = 全部符合预期；非 0 = 有 INCONCLUSIVE / 有 0 红 / 还原校验失败。
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 90

# ── 变异表 ────────────────────────────────────────────────────────────────
# 字段（TAB 分隔，因为字面量里会出现 `|`、`||`、`"`、`*`）：
#   id  目标文件  find(精确字面量，\n 表示换行)  replace  目标 spec  runner  保护的安全性质
# ⚠️ 每个 find 必须在目标文件里**唯一命中**（preflight 会逐条校验）。
#    这条规矩是踩过坑的：曾经有一个锚点在同一文件里命中 2 次，删掉目标调用点后
#    断言仍然匹配到另一处 ⇒ 变异对照 0 红，被误读成"守卫有效"。
# ⚠️ runner: jest = packages/server 的 jest；vitest = packages/website 的 vitest。
TABLE='M01	packages/server/src/provider/access/access.guard.ts	if (isSuperAdminOnlyRoute(path)) {	if (isSuperAdminOnlyRoute('"''"')) {	packages/server/src/provider/access/accessGuard.spec.ts	jest	协作者勾「所有权限」也不能碰凭据类路由（改口令/API Token/整站备份/流水线/协作者/系统设置/反代证书）
M02	packages/server/src/controller/admin/init/init.controller.ts	if (outcome?.kind === '"'"'busy'"'"') return { owner: null, busy: true };	if (outcome?.kind === '"'"'__mutation_never__'"'"') return { owner: null, busy: true };	packages/server/src/controller/admin/init/init.dblock.spec.ts	jest	cluster>1 时初始化/恢复由 DB 级 TTL 锁互斥，抢不到锁的一方 409（否则会造出两个 id:0 管理员）
M03	packages/server/src/utils/dbLock.ts	{ _id: name, expiresAt: { $lte: now } },	{ _id: name },	packages/server/src/utils/dbLock.spec.ts	jest	过期锁才能被接管：不判过期就等于**活锁也能被任何人抢走**
M04	packages/server/src/provider/token/token.provider.ts	if (typeof token !== '"'"'string'"'"' || !token.trim()) {	if (false) {	packages/server/src/utils/queryFilterDrift.spec.ts	jest	checkToken 的空/非字符串守卫（缺了它会退化成"匹配任意未吊销 token"，曾造成未认证管理员接管）
M05	packages/server/src/provider/user/user.provider.ts	      permissions,\n      password: encrypted,	      permission: permissions,\n      password: encrypted,	packages/server/src/provider/user/collaboratorPermissions.spec.ts	jest	协作者权限写库必须用复数 permissions（单数会被 mongoose strict 模式静默丢弃 ⇒ 权限从来没生效过）
M06	packages/server/src/main.ts	await listenWithBacklog(port, host, listenBacklog);	await app.listen(port, host);	packages/server/src/__tests__/listenBacklog.spec.ts	jest	listen 必须显式传 backlog（Node 默认 511 ⇒ C10K 下反代路径大量 502，实测 ListenOverflows Δ=3745）
M07	packages/website/utils/markdownSanitize.ts	  schema.attributes["*"] = (schema.attributes["*"] || []).filter(\n    (entry) => entry !== "src" && entry !== "style",\n  );	  schema.attributes["*"] = [...(schema.attributes["*"] || []).filter((entry) => entry !== "style"), "src"];	packages/website/__tests__/markdownSanitizeWhitelist.spec.ts	vitest	正文 HTML 白名单不许把 src 发给**每一个**标签（否则 <iframe src="data:text/html;base64,…"> 可用）
M08	packages/server/src/utils/publicMetaCache.ts	  if (inflight) {\n    return (await inflight) as T;\n  }	  if (false) {\n    return (await inflight) as T;\n  }	packages/server/src/utils/publicMetaCache.singleFlight.spec.ts	jest	public meta 缓存的并发合并（缺了它，TTL 到期瞬间 N 个并发各自打 8 次 Mongo ⇒ 延迟雪崩）
M09	packages/server/src/utils/backupCrypto.ts	{ N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_PARAMS.maxmem },	{ N: params.N, r: params.r, p: params.p },	packages/server/src/utils/backupCrypto.spec.ts	jest	scrypt 必须显式 maxmem（否则匿名恢复上传可以用加密头部的 KDF 参数造成 CPU/内存耗尽）
M10	packages/server/src/utils/customPagePath.ts	  if (segs.some((seg) => seg === '"'"'..'"'"')) {\n    throw new ForbiddenException('"'"'非法路径'"'"');\n  }	  if (segs.some((seg) => seg === '"'"'__mutation_never__'"'"')) {\n    throw new ForbiddenException('"'"'非法路径'"'"');\n  }	packages/server/src/utils/customPagePath.spec.ts	jest	自定义页面路径的容器化校验（去掉它 ../ 就能写到静态目录外）'

# ── 参数解析 ──────────────────────────────────────────────────────────────
MODE="run"; ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) MODE="list"; shift ;;
    --preflight) MODE="preflight"; shift ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

# ── 工具函数 ──────────────────────────────────────────────────────────────
# ⚠️ 用 python3 做字面量替换：shell 的 sed/awk 处理含 `"`、`*`、`||`、换行的字面量
#    太容易出错，而"替换是否真的发生了"必须是**可断言**的（见 assert_mutated）。
py_replace() { # <file> <find> <replace> <expect_count>
  F="$1" FIND="$2" REPL="$3" EXPECT="$4" python3 - <<'PY'
import os, sys
p = os.environ["F"]; find = os.environ["FIND"].replace("\\n", "\n")
repl = os.environ["REPL"].replace("\\n", "\n"); expect = int(os.environ["EXPECT"])
s = open(p, encoding="utf-8").read()
n = s.count(find)
if n != expect:
    print(f"COUNT_MISMATCH:{n}", end=""); sys.exit(3)
open(p, "w", encoding="utf-8").write(s.replace(find, repl, 1) if expect == 1 else s)
print("OK", end="")
PY
}
py_count() { # <file> <find> → 打印命中次数
  F="$1" FIND="$2" python3 - <<'PY'
import os
p = os.environ["F"]; find = os.environ["FIND"].replace("\\n", "\n")
try: print(open(p, encoding="utf-8").read().count(find))
except OSError: print(-1)
PY
}
sha_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# 解析测试结果：输出 "<failed> <passed> <suite_ran:1|0>"
# ⚠️ 两个 runner 的输出形状不同，而且**全绿时 jest 不打 "0 failed"** ——
#    曾经有一个变异脚本的基线解析只认 `Tests: N failed, M passed`，全绿时解析不出来
#    直接退出，于是那一轮"什么都没验"。这里对两种形状都要认。
parse_results() { # <runner> <logfile>
  local runner="$1" log="$2" failed=0 passed=0 ran=0
  if [[ "$runner" == "jest" ]]; then
    local line
    line="$(grep -E "^Tests:" "$log" | tail -1)"
    if [[ -n "$line" ]]; then
      ran=1
      failed="$(printf '%s' "$line" | sed -n 's/.*\b\([0-9][0-9]*\) failed.*/\1/p')"
      passed="$(printf '%s' "$line" | sed -n 's/.*\b\([0-9][0-9]*\) passed.*/\1/p')"
      failed="${failed:-0}"; passed="${passed:-0}"
    fi
    # 套件跑不起来（编译错误等）⇒ 不算"跑过"
    grep -q "Test suite failed to run" "$log" && ran=0
  else
    local line
    line="$(grep -E "^[[:space:]]*Tests[[:space:]]+" "$log" | tail -1)"
    if [[ -n "$line" ]]; then
      ran=1
      failed="$(printf '%s' "$line" | sed -n 's/.*\b\([0-9][0-9]*\) failed.*/\1/p')"
      passed="$(printf '%s' "$line" | sed -n 's/.*\b\([0-9][0-9]*\) passed.*/\1/p')"
      failed="${failed:-0}"; passed="${passed:-0}"
    fi
    grep -qE "Failed to load|No test files found|Unhandled" "$log" && ran=0
  fi
  echo "$failed $passed $ran"
}

run_spec() { # <runner> <spec> <logfile> → 退出码不参与判定，靠解析
  local runner="$1" spec="$2" log="$3"
  if [[ "$runner" == "jest" ]]; then
    ( cd "$ROOT/packages/server" && ./node_modules/.bin/jest "${spec#packages/server/}" --silent ) >"$log" 2>&1
  else
    ( cd "$ROOT/packages/website" && \
      HOME="$ROOT/.tools/home" PNPM_HOME="$ROOT/.tools/pnpm-home" PATH="$ROOT/.tools/node24/bin:$PATH" \
      "$ROOT/.tools/node_modules/.bin/pnpm" exec vitest run "${spec#packages/website/}" ) >"$log" 2>&1
  fi
}

# ── 读表 ──────────────────────────────────────────────────────────────────
IDS=(); FILES=(); FINDS=(); REPLS=(); SPECS=(); RUNNERS=(); PROPS=()
while IFS=$'\t' read -r id file find repl spec runner prop; do
  [[ -z "${id:-}" ]] && continue
  IDS+=("$id"); FILES+=("$file"); FINDS+=("$find"); REPLS+=("$repl")
  SPECS+=("$spec"); RUNNERS+=("$runner"); PROPS+=("$prop")
done <<< "$TABLE"
N=${#IDS[@]}

only_selected() { # <id>
  [[ -z "$ONLY" ]] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  IFS=',' read -ra _parts <<< "$ONLY"
  for p in "${_parts[@]}"; do [[ "$p" == "$1" ]] && return 0; done
  return 1
}

if [[ "$MODE" == "list" ]]; then
  echo "变异表（$N 条）："
  for i in $(seq 0 $((N-1))); do
    printf '  %s  %s\n        spec: %s (%s)\n        性质: %s\n' \
      "${IDS[$i]}" "${FILES[$i]}" "${SPECS[$i]}" "${RUNNERS[$i]}" "${PROPS[$i]}"
  done
  exit 0
fi

# ── 互斥锁 ────────────────────────────────────────────────────────────────
# ⚠️ 锁的创建**必须在主 shell 里**，不能放在命令替换里：命令替换跑在子 shell，
#    在子 shell 里注册的 trap / 写入的变量都传不回父 shell。本仓库真发生过一次
#    "清理登记在数组里、而登记动作发生在 $(...) 里" ⇒ trap 兜底形同虚设，
#    口令临时文件留在磁盘上。同一个坑，这里避开。
LOCKDIR="${TMPDIR:-/tmp}/vanblog-mutation-smoke.lock"
LOCK_HELD=0
# ⚠️ 必须在注册 trap **之前**赋值：`exit 3/4/5` 这些早退路径也会触发 EXIT trap，
#    而 `set -u` 下引用未赋值的 WORKDIR 会让清理函数自己崩掉（实测过：
#    "line 183: WORKDIR: unbound variable"，于是锁没被释放、变成残留锁）。
WORKDIR=""
N_ROWS="$N"
cleanup() {
  local rc=$?
  # 先还原所有仍处于变异状态的文件（幂等）
  local i
  for i in $(seq 0 $((N_ROWS-1))); do
    if [[ -n "$WORKDIR" && -f "$WORKDIR/mutated.${IDS[$i]}" && -f "$WORKDIR/backup.${IDS[$i]}" ]]; then
      cp -p "$WORKDIR/backup.${IDS[$i]}" "${FILES[$i]}" 2>/dev/null || true
      rm -f "$WORKDIR/mutated.${IDS[$i]}"
    fi
  done
  # ⚠️ 必须 `rm -rf` 而不是 `rmdir`：锁目录里放着 `pid` 文件，目录非空 ⇒ `rmdir` 静默失败，
  #    于是每次跑完都留下一个残留锁（实测踩过：下一次运行要靠"陈旧锁接管"才能继续）。
  #    只在 `LOCK_HELD=1`（本进程确实是持有者）时删，绝不会删掉别人的锁。
  if [[ "$LOCK_HELD" == "1" ]]; then rm -rf "$LOCKDIR" 2>/dev/null || true; fi
  exit $rc
}
trap cleanup EXIT INT TERM

if mkdir "$LOCKDIR" 2>/dev/null; then
  LOCK_HELD=1
  echo "$$" > "$LOCKDIR/pid"
else
  other="$(cat "$LOCKDIR/pid" 2>/dev/null || echo '')"
  if [[ -n "$other" ]] && kill -0 "$other" 2>/dev/null; then
    echo "✗ 已有另一个 mutation-smoke 在跑（PID $other）。这个脚本会临时改源文件，不能并发。" >&2
    exit 4
  fi
  echo "! 发现残留锁（PID ${other:-未知} 已不存在），接管。" >&2
  rm -rf "$LOCKDIR"; mkdir "$LOCKDIR" && { LOCK_HELD=1; echo "$$" > "$LOCKDIR/pid"; }
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/vanblog-mutation.XXXXXX")"

# ── 预检 ──────────────────────────────────────────────────────────────────
echo "════ mutation-smoke 预检 ════"
PRE_FAIL=0

# 1) 自己的语法
if bash -n "${BASH_SOURCE[0]}" 2>"$WORKDIR/syn.err"; then
  echo "  ✓ bash -n 通过"
else
  echo "  ✗ bash -n 失败：$(head -2 "$WORKDIR/syn.err")"; PRE_FAIL=1
fi

# 2) 并发测试进程检测（这个脚本会改共享源文件）
# ⚠️ 只在真要做变异时检查：`--preflight` 一个字节都不改，跟别的测试并发跑没有冲突，
#    拦下来只会让人以为预检本身有问题。
if [[ "$MODE" != "preflight" && "${MUTATION_SMOKE_ALLOW_BUSY:-0}" != "1" ]]; then
  # ⚠️ 不能只看"有没有匹配到进程"：本机实测遇到过**卡死 5 小时、CPU 时间只有 16 秒且不再增长**的
  #    孤儿 jest 进程（父 shell 早就没了）。只按名字匹配会让这个脚本**永远**跑不起来。
  #    所以用复合判据：存活超过 STALE_SECONDS **且** 采样窗口内 CPU 时间不增长 ⇒ 判为陈旧并放行；
  #    否则中止。加"存活超过阈值"这一半是为了避免把正在 IO/定时器等待的正常测试误判成陈旧。
  STALE_SECONDS="${MUTATION_SMOKE_STALE_SECONDS:-1800}"
  SAMPLE_SECONDS="${MUTATION_SMOKE_SAMPLE_SECONDS:-10}"
  # HH:MM:SS → 秒。⚠️ 不能比较字符串：卡死的 jest 偶尔也会累积 1 秒 CPU，
  #    字符串不等就判"活着"，于是这个脚本会被孤儿进程**永久**挡住（实测踩过）。
  cpu_secs() { local t="${1:-0:0:0}"; local h m x; IFS=: read -r h m x <<< "$t"; echo $(( 10#${h:-0}*3600 + 10#${m:-0}*60 + 10#${x:-0} )); }
  # ⚠️ 模式用方括号惯用法（`[j]est` 而不是 `jest`）：`pgrep -f` 匹配的是**整条命令行**，
  #    而调用它的那个 shell 的命令行里就写着这个模式 ⇒ 会匹配到自己，于是"有没有并发测试"
  #    永远为真。实测踩过：被标记成 LIVE 的进程其实是本次调用的 `bash -c` 包装器，
  #    81 秒后自己就消失了。同理再排除本进程、父进程，以及命令行含 mutation-smoke/pgrep 的进程。
  BUSY_RE='[j]est|[v]itest|[t]sc |[b]uild-image-local|[m]easure.sh'
  # 自己的会话 ID 与进程组 ID：同会话/同进程组的一律排除（从构造上消灭自匹配 ——
  # 只按 PID 与命令行关键字排除是不够的，实测漏过两次：一次是调用方的 `bash -c` 包装器，
  # 一次是包装器里的 `sleep`，两者 CPU 都不推进却因为"存活时间短"被判成 LIVE）。
  MY_IDS="$(ps -o sid=,pgid= -p $$ 2>/dev/null | tr -s ' ')"
  mapfile -t CANDIDATES < <(pgrep -f "$BUSY_RE" 2>/dev/null)
  PIDS=()
  for p in "${CANDIDATES[@]:-}"; do
    [[ -z "$p" || "$p" == "$$" || "$p" == "$PPID" ]] && continue
    cl="$(ps -o args= -p "$p" 2>/dev/null)"
    [[ -z "$cl" ]] && continue
    case "$cl" in *mutation-smoke*|*pgrep*|*ps\ -o*) continue ;; esac
    their_ids="$(ps -o sid=,pgid= -p "$p" 2>/dev/null | tr -s ' ')"
    [[ -n "$MY_IDS" && "$their_ids" == "$MY_IDS" ]] && continue
    PIDS+=("$p")
  done
  LIVE=(); STALE=()
  if [[ ${#PIDS[@]} -gt 0 ]]; then
    BEFORE=()
    for p in "${PIDS[@]}"; do BEFORE+=("$(ps -o time= -p "$p" 2>/dev/null | tr -d ' ')"); done
    sleep "$SAMPLE_SECONDS"
    for idx in "${!PIDS[@]}"; do
      p="${PIDS[$idx]}"
      et="$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')"
      [[ -z "$et" ]] && continue                      # 采样期间自己退出了
      after="$(ps -o time= -p "$p" 2>/dev/null | tr -d ' ')"
      before="${BEFORE[$idx]:-0:0:0}"
      delta=$(( $(cpu_secs "$after") - $(cpu_secs "$before") ))
      # ⚠️ 判据是"**CPU 有没有推进**"，不是"存活多久"：真正在跑的测试会持续吃 CPU，
      #    而卡死的孤儿、以及只是在睡觉的自家 shell（`sleep`、等 IO 的包装器）都是 +0s。
      #    早先的版本要求"存活 > 30 分钟**且** CPU 不推进"才算陈旧，结果一个存活 11 秒、
      #    CPU +0s 的睡觉进程被判成 LIVE，把整个脚本永久挡住（实测踩过两次）。
      #    存活时间只用来在报告里区分"孤儿"与"刚启动但空闲"。
      if [[ "$delta" -le 0 ]]; then
        if [[ "$et" -gt "$STALE_SECONDS" ]]; then
          STALE+=("$p 存活${et}s CPU ${before}→${after}(+${delta}s) ⇒ 孤儿")
        else
          STALE+=("$p 存活${et}s CPU ${before}→${after}(+${delta}s) ⇒ 空闲/未在计算")
        fi
      else
        LIVE+=("$p 存活${et}s CPU ${before}→${after}(+${delta}s)")
      fi
    done
  fi
  if [[ ${#LIVE[@]} -gt 0 ]]; then
    echo "  ✗ 检测到**正在推进**的测试/构建进程，已中止（它们会读到被变异的文件）：" >&2
    printf '    %s\n' "${LIVE[@]}" | head -6 >&2
    echo "    判定依据：存活 <= ${STALE_SECONDS}s，或 ${SAMPLE_SECONDS}s 采样窗口内 CPU 推进 > 1s。" >&2
    echo "    等它们结束再跑；确认无碍可用 MUTATION_SMOKE_ALLOW_BUSY=1 强制。" >&2
    exit 5
  fi
  if [[ ${#STALE[@]} -gt 0 ]]; then
    echo "  ! 发现 ${#STALE[@]} 个**陈旧**进程（存活 > ${STALE_SECONDS}s 且 ${SAMPLE_SECONDS}s 内 CPU 推进 <= 1s），判定为孤儿并继续："
    printf '    %s\n' "${STALE[@]}" | head -4
    echo "    ⚠️ 它们是上一轮遗留的卡死进程，不是并发测试；要清理请自行 kill。"
  else
    echo "  ✓ 没有检测到并发的测试/构建进程"
  fi
fi

# 3) 起点干净（只看**本脚本会碰的路径**：工作树里可能同时有别的代理在改 docs 等）
# ⚠️ 设计取舍：起点脏**不整体中止**，而是**只跳过脏的那几条**。
#    理由：这个脚本会在"别的代理正在改代码"的仓库里被用到，而它的目标文件只是全仓库的一小撮；
#    整体中止会让它在任何并发工作期间都跑不了（等于没有工具）。安全性不受影响 ——
#    脏的行我们**一个字节都不碰**，收尾也只对碰过的行做还原校验。
#    只有**全部**行都脏（说明这个仓库此刻根本不适合做变异）才中止。
dirty="$(git status --porcelain -- "${FILES[@]}" "${SPECS[@]}" 2>/dev/null)"
declare -A DIRTY_PATH
if [[ -n "$dirty" ]]; then
  # ⚠️ 必须 `IFS= read -r`：默认 IFS 会**吃掉行首空白**，而 git porcelain 的行首正是
  #    两个状态位 + 一个空格（` M path`）。少了 `IFS=` 会得到 `M path`，再剥 3 个字符
  #    就把路径首字母也剥掉了（实测得到 `ackages/...`），于是**所有键都匹配不上**、
  #    "跳过脏行"这道安全闸静默失效 —— 而这正是防止覆盖别人工作的唯一屏障。
  while IFS= read -r dline; do
    [[ -z "$dline" ]] && continue
    dp="${dline:3}"
    [[ -n "$dp" ]] && DIRTY_PATH["$dp"]=1
  done <<< "$dirty"
  echo "  ! 起点不干净：下列目标路径已有未提交改动，**对应的变异会被跳过**（绝不碰别人的工作）："
  printf '    %s\n' "${!DIRTY_PATH[@]}" | head -8
fi
SKIP_DIRTY=0
for i in $(seq 0 $((N-1))); do
  if [[ -n "${DIRTY_PATH[${FILES[$i]}]:-}" || -n "${DIRTY_PATH[${SPECS[$i]}]:-}" ]]; then
    SKIP_DIRTY=$((SKIP_DIRTY+1))
  fi
done
if [[ "$SKIP_DIRTY" -eq "$N" ]]; then
  echo "  ✗ ${N} 条变异的目标路径**全部**有未提交改动 ⇒ 现在不适合做变异对照，中止。" >&2
  exit 3
fi
echo "  ✓ 起点可用：${N} 条里有 $((N-SKIP_DIRTY)) 条的目标文件与 spec 都干净（$SKIP_DIRTY 条将被跳过）"

# 4) 每个 find 唯一命中 + 每个 replace 当前**不**存在（否则说明已经变异过或表过时）
for i in $(seq 0 $((N-1))); do
  id="${IDS[$i]}"; f="${FILES[$i]}"
  if [[ ! -f "$f" ]]; then echo "  ✗ $id 目标文件不存在：$f"; PRE_FAIL=1; continue; fi
  if [[ ! -f "${SPECS[$i]}" ]]; then echo "  ✗ $id 目标 spec 不存在：${SPECS[$i]}"; PRE_FAIL=1; continue; fi
  c="$(py_count "$f" "${FINDS[$i]}")"
  if [[ "$c" != "1" ]]; then
    echo "  ✗ $id 的 find 字面量在 $f 里命中 $c 次（必须恰好 1 次）⇒ 表已过时或锚点不唯一"; PRE_FAIL=1
  fi
  r="$(py_count "$f" "${REPLS[$i]}")"
  if [[ "$r" != "0" ]]; then
    echo "  ✗ $id 的 replace 字面量已经存在于 $f（命中 $r 次）⇒ 文件可能已被变异，或表写反了"; PRE_FAIL=1
  fi
done
[[ "$PRE_FAIL" == "0" ]] && echo "  ✓ ${N} 条 find 字面量各自唯一命中，且 replace 形状当前都不存在"

# 5) 记录预检时刻每个目标文件的 sha256，作为"这一轮开始时它长什么样"的基准。
#    ⚠️ 这条是被一次真实事故逼出来的：本脚本跑了 281 秒，期间**另一个代理编辑了
#    `user.provider.ts`**。还原本身是对的（变异形状已确认归零），但：
#      - 如果那次编辑落在"我 cp 备份"与"我还原"之间，我的还原会**静默覆盖它的工作**；
#      - 而收尾的 `git status` 只报"文件被改过"，分不清是**我的残留**还是**别人的编辑**。
#    所以现在：变异前逐条比对 sha（变了就**跳过**这条，绝不覆盖别人的工作），
#    还原后也比对 sha，收尾时把"脏"分成两类分别报告。
declare -A PRE_SHA
for i in $(seq 0 $((N-1))); do PRE_SHA["${FILES[$i]}"]="$(sha_of "${FILES[$i]}")"; done
echo "  ✓ 已记录 ${N} 个目标文件的预检 sha256（用于检测并发编辑）"

if [[ "$MODE" == "preflight" ]]; then
  echo "预检结束（--preflight 不做任何变异）。PRE_FAIL=$PRE_FAIL"
  [[ "$PRE_FAIL" == "0" ]] && { echo "passed=$N failed=0"; exit 0; } || { echo "passed=0 failed=$PRE_FAIL"; exit 1; }
fi
if [[ "$PRE_FAIL" != "0" ]]; then
  echo "✗ 预检失败，不做任何变异（工作树未被触碰）。" >&2
  echo "passed=0 failed=$PRE_FAIL"; exit 1
fi

# ── 基线 ──────────────────────────────────────────────────────────────────
echo ""
echo "════ 基线（未变异状态各跑一次目标 spec）════"
declare -A BASE_FAILED BASE_RAN BASE_SEEN
T_START=$(date +%s)
for i in $(seq 0 $((N-1))); do
  only_selected "${IDS[$i]}" || continue
  [[ -n "${DIRTY_PATH[${FILES[$i]}]:-}" || -n "${DIRTY_PATH[${SPECS[$i]}]:-}" ]] && continue
  spec="${SPECS[$i]}"
  if [[ -n "${BASE_SEEN[$spec]:-}" ]]; then continue; fi
  BASE_SEEN[$spec]=1
  t0=$(date +%s)
  run_spec "${RUNNERS[$i]}" "$spec" "$WORKDIR/base.$(echo "$spec" | tr '/' '_').log"
  read -r bf bp bran <<< "$(parse_results "${RUNNERS[$i]}" "$WORKDIR/base.$(echo "$spec" | tr '/' '_').log")"
  BASE_FAILED[$spec]="$bf"; BASE_RAN[$spec]="$bran"
  printf '  %-72s failed=%s passed=%s ran=%s (%ss)\n' "${spec##*/}" "$bf" "$bp" "$bran" "$(( $(date +%s) - t0 ))"
  if [[ "$bran" != "1" ]]; then
    echo "  ✗ 基线就没跑起来：$spec ⇒ 后面的对照没有意义，先修基线" >&2
  fi
done
echo "  基线耗时 $(( $(date +%s) - T_START ))s"

# ── 逐条变异 ──────────────────────────────────────────────────────────────
echo ""
echo "════ 变异对照 ════"
RED=0; INCONC=0; NOTRED=0; SKIPPED=0; RESTORE_BAD=0
for i in $(seq 0 $((N-1))); do
  id="${IDS[$i]}"; f="${FILES[$i]}"; spec="${SPECS[$i]}"; runner="${RUNNERS[$i]}"
  if ! only_selected "$id"; then SKIPPED=$((SKIPPED+1)); continue; fi
  if [[ -n "${DIRTY_PATH[$f]:-}" || -n "${DIRTY_PATH[$spec]:-}" ]]; then
    echo "  $id  SKIPPED(起点就有未提交改动，不碰别人的工作)  ${PROPS[$i]}"
    SKIPPED=$((SKIPPED+1)); continue
  fi
  log="$WORKDIR/mut.$id.log"
  sha_before="$(sha_of "$f")"
  # ⚠️ 并发保护：预检之后有人改过这个文件 ⇒ 跳过，绝不在别人的编辑之上做变异与还原
  if [[ "$sha_before" != "${PRE_SHA[$f]:-}" ]]; then
    echo "  $id  SKIPPED(预检后文件被并发修改，跳过以免覆盖别人的工作)  ${PROPS[$i]}"
    SKIPPED=$((SKIPPED+1)); continue
  fi
  cp -p "$f" "$WORKDIR/backup.$id"
  out="$(py_replace "$f" "${FINDS[$i]}" "${REPLS[$i]}" 1)"; rc=$?
  if [[ "$rc" != "0" || "$out" != "OK" ]]; then
    echo "  $id  INCONCLUSIVE(替换未发生: ${out:-rc=$rc})  ${PROPS[$i]}"
    cp -p "$WORKDIR/backup.$id" "$f"; INCONC=$((INCONC+1)); continue
  fi
  # ⚠️ 断言"变异体确实与原文件不同"：曾经有过一次变异正则写错（`showRSS\?:` vs `showRSS:`），
  #    变异根本没发生，而对照被当成"守卫有效"。
  sha_mut="$(sha_of "$f")"
  touch "$WORKDIR/mutated.$id"
  if [[ "$sha_mut" == "$sha_before" ]]; then
    echo "  $id  INCONCLUSIVE(变异未改变文件)  ${PROPS[$i]}"
    cp -p "$WORKDIR/backup.$id" "$f"; rm -f "$WORKDIR/mutated.$id"; INCONC=$((INCONC+1)); continue
  fi
  t0=$(date +%s)
  run_spec "$runner" "$spec" "$log"
  dt=$(( $(date +%s) - t0 ))
  read -r mf mp mran <<< "$(parse_results "$runner" "$log")"
  bf="${BASE_FAILED[$spec]:-0}"; bran="${BASE_RAN[$spec]:-1}"
  verdict=""; 
  if [[ "$mran" != "1" ]]; then
    # 套件没跑起来：区分"编译不过"与"其它原因"
    if grep -qE "error TS|Test suite failed to run|Failed to load|Cannot find module|SyntaxError" "$log"; then
      verdict="INCONCLUSIVE(compiles=false)"
    else
      verdict="INCONCLUSIVE(套件未运行)"
    fi
    INCONC=$((INCONC+1))
  elif [[ "$bran" != "1" ]]; then
    verdict="INCONCLUSIVE(基线未运行)"; INCONC=$((INCONC+1))
  elif [[ "$mf" -gt "$bf" ]]; then
    verdict="RED(+$((mf-bf)))"; RED=$((RED+1))
  else
    verdict="NOT_RED(failed=$mf, 基线=$bf)"; NOTRED=$((NOTRED+1))
  fi
  # 还原 + sha256 校验（从副本还原，不是"重新读文件比较"）
  cp -p "$WORKDIR/backup.$id" "$f"
  rm -f "$WORKDIR/mutated.$id"
  sha_after="$(sha_of "$f")"
  if [[ "$sha_after" != "$sha_before" ]]; then
    echo "  $id  🔴 还原失败：sha256 不一致（$sha_before → $sha_after）" >&2
    RESTORE_BAD=$((RESTORE_BAD+1))
  elif [[ "$sha_after" != "${PRE_SHA[$f]:-}" ]]; then
    # 还原到了"我 cp 时的样子"，但那已经不是预检时的样子 ⇒ 有人在窗口内改过它。
    # 不算还原失败（我的变异形状确认已消失），但必须大声说出来。
    echo "  $id  ⚠️ 已还原到变异前状态，但该文件在变异窗口内被**并发修改**过（sha 与预检不同）"
  fi
  printf '  %-4s %-22s %ss  %s\n' "$id" "$verdict" "$dt" "${PROPS[$i]}"
done

# ── 收尾复核：工作树必须与开始时逐字节一致 ────────────────────────────────
echo ""
echo "════ 还原复核 ════"
leftover="$(git status --porcelain -- "${FILES[@]}" 2>/dev/null)"
MINE=0; THEIRS=0; CONCURRENT=0
# ⚠️ 先算出"本次运行**真的变异过**哪些文件"。判据是物证而不是记忆：
#    `$WORKDIR/backup.<id>` 只在变异真正施加时才创建（见上面的 `cp -p "$f" "$WORKDIR/backup.$id"`），
#    所以有备份文件 = 这个文件被本脚本改过。`--only` 没选中的、以及被 SKIPPED 的，都不在里面。
declare -A MUTATED_PATHS=()
for _i in "${!IDS[@]}"; do
  [[ -f "$WORKDIR/backup.${IDS[$_i]}" ]] && MUTATED_PATHS["${FILES[$_i]}"]=1
done
if [[ -n "$leftover" ]]; then
  # ⚠️ 逐个文件判定：sha 与预检一致 ⇒ 是**别人的并发编辑**（不是我的残留）；
  #    sha 与预检不一致 ⇒ 说明我的还原没把它带回去，**这才是还原失败**。
  #    只看 git status 会把两者混为一谈，而它们的处置完全相反。
  while IFS= read -r lf; do          # ⚠️ 同上：必须 IFS= 否则路径首字母被吃掉
    [[ -z "$lf" ]] && continue
    lpath="${lf:3}"
    [[ -z "$lpath" ]] && continue
    now="$(sha_of "$lpath")"
    if [[ "$now" == "${PRE_SHA[$lpath]:-__none__}" ]]; then
      # 内容与预检时逐字节相同 ⇒ 它在预检前就已是脏的（别人的未提交工作），本脚本没动过它。
      THEIRS=$((THEIRS+1)); echo "  ⚠️ 并发编辑（不是本脚本残留）：$lpath"
    elif [[ -n "${MUTATED_PATHS[$lpath]:-}" ]]; then
      # 本次真的变异过它，而内容与预检不一致 ⇒ **这才是还原失败**。
      MINE=$((MINE+1)); echo "  🔴 本脚本残留：$lpath（本次变异过且 sha 与预检不一致）" >&2
      git diff -- "$lpath" | head -12 | cut -c1-120 >&2
    else
      # 🔴 以前这一支被算成"本脚本残留"，那是**误分类**：本脚本从没变异过它
      #    （`--only` 没选中、或它被 SKIPPED），sha 却变了 ⇒ 按定义只能是别人在窗口内改了它。
      #    实测踩过：`--only M09` 时 `main.ts`（M06 的目标）正被另一个代理编辑，
      #    于是收尾报"还原校验失败 1"，而仓库里其实**一个变异形状都没有**。
      #    危害不只是噪音：它会让"🔴 残留"变成狼来了，真残留反而被忽略。
      CONCURRENT=$((CONCURRENT+1))
      echo "  ⚠️ 变异窗口内被并发修改（本脚本**没有**变异过它，不是残留）：$lpath"
    fi
  done <<< "$leftover"
  if [[ "$MINE" -gt 0 ]]; then
    echo "  🔴 有 $MINE 个文件未还原干净 ⇒ 任何后续对照都不可信，请手工检查" >&2
    RESTORE_BAD=$((RESTORE_BAD+MINE))
  fi
  [[ "$THEIRS" -gt 0 ]] && echo "  ! 另有 $THEIRS 个文件在预检前就已是脏的（别人的未提交工作，本脚本没有覆盖它们）"
  [[ "$CONCURRENT" -gt 0 ]] && echo "  ! 另有 $CONCURRENT 个文件在变异窗口内被并发修改（本脚本没有变异过它们 ⇒ 不是残留，但它们的 sha 对照已失效）"
else
  echo "  ✓ ${N} 个目标文件还原后 git status 为空（逐字节一致）"
fi
[[ "$RESTORE_BAD" == "0" ]] || echo "  🔴 sha256/还原校验失败次数：$RESTORE_BAD" >&2

TOTAL=$((RED+INCONC+NOTRED))   # 只算真正跑过的；SKIPPED 不进 total（分母），否则并发期间永远非 0 退出
PASS=$((RED))
FAIL=$((INCONC+NOTRED+RESTORE_BAD))
echo ""
echo "════ 结果 ════"
echo "  RED（守卫抓住了变异）        : $RED"
echo "  INCONCLUSIVE（变异体跑不起来）: $INCONC"
echo "  NOT_RED（0 红 ⇒ 守卫空转）   : $NOTRED"
echo "  SKIPPED（--only 未选中）      : $SKIPPED"
echo "  还原校验失败                  : $RESTORE_BAD"
echo "  总耗时 $(( $(date +%s) - T_START ))s；中间产物在 $WORKDIR"
echo "MUTATION: total=$TOTAL red=$RED inconclusive=$INCONC notred=$NOTRED skipped=$SKIPPED"
echo "passed=$PASS failed=$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
exit 0
