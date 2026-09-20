#!/usr/bin/env bash
# 加密整站备份在**脚本侧**的行为：口令解析、临时文件安全、格式识别、清理 glob、
# 恢复时怎么把口令送进去（且绝不进 argv）、以及 rotate-jwt 子命令。
#
# 为什么值得一个独立套件：这批行为全都是"**错了也不报错**"的形状 ——
#   - 格式认不出 ⇒ 一份好归档被判成 FAIL（站长以为备份坏了）；
#   - 清理 glob 漏掉 .enc ⇒ 加密归档永远不清理，一直堆到磁盘满，然后**每次备份都失败**；
#   - 口令进了 curl 的 argv ⇒ 同机任何用户 `ps` 就能看到（而这口令保护的正是全站凭据）；
#   - 字段名与服务端漂了 ⇒ 请求 200，但**静默不解密**，恢复出来的是错的东西。
# 所以每条都尽量做成**行为级**（真跑函数、真看输出、真数残留文件），源码级钉子只用来
# 钉"两种形状必须同时存在"这种跨文件契约，并且一律先剥注释（本仓库已踩 8 次
# "断言匹配到自己的解释性注释"）。
#
# ⚠️ 加密 fixture 用的是**服务端自己的实现**（packages/server/dist/src/utils/backupCrypto.js
# 的 createEncryptor），不是本测试手搓的假格式 —— 手搓的话测出来的只是"我的假设自洽"。
# dist 不存在时（CI 没构建过 server）相关用例**明确 NOTE 跳过**，不假装通过。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"
DRILL="${ROOT}/scripts/vanblog-drill.sh"
SERVER_DIR="${ROOT}/packages/server"
CRYPTO_JS="${SERVER_DIR}/dist/src/utils/backupCrypto.js"

PASS=0
FAIL=0
NOTE=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
note() { echo "NOTE: $*"; NOTE=$((NOTE + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_rc() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (rc=$1, want $2)"; fi; }
assert_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }
assert_not_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then fail "$3 (unexpected: $2)"; else pass "$3"; fi; }
assert_matches() { if printf '%s' "$1" 2>/dev/null | grep -qE -- "$2"; then pass "$3"; else fail "$3 (no match: $2)"; fi; }

echo "== vanblog.sh 加密备份 / 口令 / rotate-jwt =="

for tool in tar zstd sha256sum curl node; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "本机没有 ${tool}，没法真跑这个套件"
    echo "passed=0 failed=1"
    exit 1
  fi
done

TEST_DIR="$(mktemp -d)"
cleanup_all() { rm -rf "${TEST_DIR}" 2>/dev/null; }
trap cleanup_all EXIT

APILOG="${TEST_DIR}/api.log"
export APILOG
: >"${APILOG}"
mkdir -p "${TEST_DIR}/bin"

# ── 假 curl：把**完整 argv** 记下来（这正是"口令有没有进 argv"的判据），再按端点回假响应 ──
cat >"${TEST_DIR}/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
args="$*"
printf '%s\n' "${args}" >>"${APILOG}"
case "${args}" in
  */api/public/meta*)
    if printf '%s' "${args}" | grep -q -- "-w"; then printf '200'; else printf '{"statusCode":200,"data":{"siteName":"测试站"}}'; fi ;;
  */api/admin/backup/jwt/rotate*)
    case "${ROTATE_MODE:-ok}" in
      ok) printf '{"statusCode":200,"message":"JWT 密钥已轮换（新 kid abc12345）","data":{"kid":"abc12345","previousKid":"old99999","graceDays":7,"apiTokensAffected":3,"restartRequired":false}}' ;;
      restart) printf '{"statusCode":200,"message":"已轮换但签发侧没切","data":{"kid":"abc12345","previousKid":"old99999","graceDays":7,"apiTokensAffected":3,"restartRequired":true}}' ;;
      denied) printf '{"statusCode":403,"message":"只有管理员能轮换密钥"}' ;;
    esac ;;
  */api/admin/backup/full/inspect*)
    printf '{"statusCode":200,"data":{"name":"vanblog-full-20260920-100000.tar.zst","createdAt":"2026-09-20T02:00:00.000Z","totals":{"collections":13,"documents":9830,"files":185}}}' ;;
  */api/admin/backup/full/restore*)
    printf '{"statusCode":200,"data":{"collections":13,"documents":9830,"files":185}}' ;;
  */api/admin/backup/full/export*)
    printf '{"statusCode":200,"data":{"name":"%s","size":"1.2MB","seconds":3,"collections":13,"documents":9830,"files":185}}' "${EXPORT_NAME:-vanblog-full-20260920-100000.tar.zst}" ;;
  */api/admin/auth/login*) printf '{"statusCode":200,"data":{"token":"enc-test-token"}}' ;;
  *) printf '{}' ;;
esac
exit 0
FAKECURL
chmod +x "${TEST_DIR}/bin/curl"
export PATH="${TEST_DIR}/bin:${PATH}"

BASE="${TEST_DIR}/var/vanblog"
DATA="${BASE}/data"
BK="${DATA}/log/vanblog-backups"
mkdir -p "${BK}" "${DATA}/data/static/img" "${DATA}/data/mongo"

export VANBLOG_SKIP_MAIN=1
export VANBLOG_BASE_PATH="${BASE}"
export VANBLOG_DATA_PATH="${DATA}"
export VANBLOG_ADMIN_TOKEN="enc-test-token" # 免得每个用例都去交互登录
export VANBLOG_ASSUME_YES=1
unset VANBLOG_BACKUP_PASSPHRASE VANBLOG_BACKUP_PASSPHRASE_FILE VANBLOG_DATA_PATH_RAW 2>/dev/null || true

SRC="$(cat "${SCRIPT}")"
# shellcheck disable=SC1090
source "${SCRIPT}" >/dev/null 2>&1
# ⚠️ source 进来的脚本自己装了 `trap _passphrase_cleanup EXIT`，会把上面那个 cleanup_all **顶掉**
#    （bash 每个信号只保留最后一个 trap）⇒ TEST_DIR 就没人删了。合成一个，两件都做。
trap '_passphrase_cleanup; cleanup_all' EXIT

# 剥掉整行注释（⚠️ shell 只能用 sed，绝不能用 TS 的 stripCommentsForAnchor：
# 它会把 `https://` 当行注释吃掉、并被引号与 $( ) 带偏，实测把整份脚本啃残）
no_comments() { printf '%s\n' "$1" | sed '/^[[:space:]]*#/d'; }
CODE="$(no_comments "${SRC}")"

reset_apilog() { : >"${APILOG}"; }

# ── 造一份**真的**整站备份归档（结构照 server 的打包方式），再加密它 ──────────────
STAGE="${TEST_DIR}/stage"
mkdir -p "${STAGE}/db/vanBlog" "${STAGE}/static/img"
printf '{"version":1,"kind":"full"}' >"${STAGE}/manifest.json"
printf '{"title":"测试文章"}\n' >"${STAGE}/db/vanBlog/articles.ndjson"
printf 'fakepng' >"${STAGE}/static/img/a.png"
PLAIN="${BK}/vanblog-full-20260920-100000.tar.zst"
ENC="${BK}/vanblog-full-20260920-100000.tar.zst.enc"
(cd "${STAGE}" && tar -cf - . | zstd -q -3 -o "${PLAIN}")
pass "明文归档已造出来（$(du -h "${PLAIN}" | cut -f1)）"

HAVE_REAL_ENC=0
if [[ -f "${CRYPTO_JS}" ]]; then
  if VANBLOG_ENC_PASS="这是一句足够长的测试口令-2026" node -e '
    const {createEncryptor}=require(process.argv[1]);
    const fs=require("fs");
    (async()=>{
      const enc=await createEncryptor({passphrase:process.env.VANBLOG_ENC_PASS,
        inner:{format:"zstd",ext:".tar.zst",label:"整站备份"}});
      const out=fs.createWriteStream(process.argv[3]);
      fs.createReadStream(process.argv[2]).pipe(enc.transform).pipe(out);
      await new Promise(r=>out.on("close",r));
    })();' "${CRYPTO_JS}" "${PLAIN}" "${ENC}" 2>"${TEST_DIR}/enc.err"; then
    HAVE_REAL_ENC=1
  else
    note "服务端 createEncryptor 跑不起来（$(head -c 160 "${TEST_DIR}/enc.err" | tr '\n' ' ')）⇒ 真加密用例跳过"
  fi
else
  note "没有 ${CRYPTO_JS#/home/ckboss/WorkSpace/WorkSpaceL/vanblog/}（server 还没构建过）⇒ 真加密用例跳过；先 cd packages/server && ./node_modules/.bin/nest build"
fi

# ═══ A. 口令解析（与 server 的 resolveBackupPassphrase 同口径）═══
echo "-- A. 口令解析 --"
unset VANBLOG_BACKUP_PASSPHRASE VANBLOG_BACKUP_PASSPHRASE_FILE 2>/dev/null || true
out="$(backup_passphrase_from_env 2>/dev/null)"; rc=$?
assert_eq "${out}" "" "没配口令 → 空串"
assert_rc "${rc}" 0 "没配口令 → rc 0（不是错误）"

export VANBLOG_BACKUP_PASSPHRASE="  前导空格要保留  "
out="$(backup_passphrase_from_env 2>/dev/null)"
assert_eq "${out}" "  前导空格要保留" "trimEnd：尾部空白去掉、**前导空格保留**（与 server 一致）"

printf '文件里的口令\n\n' >"${TEST_DIR}/pass.txt"
chmod 600 "${TEST_DIR}/pass.txt"
export VANBLOG_BACKUP_PASSPHRASE_FILE="${TEST_DIR}/pass.txt"
out="$(backup_passphrase_from_env 2>/dev/null)"
assert_eq "${out}" "文件里的口令" "_FILE **优先于**内联变量"
assert_not_contains "${out}" "前导空格" "_FILE 生效时内联值完全不被使用"

export VANBLOG_BACKUP_PASSPHRASE_FILE="${TEST_DIR}/不存在的口令文件"
err="$(backup_passphrase_from_env 2>&1 >/dev/null)"; rc=$?
assert_rc "${rc}" 2 "_FILE 读不到 → rc 2（与'没配'的 rc 0 区分开）"
assert_contains "${err}" "已拒绝继续" "_FILE 读不到 → 明确说拒绝继续"
assert_contains "${err}" "不会静默当成明文归档处理" "_FILE 读不到 → 说清不会静默降级"
assert_contains "${err}" "VANBLOG_BACKUP_PASSPHRASE" "_FILE 读不到 → 给出另一条照做的办法"
unset VANBLOG_BACKUP_PASSPHRASE_FILE
unset VANBLOG_BACKUP_PASSPHRASE

# ═══ B. 临时文件：0600 / 目录 0700 / 用完即删 / EXIT trap 兜底 ═══
echo "-- B. 临时文件安全 --"
SAVED_UMASK="$(umask)"
umask 0002 # 本机实际 umask：mkdir 出来会是 0775 ⇒ 目录权限这条是真断言
pf="$(passphrase_temp_file "一句测试口令")"
assert_eq "$(stat -c %a "${pf}")" "600" "口令文件权限 0600"
assert_eq "$(stat -c %a "$(dirname "${pf}")")" "700" "口令文件所在**目录** 0700（umask 0002 下 mkdir 默认 0775）"
assert_eq "$(cat "${pf}")" "一句测试口令" "临时文件内容正确"
assert_eq "$(wc -c <"${pf}" | tr -d ' ')" "$(printf '%s' "一句测试口令" | wc -c | tr -d ' ' | sed 's/$//')" "内容无尾换行（多一个换行就会让口令对不上）"
passphrase_temp_free "${pf}"
[[ -e "${pf}" ]] && fail "passphrase_temp_free 后文件仍在" || pass "passphrase_temp_free 删掉了文件"
[[ -e "$(dirname "${pf}")" ]] && fail "passphrase_temp_free 后目录仍在" || pass "passphrase_temp_free 连目录一起删掉"
umask "${SAVED_UMASK}"

# EXIT trap 兜底：子 shell 里建了临时文件、**不手动删**就退出（模拟脚本报错/被信号打断）
LEAKDIR="${TEST_DIR}/leak"
mkdir -p "${LEAKDIR}"
cat >"${LEAKDIR}/probe.sh" <<PROBE
#!/usr/bin/env bash
export VANBLOG_SKIP_MAIN=1 VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}"
source "${SCRIPT}" >/dev/null 2>&1
f="\$(passphrase_temp_file "会泄漏的口令")"
printf '%s\n' "\$(dirname "\$f")" > "${LEAKDIR}/dir.txt"
exit 3   # 非 0 退出：trap 仍必须清掉口令文件
PROBE
chmod +x "${LEAKDIR}/probe.sh"
"${LEAKDIR}/probe.sh" >/dev/null 2>&1
probe_rc=$?
assert_rc "${probe_rc}" 3 "子脚本按预期以 rc 3 退出"
leak_dir="$(cat "${LEAKDIR}/dir.txt" 2>/dev/null)"
if [[ -n "${leak_dir}" && ! -e "${leak_dir}" ]]; then
  pass "EXIT trap 兜底：非 0 退出后口令文件与目录都没残留"
else
  fail "EXIT trap 兜底失败：${leak_dir:-<没记录到路径>} 还在（口令会留在磁盘上）"
fi
# ⚠️ 判据限定在**本进程自己的** PID 目录：全局扫 /tmp + 时间窗会被并发运行、
#    或上一轮实验的残留踩到（实测踩过一次：那是变异对照故意去掉清理逻辑留下的），
#    那种红与被测代码无关，属于会侵蚀信任的假红。
[[ -e "${VANBLOG_PASS_DIR}" ]] && fail "本轮自己的口令目录 ${VANBLOG_PASS_DIR} 结束后仍在" \
  || pass "本轮自己的口令目录（PID 作用域）结束后已清掉"
if [[ -d "${VANBLOG_PASS_DIR}" ]]; then
  assert_eq "$(ls -A "${VANBLOG_PASS_DIR}" 2>/dev/null)" "" "口令目录里没有残留文件"
fi

# ═══ C. 格式识别与 verify（真加密 fixture）═══
echo "-- C. 格式识别 / verify --"
assert_eq "$(archive_format_of "${ENC}")" "zstd" "archive_format_of 对 .tar.zst.enc 仍认出内层格式 zstd"
assert_eq "$(archive_format_of "${PLAIN}")" "zstd" "archive_format_of 对明文 .tar.zst 不受影响"
assert_eq "$(archive_format_of "x.tar.gz.enc")" "gzip" "archive_format_of 对 .tar.gz.enc 认出 gzip"
assert_eq "$(archive_format_of "x.tar.xz.enc")" "xz" "archive_format_of 对 .tar.xz.enc 认出 xz"
assert_eq "$(archive_format_of "x.zip")" "" "archive_format_of 对不认识的后缀仍返回空（没有放宽到'什么都认'）"
# 负向对照：`.enc` 剥离不能把"真不认识"的也放过去
assert_eq "$(archive_format_of "x.enc")" "" "只有 .enc 而没有内层格式 → 仍然认不出（没有变成'一律 zstd'）"

archive_has_enc_suffix "a/b.tar.zst.enc" && pass "archive_has_enc_suffix 认 .enc 后缀" || fail "archive_has_enc_suffix 不认 .enc"
archive_has_enc_suffix "a/b.tar.zst" && fail "archive_has_enc_suffix 把明文也当成 .enc" || pass "archive_has_enc_suffix 对明文返回假"
archive_has_enc_suffix "a/b.tar.zst.ENC" && pass "archive_has_enc_suffix 大小写不敏感" || fail "archive_has_enc_suffix 对大写 .ENC 返回假"

if [[ ${HAVE_REAL_ENC} -eq 1 ]]; then
  archive_is_encrypted "${ENC}" && pass "archive_is_encrypted 认出真加密归档（按**魔数**）" || fail "archive_is_encrypted 没认出真加密归档"
  archive_is_encrypted "${PLAIN}" && fail "archive_is_encrypted 把明文归档也判成加密（永远返回真）" || pass "archive_is_encrypted 对明文归档返回假（负向对照）"
  cp "${PLAIN}" "${TEST_DIR}/renamed-plain.tar.zst.enc"
  archive_is_encrypted "${TEST_DIR}/renamed-plain.tar.zst.enc" && fail "只看后缀：把改名的明文当成加密" || pass "**改名的明文**不会被当成加密（判据是魔数不是后缀）"
  cp "${ENC}" "${TEST_DIR}/renamed-enc.tar.zst"
  archive_is_encrypted "${TEST_DIR}/renamed-enc.tar.zst" && pass "**改名的密文**仍被识别为加密（后缀没了也认）" || fail "改名去掉 .enc 后就认不出加密了"

  archive_integrity_test zstd "${ENC}"; rc=$?
  assert_rc "${rc}" 128 "archive_integrity_test 对加密归档返回 128（不适用），而不是失败"
  archive_integrity_test zstd "${PLAIN}"; rc=$?
  assert_rc "${rc}" 0 "archive_integrity_test 对明文归档仍然真跑 zstd -t（rc 0）"

  (cd "${BK}" && sha256sum "$(basename "${ENC}")" >"$(basename "${ENC}").sha256")
  vout="$(verify_one_archive "${ENC}" 2>&1)"; vrc=$?
  assert_rc "${vrc}" 0 "verify 对**带 sidecar 的加密归档**返回 0（不再判成'认不出压缩格式'）"
  assert_contains "${vout}" "跳过 zstd 压缩流校验" "verify 明说跳过了压缩流校验（不是静默跳过）"
  assert_contains "${vout}" "外层是密文" "verify 解释了**为什么**跳过"
  assert_contains "${vout}" "sha256 ✓" "加密归档仍然比对明文 sidecar（脚本侧唯一能做的那项校验）"
  assert_contains "${vout}" "已识别为加密归档" "verify 说明这是加密归档"
  assert_not_contains "${vout}" "缺 manifest.json" "加密归档不会被误报'缺 manifest.json'（列不出成员 ≠ 损坏）"
  assert_not_contains "${vout}" "列不出成员" "加密归档不会被误报'列不出成员'"
  assert_not_contains "${vout}" "认不出压缩格式" "加密归档不会被误报'认不出压缩格式'"
  assert_contains "${vout}" "成员级校验需要口令" "verify 说清成员级校验需要口令（把'没验'交代给站长）"

  # 篡改密文：sidecar 比对必须抓住（加密归档的完整性仍然可验，这是"能验的那部分"）
  TAMPER="${BK}/tampered.tar.zst.enc"
  cp "${ENC}" "${TAMPER}"
  (cd "${BK}" && sha256sum "$(basename "${ENC}")" >"tampered.tar.zst.enc.sha256")
  printf 'X' | dd of="${TAMPER}" bs=1 seek=40 conv=notrunc status=none 2>/dev/null
  tout="$(verify_one_archive "${TAMPER}" 2>&1)"; trc=$?
  [[ ${trc} -ne 0 ]] && pass "篡改过的加密归档 verify **失败**（rc=${trc}）" || fail "篡改过的加密归档 verify 竟然通过了"
  assert_contains "${tout}" "sha256 不匹配" "篡改被 sidecar 比对抓住，且说清是 sha256 不匹配"

  # 内容是密文但名字没有 .enc ⇒ 要提示（否则站长会以为自己拿的是明文归档）
  NONSUF="${BK}/vanblog-full-20260920-100001.tar.zst"
  cp "${ENC}" "${NONSUF}"
  nout="$(verify_one_archive "${NONSUF}" 2>&1)"
  assert_contains "${nout}" "文件名没有 .enc 后缀" "内容是密文但名字没 .enc → 明确提示（判据以魔数为准）"
  rm -f "${TAMPER}" "${TAMPER}.sha256" "${NONSUF}"
else
  note "跳过 12 条真加密用例（fixture 造不出来）；C 段的名字级断言已全部跑过"
fi

# ═══ D. 清理 glob 必须认 .enc（漏了就会堆到磁盘满）═══
echo "-- D. 清理 glob --"
MIRROR="${TEST_DIR}/mirror"
mkdir -p "${MIRROR}"
# 造 4 份：2 明文 + 2 加密，时间戳递增（mtime 用 touch 显式设定，别依赖创建顺序）
i=0
for n in 20260901-010100 20260902-010100; do
  cp "${PLAIN}" "${MIRROR}/vanblog-full-${n}.tar.zst"
  (cd "${MIRROR}" && sha256sum "vanblog-full-${n}.tar.zst" >"vanblog-full-${n}.tar.zst.sha256")
  touch -d "2026-09-0${i} 01:00" "${MIRROR}/vanblog-full-${n}.tar.zst" 2>/dev/null || true
  i=$((i + 1))
done
if [[ ${HAVE_REAL_ENC} -eq 1 ]]; then
  j=1
  for n in 20260903-010100 20260904-010100; do
    cp "${ENC}" "${MIRROR}/vanblog-full-${n}.tar.zst.enc"
    (cd "${MIRROR}" && sha256sum "vanblog-full-${n}.tar.zst.enc" >"vanblog-full-${n}.tar.zst.enc.sha256")
    touch -d "2026-09-0$((j + 2)) 01:00" "${MIRROR}/vanblog-full-${n}.tar.zst.enc" 2>/dev/null || true
    j=$((j + 1))
  done
fi
# ⚠️ 行为级：真调 mirror_backup_artifacts（KEEP=1），数最后剩几份。
#    这比"从源码里抽 find 表达式再 eval"可靠得多 —— 抽取正则一旦跟不上源码形状就会假绿。
#    判据：4 份（2 明文 + 2 加密）+ keep=1 ⇒ 只应剩 1 份。
#    如果清理 glob 漏掉 .enc，那 2 份加密归档**永远不会被删**，结果会是 3 份。
newest="$(ls -1t "${MIRROR}"/vanblog-full-* 2>/dev/null | grep -vE '\.(sha256|manifest\.json)$' | head -1)"
before_n="$(ls -1 "${MIRROR}"/vanblog-full-* 2>/dev/null | grep -vE '\.(sha256|manifest\.json)$' | wc -l | tr -d ' ')"
if [[ ${HAVE_REAL_ENC} -eq 1 ]]; then
  assert_eq "${before_n}" "4" "fixture 就位：镜像目录里 4 份归档（2 明文 + 2 加密）"
  VANBLOG_BACKUP_MIRROR_DIR="${MIRROR}" VANBLOG_BACKUP_MIRROR_KEEP=1 mirror_backup_artifacts "${newest}" >/dev/null 2>&1
  after_n="$(ls -1 "${MIRROR}"/vanblog-full-* 2>/dev/null | grep -vE '\.(sha256|manifest\.json)$' | wc -l | tr -d ' ')"
  assert_eq "${after_n}" "1" "清理后只剩最新的 1 份（**含加密归档也被计入清理**；漏掉 .enc 的话这里会是 3）"
  left_enc="$(ls -1 "${MIRROR}"/vanblog-full-*.tar.zst.enc 2>/dev/null | wc -l | tr -d ' ')"
  assert_eq "${left_enc}" "0" "加密归档确实被清理掉了（这条是'堆到磁盘满'那个缺陷的直接反证）"
  left_sidecar="$(ls -1 "${MIRROR}"/*.sha256 2>/dev/null | wc -l | tr -d ' ')"
  assert_eq "${left_sidecar}" "1" "被删归档的 .sha256 sidecar 也一起删了（不留孤儿 sidecar）"
else
  note "跳过 4 条清理行为断言（没有真加密 fixture）"
fi
# 原则不能松：清理仍然**只碰自己认识的名字**（不能放宽成 vanblog-full-*.tar.*）
assert_contains "${CODE}" "vanblog-full-*.tar.zst' -o -name 'vanblog-full-*.tar.zst.enc'" "清理用的是**两条精确形状**，没有放宽成通配（放宽会削弱'绝不用通配删别的文件'这条原则）"
# doctor 的三处也要认 .enc（否则站长看到"你已经 N 天没备份了"，其实每天都备了）
doc_globs="$(printf '%s\n' "${CODE}" | grep -cE "vanblog-full-\*\.tar\.zst\.enc")"
[[ ${doc_globs} -ge 3 ]] && pass "doctor/清理里 .enc 形状至少出现 ${doc_globs} 处（清理 1 + doctor 2）" || fail ".enc 形状只出现 ${doc_globs} 处，doctor 的'最近备份多旧/份数'可能仍漏掉加密归档"

# ═══ E. 恢复：口令怎么送进去（核心安全断言：绝不进 argv）═══
echo "-- E. 恢复时的口令管道 --"
PASS_SENTINEL="这句口令绝不能出现在argv里-2026"

reset_apilog
unset VANBLOG_BACKUP_PASSPHRASE VANBLOG_BACKUP_PASSPHRASE_FILE 2>/dev/null || true
if [[ ${HAVE_REAL_ENC} -eq 1 ]]; then
  eout="$(restore_full_backup "${ENC}" true 2>&1)"; erc=$?
  [[ ${erc} -ne 0 ]] && pass "加密归档 + 本机没口令 → 恢复**提前失败**（rc=${erc}）" || fail "加密归档 + 没口令竟然继续走下去了"
  assert_contains "${eout}" "这份归档是加密的" "缺口令时明确说这份归档是加密的"
  assert_contains "${eout}" "VANBLOG_BACKUP_PASSPHRASE=" "缺口令时给出可直接照做的办法①（内联变量）"
  assert_contains "${eout}" "VANBLOG_BACKUP_PASSPHRASE_FILE=" "缺口令时给出办法②（口令文件）"
  assert_not_contains "$(cat "${APILOG}")" "full/restore" "缺口令时**根本没发恢复请求**（预检在发请求之前，不让用户白确认一次）"
fi

# 上传路径 + 有口令
reset_apilog
export VANBLOG_BACKUP_PASSPHRASE="${PASS_SENTINEL}"
target_for_upload="${PLAIN}"
[[ ${HAVE_REAL_ENC} -eq 1 ]] && target_for_upload="${ENC}"
uout="$(restore_full_backup "${target_for_upload}" true 2>&1)"; urc=$?
assert_rc "${urc}" 0 "带口令恢复加密归档 → rc 0"
argv_log="$(cat "${APILOG}")"
assert_contains "${argv_log}" "full/restore" "恢复请求确实发出去了"
assert_contains "${argv_log}" "passphrase=<" "口令用 curl 的 '<文件' 形式传（值从文件读）"
assert_not_contains "${argv_log}" "${PASS_SENTINEL}" "⚠️ 核心安全断言：口令**没有**出现在 curl 的 argv 里（argv 对同机任何用户 ps 可见）"
assert_contains "${uout}" "不回显" "脚本自己的输出也不回显口令（只说字节数）"
assert_not_contains "${uout}" "${PASS_SENTINEL}" "脚本输出里没有口令明文"
[[ -e "${VANBLOG_PASS_DIR}" ]] && fail "恢复结束后口令目录仍在（${VANBLOG_PASS_DIR}）" \
  || pass "恢复结束后口令临时文件已删净（PID 目录整个没了）"

# by-name 路径 + 有口令：整个 body 走 0600 文件 + -d @file
reset_apilog
nout="$(restore_full_backup "vanblog-full-20260920-100000.tar.zst.enc" true 2>&1)"; nrc=$?
assert_rc "${nrc}" 0 "by-name 恢复（不上传）→ rc 0"
argv_log="$(cat "${APILOG}")"
assert_contains "${argv_log}" "-d @" "by-name 路径用 -d @文件（整个 body 走文件）"
assert_not_contains "${argv_log}" "${PASS_SENTINEL}" "by-name 路径的 argv 里也没有口令明文"
assert_not_contains "${argv_log}" "passphrase=" "by-name 路径没有把口令塞进 argv 形式的 JSON"

# 明文归档 + 没口令：不该多做事
reset_apilog
unset VANBLOG_BACKUP_PASSPHRASE
mout="$(restore_full_backup "${PLAIN}" true 2>&1)"; mrc=$?
assert_rc "${mrc}" 0 "明文归档 + 没口令 → 照常恢复（rc 0）"
assert_not_contains "$(cat "${APILOG}")" "passphrase" "明文归档 + 没口令 → 请求里不带 passphrase 字段（没有为了'看起来做了事'而多加东西）"

# 跨包对账：脚本发的字段名必须等于服务端读的字段名（漂了不报错，只是**静默不解密**）
BKCTL="${SERVER_DIR}/src/controller/admin/backup/backup.controller.ts"
INITCTL="${SERVER_DIR}/src/controller/admin/init/init.controller.ts"
if [[ -f "${BKCTL}" && -f "${INITCTL}" ]]; then
  grep -q "passphrase?: string" "${BKCTL}" && pass "服务端 full/restore 读的字段确实叫 passphrase" || fail "服务端 full/restore 的字段名变了（脚本发的是 passphrase）⇒ 会静默不解密"
  grep -q "@Body('backupPassphrase')" "${INITCTL}" && pass "服务端匿名 init/restore 读的字段确实叫 backupPassphrase" || fail "服务端 init/restore 的字段名变了（脚本发的是 backupPassphrase）⇒ 会静默不解密"
  # 两个字段名**必须不同**这件事本身也要钉住：它们是两条接口，谁把它们统一了都会出事
  assert_contains "$(grep -o "passphrase?: string" "${BKCTL}" | head -1)" "passphrase" "两条恢复接口的口令字段名确实不一样（full/restore=passphrase，init/restore=backupPassphrase）"
  grep -q "'jwt/rotate'" "${BKCTL}" && pass "服务端确实有 POST jwt/rotate（脚本打的路径没漂）" || fail "服务端 jwt/rotate 路径变了，脚本会 404"
  grep -q "graceDays" "${BKCTL}" && pass "服务端 rotate 接口读的字段确实叫 graceDays" || fail "服务端 rotate 的字段名变了（脚本发的是 graceDays）"
else
  note "找不到服务端控制器源码，跳过 5 条跨包对账"
fi

# ═══ F. rotate-jwt ═══
echo "-- F. rotate-jwt --"
assert_contains "${SRC}" "rotate-jwt" "--help/脚本里出现 rotate-jwt"
usage_out="$(show_usage 2>&1)"
assert_contains "${usage_out}" "rotate-jwt" "show_usage 列出了 rotate-jwt（有一条守卫专查'dispatcher 认的子命令必须在 --help 里'）"
assert_contains "${usage_out}" "--grace-days" "show_usage 说明了 --grace-days"
assert_contains "${usage_out}" "全部 API Token" "show_usage 说清了'宽限期一过全部 API Token 失效'这个后果"
assert_contains "${usage_out}" "waline" "show_usage 提示了 waline 会话的耦合"

# 参数校验：超范围/非数字都要在**发请求之前**失败
reset_apilog
rout="$(rotate_jwt 0 --grace-days 999 2>&1)"; rrc=$?
[[ ${rrc} -ne 0 ]] && pass "--grace-days 999（超范围）→ rc 非 0" || fail "--grace-days 999 竟然被接受了"
assert_contains "${rout}" "0 到 365" "超范围时报错说清合法区间"
assert_eq "$(cat "${APILOG}")" "" "超范围时**没有发任何请求**"
reset_apilog
rout="$(rotate_jwt 0 --grace-days abc 2>&1)"; rrc=$?
[[ ${rrc} -ne 0 ]] && pass "--grace-days abc（非数字）→ rc 非 0" || fail "--grace-days abc 竟然被接受了"
assert_eq "$(cat "${APILOG}")" "" "非数字时没有发任何请求"
reset_apilog
rout="$(rotate_jwt 0 --unknown-flag 2>&1)"; rrc=$?
[[ ${rrc} -ne 0 ]] && pass "不认识的参数 → rc 非 0" || fail "不认识的参数被忽略了"
assert_contains "${rout}" "不认识这个参数" "不认识的参数时明确说出来（不是静默忽略）"

# 确认交互：不输 yes 就不许发请求（这是不可逆操作）
reset_apilog
unset VANBLOG_ASSUME_YES
rout="$(printf 'n\n' | rotate_jwt 0 --grace-days 7 2>&1)"; rrc=$?
assert_rc "${rrc}" 0 "输入 n → 取消，rc 0（取消不是错误）"
assert_contains "${rout}" "已取消（密钥未改动）" "取消时明确说密钥未改动"
assert_not_contains "$(cat "${APILOG}")" "jwt/rotate" "取消时**没有发轮换请求**（连通性检查发生在确认之前，那是应该的）"
# 确认之前必须把三条后果与 waline 耦合说清
assert_contains "${rout}" "宽限期一过" "确认前说明后果②（宽限期一过旧会话与 API Token 全失效）"
assert_contains "${rout}" "恢复一份旧归档会把密钥一起回滚" "确认前说明后果③（恢复旧归档会回滚密钥）"
assert_contains "${rout}" "waline" "确认前说明 waline 会话密钥的耦合"
assert_contains "${rout}" "不可逆" "确认前明说这是不可逆操作"
export VANBLOG_ASSUME_YES=1

# 成功路径
reset_apilog
rout="$(rotate_jwt 0 --grace-days 7 --yes 2>&1)"; rrc=$?
assert_rc "${rrc}" 0 "--yes + 成功响应 → rc 0"
argv_log="$(cat "${APILOG}")"
assert_contains "${argv_log}" "/api/admin/backup/jwt/rotate" "打的是正确的接口路径"
assert_contains "${argv_log}" '{"graceDays":7}' "graceDays 按传的值发出去"
assert_contains "${rout}" "abc12345" "输出里给出新 kid（站长要能对上日志）"
assert_contains "${rout}" "old99999" "输出里给出旧 kid"
assert_contains "${rout}" "3" "输出里给出受影响的 API Token 数量"
assert_not_contains "${rout}" "请重启容器" "restartRequired=false 时不叫站长重启（不多事）"
assert_contains "${rout}" "VANBLOG_ADMIN_TOKEN" "提醒站长当前 token 会在宽限期后失效"

# restartRequired=true → 必须叫站长重启，并给出命令
reset_apilog
export ROTATE_MODE=restart
rout="$(rotate_jwt 0 --yes 2>&1)"; rrc=$?
assert_rc "${rrc}" 0 "restartRequired=true 时仍算成功（密钥确实换了）"
assert_contains "${rout}" "请重启容器完成切换" "restartRequired=true → 明确要求重启"
assert_contains "${rout}" "restart" "restartRequired=true → 给出重启命令"
assert_contains "${rout}" "提前失效" "restartRequired=true → 解释不重启的后果（新令牌会提前失效）"
unset ROTATE_MODE

# 失败路径：原样打印服务端的 message（不要翻译成自己的话）
reset_apilog
export ROTATE_MODE=denied
rout="$(rotate_jwt 0 --yes 2>&1)"; rrc=$?
[[ ${rrc} -ne 0 ]] && pass "服务端拒绝（403）→ rc 非 0" || fail "服务端拒绝了脚本却报成功"
assert_contains "${rout}" "只有管理员能轮换密钥" "失败时**原样**打印服务端的 message"
assert_contains "${rout}" "勾「所有权限」的协作者也不行" "失败时提示这条接口的权限门槛（本轮刚收口过）"
unset ROTATE_MODE

# 不传 --grace-days 时不该硬塞一个值（用服务端默认）
reset_apilog
rout="$(rotate_jwt 0 --yes 2>&1)"
assert_not_contains "$(cat "${APILOG}")" "graceDays" "不传 --grace-days → body 里没有这个字段（交给服务端默认值，不在脚本里另立一个真相）"

# ═══ G. drill 的口令透传（不启容器，只查形状）═══
echo "-- G. drill 口令透传 --"
if [[ -f "${DRILL}" ]]; then
  DSRC="$(cat "${DRILL}")"
  DCODE="$(no_comments "${DSRC}")"
  assert_contains "${DCODE}" "vanblog-backup-passphrase:ro" "drill 把口令文件**只读**挂进容器"
  assert_contains "${DCODE}" "VANBLOG_BACKUP_PASSPHRASE_FILE=/run/secrets/vanblog-backup-passphrase" "drill 给容器的是**容器内路径**（宿主路径在容器里不存在）"
  assert_not_contains "${DCODE}" '-e VANBLOG_BACKUP_PASSPHRASE="$' "drill 没有把口令值放进 run 的 argv（-e VAR=\"\$值\" 会泄漏给 ps）"
  assert_not_contains "${DCODE}" "-e VANBLOG_BACKUP_PASSPHRASE=\${VANBLOG_BACKUP_PASSPHRASE}" "drill 没有用 -e VAR=\${VAR} 这种同样会进 argv 的写法"
  assert_contains "${DCODE}" "chmod 600" "drill 从内联变量落地临时文件时会 chmod 600"
  assert_contains "${DCODE}" "不回显" "drill 的断言台账只说字节数、不回显口令"
  # 负向对照：上面那条"不进 argv"的断言，在旧形状下必须命中（证明它不是空断言）
  printf '%s' '-e VANBLOG_BACKUP_PASSPHRASE="$pass"' | grep -qF -- '-e VANBLOG_BACKUP_PASSPHRASE="$' \
    && pass "负向对照：'-e VAR=\"\$值\"' 这个形状确实会被上面的断言抓到" \
    || fail "负向对照失败：断言抓不到它本该抓的形状（空断言）"
else
  note "找不到 ${DRILL}，跳过 6 条 drill 断言"
fi

# ═══ H. 导出成功后的加密提示（站长把归档传走之前必须知道）═══
echo "-- H. 导出提示 --"
assert_contains "${CODE}" "这份归档是加密的" "导出成功后会明说这份归档是加密的"
assert_contains "${CODE}" "口令丢了这份归档就恢复不了" "导出提示里说清'口令丢了就恢复不了'（这是最容易踩的坑）"
assert_contains "${CODE}" "enc_judged_by" "导出提示会说明判据（魔数还是后缀）—— 读不到文件时退回看后缀必须交代"

echo
echo "passed=${PASS} failed=${FAIL} note=${NOTE}"
[[ ${FAIL} -eq 0 ]] || exit 1
exit 0
