---
title: 安全与加固
icon: shield-halved
order: 9
---

这一页记录 VanBlog 在服务端做的安全约束，以及部署时可以用环境变量调整的几个开关。做过一轮完整审计（认证/权限、上传与文件、注入与数据暴露、功能正确性四个方向），下面是结论。

<!-- more -->

## 上传

- **图床只接受真图片**：按文件**内容**（魔数 + 解码）判定类型，不看客户端给的后缀和 MIME。`.html` / `.svg` / 伪装成 png 的任意文件一律 400。原因：`/static/img/**` 与站点同源且匿名可读，一个能存进去的 HTML 就是存储型 XSS（可偷后台 token）。非图片请走 [附件管理](../features/attachment.md)——附件对 html/svg/js 等类型强制下载并带 `nosniff`。
- **体积上限**：图片 50MB、自定义页面 200MB、附件 200MB、旧版 JSON 备份 200MB、整站备份恢复 8GB（落盘，不进内存）。
- **像素上限** 1 亿像素：隐写水印需要把整图解码成 RGBA，超大图会瞬间吃掉上 GB 内存。
- 整个静态目录都带 `X-Content-Type-Options: nosniff`；可执行/可渲染的文本类型（html、svg、js、css…）无论在哪个子目录都强制下载。
- 图片与缩略图缓存：`public, max-age=3600, stale-while-revalidate=604800`（不用 `immutable`，因为「替换图片」是同名覆盖）。

## 下载与导出

- 「导出全部图片 / 导出全部附件」的归档**不再放在静态目录**，改存 `backup.path/export/`，只能通过带登录态的 `GET /api/admin/export/archive?name=` 下载，下载完即删除。以前归档在匿名可读的 `/static/export/` 下、文件名只有日期，任何人都能猜出来把整站图片和附件拖走。
- 整站备份归档同样在静态目录之外，`/static/export/`、`/static/tmp/`、`/static/upload-tmp/` 一律匿名 403。
- 旧版 JSON 导出改成系统临时目录 + 无论成败都删除。

## 认证

- **登录防爆破默认开启**：5 次失败 / 300 秒（后台「登录设置」可改 `maxRetryTimes` / `durationSeconds`，也可以整体关掉）。只统计**失败**次数，登录成功即清零——以前的实现把成功登录也算一次，正常用户一分钟内登录几次就会被锁在门外。
- 限流的 key 用 **TCP 套接字地址**，不用 `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP`（这些都能被客户端伪造，伪造一次就绕过限流，反过来还能用别人的 IP 把对方锁死）。
- 空密码一律拒绝：改密码、建/改协作者、「忘记密码」恢复通道都会校验用户名与密码，避免把密码哈希写成空串（空哈希曾经能用空密码登进来）。
- 协作者读不到分类的加密密码（`GET /api/admin/category/all?detail=true` 会对协作者脱敏）。
- 权限判定出错时**拒绝**（以前是放行）。

## 请求参数

- 全局净化中间件会递归删掉请求里以 `$` 开头的键（Mongo 操作符）以及 `__proto__` / `constructor` / `prototype`。以前 `?category[$ne]=x`、`?path[$regex]=^/bl` 这类查询对象会被直接塞进 Mongo 过滤器。
- 所有进入 `$regex` 的用户输入都会转义并限长 200 字符，搜索还带 5 秒 `maxTimeMS`。以前搜 `(`、`[`、`*`、`a{2,1}` 会让公开搜索接口直接 500，`(a+)+b` 这类模式还能造成灾难性回溯。
- 加密文章不会通过搜索、RSS、`POST /api/public/article/:id`（输密码解锁）泄露：这三处以前各有一条缝。

## 出站请求（SSRF）

- 所有服务端抓取外链的地方（导出 md/mdz 时抓远程图片、转移外链图片、扫描文章图片）都走同一套 `fetchRemoteSafely`：**禁用自动重定向，每一跳重新校验**，只允许 http/https，拒绝回环/内网/链路本地地址，抓回来的内容必须是真图片（魔数校验）才会被使用。
  以前只校验第一个 URL，攻击者可以用自己的域名过检再 302 到 `169.254.169.254`（云元数据）或 `127.0.0.1` 的内部服务，把响应体原样带回来。
- Caddy 的按需证书回调 `/api/admin/caddy/ask` 只批准本站域名（`siteInfo.baseUrl`、HTTPS 设置里的域名、已登记的 subjects）。以前任何非 IPv4 的域名都会被批准，别人把域名指过来就能让本站为它申请证书。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VANBLOG_DISABLE_IP_GEO` | 空 | 设 `true` 完全关闭登录日志的 IP 归属地查询（不再把访客 IP 发给第三方 cip.cc） |
| `VAN_BLOG_IP_GEO_TIMEOUT` | `3000` | 归属地查询超时（毫秒）。以前没有超时，离线环境下每次登录都要干等外网 |
| `VANBLOG_CADDY_ASK_ALLOW_ALL` | 空 | 设 `true` 恢复「任何域名都批准按需证书」的旧行为（多域名/CDN 场景才需要） |
| `VAN_BLOG_BACKUP_PATH` | `<log>/vanblog-backups` | 整站备份与导出归档的存放目录，必须在静态目录之外 |
| `VANBLOG_SWAGGER` | 空（= 开启） | 设 `false` 关闭 `/swagger` 与 `/swagger-json`。它默认公开，等于把整个后台 API 面摊给未登录用户，生产环境建议关掉 |
| `VAN_BLOG_REVALIDATE_SECRET` | 空 | 设了之后，前台的 `/api/revalidate` 必须带同名 `secret` 才生效（server 会自动带上）。一体式镜像里该路由不可达，**单独部署 website 镜像时建议设置** |
| `VANBLOG_PIPELINE_TIMEOUT_MS` | `30000` | 单个流水线的执行上限；超时直接杀进程，避免保存文章时被卡死 |
| `VANBLOG_DEPS_INSTALL_TIMEOUT_MS` | `300000` | 流水线安装依赖（`pnpm add`）的上限 |

## 已知限制（尚未处理）

- 文章/分类的**加密密码是明文存储**、用 `==` 比较，且解锁接口没有次数限制（可离线爆破）。
- 管理员口令用的是 sha256 套 sha256（带每用户 salt），**不是 bcrypt/argon2**：数据库或备份泄露后可以被 GPU 快速爆破。
- 加密文章的解锁接口已有次数限制（同一 IP + 同一文章 10 分钟 20 次），但**其它公开接口仍没有全局限流**。
- Swagger（`/swagger`、`/swagger-json`）默认公开，等于把整个后台 API 面暴露给未登录用户。
- 没有全局 `ValidationPipe`（`class-validator` 不是依赖），参数校验靠各处手写；目前的净化中间件是「黑名单」而不是「白名单」。
- 后台的 `/init` 接口没有守卫，靠「库里有没有用户」判断是否已初始化（初始化窗口内的 TOCTOU）。
- API Token 有效期 100 年，只能靠手动吊销。

::: warning 部署建议

生产环境请务必：设置强管理员密码、通过 HTTPS 访问、不要把 3000/3001 端口直接暴露到公网（用仓库自带的 Caddy 配置）、定期用[整站备份](backup.md)留档，并且**不要把备份文件放在能被 Web 访问到的目录里**。

:::
