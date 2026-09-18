---
title: API 参考
icon: plug
order: 6
---

这一页**不抄接口清单**（抄一份就会过期一份）：完整清单以运行时生成的 OpenAPI 文档为准（见下面[怎么看完整清单](#怎么看完整清单)）。
这里只写四件不随版本漂移、又最容易踩的事：**怎么鉴权**、**哪些接口不需要登录**、**响应长什么样**、**限流怎么分桶**。

::: warning 实时 swagger 默认是关闭的

`/swagger` **默认关闭**（`VANBLOG_SWAGGER` 只认字面 `true`）：开着等于把整个后台接口面摊给未登录用户，
而 robots 的 disallow 不是访问控制。要用时给容器设 `VANBLOG_SWAGGER=true` 并重启，排查完建议关回去。

后台两个入口的行为**不一样**，别搞混：

- `系统设置 / Token 管理` 里的「API 文档」按钮会**先探一下** `/swagger-json`：开着就打开 `/swagger`，
  关着就提示你该设哪个环境变量、并改开仓库里的这一页（所以不会弹出 404 标签页）。
- 「关于」页的「API 文档」**不探测**，直接指向仓库里的这一页。

:::

## 怎么看完整清单

打开 `VANBLOG_SWAGGER=true` 重启后：

| 地址 | 是什么 |
| --- | --- |
| `/swagger` | Swagger UI，能直接在页面上试调 |
| `/swagger-json` | 机器可读的 OpenAPI JSON（`curl` 下来自己处理） |

::: caution swagger 里的分组标签不能当鉴权依据

swagger 的分组来自代码里的 `@ApiTags`，那是**按模块**分的，不是按"要不要登录"分的。
实际的错位有好几处：匿名可达的健康检查挂在 `PublicHealth` 组、三条匿名初始化接口挂在 `init` 组、
匿名评论接口和**需要登录**的后台评论接口同挂 `comment` 组，而登录 / 登出 / 找回密码三个接口挂在 `tag` 组里
（和标签管理混在一起）。所以**不要**用"某个组是不是叫 public"来判断一条接口要不要登录 ——
照下面[哪些接口不需要登录](#哪些接口不需要登录)那张表判断。

:::

⚠️ 还有三类地址**不在 swagger 里**，因为它们不是接口路由：

| 地址 | 实际是什么 |
| --- | --- |
| `/static/**` | 静态目录（图片、附件、主题 CSS 文件）。⚠️ 其中 `export`、`tmp`、`upload-tmp` 三段匿名一律 403 |
| `/rss/**`、`/sitemap/**` | 也是静态目录（RSS 与站点地图由后台任务生成后写在这里） |
| `/api/revalidate` | 属于**前台**（Next.js）那一侧，不在 server 上 |

## 响应长什么样

成功时统一是一层信封：

```json
{ "statusCode": 200, "data": { } }
```

出错时是 Nest 的形状，`statusCode` 就是 HTTP 状态码，可能附带额外字段。例如未初始化站点上调初始化接口：

```json
{ "statusCode": 400, "message": "本站开启了初始化保护…", "setupKeyRequired": true, "reason": "setupKeyMissing" }
```

::: warning 站点还没初始化时，几乎所有接口都返回 233 而不是报错

这是最容易让人一头雾水的一条：站点**未初始化**期间，除了下面这几个例外，
**所有**请求（包括 `/api/public/**`）都会拿到 HTTP **200**，但响应体是

```json
{ "statusCode": 233, "message": "未初始化!", "data": { "allowDomains": "" } }
```

也就是说：拿到 200 不代表成功，**要看响应体里的 `statusCode`**。看到 233 就说明站点还没走完初始化
（去 `/admin/init` 或用一键脚本），不是你的请求写错了。

例外（未初始化时也能正常用）：`GET /api/public/health`、`POST /api/admin/init`、
`POST /api/admin/init/upload`、`POST /api/admin/init/restore`、`GET /api/admin/caddy/ask`、
`POST /api/admin/img/upload`（这条要登录态，列在这里是因为它同样不受 233 影响）。

:::

## 鉴权

需要鉴权的接口只看**请求头里的 `token` 字段**，`Authorization: Bearer` **不认**
（服务端就是从 `token` 这个头里取 JWT 的）：

```bash
curl -sS http://127.0.0.1/api/admin/article \
  -H 'token: <你的 token>'
```

后台接口（`/api/admin/**`，除下面表格里那几个例外）要过三道检查：

1. **JWT 有效**（签名对、没过期）
2. **这个 token 在库里且没被吊销**
3. **当前账号有这项权限**（协作者的权限范围在后台 `站点管理 / 系统设置 / 用户设置` 里配，
   见 [协作者](../advanced/collaborator.md)）

第 1、2 道不过返回 **401**，第 3 道不过返回 **403**。

token 有两种，都在后台 **系统设置 / Token 管理** 里签发与吊销：

| 类型 | 怎么来 | 有效期 | 权限 |
| --- | --- | --- | --- |
| 登录凭证 | 登录时自动签发，前端存在 LocalStorage 的 `token` 里 | 后台「登录凭证(Token)有效期(秒)」，默认 **7 天** | 登录的是谁就是谁的权限（协作者受限） |
| API Token | 在 Token 管理里手动新建 | 默认 **365 天**（`VANBLOG_API_TOKEN_TTL_DAYS` 可调，见下） | ⚠️ **等于超管**，不受协作者权限限制 |

::: danger API Token 等于把整站交出去

API Token 签出来时身份就是超管，所以它能调**所有** `/api/admin/**` 接口 ——
包括改账号密码、改设置、删文章、导出整站备份。因此：

- 不要写进前台代码、不要提交进仓库、不要贴到聊天里；
- 只想让别人读文章的话，用匿名接口（`/api/public/**`），别发 Token；
- 有效期默认 365 天，`VANBLOG_API_TOKEN_TTL_DAYS` 可调，范围 **1 ~ 36500 天**；
  ⚠️ 填 `0`、填字母、或干脆不设，都会回落成 **365**（不会变成 1 天）；
- 已经签出去的 Token 不受这个变量影响（有效期在签发时就写进库里了），介意就到后台吊销重签。

:::

**什么时候 Token 会突然全部失效**（脚本全线 401 多半是这几条之一）：

| 你做了什么 | 结果 |
| --- | --- |
| 后台保存账号信息 / 改密码 | 吊销**全部** token（含 API Token），约 1 秒后生效 |
| 用日志里的恢复密钥重置密码 | 同上 |
| **修改或删除**一个协作者 | 吊销所有非超管的登录态 —— ⚠️ **API Token 也在这个范围里**，会被一起吊销 |
| 新建一个协作者 | 不影响已有 token |
| 从整站备份恢复 | token 跟着备份回来，但 JWT 密钥是启动时读的 ⇒ **重启一次容器**再重新登录 |
| 在 Token 管理里点吊销 | 只吊销那一个 |

## 哪些接口不需要登录

`/api/admin/**` 里下面这几条是**故意**匿名的，其余全部要鉴权：

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/admin/auth/login` | POST | 登录（失败次数受限：默认同一 IP 5 次 / 300 秒） |
| `/api/admin/auth/restore` | POST | 忘记管理员密码，用日志里的恢复密钥重置 |
| `/api/admin/init` | POST | 初始化向导建管理员（仅未初始化时；**默认要初始化密钥**） |
| `/api/admin/init/restore` | POST | 初始化页直接上传整站备份恢复（仅未初始化时；**默认要初始化密钥**） |
| `/api/admin/init/upload` | POST | 初始化向导里上传 logo / favicon（仅未初始化时；⚠️ **不要求初始化密钥**） |
| `/api/admin/caddy/ask` | GET | caddy 按需签发证书的回调，只批准本站已登记的域名 |

另外这些本来就是公开的：

| 路径 | 说明 |
| --- | --- |
| `/api/public/**` | 前台要用的数据：文章列表与详情、分类 / 标签、时间线、`meta`、搜索、评论、访客统计、主题、健康检查 |
| `/robots.txt` | 搜索引擎用 |
| `/c/<自定义页路径>` | 自定义页面；旧地址 `/custom/<路径>` 会重定向过来 |

⚠️ `/api/public/**` 也不是全无门槛：

- **写操作**（发评论、上报访客）另有一个更紧的桶：默认每 IP 每分钟 30 次，超限 **429**；
- 发评论在这之上还有三把自己的锁，超限返回的是 **400**（不是 429），消息里会写还要等多久：
  每 IP 每 10 分钟若干条（后台「评论设置」里可配，默认 **10**，上限 1000）、
  每 IP 每天 **50** 条、同一 IP 发同样内容 5 分钟内只允许 **1** 条；
- `POST /api/public/article/:id`（输密码解锁加密文章）单独限次：**同一 IP + 同一篇文章 20 次 / 10 分钟**，
  超了返回 **429**。文章 id 会先归一化，所以 `07`、`7.0`、`0x7` 这类写法**不会**各自拿到一份新预算。

`/api/public/health` 有个特例：`status`、`mongo*`、`now`、`version` 匿名可见（版本号本来就渲染在每个前台页脚上），
而 `uptimeSeconds` 与内存字段要带正确的 `x-vanblog-internal` 令牌，或站长显式设 `VANBLOG_HEALTH_DETAILS=true`；
数据库 ping 不通时它返回 **503**（这样容器健康检查才有意义）。

## 限流

| 桶 | 覆盖 | 默认 | 变量 |
| --- | --- | --- | --- |
| 初始化 | `/api/admin/init*`（含 upload / restore） | 每 IP 10 分钟 5 次 | `VANBLOG_INIT_LIMIT_PER_10MIN` |
| 公开写 | `/api/public/**` 的非 GET 请求 | 每 IP 每分钟 30 次 | `VANBLOG_PUBLIC_WRITE_LIMIT_PER_MIN` |
| 静态 | `/static/**` | 全局的 10 倍 | `VANBLOG_STATIC_LIMIT_PER_MIN` |
| 全局 | 其余所有请求（含 `/rss/`、`/sitemap/`、`/swagger`、`/robots.txt`） | 每 IP 每分钟 600 次 | `VANBLOG_RATE_LIMIT_PER_MIN` |

超限返回 **429**，并带一个 **`Retry-After`** 响应头（单位秒，最小 1）—— 写脚本时读它就行，
不用去解析中文消息。响应体是 `{"statusCode":429,"message":"请求过于频繁，请稍后再试"}`。

::: warning 只有"容器内回环直连"才不限流，从宿主机打照样会 429

**豁免的判据是两条同时成立**：socket 是回环地址，**且** 请求里没有 `X-Forwarded-For` / `X-Real-IP`
（`utils/rateLimit.ts` 的 `isLoopbackRequest`）。这是给前台 SSR、waline、ISR 触发这些高频内部调用留的路。

所以：

- 在宿主机上 `curl http://127.0.0.1/api/public/...` —— 走的是发布端口 → caddy → 反代到 server，
  caddy **会加转发头** ⇒ **照常限流**。下面那组实测数字就是这么打出来的。
- 只有 `docker exec` 进容器、直接 curl server 自己监听的端口（不经过 caddy、没有转发头）才会被豁免。

实测（从容器外打匿名 API）：第 **601** 次开始返回 429 并带 `Retry-After`；
而连打 **1200** 次静态资源零 429 —— 静态桶与全局桶是**独立**的，刷图不会把 API 预算吃掉，
反之亦然。原理见 [安全 → 限流](../advanced/security.md)。

:::

计数按**可信客户端 IP** 分桶：只有对端是回环/私网地址时才采信 `X-Forwarded-For`
（`VANBLOG_TRUST_FORWARDED_HEADERS`，默认 `auto`；CDN 或隧道直连源站要设 `always`）。
页面 HTML 不经过这个限流器（缓存命中时压根不进 server），所以"开了直发就绕过限流"是误解。
细节与调优见 [环境变量 → 安全、限流与可观测性](./env.md#安全限流与可观测性)。

## 举例

匿名接口可以直接调。把下面的地址换成你自己的域名（本机排查用 `127.0.0.1` 就行）：

```bash
curl -sS http://127.0.0.1/api/public/article/28
```

看到以 `{"statusCode":200,"data":{...}}` 开头的 JSON 就说明通了。
文章不存在时返回 **404**（说明接口在，只是没这篇文章）；返回 `statusCode: 233` 则是站点还没初始化。

要鉴权的接口带上 `token` 头：

```bash
curl -sS 'http://127.0.0.1/api/admin/article?page=1&pageSize=5' \
  -H "token: $VANBLOG_ADMIN_TOKEN"
```

`./vanblog.sh` 的备份、校验、演练等命令走的就是这条路（`VANBLOG_ADMIN_TOKEN` 环境变量，
或在后台 Token 管理里签发一个 API Token）。详见 [API Token 管理](../advanced/token.md)。
