#!/usr/bin/env bash
# Unit tests for vanblog.sh compose/script download fallbacks: mock wget/curl, no network.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"
PUBLIC_SCRIPT="${ROOT}/docs/.vuepress/public/vanblog.sh"
TEMPLATE_FIXTURE="${ROOT}/docker-compose/docker-compose-template.yml"

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

url_attempt_order() {
  awk '/^wget / { print $2 }' "${VANBLOG_TEST_LOG}"
}

install_mocks() {
  local bindir="$1"
  cat >"${bindir}/wget" <<'EOF'
#!/usr/bin/env bash
set -u
LOG="${VANBLOG_TEST_LOG}"
FAIL_FILE="${VANBLOG_TEST_FAIL_URLS}"
INVALID_FILE="${VANBLOG_TEST_INVALID_URLS}"
PAYLOAD="${VANBLOG_TEST_PAYLOAD}"

dest=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  -O | -o)
    dest="${2-}"
    shift 2
    ;;
  -t | -T | --timeout | --tries)
    shift 2
    ;;
  --no-check-certificate | -q | -s | -S | -L | -f)
    shift
    ;;
  --connect-timeout | --retry | --max-time)
    shift 2
    ;;
  -*)
    shift
    ;;
  *)
    url="$1"
    shift
    ;;
  esac
done

echo "wget ${url} dest=${dest}" >>"${LOG}"

if [[ -z "${url}" || -z "${dest}" ]]; then
  exit 1
fi

fail_match=0
if [[ -f "${FAIL_FILE}" ]] && grep -Fxq -- "${url}" "${FAIL_FILE}"; then
  fail_match=1
fi
invalid_match=0
if [[ -f "${INVALID_FILE}" ]] && grep -Fxq -- "${url}" "${INVALID_FILE}"; then
  invalid_match=1
fi

if [[ "${fail_match}" == "1" ]]; then
  : >"${dest}"
  exit 1
fi

mkdir -p "$(dirname "${dest}")"
if [[ "${invalid_match}" == "1" ]]; then
  printf '<html><title>404 Not Found</title></html>\n' >"${dest}"
  exit 0
fi

if [[ ! -f "${PAYLOAD}" ]]; then
  echo "missing payload ${PAYLOAD}" >&2
  exit 1
fi
cat "${PAYLOAD}" >"${dest}"
exit 0
EOF

  cat >"${bindir}/curl" <<'EOF'
#!/usr/bin/env bash
set -u
LOG="${VANBLOG_TEST_LOG}"
FAIL_FILE="${VANBLOG_TEST_FAIL_URLS}"
INVALID_FILE="${VANBLOG_TEST_INVALID_URLS}"
PAYLOAD="${VANBLOG_TEST_PAYLOAD}"

dest=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  -o | --output)
    dest="${2-}"
    shift 2
    ;;
  --connect-timeout | --retry | --max-time | -m)
    shift 2
    ;;
  -O)
    shift
    ;;
  -*)
    shift
    ;;
  *)
    url="$1"
    shift
    ;;
  esac
done

echo "curl ${url} dest=${dest}" >>"${LOG}"

if [[ -z "${url}" || -z "${dest}" ]]; then
  exit 1
fi

fail_match=0
if [[ -f "${FAIL_FILE}" ]] && grep -Fxq -- "${url}" "${FAIL_FILE}"; then
  fail_match=1
fi
invalid_match=0
if [[ -f "${INVALID_FILE}" ]] && grep -Fxq -- "${url}" "${INVALID_FILE}"; then
  invalid_match=1
fi

if [[ "${fail_match}" == "1" ]]; then
  : >"${dest}"
  exit 1
fi

mkdir -p "$(dirname "${dest}")"
if [[ "${invalid_match}" == "1" ]]; then
  printf '<html><title>404 Not Found</title></html>\n' >"${dest}"
  exit 0
fi

if [[ ! -f "${PAYLOAD}" ]]; then
  echo "missing payload ${PAYLOAD}" >&2
  exit 1
fi
cat "${PAYLOAD}" >"${dest}"
exit 0
EOF
  chmod +x "${bindir}/wget" "${bindir}/curl"
}

setup_case() {
  TEST_DIR="$(mktemp -d)"
  mkdir -p "${TEST_DIR}/bin" "${TEST_DIR}/vanblog"
  VANBLOG_TEST_LOG="${TEST_DIR}/commands.log"
  VANBLOG_TEST_FAIL_URLS="${TEST_DIR}/fail-urls"
  VANBLOG_TEST_INVALID_URLS="${TEST_DIR}/invalid-urls"
  VANBLOG_TEST_PAYLOAD="${TEST_DIR}/payload"
  : >"${VANBLOG_TEST_LOG}"
  : >"${VANBLOG_TEST_FAIL_URLS}"
  : >"${VANBLOG_TEST_INVALID_URLS}"
  cat "${TEMPLATE_FIXTURE}" >"${VANBLOG_TEST_PAYLOAD}"
  install_mocks "${TEST_DIR}/bin"
  export VANBLOG_TEST_LOG VANBLOG_TEST_FAIL_URLS VANBLOG_TEST_INVALID_URLS VANBLOG_TEST_PAYLOAD
  export PATH="${TEST_DIR}/bin:${PATH}"
  VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
}

source_script() {
  export VANBLOG_SKIP_MAIN=1
  # 这个文件测的是「下载编排文件/脚本的回退顺序」，不该去联网克隆源码或构建镜像。
  # 默认走官方镜像分支（prepare_vanblog_image 直接返回），源码构建那套在
  # vanblog-source-install.test.sh 里用假的 git/docker 单独测。
  export VANBLOG_USE_UPSTREAM_IMAGE=true
  export VANBLOG_SRC_DIR="${TEST_DIR}/src"
  # shellcheck disable=SC1090
  source "${SCRIPT}"
}

run_download_compose() {
  local dest="${1:-${VANBLOG_BASE_PATH}/docker-compose-template.yaml}"
  DOWNLOAD_OUT="$(download_compose_template "${dest}" 2>&1)"
  DOWNLOAD_RC=$?
}

run_download_script() {
  local dest="$1"
  DOWNLOAD_OUT="$(download_script "${dest}" 2>&1)"
  DOWNLOAD_RC=$?
}

echo "== vanblog.sh download fallback tests =="

if [[ ! -f "${SCRIPT}" ]]; then
  echo "missing ${SCRIPT}"
  exit 1
fi
if [[ ! -f "${TEMPLATE_FIXTURE}" ]]; then
  echo "missing ${TEMPLATE_FIXTURE}"
  exit 1
fi

assert_eq "$(cmp -s "${SCRIPT}" "${PUBLIC_SCRIPT}" && echo same || echo diff)" "same" "scripts/vanblog.sh matches docs public copy"

# --- fallback order: **fork 优先** ---
# 本分支三源（GitHub raw → jsDelivr gh/CKboss → Release 附件）全部试过之后，
# 才允许退到上游（文档站 → 上游 raw → 上游 jsDelivr）。原因：本分支的 raw 地址就是
# raw.githubusercontent.com，国内常常不通 —— 以前的顺序会在那里静默退到上游产物。
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
mapfile -t COMPOSE_URL_LIST < <(compose_template_urls)
mapfile -t SCRIPT_URL_LIST < <(script_urls)
assert_eq "${#COMPOSE_URL_LIST[@]}" "6" "compose fallback list has 6 URLs"
assert_eq "${COMPOSE_URL_LIST[0]}" "https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml" "compose #1 is the fork raw file on dev/dsh"
assert_eq "${COMPOSE_URL_LIST[1]}" "https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/docker-compose/docker-compose-template.yml" "compose #2 is the fork's jsDelivr mirror (raw is often blocked in CN)"
assert_eq "${COMPOSE_URL_LIST[2]}" "https://github.com/CKboss/vanblog/releases/latest/download/docker-compose-template.yml" "compose #3 is the fork's Release asset (release-fork.yml attaches docker-compose-template.yml)"
assert_eq "${COMPOSE_URL_LIST[3]}" "https://vanblog.mereith.com/docker-compose-template.yml" "compose #4 (first upstream) is the docs host"
assert_eq "${COMPOSE_URL_LIST[4]}" "https://raw.githubusercontent.com/Mereithhh/vanblog/master/docker-compose/docker-compose-template.yml" "compose #5 is upstream GitHub raw"
assert_eq "${COMPOSE_URL_LIST[5]}" "https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/docker-compose/docker-compose-template.yml" "compose #6 is upstream jsDelivr"
assert_eq "${#SCRIPT_URL_LIST[@]}" "6" "script fallback list has 6 URLs"
assert_eq "${SCRIPT_URL_LIST[0]}" "https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh" "script #1 is the fork raw file on dev/dsh"
assert_eq "${SCRIPT_URL_LIST[1]}" "https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/scripts/vanblog.sh" "script #2 is the fork's jsDelivr mirror"
assert_eq "${SCRIPT_URL_LIST[2]}" "https://github.com/CKboss/vanblog/releases/latest/download/vanblog.sh" "script #3 is the fork's Release asset (release-fork.yml attaches vanblog.sh)"
assert_eq "${SCRIPT_URL_LIST[3]}" "https://vanblog.mereith.com/vanblog.sh" "script #4 (first upstream) is the docs host"
assert_eq "${SCRIPT_URL_LIST[4]}" "https://raw.githubusercontent.com/Mereithhh/vanblog/master/scripts/vanblog.sh" "script #5 is upstream GitHub raw"
assert_eq "${SCRIPT_URL_LIST[5]}" "https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/scripts/vanblog.sh" "script #6 is upstream jsDelivr"
# 不变式：前三个必须都是 fork 自己的源（CKboss），后三个才轮到上游
fork_first_ok=1
for u in "${COMPOSE_URL_LIST[@]:0:3}" "${SCRIPT_URL_LIST[@]:0:3}"; do
  [[ "${u}" == *"CKboss/vanblog"* ]] || fork_first_ok=0
done
for u in "${COMPOSE_URL_LIST[@]:3:3}" "${SCRIPT_URL_LIST[@]:3:3}"; do
  [[ "${u}" == *"CKboss"* ]] && fork_first_ok=0
done
if [[ "${fork_first_ok}" == "1" ]]; then
  pass "前三条回退全是 fork 源、后三条才到上游（不会在 fork 镜像没试完时静默用上游产物）"
else
  fail "前三条回退全是 fork 源、后三条才到上游"
fi

# --- VANBLOG_RELEASE_TAG 覆盖：钉住 tag 时走 releases/download/<tag>/ ---
setup_case
VANBLOG_RELEASE_TAG="v2026.09" source_script
mapfile -t TAGGED_COMPOSE < <(compose_template_urls)
mapfile -t TAGGED_SCRIPT < <(script_urls)
assert_eq "${TAGGED_COMPOSE[2]}" "https://github.com/CKboss/vanblog/releases/download/v2026.09/docker-compose-template.yml" "VANBLOG_RELEASE_TAG pins the compose Release asset URL"
assert_eq "${TAGGED_SCRIPT[2]}" "https://github.com/CKboss/vanblog/releases/download/v2026.09/vanblog.sh" "VANBLOG_RELEASE_TAG pins the script Release asset URL"
unset VANBLOG_RELEASE_TAG

# --- VANBLOG_BRANCH 覆盖：jsDelivr 的分支跟着走 ---
setup_case
VANBLOG_BRANCH="dev/other" source_script
mapfile -t BR_COMPOSE < <(compose_template_urls)
assert_eq "${BR_COMPOSE[1]}" "https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/other/docker-compose/docker-compose-template.yml" "jsDelivr fallback follows VANBLOG_BRANCH"
unset VANBLOG_BRANCH

# --- primary success: only first URL, valid compose, prints which URL worked ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
run_download_compose
assert_eq "${DOWNLOAD_RC}" "0" "primary success exits 0"
assert_contains "${DOWNLOAD_OUT}" "下载成功: https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml" "primary success prints working URL"
assert_not_contains "${DOWNLOAD_OUT}" "vanblog.mereith.com" "primary success does not try the docs host"
assert_not_contains "${DOWNLOAD_OUT}" "jsdelivr" "primary success does not try jsDelivr"
assert_file_contains "${TEST_DIR}/vanblog/docker-compose-template.yaml" "services:" "primary success writes compose services"
assert_file_contains "${TEST_DIR}/vanblog/docker-compose-template.yaml" "vanblog:" "primary success writes vanblog service"
assert_file_contains "${VANBLOG_TEST_LOG}" "wget https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml" "primary success uses wget"
if grep -q 'vanblog.mereith.com' "${VANBLOG_TEST_LOG}"; then
  fail "primary success does not request fallback URLs"
else
  pass "primary success does not request fallback URLs"
fi

# --- failed primary + successful secondary (fork jsDelivr) writes a valid compose file ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
printf '%s\n' "https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml" >"${VANBLOG_TEST_FAIL_URLS}"
run_download_compose
assert_eq "${DOWNLOAD_RC}" "0" "secondary success exits 0"
assert_contains "${DOWNLOAD_OUT}" "该地址不可用: https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml" "secondary path reports primary failure"
assert_contains "${DOWNLOAD_OUT}" "下载成功: https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/docker-compose/docker-compose-template.yml" "secondary success prints the fork's jsDelivr URL"
assert_not_contains "${DOWNLOAD_OUT}" "vanblog.mereith.com" "secondary success never reaches the upstream docs host"
assert_not_contains "${DOWNLOAD_OUT}" "下载失败，已尝试全部地址" "secondary success is not an all-fail"
assert_file_contains "${TEST_DIR}/vanblog/docker-compose-template.yaml" "services:" "secondary success writes services"
assert_file_contains "${TEST_DIR}/vanblog/docker-compose-template.yaml" "vanblog_email" "secondary success writes template placeholders"
assert_file_contains "${TEST_DIR}/vanblog/docker-compose-template.yaml" "mongo:" "secondary success writes mongo service"
if [[ "$(url_attempt_order | tr '\n' ' ')" == "https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/docker-compose/docker-compose-template.yml " ]]; then
  pass "wget order is fork raw then fork jsDelivr"
else
  fail "wget order is fork raw then fork jsDelivr (got: $(url_attempt_order | tr '\n' '|'))"
fi
if grep -q 'mereith' "${VANBLOG_TEST_LOG}"; then
  fail "stopped after first successful fallback (no upstream requested)"
else
  pass "stopped after first successful fallback (no upstream requested)"
fi

# --- HTML/invalid primary is rejected and the fork's jsDelivr is used (still no upstream) ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
printf '%s\n' "https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml" >"${VANBLOG_TEST_INVALID_URLS}"
run_download_compose
assert_eq "${DOWNLOAD_RC}" "0" "invalid primary then fork jsDelivr exits 0"
assert_contains "${DOWNLOAD_OUT}" "该地址不可用: https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml" "HTML primary is treated as unavailable"
assert_contains "${DOWNLOAD_OUT}" "下载成功: https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/docker-compose/docker-compose-template.yml" "HTML primary falls through to the fork's jsDelivr, not upstream"
assert_file_contains "${TEST_DIR}/vanblog/docker-compose-template.yaml" "services:" "HTML primary still yields valid compose"
assert_file_not_contains "${TEST_DIR}/vanblog/docker-compose-template.yaml" "<html>" "HTML error page is not kept"

# --- all three fork sources fail → first upstream (docs host) is used, and only then ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
cat >"${VANBLOG_TEST_FAIL_URLS}" <<EOF
https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml
https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/docker-compose/docker-compose-template.yml
https://github.com/CKboss/vanblog/releases/latest/download/docker-compose-template.yml
EOF
run_download_compose
assert_eq "${DOWNLOAD_RC}" "0" "upstream docs-host fallback exits 0"
assert_contains "${DOWNLOAD_OUT}" "下载成功: https://vanblog.mereith.com/docker-compose-template.yml" "after all fork sources fail, the docs host wins"
assert_file_contains "${TEST_DIR}/vanblog/docker-compose-template.yaml" "vanblog:" "docs-host fallback writes compose"
if [[ "$(url_attempt_order | wc -l | tr -d ' ')" == "4" ]]; then
  pass "exactly the 3 fork URLs then the docs host were attempted"
else
  fail "exactly the 3 fork URLs then the docs host were attempted (got $(url_attempt_order | wc -l))"
fi
# 上游源只该在 fork 三源都失败之后出现（顺序不变式）
first_upstream_line="$(grep -n 'mereith' "${VANBLOG_TEST_LOG}" | head -1 | cut -d: -f1)"
last_fork_line="$(grep -n 'CKboss' "${VANBLOG_TEST_LOG}" | tail -1 | cut -d: -f1)"
if [[ -n "${first_upstream_line}" && -n "${last_fork_line}" && "${first_upstream_line}" -gt "${last_fork_line}" ]]; then
  pass "upstream URLs are only requested after every fork URL failed"
else
  fail "upstream URLs are only requested after every fork URL failed"
fi

# --- all compose URLs fail: non-zero and clear error, no leftover compose ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
cat >"${VANBLOG_TEST_FAIL_URLS}" <<EOF
https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml
https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/docker-compose/docker-compose-template.yml
https://github.com/CKboss/vanblog/releases/latest/download/docker-compose-template.yml
https://vanblog.mereith.com/docker-compose-template.yml
https://raw.githubusercontent.com/Mereithhh/vanblog/master/docker-compose/docker-compose-template.yml
https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/docker-compose/docker-compose-template.yml
EOF
run_download_compose "${TEST_DIR}/vanblog/docker-compose-template.yaml"
assert_eq "${DOWNLOAD_RC}" "1" "all-fail exits 1"
assert_contains "${DOWNLOAD_OUT}" "下载失败，已尝试全部地址" "all-fail prints clear error"
assert_contains "${DOWNLOAD_OUT}" "该地址不可用: https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml" "all-fail mentions the fork raw URL"
assert_contains "${DOWNLOAD_OUT}" "该地址不可用: https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/docker-compose/docker-compose-template.yml" "all-fail mentions the fork jsDelivr URL"
assert_contains "${DOWNLOAD_OUT}" "该地址不可用: https://github.com/CKboss/vanblog/releases/latest/download/docker-compose-template.yml" "all-fail mentions the fork Release asset URL"
assert_contains "${DOWNLOAD_OUT}" "该地址不可用: https://vanblog.mereith.com/docker-compose-template.yml" "all-fail mentions docs host"
assert_contains "${DOWNLOAD_OUT}" "该地址不可用: https://raw.githubusercontent.com/Mereithhh/vanblog/master/docker-compose/docker-compose-template.yml" "all-fail mentions GitHub"
assert_contains "${DOWNLOAD_OUT}" "该地址不可用: https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/docker-compose/docker-compose-template.yml" "all-fail mentions upstream jsDelivr"
assert_not_contains "${DOWNLOAD_OUT}" "下载成功:" "all-fail does not print success"
if [[ -e "${TEST_DIR}/vanblog/docker-compose-template.yaml" ]]; then
  fail "all-fail does not leave a compose template"
else
  pass "all-fail does not leave a compose template"
fi
if [[ "$(url_attempt_order | wc -l | tr -d ' ')" == "6" ]]; then
  pass "all-fail tries every compose URL (6)"
else
  fail "all-fail tries every compose URL (got $(url_attempt_order | wc -l))"
fi

# --- config() download failure returns non-zero and does not prompt ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
cat >"${VANBLOG_TEST_FAIL_URLS}" <<EOF
https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml
https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/docker-compose/docker-compose-template.yml
https://github.com/CKboss/vanblog/releases/latest/download/docker-compose-template.yml
https://vanblog.mereith.com/docker-compose-template.yml
https://raw.githubusercontent.com/Mereithhh/vanblog/master/docker-compose/docker-compose-template.yml
https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/docker-compose/docker-compose-template.yml
EOF
CONFIG_OUT="$(config 0 2>&1)" || CONFIG_RC=$?
CONFIG_RC="${CONFIG_RC:-0}"
assert_eq "${CONFIG_RC}" "1" "config all-fail exits 1"
assert_contains "${CONFIG_OUT}" "下载编排文件失败" "config all-fail prints compose download error"
assert_not_contains "${CONFIG_OUT}" "请输入您的邮箱" "config all-fail does not continue to prompts"

# --- script self-update: failed fork raw + successful fork jsDelivr (never upstream) ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
printf '%s\n' "https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh" >"${VANBLOG_TEST_FAIL_URLS}"
cat "${SCRIPT}" >"${VANBLOG_TEST_PAYLOAD}"
run_download_script "${TEST_DIR}/vanblog.sh"
assert_eq "${DOWNLOAD_RC}" "0" "script fork-jsDelivr fallback exits 0"
assert_contains "${DOWNLOAD_OUT}" "该地址不可用: https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh" "script fallback reports the fork raw URL failure"
assert_contains "${DOWNLOAD_OUT}" "下载成功: https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/scripts/vanblog.sh" "script fallback uses the fork's jsDelivr before any upstream"
assert_file_contains "${TEST_DIR}/vanblog.sh" "VANBLOG_SCRIPT_VERSION" "script fallback writes a vanblog script"
assert_file_contains "${TEST_DIR}/vanblog.sh" "download_compose_template" "script fallback writes current helper"

# --- script self-update all-fail ---
setup_case
source_script
VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
cat >"${VANBLOG_TEST_FAIL_URLS}" <<EOF
https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh
https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/scripts/vanblog.sh
https://github.com/CKboss/vanblog/releases/latest/download/vanblog.sh
https://vanblog.mereith.com/vanblog.sh
https://raw.githubusercontent.com/Mereithhh/vanblog/master/scripts/vanblog.sh
https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/scripts/vanblog.sh
EOF
cat "${SCRIPT}" >"${VANBLOG_TEST_PAYLOAD}"
run_download_script "${TEST_DIR}/vanblog.sh"
assert_eq "${DOWNLOAD_RC}" "1" "script all-fail exits 1"
assert_contains "${DOWNLOAD_OUT}" "下载失败，已尝试全部地址" "script all-fail prints clear error"
if [[ -e "${TEST_DIR}/vanblog.sh" ]]; then
  fail "script all-fail does not leave a partial script"
else
  pass "script all-fail does not leave a partial script"
fi

stub_install_vanblog() {
  VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
  VANBLOG_DATA_PATH="${TEST_DIR}/vanblog/data"
  install_base() { :; }
  prepare_vanblog_image() {
    echo "prepare_vanblog_image"
    return 0
  }
  config() {
    echo "config $*"
    return "${CONFIG_STUB_RC:-0}"
  }
  before_show_menu() {
    echo "before_show_menu"
  }
  cat >"${TEST_DIR}/bin/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "${TEST_DIR}/bin/docker"
  # 脚本现在只有在「没有 docker-compose 命令」时才会去写 /usr/local/bin/docker-compose，
  # 测试里不该碰真实路径，所以沙箱内直接提供一个假的 docker-compose
  cat >"${TEST_DIR}/bin/docker-compose" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "${TEST_DIR}/bin/docker-compose"
}

# --- menu install (no args) still returns to the menu after config succeeds ---
setup_case
source_script
CONFIG_STUB_RC=0
stub_install_vanblog
INSTALL_OUT="$(install_vanblog 2>&1)"
INSTALL_RC=$?
assert_eq "${INSTALL_RC}" "0" "menu install success exits 0"
assert_contains "${INSTALL_OUT}" "config 0" "menu install runs config"
assert_contains "${INSTALL_OUT}" "before_show_menu" "menu install returns to menu on success"

# --- CLI install (with arg) does not return to the menu on success ---
setup_case
source_script
CONFIG_STUB_RC=0
stub_install_vanblog
INSTALL_OUT="$(install_vanblog 0 2>&1)"
INSTALL_RC=$?
assert_eq "${INSTALL_RC}" "0" "CLI install success exits 0"
assert_contains "${INSTALL_OUT}" "config 0" "CLI install runs config"
assert_not_contains "${INSTALL_OUT}" "before_show_menu" "CLI install does not return to menu on success"

# --- menu install still returns to the menu when config fails ---
setup_case
source_script
CONFIG_STUB_RC=1
stub_install_vanblog
INSTALL_OUT="$(install_vanblog 2>&1)" || INSTALL_RC=$?
INSTALL_RC="${INSTALL_RC:-0}"
assert_eq "${INSTALL_RC}" "1" "menu install config-fail exits 1"
assert_contains "${INSTALL_OUT}" "安装失败：未能下载编排文件" "menu install config-fail prints error"
assert_contains "${INSTALL_OUT}" "before_show_menu" "menu install returns to menu on config failure"

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
