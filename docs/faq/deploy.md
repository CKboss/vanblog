---
title: 部署常见问题
icon: rocket
order: 1
---

## 域名变更后文章图片打不开

换域名后，文章里指向旧域名的绝对图片地址不会自动更新（[#475](https://github.com/Mereithhh/vanblog/issues/475)）。请到后台 **站点管理 / 系统设置 / 图床设置** 用「域名变更后改写文章图片链接」把旧站点/图床地址改成新地址，并在 **站点配置** 更新「网站 Url」。操作说明见 [使用常见问题](./usage.md#域名变更后文章里的图片打不开)。

`VAN_BLOG_CDN_URL` 不会改写文章图片，见下一节。

## 如何部署到 CDN

`VAN_BLOG_CDN_URL` 只给前台 Next.js 的公共资源加前缀（页面里的 `/_next/static` JS/CSS），**不会**改写文章里的图片或本地图床 `/static` 路径。

在编排文件 `docker-compose.yaml` 中设置 `vanblog` 容器的环境变量后重启容器即可，例如：

```yaml
environment:
  VAN_BLOG_CDN_URL: "https://cdn.example.com"
```

然后按部就班增加 CDN：回源到博客主站，缓存 `/_next/static`。

![image](https://user-images.githubusercontent.com/95157017/204312649-8d02dfd6-bb2a-4646-921c-d59f07221854.png)

原则上 CDN 只缓存 `/_next/static` 这个目录就够了。设置后需要重启 VanBlog 容器，HTML 里的脚本/样式会变成 `https://cdn.example.com/_next/static/...`。

## 如何让 VanBlog 只接受本机反代的流量

同机 Nginx / Caddy 反代时，可以让 VanBlog 只在回环上听，外网直接打到映射端口会被拒绝（[#488](https://github.com/Mereithhh/vanblog/issues/488)）。

**Nest API（容器/进程内的 3000）**：编排里加环境变量后重启：

```yaml
environment:
  VAN_BLOG_SERVER_HOST: "127.0.0.1"
```

未设置时与升级前一样监听所有网卡，现有 Docker 用户不用改。

**宿主机映射的 80 / 443**：把编排的端口改成只绑本机，例如 `- "127.0.0.1:80:80"`，再让本机反代 `proxy_pass` / `reverse_proxy` 到 `127.0.0.1:<端口>`。只改 `VAN_BLOG_SERVER_HOST` 不会收紧宿主机上的 `80:80`。

Caddy 示例（与 [反代](../reference/reverse-proxy.md) 一致）：

```conf
example.com {
  tls admin@example.com
  reverse_proxy 127.0.0.1:<你映射的端口号> {
    trusted_proxies private_ranges
  }
}
```

Nginx 最小片段（必须转发 `Host`）：

```nginx
location / {
  proxy_pass http://127.0.0.1:<PORT>;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_no_cache 1;
  proxy_cache_bypass 1;
}
```

完整 Http / Https 配置见 [反代](../reference/reverse-proxy.md#仅接受来自本机反代的流量)。只用内置 Caddy、不再套一层时，一般不必绑 `127.0.0.1`。

## 反代后 Waline 登录跳到 localhost

在外层 Nginx 反代后面登录评论（GitHub 等 OAuth）或打开 Waline 管理后台时，浏览器可能跳到 `localhost` 或 `0.0.0.0`，而不是站点域名（[#396](https://github.com/Mereithhh/vanblog/issues/396)）。

这是因为反代没有把真实 `Host` 传给 VanBlog。内嵌 Waline 会用 upstream 地址（容器映射的 `127.0.0.1` / `0.0.0.0`）去拼 OAuth 回调 URL。

在 Nginx 的 `location` 里加上：

```nginx
proxy_set_header Host $host;
```

并建议同时转发 `X-Forwarded-Proto` 和 `X-Forwarded-For`。完整 Http / Https 示例见 [反代](../reference/reverse-proxy.md)。

只用 VanBlog 内置 Caddy、没有再套一层反代时，一般不需要改这个。

## Cloudflare 缓存了后台或后台 API

Cloudflare（或同类 CDN）如果用「缓存全部」覆盖 `/*`，即使另有 `/admin*` 绕过规则，**`/api/admin/*` 也不会被那条规则匹配**，登录和后台 JSON 仍可能被边缘缓存（[#140](https://github.com/Mereithhh/vanblog/issues/140)）。只改页面规则不够：旧版本源站没有 `Cache-Control`。

升级后 VanBlog 会对 `/admin` 和 `/api/admin/*` 返回：

- `Cache-Control: private, no-store, no-cache, must-revalidate`
- `CDN-Cache-Control: no-store`
- `Cloudflare-CDN-Cache-Control: no-store`

前台文章 HTML 和 `/_next/static` 不会被改成 no-store。仍建议在 Cloudflare 为 `/admin*` 与 `/api/admin*` 设置「绕过缓存」。改完后到 Cloudflare 清一下该路径的缓存。

若「缓存全部」也缓存了前台 HTML，后台发布后公网站点会一直显示旧文章，见下一节。

## 后台发布后前台不刷新仍显示旧文章

后台发布或更新文章后，公网首页 / 文章页不刷新、仍显示旧内容；整站迁移后也可能这样。先到 **站点管理 / 系统设置 / 高级设置** 手动触发一次静态页面更新，并确认**直连容器映射端口**能看到新内容。说明见 [静态页面更新策略](../advanced/isr.md)。

若只有走 Nginx / 宝塔反代（或 Cloudflare 等 CDN）时是旧页，就是外层在缓存 HTML（[#469](https://github.com/Mereithhh/vanblog/issues/469)）。社区方案来自 [RubyXun](https://github.com/RubyXun) / [lateautumn233](https://github.com/lateautumn233)，相关讨论见 [#332](https://github.com/Mereithhh/vanblog/issues/332)。

源站已对 `/admin` 和 `/api/admin/*` 发送 `private, no-store`（见上一节）。**前台 HTML 不会强制 no-store**，代理和 CDN 仍可能把整页存下来。

Nginx `location` 里加上：

```nginx
location / {
  proxy_pass http://127.0.0.1:<PORT>;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_no_cache 1;
  proxy_cache_bypass 1;
}
```

宝塔常在 `/www/server/nginx/conf/proxy.conf` 里写 `proxy_cache cache_one;`，对所有反代生效。可以在站点反代配置里加上面两行，和 / 或把 `proxy.conf` 里的 `proxy_cache cache_one;` 注释掉（`# proxy_cache cache_one;`），再重载 Nginx。

Cloudflare 等 CDN 不要对 HTML 开「缓存全部」；改完后清边缘缓存。完整说明见 [反代](../reference/reverse-proxy.md#后台发布后前台不刷新仍显示旧文章)，使用侧见 [使用常见问题](./usage.md#后台发布后前台不刷新仍显示旧文章)。

## 一键脚本下载编排文件失败

一键安装 / `config` 需要下载 `docker-compose-template.yml`。旧脚本只请求 `https://vanblog.mereith.com/docker-compose-template.yml`，部分网络（例如北美）即使能上网也连不上该主机，于是报「下载脚本失败」（[#115](https://github.com/Mereithhh/vanblog/issues/115)）。

请先更新到最新脚本（菜单 **20. 更新此脚本**，或重新下载）。新脚本会按顺序尝试：

1. `https://vanblog.mereith.com/docker-compose-template.yml`
1. 本分支 GitHub raw：`https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml`
1. 上游文档站与上游 GitHub raw / jsDelivr（兜底，拿到的是**上游模板**：镜像是官方版、mongo 是 4.4.16，
   没有本分支的日志上限、`depends_on`、mongo 版本占位符这些改动）
1. jsDelivr：`https://cdn.jsdelivr.net/gh/Mereithhh/vanblog@master/docker-compose/docker-compose-template.yml`

某一地址成功就会继续安装，并打印实际使用的 URL。全部失败才会报错退出。更新脚本自身也使用同一套回退。

若连文档站上的 `vanblog.sh` 都下不下来，可以用 GitHub raw：

```bash
curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh && ./vanblog.sh
```

这与 Docker Hub / 镜像仓库拉取失败不是同一类问题。

## 一键脚本部署后如何再部署其他项目

脚本装好的 VanBlog 是一组 Docker Compose 服务，不是可以把任意项目丢进去的应用平台。

- **静态 HTML/CSS/JS**：用后台 [自定义页面](../advanced/custom-page.md)，挂到 `/c/<名称>/`。入口必须是根目录 `index.html`；默认假设自己在网站根路径的 React/Vue 打包产物（如 uptime-status 的 `/static/js/...`）通常打不开，见 [自定义常见问题](./customize.md#自定义页面)。
- **需要后端、自己的路由、或必须占某个路径**：另起容器或进程，用 Nginx / Caddy **反代**到它（不同路径或子域名）。VanBlog 仍只反代自己映射的 HTTP 端口，见 [反代](../reference/reverse-proxy.md)。
- **长期共存**：给其他站点单独的子域名最省事，不必塞进 VanBlog 容器的 `/app/static`。

不要改 VanBlog 镜像内部去「顺便跑」别的项目。额外服务请写在你自己的编排文件里；脚本再次执行只管理 VanBlog。

## 如何安装 docker ?

可以用这个一键安装脚本:

```bash
curl -sSL https://get.daocloud.io/docker | sh
```

## 如何在外部访问数据库

默认的数据库是不会暴漏在外面的，只在容器内可访问，是相对安全的。

如果你看不懂下面的描述，我建议你先学一下相关的知识。如果不想学的话，建议还是放弃在外部访问数据库的打算，不然安全问题堪忧。

为了安全考虑默认的 docker-compose.yaml 编排中的 mongoDB 是仅容器内访问的（换句话说不会对外保留端口）。

如果你想连接的话，首先需要修改编排中 mongoDB 的账密（对外暴漏端口有安全风险，一定要设置强密码！）

![修改账号密码](https://www.mereith.com/static/img/06f19fe68043cd4e8780e1e2484b70d9.clipboard-2022-09-02.png)

注意画红圈的地方要同步改，然后加上下图画红线的语句：

![添加端口](https://www.mereith.com/static/img/e2bc119c1408d50f73a2da526dec96c8.clipboard-2022-09-02.png)

然后重启容器，就可以通过 27017 端口访问 mongoDB 了：

```bash
docker-compose down && docker-compose up -d
```

::: danger 千万不要顺手加 `-v`

`docker-compose down -v` 会**删除编排里的卷**。现在默认是 bind mount（数据在宿主机目录里）所以侥幸没事，
但只要有人把编排改成了命名卷，`-v` 就等于删库。重启请用不带 `-v` 的 `down`；
只有 `./vanblog.sh uninstall`（卸载）才应该用 `-v`，而且它会先让你确认。

:::

具体访问方式可以自行查阅资料，我一般都是用 [mongoDBCompass](https://www.mongodb.com/try/download/compass) 这个工具。

## 用的是 HTTP/1.1 还是 HTTP/2 / HTTP/3

容器里的 caddy 在 **HTTPS（:443）上默认就是 HTTP/1.1 + HTTP/2 + HTTP/3**（Caddy 2.6 起 QUIC 就是默认开的，
`caddyTemplate.json` 里把 `"protocols": ["h1","h2","h3"]` 显式写出来是为了钉住这个默认值）。
明文的 `:80` 只有 HTTP/1.1 —— caddy 自己的日志会写 `HTTP/2 skipped because it requires TLS`。caddy 到容器内 Node（server:3000 / website:3001）的上游仍是 HTTP/1.1 ——
Nest(Express) 与 Next standalone 默认都不支持 h2c，改成 h2 没有收益；上游连接开了连接池
（`keep_alive.max_idle_conns_per_host: 32`，Go 默认只有 2，并发一上来会不停开关连接）。

**HTTP/3 要真的能用，还得满足两个条件**（caddy 里开着只是第一步）：

1. 编排文件里映射了 **UDP** 443 —— QUIC 跑在 UDP 上，端口没发布的话，浏览器收到 `Alt-Svc`
   也连不上，只能永远用 HTTP/2。新装自带；**老安装需要跑一次
   `./vanblog.sh config` 重新生成编排文件**，然后 `./vanblog.sh restart`。
   `./vanblog.sh status` 会直接告诉你：

   ```text
   HTTPS 端口：443（TCP+UDP 都已映射，HTTP/3 可用；云主机还需在安全组放行 UDP 443）
   ```

2. 云主机的安全组 / 防火墙放行 **UDP 443**。没放行也**不会坏**：caddy 照样发 `Alt-Svc`，
   浏览器试连 QUIC 失败会自动退回 HTTP/2。

**怎么验证：**

```bash
# 看 HTTP 版本与 Alt-Svc（有 h3 就说明 QUIC 已启用）
curl -sI --http2 https://你的域名/ | grep -iE '^HTTP|^alt-svc'
#   HTTP/2 200
#   alt-svc: h3=":443"; ma=2592000
```

浏览器里按 F12 → Network → 右键表头勾选 **Protocol** 一列，刷新后能看到 `h2` 或 `h3`。
在线工具（如 HTTP/3 Test）也可以直接测。

::: tip 站点在别的反代后面时

如果你在 VanBlog 前面还套了 nginx / NPM / Cloudflare，那么访客用的是**外层反代**的协议：
外层没开 HTTP/2 就还是 1.1，QUIC 也过不去（nginx 不能反代 UDP）。这时要在外层开
`listen 443 ssl; http2 on;`，配置见[反向代理](../reference/reverse-proxy.md)。

:::

## 换机器 / 重装，最快的方式是什么

用**整站备份 + `reset`**，不要再去拷数据目录（那要求两边的 MongoDB 大版本一致，很容易翻车）：

```bash
# 旧机器：出一份整站备份（一致性快照，跨 MongoDB 版本可恢复）
./vanblog.sh backup
# 把 vanblog-full-*.tar.zst 拷到新机器（scp / U 盘都行）

# 新机器：装 + 恢复一步到位
VANBLOG_RESTORE_FROM=/path/to/vanblog-full-xxx.tar.zst ./vanblog.sh install
# 或者先装再重置
./vanblog.sh install && ./vanblog.sh reset /path/to/vanblog-full-xxx.tar.zst
```

`reset` 会自动完成"初始化 → 登录 → 恢复 → 重启 → 核对"整条链：新站点是空库时，
恢复接口在鉴权后面，**没初始化就没法登录、没法登录就没法恢复**，脚本用一个随机口令的
临时账号把这个死结解开，恢复成功后该账号就被备份里的真实账号覆盖了（用你原来的账号登录）。

::: tip 证书不用搬

caddy 的证书不在整站备份里，但**不需要搬**：新机器上首次访问域名时会按需重新签发
（前提是域名已经解析到新机器、80/443 可达）。真要连证书一起搬，用 `./vanblog.sh backup --offline`
打目录级快照，它包含 `caddy/` 目录。

:::

详见 [备份与迁移](../guide/backup.md#换新机器一条命令把整站搬过去)。

## 部署后无法访问后台

可以按照下面的步骤进行排查：

1. 检查编排端口映射、配置是否正确。
1. 浏览容器日志，确认是否成功启动。
1. 检查访问网址、端口是否正确。
1. 检查服务器防火墙、云服务厂商防火墙是否放行。
1. 检查本地服务器能不能访问。用 curl 简单测一下。

## docker 镜像拉取慢

您可以 [设置 docker 镜像加速器](https://www.runoob.com/docker/docker-mirror-acceleration.html)。

## 端口被占用

改一下编排里的端口映射到非常用端口就好了。

![端口修改](https://pic.mereith.com/img/47a03229d46e9120ad1e7bf1abf4b504.clipboard-2022-09-14.png)

## 部署后 http error

![错误案例](https://pic.mereith.com/img/ae28e582a7dce7be4816c1bf82dd77de.clipboard-2022-08-28.png)

请检查一下 docker-compose 编排文件，如果修改了下面的数据库账号密码，上面的也要同步修改。

![检查位置](https://pic.mereith.com/img/eb46eabfff8856c84ccd54a97d7f333c.clipboard-2022-08-28.png)

这两个地方的账号密码是对应的，实际上数据库是不会暴露到外面的（因为没有映射端口），所以无需更改默认账号与密码。

如需求该，需要同步修改两处，比如数据库账号密码改成了 `admin` 与 `xxxx`，那对应的数据库链接地址也要改成: `mongodb://admin:xxxx@mongo:27017`。

如果还是没能解决可以去 [QQ 交流群](https://jq.qq.com/?_wv=1027&k=5NRyK2Sw) 寻求帮助。

## 无法通过 Https + IP 访问网址

很遗憾，目前不支持通过 `https + ip` 访问，请通过 `https + 域名` 或者 `http + ip` 访问。用 `http + ip` 访问前请在后台设置中关闭 `https 自动重定向`。

## 宝塔 nginx 反代后前台显示错误

使用宝塔内置 nginx 反代后，常见表现是后台改了文章、前台仍是旧页。这多半是宝塔 `/www/server/nginx/conf/proxy.conf` 里的 `proxy_cache` 在缓存 HTML，而不是必须重装 Nginx。请按 [后台发布后前台不刷新仍显示旧文章](#后台发布后前台不刷新仍显示旧文章) 关闭或绕过代理缓存（[#469](https://github.com/Mereithhh/vanblog/issues/469)）。

个别环境升级 Nginx 也能缓解，但优先检查缓存配置。宝塔会在配置文件外自动加一些语句，其中就包括全局 `proxy_cache`。

## https 反代前台点击按钮跳转后页面不更新

同上，先按 [后台发布后前台不刷新仍显示旧文章](#后台发布后前台不刷新仍显示旧文章) 检查 Nginx / 宝塔 / CDN 是否在缓存前台 HTML。升级 Nginx 可以作为补充手段。
