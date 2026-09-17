#!/usr/bin/env bash
# scripts/reset-waline.sh 的测试：这个脚本重置 waline 全部管理员的密码，
# 旧版硬编码了一段公开在仓库里的 bcrypt 哈希 + admin@admin.com —— 已知凭据事故。
# 这里钉住新版的全部安全语义：
#   · 没有密码来源 → 拒绝执行（绝不回落成默认值）
#   · --generate 的密码够长、两次不同、只打印一次
#   · 确认门（n/EOF 取消，yes/--yes 放行），取消时一条改库命令都不发
#   · 送进容器的 JS 里只有哈希、没有明文；邮箱默认不动
#   · 文件里不再有任何 bcrypt 哈希字面量 / 123123 / admin@admin.com / exec -it
# 容器引擎全程用假二进制桩掉：**不碰任何真容器**（包括在跑的栈）。
#
# ⚠️ 退出码断言一律 `cmd >out 2>&1; rc=$?`，绝不 `cmd | tail; echo $?`。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/reset-waline.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
skip() { echo "SKIP: $*"; }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_ne() { if [[ "$1" != "$2" ]]; then pass "$3"; else fail "$3 (both '$1')"; fi; }
assert_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }
assert_not_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then fail "$3 (unexpected: $2)"; else pass "$3"; fi; }
assert_rc() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (rc=$1, want $2)"; fi; }

echo "== reset-waline.sh：不再有已知凭据的重置脚本 =="

if [[ ! -f "${SCRIPT}" ]]; then
  echo "找不到 ${SCRIPT}"
  echo "passed=0 failed=1"
  exit 1
fi

TEST_DIR="$(mktemp -d)"
cleanup_test() { rm -rf "${TEST_DIR}" >/dev/null 2>&1 || true; }
trap cleanup_test EXIT

# ── 假引擎：docker 与 podman 是同一份桩，用 $0 区分；所有调用记到日志 ─────────
FAKE_BIN="${TEST_DIR}/bin"
mkdir -p "${FAKE_BIN}"
FAKE_LOG="${TEST_DIR}/engine-calls.log"
FAKE_CP_DIR="${TEST_DIR}/cp-captured"
mkdir -p "${FAKE_CP_DIR}"
export FAKE_ENGINE_LOG="${FAKE_LOG}" FAKE_CP_DIR
cat >"${FAKE_BIN}/docker" <<'STUB'
#!/usr/bin/env bash
me="$(basename "$0")"
echo "${me} $*" >> "${FAKE_ENGINE_LOG}"
case "$1" in
  info)
    if [[ "${me}" == "docker" ]]; then exit "${FAKE_DOCKER_INFO_RC:-0}"; fi
    exit 0 ;;
  ps)
    [[ "${FAKE_NO_CONTAINER:-0}" == "1" ]] && exit 0
    printf '%s\t%s\n' "vb-mongo-1" "docker.io/library/mongo:7.0" ;;
  inspect) exit "${FAKE_INSPECT_RC:-0}" ;;
  exec)
    case "$*" in
      *"command -v"*) echo "/usr/bin/mongosh" ;;
      *"--eval"*) echo "${FAKE_EVAL_OUT:-3}" ;;
      *"rm -f"*) exit 0 ;;
      *) echo "waline-reset matched=3 modified=3" ;;
    esac ;;
  cp)
    src="$2"
    if [[ -f "${src}" ]]; then cp "${src}" "${FAKE_CP_DIR}/captured-$RANDOM.js" 2>/dev/null || true; fi
    exit 0 ;;
esac
exit 0
STUB
chmod +x "${FAKE_BIN}/docker"
cp "${FAKE_BIN}/docker" "${FAKE_BIN}/podman"
: >"${FAKE_LOG}"

run_script() { env -i PATH="${FAKE_BIN}:/usr/bin:/bin" HOME="${TEST_DIR}" TMPDIR="${TEST_DIR}" \
  FAKE_ENGINE_LOG="${FAKE_LOG}" FAKE_CP_DIR="${FAKE_CP_DIR}" \
  FAKE_DOCKER_INFO_RC="${FAKE_DOCKER_INFO_RC:-0}" FAKE_NO_CONTAINER="${FAKE_NO_CONTAINER:-0}" \
  FAKE_INSPECT_RC="${FAKE_INSPECT_RC:-0}" FAKE_EVAL_OUT="${FAKE_EVAL_OUT:-3}" \
  WALINE_NEW_PASSWORD="${WALINE_NEW_PASSWORD:-}" WALINE_RESET_YES="${WALINE_RESET_YES:-}" \
  WALINE_MONGO_CONTAINER="${WALINE_MONGO_CONTAINER:-}" WALINE_DB="${WALINE_DB:-}" WALINE_ENGINE="${WALINE_ENGINE:-}" \
  bash "${SCRIPT}" "$@"; }
captured_js() { cat "${FAKE_CP_DIR}"/captured-*.js 2>/dev/null; }
reset_log() { : >"${FAKE_LOG}"; rm -f "${FAKE_CP_DIR}"/captured-*.js 2>/dev/null || true; }

# ── 源码级：已知凭据必须彻底消失 ────────────────────────────────────────────
echo
echo "-- 源码级不变式 --"
SRC="$(cat "${SCRIPT}")"
if printf '%s\n' "${SRC}" | grep -qE '\$2[abxy]\$[0-9]{2}\$'; then
  fail "文件里还有 bcrypt 哈希字面量（已知凭据的载体）"
else
  pass "文件里没有任何 bcrypt 哈希字面量"
fi
assert_not_contains "${SRC}" "123123" "上游那个尽人皆知的弱密码没了"
assert_not_contains "${SRC}" "admin@admin.com" "上游硬编码的邮箱没了（邮箱默认不动）"
if printf '%s\n' "${SRC}" | grep -vE '^[[:space:]]*#' | grep -qE 'exec .*-it|exec -it'; then
  fail "还有 exec -it（cron/管道里会挂）"
else
  pass "没有 exec -it（非交互场景可用）"
fi
if bash -n "${SCRIPT}" 2>/dev/null; then pass "bash -n 语法检查通过"; else fail "bash -n 不过"; fi
if [[ -x "${SCRIPT}" ]]; then pass "脚本有可执行位"; else fail "脚本没有可执行位"; fi

# ── 拒绝执行：没有密码来源 ──────────────────────────────────────────────────
echo
echo "-- 密码来源 --"
reset_log
run_script --yes >"${TEST_DIR}/o1" 2>&1 </dev/null
RC=$?
O1="$(cat "${TEST_DIR}/o1")"
assert_rc "${RC}" "2" "没有任何密码来源 → 拒绝执行（退出码 2）"
assert_contains "${O1}" "不再有内置默认密码" "拒绝时说清了为什么默认密码没了"
assert_contains "${O1}" "--generate" "给出了随机生成的路"
assert_contains "${O1}" "WALINE_NEW_PASSWORD" "给出了环境变量的路"
assert_eq "$(cat "${FAKE_LOG}")" "" "拒绝时一条引擎命令都没发（连容器都不找）"
run_script --password abc --yes >"${TEST_DIR}/o2" 2>&1 </dev/null
RC=$?
assert_rc "${RC}" "2" "弱密码（<8 位）直接拒绝"
assert_contains "$(cat "${TEST_DIR}/o2")" "密码太短" "说清了是长度问题"
run_script --no-such-flag >"${TEST_DIR}/o3" 2>&1 </dev/null
assert_rc "$?" "2" "未知参数 → 退出码 2 并打用法"
run_script --generate --cost 99 --yes >"${TEST_DIR}/o4" 2>&1 </dev/null
assert_rc "$?" "2" "cost 超出 4–31 → 拒绝"

# 本机有没有能算 bcrypt 的工具（没有的话生成/改库用例只能 SKIP，不算失败）
HAS_HASHER=0
if command -v python3 >/dev/null 2>&1 && python3 -c 'import bcrypt' >/dev/null 2>&1; then
  HAS_HASHER=1
elif command -v htpasswd >/dev/null 2>&1; then
  HAS_HASHER=1
fi

# ── 确认门 ─────────────────────────────────────────────────────────────────
echo
echo "-- 确认门（改的是全部管理员行，必须先问）--"
reset_log
WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script >"${TEST_DIR}/c1" 2>&1 <<<"n"
RC=$?
C1="$(cat "${TEST_DIR}/c1")"
assert_rc "${RC}" "1" "输入 n → 取消（退出码 1）"
assert_contains "${C1}" "已取消" "明说取消了"
assert_contains "${C1}" "没有被改动" "明说库没被碰"
assert_eq "$(grep -c ' cp ' "${FAKE_LOG}" 2>/dev/null || true)" "0" "取消时一条 cp/改库命令都没发"
reset_log
WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script >"${TEST_DIR}/c2" 2>&1 </dev/null
RC=$?
assert_rc "${RC}" "1" "stdin 不可用且没 --yes → 拒绝而不是悬挂（cron 安全）"
assert_contains "$(cat "${TEST_DIR}/c2")" "--yes" "并告诉自动化场景该用什么"
reset_log
WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script >"${TEST_DIR}/c3" 2>&1 <<<"yes"
RC=$?
C3="$(cat "${TEST_DIR}/c3")"
assert_rc "${RC}" "0" "输入 yes → 放行"
assert_contains "${C3}" "即将执行" "动库前打印了将要发生什么"
assert_contains "${C3}" "administrator" "说清了改的是哪些行"
assert_contains "${C3}" "matched=3 modified=3" "汇报了实际改动的行数（来自桩）"
assert_contains "$(cat "${FAKE_LOG}")" "cp " "放行后才把 JS 拷进容器"
reset_log
WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script --yes >"${TEST_DIR}/c4" 2>&1 </dev/null
assert_rc "$?" "0" "--yes 跳过确认（stdin 关着也能走完全程）"

# ── 送进容器的 JS：只有哈希、没有明文；邮箱默认不动 ────────────────────────
echo
echo "-- JS 内容 --"
if [[ "${HAS_HASHER}" != "1" ]]; then
  skip "本机没有 python3-bcrypt / htpasswd，跳过哈希相关用例"
else
  JS="$(captured_js)"
  assert_contains "${JS}" 'db.Users.updateMany({ type: "administrator" }' "JS 改的是 Users 集合里 type=administrator 的行（本项目的真实形状）"
  if printf '%s' "${JS}" | grep -qE "password: '\\\$2[abxy]\\\$[0-9]{2}\\\$"; then
    pass "JS 里的 password 是 bcrypt 哈希"
  else
    fail "JS 里的 password 不是 bcrypt 哈希形状"
  fi
  assert_not_contains "${JS}" "Str0ng-Test-Passw0rd" "明文密码绝不进 JS（更不进库）"
  assert_not_contains "${C3}" "Str0ng-Test-Passw0rd" "指定密码时输出里也不回显明文"
  assert_not_contains "${JS}" "email" "没给 --email 时 JS 里没有 email 字段（邮箱保持不动）"
  assert_not_contains "$(cat "${FAKE_LOG}")" "updateAdmin.js" "不再往当前目录写 updateAdmin.js（临时文件走 mktemp+trap）"
  reset_log
  WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script --yes --email someone@example.com >"${TEST_DIR}/e1" 2>&1 </dev/null
  assert_rc "$?" "0" "--email 给了就能一并改邮箱"
  assert_contains "$(captured_js)" "email: 'someone@example.com'" "JS 里带上了 email"
  # cost 生效（哈希前缀里的 cost 段）
  reset_log
  WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script --yes --cost 12 >"${TEST_DIR}/e2" 2>&1 </dev/null
  if printf '%s' "$(captured_js)" | grep -qE '\$2[abxy]\$12\$'; then
    pass "--cost 12 真的用上了（哈希里是 12）"
  else
    fail "--cost 12 没有反映到哈希里"
  fi
fi

# ── --generate：长、随机、只打印一次 ───────────────────────────────────────
echo
echo "-- --generate --"
if [[ "${HAS_HASHER}" != "1" ]]; then
  skip "本机没有 bcrypt 工具，跳过 --generate 用例"
else
  reset_log
  run_script --generate --yes >"${TEST_DIR}/g1" 2>&1 </dev/null
  RC=$?
  G1="$(cat "${TEST_DIR}/g1")"
  assert_rc "${RC}" "0" "--generate --yes 走完全程"
  PW1="$(printf '%s\n' "${G1}" | grep -oE '^    [A-Za-z0-9]{20,24}$' | tr -d ' ' | head -1)"
  if [[ -n "${PW1}" ]]; then
    pass "打印了生成的密码（独立一行，方便复制）"
    if [[ "${#PW1}" -ge 20 ]]; then pass "密码长度 ${#PW1} ≥ 20"; else fail "密码太短：${#PW1}"; fi
    N_TIMES="$(printf '%s\n' "${G1}" | grep -cF -- "${PW1}" || true)"
    assert_eq "${N_TIMES}" "1" "密码在输出里只出现一次（脚本不留副本、不重复打印）"
    assert_contains "${G1}" "只显示这一次" "明说了只显示一次、要立刻保存"
    assert_not_contains "$(captured_js)" "${PW1}" "明文不进 JS（库里只有哈希）"
  else
    fail "输出里找不到生成的密码行"
  fi
  reset_log
  run_script --generate --yes >"${TEST_DIR}/g2" 2>&1 </dev/null
  PW2="$(grep -oE '^    [A-Za-z0-9]{20,24}$' "${TEST_DIR}/g2" | tr -d ' ' | head -1)"
  assert_ne "${PW1}" "${PW2}" "两次生成的密码不同（真的在随机，不是常量）"
fi

# ── 引擎与容器发现 ─────────────────────────────────────────────────────────
echo
echo "-- 引擎探测 / 容器发现 --"
reset_log
FAKE_DOCKER_INFO_RC=1 WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script --yes >"${TEST_DIR}/p1" 2>&1 </dev/null
assert_rc "$?" "0" "docker daemon 连不上时回落到 podman（本机形状）"
assert_contains "$(cat "${FAKE_LOG}")" "podman ps" "后面的命令确实走的 podman"
reset_log
FAKE_NO_CONTAINER=1 WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script --yes >"${TEST_DIR}/p2" 2>&1 </dev/null
RC=$?
assert_rc "${RC}" "5" "找不到 mongo 容器 → 退出码 5"
assert_contains "$(cat "${TEST_DIR}/p2")" "没有找到运行中的 mongo 容器" "说清了怎么指定（--container）"
reset_log
FAKE_EVAL_OUT=0 WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script --yes >"${TEST_DIR}/p3" 2>&1 </dev/null
RC=$?
assert_rc "${RC}" "7" "waline 库里没有 administrator 行 → 退出码 7（不做假成功的空操作）"
assert_contains "$(cat "${TEST_DIR}/p3")" "没有可重置的对象" "解释了为什么拒绝"
assert_contains "$(cat "${TEST_DIR}/p3")" "--db" "并提示了库名可能不对（VAN_BLOG_WALINE_DB）"
reset_log
FAKE_INSPECT_RC=1 WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script --yes --container ghost >"${TEST_DIR}/p4" 2>&1 </dev/null
assert_rc "$?" "5" "--container 指到一个不存在的容器 → 退出码 5"
reset_log
WALINE_NEW_PASSWORD='Str0ng-Test-Passw0rd' run_script --yes --container my-mongo --db mywaline >"${TEST_DIR}/p5" 2>&1 </dev/null
assert_rc "$?" "0" "--container/--db 显式指定时全程可用"
assert_contains "$(cat "${TEST_DIR}/p5")" "mywaline" "摘要里报的是指定的库名"

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
