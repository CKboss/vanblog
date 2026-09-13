#!/usr/bin/env bash
# VanBlog 本地开发环境脚本（工作区自包含，不依赖 docker / sudo / 全局 node）
#
# 用法:
#   ./dev-env.sh bootstrap  首次准备: 下载 Node 20 / pnpm 8 / MongoDB 7 到 .tools/，并建好本地骨架
#   ./dev-env.sh install    安装依赖 (pnpm 8 + Node 20, store 在 .tools/pnpm-store)
#   ./dev-env.sh            启动全部 (MongoDB + server:3000 + website:3001 + admin:3002)
#   ./dev-env.sh start      同上
#   ./dev-env.sh stop       停止全部
#   ./dev-env.sh restart    重启全部
#   ./dev-env.sh status     查看端口/进程状态
#   ./dev-env.sh logs [server|website|admin|mongod]   跟踪日志
#   ./dev-env.sh db     巡检数据库（mongod 版本 / FCV / 各集合条数 / 站点信息）
#
# 说明:
#   - Node 使用 .tools/node20 (v20.19.5)。系统默认的 Node 24 会让 @nestjs/cli 崩溃
#     (util.isObject 在 Node 23 被移除)，Node 18/20 才是本项目验证过的版本。
#   - pnpm 使用 .tools/node_modules/pnpm (8.11.0，与 package.json 的 packageManager 一致)。
#   - MongoDB 使用 .tools/mongodb (7.0.14) 的免安装版，数据目录 vanblog_dev/mongo-data；
#     另备有 .tools/mongodb50 / .tools/mongodb60 用于导入更老版本的备份（见下方说明）。
#   - HOME 被隔离到 .tools/home，避免 picgo 等组件写 ~/.picgo 失败；
#     npm/pnpm 缓存也全部落在工作区内 (.tools/npm-cache, .tools/pnpm-store)。
set -uo pipefail
cd "$(dirname "$0")"
ROOT=$PWD

# 页脚与后台「关于」显示的版本号来自环境变量 VAN_BLOG_VERSION（server 的 utils/loadConfig.ts:
#   export const version = process.env['VAN_BLOG_VERSION'] || 'dev'）。
# 官方镜像在构建时用 --build-arg VAN_BLOG_VERSIONS=<tag> 写死（注意 Dockerfile 里构建参数是
# 复数 VERSIONS、注入的环境变量是单数 VERSION），源码直跑时没人设它，就会显示 "dev"。
# 本地开发给一个能对上代码的标签：分支名 + 短 sha。
_git_sha=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)
VERSION_LABEL="dev/dsh${_git_sha:+@$_git_sha}"

NODE_BIN="$ROOT/.tools/node20/bin"
NODE="$NODE_BIN/node"
PNPM_CJS="$ROOT/.tools/node_modules/pnpm/bin/pnpm.cjs"
# 数据库版本说明：
#   - 导入的官方备份原本是 mongo 4.4 的数据 (FCV=4.4)，已按 5.0 -> 6.0 的升级链把 FCV 升到 6.0，
#     所以现在日常直接用 .tools/mongodb (7.0.14) 启动（7.0 拒绝 FCV<6.0 的数据：
#     "UPGRADE PROBLEM: Invalid featureCompatibilityVersion"）。
#   - 以后若还要导入更老的备份：先用 .tools/mongodb50 (5.0.34) 打开并 setFCV 5.0，
#     再用 .tools/mongodb60 (6.0.29) 打开并 setFCV 6.0，最后交回 7.0；
#     FCV 可用 vanblog_dev/set-fcv.cjs 设置（node vanblog_dev/set-fcv.cjs <port> <version>）。
MONGOD="$ROOT/.tools/mongodb/bin/mongod"
[ -x "$MONGOD" ] || MONGOD="$ROOT/.tools/mongodb50/bin/mongod"

DEV_DIR="$ROOT/vanblog_dev"
LOG_DIR="$DEV_DIR/logs"
PID_DIR="$DEV_DIR/pids"
MONGO_DATA="$DEV_DIR/mongo-data"
MONGO_PORT=27017

REGISTRY="${VANBLOG_REGISTRY:-https://registry.npmmirror.com}"

export PATH="$NODE_BIN:$PATH"
export HOME="$ROOT/.tools/home"
export PNPM_HOME="$ROOT/.tools/pnpm-home"
export npm_config_cache="$ROOT/.tools/npm-cache"
export npm_config_store_dir="$ROOT/.tools/pnpm-store"
export npm_config_registry="$REGISTRY"
# 国内网络下 GitHub 直连超时，原生依赖的二进制走 npmmirror 镜像：
#   - disturl: node-gyp 需要的 node 头文件
#   - sharp_binary_host / sharp_libvips_binary_host: sharp 预编译产物与 libvips
export npm_config_disturl="${VANBLOG_NODE_DISTURL:-https://npmmirror.com/mirrors/node}"
export npm_config_sharp_binary_host="${VANBLOG_SHARP_MIRROR:-https://npmmirror.com/mirrors/sharp}"
export npm_config_sharp_libvips_binary_host="${VANBLOG_SHARP_LIBVIPS_MIRROR:-https://npmmirror.com/mirrors/sharp-libvips}"
# 开发环境不需要下载 e2e 浏览器/无头浏览器，跳过以加快安装（需要时手动执行 pnpm playwright）
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PUPPETEER_SKIP_DOWNLOAD=1

pnpm() { "$NODE" "$PNPM_CJS" "$@"; }

# 工具链自检：缺什么就直说，别让人对着 "node: command not found" 猜。
# 用法: need_toolchain [mongo]   （带 mongo 参数时连 mongod 一起检查）
need_toolchain() {
  local missing=0
  [ -x "$NODE" ] || { echo "!! 缺少 Node 20: $NODE"; missing=1; }
  [ -f "$PNPM_CJS" ] || { echo "!! 缺少 pnpm 8.11.0: $PNPM_CJS"; missing=1; }
  if [ "${1:-}" = "mongo" ] && [ ! -x "$MONGOD" ]; then
    echo "!! 找不到 mongod（.tools/mongodb/bin/mongod 或 .tools/mongodb50/bin/mongod）"; missing=1
  fi
  if [ "$missing" -ne 0 ]; then
    echo "   请按 AGENTS.md §3.1-3.2 准备 .tools/ 工具链（Node 20 + pnpm 8.11.0 + MongoDB 7.0），"
    echo "   然后再执行: ./dev-env.sh install && ./dev-env.sh start"
    exit 1
  fi
}

mkdir -p "$LOG_DIR" "$PID_DIR" "$MONGO_DATA" "$DEV_DIR/static" "$DEV_DIR/codeRunner" \
  "$DEV_DIR/pluginRunner" "$HOME" "$PNPM_HOME" "$ROOT/.tools/npm-cache"

port_pid() { # 找出监听某端口的 pid（需要 ss 能看到进程信息，否则返回空）
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

port_open() { # 端口是否有服务在监听（不依赖 ss 的进程可见性）
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3<&- 3>&-; return 0; } || return 1
}

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

read_pid() { cat "$PID_DIR/$1.pid" 2>/dev/null; }

do_install() {
  need_toolchain
  echo "==> 安装依赖 (registry: $REGISTRY, 日志: vanblog_dev/logs/install.log)"
  pnpm install --frozen-lockfile --store-dir "$ROOT/.tools/pnpm-store" --registry "$REGISTRY" 2>&1 \
    | tee "$LOG_DIR/install.log"
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] && echo "==> 依赖安装完成" || echo "!! 依赖安装失败 (exit $rc)，见 vanblog_dev/logs/install.log"
  return "$rc"
}

start_mongo() {
  local pid; pid=$(read_pid mongod)
  if alive "$pid"; then echo "==> MongoDB 已在运行 (pid $pid, :$MONGO_PORT)"; return 0; fi
  echo "==> 启动 MongoDB (127.0.0.1:$MONGO_PORT, 数据: vanblog_dev/mongo-data)"
  "$MONGOD" --dbpath "$MONGO_DATA" --port "$MONGO_PORT" --bind_ip 127.0.0.1 \
    --fork --logpath "$LOG_DIR/mongod.log" --pidfilepath "$PID_DIR/mongod.pid" >/dev/null
}

start_svc() { # name, label, log, cmd...
  local name=$1 label=$2 log=$3; shift 3
  local pid; pid=$(read_pid "$name")
  if alive "$pid"; then echo "==> $label 已在运行 (pid $pid)"; return 0; fi
  echo "==> 启动 $label  (日志: ${log#$ROOT/})"
  setsid nohup "$@" >"$log" 2>&1 &
  echo $! >"$PID_DIR/$name.pid"
}

do_start() {
  need_toolchain mongo
  if [ ! -d "$ROOT/node_modules" ]; then
    echo "!! 还没安装依赖，先执行: ./dev-env.sh install"; exit 1
  fi
  start_mongo
  # server 用本地的 tsconfig.dev.json（限制 typeRoots 在仓库内），
  # 避免 TS 4.9 去解析家目录 node_modules/@types/bun 里的 bun-types 而报语法错误。
  start_svc server "server  (:3000)" "$LOG_DIR/server-dev.log" \
    bash -c "cd '$ROOT/packages/server' && exec env VANBLOG_DISABLE_WEBSITE=true VAN_BLOG_VERSION='$VERSION_LABEL' ./node_modules/.bin/nest start --watch -p tsconfig.dev.json"
  start_svc admin "admin   (:3002)" "$LOG_DIR/admin-dev.log" \
    "$NODE" "$PNPM_CJS" --filter @vanblog/admin dev
  start_svc website "website (:3001)" "$LOG_DIR/website-dev.log" \
    "$NODE" "$PNPM_CJS" --filter @vanblog/theme-default dev
  echo
  echo "启动中（首次编译需要 1-3 分钟），日志目录: vanblog_dev/logs/"
  echo "  后台管理 : http://localhost:3002   (首次访问会引导初始化博客)"
  echo "  前台站点 : http://localhost:3001"
  echo "  后端 API : http://localhost:3000   (Swagger: /swagger-ui 见 server 日志)"
  echo "  评论服务 : http://localhost:8360   (由 server 自动拉起 waline)"
  echo "查看状态: ./dev-env.sh status    跟踪日志: ./dev-env.sh logs server"
}

stop_one() { # name, label
  local pid; pid=$(read_pid "$1")
  if alive "$pid"; then
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null
    echo "stopped $2 (pid $pid)"
  fi
  rm -f "$PID_DIR/$1.pid"
}

do_stop() {
  stop_one server "server"
  stop_one admin "admin"
  stop_one website "website"
  sleep 2
  # 兜底：清理仍占用端口的残留子进程（只匹配本工作区路径）
  for port in 3000 3001 3002 8360; do
    local pid; pid=$(port_pid "$port")
    if [ -n "${pid:-}" ]; then kill "$pid" 2>/dev/null && echo "killed :$port (pid $pid)"; fi
  done
  # 兜底清理：只杀命令行里带本工作区路径的进程；waline 由 server 用相对路径拉起，
  # 命令行里不含 $ROOT，需要单独按脚本名匹配（否则下次启动会 bind EADDRINUSE :8360）。
  # 注意排除脚本自身与父进程，避免 pkill -f 把自己的 shell 一起杀掉。
  local self=$$ parent=$PPID p
  for p in $(pgrep -f "$ROOT/packages" 2>/dev/null; pgrep -f '@waline/vercel/vanilla\.js' 2>/dev/null); do
    case "$p" in
      "$self" | "$parent") continue ;;
    esac
    kill "$p" 2>/dev/null
  done
  local mpid; mpid=$(read_pid mongod)
  if alive "$mpid"; then
    "$MONGOD" --dbpath "$MONGO_DATA" --shutdown >/dev/null 2>&1 && echo "stopped mongod (pid $mpid)"
  fi
  rm -f "$PID_DIR/mongod.pid"
}

do_status() {
  printf "%-10s %-8s %-8s %s\n" SERVICE PORT STATE PID
  for entry in "server:3000" "website:3001" "admin:3002" "waline:8360" "mongod:$MONGO_PORT"; do
    local name=${entry%%:*} port=${entry##*:}
    local pid; pid=$(read_pid "$name")
    local state="stopped"
    if alive "$pid"; then
      state="running"
    elif port_open "$port"; then
      # waline 由 server 拉起、没有 pidfile；端口通就说明在跑
      state="running"; pid=$(port_pid "$port"); pid=${pid:-"(子进程)"}
    fi
    printf "%-10s %-8s %-8s %s\n" "$name" "$port" "$state" "${pid:--}"
  done
}

do_logs() {
  local target=${1:-server}
  case "$target" in
    server) tail -n 100 -f "$LOG_DIR/server-dev.log" ;;
    website) tail -n 100 -f "$LOG_DIR/website-dev.log" ;;
    admin) tail -n 100 -f "$LOG_DIR/admin-dev.log" ;;
    mongod) tail -n 100 -f "$LOG_DIR/mongod.log" ;;
    *) echo "unknown target: $target (server|website|admin|mongod)"; exit 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# bootstrap: 把工具链装进 .tools/（Node 20 + pnpm 8 + MongoDB 7），并建好本地骨架
#
#   ./dev-env.sh bootstrap                     # 装 Node/pnpm/mongod + 建目录/软链/config.yaml
#   ./dev-env.sh bootstrap --with-legacy-mongo # 额外装 5.0/6.0，用于导入 FCV 4.4 的老备份
#
# 可用环境变量覆盖（都有默认值）:
#   VANBLOG_NODE_VERSION      默认 20.19.5
#   VANBLOG_PNPM_VERSION      默认 8.11.0（要和 package.json 的 packageManager 一致）
#   VANBLOG_MONGO_VERSION     默认 7.0.14
#   VANBLOG_MONGO_PLATFORM    默认 ubuntu2204（老发行版缺 libssl3 时可试 ubuntu2004）
#   VANBLOG_NODE_DISTURL      Node  tarball 源，默认 npmmirror 镜像；海外可换 https://nodejs.org/dist
#   VANBLOG_MONGO_MIRROR      MongoDB tarball 源，默认 https://fastdl.mongodb.org/linux
#   VANBLOG_PROXY             下载命令前缀，例如 "proxychains4 -q"
#   VANBLOG_KEEP_DOWNLOADS=1  保留下载的 tarball（默认装完就删）
# ---------------------------------------------------------------------------
BOOTSTRAP_NODE_VERSION="${VANBLOG_NODE_VERSION:-20.19.5}"
BOOTSTRAP_PNPM_VERSION="${VANBLOG_PNPM_VERSION:-8.11.0}"
BOOTSTRAP_MONGO_VERSION="${VANBLOG_MONGO_VERSION:-7.0.14}"
BOOTSTRAP_MONGO50_VERSION="${VANBLOG_MONGO50_VERSION:-5.0.34}"
BOOTSTRAP_MONGO60_VERSION="${VANBLOG_MONGO60_VERSION:-6.0.29}"
BOOTSTRAP_MONGO_PLATFORM="${VANBLOG_MONGO_PLATFORM:-ubuntu2204}"
NODE_DIST_BASE="${VANBLOG_NODE_DISTURL:-https://npmmirror.com/mirrors/node}"
MONGO_DIST_BASE="${VANBLOG_MONGO_MIRROR:-https://fastdl.mongodb.org/linux}"
PROXY_CMD="${VANBLOG_PROXY:-}"
KEEP_DOWNLOADS="${VANBLOG_KEEP_DOWNLOADS:-0}"

host_arch_node() {
  case "$(uname -m)" in
    x86_64) echo "x64" ;;
    aarch64 | arm64) echo "arm64" ;;
    *) return 1 ;;
  esac
}

host_arch_mongo() {
  case "$(uname -m)" in
    x86_64) echo "x86_64" ;;
    aarch64 | arm64) echo "aarch64" ;;
    *) return 1 ;;
  esac
}

# fetch <url> <输出文件> [quiet]
# 已经存在且非空就跳过（可重复执行）；配了 VANBLOG_PROXY 就走代理前缀。
fetch() {
  local url=$1 out=$2 quiet=${3:-}
  if [ -s "$out" ]; then
    [ -n "$quiet" ] || echo "    已缓存 $(basename "$out")，跳过下载"
    return 0
  fi
  [ -n "$quiet" ] || echo "    下载 $url"
  mkdir -p "$(dirname "$out")"
  if [ -n "$PROXY_CMD" ]; then
    # shellcheck disable=SC2086
    $PROXY_CMD curl -fL --retry 3 --retry-delay 2 -C - -sS -o "$out" "$url"
  else
    curl -fL --retry 3 --retry-delay 2 -C - -sS -o "$out" "$url"
  fi
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$out"
    [ -n "$quiet" ] || echo "    !! 下载失败 (exit $rc)：$url"
    return 1
  fi
  return 0
}

sha256_of() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }

# check_sha256 <文件> <期望值>
check_sha256() {
  local got; got=$(sha256_of "$1")
  [ -n "$got" ] && [ "$got" = "$2" ]
}

drop_tarball() {
  [ "$KEEP_DOWNLOADS" = "1" ] || rm -f "$1"
}

install_node() {
  if [ -x "$NODE" ] && [ "$("$NODE" -v 2>/dev/null)" = "v$BOOTSTRAP_NODE_VERSION" ]; then
    echo "==> Node v$BOOTSTRAP_NODE_VERSION 已就绪，跳过"
    return 0
  fi
  local arch; arch=$(host_arch_node) || { echo "!! 不支持的架构: $(uname -m)"; return 1; }
  local name="node-v$BOOTSTRAP_NODE_VERSION-linux-$arch"
  local tarball="$ROOT/.tools/$name.tar.xz"
  echo "==> 安装 Node v$BOOTSTRAP_NODE_VERSION ($arch) 到 .tools/node20"
  fetch "$NODE_DIST_BASE/v$BOOTSTRAP_NODE_VERSION/$name.tar.xz" "$tarball" || return 1

  # 官方 SHASUMS256.txt 能拿到就校验（拿不到只警告，不阻断）
  local sums="$ROOT/.tools/SHASUMS256-node-v$BOOTSTRAP_NODE_VERSION.txt" expected
  if fetch "$NODE_DIST_BASE/v$BOOTSTRAP_NODE_VERSION/SHASUMS256.txt" "$sums" quiet; then
    expected=$(grep " $name\.tar\.xz\$" "$sums" | awk '{print $1}' | head -1)
    if [ -n "$expected" ]; then
      if check_sha256 "$tarball" "$expected"; then
        echo "    sha256 校验通过"
      else
        echo "!! sha256 校验失败，已删除下载文件；请检查网络/镜像后重试"
        rm -f "$tarball"; return 1
      fi
    else
      echo "    (SHASUMS256.txt 里没有这个文件名，跳过校验)"
    fi
  else
    echo "    (拿不到 SHASUMS256.txt，跳过校验)"
  fi

  local tmp="$ROOT/.tools/.bootstrap-node.$$"
  rm -rf "$tmp"; mkdir -p "$tmp"
  tar -xf "$tarball" -C "$tmp" || { echo "!! 解压失败（文件可能不完整）"; rm -rf "$tmp"; return 1; }
  [ -d "$tmp/$name" ] || { echo "!! 解压后没找到 $name 目录"; rm -rf "$tmp"; return 1; }
  rm -rf "$ROOT/.tools/node20"
  mv "$tmp/$name" "$ROOT/.tools/node20" && rm -rf "$tmp"
  drop_tarball "$tarball"; rm -f "$sums"
  echo "    已安装: $("$ROOT/.tools/node20/bin/node" -v)"
}

install_pnpm() {
  if [ -f "$PNPM_CJS" ] && [ "$("$NODE" "$PNPM_CJS" -v 2>/dev/null)" = "$BOOTSTRAP_PNPM_VERSION" ]; then
    echo "==> pnpm $BOOTSTRAP_PNPM_VERSION 已就绪，跳过"
    return 0
  fi
  [ -x "$NODE" ] || { echo "!! 需要先装好 Node（.tools/node20）"; return 1; }
  echo "==> 安装 pnpm $BOOTSTRAP_PNPM_VERSION 到 .tools/node_modules（registry: $REGISTRY）"
  local pkg="$ROOT/.tools/package.json"
  if [ ! -f "$pkg" ]; then
    printf '{"name":"vanblog-dev-tools","private":true,"dependencies":{"pnpm":"%s"}}\n' \
      "$BOOTSTRAP_PNPM_VERSION" > "$pkg"
  fi
  mkdir -p "$ROOT/.tools/home" "$ROOT/.tools/npm-cache"
  HOME="$ROOT/.tools/home" PATH="$NODE_BIN:$PATH" \
    "$NODE_BIN/npm" install --prefix "$ROOT/.tools" --cache "$ROOT/.tools/npm-cache" \
      --registry "$REGISTRY" --no-audit --no-fund >/dev/null || {
        echo "!! pnpm 安装失败，可手动执行:"
        echo "   HOME=\$PWD/.tools/home PATH=\$PWD/.tools/node20/bin:\$PATH npm install --prefix \$PWD/.tools pnpm@$BOOTSTRAP_PNPM_VERSION"
        return 1
      }
  echo "    已安装: pnpm $("$NODE" "$PNPM_CJS" -v)"
}

# install_mongo <版本> <目标目录名> [是否检查 ldd]
install_mongo() {
  local ver=$1 dir=$2
  local bin="$ROOT/.tools/$dir/bin/mongod"
  if [ -x "$bin" ]; then
    echo "==> .tools/$dir 已就绪 ($("$bin" --version 2>/dev/null | head -1))，跳过"
    return 0
  fi
  local arch; arch=$(host_arch_mongo) || { echo "!! 不支持的架构: $(uname -m)"; return 1; }
  local platform="$BOOTSTRAP_MONGO_PLATFORM"
  # 5.0/6.0 只用于导入老备份，官方只有 ubuntu2004/ubuntu2204 等构建，沿用同一个 platform
  local name="mongodb-linux-$arch-$platform-$ver"
  local url="$MONGO_DIST_BASE/$name.tgz"
  local tarball="$ROOT/.tools/$name.tgz"
  echo "==> 安装 MongoDB $ver ($arch/$platform) 到 .tools/$dir"
  fetch "$url" "$tarball" || return 1

  local sidecar="$tarball.sha256" expected
  if fetch "$url.sha256" "$sidecar" quiet; then
    expected=$(awk '{print $1}' "$sidecar" | head -1)
    if [ -n "$expected" ]; then
      if check_sha256 "$tarball" "$expected"; then
        echo "    sha256 校验通过"
      else
        echo "!! sha256 校验失败，已删除下载文件"; rm -f "$tarball" "$sidecar"; return 1
      fi
    fi
  else
    echo "    (拿不到 .sha256，跳过校验)"
  fi

  local tmp="$ROOT/.tools/.bootstrap-mongo.$$"
  rm -rf "$tmp"; mkdir -p "$tmp"
  tar -xzf "$tarball" -C "$tmp" || { echo "!! 解压失败"; rm -rf "$tmp"; return 1; }
  [ -d "$tmp/$name" ] || { echo "!! 解压后没找到 $name 目录"; rm -rf "$tmp"; return 1; }
  rm -rf "$ROOT/.tools/$dir"
  mv "$tmp/$name" "$ROOT/.tools/$dir" && rm -rf "$tmp"
  drop_tarball "$tarball"; rm -f "$sidecar"

  if [ -x "$bin" ]; then
    echo "    已安装: $("$bin" --version 2>/dev/null | head -1)"
    local missing; missing=$(ldd "$bin" 2>/dev/null | grep "not found" || true)
    if [ -n "$missing" ]; then
      echo "    !! mongod 缺动态库（跑不起来）:"
      echo "$missing" | sed 's/^/       /'
      echo "       ubuntu2204 构建需要 libssl3/libcrypto3；老发行版可试 VANBLOG_MONGO_PLATFORM=ubuntu2004"
      return 1
    fi
  fi
}

# 建本地骨架：数据目录、前台静态软链、config.yaml、tsconfig.dev.json、.git/info/exclude
bootstrap_skeleton() {
  echo "==> 建本地目录骨架"
  mkdir -p "$LOG_DIR" "$PID_DIR" "$MONGO_DATA" "$DEV_DIR/static" "$DEV_DIR/codeRunner" \
    "$DEV_DIR/pluginRunner" "$ROOT/.tools/home" "$ROOT/.tools/pnpm-home" \
    "$ROOT/.tools/npm-cache" "$ROOT/.tools/pnpm-store"

  local link="$ROOT/packages/website/public/static"
  if [ -L "$link" ] || [ -e "$link" ]; then
    echo "    packages/website/public/static 已存在，跳过"
  else
    mkdir -p "$(dirname "$link")"
    ln -sfn ../../../vanblog_dev/static "$link" \
      && echo "    软链 packages/website/public/static -> ../../../vanblog_dev/static（让前台 dev 能出图）"
  fi

  # 下面两个文件属于 packages/server，只有在仓库根目录下跑 bootstrap 才有意义
  if [ ! -d "$ROOT/packages/server" ]; then
    echo "    (没找到 packages/server，跳过 config.yaml / tsconfig.dev.json；请在仓库根目录下运行)"
    return 0
  fi

  local cfg="$ROOT/packages/server/config.yaml"
  if [ -f "$cfg" ]; then
    echo "    packages/server/config.yaml 已存在，跳过"
  else
    {
      echo "# 由 dev-env.sh bootstrap 生成（仓库 .gitignore 已忽略此文件）"
      echo "# 路径必须是绝对路径：server 进程的 cwd 是 packages/server"
      echo "database:"
      echo "  url: mongodb://localhost:27017/vanBlog?authSource=admin"
      echo "static:"
      echo "  path: $DEV_DIR/static"
      echo "demo: 'false'"
      echo "waline:"
      echo "  db: waline"
      echo "log: $LOG_DIR"
      echo "codeRunner:"
      echo "  path: $DEV_DIR/codeRunner"
      echo "pluginRunner:"
      echo "  path: $DEV_DIR/pluginRunner"
    } > "$cfg" && echo "    已生成 packages/server/config.yaml" \
      || echo "    !! 写入 packages/server/config.yaml 失败（磁盘/权限？）"
  fi

  # 限制 typeRoots，避免 TS 4.9 去解析家目录 node_modules/@types 里的新语法包（详见 AGENTS.md §3.6）
  local tsc="$ROOT/packages/server/tsconfig.dev.json"
  if [ -f "$tsc" ]; then
    echo "    packages/server/tsconfig.dev.json 已存在，跳过"
  else
    {
      echo "{"
      echo '  "extends": "./tsconfig.build.json",'
      echo '  "compilerOptions": {'
      echo '    "typeRoots": ["./node_modules/@types", "../../node_modules/@types"],'
      echo '    "tsBuildInfoFile": "./dist/.tsbuildinfo-dev"'
      echo "  }"
      echo "}"
    } > "$tsc" && echo "    已生成 packages/server/tsconfig.dev.json" \
      || echo "    !! 写入 packages/server/tsconfig.dev.json 失败（磁盘/权限？）"
  fi

  # 本地文件不要污染 git status：写进 .git/info/exclude（不动仓库的 .gitignore）
  local exclude="$ROOT/.git/info/exclude"
  if [ -f "$exclude" ]; then
    local entry added=0
    for entry in ".tools/" "vanblog_dev/" ".xdg-data/" ".pnpm-home/" \
      "packages/server/tsconfig.dev.json" "packages/website/public/static" "AGENTS.local.md"; do
      if ! grep -qxF "$entry" "$exclude"; then
        echo "$entry" >> "$exclude"; added=1
      fi
    done
    [ "$added" -eq 1 ] && echo "    已补全 .git/info/exclude（本地文件不进 git status）"
  fi
}

do_bootstrap() {
  local with_legacy=0 arg
  for arg in "$@"; do
    case "$arg" in
      --with-legacy-mongo) with_legacy=1 ;;
      -h | --help)
        sed -n '/^# bootstrap:/,/^# ---.*$/p' "$0" | sed 's/^# \{0,1\}//'
        return 0 ;;
      *) echo "未知参数: $arg（可用: --with-legacy-mongo）"; return 1 ;;
    esac
  done

  local missing=0 tool
  for tool in curl tar sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || { echo "!! 缺少命令: $tool"; missing=1; }
  done
  command -v xz >/dev/null 2>&1 || { echo "!! 缺少命令: xz（解压 Node tarball 需要）"; missing=1; }
  [ "$missing" -eq 0 ] || return 1

  mkdir -p "$ROOT/.tools"
  local failed=0
  install_node || failed=1
  if [ "$failed" -eq 0 ]; then
    install_pnpm || failed=1
  fi
  install_mongo "$BOOTSTRAP_MONGO_VERSION" mongodb || failed=1
  if [ "$with_legacy" -eq 1 ]; then
    echo "==> 额外安装老版本 mongod（导入 FCV 4.4 备份时用，见 AGENTS.md §4.2）"
    install_mongo "$BOOTSTRAP_MONGO50_VERSION" mongodb50 || failed=1
    install_mongo "$BOOTSTRAP_MONGO60_VERSION" mongodb60 || failed=1
  fi
  bootstrap_skeleton

  echo
  if [ "$failed" -ne 0 ]; then
    echo "!! bootstrap 有失败项，请按上面的提示处理后重跑（可重复执行，已装好的会跳过）"
    return 1
  fi
  echo "==> bootstrap 完成。下一步:"
  echo "    ./dev-env.sh install    # 安装依赖（约 6 分钟，其中 sqlite3 源码编译约 5 分钟）"
  echo "    ./dev-env.sh start      # 启动 MongoDB + server + admin + website"
  echo "    ./dev-env.sh status     # 查看状态"
}

case "${1:-start}" in
  bootstrap) shift; do_bootstrap "$@" ;;
  install) do_install ;;
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; sleep 1; do_start ;;
  status) do_status ;;
  logs) shift; do_logs "${1:-server}" ;;
  db)   # 巡检数据库（版本/FCV/各集合条数/站点信息）。脚本是本机文件，不入库。
        if [ -f "$DEV_DIR/db-inspect.cjs" ]; then
          need_toolchain mongo; "$NODE" "$DEV_DIR/db-inspect.cjs" "${2:-}"
        else
          echo "!! 缺少 vanblog_dev/db-inspect.cjs（该脚本不在仓库里）"
          echo "   可以直接用 mongod 自带的工具查，或自己写一个：连接 mongodb://127.0.0.1:$MONGO_PORT/vanBlog"
          echo "   列出各集合条数、db.adminCommand({getParameter:1,featureCompatibilityVersion:1}) 等。"
          exit 1
        fi ;;
  *) echo "用法: $0 {bootstrap [--with-legacy-mongo]|install|start|stop|restart|status|logs [server|website|admin|mongod]|db}"; exit 1 ;;
esac
