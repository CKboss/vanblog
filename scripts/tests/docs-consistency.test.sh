#!/usr/bin/env bash
# 文档与脚本的一致性守卫。
#
# 这类漂移已经发生过好几次：脚本的默认行为改了（backup 从"打包数据目录"变成"整站备份"、
# 镜像换成 ghcr、mongo 版本改成按数据目录决定），而文档还写着旧命令；更糟的是文档里
# 还留着 `docker-compose down -v` 这种**会删卷**的命令。测试比人记得牢。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"
PUBLIC_SCRIPT="${ROOT}/docs/.vuepress/public/vanblog.sh"
FORK_SCRIPT_URL="https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }

echo "== 安装/备份/恢复文档一致性 =="

# ---------- 0) 两份脚本必须字节一致 ----------
if cmp -s "${SCRIPT}" "${PUBLIC_SCRIPT}"; then
  pass "scripts/vanblog.sh 与 docs/.vuepress/public/vanblog.sh 字节一致"
else
  fail "两份 vanblog.sh 不一致（文档站提供下载的那份会是旧的）"
fi

# ---------- 1) 文档里出现的每个子命令，脚本都得真的支持 ----------
# 子命令有两种形状，都要抠出来：
#   a) 底部分发处的 `  "name")`（历史形状，两空格缩进 + 单独一行）
#   b) pre_check **之前**那一行 `case "${1:-}" in a | b | c) … exec …/vanblog-drill.sh …`
#      —— 免 root 的只读子命令（drill / verify-deep / backup-verify / backup-status）走这条：
#      pre_check 既 `mkdir -p /var/vanblog` 又对非 root 直接 exit 1，放在分发处的话
#      "校验一份自己拥有的归档"这种纯只读操作也会要求 root（而这台机器上 root 跑 podman
#      看到的是另一套镜像存储，等于演练根本跑不了）。
# 只认 a) 的后果是：文档里写了 ./vanblog.sh drill，这条守卫反而说脚本不支持它。
SUBS="$(
  {
    grep -oE '^  "[a-z_-]+"\)' "${SCRIPT}" | tr -d ' ")'
    grep -E '^case "\$\{1:-\}" in .*vanblog-drill\.sh' "${SCRIPT}" | head -1 |
      sed -E 's/^case "\$\{1:-\}" in ([^)]*)\).*/\1/' | tr '|' '\n' | tr -d ' '
  } | grep -v '^$' | sort -u
)"
for c in drill verify-deep backup-verify backup-status; do
  if printf '%s\n' "${SUBS}" | grep -qx "${c}"; then
    pass "vanblog.sh 支持 ${c}（转发给 scripts/vanblog-drill.sh，且在 pre_check 之前 ⇒ 不要求 root）"
  else
    fail "vanblog.sh 没有把 ${c} 转发给 vanblog-drill.sh（pre_check 之前那行 case 被删了/改名了？）"
  fi
done
DOC_CMDS="$(grep -rhoE '\./vanblog\.sh [a-z_-]+' "${ROOT}/docs" --include='*.md' 2>/dev/null |
  awk '{print $2}' | sort -u)"
missing=""
for c in ${DOC_CMDS}; do
  printf '%s\n' "${SUBS}" | grep -qx "${c}" || missing="${missing} ${c}"
done
if [[ -z "${missing}" ]]; then
  pass "文档里出现的子命令脚本都支持（$(printf '%s' "${DOC_CMDS}" | tr '\n' ' ')）"
else
  fail "文档写了脚本不支持的子命令:${missing}"
fi
# 反向：脚本新增的子命令应该在文档里出现过（status 这种新命令最容易漏）
for c in backup restore status update install config log; do
  if printf '%s' "${DOC_CMDS}" | grep -qx "${c}"; then
    pass "子命令 ${c} 在文档里有出现"
  else
    fail "子命令 ${c} 脚本里有、文档里没提"
  fi
done

# ---------- 2) 绝不能教用户敲 `down -v` ----------
# 允许出现在"不要这样做"的警告里，不允许出现在可复制的代码块里
BAD_V="$(grep -rn 'down -v' "${ROOT}/docs" --include='*.md' 2>/dev/null |
  # ⚠️ `删卷` 也要算警告措辞：docs/changelog.md 是根 CHANGELOG 的**生成镜像**，
  #    里面的历史条目写的是「原来还在教 docker-compose down -v，那会删卷」——
  #    那是在**记录一次修复**，不是在教人用。为了历史条目去改根 CHANGELOG 的措辞是本末倒置。
  grep -vE '不要|千万|danger|删除编排里的卷|删库|删卷|只有.*uninstall')"
if [[ -z "${BAD_V}" ]]; then
  pass "文档里没有教人用 docker-compose down -v（只在警告里出现）"
else
  fail "文档里还有 down -v 的用法：$(printf '%s' "${BAD_V}" | head -2 | cut -c1-100)"
fi

# ---------- 3) 安装文档必须指向本分支的脚本，而不是上游的 ----------
UPSTREAM_HITS="$(grep -rn 'vanblog\.mereith\.com/vanblog\.sh' "${ROOT}/docs/guide" "${ROOT}/docs/faq" \
  --include='*.md' 2>/dev/null | grep -v '上游' || true)"
if [[ -z "${UPSTREAM_HITS}" ]]; then
  pass "guide/faq 里没有把上游脚本地址当成安装命令（会装成官方版）"
else
  fail "还有文档让人从上游地址下脚本：$(printf '%s' "${UPSTREAM_HITS}" | head -2 | cut -c1-110)"
fi
if grep -rqF "${FORK_SCRIPT_URL}" "${ROOT}/docs/guide/script.snippet.md"; then
  pass "安装文档给的是本分支的脚本地址"
else
  fail "安装文档里没有本分支的脚本地址"
fi

# ---------- 4) 文档提到的环境变量名，必须真的在代码里有读取点 ----------
# 🔴 2026-09-22 扩宽。原来只扫 5 份文档、只认 `VANBLOG_[A-Z_]+`、"存在"语料只有
#    一键脚本 + compose 模板 + drill 脚本 + `packages/server/src`。三处缺口都是实测出来的：
#    ① `docs/reference/env.md` 是变量的**权威清单**（210 个名字），却不在语料里 ⇒
#       全部文档里的 246 个名字有 **165 个从来没被这条守卫扫过**；
#    ② 正则漏掉 `VAN_BLOG_*` 家族（`loadConfig('a.b.c')` 推导出的那一支，共 33 个）——
#       而 🔴 **第二次死旋钮事故正是这个家族**：文档写 `VANBLOG_CADDY_DATA_PATH`，
#       真名是 `VAN_BLOG_CADDY_DATA_PATH`（差一个下划线）⇒ **那条因它而生的守卫抓不到它的复发**；
#    ③ `[A-Z_]+` 不含数字 ⇒ `VANBLOG_INIT_LIMIT_PER_10MIN` 会被截成 `..._PER_`，
#       而判据是 `grep -qF`（**子串**匹配）⇒ 截断后的前缀能在真名里找到 ⇒ 🔴 **静默放行**
#       （比误报更糟：它让守卫看起来在跑，实际那一条从来没被检查过）。
# ⚠️ 语料口径的两点刻意选择，都别"顺手统一"：
#   - **"存在"语料包含 spec 文件**，这与 `packages/server/src/utils/envVarMentions.spec.ts`
#     刻意**排除** spec 相反，而 🔴 **两边都对**：那条守卫问的是"用户可见文案里提到的变量
#     是否真有**运行期**读取点"（只有测试读的变量不算数）；这一条问的是"文档写的名字是否
#     **在仓库里存在**"，而 `env.md` 有一节专门登记**测试专用**变量
#     （`VANBLOG_TEST_ENV_NUM`、`VANBLOG_SEARCH_MONGOD`、`VANBLOG_SEARCH_REALDB*`）⇒
#     排除 spec 会把这些**合法的**登记判成"编造的"。👉 同一条性质、两个不同的问题 ⇒ 两套语料。
#   - **通配家族写法（结尾是下划线，如 `VANBLOG_ISR_RETRY_`、`VANBLOG_WATERMARK_`）不算名字**，
#     所以正则要求**以字母数字结尾**；否则会把"某家族"当成"某个变量"去查，必然查不到。
# ⚠️ 已知宽松处（与扩宽前一致，未新增）：判据是"名字在语料里出现过"，所以**只在代码注释里
#    被提过**也算存在。要收紧到"真的有 `process.env[...]` 读取点"需要数据流分析，成本与
#    假阳性都会大幅上升；`envVarMentions.spec.ts` 已从"用户可见文案"那一侧覆盖了更严的口径。
# 🔴 提取口径：**一条贪婪正则 + 按结尾字符分流**，不要用两条正则。
#    贪婪 `(VAN_BLOG|VANBLOG)_[A-Z0-9_]*` 会把 `VANBLOG_ADMIN_PASSWORD_FILE` **整体**取出，
#    所以不会另外产生截断形 `VANBLOG_ADMIN_PASSWORD`；而**通配家族写法**（文档里写成
#    `VANBLOG_ISR_RETRY_`、`VANBLOG_WATERMARK_` 这种结尾带下划线的）取出后**以下划线结尾**，
#    用 `grep -E '[A-Z0-9]$'` 一律滤掉 ⇒ 不需要单独再抠一遍家族写法。
#    ⚠️ 曾经踩过：用第二条"以 `_` 结尾"的正则去抠家族写法，它会匹配**任何真名字的前半段**
#    （`VANBLOG_ADMIN_PASSWORD_FILE` 的前缀 `VANBLOG_ADMIN_PASSWORD_`）⇒ 一次误删了 9 个真变量
#    （`VANBLOG_ADMIN_PASSWORD`、`VANBLOG_BACKUP_PASSPHRASE`、`VANBLOG_DATA_PATH`、
#    `VAN_BLOG_REVALIDATE` 等），而守卫**不会变红、只会静默变弱**。
#    🔴 判据不能是"是别的名字的严格前缀"（`VANBLOG_BACKUP_PASSPHRASE` 正是 `..._FILE` 的严格前缀，
#    两者都是真变量），只能是"**原文里这个 token 以下划线结尾**"。
ENV_TOKEN_RE='(VAN_BLOG|VANBLOG)_[A-Z0-9_]*'
DOC_ENV_NAMES="$(mktemp)"
CODE_ENV_NAMES="$(mktemp)"
SYN_ENV_NAMES="$(mktemp)"
# 文档侧：全部 docs/**/*.md（🔴 排除生成镜像 docs/changelog.md —— 它整篇是历史记录，
# 里面合法地提到"某变量已删除"这类事实）+ README.md；排除 .vuepress 的构建产物。
find "${ROOT}/docs" -name '*.md' \
  -not -path "${ROOT}/docs/changelog.md" \
  -not -path '*/.vuepress/*' -print0 2>/dev/null \
  | xargs -0 grep -ohIE "${ENV_TOKEN_RE}" 2>/dev/null > "${DOC_ENV_NAMES}.raw"
grep -ohIE "${ENV_TOKEN_RE}" "${ROOT}/README.md" 2>/dev/null >> "${DOC_ENV_NAMES}.raw"
grep -E '[A-Z0-9]$' "${DOC_ENV_NAMES}.raw" 2>/dev/null | sort -u > "${DOC_ENV_NAMES}"
# 代码侧：所有包的源码与配置、scripts/**、.github/**，外加 Dockerfile / compose / 根 package.json。
find "${ROOT}/packages" "${ROOT}/scripts" "${ROOT}/.github" \
  \( -name node_modules -o -name dist -o -name .next -o -name .umi -o -name .umi-production \
     -o -name coverage -o -name .turbo -o -name .vuepress \) -prune -o \
  -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.cjs' \
     -o -name '*.mjs' -o -name '*.json' -o -name '*.sh' -o -name '*.yml' -o -name '*.yaml' \) \
  -print0 2>/dev/null \
  | xargs -0 grep -ohIE "${ENV_TOKEN_RE}" 2>/dev/null > "${CODE_ENV_NAMES}.raw"
for extra in Dockerfile docker-compose/docker-compose-template.yml docker-compose/docker-compose.yml package.json; do
  grep -ohIE "${ENV_TOKEN_RE}" "${ROOT}/${extra}" 2>/dev/null >> "${CODE_ENV_NAMES}.raw"
done
grep -E '[A-Z0-9]$' "${CODE_ENV_NAMES}.raw" 2>/dev/null | sort -u > "${CODE_ENV_NAMES}"
doc_env_count="$(wc -l < "${DOC_ENV_NAMES}" | tr -d ' ')"
code_env_count="$(wc -l < "${CODE_ENV_NAMES}" | tr -d ' ')"
unknown_env="$(comm -23 "${DOC_ENV_NAMES}" "${CODE_ENV_NAMES}")"
# 🔴 反空转：语料 glob 坏掉时"没有未知名字"会变成一个空的绿（本仓库已因此写出过恒真守卫）
if [[ "${doc_env_count}" -ge 200 ]]; then
  pass "反空转：文档侧提取到 ${doc_env_count} 个变量名（下界 200）"
else
  fail "反空转：文档侧只提取到 ${doc_env_count} 个变量名（下界 200）⇒ docs 语料的 find/grep 或结尾过滤可能坏了"
fi
if [[ "${code_env_count}" -ge 200 ]]; then
  pass "反空转：代码侧提取到 ${code_env_count} 个变量名（下界 200）"
else
  fail "反空转：代码侧只提取到 ${code_env_count} 个变量名（下界 200）⇒ 代码语料的 find/grep 或结尾过滤可能坏了"
fi
# 🔴 尺子有效性反证：同一套差集逻辑，对"一个真名字 + 一个编造名字"的合成语料，
#    必须**只**抓到编造的那个（否则会误报真名字 ⇒ 守卫一上线就天天红 ⇒ 被加白名单加到失效）。
# 🔴 探针名用**相邻字符串拼接**构造：完整字面量绝不出在本文件里。
#    原因（实测踩过）：代码语料包含 `scripts/**`，也就是**包含这条守卫自己**，
#    所以直接写 `probe_env="VANBLOG_XXX"` 会让 XXX 立刻"存在于代码语料"⇒ 差集为空 ⇒
#    尺子反证恒真地"通过"。👉 这正是"不要写你要断言不存在的字面量"那条规矩的新形态：
#    **守卫自己的源码也在它的语料里**。拼接后源码里只有 `VANBLOG_` 与 `ZZ_RULER_PROBE_KNOB`
#    两半，都不匹配名字正则（前者后面紧跟引号、不以字母数字结尾；后者不带前缀）。
probe_env="VANBLOG_""ZZ_RULER_PROBE_KNOB"
printf '%s\n%s\n' 'VANBLOG_TRUST_FORWARDED_HEADERS' "${probe_env}" | sort -u > "${SYN_ENV_NAMES}"
syn_unknown="$(comm -23 "${SYN_ENV_NAMES}" "${CODE_ENV_NAMES}")"
if [[ "${syn_unknown}" == "${probe_env}" ]]; then
  pass "尺子有效性：合成语料里编造的名字被抓到、真名字没被误报"
else
  fail "尺子失效：合成语料的差集结果不是恰好那个编造名（got '${syn_unknown}'）"
fi
if [[ -z "${unknown_env}" ]]; then
  pass "文档里的 ${doc_env_count} 个 VAN_BLOG_*/VANBLOG_* 名字都在代码语料里存在（含 env.md 权威清单）"
else
  fail "文档提到代码里不存在的变量名（可能是编造的、改名后没同步、或差一个下划线）:$(printf '%s' "${unknown_env}" | tr '\n' ' ')"
fi
rm -f "${DOC_ENV_NAMES}" "${DOC_ENV_NAMES}.raw" "${CODE_ENV_NAMES}" "${CODE_ENV_NAMES}.raw" "${SYN_ENV_NAMES}"

# ---------- 5) 文档写的默认值要和脚本一致 ----------
# ⚠️ `${VAR:-default}` 里 cut -d: -f2- 会多带一个 `-`，要把开头的 `-` 去掉
img_default="$(grep -oE 'VANBLOG_IMAGE_REF:-[^}]+' "${SCRIPT}" | head -1 | cut -d: -f2- | sed 's/^-//')"
mongo_default="$(grep -oE 'VANBLOG_MONGO_IMAGE:-[^}]+' "${SCRIPT}" | head -1 | cut -d: -f2- | sed 's/^-//')"
if grep -rqF "${img_default}" "${ROOT}/docs/guide/script.snippet.md"; then
  pass "文档写的默认镜像与脚本一致（${img_default}）"
else
  fail "文档里的默认镜像与脚本不一致（脚本是 ${img_default}）"
fi
if grep -rqF "${mongo_default}" "${ROOT}/docs/guide/script.snippet.md"; then
  pass "文档写的默认 mongo 与脚本一致（${mongo_default}）"
else
  fail "文档里的默认 mongo 与脚本不一致（脚本是 ${mongo_default}）"
fi

# ---------- 6) backup/restore 的文档要说清"默认是整站备份" ----------
if grep -qF 'backup --offline' "${ROOT}/docs/guide/backup.md" &&
  grep -qF 'vanblog-full-' "${ROOT}/docs/guide/backup.md"; then
  pass "备份文档区分了整站备份（默认）与 --offline 目录快照"
else
  fail "备份文档没写清默认是整站备份、--offline 才是目录快照"
fi
if grep -qF 'JWT' "${ROOT}/docs/guide/backup.md" || grep -qF '重新登录' "${ROOT}/docs/guide/backup.md"; then
  pass "备份文档提醒了恢复后要重新登录后台（JWT 密钥是启动时读的）"
else
  fail "备份文档没提恢复后需要重新登录"
fi
if grep -qF 'down -v' "${ROOT}/docs/guide/update.md" && grep -qF '不要' "${ROOT}/docs/guide/update.md"; then
  pass "升级文档明确警告了 down -v"
else
  fail "升级文档没有 down -v 的警告"
fi

# ---------- 7) 本地构建文档存在且被安装文档链接到 ----------
if [[ -f "${ROOT}/docs/advanced/local-build.md" ]]; then
  pass "有 docs/advanced/local-build.md（本地构建与验证镜像）"
  for kw in "build-image-local.sh" "podman" "SHARP_DIST_HOST" "aardvark-dns" "publish-ghcr"; do
    if grep -qF "${kw}" "${ROOT}/docs/advanced/local-build.md"; then
      pass "本地构建文档覆盖 ${kw}"
    else
      fail "本地构建文档没提 ${kw}"
    fi
  done
else
  fail "缺少 docs/advanced/local-build.md"
fi
if grep -qF "local-build.md" "${ROOT}/docs/guide/script.snippet.md"; then
  pass "安装文档链接到了本地构建文档"
else
  fail "安装文档没有链接本地构建文档"
fi


# ---------- 8) Markdown 里不能有"裸的尖括号占位符"（会让文档站构建失败）----------
# 真踩过：`<https://github.com/<owner>/<repo>/...>` 这种自动链接里套占位符，
# vue 编译器把 `<owner>` 当成没闭合的标签 → `[vite:vue] Element is missing end tag` →
# 整个文档站构建失败。占位符要么放进反引号，要么就别用尖括号自动链接。
# 合法的 HTML 标签（img/kbd/strong/p/br/a/code/details/summary/table 等）放行。
# ⚠️ 参数必须写在 heredoc **之前**（`python3 - "${ROOT}" <<'PYANGLE'`）。
# 以前它写在结束符 `PYANGLE` 之后另起一行（` "${ROOT}")"`），bash 会把它当成一条**新命令**执行
# ⇒ 屏幕上多一句 `Is a directory`，而 python 拿不到 argv[1] ⇒ IndexError ⇒ stdout 为空
# ⇒ 下面 `[[ -z "${BAD_ANGLES}" ]]` 成立 ⇒ **PASS 是假的**（这条守卫就这样空转了很久）。
# 所以现在：① 参数前置；② python 先打一行 `SCANNED=<份数>` 作为"我真跑了"的凭据；
# ③ bash 检查退出码与那个份数，任何一个不对都算 FAIL，绝不把"脚本自己挂了"读成"文档没问题"。
BAD_ANGLES_RAW="$("${PY:-python3}" - "${ROOT}" <<'PYANGLE'
import re, subprocess, sys
allowed = {
    "img", "p", "br", "strong", "em", "code", "pre", "kbd", "a", "details", "summary",
    "table", "thead", "tbody", "tr", "td", "th", "div", "span", "sup", "sub", "b", "i",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "center", "video", "source", "AutoCatalog",
    "Badge", "CodeGroup", "CodeGroupItem", "FontIcon", "Icon", "Tabs", "Tab",
}
fence = re.compile(r"^\s*(```|~~~)")
angle = re.compile(r"</?([A-Za-z][A-Za-z0-9_-]*)[^>]*>|<[^>\s]{1,40}>")
files = subprocess.run(["git", "ls-files", "docs/**/*.md", "docs/*.md", "README.md"],
                       capture_output=True, text=True, cwd=sys.argv[1]).stdout.split()
bad = []
for path in files:
    try:
        lines = open(path, encoding="utf-8").read().split("\n")
    except OSError:
        continue
    in_code = False
    for n, line in enumerate(lines, 1):
        if fence.match(line):
            in_code = not in_code
            continue
        if in_code:
            continue
        no_inline = re.sub(r"`[^`]*`", "", line)
        for m in angle.finditer(no_inline):
            tag = (m.group(1) or "").strip("/")
            if tag in allowed:
                continue
            # 放行**不含占位符**的自动链接 `<https://…>`：那是合法 Markdown，文档站构建实测通过。
            # 要拦的是它里面再套一层尖括号的形状（`<https://github.com/<owner>/<repo>/…>`）——
            # vue 会把 `<owner>` 当成没闭合的标签，整个文档站构建失败（本守卫存在的原因）。
            body = m.group(0)[1:-1]
            if body.startswith(("http://", "https://", "mailto:")) and "<" not in body:
                continue
            bad.append("%s:%d %s" % (path, n, m.group(0)))
print("SCANNED=%d" % len(files))
print("\n".join(bad[:10]))
PYANGLE
)"
ANGLE_RC=$?
ANGLES_SCANNED="$(printf '%s\n' "${BAD_ANGLES_RAW}" | sed -n 's/^SCANNED=\([0-9]*\)$/\1/p' | head -1)"
BAD_ANGLES="$(printf '%s\n' "${BAD_ANGLES_RAW}" | grep -v '^SCANNED=')"
if [[ "${ANGLE_RC}" -ne 0 ]]; then
  fail "裸尖括号检查脚本自己跑挂了（rc=${ANGLE_RC}）—— 这种情况以前会静默变成 PASS"
elif [[ -z "${ANGLES_SCANNED}" || "${ANGLES_SCANNED}" -lt 20 ]]; then
  fail "裸尖括号守卫没有真跑起来（只扫到 ${ANGLES_SCANNED:-0} 份文档；docs/ 下应该有几十份）"
elif [[ -z "${BAD_ANGLES}" ]]; then
  pass "文档里没有会让 vue 编译失败的裸尖括号占位符（真扫了 ${ANGLES_SCANNED} 份）"
else
  fail "文档里有裸尖括号（会让文档站构建失败）：$(printf '%s' "${BAD_ANGLES}" | head -3 | tr '\n' ' ')"
fi


# ---------- 9) 文档里写的每个环境变量，代码里都必须真的读它 ----------
# 范围是**全部** docs/*.md（不只是部署那几份）：server / website / admin / Dockerfile /
# compose / 脚本 / entrypoint / start.js 里任一处出现即算数。
# 上一轮人工核过 39 个全对得上，这里把它固化成守卫，防止以后文档写了个不存在的变量。
ENV_CHECK="$("${PY:-python3}" - <<'PYENV' "${ROOT}"
import os, re, subprocess, sys
root = sys.argv[1]
# ⚠️ 排除 docs/changelog.md：它是根 CHANGELOG.md 的**生成镜像**（`pnpm release-doc`），
#    内容是历史记录 —— 里面会提到"某变量已删除"这类事实（例如 VANBLOG_WATERMARK_FONT_MIN_PX，
#    那两个名字当年只登记在 env 表里、代码从来没读过，本轮删掉了）。
#    这条守卫要抓的是"文档教用户去设一个代码里不存在的变量"，历史条目不是教学，
#    而为了过守卫去改历史记录的措辞是本末倒置（根 CHANGELOG.md 本来也不在扫描范围内）。
out = subprocess.run(["grep", "-rhoE", "VAN_BLOG_[A-Z_]+|VANBLOG_[A-Z_]+", "docs/",
                      "--include=*.md", "--exclude=changelog.md"],
                     capture_output=True, text=True, cwd=root).stdout.split()
names = sorted({v for v in out if not v.endswith("_")})
roots = ["packages/server/src", "packages/website", "packages/admin/src", "packages/cli",
         "Dockerfile", "entrypoint.sh", "scripts/start.js", "scripts/vanblog.sh",
         "scripts/vanblog-drill.sh",
         # ⚠️ `scripts/tests` 也必须在语料里：有些开关**只被守卫读取**（例如
         #    `VANBLOG_DRILL_LIVE` 只在 `vanblog-drill.test.sh` 里读），而贡献文档恰恰最需要
         #    写清这类"怎么把守卫的活体部分打开"的变量。不收它就会把真实变量误判成
         #    "文档写了代码里不存在的名字"（2026-09-20 真实发生过，作者只能改成不写变量名）。
         "scripts/tests",
         "scripts/build-image-local.sh", "scripts/caddyConfig.js", "docker-compose",
         "caddyTemplate.json", "caddyFallbackTemplate.json"]
corpus = []
for r in roots:
    p = os.path.join(root, r)
    if os.path.isfile(p):
        corpus.append(open(p, encoding="utf-8", errors="ignore").read())
        continue
    for dp, dn, fn in os.walk(p):
        dn[:] = [d for d in dn if d not in ("node_modules", ".next", "dist", ".umi", ".umi-production")]
        for f in fn:
            if f.endswith((".ts", ".tsx", ".js", ".jsx", ".json", ".yml", ".yaml", ".sh")):
                try:
                    corpus.append(open(os.path.join(dp, f), encoding="utf-8", errors="ignore").read())
                except OSError:
                    pass
text = "".join(corpus)
missing = [v for v in names if v not in text]
print("total=%d" % len(names))
for m in missing:
    hits = subprocess.run(["grep", "-rl", m, "docs/", "--include=*.md"],
                          capture_output=True, text=True, cwd=root).stdout.split()
    print("missing %s (%s)" % (m, ", ".join(hits[:3])))
PYENV
)"
env_total="$(printf '%s\n' "${ENV_CHECK}" | sed -n 's/^total=//p')"
env_missing="$(printf '%s\n' "${ENV_CHECK}" | grep '^missing ' | head -6)"
if [[ -n "${env_total}" && "${env_total}" -ge 20 && -z "${env_missing}" ]]; then
  pass "文档里 ${env_total} 个 VAN_BLOG_*/VANBLOG_* 变量代码里都真的在读"
else
  fail "文档写了代码里不存在的环境变量（共 ${env_total:-0} 个变量）：${env_missing}"
fi


# ---------- 10) 交互菜单与 --help 不能和脚本的实际能力脱节 ----------
MENU="$(awk '/^show_menu\(\) \{/,/^\}$/' "${SCRIPT}")"
USAGE_TEXT="$(awk '/^show_usage\(\) \{/,/^\}$/' "${SCRIPT}")"
MENU_CODE="$(printf '%s' "${MENU}" | sed 's|^[[:space:]]*#.*||')"

if [[ -n "${MENU}" && -n "${USAGE_TEXT}" ]]; then
  pass "能切出 show_menu / show_usage 两个函数体"
else
  fail "切不出 show_menu 或 show_usage 的函数体（检查器的 awk 范围要跟着改）"
fi

# 每个 dispatcher 支持的子命令都必须在 --help 里出现
DISPATCH="$(grep -oE '^  "[a-z_-]+"\)' "${SCRIPT}" | tr -d ' ")' | sort -u)"
miss_usage=""
for c in ${DISPATCH}; do
  printf '%s' "${USAGE_TEXT}" | grep -qF "${c}" || miss_usage="${miss_usage} ${c}"
done
if [[ -z "${miss_usage}" ]]; then
  pass "--help 覆盖了 dispatcher 的全部子命令（$(printf '%s' ${DISPATCH} | wc -w) 个）"
else
  fail "--help 里没写这些子命令:${miss_usage}"
fi

# 菜单要有状态总览与重置整站这两个新入口
for item in "13." "状态总览" "12." "重置整站" "整站备份"; do
  if printf '%s' "${MENU_CODE}" | grep -qF "${item}"; then
    pass "菜单里有「${item}」"
  else
    fail "菜单里缺「${item}」"
  fi
done
# 菜单顶上的状态行（装没装、跑没跑、从哪访问）
if grep -qF 'menu_state_line' "${SCRIPT}" && printf '%s' "${MENU_CODE}" | grep -qF 'menu_state_line'; then
  pass "菜单会显示运行状态行（未安装 / 运行中 / 接口不通）"
else
  fail "菜单没有运行状态行"
fi
# 不许再把上游仓库当自己的门头，也不许再谎称默认是本地构建
if printf '%s' "${MENU_CODE}" | grep -qF -- '--- https://github.com/mereithhh/van-blog ---'; then
  fail "菜单门头还是上游仓库地址（应指向本分支，上游只作为「上游项目」出现）"
else
  pass "菜单门头指向本分支（上游只作为出处提及）"
fi
if printf '%s' "${MENU_CODE}" | grep -qF '本地构建镜像 ${VANBLOG_IMAGE_TAG}'; then
  fail "菜单还说默认是本地构建镜像（现在默认是拉 ghcr 镜像，拉不到才构建）"
else
  pass "菜单描述的镜像来源与默认行为一致"
fi
# --help 里要有常用环境变量与场景配方，否则等于没写
for kw in VANBLOG_INSTALL_MODE VANBLOG_MONGO_IMAGE VANBLOG_RESTORE_FROM VANBLOG_ADMIN_TOKEN \
          VANBLOG_ASSUME_YES VANBLOG_ALPINE_MIRROR 退出码 换机器 定时; do
  if printf '%s' "${USAGE_TEXT}" | grep -qF "${kw}"; then
    pass "--help 里有「${kw}」"
  else
    fail "--help 里缺「${kw}」"
  fi
done
# usage 里不该再有重复/过时的条目
if printf '%s' "${USAGE_TEXT}" | grep -c 'backup  *- 备份 VanBlog' | grep -q '^0$'; then
  pass "--help 里没有遗留的旧「backup - 备份 VanBlog」重复条目"
else
  fail "--help 里还有旧的重复 backup 条目"
fi
if printf '%s' "${USAGE_TEXT}" | grep -qF '默认从源码构建本分支'; then
  fail "--help 还说默认从源码构建（现在默认先拉镜像）"
else
  pass "--help 对默认安装方式的描述是新的"
fi

echo "== 文档里的\"当前最新发布版\"断言不得硬编码版本号 =="

# 这类腐烂真实发生过：docs 里约 70 处硬编码 v2026.9.2、而 v2026.9.3 发布后 0 命中，
# 其中几处是**现在时**的"这就是最新发布版"断言 ⇒ 照文档钉版本的人会钉到旧版，
# 且没有任何守卫会红。修法是把这类断言改成指向 Releases 页面（权威出处），
# 这条守卫钉住"改后的形状不再退化"。
#
# ⚠️ 口径刻意收窄，否则天天误报（横切守卫最常见的死法是误报太多 ⇒ 被人加白名单加到失效）：
#   - **只报**同一行里既有"最新/当前 + 发布版/最新版本/release"这类现在时断言、又有硬编码 vX 的；
#   - **不报**格式示例（"发布号长这样 vX"）、**不报**历史实测记录、
#     **不报**"写这段时是 vX"这种**带时间限定的历史陈述**（发新版后它并不会变成假的）；
#   - 排除生成镜像 docs/changelog.md（它整篇都是历史条目）。
# ⚠️ 已知局限：这是**按行**匹配，跨行的断言扫不到。

# 权威出处：CHANGELOG.md 里最新的**已发布**版本节（顶部的 [Unreleased] 不算）。
LATEST_RELEASED="$(grep -m1 -oE '^## \[v[0-9]{4}\.[0-9]+(\.[0-9]+)?\]' "${ROOT}/CHANGELOG.md" 2>/dev/null | grep -oE 'v[0-9]{4}\.[0-9]+(\.[0-9]+)?' || true)"

# 反空转①：权威版本号必须真的解析出来了，否则"docs 里没有过时断言"是恒真的。
if [[ -n "${LATEST_RELEASED}" ]]; then
  pass "从 CHANGELOG.md 解析出最新的已发布版本节：${LATEST_RELEASED}（不是 [Unreleased]）"
else
  fail "没能从 CHANGELOG.md 解析出最新的已发布版本节 ⇒ 本节其余断言会恒真"
fi

# 反空转②：必须真的扫到了文档文件。
DOCS_SCANNED="$(find "${ROOT}/docs" -name '*.md' ! -name 'changelog.md' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "${DOCS_SCANNED}" -ge 40 ]]; then
  pass "扫描覆盖了 ${DOCS_SCANNED} 个文档文件（排除生成镜像 changelog.md）"
else
  fail "只扫到 ${DOCS_SCANNED} 个文档文件（预期 >= 40）⇒ 扫描范围可能坏了"
fi

# 核心断言：不得存在"现在时的最新发布版断言 + 硬编码版本号"。
PRESENT_TENSE_HITS="$(grep -rnE '(最新|当前)[^。|]{0,14}(发布版|发布的版本|最新版本|release)' \
  "${ROOT}/docs" "${ROOT}/README.md" --include='*.md' 2>/dev/null \
  | grep -v "^${ROOT}/docs/changelog.md:" \
  | grep -E 'v20[0-9]{2}\.[0-9]+' || true)"
if [[ -z "${PRESENT_TENSE_HITS}" ]]; then
  pass "docs 与 README 里没有\"现在时的最新发布版 + 硬编码版本号\"（权威出处应指向 Releases 页面）"
else
  fail "发现现在时的最新发布版断言里硬编码了版本号（发版后会静默过时）：$(printf '%s' "${PRESENT_TENSE_HITS}" | head -3 | tr '\n' ';')"
fi

# 尺子有效性反证：把匹配器喂一条**已知坏**的合成文本，必须能抓到；
# 喂三类**合法**形状（格式示例、带时间限定的历史陈述、历史实测记录），必须不误报。
probe_matcher() {
  printf '%s\n' "$1" | grep -qE '(最新|当前)[^。|]{0,14}(发布版|发布的版本|最新版本|release)' \
    && printf '%s\n' "$1" | grep -qE 'v20[0-9]{2}\.[0-9]+\.'
}
if probe_matcher '当前最新发布版是 v2020.1.1，直接钉它就行'; then
  pass "尺子有效：合成的\"现在时断言 + 旧版本号\"被抓到"
else
  fail "尺子失效：合成的坏样本没被抓到 ⇒ 上面那条核心断言可能是恒真的"
fi
BAD_FP=0
probe_matcher '发布号长这样：v2026.9.2（一个固定的标签，内容永不变）' && BAD_FP=$((BAD_FP + 1))
probe_matcher '权威出处是 Releases 页面，写这段时是 v2026.9.3' && BAD_FP=$((BAD_FP + 1))
probe_matcher '实测 v2026.9.2 的附件是 173,377 字节（历史快照，不改写）' && BAD_FP=$((BAD_FP + 1))
if [[ "${BAD_FP}" -eq 0 ]]; then
  pass "口径够窄：格式示例、带时间限定的历史陈述、历史实测记录三类合法形状都不误报"
else
  fail "口径太宽：${BAD_FP} 类合法形状被误报 ⇒ 这条守卫会天天红并被人加白名单加到失效"
fi

# 附带不变量：任何"写这段时是 vX"的带时间限定陈述，其版本号必须**真实存在**于 CHANGELOG
# （不要求等于最新版 —— 它是历史陈述，发新版后不会变成假的；但不得指向不存在的版本）。
ASOF_BAD=0
while IFS= read -r V; do
  [[ -z "${V}" ]] && continue
  grep -qF "## [${V}]" "${ROOT}/CHANGELOG.md" 2>/dev/null || ASOF_BAD=$((ASOF_BAD + 1))
done < <(grep -rhoE '写这段时是 `v[0-9]{4}\.[0-9]+(\.[0-9]+)?`' "${ROOT}/docs" --include='*.md' 2>/dev/null \
  | grep -oE 'v[0-9]{4}\.[0-9]+(\.[0-9]+)?' | sort -u)
if [[ "${ASOF_BAD}" -eq 0 ]]; then
  pass "所有\"写这段时是 vX\"的时间限定陈述都指向 CHANGELOG 里真实存在的版本节"
else
  fail "${ASOF_BAD} 个\"写这段时是 vX\"指向了 CHANGELOG 里不存在的版本节"
fi


echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
