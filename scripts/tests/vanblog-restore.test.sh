#!/usr/bin/env bash
# 整站备份（vanblog-full-*）的一步恢复：./vanblog.sh restore
#
# 这条路径以前是不存在的 —— 脚本的 restore 只会把 vanblog-backup-*.tar.gz（数据目录的
# 原始 tar 包）停服解压回去，而 server 导出的 vanblog-full-*.tar.zst 是**各集合的 NDJSON +
# 图床 + 清单**，只能由 server 的 /api/admin/backup/full/restore 还原（按集合原子替换、
# 重建索引、触发全量渲染）。所以脚本现在会分流：整站备份走 HTTP，老格式仍走离线解压。
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

setup_case() {
  TEST_DIR="$(mktemp -d)"
  CMDLOG="${TEST_DIR}/commands.log"
  APILOG="${TEST_DIR}/api.log"
  : >"${CMDLOG}"
  : >"${APILOG}"
  mkdir -p "${TEST_DIR}/vanblog" "${TEST_DIR}/backups"
  # 一份假的整站备份 + 它的 sidecar 清单（清单必须被列表忽略）
  echo "fake-archive" >"${TEST_DIR}/backups/vanblog-full-20260913-172338.tar.zst"
  echo '{}' >"${TEST_DIR}/backups/vanblog-full-20260913-172338.tar.zst.manifest.json"
  # 一份老格式的数据目录备份
  mkdir -p "${TEST_DIR}/payload/data"
  echo hello >"${TEST_DIR}/payload/data/x.txt"
  (cd "${TEST_DIR}/payload" && tar czf "${TEST_DIR}/backups/vanblog-backup-20260101000000.tar.gz" data) >/dev/null 2>&1
  cat >"${TEST_DIR}/vanblog/docker-compose.yaml" <<'YML'
services:
  vanblog:
    image: ghcr.io/ckboss/vanblog:dev-dsh
    ports:
      - "8080:80"
      - "8443:443"
  mongo:
    image: mongo
YML
}

source_script() {
  export VANBLOG_SKIP_MAIN=1
  export VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
  export VANBLOG_DATA_PATH="${TEST_DIR}/data"
  export VANBLOG_BACKUP_DIR="${TEST_DIR}/backups"
  export VANBLOG_API_BASE="http://127.0.0.1:9999"
  export VANBLOG_ADMIN_TOKEN="test-token"
  unset VANBLOG_RESTORE_FILE
  # shellcheck disable=SC1090
  source "${SCRIPT}"
  # 别真的停服/起服
  stop_vanblog() { echo "stop_vanblog" >>"${CMDLOG}"; }
  start_vanblog() { echo "start_vanblog" >>"${CMDLOG}"; }
}

# 假 curl：把请求记下来，并按 URL 返回固定的 JSON
install_fake_curl() {
  cat >"${TEST_DIR}/curl" <<FAKE
#!/usr/bin/env bash
echo "curl \$*" >>"${APILOG}"
args="\$*"
case "\${args}" in
  */api/public/meta*) printf '200' ;;
  */api/admin/auth/login*) printf '{"statusCode":200,"data":{"token":"tok-from-login"}}' ;;
  */api/admin/backup/full/inspect*) printf '{"statusCode":200,"data":{"kind":"vanblog-full-backup","createdAt":"2026-09-13T09:23:37.560Z","databases":{"vanBlog":{"collections":{"articles":{"count":59}}}}}}' ;;
  */api/admin/backup/full/export*)
    printf '{"statusCode":200,"data":{"name":"vanblog-full-20260913-181937.tar.zst","bytes":69111933,"size":"65.91 MB","format":"zstd","compressor":"zstd -19","seconds":29.9,"totals":{"databases":2,"collections":15,"documents":9838,"files":185}}}' ;;
  */api/admin/backup/full/restore*)
    printf '{"statusCode":200,"data":{"restoredAt":"2026-09-13T09:30:00.000Z","seconds":12.3,"uploaded":false,"databases":{"vanBlog":{"collections":15,"documents":9838}},"static":{"files":185},"notes":[]}}' ;;
  *) printf '{"statusCode":500}' ;;
esac
exit 0
FAKE
  chmod +x "${TEST_DIR}/curl"
  export PATH="${TEST_DIR}:${PATH}"
}

echo "== vanblog.sh 整站恢复测试 =="
assert_eq "$(cmp -s "${SCRIPT}" "${PUBLIC_SCRIPT}" && echo same || echo diff)" "same" "两份 vanblog.sh 字节一致"

# --- 1) 登录口令派生必须和后台的 encryptPwd.js 逐字节一致 ---
NODE_BIN=""
for cand in node "${ROOT}/.tools/node20/bin/node"; do
  if command -v "${cand}" >/dev/null 2>&1; then NODE_BIN="${cand}"; break; fi
done
SHA_DIR="$(ls -d "${ROOT}"/node_modules/.pnpm/js-sha256@*/node_modules/js-sha256 2>/dev/null | head -1)"
if [[ -n "${NODE_BIN}" && -n "${SHA_DIR}" ]]; then
  setup_case
  source_script
  for pair in "JiangOil|test-password-123" "admin|p@ss w0rd" "用户甲|密码漢字"; do
    u="${pair%%|*}"
    pw="${pair##*|}"
    js="$(U="${u}" P="${pw}" SHA="${SHA_DIR}" "${NODE_BIN}" -e '
const { sha256 } = require(process.env.SHA);
const u = process.env.U.toLowerCase(), p = process.env.P;
const h1 = sha256(p), h2 = sha256(h1), h3 = sha256(h2), h4 = sha256(h3), hu = sha256(u);
process.stdout.write(sha256(u + h4 + hu));
')"
    sh="$(derive_login_password "${u}" "${pw}")"
    assert_eq "${sh}" "${js}" "派生口令与后台 encryptPwd.js 一致（user=${u}）"
  done
  # 用户名大小写不敏感（后台会 toLowerCase）
  assert_eq "$(derive_login_password 'Admin' 'x')" "$(derive_login_password 'admin' 'x')" "用户名按小写归一"
else
  echo "NOTE: 没有 node/js-sha256，跳过与 encryptPwd.js 的逐字节比对"
fi

# --- 2) 接口地址与端口 ---
setup_case
source_script
unset VANBLOG_API_BASE
assert_eq "$(get_compose_http_port)" "8080" "从编排文件读出映射到容器 80 的宿主机端口"
assert_eq "$(vanblog_api_base)" "http://127.0.0.1:8080" "默认接口地址用读出来的端口"
VANBLOG_API_BASE="http://blog.example.com/"
assert_eq "$(vanblog_api_base)" "http://blog.example.com" "VANBLOG_API_BASE 生效且去掉尾斜杠"

# --- 3) 目标分流 ---
setup_case
source_script
for t in vanblog-full-20260913-172338.tar.zst /tmp/x/vanblog-full-1.tar.zst a.tar.zst b.tar.xz; do
  if is_full_backup_target "${t}"; then pass "整站备份：${t}"; else fail "整站备份：${t}"; fi
done
for t in vanblog-backup-20260101000000.tar.gz old.tgz; do
  if is_full_backup_target "${t}"; then fail "老格式不该走接口：${t}"; else pass "老格式走离线解压：${t}"; fi
done

# --- 4) 备份列表：忽略 sidecar 清单，输出裸名字 ---
setup_case
source_script
picked="$(pick_full_backup <<<"1")"
assert_eq "${picked}" "vanblog-full-20260913-172338.tar.zst" "选择后输出归档名（不是路径，这样恢复时不用上传）"
listing="$(pick_full_backup <<<"" 2>&1 >/dev/null || true)"
assert_not_contains "${listing}" "manifest.json" "列表里不出现 .manifest.json sidecar"
assert_contains "${listing}" "vanblog-full-20260913-172338.tar.zst" "列表里有真正的归档"

# --- 5) 一步恢复：走接口，先 inspect 再 restore，带 confirm ---
setup_case
source_script
install_fake_curl
VANBLOG_ASSUME_YES=1
OUT="$(restore 0 vanblog-full-20260913-172338.tar.zst 2>&1)"
assert_eq "$?" "0" "按名字恢复成功"
assert_file_contains "${APILOG}" "/api/admin/backup/full/inspect" "恢复前先读清单"
assert_file_contains "${APILOG}" "/api/admin/backup/full/restore" "调用恢复接口"
assert_file_contains "${APILOG}" "confirm" "带了 confirm（服务端强制要求）"
assert_file_contains "${APILOG}" "token: test-token" "带上了管理员 token"
assert_contains "${OUT}" "恢复成功" "打印恢复成功"
assert_contains "${OUT}" "不需要上传" "服务器已有的归档不上传"
assert_not_contains "$(cat "${CMDLOG}")" "stop_vanblog" "走接口的恢复**不停服**（server 自己按集合原子替换）"

# --- 6) 本地文件走上传分支 ---
setup_case
source_script
install_fake_curl
VANBLOG_ASSUME_YES=1
OUT="$(restore 0 "${TEST_DIR}/backups/vanblog-full-20260913-172338.tar.zst" 2>&1)"
assert_eq "$?" "0" "按本地路径恢复成功"
assert_file_contains "${APILOG}" "-F file=@" "本地文件用 multipart 上传"
assert_contains "${OUT}" "将上传到服务器" "上传分支有说明"

# --- 7) --no-static 会传 withStatic=false ---
setup_case
source_script
install_fake_curl
VANBLOG_ASSUME_YES=1
restore 0 vanblog-full-20260913-172338.tar.zst --no-static >/dev/null 2>&1
# 按名字恢复走 JSON body（上传分支才是 -F withStatic=…），所以针里要带引号
assert_file_contains "${APILOG}" '"withStatic":"false"' "--no-static 传成 withStatic=false"

# --- 8) 不确认就不恢复 ---
setup_case
source_script
install_fake_curl
unset VANBLOG_ASSUME_YES
OUT="$(restore 0 vanblog-full-20260913-172338.tar.zst <<<"no" 2>&1)"
assert_contains "${OUT}" "已取消恢复" "输入不是 yes 就取消"
assert_not_contains "$(cat "${APILOG}")" "full/restore" "取消时不会调用恢复接口"

# --- 9) 站点没起时给出可执行的下一步 ---
setup_case
source_script
cat >"${TEST_DIR}/curl" <<'FAKE'
#!/usr/bin/env bash
args="$*"
case "${args}" in
  */api/public/meta*) printf '000' ;;
  *) printf '{}' ;;
esac
exit 0
FAKE
chmod +x "${TEST_DIR}/curl"
export PATH="${TEST_DIR}:${PATH}"
OUT="$(restore 0 vanblog-full-20260913-172338.tar.zst 2>&1)"
if [[ $? -ne 0 ]]; then pass "接口不通时返回非 0"; else fail "接口不通时返回非 0"; fi
assert_contains "${OUT}" "./vanblog.sh start" "接口不通时提示先启动服务"
assert_not_contains "$(cat "${APILOG}")" "full/restore" "接口不通时不会去恢复"

# --- 10) 老格式仍然走离线解压（停服 → tar → 起服）---
setup_case
source_script
install_fake_curl
VANBLOG_ASSUME_YES=1
OUT="$(restore 0 "${TEST_DIR}/backups/vanblog-backup-20260101000000.tar.gz" 2>&1)"
assert_contains "$(cat "${CMDLOG}")" "stop_vanblog" "老格式仍然停服后离线解压"
assert_not_contains "$(cat "${APILOG}")" "full/restore" "老格式不会调用整站恢复接口"

# --- 整站备份：默认走 server 接口，--offline 才打包数据目录 ---
setup_case
source_script
install_fake_curl
OUT="$(backup 0 2>&1)"
assert_eq "$?" "0" "默认整站备份成功"
assert_file_contains "${APILOG}" "/api/admin/backup/full/export" "调用了整站备份接口"
assert_file_contains "${APILOG}" '"format":"zstd"' "默认压缩格式是 zstd"
assert_file_contains "${APILOG}" "token: test-token" "带上了管理员 token"
assert_contains "${OUT}" "vanblog-full-20260913-181937.tar.zst" "输出里有归档名"
assert_contains "${OUT}" "65.91 MB" "输出里有归档大小"
assert_contains "${OUT}" "9838" "输出里有文档条数（能看出备了多少东西）"
assert_contains "${OUT}" "./vanblog.sh restore" "输出里给出恢复命令"
assert_contains "${OUT}" "不含 caddy 的证书" "说清楚整站备份不含 caddy 证书（要备证书得用 --offline）"
assert_not_contains "$(cat "${CMDLOG}")" "tar" "整站备份不会去打包数据目录"

# --- --format 透传与非法值 ---
setup_case
source_script
install_fake_curl
backup 0 --format gzip >/dev/null 2>&1
assert_file_contains "${APILOG}" '"format":"gzip"' "--format gzip 透传给接口"
setup_case
source_script
install_fake_curl
OUT="$(backup 0 --format 7z 2>&1)"
if [[ $? -ne 0 ]]; then pass "非法压缩格式直接拒绝"; else fail "非法压缩格式直接拒绝"; fi
assert_contains "${OUT}" "zstd / xz / gzip" "拒绝时列出可选格式"
assert_not_contains "$(cat "${APILOG}")" "full/export" "非法格式时不会调接口"

# --- 站点没起：给出两条明确的路，而不是默默打个 tar ---
setup_case
source_script
cat >"${TEST_DIR}/curl" <<'FAKE'
#!/usr/bin/env bash
args="$*"
case "${args}" in
  */api/public/meta*) printf '000' ;;
  *) printf '{}' ;;
esac
exit 0
FAKE
chmod +x "${TEST_DIR}/curl"
export PATH="${TEST_DIR}:${PATH}"
OUT="$(backup 0 2>&1)"
if [[ $? -ne 0 ]]; then pass "接口不通时备份返回非 0"; else fail "接口不通时备份返回非 0"; fi
assert_contains "${OUT}" "./vanblog.sh start" "提示先启动站点"
assert_contains "${OUT}" "backup --offline" "提示离线打包这条路"
assert_contains "${OUT}" "--consistent" "提示离线也有一致性模式"
assert_not_contains "${OUT}" "000000" "HTTP 状态码没有被重复拼接成 000000"

# --- --offline 走老路径：打包数据目录，不调接口 ---
setup_case
source_script
install_fake_curl
# backup_offline 有两处路径要求：先检查 VANBLOG_DATA_PATH 存在，
# 再打包 `-C ${VANBLOG_BASE_PATH} ./data`。默认布局下两者是同一个目录
# （DATA_PATH=BASE_PATH/data），但本用例的 harness 把它们设成了两处，所以都要建。
mkdir -p "${VANBLOG_BASE_PATH}/data" "${VANBLOG_DATA_PATH}"
echo x >"${VANBLOG_BASE_PATH}/data/f.txt"
OUT="$(backup 0 --offline 2>&1)"
assert_eq "$?" "0" "离线备份成功"
assert_not_contains "$(cat "${APILOG}")" "full/export" "离线模式不调整站备份接口"
assert_contains "${OUT}" "vanblog-backup-" "离线模式仍然产出 vanblog-backup-*.tar.gz"


echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
