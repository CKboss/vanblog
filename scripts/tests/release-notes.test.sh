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

# ── ② 超大的一节：必须压成摘要，且**真的压了** ─────────────────────────────
run v2026.10.1-not-exists "${TMP}/big.md" "${TMP}/big.err"
RAW_CHARS="$("${PY}" - "${CHANGELOG}" <<'PYRAW'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
parts = re.split(r'(?m)^## \[([^\]]+)\][^\n]*\n', text)
sec = {}
for i in range(1, len(parts) - 1, 2):
    sec[parts[i].strip()] = parts[i + 1].strip()
print(len(sec.get('Unreleased', '')))
PYRAW
)"
OUT_CHARS="$(wc -m < "${TMP}/big.md" | tr -d ' ')"
# 反空转：原文必须**确实**超过阈值，否则"压成摘要"这条断言是空的绿
if [[ "${RAW_CHARS}" -gt 100000 ]]; then
  pass "反空转成立：[Unreleased] 原文有 ${RAW_CHARS} 字符（> 阈值 100000）⇒ 压缩路径是真的被走到了"
else
  fail "[Unreleased] 原文只有 ${RAW_CHARS} 字符（≤ 100000）⇒ 压缩路径没被走到，下面几条断言都是空的绿（换个更小的 --limit 再跑）"
fi
if [[ "${OUT_CHARS}" -lt 100000 ]]; then
  pass "输出被压到 ${OUT_CHARS} 字符（< 100000 ⇒ 不会撞 Release 正文长度上限）"
else
  fail "🔴 输出仍有 ${OUT_CHARS} 字符（≥ 100000）⇒ 压缩没生效，发版那天创建 Release 会被 API 拒"
fi
if grep -q "超过阈值" "${TMP}/big.err"; then
  pass "压缩这件事**说出来**了（stderr 里写了原文字符数与阈值）—— 静默压缩会让人以为发的是全文"
else
  fail "压缩了却没在 stderr 里说明（静默降级：读日志的人会以为 Release 里是完整正文）"
fi
# 🔴 反证：完整正文里的长句不许出现在摘要里（否则"压了"是假的）
LONG_LINE="$("${PY}" - "${CHANGELOG}" <<'PYLONG'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
parts = re.split(r'(?m)^## \[([^\]]+)\][^\n]*\n', text)
sec = {}
for i in range(1, len(parts) - 1, 2):
    sec[parts[i].strip()] = parts[i + 1].strip()
body = sec.get('Unreleased', '')
# ⚠️ 门槛原来是 >260 字，实测**取不到样本**（CHANGELOG 是手工折行的，正文行大多 100 字上下）
#    ⇒ 反证变成"取不到样本就 fail"。改成取**最长的那一行**（≥80 字即可当样本），
#    并在下面保留"取不到就 fail"的分支（🔴 宁可红，也不要留一条空的绿）。
cands = [l.strip() for l in body.split('\n')
         if len(l.strip()) >= 80 and not l.strip().startswith(('|', '#', '```', '>'))]
cands.sort(key=len, reverse=True)
print(cands[0][:60] if cands else '')
PYLONG
)"
if [[ -n "${LONG_LINE}" ]]; then
  if grep -qF "${LONG_LINE}" "${TMP}/big.md"; then
    fail "🔴 摘要里出现了完整正文的长句（${LONG_LINE:0:40}…）⇒ 其实没压缩，只是截断了前面部分"
  else
    pass "反证成立：完整正文里的长句（${LONG_LINE:0:32}…）没有出现在摘要里 ⇒ 真的压了，不是假压缩"
  fi
else
  fail "反证取不到样本（CHANGELOG 里没有 >=80 字的正文行）⇒ 换一个反证口径，别留着空的绿"
fi

# ── ③ 摘要不许丢批次 + 必须给完整记录的链接 ───────────────────────────────
HEADINGS_RAW="$("${PY}" - "${CHANGELOG}" <<'PYH'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
parts = re.split(r'(?m)^## \[([^\]]+)\][^\n]*\n', text)
sec = {}
for i in range(1, len(parts) - 1, 2):
    sec[parts[i].strip()] = parts[i + 1].strip()
print(len(re.findall(r'(?m)^### ', sec.get('Unreleased', ''))))
PYH
)"
HEADINGS_OUT="$(grep -c '^### ' "${TMP}/big.md" || true)"
if [[ "${HEADINGS_OUT}" -eq "${HEADINGS_RAW}" && "${HEADINGS_RAW}" -gt 10 ]]; then
  pass "摘要里 ${HEADINGS_OUT} 个批次标题 == 原文 ${HEADINGS_RAW} 个（一个批次都没丢）"
else
  fail "批次标题数不一致：原文 ${HEADINGS_RAW} / 摘要 ${HEADINGS_OUT} ⇒ 摘要丢批次（读者会以为那一版没做这些）"
fi
if grep -q "CHANGELOG.md](https://github.com/CKboss/vanblog/blob/" "${TMP}/big.md"; then
  pass "摘要末尾给了完整 CHANGELOG 的**绝对**链接（内容一个字都没丢，只是不在 Release 正文里）"
else
  fail "摘要里没有指向完整 CHANGELOG 的绝对链接 ⇒ 读者拿到摘要就以为那是全部"
fi

# ── ④ 找不到 tag 时退回 [Unreleased] ──────────────────────────────────────
if grep -q "累积了" "${TMP}/big.md"; then
  pass "tag 不存在时退回了 [Unreleased] 一节（不是空手去建 Release）"
else
  fail "tag 不存在时没有退回 [Unreleased]（输出开头是：$(head -1 "${TMP}/big.md" | cut -c1-60)）"
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
