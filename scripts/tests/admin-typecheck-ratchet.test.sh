#!/usr/bin/env bash
# admin（umi 3 + antd 4 + React 17）类型错误的**棘轮守卫**：数量只许减、不许增。
#
# ## 为什么是棘轮，而不是"先清零再加检查"
# `.github/workflows/server-test.yml` 里曾长期写着「admin 的类型检查**故意不加**：当前有 115 个错，
# 加进来等于给每个 PR 挂一盏常红灯，而常红灯训练出来的习惯是"忽略红"；要加就得先清零」。
# 🔴 **那个 115 是量错了口径**：它是用**裸的** `packages/admin/tsconfig.json` 跑出来的，而那份配置
# ① 没有限制 `typeRoots` ⇒ TypeScript 4.9 会扫到家目录的 `@types/bun`（bun-types 需要 TS 5+），
#    实测单独贡献 **115** 条语法错误；② 没有 `@@/*` 别名 ⇒ umi 的插件导出全部解析不到；
# ③ 没有样式模块的 ambient 声明 ⇒ `*.less`/`*.css` 报 TS2307。
# 🔴 **把这三处配置修对之后（`packages/admin/tsconfig.typecheck.json` + `src/typings.d.ts`），
#    实测是 31 条，其中 admin 自己 `src/` 里 29 条、依赖自带的 2 条。**
# ⇒ 所以"必须先清零"这个前提不成立；而 🔴 **"常红灯"的顾虑正是棘轮要解决的**：
#    棘轮不要求 0，只要求**不倒退** —— 这与本仓库既有的 `strict-null-ratchet.test.sh`
#    （基线 10，不是 0）是同一个模式。
#
# ## 修配置消掉的是哪 19 条（都不是真错，是"配置产物"）
#   · TS2305 ×10 + TS2724 ×7 —— `Module '"umi"' has no exported member 'useIntl'/'useModel'/
#     'SelectLang'/'history'/'request'`。真因：`node_modules/umi/types.d.ts` 的内容是
#     `export * from '@@/core/umiExports'`，而 `@@/*` 这个别名 umi 只在**它自己的构建流程**里注入；
#     `src/.umi/core/umiExports.ts` 才是这些符号的真实来源。⇒ **不声明别名，tsc 看不到任何插件导出。**
#   · TS2307 ×2 —— 样式模块找不到类型，由 `src/typings.d.ts` 解决。
# 🔴 **而修对配置还"揭露"了 6 条此前被掩盖的真错**（TS2345 2→4、新增 TS2769 ×3、TS2538 ×1）：
#    因为 `history`/`request`/`useModel` 此前是 error-any，调用点根本没被检查。
#    ⇒ 44 → 31 不是"少了 13 条"，而是"消掉 19 条配置产物、揭露 6 条真错"。
#
# ## 🔴 本守卫最重要的两条防假绿
#   1. **TS5xxx/TS6xxx 必须为 0**：出现它们说明命令本身没跑对（tsconfig 读不到、composite 冲突、
#      参数非法…），此时错误计数**毫无意义**（很可能是 0）⇒ 硬失败，不能当绿。
#   2. **配置产物三类码（TS2305/TS2724/TS2307）必须为 0**：它们一旦回来，说明 `@@/*` 别名、
#      `src/typings.d.ts` 或 `src/.umi` 生成物出了问题的可能性最高。
#      🔴 **特别是 `.umi`**：它是 `umi g tmp` 的生成物（`postinstall` 会跑，CI 的 install 步骤里也会跑），
#      被 gitignore ⇒ **本机全新 clone 后如果没装依赖，它就不存在**，那时 TS2305/TS2724 会全部回来。
#      所以本守卫**在 `.umi` 缺失时 fail-loud 并给出可操作提示，绝不静默跳过** ——
#      🔴 **静默跳过会变成"永远绿"的假门禁，而空的绿比红更危险。**
#
# ## 可复跑的主指标命令（与本守卫等价）
#   cd packages/admin && ./node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit --listFiles \
#     2>&1 | grep -acE '^src/.*error TS[0-9]+'
#
# ⚠️ 本脚本**需要 admin 的 node_modules、tsc 与 src/.umi**（实测约 15-30 秒），
#    所以进 CI 的 `server-test` 档（与 `strict-null-ratchet` 同一档），**不是** `guards-core`
#    （那一档的定位是"不需要依赖"）。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADMIN="${ROOT}/packages/admin"
TSC="${ADMIN}/node_modules/.bin/tsc"
TSCONFIG="tsconfig.typecheck.json"
TIMEOUT_S=300

# ── 基线：只许减不许增 ────────────────────────────────────────────────
# 🔴 减少之后请把常量改成新的实测值，并在提交信息里写清"清掉了哪几处、各自的正确修法是什么"。
#    （减少时本守卫会**打出提示但仍然 pass** —— 与 strict-null-ratchet 同一取舍。）
# 实测于 2026-09-25，口径：`tsconfig.typecheck.json`（typeRoots 受限 + `@@/*` 别名 + 样式声明），
# tsc 4.9.5，`allowJs: false` ⇒ **只覆盖 `.ts`/`.tsx`（105 个文件），不含 `.jsx`/`.js`**。
BASELINE_ADMIN=29   # admin 自己 src/ 里的错误总数
BASELINE_DEP=2      # 依赖自带 .ts 的错误（mdast-util-mark@1.0.0），admin 侧修不了 ⇒ 单独一桶

# 分类基线（🔴 必须分类计数：否则"某一类涨了、另一类降了"会被总数掩盖）
#   实测分布：TS2322 14 / TS2339 7 / TS2769 3 / TS2345 2 / TS18048 2 / TS2538 1 = 29
BASE_TS2322=14   # 类型不可赋值（多是 antd 4 的 props 形状 vs 实际传值）
BASE_TS2339=7    # 属性不存在
BASE_TS2769=3    # 没有匹配的重载
BASE_TS2345=2    # 实参类型不匹配（admin src 内的；依赖那 2 条另算）
BASE_TS18048=2   # 可能是 undefined
BASE_TS2538=1    # 类型不能用作索引

# 🔴 配置产物三类码：必须为 0（非 0 就说明配置或 .umi 生成物退化了）
CFG_ARTEFACT_RE='error (TS2305|TS2724|TS2307)'
# 配置/工程类错误（TS5xxx / TS6xxx）：出现它们说明**命令本身没跑对** ⇒ 计数不可信 ⇒ 硬失败
CFG_CODES_RE='error TS[56][0-9][0-9][0-9]'

# 「仍在编译范围内」的热点文件：钉的是**编译范围**而不是错误数，
# 所以把它们修干净不会打红本守卫，而把它们排除出编译（或改名/挪走）会。
# 🔴 前两个还兼作"配置生效"的正向判据：umiExports.ts 在清单里 ⇒ `@@/*` 别名解析成功；
#    typings.d.ts 在清单里 ⇒ 样式声明真的被编译。
HOT_FILES=(
  "src/.umi/core/umiExports.ts"
  "src/typings.d.ts"
  "src/components/SiteInfoForm/index.tsx"
  "src/pages/Code/index.tsx"
  "src/components/UpdateModal/index.tsx"
)
# 🔴 必须**不**在编译范围内的（纳进来会引入与源码无关的噪音）
MUST_ABSENT=(
  "src/.umi/.cache"
  "src/.umi-production"
)

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# ---------- 0) 前置：没有 tsc 就跳过（与 start-js.test.sh / strict-null-ratchet 同一约定） ----------
if [[ ! -x "${TSC}" ]]; then
  echo "NOTE: 没有 ${TSC}（admin 的 node_modules 未安装），跳过 admin 类型检查棘轮"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi
pass "tsc 可用（${TSC#"${ROOT}/"}，$("${TSC}" --version 2>&1 | head -1)）"

# ---------- 0b) 🔴 前置：src/.umi 必须存在，缺失就 fail-loud（绝不静默跳过） ----------
UMI_EXPORTS="${ADMIN}/src/.umi/core/umiExports.ts"
if [[ ! -f "${UMI_EXPORTS}" ]]; then
  fail "🔴 缺少 ${UMI_EXPORTS#"${ROOT}/"}（umi 的生成物）⇒ \`@@/*\` 别名无处可指，
      TS2305/TS2724 会全部回来，本守卫的计数毫无意义。
      修法：cd packages/admin && npm run postinstall   （即 umi g tmp）
      ⚠️ CI 的 \`pnpm install --frozen-lockfile\` 会自动跑 postinstall，所以 CI 上不该缺；
         本机缺通常是全新 clone 后没装依赖。"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 1
fi
pass "umi 生成物在位（src/.umi/core/umiExports.ts）"

# ---------- 1) 主测量：一次调用同时拿诊断与编译清单（--listFiles） ----------
# 🔴 **不要加 `--tsBuildInfoFile`**：`tsconfig.typecheck.json` 里 `composite: false` 且没有 `incremental`，
#    加上它会报 **TS5069**（Option tsBuildInfoFile cannot be specified without incremental/composite）
#    ⇒ **tsc 在做任何类型检查之前就中止**，错误数变成 0。
#    🔴 本守卫第一次实跑就是这样"假绿"的，是被下面第 2 节的 TS5xxx/TS6xxx 断言与第 3 节的
#    "计数为 0 就报红"**两条各自独立**抓住的 ⇒ 这两条防假绿断言都必须保留，不要"简化"掉。
#    ⚠️ 与 strict-null-ratchet 的区别：那份必须传全新的 tsBuildInfoFile，因为它用的
#    `tsconfig.build.json` 是 composite/增量；本配置不是增量 ⇒ 每次全量检查，没有陈旧缓存的风险。
# ⚠️ 必须 cd 进 packages/admin 再跑：`-p tsconfig.typecheck.json` 是**相对 cwd** 解析的。
# ⚠️ timeout 是必须的：挂住的话整个 CI job 会卡到超时而不是报红。
MAIN_OUT="${WORK}/main.txt"
( cd "${ADMIN}" && timeout "${TIMEOUT_S}" "${TSC}" -p "${TSCONFIG}" --noEmit --listFiles ) >"${MAIN_OUT}" 2>&1
MAIN_RC=$?

if [[ "${MAIN_RC}" == "124" ]]; then
  fail "tsc 超时（>${TIMEOUT_S}s）—— 不是「没有错误」，是**没跑完**"
elif [[ "${MAIN_RC}" != "0" && "${MAIN_RC}" != "1" && "${MAIN_RC}" != "2" ]]; then
  # 0=无错，1/2=有诊断（tsc 对"有错误"的正常退出码）。别的（126/127/信号…）都是调用本身坏了。
  fail "tsc 异常退出（rc=${MAIN_RC}）⇒ 计数不可信；输出前 3 行：$(head -3 "${MAIN_OUT}" | tr '\n' '|')"
else
  pass "tsc 正常跑完（rc=${MAIN_RC}；0/1/2 都是「有诊断」的正常形状）"
fi

count_admin() { grep -acE '^src/.*error TS[0-9]+' "$1" 2>/dev/null || true; }
count_dep()   { grep -acE '^\.\./.*error TS[0-9]+' "$1" 2>/dev/null || true; }
count_admin_code() { grep -acE "^src/.*error $2" "$1" 2>/dev/null || true; }
count_cfg()   { grep -acE "${CFG_CODES_RE}" "$1" 2>/dev/null || true; }
count_artefact() { grep -acE "${CFG_ARTEFACT_RE}" "$1" 2>/dev/null || true; }

# ---------- 2) 🔴 防假绿（一）：绝不能有配置/工程类错误 ----------
CFG_N="$(count_cfg "${MAIN_OUT}")"; CFG_N="${CFG_N:-0}"
if [[ "${CFG_N}" == "0" ]]; then
  pass "输出里没有 TS5xxx/TS6xxx 配置类错误（⇒ 计数是真量出来的，不是命令没跑对）"
else
  fail "输出里有 ${CFG_N} 条 TS5xxx/TS6xxx 配置类错误 ⇒ 命令没跑对，计数不可信：$(grep -aE "${CFG_CODES_RE}" "${MAIN_OUT}" | head -3 | tr '\n' '|')"
fi

# ---------- 2b) 🔴 防假绿（二）：输出必须非空、且编译清单足够大 ----------
LIST_N="$(grep -acE '^/' "${MAIN_OUT}" 2>/dev/null || true)"; LIST_N="${LIST_N:-0}"
if [[ "${LIST_N}" -gt 1000 ]]; then
  pass "--listFiles 清单足够大（${LIST_N} 个绝对路径 ⇒ tsc 真的编译了整个工程）"
else
  fail "--listFiles 清单只有 ${LIST_N} 行 ⇒ tsc 可能没真的编译（空输出会让计数假性为 0）"
fi

SRC_N="$(grep -acE '^/.*packages/admin/src/.*\.tsx?$' "${MAIN_OUT}" 2>/dev/null || true)"; SRC_N="${SRC_N:-0}"
if [[ "${SRC_N}" -ge 100 ]]; then
  pass "编译范围覆盖 admin 的 ${SRC_N} 个 .ts/.tsx（allowJs:false ⇒ 不含 .jsx/.js，这是已知口径）"
else
  fail "编译范围只有 ${SRC_N} 个 admin .ts/.tsx（期望 ≥100）⇒ include/exclude 可能被改坏了"
fi

# ---------- 2c) 🔴 防假绿（三）：热点文件必须都在编译范围内 ----------
for hf in "${HOT_FILES[@]}"; do
  if grep -aqF "/packages/admin/${hf}" "${MAIN_OUT}"; then
    pass "编译范围含 ${hf}"
  else
    fail "🔴 编译范围**不含** ${hf} ⇒ 它被排除出类型检查了（改名/挪走/include 变窄都会这样），
      而错误数可能因此**变少**⇒ 棘轮会假绿。请核实是有意为之还是配置退化。"
  fi
done
for ma in "${MUST_ABSENT[@]}"; do
  if grep -aqF "/packages/admin/${ma}" "${MAIN_OUT}"; then
    fail "🔴 编译范围**含** ${ma} ⇒ 生成物/构建缓存被纳进来了，会引入与源码无关的报错噪音"
  else
    pass "编译范围不含 ${ma}（生成缓存已正确排除）"
  fi
done

# ---------- 2d) 🔴 防假绿（四）：配置产物三类码必须为 0 ----------
ART_N="$(count_artefact "${MAIN_OUT}")"; ART_N="${ART_N:-0}"
if [[ "${ART_N}" == "0" ]]; then
  pass "TS2305/TS2724/TS2307 = 0（⇒ \`@@/*\` 别名与样式声明都生效，umi 的插件导出解析得到）"
else
  fail "🔴 TS2305/TS2724/TS2307 出现了 ${ART_N} 条 ⇒ 配置退化了（最可能：tsconfig.typecheck.json 的
      \`@@/*\` 别名被删、src/typings.d.ts 被删、或 src/.umi 未生成）。这些**不是真错**，
      它们会淹没真实信号（历史上这一族单独就贡献过 19 条）。前 5 条：
      $(grep -aE "${CFG_ARTEFACT_RE}" "${MAIN_OUT}" | head -5 | tr '\n' '|')"
fi

# ---------- 3) 棘轮本体 ----------
ADMIN_N="$(count_admin "${MAIN_OUT}")"; ADMIN_N="${ADMIN_N:-0}"
DEP_N="$(count_dep "${MAIN_OUT}")"; DEP_N="${DEP_N:-0}"
TOTAL_N=$((ADMIN_N + DEP_N))

echo "  · admin src 错误 = ${ADMIN_N}（基线 ${BASELINE_ADMIN}）；依赖自带 = ${DEP_N}（基线 ${BASELINE_DEP}）；合计 ${TOTAL_N}"

if [[ "${ADMIN_N}" -eq 0 ]]; then
  # 🔴 尺子有效性：0 有两种可能 —— ①真的全修好了 ②测量坏了。
  #    与 strict-null-ratchet 同一取舍：0 是**歧义**信号，报红逼一次有意识的处理
  #    （把 BASELINE_ADMIN 改成 0 并在提交信息里说明，或者发现是测量坏了）。
  fail "admin src 错误数 = 0：要么真的全修好了（那就把 BASELINE_ADMIN 改成 0 并在提交信息里说明），
      要么测量坏了（先看上面几条防假绿断言）。静默通过等于让守卫悄悄失效。"
elif [[ "${ADMIN_N}" -gt "${BASELINE_ADMIN}" ]]; then
  fail "🔴 棘轮被打破：admin src 的类型错误从 ${BASELINE_ADMIN} 增到 ${ADMIN_N}（新增 $((ADMIN_N - BASELINE_ADMIN)) 处）。按文件分布："
  grep -aE '^src/.*error TS[0-9]+' "${MAIN_OUT}" | sed 's/(.*//' | sort | uniq -c | sort -rn | head -8 | sed 's/^/      /'
  echo "      🔴 正在做多语言改造时尤其要注意：把中文标签换成 t(...) 调用最容易引入 TS2322/TS2345"
  echo "      （props 形状变了、或把 ReactNode 传给了只接受 string 的位置）。"
elif [[ "${ADMIN_N}" -lt "${BASELINE_ADMIN}" ]]; then
  pass "棘轮守住了：admin src 错误 ${ADMIN_N} < 基线 ${BASELINE_ADMIN}（🔴 请把 BASELINE_ADMIN 下调到 ${ADMIN_N}，并在提交信息里写清清了哪几处）"
else
  pass "棘轮守住了：admin src 错误 ${ADMIN_N} == 基线 ${BASELINE_ADMIN}"
fi

if [[ "${DEP_N}" -gt "${BASELINE_DEP}" ]]; then
  fail "依赖自带的类型错误从 ${BASELINE_DEP} 增到 ${DEP_N} ⇒ 大概率是某个依赖升级带来的（admin 侧修不了，但要知情）："
  grep -aE '^\.\./.*error TS[0-9]+' "${MAIN_OUT}" | head -5 | sed 's/^/      /'
else
  pass "依赖自带的类型错误 ${DEP_N} ≤ 基线 ${BASELINE_DEP}（当前是 mdast-util-mark 自己的 .ts，admin 侧不可修）"
fi

# ---------- 4) 分类计数（🔴 防止"某一类涨了、另一类降了"被总数掩盖） ----------
check_code() { # $1=码  $2=基线  $3=说明
  local n; n="$(count_admin_code "${MAIN_OUT}" "$1")"; n="${n:-0}"
  if [[ "${n}" -gt "$2" ]]; then
    fail "🔴 ${1} 从 $2 增到 ${n}（${3}）—— 总数没变也要报，因为它是**另一类**问题变多了"
    grep -aE "^src/.*error ${1}" "${MAIN_OUT}" | head -4 | sed 's/^/      /'
  else
    pass "${1} = ${n} ≤ 基线 $2（${3}）"
  fi
}
check_code TS2322 "${BASE_TS2322}" "类型不可赋值"
check_code TS2339 "${BASE_TS2339}" "属性不存在"
check_code TS2769 "${BASE_TS2769}" "没有匹配的重载"
check_code TS2345 "${BASE_TS2345}" "实参类型不匹配"
check_code TS18048 "${BASE_TS18048}" "可能是 undefined"
check_code TS2538 "${BASE_TS2538}" "类型不能用作索引"

# ---------- 5) 分类之和必须等于总数（防"分类漏了一类"造成的假绿） ----------
SUM_CODES=0
for c in TS2322 TS2339 TS2769 TS2345 TS18048 TS2538; do
  n="$(count_admin_code "${MAIN_OUT}" "$c")"; n="${n:-0}"; SUM_CODES=$((SUM_CODES + n))
done
assert_eq "${SUM_CODES}" "${ADMIN_N}" "六类之和 == admin src 总数（⇒ 没有未登记的错误码被漏掉）"
if [[ "${SUM_CODES}" != "${ADMIN_N}" ]]; then
  echo "      🔴 出现了未登记的错误码，请把它加进上面的分类基线（不要靠总数掩盖）："
  grep -aE '^src/.*error TS[0-9]+' "${MAIN_OUT}" | grep -avE 'TS2322|TS2339|TS2769|TS2345|TS18048|TS2538' | head -5 | sed 's/^/        /'
fi

echo
echo "passed=${PASS} failed=${FAIL}"
[[ "${FAIL}" -eq 0 ]]
