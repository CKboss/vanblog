#!/usr/bin/env bash

#========================================================
#   reset-waline.sh —— 重置 waline（评论区）全部管理员的密码
#   Github: https://github.com/CKboss/vanblog
#========================================================
#
# ⚠️ 为什么这个脚本**不再有内置默认密码**：
#   上游旧版把一段内容公开的 bcrypt 哈希（cost 8，可离线爆破，对应一个尽人皆知的弱密码）
#   和一个硬编码的占位管理员邮箱写死在这里：任何人跑一次，就把 waline 的**每一个**管理员行
#   静默改成公开仓库里的已知凭据，还顺手覆盖掉能用来找回密码的邮箱。
#   那是事故不是功能。本版本因此：
#     · 密码只能来自 --password / WALINE_NEW_PASSWORD，或 --generate 现场随机生成；
#       两者都没有 → **拒绝执行**（退出码 2），绝不回落成任何默认值；
#     · 随机密码只在成功改库之后打印**一次**，脚本自身不留存；
#     · 邮箱默认**不动**（--email 显式给了才改，避免覆盖掉找回密码用的邮箱）；
#     · 动库之前打印将要发生什么，并要求交互确认（--yes / WALINE_RESET_YES=1 跳过；
#       stdin 不可用时视为拒绝 —— cron 里绝不悬挂等待输入）。
#
# 用法：
#   scripts/reset-waline.sh --generate [--yes]        # 随机强密码，成功后打印一次
#   scripts/reset-waline.sh --password '<新密码>'      # ⚠️ 会进 shell 历史与 ps，优先用环境变量
#   WALINE_NEW_PASSWORD='<新密码>' scripts/reset-waline.sh
#
# 选项：
#   --generate            生成 24 位字母数字随机密码（约 143 bit），成功后打印一次
#   --password <pw>       指定新密码（至少 8 位；更短直接拒绝）
#   --email <addr>        同时改管理员邮箱（默认不改）
#   --container <name>    mongo 容器名（默认自动发现：第一个名字/镜像含 mongo 的运行中容器）
#   --engine docker|podman  容器引擎（默认自动探测：docker daemon 连得上用 docker，否则 podman）
#   --db <name>           waline 的库名（默认 $WALINE_DB 或 waline；compose 里对应 VAN_BLOG_WALINE_DB）
#   --cost <N>            bcrypt cost factor（默认 10，合法范围 4–31；上游旧版是 8，太低）
#   --yes | -y            跳过交互确认（自动化用；请清楚它会改**全部** administrator 行）
#   --help | -h           本页
#
# 环境变量：WALINE_NEW_PASSWORD / WALINE_RESET_YES=1 / WALINE_MONGO_CONTAINER /
#           WALINE_DB / WALINE_ENGINE
#
# 依赖：bash + docker 或 podman + 容器里的 mongosh/mongo（mongo:7.0 只有 mongosh，都认）。
#   bcrypt 哈希用本机**现成**的工具算（不新增安装）：python3-bcrypt → htpasswd(apache2-utils)
#   → 仓库 node_modules 里的 bcryptjs；一个都没有时拒绝执行并说明缺什么，
#   绝不退化成明文或已知哈希。产出的 $2b$/$2y$ 哈希 waline（bcryptjs）都能校验。
#   集合形状沿用本项目实际在用的：库 waline（可 --db），集合 Users，行条件 type='administrator'。

set -u

SELF_NAME="$(basename "${BASH_SOURCE[0]}")"

usage() {
  cat <<'USAGE'
reset-waline.sh —— 重置 waline 全部管理员的密码（不再有内置默认密码）

用法：
  reset-waline.sh --generate [--yes]
  reset-waline.sh --password '<新密码>' [--yes]
  WALINE_NEW_PASSWORD='<新密码>' reset-waline.sh

选项：
  --generate            随机生成 24 位强密码，成功后**只打印一次**
  --password <pw>       指定新密码（至少 8 位；命令行会进 shell 历史，优先用环境变量）
  --email <addr>        同时改管理员邮箱（默认不动邮箱）
  --container <name>    mongo 容器名（默认自动发现名字/镜像含 mongo 的运行中容器）
  --engine docker|podman  容器引擎（默认自动探测）
  --db <name>           waline 库名（默认 $WALINE_DB 或 waline）
  --cost <N>            bcrypt cost（默认 10，范围 4–31）
  --yes | -y            跳过交互确认（stdin 不可用且没给 --yes 时会拒绝，不悬挂）
  --help | -h           本页

环境变量：WALINE_NEW_PASSWORD / WALINE_RESET_YES=1 / WALINE_MONGO_CONTAINER / WALINE_DB / WALINE_ENGINE
退出码：0 成功；1 用户取消；2 参数/密码来源错误；3 本机没有 bcrypt 工具；4 没有引擎；
        5 找不到 mongo 容器；6 容器里没有 mongosh/mongo；7 没有 administrator 行；8 改库失败
USAGE
}

die() { # <rc> <消息>
  local rc="$1"; shift
  printf '%s\n' "$*" >&2
  exit "${rc}"
}

PW_SOURCE=""
PASSWORD="${WALINE_NEW_PASSWORD:-}"
[[ -n "${PASSWORD}" ]] && PW_SOURCE="环境变量 WALINE_NEW_PASSWORD"
GEN=0
EMAIL=""
CONTAINER="${WALINE_MONGO_CONTAINER:-}"
ENGINE="${WALINE_ENGINE:-}"
DB="${WALINE_DB:-waline}"
COST=10
ASSUME_YES="${WALINE_RESET_YES:-0}"

while [[ $# -gt 0 ]]; do
  arg="$1"; shift
  case "${arg}" in
  --generate) GEN=1 ;;
  --password) PASSWORD="${1:-}"; PW_SOURCE="--password 参数"; shift ;;
  --email) EMAIL="${1:-}"; shift ;;
  --container) CONTAINER="${1:-}"; shift ;;
  --engine) ENGINE="${1:-}"; shift ;;
  --db) DB="${1:-}"; shift ;;
  --cost) COST="${1:-}"; shift ;;
  --yes | -y) ASSUME_YES=1 ;;
  --help | -h) usage; exit 0 ;;
  *) usage >&2; die 2 "错误：不认识的参数 ${arg}" ;;
  esac
done

# ── 1) 密码来源：没有就拒绝（这就是"不再有默认密码"的落点）────────────────
if [[ -n "${PASSWORD}" ]]; then
  if [[ "${PW_SOURCE}" == "--password 参数" ]]; then
    echo "注意：命令行里的密码会留在 shell 历史与 ps 输出里；更稳的做法是 WALINE_NEW_PASSWORD='<密码>' ${SELF_NAME}" >&2
  fi
  if [[ "${#PASSWORD}" -lt 8 ]]; then
    die 2 "错误：密码太短（${#PASSWORD} 位 < 8 位）。这个脚本存在的意义就是消灭弱凭据，不接受弱密码。"
  fi
elif [[ "${GEN}" == "1" ]]; then
  PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24)"
  if [[ "${#PASSWORD}" -lt 20 ]]; then
    die 3 "错误：随机密码生成失败（/dev/urandom 不可用？），拒绝继续"
  fi
  PW_SOURCE="现场随机生成（24 位字母数字）"
else
  die 2 "错误：没有提供新密码，拒绝执行。

这个脚本**不再有内置默认密码**：旧版硬编码了一段公开在仓库里的 bcrypt 哈希
（对应尽人皆知的弱密码），谁跑一次就把所有 waline 管理员改成已知凭据。
请用下面任意一种方式提供密码：

  ${SELF_NAME} --generate        # 随机生成强密码，成功后只打印一次
  ${SELF_NAME} --password '<新密码>'
  WALINE_NEW_PASSWORD='<新密码>' ${SELF_NAME}   # 不进 shell 历史"
fi

# ── 2) bcrypt 哈希（cost 可调，默认 10；上游旧版是 8，太低）─────────────────
case "${COST}" in
'' | *[!0-9]*) die 2 "错误：--cost 必须是数字（4–31），得到 ${COST}" ;;
esac
if [[ "${COST}" -lt 4 || "${COST}" -gt 31 ]]; then
  die 2 "错误：--cost 超出 bcrypt 合法范围 4–31：${COST}"
fi

hash_password() { # <pw> <cost> → stdout 哈希；全部工具不可用返回 1
  local pw="$1" cost="$2" h bj
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import bcrypt' >/dev/null 2>&1; then
    h="$(python3 -c 'import bcrypt,sys; sys.stdout.write(bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt(rounds=int(sys.argv[2]))).decode())' "${pw}" "${cost}" 2>/dev/null)" &&
      [[ "${h}" == \$2* ]] && { printf '%s' "${h}"; return 0; }
  fi
  if command -v htpasswd >/dev/null 2>&1; then
    h="$(htpasswd -nbBC "${cost}" resetwaline "${pw}" 2>/dev/null | cut -d: -f2- | tr -d '\n')" &&
      [[ "${h}" == \$2* ]] && { printf '%s' "${h}"; return 0; }
  fi
  if command -v node >/dev/null 2>&1; then
    bj="$(find "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)/node_modules/.pnpm" \
      -maxdepth 4 -type d -name bcryptjs 2>/dev/null | head -1)"
    if [[ -n "${bj}" ]]; then
      h="$(NODE_PATH="${bj}/.." node -e 'const b=require("bcryptjs");process.stdout.write(b.hashSync(process.argv[1],Number(process.argv[2])))' "${pw}" "${cost}" 2>/dev/null)" &&
        [[ "${h}" == \$2* ]] && { printf '%s' "${h}"; return 0; }
    fi
  fi
  return 1
}

HASH="$(hash_password "${PASSWORD}" "${COST}")" || die 3 "错误：本机找不到任何能算 bcrypt 的工具（试过 python3-bcrypt、htpasswd、仓库 node_modules 里的 bcryptjs）。
不会退化成明文或已知哈希 —— 装一个再来（例如 python3 的 bcrypt 包，或 apache2-utils 的 htpasswd）。"

# ── 3) 引擎探测（与 drill 一致：docker daemon 连不上就用 podman）─────────────
if [[ -n "${ENGINE}" ]]; then
  command -v "${ENGINE}" >/dev/null 2>&1 || die 4 "错误：指定的引擎 ${ENGINE} 不在 PATH 里"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
  ENGINE=podman
else
  die 4 "错误：docker daemon 连不上，也没有可用的 podman；起一个引擎或用 --engine 指定"
fi

# ── 4) 找 mongo 容器（显式给了就用；否则按名字/镜像找第一个运行中的）────────
if [[ -z "${CONTAINER}" ]]; then
  CONTAINER="$("${ENGINE}" ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null |
    grep -i mongo | head -1 | cut -f1)"
fi
[[ -n "${CONTAINER}" ]] || die 5 "错误：没有找到运行中的 mongo 容器（--container 指定名字，或先把栈起起来）"
"${ENGINE}" inspect --type container "${CONTAINER}" >/dev/null 2>&1 ||
  die 5 "错误：容器 ${CONTAINER} 不存在（--container 指定正确的名字）"

# ── 5) 容器里的 mongo shell（mongo:7.0 只有 mongosh，老镜像是 mongo）─────────
MSHELL="$("${ENGINE}" exec "${CONTAINER}" sh -c 'command -v mongosh || command -v mongo' 2>/dev/null | head -1)"
[[ -n "${MSHELL}" ]] || die 6 "错误：容器 ${CONTAINER} 里既没有 mongosh 也没有 mongo，没法改库"

# ── 6) 只读预检：将要改多少行（0 行就拒绝，避免"成功"了一个空操作）──────────
ADMIN_N="$("${ENGINE}" exec "${CONTAINER}" "${MSHELL}" --quiet "${DB}" \
  --eval 'print(db.Users.countDocuments({ type: "administrator" }))' 2>/dev/null | tail -1)"
case "${ADMIN_N}" in
'' | *[!0-9]*) ADMIN_N="?" ;;
esac
if [[ "${ADMIN_N}" == "0" ]]; then
  die 7 "错误：库 ${DB} 的 Users 集合里没有 type='administrator' 的行 —— 没有可重置的对象。
（waline 的库名可用 --db 指定；compose 里对应 VAN_BLOG_WALINE_DB，默认 waline）"
fi

# ── 7) 确认门（改的是**全部**管理员行；stdin 不可用且没 --yes 时视为拒绝）───
echo "即将执行（引擎 ${ENGINE}，容器 ${CONTAINER}，库 ${DB}）："
echo "  · 把 Users 集合里全部 type='administrator' 的行（当前 ${ADMIN_N} 个）的 password 改成新 bcrypt 哈希（cost ${COST}）"
echo "  · 密码来源：${PW_SOURCE}"
if [[ -n "${EMAIL}" ]]; then
  echo "  · 同时把这些行的 email 改成：${EMAIL}"
else
  echo "  · 邮箱保持不动（--email 可以一并改）"
fi
if [[ "${ASSUME_YES}" != "1" ]]; then
  printf '确认请输入 yes（其它任何输入/直接回车都取消）：'
  if ! IFS= read -r ANSWER; then
    echo >&2
    die 1 "已取消：stdin 不可用（cron/管道场景请加 --yes 或 WALINE_RESET_YES=1；本脚本绝不悬挂等输入）"
  fi
  case "${ANSWER}" in
  yes | y | YES | Y) : ;;
  *) die 1 "已取消：输入的不是 yes（waline 管理员密码没有被改动）" ;;
  esac
fi

# ── 8) 生成 JS（mktemp + trap；文件里只有哈希，没有明文）────────────────────
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/waline-reset.XXXXXX")" || die 3 "错误：mktemp 失败"
trap 'rm -rf "${TMPD}" 2>/dev/null || true' EXIT INT TERM
JSF="${TMPD}/reset.js"
SET_LINE="password: '${HASH}'"
[[ -n "${EMAIL}" ]] && SET_LINE="${SET_LINE}, email: '${EMAIL}'"
printf 'var r = db.Users.updateMany({ type: "administrator" }, { $set: { %s } });\nprint("waline-reset matched=" + r.matchedCount + " modified=" + r.modifiedCount);\n' \
  "${SET_LINE}" >"${JSF}"
chmod 600 "${JSF}"

REMOTE_JS="/tmp/waline-reset-$$.js"
"${ENGINE}" cp "${JSF}" "${CONTAINER}:${REMOTE_JS}" >/dev/null 2>&1 ||
  die 8 "错误：往容器里拷 JS 失败（容器 ${CONTAINER} 还在跑吗？）"
OUT="$("${ENGINE}" exec "${CONTAINER}" "${MSHELL}" --quiet "${DB}" "${REMOTE_JS}" 2>&1)"
RC=$?
"${ENGINE}" exec "${CONTAINER}" rm -f "${REMOTE_JS}" >/dev/null 2>&1 || true
if [[ ${RC} -ne 0 ]]; then
  printf '%s\n' "${OUT}" >&2
  die 8 "错误：改库失败（rc=${RC}）；容器里那份临时 JS 已尽力删除"
fi

MOD_LINE="$(printf '%s\n' "${OUT}" | grep -o 'waline-reset matched=[0-9]* modified=[0-9]*' | tail -1)"
if [[ -z "${MOD_LINE}" ]]; then
  printf '%s\n' "${OUT}" >&2
  die 8 "错误：改库的输出形状不对（没看到 matched/modified 行）—— 请人工核对 ${DB}.Users"
fi
echo "${MOD_LINE}"
case "${MOD_LINE}" in
*"modified=0"*) echo "注意：matched 到的行一个都没被改动（新密码与旧值相同？）" ;;
esac

# ── 9) 随机密码只在这里出现一次（脚本与数据库里都不存明文）──────────────────
if [[ "${GEN}" == "1" ]]; then
  echo
  echo "────────────────────────────────────────────────────"
  echo "✅ 新的 waline 管理员密码（**只显示这一次**，任何地方都没有留存）："
  echo
  echo "    ${PASSWORD}"
  echo
  echo "   请立刻保存到密码管理器；丢了无法找回，只能重跑本脚本再重置一次。"
  echo "────────────────────────────────────────────────────"
else
  echo "✅ 密码已重置（来源：${PW_SOURCE}）。用 waline 后台任一管理员的邮箱 + 新密码登录即可。"
fi
exit 0
