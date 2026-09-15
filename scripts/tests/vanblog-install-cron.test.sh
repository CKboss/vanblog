#!/usr/bin/env bash
# `./vanblog.sh install-cron` 的测试。
# 用 PATH 上的**假 crontab**跑真流程：-l 从一个文件里读、`crontab -` 把 stdin 写回该文件，
# 所有调用记进日志 —— 绝不碰这台机器真实的 crontab。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }
assert_not_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then fail "$3 (unexpected: $2)"; else pass "$3"; fi; }
assert_file_contains() { if grep -qF -- "$2" "$1"; then pass "$3"; else fail "$3 (missing in $1: $2)"; fi; }
assert_file_not_contains() { if grep -qF -- "$2" "$1"; then fail "$3 (unexpected in $1: $2)"; else pass "$3"; fi; }

echo "== vanblog.sh install-cron =="

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

BASE="${TEST_DIR}/var/vanblog"
DATA="${BASE}/data"
mkdir -p "${DATA}/log"

BIN="${TEST_DIR}/bin"
mkdir -p "${BIN}"
# 假 crontab：
#   -l → 从 FAKE_CRONTAB 读；文件不存在时按真 cron 的行为报 "no crontab for root" 退 1；
#        CRONTAB_L_MODE=broken 时模拟"临时故障"（必须让脚本拒绝写入）
#   -  → 把 stdin 写进 FAKE_CRONTAB（CRONTAB_SINK_MODE=devnull 时丢弃，模拟写入后丢失）
#   ⚠️ 桩需要的变量全部 export（子进程看不见 shell 变量 —— AGENTS 里记过的坑）
export FAKE_CRONTAB="${TEST_DIR}/crontab.txt"
export CRON_CALLS="${TEST_DIR}/crontab-calls.log"
cat >"${BIN}/crontab" <<'EOS'
#!/usr/bin/env bash
echo "crontab $*" >>"${CRON_CALLS}"
case "$1" in
-l)
  if [[ "${CRONTAB_L_MODE:-ok}" == "broken" ]]; then
    echo "crontab: temporary failure" >&2
    exit 1
  fi
  if [[ ! -f "${FAKE_CRONTAB}" ]]; then
    echo "no crontab for root" >&2
    exit 1
  fi
  cat "${FAKE_CRONTAB}"
  exit 0
  ;;
-)
  if [[ "${CRONTAB_SINK_MODE:-file}" == "devnull" ]]; then
    cat >/dev/null
    exit 0
  fi
  cat >"${FAKE_CRONTAB}"
  exit 0
  ;;
*) exit 0 ;;
esac
EOS
chmod +x "${BIN}/crontab"
export PATH="${BIN}:${PATH}"
# ⚠️ 之前的用例可能留了函数桩（cron 行里 source 的 env 文件路径等依赖这些函数）
unset -f crontab docker docker-compose curl git df du 2>/dev/null || true

ENVF="${BASE}/vanblog-cron.env"
LOGF="${DATA}/log/vanblog-backup-cron.log"
MARKER="# vanblog-backup-cron"

fresh_case() {
  rm -f "${FAKE_CRONTAB}" "${ENVF}" "${LOGF}"
  : >"${CRON_CALLS}"
  unset CRONTAB_L_MODE CRONTAB_SINK_MODE VANBLOG_ADMIN_TOKEN
  export VANBLOG_SKIP_MAIN=1
  export VANBLOG_BASE_PATH="${BASE}"
  export VANBLOG_DATA_PATH="${DATA}"
  unset VANBLOG_DATA_PATH_RAW VANBLOG_COMPOSE_COND_SUPPORT
  # shellcheck disable=SC1090
  source "${SCRIPT}" >/dev/null 2>&1
}

# ---------- 1) 全新安装：带 token、免确认 ----------
fresh_case
OUT="$(VANBLOG_ASSUME_YES=1 VANBLOG_ADMIN_TOKEN='tok.abc123' install_cron 2>&1)"
RC=$?
assert_eq "${RC}" "0" "全新安装返回 0"
assert_contains "${OUT}" "将向" "写入前展示了将要添加的内容"
assert_contains "${OUT}" "${MARKER}" "展示的行里带幂等标记"
assert_contains "${OUT}" "定时备份已安装" "安装成功有明确提示"
if [[ -f "${FAKE_CRONTAB}" ]]; then
  pass "crontab 被写入"
  LINE="$(cat "${FAKE_CRONTAB}")"
  assert_eq "$(grep -cF "${MARKER}" "${FAKE_CRONTAB}")" "1" "只写了一条带标记的条目"
  assert_contains "${LINE}" "0 3 * * *" "默认每天 03:00"
  assert_contains "${LINE}" ". '${ENVF}'" "cron 行 source env 文件（token 不进 crontab 明文）"
  assert_contains "${LINE}" "'${SCRIPT}' backup" "cron 行跑的是本脚本的绝对路径 + backup"
  assert_contains "${LINE}" ">> '${LOGF}' 2>&1" "输出重定向到日志目录下的日志文件"
  assert_not_contains "${LINE}" "tok.abc123" "token 没有直接出现在 crontab 行里"
else
  fail "crontab 没有被写入"
fi
# env 文件：0600、内容正确
if [[ -f "${ENVF}" ]]; then
  pass "生成了 env 文件 ${ENVF}"
  MODE="$(stat -c %a "${ENVF}")"
  assert_eq "${MODE}" "600" "env 文件权限 0600（仅 root 可读，里面是管理员 token）"
  assert_file_contains "${ENVF}" "export VANBLOG_ADMIN_TOKEN='tok.abc123'" "token 以 export 形式写入（cron 行 source 后子进程可见）"
  assert_file_contains "${ENVF}" "export VANBLOG_ASSUME_YES=1" "env 文件里带 VANBLOG_ASSUME_YES=1（cron 里没人能输 yes）"
  assert_file_contains "${ENVF}" "export VANBLOG_BACKUP_KEEP=7" "默认 VANBLOG_BACKUP_KEEP=7"
  assert_file_contains "${ENVF}" "长期明文落盘" "env 文件头部写明 token 落盘的权衡"
else
  fail "没有生成 env 文件"
fi

# ---------- 2) 已有条目时幂等：第二次装不重复添加 ----------
OUT="$(VANBLOG_ASSUME_YES=1 VANBLOG_ADMIN_TOKEN='tok.abc123' install_cron 2>&1)"
RC=$?
assert_eq "${RC}" "0" "重复安装返回 0（幂等，不是报错）"
assert_contains "${OUT}" "不会重复添加" "重复安装明说不会添加第二条"
assert_eq "$(grep -cF "${MARKER}" "${FAKE_CRONTAB}")" "1" "crontab 里仍然只有一条"

# ---------- 3) 参数不同的已有条目：拒绝，除非 --force ----------
OUT="$(VANBLOG_ASSUME_YES=1 install_cron --hour 5 2>&1)"
RC=$?
assert_eq "${RC}" "1" "参数不同的已有条目 → 拒绝（非 0），让用户显式决定"
assert_contains "${OUT}" "不会添加第二条" "拒绝时明说不会添加第二条"
assert_contains "${OUT}" "--force" "拒绝时给出 --force / --remove 两条路"
assert_eq "$(grep -cF "${MARKER}" "${FAKE_CRONTAB}")" "1" "拒绝后 crontab 原样（没有第二条）"
OUT="$(VANBLOG_ASSUME_YES=1 VANBLOG_ADMIN_TOKEN='tok.new456' install_cron --hour 5 --keep 3 --force 2>&1)"
RC=$?
assert_eq "${RC}" "0" "--force 替换成功"
assert_eq "$(grep -cF "${MARKER}" "${FAKE_CRONTAB}")" "1" "--force 后仍然只有一条（替换，不是追加）"
assert_file_contains "${FAKE_CRONTAB}" "0 5 * * *" "--hour 5 生效"
assert_file_contains "${ENVF}" "export VANBLOG_BACKUP_KEEP=3" "--keep 3 写进 env 文件"
assert_file_contains "${ENVF}" "tok.new456" "--force 时 token 也更新了"
assert_file_not_contains "${ENVF}" "tok.abc123" "旧 token 被替换掉了"

# ---------- 4) 绝不动用户已有的其它条目 ----------
{
  echo "0 1 * * * /usr/bin/other-job"
  echo "30 2 * * 0 /usr/bin/weekly-thing"
  cat "${FAKE_CRONTAB}"
} >"${TEST_DIR}/merged"
cp "${TEST_DIR}/merged" "${FAKE_CRONTAB}"
OUT="$(VANBLOG_ASSUME_YES=1 install_cron --remove 2>&1)"
RC=$?
assert_eq "${RC}" "0" "--remove 返回 0"
assert_file_not_contains "${FAKE_CRONTAB}" "${MARKER}" "--remove 后标记条目没了"
assert_file_contains "${FAKE_CRONTAB}" "/usr/bin/other-job" "用户自己的条目原样保留（append/过滤，从不整表重写）"
assert_file_contains "${FAKE_CRONTAB}" "/usr/bin/weekly-thing" "第二条用户条目也保留"
assert_contains "${OUT}" "vanblog-cron.env" "--remove 后提醒 token 文件还在哪里"
OUT="$(VANBLOG_ASSUME_YES=1 install_cron --remove 2>&1)"
assert_eq "$?" "0" "没有条目时 --remove 也算成功（幂等）"
assert_contains "${OUT}" "不用移除" "没有条目时明说不用移除"

# ---------- 5) crontab -l 出别的错 → 拒绝写入（宁可装不上，不能覆盖）----------
fresh_case
echo "0 1 * * * /usr/bin/precious-job" >"${FAKE_CRONTAB}"
# ⚠️ 必须 export：假 crontab 是**子进程**，靠环境变量决定行为（AGENTS 里记过的坑）
export CRONTAB_L_MODE=broken
OUT="$(VANBLOG_ASSUME_YES=1 VANBLOG_ADMIN_TOKEN=t install_cron 2>&1)"
RC=$?
assert_eq "${RC}" "1" "读不出现有 crontab 时返回非 0"
assert_contains "${OUT}" "不写入" "明说这次不写入"
assert_file_contains "${FAKE_CRONTAB}" "/usr/bin/precious-job" "现有 crontab 一个字节都没动"
unset CRONTAB_L_MODE

# ---------- 6) 写入后回读确认：crontab 说谎时不算成功 ----------
fresh_case
export CRONTAB_SINK_MODE=devnull
OUT="$(VANBLOG_ASSUME_YES=1 VANBLOG_ADMIN_TOKEN=t install_cron 2>&1)"
RC=$?
assert_eq "${RC}" "1" "写入后回读不到条目 → 返回非 0（不假装装好了）"
assert_contains "${OUT}" "没找到条目" "写入丢失时明说"
unset CRONTAB_SINK_MODE

# ---------- 7) 没有 crontab 命令：给出可照抄的手工步骤 ----------
fresh_case
OUT="$(PATH="${TEST_DIR}/emptybin-nonexistent" VANBLOG_ASSUME_YES=1 install_cron 2>&1)"
RC=$?
assert_eq "${RC}" "1" "没有 crontab 命令时返回非 0"
assert_contains "${OUT}" "没有 crontab 命令" "明说缺 crontab"
assert_contains "${OUT}" "apt install cron" "给了安装 cron 的命令（Debian/Ubuntu）"
assert_contains "${OUT}" "crontab -e" "给了手动添加的路径"
assert_contains "${OUT}" "${MARKER}" "给出的手工行里带标记（以后 install-cron 还能识别）"

# ---------- 8) 没有 token（非交互）：照装但把后果说清楚 ----------
fresh_case
OUT="$(VANBLOG_ASSUME_YES=1 install_cron </dev/null 2>&1)"
RC=$?
assert_eq "${RC}" "0" "没有 token 也能装（用户可能想之后补）"
assert_contains "${OUT}" "未提供" "明说 token 未提供"
assert_contains "${OUT}" "登录一步失败" "明说不配 token 的后果（备份会失败），不假装装好就能用"
assert_file_contains "${ENVF}" "# export VANBLOG_ADMIN_TOKEN=" "env 文件里留了注释掉的模板行"
assert_file_not_contains "${ENVF}" "export VANBLOG_ADMIN_TOKEN=''" "没有写一个空的 token export（那会静默顶掉别处的取值）"
assert_eq "$(stat -c %a "${ENVF}")" "600" "没有 token 时 env 文件也是 0600"

# ---------- 9) 交互确认：n 取消（crontab 不动）、y 写入 ----------
fresh_case
OUT="$(printf 'n\n' | VANBLOG_ADMIN_TOKEN=t install_cron 2>&1)"
assert_eq "$?" "0" "输 n 取消时返回 0"
assert_contains "${OUT}" "已取消" "取消有明确提示"
if [[ -f "${FAKE_CRONTAB}" ]]; then fail "取消后 crontab 不该被写入"; else pass "取消后 crontab 没有被写入"; fi
OUT="$(printf 'y\n' | VANBLOG_ADMIN_TOKEN=t install_cron 2>&1)"
assert_eq "$?" "0" "输 y 确认写入成功"
assert_file_contains "${FAKE_CRONTAB}" "${MARKER}" "确认后条目写入"

# ---------- 10) token 带单引号：正确转义、source 能还原、不回显 ----------
fresh_case
OUT="$(VANBLOG_ASSUME_YES=1 VANBLOG_ADMIN_TOKEN="to'k" install_cron 2>&1)"
assert_eq "$?" "0" "带单引号的 token 安装成功"
assert_file_contains "${ENVF}" "'to'\\''k'" "带单引号的 token 被正确转义（source 时不会炸）"
assert_not_contains "${OUT}" "to'k" "token 没有回显到输出里"
# source 一遍 env 文件，确认真的能解析出原值
(
  # shellcheck disable=SC1090
  source "${ENVF}"
  [[ "${VANBLOG_ADMIN_TOKEN}" == "to'k" ]]
) && pass "env 文件 source 后 token 原值还原（含单引号）" || fail "env 文件 source 后 token 还原失败"

# ---------- 10b) 真 tty 下的交互输入（read -s 不回显）----------
# install_cron 只在 stdin 是 tty 时才提示输 token（cron/管道场景不打扰）；
# 用 util-linux 的 script 起一个真 pty 来测这条路。没有 script 就跳过并说明。
if command -v script >/dev/null 2>&1; then
  fresh_case
  OUT="$(printf "tok.tty999\ny\n" | script -qec "bash -c 'source \"${SCRIPT}\" >/dev/null 2>&1; install_cron'" /dev/null 2>&1)"
  RC=$?
  assert_eq "${RC}" "0" "tty 下交互输 token + y 确认，安装成功"
  assert_contains "${OUT}" "token: " "tty 下出现了交互输入 token 的提示"
  # ⚠️ util-linux 的 script 会把它自己的 stdin **原样回显**到输出开头（管道喂进去的
  #    字节先出现一次，这是 harness 的假象，不是 read 在回显）。真正的"read -s 不回显"
  #    要看**提示符之后**还有没有 token：pty 的 ECHO 关掉了的话，后面就是干净的。
  AFTER_PROMPT="${OUT#*token: }"
  assert_not_contains "${AFTER_PROMPT}" "tok.tty999" "提示符之后 token 没有再出现（read -s 关掉了 pty 回显）"
  assert_file_contains "${ENVF}" "export VANBLOG_ADMIN_TOKEN='tok.tty999'" "交互输入的 token 写进了 env 文件"
  assert_contains "$(awk '/^install_cron\(\) \{/,/^\}/' "${SCRIPT}")" 'read -e -r -s -p "token: "' "源码级确认：token 的 read 带 -s（静默）"
else
  echo "NOTE: 本机没有 script 命令，跳过 tty 交互输入用例"
fi

# ---------- 11) 参数校验 ----------
fresh_case
OUT="$(VANBLOG_ASSUME_YES=1 install_cron --hour 25 2>&1)"
assert_eq "$?" "1" "--hour 25 被拒"
OUT="$(VANBLOG_ASSUME_YES=1 install_cron --hour abc 2>&1)"
assert_eq "$?" "1" "--hour abc 被拒"
OUT="$(VANBLOG_ASSUME_YES=1 install_cron --keep 0 2>&1)"
assert_eq "$?" "1" "--keep 0 被拒（保留 0 份等于备完就删）"
OUT="$(VANBLOG_ASSUME_YES=1 install_cron --keep x 2>&1)"
assert_eq "$?" "1" "--keep x 被拒"
if [[ -f "${FAKE_CRONTAB}" ]]; then fail "非法参数时不该写 crontab"; else pass "非法参数时没有写 crontab"; fi
# VANBLOG_BACKUP_KEEP 是 --keep 的默认来源
OUT="$(VANBLOG_ASSUME_YES=1 VANBLOG_BACKUP_KEEP=14 VANBLOG_ADMIN_TOKEN=t install_cron 2>&1)"
assert_eq "$?" "0" "VANBLOG_BACKUP_KEEP=14 时安装成功"
assert_file_contains "${ENVF}" "export VANBLOG_BACKUP_KEEP=14" "VANBLOG_BACKUP_KEEP 成为默认保留份数"

# ---------- 12) 接线：dispatcher / 菜单 / --help ----------
SRC="$(cat "${SCRIPT}")"
assert_contains "${SRC}" '"install-cron")' "dispatcher 接了 install-cron 子命令"
MENU="$(awk '/^show_menu\(\) \{/,/^\}$/' "${SCRIPT}")"
assert_contains "${MENU}" "14." "菜单加了 14（定时备份）"
assert_contains "${MENU}" "install_cron" "菜单 14 调 install_cron"
assert_contains "${MENU}" "15." "菜单加了 15（校验备份）"
assert_contains "${MENU}" "verify" "菜单 15 调 verify"
USAGE_TEXT="$(awk '/^show_usage\(\) \{/,/^\}$/' "${SCRIPT}")"
for kw in install-cron "--remove" "--hour" "--keep" "--force" vanblog-cron.env "0600" verify ".sha256" VANBLOG_BACKUP_SPACE_MARGIN_MB VANBLOG_BACKUP_SKIP_SPACE_CHECK; do
  assert_contains "${USAGE_TEXT}" "${kw}" "--help 覆盖了「${kw}」"
done
# 菜单编号稳定性：老编号一个都不能变
for n in "1." "2." "3." "6." "10." "11." "12." "13." "20." "30."; do
  assert_contains "${MENU}" "${n}" "菜单编号 ${n} 保持不变"
done

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
