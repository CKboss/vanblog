#!/bin/bash

#========================================================
#   System Required: CentOS 7+ / Debian 8+ / Ubuntu 16+ /
#     Arch 未测试
#   Description: vanblog 安装脚本
#   Github: https://github.com/mereithhh/van-blog
#========================================================

# 可以用环境变量覆盖（测试、以及想把安装目录放到别处的场景）；默认值不变。
VANBLOG_BASE_PATH="${VANBLOG_BASE_PATH:-/var/vanblog}"
VANBLOG_DATA_PATH="${VANBLOG_DATA_PATH:-${VANBLOG_BASE_PATH}/data}"
VANBLOG_DATA_PATH_RAW="${VANBLOG_DATA_PATH_RAW:-\/var\/vanblog\/data}"
VANBLOG_SCRIPT_VERSION="v0.4.0"

# ── 装的是哪一个 VanBlog ──────────────────────────────────────────────
# 装的是本分支（CKboss/vanblog 的 dev/dsh），**不是**官方的 mereith/van-blog:latest
# （那是上游 master，不含本分支的任何改动）。
#
# 默认走「拉镜像」：ghcr.io/ckboss/vanblog:dev-dsh 由 .github/workflows/publish-ghcr.yml
# 在 GitHub 的 runner 上构建并发布，本机只需要 docker pull —— 这样 1C1G 的小机器也能装
# （源码构建要跑 umi + next 的生产构建，峰值 1.5-4GB，小机器必挂）。
#
# 拉不到就**自动退回源码构建**（镜像还没发布 / 网络不通 ghcr / 架构没有对应镜像，
# 比如只发布了 amd64 而机器是 arm64）。也可以手动指定：
#   VANBLOG_INSTALL_MODE=image   ./vanblog.sh   # 只拉镜像，拉不到就报错
#   VANBLOG_INSTALL_MODE=source  ./vanblog.sh   # 只源码构建（改了代码想自己出一个镜像时）
#   VANBLOG_IMAGE_REF=<ref>      ./vanblog.sh   # 换镜像地址（自己的 registry / 特定 sha）
#   VANBLOG_USE_UPSTREAM_IMAGE=true ./vanblog.sh  # 用上游官方镜像（不含本分支改动）
# 想换分支/换仓库（只对源码构建有意义）：VANBLOG_BRANCH=xxx VANBLOG_REPO=xxx ./vanblog.sh
VANBLOG_REPO="${VANBLOG_REPO:-https://github.com/CKboss/vanblog.git}"
VANBLOG_BRANCH="${VANBLOG_BRANCH:-dev/dsh}"
VANBLOG_SRC_DIR="${VANBLOG_SRC_DIR:-${VANBLOG_BASE_PATH}/src}"
VANBLOG_IMAGE_TAG="${VANBLOG_IMAGE_TAG:-vanblog:dev-dsh}"
VANBLOG_USE_UPSTREAM_IMAGE="${VANBLOG_USE_UPSTREAM_IMAGE:-false}"
# 构建时写进镜像的 VAN_BLOG_VERSION（后台「关于」里能看到），形如 dev/dsh@1a2b3c4
VANBLOG_SRC_COMMIT=""

# ── 构建资源自适应（低配机器也能装）────────────────────────────────────
# docker build 默认会**并发**跑 admin / server / website 三个 stage，
# 每个都是重活（umi build 峰值 1.5-2GB、next build 2-4GB）。在 1C2G 的小机器上
# 三个一起跑必然 OOM，而且报错点在很后面（构建 10 分钟之后），排查成本极高。
# 所以构建前先量一量本机，再决定并发/串行与堆上限。
#   VANBLOG_BUILD_MODE=auto|fast|balanced|lowmem   默认 auto（按实测资源决定）
#     fast     并发构建，admin 堆上限 4096MB（≥7GB 内存且 ≥4 核）
#     balanced 串行构建，admin 堆上限 4096MB（3-7GB，或核少但内存够）
#     lowmem   串行构建，admin 堆上限 1536MB（<3.5GB 内存）
#   VANBLOG_FORCE_BUILD=true   内存太小本来会劝退，加这个就照跑（后果自负）
#   VANBLOG_NPM_REGISTRY=<url> 留空则自动探测（见 detect_npm_registry）
# 本分支镜像的地址（由 publish-ghcr workflow 推送）
VANBLOG_IMAGE_REF="${VANBLOG_IMAGE_REF:-ghcr.io/ckboss/vanblog:dev-dsh}"
# auto=先拉镜像，拉不到退回源码构建；image=只拉；source=只构建
VANBLOG_INSTALL_MODE="${VANBLOG_INSTALL_MODE:-auto}"
VANBLOG_BUILD_MODE="${VANBLOG_BUILD_MODE:-auto}"
VANBLOG_FORCE_BUILD="${VANBLOG_FORCE_BUILD:-false}"
VANBLOG_NPM_REGISTRY="${VANBLOG_NPM_REGISTRY:-}"
# 下面几个由探测函数填，只用于日志与测试
VANBLOG_HOST_CPUS=""
VANBLOG_HOST_MEM_MB=""
VANBLOG_BUILD_PARALLEL="true"
VANBLOG_ADMIN_BUILD_SCRIPT="build"
VANBLOG_BUILD_VIABLE="true"
VANBLOG_BUILD_REASON=""

# Ordered fallbacks: docs host (historical default), then GitHub raw, then jsDelivr.
# 本分支的 raw 地址排在最前面：模板里有本分支新增的可选环境变量注释，
# 上游那份没有；下载不到再依次退回上游文档站 / GitHub / jsDelivr。
COMPOSE_URL_FORK="https://raw.githubusercontent.com/CKboss/vanblog/${VANBLOG_BRANCH}/docker-compose/docker-compose-template.yml"
SCRIPT_URL_FORK="https://raw.githubusercontent.com/CKboss/vanblog/${VANBLOG_BRANCH}/scripts/vanblog.sh"
COMPOSE_URL="https://vanblog.mereith.com/docker-compose-template.yml"
COMPOSE_URL_GITHUB="https://raw.githubusercontent.com/Mereithhh/vanblog/master/docker-compose/docker-compose-template.yml"
COMPOSE_URL_JSDELIVR="https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/docker-compose/docker-compose-template.yml"
SCRIPT_URL="https://vanblog.mereith.com/vanblog.sh"
SCRIPT_URL_GITHUB="https://raw.githubusercontent.com/Mereithhh/vanblog/master/scripts/vanblog.sh"
SCRIPT_URL_JSDELIVR="https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/scripts/vanblog.sh"
GITHUB_URL="dn-dao-github-mirror.daocloud.io"
Get_Docker_URL="vanblog.mereith.com/docker.sh"
Get_Docker_Argu=" -s docker --mirror Aliyun"

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'
export PATH=$PATH:/usr/local/bin

os_arch=""


vanblog_compose() {
  (cd "${VANBLOG_BASE_PATH}" && docker-compose "$@")
}

get_compose_vanblog_image() {
  local compose_file="${VANBLOG_BASE_PATH}/docker-compose.yaml"
  if [[ ! -f "${compose_file}" ]]; then
    return 1
  fi
  awk '
    $1 == "vanblog:" { in_svc=1; next }
    in_svc && $1 ~ /^[a-zA-Z0-9_]+:$/ && $1 != "image:" { in_svc=0 }
    in_svc && $1 == "image:" { print $2; exit }
  ' "${compose_file}"
}

align_compose_latest_image() {
  local compose_file="${VANBLOG_BASE_PATH}/docker-compose.yaml"
  local current_image
  current_image=$(get_compose_vanblog_image)
  if [[ "${current_image}" == "registry.cn-beijing.aliyuncs.com/mereith/van-blog:latest" ]]; then
    echo -e "> 中国镜像 latest 可能未同步，改用 mereith/van-blog:latest"
    sed -i "s#registry.cn-beijing.aliyuncs.com/mereith/van-blog:latest#mereith/van-blog:latest#g" "${compose_file}"
  fi
}

get_vanblog_container_id() {
  vanblog_compose ps -q vanblog 2>/dev/null | head -n 1
}

get_container_image_id() {
  local cid="$1"
  if [[ -z "${cid}" ]]; then
    return 1
  fi
  docker inspect -f '{{.Image}}' "${cid}" 2>/dev/null
}

get_container_version() {
  local cid="$1"
  if [[ -z "${cid}" ]]; then
    return 1
  fi
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${cid}" 2>/dev/null \
    | awk -F= '$1 == "VAN_BLOG_VERSION" { print $2; exit }'
}

is_container_running() {
  local cid="$1"
  if [[ -z "${cid}" ]]; then
    return 1
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' "${cid}" 2>/dev/null)" == "true" ]]
}

image_in_use() {
  local image="$1"
  if [[ -z "${image}" ]]; then
    return 1
  fi
  [[ -n "$(docker ps -aq --filter "ancestor=${image}" 2>/dev/null)" ]]
}

remove_unused_image() {
  local image="$1"
  if [[ -z "${image}" ]]; then
    return 0
  fi
  if image_in_use "${image}"; then
    echo -e "> 旧镜像仍被容器使用，跳过删除"
    return 0
  fi
  echo -e "> 删除未使用的旧镜像"
  docker rmi "${image}" >/dev/null 2>&1 || true
}

pre_check() {

  mkdir -p ${VANBLOG_BASE_PATH}

  command -v curl >/dev/null 2>&1
  if [[ $? != 0 ]]; then
    echo "未找到 curl 命令"
    exit 1
  fi

  # check root
  [[ $EUID -ne 0 ]] && echo -e "${red}错误: ${plain} 必须使用root用户运行此脚本！\n" && exit 1

  ## os_arch
  if [[ $(uname -m | grep 'x86_64') != "" ]]; then
    os_arch="amd64"
  elif [[ $(uname -m | grep 'i386\|i686') != "" ]]; then
    echo "不支持 386 平台"
    exit 1
  elif [[ $(uname -m | grep 'aarch64\|armv8b\|armv8l') != "" ]]; then
    os_arch="arm64"
  elif [[ $(uname -m | grep 'arm') != "" ]]; then
    echo "不支持 arm 平台，目前只支持 arm64、amd64"
    exit 1
  elif [[ $(uname -m | grep 's390x') != "" ]]; then
    echo "不支持 s390x 平台，目前只支持 arm64、amd64"
    exit 1
  elif [[ $(uname -m | grep 'riscv64') != "" ]]; then
    echo "不支持 riscv64 平台，目前只支持 arm64、amd64"
    exit 1
  fi

      ## China_IP
    if [[ -z "${CN}" ]]; then
        if [[ $(curl -m 10 -s https://ipapi.co/json | grep 'China') != "" ]]; then
            echo "根据ipapi.co提供的信息，当前IP可能在中国"
            read -e -r -p "是否选用中国镜像完成安装? [Y/n] " input
            case $input in
                [yY][eE][sS] | [yY])
                    echo "使用中国镜像"
                    CN=true
                ;;

                [nN][oO] | [nN])
                    echo "不使用中国镜像"
                ;;
                *)
                    echo "使用中国镜像"
                    CN=true
                ;;
            esac
        fi
    fi

    if [[ -z "${CN}" ]]; then
        Get_Docker_URL="get.docker.com"
        GITHUB_URL="dn-dao-github-mirror.daocloud.io"
        Get_Docker_Argu=" "
        Docker_IMG="mereith/van-blog:latest"
    else
        echo "使用中国镜像"
        Get_Docker_URL="vanblog.mereith.com/docker.sh"
        GITHUB_URL="github.com"
        Get_Docker_Argu=" -s docker --mirror Aliyun"
        Docker_IMG="registry.cn-beijing.aliyuncs.com/mereith/van-blog:latest"
    fi

}

confirm() {
  if [[ $# > 1 ]]; then
    echo && read -e -p "$1 [默认$2]: " temp
    if [[ x"${temp}" == x"" ]]; then
      temp=$2
    fi
  else
    read -e -p "$1 [y/n]: " temp
  fi
  if [[ x"${temp}" == x"y" || x"${temp}" == x"Y" ]]; then
    return 0
  else
    return 1
  fi
}

compose_template_urls() {
  printf '%s\n' "${COMPOSE_URL_FORK}" "${COMPOSE_URL}" "${COMPOSE_URL_GITHUB}" "${COMPOSE_URL_JSDELIVR}"
}

script_urls() {
  printf '%s\n' "${SCRIPT_URL_FORK}" "${SCRIPT_URL}" "${SCRIPT_URL_GITHUB}" "${SCRIPT_URL_JSDELIVR}"
}

# ---------- 从源码构建本分支的镜像 ----------

use_upstream_image() {
  [[ "${VANBLOG_USE_UPSTREAM_IMAGE}" == "true" ]]
}

vanblog_src_template() {
  printf '%s' "${VANBLOG_SRC_DIR}/docker-compose/docker-compose-template.yml"
}

clone_or_update_source() {
  if ! command -v git >/dev/null 2>&1; then
    echo -e "正在安装 git"
    install_soft git
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo -e "${red}缺少 git，无法获取源码${plain}"
    return 1
  fi

  if [[ -d "${VANBLOG_SRC_DIR}/.git" ]]; then
    echo -e "> 更新源码 ${VANBLOG_REPO} (${VANBLOG_BRANCH})"
    git -C "${VANBLOG_SRC_DIR}" fetch --depth 1 origin "${VANBLOG_BRANCH}" || return 1
    # 用 FETCH_HEAD 而不是 pull：源码目录只当构建缓存用，
    # 里面若有本地改动（或上次构建留下的产物）会把 pull 卡住
    git -C "${VANBLOG_SRC_DIR}" checkout -f FETCH_HEAD || return 1
    # 只有默认目录才敢清未跟踪文件（用户指到别处时不能乱删东西）
    if [[ "${VANBLOG_SRC_DIR}" == "${VANBLOG_BASE_PATH}/src" ]]; then
      git -C "${VANBLOG_SRC_DIR}" clean -fdq >/dev/null 2>&1 || true
    fi
  else
    echo -e "> 克隆源码 ${VANBLOG_REPO} (${VANBLOG_BRANCH})"
    mkdir -p "$(dirname "${VANBLOG_SRC_DIR}")"
    rm -rf "${VANBLOG_SRC_DIR}"
    git clone --depth 1 --branch "${VANBLOG_BRANCH}" "${VANBLOG_REPO}" "${VANBLOG_SRC_DIR}" || return 1
  fi

  VANBLOG_SRC_COMMIT="$(git -C "${VANBLOG_SRC_DIR}" rev-parse --short HEAD 2>/dev/null)"
  echo -e "> 源码版本：${yellow}${VANBLOG_BRANCH}@${VANBLOG_SRC_COMMIT:-未知}${plain}"
  return 0
}

# 量一量本机：CPU 核数与可用内存（MB）。docker 自己有配额时以配额为准。
detect_host_resources() {
  local cpus mem_mb docker_mem_mb
  cpus="$(nproc 2>/dev/null || true)"
  if [[ -z "${cpus}" && -r /proc/cpuinfo ]]; then
    cpus="$(grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)"
  fi
  VANBLOG_HOST_CPUS="${cpus:-1}"

  mem_mb=0
  if [[ -r /proc/meminfo ]]; then
    # MemAvailable 比 MemFree 靠谱（含可回收的 page cache）
    mem_mb="$(awk '/^MemAvailable:/ {printf "%d", $2/1024; exit}' /proc/meminfo 2>/dev/null || echo 0)"
    if [[ -z "${mem_mb}" || "${mem_mb}" -eq 0 ]]; then
      mem_mb="$(awk '/^MemTotal:/ {printf "%d", $2/1024; exit}' /proc/meminfo 2>/dev/null || echo 0)"
    fi
  elif command -v free >/dev/null 2>&1; then
    mem_mb="$(free -m 2>/dev/null | awk '/^Mem:/ {print $7}')"
  fi

  # Docker Desktop / 有 cgroup 配额时，容器能用的内存比宿主机小得多
  docker_mem_mb="$(docker info --format '{{.MemTotal}}' 2>/dev/null || true)"
  if [[ "${docker_mem_mb}" =~ ^[0-9]+$ ]] && (( docker_mem_mb > 0 )); then
    docker_mem_mb=$((docker_mem_mb / 1024 / 1024))
    if (( docker_mem_mb < mem_mb )); then
      mem_mb="${docker_mem_mb}"
    fi
  fi
  VANBLOG_HOST_MEM_MB="${mem_mb:-0}"
}

# 纯判定：给定核数与可用内存，决定并发/串行、admin 用哪档堆、以及要不要劝退。
# 拆成独立函数是为了能被测试喂假数据（1 核 1GB 这种场景本机造不出来）。
classify_build_profile() {
  local cpus="${1:-1}" mem="${2:-0}"
  VANBLOG_BUILD_VIABLE="true"
  if (( mem > 0 && mem < 1800 )); then
    # 1.8GB 以下：umi/next 的生产构建各自都要 1GB 以上，基本没有成功可能。
    # 直接劝退比让人等 20 分钟再失败好（VANBLOG_FORCE_BUILD=true 可以强行继续）。
    VANBLOG_BUILD_VIABLE="false"
    VANBLOG_BUILD_PARALLEL="false"; VANBLOG_ADMIN_BUILD_SCRIPT="build:lowmem"
    VANBLOG_BUILD_REASON="可用内存仅 ${mem}MB：源码构建几乎必然 OOM"
  elif (( mem > 0 && mem < 3500 )); then
    VANBLOG_BUILD_PARALLEL="false"; VANBLOG_ADMIN_BUILD_SCRIPT="build:lowmem"
    VANBLOG_BUILD_REASON="可用内存 ${mem}MB（<3.5GB）：串行构建 + admin 堆降到 1536MB"
  elif (( cpus < 2 )); then
    VANBLOG_BUILD_PARALLEL="false"; VANBLOG_ADMIN_BUILD_SCRIPT="build"
    VANBLOG_BUILD_REASON="只有 ${cpus} 核：串行构建（并发只会互相抢 CPU，不会更快）"
  elif (( mem < 7000 || cpus < 4 )); then
    VANBLOG_BUILD_PARALLEL="false"; VANBLOG_ADMIN_BUILD_SCRIPT="build"
    VANBLOG_BUILD_REASON="可用内存 ${mem}MB / ${cpus} 核：串行构建，避免三个 stage 互相挤内存"
  else
    VANBLOG_BUILD_PARALLEL="true"; VANBLOG_ADMIN_BUILD_SCRIPT="build"
    VANBLOG_BUILD_REASON="可用内存 ${mem}MB / ${cpus} 核：并发构建（最快）"
  fi
}

# 按实测资源选档位；VANBLOG_BUILD_MODE 不是 auto 时听用户的。
choose_build_profile() {
  detect_host_resources
  local cpus="${VANBLOG_HOST_CPUS}" mem="${VANBLOG_HOST_MEM_MB}"

  VANBLOG_BUILD_VIABLE="true"
  if [[ "${VANBLOG_BUILD_MODE}" == "fast" ]]; then
    VANBLOG_BUILD_PARALLEL="true"; VANBLOG_ADMIN_BUILD_SCRIPT="build"
    VANBLOG_BUILD_REASON="VANBLOG_BUILD_MODE=fast（手动指定：并发构建，admin 堆 4096MB）"
  elif [[ "${VANBLOG_BUILD_MODE}" == "balanced" ]]; then
    VANBLOG_BUILD_PARALLEL="false"; VANBLOG_ADMIN_BUILD_SCRIPT="build"
    VANBLOG_BUILD_REASON="VANBLOG_BUILD_MODE=balanced（手动指定：串行构建，admin 堆 4096MB）"
  elif [[ "${VANBLOG_BUILD_MODE}" == "lowmem" ]]; then
    VANBLOG_BUILD_PARALLEL="false"; VANBLOG_ADMIN_BUILD_SCRIPT="build:lowmem"
    VANBLOG_BUILD_REASON="VANBLOG_BUILD_MODE=lowmem（手动指定：串行构建，admin 堆 1536MB）"
  else
    classify_build_profile "${cpus}" "${mem}"
  fi
}

# 实测哪个 pnpm 源快就用哪个：拿一个真实存在的小包当探针，比 time_total。
# 以前 admin 那层在 Dockerfile 里硬编码 registry.npmjs.org，国内直连只有 200-350KB/s，
# 是它 `pnpm i` 比 website 层慢 4 倍的原因；而写死 npmmirror 对海外用户又未必最快。
detect_npm_registry() {
  if [[ -n "${VANBLOG_NPM_REGISTRY}" ]]; then
    echo -e "> pnpm 源：${yellow}${VANBLOG_NPM_REGISTRY}${plain}（VANBLOG_NPM_REGISTRY 指定）"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    VANBLOG_NPM_REGISTRY="https://registry.npmmirror.com"
    echo -e "> pnpm 源：${yellow}${VANBLOG_NPM_REGISTRY}${plain}（没有 curl，用默认值）"
    return 0
  fi
  local candidates=("https://registry.npmmirror.com" "https://registry.npmjs.org")
  local url seconds ms best="" best_ms=-1
  echo -e "> 探测 pnpm 源延迟（各 8 秒超时）："
  for url in "${candidates[@]}"; do
    seconds="$(curl -sS -o /dev/null -m 8 -w '%{time_total}' "${url}/cross-env" 2>/dev/null || true)"
    if [[ -z "${seconds}" ]]; then
      echo -e "    ${url} -> ${red}不可达${plain}"
      continue
    fi
    ms="$(awk -v x="${seconds}" 'BEGIN { printf "%d", x * 1000 }')"
    echo -e "    ${url} -> ${ms}ms"
    if (( best_ms < 0 || ms < best_ms )); then
      best_ms="${ms}"; best="${url}"
    fi
  done
  if [[ -z "${best}" ]]; then
    best="https://registry.npmmirror.com"
    best_ms=""
    echo -e "${yellow}  两个源都探测失败（可能是构建机不通外网），用默认值 ${best}${plain}"
  fi
  VANBLOG_NPM_REGISTRY="${best}"
  if [[ -n "${best_ms}" ]]; then
    echo -e "> pnpm 源：${yellow}${VANBLOG_NPM_REGISTRY}${plain}（实测 ${best_ms}ms）"
  else
    echo -e "> pnpm 源：${yellow}${VANBLOG_NPM_REGISTRY}${plain}（未实测）"
  fi
}

build_vanblog_image() {
  if ! command -v docker >/dev/null 2>&1; then
    echo -e "${red}未找到 docker，无法构建镜像${plain}"
    return 1
  fi
  if [[ ! -f "${VANBLOG_SRC_DIR}/Dockerfile" ]]; then
    echo -e "${red}${VANBLOG_SRC_DIR} 里没有 Dockerfile，无法构建镜像${plain}"
    return 1
  fi

  choose_build_profile
  echo -e "> 本机：${yellow}${VANBLOG_HOST_CPUS} 核 / ${VANBLOG_HOST_MEM_MB}MB 可用内存${plain}"
  echo -e "> 构建档位：${yellow}${VANBLOG_BUILD_PARALLEL:+并发}${plain}${VANBLOG_BUILD_REASON}"
  if [[ "${VANBLOG_BUILD_VIABLE}" != "true" ]]; then
    if [[ "${VANBLOG_FORCE_BUILD}" != "true" ]]; then
      echo -e "${red}${VANBLOG_BUILD_REASON}${plain}"
      echo -e "${red}源码构建在这个配置上基本不可能成功（umi 与 next 的生产构建各自都要 1GB 以上）。${plain}"
      echo -e "两条路："
      echo -e "  1) ${green}VANBLOG_USE_UPSTREAM_IMAGE=true $0${plain}   # 用官方镜像（不含本分支改动，但能跑起来）"
      echo -e "  2) ${green}VANBLOG_FORCE_BUILD=true $0${plain}          # 我知道会失败，还是想试"
      echo -e "     （也可以换一台 ≥2GB 内存的机器构建，再把镜像 save/load 过去）"
      return 1
    fi
    echo -e "${yellow}按 VANBLOG_FORCE_BUILD=true 继续，但很可能在 admin 或 website 构建时 OOM${plain}"
  fi
  detect_npm_registry

  local version_arg="${VANBLOG_BRANCH}-${VANBLOG_SRC_COMMIT:-unknown}"
  # VAN_BLOG_BUILD_SERVER 必须传：Dockerfile 里它是 ARG → ENV VAN_BLOG_SERVER_URL，
  # 而前台 utils/loadConfig.ts 在**模块顶层** new URL(它)。不传就是空串，
  # next build 会在 "Collecting page data" 阶段抛 ERR_INVALID_URL 直接失败。
  # 构建期这个地址其实是连不上的（容器里还没有 server），页面会走兜底数据，
  # 运行时再由 runner 阶段的 ENV 覆盖成真实地址，所以这里给个合法值就够了。
  local build_server="${VANBLOG_BUILD_SERVER:-http://127.0.0.1:3000}"
  local -a build_args=(
    --build-arg "VAN_BLOG_VERSIONS=${version_arg}"
    --build-arg "VAN_BLOG_BUILD_SERVER=${build_server}"
    --build-arg "VAN_BLOG_NPM_REGISTRY=${VANBLOG_NPM_REGISTRY}"
    --build-arg "VAN_BLOG_ADMIN_BUILD_SCRIPT=${VANBLOG_ADMIN_BUILD_SCRIPT}"
  )

  if [[ "${VANBLOG_BUILD_PARALLEL}" == "true" ]]; then
    echo -e "> 构建镜像 ${yellow}${VANBLOG_IMAGE_TAG}${plain}（并发，约 5-20 分钟）"
    docker build "${build_args[@]}" -t "${VANBLOG_IMAGE_TAG}" "${VANBLOG_SRC_DIR}" || return 1
  else
    # 串行：一次只跑一个重活。先逐个 --target 构建三个 builder（不打 tag，
    # BuildKit 仍然会把层写进缓存），最后一次全量构建会全部命中缓存、只组装 runner。
    echo -e "> 构建镜像 ${yellow}${VANBLOG_IMAGE_TAG}${plain}（串行，约 15-40 分钟；小机器上更稳）"
    local stage
    for stage in admin_builder server_builder website_builder; do
      echo -e ">   [1/4] 单独构建 ${yellow}${stage}${plain}（其余 stage 此时不占资源）"
      docker build "${build_args[@]}" --target "${stage}" "${VANBLOG_SRC_DIR}" || return 1
    done
    echo -e ">   [4/4] 组装最终镜像（前三步命中缓存，很快）"
    docker build "${build_args[@]}" -t "${VANBLOG_IMAGE_TAG}" "${VANBLOG_SRC_DIR}" || return 1
  fi
  echo -e "${green}镜像构建完成${plain}：${VANBLOG_IMAGE_TAG}（${version_arg}）"
  return 0
}

# 安装与更新都走这里：源码模式下把 Docker_IMG 换成本地构建出来的 tag
# 拉本分支的镜像。返回非 0 表示拉不到（还没发布 / 不通 ghcr / 架构不匹配）。
pull_fork_image() {
  if ! command -v docker >/dev/null 2>&1; then
    echo -e "${red}未找到 docker，无法拉取镜像${plain}"
    return 1
  fi
  echo -e "> 拉取本分支镜像 ${yellow}${VANBLOG_IMAGE_REF}${plain}"
  # 把输出接住再打出来，这样才能按失败原因给出**具体**的下一步，
  # 而不是笼统一句"拉取失败"（ghcr 的包默认 private、架构不匹配，都是常见原因）
  local out rc
  out="$(docker pull "${VANBLOG_IMAGE_REF}" 2>&1)"
  rc=$?
  [[ -n "${out}" ]] && printf '%s\n' "${out}"
  if [[ ${rc} -eq 0 ]]; then
    return 0
  fi
  case "${out}" in
    *denied*|*unauthorized*|*authentication*)
      echo -e "${yellow}  看起来是权限问题：ghcr 的 package 默认是 private。${plain}"
      echo -e "${yellow}  去 https://github.com/CKboss/vanblog/pkgs/container/vanblog${plain}"
      echo -e "${yellow}  → Package settings → Danger Zone → Change visibility → Public${plain}"
      ;;
    *"no matching manifest"*|*"not found"*)
      echo -e "${yellow}  没有匹配本机架构（$(uname -m 2>/dev/null || echo 未知)）的镜像：目前只发布 linux/amd64。${plain}"
      echo -e "${yellow}  arm64 机器可以在 Actions 里手动触发 publish-ghcr 并把 platforms 填成 linux/arm64。${plain}"
      ;;
    *)
      echo -e "${yellow}  拉取失败（镜像可能还没发布，或网络到不了 ghcr.io）${plain}"
      ;;
  esac
  return 1
}

# 从本地构建切到拉镜像之后，旧的本地镜像会一直占着磁盘（~1.5GB）。
# 只提示、不自动删：删镜像是不可逆操作，而且用户可能还想切回去。
hint_stale_local_image() {
  command -v docker >/dev/null 2>&1 || return 0
  [[ "${Docker_IMG}" == "${VANBLOG_IMAGE_TAG}" ]] && return 0
  if docker image inspect "${VANBLOG_IMAGE_TAG}" >/dev/null 2>&1; then
    echo -e "> 检测到以前源码构建留下的本地镜像 ${yellow}${VANBLOG_IMAGE_TAG}${plain}（现在已改用 ${Docker_IMG}）"
    echo -e "  确认新容器正常后可以删掉它腾空间：${yellow}docker rmi ${VANBLOG_IMAGE_TAG}${plain}"
  fi
  return 0
}

# 源码构建（克隆 + 本地 docker build）。低配机器上很慢且可能 OOM，见 choose_build_profile。
build_from_source() {
  clone_or_update_source || return 1
  build_vanblog_image || return 1
  Docker_IMG="${VANBLOG_IMAGE_TAG}"
  return 0
}

prepare_vanblog_image() {
  if use_upstream_image; then
    echo -e "> 按 VANBLOG_USE_UPSTREAM_IMAGE=true 使用官方镜像 ${yellow}${Docker_IMG}${plain}（不含本分支改动）"
    return 0
  fi
  case "${VANBLOG_INSTALL_MODE}" in
    image)
      pull_fork_image || return 1
      Docker_IMG="${VANBLOG_IMAGE_REF}"
      ;;
    source)
      echo -e "> 按 VANBLOG_INSTALL_MODE=source 走源码构建"
      build_from_source || return 1
      ;;
    *)
      # auto：先试镜像（几秒钟的事），拉不到再退回源码构建（十几分钟起）
      if pull_fork_image; then
        Docker_IMG="${VANBLOG_IMAGE_REF}"
      else
        echo -e "> 退回${yellow}源码构建${plain}（首次约 15-40 分钟，取决于机器与网络）"
        build_from_source || return 1
      fi
      ;;
  esac
  echo -e "> 将使用镜像 ${yellow}${Docker_IMG}${plain}"
  hint_stale_local_image
  return 0
}

# 编排文件里的 image: 要和当前模式一致（例如从官方镜像切到本地构建，或反之）
ensure_compose_image() {
  local compose_file="${VANBLOG_BASE_PATH}/docker-compose.yaml"
  [[ -f "${compose_file}" ]] || return 0
  if grep -q "vanblog_image" "${compose_file}"; then
    sed -i "s|vanblog_image|${Docker_IMG}|g" "${compose_file}"
    return 0
  fi
  local current
  current="$(get_compose_vanblog_image)"
  if [[ -n "${current}" && "${current}" != "${Docker_IMG}" ]]; then
    echo -e "> 编排文件里的镜像 ${yellow}${current}${plain} 与当前模式不一致，改成 ${yellow}${Docker_IMG}${plain}"
    sed -i "s|image:[[:space:]]*${current//|/\\|}|image: ${Docker_IMG}|" "${compose_file}"
  fi
  return 0
}



is_valid_compose_template() {
  local file="$1"
  if [[ ! -s "${file}" ]]; then
    return 1
  fi
  grep -q "services:" "${file}" && grep -q "vanblog:" "${file}"
}

is_valid_vanblog_script() {
  local file="$1"
  if [[ ! -s "${file}" ]]; then
    return 1
  fi
  grep -q "VANBLOG_SCRIPT_VERSION" "${file}"
}

download_url_to_file() {
  local url="$1"
  local dest="$2"
  if command -v wget >/dev/null 2>&1; then
    wget -t 2 --no-check-certificate -T 10 -O "${dest}" "${url}" >/dev/null 2>&1
    return $?
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 10 --retry 2 -o "${dest}" "${url}" >/dev/null 2>&1
    return $?
  fi
  echo -e "${red}未找到 wget 或 curl，无法下载${plain}"
  return 1
}

download_with_fallback() {
  local dest="$1"
  local validator="$2"
  shift 2
  local url tmp
  tmp="${dest}.download.$$"
  mkdir -p "$(dirname "${dest}")"
  for url in "$@"; do
    echo -e "> 尝试下载: ${url}"
    rm -f "${tmp}"
    if download_url_to_file "${url}" "${tmp}" && "${validator}" "${tmp}"; then
      mv -f "${tmp}" "${dest}"
      echo -e "${green}下载成功: ${url}${plain}"
      return 0
    fi
    echo -e "${yellow}该地址不可用: ${url}${plain}"
    rm -f "${tmp}"
  done
  echo -e "${red}下载失败，已尝试全部地址${plain}"
  return 1
}

download_compose_template() {
  local dest="${1:-${VANBLOG_BASE_PATH}/docker-compose-template.yaml}"
  # 已经克隆过源码就直接用仓库里的模板：不依赖网络，也不会误用上游那份
  local local_template
  local_template="$(vanblog_src_template)"
  if [[ -s "${local_template}" ]] && is_valid_compose_template "${local_template}"; then
    cp "${local_template}" "${dest}" && return 0
  fi
  local urls=()
  local line
  while IFS= read -r line; do
    [[ -n "${line}" ]] && urls+=("${line}")
  done < <(compose_template_urls)
  download_with_fallback "${dest}" is_valid_compose_template "${urls[@]}"
}

download_script() {
  local dest="${1:-/tmp/vanblog.sh}"
  local urls=()
  local line
  while IFS= read -r line; do
    [[ -n "${line}" ]] && urls+=("${line}")
  done < <(script_urls)
  download_with_fallback "${dest}" is_valid_vanblog_script "${urls[@]}"
}

update_script() {
  echo -e "> 更新脚本"

  if ! download_script /tmp/vanblog.sh; then
    echo -e "${red}脚本获取失败，请检查本机能否连接文档站、GitHub 或 jsDelivr${plain}"
    return 1
  fi
  new_version=$(cat /tmp/vanblog.sh | grep "VANBLOG_SCRIPT_VERSION" | head -n 1 | awk -F "=" '{print $2}' | sed 's/\"//g;s/,//g;s/ //g')
  if [ ! -n "$new_version" ]; then
    echo -e "脚本获取失败，已下载的文件无法解析版本号"
    return 1
  fi
  echo -e "当前最新版本为: ${new_version}"
  mv -f /tmp/vanblog.sh ./vanblog.sh && chmod a+x ./vanblog.sh

  echo -e "3s后执行新脚本"
  sleep 3s
  clear
  exec ./vanblog.sh
  exit 0
}

before_show_menu() {
  echo && echo -n -e "${yellow}* 按回车返回主菜单 *${plain}" && read temp
  show_menu
}

install_base() {
  (command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && command -v wget >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1 && command -v getenforce >/dev/null 2>&1) ||
    (install_soft curl wget git unzip)
}

install_soft() {
  # Arch官方库不包含selinux等组件
  (command -v yum >/dev/null 2>&1 && yum makecache && yum install $* selinux-policy -y) ||
    (command -v apt >/dev/null 2>&1 && apt update && apt install $* selinux-utils -y) ||
    (command -v pacman >/dev/null 2>&1 && pacman -Syu $*) ||
    (command -v apt-get >/dev/null 2>&1 && apt-get update && apt-get install $* selinux-utils -y)
}

install_vanblog() {
  install_base

  echo -e "> 安装 VanBlog"

  # VanBlog 数据文件夹
  if [ ! -d "${VANBLOG_DATA_PATH}" ]; then
    mkdir -p $VANBLOG_DATA_PATH
  else
    echo "您可能已经安装过 VanBlog，重复安装可能会引发问题，请注意备份。"
    read -e -r -p "是否退出安装? [Y/n] " input
    case $input in
    [yY][eE][sS] | [yY])
      echo "退出安装"
      exit 0
      ;;
    [nN][oO] | [nN])
      echo "继续安装"
      ;;
    *)
      echo "退出安装"
      exit 0
      ;;
    esac
  fi

  # 不要 777：这个目录里有 MongoDB 数据文件、图床内容，以及 caddy 的证书**私钥**。
  # 容器内进程是 root，宿主机上 755 就够用了。
  chmod 755 "${VANBLOG_DATA_PATH}" 2>/dev/null || true
  find "${VANBLOG_DATA_PATH}" -type d -exec chmod 755 {} + 2>/dev/null || true

  command -v docker >/dev/null 2>&1
  if [[ $? != 0 ]]; then
    echo -e "正在安装 Docker"
    bash <(curl -sL https://${Get_Docker_URL}) ${Get_Docker_Argu} >/dev/null 2>&1
    systemctl enable docker.service
    systemctl start docker.service
    command -v docker >/dev/null 2>&1
    if [[ $? != 0 ]]; then
      echo -e "${red}Docker 安装失败${plain}"
      exit 0
    fi
    echo -e "${green}Docker${plain} 安装成功"
  fi


  # 只有在「没有 docker-compose 命令、但有 docker compose 子命令」时才建别名。
  # 旧实现只要 docker compose 可用就无条件写 /usr/local/bin/docker-compose，
  # 会把用户自己装的 docker-compose 覆盖掉。
  if ! command -v docker-compose >/dev/null 2>&1; then
    if [[ $(docker compose 2>/dev/null | grep 'Usage') != "" ]]; then
      echo -e "未找到 docker-compose ，尝试使用 docker compose 创建别名"
      echo 'docker compose "$@"' > /usr/local/bin/docker-compose
      chmod +x /usr/local/bin/docker-compose
      if ! command -v docker-compose >/dev/null 2>&1; then
        echo -e "${red}Docker Compose 别名创建失败${plain}，请手动安装 Docker Compose"
        return 1
      fi
      echo -e "${green}Docker Compose${plain} 别名创建成功"
    else
      echo -e "${red}未找到 docker compose（插件或独立二进制），请先安装${plain}"
      return 1
    fi
  fi

  # 源码模式：克隆本分支并本地构建镜像（Docker_IMG 会被换成本地 tag）。
  # 必须在 config 之前，因为 config 会把 Docker_IMG 写进编排文件。
  if ! prepare_vanblog_image; then
    echo -e "${red}安装失败：未能准备好 VanBlog 镜像${plain}"
    echo -e "如果只想先用官方镜像跑起来，可以： ${yellow}VANBLOG_USE_UPSTREAM_IMAGE=true ./vanblog.sh${plain}"
    if [[ $# == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi

  config 0
  if [[ $? != 0 ]]; then
    echo -e "${red}安装失败：未能下载编排文件${plain}"
    if [[ $# == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi
  if [[ $# == 0 ]]; then
    before_show_menu
  fi
}

selinux() {
  #判断当前的状态
  getenforce | grep '[Ee]nfor'
  if [ $? -eq 0 ]; then
    echo -e "SELinux是开启状态，正在关闭！"
    setenforce 0 &>/dev/null
    find_key="SELINUX="
    sed -ri "/^$find_key/c${find_key}disabled" /etc/selinux/config
  fi
}

config() {
  local skip_menu=0
  if [[ $# -gt 0 ]]; then
    skip_menu=1
  fi

  echo -e "> 修改配置"

  echo -e "正在下载编排文件"
  rm ${VANBLOG_BASE_PATH}/docker-compose-template.yaml >/dev/null 2>&1
  if ! download_compose_template "${VANBLOG_BASE_PATH}/docker-compose-template.yaml"; then
    echo -e "${red}下载编排文件失败，请检查本机能否连接文档站、GitHub 或 jsDelivr${plain}"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi

  # read -ep "请输入您想要安装的版本，默认不填为最新：" vanblog_version &&
  read -ep "请输入您的邮箱：" vanblog_email &&
    read -ep "请输入 http 端口（默认为 80）：" vanblog_http_port &&
    read -ep "请输入 https 端口（默认为 443）：" vanblog_https_port
  # echo "接下来您需要输入的域名对应着编排文件中的 VAN_BLOG_ALLOW_DOMAINS 变量（不含协议、不可包含通配符、多个域名通过英文逗号分隔）" &&
  # echo "如果用了 cdn 或图床，需要把图床或 cdn 的域名也加上" &&
  # read -ep "请输入您最终要绑定的域名（小写）:" vanblog_domains

  if [[ -z "${vanblog_email}" ]]; then
    echo -e "${red}除了端口外所有选项都不能为空${plain}"
    before_show_menu
    return 1
  fi
  # 邮箱要用来申请证书，写错了 caddy 会一直签发失败，所以这里就拦住
  if [[ ! "${vanblog_email}" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
    echo -e "${red}邮箱格式不正确：${vanblog_email}${plain}"
    before_show_menu
    return 1
  fi

  if [[ -z "${vanblog_http_port}" ]]; then
    vanblog_http_port=80
  fi
  if [[ -z "${vanblog_https_port}" ]]; then
    vanblog_https_port=443
  fi
  # 端口写错会生成一个起不来的编排文件，而且报错信息很难看懂
  for port_value in "${vanblog_http_port}" "${vanblog_https_port}"; do
    if [[ ! "${port_value}" =~ ^[0-9]+$ ]] || ((port_value < 1 || port_value > 65535)); then
      echo -e "${red}端口必须是 1-65535 之间的数字：${port_value}${plain}"
      before_show_menu
      return 1
    fi
  done
  # if [[ -z "${vanblog_version}" ]]; then
  #   vanblog_version="latest"
  # fi

  # 重新生成会**覆盖**用户自己加的 environment / 卷映射（比如 VAN_BLOG_CDN_URL、
  # VAN_BLOG_BACKUP_PATH），所以先把旧的存一份，并提示去哪里找
  if [[ -f "${VANBLOG_BASE_PATH}/docker-compose.yaml" ]]; then
    local compose_backup="${VANBLOG_BASE_PATH}/docker-compose.yaml.bak-$(date +"%Y%m%d%H%M%S")"
    cp "${VANBLOG_BASE_PATH}/docker-compose.yaml" "${compose_backup}" >/dev/null 2>&1 || true
    echo -e "> 已备份原有编排文件到 ${yellow}${compose_backup}${plain}（自定义的 environment / 卷映射需要重新加回来）"
  fi
  rm ${VANBLOG_BASE_PATH}/docker-compose.yaml >/dev/null 2>&1
  cp ${VANBLOG_BASE_PATH}/docker-compose-template.yaml ${VANBLOG_BASE_PATH}/docker-compose.yaml >/dev/null 2>&1
  sed -i "s/vanblog_data_path/${VANBLOG_DATA_PATH_RAW}/g" ${VANBLOG_BASE_PATH}/docker-compose.yaml
  # 用 | 作分隔符：邮箱里出现 / 或 & 时 s///.../g 会被截断或展开
  sed -i "s|vanblog_email|${vanblog_email}|g" ${VANBLOG_BASE_PATH}/docker-compose.yaml
  sed -i "s/vanblog_http_port/${vanblog_http_port}/g" ${VANBLOG_BASE_PATH}/docker-compose.yaml
  sed -i "s/vanblog_https_port/${vanblog_https_port}/g" ${VANBLOG_BASE_PATH}/docker-compose.yaml
  # sed -i "s/vanblog_domains/${vanblog_domains}/g" ${VANBLOG_BASE_PATH}/docker-compose.yaml
  # sed -i "s/vanblog_version/${vanblog_version}/g" ${VANBLOG_BASE_PATH}/docker-compose.yaml
  # 用 | 作分隔符：镜像名里带 / （官方镜像、或自定义 tag 如 ckboss/vanblog:dev-dsh）时，
  # s///.../ 会被截断。Docker_IMG 现在一律不转义斜杠。
  sed -i "s|vanblog_image|${Docker_IMG}|g" ${VANBLOG_BASE_PATH}/docker-compose.yaml
  ensure_compose_image

  mkdir -p $VANBLOG_DATA_PATH

  echo -e "配置 ${green}修改成功，请稍等重启生效${plain}"

  restart

  if [[ $# == 0 ]]; then
    before_show_menu
  fi
}

restart() {
  echo -e "> 重启服务"

  cd $VANBLOG_BASE_PATH
  # 不能带 -v：那会删除编排文件里的卷。现在数据是 bind mount 所以侥幸没事，
  # 但很多人会把 compose 改成命名卷，那时「重启」就等于删库。只有卸载才用 -v。
  docker-compose down --remove-orphans
  docker-compose up -d
  if [[ $? == 0 ]]; then
    echo -e "${green}VanBlog 重启成功${plain}"
    echo -e "默认管理面板地址：${yellow}域名:站点访问端口/admin${plain}"
  else
    echo -e "${red}重启失败，可能是因为启动时间超过了两秒，请稍后查看日志信息${plain}"
  fi

  if [[ $# == 0 ]]; then
    before_show_menu
  fi
}
update() {
  local skip_menu=0
  if [[ $# -gt 0 ]]; then
    skip_menu=1
  fi

  echo -e "> 更新服务"

  if [[ ! -f "${VANBLOG_BASE_PATH}/docker-compose.yaml" ]]; then
    echo -e "${red}未找到 ${VANBLOG_BASE_PATH}/docker-compose.yaml，无法更新${plain}"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi

  if use_upstream_image; then
    align_compose_latest_image
  fi

  # 先记录旧容器/镜像/版本：必须在新镜像准备好**之前**采集，
  # 否则「版本有没有变」的比较就失去意义（pull 之后读到的已经是新版本，
  # 于是永远显示"已经是最新版本"）。读的是**运行中容器**的镜像 id，
  # 先 pull 一个新 tag 不会影响它。
  local old_cid old_image old_version
  old_cid=$(get_vanblog_container_id)
  old_image=$(get_container_image_id "${old_cid}")
  old_version=$(get_container_version "${old_cid}")

  # ⚠️ 顺序很重要：**先把新镜像准备好，再停旧容器**。
  # 旧实现是先 down 再 pull/build —— 拉镜像要几十秒，源码构建要 15-40 分钟，
  # 整段时间站点是停的；构建失败时更是「白白停机一次，再把旧容器起回来」。
  # 现在准备失败就直接返回，正在跑的容器**全程不动**，停机时间只剩重启那几秒。
  if use_upstream_image; then
    echo -e "> 拉取最新官方镜像"
    if ! vanblog_compose pull vanblog; then
      echo -e "${red}拉取镜像失败，保持原容器不动${plain}"
      if [[ ${skip_menu} == 0 ]]; then
        before_show_menu
      fi
      return 1
    fi
  else
    # 本分支：默认 auto —— 先 docker pull ghcr 镜像，拉不到才退回克隆源码 + 本地构建
    echo -e "> 准备本分支镜像（${VANBLOG_INSTALL_MODE} 模式）"
    if ! prepare_vanblog_image; then
      echo -e "${red}更新失败：新镜像没准备好，保持原容器与原镜像不动${plain}"
      if [[ ${skip_menu} == 0 ]]; then
        before_show_menu
      fi
      return 1
    fi
    ensure_compose_image
  fi

  echo -e "> 停止并移除旧容器"
  # 同样不能带 -v：更新是常规操作，删卷等于删数据
  vanblog_compose down --remove-orphans
  if [[ $? != 0 ]]; then
    echo -e "${red}停止容器失败${plain}"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi

  echo -e "> 启动新容器"
  vanblog_compose up -d
  if [[ $? != 0 ]]; then
    echo -e "${red}启动失败，请稍后查看日志信息${plain}"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi

  local new_cid new_image new_version
  new_cid=$(get_vanblog_container_id)
  new_image=$(get_container_image_id "${new_cid}")
  new_version=$(get_container_version "${new_cid}")

  if ! is_container_running "${new_cid}"; then
    echo -e "${red}更新失败：vanblog 容器未在运行${plain}"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi

  if [[ -n "${old_image}" && "${new_image}" == "${old_image}" ]]; then
    # 镜像 id 没变通常就是「已经是最新版」，不是失败（旧实现报红色"更新失败"，
    # 让人以为出了故障）。真的拉取失败在上面 pull 那一步就已经拦下了。
    echo -e "${green}已经是最新版本${plain}（${yellow}${new_version:-未知}${plain}），容器已重启"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 0
  fi

  if [[ -n "${old_image}" ]]; then
    remove_unused_image "${old_image}"
  fi

  echo -e "${green}VanBlog 更新并重启成功${plain}"
  if [[ -n "${old_version}" || -n "${new_version}" ]]; then
    echo -e "版本：${yellow}${old_version:-未知} -> ${new_version:-未知}${plain}"
  fi
  if ! use_upstream_image && [[ -n "${VANBLOG_SRC_COMMIT}" ]]; then
    echo -e "源码：${yellow}${VANBLOG_BRANCH}@${VANBLOG_SRC_COMMIT}${plain}（镜像 ${VANBLOG_IMAGE_TAG}）"
  fi
  echo -e "默认管理面板地址：${yellow}域名:站点访问端口${plain}"

  if [[ ${skip_menu} == 0 ]]; then
    before_show_menu
  fi
  return 0
}

vanblog_data_dir() {
  echo "${VANBLOG_DATA_PATH:-${VANBLOG_BASE_PATH}/data}"
}

vanblog_caddy_dir() {
  echo "$(vanblog_data_dir)/caddy"
}

# Host-side HTTPS redirect leftovers: Caddy autosave / Caddyfile / https.json flags.
https_redirect_files() {
  local caddy_dir
  caddy_dir="$(vanblog_caddy_dir)"
  local data_dir
  data_dir="$(vanblog_data_dir)"
  find "${caddy_dir}" "${data_dir}" "${VANBLOG_BASE_PATH}" \
    \( -name 'autosave.json' -o -name 'caddy.json' -o -name 'Caddyfile' -o -name 'Caddyfile.*' -o -name 'https.json' \) \
    2>/dev/null
}

https_redirect_config_present() {
  local file
  while IFS= read -r file; do
    [[ -f "${file}" ]] || continue
    if grep -Eq 'http_redirect|"listener_wrappers"|redir[[:space:]].*https|"redirect"[[:space:]]*:[[:space:]]*true' "${file}"; then
      return 0
    fi
  done < <(https_redirect_files)
  return 1
}

strip_json_https_redirect() {
  local file="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "${file}" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    sys.exit(2)

changed = False


def strip_wrappers(obj):
    global changed
    if isinstance(obj, dict):
        wrappers = obj.get("listener_wrappers")
        if isinstance(wrappers, list):
            kept = [
                item
                for item in wrappers
                if not (
                    item == "http_redirect"
                    or (isinstance(item, dict) and item.get("wrapper") == "http_redirect")
                )
            ]
            if len(kept) != len(wrappers):
                changed = True
            if kept:
                obj["listener_wrappers"] = kept
            else:
                del obj["listener_wrappers"]
                changed = True
        elif "listener_wrappers" in obj:
            del obj["listener_wrappers"]
            changed = True
        if obj.get("redirect") is True and set(obj.keys()) <= {"redirect", "domains", "type"}:
            obj["redirect"] = False
            changed = True
        for value in list(obj.values()):
            strip_wrappers(value)
    elif isinstance(obj, list):
        for value in obj:
            strip_wrappers(value)


strip_wrappers(data)
if changed:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    sys.exit(0)
sys.exit(1)
PY
    return $?
  fi

  if grep -q 'http_redirect\|listener_wrappers\|"redirect"[[:space:]]*:[[:space:]]*true' "${file}"; then
    sed -i \
      -e 's/,"listener_wrappers":\[{"wrapper":"http_redirect"}\]//g' \
      -e 's/"listener_wrappers":\[{"wrapper":"http_redirect"}\],//g' \
      -e 's/"listener_wrappers":\[{"wrapper":"http_redirect"}\]//g' \
      -e 's/"redirect"[[:space:]]*:[[:space:]]*true/"redirect":false/g' \
      "${file}"
    return 0
  fi
  return 1
}

strip_caddyfile_https_redirect() {
  local file="$1"
  if ! grep -Eq 'http_redirect|redir[[:space:]].*https' "${file}"; then
    return 1
  fi
  # Drop force-HTTPS redir / http_redirect so the HTTP site block can serve again.
  sed -i \
    -e '/http_redirect/d' \
    -e '/redir[[:space:]].*https/d' \
    "${file}"
  return 0
}

clear_caddy_https_redirect_files() {
  local file first changed=0
  while IFS= read -r file; do
    [[ -f "${file}" ]] || continue
    first="$(tr -d ' \t\n\r' <"${file}" | head -c 1)"
    if [[ "${first}" == "{" || "${first}" == "[" ]]; then
      if strip_json_https_redirect "${file}"; then
        changed=1
      fi
    else
      if strip_caddyfile_https_redirect "${file}"; then
        changed=1
      fi
    fi
  done < <(https_redirect_files)
  # Known flag files created by older notes / manual toggles.
  local flag
  for flag in \
    "$(vanblog_caddy_dir)/force-https" \
    "$(vanblog_data_dir)/force-https" \
    "${VANBLOG_BASE_PATH}/force-https"; do
    if [[ -e "${flag}" ]]; then
      rm -f "${flag}"
      changed=1
    fi
  done
  [[ "${changed}" == "1" ]]
}

clear_https_setting_in_mongo() {
  local eval_js='db.getCollection("settings").deleteMany({type:"https"})'
  if vanblog_compose exec -T mongo mongo --quiet vanBlog --eval "${eval_js}"; then
    return 0
  fi
  if vanblog_compose exec -T mongo mongosh --quiet vanBlog --eval "${eval_js}"; then
    return 0
  fi
  if vanblog_compose exec -T vanblog node -e \
    'const {MongoClient}=require("mongodb");(async()=>{const c=new MongoClient("mongodb://mongo:27017/vanBlog?authSource=admin");await c.connect();const r=await c.db("vanBlog").collection("settings").deleteMany({type:"https"});console.log("deleted",r.deletedCount);await c.close();})().catch(e=>{console.error(e);process.exit(1);});'; then
    return 0
  fi
  if printf '\n' | vanblog_compose exec -T vanblog node /app/cli/resetHttps.js; then
    return 0
  fi
  return 1
}

clear_https_redirect_via_caddy_api() {
  vanblog_compose exec -T vanblog node -e \
    'const http=require("http");http.request({method:"DELETE",host:"127.0.0.1",port:2019,path:"/config/apps/http/servers/srv1/listener_wrappers"},res=>{process.exit(res.statusCode<400||res.statusCode===404?0:1);}).on("error",()=>process.exit(1)).end();'
}

reset_https() {
  local skip_menu=0
  if [[ $# -gt 0 ]]; then
    skip_menu=1
  fi

  echo -e "> 重置 https 设置（关闭强制跳转，恢复 HTTP / IP 访问）"

  if [[ ! -f "${VANBLOG_BASE_PATH}/docker-compose.yaml" ]]; then
    echo -e "${red}未找到 ${VANBLOG_BASE_PATH}/docker-compose.yaml，无法重置 https${plain}"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi

  echo -e "> 清除本机 Caddy / https 重定向配置"
  clear_caddy_https_redirect_files || true

  echo -e "> 清除数据库中的 https 强制跳转设置"
  local mongo_ok=0
  if clear_https_setting_in_mongo >/dev/null 2>&1; then
    mongo_ok=1
  else
    echo -e "> 尝试启动 mongo 后再清除 https 设置"
    vanblog_compose up -d mongo >/dev/null 2>&1 || true
    if clear_https_setting_in_mongo >/dev/null 2>&1; then
      mongo_ok=1
    fi
  fi
  if [[ ${mongo_ok} == 1 ]]; then
    echo -e "> 已删除 settings 中的 https 配置"
  else
    echo -e "${yellow}未能通过容器清除数据库 https 设置（容器可能未运行）${plain}"
  fi

  echo -e "> 关闭运行中的 Caddy http_redirect"
  local caddy_api_ok=0
  if clear_https_redirect_via_caddy_api >/dev/null 2>&1; then
    caddy_api_ok=1
    echo -e "> 已通过 Caddy API 关闭自动重定向"
  else
    echo -e "${yellow}未能调用 Caddy API，将重启容器使模板配置生效${plain}"
  fi

  echo -e "> 重启 vanblog 以恢复 HTTP / IP 访问"
  local restart_ok=0
  if vanblog_compose restart vanblog; then
    restart_ok=1
  elif vanblog_compose up -d; then
    restart_ok=1
  fi

  if [[ ${restart_ok} != 1 ]]; then
    echo -e "${red}重置失败：容器重启失败，请查看日志${plain}"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi

  if https_redirect_config_present; then
    echo -e "${red}重置失败：Caddy / https 配置中仍有强制跳转${plain}"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi

  if [[ ${mongo_ok} != 1 ]]; then
    echo -e "${red}重置失败：未能清除数据库 https 设置，重启后可能再次强制跳转到 https${plain}"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 1
  fi

  echo -e "${green}已重置 https 设置，HTTP 和 IP 访问应已恢复${plain}"
  echo -e "如浏览器仍跳转到 https，请清除本地缓存或改用 http://IP 访问。"

  if [[ ${skip_menu} == 0 ]]; then
    before_show_menu
  fi
  return 0
}

start_vanblog() {
  echo -e "> 启动 VanBlog"

  cd $VANBLOG_BASE_PATH && docker-compose up -d
  if [[ $? == 0 ]]; then
    echo -e "${green}VanBlog 启动成功${plain}"
  else
    echo -e "${red}启动失败，请稍后查看日志信息${plain}"
  fi

  if [[ $# == 0 ]]; then
    before_show_menu
  fi
}

stop_vanblog() {
  echo -e "> 停止 VanBlog"

  # 停止服务不该删卷（见 restart 里的说明）
  cd $VANBLOG_BASE_PATH && docker-compose down --remove-orphans
  if [[ $? == 0 ]]; then
    echo -e "${green}VanBlog 停止成功${plain}"
  else
    echo -e "${red}停止失败，请稍后查看日志信息${plain}"
  fi

  if [[ $# == 0 ]]; then
    before_show_menu
  fi
}

show_log() {
  echo -e "> 获取日志"

  cd $VANBLOG_BASE_PATH && docker-compose logs -f

  if [[ $# == 0 ]]; then
    before_show_menu
  fi
}

is_vanblog_backup_entry() {
  local name="$1"
  [[ "${name}" == vanblog-backup-* ]]
}

list_vanblog_backups() {
  local path name
  if [[ -z "${VANBLOG_BASE_PATH}" || ! -d "${VANBLOG_BASE_PATH}" ]]; then
    return 0
  fi
  for path in "${VANBLOG_BASE_PATH}"/vanblog-backup-*; do
    [[ -e "${path}" ]] || continue
    name="$(basename "${path}")"
    if is_vanblog_backup_entry "${name}"; then
      printf '%s\n' "${path}"
    fi
  done
}

remove_vanblog_install_files() {
  local compose data_path
  data_path="${VANBLOG_DATA_PATH}"
  if [[ -z "${data_path}" || "${data_path}" == "/" || "${data_path}" == "${VANBLOG_BASE_PATH}" ]]; then
    echo -e "${red}拒绝删除无效的数据目录：${data_path:-<empty>}${plain}"
    return 1
  fi
  if [[ -e "${data_path}" ]]; then
    echo -e "> 删除安装数据 ${data_path}"
    rm -rf "${data_path}"
  fi
  # 源码模式会在安装目录下留一份 git clone（构建缓存），卸载时一并清掉。
  # 只清「确实在安装目录下、且真的是我们克隆出来的」那个，避免用户把
  # VANBLOG_SRC_DIR 指到自己别的目录时被误删。
  local src_dir="${VANBLOG_SRC_DIR}"
  if [[ -n "${src_dir}" && "${src_dir}" == "${VANBLOG_BASE_PATH}"/* && -d "${src_dir}/.git" ]]; then
    echo -e "> 删除源码目录 ${src_dir}"
    rm -rf "${src_dir}"
  fi
  for compose in \
    docker-compose.yaml \
    docker-compose.yml \
    docker-compose-template.yaml \
    docker-compose-template.yml; do
    if [[ -e "${VANBLOG_BASE_PATH}/${compose}" ]]; then
      echo -e "> 删除 ${VANBLOG_BASE_PATH}/${compose}"
      rm -f "${VANBLOG_BASE_PATH}/${compose}"
    fi
  done
  if [[ -e "${VANBLOG_BASE_PATH}/force-https" ]]; then
    rm -f "${VANBLOG_BASE_PATH}/force-https"
  fi
}

uninstall_vanblog() {
  local skip_menu=0
  if [[ $# -gt 0 ]]; then
    skip_menu=1
  fi

  echo -e "> 卸载 VanBlog"
  echo -e "${yellow}将删除安装数据与编排文件（${VANBLOG_DATA_PATH} 以及 docker-compose*.yaml），并停止容器、移除镜像。${plain}"
  echo -e "${yellow}不会删除脚本备份 vanblog-backup-*，也不会删除安装目录以外的备份。${plain}"

  local backups
  backups="$(list_vanblog_backups || true)"
  if [[ -n "${backups}" ]]; then
    echo -e "${green}检测到将保留的备份：${plain}"
    echo "${backups}"
  fi
  echo -e "${red}安装数据删除后不可恢复（备份除外）。${plain}"

  local input
  read -e -r -p "确认卸载并删除安装数据（备份会保留）? [y/N] " input
  case $input in
  [yY][eE][sS] | [yY])
    echo "继续卸载"
    ;;
  *)
    echo "退出卸载"
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 0
    ;;
  esac

  if [[ -d "${VANBLOG_BASE_PATH}" ]]; then
    if [[ -f "${VANBLOG_BASE_PATH}/docker-compose.yaml" || -f "${VANBLOG_BASE_PATH}/docker-compose.yml" ]]; then
      (cd "${VANBLOG_BASE_PATH}" && docker-compose down -v) || true
    fi
    remove_vanblog_install_files || true
  fi
  docker rmi -f mereith/van-blog:latest >/dev/null 2>&1 || true
  clean_all

  if [[ -d "${VANBLOG_BASE_PATH}" ]]; then
    echo -e "${green}已卸载 VanBlog，安装数据已删除${plain}"
    backups="$(list_vanblog_backups || true)"
    if [[ -n "${backups}" ]]; then
      echo -e "${green}已保留备份：${plain}"
      echo "${backups}"
    else
      echo -e "${yellow}安装目录仍在（含非安装文件），未整目录删除：${VANBLOG_BASE_PATH}${plain}"
    fi
  else
    echo -e "${green}已卸载 VanBlog，安装目录已删除${plain}"
  fi

  if [[ ${skip_menu} == 0 ]]; then
    before_show_menu
  fi
  return 0
}

clean_all() {
  if [[ -z "${VANBLOG_BASE_PATH}" || "${VANBLOG_BASE_PATH}" == "/" || ! -d "${VANBLOG_BASE_PATH}" ]]; then
    return 0
  fi
  if [ -z "$(ls -A "${VANBLOG_BASE_PATH}")" ]; then
    rm -rf "${VANBLOG_BASE_PATH}"
  fi
}

is_gnu_tar() {
  tar --version 2>/dev/null | head -n 1 | grep -q 'GNU tar'
}

human_size() {
  local file="$1"
  if command -v du >/dev/null 2>&1; then
    du -h "${file}" 2>/dev/null | awk '{print $1}'
  fi
}

# 备份整个数据目录（图床 + MongoDB 数据 + 日志 + caddy 证书），产物放在安装目录下，
# 文件名形如 vanblog-backup-20260913-024500.tar.gz（卸载时会保留这些文件）。
#
# 用法：
#   ./vanblog.sh backup                  热备份（MongoDB 不停，速度最快，可能不完全一致）
#   ./vanblog.sh backup --consistent     先停 MongoDB 再打包（一致性最好，期间不可写）
#   VANBLOG_BACKUP_CONSISTENT=1 ./vanblog.sh backup    同 --consistent（适合定时任务）
backup() {
  echo -e "> 备份 vanblog"

  local consistent="${VANBLOG_BACKUP_CONSISTENT:-0}"
  local arg
  for arg in "$@"; do
    case "${arg}" in
    --consistent) consistent=1 ;;
    esac
  done

  if [[ ! -d "${VANBLOG_DATA_PATH}" ]]; then
    echo -e "${red}未找到数据目录 ${VANBLOG_DATA_PATH}，无法备份${plain}"
    return 1
  fi

  local name="vanblog-backup-$(date +"%Y%m%d%H%M%S").tar.gz"
  local dest="${VANBLOG_BASE_PATH}/${name}"
  local tar_opts=()
  if is_gnu_tar; then
    # 热备份时文件会变，GNU tar 会因此退出码 1 并刷屏警告，这里显式容忍
    tar_opts+=(--warning=no-file-changed)
  fi

  local mongo_stopped=0
  if [[ "${consistent}" == "1" ]]; then
    echo -e "> 一致性备份：先停止 MongoDB"
    if vanblog_compose stop mongo >/dev/null 2>&1; then
      mongo_stopped=1
      # 等 mongod 真正落盘退出，否则还是热备份
      sleep 3
    else
      echo -e "${yellow}停止 MongoDB 失败（可能没在运行），继续热备份${plain}"
    fi
  else
    echo -e "${yellow}提示：这是热备份，MongoDB 仍在运行。恢复时脚本会自动删掉 mongod.lock；${plain}"
    echo -e "${yellow}      追求一致性请用 ./vanblog.sh backup --consistent${plain}"
  fi

  local rc=0
  tar czf "${dest}" "${tar_opts[@]}" -C "${VANBLOG_BASE_PATH}" ./data || rc=$?

  if [[ ${mongo_stopped} == 1 ]]; then
    echo -e "> 重新启动 MongoDB"
    vanblog_compose start mongo >/dev/null 2>&1 ||
      echo -e "${red}MongoDB 启动失败，请手动执行 docker-compose start mongo${plain}"
  fi

  # GNU tar: 0=正常, 1=有文件在读取时被修改（热备份的正常现象）, >=2=真错误
  if ((rc > 1)) || { ((rc == 1)) && ! is_gnu_tar; }; then
    echo -e "${red}备份失败（tar 退出码 ${rc}）${plain}"
    rm -f "${dest}" >/dev/null 2>&1 || true
    return 1
  fi

  echo -e "${green}备份成功${plain}，文件名：${yellow}${name}${plain} 大小：$(human_size "${dest}") 路径：${VANBLOG_BASE_PATH}"
  if ((rc == 1)); then
    echo -e "${yellow}注意：打包过程中有文件发生变化（热备份的正常现象），归档仍然可用${plain}"
  fi
  return 0
}

# 从 vanblog.sh backup 生成的 tar.gz 恢复整个数据目录。
#
# 用法：
#   ./vanblog.sh restore                                  交互式（输入文件名 + 二次确认）
#   VANBLOG_RESTORE_FILE=/path/to/vanblog-backup-xxx.tar.gz \
#   VANBLOG_ASSUME_YES=1 ./vanblog.sh restore             非交互（适合脚本）
restore() {
  echo -e "> 恢复 vanblog"

  local path="${VANBLOG_RESTORE_FILE:-}"
  # 分发入口会传一个 0 表示「不进菜单」，别把它当成文件路径
  local arg
  for arg in "$@"; do
    if [[ -n "${arg}" && "${arg}" != "0" && "${arg}" != --* ]]; then
      path="${arg}"
    fi
  done
  if [[ -z "${path}" ]]; then
    read -e -r -p "请输入备份文件名（含路径）: " path
  fi

  if [[ -z "${path}" ]]; then
    echo -e "${red}输入为空${plain}"
    return 1
  fi
  if [[ ! -f "${path}" ]]; then
    echo -e "${red}找不到备份文件：${path}${plain}"
    return 1
  fi
  # 下载中断 / scp 没传完的包在这里就能发现，别等到解压一半才失败
  if command -v gzip >/dev/null 2>&1 && ! gzip -t "${path}" >/dev/null 2>&1; then
    echo -e "${red}${path} 不是完整的 gzip 压缩包（可能传输中断）${plain}"
    return 1
  fi

  echo -e "${red}恢复会用备份覆盖 ${VANBLOG_DATA_PATH} 下的现有数据（图床、数据库、日志、证书），不可撤销。${plain}"
  if [[ "${VANBLOG_ASSUME_YES:-0}" != "1" ]]; then
    local input
    read -e -r -p "确认恢复? [y/N] " input
    case $input in
    [yY][eE][sS] | [yY]) ;;
    *)
      echo "已取消恢复"
      return 0
      ;;
    esac
  fi

  echo -e "> 停止 vanblog 中..."
  stop_vanblog 0

  echo -e "> 覆盖解压到 ${VANBLOG_BASE_PATH} 中..."
  if ! tar xzf "${path}" -C "${VANBLOG_BASE_PATH}"; then
    echo -e "${red}解压失败，数据可能处于中间状态，请检查磁盘空间与备份文件${plain}"
    return 1
  fi

  # 热备份打出来的 MongoDB 数据目录带着 mongod.lock，不删掉 mongod 会拒绝启动
  # （表现是容器反复重启，日志里报 Unable to lock file）
  if [[ -f "${VANBLOG_DATA_PATH}/data/mongo/mongod.lock" ]]; then
    rm -f "${VANBLOG_DATA_PATH}/data/mongo/mongod.lock"
    echo -e "> 已删除 mongod.lock（热备份的正常产物）"
  fi

  echo -e "${green}恢复成功${plain}"
  if [[ "${VANBLOG_ASSUME_YES:-0}" == "1" ]]; then
    start_vanblog 0
  else
    read -e -r -p "是否立即启动 VanBlog? [Y/n] " input
    case $input in
    [nN][oO] | [nN]) echo -e "请稍后手动执行 ${yellow}./vanblog.sh start${plain}" ;;
    *) start_vanblog 0 ;;
    esac
  fi
  return 0
}

show_usage() {
  echo "VanBlog 管理脚本使用方法: "
  echo "--------------------------------------------------------"
  echo "./vanblog.sh                            - 显示管理菜单"
  echo "./vanblog.sh install                    - 安装 VanBlog"
  echo "./vanblog.sh config                     - 修改 VanBlog 配置"
  echo "./vanblog.sh start                      - 启动 VanBlog"
  echo "./vanblog.sh stop                       - 停止 VanBlog"
  echo "./vanblog.sh restart                    - 重启 VanBlog"
  echo "./vanblog.sh update                     - 更新 VanBlog"
  echo "./vanblog.sh log                        - 查看 VanBlog 日志"
  echo "./vanblog.sh uninstall                  - 卸载 VanBlog"
  echo "./vanblog.sh reset_https                - 重置 https 设置"
  echo "./vanblog.sh backup                     - 备份 VanBlog"
  echo "./vanblog.sh restore                    - 恢复 VanBlog"
  echo "--------------------------------------------------------"
  echo "./vanblog.sh update_script              - 更新此脚本"
  echo "--------------------------------------------------------"
  echo "装的是哪个版本（默认从源码构建本分支，不用官方镜像）："
  echo "  VANBLOG_REPO=${VANBLOG_REPO}"
  echo "  VANBLOG_BRANCH=${VANBLOG_BRANCH}"
  echo "  VANBLOG_SRC_DIR=${VANBLOG_SRC_DIR}"
  echo "  VANBLOG_IMAGE_TAG=${VANBLOG_IMAGE_TAG}"
  echo "  VANBLOG_USE_UPSTREAM_IMAGE=${VANBLOG_USE_UPSTREAM_IMAGE}  # true = 改用官方 mereith/van-blog:latest"
  echo "  VANBLOG_BUILD_SERVER=<url>            # 可选：构建期写入前台访问后端的地址"
  echo "--------------------------------------------------------"
}

show_menu() {
  echo -e "
    ${green}VanBlog 管理脚本${plain} ${red}${VANBLOG_SCRIPT_VERSION}${plain}
    安装来源：${yellow}${VANBLOG_REPO}${plain} 分支 ${yellow}${VANBLOG_BRANCH}${plain}$([[ "${VANBLOG_USE_UPSTREAM_IMAGE}" == "true" ]] && echo "（已改为使用官方镜像）" || echo "（本地构建镜像 ${VANBLOG_IMAGE_TAG}）")
    --- https://github.com/mereithhh/van-blog ---
    ${green}1.${plain}  安装 VanBlog
    ${green}2.${plain}  修改配置
    ${green}3.${plain}  启动服务
    ${green}4.${plain}  停止服务
    ${green}5.${plain}  重启服务
    ${green}6.${plain}  更新
    ${green}7.${plain}  查看日志
    ${green}8.${plain}  卸载
    ${green}9.${plain}  重置 https 设置
    ${green}10.${plain} 备份 VanBlog
    ${green}11.${plain} 恢复 VanBlog
    ————————————————-
    ${green}20.${plain} 更新此脚本
    ${green}30.${plain} 查看脚本使用说明
    ${green}0.${plain}  退出脚本
    "
  echo && read -ep "请输入选择 [0-30]: " num

  case "${num}" in
  0)
    exit 0
    ;;
  1)
    install_vanblog
    ;;
  2)
    config
    ;;
  3)
    start_vanblog
    ;;
  4)
    stop_vanblog
    ;;
  5)
    restart
    ;;
  6)
    update
    ;;
  7)
    show_log
    ;;
  8)
    uninstall_vanblog
    ;;
  9)
    reset_https
    ;;
  10)
    backup
    ;;
  11)
    restore
    ;;
  20)
    update_script
    ;;
  30)
    show_usage
    ;;
  *)
    echo -e "${red}请输入正确的数字 [0-8]${plain}"
    ;;
  esac
}

if [[ "${VANBLOG_SKIP_MAIN:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

pre_check

if [[ $# > 0 ]]; then
  case $1 in
  "install")
    install_vanblog 0
    ;;
  "config")
    config 0
    ;;
  "start")
    start_vanblog 0
    ;;
  "stop")
    stop_vanblog 0
    ;;
  "restart")
    restart 0
    ;;
  "update")
    update 0
    exit $?
    ;;
  "log")
    show_log 0
    ;;
  "update_script")
    update_script 0
    ;;
  "uninstall")
    uninstall_vanblog 0
    ;;
  "reset_https")
    reset_https 0
    exit $?
    ;;
  "backup")
    shift
    backup 0 "$@"
    ;;
  "restore")
    shift
    restore 0 "$@"
    ;;
  *) show_usage ;;
  esac
else
  show_menu
fi
