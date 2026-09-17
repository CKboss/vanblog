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
for kw in drill verify backup-verify backup-status --image --engine --keep --dry-run --mongo-image --timeout --as --no-pull --stale-days --strict; do
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
assert_not_contains "${SRC}" "codebonobo" "脚本里没有生产域名"
assert_not_contains "${SRC}" "JiangOil" "脚本里没有真实账号名"
assert_not_contains "${SRC}" "10.1.1." "脚本里没有内网地址"
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
VANBLOG_BASE_PATH="${BASE}" VANBLOG_DATA_PATH="${DATA}" VANBLOG_BACKUP_DIR="${STATUS_DIR}" \
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
OUT="$(VANBLOG_BACKUP_DIR="${STATUS_DIR}" run_cli drill --dry-run --skip-preflight --image vanblog:test "${STATUS_DIR}/${GOOD_NAME}" 2>&1)"
assert_rc "$?" "0" "--skip-preflight 时 dry-run 照常通过"
TRUNC_DIR="${TEST_DIR}/trunc2"
mkdir -p "${TRUNC_DIR}"
head -c $(( $(wc -c <"${GOOD}") / 2 )) "${GOOD}" >"${TRUNC_DIR}/vanblog-full-20260917-999999.tar.zst"
OUT="$(VANBLOG_BACKUP_DIR="${TRUNC_DIR}" run_cli drill --dry-run --image vanblog:test "${TRUNC_DIR}/vanblog-full-20260917-999999.tar.zst" 2>&1)"
RC=$?
assert_rc "${RC}" "1" "截断的归档：默认在预检就拦下（不用起容器就知道恢复不了）"
assert_contains "${OUT}" "归档里的清单读得出来" "点名了清单读不出来"
OUT="$(VANBLOG_BACKUP_DIR="${TRUNC_DIR}" run_cli drill --dry-run --skip-preflight --image vanblog:test "${TRUNC_DIR}/vanblog-full-20260917-999999.tar.zst" 2>&1)"
RC=$?
assert_eq "${RC}" "0" "--skip-preflight 时不拦，交给 server 判（演练护栏要用这条）"
assert_contains "${OUT}" "--skip-preflight" "但会明说预检被跳过了（不静默放宽）"

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
fi

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
