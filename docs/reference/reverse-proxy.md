---
title: 反代
icon: refresh
order: 4
---

::: info 注意

VanBlog 内置了 caddy，可以全自动申请 https 证书，如没有其他服务需要共存，是不建议再加一层反代的。反代时只需要反代映射的 HTTP 端口，由于 VanBlog 是一个整体，无需考虑内部的 Caddy。你需要：

1. 按需修改默认的 80 端口号
1. 关闭 `https 自动重定向` (默认是关闭的)

:::

## 仅接受来自本机反代的流量

同机 Nginx / Caddy 反代时，可以把 VanBlog 绑到回环，避免 API 或映射端口暴露到公网（[#488](https://github.com/Mereithhh/vanblog/issues/488)）。这是**监听网卡**，不是额外的来源 IP 白名单。

### Nest API（端口 3000）

设置环境变量 `VAN_BLOG_SERVER_HOST=127.0.0.1`（或配置文件里的 `server.host`），重启后 Nest 只在回环上听 3000。默认留空 = 监听所有网卡，所以不改也不影响现有部署。

VanBlog 的一体式镜像里，内置 Caddy 已经反代 `127.0.0.1:3000`，把 Nest 绑到 `127.0.0.1` 不会打断容器内部转发。前台 Next 进程仍按原方式启动，本项只改 API 的 listen host。

### Docker 映射的 80 / 443

宿主机上的反代访问的是编排映射出来的端口。只改 `VAN_BLOG_SERVER_HOST` **不会**把宿主机的 `80:80` 收成仅本机。这时应改编排，例如：

```yaml
ports:
  - "127.0.0.1:80:80"
  - "127.0.0.1:443:443"
```

然后本机反代指到 `127.0.0.1:<映射端口>`。不要改默认的 `80:80` / `443:443`，除非你确实在同机再套一层反代。

::: warning 注意

在外层反代后面请关闭后台「HTTPS 自动重定向」，只反代映射的 HTTP 端口。必须转发 `Host`，见下文 Nginx 示例。

:::

## 转发头与限流分桶：追加而不是覆盖 `X-Forwarded-For`

🔴 **这一节直接关系到「按 IP 的限流与登录锁定」在你这套反代下面是否真的生效**，配错了会**静默失效**（不报错，只是挡不住人、或者反过来把所有人当成同一个人）。

VanBlog 的限流与防爆破计数都要一个「客户端 IP」。在反代后面，套接字对端是你的反代（一体式部署里就是容器内的 caddy，即回环地址），所以真实客户端只能从转发头里取 —— 而**转发头是客户端想写什么就写什么**。判据由 `VANBLOG_TRUST_FORWARDED_HEADERS` 决定（权威说明见 [环境变量参考](./env.md)）：

| 取值 | 行为 | 什么时候用 |
| --- | --- | --- |
| **`auto`（默认）** | **只有当套接字对端是回环/私网时**才采信转发头，而且只信**一跳**：取 `X-Forwarded-For` 的**最右**一项 | 绝大多数部署：同机/内网反代，或一体式镜像里内置的 caddy |
| `always` | 始终采信转发头（并优先看 CDN 头 `CF-Connecting-IP` / `True-Client-IP`） | CDN 或隧道**直连源站**、对端就是公网代理 IP 的部署 |
| `never` | 只认套接字地址 | ⚠️ 反代后面等于**全站共用一个限流桶**，会引发 429 风暴，一般不要用 |

🔴 **为什么默认取「最右一跳」**：caddy 与 nginx 的常规配置是把真实对端**追加**到客户端自带的 XFF 之后，所以**最右一项才是「可信代理看到的对端」**，左边的都可能是客户端伪造的。

::: warning 外层反代必须「追加」XFF，不能「覆盖」

- ✅ **追加**（正确）：nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`、caddy `reverse_proxy`（默认就追加）、宝塔/NPM 的默认模板。此时 XFF 形如 `<客户端伪造的一串>, <你的反代看到的真实对端>`，最右一项可信。
- 🔴 **覆盖**（错误）：把 XFF 直接设成客户端传来的值、或只设成 `$remote_addr` 而丢掉原有内容。此时**最右一项就是攻击者自己写的**，于是：
  - **体量类限流被绕过**：攻击者每次请求换一个新的伪造 XFF，就拿到一份全新的 600 次/分钟预算；
  - 🔴 **反过来还能栽赃**：把 XFF 写成受害者的真实 IP，让对方被登录失败锁定挡在门外。
- ⚠️ 如果你**必须**在多层代理后面（例如 Cloudflare → 自己的 caddy → VanBlog），`auto` 取到的最右一项是**上一层代理**的地址而不是访客的 ⇒ 这种部署应当用 `always`（它会优先看 CDN 头）。

:::

⚠️ **登录防爆破 / 评论频率 / 加密文章解锁**这几处计数用哪个 IP，由 `VANBLOG_BRUTE_FORCE_IP_SOURCE` 单独决定（默认 `trusted`，即与上面同一套可信判定）。这几处之所以要单独一个旋钮：对它们而言攻击者的收益正是「换一个 key 重新开始」，所以身份来源必须谨慎；而**体量类**限流（全局 / 静态 / 公开写 / 初始化）轮换头的收益只是「攻击者自己拿到新的体量预算」，与旧行为相同。

🔴 **配错了怎么发现**：如果你配了 `VANBLOG_ADMIN_LOGIN_ALLOW_CIDR`（后台登录网段白名单）却一直被 403 挡在外面，服务端日志里那条拒绝记录会**直接告诉你原因** —— 它会在「被拒的 IP 是私网/回环、而白名单里全是公网网段」时提示：这通常意味着**转发头没被采信**，请检查 `VANBLOG_TRUST_FORWARDED_HEADERS`，或者**你的反代是在覆盖而不是追加 `X-Forwarded-For`**。

⚠️ **多进程（cluster）部署**：各档限流阈值会按 worker 数**摊薄**，因为计数器是每进程内存的 —— 不摊薄等于把预算悄悄放宽 N 倍。所以你在文档里看到的「600 次/分钟」在 N 个 worker 下是**每个 worker 600/N 次**。

## 协议：HTTP/2 与 HTTP/3 在哪一层生效

VanBlog 容器里的 caddy 在 `:443` 上默认就是 `h1 / h2 / h3`（HTTP/3 要真的可用，还需要编排文件映射
**UDP** 443 —— QUIC 走 UDP，新装自带；老安装跑一次 `./vanblog.sh config` 再 `restart`）。

**一旦你在前面又套了一层反代，访客用的就是外层的协议**，caddy 那层的 h2/h3 只对
"外层 → caddy"这一跳有意义：

- 外层是 nginx / NPM：请显式开 HTTP/2（nginx ≥ 1.25.1 用 `http2 on;`，更早的版本写
  `listen 443 ssl http2;`），否则访客仍然是 HTTP/1.1。
- **QUIC/HTTP/3 过不去**：nginx 不能反代 UDP。要么让访客直连 VanBlog 的 443（含 UDP），
  要么用支持 HTTP/3 的边缘（如 Cloudflare，它会在边缘终结 QUIC，回源仍是 h1/h2）。
- 外层到 VanBlog 的这一跳走 HTTP/1.1 就够了（本机/内网，延迟极低），不必折腾 h2c ——
  容器里的 Nest 与 Next 默认也不支持 h2c。
- 外层记得转发 `X-Forwarded-For` / `X-Forwarded-Proto` 与原始 `Host`（下面各节的配置里都有），
  否则访问统计会记成反代的 IP、站内绝对链接会变成 http。

## 反代方式

### nginx-proxy-manager

强烈推荐 [nginx-proxy-manager](https://nginxproxymanager.com/)这个项目！它可以帮你自动管理反代配置，并申请相应的 `https` 证书。

### Caddy

第二推荐的是 [caddy](https://caddyserver.com/)，一个现代的高性能 web 服务器，它也可以自动帮你配置好 `https`

配置文件参考：

::: code-tabs

@tab Caddy V2

```conf
example.com {
  tls admin@example.com
  reverse_proxy  127.0.0.1:<你映射的端口号> {
    trusted_proxies private_ranges
  }
}
```

@tab Caddy V1

```conf
example.com {
  tls admin@example.com
  proxy / 127.0.0.1:<你映射的端口号> {
    transparent
    websocket
  }
}
```

:::

::: tip Caddy 与缓存

Caddy 的 `reverse_proxy` **默认不缓存** HTML，一般不会出现「后台发了、前台还是旧文章」。若另外装了 cache 插件，或前面还有 Cloudflare 等 CDN，请不要缓存前台 HTML；改完后清一下边缘缓存。Nginx / 宝塔见下文。[#469](https://github.com/Mereithhh/vanblog/issues/469)

:::

### Nginx（配置示例）

用 Nginx 反代时，下面两份配置可以直接改域名与端口用。想自己生成一份，可以用在线工具 [nginxconfig.io](https://nginxconfig.io/)（生成后请把下面「注意」里列的几行补上，尤其是转发 `Host`）。

::: warning 注意

- 宝塔面板用 Nginx 反代，后台发布后前台仍是旧文章时，先关 `proxy_cache`（见下文），不要只靠缩短缓存或重装 Nginx。
- location 下面的配置块只保留下面提供配置的那几行就可以了，不要加奇奇怪怪的语句和请求头（看不懂请忽略）
- **必须转发 `Host`**（`proxy_set_header Host $host;`）。否则内嵌 Waline 评论登录 / 管理后台的 OAuth 回调会写成 `localhost` 或容器监听地址（如 `0.0.0.0`），而不是站点域名。见 [部署常见问题](../faq/deploy.md#反代后-waline-登录跳到-localhost)。
- **必须转发 `X-Forwarded-For`，而且是「追加」不是「覆盖」**（nginx 写 `$proxy_add_x_forwarded_for`，它就是把真实对端**追加**到客户端自带的 XFF 之后；🔴 **不要写成 `$http_x_forwarded_for` 或自己拼一个只含 `$remote_addr` 的值**）。原因见下面「转发头与限流分桶」一节：VanBlog 默认取 XFF 的**最右一跳**，**追加**时最右一项才是你的反代看到的真实对端，**覆盖**时最右一项就变成客户端自己写的值。
- 建议同时转发 `X-Real-IP`。⚠️ **但默认的 `auto` 模式不看 `X-Real-IP`**（它没有「由代理追加」的语义，无法区分「代理写的」与「客户端写的」），所以只设 X-Real-IP 不设 XFF 是不够的。
- 若站点在 Cloudflare（或同类 CDN）后面，请把来访请求的 `CF-Connecting-IP` 原样转给 VanBlog，不要改写成边缘节点 IP。🔴 **注意：默认的 `auto` 模式也不看 `CF-Connecting-IP`**（CDN 专用头，只有 CDN 会覆写它，而 `auto` 的前提是「对端就是我自己的代理」）⇒ **这种部署要把 `VANBLOG_TRUST_FORWARDED_HEADERS` 设成 `always`**，否则访问统计与限流分桶拿到的是边缘节点 IP。Nginx 默认会透传该头；登录日志会优先读它。
- 若 CDN 使用「缓存全部」，请为 `/admin*` 和 `/api/admin*` 设置绕过缓存。VanBlog 源站已对这两类路径发送 `Cache-Control: private, no-store` 以及 `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control: no-store`，避免后台 HTML/JSON 被边缘存储；页面规则仍建议保留。见 [部署常见问题](../faq/deploy.md#cloudflare-缓存了后台或后台-api)。
- 外层 Nginx / 宝塔若开启了 `proxy_cache`（宝塔常在 `/www/server/nginx/conf/proxy.conf` 里写 `proxy_cache cache_one;`），会把**前台 HTML** 缓存很久。后台发布、更新或迁移后，公网站点可能仍是旧文章。官方示例已加上 `proxy_no_cache 1;` 与 `proxy_cache_bypass 1;`。源站后台/API 已发 no-store，**前台 HTML 不会强制 no-store**，代理和 CDN 仍可能缓存整页。见 [后台发布后前台不刷新仍显示旧文章](#后台发布后前台不刷新仍显示旧文章)（[#469](https://github.com/Mereithhh/vanblog/issues/469)）。

:::

::: code-tabs

@tab Http

```nginx
server {
  gzip on;
  gzip_min_length 1k;
  gzip_comp_level 9;
  gzip_types text/plain application/javascript application/x-javascript text/css application/xml text/javascript application/x-httpd-php image/jpeg image/gif image/png;
  gzip_vary on;
  gzip_disable "MSIE [1-6]\.";
  listen 80 ;
  # 改为你的网址
  server_name example.com;
  proxy_buffers 8 32k;
  proxy_buffer_size 64k;

  location / {
    # 改为容器的 PORT
    proxy_pass http://127.0.0.1:<PORT>;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    # 绕过 proxy_cache（宝塔 proxy.conf 可能全局开启），避免前台 HTML 发不出去
    proxy_no_cache 1;
    proxy_cache_bypass 1;
  }
}
```

@tab Https

```nginx
server {
  listen 80;
  # 改为你的网址
  server_name example.com;
  # 重定向为 https
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  # 改为你的网址
  server_name example.com;
  # 证书的公私钥
  ssl_certificate /path/to/public.crt;
  ssl_certificate_key /path/to/private.key;

  location / {
    # 改为容器的 PORT
    proxy_pass http://127.0.0.1:<PORT>;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    # 绕过 proxy_cache（宝塔 proxy.conf 可能全局开启），避免前台 HTML 发不出去
    proxy_no_cache 1;
    proxy_cache_bypass 1;
  }
}
```

:::

## 后台发布后前台不刷新仍显示旧文章

后台发布或更新文章后，公网首页 / 文章页不刷新、仍显示旧内容；整站迁移后也可能这样。先排除 VanBlog 自己的增量渲染：到 **站点管理 / 系统设置 / 高级设置** 手动触发一次静态页面更新，并确认**直连容器映射端口**能看到新内容。说明见 [静态页面更新策略](../advanced/isr.md)。

若只有走 Nginx / 宝塔反代（或 Cloudflare 等 CDN）时是旧页，就是外层在缓存 HTML（[#469](https://github.com/Mereithhh/vanblog/issues/469)）。社区方案来自 [RubyXun](https://github.com/RubyXun) / [lateautumn233](https://github.com/lateautumn233)，相关讨论见 [#332](https://github.com/Mereithhh/vanblog/issues/332)。

源站已对 `/admin` 和 `/api/admin/*` 发送 `Cache-Control: private, no-store`（以及 CDN / Cloudflare 的 `no-store`），见 [#140](https://github.com/Mereithhh/vanblog/issues/140)。**前台文章 HTML 不会强制 no-store**，Nginx / 宝塔 / CDN 仍可能把整页存下来。

### Nginx

在反代 `location` 里加上下面这些（`<PORT>` 换成你的实际端口）：

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

`proxy_no_cache 1;` 与 `proxy_cache_bypass 1;` 会绕过本层以及上层 `proxy_cache`（例如宝塔全局配置）。不要依赖缩短缓存时间来「差不多及时」。

### 宝塔

宝塔常在 `/www/server/nginx/conf/proxy.conf` 里写 `proxy_cache cache_one;`，对所有反代生效。可以：

1. 在站点反代的 `location` 里加上面两行；和 / 或
2. 把 `proxy.conf` 里的 `proxy_cache cache_one;` 注释掉（`# proxy_cache cache_one;`），再重载 Nginx。

改完后清一下浏览器缓存。图形化部署步骤里的缓存说明见 [宝塔面板](../guide/get-started.md#调整-nginx-缓存)。

### Cloudflare / CDN

不要对 HTML 开「缓存全部」。改完后到 CDN 控制台清一次边缘缓存。后台路径绕过见 [部署常见问题](../faq/deploy.md#cloudflare-缓存了后台或后台-api)。

只用内置 Caddy、没有再套一层反代或 CDN 时，一般不必改这些。部署侧说明见 [部署常见问题](../faq/deploy.md#后台发布后前台不刷新仍显示旧文章)，使用侧见 [使用常见问题](../faq/usage.md#后台发布后前台不刷新仍显示旧文章)。
