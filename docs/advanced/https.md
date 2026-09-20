---
title: HTTPS
icon: certificate
order: 1
---

VanBlog 镜像内采用了 Caddy 作为反向代理，并支持全自动按需 HTTPS 证书申请配置。

<!-- more -->

::: info Caddy

[Caddy](https://caddyserver.com/) 是一款默认开启并支持自动 HTTPS 、证书申请续期的 Web 服务器。

:::

## 开启 HTTPS

VanBlog 首次运行默认关闭 HTTPS，请通过 HTTP 协议访问。无需多余设置，首次通过 “HTTPS + 域名” 访问时，会自动申请 HTTPS 证书并应用。

::: info 自动 HTTPS 要求

- 在部署时设置了 `EMAIL` 环境变量
- 对外映射了 `80/443` 端口，确保公网可访问
- 正在通过要申请证书的域名访问该服务器（已经设置了 DNS 解析）

:::

::: tip 想让访客用上 HTTP/3，还要放行 UDP 443

证书与 HTTPS 只需要 TCP 443；**HTTP/3(QUIC) 走的是 UDP 443**。容器里的 caddy 在 `:443` 上
本来就同时开了 `h1 / h2 / h3` 并发 `alt-svc` 头，所以缺的往往只是端口：新装的编排模板已经带
`<https端口>:443/udp`，**老安装**跑一次 `./vanblog.sh config` 再 `./vanblog.sh restart` 就会补上
（`./vanblog.sh status` 会直接告诉你 QUIC 端口映射了没有）。UDP 没放行也**不会坏** ——
浏览器试连失败会自动退回 HTTP/2。外层还有 nginx 之类反代时注意：nginx 不能反代 UDP，
详见 [反代 → 协议](../reference/reverse-proxy.md#协议http2-与-http3-在哪一层生效)。

:::

你可以点击 `使用当前访问域名触发按需申请` 按钮手动触发一下证书申请。

触发请后稍等一会（申请时间取决于网络环境）。若成功，页面将通过 HTTPS 正常加载。

![申请证书](https://pic.mereith.com/img/8383fb4f32144be26cb134c2390d6d10.clipboard-2022-08-23.png)

::: tip

1. 如果超过 5 分钟还是不生效，请检查日志。
1. 只有域名可以触发证书申请，通过 IP 访问不会触发。

:::

## HTTPS 自动重定向

当你确保可以通过自动申请的证书正常访问的时候，可以选择开启 `https 自动重定向` 功能，开启后所有的 `http` 访问将自动重定向到 HTTPS。

初始化完成后，请进入后台的 `站点管理/系统设置/HTTPS`，确认 HTTPS 证书已自动生成。确认状态正常后，再按需开启 HTTPS 自动重定向。

![开启 https 自动重定向](https://pic.mereith.com/img/d1e7b502279f0bd8225dfaedf89a5140.clipboard-2022-08-23.png)

这个配置将会保存到数据库，每次容器启动的时候都会初始化到 Caddy 中。

开启后请用无痕窗口访问 `http://你的域名`，确认会跳到 `https://`。也可在后台点「查看 Caddy 配置」，`apps.http.servers.srv1.listener_wrappers` 应含 `{"wrapper":"http_redirect"}`。若仍是 http，说明重定向未写入，请看 Caddy 日志或重试保存。

::: note

1. 开启后，不能通过 `http + ip` 访问站点
1. 无论 HTTPS 自动重定向是否开启，均不支持通过 `HTTPS + IP 地址` 来访问。需要 IP 访问请用 HTTP 协议并关闭 HTTPS 自动重定向。

:::

## HSTS（告诉浏览器：这个域名以后只用 HTTPS）

证书签好、443 能正常访问之后，内置 caddy 会在 **443 的响应上**默认下发：

```
Strict-Transport-Security: max-age=31536000
```

它的作用是：浏览器记住「这个域名一年内必须走 HTTPS」，之后即使有人手输 `http://` 或被塞了一个 `http://` 链接，浏览器也会**自己**改成 `https://`，不给中间人降级的机会。这和上面那个「HTTPS 自动重定向」是两件事 —— 重定向要靠服务器回一次 301（那一次仍然走的是明文），HSTS 是浏览器**本地**就改掉，第一次之后不再有明文请求。

想关掉或改时长，给容器设 `VANBLOG_HSTS_MAX_AGE`（秒；写 `0` = 不发这个头）。查现在有没有发：

```bash
curl -sI https://你的域名/ | grep -i strict-transport
```

**看到什么算成功**：输出 `strict-transport-security: max-age=31536000`。

::: warning 开之前请确认这两件事，否则可能把自己锁在门外

1. **证书目录必须真的持久化**。HSTS 生效期间，证书续签失败 = 浏览器**硬失败**，连「仍然前往」这个选项都不给。先跑一次体检确认：

   ```bash
   ./vanblog.sh doctor      # 会查「证书目录有没有真的持久化」与「证书还剩几天」
   ```

   ⚠️ k8s 部署最容易漏这一步：清单里要挂 caddy 的 config 与 data 两个卷，否则每次重建 Pod 都要重新签证书，很容易撞上 Let's Encrypt 的限额（同一组域名 7 天 5 张、34 小时 1 张）。

2. **一年内退不回纯 HTTP**。`max-age=31536000` 就是 365 天，浏览器会记这么久。如果你之后想彻底放弃 HTTPS，得等这个窗口过去（或者把 `VANBLOG_HSTS_MAX_AGE` 设成 `0`、再等访客的浏览器把旧记录熬过期）。

:::

几个边界，都是有意这么设的：

- **只在 443 上下发**。80 端口不发 —— 浏览器按规范（RFC 6797）本来就会忽略明文连接上的 HSTS，发了只是噪音。
- **用 IP 访问不受影响**。HSTS 是按域名记的，浏览器不会对 IP 地址启用它，所以 `http://服务器IP` 照常能用。
- **降级配置里不发**。证书校验不通过时 caddy 会回落到一份自签证书的降级配置，那份配置**故意不带** HSTS —— 在证书本来就不可信的路径上要求「一年内只用 HTTPS」，等于把站长锁在自己站点外面。
- **没有加 `includeSubDomains` 与 `preload`**。前者会波及同域名下别的子域（可能跑着别人的服务），后者一旦提交进浏览器预加载列表就**很难撤回**。需要的话自己在反代上加。

## FAQ

::: info 原理

VanBlog 通过 Caddy 的 API 在运行时动态修改配置来开关 HTTPS 自动重定向。

全自动按需申请证书可以参考 [on-demand-tls](https://caddyserver.com/docs/automatic-https#on-demand-tls)

:::

::: tip 问题排查

开启自动重定向后，用无痕窗口访问 `http://域名` 应跳到 https。若没有跳转，点「查看 Caddy 配置」确认 `srv1.listener_wrappers` 含 `http_redirect`（[#150](https://github.com/Mereithhh/vanblog/issues/150)）。

如果你熟悉 Caddy ，或者想自己排查，可以点击 `查看日志` 或者 `查看配置` 按钮自行排查。

- VanBlog 的访问日志在容器中的 `/var/log/vanblog-access.log`（这份是 **caddy** 写的 JSON 访问日志，
  一直在写，不需要开关；后台「Caddy」页也给了同样的路径）

- Caddy 的运行日志储存在 `/var/log/caddy.log`中，除了可以在后台查看外，也可以自行进入容器中或挂载目录查看。

:::
