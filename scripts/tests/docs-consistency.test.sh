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

# ---------- 4) 安装/备份文档提到的 VANBLOG_* 变量，必须真的存在 ----------
# ⚠️ "存在"的判据是三处之一：一键脚本、编排模板、**或 server 源码**。
# 只认前两处不够：`docs/advanced/backup.md` 会写恢复侧的 server 变量
# （`VANBLOG_RESTORE_PRUNE_STATIC` / `VANBLOG_RESTORE_DROP_ABSENT_COLLECTIONS`，定义在
# packages/server/src/utils/fullBackup.ts）—— 它们是真的、也确实该写进编排的 `environment:`，
# 但脚本自己从来不读 ⇒ 只查脚本会把真变量判成"编造的"。
# 这条守卫要抓的是"文档写了一个任何地方都不存在的变量名"，所以语料要覆盖三处。
DOC_VARS="$(grep -rhoE 'VANBLOG_[A-Z_]+' \
  "${ROOT}/docs/guide/script.snippet.md" "${ROOT}/docs/guide/backup.md" \
  "${ROOT}/docs/guide/update.md" "${ROOT}/docs/advanced/backup.md" \
  "${ROOT}/docs/advanced/local-build.md" 2>/dev/null | sort -u)"
COMPOSE_TPL="${ROOT}/docker-compose/docker-compose-template.yml"
SERVER_SRC="${ROOT}/packages/server/src"
# ⚠️ 还要收 `scripts/vanblog-drill.sh`：`VANBLOG_BACKUP_STALE_DAYS` / `_REVERIFY_DAYS` /
#    那 19 个 `VANBLOG_DRILL_*` 旋钮都定义在它里面，而 backup.md / env.md 会提到它们。
#    漏掉的结果是**真变量被判成编造的**（本轮两个代理各踩了一次）。
DRILL_SCRIPT="${ROOT}/scripts/vanblog-drill.sh"
unknown=""
for v in ${DOC_VARS}; do
  if grep -qF "${v}" "${SCRIPT}" || grep -qF "${v}" "${COMPOSE_TPL}" ||
    grep -qF "${v}" "${DRILL_SCRIPT}" ||
    grep -rqF --include='*.ts' "${v}" "${SERVER_SRC}" 2>/dev/null; then
    continue
  fi
  unknown="${unknown} ${v}"
done
if [[ -z "${unknown}" ]]; then
  pass "文档里的 VANBLOG_* 变量都真实存在（$(printf '%s' "${DOC_VARS}" | wc -w) 个；脚本 / 编排模板 / server 源码任一即算）"
else
  fail "文档提到不存在的变量（脚本、编排模板、server 源码里都找不到）:${unknown}"
fi

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

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
