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
    if name == "admin":
        own = (pkg.get("pnpm") or {}).get("patchedDependencies") or {}
        for dep, rel in patches.items():
            emit(
                own.get(dep) == rel,
                "packages/admin/package.json mirrors patchedDependencies %s -> %s" % (dep, rel),
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

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
