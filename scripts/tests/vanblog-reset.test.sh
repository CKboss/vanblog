#!/usr/bin/env bash
# `./vanblog.sh reset`（从整站备份重置整个站点）的行为测试。
#
# 这条路径解决的是"换新机器太繁琐"：以前要 装 → 打开后台走向导初始化 → 登录 →
# 上传备份 → 恢复，而初始化建的账号马上会被备份里的真实账号覆盖，纯属白走一趟；
# 更麻烦的是恢复接口在 AdminGuard 后面 —— **没初始化就没法登录，也就没法恢复**（鸡生蛋）。
# 现在 reset 把整条链自动化了，所以这里逐段验证。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_contains() { if printf '%s' "$1" | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }
assert_not_contains() { if printf '%s' "$1" | grep -qF -- "$2"; then fail "$3 (unexpected: $2)"; else pass "$3"; fi; }
assert_file_contains() { if grep -qF -- "$2" "$1"; then pass "$3"; else fail "$3 (missing in $1: $2)" ; fi; }

echo "== vanblog.sh reset（从整站备份重置整站）=="

# ---------- 测试脚手架 ----------
setup_case() {
  TEST_DIR="$(mktemp -d)"
  APILOG="${TEST_DIR}/api.log"
  CMDLOG="${TEST_DIR}/commands.log"
  # ⚠️ 必须 export：假 curl / restart 是子进程或函数，靠这两个文件记录调用
  export APILOG CMDLOG
  : >"${APILOG}"
  : >"${CMDLOG}"
  mkdir -p "${TEST_DIR}/bin" "${TEST_DIR}/vanblog/data/log/vanblog-backups"

  # INIT_MODE=fresh|inited|fail 控制 /api/admin/init 的返回
  cat >"${TEST_DIR}/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
args="$*"
printf '%s\n' "${args}" >>"${APILOG}"
case "${args}" in
  */api/public/meta*)
    if printf '%s' "${args}" | grep -q -- "-w"; then printf '200'; else printf '{"statusCode":200,"data":{"siteName":"测试站"}}'; fi ;;
  */api/admin/init*)
    case "${INIT_MODE:-fresh}" in
      inited) printf '{"statusCode":500,"message":"已初始化"}' ;;
      fail) printf '{"statusCode":500,"message":"数据库连不上"}' ;;
      *) printf '{"statusCode":200,"message":"初始化成功!"}' ;;
    esac ;;
  */api/admin/auth/login*)
    if [[ "${LOGIN_FAIL:-0}" == "1" ]]; then printf '{"statusCode":401,"message":"用户名或密码错误！"}'
    else printf '{"statusCode":200,"data":{"token":"reset-test-token"}}'; fi ;;
  */api/admin/backup/full/inspect*)
    printf '{"statusCode":200,"data":{"name":"vanblog-full-20260913-140955.tar.zst","createdAt":"2026-09-13T06:09:54.882Z","totals":{"collections":13,"documents":9830,"files":185}}}' ;;
  */api/admin/backup/full/restore*)
    if [[ "${RESTORE_FAIL:-0}" == "1" ]]; then printf '{"statusCode":500,"message":"归档损坏"}'
    else printf '{"statusCode":200,"data":{"collections":13,"documents":9830,"files":185}}'; fi ;;
  */api/public/articles*) printf '{"statusCode":200,"data":{"total":59}}' ;;
  *) printf '{}' ;;
esac
exit 0
FAKECURL
  chmod +x "${TEST_DIR}/bin/curl"
  export PATH="${TEST_DIR}/bin:${PATH}"
  # ⚠️ 用例之间必须清干净：INIT_MODE 一旦从上一个用例漏下来，
  #    后面的用例就会走"已初始化"分支去交互登录，然后读到 EOF 失败，
  #    表现为一片莫名其妙的 rc=1（这次就是这么查了半天的）。
  unset INIT_MODE LOGIN_FAIL RESTORE_FAIL RESTORE_CODE RESTART_RC
  # 生命周期与菜单一律桩掉：reset 成功后会调 restart，测试里不能真去动容器
  restart() { echo "restart $*" >>"${CMDLOG}"; return "${RESTART_RC:-0}"; }
  start_vanblog() { echo "start $*" >>"${CMDLOG}"; return 0; }
  stop_vanblog() { echo "stop $*" >>"${CMDLOG}"; return 0; }
  before_show_menu() { :; }
}

source_script() {
  export VANBLOG_SKIP_MAIN=1
  export VANBLOG_BASE_PATH="${TEST_DIR}/vanblog"
  export VANBLOG_DATA_PATH="${TEST_DIR}/vanblog/data"
  export VANBLOG_BACKUP_DIR="${TEST_DIR}/vanblog/data/log/vanblog-backups"
  export VANBLOG_API_BASE="http://127.0.0.1:18080"
  unset VANBLOG_ADMIN_TOKEN VANBLOG_ASSUME_YES VANBLOG_RESTORE_FROM RESET_TEMP_USER RESET_TEMP_PASS
  unset -f docker curl git 2>/dev/null || true
  # shellcheck disable=SC1090
  source "${SCRIPT}"
  restart() { echo "restart $*" >>"${CMDLOG}"; return "${RESTART_RC:-0}"; }
  before_show_menu() { :; }
}

# ---------- 1) 全新站点：自动初始化 → 登录 → 恢复 → 重启 → 核对 ----------
setup_case
source_script
export VANBLOG_ASSUME_YES=1
OUT="$(reset 0 vanblog-full-20260913-140955.tar.zst 2>&1)"
assert_eq "$?" "0" "全新站点上 reset 成功"
assert_file_contains "${APILOG}" "/api/admin/init" "调用了初始化接口（不然没登录就没法恢复）"
assert_file_contains "${APILOG}" "/api/admin/auth/login" "用临时账号登录拿 token"
assert_file_contains "${APILOG}" "/api/admin/backup/full/restore" "调用了整站恢复接口"
assert_file_contains "${APILOG}" "token: reset-test-token" "恢复请求带上了刚拿到的 token"
assert_contains "${OUT}" "站点是全新的" "说明了是自动初始化的"
assert_contains "${OUT}" "恢复成功" "报告恢复成功"
assert_contains "${OUT}" "重启容器" "默认会重启（让 server 重新读取恢复后的 JWT 密钥）"
assert_file_contains "${CMDLOG}" "restart" "确实调用了 restart"
assert_contains "${OUT}" "用备份里原来的账号" "告诉用户初始化用的临时账号已被覆盖"
assert_contains "${OUT}" "测试站" "核对阶段读到了站点名"

# ---------- 2) 已经初始化过：不该再初始化，而是走正常登录 ----------
setup_case
source_script
export VANBLOG_ASSUME_YES=1 INIT_MODE=inited VANBLOG_ADMIN_TOKEN="existing-token"
OUT="$(reset 0 vanblog-full-20260913-140955.tar.zst 2>&1)"
assert_eq "$?" "0" "已初始化的站点上 reset 也成功"
assert_contains "${OUT}" "已经初始化过了" "识别出站点已初始化"
assert_file_contains "${APILOG}" "token: existing-token" "用的是现有 token，不是临时账号"
assert_not_contains "${OUT}" "站点是全新的" "没有谎称做了初始化"

# ---------- 3) --no-restart：不动容器 ----------
setup_case
source_script
export VANBLOG_ASSUME_YES=1
OUT="$(reset 0 vanblog-full-20260913-140955.tar.zst --no-restart 2>&1)"
assert_eq "$?" "0" "--no-restart 时 reset 成功"
if grep -q "restart" "${CMDLOG}"; then
  fail "--no-restart 时不该调用 restart"
else
  pass "--no-restart 时不调用 restart"
fi

# ---------- 4) 不确认就不动手 ----------
setup_case
source_script
unset VANBLOG_ASSUME_YES
OUT="$(printf 'no\n' | reset 0 vanblog-full-20260913-140955.tar.zst 2>&1)"
if [[ $? -ne 0 ]]; then pass "输入 no 时取消并返回非 0"; else fail "输入 no 时取消并返回非 0"; fi
assert_contains "${OUT}" "已取消" "取消时说清楚了"
assert_not_contains "$(cat "${APILOG}")" "full/restore" "取消后没有调用恢复接口"
assert_not_contains "$(cat "${APILOG}")" "/api/admin/init" "取消后连初始化都没做（不会留下一个临时账号）"

# ---------- 5) 归档在服务器备份目录里：按名字恢复，不上传 ----------
setup_case
source_script
export VANBLOG_ASSUME_YES=1
head -c 1000 /dev/urandom >"${VANBLOG_BACKUP_DIR}/vanblog-full-20260913-140955.tar.zst"
OUT="$(reset 0 vanblog-full-20260913-140955.tar.zst 2>&1)"
assert_contains "${OUT}" "直接用服务器上的文件" "识别出归档已在服务器上，不走上传"
assert_not_contains "$(cat "${APILOG}")" "-F file=@" "没有 multipart 上传"

# ---------- 6) 本地路径：走上传 ----------
setup_case
source_script
export VANBLOG_ASSUME_YES=1
LOCAL="${TEST_DIR}/vanblog-full-20260101-010101.tar.zst"
head -c 1000 /dev/urandom >"${LOCAL}"
OUT="$(reset 0 "${LOCAL}" 2>&1)"
assert_file_contains "${APILOG}" "-F file=@${LOCAL}" "本地文件走 multipart 上传"

# ---------- 7) 恢复失败：要把临时账号打出来，否则用户连后台都进不去 ----------
setup_case
source_script
export VANBLOG_ASSUME_YES=1 RESTORE_FAIL=1
OUT="$(reset 0 vanblog-full-20260913-140955.tar.zst 2>&1)"
if [[ $? -ne 0 ]]; then pass "恢复失败时返回非 0"; else fail "恢复失败时返回非 0"; fi
assert_contains "${OUT}" "恢复失败" "明确说恢复失败"
assert_contains "${OUT}" "临时管理员账号" "失败时给出临时账号（不然新机器上连后台都进不去）"
assert_contains "${OUT}" "reset-init" "临时账号用户名可用"

# ---------- 8) 初始化失败 / 站点没起 ----------
setup_case
source_script
export VANBLOG_ASSUME_YES=1 INIT_MODE=fail
OUT="$(reset 0 vanblog-full-20260913-140955.tar.zst 2>&1)"
if [[ $? -ne 0 ]]; then pass "初始化失败时返回非 0"; else fail "初始化失败时返回非 0"; fi
assert_contains "${OUT}" "初始化失败" "初始化失败时说清楚了"

setup_case
source_script
cat >"${TEST_DIR}/bin/curl" <<'DEADCURL'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${APILOG}"
case "$*" in
  *-w*) printf '000' ;;
  *) printf '{}' ;;
esac
exit 0
DEADCURL
chmod +x "${TEST_DIR}/bin/curl"
OUT="$(VANBLOG_ASSUME_YES=1 reset 0 x.tar.zst 2>&1)"
if [[ $? -ne 0 ]]; then pass "站点接口不通时返回非 0"; else fail "站点接口不通时返回非 0"; fi
assert_contains "${OUT}" "start" "接口不通时提示先启动（或先安装）"
assert_not_contains "$(cat "${APILOG}")" "/api/admin/init" "接口不通时不会去初始化"

# ---------- 9) 安装时顺手重置：VANBLOG_RESTORE_FROM ----------
setup_case
source_script
install_and_maybe_reset() { :; } # 占位，避免真的安装
if grep -qF 'VANBLOG_RESTORE_FROM' "${SCRIPT}" && grep -qF 'install_and_maybe_reset' "${SCRIPT}"; then
  pass "install 支持 VANBLOG_RESTORE_FROM（装完自动从整站备份重置）"
else
  fail "install 没有接 VANBLOG_RESTORE_FROM"
fi
# 菜单与命令行两个入口都要走包装函数，否则从菜单装就不会自动恢复
MENU_CALLS="$(grep -c 'install_and_maybe_reset' "${SCRIPT}")"
if [[ "${MENU_CALLS}" -ge 3 ]]; then
  pass "菜单与命令行两个入口都用 install_and_maybe_reset（${MENU_CALLS} 处）"
else
  fail "install_and_maybe_reset 只出现 ${MENU_CALLS} 处，菜单或命令行有一个漏了"
fi
# 子命令与菜单项都要有
assert_file_contains "${SCRIPT}" '"reset")' "dispatcher 支持 reset 子命令"
assert_file_contains "${SCRIPT}" "12)" "菜单里有 12) 重置整站"
assert_file_contains "${SCRIPT}" "./vanblog.sh reset" "usage 里列出了 reset"

# ---------- 10) INIT 前缀只能在 ensure_admin_token 里 ----------
# 差点踩的坑：给 vanblog_admin_token 的输出加 INIT 前缀会**连累 restore**
# （它也用这个函数拿 token，会把 "INIT xxx" 整个当成 token 发出去）。
# 前缀只允许出现在 ensure_admin_token 的函数体里。
awk '
  /^vanblog_admin_token\(\)/ { fn="admin"; next }
  /^ensure_admin_token\(\)/ { fn="ensure"; next }
  /^[a-z_]+\(\)/ { fn=""; next }
  /printf .INIT %s./ { print (fn=="" ? "other" : fn) }
' "${SCRIPT}" >"${TEST_DIR}/init-prefix.txt"
if grep -qx "ensure" "${TEST_DIR}/init-prefix.txt" && ! grep -qxE "admin|other" "${TEST_DIR}/init-prefix.txt"; then
  pass "INIT 前缀只出现在 ensure_admin_token 里（vanblog_admin_token 保持纯 token，restore 才不受影响）"
else
  fail "INIT 前缀跑到了别的函数里：$(tr '\n' ' ' <"${TEST_DIR}/init-prefix.txt")"
fi

# ---------- 11) 随机口令 ----------
setup_case
source_script
p1="$(random_password 18)"
p2="$(random_password 18)"
assert_eq "${#p1}" "18" "随机口令长度正确"
if [[ "${p1}" != "${p2}" ]]; then pass "两次生成的口令不同"; else fail "两次生成的口令相同"; fi
if printf '%s' "${p1}" | grep -qE '^[A-Za-z0-9]+$'; then
  pass "随机口令只含字母数字（不会有 shell/JSON 转义问题）"
else
  fail "随机口令含特殊字符：${p1}"
fi

# ---------- 12) 备份清单的摘要输出 ----------
setup_case
source_script
BJ='{"name":"vanblog-full-20260913-140955.tar.zst","createdAt":"2026-09-13T06:09:54.882Z","format":"zstd","size":"65.91 MB","seconds":29.4,"totals":{"databases":2,"collections":15,"documents":9838,"files":185},"databases":{"vanBlog":{"collections":{"articles":{"count":59},"statics":{"count":93}}}}}'
SUM="$(summarize_backup_json "${BJ}")"
assert_contains "${SUM}" "2026-09-13T06:09:54.882Z" \
  "备份时间完整显示（`sed s/.*://` 会把 ISO 时间戳削成 54.882Z）"
assert_contains "${SUM}" "15 个集合 / 9838 条文档 / 185 个静态文件" "摘要里有集合/文档/文件数"
assert_contains "${SUM}" "articles" "摘要里列出各集合条数"
assert_contains "${SUM}" "65.91 MB" "摘要里有归档大小"
lines="$(printf '%s\n' "${SUM}" | wc -l | tr -d ' ')"
if (( lines < 15 )); then
  pass "摘要只有 ${lines} 行（完整 JSON 有上百行，屏幕上全是 }, 根本没法看）"
else
  fail "摘要有 ${lines} 行，还是太吵"
fi
OUT="$(VANBLOG_VERBOSE=1 print_backup_json "${BJ}" 2>&1)"
assert_contains "${OUT}" '"documents": 9838' "--verbose 时给完整 JSON"
OUT2="$(print_backup_json "${BJ}" 2>&1)"
assert_contains "${OUT2}" "--verbose" "默认摘要模式会提示怎么看全文"

# ---------- 13) reset/restore 都支持 --verbose ----------
assert_file_contains "${SCRIPT}" '--verbose) export VANBLOG_VERBOSE=1 ;;' "reset 与 restore 都接 --verbose"
assert_file_contains "${SCRIPT}" "print_backup_json" "恢复流程用摘要而不是直接倒 JSON"


echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
