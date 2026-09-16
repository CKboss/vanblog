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

assert_contains_in "${WEBSITE_STAGES}" "node:20-alpine" "website builder uses node:20-alpine"
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
start = text.find("FROM node:20-alpine AS website_builder")
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

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
