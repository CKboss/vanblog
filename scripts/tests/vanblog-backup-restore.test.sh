#!/usr/bin/env bash
# vanblog.sh 的 backup/restore 与「不该删卷」相关行为的单元测试。
# 全程用假的 docker-compose（记录调用）+ 真实的 tar，不碰任何真容器。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"
PUBLIC_SCRIPT="${ROOT}/docs/.vuepress/public/vanblog.sh"

PASS=0
FAIL=0
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }

assert_contains() { # haystack needle label
  if [[ "$1" == *"$2"* ]]; then pass "$3"; else fail "$3 (缺少: $2)"; fi
}
assert_not_contains() {
  if [[ "$1" != *"$2"* ]]; then pass "$3"; else fail "$3 (不该出现: $2)"; fi
}
assert_eq() {
  if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (期望 $2，实际 $1)"; fi
}

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

# 假的 docker-compose / docker：只记录调用
BIN="${TEST_DIR}/bin"
mkdir -p "${BIN}"
cat > "${BIN}/docker-compose" <<'EOS'
#!/bin/bash
echo "docker-compose $*" >> "${VANBLOG_TEST_LOG}"
exit 0
EOS
cat > "${BIN}/docker" <<'EOS'
#!/bin/bash
echo "docker $*" >> "${VANBLOG_TEST_LOG}"
exit 0
EOS
chmod +x "${BIN}/docker-compose" "${BIN}/docker"

BASE="${TEST_DIR}/var/vanblog"
DATA="${BASE}/data"
mkdir -p "${DATA}/data/static" "${DATA}/data/mongo" "${DATA}/log" "${DATA}/caddy/config"
echo "img-bytes" > "${DATA}/data/static/a.webp"
echo "wired" > "${DATA}/data/mongo/WiredTiger"
echo "locked" > "${DATA}/data/mongo/mongod.lock"

# 生成一份可 source 的脚本副本（跳过 main、用测试路径）
run_snippet() { # log_file env_lines snippet
  local log="$1" env_lines="$2" snippet="$3"
  cat > "${TEST_DIR}/case.sh" <<EOS
set -u
export PATH="${BIN}:\$PATH"
export VANBLOG_TEST_LOG="${log}"
export VANBLOG_BASE_PATH="${BASE}"
export VANBLOG_DATA_PATH="${DATA}"
export VANBLOG_DATA_PATH_RAW="${DATA}"
export VANBLOG_SKIP_MAIN=1
${env_lines}
source "${SCRIPT}"
${snippet}
EOS
  bash "${TEST_DIR}/case.sh" 2>&1
}

# ---------- 1) 备份 ----------
LOG="${TEST_DIR}/backup.log"; : > "${LOG}"
OUT="$(run_snippet "${LOG}" "" 'backup 0 --offline --consistent; echo "rc=$?"')"
assert_contains "${OUT}" "备份成功" "一致性备份成功"
assert_contains "${OUT}" "rc=0" "备份返回 0"
assert_contains "${OUT}" "先停止 MongoDB" "一致性模式会先停 MongoDB"
assert_contains "$(cat "${LOG}")" "stop mongo" "调用了 compose stop mongo"
assert_contains "$(cat "${LOG}")" "start mongo" "备份后重新启动了 mongo"

ARCHIVE="$(ls "${BASE}"/vanblog-backup-*.tar.gz 2>/dev/null | head -n 1)"
if [[ -n "${ARCHIVE}" ]]; then
  pass "生成了归档文件 $(basename "${ARCHIVE}")"
  LIST="$(tar tzf "${ARCHIVE}")"
  assert_contains "${LIST}" "./data/data/static/a.webp" "归档含图床文件"
  assert_contains "${LIST}" "./data/data/mongo/WiredTiger" "归档含数据库文件"
  assert_contains "${LIST}" "./data/log" "归档含日志目录（整站备份归档就放在这里）"
else
  fail "没有生成归档文件"
fi

# ---------- 2) 热备份（默认）不停 mongo，并给出提示 ----------
LOG2="${TEST_DIR}/hot.log"; : > "${LOG2}"
OUT2="$(run_snippet "${LOG2}" "" 'backup 0 --offline; echo "rc=$?"')"
assert_contains "${OUT2}" "热备份" "默认是热备份并给出提示"
assert_not_contains "$(cat "${LOG2}")" "stop mongo" "热备份不会停 mongo"
assert_contains "${OUT2}" "rc=0" "热备份返回 0"

# ---------- 3) 数据目录不存在要报错 ----------
OUT3="$(run_snippet "${TEST_DIR}/x.log" "export VANBLOG_DATA_PATH=\"${TEST_DIR}/missing\"" 'backup 0 --offline; echo "rc=$?"')"
assert_contains "${OUT3}" "未找到数据目录" "数据目录缺失时报错"
assert_contains "${OUT3}" "rc=1" "数据目录缺失返回 1"

# ---------- 4) 恢复：错误路径 ----------
OUT4="$(run_snippet "${TEST_DIR}/r1.log" "export VANBLOG_RESTORE_FILE=\"${TEST_DIR}/nope.tar.gz\"" 'restore 0; echo "rc=$?"')"
assert_contains "${OUT4}" "找不到备份文件" "恢复时文件不存在会明确报错"
assert_contains "${OUT4}" "rc=1" "文件不存在返回 1"

echo "not a gzip" > "${TEST_DIR}/bad.tar.gz"
OUT5="$(run_snippet "${TEST_DIR}/r2.log" "export VANBLOG_RESTORE_FILE=\"${TEST_DIR}/bad.tar.gz\"" 'restore 0; echo "rc=$?"')"
assert_contains "${OUT5}" "不是完整的 gzip" "恢复时校验压缩包完整性"
assert_contains "${OUT5}" "rc=1" "坏包返回 1"

# ---------- 5) 恢复：正常往返 ----------
echo "changed-after-backup" > "${DATA}/data/static/a.webp"
rm -f "${DATA}/data/mongo/WiredTiger"
LOG6="${TEST_DIR}/restore.log"; : > "${LOG6}"
OUT6="$(run_snippet "${LOG6}" "export VANBLOG_RESTORE_FILE=\"${ARCHIVE}\"
export VANBLOG_ASSUME_YES=1" 'restore 0; echo "rc=$?"')"
assert_contains "${OUT6}" "恢复成功" "恢复成功"
assert_contains "${OUT6}" "已删除 mongod.lock" "恢复后清掉了 mongod.lock（热备份产物）"
assert_eq "$(cat "${DATA}/data/static/a.webp")" "img-bytes" "被改动的文件已还原"
if [[ -f "${DATA}/data/mongo/WiredTiger" ]]; then pass "被删除的数据库文件已还原"; else fail "数据库文件没有还原"; fi
if [[ -f "${DATA}/data/mongo/mongod.lock" ]]; then fail "mongod.lock 还在，mongod 会拒绝启动"; else pass "mongod.lock 已被删除"; fi
assert_contains "$(cat "${LOG6}")" "up -d" "恢复后自动启动"

# ---------- 6) 任何常规操作都不能删卷 ----------
COMBINED="$(cat "${LOG}" "${LOG2}" "${LOG6}")"
assert_contains "${COMBINED}" "down --remove-orphans" "停止时用 down --remove-orphans"
assert_not_contains "${COMBINED}" "down -v" "常规操作不带 -v（那会删卷）"
SRC="$(cat "${SCRIPT}")"
DOWN_V_COUNT="$(grep -c 'down -v' "${SCRIPT}" || true)"
assert_eq "${DOWN_V_COUNT}" "1" "只有卸载流程保留 down -v（1 处）"
assert_not_contains "${SRC}" "chmod 777" "不再把数据目录 chmod 777（里面有证书私钥和数据库）"
assert_contains "${SRC}" 'if ! command -v docker-compose' "只在缺少 docker-compose 时才建别名，不覆盖用户已有的"

# ---------- 7) 两份脚本一致、版本已更新、部署文件同步 ----------
if diff -q "${SCRIPT}" "${PUBLIC_SCRIPT}" >/dev/null 2>&1; then
  pass "scripts/ 与 docs/.vuepress/public/ 两份脚本一致"
else
  fail "两份 vanblog.sh 不一致"
fi
assert_contains "${SRC}" 'VANBLOG_SCRIPT_VERSION="v0.6.0"' "脚本版本号已更新"
TEMPLATE="$(cat "${ROOT}/docker-compose/docker-compose-template.yml")"
assert_contains "${TEMPLATE}" "VAN_BLOG_BACKUP_PATH" "编排模板里说明了备份目录变量"
assert_contains "${TEMPLATE}" "VANBLOG_DISABLE_IP_GEO" "编排模板里说明了 IP 归属地开关"
DOCKERFILE="$(cat "${ROOT}/Dockerfile")"
assert_contains "${DOCKERFILE}" "zstd xz" "运行镜像装了 zstd/xz（否则整站备份会静默降级成 gzip）"

echo
# ---------------------------------------------------------------------------
# 备份保留策略（--keep N / VANBLOG_BACKUP_KEEP）
# 背景：一份整站备份几十 MB，配了 cron 每天备一次一个月就是 2GB，而仓库里
# 以前**没有任何清理逻辑**（脚本和 server 都只管写不管删），小盘机器迟早被撑满。
# ---------------------------------------------------------------------------
echo
echo "== 备份保留策略 =="

PRUNE_DIR="${TEST_DIR}/prune"
mkdir -p "${PRUNE_DIR}/data/log/vanblog-backups"
BK="${PRUNE_DIR}/data/log/vanblog-backups"
for i in 1 2 3 4 5; do
  head -c 1200 /dev/urandom >"${BK}/vanblog-full-2026090${i}-010101.tar.zst"
  echo '{}' >"${BK}/vanblog-full-2026090${i}-010101.manifest.json"
  # 用 mtime 决定新旧（prune 按 ls -1t 排序）
  touch -d "2026-09-0${i}" "${BK}/vanblog-full-2026090${i}-010101.tar.zst" \
    "${BK}/vanblog-full-2026090${i}-010101.manifest.json"
done
echo "不要删我" >"${BK}/restore-me.txt"
echo "不要删我" >"${BK}/vanblog-backup-20260901-010101.tar.gz" # 离线备份不属于 full 那一类

(
  export VANBLOG_SKIP_MAIN=1 VANBLOG_BASE_PATH="${PRUNE_DIR}" VANBLOG_DATA_PATH="${PRUNE_DIR}/data"
  # shellcheck disable=SC1090
  source "${SCRIPT}" >/dev/null 2>&1
  prune_old_backups full 2
) >"${TEST_DIR}/prune.out" 2>&1

left="$(ls -1 "${BK}" | tr '\n' ' ')"
assert_contains "${left}" "vanblog-full-20260905-010101.tar.zst" "保留策略：最新的一份留着"
assert_contains "${left}" "vanblog-full-20260904-010101.tar.zst" "保留策略：第二新的留着"
if [[ "${left}" == *"vanblog-full-20260903"* || "${left}" == *"vanblog-full-20260902"* || "${left}" == *"vanblog-full-20260901-010101.tar.zst"* ]]; then
  fail "保留策略：超出份数的旧归档应该被删掉（实际剩下：${left}）"
else
  pass "保留策略：超出份数的旧归档被删掉了"
fi
# 被删归档的 sidecar 要一起删（否则 restore 列表里会出现孤儿清单），
# 但**留下的**那两份的清单必须还在 —— 别把断言写成"一个 manifest 都不许有"。
if [[ "${left}" == *"vanblog-full-20260903-010101.manifest.json"* ||
  "${left}" == *"vanblog-full-20260902-010101.manifest.json"* ||
  "${left}" == *"vanblog-full-20260901-010101.manifest.json"* ]]; then
  fail "保留策略：被删归档的 .manifest.json 应该一起删（实际剩下：${left}）"
else
  pass "保留策略：连带删掉了被删归档的 .manifest.json"
fi
assert_contains "${left}" "vanblog-full-20260905-010101.manifest.json" "保留策略：留下的归档，清单也留着"
assert_contains "${left}" "vanblog-full-20260904-010101.manifest.json" "保留策略：第二新的清单也留着"
assert_contains "${left}" "restore-me.txt" "保留策略：不认识的文件一概不动"
assert_contains "${left}" "vanblog-backup-20260901-010101.tar.gz" "保留策略：full 模式不碰离线备份归档"
assert_contains "$(cat "${TEST_DIR}/prune.out")" "删掉 3 份" "保留策略：报告了删掉几份"
assert_contains "$(cat "${TEST_DIR}/prune.out")" "释放" "保留策略：报告了释放多少空间"

# keep=0 / 非数字 / 比现有份数还大：都不该删任何东西
for k in 0 abc 99; do
  before="$(ls -1 "${BK}" | wc -l | tr -d ' ')"
  (
    export VANBLOG_SKIP_MAIN=1 VANBLOG_BASE_PATH="${PRUNE_DIR}" VANBLOG_DATA_PATH="${PRUNE_DIR}/data"
    # shellcheck disable=SC1090
    source "${SCRIPT}" >/dev/null 2>&1
    prune_old_backups full "${k}"
  ) >"${TEST_DIR}/prune-${k}.out" 2>&1
  after="$(ls -1 "${BK}" | wc -l | tr -d ' ')"
  if [[ "${before}" == "${after}" ]]; then
    pass "keep=${k} 时不删任何东西（${before} → ${after}）"
  else
    fail "keep=${k} 时删了东西（${before} → ${after}）"
  fi
done

# 只删自己认识的两种归档名，且只在备份目录里删（不递归）
SRC_PRUNE="$(awk '/^prune_old_backups\(\) \{/,/^\}/' "${SCRIPT}")"
assert_contains "${SRC_PRUNE}" "vanblog-full-*.tar.*" "prune 只认整站备份的文件名"
assert_contains "${SRC_PRUNE}" "vanblog-backup-*.tar.*" "prune 只认离线备份的文件名"
assert_contains "${SRC_PRUNE}" '*[!0-9]*) return 0' "keep 不是正整数就什么都不做"
assert_contains "${SRC_PRUNE}" 'rm -f "${dir:?}/${name}"' "删除路径带 :? 保护（dir 为空时不会变成 rm -f /xxx）"

# 只在备份成功之后清理：失败时删旧备份等于把最后的恢复点也弄没了
SRC_BACKUP="$(awk '/^backup\(\) \{/,/^\}/' "${SCRIPT}")"
assert_contains "${SRC_BACKUP}" 'if [[ ${rc} -eq 0 && -n "${keep}" ]]' "只有备份成功才清理"
assert_contains "${SRC_BACKUP}" '--format | --keep)' "--format / --keep 走同一条带值分支"
assert_contains "${SRC_BACKUP}" 'keep="${val}"' "支持 --keep N（值取自下一个参数）"
assert_contains "${SRC_BACKUP}" 'VANBLOG_BACKUP_KEEP' "支持 VANBLOG_BACKUP_KEEP 环境变量（cron 用）"
assert_contains "$(cat "${SCRIPT}")" "VANBLOG_BACKUP_KEEP=7" "--help 里写了这个环境变量"

# ── 打错的开关必须被拒绝，不能静默按默认值备份 ─────────────────────────────────
# 为什么这条值钱：backup 上的静默降级**看不出来**。用户敲 `backup --offine`（少一个 l），
# 旧代码一声不响按 API 模式备份，他以为拿到了含 caddy 证书的离线包 —— 等到真要换机器那天
# 才发现归档里没有证书。同一类里还有更隐蔽的一条：`--verbose` 写在 --help 里、备份输出还会
# 提示"完整清单加 --verbose"，但解析器从来没处理过它（被那条吞一切的分支吃掉了）。
echo "-- backup 的未知/缺值参数必须被拒绝 --"
SRC_BACKUP_USAGE="$(awk '/^print_backup_usage\(\) \{/,/^\}/' "${SCRIPT}")"
assert_contains "${SRC_BACKUP_USAGE}" "--offline" "用法里列了 --offline"
assert_contains "${SRC_BACKUP_USAGE}" "--verbose" "用法里列了 --verbose"
assert_contains "${SRC_BACKUP_USAGE}" "--keep N" "用法里列了 --keep N"

LOG_BAD="${TEST_DIR}/bad.log"
OUT="$(run_snippet "${LOG_BAD}" "" 'backup 0 --oops; echo "rc=$?"')"
assert_contains "${OUT}" "rc=2" "backup --oops 退出码 2（用法错误，与 update 一致）"
assert_contains "${OUT}" "backup 不认这个参数：--oops" "点名了打错的那个参数"
assert_contains "${OUT}" "--offline" "报错里带出正确的开关名，用户能照着改"
assert_contains "${OUT}" "不会静默按默认值备份" "并说清后果（不是只丢一句「参数错了」）"

OUT="$(run_snippet "${LOG_BAD}" "" 'backup 0 --offine; echo "rc=$?"')"
assert_contains "${OUT}" "rc=2" "少一个字母的 --offine 也被拒（这正是最贵的那种静默降级）"
OUT="$(run_snippet "${LOG_BAD}" "" 'backup 0 --keep; echo "rc=$?"')"
assert_contains "${OUT}" "rc=2" "--keep 后面忘了写数字 ⇒ 拒绝，不当成「不清理」"
assert_contains "${OUT}" "后面要跟一个值" "并说清是缺值"
OUT="$(run_snippet "${LOG_BAD}" "" 'backup 0 --format; echo "rc=$?"')"
assert_contains "${OUT}" "rc=2" "--format 缺值同样拒绝"
# 缺值的例子要**按开关**给：第一版对所有开关都举「zstd、7」，于是 --keep 的报错里出现
# 「例如 --keep zstd」—— 在一条本来就在讲"你参数写错了"的消息里再给个错例子，等于把人往沟里带。
OUT_K="$(run_snippet "${LOG_BAD}" "" 'backup 0 --keep')"
assert_contains "${OUT_K}" "只留最新 7 份" "--keep 缺值时举的是份数的例子（不是格式值）"
assert_not_contains "${OUT_K}" "--keep zstd" "--keep 缺值时不会举 zstd 这种格式值当例子"
OUT_F="$(run_snippet "${LOG_BAD}" "" 'backup 0 --format')"
assert_contains "${OUT_F}" "zstd|xz|gzip" "--format 缺值时举的是格式的例子"

# 合法开关必须**仍然被接受**（别把"收紧"做成"什么都拒"）
assert_contains "${SRC_BACKUP}" "--offline)" "合法开关 --offline 仍在解析器里"
assert_contains "${SRC_BACKUP}" "--api | --full)" "合法开关 --api / --full 仍在解析器里"
assert_contains "${SRC_BACKUP}" "--consistent)" "合法开关 --consistent 仍在解析器里"
assert_contains "${SRC_BACKUP}" '--verbose) export VANBLOG_VERBOSE=1' "--verbose 现在真的生效（以前被静默吞掉）"
# 行为级验证（不只是源码里有这一行）：--verbose 真的把开关置上了，而且置上之后仍然会拒绝坏参数
OUT_V="$(run_snippet "${LOG_BAD}" "" 'backup 0 --verbose --oops >/dev/null 2>&1; echo "verbose=${VANBLOG_VERBOSE:-unset}"')"
assert_contains "${OUT_V}" "verbose=1" "--verbose 把 VANBLOG_VERBOSE 置成 1（print_backup_json 读的就是它）"

# 反证一：拒绝路径**不许**真的动手备份
# ⚠️ 这里不能拿 "vanblog-full-" 当判据：print_backup_usage 的正文里就写着
#    `vanblog-full-<时间戳>.tar.zst`，断言会匹配到**用法说明**而不是真备份（第一版就这么假红过）。
#    只用"真跑起来才会出现的字样"：离线备份的开场白、成功语、带数字的真实归档名前缀。
for forbidden in "备份 vanblog" "备份成功" "vanblog-backup-2"; do
  assert_not_contains "${OUT}" "${forbidden}" "拒绝路径上没有「${forbidden}」（没有一边报错一边动手）"
done
# 反证二：拒绝路径一次都不许调用引擎（假 docker/docker-compose 会把调用记进日志）
LOG_CLEAN="${TEST_DIR}/clean.log"; : > "${LOG_CLEAN}"
run_snippet "${LOG_CLEAN}" "" 'backup 0 --oops' >/dev/null 2>&1
assert_eq "$(wc -c < "${LOG_CLEAN}" | tr -d ' ')" "0" "拒绝路径没有调用 docker / docker-compose（日志空）"

# 反证三：解析器里不许再有"吞掉一切未知开关"的那条分支
# ⚠️ 必须剥掉注释再断言：解释这个改动的注释里就写着旧形状（本仓库已踩 6 次这个坑）
SRC_BACKUP_CODE="$(printf '%s\n' "${SRC_BACKUP}" | grep -v '^[[:space:]]*#')"
SWALLOW_RE='^[[:space:]]*(0 \| )?--\*\)[[:space:]]*:[[:space:]]*;;'
if printf '%s\n' "${SRC_BACKUP_CODE}" | grep -qE "${SWALLOW_RE}"; then
  fail "backup 的解析器里还有静默吞掉未知开关的分支"
else
  pass "backup 的解析器里没有静默吞开关的分支（剥掉注释后核对）"
fi
# 反证的反证：同一条正则必须能抓住旧形状，否则上面那条是空转
if printf '%s\n' '    0 | --*) : ;;' | grep -qE "${SWALLOW_RE}"; then
  pass "那条正则确实抓得住旧形状（断言不是空转）"
else
  fail "正则抓不住旧形状 —— 上面那条断言空转了，请重写"
fi

echo "passed=${PASS} failed=${FAIL}"
[[ ${FAIL} -eq 0 ]]
