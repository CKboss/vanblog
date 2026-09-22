#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# `docs/changelog.md` 必须与根 `CHANGELOG.md` 同步（前者是 `scripts/releaseDoc.js` 的产物）。
#
# 🔴 为什么需要这条守卫：`scripts/tests/docs-consistency.test.sh` **刻意排除了** `docs/changelog.md`
#    （镜像会按设计重写链接，与根文件永远不会逐字节相同）⇒ **两者不同步不会有任何东西变红**。
#    本周期已经因此出过一次事故：一次 python 编辑的 `assert` 失败 ⇒ 根 `CHANGELOG.md` **根本没被写**，
#    而同一条命令链里后面的 `node scripts/releaseDoc.js` **照跑** ⇒ 产生了一个**假的 `doc-version` bump**
#    （0.12.192 → 0.12.193，而镜像内容其实一个字都没变）。是父代理靠 `git status` 发现
#    "只有 doc-version 脏、镜像没脏"才识破的 —— 也就是说，**它当时没有任何守卫可依赖**。
#
# 🔴 判定不同步的唯一可靠办法是**真的跑一次生成器再比对**，而生成器默认会写
#    `docs/changelog.md` 与 `doc-version` ⇒ 守卫本身会有副作用（在 CI 里改动工作树）。
#    解法是生成器的 `--out <file>` 模式：只把内容写到指定路径，**一个字节都不碰仓库**。
#    本守卫因此也顺带钉住"`--out` 模式确实无副作用"（见第 4 节）—— 那条断言是这套办法的前提，
#    它若失效，本守卫就会变成一个"每跑一次就把仓库改一次"的东西。
#
# ⚠️ 比对用 `cmp`/`diff`，**不要把内容读进 shell 变量**：镜像有 ~770 KB，
#    读进变量会撑爆内存或撞上 bash 的变量长度限制。失败时只打印 diff 的前若干行。
# ---------------------------------------------------------------------------
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GEN="${ROOT}/scripts/releaseDoc.js"
MIRROR="${ROOT}/docs/changelog.md"
SRC="${ROOT}/CHANGELOG.md"
DOCVER="${ROOT}/doc-version"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
note() { echo "NOTE: $*"; }

echo "== CHANGELOG 镜像同步检查 =="

# ---------- 0) 前置：文件与 node ----------
if [[ ! -f "${GEN}" ]]; then
  fail "找不到生成器 ${GEN}"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 1
fi
for f in "${MIRROR}" "${SRC}" "${DOCVER}"; do
  if [[ ! -f "${f}" ]]; then
    fail "找不到 ${f}（本守卫需要根 CHANGELOG、镜像与 doc-version 三者都在）"
  fi
done

NODE="$(command -v node || true)"
if [[ -z "${NODE}" ]]; then
  # ⚠️ 与 docs-links.test.sh 对 python 的处理同口径：缺工具就如实说明并跳过，不假装通过。
  #    CI 里这一步排在 Setup Node 之后，所以不会走到这里。
  note "本机没有 node，无法跑生成器 ⇒ 本次未验证镜像同步（不是通过）"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/changelog-mirror-XXXXXX")"
trap 'rm -rf "${T}"' EXIT INT TERM

# ---------- 1) 反空转：比对的两边都必须是"非平凡"的内容 ----------
# 🔴 没有这一节，"两边都是空文件"会恒真地通过（本仓库已多次写出这种恒真守卫）。
for pair in "根 CHANGELOG:${SRC}" "入库镜像:${MIRROR}"; do
  label="${pair%%:*}"; f="${pair#*:}"
  bytes="$(wc -c <"${f}" 2>/dev/null | tr -d ' ')"
  lines="$(wc -l <"${f}" 2>/dev/null | tr -d ' ')"
  if [[ "${bytes:-0}" -lt 20000 ]]; then
    fail "${label} ${f} 只有 ${bytes:-0} 字节 ⇒ 内容异常小，比对结果不可信（下界 20000）"
  fi
  if [[ "${lines:-0}" -lt 200 ]]; then
    fail "${label} ${f} 只有 ${lines:-0} 行 ⇒ 内容异常小（下界 200）"
  fi
done
# 两份都必须含至少一个已发布版本节标题，否则"同步"可能只是"两边都被清空了"
src_vers="$(grep -cE '^## \[v' "${SRC}" 2>/dev/null || true)"
mir_vers="$(grep -cE '^## \[v' "${MIRROR}" 2>/dev/null || true)"
if [[ "${src_vers:-0}" -lt 1 ]]; then
  fail "根 CHANGELOG.md 里找不到任何已发布版本节（形如以两个井号加方括号 v 开头的行）⇒ 反空转失败"
fi
if [[ "${mir_vers:-0}" -lt 1 ]]; then
  fail "docs/changelog.md 里找不到任何已发布版本节 ⇒ 反空转失败"
fi
if [[ "${src_vers:-0}" -eq "${mir_vers:-0}" && "${src_vers:-0}" -ge 1 ]]; then
  pass "两边都含版本节且数量一致（各 ${src_vers} 个）⇒ 比对的不是两份空文件"
fi

# ---------- 2) 用 --out 生成到临时路径（不碰仓库） ----------
GEN_OUT="${T}/generated.md"
if ! "${NODE}" "${GEN}" --out "${GEN_OUT}" >"${T}/gen.log" 2>"${T}/gen.err"; then
  fail "生成器的 --out 模式非 0 退出（rc 见下），无法判定同步性"
  head -6 "${T}/gen.err" 2>/dev/null | sed 's/^/      /'
  head -3 "${T}/gen.log" 2>/dev/null | sed 's/^/      /'
fi
if [[ ! -s "${GEN_OUT}" ]]; then
  fail "生成器的 --out 模式没有产出非空文件 ⇒ 无法判定同步性"
fi

# ---------- 3) 比对：生成产物 vs 入库镜像 ----------
if [[ -s "${GEN_OUT}" ]]; then
  if cmp -s "${GEN_OUT}" "${MIRROR}"; then
    pass "docs/changelog.md 与根 CHANGELOG.md 同步（生成产物逐字节相同，$(wc -c <"${GEN_OUT}" | tr -d ' ') 字节）"
  else
    fail "docs/changelog.md 与根 CHANGELOG.md **不同步** ⇒ 修法：跑 node scripts/releaseDoc.js，然后 git add docs/changelog.md doc-version 一起提交（生成器会同时 bump doc-version，两个文件必须同一次提交）"
    # ⚠️ 只打印前若干行：镜像有 ~770 KB，全量 diff 会淹没 CI 日志。
    echo "      ---- diff 前 12 行（< 是入库镜像，> 是应当生成的内容）----"
    diff "${MIRROR}" "${GEN_OUT}" 2>/dev/null | head -12 | sed 's/^/      /'
  fi

  # 🔴 尺子有效性反证（内部、不碰仓库）：把生成产物复制一份并扰动一个字节，
  #    比对**必须**报出不同。否则"上面那条 pass"可能来自一个坏掉的比较器。
  cp -p "${GEN_OUT}" "${T}/perturbed.md"
  printf 'x\n' >>"${T}/perturbed.md"
  if cmp -s "${T}/perturbed.md" "${MIRROR}"; then
    fail "尺子失效：把生成产物追加一个字节后仍与入库镜像逐字节相同 ⇒ cmp 判据不可信，上面那条同步结论无效"
  else
    pass "尺子有效：扰动一个字节后 cmp 确实报出不同（所以上面那条同步结论是真的比出来的）"
  fi
fi

# ---------- 4) 钉住 "--out 模式无副作用"（这是整套办法的前提） ----------
# 🔴 如果 --out 偷偷也写了 doc-version 或镜像，本守卫每跑一次就会改动工作树：
#    在 CI 里表现为"检查跑完工作树脏了"，在本地表现为莫名其妙的 doc-version 漂移。
dv_before="$(sha256sum "${DOCVER}" 2>/dev/null | cut -d' ' -f1)"
mir_before="$(sha256sum "${MIRROR}" 2>/dev/null | cut -d' ' -f1)"
status_before="$(cd "${ROOT}" && git status --porcelain 2>/dev/null | sha256sum | cut -d' ' -f1)"
"${NODE}" "${GEN}" --out "${T}/again.md" >"${T}/gen2.log" 2>"${T}/gen2.err"
dv_after="$(sha256sum "${DOCVER}" 2>/dev/null | cut -d' ' -f1)"
mir_after="$(sha256sum "${MIRROR}" 2>/dev/null | cut -d' ' -f1)"
status_after="$(cd "${ROOT}" && git status --porcelain 2>/dev/null | sha256sum | cut -d' ' -f1)"
if [[ "${dv_before}" == "${dv_after}" ]]; then
  pass "--out 模式没有改 doc-version（守卫本身不会造成假的版本号 bump）"
else
  fail "--out 模式改了 doc-version（${dv_before:0:12} → ${dv_after:0:12}）⇒ 守卫有副作用，会在 CI 里改动工作树"
fi
if [[ "${mir_before}" == "${mir_after}" ]]; then
  pass "--out 模式没有改 docs/changelog.md"
else
  fail "--out 模式改了 docs/changelog.md ⇒ 守卫有副作用"
fi
if [[ "${status_before}" == "${status_after}" ]]; then
  pass "--out 模式跑完后 git status 完全没变（一个字节都不写仓库）"
else
  fail "--out 模式跑完后 git status 变了 ⇒ 守卫有副作用；请检查生成器是不是又落盘了"
fi
# 两次 --out 必须产出相同内容（确定性；否则比对结果取决于跑几次）
if [[ -s "${T}/again.md" ]] && cmp -s "${GEN_OUT}" "${T}/again.md"; then
  pass "--out 模式是确定性的（两次产物逐字节相同）"
else
  fail "--out 模式两次产物不同 ⇒ 生成不确定，比对结果不可信"
fi

# ---------- 5) 源码级：钉住 fail-loud 与"先 return 再碰 doc-version"的顺序 ----------
# ⚠️ 只读源码文本，不执行默认模式（执行它会真的 bump doc-version）。
GEN_CODE="$(cat "${GEN}" 2>/dev/null)"
# 剥掉注释再断言"存在/不存在"，否则本文件与生成器里的解释性文字会互相喂饱断言。
GEN_CODE_ONLY="$(printf '%s' "${GEN_CODE}" | sed -e 's://.*::' -e 's:/\*.*\*/::g')"

if printf '%s' "${GEN_CODE_ONLY}" | grep -qF 'process.exit(9)'; then
  pass "生成器对参数错误 fail-loud（存在退出码 9 的分支）"
else
  fail "生成器里没有 fail-loud 的退出码 9 分支 ⇒ 参数错误可能静默回退到默认行为，而默认行为会 bump doc-version"
fi
if printf '%s' "${GEN_CODE_ONLY}" | grep -qF "startsWith('-')"; then
  pass "生成器把以短横线开头的 --out 取值当成缺值处理（不会把下一个 flag 当文件名）"
else
  fail "生成器不再把以短横线开头的 --out 取值当成缺值 ⇒ --out --foo 会把 --foo 当文件名"
fi
# 🔴 顺序断言：--out 分支必须在写 doc-version 之前 return，否则 --out 也会 bump 版本号。
out_idx="$(printf '%s' "${GEN_CODE_ONLY}" | grep -n 'outPath !== null' | head -1 | cut -d: -f1)"
dv_idx="$(printf '%s' "${GEN_CODE_ONLY}" | grep -n 'docVersionPath' | head -1 | cut -d: -f1)"
if [[ -n "${out_idx}" && -n "${dv_idx}" && "${out_idx}" -lt "${dv_idx}" ]]; then
  pass "生成器里 --out 分支（第 ${out_idx} 行）在碰 doc-version（第 ${dv_idx} 行）之前就返回"
else
  fail "生成器里 --out 分支与 doc-version 的先后关系不对（out_idx='${out_idx:-空}' dv_idx='${dv_idx:-空}'）⇒ --out 可能也会 bump 版本号"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
