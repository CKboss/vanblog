#!/bin/sh
# 容器入口。
#
# ⚠️ 这里刻意**不用** `set -e`：caddy 起不来时我们要「降级继续」，
# 而不是让整个容器退出（restart: always 会变成崩溃循环，用户只看到容器反复重启）。
echo "============================================="
echo "欢迎使用 VanBlog 博客系统"
# ⚠️ 这里**不要**写"由某某分支构建"：发布镜像是按 **tag**（如 v2026.9.2）构建的，
#    源码构建才是 dev/dsh@<短sha>，写死分支名对发布版就是错的。版本一律看下面那行 Version(Env)。
echo "Github: https://github.com/CKboss/vanblog （文档与问题反馈都在这个仓库）"
# 署名保留：本版本基于原作者的项目修改，遵循 GPL-3.0。仓库名是 vanblog（旧名 van-blog 只 301 过来）。
echo "原始项目: https://github.com/Mereithhh/vanblog"
# 变量没设时别打印一个空的 "Version(Env):"（看着像 bug）；兜底文案在 busybox sh 里实测有效。
echo "Version(Env): ${VAN_BLOG_VERSION:-(未设置)}"
echo "============================================="

# ── 1) 邮箱：占位符没被替换 / 为空 / 不像邮箱时，不要把它塞进 ACME 配置 ──
# 编排模板里是 `EMAIL: vanblog_email` 占位，由 vanblog.sh 的 config 流程替换。
# 用户手改 compose 漏掉这一步时，caddy 会拿着 "vanblog_email" 这种非法地址去注册 ACME 账号，
# 结果是 HTTPS 一直签不出证书，而日志里只有一条不起眼的错误。
# 留空是安全的：Caddy 的 acme issuer 允许没有联系邮箱。
EMAIL_SAFE="${EMAIL:-}"
case "${EMAIL_SAFE}" in
  "" | vanblog_email)
    EMAIL_SAFE=""
    ;;
  # ⚠️ 字符集白名单，而不是只判"像不像邮箱"。原来的判据是 `*@*.*)`，于是 `a|b@c.com` 也算通过，
  #    而这个值随后会进 sed 表达式（见下面第 3 步的降级分支）——`|` 正是那里的分隔符，
  #    一个 `|` 就能把 `s|VAN_BLOG_EMAIL|a|b@c.com|g` 变成畸形表达式，sed 报错、
  #    输出文件是空的，caddy 起不来 ⇒ 容器"在跑但 80/443 都没监听"（正是第 3 步要防的那个事故）。
  #    ACME 的联系邮箱只需要 ASCII 里那几个字符，白名单不会误伤真实地址；
  #    带 `"` `'` `\` `$` 反引号 空格 `;` `&` `<` `>` `(` `)` 的一律忽略（证书照样能签，只是没有到期提醒）。
  #    ⚠️ `-` 必须放在方括号最后才是字面量，别挪位置。
  *[!A-Za-z0-9._%+@-]*)
    echo "!! EMAIL='${EMAIL_SAFE}' 含非法字符，已忽略（ACME 不带联系邮箱仍然可以签发证书）"
    EMAIL_SAFE=""
    ;;
  *@*.*) ;;
  *)
    echo "!! EMAIL='${EMAIL_SAFE}' 不像邮箱地址，已忽略（ACME 不带联系邮箱仍然可以签发证书）"
    EMAIL_SAFE=""
    ;;
esac
if [ -z "${EMAIL_SAFE}" ]; then
  echo "> 未配置有效的 EMAIL，证书申请将不带联系邮箱（不影响签发，只是收不到到期提醒）"
fi
# ── 2) 生成配置：两种 on-demand TLS 写法都试，用 caddy 自己 validate 通过的那个 ──
# **Caddy 2.11 把 `on_demand.ask` 换成了 `on_demand.permission`**（module=http + endpoint），
# 用旧写法它会拒绝加载整份配置：
#   provisioning automation policy 0: on-demand TLS cannot be enabled without a permission module
# 镜像里的 caddy 是 `apk add` 装的，版本随基础镜像漂移（2.11.4 是实测到的），所以**不猜版本**：
# 由 /app/caddyConfig.js 分别生成 permission / ask 两种形式，谁 validate 过就用谁。
# 邮箱替换也在那个脚本里做（在解析后的对象上改，不是文本 sed）——
# 邮箱里出现 / & 引号 反斜杠都不会把 JSON 写坏。
# ⚠️ validate 不要加 `--adapter json`：这个 caddy 会报 `unrecognized config adapter: json`，
#    于是主配置永远"校验失败"、每次都降级成无 TLS（HTTPS 变自签证书）。.json 后缀它自己会认。
CADDY_OK=0
for MODE in permission ask; do
  # ⚠️ 这里**不要**再把 stderr 丢进 /dev/null：caddyConfig.js 会把"站长把值设错了"这类
  #    WARN 打到 stderr（例如 VANBLOG_HSTS_MAX_AGE 写了垃圾值回落默认、VANBLOG_CADDY_ACCESS_LOG
  #    拼错所以日志保持开启、上界被夹取、preload/includeSubDomains 被丢弃）。丢了就等于
  #    "配置静默不生效"—— 而那正是最难排的一类故障。stdout 才是生成的 JSON，两条流分开，
  #    所以去掉这个重定向不会污染 caddy.json，只会让 WARN 出现在 `podman logs` 里。
  if ! node /app/caddyConfig.js /app/caddyTemplate.json "${MODE}" "${EMAIL_SAFE}" >/app/caddy.json; then
    echo "!! 生成 caddy 配置失败（形式：${MODE}）"
    continue
  fi
  if ! caddy validate --config /app/caddy.json >/dev/null 2>&1; then
    echo "!! caddy 不接受 ${MODE} 形式的 on-demand 配置，换另一种试试："
    caddy validate --config /app/caddy.json 2>&1 | tail -3
    continue
  fi
  echo "> caddy 配置形式：${MODE}（$(caddy version 2>/dev/null | head -1)）"
  if caddy start --config /app/caddy.json; then
    CADDY_OK=1
  fi
  break
done

# ── 3) 主配置起不来就降级到「无 TLS 自动化」，绝不能让容器"在跑但没监听" ──
# 真实事故：模板里 tls.issuance.zerossl 带了 email 字段，而较新的 Caddy 已经去掉这个字段，
# 于是 caddy 退出、容器却还在"运行"，80/443 全都没有监听 —— docker ps 看着一切正常。

if [ "${CADDY_OK}" != "1" ]; then
  echo "!! caddy 主配置起不来，降级使用「无 TLS 自动化」的配置（HTTP 仍可用，HTTPS 会是自签证书）"
  echo "!! 请把上面的错误连同 Caddy 版本一起反馈：https://github.com/CKboss/vanblog/issues"
  caddy version 2>/dev/null
  if [ -f /app/caddyFallbackTemplate.json ]; then
    # ⚠️ 这里以前是：
    #     node /app/caddyConfig.js … || sed "s|VAN_BLOG_EMAIL|${EMAIL_SAFE}|g" …
    # 那个 sed 兜底有两个问题：① 它是**文本替换**，而主路径特意用 caddyConfig.js 在解析后的
    #    对象上改邮箱（上面第 2 步的注释就是这么写的），兜底却把文本替换又请回来了；
    #    ② `caddyFallbackTemplate.json` 里**根本没有 VAN_BLOG_EMAIL 这个占位符**（已核），
    #    所以这个 sed 唯一可能的效果就是"原样输出模板"—— 而一旦 EMAIL 里含 `|`，
    #    它连这件事都做不到：表达式畸形 ⇒ sed 非零退出 ⇒ 输出文件空 ⇒ caddy 起不来。
    # 现在改成 `cp`：既然模板里没有占位符，逐字复制就是正确结果，而且不再有注入面。
    # ⚠️ 如果哪天给降级模板加了 VAN_BLOG_EMAIL 占位符，**不要**把 sed 加回来 ——
    #    改成再调一次 caddyConfig.js（它接受模板路径参数），image-runtime.test.sh 里有一条
    #    断言钉着"降级模板不含占位符"，加了就会红，那时按断言的提示改。
    node /app/caddyConfig.js /app/caddyFallbackTemplate.json permission "${EMAIL_SAFE}" >/app/caddy-fallback.json ||
      cp /app/caddyFallbackTemplate.json /app/caddy-fallback.json
    if caddy start --config /app/caddy-fallback.json; then
      echo "> 已用降级配置启动 caddy：站点可通过 HTTP 访问，后台在 /admin"
      echo "> HTTPS 需要修好主配置后 ./vanblog.sh restart（或重置 https 设置）"
    else
      echo "!! 降级配置也起不来，容器内将没有 80/443 监听（server 仍会启动，可用 docker exec 排查）"
    fi
  else
    echo "!! 镜像里没有 /app/caddyFallbackTemplate.json，无法降级"
  fi
fi

# ── 4) exec：让 node 成为 PID 1，直接收到 docker stop 的 SIGTERM ──
# 以前是 `node start.js`（不 exec），PID 1 是 sh，SIGTERM 只发给 sh，
# node 收不到 → docker stop 等满 10 秒宽限期后 SIGKILL，
# 正在写的备份/导出/上传会被硬生生截断。
exec node start.js
