#!/usr/bin/env bash
# 🔴 发版说明生成器（`scripts/releaseNotes.py`）的守卫 —— 期 12 第三批（发版准备）。
#
# 为什么要有它：这段逻辑原来**内联在 `.github/workflows/release-fork.yml` 里**，
# 🔴 于是它只在"打 tag 发版那一刻"才第一次真跑 —— 而发版失败是要重来一次的（tag 已经推出去了）。
# 搬进仓库之后就能在本机跑真脚本、用真 CHANGELOG 当输入。
#
# 它钉的是四件事（每件都对应一种真实的坏法）：
#   ① **小的一节要逐字照发**（不许因为"统一处理"把已有发布说明也压成摘要 ⇒ 那会丢内容）；
#   ② **超大的一节要压成摘要**，且 🔴 **必须真的压了**（反证：完整正文里那种长句不许出现在输出里）；
#      起因是实测：当前 `[Unreleased]` 有 **126,276 字符 / 241 KB**，而 GitHub 对 Release 正文有长度上限
#      （业界常引用 124,000 字符；本机网络取不到 docs.github.com 核实 ⇒ 脚本取保守值 100,000）；
#   ③ **摘要不许丢批次**：每个 `### ` 批次标题都还在（47 个，实测数出来的），并附完整 CHANGELOG 的绝对链接；
#   ④ 找不到 tag 时**退回 `[Unreleased]`**（不是直接空手去建 Release）。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="$(command -v python3 || command -v python)"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }

echo "== 发版说明生成器（scripts/releaseNotes.py）=="

if [[ -z "${PY}" ]]; then
  echo "NOTE: 没有 python，跳过"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

SCRIPT="${ROOT}/scripts/releaseNotes.py"
CHANGELOG="${ROOT}/CHANGELOG.md"
WORKFLOW="${ROOT}/.github/workflows/release-fork.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

if [[ ! -f "${SCRIPT}" ]]; then
  fail "找不到 ${SCRIPT}（发版说明生成器不在仓库里？）"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 1
fi
pass "脚本存在：scripts/releaseNotes.py"

run() { # <tag> <输出文件> <stderr 文件> [额外参数…]
  local tag="$1" out="$2" err="$3"
  shift 3
  ( cd "${ROOT}" && "${PY}" scripts/releaseNotes.py "${tag}" CKboss/vanblog --changelog "${CHANGELOG}" "$@" >"${out}" 2>"${err}" )
}

# ── ① 小的一节：逐字照发（v2026.9.6 是已发布的真实一节）──────────────────
run v2026.9.6 "${TMP}/small.md" "${TMP}/small.err"
RC=$?
if [[ "${RC}" -eq 0 && -s "${TMP}/small.md" ]]; then
  pass "取 v2026.9.6 那一节能成功（rc=0、输出非空）"
else
  fail "取 v2026.9.6 失败（rc=${RC}，输出 $(wc -c < "${TMP}/small.md" 2>/dev/null || echo 0) 字节）"
fi
if grep -q "压成摘要\|超过阈值" "${TMP}/small.err"; then
  fail "🔴 v2026.9.6 那一节**不该**被压缩（它只有几千字符）⇒ 压缩阈值判错了，会把已有发布说明也压掉"
else
  pass "v2026.9.6 没有被压缩（小的节逐字照发，不丢内容）"
fi
if grep -q "https://github.com/CKboss/vanblog/blob/v2026.9.6/" "${TMP}/small.md" ||
   ! grep -qE '\]\((docs/|README\.md|CHANGELOG\.md|scripts/|packages/)' "${TMP}/small.md"; then
  pass "相对链接被改写成指向该 tag 的绝对地址（Release 页面上相对链接是死的）"
else
  fail "输出里还留着相对链接：$(grep -oE '\]\((docs/|README\.md|CHANGELOG\.md|scripts/|packages/)[^)]*' "${TMP}/small.md" | head -2 | tr '\n' ' ')"
fi

# ── ②③ 超长的节：必须压成摘要、**真的压了**、且不丢批次 ─────────────────────
# 🔴 2026-10-06：这一整块原来**写死了"[Unreleased] 就是那节超长的"**（用一个不存在的 tag 退回去测）。
#    发版把 `[Unreleased]` 收成 `## [v2026.10.1]` 之后，Unreleased 只剩 309 字符 ⇒ 6 条断言全红。
#    ⚠️ 值得夸一句：它们的**反空转**那条如实报了"压缩路径没被走到 ⇒ 下面几条都是空的绿"，
#    🔴 没有假装通过 —— 这正是反空转判据存在的意义（否则发版之后守卫会悄悄变成空的绿，
#    而"发版之后"恰恰是它最该继续工作的时候）。
#    修法：① 不再写死哪一节大，而是**把所有超过阈值的节都测一遍**（这样"马上要打 tag 的那一节"必然被覆盖，
#          而不是由"历史上最大的那一节"碰巧代表 —— 实测 v2026.9.3 有 16.6 万字符却只有 2 个批次，
#          拿它当唯一样本 ⇒ "摘要不丢批次"几乎验不到东西）；
#          ② 一节都不超长时（刚发完版就是这种状态），退回"最大的那节 + `--limit 2000` **强制**走压缩路径"。
PLAN="$("${PY}" - "${CHANGELOG}" <<'PYPLAN'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
parts = re.split(r'(?m)^## \[([^\]]+)\][^\n]*\n', text)
sec = {}
for i in range(1, len(parts) - 1, 2):
    sec[parts[i].strip()] = parts[i + 1].strip()
if not sec:
    print('BIG_KEY='); print('BIG_CHARS=0'); print('OVER_KEYS='); sys.exit(0)
big = max(sec.items(), key=lambda kv: len(kv[1]))
print('BIG_KEY=%s' % big[0])
print('BIG_CHARS=%d' % len(big[1]))
over = sorted([k for k, v in sec.items() if len(v) > 100000], key=lambda k: -len(sec[k]))
print('OVER_KEYS=%s' % ','.join(over))
PYPLAN
)"
eval "${PLAN}"

# 每一节的检查（含反空转、"确实压了"的反证、批次不丢、链接）
check_section() { # <key> <eff_limit> [额外参数…]
  local key="$1" eff="$2"
  shift 2
  local extra=("$@")
  local out="${TMP}/sec-${key}.md" err="${TMP}/sec-${key}.err" long="${TMP}/sec-${key}.long"
  run "${key}" "${out}" "${err}" ${extra+"${extra[@]}"}
  local raw heads outchars
  raw="$("${PY}" - "${CHANGELOG}" "${key}" <<'PYRAW'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
parts = re.split(r'(?m)^## \[([^\]]+)\][^\n]*\n', text)
sec = {}
for i in range(1, len(parts) - 1, 2):
    sec[parts[i].strip()] = parts[i + 1].strip()
body = sec.get(sys.argv[2], '')
print(len(body))
print(len(re.findall(r'(?m)^### ', body)))
cands = [l.strip() for l in body.split('\n')
         if len(l.strip()) >= 80 and not l.strip().startswith(('|', '#', '```', '>'))]
cands.sort(key=len, reverse=True)
open(sys.argv[1] + '.long.tmp', 'w', encoding='utf-8').write(cands[0][:60] if cands else '')
PYRAW
)"
  heads="$(printf '%s\n' "${raw}" | sed -n 2p)"
  raw="$(printf '%s\n' "${raw}" | sed -n 1p)"
  long="$(cat "${CHANGELOG}.long.tmp" 2>/dev/null)"
  rm -f "${CHANGELOG}.long.tmp"
  outchars="$(wc -m < "${out}" | tr -d ' ')"
  if [[ "${raw}" -gt "${eff}" ]]; then
    pass "[${key}] 反空转：原文 ${raw} 字符 > 阈值 ${eff} ⇒ 压缩路径真的被走到"
  else
    fail "[${key}] 原文只有 ${raw} 字符（≤ 阈值 ${eff}）⇒ 压缩路径没被走到，本节其余断言都是空的绿"
  fi
  if [[ "${outchars}" -lt "${eff}" ]]; then
    pass "[${key}] 压到 ${outchars} 字符（< ${eff} ⇒ 不会撞 Release 正文长度上限）"
  else
    fail "🔴 [${key}] 输出仍有 ${outchars} 字符（≥ ${eff}）⇒ 压缩没生效，发版那天创建 Release 会被 API 拒"
  fi
  if grep -q "超过阈值" "${err}"; then
    pass "[${key}] 压缩这件事**说出来**了（stderr 写了原文字符数与阈值）—— 静默压缩会让人以为发的是全文"
  else
    fail "[${key}] 压缩了却没在 stderr 里说明（静默降级：读日志的人会以为 Release 里是完整正文）"
  fi
  # 🔴 反证：完整正文里最长的那行不许出现在摘要里（否则"压了"是假的）
  # 🔴 必须写 `grep -qF --`：样本行以 `- ` 开头，不加 `--` 时 grep 把它当**选项**
  #    （实测报 `grep: invalid option -- ' '` 并非 0 退出）⇒ `if grep …` 判假 ⇒
  #    这条反证会变成**空的绿**（"grep 出错"与"确实没有"分不开）。
  #    👉 一般化：**把变量当 grep 的模式用，一律加 `--`**。
  if [[ -n "${long}" ]]; then
    if grep -qF -- "${long}" "${out}"; then
      fail "🔴 [${key}] 摘要里出现了完整正文的长句（${long:0:40}…）⇒ 其实没压缩，只是截断了前面部分"
    else
      pass "[${key}] 反证成立：原文最长的那行（${long:0:30}…）不在摘要里 ⇒ 真的压了"
    fi
  else
    fail "[${key}] 反证取不到样本（没有 >=80 字的正文行）⇒ 换一个反证口径，别留着空的绿"
  fi
  local hout
  hout="$(grep -c '^### ' "${out}" || true)"
  if [[ "${hout}" -eq "${heads}" ]]; then
    pass "[${key}] 摘要里 ${hout} 个批次标题 == 原文 ${heads} 个（一个批次都没丢）"
  else
    fail "[${key}] 批次标题数不一致：原文 ${heads} / 摘要 ${hout} ⇒ 摘要丢批次（读者会以为那一版没做这些）"
  fi
  if grep -q "CHANGELOG.md](https://github.com/CKboss/vanblog/blob/" "${out}"; then
    pass "[${key}] 摘要给了完整 CHANGELOG 的**绝对**链接（内容一个字都没丢，只是不在 Release 正文里）"
  else
    fail "[${key}] 摘要里没有指向完整 CHANGELOG 的绝对链接 ⇒ 读者拿到摘要就以为那是全部"
  fi
}

if [[ -z "${BIG_KEY:-}" ]]; then
  fail "CHANGELOG 里一节都没解析出来 ⇒ 切段口径坏了，后面几条都是空的绿"
else
  TARGETS="${OVER_KEYS:-}"
  if [[ -n "${TARGETS}" ]]; then
    echo "  · 本轮被测的节（都超过默认阈值 100000）：${TARGETS}"
    IFS=',' read -ra KEYS <<< "${TARGETS}"
    for k in ${KEYS+"${KEYS[@]}"}; do
      [[ -n "${k}" ]] && check_section "${k}" 100000
    done
  else
    # 刚发完版的状态：一节都不超长 ⇒ 用 --limit 2000 **强制**把压缩路径走出来
    echo "  · 没有超过 100000 字符的节（刚发完版就是这种状态）⇒ 用 --limit 2000 强制测压缩路径：[${BIG_KEY}]"
    check_section "${BIG_KEY}" 2000 --limit 2000
  fi
fi

# ── ④ 找不到 tag 时退回 [Unreleased] ──────────────────────────────────────
# 🔴 2026-10-06 改：这条原来复用 ②③ 那个"大节"的输出文件，并靠 `grep "累积了"` 认它 ——
#    两处都写死了旧状态（文件已改名；`[Unreleased]` 现在是空的、里面根本没有"累积了"这三个字）。
#    改成：自己跑一次不存在的 tag，然后拿**当前 [Unreleased] 一节的第一行非空文本**当指纹来比对
#    （🔴 指纹从 CHANGELOG 现取，不写死字面量 ⇒ 以后 Unreleased 写成什么样都不用改判据）。
run "v-does-not-exist-$$" "${TMP}/fallback.md" "${TMP}/fallback.err"
UNREL_MARK="$("${PY}" - "${CHANGELOG}" <<'PYMARK'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
parts = re.split(r'(?m)^## \[([^\]]+)\][^\n]*\n', text)
sec = {}
for i in range(1, len(parts) - 1, 2):
    sec[parts[i].strip()] = parts[i + 1].strip()
body = sec.get('Unreleased', '')
lines = [l.strip() for l in body.split('\n') if l.strip()]
print(lines[0][:60] if lines else '')
PYMARK
)"
if [[ -z "${UNREL_MARK}" ]]; then
  fail "[Unreleased] 一节是空的/不存在 ⇒ 这条退回判据没有指纹可比（先给 Unreleased 写点内容，或换一个口径）"
elif grep -qF -- "${UNREL_MARK}" "${TMP}/fallback.md"; then
  pass "tag 不存在时退回了 [Unreleased] 一节（指纹：${UNREL_MARK:0:36}…）⇒ 不会空手去建 Release"
else
  fail "tag 不存在时没有退回 [Unreleased]（指纹「${UNREL_MARK:0:36}」不在输出里；输出开头是：$(head -1 "${TMP}/fallback.md" | cut -c1-50)）"
fi

# ── ④b 🔴 小节引言里"自称的批次数/日期跨度"必须与正文**对得上** ────────────────
# 起因（发版当天实测）：我在 `## [v2026.10.1]` 的引言里写了"**47 批**，2026-09-28 → 2026-10-06"，
# 而那一节实际有 **48** 个 `###`、日期跨度是 **2026-09-24 → 2026-10-06**（末尾还有一条 09-24 的更正）
# ⇒ 🔴 生成的 Release 正文里同时出现"47 批"（我写的）与"48 个批次"（生成器数的），自相矛盾。
# 根因是**用了上一轮的测量值**而没有现量 —— 与本仓库"数字必须现量"的纪律同源。
# 👉 所以把这条变成判据：同一份文件里出现两处口径（人写的引言 vs 可数的正文），就必须对账。
INTRO="$("${PY}" - "${CHANGELOG}" <<'PYINTRO'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
parts = re.split(r'(?m)^## \[([^\]]+)\][^\n]*\n', text)
sec = {}
for i in range(1, len(parts) - 1, 2):
    sec[parts[i].strip()] = parts[i + 1].strip()
bad = 0
checked = 0
for key, body in sec.items():
    if key == 'Unreleased':
        continue
    # 引言 = 第一个 `### ` 之前的部分
    head = re.split(r'(?m)^### ', body)[0]
    n_real = len(re.findall(r'(?m)^### ', body))
    m = re.search(r'\*\*(\d+)\s*批\*\*', head)
    if m:
        checked += 1
        if int(m.group(1)) != n_real:
            print('BADCOUNT %s 自称 %s 批 / 实际 %d 批' % (key, m.group(1), n_real)); bad += 1
    d = re.findall(r'(\d{4}-\d{2}-\d{2})', head)
    dates = sorted({x[:10] for x in re.findall(r'(?m)^### (\d{4}-\d{2}-\d{2})', body)})
    if len(d) >= 2 and dates:
        checked += 1
        if d[0] != dates[0] or d[-1] != dates[-1]:
            print('BADRANGE %s 自称 %s → %s / 实际 %s → %s' % (key, d[0], d[-1], dates[0], dates[-1])); bad += 1
print('CHECKED=%d BAD=%d' % (checked, bad))
PYINTRO
)"
CHECKED="$(printf '%s\n' "${INTRO}" | sed -n 's/^CHECKED=\([0-9]*\) BAD=.*/\1/p')"
BADN="$(printf '%s\n' "${INTRO}" | sed -n 's/^CHECKED=[0-9]* BAD=\([0-9]*\)/\1/p')"
if [[ "${CHECKED:-0}" -ge 1 ]]; then
  pass "反空转：真的对账了 ${CHECKED} 处"自称批次数/日期跨度"的引言（不是没扫到）"
else
  fail "一处"自称批次数"的引言都没扫到 ⇒ 口径变了（或正则失效），这条判据成了空的绿"
fi
if [[ "${BADN:-1}" -eq 0 ]]; then
  pass "所有已发布小节的引言与正文对得上（自称的批次数 == 实际 \`###\` 数、日期跨度 == 实际首末日期）"
else
  fail "🔴 引言与正文对不上：$(printf '%s\n' "${INTRO}" | grep -E '^BAD' | tr '\n' '; ') ⇒ Release 说明会自相矛盾（人写的数字必须现量，不能用上一轮的）"
fi

# ── ⑤ 单一口径：workflow 必须**调用这个脚本**，不许再自己内联一份 ────────────
# 🔴 否则就是"同一性质两处口径"：改了脚本、workflow 还是老逻辑（发版那天才炸）。
if grep -q "python3 scripts/releaseNotes.py" "${WORKFLOW}"; then
  pass "release-fork.yml 调用的是仓库里的脚本（单一口径）"
else
  fail "release-fork.yml 没有调用 scripts/releaseNotes.py ⇒ 又变成两处口径（workflow 里那份不会跟着改）"
fi
if grep -q "<<'PY'" "${WORKFLOW}"; then
  fail "release-fork.yml 里还留着内联 python heredoc（<<'PY'）⇒ 那份逻辑本机跑不到、也没人守"
else
  pass "release-fork.yml 里已经没有内联 python heredoc"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
[[ "${FAIL}" -eq 0 ]]
