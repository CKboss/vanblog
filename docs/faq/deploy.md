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

不设置就监听所有网卡（容器内的默认行为），所以现有部署不用改。

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

Cloudflare（或同类 CDN）如果用「缓存全部」覆盖 `/*`，即使另有 `/admin*` 绕过规则，**`/api/admin/*` 也不会被那条规则匹配**，登录和后台 JSON 仍可能被边缘缓存（来历：[#140](https://github.com/Mereithhh/vanblog/issues/140)）。所以只加页面规则不够。

源站自己也会帮忙：`/admin` 与 `/api/admin/*` 的响应带

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

一键安装 / `config` 需要下载 `docker-compose-template.yml`。脚本会按下面的顺序逐个试，
任一处成功就继续，并**打印实际用的 URL**（排查时把这行贴出来最有用）：

1. GitHub raw：`https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/docker-compose/docker-compose-template.yml`
1. jsDelivr 镜像：`https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/docker-compose/docker-compose-template.yml`
   （raw.githubusercontent.com 在部分网络下经常不通，jsDelivr 通常可达）
1. GitHub Release 附件：`https://github.com/CKboss/vanblog/releases/latest/download/docker-compose-template.yml`
   （每次发版都会把模板与 `vanblog.sh` 挂在 Release 上；`VANBLOG_RELEASE_TAG` 可以钉住某个 tag）
1. 最后三条是第三方兜底（`vanblog.mereith.com` 文档站，以及它的 raw / jsDelivr）。
   ⚠️ 走到兜底拿到的是**旧模板**：mongo 钉在 4.4.16，也没有日志上限、`depends_on`、
   mongo healthcheck 这些当前默认。脚本会提示「模板里没有 mongo 占位符」，功能仍可用，
   但建议排查网络后重跑 `config`。

报「下载脚本失败」时先做两件事：

1. 用菜单 **20. 更新此脚本** 把脚本更新到最新，再重跑一次 —— 旧脚本只请求一个地址，
   部分网络（例如北美）连不上就直接失败（来历见 [#115](https://github.com/Mereithhh/vanblog/issues/115)）。
2. 把脚本打印的那个 URL 拿出来 `curl -I` 试一下，看是哪一段网络不通。

若连文档站上的 `vanblog.sh` 都下不下来，可以用 GitHub raw 或 jsDelivr：

```bash
curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh && ./vanblog.sh
# raw 不通时（常见于中国大陆网络）：
curl -L https://cdn.jsdelivr.net/gh/CKboss/vanblog@dev/dsh/scripts/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh && ./vanblog.sh
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

::: warning 一键脚本装 docker 的方式

`./vanblog.sh install` 发现机器上没有 docker 时，会**用 root 通过 `bash <(curl …)` 管道执行一个远端安装脚本**
（国内走 `vanblog.mereith.com/docker.sh`，海外走 `get.docker.com`）。这等于把 root 交给那个远端脚本当时的内容 ——
脚本内容变了、或域名换了主人，你都会照着执行。
不放心的话，先自己装好 docker（发行版仓库、`get.docker.com` 或上面的 daocloud 脚本，
装之前都可以先下载下来读一遍），再跑 `./vanblog.sh`：脚本检测到 docker 已存在就不会再碰这一步。

:::

## 编排文件里的 mongo healthcheck 与 depends_on

新生成的编排文件里，mongo 带了一个健康检查：

```yaml
healthcheck:
  test: ["CMD-SHELL", "mongosh --quiet --eval 'db.runCommand({ping:1}).ok' || mongo --quiet --eval 'db.runCommand({ping:1}).ok'"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 40s
```

两个 shell 都要试是因为镜像 tag 不固定：`mongo:4.4.16` **没有** `mongosh`，`mongo:6.0/7.0`
**没有** legacy `mongo` shell，`||` 短路让同一个 test 在哪个版本上都能用。`start_period`
给首次启动（初始化数据目录 / 崩溃后回放 journal）留了 40 秒宽限，期间的失败不计入 `retries`。

vanblog 服务对 mongo 的 `depends_on` 有两种形状，脚本会按你机器的 compose **实测**选择
（`config` 时拿一个带 `condition:` 的临时文件跑一次 `docker-compose config`，看退出码，不猜版本号）：

| 你的 docker-compose | 生成的 depends_on | 行为 |
| --- | --- | --- |
| ≥1.27 或 compose v2（`docker compose`） | 长格式 `mongo: {condition: service_healthy}` | vanblog **等 mongo 健康检查通过**才启动，首次安装不再"重启几次才稳" |
| 更老（如 Ubuntu 20.04 自带的 1.25） | 列表形式 `- mongo` | 只保证 mongo 先启动，不等就绪；server 自己会重试连库（10 次 × 3 秒），多等几秒属正常 |

模板里**提交的是列表形式**（所有版本都解析得了的方向），长格式是脚本在你机器上实测支持后
才升级上去的 —— 反过来（模板写死长格式）会让 Ubuntu 20.04 这类老 compose 直接解析失败、
整个栈起不来。老安装跑一次 `./vanblog.sh config` 就能拿到 healthcheck 与（如果支持的话）长格式。

## 如何在外部访问数据库

::: warning 先想清楚要不要真的暴露端口

默认编排里 mongo **没有映射任何端口**，只有同一个 compose 网络里的 vanblog 能连它 —— 这本身就是最安全的状态。
把 27017 开到公网，等于把整站数据（含密码哈希）挂在互联网上等扫描器；MongoDB 被扫到后勒索、删库都是常见结局。
**九成场景用下面的「SSH 隧道」就够了**，不需要暴露端口。

:::

### 推荐：SSH 隧道（不改安全边界）

在编排里把 mongo 的端口只绑到本机回环：

```yaml
  mongo:
    ports:
      - "127.0.0.1:27017:27017"
```

`docker-compose down && docker-compose up -d` 之后，在你自己的电脑上开隧道，再用本地客户端连 `127.0.0.1:27017`：

```bash
ssh -L 27017:127.0.0.1:27017 <用户>@<服务器IP>
```

这样 27017 只有服务器上本机可达，外网扫不到。图形客户端（如 [MongoDB Compass](https://www.mongodb.com/try/download/compass)）
连 `mongodb://127.0.0.1:27017` 即可。

### 必须直接暴露端口时

默认模板里的 mongo **没有开认证**（`environment:` 只有 `TZ`），靠的就是"外面连不到"。
要对外开端口，必须先给它加上账号密码，三处要一起改：

```yaml
  mongo:
    environment:
      TZ: 'Asia/Shanghai'
      MONGO_INITDB_ROOT_USERNAME: 'admin'
      MONGO_INITDB_ROOT_PASSWORD: '换成你自己的强密码'
    ports:
      - "27017:27017"        # ⚠️ 能不写就不写；要写也尽量绑到内网/VPN 网卡的地址

  vanblog:
    environment:
      # 账号密码要与上面一致，并且保留 /vanBlog?authSource=admin
      VAN_BLOG_DATABASE_URL: 'mongodb://admin:换成你自己的强密码@mongo:27017/vanBlog?authSource=admin'
```

```bash
docker-compose down && docker-compose up -d     # ⚠️ 不要加 -v
```

⚠️ **`MONGO_INITDB_ROOT_*` 只在数据目录为空时生效**（也就是全新安装）。已经有数据的站点要先在库里建用户，
否则 vanblog 会连不上：

```bash
# mongo 6.0 / 7.0 用 mongosh；mongo 4.4 把 mongosh 换成 mongo
docker-compose exec mongo mongosh --eval 'db.getSiblingDB("admin").createUser({user:"admin",pwd:"换成你自己的强密码",roles:[{role:"root",db:"admin"}]})'
```

再按上面改 `VAN_BLOG_DATABASE_URL` 并重启。连不上时先看容器日志（`./vanblog.sh log`）里有没有
认证失败（`Authentication failed`）或 `command find requires authentication`。

::: danger 千万不要顺手加 -v

`docker-compose down -v` 会**删除编排里的卷**。现在默认是 bind mount（数据在宿主机目录里）所以侥幸没事，
但只要有人把编排改成了命名卷，`-v` 就等于删库。重启请用不带 `-v` 的 `down`；
只有 `./vanblog.sh uninstall`（卸载）才应该用 `-v`，而且它会先让你确认。

:::

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
# 拷走之前先验一遍（完整性 + sha256 + 内容清单，不解压落盘），到新机器上还可以再验一次
./vanblog.sh verify
# 把 vanblog-full-*.tar.zst（连同同名 .sha256 / .manifest.json）拷到新机器（scp / U 盘都行）

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

## 站点出问题了，先跑一次 doctor

```bash
./vanblog.sh doctor
```

**只读体检，不改任何东西**，一次把该看的都看完，而且退出码可以直接给监控用：`0` = 没有致命问题、`1` = 有问题。交互菜单里是第 **16** 项。

它查这些：

| 查什么 | 什么情况会报出来 |
| --- | --- |
| 容器状态与**重启次数** | 重启 ≥5 次会直说「在崩溃循环里」，并把两个容器最近的日志各打 12 行 |
| 健康探测有没有真的在生效 | 显示 `none` 说明构建工具（podman/buildah）把镜像里的 HEALTHCHECK 丢了，见 [Docker 部署](../guide/docker.snippet.md) |
| 健康接口 | **503 会直接说「server 活着但数据库连不上」并指路 `restore --offline-full`** |
| 磁盘剩余 | 小于 2 GiB 报红 |
| 最近一次备份多旧 | 超过 72 小时报红、超过 26 小时提醒；上次定时备份失败也会说 |
| **证书目录有没有真的持久化** | 没挂上卷会报出来，并附 Let's Encrypt 的真实限额（同一组域名 7 天 5 张、34 小时 1 张） |
| **证书还剩几天** | 小于 21 天提醒、小于 7 天报红 |
| 日志里的严重错误 | 扫 `Cannot find module` / `ECONNREFUSED` / `ENOSPC` / OOM 等关键字 |

⚠️ 两件事它**故意不做**：读不到某样东西时会**明说读不到**并返回 0，而不是猜一个数字（比如某些系统上 `find -printf` 不可用，那时它会说「查不了」而不是报「你没有备份」）；证书读不到也不算问题（用 IP 或纯 HTTP 部署、证书还没签发，都是合法状态）。

`./vanblog.sh status` 也会多打印一行证书剩余天数。

## 站点已经起不来了（数据库坏了）

平时的 `restore` 与 `reset` 都要先访问站点接口，而站点要连得上数据库 —— 所以**数据库损坏时这两条路都走不通**，这是个死锁。用这条：

```bash
./vanblog.sh restore --offline-full /路径/vanblog-full-20260920-030000.tar.zst
```

它先校验归档（**不过就一个字节都不动**）→ 要你输 `yes` → 停栈 → 把数据库目录**改名保留**成 `data/mongo.broken-<时间戳>`（**不删除**）→ 起栈（站点显示「未初始化」是正常的）→ 用归档重置整站 → 逐项核对。

**看到什么算成功**：打印 `✓ 离线恢复完成`，前台能打开、后台能登录。
**中途失败**：每一步都会打印可照抄的回滚命令（把那个 `.broken-*` 目录改回去）。⚠️ 确认站点正常之前**不要删**它，那是唯一的回滚点。

完整说明见 [整站备份](../advanced/backup.md#站点已经起不来了怎么恢复)。

## 部署后无法访问后台

可以按照下面的步骤进行排查（**先跑一次 `./vanblog.sh doctor`**，上面那一节）：

1. 检查编排端口映射、配置是否正确。
1. 浏览容器日志，确认是否成功启动。
1. 检查访问网址、端口是否正确。
1. 检查服务器防火墙、云服务厂商防火墙是否放行。
1. 检查本地服务器能不能访问。用 curl 简单测一下。

## docker 镜像拉取慢

本项目的镜像在 `ghcr.io/ckboss/vanblog`，而 ghcr.io 在中国大陆经常很慢或超时。三条路，按省事程度排：

1. **给 docker 配镜像加速器 / 代理**（一次配好，所有镜像都受益），例如
   [设置 docker 镜像加速器](https://www.runoob.com/docker/docker-mirror-acceleration.html)；
2. **把 `VANBLOG_IMAGE_REF` 指向你自己的镜像加速地址**，例如
   `VANBLOG_IMAGE_REF=<你的加速地址>/ckboss/vanblog:latest ./vanblog.sh install`；
3. **在能拉到的机器上导出、再导入**：

   ```bash
   # 能拉到镜像的机器
   docker pull ghcr.io/ckboss/vanblog:latest && docker save ghcr.io/ckboss/vanblog:latest -o vanblog.tar
   # 目标机器
   docker load -i vanblog.tar
   VANBLOG_INSTALL_MODE=image VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:latest ./vanblog.sh install
   ```

拉不到镜像时脚本会退回**源码构建**（15–40 分钟、要 1.8GB 以上可用内存），不想等就用
`VANBLOG_INSTALL_MODE=image` 明确只拉镜像，失败了立刻看到错误。

⚠️ 上面第 3 条（`save` → 拷 → `load`）**现在是真能跑通的**。以前脚本无条件先 `docker pull`，
拉不到就直接失败 —— 而它失败时给出的建议恰恰是「先 load 再重跑」，照做仍然会走同一个 pull，
于是断网的机器上根本装不起来。

## 完全离线的机器（不能出网）怎么装

```bash
# ① 在一台能上网的机器上把镜像导出
docker pull ghcr.io/ckboss/vanblog:latest
docker save ghcr.io/ckboss/vanblog:latest -o vanblog.tar
#    顺便把一键脚本也存下来（离线机器上没法 curl）
curl -fsSL https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh

# ② 把 vanblog.tar、vanblog.sh（以及你的整站备份归档，如果有）拷到目标机器
#    scp / U 盘都行；Docker 本身要提前装好

# ③ 在目标机器上导入并安装（VANBLOG_SKIP_PULL=1 = 一次网络都不碰）
docker load -i vanblog.tar
chmod +x vanblog.sh
VANBLOG_SKIP_PULL=1 ./vanblog.sh install

# ④ 有备份归档的话，安装时一步恢复
VANBLOG_SKIP_PULL=1 VANBLOG_RESTORE_FROM=/path/vanblog-full-xxx.tar.zst ./vanblog.sh install
```

**看到什么算成功**：安装过程打印 `VANBLOG_SKIP_PULL=1：使用本地镜像 …（未联网）`，最后逐项核对通过。

- `VANBLOG_SKIP_PULL=1` 的含义是**绝不联网**：本机有这个镜像就用，没有就明确报错（不会偷偷去拉）。本机没有时它会告诉你怎么办。
- **不设** `VANBLOG_SKIP_PULL` 时的默认行为：照常先 pull（⚠️ 这一步不能省，否则 `latest` 这种会移动的标签永远升不上去），**pull 失败但本机已有一份**时回落到本地镜像继续，并把「这份可能不是最新的」说清楚，同时告诉你怎么看这份本地镜像是哪一版。
- ⚠️ 离线环境下这几件事会受影响，提前知道比现场排查省事：**HTTPS 证书签不出来**（要向 Let's Encrypt 出网；解决办法是在别处签好、连 `caddy/` 目录一起搬，或用目录级快照 `backup --offline` 搬 —— 它含证书），**流水线的「安装依赖」跑不了**（要出网 `pnpm add`；可以在有网机器上装好后把 `pluginRunner` 目录一起搬过去），**图床的第三方存储与外链转存**要能出网到对应服务。

## 端口被占用

改一下编排里的端口映射到非常用端口就好了。

![端口修改](https://pic.mereith.com/img/47a03229d46e9120ad1e7bf1abf4b504.clipboard-2022-09-14.png)

## 部署后 http error

先按这个顺序排（绝大多数是**数据库连不上**）：

```bash
./vanblog.sh status      # 容器/接口/端口/目录一眼看全
./vanblog.sh log         # 容器日志：看 server 有没有报连不上 mongo
```

1. 日志里出现 `MongoNetworkError` / `connect ECONNREFUSED mongo:27017`：mongo 还没起来或不在同一个网络里。
   等 30 秒再看（首次初始化数据目录会慢一点）；仍不行就 `docker-compose down && docker-compose up -d`（**不要加 `-v`**）。
2. 日志里出现 `Authentication failed` / `requires authentication`：连接串与 mongo 的账号密码不一致。
   默认模板里 mongo **没有开认证**，vanblog 用的连接串是
   `mongodb://mongo:27017/vanBlog?authSource=admin`；如果你给 mongo 加了
   `MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD`，就必须同步把
   `VAN_BLOG_DATABASE_URL` 改成 `mongodb://<用户>:<密码>@mongo:27017/vanBlog?authSource=admin`
   （**`/vanBlog?authSource=admin` 这段不能丢**），两处改完再重启。
3. 日志里出现 `Unclean shutdown detected` 或 mongo 反复重启：多半是上次被硬杀或磁盘满了。
   先 `df -h` 看磁盘，再 `./vanblog.sh restart`。
4. 以上都正常但浏览器还是报错：回到 [部署后无法访问后台](#部署后无法访问后台) 按端口 / 防火墙逐条排。

改完编排文件记得重启容器才生效；`./vanblog.sh config` 会**重新生成**编排文件（覆盖前存一份
`.bak-<时间戳>`），手改的 `environment:` 要记得加回去。

仍然没头绪的话，带上 `./vanblog.sh status` 的输出与日志片段去
[CKboss/vanblog 开 issue](https://github.com/CKboss/vanblog/issues/new)，见 [问题反馈](./README.md#问题反馈)。

## 无法通过 Https + IP 访问网址

不支持用 `https + IP` 访问：HTTPS 需要证书，而证书是 caddy 按域名向 Let's Encrypt 申请的（IP 拿不到证书）。请用 `https + 域名`，或者 `http + IP`；用 `http + IP` 之前，先到后台 **系统设置 / HTTPS** 关掉「HTTPS 自动重定向」，否则会被强制跳到 https。关不掉时用 `./vanblog.sh reset_https` 在服务器上重置，见 [使用常见问题](./usage.md#开启了-https-重定向后关不掉)。

## 宝塔 nginx 反代后前台显示错误

使用宝塔内置 nginx 反代后，常见表现是后台改了文章、前台仍是旧页。这多半是宝塔 `/www/server/nginx/conf/proxy.conf` 里的 `proxy_cache` 在缓存 HTML，而不是必须重装 Nginx。请按 [后台发布后前台不刷新仍显示旧文章](#后台发布后前台不刷新仍显示旧文章) 关闭或绕过代理缓存（[#469](https://github.com/Mereithhh/vanblog/issues/469)）。

个别环境升级 Nginx 也能缓解，但优先检查缓存配置。宝塔会在配置文件外自动加一些语句，其中就包括全局 `proxy_cache`。

## https 反代前台点击按钮跳转后页面不更新

同上，先按 [后台发布后前台不刷新仍显示旧文章](#后台发布后前台不刷新仍显示旧文章) 检查 Nginx / 宝塔 / CDN 是否在缓存前台 HTML。升级 Nginx 可以作为补充手段。
