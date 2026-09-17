#!/usr/bin/env bash
# scripts/build-image-local.sh 的静态契约测试。
#
# 这个脚本本身要跑真构建（15-40 分钟 + 需要容器引擎），没法在测试里执行，
# 所以这里钉住的是"它必须做的事"：构建参数与 CI 一致、冒烟测试覆盖历史上真炸过的那些特征、
# 临时容器一定会被拆掉、端口不与正在跑的站点冲突。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/build-image-local.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $*"; PASS=$((PASS + 1)); }
has() { if grep -qF -- "$2" "${SCRIPT}"; then pass "$1"; else fail "$1（缺少：$2）"; fi; }
hasnt() { if grep -qF -- "$2" "${SCRIPT}"; then fail "$1（不该有：$2）"; else pass "$1"; fi; }

echo "== build-image-local.sh 契约 =="

if [[ ! -x "${SCRIPT}" ]]; then
  fail "scripts/build-image-local.sh 不存在或不可执行"
else
  pass "脚本存在且可执行"
fi
if bash -n "${SCRIPT}" 2>/dev/null; then
  pass "bash -n 语法正确"
else
  fail "bash -n 语法错误"
fi

# 构建参数必须和 CI / vanblog.sh 一致，否则"本地测过了"是假的
has "传版本号 build-arg" 'VAN_BLOG_VERSIONS='
has "传 server 地址 build-arg（空值会让 next build 挂）" 'VAN_BLOG_BUILD_SERVER=http://127.0.0.1:3000'
has "传 pnpm 源 build-arg" 'VAN_BLOG_NPM_REGISTRY='
has "传 admin 构建档位 build-arg" 'VAN_BLOG_ADMIN_BUILD_SCRIPT='
has "传 Alpine 源 build-arg（国内直连 dl-cdn 会卡在 apk add）" 'VAN_BLOG_ALPINE_MIRROR='
has "Alpine 源可以用 ALPINE_MIRROR=none 关掉" 'ALPINE_MIRROR-https://mirrors.aliyun.com/alpine'
has "传 node-gyp 头文件源 build-arg（musl 默认的 unofficial-builds 国内连不上）" 'VAN_BLOG_NODE_DIST_URL='
has "头文件源默认走 npmmirror 的 CDN" 'cdn.npmmirror.com/binaries/node'
has "支持只构建单个 stage（迭代时快得多）" '--target'

# 引擎：docker 组常常是空的，podman rootless 是免 sudo 的那条路
has "自动探测引擎" 'pick_engine'
has "支持 podman（rootless，不需要 docker 组）" 'podman'
has "探测 docker daemon 是否真的可用，而不是只看有没有命令" 'docker info'

# 冒烟测试要覆盖历史上真炸过的故障特征
for pat in "Cannot find module" "caddy process exited" "Reached heap limit" "ERR_INVALID_URL" "Failed to collect page data"; do
  has "冒烟测试会扫「${pat}」" "${pat}"
done
has "冒烟测试检查 caddy 降级（说明主配置没加载成功）" "降级使用"
has "冒烟测试打关键路径" "/api/public/meta"
has "冒烟测试打后台页面" "/admin"
has "冒烟测试打 robots.txt" "/robots.txt"
has "冒烟测试打 sitemap" "/sitemap.xml"
has "冒烟测试验证优雅停机耗时（信号转发是否生效）" "stop_cost"
has "冒烟测试看重启次数（有进程在崩就会发现）" "RestartCount"
has "冒烟测试读 healthcheck 状态" ".State.Health"

# 临时资源必须清理，且不能撞上正在跑的站点
has "trap 里清理容器与临时目录" "trap cleanup EXIT"
has "默认端口避开 80/443（不撞正在跑的站点）" "SMOKE_HTTP_PORT:-18080"
has "容器名带 PID（并发跑两次不会互相拆）" 'vanblog-smoke-$$'
has "可以保留容器排查" "SMOKE_KEEP"
# 被 SIGTERM 打断的 podman build 会退出 0（实测），只信退出码就会宣布"构建成功"
has "构建后确认镜像真的存在（podman build 被打断时也会返回 0）" 'image exists "${IMAGE_TAG}"'
has "mongo 版本跟着脚本的 pick_mongo_image 走（和真实安装一致）" "pick_mongo_image"

# 不该有的东西
# 内网地址一律不许出现（用正则匹配整个 RFC1918 段，而不是把某个具体地址写进测试里 ——
# 写具体地址等于把这个地址本身也提交进公开仓库）
if grep -qE '\b(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})\b' "${SCRIPT}"; then
  fail "脚本里出现了 RFC1918 内网地址（不该把私人网络写进公开仓库）"
else
  pass "没有硬编码内网地址或私人镜像站"
fi
hasnt "没有把 docker.io 镜像加速写死（各机器网络不同，走环境变量/引擎配置）" "daocloud"

# ── 冒烟测试怎么把 mongo 告诉 vanblog 容器（2026-09-17 实测炸过）─────────────
# `podman run --link` 是 docker 的旧式互联，**podman 4.9 直接 `Error: unknown flag: --link`** ⇒
# 在只有 podman 的机器上"构建成功、冒烟立刻 die"，一条镜像问题都测不到（本机就是这样发现的：
# 镜像 892 MB 建好了，冒烟第一步就退出）。容器名 DNS 也不能指望 —— rootless podman
# 常常没装 aardvark-dns（本机就没有）。现在走 vanblog-drill.sh 那条本机验证过的路：
# 专用网络 + 取 mongo 的容器 IP + --add-host 把名字写进 /etc/hosts。
# ⚠️ 负向断言必须打在**剥掉注释之后**的代码上：脚本里解释这个坑的注释本身就写着 `--link`，
#    grep 整个文件会匹配到那段注释 ⇒ 与本仓库反复踩过的"守卫匹配到解释性注释"同一个坑。
SMOKE_CODE="$(grep -vE '^[[:space:]]*#' "${SCRIPT}")"
if printf '%s\n' "${SMOKE_CODE}" | grep -qE '(^|[[:space:]])--link([[:space:]"=]|$)'; then
  fail "冒烟测试仍在用 --link（podman 不认这个 flag，冒烟一步都跑不了）"
else
  pass "冒烟测试没有用 docker 专有的 --link"
fi
has "冒烟测试建了专用网络（两个引擎都支持）" 'network create "${SMOKE_NET}"'
has "冒烟测试把 mongo 的容器 IP 写进 /etc/hosts" '--add-host "${MONGO_NAME}:${MONGO_IP}"'
has "取容器 IP 用两个引擎都认的 inspect 模板" '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
has "拿不到 IP 会重试一会儿再明确失败（网络插件给地址有延迟）" '30 秒都拿不到 mongo 的容器 IP'
has "拆容器的时候也拆网络（不留垃圾网络）" 'network rm "${SMOKE_NET}"'
# mongo 的数据用**命名卷**而不是宿主机 bind mount：mongod 在容器里是 root，rootless 引擎把它
# 映射成宿主机上一个谁也不是的 uid（本机实测 100998），`journal/` 与 `diagnostic.data/`
# 于是**非 root 删不掉** —— 每跑一次冒烟就在 /tmp 留一坨要 sudo 才能清的垃圾。
has "mongo 数据挂命名卷（引擎自己回收）" '-v "${SMOKE_MONGO_VOL}:/data/db"'
hasnt "mongo 数据不再 bind mount 到宿主机临时目录（会留下删不掉的 root 映射文件）" '${SMOKE_DATA}/mongo:/data/db'
has "拆的时候连命名卷一起拆" 'volume rm "${SMOKE_MONGO_VOL}"'

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
