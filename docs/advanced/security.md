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
| `VANBLOG_RATE_LIMIT_PER_MIN` | `600` | 每 IP 每分钟的全局请求上限（兜底限流，挡扫描器与失控客户端） |
| `VANBLOG_PUBLIC_WRITE_LIMIT_PER_MIN` | `30` | 每 IP 每分钟对 `/api/public/**` 写操作（POST/PUT/DELETE）的上限 |
| `VANBLOG_INIT_LIMIT_PER_10MIN` | `5` | 每 IP 每 10 分钟对 `/api/admin/init*` 的调用上限 |
| `VAN_BLOG_INTERNAL_TOKEN` | 空 | 前后端分离部署时的内部令牌：带上 `x-vanblog-internal: <token>` 的请求才允许 `pageSize=-1`（一体式镜像里回环直连自动放行，不需要设） |
| `VANBLOG_API_TOKEN_TTL_DAYS` | `365` | 新签发 API Token 的有效期（天）。原来是 100 年，等于永不过期；已签发的 token 不受影响 |

## 口令存储：scrypt（登录时自动迁移）

管理员与协作者的口令以前是 `sha256(sha256(username + 浏览器端派生值) + salt + sha256(username + salt))`。
纯 sha256 是**快哈希**：拿到库（或整站备份）之后可以用 GPU 每秒试几十亿次。现在改成 **scrypt**
（`N=16384, r=8, p=1`，每次校验要吃 16MB 内存），存储格式自描述：

```
scrypt$16384$8$1$<salt base64>$<hash base64>
```

- **迁移是透明的**：校验函数同时认新格式与旧格式，登录成功时顺手把旧哈希升级成 scrypt
  （`UserProvider.updateSalt()` 本来就每次登录轮换盐）。用户不需要改密码，也不用停机跑脚本。
- 客户端不用改：scrypt 的输入仍然是浏览器端派生出来的那个值。
- 新建用户、改密码、建/改协作者、「忘记密码」恢复通道都直接写 scrypt。
- 只有一处仍是旧格式：`washUserWithSalt()`（把更老的「无盐」数据洗成带盐的）。它的输入是
  **上一代服务端哈希**，拿不到浏览器端派生值，没法直接换；等该用户下次登录成功就会自动升级。
- 校验时会检查 scrypt 参数上限（`N ≤ 2^20`、`128*N*r ≤ 64MB`）：库被改过也不至于构造出
  一个让进程 OOM 的哈希。
- 空口令一律拒绝（空哈希曾经等于「空密码可登录」）。

## 后台渲染日志：ANSI 转 HTML 必须转义

后台「日志管理 → 系统日志」把日志文本经 `ansi-to-html` 转成带颜色的 HTML，再用
`dangerouslySetInnerHTML` 塞进 `<code>`。这个库的 `escapeXML` **默认是 `false`** ——
也就是日志里的 `<`、`>`、`&` 会原样成为标签。而日志里完全可能出现访客可控的字符串
（404 的路径、上传的文件名、评论作者、子进程输出里的 URL），于是这就是一条
**存到后台的 XSS**：谁打开那个页面谁中招，而后台 token 就放在 localStorage 里，
等于把管理员会话交出去。

现在组件显式用 `new convert({ escapeXML: true })`：ANSI 颜色照常渲染（这本来就是它的用途），
尖括号变成实体。测试里除了断言源码写了这个选项，还**用真库跑了一遍**：
`<img src=x onerror=alert(1)>` 必须变成 `&lt;img …`，同时默认配置的对照组必须仍然漏出真标签
（证明这个修复不是白改的）；另有一条断言盯着"全后台只允许这一处
`dangerouslySetInnerHTML`"，以后谁再加第二处就会被逼着想清楚"这里的数据是谁写的"。

## 限流

| 范围 | 默认 | 环境变量 |
| --- | --- | --- |
| 登录 | LoginGuard（既有） | — |
| 加密文章解锁 | 同 IP + 同文章 10 分钟 20 次 | — |
| 发表评论 | 10 分钟 N 次 + 每天 50 次 + 同内容 5 分钟 1 次 | 后台「评论设置」 |
| `/api/admin/init*` | 10 分钟 5 次 | `VANBLOG_INIT_LIMIT_PER_10MIN` |
| `/api/public/**` 写操作 | 每分钟 30 次 | `VANBLOG_PUBLIC_WRITE_LIMIT_PER_MIN` |
| 全局兜底 | 每分钟 600 次 | `VANBLOG_RATE_LIMIT_PER_MIN` |

两条设计原则：

- **容器内部回环直连放行**（前台 SSR、waline、ISR 触发都要高频调公开接口）。判据要求
  「socket 是回环 **且** 请求里没有 `X-Forwarded-For` / `X-Real-IP`」—— 经过 caddy/nginx
  转发的一定带转发头，所以反代后面的真实客户端不会被误放行。
- **fail-open**：限流组件自己抛错时放行。宁可少挡一次，也不能因为一个计数器把整站变成 500。

命中限流返回 `429` 并带 `Retry-After`。

## 其它加固

- **安全响应头**（caddy 模板对**所有**响应下发，Nest 中间件对 `/api/**`、`/static/**` 也下发；
  `set` 是覆盖不是追加，所以不会重复）：`X-Content-Type-Options: nosniff`、
  `X-Frame-Options: SAMEORIGIN`（不是 DENY：后台要 iframe 同源的 waline `/ui`）、
  `Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`，并隐藏 caddy 的 `Server` 头。
- **`pageSize=-1` 收敛**：公开文章列表以前允许任何人一次性把**全部文章连正文**拉走
  （一个现成的拖库 + 打爆内存按钮）。现在只有内部调用（回环直连，或带
  `x-vanblog-internal: <VAN_BLOG_INTERNAL_TOKEN>`）可以，其它一律夹到 `MAX_PAGE_SIZE`。
  前台静态生成走的是容器内回环，一体式部署不需要任何配置；前后端分离部署时给两边配同一个
  `VAN_BLOG_INTERNAL_TOKEN` 即可。
- **API Token 有效期**：原来是 **100 年**（等于永不过期，泄露一次长期有效）。新签发的默认 1 年，
  可用 `VANBLOG_API_TOKEN_TTL_DAYS` 调；已签发的 token 不受影响（各自的 `expiresIn` 已经写在库里），
  需要的话在后台吊销。
- **文章解锁的密码比较改成常量时间**（原来的 `!==` 会因短路泄露长度/前缀信息），
  并且同时支持明文（历史数据）与 scrypt 哈希。

## 已知限制（尚未处理）

- **文章 / 分类的访问密码仍是明文存储**。校验已经常量时间、解锁接口已限次，但没有直接换成哈希：
  后台「修改信息」表单会把存着的密码**回填到输入框**，改成哈希就必须同时改前端语义
  （留空 = 不修改），否则会把密码改成哈希串、或把文章意外解锁。要做就得前后端一起改。
- **没有 CSP**。前台/后台都有大量内联样式、bytemd 注入的脚本与可选的第三方统计，
  严 CSP 会直接把站点搞坏，松 CSP 又等于没有；要做必须先给内联样式发 nonce（`next/script` 也要一并改）。
- **没有全局 `ValidationPipe`**（`class-validator` 不是依赖），参数校验靠各处手写；
  请求净化中间件是「黑名单」而不是「白名单」。
- `/api/admin/init` 仍然靠「库里有没有用户」判断是否已初始化（初始化窗口内的 TOCTOU），
  现在只有 10 分钟 5 次的限流兜着。
- `/swagger` 默认公开（可用 `VANBLOG_SWAGGER=false` 关闭），等于把整个后台 API 面摊给未登录用户。
- ~~`/post/<数字id>` 与 `/post/<别名>` 都返回 200，没有 canonical / 301~~ —— **已经修好了**：
  数字 id 现在 308 跳到拼音别名，页面也带 `link rel="canonical"`，阅读量按规范化后的 pathname 统计。
  见 [SEO](./seo.md)。
- ~~website 的 `__tests__` 里还有约 27 个类型错误~~ —— **已经清干净了**：`tsc --noEmit` 在
  `packages/website` 上报的 115 个错误全部来自本机 `~/node_modules/bun-types`（TS 4.9 解析不了它的
  新语法，见 AGENTS §3.6），仓库代码本身 0 个类型错误。

::: warning 部署建议

生产环境请务必：设置强管理员密码、通过 HTTPS 访问、不要把 3000/3001 端口直接暴露到公网（用仓库自带的 Caddy 配置）、定期用[整站备份](backup.md)留档，并且**不要把备份文件放在能被 Web 访问到的目录里**。

:::
