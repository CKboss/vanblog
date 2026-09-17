#!/usr/bin/env bash

#========================================================
#   vanblog-drill.sh —— 恢复演练 / 语义化校验 / 备份即验
#   Description: vanblog.sh 的旁挂扩展（备份能不能**恢复**，不是能不能打包）
#   Github: https://github.com/CKboss/vanblog
#========================================================
#
# 为什么是**单独一个文件**，而不是直接写进 scripts/vanblog.sh：
#   scripts/vanblog.sh 在 docs/.vuepress/public/vanblog.sh 有一份**字节一致的双胞胎**
#   （文档站的一行安装就是下载那一份），有好几条测试用 `cmp -s` 钉住这个关系。
#   两份必须同时改，所以这里把新逻辑全部放进本文件，vanblog.sh 只需要一行转发
#   （见文件末尾「怎么接到 vanblog.sh 上」）。这样双胞胎关系一个字节都没动。
#
# 为什么需要它（这一轮之前踩过的三个坑，全都"备份成功、恢复失败"）：
#   a) BSON 构造器来自另一个 driver 主版本 ⇒ 恢复第一个集合就 400，整站恢复不可用；
#   b) 上传的主题 CSS 在 <static>/themes/，而打包清单是手写的三元素 ⇒ 主题文件从来没进归档，
#      恢复后后台显示主题还在、/api/public/theme.css 却拿不到 CSS，前台静默退回默认皮肤；
#   c) 流水线脚本体在磁盘上（<codeRunner>/<id>.js），恢复只填了库 ⇒ 保存文章卡到超时。
#   `vanblog.sh verify` 一条都抓不到：它只证明归档**读得出来**（zstd -t / 成员表 / sha256），
#   不证明**恢复得回来**。演练（drill）才能：起一套一次性容器，走用户真正会走的那条
#   HTTP 上传恢复接口，然后拿恢复出来的站点跟归档清单对账。
#
# 子命令：
#   drill [归档]           一次性容器里真恢复一遍，并逐项断言（详见 cmd_drill）
#   verify [归档…]         vanblog.sh verify 的全部结构校验 + 一层"能不能恢复"的语义校验
#   backup-verify          备份**并立刻验证**（cron 用：失败就非 0 退出）
#   backup-status          最近一次备份是什么时候、验过没有、演练过没有、有没有变陈旧
#
# ⚠️ drill 绝不碰在跑的栈：自己的一次性容器/卷/网络/端口，名字带随机后缀，
#    检测到任何名字或端口冲突就**拒绝启动**（而不是把别人的容器顶掉），
#    并且用 trap 保证失败也拆干净。它也不需要 root（rootless podman 可用）。

set -u

DRILL_SELF_PATH="${BASH_SOURCE[0]}"
DRILL_SELF_DIR="$(cd "$(dirname "${DRILL_SELF_PATH}")" 2>/dev/null && pwd)"
DRILL_SELF_NAME="$(basename "${DRILL_SELF_PATH}")"
VANBLOG_MAIN_SCRIPT="${VANBLOG_MAIN_SCRIPT:-${DRILL_SELF_DIR}/vanblog.sh}"

# ── 复用 vanblog.sh 的既有实现（颜色、归档工具、备份目录、backup 本体…）────────
# 用 VANBLOG_SKIP_MAIN=1 source：那是 vanblog.sh 自己给测试留的口子，
# 只加载函数、不跑 pre_check（不要求 root、不建 /var/vanblog、不探测中国 IP）。
# 一份实现两处用，才不会"脚本说 zstd -t 过了、演练用另一套解压参数"这种漂移。
VANBLOG_MAIN_LOADED=0
if [[ -f "${VANBLOG_MAIN_SCRIPT}" ]]; then
  # shellcheck disable=SC1090
  VANBLOG_SKIP_MAIN=1 source "${VANBLOG_MAIN_SCRIPT}" >/dev/null 2>&1 && VANBLOG_MAIN_LOADED=1
fi

red="${red:-\033[0;31m}"
green="${green:-\033[0;32m}"
yellow="${yellow:-\033[0;33m}"
plain="${plain:-\033[0m}"
[[ -n "${VANBLOG_NO_COLOR:-}" ]] && { red=""; green=""; yellow=""; plain=""; }

say() { echo -e "$*"; }
step() { echo -e "\n${yellow}== $* ==${plain}"; }

# 找不到 vanblog.sh 时给几个最小兜底（只够 --help 与纯函数测试用；真要跑 drill/verify
# 必须有 vanblog.sh，因为它才是"生产路径"的那一份实现）
if [[ "${VANBLOG_MAIN_LOADED}" != "1" ]]; then
  human_bytes() { printf '%s B' "${1:-0}"; }
  is_gnu_tar() { tar --version 2>/dev/null | head -n 1 | grep -q 'GNU tar'; }
  archive_format_of() {
    case "$(basename "$1" | tr '[:upper:]' '[:lower:]')" in
    *.tar.zst | *.zst) printf 'zstd' ;;
    *.tar.xz | *.xz) printf 'xz' ;;
    *.tar.gz | *.tgz | *.gz) printf 'gzip' ;;
    *) printf '' ;;
    esac
  }
  full_backup_dir() { printf '%s' "${VANBLOG_BACKUP_DIR:-/var/vanblog/data/log/vanblog-backups}"; }
  archive_list_members() { return 2; }
  archive_integrity_test() { return 2; }
  verify_one_archive() { return 2; }
  json_string() { local s="${1//\\/\\\\}"; printf '"%s"' "${s//\"/\\\"}"; }
fi

# ── 可调项（全部有默认值；命令行开关优先于环境变量）──────────────────────────
#   VANBLOG_DRILL_ENGINE       docker|podman（默认自动探测：docker daemon 连得上用 docker，否则 podman）
#   VANBLOG_DRILL_IMAGE        演练用的 vanblog 镜像（默认：编排文件里的那个 → VANBLOG_IMAGE_REF）
#   VANBLOG_DRILL_MONGO_IMAGE  演练用的 mongo 镜像（默认 VANBLOG_MONGO_IMAGE，即 mongo:7.0）
#   VANBLOG_DRILL_PREFIX       一次性容器/卷/网络的名字前缀（默认 vb-drill）
#   VANBLOG_DRILL_PORT_BASE    挑空闲端口的起点（默认 18500；避开 3000/3001/3002/18080/27017 这些在用的）
#   VANBLOG_DRILL_PORT_SPAN    从起点往上试多少个（默认 400）
#   VANBLOG_DRILL_TIMEOUT      等服务就绪的秒数（默认 240）
#   VANBLOG_DRILL_HOME         给 podman 换一个 HOME（本机把镜像存储放在仓库里的场景；留空=用真实 HOME）
#   VANBLOG_DRILL_TMPDIR       给 podman/临时文件换一个 TMPDIR（留空=沿用当前）
#   VANBLOG_DRILL_KEEP=1       等价于 --keep（演练完不拆，方便进去看）
#   VANBLOG_DRILL_DRY_RUN=1    等价于 --dry-run
#   VANBLOG_DRILL_NO_PULL=1    镜像不在本地就直接失败，不尝试 pull（离线机器/CI 用）
#   VANBLOG_BACKUP_STALE_DAYS  最新归档超过这么多天就算"陈旧"（默认 7；0=不检查）
#   VANBLOG_VERIFY_ALLOW_EMPTY=1  "归档里一条文档都没有"从 FAIL 降级成 WARN
DRILL_ENGINE="${VANBLOG_DRILL_ENGINE:-${ENGINE:-}}"
DRILL_IMAGE="${VANBLOG_DRILL_IMAGE:-}"
DRILL_MONGO_IMAGE="${VANBLOG_DRILL_MONGO_IMAGE:-${VANBLOG_MONGO_IMAGE:-mongo:7.0}}"
DRILL_PREFIX="${VANBLOG_DRILL_PREFIX:-vb-drill}"
DRILL_PORT_BASE="${VANBLOG_DRILL_PORT_BASE:-18500}"
DRILL_PORT_SPAN="${VANBLOG_DRILL_PORT_SPAN:-400}"
DRILL_TIMEOUT="${VANBLOG_DRILL_TIMEOUT:-240}"
DRILL_KEEP="${VANBLOG_DRILL_KEEP:-0}"
DRILL_DRY_RUN="${VANBLOG_DRILL_DRY_RUN:-0}"
DRILL_NO_PULL="${VANBLOG_DRILL_NO_PULL:-0}"
DRILL_SKIP_PREFLIGHT="${VANBLOG_DRILL_SKIP_PREFLIGHT:-0}"
DRILL_STALE_DAYS="${VANBLOG_BACKUP_STALE_DAYS:-7}"
DRILL_LOG_TAIL="${VANBLOG_DRILL_LOG_TAIL:-80}"

# ── 断言台账 ────────────────────────────────────────────────────────────────
# 演练/校验的结论不是"最后打一行 OK"，而是**每一条断言都留痕**：
# 跑了哪些、各自看到什么数字。出问题时这张表就是排障现场。
ASSERT_PASS=0
ASSERT_FAIL=0
ASSERT_WARN=0
ASSERT_NOTE=0
ASSERT_LOG=()

# ⚠️ 分隔符用 \x1f（unit separator）而不是 "|"：细节文本里真的会出现竖线
#    （例如"归档里没有 static/img|file|customPage 成员"），用竖线切会把台账表切错位。
ASSERT_SEP=$'\x1f'
_assert_add() { # <kind> <label> <detail>
  ASSERT_LOG+=("$1${ASSERT_SEP}$2${ASSERT_SEP}$3")
}
rec_pass() { ASSERT_PASS=$((ASSERT_PASS + 1)); _assert_add PASS "$1" "${2:-}"; echo -e "  ${green}PASS${plain}  $1${2:+ —— $2}"; }
rec_fail() { ASSERT_FAIL=$((ASSERT_FAIL + 1)); _assert_add FAIL "$1" "${2:-}"; echo -e "  ${red}FAIL${plain}  $1${2:+ —— $2}"; }
rec_warn() { ASSERT_WARN=$((ASSERT_WARN + 1)); _assert_add WARN "$1" "${2:-}"; echo -e "  ${yellow}WARN${plain}  $1${2:+ —— $2}"; }
rec_note() { ASSERT_NOTE=$((ASSERT_NOTE + 1)); _assert_add NOTE "$1" "${2:-}"; echo -e "  ·      $1${2:+ —— $2}"; }
assert_reset() { ASSERT_PASS=0; ASSERT_FAIL=0; ASSERT_WARN=0; ASSERT_NOTE=0; ASSERT_LOG=(); }

# 打印断言台账（--keep / 失败时特别有用：一眼看到"哪些断言跑过"）
assert_table() {
  [[ ${#ASSERT_LOG[@]} -eq 0 ]] && return 0
  echo -e "\n> 断言台账（跑了 $((ASSERT_PASS + ASSERT_FAIL + ASSERT_WARN)) 条判定 + ${ASSERT_NOTE} 条说明）："
  local line kind label detail
  for line in ${ASSERT_LOG[@]+"${ASSERT_LOG[@]}"}; do
    kind="${line%%"${ASSERT_SEP}"*}"
    label="${line#*"${ASSERT_SEP}"}"
    detail="${label#*"${ASSERT_SEP}"}"
    label="${label%%"${ASSERT_SEP}"*}"
    case "${kind}" in
    PASS) printf '    %s  %-46s %s\n' "${green}PASS${plain}" "${label}" "${detail}" ;;
    FAIL) printf '    %s  %-46s %s\n' "${red}FAIL${plain}" "${label}" "${detail}" ;;
    WARN) printf '    %s  %-46s %s\n' "${yellow}WARN${plain}" "${label}" "${detail}" ;;
    *) printf '    ·      %-46s %s\n' "${label}" "${detail}" ;;
    esac
  done
}

# 汇总行（人和机器都能读；测试钉的就是这两行的形状）
assert_summary() { # <标题>
  local title="${1:-结果}"
  echo
  if [[ ${ASSERT_FAIL} -gt 0 ]]; then
    echo -e "> ${title}：${red}FAIL${plain}（PASS ${ASSERT_PASS}，WARN ${ASSERT_WARN}，FAIL ${ASSERT_FAIL}，NOTE ${ASSERT_NOTE}）"
    echo "RESULT: FAIL pass=${ASSERT_PASS} warn=${ASSERT_WARN} fail=${ASSERT_FAIL} note=${ASSERT_NOTE}"
    return 1
  fi
  echo -e "> ${title}：${green}PASS${plain}（PASS ${ASSERT_PASS}，WARN ${ASSERT_WARN}，FAIL 0，NOTE ${ASSERT_NOTE}）"
  echo "RESULT: PASS pass=${ASSERT_PASS} warn=${ASSERT_WARN} fail=0 note=${ASSERT_NOTE}"
  return 0
}

# ── 一个不依赖 jq / python3 的 JSON 取值器 ──────────────────────────────────
# 小机器上不一定有 jq，python3 也不该是硬依赖（vanblog.sh 全程都这么要求）。
# 这里用一个 awk 写的极小 JSON 扫描器：认字符串转义、认嵌套 {} []，
# 按点号路径取值 / 列键 / 数元素。⚠️ 不是通用 JSON 解析器，只做这三件事，
# 但它是**真的**扫描器：文章正文里出现 `{`、`"deleted":true` 这类字面量也不会骗到它
# （这正是"用 grep 数 NDJSON"会错的地方：一篇讲 JSON 的文章会被当成已删除）。
# awk 程序里不能出现单引号（整段是 bash 单引号字符串），改字符类时注意。
_JSON_AWK_FUNCS='
function _jstr(s, i,   out, c, n) {
  out = ""; n = length(s); i++
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") { out = out substr(s, i + 1, 1); i += 2; continue }
    if (c == "\"") { RET_END = i; return out }
    out = out c; i++
  }
  RET_END = n + 1; return out
}
function _jraw(s, i,   c, depth, instr, start, n) {
  n = length(s)
  while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
  start = i; depth = 0; instr = 0
  while (i <= n) {
    c = substr(s, i, 1)
    if (instr) {
      if (c == "\\") { i += 2; continue }
      if (c == "\"") instr = 0
      i++; continue
    }
    if (c == "\"") { instr = 1; i++; continue }
    if (c == "{" || c == "[") { depth++; i++; continue }
    if (c == "}" || c == "]") { if (depth == 0) break; depth--; i++; continue }
    if (c == "," && depth == 0) break
    i++
  }
  RET_END = i
  return substr(s, start, i - start)
}
function _jval(obj, key,   i, n, k, v) {
  n = length(obj); i = 1
  while (i <= n && substr(obj, i, 1) != "{") i++
  if (i > n) return ""
  i++
  while (i <= n) {
    while (i <= n && substr(obj, i, 1) ~ /[ \t\r\n,]/) i++
    if (substr(obj, i, 1) != "\"") return ""
    k = _jstr(obj, i); i = RET_END + 1
    while (i <= n && substr(obj, i, 1) ~ /[ \t\r\n]/) i++
    if (substr(obj, i, 1) != ":") return ""
    v = _jraw(obj, i + 1); i = RET_END
    if (k == key) return v
    if (i >= n) return ""
  }
  return ""
}
function _jkeys(obj,   i, n, k, out, sep) {
  n = length(obj); i = 1; out = ""; sep = ""
  while (i <= n && substr(obj, i, 1) != "{") i++
  if (i > n) return ""
  i++
  while (i <= n) {
    while (i <= n && substr(obj, i, 1) ~ /[ \t\r\n,]/) i++
    if (substr(obj, i, 1) != "\"") return out
    k = _jstr(obj, i); i = RET_END + 1
    out = out sep k; sep = "\n"
    while (i <= n && substr(obj, i, 1) ~ /[ \t\r\n]/) i++
    if (substr(obj, i, 1) != ":") return out
    _jraw(obj, i + 1); i = RET_END
    if (i >= n) return out
  }
  return out
}
function _jcount(s,   i, n, c, depth, instr, commas, empty) {
  n = length(s); i = 1
  while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
  c = substr(s, i, 1)
  if (c != "[" && c != "{") return 1
  depth = 0; instr = 0; commas = 0; empty = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (instr) {
      if (c == "\\") { i += 2; continue }
      if (c == "\"") instr = 0
      i++; continue
    }
    if (c == "\"") { instr = 1; empty = 0; i++; continue }
    if (c == "[" || c == "{") { depth++; empty = 0; i++; continue }
    if (c == "]" || c == "}") { depth--; if (depth <= 0) break; i++; continue }
    if (depth == 1) {
      if (c == ",") commas++
      else if (c !~ /[ \t\r\n:]/) empty = 0
    }
    i++
  }
  if (empty) return 0
  return commas + 1
}
function _jwalk(doc, path,   n, i, keys, cur, v) {
  n = split(path, keys, ".")
  cur = doc
  for (i = 1; i <= n; i++) {
    v = _jval(cur, keys[i])
    if (v == "") return ""
    cur = v
  }
  return cur
}
function _jtrim(s) { gsub(/^[ \t\r\n]+/, "", s); gsub(/[ \t\r\n]+$/, "", s); return s }
'

_json_run() { # <mode:get|keys|len> <path>   ; JSON 从 stdin 进
  awk -v mode="${1:-get}" -v path="${2:-}" "${_JSON_AWK_FUNCS}"'
  { doc = doc $0 "\n" }
  END {
    v = _jwalk(doc, path)
    if (mode == "keys") { if (v != "") printf "%s\n", _jkeys(v); exit }
    if (mode == "len") { if (v == "") { print 0 } else { print _jcount(v) }; exit }
    if (v == "") exit
    v = _jtrim(v)
    if (substr(v, 1, 1) == "\"") { printf "%s\n", _jstr(v, 1); exit }
    printf "%s\n", v
  }'
}

json_get() { printf '%s' "${1:-}" | _json_run get "${2:-}"; }    # <json> <a.b.c> → 标量（去引号）
json_raw() { printf '%s' "${1:-}" | _json_run get "${2:-}"; }    # 同上（数组/对象会原样给出）
json_keys() { printf '%s' "${1:-}" | _json_run keys "${2:-}"; }  # <json> <a.b> → 每行一个键
json_len() { printf '%s' "${1:-}" | _json_run len "${2:-}"; }    # <json> <a.b> → 数组/对象元素个数

# ── 引擎（docker / podman）──────────────────────────────────────────────────
# 这台开发机上只有 rootless podman（没有 docker daemon、没有 docker 组、sudo 要密码），
# 生产机器上通常是 docker —— 所以两边都要能跑，默认自动探测。
drill_detect_engine() {
  local want="${DRILL_ENGINE}"
  if [[ -n "${want}" ]]; then
    if command -v "${want}" >/dev/null 2>&1; then
      printf '%s' "${want}"
      return 0
    fi
    return 1
  fi
  # docker 二进制在但 daemon 没起（本机就是这样）⇒ 不能算可用，否则每条命令都挂
  if command -v docker >/dev/null 2>&1 && drill_cmd_timeout 8 docker info >/dev/null 2>&1; then
    printf 'docker'
    return 0
  fi
  if command -v podman >/dev/null 2>&1 && drill_cmd_timeout 15 podman info >/dev/null 2>&1; then
    printf 'podman'
    return 0
  fi
  return 1
}

drill_cmd_timeout() { # <秒> <cmd…>：有 timeout 就用，没有就直接跑
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${secs}" "$@"
  else
    "$@"
  fi
}

# rootless podman 需要 XDG_RUNTIME_DIR（放 socket）；cron / CI 里常常没有。
# ⚠️ **不擅自改 HOME**：podman 的镜像存储在 $HOME/.local/share/containers 下，
#    悄悄换个 HOME 等于"用户明明有镜像，脚本却说找不到"。要换必须显式给
#    VANBLOG_DRILL_HOME（本机把存储放在仓库里时就是这么用的）。
DRILL_XDG_CREATED=""
drill_export_engine_env() {
  local eng="${1:-${DRILL_ENGINE}}"
  if [[ -n "${VANBLOG_DRILL_HOME:-}" ]]; then
    mkdir -p "${VANBLOG_DRILL_HOME}" 2>/dev/null || true
    export HOME="${VANBLOG_DRILL_HOME}"
  fi
  if [[ "${eng}" != "podman" ]]; then
    return 0
  fi
  export TMPDIR="${VANBLOG_DRILL_TMPDIR:-${TMPDIR:-/tmp}}"
  mkdir -p "${TMPDIR}" 2>/dev/null || true
  if [[ -z "${XDG_RUNTIME_DIR:-}" || ! -d "${XDG_RUNTIME_DIR:-}" || ! -w "${XDG_RUNTIME_DIR:-}" ]]; then
    local d="${TMPDIR%/}/vanblog-drill-xdg-$$-${RANDOM}"
    if mkdir -p "${d}" 2>/dev/null && chmod 700 "${d}" 2>/dev/null; then
      export XDG_RUNTIME_DIR="${d}"
      DRILL_XDG_CREATED="${d}"
    fi
  fi
  return 0
}

drill_engine_version() {
  local eng="${1:-${DRILL_ENGINE}}"
  case "${eng}" in
  podman) podman --version 2>/dev/null | head -1 ;;
  docker) docker --version 2>/dev/null | head -1 ;;
  *) printf '' ;;
  esac
}

# ── 端口与名字：只挑**空的**，撞到就拒绝 ────────────────────────────────────
DRILL_TAKEN_PORTS=""

drill_port_listening() { # <port> → 0 表示已被监听
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | grep -qE "[:.]${p}\$" && return 0
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk 'NR>1{print $4}' | grep -qE "[:.]${p}\$" && return 0
  fi
  return 1
}

drill_port_connectable() { # <port> → 0 表示能连上（有人在用）
  local p="$1"
  if (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null; then
    exec 3>&- 3<&- 2>/dev/null || true
    return 0
  fi
  return 1
}

drill_port_ephemeral() { # <port> → 0 表示落在系统临时端口区间（随时可能被出站连接抢走）
  local p="$1" lo hi
  [[ -r /proc/sys/net/ipv4/ip_local_port_range ]] || return 1
  read -r lo hi </proc/sys/net/ipv4/ip_local_port_range 2>/dev/null || return 1
  [[ "${p}" -ge "${lo}" && "${p}" -le "${hi}" ]]
}

drill_port_taken_by_us() {
  local p="$1"
  [[ ",${DRILL_TAKEN_PORTS}," == *",${p},"* ]]
}

drill_port_free() { # <port> → 0 空闲可用
  local p="$1"
  case "${p}" in
  '' | *[!0-9]*) return 1 ;;
  esac
  ((p >= 1024 && p <= 65535)) || return 1
  drill_port_taken_by_us "${p}" && return 1
  drill_port_listening "${p}" && return 1
  drill_port_connectable "${p}" && return 1
  drill_port_ephemeral "${p}" && return 1
  return 0
}

# 从 base 往上找 span 个里的第一个空闲端口。第一遍严格（排除临时端口区间），
# 全被占才放宽（用户把 base 指到 32768+ 时不至于一个都挑不出来），并明说放宽了。
# ⚠️ 结果放**全局** PICKED_PORT，不要写成 `p="$(drill_pick_free_port …)"`：
#    命令替换是子 shell，"这个端口已经被我占了"记不回父 shell，
#    于是 HTTP 和 mongo 会挑到**同一个**端口（第一版就这么错过：两个都 18500）。
PICKED_PORT=""
drill_pick_free_port() { # [base] [span] → 设 PICKED_PORT
  local base="${1:-${DRILL_PORT_BASE}}" span="${2:-${DRILL_PORT_SPAN}}"
  local i p
  PICKED_PORT=""
  for ((i = 0; i < span; i++)); do
    p=$((base + i))
    if drill_port_free "${p}"; then
      DRILL_TAKEN_PORTS="${DRILL_TAKEN_PORTS},${p}"
      PICKED_PORT="${p}"
      return 0
    fi
  done
  for ((i = 0; i < span; i++)); do
    p=$((base + i))
    drill_port_taken_by_us "${p}" && continue
    drill_port_listening "${p}" && continue
    drill_port_connectable "${p}" && continue
    DRILL_TAKEN_PORTS="${DRILL_TAKEN_PORTS},${p}"
    echo -e "  ${yellow}注意：${base}+${span} 里没有严格空闲的端口，退而使用临时端口区间里的 ${p}${plain}" >&2
    PICKED_PORT="${p}"
    return 0
  done
  return 1
}

# 一次性资源的名字：前缀 + PID + 随机数。绝不复用已有名字（撞了就拒绝启动）。
drill_make_suffix() { printf '%s-%s' "$$" "${RANDOM}"; }

drill_resource_exists() { # <engine> <container|image|volume|network> <name>
  local eng="$1" kind="$2" name="$3"
  case "${kind}" in
  container) "${eng}" inspect --type container "${name}" >/dev/null 2>&1 ;;
  image) "${eng}" image inspect "${name}" >/dev/null 2>&1 ;;
  volume) "${eng}" volume inspect "${name}" >/dev/null 2>&1 ;;
  network) "${eng}" network inspect "${name}" >/dev/null 2>&1 ;;
  *) return 1 ;;
  esac
}

# ── 归档侧的读取工具（流式，不落盘）────────────────────────────────────────
# 和 vanblog.sh 的 archive_list_members 同一套解压参数（zstd 要 --long=27，
# 因为 server 就是用 `zstd -19 --long=27` 压的；老 zstd 不认 --long 就去掉再试）。
drill_decompress_cmd() { # <fmt> → 打印解压命令（空格分隔），认不出返回 1
  case "$1" in
  zstd) printf 'zstd -dc -q' ;;
  xz) printf 'xz -dc' ;;
  gzip) printf 'gzip -dc' ;;
  *) return 1 ;;
  esac
}

drill_zstd_long_opt() {
  if command -v zstd >/dev/null 2>&1 && zstd --help 2>&1 | grep -q -- '--long'; then
    printf -- ' --long=27'
  fi
}

# 取归档里的**单个成员**到 stdout（tar -xO），不解压落盘。
drill_archive_member() { # <archive> <member>
  local file="$1" member="$2" fmt dec extra=""
  fmt="$(archive_format_of "${file}")"
  [[ -n "${fmt}" ]] || return 2
  dec="$(drill_decompress_cmd "${fmt}")" || return 2
  command -v "${dec%% *}" >/dev/null 2>&1 || return 127
  [[ "${fmt}" == "zstd" ]] && extra="$(drill_zstd_long_opt)"
  local -a tar_opts=(-xO)
  is_gnu_tar && tar_opts+=(--warning=no-unknown-keyword)
  # shellcheck disable=SC2086
  ${dec} ${extra} "${file}" 2>/dev/null | tar "${tar_opts[@]}" "${member}" 2>/dev/null
}

MANIFEST_SOURCE="none"
MANIFEST_JSON=""
# 读清单：**优先从归档里读**（那才是恢复时 server 读到的东西）；
# 旁边的 .manifest.json 只是导出时写的副本，归档被换过/截断过它就会说谎。
# ⚠️ 结果放**全局**（MANIFEST_JSON / MANIFEST_SOURCE）而不是 stdout：
#    调用方一旦写成 `m="$(drill_archive_manifest …)"`，命令替换是子 shell，
#    "清单是从归档里读出来的、还是从旁边副本捡的"这条信息就丢了
#    （第一版就这么错过：明明读到了清单，却报告来源 none）。
drill_archive_manifest() { # <archive> → 设 MANIFEST_JSON / MANIFEST_SOURCE
  local file="$1" out
  MANIFEST_SOURCE="none"
  MANIFEST_JSON=""
  out="$(drill_archive_member "${file}" "./manifest.json")"
  if [[ -z "${out}" ]]; then
    out="$(drill_archive_member "${file}" "manifest.json")"
  fi
  if [[ -n "${out}" ]]; then
    MANIFEST_SOURCE="inside"
    MANIFEST_JSON="${out}"
    return 0
  fi
  if [[ -f "${file}.manifest.json" ]]; then
    MANIFEST_SOURCE="sidecar"
    MANIFEST_JSON="$(cat "${file}.manifest.json")"
    return 0
  fi
  return 1
}

# 成员表（一次解压），调用方自己缓存 —— verify 的语义检查全部复用这一份。
drill_archive_members() { # <archive>
  local file="$1" fmt
  fmt="$(archive_format_of "${file}")"
  if declare -f archive_list_members >/dev/null 2>&1; then
    archive_list_members "${fmt}" "${file}"
    return $?
  fi
  return 2
}

# 归档里的上传主题（static/themes/**）；输出成员名（去掉前导 ./），没有就空
drill_archive_theme_members() { # <members>
  printf '%s\n' "${1:-}" |
    grep -E '(^|/)static/themes/[^/]+$' |
    sed -E 's#^\./##' | grep -v '/$' || true
}

# 归档里可以拿来探测的静态文件（优先原图，避开缩略图目录），输出 URL 路径
drill_archive_probe_static() { # <members>
  local m
  m="$(printf '%s\n' "${1:-}" |
    grep -E '(^|/)static/(img|file|customPage)/[^/]+$' |
    grep -v '/thumb/' | head -1 | sed -E 's#^\./##')"
  if [[ -z "${m}" ]]; then
    m="$(printf '%s\n' "${1:-}" | grep -E '(^|/)static/[^/]+/[^/]+$' | head -1 | sed -E 's#^\./##')"
  fi
  [[ -n "${m}" ]] && printf '/%s' "${m}"
}

# 从归档的 NDJSON 里算"前台应该能列出多少篇文章"。
# 判据照着 server 的公开列表过滤条件写（article.provider.getByOption(isPublic=true)）：
#   deleted != true、hidden != true、且分类不是私密分类。
# ⚠️ 用 JSON 扫描器逐行取字段，不用 grep 数 `"deleted":true`：
#    文章正文里出现这几个字面量是完全可能的（一篇讲 JSON 的文章就会中枪）。
drill_expected_articles() { # <articles.ndjson 内容> <categories.ndjson 内容>
  local arts="$1" cats="$2"
  # ⚠️ 分类必须**先**读：文章要不要扣"私密分类"取决于分类表，
  #    先读文章的话 privcat 还是空的，私密分类里的文章会被算成公开（第一版就这么错过）。
  #    awk 的文件顺序因此与参数顺序相反，用 NR==FNR 判断"还在读第一个文件"。
  awk "${_JSON_AWK_FUNCS}"'
  {
    line = $0
    if (line ~ /^[ \t]*$/) next
    if (NR == FNR) {
      if (_jval(line, "private") == "true") {
        nm = _jval(line, "name")
        gsub(/^"|"$/, "", nm)
        privcat[nm] = 1
      }
      next
    }
    total++
    if (_jval(line, "deleted") == "true") { deleted++; next }
    if (_jval(line, "hidden") == "true") { hidden++; next }
    if (_jval(line, "private") == "true") { priv++; next }
    cat = _jval(line, "category")
    gsub(/^"|"$/, "", cat)
    if (cat in privcat) { inprivcat++; next }
    public++
    loose++
  }
  END {
    printf "total=%d public=%d loose=%d deleted=%d hidden=%d private=%d inprivcat=%d\n",
      total + 0, public + 0, loose + 0, deleted + 0, hidden + 0, priv + 0, inprivcat + 0
  }' <(printf '%s\n' "${cats}") <(printf '%s\n' "${arts}")
}

# ── HTTP 探测 ──────────────────────────────────────────────────────────────
HTTP_CODE="000"
HTTP_BYTES="0"

http_probe() { # <method> <url> <body_out_file> [timeout] [extra curl args…]
  local method="$1" url="$2" out="$3" tmo="${4:-60}"
  shift 4 2>/dev/null || shift $#
  local res
  res="$(curl -sS -m "${tmo}" -o "${out}" -w '%{http_code} %{size_download}' \
    -X "${method}" "$@" "${url}" 2>/dev/null)"
  HTTP_CODE="${res%% *}"
  HTTP_BYTES="${res##* }"
  [[ "${HTTP_CODE}" =~ ^[0-9]+$ ]] || HTTP_CODE="000"
  [[ "${HTTP_BYTES}" =~ ^[0-9]+$ ]] || HTTP_BYTES="0"
  [[ "${HTTP_CODE}" != "000" ]]
}

http_get() { # <url> <body_out> [timeout]
  http_probe GET "$1" "$2" "${3:-30}"
}

# 等一个 URL 返回期望的状态码（恢复后 ISR/静态生成是陆续来的，所以要重试）
http_wait() { # <url> <期望码，空格分隔> <body_out> <超时秒> [间隔秒]
  local url="$1" want="$2" out="$3" tmo="$4" gap="${5:-3}"
  local waited=0 c
  while ((waited < tmo)); do
    if http_get "${url}" "${out}" 15; then
      c="${HTTP_CODE}"
      if printf '%s' "${want}" | grep -qw "${c}"; then
        return 0
      fi
    fi
    sleep "${gap}"
    waited=$((waited + gap))
  done
  return 1
}

# ── 演练（P1）──────────────────────────────────────────────────────────────
DRILL_TMP=""
DRILL_CONTAINERS=()
DRILL_VOLUMES=()
DRILL_NETWORKS=()
DRILL_APP_NAME=""
DRILL_MONGO_NAME=""
DRILL_HTTP_PORT=""
DRILL_MONGO_PORT=""
DRILL_STARTED=0

drill_cleanup() {
  local rc=$?
  local eng="${DRILL_ENGINE}"
  if [[ "${DRILL_KEEP}" == "1" && ${DRILL_STARTED} -eq 1 ]]; then
    say "\n> --keep：一次性栈**保留**着，自己进去看："
    [[ -n "${DRILL_APP_NAME}" ]] && say "    站点    ：http://127.0.0.1:${DRILL_HTTP_PORT}（后台 /admin）"
    [[ -n "${DRILL_MONGO_NAME}" ]] && say "    mongo   ：127.0.0.1:${DRILL_MONGO_PORT}"
    [[ -n "${DRILL_APP_NAME}" ]] && say "    日志    ：${eng} logs ${DRILL_APP_NAME} | tail -80"
    say "    拆掉    ：${green}${eng} rm -f ${DRILL_CONTAINERS[*]}${plain}"
    [[ ${#DRILL_VOLUMES[@]} -gt 0 ]] && say "              ${green}${eng} volume rm ${DRILL_VOLUMES[*]}${plain}"
    [[ ${#DRILL_NETWORKS[@]} -gt 0 ]] && say "              ${green}${eng} network rm ${DRILL_NETWORKS[*]}${plain}"
    [[ -n "${DRILL_TMP}" && -d "${DRILL_TMP}" ]] && say "    临时目录：${DRILL_TMP}（里面是响应体与探测结果）"
  else
    if [[ -n "${eng}" ]] && command -v "${eng}" >/dev/null 2>&1; then
      local n
      for n in ${DRILL_CONTAINERS[@]+"${DRILL_CONTAINERS[@]}"}; do
        [[ -n "${n}" ]] && "${eng}" rm -f "${n}" >/dev/null 2>&1 || true
      done
      for n in ${DRILL_NETWORKS[@]+"${DRILL_NETWORKS[@]}"}; do
        [[ -n "${n}" ]] && "${eng}" network rm "${n}" >/dev/null 2>&1 || true
      done
      # 卷由引擎自己删：mongo 的数据文件在宿主机上是 root 所有，
      # 用目录挂载的话没有 sudo 根本 rm 不掉（本机就是这么被卡住过的）
      for n in ${DRILL_VOLUMES[@]+"${DRILL_VOLUMES[@]}"}; do
        [[ -n "${n}" ]] && "${eng}" volume rm "${n}" >/dev/null 2>&1 || true
      done
    fi
    [[ -n "${DRILL_XDG_CREATED}" && -d "${DRILL_XDG_CREATED}" ]] && rm -rf "${DRILL_XDG_CREATED}" 2>/dev/null || true
    [[ -n "${DRILL_TMP}" && -d "${DRILL_TMP}" ]] && rm -rf "${DRILL_TMP}" 2>/dev/null || true
  fi
  return ${rc}
}

# 失败时打容器日志：⚠️ 只打 tail 常常一句有用的都没有（恢复失败那一刻，
# 尾部往往全是 Nest 启动时打的 RouterExplorer 路由表）。所以先给"错误/警告行"，再给尾部。
drill_dump_app_logs() { # <engine> [容器名]
  local eng="$1" name="${2:-${DRILL_APP_NAME}}"
  [[ -n "${eng}" && -n "${name}" ]] || return 0
  command -v "${eng}" >/dev/null 2>&1 || return 0
  local all err
  all="$("${eng}" logs --tail 3000 "${name}" 2>&1)"
  err="$(printf '%s\n' "${all}" | grep -aE 'ERROR|WARN|Error|Exception|EACCES|ENOSPC|ECONNREFUSED|BSON|失败|异常' |
    grep -av 'RouterExplorer' | tail -20)"
  if [[ -n "${err}" ]]; then
    echo -e "\n${red}── ${name} 日志里的错误/警告行（最多 20 行）──${plain}"
    printf '%s\n' "${err}" | sed 's/^/    /'
  else
    echo -e "\n${yellow}── ${name} 日志里没有匹配到错误/警告关键字（下面是尾部原文）──${plain}"
  fi
  echo -e "${red}── ${name} 日志尾部（最后 ${DRILL_LOG_TAIL} 行）──${plain}"
  printf '%s\n' "${all}" | tail -"${DRILL_LOG_TAIL}" | sed 's/^/    /'
}

# 镜像解析顺序：--image → VANBLOG_DRILL_IMAGE → 编排文件里正在用的那个
# → VANBLOG_IMAGE_REF（本分支 ghcr 镜像）。演练要跟真栈同一个镜像，否则演练证明不了什么。
drill_resolve_image() {
  if [[ -n "${DRILL_IMAGE}" ]]; then
    printf '%s' "${DRILL_IMAGE}"
    return 0
  fi
  local from_compose=""
  if declare -f get_compose_vanblog_image >/dev/null 2>&1; then
    from_compose="$(get_compose_vanblog_image 2>/dev/null)"
  fi
  case "${from_compose}" in
  '' | vanblog_image) from_compose="" ;;
  esac
  if [[ -n "${from_compose}" ]]; then
    printf '%s' "${from_compose}"
    return 0
  fi
  printf '%s' "${VANBLOG_IMAGE_REF:-ghcr.io/ckboss/vanblog:dev-dsh}"
}

# 归档必须是这个文件名形状才能走上传恢复：server 用
# FULL_BACKUP_ARCHIVE_RE = /^vanblog-full-.+\.tar\.(zst|xz|gz)$/ 白名单校验 originalname。
drill_archive_name_ok() {
  local base
  base="$(basename "$1")"
  [[ "${base}" =~ ^vanblog-full-.+\.tar\.(zst|xz|gz)$ ]]
}

drill_usage() {
  cat <<'USAGE'
vanblog-drill.sh —— 恢复演练 / 语义化校验 / 备份即验（vanblog.sh 的旁挂扩展）

用法： vanblog-drill.sh <子命令> [参数]
      （接上 vanblog.sh 之后也可以写 ./vanblog.sh drill …，见文件末尾）

  drill [归档名|路径]        在**一次性容器**里把这份整站备份真恢复一遍，然后逐项断言。
                             不带参数 = 用备份目录里最新的一份 vanblog-full-* 归档。
        --image <ref>        演练用的 vanblog 镜像（默认跟真栈同一个：编排文件 → VANBLOG_IMAGE_REF）
        --mongo-image <ref>  演练用的 mongo 镜像（默认 VANBLOG_MONGO_IMAGE，即 mongo:7.0）
        --engine docker|podman  容器引擎（默认自动探测；本机只有 rootless podman）
        --http-port N        指定宿主机 HTTP 端口（默认自动挑空闲端口）
        --mongo-port N       指定宿主机 mongo 端口（默认自动挑；⚠️ 绝不指向 27017 那个真库）
        --timeout N          等服务就绪的秒数（默认 240）
        --keep               演练完**不拆**，打印怎么访问、怎么删（默认总是拆干净）
        --dry-run            只打印会做什么（引擎/镜像/名字/端口/卷/每一步），什么都不动
        --as <名字>          上传时用这个文件名（归档被改过名时用；会明说这不是用户真实路径）
        --no-pull            镜像不在本地就失败，不尝试 pull
        --skip-preflight     跳过归档侧的静态预检（清单/成员表读不出也照样上传）。
                             用途是**演练 server 的护栏**：坏归档必须 400，而且不能把那条
                             匿名接口的单飞锁卡死（否则一个人传一个坏归档就能让整站再也恢复不了）。
                             平时不要用：预检能在不起容器的情况下就告诉你这份归档恢复不了。
                             演练走的是**用户真正会走的那条路**：POST /api/admin/init/restore
                             （multipart 字段 file，匿名，只在未初始化时开放），不是内部函数调用；
                             断言的是语义 —— 恢复出来的那个站点能不能对上归档清单，
                             而不只是"接口返回了 200"。失败时会打容器日志里的错误行 + 尾部
                             （只说"超时了"没有排障价值），并且总是拆干净（trap，--keep 才留）。

  verify [归档名|路径]…      vanblog.sh verify 的**全部**结构校验（原样输出）+ 一层语义校验：
                             清单 kind/version 本程序认不认、声明的集合有没有对应 .ndjson、
                             成员路径是不是绝对路径/带 ..（恢复会 400）、声明条数是否自洽、
                             static/themes 在不在（不在 = 这份归档早于主题备份）、
                             需要哪个解压工具、本机有没有。
                             会让恢复失败的 → FAIL（非 0 退出）；只是降级的 → WARN。
                             不带参数 = 备份目录里全部 vanblog-full-* 归档。

  backup-verify [backup 的参数]  备份**并立刻验证**：调 vanblog.sh 的 backup，成功后对新归档
                             跑一遍上面的语义校验，再查一次陈旧度；任一步失败 → 非 0 退出。
        --stale-days N       最新归档超过 N 天就算失败（默认 VANBLOG_BACKUP_STALE_DAYS 或 7；0=不查）
        --no-stale-check     等价于 --stale-days 0
        --drill              备份+校验通过后，顺手对这份新归档跑一次 drill（需要引擎与镜像）
                             适合 cron：备份没成功、或者成功了但恢复不回来，都会非 0 退出。

  backup-status              不用翻日志就能回答："最近一次备份什么时候？验过没有？演练过没有？"
        --stale-days N       陈旧判据（同上；默认 7 天，超了非 0 退出）
        --strict             最新归档没有"已验证"记录时也非 0 退出

  help | --help | -h         本页

verify 与 verify-deep 的区别（两条都在，是故意的）：
  ./vanblog.sh verify       vanblog.sh 自己的结构校验（压缩完整性 / sha256 / 成员表）。要求 root，
                            判据宽松：只证明"归档读得出来"。老 cron 里继续用它，退出码语义不变。
  ./vanblog.sh verify-deep  = 上面那些（**原样**输出，一条不少）+ 一层"能不能恢复"的语义校验。
                            不要求 root；判据严格：清单 version 比本程序新、归档里没有 manifest.json、
                            一条文档都没有、成员路径越界 …… 都会非 0 退出。新写的 cron/监控用这条。
  ⚠️ 但校验再深也只是**静态**判断：能证明"恢复得回来"的只有 drill（真起一套一次性容器恢复一遍）。

cron 建议：把 install-cron 写的那一行里的 `backup` 换成 `backup-verify`
  —— 备份完立刻做一遍深度校验 + 陈旧度护栏 + 往台账里留痕，任一步失败就非 0 退出。
  （install-cron 的参数变了会拒绝覆盖旧条目，加 --force 才会替换。）

环境变量（都有默认值，命令行优先）：
  VANBLOG_DRILL_ENGINE / _IMAGE / _MONGO_IMAGE / _PREFIX / _PORT_BASE / _PORT_SPAN /
  _TIMEOUT / _KEEP / _DRY_RUN / _NO_PULL / _HOME / _TMPDIR / _LOG_TAIL
  VANBLOG_BACKUP_STALE_DAYS  陈旧天数（默认 7）
  VANBLOG_VERIFY_ALLOW_EMPTY=1  "归档里一条文档都没有"从 FAIL 降级成 WARN
  VANBLOG_BACKUP_DIR / VANBLOG_DATA_PATH / VANBLOG_BASE_PATH  沿用 vanblog.sh 的定义

安全边界：
  · drill 只创建自己的一次性容器/卷/网络（名字带 PID+随机后缀），**不复用、不删除**任何已有资源；
    发现名字或端口被撞就拒绝启动，而不是把在跑的栈顶掉。
  · 永远不指向开发/生产在用的 mongod（默认端口从 18500 起挑，且会跳过正在监听的端口）。
  · 退出前一定拆（trap EXIT/INT/TERM）；--keep 时才留着，并把删除命令打印出来。
USAGE
}

# ── 纯断言函数：只吃数据、只记结论，不碰网络也不碰容器 ─────────────────────
# 为什么抽出来：演练的**语义**必须能"不起容器"就测到。
# scripts/tests/vanblog-drill.test.sh 直接喂这些函数各种真实形状的响应体
# （成功、initialized:false、400、403、409、演示站信封、counts 对不上、缺 themes 成员）。
# 留在 cmd_drill 里的话，那些分支只有真起容器才走得到 —— 而容器恰恰是最难在 CI 里有的东西。

# 通用：这一段有没有新增 FAIL（每个断言函数用它决定返回值）
_no_new_fail() { [[ "${ASSERT_FAIL}" -eq "${1}" ]]; }

# 找出会写到解包目录之外的成员（绝对路径 / Windows 盘号 / 任何一段是 ..）。
# 与 server 的 findUnsafeArchiveMember 同一套判据：恢复前它会把这种归档直接 400 掉。
# ⚠️ 不依赖 tar 自己拒绝穿越：本机是 GNU tar 会拒，容器里是 busybox tar，而这条接口匿名。
drill_find_unsafe_member() { # <members（每行一个）> → 找到就打印第一个并返回 0
  local m
  while IFS= read -r m; do
    [[ -n "${m}" ]] || continue
    case "${m}" in
    /* | [A-Za-z]:\\* | [A-Za-z]:/*) printf '%s\n' "${m}"; return 0 ;;
    esac
    if printf '%s' "${m}" | grep -qE '(^|/)\.\.(/|$)'; then
      printf '%s\n' "${m}"
      return 0
    fi
  done <<<"${1:-}"
  return 1
}

DRILL_ENV_SECS=""
DRILL_ENV_INIT=""
DRILL_ENV_ADMIN=""
DRILL_ENV_ARTICLES=""
DRILL_ENV_STATICS=""
DRILL_ENV_USERS=""
DRILL_ENV_VISITS=""
DRILL_ENV_VIEWERS=""
DRILL_ENV_SETTINGS=""
DRILL_ENV_TOTAL=""
DRILL_ENV_DOCS=""
DRILL_ENV_COLLS=""

# 恢复接口的响应信封：<http_code> <body> <归档清单 JSON> <端到端秒> <归档大小（人类可读）>
drill_assert_restore_envelope() {
  local code="$1" body="$2" manifest="$3" elapsed="${4:-?}" pretty="${5:-?}"
  local f0=${ASSERT_FAIL}

  local env_code0
  env_code0="$(json_get "${body}" statusCode)"
  if [[ "${env_code0}" == "401" ]]; then
    # 演示站：HTTP 200 + {"statusCode":401,"message":"演示站禁止修改此项！"} —— 看着成功其实什么都没做
    rec_fail "信封 statusCode=200" "演示站信封（HTTP ${code} + statusCode=401）：$(json_get "${body}" message) ⇒ 恢复**没有发生**，而 HTTP 状态码是 200（只看 HTTP 码就会误判成功）"
    return 1
  fi
  if [[ "${code}" == "201" ]]; then
    rec_pass "恢复接口返回 HTTP 201" "上传 ${pretty} + 恢复，端到端 ${elapsed}s"
  else
    rec_fail "恢复接口返回 HTTP 201" "实际 HTTP ${code}：$(printf '%s' "${body}" | head -c 300)"
    case "${code}" in
    400) say "  ${yellow}400 = 归档被拒（没有文件 / 文件名不合规 / 清单读不出 / 成员不安全 / 没有解压器 / 归档版本比本程序新）${plain}" ;;
    403) say "  ${yellow}403 = 站点已初始化：这条接口只对全新站点开放（演练必须在空库上跑）${plain}" ;;
    409) say "  ${yellow}409 = 另有一个恢复在跑（单飞锁）${plain}" ;;
    413) say "  ${yellow}413 = 超过上传限额（8GB）${plain}" ;;
    000) say "  ${yellow}000 = 请求根本没送达（容器挂了 / 端口不对 / 反代超时）${plain}" ;;
    esac
    return 1
  fi

  local env_code="${env_code0}"
  if [[ "${env_code}" == "200" ]]; then
    rec_pass "信封 statusCode=200" "200"
  else
    rec_fail "信封 statusCode=200" "得到 ${env_code:-（空）}：$(printf '%s' "${body}" | head -c 200)"
    return 1
  fi

  DRILL_ENV_INIT="$(json_get "${body}" data.initialized)"
  DRILL_ENV_ADMIN="$(json_get "${body}" data.adminUserFromArchive)"
  DRILL_ENV_SECS="$(json_get "${body}" data.seconds)"
  local m_users
  m_users="$(json_get "${manifest}" databases.vanBlog.collections.users.count)"

  if [[ "${DRILL_ENV_INIT}" == "true" ]]; then
    rec_pass "恢复后站点已初始化（data.initialized）" "true"
  elif [[ "${DRILL_ENV_INIT}" == "false" ]]; then
    # 归档里没有 users 时，恢复"成功"但站点仍未初始化 —— 这是**合法的**，
    # 要解释清楚而不是判失败（前台只看 HTTP 200 会以为万事大吉）
    rec_warn "恢复后站点已初始化（data.initialized）" "false：这份归档里没有管理员账号（清单 users=${m_users:-0}）。数据恢复了，但站点仍是未初始化状态、进不了后台；要演练「能登录的站点恢复回来了」，请用带 users 的归档"
  else
    rec_fail "恢复后站点已初始化（data.initialized）" "响应里没有 data.initialized（得到 ${DRILL_ENV_INIT:-（空）}）：接口形状变了？前台只看 HTTP 200 会误判"
  fi
  if [[ "${DRILL_ENV_ADMIN}" == "true" ]]; then
    rec_pass "后台账号来自归档（adminUserFromArchive）" "true（恢复后用备份里的那套凭据登录）"
  elif [[ "${DRILL_ENV_ADMIN}" == "false" ]]; then
    rec_warn "后台账号来自归档（adminUserFromArchive）" "false：归档里没有 users，恢复后没有管理员账号"
  else
    rec_fail "后台账号来自归档（adminUserFromArchive）" "响应里没有这个字段（得到 ${DRILL_ENV_ADMIN:-（空）}）"
  fi

  DRILL_ENV_ARTICLES="$(json_get "${body}" data.counts.articles)"
  DRILL_ENV_STATICS="$(json_get "${body}" data.counts.statics)"
  DRILL_ENV_USERS="$(json_get "${body}" data.counts.users)"
  DRILL_ENV_VISITS="$(json_get "${body}" data.counts.visits)"
  DRILL_ENV_VIEWERS="$(json_get "${body}" data.counts.viewers)"
  DRILL_ENV_SETTINGS="$(json_get "${body}" data.counts.settings)"
  DRILL_ENV_TOTAL="$(json_get "${body}" data.counts.total)"
  if [[ "${DRILL_ENV_ARTICLES}" =~ ^[0-9]+$ ]] && ((DRILL_ENV_ARTICLES > 0)); then
    rec_pass "counts.articles > 0" "articles=${DRILL_ENV_ARTICLES}（statics=${DRILL_ENV_STATICS:-?} users=${DRILL_ENV_USERS:-?} settings=${DRILL_ENV_SETTINGS:-?} total=${DRILL_ENV_TOTAL:-?}）"
  else
    rec_fail "counts.articles > 0" "articles=${DRILL_ENV_ARTICLES:-（空）}：一份没有文章的整站备份，恢复出来就是个空站"
  fi
  say "  信封数字  ：articles=${DRILL_ENV_ARTICLES:-?} statics=${DRILL_ENV_STATICS:-?} users=${DRILL_ENV_USERS:-?} visits=${DRILL_ENV_VISITS:-?} viewers=${DRILL_ENV_VIEWERS:-?} settings=${DRILL_ENV_SETTINGS:-?} total=${DRILL_ENV_TOTAL:-?}"
  say "  恢复耗时  ：server 报 ${DRILL_ENV_SECS:-?}s（含写库与静态文件），端到端 ${elapsed}s"

  # notes 有两种：一种只是提醒（"建议重启 server"、"要重新登录"，每次成功恢复都会有），
  # 一种是**数据没全恢复**（某集合的 .ndjson 缺失被跳过）。只有后者值得 WARN，
  # 否则每次演练都顶着一条 WARN，看的人会习惯性忽略它（狼来了）。
  local notes_n d_notes
  notes_n="$(json_len "${body}" data.notes)"
  d_notes="$(json_raw "${body}" data.notes)"
  if [[ "${notes_n}" =~ ^[0-9]+$ ]] && ((notes_n > 0)); then
    local bad_notes
    bad_notes="$(printf '%s' "${d_notes}" | grep -oiE '"[^"]*(缺失|跳过|失败|没找到|missing|skip|not found|error)[^"]*"' | head -3)"
    if [[ -n "${bad_notes}" ]]; then
      rec_warn "恢复 notes 里没有数据缺失" "${notes_n} 条里有缺失类的：$(printf '%s' "${bad_notes}" | tr '\n' ' ' | head -c 300)"
    else
      rec_note "server 给了 ${notes_n} 条提醒（不是故障）" "$(printf '%s' "${d_notes}" | tr -d '\n' | head -c 300)"
    fi
  else
    rec_pass "server 恢复时没有 notes" "0 条"
  fi

  # ── 与归档清单对账："接口说 59" 和 "清单里写着 59" 是两个说法 ──
  local m_articles
  m_articles="$(json_get "${manifest}" databases.vanBlog.collections.articles.count)"
  if [[ -n "${m_articles}" && "${DRILL_ENV_ARTICLES}" == "${m_articles}" ]]; then
    rec_pass "信封 counts.articles 与归档清单一致" "${DRILL_ENV_ARTICLES} == 清单 databases.vanBlog.collections.articles.count"
  else
    rec_fail "信封 counts.articles 与归档清单一致" "信封 ${DRILL_ENV_ARTICLES:-（空）} vs 清单 ${m_articles:-（读不出）}"
  fi
  if [[ -n "${m_users}" && "${DRILL_ENV_USERS}" == "${m_users}" ]]; then
    rec_pass "信封 counts.users 与归档清单一致" "${DRILL_ENV_USERS}"
  else
    rec_warn "信封 counts.users 与归档清单一致" "信封 ${DRILL_ENV_USERS:-（空）} vs 清单 ${m_users:-（读不出）}"
  fi

  # 清单自洽 + 真写进库的文档数
  DRILL_ENV_DOCS="$(json_get "${body}" data.databases.vanBlog.documents)"
  DRILL_ENV_COLLS="$(json_get "${body}" data.databases.vanBlog.collections)"
  local sum_docs=0 dbk collk cv
  while read -r dbk; do
    [[ -n "${dbk}" ]] || continue
    while read -r collk; do
      [[ -n "${collk}" ]] || continue
      cv="$(json_get "${manifest}" "databases.${dbk}.collections.${collk}.count")"
      [[ "${cv}" =~ ^[0-9]+$ ]] && sum_docs=$((sum_docs + cv))
    done < <(json_keys "${manifest}" "databases.${dbk}.collections")
  done < <(json_keys "${manifest}" databases)
  local m_total
  m_total="$(json_get "${manifest}" totals.documents)"
  if [[ -z "${m_total}" ]]; then
    rec_note "清单里没有 totals.documents" "没法核对声明条数是否自洽"
  elif [[ "${sum_docs}" == "${m_total}" ]]; then
    rec_pass "清单自洽：Σ集合条数 == totals.documents" "${sum_docs}"
  else
    rec_warn "清单自洽：Σ集合条数 == totals.documents" "Σ=${sum_docs} vs totals.documents=${m_total}（恢复路径不读 totals，只是导出时算错了）"
  fi
  local all_docs=0 dv
  while read -r dbk; do
    [[ -n "${dbk}" ]] || continue
    dv="$(json_get "${body}" "data.databases.${dbk}.documents")"
    [[ "${dv}" =~ ^[0-9]+$ ]] && all_docs=$((all_docs + dv))
  done < <(json_keys "${body}" data.databases)
  if ((all_docs > 0)); then
    rec_pass "恢复真的写进了文档（data.databases）" "共 ${all_docs} 条（vanBlog：${DRILL_ENV_DOCS:-?} 条 / ${DRILL_ENV_COLLS:-?} 个集合）"
  else
    rec_fail "恢复真的写进了文档（data.databases）" "一条都没写进去（响应前 120 字节：$(printf '%s' "${body}" | head -c 120)）"
  fi

  _no_new_fail "${f0}"
}

# /api/public/meta：<http_code> <body> <归档算出的公开文章数（可空）>
drill_assert_meta() {
  local code="$1" body="$2" expect_public="${3:-}"
  local f0=${ASSERT_FAIL}
  local env_code site_name total_articles
  env_code="$(json_get "${body}" statusCode)"
  if [[ "${code}" != "200" ]]; then
    rec_fail "/api/public/meta 是真实站点" "HTTP ${code}（期望 200）"
    return 1
  fi
  if [[ "${env_code}" == "233" ]]; then
    rec_fail "/api/public/meta 是真实站点" "仍然是未初始化的 233 信封（$(json_get "${body}" message)）⇒ 数据没恢复进去"
    return 1
  fi
  # 站点名的位置在不同版本里挪过：data.meta.siteInfo.siteName 是当前的形状，其余是兼容回落
  site_name="$(json_get "${body}" data.meta.siteInfo.siteName)"
  [[ -n "${site_name}" ]] || site_name="$(json_get "${body}" data.siteInfo.siteName)"
  [[ -n "${site_name}" ]] || site_name="$(json_get "${body}" data.meta.siteName)"
  [[ -n "${site_name}" ]] || site_name="$(json_get "${body}" data.siteName)"
  if [[ "${env_code}" == "200" && -n "${site_name}" ]]; then
    rec_pass "/api/public/meta 是真实站点" "statusCode=200，siteName=${site_name}"
  elif [[ "${env_code}" == "200" ]]; then
    rec_warn "/api/public/meta 是真实站点" "statusCode=200 但读不出站点名（响应前 200 字节：$(printf '%s' "${body}" | head -c 200)）"
  else
    rec_fail "/api/public/meta 是真实站点" "statusCode=${env_code:-（空）}"
  fi
  # meta 里另有一份公开文章数（与列表接口独立算的），一起对账
  total_articles="$(json_get "${body}" data.totalArticles)"
  if [[ -n "${expect_public}" && "${expect_public}" =~ ^[0-9]+$ ]]; then
    if [[ "${total_articles}" == "${expect_public}" ]]; then
      rec_pass "meta.totalArticles 与归档对得上" "${total_articles} == 归档算出的公开文章数 ${expect_public}"
    elif [[ -z "${total_articles}" ]]; then
      rec_note "meta 里没有 totalArticles" "没法用它交叉验证（列表接口那条还在）"
    else
      rec_fail "meta.totalArticles 与归档对得上" "meta ${total_articles} vs 归档公开 ${expect_public}"
    fi
  fi
  _no_new_fail "${f0}"
}

# 公开文章列表的 total：<站点 total> <drill_expected_articles 的输出> <清单里的 articles 总数> <http_code>
drill_assert_article_total() {
  local site_total="$1" expect_line="$2" m_articles="${3:-?}" code="${4:-200}"
  local f0=${ASSERT_FAIL}
  local exp_public exp_loose
  exp_public="$(printf '%s' "${expect_line}" | grep -oE 'public=[0-9]+' | cut -d= -f2)"
  exp_loose="$(printf '%s' "${expect_line}" | grep -oE 'loose=[0-9]+' | cut -d= -f2)"
  rec_note "归档里的文章构成" "${expect_line}（判据照 server 的公开列表过滤：deleted / hidden / private / 私密分类）"
  if [[ -z "${site_total}" ]]; then
    rec_fail "公开文章列表 total 与归档对得上" "读不出 /api/public/article 的 data.total（HTTP ${code}）"
  elif [[ "${site_total}" == "${exp_public}" ]]; then
    rec_pass "公开文章列表 total 与归档对得上" "站点 ${site_total} == 归档算出的公开文章数 ${exp_public}（归档共 ${m_articles} 篇）"
  elif [[ -n "${exp_loose}" && "${site_total}" == "${exp_loose}" && "${exp_loose}" != "${exp_public}" ]]; then
    rec_warn "公开文章列表 total 与归档对得上" "站点 ${site_total} == 不扣私密分类的 ${exp_loose}（严格判据是 ${exp_public}）：私密分类两边的口径不同，数字对得上其中一种"
  elif [[ "${site_total}" == "0" ]]; then
    rec_fail "公开文章列表 total 与归档对得上" "站点 0 篇，归档里有 ${exp_public:-?} 篇公开文章 ⇒ 前台是空的"
  else
    rec_fail "公开文章列表 total 与归档对得上" "站点 ${site_total} vs 归档公开 ${exp_public:-?}（含私密分类则 ${exp_loose:-?}），归档共 ${m_articles} 篇"
  fi
  _no_new_fail "${f0}"
}

# 归档里的一个静态文件：<URL 路径> <http_code> <字节数>
drill_assert_static_fetch() {
  local url="$1" code="$2" bytes="$3"
  local f0=${ASSERT_FAIL}
  if [[ -z "${url}" ]]; then
    rec_warn "归档里的静态文件取得到" "归档里没有 static/img|file|customPage 成员，没法探（空站点属正常）"
  elif [[ "${code}" == "200" && "${bytes}" =~ ^[0-9]+$ ]] && ((bytes > 0)); then
    rec_pass "归档里的静态文件取得到" "GET ${url} → 200，${bytes} 字节"
  elif [[ "${code}" == "200" ]]; then
    rec_fail "归档里的静态文件取得到" "GET ${url} → 200 但 ${bytes:-0} 字节（文件恢复了却是空的）"
  else
    rec_fail "归档里的静态文件取得到" "GET ${url} → HTTP ${code}（静态树没恢复出来）"
  fi
  _no_new_fail "${f0}"
}

# 主题（专门盯"上传的主题 CSS 从来不进备份"那个回归）：
#   <归档里的 themes 成员（每行一个）> <生效主题 JSON> <theme.css 的码> <theme.css 的字节>
#   <归档里第一个主题文件的 URL> <它的码> <它的字节>
drill_assert_themes() {
  local theme_members="$1" active_json="$2" css_code="$3" css_bytes="$4" file_url="$5" file_code="$6" file_bytes="$7"
  local f0=${ASSERT_FAIL}
  local theme_n active_url
  theme_n="$(printf '%s\n' "${theme_members}" | grep -c . || true)"
  active_url="$(json_get "${active_json}" data.url)"
  if [[ "${theme_n}" =~ ^[0-9]+$ ]] && ((theme_n > 0)); then
    say "  归档里的主题文件：$(printf '%s' "${theme_members}" | head -3 | tr '\n' ' ')（共 ${theme_n} 个）"
    if [[ "${file_code}" == "200" && "${file_bytes}" =~ ^[0-9]+$ ]] && ((file_bytes > 0)); then
      rec_pass "归档里的主题 CSS 文件取得到" "GET ${file_url} → 200，${file_bytes} 字节"
    else
      rec_fail "归档里的主题 CSS 文件取得到" "GET ${file_url} → HTTP ${file_code}，${file_bytes:-0} 字节 ⇒ static/themes 没进归档或没恢复出来（后台会显示主题还在，前台静默退回默认皮肤）"
    fi
    if [[ -n "${active_url}" ]]; then
      # 生效的是上传主题：稳定地址必须给真 CSS。
      # ⚠️ 204 不是"没有主题"，是 theme.controller 读不到文件时的**静默兜底**（空样式表）——
      #    所以元数据在、文件不在时用户看到的是默认皮肤 + 零报错，正是那个回归的形状。
      if [[ "${css_code}" == "200" && "${css_bytes}" =~ ^[0-9]+$ ]] && ((css_bytes > 0)); then
        rec_pass "/api/public/theme.css 返回真 CSS" "生效主题 ${active_url}；200，${css_bytes} 字节"
      elif [[ "${css_code}" == "204" ]]; then
        rec_fail "/api/public/theme.css 返回真 CSS" "204 空样式表：主题元数据在（${active_url}）、文件不在 ⇒ 正是「主题不进备份」那个回归（前台静默用默认皮肤，零报错）"
      else
        rec_fail "/api/public/theme.css 返回真 CSS" "HTTP ${css_code}（期望 200）"
      fi
    else
      rec_note "当前生效的是内置主题（生效主题没有 static/themes 文件）" "/api/public/theme.css 此时返回 204 是正常的；要覆盖那条路径，先在后台切到上传的主题再演练"
    fi
  else
    # 归档里没有 themes 不是"通过"，是一条必须说出来的信息：真恢复之后上传的主题会丢
    rec_note "这份归档里没有 static/themes/" "它早于「主题进整站备份」那个修复；真机恢复后**上传的主题会丢**（后台可能仍显示主题存在且启用，前台退回默认皮肤）。要覆盖这条，用修复之后导出的归档演练"
    if [[ -n "${active_url}" ]]; then
      rec_fail "归档没有主题、但恢复后却有生效的上传主题" "生效主题指向 ${active_url}，而归档里没有 static/themes/ ⇒ 元数据恢复了、文件没恢复（用户看到的就是「主题在但样式没了」）"
    fi
  fi
  _no_new_fail "${f0}"
}

# 容器日志里的致命错误（BSON 主版本那个 400 就是从这儿看出来的）：<日志文件>
DRILL_LOG_PATTERNS=("Unsupported BSON version" "BSONVersionError" "Cannot find module" "unhandledRejection" "ECONNREFUSED" "Reached heap limit")
drill_assert_logs() {
  local logfile="$1"
  local f0=${ASSERT_FAIL} pat hits=""
  if [[ ! -f "${logfile}" ]]; then
    rec_warn "容器日志里没有致命错误" "拿不到日志文件（${logfile}）"
    return 0
  fi
  for pat in ${DRILL_LOG_PATTERNS[@]+"${DRILL_LOG_PATTERNS[@]}"}; do
    if grep -qF -- "${pat}" "${logfile}" 2>/dev/null; then
      hits="${hits}${hits:+；}${pat}"
    fi
  done
  local plist="" p2
  for p2 in ${DRILL_LOG_PATTERNS[@]+"${DRILL_LOG_PATTERNS[@]}"}; do
    plist="${plist}${plist:+ / }${p2}"
  done
  if [[ -z "${hits}" ]]; then
    rec_pass "容器日志里没有致命错误" "扫了 ${#DRILL_LOG_PATTERNS[@]} 个模式（${plist}）"
  else
    rec_fail "容器日志里没有致命错误" "命中：${hits}"
    grep -F -- "${hits%%；*}" "${logfile}" 2>/dev/null | head -3 | sed 's/^/      /'
  fi
  _no_new_fail "${f0}"
}

# 已初始化之后再调一次恢复接口：<http_code> <body>
drill_assert_second_restore() {
  local code="$1" body="$2"
  local f0=${ASSERT_FAIL}
  if [[ "${code}" == "403" ]]; then
    rec_pass "恢复接口在已初始化站点上被挡住（403）" "403：$(printf '%s' "${body}" | head -c 160)"
  elif [[ "${code}" == "201" ]]; then
    rec_fail "恢复接口在已初始化站点上被挡住（403）" "又恢复了一次（HTTP 201）⇒ 匿名恢复接口没有「只在未初始化时开放」这道闸，任何人都能反复覆盖整站"
  else
    rec_warn "恢复接口在已初始化站点上被挡住（403）" "期望 403，实际 HTTP ${code}：$(printf '%s' "${body}" | head -c 200)"
  fi
  _no_new_fail "${f0}"
}

# 把演练计划打出来（--dry-run 与真跑共用同一份，避免"打印的是一套、跑的是另一套"）
drill_print_plan() {
  local eng="$1" img="$2" mongo_img="$3" archive="$4" suffix="$5" net="$6"
  say "  引擎      ：${yellow}${eng}${plain}（$(drill_engine_version "${eng}")）"
  say "  vanblog   ：${yellow}${img}${plain}"
  say "  mongo     ：${yellow}${mongo_img}${plain}"
  say "  归档      ：${yellow}${archive}${plain}"
  say "  名字前缀  ：${DRILL_PREFIX}-${suffix}（容器 ${DRILL_APP_NAME} / ${DRILL_MONGO_NAME}，网络 ${net}）"
  say "  端口      ：HTTP ${DRILL_HTTP_PORT} → 容器 80；mongo ${DRILL_MONGO_PORT} → 容器 27017（都是宿主机上的空闲端口）"
  say "  卷        ：${DRILL_VOLUMES[*]:-（未分配）}（引擎管理的临时卷，不用宿主机目录：mongo 的数据文件是 root 所有，没有 sudo 删不掉）"
  say "  临时目录  ：${DRILL_TMP:-（未分配）}（放响应体与探测结果）"
  say "  步骤      ：起 mongo → 起 vanblog（指向 mongo 容器 IP，不依赖容器名 DNS）→ 等 /api/public/health 200"
  say "              → 确认站点**未**初始化（/api/public/meta 回 233 信封）→ POST /api/admin/init/restore 上传归档"
  say "              → 断言恢复信封（statusCode/initialized/adminUserFromArchive/counts）"
  say "              → 与归档清单对账（条数、静态文件数）→ HTTP 探测恢复出来的站点"
  say "                 （meta 不是未初始化信封 / 文章列表 total 对上 / 抽一个静态文件 200 且非空 /"
  say "                  归档里有 static/themes 时主题 CSS 必须 200，没有则明说这份归档早于主题备份）"
  say "              → 扫容器日志里的致命错误 → 再调一次恢复接口，期望 403（已初始化）"
  say "              → 拆掉全部一次性资源（trap，失败也拆）"
}

cmd_drill() {
  local archive="" upload_name="" want_http="" want_mongo=""
  local arg
  while [[ $# -gt 0 ]]; do
    arg="$1"
    shift
    case "${arg}" in
    --image) DRILL_IMAGE="${1:-}"; shift ;;
    --mongo-image) DRILL_MONGO_IMAGE="${1:-}"; shift ;;
    --engine) DRILL_ENGINE="${1:-}"; shift ;;
    --http-port) want_http="${1:-}"; shift ;;
    --mongo-port) want_mongo="${1:-}"; shift ;;
    --timeout) DRILL_TIMEOUT="${1:-${DRILL_TIMEOUT}}"; shift ;;
    --prefix) DRILL_PREFIX="${1:-${DRILL_PREFIX}}"; shift ;;
    --as) upload_name="${1:-}"; shift ;;
    --keep) DRILL_KEEP=1 ;;
    --dry-run) DRILL_DRY_RUN=1 ;;
    --no-pull) DRILL_NO_PULL=1 ;;
    --skip-preflight) DRILL_SKIP_PREFLIGHT=1 ;;
    -h | --help | help) drill_usage; return 0 ;;
    0) : ;; # vanblog.sh 的菜单/分发习惯会塞一个 0 进来
    --*) say "${red}drill：未知参数 ${arg}${plain}"; return 2 ;;
    *)
      if [[ -z "${archive}" ]]; then archive="${arg}"; else say "${yellow}忽略多余的参数：${arg}${plain}"; fi
      ;;
    esac
  done

  assert_reset
  step "恢复演练（drill）：把整站备份真恢复一遍"

  # ── 1) 找归档 ──────────────────────────────────────────────────────────
  if [[ -z "${archive}" ]]; then
    local dir newest
    dir="$(full_backup_dir 2>/dev/null)"
    newest="$(ls -1t "${dir}"/vanblog-full-* 2>/dev/null | grep -vE '\.(manifest\.json|sha256)$' | head -1)"
    if [[ -z "${newest}" ]]; then
      say "${red}没有指定归档，而备份目录里也找不到 vanblog-full-* 归档：${dir}${plain}"
      say "  用法：${green}${DRILL_SELF_NAME} drill /path/to/vanblog-full-xxx.tar.zst${plain}"
      rec_fail "找到要演练的归档" "备份目录 ${dir} 里没有 vanblog-full-* 归档"
      assert_summary "演练结果"
      return 1
    fi
    archive="${newest}"
    rec_note "未指定归档，用备份目录里最新的一份" "$(basename "${archive}")"
  elif [[ ! -f "${archive}" && -f "$(full_backup_dir 2>/dev/null)/${archive}" ]]; then
    archive="$(full_backup_dir)/${archive}"
  fi

  if [[ ! -f "${archive}" ]]; then
    rec_fail "归档可读" "${archive} 不存在"
    assert_summary "演练结果"
    return 1
  fi
  archive="$(cd "$(dirname "${archive}")" && pwd)/$(basename "${archive}")"
  local size pretty
  size="$(wc -c <"${archive}" 2>/dev/null || echo 0)"
  pretty="$(human_bytes "${size}")"

  # ── 2) 上传前的静态预检（这些不合规，接口一定 400，白等一次容器启动）──────
  if [[ -n "${upload_name}" ]]; then
    rec_warn "上传文件名被 --as 覆盖" "真实用户拿到的是原名 $(basename "${archive}")；这次以 ${upload_name} 上传"
  else
    upload_name="$(basename "${archive}")"
  fi
  if drill_archive_name_ok "${upload_name}"; then
    rec_pass "归档文件名符合上传白名单" "${upload_name}（^vanblog-full-.+\\.tar\\.(zst|xz|gz)$）"
  else
    if [[ "${DRILL_SKIP_PREFLIGHT}" == "1" ]]; then
      rec_warn "归档文件名符合上传白名单" "${upload_name} 不匹配白名单（--skip-preflight：照样上传，期望 server 400）"
    else
      rec_fail "归档文件名符合上传白名单" "${upload_name} 不匹配 ^vanblog-full-.+\\.tar\\.(zst|xz|gz)$，/api/admin/init/restore 会直接 400（改回原名或用 --as）"
    fi
  fi
  local fmt
  fmt="$(archive_format_of "${archive}")"
  if [[ -z "${fmt}" ]]; then
    rec_fail "认得出压缩格式" "$(basename "${archive}") 不是 .tar.zst/.tar.xz/.tar.gz"
    assert_summary "演练结果"
    return 1
  fi
  rec_pass "认得出压缩格式" "${fmt}"

  # 清单：从归档里读（恢复时 server 读的就是这一份）
  local manifest manifest_kind manifest_version
  if drill_archive_manifest "${archive}"; then
    manifest="${MANIFEST_JSON}"
    rec_pass "归档里的清单读得出来" "来源：${MANIFEST_SOURCE}（$(printf '%s' "${manifest}" | wc -c | tr -d ' ') 字节）"
    if [[ "${MANIFEST_SOURCE}" == "sidecar" ]]; then
      rec_warn "清单来自归档内部" "归档里读不出 manifest.json，退用了旁边的 .manifest.json 副本；恢复时 server 读的是**归档里**那一份，副本对不上就是 400"
    fi
  elif [[ "${DRILL_SKIP_PREFLIGHT}" == "1" ]]; then
    manifest="{}"
    rec_warn "归档里的清单读得出来" "读不出 manifest.json（--skip-preflight：照样上传，让 server 的护栏去判）；本机 ${fmt} 工具：$(command -v "${fmt}" >/dev/null 2>&1 && echo 有 || echo 没有)"
  else
    rec_fail "归档里的清单读得出来" "读不出 manifest.json（恢复会 400：读不出这个备份的清单）；本机 ${fmt} 工具：$(command -v "${fmt}" >/dev/null 2>&1 && echo 有 || echo 没有)"
    assert_summary "演练结果"
    return 1
  fi
  manifest_kind="$(json_get "${manifest}" kind)"
  manifest_version="$(json_get "${manifest}" version)"
  if [[ "${manifest_kind}" == "vanblog-full-backup" ]]; then
    rec_pass "清单 kind 正确" "${manifest_kind}"
  elif [[ "${DRILL_SKIP_PREFLIGHT}" == "1" ]]; then
    rec_warn "清单 kind 正确" "得到 ${manifest_kind:-（空）}（--skip-preflight：交给 server 判）"
  else
    rec_fail "清单 kind 正确" "得到 ${manifest_kind:-（空）}，期望 vanblog-full-backup（恢复会 400）"
  fi
  if [[ "${manifest_version}" =~ ^[0-9]+$ ]] && ((manifest_version <= 1)); then
    rec_pass "清单 version 本程序认" "version=${manifest_version}（恢复只接受 <= 1）"
  elif [[ "${DRILL_SKIP_PREFLIGHT}" == "1" ]]; then
    rec_warn "清单 version 本程序认" "version=${manifest_version:-（非数字）}（--skip-preflight：交给 server 判）"
  else
    rec_fail "清单 version 本程序认" "version=${manifest_version:-（非数字）}；比本程序新的归档恢复时会被拒绝（400）"
  fi

  local members
  members="$(drill_archive_members "${archive}")"
  if [[ -z "${members}" && "${DRILL_SKIP_PREFLIGHT}" == "1" ]]; then
    rec_warn "成员表列得出来" "列不出成员（归档可能截断/损坏）—— --skip-preflight：照样上传，看 server 怎么判"
    members="./manifest.json"
  elif [[ -z "${members}" ]]; then
    rec_fail "成员表列得出来" "解压或 tar 失败（归档可能截断/损坏）"
    assert_summary "演练结果"
    return 1
  fi
  local member_n unsafe
  member_n="$(printf '%s\n' "${members}" | grep -c . || true)"
  rec_pass "成员表列得出来" "${member_n} 个成员"
  unsafe="$(printf '%s\n' "${members}" | grep -E '^/|^[A-Za-z]:[\\/]|(^|/)\.\.(/|$)' | head -3)"
  if [[ -z "${unsafe}" ]]; then
    rec_pass "成员路径安全（无绝对路径 / ..）" "恢复前的 assertRestorableArchive 会拒绝越界成员"
  else
    rec_fail "成员路径安全（无绝对路径 / ..）" "$(printf '%s' "${unsafe}" | tr '\n' ' ')"
  fi

  local theme_members probe_static
  theme_members="$(drill_archive_theme_members "${members}")"
  probe_static="$(drill_archive_probe_static "${members}")"

  # 期望值：文章条数（清单里的总数 + NDJSON 里按公开过滤条件算出来的数）
  local m_articles m_users m_statics m_total_docs m_files
  m_articles="$(json_get "${manifest}" databases.vanBlog.collections.articles.count)"
  m_users="$(json_get "${manifest}" databases.vanBlog.collections.users.count)"
  m_statics="$(json_get "${manifest}" databases.vanBlog.collections.statics.count)"
  m_total_docs="$(json_get "${manifest}" totals.documents)"
  m_files="$(json_get "${manifest}" totals.files)"

  # ── 3) 引擎 / 镜像 / 端口 / 名字 ───────────────────────────────────────
  local eng img
  img="$(drill_resolve_image)"
  if ! eng="$(drill_detect_engine)"; then
    DRILL_ENGINE="${DRILL_ENGINE}"
    say "${red}没有可用的容器引擎${plain}（docker daemon 连不上，也没有可用的 podman）"
    say "  装一个再跑：podman（rootless，免 sudo）或 docker；也可以用 --engine 指定"
    rec_fail "有可用的容器引擎" "docker/podman 都不可用；演练需要起一次性容器"
    assert_summary "演练结果"
    return 1
  fi
  DRILL_ENGINE="${eng}"
  drill_export_engine_env "${eng}"
  rec_pass "有可用的容器引擎" "${eng}（$(drill_engine_version "${eng}")）"

  local suffix net_name
  suffix="$(drill_make_suffix)"
  DRILL_APP_NAME="${DRILL_PREFIX}-app-${suffix}"
  DRILL_MONGO_NAME="${DRILL_PREFIX}-mongo-${suffix}"
  net_name="${DRILL_PREFIX}-net-${suffix}"
  DRILL_VOLUMES=("${DRILL_PREFIX}-static-${suffix}" "${DRILL_PREFIX}-log-${suffix}"
    "${DRILL_PREFIX}-caddycfg-${suffix}" "${DRILL_PREFIX}-caddydata-${suffix}"
    "${DRILL_PREFIX}-mongo-${suffix}")

  # 撞名就拒绝（宁可不做演练，也不能碰到在跑的栈）
  local collide=""
  local n
  for n in "${DRILL_APP_NAME}" "${DRILL_MONGO_NAME}"; do
    drill_resource_exists "${eng}" container "${n}" && collide="${collide} container:${n}"
  done
  drill_resource_exists "${eng}" network "${net_name}" && collide="${collide} network:${net_name}"
  for n in ${DRILL_VOLUMES[@]+"${DRILL_VOLUMES[@]}"}; do
    drill_resource_exists "${eng}" volume "${n}" && collide="${collide} volume:${n}"
  done
  if [[ -n "${collide}" ]]; then
    rec_fail "一次性资源名字没有冲突" "已存在：${collide}（拒绝启动，避免碰到在跑的栈；换个 VANBLOG_DRILL_PREFIX 再试）"
    assert_summary "演练结果"
    return 1
  fi
  rec_pass "一次性资源名字没有冲突" "${DRILL_PREFIX}-${suffix}"

  if [[ -n "${want_http}" ]]; then
    if drill_port_free "${want_http}"; then
      DRILL_HTTP_PORT="${want_http}"
      DRILL_TAKEN_PORTS="${DRILL_TAKEN_PORTS},${want_http}"
    else
      rec_fail "指定端口可用" "--http-port ${want_http} 已被占用/在临时端口区间"
      assert_summary "演练结果"
      return 1
    fi
  else
    drill_pick_free_port "${DRILL_PORT_BASE}" "${DRILL_PORT_SPAN}"
    DRILL_HTTP_PORT="${PICKED_PORT}"
  fi
  if [[ -n "${want_mongo}" ]]; then
    if drill_port_free "${want_mongo}" && [[ "${want_mongo}" != "27017" ]]; then
      DRILL_MONGO_PORT="${want_mongo}"
      DRILL_TAKEN_PORTS="${DRILL_TAKEN_PORTS},${want_mongo}"
    else
      rec_fail "指定端口可用" "--mongo-port ${want_mongo} 不可用（27017 是开发/生产在用的库，演练绝不用它）"
      assert_summary "演练结果"
      return 1
    fi
  else
    drill_pick_free_port "${DRILL_PORT_BASE}" "${DRILL_PORT_SPAN}"
    DRILL_MONGO_PORT="${PICKED_PORT}"
  fi
  if [[ -z "${DRILL_HTTP_PORT}" || -z "${DRILL_MONGO_PORT}" ]]; then
    rec_fail "挑到两个空闲端口" "在 ${DRILL_PORT_BASE}..$((DRILL_PORT_BASE + DRILL_PORT_SPAN)) 里没找到（VANBLOG_DRILL_PORT_BASE 可换区间）"
    assert_summary "演练结果"
    return 1
  fi
  if [[ "${DRILL_HTTP_PORT}" == "${DRILL_MONGO_PORT}" ]]; then
    rec_fail "挑到两个**不同的**空闲端口" "HTTP 与 mongo 都挑到了 ${DRILL_HTTP_PORT}（端口占用表没记下来？）"
    assert_summary "演练结果"
    return 1
  fi
  # 硬护栏：演练的 mongo 端口绝不可能是真库那个
  if [[ "${DRILL_MONGO_PORT}" == "27017" ]]; then
    rec_fail "演练不碰 27017" "挑端口挑到了 27017（开发/生产在用的库），拒绝继续"
    assert_summary "演练结果"
    return 1
  fi
  rec_pass "挑到两个空闲端口" "HTTP ${DRILL_HTTP_PORT}，mongo ${DRILL_MONGO_PORT}（都不是 27017）"

  DRILL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/vanblog-drill.XXXXXX" 2>/dev/null)" || DRILL_TMP=""
  if [[ -z "${DRILL_TMP}" ]]; then
    rec_fail "建得出临时目录" "mktemp 失败（TMPDIR=${TMPDIR:-/tmp}）"
    assert_summary "演练结果"
    return 1
  fi

  if [[ "${DRILL_DRY_RUN}" == "1" ]]; then
    step "dry-run：只打印计划，不动任何东西"
    drill_print_plan "${eng}" "${img}" "${DRILL_MONGO_IMAGE}" "${archive}（${pretty}）" "${suffix}" "${net_name}"
    say "\n  将要断言的项：归档文件名白名单 / 压缩格式 / 清单 kind 与 version / 成员路径安全 /"
    say "                引擎可用 / 名字不撞 / 端口空闲 / 容器起来并就绪（/api/public/health 200）/"
    say "                恢复前站点未初始化（233）/ 恢复接口 HTTP 201 且 statusCode=200 /"
    say "                data.initialized 与 adminUserFromArchive / counts.articles>0 /"
    say "                信封 counts 与归档清单一致 / meta 是真实站点 / 文章列表 total 对上 /"
    say "                抽一个静态文件 200 且非空 / 主题（有 static/themes 就必须 200，没有就说明）/"
    say "                容器日志无致命错误 / 第二次恢复被 403 挡住"
    say "\n> dry-run 完成：没有创建容器、没有发起请求（上面的静态预检是只读的）"
    echo "RESULT: DRY-RUN pass=${ASSERT_PASS} warn=${ASSERT_WARN} fail=${ASSERT_FAIL} note=${ASSERT_NOTE}"
    rm -rf "${DRILL_TMP}" 2>/dev/null || true
    DRILL_TMP=""
    return $((ASSERT_FAIL > 0 ? 1 : 0))
  fi

  # 从这里开始要动容器了：先装 trap，保证任何失败路径都拆干净
  trap 'drill_cleanup' EXIT
  trap 'drill_cleanup; exit 130' INT
  trap 'drill_cleanup; exit 143' TERM

  # ── 4) 镜像在不在 ─────────────────────────────────────────────────────
  local need_pull=0
  if drill_resource_exists "${eng}" image "${img}"; then
    rec_pass "vanblog 镜像在本地" "${img}"
  else
    need_pull=1
  fi
  if ! drill_resource_exists "${eng}" image "${DRILL_MONGO_IMAGE}"; then
    rec_warn "mongo 镜像不在本地" "${DRILL_MONGO_IMAGE}（下面会尝试 pull）"
  fi
  if [[ ${need_pull} -eq 1 ]]; then
    if [[ "${DRILL_NO_PULL}" == "1" ]]; then
      rec_fail "vanblog 镜像在本地" "${img} 不在本地，且 --no-pull"
      assert_summary "演练结果"
      return 1
    fi
    say "> 本地没有 ${img}，尝试 pull（可能要几分钟）..."
    if "${eng}" pull "${img}" >/dev/null 2>&1; then
      rec_pass "vanblog 镜像拉取成功" "${img}"
    else
      rec_fail "vanblog 镜像可用" "${img} 本地没有、也拉不下来（先 build/pull，或用 --image 指定本机已有的）"
      assert_summary "演练结果"
      return 1
    fi
  fi

  step "起一次性栈（拆的时候不会碰到任何已有容器/卷）"
  DRILL_STARTED=1
  local base="http://127.0.0.1:${DRILL_HTTP_PORT}"

  # ── 5) mongo ──────────────────────────────────────────────────────────
  if ! "${eng}" network create "${net_name}" >/dev/null 2>&1; then
    rec_fail "建得起专用网络" "${eng} network create ${net_name} 失败"
    say "${yellow}（rootless podman 没有 aardvark-dns 时容器名 DNS 不可用，所以后面用容器 IP 直连）${plain}"
    assert_summary "演练结果"
    return 1
  fi
  DRILL_NETWORKS+=("${net_name}")
  if ! "${eng}" run -d --name "${DRILL_MONGO_NAME}" --network "${net_name}" \
    -p "${DRILL_MONGO_PORT}:27017" \
    -v "${DRILL_VOLUMES[4]}:/data/db" \
    -e TZ=Asia/Shanghai \
    "${DRILL_MONGO_IMAGE}" >/dev/null 2>&1; then
    rec_fail "mongo 容器起得来" "${eng} run ${DRILL_MONGO_IMAGE} 失败；日志：$("${eng}" logs --tail 20 "${DRILL_MONGO_NAME}" 2>&1 | tr '\n' ' ' | head -c 300)"
    DRILL_CONTAINERS+=("${DRILL_MONGO_NAME}")
    assert_summary "演练结果"
    return 1
  fi
  DRILL_CONTAINERS+=("${DRILL_MONGO_NAME}")
  say "  mongo：${DRILL_MONGO_IMAGE}（${DRILL_MONGO_NAME}，宿主机 127.0.0.1:${DRILL_MONGO_PORT}）"

  # 取容器 IP：rootless podman 4.9 上容器名解析要 aardvark-dns（本机没装），
  # 而 `podman run --link` 也不支持 ⇒ 直连 IP + --add-host 两条路都留着（本机验证过的做法）
  local mongo_ip="" i
  for i in $(seq 1 30); do
    mongo_ip="$("${eng}" inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${DRILL_MONGO_NAME}" 2>/dev/null | head -1)"
    [[ -n "${mongo_ip}" ]] && break
    sleep 1
  done
  if [[ -z "${mongo_ip}" ]]; then
    rec_fail "拿得到 mongo 容器 IP" "inspect 30 秒都没有 IP（网络插件没给地址）；容器日志：$("${eng}" logs --tail 20 "${DRILL_MONGO_NAME}" 2>&1 | tr '\n' ' ' | head -c 300)"
    assert_summary "演练结果"
    return 1
  fi
  rec_pass "拿得到 mongo 容器 IP" "${mongo_ip}（不依赖容器名 DNS）"

  # 等 mongod 真能接受连接（不是"进程活着"）：镜像里有 mongosh 就 ping，没有就退化成等端口
  local mongo_ready=0
  for i in $(seq 1 40); do
    if "${eng}" exec "${DRILL_MONGO_NAME}" sh -c 'mongosh --quiet --eval "db.runCommand({ping:1}).ok" 2>/dev/null || mongo --quiet --eval "db.runCommand({ping:1}).ok" 2>/dev/null' 2>/dev/null | grep -q 1; then
      mongo_ready=1
      break
    fi
    sleep 2
  done
  if [[ ${mongo_ready} -eq 1 ]]; then
    rec_pass "mongod 就绪（能 ping 通）" "约 $((i * 2)) 秒"
  else
    rec_warn "mongod 就绪（能 ping 通）" "80 秒内没能用 mongosh/mongo ping 通（镜像里没有 shell？），继续试 vanblog 容器；日志尾部：$("${eng}" logs --tail 10 "${DRILL_MONGO_NAME}" 2>&1 | tr '\n' ' ' | head -c 200)"
  fi

  # ── 6) vanblog ────────────────────────────────────────────────────────
  if ! "${eng}" run -d --name "${DRILL_APP_NAME}" \
    --network "${net_name}" \
    --add-host "${DRILL_MONGO_NAME}:${mongo_ip}" \
    -p "${DRILL_HTTP_PORT}:80" \
    -e TZ=Asia/Shanghai \
    -e EMAIL="" \
    -e "VAN_BLOG_DATABASE_URL=mongodb://${mongo_ip}:27017/vanBlog?authSource=admin" \
    -v "${DRILL_VOLUMES[0]}:/app/static" \
    -v "${DRILL_VOLUMES[1]}:/var/log" \
    -v "${DRILL_VOLUMES[2]}:/root/.config/caddy" \
    -v "${DRILL_VOLUMES[3]}:/root/.local/share/caddy" \
    "${img}" >/dev/null 2>&1; then
    rec_fail "vanblog 容器起得来" "${eng} run ${img} 失败；日志：$("${eng}" logs --tail 30 "${DRILL_APP_NAME}" 2>&1 | tr '\n' ' ' | head -c 400)"
    DRILL_CONTAINERS+=("${DRILL_APP_NAME}")
    assert_summary "演练结果"
    return 1
  fi
  DRILL_CONTAINERS+=("${DRILL_APP_NAME}")
  say "  vanblog：${img}（${DRILL_APP_NAME}）→ ${base}"

  # ── 7) 等就绪（用健康端点；超时就打日志，因为"它超时了"这句话没有排障价值）──
  local health_body="${DRILL_TMP}/health.json" ready=0 waited=0 code=""
  while ((waited < DRILL_TIMEOUT)); do
    if http_get "${base}/api/public/health" "${health_body}" 10; then
      code="${HTTP_CODE}"
      if [[ "${code}" == "200" ]]; then
        ready=1
        break
      fi
    fi
    # 容器已经退出就别干等（镜像跑不起来时最典型）
    local running
    running="$("${eng}" inspect -f '{{.State.Running}}' "${DRILL_APP_NAME}" 2>/dev/null)"
    if [[ "${running}" == "false" ]]; then
      break
    fi
    sleep 3
    waited=$((waited + 3))
  done
  if [[ ${ready} -ne 1 ]]; then
    rec_fail "服务就绪（/api/public/health 200）" "等了 ${waited}/${DRILL_TIMEOUT} 秒，最后一次 HTTP ${code:-000}"
    drill_dump_app_logs "${eng}"
    say "${red}── mongo 容器日志（最后 20 行）──${plain}"
    "${eng}" logs --tail 20 "${DRILL_MONGO_NAME}" 2>&1 | sed 's/^/    /'
    say "\n  容器状态：$("${eng}" ps -a --filter "name=${DRILL_PREFIX}" --format '{{.Names}} {{.Status}}' 2>/dev/null | tr '\n' ' ')"
    assert_summary "演练结果"
    return 1
  fi
  # ⚠️ health 端点也是信封形状：{"statusCode":200,"data":{status,mongo,mongoStateText,…}}，
  #    字段在 data 底下（第一版按顶层取，结果一路显示 mongo=?，看不出探测到底说了什么）
  local health_json health_mongo health_state health_ping
  health_json="$(cat "${health_body}" 2>/dev/null)"
  health_mongo="$(json_get "${health_json}" data.mongo)"
  health_state="$(json_get "${health_json}" data.mongoStateText)"
  health_ping="$(json_get "${health_json}" data.mongoPingMs)"
  if [[ "${health_mongo}" == "up" ]]; then
    rec_pass "服务就绪（/api/public/health 200）" "约 ${waited} 秒；mongo=up（${health_state:-?}，ping ${health_ping:-?}ms）"
  else
    rec_warn "服务就绪（/api/public/health 200）" "HTTP 200 但 mongo=${health_mongo:-?}（${health_state:-?}）：健康端点在库连不上时会回 503，这里读到 200 说明它认为库是通的"
  fi

  # ── 8) 恢复前必须是"未初始化"，否则这次演练什么都没证明 ─────────────────
  local meta_body="${DRILL_TMP}/meta-before.json"
  http_get "${base}/api/public/meta" "${meta_body}" 20 || true
  local pre_body
  pre_body="$(cat "${meta_body}" 2>/dev/null)"
  if [[ "${HTTP_CODE}" == "200" ]] && printf '%s' "${pre_body}" | grep -q '"statusCode":233'; then
    rec_pass "恢复前站点未初始化（233 信封）" "/api/public/meta → 200 且 statusCode=233，恢复接口才是开放的"
  elif [[ "${HTTP_CODE}" == "200" ]]; then
    rec_fail "恢复前站点未初始化（233 信封）" "站点已经是初始化状态，/api/admin/init/restore 会 403 ⇒ 演练证明不了恢复能成功（镜像里带了残留数据？）"
    assert_summary "演练结果"
    return 1
  else
    rec_warn "恢复前站点未初始化（233 信封）" "/api/public/meta → HTTP ${HTTP_CODE}（继续试恢复接口）"
  fi

  # ── 9) 真上传恢复（用户真正会走的那条路）──────────────────────────────
  step "POST /api/admin/init/restore（multipart 字段 file，匿名，${pretty}）"
  local restore_body="${DRILL_TMP}/restore.json" t0 t1 elapsed
  t0="$(date +%s)"
  local restore_ok=1
  http_probe POST "${base}/api/admin/init/restore" "${restore_body}" 3600 \
    -F "file=@${archive};filename=${upload_name};type=application/octet-stream" || restore_ok=0
  t1="$(date +%s)"
  elapsed=$((t1 - t0))
  local body
  body="$(cat "${restore_body}" 2>/dev/null)"

  if [[ ${restore_ok} -eq 0 ]]; then
    rec_fail "恢复请求送达" "curl 没能完成请求（HTTP ${HTTP_CODE}，${elapsed}s）—— 归档 ${pretty} 超过上传限额？caddy/反代超时？容器挂了？"
    drill_dump_app_logs "${eng}"
    assert_summary "演练结果"
    return 1
  fi

  # 信封的语义断言全在 drill_assert_restore_envelope 里（纯函数，可以不起容器就测）
  local env_rc=0
  drill_assert_restore_envelope "${HTTP_CODE}" "${body}" "${manifest}" "${elapsed}" "${pretty}" || env_rc=1
  # 后面结论要用到的数字，从断言函数设好的全局里取
  local d_secs="${DRILL_ENV_SECS}" d_init="${DRILL_ENV_INIT}" d_admin="${DRILL_ENV_ADMIN}"
  local c_articles="${DRILL_ENV_ARTICLES}" c_statics="${DRILL_ENV_STATICS}" c_users="${DRILL_ENV_USERS}"
  local c_visits="${DRILL_ENV_VISITS}" c_viewers="${DRILL_ENV_VIEWERS}" c_settings="${DRILL_ENV_SETTINGS}"
  local c_total="${DRILL_ENV_TOTAL}" r_docs="${DRILL_ENV_DOCS}" r_colls="${DRILL_ENV_COLLS}"
  if [[ ${env_rc} -ne 0 ]]; then
    drill_dump_app_logs "${eng}"
    step "演练结论"
    assert_table
    assert_summary "演练结果"
    drill_verify_log_append drill "${archive}" fail "\"engine\":\"${eng}\",\"image\":\"${img}\",\"stage\":\"envelope\",\"httpCode\":\"${HTTP_CODE}\""
    return 1
  fi

  # ── 12) 探测恢复出来的站点（"接口说 59" 和 "站点真的服务 59" 是两个说法，后者才要紧）──
  step "探测恢复出来的站点（${base}）"
  local after_body="${DRILL_TMP}/meta-after.json" after_json=""
  if http_wait "${base}/api/public/meta" "200" "${after_body}" 90 3; then
    after_json="$(cat "${after_body}" 2>/dev/null)"
  fi

  # 归档里应该有多少篇公开文章（照 server 的公开过滤条件，从 NDJSON 逐行取字段算）
  local arts_ndjson cats_ndjson expect_line exp_public
  arts_ndjson="$(drill_archive_member "${archive}" "./db/vanBlog/articles.ndjson")"
  cats_ndjson="$(drill_archive_member "${archive}" "./db/vanBlog/categories.ndjson")"
  expect_line="$(drill_expected_articles "${arts_ndjson}" "${cats_ndjson}")"
  exp_public="$(printf '%s' "${expect_line}" | grep -oE 'public=[0-9]+' | cut -d= -f2)"

  drill_assert_meta "${HTTP_CODE}" "${after_json}" "${exp_public}"

  local list_body="${DRILL_TMP}/articles.json" site_total=""
  if http_wait "${base}/api/public/article?page=1&pageSize=1&toListView=true" "200" "${list_body}" 90 3; then
    site_total="$(json_get "$(cat "${list_body}" 2>/dev/null)" data.total)"
  fi
  drill_assert_article_total "${site_total}" "${expect_line}" "${m_articles:-?}" "${HTTP_CODE}"

  # 静态文件：从归档成员里挑一个真的去取（"清单说有 93 个" 和 "取得到" 是两件事）
  local st_body="${DRILL_TMP}/static.bin" st_code="" st_bytes=""
  if [[ -n "${probe_static}" ]]; then
    http_wait "${base}${probe_static}" "200" "${st_body}" 60 3 || true
    st_code="${HTTP_CODE}"
    st_bytes="${HTTP_BYTES}"
  fi
  drill_assert_static_fetch "${probe_static}" "${st_code}" "${st_bytes}"

  # 主题：这一条专门盯"上传的主题 CSS 从来不进备份"那个回归
  local active_body="${DRILL_TMP}/theme.json" css_body="${DRILL_TMP}/theme.css"
  local first_theme theme_url="" file_code="" file_bytes="" css_code="" css_bytes=""
  http_get "${base}/api/public/theme" "${active_body}" 20 || true
  first_theme="$(printf '%s\n' "${theme_members}" | head -1)"
  if [[ -n "${first_theme}" ]]; then
    theme_url="/${first_theme}"
    http_get "${base}${theme_url}" "${css_body}" 30 || true
    file_code="${HTTP_CODE}"
    file_bytes="${HTTP_BYTES}"
  fi
  if [[ -n "${first_theme}" ]] || [[ -n "$(json_get "$(cat "${active_body}" 2>/dev/null)" data.url)" ]]; then
    http_get "${base}/api/public/theme.css" "${css_body}" 30 || true
    css_code="${HTTP_CODE}"
    css_bytes="${HTTP_BYTES}"
  fi
  drill_assert_themes "${theme_members}" "$(cat "${active_body}" 2>/dev/null)" \
    "${css_code}" "${css_bytes}" "${theme_url}" "${file_code}" "${file_bytes}"

  # ── 13) 容器日志里的致命错误（BSON 主版本那个 400 就是从这儿看出来的）────
  local logs="${DRILL_TMP}/app.log"
  "${eng}" logs --tail 2000 "${DRILL_APP_NAME}" >"${logs}" 2>&1 || true
  drill_assert_logs "${logs}"

  # ── 14) 已初始化之后，这条匿名恢复接口必须被挡住（403）────────────────
  local again_body="${DRILL_TMP}/restore-again.json"
  http_probe POST "${base}/api/admin/init/restore" "${again_body}" 120 \
    -F "file=@${archive};filename=${upload_name};type=application/octet-stream" || true
  drill_assert_second_restore "${HTTP_CODE}" "$(cat "${again_body}" 2>/dev/null)"

  # ── 15) 结论 + 留痕 ───────────────────────────────────────────────────
  step "演练结论"
  say "  归档      ：$(basename "${archive}")（${pretty}，清单 ${MANIFEST_SOURCE}，备份时间 $(json_get "${manifest}" createdAt)）"
  say "  镜像/引擎 ：${img} / ${eng}（mongo ${DRILL_MONGO_IMAGE}）"
  say "  恢复      ：server ${d_secs:-?}s，端到端 ${elapsed}s，写入 ${r_docs:-?} 条 vanBlog 文档 / ${r_colls:-?} 个集合"
  say "  counts    ：articles=${c_articles:-?} statics=${c_statics:-?} users=${c_users:-?} visits=${c_visits:-?} viewers=${c_viewers:-?} settings=${c_settings:-?} total=${c_total:-?}"
  say "  站点      ：${base}（initialized=${d_init:-?}，adminUserFromArchive=${d_admin:-?}）"
  assert_table
  local rc=0
  assert_summary "演练结果" || rc=1
  drill_verify_log_append drill "${archive}" "$([[ ${rc} -eq 0 ]] && echo pass || echo fail)" \
    "\"engine\":\"${eng}\",\"image\":\"${img}\",\"seconds\":\"${d_secs:-}\",\"articles\":\"${c_articles:-0}\",\"initialized\":\"${d_init:-}\""
  return ${rc}
}

# ── 语义化校验（P2）───────────────────────────────────────────────────────
# 结构校验（完整性 / sha256 / 成员表）仍然由 vanblog.sh 的 verify_one_archive 做，
# 输出一个字不改（有测试钉着）；这里**只加**一层"这份归档恢复得回来吗"的判断。
# 解压工具的版本号（zstd 的 --version 会打一整行 "*** Zstandard CLI … ***" 横幅，
# 塞进一行结论里太吵，这里只留 v1.5.5 这样的版本串；拿不到就退化成第一行前 40 字）
drill_tool_version() {
  local t="$1" v
  v="$("${t}" --version 2>&1 | head -1)"
  local short
  short="$(printf '%s' "${v}" | grep -oE 'v?[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)"
  if [[ -n "${short}" ]]; then printf '%s %s' "${t}" "${short}"; else printf '%s' "${v:0:40}"; fi
}

verify_semantic_one() { # <archive> → 0 可恢复，1 会让恢复失败/降级
  local file="$1"
  local base
  base="$(basename "${file}")"
  local rc=0

  if declare -f verify_one_archive >/dev/null 2>&1; then
    verify_one_archive "${file}" || rc=1
  else
    echo -e "  ${red}FAIL${plain} ${base}：找不到 vanblog.sh 的 verify_one_archive（结构校验做不了）"
    rc=1
  fi

  local fmt
  fmt="$(archive_format_of "${file}")"
  if [[ -z "${fmt}" ]]; then
    echo -e "    ${red}语义 FAIL${plain} 认不出压缩格式，没法读清单"
    return 1
  fi

  # 解压工具：本机要有（否则连清单都读不出），镜像里也要有（否则恢复时 400"没有解压器"）
  local tool="${fmt}"
  case "${fmt}" in
  zstd) tool="zstd" ;;
  xz) tool="xz" ;;
  gzip) tool="gzip" ;;
  esac
  if command -v "${tool}" >/dev/null 2>&1; then
    echo -e "    语义 PASS 解压工具：本机有 ${tool}（$(drill_tool_version "${tool}")）；镜像里内置 zstd 与 xz，恢复侧不缺解压器"
  else
    echo -e "    ${red}语义 FAIL${plain} 解压工具：本机没有 ${tool} —— 读不出清单，也没法演练（恢复是在容器里做的，容器镜像自带 ${tool}）"
    rc=1
  fi

  local members
  members="$(drill_archive_members "${file}")"
  if [[ -z "${members}" ]]; then
    echo -e "    ${red}语义 FAIL${plain} 成员表读不出来，语义校验做不了（结构校验已经报过原因）"
    return 1
  fi

  # 成员路径安全：恢复前 server 会跑 assertRestorableArchive，绝对路径/.. 一律 400
  local unsafe
  unsafe="$(printf '%s\n' "${members}" | grep -E '^/|^[A-Za-z]:[\\/]|(^|/)\.\.(/|$)' | head -3)"
  if [[ -n "${unsafe}" ]]; then
    echo -e "    ${red}语义 FAIL${plain} 成员路径越界（恢复会 400 拒绝）：$(printf '%s' "${unsafe}" | tr '\n' ' ')"
    rc=1
  else
    echo -e "    语义 PASS 成员路径安全：没有绝对路径，也没有 .. 段（恢复侧的 assertRestorableArchive 会放行）"
  fi

  # 上传白名单：走 /api/admin/init/restore（初始化页/演练）时文件名必须匹配
  if drill_archive_name_ok "${base}"; then
    echo -e "    语义 PASS 文件名符合上传白名单：^vanblog-full-.+\\.tar\\.(zst|xz|gz)\$"
  else
    echo -e "    ${yellow}语义 WARN${plain} 文件名 ${base} 不在上传白名单里：走上传恢复（初始化页 / drill）会被 400 拒绝，改回 vanblog-full-<时间戳>.tar.${fmt} 就行（后台按名字恢复不受影响）"
  fi

  # 清单：从归档里读，读不到才退到旁边的副本（并明说退到了副本）
  local manifest
  if drill_archive_manifest "${file}"; then
    manifest="${MANIFEST_JSON}"
  fi
  if [[ -z "${manifest}" ]]; then
    echo -e "    ${red}语义 FAIL${plain} 读不出 manifest.json（归档里和旁边都没有）：恢复会 400「读不出这个备份的清单」"
    return 1
  fi
  if [[ "${MANIFEST_SOURCE}" == "sidecar" ]]; then
    # 只有旁边的副本、归档里没有 ⇒ 恢复时 server 读的是**归档里**那一份，它读不到就是 400
    echo -e "    ${red}语义 FAIL${plain} 归档里读不出 manifest.json，只有旁边的 .manifest.json 副本："
    echo -e "                 恢复走的是归档内部那份清单，读不到就是 400 ⇒ 这份归档**恢复不了**（副本再全也没用）"
    rc=1
  else
    echo -e "    语义 PASS 清单来自归档内部（恢复时 server 读的就是这一份）"
  fi

  local kind version created
  kind="$(json_get "${manifest}" kind)"
  version="$(json_get "${manifest}" version)"
  created="$(json_get "${manifest}" createdAt)"
  if [[ "${kind}" == "vanblog-full-backup" ]]; then
    echo -e "    语义 PASS 清单 kind=${kind}"
  else
    echo -e "    ${red}语义 FAIL${plain} 清单 kind=${kind:-（空）}，不是 vanblog-full-backup ⇒ 恢复侧的 isFullBackupManifest 直接不认（400）"
    rc=1
  fi
  if [[ "${version}" =~ ^[0-9]+$ ]]; then
    if ((version <= 1)); then
      echo -e "    语义 PASS 清单 version=${version}（本程序恢复接受 version <= 1）"
    else
      echo -e "    ${red}语义 FAIL${plain} 清单 version=${version} **比本程序新**：恢复会被明确拒绝（400「归档版本比本程序新」）。"
      echo -e "                 这份归档是在更新的 VanBlog 上做的，只能先升级站点再恢复 —— 别拿它当恢复点。"
      rc=1
    fi
  else
    echo -e "    ${red}语义 FAIL${plain} 清单 version 不是数字（${version:-空}）：isFullBackupManifest 不认"
    rc=1
  fi
  [[ -n "${created}" ]] && echo -e "    语义 NOTE 备份时间：${created}（归档文件 mtime：$(date -r "${file}" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)）"

  # 声明的库/集合是否都有对应的 .ndjson 成员（缺了恢复会跳过并在 notes 里记一条）
  local dbk collk ndjson missing="" declared=0 present=0
  while read -r dbk; do
    [[ -n "${dbk}" ]] || continue
    while read -r collk; do
      [[ -n "${collk}" ]] || continue
      declared=$((declared + 1))
      if printf '%s\n' "${members}" | grep -qE "(^|/)db/${dbk}/${collk}\.ndjson$"; then
        present=$((present + 1))
      else
        missing="${missing}${missing:+,}${dbk}/${collk}"
      fi
    done < <(json_keys "${manifest}" "databases.${dbk}.collections")
  done < <(json_keys "${manifest}" databases)
  if [[ ${declared} -eq 0 ]]; then
    echo -e "    ${red}语义 FAIL${plain} 清单里没有声明任何库/集合（databases 是空的）：恢复出来就是个空站"
    rc=1
  elif [[ -z "${missing}" ]]; then
    echo -e "    语义 PASS 清单声明的 ${declared} 个集合都有对应的 db/<库>/<集合>.ndjson"
  else
    echo -e "    ${yellow}语义 WARN${plain} 有 $((declared - present))/${declared} 个集合缺 .ndjson 成员：${missing}"
    echo -e "                 恢复**不会失败**（缺的集合被跳过、条数记 0，notes 里会写一条），但那些数据就是没了 —— 归档不完整"
  fi

  # 声明条数：非零 + 自洽
  local total_docs total_files total_colls sum_docs=0 sum_files=0 cv fk
  total_docs="$(json_get "${manifest}" totals.documents)"
  total_files="$(json_get "${manifest}" totals.files)"
  total_colls="$(json_get "${manifest}" totals.collections)"
  while read -r dbk; do
    [[ -n "${dbk}" ]] || continue
    while read -r collk; do
      [[ -n "${collk}" ]] || continue
      cv="$(json_get "${manifest}" "databases.${dbk}.collections.${collk}.count")"
      [[ "${cv}" =~ ^[0-9]+$ ]] && sum_docs=$((sum_docs + cv))
    done < <(json_keys "${manifest}" "databases.${dbk}.collections")
  done < <(json_keys "${manifest}" databases)
  local stk
  while read -r stk; do
    [[ -n "${stk}" ]] || continue
    fk="$(json_get "${manifest}" "static.${stk}.files")"
    [[ "${fk}" =~ ^[0-9]+$ ]] && sum_files=$((sum_files + fk))
  done < <(json_keys "${manifest}" static)
  if [[ "${sum_docs}" == "${total_docs:-x}" ]]; then
    echo -e "    语义 PASS 声明条数自洽：Σ集合 count=${sum_docs} == totals.documents"
  else
    echo -e "    ${yellow}语义 WARN${plain} 声明条数不自洽：Σ集合 count=${sum_docs} ≠ totals.documents=${total_docs:-（空）}（恢复路径不读 totals，所以不影响恢复，但导出侧算错了）"
  fi
  if [[ "${sum_files}" == "${total_files:-x}" ]]; then
    echo -e "    语义 PASS 静态文件数自洽：Σstatic.files=${sum_files} == totals.files"
  else
    echo -e "    ${yellow}语义 WARN${plain} 静态文件数不自洽：Σstatic.files=${sum_files} ≠ totals.files=${total_files:-（空）}"
  fi
  if [[ -n "${total_colls}" && "${total_colls}" != "${declared}" ]]; then
    echo -e "    ${yellow}语义 WARN${plain} totals.collections=${total_colls} 与声明的集合数 ${declared} 不一致"
  fi
  if [[ "${sum_docs}" == "0" && "${sum_files}" == "0" ]]; then
    if [[ "${VANBLOG_VERIFY_ALLOW_EMPTY:-0}" == "1" ]]; then
      echo -e "    ${yellow}语义 WARN${plain} 这份归档里一条文档、一个静态文件都没有（VANBLOG_VERIFY_ALLOW_EMPTY=1，降级为警告）"
    else
      echo -e "    ${red}语义 FAIL${plain} 这份归档里一条文档、一个静态文件都没有：恢复「成功」也是个空站。"
      echo -e "                 这正是「备份看着成功其实没备到东西」的形状（VANBLOG_VERIFY_ALLOW_EMPTY=1 可降级为警告）"
      rc=1
    fi
  elif [[ "${sum_docs}" == "0" ]]; then
    echo -e "    ${yellow}语义 WARN${plain} 数据库部分是空的（只有 ${sum_files} 个静态文件）：恢复出来没有任何内容/账号"
  else
    local arts
    arts="$(json_get "${manifest}" databases.vanBlog.collections.articles.count)"
    local users
    users="$(json_get "${manifest}" databases.vanBlog.collections.users.count)"
    echo -e "    语义 PASS 声明条数非零：共 ${sum_docs} 条文档（articles=${arts:-0}，users=${users:-0}）+ ${sum_files} 个静态文件"
    if [[ "${arts:-0}" == "0" ]]; then
      echo -e "    ${yellow}语义 WARN${plain} articles=0：一份没有文章的整站备份，恢复出来前台是空的（新建站点属正常）"
    fi
    if [[ "${users:-0}" == "0" ]]; then
      echo -e "    ${yellow}语义 WARN${plain} users=0：恢复后**没有管理员账号**，站点仍是未初始化状态（data.initialized=false），进不了后台"
    fi
  fi

  # 主题：这是"备份看着成功、恢复后皮肤悄悄丢了"的那个坑
  local theme_n
  theme_n="$(drill_archive_theme_members "${members}" | grep -c . || true)"
  local has_static
  has_static="$(printf '%s\n' "${members}" | grep -cE '(^|/)static/' || true)"
  if [[ "${theme_n}" =~ ^[0-9]+$ ]] && ((theme_n > 0)); then
    echo -e "    语义 PASS 上传的主题在归档里：static/themes/ 有 ${theme_n} 个文件（恢复后 /api/public/theme.css 才拿得到 CSS）"
  elif [[ "${has_static:-0}" =~ ^[0-9]+$ ]] && ((has_static > 0)); then
    echo -e "    ${yellow}语义 WARN${plain} 归档里**没有** static/themes/（其它静态树有 ${has_static} 个成员）："
    echo -e "                 这份归档早于「主题进整站备份」那个修复。真机恢复后，上传的主题文件会丢，"
    echo -e "                 而主题元数据在 settings/metas 里、照样恢复 ⇒ 后台显示主题存在且已启用，"
    echo -e "                 /api/public/theme.css 却拿不到 CSS，前台静默退回默认皮肤（零报错的数据丢失）。"
    echo -e "                 用当前版本重新导出一份归档即可（BACKUP_STATIC_FOLDERS 已含 themes）。"
  else
    echo -e "    语义 NOTE 归档里没有 static/ 树（空站点属正常），主题一项无从判断"
  fi

  # 索引文件：少了不影响恢复（server 会重建），只是信息
  local idx_n
  idx_n="$(printf '%s\n' "${members}" | grep -cE '(^|/)db/[^/]+/[^/]+\.indexes\.json$' || true)"
  echo -e "    语义 NOTE 索引文件 ${idx_n:-0} 个（缺了恢复会重建索引，只是慢一点/顺序不同）"

  if [[ ${rc} -eq 0 ]]; then
    echo -e "    ${green}语义结论：这份归档可以被当前版本恢复${plain}（要**证明**它，跑一次 ${DRILL_SELF_NAME} drill ${base}）"
  else
    echo -e "    ${red}语义结论：这份归档会让恢复失败或降级${plain}（原因见上面标 FAIL/WARN 的行）"
  fi
  return ${rc}
}

cmd_verify() {
  local -a targets=()
  local arg
  for arg in "$@"; do
    case "${arg}" in
    0 | --help | -h | help) continue ;;
    --*) say "${yellow}verify：忽略未知开关 ${arg}${plain}" ;;
    *) [[ -n "${arg}" ]] && targets+=("${arg}") ;;
    esac
  done
  local dir
  dir="$(full_backup_dir 2>/dev/null)"
  if [[ ${#targets[@]} -eq 0 ]]; then
    if [[ ! -d "${dir}" ]]; then
      say "${red}备份目录不存在：${dir}${plain}（还没备份过，或数据目录不在本机）"
      return 1
    fi
    local f
    while IFS= read -r f; do
      [[ -n "${f}" ]] || continue
      case "${f}" in
      *.manifest.json | *.sha256) continue ;;
      esac
      targets+=("${f}")
    done < <(ls -1t "${dir}"/vanblog-full-* 2>/dev/null)
    if [[ ${#targets[@]} -eq 0 ]]; then
      say "${yellow}${dir} 里没有可校验的 vanblog-full-* 归档${plain}（先跑 backup）"
      return 0
    fi
    echo -e "> 深度校验备份目录里的全部归档（${#targets[@]} 个）：${dir}"
  else
    echo -e "> 深度校验 ${#targets[@]} 个归档（结构校验沿用 vanblog.sh verify，再加一层语义）"
  fi
  local ok=0 bad=0 t resolved
  for t in ${targets[@]+"${targets[@]}"}; do
    if [[ -f "${t}" ]]; then
      resolved="${t}"
    elif [[ -f "${dir}/${t}" ]]; then
      resolved="${dir}/${t}"
    else
      echo -e "  ${red}FAIL${plain} ${t}：本地找不到（既不是路径，也不在 ${dir}/ 里）"
      bad=$((bad + 1))
      continue
    fi
    if verify_semantic_one "${resolved}"; then
      ok=$((ok + 1))
      drill_verify_log_append verify "${resolved}" pass ""
    else
      bad=$((bad + 1))
      drill_verify_log_append verify "${resolved}" fail ""
    fi
  done
  echo
  if [[ ${bad} -gt 0 ]]; then
    echo -e "> 深度校验完成：${green}OK ${ok}${plain}，${red}FAIL ${bad}${plain} —— FAIL 的归档别当恢复点"
    return 1
  fi
  echo -e "> 深度校验完成：${green}OK ${ok}${plain}，FAIL 0"
  return 0
}

# ── 验证留痕（P3）──────────────────────────────────────────────────────────
# "最近一次备份什么时候成功、验过没有"这件事不该靠翻日志。
# 这里在备份目录里追加一份 JSONL 台账（**append-only**，不覆盖，坏了也只影响这一条记录）。
# ⚠️ 文件名刻意不叫 vanblog-full-*：备份目录里凡是以 vanblog-full- 开头的文件，
#    都会被 verify 的枚举、prune 的计数（glob vanblog-full-*.tar.*）与 status 的统计
#    当成"一份归档"，多一个兄弟文件就会让保留策略多删一份真归档。
drill_verify_log_file() { printf '%s/vanblog-verify-log.jsonl' "$(full_backup_dir 2>/dev/null)"; }

drill_verify_log_append() { # <kind> <archive> <pass|fail> <额外 JSON 片段>
  local kind="$1" archive="$2" result="$3" extra="${4:-}"
  local logf dir
  logf="$(drill_verify_log_file)"
  dir="$(dirname "${logf}")"
  [[ -d "${dir}" ]] || mkdir -p "${dir}" 2>/dev/null || true
  [[ -d "${dir}" ]] || return 0
  local name size sha line
  name="$(basename "${archive}")"
  size="$(wc -c <"${archive}" 2>/dev/null || echo 0)"
  sha=""
  if [[ -f "${archive}.sha256" ]]; then
    sha="$(awk 'NR==1{print $1}' "${archive}.sha256" 2>/dev/null)"
  fi
  line="{\"kind\":$(json_string "${kind}"),\"archive\":$(json_string "${name}"),\"at\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"result\":$(json_string "${result}"),\"size\":${size:-0}"
  [[ -n "${sha}" ]] && line="${line},\"sha256\":$(json_string "${sha}")"
  [[ -n "${extra}" ]] && line="${line},${extra}"
  line="${line}}"
  if printf '%s\n' "${line}" >>"${logf}" 2>/dev/null; then
    chmod 0644 "${logf}" 2>/dev/null || true
    return 0
  fi
  echo -e "  ${yellow}写不进验证台账 ${logf}（不影响校验结果，只是 backup-status 看不到这条）${plain}"
  return 0
}

# 台账里某个归档最后一条记录（没有就空）
drill_verify_log_last() { # <archive 名或路径> [kind]
  local name logf kind="${2:-}"
  name="$(basename "$1")"
  logf="$(drill_verify_log_file)"
  [[ -f "${logf}" ]] || return 1
  local line
  line="$(grep -F "\"archive\":\"${name}\"" "${logf}" 2>/dev/null |
    { if [[ -n "${kind}" ]]; then grep -F "\"kind\":\"${kind}\""; else cat; fi; } | tail -1)"
  [[ -n "${line}" ]] || return 1
  printf '%s' "${line}"
}

# 最新归档 + 陈旧度（P3 的"cron 已经失败好几周"护栏）
drill_newest_archive() {
  local dir
  dir="$(full_backup_dir 2>/dev/null)"
  [[ -d "${dir}" ]] || return 1
  ls -1t "${dir}"/vanblog-full-* 2>/dev/null | grep -vE '\.(manifest\.json|sha256)$' | head -1
}

drill_age_days() { # <file> → 整数天（算不出打印 -1）
  local f="$1" now mt
  [[ -f "${f}" ]] || { printf -- '-1'; return 1; }
  now="$(date +%s)"
  mt="$(stat -c %Y "${f}" 2>/dev/null || stat -f %m "${f}" 2>/dev/null || echo "")"
  if [[ -z "${mt}" ]]; then printf -- '-1'; return 1; fi
  printf '%s' $(( (now - mt) / 86400 ))
}

cmd_backup_status() {
  local stale_days="${DRILL_STALE_DAYS}" strict=0 arg
  while [[ $# -gt 0 ]]; do
    arg="$1"; shift
    case "${arg}" in
    --stale-days) stale_days="${1:-${stale_days}}"; shift ;;
    --no-stale-check) stale_days=0 ;;
    --strict) strict=1 ;;
    0 | --*) : ;;
    esac
  done
  assert_reset
  step "备份状态（不翻日志就能回答：最近一次备份什么时候？验过没有？）"
  local dir newest
  dir="$(full_backup_dir 2>/dev/null)"
  say "  备份目录：${dir}"
  if [[ ! -d "${dir}" ]]; then
    rec_fail "备份目录存在" "${dir} 不存在 ⇒ 从来没有成功备份过"
    assert_summary "备份状态"
    return 1
  fi
  newest="$(drill_newest_archive)"
  local count
  count="$(ls -1 "${dir}"/vanblog-full-* 2>/dev/null | grep -vE '\.(manifest\.json|sha256)$' | grep -c . || true)"
  if [[ -z "${newest}" ]]; then
    rec_fail "有整站备份归档" "${dir} 里一份 vanblog-full-* 都没有（共 ${count:-0} 个匹配文件）"
    assert_summary "备份状态"
    return 1
  fi
  local name age size_pretty
  name="$(basename "${newest}")"
  age="$(drill_age_days "${newest}")"
  size_pretty="$(human_size "${newest}" 2>/dev/null)"
  [[ -n "${size_pretty}" ]] || size_pretty="$(human_bytes "$(wc -c <"${newest}" 2>/dev/null || echo 0)")"
  say "  最新归档：${yellow}${name}${plain}（${size_pretty:-?}，mtime $(date -r "${newest}" '+%Y-%m-%d %H:%M:%S' 2>/dev/null)，共 ${count} 份）"
  rec_pass "有整站备份归档" "${count} 份，最新 ${name}"

  # 陈旧度：cron 静默失败最典型的形状就是"最新归档越来越旧"
  case "${stale_days}" in
  '' | *[!0-9]*) stale_days=0 ;;
  esac
  if [[ "${stale_days}" == "0" ]]; then
    rec_note "陈旧度检查已关闭" "--stale-days 0 / VANBLOG_BACKUP_STALE_DAYS=0"
  elif [[ "${age}" == "-1" ]]; then
    rec_warn "最新归档不老于 ${stale_days} 天" "算不出 mtime"
  elif ((age > stale_days)); then
    rec_fail "最新归档不老于 ${stale_days} 天" "已经 ${age} 天了 ⇒ 定时备份很可能早就在失败（看 $(vanblog_cron_log_file 2>/dev/null || printf '%s' "${dir}/../vanblog-backup-cron.log")，然后手动跑一次 backup-verify）"
  else
    rec_pass "最新归档不老于 ${stale_days} 天" "${age} 天前"
  fi

  # sidecar 与台账
  [[ -f "${newest}.sha256" ]] && rec_pass "有 sha256 校验和记录" "$(basename "${newest}").sha256（verify 会比对）" ||
    rec_warn "有 sha256 校验和记录" "没有 .sha256（server 导出的归档本来就没有；脚本做的备份才会写）"
  [[ -f "${newest}.manifest.json" ]] && rec_note "有清单副本" "$(basename "${newest}").manifest.json（恢复读的是归档**里面**那份）"

  local vline dline
  if vline="$(drill_verify_log_last "${newest}" verify)"; then
    local vat vres
    vat="$(json_get "${vline}" at)"
    vres="$(json_get "${vline}" result)"
    if [[ "${vres}" == "pass" ]]; then
      rec_pass "最新归档验证过" "${vat}（result=pass）"
    else
      rec_fail "最新归档验证过" "${vat} 的验证结果是 ${vres}"
    fi
  else
    if [[ ${strict} -eq 1 ]]; then
      rec_fail "最新归档验证过" "台账里没有这份归档的验证记录（--strict）；跑一次 backup-verify 或 verify ${name}"
    else
      rec_warn "最新归档验证过" "没有验证记录（台账：$(drill_verify_log_file)）。备份存在 ≠ 能恢复；跑一次 ${green}backup-verify${plain} 或 ${green}verify ${name}${plain}"
    fi
  fi
  if dline="$(drill_verify_log_last "${newest}" drill)"; then
    local dat dres
    dat="$(json_get "${dline}" at)"
    dres="$(json_get "${dline}" result)"
    if [[ "${dres}" == "pass" ]]; then
      rec_pass "最新归档演练过（真恢复过一次）" "${dat}（result=pass，$(json_get "${dline}" engine)/$(json_get "${dline}" image)）"
    else
      rec_fail "最新归档演练过（真恢复过一次）" "${dat} 的演练结果是 ${dres}"
    fi
  else
    rec_note "这份归档还没演练过" "drill 才是「证明恢复得回来」的那一步：${DRILL_SELF_NAME} drill ${name}"
  fi

  # server 自己写的持久状态文件 <备份目录>/backup-status.json：**不需要 token** 就能读，
  # 所以它才是 cron 场景下"上次备份什么时候成功、server 自己验过没有"的首选来源。
  # 字段（version 1）：updatedAt / lastSuccessAt / lastSuccessName / lastSuccessBytes /
  #   lastVerifyMs / lastFailureAt / lastFailureStage('export'|'verify') / lastFailureName /
  #   lastFailureMessage / consecutiveFailures
  local sfile="${dir}/backup-status.json"
  if [[ -f "${sfile}" ]]; then
    local fj fsuccess fname fbytes fcons fat fstage fmsg fverify
    fj="$(cat "${sfile}" 2>/dev/null)"
    fsuccess="$(json_get "${fj}" lastSuccessAt)"
    fname="$(json_get "${fj}" lastSuccessName)"
    fbytes="$(json_get "${fj}" lastSuccessBytes)"
    fcons="$(json_get "${fj}" consecutiveFailures)"
    fat="$(json_get "${fj}" lastFailureAt)"
    fstage="$(json_get "${fj}" lastFailureStage)"
    fmsg="$(json_get "${fj}" lastFailureMessage)"
    fverify="$(json_get "${fj}" lastVerifyMs)"
    if [[ -n "${fsuccess}" ]]; then
      rec_pass "server 记着最近一次成功的备份（backup-status.json）" "${fsuccess}，${fname:-?}，$(human_bytes "${fbytes:-0}")"
      if [[ -n "${fname}" && "${fname}" != "${name}" ]]; then
        rec_warn "server 与文件系统说的是同一份归档" "server 记的是 ${fname}，而备份目录里最新的是 ${name} ⇒ 两边不一致（备份写到了别的目录？盘上这份是手工拷来的？server 那次之后又有人手工备过？）"
      fi
      if [[ -n "${fbytes}" && "${fbytes}" =~ ^[0-9]+$ ]]; then
        local fsize
        fsize="$(wc -c <"${newest}" 2>/dev/null || echo 0)"
        if [[ "${fname}" == "${name}" && "${fsize}" != "${fbytes}" ]]; then
          rec_warn "server 记的字节数与盘上的文件一致" "server ${fbytes} vs 盘上 ${fsize}（归档被截断过？不是同一份？）"
        fi
      fi
    else
      rec_warn "server 记着最近一次成功的备份（backup-status.json）" "lastSuccessAt 为空 ⇒ server 认为**从来没有成功过**，而盘上有 ${count} 份归档（最新 ${name}）"
    fi
    if [[ -n "${fverify}" && "${fverify}" != "null" ]]; then
      rec_pass "server 导出后自己验过这份归档" "lastVerifyMs=${fverify}（server 侧的导出后自检；脚本这边还会再独立验一遍）"
    else
      rec_note "server 的状态文件里没有 lastVerifyMs" "这个 server 版本还没有「导出后自检」；脚本这边的深度校验就是唯一那一层"
    fi
    if [[ "${fcons}" =~ ^[0-9]+$ ]] && ((fcons > 0)); then
      rec_fail "server 侧没有连续失败的备份" "consecutiveFailures=${fcons}，最后一次失败 ${fat:-?}（阶段 ${fstage:-?}）：${fmsg:-（无消息）}"
    else
      rec_pass "server 侧没有连续失败的备份" "consecutiveFailures=${fcons:-0}，lastFailureStage=${fstage:-null}"
    fi
  else
    rec_note "备份目录里没有 server 写的 backup-status.json" "server 版本较旧，或它把状态写在别处；此时只有文件系统 + 本脚本台账这两个说法（都可用，且都不需要 token）"
  fi

  # 可选：与 server 自己的备份状态对账（GET /api/admin/backup/full/status，AdminGuard）。
  # 有 VANBLOG_ADMIN_TOKEN 才做：cron 里通常**没有** token，而"最近一次备份什么时候成功"
  # 必须在没有 token 时也答得出来 —— 这正是文件系统 + 台账那一条路存在的理由，
  # 端点只是第二重说法。两边不一致本身就是发现（server 说成功、盘上没有新归档 = 写到了别处）。
  # ⚠️ 鉴权头是 `token: <jwt>`，不是 Authorization: Bearer（token.guard.ts 读的是 headers['token']）。
  # ⚠️ 绝不把 token 打进输出/台账。
  local token="${VANBLOG_ADMIN_TOKEN:-}"
  if [[ -n "${token}" ]]; then
    local sbase sbody="${DRILL_STATUS_TMP:-${TMPDIR:-/tmp}}/vanblog-backup-status.$$.json"
    sbase="$(vanblog_api_base 2>/dev/null)"
    if http_probe GET "${sbase}/api/admin/backup/full/status" "${sbody}" 20 -H "token: ${token}"; then
      local sjson slast sbytes sfail sstage scons sstale smsg
      sjson="$(cat "${sbody}" 2>/dev/null)"
      slast="$(json_get "${sjson}" data.lastSuccessName)"
      sbytes="$(json_get "${sjson}" data.lastSuccessBytes)"
      sfail="$(json_get "${sjson}" data.lastFailureAt)"
      sstage="$(json_get "${sjson}" data.lastFailureStage)"
      scons="$(json_get "${sjson}" data.consecutiveFailures)"
      sstale="$(json_get "${sjson}" data.stale)"
      smsg="$(json_get "${sjson}" data.staleMessage)"
      if [[ "${HTTP_CODE}" != "200" ]]; then
        rec_warn "server 的备份状态端点可读" "${sbase}/api/admin/backup/full/status → HTTP ${HTTP_CODE}（token 过期？server 版本没有这个端点？）；只用文件系统的说法"
      else
        rec_pass "server 的备份状态端点可读" "lastSuccessName=${slast:-（空）}，consecutiveFailures=${scons:-?}"
        if [[ -n "${slast}" && "${slast}" == "${name}" ]]; then
          rec_pass "server 与文件系统说的是同一份归档" "${slast}"
        elif [[ -n "${slast}" ]]; then
          rec_warn "server 与文件系统说的是同一份归档" "server 说最近成功的是 ${slast}，而备份目录里最新的是 ${name} ⇒ 两边不一致（备份写到别的目录了？盘上这份是手工拷来的？）"
        else
          rec_warn "server 与文件系统说的是同一份归档" "server 说从来没有成功过（lastSuccessName 为空），但盘上有 ${count} 份归档，最新是 ${name}"
        fi
        if [[ -n "${sbytes}" && "${sbytes}" =~ ^[0-9]+$ ]]; then
          local fsize
          fsize="$(wc -c <"${newest}" 2>/dev/null || echo 0)"
          if [[ "${fsize}" == "${sbytes}" ]]; then
            rec_pass "server 报的字节数与盘上的文件一致" "${sbytes} 字节"
          else
            rec_warn "server 报的字节数与盘上的文件一致" "server ${sbytes} vs 盘上 ${fsize}（归档被截断过？不是同一份？）"
          fi
        fi
        if [[ "${scons}" =~ ^[0-9]+$ ]] && ((scons > 0)); then
          rec_fail "server 侧没有连续失败的备份" "consecutiveFailures=${scons}，最后一次失败：${sfail:-?}（阶段 ${sstage:-?}）⇒ 定时备份正在失败"
        else
          rec_pass "server 侧没有连续失败的备份" "consecutiveFailures=${scons:-0}（lastFailureStage=${sstage:-null}）"
        fi
        if [[ "${sstale}" == "true" ]]; then
          rec_fail "server 侧不认为备份已陈旧" "${smsg:-stale=true}（阈值 VANBLOG_BACKUP_STALE_WARN_HOURS）"
        else
          rec_pass "server 侧不认为备份已陈旧" "stale=${sstale:-?}"
        fi
      fi
    else
      rec_warn "server 的备份状态端点可读" "${sbase} 连不上（站点没在跑？）；只用文件系统的说法"
    fi
    rm -f "${sbody}" 2>/dev/null || true
  else
    rec_note "没有 VANBLOG_ADMIN_TOKEN，跳过与 server 的对账" "文件系统 + 台账这条路不需要 token（cron 里就是这么用的）；给了 token 就会多一层「server 说的」与「盘上有的」交叉验证"
  fi

  # 台账本身
  local logf
  logf="$(drill_verify_log_file)"
  if [[ -f "${logf}" ]]; then
    say "  验证台账：${logf}（$(grep -c . "${logf}" 2>/dev/null || echo 0) 条记录，最后一条 $(tail -1 "${logf}" | head -c 160)）"
  else
    say "  验证台账：还没有（${logf}）—— backup-verify / verify / drill 会往里追加"
  fi
  local rc=0
  assert_summary "备份状态" || rc=1
  return ${rc}
}

cmd_backup_verify() {
  local -a bargs=()
  local stale_days="${DRILL_STALE_DAYS}" run_drill=0 arg
  while [[ $# -gt 0 ]]; do
    arg="$1"; shift
    case "${arg}" in
    --stale-days) stale_days="${1:-${stale_days}}"; shift ;;
    --no-stale-check) stale_days=0 ;;
    --drill) run_drill=1 ;;
    --format | --keep) bargs+=("${arg}" "${1:-}"); shift ;;
    --offline | --consistent | --api | --full | --verbose) bargs+=("${arg}") ;;
    0) : ;;
    --*) bargs+=("${arg}") ;;
    *) bargs+=("${arg}") ;;
    esac
  done
  assert_reset
  step "备份并立刻验证（backup + 语义校验 + 陈旧度）"
  if ! declare -f backup >/dev/null 2>&1; then
    say "${red}找不到 vanblog.sh 的 backup 函数（${VANBLOG_MAIN_SCRIPT} 没加载上）${plain}"
    return 2
  fi

  local dir
  dir="$(full_backup_dir 2>/dev/null)"
  local -a before=()
  if [[ -d "${dir}" ]]; then
    local f
    while IFS= read -r f; do
      [[ -n "${f}" ]] && before+=("$(basename "${f}")")
    done < <(ls -1 "${dir}"/vanblog-full-* 2>/dev/null | grep -vE '\.(manifest\.json|sha256)$')
  fi

  # ⚠️ 不捕获 backup 的输出：它可能要交互读账号密码（提示走 stderr、读走 stdin），
  #    命令替换会把提示一起吃掉，用户在 cron 之外跑就成了"卡住不动"。
  local rc=0
  backup 0 ${bargs[@]+"${bargs[@]}"} || rc=$?
  if [[ ${rc} -ne 0 ]]; then
    rec_fail "备份本身成功" "vanblog.sh 的 backup 返回 ${rc}（没有新归档可验；旧归档**没有**被删）"
    assert_summary "备份+验证"
    drill_verify_log_append backup-verify "${dir}/(none)" fail "\"stage\":\"backup\",\"rc\":${rc}"
    return 1
  fi

  # 找出这次新出现的归档（比解析输出稳：输出格式是给人看的，会改）
  local new="" f2
  if [[ -d "${dir}" ]]; then
    while IFS= read -r f2; do
      [[ -n "${f2}" ]] || continue
      local bn
      bn="$(basename "${f2}")"
      local seen=0 b
      for b in ${before[@]+"${before[@]}"}; do
        [[ "${b}" == "${bn}" ]] && { seen=1; break; }
      done
      if [[ ${seen} -eq 0 ]]; then
        case "${bn}" in
        *.manifest.json | *.sha256) continue ;;
        esac
        new="${f2}"
        break
      fi
    done < <(ls -1t "${dir}"/vanblog-full-* 2>/dev/null | grep -vE '\.(manifest\.json|sha256)$')
  fi
  if [[ -z "${new}" ]]; then
    # --offline 打的是 vanblog-backup-*.tar.gz，落在安装目录
    local off
    off="$(ls -1t "${VANBLOG_BASE_PATH:-/var/vanblog}"/vanblog-backup-*.tar.* 2>/dev/null | head -1)"
    if [[ -n "${off}" ]]; then
      new="${off}"
      rec_note "这次是离线目录快照（--offline）" "$(basename "${off}")；它不是整站备份，只能用离线方式恢复（停服解压），drill 不适用"
    fi
  fi
  if [[ -z "${new}" ]]; then
    rec_fail "备份产出了新归档" "backup 说成功了，但 ${dir} 里没有新出现的归档（磁盘满？目录不可写？名字不是 vanblog-full-*？）"
    assert_summary "备份+验证"
    drill_verify_log_append backup-verify "${dir}/(none)" fail '"stage":"locate"'
    return 1
  fi
  rec_pass "备份产出了新归档" "$(basename "${new}")（$(human_size "${new}" 2>/dev/null)）"

  step "立刻验证这份新归档（结构 + 语义）"
  local vrc=0
  verify_semantic_one "${new}" || vrc=1
  if [[ ${vrc} -eq 0 ]]; then
    rec_pass "新归档通过深度校验" "$(basename "${new}")"
    drill_verify_log_append backup-verify "${new}" pass '"stage":"verify"'
  else
    rec_fail "新归档通过深度校验" "$(basename "${new}") 结构或语义校验不过 ⇒ 这份备份**恢复不回来**，别把它当恢复点（旧的归档还在，先别清理）"
    drill_verify_log_append backup-verify "${new}" fail '"stage":"verify"'
  fi

  # 陈旧度：新备份刚做完，这一条几乎总是过的；它防的是"这次也没做成、最新还是很旧"
  case "${stale_days}" in
  '' | *[!0-9]*) stale_days=0 ;;
  esac
  if [[ "${stale_days}" != "0" ]]; then
    local age
    age="$(drill_age_days "${new}")"
    if [[ "${age}" != "-1" ]] && ((age > stale_days)); then
      rec_fail "最新归档不老于 ${stale_days} 天" "最新归档还是 ${age} 天前的（这次备份没产出新文件？）"
    else
      rec_pass "最新归档不老于 ${stale_days} 天" "${age} 天"
    fi
  fi

  if [[ ${run_drill} -eq 1 ]]; then
    step "顺手演练一次（--drill）"
    cmd_drill "${new}" || vrc=1
  fi

  local rc2=0
  assert_summary "备份+验证" || rc2=1
  if [[ ${rc2} -eq 0 ]]; then
    say "\n> 这份备份已经**验证过**（$(basename "${new}")）；要证明它真能恢复回来，跑一次："
    say "    ${green}${DRILL_SELF_NAME} drill ${new}${plain}"
  else
    say "\n> ${red}备份或验证失败${plain}：cron 里请用这条命令的退出码报警（非 0 = 这次没有可用的新恢复点）"
  fi
  return ${rc2}
}

# ── 入口 ──────────────────────────────────────────────────────────────────
drill_main() {
  local sub="${1:-help}"
  [[ $# -gt 0 ]] && shift
  case "${sub}" in
  drill) cmd_drill "$@" ;;
  verify | verify-deep | verify-semantic) cmd_verify "$@" ;;
  backup-verify | backup_verify) cmd_backup_verify "$@" ;;
  backup-status | backup_status | status) cmd_backup_status "$@" ;;
  help | --help | -h | "") drill_usage; return 0 ;;
  *)
    say "${red}未知子命令：${sub}${plain}"
    drill_usage
    return 2
    ;;
  esac
}

if [[ "${VANBLOG_DRILL_SKIP_MAIN:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

drill_main "$@"
exit $?

# ── 怎么接到 vanblog.sh 上 ────────────────────────────────────────────────
# scripts/vanblog.sh 与 docs/.vuepress/public/vanblog.sh 是**字节一致的双胞胎**，
# 改一个必须改另一个（有测试用 cmp -s 钉着）。所以本文件不改 vanblog.sh 一个字，
# 需要的转发由维护者加一次（两份都加，加完 `cmp -s` 必须仍然一致）。
# 在 vanblog.sh 底部那个 `case $1 in` 分发里加四条**单行** case（写成单行是为了让
# scripts/tests/docs-consistency.test.sh 里 `grep -oE '^  "[a-z_-]+"\)'` 那条
# "文档里出现的子命令脚本都得支持"的守卫能认出它们）：
#
#   "drill") shift; exec "$(dirname "${BASH_SOURCE[0]}")/vanblog-drill.sh" drill "$@" ;;
#   "verify-deep") shift; exec "$(dirname "${BASH_SOURCE[0]}")/vanblog-drill.sh" verify "$@" ;;
#   "backup-verify") shift; exec "$(dirname "${BASH_SOURCE[0]}")/vanblog-drill.sh" backup-verify "$@" ;;
#   "backup-status") shift; exec "$(dirname "${BASH_SOURCE[0]}")/vanblog-drill.sh" backup-status "$@" ;;
#
# ⚠️ 分发之前有 pre_check，它要求 root。演练**不需要** root（rootless podman 就能跑），
#    而且 root 下的 podman 用的是另一套镜像存储（root 看到的镜像和你平时看到的不是一套）。
#    所以非 root 场景请直接调 scripts/vanblog-drill.sh，别绕 vanblog.sh。
