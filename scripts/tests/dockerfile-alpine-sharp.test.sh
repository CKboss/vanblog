#!/usr/bin/env bash
# Assert official all-in-one Dockerfile can install sharp on Alpine (#413).
# File-level checks only; the companion install script needs Docker.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCKERFILE="${ROOT}/Dockerfile"
WEBSITE_PKG="${ROOT}/packages/website/package.json"
SERVER_PKG="${ROOT}/packages/server/package.json"
LOCKFILE="${ROOT}/pnpm-lock.yaml"

PASS=0
FAIL=0

fail() {
  echo "FAIL: $*"
  FAIL=$((FAIL + 1))
}

pass() {
  echo "PASS: $*"
  PASS=$((PASS + 1))
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -q -- "${needle}" "${file}"; then
    pass "${label}"
  else
    fail "${label} (missing in ${file}: ${needle})"
  fi
}

assert_file_not_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -q -- "${needle}" "${file}"; then
    fail "${label} (unexpected in ${file}: ${needle})"
  else
    pass "${label}"
  fi
}

# Isolate the website_builder stage so ADMIN/SERVER/runner lines cannot
# satisfy the assertions.
WEBSITE_STAGES="$(awk '
  BEGIN { keep=0 }
  $0 ~ /^FROM / { keep=0 }
  $0 ~ /^FROM .* AS website_builder/ { keep=1 }
  keep { print }
' "${DOCKERFILE}")"

if [[ -z "${WEBSITE_STAGES}" ]]; then
  fail "Dockerfile defines website_builder stage"
else
  pass "Dockerfile defines website_builder stage"
fi

assert_contains_in() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    pass "${label}"
  else
    fail "${label} (missing: ${needle})"
  fi
}

assert_contains_in "${WEBSITE_STAGES}" "node:" "website builder 用官方 node:<ver>-alpine 基础镜像"
assert_contains_in "${WEBSITE_STAGES}" "SHARP_IGNORE_GLOBAL_LIBVIPS=1" "website builder ignores Alpine system libvips"
# ⚠️⚠️ 这几条以前是**假绿**：它们在整个 stage 文本里搜 "vips-dev" / "fftw-dev"，
# 而 stage 里恰好有一行注释写着「去掉 vips-dev/fftw-dev：sharp 用 musl 预编译包」——
# 于是断言匹配到的是**说明为什么没有装**的那句注释，结论正好反了。
# 这个坑本仓库已经踩过很多次（"守卫断言匹配到了描述陷阱的注释"），
# 规矩：断言前**先剥注释**，并且只针对真正的那条 `RUN apk add` 行。
WEBSITE_APK_LINE="$(printf '%s\n' "${WEBSITE_STAGES}" |
  sed 's|^[[:space:]]*#.*||' |
  grep -E '^[[:space:]]*RUN apk add' | head -1)"

if [[ -n "${WEBSITE_APK_LINE}" ]]; then
  pass "website builder 有一条 RUN apk add（${WEBSITE_APK_LINE##*apk add}）"
else
  fail "website builder 里找不到 RUN apk add 行"
fi

for pkg in libc6-compat python3 make g++; do
  assert_contains_in "${WEBSITE_APK_LINE}" "${pkg}" "apk add 装了 ${pkg}（node-gyp 兜底 + musl 兼容）"
done
for pkg in vips-dev fftw-dev; do
  if printf '%s' "${WEBSITE_APK_LINE}" | grep -qF -- "${pkg}"; then
    fail "apk add 不该再装 ${pkg}（sharp 走 musl 预编译包，装了会白白拖慢构建）"
  else
    pass "apk add 没有 ${pkg}（sharp 用预编译二进制）"
  fi
done
assert_contains_in "${WEBSITE_STAGES}" "pnpm install --frozen-lockfile" "website builder keeps frozen lockfile"
assert_contains_in "${WEBSITE_STAGES}" "pnpm@8.11.0" "website builder pins pnpm 8.11.0 (repo packageManager, not latest)"

# 同上：注释里出现 vips-dev 不算数，只看真正的 apk 行
if printf '%s' "${WEBSITE_APK_LINE}" | grep -q "apk add"; then
  pass "website builder 确实在镜像里装系统包（而不是靠源码编译 sharp）"
else
  fail "website builder 的 apk add 行没解析出来"
fi

# ENV must be set before pnpm install in the website builder stage.
python3 - "${DOCKERFILE}" <<'PY' && pass "SHARP_IGNORE_GLOBAL_LIBVIPS is set before website pnpm install" || fail "SHARP_IGNORE_GLOBAL_LIBVIPS is set before website pnpm install"
import sys
text = open(sys.argv[1], encoding="utf-8").read()
start = text.find("AS website_builder")
end = text.find("\nFROM ", start + 1)
if start < 0 or end < 0:
    raise SystemExit(1)
stage = text[start:end]
env_at = stage.find("SHARP_IGNORE_GLOBAL_LIBVIPS=1")
install_at = stage.find("pnpm install --frozen-lockfile")
if env_at < 0 or install_at < 0 or env_at > install_at:
    raise SystemExit(1)
PY

assert_file_not_contains "${DOCKERFILE}" "pnpm@latest" "Dockerfile does not activate floating pnpm@latest"
# ── sharp 的版本约定（2026-09 起）──────────────────────────────────────────
# #413 的老修法是"把 sharp 钉死在 0.32.6"，因为那一版的安装脚本里有人给 musl 版本号
# （形如 1.2.4_git20230717，不是合法 semver）加了 semverCoerce 兜底。
# sharp 0.33 起**安装脚本整个没了**：预编译二进制改成 npm 的 optionalDependencies
# （@img/sharp-<平台> + @img/sharp-libvips-<平台>），装包时不下载 libvips、不跑脚本，
# 于是那条崩溃路径结构性消失，也就不需要再靠钉版本绕开它（代价是 0.32 那一串
# libvips/libheif CVE 只能干看着）。所以现在钉的是"必须 >= 0.33"而不是"必须 == 0.32.6"。
SHARP_TOO_OLD="$(python3 - "${WEBSITE_PKG}" "${SERVER_PKG}" <<'SHARPPY'
import json, re, sys
bad = []
for path in sys.argv[1:]:
    spec = json.load(open(path, encoding="utf-8"))["dependencies"].get("sharp", "")
    nums = [int(x) for x in re.findall(r"\d+", spec)[:2]] + [0, 0]
    if (nums[0], nums[1]) < (0, 33):
        bad.append("%s -> %s" % (path, spec))
print(",".join(bad))
SHARPPY
)"
if [[ -z "${SHARP_TOO_OLD}" ]]; then
  pass "website 与 server 声明的 sharp 都 >= 0.33（预编译走 optionalDependencies，不再有会崩的安装脚本）"
else
  fail "sharp 低于 0.33，会带回 #413 那个安装脚本：${SHARP_TOO_OLD}"
fi
assert_file_not_contains "${WEBSITE_PKG}" '"sharp": "0.32.6"' "website 不再钉死 0.32.6（那版带会在 Alpine 崩的安装脚本）"
assert_file_not_contains "${WEBSITE_PKG}" '"sharp": "^0.31.' "website no longer depends on sharp 0.31"
assert_file_not_contains "${LOCKFILE}" "/sharp@0.31.3" "lockfile no longer pins sharp 0.31.3"
assert_file_not_contains "${LOCKFILE}" "/sharp@0.32." "lockfile 里不再有 0.32.x"
assert_file_contains "${LOCKFILE}" "/sharp@0.3" "lockfile resolves a sharp 0.3x"
# Alpine 运行镜像靠这两个 optionalDependency 拿到 musl 预编译产物（不再从 GitHub 下 libvips）
assert_file_contains "${LOCKFILE}" "@img/sharp-linuxmusl-x64" "lockfile 里有 musl 版 sharp 预编译包（Alpine 运行镜像靠它）"
assert_file_contains "${LOCKFILE}" "@img/sharp-libvips-linuxmusl-x64" "lockfile 里有 musl 版 libvips 预编译包"

# runner needs musl compat for Next/sharp native binaries copied from the builder.
runner_STAGE="$(awk '
  BEGIN { keep=0 }
  $0 ~ /^FROM / { keep=0 }
  $0 ~ /^FROM .* AS runner/ { keep=1 }
  keep { print }
' "${DOCKERFILE}")"
assert_contains_in "${runner_STAGE}" "libc6-compat" "runner installs libc6-compat for sharp/next native binaries"
assert_contains_in "${runner_STAGE}" "libavif-apps" "runner installs libavif-apps (avifenc) for AVIF fallback"
assert_contains_in "${runner_STAGE}" "libwebp-tools" "runner still installs libwebp-tools (cwebp)"
assert_contains_in "${runner_STAGE}" "COPY --from=website_builder" "runner still copies website from website_builder"

# ── 供应链：cli 与 waline 两棵树必须走 lockfile（2026-09-19）────────────────────
# 以前这两处是**孤立目录里的 `pnpm i`**：构建上下文里没有 pnpm-lock.yaml，也没有根 package.json。
# 后果不只是"不可复现"，更要紧的是**根 package.json 的 pnpm.overrides 对它们完全不生效** ——
# 而 waline 子树里正好有带 critical/high 通告的包（mysql2 / protobufjs / koa / tar-fs）。
# 也就是说：仓库里用 override 把它们抬到安全版本，镜像里 /app/waline/node_modules 装的仍是旧的，
# 而那份 node_modules 会被拷进 runner 当子进程跑。admin/server/website 三层早就修过同一个错误
# （Dockerfile 自己的注释里记着），这两处漏了。
WALINE_STAGE="$(awk '
  BEGIN { keep=0 }
  $0 ~ /^FROM / { keep=0 }
  $0 ~ /^FROM .* AS waline_builder/ { keep=1 }
  keep { print }
' "${DOCKERFILE}")"
CLI_STAGE="$(awk '
  BEGIN { keep=0 }
  $0 ~ /^FROM / { keep=0 }
  $0 ~ /^FROM .* AS cli_builder/ { keep=1 }
  keep { print }
' "${DOCKERFILE}")"
# ⚠️ 反证：上面两个 stage 文本必须非空，否则所有 absence 断言都会假通过（空串什么都不含）
assert_contains_in "${WALINE_STAGE}" "waline_builder" "（反证）waline_builder stage 被正确切出来了，不是空串"
assert_contains_in "${CLI_STAGE}" "cli_builder" "（反证）cli_builder stage 被正确切出来了，不是空串"

# ⚠️⚠️ 断言前**必须剥注释** —— 这是本仓库第 7 次踩同一个坑（前 6 次记在 AGENTS.md）：
#    解释"为什么不能这么写"的注释里，必然写着那个被禁的字符串。这次我自己就中了两发：
#    waline 的注释写着「这一层**不能**加 --ignore-scripts」、runner 的注释写着
#    「以前还装着 nss-tools …已删」，两条 absence 断言当场假红。
#    ⇒ 所有针对 Dockerfile 的 contains / not-contains 断言都打在剥过注释的文本上。
#    （Dockerfile 的注释都是整行 #，没有行尾注释语义，所以按整行删是安全的。）
strip_df_comments() { printf '%s\n' "$1" | sed '/^[[:space:]]*#/d'; }
WALINE_CODE="$(strip_df_comments "${WALINE_STAGE}")"
CLI_CODE="$(strip_df_comments "${CLI_STAGE}")"
RUNNER_CODE="$(strip_df_comments "${runner_STAGE}")"

# ⚠️ 不用 `for pair in "name|${STAGE}"` 这种打包写法：stage 文本里本身就有 `|`
#    （例如 `du -sh /deploy/node_modules | cut -f1`），按 `|` 切会把 stage 截断，
#    于是断言打在残缺文本上 —— 可能假通过，也可能假失败。直接写两遍。
for stage_name in waline cli; do
  if [[ "${stage_name}" == "waline" ]]; then stage="${WALINE_CODE}"; else stage="${CLI_CODE}"; fi
  assert_contains_in "${stage}" "COPY ./pnpm-lock.yaml ./" "${stage_name}_builder 把 pnpm-lock.yaml 拷进了构建上下文"
  assert_contains_in "${stage}" "COPY ./pnpm-workspace.yaml ./" "${stage_name}_builder 拷了 pnpm-workspace.yaml（否则 --filter 找不到 workspace）"
  assert_contains_in "${stage}" "COPY ./package.json ./" "${stage_name}_builder 拷了**根** package.json（pnpm.overrides 在这里，缺了 override 就不生效）"
  assert_contains_in "${stage}" "pnpm install --frozen-lockfile" "${stage_name}_builder 用 --frozen-lockfile（版本必须与仓库锁的一致）"
  assert_contains_in "${stage}" "deploy --prod" "${stage_name}_builder 用 pnpm deploy 导出自包含产物（runner 只拷这一份就能跑）"
done
# ⚠️ waline **不能**加 --ignore-scripts：@waline/vercel 硬依赖 sqlite3，musl 上没有预编译包，
#    必须现场 node-gyp 编译；关掉脚本 = waline 子进程启动即崩。cli 反过来：mongodb 是纯 JS，
#    加 --ignore-scripts 正好把"依赖被投毒时在构建期以 root 跑 postinstall"这条路关掉。
if printf '%s' "${WALINE_CODE}" | grep -q -- '--ignore-scripts'; then
  fail "waline_builder 加了 --ignore-scripts：sqlite3 编不出来，waline 子进程会启动即崩"
else
  pass "waline_builder 没有 --ignore-scripts（sqlite3 必须现场编译）"
fi
assert_contains_in "${CLI_CODE}" "--ignore-scripts" "cli_builder 用 --ignore-scripts（mongodb 是纯 JS，顺手关掉构建期 postinstall 这条路）"
assert_contains_in "${WALINE_CODE}" "vanilla.js" "waline_builder 构建期就验证 vanilla.js 在（server 按 ../waline/node_modules/@waline/vercel/vanilla.js 找它）"

# runner 侧：不许再现场装依赖，两棵树的 node_modules 都来自 builder 的 deploy 产物
if printf '%s' "${RUNNER_CODE}" | grep -qE '^RUN pnpm i'; then
  fail "runner 里还有 'RUN pnpm i'：那是不走 lockfile 的现场解析，正是这次要消除的东西"
else
  pass "runner 不再现场 pnpm i（cli 与 waline 的依赖都来自各自 builder 的 frozen-lockfile 产物）"
fi
assert_contains_in "${RUNNER_CODE}" "COPY --from=cli_builder /deploy/node_modules" "runner 从 cli_builder 的 deploy 产物拷 cli 依赖"
assert_contains_in "${RUNNER_CODE}" "COPY --from=waline_builder /deploy/node_modules" "runner 从 waline_builder 的 deploy 产物拷 waline 依赖"
assert_contains_in "${RUNNER_CODE}" "WORKDIR /app/cli" "cli 仍然落在 /app/cli（vanblog.sh 的 reset_https 兜底与 README 都按这个绝对路径调它）"
# ⚠️ runner 里的 corepack/pnpm 不能顺手删掉：运行期「流水线」功能会 pnpm add 装依赖
assert_contains_in "${RUNNER_CODE}" "corepack prepare pnpm@8.11.0" "runner 仍装着 pnpm（运行期流水线要 pnpm add，不是为了构建期安装）"

# ── nss-tools：白装的包（certutil 全仓库没人用，caddy 也不依赖它）──────────────
# 实测证据：`apk info -R caddy` → 只依赖 ca-certificates / /bin/sh / so:libc.musl；
#          `apk info -r nss-tools` → 没有任何包依赖它；仓库里 certutil/pk12util/libnss 零命中。
if printf '%s' "${RUNNER_CODE}" | grep -qF 'nss-tools'; then
  fail "runner 又装回了 nss-tools（688 KiB + 攻击面；certutil 全仓库没人用，caddy 只依赖 ca-certificates）"
else
  pass "runner 没有装 nss-tools（caddy 只依赖 ca-certificates，certutil 全仓库零调用）"
fi
assert_contains_in "${RUNNER_CODE}" "caddy" "（反证）runner 的 apk 行确实被切出来了，nss-tools 那条 absence 断言不是在对空串说话"

# ── OCI 版本标签：别让 CI 用"第一个标签"去猜（实测已发布镜像的 version 字面是 latest）──
assert_contains_in "${RUNNER_CODE}" 'LABEL org.opencontainers.image.version="${VAN_BLOG_VERSIONS}"' \
  "镜像自带 org.opencontainers.image.version，且与 ENV VAN_BLOG_VERSION 同源（本地构建也有正确版本标签）"

# ── 构建产物瘦身：.map / .d.ts 不进发布镜像 ──────────────────────────────────
# 两条约束，缺一不可：
#   ① `.map` 由 tsconfig.build.json 关 sourceMap（不生成）；`.d.ts` 只能**生成后删** ——
#      因为 packages/server/tsconfig.json 有 composite:true，TS 不允许复合项目关 declaration
#      （TS6304），而这个错误只在镜像构建里暴露（本地 tsc --noEmit 不产出文件，所以不报）。
#   ② 删必须发生在 **server_builder**，不能在 runner 里"COPY 完再 rm"：那样文件已经在 COPY
#      那一层里，后续层只是加个 whiteout 标记，**镜像体积一点都不会变小**。
SERVER_STAGE="$(awk '
  BEGIN { keep=0 }
  $0 ~ /^FROM / { keep=0 }
  $0 ~ /^FROM .* AS server_builder/ { keep=1 }
  keep { print }
' "${DOCKERFILE}")"
SERVER_CODE="$(strip_df_comments "${SERVER_STAGE}")"
assert_contains_in "${SERVER_STAGE}" "server_builder" "（反证）server_builder stage 被正确切出来了，不是空串"
assert_contains_in "${SERVER_CODE}" "find dist \( -name '*.d.ts' -o -name '*.map' \) -delete" \
  "server_builder 在构建后删掉 dist 里的 .d.ts 与 .map（发生在 runner COPY 之前，所以体积真的会变小）"
assert_contains_in "${SERVER_CODE}" "find dist -name 'main.js'" \
  "删完还自检入口 main.js 仍在（别等容器起不来才发现删多了）"
if printf '%s' "${RUNNER_CODE}" | grep -qE "rm .*\.d\.ts|rm .*\*\.map|-name '\*\.map' -delete"; then
  fail "runner 里出现了 COPY 之后再删 .map/.d.ts 的写法：那样省不下体积（文件已在 COPY 层里，只会多一个 whiteout）"
else
  pass "runner 没有用『COPY 完再 rm』这种省不下体积的写法"
fi
TSCONFIG_BUILD="${ROOT}/packages/server/tsconfig.build.json"
assert_file_contains "${TSCONFIG_BUILD}" '"sourceMap": false' "tsconfig.build.json 关掉了 sourceMap（生产构建不出 .map）"
if grep -q '"declaration": false' "${TSCONFIG_BUILD}"; then
  fail "tsconfig.build.json 关了 declaration：tsconfig.json 有 composite:true，nest build 会报 TS6304（复合项目不允许关 declaration emit）"
else
  pass "tsconfig.build.json 没有关 declaration（composite:true 下关了会 TS6304，所以改成构建后删 .d.ts）"
fi

# ── 可见水印要的系统字体（2026-09 起）───────────────────────────────────────
# 水印文字是 SVG <text>，由 sharp 内置的 libvips → librsvg → pango → fontconfig 栅格化，
# 要的是**系统字体**（不是 npm 包，也不是前台自托管那份只给浏览器用的 woff2）。
# 缺字体不是"渲染成空白"：零字体的 node:24-alpine 实测画**满屏 .notdef 豆腐块**，
# 所以 utils/watermark.ts 改成逐字符集探测、探不过就 WARN + 返回原图 ——
# 也就是说**镜像里少了这三个包，可见水印在生产环境等于没有这个功能**（上传不失败，一张也盖不上）。
WATERMARK_TS="${ROOT}/packages/server/src/utils/watermark.ts"
WATERMARK_SVG_TS="${ROOT}/packages/server/src/utils/watermarkSvg.ts"

# ⚠️ 断言必须打在**真正那条 apk add 命令**上，不能打在 runner stage 的文本上：
# stage 里就有一段注释写着「fontconfig ttf-dejavu wqy-zenhei：可见水印要的」，
# 直接 grep stage 会匹配到那段解释为什么要装的注释 —— 与本文件上面 vips-dev 那次假绿同一个坑。
RUNNER_APK="$(python3 - "${DOCKERFILE}" <<'PYAPK'
import sys
text = open(sys.argv[1], encoding="utf-8").read()
start = text.find("AS runner")
if start < 0:
    raise SystemExit(1)
lines = text[start:].split("\n")
out, collecting = [], False
for ln in lines:
    s = ln.strip()
    if not collecting:
        if s.startswith("RUN") and "apk add" in s:
            collecting = True
        else:
            continue
    out.append(ln.split("#")[0])          # 剥掉注释（含续行里的 shell 注释）
    if not ln.rstrip().endswith("\\"):    # 续行结束
        break
print(" ".join(out))
PYAPK
)"

if [[ -n "${RUNNER_APK}" ]]; then
  pass "解析出了 runner 真正的那条 apk add 命令（不是注释）"
else
  fail "解析不出 runner 的 apk add 命令 —— 下面几条字体断言会变成空断言"
fi
for pkg in fontconfig ttf-dejavu wqy-zenhei; do
  assert_contains_in "${RUNNER_APK}" "${pkg}" "runner 的 apk add 真的装了 ${pkg}（可见水印的系统字体）"
done

# 漂移守卫：代码里那条"去装这些包"的 WARN 与镜像实际装的必须是同一批，
# 且字体栈里点名的家族要有对应的包（否则探测过了也渲染不出对应字形）。
python3 - "${WATERMARK_TS}" "${WATERMARK_SVG_TS}" "${RUNNER_APK}" <<'PYFONT' && pass "水印代码点名的字体包/字体族与镜像实际装的一致" || fail "水印代码点名的字体包/字体族与镜像实际装的不一致（改了一边忘了另一边）"
import re, sys

watermark = open(sys.argv[1], encoding="utf-8").read()
svg = open(sys.argv[2], encoding="utf-8").read()
apk = sys.argv[3]

# 1) 代码里叫用户去装的那批包（FONT_INSTALL_HINT 里的 apk add 行）
hint = re.search(r"apk add --no-cache ([^'\"（]+)", watermark)
if not hint:
    raise SystemExit(1)
hinted = set(hint.group(1).split())
expected = {"fontconfig", "ttf-dejavu", "wqy-zenhei"}
if hinted != expected:
    raise SystemExit(1)

# 2) 镜像里真的装了这三个（apk 命令行，已剥注释）
if not expected <= set(apk.split()):
    raise SystemExit(1)

# 3) 字体栈里点名的家族要有对应的包：DejaVu Sans ← ttf-dejavu，WenQuanYi Zen Hei ← wqy-zenhei
#    （Noto Sans CJK SC 是故意不装的：font-noto-cjk 太大，pango 会逐字符回落到 wqy）
family = re.search(r'DEFAULT_WATERMARK_FONT_FAMILY\s*=\s*\n?\s*"([^"]+)"', svg)
if not family:
    raise SystemExit(1)
for name in ("DejaVu Sans", "WenQuanYi Zen Hei"):
    if name not in family.group(1):
        raise SystemExit(1)
PYFONT

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
