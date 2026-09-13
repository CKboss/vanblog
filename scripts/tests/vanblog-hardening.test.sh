#!/usr/bin/env bash
# 部署审计（2026-09）修掉的那批坑的回归测试。
#
# 每一条都对应一个真实会发生、而且**用户看不出来**的故障：
#   B1 改个邮箱就把本 fork 的镜像悄悄换成上游官方镜像（产品被替换，无任何提示）
#   B2 restart/start/stop 永远返回 0 → 到处打印"成功"，而 restore 会因此
#      在 mongod 还活着的时候解压覆盖数据目录（唯一一条真的会毁数据的路径）
#   B3 自更新只 grep 一个版本号就覆盖自身 → 一次截断的下载能把唯一可用的脚本变成残骸
#   M1 VANBLOG_DATA_PATH_RAW 写死 /var/vanblog/data → 换数据目录后编排文件与
#      backup/restore 各写各的地方
#   M2 clone 前无条件 rm -rf "${VANBLOG_SRC_DIR}" → 指向自己的源码树时整个删掉
#   M3 编排模板校验太松 → 截断的模板能过，生成一份没有 mongo 的编排文件
#   m1 邮箱里的 & 在 sed 替换文本中会被展开成整个匹配 → ACME 拿到非法邮箱
#   m2 端口解析把 "3000:8080" 当成 80 → restore 探错端口
#   m3 wget --no-check-certificate（下载的是编排模板与脚本自己，且脚本以 root 运行）
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"
PUBLIC_SCRIPT="${ROOT}/docs/.vuepress/public/vanblog.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_contains() { if printf '%s' "$1" | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }
assert_not_contains() { if printf '%s' "$1" | grep -qF -- "$2"; then fail "$3 (unexpected: $2)"; else pass "$3"; fi; }
assert_file_contains() { if grep -qF -- "$2" "$1"; then pass "$3"; else fail "$3 (missing in $1: $2)"; fi; }
assert_file_not_contains() { if grep -qF -- "$2" "$1"; then fail "$3 (unexpected in $1: $2)"; else pass "$3"; fi; }

echo "== vanblog.sh 部署加固回归测试 =="
# 源码层面的反向断言统一用剥掉注释的副本：新加的注释里正好引用了旧写法
# （mv -f /tmp/vanblog.sh、--no-check-certificate），不剥就会自己匹配自己
# （本仓库第四次踩这个坑）。定义放在最前面，因为多处断言都要用。
# ⚠️ sed 的分隔符不能用 #：脚本里的注释正是以 # 开头，用 # 当分隔符会让模式被截断
#    （`s#^[[:space:]]*#.*##` 实际是"把行首空白替换成 .*"），注释根本没被剥掉。
SCRIPT_CODE="$(sed 's|^[[:space:]]*#.*||' "${SCRIPT}")"

assert_eq "$(cmp -s "${SCRIPT}" "${PUBLIC_SCRIPT}" && echo same || echo diff)" "same" "两份 vanblog.sh 字节一致"

setup_case() {
  TEST_DIR="$(mktemp -d)"
  CMDLOG="${TEST_DIR}/commands.log"
  : >"${CMDLOG}"
  mkdir -p "${TEST_DIR}/bin" "${TEST_DIR}/vanblog"
  cat >"${TEST_DIR}/bin/git" <<'GIT'
#!/usr/bin/env bash
echo "git $*" >>"${CMDLOG}"
sub="$1"; shift || true
case "${sub}" in
  clone) dest="${!#}"; mkdir -p "${dest}/.git" "${dest}/docker-compose"; echo "FROM scratch" >"${dest}/Dockerfile" ;;
  -C) dir="$1"; shift; mkdir -p "${dir}/.git"; [[ -f "${dir}/Dockerfile" ]] || echo "FROM scratch" >"${dir}/Dockerfile" ;;
esac
exit 0
GIT
  # 假 docker-compose：DOCKER_COMPOSE_FAIL=1 时全部失败
  cat >"${TEST_DIR}/bin/docker-compose" <<'DC'
#!/usr/bin/env bash
echo "docker-compose $*" >>"${CMDLOG}"
[[ "${DOCKER_COMPOSE_FAIL:-0}" == "1" ]] && exit 1
exit 0
DC
  cat >"${TEST_DIR}/bin/docker" <<'DK'
#!/usr/bin/env bash
echo "docker $*" >>"${CMDLOG}"
[[ "${DOCKER_FAIL:-0}" == "1" && "$1" == "rmi" ]] && exit 1
exit 0
DK
  chmod +x "${TEST_DIR}/bin/git" "${TEST_DIR}/bin/docker-compose" "${TEST_DIR}/bin/docker"
  export PATH="${TEST_DIR}/bin:${PATH}"
  # 菜单交互一律短路
  before_show_menu() { :; }
}

source_script() {
  export VANBLOG_SKIP_MAIN=1
  export VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
  export VANBLOG_DATA_PATH="${TEST_DIR}/vanblog/data"
  unset VANBLOG_USE_UPSTREAM_IMAGE VANBLOG_IMAGE_REF VANBLOG_INSTALL_MODE DOCKER_COMPOSE_FAIL
  # ⚠️ RAW 是在 source 时用 ${VANBLOG_DATA_PATH_RAW:-…} 算的：不 unset 的话，
  # 同一个 shell 里第二次 source（换了 TEST_DIR）会沿用上一次的旧值
  unset VANBLOG_DATA_PATH_RAW
  # shellcheck disable=SC1090
  source "${SCRIPT}"
  before_show_menu() { :; }
}

# ---------- B1：config 不许把镜像换回上游官方镜像 ----------
setup_case
source_script
# config 第一步会去下载编排模板，测试环境没网 —— 用桩函数把它换成本地 fixture
TEMPLATE_FIXTURE="${TEST_DIR}/template.yml"
cat >"${TEMPLATE_FIXTURE}" <<'YML'
services:
  vanblog:
    image: vanblog_image
    ports:
      - vanblog_http_port:80
      - vanblog_https_port:443
    volumes:
      - vanblog_data_path/data/static:/app/static
    environment:
      EMAIL: vanblog_email
  mongo:
    image: mongo:4.4.16
YML
download_compose_template() { cp "${TEMPLATE_FIXTURE}" "$1"; }
cat >"${VANBLOG_BASE_PATH}/docker-compose-template.yaml" <<'YML'
services:
  vanblog:
    image: vanblog_image
    ports:
      - vanblog_http_port:80
      - vanblog_https_port:443
    volumes:
      - vanblog_data_path/data/static:/app/static
    environment:
      EMAIL: vanblog_email
  mongo:
    image: mongo:4.4.16
YML
cat >"${VANBLOG_BASE_PATH}/docker-compose.yaml" <<'YML'
services:
  vanblog:
    image: ghcr.io/ckboss/vanblog:dev-dsh
    ports:
      - 8080:80
YML
printf 'a&b@example.com\n8080\n8443\n' | config >"${TEST_DIR}/config.out" 2>&1
assert_file_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "image: ghcr.io/ckboss/vanblog:dev-dsh" \
  "config 沿用编排文件里现有的镜像（不换回上游官方镜像）"
assert_file_not_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "mereith/van-blog" \
  "config 之后编排文件里没有上游镜像"
# m1：邮箱里的 & 不能被 sed 展开成整个匹配
assert_file_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "EMAIL: a&b@example.com" \
  "邮箱里的 & 原样写入（sed 替换文本已转义）"
assert_file_not_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "avanblog_emailb" \
  "没有出现 & 被展开成匹配串的痕迹"
assert_file_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "8080:80" "端口占位符被替换"
assert_file_contains "${VANBLOG_BASE_PATH}/docker-compose.yaml" "${VANBLOG_DATA_PATH}/data/static" \
  "M1：卷路径跟着 VANBLOG_DATA_PATH 走，不再写死 /var/vanblog/data"
assert_not_contains "$(cat "${VANBLOG_BASE_PATH}/docker-compose.yaml")" "/var/vanblog/data" \
  "M1：编排文件里没有写死的默认数据目录"

# ---------- B2：生命周期函数必须把失败返回出去 ----------
setup_case
source_script
export DOCKER_COMPOSE_FAIL=1
restart 0 >/dev/null 2>&1
if [[ $? -ne 0 ]]; then pass "restart 在 docker-compose 失败时返回非 0"; else fail "restart 在 docker-compose 失败时返回非 0"; fi
start_vanblog 0 >/dev/null 2>&1
if [[ $? -ne 0 ]]; then pass "start_vanblog 失败时返回非 0"; else fail "start_vanblog 失败时返回非 0"; fi
stop_vanblog 0 >/dev/null 2>&1
if [[ $? -ne 0 ]]; then pass "stop_vanblog 失败时返回非 0（restore 靠它判断能不能解压）"; else fail "stop_vanblog 失败时返回非 0"; fi
unset DOCKER_COMPOSE_FAIL
restart 0 >/dev/null 2>&1
assert_eq "$?" "0" "正常时 restart 返回 0"

# ---------- B2：停不下来就不许解压（唯一一条会毁数据的路径）----------
setup_case
source_script
export DOCKER_COMPOSE_FAIL=1
mkdir -p "${TEST_DIR}/payload/data"
echo x >"${TEST_DIR}/payload/data/f.txt"
(cd "${TEST_DIR}/payload" && tar czf "${TEST_DIR}/old.tar.gz" data) >/dev/null 2>&1
OUT="$(VANBLOG_ASSUME_YES=1 restore 0 "${TEST_DIR}/old.tar.gz" 2>&1)"
if [[ $? -ne 0 ]]; then pass "停服失败时离线恢复直接中止"; else fail "停服失败时离线恢复直接中止"; fi
assert_contains "${OUT}" "停不下来就不解压" "中止时说清楚了原因"
assert_not_contains "$(cat "${CMDLOG}")" "tar" "中止时没有解压动作"
unset DOCKER_COMPOSE_FAIL

# ---------- B3：自更新不能把唯一一份可用脚本毁掉 ----------
setup_case
source_script
good="${TEST_DIR}/good.sh"
cp "${SCRIPT}" "${good}"
if is_valid_vanblog_script "${good}"; then pass "完整脚本通过校验"; else fail "完整脚本通过校验"; fi
head -n 20 "${SCRIPT}" >"${TEST_DIR}/truncated.sh"   # 只下载了前 20 行（里面就有版本号）
if is_valid_vanblog_script "${TEST_DIR}/truncated.sh"; then
  fail "截断到 20 行的脚本不该通过校验（旧实现只 grep 版本号，会用它覆盖掉好脚本）"
else
  pass "截断脚本被拒（bash -n + 首尾标志）"
fi
printf '#!/usr/bin/env bash\nVANBLOG_SCRIPT_VERSION="v9.9.9"\nexit 0\n' >"${TEST_DIR}/stub.sh"
if is_valid_vanblog_script "${TEST_DIR}/stub.sh"; then
  fail "只有版本号、没有 show_menu 的残骸不该通过校验"
else
  pass "缺少结尾标志的残骸被拒"
fi
assert_file_contains "${SCRIPT}" "VANBLOG_SELF_PATH" "自更新覆盖的是脚本自身的绝对路径，而不是 ./vanblog.sh"
assert_not_contains "${SCRIPT_CODE}" "mv -f /tmp/vanblog.sh ./vanblog.sh" "不再用固定 /tmp 路径 + CWD 相对路径覆盖自身"
assert_not_contains "${SCRIPT_CODE}" "exec ./vanblog.sh" "不再 exec CWD 相对路径"
assert_file_contains "${SCRIPT}" 'mktemp "${TMPDIR:-/tmp}/vanblog-script.XXXXXX"' "下载用 mktemp（固定 /tmp 文件名可被软链攻击）"
assert_file_contains "${SCRIPT}" 'if [[ "${new_version}" == "${VANBLOG_SCRIPT_VERSION}" ]]' "版本相同就不替换"

# ---------- M2：clone 前的 rm -rf 要有护栏 ----------
setup_case
source_script
export VANBLOG_SRC_DIR="${TEST_DIR}/my-own-source"
mkdir -p "${VANBLOG_SRC_DIR}/packages"
echo "precious" >"${VANBLOG_SRC_DIR}/README.md"
OUT="$(clone_or_update_source 2>&1)"
if [[ $? -ne 0 ]]; then pass "已存在但不是 git 仓库的源码目录：拒绝删除并报错"; else fail "已存在但不是 git 仓库的源码目录应拒绝"; fi
assert_contains "${OUT}" "不会自动删除" "拒绝时说清楚了不会删"
if [[ -f "${VANBLOG_SRC_DIR}/README.md" ]]; then pass "用户自己的文件没有被删"; else fail "用户自己的文件被删了"; fi
unset VANBLOG_SRC_DIR

# ---------- M3：编排模板校验 ----------
setup_case
source_script
printf 'services:\n  vanblog:\n    image: vanblog_image\n' >"${TEST_DIR}/truncated.yml"
if is_valid_compose_template "${TEST_DIR}/truncated.yml"; then
  fail "缺 mongo 与占位符的截断模板不该通过校验"
else
  pass "截断的编排模板被拒（否则 config 会生成一份没有 mongo 的编排文件）"
fi
if is_valid_compose_template "${VANBLOG_BASE_PATH}/docker-compose-template.yaml" 2>/dev/null ||
  is_valid_compose_template "${ROOT}/docker-compose/docker-compose-template.yml"; then
  pass "仓库里的编排模板通过校验"
else
  fail "仓库里的编排模板没通过校验"
fi

# ---------- m2：端口解析不能把 :8080 当成 :80 ----------
setup_case
source_script
cat >"${VANBLOG_BASE_PATH}/docker-compose.yaml" <<'YML'
services:
  vanblog:
    image: x
    ports:
      - "3000:8080"
      - "8081:80"
      - "8443:443"
YML
assert_eq "$(get_compose_http_port)" "8081" "端口解析取映射到容器 80 的那个（不被 :8080 前缀骗到）"

# ---------- m3 / M5 / m4：源码层面的不变式 ----------
# ⚠️ 断言前剥注释：新加的注释里正好写着"以前是 mv -f /tmp/vanblog.sh ./vanblog.sh"
#    "以前给 wget 加了 --no-check-certificate"，不剥就会自己匹配自己（本仓库第四次踩这个坑）
assert_not_contains "${SCRIPT_CODE}" "--no-check-certificate" "下载不再关闭 TLS 校验"
assert_file_contains "${SCRIPT}" "if ! docker info >/dev/null 2>&1; then" "装完 docker 会确认 daemon 真的可用"
if printf '%s' "${SCRIPT_CODE}" | grep -A1 'Docker 安装失败' | grep -q 'exit 0'; then
  fail "docker 装不上仍然 exit 0（自动化流程会误判成功）"
else
  pass "docker 装不上时不再 exit 0"
fi
assert_file_contains "${SCRIPT}" 'docker rmi -f "${VANBLOG_IMAGE_REF}"' "卸载会删本分支的 ghcr 镜像"
assert_file_contains "${SCRIPT}" 'docker rmi -f "${VANBLOG_IMAGE_TAG}"' "卸载会删本地构建的镜像"
assert_file_contains "${SCRIPT}" "已移除本脚本创建的 docker-compose 兼容 shim" "卸载会清掉自己建的 shim（且只清自己建的）"
assert_file_contains "${SCRIPT}" "getenforce" "SELinux Enforcing 时会提示（bind mount 没有 :z）"

# ---------- mongo 版本：已有数据绝不擅自换大版本 ----------
setup_case
source_script
printf 'services:\n  vanblog:\n    image: x\n  mongo:\n    image: mongo:4.4.16\n' \
  >"${VANBLOG_BASE_PATH}/docker-compose.yaml"
assert_eq "$(get_compose_mongo_image)" "mongo:4.4.16" "能读出现有编排文件里的 mongo 版本"
assert_eq "$(pick_mongo_image)" "mongo:7.0" "全新安装（没有数据目录）用受支持的 mongo:7.0"
mkdir -p "${VANBLOG_DATA_PATH}/data/mongo"
touch "${VANBLOG_DATA_PATH}/data/mongo/WiredTiger" "${VANBLOG_DATA_PATH}/data/mongo/mongod.lock"
assert_eq "$(pick_mongo_image)" "mongo:4.4.16" \
  "已有数据时保持原版本（换大版本 mongod 会拒绝启动，看起来像数据全丢）"
assert_eq "$(VANBLOG_MONGO_IMAGE=mongo:6.0 pick_mongo_image)" "mongo:4.4.16" \
  "已有数据时连环境变量覆盖也不听（要走升级就得先迁数据）"
rm -rf "${VANBLOG_DATA_PATH}/data/mongo"
mkdir -p "${VANBLOG_DATA_PATH}/data/mongo"
assert_eq "$(pick_mongo_image)" "mongo:7.0" "空的数据目录算全新安装（这正是备份迁移升级的路径）"
assert_eq "$(VANBLOG_MONGO_IMAGE=mongo:6.0 pick_mongo_image)" "mongo:6.0" "全新安装时 VANBLOG_MONGO_IMAGE 生效"
# 只有 mongo 的空壳文件不算数据（比如上次启动失败留下的 mongod.lock）
rm -rf "${VANBLOG_DATA_PATH}/data/mongo"
mkdir -p "${VANBLOG_DATA_PATH}/data/mongo/subdir"
touch "${VANBLOG_DATA_PATH}/data/mongo/subdir/x.txt"
assert_eq "$(pick_mongo_image)" "mongo:7.0" "目录里只有无关文件时仍算全新安装"


echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
