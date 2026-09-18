---
title: 评论
icon: comments
order: 4
---

VanBlog 现在支持**两套**评论系统，在后台 `站点管理 / 系统设置 / 评论设置` 里三选一：

| 模式 | 说明 |
| --- | --- |
| **内置评论**（builtin） | 评论存在本站的 Mongo 里，走本站接口，不需要额外进程 / 端口 / 数据库。**全新安装默认用它** |
| **Waline** | 外挂的第三方评论系统：server 会拉起一个 waline 子进程（端口 8360，独立的 `waline` 库），前台用 `@waline/client`，后台评论页是它的 `/ui` iframe。功能最全（邮件通知、点赞、验证码），代价是多一个常驻进程 |
| **关闭**（off） | 前台不渲染任何评论区 |

评论总开关仍在 `站点管理/系统设置/站点配置/高级设置`。

![评论系统开关](https://pic.mereith.com/img/4ab797b4096a953d9d27ebf6a4a2b0dc.clipboard-2022-08-25.png)

::: warning 老站点升级 / 切换模式

- 升级上来、还没有这条设置的站点**默认按 Waline 处理**，已有评论不会消失。
- 切换模式**不迁移数据**：内置评论在 `vanBlog` 库的 `nativecomments` 集合，Waline 在独立的 `waline` 库。
  切过去老评论就不显示了（数据还在，切回来就还在）。
- 切到内置或关闭时，waline 子进程会被停掉（省一个常驻 node 进程和 8360 端口）；切回 Waline 会自动拉起。

:::

## 内置评论

### 内置评论有什么

- 两层结构：顶层评论 + 回复（回复「回复」也归到同一个顶层，显示成「回复 @某人」）
- 分页加载（每页 20 条，「加载更多」往下翻）
- 昵称 / 邮箱 / 个人主页，浏览器本地记住（只记这三项，不记评论内容）
- 基础 Markdown：**粗体**、*斜体*、`行内代码`、代码块、引用、列表、链接、删除线
- 评论数显示在文章卡片的元信息行（批量取，一屏十几篇也只发一个请求）
- 博主标识：邮箱与站点信息里的 `authorEmail` 一致的评论会打上「博主」标签，并且直通审核
- 深色模式与 Apple 风格皮肤都已适配

### 审核

后台可选三种策略：

| 策略 | 行为 |
| --- | --- |
| `先发后审`（默认） | 直接显示；命中规则自动转「待审」，后台放行后才出现 |
| `先审后发` | 全部先待审 |
| `不审核` | 全部直接显示，只提供删除 |

「先发后审」下会自动转待审的情况：

- 命中后台配置的**关键词**（大小写不敏感，最多 200 个）
- 内容里含**外链**（可在设置里关掉这条规则）
- 蜜罐字段被填写 → 直接判**垃圾**（对用户仍显示「待审」，不暴露判定逻辑）

### 反垃圾与限流

| 措施 | 默认值 |
| --- | --- |
| 同 IP 每 10 分钟最多 | 10 条（设置里可调，上限 1000） |
| 同 IP 每天最多 | 50 条 |
| 同 IP + 同内容 5 分钟内 | 只允许 1 条 |
| 单条长度 | 2000 字（设置里可调，上限 20000） |
| 蜜罐字段 | 有（视觉上不可见、不可聚焦、读屏也读不到） |
| 演示站 | 禁止发表评论 |

评论只能发在**真实存在且未隐藏**的文章下（路径会去库里核对），所以机器人没法靠编造路径灌库。

### 安全

评论是**匿名任何人**都能写的内容，所以渲染链路比正文严格得多：

1. **原始 HTML 根本不被解析**：渲染器不开 `allowDangerousHtml`，`<b>x</b>` 会按字面量显示。
   同时 html 节点会被转成文本节点（remark-rehype 默认是直接丢弃，那样用户写的东西会凭空消失）。
2. **严格白名单**（`utils/commentSanitize.ts`）：只留排版标签，**没有 `img`**（防追踪像素/钓鱼图）、
   没有 `iframe`/`style`/`svg`/`math`/`form`/`input`/`button`，`script`/`style` 等连内容一起丢掉；
   属性只允许 `a` 的 `href/title/rel/target` 与代码高亮需要的 `className`，**没有 `style`、没有 `id`、没有 `data-*`**。
3. **链接加固**：所有评论里的链接统一 `target="_blank"` + `rel="nofollow noopener noreferrer"`
   （防 tab-nabbing，也不给评论区传 SEO 权重）；协议只允许 `http/https/mailto`。
4. **服务端再校验一遍**（不信任前端）：路径必须 `/` 开头且不含 `..`；昵称剥掉尖括号与控制字符；
   邮箱校验格式；个人主页**显式拒绝任何非 http/https 的 scheme**（`javascript:`、`data:`、`vbscript:`…，
   不依赖 `new URL()` 碰巧解析失败）；内容拒绝控制字符、剥掉双向控制符（U+202A~202E、U+2066~2069，
   防 RLO 伪装昵称与链接）、限长。
5. **不泄露隐私**：公开接口的返回里**没有** `email` / `ip` / `ua` / `reason`；这些只在后台可见。
   昵称与主页在组件里一律当文本渲染，主页链接只在客户端再校验一次 `^https?://` 才变成 `<a>`。
6. **反注入**：所有进 Mongo 的字段都做了类型收敛（对象型入参会被拒），后台的关键词搜索会转义正则元字符，
   排序字段只接受白名单值。

### 接口

公开（无需登录）：

```
GET  /api/public/comments/setting            # provider / moderation / requireEmail / maxContentLength
GET  /api/public/comments?path=&page=&pageSize=&sort=
GET  /api/public/comments/counts?paths=/post/a,/post/b
POST /api/public/comments                    # { path, parentId?, nick, email?, site?, content, hp? }
```

后台（需要管理员 token）：

```
GET    /api/admin/setting/comment            # 完整设置（含关键词）
PUT    /api/admin/setting/comment            # 切换模式时会自动启停 waline 子进程
GET    /api/admin/comment?status=&path=&keyword=&page=&pageSize=
GET    /api/admin/comment/counts
PUT    /api/admin/comment/:id                # { status?, content?, nick?, isAuthor? }
DELETE /api/admin/comment/:id                # 删顶层会连带删它的回复（软删）
```

### 从 Waline 导入历史评论

后台接口 `POST /api/admin/comment/import/waline`（需要管理员 token）可以直接吃 Waline 导出的 JSON，
支持三种形状：

1. VanBlog 的 waline 备份文件：`{ type:'waline', tables:[...], data:{ Comment:[...] } }`
2. `{ Comment: [...] }`
3. 裸数组 `[...]`

行为约定：

| 项 | 说明 |
| --- | --- |
| **默认只导入正式显示的** | 只导 `status === 'approved'`；waline 的 `waiting` / `spam` 默认跳过。要一起导就传 `{ payload, includeNonApproved: true }`，它们会映射成 `pending` / `spam`，**不会**混进公开列表 |
| **幂等** | 按 waline 的 `objectId`（存成 `sourceId`）去重，同一份文件重复导入不会翻倍 |
| **保留原始时间** | `insertedAt` → `createdAt`，导入后时间线顺序不变（否则全变成"刚刚"） |
| **保留点赞数** | waline 的 `like` → `likeCount`（本站暂时没有点赞 UI，只是不丢数据） |
| **两层结构** | waline 的 `rid`（根）/ `pid`（直接父级）映射成本站的数字 id，回复关系保留 |
| **走同一套校验** | 导入不是绕过后门：路径、昵称、内容、控制字符、双向控制符一样要过 |
| **容错** | 历史数据里邮箱格式不合法很常见 —— 只清空邮箱，**不丢整条**评论；主页地址坏了同理 |
| **data: 图片会折叠** | 老 waline 里把截图直接塞成 base64 的评论（一条几十 KB），导入时折叠成 alt 文本；反正评论白名单里没有 `img`，前台本来也只会显示字面量 |
| **不要求文章存在** | `/link`、`/about` 这类页面的历史评论也能进来（本站发表评论才要求文章真实存在） |
| **dryRun** | 传 `{ payload, dryRun: true }` 只统计不写库，先看看会导入多少条 |

```bash
# 先空跑看看
curl -X POST "$BASE/api/admin/comment/import/waline" -H "token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{"payload": $(cat waline.json), "dryRun": true}"
# 正式导入
curl -X POST "$BASE/api/admin/comment/import/waline" -H "token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{"payload": $(cat waline.json)}"
```

返回：`{ total, imported, skippedNotApproved, skippedDuplicate, skippedInvalid, dryRun, errors[] }`。

::: tip 导入后记得切换模式

导入只是把数据写进内置评论表；前台要显示，还得在「评论设置」里把模式切到**内置评论**。
反过来，切回 Waline 也随时可以 —— 两边数据互不覆盖。

:::

### 导出评论

`GET /api/admin/comment/export`（需要管理员 token）：

- **默认只导出正式显示的（`status=approved`）**，待审 / 垃圾 / 已删除不导出；
- 要全部就传 `?status=all`，也可以传 `pending` / `spam` / `deleted` 单独导某一类；
- 加 `?download=1` 会带附件头，浏览器直接存成 `vanblog-comments-<status>-<时间>.json`；
- 导出是**管理视角**的字段（含 email / ip / ua / status / source / sourceId），所以这个接口在管理员鉴权后面，不要把它暴露到前台。

### 备份会不会带上评论？

会。整站备份（`/api/admin/backup/full/export` 或 `scripts/vanblog.sh backup`）是按
`db.collections()` **动态枚举**所有集合的，所以内置评论的 `nativecomments` 自动就在里面；
同时 waline 那个库也会一起备（`waline.Comment` / `waline.Users`），静态目录一起打包。
清单（`*.manifest.json`）里能看到每个集合的条数与字节数。

::: warning 备份与导出的区别

**备份包含所有状态**的评论（含待审 / 垃圾 / 已删除）—— 备份就该是完整的，否则恢复之后数据就少了。
只想要"正式显示的评论"用的是上面的 **export** 接口（默认 `approved`）。

:::

### 相关环境变量

评论本身不需要额外环境变量。选 Waline 时它会照旧用 `waline.db` 配置与站点信息里的 SMTP 设置。

## Waline（外挂）

### 配置

您可以在后台 `站点管理/系统设置/评论设置` 中对评论的一些功能进行配置：

![评论设置](https://www.mereith.com/static/img/4b0725013bd8cd940995e383ba83e527.clipboard-2022-09-01.png)

### 强制登录后评论

开启「是否强制登录后评论」后：

- 访客必须先注册 / 登录 **Waline 评论账号** 才能发表评论（这不是后台管理员登录）。
- 未登录的匿名评论会被服务端拒绝，前台评论框也会隐藏匿名输入项。
- 保存后会立即把配置传给内嵌 Waline 并重启评论进程，无需再手动重启 VanBlog。

### 消息通知

内嵌的评论系统可以通过邮件或者 `webhook` 进行消息通知，具体来说：

- 当有新评论时会根据表单中的 `博主邮箱`，对博主进行通知。
- 当某人的评论被回复时，会通过这个人在评论时所写的邮箱进行通知。
- 通知时的站点名称和站点地址取自 `站点管理/系统设置/站点配置` 。

VanBlog **没有单独的邮件系统**。通知走的是内嵌 [Waline](https://waline.js.org/) 的 SMTP，全部在后台 `站点管理 / 系统设置 / 评论设置` 里改。

### 更换通知邮箱

整了自定义域名邮箱（如 `noreply@yourdomain.com`），或想把通知从 QQ 邮箱换成这个域名邮箱时，**不用另外部署**，还是改同一张表单：

1. 后台进入 **站点管理 / 系统设置 / 评论设置**。
2. 开启 **是否启用邮件通知**。
3. 填写邮箱服务商的 SMTP（不是博客域名）：
   - **SMTP 地址 (host)**：服务商 SMTP，例如 `smtp.exmail.qq.com`、`smtp.gmail.com`，或自定义域名邮箱后台给出的 `smtp.xxx.com`。
   - **SMTP 端口号**：常见 `465`（SSL）或 `587`（STARTTLS）。
   - **SMTP 用户名**：一般是完整邮箱，例如 `noreply@yourdomain.com`。
   - **SMTP 密码（授权码）**：多数不是登录密码，而是 SMTP **授权码 / 应用专用密码（App Password）**。需要先在邮箱后台开启 SMTP 再生成。
4. **博主邮箱（通知收件人）**：有新评论时发到这个地址。可以填自定义域名邮箱，也可以和发件地址不同（例如用域名邮箱发信、用常用邮箱收信）。
5. **发件人显示名称**：收件箱里显示的 From 名称，可填站点名。
6. **发件地址（From）**：填自定义域名邮箱。多数服务商要求它与 **SMTP 用户名** 一致，否则可能报 `501 Mail from address must be same as authorization user`。
7. 保存后会立刻把配置传给内嵌 Waline 并重启评论进程。若仍不发信，可再重启一次 VanBlog。

三种地址可以这样理解：

| 字段 | 作用 |
| --- | --- |
| SMTP 用户名 | 登录发信服务器的账号 |
| 发件地址（From） | 收件人看到的发件邮箱，自定义域名邮箱填这里 |
| 博主邮箱 | 站长自己收「有新评论」通知的收件箱 |

最简单的做法是三个都填同一个自定义域名邮箱。Waline 服务端对应的环境变量说明见 [评论通知](https://waline.js.org/guide/features/notification.html) 和 [服务端环境变量（邮件）](https://waline.js.org/reference/server/env.html)；VanBlog 会从本表单映射过去，一般不必自己设环境变量。

常见问题见 [如何更换评论系统通知邮箱](../faq/usage.md#如何更换评论系统通知邮箱)。

### 配置邮件消息通知

选择 `是否启用邮件通知` 后，会出现一些表单，必填项就是开启邮件消息通知所必需的。

和 `SMTP` 有关的四项需要您在自己的邮件服务商处获取。

::: details 例子

以 QQ 邮箱为例，进入后台的设置页面，可以找到下面的内容：

![QQ 邮箱](https://www.mereith.com/static/img/3a0157c13c7ed53b5f3a7c360f23c61c.clipboard-2022-09-01.png)

很多邮件服务商会**默认关闭 SMTP**，你需要先开启才行！

:::

点击官方的帮助文档，可以获取到相应的内容，填入即可。拿我来说，我就这样写的：

![](https://www.mereith.com/static/img/c55b4837910d893d4431543304ac0585.clipboard-2022-09-01.png)

> 参数说明（以QQ邮箱为例）：
>
> - **SMTP 地址(host)**：个人邮箱可使用 `smtp.qq.com` ，企业邮箱可使用 `smtp.exmail.qq.com`
> - **SMTP 端口号**：`465` 或 `587`
> - **SMTP 用户名**：发送邮件的邮箱地址，即你的QQ邮箱地址
> - **SMTP 密码（授权码）**：生成的授权码（需要在QQ邮箱设置中生成）
> - **发件人显示名称**：不重要，自定义即可
> - **发件地址（From）**：需要与 **SMTP 用户名** 一致，否则发送邮件时可能报错`501 Mail from address must be same as authorization user`。
>
> 附上QQ邮箱官方说明：[QQ邮箱 SMTP/IMAP服务](https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/authorizationCode)、[腾讯企业邮 常用邮件客户端软件设置](https://service.exmail.qq.com/cgi-bin/help?subtype=1&id=28&no=1000564)

当我（博主）收到评论时邮箱中会显示：

![](https://www.mereith.com/static/img/d57d80bd5c8a3459142066c039fc386c.clipboard-2022-09-01.png)

当某人的评论得到了回复，他的邮箱也会显示：

![](https://www.mereith.com/static/img/ac9a19cc271e76b0b09159884cb54e63.clipboard-2022-09-01.png)

::: tip 提示

如果配置好但邮件通知不生效的话，请检查一下密码是否正确，很多服务商需要申请独立授权码以用作 SMTP 密码。

如果还是不生效，可以尝试一下重启 VanBlog，可能会解决问题。

:::

### 配置 webhook 消息通知

VanBlog 内嵌的评论系统支持在有新评论时发送 `webhook`，配置好 `webhook` 接收地址后，会发送一条 `POST` 请求，具体包含以下请求体（JSON 格式）：

```json
{
  "type": "new_comment",
  "data": {
    "comment": {
      "link": "https://blog.example.com",
      "mail": "someone@example.com",
      "nick": "读者昵称",
      "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36",
      "url": "/",
      "comment": "评论测试",
      "ip": "::ffff:203.0.113.7",
      "insertedAt": "2022-09-01T05:52:26.233Z",
      "status": "approved",
      "objectId": "6310489b4e92ac0784a13669",
      "rawComment": "评论测试"
    }
  }
}
```

## 外部数据库 / Atlas

内嵌 Waline 与主站共用 `VAN_BLOG_DATABASE_URL`，评论数据写在 `VAN_BLOG_WALINE_DB`（默认 `waline`）。

- 默认 docker-compose 本地 Mongo 仍使用 `authSource=admin`。
- 如果你提供了完整连接串，Waline 会沿用其中的 `authSource`，不再写死 `admin`。
- MongoDB Atlas（`*.mongodb.net`）在 URL 未指定 `authSource` 时不会再追加 `authSource=admin`。需要时请把 `authSource` 写进连接串，和主库一样。

## 自定义环境变量

后台 `站点管理 / 系统设置 / 评论设置` 最下方的「自定义环境变量」是一个 JSON 对象，保存后会立刻重启内嵌 Waline。

两类键会分别生效：

- **服务端环境变量**（大写，见 [Waline Server 文档](https://waline.js.org/reference/server.html)）：例如 `IPQPS`（同一 IP 每分钟请求数，默认已是 `60`）。会作为字符串写入 Waline 进程环境变量。
- **客户端选项**（见 [Waline Client 文档](https://waline.js.org/reference/client/props.html)）：例如 `imageUploader: false` 会传给前台 `@waline/client`，用来关掉评论框图片上传。这一项以前只写进了服务端环境，前台看不到，所以会表现为「设置了但不生效」。

```json
{
  "imageUploader": false,
  "IPQPS": 60
}
```

注意：

- 布尔值请写 `false` / `true`，不要写成字符串 `"false"`（虽然现在会自动转换）。
- 可以带 `//` 行注释；必须是一个 JSON **对象**。
- `LOGIN` 仍由「是否强制登录后评论」开关控制，自定义变量里的 `LOGIN` 不会覆盖该开关。

## 原理

在后端的 server 中内嵌了控制 `waline.js` 启动停止的服务，后台页面中暂时使用 `iframe` 内嵌 Waline 管理页面，后续会考虑陆续替换成自己的评论实现。

![评论管理](https://pic.mereith.com/img/dd7792a91f5a3b945ee2b261b06f666a.clipboard-2022-08-25.png)

配置信息也会由后端的服务生成，传递给 `waline.js` 中，具体采用了 `node` 的 `child_process` 模块。

具体可以看 `packages/server/src/provider/waline/waline.provider.ts` 的代码。

### 忘记 waline 管理员密码：`scripts/reset-waline.sh`

```bash
scripts/reset-waline.sh --generate          # 生成强随机密码（24 位，约 143 bit），**只显示一次**
scripts/reset-waline.sh --password '你的新密码'   # 或自己提供（也可用 WALINE_NEW_PASSWORD 环境变量）
scripts/reset-waline.sh --generate --yes     # 跳过确认（cron / 脚本里用）
```

它会把 waline 库里**所有** `type: 'administrator'` 的账号密码改掉，所以改之前会打印引擎、容器、
数据库名与将被修改的管理员行数，并要求你输入 `yes` 确认（`--yes` 或 `WALINE_RESET_YES=1` 可跳过；
标准输入是 EOF 时**直接拒绝**而不是挂住）。**邮箱默认不动**，需要一起改才加 `--email <地址>`。
密码哈希在本地算好（依次尝试 python3-bcrypt → htpasswd → 仓库自带的 bcryptjs；都没有就**拒绝运行**，
绝不退回明文或某个已知哈希），明文只在更新成功后打印一次，不进数据库、不进日志。
一个管理员都没有时报错退出（不会假装成功）。

> ⚠️ **如果你跑过 2026-09 之前的旧版脚本，请把那个密码当成已经泄露**：旧版把密码哈希**硬编码在仓库里**
> （`$2a$08$…`，成本因子 8，可离线爆破），还会把邮箱一并改成 `admin@admin.com`。
> 那个哈希在公开的 git 历史里，删不掉 —— 所以任何用旧版设置过的 waline 管理员密码都应视为已知，
> 请用上面的命令重新设一次。
