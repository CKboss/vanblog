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
if [[ "${DOCKER_PULL_FAIL:-0}" == "1" && "$1" == "pull" ]]; then
  echo "Error response from daemon: manifest unknown" >&2
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
  # 构建相关的新变量也要清：用例之间不能互相污染
  unset VANBLOG_BUILD_SERVER VANBLOG_BUILD_MODE VANBLOG_FORCE_BUILD VANBLOG_NPM_REGISTRY
  unset VANBLOG_INSTALL_MODE VANBLOG_IMAGE_REF DOCKER_PULL_FAIL
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
# VAN_BLOG_BUILD_SERVER 现在是**必传**的：Dockerfile 把它 ARG → ENV VAN_BLOG_SERVER_URL，
# 而前台 utils/loadConfig.ts 在模块顶层 new URL(它)；不传就是空串，next build 会在
# "Collecting page data" 阶段抛 ERR_INVALID_URL（曾经真的这么炸过一次）。
assert_file_contains "${CMDLOG}" "--build-arg VAN_BLOG_VERSIONS=dev/dsh-abc1234" "构建参数带分支与 commit"
assert_file_contains "${CMDLOG}" "--build-arg VAN_BLOG_BUILD_SERVER=http://127.0.0.1:3000" "默认 server 地址"
assert_file_contains "${CMDLOG}" "-t vanblog:dev-dsh" "镜像 tag"

# --- 用户显式指定 server 地址时以用户为准 ---
setup_case
source_script
clone_or_update_source >/dev/null 2>&1
VANBLOG_BUILD_SERVER="http://192.0.2.10:3000"
VANBLOG_SRC_COMMIT="abc1234"
build_vanblog_image >/dev/null 2>&1
assert_eq "$?" "0" "带自定义 server 地址构建成功"
assert_file_contains "${CMDLOG}" "--build-arg VAN_BLOG_BUILD_SERVER=http://192.0.2.10:3000" "用户指定的 server 地址优先于默认值"
assert_contains "${OUT}" "镜像构建完成" "构建成功有提示"

# --- 没有 Dockerfile 就不要瞎构建 ---
setup_case
source_script
mkdir -p "${VANBLOG_SRC_DIR}"
OUT="$(build_vanblog_image 2>&1)"
if [[ $? -ne 0 ]]; then pass "缺 Dockerfile 时构建失败"; else fail "缺 Dockerfile 时构建失败"; fi
assert_contains "${OUT}" "没有 Dockerfile" "缺 Dockerfile 有明确报错"
assert_not_contains "$(cat "${CMDLOG}")" "docker build" "缺 Dockerfile 时不会调用 docker build"

# --- prepare_vanblog_image（源码模式）：把 Docker_IMG 换成本地 tag ---
setup_case
source_script
export VANBLOG_INSTALL_MODE=source
Docker_IMG="mereith/van-blog:latest"
prepare_vanblog_image >/dev/null 2>&1
assert_eq "$?" "0" "准备镜像成功"
assert_eq "${Docker_IMG}" "vanblog:dev-dsh" "Docker_IMG 换成本地构建的 tag"
assert_file_contains "${CMDLOG}" "git" "源码模式会取源码"
assert_file_contains "${CMDLOG}" "docker build" "源码模式会本地构建"

# --- 构建失败必须返回非 0（安装/更新会据此中止，不会拿旧镜像糊弄）---
setup_case
source_script
export VANBLOG_INSTALL_MODE=source
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
export VANBLOG_INSTALL_MODE=source
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
export VANBLOG_INSTALL_MODE=source
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

# 这个文件原来的断言助手没有"正则匹配"，补一个（只在本段用）
assert_match() {
  local value="$1" pattern="$2" label="$3"
  if [[ "${value}" =~ ${pattern} ]]; then
    pass "${label}"
  else
    fail "${label} (value '${value}' !~ ${pattern})"
  fi
}

# --- 低配机器自适应：档位判定（纯函数，喂假数据） ---
setup_case
source_script
classify_build_profile 1 1024
assert_eq "${VANBLOG_BUILD_VIABLE}" "false" "1核1G：判定为不该源码构建"
assert_eq "${VANBLOG_BUILD_PARALLEL}" "false" "1核1G：串行"
assert_eq "${VANBLOG_ADMIN_BUILD_SCRIPT}" "build:lowmem" "1核1G：admin 用 1536MB 堆"
classify_build_profile 1 3000
assert_eq "${VANBLOG_BUILD_VIABLE}" "true" "1核3G：可行"
assert_eq "${VANBLOG_ADMIN_BUILD_SCRIPT}" "build:lowmem" "1核3G：admin 降堆"
assert_eq "${VANBLOG_BUILD_PARALLEL}" "false" "1核3G：串行"
classify_build_profile 1 16000
assert_eq "${VANBLOG_ADMIN_BUILD_SCRIPT}" "build" "1核16G：内存够就用满堆"
assert_eq "${VANBLOG_BUILD_PARALLEL}" "false" "1核16G：仍然串行（并发只会抢 CPU）"
classify_build_profile 4 6000
assert_eq "${VANBLOG_BUILD_PARALLEL}" "false" "4核6G：串行（三个 stage 会互相挤内存）"
classify_build_profile 8 24000
assert_eq "${VANBLOG_BUILD_PARALLEL}" "true" "8核24G：并发（最快）"
assert_eq "${VANBLOG_ADMIN_BUILD_SCRIPT}" "build" "8核24G：admin 满堆"
classify_build_profile 2 0
assert_eq "${VANBLOG_BUILD_VIABLE}" "true" "拿不到内存信息时不劝退（宁可试一次）"
assert_eq "${VANBLOG_BUILD_PARALLEL}" "false" "拿不到内存信息时保守串行"

# --- 手动档位优先于自动判定 ---
setup_case
source_script
VANBLOG_BUILD_MODE="lowmem"
choose_build_profile
assert_eq "${VANBLOG_ADMIN_BUILD_SCRIPT}" "build:lowmem" "VANBLOG_BUILD_MODE=lowmem 生效"
assert_eq "${VANBLOG_BUILD_PARALLEL}" "false" "lowmem 一定串行"
VANBLOG_BUILD_MODE="fast"
choose_build_profile
assert_eq "${VANBLOG_BUILD_PARALLEL}" "true" "VANBLOG_BUILD_MODE=fast 生效"
assert_eq "${VANBLOG_ADMIN_BUILD_SCRIPT}" "build" "fast 用满堆"
VANBLOG_BUILD_MODE="balanced"
choose_build_profile
assert_eq "${VANBLOG_BUILD_PARALLEL}" "false" "balanced 串行"
assert_eq "${VANBLOG_ADMIN_BUILD_SCRIPT}" "build" "balanced 用满堆"
assert_contains "${VANBLOG_BUILD_REASON}" "手动指定" "手动档位要在日志里说明是手动指定"

# --- 资源探测：真跑一次，值必须合理 ---
setup_case
source_script
detect_host_resources
assert_match "${VANBLOG_HOST_CPUS}" '^[1-9][0-9]*$' "探测到 CPU 核数（${VANBLOG_HOST_CPUS}）"
assert_match "${VANBLOG_HOST_MEM_MB}" '^[0-9][0-9]*$' "探测到可用内存 MB（${VANBLOG_HOST_MEM_MB}）"

# --- pnpm 源自动探测 ---
setup_case
source_script
curl() { local u="${@: -1}"; case "$u" in *npmmirror*) echo "0.420" ;; *npmjs*) echo "1.870" ;; esac; }
VANBLOG_NPM_REGISTRY=""
detect_npm_registry >"${TEST_DIR}/r1.log" 2>&1
assert_eq "${VANBLOG_NPM_REGISTRY}" "https://registry.npmmirror.com" "npmmirror 更快时选 npmmirror"
curl() { local u="${@: -1}"; case "$u" in *npmmirror*) echo "2.500" ;; *npmjs*) echo "0.300" ;; esac; }
VANBLOG_NPM_REGISTRY=""
detect_npm_registry >/dev/null 2>&1
assert_eq "${VANBLOG_NPM_REGISTRY}" "https://registry.npmjs.org" "npmjs 更快时选 npmjs（海外机器）"
curl() { local u="${@: -1}"; case "$u" in *npmmirror*) return 1 ;; *npmjs*) echo "0.800" ;; esac; }
VANBLOG_NPM_REGISTRY=""
detect_npm_registry >/dev/null 2>&1
assert_eq "${VANBLOG_NPM_REGISTRY}" "https://registry.npmjs.org" "npmmirror 不可达时退回 npmjs"
curl() { return 1; }
VANBLOG_NPM_REGISTRY=""
# ⚠️ 不能用 OUT="$(detect_npm_registry)"：命令替换是子 shell，函数里对全局变量的赋值会丢
detect_npm_registry >"${TEST_DIR}/reg.log" 2>&1
assert_eq "${VANBLOG_NPM_REGISTRY}" "https://registry.npmmirror.com" "两个源都不可达时用默认值"
assert_file_contains "${TEST_DIR}/reg.log" "都探测失败" "两个源都不可达时要说清楚"
VANBLOG_NPM_REGISTRY="https://my.registry.example/"
detect_npm_registry >"${TEST_DIR}/reg2.log" 2>&1
assert_eq "${VANBLOG_NPM_REGISTRY}" "https://my.registry.example/" "用户显式指定时不探测"
assert_file_contains "${TEST_DIR}/reg2.log" "VANBLOG_NPM_REGISTRY 指定" "日志里说明是用户指定"

# --- 构建命令：四个 build-arg 都要传，串行模式要分四步 ---
setup_case
source_script
clone_or_update_source >/dev/null 2>&1
VANBLOG_SRC_COMMIT="abc1234"
VANBLOG_BUILD_MODE="fast"
VANBLOG_NPM_REGISTRY="https://registry.example/"
build_vanblog_image >/dev/null 2>&1
assert_eq "$?" "0" "并发模式构建成功"
assert_file_contains "${CMDLOG}" "--build-arg VAN_BLOG_NPM_REGISTRY=https://registry.example/" "传入自动选出的 pnpm 源"
assert_file_contains "${CMDLOG}" "--build-arg VAN_BLOG_ADMIN_BUILD_SCRIPT=build" "并发模式用满堆脚本"
assert_file_contains "${CMDLOG}" "--build-arg VAN_BLOG_BUILD_SERVER=http://127.0.0.1:3000" "仍然传 server 地址"
assert_not_contains "$(cat "${CMDLOG}")" "--target" "并发模式不分步"

setup_case
source_script
clone_or_update_source >/dev/null 2>&1
VANBLOG_SRC_COMMIT="abc1234"
VANBLOG_BUILD_MODE="lowmem"
VANBLOG_NPM_REGISTRY="https://registry.example/"
OUT="$(build_vanblog_image 2>&1)"
assert_eq "$?" "0" "串行模式构建成功"
assert_file_contains "${CMDLOG}" "--target admin_builder" "串行：先单独构建 admin"
assert_file_contains "${CMDLOG}" "--target server_builder" "串行：再单独构建 server"
assert_file_contains "${CMDLOG}" "--target website_builder" "串行：再单独构建 website"
assert_file_contains "${CMDLOG}" "--build-arg VAN_BLOG_ADMIN_BUILD_SCRIPT=build:lowmem" "串行低内存档用 1536MB 堆"
assert_eq "$(grep -c 'docker build' "${CMDLOG}")" "4" "串行模式一共四次 docker build（三个 target + 一次组装）"
assert_contains "${OUT}" "串行" "日志里说明走的是串行"

# --- 内存太小时要劝退，并给出两条出路 ---
setup_case
source_script
clone_or_update_source >/dev/null 2>&1
VANBLOG_BUILD_MODE=""
VANBLOG_FORCE_BUILD="false"
detect_host_resources() { VANBLOG_HOST_CPUS=1; VANBLOG_HOST_MEM_MB=1024; }
OUT="$(build_vanblog_image 2>&1)"
assert_eq "$?" "1" "1G 内存下直接返回失败，不浪费 20 分钟"
assert_contains "${OUT}" "VANBLOG_USE_UPSTREAM_IMAGE=true" "劝退时给出「用官方镜像」这条路"
assert_contains "${OUT}" "VANBLOG_FORCE_BUILD=true" "劝退时给出「强行构建」这条路"
assert_file_not_contains "${CMDLOG}" "build" "劝退时一次 docker build 都不该跑"

VANBLOG_FORCE_BUILD="true"
OUT="$(build_vanblog_image 2>&1)"
assert_eq "$?" "0" "VANBLOG_FORCE_BUILD=true 时照跑"
assert_contains "${OUT}" "OOM" "强行构建时要提醒可能 OOM"

# --- 默认走「拉镜像」，源码构建只是兜底 ---
setup_case
source_script
assert_eq "${VANBLOG_INSTALL_MODE}" "auto" "默认安装模式是 auto（先拉镜像）"
assert_eq "${VANBLOG_IMAGE_REF}" "ghcr.io/ckboss/vanblog:dev-dsh" "默认镜像是本分支的 ghcr 地址"
Docker_IMG="mereith/van-blog:latest"
# ⚠️ 不能用 OUT="$(prepare_vanblog_image)"：命令替换是子 shell，Docker_IMG 的赋值会丢
prepare_vanblog_image >"${TEST_DIR}/prep.log" 2>&1
OUT="$(cat "${TEST_DIR}/prep.log")"
assert_eq "$?" "0" "auto 模式准备镜像成功"
assert_eq "${Docker_IMG}" "ghcr.io/ckboss/vanblog:dev-dsh" "auto 模式用 ghcr 镜像，不再是上游镜像"
assert_file_contains "${CMDLOG}" "pull ghcr.io/ckboss/vanblog:dev-dsh" "auto 模式会 docker pull"
assert_not_contains "$(cat "${CMDLOG}")" "docker build" "拉到镜像就不该本地构建（小机器装得动的前提）"
assert_not_contains "$(cat "${CMDLOG}")" "git clone" "拉到镜像就不该克隆源码"

# --- auto 模式拉不到镜像时退回源码构建 ---
setup_case
source_script
export DOCKER_PULL_FAIL=1
Docker_IMG="mereith/van-blog:latest"
prepare_vanblog_image >"${TEST_DIR}/prep2.log" 2>&1
RC=$?
OUT="$(cat "${TEST_DIR}/prep2.log")"
assert_eq "${RC}" "0" "拉不到镜像时退回源码构建仍然成功"
assert_eq "${Docker_IMG}" "vanblog:dev-dsh" "退回源码构建后 Docker_IMG 是本地 tag"
assert_file_contains "${CMDLOG}" "docker build" "退回路径确实构建了"
assert_contains "${OUT}" "源码构建" "退回时日志里说清楚"
unset DOCKER_PULL_FAIL

# --- image 模式：拉不到就直接失败，绝不偷偷构建（用户明确说了只要镜像）---
setup_case
source_script
export VANBLOG_INSTALL_MODE=image
export DOCKER_PULL_FAIL=1
OUT="$(prepare_vanblog_image 2>&1)"
if [[ $? -ne 0 ]]; then pass "image 模式拉不到镜像时返回非 0"; else fail "image 模式拉不到镜像时返回非 0"; fi
assert_not_contains "$(cat "${CMDLOG}")" "docker build" "image 模式不会退回构建"
unset DOCKER_PULL_FAIL

# --- source 模式：一次 pull 都不发 ---
setup_case
source_script
export VANBLOG_INSTALL_MODE=image
prepare_vanblog_image >/dev/null 2>&1
assert_eq "${Docker_IMG}" "ghcr.io/ckboss/vanblog:dev-dsh" "image 模式用指定的镜像地址"
setup_case
source_script
export VANBLOG_INSTALL_MODE=source
prepare_vanblog_image >/dev/null 2>&1
assert_eq "${Docker_IMG}" "vanblog:dev-dsh" "source 模式用本地构建的 tag"
assert_not_contains "$(cat "${CMDLOG}")" "docker pull" "source 模式不拉镜像"

# --- 自定义镜像地址（自己的 registry / 特定 sha）---
setup_case
source_script
export VANBLOG_IMAGE_REF="ghcr.io/ckboss/vanblog:dev-dsh-abc1234"
prepare_vanblog_image >/dev/null 2>&1
assert_eq "${Docker_IMG}" "ghcr.io/ckboss/vanblog:dev-dsh-abc1234" "VANBLOG_IMAGE_REF 生效"
assert_file_contains "${CMDLOG}" "pull ghcr.io/ckboss/vanblog:dev-dsh-abc1234" "按自定义地址拉取"
unset VANBLOG_IMAGE_REF

# --- 上游官方镜像仍然优先级最高 ---
setup_case
source_script
export VANBLOG_USE_UPSTREAM_IMAGE=true
Docker_IMG="mereith/van-blog:latest"
prepare_vanblog_image >/dev/null 2>&1
assert_eq "${Docker_IMG}" "mereith/van-blog:latest" "VANBLOG_USE_UPSTREAM_IMAGE=true 时不碰 ghcr"
assert_not_contains "$(cat "${CMDLOG}")" "pull ghcr.io" "上游镜像模式不会去拉本分支镜像"
unset VANBLOG_USE_UPSTREAM_IMAGE

# --- 编排文件里写的是 ghcr 地址（含斜杠，sed 分隔符是 | ）---
setup_case
source_script
prepare_vanblog_image >/dev/null 2>&1
cp "${TEMPLATE_FIXTURE}" "${VANBLOG_BASE_PATH}/docker-compose.yaml"
ensure_compose_image
assert_file_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "image: ghcr.io/ckboss/vanblog:dev-dsh" "编排文件写入 ghcr 镜像"
assert_file_not_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "mereith/van-blog" "编排文件不再指向官方镜像"

# --- 发布 workflow：用 GITHUB_TOKEN，不需要额外 secret ---
WORKFLOW="${ROOT}/.github/workflows/publish-ghcr.yml"
if [[ -f "${WORKFLOW}" ]]; then
  pass "存在 publish-ghcr workflow"
  assert_file_contains "${WORKFLOW}" "packages: write" "workflow 有推包权限"
  assert_file_contains "${WORKFLOW}" "ghcr.io" "推到 ghcr.io"
  assert_file_contains "${WORKFLOW}" "secrets.GITHUB_TOKEN" "用自带的 GITHUB_TOKEN（不需要配 secret）"
  assert_not_contains "$(cat "${WORKFLOW}")" "DOCKERHUB_TOKEN" "不再依赖上游的 Docker Hub 凭据"
  assert_file_contains "${WORKFLOW}" "VAN_BLOG_VERSIONS" "构建时写入版本号"
  assert_file_contains "${WORKFLOW}" "VAN_BLOG_BUILD_SERVER" "构建时传入 server 地址（空值会让 next build 挂）"
  assert_file_contains "${WORKFLOW}" "VAN_BLOG_NPM_REGISTRY" "构建时指定 pnpm 源"
  assert_file_contains "${WORKFLOW}" "cache-from: type=gha" "用 Actions 缓存加速重建"
  assert_file_contains "${WORKFLOW}" "Public" "提醒把 package 可见性改成 Public（否则别人拉不动）"
  # 触发策略：**不是每次 push 都构建**（一次 20-40 分钟 runner，而文档类提交占大多数）
  assert_file_contains "${WORKFLOW}" "workflow_dispatch" "支持手动触发（平时发版就点这个）"
  # ⚠️ assert_file_contains 走的是 grep（正则），`*` 要转义，否则 v* 会匹配成"零个或多个 v"
  assert_file_contains "${WORKFLOW}" "- 'v\*'" "打 v* 标签时构建（当作正式发版）"
  # 分支 push 触发必须是被注释掉的，不能是活的
  if grep -qE '^ *branches:' "${WORKFLOW}"; then
    fail "workflow 又变成每次 push 分支都构建了（branches: 不该是生效状态）"
  else
    pass "分支 push 不会触发构建（branches: 只以注释形式存在）"
  fi
  assert_file_contains "${WORKFLOW}" "# branches:" "把分支触发的写法留在注释里，需要时能直接放开"
  assert_file_contains "${WORKFLOW}" "# paths:" "注释里给了 paths 过滤的写法（只想在代码变化时构建）"
  # ghcr（和 Docker 一样）要求镜像引用全小写，而仓库 owner 是 CKboss —— 直接拼
  # ${{ github.repository }} 会得到 ghcr.io/CKboss/vanblog，构建几十分钟后才报
  # invalid reference format。必须有一个 step 把它转小写。
  # ⚠️ 针里的 [ ] 要转义：assert_file_contains 走的是 grep（BRE），[:upper:] 会被当成字符类
  assert_file_contains "${WORKFLOW}" "tr '\[:upper:\]' '\[:lower:\]'" "镜像名强制转小写（owner 带大写字母）"
  assert_not_contains "$(cat "${WORKFLOW}")" 'images: \${{ env.REGISTRY }}/\${{ env.IMAGE_NAME }}' "不再直接用大写的 github.repository 当镜像名"
  assert_file_contains "${WORKFLOW}" "steps.image.outputs.name" "meta 与摘要都用小写后的镜像名"
  assert_file_contains "${WORKFLOW}" "打印本次构建参数" "构建前把生效的参数打出来（失败时好排查）"
else
  fail "缺少 .github/workflows/publish-ghcr.yml"
fi


# --- 镜像发布成功之后：脚本这边的配套改动 ---
# 1) update 必须「先备好新镜像，再停旧容器」：拉镜像几十秒、源码构建 15-40 分钟，
#    旧顺序是先 down 再 pull/build，整段时间站点是停的；构建失败还白白停机一次。
setup_case
source_script
UPDATE_BODY="$(awk '/^update\(\) \{/,/^\}/' "${SCRIPT}")"
PREP_LINE="$(printf '%s\n' "${UPDATE_BODY}" | grep -n 'prepare_vanblog_image' | head -1 | cut -d: -f1)"
DOWN_LINE="$(printf '%s\n' "${UPDATE_BODY}" | grep -n 'down --remove-orphans' | head -1 | cut -d: -f1)"
PULL_LINE="$(printf '%s\n' "${UPDATE_BODY}" | grep -n 'vanblog_compose pull vanblog' | head -1 | cut -d: -f1)"
if [[ -n "${PREP_LINE}" && -n "${DOWN_LINE}" && "${PREP_LINE}" -lt "${DOWN_LINE}" ]]; then
  pass "update 里 prepare_vanblog_image 在 down 之前（先备好镜像再停机）"
else
  fail "update 里 prepare_vanblog_image(${PREP_LINE}) 必须在 down(${DOWN_LINE}) 之前"
fi
if [[ -n "${PULL_LINE}" && "${PULL_LINE}" -lt "${DOWN_LINE}" ]]; then
  pass "上游镜像模式也是先 pull 再 down"
else
  fail "上游镜像模式的 pull(${PULL_LINE}) 也应在 down(${DOWN_LINE}) 之前"
fi
assert_contains "${UPDATE_BODY}" "保持原容器与原镜像不动" "准备失败时明确说明不动正在跑的容器"

# 2) 准备失败时一次 down 都不该发生（站点不受影响）
setup_case
source_script
export VANBLOG_INSTALL_MODE=image
export DOCKER_PULL_FAIL=1
cp "${TEMPLATE_FIXTURE}" "${VANBLOG_BASE_PATH}/docker-compose.yaml"
update skip >/dev/null 2>&1
if [[ $? -ne 0 ]]; then pass "拉不到镜像时 update 返回非 0"; else fail "拉不到镜像时 update 返回非 0"; fi
assert_not_contains "$(cat "${CMDLOG}")" "down --remove-orphans" "拉不到镜像时不会停掉正在跑的容器"
assert_not_contains "$(cat "${CMDLOG}")" "docker build" "image 模式下不会偷偷构建"
unset DOCKER_PULL_FAIL

# 3) 拉取失败要按原因给出具体下一步（ghcr 包默认 private / 架构不匹配）
setup_case
source_script
docker() { echo "Error response from daemon: denied: requested access to the resource is denied"; return 1; }
OUT="$(pull_fork_image 2>&1)"
assert_contains "${OUT}" "Change visibility" "denied 时提示把 package 改成 Public"
assert_contains "${OUT}" "pkgs/container/vanblog" "denied 时给出 package 设置页地址"
docker() { echo "Error: no matching manifest for linux/arm64/v8"; return 1; }
OUT="$(pull_fork_image 2>&1)"
assert_contains "${OUT}" "架构" "架构不匹配时说清楚是架构问题"
assert_contains "${OUT}" "linux/arm64" "架构不匹配时告诉用户怎么出 arm64 镜像"
docker() { echo "Error: dial tcp: i/o timeout"; return 1; }
OUT="$(pull_fork_image 2>&1)"
assert_contains "${OUT}" "网络到不了 ghcr.io" "其它失败给出通用解释"
assert_contains "${OUT}" "VANBLOG_IMAGE_REF" "网络类失败给出「换镜像加速地址」这条路"
assert_contains "${OUT}" "docker save" "网络类失败给出「大机器 save / 本机 load」这条路"
assert_contains "${OUT}" "VANBLOG_INSTALL_MODE=source" "网络类失败给出「源码构建」这条路"

# 4) 从本地构建切到拉镜像后，提示清掉旧镜像（只提示，不自动删）
setup_case
source_script
Docker_IMG="ghcr.io/ckboss/vanblog:dev-dsh"
VANBLOG_IMAGE_TAG="vanblog:dev-dsh"
docker() { [[ "$1 $2" == "image inspect" ]] && return 0 || return 1; }
OUT="$(hint_stale_local_image 2>&1)"
assert_contains "${OUT}" "docker rmi vanblog:dev-dsh" "提示怎么删旧的本地镜像"
assert_contains "${OUT}" "确认新容器正常后" "强调要等新容器正常再删"
# 用的还是本地 tag 时不该提示（否则等于让人删掉正在用的镜像）
Docker_IMG="vanblog:dev-dsh"
OUT="$(hint_stale_local_image 2>&1)"
if [[ -z "${OUT}" ]]; then pass "仍在用本地镜像时不提示删除"; else fail "仍在用本地镜像时不该提示删除"; fi


echo
echo "passed=${PASS} failed=${FAIL}"
[[ ${FAIL} -eq 0 ]]
