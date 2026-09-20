#!/usr/bin/env bash
# mongo healthcheck + depends_on 长/短格式的测试（§7.40 D-18 的落地）。
# 背景（都是实测出来的，不是猜的）：
#   - docker-compose 1.25.5 的 config_schema_v3.0~v3.3 里 healthcheck **没有 start_period**
#     （additionalProperties:false → `version: '3'` 的模板写 start_period 会被直接拒掉），
#     v3.4 起才有 → 模板 version 必须是 '3.4'；
#   - 同版本的 depends_on 在 v3.x 全部 schema 里都只是 list_of_strings，
#     condition 长格式要 docker-compose ≥1.27 / compose v2 → 只能实测探测，不能猜版本号。
# docker-compose 用 PATH 上的假二进制模拟"支持/不支持"两代实现，不碰任何真容器。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/vanblog.sh"
TEMPLATE="${ROOT}/docker-compose/docker-compose-template.yml"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
assert_eq() { if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then pass "$3"; else fail "$3 (missing: $2)"; fi; }
assert_not_contains() { if printf '%s' "$1" 2>/dev/null | grep -qF -- "$2"; then fail "$3 (unexpected: $2)"; else pass "$3"; fi; }
assert_file_contains() { if grep -qF -- "$2" "$1"; then pass "$3"; else fail "$3 (missing in $1: $2)"; fi; }
assert_file_not_contains() { if grep -qF -- "$2" "$1"; then fail "$3 (unexpected in $1: $2)"; else pass "$3"; fi; }

echo "== mongo healthcheck 与 depends_on 形式 =="

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

BASE="${TEST_DIR}/var/vanblog"
DATA="${BASE}/data"
mkdir -p "${DATA}"

# ---------- 1) 模板内容 ----------
TPL="$(cat "${TEMPLATE}")"
# 反向断言前先剥注释（模板注释里就写着 condition: service_healthy 这些词 —— 不剥就自己匹配自己）
TPL_CODE="$(sed 's|^[[:space:]]*#.*||' "${TEMPLATE}")"

assert_contains "${TPL_CODE}" "healthcheck:" "模板里有 mongo healthcheck"
assert_contains "${TPL_CODE}" "mongosh --quiet --eval 'db.runCommand({ping:1}).ok'" "healthcheck 先试 mongosh（7.0 没有 legacy mongo shell）"
assert_contains "${TPL_CODE}" "|| mongo --quiet --eval 'db.runCommand({ping:1}).ok'" "mongosh 不存在/失败时落到 legacy mongo（4.4.16 没有 mongosh）"
assert_contains "${TPL_CODE}" "CMD-SHELL" "healthcheck 用 CMD-SHELL（要跑 shell 的 || 短路）"
assert_contains "${TPL_CODE}" "interval: 10s" "interval 10s"
assert_contains "${TPL_CODE}" "timeout: 5s" "timeout 5s"
assert_contains "${TPL_CODE}" "retries: 5" "retries 5"
assert_contains "${TPL_CODE}" "start_period: 40s" "start_period 40s（首启初始化/journal 回放不计入失败）"
assert_contains "${TPL_CODE}" "version: '3.4'" "version 是 '3.4'（start_period 要 ≥3.4；1.25 对 '3'=3.0 的 schema 会拒掉它）"
assert_contains "${TPL}" "docker-compose ≥1.27" "模板注释解释了长格式的版本门槛"
assert_contains "${TPL}" "1.25" "模板注释点名 Ubuntu 20.04 的 1.25 会解析失败"
# 提交的模板必须是**列表形式**（老 compose 也能解析的方向），长格式由脚本按本机实测升级
assert_contains "${TPL_CODE}" "- mongo" "模板提交的 depends_on 是列表形式（对老 compose 安全）"
assert_not_contains "${TPL_CODE}" "condition: service_healthy" "模板没有把长格式写死（写死会把 1.25 的现有安装搞坏）"

# healthcheck 必须挂在 mongo 服务块里（vanblog 服务现在**也**有一份，理由见下面那条升级说明）
MONGO_BLOCK="$(awk '/^  mongo:[[:space:]]*$/{f=1} f&&/^  [A-Za-z0-9_-]+:[[:space:]]*$/&&$1!="mongo:"{f=0} f' "${TEMPLATE}")"
assert_contains "${MONGO_BLOCK}" "healthcheck:" "healthcheck 在 mongo 服务块里"
VANBLOG_BLOCK="$(awk '/^  vanblog:[[:space:]]*$/{f=1} f&&/^  [A-Za-z0-9_-]+:[[:space:]]*$/&&$1!="vanblog:"{f=0} f' "${TEMPLATE}")"
# ⚠️ 这条断言以前是 `assert_not_contains "${VANBLOG_BLOCK}" "healthcheck:"`，理由写的是
#    "镜像自己有 HEALTHCHECK 指令，编排里不重复"。那个理由在 **podman 下不成立**：
#    podman/buildah 构建会**丢掉** Dockerfile 的 HEALTHCHECK 指令 ⇒ podman 部署**零健康探测**，
#    而 podman 的 `restart: always` 也不会因为 unhealthy 而重启（要 `--health-on-failure=restart`）。
#    于是断言被**升级**（不是删除）：vanblog 服务现在**必须有** healthcheck，而且它的探测程序必须
#    与 Dockerfile 里那段**逐字节相同** —— 两处真相由这条测试同步，而不是靠人记得。
assert_contains "${VANBLOG_BLOCK}" "healthcheck:" "vanblog 服务有 healthcheck（podman 构建会丢掉镜像的 HEALTHCHECK，编排里必须自己写一份）"
# ⚠️ 下面这几条必须打在**剥掉注释**的文本上：模板的注释里本来就写着 `start_period`（解释它为什么
#    需要 3.4 格式）与 `curl`（解释为什么不能用），所以直接对整个服务块断言会**匹配到注释** ——
#    变异对照实测过：把真的 `start_period: 180s` 那行删掉，断言仍然绿。
#    这是本仓库第 9 次踩"断言匹配到解释性注释"，所以这里连"剥离确实生效"都要反证一次。
#    ⚠️ 只能用 `sed '/^[[:space:]]*#/d'`：**绝不要**用 server 那个 `stripCommentsForAnchor`
#    （那是 TS 剥注释器，会把 `https://` 当行注释、被引号与 `$( )` 带偏，实测把整份 shell 脚本啃残）。
VANBLOG_BLOCK_CODE="$(printf '%s\n' "${VANBLOG_BLOCK}" | sed '/^[[:space:]]*#/d')"
if [[ "${VANBLOG_BLOCK}" != "${VANBLOG_BLOCK_CODE}" ]]; then
  pass "剥注释这一步确实生效（否则下面的断言可能是在匹配注释）"
else
  fail "剥注释前后一样：要么模板没有注释（不可能），要么 sed 形状写错了，下面的断言不可信"
fi
assert_contains "${VANBLOG_BLOCK_CODE}" "start_period" "vanblog 的 healthcheck **配置里**给了 start_period（冷启动 + 首次连 mongo 很慢，不给足会一起来就 unhealthy）"
assert_contains "${VANBLOG_BLOCK_CODE}" "healthcheck:" "剥注释后 healthcheck 配置仍然存在（不是在匹配注释里的字）"
assert_not_contains "${VANBLOG_BLOCK_CODE}" "curl" "vanblog 的 healthcheck 不用 curl（镜像里没装 curl，用了会永远 unhealthy）"
# 探测程序两处必须逐字节相同（漂移守卫）：Dockerfile 的 HEALTHCHECK 与编排的 healthcheck.test
DF_HEALTHCHECK_PROG="$(sed -n 's/^  CMD node -e "\(.*\)"$/\1/p' "${ROOT}/Dockerfile")"
TPL_HEALTHCHECK_PROG="$(printf '%s\n' "${VANBLOG_BLOCK}" | sed -n 's/^ *test: \["CMD", "node", "-e", "\(.*\)"\]$/\1/p')"
if [[ -n "${DF_HEALTHCHECK_PROG}" && "${DF_HEALTHCHECK_PROG}" == "${TPL_HEALTHCHECK_PROG}" ]]; then
  pass "编排与 Dockerfile 的健康探测程序逐字节相同（${#DF_HEALTHCHECK_PROG} 字符）"
else
  fail "编排与 Dockerfile 的健康探测程序不一致（Dockerfile ${#DF_HEALTHCHECK_PROG} 字符 / 编排 ${#TPL_HEALTHCHECK_PROG} 字符）—— 改一处必须改两处"
fi
# 空转反证：抽程序的两条 sed 必须真的抽到东西，否则会拿两个空串比出"相同"
if [[ ${#DF_HEALTHCHECK_PROG} -gt 100 && ${#TPL_HEALTHCHECK_PROG} -gt 100 ]]; then
  pass "两处都真的抽到了探测程序（不是两个空串假绿）"
else
  fail "探测程序没抽到（sed 形状与文件内容对不上），漂移守卫等于没生效"
fi
assert_contains "${TPL_HEALTHCHECK_PROG}" "3001" "编排那份也探前台（3001），不只是 caddy:80"

# YAML 必须能解析，且结构与预期一致（有 python3 才做，没有就跳过并说明）
if command -v python3 >/dev/null 2>&1; then
  PYOUT="$(python3 - "${TEMPLATE}" <<'PYEOF'
import sys, yaml, json
d = yaml.safe_load(open(sys.argv[1]))
hc = d['services']['mongo']['healthcheck']
dep = d['services']['vanblog']['depends_on']
print(json.dumps({
    'version': d.get('version'),
    'test0': hc['test'][0],
    'interval': hc['interval'],
    'timeout': hc['timeout'],
    'retries': hc['retries'],
    'start_period': hc['start_period'],
    'depends_on': dep,
}))
PYEOF
)"
  if [[ -n "${PYOUT}" ]]; then
    pass "模板是合法 YAML（python3 + pyyaml 解析通过）"
    assert_contains "${PYOUT}" '"version": "3.4"' "解析出的 version 是字符串 3.4"
    assert_contains "${PYOUT}" '"test0": "CMD-SHELL"' "healthcheck.test 是 CMD-SHELL 形式"
    assert_contains "${PYOUT}" '"depends_on": ["mongo"]' "解析出的 depends_on 是列表 ['mongo']"
    assert_contains "${PYOUT}" '"start_period": "40s"' "start_period 解析为 40s"
  else
    fail "模板解析失败（python3 报了错）"
  fi
else
  echo "NOTE: 没有 python3，跳过 YAML 解析用例"
fi

# ---------- 2) 探测函数：不猜版本号，实测 docker-compose config ----------
BIN="${TEST_DIR}/bin"
mkdir -p "${BIN}"
# 假 docker-compose：SUPPORT_COND=1 时 `config` 成功（模拟 compose v2 / ≥1.27），否则失败（模拟 1.25）
# ⚠️ 桩要用的变量全部 export（子进程看不见 shell 变量）
export PROBE_CAPTURE="${TEST_DIR}/probe.yml"
cat >"${BIN}/docker-compose" <<'EOS'
#!/usr/bin/env bash
echo "docker-compose $*" >>"${CMDLOG:-/dev/null}"
if [[ "$1" == "-f" ]]; then
  cp "$2" "${PROBE_CAPTURE}" 2>/dev/null || true
  [[ "$3" == "config" ]] || exit 0
  [[ "${SUPPORT_COND:-0}" == "1" ]] && exit 0
  # 模拟 1.25 的真实报错去向（stderr）
  echo "ERROR: The Compose file is invalid because configuration for probe_a should be a mapping" >&2
  exit 1
fi
exit 0
EOS
chmod +x "${BIN}/docker-compose"
export PATH="${BIN}:${PATH}"
# ⚠️ 清掉可能存在的函数桩（函数优先级高于 PATH 里的假二进制 —— AGENTS 记过的坑）
unset -f docker docker-compose curl git df du crontab 2>/dev/null || true

source_script() {
  export VANBLOG_SKIP_MAIN=1
  export VANBLOG_BASE_PATH="${BASE}"
  export VANBLOG_DATA_PATH="${DATA}"
  unset VANBLOG_DATA_PATH_RAW VANBLOG_COMPOSE_COND_SUPPORT VANBLOG_USE_UPSTREAM_IMAGE
  # shellcheck disable=SC1090
  source "${SCRIPT}" >/dev/null 2>&1
}

source_script
export SUPPORT_COND=1
if compose_supports_depends_condition; then pass "config 成功 → 判定支持长格式"; else fail "config 成功应判定支持"; fi
assert_eq "${VANBLOG_COMPOSE_COND_SUPPORT}" "yes" "探测结果缓存为 yes"
assert_file_contains "${PROBE_CAPTURE}" "condition: service_healthy" "探测文件真的用了 condition 长格式（实测而不是猜版本号）"
assert_file_contains "${PROBE_CAPTURE}" "version: '3.4'" "探测文件与生成的编排文件同 version（老 compose 若对 3.4 严格，也如实反映）"
# 缓存生效：换成"不支持"的环境，不重置缓存就还是 yes
export SUPPORT_COND=0
if compose_supports_depends_condition; then pass "结果有缓存（同一进程只实测一次）"; else fail "缓存没生效"; fi
VANBLOG_COMPOSE_COND_SUPPORT=""
if compose_supports_depends_condition; then fail "config 失败应判定不支持"; else pass "config 失败 → 判定不支持（1.25 的行为）"; fi
assert_eq "${VANBLOG_COMPOSE_COND_SUPPORT}" "no" "探测结果缓存为 no"

# 没有 docker-compose 命令时 → 不支持（保持列表形式），且不炸
VANBLOG_COMPOSE_COND_SUPPORT=""
OUT="$(PATH="${TEST_DIR}/no-such-bin" compose_supports_depends_condition 2>&1; echo "rc=$?")"
assert_contains "${OUT}" "rc=1" "没有 docker-compose 命令时判定为不支持（返回非 0，不报错）"

# ---------- 3) apply_depends_on_form：升级 / 降级 / 幂等 / 无 healthcheck 不动 ----------
gen_compose() { # 从真模板生成一份替换过占位符的编排文件
  sed -e 's|vanblog_image|ghcr.io/ckboss/vanblog:dev-dsh|' \
    -e 's|vanblog_mongo_image|mongo:7.0|' \
    -e "s|vanblog_data_path|${DATA}|g" \
    -e 's|vanblog_http_port|8080|' -e 's|vanblog_https_port|8443|' \
    -e 's|vanblog_email|a@b.example.com|' \
    "${TEMPLATE}" >"${BASE}/docker-compose.yaml"
}

source_script
gen_compose
export SUPPORT_COND=1
VANBLOG_COMPOSE_COND_SUPPORT=""
OUT="$(apply_depends_on_form "${BASE}/docker-compose.yaml" 2>&1)"
assert_contains "${OUT}" "健康检查通过" "升级时打印一行说明（等什么、为什么）"
assert_file_contains "${BASE}/docker-compose.yaml" "condition: service_healthy" "支持的机器上升级成长格式"
assert_file_contains "${BASE}/docker-compose.yaml" "      mongo:" "长格式的 mongo 键缩进正确"
assert_file_not_contains "${BASE}/docker-compose.yaml" "      - mongo" "升级后列表形式的那行没了（不是两种并存）"
# 升级后的文件必须还是合法 YAML、depends_on 形状正确
if command -v python3 >/dev/null 2>&1; then
  DEP="$(python3 -c "import yaml,json; print(json.dumps(yaml.safe_load(open('${BASE}/docker-compose.yaml'))['services']['vanblog']['depends_on']))" 2>/dev/null)"
  assert_eq "${DEP}" '{"mongo": {"condition": "service_healthy"}}' "升级后 YAML 解析出 condition 长格式"
fi
# 幂等：再跑一次不重复改
BEFORE="$(cat "${BASE}/docker-compose.yaml")"
VANBLOG_COMPOSE_COND_SUPPORT=""
OUT2="$(apply_depends_on_form "${BASE}/docker-compose.yaml" 2>&1)"
AFTER="$(cat "${BASE}/docker-compose.yaml")"
assert_eq "${AFTER}" "${BEFORE}" "长格式文件在支持的机器上再跑一次不变（幂等）"
assert_eq "$(grep -c 'condition: service_healthy' <<<"${AFTER}" | tr -d ' ')" "$(grep -c 'condition: service_healthy' <<<"${BEFORE}" | tr -d ' ')" "condition 行数没有增加"

# 降级：老 compose + 长格式文件 → 回到列表形式，并打印一行原因
export SUPPORT_COND=0
VANBLOG_COMPOSE_COND_SUPPORT=""
OUT="$(apply_depends_on_form "${BASE}/docker-compose.yaml" 2>&1)"
assert_contains "${OUT}" "不支持" "降级时打印一行说明为什么"
assert_contains "${OUT}" "列表形式" "降级说明里写清退回了列表形式"
assert_file_contains "${BASE}/docker-compose.yaml" "- mongo" "降级后是列表形式"
assert_file_not_contains "$(sed 's|^[[:space:]]*#.*||' "${BASE}/docker-compose.yaml")" "condition: service_healthy" "降级后代码里不再有 condition（注释除外）"
if command -v python3 >/dev/null 2>&1; then
  DEP="$(python3 -c "import yaml,json; print(json.dumps(yaml.safe_load(open('${BASE}/docker-compose.yaml'))['services']['vanblog']['depends_on']))" 2>/dev/null)"
  assert_eq "${DEP}" '["mongo"]' "降级后 YAML 解析回列表 ['mongo']"
fi
# 老 compose + 列表形式（模板默认）→ 保持原样 + 一行说明
BEFORE="$(cat "${BASE}/docker-compose.yaml")"
VANBLOG_COMPOSE_COND_SUPPORT=""
OUT="$(apply_depends_on_form "${BASE}/docker-compose.yaml" 2>&1)"
assert_eq "$(cat "${BASE}/docker-compose.yaml")" "${BEFORE}" "不支持时列表形式的文件原样保留"
assert_contains "${OUT}" "列表形式" "不支持时也打印一行说明（用户知道为什么没等健康）"

# 支持长格式但 mongo 没有 healthcheck（例如上游旧模板生成的文件）→ 不许升级
gen_compose
python3 - "${BASE}/docker-compose.yaml" <<'PYEOF' 2>/dev/null || sed -i '/healthcheck:/,+6d' "${BASE}/docker-compose.yaml"
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'    healthcheck:\n(?:      .*\n)+', '', s)
open(p, 'w').write(s)
PYEOF
export SUPPORT_COND=1
VANBLOG_COMPOSE_COND_SUPPORT=""
OUT="$(apply_depends_on_form "${BASE}/docker-compose.yaml" 2>&1)"
assert_file_contains "${BASE}/docker-compose.yaml" "- mongo" "没有 healthcheck 时不升级（service_healthy 会永远等不到/直接报错）"
assert_contains "${OUT}" "没有 healthcheck" "不升级时明说原因"

# 异形文件（depends_on 被人手改过）→ 原样不动，返回 0
gen_compose
printf 'services:\n  vanblog:\n    image: x\n    depends_on:\n      mongo: {}\n  mongo:\n    image: mongo:7.0\n    healthcheck:\n      test: ["CMD", "true"]\n' >"${BASE}/weird.yaml"
BEFORE="$(cat "${BASE}/weird.yaml")"
VANBLOG_COMPOSE_COND_SUPPORT=""
apply_depends_on_form "${BASE}/weird.yaml" >/dev/null 2>&1
RC=$?
assert_eq "${RC}" "0" "异形 depends_on 不炸（返回 0）"
assert_eq "$(cat "${BASE}/weird.yaml")" "${BEFORE}" "异形 depends_on 原样保留（不敢乱改用户手写的东西）"
# 不存在的文件也不炸
apply_depends_on_form "${BASE}/no-such-file.yaml" >/dev/null 2>&1
assert_eq "$?" "0" "文件不存在时安静返回"

# ---------- 4) config 集成：整条生成链路走下来形状正确 ----------
source_script
gen_compose # 预置一份"现有编排"，让 config 沿用镜像、不去构建
export VANBLOG_USE_UPSTREAM_IMAGE=true
download_compose_template() { cp "${TEMPLATE}" "$1"; } # 无网络：模板直接给本地这份
export SUPPORT_COND=1
VANBLOG_COMPOSE_COND_SUPPORT=""
printf 'a@b.example.com\n8080\n8443\n' | config 0 >"${TEST_DIR}/config-v2.out" 2>&1
RC=$?
assert_eq "${RC}" "0" "config（compose v2 环境）返回 0"
assert_file_contains "${BASE}/docker-compose.yaml" "condition: service_healthy" "config 生成的编排文件在 v2 环境里是长格式"
assert_file_contains "${BASE}/docker-compose.yaml" "healthcheck:" "config 生成的编排文件带着 mongo healthcheck"
assert_file_contains "${BASE}/docker-compose.yaml" "image: mongo:7.0" "mongo 占位符照常替换"
export SUPPORT_COND=0
source_script
gen_compose
download_compose_template() { cp "${TEMPLATE}" "$1"; }
VANBLOG_COMPOSE_COND_SUPPORT=""
printf 'a@b.example.com\n8080\n8443\n' | config 0 >"${TEST_DIR}/config-125.out" 2>&1
RC=$?
assert_eq "${RC}" "0" "config（1.25 环境）返回 0"
assert_file_contains "${BASE}/docker-compose.yaml" "- mongo" "config 生成的编排文件在 1.25 环境里是列表形式"
assert_file_not_contains "$(sed 's|^[[:space:]]*#.*||' "${BASE}/docker-compose.yaml")" "condition: service_healthy" "1.25 环境里代码中没有 condition（生成物老 compose 解析得了）"
assert_file_contains "${BASE}/docker-compose.yaml" "healthcheck:" "1.25 环境里 healthcheck 仍然在（它本身 3.4 就支持，白拿状态可见性）"
assert_contains "$(cat "${TEST_DIR}/config-125.out")" "列表形式" "1.25 环境下 config 输出解释了为什么是列表形式"


# ══════════════════════════════════════════════════════════════════════════════
# 部署层加固（站长裁定：容器继续以 root 运行，只做编排层收窄 + 文档写明风险）
#
# ⚠️ 这一节的断言分两类，两类都必须有：
#   (a) 「已启用」的那一项必须真的出现在**剥注释后**的文本里，并且用 PyYAML 解析后按值断言
#       —— 只 grep 原文的话，一行注释就能让它假绿。
#   (b) 「故意不启用」的三项必须**同时**满足：剥注释后不存在（真的没启用）+ 原文里存在
#       （理由与打开方法写在注释里，下一个人能读到）。
#       ⚠️ 只写 (b) 的前半就是空断言：模板里从来不写这三个词也能过。
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "== 部署层加固：no-new-privileges 与三项故意不启用的收窄 =="

MONGO_BLOCK="$(awk '/^  mongo:[[:space:]]*$/{f=1} f&&/^  [A-Za-z0-9_-]+:[[:space:]]*$/&&$1!="mongo:"{f=0} f' "${TEMPLATE}")"

assert_contains "${VANBLOG_BLOCK_CODE}" "security_opt:" "vanblog 服务真的启用了 security_opt（剥注释后仍在 ⇒ 不是注释里的字）"
assert_contains "${VANBLOG_BLOCK_CODE}" "no-new-privileges:true" "vanblog 服务启用了 no-new-privileges:true（剥注释后仍在）"
assert_not_contains "${MONGO_BLOCK}" "security_opt" "mongo 服务**故意不加** security_opt（官方镜像 entrypoint 以 root 启动时会自己降权，那条路径依赖 setuid/setgid 语义，本轮无容器可实测）"

# ── no-new-privileges 的安全前提是一条**跨文件不变量**：容器里不能有需要提权的步骤 ──
# ⚠️ 这条断言的意义是"将来有人往 entrypoint 里加 gosu/setpriv 时会撞红"，
#    因为那时 no-new-privileges 就会让启动失败，而失败形状是"容器起不来"、很难联想到这一行。
for f in entrypoint.sh scripts/start.js Dockerfile; do
  NOPRIV_CODE="$(sed '/^[[:space:]]*#/d' "${ROOT}/${f}" 2>/dev/null)"
  #    ⚠️ 只能用 sed 剥注释：绝不要用 server 那个 stripCommentsForAnchor（会把 https:// 当行注释吃掉）
  for w in gosu setpriv setuid newgrp; do
    assert_not_contains "${NOPRIV_CODE}" "${w}" "${f} 剥注释后不含 ${w}（no-new-privileges 的安全前提；若将来需要提权步骤，必须同时重新评估这一行）"
  done
done

# ── 三项「故意不启用」的收窄：剥注释后必须不存在，原文里必须有（带理由）──
for key in "read_only:" "pids_limit:" "cap_drop:"; do
  assert_not_contains "${TPL_CODE}" "${key}" "模板里 ${key} **没有被启用**（剥注释后不存在；理由写在注释里）"
  assert_contains "${TPL}" "${key}" "模板的注释里**有** ${key} 这个可选项（否则上一条断言是空转：从来没写过也算过）"
done
assert_contains "${TPL}" "CAP_DAC_OVERRIDE" "注释里写清了 cap_drop 的风险来源（root 写宿主属主的 bind mount 靠 CAP_DAC_OVERRIDE）"
assert_contains "${TPL}" "/app/caddy.json" "注释里点名了 read_only 的第一个阻塞点（entrypoint 每次启动都要写 /app/caddy.json）"
assert_contains "${TPL}" "codeRunner" "注释里点名了 read_only 的第二个阻塞点（流水线要写 /app/codeRunner）"
assert_contains "${TPL}" ".next/server/pages" "注释里点名了 read_only 的第三个阻塞点（ISR 产物写在 .next/server/pages 下）"
assert_contains "${TPL}" "1.29.2" "pids_limit 的注释写明了版本依据是**实证过的** 1.29.2 schema，而不是凭印象"

# ── 语义级：用 PyYAML 解析后按键断言（文本断言证明不了"它是一个值"）──
K8S_MD="${ROOT}/docs/guide/kubernetes.snippet.md"
python3 - "${TEMPLATE}" "${K8S_MD}" >"${TEST_DIR}/hardening.py.out" 2>&1 <<'PYEOF'
import re, sys, yaml
tpl_path, k8s_path = sys.argv[1], sys.argv[2]
s = open(tpl_path, encoding='utf-8').read()
for k, v in [('vanblog_data_path', '/var/vanblog'), ('vanblog_image', 'x/y:z'),
             ('vanblog_mongo_image', 'mongo:7.0'), ('vanblog_http_port', '80'),
             ('vanblog_https_port', '443'), ('vanblog_email', 'a@b.example.com')]:
    s = s.replace(k, v)
d = yaml.safe_load(s)
vb = d['services']['vanblog']
mg = d['services']['mongo']
rc = 0
def ck(cond, msg):
    global rc
    print(('PASS: ' if cond else 'FAIL: ') + msg)
    if not cond: rc = 1
ck(vb.get('security_opt') == ['no-new-privileges:true'],
   "解析后 vanblog.security_opt 的值恰好是 ['no-new-privileges:true']（不是文本里出现过就算）")
ck('security_opt' not in mg, "解析后 mongo 服务没有 security_opt 键")
for key in ('read_only', 'pids_limit', 'cap_drop', 'cap_add', 'privileged'):
    ck(key not in vb, f"解析后 vanblog 服务没有 {key} 键（故意不启用的收窄）")
    ck(key not in mg, f"解析后 mongo 服务没有 {key} 键")
ck(vb.get('restart') == 'always' and vb.get('stop_grace_period') == '30s',
   "既有的 restart/stop_grace_period 没有被这次加固弄丢")
ck(vb.get('ulimits', {}).get('nofile', {}).get('soft') == 65536,
   "既有的 ulimits.nofile 没有被这次加固弄丢（C10K 的前提之一）")

# ── k8s 清单：PyYAML 解析后按 k8s 语义断言 ──
block = re.findall(r'```yaml\n(.*?)```', open(k8s_path, encoding='utf-8').read(), re.S)[0]
k = yaml.safe_load(block)
spec = k['spec']['template']['spec']; c = spec['containers'][0]
ck('limits' not in c, "🔴 k8s 容器层**没有**误挂的 limits 键（它不是合法的 k8s 字段；曾缩进错到这一层 ⇒ apply 被拒或被静默丢弃、上限等于没设）")
res = c.get('resources', {})
ck('limits' in res and 'requests' in res, "k8s resources 同时有 requests 与 limits（limits 是 resources 的**子键**）")
def mib(v):
    n = int(re.sub(r'[^0-9]', '', str(v)))
    return n * 1024 if str(v).endswith('Gi') else n
ck(mib(res.get('limits', {}).get('memory', '0Mi')) >= 1024,
   "k8s 内存上限 ≥ 1Gi（整站备份用 zstd -19 --long=27 -T0 峰值约 1GB；500Mi 会把备份 OOM 杀掉）")
sc = c.get('securityContext', {})
ck(sc.get('allowPrivilegeEscalation') is False, "k8s allowPrivilegeEscalation:false（与 compose 的 no-new-privileges 同口径）")
ck(sc.get('seccompProfile', {}).get('type') == 'RuntimeDefault', "k8s seccompProfile 显式写 RuntimeDefault（集群默认策略变了也不会静默放宽）")
ck(sc.get('runAsNonRoot') is False, "k8s runAsNonRoot 如实写 false（这个镜像就是 root；写出来是为了不误导 —— 它过不了 PodSecurity restricted）")
ck('capabilities' not in sc, "k8s securityContext **没有**默认打开 capabilities 收窄（与 compose 同一理由：root 写宿主属主 hostPath 靠 CAP_DAC_OVERRIDE，本轮无集群可实测）")
ck(sorted(p['name'] for p in c['ports']) or True, "k8s 端口存在")
ck([(p['containerPort'], p.get('protocol')) for p in c['ports']] == [(80,'TCP'),(443,'TCP'),(443,'UDP')],
   "k8s 端口仍是 (80,TCP)/(443,TCP)/(443,UDP)（QUIC 的 UDP 443 没被这次改动弄丢）")
vols = {v['name'] for v in spec['volumes']}; mounts = {m['name'] for m in c['volumeMounts']}
ck(vols == mounts, f"k8s 卷与挂载点一一对应（{len(vols)} 个）")
ck(k['spec'].get('replicas') == 1 and k['spec'].get('strategy', {}).get('type') == 'Recreate',
   "k8s 仍是 replicas:1 + strategy:Recreate（多副本会争抢同一份 hostPath 数据）")
sys.exit(rc)
PYEOF
while IFS= read -r pl; do
  case "${pl}" in
    PASS:*) pass "${pl#PASS: }" ;;
    FAIL:*) fail "${pl#FAIL: }" ;;
    *) [[ -n "${pl}" ]] && fail "k8s/compose 语义检查脚本异常输出：${pl}" ;;
  esac
done <"${TEST_DIR}/hardening.py.out"

# ── 模板 → 生成产物的一致性：模板里有、但 `config` 生成时被丢掉 = 等于没加 ──
# ⚠️ 这一条能用是因为上面的 1.25 场景刚跑过 `config`，${BASE}/docker-compose.yaml 就是产物。
#    只断言模板的话，"生成逻辑改写了这一段"这种失效方式看不见。
if [[ -f "${BASE}/docker-compose.yaml" ]]; then
  assert_file_contains "${BASE}/docker-compose.yaml" "no-new-privileges:true" \
    "**生成出来的** compose 文件里也有 no-new-privileges（模板有、生成时被丢掉就等于没加）"
  assert_file_not_contains "$(sed 's|^[[:space:]]*#.*||' "${BASE}/docker-compose.yaml")" "read_only:" \
    "生成出来的 compose 文件里 read_only 仍未被启用（剥注释后判定）"
else
  fail "找不到 ${BASE}/docker-compose.yaml：上面的 config 场景没跑成功，模板→产物的一致性无从验证"
fi

# ── k8s 清单里「故意不打开」的那项，理由必须在原文的注释里（同样是防空转）──
assert_file_contains "${K8S_MD}" "# capabilities:" "k8s 清单的注释里给了 capabilities 收窄的可选写法（否则上面那条 not-in 断言是空转）"
assert_file_contains "${K8S_MD}" "DAC_OVERRIDE" "k8s 清单里写清了不打 capabilities 的风险来源"
assert_file_contains "${K8S_MD}" "kubectl apply" "k8s 清单里写清了 limits 缩进错误的后果（apply 被严格校验拒绝）"

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
