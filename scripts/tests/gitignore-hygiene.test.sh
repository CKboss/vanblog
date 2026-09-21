#!/usr/bin/env bash
# gitignore 卫生守卫：防止"一个源码目录被 gitignore 静默吞掉 ⇒ 新文件永远进不了仓库"。
#
# ## 为什么需要它（真实事故，2026-09-21）
# `.gitignore` 里曾有一条**裸 `log`**（本意是仓库根的日志输出目录）。而
# 🔴 **没有前导 `/` 的 gitignore 模式会在任意层级匹配** ⇒ 它把**两个源码目录**整个吞掉了：
#   - `packages/server/src/provider/log/`（5 个文件）
#   - `packages/server/src/controller/admin/log/`（2 个文件）
# 目录里**已跟踪**的文件因为"gitignore 不会取消跟踪"而照常存在 ⇒ 目录看起来健康、`git status` 干净、
# 每个既有文件都在仓库里，**但那个目录里任何新增文件都会被静默忽略**：不出现在 `git status`、
# 不会被提交、任何只读已提交代码的审查都看不见它。
# 实际受害者：`provider/log/log.provider.tail.spec.ts`（9 条用例、mtime 2026-09-16）
# **在每次全量 jest 里跑了 5 天却从未入库** ⇒ "跟踪的套件数 + 新增 = 267 而 `jest --listTests` 报 268"
# 这个差 1 永远对不上。已修（规则锚定成 `/log`、`/log/**`）。
#
# ## 🔴 尺子口径（实测过，别改成"对目录跑 check-ignore"）
# 直觉做法是对每个祖先目录跑 `git check-ignore -q <dir>/`。**实测那样抓不到**：
# 在事故形状下（裸 `log`），
#   - `git check-ignore -v packages/server/src/provider/log/`   → rc=1（**不报**）
#   - `git check-ignore -v packages/server/src/provider/log`    → rc=1（**不报**）
#   - `git check-ignore -v <该目录下一个假想新文件>`             → rc=0（报）
#   - `git check-ignore -v --no-index <该目录下的已跟踪文件>`    → rc=0（报）
# ⇒ **目录本身不会被 check-ignore 报出来**，必须问"这个路径**假如没被跟踪**会不会被忽略"。
# 本守卫用 `--no-index`：它对**已跟踪**文件也给出"若无索引则会被哪条规则忽略"的答案，
# 正好就是"这个目录里的新文件会不会消失"。批量走 `--stdin`，1451 个文件实测 **17ms**。
#
# ⚠️ 一个必须过滤的假阳性：`git check-ignore -v` 会把**否定规则**（`!pattern`）也报出来
# （例如 `packages/server/.gitignore:31:!.vscode/settings.json`）。否定规则意味着"显式取消忽略"，
# **不是**危险 ⇒ 过滤掉 `:!*` 形状的行。实测：不过滤时有 1 条假阳性，过滤后事故形状报 8 条、修复后报 0 条。
#
# ## 第二部分：测试文件对账
# 光有"目录没被忽略"还不够 —— 本次事故的**症状**是"一个测试在跑但没入库"。所以直接对账：
# 每个测试目录下**磁盘上的文件数**必须等于**已跟踪的文件数**，不等就列出未跟踪的那些。
# 这一部分只需要 git + find，因此本守卫整体可以放进 CI 的 `guards-core`（无需 node_modules）；
# 唯一需要依赖的是"用 runner 自己的清单再对一次账"（`jest --listTests`），缺依赖时 NOTE 跳过。
# ⚠️ website 侧**不能**用 `vitest list`：本机 vitest 是 **0.29.2**，`list` 子命令不存在，
#    实测会**挂住**（被 SIGTERM 才停）⇒ 放进 CI 会把 job 拖到超时。所以 website 只用 find 对账。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}" || { echo "无法进入仓库根 ${ROOT}"; exit 2; }

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
note() { echo "NOTE: $*"; }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }

WORK="$(mktemp -d)"
# 🔴 临时文件只放 mktemp -d / /tmp，**绝不放进仓库**：本仓库有过一次事故 ——
#    一个探针被 `cp` 进 `packages/server/src/`，随后那条命令被 600 秒上限 SIGTERM 打断、
#    末尾的 `rm -f` 没执行，探针就成了未跟踪的仓库文件（而 `git add -A` 会把它带进去）。
trap 'rm -rf "${WORK}"' EXIT

# ⚠️ `grep -c` 在无匹配时**退出码 1**，会打断 `&&` 链（本仓库踩过多次，其中一次差点让一个
#    违规提交成功）；而 `v="$(grep -c … || echo 0)"` 在无匹配时会得到 "0\n0" 并**让算术崩掉**。
#    ⇒ 统一用这个 helper：先 `|| true` 兜退出码，再校验结果是纯数字。
count_of() { # $1=文件  $2=扩展正则
  local n
  n="$(grep -acE "$2" "$1" 2>/dev/null || true)"
  if [[ ! "${n}" =~ ^[0-9]+$ ]]; then n=0; fi
  printf '%s' "${n}"
}

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  note "当前目录不是 git 仓库，跳过 gitignore 卫生守卫"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

# ---------- 1) 反空转：仓库必须真的有内容 ----------
# 没有这条，"没有任何目录被忽略"在一个空仓上恒真（0 个文件 ⇒ 0 个命中 ⇒ pass）。
TRACKED_ALL="${WORK}/tracked.txt"
git ls-files >"${TRACKED_ALL}" 2>/dev/null
TRACKED_N="$(wc -l <"${TRACKED_ALL}" | tr -d ' ')"
if [[ "${TRACKED_N}" -gt 1000 ]]; then
  pass "反空转：仓库有 ${TRACKED_N} 个已跟踪文件（>1000，所以后面的 0 命中是有意义的）"
else
  fail "仓库只有 ${TRACKED_N} 个已跟踪文件（期望 >1000）⇒ git ls-files 可能没跑对，后面的断言会假绿"
fi

# ---------- 2) 核心：任何已跟踪文件所在的目录，都不该忽略"新来的同级文件" ----------
# 口径见文件头：用 --no-index 批量问"假如没被跟踪会不会被忽略"，并过滤掉否定规则（!pattern）。
RAW="${WORK}/check-ignore-raw.txt"
git check-ignore --no-index --stdin -v <"${TRACKED_ALL}" >"${RAW}" 2>/dev/null
# ⚠️ git check-ignore 在"有命中"时退出码 0、"无命中"时 1 —— 两者都不是错误，别用 set -e 思维判断。
RAW_N="$(wc -l <"${RAW}" | tr -d ' ')"

HAZ="${WORK}/hazards.txt"
# 否定规则的形状是 `<file>:<line>:!<pattern>`；只保留**非**否定规则的命中。
awk -F'\t' '$1 !~ /^[^:]*:[0-9]+:!/' "${RAW}" >"${HAZ}" 2>/dev/null
HAZ_N="$(wc -l <"${HAZ}" | tr -d ' ')"
NEG_N=$(( RAW_N - HAZ_N ))

echo "  · check-ignore 原始命中 ${RAW_N} 条（其中否定规则 ${NEG_N} 条已过滤），真实隐患 ${HAZ_N} 条"

if [[ "${HAZ_N}" -eq 0 ]]; then
  pass "没有任何已跟踪文件位于「会被 gitignore 吞掉新文件」的目录里"
else
  fail "🔴 有 ${HAZ_N} 个已跟踪文件位于被 gitignore 匹配的目录里 ⇒ 那些目录里**新增的文件会被静默忽略**（不会出现在 git status、不会被提交）："
  # 按"目录 + 命中的规则"聚合，便于直接看出该改哪条规则
  awk -F'\t' '{ n=split($2, parts, "/"); sub("/" parts[n] "$", "", $2); print $1 "\t" $2 }' "${HAZ}" \
    | sort | uniq -c | sort -rn | head -12 | sed 's/^/      /'
  echo "      修法：把那条规则**锚定到仓库根**（例如 \`log\` → \`/log\`、\`log/**\` → \`/log/**\`），"
  echo "            或者给它加一条否定规则；改完用 \`git check-ignore -v <路径>\` 复核。"
  echo "      ⚠️ 注意：已跟踪的文件不会因此消失，所以这个缺陷**看起来一切正常**，只在新建文件时才发作。"
fi

# 尺子有效性（一）：否定规则确实被识别出来了 —— 否则"过滤否定规则"这段可能是死代码，
# 而它一旦失效就会把 `.vscode/settings.json` 这类**显式取消忽略**的路径误报成隐患。
if [[ "${NEG_N}" -gt 0 ]]; then
  pass "否定规则过滤是活的（本次过滤掉 ${NEG_N} 条 \`!pattern\` 命中，它们是「显式取消忽略」不是隐患）"
else
  note "本次没有出现否定规则命中 —— 过滤逻辑未被这条断言覆盖（不代表它坏了；仓库当前可能没有 !pattern 生效在已跟踪文件上）"
fi

# ---------- 3) 🔴 尺子有效性（二）：合成一个"事故形状"，证明这把尺子真的会红 ----------
# 没有这条，第 2 节的 0 命中可能只是"尺子量不到东西"。做法：在 WORK 里造一个**独立的迷你仓库**，
# 用裸模式忽略一个含已跟踪文件的目录，然后跑同一段 awk 逻辑。
# ⚠️ 刻意**不改本仓库的 .gitignore** —— 改真仓库的 .gitignore 来测守卫，一旦中途被打断就会留下
#    一个"忽略了源码目录"的危险状态（这正是本守卫要防的事故本身）。
MINI="${WORK}/mini"
mkdir -p "${MINI}/src/provider/log"
(
  cd "${MINI}" || exit 1
  git init -q . >/dev/null 2>&1
  git config user.email guard@local >/dev/null 2>&1
  git config user.name guard >/dev/null 2>&1
  printf 'node_modules/\nlog\nlog/**\n' >.gitignore
  echo "export const a = 1;" >src/provider/log/log.provider.ts
  # 🔴 必须用 `git add -f`：实测在"裸 log"这个事故形状下，`git add -A` 会**静默跳过**
  #    `src/provider/log/log.provider.ts`（因为它被忽略了）⇒ 迷你仓库里只剩 .gitignore 一个文件，
  #    于是"已跟踪文件位于被忽略目录"这个形状根本造不出来（本守卫第一版就因此假红）。
  #    ⚠️ 这本身就是事故之所以隐形的原因之一：**连 `git add` 都不会把它加进来，而且不报错**。
  #    真仓库里那 7 个文件是"规则写下之前就已跟踪"才留在库里的。
  git add -A >/dev/null 2>&1
  git add -f src/provider/log/log.provider.ts >/dev/null 2>&1
  git commit -qm init >/dev/null 2>&1
)
if [[ -f "${MINI}/src/provider/log/log.provider.ts" ]]; then
  MINI_RAW="${WORK}/mini-raw.txt"
  ( cd "${MINI}" && git ls-files | git check-ignore --no-index --stdin -v ) >"${MINI_RAW}" 2>/dev/null
  MINI_HAZ="$(awk -F'\t' '$1 !~ /^[^:]*:[0-9]+:!/' "${MINI_RAW}" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${MINI_HAZ}" -gt 0 ]]; then
    pass "尺子有效性：在合成的「裸 log 规则」事故形状下，同一套判定报出 ${MINI_HAZ} 条隐患（⇒ 第 2 节的 0 命中是真 0）"
  else
    fail "🔴 尺子失效：合成的事故形状（裸 \`log\` + 已跟踪的 src/provider/log/log.provider.ts）**没有**被报出来 ⇒ 第 2 节的 0 命中不可信"
  fi
  # 反证：把规则锚定到根之后，同一个迷你仓库应当 0 命中（证明"锚定"确实是修法，而不是碰巧)
  printf 'node_modules/\n/log\n/log/**\n' >"${MINI}/.gitignore"
  MINI_RAW2="${WORK}/mini-raw2.txt"
  ( cd "${MINI}" && git ls-files | git check-ignore --no-index --stdin -v ) >"${MINI_RAW2}" 2>/dev/null
  MINI_HAZ2="$(awk -F'\t' '$1 !~ /^[^:]*:[0-9]+:!/' "${MINI_RAW2}" 2>/dev/null | wc -l | tr -d ' ')"
  assert_eq "${MINI_HAZ2}" "0" "尺子有效性（反向）：同一迷你仓库把规则锚定成 /log 后，隐患归 0（⇒ 锚定确实是修法）"
else
  fail "合成迷你仓库没建起来（${MINI}/src/provider/log/log.provider.ts 不存在）⇒ 尺子有效性未被验证"
fi

# ---------- 4) 测试文件对账：磁盘上的测试文件必须全部已跟踪 ----------
# 这一节直接抓本次事故的**症状**："一个测试在跑，但不在仓库里"。
# 口径：对每个测试目录，比较「find 到的文件数」与「git ls-files 到的文件数」，不等就列出差集。
# ---------- 4) 测试文件对账：磁盘上的测试文件必须全部已跟踪 ----------
# 这一节直接抓本次事故的**症状**："一个测试在跑，但不在仓库里"。
#
# 🔴 **判据是"被忽略" vs "可见的未跟踪"，不是"工作树脏不脏"** —— 这条是实测出来的，别改回直觉做法。
# 直觉做法（"工作树脏 ⇒ 降级成 NOTE"）有一个洞：真事故发生时**工作树是干净的**，因为那个孤儿 spec
# 位于被忽略的目录里 ⇒ `git status` **根本不显示它**（实测：迷你仓库里 `git status --porcelain` 输出为空，
# 加 `--ignored` 才看得见 `!! src/provider/log/orphan.spec.ts`）。于是"脏树豁免"在开发者**正好也在改别的
# 东西**时（这几乎是常态）会把事故一起豁免掉。
# ⇒ 正确的分法：
#   - **被 gitignore 忽略的测试文件** ⇒ 开发者**永远**在 `git status` 里看不到它、`git add` 也会静默跳过它
#     ⇒ 这就是事故本身 ⇒ **无条件硬失败**（与工作树脏不脏无关）。
#   - **可见的未跟踪测试文件**（`git status` 里是 `??`）⇒ 开发者看得见 ⇒ 正常的开发中间态
#     ⇒ **只 NOTE 不失败**。⚠️ 否则任何代理新建一个 spec 还没提交时本守卫就红，
#        而"CI 常红训练出的是忽略红"—— 本仓库已为此吃过亏。
# ⚠️ 由此推论，也如实说明本节的**作用域**：CI 的工作树是 checkout 出来的、不含未跟踪文件，
#    所以本节在 CI 里几乎总是绿的；它的价值在**本地/提交前**——也就是那个孤儿 spec 真实存活了 5 天的地方。
#    在 CI 里对"新增了一条会吞源码目录的规则"负责的是第 2 节。两者分工不同，不要合并。
reconcile() { # $1=名称  $2=find 的根路径  $3=find 的 -name 模式  $4=git ls-files 的 pathspec
  local label="$1" root="$2" pattern="$3" spec="$4"
  local disk_f tracked_f disk_n tracked_n
  local slug; slug="$(echo "${label}" | tr ' /' '__')"
  disk_f="${WORK}/disk-${slug}.txt"
  tracked_f="${WORK}/trk-${slug}.txt"
  if [[ ! -d "${root}" ]]; then
    note "${label}: 目录 ${root} 不存在，跳过"
    return
  fi
  find "${root}" -type f -name "${pattern}" \
    -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.next/*' \
    -not -path '*/.umi/*' -not -path '*/.umi-production/*' -not -path '*/coverage/*' \
    2>/dev/null | sed "s#^${ROOT}/##" | sort >"${disk_f}"
  git ls-files -- "${spec}" 2>/dev/null | sort >"${tracked_f}"
  disk_n="$(wc -l <"${disk_f}" | tr -d ' ')"
  tracked_n="$(wc -l <"${tracked_f}" | tr -d ' ')"
  if [[ "${disk_n}" -eq 0 ]]; then
    fail "${label}: 磁盘上找到 0 个测试文件 ⇒ find 的根路径或模式写错了（对账失去意义）"
    return
  fi

  local untracked_f missing_f
  untracked_f="${WORK}/untracked-${slug}.txt"
  missing_f="${WORK}/missing-${slug}.txt"
  comm -23 "${disk_f}" "${tracked_f}" >"${untracked_f}"
  comm -13 "${disk_f}" "${tracked_f}" >"${missing_f}"
  local un_n miss_n
  un_n="$(wc -l <"${untracked_f}" | tr -d ' ')"
  miss_n="$(wc -l <"${missing_f}" | tr -d ' ')"

  if [[ "${un_n}" -eq 0 && "${miss_n}" -eq 0 ]]; then
    pass "${label}: 磁盘 ${disk_n} 个 == 已跟踪 ${tracked_n} 个（没有「在跑但没入库」的测试）"
    return
  fi

  # 把"未跟踪"再分成「被忽略」与「可见」两类 —— 判据见本节开头
  local ign_f vis_f
  ign_f="${WORK}/ignored-${slug}.txt"
  vis_f="${WORK}/visible-${slug}.txt"
  : >"${ign_f}"; : >"${vis_f}"
  while IFS= read -r f; do
    [[ -n "${f}" ]] || continue
    if git check-ignore -q -- "${f}" 2>/dev/null; then
      printf '%s\n' "${f}" >>"${ign_f}"
    else
      printf '%s\n' "${f}" >>"${vis_f}"
    fi
  done <"${untracked_f}"
  local ign_n vis_n
  ign_n="$(wc -l <"${ign_f}" | tr -d ' ')"
  vis_n="$(wc -l <"${vis_f}" | tr -d ' ')"

  if [[ "${ign_n}" -gt 0 ]]; then
    fail "🔴 ${label}: 有 ${ign_n} 个测试文件在磁盘上、在跑，但被 gitignore **静默忽略** ⇒ git status 永远不显示、git add 会静默跳过（这就是那个存活了 5 天的孤儿 spec 的形状）："
    head -10 "${ign_f}" | sed 's/^/      !! /'
    echo "      查是哪条规则：git check-ignore -v <路径>；修法通常是把规则锚定到根（\`log\` → \`/log\`）。"
  fi
  if [[ "${vis_n}" -gt 0 ]]; then
    note "${label}: 有 ${vis_n} 个测试文件未跟踪但**可见**（git status 里是 ??）⇒ 视为开发中间态，不算失败。提交前请记得 git add："
    head -10 "${vis_f}" | sed 's/^/      ?? /'
  fi
  if [[ "${miss_n}" -gt 0 ]]; then
    note "${label}: 有 ${miss_n} 个已跟踪的测试文件在磁盘上不存在（删了还没提交？）："
    head -10 "${missing_f}" | sed 's/^/      已跟踪但缺失: /'
  fi
}

reconcile "server specs"   "${ROOT}/packages/server"            '*.spec.ts'  'packages/server/**/*.spec.ts'
reconcile "website specs"  "${ROOT}/packages/website"           '*.spec.ts'  'packages/website/**/*.spec.ts'
reconcile "admin tests"    "${ROOT}/packages/admin/tests/unit"   '*.test.js' 'packages/admin/tests/unit/*.test.js'
reconcile "script guards"  "${ROOT}/scripts/tests"               '*.test.sh' 'scripts/tests/*.test.sh'

# ---------- 5) 用 runner 自己的清单再对一次账（需要 node_modules，缺则 NOTE 跳过） ----------
# 为什么要这一层：第 4 节用的是**我的** glob，如果 runner 的 testMatch 比我的 glob 宽
# （例如还收 `test/` 目录、或 `.test.ts`），第 4 节就会漏掉。用 runner 的清单能抓到这种偏差。
JEST="${ROOT}/packages/server/node_modules/.bin/jest"
if [[ -x "${JEST}" ]]; then
  JL="${WORK}/jest-list.txt"
  ( cd "${ROOT}/packages/server" && timeout 180 "${JEST}" --listTests ) >"${JL}" 2>/dev/null
  JEST_N="$(wc -l <"${JL}" | tr -d ' ')"
  if [[ "${JEST_N}" -gt 0 ]]; then
    # 逐个核实：runner 要跑的每个文件都必须已跟踪（这条比"数量相等"更强，能抓住"多一个+少一个"的抵消）。
    # 🔴 判据与第 4 节**必须一致**（被忽略 ⇒ 硬失败；仅可见未跟踪 ⇒ NOTE）。
    #    第一版这里无条件 fail，结果一个"新建但还没提交"的 server spec 就会让本守卫红 2 条
    #    （数量对账 + 逐个对账）⇒ 正是"CI 常红训练出忽略红"的形状，已按同一判据修掉。
    sed "s#^${ROOT}/##" "${JL}" | sort >"${WORK}/jest-rel.txt"
    git ls-files -- 'packages/server/**/*.spec.ts' | sort >"${WORK}/server-trk.txt"
    UNTRACKED_RUN="${WORK}/untracked-run.txt"
    comm -23 "${WORK}/jest-rel.txt" "${WORK}/server-trk.txt" >"${UNTRACKED_RUN}"
    RUN_IGN="${WORK}/run-ignored.txt"; RUN_VIS="${WORK}/run-visible.txt"
    : >"${RUN_IGN}"; : >"${RUN_VIS}"
    while IFS= read -r f; do
      [[ -n "${f}" ]] || continue
      if git check-ignore -q -- "${f}" 2>/dev/null; then
        printf '%s\n' "${f}" >>"${RUN_IGN}"
      else
        printf '%s\n' "${f}" >>"${RUN_VIS}"
      fi
    done <"${UNTRACKED_RUN}"
    RUN_IGN_N="$(wc -l <"${RUN_IGN}" | tr -d ' ')"
    RUN_VIS_N="$(wc -l <"${RUN_VIS}" | tr -d ' ')"
    if [[ "${RUN_IGN_N}" -gt 0 ]]; then
      fail "🔴 jest 会跑、但被 gitignore **静默忽略**（永远不会被提交）的文件有 ${RUN_IGN_N} 个："
      head -10 "${RUN_IGN}" | sed 's/^/      !! /'
    elif [[ "${RUN_VIS_N}" -gt 0 ]]; then
      note "jest 会跑、且未跟踪但**可见**（?? 开发中间态）的文件有 ${RUN_VIS_N} 个 ⇒ 不算失败，提交前记得 git add："
      head -10 "${RUN_VIS}" | sed 's/^/      ?? /'
    else
      pass "jest 将要跑的每个文件都已跟踪（不是只比数量，是逐个比路径）"
    fi
    # 数量对账只在"没有被忽略的文件"时才有意义（可见的 WIP 文件会让数量临时不等）
    SERVER_TRACKED="$(git ls-files -- 'packages/server/**/*.spec.ts' | wc -l | tr -d ' ')"
    if [[ "${RUN_IGN_N}" -eq 0 && "${RUN_VIS_N}" -eq 0 ]]; then
      assert_eq "${JEST_N}" "${SERVER_TRACKED}" "jest --listTests（${JEST_N}）== 已跟踪的 server spec 数（${SERVER_TRACKED}）"
    else
      note "跳过 jest 数量对账（有 ${RUN_IGN_N} 个被忽略 + ${RUN_VIS_N} 个可见未跟踪的 spec，数量本来就会不等）"
    fi
  else
    note "jest --listTests 没有输出（可能没装依赖或 testMatch 为空），跳过 runner 对账"
  fi
else
  note "没有 ${JEST#"${ROOT}/"}（node_modules 未安装），跳过 runner 对账 —— 第 4 节的 find/ls-files 对账仍然有效"
fi

# ---------- 6) 其余裸模式的现状盘点（只报告，不改） ----------
#
# ## 2026-09-21 的逐个评估结论（🔴 结论是**不要批量锚定**，理由如下）
# 实测：全部 .gitignore 里共有 **55** 条"无前导 / 、非否定、不含 *"的裸模式，其中约 **50** 条
# 会在任意层级匹配（用 `git check-ignore -q packages/server/src/__probe__/<pat>/x.ts` 逐条探测）。
# 但**修复 log 之后，没有任何一条当前正覆盖着已跟踪的源码目录**（tracked-under 全为 0）。
# ⇒ 所以"批量锚定"没有现实收益，却有明确风险：
#
# 🔴 **必须保持宽匹配（锚定会造成真实损害）的那几条**：
#   - `config.yaml`：**最高风险**。`packages/server/config.yaml` 是本机真实配置（含数据库 URL、
#     静态目录、日志路径），**正因为它在任意层级被忽略才没有被提交**。锚定成 `/config.yaml`
#     会让它立刻出现在 `git status` 里 ⇒ 一次 `git add -A` 就把本机配置（可能含凭据）提交上去。
#   - `.env` / `.env.test` / `.env.*`：同理，**密钥必须能在任意层级被忽略**。
#   - `node_modules` / `dist` / `build` / `coverage` / `.next` / `.umi` / `.umi-production` /
#     `logs` / `pids` / `.cache` / `.eslintcache` / `.nyc_output` / `lib-cov` / `temp.json` /
#     `staticFolder` / `localBuild.sh`：这些是**每个包各自**的构建/工具产物，本来就出现在多个层级
#     （`packages/server/dist`、`packages/website/.next`、`packages/admin/.umi`…）⇒ 锚定到根
#     会让它们**全部变成未忽略**，一次误提交就是几十万个生成文件。
#   - `.DS_Store` / `.idea` / `.history` / `.settings` / `.project` / `.classpath`：编辑器与系统噪音，
#     宽匹配是正确意图。
# ⚠️ **值得留意但目前无受害者的一条**：`typings` —— 按惯例 `typings/` 常是**手写源码**（.d.ts），
#   将来若有人新建 `packages/*/src/typings/`，它会静默消失。当前 tracked-under=0，所以不改，
#   但**第 2 节的核心断言会在它发生的那天自动报红**（这正是把守卫做成常驻而不是做一次清理的理由）。
# 📌 **根因备注**：这份 .gitignore 大体是 **Node.js 官方模板整份搬来的**（bower_components /
#   jspm_packages / .fusebox / .rts2_cache_* / _roadhog-api-doc / .serverless / .dynamodb / .c9 /
#   .grunt 等都不是本项目会产生的东西），`log` 那条也是模板带来的 ⇒ 它从来没有被逐条审过。
#   👉 结论：**与其批量重写，不如让第 2 节的断言常驻**——它把"某条规则开始吞源码目录"这件事
#   变成 CI 红灯，而不依赖有人记得去审 55 条模板规则。
# ⚠️ 这一节**不断言**、只打印，因为它记录的是"还有哪些规则在任意层级匹配"这一事实，
#    供人判断要不要锚定。断言它们会锁死一个产品决定（有些宽匹配是有意的，例如 node_modules）。
echo "  · 其余「无前导 / 」的裸模式（会在任意层级匹配）及其对已跟踪文件的影响："
GITIGNORES="$(git ls-files | grep -E '(^|/)\.gitignore$' || true)"
BARE_REPORT="${WORK}/bare.txt"
: >"${BARE_REPORT}"
for gi in .gitignore ${GITIGNORES}; do
  [[ -f "${ROOT}/${gi}" ]] || continue
  # 取出「非注释、非空、无前导 / 、无 ! 、不含 * 的裸名字」规则
  sed -e 's/[[:space:]]*#.*$//' "${ROOT}/${gi}" 2>/dev/null \
    | grep -vE '^[[:space:]]*$' \
    | grep -vE '^[!/]' \
    | grep -vE '\*' \
    | sed 's#/$##' \
    | while IFS= read -r pat; do
        [[ -n "${pat}" ]] || continue
        # 这条裸模式当前覆盖了多少个**已跟踪**文件（即"有多少源码正住在一个被它匹配的目录下"）？
        n="$(git ls-files | grep -cE "(^|/)${pat}/" 2>/dev/null || true)"
        [[ "${n}" =~ ^[0-9]+$ ]] || n=0
        if [[ "${n}" -gt 0 ]]; then
          printf '%s\t%s\t%s\n' "${gi}" "${pat}" "${n}" >>"${BARE_REPORT}"
        fi
      done
done
if [[ -s "${BARE_REPORT}" ]]; then
  echo "      ⚠️ 下列裸模式当前正覆盖着已跟踪的源码目录（新文件会消失，与 log 事故同形）："
  sort -u "${BARE_REPORT}" | head -10 | awk -F'\t' '{ printf "      %s 里的裸模式 `%s` → 覆盖 %s 个已跟踪文件\n", $1, $2, $3 }'
  note "上面这些是**待裁定**项，不是失败项：锚定它们可能让本该忽略的东西变成未忽略，需要逐条判断"
else
  echo "      （没有其它裸模式正覆盖已跟踪的源码目录）"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
