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
# 写进编排文件时要作为 sed 的**替换文本**，所以 & \ | 都得转义（分隔符用 |）。
# ⚠️ 这里以前是写死的 `\/var\/vanblog\/data`：一旦用 VANBLOG_DATA_PATH 换了目录，
# 编排文件里的卷还是指向 /var/vanblog/data，而 backup/restore/reset_https 操作的是新目录，
# 两边各写各的 —— 表现是"数据不见了"，其实是写到了两个地方。
_vb_data_sed="${VANBLOG_DATA_PATH//\\/\\\\}"
_vb_data_sed="${_vb_data_sed//&/\\&}"
VANBLOG_DATA_PATH_RAW="${VANBLOG_DATA_PATH_RAW:-${_vb_data_sed//|/\\|}}"
VANBLOG_SCRIPT_VERSION="v0.5.0"

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
# 全新安装时用的 MongoDB 镜像。mongo 4.4 在 2024-02 就 EOL 了（没有安全更新），
# 而 mongoose 7.6 / driver 5.9 官方支持到 7.0，本机开发环境跑的也是 7.0.14。
# ⚠️ 这个值**只在全新安装时生效**：已有数据目录的安装会保持原 tag（见 pick_mongo_image），
# 因为数据目录与 featureCompatibilityVersion 绑定，直接换大版本 mongod 会拒绝启动。
# 老机器不支持 avx（跑不了 5.0+）就设 VANBLOG_MONGO_IMAGE=mongo:4.4.16。
VANBLOG_MONGO_IMAGE="${VANBLOG_MONGO_IMAGE:-mongo:7.0}"
# auto=先拉镜像，拉不到退回源码构建；image=只拉；source=只构建
VANBLOG_INSTALL_MODE="${VANBLOG_INSTALL_MODE:-auto}"
VANBLOG_BUILD_MODE="${VANBLOG_BUILD_MODE:-auto}"
VANBLOG_FORCE_BUILD="${VANBLOG_FORCE_BUILD:-false}"
VANBLOG_NPM_REGISTRY="${VANBLOG_NPM_REGISTRY:-}"
# Alpine 软件源镜像（构建时传给 Dockerfile 的 VAN_BLOG_ALPINE_MIRROR）。
# 留空 = 自动探测；设成 "none" = 强制用官方源。
VANBLOG_ALPINE_MIRROR="${VANBLOG_ALPINE_MIRROR:-}"
# node-gyp 下载 Node 头文件的地址（原生模块 tree-sitter / sharp 要用）。
# Alpine/musl 下 node-gyp 默认去 unofficial-builds.nodejs.org，国内经常连不上，
# 于是 `pnpm install` 整个失败。留空 = 跟着 pnpm 源自动选（用 npmmirror 就配 cdn.npmmirror）。
VANBLOG_NODE_DIST_URL="${VANBLOG_NODE_DIST_URL:-}"
# sharp / sharp-libvips 预编译二进制的下载源。sharp 默认从 github.com 下，国内直接 aborted。
# npmmirror 两套都镜像了（含 musl 版），所以用预编译包就不必在镜像里装 gcc+vips 现编。
# 设成 none 表示用官方 GitHub（海外/CI 更快）。
VANBLOG_SHARP_DIST_HOST="${VANBLOG_SHARP_DIST_HOST:-}"
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

# 现有编排文件里 mongo 用的镜像（没有编排文件时输出空）
get_compose_mongo_image() {
  local compose_file="${VANBLOG_BASE_PATH}/docker-compose.yaml"
  [[ -f "${compose_file}" ]] || return 0
  awk '
    /^[[:space:]]*mongo:[[:space:]]*$/ { in_svc=1; next }
    in_svc && /^[[:space:]]*image:[[:space:]]*/ { print $2; exit }
    in_svc && /^[[:space:]]{0,4}[A-Za-z0-9_-]+:[[:space:]]*$/ { in_svc=0 }
  ' "${compose_file}"
}

# mongo 数据目录里有没有真实数据（决定能不能换版本）
mongo_datadir_has_data() {
  local dir="${VANBLOG_DATA_PATH}/data/mongo"
  [[ -d "${dir}" ]] || return 1
  ls -A "${dir}" 2>/dev/null |
    grep -qE '^(WiredTiger|mongod\.lock|storage\.bson|collection-|index-|_mdb_catalog\.wt|diagnostic\.data)'
}

# 挑 mongo 镜像：
#   已有数据 → **保持现有 tag**（换大版本 mongod 会拒绝启动，看起来像数据全丢）
#   全新安装 → VANBLOG_MONGO_IMAGE（默认 mongo:7.0）
pick_mongo_image() {
  local existing
  existing="$(get_compose_mongo_image)"
  if [[ -n "${existing}" && "${existing}" != "vanblog_mongo_image" ]] && mongo_datadir_has_data; then
    printf '%s' "${existing}"
    return 0
  fi
  printf '%s' "${VANBLOG_MONGO_IMAGE}"
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
    # ⚠️ 这个 rm -rf 以前是无条件的：如果用户把 VANBLOG_SRC_DIR 指到自己解压的源码树
    # （没有 .git），整个目录会被删掉。uninstall 里同样的操作是有护栏的，这里也要有。
    if [[ -e "${VANBLOG_SRC_DIR}" ]]; then
      if [[ -d "${VANBLOG_SRC_DIR}/.git" || "${VANBLOG_SRC_DIR}" == "${VANBLOG_BASE_PATH}/src" ]]; then
        rm -rf "${VANBLOG_SRC_DIR}"
      else
        echo -e "${red}${VANBLOG_SRC_DIR} 已存在，但既不是 git 仓库也不在 ${VANBLOG_BASE_PATH} 下，${plain}"
        echo -e "${red}为避免误删你自己的文件，不会自动删除。请手动清理或换一个 VANBLOG_SRC_DIR。${plain}"
        return 1
      fi
    fi
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

# 探测 Alpine 源：官方 dl-cdn 在国内经常要 10 秒以上，构建会看起来"卡死"在 apk add。
# 和 pnpm 源一样：实测谁快用谁，都不可达就用官方源。
detect_alpine_mirror() {
  if [[ "${VANBLOG_ALPINE_MIRROR}" == "none" ]]; then
    VANBLOG_ALPINE_MIRROR=""
    echo -e "> Alpine 源：${yellow}官方 dl-cdn${plain}（VANBLOG_ALPINE_MIRROR=none）"
    return 0
  fi
  if [[ -n "${VANBLOG_ALPINE_MIRROR}" ]]; then
    echo -e "> Alpine 源：${yellow}${VANBLOG_ALPINE_MIRROR}${plain}（VANBLOG_ALPINE_MIRROR 指定）"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    VANBLOG_ALPINE_MIRROR=""
    return 0
  fi
  local candidates=(
    "https://mirrors.aliyun.com/alpine"
    "https://mirrors.tuna.tsinghua.edu.cn/alpine"
    "https://dl-cdn.alpinelinux.org/alpine"
  )
  local url probe ms best="" best_ms=-1
  echo -e "> 探测 Alpine 源延迟："
  for url in "${candidates[@]}"; do
    # 用 latest-stable 而不是写死某个 v3.x：基础镜像的 Alpine 版本会随 node:20-alpine 漂移
    # （现在已经是 3.23 了），写死版本号会让探测结果和实际构建用的路径对不上。
    probe="$(curl -sS -o /dev/null -m 8 -w '%{http_code} %{time_total}' \
      "${url}/latest-stable/main/x86_64/APKINDEX.tar.gz" 2>/dev/null || true)"
    if [[ "${probe%% *}" != "200" ]]; then
      echo -e "    ${url} -> ${red}不可达${plain}"
      continue
    fi
    ms="$(awk -v x="${probe#* }" 'BEGIN { printf "%d", x * 1000 }')"
    echo -e "    ${url} -> ${ms}ms"
    if (( best_ms < 0 || ms < best_ms )); then
      best_ms="${ms}"; best="${url}"
    fi
  done
  # 官方源就算"可达"也常常慢到不可用：只有它是唯一选项时才用
  VANBLOG_ALPINE_MIRROR="${best}"
  if [[ -z "${best}" ]]; then
    echo -e "${yellow}  三个 Alpine 源都探测失败，构建时用官方源（可能很慢）${plain}"
  else
    echo -e "> Alpine 源：${yellow}${best}${plain}（实测 ${best_ms}ms）"
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
  detect_alpine_mirror
  # sharp 的预编译二进制源同样跟着 pnpm 源走
  if [[ -z "${VANBLOG_SHARP_DIST_HOST}" ]]; then
    case "${VANBLOG_NPM_REGISTRY}" in
    *npmmirror*)
      VANBLOG_SHARP_DIST_HOST="https://registry.npmmirror.com/-/binary"
      echo -e "> sharp 预编译源：${yellow}${VANBLOG_SHARP_DIST_HOST}${plain}（跟随 pnpm 源，免编译免 GitHub）"
      ;;
    esac
  elif [[ "${VANBLOG_SHARP_DIST_HOST}" == "none" ]]; then
    VANBLOG_SHARP_DIST_HOST=""
  fi
  # node-gyp 的头文件源跟着 pnpm 源走：用 npmmirror 就用它的 CDN（实测 3.4MB/s，
  # 比 npmmirror.com/mirrors 与 nodejs.org 快 6 倍），用 npmjs 就不设（走 node-gyp 默认）
  if [[ -z "${VANBLOG_NODE_DIST_URL}" ]]; then
    case "${VANBLOG_NPM_REGISTRY}" in
    *npmmirror*)
      VANBLOG_NODE_DIST_URL="https://cdn.npmmirror.com/binaries/node"
      echo -e "> node-gyp 头文件源：${yellow}${VANBLOG_NODE_DIST_URL}${plain}（跟随 pnpm 源）"
      ;;
    esac
  fi

  local version_arg="${VANBLOG_BRANCH}-${VANBLOG_SRC_COMMIT:-unknown}"
  # VAN_BLOG_BUILD_SERVER 必须传：Dockerfile 里它是 ARG → ENV VAN_BLOG_SERVER_URL，
  # 而前台 utils/loadConfig.ts 在**模块顶层** new URL(它)。不传就是空串，
  # next build 会在 "Collecting page data" 阶段抛 ERR_INVALID_URL 直接失败。
  # 构建期这个地址其实是连不上的（容器里还没有 server），页面会走兜底数据，
  # 运行时再由 runner 阶段的 ENV 覆盖成真实地址，所以这里给个合法值就够了。
  local build_server="${VANBLOG_BUILD_SERVER:-http://127.0.0.1:3000}"
  # sharp 的 install 脚本只认环境变量，所以真正传进镜像的是这两个具体 host
  local sharp_binary_host sharp_libvips_host
  if [[ -n "${VANBLOG_SHARP_DIST_HOST}" ]]; then
    sharp_binary_host="${VANBLOG_SHARP_DIST_HOST}/sharp"
    sharp_libvips_host="${VANBLOG_SHARP_DIST_HOST}/sharp-libvips"
  else
    sharp_binary_host="https://github.com/lovell/sharp/releases/download"
    sharp_libvips_host="https://github.com/lovell/sharp-libvips/releases/download"
  fi
  local -a build_args=(

    --build-arg "VAN_BLOG_VERSIONS=${version_arg}"
    --build-arg "VAN_BLOG_BUILD_SERVER=${build_server}"
    --build-arg "VAN_BLOG_NPM_REGISTRY=${VANBLOG_NPM_REGISTRY}"
    --build-arg "VAN_BLOG_ADMIN_BUILD_SCRIPT=${VANBLOG_ADMIN_BUILD_SCRIPT}"
    --build-arg "VAN_BLOG_ALPINE_MIRROR=${VANBLOG_ALPINE_MIRROR}"
    --build-arg "VAN_BLOG_NODE_DIST_URL=${VANBLOG_NODE_DIST_URL}"
    --build-arg "VAN_BLOG_SHARP_DIST_HOST=${VANBLOG_SHARP_DIST_HOST}"
    --build-arg "VAN_BLOG_SHARP_BINARY_HOST=${sharp_binary_host}"
    --build-arg "VAN_BLOG_SHARP_LIBVIPS_HOST=${sharp_libvips_host}"
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
      echo -e "${yellow}  国内机器拉 ghcr.io 经常超时，三条路：${plain}"
      echo -e "    1) 走镜像加速：${green}VANBLOG_IMAGE_REF=<你的 ghcr 镜像地址>/ckboss/vanblog:dev-dsh $0${plain}"
      echo -e "       （例如 ghcr.nju.edu.cn 这类公共加速域名，能不能用取决于当下网络，别写死在脚本里）"
      echo -e "    2) 在大机器上 ${green}docker pull${plain} + ${green}docker save${plain}，拷到本机 ${green}docker load${plain}，"
      echo -e "       然后 ${green}VANBLOG_INSTALL_MODE=image VANBLOG_IMAGE_REF=vanblog:dev-dsh $0${plain}"
      echo -e "    3) 直接源码构建：${green}VANBLOG_INSTALL_MODE=source $0${plain}（15-40 分钟，吃内存）"
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
  # 只 grep services:/vanblog: 是不够的：下载被截断时前几十行就有这两个词，
  # 校验通过后 config 会把它 sed 成一份**没有 mongo 服务**的编排文件，
  # 起栈时一半成功一半失败，而脚本还会打印"成功"。
  grep -q "services:" "${file}" || return 1
  grep -q "vanblog:" "${file}" || return 1
  grep -q "mongo:" "${file}" || return 1
  # 占位符也必须在，否则 config 的 sed 无处可替，最后留下一份跑不起来的编排文件
  local ph
  for ph in vanblog_image vanblog_data_path vanblog_http_port vanblog_https_port; do
    grep -q "${ph}" "${file}" || return 1
  done
  return 0
}

# 脚本自己的绝对路径：自更新要覆盖的是**这一份**，而不是当前工作目录下的同名文件
# （以前是 `mv -f /tmp/vanblog.sh ./vanblog.sh && exec ./vanblog.sh`，
#   在别的目录里执行就会写错地方、exec 到的还是旧脚本）。
VANBLOG_SELF_PATH="${VANBLOG_SELF_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/$(basename "${BASH_SOURCE[0]}")}"
[[ -f "${VANBLOG_SELF_PATH}" ]] || VANBLOG_SELF_PATH="./vanblog.sh"
# 给用户看的命令名。⚠️ 不要用 $0：脚本被 source（测试、或别人在自己的 shell 里加载）时
# $0 是 "bash"，提示语会变成"跑一次 bash backup"这种鬼话。
VANBLOG_SELF_NAME="$(basename "${VANBLOG_SELF_PATH}")"
[[ "${VANBLOG_SELF_NAME}" == "vanblog.sh" ]] || VANBLOG_SELF_NAME="./vanblog.sh"

is_valid_vanblog_script() {
  local file="$1"
  if [[ ! -s "${file}" ]]; then
    return 1
  fi
  bash -n "${file}" >/dev/null 2>&1 || return 1
  grep -q "VANBLOG_SCRIPT_VERSION" "${file}" || return 1
  grep -q "^show_menu()" "${file}" || return 1
  tail -n 20 "${file}" | grep -q "show_menu" || return 1
  return 0
}

download_url_to_file() {
  local url="$1"
  local dest="$2"
  # ⚠️ 以前这里给 wget 加了 --no-check-certificate：下载的是**编排模板和脚本自己**，
  # 关掉校验等于允许中间人塞一份进来（而脚本是 root 跑的、还会 exec 新脚本）。
  # 现在正常校验；wget 失败（比如老机器的 CA 包过期）就退到 curl，而不是退到"不校验"。
  if command -v wget >/dev/null 2>&1; then
    if wget -t 2 -T 10 -O "${dest}" "${url}" >/dev/null 2>&1; then
      return 0
    fi
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 10 --retry 2 -o "${dest}" "${url}" >/dev/null 2>&1
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    echo -e "${red}wget 与 curl 都没能下载 ${url}（TLS 证书校验是开启的，请不要绕过它；${plain}"
    echo -e "${red}如果本机 CA 证书过期，先更新 ca-certificates 再重试）${plain}"
    return 1
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

  # ⚠️ 不要下载到固定路径 /tmp/vanblog.sh：那是全局可写目录，
  # 先放一个指向 /root/xxx 的软链再让 curl -o 跟随，就能覆盖任意文件（脚本是 root 跑的）。
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/vanblog-script.XXXXXX")" || {
    echo -e "${red}无法创建临时文件${plain}"
    return 1
  }
  if ! download_script "${tmp}"; then
    rm -f "${tmp}"
    echo -e "${red}脚本获取失败，请检查本机能否连接文档站、GitHub 或 jsDelivr${plain}"
    return 1
  fi
  if ! is_valid_vanblog_script "${tmp}"; then
    rm -f "${tmp}"
    echo -e "${red}下载到的脚本不完整或语法有误，已丢弃（不会覆盖当前这份）${plain}"
    return 1
  fi
  new_version=$(grep "VANBLOG_SCRIPT_VERSION" "${tmp}" | head -n 1 | awk -F "=" '{print $2}' | sed 's/\"//g;s/,//g;s/ //g')
  if [ ! -n "$new_version" ]; then
    rm -f "${tmp}"
    echo -e "脚本获取失败，已下载的文件无法解析版本号"
    return 1
  fi
  echo -e "当前最新版本为: ${new_version}（本机 ${VANBLOG_SCRIPT_VERSION}）"
  if [[ "${new_version}" == "${VANBLOG_SCRIPT_VERSION}" ]]; then
    rm -f "${tmp}"
    echo -e "${green}已经是最新版本，无需替换${plain}"
    return 0
  fi
  if ! cp "${tmp}" "${VANBLOG_SELF_PATH}"; then
    rm -f "${tmp}"
    echo -e "${red}写入 ${VANBLOG_SELF_PATH} 失败${plain}"
    return 1
  fi
  rm -f "${tmp}"
  chmod a+x "${VANBLOG_SELF_PATH}"

  echo -e "3s后执行新脚本"
  sleep 3s
  clear
  exec bash "${VANBLOG_SELF_PATH}"
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

# 装完顺手从整站备份重置：新机器上"装 + 初始化 + 恢复 + 核对"一步到位。
#   VANBLOG_RESTORE_FROM=/path/to/vanblog-full-xxx.tar.zst ./vanblog.sh install
#   VANBLOG_RESTORE_FROM=<归档名> ./vanblog.sh install      # 归档已在服务器备份目录里
# 没设这个变量时行为完全不变。
install_and_maybe_reset() {
  install_vanblog "$@"
  local rc=$?
  if [[ ${rc} -ne 0 ]]; then
    return ${rc}
  fi
  if [[ -n "${VANBLOG_RESTORE_FROM:-}" ]]; then
    echo
    echo -e "> 检测到 ${yellow}VANBLOG_RESTORE_FROM${plain}，安装完成后直接从整站备份重置站点"
    reset 0 "${VANBLOG_RESTORE_FROM}"
    return $?
  fi
  return 0
}

install_vanblog() {
  install_base

  # SELinux enforcing 时，编排文件里的 bind mount 没有 :z/:Z 标记，
  # mongod 与 caddy 会因为 AVC 拒绝读写数据目录而反复重启 —— 而这类失败
  # 在脚本这边只表现为"起不来"，很难想到是 SELinux。这里提前说一声。
  if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
    echo -e "${yellow}检测到 SELinux 处于 Enforcing：本编排文件的 bind mount 没有打 :z 标记，${plain}"
    echo -e "${yellow}mongo/caddy 可能因 AVC 拒绝而无法读写 ${VANBLOG_DATA_PATH}。${plain}"
    echo -e "${yellow}若容器反复重启，先看 ${yellow}ausearch -m avc -ts recent${plain}${yellow}，"
    echo -e "${yellow}必要时给卷加 :z，或临时 setenforce 0 验证。${plain}"
  fi

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
      # ⚠️ 以前这里是 exit 0：cloud-init / ansible 会认为安装成功，
      # 然后后面每一步都失败，日志里却看不到真正的起因。
      exit 1
    fi
    # 有 docker 命令不等于 daemon 起来了（非 systemd 的机器、或 service 启动失败）
    if ! docker info >/dev/null 2>&1; then
      echo -e "${red}Docker 命令已安装，但 daemon 连不上（docker info 失败）。${plain}"
      echo -e "${red}请先启动 docker 服务再重试；非 systemd 的机器需要手动 dockerd。${plain}"
      exit 1
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
  # ⚠️ 下面会用 Docker_IMG 重写 image: 行，而 Docker_IMG 只在 pre_check 里被设成
  # **上游官方镜像**，这条路径又不经过 prepare_vanblog_image —— 于是"改个邮箱/端口"
  # 就会把本 fork 的镜像悄悄换成 mereith/van-blog:latest，本分支的功能全部消失
  # （数据还在，但装的东西被换了，而且没有任何提示）。
  # 规则：现有编排文件里已经有 image 就**沿用**，没有才去准备镜像。
  local current_image
  current_image="$(get_compose_vanblog_image 2>/dev/null)"
  if [[ -n "${current_image}" && "${current_image}" != "vanblog_image" ]]; then
    # ⚠️ 这里必须写 ${Docker_IMG:-}：Docker_IMG 是 pre_check 里才赋值的普通变量，
    # 在 set -u 的环境下（有人 source 这个脚本、或测试里）直接引用会 unbound variable 中断，
    # 结果就是"改个配置"改到一半退出，编排文件停在旧状态。
    if [[ "${current_image}" != "${Docker_IMG:-}" ]]; then
      echo -e "> 沿用编排文件里现有的镜像 ${yellow}${current_image}${plain}（不改回官方镜像）"
    fi
    Docker_IMG="${current_image}"
  elif ! use_upstream_image; then
    echo -e "> 编排文件里还没有镜像，先准备本分支镜像"
    prepare_vanblog_image || return 1
  fi

  rm "${VANBLOG_BASE_PATH}/docker-compose.yaml" >/dev/null 2>&1
  cp "${VANBLOG_BASE_PATH}/docker-compose-template.yaml" "${VANBLOG_BASE_PATH}/docker-compose.yaml" >/dev/null 2>&1
  # 用 | 作分隔符（路径里有 /），替换文本里的 & \ | 已转义
  sed -i "s|vanblog_data_path|${VANBLOG_DATA_PATH_RAW}|g" "${VANBLOG_BASE_PATH}/docker-compose.yaml"
  # ⚠️ 邮箱里的 & 在 sed 替换文本中会被展开成"整个匹配"：a&b@x.com 会变成
  # `EMAIL: avanblog_emailb@x.com`，ACME 拿到非法地址，HTTPS 证书一直签不出来。
  local email_sed="${vanblog_email//\\/\\\\}"
  email_sed="${email_sed//&/\\&}"
  email_sed="${email_sed//|/\\|}"
  sed -i "s|vanblog_email|${email_sed}|g" "${VANBLOG_BASE_PATH}/docker-compose.yaml"
  sed -i "s/vanblog_http_port/${vanblog_http_port}/g" ${VANBLOG_BASE_PATH}/docker-compose.yaml
  sed -i "s/vanblog_https_port/${vanblog_https_port}/g" ${VANBLOG_BASE_PATH}/docker-compose.yaml
  # mongo 版本：已有数据就保持现状，全新安装才用新默认值
  local mongo_image
  mongo_image="$(pick_mongo_image)"
  if grep -q "vanblog_mongo_image" "${VANBLOG_BASE_PATH}/docker-compose.yaml"; then
    sed -i "s|vanblog_mongo_image|${mongo_image}|g" "${VANBLOG_BASE_PATH}/docker-compose.yaml"
  else
    echo -e "${yellow}> 编排模板里没有 vanblog_mongo_image 占位符（可能是上游旧模板），mongo 版本保持模板原样${plain}"
  fi
  if mongo_datadir_has_data; then
    echo -e "> 检测到已有 MongoDB 数据，沿用 ${yellow}${mongo_image}${plain}（不擅自升级大版本）"
    case "${mongo_image}" in
    mongo:4.* | mongo:5.*)
      echo -e "${yellow}  ${mongo_image} 已经 EOL（无安全更新）。升级只有两条路：${plain}"
      echo -e "${yellow}    a) 阶梯升级 5.0 → 6.0 → 7.0，每级都要 setFCV；${plain}"
      echo -e "${yellow}    b) 整站备份迁移：$0 backup → VANBLOG_MONGO_IMAGE=mongo:7.0 起空库 → $0 restore <归档名>${plain}"
      ;;
    esac
  else
    echo -e "> 全新安装，MongoDB 用 ${yellow}${mongo_image}${plain}（可用 VANBLOG_MONGO_IMAGE 覆盖；老机器不支持 avx 就设 mongo:4.4.16）"
  fi
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
  # ⚠️ 这两步的返回码以前被丢掉了：不管 docker-compose 成没成功都打印"重启成功"、
  # 函数都返回 0。后果是端口被占/镜像拉不下来/caddy 崩溃循环时，安装与 config 流程
  # 照样报成功，而调用方（比如 restore 的"先停服再解压"）也判断不出停没停。
  docker-compose down --remove-orphans
  local down_rc=$?
  docker-compose up -d
  local up_rc=$?
  if [[ ${up_rc} == 0 && ${down_rc} == 0 ]]; then
    echo -e "${green}VanBlog 重启成功${plain}"
    echo -e "默认管理面板地址：${yellow}域名:站点访问端口/admin${plain}"
  else
    echo -e "${red}重启失败（down=${down_rc} up=${up_rc}），请查看日志：${yellow}$0 log${plain}"
    echo -e "${red}常见原因：80/443 端口被占用、镜像拉取失败、磁盘满、caddy 配置加载失败${plain}"
    if [[ $# == 0 ]]; then
      before_show_menu
    fi
    return 1
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

  cd "${VANBLOG_BASE_PATH}" && docker-compose up -d
  local rc=$?
  if [[ ${rc} == 0 ]]; then
    echo -e "${green}VanBlog 启动成功${plain}"
  else
    echo -e "${red}启动失败（docker-compose 退出码 ${rc}），请查看日志：${yellow}$0 log${plain}"
    echo -e "${red}常见原因：80/443 已被别的进程或另一套 vanblog 占用、镜像没拉下来、磁盘满${plain}"
    if command -v docker >/dev/null 2>&1; then
      local others
      others="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E ':80->|:443->' | head -3)"
      if [[ -n "${others}" ]]; then
        echo -e "${yellow}当前占用 80/443 的容器：${plain}"
        printf '%s\n' "${others}" | sed 's/^/    /'
      fi
    fi
  fi

  if [[ $# == 0 ]]; then
    before_show_menu
  fi
  return ${rc}
}

stop_vanblog() {
  echo -e "> 停止 VanBlog"

  # 停止服务不该删卷（见 restart 里的说明）
  cd "${VANBLOG_BASE_PATH}" && docker-compose down --remove-orphans
  local rc=$?
  if [[ ${rc} == 0 ]]; then
    echo -e "${green}VanBlog 停止成功${plain}"
  else
    echo -e "${red}停止失败（docker-compose 退出码 ${rc}），请稍后查看日志信息${plain}"
  fi

  if [[ $# == 0 ]]; then
    before_show_menu
  fi
  # 必须把失败传出去：restore 的离线恢复靠它判断"是不是真的停下来了"，
  # 停不下来还去解压覆盖数据目录 = mongod 还在写的时候动它的数据文件
  return ${rc}
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
  # 三种来源的镜像都清：上游官方、本分支 ghcr、本地构建的 tag。
  # 以前只删上游那个，换成本分支镜像之后卸载会留下 1.5GB+ 的悬空镜像。
  docker rmi -f mereith/van-blog:latest >/dev/null 2>&1 || true
  docker rmi -f "${VANBLOG_IMAGE_REF}" >/dev/null 2>&1 || true
  docker rmi -f "${VANBLOG_IMAGE_TAG}" >/dev/null 2>&1 || true
  # 只删**本脚本自己写的** shim（内容就是 `docker compose "$@"`），
  # 用户自己装的 docker-compose 绝不能碰
  if [[ -f /usr/local/bin/docker-compose ]] &&
    grep -qF 'docker compose "$@"' /usr/local/bin/docker-compose 2>/dev/null &&
    [[ "$(wc -l </usr/local/bin/docker-compose 2>/dev/null)" -le 2 ]]; then
    rm -f /usr/local/bin/docker-compose
    echo -e "> 已移除本脚本创建的 docker-compose 兼容 shim"
  fi
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
# 老路径：直接把数据目录打成 tar.gz（含 mongo 数据文件、图床、caddy 证书与配置、日志）。
# 现在是**兜底**手段：站点起不来、或者你想连 caddy 证书一起备的时候用它。
# 日常备份请用整站备份（backup_full）—— 那才是一致的、跨版本可恢复的快照。
# ── 整站备份（默认路径）────────────────────────────────────────────────────
# 调 server 的 POST /api/admin/backup/full/export：由 server 自己把**所有集合**导出成
# NDJSON、带上 waline 评论库与图床/附件/自定义页面，压缩成一个 vanblog-full-*.tar.zst，
# 并写一份 sidecar 清单。相比打包数据目录，它有三个实打实的好处：
#   1. **一致**：由 server 在运行中导出，不会拍到 mongod 写了一半的数据文件
#      （热 tar 的老路径要么不一致，要么得先停 mongo）；
#   2. **跨版本可恢复**：NDJSON 不绑 MongoDB 版本，mongo 4.4 → 6.0 → 7.0 都能恢复进去，
#      而数据目录 tar 包换个大版本 mongod 直接拒绝启动；
#   3. **可预览**：恢复前能读清单看每个集合多少条，不会恢复错版本。
# 代价：需要站点在跑 + 管理员凭据；而且**不含 caddy 的证书与配置**（那些在数据目录里），
# 想连证书一起备就用 --offline。
backup_full() {
  local format="${1:-zstd}"
  case "${format}" in
  zstd | xz | gzip) ;;
  *)
    echo -e "${red}不支持的压缩格式：${format}（可选 zstd / xz / gzip）${plain}"
    return 1
    ;;
  esac

  local base
  base="$(vanblog_api_base)"
  echo -e "> 整站备份（走 server 接口）：${yellow}${base}${plain}，压缩格式 ${yellow}${format}${plain}"

  local code
  # ⚠️ 不要写成 `$(curl … || echo 000)`：curl 连接失败时 -w 已经输出过 000，
  #    再补一个就变成 "000000"（restore 那边踩过一次）
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "${base}/api/public/meta" 2>/dev/null)"
  [[ -n "${code}" ]] || code="000"
  if [[ "${code}" != "200" ]]; then
    echo -e "${red}站点接口不通（${base}/api/public/meta → ${code}），整站备份需要 server 在跑。${plain}"
    echo -e "两条路："
    echo -e "  1) ${green}./vanblog.sh start${plain} 之后再 ${green}./vanblog.sh backup${plain}"
    echo -e "  2) 站点起不来时改用离线打包（连 caddy 证书一起备，但是一致性差一些）："
    echo -e "     ${green}./vanblog.sh backup --offline${plain}          # 热备份"
    echo -e "     ${green}./vanblog.sh backup --offline --consistent${plain}  # 先停 mongo，一致性好"
    return 1
  fi

  local token
  token="$(vanblog_admin_token)" || return 1

  echo -e "> 开始导出（大站点可能要几分钟：要遍历全部集合并压缩）..."
  local resp
  resp="$(curl -sS -m 7200 -X POST "${base}/api/admin/backup/full/export" \
    -H "token: ${token}" -H 'Content-Type: application/json' \
    -d "{\"format\":\"${format}\"}" 2>&1)"

  if ! printf '%s' "${resp}" | grep -q '"statusCode":200'; then
    echo -e "${red}整站备份失败${plain}："
    printf '%s\n' "${resp}" | head -c 600
    echo
    echo -e "${yellow}如果是因为站点起不来，可以用 ${plain}${green}./vanblog.sh backup --offline${plain}"
    return 1
  fi

  local data name size seconds docs files colls
  data="$(printf '%s' "${resp}" | sed 's/^{"statusCode":200,"data"://; s/}$//')"
  # 只削掉开头的 "key": 与首尾引号（`sed 's/.*://'` 会把 ISO 时间戳削成 54.882Z）
  pick() { printf '%s' "${data}" | grep -oE "\"$1\":(\"[^\"]*\"|[0-9.]+)" | head -1 | sed -E "s/^\"$1\"://; s/^\"//; s/\"$//"; }
  name="$(pick name)"
  size="$(pick size)"
  seconds="$(pick seconds)"
  docs="$(printf '%s' "${data}" | grep -oE '"documents":[0-9]+' | head -1 | cut -d: -f2)"
  files="$(printf '%s' "${data}" | grep -oE '"files":[0-9]+' | head -1 | cut -d: -f2)"
  colls="$(printf '%s' "${data}" | grep -oE '"collections":[0-9]+' | head -1 | cut -d: -f2)"

  echo -e "${green}整站备份成功${plain}"
  echo -e "  归档    ：${yellow}${name:-未知}${plain}（${size:-?}，用时 ${seconds:-?}s）"
  echo -e "  内容    ：${colls:-?} 个集合 / ${docs:-?} 条文档 / ${files:-?} 个静态文件"
  local host_path="$(full_backup_dir)/${name}"
  if [[ -n "${name}" && -f "${host_path}" ]]; then
    echo -e "  宿主机路径：${yellow}${host_path}${plain}"
  else
    echo -e "  服务器目录：${yellow}$(full_backup_dir)${plain}（容器内 <日志目录>/vanblog-backups）"
  fi
  echo -e "  恢复    ：${green}./vanblog.sh restore ${name}${plain}"
  echo -e "  ${yellow}注意：这份归档不含 caddy 的证书与配置（它们在数据目录里）。要连证书一起备，用 --offline。${plain}"
  return 0
}

# backup 的入口：默认走整站备份，--offline 才打包数据目录
backup() {
  local mode="${VANBLOG_BACKUP_MODE:-api}"
  local format="${VANBLOG_BACKUP_FORMAT:-zstd}"
  local arg
  for arg in "$@"; do
    case "${arg}" in
    --offline) mode="offline" ;;
    --api | --full) mode="api" ;;
    --consistent) : ;; # 由 backup_offline 自己解析
    --format) : ;; # 值在下一个参数
    0 | --*) : ;;
    *)
      # --format 后面的值
      if [[ "${prev_was_format:-0}" == "1" ]]; then
        format="${arg}"
        prev_was_format=0
      fi
      ;;
    esac
    [[ "${arg}" == "--format" ]] && prev_was_format=1
  done

  if [[ "${mode}" == "offline" ]]; then
    backup_offline "$@"
    return $?
  fi
  backup_full "${format}"
}

backup_offline() {
  echo -e "> 备份 vanblog（离线：打包数据目录）"

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

# ── 整站备份（vanblog-full-*）的一步恢复 ────────────────────────────────────
# 这类归档是 **server 自己**导出的：各集合的 NDJSON + waline 库 + 图床/附件/自定义页面，
# zstd/xz/gzip 压缩，旁边还有一个 sidecar 清单。它**只能**用 server 的恢复接口还原
# （按集合原子替换 + 重建索引 + 触发全量渲染），直接解压到数据目录是错的：
# 那是 mongo 的数据文件布局，不是 NDJSON。
# 所以脚本走 HTTP；如果归档本来就在服务器的备份目录里，直接传名字（几百 MB 也不用上传）。

# 宿主机上对应容器 <log>/vanblog-backups 的目录（compose 把 <data>/log 挂到 /var/log）
full_backup_dir() {
  printf '%s' "${VANBLOG_BACKUP_DIR:-${VANBLOG_DATA_PATH}/log/vanblog-backups}"
}

# 从编排文件里读 vanblog 服务映射到容器 80 的宿主机端口
get_compose_http_port() {
  local compose_file="${VANBLOG_BASE_PATH}/docker-compose.yaml"
  [[ -f "${compose_file}" ]] || return 1
  local block
  block="$(awk '/^[[:space:]]*vanblog:[[:space:]]*$/{f=1;next} f&&/^  [A-Za-z0-9_-]+:[[:space:]]*$/{f=0} f' "${compose_file}")"
  # ports 里形如 - "8080:80" / - 8080:80 / - "8080:80/tcp"
  # ⚠️ 别写成 '[0-9]+:80'：那会把 "3000:8080" 里的 3000:80 也匹配上，
  # 于是 restore 去探一个错误的端口，然后告诉你"站点没起，请先 start"。
  # 容器端口必须是**完整的** 80（后面跟引号、/tcp 或行尾）。
  printf '%s\n' "${block}" |
    grep -oE '[0-9]+:80(/tcp)?["'"'"']?[[:space:]]*$' |
    head -1 | grep -oE '^[0-9]+'
}

# HTTPS 端口（宿主机侧），以及有没有映射 QUIC 用的 UDP 端口
get_compose_https_port() {
  local compose_file="${VANBLOG_BASE_PATH}/docker-compose.yaml"
  [[ -f "${compose_file}" ]] || return 1
  local block
  block="$(awk '/^[[:space:]]*vanblog:[[:space:]]*$/{f=1;next} f&&/^  [A-Za-z0-9_-]+:[[:space:]]*$/{f=0} f' "${compose_file}")"
  # 只认映射到容器 443 的那条，且要区分 tcp / udp
  printf '%s\n' "${block}" |
    grep -oE '[0-9]+:443(/(tcp|udp))?["'"'"']?[[:space:]]*$' |
    head -1 | grep -oE '^[0-9]+'
}

compose_has_quic_port() {
  local compose_file="${VANBLOG_BASE_PATH}/docker-compose.yaml"
  [[ -f "${compose_file}" ]] || return 1
  grep -qE '[0-9]+:443/udp' "${compose_file}"
}

vanblog_api_base() {
  if [[ -n "${VANBLOG_API_BASE:-}" ]]; then
    printf '%s' "${VANBLOG_API_BASE%/}"
    return 0
  fi
  local port
  port="$(get_compose_http_port)"
  printf 'http://127.0.0.1:%s' "${port:-80}"
}

sha256_hex() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

json_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "${s}"
}

# 必须和 packages/admin/src/services/van-blog/encryptPwd.js 逐字节一致：
#   u = username.toLowerCase()
#   sha256( u + sha256(sha256(sha256(sha256(password)))) + sha256(u) )
# 服务端存的是这个派生值再套一层 salt 的结果，所以脚本必须自己算，不能明文传密码。
derive_login_password() {
  local u h1 h2 h3 h4 hu
  u="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  h1="$(sha256_hex "$2")"
  h2="$(sha256_hex "${h1}")"
  h3="$(sha256_hex "${h2}")"
  h4="$(sha256_hex "${h3}")"
  hu="$(sha256_hex "${u}")"
  sha256_hex "${u}${h4}${hu}"
}

# 拿管理员 token：优先用 VANBLOG_ADMIN_TOKEN，否则用账号密码登录换。
vanblog_admin_token() {
  if [[ -n "${VANBLOG_ADMIN_TOKEN:-}" ]]; then
    printf '%s' "${VANBLOG_ADMIN_TOKEN}"
    return 0
  fi
  if ! command -v sha256sum >/dev/null 2>&1; then
    echo -e "${red}本机没有 sha256sum，无法在本地算登录口令。${plain}" >&2
    echo -e "改用 ${yellow}VANBLOG_ADMIN_TOKEN=<token> ./vanblog.sh restore${plain}（token 在浏览器 F12 → Application → Local Storage → token）" >&2
    return 1
  fi
  local user pass derived resp token
  read -e -r -p "后台用户名: " user
  if [[ -z "${user}" ]]; then
    echo -e "${red}用户名为空${plain}" >&2
    return 1
  fi
  read -e -r -s -p "后台密码: " pass
  echo >&2
  if [[ -z "${pass}" ]]; then
    echo -e "${red}密码为空${plain}" >&2
    return 1
  fi
  derived="$(derive_login_password "${user}" "${pass}")"
  # ⚠️ 登录接口有失败次数限制（连续失败会被锁一段时间），所以**只试一次，不重试**
  resp="$(curl -sS -m 30 -X POST "$(vanblog_api_base)/api/admin/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":$(json_string "${user}"),\"password\":\"${derived}\"}" 2>&1)"
  token="$(printf '%s' "${resp}" |
    grep -oE '"token"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 |
    sed 's/.*"token"[[:space:]]*:[[:space:]]*"//; s/"$//')"
  if [[ -z "${token}" ]]; then
    echo -e "${red}登录失败${plain}：$(printf '%s' "${resp}" | head -c 200)" >&2
    echo -e "${yellow}连续失败会被限流锁定。也可以设 VANBLOG_ADMIN_TOKEN=<token> 跳过登录。${plain}" >&2
    return 1
  fi
  # 前缀 INIT 用来告诉父 shell"这次是真的做了初始化"（子 shell 里设的变量传不回去）
  printf '%s' "${token}"
}

# 判断目标是「整站备份」还是脚本自己打的「数据目录 tar.gz」
is_full_backup_target() {
  local base
  base="$(basename "$1")"
  case "${base}" in
  vanblog-full-*) return 0 ;;
  vanblog-backup-*.tar.gz | *.tgz) return 1 ;;
  esac
  case "${base}" in
  *.tar.zst | *.zst | *.tar.xz) return 0 ;;
  esac
  return 1
}

# 列出服务器备份目录里的整站备份，让用户挑一个；输出**归档名**（不是路径），
# 这样恢复时走 name= 分支，不用把几百 MB 再上传一遍。
pick_full_backup() {
  local dir
  dir="$(full_backup_dir)"
  if [[ ! -d "${dir}" ]]; then
    echo -e "${yellow}没找到备份目录 ${dir}（可能站点还没备份过，或数据目录不在本机）${plain}" >&2
    return 1
  fi
  local -a files=()
  local f
  while IFS= read -r f; do
    # 排除 sidecar 清单（vanblog-full-xxx.tar.zst.manifest.json），它不是可恢复的归档
    [[ -n "${f}" ]] || continue
    case "${f}" in
    *.manifest.json) continue ;;
    esac
    files+=("${f}")
  done < <(ls -1t "${dir}"/vanblog-full-* 2>/dev/null)
  if [[ ${#files[@]} -eq 0 ]]; then
    echo -e "${yellow}${dir} 里没有 vanblog-full-* 归档${plain}" >&2
    return 1
  fi
  echo -e "> 服务器上可恢复的整站备份（${yellow}${dir}${plain}）：" >&2
  local i=1
  for f in "${files[@]}"; do
    local size
    size="$(du -h "${f}" 2>/dev/null | cut -f1)"
    printf '  %2d) %-52s %8s  %s\n' "${i}" "$(basename "${f}")" "${size:-?}" "$(date -r "${f}" '+%Y-%m-%d %H:%M' 2>/dev/null)" >&2
    i=$((i + 1))
  done
  local choice
  read -e -r -p "选择要恢复的备份编号（回车取消）: " choice >&2
  if [[ -z "${choice}" ]]; then
    return 1
  fi
  if ! [[ "${choice}" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#files[@]} )); then
    echo -e "${red}编号超出范围${plain}" >&2
    return 1
  fi
  basename "${files[$((choice - 1))]}"
}

# 把接口返回的 JSON 排版一下：有 python3 就缩进美化，没有就原样打印。
# ⚠️ 别用 sed 硬拆（我第一版是 `s/,"/,\n/g`，嵌套对象会被拆得支离破碎、根本没法读）。
# 也**不硬依赖** jq/python3：小机器上不一定有，退化成一行的原始 JSON 也比报错好。
pretty_json() {
  local input out
  input="$(cat)"
  if command -v python3 >/dev/null 2>&1; then
    if out="$(printf '%s' "${input}" | python3 -c 'import json,sys
try:
    print(json.dumps(json.load(sys.stdin), ensure_ascii=False, indent=2))
except Exception:
    raise SystemExit(1)' 2>/dev/null)"; then
      printf '%s\n' "${out}" | sed 's/^/  /'
      return 0
    fi
  fi
  printf '%s\n' "${input}"
}

# 把整站备份的 inspect / restore 响应压成几行摘要。
# 完整 JSON 太吵：一次 reset 能打印上百行，屏幕上全是 `},` 和字段名，
# 真正要看的就那几项（备份时间、集合/文档/文件数、各集合条数）。
# 要看全文用 --verbose（或 VANBLOG_VERBOSE=1）。
summarize_backup_json() {
  local data="$1"
  local pick
  pick() {
    # ⚠️ 不能用 `sed 's/.*://'` 去掉键名：ISO 时间戳里全是冒号
    #    （2026-09-13T06:09:54.882Z 会被削成 54.882Z）。只削掉开头的 "key": 与首尾引号。
    printf '%s' "${data}" | grep -oE "\"$1\":(\"[^\"]*\"|[0-9.]+)" | head -1 |
      sed -E "s/^\"$1\"://; s/^\"//; s/\"$//"
  }
  local name created fmt size secs colls docs files
  name="$(pick name)"
  created="$(pick createdAt)"
  fmt="$(pick format)"
  size="$(pick size)"
  secs="$(pick seconds)"
  colls="$(printf '%s' "${data}" | grep -oE '"collections":[0-9]+' | head -1 | cut -d: -f2)"
  docs="$(printf '%s' "${data}" | grep -oE '"documents":[0-9]+' | head -1 | cut -d: -f2)"
  files="$(printf '%s' "${data}" | grep -oE '"files":[0-9]+' | head -1 | cut -d: -f2)"
  [[ -n "${name}" ]] && echo -e "    归档    ：${yellow}${name}${plain}"
  [[ -n "${created}" ]] && echo -e "    备份时间：${created}"
  local meta=""
  [[ -n "${fmt}" ]] && meta="格式 ${fmt}"
  [[ -n "${size}" ]] && meta="${meta:+${meta}，}大小 ${size}"
  [[ -n "${secs}" ]] && meta="${meta:+${meta}，}耗时 ${secs}s"
  [[ -n "${meta}" ]] && echo -e "    ${meta}"
  if [[ -n "${colls}${docs}${files}" ]]; then
    echo -e "    内容    ：${colls:-?} 个集合 / ${docs:-?} 条文档 / ${files:-?} 个静态文件"
  fi
  # 各集合条数（最多列 10 个，多的省略）
  local pairs
  pairs="$(printf '%s' "${data}" | grep -oE '"[A-Za-z_][A-Za-z0-9_]*":\{"count":[0-9]+' |
    sed -E 's/^"//; s/":\{"count":/ /' | head -10)"
  if [[ -n "${pairs}" ]]; then
    echo -e "    各集合  ："
    printf '%s\n' "${pairs}" | while read -r cname cnum; do
      [[ -n "${cname}" ]] && printf '      %-18s %s\n' "${cname}" "${cnum}"
    done
  fi
  return 0
}

# 打印备份响应：默认摘要，--verbose 时给完整 JSON
print_backup_json() {
  local data="$1"
  if [[ "${VANBLOG_VERBOSE:-0}" == "1" ]]; then
    printf '%s' "${data}" | pretty_json | head -120
  else
    summarize_backup_json "${data}"
    echo -e "    ${yellow}（完整清单加 --verbose）${plain}"
  fi
}

restore_full_backup() {
  local target="$1"
  local with_static="${2:-true}"
  local base
  base="$(vanblog_api_base)"
  echo -e "> 整站恢复（走 server 接口）：${yellow}${base}${plain}"

  local code
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "${base}/api/public/meta" 2>/dev/null)"
  [[ -n "${code}" ]] || code="000"
  if [[ "${code}" != "200" ]]; then
    echo -e "${red}站点接口不通（${base}/api/public/meta → ${code}）。${plain}"
    echo -e "${red}整站恢复必须经过 server 的接口（它要按集合原子替换并重建索引），请先 ${yellow}./vanblog.sh start${red} 再试。${plain}"
    return 1
  fi

  local token
  token="$(vanblog_admin_token)" || return 1

  local upload=0
  if [[ -f "${target}" ]]; then
    upload=1
    echo -e "> 备份文件：${yellow}${target}${plain}（$(du -h "${target}" 2>/dev/null | cut -f1)，将上传到服务器）"
  else
    echo -e "> 备份名称：${yellow}${target}${plain}（服务器备份目录里已有，不需要上传）"
    if [[ ! -f "$(full_backup_dir)/${target}" ]]; then
      echo -e "${yellow}  注意：宿主机 $(full_backup_dir) 里没看到这个文件，将交给 server 自己在它的备份目录里找${plain}"
    fi
  fi

  # 恢复前先把清单打出来：备份是什么时候的、里面有哪些集合，避免恢复错版本
  local inspect_body inspect_resp
  if [[ ${upload} -eq 0 ]]; then
    inspect_body="{\"name\":$(json_string "${target}")}"
    inspect_resp="$(curl -sS -m 60 -X POST "${base}/api/admin/backup/full/inspect" \
      -H "token: ${token}" -H 'Content-Type: application/json' -d "${inspect_body}" 2>&1)"
    if printf '%s' "${inspect_resp}" | grep -q '"statusCode":200'; then
      echo -e "> 备份清单："
      print_backup_json "$(printf '%s' "${inspect_resp}" | sed 's/^{"statusCode":200,"data"://; s/}$//')"
    else
      echo -e "${yellow}  读不出清单（$(printf '%s' "${inspect_resp}" | head -c 160)），继续前请确认这个归档是本功能导出的${plain}"
    fi
  fi

  echo -e "${red}恢复会用这份备份覆盖当前【全部】数据：数据库所有集合、waline 评论库、图床/附件/自定义页面。不可撤销。${plain}"
  if [[ "${with_static}" != "true" ]]; then
    echo -e "${yellow}（--no-static：这次只恢复数据库，保留当前图床与附件）${plain}"
  fi
  if [[ "${VANBLOG_ASSUME_YES:-0}" != "1" ]]; then
    local input
    read -e -r -p "确认恢复? 输入 yes 继续: " input
    if [[ "${input}" != "yes" ]]; then
      echo "已取消恢复"
      return 0
    fi
  fi

  echo -e "> 开始恢复（大备份可能要几分钟，请勿中断）..."
  local resp
  if [[ ${upload} -eq 1 ]]; then
    resp="$(curl -sS -m 7200 -X POST "${base}/api/admin/backup/full/restore" \
      -H "token: ${token}" \
      -F "file=@${target}" \
      -F "confirm=true" \
      -F "withStatic=${with_static}" 2>&1)"
  else
    resp="$(curl -sS -m 7200 -X POST "${base}/api/admin/backup/full/restore" \
      -H "token: ${token}" -H 'Content-Type: application/json' \
      -d "{\"name\":$(json_string "${target}"),\"confirm\":\"true\",\"withStatic\":\"${with_static}\"}" 2>&1)"
  fi

  if printf '%s' "${resp}" | grep -q '"statusCode":200'; then
    echo -e "${green}恢复成功${plain}"
    print_backup_json "$(printf '%s' "${resp}" | sed 's/^{"statusCode":200,"data"://; s/}$//')"
    echo -e "> server 已触发全量重渲染（ISR），前台页面会在几分钟内刷新到新数据"
    return 0
  fi
  echo -e "${red}恢复失败${plain}："
  printf '%s\n' "${resp}" | head -c 800
  echo
  return 1
}

# 恢复。两种归档自动分流：
#   vanblog-full-*（server 导出的整站备份）→ 走 HTTP 接口，**不停服**
#   vanblog-backup-*.tar.gz（本脚本 backup 打的数据目录 tar 包）→ 停服后离线解压
#
# 用法：
#   ./vanblog.sh restore                       列出服务器备份目录里的整站备份，选一个恢复
#   ./vanblog.sh restore <归档名>              一步恢复（归档在服务器备份目录里，不上传）
#   ./vanblog.sh restore /path/to/vanblog-full-xxx.tar.zst   本地文件，走上传
#   ./vanblog.sh restore <归档名> --no-static  只恢复数据库，保留当前图床/附件
#   VANBLOG_ASSUME_YES=1 ./vanblog.sh restore <归档名>       非交互（跳过 yes 确认）
#   VANBLOG_ADMIN_TOKEN=<token> ./vanblog.sh restore …       跳过账号密码登录
#   VANBLOG_API_BASE=http://127.0.0.1:8080 ./vanblog.sh restore …  手动指定接口地址
#   VANBLOG_RESTORE_FILE=/path/to/vanblog-backup-xxx.tar.gz ./vanblog.sh restore   老格式
restore() {
  echo -e "> 恢复 vanblog"

  local path="${VANBLOG_RESTORE_FILE:-}"
  local with_static="true"
  # 分发入口会传一个 0 表示「不进菜单」，别把它当成文件路径
  local arg
  for arg in "$@"; do
    case "${arg}" in
    --no-static) with_static="false" ;;
    --with-static) with_static="true" ;;
    --verbose) export VANBLOG_VERBOSE=1 ;;
    0 | --*) : ;;
    *)
      if [[ -n "${arg}" ]]; then
        path="${arg}"
      fi
      ;;
    esac
  done

  # 没给参数：先把服务器上现成的整站备份列出来让选（这是最常见的一步恢复场景）
  if [[ -z "${path}" ]]; then
    path="$(pick_full_backup)" || path=""
  fi
  if [[ -z "${path}" ]]; then
    read -e -r -p "请输入备份名称或文件路径（回车取消）: " path
  fi

  if [[ -z "${path}" ]]; then
    echo -e "${red}输入为空${plain}"
    return 1
  fi

  # 整站备份（vanblog-full-*）走 server 接口；脚本自己打的数据目录 tar.gz 走下面的离线流程
  if is_full_backup_target "${path}"; then
    restore_full_backup "${path}" "${with_static}"
    return $?
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
  if ! stop_vanblog 0; then
    echo -e "${red}停不下来就不解压：mongod 还在运行时覆盖它的数据目录会直接损坏数据库。${plain}"
    echo -e "${red}请先排查（${yellow}$0 log${red}），确认容器已停再重试。${plain}"
    return 1
  fi

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

# 一眼看清"装了什么、跑着没有、数据多大、备份在哪、磁盘还剩多少"。
# 全部只读，不改任何东西，也不需要站点在跑。
show_status() {
  echo -e "> VanBlog 状态"
  echo -e "  脚本版本  ：${VANBLOG_SCRIPT_VERSION}"
  echo -e "  安装目录  ：${VANBLOG_BASE_PATH}$([[ -d "${VANBLOG_BASE_PATH}" ]] || echo -e " ${red}(不存在)${plain}")"
  echo -e "  数据目录  ：${VANBLOG_DATA_PATH}$([[ -d "${VANBLOG_DATA_PATH}" ]] || echo -e " ${red}(不存在)${plain}")"

  local compose_file="${VANBLOG_BASE_PATH}/docker-compose.yaml"
  if [[ -f "${compose_file}" ]]; then
    echo -e "  编排镜像  ：${yellow}$(get_compose_vanblog_image 2>/dev/null || echo 未知)${plain}"
    local mongo_img
    mongo_img="$(get_compose_mongo_image 2>/dev/null)"
    echo -e "  编排 mongo：${yellow}${mongo_img:-未知}${plain}"
    if mongo_datadir_has_data; then
      echo -e "  mongo 数据：已有（升级大版本前请先做整站备份，见 backup 的说明）"
    else
      echo -e "  mongo 数据：数据目录是空的（全新安装，会用 ${VANBLOG_MONGO_IMAGE}）"
    fi
    local http_port
    http_port="$(get_compose_http_port 2>/dev/null)"
    echo -e "  HTTP 端口 ：${http_port:-未知}"
    local https_port
    https_port="$(get_compose_https_port 2>/dev/null)"
    if [[ -n "${https_port}" ]]; then
      # caddy 在 :443 上开了 h1/h2/h3，但 QUIC 走 UDP：没映射这个端口的话浏览器只能用 HTTP/2
      if compose_has_quic_port; then
        echo -e "  HTTPS 端口：${https_port}（TCP+UDP 都已映射，${green}HTTP/3 可用${plain}；云主机还需在安全组放行 UDP ${https_port}）"
      else
        echo -e "  HTTPS 端口：${https_port}（${yellow}只映射了 TCP${plain}，浏览器只能用 HTTP/2；跑一次 ${VANBLOG_SELF_NAME} config 重新生成编排文件即可加上 UDP）"
      fi
    fi
    if [[ -n "${http_port}" ]]; then
      local base code
      base="$(vanblog_api_base 2>/dev/null)"
      code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "${base}/api/public/meta" 2>/dev/null)"
      [[ -n "${code}" ]] || code="000"
      if [[ "${code}" == "200" ]]; then
        echo -e "  站点接口  ：${green}${base} → 200${plain}"
      else
        echo -e "  站点接口  ：${red}${base} → ${code}（没在跑？先 ${VANBLOG_SELF_NAME} start）${plain}"
      fi
    fi
  else
    echo -e "  ${yellow}没有找到编排文件（${compose_file}），可能还没安装${plain}"
  fi

  if command -v docker-compose >/dev/null 2>&1 || command -v docker >/dev/null 2>&1; then
    echo -e "  容器状态  ："
    (cd "${VANBLOG_BASE_PATH}" 2>/dev/null && docker-compose ps 2>/dev/null | sed 's/^/    /') ||
      echo -e "    ${yellow}(拿不到，docker-compose ps 失败)${plain}"
  fi

  # 目录占用：数据/日志/备份分开看，磁盘写满时最有用
  if [[ -d "${VANBLOG_DATA_PATH}" ]]; then
    echo -e "  目录占用  ："
    local d
    for d in data/static data/mongo log caddy; do
      if [[ -d "${VANBLOG_DATA_PATH}/${d}" || -d "${VANBLOG_BASE_PATH}/${d}" ]]; then
        local real="${VANBLOG_DATA_PATH}/${d}"
        [[ -d "${real}" ]] || real="${VANBLOG_BASE_PATH}/${d}"
        printf '    %-14s %s\n' "${d}" "$(du -sh "${real}" 2>/dev/null | cut -f1)"
      fi
    done
  fi

  local bdir
  bdir="$(full_backup_dir 2>/dev/null)"
  if [[ -d "${bdir}" ]]; then
    local count total
    count="$(ls -1 "${bdir}"/vanblog-full-*.tar.* 2>/dev/null | grep -v 'manifest.json' | wc -l | tr -d ' ')"
    total="$(du -sh "${bdir}" 2>/dev/null | cut -f1)"
    echo -e "  整站备份  ：${count} 个归档，共 ${total}（${bdir}）"
    ls -1t "${bdir}"/vanblog-full-*.tar.* 2>/dev/null | grep -v 'manifest.json' | head -3 |
      while read -r f; do printf '    %s  %s\n' "$(basename "${f}")" "$(human_size "${f}")"; done
  else
    echo -e "  整站备份  ：还没有（${bdir} 不存在，跑一次 ${VANBLOG_SELF_NAME} backup）"
  fi

  # 安装目录还不存在时 df 会失败，退回看根分区（磁盘满是最常见的"博客突然挂掉"原因之一）
  local df_target="${VANBLOG_BASE_PATH}"
  [[ -d "${df_target}" ]] || df_target="/"
  echo -e "  磁盘剩余  ：$(df -h "${df_target}" 2>/dev/null | tail -1 | awk '{print $4" 可用 / 共 "$2"（已用 "$5"），挂载点 "$6}')"

  if [[ $# == 0 ]]; then
    before_show_menu
  fi
  return 0
}

# ── 从整站备份「重置」整个站点（新机器上一条命令搞定）──────────────────────
# 痛点：换新机器时流程是"装 → 打开后台走向导初始化 → 登录 → 上传备份 → 恢复"，
# 而初始化建的那个账号马上又会被备份里的真实账号覆盖 —— 纯属白走一趟。
# 更麻烦的是恢复接口在 AdminGuard 后面，**没初始化就没法登录，也就没法恢复**（鸡生蛋）。
# 所以这里把整条链自动化：探活 → 没初始化就用随机口令的临时账号初始化 → 登录拿 token →
# 恢复整站备份 → 重启容器（让 server 重新读取恢复后的 JWT 密钥）→ 验证 → 打印结果。
#
# 临时账号只是"敲门用"的：恢复会把 users 集合整个换成备份里的那份，所以恢复成功后
# 用**你原来的账号**登录；万一恢复失败，脚本会把临时账号打印出来，让你至少能进后台。

# 随机口令（临时管理员用）
random_password() {
  local n="${1:-18}"
  local raw
  if command -v openssl >/dev/null 2>&1; then
    raw="$(openssl rand -base64 32 2>/dev/null)"
  fi
  if [[ -z "${raw:-}" ]]; then
    raw="$(head -c 96 /dev/urandom 2>/dev/null | base64 2>/dev/null)"
  fi
  printf '%s' "${raw}" | tr -dc 'A-Za-z0-9' | head -c "${n}"
}

# 站点还没初始化时自动初始化，并把可用的 admin token 打到 stdout（提示走 stderr）。
# 已经初始化过就退回正常的登录流程（VANBLOG_ADMIN_TOKEN 或交互输入账号密码）。
# 用法：ensure_admin_token <临时用户名> <临时口令>
# ⚠️ 账号口令必须由**调用方**生成并保存成全局变量：这个函数是在
# `token="$(ensure_admin_token …)"` 这种命令替换里跑的，也就是**子 shell**，
# 在里面设的变量出了子 shell 就没了（恢复失败时就打印不出临时账号，
# 用户在新机器上连后台都进不去）。
ensure_admin_token() {
  local base init_user init_pass derived resp token
  base="$(vanblog_api_base)"
  init_user="$1"
  init_pass="$2"
  if ! command -v sha256sum >/dev/null 2>&1; then
    echo -e "${red}本机没有 sha256sum，无法在本地派生登录口令。${plain}" >&2
    echo -e "${yellow}请用 VANBLOG_ADMIN_TOKEN=<token> 指定（浏览器 F12 → Application → Local Storage → token）${plain}" >&2
    return 1
  fi
  derived="$(derive_login_password "${init_user}" "${init_pass}")"

  resp="$(curl -sS -m 60 -X POST "${base}/api/admin/init" \
    -H 'Content-Type: application/json' \
    -d "{\"user\":{\"username\":$(json_string "${init_user}"),\"password\":\"${derived}\",\"nickname\":$(json_string "重置初始化")},\"siteInfo\":{\"author\":\"vanblog\",\"siteName\":\"VanBlog\",\"siteDesc\":\"reset\",\"baseUrl\":\"${base}/\"}}" 2>&1)"

  if printf '%s' "${resp}" | grep -q '已初始化'; then
    echo -e "> 站点已经初始化过了，用现有账号登录" >&2
    vanblog_admin_token
    return $?
  fi
  if ! printf '%s' "${resp}" | grep -q '"statusCode":200'; then
    echo -e "${red}初始化失败：$(printf '%s' "${resp}" | head -c 300)${plain}" >&2
    return 1
  fi
  echo -e "> 站点是全新的，已用临时账号 ${yellow}${init_user}${plain} 完成初始化（恢复成功后会被备份里的账号覆盖）" >&2

  # 登录拿 token（只试一次：登录接口有失败限流）
  resp="$(curl -sS -m 30 -X POST "${base}/api/admin/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":$(json_string "${init_user}"),\"password\":\"${derived}\"}" 2>&1)"
  token="$(printf '%s' "${resp}" |
    grep -oE '"token"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 |
    sed 's/.*"token"[[:space:]]*:[[:space:]]*"//; s/"$//')"
  if [[ -z "${token}" ]]; then
    echo -e "${red}临时账号登录失败：$(printf '%s' "${resp}" | head -c 200)${plain}" >&2
    echo -e "${yellow}临时账号：${init_user} / ${init_pass}${plain}" >&2
    return 1
  fi
  # 前缀 INIT 用来告诉父 shell「这次真的做了初始化」（子 shell 里设的变量传不回去）
  printf 'INIT %s' "${token}"
}

# 站点重置后核对一下：接口通不通、站点名对不对、文章有多少篇
verify_after_reset() {
  local base="$1"
  local code name arts
  code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "${base}/api/public/meta" 2>/dev/null)"
  [[ -n "${code}" ]] || code="000"
  if [[ "${code}" != "200" ]]; then
    echo -e "  ${red}✗${plain} /api/public/meta → ${code}"
    return 1
  fi
  echo -e "  ${green}✓${plain} /api/public/meta → 200"
  name="$(curl -sS -m 20 "${base}/api/public/meta" 2>/dev/null |
    grep -oE '"siteName"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 |
    sed 's/.*:[[:space:]]*"//; s/"$//')"
  [[ -n "${name}" ]] && echo -e "  ${green}✓${plain} 站点名：${yellow}${name}${plain}"
  for path in / /admin /sitemap.xml /robots.txt; do
    code="$(curl -sS -m 40 -o /dev/null -w '%{http_code}' "${base}${path}" 2>/dev/null)"
    case "${code}" in
    200 | 301 | 302 | 308) echo -e "  ${green}✓${plain} ${path} → ${code}" ;;
    *) echo -e "  ${yellow}!${plain} ${path} → ${code}（刚恢复完可能还在渲染，稍后再试）" ;;
    esac
  done
  arts="$(curl -sS -m 40 "${base}/api/public/articles?page=1&pageSize=1" 2>/dev/null |
    grep -oE '"total"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$')"
  [[ -n "${arts}" ]] && echo -e "  ${green}✓${plain} 前台可见文章：${arts} 篇"
  return 0
}

reset_from_backup() {
  local target="$1"
  local with_static="${2:-true}"
  local do_restart="${3:-1}"
  local base
  base="$(vanblog_api_base)"

  echo -e "> 从整站备份重置整个站点：${yellow}${base}${plain}"
  local code
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "${base}/api/public/meta" 2>/dev/null)"
  [[ -n "${code}" ]] || code="000"
  if [[ "${code}" != "200" ]]; then
    echo -e "${red}站点接口不通（${base} → ${code}）。重置需要 server 在跑：先 ${yellow}${VANBLOG_SELF_NAME} start${red}（或先 install）。${plain}"
    return 1
  fi

  # 没初始化就自动初始化，然后拿到 token。
  # 临时账号在**这里**（父 shell）生成并记住，恢复失败时要打印给用户
  RESET_TEMP_USER="${VANBLOG_RESET_INIT_USER:-reset-init}"
  RESET_TEMP_PASS="${VANBLOG_RESET_INIT_PASS:-$(random_password 18)}"
  local token
  RESET_DID_INIT=0
  token="$(ensure_admin_token "${RESET_TEMP_USER}" "${RESET_TEMP_PASS}")" || {
    echo -e "${yellow}临时管理员账号（如果初始化其实成功了，可以用它进后台排查）：${RESET_TEMP_USER} / ${RESET_TEMP_PASS}${plain}"
    return 1
  }
  if [[ -z "${token}" ]]; then
    echo -e "${red}拿不到管理员 token，无法恢复${plain}"
    return 1
  fi
  if [[ "${token}" == INIT\ * ]]; then
    RESET_DID_INIT=1
    token="${token#INIT }"
  fi
  # restore_full_backup 优先用这个环境变量，不会再问一遍账号密码
  VANBLOG_ADMIN_TOKEN="${token}" restore_full_backup "${target}" "${with_static}"
  local rc=$?
  if [[ ${rc} -ne 0 ]]; then
    echo -e "${red}恢复失败。${plain}"
      if [[ "${RESET_DID_INIT:-0}" == "1" ]]; then
      echo -e "${yellow}临时管理员账号（还能进后台排查）：${RESET_TEMP_USER} / ${RESET_TEMP_PASS}${plain}"
    fi
    return ${rc}
  fi

  if [[ "${do_restart}" == "1" ]]; then
    echo -e "> 重启容器，让 server 重新读取恢复后的 JWT 密钥"
    echo -e "  ${yellow}（不重启的话，恢复前登录的会话会失效，而且用备份里的密钥签的 token 验不过）${plain}"
    if restart 0; then
      echo -e "  ${green}✓${plain} 已重启"
    else
      echo -e "  ${yellow}!${plain} 重启失败，请手动 ${VANBLOG_SELF_NAME} restart 后再验证"
    fi
    # 等接口回来
    local i
    for i in $(seq 1 40); do
      code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "${base}/api/public/meta" 2>/dev/null)"
      [[ "${code}" == "200" ]] && break
      sleep 3
    done
  fi

  echo -e "> 核对结果"
  verify_after_reset "${base}"

  echo
  echo -e "${green}整站重置完成${plain}"
  echo -e "  站点地址：${yellow}${base}/${plain}（后台 ${yellow}${base}/admin${plain}）"
  if [[ "${RESET_DID_INIT:-0}" == "1" ]]; then
    echo -e "  登录账号：${yellow}用备份里原来的账号${plain}（初始化用的临时账号 ${RESET_TEMP_USER} 已被覆盖）"
  fi
  echo -e "  ${yellow}提示：前台页面由 ISR 逐步生成，个别页面第一次访问会慢一点，属正常。${plain}"
  return 0
}

reset() {
  local with_static="true"
  local do_restart=1
  local target=""
  local args=()
  local arg
  for arg in "$@"; do
    case "${arg}" in
    --no-static) with_static="false" ;;
    --with-static) with_static="true" ;;
    --no-restart) do_restart=0 ;;
    --verbose) export VANBLOG_VERBOSE=1 ;;
    0) : ;; # 菜单传进来的占位
    --*) echo -e "${red}未知参数：${arg}${plain}"; return 1 ;;
    *) args+=("${arg}") ;;
    esac
  done

  if [[ ${#args[@]} -gt 0 ]]; then
    target="${args[0]}"
    # 给的是名字但在本地也能找到同名文件时，优先按本地文件上传（新机器上常见）
    if [[ ! -f "${target}" && -f "$(full_backup_dir)/${target}" ]]; then
      target="$(full_backup_dir)/${target}"
      echo -e "> 在服务器备份目录里找到了 ${yellow}$(basename "${target}")${plain}，直接用服务器上的文件（不上传）"
      target="$(basename "${target}")"
    fi
  else
    echo -e "> 没有指定归档，列出服务器备份目录里的整站备份："
    target="$(pick_full_backup)" || return 1
    if [[ -z "${target}" ]]; then
      echo -e "${red}备份目录里没有整站备份。${plain}"
      echo -e "把归档拷到 ${yellow}$(full_backup_dir)${plain} 之后再来，或者直接指定路径："
      echo -e "  ${green}${VANBLOG_SELF_NAME} reset /path/to/vanblog-full-xxx.tar.zst${plain}"
      return 1
    fi
  fi

  echo -e "> 将要重置整站，来源：${yellow}${target}${plain}，静态文件：${yellow}${with_static}${plain}"
  if [[ "${VANBLOG_ASSUME_YES:-0}" != "1" ]]; then
    read -e -r -p "这会**覆盖当前站点的全部数据**，确认继续？(yes/no): " ans
    if [[ "${ans}" != "yes" ]]; then
      echo -e "${yellow}已取消${plain}"
      return 1
    fi
  fi

  reset_from_backup "${target}" "${with_static}" "${do_restart}"
}

show_usage() {
  # ⚠️ 这里用**引号 heredoc**（<<'USAGE'）：正文里有大量 `$VAR`、`$(...)` 形式的示例，
  #    用不加引号的 heredoc 会被当场展开甚至执行。需要显示实际默认值的几行单独 echo。
  cat <<'USAGE'
VanBlog 管理脚本（本分支 CKboss/vanblog @ dev/dsh；上游项目 https://github.com/Mereithhh/van-blog）

用法： ./vanblog.sh [子命令] [参数]        不带参数 = 交互菜单
      ./vanblog.sh --help | -h | help    显示本页

──────────────────────── 安装与日常 ────────────────────────
  install                 安装 / 重装。默认「先拉镜像，拉不到再从源码构建」。
                          装完如果设了 VANBLOG_RESTORE_FROM=<归档>，会顺手把整站备份恢复上去。
  config                  重新生成编排文件（邮箱、HTTP/HTTPS 端口、镜像、mongo 版本）。
                          ⚠️ 会覆盖你手写的 environment / 卷映射，改前会自动存一份 .bak-<时间戳>。
                          ⚠️ 不会把镜像换回上游官方版（沿用编排文件里现有的那个）。
  start | stop | restart  启动 / 停止 / 重启（restart 不带 -v，不会删卷）。
                          三者都如实返回 docker-compose 的退出码，失败时打印排查方向。
  update                  更新：**先把新镜像准备好，再停容器**（拉取/构建失败时旧站点还在跑），
                          只删已经没人用的旧镜像，只有版本确实前进才报成功。
  status                  状态总览（只读）：脚本版本、安装/数据目录、编排里的 vanblog 与 mongo 镜像、
                          mongo 数据是否存在、HTTP 端口、接口探活、容器状态、各目录占用、
                          整站备份数量与最近三个归档、磁盘剩余。
  log                     查看日志（docker-compose logs）。
  uninstall               卸载。会问确认；**不删备份**；顺带清掉本分支镜像、本地构建 tag 与自建 shim。
  reset_https             重置 https 设置（证书签不出来、域名换过、caddy 配置被改坏时用）。
  update_script           更新此脚本自身（校验语法与首尾标志，版本相同不替换）。

──────────────────────── 备份 / 恢复 / 重置 ────────────────────────
  backup                          整站备份（默认）：调 server 接口导出
                                  vanblog-full-<时间戳>.tar.zst 到 <数据目录>/log/vanblog-backups/。
                                  一致性快照、NDJSON 跨 MongoDB 版本可恢复、可预览清单。
        --format zstd|xz|gzip     换压缩格式（默认 zstd）
        --offline                 改成打包整个数据目录（vanblog-backup-*.tar.gz）：
                                  站点起不来时的兜底，也是唯一**包含 caddy 证书**的方式
        --offline --consistent    先停 mongo 再打包（一致性好，几十秒不可写）
        --verbose                 打印完整 JSON（默认只给摘要）
  restore                         从整站备份恢复。不带参数 = 列出服务器备份目录里的归档让你选编号。
        restore <归档名>           归档在服务器备份目录里 → 不上传，秒级开始（几百 MB 也一样）
        restore <本地路径>         本地文件 → multipart 上传
        --no-static               只恢复数据库，保留当前图床/附件
        --with-static             显式恢复静态文件（默认就是恢复）
        --verbose                 打印完整清单 JSON
                                  ⚠️ 恢复**不停服**：server 按集合原子替换 + 重建索引 + 触发全量渲染。
                                  ⚠️ 恢复后要重新登录后台（JWT 密钥是启动时读的）；
                                     自动化脚本恢复后调 /api/admin/** 需要先重启一次容器。
                                  老的 vanblog-backup-*.tar.gz 会自动走离线恢复（停服解压），
                                  并且**停不下来就不解压**（mongod 还在写时覆盖数据文件会损坏数据库）。
  reset                           新机器上一条命令把整站搬过来：
                                  探活 → 没初始化就用随机口令的临时账号初始化 → 登录 →
                                  打印清单 → 要 yes → 恢复 → 重启容器 → 逐项核对 → 打印结果。
        reset <归档名|本地路径>     指定归档（不给就列出服务器上的让你选）
        --no-static               只恢复数据库
        --no-restart              恢复完不重启（那就得自己重启一次）
        --verbose                 打印完整清单 JSON
                                  ⚠️ 恢复失败时会把临时管理员账号打印出来，不会把你锁在门外。

──────────────────────── 环境变量 ────────────────────────
  装什么：
    VANBLOG_INSTALL_MODE=auto|image|source   默认 auto：先拉镜像，拉不到再源码构建
    VANBLOG_IMAGE_REF=<ref>                  默认 ghcr.io/ckboss/vanblog:dev-dsh（可指镜像加速地址）
    VANBLOG_USE_UPSTREAM_IMAGE=true          改用上游官方镜像（不含本分支任何改动）
    VANBLOG_MONGO_IMAGE=mongo:7.0            **只在全新安装时生效**；已有数据目录会保持原 tag
                                             （数据目录与 FCV 绑定，直接换大版本 mongod 会拒绝启动）
                                             老机器 CPU 不支持 avx 就设 mongo:4.4.16
    VANBLOG_RESTORE_FROM=<归档>              install 之后自动 reset（换机器一步到位）
  放在哪：
    VANBLOG_BASE_PATH=/var/vanblog           安装目录（编排文件、离线备份 tar 包）
    VANBLOG_DATA_PATH=<dir>                  数据目录（默认 <安装目录>/data）
    VANBLOG_BACKUP_DIR=<dir>                 整站备份目录（默认 <数据目录>/log/vanblog-backups）
    VANBLOG_SRC_DIR=<dir>                    源码构建时的克隆目录
  构建时用哪个源（留空 = 自动实测延迟后选最快的；海外机器什么都不用设）：
    VANBLOG_NPM_REGISTRY                     pnpm 源（npmmirror / npmjs）
    VANBLOG_ALPINE_MIRROR                    容器内 Alpine 软件源（none = 官方 dl-cdn）
    VANBLOG_NODE_DIST_URL                    node-gyp 的 Node 头文件源（none = 默认）
    VANBLOG_SHARP_DIST_HOST                  sharp / libvips 预编译包源（none = 官方 GitHub）
    VAN_BLOG_ADMIN_BUILD_SCRIPT=build|build:lowmem   admin 的 webpack 堆：4096MB / 1536MB
  备份与恢复：
    VANBLOG_ADMIN_TOKEN=<token>              跳过账号密码登录（浏览器 F12 → Application → Local Storage → token）
    VANBLOG_API_BASE=http://127.0.0.1:80     站点接口地址（默认从编排文件读映射到容器 80 的宿主机端口）
    VANBLOG_ASSUME_YES=1                     跳过所有 yes 确认（定时任务用）
    VANBLOG_VERBOSE=1                        打印完整 JSON
    VANBLOG_BACKUP_FORMAT=zstd|xz|gzip       backup 的压缩格式
    VANBLOG_BACKUP_CONSISTENT=1              等价于 backup --offline --consistent
    VANBLOG_RESTORE_FILE=<路径>              等价于 restore <路径>（老写法，仍支持）
    VANBLOG_RESET_INIT_USER / _PASS          reset 自动初始化用的临时账号（默认随机口令）
  其它：
    VANBLOG_SKIP_MAIN=1                      只加载函数不执行主流程（写测试用）

──────────────────────── 常见场景 ────────────────────────
  新机器装机：            ./vanblog.sh install
  换机器搬站（一步）：     VANBLOG_RESTORE_FROM=/path/to/vanblog-full-xxx.tar.zst ./vanblog.sh install
  换机器搬站（两步）：     ./vanblog.sh install && ./vanblog.sh reset /path/to/vanblog-full-xxx.tar.zst
  每天凌晨三点整站备份：   0 3 * * * VANBLOG_ADMIN_TOKEN=<token> VANBLOG_ASSUME_YES=1 /var/vanblog/vanblog.sh backup >> /var/log/vanblog-backup.cron.log 2>&1
  升级：                  ./vanblog.sh update
  回滚镜像：              把编排里的 image 改成 ghcr.io/ckboss/vanblog:dev-dsh-<短sha>，再 restart
  站点打不开怎么查：       ./vanblog.sh status → ./vanblog.sh log
                          （status 会告诉你接口通不通、容器在不在、磁盘满没满）
  证书 / HTTPS 出问题：    ./vanblog.sh reset_https
  磁盘满了：              ./vanblog.sh status 看各目录占用；整站备份归档和日志是大头

──────────────────────── 约定 ────────────────────────
  退出码：0 = 成功；非 0 = 失败（可以在自动化里判断）。
          ⚠️ 生命周期命令以前无论成败都返回 0，导致到处打印"成功"；现在如实返回。
  需要 root（脚本开头会检查 id -u）。
  所有写操作前都会确认；破坏性操作（卸载、恢复、重置）要输入完整的 yes。
  路径与文件：
    <安装目录>/docker-compose.yaml            编排文件（config 会重新生成，旧的存成 .bak-<时间戳>）
    <数据目录>/data/static                    图床与附件
    <数据目录>/data/mongo                     MongoDB 数据文件
    <数据目录>/log                            日志（容器里的 /var/log）
    <数据目录>/log/vanblog-backups            整站备份归档 + .manifest.json 清单
    <安装目录>/caddy/{config,data}            caddy 配置与证书

USAGE
  echo "本机实际取值："
  echo "  VANBLOG_BASE_PATH=${VANBLOG_BASE_PATH}"
  echo "  VANBLOG_DATA_PATH=${VANBLOG_DATA_PATH}"
  echo "  整站备份目录=$(full_backup_dir 2>/dev/null)"
  echo "  VANBLOG_INSTALL_MODE=${VANBLOG_INSTALL_MODE:-auto}   VANBLOG_IMAGE_REF=${VANBLOG_IMAGE_REF}"
  echo "  VANBLOG_MONGO_IMAGE=${VANBLOG_MONGO_IMAGE}（仅全新安装生效）"
  echo "  VANBLOG_REPO=${VANBLOG_REPO}   VANBLOG_BRANCH=${VANBLOG_BRANCH}"
  echo "  VANBLOG_SRC_DIR=${VANBLOG_SRC_DIR}   VANBLOG_IMAGE_TAG=${VANBLOG_IMAGE_TAG}"
  echo "--------------------------------------------------------"
}

# 菜单顶上那一行运行状态：一眼看出"装没装、跑没跑、从哪儿访问"。
# 只探一次接口（超时 3 秒），不给菜单增加明显延迟。
menu_state_line() {
  local compose_file="${VANBLOG_BASE_PATH}/docker-compose.yaml"
  if [[ ! -f "${compose_file}" ]]; then
    echo -e "    状态    ：${yellow}未安装${plain}（${VANBLOG_BASE_PATH} 下没有编排文件，选 1 安装）"
    return 0
  fi
  local port code
  port="$(get_compose_http_port 2>/dev/null)"
  if [[ -z "${port}" ]]; then
    echo -e "    状态    ：${yellow}读不出端口映射${plain}（编排文件可能被改坏了，选 2 重新生成）"
    return 0
  fi
  code="$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/public/meta" 2>/dev/null)"
  [[ -n "${code}" ]] || code="000"
  if [[ "${code}" == "200" ]]; then
    echo -e "    状态    ：${green}● 运行中${plain}  http://<域名或服务器IP>:${port}（后台在后面加 /admin）"
  else
    echo -e "    状态    ：${red}○ 接口不通${plain}（127.0.0.1:${port} → ${code}；用 3 启动、7 看日志、13 看总览）"
  fi
}

show_menu() {
  echo -e "
    ${green}VanBlog 管理脚本${plain} ${red}${VANBLOG_SCRIPT_VERSION}${plain}
    本分支  ：${yellow}CKboss/vanblog${plain} 分支 ${yellow}${VANBLOG_BRANCH}${plain}（上游项目 Mereithhh/van-blog）
    安装目录：${VANBLOG_BASE_PATH}    数据目录：${VANBLOG_DATA_PATH}
    镜像来源：${yellow}${VANBLOG_IMAGE_REF}${plain}$([[ "${VANBLOG_USE_UPSTREAM_IMAGE:-}" == "true" ]] && echo "（已切到上游官方镜像，不含本分支改动）")
              模式 ${VANBLOG_INSTALL_MODE:-auto}：先拉镜像，拉不到再从源码构建$( [[ -n "${VANBLOG_RESTORE_FROM:-}" ]] && echo "；装完自动恢复 ${VANBLOG_RESTORE_FROM}")
$(menu_state_line)
    ${green}── 安装与日常 ──────────────────────────────${plain}
    ${green}1.${plain}  安装 / 重装 VanBlog
    ${green}2.${plain}  修改配置（邮箱 / HTTP·HTTPS 端口 / 镜像 / mongo 版本）
    ${green}3.${plain}  启动服务        ${green}4.${plain}  停止服务        ${green}5.${plain}  重启服务
    ${green}6.${plain}  更新（先把新镜像准备好，再停容器；失败时旧站点还在跑）
    ${green}7.${plain}  查看日志        ${green}13.${plain} 状态总览（镜像/容器/接口/目录占用/备份/磁盘）
    ${green}── 备份与恢复 ──────────────────────────────${plain}
    ${green}10.${plain} 备份（整站备份：一致性快照、跨 MongoDB 版本可恢复、可预览清单）
    ${green}11.${plain} 恢复（从整站备份恢复，${yellow}不停服${plain}；不带参数会列出归档让你选）
    ${green}12.${plain} 重置整站（${yellow}新机器推荐${plain}：自动初始化 + 恢复 + 重启 + 逐项核对）
    ${green}── 其它 ──────────────────────────────────${plain}
    ${green}8.${plain}  卸载（会问确认；${yellow}不删备份${plain}）
    ${green}9.${plain}  重置 https 设置（证书签不出来 / 换过域名 / caddy 配置被改坏时）
    ${green}20.${plain} 更新此脚本      ${green}30.${plain} 使用说明（全部子命令、参数、环境变量与场景配方）
    ${green}0.${plain}  退出脚本
    "
echo && read -ep "请输入选择 [0-30]: " num

  case "${num}" in
  0)
    exit 0
    ;;
  1)
    install_and_maybe_reset
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
  12)
    reset
    ;;
  13)
    show_status
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
    install_and_maybe_reset 0
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
  "status")
    show_status 0
    ;;
  "-h" | "--help" | "help")
    show_usage
    exit 0
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
  "reset")
    shift
    reset 0 "$@"
    exit $?
    ;;
  *) show_usage ;;
  esac
else
  show_menu
fi
