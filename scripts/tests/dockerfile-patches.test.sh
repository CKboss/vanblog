#!/usr/bin/env bash
# Assert the all-in-one Dockerfile ships pnpm's patch files into every stage that
# needs them, and that patched deps are declared where the install can see them.
#
# Why this exists: `pnpm install` failed the whole image build with
#   ENOENT: no such file or directory, open '/app/patches/remark-supersub@1.0.0.patch'
# because the root package.json declares pnpm.patchedDependencies while the
# website_builder stage copied package.json/lockfile/workspace but never ./patches.
# The admin stage had the mirror-image bug waiting behind it: it installs
# packages/admin standalone, so it cannot see the ROOT manifest's patch config at
# all — without its own declaration the two ESM-only remark packages stay unpatched
# and umi3's MFSU resolver dies with
#   AssertionError: filePath not found of remark-github-blockquote-alert
# File-level checks only; the real build needs Docker.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCKERFILE="${ROOT}/Dockerfile"
SCRIPT="${ROOT}/scripts/vanblog.sh"

PASS=0
FAIL=0

fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }

PY=$(command -v python3 || command -v python)
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

# ---------- 1) 清单层面的检查（一次 python 跑完，输出 ok/bad + 说明） ----------
"${PY}" - "${ROOT}" >"${TMP}" <<'PY'
import json, os, sys

root = sys.argv[1]


def manifest(rel):
    path = os.path.join(root, rel)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def emit(ok, label):
    print(("ok " if ok else "bad ") + label)


root_pkg = manifest("package.json") or {}
patches = (root_pkg.get("pnpm") or {}).get("patchedDependencies") or {}

emit(bool(patches), "root package.json declares pnpm.patchedDependencies")

# 1. 补丁文件本身必须在仓库里
for dep, rel in patches.items():
    emit(os.path.isfile(os.path.join(root, rel)), "patch file exists: %s" % rel)

# 2. lockfile 记录了同样的补丁，否则 --frozen-lockfile 直接失败
with open(os.path.join(root, "pnpm-lock.yaml"), encoding="utf-8") as fh:
    lock = fh.read()
for dep, rel in patches.items():
    emit(
        ("patchedDependencies:" in lock) and (dep + ":" in lock) and (("path: " + rel) in lock),
        "pnpm-lock.yaml records %s -> %s" % (dep, rel),
    )

# 3. 哪些 workspace 包直接依赖被补丁的包 —— 这些包所在的 stage 都必须拿得到补丁。
#    admin 那种「只 COPY 自己目录再独立 pnpm i」的 stage 看不到根 manifest，
#    所以它自己的 package.json 必须镜像同一份声明。
patched_names = {dep.split("@")[0] for dep in patches}
consumers = []
for name in sorted(os.listdir(os.path.join(root, "packages"))):
    pkg = manifest("packages/%s/package.json" % name)
    if not pkg:
        continue
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    hit = sorted(patched_names & set(deps))
    if not hit:
        continue
    consumers.append((name, hit))
    # admin 现在也走 workspace 安装（--frozen-lockfile），能看到根 manifest，
    # 所以它自己**不该**再声明一份：多写一份只会让每次 pnpm install 打一条 WARN，
    # 而且容易和根上那份不同步（历史上就是为了让独立安装生效才加的）。
    if name == "admin":
        own = (pkg.get("pnpm") or {}).get("patchedDependencies") or {}
        emit(
            not own,
            "packages/admin/package.json 不再重复声明 patchedDependencies（workspace 安装看得到根 manifest）",
        )

# 被补丁的包必须**钉死到补丁对应的精确版本**：pnpm 的 patchedDependencies 键是 name@version，
# 而 admin_builder 那层是独立安装（没有 lockfile 兜底），写成 ^2.1.0 的话上游一发布 2.1.1
# 就会解析到新版 → 补丁不匹配 → pnpm 8 直接 ERR_PNPM_PATCH_NOT_APPLIED，镜像构建失败。
for dep, rel in patches.items():
    name, _, ver = dep.partition("@")
    for consumer_name, _hit in consumers:
        pkg = manifest("packages/%s/package.json" % consumer_name) or {}
        deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
        if name in deps:
            emit(
                deps[name] == ver,
                "packages/%s pins %s to the patched version %s (found %r)"
                % (consumer_name, name, ver, deps[name]),
            )

emit(
    bool(consumers),
    "workspace packages depending on patched deps: %s"
    % ", ".join("%s(%s)" % (n, "/".join(h)) for n, h in consumers),
)
print("consumers " + " ".join(n for n, _ in consumers))
PY

while read -r status rest; do
  case "${status}" in
    ok) pass "${rest}" ;;
    bad) fail "${rest}" ;;
    consumers) echo "NOTE: patched-dep consumers: ${rest}" ;;
    "") ;;
    *) fail "unparsable checker output: ${status} ${rest}" ;;
  esac
done <"${TMP}"

# ---------- 2) 相关 stage 都要 COPY ./patches ----------
stage_body() {
  awk -v name="$1" '
    index($0, "AS " name) == 1 || $0 ~ ("^FROM .* AS " name "($| )") { keep = 1; next }
    /^FROM / { keep = 0 }
    keep { print }
  ' "${DOCKERFILE}"
}

if stage_body website_builder | grep -qE '^COPY \./patches \./patches[[:space:]]*$'; then
  pass "website_builder copies ./patches"
else
  fail "website_builder does NOT copy ./patches -> pnpm install dies with ENOENT /app/patches/*.patch"
fi

if stage_body admin_builder | grep -qE '^COPY \./patches \./patches[[:space:]]*$'; then
  pass "admin_builder copies ./patches"
else
  fail "admin_builder does NOT copy ./patches -> MFSU cannot resolve the ESM-only remark packages"
fi

# admin_builder 以前是「只拷 packages/admin + pnpm i」的**独立安装**，没有 lockfile，
# 每次构建都重新解析依赖版本。真实事故：mermaid 10.6.1 要 cytoscape/dist/cytoscape.umd.js，
# lockfile 锁的 cytoscape 3.27.0 的 exports 里有这条路径，但新解析到的版本没有 →
# `Module not found: Package path ./dist/cytoscape.umd.js is not exported`，构建失败。
# website_builder 一直用 --frozen-lockfile，所以从来没这个问题。
for f in package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json; do
  if stage_body admin_builder | grep -qE "^COPY \\./${f} "; then
    pass "admin_builder 拷了 ./${f}（workspace 安装需要）"
  else
    fail "admin_builder 没有拷 ./${f} —— 缺了它 --frozen-lockfile 装不起来"
  fi
done
if stage_body admin_builder | grep -qE '^RUN pnpm install --frozen-lockfile[[:space:]]*$'; then
  pass "admin_builder 用 --frozen-lockfile 安装（版本可复现，不会漂移）"
else
  fail "admin_builder 没有用 --frozen-lockfile —— 依赖版本会漂移（cytoscape 那次事故就是这么来的）"
fi
if stage_body admin_builder | grep -qE '^WORKDIR /app/packages/admin[[:space:]]*$'; then
  pass "admin_builder 在 packages/admin 目录下构建"
else
  fail "admin_builder 没有切到 packages/admin 目录"
fi
if grep -qE '^COPY --from=admin_builder /app/packages/admin/dist/ ' "${DOCKERFILE}"; then
  pass "runner 从 /app/packages/admin/dist/ 取后台产物（跟着 workspace 布局改了）"
else
  fail "runner 还在从旧路径 /app/dist/ 取 admin 产物，镜像里会没有后台页面"
fi

# server / runner 不依赖补丁包，拷不拷都行，只提示
for stage in server_builder runner; do
  if stage_body "${stage}" | grep -qE '^COPY \./patches \./patches[[:space:]]*$'; then
    echo "NOTE: ${stage} copies ./patches although it does not need it (harmless)"
  fi
done

# ---------- 3) COPY --from= 必须指向已声明的 stage（改阶段名时最容易漏） ----------
DECLARED=$(grep -oE '^FROM[[:space:]]+[^[:space:]]+[[:space:]]+AS[[:space:]]+[a-z0-9_]+' "${DOCKERFILE}" | awk '{print $NF}' | sort -u)
REFERENCED=$(grep -oE -- '--from=[A-Za-z0-9_]+' "${DOCKERFILE}" | sed 's/--from=//' | sort -u)
if [ -z "${REFERENCED}" ]; then
  fail "no COPY --from= found; the Dockerfile shape changed unexpectedly"
fi
for stage in ${REFERENCED}; do
  if printf '%s\n' "${DECLARED}" | grep -qx "${stage}"; then
    pass "COPY --from=${stage} resolves to a declared stage"
  else
    fail "COPY --from=${stage} has no matching 'FROM ... AS ${stage}'"
  fi
done

# ---------- 4) 阶段名小写、FROM/AS 大小写一致、ENV 用 key=value ----------
if grep -qE '^FROM[[:space:]]+[^[:space:]]+[[:space:]]+(AS[[:space:]]+[A-Z_]|as[[:space:]])' "${DOCKERFILE}"; then
  fail "stage naming inconsistent: use 'FROM <image> AS <lowercase_name>' (StageNameCasing/FromAsCasing)"
else
  pass "stage names lowercase and every FROM uses uppercase AS"
fi

if grep -qE '^ENV[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]+[^=]' "${DOCKERFILE}"; then
  fail "legacy 'ENV key value' form still present (use ENV key=value)"
else
  pass "all ENV instructions use the key=value form"
fi

# ---------- 5) 一键脚本从源码树构建（./patches 才会在构建上下文里） ----------
if grep -q 'docker build' "${SCRIPT}"; then
  pass "vanblog.sh runs docker build"
else
  fail "vanblog.sh no longer runs docker build; re-check that ./patches is inside the build context"
fi
if grep -qE 'VANBLOG_SRC_DIR|SRC_DIR' "${SCRIPT}"; then
  pass "vanblog.sh builds from the checked-out source tree (patches/ travels with it)"
else
  fail "cannot tell what build context vanblog.sh uses; verify ./patches is copied into it"
fi

# ---------- 6) 构建期环境变量不能是空串（否则 next build 在收集页面数据时炸） ----------
# Dockerfile: ARG VAN_BLOG_BUILD_SERVER → ENV VAN_BLOG_SERVER_URL，前台 utils/loadConfig.ts
# 在**模块顶层** new URL(它)。不传 build-arg 就是空串 → ERR_INVALID_URL，
# 报在 "Failed to collect page data for /about"，栈里只有 webpack chunk 编号，极难定位。
if grep -qE '^ARG VAN_BLOG_BUILD_SERVER=https?://[^[:space:]]+' "${DOCKERFILE}"; then
  pass "Dockerfile gives ARG VAN_BLOG_BUILD_SERVER a usable default"
else
  fail "ARG VAN_BLOG_BUILD_SERVER has no default -> empty ENV breaks 'next build' page-data collection"
fi

if grep -q -- '--build-arg "VAN_BLOG_BUILD_SERVER=' "${SCRIPT}"; then
  pass "vanblog.sh always passes VAN_BLOG_BUILD_SERVER"
else
  fail "vanblog.sh may skip VAN_BLOG_BUILD_SERVER; the build then gets an empty server URL"
fi
if grep -q 'if \[\[ -n "\${VANBLOG_BUILD_SERVER:-}" \]\]; then' "${SCRIPT}"; then
  fail "vanblog.sh still has the conditional build-arg branch (empty by default)"
else
  pass "vanblog.sh no longer conditions the build-arg on the user setting it"
fi

# ---------- 7) 构建资源自适应相关的 ARG（低配机器与 pnpm 源）----------
# 全局 ARG 在 FROM 之前声明；⚠️ BuildKit 规则：stage 里要用必须**再 ARG 一次**，
# 否则取到的是空值（表现是 `pnpm config set registry  -g`，然后回退到默认源）。
if grep -qE '^ARG VAN_BLOG_NPM_REGISTRY=https?://' "${DOCKERFILE}"; then
  pass "全局声明了 VAN_BLOG_NPM_REGISTRY 且带默认值"
else
  fail "缺少全局 ARG VAN_BLOG_NPM_REGISTRY=<默认源>"
fi
if grep -qE '^ARG VAN_BLOG_ADMIN_BUILD_SCRIPT=build$' "${DOCKERFILE}"; then
  pass "全局声明了 VAN_BLOG_ADMIN_BUILD_SCRIPT 且默认 build"
else
  fail "缺少全局 ARG VAN_BLOG_ADMIN_BUILD_SCRIPT=build"
fi

# 每个用到 registry 的 stage 都必须重新 ARG 一次
STAGES_WITH_REGISTRY=$(grep -c 'pnpm config set registry \${VAN_BLOG_NPM_REGISTRY}' "${DOCKERFILE}")
STAGES_WITH_ARG=$(awk '/^FROM /{stage=$0; has=0} /^ARG VAN_BLOG_NPM_REGISTRY$/{has=1}
  /pnpm config set registry/{if (has) print stage}' "${DOCKERFILE}" | wc -l)
if [[ "${STAGES_WITH_REGISTRY}" -ge 4 && "${STAGES_WITH_REGISTRY}" == "${STAGES_WITH_ARG}" ]]; then
  pass "${STAGES_WITH_REGISTRY} 处 registry 设置都在重新声明过 ARG 的 stage 里"
else
  fail "有 stage 用了 registry 变量却没重新 ARG（会取到空值）：用了 ${STAGES_WITH_REGISTRY} 处，声明齐的 ${STAGES_WITH_ARG} 处"
fi

# admin 的构建脚本必须可切换（低内存机器用 build:lowmem）
if grep -qE '^RUN pnpm run \$\{VAN_BLOG_ADMIN_BUILD_SCRIPT\}$' "${DOCKERFILE}"; then
  pass "admin_builder 用 VAN_BLOG_ADMIN_BUILD_SCRIPT 决定构建档位"
else
  fail "admin_builder 没有用 VAN_BLOG_ADMIN_BUILD_SCRIPT（低内存机器没法降堆）"
fi

# 两档构建脚本都得存在，且都带堆上限（cross-env 会整体替换 NODE_OPTIONS，见 §7.24）
for script in build "build:lowmem"; do
  if "${PY}" - "${ROOT}/packages/admin/package.json" "${script}" <<'PYCHK'
import json, sys
d = json.load(open(sys.argv[1]))
cmd = d.get("scripts", {}).get(sys.argv[2], "")
ok = "umi build" in cmd and "--max_old_space_size=" in cmd and "--openssl-legacy-provider" in cmd
raise SystemExit(0 if ok else 1)
PYCHK
  then
    pass "packages/admin 的 ${script} 脚本存在且带堆上限与 openssl-legacy-provider"
  else
    fail "packages/admin 缺少可用的 ${script} 脚本"
  fi
done

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
