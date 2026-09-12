#!/usr/bin/env bash
# VanBlog 本地开发环境脚本（工作区自包含，不依赖 docker / sudo / 全局 node）
#
# 用法:
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
    bash -c "cd '$ROOT/packages/server' && exec env VANBLOG_DISABLE_WEBSITE=true ./node_modules/.bin/nest start --watch -p tsconfig.dev.json"
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

case "${1:-start}" in
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
  *) echo "用法: $0 {install|start|stop|restart|status|logs [server|website|admin|mongod]|db}"; exit 1 ;;
esac
