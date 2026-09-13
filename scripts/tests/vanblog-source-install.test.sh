#!/usr/bin/env bash
# 一键安装装的是「本分支源码构建出来的镜像」，不是上游的 mereith/van-blog:latest。
# 用假的 git / docker / docker-compose 跑，不联网、不碰真实 daemon。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"
PUBLIC_SCRIPT="${ROOT}/docs/.vuepress/public/vanblog.sh"
TEMPLATE_FIXTURE="${ROOT}/docker-compose/docker-compose-template.yml"

PASS=0
FAIL=0

fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }

assert_eq() {
  if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi
}
assert_contains() {
  if [[ "$1" == *"$2"* ]]; then pass "$3"; else
    fail "$3 (missing: $2)"; echo "---- output ----"; echo "$1"; echo "----------------"
  fi
}
assert_not_contains() {
  if [[ "$1" != *"$2"* ]]; then pass "$3"; else
    fail "$3 (unexpected: $2)"; echo "---- output ----"; echo "$1"; echo "----------------"
  fi
}
assert_file_contains() {
  if grep -q -- "$2" "$1" 2>/dev/null; then pass "$3"; else fail "$3 (missing in $1: $2)"; fi
}
assert_file_not_contains() {
  if grep -q -- "$2" "$1" 2>/dev/null; then fail "$3 (unexpected in $1: $2)"; else pass "$3"; fi
}

setup_case() {
  TEST_DIR="$(mktemp -d)"
  mkdir -p "${TEST_DIR}/bin" "${TEST_DIR}/vanblog"
  CMDLOG="${TEST_DIR}/commands.log"
  : >"${CMDLOG}"

  # 假 git：clone 时造出一个带 Dockerfile 与 compose 模板的源码目录
  cat >"${TEST_DIR}/bin/git" <<'GIT'
#!/usr/bin/env bash
echo "git $*" >>"${CMDLOG}"
sub="$1"; shift || true
case "${sub}" in
  clone)
    dest="${!#}"
    mkdir -p "${dest}/docker-compose"
    echo "FROM scratch" >"${dest}/Dockerfile"
    cp "${TEMPLATE_FIXTURE}" "${dest}/docker-compose/docker-compose-template.yml"
    mkdir -p "${dest}/.git"
    ;;
  -C)
    dir="$1"; shift
    mkdir -p "${dir}/.git" "${dir}/docker-compose"
    [[ -f "${dir}/Dockerfile" ]] || echo "FROM scratch" >"${dir}/Dockerfile"
    [[ -f "${dir}/docker-compose/docker-compose-template.yml" ]] ||
      cp "${TEMPLATE_FIXTURE}" "${dir}/docker-compose/docker-compose-template.yml"
    ;;
esac
exit 0
GIT

  # 假 docker：build 成功；inspect 之类一律 0
  cat >"${TEST_DIR}/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
echo "docker $*" >>"${CMDLOG}"
if [[ "${DOCKER_BUILD_FAIL:-0}" == "1" && "$1" == "build" ]]; then
  exit 1
fi
exit 0
DOCKER

  cat >"${TEST_DIR}/bin/docker-compose" <<'COMPOSE'
#!/usr/bin/env bash
echo "docker-compose $*" >>"${CMDLOG}"
exit 0
COMPOSE

  chmod +x "${TEST_DIR}/bin/git" "${TEST_DIR}/bin/docker" "${TEST_DIR}/bin/docker-compose"
  export CMDLOG TEMPLATE_FIXTURE
  export PATH="${TEST_DIR}/bin:${PATH}"
}

source_script() {
  export VANBLOG_SKIP_MAIN=1
  export VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
  export VANBLOG_DATA_PATH="${TEST_DIR}/vanblog/data"
  unset VANBLOG_USE_UPSTREAM_IMAGE VANBLOG_REPO VANBLOG_BRANCH VANBLOG_SRC_DIR VANBLOG_IMAGE_TAG
  # shellcheck disable=SC1090
  source "${SCRIPT}"
}

# --- 默认值：装的就是 CKboss/vanblog 的 dev/dsh ---
setup_case
source_script
assert_eq "${VANBLOG_REPO}" "https://github.com/CKboss/vanblog.git" "默认仓库是本 fork"
assert_eq "${VANBLOG_BRANCH}" "dev/dsh" "默认分支是 dev/dsh"
assert_eq "${VANBLOG_SRC_DIR}" "${TEST_DIR}/vanblog/src" "默认源码目录在安装目录下"
assert_eq "${VANBLOG_IMAGE_TAG}" "vanblog:dev-dsh" "默认本地镜像 tag"
assert_eq "${VANBLOG_USE_UPSTREAM_IMAGE}" "false" "默认不使用官方镜像"
if use_upstream_image; then fail "默认应走源码构建"; else pass "默认应走源码构建"; fi
assert_contains "$(compose_template_urls | head -1)" "CKboss/vanblog/dev/dsh" "编排模板优先取本分支 raw"
assert_contains "$(script_urls | head -1)" "CKboss/vanblog/dev/dsh" "脚本自更新优先取本分支 raw"

# --- 克隆源码：全新安装走 git clone --depth 1 --branch ---
setup_case
source_script
OUT="$(clone_or_update_source 2>&1)"
assert_eq "$?" "0" "克隆源码成功"
assert_file_contains "${CMDLOG}" "clone --depth 1 --branch dev/dsh https://github.com/CKboss/vanblog.git" "按分支浅克隆本 fork"
assert_contains "${OUT}" "源码版本" "打印源码版本"
if [[ -f "${VANBLOG_SRC_DIR}/Dockerfile" ]]; then pass "源码目录里有 Dockerfile"; else fail "源码目录里没有 Dockerfile"; fi

# --- 已有源码目录：fetch + checkout -f FETCH_HEAD（不 pull，避免被本地改动卡住）---
setup_case
source_script
mkdir -p "${VANBLOG_SRC_DIR}/.git"
OUT="$(clone_or_update_source 2>&1)"
assert_eq "$?" "0" "更新源码成功"
assert_file_contains "${CMDLOG}" "fetch --depth 1 origin dev/dsh" "更新时按分支 fetch"
assert_file_contains "${CMDLOG}" "checkout -f FETCH_HEAD" "更新时强制切到分支 tip"
assert_not_contains "$(cat "${CMDLOG}")" " clone " "已有源码目录就不再 clone"

# --- 构建镜像：tag 与版本参数都对 ---
setup_case
source_script
clone_or_update_source >/dev/null 2>&1
VANBLOG_SRC_COMMIT="abc1234"
OUT="$(build_vanblog_image 2>&1)"
assert_eq "$?" "0" "构建镜像成功"
assert_file_contains "${CMDLOG}" "build --build-arg VAN_BLOG_VERSIONS=dev/dsh-abc1234 -t vanblog:dev-dsh" "构建参数带分支与 commit"
assert_contains "${OUT}" "镜像构建完成" "构建成功有提示"

# --- 没有 Dockerfile 就不要瞎构建 ---
setup_case
source_script
mkdir -p "${VANBLOG_SRC_DIR}"
OUT="$(build_vanblog_image 2>&1)"
if [[ $? -ne 0 ]]; then pass "缺 Dockerfile 时构建失败"; else fail "缺 Dockerfile 时构建失败"; fi
assert_contains "${OUT}" "没有 Dockerfile" "缺 Dockerfile 有明确报错"
assert_not_contains "$(cat "${CMDLOG}")" "docker build" "缺 Dockerfile 时不会调用 docker build"

# --- prepare_vanblog_image：把 Docker_IMG 换成本地 tag ---
setup_case
source_script
Docker_IMG="mereith/van-blog:latest"
prepare_vanblog_image >/dev/null 2>&1
assert_eq "$?" "0" "准备镜像成功"
assert_eq "${Docker_IMG}" "vanblog:dev-dsh" "Docker_IMG 换成本地构建的 tag"
assert_file_contains "${CMDLOG}" "git" "源码模式会取源码"
assert_file_contains "${CMDLOG}" "docker build" "源码模式会本地构建"

# --- 构建失败必须返回非 0（安装/更新会据此中止，不会拿旧镜像糊弄）---
setup_case
source_script
export DOCKER_BUILD_FAIL=1
OUT="$(prepare_vanblog_image 2>&1)"
RC=$?
unset DOCKER_BUILD_FAIL
if [[ ${RC} -ne 0 ]]; then pass "构建失败时 prepare 返回非 0"; else fail "构建失败时 prepare 返回非 0"; fi

# --- 官方镜像模式：不联网、不构建，保持 Docker_IMG 不变 ---
setup_case
source_script
export VANBLOG_USE_UPSTREAM_IMAGE=true
Docker_IMG="mereith/van-blog:latest"
OUT="$(prepare_vanblog_image 2>&1)"
assert_eq "$?" "0" "官方镜像模式直接成功"
assert_eq "${Docker_IMG}" "mereith/van-blog:latest" "官方镜像模式不改 Docker_IMG"
assert_contains "${OUT}" "官方镜像" "官方镜像模式有提示"
if [[ -s "${CMDLOG}" ]]; then fail "官方镜像模式不该调用 git/docker"; else pass "官方镜像模式不该调用 git/docker"; fi
unset VANBLOG_USE_UPSTREAM_IMAGE

# --- 生成的编排文件里写的是本地 tag（斜杠不再被转义）---
setup_case
source_script
prepare_vanblog_image >/dev/null 2>&1
cp "${TEMPLATE_FIXTURE}" "${VANBLOG_BASE_PATH}/docker-compose-template.yaml"
vanblog_email="a@b.com" vanblog_http_port=80 vanblog_https_port=443
sed -i "s/vanblog_data_path/\/var\/vanblog\/data/g" "${VANBLOG_BASE_PATH}/docker-compose-template.yaml"
cp "${VANBLOG_BASE_PATH}/docker-compose-template.yaml" "${VANBLOG_BASE_PATH}/docker-compose.yaml"
sed -i "s|vanblog_image|${Docker_IMG}|g" "${VANBLOG_BASE_PATH}/docker-compose.yaml"
assert_file_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "image: vanblog:dev-dsh" "编排文件用本地镜像 tag"
assert_file_not_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "mereith/van-blog" "编排文件不再指向官方镜像"
assert_file_not_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" 'vanblog_image' "占位符已被替换"

# --- 自定义 tag 里带斜杠也不会破坏 sed（分隔符是 | ）---
setup_case
source_script
export VANBLOG_IMAGE_TAG="ckboss/vanblog:dev-dsh"
prepare_vanblog_image >/dev/null 2>&1
cp "${TEMPLATE_FIXTURE}" "${VANBLOG_BASE_PATH}/docker-compose.yaml"
ensure_compose_image
assert_file_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "image: ckboss/vanblog:dev-dsh" "带斜杠的 tag 也能正确写入"
unset VANBLOG_IMAGE_TAG

# --- ensure_compose_image：把旧的官方镜像行改成本地 tag ---
setup_case
source_script
Docker_IMG="vanblog:dev-dsh"
sed "s/vanblog_image/mereith\/van-blog:latest/" "${TEMPLATE_FIXTURE}" >"${VANBLOG_BASE_PATH}/docker-compose.yaml"
OUT="$(ensure_compose_image 2>&1)"
assert_file_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "image: vanblog:dev-dsh" "旧编排文件会被改成本地 tag"
assert_file_not_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "mereith/van-blog" "旧镜像行不再残留"
assert_contains "${OUT}" "不一致" "切换镜像来源时有提示"

# --- 已经有源码时，编排模板直接用仓库里的那份（不联网）---
setup_case
source_script
clone_or_update_source >/dev/null 2>&1
: >"${CMDLOG}"
rm -f "${VANBLOG_BASE_PATH}/docker-compose-template.yaml"
download_compose_template "${VANBLOG_BASE_PATH}/docker-compose-template.yaml" >/dev/null 2>&1
assert_file_contains "${VANBLOG_BASE_PATH}/docker-compose-template.yaml" "services:" "本地模板可用"
if grep -q "wget\|curl" "${CMDLOG}" 2>/dev/null; then
  fail "有本地源码时不该再去下载模板"
else
  pass "有本地源码时不该再去下载模板"
fi

# --- 两份脚本必须一致（docs 下那份是文档站发布的副本）---
if cmp -s "${SCRIPT}" "${PUBLIC_SCRIPT}"; then
  pass "scripts/vanblog.sh 与 docs 公开副本一致"
else
  fail "scripts/vanblog.sh 与 docs 公开副本一致"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
[[ ${FAIL} -eq 0 ]]
