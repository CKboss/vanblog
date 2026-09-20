#!/usr/bin/env bash
# scripts/vanblog-drill.sh 的测试：恢复演练（drill）/ 语义化校验（verify-deep）/ 备份即验。
#
# 分两部分：
#   A) 纯逻辑，**不需要容器**（默认全部跑）：JSON 取值器、断言函数（喂真实形状的响应体：
#      成功 / initialized:false / 400 / 403 / 409 / 演示站信封 / counts 对不上 / 缺 themes）、
#      端口与名字选择、podman 的环境变量、trap 清理（成功路径与失败路径都要拆）、
#      语义校验（归档现场用真 tar+zstd/xz/gzip 打，不 mock 压缩器）、验证台账、退出码纪律。
#      编排层用「假引擎 + 假 HTTP 服务」跑通整条 cmd_drill（有 python3 时）。
#   B) 活体（需要引擎 + 镜像 + 真归档）：默认**跳过并说明原因**；
#      VANBLOG_DRILL_LIVE=1 时才真起一次性容器跑完整演练。
#
# ⚠️ 退出码断言一律 `cmd >out 2>&1; rc=$?`（或 ${PIPESTATUS[0]}），
#    绝不写 `cmd | tail; echo $?` —— 那拿到的是 tail 的退出码，这个仓库已经这么"假绿"过三次。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog-drill.sh"
MAIN="${ROOT}/scripts/vanblog.sh"
PUBLIC_MAIN="${ROOT}/docs/.vuepress/public/vanblog.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
skip() { echo "SKIP: $*"; }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_ne() { if [[ "$1" != "$2" ]]; then pass "$3"; else fail "$3 (both '$1')"; fi; }
# printf + grep -q：grep 命中就提前退出，大文本会写出 broken pipe 噪音，stderr 要压掉
assert_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }
assert_not_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then fail "$3 (unexpected: $2)"; else pass "$3"; fi; }
assert_rc() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (rc=$1, want $2)"; fi; }
# 子进程调用 CLI：⚠️ 必须把 VANBLOG_DRILL_SKIP_MAIN 摘掉。它是给 source 用的开关，而这里是
# export 出去的 ⇒ 子进程 source 完就直接 exit 0、一个字都不打印，于是"退出码 0"和
# "输出里没有 FAIL"全都假绿（本轮真踩过：CLI 用例整片 rc=0 且输出为空）。
run_cli() { env -u VANBLOG_DRILL_SKIP_MAIN bash "${SCRIPT}" "$@"; }
run_main() { env -u VANBLOG_DRILL_SKIP_MAIN bash "${MAIN}" "$@"; }
# 数输出里有几条某种判定：断言函数在 $(…) 里跑时计数器留在子 shell（同一个坑的另一种形状），
# 所以要么数输出，要么在当前 shell 里直接调（下面两种都有）
n_kind() { printf '%s\n' "$1" | grep -c "^  $2" || true; }

echo "== vanblog-drill.sh：恢复演练 / 语义校验 / 备份即验 =="

for tool in tar zstd gzip sha256sum curl awk; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "本机没有 ${tool}，没法真跑这个套件"
    echo "passed=0 failed=1"
    exit 1
  fi
done

if [[ ! -f "${SCRIPT}" ]]; then
  echo "找不到 ${SCRIPT}"
  echo "passed=0 failed=1"
  exit 1
fi

TEST_DIR="$(mktemp -d)"
cleanup_test() {
  [[ -n "${FAKE_SRV_PID:-}" ]] && kill "${FAKE_SRV_PID}" >/dev/null 2>&1 || true
  rm -rf "${TEST_DIR}" >/dev/null 2>&1 || true
}
trap cleanup_test EXIT

BASE="${TEST_DIR}/var/vanblog"
DATA="${BASE}/data"
BK="${DATA}/log/vanblog-backups"
mkdir -p "${BK}" "${DATA}/data/static/img" "${DATA}/data/mongo"

export VANBLOG_DRILL_SKIP_MAIN=1
export VANBLOG_BASE_PATH="${BASE}"
export VANBLOG_DATA_PATH="${DATA}"
export VANBLOG_BACKUP_DIR="${BK}"
# ⚠️ 关掉颜色：断言用 grep -F 字面匹配，而脚本输出里 `语义 WARN` 与后面的正文之间夹着
#    转义码（\033[0m），字面量对不上就会"看着有、其实匹配不到"（本轮 98 条假红大半是这个）
export VANBLOG_NO_COLOR=1
# ⚠️ 记住本机的 podman 存储位置再 unset：纯逻辑用例不能被本机环境影响，
#    而活体那一段**必须**用回它（镜像就存在那个 HOME 底下，用真实 HOME 会"看不到镜像"）
SAVED_DRILL_HOME="${VANBLOG_DRILL_HOME:-}"
SAVED_DRILL_TMPDIR="${VANBLOG_DRILL_TMPDIR:-}"
unset VANBLOG_ADMIN_TOKEN VANBLOG_DRILL_ENGINE VANBLOG_DRILL_IMAGE VANBLOG_DRILL_HOME \
  VANBLOG_DRILL_TMPDIR VANBLOG_DRILL_KEEP VANBLOG_DRILL_DRY_RUN VANBLOG_VERIFY_ALLOW_EMPTY ENGINE 2>/dev/null || true
unset -f df du curl docker docker-compose podman git backup 2>/dev/null || true
# shellcheck disable=SC1090
source "${SCRIPT}" >/dev/null 2>&1

if ! declare -f cmd_drill >/dev/null 2>&1; then
  echo "source ${SCRIPT} 之后没有 cmd_drill，脚本加载失败"
  echo "passed=0 failed=1"
  exit 1
fi
pass "脚本可以被 source（VANBLOG_DRILL_SKIP_MAIN=1 时不跑主流程）"
if [[ "${VANBLOG_MAIN_LOADED}" == "1" ]]; then
  pass "复用 vanblog.sh 的实现（颜色/归档工具/备份目录都是同一份，不会漂）"
else
  fail "没有加载 vanblog.sh（语义校验会退化成兜底实现）"
fi

# ── 造归档的帮手：结构照 server 的打包方式（tar -C staging . ⇒ ./manifest.json、
#    ./db/<库>/<集合>.ndjson、./static/<img|file|customPage|themes>/…）──────────
# make_full_archive <dest> [变体…]
#   变体：no-manifest（归档里没有 manifest.json）| version2 | no-themes | with-themes
#         missing-ndjson | empty | bad-totals | bad-name（由调用方给文件名）
make_full_archive() {
  local dest="$1"
  shift
  local variant=" ${*:-} "
  local st="${TEST_DIR}/staging-$$-${RANDOM}"
  mkdir -p "${st}/db/vanBlog" "${st}/db/waline" "${st}/static/img"
  local version=1
  [[ "${variant}" == *" version2 "* ]] && version=2
  local cnt_art=3 cnt_usr=1 cnt_st=2 cnt_cm=1
  if [[ "${variant}" == *" empty "* ]]; then cnt_art=0; cnt_usr=0; cnt_st=0; cnt_cm=0; fi
  if [[ "${variant}" != *" no-manifest "* ]]; then
    local themes_json=""
    if [[ "${variant}" == *" with-themes "* ]]; then
      themes_json=',"themes":{"files":1,"bytes":12}'
    fi
    cat >"${st}/manifest.json" <<EOF
{"kind":"vanblog-full-backup","version":${version},"createdAt":"2026-09-16T01:02:03.000Z","format":"zstd",
"databases":{"vanBlog":{"collections":{"articles":{"count":${cnt_art},"bytes":300,"indexes":4},"users":{"count":${cnt_usr},"bytes":10,"indexes":1},"statics":{"count":${cnt_st},"bytes":20,"indexes":1}}},"waline":{"collections":{"Comment":{"count":${cnt_cm},"bytes":5,"indexes":0}}}},
"static":{"img":{"files":$([[ "${variant}" == *" empty "* ]] && echo 0 || echo 1),"bytes":9}${themes_json}},
"totals":{"databases":2,"collections":4,"documents":$([[ "${variant}" == *" empty "* ]] && echo 0 || echo 7),"files":$([[ "${variant}" == *" empty "* ]] && echo 0 || echo 1),"staticBytes":9,"archiveBytes":1234}}
EOF
    if [[ "${variant}" == *" bad-totals "* ]]; then
      sed -i 's/"documents":7/"documents":999/' "${st}/manifest.json" 2>/dev/null ||
        perl -pi -e 's/"documents":7/"documents":999/' "${st}/manifest.json"
    fi
  fi
  if [[ "${variant}" != *" empty "* ]]; then
    if [[ "${variant}" != *" missing-ndjson "* ]]; then
      printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439011"},"title":"a","deleted":false,"hidden":false,"private":false,"category":"博客"}' \
        '{"_id":{"$oid":"507f1f77bcf86cd799439012"},"title":"b","deleted":true,"category":"博客"}' \
        '{"_id":{"$oid":"507f1f77bcf86cd799439013"},"title":"c","category":"博客"}' >"${st}/db/vanBlog/articles.ndjson"
      printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439021"},"username":"admin"}' >"${st}/db/vanBlog/users.ndjson"
      printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439031"},"name":"博客","private":false}' >"${st}/db/vanBlog/categories.ndjson"
      printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439041"},"staticType":"img","realPath":"/static/img/a.webp"}' \
        '{"_id":{"$oid":"507f1f77bcf86cd799439042"},"staticType":"img","realPath":"/static/img/b.webp"}' >"${st}/db/vanBlog/statics.ndjson"
      printf '%s\n' '{"x":1}' >"${st}/db/waline/Comment.ndjson"
      echo '[]' >"${st}/db/vanBlog/articles.indexes.json"
    else
      # 清单声明了 4 个集合，只放 2 个 .ndjson ⇒ 恢复会跳过缺的那些（notes 里记一条）
      printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439011"},"title":"a"}' >"${st}/db/vanBlog/articles.ndjson"
      printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439021"},"username":"admin"}' >"${st}/db/vanBlog/users.ndjson"
    fi
    echo "fakeimg" >"${st}/static/img/a.webp"
    if [[ "${variant}" == *" with-themes "* ]]; then
      mkdir -p "${st}/static/themes"
      echo '.skin{color:red}' >"${st}/static/themes/1-abcd1234.css"
    fi
  fi
  case "${dest}" in
  *.tar.zst) (cd "${st}" && tar -cf - .) | zstd -19 --long=27 -q -o "${dest}" ;;
  *.tar.gz) (cd "${st}" && tar -cf - .) | gzip -9 >"${dest}" ;;
  *) (cd "${st}" && tar -cf - .) | zstd -q -o "${dest}" ;;
  esac
  local rc=$?
  rm -rf "${st}"
  return ${rc}
}

GOOD="${BK}/vanblog-full-20260916-010101.tar.zst"
make_full_archive "${GOOD}"
if [[ ! -s "${GOOD}" ]]; then
  echo "造不出测试归档，后面的用例没意义"
  echo "passed=${PASS} failed=1"
  exit 1
fi

# ══════════════════════════ A1) JSON 取值器 ══════════════════════════
echo
echo "-- JSON 取值器（不依赖 jq / python3）--"
OK_BODY='{"statusCode":200,"data":{"restoredAt":"2026-09-16T02:03:04.500Z","seconds":3.8,"databases":{"vanBlog":{"collections":13,"documents":9832},"waline":{"collections":2,"documents":6}},"static":{"img":{"files":182}},"backupCreatedAt":"2026-09-13T10:19:37.023Z","notes":["建议重启 server 进程","恢复后需要重新登录后台"],"counts":{"articles":59,"statics":93,"users":1,"visits":8747,"viewers":796,"settings":7,"total":9838},"adminUserFromArchive":true,"initialized":true,"needsRestartForPipelineDeps":false}}'
assert_eq "$(json_get "${OK_BODY}" statusCode)" "200" "取顶层 statusCode"
assert_eq "$(json_get "${OK_BODY}" data.seconds)" "3.8" "取小数（不会被削成 8）"
assert_eq "$(json_get "${OK_BODY}" data.initialized)" "true" "取布尔"
assert_eq "$(json_get "${OK_BODY}" data.counts.articles)" "59" "取嵌套 counts.articles"
assert_eq "$(json_get "${OK_BODY}" data.databases.vanBlog.documents)" "9832" "取 databases.vanBlog.documents"
assert_eq "$(json_get "${OK_BODY}" data.restoredAt)" "2026-09-16T02:03:04.500Z" "ISO 时间戳不会被冒号削掉"
assert_eq "$(json_len "${OK_BODY}" data.notes)" "2" "数组长度"
assert_eq "$(json_keys "${OK_BODY}" data.databases | tr '\n' ',')" "vanBlog,waline," "列对象的键"
assert_eq "$(json_get "${OK_BODY}" data.nope.deep)" "" "不存在的路径给空，不报错"
TRICKY='{"a":"正文里有 { 花括号、\"转义引号\" 和 , 逗号","n":7,"arr":[1,2,{"k":"v"}]}'
assert_eq "$(json_get "${TRICKY}" a)" '正文里有 { 花括号、"转义引号" 和 , 逗号' "字符串里的花括号/逗号/转义引号不会骗到扫描器"
assert_eq "$(json_get "${TRICKY}" n)" "7" "花括号字符串之后的键仍然取得到"
assert_eq "$(json_len "${TRICKY}" arr)" "3" "数组里嵌套对象也算一个元素"
PRETTY="$(printf '{\n  "kind": "vanblog-full-backup",\n  "version": 1,\n  "totals": {"documents": 7}\n}')"
assert_eq "$(json_get "${PRETTY}" kind)" "vanblog-full-backup" "多行美化的 JSON 也读得动（清单就是这种形状）"
assert_eq "$(json_get "${PRETTY}" version)" "1" "多行 JSON 取数字"

# ══════════════════════════ A2) 断言函数：喂真实形状的响应体 ══════════════════════════
echo
echo "-- 断言函数（成功 / initialized:false / 400 / 403 / 409 / 演示站 / counts 不符 / 缺 themes）--"
MANIFEST_OK='{"kind":"vanblog-full-backup","version":1,"createdAt":"2026-09-13T10:19:37.023Z","databases":{"vanBlog":{"collections":{"articles":{"count":59},"users":{"count":1}}},"waline":{"collections":{"Comment":{"count":3}}}},"static":{"img":{"files":182}},"totals":{"databases":2,"collections":3,"documents":63,"files":182}}'

assert_reset
OUT="$(drill_assert_restore_envelope 201 "${OK_BODY}" "${MANIFEST_OK}" 5 "65.9 MB" 2>&1)"
RC=$?
assert_rc "${RC}" "0" "成功信封：断言函数返回 0"
assert_eq "${ASSERT_FAIL}" "0" "成功信封：没有 FAIL"
assert_contains "${OUT}" "恢复接口返回 HTTP 201" "报了 HTTP 201"
assert_contains "${OUT}" "信封 statusCode=200" "报了信封 statusCode"
assert_contains "${OUT}" "恢复后站点已初始化" "报了 data.initialized"
assert_contains "${OUT}" "后台账号来自归档" "报了 adminUserFromArchive"
assert_contains "${OUT}" "counts.articles > 0" "报了 counts.articles"
assert_contains "${OUT}" "信封 counts.articles 与归档清单一致" "信封与清单对了账"
assert_contains "${OUT}" "清单自洽：Σ集合条数 == totals.documents" "清单自洽性对了账"
assert_contains "${OUT}" "恢复真的写进了文档" "确认了 data.databases 里真有文档"
assert_contains "${OUT}" "63" "Σ集合条数算对了（59+1+3）"
# notes 是提醒（"建议重启"/"重新登录"），不是故障 ⇒ 不该 WARN
assert_eq "$(n_kind "${OUT}" WARN)" "0" "成功恢复的两条提醒不算 WARN（否则每次演练都顶着 WARN，看的人会忽略它）"
assert_contains "${OUT}" "server 给了 2 条提醒" "提醒被如实报出来（NOTE）"

NOINIT_BODY='{"statusCode":200,"data":{"seconds":1.1,"databases":{"vanBlog":{"collections":13,"documents":9832}},"notes":[],"counts":{"articles":59,"statics":93,"users":0,"total":9838},"adminUserFromArchive":false,"initialized":false}}'
MANIFEST_NOUSERS='{"kind":"vanblog-full-backup","version":1,"databases":{"vanBlog":{"collections":{"articles":{"count":59},"users":{"count":0}}}},"totals":{"documents":59}}'
assert_reset
OUT="$(drill_assert_restore_envelope 201 "${NOINIT_BODY}" "${MANIFEST_NOUSERS}" 2 "?" 2>&1)"
RC=$?
assert_rc "${RC}" "0" "归档里没有 users ⇒ initialized:false 是**合法**结果，不判失败"
assert_eq "$(n_kind "${OUT}" WARN)" "2" "initialized:false 与 adminUserFromArchive:false 各记一条 WARN"
assert_contains "${OUT}" "WARN" "输出里明说是 WARN 而不是 FAIL"
assert_contains "${OUT}" "没有管理员账号" "解释了为什么没初始化（用户看到就知道该换带 users 的归档）"

BAD400='{"statusCode":400,"message":"读不出这个备份的清单：文件损坏/不完整，或不是本功能导出的整站备份"}'
assert_reset
OUT="$(drill_assert_restore_envelope 400 "${BAD400}" "${MANIFEST_OK}" 1 "?" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "400 → 返回 1"
assert_contains "${OUT}" "FAIL" "400 记成 FAIL"
assert_contains "${OUT}" "归档被拒" "400 附带了原因清单（没有文件/文件名/清单/成员/解压器/版本）"

BAD403='{"statusCode":403,"message":"站点已经初始化过了：这条接口只对全新站点开放，请登录后到「备份与恢复」里恢复"}'
assert_reset
OUT="$(drill_assert_restore_envelope 403 "${BAD403}" "${MANIFEST_OK}" 1 "?" 2>&1)"
assert_rc "$?" "1" "403 → 返回 1"
assert_contains "${OUT}" "站点已初始化" "403 说清了含义（演练必须在空库上跑）"

BAD409='{"statusCode":409,"message":"已经有一个恢复正在进行，请等它结束（完成后刷新页面即可进入后台）"}'
assert_reset
OUT="$(drill_assert_restore_envelope 409 "${BAD409}" "${MANIFEST_OK}" 1 "?" 2>&1)"
assert_rc "$?" "1" "409 → 返回 1"
assert_contains "${OUT}" "单飞锁" "409 说明了是单飞锁"

DEMO='{"statusCode":401,"message":"演示站禁止修改此项！"}'
assert_reset
OUT="$(drill_assert_restore_envelope 200 "${DEMO}" "${MANIFEST_OK}" 1 "?" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "演示站信封（HTTP 200 + statusCode 401）判失败"
assert_contains "${OUT}" "演示站" "点名了这是演示站守卫"
assert_contains "${OUT}" "恢复**没有发生**" "说清了「HTTP 200 但什么都没做」这个陷阱"

MISMATCH='{"statusCode":200,"data":{"seconds":2,"databases":{"vanBlog":{"collections":13,"documents":10}},"notes":[],"counts":{"articles":7,"statics":1,"users":1,"total":10},"adminUserFromArchive":true,"initialized":true}}'
assert_reset
OUT="$(drill_assert_restore_envelope 201 "${MISMATCH}" "${MANIFEST_OK}" 2 "?" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "counts 与清单不符 → 返回 1"
assert_contains "${OUT}" "信封 7 vs 清单 59" "对不上时把两个数字都打出来（接口说的 vs 归档写的）"

EMPTYDOCS='{"statusCode":200,"data":{"seconds":0.1,"databases":{"vanBlog":{"collections":0,"documents":0}},"notes":[],"counts":{"articles":0,"statics":0,"users":0,"total":0},"adminUserFromArchive":false,"initialized":false}}'
assert_reset
OUT="$(drill_assert_restore_envelope 201 "${EMPTYDOCS}" "${MANIFEST_NOUSERS}" 1 "?" 2>&1)"
assert_rc "$?" "1" "一条文档都没写进去 → 返回 1"
assert_contains "${OUT}" "counts.articles > 0" "articles=0 被点名"
assert_contains "${OUT}" "一条都没写进去" "data.databases 全 0 被点名"

MANIFEST_ONEUSER='{"kind":"vanblog-full-backup","version":1,"databases":{"vanBlog":{"collections":{"articles":{"count":59},"users":{"count":1}}}},"totals":{"documents":60}}'
MISSINGNOTES='{"statusCode":200,"data":{"seconds":1,"databases":{"vanBlog":{"collections":1,"documents":59}},"notes":["集合 pipelines 的 .ndjson 缺失，已跳过"],"counts":{"articles":59,"statics":0,"users":1,"total":59},"adminUserFromArchive":true,"initialized":true}}'
assert_reset
OUT="$(drill_assert_restore_envelope 201 "${MISSINGNOTES}" "${MANIFEST_ONEUSER}" 1 "?" 2>&1)"
assert_eq "$(n_kind "${OUT}" WARN)" "1" "notes 里提到「缺失/跳过」才算 WARN"
assert_contains "${OUT}" "恢复 notes 里没有数据缺失" "缺数据的 note 被升级成 WARN（不是提醒）"

# --- meta ---
META_233='{"statusCode":233,"message":"未初始化!"}'
META_REAL='{"statusCode":200,"data":{"version":"local@d3685180","tags":["Life"],"totalArticles":53,"meta":{"siteInfo":{"siteName":"我的博客","author":"someone"}}}}'
assert_reset
OUT="$(drill_assert_meta 200 "${META_233}" 53 2>&1)"
assert_rc "$?" "1" "meta 还是 233 信封 → 判失败"
assert_contains "${OUT}" "数据没恢复进去" "233 的含义说清了"
assert_reset
OUT="$(drill_assert_meta 200 "${META_REAL}" 53 2>&1)"
RC=$?
assert_rc "${RC}" "0" "真实站点 meta → 通过"
assert_contains "${OUT}" "siteName=我的博客" "读出了站点名（路径是 data.meta.siteInfo.siteName）"
assert_contains "${OUT}" "meta.totalArticles 与归档对得上" "用 meta.totalArticles 做了第二重交叉验证"
assert_reset
OUT="$(drill_assert_meta 200 "${META_REAL}" 40 2>&1)"
assert_rc "$?" "1" "meta.totalArticles 与归档算出的公开文章数不符 → 判失败"
assert_reset
OUT="$(drill_assert_meta 500 "${META_REAL}" 53 2>&1)"
assert_rc "$?" "1" "meta HTTP 500 → 判失败"

# --- 文章列表 total ---
EXPECT_LINE="total=59 public=53 loose=53 deleted=6 hidden=0 private=0 inprivcat=0"
assert_reset
OUT="$(drill_assert_article_total 53 "${EXPECT_LINE}" 59 200 2>&1)"
assert_rc "$?" "0" "站点 total 与归档算出的公开文章数一致 → 通过"
assert_contains "${OUT}" "站点 53 == 归档算出的公开文章数 53" "把两边的数字都打出来"
assert_reset
OUT="$(drill_assert_article_total 0 "${EXPECT_LINE}" 59 200 2>&1)"
assert_rc "$?" "1" "站点 0 篇（归档有 53 篇公开）→ 判失败"
assert_contains "${OUT}" "前台是空的" "0 篇的后果说清了"
assert_reset
OUT="$(drill_assert_article_total 41 "${EXPECT_LINE}" 59 200 2>&1)"
assert_rc "$?" "1" "数量对不上 → 判失败"
assert_reset
OUT="$(drill_assert_article_total "" "${EXPECT_LINE}" 59 500 2>&1)"
assert_rc "$?" "1" "读不出 total → 判失败（并带上 HTTP 码）"
assert_reset
OUT="$(drill_assert_article_total 55 "total=59 public=53 loose=55 deleted=4 hidden=2 private=0 inprivcat=2" 59 200 2>&1)"
assert_eq "$(n_kind "${OUT}" WARN)" "1" "站点数等于「不扣私密分类」的那一种口径 → WARN 而不是 FAIL（两边口径可能不同）"

# --- 静态文件 ---
assert_reset
OUT="$(drill_assert_static_fetch "/static/img/a.webp" 200 823370 2>&1)"
assert_rc "$?" "0" "静态文件 200 且非空 → 通过"
assert_contains "${OUT}" "823370 字节" "报出了取到的字节数"
assert_reset
OUT="$(drill_assert_static_fetch "/static/img/a.webp" 200 0 2>&1)"
assert_rc "$?" "1" "200 但 0 字节 → 判失败（文件恢复了却是空的）"
assert_reset
OUT="$(drill_assert_static_fetch "/static/img/a.webp" 404 0 2>&1)"
assert_rc "$?" "1" "404 → 判失败（静态树没恢复出来）"
assert_reset
OUT="$(drill_assert_static_fetch "" "" "" 2>&1)"
assert_rc "$?" "0" "归档里没有静态成员 → WARN 而不是 FAIL（空站点属正常）"
assert_eq "$(n_kind "${OUT}" WARN)" "1" "空站点那条记成 WARN"

# --- 主题（那个"主题 CSS 从来不进备份"的回归）---
THEMES_MEMBERS='static/themes/1-abcd1234.css
static/themes/2-ef567890.css'
ACTIVE_UPLOADED='{"statusCode":200,"data":{"name":"my-skin","url":"/static/themes/1-abcd1234.css","hash":"abcd1234"}}'
ACTIVE_BUILTIN='{"statusCode":200,"data":{"name":"apple","url":"","hash":""}}'
assert_reset
OUT="$(drill_assert_themes "${THEMES_MEMBERS}" "${ACTIVE_UPLOADED}" 200 4096 "/static/themes/1-abcd1234.css" 200 4096 2>&1)"
RC=$?
assert_rc "${RC}" "0" "归档有 themes + 文件取得到 + theme.css 200 → 通过"
assert_contains "${OUT}" "归档里的主题 CSS 文件取得到" "探了归档里那个具体文件"
assert_contains "${OUT}" "/api/public/theme.css 返回真 CSS" "也探了稳定地址"
assert_reset
OUT="$(drill_assert_themes "${THEMES_MEMBERS}" "${ACTIVE_UPLOADED}" 204 0 "/static/themes/1-abcd1234.css" 404 0 2>&1)"
RC=$?
assert_rc "${RC}" "1" "元数据在、CSS 文件不在（theme.css 204）→ 判失败：这正是那个回归"
assert_contains "${OUT}" "主题不进备份" "点名了是哪个回归"
assert_contains "${OUT}" "静默" "说清了它是静默失败（前台退回默认皮肤、零报错）"
assert_reset
OUT="$(drill_assert_themes "" "${ACTIVE_BUILTIN}" "" "" "" "" "" 2>&1)"
RC=$?
assert_rc "${RC}" "0" "归档没有 themes 且生效的是内置主题 → 只是 NOTE，不判失败"
assert_eq "$(n_kind "${OUT}" "·")" "1" "记了一条 NOTE（不判成败，但必须说出来）"
assert_contains "${OUT}" "早于" "明说这份归档早于主题备份修复（不静默通过）"
assert_contains "${OUT}" "上传的主题会丢" "说清了后果"
assert_reset
OUT="$(drill_assert_themes "" "${ACTIVE_UPLOADED}" 204 0 "" 204 0 2>&1)"
RC=$?
assert_rc "${RC}" "1" "归档没有 themes、恢复后却有生效的上传主题 → 判失败（元数据回来了、文件没有）"
assert_contains "${OUT}" "主题在但样式没了" "描述了用户实际看到的现象"
assert_reset
OUT="$(drill_assert_themes "${THEMES_MEMBERS}" "${ACTIVE_BUILTIN}" 204 0 "/static/themes/1-abcd1234.css" 200 4096 2>&1)"
assert_rc "$?" "0" "文件都回来了、当前生效的是内置主题 → 通过 + 一条说明（theme.css 204 此时是正常的）"
assert_contains "${OUT}" "内置主题" "说明了为什么 theme.css 是 204 也算过"

# --- 日志扫描 ---
LOGF="${TEST_DIR}/app.log"
printf 'server started\n整站恢复触发全量渲染\n' >"${LOGF}"
assert_reset
OUT="$(drill_assert_logs "${LOGF}" 2>&1)"
assert_rc "$?" "0" "干净日志 → 通过"
# 计数器本身也要对：这一组在**当前 shell** 里调（不经过命令替换），所以全局计数器可信
assert_reset
rec_pass "甲" ""
rec_warn "乙" ""
rec_note "丙" ""
rec_fail "丁" ""
assert_eq "${ASSERT_PASS}" "1" "计数器：PASS"
assert_eq "${ASSERT_WARN}" "1" "计数器：WARN"
assert_eq "${ASSERT_NOTE}" "1" "计数器：NOTE"
assert_eq "${ASSERT_FAIL}" "1" "计数器：FAIL"
assert_eq "${#ASSERT_LOG[@]}" "4" "台账里四条都在（「跑了哪些断言」要能列出来）"
printf 'Error: Unsupported BSON version, bson types must be from bson 6.x.x\n' >>"${LOGF}"
assert_reset
OUT="$(drill_assert_logs "${LOGF}" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "日志里有 Unsupported BSON version → 判失败（整站恢复 400 那个 bug 的指纹）"
assert_contains "${OUT}" "Unsupported BSON version" "把命中的模式打出来"
assert_contains "${OUT}" "bson types must be from bson 6.x.x" "把命中的原文也打出来（排障要看得见）"
assert_reset
drill_assert_logs "${TEST_DIR}/nope.log" >/dev/null 2>&1
assert_eq "${ASSERT_WARN}" "1" "拿不到日志文件 → WARN（不假装扫过了）"

# --- 第二次恢复必须 403 ---
assert_reset
OUT="$(drill_assert_second_restore 403 "${BAD403}" 2>&1)"
assert_rc "$?" "0" "已初始化后第二次恢复被 403 挡住 → 通过"
assert_reset
OUT="$(drill_assert_second_restore 201 "${OK_BODY}" 2>&1)"
assert_rc "$?" "1" "第二次恢复又成功了（201）→ 判失败：匿名接口少了「只在未初始化时开放」这道闸"
assert_reset
OUT="$(drill_assert_second_restore 500 "${BAD400}" 2>&1)"
assert_eq "$(n_kind "${OUT}" WARN)" "1" "意料之外的码（500）→ WARN"

# --- 不安全成员 ---
assert_eq "$(drill_find_unsafe_member './manifest.json
./db/vanBlog/articles.ndjson
./static/img/a.webp')" "" "正常成员表里没有越界成员"
assert_eq "$(drill_find_unsafe_member './manifest.json
../etc/passwd')" "../etc/passwd" "抓到 .. 段"
assert_eq "$(drill_find_unsafe_member '/etc/passwd
./manifest.json')" "/etc/passwd" "抓到绝对路径"
assert_contains "$(drill_find_unsafe_member './a
C:\evil\x')" 'C:\evil\x' "抓到 Windows 盘号"

# ══════════════════════════ A3) 期望公开文章数（不能用 grep 数）══════════════════════
echo
echo "-- 从归档 NDJSON 算「前台应该有多少篇文章」--"
ARTS='{"title":"普通文章","deleted":false,"hidden":false,"private":false,"category":"博客"}
{"title":"已删除","deleted":true,"category":"博客"}
{"title":"隐藏","hidden":true,"category":"博客"}
{"title":"私密","private":true,"category":"博客"}
{"title":"讲 JSON 的文章","content":"示例：{\"deleted\":true,\"hidden\":true} 这样的字面量","deleted":false,"category":"博客"}
{"title":"没有这些字段","category":"私密分类"}
{"title":"私密分类里的公开文章","deleted":false,"category":"私密分类"}'
CATS='{"name":"博客","private":false}
{"name":"私密分类","private":true}'
LINE="$(drill_expected_articles "${ARTS}" "${CATS}")"
assert_contains "${LINE}" "total=7" "数出了总条数"
assert_contains "${LINE}" "deleted=1" "扣掉了 deleted:true"
assert_contains "${LINE}" "hidden=1" "扣掉了 hidden:true"
assert_contains "${LINE}" "private=1" "扣掉了 private:true"
assert_contains "${LINE}" "inprivcat=2" "扣掉了私密分类里的两篇（分类表必须先读，否则这里是 0）"
assert_contains "${LINE}" "public=2" "严格公开数 = 2（普通那篇 + 讲 JSON 的那篇）"
# ⚠️ 这条是整个判据存在的理由：正文里出现 "deleted":true 字面量的文章**不能**被当成已删除
assert_eq "$(drill_expected_articles '{"title":"讲 JSON","content":"{\"deleted\":true}","deleted":false}' '' | grep -oE 'public=[0-9]+')" "public=1" \
  "正文里有 \"deleted\":true 字面量的文章不被误判（用 grep 数就会错）"

# ══════════════════════════ A4) 端口 / 名字 / 引擎环境 ══════════════════════════
echo
echo "-- 端口选择、名字冲突、podman 环境变量 --"
# 用桩函数造出"某些端口已被占用"的现场（比真去 bind 端口稳，也不碰本机在跑的东西）
STUB_BUSY=""
drill_port_listening() { [[ ",${STUB_BUSY}," == *",$1,"* ]]; }
drill_port_connectable() { return 1; }
drill_port_ephemeral() { return 1; }
DRILL_TAKEN_PORTS=""
PICKED_PORT=""
drill_pick_free_port 19000 5
assert_eq "${PICKED_PORT}" "19000" "第一个空闲端口就是起点"
drill_pick_free_port 19000 5
assert_eq "${PICKED_PORT}" "19001" "同一次运行里不会挑到同一个端口（HTTP 与 mongo 必须不同）"
STUB_BUSY="19000,19001,19002"
DRILL_TAKEN_PORTS=""
drill_pick_free_port 19000 5
assert_eq "${PICKED_PORT}" "19003" "跳过正在监听的端口"
DRILL_TAKEN_PORTS=""
STUB_BUSY="19000,19001,19002,19003,19004"
if drill_pick_free_port 19000 5; then
  fail "整段窗口都被占时应该挑不出端口"
else
  pass "整段窗口都被占时返回非 0（调用方会明确报错，而不是随便挑一个）"
fi
STUB_BUSY=""
drill_port_ephemeral() { [[ "$1" -ge 32768 && "$1" -le 60999 ]]; }
DRILL_TAKEN_PORTS=""
drill_pick_free_port 32768 3
assert_eq "${PICKED_PORT}" "32768" "整段都在临时端口区间时放宽（并打印说明），否则一个都挑不出来"
drill_port_ephemeral() { return 1; }
drill_port_listening() { return 1; }
# 端口有效性
DRILL_TAKEN_PORTS=""
if drill_port_free 80; then fail "80 应该判为不可用（<1024 rootless 绑不上，挑了也白挑）"; else pass "80 判为不可用（<1024 rootless 绑不上）"; fi
if drill_port_free 27017; then
  pass "27017 在本机没被监听时可以被判为空闲（演练另有硬护栏拒绝它）"
else
  pass "27017 在本机被占用 ⇒ 判为不可用（开发库就在这儿）"
fi
drill_port_free "abc" && fail "非数字端口应该判为不可用" || pass "非数字端口判为不可用"
drill_port_free 99999 && fail "超出 65535 应该判为不可用" || pass "超出范围的端口判为不可用"

# 名字
SUF1="$(drill_make_suffix)"
assert_contains "${SUF1}" "$$" "一次性资源名字里带 PID"
assert_ne "$(drill_make_suffix)" "$(drill_make_suffix)" "两次生成的后缀不同（撞名的概率压到最低）"

# 引擎探测
OUT="$(DRILL_ENGINE="bash" drill_detect_engine)"
assert_eq "${OUT}" "bash" "--engine/VANBLOG_DRILL_ENGINE 指定的引擎只要在 PATH 里就用它"
if DRILL_ENGINE="definitely-not-an-engine-xyz" drill_detect_engine >/dev/null 2>&1; then
  fail "指定一个不存在的引擎应该失败"
else
  pass "指定一个不存在的引擎会失败（不会静默换成别的引擎）"
fi
DRILL_ENGINE=""
OUT="$(drill_detect_engine 2>/dev/null)"
RC=$?
case "${OUT}" in
docker | podman) pass "自动探测到引擎：${OUT}" ;;
"") if [[ ${RC} -ne 0 ]]; then pass "本机没有可用引擎时探测失败（rc=${RC}），演练会明确报错而不是硬跑"; else fail "探测没给出引擎却返回 0"; fi ;;
*) fail "自动探测给出了不认识的东西：${OUT}" ;;
esac

# podman 的环境变量（XDG_RUNTIME_DIR / HOME / TMPDIR）
OUT="$(unset XDG_RUNTIME_DIR; export VANBLOG_DRILL_TMPDIR="${TEST_DIR}/tdir"; drill_export_engine_env podman >/dev/null 2>&1; echo "XDG=${XDG_RUNTIME_DIR}"; echo "CREATED=${DRILL_XDG_CREATED}")"
assert_contains "${OUT}" "XDG=${TEST_DIR}/tdir/vanblog-drill-xdg-" "podman 且 XDG_RUNTIME_DIR 缺失时，在 TMPDIR 下建一个并导出（cron/CI 里 rootless podman 没它起不来）"
assert_contains "${OUT}" "CREATED=${TEST_DIR}/tdir/vanblog-drill-xdg-" "记下了自己建的目录（退出时删掉，不留垃圾）"
if ls -d "${TEST_DIR}"/tdir/vanblog-drill-xdg-* >/dev/null 2>&1; then
  pass "那个 XDG 目录真的建出来了"
else
  fail "XDG 目录没建出来"
fi
mkdir -p "${TEST_DIR}/keepme"
OUT="$(export XDG_RUNTIME_DIR="${TEST_DIR}/keepme"; drill_export_engine_env podman >/dev/null 2>&1; echo "${XDG_RUNTIME_DIR}")"
assert_eq "${OUT}" "${TEST_DIR}/keepme" "已经有可用的 XDG_RUNTIME_DIR 就不动它"
ORIG_HOME="${HOME}"
OUT="$(export VANBLOG_DRILL_HOME="${TEST_DIR}/phome"; drill_export_engine_env podman >/dev/null 2>&1; echo "${HOME}")"
assert_eq "${OUT}" "${TEST_DIR}/phome" "VANBLOG_DRILL_HOME 显式给了才换 HOME（本机把镜像存储放在仓库里时用）"
OUT="$(HOME="${ORIG_HOME}" drill_export_engine_env docker >/dev/null 2>&1; echo "${HOME}")"
assert_eq "${OUT}" "${ORIG_HOME}" "docker 引擎不碰 HOME"
assert_not_contains "$(HOME="${ORIG_HOME}" drill_export_engine_env docker 2>&1; echo "${HOME}")" "${TEST_DIR}/phome" "不指定 VANBLOG_DRILL_HOME 时绝不悄悄换 HOME（换了就等于「用户明明有镜像、脚本却说找不到」）"

# ══════════════════════════ A5) trap 清理（成功与失败都要拆）══════════════════════
echo
echo "-- 清理：只拆自己创建的，--keep 时留着 --"
FAKE_BIN="${TEST_DIR}/bin"
mkdir -p "${FAKE_BIN}"
FAKE_LOG="${TEST_DIR}/engine-calls.log"
cat >"${FAKE_BIN}/fakeengine" <<'STUB'
#!/usr/bin/env bash
echo "fakeengine $*" >> "${FAKE_ENGINE_LOG}"
case "$1" in
  --version) echo "fakeengine version 9.9.9 (stub)" ;;
  info) exit 0 ;;
  image) [[ "$2" == "inspect" ]] && { [[ "${FAKE_NO_IMAGE:-0}" == "1" ]] && exit 1; exit 0; } ;;
  inspect)
    case "$*" in
      *"--type container"*) [[ "${FAKE_COLLIDE:-}" != "" && "$*" == *"${FAKE_COLLIDE}"* ]] && exit 0; exit 1 ;;
      *) echo "10.99.0.7"; exit 0 ;;
    esac ;;
  volume|network) [[ "$2" == "inspect" ]] && exit 1; exit 0 ;;
  run) echo "fakecontainerid"; exit 0 ;;
  exec) echo "1"; exit 0 ;;
  logs) echo "server started ok" ;;
  rm|pull) exit 0 ;;
esac
exit 0
STUB
chmod +x "${FAKE_BIN}/fakeengine"
export FAKE_ENGINE_LOG="${FAKE_LOG}"
: >"${FAKE_LOG}"

DRILL_ENGINE="fakeengine"
DRILL_APP_NAME="vb-drill-app-t1"
DRILL_MONGO_NAME="vb-drill-mongo-t1"
DRILL_CONTAINERS=("vb-drill-app-t1" "vb-drill-mongo-t1")
DRILL_VOLUMES=("vb-drill-static-t1" "vb-drill-mongo-t1")
DRILL_NETWORKS=("vb-drill-net-t1")
DRILL_TMP="${TEST_DIR}/scratch"
mkdir -p "${DRILL_TMP}"
DRILL_KEEP=0
DRILL_STARTED=1
PATH="${FAKE_BIN}:${PATH}" drill_cleanup >/dev/null 2>&1
CALLS="$(cat "${FAKE_LOG}")"
assert_contains "${CALLS}" "rm -f vb-drill-app-t1" "清理删掉了 app 容器"
assert_contains "${CALLS}" "rm -f vb-drill-mongo-t1" "清理删掉了 mongo 容器"
assert_contains "${CALLS}" "network rm vb-drill-net-t1" "清理删掉了专用网络"
assert_contains "${CALLS}" "volume rm vb-drill-static-t1" "清理删掉了静态卷"
assert_contains "${CALLS}" "volume rm vb-drill-mongo-t1" "清理删掉了 mongo 卷"
if [[ -d "${DRILL_TMP}" ]]; then fail "临时目录没删"; else pass "临时目录删掉了"; fi

# --keep：什么都不删，但要把怎么访问/怎么删打印出来
: >"${FAKE_LOG}"
DRILL_KEEP=1
DRILL_TMP="${TEST_DIR}/scratch2"
mkdir -p "${DRILL_TMP}"
DRILL_HTTP_PORT=18500
DRILL_MONGO_PORT=18501
OUT="$(PATH="${FAKE_BIN}:${PATH}" drill_cleanup 2>&1)"
CALLS="$(cat "${FAKE_LOG}")"
assert_eq "${CALLS}" "" "--keep 时一条删除命令都没发（容器留着给人看）"
assert_contains "${OUT}" "--keep" "说明了为什么留着"
assert_contains "${OUT}" "http://127.0.0.1:18500" "打印了怎么访问"
assert_contains "${OUT}" "rm -f vb-drill-app-t1" "打印了怎么删（用户不用自己猜名字）"
assert_contains "${OUT}" "volume rm" "也打印了卷怎么删"
if [[ -d "${DRILL_TMP}" ]]; then pass "--keep 时临时目录也留着（里面是响应体与探测结果）"; else fail "--keep 却把临时目录删了"; fi
DRILL_KEEP=0
rm -rf "${DRILL_TMP}"

# 失败路径也要拆：子进程里跑一个"起容器后立刻失败"的演练
DRILL_CONTAINERS=()
DRILL_VOLUMES=()
DRILL_NETWORKS=()

# ══════════════════════════ A6) 语义校验（真归档）══════════════════════
echo
echo "-- 语义化校验（结构校验沿用 vanblog.sh 的 verify_one_archive，只加不减）--"
OUT="$(verify_semantic_one "${GOOD}" 2>&1)"
RC=$?
assert_rc "${RC}" "0" "正常归档：语义校验通过"
# 结构部分（vanblog.sh 的原样输出）必须还在 —— 这是"additive"的硬要求
assert_contains "${OUT}" "OK   vanblog-full-20260916-010101.tar.zst" "仍然打了 vanblog.sh verify 的那行 OK 摘要"
assert_contains "${OUT}" "zstd 完整性 ✓" "仍然跑了流式完整性测试"
assert_contains "${OUT}" "manifest ✓" "仍然查了 manifest"
assert_contains "${OUT}" "NDJSON" "仍然数了 NDJSON"
assert_contains "${OUT}" "静态目录 ✓" "仍然看了静态树"
# 语义部分
assert_contains "${OUT}" "语义 PASS 清单来自归档内部" "说明了清单是从归档里读的（不是旁边的副本）"
assert_contains "${OUT}" "语义 PASS 清单 kind=vanblog-full-backup" "查了 kind"
assert_contains "${OUT}" "语义 PASS 清单 version=1" "查了 version"
assert_contains "${OUT}" "语义 PASS 成员路径安全" "查了越界成员"
assert_contains "${OUT}" "语义 PASS 文件名符合上传白名单" "查了上传白名单"
assert_contains "${OUT}" "语义 PASS 清单声明的 4 个集合都有对应的 db/<库>/<集合>.ndjson" "逐个核对了声明的集合有没有 .ndjson"
assert_contains "${OUT}" "语义 PASS 声明条数自洽" "核对了 Σcount == totals.documents"
assert_contains "${OUT}" "语义 PASS 静态文件数自洽" "核对了 Σstatic.files == totals.files"
assert_contains "${OUT}" "语义 PASS 解压工具" "报了需要哪个解压工具、本机有没有"
assert_contains "${OUT}" "语义 WARN 归档里**没有** static/themes/" "没有 themes 时报 WARN（这份归档早于主题备份）"
assert_contains "${OUT}" "前台静默退回默认皮肤" "把后果说清楚了（后台显示主题在、CSS 却没了）"
assert_contains "${OUT}" "语义结论：这份归档可以被当前版本恢复" "给了明确结论"
assert_contains "${OUT}" "drill" "结论里指向演练（校验只能证明读得出来，演练才能证明恢复得回来）"

THEMED="${BK}/vanblog-full-20260916-020202.tar.zst"
make_full_archive "${THEMED}" with-themes
OUT="$(verify_semantic_one "${THEMED}" 2>&1)"
assert_rc "$?" "0" "带 themes 的归档通过"
assert_contains "${OUT}" "语义 PASS 上传的主题在归档里" "认出了 static/themes/"
assert_not_contains "${OUT}" "语义 WARN 归档里**没有** static/themes/" "有 themes 时不再报那条 WARN"

V2="${BK}/vanblog-full-20260916-030303.tar.zst"
make_full_archive "${V2}" version2
OUT="$(verify_semantic_one "${V2}" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "version=2（比本程序新）→ 非 0 退出"
assert_contains "${OUT}" "语义 FAIL 清单 version=2 **比本程序新**" "大声说出来：恢复会明确拒绝"
assert_contains "${OUT}" "别拿它当恢复点" "告诉了用户该怎么办"

NOMFST="${BK}/vanblog-full-20260916-040404.tar.zst"
make_full_archive "${NOMFST}" no-manifest
echo '{"kind":"vanblog-full-backup","version":1,"databases":{"vanBlog":{"collections":{"articles":{"count":3}}}},"totals":{"documents":3}}' >"${NOMFST}.manifest.json"
OUT="$(verify_semantic_one "${NOMFST}" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "归档里没有 manifest.json（只有旁边的副本）→ 非 0"
assert_contains "${OUT}" "语义 FAIL 归档里读不出 manifest.json" "点名了是归档内部缺清单"
assert_contains "${OUT}" "恢复走的是归档内部那份清单" "解释了为什么副本不算数"

MISSND="${BK}/vanblog-full-20260916-050505.tar.zst"
make_full_archive "${MISSND}" missing-ndjson
OUT="$(verify_semantic_one "${MISSND}" 2>&1)"
RC=$?
assert_eq "${RC}" "0" "缺 .ndjson 成员**不会**让恢复失败（server 跳过并在 notes 里记一条），所以不判 FAIL"
assert_contains "${OUT}" "语义 WARN 有 2/4 个集合缺 .ndjson 成员" "但必须被说出来"
assert_contains "${OUT}" "waline/Comment" "点名了缺哪个集合"
assert_contains "${OUT}" "恢复**不会失败**" "说清了严重性（降级而不是失败）"

EMPTYA="${BK}/vanblog-full-20260916-060606.tar.zst"
make_full_archive "${EMPTYA}" empty
OUT="$(verify_semantic_one "${EMPTYA}" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "一条文档、一个文件都没有的归档 → 非 0（这就是「备份看着成功其实没备到东西」）"
assert_contains "${OUT}" "语义 FAIL 这份归档里一条文档、一个静态文件都没有" "点名了空归档"
OUT="$(VANBLOG_VERIFY_ALLOW_EMPTY=1 verify_semantic_one "${EMPTYA}" 2>&1)"
assert_contains "${OUT}" "VANBLOG_VERIFY_ALLOW_EMPTY=1，降级为警告" "给了降级开关并且明说降级了"

BADTOT="${BK}/vanblog-full-20260916-070707.tar.zst"
make_full_archive "${BADTOT}" bad-totals
OUT="$(verify_semantic_one "${BADTOT}" 2>&1)"
assert_eq "$?" "0" "totals 与 Σcount 不一致不影响恢复（恢复路径不读 totals）⇒ 不判 FAIL"
assert_contains "${OUT}" "语义 WARN 声明条数不自洽" "但会被说出来"
assert_contains "${OUT}" "Σ集合 count=7 ≠ totals.documents=999" "两个数字都打出来"

RENAMED="${BK}/my-renamed-backup.tar.zst"
make_full_archive "${RENAMED}"
OUT="$(verify_semantic_one "${RENAMED}" 2>&1)"
assert_contains "${OUT}" "语义 WARN 文件名 my-renamed-backup.tar.zst 不在上传白名单里" "改过名的归档：走上传恢复会 400，得说清楚"
assert_contains "${OUT}" "后台按名字恢复不受影响" "也说清了哪条路还能用"

TRUNC="${BK}/vanblog-full-20260916-999999.tar.zst"
SZ="$(wc -c <"${GOOD}")"
head -c $((SZ / 2)) "${GOOD}" >"${TRUNC}"
OUT="$(verify_semantic_one "${TRUNC}" >"${TEST_DIR}/trunc.out" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "截断的归档 → 非 0"
TRUNC_OUT="$(cat "${TEST_DIR}/trunc.out")"
assert_contains "${TRUNC_OUT}" "FAIL" "截断的归档标成 FAIL"
rm -f "${TRUNC}"

GZA="${BK}/vanblog-full-20260916-080808.tar.gz"
make_full_archive "${GZA}" with-themes
OUT="$(verify_semantic_one "${GZA}" 2>&1)"
assert_rc "$?" "0" "gzip 归档也走得通（不只 zstd）"
assert_contains "${OUT}" "gzip 完整性 ✓" "gzip 走了 vanblog.sh 的流式完整性测试"

# cmd_verify：整条命令 + 退出码（用子进程跑，测的是真实的退出码）
OUT="$(run_cli verify "${GOOD}" "${THEMED}" >"${TEST_DIR}/v.out" 2>&1)"
RC=$?
VOUT="$(cat "${TEST_DIR}/v.out")"
assert_rc "${RC}" "0" "verify 两个好归档 → 退出码 0"
assert_contains "${VOUT}" "深度校验 2 个归档" "报了校验了几个"
assert_contains "${VOUT}" "深度校验完成：" "有汇总行"
assert_contains "${VOUT}" "OK 2" "汇总里 OK 2"
run_cli verify "${V2}" >"${TEST_DIR}/v2.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "verify 一个 version=2 的归档 → 退出码非 0（可以放进 cron/监控）"
assert_contains "$(cat "${TEST_DIR}/v2.out")" "FAIL 1" "汇总里 FAIL 1"
run_cli verify "${BK}/不存在的归档.tar.zst" >"${TEST_DIR}/v3.out" 2>&1
assert_rc "$?" "1" "verify 一个不存在的归档 → 退出码非 0"
# 不带参数 = 备份目录里的全部归档（这个目录里现在有好有坏）
run_cli verify >"${TEST_DIR}/v4.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "不带参数时校验备份目录里的全部归档，其中有坏的 ⇒ 非 0"
assert_contains "$(cat "${TEST_DIR}/v4.out")" "深度校验备份目录里的全部归档" "说明了在扫整个备份目录"

# ══════════════════════════ A7) 验证台账（P3）══════════════════════
echo
echo "-- 验证台账：最近一次备份/验证/演练是什么时候 --"
LOGDIR="${TEST_DIR}/ledger"
mkdir -p "${LOGDIR}"
OUT="$(VANBLOG_BACKUP_DIR="${LOGDIR}" drill_verify_log_file)"
assert_eq "${OUT}" "${LOGDIR}/vanblog-verify-log.jsonl" "台账文件在备份目录里，名字固定"
assert_not_contains "$(basename "${OUT}")" "vanblog-full" "⚠️ 台账名字**不能**以 vanblog-full 开头"
# 这条是硬约束：备份目录里凡是 vanblog-full-* 都会被 verify 的枚举、prune 的计数
# （glob vanblog-full-*.tar.*）与 status 的统计当成"一份归档"，多一个兄弟文件就会多删一份真归档
LEDGER_TEST_DIR="${TEST_DIR}/globs"
mkdir -p "${LEDGER_TEST_DIR}"
cp "${GOOD}" "${LEDGER_TEST_DIR}/"
VANBLOG_BACKUP_DIR="${LEDGER_TEST_DIR}" drill_verify_log_append verify "${LEDGER_TEST_DIR}/$(basename "${GOOD}")" pass '"x":1'
GLOB1="$(cd "${LEDGER_TEST_DIR}" && ls -1 vanblog-full-* 2>/dev/null | grep -c .)"
GLOB2="$(cd "${LEDGER_TEST_DIR}" && ls -1 vanblog-full-*.tar.* 2>/dev/null | grep -vE '\.(sha256|manifest\.json)$' | grep -c .)"
assert_eq "${GLOB1}" "1" "台账不会被 verify 的 vanblog-full-* 枚举当成归档"
assert_eq "${GLOB2}" "1" "台账不会被 prune 的 vanblog-full-*.tar.* 计数当成归档（否则保留策略会多删一份真归档）"
LINE="$(VANBLOG_BACKUP_DIR="${LEDGER_TEST_DIR}" drill_verify_log_last "${LEDGER_TEST_DIR}/$(basename "${GOOD}")" verify)"
assert_eq "$(json_get "${LINE}" result)" "pass" "台账读得回来：result"
assert_eq "$(json_get "${LINE}" kind)" "verify" "台账读得回来：kind"
assert_contains "$(json_get "${LINE}" at)" "T" "台账里有 ISO 时间戳"
assert_eq "$(json_get "${LINE}" archive)" "$(basename "${GOOD}")" "台账里记的是归档名（不是绝对路径，拷到别的机器也能读）"
if VANBLOG_BACKUP_DIR="${LEDGER_TEST_DIR}" drill_verify_log_last "vanblog-full-不存在.tar.zst" verify >/dev/null 2>&1; then
  fail "查一个没记录的归档应该失败"
else
  pass "查一个没记录的归档返回非 0（调用方据此说「没验过」）"
fi

# ══════════════════════════ A8) backup-status：陈旧度护栏 ══════════════════════════
echo
echo "-- backup-status：最近一次备份什么时候、验过没有、陈旧了没有 --"
FRESH="${TEST_DIR}/fresh"
mkdir -p "${FRESH}"
cp "${GOOD}" "${FRESH}/vanblog-full-20260916-120000.tar.zst"
OUT="$(VANBLOG_BACKUP_DIR="${FRESH}" run_cli backup-status >"${TEST_DIR}/bs1.out" 2>&1)"
RC=$?
BS1="$(cat "${TEST_DIR}/bs1.out")"
assert_rc "${RC}" "0" "有一份刚做的归档 → 退出码 0"
assert_contains "${BS1}" "最新归档" "报出了最新归档"
assert_contains "${BS1}" "RESULT: PASS" "有机器可读的结论行"
assert_contains "${BS1}" "有 sha256 校验和记录" "查了 sha256 sidecar"
assert_contains "${BS1}" "还没演练过" "明说了演练没做过（备份存在 ≠ 能恢复）"
STALE="${TEST_DIR}/stale"
mkdir -p "${STALE}"
cp "${GOOD}" "${STALE}/vanblog-full-20260801-120000.tar.zst"
touch -d "30 days ago" "${STALE}/vanblog-full-20260801-120000.tar.zst"
VANBLOG_BACKUP_DIR="${STALE}" run_cli backup-status >"${TEST_DIR}/bs2.out" 2>&1
RC=$?
BS2="$(cat "${TEST_DIR}/bs2.out")"
assert_rc "${RC}" "1" "最新归档 30 天前 → 退出码非 0（cron 静默失败就是这么被抓到的）"
assert_contains "${BS2}" "FAIL" "标成 FAIL"
assert_contains "${BS2}" "定时备份很可能早就在失败" "说清了这意味着什么"
assert_contains "${BS2}" "RESULT: FAIL" "机器可读的结论行是 FAIL"
VANBLOG_BACKUP_DIR="${STALE}" run_cli backup-status --stale-days 60 >"${TEST_DIR}/bs3.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "--stale-days 60 时 30 天前的归档不算陈旧（判据可调）"
assert_contains "$(cat "${TEST_DIR}/bs3.out")" "最新归档不老于 60 天" "报出了实际用的判据"
VANBLOG_BACKUP_DIR="${STALE}" run_cli backup-status --no-stale-check >"${TEST_DIR}/bs4.out" 2>&1
assert_rc "$?" "0" "--no-stale-check 关掉陈旧度检查"
assert_contains "$(cat "${TEST_DIR}/bs4.out")" "陈旧度检查已关闭" "关掉时明说关掉了，不假装查过"
EMPTYDIR="${TEST_DIR}/emptydir"
mkdir -p "${EMPTYDIR}"
VANBLOG_BACKUP_DIR="${EMPTYDIR}" run_cli backup-status >"${TEST_DIR}/bs5.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "一份归档都没有 → 退出码非 0"
assert_contains "$(cat "${TEST_DIR}/bs5.out")" "一份 vanblog-full-* 都没有" "说清了是没有备份"
NODIR="${TEST_DIR}/nodir"
VANBLOG_BACKUP_DIR="${NODIR}" run_cli backup-status >"${TEST_DIR}/bs6.out" 2>&1
assert_rc "$?" "1" "备份目录不存在 → 退出码非 0"
assert_contains "$(cat "${TEST_DIR}/bs6.out")" "从来没有成功备份过" "目录不存在时把话说到位"
# --strict：有归档但没验过
VANBLOG_BACKUP_DIR="${FRESH}" run_cli backup-status --strict >"${TEST_DIR}/bs7.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "--strict：最新归档没有验证记录 → 退出码非 0"
assert_contains "$(cat "${TEST_DIR}/bs7.out")" "台账里没有这份归档的验证记录" "说清了缺什么、怎么补"
# 台账里有 pass 记录时，--strict 应该过
VANBLOG_BACKUP_DIR="${FRESH}" drill_verify_log_append verify "${FRESH}/vanblog-full-20260916-120000.tar.zst" pass ""
VANBLOG_BACKUP_DIR="${FRESH}" run_cli backup-status --strict >"${TEST_DIR}/bs8.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "台账里有 pass 记录后 --strict 通过"
assert_contains "$(cat "${TEST_DIR}/bs8.out")" "最新归档验证过" "报出了验证时间与结果"

# ══════════════════════════ A9) backup-verify：备份 + 立刻验证 ══════════════════════════
echo
echo "-- backup-verify：备份完立刻验证，失败就非 0（cron 用）--"
BVDIR="${TEST_DIR}/bv"
mkdir -p "${BVDIR}"
# 桩 backup：模拟"备份成功、产出新归档"
cat >"${TEST_DIR}/bv-ok.sh" <<EOF
set -u
export VANBLOG_DRILL_SKIP_MAIN=1 VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${BVDIR}"
source "${SCRIPT}" >/dev/null 2>&1
backup() { cp "${GOOD}" "${BVDIR}/vanblog-full-20260917-010101.tar.zst"; echo "整站备份成功"; return 0; }
cmd_backup_verify "\$@"
EOF
OUT="$(bash "${TEST_DIR}/bv-ok.sh" >"${TEST_DIR}/bv1.out" 2>&1)"
RC=$?
BV1="$(cat "${TEST_DIR}/bv1.out")"
assert_rc "${RC}" "0" "备份成功 + 归档能恢复 → 退出码 0"
assert_contains "${BV1}" "备份产出了新归档" "找到了这次新产出的归档（不是解析输出，是比对目录）"
assert_contains "${BV1}" "新归档通过深度校验" "对新归档跑了深度校验"
assert_contains "${BV1}" "RESULT: PASS" "有机器可读结论"
if grep -q '"kind":"backup-verify"' "${BVDIR}/vanblog-verify-log.jsonl" 2>/dev/null; then
  pass "台账里留下了 backup-verify 的记录"
else
  fail "台账里没有 backup-verify 记录"
fi
# 桩 backup：备份失败
cat >"${TEST_DIR}/bv-bad.sh" <<EOF
set -u
export VANBLOG_DRILL_SKIP_MAIN=1 VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${BVDIR}"
source "${SCRIPT}" >/dev/null 2>&1
backup() { echo "整站备份失败：站点接口不通"; return 1; }
cmd_backup_verify "\$@"
EOF
bash "${TEST_DIR}/bv-bad.sh" >"${TEST_DIR}/bv2.out" 2>&1
RC=$?
BV2="$(cat "${TEST_DIR}/bv2.out")"
assert_rc "${RC}" "1" "备份本身失败 → 退出码非 0"
assert_contains "${BV2}" "备份本身成功" "点名了失败发生在备份这一步"
assert_contains "${BV2}" "旧归档**没有**被删" "提醒了旧恢复点还在（失败时清理旧备份等于把最后的恢复点也弄没）"
# 桩 backup：说成功了但目录里没有新归档（磁盘满/目录不可写的形状）
BVDIR2="${TEST_DIR}/bv2"
mkdir -p "${BVDIR2}"
cat >"${TEST_DIR}/bv-lie.sh" <<EOF
set -u
export VANBLOG_DRILL_SKIP_MAIN=1 VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${BVDIR2}"
source "${SCRIPT}" >/dev/null 2>&1
backup() { echo "整站备份成功"; return 0; }
cmd_backup_verify "\$@"
EOF
bash "${TEST_DIR}/bv-lie.sh" >"${TEST_DIR}/bv3.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "backup 说成功、目录里却没有新归档 → 退出码非 0（这就是"备份看着成功"的护栏）"
assert_contains "$(cat "${TEST_DIR}/bv3.out")" "备份产出了新归档" "点名了这一步没过"
# 桩 backup：产出一个坏归档（version=2）
BVDIR3="${TEST_DIR}/bv3"
mkdir -p "${BVDIR3}"
cat >"${TEST_DIR}/bv-v2.sh" <<EOF
set -u
export VANBLOG_DRILL_SKIP_MAIN=1 VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${BVDIR3}"
source "${SCRIPT}" >/dev/null 2>&1
backup() { cp "${V2}" "${BVDIR3}/vanblog-full-20260917-020202.tar.zst"; return 0; }
cmd_backup_verify "\$@"
EOF
bash "${TEST_DIR}/bv-v2.sh" >"${TEST_DIR}/bv4.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "备份出来了但校验不过 → 退出码非 0"
assert_contains "$(cat "${TEST_DIR}/bv4.out")" "这份备份**恢复不回来**" "把后果说明白（别把它当恢复点）"

# ══════════════════════════ A10) 参数解析 / dry-run / 输出格式 ══════════════════════════
echo
echo "-- 参数解析、dry-run、PASS/FAIL 输出格式 --"
OUT="$(run_cli help 2>&1)"
assert_rc "$?" "0" "help 返回 0"
for kw in drill verify backup-verify backup-status --image --engine --keep --dry-run --mongo-image --timeout --as --no-pull --stale-days --strict --skip-hash --all --reverify-days VANBLOG_BACKUP_REVERIFY_DAYS VANBLOG_DRILL_SKIP_HASH VANBLOG_FORCE_COLOR; do
  assert_contains "${OUT}" "${kw}" "help 里写了 ${kw}"
done
assert_contains "${OUT}" "不复用、不删除" "help 里写清了安全边界（不碰在跑的栈）"
assert_contains "${OUT}" "27017" "help 里明说不会碰真库那个端口"
OUT="$(run_cli 2>&1)"
assert_rc "$?" "0" "不带参数 = 显示用法"
run_cli definitely-not-a-subcommand >"${TEST_DIR}/unk.out" 2>&1
RC=$?
assert_rc "${RC}" "2" "未知子命令 → 退出码 2（与"失败"区分开）"
assert_contains "$(cat "${TEST_DIR}/unk.out")" "未知子命令" "未知子命令会明说"
# drill 的参数解析：未知开关要报错，不能默默忽略
OUT="$(run_cli drill --no-such-flag 2>&1)"
RC=$?
assert_rc "${RC}" "2" "drill 遇到未知开关 → 退出码 2"
assert_contains "${OUT}" "未知参数" "并且点名了是哪个参数"
# drill 找不到归档
OUT="$(VANBLOG_BACKUP_DIR="${EMPTYDIR}" run_cli drill 2>&1)"
RC=$?
assert_rc "${RC}" "1" "没有指定归档、备份目录也是空的 → 退出码非 0"
assert_contains "${OUT}" "RESULT: FAIL" "有机器可读结论行"
assert_contains "${OUT}" "drill /path/to/vanblog-full-xxx.tar.zst" "给了正确用法"
OUT="$(run_cli drill "${TEST_DIR}/没有这个文件.tar.zst" 2>&1)"
assert_rc "$?" "1" "指定的归档不存在 → 退出码非 0"
# dry-run：用假引擎跑完整编排，但一个容器都不建
: >"${FAKE_LOG}"
DRY_DIR="${TEST_DIR}/dry"
mkdir -p "${DRY_DIR}"
cp "${GOOD}" "${DRY_DIR}/vanblog-full-20260916-130000.tar.zst"
OUT="$(PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${DRY_DIR}" \
  run_cli drill --dry-run --image vanblog:test --mongo-image mongo:7.0 "${DRY_DIR}/vanblog-full-20260916-130000.tar.zst" >"${TEST_DIR}/dry.out" 2>&1)"
RC=$?
DRYOUT="$(cat "${TEST_DIR}/dry.out")"
assert_rc "${RC}" "0" "dry-run 返回 0"
assert_contains "${DRYOUT}" "RESULT: DRY-RUN" "dry-run 有自己明确的结论行（不冒充 PASS）"
assert_contains "${DRYOUT}" "vanblog:test" "打印了会用哪个 vanblog 镜像"
assert_contains "${DRYOUT}" "mongo:7.0" "打印了会用哪个 mongo 镜像"
assert_contains "${DRYOUT}" "fakeengine" "打印了会用哪个引擎"
assert_contains "${DRYOUT}" "POST /api/admin/init/restore" "打印了会走哪条接口（用户真正会走的那条）"
assert_contains "${DRYOUT}" "拆掉全部一次性资源" "打印了会拆干净"
assert_not_contains "${DRYOUT}" "恢复接口返回 HTTP 201" "dry-run 里没有真去恢复（没有 201 那条断言）"
CALLS="$(grep -E 'fakeengine (run |network create|volume create|volume rm|rm -f|network rm)' "${FAKE_LOG}" 2>/dev/null)"
assert_eq "${CALLS}" "" "dry-run 一条创建/删除命令都没发（只读预检而已）"
# dry-run 也会把静态预检的 FAIL 报出来（文件名不合规的归档）
BADNAME_DIR="${TEST_DIR}/badname"
mkdir -p "${BADNAME_DIR}"
cp "${GOOD}" "${BADNAME_DIR}/renamed-archive.tar.zst"
PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${BADNAME_DIR}" \
  run_cli drill --dry-run "${BADNAME_DIR}/renamed-archive.tar.zst" >"${TEST_DIR}/dry2.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "dry-run 里静态预检不过 → 退出码非 0（不用真起容器就知道会 400）"
assert_contains "$(cat "${TEST_DIR}/dry2.out")" "归档文件名符合上传白名单" "点名了文件名不合规"
# --as 覆盖上传名
PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${BADNAME_DIR}" \
  run_cli drill --dry-run --as vanblog-full-20260916-999999.tar.zst "${BADNAME_DIR}/renamed-archive.tar.zst" >"${TEST_DIR}/dry3.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "--as 给了合规名字后 dry-run 通过"
assert_contains "$(cat "${TEST_DIR}/dry3.out")" "上传文件名被 --as 覆盖" "但会明说这不是用户真实拿到的文件名"
# 输出格式：PASS/FAIL/WARN 三种行首 + 台账表
assert_reset
rec_pass "标签A" "细节A"
rec_fail "标签B" "细节B"
rec_warn "标签C" "细节C"
rec_note "标签D" "细节D"
OUT="$(assert_table 2>&1)"
assert_contains "${OUT}" "PASS" "台账表里有 PASS 行"
assert_contains "${OUT}" "FAIL" "台账表里有 FAIL 行"
assert_contains "${OUT}" "标签A" "台账表里有标签"
assert_contains "${OUT}" "细节B" "台账表里有细节"
assert_contains "${OUT}" "跑了 3 条判定 + 1 条说明" "台账表头把判定数与说明数分开报"
OUT="$(assert_summary "演练结果" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "有 FAIL 时 assert_summary 返回 1"
assert_contains "${OUT}" "RESULT: FAIL pass=1 warn=1 fail=1 note=1" "机器可读的结论行带全部计数"
assert_reset
rec_pass "含竖线的标签" "细节里有 static/img|file|customPage 竖线"
OUT="$(assert_table 2>&1)"
assert_contains "${OUT}" "static/img|file|customPage 竖线" "台账表用 \\x1f 分隔：细节里的竖线不会把表切错位"
assert_reset
rec_pass "x" "y"
OUT="$(assert_summary "演练结果" 2>&1)"
RC=$?
assert_rc "${RC}" "0" "没有 FAIL 时返回 0"
assert_contains "${OUT}" "RESULT: PASS pass=1 warn=0 fail=0 note=0" "PASS 的结论行形状"

# ══════════════════════════ A11) 编排层：假引擎 + 假 HTTP 服务 ══════════════════════════
echo
echo "-- 编排层（假引擎 + 假 HTTP 服务，不需要真容器）--"
if command -v python3 >/dev/null 2>&1; then
  FAKE_PORT=""
  for cand in 19801 19802 19803 19804 19805; do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/${cand}") 2>/dev/null; then FAKE_PORT="${cand}"; break; fi
    exec 3>&- 3<&- 2>/dev/null || true
  done
  if [[ -z "${FAKE_PORT}" ]]; then
    skip "找不到空闲端口给假 HTTP 服务，跳过编排层用例"
  else
    cat >"${TEST_DIR}/fake_site.py" <<'PY'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

MODE = os.environ.get("FAKE_SITE_MODE", "ok")
state = {"restored": False}
OK = {
    "statusCode": 200,
    "data": {
        "restoredAt": "2026-09-17T00:00:00.000Z", "seconds": 1.5,
        "databases": {"vanBlog": {"collections": 3, "documents": 7}, "waline": {"collections": 1, "documents": 1}},
        "static": {"img": {"files": 1}}, "backupCreatedAt": "2026-09-16T01:02:03.000Z",
        "notes": ["建议重启 server 进程"],
        "counts": {"articles": 3, "statics": 2, "users": 1, "visits": 0, "viewers": 0, "settings": 1, "total": 7},
        "adminUserFromArchive": True, "initialized": True, "needsRestartForPipelineDeps": False,
    },
}
META = {"statusCode": 200, "data": {"version": "t", "totalArticles": 2,
                                  "meta": {"siteInfo": {"siteName": "演练站"}}}}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/public/health":
            self._send(200, {"statusCode": 200, "data": {"status": "ok", "mongo": "up",
                                                         "mongoStateText": "connected", "mongoPingMs": 1}})
        elif p == "/api/public/meta":
            if state["restored"]:
                self._send(200, META)
            else:
                self._send(200, {"statusCode": 233, "message": "未初始化!"})
        elif p == "/api/public/article":
            self._send(200, {"statusCode": 200, "data": {"total": 2, "articles": []}})
        elif p == "/api/public/theme":
            self._send(200, {"statusCode": 200, "data": {"name": "apple", "url": "", "hash": ""}})
        elif p == "/api/public/theme.css":
            self.send_response(204)
            self.end_headers()
        elif p.startswith("/static/"):
            self._send(200, b"fakeimg", "image/webp")
        else:
            self._send(404, {"statusCode": 404})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        while n > 0:
            chunk = self.rfile.read(min(65536, n))
            if not chunk:
                break
            n -= len(chunk)
        p = self.path.split("?")[0]
        if p != "/api/admin/init/restore":
            self._send(404, {"statusCode": 404})
            return
        if MODE == "bad400":
            self._send(400, {"statusCode": 400, "message": "读不出这个备份的清单"})
            return
        if state["restored"]:
            self._send(403, {"statusCode": 403, "message": "站点已经初始化过了"})
            return
        state["restored"] = True
        self._send(201, OK)


HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
    python3 "${TEST_DIR}/fake_site.py" "${FAKE_PORT}" >/dev/null 2>&1 &
    FAKE_SRV_PID=$!
    for _ in $(seq 1 40); do
      if curl -sS -m 2 -o /dev/null "http://127.0.0.1:${FAKE_PORT}/api/public/health" 2>/dev/null; then break; fi
      sleep 0.25
    done
    # 假引擎：把 curl 的目标端口固定成假服务（演练自己挑端口，挑到的一定不是 FAKE_PORT）
    # 所以这里用 stub 的方式跑编排：直接调 cmd_drill 的各段太碎，改成让假引擎什么都不做，
    # 并把演练指向假服务 —— 用 VANBLOG_DRILL_* 无法改 base，所以这一段只验"编排会拆干净"。
    ORCH_DIR="${TEST_DIR}/orch"
    mkdir -p "${ORCH_DIR}"
    cp "${GOOD}" "${ORCH_DIR}/vanblog-full-20260916-140000.tar.zst"
    : >"${FAKE_LOG}"
    # 假引擎的 run 之后容器"起不来"（health 探不到），演练必须失败并**仍然拆干净**
    cat >"${FAKE_BIN}/fakeengine" <<'STUB'
#!/usr/bin/env bash
echo "fakeengine $*" >> "${FAKE_ENGINE_LOG}"
case "$1" in
  --version) echo "fakeengine version 9.9.9 (stub)" ;;
  info) exit 0 ;;
  image) exit 0 ;;
  inspect)
    case "$*" in
      *"--type container"*) exit 1 ;;
      *"State.Running"*) echo "true" ;;
      *) echo "10.99.0.7" ;;
    esac ;;
  volume|network) [[ "$2" == "inspect" ]] && exit 1; exit 0 ;;
  rm|pull|exec) exit 0 ;;
  run) echo "fakeid"; exit 0 ;;
  logs) echo "server started ok" ;;
esac
exit 0
STUB
    chmod +x "${FAKE_BIN}/fakeengine"
    ORCH_TMP="${TEST_DIR}/orch-tmp"
    mkdir -p "${ORCH_TMP}"
    OUT="$(PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${ORCH_DIR}" \
      TMPDIR="${ORCH_TMP}" VANBLOG_DRILL_TMPDIR="${ORCH_TMP}" \
      VANBLOG_DRILL_TIMEOUT=6 VANBLOG_DRILL_PORT_BASE=19900 \
      run_cli drill "${ORCH_DIR}/vanblog-full-20260916-140000.tar.zst" >"${TEST_DIR}/orch.out" 2>&1)"
    RC=$?
    ORCHOUT="$(cat "${TEST_DIR}/orch.out")"
    assert_rc "${RC}" "1" "服务起不来（健康端点探不到）→ 演练失败，退出码非 0"
    assert_contains "${ORCHOUT}" "服务就绪（/api/public/health 200）" "点名了卡在哪一步"
    assert_contains "${ORCHOUT}" "日志尾部" "失败时打了容器日志尾部（光说「超时了」没有排障价值）"
assert_contains "${ORCHOUT}" "错误/警告关键字" "还先扫了一遍错误/警告行：只打 tail 常常一句有用的都没有（失败那一刻尾部全是 Nest 的路由表）"
    assert_contains "${ORCHOUT}" "RESULT: FAIL" "有机器可读结论"
    CALLS="$(cat "${FAKE_LOG}")"
    assert_contains "${CALLS}" "fakeengine run -d --name vb-drill-mongo-" "起了 mongo 容器（名字带 vb-drill- 前缀与随机后缀）"
    assert_contains "${CALLS}" "fakeengine run -d --name vb-drill-app-" "起了 vanblog 容器"
    assert_contains "${CALLS}" "--add-host vb-drill-mongo-" "用 --add-host 而不是容器名 DNS（rootless podman 没有 aardvark-dns）"
    assert_contains "${CALLS}" "10.99.0.7" "数据库地址用的是容器 IP"
    assert_contains "${CALLS}" "fakeengine rm -f vb-drill-app-" "失败路径也拆了 app 容器（trap 生效）"
    assert_contains "${CALLS}" "fakeengine rm -f vb-drill-mongo-" "失败路径也拆了 mongo 容器"
    assert_contains "${CALLS}" "fakeengine volume rm" "失败路径也删了卷"
    assert_contains "${CALLS}" "fakeengine network rm" "失败路径也删了网络"
    assert_not_contains "${CALLS}" "27017:27017" "宿主机侧没有把 mongo 映射到 27017（那是真库）"
    assert_not_contains "${CALLS}" "-p 27017:" "同上：发布端口不是 27017"
    if [[ "${CALLS}" == *"-p 19900:80"* && "${CALLS}" == *"19901:27017"* ]]; then
      pass "HTTP 与 mongo 发布在两个不同的空闲端口（19900 / 19901）"
    else
      fail "端口发布形状不对：$(printf '%s' "${CALLS}" | grep -oE '\-p [0-9]+:[0-9]+' | tr '\n' ' ')"
    fi
    if ls -d "${ORCH_TMP}"/vanblog-drill.* >/dev/null 2>&1; then
      fail "临时目录没删干净：$(ls -d "${ORCH_TMP}"/vanblog-drill.* | tr '\n' ' ')"
    else
      pass "失败路径也把临时目录删了（在它自己的 TMPDIR 里查，不去公共 /tmp 里猜）"
    fi
    # 撞名 → 拒绝启动（宁可不做演练，也不碰在跑的栈）
    cat >"${FAKE_BIN}/fakeengine" <<'STUB'
#!/usr/bin/env bash
echo "fakeengine $*" >> "${FAKE_ENGINE_LOG}"
case "$1" in
  --version) echo "fakeengine version 9.9.9 (stub)" ;;
  info) exit 0 ;;
  image) exit 0 ;;
  inspect) [[ "$*" == *"--type container"* ]] && exit 0 || exit 1 ;;
  *) exit 0 ;;
esac
STUB
    chmod +x "${FAKE_BIN}/fakeengine"
    : >"${FAKE_LOG}"
    OUT="$(PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${ORCH_DIR}" \
      run_cli drill --dry-run "${ORCH_DIR}/vanblog-full-20260916-140000.tar.zst" >"${TEST_DIR}/coll.out" 2>&1)"
    RC=$?
    assert_rc "${RC}" "1" "名字撞了 → 拒绝启动（退出码非 0）"
    assert_contains "$(cat "${TEST_DIR}/coll.out")" "一次性资源名字没有冲突" "点名了是名字冲突"
    assert_contains "$(cat "${TEST_DIR}/coll.out")" "拒绝启动" "说清了它不会去顶掉在跑的容器"
    assert_eq "$(grep -cE 'fakeengine (run|network create)' "${FAKE_LOG}" 2>/dev/null)" "0" "撞名时一条创建命令都没发"
    kill "${FAKE_SRV_PID}" >/dev/null 2>&1 || true
    FAKE_SRV_PID=""
  fi
else
  skip "本机没有 python3，跳过「假引擎 + 假 HTTP 服务」那组编排用例"
fi

# ══════════════════════════ A12) 源码级不变式 ══════════════════════════
echo
echo "-- 源码级不变式 --"
SRC="$(cat "${SCRIPT}")"
assert_contains "${SRC}" "trap 'drill_cleanup' EXIT" "EXIT 上挂了清理"
assert_contains "${SRC}" "trap 'drill_cleanup; exit 130' INT" "INT（Ctrl-C）上也挂了清理"
assert_contains "${SRC}" "trap 'drill_cleanup; exit 143' TERM" "TERM 上也挂了清理"
assert_contains "${SRC}" 'DRILL_MONGO_PORT}" == "27017"' "有硬护栏：挑到 27017 就拒绝（那是开发/生产在用的库）"
assert_contains "${SRC}" "vb-drill" "一次性资源用 vb-drill 前缀（不会与 vb-app/vb-mongo 这类在跑的栈撞名）"
assert_contains "${SRC}" "mktemp -d" "临时空间来自 mktemp -d，不是写死的 /var/vanblog"
assert_not_contains "${SRC}" "/home/" "脚本里没有绝对家目录路径（本机专属信息不进库）"
# ⚠️ 隐私守卫自己**绝不能内嵌它要防的字面量**。这一段旧版写的是
#    assert_not_contains "${SRC}" "<生产域名片段>" / "<真实账号名>" / "<内网 IP 前缀>"，
#    等于把私密值本身提交进了公开仓库（历史 d3d95363 里已经留下，删 HEAD 不删历史）。
#    所以现在全部按**形状**判定：URL 白名单、@ 形主机名、私有 IP 段、--add-host 的字面主机。
#    谁想把这几条"改进"回字面量比对 —— 停，那条断言本身就是泄露。
#    真要比对本机的私密值，用文件末尾那个可选的本地 denylist（不入库、缺失时 SKIP）。
URLS_FOUND="$(printf '%s\n' "${SRC}" | grep -oE 'https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' | sort -u)"
BAD_URL_N=0
while IFS= read -r u; do
  [[ -n "${u}" ]] || continue
  case "${u}" in
  https://github.com/CKboss/* | https://github.com/Mereithhh/* | https://ghcr.io/ckboss/* | https://raw.githubusercontent.com/* | http://127.0.0.1* | http://localhost*) : ;;
  *) BAD_URL_N=$((BAD_URL_N + 1)) ;;
  esac
done <<<"${URLS_FOUND}"
# ⚠️ 失败时也只报**条数**、不回显 URL：那条 URL 很可能正是要防的生产地址
assert_eq "${BAD_URL_N}" "0" "脚本里的绝对 URL 全部在公开白名单内（github/ghcr/raw.githubusercontent/127.0.0.1），白名单外命中 ${BAD_URL_N} 条"
if printf '%s\n' "${SRC}" | grep -qE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'; then
  fail "脚本里出现了 @ 形主机名/邮箱（真实账号与 user:pass@host 形凭据都不该内嵌）"
else
  pass "脚本里没有 @ 形主机名/邮箱"
fi
if printf '%s\n' "${SRC}" | grep -vE '^[[:space:]]*#' |
  grep -qE '(^|[^0-9.])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9.]|$)'; then
  fail "脚本非注释行里出现了私有网段 IP（内网拓扑不进库；命中不打印值）"
else
  pass "脚本非注释行里没有私有网段 IP（10.x / 192.168.x / 172.16-31.x）"
fi
ADDHOST_HITS="$(printf '%s\n' "${SRC}" | grep -E -- '--add-host' | grep -vE '^[[:space:]]*#' |
  grep -cE -- '--add-host[= ]"?[^" $]*[A-Za-z0-9-]+\.[A-Za-z]{2,}' || true)"
assert_eq "${ADDHOST_HITS}" "0" "--add-host 只用引擎注入的容器 IP（shell 变量），字面主机名命中 ${ADDHOST_HITS} 条"
# 可选：本机专属 denylist（vanblog_dev/ 整个在 .git/info/exclude 里，永不入库）。
# 存在时逐行当作"禁止出现的字面量"，对照 vanblog-drill.sh 与**本测试文件自己**；
# 命中只报计数、绝不回显值。文件缺失时 SKIP，CI 不受影响。
# ⚠️ 永远不要把该文件里的值写进任何 tracked 文件，也不要由代理创建它（值是主人的）。
PRIVATE_DENYLIST="${ROOT}/vanblog_dev/private-denylist.txt"
if [[ -f "${PRIVATE_DENYLIST}" ]]; then
  DENY_HITS=0
  SELF_SRC="$(cat "$0" 2>/dev/null)"
  while IFS= read -r secret; do
    [[ -n "${secret}" ]] || continue
    printf '%s' "${SRC}" | grep -qF -- "${secret}" && DENY_HITS=$((DENY_HITS + 1))
    printf '%s' "${SELF_SRC}" | grep -qF -- "${secret}" && DENY_HITS=$((DENY_HITS + 1))
  done <"${PRIVATE_DENYLIST}"
  assert_eq "${DENY_HITS}" "0" "本地 denylist 命中 0 次（私密字面量既不在脚本里、也不在本测试里）"
else
  skip "vanblog_dev/private-denylist.txt 不存在（可选的本地 denylist）：跳过字面量级隐私比对；上面的形状守卫（URL/@/私有 IP/--add-host）仍然生效"
fi
assert_contains "${SRC}" "XDG_RUNTIME_DIR" "处理了 rootless podman 需要的 XDG_RUNTIME_DIR"
assert_contains "${SRC}" "aardvark-dns" "记录了为什么用容器 IP 而不是容器名 DNS"
assert_contains "${SRC}" "--add-host" "用了 --add-host（podman 4.9 不支持 --link）"
if printf '%s\n' "${SRC}" | grep -v '^[[:space:]]*#' | grep -q -- '--link'; then
  fail "非注释行里出现了 --link（podman 4.9 不支持）"
else
  pass "没有真的用 --link（只在注释里解释了为什么不用）"
fi
assert_contains "${SRC}" "/api/admin/init/restore" "走的是用户真正会走的那条上传恢复接口"
assert_contains "${SRC}" "file=@" "multipart 字段名是 file"
assert_contains "${SRC}" "/api/public/health" "用健康端点等就绪"
assert_contains "${SRC}" "verify_one_archive" "语义校验复用 vanblog.sh 的结构校验（不另写一份）"
assert_contains "${SRC}" "VANBLOG_DRILL_SKIP_MAIN" "留了 source 口子给测试"
# 双胞胎：这一个字节都没动
if cmp -s "${MAIN}" "${PUBLIC_MAIN}"; then
  pass "scripts/vanblog.sh 与 docs/.vuepress/public/vanblog.sh 仍然字节一致（本轮没动它）"
else
  fail "两份 vanblog.sh 不一致了"
fi
if bash -n "${SCRIPT}" 2>/dev/null; then pass "bash -n 语法检查通过"; else fail "bash -n 不过"; fi
if [[ -x "${SCRIPT}" ]]; then pass "脚本有可执行位"; else fail "脚本没有可执行位（用户没法直接 ./vanblog-drill.sh）"; fi
# 退出码纪律：这一条是"失败的路径必须真的非 0"的守卫（这个仓库已经三次被 | tail 骗过）
run_cli verify "${V2}" >"${TEST_DIR}/rc.out" 2>&1
RC=$?
assert_ne "${RC}" "0" "失败的子命令必须非 0 退出（如果哪天变成 0，cron 就再也报不出警了）"
assert_eq "${RC}" "1" "而且就是 1（不是被信号打断之类的奇怪码）"
run_cli verify "${GOOD}" >"${TEST_DIR}/rc2.out" 2>&1
RC2=$?
assert_eq "${RC2}" "0" "成功的子命令返回 0"

# ══════════════════════════ A13) 与 server 的备份状态对账 ══════════════════════════
echo
echo "-- backup-status：文件系统 + server 状态文件 + server 端点，三重说法 --"
# server 写的 <备份目录>/backup-status.json：**不需要 token** 就能读 ⇒ cron 场景的首选来源
SFILE_DIR="${TEST_DIR}/sfile"
mkdir -p "${SFILE_DIR}"
cp "${GOOD}" "${SFILE_DIR}/vanblog-full-20260917-085458.tar.zst"
GOOD_BYTES="$(wc -c <"${SFILE_DIR}/vanblog-full-20260917-085458.tar.zst")"
cat >"${SFILE_DIR}/backup-status.json" <<EOF
{"version":1,"updatedAt":"2026-09-17T00:55:27.342Z","lastSuccessAt":"2026-09-17T00:55:27.341Z",
 "lastSuccessName":"vanblog-full-20260917-085458.tar.zst","lastSuccessBytes":${GOOD_BYTES},
 "lastVerifyMs":435,"lastFailureAt":null,"lastFailureStage":null,"lastFailureName":null,
 "lastFailureMessage":null,"consecutiveFailures":0}
EOF
VANBLOG_BACKUP_DIR="${SFILE_DIR}" run_cli backup-status >"${TEST_DIR}/sf1.out" 2>&1
RC=$?
SF1="$(cat "${TEST_DIR}/sf1.out")"
assert_rc "${RC}" "0" "server 状态文件与盘上一致 → 退出码 0"
assert_contains "${SF1}" "server 记着最近一次成功的备份（backup-status.json）" "读了 server 写的状态文件"
assert_contains "${SF1}" "2026-09-17T00:55:27.341Z" "报出了 server 记的成功时间（这就是「上次备份什么时候成功」的答案，不用翻日志）"
assert_contains "${SF1}" "server 导出后自己验过这份归档" "认出了 lastVerifyMs"
assert_contains "${SF1}" "lastVerifyMs=435" "把 server 自检耗时也报出来"
assert_contains "${SF1}" "server 侧没有连续失败的备份" "查了 consecutiveFailures"
assert_contains "${SF1}" "RESULT: PASS" "结论行"
# 没有这个文件时必须明说，不能假装查过
rm -f "${SFILE_DIR}/backup-status.json"
VANBLOG_BACKUP_DIR="${SFILE_DIR}" run_cli backup-status >"${TEST_DIR}/sf2.out" 2>&1
assert_contains "$(cat "${TEST_DIR}/sf2.out")" "没有 server 写的 backup-status.json" "状态文件不在时明说（不假装读过）"
# server 说连续失败 / 说的不是同一份归档
cat >"${SFILE_DIR}/backup-status.json" <<EOF
{"version":1,"lastSuccessAt":"2026-09-10T00:00:00.000Z","lastSuccessName":"vanblog-full-20260910-000000.tar.zst",
 "lastSuccessBytes":1,"lastVerifyMs":null,"lastFailureAt":"2026-09-17T01:00:00.000Z",
 "lastFailureStage":"verify","lastFailureName":"vanblog-full-20260917-085458.tar.zst",
 "lastFailureMessage":"zstd 完整性校验失败","consecutiveFailures":3}
EOF
VANBLOG_BACKUP_DIR="${SFILE_DIR}" run_cli backup-status >"${TEST_DIR}/sf3.out" 2>&1
RC=$?
SF3="$(cat "${TEST_DIR}/sf3.out")"
assert_rc "${RC}" "1" "server 说连续失败 3 次 → 退出码非 0（cron 就能报警了）"
assert_contains "${SF3}" "consecutiveFailures=3" "报出了连续失败次数"
assert_contains "${SF3}" "阶段 verify" "报出了失败发生在哪个阶段（export 还是 verify）"
assert_contains "${SF3}" "zstd 完整性校验失败" "把 server 的失败原因原样带出来"
assert_contains "${SF3}" "两边不一致" "server 记的归档与盘上最新的不一致时点名（这本身就是发现）"
# 字节数对账只在"两边说的是同一份归档"时才有意义（不同名就无从比起）
assert_not_contains "${SF3}" "server 记的字节数" "名字都不一样时不做字节数对账（无从比起，报了反而是噪音）"
cat >"${SFILE_DIR}/backup-status.json" <<EOF
{"version":1,"lastSuccessAt":"2026-09-17T00:55:27.341Z","lastSuccessName":"vanblog-full-20260917-085458.tar.zst",
 "lastSuccessBytes":1,"lastVerifyMs":435,"lastFailureStage":null,"consecutiveFailures":0}
EOF
VANBLOG_BACKUP_DIR="${SFILE_DIR}" run_cli backup-status >"${TEST_DIR}/sf4.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "只有字节数对不上时不判失败（可能是 server 记的是压缩前/后的另一个口径）"
assert_contains "$(cat "${TEST_DIR}/sf4.out")" "server 记的字节数与盘上的文件一致" "同一份归档但字节数不同 → 会被说出来（归档被截断过？）"

# ══════════════════════════ A13) 与 server 的备份状态端点对账（有 token 才做）══════════════════════
echo
echo "-- backup-status：文件系统 + server 端点两重说法 --"
STATUS_DIR="${TEST_DIR}/statusdir"
mkdir -p "${STATUS_DIR}"
cp "${GOOD}" "${STATUS_DIR}/vanblog-full-20260917-085458.tar.zst"
GOOD_NAME="vanblog-full-20260917-085458.tar.zst"
GOOD_SIZE="$(wc -c <"${STATUS_DIR}/${GOOD_NAME}")"
# 桩掉 http_probe：不打任何真实站点（也顺便证明"没有 token 就不发请求"）
HTTP_PROBE_LOG="${TEST_DIR}/http-probe-calls.log"
: >"${HTTP_PROBE_LOG}"
http_probe() {
  # ⚠️ 记到文件而不是变量：调用方在 $(…) 里跑，子 shell 里改的变量传不回来
  printf '%s\n' "$*" >>"${HTTP_PROBE_LOG}"
  printf '%s' "${CANNED_STATUS}" >"$3"
  HTTP_CODE="200"
  HTTP_BYTES="${#CANNED_STATUS}"
  return 0
}
CANNED_STATUS="{\"statusCode\":200,\"data\":{\"version\":\"x\",\"lastSuccessName\":\"${GOOD_NAME}\",\"lastSuccessBytes\":${GOOD_SIZE},\"lastFailureStage\":null,\"consecutiveFailures\":0,\"stale\":false}}"
OUT="$(VANBLOG_ADMIN_TOKEN=fake-token-xyz VANBLOG_API_BASE=http://127.0.0.1:1 VANBLOG_BACKUP_DIR="${STATUS_DIR}" cmd_backup_status 2>&1)"
RC=$?
assert_rc "${RC}" "0" "两边说法一致 → 退出码 0"
assert_contains "${OUT}" "server 的备份状态端点可读" "有 token 时读了 /api/admin/backup/full/status"
assert_contains "${OUT}" "server 与文件系统说的是同一份归档" "对账了归档名"
assert_contains "${OUT}" "server 报的字节数与盘上的文件一致" "对账了字节数"
assert_contains "${OUT}" "server 侧没有连续失败的备份" "对账了 consecutiveFailures"
assert_contains "${OUT}" "server 侧不认为备份已陈旧" "对账了 stale"
assert_not_contains "${OUT}" "fake-token-xyz" "⚠️ token 绝不出现在输出里"
assert_contains "$(cat "${HTTP_PROBE_LOG}")" "-H token: fake-token-xyz" "鉴权头是 token: <jwt>（不是 Authorization: Bearer，token.guard 读的是 headers[token]）"
: >"${HTTP_PROBE_LOG}"
OUT="$(VANBLOG_API_BASE=http://127.0.0.1:1 VANBLOG_BACKUP_DIR="${STATUS_DIR}" cmd_backup_status 2>&1)"
assert_eq "$(cat "${HTTP_PROBE_LOG}")" "" "没有 token 时一个请求都不发（cron 里通常没有 token）"
assert_contains "${OUT}" "没有 VANBLOG_ADMIN_TOKEN，跳过与 server 的对账" "没 token 时明说跳过了，不假装对过账"
# 两边不一致本身就是发现
CANNED_STATUS="{\"statusCode\":200,\"data\":{\"lastSuccessName\":\"vanblog-full-19990101-000000.tar.zst\",\"lastSuccessBytes\":1,\"consecutiveFailures\":3,\"lastFailureAt\":\"2026-09-17T01:00:00Z\",\"lastFailureStage\":\"verify\",\"stale\":true,\"staleMessage\":\"已经 72 小时没有成功备份\"}}"
OUT="$(VANBLOG_ADMIN_TOKEN=fake-token-xyz VANBLOG_API_BASE=http://127.0.0.1:1 VANBLOG_BACKUP_DIR="${STATUS_DIR}" cmd_backup_status 2>&1)"
RC=$?
assert_rc "${RC}" "1" "server 说连续失败 3 次 + 已陈旧 → 退出码非 0"
assert_contains "${OUT}" "两边不一致" "server 与文件系统说法不同时点名（这本身就是发现）"
assert_contains "${OUT}" "consecutiveFailures=3" "报出了连续失败次数"
assert_contains "${OUT}" "verify" "报出了失败发生在哪个阶段"
assert_contains "${OUT}" "已经 72 小时没有成功备份" "把 server 的陈旧原因原样带出来"
assert_contains "${OUT}" "server 报的字节数与盘上的文件一致" "字节数也对账了"
assert_not_contains "${OUT}" "fake-token-xyz" "失败路径也不泄漏 token"
unset -f http_probe

# ══════════════════════════ A14) vanblog.sh 的转发（免 root 的只读子命令）══════════════════════
echo
echo "-- vanblog.sh 转发：drill / verify-deep / backup-verify / backup-status --"
MAINSRC="$(cat "${MAIN}")"
assert_contains "${MAINSRC}" "vanblog-drill.sh" "vanblog.sh 里有转发到 vanblog-drill.sh 的那一行"
# 位置很要紧：必须在 pre_check 之前。pre_check 既 `mkdir -p /var/vanblog` 又对非 root 直接 exit 1，
# 放在分发处的话这些只读子命令就仍然要求 root（而这台机器上 root 跑 podman 看到的是另一套镜像存储）
LINE_NO_DELEGATE="$(grep -n 'vanblog-drill\.sh' "${MAIN}" | head -1 | cut -d: -f1)"
LINE_NO_PRECHECK="$(grep -n '^pre_check$' "${MAIN}" | head -1 | cut -d: -f1)"
if [[ -n "${LINE_NO_DELEGATE}" && -n "${LINE_NO_PRECHECK}" && "${LINE_NO_DELEGATE}" -lt "${LINE_NO_PRECHECK}" ]]; then
  pass "转发那行在 pre_check（第 ${LINE_NO_PRECHECK} 行）之前（第 ${LINE_NO_DELEGATE} 行）⇒ 只读子命令不要求 root"
else
  fail "转发那行不在 pre_check 之前（delegate=${LINE_NO_DELEGATE:-无}，pre_check=${LINE_NO_PRECHECK:-无}）⇒ 非 root 用户跑不了 drill"
fi
# 端到端：真的从 vanblog.sh 进去（不要求 root，不建 /var/vanblog）
OUT="$(VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${STATUS_DIR}" \
  run_main backup-status >"${TEST_DIR}/main1.out" 2>&1)"
RC=$?
assert_rc "${RC}" "0" "./vanblog.sh backup-status 能跑通（当前 uid=$(id -u)，不是 root 也行）"
assert_contains "$(cat "${TEST_DIR}/main1.out")" "备份状态" "转发到了 vanblog-drill.sh 的 backup-status"
assert_contains "$(cat "${TEST_DIR}/main1.out")" "${GOOD_NAME}" "读到了备份目录里的归档"
VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${STATUS_DIR}" \
  run_main verify-deep "${STATUS_DIR}/${GOOD_NAME}" >"${TEST_DIR}/main2.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "./vanblog.sh verify-deep <归档> 能跑通"
assert_contains "$(cat "${TEST_DIR}/main2.out")" "深度校验" "转发到了深度校验"
assert_contains "$(cat "${TEST_DIR}/main2.out")" "语义 PASS" "语义层跑了"
VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${STATUS_DIR}" \
  run_main verify-deep "${V2}" >"${TEST_DIR}/main3.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "./vanblog.sh verify-deep 对坏归档返回非 0（退出码穿过 exec 传回来了）"

# ── A14b) 自述缺口：能跑的子命令必须在 --help 里出现 ──────────────────────────────
# 本轮实测：drill / verify-deep / backup-verify / backup-status 四条**一直可用**（上面刚跑通三条），
# 但 `show_usage` 里出现 **0 次**，而交互菜单第 30 项自称「使用说明（全部子命令、参数、环境变量
# 与场景配方）」—— 也就是说菜单在说一句假话，而这四条恰恰是"证明备份能恢复"的那批命令，
# 最需要被发现。修法是把它们写进 --help；这里钉住，并顺手做成**通用漂移守卫**：
# dispatcher 认的子命令 + 提前转发的四条，一个都不许在 --help 里缺席。
USAGE_SRC="$(awk '/^show_usage\(\) \{/,/^USAGE$/' "${MAIN}")"
for sub in drill verify-deep backup-verify backup-status; do
  assert_contains "${USAGE_SRC}" "${sub}" "--help 里有 ${sub}（以前能跑、自述里 0 次）"
done
assert_contains "${USAGE_SRC}" "不需要 root" "--help 说明了这四条免 root（否则用户会去加 sudo）"
assert_contains "${USAGE_SRC}" "RESULT: PASS" "--help 写了 drill 的结论行长什么样（照着 grep 才用得起来）"
DISPATCH_SUBS="$(awk '/^  case \$1 in$/,/^  esac$/' "${MAIN}" | grep -oE '^[[:space:]]*"[a-z_-]+"\)' | tr -d ' ")' | sort -u)"
if [[ -z "${DISPATCH_SUBS}" ]]; then
  fail "没解析出 dispatcher 的子命令清单 —— 这条漂移守卫空转了（awk 范围要跟着 dispatcher 的写法改）"
else
  missing=""
  for sub in ${DISPATCH_SUBS} drill verify-deep backup-verify backup-status; do
    printf '%s' "${USAGE_SRC}" | grep -qF -- "${sub}" || missing="${missing} ${sub}"
  done
  if [[ -z "${missing}" ]]; then
    pass "--help 覆盖了全部 $(printf '%s' "${DISPATCH_SUBS}" | wc -w)+4 个子命令（菜单第 30 项那句「全部子命令」名副其实）"
  else
    fail "--help 里缺这些子命令：${missing}（菜单第 30 项自称「全部子命令」，缺一个就是假话）"
  fi
fi
# 反证：这条守卫不是空转的 —— 把 show_usage 换成一段不含这四条的假文本，它必须报缺
FAKE_USAGE="backup 整站备份
verify 校验归档"
fake_missing=""
for sub in drill verify-deep backup-verify backup-status; do
  printf '%s' "${FAKE_USAGE}" | grep -qF -- "${sub}" || fake_missing="${fake_missing} ${sub}"
done
assert_eq "$(printf '%s' "${fake_missing}" | wc -w | tr -d ' ')" "4" "同一段检查跑在缺这四条的假 --help 上会报满 4 个（守卫不空转）"

# ── A14c) `--help` 自己也不该要求 root ───────────────────────────────────────────
# 上面那四条免 root 的子命令，用户是从**帮助**里才知道它们免 root 的；可帮助本身以前要过了
# pre_check 才打印，而 pre_check 对非 root 直接 exit 1 ⇒ 没有 root 的人连"哪些命令不需要 root"
# 都查不到，只会得到一句"必须使用root用户运行此脚本"。修法是把这个 case 挪到 pre_check 之前
# （与 drill 转发同一个位置、同一个理由）。这里同时钉住**位置**与**行为**。
LINE_NO_HELP="$(grep -n 'show_usage; exit 0 ;; esac' "${MAIN}" | head -1 | cut -d: -f1)"
if [[ -n "${LINE_NO_HELP}" && -n "${LINE_NO_PRECHECK}" && "${LINE_NO_HELP}" -lt "${LINE_NO_PRECHECK}" ]]; then
  pass "--help 的处理（第 ${LINE_NO_HELP} 行）在 pre_check（第 ${LINE_NO_PRECHECK} 行）之前 ⇒ 非 root 也能看帮助"
else
  fail "--help 的处理不在 pre_check 之前（help=${LINE_NO_HELP:-无}，pre_check=${LINE_NO_PRECHECK:-无}）⇒ 非 root 看不到帮助"
fi
# 行为级：真跑一次（当前 uid 是不是 root 都该出帮助、都该 rc=0）
HELP_OUT="$(bash "${MAIN}" --help 2>&1 </dev/null)"; HELP_RC=$?
assert_rc "${HELP_RC}" "0" "./vanblog.sh --help 退出码 0（当前 uid=$(id -u)）"
assert_contains "${HELP_OUT}" "VanBlog 管理脚本" "--help 真的打印了帮助正文"
assert_contains "${HELP_OUT}" "verify-deep" "帮助里能看到那四条免 root 的子命令"
assert_not_contains "${HELP_OUT}" "必须使用root" "帮助路径上没有冒出 root 门槛的报错"
# 另外两个等价入口也要一样（-h / help），否则只修了一个形状
for a in -h help; do
  A_OUT="$(bash "${MAIN}" "${a}" 2>&1 </dev/null)"; A_RC=$?
  assert_rc "${A_RC}" "0" "./vanblog.sh ${a} 同样退出码 0"
  assert_contains "${A_OUT}" "VanBlog 管理脚本" "./vanblog.sh ${a} 同样打印帮助"
done
# 反证（位置那条断言不是空转）：pre_check 里确实有 root 门槛，否则"挪到它前面"毫无意义
if grep -qF 'EUID -ne 0' "${MAIN}"; then
  pass "pre_check 里确实有 root 门槛（所以「挪到它之前」这条断言有意义）"
else
  fail "pre_check 里没有 root 门槛了 —— 上面那条位置断言可能已失去意义，请重新核对"
fi
# 反证（行为那条不是空转）：不带参数时仍然照常要 root（别把门槛整个拆了）
if grep -qE '^pre_check$' "${MAIN}"; then
  pass "pre_check 仍然会被调用（不带参数时照旧要 root、照旧进菜单）"
else
  fail "找不到 pre_check 的调用点了 ——  root 门槛可能被整个拆掉"
fi
# ⚠️ 从这里开始的 dry-run 一律带**本节专用的假引擎**，与 A10 那组同一个思路。
# 原因（本机实测）：dry-run 虽然一个容器都不建，但**仍然会探测引擎**，探不到就
# FAIL + rc=1（`没有可用的容器引擎（docker daemon 连不上，也没有可用的 podman）`）。
# 在受限环境里这是常态而不是异常 —— 沙箱不给 /dev/shm 时 rootless podman 会以
# `failed to open 2048 locks in /libpod_rootless_lock_1000: permission denied` 起不来，
# docker 组为空时 docker 一律 EACCES。A14 要钉的是"vanblog.sh 把子命令转发给 drill、
# 且退出码原样穿回来"，不是"这台机器装了引擎" ⇒ 用假引擎让它 hermetic。
# ⚠️ 不能复用 ${FAKE_BIN} 里那个 stub：它已经被 A11 改写成"inspect 一律成功"
#    （那一节要演的是"容器起不来但必须拆干净"），于是这里的**名字冲突预检**会认为
#    vb-drill-* 全都已存在 ⇒ `一次性资源名字没有冲突` FAIL。所以单独造一个
#    "什么都没占用"的 stub（按 drill_resource_exists 的四种调用形状逐一给答案）。
DRY_BIN="${TEST_DIR}/drybin"
mkdir -p "${DRY_BIN}"
cat >"${DRY_BIN}/fakeengine" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "inspect --type") exit 1 ;;  # 容器不存在 ⇒ 名字没被占用
  "volume inspect") exit 1 ;;  # 卷不存在
  "network inspect") exit 1 ;; # 网络不存在
  "image inspect") exit 0 ;;   # 镜像在本地（免得 dry-run 多一条与本节无关的 WARN）
esac
case "$1" in
  --version) echo "fakeengine version 9.9.9 (a14 dry-run stub)" ;;
  info) exit 0 ;;              # drill_detect_engine 只要求 command -v 命中，这里顺便让 info 也过
esac
exit 0
STUB
chmod +x "${DRY_BIN}/fakeengine"
VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${STATUS_DIR}" \
  PATH="${DRY_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine \
  run_main drill --dry-run --image vanblog:test "${STATUS_DIR}/${GOOD_NAME}" >"${TEST_DIR}/main4.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "./vanblog.sh drill --dry-run 能跑通"
assert_contains "$(cat "${TEST_DIR}/main4.out")" "RESULT: DRY-RUN" "dry-run 的结论行"
# 免 root 的同时，绝不能顺带把 /var/vanblog 建出来
if [[ -d /var/vanblog && ! -w /var/vanblog ]]; then
  skip "/var/vanblog 已经存在（真装过），跳过「没有顺手建目录」这条"
else
  assert_contains "$(cat "${TEST_DIR}/main1.out")" "备份状态" "（同一条）只读子命令没有触发 pre_check"
fi
# --skip-preflight：坏归档也照样上传，用来演练 server 的护栏
OUT="$(PATH="${DRY_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${STATUS_DIR}" \
  run_cli drill --dry-run --skip-preflight --image vanblog:test "${STATUS_DIR}/${GOOD_NAME}" 2>&1)"
assert_rc "$?" "0" "--skip-preflight 时 dry-run 照常通过"
TRUNC_DIR="${TEST_DIR}/trunc2"
mkdir -p "${TRUNC_DIR}"
head -c $(( $(wc -c <"${GOOD}") / 2 )) "${GOOD}" >"${TRUNC_DIR}/vanblog-full-20260917-999999.tar.zst"
OUT="$(PATH="${DRY_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${TRUNC_DIR}" \
  run_cli drill --dry-run --image vanblog:test "${TRUNC_DIR}/vanblog-full-20260917-999999.tar.zst" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "截断的归档：默认在预检就拦下（不用起容器就知道恢复不了）"
assert_contains "${OUT}" "归档里的清单读得出来" "点名了清单读不出来"
# ⚠️ 上一条的 rc=1 必须来自**预检**而不是别的原因：假引擎排除了"没有引擎"，
#    这条再排除"名字冲突"—— 否则一台环境不对的机器上它会因为错误的原因变绿（rc 都是 1）。
assert_not_contains "${OUT}" "没有可用的容器引擎" "rc=1 的原因是归档坏，不是环境没有引擎"
assert_not_contains "${OUT}" "一次性资源名字没有冲突" "rc=1 的原因也不是名字冲突"
OUT="$(PATH="${DRY_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${TRUNC_DIR}" \
  run_cli drill --dry-run --skip-preflight --image vanblog:test "${TRUNC_DIR}/vanblog-full-20260917-999999.tar.zst" 2>&1)"
RC=$?
assert_eq "${RC}" "0" "--skip-preflight 时不拦，交给 server 判（演练护栏要用这条）"
assert_contains "${OUT}" "--skip-preflight" "但会明说预检被跳过了（不静默放宽）"

# ══════════════════════════ A15) JSON 扫描器的转义解码（成员名是任意字节）══════════════════════
echo
echo "-- JSON 字符串解码（\\u / 控制字符：integrity.members 的键是 tar 头里的原始文件名）--"
assert_eq "$(json_get '{"k":"aAb"}' k)" "aAb" "普通字符串照旧"
U41='{"k":"aAb"}'
assert_eq "$(json_get "${U41}" k)" "aAb" "基线：无转义"
UESC='{"k":"a\u0041b"}'
assert_eq "$(json_get "${UESC}" k)" "aAb" '\u0041 解码成 A（旧版扫描器会给出 u0041 —— 成员名就对不上了）'
C1ESC="$(printf '{"k":"x\\u009by"}')"
assert_eq "$(json_get "${C1ESC}" k)" "$(printf 'x\302\233y')" '\u009b 解码成 UTF-8 字节 C2 9B（双重编码 CJK 图名在 JSON 里的形状）'
NESC='{"k":"a\nb"}'
assert_eq "$(json_get "${NESC}" k)" "$(printf 'a\nb')" '\n 转义解码成真换行（旧版给出字面量 n）'
TESC='{"k":"a\tb"}'
assert_eq "$(json_get "${TESC}" k)" "$(printf 'a\tb')" '\t 转义解码成真制表符'
SESC='{"k":"\ud83d\ude00"}'
assert_eq "$(json_get "${SESC}" k | tr -d '\n' | od -An -tx1 | tr -d ' \n')" "f09f9880" '代理对解码成 4 字节 UTF-8（U+1F600）'

# ══════════════════════════ A16) 成员级完整性（integrity 块）══════════════════════
echo
echo "-- 成员级完整性：哈希/merkle/双清单/memberCount（真 tar+zstd 现场打包，不 mock）--"
# 造**带 integrity 块**的归档：照 server 的导出顺序（暂存树逐文件哈希 → 写 manifest
# （members+2 个 null、merkleRoot=排序后 "<名>\n<sha|null>\n" 拼接的 sha256、
# memberCount=暂存树 tar 条目数+2）→ 复制出 MANIFEST.copy.json → 整树打包）。
# 默认成员名里就带 C2 9B 字节（双重编码 CJK 的控制字符形状，真站静态目录里有 10 个）。
# 变体：corrupt-content（写完清单再改文件内容：zstd -t 过得了，只有成员哈希抓得到）
#       bad-merkle | copy-mismatch | bad-count | tamper-sha（改表内哈希：merkle 必须抓）
#       missing-copy | newline-name（成员名里带真换行）
make_integrity_archive() {
  local dest="$1"
  shift
  local variant=" ${*:-} "
  local st="${TEST_DIR}/ist-$$-${RANDOM}"
  mkdir -p "${st}/db/vanBlog" "${st}/static/img" "${st}/static/themes"
  printf '%s\n' \
    '{"_id":{"$oid":"507f1f77bcf86cd799439011"},"title":"a","deleted":false,"hidden":false,"private":false,"category":"博客"}' \
    '{"_id":{"$oid":"507f1f77bcf86cd799439012"},"title":"gone","deleted":true,"deletedAt":"2026-09-01T00:00:00Z","category":"博客"}' \
    '{"_id":{"$oid":"507f1f77bcf86cd799439013"},"title":"c","category":"博客"}' >"${st}/db/vanBlog/articles.ndjson"
  printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439021"},"username":"admin"}' >"${st}/db/vanBlog/users.ndjson"
  printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439051"},"articleId":"x","v":1}' \
    '{"_id":{"$oid":"507f1f77bcf86cd799439052"},"articleId":"x","v":2}' >"${st}/db/vanBlog/revisions.ndjson"
  printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439061"},"name":"m1"}' >"${st}/db/vanBlog/migrations.ndjson"
  printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439071"},"title":"d"}' >"${st}/db/vanBlog/drafts.ndjson"
  printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439031"},"name":"博客","private":false}' >"${st}/db/vanBlog/categories.ndjson"
  # metas 必须有：/api/public/meta 在没有 metas 文档时会 500（活体演练实测）。
  # ⚠️ 全部是合成值（站名"演练站"）—— 真站点 metas 里有域名/作者/统计 ID，绝不进测试文件
  printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439081"},"links":[],"socials":[],"menus":[],"rewards":[],"about":{"content":""},"siteInfo":{"siteName":"演练站","author":"drill","siteDesc":"","baseUrl":"","since":"2026-01-01"},"viewer":0}' >"${st}/db/vanBlog/metas.ndjson"
  # settings 也必须有：/api/public/meta 对 menuRes 做 `const { data: menus } = menuRes`，
  # 归档没有 settings 集合时 getMenuSetting() 返回 null → 解构 null → **500**
  # （这是 server 侧一个潜在 bug，已上报；真实站点备份总有 settings，这里给最小文档绕过）
  printf '%s\n' '{"_id":{"$oid":"507f1f77bcf86cd799439091"},"type":"menu","value":{"data":[]}}' >"${st}/db/vanBlog/settings.ndjson"
  echo 'fakeimg' >"${st}/static/img/a.webp"
  echo '.skin{}' >"${st}/static/themes/1-abcd1234.css"
  local cn
  cn="$(printf 'weird-\302\233-x.webp')"
  printf 'ctrl' >"${st}/static/img/${cn}"
  if [[ "${variant}" == *" newline-name "* ]]; then
    local nl=$'\n'
    printf 'nl' >"${st}/static/img/nl-a${nl}b.webp"
  fi
  local se
  se="$( (cd "${st}" && tar -cf - .) | tar -tf - | wc -l | tr -d ' ')"
  local recs="${st}.recs" memjson="" img_n=0
  : >"${recs}"
  while IFS= read -r -d '' f; do
    local rel="./${f#"${st}"/}" sha sz esc
    # ⚠️ sha256sum 必须走 stdin 重定向：文件名带换行/反斜杠时 GNU sha256sum 会在
    #    输出行首加 "\" 并转义文件名，hex 里混进反斜杠（fixture 实测踩过）
    sha="$(sha256sum <"${f}" | cut -d' ' -f1)"
    sz="$(wc -c <"${f}" | tr -d ' ')"
    printf '%s\t%s\0' "${rel}" "${sha}" >>"${recs}"
    esc="$(printf '%s' "${rel}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | LC_ALL=C awk '{if (NR>1) printf "\\n"; printf "%s", $0}')"
    memjson="${memjson}${memjson:+,}\"${esc}\":{\"sha256\":\"${sha}\",\"bytes\":${sz}}"
    [[ "${rel}" == ./static/img/* ]] && img_n=$((img_n + 1))
  done < <(find "${st}" -type f -print0)
  printf './MANIFEST.copy.json\t-\0./manifest.json\t-\0' >>"${recs}"
  local payf="${st}.pay"
  : >"${payf}"
  while IFS= read -r -d '' r; do
    local p="${r%%$'\t'*}" s="${r#*$'\t'}"
    [[ "${s}" == "-" ]] && s=null
    printf '%s\n%s\n' "${p}" "${s}" >>"${payf}"
  done < <(LC_ALL=C sort -z -t $'\t' -k1,1 <"${recs}")
  local merkle mc
  merkle="$(sha256sum <"${payf}" | cut -d' ' -f1)"
  mc=$((se + 2))
  [[ "${variant}" == *" bad-merkle "* ]] && merkle="deadbeef${merkle:8}"
  [[ "${variant}" == *" bad-count "* ]] && mc=$((mc + 7))
  cat >"${st}/manifest.json" <<EOF
{"kind":"vanblog-full-backup","version":1,"createdAt":"2026-09-17T05:00:00.000Z","format":"zstd",
"databases":{"vanBlog":{"collections":{"articles":{"count":3,"bytes":300,"indexes":0},"users":{"count":1,"bytes":60,"indexes":0},"revisions":{"count":2,"bytes":110,"indexes":0},"migrations":{"count":1,"bytes":50,"indexes":0},"drafts":{"count":1,"bytes":50,"indexes":0},"categories":{"count":1,"bytes":60,"indexes":0},"metas":{"count":1,"bytes":200,"indexes":0},"settings":{"count":1,"bytes":40,"indexes":0}}}},
"static":{"img":{"files":${img_n},"bytes":20},"themes":{"files":1,"bytes":8}},
"totals":{"databases":1,"collections":8,"documents":11,"files":$((img_n + 1)),"staticBytes":28,"archiveBytes":1},
"integrity":{"algorithm":"sha256","zstdFrameChecksum":true,"merkleRoot":"${merkle}","memberCount":${mc},"members":{${memjson},"./MANIFEST.copy.json":null,"./manifest.json":null}},
"source":{"codeVersion":"test-fixture","walineDB":"waline","demo":false}}
EOF
  cp "${st}/manifest.json" "${st}/MANIFEST.copy.json"
  [[ "${variant}" == *" copy-mismatch "* ]] && echo 'tamper' >>"${st}/MANIFEST.copy.json"
  [[ "${variant}" == *" missing-copy "* ]] && rm -f "${st}/MANIFEST.copy.json"
  [[ "${variant}" == *" corrupt-content "* ]] && echo 'tampered' >>"${st}/static/img/a.webp"
  [[ "${variant}" == *" tamper-sha "* ]] && sed -i '0,/"sha256":"/s/"sha256":"[0-9a-f]/"sha256":"f/' "${st}/manifest.json"
  (cd "${st}" && tar -cf - .) | zstd -19 --long=27 -q -o "${dest}"
  local rc=$?
  rm -rf "${st}" "${recs}" "${payf}"
  return ${rc}
}

IG="${BK}/vanblog-full-20260917-110000.tar.zst"
make_integrity_archive "${IG}"
if [[ ! -s "${IG}" ]]; then
  echo "造不出 integrity 归档，A16 之后的用例没意义"
  echo "passed=${PASS} failed=1"
  exit 1
fi
# ⚠️ verify_semantic_one 必须在**当前 shell** 里调：INTEG_* 是全局变量，
#    命令替换是子 shell，结论会丢（MANIFEST_SOURCE 踩过的那个坑）
verify_semantic_one "${IG}" >"${TEST_DIR}/ig1.out" 2>&1
RC=$?
IGOUT="$(cat "${TEST_DIR}/ig1.out")"
assert_rc "${RC}" "0" "带 integrity 块的好归档 → 语义校验通过"
assert_contains "${IGOUT}" "语义 PASS 成员级哈希" "跑了逐成员哈希比对"
assert_contains "${IGOUT}" "merkleRoot 与 members 表重算一致" "merkleRoot 重算比对过"
assert_contains "${IGOUT}" "双清单一致" "两份清单逐字节对照过"
assert_contains "${IGOUT}" "memberCount=" "memberCount 与实际条目数对过账"
assert_contains "${IGOUT}" "zstdFrameChecksum=true" "报告了帧校验和状态（说明 zstd -t 那层护住了什么）"
assert_eq "${INTEG_MODE}" "full" "INTEG_MODE=full"
if [[ "${INTEG_HASHED}" -ge 9 ]]; then
  pass "实际比对了 ${INTEG_HASHED} 个成员哈希（含 C2 9B 控制字符名的那个）"
else
  fail "只比对了 ${INTEG_HASHED} 个成员（期望 ≥9）"
fi
assert_eq "${INTEG_MISMATCH}" "0" "零哈希不符"
assert_eq "${INTEG_MISSING}" "0" "零缺失成员（控制字符名没有造成假缺失）"
assert_eq "${INTEG_UNEXPECTED}" "0" "零多余成员"
assert_eq "${INTEG_MERKLE}" "ok" "merkle=ok"
assert_eq "${INTEG_COPY}" "ok" "copy=ok"
assert_eq "${INTEG_COUNT}" "ok" "memberCount=ok"
assert_contains "${IGOUT}" "没有任何参照可比" "没有 sidecar/status 时明说整归档 sha256「跳过，不是通过」"

# corrupt-content：zstd -t 过得了（帧校验和护不住"解得开但内容不对"），只有成员哈希抓得到
IGC="${BK}/vanblog-full-20260917-110001.tar.zst"
make_integrity_archive "${IGC}" corrupt-content
verify_semantic_one "${IGC}" >"${TEST_DIR}/ig2.out" 2>&1
RC=$?
IGCOUT="$(cat "${TEST_DIR}/ig2.out")"
assert_rc "${RC}" "1" "内容被改（哈希不符）→ 非 0 退出"
assert_contains "${IGCOUT}" "zstd 完整性 ✓" "帧级完整性测试**通过**（这正是需要成员哈希的理由）"
assert_contains "${IGCOUT}" "第一个坏成员" "报的是第一个坏成员的路径，不是笼统一句 corrupt"
assert_contains "${IGCOUT}" "./static/img/a.webp" "点名了坏成员"
assert_contains "${IGCOUT}" "期望" "给了期望 vs 实际两个哈希"
assert_contains "${IGCOUT}" "静态文件" "说明了坏的是什么类型的数据（图 vs 数据库 dump，处置方式不同）"
assert_eq "${INTEG_BAD_KIND}" "hash" "BAD_KIND=hash"

# tamper-sha：清单表里的一个哈希被改 → merkleRoot 必须抓住（表自身的指纹）
IGT="${BK}/vanblog-full-20260917-110002.tar.zst"
make_integrity_archive "${IGT}" tamper-sha
verify_semantic_one "${IGT}" >"${TEST_DIR}/ig3.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "清单哈希表被篡改 → 非 0"
assert_contains "$(cat "${TEST_DIR}/ig3.out")" "merkleRoot 对不上" "merkleRoot 抓住了表篡改"

# bad-merkle
IGM="${BK}/vanblog-full-20260917-110003.tar.zst"
make_integrity_archive "${IGM}" bad-merkle
verify_semantic_one "${IGM}" >"${TEST_DIR}/ig4.out" 2>&1
assert_rc "$?" "1" "merkleRoot 本身被改 → 非 0"
assert_contains "$(cat "${TEST_DIR}/ig4.out")" "merkleRoot 对不上" "点名 merkleRoot"

# copy-mismatch：双清单互为对照
IGX="${BK}/vanblog-full-20260917-110004.tar.zst"
make_integrity_archive "${IGX}" copy-mismatch
verify_semantic_one "${IGX}" >"${TEST_DIR}/ig5.out" 2>&1
assert_rc "$?" "1" "MANIFEST.copy.json 与 manifest.json 不一致 → 非 0（本身就是发现）"
assert_contains "$(cat "${TEST_DIR}/ig5.out")" "双清单不一致" "点名双清单不一致"
assert_contains "$(cat "${TEST_DIR}/ig5.out")" "至少一份坏了" "说清了含义"

# missing-copy：新格式却没有副本
IGP="${BK}/vanblog-full-20260917-110005.tar.zst"
make_integrity_archive "${IGP}" missing-copy
verify_semantic_one "${IGP}" >"${TEST_DIR}/ig6.out" 2>&1
assert_rc "$?" "1" "缺 ./MANIFEST.copy.json → 非 0"
assert_contains "$(cat "${TEST_DIR}/ig6.out")" "MANIFEST.copy.json" "点名缺的是清单副本"

# bad-count
IGB="${BK}/vanblog-full-20260917-110006.tar.zst"
make_integrity_archive "${IGB}" bad-count
verify_semantic_one "${IGB}" >"${TEST_DIR}/ig7.out" 2>&1
assert_rc "$?" "1" "memberCount 对不上 → 非 0"
assert_contains "$(cat "${TEST_DIR}/ig7.out")" "归档实际列出" "两个数字都打出来"

# newline-name：成员名里带真换行 —— 既不许假不符，也不许假通过
IGN="${BK}/vanblog-full-20260917-110007.tar.zst"
make_integrity_archive "${IGN}" newline-name
verify_semantic_one "${IGN}" >"${TEST_DIR}/ig8.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "带换行成员名的归档 → 校验通过（NUL 记录路径不吃行式解析的亏）"
assert_eq "${INTEG_MISSING}" "0" "换行名没有造成假「缺失」"
assert_eq "${INTEG_UNEXPECTED}" "0" "换行名没有造成假「多余」"
assert_contains "$(cat "${TEST_DIR}/ig8.out")" "成员名里带换行" "但如实报告了换行名的存在（不静默）"

# 旧归档（没有 integrity 块）：一切照旧 + **明确的 NOTE**
verify_semantic_one "${GOOD}" >"${TEST_DIR}/ig9.out" 2>&1
RC=$?
IG9="$(cat "${TEST_DIR}/ig9.out")"
assert_rc "${RC}" "0" "旧归档照常通过（additive：老归档仍然有效）"
assert_contains "${IG9}" "成员级哈希校验**不可用**" "明说成员级校验不可用"
assert_contains "${IG9}" "别把 PASS 读成比它更强" "明说这个 PASS 不代表逐成员比对过"
assert_eq "${INTEG_MODE}" "unavailable" "INTEG_MODE=unavailable"

# 中段字节翻转：帧校验和/解压必须抓住
IGF="${BK}/vanblog-full-20260917-110008.tar.zst"
cp "${IG}" "${IGF}"
IGFSZ="$(wc -c <"${IGF}")"
printf '\xff' | dd of="${IGF}" bs=1 seek=$((IGFSZ / 2)) count=1 conv=notrunc status=none
verify_semantic_one "${IGF}" >"${TEST_DIR}/ig10.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "中段字节翻转 → 非 0"
if grep -qE "完整性校验失败|解不完整|FAIL" "${TEST_DIR}/ig10.out"; then
  pass "字节翻转被点名（帧校验和失败或解不完整）"
else
  fail "字节翻转没被点名"
fi
rm -f "${IGF}"

# merkle 单元：drill_compute_merkle 必须与「独立实现」（fixture 里那份 python 风格重算）一致
MJ_IG="$(drill_archive_member "${IG}" "./manifest.json")"
DECL_BIN="${TEST_DIR}/decl.bin"
drill_integrity_members "${MJ_IG}" >"${DECL_BIN}"
DECL_N=$(( $(tr -dc '\0' <"${DECL_BIN}" | wc -c) ))
if [[ "${DECL_N}" -ge 11 ]]; then
  pass "drill_integrity_members 解析出 ${DECL_N} 条成员记录（NUL 分隔）"
else
  fail "drill_integrity_members 只解析出 ${DECL_N} 条（期望 ≥11）"
fi
CALC_MERKLE="$(drill_compute_merkle "${DECL_BIN}")"
DECL_MERKLE="$(json_get "${MJ_IG}" integrity.merkleRoot)"
assert_eq "${CALC_MERKLE}" "${DECL_MERKLE}" "drill_compute_merkle 复现 fixture 独立算出的 merkleRoot（与 server computeMerkleRoot 同构）"

# 非 GNU tar 宿主机（busybox tar 没有 --to-command）：退化成「解包到临时目录逐文件哈希」，
# 结论必须与流式路径**一致**（子 shell 里覆盖 is_gnu_tar，不污染后面的用例）
EXTRACT_RES="$(
  is_gnu_tar() { return 1; }
  drill_archive_integrity "${IG}" "${MJ_IG}" >"${TEST_DIR}/ig-extract.out" 2>&1
  echo "rc=$? mode=${INTEG_MODE} engine=${HASH_ENGINE} hashed=${INTEG_HASHED} mismatch=${INTEG_MISMATCH} copy=${INTEG_COPY} count=${INTEG_COUNT}"
)"
assert_contains "${EXTRACT_RES}" "rc=0" "非 GNU tar 退化路径：好归档照样通过"
assert_contains "${EXTRACT_RES}" "engine=extract" "退化路径确实走了解包比对（不是悄悄跳回流式）"
assert_contains "${EXTRACT_RES}" "mode=full" "退化路径也是完整的成员级校验"
assert_contains "${EXTRACT_RES}" "hashed=11" "退化路径比对了全部 11 个带哈希成员"
assert_contains "${EXTRACT_RES}" "mismatch=0" "退化路径零误报"
MJ_IGC="$(drill_archive_member "${IGC}" "./manifest.json")"
EXTRACT_BAD="$(
  is_gnu_tar() { return 1; }
  drill_archive_integrity "${IGC}" "${MJ_IGC}" >"${TEST_DIR}/ig-extract-bad.out" 2>&1
  echo "rc=$? bad=${INTEG_BAD_PATH} kind=${INTEG_BAD_KIND}"
)"
assert_contains "${EXTRACT_BAD}" "rc=1" "非 GNU tar 退化路径同样抓住内容损坏"
assert_contains "${EXTRACT_BAD}" "bad=./static/img/a.webp" "退化路径点名的坏成员与流式路径一致"
IGN_NL="$(drill_archive_member "${IGN}" "./manifest.json")"
EXTRACT_NL="$(
  is_gnu_tar() { return 1; }
  drill_archive_integrity "${IGN}" "${IGN_NL}" >"${TEST_DIR}/ig-extract-nl.out" 2>&1
  echo "rc=$? missing=${INTEG_MISSING} unexpected=${INTEG_UNEXPECTED}"
)"
assert_contains "${EXTRACT_NL}" "rc=0" "退化路径对换行成员名也没有假不符（find -print0 全程 NUL 分隔）"
# raw 成员名列表：⚠️ 桩环境是「宿主机 GNU tar + is_gnu_tar=false」的组合 ——
# 靠的是对 --quoting-style=literal 的**能力探测**，不是按 tar 品牌猜（品牌猜不出这种组合）
RAW_OUT="$(drill_archive_members_raw "${IG}")"
assert_contains "${RAW_OUT}" "./db/vanBlog/metas.ndjson" "raw 列表列得出普通成员"
if printf '%s' "${RAW_OUT}" | grep -q $'weird-\302\233-x.webp'; then
  pass "raw 列表保住了成员名里的 C2 9B 控制字节（tar -tf 默认渲染会转义成文本，拿去比对就冤枉好归档）"
else
  fail "raw 列表里的控制字节丢了/被转义了"
fi
assert_eq "$(printf '%s' './a\302\233b.webp' | drill_unescape_tar_names)" "$(printf './a\302\233b.webp')" "反转义：\\302\\233 → 原始字节（老 GNU tar 渲染形状的兜底）"
assert_eq "$(printf '%s' './a\nb' | drill_unescape_tar_names)" "$(printf './a\nb')" "反转义：字面量 \\n → 真换行"
assert_eq "$(printf '%s' 'plain-name.webp' | drill_unescape_tar_names)" "plain-name.webp" "反转义：普通名字原样通过"

# ══════════════════════════ A17) 整归档 sha256 的外部参照 ══════════════════════════
echo
echo "-- 整归档 sha256：sidecar / backup-status.json 参照，明说用了哪个 --"
SR="${TEST_DIR}/sharefs"
mkdir -p "${SR}"
cp "${IG}" "${SR}/vanblog-full-20260917-111000.tar.zst"
SRA="${SR}/vanblog-full-20260917-111000.tar.zst"
SRSHA="$(sha256sum <"${SRA}" | cut -d' ' -f1)"
drill_archive_sha_refs "${SRA}" >"${TEST_DIR}/sr0.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "没有任何参照 → 返回 0（但明说跳过）"
assert_contains "$(cat "${TEST_DIR}/sr0.out")" "跳过**，不是通过" "无参照时不冒充通过"
printf '%s  %s\n' "${SRSHA}" "vanblog-full-20260917-111000.tar.zst" >"${SRA}.sha256"
drill_archive_sha_refs "${SRA}" >"${TEST_DIR}/sr1.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "sidecar 一致 → 0"
assert_contains "$(cat "${TEST_DIR}/sr1.out")" "用的参照：sidecar" "明说这次用的参照是 sidecar"
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "vanblog-full-20260917-111000.tar.zst" >"${SRA}.sha256"
drill_archive_sha_refs "${SRA}" >"${TEST_DIR}/sr2.out" 2>&1
assert_rc "$?" "1" "sidecar 不符 → 非 0（内容被改过/损坏）"
assert_contains "$(cat "${TEST_DIR}/sr2.out")" "sidecar 不符" "点名 sidecar 不符"
printf '%s  %s\n' "${SRSHA}" "vanblog-full-RENAMED.tar.zst" >"${SRA}.sha256"
drill_archive_sha_refs "${SRA}" >"${TEST_DIR}/sr3.out" 2>&1
assert_contains "$(cat "${TEST_DIR}/sr3.out")" "sidecar 里记的文件名" "sidecar 名字对不上时提醒（可能配错对象）"
cat >"${SR}/backup-status.json" <<EOF
{"version":1,"lastSuccessName":"vanblog-full-20260917-111000.tar.zst","lastSuccessBytes":$(wc -c <"${SRA}"),"lastSuccessSha256":"${SRSHA}","consecutiveFailures":0}
EOF
rm -f "${SRA}.sha256"
drill_archive_sha_refs "${SRA}" >"${TEST_DIR}/sr4.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "backup-status.json 参照一致 → 0"
assert_contains "$(cat "${TEST_DIR}/sr4.out")" "lastSuccessSha256 一致" "认出了 server 记的整归档 sha256"
assert_contains "$(cat "${TEST_DIR}/sr4.out")" "用的参照：backup-status.json" "明说用的参照"
cat >"${SR}/backup-status.json" <<EOF
{"version":1,"lastSuccessName":"vanblog-full-20260917-111000.tar.zst","lastSuccessSha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}
EOF
drill_archive_sha_refs "${SRA}" >"${TEST_DIR}/sr5.out" 2>&1
assert_rc "$?" "1" "server 参照不符 → 非 0（盘上这份不是 server 写的那份）"

# ══════════════════════════ A18) verify --all：每归档表 + 机器可读行 + 台账 ══════════════════════════
echo
echo "-- verify --all：全量复验、每归档表、VERIFY-RESULT、台账每归档一行 --"
AD="${TEST_DIR}/alldir"
mkdir -p "${AD}"
cp "${IG}" "${AD}/vanblog-full-20260917-110000.tar.zst"
cp "${GOOD}" "${AD}/vanblog-full-20260916-010101.tar.zst"
cp "${IGC}" "${AD}/vanblog-full-20260917-110001.tar.zst"
VANBLOG_BACKUP_DIR="${AD}" run_cli verify --all >"${TEST_DIR}/va1.out" 2>&1
RC=$?
VA1="$(cat "${TEST_DIR}/va1.out")"
assert_rc "${RC}" "1" "--all：其中一份坏（corrupt-content）→ 非 0"
assert_contains "${VA1}" "每归档结果" "打了每归档的表"
assert_contains "${VA1}" "成员哈希" "表里有成员哈希列"
assert_contains "${VA1}" "checked" "好归档标 checked（真的逐成员比过）"
assert_contains "${VA1}" "no-integrity" "旧归档标 no-integrity（没比过就是没比过）"
assert_contains "${VA1}" "VERIFY-RESULT total=3 ok=2 fail=1" "机器可读的最后一行（cron 可解析）"
LEDGER_LINES="$(grep -c '"kind":"verify"' "${AD}/vanblog-verify-log.jsonl" 2>/dev/null || true)"
assert_eq "${LEDGER_LINES}" "3" "台账每归档一行（3 行）"
if grep -q '"hashMode":"checked"' "${AD}/vanblog-verify-log.jsonl" 2>/dev/null; then
  pass "台账行里带 hashMode（复验记录能回答「比没比过成员哈希」）"
else
  fail "台账行里没有 hashMode"
fi
if grep -q '"badMember":"./static/img/a.webp"' "${AD}/vanblog-verify-log.jsonl" 2>/dev/null; then
  pass "失败行里带 badMember（第一个坏成员进了台账）"
else
  fail "失败行里没有 badMember"
fi
GLOB_N="$(cd "${AD}" && ls -1 vanblog-full-* 2>/dev/null | grep -vE '\.(sha256|manifest\.json)$' | grep -c .)"
assert_eq "${GLOB_N}" "3" "台账/sidecar 依然不会被 vanblog-full-* 枚举当成归档（保留策略不会多删）"
# --all 与显式目标并用：去重
VANBLOG_BACKUP_DIR="${AD}" run_cli verify --all "${AD}/vanblog-full-20260917-110000.tar.zst" >"${TEST_DIR}/va2.out" 2>&1
assert_contains "$(cat "${TEST_DIR}/va2.out")" "VERIFY-RESULT total=3" "--all + 显式目标：去重后还是 3 份"

# ══════════════════════════ A19) drill 预检：坏了拒绝、--skip-hash 明说 ══════════════════════════
echo
echo "-- drill 预检：成员级损坏 → 拒绝演练（不起容器）；--skip-hash → WARN --"
# ⚠️ A11 结尾把 fakeengine 换成了「一律撞名」的桩：这里必须换回宽松版，
#    否则所有 dry-run 都死在名字冲突上，测不到完整性预检（本轮真踩过）
cat >"${FAKE_BIN}/fakeengine" <<'STUB'
#!/usr/bin/env bash
echo "fakeengine $*" >> "${FAKE_ENGINE_LOG}"
case "$1" in
  --version) echo "fakeengine version 9.9.9 (stub)" ;;
  info) exit 0 ;;
  image) [[ "$2" == "inspect" ]] && { [[ "${FAKE_NO_IMAGE:-0}" == "1" ]] && exit 1; exit 0; } ;;
  inspect)
    case "$*" in
      *"--type container"*) [[ "${FAKE_COLLIDE:-}" != "" && "$*" == *"${FAKE_COLLIDE}"* ]] && exit 0; exit 1 ;;
      *) echo "10.99.0.7"; exit 0 ;;
    esac ;;
  volume|network) [[ "$2" == "inspect" ]] && exit 1; exit 0 ;;
  run) echo "fakecontainerid"; exit 0 ;;
  exec) echo "1"; exit 0 ;;
  logs) echo "server started ok" ;;
  rm|pull) exit 0 ;;
esac
exit 0
STUB
chmod +x "${FAKE_BIN}/fakeengine"
CD="${TEST_DIR}/corrdir"
mkdir -p "${CD}"
cp "${IGC}" "${CD}/vanblog-full-20260917-112000.tar.zst"
: >"${FAKE_LOG}"
# ⚠️ 不是 --dry-run：dry-run 故意不解包（内容哈希无从比起），拒绝内容损坏要靠真跑的预检
PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${CD}" \
  run_cli drill --image vanblog:test "${CD}/vanblog-full-20260917-112000.tar.zst" >"${TEST_DIR}/cd1.out" 2>&1
RC=$?
CD1="$(cat "${TEST_DIR}/cd1.out")"
assert_rc "${RC}" "1" "成员哈希不符的归档：预检就拒绝（非 0，不起容器不上传）"
assert_contains "${CD1}" "预检：成员级哈希校验" "点名了成员级校验这条断言"
assert_contains "${CD1}" "拒绝演练" "明说拒绝演练而不是硬上传"
assert_contains "${CD1}" "./static/img/a.webp" "拒绝时点名第一个坏成员"
assert_eq "$(grep -cE 'fakeengine (run |network create)' "${FAKE_LOG}" 2>/dev/null)" "0" "拒绝时一条容器命令都没发"
# bad-merkle：dry-run 也拦（merkle 不需要解包）
MD="${TEST_DIR}/merkledir"
mkdir -p "${MD}"
cp "${IGM}" "${MD}/vanblog-full-20260917-112001.tar.zst"
PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${MD}" \
  run_cli drill --dry-run --image vanblog:test "${MD}/vanblog-full-20260917-112001.tar.zst" >"${TEST_DIR}/cd2.out" 2>&1
assert_rc "$?" "1" "merkleRoot 不符：dry-run 也拦（清单自身矛盾，不用解包就知道）"
# 好归档 + dry-run：merkle 查、解包比对不做（明说）
GD="${TEST_DIR}/goodir"
mkdir -p "${GD}"
cp "${IG}" "${GD}/vanblog-full-20260917-112002.tar.zst"
PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${GD}" \
  run_cli drill --dry-run --image vanblog:test "${GD}/vanblog-full-20260917-112002.tar.zst" >"${TEST_DIR}/cd3.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "好归档 dry-run → 0"
assert_contains "$(cat "${TEST_DIR}/cd3.out")" "merkleRoot 与 members 表重算一致" "dry-run 也查了 merkleRoot"
assert_contains "$(cat "${TEST_DIR}/cd3.out")" "dry-run：不解包比对" "并明说 dry-run 不解包（不冒充比过）"
PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${GD}" \
  run_cli drill --dry-run --skip-hash --image vanblog:test "${GD}/vanblog-full-20260917-112002.tar.zst" >"${TEST_DIR}/cd4.out" 2>&1
assert_rc "$?" "0" "--skip-hash → 0（但下面这条 WARN 必须在）"
assert_contains "$(cat "${TEST_DIR}/cd4.out")" "--skip-hash" "明说哈希比对被 --skip-hash 跳过了"
# 旧归档（无 integrity）：预检不拦，但 PASS 行必须自报「未校验」
OD="${TEST_DIR}/olddir"
mkdir -p "${OD}"
cp "${GOOD}" "${OD}/vanblog-full-20260916-010101.tar.zst"
PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${OD}" \
  run_cli drill --dry-run --image vanblog:test "${OD}/vanblog-full-20260916-010101.tar.zst" >"${TEST_DIR}/cd5.out" 2>&1
assert_rc "$?" "0" "旧归档 dry-run → 0（照常演练）"
assert_contains "$(cat "${TEST_DIR}/cd5.out")" "没有 integrity 块" "但 PASS 里如实说成员哈希没校验过"
# 中段翻转的旧归档：流式完整性预检拦下（不起容器）
FD="${TEST_DIR}/flipdir"
mkdir -p "${FD}"
cp "${GOOD}" "${FD}/vanblog-full-20260916-010102.tar.zst"
FSZ="$(wc -c <"${FD}/vanblog-full-20260916-010102.tar.zst")"
printf '\xff' | dd of="${FD}/vanblog-full-20260916-010102.tar.zst" bs=1 seek=$((FSZ / 2)) count=1 conv=notrunc status=none
: >"${FAKE_LOG}"
PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${FD}" \
  run_cli drill --image vanblog:test "${FD}/vanblog-full-20260916-010102.tar.zst" >"${TEST_DIR}/cd6.out" 2>&1
RC=$?
CD6="$(cat "${TEST_DIR}/cd6.out")"
assert_rc "${RC}" "1" "中段字节翻转的旧归档 → drill 非 0"
if printf '%s' "${CD6}" | grep -qE "流式完整性|清单读得出来"; then
  pass "预检就点名了损坏（帧级完整性失败，或清单都读不出来）"
else
  fail "预检没有点名损坏（输出里既没有流式完整性也没有清单）"
fi
assert_eq "$(grep -cE 'fakeengine (run |network create)' "${FAKE_LOG}" 2>/dev/null)" "0" "预检拒绝：一条容器命令都没发（不是半恢复，是根本不开始）"
# --skip-preflight 时流式检查必须让路（那条路的用途是演练 server 护栏）
PATH="${FAKE_BIN}:${PATH}" VANBLOG_DRILL_ENGINE=fakeengine VANBLOG_BACKUP_DIR="${FD}" VANBLOG_DRILL_TIMEOUT=3 \
  run_cli drill --skip-preflight --image vanblog:test "${FD}/vanblog-full-20260916-010102.tar.zst" >"${TEST_DIR}/cd7.out" 2>&1
assert_contains "$(cat "${TEST_DIR}/cd7.out")" "skip-preflight" "--skip-preflight 时明说预检被跳过（既有语义不变）"

# ══════════════════════════ A20) 定期复验护栏（--reverify-days）══════════════════════
echo
echo "-- 定期复验护栏：任何归档太久没「验证通过」就要在日程上炸出来 --"
RV="${TEST_DIR}/reverify"
mkdir -p "${RV}"
cp "${IG}" "${RV}/vanblog-full-20260917-113000.tar.zst"
cp "${GOOD}" "${RV}/vanblog-full-20260916-113001.tar.zst"
VANBLOG_BACKUP_DIR="${RV}" run_cli backup-status --reverify-days 30 >"${TEST_DIR}/rv1.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "台账里没有任何「验证通过」记录 → 护栏失败（非 0）"
assert_contains "$(cat "${TEST_DIR}/rv1.out")" "没有「验证通过」记录" "点名了缺什么"
assert_contains "$(cat "${TEST_DIR}/rv1.out")" "backup-verify --all" "给了补救命令"
VANBLOG_BACKUP_DIR="${RV}" drill_verify_log_append verify "${RV}/vanblog-full-20260917-113000.tar.zst" pass ""
VANBLOG_BACKUP_DIR="${RV}" drill_verify_log_append verify "${RV}/vanblog-full-20260916-113001.tar.zst" pass ""
VANBLOG_BACKUP_DIR="${RV}" run_cli backup-status --reverify-days 30 >"${TEST_DIR}/rv2.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "两份都有新鲜的 pass 记录 → 护栏通过"
assert_contains "$(cat "${TEST_DIR}/rv2.out")" "全部 2 份归档都在 30 天内复验过" "报出了份数与判据"
# 把其中一份的台账时间改老（40 天前）
OLD_AT="$(date -u -d '40 days ago' '+%Y-%m-%dT%H:%M:%SZ')"
sed -i "s|\"archive\":\"vanblog-full-20260916-113001.tar.zst\",\"at\":\"[^\"]*\"|\"archive\":\"vanblog-full-20260916-113001.tar.zst\",\"at\":\"${OLD_AT}\"|" "${RV}/vanblog-verify-log.jsonl"
VANBLOG_BACKUP_DIR="${RV}" run_cli backup-status --reverify-days 30 >"${TEST_DIR}/rv3.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "一份归档 40 天没复验 → 护栏失败（位腐烂要在日程上被发现）"
assert_contains "$(cat "${TEST_DIR}/rv3.out")" "vanblog-full-20260916-113001.tar.zst（上次验证 4" "点名了过期的是哪份、多久没验"
VANBLOG_BACKUP_DIR="${RV}" run_cli backup-status --reverify-days 0 >"${TEST_DIR}/rv4.out" 2>&1
assert_rc "$?" "0" "--reverify-days 0 → 关闭护栏（默认行为不变）"
assert_contains "$(cat "${TEST_DIR}/rv4.out")" "定期复验护栏关闭" "关闭时明说，不假装查过"

# ══════════════════════════ A21) backup-verify --all ══════════════════════════
echo
echo "-- backup-verify --all：备份 + 全量复验（每归档一行台账 + 表）--"
BV5="${TEST_DIR}/bv5"
mkdir -p "${BV5}"
cp "${IG}" "${BV5}/vanblog-full-20260917-114000.tar.zst"
cp "${IGC}" "${BV5}/vanblog-full-20260917-114001.tar.zst"
cat >"${TEST_DIR}/bv5.sh" <<EOF
set -u
export VANBLOG_DRILL_SKIP_MAIN=1 VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${BV5}"
source "${SCRIPT}" >/dev/null 2>&1
backup() { cp "${GOOD}" "${BV5}/vanblog-full-20260917-114002.tar.zst"; echo "整站备份成功"; return 0; }
cmd_backup_verify "\$@"
EOF
bash "${TEST_DIR}/bv5.sh" --all >"${TEST_DIR}/bv5.out" 2>&1
RC=$?
BV5OUT="$(cat "${TEST_DIR}/bv5.out")"
assert_rc "${RC}" "1" "--all：保留归档里有一份坏 → 非 0（哪怕这次的新备份是好的）"
assert_contains "${BV5OUT}" "全量复验" "跑了全量复验"
assert_contains "${BV5OUT}" "每归档结果" "打了每归档的表"
assert_contains "${BV5OUT}" "RESULT: FAIL" "机器可读结论行是 FAIL"
BV5_LEDGER_N="$(grep -c '"result"' "${BV5}/vanblog-verify-log.jsonl" 2>/dev/null || true)"
if [[ "${BV5_LEDGER_N}" -ge 3 ]]; then
  pass "台账里每归档一行（${BV5_LEDGER_N} 行 ≥3：新归档 + 两份保留归档）"
else
  fail "台账只有 ${BV5_LEDGER_N} 行（期望 ≥3）"
fi
BV6="${TEST_DIR}/bv6"
mkdir -p "${BV6}"
cp "${IG}" "${BV6}/vanblog-full-20260917-114000.tar.zst"
cat >"${TEST_DIR}/bv6.sh" <<EOF
set -u
export VANBLOG_DRILL_SKIP_MAIN=1 VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${BV6}"
source "${SCRIPT}" >/dev/null 2>&1
backup() { cp "${GOOD}" "${BV6}/vanblog-full-20260917-114003.tar.zst"; echo "整站备份成功"; return 0; }
cmd_backup_verify "\$@"
EOF
bash "${TEST_DIR}/bv6.sh" --all --reverify-days 30 >"${TEST_DIR}/bv6.out" 2>&1
RC=$?
assert_rc "${RC}" "0" "--all 之后每份都有新鲜 pass 记录 → --reverify-days 30 也通过"
assert_contains "$(cat "${TEST_DIR}/bv6.out")" "全部 2 份归档都在 30 天内复验过" "护栏在 --all 之后自然变绿"

# ══════════════════════════ A22) backup-status 的新字段 ══════════════════════════
echo
echo "-- backup-status：整归档 sha256 / sweep / 恢复日志 / 三方不一致 --"
NS="${TEST_DIR}/newstatus"
mkdir -p "${NS}"
cp "${IG}" "${NS}/vanblog-full-20260917-115000.tar.zst"
NSA="${NS}/vanblog-full-20260917-115000.tar.zst"
NSSHA="$(sha256sum <"${NSA}" | cut -d' ' -f1)"
NSBYTES="$(wc -c <"${NSA}")"
printf '%s  %s\n' "${NSSHA}" "vanblog-full-20260917-115000.tar.zst" >"${NSA}.sha256"
cat >"${NS}/backup-status.json" <<EOF
{"version":1,"updatedAt":"2026-09-17T03:00:00.000Z","lastSuccessAt":"2026-09-17T03:00:00.000Z",
 "lastSuccessName":"vanblog-full-20260917-115000.tar.zst","lastSuccessBytes":${NSBYTES},
 "lastVerifyMs":900,"lastSuccessSha256":"${NSSHA}","lastSuccessMembers":20,
 "lastFailureStage":null,"consecutiveFailures":0,
 "lastSweepAt":"2026-09-17T02:00:00.000Z","lastSweepMs":1400,"lastSweepArchives":2,"lastSweepFailures":0,
 "lastSweepResults":[{"name":"vanblog-full-20260917-115000.tar.zst","ok":true,"ms":900,"bytes":${NSBYTES},"membersChecked":18,"issues":[]}],
 "lastSweepMessage":null,"sweepIntervalHours":24,"sweepMaxArchives":3,"restoreJournal":null}
EOF
VANBLOG_BACKUP_DIR="${NS}" run_cli backup-status >"${TEST_DIR}/ns1.out" 2>&1
RC=$?
NS1="$(cat "${TEST_DIR}/ns1.out")"
assert_rc "${RC}" "0" "全部一致 → 0"
assert_contains "${NS1}" "盘上重算与 server 记录一致" "整归档 sha256 三方对账（盘上重算 vs server vs sidecar）"
assert_contains "${NS1}" "sidecar 也一致" "sidecar 也参与了对账"
assert_contains "${NS1}" "server 定期复验（sweep）没有发现坏归档" "报出了 sweep"
assert_contains "${NS1}" "节奏 24h" "报出了 sweep 的节奏与上限（运维不用翻 env）"
assert_contains "${NS1}" "没有悬着的恢复日志" "查了 restore-journal"
# sha 不符 → WARN
cat >"${NS}/backup-status.json" <<EOF
{"version":1,"lastSuccessAt":"2026-09-17T03:00:00.000Z","lastSuccessName":"vanblog-full-20260917-115000.tar.zst",
 "lastSuccessBytes":${NSBYTES},"lastSuccessSha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","consecutiveFailures":0}
EOF
VANBLOG_BACKUP_DIR="${NS}" run_cli backup-status >"${TEST_DIR}/ns2.out" 2>&1
assert_contains "$(cat "${TEST_DIR}/ns2.out")" "盘上这份不是 server 当时写的那份" "server 记的 sha256 与盘上不符 → 点名（截断/替换/拷贝损坏）"
# sweep 有失败 → FAIL + 明细
cat >"${NS}/backup-status.json" <<EOF
{"version":1,"lastSuccessAt":"2026-09-17T03:00:00.000Z","lastSuccessName":"vanblog-full-20260917-115000.tar.zst",
 "lastSuccessBytes":${NSBYTES},"lastSuccessSha256":"${NSSHA}","consecutiveFailures":0,
 "lastSweepAt":"2026-09-17T02:00:00.000Z","lastSweepArchives":2,"lastSweepFailures":1,
 "lastSweepResults":[{"name":"vanblog-full-20260916-010101.tar.zst","ok":false,"ms":12,"bytes":1,"membersChecked":null,"issues":["zstd 完整性校验失败"]}],
 "sweepIntervalHours":24,"sweepMaxArchives":3}
EOF
VANBLOG_BACKUP_DIR="${NS}" run_cli backup-status >"${TEST_DIR}/ns3.out" 2>&1
RC=$?
assert_rc "${RC}" "1" "sweep 发现坏归档 → 非 0（位腐烂已经被 server 抓到了）"
assert_contains "$(cat "${TEST_DIR}/ns3.out")" "已经出现位腐烂" "说清了含义"
assert_contains "$(cat "${TEST_DIR}/ns3.out")" "zstd 完整性校验失败" "把 server 的失败明细带出来"
# 悬着的恢复日志 → WARN + 进度
cat >"${NS}/restore-journal.json" <<'EOF'
{"version":1,"startedAt":"2026-09-17T02:30:00.000Z","updatedAt":"2026-09-17T02:31:00.000Z",
 "archivePath":"/tmp/x.tar.zst","archiveName":"vanblog-full-20260917-115000.tar.zst","archiveCreatedAt":null,
 "hostname":"h","pid":1,"phase":"static","planned":{"vanBlog":["articles"]},"done":[{"db":"vanBlog","collection":"articles","documents":3,"at":"2026-09-17T02:30:30.000Z"}],"error":null}
EOF
VANBLOG_BACKUP_DIR="${NS}" run_cli backup-status >"${TEST_DIR}/ns4.out" 2>&1
NS4="$(cat "${TEST_DIR}/ns4.out")"
assert_contains "${NS4}" "上次恢复没有正常结束" "restore-journal.json 还在 → 点名（成功恢复会清掉它）"
assert_contains "${NS4}" "phase=static" "带出了 journal 的 phase（恢复走到了哪一步）"
assert_contains "${NS4}" "已换 1 个集合" "带出了已完成集合数"
rm -f "${NS}/restore-journal.json"
# 台账 vs 文件系统：最新 pass 记录不是盘上最新归档 → WARN
VANBLOG_BACKUP_DIR="${NS}" drill_verify_log_append verify "${NSA}" pass ""
cp "${GOOD}" "${NS}/vanblog-full-20260917-120000.tar.zst" # 更新的归档出现了（没人验过）
VANBLOG_BACKUP_DIR="${NS}" run_cli backup-status >"${TEST_DIR}/ns5.out" 2>&1
assert_contains "$(cat "${TEST_DIR}/ns5.out")" "最新这份还没被验证过" "台账最新 pass ≠ 盘上最新归档 → 三方不一致本身就是 WARN"
rm -f "${NS}/vanblog-full-20260917-120000.tar.zst"

# ══════════════════════════ A23) 纯断言帮手：数据往返 / 静态集合 / journal ══════════════════════════
echo
echo "-- 纯断言帮手（不起容器就能测）：往返 / 静态集合 / journal / 计数 --"
assert_reset
OUT="$(drill_assert_count_roundtrip revisions 2 2 "文章版本历史" 2>&1)"
assert_rc "$?" "0" "往返相等 → PASS"
assert_contains "${OUT}" "归档 2 条 == 恢复库 2 条" "两个数字都打出来"
assert_reset
OUT="$(drill_assert_count_roundtrip revisions 2 1 "" 2>&1)"
assert_rc "$?" "1" "往返不等 → FAIL"
assert_reset
OUT="$(drill_assert_count_roundtrip revisions absent 0 "" 2>&1)"
RC=$?
assert_rc "${RC}" "0" "归档没有该集合 + 恢复库 0 条 → NOTE（如实说明，不冒充通过）"
assert_eq "$(n_kind "${OUT}" "·")" "1" "记的是 NOTE"
assert_contains "${OUT}" "如实说明" "明说这不是静默跳过"
assert_reset
OUT="$(drill_assert_count_roundtrip revisions 2 "" "" 2>&1)"
RC=$?
assert_rc "${RC}" "0" "恢复库读不出条数 → WARN 而不是 FAIL（环境问题不冤枉归档）"
assert_eq "$(n_kind "${OUT}" WARN)" "1" "记的是 WARN"
assert_contains "${OUT}" "没有验证" "明说这项没有验证（不是通过）"
assert_reset
OUT="$(drill_assert_deleted_roundtrip 6 6 6 0 2>&1)"
assert_rc "$?" "0" "软删除往返相等 + deletedAt 齐全 → PASS"
assert_reset
OUT="$(drill_assert_deleted_roundtrip 6 6 5 0 2>&1)"
assert_rc "$?" "1" "回收站少了一条 → FAIL"
assert_reset
OUT="$(drill_assert_deleted_roundtrip 6 6 6 2 2>&1)"
assert_rc "$?" "1" "deletedAt 丢了 2 条 → FAIL"
assert_reset
OUT="$(drill_assert_deleted_roundtrip 0 0 0 0 2>&1)"
assert_contains "${OUT}" "空集对账" "0==0 时明说证明不了 deletedAt 行为（不冒充强结论）"
assert_reset
OUT="$(drill_assert_static_set 'static/img/a.webp
static/img/b.webp' 'static/img/a.webp
static/img/b.webp' 2>&1)"
assert_rc "$?" "0" "静态集合一致 → PASS"
assert_contains "${OUT}" "prune-on-restore 生效" "说明了这条证明的是先清后写"
assert_reset
OUT="$(drill_assert_static_set 'static/img/a.webp
static/img/b.webp' 'static/img/a.webp' 2>&1)"
assert_rc "$?" "1" "缺文件 → FAIL"
assert_contains "${OUT}" "static/img/b.webp" "点名缺的是哪个"
assert_reset
OUT="$(drill_assert_static_set 'static/img/a.webp' 'static/img/a.webp
static/img/old.webp' 2>&1)"
assert_rc "$?" "1" "多文件（merge 而不是 replace）→ FAIL"
assert_contains "${OUT}" "old.webp" "点名多出来的是哪个"
assert_reset
OUT="$(drill_assert_static_set 'static/img/a.webp
static/img/b.webp' '' 2>&1)"
assert_eq "$(n_kind "${OUT}" WARN)" "1" "容器侧一个都列不出来 → WARN（枚举坏了不冤枉归档，也不冒充一致）"
assert_reset
OUT="$(drill_assert_journal "" "" 2>&1)"
assert_rc "$?" "0" "journal 不在 → PASS"
assert_reset
OUT="$(drill_assert_journal '{"phase":"static"}' "caveat" 2>&1)"
assert_rc "$?" "1" "journal 残留 → FAIL（恢复没干净收尾）"
assert_contains "${OUT}" "混合状态" "说清了后果"
assert_eq "$(drill_ndjson_count '{"a":1}
{"b":2}

')" "2" "NDJSON 计数：空行不算文档"
assert_eq "$(drill_ndjson_count "")" "0" "NDJSON 计数：空内容 = 0"
assert_eq "$(drill_deleted_stats '{"deleted":true,"deletedAt":"2026-01-01"}
{"deleted":true}
{"content":"{\"deleted\":true}","deleted":false}')" "deleted=2 withAt=1" "软删除统计：正文字面量骗不到它，deletedAt 分开数"
assert_eq "$(drill_counts_get 'revisions=2
deleted=6' deleted)" "6" "counts 输出解析"
assert_eq "$(drill_counts_get 'revisions=2' nope)" "" "读不出的标签给空（调用方走 WARN 分支）"
assert_eq "$(drill_integ_mode_label full)" "checked" "模式标签：full→checked"
assert_eq "$(drill_integ_mode_label unavailable)" "no-integrity" "模式标签：unavailable→no-integrity"
assert_eq "$(drill_integ_mode_label "")" "not-run" "模式标签：空→not-run"
assert_eq "$(drill_jsonl_safe 'a"b\c')" 'a\"b\\c' "台账字符串转义：引号与反斜杠"
assert_eq "$(drill_jsonl_safe "$(printf 'a\nb\tc')")" "abc" "台账字符串转义：控制字符被去掉（JSONL 是按行的，一行变两行台账就坏了）"

# ══════════════════════════ A24) cron-safe：颜色与 tty ══════════════════════════
echo
echo "-- cron-safe：管道里自动去色，VANBLOG_FORCE_COLOR 才保留 --"
COLOR_OUT="$(env -u VANBLOG_NO_COLOR VANBLOG_BACKUP_DIR="${RV}" VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" \
  bash -c 'env -u VANBLOG_DRILL_SKIP_MAIN bash "${0}" backup-status --no-stale-check 2>&1 | cat' "${SCRIPT}")"
if printf '%s' "${COLOR_OUT}" | grep -q $'\033'; then
  fail "管道输出里还有 ANSI 转义码（cron 邮件里没法读）"
else
  pass "stdout 不是 tty 时自动去色（不用手动设 VANBLOG_NO_COLOR）"
fi
FORCE_OUT="$(env -u VANBLOG_NO_COLOR VANBLOG_FORCE_COLOR=1 VANBLOG_BACKUP_DIR="${RV}" VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" \
  bash -c 'env -u VANBLOG_DRILL_SKIP_MAIN bash "${0}" backup-status --no-stale-check 2>&1 | cat' "${SCRIPT}")"
if printf '%s' "${FORCE_OUT}" | grep -q $'\033'; then
  pass "VANBLOG_FORCE_COLOR=1 时管道里也保留颜色（less -R 场景）"
else
  fail "VANBLOG_FORCE_COLOR=1 没有生效"
fi

# ══════════════════════════ A25) 退出码纪律（新增失败路径）══════════════════════
echo
echo "-- 退出码纪律：新的失败路径必须真的非 0（防「失败开始退出 0」的回归）--"
run_cli verify "${IGC}" >"${TEST_DIR}/rc3.out" 2>&1
RC=$?
assert_eq "${RC}" "1" "成员哈希不符的归档：verify 退出码**恰好是 1**（哪天变成 0，这条就红）"
RC4D="${TEST_DIR}/rc4dir"
mkdir -p "${RC4D}"
cp "${IG}" "${RC4D}/vanblog-full-20260917-116100.tar.zst"
VANBLOG_BACKUP_DIR="${RC4D}" drill_verify_log_append verify "${RC4D}/vanblog-full-20260917-116100.tar.zst" pass ""
VANBLOG_BACKUP_DIR="${RC4D}" run_cli backup-status --reverify-days 1 --no-stale-check >"${TEST_DIR}/rc4.out" 2>&1
RC=$?
assert_eq "${RC}" "0" "复验护栏在记录新鲜时放行（失败路径在上面 A20 已钉）"
IGD="${TEST_DIR}/discdir"
mkdir -p "${IGD}"
cp "${IGC}" "${IGD}/vanblog-full-20260917-116000.tar.zst"
VANBLOG_BACKUP_DIR="${IGD}" run_cli backup-status --strict >"${TEST_DIR}/rc5.out" 2>&1
assert_ne "$?" "0" "backup-status --strict 对没验过的归档仍然非 0（既有语义没被新功能冲掉）"

# ══════════════════════════ A26) 源码级不变式（新增）══════════════════════
echo
echo "-- 源码级不变式（成员级校验这一层）--"
assert_contains "${SRC}" "quoting-style=literal" "成员名列表用原始字节（GNU tar 默认渲染会把控制字符转义，真站有 10 个这样的图名）"
assert_contains "${SRC}" 'read -r -d '"''" "成员记录用 NUL 分隔解析（名字里可以有换行）"
assert_contains "${SRC}" 'sha256sum <' "哈希走 stdin 重定向（文件名带换行时 GNU sha256sum 会往 hex 前面塞反斜杠）"
assert_contains "${SRC}" "校验器自检不过" "有「匹配到 0 条就 FAIL」的自检（0 匹配的校验器 = 空转通过，本仓库踩过）"
assert_contains "${SRC}" "drill_jsonl_safe" "台账字符串过了 JSONL 安全化"
assert_not_contains "${SRC}" '${!A_TYPE[@]+' "不再用 ${!arr[@]+…} 这个会被 bash 解析成间接引用的坏写法（实测炸过 invalid variable name）"
assert_contains "${SRC}" "VANBLOG_BACKUP_REVERIFY_DAYS" "定期复验护栏有环境变量入口"
assert_contains "${SRC}" "VANBLOG_DRILL_SKIP_HASH" "--skip-hash 有环境变量入口"
assert_contains "${SRC}" "restore-journal.json" "认识 server 的恢复日志文件"
assert_contains "${SRC}" "lastSuccessSha256" "认识 server 状态文件里的整归档 sha256 字段"
assert_contains "${SRC}" "lastSweepAt" "认识 server 状态文件里的 sweep 字段"
# 台账文件名不变式（新增字段不改文件名；两条既有测试之外再钉一次）
assert_contains "${SRC}" "vanblog-verify-log.jsonl" "台账文件名没变（它故意不匹配 vanblog-full-*）"


# ══════════════════════════ B) 活体演练（默认跳过）══════════════════════
echo
echo "-- 活体演练（需要引擎 + 镜像 + 真归档；默认跳过）--"
LIVE_ARCHIVE="${VANBLOG_DRILL_LIVE_ARCHIVE:-}"
LIVE_IMAGE="${VANBLOG_DRILL_LIVE_IMAGE:-${VANBLOG_DRILL_IMAGE:-}}"
LIVE_ENGINE="${VANBLOG_DRILL_LIVE_ENGINE:-${VANBLOG_DRILL_ENGINE:-}}"
if [[ "${VANBLOG_DRILL_LIVE:-0}" != "1" ]]; then
  skip "VANBLOG_DRILL_LIVE 不等于 1：不真起容器。要跑活体演练："
  skip "  VANBLOG_DRILL_LIVE=1 VANBLOG_DRILL_LIVE_ARCHIVE=/path/to/vanblog-full-*.tar.zst \\"
  skip "  VANBLOG_DRILL_LIVE_IMAGE=<镜像> [VANBLOG_DRILL_LIVE_ENGINE=podman] bash scripts/tests/vanblog-drill.test.sh"
elif [[ -z "${LIVE_ARCHIVE}" || ! -f "${LIVE_ARCHIVE}" ]]; then
  skip "VANBLOG_DRILL_LIVE=1 但没给 VANBLOG_DRILL_LIVE_ARCHIVE（或文件不存在），跳过活体演练"
elif [[ -n "${LIVE_ENGINE}" ]] && ! command -v "${LIVE_ENGINE}" >/dev/null 2>&1; then
  skip "指定的引擎 ${LIVE_ENGINE} 不在 PATH 里，跳过活体演练"
elif [[ -z "${LIVE_ENGINE}" ]] && ! drill_detect_engine >/dev/null 2>&1; then
  skip "本机没有可用的容器引擎（docker daemon 连不上、也没有可用的 podman），跳过活体演练"
elif [[ -n "${LIVE_IMAGE}" ]] && ! "${LIVE_ENGINE:-$(drill_detect_engine 2>/dev/null)}" image inspect "${LIVE_IMAGE}" >/dev/null 2>&1 &&
  [[ "${VANBLOG_DRILL_NO_PULL:-0}" == "1" ]]; then
  skip "镜像 ${LIVE_IMAGE} 不在本地，而 VANBLOG_DRILL_NO_PULL=1（不许 pull）⇒ 跳过活体演练"
else
  if [[ -n "${LIVE_IMAGE}" ]] && ! "${LIVE_ENGINE:-$(drill_detect_engine 2>/dev/null)}" image inspect "${LIVE_IMAGE}" >/dev/null 2>&1; then
    echo "   注意：镜像 ${LIVE_IMAGE} 不在本地，演练会先 pull（可能要几分钟）"
  fi
  echo "   活体演练：${LIVE_ARCHIVE}（镜像 ${LIVE_IMAGE:-自动解析}，引擎 ${LIVE_ENGINE:-自动}）"
  # 用回本机的引擎环境（镜像存储/临时目录），否则 rootless podman 会"看不到镜像"
  export VANBLOG_DRILL_HOME="${VANBLOG_DRILL_LIVE_HOME:-${SAVED_DRILL_HOME}}"
  export VANBLOG_DRILL_TMPDIR="${VANBLOG_DRILL_LIVE_TMPDIR:-${SAVED_DRILL_TMPDIR}}"
  LIVE_TMP="$(mktemp -d)"
  cp "${LIVE_ARCHIVE}" "${LIVE_TMP}/" 2>/dev/null || true
  LIVE_OUT="${TEST_DIR}/live.out"
  VANBLOG_BACKUP_DIR="${LIVE_TMP}" run_cli drill "${LIVE_TMP}/$(basename "${LIVE_ARCHIVE}")" \
    ${LIVE_IMAGE:+--image "${LIVE_IMAGE}"} ${LIVE_ENGINE:+--engine "${LIVE_ENGINE}"} >"${LIVE_OUT}" 2>&1
  LIVE_RC=$?
  LIVE_TEXT="$(cat "${LIVE_OUT}")"
  if [[ "${LIVE_RC}" != "0" ]]; then
    echo "   ---- 活体演练输出（最后 45 行）----"
    tail -45 "${LIVE_OUT}" | sed 's/^/   /'
    echo "   ----------------------------------"
  fi
  assert_rc "${LIVE_RC}" "0" "活体演练：一次性容器里真恢复一遍并通过全部断言"
  assert_contains "${LIVE_TEXT}" "恢复接口返回 HTTP 201" "活体：恢复接口 201"
  assert_contains "${LIVE_TEXT}" "RESULT: PASS" "活体：结论行是 PASS"
  assert_contains "${LIVE_TEXT}" "公开文章列表 total 与归档对得上" "活体：站点服务的文章数与归档对上了"
  assert_contains "${LIVE_TEXT}" "数据往返" "活体：在一次性 mongo 里做了条数往返"
  assert_contains "${LIVE_TEXT}" "revisions 的往返" "活体：文章版本历史做了往返（没有凭据就直连演练库数，不跳过）"
  assert_contains "${LIVE_TEXT}" "migrations 的往返" "活体：迁移账本做了往返"
  assert_contains "${LIVE_TEXT}" "drafts 的往返" "活体：草稿做了往返"
  assert_contains "${LIVE_TEXT}" "软删除文章的往返" "活体：回收站做了往返"
  assert_contains "${LIVE_TEXT}" "静态树逐文件一致" "活体：静态树与归档逐文件一致（prune-on-restore 的证明；含 10 个控制字符图名的原始字节比对）"
  assert_contains "${LIVE_TEXT}" "恢复日志已清理" "活体：恢复日志断言跑了"
  assert_contains "${LIVE_TEXT}" "预检：成员级哈希校验" "活体：成员级哈希预检跑了（旧归档如实报「不可用」）"
  assert_contains "${LIVE_TEXT}" "完整性    ：成员哈希：" "活体：结论区自报了成员哈希是否校验过"
  if printf '%s' "${LIVE_TEXT}" | grep -q "vb-drill-app-"; then
    pass "活体：用的是一次性容器名（vb-drill-app-…）"
  else
    fail "活体：没看到 vb-drill-app- 容器名（是不是碰到别的栈了？）"
  fi
  rm -rf "${LIVE_TMP}"

  # ── 负例：截断的归档必须 FAIL、必须拆干净，而且**不能把恢复接口的单飞锁卡死** ──
  # （server 侧曾经有个 bug：listArchiveMembers 在截断归档上永不 settle ⇒ 那条匿名接口的
  #   单飞锁永远不放，任何人传一个坏归档就能让整站再也恢复不了，而且一点错误都不露。
  #   最后那条"紧接着的好归档仍然成功"才是能抓住它的断言。）
  LIVE_ENG="${VANBLOG_DRILL_LIVE_ENGINE:-}"
  if [[ -z "${LIVE_ENG}" ]]; then
    LIVE_ENG="$(drill_detect_engine 2>/dev/null || true)"
  fi
  BAD_TMP="$(mktemp -d)"
  BAD_NAME="$(basename "${LIVE_ARCHIVE}")"
  cp "${LIVE_ARCHIVE}" "${BAD_TMP}/${BAD_NAME}"
  BAD_SIZE="$(wc -c <"${BAD_TMP}/${BAD_NAME}")"
  head -c $((BAD_SIZE / 2)) "${BAD_TMP}/${BAD_NAME}" >"${BAD_TMP}/half" && mv -f "${BAD_TMP}/half" "${BAD_TMP}/${BAD_NAME}"
  if [[ "$(wc -c <"${BAD_TMP}/${BAD_NAME}")" == "${BAD_SIZE}" ]]; then
    fail "负例准备失败：截断没生效（原归档 ${BAD_SIZE} 字节，只读不改）"
  else
    pass "负例归档已准备好（在自己的临时目录里截断，原归档一个字节没动：$(wc -c <"${BAD_TMP}/${BAD_NAME}")/${BAD_SIZE}）"
    VANBLOG_BACKUP_DIR="${BAD_TMP}" run_cli drill --skip-preflight \
      ${LIVE_IMAGE:+--image "${LIVE_IMAGE}"} ${LIVE_ENG:+--engine "${LIVE_ENG}"} \
      "${BAD_TMP}/${BAD_NAME}" >"${TEST_DIR}/live-bad.out" 2>&1
    BAD_RC=$?
    BAD_TEXT="$(cat "${TEST_DIR}/live-bad.out")"
    assert_ne "${BAD_RC}" "0" "负例：坏归档演练必须非 0 退出"
    if printf '%s' "${BAD_TEXT}" | grep -q "RESULT: FAIL"; then
      pass "负例：结论行是 RESULT: FAIL"
    else
      fail "负例：没有 RESULT: FAIL 结论行"
    fi
    assert_contains "${BAD_TEXT}" "FAIL" "负例：报了 FAIL"
    # ⚠️ 下面两条是防"空转通过"的：如果演练其实是死在环境问题（镜像不在、端口冲突），
    #    那"非 0 退出 + 没有残留"这两条会**照样通过**，而坏归档那条路根本没走到。
    #    （本轮真发生过：测试把 VANBLOG_DRILL_HOME unset 了 ⇒ 镜像看不见 ⇒ 负例假绿）
    assert_contains "${BAD_TEXT}" "起一次性栈" "负例：真的起了一次性容器（不是死在环境预检上）"
    assert_contains "${BAD_TEXT}" "POST /api/admin/init/restore" "负例：真的把坏归档上传到了恢复接口（这才演练到 server 的护栏）"
    if printf '%s' "${BAD_TEXT}" | grep -qE "HTTP 4[0-9][0-9]|清单|损坏|截断|400"; then
      pass "负例：失败原因是有用的（400/清单/损坏之一），不是光一句「超时了」"
    else
      fail "负例：失败原因看不出来（输出里既没有 HTTP 4xx 也没有「清单/损坏/截断」）"
    fi
    # 拆干净
    if [[ -n "${LIVE_ENG}" ]] && command -v "${LIVE_ENG}" >/dev/null 2>&1; then
      LEFT="$("${LIVE_ENG}" ps -a --format '{{.Names}}' 2>/dev/null | grep -c 'vb-drill' || true)"
      assert_eq "${LEFT}" "0" "负例：失败后一次性容器全拆了（没有 vb-drill* 残留）"
      LEFTV="$("${LIVE_ENG}" volume ls --format '{{.Name}}' 2>/dev/null | grep -c 'vb-drill' || true)"
      assert_eq "${LEFTV}" "0" "负例：卷也全删了（root 所有的 mongo 数据不会留在删不掉的目录里）"
    else
      skip "拿不到引擎名，跳过残留检查"
    fi
    # 紧接着的好归档必须仍然成功（单飞锁没被卡死）
    GOOD_TMP="$(mktemp -d)"
    cp "${LIVE_ARCHIVE}" "${GOOD_TMP}/"
    VANBLOG_BACKUP_DIR="${GOOD_TMP}" run_cli drill \
      ${LIVE_IMAGE:+--image "${LIVE_IMAGE}"} ${LIVE_ENG:+--engine "${LIVE_ENG}"} \
      "${GOOD_TMP}/$(basename "${LIVE_ARCHIVE}")" >"${TEST_DIR}/live-after-bad.out" 2>&1
    AFTER_RC=$?
    if [[ "${AFTER_RC}" != "0" ]]; then
      echo "   ---- 负例之后的那次演练（最后 45 行）----"
      tail -45 "${TEST_DIR}/live-after-bad.out" | sed 's/^/   /'
      echo "   ----------------------------------------"
    fi
    assert_rc "${AFTER_RC}" "0" "负例之后紧接着演练好归档仍然成功（坏归档没有把恢复接口的单飞锁卡死）"
    assert_contains "$(cat "${TEST_DIR}/live-after-bad.out")" "RESULT: PASS" "第二次演练的结论行是 PASS"
    rm -rf "${GOOD_TMP}"
  fi
  rm -rf "${BAD_TMP}"

  # ── 负例 2：中段字节翻转（与截断不同的损坏形状）──
  # 要求：verify 点名损坏（帧校验和/成员），drill **拒绝**而不是半恢复，拒绝时不起容器。
  FLIP_TMP="$(mktemp -d)"
  FLIP_NAME="$(basename "${LIVE_ARCHIVE}")"
  cp "${LIVE_ARCHIVE}" "${FLIP_TMP}/${FLIP_NAME}"
  FLIP_SZ="$(wc -c <"${FLIP_TMP}/${FLIP_NAME}")"
  printf '\xff' | dd of="${FLIP_TMP}/${FLIP_NAME}" bs=1 seek=$((FLIP_SZ / 2)) count=1 conv=notrunc status=none
  VANBLOG_BACKUP_DIR="${FLIP_TMP}" run_cli verify "${FLIP_TMP}/${FLIP_NAME}" >"${TEST_DIR}/live-flip-v.out" 2>&1
  FLIPV_RC=$?
  assert_ne "${FLIPV_RC}" "0" "负例2：字节翻转的归档 verify 非 0"
  if grep -qE "完整性校验失败|解不完整|sha256 不匹配|成员级" "${TEST_DIR}/live-flip-v.out"; then
    pass "负例2：verify 点名了损坏（帧校验和失败 / 解不完整 / 成员哈希之一）"
  else
    fail "负例2：verify 没有点名损坏原因"
  fi
  VANBLOG_BACKUP_DIR="${FLIP_TMP}" run_cli drill \
    ${LIVE_IMAGE:+--image "${LIVE_IMAGE}"} ${LIVE_ENG:+--engine "${LIVE_ENG}"} \
    "${FLIP_TMP}/${FLIP_NAME}" >"${TEST_DIR}/live-flip-d.out" 2>&1
  FLIPD_RC=$?
  assert_ne "${FLIPD_RC}" "0" "负例2：字节翻转的归档 drill 非 0"
  if grep -q "起一次性栈" "${TEST_DIR}/live-flip-d.out"; then
    fail "负例2：drill 竟然起了容器（应该在预检就拒绝，而不是把坏归档传上去赌 server 的护栏）"
  else
    pass "负例2：drill 在预检就拒绝了（没有起容器 —— 不是半恢复，是根本不开始）"
  fi
  if grep -qE "RESULT: FAIL" "${TEST_DIR}/live-flip-d.out"; then
    pass "负例2：结论行是 RESULT: FAIL"
  else
    fail "负例2：没有 RESULT: FAIL 结论行"
  fi
  if [[ -n "${LIVE_ENG}" ]] && command -v "${LIVE_ENG}" >/dev/null 2>&1; then
    FLIP_LEFT="$("${LIVE_ENG}" ps -a --format '{{.Names}}' 2>/dev/null | grep -c 'vb-drill' || true)"
    assert_eq "${FLIP_LEFT}" "0" "负例2：拒绝路径也没有留下任何 vb-drill* 容器"
  fi
  rm -rf "${FLIP_TMP}"

  # ── 活体：带 integrity 块的归档（本测试现场造的小站点）走完整演练 ──
  # 这是 P1+P3 全链路的真机证明：成员哈希预检（真比对）→ 容器恢复 → 版本历史/迁移/
  # 草稿/回收站在一次性 mongo 里的条数往返 → 静态树逐文件一致 → 恢复日志清理。
  IG_TMP="$(mktemp -d)"
  make_integrity_archive "${IG_TMP}/vanblog-full-20260917-120000.tar.zst"
  VANBLOG_BACKUP_DIR="${IG_TMP}" run_cli drill \
    ${LIVE_IMAGE:+--image "${LIVE_IMAGE}"} ${LIVE_ENG:+--engine "${LIVE_ENG}"} \
    "${IG_TMP}/vanblog-full-20260917-120000.tar.zst" >"${TEST_DIR}/live-ig.out" 2>&1
  IGL_RC=$?
  IGL_TEXT="$(cat "${TEST_DIR}/live-ig.out")"
  if [[ "${IGL_RC}" != "0" ]]; then
    echo "   ---- 活体 integrity 演练输出（最后 45 行）----"
    tail -45 "${TEST_DIR}/live-ig.out" | sed 's/^/   /'
    echo "   --------------------------------------------"
  fi
  assert_rc "${IGL_RC}" "0" "活体：带 integrity 块的归档完整演练通过"
  assert_contains "${IGL_TEXT}" "RESULT: PASS" "活体：结论行 PASS"
  assert_contains "${IGL_TEXT}" "预检：成员级哈希校验" "活体：成员哈希预检真的跑了"
  assert_contains "${IGL_TEXT}" "成员哈希：已校验" "活体：PASS 行自报了「哈希已校验」（这个 PASS 是逐成员比对过的）"
  assert_contains "${IGL_TEXT}" "revisions 的往返" "活体：文章版本历史做了往返对账"
  assert_contains "${IGL_TEXT}" "归档 2 条 == 恢复库 2 条" "活体：版本历史 2 条真回来了（在一次性 mongo 里数出来的）"
  assert_contains "${IGL_TEXT}" "migrations 的往返" "活体：迁移账本做了往返对账"
  assert_contains "${IGL_TEXT}" "drafts 的往返" "活体：草稿做了往返对账"
  assert_contains "${IGL_TEXT}" "软删除文章的 deletedAt 也回来了" "活体：deletedAt 字段做了对账（归档 1/1）"
  assert_contains "${IGL_TEXT}" "静态树逐文件一致" "活体：静态树逐文件对账过了（含 C2 9B 控制字符文件名）"
  assert_contains "${IGL_TEXT}" "恢复日志已清理" "活体：恢复日志断言跑了"
  if [[ -n "${LIVE_ENG}" ]] && command -v "${LIVE_ENG}" >/dev/null 2>&1; then
    IGL_LEFT="$("${LIVE_ENG}" ps -a --format '{{.Names}}' 2>/dev/null | grep -c 'vb-drill' || true)"
    assert_eq "${IGL_LEFT}" "0" "活体：integrity 演练之后容器也全拆了"
  fi
  rm -rf "${IG_TMP}"
fi

# ══════════════════════════ A16) 初始化密钥（setup key）：drill 必须带上它 ══════════════════════════
# 背景（真炸过）：`VANBLOG_INIT_REQUIRE_SETUP_KEY` 默认开启之后，`POST /api/admin/init/restore`
# 要求 multipart 里带 `setupKey` 字段，而 drill 不带 ⇒ 恢复必然 400 `setupKeyRequired`。
# 它自己的 573 条断言全绿也没发现 —— 那些用例走的是**假 HTTP 层**，只有真起容器跑一次才炸。
echo
echo "-- 初始化密钥：取得到、送得出、且绝不外泄 --"

SK_BIN="${TEST_DIR}/skbin"
mkdir -p "${SK_BIN}"
SK_KEY="U2V0dXBLZXkvc2hhcGUrdGVzdD09Cg==" # 32 字节 base64 的形状（含 + / =）

# 场景 1：容器里的 setup.key 读得到（日志目录是命名卷，只能 exec 进去读）
cat >"${SK_BIN}/fakeengine" <<STUB
#!/usr/bin/env bash
case "\$1" in
  exec) printf '%s' "${SK_KEY}" ;;
  logs) echo "log without any key" ;;
esac
exit 0
STUB
chmod +x "${SK_BIN}/fakeengine"
GOT="$(PATH="${SK_BIN}:${PATH}" drill_fetch_setup_key fakeengine vb-drill-app-x)"
assert_eq "${GOT}" "${SK_KEY}" "容器内 setup.key 读得到时，取到的就是它"

# 场景 2：文件读不到，从日志的密钥块兜底（每次启动 + 每 10 分钟重印）
cat >"${SK_BIN}/fakeengine" <<STUB
#!/usr/bin/env bash
case "\$1" in
  exec) exit 1 ;;
  logs)
    echo "WARN [InitProvider] ============ VanBlog 初始化密钥（setup key） ============"
    echo "初始化密钥： ${SK_KEY}"
    echo "密钥文件： /var/log/setup.key（0600）"
    ;;
esac
exit 0
STUB
GOT="$(PATH="${SK_BIN}:${PATH}" drill_fetch_setup_key fakeengine vb-drill-app-x)"
assert_eq "${GOT}" "${SK_KEY}" "文件读不到时，从日志的「初始化密钥：」行兜底取到"

# 场景 3：⚠️ 日志里同时有**别的** base64 秘密（restore.key / jwt），绝不能抓错 ——
# 送错密钥比不送更难查（400 长得一模一样）
cat >"${SK_BIN}/fakeengine" <<STUB
#!/usr/bin/env bash
case "\$1" in
  exec) exit 1 ;;
  logs)
    echo "恢复密钥（restore.key）： QUFBQXJlc3RvcmVLZXlOb3RUaGVTZXR1cEtleQ=="
    echo "jwt secret: QkJCQmp3dFNlY3JldE5vdFRoZVNldHVwS2V5RUJB"
    echo "初始化密钥： ${SK_KEY}"
    ;;
esac
exit 0
STUB
GOT="$(PATH="${SK_BIN}:${PATH}" drill_fetch_setup_key fakeengine vb-drill-app-x)"
assert_eq "${GOT}" "${SK_KEY}" "日志里有别的 base64 秘密时也只取初始化密钥（不抓错）"

# 场景 4：两条路都拿不到 ⇒ 返回空（调用方 WARN，绝不猜一个值）
cat >"${SK_BIN}/fakeengine" <<STUB
#!/usr/bin/env bash
case "\$1" in
  exec) exit 1 ;;
  logs) echo "nothing here" ;;
esac
exit 0
STUB
GOT="$(PATH="${SK_BIN}:${PATH}" drill_fetch_setup_key fakeengine vb-drill-app-x)"
assert_eq "${GOT}" "" "两条路都拿不到时返回空（调用方 WARN，不猜）"
GOT="$(PATH="${SK_BIN}:${PATH}" drill_fetch_setup_key "" "")"
assert_eq "${GOT}" "" "引擎/容器名为空时安全返回空（不炸）"

# 源码级：密钥怎么送、怎么不外泄
SK_SRC="$(cat "${SCRIPT}")"
# ⚠️ 2026-09-20 升级（不是放宽）：这条原本钉的是字面量 `-F "setupKey=<${setup_key_file}"`，
#    而恢复调用被重构成纯函数 `drill_build_restore_args` 之后局部变量改名为 `keyfile`
#    ⇒ 断言红了，但**性质完好**（仍是 `-F "setupKey=<${keyfile}"`，值从文件读、不进 argv）。
#    钉"变量名"就是钉实现细节；这里改成钉**性质**：字段名 + curl 的 `<文件` 取值形状，与变量名无关。
if printf '%s' "${SK_SRC}" | grep -qE -- '-F "setupKey=<\$\{[A-Za-z_][A-Za-z0-9_]*\}"'; then
  pass '密钥走 curl 的 -F "字段<文件" 形式（值从文件读出，不进命令行）'
else
  fail '密钥没有走 -F "setupKey=<文件" 形式 ⇒ 值可能进了 argv（ps 可见）'
fi
# 🔴 负向：绝不能出现"把密钥值内联进 -F"的形状（那正是这条纪律要防的）
# ⚠️ 本条第一版是**空转的**，写成了 `grep -qE … | grep -qv '<'`：`grep -q` 不输出任何内容，
#    于是后面那个 grep 收到空输入、恒返回 1 ⇒ `if` 永远为假、`fail` 分支永远不触发。
#    这正是本仓库反复强调的"负向对照必须先证明它量得到坏形状"—— 我自己犯了一次。
#    正确写法是先取出候选行、再过滤、最后判**非空**。
# ⚠️ 必须带 `-a`：drill 脚本里含 grep 判为二进制的字节，默认模式下 grep 会输出
#    "Binary file (standard input) matches" 而**不是**匹配行 ⇒ 那串文字本身非空，
#    会让"内联密钥"这条负向对照**假阳性**（实测踩过：622 passed / 1 failed，
#    报的就是这一条，而真相是 grep 的输出形状变了、不是脚本有问题）。
# ⚠️ 必须先剥注释行：drill 脚本里有一句**解释性注释**正好写着『不要这样：`-F "setupKey=值"`』，
#    不剥注释就会命中它 ⇒ 负向对照假阳性（本仓库第 10 次踩"断言匹配到解释性注释"这个坑）。
#    ⚠️ shell 里用 sed 剥整行注释，**绝不能**用 TS 的 stripCommentsForAnchor（它会把 https:// 当注释吃掉）。
SK_CODE_ONLY="$(printf '%s\n' "${SK_SRC}" | sed '/^[[:space:]]*#/d')"
INLINE_KEY_LINES="$(printf '%s\n' "${SK_CODE_ONLY}" | grep -aE -- '-F "setupKey=' | grep -av -- '<' || true)"
# ⚠️ 反向保险：如果 grep 因为二进制判定而输出 "Binary file ... matches"，那不是证据，必须报出来
if printf '%s' "${INLINE_KEY_LINES}" | grep -q 'Binary file'; then
  fail '负向对照被 grep 的二进制判定污染了（输出是 "Binary file matches" 而不是匹配行）⇒ 请检查 -a 是否漏了'
fi
if [[ -n "${INLINE_KEY_LINES}" ]]; then
  fail "出现了把密钥值内联进 -F 的形状（值会进 argv、ps 可见）：$(printf '%s' "${INLINE_KEY_LINES}" | head -1 | cut -c1-80)"
else
  pass '没有把密钥值内联进 -F 的形状（所有 setupKey 都走 <文件 读取）'
fi
# ⚠️ 上面那条负向对照的**尺子有效性反证**：喂一个内联形状，必须被判为不合规（非空）
PROBE_INLINE="$(printf '%s\n' '-F "setupKey=${setup_key}"' | grep -aE -- '-F "setupKey=' | grep -av -- '<' || true)"
# ⚠️ 反向反证：同样的坏形状**写在注释里**时，剥注释后必须检不出来（否则说明剥注释没生效）
PROBE_COMMENT="$(printf '%s\n' '# 别这样写：-F "setupKey=${setup_key}"' | sed '/^[[:space:]]*#/d' | grep -aE -- '-F "setupKey=' | grep -av -- '<' || true)"
if [[ -n "${PROBE_INLINE}" && -z "${PROBE_COMMENT}" ]]; then
  pass '反证成立：代码里的内联形状会被检出、注释里的同样形状不会（剥注释这一步既有效又必要）'
else
  fail "反证失败：inline='${PROBE_INLINE:0:20}' comment='${PROBE_COMMENT:0:20}' ⇒ 尺子方向不对或剥注释失效"
fi
if [[ -n "${PROBE_INLINE}" ]]; then
  pass '反证成立：内联形状会被上面那条负向对照检出（它不是恒 pass）'
else
  fail '反证失败：内联形状检不出来 ⇒ 上面那条负向对照是空转的'
fi
# ⚠️ 尺子有效性反证：证明上面那把正则真的量得到东西（喂一个内联形状必须被判为不合规）
if printf '%s' '-F "setupKey=${setup_key}"' | grep -qE -- '-F "setupKey=<\$\{[A-Za-z_][A-Za-z0-9_]*\}"'; then
  fail '反证失败：内联形状也被判合规 ⇒ 上面那条断言恒真'
else
  pass '反证成立：内联形状不会被误判成合规（尺子有方向性）'
fi
assert_not_contains "${SK_SRC}" '-F "setupKey=${setup_key}"' "不许把密钥值直接写进命令行（ps 里谁都能看）"
assert_contains "${SK_SRC}" '(umask 077; printf' "临时密钥文件用 umask 077 建（0600）"
assert_contains "${SK_SRC}" 'rm -f "${setup_key_file}"' "请求发完就删临时密钥文件"
assert_contains "${SK_SRC}" 'setup_key=""' "变量也立刻清掉（免得后面哪条调试输出带出去）"
assert_contains "${SK_SRC}" '${#setup_key} 字节' "台账只记密钥**字节数**，不记内容"
assert_contains "${SK_SRC}" 'grep -q "setupKey"' "4xx 且响应点名 setupKey 时有专门诊断"
assert_contains "${SK_SRC}" 'setupKeyRequired' "诊断文案点名 setupKeyRequired 这个 wire 字段（用户不会去怀疑自己的备份）"
assert_contains "${SK_SRC}" "grep -oE '初始化密钥： " "日志兜底锚在「初始化密钥：」标签上，不是裸抓 base64"

echo

# ── A19 兜底分支的备份目录推导（source 不到 vanblog.sh 时）──────────────────
# 以前兜底把 `/var/vanblog/data/log/vanblog-backups` **写死**，而 :1846 的帮助声称
# `VANBLOG_BACKUP_DIR / VANBLOG_DATA_PATH / VANBLOG_BASE_PATH` "沿用 vanblog.sh 的定义"，
# :3714 也真的在用 `${VANBLOG_BASE_PATH:-/var/vanblog}` ⇒ 同一文件内自相矛盾。
# 换了安装目录的站点走到兜底分支就会去错目录、报"没有归档"。
# ⚠️ 兜底只在 source 不到 vanblog.sh 时生效，所以这里把 VANBLOG_MAIN_SCRIPT 指向不存在的路径；
#    仓库里两个脚本是同目录的，不这么做测到的会是 vanblog.sh 那份实现（那一份本来就是对的）。
fallback_dir() { # $1 = 额外 export 语句（可空）
  bash -c "
    export VANBLOG_DRILL_SKIP_MAIN=1 VANBLOG_NO_COLOR=1
    export VANBLOG_MAIN_SCRIPT=/nonexistent/vanblog.sh
    unset VANBLOG_BACKUP_DIR VANBLOG_DATA_PATH VANBLOG_BASE_PATH
    $1
    source '${SCRIPT}' >/dev/null 2>&1
    if declare -F full_backup_dir >/dev/null 2>&1; then full_backup_dir; else printf '__NOFUNC__'; fi
  " 2>/dev/null
}
main_dir() { # 同样入参，但走 vanblog.sh 的真实实现（生产路径）
  bash -c "
    export VANBLOG_SKIP_MAIN=1 VANBLOG_NO_COLOR=1
    unset VANBLOG_BACKUP_DIR VANBLOG_DATA_PATH VANBLOG_BASE_PATH
    $1
    source '${ROOT}/scripts/vanblog.sh' >/dev/null 2>&1
    if declare -F full_backup_dir >/dev/null 2>&1; then full_backup_dir; else printf '__NOFUNC__'; fi
  " 2>/dev/null
}

assert_eq "$(fallback_dir '')" "/var/vanblog/data/log/vanblog-backups" "兜底：全默认时仍是标准路径（默认值没被改坏）"
assert_eq "$(fallback_dir 'export VANBLOG_BASE_PATH=/srv/vb')" "/srv/vb/data/log/vanblog-backups" "兜底：VANBLOG_BASE_PATH 生效（以前写死，这个会被忽略）"
assert_eq "$(fallback_dir 'export VANBLOG_DATA_PATH=/data/x')" "/data/x/log/vanblog-backups" "兜底：VANBLOG_DATA_PATH 生效"
assert_eq "$(fallback_dir 'export VANBLOG_BASE_PATH=/srv/vb VANBLOG_DATA_PATH=/data/x')" "/data/x/log/vanblog-backups" "兜底：DATA_PATH 优先于 BASE_PATH 推导（与 vanblog.sh 同序）"
assert_eq "$(fallback_dir 'export VANBLOG_BACKUP_DIR=/bk')" "/bk" "兜底：VANBLOG_BACKUP_DIR 最优先"

# 兜底与生产实现必须**同源**：同一组环境变量给出同一个目录
for envs in '' 'export VANBLOG_BASE_PATH=/srv/vb' 'export VANBLOG_DATA_PATH=/data/x' 'export VANBLOG_BACKUP_DIR=/bk'; do
  assert_eq "$(fallback_dir "${envs}")" "$(main_dir "${envs}")" "兜底与 vanblog.sh 的实现一致（env: ${envs:-全默认}）"
done

# 源码级：兜底块里不许再有写死的那个绝对路径（⚠️ 先剥整行注释：解释这件事的注释里就写着它，
# 本仓库已经六次踩到"断言匹配到解释性注释"）
FALLBACK_BLOCK="$(awk '/^if \[\[ "\$\{VANBLOG_MAIN_LOADED\}" != "1" \]\]; then$/{f=1} f{print} f&&/^fi$/{exit}' "${SCRIPT}")"
if [[ -z "${FALLBACK_BLOCK}" ]]; then
  fail "没能从脚本里切出兜底块（awk 锚点失效？那这条检查就是空的）"
else
  pass "切出了兜底块（$(printf '%s' "${FALLBACK_BLOCK}" | wc -l) 行）"
  STRIPPED_FALLBACK="$(printf '%s\n' "${FALLBACK_BLOCK}" | grep -v '^[[:space:]]*#')"
  if printf '%s' "${STRIPPED_FALLBACK}" | grep -qF '/var/vanblog/data/log/vanblog-backups'; then
    fail "兜底块里还有写死的绝对路径（应由 VANBLOG_BASE_PATH/DATA_PATH 推导）"
  else
    pass "兜底块里没有写死的绝对路径（剥注释后）"
  fi
  # 空转反证：同一个 grep 跑在**旧写法**那一行上必须命中，否则上面那条 PASS 是空的
  if printf '%s' '  full_backup_dir() { printf '"'"'%s'"'"' "${VANBLOG_BACKUP_DIR:-/var/vanblog/data/log/vanblog-backups}"; }' |
    grep -qF '/var/vanblog/data/log/vanblog-backups'; then
    pass "反证成立：旧的写死形状会被这条 grep 抓到（不是空转）"
  else
    fail "反证失败：grep 抓不到旧形状 ⇒ 上面那条 PASS 没有意义"
  fi
  assert_contains "${STRIPPED_FALLBACK}" 'VANBLOG_BASE_PATH' "兜底块真的读 VANBLOG_BASE_PATH"
  assert_contains "${STRIPPED_FALLBACK}" 'VANBLOG_DATA_PATH' "兜底块真的读 VANBLOG_DATA_PATH"
fi

echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
