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
has "mongo 版本跟着脚本的 pick_mongo_image 走（和真实安装一致）" "pick_mongo_image"

# 不该有的东西
hasnt "没有硬编码内网地址或私人镜像站" "10.1.1.111"
hasnt "没有把 docker.io 镜像加速写死（各机器网络不同，走环境变量/引擎配置）" "daocloud"

echo
echo "passed=${PASS} failed=${FAIL}"
if [[ "${FAIL}" -ne 0 ]]; then
  exit 1
fi
exit 0
