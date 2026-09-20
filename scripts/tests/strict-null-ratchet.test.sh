#!/usr/bin/env bash
# 「确定性空值解引用」的**棘轮守卫**：数量只许减、不许增。
#
# ## 为什么是棘轮，而不是一次性清干净、直接把 strictNullChecks 打开
# 本仓库 `packages/server/tsconfig.json` 里 `"strictNullChecks": false`，所以编译器平时**不报**这类错。
# 而这一族已经造成过三个真实缺陷（都在最不该出问题的路径上）：
#   - `provider/auth/jwt.strategy.ts`：库里没有 `id:0` 管理员时鉴权路径抛 TypeError ⇒ **500 而不是 401**
#   - `controller/admin/collaborator/collaborator.controller.ts`：同条件 **500**（后台会显示"这个站没有管理员"）
#   - `utils/backupVerify.ts`：灾难恢复路径上的空值解引用
# 真把开关打开还需要额外清 **100+ 条**别的 strict 错误（实测同一份输出里 TS2322 / TS2345 / TS2339 / TS2769
# 共 111 条，多是 Mongoose 文档 vs DTO 的赋值形状，**不是崩溃**），而且
# 🔴 **TypeScript 不支持在同一个 project 内按目录分别开这个开关** ⇒ 没法"先只对 utils/ 严格"。
# 所以路线是：**先防倒退（本守卫）→ 再按文件清 → 最后才开开关**。
# ⚠️ 一步到位会让每个 PR 都挂着几十条红，而**常红灯训练出的是"忽略红"**，那比没有检查更糟。
#
# ## 🔴 伞形陷阱（实测，务必别"简化"这条命令）
# `--strict` **量不到**这些东西：实测 `--strict` 下四类命中 = **0**、总错误只有 6 条；
# 而 `--strictNullChecks` 单项开关下四类命中 = **32**。原因是 tsconfig 里**显式**写了
# `"strictNullChecks": false`：**显式的 CLI 单项开关能压过它，伞形 `--strict` 不能**。
# ⇒ 本守卫必须用单项开关，并且**下面有一条断言专门钉住这个事实**（第 5 节），
#    否则将来有人把命令"简化"成 `--strict`，这条守卫会变成**恒绿**（0 ≤ 32 永远成立）。
#
# ## 可复跑的主指标命令（与本守卫等价）
#   cd packages/server && ./node_modules/.bin/tsc -p tsconfig.build.json --noEmit --strictNullChecks \
#     --tsBuildInfoFile "$(mktemp -d)/snc.tsbuildinfo" 2>&1 \
#     | grep -cE 'error (TS18047|TS18048|TS2531|TS2532)'
#
# ⚠️ 本脚本**需要 node_modules 与 tsc**（约 30 秒，三次 tsc），所以进 CI 的 `server-test` 档，
#    **不是** `guards-core`（那一档的定位是"不需要依赖"）。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER="${ROOT}/packages/server"
TSC="${SERVER}/node_modules/.bin/tsc"
TSCONFIG="tsconfig.build.json"

# ── 基线：只许减不许增 ───────────────────────────────────────────────────────
# 🔴 减少之后请把常量改成新的实测值，并在提交信息里写清"清掉了哪几处、各自的可达性与降级是什么"。
#    （减少时本守卫会**打出提示但仍然 pass** —— 见第 3 节的取舍说明。）
BASELINE=32

# 四类「确定性空值解引用」：
#   TS18047 'x' is possibly 'null'          TS18048 'x' is possibly 'undefined'
#   TS2531  Object is possibly 'null'       TS2532  Object is possibly 'undefined'
CODES_RE='error (TS18047|TS18048|TS2531|TS2532)'
# 配置/工程类错误（TS5xxx / TS6xxx）：出现它们说明**命令本身没跑对**（tsconfig 读不到、
# composite 冲突、参数非法…），此时四类命中数**毫无意义**（很可能是 0）⇒ 必须硬失败，不能当绿。
CFG_CODES_RE='error TS[56][0-9][0-9][0-9]'
# 「仍在编译范围内」的热点文件：钉的是**编译范围**而不是**错误数**，
# 所以把它们修干净不会打红本守卫，而把它们排除出编译（或改名/挪走）会。
HOT_FILES=(
  "src/provider/rss/rss.provider.ts"
  "src/provider/meta/meta.provider.ts"
  "src/provider/static/static.provider.ts"
)
TIMEOUT_S=300

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# ---------- 0) 前置：没有 tsc 就跳过（与 start-js.test.sh 同一约定：NOTE + exit 0） ----------
if [[ ! -x "${TSC}" ]]; then
  echo "NOTE: 没有 ${TSC}（node_modules 未安装），跳过 strictNullChecks 棘轮守卫"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi
pass "tsc 可用（${TSC#"${ROOT}/"}）"

# 跑一次 tsc，把输出写到 $2，退出码写到 $3（全局变量，因为 bash 函数不能返回字符串）
# ⚠️ 每次都用一个**全新的** tsBuildInfoFile：复用同一个会让 tsc 走增量、把错误"跳过"，
#    命中数变成 0 —— 本仓库已踩过这个坑（它让 5 个有效变异对照被误标成 COMPILE-FAIL）。
# ⚠️ timeout 是必须的：这条命令正常约 10 秒，挂住的话整个 CI job 会卡到超时而不是报红。
# ⚠️ 必须 cd 进 packages/server 再跑：`-p tsconfig.build.json` 是**相对 cwd** 解析的，
#    在仓库根跑会得到 `error TS5058: The specified path does not exist`，而四类命中数变成 0
#    ⇒ 那正是"0 ≤ 32 恒成立"的假绿形状。本守卫第 2 节的 TS5xxx 断言就是为了抓住这种情况
#    （第一版就是这么被自己抓到的：4 条断言同时报红，而不是静默通过）。
run_tsc() { # $1=额外的 tsc 参数  $2=输出文件  $3=存放 rc 的变量名  $4=tsbuildinfo 路径
  ( cd "${SERVER}" && timeout "${TIMEOUT_S}" "${TSC}" -p "${TSCONFIG}" --noEmit $1 --tsBuildInfoFile "$4" ) >"$2" 2>&1
  printf -v "$3" '%s' "$?"
}

count_codes() { grep -acE "${CODES_RE}" "$1" 2>/dev/null || true; }
count_all()   { grep -acE 'error TS[0-9]+' "$1" 2>/dev/null || true; }
count_cfg()   { grep -acE "${CFG_CODES_RE}" "$1" 2>/dev/null || true; }

# ---------- 1) 主测量：单项开关 --strictNullChecks + --listFiles（一次调用同时拿到诊断与编译清单） ----------
MAIN_OUT="${WORK}/main.txt"
MAIN_RC=0
run_tsc "--strictNullChecks --listFiles" "${MAIN_OUT}" MAIN_RC "${WORK}/main.tsbuildinfo"

if [[ "${MAIN_RC}" == "124" ]]; then
  fail "tsc 超时（>${TIMEOUT_S}s）—— 不是「没有错误」，是**没跑完**"
elif [[ "${MAIN_RC}" != "0" && "${MAIN_RC}" != "1" && "${MAIN_RC}" != "2" ]]; then
  # 0=无错，1/2=有诊断（tsc 对"有错误"的正常退出码）。别的（126/127/信号…）都是调用本身坏了。
  fail "tsc 异常退出（rc=${MAIN_RC}）⇒ 命中数不可信；输出前 3 行：$(head -3 "${MAIN_OUT}" | tr '\n' '|')"
else
  pass "tsc 正常跑完（rc=${MAIN_RC}；0/1/2 都是「有诊断」的正常形状）"
fi

# ---------- 2) 防恒真（一）：绝不能有配置/工程类错误 ----------
# 🔴 这是本守卫最重要的一条防假绿：如果 tsconfig 读不到、参数写错、composite 冲突，
#    tsc 会打 TS5xxx/TS6xxx 而**四类命中数会是 0** —— "0 ≤ 32" 于是永远 pass。
CFG_N="$(count_cfg "${MAIN_OUT}")"
if [[ "${CFG_N}" == "0" ]]; then
  pass "输出里没有 TS5xxx/TS6xxx 配置类错误（⇒ 命中数是真量出来的，不是命令没跑对）"
else
  fail "输出里有 ${CFG_N} 条 TS5xxx/TS6xxx 配置类错误 ⇒ 命令没跑对，四类命中数不可信：$(grep -aE "${CFG_CODES_RE}" "${MAIN_OUT}" | head -2 | tr '\n' '|')"
fi

# 输出必须非空（listFiles 至少有上千行；空输出意味着 tsc 根本没产生任何东西）
MAIN_LINES="$(wc -l <"${MAIN_OUT}" 2>/dev/null || echo 0)"
if [[ "${MAIN_LINES}" -gt 100 ]]; then
  pass "tsc 输出非空（${MAIN_LINES} 行，含 --listFiles 清单）"
else
  fail "tsc 输出只有 ${MAIN_LINES} 行 ⇒ tsc 可能没真的编译（空输出会让命中数假性为 0）"
fi

# listFiles 行里不该混进诊断（文件名里含 "error TS" 会污染计数）——一条便宜的形状自检
PATHLIKE_DIAG="$(grep -acE '^/.*error TS[0-9]' "${MAIN_OUT}" 2>/dev/null || true)"
assert_eq "${PATHLIKE_DIAG}" "0" "--listFiles 的绝对路径行里没有混进诊断文本（计数不会被污染）"

# ---------- 3) 棘轮本体 ----------
COUNT="$(count_codes "${MAIN_OUT}")"
COUNT="${COUNT:-0}"
TOTAL_ALL="$(count_all "${MAIN_OUT}")"

echo "  · 四类确定性空值解引用命中 = ${COUNT}（基线 ${BASELINE}）；同次输出的 strict 错误总数 = ${TOTAL_ALL}"

if [[ "${COUNT}" -eq 0 ]]; then
  # 🔴 尺子有效性：0 有两种可能 —— ①真的全修好了 ②测量坏了。
  #    本守卫选择**在 0 时报红**，逼一次有意识的处理（把 BASELINE 改成 0 并留下说明，
  #    或者发现是测量坏了）。理由与"减少时只提示不报红"正好相反：
  #    减少是**已知方向**的好事，而 0 是**歧义**信号，静默通过就等于让守卫悄悄失效。
  fail "四类命中数 = 0：要么真的全修好了（那就把 BASELINE 改成 0 并在提交信息里说明），要么测量坏了（先看上面几条防恒真断言）"
elif [[ "${COUNT}" -gt "${BASELINE}" ]]; then
  fail "🔴 棘轮被打破：确定性空值解引用从 ${BASELINE} 增到 ${COUNT}（新增 $((COUNT - BASELINE)) 处）。按文件分布："
  grep -aE "${CODES_RE}" "${MAIN_OUT}" | sed 's/(.*//' | sort | uniq -c | sort -rn | head -8 | sed 's/^/      /'
  echo "      每一处都要判断：可达性是什么？正确的降级是什么（401/404/400/500/返回 null/跳过）？"
  echo "      ⚠️ 不要一律加 ?. 然后静默继续 —— 那会把「数据损坏」变成「静默的错答案」，比崩溃更糟。"
elif [[ "${COUNT}" -lt "${BASELINE}" ]]; then
  pass "棘轮守住了：命中数 ${COUNT} ≤ 基线 ${BASELINE}"
  # ⚠️ 取舍说明（写在输出里，也写在这里）：**减少时只提示、仍然 pass**。
  #    如果减少也算失败，那每修一处就必须先改守卫常量 —— 那会训练出"顺手把常量放宽"的习惯，
  #    而"顺手放宽"正是棘轮要防的事。所以这里只提示，让下调成为一次**可选的、显式的**动作。
  echo "      NOTE: 基线可以下调到 ${COUNT}（请把本脚本顶部的 BASELINE 改成 ${COUNT}，并在提交信息里写清了哪几处）"
else
  pass "棘轮守住了：命中数 ${COUNT} == 基线 ${BASELINE}（一处未增）"
fi

# ---------- 4) 防恒真（二）：编译范围没被偷偷缩小 ----------
# 钉的是**文件仍在编译清单里**，不是"文件仍有错误" ⇒ 把它们修干净不会打红，
# 而把它们排除出编译（改 exclude、挪目录、改名）会 —— 那正是"错误突然全消失"的常见真因。
for hf in "${HOT_FILES[@]}"; do
  if grep -aqF "${SERVER}/${hf}" "${MAIN_OUT}"; then
    pass "热点文件仍在编译范围内：${hf}"
  else
    fail "热点文件不在 --listFiles 清单里：${hf} ⇒ 它可能被排除出编译范围（那样它的空值错误会「消失」而不是被修好）"
  fi
done

# ---------- 5) 🔴 钉住「伞形 --strict 量不到」这个事实 ----------
# 这条是防止将来有人把命令"简化"成 --strict：那样主测量会变成 0，
# 而"0 ≤ 32"永远成立 ⇒ 守卫恒绿。这里断言**伞形版本的命中数严格小于单项开关版本**。
# ⚠️ 代价是多跑一次 tsc（实测约 10 秒，不是原先估计的 40 秒），完全可接受，所以**默认就跑**、
#    不藏在 --deep 后面：藏在后面的断言等于没有断言（没人会记得打开它）。
STRICT_OUT="${WORK}/strict.txt"
STRICT_RC=0
run_tsc "--strict" "${STRICT_OUT}" STRICT_RC "${WORK}/strict.tsbuildinfo"

if [[ "${STRICT_RC}" == "124" ]]; then
  fail "对照用的 --strict 跑超时（>${TIMEOUT_S}s）"
elif [[ "${STRICT_RC}" != "0" && "${STRICT_RC}" != "1" && "${STRICT_RC}" != "2" ]]; then
  fail "对照用的 --strict 异常退出（rc=${STRICT_RC}）⇒ 无法证明伞形开关量不到东西"
else
  STRICT_COUNT="$(count_codes "${STRICT_OUT}")"
  STRICT_COUNT="${STRICT_COUNT:-0}"
  STRICT_CFG="$(count_cfg "${STRICT_OUT}")"
  echo "  · 对照：--strict 下四类命中 = ${STRICT_COUNT}（单项开关下 = ${COUNT}）"
  if [[ "${STRICT_CFG}" != "0" ]]; then
    fail "--strict 那次跑出了 ${STRICT_CFG} 条配置类错误 ⇒ 对照不可信"
  elif [[ "${STRICT_COUNT}" -lt "${COUNT}" ]]; then
    pass "钉住伞形陷阱：--strict 只量到 ${STRICT_COUNT} 条，严格少于单项开关的 ${COUNT} 条（⇒ 谁把命令改成 --strict，本守卫就会红）"
  else
    fail "伞形陷阱断言失效：--strict 量到 ${STRICT_COUNT} 条，并不少于单项开关的 ${COUNT} 条 ⇒ 要么 TypeScript 行为变了（那 --strict 可以用，请更新本守卫与注释），要么主测量坏了"
  fi
fi

# ---------- 6) 防恒真（三）：同一个测量重复跑必须**稳定** ----------
# 如果命中数会因为增量缓存/并发而漂移，棘轮就没有意义。用一个**新的** tsBuildInfoFile 再跑一次，
# 断言两次的四类命中数完全相同（这也顺带证明了"每次换新 tsbuildinfo"这个做法是必要的）。
AGAIN_OUT="${WORK}/again.txt"
AGAIN_RC=0
run_tsc "--strictNullChecks --listFiles" "${AGAIN_OUT}" AGAIN_RC "${WORK}/again.tsbuildinfo"
if [[ "${AGAIN_RC}" == "0" || "${AGAIN_RC}" == "1" || "${AGAIN_RC}" == "2" ]]; then
  AGAIN_COUNT="$(count_codes "${AGAIN_OUT}")"
  AGAIN_COUNT="${AGAIN_COUNT:-0}"
  assert_eq "${AGAIN_COUNT}" "${COUNT}" "重复测量稳定（换一个全新的 tsBuildInfoFile 再跑，命中数不变）"
else
  fail "重复测量时 tsc 异常退出（rc=${AGAIN_RC}）⇒ 无法证明测量稳定"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
