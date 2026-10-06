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

# 🔴 期 12 第一批：离线/受限网络下能用**本地已缓存**的基础镜像构建（PULL_POLICY）
#    起因：本机 buildah 1.33 的默认策略实测是"每次都去 ping 仓库"⇒ 连不上 docker.io 时，
#    即使 `podman images` 里已经有 node:24-alpine，构建也在 STEP 1 就失败，
#    而报错只说 "pinging container registry"（完全没提"本地其实有镜像"）⇒ 极易误判成 Dockerfile 的问题。
has "--help 里说明了 PULL_POLICY" 'PULL_POLICY'
has "PULL_POLICY 真的被传给 buildah（否则是个摆设）" '--pull="${PULL_POLICY}"'
has "非法的 PULL_POLICY 立刻退出（拼错却'以为生效了'比报错更糟）" '无效的 PULL_POLICY'
has "docker 下忽略 PULL_POLICY 时要**说出来**（不静默忽略）" '已忽略：docker'

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
# 🔴 2026-09-21 修正：这条断言原先钉的是字面量 `SMOKE_HTTP_PORT:-18080`，
#    而它的**标题**写的是"默认端口避开 80/443（不撞正在跑的站点）"—— **两者相反**：
#    18080 恰恰就是站长那套栈在用的宿主机端口，而脚本 :241 会 `-p "${SMOKE_HTTP_PORT}:80"` 真的去 bind 它。
#    也就是说这条守卫**把与脚本注释同一个错误信念固化成了"不许改"**（与 `perfBudget.spec.ts` 曾把 next
#    钉在 14.x 是同一族：守卫的意图对、断言错）。
#    ⇒ 按**意图**修：断言默认端口既不是特权端口，也不是本机在用的那几个。
has "默认冒烟端口不是特权端口（80/443）" "SMOKE_HTTP_PORT:-18074"
# 🔴 EXIT trap 必须对"冒烟变量还没赋值就退出"安全（--build-only 就是这条路径）：
#    否则 set -u 下会报 unbound variable 并在 `rm -rf "${SMOKE_DATA}"` 之前中断 ⇒ 静默泄漏 mktemp 目录。
has "cleanup 用 \${MONGO_NAME:-} 取值（trap 早于赋值触发时不炸）" 'MONGO_NAME:-'
has "cleanup 用 \${SMOKE_DATA:-} 取值" 'SMOKE_DATA:-'
has "cleanup 用 \${SMOKE_KEEP:-0} 取值" 'SMOKE_KEEP:-0'
# 并且断言"清临时目录"那一行**在 cleanup 的最后**（前面任何一行中断都不该挡住它）
if awk '/^cleanup\(\) \{/,/^\}/' "$SCRIPT" | grep -nE 'rm -rf "\$\{SMOKE_DATA' | tail -1 | grep -q .; then
  _last=$(awk '/^cleanup\(\) \{/,/^\}/' "$SCRIPT" | grep -nvE '^\s*(#|$)' | grep -E 'rm -rf "\$\{SMOKE_DATA' | tail -1 | cut -d: -f1)
  _tot=$(awk '/^cleanup\(\) \{/,/^\}/' "$SCRIPT" | grep -cvE '^\s*(#|$)')
  if [ -n "${_last:-}" ] && [ "${_last}" -le "$((_tot - 1))" ]; then
    pass "清理 mktemp 目录那一行在 cleanup 的末尾附近（不会被前面的调用挡住）"
  else
    fail "清理 mktemp 目录那一行的位置可疑（_last=${_last:-?} / _tot=${_tot:-?}），请人工确认它不会被前面的语句中断"
  fi
else
  fail "cleanup 里找不到 rm -rf \${SMOKE_DATA…}（临时目录不会被清理）"
fi
# 并且断言默认值**不在**"本机在用/不许碰"的端口集合里（这才是标题一直想说的那件事）
if grep -qE '^SMOKE_HTTP_PORT="\$\{SMOKE_HTTP_PORT:-(80|443|3000|3001|3002|8360|18080|18097|18107|27017)\}"' "$SCRIPT"; then
  fail "默认冒烟端口撞上了本机在用/不许碰的端口（80/443/3000-3002/8360/18080/18097/18107/27017）"
else
  pass "默认冒烟端口避开了本机在用与不许碰的端口（含 18080 = 站长的站点）"
fi
has "容器名带 PID（并发跑两次不会互相拆）" 'vanblog-smoke-$$'
has "可以保留容器排查" "SMOKE_KEEP"
# 被 SIGTERM 打断的 podman build 会退出 0（实测），只信退出码就会宣布"构建成功"
has "构建后确认镜像真的存在（podman build 被打断时也会返回 0）" 'image_exists "${ENGINE}" "${IMAGE_TAG}"'

# 🔴 期 12 第三批：那个存在性检查必须**按引擎**用各自的命令。
#    `podman image exists` 是 podman 独有的 —— `docker image` 下面**没有 exists**
#    （实测 `docker image --help` 只有 build/history/import/inspect/load/ls/prune/pull/push/rm/save/tag）
#    ⇒ 原来那句 `"${ENGINE}" image exists "${IMAGE_TAG}"` 在 docker 上**永远失败**，
#    于是"构建成功"被误报成"镜像不存在（多半是构建被打断了）"。
#    🔴 这就是 nightly 的 image-build 从 2026-09-23 起**连续 13 次失败**的真因（runner 用 docker）：
#    注解里 `#136 writing image sha256:… done` 之后紧跟那句误报 ⇒ 镜像其实建出来了。
#    ⚠️ 本机只用 podman 跑，所以这条**在本机永远撞不到** ⇒ 只能用"假引擎"把它测出来（下面就是这么做的）。
echo "-- image_exists：双引擎行为（用假引擎跑真函数）--"
FAKE_BIN="$(mktemp -d)"
cat > "${FAKE_BIN}/podman" <<'FK'
#!/usr/bin/env bash
# 假 podman：支持 `image exists`（tag=good 时存在）；也支持 `image inspect` 以便对照
[[ "$1" == "image" ]] || exit 64
case "$2" in
  exists)  [[ "$3" == "good" ]] && exit 0 || exit 1 ;;
  inspect) [[ "$3" == "good" ]] && exit 0 || exit 1 ;;
  *) exit 64 ;;
esac
FK
cat > "${FAKE_BIN}/docker" <<'FK'
#!/usr/bin/env bash
# 假 docker：**照真 docker 的行为**——没有 `image exists` 这个子命令
[[ "$1" == "image" ]] || exit 64
case "$2" in
  inspect) [[ "$3" == "good" ]] && exit 0 || exit 1 ;;
  exists)  echo "docker: 'exists' is not a docker command." >&2; exit 1 ;;
  *) exit 64 ;;
esac
FK
chmod +x "${FAKE_BIN}/podman" "${FAKE_BIN}/docker"
# 反证：假引擎必须**忠实**（假 docker 真的要拒绝 `image exists`），否则下面的绿是假的
if PATH="${FAKE_BIN}:${PATH}" docker image exists good >/dev/null 2>&1; then
  fail "假 docker 居然接受了 image exists ⇒ 它不忠实，下面几条断言都是空的绿"
else
  pass "反证：假 docker 拒绝 image exists（与真 docker 一致）⇒ 下面的断言有区分力"
fi
# 把真函数抽出来跑（不 source 整个脚本：它会执行主流程）
eval "$(sed -n '/^image_exists()/,/^}$/p' "${SCRIPT}")"
if declare -F image_exists >/dev/null 2>&1; then
  pass "能从脚本里抽出 image_exists 这个函数（它是可测的，不是内联在构建流程里）"
else
  fail "抽不出 image_exists 函数 ⇒ 这段逻辑没法单测（这正是它当初在 docker 上坏了 13 天没人知道的原因）"
fi
PATH="${FAKE_BIN}:${PATH}" image_exists podman good && pass "podman + 镜像存在 → rc 0" || fail "podman + 镜像存在 应该是 rc 0"
PATH="${FAKE_BIN}:${PATH}" image_exists podman nope; [[ $? -ne 0 ]] && pass "podman + 镜像不存在 → 非 0" || fail "podman + 镜像不存在 应该非 0"
PATH="${FAKE_BIN}:${PATH}" image_exists docker good && pass "🔴 docker + 镜像存在 → rc 0（原来这里必红：docker 没有 image exists）" || fail "🔴 docker + 镜像存在 应该是 rc 0（用 docker image inspect 查）"
PATH="${FAKE_BIN}:${PATH}" image_exists docker nope; [[ $? -ne 0 ]] && pass "docker + 镜像不存在 → 非 0（不能因为换了命令就把"没有"也判成"有"）" || fail "docker + 镜像不存在 应该非 0"
PATH="${FAKE_BIN}:${PATH}" image_exists nosuchengine good; [[ $? -eq 2 ]] && pass "引擎不存在 → rc 2（查不了 ≠ 不存在，两种都要与"有"区分开）" || fail "引擎不存在 应该 rc 2"
PATH="${FAKE_BIN}:${PATH}" image_exists podman ""; [[ $? -eq 2 ]] && pass "tag 为空 → rc 2（不许把空 tag 判成"存在"）" || fail "tag 为空 应该 rc 2"
rm -rf "${FAKE_BIN}"
# 🔴 源码级：不许再有"不分引擎就调 image exists"的形状（那正是坏掉的那一句）
# 🔴 这里**刻意不加**"源码里不许出现 image exists"那种形状判据：
#    `image exists` 在 `image_exists()` 的 **podman 分支里是正确写法**，形状判据分不清
#    "在 podman 分支里"与"不分引擎直接调"⇒ 第一版我就写了这么一条，结果它在**没被变异的正确代码上就红**
#    （把 `${eng}` 也算进来了），放宽成只认 `${ENGINE}` 又漏掉了"函数体里退回坏形状"的变异。
#    👉 结论：**这种"要看上下文才知道对错"的性质，交给上面那组假引擎行为断言**（它们直接跑真函数），
#    不要用源码正则去近似 —— 近似出来的判据要么假红、要么漏红，两边都坏。
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
