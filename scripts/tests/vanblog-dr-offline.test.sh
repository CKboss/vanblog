#!/usr/bin/env bash
# 灾难恢复 / 离线 / 体检这一批的测试：
#   - print_dead_site_playbook 与两处"站点接口不通"的接线（mongo 坏了 ⇒ restore/reset 双双死锁）
#   - restore --offline-full（移开坏库 → 起栈 → 走既有 reset；每步可回滚）
#   - backup_cron_run（失败回落 --offline、写旁路状态、webhook 绝不影响结果）
#   - mirror_backup_artifacts（第二个目的地：复制 + 校验 + 按份数清理，且**永不**让本地备份失败）
#   - install-cron --every N（RPO）与 --hour 的互斥
#   - cert_days_for_file / cert_report（用真自签证书端到端测，含 21/7 两个阈值）
#   - doctor（只读体检，退出码要能直接给 cron/监控用）
#
# ⚠️ 全部用桩跑：假 docker / 假 curl / 重定义 backup·reset·start·stop·verify，
#    绝不碰这台机器真实的容器、crontab 与站点。
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
assert_rc() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got rc=$1, want $2)"; fi; }

echo "== vanblog.sh 灾难恢复 / 离线 / 体检 =="

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT
BIN="${TEST_DIR}/bin"
mkdir -p "${BIN}"

BASE="${TEST_DIR}/var/vanblog"
DATA="${BASE}"
mkdir -p "${DATA}/log/vanblog-backups" "${DATA}/data/mongo"

# 假 docker：默认什么都成功；DOCKER_MODE 可以模拟"容器没在跑"/"inspect 给出崩溃循环"
export DOCKER_MODE="${DOCKER_MODE:-ok}"
cat >"${BIN}/docker" <<'EOS'
#!/usr/bin/env bash
echo "docker $*" >>"${DOCKER_CALLS:-/dev/null}"
case "${DOCKER_MODE:-ok}" in
  nocontainer) exit 1 ;;
  # ⚠️ ok 模式必须真的**回答** inspect：早先这里直接 exit 0 不打印，doctor 读到空状态就判成
  #    "容器不在跑"，于是"一切正常时返回 0"这条用例永远红 —— 坏的是桩，不是被测代码。
  ok)
    if [[ "$1" == "inspect" ]]; then
      case "$*" in
        *RestartCount*) echo "0" ;;
        *State.Health*) echo "healthy" ;;
        *) echo "running" ;;
      esac
    fi
    exit 0
    ;;
  crashloop)
    case "$1" in
      inspect)
        case "$*" in
          *State.Status*) echo "running" ;;
          *RestartCount*) echo "${FAKE_RESTARTS:-9}" ;;
          *Health*) echo "none" ;;
          *) echo "running" ;;
        esac
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
EOS
chmod +x "${BIN}/docker"
export DOCKER_CALLS="${TEST_DIR}/docker-calls.log"

# 假 curl：默认健康接口 200；CURL_HEALTH_CODE 可以改成 503/000
cat >"${BIN}/curl" <<'EOS'
#!/usr/bin/env bash
echo "curl $*" >>"${CURL_CALLS:-/dev/null}"
if [[ "$*" == *"/api/public/health"* ]]; then
  code="${CURL_HEALTH_CODE:-200}"
  if [[ "$*" == *"-o /dev/null"* || "$*" == *"-w"* ]]; then printf '%s' "${code}"; exit 0; fi
  printf '{"status":"ok"}'; exit 0
fi
# webhook / 其它：按 CURL_OTHER_RC 决定
exit "${CURL_OTHER_RC:-0}"
EOS
chmod +x "${BIN}/curl"
export CURL_CALLS="${TEST_DIR}/curl-calls.log"

setup_case() {
  export PATH="${BIN}:${PATH}"
  export VANBLOG_BASE_PATH="${BASE}"
  export VANBLOG_DATA_PATH="${DATA}"
  export VANBLOG_SKIP_MAIN=1
  export VANBLOG_ASSUME_YES=1
  unset VANBLOG_BACKUP_MIRROR_DIR VANBLOG_BACKUP_ALERT_WEBHOOK DOCKER_MODE CURL_HEALTH_CODE CURL_OTHER_RC
  export DOCKER_MODE=ok
  rm -rf "${DATA}/data/mongo" "${DATA}/data"/mongo.broken-* "${DATA}/log/vanblog-backups/cron-status.json"
  # ⚠️ 调用日志必须每个用例清空：它跨用例累积，会让"这次不该调用 X"这类断言读到上一个用例的记录
  : >"${DOCKER_CALLS}" 2>/dev/null || true
  : >"${CURL_CALLS}" 2>/dev/null || true
  # 调用轨迹用**文件**记，不用变量：被测函数在 `$( )` 子 shell 里跑，子 shell 里的赋值传不回来
  # （曾经用变量记，导致"校验不通过时没动手"那条断言永远看到空字符串 —— 空转，什么都没证明）
  export TRACE="${TEST_DIR}/trace.log"
  : >"${TRACE}"
  mkdir -p "${DATA}/data/mongo" "${DATA}/log/vanblog-backups"
  echo "sentinel" >"${DATA}/data/mongo/WiredTiger"
  # shellcheck disable=SC1090
  source "${SCRIPT}"
  # 编排相关的桩：测试环境里没有真的 compose 文件/容器
  vanblog_compose() { [[ "${DOCKER_MODE:-ok}" == "nocontainer" ]] && return 1; echo "fakecid123"; }
  vanblog_api_base() { echo "http://127.0.0.1:18099"; }
}

# ---------------------------------------------------------------------------
# 1) 死锁剧本：站点起不来时 restore/reset 都要打印可照做的恢复剧本
# ---------------------------------------------------------------------------
setup_case
OUT="$(print_dead_site_playbook /tmp/x.tar.zst 2>&1)"
assert_contains "${OUT}" "restore --offline-full" "剧本给出推荐的一条命令"
assert_contains "${OUT}" "mv " "剧本用的是 mv（改名保留）"
assert_contains "${OUT}" "不要 rm -rf" "剧本明确禁止 rm -rf（留着才能回滚/取证）"
assert_contains "${OUT}" "verify" "剧本第一步是先确认归档是好的"
assert_contains "${OUT}" "回滚" "剧本给了回滚步骤"
assert_contains "${OUT}" "/tmp/x.tar.zst" "剧本会带上调用者给的归档路径"
# 只读性：打印剧本不能动任何文件
BEFORE="$(find "${DATA}" -type f | sort | md5sum)"
print_dead_site_playbook >/dev/null 2>&1
AFTER="$(find "${DATA}" -type f | sort | md5sum)"
assert_eq "${BEFORE}" "${AFTER}" "打印剧本是只读的（数据目录一个文件都没变）"

# 两处"站点接口不通"的报错都必须接上剧本（源码级，剥注释后断言）
SRC_CODE="$(sed '/^[[:space:]]*#/d' "${SCRIPT}")"
N_HOOKS="$(printf '%s\n' "${SRC_CODE}" | grep -c 'print_dead_site_playbook "\${target}"')"
assert_eq "${N_HOOKS}" "2" "restore 与 reset 两处死锁报错都接上了剧本（剥注释后数调用点）"
# 空转反证：剥注释之前必须能数到更多（定义 + 注释里的提及），否则说明上面的 grep 形状根本没在工作
N_RAW="$(grep -c 'print_dead_site_playbook' "${SCRIPT}")"
if (( N_RAW > N_HOOKS )); then
  pass "剥注释前后的计数不同（${N_RAW} > ${N_HOOKS}），说明剥离与形状都真的在起作用"
else
  fail "剥注释前后计数一样（${N_RAW} vs ${N_HOOKS}）：断言可能是空转的"
fi

# ---------------------------------------------------------------------------
# 2) restore --offline-full
# ---------------------------------------------------------------------------
setup_case
ARCHIVE="${TEST_DIR}/vanblog-full-20260920-000000.tar.zst"
echo "fake archive" >"${ARCHIVE}"

# 2a) 没给归档 → 退出码 2（与 restore 其它参数错误一致）
OUT="$(offline_full_restore "" 2>&1)"; rc=$?
assert_rc "${rc}" "2" "--offline-full 没给归档时退出码 2"
assert_contains "${OUT}" "需要指定归档" "并说清缺什么"

# 2b) 归档不存在 → 退出码 2
OUT="$(offline_full_restore "${TEST_DIR}/nope.tar.zst" 2>&1)"; rc=$?
assert_rc "${rc}" "2" "归档不存在时退出码 2"

# 2c) 🔴 归档校验不通过 ⇒ 一个字节都不许动（这是唯一退路，不能亲手毁掉）
setup_case
verify() { return 1; }
stop_vanblog() { echo "stop" >>"${TRACE}"; return 0; }
start_vanblog() { echo "start" >>"${TRACE}"; return 0; }
reset() { echo "reset" >>"${TRACE}"; return 0; }
OUT="$(offline_full_restore "${ARCHIVE}" 2>&1)"; rc=$?
assert_rc "${rc}" "1" "归档校验不通过时返回 1"
assert_eq "$(cat "${TRACE}" 2>/dev/null)" "" "校验不通过时**没有**停栈/起栈/重置（一个动作都没做）"
if [[ -d "${DATA}/data/mongo" ]] && ! ls -d "${DATA}/data"/mongo.broken-* >/dev/null 2>&1; then
  pass "校验不通过时数据库目录原封不动"
else
  fail "校验不通过时竟然动了数据库目录"
fi
assert_contains "${OUT}" "没有改动任何文件" "并明确告诉用户没动过东西"

# 2d) 正常路径：verify 过 → 停栈 → 改名保留 → 起栈 → reset
setup_case
verify() { return 0; }
stop_vanblog() { printf 'stop>' >>"${TRACE}"; return 0; }
start_vanblog() { printf 'start>' >>"${TRACE}"; return 0; }
reset() { printf 'reset(%s)>' "$2" >>"${TRACE}"; return 0; }
OUT="$(offline_full_restore "${ARCHIVE}" 2>&1)"; rc=$?
assert_rc "${rc}" "0" "正常路径返回 0"
assert_eq "$(cat "${TRACE}")" "stop>start>reset(${ARCHIVE})>" "顺序是 停栈→起栈→用归档重置，且归档路径原样传下去"
ASIDE="$(ls -d "${DATA}/data"/mongo.broken-* 2>/dev/null | head -1)"
if [[ -n "${ASIDE}" && -f "${ASIDE}/WiredTiger" ]]; then
  pass "旧数据库目录被**改名保留**（含原文件），不是删除"
else
  fail "没找到改名保留的旧数据库目录（或里面文件丢了）"
fi
if [[ ! -d "${DATA}/data/mongo" ]]; then
  pass "原路径已让位（起栈后会是全新的空库）"
else
  fail "原路径还在：mv 没有真的发生"
fi
assert_contains "${OUT}" "别删" "提醒用户在确认之前不要删掉唯一回滚点"
assert_contains "${OUT}" "doctor" "并建议顺手体检"

# 2e) reset 失败 ⇒ 必须打印**可直接照抄**的回滚命令（含那个 .broken-* 路径）
setup_case
verify() { return 0; }
stop_vanblog() { return 0; }
start_vanblog() { return 0; }
reset() { return 1; }
OUT="$(offline_full_restore "${ARCHIVE}" 2>&1)"; rc=$?
assert_rc "${rc}" "1" "reset 失败时返回 1"
assert_contains "${OUT}" "回滚" "失败时给出回滚"
ASIDE="$(ls -d "${DATA}/data"/mongo.broken-* 2>/dev/null | head -1)"
assert_contains "${OUT}" "$(basename "${ASIDE:-__none__}")" "回滚命令里点名了那个被移开的旧库目录"
assert_contains "${OUT}" "mv " "回滚是把它改回去（而不是叫用户重装）"

# 2f) start 失败也要给回滚
setup_case
verify() { return 0; }
stop_vanblog() { return 0; }
start_vanblog() { return 1; }
reset() { return 0; }
OUT="$(offline_full_restore "${ARCHIVE}" 2>&1)"; rc=$?
assert_rc "${rc}" "1" "起栈失败时返回 1（不会带着半新半旧的目录硬往下走）"
assert_contains "${OUT}" "回滚" "起栈失败也给回滚命令"

# 2g) restore 的参数解析认 --offline-full，且不认识拼错的
setup_case
OUT="$(restore --offline-ful "${ARCHIVE}" 2>&1)"; rc=$?
assert_rc "${rc}" "2" "拼错的 --offline-ful 被拒绝（退出码 2，不会静默按普通恢复跑）"
assert_contains "${OUT}" "不认这个参数" "并点名是哪个参数"

# ---------------------------------------------------------------------------
# 3) backup_cron_run：失败要看得见，站点死了也要有兜底归档
# ---------------------------------------------------------------------------
setup_case
SIDE="${DATA}/log/vanblog-backups/cron-status.json"
backup() { return 0; }
OUT="$(backup_cron_run 2>&1)"; rc=$?
assert_rc "${rc}" "0" "备份成功时 cron 入口返回 0"
assert_contains "${OUT}" "方式：full" "并说明这次是整站备份"
if [[ -f "${SIDE}" ]]; then
  pass "写了旁路状态文件（doctor/status 靠它才能看见 cron 的结果）"
  assert_file_contains "${SIDE}" '"mode":"full"' "状态里记了方式"
  assert_file_contains "${SIDE}" '"exitCode":0' "状态里记了退出码"
  PERM="$(stat -c '%a' "${SIDE}" 2>/dev/null)"
  assert_eq "${PERM}" "600" "状态文件是 0600（里面有路径与失败原因，不该让别人读）"
  if command -v python3 >/dev/null 2>&1; then
    if python3 -c "import json,sys;json.load(open(sys.argv[1]))" "${SIDE}" 2>/dev/null; then
      pass "状态文件是合法 JSON（不是手拼出来的半截）"
    else
      fail "状态文件不是合法 JSON"
    fi
  fi
else
  fail "没有写旁路状态文件"
fi
# ⚠️ 不许写 server 那个 backup-status.json（它有自己的 schema，写坏会让所有"最近备份"判断失真）
if [[ ! -f "${DATA}/log/vanblog-backups/backup-status.json" ]]; then
  pass "没有去动 server 维护的 backup-status.json"
else
  fail "cron 入口写了 server 的 backup-status.json（两个真相会打架）"
fi

# 3b) 整站备份失败 → 回落离线包，成功就算成功，但状态里要写清是回落的
setup_case
rm -f "${SIDE}"
backup() { if [[ "${1:-}" == "--offline" ]]; then return 0; fi; return 1; }
OUT="$(backup_cron_run 2>&1)"; rc=$?
assert_rc "${rc}" "0" "整站备份失败但离线包成功时，cron 算成功（有备份比没备份重要）"
assert_contains "${OUT}" "回落离线打包" "并说清是回落到离线包"
assert_file_contains "${SIDE}" '"mode":"offline"' "状态里记的是 offline（事后能看出站点当时不可用）"
assert_file_contains "${SIDE}" '"exitCode":0' "但退出码是 0"

# 3c) 两个都失败 → 非 0，状态记 failed
setup_case
rm -f "${SIDE}"
backup() { return 1; }
OUT="$(backup_cron_run 2>&1)"; rc=$?
if [[ "${rc}" != "0" ]]; then pass "两种备份都失败时 cron 返回非 0（cron 会记进邮件/日志）"; else fail "两种备份都失败却返回 0"; fi
assert_file_contains "${SIDE}" '"mode":"failed"' "状态里记的是 failed"
assert_contains "${OUT}" "doctor" "失败时指路体检"

# 3d) 🔴 webhook 打不通绝不能让备份算失败
setup_case
rm -f "${SIDE}"
export VANBLOG_BACKUP_ALERT_WEBHOOK="https://example.invalid/hook"
export CURL_OTHER_RC=7
backup() { return 1; }
OUT="$(backup_cron_run 2>&1)"; rc=$?
assert_contains "${OUT}" "webhook 告警没发出去" "webhook 失败被如实报告"
assert_contains "${OUT}" "不影响备份结果" "并说清它不影响备份结果"
if [[ "${rc}" != "0" ]]; then pass "webhook 失败没有把退出码变成别的值（仍是备份本身的失败码）"; else fail "备份失败却返回 0"; fi
# 反过来：备份成功 + webhook 不通 ⇒ 必须仍是 0
setup_case
export VANBLOG_BACKUP_ALERT_WEBHOOK="https://example.invalid/hook"
export CURL_OTHER_RC=7
backup() { return 0; }
backup_cron_run >/dev/null 2>&1; rc=$?
assert_rc "${rc}" "0" "备份成功时，webhook 通不通都不影响退出码"
# 备份成功时根本不该发告警（否则每天骚扰）
if grep -q "example.invalid" "${CURL_CALLS}" 2>/dev/null; then
  fail "备份成功时也发了 webhook（会天天骚扰）"
else
  pass "备份成功时不发 webhook"
fi

# ---------------------------------------------------------------------------
# 4) mirror_backup_artifacts：第二个目的地，且永不拖累本地备份
# ---------------------------------------------------------------------------
setup_case
SRC_A="${DATA}/log/vanblog-backups/vanblog-full-20260920-010101.tar.zst"
echo "archive-bytes" >"${SRC_A}"
echo "deadbeef  $(basename "${SRC_A}")" >"${SRC_A}.sha256"
# 4a) 没配目的地 = 完全不动（默认行为一字不变）
MIRROR="${TEST_DIR}/mirror"
OUT="$(mirror_backup_artifacts "${SRC_A}" 2>&1)"; rc=$?
assert_rc "${rc}" "0" "没配镜像目的地时返回 0"
if [[ ! -d "${MIRROR}" ]]; then pass "没配镜像目的地时什么都不做"; else fail "没配却建了目录"; fi

# 4b) 正常镜像：归档 + sidecar 都过去，且校验通过
setup_case
export VANBLOG_BACKUP_MIRROR_DIR="${MIRROR}"
SRC_A="${DATA}/log/vanblog-backups/vanblog-full-20260920-010101.tar.zst"
echo "archive-bytes" >"${SRC_A}"
( cd "${DATA}/log/vanblog-backups" && sha256sum "$(basename "${SRC_A}")" >"$(basename "${SRC_A}").sha256" )
OUT="$(mirror_backup_artifacts "${SRC_A}" 2>&1)"; rc=$?
assert_rc "${rc}" "0" "镜像成功返回 0"
if [[ -f "${MIRROR}/$(basename "${SRC_A}")" ]]; then pass "归档已复制到镜像目的地"; else fail "归档没复制过去"; fi
if [[ -f "${MIRROR}/$(basename "${SRC_A}").sha256" ]]; then pass "sidecar 也复制了（否则在目的地那侧没法 verify）"; else fail "sidecar 没复制"; fi
assert_contains "${OUT}" "sha256 一致" "复制后做了真校验（不是只复制就完事）"
# 不许留下 .part 临时文件
if ls "${MIRROR}"/.*.part >/dev/null 2>&1; then fail "留下了 .part 临时文件"; else pass "没有留下 .part 临时文件（先写临时名再 mv）"; fi

# 4c) 🔴 目的地不可写 ⇒ 只 WARN，返回 0（本地备份绝不能因为镜像失败而算失败）
setup_case
RO="${TEST_DIR}/ro-mirror"
mkdir -p "${RO}"
chmod 0500 "${RO}"
export VANBLOG_BACKUP_MIRROR_DIR="${RO}"
SRC_A="${DATA}/log/vanblog-backups/vanblog-full-20260920-020202.tar.zst"
echo "x" >"${SRC_A}"
OUT="$(mirror_backup_artifacts "${SRC_A}" 2>&1)"; rc=$?
chmod 0700 "${RO}"
assert_rc "${rc}" "0" "目的地不可写时仍返回 0（本地那份才是主，不能因为远处写不进就两份都没有）"
assert_contains "${OUT}" "本地备份已成功" "并明说本地备份没受影响"

# 4d) 副本损坏 ⇒ 删掉坏副本（不能留一个"看着像备份"的坏文件），但仍返回 0
setup_case
export VANBLOG_BACKUP_MIRROR_DIR="${MIRROR}"
mkdir -p "${MIRROR}"
SRC_A="${DATA}/log/vanblog-backups/vanblog-full-20260920-030303.tar.zst"
echo "good-bytes" >"${SRC_A}"
echo "0000000000000000000000000000000000000000000000000000000000000000  $(basename "${SRC_A}")" >"${SRC_A}.sha256"
OUT="$(mirror_backup_artifacts "${SRC_A}" 2>&1)"; rc=$?
assert_rc "${rc}" "0" "校验不通过时也不把本地备份拖成失败"
assert_contains "${OUT}" "已删除这个坏副本" "校验不通过时明说删掉了坏副本"
if [[ -f "${MIRROR}/$(basename "${SRC_A}")" ]]; then
  fail "坏副本还留在镜像目的地（会让人误以为有备份）"
else
  pass "坏副本已从镜像目的地删除"
fi

# 4e) 按份数清理，且**只**清自己认识的名字
setup_case
export VANBLOG_BACKUP_MIRROR_DIR="${MIRROR}"
export VANBLOG_BACKUP_MIRROR_KEEP=3
mkdir -p "${MIRROR}"
rm -f "${MIRROR}"/*
for i in 1 2 3 4 5; do
  f="${MIRROR}/vanblog-full-2026090${i}-00000${i}.tar.zst"
  echo "a${i}" >"${f}"; touch -d "2026-09-0${i} 00:00:00" "${f}"
done
echo "别删我" >"${MIRROR}/README.txt"
echo "别删我" >"${MIRROR}/vanblog-full-IMPORTANT-notes.md"
SRC_A="${DATA}/log/vanblog-backups/vanblog-full-20260920-040404.tar.zst"
echo "newest" >"${SRC_A}"
( cd "${DATA}/log/vanblog-backups" && sha256sum "$(basename "${SRC_A}")" >"$(basename "${SRC_A}").sha256" )
mirror_backup_artifacts "${SRC_A}" >/dev/null 2>&1
LEFT="$(find "${MIRROR}" -maxdepth 1 -name 'vanblog-full-*.tar.zst' | wc -l)"
assert_eq "${LEFT}" "3" "镜像目的地只保留最新 3 份归档"
if [[ -f "${MIRROR}/vanblog-full-20260920-040404.tar.zst" ]]; then pass "留下的是最新那份"; else fail "最新那份被清掉了"; fi
if [[ -f "${MIRROR}/vanblog-full-20260901-000001.tar.zst" ]]; then fail "最旧那份没被清掉"; else pass "最旧那份被清掉了"; fi
if [[ -f "${MIRROR}/README.txt" && -f "${MIRROR}/vanblog-full-IMPORTANT-notes.md" ]]; then
  pass "不认识的其它文件一个没动（清理只碰自己认识的归档名）"
else
  fail "清理碰到了不认识的文件（这是会删掉用户东西的形状）"
fi

# ---------------------------------------------------------------------------
# 5) install-cron --every N（RPO）与 --hour 的互斥
# ---------------------------------------------------------------------------
# cron 行由 vanblog_cron_line 生成，直接测它最省事，也最不容易被桩挡住
setup_case
LINE="$(vanblog_cron_line '*/6')"
assert_contains "${LINE}" "0 */6 * * *" "--every 6 生成的是每 6 小时一次"
assert_contains "${LINE}" "backup-cron-run" "cron 跑的是 backup-cron-run（失败会回落离线包并写状态），不是裸 backup"
assert_not_contains "${LINE}" "' backup " "cron 行里不再是裸 backup"
LINE_D="$(vanblog_cron_line '3')"
assert_contains "${LINE_D}" "0 3 * * *" "--hour 3 的行为一字未变（每天凌晨 3 点）"
assert_contains "${LINE_D}" "backup-cron-run" "每日那条也走 cron 专用入口"

# 参数校验（用真 install_cron，配假 crontab 环境；只关心退出码与报错）
setup_case
FAKE_CRONTAB_FILE="${TEST_DIR}/crontab.txt"
crontab() {
  case "$1" in
  -l) echo "no crontab for root" >&2; return 1 ;;
  -r) : >"${FAKE_CRONTAB_FILE}"; return 0 ;;
  -) cat >"${FAKE_CRONTAB_FILE}"; return 0 ;;
  *) cat >"${FAKE_CRONTAB_FILE}"; return 0 ;;
  esac
}
OUT="$(install_cron --every 6 --hour 3 2>&1)"; rc=$?
assert_rc "${rc}" "2" "--every 与 --hour 同时给 ⇒ 退出码 2（不许猜，猜错等于 RPO 从 6 小时悄悄变成 24 小时）"
assert_contains "${OUT}" "不能同时给" "并说清为什么不行"
OUT="$(install_cron --every 0 2>&1)"; rc=$?
assert_rc "${rc}" "2" "--every 0 被拒（每 0 小时没有意义，写进 crontab 会变成每小时）"
OUT="$(install_cron --every 24 2>&1)"; rc=$?
assert_rc "${rc}" "2" "--every 24 被拒（超出 1-23）"
OUT="$(install_cron --every abc 2>&1)"; rc=$?
assert_rc "${rc}" "2" "--every 非数字被拒"
OUT="$(install_cron --every 2>&1)"; rc=$?
assert_rc "${rc}" "2" "--every 缺值被拒（不许静默按默认跑）"
assert_contains "${OUT}" "每 6 小时一次" "缺值时给的例子是 --every 自己的（不是 --hour 的 3）"

# ---------------------------------------------------------------------------
# 6) 证书剩余天数（真自签证书端到端）与 21/7 两个阈值
# ---------------------------------------------------------------------------
if command -v openssl >/dev/null 2>&1; then
  setup_case
  CERTDIR="${DATA}/caddy/data/certificates/acme-v02.api.letsencrypt.org-directory/example.com"
  mkdir -p "${CERTDIR}"
  mkcert() { openssl req -x509 -newkey rsa:2048 -keyout /dev/null -out "$1" -days "$2" -nodes -subj "/CN=example.com" >/dev/null 2>&1; }
  mkcert "${CERTDIR}/example.com.crt" 30
  DAYS="$(cert_days_for_file "${CERTDIR}/example.com.crt" 2>/dev/null)"
  if [[ "${DAYS}" =~ ^[0-9]+$ ]] && (( DAYS >= 28 && DAYS <= 30 )); then
    pass "真证书解析出剩余 ${DAYS} 天（签的是 30 天）"
  else
    fail "真证书解析出的天数不对：'${DAYS}'（期望 28-30）"
  fi
  OUT="$(cert_report 2>&1)"; rc=$?
  assert_rc "${rc}" "0" "剩 30 天时 cert_report 返回 0"
  assert_contains "${OUT}" "example.com" "报告里点名了域名"
  assert_contains "${OUT}" "剩余" "并给出剩余天数"

  mkcert "${CERTDIR}/example.com.crt" 15
  OUT="$(cert_report 2>&1)"; rc=$?
  assert_rc "${rc}" "1" "剩 15 天（<21）时返回 1 = 提醒"
  assert_contains "${OUT}" "还没续上要查" "并说清 caddy 本该已经在续了"

  mkcert "${CERTDIR}/example.com.crt" 3
  OUT="$(cert_report 2>&1)"; rc=$?
  assert_rc "${rc}" "2" "剩 3 天（<7）时返回 2 = 报红"
  assert_contains "${OUT}" "HSTS" "报红时必须提 HSTS（证书一过期浏览器会硬失败，站点彻底进不去）"

  # 已过期的证书要给负数，并且仍然报红
  mkcert "${CERTDIR}/example.com.crt" 1
  OUT="$(cert_report 2>&1)"; rc=$?
  assert_rc "${rc}" "2" "剩 1 天时也是报红"

  # 读不到证书是**合法状态**，不许当成失败
  setup_case
  rm -rf "${DATA}/caddy"
  OUT="$(cert_report 2>&1)"; rc=$?
  assert_rc "${rc}" "0" "没有证书目录时返回 0（纯 HTTP/IP 部署是合法的，不能每次体检都报红）"
  assert_contains "${OUT}" "合法状态" "并说明这是合法状态"
  setup_case
  mkdir -p "${DATA}/caddy/data/certificates/x"
  OUT="$(cert_report 2>&1)"; rc=$?
  assert_rc "${rc}" "0" "目录在但没有证书文件时也返回 0"
  # 解析不了（既没容器也没本机 node/openssl）时只说明，不算失败
  setup_case
  mkdir -p "${CERTDIR}" 2>/dev/null
  echo "not a certificate" >"${CERTDIR}/example.com.crt"
  cert_days_for_file() { return 1; }
  OUT="$(cert_report 2>&1)"; rc=$?
  assert_rc "${rc}" "0" "证书解析不了时返回 0（说清原因，但不算体检失败）"
  assert_contains "${OUT}" "解析不了" "并明说是解析不了，而不是假装健康"
else
  echo "SKIP: 本机没有 openssl，跳过证书解析的端到端测试"
fi

# 阈值本身也要钉住（剥注释后；注释里必然写着 21 与 7 这两个数字）
setup_case
CODE_ONLY="$(sed '/^[[:space:]]*#/d' "${SCRIPT}")"
if printf '%s\n' "${CODE_ONLY}" | grep -qF '(( days < 7 ))'; then
  pass "报红阈值是 7 天（在代码里，不是只在注释里）"
else
  fail "找不到 7 天报红阈值"
fi
if printf '%s\n' "${CODE_ONLY}" | grep -qF '(( days < 21 ))'; then
  pass "提醒阈值是 21 天（LE 证书 90 天、caddy 约剩 1/3 时开始续 ⇒ 21 天是"续过一轮仍失败"的线）"
else
  fail "找不到 21 天提醒阈值"
fi

# ---------------------------------------------------------------------------
# 7) doctor：只读、退出码可用
# ---------------------------------------------------------------------------
setup_case
# 编排文件与一个"健康"的环境
cat >"${BASE}/docker-compose.yaml" <<'YML'
services:
  vanblog:
    volumes:
      - /var/vanblog/caddy/data:/root/.local/share/caddy
YML
echo '{"at":"x","mode":"full","exitCode":0,"message":"ok","strictExitCode":0}' >"${DATA}/log/vanblog-backups/cron-status.json"
chmod 0600 "${DATA}/log/vanblog-backups/cron-status.json"
# ⚠️ "一切正常"的夹具必须包含一份**新鲜**归档：doctor 会把"一份归档都没有"正确地判成问题，
#    少了它这条用例测的就不是"正常环境返回 0"，而是"缺备份时返回 1"。
echo "fake" >"${DATA}/log/vanblog-backups/vanblog-full-20260920-050505.tar.zst"
OUT="$(doctor 2>&1)"; rc=$?
assert_rc "${rc}" "0" "一切正常时 doctor 返回 0（可以直接挂 cron/监控）"
assert_contains "${OUT}" "体检结果" "并给出一句总结"
assert_contains "${OUT}" "caddy 证书目录已持久化" "检查了证书目录有没有真的挂出来"
assert_contains "${OUT}" "cron 备份成功" "读到了 cron 的旁路状态"

# 7b) 健康接口 503 = server 活着但 mongo 连不上 ⇒ 必须报红并指路 --offline-full
setup_case
cat >"${BASE}/docker-compose.yaml" <<'YML'
services:
  vanblog:
    volumes:
      - /var/vanblog/caddy/data:/root/.local/share/caddy
YML
export CURL_HEALTH_CODE=503
OUT="$(doctor 2>&1)"; rc=$?
assert_rc "${rc}" "1" "健康接口 503 时 doctor 返回 1"
assert_contains "${OUT}" "mongo 连不上" "并说清 503 的含义（server 活着但库不通）"
assert_contains "${OUT}" "--offline-full" "直接指路唯一可行的恢复命令"

# 7c) 崩溃循环要能看出来
setup_case
cat >"${BASE}/docker-compose.yaml" <<'YML'
services:
  vanblog:
    volumes:
      - /var/vanblog/caddy/data:/root/.local/share/caddy
YML
export DOCKER_MODE=crashloop
export FAKE_RESTARTS=12
OUT="$(doctor 2>&1)"; rc=$?
assert_rc "${rc}" "1" "重启次数 12 时 doctor 返回 1"
assert_contains "${OUT}" "崩溃循环" "并说清这是崩溃循环"
assert_contains "${OUT}" "没有健康探测" "同时提醒这个容器没有健康探测（podman 构建会丢掉 HEALTHCHECK）"

# 7d) cron 上次失败要报出来（这是"没人知道备份一直没成功"那条的解药）
setup_case
cat >"${BASE}/docker-compose.yaml" <<'YML'
services:
  vanblog:
    volumes:
      - /var/vanblog/caddy/data:/root/.local/share/caddy
YML
echo '{"at":"x","mode":"failed","exitCode":1,"message":"整站备份失败(exit=1)；离线包也失败(exit=1)","strictExitCode":null}' \
  >"${DATA}/log/vanblog-backups/cron-status.json"
OUT="$(doctor 2>&1)"; rc=$?
assert_rc "${rc}" "1" "cron 上次失败时 doctor 返回 1"
assert_contains "${OUT}" "cron 备份**失败**" "并点名是 cron 备份失败"
assert_contains "${OUT}" "离线包也失败" "把失败原因原样带出来"

# 7e) doctor 是只读的：跑完不能改动数据目录里的任何文件
setup_case
cat >"${BASE}/docker-compose.yaml" <<'YML'
services:
  vanblog:
    volumes:
      - /var/vanblog/caddy/data:/root/.local/share/caddy
YML
BEFORE="$(find "${DATA}" -type f -printf '%p %s\n' | sort | md5sum)"
doctor >/dev/null 2>&1
AFTER="$(find "${DATA}" -type f -printf '%p %s\n' | sort | md5sum)"
assert_eq "${BEFORE}" "${AFTER}" "doctor 跑完数据目录里的文件一个没变（它是只读的）"

# ---------------------------------------------------------------------------
# 8) status 里也要有证书那一行（站长平时看的是 status，不是 doctor）
# ---------------------------------------------------------------------------
SRC_ONLY="$(sed '/^[[:space:]]*#/d' "${SCRIPT}")"
STATUS_BODY="$(printf '%s\n' "${SRC_ONLY}" | awk '/^show_status\(\)/{f=1} f&&/^\}/{exit} f')"
if printf '%s\n' "${STATUS_BODY}" | grep -q 'cert_report'; then
  pass "status 里会打印证书剩余天数"
else
  fail "status 里没有证书信息（站长平时看的是 status）"
fi
# 且只调一次（曾经误写成"静默跑一次再跑一次"，白做一次 docker exec）
N_CERT="$(printf '%s\n' "${STATUS_BODY}" | grep -c 'cert_report')"
assert_eq "${N_CERT}" "1" "status 里只调一次 cert_report（重复调用会白跑 docker exec）"

# ---------------------------------------------------------------------------
# 9) install-cron 的三个任务：marker 互不为子串、幂等、--remove 删干净、绝不覆盖已有 crontab
# ---------------------------------------------------------------------------
setup_case
# ⚠️ 这条是**设计约束**而不是实现细节：install-cron 的幂等检测与 --force 替换都用
#    `grep -F "${VANBLOG_CRON_MARKER}"`，所以只要有一个新 marker 包含旧 marker（或被它包含），
#    备份行的检测就会匹配到 verify/drill 行 ⇒ 误判"定时备份已装过"，或 --force 时误删别人的行。
for pair in "${VANBLOG_CRON_MARKER}|${VANBLOG_CRON_MARKER_VERIFY}" \
            "${VANBLOG_CRON_MARKER}|${VANBLOG_CRON_MARKER_DRILL}" \
            "${VANBLOG_CRON_MARKER_VERIFY}|${VANBLOG_CRON_MARKER_DRILL}"; do
  A="${pair%%|*}"; B="${pair##*|}"
  if [[ "${A}" == *"${B}"* || "${B}" == *"${A}"* ]]; then
    fail "marker 互为子串（'${A}' vs '${B}'）：grep -F 会把两种任务混为一谈"
  else
    pass "marker 互不为子串：${A} / ${B}"
  fi
done

VL="$(vanblog_cron_verify_line 4)"
assert_contains "${VL}" "0 4 * * 0" "每周校验是周日 04:00（= 每日备份的 3 点 + 1 小时，验的是刚备出来的那份）"
assert_contains "${VL}" "backup-verify" "每周校验跑 backup-verify（备份+立刻验证，失败非 0）"
assert_contains "${VL}" "${VANBLOG_CRON_MARKER_VERIFY}" "并带自己的 marker"
DL="$(vanblog_cron_drill_line 5)"
assert_contains "${DL}" "0 5 1 * *" "每月演练是每月 1 号 05:00"
assert_contains "${DL}" "'${VANBLOG_SELF_PATH}' drill" "每月演练跑 drill（真恢复一遍并对账）"
assert_contains "${DL}" "${VANBLOG_CRON_MARKER_DRILL}" "并带自己的 marker"

# 真 crontab 桩：-l 读文件、- 写文件、-r 删文件（绝不碰这台机器真的 crontab）
CRONF="${TEST_DIR}/crontab-real.txt"
crontab() {
  case "$1" in
  -l)
    if [[ "${CRONTAB_L_MODE:-ok}" == "broken" ]]; then echo "crontab: temporary failure" >&2; return 1; fi
    if [[ -f "${CRONF}" ]]; then cat "${CRONF}"; return 0; fi
    echo "no crontab for root" >&2; return 1
    ;;
  -r) rm -f "${CRONF}"; return 0 ;;
  -) cat >"${CRONF}.tmp" && mv -f "${CRONF}.tmp" "${CRONF}"; return 0 ;;
  *) return 0 ;;
  esac
}

cron_reset() { rm -f "${CRONF}"; }
# ⚠️ 不能用 `A && grep -c … || echo 0` 这个形状：`grep -c` 在**匹配 0 行**时也会打印 0，
#    但退出码是 1 ⇒ `|| echo 0` 又补一个 0，结果变成 "0\n0"，断言就永远对不上。
cron_count() {
  if [[ ! -f "${CRONF}" ]]; then printf '0'; return 0; fi
  local n
  n="$(grep -cF -- "$1" "${CRONF}" 2>/dev/null)"
  printf '%s' "${n:-0}"
}

# 9a) 装三个任务
setup_case; cron_reset
install_cron --with-verify --with-drill >/dev/null 2>&1; rc=$?
assert_rc "${rc}" "0" "install-cron --with-verify --with-drill 成功"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER}")" "1" "备份任务恰好一行"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_VERIFY}")" "1" "每周校验恰好一行"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_DRILL}")" "1" "每月演练恰好一行"

# 9b) 🔴 幂等：重复装**不许**出现两行
setup_case
install_cron --with-verify --with-drill >/dev/null 2>&1
OUT="$(install_cron --with-verify --with-drill 2>&1)"; rc=$?
assert_rc "${rc}" "0" "重复安装返回 0（不是错误）"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_VERIFY}")" "1" "🔴 重复 --with-verify 不会出现两行 verify"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_DRILL}")" "1" "🔴 重复 --with-drill 不会出现两行 drill"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER}")" "1" "重复安装也不会出现两行备份"
assert_contains "${OUT}" "不会重复添加" "并明确告诉用户没有重复添加"

# 9c) 🔴 绝不覆盖用户已有的 crontab（这是安全边界，一寸都不能让）
setup_case; cron_reset
printf '%s\n' "0 2 * * * /usr/local/bin/my-own-backup.sh" "# 我自己的任务，别动" >"${CRONF}"
install_cron --with-verify >/dev/null 2>&1
assert_file_contains "${CRONF}" "my-own-backup.sh" "🔴 用户自己的 cron 行原样保留"
assert_file_contains "${CRONF}" "我自己的任务，别动" "连用户的注释行也保留（不是只留命令行）"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_VERIFY}")" "1" "新任务也确实装上了"
# crontab 读取失败时必须**拒绝写入**，而不是当成空表覆盖掉
setup_case
export CRONTAB_L_MODE=broken
OUT="$(install_cron --with-verify 2>&1)"; rc=$?
if [[ "${rc}" != "0" ]]; then pass "读不到现有 crontab 时拒绝写入（宁可不装，绝不覆盖）"; else fail "读不到 crontab 却继续写入了"; fi
assert_contains "${OUT}" "不写入 crontab" "并说清是为了不覆盖已有任务"
# ⚠️ 上面那条 `rc != 0` 曾经是**假阳性守卫**：写回之后的复核也用同一个坏桩，于是 rc 因为
#    "另一个原因"变成非 0，断言就"歪打正着"通过了 —— 而用户的 crontab 其实已经被覆盖。
#    所以必须断言**文件内容**：读不到 crontab 时一个字节都不许写。
assert_file_contains "${CRONF}" "my-own-backup.sh" "🔴 读不到 crontab 时**没有**写入（用户已有的任务一条都没丢）"
unset CRONTAB_L_MODE

# 9d) 🔴 --remove 删掉**全部**三种，一条不留；用户自己的行仍然保留
setup_case; cron_reset
printf '%s\n' "0 2 * * * /usr/local/bin/my-own-backup.sh" >"${CRONF}"
install_cron --with-verify --with-drill >/dev/null 2>&1
install_cron --remove >/dev/null 2>&1; rc=$?
assert_rc "${rc}" "0" "--remove 成功"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER}")" "0" "🔴 --remove 删掉了备份行"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_VERIFY}")" "0" "🔴 --remove 也删掉了每周校验行（新 marker 不能漏）"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_DRILL}")" "0" "🔴 --remove 也删掉了每月演练行"
assert_file_contains "${CRONF}" "my-own-backup.sh" "但用户自己的行还在（--remove 只删自己的）"

# 9e) --remove 与 --with-* 互斥；拼错的开关仍然退出码 2
setup_case
OUT="$(install_cron --remove --with-verify 2>&1)"; rc=$?
assert_rc "${rc}" "2" "--remove 与 --with-verify 同时给 ⇒ 退出码 2（相反意图不许猜）"
OUT="$(install_cron --with-verif 2>&1)"; rc=$?
assert_rc "${rc}" "2" "拼错的 --with-verif 被拒（不会静默按"不装"跑）"

# 9f) 参数不同又没有 --force ⇒ 拒绝，不静默替换、也不加第二行
setup_case; cron_reset
install_cron --with-verify --hour 3 >/dev/null 2>&1
OUT="$(install_cron --with-verify --hour 8 2>&1)"; rc=$?
if [[ "${rc}" != "0" ]]; then pass "已有校验条目、参数不同又没 --force 时拒绝（要求显式）"; else fail "参数不同却静默改了"; fi
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_VERIFY}")" "1" "拒绝时也没有加第二行"
assert_contains "${OUT}" "--force" "并告诉用户要显式 --force"

# 9g) --force 只重写**这次请求的**任务，没请求的保持原样
setup_case; cron_reset
install_cron --with-verify --with-drill --hour 3 >/dev/null 2>&1
BEFORE_DRILL="$(grep -F "${VANBLOG_CRON_MARKER_DRILL}" "${CRONF}")"
install_cron --force --with-verify --hour 5 >/dev/null 2>&1
AFTER_DRILL="$(grep -F "${VANBLOG_CRON_MARKER_DRILL}" "${CRONF}" 2>/dev/null)"
assert_eq "${BEFORE_DRILL}" "${AFTER_DRILL}" "--force 改备份与校验时，没被请求的演练行原样保留（不会顺手删掉用户装过的东西）"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_VERIFY}")" "1" "--force 重写校验后仍然只有一行"
assert_file_contains "${CRONF}" "0 5 * * *" "--force 真的把备份时间改成了 5 点"

# 9h) 🔴 "备份行已存在"时加装可选任务：三条性质都必须成立
#     这一组是**真实踩过的坑**钉出来的：把同参数分支的 `return 0` 改成标志位之后，控制流掉进了
#     `--force` 的移除分支 ⇒ 备份行被删掉、只写回新任务，**定时备份静默停止**，而命令还返回 0。
setup_case; cron_reset
install_cron >/dev/null 2>&1
ENVF="${BASE}/vanblog-cron.env"
printf '%s\n' "# 用户手工加的一行，绝不能被冲掉" "export MY_OWN_VAR=1" >>"${ENVF}" 2>/dev/null
OUT="$(install_cron --with-verify 2>&1)"; rc=$?
assert_rc "${rc}" "0" "备份行已存在时 --with-verify 返回 0"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER}")" "1" "🔴 备份行**仍然在**（加装可选任务绝不能把已有的备份行删掉）"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_VERIFY}")" "1" "verify 行确实装上了（不是静默什么都不做）"
assert_not_contains "${OUT}" "--force：先移除旧条目" "没给 --force 时不许走"先移除旧条目"那条路"
assert_not_contains "${OUT}" "参数不同" "备份行一模一样时不许误报"参数不同""
if [[ -f "${ENVF}" ]] && grep -q "MY_OWN_VAR" "${ENVF}" 2>/dev/null; then
  pass "🔴 token/环境文件没有被重写（用户手工补的 VANBLOG_ADMIN_TOKEN 不会被冲掉）"
else
  fail "环境文件被重写了：用户手工补进去的 token 会丢"
fi

# 9i) 不给 --with-* 时绝不装可选任务（默认行为一字不变）
setup_case; cron_reset
install_cron >/dev/null 2>&1
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_VERIFY}")" "0" "默认不装每周校验（要显式 --with-verify）"
assert_eq "$(cron_count "${VANBLOG_CRON_MARKER_DRILL}")" "0" "默认不装每月演练（它需要容器引擎与磁盘）"

# 9j) 源码级：同参数分支不许再出现"提前 return"（那会让可选任务永远走不到）
CRON_SRC="$(sed '/^[[:space:]]*#/d' "${SCRIPT}" | awk '/^install_cron\(\)/{f=1} f&&/^\}/{exit} f')"
if printf '%s\n' "${CRON_SRC}" | grep -q 'backup_already=1'; then
  pass "同参数分支设的是标志位（继续往下处理可选任务），不是提前 return"
else
  fail "找不到 backup_already 标志位：同参数分支可能又变回提前 return 了"
fi
# 空转反证：尺子必须能命中旧形状（否则上面那条 PASS 说明不了任何事）
if printf '        echo -e "x"\n        return 0\n      fi\n' | grep -q 'return 0'; then
  pass "反证：这把尺子确实能命中 'return 0' 这个旧形状"
else
  fail "反证失败：尺子命不中旧形状，上面那条断言是空转的"
fi
# force 的移除分支必须挂在 else 上（否则"已装过"路径会掉进去把备份行删掉）
if printf '%s\n' "${CRON_SRC}" | grep -B1 'grep -vF "${VANBLOG_CRON_MARKER}")"' | grep -q 'else'; then
  pass "force 的移除分支挂在 else 上（不会被"已装过"路径掉进去）"
else
  fail "force 的移除分支不在 else 里：已装过的路径会掉进去删掉备份行"
fi

echo
echo "passed=${PASS} failed=${FAIL}"
[[ ${FAIL} -eq 0 ]]
