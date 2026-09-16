#!/usr/bin/env bash
# `./vanblog.sh verify` / sha256 sidecar / 磁盘空间预检 的测试。
# 归档全部用**真的** tar + zstd/xz/gzip 现场打（不 mock 压缩器）：
# verify 的价值就在于抓住真截断/真损坏，假归档测不出这个。
# 结构按 server 的打包方式造（tar -C staging . ⇒ ./manifest.json、./db/<库>/<集合>.ndjson、
# ./static/<img|file|customPage|themes>/…，见 packages/server/src/utils/fullBackup.ts）。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
# ⚠️ printf 后面接 grep -q：grep 匹配到就提前退出，大文本（整个脚本）会写出一截
#    broken pipe 噪音，printf 的 stderr 要压掉
assert_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }
assert_not_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then fail "$3 (unexpected: $2)"; else pass "$3"; fi; }

echo "== vanblog.sh verify / sha256 / 空间预检 =="

for tool in tar zstd xz gzip sha256sum; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "本机没有 ${tool}，没法真跑这个套件"
    echo "passed=0 failed=1"
    exit 1
  fi
done

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

BASE="${TEST_DIR}/var/vanblog"
DATA="${BASE}/data"
BK="${DATA}/log/vanblog-backups"
mkdir -p "${BK}" "${DATA}/data/static/img" "${DATA}/data/mongo"
echo "img" >"${DATA}/data/static/img/a.webp"

# 可 source 的脚本环境（跳过 main）
export VANBLOG_SKIP_MAIN=1
export VANBLOG_BASE_PATH="${BASE}"
export VANBLOG_DATA_PATH="${DATA}"
unset VANBLOG_DATA_PATH_RAW VANBLOG_BACKUP_DIR VANBLOG_ADMIN_TOKEN \
  VANBLOG_BACKUP_SKIP_SPACE_CHECK VANBLOG_BACKUP_SPACE_MARGIN_MB 2>/dev/null || true
# ⚠️ 前面的用例可能定义过 df/du/curl 桩函数，函数优先级高于 PATH，必须清掉
unset -f df du curl docker docker-compose git 2>/dev/null || true
# shellcheck disable=SC1090
source "${SCRIPT}" >/dev/null 2>&1

# 造一个 server 形状的整站备份归档：make_full_archive <dest> [no-db|no-manifest|no-static]
make_full_archive() {
  local dest="$1" variant="${2:-}"
  local st="${TEST_DIR}/staging-$$-${RANDOM}"
  mkdir -p "${st}/db/vanBlog" "${st}/db/waline" "${st}/static/img"
  [[ "${variant}" == no-manifest ]] || echo '{"kind":"vanblog-full-backup","version":1}' >"${st}/manifest.json"
  if [[ "${variant}" != no-db ]]; then
    echo '{"_id":{"$oid":"507f1f77bcf86cd799439011"},"title":"t"}' >"${st}/db/vanBlog/articles.ndjson"
    echo '[]' >"${st}/db/vanBlog/articles.indexes.json"
    echo '{"x":1}' >"${st}/db/waline/Comment.ndjson"
  fi
  if [[ "${variant}" == no-static ]]; then
    # ⚠️ 整个 static/ 树都要去掉：只删文件留空目录的话，tar 会把空目录打进去，
    #    成员列表里仍有 ./static/img/，"没有静态树"的用例就测不到想测的分支
    rm -rf "${st}/static"
  else
    echo "fakeimg" >"${st}/static/img/a.webp"
  fi
  case "${dest}" in
  *.tar.zst) (cd "${st}" && tar -cf - .) | zstd -19 --long=27 -q -o "${dest}" ;;
  *.tar.xz) (cd "${st}" && tar -cf - .) | xz -9e >"${dest}" ;;
  *.tar.gz) (cd "${st}" && tar -cf - .) | gzip -9 >"${dest}" ;;
  *) (cd "${st}" && tar -cf - .) | zstd -q -o "${dest}" ;;
  esac
  local rc=$?
  rm -rf "${st}"
  return ${rc}
}

# ---------- 1) 三种压缩格式的真归档都 OK ----------
make_full_archive "${BK}/vanblog-full-20260915-010101.tar.zst"
make_full_archive "${BK}/vanblog-full-20260915-020202.tar.gz"
make_full_archive "${BK}/vanblog-full-20260915-030303.tar.xz"
echo '{}' >"${BK}/vanblog-full-20260915-010101.manifest.json"

OUT="$(verify 2>&1)"
RC=$?
assert_eq "${RC}" "0" "三个真归档全部通过时 verify 返回 0"
assert_contains "${OUT}" "OK 3" "汇总报告 OK 3"
assert_contains "${OUT}" "zstd 完整性 ✓" "zstd 归档走了流式完整性测试"
assert_contains "${OUT}" "gzip 完整性 ✓" "gzip 归档走了流式完整性测试"
assert_contains "${OUT}" "xz 完整性 ✓" "xz 归档走了流式完整性测试"
assert_contains "${OUT}" "manifest ✓" "认出了归档内的 manifest.json"
assert_contains "${OUT}" "NDJSON 2 个 ✓" "数出了 db/<库>/<集合>.ndjson（vanBlog + waline）"
assert_contains "${OUT}" "静态目录 ✓" "认出了 static/ 树"
assert_not_contains "${OUT}" "FAIL vanblog-full" "全好的时候没有单个归档被标 FAIL（汇总行的 FAIL 0 不算）"

# sidecar 不当成归档：.manifest.json / .sha256 都不进校验列表
assert_contains "${OUT}" "全部归档（3 个）" "sidecar（.manifest.json）没有被当成归档"

# ---------- 2) 截断的归档必须 FAIL ----------
GOOD="${BK}/vanblog-full-20260915-010101.tar.zst"
SZ="$(wc -c <"${GOOD}")"
head -c $((SZ / 2)) "${GOOD}" >"${BK}/vanblog-full-20260915-999999.tar.zst"
OUT="$(verify "${BK}/vanblog-full-20260915-999999.tar.zst" 2>&1)"
RC=$?
assert_eq "${RC}" "1" "截断的归档 verify 返回非 0"
assert_contains "${OUT}" "FAIL" "截断的归档标成 FAIL"
assert_contains "${OUT}" "完整性校验失败" "失败原因指向完整性（截断/损坏）"
rm -f "${BK}/vanblog-full-20260915-999999.tar.zst"

# ---------- 3) sha256 sidecar：写入、比对、篡改 ----------
OUT="$(write_sha256_sidecar "${GOOD}" 2>&1)"
assert_contains "${OUT}" "已写入" "write_sha256_sidecar 报告写入"
if [[ -f "${GOOD}.sha256" ]]; then
  pass "生成了 <归档>.sha256 sidecar"
else
  fail "没有生成 .sha256 sidecar"
fi
# sidecar 格式与 sha256sum -c 兼容（在归档目录里跑）
if (cd "${BK}" && sha256sum -c "$(basename "${GOOD}").sha256" >/dev/null 2>&1); then
  pass "sidecar 格式与 sha256sum -c 兼容（记录的是 basename，归档可以整个目录搬走）"
else
  fail "sidecar 过不了 sha256sum -c"
fi
OUT="$(verify "${GOOD}.sha256" 2>&1)" # 拿 sidecar 本身当参数 → 认不出格式
assert_eq "$?" "1" "把 .sha256 当归档校验会失败（它不是归档）"
OUT="$(verify "${GOOD}" 2>&1)"
assert_eq "$?" "0" "有正确 sidecar 时 verify 通过"
assert_contains "${OUT}" "sha256 ✓" "sha256 比对通过时有明确标记"
# 篡改归档一个字节（不动 sidecar）→ sha256 必须抓住
cp "${GOOD}" "${GOOD}.bak"
printf '\xff' | dd of="${GOOD}" bs=1 seek=10 conv=notrunc status=none
OUT="$(verify "${GOOD}" 2>&1)"
RC=$?
mv -f "${GOOD}.bak" "${GOOD}"
assert_eq "${RC}" "1" "内容被改（sha256 不匹配）时 verify 失败"
assert_contains "${OUT}" "sha256 不匹配" "失败原因写明 sha256 不匹配"
# 错误的 sidecar 也一样
echo "0000000000000000000000000000000000000000000000000000000000000000  x" >"${GOOD}.sha256"
OUT="$(verify "${GOOD}" 2>&1)"
assert_eq "$?" "1" "sidecar 记录错误时 verify 失败"
rm -f "${GOOD}.sha256"
# 没有 sidecar 的归档（server 导出/旧归档）照常校验，只是明说跳过 —— 恢复不受影响
OUT="$(verify "${GOOD}" 2>&1)"
assert_eq "$?" "0" "没有 sidecar 的归档不因缺 sha256 而失败"
assert_contains "${OUT}" "无 sha256 记录" "没有 sidecar 时明说跳过比对（不假装比过）"

# ---------- 4) 内容缺失：缺 NDJSON / 缺 manifest / 缺 static ----------
make_full_archive "${TEST_DIR}/no-db.tar.zst" no-db
OUT="$(verify "${TEST_DIR}/no-db.tar.zst" 2>&1)"
assert_eq "$?" "1" "一个 NDJSON 都没有的归档 FAIL"
assert_contains "${OUT}" "ndjson 都没有" "指出了缺 NDJSON"
make_full_archive "${TEST_DIR}/no-manifest.tar.zst" no-manifest
OUT="$(verify "${TEST_DIR}/no-manifest.tar.zst" 2>&1)"
assert_eq "$?" "1" "缺 manifest.json 的归档 FAIL"
assert_contains "${OUT}" "缺 manifest.json" "指出了缺 manifest"
make_full_archive "${TEST_DIR}/no-static.tar.zst" no-static
OUT="$(verify "${TEST_DIR}/no-static.tar.zst" 2>&1)"
assert_eq "$?" "0" "缺 static/ 树不算失败（img/file/customPage 是存在才打包，空站正常）"
assert_contains "${OUT}" "空站点属正常" "缺 static 时给出的是解释而不是 FAIL"

# ---------- 5) 离线归档（vanblog-backup-*.tar.gz）与陌生文件名 ----------
(cd "${BASE}" && tar czf "${TEST_DIR}/vanblog-backup-20260915-010101.tar.gz" ./data) >/dev/null 2>&1
OUT="$(verify "${TEST_DIR}/vanblog-backup-20260915-010101.tar.gz" 2>&1)"
assert_eq "$?" "0" "含 ./data 树的离线归档通过"
assert_contains "${OUT}" "数据目录树 ✓" "离线归档按 ./data 树核对"
mkdir -p "${TEST_DIR}/empty-d"
(cd "${TEST_DIR}/empty-d" && tar czf "${TEST_DIR}/vanblog-backup-20260915-020202.tar.gz" .) >/dev/null 2>&1
OUT="$(verify "${TEST_DIR}/vanblog-backup-20260915-020202.tar.gz" 2>&1)"
assert_eq "$?" "1" "没有 ./data 树的离线归档 FAIL"
mkdir -p "${TEST_DIR}/misc"
echo hi >"${TEST_DIR}/misc/f.txt"
(cd "${TEST_DIR}/misc" && tar czf "${TEST_DIR}/random-stuff.tar.gz" .) >/dev/null 2>&1
OUT="$(verify "${TEST_DIR}/random-stuff.tar.gz" 2>&1)"
assert_eq "$?" "0" "陌生文件名只验完整性与 tar 结构，不套 vanblog 的预期成员"
assert_contains "${OUT}" "非 vanblog 备份文件名" "陌生文件名时明说只做通用校验"

# ---------- 6) 按名字（不是路径）校验、找不到、空目录 ----------
OUT="$(verify vanblog-full-20260915-020202.tar.gz 2>&1)"
assert_eq "$?" "0" "按归档名校验（自动在备份目录里找）"
OUT="$(verify nope-does-not-exist.tar.zst 2>&1)"
assert_eq "$?" "1" "找不到的归档返回非 0"
assert_contains "${OUT}" "本地找不到" "找不到时说清楚两种可能（路径/备份目录）"
EMPTY="${TEST_DIR}/emptybk"
mkdir -p "${EMPTY}"
OUT="$(VANBLOG_BACKUP_DIR="${EMPTY}" verify 2>&1)"
assert_eq "$?" "0" "空备份目录（没有归档）返回 0 并给提示"
assert_contains "${OUT}" "没有可校验的" "空目录时明确说没有可校验的归档"
OUT="$(VANBLOG_BACKUP_DIR="${TEST_DIR}/no-such-dir" verify 2>&1)"
assert_eq "$?" "1" "备份目录不存在返回非 0"

# ---------- 7) 部分失败 → 汇总 FAIL 计数与非 0 退出码 ----------
make_full_archive "${BK}/vanblog-full-20260915-040404.tar.zst"
head -c 20 "${BK}/vanblog-full-20260915-040404.tar.zst" >"${BK}/vanblog-full-20260915-050505.tar.zst"
OUT="$(verify 2>&1)"
RC=$?
assert_eq "${RC}" "1" "有任一归档失败时整体退出码非 0"
assert_contains "${OUT}" "FAIL 1" "汇总里 FAIL 计数正确"
assert_contains "${OUT}" "别拿来恢复" "失败时给出可操作的建议"
rm -f "${BK}/vanblog-full-20260915-040404.tar.zst" "${BK}/vanblog-full-20260915-050505.tar.zst"

# ---------- 8) prune / 列表把 .sha256 sidecar 排除掉 ----------
write_sha256_sidecar "${BK}/vanblog-full-20260915-010101.tar.zst" >/dev/null 2>&1
write_sha256_sidecar "${BK}/vanblog-full-20260915-020202.tar.gz" >/dev/null 2>&1
write_sha256_sidecar "${BK}/vanblog-full-20260915-030303.tar.xz" >/dev/null 2>&1
touch -d "2026-09-13" "${BK}/vanblog-full-20260915-010101.tar.zst"*
touch -d "2026-09-14" "${BK}/vanblog-full-20260915-020202.tar.gz"*
touch -d "2026-09-15" "${BK}/vanblog-full-20260915-030303.tar.xz"*
OUT="$(prune_old_backups full 2 2>&1)"
assert_contains "${OUT}" "删掉 1 份" "prune 计数不含 .sha256 sidecar（3 个归档留 2 删 1，而不是把 6 个文件当 6 份归档）"
if [[ -f "${BK}/vanblog-full-20260915-010101.tar.zst.sha256" ]]; then
  fail "被删归档的 .sha256 应该一起删（成了孤儿）"
else
  pass "prune 连带删掉了被删归档的 .sha256"
fi
if [[ -f "${BK}/vanblog-full-20260915-030303.tar.xz.sha256" && -f "${BK}/vanblog-full-20260915-030303.tar.xz" ]]; then
  pass "保留的归档，.sha256 也保留"
else
  fail "保留的归档，.sha256 也保留"
fi
# pick_full_backup 的列表里不许出现 sidecar
LISTING="$(echo "" | pick_full_backup 2>&1 >/dev/null)"
assert_not_contains "${LISTING}" ".sha256" "pick_full_backup 列表不显示 .sha256 sidecar"
assert_not_contains "${LISTING}" ".manifest.json" "pick_full_backup 列表不显示 .manifest.json"

# ---------- 9) backup 成功后写 sidecar（offline 真跑；full 用 curl 桩）----------
OUT="$(VANBLOG_ASSUME_YES=1 backup 0 --offline 2>&1)"
assert_eq "$?" "0" "offline 备份成功"
OFF="$(ls -1t "${BASE}"/vanblog-backup-*.tar.gz 2>/dev/null | head -1)"
if [[ -n "${OFF}" && -f "${OFF}.sha256" ]]; then
  pass "offline 备份写了 <归档>.sha256"
  if (cd "${BASE}" && sha256sum -c "$(basename "${OFF}").sha256" >/dev/null 2>&1); then
    pass "offline 的 .sha256 内容正确"
  else
    fail "offline 的 .sha256 内容不对"
  fi
else
  fail "offline 备份没有写 .sha256 sidecar"
fi
# full：mock curl（探活 → 200；export → 成功 JSON），归档文件先摆好（server 写的）
curl() {
  local args="$*"
  case "${args}" in
  *"/api/public/meta"*) printf '200' ;;
  *"full/export"*)
    printf '%s' '{"statusCode":200,"message":"success","data":{"name":"vanblog-full-20260916-010101.tar.zst","format":"zstd","size":"9.99 MB","seconds":1,"collections":2,"documents":3,"files":1}}'
    ;;
  *) return 1 ;;
  esac
}
make_full_archive "${BK}/vanblog-full-20260916-010101.tar.zst"
OUT="$(VANBLOG_ADMIN_TOKEN=tok backup 0 2>&1)"
RC=$?
assert_eq "${RC}" "0" "full 备份（mock server）成功"
assert_contains "${OUT}" "空间预检" "full 备份前跑了磁盘空间预检"
if [[ -f "${BK}/vanblog-full-20260916-010101.tar.zst.sha256" ]]; then
  pass "backup_full 给新归档写了 .sha256 sidecar"
else
  fail "backup_full 没有写 .sha256 sidecar"
fi
OUT2="$(verify vanblog-full-20260916-010101.tar.zst 2>&1)"
assert_contains "${OUT2}" "sha256 ✓" "backup 写出的 sidecar 能被 verify 用回（闭环）"
unset -f curl

# ---------- 10) 空间预检的三条路：通过 / 中止 / 偏紧 ----------
# 用 df 桩精确控制"剩余空间"（真实 df 的数值没法摆布）；桩读 STUB_FREE_KB（单位 KB）
# ⚠️ 估算基准归档必须 >1KB：df/估算都按 KB 取整，几百字节的 fixture 一除就成了 0
#    （第一版就在这里全军覆没：free_b=0 → 全走"中止"分支）。用 512KB 随机数据垫大
#    （随机数据压不动，归档大小可预期）。
BIG="${TEST_DIR}/bigstage"
mkdir -p "${BIG}/db/vanBlog" "${BIG}/static/img"
echo '{"kind":"vanblog-full-backup","version":1}' >"${BIG}/manifest.json"
echo '{"a":1}' >"${BIG}/db/vanBlog/c.ndjson"
head -c 524288 /dev/urandom >"${BIG}/static/img/big.bin"
(cd "${BIG}" && tar -cf - .) | zstd -q -o "${BK}/vanblog-full-20260916-020202.tar.zst"
EST="$(wc -c <"${BK}/vanblog-full-20260916-020202.tar.zst")" # 最新归档 → 估算依据
df() {
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n'
  printf 'stub 999999999 1 %s 1%% /stub\n' "${STUB_FREE_KB:-100000000}"
}
FREE_KB=$(( (EST + 100 * 1024 * 1024) / 1024 )) # 比估算富余 100MB
STUB_FREE_KB="${FREE_KB}"
OUT="$(VANBLOG_BACKUP_SPACE_MARGIN_MB=1 check_backup_space full "${BK}" 2>&1)"
assert_eq "$?" "0" "剩余空间充足（margin=1MB）时预检通过"
assert_contains "${OUT}" "空间预检通过" "通过时打印空间预检通过"
assert_contains "${OUT}" "上一个归档" "估算依据是上一个归档的大小（最有依据的启发式）"
STUB_FREE_KB=$(( (EST / 2) / 1024 )) # 只剩估算的一半
OUT="$(VANBLOG_BACKUP_SPACE_MARGIN_MB=1 check_backup_space full "${BK}" 2>&1)"
assert_eq "$?" "1" "剩余低于估算+margin 时预检中止（非 0）"
assert_contains "${OUT}" "空间预检不通过" "中止时明说不通过"
assert_contains "${OUT}" "已中止备份" "中止时明说备份没有发起"
assert_contains "${OUT}" "VANBLOG_BACKUP_SPACE_MARGIN_MB" "中止消息里写了怎么调余量"
STUB_FREE_KB=$(( (EST * 3 / 2) / 1024 )) # margin=0 时：估算 ≤ free < 估算×2 → 偏紧带
OUT="$(VANBLOG_BACKUP_SPACE_MARGIN_MB=0 check_backup_space full "${BK}" 2>&1)"
assert_eq "$?" "0" "只是偏紧时继续（返回 0）"
assert_contains "${OUT}" "偏紧" "偏紧时打印警告"
# ⚠️ 偏紧带用 margin=0 才测得到：fixture 归档只有几百字节，margin 若给 1MB，
#    need=估算+1MB 会直接盖过 1.5×估算，落进"中止"而不是"偏紧"（第一版就栽在这）
# margin 覆盖生效：同样的空间，margin 调大就该中止
STUB_FREE_KB=$(( (EST + 50 * 1024 * 1024) / 1024 ))
OUT="$(VANBLOG_BACKUP_SPACE_MARGIN_MB=100 check_backup_space full "${BK}" 2>&1)"
assert_eq "$?" "1" "VANBLOG_BACKUP_SPACE_MARGIN_MB 调大后同样的空间会中止"
OUT="$(VANBLOG_BACKUP_SPACE_MARGIN_MB=1 check_backup_space full "${BK}" 2>&1)"
assert_eq "$?" "0" "margin 调回小值又通过（环境变量确实生效）"
# skip 开关
STUB_FREE_KB=1
OUT="$(VANBLOG_BACKUP_SKIP_SPACE_CHECK=1 check_backup_space full "${BK}" 2>&1)"
assert_eq "$?" "0" "VANBLOG_BACKUP_SKIP_SPACE_CHECK=1 时不拦"
assert_contains "${OUT}" "跳过" "skip 时明说跳过了"

# ---------- 11) 诚实性：算不出估算/df 失败时明说并放行 ----------
STUB_FREE_KB=100000000
du() { return 1; } # 估算不了（离线：数据目录 du 失败）
OUT="$(check_backup_space offline "${BASE}" 2>&1)"
assert_eq "$?" "0" "估算不出来时放行（不因为检查不了就拦住备份）"
assert_contains "${OUT}" "算不出估算值" "估算不出来时明说，不假装检查过"
unset -f du
df() { return 1; } # df 失败
OUT="$(check_backup_space full "${BK}" 2>&1)"
assert_eq "$?" "0" "df 读不出剩余空间时放行"
assert_contains "${OUT}" "df 读不出" "df 失败时明说原因"
unset -f df

# ---------- 12) 源码级不变式 ----------
SRC="$(cat "${SCRIPT}")"
assert_contains "${SRC}" "archive_integrity_test" "verify 有独立的完整性测试函数"
assert_contains "${SRC}" "zstd -t -q --long=27" "zstd 完整性用 -t（流式，不解压落盘）且对齐 server 的 --long=27"
assert_contains "${SRC}" "xz -t" "xz 完整性用 -t"
assert_contains "${SRC}" "gzip -t" "gzip 完整性用 -t"
assert_contains "${SRC}" "is_gnu_tar" "成员列表用 is_gnu_tar 处理 tar 旗标差异"
assert_contains "${SRC}" '"verify")' "dispatcher 接了 verify 子命令"

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
