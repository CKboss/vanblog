#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# `scripts/tests/run-guard.sh` 的守卫。
#
# 🔴 为什么这个 wrapper 需要自己的守卫：它现在是 CI 里 **34 个守卫步骤**的共同入口。
#    它唯一的关键职责是**把被包装守卫的退出码原样透传**；一旦它吞掉非 0 退出码，
#    🔴 **所有守卫会同时变成装饰品**（照跑、照样打印 FAIL，而 job 依然 success）——
#    那是一种"全绿但什么都没在守"的失效，比单个守卫红掉危险得多，而且从 CI 界面上看不出来。
#    所以这里用桩脚本把三种结局（通过 / 有断言失败 / 脚本自己崩了）逐个钉住。
#
# ⚠️ 本文件不叫 `*.test.sh` 之外的名字是有意的：它**是**一个守卫脚本，
#    因此被"每个守卫都必须被某个 workflow 按文件名引用"那条常驻断言覆盖。
# ---------------------------------------------------------------------------
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WRAPPER="${ROOT}/scripts/tests/run-guard.sh"
PASS=0; FAIL=0
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }
assert_not_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then fail "$3 (unexpected: $2)"; else pass "$3"; fi; }

[[ -f "${WRAPPER}" ]] || { echo "FAIL: 找不到 ${WRAPPER}"; echo "passed=0 failed=1"; exit 1; }

T="$(mktemp -d "${TMPDIR:-/tmp}/ci-guard-wrapper-XXXXXX")"
trap 'rm -rf "${T}"' EXIT INT TERM
export RUNNER_TEMP="${T}"

# 三个桩：通过 / 有断言失败 / 自己崩了（没有汇总行）
printf '%s\n' '#!/usr/bin/env bash' 'echo "PASS: ok"' 'echo "passed=1 failed=0"' 'exit 0' >"${T}/ok.test.sh"
printf '%s\n' '#!/usr/bin/env bash' 'echo "PASS: ok"' 'echo "FAIL: 桩里故意失败的那条 (missing: xyz)"' \
  'echo "passed=1 failed=1"' 'exit 1' >"${T}/bad.test.sh"
printf '%s\n' '#!/usr/bin/env bash' 'echo "崩了，没有汇总行"' 'exit 3' >"${T}/crash.test.sh"

# 1) 退出码透传：通过 → 0
OUT="$(bash "${WRAPPER}" "${T}/ok.test.sh" 2>&1)"; rc=$?
assert_eq "${rc}" "0" "被包装的守卫通过时 wrapper 退出 0"
assert_not_contains "${OUT}" "::error::" "🔴 通过时**不打**注解（否则每次 CI 都刷一堆假错误）"

# 2) 退出码透传：有断言失败 → 原样透传（🔴 这条是整个 wrapper 的命根子）
OUT="$(bash "${WRAPPER}" "${T}/bad.test.sh" 2>&1)"; rc=$?
assert_eq "${rc}" "1" "🔴 被包装的守卫失败时 wrapper 原样透传退出码（吞掉它 = 所有守卫变成装饰品）"
assert_contains "${OUT}" "::error::" "失败时打 ::error 注解（annotations 走公开 API 可读，绕开日志 403）"
assert_contains "${OUT}" "桩里故意失败的那条" "注解里带上**具体哪条断言**失败（不是只说"有失败"）"
assert_contains "${OUT}" "passed=1 failed=1" "注解里带上 passed=/failed= 汇总"

# 3) 退出码透传：脚本自己崩了（非 1 的退出码 + 没有汇总行）
OUT="$(bash "${WRAPPER}" "${T}/crash.test.sh" 2>&1)"; rc=$?
assert_eq "${rc}" "3" "守卫脚本自己崩了时，它那个非 1 的退出码也要原样透传"
assert_contains "${OUT}" "没有输出 passed=/failed= 汇总行" "崩了（没有汇总行）时如实说清，而不是静默"

# 4) 用法错误必须是**响亮**的失败，不能退化成 0
OUT="$(bash "${WRAPPER}" 2>&1)"; rc=$?
assert_eq "${rc}" "9" "不给参数时退出 9（不能静默成功）"
OUT="$(bash "${WRAPPER}" "${T}/does-not-exist.test.sh" 2>&1)"; rc=$?
assert_eq "${rc}" "9" "守卫脚本不存在时退出 9（否则改错路径会让那一步悄悄变绿）"

# 5) 源码级：rc 必须取自 PIPESTATUS，不能取管道的 $?（那是 tee 的退出码，永远是 0）
CODE="$(sed 's|^[[:space:]]*#.*||' "${WRAPPER}")"
if printf '%s\n' "${CODE}" | grep -qF 'rc=${PIPESTATUS[0]}'; then
  pass "rc 取自 PIPESTATUS[0]（被包装守卫的退出码），而不是管道最后一个命令 tee 的"
else
  fail "找不到 rc=\${PIPESTATUS[0]}：rc 很可能取的是 tee 的退出码（恒 0 ⇒ 守卫全部失效）"
fi
# 尺子有效性反证：上面那条判据确实能区分好坏形状
BAD_SHAPE='bash "$g" 2>&1 | tee "$log"
rc=$?'
if printf '%s\n' "${BAD_SHAPE}" | grep -qF 'rc=${PIPESTATUS[0]}'; then
  fail "尺子失效：坏形状（rc=\$?）也被判成好形状"
else
  pass "尺子有效性：坏形状（rc 取管道 \$?）不会被误判成好形状"
fi

# 6) 反空转：三个桩都真的存在且可执行（否则上面全是空转的绿）
# ⚠️ 判据用 -s（存在且非空）而不是 -x：桩是用 printf 建的、没有执行位，
#    而 wrapper 是 `bash "${guard}"` 调它的，不需要执行位。
#    🔴 这一条最初写成 -x 时自己红了（got 0 want 3）—— 反空转控制正是为此存在的。
n=0; for f in ok bad crash; do [[ -s "${T}/${f}.test.sh" ]] && n=$((n+1)); done
assert_eq "${n}" "3" "反空转：三个桩脚本都真的建出来了（否则上面全是空转的绿）"

echo "passed=${PASS} failed=${FAIL}"
[[ "${FAIL}" -eq 0 ]] || exit 1
exit 0
