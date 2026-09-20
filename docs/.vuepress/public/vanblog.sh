#!/bin/bash

#========================================================
#   System Required: CentOS 7+ / Debian 8+ / Ubuntu 16+ /
#     Arch 未测试
#   Description: vanblog 安装脚本
#   Github: https://github.com/CKboss/vanblog（原始项目：https://github.com/Mereithhh/vanblog）
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
VANBLOG_SCRIPT_VERSION="v0.6.0"

# ── 装的是哪一个 VanBlog ──────────────────────────────────────────────
# 装的是本仓库 CKboss/vanblog 构建出来的镜像。
#
# 默认走「拉镜像」：ghcr.io/ckboss/vanblog:latest 由 .github/workflows/publish-ghcr.yml
# 在 GitHub 的 runner 上构建并发布，本机只需要 docker pull —— 这样 1C1G 的小机器也能装
# （源码构建要跑 umi + next 的生产构建，峰值 1.5-4GB，小机器必挂）。
#
# 拉不到就**自动退回源码构建**（镜像还没发布 / 网络不通 ghcr / 架构没有对应镜像，
# 比如只发布了 amd64 而机器是 arm64）。也可以手动指定：
#   VANBLOG_INSTALL_MODE=image   ./vanblog.sh   # 只拉镜像，拉不到就报错
#   VANBLOG_INSTALL_MODE=source  ./vanblog.sh   # 只源码构建（改了代码想自己出一个镜像时）
#   VANBLOG_IMAGE_REF=<ref>      ./vanblog.sh   # 换镜像地址（自己的 registry / 特定 sha）
#   VANBLOG_USE_UPSTREAM_IMAGE=true ./vanblog.sh  # 逃生口：改用别处的官方镜像（不含本仓库改动）
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
# 本仓库镜像的地址（由 publish-ghcr workflow 推送）。
# ⚠️ 默认是 `latest`，**不是** `dev-dsh` —— 这是实测出来的结论，别改回去：
#    publish-ghcr 只在「推 v* 标签」和「手动 workflow_dispatch」时构建（branches: 触发是关掉的），
#    所以 `dev-dsh` 只在有人手动构建时才动，而 `latest` 跟着最近一次发布构建走。
#    2026-09-18 实测 ghcr：`latest` 与 `v2026.9.2` 同 digest（镜像内 VAN_BLOG_VERSION=v2026.9.2@23f2e9c，
#    构建于 09-17），而 `dev-dsh` 还是 `dev-dsh@b31a1ec`（09-13，**旧 4 天**）——
#    默认值用 dev-dsh 意味着 `./vanblog.sh update` 会把站点**降级**到发布版之前，
#    整轮安全修复（含三个未认证漏洞）都会被悄悄回滚掉。
#    想要分支构建：VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:dev-dsh
#    想钉死某一版：VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:v2026.9.2，或直接 `./vanblog.sh update v2026.9.2`
VANBLOG_IMAGE_REF="${VANBLOG_IMAGE_REF:-ghcr.io/ckboss/vanblog:latest}"
# 镜像名（不含 tag）：`update <tag>` 拼完整 ref 时用。
# ⚠️ 从上面那行**推导**，不要再写一遍仓库地址 —— 两处各写一次迟早会漂，而且漂了守卫也发现不了
#    （docs-consistency 只把上面那行的默认值与文档对账）。副作用是有意的：用户把
#    VANBLOG_IMAGE_REF 指到镜像加速地址时，`update <tag>` 也跟着走他的加速地址。
VANBLOG_FORK_IMAGE="${VANBLOG_IMAGE_REF%%:*}"
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

# Ordered fallbacks —— **fork 优先**：本分支的三个源（GitHub raw → jsDelivr → Release 附件）
# 全部试过之后，才允许退到上游作者的源（文档站 → GitHub raw → jsDelivr）。
# 为什么：本分支的 raw 地址就是 raw.githubusercontent.com，而它在国内网络下常常不通；
# 以前的顺序会在它失败后**静默退到上游**（vanblog.mereith.com / Mereithhh raw / jsDelivr），
# 用户就此装上了不含本分支任何加固（日志上限、mongo 7 默认、整站备份、ghcr 镜像）的上游产物。
# jsDelivr 的 gh/CKboss/vanblog@dev/dsh/… 与 Release 附件（release-fork.yml 挂的
# vanblog.sh / docker-compose-template.yml，tag 约定 v*，默认取 latest）都是 fork 自己的可达镜像。
# 下载成功后仍然会打印"实际用的是哪个 URL"，并且照旧做完整性校验（bash -n / 占位符）。
VANBLOG_RELEASE_TAG="${VANBLOG_RELEASE_TAG:-latest}"
COMPOSE_URL_FORK="https://raw.githubusercontent.com/CKboss/vanblog/${VANBLOG_BRANCH}/docker-compose/docker-compose-template.yml"
SCRIPT_URL_FORK="https://raw.githubusercontent.com/CKboss/vanblog/${VANBLOG_BRANCH}/scripts/vanblog.sh"
COMPOSE_URL_FORK_JSDELIVR="https://cdn.jsdelivr.net/gh/CKboss/vanblog@${VANBLOG_BRANCH}/docker-compose/docker-compose-template.yml"
SCRIPT_URL_FORK_JSDELIVR="https://cdn.jsdelivr.net/gh/CKboss/vanblog@${VANBLOG_BRANCH}/scripts/vanblog.sh"
# GitHub 的 releases/latest/download/<asset> 会自动 302 到最新 Release 的同名附件；
# 钉住某个 tag（VANBLOG_RELEASE_TAG=v2026.09）时走 releases/download/<tag>/<asset>
if [[ "${VANBLOG_RELEASE_TAG}" == "latest" ]]; then
  COMPOSE_URL_FORK_RELEASE="https://github.com/CKboss/vanblog/releases/latest/download/docker-compose-template.yml"
  SCRIPT_URL_FORK_RELEASE="https://github.com/CKboss/vanblog/releases/latest/download/vanblog.sh"
else
  COMPOSE_URL_FORK_RELEASE="https://github.com/CKboss/vanblog/releases/download/${VANBLOG_RELEASE_TAG}/docker-compose-template.yml"
  SCRIPT_URL_FORK_RELEASE="https://github.com/CKboss/vanblog/releases/download/${VANBLOG_RELEASE_TAG}/vanblog.sh"
fi
COMPOSE_URL="https://vanblog.mereith.com/docker-compose-template.yml"
COMPOSE_URL_GITHUB="https://raw.githubusercontent.com/Mereithhh/vanblog/master/docker-compose/docker-compose-template.yml"
COMPOSE_URL_JSDELIVR="https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/docker-compose/docker-compose-template.yml"
SCRIPT_URL="https://vanblog.mereith.com/vanblog.sh"
SCRIPT_URL_GITHUB="https://raw.githubusercontent.com/Mereithhh/vanblog/master/scripts/vanblog.sh"
SCRIPT_URL_JSDELIVR="https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/scripts/vanblog.sh"
GITHUB_URL="dn-dao-github-mirror.daocloud.io"
# ⚠️ 装 docker 时脚本会把 ${Get_Docker_URL}（CN 分支 = 上游作者主机上的 docker.sh）
# 用 root 通过 `bash <(curl …)` 管道执行 —— 这是上游遗留行为，文档里有明确警告
# （docs/guide/script.snippet.md），不放心的用户应先自行安装 docker 再跑本脚本。
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

# ── depends_on 长格式（condition: service_healthy）的兼容性 ─────────────────
# 长格式要 docker-compose ≥1.27 或 compose v2 才解析得了：1.25（Ubuntu 20.04 自带）
# 对 v3.x 文件里的 depends_on **只认字符串列表**（实测 1.25.5 的 config_schema_v3.4.json：
# depends_on = list_of_strings），写上 condition 整个文件直接解析失败、栈起不来。
# 版本号字符串五花八门（1.25.5 / v2.20.2 / 本脚本自建的 shim……），所以**不猜版本、直接实测**：
# 拿一个用 condition 的最小临时编排文件跑一次 `docker-compose config`，退出码 0 = 支持。
# 探测文件带 version: '3.4'，与真正生成的编排文件同形状 —— 某些 1.27+ 对带版本号文件
# 仍按老 schema 校验的话，实测结果也如实反映"这台机器解析不了"。结果缓存，config 只探测一次。
VANBLOG_COMPOSE_COND_SUPPORT=""

compose_supports_depends_condition() {
  if [[ -n "${VANBLOG_COMPOSE_COND_SUPPORT}" ]]; then
    [[ "${VANBLOG_COMPOSE_COND_SUPPORT}" == "yes" ]]
    return $?
  fi
  VANBLOG_COMPOSE_COND_SUPPORT="no"
  if command -v docker-compose >/dev/null 2>&1; then
    local probe
    probe="$(mktemp "${TMPDIR:-/tmp}/vanblog-cond-probe.XXXXXX" 2>/dev/null)" || probe=""
    if [[ -n "${probe}" ]]; then
      cat >"${probe}" <<'YML'
version: '3.4'
services:
  probe_a:
    image: alpine:3
    depends_on:
      probe_b:
        condition: service_healthy
  probe_b:
    image: alpine:3
YML
      if docker-compose -f "${probe}" config >/dev/null 2>&1; then
        VANBLOG_COMPOSE_COND_SUPPORT="yes"
      fi
      rm -f "${probe}"
    fi
  fi
  [[ "${VANBLOG_COMPOSE_COND_SUPPORT}" == "yes" ]]
}

# mongo 服务块里有没有 healthcheck（service_healthy 的前提：没有健康检查的依赖，
# compose v2 会直接拒绝启动 dependents；老 v1 则根本走不到这一步）
compose_mongo_has_healthcheck() {
  local compose_file="$1"
  awk '
    /^  mongo:[[:space:]]*$/ { f = 1; next }
    f && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { f = 0 }
    f && /^    healthcheck:/ { print "yes"; exit }
  ' "${compose_file}" 2>/dev/null | grep -q yes
}

# 把编排文件里 vanblog→mongo 的 depends_on 同步成本机 compose 支持的形状：
#   支持长格式 + 文件是列表形式 + mongo 有 healthcheck → 升级成 condition: service_healthy
#   不支持长格式 + 文件是长格式                        → 降级回列表形式（并打印原因）
#   其余情况一律不动（用户手改过的异形 depends_on 不碰，改不动就保持现状）
# awk 重写到临时文件、确认成功且非空才 mv：sed/awk 出任何岔子都不会把编排文件改坏。
apply_depends_on_form() {
  local compose_file="$1"
  [[ -f "${compose_file}" ]] || return 0
  local has_long=0 has_list=0
  grep -qE '^        condition:[[:space:]]*service_healthy' "${compose_file}" && has_long=1
  grep -qE '^      - mongo[[:space:]]*$' "${compose_file}" && has_list=1
  local tmp rc
  if compose_supports_depends_condition; then
    if [[ ${has_list} -eq 1 ]]; then
      if compose_mongo_has_healthcheck "${compose_file}"; then
        tmp="${compose_file}.depends.$$"
        awk '
          /^    depends_on:[[:space:]]*$/ {
            print
            if ((getline nxt) > 0) {
              if (nxt ~ /^      - mongo[[:space:]]*$/) {
                print "      mongo:"
                print "        condition: service_healthy"
                upgraded = 1
              } else { print nxt }
            }
            next
          }
          { print }
          END { exit(upgraded ? 0 : 3) }
        ' "${compose_file}" >"${tmp}" 2>/dev/null
        rc=$?
        if [[ ${rc} -eq 0 && -s "${tmp}" ]]; then
          mv -f "${tmp}" "${compose_file}"
          echo -e "> depends_on 已升级为长格式：vanblog 会等 mongo ${green}健康检查通过${plain}再启动（本机 compose 实测支持 condition）"
        else
          rm -f "${tmp}"
        fi
      else
        echo -e "> 编排文件里 mongo 没有 healthcheck（可能是旧模板），depends_on 保持列表形式：只保证 mongo 先启动，不等它就绪"
      fi
    fi
  else
    if [[ ${has_long} -eq 1 ]]; then
      tmp="${compose_file}.depends.$$"
      awk '
        /^    depends_on:[[:space:]]*$/ {
          if ((getline nxt) > 0) {
            if (nxt ~ /^      mongo:[[:space:]]*$/) {
              if ((getline nxt2) > 0 && nxt2 ~ /^        condition:[[:space:]]*service_healthy[[:space:]]*$/) {
                print "    depends_on:"
                print "      - mongo"
                downgraded = 1
                next
              }
              print "    depends_on:"; print nxt; print nxt2; next
            }
            print "    depends_on:"; print nxt; next
          }
          print "    depends_on:"
          next
        }
        { print }
        END { exit(downgraded ? 0 : 3) }
      ' "${compose_file}" >"${tmp}" 2>/dev/null
      rc=$?
      if [[ ${rc} -eq 0 && -s "${tmp}" ]]; then
        mv -f "${tmp}" "${compose_file}"
        echo -e "> ${yellow}本机 docker-compose 不支持 depends_on 的 condition 长格式（<1.27 且非 compose v2，实测 docker-compose config 失败），已降级为列表形式：mongo 先启动但 vanblog 不等它就绪（server 自己会重试连库）${plain}"
      else
        rm -f "${tmp}"
      fi
    else
      echo -e "> 本机 docker-compose 较老（不支持 depends_on.condition，实测），编排文件保持列表形式：mongo 先启动但 vanblog 不等它就绪（server 自己会重试连库）"
    fi
  fi
  return 0
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

# 镜像里烙的版本号（构建时由 VAN_BLOG_VERSIONS 写进 ENV，形如 v2026.9.2@23f2e9c）。
# 与 get_container_version 的区别：这个读**镜像**，所以能在停旧容器**之前**就知道要换成哪一版。
get_image_version() {
  local img="$1"
  if [[ -z "${img}" ]]; then
    return 0
  fi
  docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${img}" 2>/dev/null \
    | awk -F= '$1 == "VAN_BLOG_VERSION" { print $2; exit }'
}

# 版本号形如 `<tag>@<短sha>`（tag 可能是 v2026.9.2 / latest / dev-dsh / dev-dsh-abc1234），
# 也可能是裸 semver（0.54.0）。下面三个函数只在**能证明**的时候才下结论，
# 证明不了就明说"证明不了"，绝不猜 —— 猜错的方向恰好是最贵的那个（把降级说成升级）。
version_sha() { # <version> → @ 后面的构建 sha（没有就空）
  local v="${1:-}"
  [[ "${v}" == *@* ]] && printf '%s' "${v##*@}"
  return 0
}

version_release_numbers() { # <version> → "主 次 修"；不是发布号就返回 1
  local v="${1%%@*}"
  [[ "${v}" =~ ^v?([0-9]+)\.([0-9]+)(\.([0-9]+))?$ ]] || return 1
  # ⚠️ 修必须取 BASH_REMATCH[4]（内层组），不是 [3] —— [3] 是 `(\.([0-9]+))` 整个组，
  #    **带着那个点**。用错的下场是实测出来的：`v2026.9.1` 与 `v2026.9.2` 走到第三段比较时
  #    触发 `((: .2: syntax error: operand expected`，算术退化成 0 ⇒ 判成 `same` ⇒
  #    **真降级被当成"版本没有变化"**，绕过 WARN 与确认照常重启。
  #    而 mock 测试用的 `0.53.0` vs `0.54.0` 在第二段就分出胜负、永远走不到出错的第三段，
  #    所以 86 条断言全绿也没发现 —— 本项目真实版本号是 `v2026.9.x`，恰恰只有第三段能区分。
  #    **教训：比较逻辑的测试必须用产品真实会出现的取值形状，不能只用"好算"的那一种。**
  printf '%s %s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[4]:-0}"
}

# 比较"正在跑的版本"与"要换上去的镜像版本"：
#   same        同一个构建（sha 相同），或发布号数字相同
#   newer       能证明更新
#   downgrade   能证明更旧 ⇒ 必须醒目 WARN + 要人确认
#   unprovable  当前是发布号、目标不是（latest/dev-dsh/读不出版本）⇒ **无法证明不更旧**，
#               同样按"可能是降级"处理。实测就是这个形状：v2026.9.2@23f2e9c → dev-dsh@b31a1ec
#               旧了 4 天，而两个字符串无论怎么比都得不出"更旧"，只能靠"目标不是发布号"识别。
#   unknown     没有正在跑的容器（或两边都读不出版本），无从比较，不拦
version_change_kind() { # <old> <new> → 打印上面五个之一
  local old="${1:-}" new="${2:-}"
  if [[ -z "${old}" ]]; then
    printf 'unknown'
    return 0
  fi
  if [[ -z "${new}" ]]; then
    printf 'unprovable'
    return 0
  fi
  local osha nsha
  osha="$(version_sha "${old}")"
  nsha="$(version_sha "${new}")"
  if [[ -n "${osha}" && "${osha}" == "${nsha}" ]]; then
    printf 'same'
    return 0
  fi
  local onum nnum
  if onum="$(version_release_numbers "${old}")" && nnum="$(version_release_numbers "${new}")"; then
    local o1 o2 o3 n1 n2 n3
    read -r o1 o2 o3 <<<"${onum}"
    read -r n1 n2 n3 <<<"${nnum}"
    # ⚠️ 六个数必须**都是纯整数**才敢做算术。bash 的 (( )) 遇到 `.2` 这种值会打印
    #    syntax error 到 stderr、然后把该子表达式当 0 —— 于是"证明不了"会伪装成"相等(same)"，
    #    而 same 是**不拦**的分支（真降级就这么溜过去了）。所以这里宁可退回 unprovable：
    #    证明不了就按"可能更旧"处理，让人来确认。这条防线是为了让上面那个 BASH_REMATCH
    #    下标 bug 这类错误**永远不可能再静默变成 same**。
    local n
    for n in "${o1}" "${o2}" "${o3}" "${n1}" "${n2}" "${n3}"; do
      if [[ ! "${n}" =~ ^[0-9]+$ ]]; then
        printf 'unprovable'
        return 0
      fi
    done
    if ((n1 < o1)) || ((n1 == o1 && n2 < o2)) || ((n1 == o1 && n2 == o2 && n3 < o3)); then
      printf 'downgrade'
    elif ((n1 > o1)) || ((n1 == o1 && n2 > o2)) || ((n1 == o1 && n2 == o2 && n3 > o3)); then
      printf 'newer'
    else
      printf 'same'
    fi
    return 0
  fi
  # 只有一边是发布号：当前是发布号而目标不是 ⇒ 证明不了不更旧
  if version_release_numbers "${old}" >/dev/null 2>&1; then
    printf 'unprovable'
    return 0
  fi
  printf 'unknown'
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
  printf '%s\n' \
    "${COMPOSE_URL_FORK}" \
    "${COMPOSE_URL_FORK_JSDELIVR}" \
    "${COMPOSE_URL_FORK_RELEASE}" \
    "${COMPOSE_URL}" \
    "${COMPOSE_URL_GITHUB}" \
    "${COMPOSE_URL_JSDELIVR}"
}

script_urls() {
  printf '%s\n' \
    "${SCRIPT_URL_FORK}" \
    "${SCRIPT_URL_FORK_JSDELIVR}" \
    "${SCRIPT_URL_FORK_RELEASE}" \
    "${SCRIPT_URL}" \
    "${SCRIPT_URL_GITHUB}" \
    "${SCRIPT_URL_JSDELIVR}"
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
    # 用 latest-stable 而不是写死某个 v3.x：基础镜像的 Alpine 版本会随 node:24-alpine 漂移
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
#
# ⚠️ 离线 / air-gapped 场景（2026-09-20 修）：这个函数以前**无条件** `docker pull`，
#    拉不到就 `return 1` —— 而它失败时打印的第 2 条建议（"在大机器上 save、拷过来 load，
#    再用 VANBLOG_IMAGE_REF=vanblog:<tag> 重跑"）**仍然会走同一个 pull**，于是照着自己的
#    建议做也必然失败。断网的机器上根本装不起来，而"部署要非常方便"是这个项目的硬要求。
#    现在有两条出路：
#      - `VANBLOG_SKIP_PULL=1`：**绝不联网**，只用本地已有的镜像（没有就明确报错）；
#      - 默认路径：先照常 pull（⚠️ 不能跳过，否则 `latest` 这类会移动的标签永远升不上去），
#        **pull 失败但本地已有一份**时回落到本地镜像，并把"这不是最新的"说清楚。
pull_fork_image() {
  if ! command -v docker >/dev/null 2>&1; then
    echo -e "${red}未找到 docker，无法拉取镜像${plain}"
    return 1
  fi

  # ① 显式离线：一次网络都不碰。适合 air-gapped 机器与"我知道本地这份就是我要的"。
  if [[ "${VANBLOG_SKIP_PULL:-}" == "1" ]]; then
    if docker image inspect "${VANBLOG_IMAGE_REF}" >/dev/null 2>&1; then
      echo -e "> ${yellow}VANBLOG_SKIP_PULL=1${plain}：使用本地镜像 ${yellow}${VANBLOG_IMAGE_REF}${plain}（未联网）"
      return 0
    fi
    echo -e "${red}VANBLOG_SKIP_PULL=1 但本机没有这个镜像：${VANBLOG_IMAGE_REF}${plain}"
    echo -e "${yellow}  先把镜像弄到本机再重跑：在有网的机器上 docker pull + docker save，拷过来 docker load -i <文件>${plain}"
    echo -e "${yellow}  （或者去掉 VANBLOG_SKIP_PULL=1，让它联网拉取）${plain}"
    return 1
  fi

  echo -e "> 拉取本分支镜像 ${yellow}${VANBLOG_IMAGE_REF}${plain}"
  # 把输出接住再打出来，这样才能按失败原因给出**具体**的下一步，
  # 而不是笼统一句"拉取失败"（标签不存在、架构不匹配、网络不通，都是常见原因）
  local out rc
  out="$(docker pull "${VANBLOG_IMAGE_REF}" 2>&1)"
  rc=$?
  [[ -n "${out}" ]] && printf '%s\n' "${out}"
  if [[ ${rc} -eq 0 ]]; then
    return 0
  fi

  # ② 拉不到，但本地已经有一份 ⇒ 用它，别让整个安装/更新中止。
  #    ⚠️ 必须说得很难听：这份可能不是最新的，用户要知道自己跑的是旧版。
  if docker image inspect "${VANBLOG_IMAGE_REF}" >/dev/null 2>&1; then
    echo -e "${yellow}⚠️ 拉取失败，但本机已有 ${VANBLOG_IMAGE_REF}，改用本地这份继续。${plain}"
    echo -e "${yellow}   它可能不是最新版本（联网时才拉得到新的）。想强制只用本地镜像、完全不联网：VANBLOG_SKIP_PULL=1${plain}"
    echo -e "${yellow}   想看这份本地镜像是哪一版：docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${VANBLOG_IMAGE_REF} | grep VAN_BLOG_VERSION${plain}"
    return 0
  fi

  case "${out}" in
    *denied*|*unauthorized*|*authentication*)
      # ⚠️ 这里以前写的是"ghcr 的 package 默认是 private，去改成 Public" —— 那个包**早就是 public**
      #    了（实测匿名取 manifest 与 tags/list 都是 200），照旧文案去改可见性只会白费功夫，
      #    还会让人以为项目没发布。denied 的真实原因通常是下面三个。
      echo -e "${yellow}  这个包在 ghcr 上是 public（匿名就能拉），所以 denied 一般不是可见性问题，而是：${plain}"
      echo -e "${yellow}    - 标签写错了：确认 ${VANBLOG_IMAGE_REF##*:} 真的存在${plain}"
      echo -e "${yellow}      → https://github.com/CKboss/vanblog/pkgs/container/vanblog${plain}"
      echo -e "${yellow}    - 中间有个要求登录的镜像加速/代理（换一个，或 docker login ghcr.io 后再试）${plain}"
      echo -e "${yellow}    - 触发了 ghcr 的匿名拉取限流（等几分钟再试）${plain}"
      ;;
    *"no matching manifest"*|*"not found"*)
      echo -e "${yellow}  没有匹配本机架构（$(uname -m 2>/dev/null || echo 未知)）的镜像：目前只发布 linux/amd64。${plain}"
      echo -e "${yellow}  arm64 机器可以在 Actions 里手动触发 publish-ghcr 并把 platforms 填成 linux/arm64。${plain}"
      ;;
    *)
      echo -e "${yellow}  拉取失败（镜像可能还没发布，或网络到不了 ghcr.io）${plain}"
      echo -e "${yellow}  国内机器拉 ghcr.io 经常超时，三条路：${plain}"
      echo -e "    1) 走镜像加速：${green}VANBLOG_IMAGE_REF=<你的 ghcr 镜像地址>/ckboss/vanblog:${VANBLOG_IMAGE_REF##*:} $0${plain}"
      echo -e "       （例如 ghcr.nju.edu.cn 这类公共加速域名，能不能用取决于当下网络，别写死在脚本里）"
      echo -e "    2) 在大机器上 ${green}docker pull${plain} + ${green}docker save${plain}，拷到本机 ${green}docker load${plain}，"
      echo -e "       然后 ${green}VANBLOG_INSTALL_MODE=image VANBLOG_IMAGE_REF=vanblog:${VANBLOG_IMAGE_REF##*:} $0${plain}"
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
    echo -e "> 编排文件里的镜像与本次要用的不一致：${yellow}${current}${plain} → ${yellow}${Docker_IMG}${plain}（已改写 image: 行）"
    echo -e "  ⚠️ 之后 restart / up -d 起的都是新 ref；想钉死某一版用 ${green}$0 update <发布号>${plain}"
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
      # 服务端从本轮起会在写完后自校验归档（响应里带 verified / verifySeconds，
      # 校验失败直接 HTTP 400），所以这里把它显式打出来：备份"成功"与"可恢复"是两件事。
      if [ -n "${_vb_verified:-}" ]; then
        echo -e "  自校验  ：${green}${_vb_verified}${plain}（耗时 ${_vb_verify_seconds:-?} 秒）"
      fi
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
  # depends_on 的形状按本机 compose 的实际解析能力定（模板提交的是所有版本都能解析的
  # 列表形式；本机支持 condition 长格式就升级成「等 mongo 健康检查通过」，见函数注释）
  apply_depends_on_form "${VANBLOG_BASE_PATH}/docker-compose.yaml"
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
print_update_usage() {
  echo -e "用法：${yellow}$0 update [版本号 | 完整镜像 ref]${plain}"
  echo -e "  $0 update                             升到默认镜像（现在是 ${VANBLOG_IMAGE_REF}）"
  echo -e "  $0 update v2026.9.2                   升到指定发布版（= ${VANBLOG_FORK_IMAGE}:v2026.9.2，内容固定不变）"
  echo -e "  $0 update dev-dsh-abc1234             回到某一次具体的构建（回滚用）"
  echo -e "  $0 update ghcr.io/foo/bar:tag         带 / 或 :// 的参数当完整镜像 ref 原样用（私有 registry / 加速地址）"
  echo -e "等价写法：VANBLOG_IMAGE_REF=${VANBLOG_FORK_IMAGE}:v2026.9.2 $0 update"
  echo -e "⚠️ 参数打错会**直接拒绝**（退出码 2）并打印本用法，不会静默按默认值升级"
}

# 动手拉镜像之前先说清"这个 ref 是什么含义"：发布号是钉死的，latest/dev-dsh 是会移动的。
# 之所以要说，是因为"我 update 了怎么版本反而旧了"这个困惑，根源就在标签会不会移动。
describe_image_ref() { # <ref>
  local ref="${1:-}" tag="${1##*:}"
  case "${tag}" in
  v[0-9]*)
    echo -e "> 目标镜像：${yellow}${ref}${plain}（发布号：内容固定不变，随时说得清装的是哪一版）"
    ;;
  latest)
    echo -e "> 目标镜像：${yellow}${ref}${plain}（最近一次发布构建；⚠️ 会随下次发版移动，不是钉死的版本）"
    ;;
  dev-dsh)
    echo -e "> 目标镜像：${yellow}${ref}${plain}（分支最近一次**手动**构建；⚠️ push 不触发构建，可能比发布版旧）"
    ;;
  dev-dsh-*)
    echo -e "> 目标镜像：${yellow}${ref}${plain}（某一次具体的分支构建，内容固定）"
    ;;
  *)
    echo -e "> 目标镜像：${yellow}${ref}${plain}"
    ;;
  esac
}

# 降级（或"证明不了不更旧"）时的确认。设计原则：**WARN 永远照打**，只有"阻塞"这一步看环境 ——
# 交互终端要人点头；非交互（cron / 管道）没人能回答，那就打印清楚后继续，绝不停在那儿吊着。
confirm_or_warn_downgrade() { # 返回 0 = 继续，1 = 用户明确取消
  if [[ "${VANBLOG_ASSUME_YES:-0}" == "1" ]]; then
    echo -e "${yellow}   VANBLOG_ASSUME_YES=1：不阻塞，继续（但上面那条 WARN 请认真看）${plain}"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    echo -e "${yellow}   当前不是交互终端（cron / 管道），没人能回答 ⇒ 继续；不想冒险就别在非交互环境里升级${plain}"
    return 0
  fi
  local input
  read -e -r -p "确认继续? [y/N] " input
  case $input in
  [yY][eE][sS] | [yY]) return 0 ;;
  *)
    echo "已取消升级（旧容器仍在运行，什么都没动）"
    return 1
    ;;
  esac
}

update() {
  local skip_menu=0
  if [[ $# -gt 0 ]]; then
    skip_menu=1
    # ⚠️ 第一个位置参数一直是"从菜单外调进来"的标志（dispatcher 传 `0`），**不是版本号**。
    #    先摘掉它，剩下的才是 `update <版本|完整 ref>` 的参数 —— 这样 `update 0`（老写法）
    #    与 `update 0 v2026.9.2`（dispatcher 透传）都对，菜单里不带参数的调用也不受影响。
    shift
  fi

  # ── 版本参数：`./vanblog.sh update v2026.9.2` = 一行命令升到指定版本 ──────────
  # 为什么要有这个写法：不带参数时用的是 VANBLOG_IMAGE_REF 的默认值（一个会移动的标签），
  # 而"升到某个发布版"必须显式指定 —— 站长实测的困惑正是"我以为 update 就是升到最新版"。
  local want_ref="" arg
  for arg in "$@"; do
    case "${arg}" in
    -h | --help)
      show_usage
      return 0
      ;;
    -*)
      # 打错的参数一律**明确拒绝**，绝不静默按默认值升级（本脚本的一贯要求）
      echo -e "${red}update 不认这个参数：${arg}${plain}"
      print_update_usage
      if [[ ${skip_menu} == 0 ]]; then
        before_show_menu
      fi
      return 2
      ;;
    */* | *://*)
      # 含 `/` 或 `://` ⇒ 当成完整镜像 ref 原样用（私有 registry / 镜像加速地址）
      want_ref="${arg}"
      ;;
    *)
      # 其余 ⇒ 当成 tag，拼到本仓库镜像名后面（镜像名从 VANBLOG_IMAGE_REF 推导，不硬编码第二遍）
      want_ref="${VANBLOG_FORK_IMAGE}:${arg}"
      ;;
    esac
  done
  if [[ $# -gt 1 ]]; then
    echo -e "${red}只能指定一个版本/镜像参数（收到 $# 个）${plain}"
    print_update_usage
    if [[ ${skip_menu} == 0 ]]; then
      before_show_menu
    fi
    return 2
  fi

  if [[ -n "${want_ref}" ]]; then
    if use_upstream_image; then
      # VANBLOG_USE_UPSTREAM_IMAGE=true 时镜像不是本仓库的，拼出来的 tag 大概率不存在。
      # 与其悄悄拼一个假 ref 让人在 pull 阶段失败，不如在这里说清楚。
      echo -e "${red}VANBLOG_USE_UPSTREAM_IMAGE=true 时不能指定版本参数（收到：${want_ref}）${plain}"
      echo -e "  那个开关用的是别处的官方镜像，标签体系与本仓库的发布号无关，拼出来的 tag 不存在。"
      echo -e "  要指定版本：去掉 VANBLOG_USE_UPSTREAM_IMAGE 再跑，或直接改编排文件里的 image: 行。"
      if [[ ${skip_menu} == 0 ]]; then
        before_show_menu
      fi
      return 2
    fi
    VANBLOG_IMAGE_REF="${want_ref}"
  fi

  echo -e "> 更新服务"
  # 动手之前先说清"这次会得到什么"。⚠️ 上游镜像模式下走的不是 VANBLOG_IMAGE_REF
  # （镜像由编排文件决定），所以那一条要单独印，否则会报一个根本不是目标的地址。
  if use_upstream_image; then
    echo -e "> 目标镜像：${yellow}${Docker_IMG:-（按编排文件里的 image）}${plain}（VANBLOG_USE_UPSTREAM_IMAGE=true：跟着编排走，不接受版本参数）"
  else
    describe_image_ref "${VANBLOG_IMAGE_REF}"
  fi

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

  # ── 停容器之前，把"版本会怎么变"说清楚 ─────────────────────────────────
  # 为什么必须在 down 之前：一旦停了旧容器，"原来跑的是哪一版"就只能靠记忆了；
  # 而"以为是升级、其实是降级"这件事，要在还能零代价反悔的时候说出来（此刻旧容器还在跑）。
  local new_image_version vkind
  if use_upstream_image; then
    new_image_version="$(get_image_version "$(get_compose_vanblog_image 2>/dev/null)")"
  else
    new_image_version="$(get_image_version "${Docker_IMG}")"
  fi
  echo -e "> 当前运行: ${yellow}${old_version:-未知}${plain} → 新镜像: ${yellow}${new_image_version:-未知}${plain}"
  vkind="$(version_change_kind "${old_version}" "${new_image_version}")"
  case "${vkind}" in
  downgrade)
    echo -e "${red}⚠️⚠️ 这是**降级**：新镜像 ${new_image_version} 比正在跑的 ${old_version} 旧${plain}"
    echo -e "${red}   要升到发布版请用发布号，例如：$0 update v2026.9.2${plain}"
    if ! confirm_or_warn_downgrade; then
      if [[ ${skip_menu} == 0 ]]; then
        before_show_menu
      fi
      return 0
    fi
    ;;
  unprovable)
    echo -e "${red}⚠️ 证明不了新镜像不比当前旧：当前 ${old_version} 是发布号，目标 ${new_image_version:-（镜像里读不出 VAN_BLOG_VERSION）} 不是${plain}"
    echo -e "${yellow}   会移动的标签（latest / dev-dsh）可能比发布版旧 —— 实测过 dev-dsh 比当时的发布版旧 4 天，${plain}"
    echo -e "${yellow}   直接 update 会把整轮安全修复悄悄回滚掉。要钉死版本：$0 update <发布号>${plain}"
    if ! confirm_or_warn_downgrade; then
      if [[ ${skip_menu} == 0 ]]; then
        before_show_menu
      fi
      return 0
    fi
    ;;
  same)
    echo -e "> 版本没有变化（同一个构建）"
    ;;
  esac

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

# 把字节数格式化成人能读的形式（human_size 收的是**文件路径**，走 du；
# 这个收的是数字 —— 清理备份时要先算总量再打印，那时文件已经删了）
human_bytes() {
  local n="${1:-0}"
  case "${n}" in
  '' | *[!0-9]*) n=0 ;;
  esac
  awk -v b="${n}" 'BEGIN {
    if (b < 1024) { printf "%d B", b }
    else if (b < 1048576) { printf "%.1f KB", b / 1024 }
    else if (b < 1073741824) { printf "%.1f MB", b / 1048576 }
    else { printf "%.2f GB", b / 1073741824 }
  }'
}

human_size() {
  local file="$1"
  if command -v du >/dev/null 2>&1; then
    du -h "${file}" 2>/dev/null | awk '{print $1}'
  fi
}

# ── 备份完整性：sha256 sidecar 与 verify 子命令 ─────────────────────────────
# ⚠️ 这里以前写着"server 导出的 manifest 里没有校验和（只写 totals.archiveBytes）"——
# **已经过时了**：server 现在会在归档里写一个 `integrity` 块（每个成员的 sha256 与字节数、
# 按成员名排序拼接算出的 merkleRoot、zstd 流是否带帧校验和、含目录项的 memberCount，
# 以及与 manifest.json 逐字节相同的双清单 ./MANIFEST.copy.json），见
# packages/server/src/utils/fullBackup.ts 的 integrityEnabled()/BACKUP_INTEGRITY_ENV
# （`VANBLOG_BACKUP_INTEGRITY=off` 是逃生舱，默认开）。`verify-deep` 与 `drill` 用的就是它。
# 那 sidecar 还有用吗？有，但职责窄了，别把两件事混为一谈：
#   - **内部** integrity 块证明"归档里每个成员的字节没坏"，但它和归档在一起 ——
#     归档整体被截断/替换时，内部块也跟着没了，所以还需要一个**外部**的凭据；
#   - 脚本自己做的备份（backup / backup --offline）成功后写 <归档>.sha256 sidecar
#     （格式同 sha256sum 输出："hex  文件名"），拷归档去别处时把 sidecar 一起带上；
#   - `verify`（旧、宽松、要 root）优先用它比对；**没有 sidecar 的归档（server 导出/旧归档）
#     照常校验**完整性与内容，只是明说"没有 sha256 记录，跳过比对" —— 恢复流程完全不受影响；
#   - ⚠️ 旧归档**没有** integrity 块，此时成员级检查会**大声降级**（WARN + 结论行注明
#     "不含逐成员比对"），绝不让人把"没查"读成"查过且通过"。

# 给归档记 sha256 sidecar。失败不影响备份本身（备份已经成功了，别反过来报错）。
# 备份成功后把归档（连同 .sha256 sidecar）复制到**第二个目的地** —— 异地/异盘的最小实现。
#
# ⚠️ 为什么内建而不是"叫用户自己 rsync"：归档固定在 <数据目录>/log/vanblog-backups，而 <数据目录>
#    就是编排挂出来的那个卷 ⇒ **备份和数据在同一个目录树、通常也在同一块盘上**。盘毁、被误删、
#    被勒索加密时，数据和备份一起没；而"我配了定时备份"这件事本身会让人不去检查。
#    （`rsync|s3|webdav|rclone` 在脚本与 server 里 0 命中，说明以前完全没有这个能力。）
# 设计取舍：
#   - 只做"复制 + 校验 + 按份数清理"，**不引入任何新依赖**（不要求 rsync/rclone/aws-cli）；
#     目的地可以是另一块盘、NFS 挂载点、或对象存储的 FUSE 挂载 —— 对脚本来说都只是一个目录。
#   - ⚠️ **目的地出问题绝不能让本地备份算失败**：本地成功 + 镜像失败 = WARN + 返回 0。
#     理由是备份的价值排序很清楚：手边有一份 >> 远处有一份 >> 因为远处写不进去而两份都没有。
#   - 复制后必须**校验**（能比对 sha256 就比对，否则退到 zstd -t，再否则比字节数并明说"没真校验"）。
#   - 清理只碰 `vanblog-full-*.tar.zst`（以及加密的 `.tar.zst.enc`）与 `*.tar.gz` 这几种自己认识的名字，
#     **绝不**用通配删别的（`.enc` 必须单独列：`-name` 是整体匹配，`*.tar.zst` 匹配不到 `*.tar.zst.enc`）。
mirror_backup_artifacts() { # <归档路径>
  local src="$1"
  local dest="${VANBLOG_BACKUP_MIRROR_DIR:-}"
  [[ -n "${dest}" ]] || return 0            # 没配就什么都不做（默认行为一字不变）
  [[ -f "${src}" ]] || return 0

  if ! mkdir -p "${dest}" 2>/dev/null; then
    echo -e "  ${yellow}!${plain} 镜像目的地建不出来：${dest}（本地备份已成功，不影响结果）"
    return 0
  fi
  if [[ ! -w "${dest}" ]]; then
    echo -e "  ${yellow}!${plain} 镜像目的地不可写：${dest}（本地备份已成功，不影响结果）"
    return 0
  fi

  local base name f rc=0
  base="$(basename "${src}")"
  # 用临时名写完再 mv：目的地上如果有别的进程/脚本在读，不会读到半截归档
  if cp -p "${src}" "${dest}/.${base}.part" 2>/dev/null && mv -f "${dest}/.${base}.part" "${dest}/${base}" 2>/dev/null; then
    echo -e "  镜像    ：已复制到 ${yellow}${dest}/${base}${plain}"
  else
    rm -f "${dest}/.${base}.part" 2>/dev/null
    echo -e "  ${yellow}!${plain} 复制到镜像目的地失败：${dest}（本地备份已成功，不影响结果；查磁盘空间与权限）"
    return 0
  fi
  # sidecar 一起带过去（`.sha256` / `.manifest.json` / `.sig`），一律走共用助手枚举，
  # 别在这写第二份文件名清单 —— 上一轮就是因为只拷了 `.sha256` 而漏了别的。
  # 🔴 其中 `.sig` 是**这个功能存在的全部理由**：异地副本只有带着签名才"可证明没被改过"。
  #    没有 `.sig` 的异地副本，在"源站已被攻陷/主机 root 已丢"的场景下无法与一份被换掉的归档区分，
  #    于是恢复时只能选择相信它 —— 而那正是签名要避免的事。所以 `.sig` 缺失要**说清楚**，
  #    而不是和"本来就没签过"混成一句沉默。
  local sc scbase
  while IFS= read -r sc; do
    [[ -n "${sc}" ]] || continue
    scbase="$(basename "${sc}")"
    if cp -p "${sc}" "${dest}/${scbase}" 2>/dev/null; then
      case "${scbase}" in
      *.sig) echo -e "  镜像    ：已复制签名 ${yellow}${scbase}${plain}（指纹 $(signature_field_of "${src}" keyFingerprint || echo '?')）" ;;
      esac
    else
      echo -e "  ${yellow}!${plain} ${scbase} 没复制过去（归档本身已经复制了）"
    fi
  done < <(backup_sidecar_paths "${src}")
  if ! archive_has_signature "${src}"; then
    echo -e "  ${yellow}!${plain} 这份归档**没有 .sig 签名**（备份时没配 VANBLOG_BACKUP_SIGNING_KEY，或早于本功能）"
    echo -e "            ⇒ 异地副本只能证明「没拷坏」（sha256），**不能证明「没被换过」**。"
    echo -e "            要签：${VANBLOG_SELF_NAME} signing-key 生成密钥对，之后给容器配 VANBLOG_BACKUP_SIGNING_KEY(_FILE)。"
  fi

  # 校验：优先按 sidecar 比对，其次 zstd -t，最后只能比字节数（并且必须明说"没真校验"）
  if command -v sha256sum >/dev/null 2>&1 && [[ -f "${dest}/${base}.sha256" ]]; then
    if (cd "${dest}" && sha256sum -c "${base}.sha256" >/dev/null 2>&1); then
      echo -e "  镜像校验：${green}sha256 一致${plain}"
    else
      echo -e "  ${red}✗${plain} 镜像校验**不通过**（sha256 不一致）：${dest}/${base} —— 已删除这个坏副本"
      # ⚠️ 连 sidecar 一起删：留下一个"签名/校验和在、归档不在"的目的地，
      #    比什么都不留更危险（下一次比对会拿旧 sidecar 去配新归档）。
      rm -f "${dest}/${base}" "${dest}/${base}.sha256" "${dest}/${base}.manifest.json" "${dest}/${base}.sig" 2>/dev/null
      return 0
    fi
  elif command -v zstd >/dev/null 2>&1 && [[ "${base}" == *.zst ]]; then
    if zstd -t "${dest}/${base}" >/dev/null 2>&1; then
      echo -e "  镜像校验：${green}zstd -t 通过${plain}（没有 sidecar 可比，只验了压缩流完整性）"
    else
      echo -e "  ${red}✗${plain} 镜像校验不通过（zstd -t 失败）：已删除这个坏副本"
      rm -f "${dest}/${base}" "${dest}/${base}.sha256" "${dest}/${base}.manifest.json" "${dest}/${base}.sig" 2>/dev/null
      return 0
    fi
  else
    local a b
    a="$(wc -c <"${src}" 2>/dev/null)"; b="$(wc -c <"${dest}/${base}" 2>/dev/null)"
    if [[ -n "${a}" && "${a}" == "${b}" ]]; then
      echo -e "  镜像校验：${yellow}只比了字节数（${a}）${plain} —— 本机没有 sha256sum/zstd，这**不算真校验**"
    else
      echo -e "  ${red}✗${plain} 镜像副本字节数对不上（源 ${a:-?} / 副本 ${b:-?}）：已删除这个坏副本"
      rm -f "${dest}/${base}" "${dest}/${base}.sha256" "${dest}/${base}.manifest.json" "${dest}/${base}.sig" 2>/dev/null
      return 0
    fi
  fi

  # 按份数清理（只碰自己认识的两种名字）
  local keep="${VANBLOG_BACKUP_MIRROR_KEEP:-${VANBLOG_BACKUP_KEEP:-7}}"
  case "${keep}" in '' | *[!0-9]*) keep=7 ;; esac
  (( keep > 0 )) || return 0
  local old
  # ⚠️ `.enc` 必须单独列一条：`vanblog-full-*.tar.zst` **匹配不上** `…tar.zst.enc`
  #    （glob 的 `*` 不跨越末尾，`-name` 是整体匹配），漏掉的后果不是"少删一个"，而是
  #    **加密归档永远不会被清理** ⇒ 一直堆到磁盘满，而磁盘满会让之后每次备份都失败。
  #    ⚠️ 不要图省事放宽成 `vanblog-full-*.tar.*`：上面那段注释与既有守卫钉着
  #    "清理只碰自己认识的名字，绝不用通配删别的文件"，放宽等于削弱那条原则。
  old="$(find "${dest}" -maxdepth 1 -type f \( -name 'vanblog-full-*.tar.zst' -o -name 'vanblog-full-*.tar.zst.enc' -o -name 'vanblog-*-data.tar.gz' \) \
         -printf '%T@ %p\n' 2>/dev/null | sort -rn | tail -n +$((keep + 1)) | cut -d' ' -f2-)"
  if [[ -n "${old}" ]]; then
    while IFS= read -r f; do
      [[ -n "${f}" ]] || continue
      if rm -f "${f}" 2>/dev/null; then
        # 三种 sidecar 一起删，否则目的地会堆满孤儿 `.sha256`/`.manifest.json`/`.sig`
        local msc
        while IFS= read -r msc; do
          [[ -n "${msc}" ]] && rm -f "${msc}"
        done < <(backup_sidecar_paths "${f}")
        echo -e "  镜像清理：删掉 $(basename "${f}")（保留最新 ${keep} 份）"
      fi
    done <<<"${old}"
  fi
  return 0
}

write_sha256_sidecar() {
  local file="$1"
  [[ -f "${file}" ]] || return 0
  if ! command -v sha256sum >/dev/null 2>&1; then
    echo -e "  ${yellow}本机没有 sha256sum，跳过校验和记录（verify 时会明说没法比对）${plain}"
    return 0
  fi
  local hex
  hex="$(sha256sum "${file}" 2>/dev/null | cut -d' ' -f1)"
  if [[ -n "${hex}" ]] && printf '%s  %s\n' "${hex}" "$(basename "${file}")" >"${file}.sha256"; then
    # ⚠️ 0600，不是 0644：sidecar 与归档同目录同命运，而归档目录（<数据目录>/log/vanblog-backups）
    # 是 **bind mount 到宿主机**的 —— 0644 等于宿主机上任何本地用户都能读。sidecar 本身只有
    # 一个哈希，但它会泄露归档名与备份节奏；server 侧写的同名 sidecar 也是 0600
    # （utils/backupIntegrity.ts 的 writeSha256Sidecar），两边口径必须一致。
    chmod 0600 "${file}.sha256" 2>/dev/null || true
    echo -e "  校验和  ：已写入 ${yellow}$(basename "${file}").sha256${plain}（${VANBLOG_SELF_NAME} verify 时比对；拷走归档时记得带上它）"
  else
    rm -f "${file}.sha256" 2>/dev/null || true
    echo -e "  ${yellow}写 ${file}.sha256 失败（不影响备份本身）${plain}"
  fi
  return 0
}

# ── 加密归档（server 侧 packages/server/src/utils/backupCrypto.ts）──────────────
# 形状：魔数 `VANBLOGENC1` + 版本 + 头部 JSON（KDF 参数/salt/iv/cipher/内层格式），
#       之后是分块 AES-256-GCM 记录流。归档名多一个 `.enc` 后缀：
#       `vanblog-full-<时间戳>.tar.zst.enc`。
# ⚠️ **格式判别一律以魔数为准，后缀只用于展示与 glob**：站长完全可能把归档改名
#    （改名后 `.enc` 没了但内容还是密文，或反过来），按后缀判会把加密归档当明文处理，
#    然后 `zstd -t` 失败 ⇒ 报"归档损坏"，而其实只是没口令。server 侧同一个原则
#    （`isEncryptedHead()` 读魔数、`hasEncryptedSuffix()` 只看名字）。
BACKUP_ENC_MAGIC="VANBLOGENC1"

archive_is_encrypted() { # <文件> → 0=加密归档 1=不是（或读不到）
  local f="$1" head
  [[ -f "${f}" ]] || return 1
  # 魔数是纯 ASCII 且在文件最前面，所以 head -c 读出来不含 NUL，可以安全地放进 bash 字符串
  head="$(head -c "${#BACKUP_ENC_MAGIC}" "${f}" 2>/dev/null)" || return 1
  [[ "${head}" == "${BACKUP_ENC_MAGIC}" ]]
}

archive_has_enc_suffix() { # <名字或路径> → 0=以 .enc 结尾
  [[ "$(basename "$1" | tr '[:upper:]' '[:lower:]')" == *.enc ]]
}

# ── 归档的 sidecar（与归档同目录、同名 + 后缀，同生共死）──────────────────────────
# 三种：`.sha256`（校验和）、`.manifest.json`（成员清单副本）、`.sig`（ed25519 离线签名）。
# 命名口径以 server 为准：`writeSecretFileSync(`${archivePath}.manifest.json`)`
# （utils/fullBackup.ts:1339）与 `signatureSidecarPath()` = `${archivePath}.sig`
# （utils/backupSigning.ts:355）⇒ 都是**在完整归档名之后**追加，不是替换 `.tar.*`。
# ⚠️ 为什么必须有**一个**函数来判：这三种名字都**匹配**脚本里那些"找归档"的 glob
#    （`vanblog-full-*`、`vanblog-full-*.tar.*`），所以任何一处漏判都会把 sidecar 当成归档：
#      - 保留策略里 sidecar 会**占掉 keep 名额** ⇒ 真归档被提前删掉（**数据丢失**）；
#      - "取最新一份归档"会取到 `.sig` ⇒ 恢复/校验打错文件；
#      - `verify --all` 与 `restore` 的候选列表会去校验/列出 `.sig` ⇒ 报"归档损坏"。
#    这类"同一判断散在多处"的形状已经漂过两次（`.enc` 那轮补了 glob，`.sig` 这轮又发现 6 处），
#    所以判断只写在这里，各处一律调它。
BACKUP_SIDECAR_EXTS=('.sha256' '.manifest.json' '.sig')

is_backup_sidecar_name() { # <名字或路径> → 0=是 sidecar（不是归档本体）
  local n ext
  n="$(basename "$1")"
  for ext in "${BACKUP_SIDECAR_EXTS[@]}"; do
    [[ "${n}" == *"${ext}" ]] && return 0
  done
  return 1
}

backup_sidecar_paths() { # <归档路径> → stdout：实际存在的 sidecar 路径（每行一个）
  local a="$1" ext
  for ext in "${BACKUP_SIDECAR_EXTS[@]}"; do
    [[ -e "${a}${ext}" ]] && printf '%s\n' "${a}${ext}"
  done
  return 0
}

# 从 stdin 的候选名单里剔掉 sidecar（每行一个名字或路径）。
# ⚠️ 所有"列归档"的地方都必须过这一道，别各写一份 `grep -vE`（那正是漂移的来源）。
filter_backup_archives() {
  local line
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    is_backup_sidecar_name "${line}" && continue
    printf '%s\n' "${line}"
  done
  return 0
}

# ── 离线签名（server 侧 packages/server/src/utils/backupSigning.ts）────────────────
# `.sig` 是**明文 JSON**、0600、与归档同目录同名 + `.sig`；含 magic `VANBLOGSIG1`、
# archiveSha256、archiveBytes、keyFingerprint（公钥 DER 的 sha256 前 16 位）、signedAt、
# signature(base64, 64B)、archiveName（⚠️ **不参与签名**，改名不影响验签）。
# ⚠️ 加密归档签的是**密文** ⇒ 不解密也能验真，所以 `.enc` 与明文归档都可能有 `.sig`。
BACKUP_SIG_MAGIC="VANBLOGSIG1"
BACKUP_SIG_EXT=".sig"

archive_has_signature() { # <归档路径> → 0=旁边有 .sig
  [[ -n "${1:-}" && -f "${1}${BACKUP_SIG_EXT}" ]]
}

# 从 `.sig` 里取一个字段（明文 JSON，用 sed 取，⚠️ 不引入 jq 依赖）。取不到就输出空。
signature_field_of() { # <归档路径> <字段名>
  local sig="${1:-}${BACKUP_SIG_EXT}" key="${2:-}"
  [[ -f "${sig}" && -n "${key}" ]] || return 0
  sed -n 's/.*"'"${key}"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${sig}" 2>/dev/null | head -1
}

# 签名状态的**三态**文案（⚠️ 三态必须可区分，合并成"没有签名信息"就丢掉了最关键的区别）：
#   signed+verified  已签且验过（只有服务端/配了公钥才能给出"验过"）
#   signed-nokey     已签，但本机没有验签公钥 ⇒ **不等于验过**
#   unsigned         从没签过（早于本功能，或备份时没配签名密钥）
# ⚠️ 判据：脚本侧**不做**密码学验签（那要 ed25519，bash 里没有；硬凑 openssl 容易写错），
#    所以脚本永远只能给出后两态；"验过"这一态只来自服务端的 verify/restore 响应。
signature_state_of() { # <归档路径> → stdout: signed-nokey | unsigned
  if archive_has_signature "$1"; then printf 'signed-nokey'; else printf 'unsigned'; fi
}

# 加密归档在脚本侧能验什么、不能验什么（三处调用点都要引用同一套说法，别各写一遍）：
#   能验：`.sha256` sidecar 与 `.manifest.json` —— **它们是明文**，不解密也能比完整性；
#   不能验：压缩流（`zstd -t` 对密文必然失败）与成员清单（`tar -t` 读不了密文）。
# ⚠️ "跳过了一项校验"必须**说出来**。在站长眼里"静默跳过"与"校验通过"长得一模一样，
#    而这两种情况的区别正是"这份归档到底能不能恢复"。
archive_encrypted_verify_note() {
  printf '加密归档：脚本侧只比对了明文的 sidecar；压缩流与成员级校验需要口令（用 drill 或后台恢复来验）'
}

# 归档的压缩格式（按扩展名，和 server 的 detectFormat 同一套优先级）
archive_format_of() {
  local name
  name="$(basename "$1" | tr '[:upper:]' '[:lower:]')"
  # ⚠️ 加密归档的名字是 <内层名>.enc，而 `*.tar.zst.enc` **匹配不上** `*.tar.zst`
  #    ⇒ 不先剥后缀就会掉进"认不出压缩格式"分支，把一份好的加密归档判成 FAIL。
  #    内层格式仍然有意义：解密之后就是那个流，drill/后台要知道该用什么解。
  name="${name%.enc}"
  case "${name}" in
  *.tar.zst | *.zst) printf 'zstd' ;;
  *.tar.xz | *.xz) printf 'xz' ;;
  *.tar.gz | *.tgz | *.gz) printf 'gzip' ;;
  *) printf '' ;;
  esac
}

# 流式完整性测试（-t：解压流走一遍 CRC/帧校验，**不落盘**）。
# 返回 127 = 本机没有对应解压工具（调用方要区分"没法验"与"验不过"）。
archive_integrity_test() {
  local fmt="$1" file="$2" rc
  # ⚠️ 加密归档的外层是**密文**，不是 zstd/xz/gzip 流 ⇒ `zstd -t` 必然失败。
  #    返回 128 = "这项校验不适用"，与 127（本机没工具）、0（通过）、其它（真的坏了）区分开。
  #    调用方必须把 128 显示成"跳过 + 为什么"，**不能**当成通过、也不能当成损坏。
  if archive_is_encrypted "${file}"; then
    return 128
  fi
  case "${fmt}" in
  zstd)
    command -v zstd >/dev/null 2>&1 || return 127
    # --long=27 对齐 server 的解压参数（它用 `zstd -19 --long=27` 压缩）；
    # 老 zstd（<1.3.2）不认识 --long，去掉再试一次，别把"工具老"误报成"归档坏"
    zstd -t -q --long=27 "${file}" >/dev/null 2>&1
    rc=$?
    if [[ ${rc} -ne 0 ]]; then
      zstd -t -q "${file}" >/dev/null 2>&1
      rc=$?
    fi
    return ${rc}
    ;;
  xz)
    command -v xz >/dev/null 2>&1 || return 127
    xz -t "${file}" >/dev/null 2>&1
    ;;
  gzip)
    command -v gzip >/dev/null 2>&1 || return 127
    gzip -t "${file}" >/dev/null 2>&1
    ;;
  *) return 2 ;;
  esac
}

# 列出归档成员名（流式解压 | tar -t，不落盘）。管道退出码 = tar 的：
# 截断的归档 tar 会以 "Unexpected EOF" 非 0 退出，这里顺带就是结构校验。
archive_list_members() {
  local fmt="$1" file="$2"
  local -a tar_opts=(-tf -)
  # GNU tar 读别的工具打的归档可能碰到未知扩展头，压掉警告；
  # BusyBox tar 不认识 --warning=*，所以只有 GNU tar 才加（is_gnu_tar 的用武之地）
  if is_gnu_tar; then
    tar_opts+=(--warning=no-unknown-keyword)
  fi
  case "${fmt}" in
  zstd)
    local -a zf=(-dc -q)
    if command -v zstd >/dev/null 2>&1 && zstd --help 2>&1 | grep -q -- '--long'; then
      zf+=(--long=27)
    fi
    zstd "${zf[@]}" "${file}" 2>/dev/null | tar "${tar_opts[@]}" 2>/dev/null
    ;;
  xz)
    xz -dc "${file}" 2>/dev/null | tar "${tar_opts[@]}" 2>/dev/null
    ;;
  gzip)
    gzip -dc "${file}" 2>/dev/null | tar "${tar_opts[@]}" 2>/dev/null
    ;;
  *) return 2 ;;
  esac
}

# 校验单个归档：完整性 → sha256 → 成员清单。打一行 OK/FAIL 摘要，FAIL 返回 1。
# 整站备份（vanblog-full-* / *.tar.zst / *.tar.xz）的预期成员按 server 的打包结构核对
# （tar -C staging . ⇒ ./manifest.json、./db/<库>/<集合>.ndjson、./static/<img|file|customPage|themes>/…）；
# 目录级快照（vanblog-backup-*.tar.gz）预期 ./data/ 树。
verify_one_archive() {
  local file="$1"
  local base
  base="$(basename "${file}")"
  if [[ ! -f "${file}" ]]; then
    echo -e "  ${red}FAIL${plain} ${base}：文件不存在"
    return 1
  fi
  local fmt
  fmt="$(archive_format_of "${file}")"
  if [[ -z "${fmt}" ]]; then
    echo -e "  ${red}FAIL${plain} ${base}：认不出压缩格式（支持 .tar.zst / .tar.xz / .tar.gz，加密归档再多个 .enc 后缀）"
    return 1
  fi
  local size
  size="$(human_size "${file}")"
  local -a problems=() notes=()

  # 1) 流式完整性（不解压落盘就能抓住截断/损坏）
  local enc=0
  archive_is_encrypted "${file}" && enc=1
  archive_integrity_test "${fmt}" "${file}"
  case $? in
  0) notes+=("${fmt} 完整性 ✓") ;;
  127) problems+=("本机没有 ${fmt} 解压工具，无法校验") ;;
  128) notes+=("加密归档：跳过 ${fmt} 压缩流校验（外层是密文，不是 ${fmt} 流）") ;;
  *) problems+=("${fmt} 完整性校验失败（归档可能被截断或损坏）") ;;
  esac
  if [[ ${enc} -eq 1 ]]; then
    # 名字里没有 .enc 但内容是密文（或反过来）都要说出来：改名会让站长误判自己拿的是哪种归档
    if archive_has_enc_suffix "${base}"; then
      notes+=("已识别为加密归档（魔数 ${BACKUP_ENC_MAGIC}）")
    else
      notes+=("⚠️ 内容是加密归档（魔数 ${BACKUP_ENC_MAGIC}）但文件名没有 .enc 后缀 —— 判定以魔数为准")
    fi
  fi

  # 2) sha256 sidecar（有就比对；没有就明说跳过，不假装比过）
  local sidecar="${file}.sha256"
  if [[ -f "${sidecar}" ]]; then
    if command -v sha256sum >/dev/null 2>&1; then
      local want got
      want="$(awk 'NR==1{print $1}' "${sidecar}" 2>/dev/null)"
      got="$(sha256sum "${file}" 2>/dev/null | cut -d' ' -f1)"
      if [[ -n "${want}" && "${want}" == "${got}" ]]; then
        notes+=("sha256 ✓")
      else
        problems+=("sha256 不匹配（记录 ${want:0:12}…，实际 ${got:0:12}…）")
      fi
    else
      notes+=("有 .sha256 但本机没有 sha256sum，未比对")
    fi
  else
    notes+=("无 sha256 记录（server 导出/旧归档），跳过比对")
  fi

  # 2.5) 离线签名（.sig）—— **三态必须可区分**，合并成"没有签名信息"就丢掉了最关键的区别：
  #   signed-nokey  有 .sig，但本机没做密码学验签 ⇒ **不等于验过**
  #   unsigned      没有 .sig ⇒ 这份归档从没被签过（不是"被改过"，也不是"验过"）
  #   malformed     .sig 在但形状不对 ⇒ 既不能当通过，也**不该**断言"被篡改"
  # ⚠️ 脚本侧**不做** ed25519 验签：bash 里没有原语，硬凑 openssl 容易写错，而"验签写错"的失败方向
  #    是**假通过**（比不验更危险）。权威结论只来自服务端：
  #      - 恢复时：`POST full/restore` 会验签，配了公钥且验不过就 400 拒绝；
  #      - 状态：`GET full/status` 的 `lastSuccessSigned` / `lastSuccessSigning.keyFingerprint`；
  #      - ⚠️ `POST full/verify` 目前**不返回** signature 段（`BackupVerifyResult` 里有这个字段，
  #        但控制器没放进响应）⇒ 想在这里显示"已签且验过"，得先让服务端把它吐出来。
  local sigfile="${file}${BACKUP_SIG_EXT}" sigmagic sigfp sigat sigbytes
  if [[ -f "${sigfile}" ]]; then
    sigmagic="$(signature_field_of "${file}" magic)"
    sigfp="$(signature_field_of "${file}" keyFingerprint)"
    sigat="$(signature_field_of "${file}" signedAt)"
    sigbytes="$(signature_field_of "${file}" archiveBytes)"
    if [[ "${sigmagic}" != "${BACKUP_SIG_MAGIC}" ]]; then
      problems+=(".sig 存在但形状不对（magic 读到 '${sigmagic:-<空>}'，应为 ${BACKUP_SIG_MAGIC}）—— 既不能当验过，也不该断言被篡改")
    else
      notes+=("已签名：.sig 在（指纹 ${sigfp:-?}，签于 ${sigat:-?}，签的归档字节数 ${sigbytes:-?}）")
      # 侧信息：.sig 里记的 archiveSha256 与本机实测值能不能对上（这**不是**验签，
      # 只是"签名所覆盖的那份内容，与手上这份是不是同一份"的弱比对；真验签要公钥）。
      # ⚠️ 有意只在**已经算过** sha256 时比对（即存在 .sha256 sidecar 且本机有 sha256sum）：
      #    为了这一条再把一份几 GB 的归档完整哈希一遍，代价与收益不成比例，而 sidecar
      #    缺失时上面那条 note 已经明说了"跳过比对"。
      local sigsha
      sigsha="$(signature_field_of "${file}" archiveSha256)"
      if [[ -n "${sigsha}" && -n "${got:-}" && "${sigsha}" == "${got}" ]]; then
        notes+=("签名覆盖的 sha256 与本机实测一致（⚠️ 这只是内容对得上，**不等于验签通过**：验签要公钥）")
      elif [[ -n "${sigsha}" && -n "${got:-}" ]]; then
        problems+=("签名覆盖的 sha256（${sigsha:0:12}…）与本机实测（${got:0:12}…）**不一致** —— 归档或 .sig 在签名之后被改动过")
      fi
      notes+=("⚠️ 脚本侧未做密码学验签（没有验签公钥也不做 ed25519）；要权威结论：给容器配 VANBLOG_BACKUP_VERIFY_KEY(_FILE) 后走恢复/服务端，或 ${VANBLOG_SELF_NAME} backup-status 看 lastSuccessSigned")
    fi
  else
    notes+=("没有 .sig 签名：这份归档**从没被签过**（早于本功能，或备份时没配签名密钥）⇒ 只能证明没拷坏，不能证明没被换过")
  fi

  # 3) 成员清单
  #    ⚠️ 加密归档**列不出成员**（tar 读不了密文），这不是损坏 —— 成员级校验需要口令，
  #    脚本侧没有口令就不做，但必须明说"没做"，否则站长会把"跳过"读成"通过"。
  local members kind
  if [[ ${enc} -eq 1 ]]; then
    members=""
    notes+=("$(archive_encrypted_verify_note)")
  else
    members="$(archive_list_members "${fmt}" "${file}")"
  fi
  case "${base}" in
  vanblog-full-*) kind="full" ;;
  vanblog-backup-*) kind="offline" ;;
  *)
    case "${fmt}" in
    zstd | xz) kind="full" ;; # .tar.zst/.tar.xz 只有整站备份会产
    *) kind="generic" ;;
    esac
    ;;
  esac
  if [[ ${enc} -eq 1 ]]; then
    # ⚠️ 加密归档在这里**一条成员断言都不做**：members 必然是空的，而下面的 full 分支
    #    会把"空清单"判成"缺 manifest.json / 一个 ndjson 都没有"⇒ 把一份好的加密归档报成 FAIL。
    #    已经在上面记了 note 说明"成员级校验需要口令"，这就够了（宁可不验，不可假验）。
    :
  elif [[ -z "${members}" ]]; then
    problems+=("列不出成员（tar 结构损坏或不是 tar 归档）")
  elif [[ "${kind}" == "full" ]]; then
    if printf '%s\n' "${members}" | grep -qE '(^|/)manifest\.json$'; then
      notes+=("manifest ✓")
    else
      problems+=("缺 manifest.json（不是整站备份导出的归档？）")
    fi
    local ndjson_n
    ndjson_n="$(printf '%s\n' "${members}" | grep -cE '(^|/)db/[^/]+/[^/]+\.ndjson$' || true)"
    if [[ "${ndjson_n}" =~ ^[0-9]+$ && "${ndjson_n}" -gt 0 ]]; then
      notes+=("NDJSON ${ndjson_n} 个 ✓")
    else
      problems+=("一个 db/<库>/<集合>.ndjson 都没有（数据库部分是空的？）")
    fi
    if printf '%s\n' "${members}" | grep -qE '(^|/)static/'; then
      notes+=("静态目录 ✓")
    else
      # 不算失败：img/file/customPage/themes 是"存在才打包"（fullBackup.ts BACKUP_STATIC_FOLDERS），
      # 全新空站可以一个都没有
      notes+=("无 static/ 树（空站点属正常）")
    fi
    if [[ ! -f "${file}.manifest.json" ]]; then
      notes+=("旁边没有 .manifest.json（不影响恢复；inspect 要解包才能读清单）")
    fi
  elif [[ "${kind}" == "offline" ]]; then
    if printf '%s\n' "${members}" | grep -qE '(^|/)data/'; then
      notes+=("数据目录树 ✓")
    else
      problems+=("缺 ./data/ 树（目录级快照应打包整个数据目录）")
    fi
  else
    notes+=("非 vanblog 备份文件名，只验了压缩完整性与 tar 结构")
  fi

  if [[ ${#problems[@]} -gt 0 ]]; then
    local why
    why="$(printf '%s；' "${problems[@]}")"
    echo -e "  ${red}FAIL${plain} ${base}（${size:-?}）：${why%；}"
    return 1
  fi
  local info
  info="$(printf '%s，' ${notes[@]+"${notes[@]}"})"
  echo -e "  ${green}OK${plain}   ${base}（${size:-?}）：${info%，}"
  return 0
}

# ./vanblog.sh verify [归档名|路径]…
# 不带参数 = 校验备份目录里的全部 vanblog-full-* 归档（排除 .manifest.json / .sha256 sidecar）。
# 任一归档 FAIL → 退出码非 0（可以放进监控/cron）。
# verify 的用法（参数打错时打印）。⚠️ 它**不接受任何开关**，只接受归档名/路径。
print_verify_usage() {
  echo -e "用法：${yellow}$0 verify [归档名|路径]…${plain}"
  echo -e "  不带参数 = 校验备份目录里的全部 vanblog-full-* 归档"
  echo -e "  verify 不接受任何开关。要语义级校验（清单版本 / 成员哈希 / 能不能恢复）："
  echo -e "    ${yellow}$0 verify-deep [--all]${plain}     # 不需要 root；--all 另出结果表与 VERIFY-RESULT 行"
  echo -e "  要证明「真能恢复回来」只能演练：${yellow}$0 drill [归档名|路径]${plain}"
  echo -e "⚠️ 参数打错会**直接拒绝**（退出码 2），不会静默忽略后按默认行为跑"
}

verify() {
  local -a targets=()
  local arg
  for arg in "$@"; do
    case "${arg}" in
    0) continue ;; # 菜单/分发入口传进来的占位
    --*)
      # ⚠️ 这里以前是 `0 | --*) continue ;;` —— 打错的开关被**静默吞掉**。
      #    后果不是"报错难看"，而是**结果与用户以为跑的命令不是一回事**：
      #      verify --all   → 安静地按"校验全部"跑（碰巧像是对的，其实本命令没有这个开关；
      #                       有 --all 的是 drill 那边的 verify-deep）
      #      verify --al    → 同样不报错，同样按"校验全部"跑
      #    本脚本的一贯要求是"打错的值不许静默生效"（update 就是未知参数退出码 2 + 打印用法）。
      #    ⚠️ 只加这一条拒绝，**不改** verify 已有的行为与退出码语义：老 cron 里的
      #    `verify <归档>` 照旧跑，任一归档 FAIL 仍然非 0，成功仍然 0。
      #    退出码用 2（= 用法错误），与 update 一致；verify 原本只用 0/1（1 = 有归档 FAIL），
      #    所以 2 不会与既有语义混淆。
      echo -e "${red}verify 不认这个参数：${arg}${plain}"
      print_verify_usage
      return 2
      ;;
    esac
    [[ -n "${arg}" ]] && targets+=("${arg}")
  done
  if [[ ${#targets[@]} -eq 0 ]]; then
    local dir f
    dir="$(full_backup_dir)"
    if [[ ! -d "${dir}" ]]; then
      echo -e "${red}备份目录不存在：${dir}${plain}（还没备份过，或数据目录不在本机）"
      return 1
    fi
    while IFS= read -r f; do
      [[ -n "${f}" ]] || continue
      # ⚠️ 用共用助手判 sidecar（`.sha256`/`.manifest.json`/`.sig`）：`.sig` 也匹配
      #    `vanblog-full-*` 这个 glob，漏判就会去"校验"一个签名文件并报"归档损坏"。
      is_backup_sidecar_name "${f}" && continue
      targets+=("${f}")
    done < <(ls -1t "${dir}"/vanblog-full-* 2>/dev/null)
    if [[ ${#targets[@]} -eq 0 ]]; then
      echo -e "${yellow}${dir} 里没有可校验的 vanblog-full-* 归档${plain}（先跑 ${VANBLOG_SELF_NAME} backup）"
      return 0
    fi
    echo -e "> 校验备份目录里的全部归档（${#targets[@]} 个）：${dir}"
  else
    echo -e "> 校验 ${#targets[@]} 个归档"
  fi
  local ok=0 bad=0 t resolved
  for t in ${targets[@]+"${targets[@]}"}; do
    if [[ -f "${t}" ]]; then
      resolved="${t}"
    elif [[ -f "$(full_backup_dir)/${t}" ]]; then
      resolved="$(full_backup_dir)/${t}"
    else
      echo -e "  ${red}FAIL${plain} ${t}：本地找不到（既不是路径，也不在 $(full_backup_dir)/ 里）"
      bad=$((bad + 1))
      continue
    fi
    if verify_one_archive "${resolved}"; then
      ok=$((ok + 1))
    else
      bad=$((bad + 1))
    fi
  done
  echo
  if [[ ${bad} -gt 0 ]]; then
    echo -e "> 校验完成：${green}OK ${ok}${plain}，${red}FAIL ${bad}${plain} —— FAIL 的归档别拿来恢复（重新备份，或换更早的一份并先 verify）"
    return 1
  fi
  echo -e "> 校验完成：${green}OK ${ok}${plain}，FAIL 0"
  return 0
}

# ── 定时整站备份：./vanblog.sh install-cron ────────────────────────────────
# 以前 --keep 有了、文档里也教了 cron 配方，但调度得用户自己手写 crontab ——
# 而手写最容易错的三件事（token 放哪、忘带 ASSUME_YES/KEEP、把已有 crontab 覆盖掉）
# 这里都收进一个幂等的子命令：
#   install-cron              每天 03:00 整站备份、留 7 份（VANBLOG_BACKUP_KEEP 覆盖默认）
#   install-cron --hour 5 --keep 14
#   install-cron --remove     从 root 的 crontab 移除（token 文件保留，路径会打印出来）
#   install-cron --force      参数变了就替换旧条目（默认参数不同会拒绝，让你显式决定）
# token 的存放（诚实的权衡）：备份接口在 AdminGuard 后面，cron 里没法交互输密码，
# 所以 VANBLOG_ADMIN_TOKEN（环境变量或安装时交互输入）会写进
# <安装目录>/vanblog-cron.env（**0600，仅 root 可读**），cron 行 source 它。
# 这意味着一个长期有效的管理员 token 明文落盘 —— 文档（docs/guide/backup.md）里写明了
# 这个权衡与作废方法；不提供 token 也能装（备份会在登录一步失败并写进日志，
# env 文件里留了怎么补的注释），不假装"装好了就能用"。
VANBLOG_CRON_MARKER="# vanblog-backup-cron"
# ⚠️ 下面两个 marker **绝不能包含上面那个作为子串**（也不能被它包含）：
#    install-cron 的幂等检测与 --force 替换都是 `grep -F "${VANBLOG_CRON_MARKER}"`，
#    如果 verify 行的 marker 是 "# vanblog-backup-cron-verify" 这种形状，备份行的检测就会
#    **匹配到 verify 行**，从而误判"定时备份已经装过了"（或 --force 时把 verify 行一起删掉）。
#    所以用 "# vanblog-verify-cron" / "# vanblog-drill-cron"：三个互不为子串。
#    --remove 则按"三个 marker 都删"来做，保持"一条命令删干净"这个既有性质。
VANBLOG_CRON_MARKER_VERIFY="# vanblog-verify-cron"
VANBLOG_CRON_MARKER_DRILL="# vanblog-drill-cron"

vanblog_cron_env_file() { printf '%s/vanblog-cron.env' "${VANBLOG_BASE_PATH}"; }
vanblog_cron_log_file() { printf '%s/log/vanblog-backup-cron.log' "${VANBLOG_DATA_PATH}"; }

# 要写进 crontab 的那一行（env 文件里带 ASSUME_YES/KEEP/TOKEN 的 export）
# cron 专用入口：把"备份失败"变成**看得见**的事件，并在站点已经死掉时仍然产出兜底归档。
#
# ⚠️ 为什么需要它（本轮 DR 排查里最刺眼的一条）：cron 以前跑的是裸 `backup`，而 backup 第一步就要
#    管理员 token + POST /api/admin/backup/full/export ⇒ **站点不可用时 100% 失败**。也就是说
#    "站点被打瘫的那几天，正好一份备份都不会有"；而失败只进 vanblog-backup-cron.log，没有任何告警
#    通道（webhook/mail/notify 在 provider 与脚本里 0 命中），也没有任何东西定期跑 backup-status
#    --strict（cron 里只有 backup）⇒ 站长往往要等到"想恢复时才发现没有备份"。
#    这里做四件事：
#      ① 失败就回落 `backup --offline`（直接打包数据目录，不需要 server 活着，而且是唯一连 caddy
#         证书一起备的方式）；
#      ② 结果写进**旁路**状态文件 `<备份目录>/cron-status.json`，让 `doctor`/`status` 能看见；
#      ③ 可选 webhook 告警（VANBLOG_BACKUP_ALERT_WEBHOOK）——打不通绝不影响备份结果；
#      ④ 顺手跑一次 `backup-status --strict`，把"陈旧/未验证"也记进同一个状态文件。
backup_cron_run() {
  local rc=0 mode="full" msg="" strict_rc=""
  local bdir="${VANBLOG_DATA_PATH}/log/vanblog-backups"
  echo -e "> 定时备份开始（$(date '+%F %T')）"
  if backup; then
    mode="full"
  else
    rc=$?
    msg="整站备份失败(exit=${rc})，站点可能不可用；回落离线打包数据目录"
    echo -e "${yellow}${msg}${plain}"
    if backup --offline; then
      mode="offline"; rc=0
      msg="${msg}；离线包成功"
    else
      local rc2=$?
      mode="failed"; rc=${rc2}
      msg="${msg}；离线包也失败(exit=${rc2})"
      echo -e "${red}${msg}${plain}"
    fi
  fi

  # 顺手核对备份状态（--strict：陈旧或未验证都算不通过）。⚠️ 这一步只**记录**，不改 rc ——
  #    它失败通常是"备份太旧"，那本身不是这次 cron 的失败。
  if [[ -x "${VANBLOG_SELF_PATH}" ]]; then
    if "${VANBLOG_SELF_PATH}" backup-status --strict >/dev/null 2>&1; then
      strict_rc=0
    else
      strict_rc=$?
      echo -e "${yellow}  backup-status --strict 未通过（exit=${strict_rc}）：备份可能陈旧或未验证${plain}"
    fi
  fi

  # ② 旁路状态文件。⚠️ **不写** server 维护的 backup-status.json：那个文件有自己的 schema，
  #    server 与脚本的 backup-status/doctor 都在读它，往里塞字段有把它写坏的风险，而它坏了会让
  #    "最近一次备份"这类判断全部失真。所以另开一个只属于 cron 的文件，并用 0600（里面有失败原因，
  #    可能含路径信息）+ 临时文件 mv（不让读者看到半截 JSON）。
  mkdir -p "${bdir}" 2>/dev/null
  local tmp="${bdir}/.cron-status.json.$$"
  local safe_msg
  safe_msg="$(printf '%s' "${msg}" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g' | head -c 300)"
  if {
    printf '{"at":"%s",' "$(date '+%FT%T%z')"
    printf '"mode":"%s",' "${mode}"
    printf '"exitCode":%s,' "${rc}"
    printf '"message":"%s",' "${safe_msg}"
    printf '"strictExitCode":%s}\n' "${strict_rc:-null}"
  } >"${tmp}" 2>/dev/null; then
    chmod 0600 "${tmp}" 2>/dev/null
    mv -f "${tmp}" "${bdir}/cron-status.json" 2>/dev/null || rm -f "${tmp}" 2>/dev/null
  else
    rm -f "${tmp}" 2>/dev/null
    echo -e "${yellow}  写 cron 状态文件失败（不影响备份结果）${plain}"
  fi

  # ③ 告警：只在失败时发，且**任何错误都吞掉** —— webhook 打不通绝不能让备份本身算失败。
  if [[ "${rc}" != "0" && -n "${VANBLOG_BACKUP_ALERT_WEBHOOK:-}" ]]; then
    if curl -sS -m 10 -o /dev/null -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"VanBlog 定时备份失败：${safe_msg}\"}" \
      "${VANBLOG_BACKUP_ALERT_WEBHOOK}" >/dev/null 2>&1; then
      echo -e "  已发告警到 webhook"
    else
      echo -e "${yellow}  webhook 告警没发出去（不影响备份结果，检查 VANBLOG_BACKUP_ALERT_WEBHOOK）${plain}"
    fi
  fi

  if [[ "${rc}" == "0" ]]; then
    echo -e "${green}✓ 定时备份完成（方式：${mode}）${plain}"
  else
    echo -e "${red}✗ 定时备份失败（方式：${mode}，exit=${rc}）${plain}"
    echo -e "${yellow}  先做一次体检：${VANBLOG_SELF_NAME} doctor${plain}"
  fi
  return "${rc}"
}

# 每周一次「备份 + 立刻验证」。用 backup-verify 而不是 verify：它的注释就写着"cron 用：失败就非 0
# 退出"，而且它会先做一次新备份再验，所以验的永远是**当前**能产出的东西，不是几周前那份。
# ⚠️ 排在每日备份的**后一小时**（(hour+1)%24），这样它验的是刚备出来的归档。
vanblog_cron_verify_line() { # <hour>
  printf '%s' "0 $1 * * 0 . '$(vanblog_cron_env_file)' && '${VANBLOG_SELF_PATH}' backup-verify >> '$(vanblog_cron_log_file)' 2>&1 ${VANBLOG_CRON_MARKER_VERIFY}"
}

# 每月一次「真恢复演练」：起一套一次性容器，走用户真正会走的那条 HTTP 恢复接口，再把恢复出来的
# 站点跟归档清单对账。⚠️ **默认关**，要显式 --with-drill：它需要容器引擎与磁盘（归档大小的两倍
# 以上），在小机器上跑不动；而且 drill 自己会拒绝任何名字/端口冲突、绝不碰在跑的栈、用 trap 拆干净。
vanblog_cron_drill_line() { # <hour>
  printf '%s' "0 $1 1 * * . '$(vanblog_cron_env_file)' && '${VANBLOG_SELF_PATH}' drill >> '$(vanblog_cron_log_file)' 2>&1 ${VANBLOG_CRON_MARKER_DRILL}"
}

vanblog_cron_line() { # <hour>
  # ⚠️ 跑的是 backup-cron-run 而不是裸 backup：后者在站点不可用时必然失败且没人知道，
  #    前者会回落离线包、写状态文件、（可选）发告警。
  printf '%s' "0 $1 * * * . '$(vanblog_cron_env_file)' && '${VANBLOG_SELF_PATH}' backup-cron-run >> '$(vanblog_cron_log_file)' 2>&1 ${VANBLOG_CRON_MARKER}"
}

# 读现有 crontab 到 CURRENT_CRONTAB。
# ⚠️ 关键安全边界：只有**确定**"没有 crontab"（stderr 里写 no crontab）才敢当空表写回；
# 其它失败（cron 服务没起、权限问题、实现差异）一律中止 —— 宁可不装，绝不覆盖用户已有的任务。
CURRENT_CRONTAB=""
read_current_crontab() {
  local mixed rc
  mixed="$(crontab -l 2>&1)"
  rc=$?
  if [[ ${rc} -eq 0 ]]; then
    CURRENT_CRONTAB="${mixed}"
    return 0
  fi
  if printf '%s' "${mixed}" | grep -qi 'no crontab'; then
    CURRENT_CRONTAB=""
    return 0
  fi
  echo -e "${red}读取现有 crontab 失败：$(printf '%s' "${mixed}" | head -c 200)${plain}" >&2
  echo -e "${red}为了不覆盖你已有的定时任务，这次不写入 crontab。${plain}" >&2
  return 1
}

# install-cron 的用法（参数打错时打印）
print_install_cron_usage() {
  echo -e "用法：${yellow}$0 install-cron [开关]${plain}"
  echo -e "  不带开关 = 每天 03:00 整站备份，成功后保留最新 7 份（VANBLOG_BACKUP_KEEP 可改这个默认）"
  echo -e "  --hour N                  每天几点跑（0-23，默认 3）"
  echo -e "  --every N                 每 N 小时跑一次（1-23）——**RPO 就是 N 小时**，与 --hour 互斥"
  echo -e "                            ⚠️ 备得越勤，同样 --keep 份数覆盖的时间越短（每 6 小时 + 留 7 份 = 42 小时）"
  echo -e "  --keep N                  备份成功后保留最新 N 份（正整数，默认 7）"
  echo -e "  --remove                  从 root 的 crontab 移除（token 文件保留，路径会打印出来）"
  echo -e "  --force                   用新参数替换已有条目（参数不同时会要求显式给）"
  echo -e "  --with-verify               再装一条「每周校验」：周日 <hour+1>:00 跑 backup-verify"
  echo -e "                              （先做一次新备份再立刻验证，失败非 0 退出 ⇒ cron 会记下来）。便宜，建议开。"
  echo -e "  --with-drill                再装一条「每月演练」：每月 1 号 <hour+2>:00 跑 drill"
  echo -e "                              （起一次性容器**真恢复一遍**并逐项对账）。${yellow}默认关${plain}：需要容器引擎"
  echo -e "                              与磁盘（归档大小的两倍以上），小机器上别开。"
  echo -e "  ⚠️ 三个任务写同一个日志；--remove 会删掉**全部**三种（备份/校验/演练），「一条命令删干净」不变。"
  echo -e "  ⚠️ --remove 与 --with-verify/--with-drill 不能同时给（退出码 2）；--force 只重写你这次请求的那几条，"
  echo -e "     没请求的保持原样（不会顺手删掉你以前装的）。重复装同一个任务**不会**出现两行。"
  echo -e "⚠️ 参数打错会**直接拒绝**（退出码 2），不会静默按默认值写进 root 的 crontab"
}

install_cron() {
  local action="install" hour="" every="" keep="${VANBLOG_BACKUP_KEEP:-7}" force=0
  local with_verify=0 with_drill=0
  # ⚠️ 以前未知 `--*` 被静默吞掉，而 install-cron 是**往 root 的 crontab 里写东西**的命令：
  #    `install-cron --horu 3`（hour 拼错）会安静地按默认 3 点装进去，用户以为自己设的是别的时间；
  #    `install-cron --remov` 会安静地**装**一条定时任务，而用户以为自己在删。
  #    写进 crontab 的东西不会每天提醒你它错了，所以这里必须当场拒绝（与 backup/verify/restore/update 一致）。
  #    ⚠️ 只加"未知开关拒绝"这一条：默认值（hour 3 / keep 7）、--hour/--keep 的取值校验
  #    （非数字或超范围 → 退出码 1）、幂等与"绝不覆盖已有 crontab"的行为**一个字都没改**，
  #    因为别人的 cron 里可能正在用这些形状。
  local -a argv=("$@")
  local i=0 arg val
  while ((i < ${#argv[@]})); do
    arg="${argv[i]}"
    case "${arg}" in
    --remove) action="remove" ;;
    # 两个新任务是**布尔开关**（不带值）：装不装，而不是装成什么参数。
    # 它们的时间由 --hour 推出来（verify 在后一小时、drill 在每月 1 号的再后一小时），
    # 所以不需要各自的 --verify-hour 之类 —— 少两个能配错的东西。
    --with-verify) with_verify=1 ;;
    --with-drill) with_drill=1 ;;
    --force) force=1 ;;
    --hour | --keep | --every)
      val="${argv[i + 1]:-}"
      # 缺值也不许静默按默认跑。⚠️ 例子按开关给（--hour 举 3、--keep 举 7）：在一条
      #    讲"你参数写错了"的消息里给错例子等于把人往沟里带（backup 那边踩过一次）。
      # ⚠️ 值为 `0` 是**合法输入**，必须原样交给下面的正整数/范围校验去拒（退出码 1），
      #    不能在这里当"缺值"吞掉 —— 旧代码专门为此把占位 `0` 的豁免放在 --hour/--keep
      #    之后，这个语义要保持。
      if [[ -z "${val}" || "${val}" == --* ]]; then
        local example="3，表示每天凌晨 3 点"
        [[ "${arg}" == "--keep" ]] && example="7，表示只留最新 7 份"
        [[ "${arg}" == "--every" ]] && example="6，表示每 6 小时一次（RPO 就是 6 小时）"
        echo -e "${red}${arg} 后面要跟一个值${plain}（例如 ${arg} ${example}）"
        print_install_cron_usage
        return 2
      fi
      if [[ "${arg}" == "--hour" ]]; then
        hour="${val}"
      elif [[ "${arg}" == "--every" ]]; then
        every="${val}"
      else
        keep="${val}"
      fi
      i=$((i + 1)) # 值已经被吃掉了，别再当位置参数过一遍（否则 `--keep 0` 的 0 会被占位分支吞掉）
      ;;
    0) : ;; # 菜单/分发入口传进来的占位
    --*)
      echo -e "${red}install-cron 不认这个参数：${arg}${plain}"
      print_install_cron_usage
      return 2
      ;;
    *) : ;; # 多余的字面量照旧忽略（不改变既有行为）
    esac
    i=$((i + 1))
  done
  # --every N（每 N 小时一次）与 --hour N（每天几点）**互斥**：两个都给等于"我不知道你要哪个"，
  # 而 install-cron 写的是 root 的 crontab —— 猜错方向的代价是"以为每小时备一次，其实每天一次"，
  # 也就是 RPO 从 1 小时悄悄变成 24 小时。所以按仓库既有规矩：点名报错 + 打用法 + 退出码 2。
  local sched=""
  if [[ -n "${every}" && -n "${hour}" ]]; then
    echo -e "${red}--every 与 --hour 不能同时给（一个是「每 N 小时」，一个是「每天几点」）${plain}"
    print_install_cron_usage
    return 2
  fi
  if [[ -n "${every}" ]]; then
    case "${every}" in
    '' | *[!0-9]*)
      echo -e "${red}--every 必须是 1-23 的数字：${every}${plain}"
      print_install_cron_usage
      return 2
      ;;
    esac
    if ((every < 1 || every > 23)); then
      echo -e "${red}--every 必须是 1-23 的数字：${every}${plain}"
      print_install_cron_usage
      return 2
    fi
    sched="*/${every}"
    echo -e "> 定时备份：每 ${yellow}${every}${plain} 小时一次（RPO = ${every} 小时）"
    echo -e "  ⚠️ 份数上限仍是 --keep：备得越勤，同样份数覆盖的时间越短（每 6 小时 + 留 7 份 = 只覆盖 42 小时）"
  fi
  hour="${hour:-3}"
  case "${hour}" in
  '' | *[!0-9]*)
    echo -e "${red}--hour 必须是 0-23 的数字：${hour}${plain}"
    return 1
    ;;
  esac
  if ((hour > 23)); then
    echo -e "${red}--hour 必须是 0-23 的数字：${hour}${plain}"
    return 1
  fi
  case "${keep}" in
  '' | *[!0-9]*)
    echo -e "${red}--keep 必须是正整数：${keep}${plain}"
    return 1
    ;;
  esac
  if ((keep < 1)); then
    echo -e "${red}--keep 必须是正整数：${keep}${plain}"
    return 1
  fi

  if [[ "${action}" == "remove" ]] && { ((with_verify)) || ((with_drill)); }; then
    echo -e "${red}--remove 与 --with-verify/--with-drill 不能同时给（一个是「全部删掉」，一个是「再装一个」）${plain}"
    print_install_cron_usage
    return 2
  fi

  local envf logf line
  envf="$(vanblog_cron_env_file)"
  logf="$(vanblog_cron_log_file)"
  [[ -n "${sched}" ]] || sched="${hour}"
  line="$(vanblog_cron_line "${sched}")"

  if ! command -v crontab >/dev/null 2>&1; then
    echo -e "${red}本机没有 crontab 命令${plain}（Debian/Ubuntu：apt install cron；CentOS/RHEL：yum install cronie）"
    echo -e "装好 cron 后重跑 ${green}${VANBLOG_SELF_NAME} install-cron${plain}；或手动把下面两件事做掉："
    echo -e "  1) 建 token 文件（0600）：${yellow}${envf}${plain}，内容至少一行 export VANBLOG_ADMIN_TOKEN='<token>'"
    echo -e "  2) 把这一行加进 root 的 crontab（crontab -e）："
    echo -e "     ${yellow}${line}${plain}"
    return 1
  fi

  if ! read_current_crontab; then
    return 1
  fi
  local backup_already=0
  local existing existing_verify existing_drill
  existing="$(printf '%s\n' "${CURRENT_CRONTAB}" | grep -F "${VANBLOG_CRON_MARKER}" | head -1)"
  existing_verify="$(printf '%s\n' "${CURRENT_CRONTAB}" | grep -F "${VANBLOG_CRON_MARKER_VERIFY}" | head -1)"
  existing_drill="$(printf '%s\n' "${CURRENT_CRONTAB}" | grep -F "${VANBLOG_CRON_MARKER_DRILL}" | head -1)"

  if [[ "${action}" == "remove" ]]; then
    if [[ -z "${existing}${existing_verify}${existing_drill}" ]]; then
      echo -e "> root 的 crontab 里没有 VanBlog 定时任务条目（标记 ${VANBLOG_CRON_MARKER} / ${VANBLOG_CRON_MARKER_VERIFY} / ${VANBLOG_CRON_MARKER_DRILL}），不用移除"
      return 0
    fi
    # ⚠️ 三个 marker 一起删：--remove 的既有性质是"一条命令删干净"，加了新任务也不能变。
    if ! printf '%s\n' "${CURRENT_CRONTAB}" |
      grep -vF -e "${VANBLOG_CRON_MARKER}" -e "${VANBLOG_CRON_MARKER_VERIFY}" -e "${VANBLOG_CRON_MARKER_DRILL}" |
      crontab -; then
      echo -e "${red}写回 crontab 失败，原样未动${plain}"
      return 1
    fi
    echo -e "${green}已从 root 的 crontab 移除 VanBlog 的全部定时任务条目（备份 / 校验 / 演练）${plain}"
    echo -e "  ${yellow}token 文件还在 ${envf}（里面有管理员 token），确认不再需要就手动 rm 掉${plain}"
    return 0
  fi

  if [[ -n "${existing}" ]]; then
    if [[ "${force}" != 1 ]]; then
      if [[ "${existing}" == "${line}" ]]; then
        echo -e "${green}已经装过了：crontab 里已有同样的条目，不会重复添加${plain}"
        echo -e "  ${existing}"
        echo -e "  要改参数：${VANBLOG_SELF_NAME} install-cron --force --hour ${hour}（--every N 改成每 N 小时、--keep 改保留份数）；要删：--remove"
        # ⚠️ 这里以前是 `return 0`（提前返回）。那是一个**静默什么都不做**的坑：
        #    在"备份条目已经装过"的机器上跑 `install-cron --with-verify`，会在这一行直接返回，
        #    永远走不到下面处理可选任务的那段 ⇒ verify 行根本没装，而用户看到的是"已经装过了"。
        #    现在改成记一个标志继续往下走；真正的早退在可选任务处理完之后（那时才知道有没有事要做）。
        backup_already=1
      else
      echo -e "${yellow}crontab 里已经有一条 VanBlog 定时备份（参数不同），不会添加第二条：${plain}"
      echo -e "  现有：${existing}"
      echo -e "  想要：${line}"
      echo -e "确认要换成新的就加 ${green}--force${plain}（或先 ${VANBLOG_SELF_NAME} install-cron --remove）"
      return 1
      fi
    else
    CURRENT_CRONTAB="$(printf '%s\n' "${CURRENT_CRONTAB}" | grep -vF "${VANBLOG_CRON_MARKER}")"
    # ⚠️ --force 只移除**它即将重写**的那几行：没被请求的任务（例如以前装过的 verify）保持原样，
    #    否则"改个备份时间"会顺手把用户的每周校验删掉，而他不会知道。
    if ((with_verify)); then
      CURRENT_CRONTAB="$(printf '%s\n' "${CURRENT_CRONTAB}" | grep -vF "${VANBLOG_CRON_MARKER_VERIFY}")"
    fi
    if ((with_drill)); then
      CURRENT_CRONTAB="$(printf '%s\n' "${CURRENT_CRONTAB}" | grep -vF "${VANBLOG_CRON_MARKER_DRILL}")"
    fi
    echo -e "> --force：先移除旧条目再写入新的"
    fi
  fi

  # ── 两个可选任务：每周校验（便宜）/ 每月演练（贵，默认关）──
  # ⚠️ 幂等是硬要求：重复 `install-cron --with-verify` **绝不允许**出现两行 verify。
  #    判据是"该 marker 的行是否已经存在且逐字相同"；不同则按既有规矩要求 --force（不静默替换）。
  local extra_lines="" vline dline vhour dhour
  vhour=$(( (hour + 1) % 24 ))
  dhour=$(( (hour + 2) % 24 ))
  if ((with_verify)); then
    vline="$(vanblog_cron_verify_line "${vhour}")"
    if [[ -n "${existing_verify}" && "${force}" != 1 && "${existing_verify}" == "${vline}" ]]; then
      echo -e "${green}每周校验已经装过了：crontab 里已有同样的条目，不会重复添加${plain}"
    elif [[ -n "${existing_verify}" && "${force}" != 1 ]]; then
      echo -e "${yellow}crontab 里已经有一条每周校验（参数不同），不会添加第二条：${plain}"
      echo -e "  现有：${existing_verify}"
      echo -e "  想要：${vline}"
      echo -e "确认要换成新的就加 ${green}--force${plain}（或先 ${VANBLOG_SELF_NAME} install-cron --remove）"
      return 1
    else
      # ⚠️ 这行清理在**当前所有可达路径上都是冗余的**（变异对照实测：删掉它测试一条都不红）：
      #    走到 else 只有两种情况 —— ① 没有同 marker 的旧行（本来就没什么可清）；
      #    ② 给了 --force，而上面 force 分支已经把 verify 行剥掉了。
      #    "重复安装不会出现两行"这个性质是由**"逐字相同就跳过"那个分支** + **force 的剥离**共同保证的，
      #    不是由这行保证的。留着它是纵深防御（将来有人改动上面的分支顺序时不会立刻退化成重复写），
      #    但**不要**把它当成那条性质的守卫。
      CURRENT_CRONTAB="$(printf '%s\n' "${CURRENT_CRONTAB}" | grep -vF "${VANBLOG_CRON_MARKER_VERIFY}")"
      extra_lines="${extra_lines}${vline}"$'\n'
      echo -e "> 每周校验：周日 $(printf '%02d:00' "${vhour}") 跑 backup-verify（先备份再立刻验证，失败非 0 退出）"
    fi
  elif [[ -n "${existing_verify}" ]]; then
    echo -e "> 已有的每周校验条目**保持原样**（这次没给 --with-verify，不会去动它；要删用 --remove）"
  fi
  if ((with_drill)); then
    dline="$(vanblog_cron_drill_line "${dhour}")"
    if [[ -n "${existing_drill}" && "${force}" != 1 && "${existing_drill}" == "${dline}" ]]; then
      echo -e "${green}每月演练已经装过了：crontab 里已有同样的条目，不会重复添加${plain}"
    elif [[ -n "${existing_drill}" && "${force}" != 1 ]]; then
      echo -e "${yellow}crontab 里已经有一条每月演练（参数不同），不会添加第二条：${plain}"
      echo -e "  现有：${existing_drill}"
      echo -e "  想要：${dline}"
      echo -e "确认要换成新的就加 ${green}--force${plain}"
      return 1
    else
      CURRENT_CRONTAB="$(printf '%s\n' "${CURRENT_CRONTAB}" | grep -vF "${VANBLOG_CRON_MARKER_DRILL}")"
      extra_lines="${extra_lines}${dline}"$'\n'
      echo -e "> 每月演练：每月 1 号 $(printf '%02d:00' "${dhour}") 跑 drill（起一次性容器真恢复一遍并对账）"
      echo -e "  ${yellow}⚠️ 它需要容器引擎与磁盘（归档大小的两倍以上）；小机器上建议不要开${plain}"
    fi
  elif [[ -n "${existing_drill}" ]]; then
    echo -e "> 已有的每月演练条目**保持原样**（这次没给 --with-drill，不会去动它；要删用 --remove）"
  fi

  # ⚠️ 备份条目已经一模一样 ⇒ 不重写它，也**绝不去碰 token 与环境文件**：
  #    环境文件是整份重写的，跑一遍就会把用户手工补进去的 VANBLOG_ADMIN_TOKEN 冲掉。
  if ((backup_already)); then
    if [[ -z "${extra_lines}" ]]; then
      echo -e "${green}没有需要改动的定时任务条目${plain}"
      return 0
    fi
    if ! {
      [[ -n "${CURRENT_CRONTAB}" ]] && printf '%s\n' "${CURRENT_CRONTAB}"
      printf '%s' "${extra_lines}"
    } | crontab -; then
      echo -e "${red}写入 crontab 失败${plain}"
      return 1
    fi
    if crontab -l 2>/dev/null | grep -qF "${VANBLOG_CRON_MARKER}"; then
      echo -e "${green}已添加 $(printf '%s' "${extra_lines}" | grep -c .) 条新的定时任务${plain}（备份条目与 token/环境文件保持原样）"
      echo -e "  所有任务写同一个日志：${yellow}${logf}${plain}"
      return 0
    fi
    echo -e "${red}写入后在 crontab 里没找到条目（这台机器的 crontab 可能被别的管理器接管）${plain}"
    return 1
  fi

  # ── token：环境变量优先，其次交互输入；都没有也照装，但明说后果 ──
  local token="${VANBLOG_ADMIN_TOKEN:-}"
  local token_from="环境变量 VANBLOG_ADMIN_TOKEN"
  if [[ -z "${token}" ]] && [[ -t 0 ]]; then
    echo -e "后台管理员 token（浏览器 F12 → Application → Local Storage → token）。"
    echo -e "直接回车 = 暂不提供：定时备份会在登录一步失败（错误会写进日志），之后按 ${envf} 里的注释补上。"
    read -e -r -s -p "token: " token
    echo
    token_from="交互输入"
  fi

  # ── env 文件（0600，root-only）：cron 行 source 的就是它 ──
  mkdir -p "${VANBLOG_BASE_PATH}" 2>/dev/null || true
  mkdir -p "$(dirname "${logf}")" 2>/dev/null || true
  if ! (
    umask 077
    {
      echo "# VanBlog 定时备份的环境文件（root-only 0600）。"
      echo "# crontab 里带 ${VANBLOG_CRON_MARKER} 标记的那一行会 source 这个文件。"
      echo "# ⚠️ 里面的 token 等价于管理员登录态，长期明文落盘；怀疑泄露就作废它"
      echo "#    （后台重新登录/删除对应 token），然后重跑 install-cron --force。"
      echo "export VANBLOG_ASSUME_YES=1"
      echo "export VANBLOG_BACKUP_KEEP=${keep}"
      if [[ -n "${token}" ]]; then
        printf "export VANBLOG_ADMIN_TOKEN='%s'\n" "${token//\'/\'\\\'\'}"
      else
        echo "# ⚠️ 还没配 token：定时备份会在登录一步失败（看 $(basename "${logf}") 日志）。"
        echo "# 浏览器 F12 → Application → Local Storage → token 复制一个，取消下一行注释并粘贴："
        echo "# export VANBLOG_ADMIN_TOKEN='把token粘贴到这里'"
      fi
    } >"${envf}"
  ); then
    echo -e "${red}写 ${envf} 失败${plain}"
    return 1
  fi
  chmod 600 "${envf}" 2>/dev/null || true

  echo -e "> 将向 ${yellow}root 的 crontab${plain} 添加（已有任务原样保留，只在末尾追加这一行）："
  echo -e "    ${line}"
  echo -e "  计划    ：每天 $(printf '%02d:00' "${hour}") 整站备份，成功后只保留最新 ${keep} 份"
  echo -e "  日志    ：${logf}"
  if [[ -n "${token}" ]]; then
    echo -e "  token   ：来自${token_from}，已写入 ${envf}（0600，仅 root 可读）"
    echo -e "  ${yellow}⚠️ 权衡：管理员 token 从此长期明文落盘；作废方法见该文件头部注释与 docs/guide/backup.md${plain}"
  else
    echo -e "  token   ：${red}未提供${plain} —— 定时备份会在登录一步失败（错误写进日志）；"
    echo -e "            按 ${envf} 里的注释补一行 export VANBLOG_ADMIN_TOKEN='…' 即可生效"
  fi
  if [[ "${VANBLOG_ASSUME_YES:-0}" != "1" ]]; then
    local input
    read -e -r -p "确认写入 crontab? [y/N] " input
    case ${input} in
    [yY][eE][sS] | [yY]) ;;
    *)
      echo "已取消（crontab 未改动）"
      return 0
      ;;
    esac
  fi

  if ! {
    [[ -n "${CURRENT_CRONTAB}" ]] && printf '%s\n' "${CURRENT_CRONTAB}"
    printf '%s\n' "${line}"
    # 额外任务（每周校验 / 每月演练）。⚠️ extra_lines 每行自带换行，所以用 %s 不是 %s\n
    [[ -n "${extra_lines}" ]] && printf '%s' "${extra_lines}"
  } | crontab -; then
    echo -e "${red}写入 crontab 失败${plain}"
    return 1
  fi
  # 写回之后读一遍确认（crontab 可能被别的东西管着，或 - 输入不被支持）
  if crontab -l 2>/dev/null | grep -qF "${VANBLOG_CRON_MARKER}"; then
    echo -e "${green}定时备份已安装${plain}：$(if [[ -n "${sched}" && "${sched}" == \*/* ]]; then echo -n "每 ${sched#*/} 小时一次"; else printf '每天 %02d:00' "${hour}"; fi)，保留 ${keep} 份"
    if [[ -n "${extra_lines}" ]]; then
      echo -e "  同时装了：$(printf '%s' "${extra_lines}" | grep -cF "${VANBLOG_CRON_MARKER_VERIFY}") 条每周校验、$(printf '%s' "${extra_lines}" | grep -cF "${VANBLOG_CRON_MARKER_DRILL}") 条每月演练"
      echo -e "  三个任务写同一个日志：${yellow}${logf}${plain}"
    fi
    echo -e "  想现在试跑一次：${green}${VANBLOG_SELF_NAME} backup${plain}（看输出），或等今晚看 ${logf}"
    echo -e "  移除：${green}${VANBLOG_SELF_NAME} install-cron --remove${plain}"
    return 0
  fi
  echo -e "${red}写入后在 crontab 里没找到条目（这台机器的 crontab 可能被别的管理器接管）${plain}"
  return 1
}



# ── 备份前的磁盘空间预检 ────────────────────────────────────────────────────
# server 导出时 ENOSPC 会优雅失败并清掉半成品，但大站上已经白等几分钟；离线 tar 更糟：
# 磁盘满会留下一个**截断的归档**。所以发起备份前先在宿主机侧量一次。
# 估算原则（诚实优先，算不出来就明说并放行，不假装检查过）：
#   full    ：有上一个整站归档 → 用它的大小（最有依据）；
#             没有 → 静态目录实际占用 + 数据库导出按固定 64MB 猜
#             （NDJSON+zstd -19 之后，64MB 够覆盖几十万条文档的库；本站 9838 条文档
#               + 185 个文件实测整包 66MB，静态部分占大头）；
#   offline ：数据目录实际占用（tar.gz 对已压缩的图片几乎不再缩小，算上界）。
# 判定：free < 估算+margin → 中止（非 0）；free < 估算×2+margin → 警告但继续。
# margin 默认 256MB：VANBLOG_BACKUP_SPACE_MARGIN_MB 覆盖；
# VANBLOG_BACKUP_SKIP_SPACE_CHECK=1 完全跳过（cron 里宁可备出来也不被拦时用）。
VANBLOG_SPACE_EST_BYTES=""
VANBLOG_SPACE_EST_SRC=""

backup_space_estimate() { # <full|offline> → 设上面两个全局；算不出返回 1
  local kind="$1" est src=""
  VANBLOG_SPACE_EST_BYTES=""
  VANBLOG_SPACE_EST_SRC=""
  if [[ "${kind}" == "full" ]]; then
    local dir latest static_kb
    dir="$(full_backup_dir 2>/dev/null)"
    latest=""
    if [[ -n "${dir}" && -d "${dir}" ]]; then
      latest="$(ls -1t "${dir}"/vanblog-full-*.tar.* 2>/dev/null | filter_backup_archives | head -1)"
    fi
    if [[ -n "${latest}" && -f "${latest}" ]]; then
      est="$(wc -c <"${latest}" 2>/dev/null)"
      src="上一个归档 $(basename "${latest}") 的大小"
    else
      static_kb="$(du -sk "${VANBLOG_DATA_PATH}/data/static" 2>/dev/null | awk '{print $1}')"
      case "${static_kb}" in
      '' | *[!0-9]*)
        # 静态目录都读不到：只能纯猜数据库部分，明说依据
        est=$((64 * 1024 * 1024))
        src="静态目录读不到，只按数据库导出 64MB 猜"
        ;;
      *)
        est=$((static_kb * 1024 + 64 * 1024 * 1024))
        src="静态目录 $(human_bytes $((static_kb * 1024))) + 数据库导出按 64MB 猜"
        ;;
      esac
    fi
  else
    local data_kb
    data_kb="$(du -sk "${VANBLOG_DATA_PATH}" 2>/dev/null | awk '{print $1}')"
    case "${data_kb}" in
    '' | *[!0-9]*) return 1 ;;
    esac
    est=$((data_kb * 1024))
    src="数据目录实际占用（tar.gz 对已压缩内容几乎不再缩小）"
  fi
  case "${est}" in
  '' | *[!0-9]*) return 1 ;;
  esac
  [[ "${est}" -gt 0 ]] || return 1
  VANBLOG_SPACE_EST_BYTES="${est}"
  VANBLOG_SPACE_EST_SRC="${src}"
  return 0
}

check_backup_space() { # <full|offline> <目标目录>
  local kind="$1" dir="$2"
  if [[ "${VANBLOG_BACKUP_SKIP_SPACE_CHECK:-0}" == "1" ]]; then
    echo -e "> 空间预检：按 VANBLOG_BACKUP_SKIP_SPACE_CHECK=1 跳过"
    return 0
  fi
  if ! backup_space_estimate "${kind}"; then
    echo -e "${yellow}> 空间预检：算不出估算值（du 与历史归档都不可用），跳过检查直接备份 —— 没有假装检查过${plain}"
    return 0
  fi
  # df 的目标：备份目录可能是导出时才创建的，不存在就往上找存在的父目录
  local probe="${dir}"
  while [[ -n "${probe}" && "${probe}" != "/" && ! -d "${probe}" ]]; do
    probe="$(dirname "${probe}")"
  done
  [[ -n "${probe}" ]] || probe="/"
  local free_kb
  free_kb="$(df -Pk "${probe}" 2>/dev/null | awk 'NR==2 {print $4}')"
  case "${free_kb}" in
  '' | *[!0-9]*)
    echo -e "${yellow}> 空间预检：df 读不出 ${probe} 的剩余空间，跳过检查直接备份${plain}"
    return 0
    ;;
  esac
  local free_b=$((free_kb * 1024))
  local margin_mb="${VANBLOG_BACKUP_SPACE_MARGIN_MB:-256}"
  case "${margin_mb}" in
  '' | *[!0-9]*) margin_mb=256 ;;
  esac
  local est="${VANBLOG_SPACE_EST_BYTES}"
  local need=$((est + margin_mb * 1024 * 1024))
  local warn_at=$((est * 2 + margin_mb * 1024 * 1024))
  if ((free_b < need)); then
    echo -e "${red}> 空间预检不通过，已中止备份：${plain}"
    echo -e "${red}    预计需要约 $(human_bytes "${est}")（${VANBLOG_SPACE_EST_SRC}）+ $(human_bytes $((margin_mb * 1024 * 1024))) 余量，${plain}"
    echo -e "${red}    而 ${probe} 只剩 $(human_bytes "${free_b}")。${plain}"
    echo -e "${red}    清出空间再试；余量可用 VANBLOG_BACKUP_SPACE_MARGIN_MB 调整（设 0 = 只要装得下就备）。${plain}"
    return 1
  fi
  if ((free_b < warn_at)); then
    echo -e "${yellow}> 空间预检：剩余 $(human_bytes "${free_b}") 偏紧（预计需要约 $(human_bytes "${est}")，${VANBLOG_SPACE_EST_SRC}），继续备份；建议清理磁盘或调低 --keep${plain}"
    return 0
  fi
  echo -e "> 空间预检通过：预计需要约 $(human_bytes "${est}")（${VANBLOG_SPACE_EST_SRC}），${probe} 剩 $(human_bytes "${free_b}")"
  return 0
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

  # 空间预检放在要 token 之前：别让用户输完密码才告诉他磁盘不够
  check_backup_space full "$(full_backup_dir)" || return 1

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
    # 脚本侧补的校验和：server 的 manifest 里没有 sha256（见 write_sha256_sidecar 注释）
    write_sha256_sidecar "${host_path}"
    mirror_backup_artifacts "${host_path}"
  else
    echo -e "  服务器目录：${yellow}$(full_backup_dir)${plain}（容器内 <日志目录>/vanblog-backups）"
  fi
  # ⚠️ 加密归档必须**在这里**就说清楚：站长往往把归档传到另一台机器/对象存储，
  #    等到真要恢复时才发现打不开就太晚了 —— 而那时口令常常已经不在手边。
  #    判据优先用魔数（读得到文件时），读不到（非 root）才退回看 .enc 后缀，并说明用了哪种判据。
  local export_encrypted=0 enc_judged_by=""
  if [[ -n "${name}" && -f "${host_path}" ]]; then
    if archive_is_encrypted "${host_path}"; then export_encrypted=1; enc_judged_by="魔数 ${BACKUP_ENC_MAGIC}"; fi
  elif archive_has_enc_suffix "${name:-}"; then
    export_encrypted=1; enc_judged_by="文件名 .enc 后缀（宿主机上读不到这个文件，没法验魔数）"
  fi
  if [[ ${export_encrypted} -eq 1 ]]; then
    echo -e "  ${yellow}加密    ：这份归档是加密的（AES-256-GCM，判据：${enc_judged_by}）${plain}"
    echo -e "  ${yellow}          恢复时必须提供当初的口令，口令丢了这份归档就恢复不了：${plain}"
    echo -e "  ${yellow}          VANBLOG_BACKUP_PASSPHRASE='<口令>' ./vanblog.sh restore ${name:-<归档名>}${plain}"
    echo -e "  ${yellow}          或 VANBLOG_BACKUP_PASSPHRASE_FILE=/path/to/pass.txt（chmod 600）${plain}"
  fi
  # ⚠️ 签名状态也要**每次**说清楚（与服务端那条每次备份都打的 WARN 同口径）。
  #    理由与加密那条一样：这个失败模式是**静默**的 —— 归档正常生成、sha256 正常写、
  #    异地镜像正常拷，没有任何地方报错，直到某天需要证明"这份归档没被换过"才发现从没签过。
  #    提醒一次很容易被日志冲走，所以每次都说。
  if [[ -n "${name}" && -f "${host_path}" ]]; then
    if archive_has_signature "${host_path}"; then
      echo -e "  签名    ：${green}已签名${plain}（.sig 在，指纹 ${yellow}$(signature_field_of "${host_path}" keyFingerprint || echo '?')${plain}，签于 $(signature_field_of "${host_path}" signedAt || echo '?')）"
      echo -e "  ${yellow}          ⚠️ 公钥的权威副本必须**离线**保存一份（密码管理器/U 盘）：验签材料只存在这台主机上时，${plain}"
      echo -e "  ${yellow}          拿到主机 root 的人可以连公钥一起换掉，签名就失去意义。取公钥：./vanblog.sh signing-export${plain}"
    else
      echo -e "  签名    ：${yellow}**未签名**${plain}（没有 .sig）⇒ 这份归档能证明「没拷坏」（sha256），但**不能证明「没被换过」**"
      echo -e "  ${yellow}          要签：./vanblog.sh signing-key 生成密钥对，然后给容器配 VANBLOG_BACKUP_SIGNING_KEY_FILE${plain}"
      echo -e "  ${yellow}          （归档里有 jwt 密钥与全部口令哈希，拷到别处就等于把站点凭据明文外送）${plain}"
    fi
  fi
  echo -e "  恢复    ：${green}./vanblog.sh restore ${name}${plain}"
  echo -e "  ${yellow}注意：这份归档不含 caddy 的证书与配置（它们在数据目录里）。要连证书一起备，用 --offline。${plain}"
  return 0
}

# backup 的入口：默认走整站备份，--offline 才打包数据目录
# 备份保留策略：只留最新的 N 份，其余删掉（连带同名的 .manifest.json）。
#
# 为什么要有这个：整站备份一份就是几十 MB（本站实测 66MB），配了 cron 每天备一次的话
# 一个月就是 2GB —— 而**整个仓库里以前没有任何清理逻辑**，脚本和 server 都只管写不管删，
# 小盘机器迟早被备份撑满，而"磁盘满"会让 mongod、caddy、导出全都出各种奇怪的错。
#
# 安全边界（宁可少删，不可多删）：
#   - 只删**自己认识的归档名**：vanblog-full-*.tar.* / vanblog-backup-*.tar.*，别的一概不动；
#   - 只在备份目录里删，不递归子目录；
#   - keep 不是正整数就什么都不做（默认行为完全不变）；
#   - 只在新备份**成功之后**才调用（失败时删旧备份等于把最后的恢复点也弄没了）。
prune_old_backups() {
  local kind="$1" keep="$2"
  local dir pattern
  case "${kind}" in
  full)
    dir="$(full_backup_dir 2>/dev/null)"
    pattern='vanblog-full-*.tar.*'
    ;;
  offline)
    dir="${VANBLOG_BASE_PATH}"
    pattern='vanblog-backup-*.tar.*'
    ;;
  *) return 0 ;;
  esac
  [[ -n "${dir}" && -d "${dir}" ]] || return 0
  case "${keep}" in
  '' | *[!0-9]*) return 0 ;;
  esac
  [[ "${keep}" -gt 0 ]] || return 0

  # ls -1t 按修改时间从新到旧；备份名里没有空格，这样比 find -printf 更可移植。
  # ⚠️ 三种 sidecar（`<归档>.sha256` / `.manifest.json` / `.sig`）**都匹配** `*.tar.*` 这个 glob。
  # 不过滤的后果不是"多算一个"，而是 sidecar **占掉 keep 名额** ⇒ 真归档被提前删掉（数据丢失），
  # 而 sidecar 自己反倒留了下来。过滤一律走共用助手（`filter_backup_archives`），别在这写第二份正则。
  local -a all
  mapfile -t all < <(cd "${dir}" 2>/dev/null && ls -1t ${pattern} 2>/dev/null | filter_backup_archives)
  local total=${#all[@]}
  if [[ ${total} -le ${keep} ]]; then
    echo -e "  保留策略：现有 ${total} 份 ≤ ${keep}，不用清理"
    return 0
  fi
  local i removed=0 freed=0 name size sidecar pretty
  for ((i = keep; i < total; i++)); do
    name="${all[$i]}"
    [[ -n "${name}" ]] || continue
    size=$( (stat -c %s "${dir}/${name}" 2>/dev/null || echo 0) )
    pretty="$(human_size "${dir}/${name}" 2>/dev/null)"
    [[ -n "${pretty}" ]] || pretty="$(human_bytes "${size}")"
    if rm -f "${dir:?}/${name}"; then
      removed=$((removed + 1))
      freed=$((freed + size))
      # 三种 sidecar 与归档同生共死，一律走共用助手删（别在这拼文件名）。
      # ⚠️ 这里原来拼的是 `${name%.tar.*}.manifest.json`（= `vanblog-full-X.manifest.json`），
      #    而 server 写的是 `${archivePath}.manifest.json`（= `vanblog-full-X.tar.zst.manifest.json`，
      #    utils/fullBackup.ts:1339）⇒ **那条 rm 一直没删到任何文件，孤儿清单从来没被清理过**。
      #    而同文件的 verify 分支用的是正确形状（`${file}.manifest.json`），两处口径本来就不一致。
      #    真备份目录里的实际文件名可以作证：`vanblog-full-20260913-172338.tar.zst.manifest.json`
      #    （= `<完整归档名>.manifest.json`）。⚠️ 别写行号进来，行号会漂。
      local sc
      while IFS= read -r sc; do
        [[ -n "${sc}" ]] && rm -f "${sc}"
      done < <(backup_sidecar_paths "${dir}/${name}")
      echo -e "  ${yellow}已删除${plain} ${name}（${pretty}）"
    fi
  done
  echo -e "  保留策略：留最新 ${keep} 份，删掉 ${removed} 份，释放 $(human_bytes "${freed}")"
  return 0
}

# backup 的用法（参数打错时打印）。
print_backup_usage() {
  echo -e "用法：${yellow}$0 backup [开关]${plain}"
  echo -e "  不带开关 = 整站备份（调 server 接口导出 vanblog-full-<时间戳>.tar.zst）"
  echo -e "  --offline                 改成打包整个数据目录（站点起不来时的兜底，也是唯一含 caddy 证书的方式）"
  echo -e "  --consistent              配合 --offline：先停 mongo 再打包（一致性好，期间几十秒不可写）"
  echo -e "  --api | --full            显式要求整站备份（就是默认行为）"
  echo -e "  --format zstd|xz|gzip     换压缩格式（默认 zstd；⚠️ 只对整站备份生效，--offline 忽略它）"
  echo -e "  --keep N                  备份**成功后**只保留最新 N 份（0 或留空 = 不清理）"
  echo -e "  --verbose                 打印完整 JSON（默认只给摘要；等价于 VANBLOG_VERBOSE=1）"
  echo -e "⚠️ 参数打错会**直接拒绝**（退出码 2），不会静默按默认值备份"
}

backup() {
  local mode="${VANBLOG_BACKUP_MODE:-api}"
  local format="${VANBLOG_BACKUP_FORMAT:-zstd}"
  # 保留份数：--keep N 或 VANBLOG_BACKUP_KEEP=N；留空/0 = 不清理（默认行为不变）
  local keep="${VANBLOG_BACKUP_KEEP:-}"
  # ⚠️ 参数解析：打错的开关**必须**被拒绝，不能静默按默认值跑。backup 上这件事尤其贵：
  #    用户敲 `backup --offine`（少一个 l），旧代码一声不响按 API 模式备份，他以为自己拿到了
  #    含 caddy 证书的离线包 —— 等到真要换机器那天才发现归档里没有证书。
  #    同一类里还有一个更隐蔽的：`--verbose` 写在 --help 里、备份输出还会提示"完整清单加 --verbose"，
  #    但解析器**从来没处理过它**（被下面那条 `--*) :` 吞掉），所以照着提示加开关的人永远看不到
  #    完整清单，只有 VANBLOG_VERBOSE=1 才行。现在它真的生效了。
  local -a argv=("$@")
  local i=0 arg val
  local saw_consistent=0 saw_format=0
  while ((i < ${#argv[@]})); do
    arg="${argv[i]}"
    case "${arg}" in
    --offline) mode="offline" ;;
    --api | --full) mode="api" ;;
    --consistent) saw_consistent=1 ;; # 真正解析它的是 backup_offline（下面原样透传 "$@"）
    --verbose) export VANBLOG_VERBOSE=1 ;;
    --format | --keep)
      val="${argv[i + 1]:-}"
      # 少了值也**不许**静默按默认跑：`backup --keep` 后面忘了写数字，旧代码会当成"不清理"
      if [[ -z "${val}" || "${val}" == --* ]]; then
        # ⚠️ 例子要**按开关**给：第一版写成"（例如 ${arg} zstd、${arg} 7）"，
        #    于是 `backup --keep` 的报错里出现「例如 --keep zstd」—— zstd 是 --format 的值，
        #    在一条本来就在讲"你参数写错了"的消息里再给一个错例子，等于把人往沟里带。
        local example="zstd|xz|gzip 里的一个"
        [[ "${arg}" == "--keep" ]] && example="7，表示只留最新 7 份"
        echo -e "${red}${arg} 后面要跟一个值${plain}（例如 ${arg} ${example}）"
        print_backup_usage
        return 2
      fi
      if [[ "${arg}" == "--format" ]]; then
        format="${val}"
        saw_format=1
      else
        keep="${val}"
      fi
      i=$((i + 1)) # 值已经被吃掉了，别再当位置参数过一遍
      ;;
    0) : ;; # 菜单/分发入口传进来的占位
    --*)
      echo -e "${red}backup 不认这个参数：${arg}${plain}"
      print_backup_usage
      return 2
      ;;
    *) : ;; # 位置参数：backup 不接受归档名，多余的字面量照旧忽略（不改变既有行为）
    esac
    i=$((i + 1))
  done
  # 两个"开关合法、但对当前模式无效"的组合：只 WARN 不拦（拦住会把本来能用的命令变成不能用，
  # 而静默忽略正是上面那个坑的同一种病 —— 说了就等于没骗人）
  if ((saw_consistent)) && [[ "${mode}" != "offline" ]]; then
    echo -e "${yellow}⚠️ --consistent 只在 --offline 时有意义（要先停 mongo 才能打包数据目录），这次忽略它${plain}"
    echo -e "${yellow}   想要一致性快照：$0 backup --offline --consistent${plain}"
  fi
  if ((saw_format)) && [[ "${mode}" == "offline" ]]; then
    echo -e "${yellow}⚠️ --offline 打的是 .tar.gz，--format ${format} 对它无效，这次忽略它${plain}"
  fi

  local rc=0
  if [[ "${mode}" == "offline" ]]; then
    backup_offline "$@"
    rc=$?
  else
    backup_full "${format}"
    rc=$?
  fi
  # ⚠️ 只在备份**成功**之后清理：失败时把旧备份删了，等于连最后的恢复点都没了
  if [[ ${rc} -eq 0 && -n "${keep}" ]]; then
    echo -e "> 按保留策略清理旧备份（--keep ${keep}）"
    if [[ "${mode}" == "offline" ]]; then
      prune_old_backups offline "${keep}"
    else
      prune_old_backups full "${keep}"
    fi
  fi
  return ${rc}
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

  # 目录级快照动辄几百 MB（数据目录整个打包），磁盘满会得到一个截断的 tar.gz —— 先量一次
  check_backup_space offline "${VANBLOG_BASE_PATH}" || return 1

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
  write_sha256_sidecar "${dest}"
  mirror_backup_artifacts "${dest}"
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

# ── 备份口令（加密归档）────────────────────────────────────────────────────
# 来源与优先级与 server 侧完全一致（`packages/server/src/utils/backupCrypto.ts` 的
# `resolveBackupPassphrase`）：`VANBLOG_BACKUP_PASSPHRASE_FILE`（**优先**，Docker secret 用）
# > `VANBLOG_BACKUP_PASSPHRASE`（内联）。
# ⚠️ 三条铁律（每条都对应一个真实的泄漏/误判路径）：
#   1. **绝不回显**：不进提示、不进日志、**不进 curl 的 argv**（argv 对同机任何用户 `ps` 可见，
#      query 更糟 —— 它会进 caddy 的访问日志）。所以送给服务端一律走 body，且用
#      `-F "字段=<文件"` / `-d @文件` 这种"值从文件读"的形式。
#   2. 只 **trimEnd**（与 server 一致）：口令里的前导空格可能是有意的一部分，
#      而尾部换行几乎总是"用文件存口令"这个写法带来的。
#   3. `_FILE` 配了但**读不到就失败关闭**（返回 2），绝不静默回落成"当明文归档处理"——
#      那会让站长看到一次"成功"的恢复，而其实恢复的是别的东西/或者根本没解密。
# ⚠️ 口令临时目录用 **PID 作用域的固定路径**，而不是"把建过的文件记进数组"：
#    调用方几乎都是 `f="$(passphrase_temp_file …)"` 这种**命令替换**，而命令替换跑在子 shell 里
#    ⇒ 子 shell 里对数组的 append **传不回父 shell**，EXIT trap 看到的永远是空数组，
#    兜底清理形同虚设（脚本中途死掉时口令就留在磁盘上了）。固定路径不需要跨 shell 传状态：
#    trap 里直接按 `$$` 重算就能删。并发运行互不干扰（PID 不同），且 bash 的 `$$` 在命令替换里
#    仍是**主 shell** 的 PID，所以子 shell 建的文件也落在同一个目录里、同样会被清掉。
VANBLOG_PASS_DIR="${TMPDIR:-/tmp}/vanblog-pass-$$"

_passphrase_cleanup() {
  # 只删自己这个 PID 的目录，绝不碰别人的（通配删 vanblog-pass-* 会误伤并发运行的另一份）
  if [[ -n "${VANBLOG_PASS_DIR}" && -d "${VANBLOG_PASS_DIR}" ]]; then
    rm -rf "${VANBLOG_PASS_DIR}" 2>/dev/null
  fi
  return 0
}
# ⚠️ 用 EXIT 而不只是 INT/TERM：脚本无论以哪种方式结束（正常返回、报错退出、被信号打断后
#    shell 退出）都要清掉口令文件。trap 里不改变退出码（不 exit / 不 return 非 0）。
trap '_passphrase_cleanup' EXIT

# 解析口令。stdout = 口令本身（可能为空串）；返回 0=拿到（含"没配"这种空）、2=`_FILE` 读不到。
# ⚠️ 调用方要用 `pass="$(backup_passphrase_from_env)"` 捕获，**不要**让它直接打到终端。
backup_passphrase_from_env() {
  local fp inline
  fp="${VANBLOG_BACKUP_PASSPHRASE_FILE:-}"
  if [[ -n "${fp}" ]]; then
    if [[ ! -r "${fp}" ]]; then
      echo -e "${red}读不到备份口令文件 ${fp}（VANBLOG_BACKUP_PASSPHRASE_FILE）${plain}" >&2
      echo -e "${yellow}已拒绝继续：不会静默当成明文归档处理。请检查路径与读权限，${plain}" >&2
      echo -e "${yellow}或改用 VANBLOG_BACKUP_PASSPHRASE='<口令>' 内联传入。${plain}" >&2
      return 2
    fi
    # 只去尾部空白（\n\r\t空格），保留前导空格：与 server 的 trimEnd 口径一致
    local raw
    raw="$(cat "${fp}" 2>/dev/null)" || {
      echo -e "${red}读取 ${fp} 失败${plain}" >&2
      return 2
    }
    printf '%s' "${raw%"${raw##*[![:space:]]}"}"
    return 0
  fi
  inline="${VANBLOG_BACKUP_PASSPHRASE:-}"
  printf '%s' "${inline%"${inline##*[![:space:]]}"}"
  return 0
}

# 把口令写进一个 0600 的临时文件，路径打到 stdout（供 curl 的 `<file` / `@file` 用）。
# ⚠️ 目录也要 0700：本机 umask 是 0002，`mkdir` 出来是 0775 ⇒ 同机其他用户能进目录看文件名。
#    `mktemp` 建的文件本身是 0600，但仍显式 chmod 一次（不依赖实现细节）。
passphrase_temp_file() { # <口令> → stdout=文件路径（0600，父目录 0700）
  local dir f n
  dir="${VANBLOG_PASS_DIR}"
  if [[ ! -d "${dir}" ]]; then
    mkdir -p "${dir}" 2>/dev/null || return 1
    # ⚠️ 本机 umask 是 0002 ⇒ mkdir 出来是 0775，同机其他用户能进目录看文件名。必须显式收紧。
    chmod 700 "${dir}" 2>/dev/null
  fi
  # 同一次运行里可能要几个（例如恢复 + 轮换），用序号避免互相覆盖
  n=1
  while [[ -e "${dir}/passphrase-${n}" ]]; do n=$((n + 1)); done
  f="${dir}/passphrase-${n}"
  : >"${f}" || return 1
  chmod 600 "${f}" 2>/dev/null
  printf '%s' "$1" >"${f}"
  printf '%s' "${f}"
}

# 用完立刻删（EXIT trap 只是兜底：口令文件在磁盘上多留一秒都是风险）
passphrase_temp_free() { # <文件路径>
  local f="$1" d
  [[ -n "${f}" ]] || return 0
  d="$(dirname "${f}")"
  rm -f "${f}" 2>/dev/null
  # ⚠️ 只删**自己那个 PID 目录**：万一 f 来自别处（调用方传错），绝不递归删人家的目录
  if [[ -n "${d}" && "${d}" == "${VANBLOG_PASS_DIR}" && -d "${d}" ]]; then
    rmdir "${d}" 2>/dev/null || rm -rf "${d}" 2>/dev/null
  fi
  return 0
}

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
    # 排除 sidecar：清单（vanblog-full-xxx.tar.zst.manifest.json）与校验和
    # （vanblog-full-xxx.tar.zst.sha256）都不是可恢复的归档
    [[ -n "${f}" ]] || continue
    # 同上：`.sig` 会被 `vanblog-full-*` 匹配到，不过滤就会把签名文件列成"可恢复的归档"
    is_backup_sidecar_name "${f}" && continue
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

# 🔴 站点已经起不来时（最常见是 mongo 数据损坏），**两条正常的恢复入口都用不了**：
#    `restore`（走 server 接口）与 `reset` 都要先访问 `/api/public/meta`，而 server 要连得上 mongo
#    ⇒ 库坏了就是死锁。这不是"再试一次"能解决的，唯一出路是把坏掉的数据库目录**移到一边**
#    （不是删除，留着才能回滚与取证）、让站点以「未初始化」状态起来，再用归档重置。
#    这套动作以前只存在于人脑子里（文档与脚本里 0 处提及），所以：
#      ① 这里把它印出来（本函数**只读**，不动任何文件），在两处"站点接口不通"的报错后自动打印；
#      ② `restore --offline-full <归档>` 把它自动化（见 offline_full_restore）。
print_dead_site_playbook() {
  local archive="${1:-<你的归档.tar.zst>}"
  local mongo_dir="${VANBLOG_DATA_PATH}/data/mongo"
  echo -e "${yellow}── 站点起不来时的恢复剧本（mongo 数据损坏 / server 连不上库）──────────${plain}"
  echo -e "  为什么普通恢复用不了：${yellow}restore${plain} 与 ${yellow}reset${plain} 都要先访问 /api/public/meta，"
  echo -e "  而 server 要连得上 mongo ⇒ 库坏了就是死锁。出路只有一条：把坏库移到一边，"
  echo -e "  让站点以「未初始化」状态起来，再用归档重置。"
  echo
  echo -e "  ${green}推荐：一条命令自动做完${plain}（坏库改名保留，不删除，可回滚）"
  echo -e "    ${yellow}${VANBLOG_SELF_NAME} restore --offline-full ${archive}${plain}"
  echo
  echo -e "  ${green}或者手工做（每步都能单独停下来看）${plain}"
  echo -e "    1) 先确认归档是好的：${yellow}${VANBLOG_SELF_NAME} verify ${archive}${plain}"
  echo -e "       ⚠️ 归档本身坏了就别往下走 —— 那会把唯一的退路也毁掉"
  echo -e "    2) 停栈：${yellow}${VANBLOG_SELF_NAME} stop${plain}"
  echo -e "    3) 把坏库移到一边（${red}不要 rm -rf${plain}，留着才能回滚/取证）："
  echo -e "       ${yellow}mv ${mongo_dir} ${mongo_dir}.broken-\$(date +%Y%m%d-%H%M%S)${plain}"
  echo -e "    4) 起栈：${yellow}${VANBLOG_SELF_NAME} start${plain} —— 站点会变成「未初始化」，这是预期的"
  echo -e "    5) 用归档重置：${yellow}${VANBLOG_SELF_NAME} reset ${archive}${plain}"
  echo -e "    6) 核对：${yellow}${VANBLOG_SELF_NAME} status${plain}，再看前台首页与后台能不能登录"
  echo
  echo -e "  回滚（发现恢复出来的不对）：${yellow}${VANBLOG_SELF_NAME} stop${plain} → 删掉新建的 mongo 目录 →"
  echo -e "  把 .broken-* 那个改回 ${yellow}${mongo_dir}${plain} → ${yellow}${VANBLOG_SELF_NAME} start${plain}"
  echo -e "  ⚠️ 这套动作会让当前数据库目录里的内容失效（改名保留，不是删除）；磁盘上还要留出归档解压的空间。"
  echo -e "${yellow}────────────────────────────────────────────────────────────────${plain}"
}

# `restore --offline-full <归档>`：站点已经起不来（通常是 mongo 数据损坏）时的恢复。
#
# ⚠️ 为什么是"把坏库移到一边 + 走既有 reset"，而不是自己写一套 NDJSON 装载器：
#    自己灌数据等于把"临时集合 + 原子替换 + 重建索引 + 静态文件回位 + integrity 校验"再实现一遍，
#    而这些在 server 侧（`utils/fullBackup.ts`）已经写好并被大量测试覆盖。重复实现只会得到第二套
#    需要维护、而且**只在灾难现场才被第一次使用**的代码 —— 那是最坏的组合。
#    所以这里把人工手术自动化：移开坏库（**改名，不删除**）→ 起栈（变未初始化）→ 既有 `reset`。
#    每一步都可回滚，任何一步失败都打印回滚命令，绝不留下"半新半旧"的数据目录。
offline_full_restore() {
  local archive="$1"
  # 跳过验签的开关要能透传到最后的 reset（它才是真正走服务端恢复的那一步）。
  # ⚠️ 脚本侧**不自己实现 ed25519 验签**：bash 里没有原语，硬凑 openssl 容易写错，
  #    而"验签写错"的失败方向是**假通过**（比不验更危险）。离线流程里 `verify` 那一步
  #    只给本地可判定的三态（有 .sig 且指纹 X / 没有 .sig / .sig 形状不对），
  #    真正的密码学验签发生在下面 `reset` 走 HTTP 恢复时，由服务端做。
  local skip_sig="${2:-false}"
  local mongo_dir="${VANBLOG_DATA_PATH}/data/mongo"

  if [[ -z "${archive}" ]]; then
    echo -e "${red}--offline-full 需要指定归档路径${plain}"
    print_restore_usage
    return 2
  fi
  if [[ ! -f "${archive}" ]]; then
    echo -e "${red}归档不存在：${archive}${plain}"
    return 2
  fi

  # 0) 归档必须先自证是好的：这一步不通过就**一个字节都不动**。
  #    理由很直接 —— 接下来要移开当前唯一的数据库，如果归档是坏的，就等于亲手毁掉退路。
  echo -e "> 先校验归档（不通过就不动任何数据）"
  if ! verify "${archive}"; then
    echo -e "${red}归档校验没通过 ⇒ 中止，没有改动任何文件。${plain}"
    echo -e "${yellow}  换一份归档，或用 ${VANBLOG_SELF_NAME} verify-deep ${archive} 看细节。${plain}"
    return 1
  fi

  local stamp aside
  stamp="$(date +%Y%m%d-%H%M%S)"
  aside="${mongo_dir}.broken-${stamp}"
  echo -e "> 将要执行的动作："
  echo -e "    1. 停栈"
  echo -e "    2. ${yellow}${mongo_dir}${plain} → ${yellow}${aside}${plain}（改名保留，${red}不删除${plain}）"
  echo -e "    3. 起栈（站点会变成「未初始化」，这是预期的）"
  echo -e "    4. 用 ${yellow}${archive}${plain} 重置整个站点（初始化 + 恢复 + 重启 + 逐项核对）"
  if [[ "${VANBLOG_ASSUME_YES:-0}" != "1" ]]; then
    local input
    read -e -r -p "确认执行? 输入 yes 继续: " input
    if [[ "${input}" != "yes" ]]; then
      echo "已取消（没有改动任何文件）"
      return 0
    fi
  fi

  echo -e "> 1/4 停栈"
  stop_vanblog 0 || echo -e "${yellow}  stop 返回非 0（可能本来就没在跑），继续${plain}"

  echo -e "> 2/4 移开数据库目录"
  if [[ -d "${mongo_dir}" ]]; then
    if ! mv "${mongo_dir}" "${aside}"; then
      echo -e "${red}移动数据库目录失败：${mongo_dir} → ${aside}${plain}"
      echo -e "${yellow}  常见原因：磁盘满、跨文件系统、权限不足。已中止，站点数据未被改动。${plain}"
      return 1
    fi
    echo -e "  ${green}✓${plain} 坏库已移到 ${aside}（回滚就是把它改回去）"
  else
    echo -e "  ${yellow}!${plain} ${mongo_dir} 不存在 —— 数据目录本来就是空的（全新机器？）"
    aside=""
  fi

  echo -e "> 3/4 起栈"
  if ! start_vanblog 0; then
    echo -e "${red}起栈失败。${plain}"
    if [[ -n "${aside}" ]]; then
      echo -e "${yellow}  回滚：${VANBLOG_SELF_NAME} stop && mv ${aside} ${mongo_dir} && ${VANBLOG_SELF_NAME} start${plain}"
    fi
    return 1
  fi

  echo -e "> 4/4 用归档重置站点"
  local -a reset_args=(0 "${archive}")
  [[ "${skip_sig}" == "true" ]] && reset_args+=(--skip-signature-check)
  if ! reset "${reset_args[@]}"; then
    echo -e "${red}重置失败。${plain}"
    if [[ -n "${aside}" ]]; then
      echo -e "${yellow}  旧库还在：${aside}${plain}"
      echo -e "${yellow}  回滚：${VANBLOG_SELF_NAME} stop && rm -rf ${mongo_dir} && mv ${aside} ${mongo_dir} && ${VANBLOG_SELF_NAME} start${plain}"
    fi
    echo -e "${yellow}  或者换一份归档重试：${VANBLOG_SELF_NAME} reset <另一份归档>${plain}"
    return 1
  fi

  echo -e "${green}✓ 离线恢复完成${plain}"
  if [[ -n "${aside}" ]]; then
    echo -e "  确认站点正常后，旧的坏库可以删掉腾空间：${yellow}rm -rf ${aside}${plain}"
    echo -e "  ⚠️ 在确认之前**别删** —— 它是唯一的回滚点。"
  fi
  echo -e "  建议顺手做一次体检：${yellow}${VANBLOG_SELF_NAME} doctor${plain}"
  return 0
}

restore_full_backup() {
  local target="$1"
  local with_static="${2:-true}"
  # ⚠️ 跳过验签是**安全绕过**，所以刻意做成第 3 个位置参数而不是环境变量：
  #    env 形式（像 --verbose 那样 export 一个变量）意味着 cron、编排文件、甚至
  #    `VANBLOG_RESTORE_SKIP_SIGNATURE=1 ./vanblog.sh restore` 这种一次性前缀都能静默打开它，
  #    而验签被绕过的后果是"恢复了一份被换过的归档"——那是本功能唯一要防的事。
  #    位置参数只能由**命令行上的显式 flag** 传进来，且只认字面 true。
  local skip_sig="${3:-false}"
  if [[ "${skip_sig}" != "true" && "${skip_sig}" != "false" ]]; then
    echo -e "${red}skip_sig 只能是字面 true/false（收到：${skip_sig}）—— 这是调用方的 bug，不是用户输入${plain}" >&2
    return 1
  fi
  local base
  base="$(vanblog_api_base)"
  echo -e "> 整站恢复（走 server 接口）：${yellow}${base}${plain}"

  local code
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "${base}/api/public/meta" 2>/dev/null)"
  [[ -n "${code}" ]] || code="000"
  if [[ "${code}" != "200" ]]; then
    echo -e "${red}站点接口不通（${base}/api/public/meta → ${code}）。${plain}"
    echo -e "${red}整站恢复必须经过 server 的接口（它要按集合原子替换并重建索引），请先 ${yellow}./vanblog.sh start${red} 再试。${plain}"
    # ⚠️ 如果 server 起不来的原因是 mongo 数据坏了，"先 start 再试"是**做不到**的（server 要连库）。
    #    这种死锁以前只在报错里留一句话，用户接下来只能自己猜 —— 所以把完整剧本印出来。
    echo -e "${yellow}  如果 start 也起不来（多半是 mongo 数据损坏），下面这条路能救：${plain}"
    print_dead_site_playbook "${target}"
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

  # ── 加密归档：先把口令准备好（放在"确认恢复"之前，免得用户确认完才被告知缺口令）──
  # ⚠️ 字段名两条路不一样，别搞混（都是**只走 body**，服务端明确不接受 query，因为 query 会进
  #    caddy 的访问日志）：
  #      POST /api/admin/backup/full/restore → `passphrase`（本函数走的就是这条）
  #      POST /api/admin/init/restore        → `backupPassphrase`（未初始化时的匿名恢复）
  #    口令留空也是合法的：服务端会回落到自己的 env（`VANBLOG_BACKUP_PASSPHRASE(_FILE)`），
  #    所以"编排里配好了口令"的部署不需要脚本再送一遍。
  local restore_pass="" restore_pass_rc=0
  restore_pass="$(backup_passphrase_from_env)" || restore_pass_rc=$?
  if [[ ${restore_pass_rc} -eq 2 ]]; then
    # `_FILE` 配了却读不到：失败关闭。绝不"当作没配"继续 —— 那会走到解包阶段才失败，
    # 而那时的报错是"归档损坏"，把站长引到完全错误的方向。
    return 1
  fi
  if [[ ${upload} -eq 1 ]] && archive_is_encrypted "${target}" ]]; then
    if [[ -n "${restore_pass}" ]]; then
      echo -e "> 这份归档是${yellow}加密的${plain}（魔数 ${BACKUP_ENC_MAGIC}）：已带上口令（${#restore_pass} 字节，不回显）"
    else
      echo -e "${red}这份归档是加密的（魔数 ${BACKUP_ENC_MAGIC}），但本机没有口令，恢复必定失败。${plain}"
      echo -e "${yellow}两个办法任选：${plain}"
      echo -e "${yellow}  ① VANBLOG_BACKUP_PASSPHRASE='<当初备份用的口令>' ${VANBLOG_SELF_NAME} restore ${target}${plain}"
      echo -e "${yellow}  ② 把口令写进一个只有你能读的文件（chmod 600），然后${plain}"
      echo -e "${yellow}     VANBLOG_BACKUP_PASSPHRASE_FILE=/path/to/pass.txt ${VANBLOG_SELF_NAME} restore ${target}${plain}"
      echo -e "  （如果口令是配在**容器**的环境里，脚本不送也行 —— server 会自己按 env 解析。）"
      return 1
    fi
  elif [[ -n "${restore_pass}" ]]; then
    echo -e "> 已带上备份口令（${#restore_pass} 字节，不回显）；如果这份归档是明文的，服务端会忽略它"
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

  # ⚠️ 绕过验签的警告必须在**确认之前**打印：确认之后再说的话，站长已经按回车了。
  if [[ "${skip_sig}" == "true" ]]; then
    echo -e "${red}⚠️ 你要求跳过签名校验（--skip-signature-check）。请先读完这一段：${plain}"
    echo -e "  · 验签是唯一能证明「这份归档离开主机后没被换过」的手段（.sha256 与归档同目录，能换归档的人也能换它）；"
    echo -e "  · 跳过后，如果这份归档是被换过的，你会把**攻击者准备的数据**恢复成整站内容，而恢复过程会显示成功；"
    echo -e "  · 归档里含 jwt 密钥与全部口令哈希 ⇒ 换过的归档等于把站点凭据也一起换掉；"
    echo -e "  · 正常做法是先解决验签失败的原因：公钥不对就找回签名时那把公钥（离线副本/密码管理器），"
    echo -e "    配 VANBLOG_BACKUP_VERIFY_KEY(_FILE) 后重试；确实没有公钥、且你接受风险，才用这个 flag。"
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
  local resp pass_file="" body_file=""
  # ⚠️ 值必须是字面 true：服务端 `isTrue(body?.skipSignatureCheck)` 与破坏性恢复的确认闸门同口径，
  #    送 "1"/"yes"/"TRUE" 都不算，会静默地**不跳过**（那时报错是"验签失败"，容易被误读成归档坏了）。
  local -a sig_form=()
  local sig_json=""
  if [[ "${skip_sig}" == "true" ]]; then
    sig_form=(-F "skipSignatureCheck=true")
    sig_json=',"skipSignatureCheck":"true"'
  fi
  # ⚠️ 口令绝不进 argv：`-F 'passphrase=值'` 与 `-d '{…值…}'` 都会把值放在命令行上，
  #    同机任何用户 `ps` 一眼就能看到。所以走"值从文件读"的形式：
  #    multipart 用 `-F "字段=<文件"`（curl 的 `<` 前缀语义），JSON 用 `-d @文件`。
  if [[ -n "${restore_pass}" ]]; then
    pass_file="$(passphrase_temp_file "${restore_pass}")" || {
      echo -e "${red}建不了口令临时文件（磁盘满？TMPDIR 不可写？）${plain}"
      return 1
    }
  fi
  if [[ ${upload} -eq 1 ]]; then
    if [[ -n "${pass_file}" ]]; then
      resp="$(curl -sS -m 7200 -X POST "${base}/api/admin/backup/full/restore" \
        -H "token: ${token}" \
        -F "file=@${target}" \
        -F "confirm=true" \
        -F "withStatic=${with_static}" \
        ${sig_form[@]+"${sig_form[@]}"} \
        -F "passphrase=<${pass_file}" 2>&1)"
    else
      resp="$(curl -sS -m 7200 -X POST "${base}/api/admin/backup/full/restore" \
        -H "token: ${token}" \
        -F "file=@${target}" \
        -F "confirm=true" \
        -F "withStatic=${with_static}" \
        ${sig_form[@]+"${sig_form[@]}"} 2>&1)"
    fi
  else
    # by-name 这条路本来就用 `-d '{…}'`（值在 argv 里）。没口令时保持原样；
    # 有口令时整个 body 改走 0600 文件 + `-d @文件`，避免口令进 argv。
    if [[ -n "${pass_file}" ]]; then
      body_file="${pass_file}.body.json"
      : >"${body_file}" && chmod 600 "${body_file}" 2>/dev/null
      printf '{"name":%s,"confirm":"true","withStatic":"%s"%s,"passphrase":%s}' \
        "$(json_string "${target}")" "${with_static}" "${sig_json}" "$(json_string "${restore_pass}")" >"${body_file}"
      resp="$(curl -sS -m 7200 -X POST "${base}/api/admin/backup/full/restore" \
        -H "token: ${token}" -H 'Content-Type: application/json' \
        -d "@${body_file}" 2>&1)"
    else
      resp="$(curl -sS -m 7200 -X POST "${base}/api/admin/backup/full/restore" \
        -H "token: ${token}" -H 'Content-Type: application/json' \
        -d "{\"name\":$(json_string "${target}"),\"confirm\":\"true\",\"withStatic\":\"${with_static}\"${sig_json}}" 2>&1)"
    fi
  fi
  # 用完立刻删（EXIT trap 只是兜底）：口令文件在磁盘上多留一秒都是风险
  passphrase_temp_free "${pass_file}"
  # 服务端会在响应里带 signatureWarning（例如"没配验签公钥，所以这次没有验签"）。
  # ⚠️ 必须显示出来：这是"这次恢复到底验没验签"的唯一权威说法，而静默不验签
  #    与"验过了"在站长眼里长得一模一样。
  local sigwarn
  sigwarn="$(printf '%s' "${resp}" | grep -oE '"signatureWarning":"[^"]*"' | head -1 | sed 's/^"signatureWarning":"//; s/"$//')"
  if [[ -n "${sigwarn}" ]]; then
    echo -e "  ${yellow}签名：${sigwarn}${plain}"
  fi
  pass_file="" body_file=""

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

# ── JWT 签名密钥轮换 ───────────────────────────────────────────────────────
# 什么时候需要它：怀疑 jwt 签名密钥泄露。**这不是假想**——一份整站备份归档里就含
# `settings{type:'jwt'}` 的密钥，拿到归档的人能**自签管理员 token**（不需要口令、不需要爆破）。
# 所以"归档流出去了"就等于"密钥泄露了"，轮换是唯一的补救（改口令没用：token 不验口令）。
#
# ⚠️ 为什么走 HTTP 而不是 `exec` 进容器跑一次性 node 脚本：HTTP 那条路
# （`POST /api/admin/backup/jwt/rotate`）除了换库里的密钥，还会**就地切换签发侧**
# （`switchJwtSigningKey`），所以正常情况下**不需要重启**；只有切换失败时响应里的
# `restartRequired` 才为 true，那时脚本会明确叫你去重启。一次性 node 进程里没有 JwtService，
# 那条路**必然**要重启，而且拿不到 `apiTokensAffected` 这些数字。
#
# ⚠️ 这是**不可逆**操作，所以默认要交互确认（`--yes` / `VANBLOG_ASSUME_YES=1` 可跳过）。
# 用法：
#   ./vanblog.sh rotate-jwt                     默认宽限期（服务端决定，通常 7 天）
#   ./vanblog.sh rotate-jwt --grace-days 0      旧密钥立即失效（所有旧会话/API Token 马上掉线）
#   ./vanblog.sh rotate-jwt --grace-days 30 --yes
rotate_jwt() {
  local skip_menu=0
  [[ "${1:-}" == "0" ]] && skip_menu=1 && shift
  local grace_days="" assume_yes=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --grace-days)
      grace_days="${2:-}"
      if [[ ! "${grace_days}" =~ ^[0-9]+$ ]] || ((grace_days > 365)); then
        echo -e "${red}--grace-days 要一个 0 到 365 之间的整数（0 = 旧密钥立即失效），收到：${grace_days}${plain}"
        return 1
      fi
      shift 2
      ;;
    --grace-days=*)
      grace_days="${1#*=}"
      if [[ ! "${grace_days}" =~ ^[0-9]+$ ]] || ((grace_days > 365)); then
        echo -e "${red}--grace-days 要一个 0 到 365 之间的整数，收到：${grace_days}${plain}"
        return 1
      fi
      shift
      ;;
    -y | --yes) assume_yes=1; shift ;;
    -h | --help)
      echo -e "  ${green}${VANBLOG_SELF_NAME} rotate-jwt [--grace-days N] [--yes]${plain}"
      echo -e "    轮换 JWT 签名密钥（怀疑密钥/整站备份泄露时的补救）。N=0..365，0 = 旧密钥立即失效。"
      return 0
      ;;
    *)
      echo -e "${red}rotate-jwt 不认识这个参数：$1${plain}"
      echo -e "  可用：${yellow}--grace-days N${plain}（0..365）、${yellow}--yes${plain}（跳过确认）"
      return 1
      ;;
    esac
  done
  [[ "${VANBLOG_ASSUME_YES:-0}" == "1" ]] && assume_yes=1

  local base
  base="$(vanblog_api_base)"
  echo -e "> 轮换 JWT 签名密钥：${yellow}${base}${plain}"

  local code
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "${base}/api/public/meta" 2>/dev/null)"
  [[ -n "${code}" ]] || code="000"
  if [[ "${code}" != "200" ]]; then
    echo -e "${red}站点接口不通（${base}/api/public/meta → ${code}）。先 ${yellow}${VANBLOG_SELF_NAME} start${red} 再试。${plain}"
    return 1
  fi

  # 后果必须在**确认之前**说清：这是不可逆操作，而且受影响的不只是站长自己
  echo -e "${red}这件事不可逆，请先读完三条后果：${plain}"
  echo -e "  1) ${yellow}宽限期内${plain}旧密钥还能验签 ⇒ 现在已登录的会话不会立刻掉线；"
  echo -e "  2) ${yellow}宽限期一过${plain}，所有用旧密钥签发的登录会话与**全部 API Token** 一律失效"
  echo -e "     （API Token 是同一份密钥签的），外部集成必须到后台「Token 管理」重新签发；"
  echo -e "  3) ${yellow}恢复一份旧归档会把密钥一起回滚${plain}（归档里含 jwt 密钥）⇒ 那时需要再轮换一次。"
  echo -e "  ⚠️ 还有一处耦合：waline 子进程的会话密钥是**从本站 jwt 密钥派生**的"
  echo -e "     （packages/server/src/provider/waline/waline.provider.ts 的 JWT_TOKEN），"
  echo -e "     所以轮换后**下次重启 waline 时**，评论者的登录会话会失效，需要重新登录才能评论。"
  if [[ -n "${grace_days}" ]]; then
    echo -e "> 本次宽限期：${yellow}${grace_days} 天${plain}"
  else
    echo -e "> 本次宽限期：用服务端默认值（不传 --grace-days）"
  fi

  if [[ ${assume_yes} -ne 1 ]]; then
    local input
    read -e -r -p "确认轮换? 输入 yes 继续: " input
    if [[ "${input}" != "yes" ]]; then
      echo "已取消（密钥未改动）"
      return 0
    fi
  fi

  local token
  token="$(vanblog_admin_token)" || return 1

  # body 里没有机密（只有 graceDays），所以直接用 -d；⚠️ 但**绝不**把它放 query
  local body='{}'
  [[ -n "${grace_days}" ]] && body="{\"graceDays\":${grace_days}}"
  local resp
  resp="$(curl -sS -m 120 -X POST "${base}/api/admin/backup/jwt/rotate" \
    -H "token: ${token}" -H 'Content-Type: application/json' -d "${body}" 2>&1)"

  if ! printf '%s' "${resp}" | grep -q '"statusCode":200'; then
    echo -e "${red}轮换失败${plain}："
    printf '%s\n' "${resp}" | head -c 600
    echo
    echo -e "${yellow}常见原因：token 过期/无权限（这条接口只有管理员能调，勾「所有权限」的协作者也不行）、"
    echo -e "          演示站禁止修改、或 graceDays 超范围（0..365）。${plain}"
    return 1
  fi

  local data pick
  data="$(printf '%s' "${resp}" | sed 's/^{"statusCode":200,//; s/}$//')"
  pick() { printf '%s' "${data}" | grep -oE "\"$1\":(\"[^\"]*\"|[0-9.]+|true|false|null)" | head -1 | sed -E "s/^\"$1\"://; s/^\"//; s/\"$//"; }
  local kid prev_kid gd affected restart msg
  kid="$(pick kid)"
  prev_kid="$(pick previousKid)"
  gd="$(pick graceDays)"
  affected="$(pick apiTokensAffected)"
  restart="$(pick restartRequired)"
  msg="$(printf '%s' "${resp}" | grep -oE '"message":"[^"]*"' | head -1 | sed 's/^"message":"//; s/"$//')"

  echo -e "${green}JWT 密钥已轮换${plain}"
  [[ -n "${kid}" ]] && echo -e "  新 kid      ：${yellow}${kid}${plain}"
  [[ -n "${prev_kid}" && "${prev_kid}" != "null" ]] && echo -e "  旧 kid      ：${prev_kid}（进入宽限期）"
  [[ -n "${gd}" && "${gd}" != "null" ]] && echo -e "  宽限期      ：${yellow}${gd} 天${plain}"
  if [[ "${affected}" =~ ^[0-9]+$ ]]; then
    echo -e "  受影响 Token：${yellow}${affected}${plain} 个 API Token 会在宽限期结束后失效（要用的请到后台重新签发）"
  fi
  [[ -n "${msg}" ]] && echo -e "  服务端原话  ：${msg}"
  if [[ "${restart}" == "true" ]]; then
    echo -e "${red}⚠️ 签发侧没能就地切换（restartRequired=true）：请重启容器完成切换${plain}"
    echo -e "${yellow}   ${VANBLOG_SELF_NAME} restart${plain}"
    echo -e "   在重启之前，新签发的令牌仍用旧密钥，宽限期一结束它们会提前失效。"
  fi
  echo -e "> 你当前这个 shell 里的 ${yellow}VANBLOG_ADMIN_TOKEN${plain} 在宽限期结束后会失效，届时重新登录取一个新的。"
  return 0
}

# ── 备份离线签名密钥（ed25519）────────────────────────────────────────────────
# 为什么要有签名：整站归档里含 `settings{type:'jwt'}` 的 **jwt 密钥**、全部口令的 scrypt 哈希与
#   `tokens` 集合，而 `.sha256` sidecar 与归档**同目录** ⇒ 能换归档的人也能换 sidecar。
#   所以 sidecar 只能证明「没拷坏」，**不能**证明「没被换过」。签名把后者交到一把
#   **可以离线保存的公钥**上：验签材料不在主机上时，拿到主机 root 也没法伪造出一份"验得过"的归档。
# 为什么走服务端接口，而不是本地 ssh-keygen/openssl：
#   ① 私钥要落在**容器内**的备份目录（目录 0700 / 文件 0600），服务端已经处理好权限与覆盖确认；
#   ② 本地生成还得再把私钥搬进容器（多一次秘密搬运、多一次落盘）；
#   ③ 密钥形状必须与服务端 sign/verify 完全一致，用同一份实现最不容易错。
# ⚠️ 私钥**绝不经 HTTP 返回、绝不打印**（服务端也只返回公钥、指纹与私钥**路径**）；
#    这两个函数同样只打印公钥。守卫里有一条断言"脚本输出里不出现 PRIVATE KEY"。
signing_key() {
  local skip_menu=0
  [[ "${1:-}" == "0" ]] && skip_menu=1 && shift
  local assume_yes=0 overwrite=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
    -y | --yes) assume_yes=1; shift ;;
    --overwrite) overwrite=1; shift ;;
    -h | --help)
      echo -e "  ${green}${VANBLOG_SELF_NAME} signing-key [--overwrite] [--yes]${plain}"
      echo -e "    生成一对 ed25519 备份签名密钥。私钥落在**容器内**的 <备份目录>/signing/（0600），不经接口返回。"
      echo -e "    生成后：整站备份会自动写出 <归档>.sig；公钥请离线保存（${yellow}${VANBLOG_SELF_NAME} signing-export${plain}）。"
      echo -e "    ⚠️ 已有密钥时必须显式加 --overwrite，且覆盖会让**所有旧 .sig 永久验不过**。"
      return 0
      ;;
    *)
      echo -e "${red}signing-key 不认识这个参数：$1${plain}"
      echo -e "  可用：${yellow}--overwrite${plain}（覆盖已有密钥）、${yellow}--yes${plain}（跳过交互确认）"
      return 1
      ;;
    esac
  done
  [[ "${VANBLOG_ASSUME_YES:-0}" == "1" ]] && assume_yes=1

  local base
  base="$(vanblog_api_base)"
  echo -e "> 备份签名密钥：${yellow}${base}${plain}"

  local code
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "${base}/api/public/meta" 2>/dev/null)"
  [[ -n "${code}" ]] || code="000"
  if [[ "${code}" != "200" ]]; then
    echo -e "${red}站点接口不通（${base}/api/public/meta → ${code}）。先 ${yellow}${VANBLOG_SELF_NAME} start${red} 再试。${plain}"
    return 1
  fi

  local token
  token="$(vanblog_admin_token)" || return 1

  # 先读现状：决定是"首次生成"还是"覆盖"，两者的后果差一个数量级
  local cur cf sf vf
  cur="$(curl -sS -m 30 "${base}/api/admin/backup/signing/key" -H "token: ${token}" 2>&1)"
  cf="$(signing_pick "${cur}" signingConfigured)"
  sf="$(signing_pick "${cur}" signingFingerprint)"
  vf="$(signing_pick "${cur}" verifyFingerprint)"
  echo -e "  当前签名密钥：$([[ "${cf}" == "true" ]] && echo "已配置（指纹 ${sf:-?}）" || echo "未配置")"
  echo -e "  当前验签公钥：$([[ -n "${vf}" && "${vf}" != "null" ]] && echo "已配置（指纹 ${vf}）" || echo "未配置（回落用签名密钥导出的公钥）")"

  local body='{}'
  if [[ "${cf}" == "true" ]]; then
    if [[ ${overwrite} -ne 1 ]]; then
      echo -e "${red}已经有一把签名密钥了（指纹 ${sf:-?}），本次不做任何改动。${plain}"
      echo -e "  ⚠️ 覆盖的后果：旧私钥被删掉 ⇒ **所有已签名归档的 .sig 永久无法验证**（除非你还留着旧公钥，"
      echo -e "     而旧私钥没了也就再也签不出新的了）。异地那些副本会全部变成「无法证明真伪」。"
      echo -e "  确实要换，请显式加 ${yellow}--overwrite${plain}（并准备好先把旧公钥归档）："
      echo -e "    ${yellow}${VANBLOG_SELF_NAME} signing-export > ~/vanblog-backup-signing-old.pub.pem${plain}"
      echo -e "    ${yellow}${VANBLOG_SELF_NAME} signing-key --overwrite${plain}"
      return 1
    fi
    echo -e "${red}你要求覆盖已有密钥（指纹 ${sf:-?}）。请先读完后果：${plain}"
    echo -e "  1) 旧私钥会被删掉 ⇒ **所有已签名归档的 .sig 从此永久验不过**；"
    echo -e "  2) 异地/离机的那些副本会失去「可证明没被换过」这个性质（sha256 仍在，但那只防拷坏）；"
    echo -e "  3) 从现在起的新备份会用新密钥签，旧公钥仍然要留着（否则旧归档无法验）。"
    if [[ ${assume_yes} -ne 1 ]]; then
      local input
      read -e -r -p "确认覆盖? 输入 yes 继续: " input
      if [[ "${input}" != "yes" ]]; then
        echo "已取消（密钥未改动）"
        return 0
      fi
    fi
    # ⚠️ 必须是字面 true：服务端用 isTrue()，"1"/"yes"/"TRUE" 都不算（与破坏性恢复的确认闸门同口径）
    body='{"overwrite":"true"}'
  fi

  local resp
  resp="$(curl -sS -m 60 -X POST "${base}/api/admin/backup/signing/key" \
    -H "token: ${token}" -H 'Content-Type: application/json' -d "${body}" 2>&1)"
  if ! printf '%s' "${resp}" | grep -q '"statusCode":200'; then
    echo -e "${red}生成签名密钥失败${plain}："
    printf '%s\n' "${resp}" | head -c 600
    echo
    echo -e "${yellow}常见原因：token 过期/无权限（这条接口只有管理员能调）、演示站禁止修改、或已有密钥但没带 --overwrite。${plain}"
    return 1
  fi

  local fp pp pub msg
  fp="$(signing_pick "${resp}" fingerprint)"
  pp="$(signing_pick "${resp}" privatePath)"
  msg="$(printf '%s' "${resp}" | grep -oE '"message":"[^"]*"' | head -1 | sed 's/^"message":"//; s/"$//')"
  echo -e "${green}备份签名密钥已$([[ "${cf}" == "true" ]] && echo 覆盖 || echo 生成)${plain}"
  [[ -n "${fp}" && "${fp}" != "null" ]] && echo -e "  指纹      ：${yellow}${fp}${plain}"
  [[ -n "${pp}" && "${pp}" != "null" ]] && echo -e "  私钥路径  ：${pp}（容器内，0600；⚠️ 不经接口返回，也不会被打印）"
  [[ -n "${msg}" ]] && echo -e "  服务端原话：${msg}"
  echo
  echo -e "${yellow}⚠️ 现在就把公钥离线保存一份（这是本功能的全部意义所在）：${plain}"
  echo -e "    ${yellow}${VANBLOG_SELF_NAME} signing-export > ~/vanblog-backup-signing.pub.pem${plain}"
  echo -e "  然后把它放进密码管理器/离机介质。验签材料只存在这台主机上时，拿到主机 root 的人可以连公钥一起换掉。"
  echo -e "  从现在起的整站备份会自动写出 <归档>.sig；${yellow}已有归档不会追溯签名${plain}（要签就重新备份一次）。"
  return 0
}

# 只打印**公钥**与指纹，供离线保存（不做任何修改，所以不需要确认）
signing_export() {
  local skip_menu=0
  [[ "${1:-}" == "0" ]] && skip_menu=1 && shift
  case "${1:-}" in
  -h | --help)
    echo -e "  ${green}${VANBLOG_SELF_NAME} signing-export${plain}"
    echo -e "    打印备份签名的**公钥**（PEM）与指纹，供离线保存。⚠️ 不打印私钥（接口也不返回私钥）。"
    return 0
    ;;
  "") ;;
  *)
    echo -e "${red}signing-export 不接受参数（收到：$1）${plain}"
    return 1
    ;;
  esac

  local base
  base="$(vanblog_api_base)"
  local code
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "${base}/api/public/meta" 2>/dev/null)"
  [[ -n "${code}" ]] || code="000"
  if [[ "${code}" != "200" ]]; then
    echo -e "${red}站点接口不通（${base}/api/public/meta → ${code}）。先 ${yellow}${VANBLOG_SELF_NAME} start${red} 再试。${plain}" >&2
    return 1
  fi
  local token
  token="$(vanblog_admin_token)" || return 1

  local resp
  resp="$(curl -sS -m 30 "${base}/api/admin/backup/signing/key" -H "token: ${token}" 2>&1)"
  if ! printf '%s' "${resp}" | grep -q '"statusCode":200'; then
    echo -e "${red}读取签名配置失败${plain}：" >&2
    printf '%s\n' "${resp}" | head -c 400 >&2
    echo >&2
    return 1
  fi
  local sf vf ss vs pub tb
  sf="$(signing_pick "${resp}" signingFingerprint)"
  vf="$(signing_pick "${resp}" verifyFingerprint)"
  ss="$(signing_pick "${resp}" signingSource)"
  vs="$(signing_pick "${resp}" verifySource)"
  tb="$(signing_pick "${resp}" trustBoundary)"
  # publicKey 是一段带 \n 转义的 PEM：用 %b 还原成真的换行，否则存下来的文件是一行转义文本
  pub="$(printf '%s' "${resp}" | grep -oE '"publicKey":"[^"]*"' | head -1 | sed 's/^"publicKey":"//; s/"$//')"
  if [[ -z "${pub}" || "${pub}" == "null" ]]; then
    echo -e "${yellow}还没有签名密钥，所以没有公钥可导出。先生成：${VANBLOG_SELF_NAME} signing-key${plain}" >&2
    return 1
  fi
  # 元信息走 stderr，公钥走 stdout ⇒ `signing-export > pub.pem` 得到的是一份干净的 PEM
  {
    echo -e "# VanBlog 备份签名公钥（ed25519）—— 这是**公开**材料，可以分发；私钥不会被导出"
    echo -e "# 签名密钥指纹：${sf:-?}（来源 ${ss:-?}）"
    echo -e "# 验签公钥指纹：${vf:-?}（来源 ${vs:-?}）"
    [[ -n "${tb}" && "${tb}" != "null" ]] && echo -e "# 信任边界：${tb}"
    echo -e "# 用法：给需要验签的一方配 VANBLOG_BACKUP_VERIFY_KEY_FILE=<这个文件>（或 VANBLOG_BACKUP_VERIFY_KEY=<内容>）"
    echo -e "# 导出时间：$(date '+%F %T %z')"
  } >&2
  printf '%b\n' "${pub}"
  return 0
}

# 从一段 JSON 里取一个顶层/嵌套的标量字段（明文 JSON，用 grep+sed，⚠️ 不引入 jq 依赖）。
# 与 rotate_jwt 里的局部 pick() 同一口径，单独提出来是因为签名这两个命令要复用。
signing_pick() { # <json> <字段名>
  printf '%s' "${1:-}" |
    grep -oE "\"${2:-}\":(\"[^\"]*\"|[0-9.]+|true|false|null)" | head -1 |
    sed -E "s/^\"${2:-}\"://; s/^\"//; s/\"$//"
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
# restore 的用法（参数打错时打印）
print_restore_usage() {
  echo -e "用法：${yellow}$0 restore [归档名|本地路径] [开关]${plain}"
  echo -e "  不带参数 = 列出服务器备份目录里的归档，让你选编号"
  echo -e "  --no-static               只恢复数据库，保留当前图床/附件"
  echo -e "  --with-static             显式恢复静态文件（默认就是恢复）"
  echo -e "  --verbose                 打印完整清单 JSON"
  echo -e "  --skip-signature-check    ${red}跳过归档的 ed25519 验签（安全绕过，请想清楚）${plain}"
  echo -e "                            验签是唯一能证明「归档离开主机后没被换过」的手段：.sha256 与归档"
  echo -e "                            同目录，能换归档的人也能换它，所以 sidecar 只防拷坏、不防被换。"
  echo -e "                            跳过后如果被换过，你会把攻击者准备的数据恢复成整站内容，而过程显示成功。"
  echo -e "                            正常做法：找回签名时那把公钥（离线副本），配 VANBLOG_BACKUP_VERIFY_KEY(_FILE)"
  echo -e "                            后重试。⚠️ 只能由这个 flag 打开（不认环境变量，免得被 cron/编排静默开启）。"
  echo -e "  --offline-full            ${yellow}站点已经起不来时${plain}用（通常是 mongo 数据损坏）："
  echo -e "                            先校验归档 → 停栈 → 把数据库目录${yellow}改名保留${plain}（不删除）→ 起栈 →"
  echo -e "                            用归档重置整站 → 逐项核对。任何一步失败都会打印回滚命令。"
  echo -e "                            ⚠️ 为什么需要它：restore 与 reset 都要先访问站点接口，而 server 要连"
  echo -e "                              mongo ⇒ 库坏了就是死锁，这是唯一不需要故障站点配合的恢复路径。"
  echo -e "⚠️ 参数打错会**直接拒绝**（退出码 2），不会静默按默认值恢复"
}

restore() {
  # ⚠️ "恢复 vanblog" 这句挪到参数解析**之后**：以前它排在最前面，于是
  #    `restore --no-statc x` 会先打印"> 恢复 vanblog"再报错 —— 先宣布干活再拒绝，
  #    读日志的人（尤其是 cron 里）会以为真的动过手。合法调用的输出一字不变
  #    （解析成功时什么都不打印），只有拒绝路径少了这句误导。
  local path="${VANBLOG_RESTORE_FILE:-}"
  local with_static="true"
  # --offline-full：站点已经起不来（通常是 mongo 数据损坏）时的恢复，见 offline_full_restore
  local offline_full="0"
  # --skip-signature-check：跳过归档的 ed25519 验签（安全绕过，只由显式 flag 打开，见 restore_full_backup）
  local skip_sig="false"
  # 分发入口会传一个 0 表示「不进菜单」，别把它当成文件路径
  # ⚠️ 这里以前是 `0 | --*) : ;;` —— 打错的开关被**静默吞掉**。restore 上这件事比 backup 更贵：
  #    `restore --no-statc <归档>`（少一个 i）会安静地按默认值恢复，也就是**连静态文件一起覆盖**，
  #    而用户以为自己保住了当前图床。恢复属于不可逆的那一类操作，猜错方向的代价最高。
  #    所以与 backup / verify / update 一致：未知 `--*` 点名报错 + 打印用法 + 退出码 2。
  #    ⚠️ 只加这一条拒绝：合法开关、位置参数当归档路径、不带参数时列归档让选，行为一个字没改。
  local arg
  for arg in "$@"; do
    case "${arg}" in
    --no-static) with_static="false" ;;
    --offline-full) offline_full="1" ;;
    --skip-signature-check) skip_sig="true" ;;
    --with-static) with_static="true" ;;
    --verbose) export VANBLOG_VERBOSE=1 ;;
    0) : ;; # 菜单/分发入口传进来的占位
    --*)
      echo -e "${red}restore 不认这个参数：${arg}${plain}"
      print_restore_usage
      return 2
      ;;
    *)
      if [[ -n "${arg}" ]]; then
        path="${arg}"
      fi
      ;;
    esac
  done
  echo -e "> 恢复 vanblog"

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

  # 🔴 --offline-full：连 server 都起不来时用（把坏库移到一边 → 起栈 → 走既有 reset）
  #    放在 picker 之后，所以 `restore --offline-full` 不带归档时照样能列出归档让选。
  if [[ "${offline_full}" == "1" ]]; then
    offline_full_restore "${path}" "${skip_sig}"
    return $?
  fi

  # 整站备份（vanblog-full-*）走 server 接口；脚本自己打的数据目录 tar.gz 走下面的离线流程
  if is_full_backup_target "${path}"; then
    restore_full_backup "${path}" "${with_static}" "${skip_sig}"
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
# ── 体检（doctor）与证书剩余天数 ─────────────────────────────────────────────
# ⚠️ 证书为什么不用 openssl 解析：**镜像里没有 openssl 二进制**（apk 清单只有 tzdata/caddy/
#    libwebp-tools/libavif-apps/libc6-compat/zstd/xz/fontconfig/字体），宿主机上也不一定装了
#    openssl 或 node。但容器里一定有 node（server 就是它跑的），而 Node 15+ 自带
#    `crypto.X509Certificate`，能直接读 PEM 拿到 validTo。
#    证书文件在**宿主机侧就能读**（编排把 <数据目录>/caddy/data 挂到 /root/.local/share/caddy），
#    所以做法是：宿主机 find 出 PEM → 内容从 stdin 喂给容器里的 node 解析。
#    容器没在跑就退回本机 node，再退回 openssl；都不行就老实说"解析不了"。
#    ⚠️ 读不到证书（还没签过、纯 IP/HTTP 部署、目录不存在）是**合法状态**，只打一行说明，
#       绝不算 doctor 的失败项 —— 否则 HTTP 部署的站长每次体检都看到红的。
VANBLOG_CERT_NODE_PROG='const c=require("crypto");let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const x=new c.X509Certificate(s);const ms=new Date(x.validTo).getTime()-Date.now();process.stdout.write(String(Math.floor(ms/86400000)))}catch(e){}});'

# 找一个能解析 PEM 的办法，输出剩余天数（整数，可为负）；解析不出来就不输出
cert_days_for_file() {
  local f="$1" cid days=""
  cid="$(vanblog_compose ps -q vanblog 2>/dev/null | head -1)"
  if [[ -n "${cid}" ]]; then
    days="$(docker exec -i "${cid}" node -e "${VANBLOG_CERT_NODE_PROG}" <"${f}" 2>/dev/null)"
  fi
  if [[ -z "${days}" ]] && command -v node >/dev/null 2>&1; then
    days="$(node -e "${VANBLOG_CERT_NODE_PROG}" <"${f}" 2>/dev/null)"
  fi
  if [[ -z "${days}" ]] && command -v openssl >/dev/null 2>&1; then
    local end
    end="$(openssl x509 -in "${f}" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
    if [[ -n "${end}" ]]; then
      local end_s now_s
      end_s="$(date -d "${end}" +%s 2>/dev/null)"
      now_s="$(date +%s)"
      [[ -n "${end_s}" ]] && days=$(( (end_s - now_s) / 86400 ))
    fi
  fi
  case "${days}" in
    ''|*[!0-9-]*) return 1 ;;
  esac
  printf '%s' "${days}"
}

# 打印每个证书的剩余天数，并按阈值上色。返回 0=都健康，1=有 WARN，2=有红的（<7 天）
cert_report() {
  local root="${VANBLOG_DATA_PATH}/caddy/data/certificates"
  if [[ ! -d "${root}" ]]; then
    echo -e "  证书      ：未发现证书目录（HTTP 部署或尚未签发，这是合法状态）"
    return 0
  fi
  local files found=0 rc=0 f days dom
  files="$(find "${root}" -type f \( -name '*.crt' -o -name '*.pem' \) 2>/dev/null | head -20)"
  if [[ -z "${files}" ]]; then
    echo -e "  证书      ：目录在但没有证书文件（还没签发过，或用的是自签降级配置）"
    return 0
  fi
  while IFS= read -r f; do
    [[ -n "${f}" ]] || continue
    found=1
    dom="$(basename "${f}")"; dom="${dom%.*}"
    if ! days="$(cert_days_for_file "${f}")"; then
      echo -e "  证书      ：${yellow}${dom}${plain} 剩余天数解析不了（容器没在跑，本机也没有 node/openssl）"
      echo -e "              ⚠️ 这正是这个检查的固有局限：**站点挂着的时候正好查不到证书状态**。"
      echo -e "              所以请趁站点还活着时定期跑 ${yellow}${VANBLOG_SELF_NAME} doctor${plain}（挂 cron 最好），别等出事才第一次跑。"
      continue
    fi
    # 阈值依据：Let's Encrypt 证书 90 天有效，caddy 大约在剩 1/3（30 天）时开始续，
    # 所以 21 天是"续过一轮都还失败"的告警线；7 天以内基本是"下一轮就要出事"。
    if (( days < 7 )); then
      echo -e "  证书      ：${red}${dom} 剩余 ${days} 天${plain} —— 马上要过期，续签一直失败"
      echo -e "              ${red}⚠️ 已开 HSTS 的话，证书一过期浏览器会硬失败且不给「仍然前往」，站点会彻底进不去${plain}"
      echo -e "              查：${yellow}${VANBLOG_SELF_NAME} log${plain}（找 caddy 的 acme 报错）；救：${yellow}${VANBLOG_SELF_NAME} reset_https${plain}"
      rc=2
    elif (( days < 21 )); then
      echo -e "  证书      ：${yellow}${dom} 剩余 ${days} 天${plain} —— caddy 应该已经在续了，还没续上要查"
      [[ ${rc} -lt 1 ]] && rc=1
    else
      echo -e "  证书      ：${green}${dom} 剩余 ${days} 天${plain}"
    fi
  done <<<"${files}"
  [[ ${found} -eq 0 ]] && echo -e "  证书      ：未发现证书文件"
  return ${rc}
}

# 一次性只读体检：不改任何东西，退出码 0=没发现问题，1=有问题（方便 cron 与监控直接用）
doctor() {
  local problems=0 warns=0
  echo -e "> VanBlog 体检（只读，不改任何东西）"

  # 1) 目录与编排文件
  local compose_file="${VANBLOG_BASE_PATH}/docker-compose.yaml"
  if [[ ! -d "${VANBLOG_DATA_PATH}" ]]; then
    echo -e "  ${red}✗${plain} 数据目录不存在：${VANBLOG_DATA_PATH}"; problems=$((problems+1))
  else
    echo -e "  ${green}✓${plain} 数据目录：${VANBLOG_DATA_PATH}"
  fi
  if [[ ! -f "${compose_file}" ]]; then
    echo -e "  ${red}✗${plain} 没找到编排文件：${compose_file}（还没安装？）"; problems=$((problems+1))
  fi

  # 2) 容器状态、重启次数、编排侧健康状态
  local cid=""
  [[ -f "${compose_file}" ]] && cid="$(vanblog_compose ps -q vanblog 2>/dev/null | head -1)"
  if [[ -z "${cid}" ]]; then
    echo -e "  ${red}✗${plain} vanblog 容器没在跑（先 ${yellow}${VANBLOG_SELF_NAME} start${plain}）"; problems=$((problems+1))
  else
    local st rc_n hc
    st="$(docker inspect -f '{{.State.Status}}' "${cid}" 2>/dev/null)"
    rc_n="$(docker inspect -f '{{.RestartCount}}' "${cid}" 2>/dev/null)"
    hc="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}" 2>/dev/null)"
    if [[ "${st}" == "running" ]]; then
      echo -e "  ${green}✓${plain} 容器：running（重启次数 ${rc_n:-?}，健康状态 ${hc}）"
    else
      echo -e "  ${red}✗${plain} 容器状态：${st}（重启次数 ${rc_n:-?}）"; problems=$((problems+1))
    fi
    # ⚠️ RestartCount 高说明它在崩溃循环里（uncaughtException 现在会非 0 退出，正是靠这个看出来）
    if [[ "${rc_n:-0}" =~ ^[0-9]+$ ]] && (( rc_n >= 5 )); then
      echo -e "  ${red}✗${plain} 重启次数 ${rc_n} ≥ 5：容器在崩溃循环里，查 ${yellow}${VANBLOG_SELF_NAME} log${plain}"; problems=$((problems+1))
    fi
    # podman/buildah 构建会丢掉 Dockerfile 的 HEALTHCHECK ⇒ 这里会是 none，得说清楚
    if [[ "${hc}" == "none" ]]; then
      echo -e "  ${yellow}!${plain} 容器没有健康探测（镜像的 HEALTHCHECK 被构建工具丢掉了，podman/buildah 会这样）"
      echo -e "      编排里那份 healthcheck 需要重新生成：${yellow}${VANBLOG_SELF_NAME} config${plain}；"
      echo -e "      podman 用户还要自己加 ${yellow}--health-on-failure=restart${plain} 才会因 unhealthy 自愈"
      warns=$((warns+1))
    elif [[ "${hc}" == "unhealthy" ]]; then
      echo -e "  ${red}✗${plain} 容器被判定 unhealthy（前台或 server 或 mongo 至少有一个不通）"; problems=$((problems+1))
    fi
  fi

  # 3) 站点接口与 mongo 连通性（health 里带 mongo 字段）
  local base body code
  base="$(vanblog_api_base 2>/dev/null)"
  code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "${base}/api/public/health" 2>/dev/null)"
  [[ -n "${code}" ]] || code="000"
  if [[ "${code}" == "200" ]]; then
    echo -e "  ${green}✓${plain} 健康接口：${base}/api/public/health → 200"
  elif [[ "${code}" == "503" ]]; then
    echo -e "  ${red}✗${plain} 健康接口 → 503：server 活着但 **mongo 连不上**（库损坏/被删/mongo 容器没起）"; problems=$((problems+1))
    echo -e "      库修不回来时用：${yellow}${VANBLOG_SELF_NAME} restore --offline-full <归档>${plain}"
  else
    echo -e "  ${red}✗${plain} 健康接口 → ${code}（站点没在服务）"; problems=$((problems+1))
  fi

  # 4) 磁盘剩余（磁盘满是"小机器 + 被攻击"最现实的死法）
  local dpath avail_kb
  dpath="$(df -Pk "${VANBLOG_DATA_PATH}" 2>/dev/null | awk 'NR==2{print $4}')"
  if [[ -n "${dpath}" ]]; then
    avail_kb="${dpath}"
    if (( avail_kb < 2097152 )); then   # < 2 GiB
      echo -e "  ${red}✗${plain} 数据目录所在盘剩余 $((avail_kb/1024)) MiB —— 备份与静态渲染随时会写失败"; problems=$((problems+1))
    elif (( avail_kb < 10485760 )); then # < 10 GiB
      echo -e "  ${yellow}!${plain} 数据目录所在盘剩余 $((avail_kb/1024/1024)) GiB（一次整站备份 + 恢复要留出归档大小的两倍）"; warns=$((warns+1))
    else
      echo -e "  ${green}✓${plain} 磁盘剩余：$((avail_kb/1024/1024)) GiB"
    fi
  fi

  # 5) 最近一次备份有多旧（RPO）+ cron 旁路状态
  local bdir newest age_h
  bdir="${VANBLOG_DATA_PATH}/log/vanblog-backups"
  if [[ -d "${bdir}" ]]; then
    # ⚠️ `-printf` 是 GNU find 的扩展。取不到时间时**绝不能**顺着"没有归档"那条分支走 ——
    #    那是把一个工具能力问题谎报成"你一份备份都没有"，比不报更糟。
    local ts_ok=1 cnt
    # ⚠️ 两处 `-name` 与下面那个 glob 都要带上 `.enc`：doctor 报"最近一次备份多旧/共几份"，
    #    漏掉加密归档会让站长看到"你已经 N 天没备份了"，而其实每天都备了（只是加密的）。
    if ! find "${bdir}" -maxdepth 1 -type f \( -name 'vanblog-full-*.tar.zst' -o -name 'vanblog-full-*.tar.zst.enc' \) -printf '%T@ %p\n' >/dev/null 2>&1; then
      ts_ok=0
    fi
    if ((ts_ok)); then
      newest="$(find "${bdir}" -maxdepth 1 -type f \( -name 'vanblog-full-*.tar.zst' -o -name 'vanblog-full-*.tar.zst.enc' \) -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1)"
    else
      newest=""
      cnt="$( { ls -1 "${bdir}"/vanblog-full-*.tar.zst "${bdir}"/vanblog-full-*.tar.zst.enc; } 2>/dev/null | wc -l)"
      echo -e "  ${yellow}!${plain} 本机的 find 不支持 -printf（非 GNU/BusyBox），**判断不了备份有多旧**；目录里有 ${cnt} 份归档"
      echo -e "      手工看最新一份：${yellow}ls -lt ${bdir} | head${plain}"
      warns=$((warns + 1))
    fi
    if ((ts_ok)) && [[ -z "${newest}" ]]; then
      echo -e "  ${red}✗${plain} 备份目录里一份整站归档都没有：${bdir}"; problems=$((problems+1))
    else
      local nf nt
      nf="${newest#* }"; nt="${newest%% *}"
      case "${nt%.*}" in
      '' | *[!0-9]*)
        echo -e "  ${yellow}!${plain} 归档的时间戳读出来不是数字（'${nt%.*}'），**不算年龄** —— 不猜"
        warns=$((warns + 1))
        nt=""
        ;;
      esac
      [[ -n "${nt}" ]] && age_h=$(( ( $(date +%s) - ${nt%.*} ) / 3600 ))
      if [[ -z "${nt}" ]]; then
        : # 上面已经报过"读不出时间"，这里不再重复判定
      elif (( age_h > 72 )); then
        echo -e "  ${red}✗${plain} 最近一次备份是 ${age_h} 小时前（$(basename "${nf}")）—— 定时备份可能一直在失败"; problems=$((problems+1))
      elif (( age_h > 26 )); then
        echo -e "  ${yellow}!${plain} 最近一次备份是 ${age_h} 小时前（每天一次的话已经错过一轮）"; warns=$((warns+1))
      else
        echo -e "  ${green}✓${plain} 最近一次备份：${age_h} 小时前（$(basename "${nf}")）"
      fi
    fi
  else
    echo -e "  ${yellow}!${plain} 备份目录不存在：${bdir}（从没备份过？）"; warns=$((warns+1))
  fi
  # cron 备份失败会写在旁路状态文件里（server 不知道 cron 的事，所以单独一个文件）
  local cron_status="${bdir}/cron-status.json"
  if [[ -f "${cron_status}" ]]; then
    local last_rc last_msg
    last_rc="$(grep -oE '"exitCode":[0-9-]+' "${cron_status}" | tail -1 | cut -d: -f2)"
    last_msg="$(grep -oE '"message":"[^"]*"' "${cron_status}" | tail -1 | sed 's/^"message":"//; s/"$//' | head -c 120)"
    if [[ "${last_rc}" != "0" && -n "${last_rc}" ]]; then
      echo -e "  ${red}✗${plain} 最近一次 cron 备份**失败**（exit=${last_rc}）：${last_msg}"; problems=$((problems+1))
    else
      echo -e "  ${green}✓${plain} 最近一次 cron 备份成功${last_msg:+：${last_msg}}"
    fi
  fi

  # 6) caddy 的证书目录有没有真的挂出来（没挂 = 容器一重建就丢证书，会撞 LE 的 5 张/7 天）
  if [[ -f "${compose_file}" ]]; then
    if grep -q "/root/.local/share/caddy" "${compose_file}"; then
      echo -e "  ${green}✓${plain} caddy 证书目录已持久化"
    else
      echo -e "  ${yellow}!${plain} 编排里没有挂 caddy 证书目录（/root/.local/share/caddy）：容器一重建就要重签，"
      echo -e "      而 Let's Encrypt 是 **5 张/7 天**、补充 1 张/34 小时 —— 反复重建会被暂停签发"; warns=$((warns+1))
      echo -e "      重新生成编排：${yellow}${VANBLOG_SELF_NAME} config${plain}"
    fi
  fi

  # 7) 证书剩余天数
  cert_report
  case $? in
    2) problems=$((problems+1)) ;;
    1) warns=$((warns+1)) ;;
  esac

  # 8) 日志里的关键错误（只读扫最近 400 行）
  local logfile="${VANBLOG_DATA_PATH}/log/vanblog-stdio.log"
  [[ -f "${logfile}" ]] || logfile="${VANBLOG_DATA_PATH}/log/vanblog-stdout.log"
  if [[ -f "${logfile}" ]]; then
    local hits
    hits="$(tail -n 400 "${logfile}" 2>/dev/null | grep -cE 'FATAL|uncaughtException|ENOSPC|ECONNREFUSED|out of memory|Reached heap limit')"
    if [[ "${hits:-0}" -gt 0 ]]; then
      echo -e "  ${yellow}!${plain} 最近的日志里有 ${hits} 处严重错误关键字（FATAL/uncaughtException/ENOSPC/…）"
      echo -e "      看：${yellow}tail -n 200 ${logfile}${plain}"; warns=$((warns+1))
    else
      echo -e "  ${green}✓${plain} 最近日志里没有严重错误关键字"
    fi
  fi

  echo
  if (( problems > 0 )); then
    if (( warns > 0 )); then
      echo -e "${red}体检结果：发现 ${problems} 个问题、${warns} 条提醒${plain}"
    else
      echo -e "${red}体检结果：发现 ${problems} 个问题${plain}"
    fi
    echo -e "  站点起不来时的恢复剧本：${yellow}${VANBLOG_SELF_NAME} restore --offline-full <归档>${plain}"
    return 1
  fi
  if (( warns > 0 )); then
    echo -e "${yellow}体检结果：没有致命问题，但有 ${warns} 条提醒${plain}"
    return 0
  fi
  echo -e "${green}体检结果：一切正常${plain}"
  return 0
}

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
    # 证书剩余天数（只读；HTTP/IP 部署没有证书时它自己会说"未发现证书"，不算问题）
    # ⚠️ status 是"看一眼"的命令，不该因为证书快过期就返回非 0 —— 那是 doctor 的职责，
    #    所以这里吞掉返回码，只把信息打出来。
    cert_report || true
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
    count="$(ls -1 "${bdir}"/vanblog-full-*.tar.* 2>/dev/null | filter_backup_archives | wc -l | tr -d ' ')"
    total="$(du -sh "${bdir}" 2>/dev/null | cut -f1)"
    echo -e "  整站备份  ：${count} 个归档，共 ${total}（${bdir}）"
    ls -1t "${bdir}"/vanblog-full-*.tar.* 2>/dev/null | filter_backup_archives | head -3 |
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

# ── 初始化密钥（setup key）──────────────────────────────────────────────────
# 2026-09 起 `VANBLOG_INIT_REQUIRE_SETUP_KEY` **默认开启**（无法识别的值也按开启处理），
# 未初始化站点的两条匿名初始化接口 `POST /api/admin/init` 与 `POST /api/admin/init/restore`
# 都要求携带 `setupKey` 字段，不带就是 400 + body 里的 `setupKeyRequired`。
# 这道保护是有道理的：初始化接口唯一的闸门是"users 集合有没有行"，攻击者一个请求就能把
# 全新实例变成自己的 —— 但它也把**本脚本自己的自动化**挡在外面了：`reset` 与
# `VANBLOG_RESTORE_FROM=… install`（文档宣传的"换机器一步到位"）都要先调 /api/admin/init，
# 不带密钥就必然失败。所以脚本必须自己去把密钥读出来带上。
#
# 密钥是 server 每次启动重新生成的 `randomBytes(32).toString('base64')`（**44 字符**，
# 可能含 `+` `/` `=`），写在 `<日志目录>/setup.key`（0600），站点未初始化期间一直在，
# 初始化成功后 server 自己删掉。编排模板把 `vanblog_data_path/log` 挂到容器 `/var/log`，
# 所以宿主机上就是 `${VANBLOG_DATA_PATH}/log/setup.key` —— **不需要 exec 进容器**
# （drill 那边日志目录是命名卷，才必须 exec；见 vanblog-drill.sh 的 drill_fetch_setup_key）。
# reset / install 都要 root（pre_check），读 0600 没有权限问题。

# 从容器启动日志里兜底取密钥：密钥块启动印一次，之后每 VANBLOG_SETUP_KEY_REMIND_MINUTES
# （默认 10 分钟）重印，所以日志里几乎一定在。
# ⚠️ 必须锚在「初始化密钥： 」（全角冒号 + 空格）这个标签上，**不能裸抓 base64**：
# 同一份日志里还有 restore.key 与 jwt 密钥材料，形状一样是 base64 ——
# 送错密钥比不送更难查（两边都是 400，长得一模一样）。
setup_key_from_logs() {
  # stderr 全部丢掉：没有 docker-compose / 没有编排文件 / 容器没起来都只是"这条路走不通"，
  # 不是错误（调用方会明说看了哪两处）。
  vanblog_compose logs --tail=400 vanblog 2>/dev/null |
    grep -oE '初始化密钥： *[A-Za-z0-9+/=]{20,}' | tail -1 |
    sed -E 's/^初始化密钥： *//' | tr -d '\r\n'
}

# 读初始化密钥：先读宿主机上的 setup.key，读不到再从容器日志兜底；都拿不到就输出空。
# ⚠️ 拿不到时**不报错、不猜**（返回 0 + 空 stdout）：密钥要求可能被显式关掉
# （VANBLOG_INIT_REQUIRE_SETUP_KEY=false），那时不带密钥才是对的，怎么办由调用方决定。
# ⚠️ 这是秘密：只经 stdout 交给调用方，任何提示都别把它打出来（调用方只说长度）。
# 用法：key="$(read_setup_key [等待秒数])"
#   不传秒数 ⇒ 用 VANBLOG_SETUP_KEY_WAIT（默认 15）；传 0 ⇒ 只看一眼、绝不 sleep。
#   ⚠️ 为什么调用方要先传 0：**已初始化的站点上 setup.key 根本不存在**（初始化成功后 server
#   会删掉它），先等满 15 秒等于给最常见的 `reset` 场景平白加 15 秒。所以正确形状是
#   "先看一眼 → 服务端真的回 setupKeyRequired 才值得等 → 等到了再重试一次"。
read_setup_key() {
  local key_file="${VANBLOG_DATA_PATH}/log/setup.key"
  local budget="${1:-${VANBLOG_SETUP_KEY_WAIT:-15}}" waited=0 key=""
  # 数字以外的预算一律当默认值（打错的环境变量不该让这里死循环或立刻放弃）
  [[ "${budget}" =~ ^[0-9]+$ ]] || budget=15
  while :; do
    # 容器刚起来时密钥可能还没写出来（server 要先连库、确认"未初始化"才生成），所以要重试
    if [[ -f "${key_file}" ]]; then
      # base64 里没有空白字符，所以把空白全删掉是最稳的"去首尾换行"
      key="$(tr -d ' \t\r\n' <"${key_file}" 2>/dev/null)"
      if [[ -n "${key}" ]]; then
        printf '%s' "${key}"
        return 0
      fi
    fi
    key="$(setup_key_from_logs)"
    if [[ -n "${key}" ]]; then
      printf '%s' "${key}"
      return 0
    fi
    if (( waited >= budget )); then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 0
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

  # 初始化密钥：镜像默认要求携带（见上面 read_setup_key 的说明）。
  # ⚠️⚠️ 本函数的 stdout 会被调用方当 **token** 用（`token="$(ensure_admin_token …)"`），
  # 所以：① 任何提示都必须走 stderr；② **密钥本身一个字符都不能出现在任何输出里**
  # （要提示只说长度）—— 多打一个字符就会污染 token，表现是"恢复接口 401"，极难查。
  #
  # 顺序是"先看一眼 → 服务端真要密钥才等 → 等到了重试一次"，**不是**"先等满 15 秒再发请求"：
  # 已初始化的站点上 setup.key 根本不存在（初始化成功后 server 会删掉它），先等的话
  # 最常见的「reset 一个已有站点」会平白多花 15 秒；密钥要求被显式关掉时同理。
  local setup_key setup_key_field="" attempt waited_key
  setup_key="$(read_setup_key 0)"
  for attempt in 1 2; do
    setup_key_field=""
    if [[ -n "${setup_key}" ]]; then
      # 走 json_string 而不是手拼：base64 里没有需要转义的字符，但这个 body 是字符串拼出来的，
      # 统一过转义 helper 才不会在将来换个密钥来源时留下注入口子。
      setup_key_field=",\"setupKey\":$(json_string "${setup_key}")"
      echo -e "> 已带上初始化密钥（${#setup_key} 字符，不回显）" >&2
    elif [[ ${attempt} -eq 1 ]]; then
      echo -e "> 没读到初始化密钥（看了 ${VANBLOG_DATA_PATH}/log/setup.key 与容器日志的「初始化密钥：」行）：先试一次 —— 站点已初始化、或镜像显式关掉了 VANBLOG_INIT_REQUIRE_SETUP_KEY 时，不带密钥才是对的" >&2
    fi

    resp="$(curl -sS -m 60 -X POST "${base}/api/admin/init" \
      -H 'Content-Type: application/json' \
      -d "{\"user\":{\"username\":$(json_string "${init_user}"),\"password\":\"${derived}\",\"nickname\":$(json_string "重置初始化")},\"siteInfo\":{\"author\":\"vanblog\",\"siteName\":\"VanBlog\",\"siteDesc\":\"reset\",\"baseUrl\":\"${base}/\"}${setup_key_field}}" 2>&1)"

    if printf '%s' "${resp}" | grep -q '已初始化'; then
      echo -e "> 站点已经初始化过了，用现有账号登录" >&2
      vanblog_admin_token
      return $?
    fi

    # 服务端点名要密钥，而这一趟没带（或带的不是它现在认的那把）⇒ 这时才**值得等**：
    # 容器刚起来时 server 要先连库、确认"未初始化"才生成密钥文件，所以等一会儿再试一次。
    if printf '%s' "${resp}" | grep -q 'setupKeyRequired' && [[ ${attempt} -eq 1 ]]; then
      echo -e "${yellow}> 服务端要求初始化密钥，等它出现（最多 ${VANBLOG_SETUP_KEY_WAIT:-15} 秒）…${plain}" >&2
      waited_key="$(read_setup_key)"
      if [[ -n "${waited_key}" && "${waited_key}" != "${setup_key}" ]]; then
        setup_key="${waited_key}"
        continue # 带着密钥重试一次（只重试一次：初始化接口挂着 5 次/10 分钟的限流）
      fi
      echo -e "${yellow}> 等过了也没拿到可用的密钥，按失败处理${plain}" >&2
    fi

    # 缺密钥/密钥不对要单独点名：否则用户只看到"初始化失败 400"，会去怀疑自己的备份或网络。
    if printf '%s' "${resp}" | grep -q 'setupKey'; then
      echo -e "${red}初始化被拒：服务端要求「初始化密钥」（setupKeyRequired）。${plain}" >&2
      echo -e "${yellow}密钥在 ${VANBLOG_DATA_PATH}/log/setup.key（0600；站点未初始化期间一直在，初始化成功后 server 会删掉），${plain}" >&2
      echo -e "${yellow}也可以从日志取：docker logs <vanblog 容器> 2>&1 | grep 初始化密钥${plain}" >&2
      echo -e "${yellow}脚本会自动读这两处，读不到通常是：容器还没起来（等几秒重试）、或日志目录不是 ${VANBLOG_DATA_PATH}/log${plain}" >&2
      echo -e "${yellow}（自定义过 VAN_BLOG_LOG 或编排里的挂载就会这样）。确实想关掉这道保护：${plain}" >&2
      echo -e "${yellow}给容器设 VANBLOG_INIT_REQUIRE_SETUP_KEY=false 再重试（公网不建议）。${plain}" >&2
      echo -e "${red}服务端原话：$(printf '%s' "${resp}" | head -c 300)${plain}" >&2
      return 1
    fi
    if ! printf '%s' "${resp}" | grep -q '"statusCode":200'; then
      echo -e "${red}初始化失败：$(printf '%s' "${resp}" | head -c 300)${plain}" >&2
      return 1
    fi
    break # 初始化成功，跳出重试循环
  done
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
    # 同上：server 起不来常常是因为 mongo 坏了，那时"先 start"这句话是空头支票 ⇒ 给出真正能走的路。
    echo -e "${yellow}  如果 start 也起不来（多半是 mongo 数据损坏），下面这条路能救：${plain}"
    print_dead_site_playbook "${target}"
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
  VANBLOG_ADMIN_TOKEN="${token}" restore_full_backup "${target}" "${with_static}" "${skip_sig}"
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
  # 与 restore 同一个开关：reset 走的也是 restore_full_backup，验签闸门在那一头
  local skip_sig="false"
  local target=""
  local args=()
  local arg
  for arg in "$@"; do
    case "${arg}" in
    --no-static) with_static="false" ;;
    --with-static) with_static="true" ;;
    --no-restart) do_restart=0 ;;
    --skip-signature-check) skip_sig="true" ;;
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
VanBlog 管理脚本（CKboss/vanblog @ dev/dsh；原始项目 https://github.com/Mereithhh/vanblog）

用法： ./vanblog.sh [子命令] [参数]        不带参数 = 交互菜单
      ./vanblog.sh --help | -h | help    显示本页

──────────────────────── 安装与日常 ────────────────────────
  install                 安装 / 重装。默认「先拉镜像，拉不到再从源码构建」。
                          装完如果设了 VANBLOG_RESTORE_FROM=<归档>，会顺手把整站备份恢复上去。
  config                  重新生成编排文件（邮箱、HTTP/HTTPS 端口、镜像、mongo 版本）。
                          ⚠️ 会覆盖你手写的 environment / 卷映射，改前会自动存一份 .bak-<时间戳>。
                          ⚠️ 不会把镜像换回上游官方版（沿用编排文件里现有的那个）。
                          生成时会实测本机 docker-compose：支持 depends_on 长格式（≥1.27/compose v2）
                          就把「vanblog 等 mongo 健康检查通过再启动」写进去；老版本（如 Ubuntu 20.04
                          的 1.25）保持列表形式并打印一行说明（mongo 的 healthcheck 两种情况下都有）。
  start | stop | restart  启动 / 停止 / 重启（restart 不带 -v，不会删卷）。
                          三者都如实返回 docker-compose 的退出码，失败时打印排查方向。
  update                  更新：**先把新镜像准备好，再停容器**（拉取/构建失败时旧站点还在跑），
                          只删已经没人用的旧镜像，只有版本确实前进才报成功。
      update <版本号>       升到指定发布版：update v2026.9.2 ⇒ 用镜像 ${VANBLOG_FORK_IMAGE}:v2026.9.2
                          （等价于 VANBLOG_IMAGE_REF=<那个 ref> $0 update）
      update <完整镜像ref>   带 / 或 :// 的参数原样当镜像地址用（私有 registry / 镜像加速地址）
      update dev-dsh-<短sha> 回到某一次具体的构建（回滚用）
                          ⚠️ 不带参数 = 升到默认标签 ${VANBLOG_IMAGE_REF}，它会随发布移动；
                            要钉死某一版就带发布号。参数打错**直接拒绝**（退出码 2），不静默按默认升级。
                          ⚠️ 停容器前会打印「当前运行 → 新镜像」两个版本号；新镜像更旧（或证明不了
                            不更旧）时醒目 WARN 并要人确认（VANBLOG_ASSUME_YES=1 不阻塞，WARN 照打）。
  status                  状态总览（只读）：脚本版本、安装/数据目录、编排里的 vanblog 与 mongo 镜像、
                          mongo 数据是否存在、HTTP 端口、接口探活、容器状态、各目录占用、
                          整站备份数量与最近三个归档、磁盘剩余、**证书剩余天数**。
  doctor                  体检（只读，不改任何东西）：容器状态与重启次数、健康探测有没有生效、
                          健康接口（503 = server 活着但 mongo 连不上）、磁盘剩余、最近一次备份多旧、
                          cron 备份上次是否失败、caddy 证书目录有没有持久化、**证书剩余天数**
                          （<21 天提醒、<7 天报红）、日志里的严重错误关键字。
                          退出码 0 = 没有致命问题（可能仍有提醒），**1 = 有问题** ⇒ 可以直接挂 cron 或监控。
                          ⚠️ 读不到证书（纯 HTTP/IP 部署、还没签发）是合法状态，只打一行说明，不算问题。
  log                     查看日志（docker-compose logs）。
  uninstall               卸载。会问确认；**不删备份**；顺带清掉本分支镜像、本地构建 tag 与自建 shim。
  reset_https             重置 https 设置（证书签不出来、域名换过、caddy 配置被改坏时用）。
  update_script           更新此脚本自身（校验语法与首尾标志，版本相同不替换）。

──────────────────────── 备份 / 恢复 / 重置 / 校验 / 定时 ────────────────────────
  backup                          整站备份（默认）：调 server 接口导出
                                  vanblog-full-<时间戳>.tar.zst 到 <数据目录>/log/vanblog-backups/。
                                  一致性快照、NDJSON 跨 MongoDB 版本可恢复、可预览清单。
        --format zstd|xz|gzip     换压缩格式（默认 zstd）
        --offline                 改成打包整个数据目录（vanblog-backup-*.tar.gz）：
                                  站点起不来时的兜底，也是唯一**包含 caddy 证书**的方式
        --offline --consistent    先停 mongo 再打包（一致性好，几十秒不可写）
        --keep N                  备份**成功后**只保留最新 N 份，其余删掉（连带 .manifest.json）。
                                  配 cron 必备：一份整站备份几十 MB，不清理迟早撑满磁盘。
                                  留空或 0 = 不清理（默认）。只删 vanblog-full-* / vanblog-backup-*，
                                  别的文件一概不动。也可用 VANBLOG_BACKUP_KEEP=N。
        --verbose                 打印完整 JSON（默认只给摘要）
                                  ⚠️ 导出前有磁盘空间预检：估算值（上一个归档的大小，或静态目录
                                     +64MB）加余量超过剩余空间就拒绝备份（非 0 退出），只是偏紧
                                     则警告后继续；估算不出来会明说"跳过检查"，不假装查过。
                                  成功后脚本会记一份 <归档>.sha256 校验和（verify 时比对）。
  restore                         从整站备份恢复。不带参数 = 列出服务器备份目录里的归档让你选编号。
        restore <归档名>           归档在服务器备份目录里 → 不上传，秒级开始（几百 MB 也一样）
        restore <本地路径>         本地文件 → multipart 上传
        --no-static               只恢复数据库，保留当前图床/附件
        --skip-signature-check    跳过归档的 ed25519 验签（**安全绕过**）。验签是唯一能证明「归档离开
                                  主机后没被换过」的手段（.sha256 与归档同目录 ⇒ 只防拷坏、不防被换）；
                                  跳过后若归档被换过，你会把攻击者准备的数据恢复成整站且过程显示成功。
                                  正常做法是找回公钥配 VANBLOG_BACKUP_VERIFY_KEY(_FILE) 后重试。
                                  ⚠️ 只认这个 flag（不认环境变量，免得被 cron/编排静默打开）。
        --offline-full            🔴 **站点已经起不来时**用（通常是 mongo 数据损坏）：先校验归档 →
                                  停栈 → 把数据库目录**改名保留**（不删除）→ 起栈 → 用归档重置整站 →
                                  逐项核对；任何一步失败都打印可直接照抄的回滚命令。
                                  为什么需要它：restore 与 reset 都要先访问站点接口，而 server 要连
                                  mongo ⇒ 库坏了就是死锁，这是唯一不需要故障站点配合的恢复路径。
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
        --skip-signature-check    跳过归档的 ed25519 验签（**安全绕过**，含义与 restore 那条完全相同；
                                  reset 走的是同一个恢复接口，所以开关也在同一处生效）
                                  ⚠️ 恢复失败时会把临时管理员账号打印出来，不会把你锁在门外。
  rotate-jwt                    轮换 JWT 签名密钥。**怀疑密钥泄露时用**：一份整站备份归档里
                                  就含 jwt 密钥，拿到它能自签管理员 token（改口令没用，token 不验口令）。
        --grace-days N            宽限期天数（0..365，0 = 旧密钥立即失效）。不传 = 用服务端默认值。
        --yes                     跳过交互确认（脚本/cron 里用；这是不可逆操作，请自己想清楚）
                                  ⚠️ 宽限期一过，所有旧登录会话与**全部 API Token** 失效（外部集成
                                  要在后台重新签发）；恢复旧归档会把密钥回滚，需要再轮换一次；
                                  waline 的评论者会话在下次重启 waline 后失效（它的密钥派生自本站 jwt 密钥）。
                                  这条接口只有管理员能调（勾「所有权限」的协作者也不行）。
  signing-key                     生成一对 ed25519 **备份签名密钥**。私钥落在容器内 <备份目录>/signing/
                                  （0600），**不经接口返回、也不打印**；生成后整站备份会自动写出 <归档>.sig。
        --overwrite               覆盖已有密钥。⚠️ 覆盖会让**所有旧 .sig 永久验不过**（旧私钥被删），
                                  所以不加这个参数时脚本拒绝改动，并先把 signing-export 的命令给你。
        --yes                     跳过交互确认（脚本/cron 用）
                                  为什么要签名：.sha256 sidecar 与归档同目录 ⇒ 能换归档的人也能换 sidecar，
                                  所以它只防「拷坏」、不防「被换过」；而归档里含 jwt 密钥与全部口令哈希。
                                  ⚠️ 公钥必须**离线**保存一份（signing-export），否则拿到主机 root 的人
                                  可以连公钥一起换掉，签名就失去意义。
  signing-export                  打印备份签名的**公钥**（PEM）与指纹，供离线保存。公钥走 stdout、
                                  元信息走 stderr ⇒ `signing-export > pub.pem` 得到一份干净的 PEM。
                                  ⚠️ 只读，不做任何修改；私钥不会被导出（接口也不返回私钥）。
  verify                          校验备份归档（**不解压落盘**），三步：
                                    a) 流式过一遍解压器（zstd/xz/gzip -t）——截断/损坏当场发现
                                    b) sha256 比对——只有**本脚本**做的备份才有 <归档>.sha256 记录；
                                       没有记录就明说跳过（⚠️ server 导出的归档另有**内部** integrity 块：
                                       逐成员 sha256 + merkleRoot + 双清单，那一层由下面的 verify-deep 用）
                                    c) 列成员清单：manifest.json、各集合 NDJSON、静态树在不在
        verify <归档名|路径>…      校验指定的归档（名字会在备份目录里找）；
                                  不带参数 = 校验备份目录里的**全部** vanblog-full-* 归档
                                  任一归档 FAIL → 退出码非 0（可以放进监控/cron）。
                                  ⚠️ verify 不接受任何开关：打错会退出码 2 并打印用法，不会静默忽略。
                                  要语义级校验用 verify-deep；要「扫全部 + 结果表」用 verify-deep --all。
  verify-deep                     verify 的全部输出（原样，一条不少）+ 一层「能不能恢复」的语义校验：
                                  清单 kind/version 认不认、声明的集合有没有对应 .ndjson、成员路径是不是
                                  绝对路径/带 ..（恢复会 400）、条数是否自洽、static·themes 在不在、需要哪个
                                  解压工具本机有没有。归档带 integrity 块时再往下钻一层：逐成员 sha256、
                                  merkleRoot 重算、双清单逐字节对照、整归档 sha256 对外部参照。
                                  会挡住恢复的 → FAIL（非 0 退出）；只是降级的 → WARN。
        --all                     扫全部保留归档，另出一张结果表 + 机器可读的 VERIFY-RESULT 行
                                  ⚠️ 与上面的 verify 并存是故意的：verify 老、宽松、**要 root**，退出码语义不变
                                  （老 cron 继续用它）；verify-deep 新、严格、**不要 root**，新写的 cron/监控
                                  用这条。但校验再深也只是**静态**判断 —— 能证明「恢复得回来」的只有 drill。
  drill                           恢复演练：起一套**一次性**容器（临时 mongo + vanblog），把这份归档真恢复
                                  一遍再逐项断言。走的是用户真会走的那条路（匿名恢复接口，只在未初始化时开放），
                                  断言的是语义，不只是「接口返回了 200」；失败时打容器日志里的错误行 + 尾部，
                                  并且总是拆干净（trap，--keep 才留）。
        drill [归档名|路径]       不带参数 = 用备份目录里最新的一份 vanblog-full-* 归档
        --image <ref>             演练用的 vanblog 镜像（默认跟真栈同一个）
        --http-port N             宿主机 HTTP 端口（默认自动挑；mongo 端口绝不指向 27017 那个真库）
        --keep                    演练完**不拆**，打印怎么访问、怎么删
        --dry-run                 只打印会做什么（引擎/镜像/名字/端口/卷/每一步），什么都不动
                                  结论行：RESULT: PASS pass=… warn=… fail=… note=…（fail 不为 0 就先别升级）
  backup-verify                   备份**并立刻验证**：调 backup，成功后对新归档跑上面那套语义校验，再查一次
                                  陈旧度；任一步失败 → 非 0 退出。配 cron 用它替换 backup 即可（install-cron 写的
                                  那一行改一个词；参数变了要加 --force 才会替换旧条目）。
        --all                     把备份目录里**每一份**保留归档都深度校验（位腐烂不挑时间）
        --drill                   顺手对这份新归档跑一次 drill（需要容器引擎与镜像）
        --stale-days N            最新归档超过 N 天就算失败（默认 7；0=不查）
        --reverify-days N         任何归档距上次「验证通过」超过 N 天 → 失败并点名（默认 0=关）
  backup-status                   不翻日志就能回答：「最近一次备份什么时候？验过没有？演练过没有？」
                                  文件系统 / 台账 / server 的 backup-status.json 三方对账，说法不一致本身就是 WARN；
                                  陈旧了 → 非 0 退出（适合放监控）。
        --strict                  最新归档没有「已验证」记录时也非 0 退出
        --stale-days N            陈旧判据（默认 7 天）
                                  ⚠️ 这四条（verify-deep / drill / backup-verify / backup-status）都由 vanblog-drill.sh
                                  实现，vanblog.sh 在 pre_check **之前**就转交过去，所以都**不需要 root**，
                                  也不会去 mkdir /var/vanblog。完整参数与更多开关：./vanblog.sh drill --help
  backup-cron-run                 定时备份的**专用入口**（install-cron 装进 crontab 的就是它，
                                  一般不用手敲）。与裸 backup 的区别是它把"失败"变成看得见的事件：
                                    1. 整站备份失败 ⇒ 自动回落 `backup --offline`（直接打包数据目录，
                                       不需要 server 活着 —— 也就是站点被打瘫时唯一还能产出备份的方式，
                                       而且它是唯一连 caddy 证书一起备的）；
                                    2. 结果写进 <备份目录>/cron-status.json（0600，临时名 + mv），
                                       `doctor` 与 `status` 会读它 ⇒ 备份一直在失败这件事不再只有翻日志才知道；
                                    3. 设了 VANBLOG_BACKUP_ALERT_WEBHOOK 就在失败时 POST 一次告警
                                       （⚠️ 打不通绝不影响备份结果与退出码）；
                                    4. 顺手跑一次 backup-status --strict，把"陈旧/未验证"也记进状态文件。
                                  退出码 = 备份本身的结果（两种都失败才非 0）。
  install-cron                    把「每天一次整站备份」装进 root 的 crontab（幂等：
                                  已有同样的条目就不重复加；参数不同会拒绝并让你显式 --force）。
        --hour N                  每天几点跑（0-23，默认 3）
        --every N                 每 N 小时跑一次（1-23，与 --hour 互斥）⇒ RPO = N 小时
        --keep N                  备份成功后保留最新 N 份（默认 VANBLOG_BACKUP_KEEP 或 7）
        --with-verify             再装一条「每周校验」：周日 <hour+1>:00 跑 backup-verify
                                  （先做一次新备份再立刻验证，失败非 0 退出）。便宜，建议开。
        --with-drill              再装一条「每月演练」：每月 1 号 <hour+2>:00 跑 drill（起一次性
                                  容器真恢复一遍并逐项对账）。**默认关**：要容器引擎 + 磁盘
                                  （归档大小的两倍以上），小机器上别开。
                                  ⚠️ --remove 删**全部**三种任务；--force 只重写这次请求的那几条；
                                  重复装同一个任务不会出现两行；--remove 与 --with-* 互斥（退出码 2）。
        --remove                  从 crontab 移除（token 文件保留，路径会打印出来）
        --force                   用新参数替换已有条目
                                  token 取 VANBLOG_ADMIN_TOKEN（或安装时交互输入），写进
                                  <安装目录>/vanblog-cron.env（0600 仅 root），cron 行 source 它。
                                  ⚠️ 权衡：管理员 token 长期明文落盘；怀疑泄露就作废它再 --force。
                                  没有 crontab 命令/不给 token 都会明说后果，不假装装好了。

──────────────────────── 环境变量 ────────────────────────
  装什么：
    VANBLOG_INSTALL_MODE=auto|image|source   默认 auto：先拉镜像，拉不到再源码构建
    VANBLOG_IMAGE_REF=<ref>                  默认 ghcr.io/ckboss/vanblog:latest（最近一次发布构建）；
                                             可指镜像加速地址，或用 `update <发布号>` 钉死某一版
    VANBLOG_USE_UPSTREAM_IMAGE=true          改用上游官方镜像（不含本分支任何改动）
    VANBLOG_MONGO_IMAGE=mongo:7.0            **只在全新安装时生效**；已有数据目录会保持原 tag
                                             （数据目录与 FCV 绑定，直接换大版本 mongod 会拒绝启动）
                                             老机器 CPU 不支持 avx 就设 mongo:4.4.16
    VANBLOG_RESTORE_FROM=<归档>              install 之后自动 reset（换机器一步到位）
    VANBLOG_RELEASE_TAG=latest               下载回退里本分支 Release 附件用哪个 tag（默认 latest；
                                             回退顺序：本分支 raw → 本分支 jsDelivr → 本分支 Release
                                             → 上游文档站 → 上游 raw → 上游 jsDelivr）
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
    VANBLOG_BACKUP_KEEP=7                    等价于 backup --keep 7（只留最新 7 份）
    VANBLOG_BACKUP_MIRROR_DIR=               备份成功后把归档（含 .sha256）再复制到**第二个目的地**
                                           （另一块盘 / NFS / 对象存储的 FUSE 挂载点都行）。
                                           ⚠️ 默认空 = 不镜像，行为与以前完全一样。
                                           为什么需要：归档默认就在 <数据目录>/log/vanblog-backups，
                                           和数据**同一棵树、通常同一块盘** ⇒ 盘毁/误删/被勒索时一起没。
                                           复制后会校验（sha256 → zstd -t → 只比字节数并明说没真校验），
                                           校验不过就删掉坏副本。⚠️ 目的地出问题**绝不会**让本地备份算失败。
    VANBLOG_BACKUP_MIRROR_KEEP=              镜像目的地保留几份（默认与 VANBLOG_BACKUP_KEEP 相同）。
                                           清理只碰 vanblog-full-*.tar.zst（含 .enc）/ *-data.tar.gz，别的文件一个不动。
    VANBLOG_BACKUP_ALERT_WEBHOOK=            定时备份**失败**时 POST 一次 JSON（{"text": "..."}）到这个地址。
                                           只在失败时发；10 秒超时；⚠️ 打不通绝不影响备份结果与退出码。
    VANBLOG_SKIP_PULL=1                      完全不联网，只用本机已有的镜像（air-gapped 装机/升级）。
                                           本机没有那个镜像就明确报错并说清怎么 docker load。
                                           ⚠️ 不设它时照常 pull（否则 latest 这类会移动的标签永远升不上去）；
                                           pull 失败但本地有一份 ⇒ 自动回落本地那份并警告"可能不是最新"。
    VANBLOG_BACKUP_SPACE_MARGIN_MB=256       备份前空间预检的余量（MB）：剩余 < 估算+余量 → 拒绝备份
    VANBLOG_BACKUP_SKIP_SPACE_CHECK=1        完全跳过空间预检（估算不出来时本来就会明说并放行）
    VANBLOG_RESTORE_FILE=<路径>              等价于 restore <路径>（老写法，仍支持）
    VANBLOG_RESET_INIT_USER / _PASS          reset 自动初始化用的临时账号（默认随机口令）
    VANBLOG_SETUP_KEY_WAIT=15                服务端**真的要**初始化密钥时，等它出现的秒数
                                             （读 <数据目录>/log/setup.key，读不到再从容器日志的
                                             「初始化密钥： 」行兜底；0 = 不等）。已初始化的站点
                                             不会白等 —— 那时密钥文件本来就不存在，脚本先看一眼、
                                             被拒了才等。密钥会自动带上且绝不回显（提示只说长度）；
                                             想关掉这道保护是 VANBLOG_INIT_REQUIRE_SETUP_KEY=false
  其它：
    VANBLOG_SKIP_MAIN=1                      只加载函数不执行主流程（写测试用）

──────────────────────── 常见场景 ────────────────────────
  新机器装机：            ./vanblog.sh install
  换机器搬站（一步）：     VANBLOG_RESTORE_FROM=/path/to/vanblog-full-xxx.tar.zst ./vanblog.sh install
  换机器搬站（两步）：     ./vanblog.sh install && ./vanblog.sh reset /path/to/vanblog-full-xxx.tar.zst
  每天凌晨三点整站备份（留 7 份）：
                          VANBLOG_ADMIN_TOKEN=<token> ./vanblog.sh install-cron --hour 3 --keep 7
                          （一条命令写进 root 的 crontab；token 存 0600 的 vanblog-cron.env，
                            移除用 install-cron --remove。手写 crontab 的等价行见 docs/guide/backup.md）
  校验备份还能不能用：      ./vanblog.sh verify            # 全部归档；或 verify <归档名|路径>
  升级（钉死发布版）：     ./vanblog.sh update v2026.9.2
  升级（跟最近一次发布）： ./vanblog.sh update          # 用默认的 :latest
  回滚镜像：              ./vanblog.sh update <旧发布号>（或 dev-dsh-<短sha> 回到某次构建）
                          也可以把编排里的 image 改成那个 ref 再 restart
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
    <安装目录>/vanblog-cron.env               install-cron 写的定时备份环境（0600，含管理员 token）
    <数据目录>/data/static                    图床与附件
    <数据目录>/data/mongo                     MongoDB 数据文件
    <数据目录>/log                            日志（容器里的 /var/log）
    <数据目录>/log/vanblog-backup-cron.log    定时备份的输出日志（install-cron 写的 cron 行重定向到这）
    <数据目录>/log/vanblog-backups            整站备份归档 + .manifest.json 清单 + .sha256 校验和
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
    仓库    ：${yellow}CKboss/vanblog${plain} 分支 ${yellow}${VANBLOG_BRANCH}${plain}（原始项目 Mereithhh/vanblog）
    安装目录：${VANBLOG_BASE_PATH}    数据目录：${VANBLOG_DATA_PATH}
    镜像来源：${yellow}${VANBLOG_IMAGE_REF}${plain}$([[ "${VANBLOG_USE_UPSTREAM_IMAGE:-}" == "true" ]] && echo "（已切到上游官方镜像，不含本分支改动）")
              模式 ${VANBLOG_INSTALL_MODE:-auto}：先拉镜像，拉不到再从源码构建$( [[ -n "${VANBLOG_RESTORE_FROM:-}" ]] && echo "；装完自动恢复 ${VANBLOG_RESTORE_FROM}")
$(menu_state_line)
    ${green}── 安装与日常 ──────────────────────────────${plain}
    ${green}1.${plain}  安装 / 重装 VanBlog
    ${green}2.${plain}  修改配置（邮箱 / HTTP·HTTPS 端口 / 镜像 / mongo 版本）
    ${green}3.${plain}  启动服务        ${green}4.${plain}  停止服务        ${green}5.${plain}  重启服务
    ${green}6.${plain}  更新（先把新镜像准备好，再停容器；失败时旧站点还在跑）
        菜单里这项用的是默认镜像标签；要升到**指定发布版**请用命令：${green}./vanblog.sh update v2026.9.2${plain}
    ${green}7.${plain}  查看日志        ${green}13.${plain} 状态总览（镜像/容器/接口/目录占用/备份/磁盘）
    ${green}── 备份与恢复 ──────────────────────────────${plain}
    ${green}10.${plain} 备份（整站备份：一致性快照、跨 MongoDB 版本可恢复、可预览清单）
    ${green}11.${plain} 恢复（从整站备份恢复，${yellow}不停服${plain}；不带参数会列出归档让你选）
    ${green}12.${plain} 重置整站（${yellow}新机器推荐${plain}：自动初始化 + 恢复 + 重启 + 逐项核对）
    ${green}14.${plain} 定时备份（写进 root 的 crontab：每天一次整站备份，默认保留 7 份，幂等）
    ${green}15.${plain} 校验备份（不解压验证归档：压缩完整性 + sha256 + 内容清单）
    ${green}16.${plain} 体检（${yellow}只读${plain}：容器/接口/磁盘/备份新旧/证书剩余天数/日志错误，有问题退出码非 0）
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
  14)
    install_cron
    ;;
  15)
    verify
    ;;
  16)
    doctor
    ;;
  20)
    update_script
    ;;
  30)
    show_usage
    ;;
  *)
    echo -e "${red}请输入正确的数字 [0-30]${plain}"
    ;;
  esac
}

if [[ "${VANBLOG_SKIP_MAIN:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

# 只读/自包含的子命令在 pre_check **之前**就转交给 vanblog-drill.sh：
# pre_check 会 `mkdir -p /var/vanblog` 且对非 root 直接 exit 1，而这些子命令
# （恢复演练、深度校验、备份状态）既不写 /var/vanblog、也不需要 root 权限的 docker daemon
# （rootless podman 就够），临时空间走 mktemp -d、演练存储走引擎管理的命名卷，
# 所以没有理由被 root 门槛挡住。放在 dispatcher 里是没用的 —— dispatcher 在 pre_check 之后。
case "${1:-}" in drill | verify-deep | backup-verify | backup-status) _vb_drill_sub="$1"; shift; exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/vanblog-drill.sh" "${_vb_drill_sub}" "$@" ;; esac

# 帮助也必须在 pre_check **之前**处理，理由与上面那条转发完全一样：
# pre_check 会 `mkdir -p /var/vanblog` 且对非 root 直接 exit 1 ⇒ 非 root 用户连 `--help` 都看不到，
# 只会得到一句"必须使用root用户运行此脚本"。而帮助里正好写着"哪四条子命令免 root"—— 讽刺的是
# 想知道这件事的人恰恰是那个没有 root 的人。show_usage 只读脚本顶部就定好的
# VANBLOG_IMAGE_REF / VANBLOG_FORK_IMAGE，不依赖 pre_check 里算的 os_arch，所以提前是安全的。
# ⚠️ dispatcher 里那个 `-h | --help | help` 分支保留（现在走不到，但它是防御性的：
#    有人把这段挪回去或从别处调 dispatcher 时仍然有帮助可看）。
case "${1:-}" in -h | --help | help) show_usage; exit 0 ;; esac
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
    shift
    update 0 "$@" # 透传 `update <版本|完整 ref>`（与 restore/reset 同一写法）
    exit $?
    ;;
  "log")
    show_log 0
    ;;
  "status")
    show_status 0
    ;;
  "doctor")
    shift
    doctor "$@"
    exit $?
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
  "backup-cron-run")
    shift
    backup_cron_run "$@"
    exit $?
    ;;
  "verify")
    shift
    verify "$@"
    exit $?
    ;;
  "install-cron")
    shift
    install_cron "$@"
    exit $?
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
  "rotate-jwt")
    shift
    rotate_jwt 0 "$@"
    exit $?
    ;;
  "signing-key")
    shift
    signing_key 0 "$@"
    exit $?
    ;;
  "signing-export")
    shift
    signing_export 0 "$@"
    exit $?
    ;;
  *) show_usage ;;
  esac
else
  show_menu
fi
