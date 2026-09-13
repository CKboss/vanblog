#!/usr/bin/env bash
# 在本地构建 + 冒烟测试 VanBlog 镜像（不依赖 CI，也不需要 root）。
#
# 为什么需要这个：镜像里的问题（缺依赖、caddy 配置加载失败、Node 版本不匹配）**在本地
# 跑测试是发现不了的** —— 前面连着四轮都是用户装的时候才炸。这个脚本把「构建 → 起一套
# 临时容器 → 打几个请求 → 扫日志里的已知故障特征 → 拆掉」串成一条命令。
#
# 用法：
#   ./scripts/build-image-local.sh                      # 构建 + 冒烟测试（默认）
#   ./scripts/build-image-local.sh --build-only         # 只构建
#   ./scripts/build-image-local.sh --smoke-only         # 只测已有的镜像
#   ./scripts/build-image-local.sh --stage admin_builder # 只构建某一层（迭代时快得多）
#   ./scripts/build-image-local.sh --lowmem             # admin 用 1536MB 堆（小内存机器）
#
# 环境变量：
#   ENGINE=docker|podman   默认自动探测（docker daemon 连不上就用 podman，rootless 免 sudo）
#   IMAGE_TAG              默认 vanblog:local-test
#   SMOKE_HTTP_PORT        冒烟测试用的宿主机端口，默认 18080（避免和正在跑的站点撞）
#   SMOKE_KEEP             设 1 则测完不拆容器（自己进去看）
#   NPM_REGISTRY           默认 https://registry.npmmirror.com（国内快；海外换 npmjs）
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}" || exit 1

IMAGE_TAG="${IMAGE_TAG:-vanblog:local-test}"
SMOKE_HTTP_PORT="${SMOKE_HTTP_PORT:-18080}"
SMOKE_KEEP="${SMOKE_KEEP:-0}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
# Alpine 源：官方 dl-cdn 在国内经常 10 秒以上（构建会看起来卡死在 apk add），
# 默认走阿里云镜像；ALPINE_MIRROR=none 表示用官方源
ALPINE_MIRROR="${ALPINE_MIRROR-https://mirrors.aliyun.com/alpine}"
[[ "${ALPINE_MIRROR}" == "none" ]] && ALPINE_MIRROR=""
# node-gyp 头文件源：musl 下默认走 unofficial-builds.nodejs.org，国内连不上会让
# pnpm install 整个失败（tree-sitter / sharp 编译不了）。NODE_DIST_URL=none 可关掉。
NODE_DIST_URL="${NODE_DIST_URL-https://cdn.npmmirror.com/binaries/node}"
[[ "${NODE_DIST_URL}" == "none" ]] && NODE_DIST_URL=""
DO_BUILD=1
DO_SMOKE=1
STAGE=""
ADMIN_BUILD_SCRIPT="build"

red='\033[0;31m'; green='\033[0;32m'; yellow='\033[0;33m'; plain='\033[0m'
say() { echo -e "$*"; }
die() { echo -e "${red}$*${plain}" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
  --build-only) DO_SMOKE=0 ;;
  --smoke-only) DO_BUILD=0 ;;
  --stage) shift; STAGE="${1:-}" ;;
  --stage=*) STAGE="${1#--stage=}" ;;
  --lowmem) ADMIN_BUILD_SCRIPT="build:lowmem" ;;
  -h | --help)
    sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *) die "未知参数：$1（--help 看用法）" ;;
  esac
  shift
done

# ---------- 选引擎 ----------
pick_engine() {
  if [[ -n "${ENGINE:-}" ]]; then
    printf '%s' "${ENGINE}"
    return 0
  fi
  # docker daemon 连得上就用 docker（缓存与 BuildKit 更好）；连不上就退 podman
  # （podman 是 rootless 的，不需要 docker 组、不需要 sudo —— 本机 docker 组常常是空的）
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    printf 'docker'
  elif command -v podman >/dev/null 2>&1; then
    printf 'podman'
  else
    printf ''
  fi
}

ENGINE="$(pick_engine)"
[[ -n "${ENGINE}" ]] || die "既没有可用的 docker daemon，也没有 podman"
say "> 构建引擎：${yellow}${ENGINE}${plain}（ENGINE=docker|podman 可强制指定）"
command -v "${ENGINE}" >/dev/null 2>&1 || die "找不到 ${ENGINE}"

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
VERSION_LABEL="local@${GIT_SHA}"

# ---------- 构建 ----------
if [[ "${DO_BUILD}" == "1" ]]; then
  BUILD_ARGS=(
    --build-arg "VAN_BLOG_VERSIONS=${VERSION_LABEL}"
    # 构建期这个地址连不上是正常的（容器里还没有 server），前台会走兜底数据；
    # 但**必须是合法 URL**，空值会让 next build 在收集页面数据时抛 ERR_INVALID_URL
    --build-arg "VAN_BLOG_BUILD_SERVER=http://127.0.0.1:3000"
    --build-arg "VAN_BLOG_NPM_REGISTRY=${NPM_REGISTRY}"
    --build-arg "VAN_BLOG_ADMIN_BUILD_SCRIPT=${ADMIN_BUILD_SCRIPT}"
    --build-arg "VAN_BLOG_ALPINE_MIRROR=${ALPINE_MIRROR}"
    --build-arg "VAN_BLOG_NODE_DIST_URL=${NODE_DIST_URL}"
  )
  if [[ -n "${STAGE}" ]]; then
    say "> 只构建 stage ${yellow}${STAGE}${plain}（不打 tag，层缓存照样留着）"
    "${ENGINE}" build "${BUILD_ARGS[@]}" --target "${STAGE}" . || die "构建 ${STAGE} 失败"
    say "${green}stage ${STAGE} 构建成功${plain}"
    exit 0
  fi
  say "> 构建 ${yellow}${IMAGE_TAG}${plain}（版本 ${VERSION_LABEL}，首次约 15-40 分钟）"
  say "  admin 堆档位：${yellow}${ADMIN_BUILD_SCRIPT}${plain}，pnpm 源：${yellow}${NPM_REGISTRY}${plain}"
  say "  Alpine 源：${yellow}${ALPINE_MIRROR:-官方 dl-cdn}${plain}，node-gyp 头文件源：${yellow}${NODE_DIST_URL:-node-gyp 默认}${plain}"
  "${ENGINE}" build "${BUILD_ARGS[@]}" -t "${IMAGE_TAG}" . || die "镜像构建失败"
  say "${green}镜像构建成功${plain}：${IMAGE_TAG}"
  "${ENGINE}" images "${IMAGE_TAG}" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' 2>/dev/null ||
    "${ENGINE}" images "${IMAGE_TAG}" 2>/dev/null | head -3
fi

# ---------- 冒烟测试 ----------
[[ "${DO_SMOKE}" == "1" ]] || exit 0

SMOKE_NAME="vanblog-smoke-$$"
MONGO_NAME="vanblog-smoke-mongo-$$"
SMOKE_DATA="$(mktemp -d)"
FAILURES=0

cleanup() {
  if [[ "${SMOKE_KEEP}" == "1" ]]; then
    say "${yellow}> SMOKE_KEEP=1，容器保留：${SMOKE_NAME} / ${MONGO_NAME}（数据在 ${SMOKE_DATA}）${plain}"
    say "  看完自己拆：${ENGINE} rm -f ${SMOKE_NAME} ${MONGO_NAME} && rm -rf ${SMOKE_DATA}"
    return 0
  fi
  "${ENGINE}" rm -f "${SMOKE_NAME}" >/dev/null 2>&1
  "${ENGINE}" rm -f "${MONGO_NAME}" >/dev/null 2>&1
  rm -rf "${SMOKE_DATA}"
}
trap cleanup EXIT

check() { # check <描述> <条件命令...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    say "  ${green}✓${plain} ${label}"
  else
    say "  ${red}✗${plain} ${label}"
    FAILURES=$((FAILURES + 1))
  fi
}

say "> 冒烟测试：起一套临时 mongo + vanblog（宿主机端口 ${SMOKE_HTTP_PORT}）"
mkdir -p "${SMOKE_DATA}/mongo" "${SMOKE_DATA}/static" "${SMOKE_DATA}/log" \
  "${SMOKE_DATA}/caddy-config" "${SMOKE_DATA}/caddy-data"

# mongo 版本跟着编排模板走：全新数据目录，所以用脚本会挑的那个版本
MONGO_IMAGE="$(VANBLOG_SKIP_MAIN=1 VANBLOG_BASE_PATH="${SMOKE_DATA}" VANBLOG_DATA_PATH="${SMOKE_DATA}" \
  bash -c 'source ./scripts/vanblog.sh >/dev/null 2>&1; pick_mongo_image' 2>/dev/null)"
MONGO_IMAGE="${MONGO_IMAGE:-mongo:7.0}"
say "  mongo 镜像：${yellow}${MONGO_IMAGE}${plain}"

"${ENGINE}" run -d --name "${MONGO_NAME}" -v "${SMOKE_DATA}/mongo:/data/db" "${MONGO_IMAGE}" >/dev/null \
  || die "起 mongo 失败"
"${ENGINE}" run -d --name "${SMOKE_NAME}" \
  -e TZ=Asia/Shanghai \
  -e EMAIL="" \
  -e "VAN_BLOG_DATABASE_URL=mongodb://${MONGO_NAME}:27017/vanBlog?authSource=admin" \
  --link "${MONGO_NAME}:${MONGO_NAME}" \
  -v "${SMOKE_DATA}/static:/app/static" \
  -v "${SMOKE_DATA}/log:/var/log" \
  -v "${SMOKE_DATA}/caddy-config:/root/.config/caddy" \
  -v "${SMOKE_DATA}/caddy-data:/root/.local/share/caddy" \
  -p "${SMOKE_HTTP_PORT}:80" \
  "${IMAGE_TAG}" >/dev/null || die "起 vanblog 容器失败"

# 等 server 起来（首次要初始化数据库、生成 jwt、拉起前台，慢机器可能一两分钟）
say "  等待服务就绪（最多 180 秒）..."
ready=0
for _ in $(seq 1 60); do
  code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SMOKE_HTTP_PORT}/api/public/meta" 2>/dev/null || echo 000)"
  if [[ "${code}" == "200" ]]; then ready=1; break; fi
  sleep 3
done
if [[ "${ready}" != "1" ]]; then
  say "${red}  服务没有就绪（/api/public/meta 最后一次是 ${code}），下面是容器日志尾部：${plain}"
  "${ENGINE}" logs --tail 60 "${SMOKE_NAME}" 2>&1 | sed 's/^/    /'
  exit 1
fi
say "  ${green}服务已就绪${plain}"

BASE="http://127.0.0.1:${SMOKE_HTTP_PORT}"
say "> 请求关键路径"
for path in / /api/public/meta /admin /robots.txt /sitemap.xml /rss/feed.xml /post/1 /timeline; do
  code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "${BASE}${path}" 2>/dev/null || echo 000)"
  case "${code}" in
  200 | 301 | 302 | 308 | 404) # 404 也算通：说明 caddy → server/前台这条链路是活的
    say "  ${green}✓${plain} ${path} → ${code}" ;;
  *)
    say "  ${red}✗${plain} ${path} → ${code}"
    FAILURES=$((FAILURES + 1)) ;;
  esac
done

say "> 扫描容器日志里的已知故障特征"
LOGS="$("${ENGINE}" logs "${SMOKE_NAME}" 2>&1)"
# 这几条都是真实踩过的坑，任何一条出现都说明镜像有问题
declare -a BAD_PATTERNS=(
  "Cannot find module"                       # 幻影依赖（multer 那次）
  "caddy process exited"                     # caddy 配置加载失败（zerossl 那次）
  "loading initial config"                   # 同上，caddy 的原始报错
  "Reached heap limit"                       # 构建/运行期内存不足
  "ERR_INVALID_URL"                          # 空的 VAN_BLOG_SERVER_URL
  "Failed to collect page data"              # next build 期的同类问题
  "unhandledRejection"                       # 启动期未捕获
  "降级使用"                                  # entrypoint 走了 caddy 降级模板
)
for pat in "${BAD_PATTERNS[@]}"; do
  if printf '%s' "${LOGS}" | grep -qF -- "${pat}"; then
    say "  ${red}✗${plain} 日志里出现「${pat}」："
    printf '%s' "${LOGS}" | grep -F -- "${pat}" | head -3 | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
  else
    say "  ${green}✓${plain} 没有「${pat}」"
  fi
done

say "> 容器自身的健康状态"
status="$("${ENGINE}" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "${SMOKE_NAME}" 2>/dev/null)"
say "  health = ${yellow}${status}${plain}（starting 是正常的，刚起来还没到第一次探测）"
if [[ "${status}" == "unhealthy" ]]; then
  FAILURES=$((FAILURES + 1))
  say "  ${red}✗ 健康检查失败${plain}"
fi
check "容器仍在运行（没有崩溃重启）" "${ENGINE}" inspect -f '{{.State.Running}}' "${SMOKE_NAME}"
restarts="$("${ENGINE}" inspect -f '{{.RestartCount}}' "${SMOKE_NAME}" 2>/dev/null || echo 0)"
if [[ "${restarts}" != "0" ]]; then
  say "  ${red}✗ 重启过 ${restarts} 次（说明有进程在崩）${plain}"
  FAILURES=$((FAILURES + 1))
else
  say "  ${green}✓${plain} 没有重启过"
fi

say "> 优雅停机（验证 SIGTERM 转发，不该等满宽限期）"
stop_start=$(date +%s)
"${ENGINE}" stop -t 20 "${SMOKE_NAME}" >/dev/null 2>&1
stop_cost=$(( $(date +%s) - stop_start ))
if (( stop_cost < 15 )); then
  say "  ${green}✓${plain} ${stop_cost}s 内停下（说明信号被正确转发，不是等满宽限期被 SIGKILL）"
else
  say "  ${red}✗${plain} 停了 ${stop_cost}s（接近宽限期 = 信号没转发，进程被硬杀）"
  FAILURES=$((FAILURES + 1))
fi

echo
if [[ "${FAILURES}" -eq 0 ]]; then
  say "${green}冒烟测试全部通过${plain}：${IMAGE_TAG}"
  exit 0
fi
say "${red}冒烟测试有 ${FAILURES} 项失败${plain}"
say "看完整日志：${yellow}${ENGINE} logs ${SMOKE_NAME}${plain}（SMOKE_KEEP=1 可以保留容器）"
exit 1
