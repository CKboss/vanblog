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
      # 镜像默认 VANBLOG_INIT_REQUIRE_SETUP_KEY=true：不带 setupKey 就是这个 400
      setupkey) printf '{"statusCode":400,"message":"缺少初始化密钥","data":{"setupKeyRequired":true,"reason":"missing"}}' ;;
      # 真服务端的形状：body 里带了 setupKey 就放行，没带才 400（用来测"被拒后等到密钥再重试"）
      setupkey_strict)
        if printf '%s' "${args}" | grep -qF '"setupKey":"'; then
          printf '{"statusCode":200,"message":"初始化成功!"}'
        else
          printf '{"statusCode":400,"message":"缺少初始化密钥","data":{"setupKeyRequired":true,"reason":"missing"}}'
        fi ;;
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
  # 测试环境里没有真容器：把「等初始化密钥出现」的重试预算关成 0（默认 15 秒，
  # 每个走全新初始化分支的用例都会白睡一遍 —— 加了这个功能之后本文件从 15 秒变成 108 秒），
  # 并把取容器日志的封装桩成"没有输出、非 0 退出"（等价于本机没有 docker-compose）。
  # 需要日志兜底的用例会在 source_script 之后自己覆盖这个桩。
  export VANBLOG_SETUP_KEY_WAIT=0
  unset VANBLOG_ADMIN_TOKEN VANBLOG_ASSUME_YES VANBLOG_RESTORE_FROM RESET_TEMP_USER RESET_TEMP_PASS
  unset -f docker curl git 2>/dev/null || true
  # shellcheck disable=SC1090
  source "${SCRIPT}"
  restart() { echo "restart $*" >>"${CMDLOG}"; return "${RESTART_RC:-0}"; }
  before_show_menu() { :; }
  vanblog_compose() { return 1; }
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


# ---------- 14) 初始化密钥（setup key）：镜像默认要求，脚本必须自己带上 ----------
# 2026-09 起 VANBLOG_INIT_REQUIRE_SETUP_KEY **默认开启**（无法识别的值也按开启处理），
# 未初始化站点的 POST /api/admin/init 不带 setupKey 就是 400 + body 里的 setupKeyRequired。
# `reset` 与 `VANBLOG_RESTORE_FROM=… install`（文档宣传的"换机器一步到位"）都要先过这条接口
# ⇒ 脚本不带密钥的话这两个功能在全新站点上**必然失败**。
# 密钥在宿主机上读得到：编排模板把 <数据目录>/log 挂到容器 /var/log，server 写 setup.key（0600）。
# ⚠️ 假密钥故意用真形状：randomBytes(32) 的 base64 = **44 字符**，且含 `+` `/` `=`
#    （含 `/` 会踩到 sed 分隔符、含 `+` 会踩到正则元字符 —— 用"看起来像单词"的假密钥测不出这些）。
FAKE_KEY='TVpndIGOm6i1ws/c6fYDEB0qN0RRXmt4hZKfrLnG0+A='
DECOY_RESTORE='cmVzdG9yZUtleU5vdFRoZVNldHVwS2V5MQ=='
DECOY_JWT='and0U2VjcmV0Tm90VGhlU2V0dXBLZXkxMg=='
ARCHIVE='vanblog-full-20260913-140955.tar.zst'

# ① 密钥文件在 ⇒ body 里出现 "setupKey":"<key>"，⑥ 且原有字段一个都没少
setup_case
source_script
export VANBLOG_ASSUME_YES=1
mkdir -p "${VANBLOG_DATA_PATH}/log"
printf '%s\n' "${FAKE_KEY}" >"${VANBLOG_DATA_PATH}/log/setup.key" # 故意带尾换行：读取时必须去掉
chmod 600 "${VANBLOG_DATA_PATH}/log/setup.key"
OUT="$(reset 0 "${ARCHIVE}" 2>&1)"
assert_eq "$?" "0" "① 读到密钥时 reset 照常成功"
assert_file_contains "${APILOG}" "\"setupKey\":\"${FAKE_KEY}\"" "① POST /api/admin/init 的 body 带上了 setupKey（尾换行已去掉，含 + / = 原样）"
assert_contains "${OUT}" "已带上初始化密钥（${#FAKE_KEY} 字符，不回显）" "① 提示只说长度、不说内容"
assert_not_contains "${OUT}" "${FAKE_KEY}" "② 密钥没有出现在 reset 的任何输出里（stdout+stderr 一起捕的）"
assert_file_contains "${APILOG}" '"user":{"username":' "⑥ body 里原有的 user.username 没丢"
assert_file_contains "${APILOG}" '"nickname":"重置初始化"' "⑥ body 里原有的 nickname 没丢"
assert_file_contains "${APILOG}" '"siteInfo":{"author":"vanblog"' "⑥ body 里原有的 siteInfo 没丢"
assert_file_contains "${APILOG}" '"baseUrl":"http://127.0.0.1:18080/"' "⑥ body 里原有的 baseUrl 没丢"
assert_file_contains "${APILOG}" "/api/admin/auth/login" "⑥ 后续「登录拿 token → 恢复」照常走"

# ③ 密钥文件不在，但容器日志里有「初始化密钥： 」⇒ 从日志兜底取到
setup_case
source_script
export VANBLOG_ASSUME_YES=1
vanblog_compose() {
  printf '%s\n' \
    "vanblog_1  | WARN [InitProvider] ========== VanBlog 初始化密钥（setup key） ==========" \
    "vanblog_1  | 初始化密钥： ${FAKE_KEY}" \
    "vanblog_1  | 密钥文件： /var/log/setup.key（0600）"
}
OUT="$(reset 0 "${ARCHIVE}" 2>&1)"
assert_eq "$?" "0" "③ 日志兜底取到密钥时 reset 照常成功"
assert_file_contains "${APILOG}" "\"setupKey\":\"${FAKE_KEY}\"" "③ 密钥文件不在时，从容器日志的「初始化密钥：」行兜底取到"
assert_not_contains "${OUT}" "${FAKE_KEY}" "③ 兜底路径同样不回显密钥"

# ⑤ 日志里同时有**诱饵** base64（restore.key / jwt 材料），而且排在真密钥**后面**
#    ⇒ 取的必须是「初始化密钥：」那一行。裸抓 base64、或"取最后一个匹配"都会抓错，
#    而送错密钥比不送更难查（两边都是 400，长得一模一样）。
setup_case
source_script
export VANBLOG_ASSUME_YES=1
vanblog_compose() {
  printf '%s\n' \
    "vanblog_1  | 初始化密钥： ${FAKE_KEY}" \
    "vanblog_1  | 恢复密钥（restore.key）： ${DECOY_RESTORE}" \
    "vanblog_1  | jwt secret: ${DECOY_JWT}"
}
OUT="$(reset 0 "${ARCHIVE}" 2>&1)"
assert_file_contains "${APILOG}" "\"setupKey\":\"${FAKE_KEY}\"" "⑤ 有诱饵时取的是「初始化密钥：」那一行的值"
if grep -qF -- "${DECOY_RESTORE}" "${APILOG}" || grep -qF -- "${DECOY_JWT}" "${APILOG}"; then
  fail "⑤ 诱饵被当成 setupKey 送出去了（restore.key / jwt 材料都不是初始化密钥）"
else
  pass "⑤ restore.key / jwt 材料都没有被误当成初始化密钥"
fi
assert_not_contains "${OUT}" "${DECOY_RESTORE}" "⑤ 诱饵也没有被打进输出"

# ④ 两处都没有密钥 + 服务端回 setupKeyRequired ⇒ 非 0 退出，且错误信息可照做
setup_case
source_script
export VANBLOG_ASSUME_YES=1 INIT_MODE=setupkey
OUT="$(reset 0 "${ARCHIVE}" 2>&1)"
rc=$?
if [[ "${rc}" != "0" ]]; then
  pass "④ 服务端要密钥而脚本没读到时，reset 非 0 退出（rc=${rc}）"
else
  fail "④ 服务端要密钥而脚本没读到时，reset 非 0 退出"
fi
assert_contains "${OUT}" "setupKeyRequired" "④ 错误里点名 wire 字段 setupKeyRequired"
assert_contains "${OUT}" "${VANBLOG_DATA_PATH}/log/setup.key" "④ 错误里给了密钥文件的确切路径"
assert_contains "${OUT}" "VANBLOG_INIT_REQUIRE_SETUP_KEY" "④ 错误里点名那个开关（真想关保护的人知道去哪关）"
assert_contains "${OUT}" "grep 初始化密钥" "④ 错误里给了从日志取密钥的照做命令"
assert_not_contains "${OUT}" "恢复成功" "④ 没有谎称恢复成功"

# ④b 密钥读到了但服务端仍然拒（密钥不对/已过期）⇒ 失败路径也绝不泄漏密钥
setup_case
source_script
export VANBLOG_ASSUME_YES=1 INIT_MODE=setupkey
mkdir -p "${VANBLOG_DATA_PATH}/log"
printf '%s' "${FAKE_KEY}" >"${VANBLOG_DATA_PATH}/log/setup.key"
OUT="$(reset 0 "${ARCHIVE}" 2>&1)"
if [[ "$?" != "0" ]]; then pass "④b 密钥被服务端拒绝时非 0 退出"; else fail "④b 密钥被服务端拒绝时非 0 退出"; fi
assert_file_contains "${APILOG}" "\"setupKey\":\"${FAKE_KEY}\"" "④b 请求里确实带了密钥（是服务端拒的，不是脚本没读）"
assert_not_contains "${OUT}" "${FAKE_KEY}" "④b 失败路径也没有把密钥打进输出"

# read_setup_key 自身的契约
setup_case
source_script
GOT="$(read_setup_key)"
assert_eq "${GOT}" "" "两处都没有密钥时 read_setup_key 输出空（不猜一个值）"
read_setup_key >/dev/null 2>&1
assert_eq "$?" "0" "拿不到密钥也是 0 退出（要不要报错由调用方决定：密钥要求可能被显式关掉）"
mkdir -p "${VANBLOG_DATA_PATH}/log"
printf '  %s \n\n' "${FAKE_KEY}" >"${VANBLOG_DATA_PATH}/log/setup.key"
GOT="$(read_setup_key)"
assert_eq "${GOT}" "${FAKE_KEY}" "密钥文件带首尾空白/多个换行也读得干净（base64 里没有空白字符）"

# ⑦ 密钥"晚到"（容器刚起、server 还没写出 setup.key）⇒ 被拒后等一次、拿到就重试成功。
#    日志桩第一次什么都不给、第二次才给密钥，模拟"密钥还在路上"。
setup_case
source_script
export VANBLOG_ASSUME_YES=1 INIT_MODE=setupkey_strict VANBLOG_SETUP_KEY_WAIT=3
LOGCALLS="${TEST_DIR}/logcalls"
vanblog_compose() {
  local n
  n="$(cat "${LOGCALLS}" 2>/dev/null || echo 0)"
  n=$((n + 1))
  printf '%s' "${n}" >"${LOGCALLS}"
  if (( n >= 2 )); then printf '%s\n' "vanblog_1  | 初始化密钥： ${FAKE_KEY}"; fi
}
OUT="$(reset 0 "${ARCHIVE}" 2>&1)"
assert_eq "$?" "0" "⑦ 第一趟没带密钥被拒、等到密钥后重试成功"
assert_contains "${OUT}" "服务端要求初始化密钥，等它出现" "⑦ 明说了在等密钥（不是静默重试）"
assert_file_contains "${APILOG}" "\"setupKey\":\"${FAKE_KEY}\"" "⑦ 重试那一趟带上了密钥"
n_init_calls="$(grep -cF '/api/admin/init' "${APILOG}")"
assert_eq "${n_init_calls}" "2" "⑦ 初始化接口只打了两次（重试一次就停 —— 那接口挂着 5 次/10 分钟限流）"
assert_contains "${OUT}" "恢复成功" "⑦ 重试成功后整条链照常走完"
assert_not_contains "${OUT}" "${FAKE_KEY}" "⑦ 重试路径也没有回显密钥"

# ⑧ 已初始化的站点：setup.key 本来就不存在（初始化成功后 server 会删），**不许白等**。
#    这是 reset 最常见的场景，"先等满预算再发请求"的实现会给它平白加上 VANBLOG_SETUP_KEY_WAIT 秒。
setup_case
source_script
export VANBLOG_ASSUME_YES=1 INIT_MODE=inited VANBLOG_ADMIN_TOKEN="existing-token" VANBLOG_SETUP_KEY_WAIT=30
t_start="$(date +%s)"
OUT="$(reset 0 "${ARCHIVE}" 2>&1)"
rc=$?
t_end="$(date +%s)"
assert_eq "${rc}" "0" "⑧ 已初始化站点上 reset 照常成功"
n_init_calls="$(grep -cF '/api/admin/init' "${APILOG}")"
assert_eq "${n_init_calls}" "1" "⑧ 已初始化时只打一次初始化接口（不触发重试）"
assert_contains "${OUT}" "已经初始化过了" "⑧ 识别出站点已初始化"
# 预算是 30 秒；真等了就会远超 5 秒（整套用例平时 2 秒跑完）
if (( t_end - t_start < 5 )); then
  pass "⑧ 没有为不存在的密钥白等（预算 30 秒，本用例实际 <5 秒）"
else
  fail "⑧ 为不存在的密钥白等了（预算 30 秒，本用例耗时 $((t_end - t_start)) 秒）"
fi

# 源码级钉子。⚠️ 断言"某文本不存在/存在"之前**先剥注释**：本仓库为此踩过 5 次 ——
# 解释"为什么这么做"的注释里就写着被断言的那个字符串（这里注释里满是 setupKey / 密钥）。
SRC_CODE="$(grep -vE '^[[:space:]]*#' "${SCRIPT}")"
assert_contains "${SRC_CODE}" 'json_string "${setup_key}"' "setupKey 走 json_string 转义，不手拼 JSON"
assert_contains "${SRC_CODE}" '已带上初始化密钥（${#setup_key} 字符，不回显）" >&2' "「已带上密钥」的提示走 stderr（stdout 是 token 通道，多一个字符就污染 token）"
assert_contains "${SRC_CODE}" '[[ "${budget}" =~ ^[0-9]+$ ]] || budget=15' "非法的等待预算回落 15 秒（不死循环、不立刻放弃）"
assert_contains "${SRC_CODE}" "grep -oE '初始化密钥： " "日志兜底锚在「初始化密钥： 」标签上，不是裸抓 base64"
assert_contains "${SRC_CODE}" 'setup_key="$(read_setup_key 0)"' "发请求前只看一眼密钥（不为「本来就不存在」的密钥白等）"
assert_contains "${SRC_CODE}" "grep -q 'setupKeyRequired' && [[ \${attempt} -eq 1 ]]" "只有服务端点名要密钥、且是第一趟时才等并重试（重试有上限）"
assert_contains "${SRC_CODE}" 'for attempt in 1 2; do' "重试上限写死成一次（初始化接口有 5 次/10 分钟限流，不能循环猛打）"
assert_contains "${SRC_CODE}" 'tr -d '"'"' \t\r\n'"'"' <"${key_file}"' "读文件时把空白全删掉（server 写的文件带尾换行）"
# 只有一个调用点 ⇒ 密钥只需要在这一处带上（VANBLOG_RESTORE_FROM 的 install 也是转交 reset 走到这里）
n_init="$(printf '%s\n' "${SRC_CODE}" | grep -oF '/api/admin/init' | wc -l | tr -d ' ')"
assert_eq "${n_init}" "1" "剥掉注释后全脚本只有一处打 /api/admin/init（所以不存在漏带密钥的第二条路）"
assert_contains "${SRC_CODE}" 'reset 0 "${VANBLOG_RESTORE_FROM}"' "install 的 VANBLOG_RESTORE_FROM 确实转交 reset（因此共用同一个调用点）"


echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
