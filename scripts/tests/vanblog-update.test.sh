#!/usr/bin/env bash
# Unit tests for vanblog.sh update(): mock docker/compose, no real daemon.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"
PUBLIC_SCRIPT="${ROOT}/docs/.vuepress/public/vanblog.sh"

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

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    pass "${label}"
  else
    fail "${label} (missing: ${needle})"
    echo "---- output ----"
    echo "${haystack}"
    echo "----------------"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    fail "${label} (unexpected: ${needle})"
    echo "---- output ----"
    echo "${haystack}"
    echo "----------------"
  else
    pass "${label}"
  fi
}

assert_eq() {
  local got="$1"
  local want="$2"
  local label="$3"
  if [[ "${got}" == "${want}" ]]; then
    pass "${label}"
  else
    fail "${label} (got '${got}', want '${want}')"
  fi
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

write_compose() {
  local dest="$1"
  local image="$2"
  cat >"${dest}" <<EOF
version: '3'
services:
  vanblog:
    image: ${image}
    restart: always
  mongo:
    image: mongo:4.4.16
EOF
}

install_mocks() {
  local bindir="$1"
  cat >"${bindir}/docker" <<'EOF'
#!/usr/bin/env bash
set -u
STATE="${VANBLOG_TEST_STATE}"
LOG="${VANBLOG_TEST_LOG}"
. "${STATE}"

log_cmd() {
  echo "running=${RUNNING:-0} docker $*" >>"${LOG}"
}

get_var() {
  # shellcheck disable=SC1090
  . "${STATE}"
  eval "printf '%s' \"\${$1-}\""
}

set_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "${STATE}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${STATE}"
  else
    echo "${key}=${value}" >>"${STATE}"
  fi
}

cmd="${1-}"
shift || true
log_cmd "${cmd}" "$@"

case "${cmd}" in
inspect)
  format=""
  cid=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
    -f | --format)
      format="${2-}"
      shift 2
      ;;
    *)
      cid="$1"
      shift
      ;;
    esac
  done
  current_cid="$(get_var CONTAINER_ID)"
  if [[ -z "${cid}" || "${cid}" != "${current_cid}" ]]; then
    echo "Error: No such container: ${cid}" >&2
    exit 1
  fi
  case "${format}" in
  *".Image"*)
    get_var IMAGE_ID
    echo
    ;;
  *".State.Running"*)
    if [[ "$(get_var RUNNING)" == "1" ]]; then
      echo true
    else
      echo false
    fi
    ;;
  *".Config.Env"*)
    echo "VAN_BLOG_VERSION=$(get_var VERSION)"
    echo "TZ=Asia/Shanghai"
    ;;
  *)
    echo "unsupported inspect format" >&2
    exit 1
    ;;
  esac
  ;;
image)
  # `docker image inspect -f '{{range .Config.Env}}…'`：脚本用它读**镜像**里的 VAN_BLOG_VERSION，
  # 好在停旧容器**之前**就知道要换成哪一版。IMAGE_VERSION 没设 ⇒ 输出空值，
  # 那正是"镜像里读不出版本号"的形状（update 会走"证明不了不更旧"的 WARN 分支）。
  sub="${1-}"
  shift || true
  if [[ "${sub}" == "inspect" ]]; then
    echo "VAN_BLOG_VERSION=$(get_var IMAGE_VERSION)"
    echo "TZ=Asia/Shanghai"
  fi
  ;;
ps)
  ancestor=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --filter)
      if [[ "${2-}" == ancestor=* ]]; then
        ancestor="${2#ancestor=}"
      fi
      shift 2
      ;;
    *)
      shift
      ;;
    esac
  done
  if [[ -n "${ancestor}" && "${ancestor}" == "$(get_var IMAGE_ID)" && -n "$(get_var CONTAINER_ID)" ]]; then
    get_var CONTAINER_ID
    echo
  fi
  if [[ -n "${ancestor}" && "${ancestor}" == "$(get_var EXTRA_IN_USE_IMAGE)" && -n "$(get_var EXTRA_IN_USE_IMAGE)" ]]; then
    echo "extra-container"
  fi
  ;;
rmi)
  target="${1-}"
  if [[ "$(get_var RUNNING)" == "1" && "$(get_var IMAGE_ID)" == "${target}" ]]; then
    echo "rmi_while_running docker rmi ${target}" >>"${LOG}"
    echo "Error response from daemon: conflict: unable to delete (cannot be forced) - image is being used by running container" >&2
    exit 1
  fi
  if [[ -n "$(get_var EXTRA_IN_USE_IMAGE)" && "$(get_var EXTRA_IN_USE_IMAGE)" == "${target}" ]]; then
    echo "rmi_while_running docker rmi ${target}" >>"${LOG}"
    echo "Error response from daemon: conflict: unable to delete (cannot be forced) - image is being used by running container" >&2
    exit 1
  fi
  echo "rmi ${target}" >>"${LOG}"
  ;;
*)
  exit 0
  ;;
esac
EOF

  cat >"${bindir}/docker-compose" <<'EOF'
#!/usr/bin/env bash
set -u
STATE="${VANBLOG_TEST_STATE}"
LOG="${VANBLOG_TEST_LOG}"

get_var() {
  # shellcheck disable=SC1090
  . "${STATE}"
  eval "printf '%s' \"\${$1-}\""
}

set_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "${STATE}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${STATE}"
  else
    echo "${key}=${value}" >>"${STATE}"
  fi
}

echo "running=$(get_var RUNNING) docker-compose $*" >>"${LOG}"

cmd="${1-}"
shift || true
case "${cmd}" in
ps)
  if [[ "$(get_var CONTAINER_ID)" != "" ]]; then
    echo "$(get_var CONTAINER_ID)"
  fi
  ;;
down)
  if [[ "$(get_var DOWN_FAIL)" == "1" ]]; then
    exit 1
  fi
  set_var RUNNING 0
  set_var CONTAINER_ID ""
  ;;
pull)
  if [[ "$(get_var PULL_FAIL)" == "1" ]]; then
    exit 1
  fi
  echo "pulled $*" >>"${LOG}"
  set_var PULLED 1
  set_var IMAGE_ID "$(get_var NEXT_IMAGE_ID)"
  set_var VERSION "$(get_var NEXT_VERSION)"
  ;;
up)
  if [[ "$(get_var UP_FAIL)" == "1" ]]; then
    exit 1
  fi
  echo "up $*" >>"${LOG}"
  set_var CONTAINER_ID "vanblog-ctr"
  set_var RUNNING 1
  set_var UP_DONE 1
  ;;
*)
  exit 0
  ;;
esac
EOF
  chmod +x "${bindir}/docker" "${bindir}/docker-compose"
}

setup_case() {
  TEST_DIR="$(mktemp -d)"
  mkdir -p "${TEST_DIR}/bin" "${TEST_DIR}/vanblog"
  VANBLOG_TEST_STATE="${TEST_DIR}/state"
  VANBLOG_TEST_LOG="${TEST_DIR}/commands.log"
  : >"${VANBLOG_TEST_LOG}"
  cat >"${VANBLOG_TEST_STATE}" <<EOF
RUNNING=1
CONTAINER_ID=vanblog-ctr
IMAGE_ID=sha-old
VERSION=0.53.0
NEXT_IMAGE_ID=sha-new
NEXT_VERSION=0.54.0
PULLED=0
UP_DONE=0
PULL_FAIL=0
UP_FAIL=0
DOWN_FAIL=0
EXTRA_IN_USE_IMAGE=
EOF
  write_compose "${TEST_DIR}/vanblog/docker-compose.yaml" "mereith/van-blog:latest"
  install_mocks "${TEST_DIR}/bin"
  export VANBLOG_TEST_STATE VANBLOG_TEST_LOG
  export PATH="${TEST_DIR}/bin:${PATH}"
  VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
}

source_script() {
  export VANBLOG_SKIP_MAIN=1
  # 这个文件测的是「官方镜像」那条更新路径（compose pull + 比较镜像 id）。
  # 源码构建那条路径在 vanblog-source-install.test.sh 里用假的 git/docker 测。
  export VANBLOG_USE_UPSTREAM_IMAGE=true
  export VANBLOG_SRC_DIR="${TEST_DIR}/src"
  # shellcheck disable=SC1090
  source "${SCRIPT}"
}

run_update() {
  UPDATE_OUT="$(update 0 2>&1)"
  UPDATE_RC=$?
}

echo "== vanblog.sh update tests =="

if [[ ! -f "${SCRIPT}" ]]; then
  echo "missing ${SCRIPT}"
  exit 1
fi

assert_eq "$(cmp -s "${SCRIPT}" "${PUBLIC_SCRIPT}" && echo same || echo diff)" "same" "scripts/vanblog.sh matches docs public copy"

# --- success: stop → pull → up, then unused rmi, print success ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
run_update
assert_eq "${UPDATE_RC}" "0" "success path exits 0"
assert_contains "${UPDATE_OUT}" "VanBlog 更新并重启成功" "success path prints success"
assert_contains "${UPDATE_OUT}" "0.53.0 -> 0.54.0" "success path reports version move"
assert_file_contains "${VANBLOG_TEST_LOG}" "docker-compose down" "success path stops containers"
assert_file_contains "${VANBLOG_TEST_LOG}" "pulled vanblog" "success path pulls vanblog"
assert_file_contains "${VANBLOG_TEST_LOG}" "up -d" "success path brings stack up"
assert_file_contains "${VANBLOG_TEST_LOG}" "rmi sha-old" "success path deletes unused old image"
assert_file_not_contains "${VANBLOG_TEST_LOG}" "rmi_while_running" "success path never rmi while running"

# command order: pull before down before up; rmi only after down
# （以前是 down → pull → up：先停机再拉镜像/构建，整段时间站点是停的。
#   现在改成先备好新镜像再停，停机只剩重启那几秒；旧状态的采集仍在 pull 之前，
#   否则"版本有没有变"就比不出来了。）
order_ok=1
down_n="$(grep -n 'docker-compose down' "${VANBLOG_TEST_LOG}" | head -n1 | cut -d: -f1)"
pull_n="$(grep -n 'pulled vanblog' "${VANBLOG_TEST_LOG}" | head -n1 | cut -d: -f1)"
up_n="$(grep -n 'up -d' "${VANBLOG_TEST_LOG}" | head -n1 | cut -d: -f1)"
rmi_n="$(grep -n 'rmi sha-old' "${VANBLOG_TEST_LOG}" | head -n1 | cut -d: -f1)"
if [[ -z "${down_n}" || -z "${pull_n}" || -z "${up_n}" || -z "${rmi_n}" ]]; then
  order_ok=0
elif [[ "${pull_n}" -ge "${down_n}" || "${down_n}" -ge "${up_n}" || "${rmi_n}" -le "${down_n}" ]]; then
  order_ok=0
fi
assert_eq "${order_ok}" "1" "order is pull → down → up, rmi after down"

if grep -q 'rmi_while_running' "${VANBLOG_TEST_LOG}"; then
  fail "no docker rmi while container still running"
else
  pass "no docker rmi while container still running"
fi
if grep -q 'running=1 docker rmi sha-new' "${VANBLOG_TEST_LOG}"; then
  fail "does not rmi the image the new container is using"
else
  pass "does not rmi the image the new container is using"
fi

# --- pull failure: no false success ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
sed -i 's/^PULL_FAIL=.*/PULL_FAIL=1/' "${VANBLOG_TEST_STATE}"
run_update
assert_eq "${UPDATE_RC}" "1" "pull failure exits 1"
assert_not_contains "${UPDATE_OUT}" "VanBlog 更新并重启成功" "pull failure does not print success"
assert_contains "${UPDATE_OUT}" "拉取镜像失败" "pull failure prints error"
assert_file_not_contains "${VANBLOG_TEST_LOG}" "rmi_while_running" "pull failure never rmi while running"

# --- up failure: no false success ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
sed -i 's/^UP_FAIL=.*/UP_FAIL=1/' "${VANBLOG_TEST_STATE}"
run_update
assert_eq "${UPDATE_RC}" "1" "up failure exits 1"
assert_not_contains "${UPDATE_OUT}" "VanBlog 更新并重启成功" "up failure does not print success"
assert_contains "${UPDATE_OUT}" "启动失败" "up failure prints error"

# --- same image after pull: no false success ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
sed -i 's/^NEXT_IMAGE_ID=.*/NEXT_IMAGE_ID=sha-old/' "${VANBLOG_TEST_STATE}"
sed -i 's/^NEXT_VERSION=.*/NEXT_VERSION=0.53.0/' "${VANBLOG_TEST_STATE}"
run_update
# 镜像 id 没变 = 本来就是最新版：这是正常结果，不该报「更新失败」把人吓一跳
# （真的拉取失败在 pull 那一步就已经拦下并返回 1 了）
assert_eq "${UPDATE_RC}" "0" "unchanged image exits 0 (already latest)"
assert_not_contains "${UPDATE_OUT}" "更新失败" "unchanged image is not reported as a failure"
assert_contains "${UPDATE_OUT}" "已经是最新版本" "unchanged image prints already-latest"
assert_file_not_contains "${VANBLOG_TEST_LOG}" "rmi sha-old" "unchanged image does not delete in-use/current image"

# --- down failure ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
sed -i 's/^DOWN_FAIL=.*/DOWN_FAIL=1/' "${VANBLOG_TEST_STATE}"
run_update
assert_eq "${UPDATE_RC}" "1" "down failure exits 1"
assert_not_contains "${UPDATE_OUT}" "VanBlog 更新并重启成功" "down failure does not print success"
# 新顺序下 pull 发生在 down 之前，所以"down 失败时没 pull"不再是有效不变式
# （先拉镜像对正在跑的容器没有任何影响）。真正要保证的是：down 失败就**不再 up**，
# 不会把栈停在一个半死不活的状态；而且旧容器全程没被动过。
assert_file_contains "${VANBLOG_TEST_LOG}" "pulled vanblog" "down 失败前镜像已经拉好（对运行中的容器无影响）"
assert_file_not_contains "${VANBLOG_TEST_LOG}" "up -d" "down failure does not bring the stack up"
assert_file_not_contains "${VANBLOG_TEST_LOG}" "rmi_while_running" "down failure never rmi while running"

# --- China mirror compose is aligned to Docker Hub latest ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
write_compose "${TEST_DIR}/vanblog/docker-compose.yaml" "registry.cn-beijing.aliyuncs.com/mereith/van-blog:latest"
run_update
assert_eq "${UPDATE_RC}" "0" "China-mirror path exits 0 after align+update"
assert_contains "${UPDATE_OUT}" "VanBlog 更新并重启成功" "China-mirror path prints success only after move"
assert_contains "${UPDATE_OUT}" "中国镜像 latest 可能未同步" "China-mirror path rewrites stale latest"
assert_file_contains "${TEST_DIR}/vanblog/docker-compose.yaml" "mereith/van-blog:latest" "China compose now uses Docker Hub latest"
if grep -q 'registry.cn-beijing.aliyuncs.com/mereith/van-blog:latest' "${TEST_DIR}/vanblog/docker-compose.yaml"; then
  fail "China compose no longer pins Aliyun latest"
else
  pass "China compose no longer pins Aliyun latest"
fi
assert_file_contains "${VANBLOG_TEST_LOG}" "docker-compose down" "China path stops first"
assert_file_contains "${VANBLOG_TEST_LOG}" "pulled vanblog" "China path pulls vanblog"
assert_file_contains "${VANBLOG_TEST_LOG}" "up -d" "China path ups after pull"
if grep -q 'rmi_while_running' "${VANBLOG_TEST_LOG}"; then
  fail "China path does not rmi while running"
else
  pass "China path does not rmi while running"
fi

# --- skip rmi when another container still uses the old image ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
sed -i 's/^EXTRA_IN_USE_IMAGE=.*/EXTRA_IN_USE_IMAGE=sha-old/' "${VANBLOG_TEST_STATE}"
run_update
assert_eq "${UPDATE_RC}" "0" "in-use old image still allows successful update"
assert_contains "${UPDATE_OUT}" "VanBlog 更新并重启成功" "in-use old image still prints success after move"
assert_contains "${UPDATE_OUT}" "旧镜像仍被容器使用，跳过删除" "skips rmi when old image still used"
assert_file_not_contains "${VANBLOG_TEST_LOG}" "rmi sha-old" "does not rmi image still in use"

# ══════════════════════════════════════════════════════════════════════════
# 默认镜像标签、`update <版本|完整 ref>` 语法、以及"降级必须醒目"三组钉子
#
# 背景（实测，别改口径）：publish-ghcr 只在推 v* 标签或手动 workflow_dispatch 时构建
# （branches: 触发是注释掉的），所以 dev-dsh 只在有人手动构建时才动。2026-09-18 实测 ghcr：
# `latest` 与 `v2026.9.2` 同 digest（镜像内 VAN_BLOG_VERSION=v2026.9.2@23f2e9c，09-17 构建），
# 而 `dev-dsh` 还是 dev-dsh@b31a1ec（09-13，**旧 4 天**）⇒ 默认值用 dev-dsh 时，
# `./vanblog.sh update` 会把站点**降级**，把整轮安全修复悄悄回滚掉。
# ══════════════════════════════════════════════════════════════════════════
echo
echo "-- 默认镜像标签 / update <版本> 语法 / 降级警告 --"

# vanblog.sh 的颜色码是无条件输出的（没有 NO_COLOR 开关），而本节的断言要比对
# 「当前运行: X → 新镜像: Y」这种**跨越颜色码**的整句 ⇒ 先剥掉 ANSI 再比。
strip_ansi() { printf '%s' "$1" | sed -e 's/\x1b\[[0-9;]*m//g'; }

# ⚠️ 断言"某段代码不存在"之前先剥注释：脚本里解释这个坑的注释写了十几处 dev-dsh，
#    直接 grep 整个文件会匹配到注释 ⇒ 假红/假绿（本仓库已踩过五次）。
SCRIPT_CODE="$(grep -vE '^[[:space:]]*#' "${SCRIPT}")"

assert_contains "${SCRIPT_CODE}" 'VANBLOG_IMAGE_REF="${VANBLOG_IMAGE_REF:-ghcr.io/ckboss/vanblog:latest}"' \
  "默认镜像 ref 是 :latest（跟着发布走）"
assert_not_contains "${SCRIPT_CODE}" 'VANBLOG_IMAGE_REF:-ghcr.io/ckboss/vanblog:dev-dsh' \
  "默认值不许改回 :dev-dsh（那会让 ./vanblog.sh update 变成降级）"
assert_contains "${SCRIPT_CODE}" 'VANBLOG_FORK_IMAGE="${VANBLOG_IMAGE_REF%%:*}"' \
  "镜像名从 VANBLOG_IMAGE_REF 推导（不把仓库地址硬编码第二遍）"

DEFAULTS_OUT="$(
  unset VANBLOG_IMAGE_REF VANBLOG_USE_UPSTREAM_IMAGE
  export VANBLOG_SKIP_MAIN=1
  source "${SCRIPT}" >/dev/null 2>&1
  printf '%s\n%s\n' "${VANBLOG_IMAGE_REF}" "${VANBLOG_FORK_IMAGE}"
)"
assert_eq "$(printf '%s' "${DEFAULTS_OUT}" | sed -n 1p)" "ghcr.io/ckboss/vanblog:latest" "运行时默认 ref = :latest"
assert_eq "$(printf '%s' "${DEFAULTS_OUT}" | sed -n 2p)" "ghcr.io/ckboss/vanblog" "推导出的镜像名不含 tag"

# --- update <参数> 的解析：在一个没有编排文件的目录里跑，只看"目标镜像"那行 ---
ARG_DIR="$(mktemp -d)"
run_update_arg() { # <args…>；子 shell 里跑，免得 VANBLOG_IMAGE_REF 的赋值漏到后面的用例
  UPDATE_OUT="$(
    unset VANBLOG_IMAGE_REF VANBLOG_USE_UPSTREAM_IMAGE
    export VANBLOG_SKIP_MAIN=1
    VANBLOG_BASE_PATH="${ARG_DIR}"
    source "${SCRIPT}" >/dev/null 2>&1
    update 0 "$@" </dev/null
  ) 2>&1"
  UPDATE_RC=$?
}
target_line() { printf '%s\n' "${UPDATE_OUT}" | grep -m1 "目标镜像"; }

run_update_arg v2026.9.2
assert_contains "$(target_line)" "ghcr.io/ckboss/vanblog:v2026.9.2" "update v2026.9.2 拼成本仓库镜像 + 该 tag"
assert_contains "$(target_line)" "发布号" "并说清发布号是固定不变的"
assert_eq "${UPDATE_RC}" "1" "没有编排文件时仍然明确失败（不静默成功）"

run_update_arg dev-dsh-abc1234
assert_contains "$(target_line)" "ghcr.io/ckboss/vanblog:dev-dsh-abc1234" "update dev-dsh-<短sha> 同样拼 tag（回滚用）"

run_update_arg ghcr.io/foo/bar:tag
assert_contains "$(target_line)" "ghcr.io/foo/bar:tag" "带 / 的参数当完整 ref 原样透传"

run_update_arg mirror.example.com:5000/ckboss/vanblog:v2026.9.2
assert_contains "$(target_line)" "mirror.example.com:5000/ckboss/vanblog:v2026.9.2" "带端口的私有 registry 也原样透传"

run_update_arg https://mirror.example.com/ckboss/vanblog
assert_contains "$(target_line)" "https://mirror.example.com/ckboss/vanblog" "带 :// 的参数原样透传"

run_update_arg
assert_contains "$(target_line)" "ghcr.io/ckboss/vanblog:latest" "反证：不带参数时仍是默认 :latest（默认值没被参数化改坏）"

run_update_arg --oops
assert_eq "${UPDATE_RC}" "2" "未知参数 --oops 退出码 2"
assert_contains "${UPDATE_OUT}" "不认这个参数" "并明说不认这个参数"
assert_contains "${UPDATE_OUT}" "用法" "打印用法"
assert_not_contains "${UPDATE_OUT}" "目标镜像" "拒绝时根本不去准备镜像（不静默按默认值升级）"

run_update_arg -x
assert_eq "${UPDATE_RC}" "2" "单个 -x 也被拒（不会被当成 tag 拼进镜像名）"

run_update_arg v2026.9.2 v2026.9.1
assert_eq "${UPDATE_RC}" "2" "给了两个版本 ⇒ 拒绝（不静默取最后一个）"
assert_contains "${UPDATE_OUT}" "只能指定一个" "并说清只能给一个"

UP_OUT="$(
  export VANBLOG_SKIP_MAIN=1 VANBLOG_USE_UPSTREAM_IMAGE=true
  VANBLOG_BASE_PATH="${ARG_DIR}"
  source "${SCRIPT}" >/dev/null 2>&1
  update 0 v2026.9.2 </dev/null
) 2>&1"
UP_RC=$?
assert_eq "${UP_RC}" "2" "VANBLOG_USE_UPSTREAM_IMAGE=true 时给版本参数 ⇒ 拒绝"
assert_contains "${UP_OUT}" "不能指定版本参数" "并说清为什么不能（不悄悄拼一个不存在的 tag）"
assert_not_contains "${UP_OUT}" "目标镜像" "拒绝时不去准备镜像"

# --- 顺序钉子：说清目标镜像要在拉镜像之前，版本对比要在停容器之前 ---
UPDATE_BODY="$(awk '/^update\(\) \{/,/^\}/' "${SCRIPT}")"
line_in_update() { printf '%s\n' "${UPDATE_BODY}" | grep -n "$1" | head -1 | cut -d: -f1; }
L_DESC="$(line_in_update 'describe_image_ref')"
L_PREP="$(line_in_update 'prepare_vanblog_image')"
L_VER="$(line_in_update '当前运行:')"
L_DOWN="$(line_in_update '停止并移除旧容器')"
if [[ -n "${L_DESC}" && -n "${L_PREP}" && "${L_DESC}" -lt "${L_PREP}" ]]; then
  pass "先说清目标镜像是什么含义，再去准备它（拉之前就能反悔）"
else
  fail "describe_image_ref 必须在 prepare_vanblog_image 之前（desc=${L_DESC:-无} prep=${L_PREP:-无}）"
fi
if [[ -n "${L_VER}" && -n "${L_DOWN}" && "${L_VER}" -lt "${L_DOWN}" ]]; then
  pass "版本对比在停容器**之前**打印（停了旧容器就查不到原来跑的是哪一版）"
else
  fail "版本对比必须在 down 之前（ver=${L_VER:-无} down=${L_DOWN:-无}）"
fi

# --- 降级 / 证明不了不更旧：WARN 必须醒目，非交互不阻塞 ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
echo "IMAGE_VERSION=0.52.0" >>"${VANBLOG_TEST_STATE}"
UPDATE_OUT="$(strip_ansi "$(update 0 </dev/null 2>&1)")"
UPDATE_RC=$?
assert_contains "${UPDATE_OUT}" "当前运行: 0.53.0 → 新镜像: 0.52.0" "停容器前打印了两个版本号"
assert_contains "${UPDATE_OUT}" "降级" "新镜像更旧时明说这是降级"
assert_contains "${UPDATE_OUT}" "update v2026.9.2" "并给出升到发布版的具体命令"
assert_eq "${UPDATE_RC}" "0" "非交互（stdin 不是 tty）不阻塞：WARN 照打、继续"
assert_contains "${UPDATE_OUT}" "不是交互终端" "并说清为什么没停下来问"
assert_file_contains "${VANBLOG_TEST_LOG}" "docker-compose down" "确实继续走完了升级"

setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
UPDATE_OUT="$(strip_ansi "$(update 0 </dev/null 2>&1)")"
UPDATE_RC=$?
assert_contains "${UPDATE_OUT}" "证明不了新镜像不比当前旧" "镜像里读不出版本号时按'可能是降级'处理（dev-dsh 那个坑就是这个形状）"
assert_eq "${UPDATE_RC}" "0" "非交互不阻塞"

setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
echo "IMAGE_VERSION=0.54.0" >>"${VANBLOG_TEST_STATE}"
UPDATE_OUT="$(strip_ansi "$(update 0 </dev/null 2>&1)")"
UPDATE_RC=$?
assert_contains "${UPDATE_OUT}" "当前运行: 0.53.0 → 新镜像: 0.54.0" "版本前进时也打印对比"
assert_not_contains "${UPDATE_OUT}" "降级" "反证：真的更新时不误报降级（否则 WARN 就成了狼来了）"
assert_eq "${UPDATE_RC}" "0" "正常升级仍然成功"

setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
echo "IMAGE_VERSION=0.52.0" >>"${VANBLOG_TEST_STATE}"
UPDATE_OUT="$(strip_ansi "$(VANBLOG_ASSUME_YES=1 update 0 </dev/null 2>&1)")"
UPDATE_RC=$?
assert_contains "${UPDATE_OUT}" "降级" "VANBLOG_ASSUME_YES=1 时 WARN 照打"
assert_contains "${UPDATE_OUT}" "VANBLOG_ASSUME_YES=1" "并说明是因为它才没阻塞"
assert_eq "${UPDATE_RC}" "0" "VANBLOG_ASSUME_YES=1 时继续完成升级"

# --- 版本比较：必须用**本项目真实的版本号形状**（v2026.9.x）---
# ⚠️ 上面那些用例用的是 0.53.0 / 0.54.0，它们在"次版本号"那一段就分出胜负，
#    永远走不到"修号"那一段 —— 而 BASH_REMATCH 下标写错（[3] 带着点，应该用 [4]）
#    恰好只在第三段爆炸：`v2026.9.1` vs `v2026.9.2` 触发 `((: .2: syntax error`、
#    算术退化成 0 ⇒ 判成 `same` ⇒ **真降级被当成"版本没有变化"，绕过 WARN 与确认**。
#    86 条 mock 断言全绿也没发现，因为没有一条用真实版本号形状。实测踩到的，钉在这里。
assert_eq "$(version_change_kind 'v2026.9.1@0ec01a5' 'v2026.9.2@23f2e9c')" "newer" "v2026.9.1 → v2026.9.2 判升级（修号那一段真的被比较了）"
assert_eq "$(version_change_kind 'v2026.9.2@23f2e9c' 'v2026.9.1@0ec01a5')" "downgrade" "v2026.9.2 → v2026.9.1 必须判降级（这条错了，降级保护等于不存在）"
assert_eq "$(version_change_kind 'v2026.9.2@23f2e9c' 'v2026.10.1@aaaaaaa')" "newer" "月份进位按数字比（不是字符串比，否则 9 > 10）"
assert_eq "$(version_change_kind 'v2026.12.3@aaaaaaa' 'v2027.1.1@bbbbbbb')" "newer" "年份进位"
assert_eq "$(version_change_kind 'v2026.9.2@23f2e9c' 'v2026.9.2@9999999')" "same" "同一发布号、不同构建 sha ⇒ same"
assert_eq "$(version_change_kind 'v2026.9.2@23f2e9c' 'dev-dsh@b31a1ec')" "unprovable" "发布号 → 会移动的标签 ⇒ 证明不了不更旧（实测 dev-dsh 比发布版旧 4 天）"
assert_eq "$(version_change_kind 'dev-dsh@b31a1ec' 'v2026.9.2@23f2e9c')" "unknown" "当前不是发布号 ⇒ 无从比较，不拦"
assert_eq "$(version_change_kind '' 'v2026.9.2@23f2e9c')" "unknown" "没有正在跑的容器 ⇒ unknown"
assert_eq "$(version_change_kind 'v2026.9.2@23f2e9c' '')" "unprovable" "读不出新镜像的版本 ⇒ unprovable（不猜）"
# 解析函数必须给出三个**纯整数**：曾经给出过 "2026 9 .2"，那个点让 (( )) 报错并退化成 0
NUMS="$(version_release_numbers 'v2026.9.2@23f2e9c')"
assert_eq "${NUMS}" "2026 9 2" "version_release_numbers 给出三个纯整数（第三段不许带点）"
if printf '%s' "${NUMS}" | grep -q '\.'; then
  fail "解析结果里还有小数点（会让算术静默退化成 0，把降级判成 same）"
else
  pass "解析结果里没有小数点"
fi
assert_eq "$(version_change_kind 'v2026.9.x@aaa' 'v2026.9.2@bbb')" "unknown" "认不出的版本形状不会被当成可比较（宁可 unknown 也不猜）"

# --- --help 与菜单同步（菜单编号一个都不许变）---
USAGE_TEXT="$(awk '/^show_usage\(\) \{/,/^\}$/' "${SCRIPT}")"
assert_contains "${USAGE_TEXT}" "update <版本号>" "--help 里写了 update <版本号>"
assert_contains "${USAGE_TEXT}" "update v2026.9.2" "--help 里有可直接复制的例子"
assert_contains "${USAGE_TEXT}" "退出码 2" "--help 说明打错参数会被拒绝"
assert_contains "${USAGE_TEXT}" "ghcr.io/ckboss/vanblog:latest" "--help 里的默认镜像与代码一致（latest）"
MENU_TEXT="$(awk '/^show_menu\(\) \{/,/^\}$/' "${SCRIPT}")"
assert_contains "${MENU_TEXT}" '6.${plain}  更新' "菜单第 6 项还是「更新」（编号没变）"
assert_contains "${MENU_TEXT}" "update v2026.9.2" "菜单里指了「升到指定发布版」的命令行写法"

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
