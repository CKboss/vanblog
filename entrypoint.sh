#!/bin/sh
# 容器入口。
#
# ⚠️ 这里刻意**不用** `set -e`：caddy 起不来时我们要「降级继续」，
# 而不是让整个容器退出（restart: always 会变成崩溃循环，用户只看到容器反复重启）。
echo "============================================="
echo "欢迎使用 VanBlog 博客系统"
echo "Github: https://github.com/CKboss/vanblog （本镜像由该仓库的 dev/dsh 分支构建）"
echo "上游项目: https://github.com/mereithhh/van-blog"
echo "Version(Env): ${VAN_BLOG_VERSION}"
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
  *@*.*) ;;
  *)
    echo "!! EMAIL='${EMAIL_SAFE}' 不像邮箱地址，已忽略（ACME 不带联系邮箱仍然可以签发证书）"
    EMAIL_SAFE=""
    ;;
esac
if [ -z "${EMAIL_SAFE}" ]; then
  echo "> 未配置有效的 EMAIL，证书申请将不带联系邮箱（不影响签发，只是收不到到期提醒）"
fi
# 用 | 当分隔符：邮箱里不会有 |，但如果地址里有 / 或 & 用 s/// 会直接把配置写坏
sed "s|VAN_BLOG_EMAIL|${EMAIL_SAFE}|g" /app/caddyTemplate.json >/app/caddy.json

# ── 2) 先 validate 再 start，失败就降级到「无 TLS 自动化」的配置 ──
# 真实事故：模板里 tls.issuance.zerossl 带了 email 字段，而较新的 Caddy 已经去掉这个字段，
# 于是 `loading initial config` 失败、caddy 进程退出，容器却还在"运行"，
# 80/443 全都没有监听 —— docker ps 看着一切正常，用户只知道"打不开页面"。
# 镜像里的 caddy 是 `apk add` 装的最新版，这类漂移随时可能再来一次，所以必须有兜底。
CADDY_OK=0
if caddy validate --config /app/caddy.json --adapter json >/dev/null 2>&1; then
  if caddy start --config /app/caddy.json; then
    CADDY_OK=1
  fi
else
  echo "!! caddy 主配置校验失败："
  caddy validate --config /app/caddy.json --adapter json 2>&1 | tail -5
fi

if [ "${CADDY_OK}" != "1" ]; then
  echo "!! caddy 主配置起不来，降级使用「无 TLS 自动化」的配置（HTTP 仍可用，HTTPS 会是自签证书）"
  echo "!! 请把上面的错误连同 Caddy 版本一起反馈：https://github.com/CKboss/vanblog/issues"
  caddy version 2>/dev/null
  if [ -f /app/caddyFallbackTemplate.json ]; then
    sed "s|VAN_BLOG_EMAIL|${EMAIL_SAFE}|g" /app/caddyFallbackTemplate.json >/app/caddy-fallback.json
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

# ── 3) exec：让 node 成为 PID 1，直接收到 docker stop 的 SIGTERM ──
# 以前是 `node start.js`（不 exec），PID 1 是 sh，SIGTERM 只发给 sh，
# node 收不到 → docker stop 等满 10 秒宽限期后 SIGKILL，
# 正在写的备份/导出/上传会被硬生生截断。
exec node start.js
