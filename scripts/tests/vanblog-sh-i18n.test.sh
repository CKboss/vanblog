#!/usr/bin/env bash
# 🔴 `scripts/vanblog.sh` 的**输出语言**判据（期 11 第一批，2026-10-02）。
#
# ## 站长裁定
# `vanblog.sh 也要提供英文版的安装说明文案, 并且默认需要是英文的, 但可以通过选项切换成中文`
# ⇒ ① 帮助/安装说明有英文版；② **默认英文**；③ `--lang zh`（或 `-l zh` / `VANBLOG_LANG=zh`）切中文。
#
# ## 这份判据钉住什么（每条都对应一种"静默坏法"）
# 1. **默认必须出英文**：`--help` 的输出里**一个汉字都不许有**。
#    🔴 这是最重要的一条 —— 只要有人在英文那份里漏了一行、或者新加了一条中文 echo 到帮助里，它就红。
# 2. **`--lang zh` 必须出中文**（而且要与默认输出**不同**）：否则"选项"是假的（形同虚设也不报错）。
# 3. **三种写法都要认**：`--lang zh` / `-l zh` / `--lang=zh` / 环境变量 `VANBLOG_LANG=zh`。
# 4. **`--lang` 可以出现在子命令之后**（`install --lang zh`）且**不会被当成子命令**：
#    🔴 解析必须在脚本顶部把 `--lang` 从位置参数里摘掉，否则 `./vanblog.sh --lang zh install`
#    会把 `--lang` 当子命令 ⇒ 落到 `*) show_usage` 分支（看起来像"脚本坏了"）。
# 5. **未知语种值要拒绝并回落英文**（不许静默按中文跑，也不许崩）。
# 6. **两份 heredoc 都得在**（`<<'USAGE'` 与 `<<'USAGE_EN'`）：删掉任何一份都会让一种语言失效。
# 7. 🔴 **棘轮**：用户可见输出里的中文行数只许减不许增（迁移是分批做的，这个数就是进度）。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SH="${ROOT}/scripts/vanblog.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }

echo "== vanblog.sh 输出语言（默认英文 / --lang zh 切中文）=="

if [[ ! -f "${SH}" ]]; then
  fail "找不到 ${SH}"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 1
fi

# 0. 语法必须先过（否则后面所有"跑一遍"的判据都是在量一个跑不起来的脚本）
if bash -n "${SH}" 2>/dev/null; then
  pass "bash -n 语法检查通过"
else
  fail "bash -n 语法检查失败（后面的判据都不可信）"
fi

# 🔴 用 `--help` 作为被测面：它**不需要 root、不写任何东西**（脚本刻意把帮助放在 pre_check 之前，
#    理由写在脚本里：非 root 用户也该能看到帮助）。
run_help() { bash "${SH}" "$@" --help 2>/dev/null; }
count_cjk() { grep -cP '[\x{4e00}-\x{9fff}]' 2>/dev/null || true; }

EN_DEFAULT="$(run_help)"
EN_CJK="$(printf '%s\n' "${EN_DEFAULT}" | count_cjk)"

# 1. 默认必须出英文（一个汉字都不许有）
if [[ "${EN_CJK}" == "0" ]]; then
  pass "默认 --help 输出里没有任何汉字（默认是英文）"
else
  fail "默认 --help 输出里有 ${EN_CJK} 行含汉字（默认必须是英文；漏翻的行请用 grep -nP '[\\x{4e00}-\\x{9fff}]' 找）"
  printf '%s\n' "${EN_DEFAULT}" | grep -nP '[\x{4e00}-\x{9fff}]' | head -5 | sed 's/^/    /'
fi

# 1b. 默认输出确实**有内容**（防止"空输出也算没有汉字"这种假绿）
if [[ "$(printf '%s\n' "${EN_DEFAULT}" | wc -l)" -gt 40 ]]; then
  pass "默认 --help 输出有实质内容（>40 行）"
else
  fail "默认 --help 输出只有 $(printf '%s\n' "${EN_DEFAULT}" | wc -l) 行 ⇒ 可能是空的绿（帮助没打印出来）"
fi

# 2. --lang zh 必须出中文，且与默认输出不同
ZH_HELP="$(bash "${SH}" --lang zh --help 2>/dev/null)"
ZH_CJK="$(printf '%s\n' "${ZH_HELP}" | count_cjk)"
if [[ "${ZH_CJK}" -gt 50 ]]; then
  pass "--lang zh 的帮助是中文（${ZH_CJK} 行含汉字）"
else
  fail "--lang zh 的帮助只有 ${ZH_CJK} 行含汉字（应该 >50）⇒ 语言开关可能没生效"
fi
if [[ "${ZH_HELP}" != "${EN_DEFAULT}" ]]; then
  pass "--lang zh 的输出与默认输出**不同**（开关不是摆设）"
else
  fail "--lang zh 的输出与默认输出完全相同 ⇒ 开关是摆设（🔴 这正是最容易静默坏的一种）"
fi

# 3. 三种写法都要认
for form in "-l zh" "--lang=zh"; do
  # shellcheck disable=SC2086
  out="$(bash "${SH}" ${form} --help 2>/dev/null)"
  if [[ "$(printf '%s\n' "${out}" | count_cjk)" -gt 50 ]]; then
    pass "\`${form}\` 也能切到中文"
  else
    fail "\`${form}\` 没有切到中文（含汉字行数 $(printf '%s\n' "${out}" | count_cjk)）"
  fi
done
out_env="$(VANBLOG_LANG=zh bash "${SH}" --help 2>/dev/null)"
if [[ "$(printf '%s\n' "${out_env}" | count_cjk)" -gt 50 ]]; then
  pass "环境变量 VANBLOG_LANG=zh 也能切到中文"
else
  fail "环境变量 VANBLOG_LANG=zh 没有切到中文"
fi

# 3b. 🔴 命令行优先级高于环境变量（`VANBLOG_LANG=zh ./vanblog.sh --lang en --help` 必须出英文）
out_pri="$(VANBLOG_LANG=zh bash "${SH}" --lang en --help 2>/dev/null)"
if [[ "$(printf '%s\n' "${out_pri}" | count_cjk)" == "0" ]]; then
  pass "命令行 --lang en 覆盖环境变量 VANBLOG_LANG=zh（优先级正确）"
else
  fail "命令行 --lang en 没能覆盖环境变量 ⇒ 优先级写反了"
fi

# 4. `--lang` 出现在**子命令之后**也要被摘掉，且不能被当成子命令
#    🔴 用 `--help` 当"可观测的落点"：如果 `--lang` 没被摘掉，`help` 就不会是 $1 ⇒ 走不到帮助分支。
out_after="$(bash "${SH}" help --lang zh 2>/dev/null)"
if [[ "$(printf '%s\n' "${out_after}" | count_cjk)" -gt 50 ]]; then
  pass "\`help --lang zh\`（选项在子命令之后）也能出中文帮助"
else
  fail "\`help --lang zh\` 没有出中文帮助（含汉字行数 $(printf '%s\n' "${out_after}" | count_cjk)）⇒ --lang 只在开头才认？"
fi

# 5. 未知语种值：拒绝 + 回落英文（不许崩、不许静默按中文跑）
out_bad="$(bash "${SH}" --lang fr --help 2>&1)"
if printf '%s' "${out_bad}" | grep -q "Unknown --lang value"; then
  pass "未知语种值会明确报一句 Unknown --lang value"
else
  fail "未知语种值没有任何提示（静默接受是最坏的：用户以为切成功了）"
fi
if [[ "$(printf '%s\n' "${out_bad}" | grep -cP '[\x{4e00}-\x{9fff}]' || true)" == "0" ]]; then
  pass "未知语种值回落到**英文**（不是中文）"
else
  fail "未知语种值没有回落到英文"
fi

# 6. 两份 heredoc 都得在
for marker in "<<'USAGE'" "<<'USAGE_EN'"; do
  if grep -qF "${marker}" "${SH}"; then
    pass "帮助文案里有 ${marker} 这份 heredoc"
  else
    fail "帮助文案里找不到 ${marker} ⇒ 有一种语言的帮助被删掉了"
  fi
done

# 7. 🔴 棘轮：用户可见输出里的中文行数只许减不许增
#    口径：**排除注释行**（以 # 开头的行是给开发者看的，站长裁定文档/注释保持中文），
#    只数"会被打印出来"的行（echo / printf / say 的中文实参 / read -p 的提示 / heredoc 正文）。
BUDGET=1210
ACTUAL="$(
  grep -nP '[\x{4e00}-\x{9fff}]' "${SH}" |
    grep -vP '^\d+:\s*#' |
    grep -c '' || true
)"
if [[ "${ACTUAL}" -le "${BUDGET}" ]]; then
  pass "用户可见输出里的中文行数 ${ACTUAL} ≤ 预算 ${BUDGET}（棘轮：只许减不许增）"
else
  fail "用户可见输出里的中文行数 ${ACTUAL} > 预算 ${BUDGET} ⇒ 有新写的中文输出没走 say/英文分支"
fi
# 🔴 反空转下界：这个口径必须真的数到东西（否则"0 行"是空的绿）
if [[ "${ACTUAL}" -gt 500 ]]; then
  pass "反空转：该口径确实数到了 ${ACTUAL} 行（>500）"
else
  fail "反空转：该口径只数到 ${ACTUAL} 行（应 >500）⇒ 尺子坏了，棘轮形同虚设"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
[[ "${FAIL}" -eq 0 ]]
