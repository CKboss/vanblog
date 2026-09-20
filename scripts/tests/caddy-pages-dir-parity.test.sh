#!/usr/bin/env bash
# `VANBLOG_CADDY_HTML_PAGES_DIR` 的**跨语言一致性**守卫（shell 侧）。
#
# 背景：这个变量同时决定 caddy 侧的 `vars.root`（生成器 `scripts/caddyConfig.js` 写入）
# 与服务端侧的哨兵目录 + 产物清理目录（`caddy.provider.ts` / `degradedServeHtml.ts` /
# `artifactReaper.ts`）。修复前生成器校验、服务端不校验 ⇒ 给一个非法值时两侧得出**不同目录**：
# 哨兵写 A、file_server 读 B、reaper 删 C，直服静默失效（而 reaper 是删除操作，非法值有破坏性）。
#
# 两侧规则无法共用代码（TS vs JS），所以：
#   - 取值表只有一份：`scripts/tests/fixtures/pages-dir-cases.json`
#   - 本脚本负责 **JS 侧的可观测后果**：对表里每个取值真跑一次生成器，断言
#     `vanblog-serve-html` 子树里的 `vars.root` 与 stderr 的 WARN 形状；
#   - `packages/server/src/provider/caddy/pagesDirParity.spec.ts` 负责**真跑两侧比对结论**
#     （它从生成器原文里按花括号配平切出真函数，不是复制品）。
#   两者共用同一份表 ⇒ 加一个取值只改一处。
#
# ⚠️ 本脚本**不依赖 node_modules**（只需要 node），所以能进 CI 的 guards-core 档。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="${ROOT}/scripts/caddyConfig.js"
TEMPLATE="${ROOT}/caddyTemplate.json"
CASES="${ROOT}/scripts/tests/fixtures/pages-dir-cases.json"
PARITY_SPEC="${ROOT}/packages/server/src/provider/caddy/pagesDirParity.spec.ts"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }

NODE_BIN=""
for cand in "${ROOT}/.tools/node20/bin/node" node; do
  if command -v "${cand}" >/dev/null 2>&1; then NODE_BIN="${cand}"; break; fi
done
if [[ -z "${NODE_BIN}" ]]; then
  echo "NOTE: 没有 node，跳过本守卫"
  echo
  echo "passed=${PASS} failed=${FAIL}"
  exit 0
fi

echo "== VANBLOG_CADDY_HTML_PAGES_DIR 跨语言一致性（shell 侧）=="

for f in "${HELPER}" "${TEMPLATE}" "${CASES}" "${PARITY_SPEC}"; do
  if [[ ! -f "${f}" ]]; then echo "FAIL: 缺少 ${f}"; echo; echo "passed=0 failed=1"; exit 1; fi
done
pass "生成器 / 模板 / 取值表 / jest 侧 parity spec 四个文件都在"

# --- 从生成结果里提取 serve-html 子树的 vars.root（与生成器同一套结构判据：按 group 名定位）---
EXTRACTOR="$(mktemp)"
cat > "${EXTRACTOR}" <<'JS'
let s = '';
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
  const roots = [];
  const walk = (n, inside) => {
    if (Array.isArray(n)) return n.forEach((c) => walk(c, inside));
    if (n && typeof n === 'object') {
      const now = inside || n.group === 'vanblog-serve-html';
      if (n.handler === 'vars' && typeof n.root === 'string' && now) roots.push(n.root);
      Object.values(n).forEach((v) => walk(v, now));
    }
  };
  walk(JSON.parse(s), false);
  console.log(roots.join('\n'));
});
JS

gen() { # $1 = mode；env 由调用方通过环境变量传入
  "${NODE_BIN}" "${HELPER}" "${TEMPLATE}" "$1" 'me@example.com'
}
roots_of() { gen permission | "${NODE_BIN}" "${EXTRACTOR}"; }

# ⚠️ 用**子 shell** 控制这个环境变量的有无：`env -u VAR fn` 是行不通的 —— `env` 只能 exec
#    外部程序，跑不了 shell 函数（会报 roots_of: No such file or directory）。
UNSET_MARK='@@unset@@'
with_dir() { # $1 = 值或 UNSET_MARK；$2 = 要跑的函数名（roots_of | gen_err）
  if [[ "$1" == "${UNSET_MARK}" ]]; then
    ( unset VANBLOG_CADDY_HTML_PAGES_DIR; "$2" )
  else
    ( VANBLOG_CADDY_HTML_PAGES_DIR="$1"; export VANBLOG_CADDY_HTML_PAGES_DIR; "$2" )
  fi
}
gen_err() { gen permission 2>&1 >/dev/null; }

# --- 默认目录**从生成器自己**读出来（不硬编码字面量：模板改了这里不会漂）---
DEFAULT_ROOT="$(with_dir "${UNSET_MARK}" roots_of | head -1)"
if [[ -z "${DEFAULT_ROOT}" ]]; then
  fail "取不到默认 root（生成器未设置该变量时应当沿用模板里的值）"
  echo; echo "passed=${PASS} failed=${FAIL}"; exit 1
fi
pass "默认 root 从生成器实测得到：${DEFAULT_ROOT}"
assert_eq "$(with_dir "${UNSET_MARK}" roots_of | wc -l | tr -d ' ')" "2" \
  "未设置时恰好 2 处 serve-html root（srv0 + srv1）"

# --- 逐个取值真跑生成器，断言可观测后果 ---
# 输出格式：id<TAB>unset(0/1)<TAB>rejected(0/1)<TAB>normalized(0/1)<TAB>dir(null 或字符串)<TAB>raw(base64)
ROWS="$("${NODE_BIN}" -e '
const fs=require("fs");
const t=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for (const c of t.cases) {
  const raw = c.unset ? "" : (typeof c.raw === "string" ? c.raw : JSON.stringify(c.raw));
  const kind = c.unset ? "unset" : "str";
  console.log([c.id, kind, c.rejected?1:0, c.normalized?1:0, c.dir===null?"@default":c.dir,
               Buffer.from(raw,"utf8").toString("base64"), c.envLossy?1:0,
               Buffer.from(c.envLossyWhy||"","utf8").toString("base64")].join("\t"));
}' "${CASES}")"

N_CASES=0
N_REJECT=0
N_ACCEPT=0
N_SKIPPED=0
while IFS=$'\t' read -r id kind rejected normalized wantDir rawB64 lossy lossyWhyB64; do
  [[ -z "${id}" ]] && continue
  N_CASES=$((N_CASES + 1))
  RAW="$(printf '%s' "${rawB64}" | base64 -d 2>/dev/null || true)"
  EXPECT_ROOT="${wantDir}"
  if [[ "${wantDir}" == "@default" ]]; then EXPECT_ROOT="${DEFAULT_ROOT}"; fi

  # ⚠️ 有些取值**无法通过环境变量表达**，必须显式跳过并说出原因（不能静默 continue，
  #    否则"全部通过"会变成假象）。实测：NUL 字节会被 execve 截断（'/ok\0x' 变成 '/okx'，
  #    而那恰好是个**合法**路径 ⇒ 生成器正确地接受了它，于是这条用例在 shell 侧永远测不到拒绝）；
  #    非字符串（数字/null）同理，env 的值永远是字符串。这两类由 jest 侧直接传 JS 值覆盖。
  if [[ "${lossy}" == "1" ]]; then
    N_SKIPPED=$((N_SKIPPED + 1))
    WHY="$(printf '%s' "${lossyWhyB64}" | base64 -d 2>/dev/null || true)"
    if [[ -n "${WHY}" ]]; then
      pass "[${id}] 显式跳过（无法用环境变量表达）：${WHY}"
    else
      fail "[${id}] 标了 envLossy 却没写 envLossyWhy ⇒ 跳过理由不可核查（等于静默少测一条）"
    fi
    continue
  fi

  if [[ "${kind}" == "unset" ]]; then
    OUT_ROOTS="$(with_dir "${UNSET_MARK}" roots_of)"
    OUT_ERR="$(with_dir "${UNSET_MARK}" gen_err)"
  else
    OUT_ROOTS="$(with_dir "${RAW}" roots_of)"
    OUT_ERR="$(with_dir "${RAW}" gen_err)"
  fi

  # 1) 生效目录：所有 serve-html root 都必须是期望值
  BAD_ROOTS="$(printf '%s\n' "${OUT_ROOTS}" | grep -vxF "${EXPECT_ROOT}" | wc -l | tr -d ' ')"
  if [[ "${BAD_ROOTS}" == "0" && -n "${OUT_ROOTS}" ]]; then
    pass "[${id}] 生成器生效目录 = ${EXPECT_ROOT}"
  else
    fail "[${id}] 生成器生效目录不符：期望每处都是 '${EXPECT_ROOT}'，实际 '$(printf '%s' "${OUT_ROOTS}" | tr '\n' '|')'"
  fi

  # 2) WARN 形状：被拒 ⇒ 必须有"已被忽略"；未被拒 ⇒ 必须没有
  HAS_IGNORE=0
  printf '%s' "${OUT_ERR}" | grep -q "已被忽略" && HAS_IGNORE=1
  if [[ "${rejected}" == "1" ]]; then
    N_REJECT=$((N_REJECT + 1))
    if [[ "${HAS_IGNORE}" == "1" ]]; then pass "[${id}] 被拒且 stderr 大声 WARN（不是静默回落）"
    else fail "[${id}] 期望被拒并 WARN，但 stderr 里没有'已被忽略'（静默失效正是本次修复要消灭的形状）"; fi
    # 被拒时绝不能让整份配置失败（那会退回降级模板、HTTPS 静默变自签）
    if ( VANBLOG_CADDY_HTML_PAGES_DIR="${RAW}"; export VANBLOG_CADDY_HTML_PAGES_DIR; gen permission >/dev/null 2>&1 ); then :; else fail "[${id}] 生成器因这个值退出非 0（会让 entrypoint 退回降级模板）"; fi
  else
    N_ACCEPT=$((N_ACCEPT + 1))
    if [[ "${HAS_IGNORE}" == "0" ]]; then pass "[${id}] 未被拒 ⇒ stderr 没有'已被忽略'"
    else fail "[${id}] 不该被拒却打了'已被忽略' WARN"; fi
  fi

  # 3) 规范化：期望规范化时必须有那条 WARN，且 root 是规范化后的值（上面 1 已断言）
  if [[ "${normalized}" == "1" ]]; then
    if printf '%s' "${OUT_ERR}" | grep -q "已规范化"; then pass "[${id}] 规范化被明确说出来（'${RAW}' → '${EXPECT_ROOT}'）"
    else fail "[${id}] 期望规范化 WARN，stderr 里没有"; fi
  fi
done <<< "${ROWS}"

assert_eq "$((N_REJECT > 0))" "1" "取值表里确实有被拒的取值（否则上面全是接受路径，守卫空转）"
assert_eq "$((N_ACCEPT > 0))" "1" "取值表里确实有被接受的取值"
# ⚠️ 跳过数必须**有上限**：否则"把整个表标成 envLossy"就能让守卫全绿而什么都不测。
if [[ "${N_SKIPPED}" -le 3 ]]; then
  pass "显式跳过 ${N_SKIPPED} 条（≤3：跳过不能被用来把整张表测空）"
else
  fail "跳过了 ${N_SKIPPED} 条，太多 ⇒ 检查是不是有人用 envLossy 绕过了断言"
fi
echo "NOTE: 取值表共 ${N_CASES} 条（shell 侧实跑：被拒 ${N_REJECT} / 未被拒 ${N_ACCEPT}；显式跳过 ${N_SKIPPED}）"

# --- 🔴 逐层隔离：每条规则都要有一个"只可能被它拦住"的取值 ---
#     教训：`{env.HOME}/x` 会先被"不是绝对路径"拦下 ⇒ 删掉花括号规则也测不出来。
for rule in control-chars braces not-absolute dot-dot filesystem-root; do
  CNT="$("${NODE_BIN}" -e '
    const fs=require("fs");
    const t=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const rule=process.argv[2];
    let n=0;
    for (const c of t.cases) {
      if (c.rule!==rule || typeof c.raw!=="string") continue;
      const raw=c.raw.trim();
      const ctrl=/[\u0000-\u001f\u007f]/.test(raw);
      const brace=raw.includes("{")||raw.includes("}");
      const abs=raw.startsWith("/");
      const dd=raw.split("/").includes("..");
      const order=[["control-chars",ctrl],["braces",brace],["not-absolute",!abs],["dot-dot",dd]];
      const first=(order.find(([,h])=>h)||[])[0];
      if (rule==="filesystem-root" ? first===undefined : first===rule) n++;
    }
    console.log(n);' "${CASES}" "${rule}")"
  if [[ "${CNT}" -ge 1 ]]; then pass "规则 ${rule} 有 ${CNT} 个'只可能被它拦住'的取值"
  else fail "规则 ${rule} 没有一个'只可能被它拦住'的取值 ⇒ 删掉这条规则也测不出来（守卫空转）"; fi
done

# --- 服务端三处必须都在调共用函数（shell 侧的独立绊线）---
# 剥掉 TS 的**整行**注释（`//`、`*`、`/*` 开头的行）。
# ⚠️ 为什么用按行剥、而不是正则剥块注释：
#   ① `sed 's://.*$::'` 会把字符串里的 `https://` 也当注释吃掉（本仓库的既有坑）；
#   ② "先剥块注释再剥行注释"的尺子会被**行注释里出现的 `/*`** 骗到，从而吃掉真实代码
#      （本仓库另一处刚踩过：注释里写了个 glob `signing/*.pub.pem`，结果中间一段代码被整段删掉，
#       表现出来是一条毫不相干的计数断言变红）；
#   ③ `sed -e '/^[[:space:]]*/\*/d'` 这种写法本身就会因为分隔符与模式里的 `/` 冲突而报
#      `unknown command`，而**它失败时输出为空 ⇒ "必须包含"假红、"不许包含"假绿**（实测踩过）。
# 所以：正向断言（必须调用共用函数）在剥掉整行注释后的文本上做；
#       负向断言（不许有裸回落）在**整个文件**上做 —— 更严格，而且与注释无关，
#       因为那三个文件的注释里都不含完整的裸回落形状（只写"裸 env || DEFAULT"这种简写）。
strip_ts_lines() {
  awk '{ l=$0; sub(/^[ \t]+/, "", l);
         if (l ~ /^\/\//) next; if (l ~ /^\*/) next; if (l ~ /^\/\*/) next;
         print }' "$1"
}
for f in packages/server/src/provider/caddy/caddy.provider.ts \
         packages/server/src/utils/degradedServeHtml.ts \
         packages/server/src/provider/isr/artifactReaper.ts; do
  CODE="$(strip_ts_lines "${ROOT}/${f}")"
  # ⚠️ 剥注释器本身也要被验证：剥完必须还有内容，否则上面那种"sed 报错 ⇒ 输出为空"的失效
  #    会让"必须包含"假红、"不许包含"假绿，而两条都看起来像是正常结论。
  if [[ -n "${CODE}" ]]; then pass "${f##*/} 的剥注释器产出了非空文本（不是静默失效）"
  else fail "${f##*/} 剥注释后为空 ⇒ 剥注释器失效，本文件的两条断言都不可信"; fi
  if printf '%s' "${CODE}" | grep -q 'resolveWebsitePagesDir('; then
    pass "${f##*/} 调用共用解析函数 resolveWebsitePagesDir"
  else
    fail "${f##*/} 没有调用 resolveWebsitePagesDir（自己解析 = 会与 caddy 侧得出不同目录）"
  fi
  if grep -qE 'SERVE_HTML_PAGES_DIR_ENV\][[:space:]]*\|\|[[:space:]]*DEFAULT_WEBSITE_PAGES_DIR' "${ROOT}/${f}"; then
    fail "${f##*/} 里仍有裸回落 env || DEFAULT（这条形状正是缺陷本身）"
  else
    pass "${f##*/} 里没有裸回落 env || DEFAULT"
  fi
done

# ⚠️ 反证：上面那把"不许出现"的尺子量得到坏形状（否则 doesNotMatch 恒真）
BAD='const dir = process.env[SERVE_HTML_PAGES_DIR_ENV] || DEFAULT_WEBSITE_PAGES_DIR;'
if printf '%s' "${BAD}" | grep -qE 'SERVE_HTML_PAGES_DIR_ENV\][[:space:]]*\|\|[[:space:]]*DEFAULT_WEBSITE_PAGES_DIR'; then
  pass "反证：坏形状确实会被上面那条尺子量到"
else
  fail "反证失败：坏形状量不到 ⇒ 上面那条'不许出现'是恒真断言"
fi
# ⚠️ 反证 2：整行注释会被剥掉，所以"注释里提到坏形状"不会造成假红
if printf '%s' "// ${BAD}" | sed -e 's://.*$::' | grep -qE 'SERVE_HTML_PAGES_DIR_ENV\][[:space:]]*\|\|'; then
  fail "行注释没有被剥掉 ⇒ 解释性注释会造成假红"
else
  pass "反证：整行注释被剥掉（解释性文字不会造成假红）"
fi

# --- jest 侧 parity spec 必须存在、必须读同一份取值表（否则两侧会各自漂）---
if grep -q 'fixtures/pages-dir-cases.json' "${PARITY_SPEC}"; then
  pass "jest 侧 parity spec 读的是同一份取值表（不是各写一份）"
else
  fail "jest 侧 parity spec 没有读 fixtures/pages-dir-cases.json ⇒ 两侧取值表会漂"
fi
if grep -q 'resolvePagesDir' "${PARITY_SPEC}" && grep -q 'sliceFunction' "${PARITY_SPEC}"; then
  pass "jest 侧是**从生成器原文切出真函数**来比对（不是复制一份 JS 规则）"
else
  fail "jest 侧看起来没有从生成器原文切函数 ⇒ 它可能在与一份复制品比对（复制品不会随 JS 改动失效）"
fi

# --- 生成器的拒绝文案必须与"服务端也校验"这个事实一致 ---
# 这段原本是"已知待办、故意不断言"：当时文案还写着"服务端仍会把哨兵文件写到你给的这个路径，
# 所以两侧现在不一致"，那句话在修复**之前**成立、之后就是假信息。原作者故意不加断言是对的
# （钉住错文案会让它永久化，断言"已修好"又会让树一直红）—— 文案已由父代理更正，所以现在可以真断言了。
# ⚠️ 必须先剥 `//` 注释行再判"不许出现"：更正时在 caddyConfig.js 里留下的解释性注释
#    **本身就引用了旧文案的片段**，直接 grep 原文会假红（本仓库已踩 9 次"断言匹配到解释性注释"）。
GEN_CODE_ONLY="$(awk '{ line=$0; sub(/^[ \t]+/, "", line); if (line ~ /^\/\//) next; print }' "${ROOT}/scripts/caddyConfig.js")"
if printf '%s' "$GEN_CODE_ONLY" | grep -qF '但服务端仍会把哨兵文件写到你给的这个路径'; then
  fail "生成器的拒绝文案仍是修复前那句假信息（服务端现在也回落默认目录了）⇒ 会误导运维去查一个已不存在的不一致"
else
  pass "生成器不再声称『服务端仍会写到给定路径 ⇒ 两侧不一致』（已剥 // 注释行后判定，避免匹配到解释性注释）"
fi
if printf '%s' "$GEN_CODE_ONLY" | grep -qF '服务端也会用同样的规则回落到默认目录'; then
  pass "生成器的拒绝文案说明了服务端同样回落默认目录（两侧同规则、同结论）"
else
  fail "生成器的拒绝文案没有说明服务端同样回落 ⇒ 运维会以为只有 caddy 侧回落"
fi
# ⚠️ 空转反证：证明上面那把"剥注释"的尺子真的在工作（剥之前必须能命中旧文案所在的注释）
if awk '{ print }' "${ROOT}/scripts/caddyConfig.js" | grep -qF '服务端仍会把哨兵写到你给的路径'; then
  pass "反证成立：未剥注释时能命中解释性注释里的旧文案片段 ⇒ 剥注释这一步不是空操作"
else
  fail "反证失败：连未剥注释的原文都命不中旧文案片段 ⇒ 上面那条『不许出现』可能是恒真"
fi

rm -f "${EXTRACTOR}"

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
