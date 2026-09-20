#!/usr/bin/env bash
# 备份**离线签名**（ed25519）在脚本侧的行为：sidecar 判定、保留策略与异地镜像会不会把 `.sig`
# 落下或当归档处理、verify 的三态、signing-key / signing-export 两个子命令、
# 恢复时 `--skip-signature-check` 这个安全绕过、以及 drill 的公钥透传与"未覆盖验签"台账。
#
# 为什么值得一个独立套件：这批行为**全都错了也不报错** ——
#   - 保留策略把 `.sig` 当成一份归档 ⇒ 它**占掉 keep 名额**，真归档被提前删掉（**数据丢失**），
#     而命令返回 0、日志一切正常；
#   - 异地镜像漏拷 `.sig` ⇒ 离线副本**无法证明没被换过**，而这个功能存在的全部理由就是证明这件事；
#   - `lastSuccessSigned` 的 `null` 被显示成"否" ⇒ 告诉站长一件没发生过的事（"你没签名"），
#     而真相是"无从判断"，两者处置完全不同；
#   - 跳过验签能被环境变量静默打开 ⇒ cron/编排里一个变量就绕过了唯一的真实性检查。
# 所以每条都尽量做成**行为级**（真造归档与真 `.sig`、真跑函数、真数剩下的文件）；
# 源码级钉子只用于跨文件契约，且一律先剥注释（本仓库已踩 8 次"断言匹配到自己的解释性注释"）。
#
# ⚠️ `.sig` fixture 用**服务端自己的实现**（packages/server/dist/src/utils/backupSigning.js 的
# generateSigningKeyPair + signArchiveDigest）生成，不是本测试手搓的假格式 —— 手搓的话测出来的
# 只是"我的假设自洽"。dist 不存在时（CI 没构建过 server）相关用例**明确 NOTE 跳过**，不假装通过。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"
DRILL="${ROOT}/scripts/vanblog-drill.sh"
SIGN_JS="${ROOT}/packages/server/dist/src/utils/backupSigning.js"

PASS=0
FAIL=0
NOTE=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
note() { echo "NOTE: $*"; NOTE=$((NOTE + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }
assert_not_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then fail "$3 (unexpected: $2)"; else pass "$3"; fi; }
assert_matches() { if printf '%s' "$1" 2>/dev/null | grep -qE -- "$2"; then pass "$3"; else fail "$3 (no match: $2)"; fi; }

echo "== vanblog.sh 备份离线签名 / sidecar 判定 / 跳过验签 =="

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

# ── 假 curl：记下**完整 argv**（"秘密有没有进 argv"与"送了哪个字段"的判据），按端点回假响应 ──
cat >"${TEST_DIR}/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
args="$*"
printf '%s\n' "${args}" >>"${APILOG}"
# body 走 -d @文件 时 argv 里看不到内容，所以把文件内容也记下来（判据要看真实 body）
for a in "$@"; do
  case "${a}" in
  @*) [[ -f "${a#@}" ]] && { printf 'BODY< %s\n' "$(cat "${a#@}" 2>/dev/null)" >>"${APILOG}"; } ;;
  esac
done
case "${args}" in
  */api/public/meta*)
    if printf '%s' "${args}" | grep -q -- "-w"; then printf '200'; else printf '{"statusCode":200,"data":{"siteName":"签名测试站"}}'; fi ;;
  */api/admin/backup/signing/key*)
    if printf '%s' "${args}" | grep -q -- "-X POST"; then
      case "${SIGN_MODE:-ok}" in
        ok) printf '{"statusCode":200,"message":"已生成备份签名密钥（指纹 aabbccddeeff0011）","data":{"fingerprint":"aabbccddeeff0011","publicKey":"-----BEGIN PUBLIC KEY-----\\nMCowFAKE\\n-----END PUBLIC KEY-----\\n","privatePath":"/var/log/vanblog-backups/signing/backup-signing-key.pem","publicPath":"/var/log/vanblog-backups/signing/backup-signing-key.pub.pem","replaced":false}}' ;;
        denied) printf '{"statusCode":403,"message":"只有管理员能生成签名密钥"}' ;;
      esac
    else
      case "${SIGN_STATE:-none}" in
        none) printf '{"statusCode":200,"data":{"signingConfigured":false,"signingFingerprint":null,"verifyConfigured":false,"verifyFingerprint":null,"publicKey":null,"trustBoundary":"验签材料只存在本机时，拿到主机 root 的人可以连公钥一起换掉"}}' ;;
        has) printf '{"statusCode":200,"data":{"signingConfigured":true,"signingFingerprint":"old0000key1111","signingSource":"generated","verifyConfigured":true,"verifyFingerprint":"old0000key1111","verifySource":"generated","publicKey":"-----BEGIN PUBLIC KEY-----\\nMCowOLD\\n-----END PUBLIC KEY-----\\n","trustBoundary":"验签材料只存在本机时，拿到主机 root 的人可以连公钥一起换掉"}}' ;;
      esac
    fi ;;
  */api/admin/backup/full/inspect*)
    printf '{"statusCode":200,"data":{"name":"vanblog-full-20260920-100000.tar.zst","createdAt":"2026-09-20T02:00:00.000Z","totals":{"collections":13,"documents":9830,"files":185}}}' ;;
  */api/admin/backup/full/restore*)
    printf '{"statusCode":200,"message":"恢复成功","data":{"collections":13,"documents":9830,"files":185,"signatureWarning":"没有配验签公钥，所以这次恢复**没有验签**"}}' ;;
  */api/admin/auth/login*) printf '{"statusCode":200,"data":{"token":"sig-test-token"}}' ;;
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
export VANBLOG_ADMIN_TOKEN="sig-test-token" # 免得每个用例去交互登录
export VANBLOG_ASSUME_YES=1

SRC="$(cat "${SCRIPT}")"
# shellcheck disable=SC1090
source "${SCRIPT}" >/dev/null 2>&1
# ⚠️ source 进来的脚本自己装了 `trap _passphrase_cleanup EXIT`，会把 cleanup_all 顶掉
#    （bash 每个信号只保留最后一个 trap）⇒ 合成一个，两件都做。
trap '_passphrase_cleanup; cleanup_all' EXIT

# 剥掉整行注释（⚠️ shell 只能用 sed，绝不能用 TS 的 stripCommentsForAnchor：
# 它会把 `https://` 当行注释吃掉、并被引号与 $( ) 带偏，实测把整份脚本啃残）
no_comments() { printf '%s\n' "$1" | sed '/^[[:space:]]*#/d'; }
CODE="$(no_comments "${SRC}")"
DRILL_SRC="$(cat "${DRILL}")"
DRILL_CODE="$(no_comments "${DRILL_SRC}")"
reset_apilog() { : >"${APILOG}"; }

# ── 造一份**真的**整站备份归档（结构照 server 的打包方式）──────────────────────
STAGE="${TEST_DIR}/stage"
mkdir -p "${STAGE}/db/vanBlog" "${STAGE}/static/img"
printf '{"version":1,"kind":"full"}' >"${STAGE}/manifest.json"
printf '{"title":"测试文章"}\n' >"${STAGE}/db/vanBlog/articles.ndjson"
printf 'fakepng' >"${STAGE}/static/img/a.png"

make_archive() { # <目标路径>
  (cd "${STAGE}" && tar -cf - . 2>/dev/null | zstd -q -o "$1" 2>/dev/null) ||
    (cd "${STAGE}" && tar -czf "$1" . 2>/dev/null)
}

# ── A. sidecar 判定助手（这一族的判断只写在一处，所以先钉它）────────────────────
echo "-- A. sidecar 判定助手 --"
for n in vanblog-full-1.tar.zst.sha256 vanblog-full-1.tar.zst.manifest.json vanblog-full-1.tar.zst.sig \
  vanblog-full-1.tar.zst.enc.sig vanblog-backup-1.tar.gz.sig; do
  if is_backup_sidecar_name "${n}"; then pass "is_backup_sidecar_name 认得 ${n}"; else fail "is_backup_sidecar_name 漏判 ${n}"; fi
done
for n in vanblog-full-1.tar.zst vanblog-full-1.tar.zst.enc vanblog-backup-1.tar.gz; do
  if is_backup_sidecar_name "${n}"; then fail "is_backup_sidecar_name 把**真归档**误判成 sidecar：${n}"; else pass "真归档不被误判：${n}"; fi
done
# 带路径也要能判（调用方有的传名字、有的传完整路径）
if is_backup_sidecar_name "/some/dir/vanblog-full-1.tar.zst.sig"; then
  pass "带完整路径也能判"
else
  fail "带完整路径判不出来（调用方传的是路径）"
fi
# filter_backup_archives：混着 sidecar 的名单里只留归档
FILTERED="$(printf '%s\n' vanblog-full-3.tar.zst vanblog-full-3.tar.zst.sig vanblog-full-2.tar.zst vanblog-full-2.tar.zst.sha256 \
  vanblog-full-1.tar.zst.enc vanblog-full-1.tar.zst.enc.sig vanblog-full-1.tar.zst.manifest.json | filter_backup_archives)"
assert_eq "$(printf '%s\n' "${FILTERED}" | wc -l | tr -d ' ')" "3" "filter_backup_archives 只留 3 份真归档（4 个 sidecar 全滤掉）"
assert_not_contains "${FILTERED}" ".sig" "滤掉的名单里没有 .sig"
assert_not_contains "${FILTERED}" ".sha256" "滤掉的名单里没有 .sha256"
assert_not_contains "${FILTERED}" ".manifest.json" "滤掉的名单里没有 .manifest.json"
# 空转反证：这把尺子对"全是归档"的名单必须一条都不滤（否则它可能是在无脑丢行）
assert_eq "$(printf '%s\n' a.tar.zst b.tar.zst | filter_backup_archives | wc -l | tr -d ' ')" "2" "尺子有效性：全是归档时一条不滤"

# backup_sidecar_paths：只列**实际存在**的
SA="${TEST_DIR}/sa.tar.zst"
make_archive "${SA}"
: >"${SA}.sha256"
: >"${SA}.sig"
SCP="$(backup_sidecar_paths "${SA}")"
assert_eq "$(printf '%s\n' "${SCP}" | grep -c .)" "2" "backup_sidecar_paths 只列存在的（.sha256 与 .sig，没有 .manifest.json）"
assert_contains "${SCP}" ".sig" "列出的里面有 .sig"
: >"${SA}.manifest.json"
assert_eq "$(backup_sidecar_paths "${SA}" | grep -c .)" "3" "补上 .manifest.json 后列出 3 个"

# ── B. 🔴 保留策略：`.sig` 绝不能占掉 keep 名额（占了就会提前删真归档 = 数据丢失）──
echo "-- B. 保留策略 --"
PR="${BK}"
rm -f "${PR}"/vanblog-* 2>/dev/null
for i in 1 2 3 4; do
  a="${PR}/vanblog-full-2026090${i}-100000.tar.zst"
  make_archive "${a}"
  printf 'deadbeef  %s\n' "$(basename "${a}")" >"${a}.sha256"
  printf '{"magic":"VANBLOGSIG1","keyFingerprint":"fp%02d"}' "${i}" >"${a}.sig"
  printf '{"version":1}' >"${a}.manifest.json"
  # mtime 拉开，保证 ls -1t 的顺序确定（i 越大越新）
  touch -d "2026-09-0${i} 10:00:00" "${a}" "${a}.sha256" "${a}.sig" "${a}.manifest.json" 2>/dev/null ||
    touch -t "2026090${i}1000" "${a}" "${a}.sha256" "${a}.sig" "${a}.manifest.json" 2>/dev/null
done
prune_old_backups full 2 >/dev/null 2>&1
left="$(cd "${PR}" && ls -1 vanblog-full-*.tar.zst 2>/dev/null | filter_backup_archives | wc -l | tr -d ' ')"
assert_eq "${left}" "2" "keep=2 之后**恰好**剩 2 份真归档（若 .sig 占了名额，这里会少于 2 ⇒ 真归档被误删）"
assert_eq "$(cd "${PR}" && ls -1 vanblog-full-*.tar.zst.sig 2>/dev/null | wc -l | tr -d ' ')" "2" ".sig 与归档同生共死：也剩 2 个（没有孤儿）"
assert_eq "$(cd "${PR}" && ls -1 vanblog-full-*.sha256 2>/dev/null | wc -l | tr -d ' ')" "2" ".sha256 没有孤儿"
# ⚠️ 这一条钉的是本轮顺带修掉的既有 bug：prune 原来删的是 `${name%.tar.*}.manifest.json`
#    （= vanblog-full-X.manifest.json），而 server 写的是 `<完整归档名>.manifest.json`
#    ⇒ 那条 rm 一直没删到任何文件，孤儿清单从来没被清理过。
assert_eq "$(cd "${PR}" && ls -1 vanblog-full-*.manifest.json 2>/dev/null | wc -l | tr -d ' ')" "2" \
  ".manifest.json 没有孤儿（这条以前是坏的：拼的名字与服务端写的不一致，rm 一直没删到东西）"
# 剩下的是**最新的两份**（不是随便两份）
newest="$(cd "${PR}" && ls -1t vanblog-full-*.tar.zst | filter_backup_archives | head -2 | sort | tr '\n' ' ')"
assert_contains "${newest}" "20260904" "留下的是最新的（含 0904）"
assert_contains "${newest}" "20260903" "留下的是最新的（含 0903）"
assert_not_contains "$(cd "${PR}" && ls -1 vanblog-full-*.tar.zst | filter_backup_archives | tr '\n' ' ')" "20260901" "最旧的 0901 被删了"

# ── C. 🔴 异地镜像必须带上 `.sig`（不带的话离线副本无法证明没被换过）──────────────
echo "-- C. 异地镜像 --"
MIR="${TEST_DIR}/mirror"
rm -rf "${MIR}"; mkdir -p "${MIR}"
MA="${BK}/vanblog-full-20260920-120000.tar.zst"
make_archive "${MA}"
# ⚠️ 必须是**真**哈希：假 sidecar 会让镜像校验判"不通过"并删掉副本（那是正确行为），
#    于是这一组测到的就不是"有没有拷 .sig"而是"坏副本清理"。
# ⚠️ 直接用 sha256sum 自己的输出（格式就是 `<hash>  <name>`），别拿 awk 拼：
#    第一版拼成了少一个引号的 awk 程序 ⇒ 语法错、sidecar 变空文件，于是镜像校验与
#    verify 都判"sha256 不符"，看起来像功能坏了，其实是 fixture 坏了。
(cd "$(dirname "${MA}")" && sha256sum "$(basename "${MA}")" >"$(basename "${MA}").sha256")
printf '{"magic":"VANBLOGSIG1","keyFingerprint":"mirrorfp01","signedAt":"2026-09-20T04:00:00.000Z","archiveSha256":"%s","archiveBytes":%s}' \
  "$(sha256sum "${MA}" | cut -d' ' -f1)" "$(wc -c <"${MA}" | tr -d ' ')" >"${MA}.sig"
printf '{"version":1}' >"${MA}.manifest.json"
VANBLOG_BACKUP_MIRROR_DIR="${MIR}" mirror_backup_artifacts "${MA}" >"${TEST_DIR}/mirror.out" 2>&1
if [[ -f "${MIR}/$(basename "${MA}")" ]]; then pass "镜像里有归档本体"; else fail "镜像里没有归档本体"; fi
if [[ -f "${MIR}/$(basename "${MA}").sig" ]]; then
  pass "🔴 镜像里有 .sig（离线副本因此可证明没被换过）"
else
  fail "🔴 镜像里**没有** .sig —— 离线副本无法验签，这个功能等于没上线"
fi
[[ -f "${MIR}/$(basename "${MA}").sha256" ]] && pass "镜像里有 .sha256" || fail "镜像里没有 .sha256"
[[ -f "${MIR}/$(basename "${MA}").manifest.json" ]] && pass "镜像里有 .manifest.json" || fail "镜像里没有 .manifest.json"
MOUT="$(cat "${TEST_DIR}/mirror.out")"
assert_contains "${MOUT}" "已复制签名" "镜像输出里点名说了复制了签名（不是静默做的）"
assert_contains "${MOUT}" "mirrorfp01" "镜像输出里给出签名指纹"
# 没签过时必须**说清楚**后果，而不是沉默
MA2="${BK}/vanblog-full-20260920-130000.tar.zst"
make_archive "${MA2}"
# ⚠️ 直接用 sha256sum 自己的输出（格式就是 `<hash>  <name>`），别拿 awk 拼：
#    第一版拼成了少一个引号的 awk 程序 ⇒ 语法错、sidecar 变空文件，于是镜像校验与
#    verify 都判"sha256 不符"，看起来像功能坏了，其实是 fixture 坏了。
(cd "$(dirname "${MA2}")" && sha256sum "$(basename "${MA2}")" >"$(basename "${MA2}").sha256")
VANBLOG_BACKUP_MIRROR_DIR="${MIR}" mirror_backup_artifacts "${MA2}" >"${TEST_DIR}/mirror2.out" 2>&1
M2="$(cat "${TEST_DIR}/mirror2.out")"
assert_contains "${M2}" "没有 .sig 签名" "未签名的归档：镜像时明说没有签名"
assert_contains "${M2}" "不能证明" "并说清后果（只能证明没拷坏、不能证明没被换过）"
assert_contains "${M2}" "signing-key" "并给出可照做的下一步（signing-key）"
# 坏副本要被删干净（连 sidecar），否则目的地会留下"签名在、归档不在"的更危险状态
VANBLOG_BACKUP_MIRROR_DIR="${MIR}" mirror_backup_artifacts "${MA}" >/dev/null 2>&1
printf 'corrupted' >"${MIR}/$(basename "${MA}")" # 破坏副本，让 sha256 比对失败
VANBLOG_BACKUP_MIRROR_DIR="${MIR}" mirror_backup_artifacts "${MA}" >"${TEST_DIR}/mirror3.out" 2>&1
# 上面这次会先重新拷一份好的，所以改成直接验证"校验失败时删 sidecar"这条源码契约 + 一次真失败
rm -f "${MIR}/$(basename "${MA}")"
printf 'x' >"${MIR}/$(basename "${MA}").sha256" # sidecar 残留
M3SRC="$(no_comments "$(sed -n '/^mirror_backup_artifacts()/,/^}/p' "${SCRIPT}")")"
assert_contains "${M3SRC}" '"${dest}/${base}.sig"' "镜像校验失败时把 .sig 一起删（源码契约）"
assert_contains "${M3SRC}" '"${dest}/${base}.manifest.json"' "镜像校验失败时把 .manifest.json 一起删"
# 镜像侧的按份数清理也要带走 .sig
VANBLOG_BACKUP_MIRROR_DIR="${MIR}" VANBLOG_BACKUP_MIRROR_KEEP=1 mirror_backup_artifacts "${MA2}" >/dev/null 2>&1
msig="$(cd "${MIR}" && ls -1 *.sig 2>/dev/null | wc -l | tr -d ' ')"
march="$(cd "${MIR}" && ls -1 vanblog-full-*.tar.zst 2>/dev/null | filter_backup_archives | wc -l | tr -d ' ')"
if [[ "${march}" -le 1 ]]; then pass "镜像清理按 keep=1 生效（剩 ${march} 份归档）"; else fail "镜像清理没生效（剩 ${march} 份）"; fi
if [[ "${msig}" -le "${march}" ]]; then pass "镜像里没有孤儿 .sig（${msig} 个 .sig ≤ ${march} 份归档）"; else fail "镜像里有孤儿 .sig（${msig} > ${march}）"; fi

# ── D. verify 的三态（signed-nokey / unsigned / malformed）──────────────────────
echo "-- D. verify 三态 --"
VA="${TEST_DIR}/vanblog-full-20260920-140000.tar.zst"
make_archive "${VA}"
# ⚠️ 真哈希：假 sidecar 会让 verify 直接判 FAIL，而 FAIL 分支**不打印 notes**
#    ⇒ 签名那三态一条都测不到（我第一次就是这么错的，还以为是功能没生效）。
# ⚠️ 直接用 sha256sum 自己的输出（格式就是 `<hash>  <name>`），别拿 awk 拼：
#    第一版拼成了少一个引号的 awk 程序 ⇒ 语法错、sidecar 变空文件，于是镜像校验与
#    verify 都判"sha256 不符"，看起来像功能坏了，其实是 fixture 坏了。
(cd "$(dirname "${VA}")" && sha256sum "$(basename "${VA}")" >"$(basename "${VA}").sha256")
VOUT="$(verify_one_archive "${VA}" 2>&1)"
# ⚠️ 这条断言在第二轮被**升级**而不是放宽：文案从「没有 .sig 签名：…」改成了
#    「本地推断：没有 .sig ⇒ …」，因为现在 verify 能拿到服务端的**权威**五态，
#    本地那三态必须自我标明是「推断」—— 否则「有 .sig」会被读成「验过签」。
#    原本要保护的性质（明说「从没被签过」、不含糊成「无签名信息」）逐字保留在下面两条里。
assert_contains "${VOUT}" "本地推断：没有 .sig" "无 .sig ⇒ 明说这是**本地推断**（不冒充服务端验签结论）"
assert_contains "${VOUT}" "从没被签过" "且明说「从没被签过」（不是含糊的「无签名信息」）"
assert_contains "${VOUT}" "不能证明" "并说清 unsigned 的含义"

if [[ -f "${SIGN_JS}" ]]; then
  # 用**服务端自己的实现**造一份真 .sig（手搓假格式只能证明我的假设自洽）
  KEYDIR="${TEST_DIR}/keydir"
  mkdir -p "${KEYDIR}"
  SIGINFO="$(node -e '
    const m = require(process.argv[1]);
    const crypto = require("crypto"); const fs = require("fs");
    const dir = process.argv[2], arc = process.argv[3];
    const gen = m.generateSigningKeyPair(dir, { overwrite: true });
    const key = m.resolveSigningKey(dir);
    const sha = crypto.createHash("sha256").update(fs.readFileSync(arc)).digest("hex");
    const p = m.signArchiveDigest({ archivePath: arc, archiveSha256: sha, archiveBytes: fs.statSync(arc).size, signingKey: key });
    process.stdout.write(JSON.stringify({ fp: gen.fingerprint, sig: p, sha }));
  ' "${SIGN_JS}" "${KEYDIR}" "${VA}" 2>"${TEST_DIR}/sig.err")"
  if [[ -n "${SIGINFO}" && -f "${VA}.sig" ]]; then
    FP="$(printf '%s' "${SIGINFO}" | sed -n 's/.*"fp":"\([^"]*\)".*/\1/p')"
    VOUT2="$(verify_one_archive "${VA}" 2>&1)"
    assert_contains "${VOUT2}" "已签名" "有真 .sig ⇒ 报「已签名」"
    assert_contains "${VOUT2}" "${FP}" "并报出密钥指纹（${FP}）"
    assert_contains "${VOUT2}" "未做密码学验签" "🔴 明说脚本侧**没有**做密码学验签（不能让人把「有 .sig」读成「验过了」）"
    assert_contains "${VOUT2}" "VANBLOG_BACKUP_VERIFY_KEY" "并指出要权威结论该配什么"
    assert_not_contains "${VOUT2}" "不一致" "内容对得上时不误报「签名覆盖的 sha256 不一致」"
    # 篡改归档 ⇒ 弱比对必须发现（这不是验签，但能抓住"签名之后归档被改过"）
    printf 'tamper' >>"${VA}"
    # ⚠️ 同步更新 .sha256：否则先撞上"sidecar 不符"那条 FAIL，测不到"签名覆盖的 sha256 与实测不一致"
    # ⚠️ 直接用 sha256sum 自己的输出（格式就是 `<hash>  <name>`），别拿 awk 拼：
    #    第一版拼成了少一个引号的 awk 程序 ⇒ 语法错、sidecar 变空文件，于是镜像校验与
    #    verify 都判"sha256 不符"，看起来像功能坏了，其实是 fixture 坏了。
    (cd "$(dirname "${VA}")" && sha256sum "$(basename "${VA}")" >"$(basename "${VA}").sha256")
    VOUT3="$(verify_one_archive "${VA}" 2>&1)"
    assert_contains "${VOUT3}" "不一致" "归档被改动后，签名覆盖的 sha256 与实测不一致 ⇒ 报出来"
    # .sig 形状不对（magic 错）⇒ 既不当通过、也不断言"被篡改"
    printf '{"magic":"NOTVANBLOG","keyFingerprint":"x"}' >"${VA}.sig"
    VOUT4="$(verify_one_archive "${VA}" 2>&1)"
    assert_contains "${VOUT4}" "形状不对" ".sig 畸形 ⇒ 明说形状不对"
    assert_contains "${VOUT4}" "不该断言被篡改" "并且不断言「被篡改」（畸形 ≠ 篡改，处置完全不同）"
  else
    note "服务端 dist 的签名实现跑不起来（$(head -c 120 "${TEST_DIR}/sig.err" 2>/dev/null)）⇒ 真 .sig 的用例跳过，不假装通过"
  fi
else
  note "没有 ${SIGN_JS}（server 未构建）⇒ 真 .sig 的用例跳过；手搓假格式只会证明假设自洽，所以不造"
fi

# ── E. signing-key / signing-export ───────────────────────────────────────────
echo "-- E. signing-key / signing-export --"
reset_apilog
# ⚠️ 必须 export：`VAR=x OUT="$(cmd)"` 整行都是赋值、没有命令，VAR **不会**进子进程环境
#    ⇒ 假 curl 读不到它（第一次就是这么错的：SIGN_STATE=has 的用例全部按 none 走了）。
export SIGN_STATE=none
E_OUT="$(signing_key 0 2>&1)"; E_RC=$?
assert_eq "${E_RC}" "0" "首次生成（无既有密钥）返回 0"
assert_contains "${E_OUT}" "备份签名密钥已" "输出里说了生成成功"
assert_contains "${E_OUT}" "aabbccddeeff0011" "输出里给出指纹"
assert_contains "${E_OUT}" "signing-export" "并立刻给出「离线保存公钥」的下一步"
assert_contains "${E_OUT}" "离线" "强调公钥必须离线保存（这是本功能的全部意义）"
assert_not_contains "${E_OUT}" "PRIVATE KEY" "🔴 输出里绝不出现私钥"
assert_not_contains "${E_OUT}" "privateKey" "🔴 输出里绝不出现 privateKey 字段"
API="$(cat "${APILOG}")"
assert_contains "${API}" "-X POST" "生成走的是 POST signing/key"
assert_not_contains "${API}" "overwrite" "首次生成不带 overwrite（没有东西要覆盖）"

# 已有密钥但没给 --overwrite ⇒ 必须**拒绝改动**并把后果与命令说清
reset_apilog
export SIGN_STATE=has
R_OUT="$(signing_key 0 2>&1)"; R_RC=$?
if [[ "${R_RC}" -ne 0 ]]; then pass "已有密钥且未给 --overwrite ⇒ 非 0 退出（拒绝改动）"; else fail "已有密钥且未给 --overwrite 却返回 0（静默覆盖是最坏的结果）"; fi
assert_contains "${R_OUT}" "永久无法验证" "并说清覆盖的后果（所有旧 .sig 永久无法验证）"
assert_contains "${R_OUT}" "--overwrite" "并给出要显式加的那个 flag"
assert_contains "${R_OUT}" "signing-export" "并先让你把旧公钥导出保存"
assert_not_contains "$(cat "${APILOG}")" "-X POST" "🔴 拒绝路径**没有发出** POST（不是发了再失败）"

# 给了 --overwrite ⇒ 要确认（VANBLOG_ASSUME_YES=1 已导出，所以直接过），且 body 里是**字面 true**
reset_apilog
export SIGN_STATE=has
O_OUT="$(signing_key 0 --overwrite 2>&1)"; O_RC=$?
assert_eq "${O_RC}" "0" "--overwrite + 已确认 ⇒ 返回 0"
OAPI="$(cat "${APILOG}")"
assert_contains "${OAPI}" '"overwrite":"true"' "🔴 送的是字面 \"true\"（服务端用 isTrue，送 1/yes/TRUE 都不算 ⇒ 会静默不覆盖）"
assert_not_contains "${OAPI}" '"overwrite":"1"' "不送 \"1\"（那不算确认）"
assert_not_contains "${O_OUT}" "PRIVATE KEY" "覆盖路径也绝不打印私钥"

# signing-export：公钥走 stdout、元信息走 stderr（`> pub.pem` 要得到干净 PEM）
reset_apilog
export SIGN_STATE=has
PUB="$(signing_export 0 2>/dev/null)"; PUB_RC=$?
META="$(signing_export 0 2>&1 >/dev/null)"
assert_eq "${PUB_RC}" "0" "signing-export 返回 0"
assert_contains "${PUB}" "BEGIN PUBLIC KEY" "stdout 是 PEM 公钥"
assert_contains "${PUB}" "END PUBLIC KEY" "PEM 完整（有结尾行）"
assert_not_contains "${PUB}" "指纹" "stdout 里**没有**元信息（否则重定向出来的 PEM 是脏的）"
assert_contains "${META}" "old0000key1111" "元信息走 stderr（含指纹）"
assert_not_contains "${META}" "PRIVATE" "stderr 里也不出现私钥"
# 没有密钥时不能吐一个空文件假装成功
reset_apilog
export SIGN_STATE=none
NP="$(signing_export 0 2>/dev/null)"; NP_RC=$?
if [[ "${NP_RC}" -ne 0 ]]; then pass "没有签名密钥时 signing-export 非 0 退出"; else fail "没有密钥却返回 0（会留下一个空的 pub.pem，看起来像导出成功）"; fi
assert_eq "${NP}" "" "且 stdout 为空（不写半个 PEM）"
# 未知参数要报错，不能静默忽略
signing_key 0 --bogus >/dev/null 2>&1 && fail "signing-key 静默接受了未知参数" || pass "signing-key 拒绝未知参数（非 0）"
signing_export 0 extra >/dev/null 2>&1 && fail "signing-export 静默接受了参数" || pass "signing-export 拒绝参数（非 0）"

# ── F. 恢复时跳过验签：只能由**显式 flag** 打开 ────────────────────────────────
echo "-- F. --skip-signature-check --"
RA="${BK}/vanblog-full-20260920-100000.tar.zst"
[[ -f "${RA}" ]] || make_archive "${RA}"
reset_apilog
restore_full_backup "vanblog-full-20260920-100000.tar.zst" true false >/dev/null 2>&1
NAPI="$(cat "${APILOG}")"
assert_not_contains "${NAPI}" "skipSignatureCheck" "不给 flag ⇒ body 里没有 skipSignatureCheck（默认必须验签）"
reset_apilog
restore_full_backup "vanblog-full-20260920-100000.tar.zst" true true >/dev/null 2>&1
SAPI="$(cat "${APILOG}")"
assert_contains "${SAPI}" "skipSignatureCheck" "给了 flag ⇒ body 里带上 skipSignatureCheck"
assert_contains "${SAPI}" '"skipSignatureCheck":"true"' "且值是字面 true（服务端 isTrue 只认这个）"
assert_not_contains "${SAPI}" 'skipSignatureCheck":"1"' "不送 \"1\""
# 🔴 安全性质：环境变量**不能**打开这个绕过（否则 cron/编排里一个变量就静默绕过验签）
reset_apilog
VANBLOG_RESTORE_SKIP_SIGNATURE=1 VANBLOG_SKIP_SIGNATURE_CHECK=1 \
  restore_full_backup "vanblog-full-20260920-100000.tar.zst" true false >/dev/null 2>&1
assert_not_contains "$(cat "${APILOG}")" "skipSignatureCheck" \
  "🔴 环境变量打不开这个绕过（只有命令行 flag 能）—— cron/编排里的一个变量不能静默跳过验签"
# skip_sig 收到非 true/false 的值要报错（调用方 bug 不能变成静默绕过）
BAD_OUT="$(restore_full_backup "vanblog-full-20260920-100000.tar.zst" true "1" 2>&1)"; BAD_RC=$?
if [[ "${BAD_RC}" -ne 0 ]]; then pass "skip_sig=1 被拒（只认字面 true/false）"; else fail "skip_sig=1 被接受了（那是绕过开关，不能宽松）"; fi
assert_contains "${BAD_OUT}" "调用方的 bug" "并说清这是调用方 bug 而不是用户输入"
# 服务端的 signatureWarning 必须显示出来（"这次到底验没验签"的唯一权威说法）
reset_apilog
W_OUT="$(restore_full_backup "vanblog-full-20260920-100000.tar.zst" true false 2>&1)"
assert_contains "${W_OUT}" "没有验签" "服务端的 signatureWarning 被显示出来（静默不验签与验过在站长眼里长得一样）"

# ── G. 帮助与用法（docs-consistency 有一条守卫专查"子命令必须在 --help 里"）──────
echo "-- G. 帮助文本 --"
USAGE="$(show_usage 2>&1)"
assert_contains "${USAGE}" "signing-key" "--help 里有 signing-key"
assert_contains "${USAGE}" "signing-export" "--help 里有 signing-export"
assert_contains "${USAGE}" "--skip-signature-check" "--help 里有 --skip-signature-check"
assert_contains "${USAGE}" "安全绕过" "并标明它是安全绕过（不是普通开关）"
PU="$(print_restore_usage 2>&1)"
assert_contains "${PU}" "--skip-signature-check" "restore 的用法里有这个 flag"
assert_contains "${PU}" "VANBLOG_BACKUP_VERIFY_KEY" "并指出正常做法是配验签公钥后重试"
# 空转反证：上面那把尺子对"确实没有"的文本必须判失败
if printf '%s' "${USAGE}" | grep -qF -- "这个字符串绝对不存在zzz"; then
  fail "尺子失效：不存在的字符串也被判为存在"
else
  pass "尺子有效性：不存在的字符串判为不存在"
fi

# ── H. drill：公钥透传 + "验签未被演练覆盖"的台账 ──────────────────────────────
echo "-- H. drill --"
assert_contains "${DRILL_CODE}" "VANBLOG_BACKUP_VERIFY_KEY_FILE" "drill 读 VANBLOG_BACKUP_VERIFY_KEY_FILE"
assert_contains "${DRILL_CODE}" "VANBLOG_BACKUP_VERIFY_KEY" "drill 也读内联的 VANBLOG_BACKUP_VERIFY_KEY"
assert_contains "${DRILL_CODE}" "/run/secrets/vanblog-backup-verify-key:ro" "公钥以**只读**文件挂进容器（与口令同一套手法）"
assert_contains "${DRILL_CODE}" 'drill_vkey_args[@]+' "透传参数真的被展开进 podman run"
# ⚠️ 这条断言在第二轮被**升级**：以前钉的是「验签未被本次演练覆盖」，因为当时匿名恢复接口
#    收不到 .sig（服务端能力缺口）。4bf4830f 给 `POST /api/admin/init/restore` 加了 signature
#    文本字段，演练**现在能真覆盖验签**了 ⇒ 台账必须改口，否则会把一个已经能验的能力说成验不了。
#    原本要保护的性质（不许让「公钥已透传」被读成「演练验过签了」）由下面三条继续钉住：
#    ① 前置条件单独记；② 没透传公钥时明说 no-key、恢复成功≠验过签；③ 权威结论只在恢复跑完后记。
assert_contains "${DRILL_CODE}" "验签的前置条件齐了" "台账先记**前置条件**（有没有 .sig、有没有透传公钥）"
assert_contains "${DRILL_CODE}" "有 .sig，但演练容器里没有验签公钥" \
  "🔴 没透传公钥时明说「没有真验签」（否则「公钥已透传」那条 note 会被读成「演练验过签了」）"
assert_contains "${DRILL_CODE}" "恢复成功**不等于**验过签" "并把「恢复成功 ≠ 验过签」写在台账里"
assert_contains "${DRILL_CODE}" "missing-sig" "并写清原因：上传路径拿不到 .sig ⇒ 只能是 missing-sig"
# 空转反证：这两把尺子在**没改过**的旧形状上必须判失败
OLD_DRILL='local -a drill_pass_args=()
drill_pass_args+=(-v "${src}:/run/secrets/vanblog-backup-passphrase:ro")'
if printf '%s' "${OLD_DRILL}" | grep -qF -- "/run/secrets/vanblog-backup-verify-key:ro"; then
  fail "尺子失效：旧形状也被判为含验签公钥挂载"
else
  pass "尺子有效性：旧形状（只有口令挂载）判为不含验签公钥挂载"
fi
# backup-status 的三态：null ≠ false（源码契约 + 文案）
assert_contains "${DRILL_CODE}" "lastSuccessSigned" "backup-status 读 lastSuccessSigned"
assert_contains "${DRILL_CODE}" "lastSuccessSigning.keyFingerprint" "并读 lastSuccessSigning.keyFingerprint"
assert_contains "${DRILL_CODE}" "签名状态**未知**（不是「未签名」）" \
  "🔴 null 显示成「未知」而不是「未签名」（把 null 说成 false 是在告诉站长一件没发生过的事）"
assert_contains "${DRILL_CODE}" "不要把它读成「没签名」" "并在文案里明说不要读成「没签名」"
# 未签名只能是 WARN，不能是 FAIL（否则所有存量部署立刻常红）
BS_BLOCK="$(no_comments "$(sed -n '/^cmd_backup_status()/,/^}/p' "${DRILL}")")"
UNSIGNED_BRANCH="$(printf '%s\n' "${BS_BLOCK}" | sed -n '/^    false)/,/^      ;;/p')"
if [[ -n "${UNSIGNED_BRANCH}" ]]; then
  if printf '%s' "${UNSIGNED_BRANCH}" | grep -q "rec_warn"; then pass "未签名走 rec_warn（警告）"; else fail "未签名分支里没有 rec_warn"; fi
  if printf '%s' "${UNSIGNED_BRANCH}" | grep -q "rec_fail"; then fail "🔴 未签名走了 rec_fail ⇒ --strict 下所有存量部署会常红"; else pass "未签名**不是** rec_fail（--strict 下也只警告）"; fi
else
  fail "在 cmd_backup_status 里找不到 lastSuccessSigned=false 的分支（结构变了？请更新这条断言而不是删掉）"
fi


# ══════════════════════════════════════════════════════════════════════════
# 第二轮：匿名恢复携带 .sig、篡改归档的负向场景、verify 的权威五态、
#         以及 sidecar 枚举漏判 .sig 这个可达 bug 的钉子
# ══════════════════════════════════════════════════════════════════════════
echo
echo "== drill：签名相关的纯函数（抽取 + eval，因为 drill 一 source 就会跑分发）=="

drill_fn() { sed -n "/^$1()/,/^}/p" "${DRILL}"; }
for fn in drill_signature_sidecar drill_build_restore_args drill_classify_signature_outcome \
          drill_make_tampered_copy drill_is_backup_sidecar; do
  body="$(drill_fn "${fn}")"
  if [[ -z "${body}" ]]; then fail "drill 里找不到函数 ${fn}（被改名或删除？）"
  else eval "${body}"; pass "已加载 drill 的纯函数 ${fn}"; fi
done
eval "$(grep -m1 '^DRILL_SIDECAR_RE=' "${DRILL}")"
assert_contains "${DRILL_SIDECAR_RE:-}" 'sig' "DRILL_SIDECAR_RE 覆盖 .sig（不只是 .sha256/.manifest.json）"

# ── sidecar 判定 ─────────────────────────────────────────────────────────
SD="${TEST_DIR}/sidecar"; mkdir -p "${SD}"
: >"${SD}/vanblog-full-20260920-1000.tar.zst"
: >"${SD}/vanblog-full-20260920-1000.tar.zst.sig"
: >"${SD}/vanblog-full-20260920-1000.tar.zst.sha256"
: >"${SD}/vanblog-full-20260920-1000.tar.zst.manifest.json"
: >"${SD}/vanblog-full-20260920-1000.tar.zst.enc"
for f in .sig .sha256 .manifest.json; do
  if drill_is_backup_sidecar "${SD}/vanblog-full-20260920-1000.tar.zst${f}"; then
    pass "drill_is_backup_sidecar 认出 ${f} 是 sidecar"
  else fail "drill_is_backup_sidecar 没认出 ${f} 是 sidecar"; fi
done
for f in .tar.zst .tar.zst.enc; do
  if drill_is_backup_sidecar "${SD}/vanblog-full-20260920-1000${f}"; then
    fail "drill_is_backup_sidecar 把真归档 ${f} 误判成 sidecar"
  else pass "drill_is_backup_sidecar 不把真归档 ${f} 当 sidecar"; fi
done
if drill_is_backup_sidecar ""; then fail "空路径不该被判成 sidecar"; else pass "空路径不被判成 sidecar（不误伤）"; fi

# 🔴 行为级钉子：`.sig` 比归档**更新**，所以旧的枚举会把 .sig 当成"最新归档"。
#    这条同时是"新判据有效"与"旧判据确实错"的对照 —— 只断言新的对，证明不了旧的错。
touch -d '2026-09-20 10:00:00' "${SD}/vanblog-full-20260920-1000.tar.zst" 2>/dev/null \
  || touch "${SD}/vanblog-full-20260920-1000.tar.zst"
touch "${SD}/vanblog-full-20260920-1000.tar.zst.sig"   # 后写 ⇒ mtime 更新（这正是 bug 的成因）
# ⚠️ 其余 sidecar 与那个 .enc 兄弟都要**比归档旧**，否则"最新归档"本来就该是它们，
#    这条钉子就测不到"漏判 .sig"这件事了（第一版就因为 .enc 是刚创建的而取到 .enc）。
touch -d '2026-09-20 09:00:00' "${SD}/vanblog-full-20260920-1000.tar.zst.sha256" \
  "${SD}/vanblog-full-20260920-1000.tar.zst.manifest.json" "${SD}/vanblog-full-20260920-1000.tar.zst.enc" 2>/dev/null || true
newest_new="$(ls -1t "${SD}"/vanblog-full-* 2>/dev/null | grep -vE "${DRILL_SIDECAR_RE}" | head -1)"
newest_old="$(ls -1t "${SD}"/vanblog-full-* 2>/dev/null | grep -vE '\.(manifest\.json|sha256)$' | head -1)"
assert_eq "$(basename "${newest_new}")" "vanblog-full-20260920-1000.tar.zst" \
  "共用判据取到的最新归档是真归档"
assert_eq "$(basename "${newest_old}")" "vanblog-full-20260920-1000.tar.zst.sig" \
  "对照：旧判据（不排除 .sig）会取到 .sig —— 证明这个 bug 真实可达，不是理论"
assert_not_contains "$(ls -1t "${SD}"/vanblog-full-* | grep -vE "${DRILL_SIDECAR_RE}")" '.sig' \
  "共用判据的枚举结果里不含任何 .sig"
# 尺子有效性反证：如果把 sig 从正则里去掉，上面那条"取到真归档"必须失败
if printf '%s' "${DRILL_SIDECAR_RE}" | sed 's/|sig//' | grep -q 'sig'; then
  fail "反证写法有误：去掉 sig 之后正则里还有 sig"
else
  bad_re="$(printf '%s' "${DRILL_SIDECAR_RE}" | sed 's/|sig//')"
  bad_pick="$(ls -1t "${SD}"/vanblog-full-* | grep -vE "${bad_re}" | head -1)"
  assert_eq "$(basename "${bad_pick}")" "vanblog-full-20260920-1000.tar.zst.sig" \
    "反证：正则里去掉 sig 就会重新取到 .sig（尺子量得到坏形状）"
fi
# 全脚本不许再有"只排除两种 sidecar"的旧形状（10 处曾全部漏掉 .sig）
OLD_SHAPE_COUNT="$(grep -cF "*.manifest.json | *.sha256)" "${DRILL}" || true)"
assert_eq "${OLD_SHAPE_COUNT}" "0" "drill 里不再有 '*.manifest.json | *.sha256' 这种漏掉 .sig 的 case"
OLD_GREP_COUNT="$(grep -cF "manifest\\.json|sha256)\$" "${DRILL}" || true)"
assert_eq "${OLD_GREP_COUNT}" "0" "drill 里不再有硬编码的两项 grep -vE（必须引用 DRILL_SIDECAR_RE）"
RE_USE_COUNT="$(grep -cF 'grep -vE "${DRILL_SIDECAR_RE}"' "${DRILL}" || true)"
if [[ "${RE_USE_COUNT}" -ge 6 ]]; then pass "枚举点都引用了共用正则（${RE_USE_COUNT} 处 ≥ 6）"
else fail "引用共用正则的枚举点只有 ${RE_USE_COUNT} 处（原本有 6 个 grep 点）"; fi
SIDE_FN_COUNT="$(grep -cF 'drill_is_backup_sidecar' "${DRILL}" || true)"
if [[ "${SIDE_FN_COUNT}" -ge 5 ]]; then pass "case 型枚举都改用了共用判据（${SIDE_FN_COUNT} 处引用 ≥ 5：定义+4 个调用点）"
else fail "drill_is_backup_sidecar 只被引用 ${SIDE_FN_COUNT} 处（应有定义 + 4 个调用点）"; fi

echo
echo "== drill：drill_signature_sidecar / drill_build_restore_args =="
got="$(drill_signature_sidecar "${SD}/vanblog-full-20260920-1000.tar.zst")"
assert_eq "$(basename "${got}")" "vanblog-full-20260920-1000.tar.zst.sig" ".sig 存在时 drill_signature_sidecar 输出它的路径"
rm -f "${SD}/vanblog-full-20260920-1000.tar.zst.sig"
got2="$(drill_signature_sidecar "${SD}/vanblog-full-20260920-1000.tar.zst")"
assert_eq "${got2}" "" ".sig 不存在时输出空（⇒ 恢复时不带 signature 字段）"
: >"${SD}/vanblog-full-20260920-1000.tar.zst.sig"   # 还原，后面的用例还要用

drill_build_restore_args "/a/vanblog-full-X.tar.zst" "vanblog-full-X.tar.zst" "/tmp/k.key" "/a/vanblog-full-X.tar.zst.sig"
joined="$(printf '%s\n' "${DRILL_RESTORE_ARGS[@]}")"
assert_contains "${joined}" "file=@/a/vanblog-full-X.tar.zst;filename=vanblog-full-X.tar.zst" "组装出 file 字段（含白名单要求的 filename）"
assert_contains "${joined}" "setupKey=</tmp/k.key" "组装出 setupKey，且用 curl 的 <文件 形式（值不进 argv）"
assert_contains "${joined}" "signature=</a/vanblog-full-X.tar.zst.sig" \
  "🔴 组装出 signature，且必须是 <文件 而不是 @文件（服务端把它声明成文本字段，@ 会变成文件字段读不到）"
assert_not_contains "${joined}" "signature=@" "signature 没有误用 @文件 形式"

drill_build_restore_args "/a/vanblog-full-X.tar.zst" "vanblog-full-X.tar.zst" "-" "-"
joined2="$(printf '%s\n' "${DRILL_RESTORE_ARGS[@]}")"
assert_not_contains "${joined2}" "signature=" "没有 .sig 时**不带** signature 字段（服务端按 missing-sig 处理）"
assert_not_contains "${joined2}" "setupKey=" "没有 setup key 时不带 setupKey 字段"
assert_contains "${joined2}" "file=@/a/vanblog-full-X.tar.zst" "只有归档时也照样组装出 file 字段"

drill_build_restore_args "/a/x.tar.zst" "x.tar.zst" "" ""
joined3="$(printf '%s\n' "${DRILL_RESTORE_ARGS[@]}")"
# ⚠️ 第一版在这里数"数组元素个数=1"，那是错的：`-F` 与它的值是**两个**元素。
#    改成直接断言"没有多出字段"—— 这才是要保护的性质（空值不该组装出 signature=<空，那会 400）。
assert_not_contains "${joined3}" "signature=" "空字符串与 - 一样按「没有」处理：不组装 signature 字段"
assert_not_contains "${joined3}" "setupKey=" "空字符串与 - 一样按「没有」处理：不组装 setupKey 字段"
assert_contains "${joined3}" "file=@" "只有归档时仍然组装出 file 字段"

echo
echo "== drill：drill_classify_signature_outcome（台账结论的归类）=="
assert_eq "$(drill_classify_signature_outcome 200 '{}' 0 1)" "not-applicable" "没带 .sig ⇒ not-applicable（不涉及验签）"
assert_eq "$(drill_classify_signature_outcome 400 '{"message":"签名不匹配"}' 1 1)" "refused-signature" "400 且点名签名 ⇒ refused-signature"
assert_eq "$(drill_classify_signature_outcome 400 '{"message":"signature mismatch"}' 1 1)" "refused-signature" "英文 signature 字样也能认出"
assert_eq "$(drill_classify_signature_outcome 400 '{"message":"归档损坏"}' 1 1)" "refused-other" "400 但原因不是签名 ⇒ refused-other（不能算验签起作用）"
assert_eq "$(drill_classify_signature_outcome 200 '{}' 1 0)" "no-key" "带了 .sig 但没透传公钥 ⇒ no-key（恢复成功不等于验过签）"
assert_eq "$(drill_classify_signature_outcome 200 '{}' 1 1)" "covered" "带了 .sig 且有公钥且 200 ⇒ covered（真验过）"
assert_eq "$(drill_classify_signature_outcome 500 '{}' 1 1)" "inconclusive" "5xx ⇒ inconclusive（不当成通过，也不当成被拒）"
assert_eq "$(drill_classify_signature_outcome 000 '' 1 1)" "inconclusive" "拿不到响应 ⇒ inconclusive"
# 🔴 顺序钉子：400+签名 的判定必须**先于** no-key，否则"没透传公钥"会把一次真实拒绝误报成"没验签"
assert_eq "$(drill_classify_signature_outcome 400 '{"message":"签名不匹配"}' 1 0)" "refused-signature" \
  "顺序：400+签名 即使没透传公钥也归 refused-signature（不能被 no-key 抢走）"
if [[ "$(drill_classify_signature_outcome 400 '{"message":"签名不匹配"}' 1 0)" == "no-key" ]]; then
  fail "上面那条顺序钉子失效了"
else pass "顺序钉子有反证（不是恒真）"; fi

echo
echo "== drill：drill_make_tampered_copy（只在副本上翻字节，且自证篡改生效）=="
BIG="${TEST_DIR}/big.tar.zst"; head -c 20000 /dev/urandom >"${BIG}"
sha_before="$(sha256sum <"${BIG}" | cut -d' ' -f1)"
CP="${TEST_DIR}/tampered.tar.zst"
if drill_make_tampered_copy "${BIG}" "${CP}"; then
  pass "篡改副本造得出来（20000 字节 > 4096 下限）"
  sha_copy="$(sha256sum <"${CP}" | cut -d' ' -f1)"
  sha_after="$(sha256sum <"${BIG}" | cut -d' ' -f1)"
  assert_eq "${sha_after}" "${sha_before}" "🔴 真归档**一个字节都没变**（篡改只发生在副本上）"
  if [[ "${sha_copy}" != "${sha_before}" ]]; then pass "副本确实与原归档不同（篡改真的生效了）"
  else fail "副本与原归档 sha 相同 ⇒ 篡改没生效，这种“被拒”证明不了任何事"; fi
  assert_eq "$(wc -c <"${CP}" | tr -d ' ')" "20000" "副本大小不变（只翻了一个字节，不是截断）"
else fail "drill_make_tampered_copy 对 20000 字节的归档失败了"; fi
rm -f "${CP}"
TINY="${TEST_DIR}/tiny.tar.zst"; head -c 100 /dev/urandom >"${TINY}"
if drill_make_tampered_copy "${TINY}" "${CP}"; then
  fail "小于 4096 字节的文件不该做篡改场景（翻中段没意义）"
else pass "过小的归档被拒绝做篡改副本（宁可跳过也不给假结论）"; fi
[[ -e "${CP}" ]] && fail "拒绝时不该留下副本" || pass "拒绝时没有留下副本"
if drill_make_tampered_copy "${TEST_DIR}/不存在的归档" "${CP}"; then
  fail "源文件不存在时不该成功"; else pass "源文件不存在时返回失败"; fi

echo
echo "== drill：接线与台账（源码级，一律剥注释）=="
DRILL_CODE2="$(no_comments "$(cat "${DRILL}")")"
assert_not_contains "${DRILL_CODE2}" '验签**未被本次演练覆盖**' \
  "🔴 那句已经不成立的台账（“验签未被本次演练覆盖”）已被删掉"
assert_contains "${DRILL_CODE2}" '验签**已被本次演练覆盖**' "台账里改成“已被覆盖”，且只在恢复真的跑完之后才记"
assert_contains "${DRILL_CODE2}" 'drill_classify_signature_outcome "${HTTP_CODE}" "${body}"' \
  "权威结论交给纯函数归类（不是就地写死 if）"
assert_contains "${DRILL_CODE2}" '-F "signature=<${sigfile}"' "组装函数里 signature 用 <文件 形式"
assert_contains "${DRILL_CODE2}" 'http_probe POST "${base}/api/admin/init/restore" "${restore_body}" 3600 "${DRILL_RESTORE_ARGS[@]}"' \
  "🔴 正向恢复真的用了组装出来的参数（含 signature），不是另写一份硬编码的 -F"
# 负向场景必须在正向恢复**之前**（成功恢复后站点就初始化了，匿名接口会 403）
neg_line="$(printf '%s\n' "${DRILL_CODE2}" | grep -n 'tampered-' | head -1 | cut -d: -f1)"
pos_line="$(printf '%s\n' "${DRILL_CODE2}" | grep -n 'restore_body}" 3600 "\${DRILL_RESTORE_ARGS' | head -1 | cut -d: -f1)"
if [[ -n "${neg_line}" && -n "${pos_line}" && "${neg_line}" -lt "${pos_line}" ]]; then
  pass "负向（篡改）场景排在正向恢复之前（否则站点已初始化、匿名接口 403，负向就永远跑不了）"
else fail "负向场景没有排在正向恢复之前（neg=${neg_line:-无} pos=${pos_line:-无}）"; fi
assert_contains "${DRILL_CODE2}" 'drill_make_tampered_copy "${archive}" "${tampered}"' "负向场景用的是篡改副本助手"
assert_contains "${DRILL_CODE2}" 'rm -f "${tampered}" "${tampered_body}"' "篡改副本用完就删（留在 DRILL_TMP 会被后续对账误当成真归档）"
assert_contains "${DRILL_CODE2}" 'refused-other)' "负向场景把“被拒但不是因为签名”单列（那种情况说明副本坏在别处）"
assert_contains "${DRILL_CODE2}" '没有被拒绝' "负向场景对“没被拒”判 fail（这是真缺陷，不是 warn）"
# 前置条件：只在有 .sig 且透传了公钥时才跑负向场景
assert_contains "${DRILL_CODE2}" 'if [[ -n "${drill_sig_file:-}" && "${drill_vkey_passed:-0}" == "1" ]]' \
  "负向场景有前置条件（没公钥时跑它必然“没被拒”，那是条件不具备而不是产品缺陷）"

echo
echo "== drill：--skip-signature-check 不能被静默忽略 =="
assert_contains "${DRILL_CODE2}" '--skip-signature-check)' "drill 显式处理这个 flag（不是落到未知参数分支）"
skip_out="${TEST_DIR}/skip.out"
set +e
timeout 90 bash "${DRILL}" drill --skip-signature-check /nonexistent.tar.zst >"${skip_out}" 2>&1
skip_rc=$?
set -e 2>/dev/null || true
assert_eq "${skip_rc}" "2" "🔴 行为级：drill --skip-signature-check 退出码 2（不是 0 ⇒ 不会被脚本化调用当成成功）"
skip_txt="$(cat "${skip_out}")"
assert_contains "${skip_txt}" '无法兑现' "退出前说清了这个 flag 在演练里无法兑现"
assert_contains "${skip_txt}" '匿名' "说明了原因：演练走匿名接口，而服务端刻意不给它跳过开关"
assert_contains "${skip_txt}" 'restore --skip-signature-check' "给出了能兑现的替代路径（管理员那条）"
assert_not_contains "${skip_txt}" '已忽略' "措辞不是“已忽略”（那会被读成“已生效”）"

echo
echo "== vanblog.sh：verify 的权威五态 =="
for st in ok mismatch key-mismatch missing-sig malformed-sig no-key; do
  lab="$(signature_verdict_label "${st}")"
  if [[ -z "${lab}" ]]; then fail "signature_verdict_label 对 ${st} 返回空"; else pass "五态之一 ${st} 有结论：${lab:0:34}…"; fi
done
assert_contains "$(signature_verdict_label ok)" '验签通过' "ok 明说“验签通过”"
assert_contains "$(signature_verdict_label mismatch)" '被改动过' "mismatch 明说“被改动过、别用它恢复”"
assert_contains "$(signature_verdict_label key-mismatch)" '公钥不是一对' \
  "key-mismatch 明说“归档不一定有问题，是公钥不对”（与 mismatch 的处置完全相反，不能合并）"
assert_contains "$(signature_verdict_label missing-sig)" '从没被签过' "missing-sig 明说“从没被签过”"
assert_contains "$(signature_verdict_label no-key)" '没有真验签' "no-key 明说“这次没有真验签，不等于验过”"
assert_contains "$(signature_verdict_label 没见过这个状态)" '不认识' "未知状态 ⇒ 说“不认识”，绝不当成通过"
for st in mismatch key-mismatch malformed-sig no-key missing-sig; do
  assert_not_contains "$(signature_verdict_label "${st}")" '验签通过' "非 ok 状态的措辞里不含“验签通过”"
done
# 取不到令牌时必须输出空（⇒ 调用方如实说“没有权威结论”），绝不回落成“验过”
( unset VANBLOG_ADMIN_TOKEN
  ensure_admin_token() { printf ''; return 0; }
  vanblog_api_base() { printf 'http://127.0.0.1:1'; return 0; }
  out="$(signature_verdict_from_server "${SD}/vanblog-full-20260920-1000.tar.zst")"
  if [[ -z "${out}" ]]; then echo OK_EMPTY; else echo "GOT:${out}"; fi ) >"${TEST_DIR}/nokey.out"
assert_eq "$(cat "${TEST_DIR}/nokey.out")" "OK_EMPTY" "拿不到令牌时 signature_verdict_from_server 输出空（不假装验过）"
SV_BLOCK="$(no_comments "$(sed -n '/^signature_verdict_from_server()/,/^}/p' "${SCRIPT}")")"
assert_contains "${SV_BLOCK}" '\"deep\":false' "只取签名结论，不要成员级深度校验（deep:false）"
assert_contains "${SV_BLOCK}" 'json_string "${name}"' "归档名走 JSON body 并经转义（不进 URL ⇒ 不进 caddy 访问日志）"
assert_contains "${SV_BLOCK}" '-H "token: ${tok}"' "鉴权头是 token:（token.guard.ts 读的就是这个头）"
assert_not_contains "${SV_BLOCK}" 'full/verify?name=' "没有把归档名放进 query"
VA_BLOCK="$(no_comments "$(sed -n '/^verify_one_archive()/,/^}/p' "${SCRIPT}")")"
assert_contains "${VA_BLOCK}" 'mismatch|key-mismatch|malformed-sig)' \
  "🔴 服务端说 mismatch/key-mismatch/malformed-sig 时进 problems（⇒ 这份归档判 FAIL，不是只记一条 note）"
assert_contains "${VA_BLOCK}" '拿不到服务端权威结论' "取不到权威结论时如实说明，并把上面的结论标成“只是本地推断”"
assert_contains "${VA_BLOCK}" '本地推断：已签名' "本地那条“已签名”明确标成推断（“有 .sig”≠“验过签”）"
assert_contains "${VA_BLOCK}" '本地推断：没有 .sig' "本地那条“没有 .sig”也标成推断"
assert_contains "${VA_BLOCK}" 'if [[ "${VB_VERIFY_SERVER_SIG}" == "1" ]]' "打服务端是显式开关控制的（默认不做 ⇒ 不会让 verify --all 的 I/O 翻倍）"

echo
echo "== vanblog.sh：verify --server-signature 开关与上传恢复的如实说明 =="
assert_contains "$(print_verify_usage 2>&1)" -- "--server-signature" "verify 的用法里写了这个开关"
assert_contains "$(print_verify_usage 2>&1)" '不等于「验过签」' "用法里说清“有 .sig 不等于验过签”"
# ⚠️ 不要用 `bash "${SCRIPT}" verify …` 测这个：整脚本入口有 pre_check（要 root），
#    在本机它会**静默退出 0**，于是"退出码 2"这条永远测不到（第一版就是这样假绿/假红过）。
#    verify() 已经被 source 进来了，直接当函数调，`return 2` 就是它的退出码。
set +e
verify --server-signatur >"${TEST_DIR}/vtypo.out" 2>&1; typo_rc=$?
set -e 2>/dev/null || true
assert_eq "${typo_rc}" "2" "打错的开关 --server-signatur 仍然退出码 2（没有被静默吞掉）"
assert_contains "$(cat "${TEST_DIR}/vtypo.out")" "不认这个参数" "并且明说不认这个参数（不是静默按默认跑）"
set +e
verify --server-signature "${SD}/vanblog-full-20260920-1000.tar.zst" >"${TEST_DIR}/vok.out" 2>&1; ok_rc=$?
set -e 2>/dev/null || true
if [[ "${ok_rc}" == "2" ]]; then fail "--server-signature 被当成未知参数拒了（开关没接上）"
else pass "--server-signature 被接受（退出码 ${ok_rc}，不是用法错误的 2）"; fi
RF_BLOCK="$(no_comments "$(sed -n '/^restore_full_backup()/,/^}/p' "${SCRIPT}")")"
assert_contains "${RF_BLOCK}" 'if [[ ${upload} -eq 1 && -f "${target}.sig" ]]' \
  "上传恢复且本地有 .sig 时会给提示（条件里带 upload=1 ⇒ 按名字恢复不会误报）"
assert_contains "${RF_BLOCK}" 'missing-sig' "提示里点名本次验签状态会是 missing-sig"
assert_contains "${RF_BLOCK}" '没有 signature 字段' "说清了原因：管理员接口没有这个字段（不是脚本忘了带）"
assert_contains "${RF_BLOCK}" '不等于验过签' "提示里明说“不等于验过签”"
assert_contains "${RF_BLOCK}" 'restore $(basename "${target}")' "给出了能真验签的替代做法（按名字恢复）"
assert_contains "${RF_BLOCK}" '在上传恢复这条路上也**没有实际作用**' \
  "--skip-signature-check 在上传恢复里没作用这件事也说了（否则用户以为跳过了什么）"

echo
echo "passed=${PASS} failed=${FAIL} note=${NOTE}"
[[ ${FAIL} -eq 0 ]] || exit 1
exit 0
