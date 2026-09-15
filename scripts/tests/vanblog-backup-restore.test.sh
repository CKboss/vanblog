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
assert_contains "${SRC}" 'VANBLOG_SCRIPT_VERSION="v0.5.0"' "脚本版本号已更新"
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
assert_contains "${SRC_BACKUP}" '--keep) keep="${arg}"' "支持 --keep N"
assert_contains "${SRC_BACKUP}" 'VANBLOG_BACKUP_KEEP' "支持 VANBLOG_BACKUP_KEEP 环境变量（cron 用）"
assert_contains "$(cat "${SCRIPT}")" "VANBLOG_BACKUP_KEEP=7" "--help 里写了这个环境变量"


echo "passed=${PASS} failed=${FAIL}"
[[ ${FAIL} -eq 0 ]]
