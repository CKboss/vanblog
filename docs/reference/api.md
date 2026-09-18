---
title: API 参考
icon: plug
order: 6
---

这一页不重复抄接口清单（抄一份就会过期一份）。接口以**运行时生成的 OpenAPI 文档**为准：`public` 标签下的都不需要鉴权，其余都要带 `token` 请求头（见下面的[鉴权](#鉴权)）。

::: warning 实时 swagger 默认是关闭的

VanBlog 的 **`/swagger` 默认是关闭的**（`VANBLOG_SWAGGER` 只认字面 `true`）：
开着等于把整个后台 API 面摊给未登录用户，而 robots 的 disallow 不是访问控制。
需要时给容器设 `VANBLOG_SWAGGER=true` 并重启，用完建议关回去。后台
`系统设置/Token 管理` 与「关于」页的「API 文档」入口会自动探测：关着的时候不会弹出 404，
而是提示如何打开，并改开仓库里的 API 文档。

:::

## API 文档入口

打开 `VANBLOG_SWAGGER=true` 之后：

- swagger 路径： `/swagger`（机器可读的 OpenAPI JSON 在 `/swagger-json`）
- 后台的 `系统设置/Token 管理` 中点击 `API 文档` 也会进入

::: note 以你自己站点的 swagger 为准

接口清单一直在增加（整站备份/恢复、迁移台账、历史版本、回收站、`.mdz` 导入导出、健康检查……），
任何一份写死的清单都会过期。要看当前这一版**确切**有哪些接口，请打开你自己站点的 `/swagger`
（需要先把 `VANBLOG_SWAGGER=true` 打开并重启容器，用完建议关回去）。

:::

举个例子，你可以通过 `GET /api/public/article/:id` 获取某篇文章的 JSON 内容。
把下面的地址换成你自己的域名（本机排查可以直接用 `127.0.0.1`）：

```bash
curl -sS http://127.0.0.1/api/public/article/28
```

看到一段以 `{"statusCode":200,"data":{...}}` 开头的 JSON 就说明通了；
文章 id 不存在时会返回 404，这也是正常的（说明接口在，只是没这篇文章）。

不需要鉴权、可以直接调的公开端点还有：`GET /api/public/health`（健康检查，数据库 ping 不通
返回 503，见 [快速上手 → 验证清单](../guide/get-started.md#装完之后验证清单)）、
`GET /api/public/search`（全文搜索，参数 `value`）等。

## 鉴权

需要鉴权的接口都看**请求头里的 `token` 字段**（不是 `Authorization: Bearer`）：

```bash
curl -sS http://127.0.0.1/api/admin/article \
  -H 'token: <你的 token>'
```

后台接口（`/api/admin/**`）要过三道检查：**JWT 有效** → **这个 token 在库里且没被吊销** →
**当前账号有这项权限**（协作者的权限范围在后台「用户设置」里配）。任一道不过都是 `401` / `403`。

token 有两种，都在后台 **系统设置 / Token 管理** 里签发与吊销：

| 类型 | 怎么来 | 有效期 | 用途 |
| --- | --- | --- | --- |
| 登录凭证 | 登录时自动签发，前端存在 LocalStorage 的 `token` 里 | 「登录凭证(Token)有效期(秒)」，默认 7 天 | 后台界面 |
| API Token | 在 Token 管理里手动新建 | 默认 365 天（`VANBLOG_API_TOKEN_TTL_DAYS` 可调） | 脚本、CI、`./vanblog.sh backup` 这类免交互调用 |

⚠️ 在后台保存账号信息或**改密码**会吊销**全部** token（含 API Token），脚本会开始 401，
需要重新签发，见 [登录安全策略](./secure.md#凭证什么时候会立刻失效)。

## 不需要鉴权的接口

`/api/public/**` 是匿名的（文章列表与详情、分类 / 标签、时间线、`meta`、搜索、健康检查等），
`public` 标签下就是这一批。其中**写操作**（评论、访客统计）另有一个更紧的限流桶
（默认每 IP 每分钟 30 次），全部阈值见 [环境变量 → 安全、限流与可观测性](./env.md#安全限流与可观测性)。

两条**匿名初始化**接口是例外中的例外 —— `POST /api/admin/init`（走向导建管理员）与
`POST /api/admin/init/restore`（初始化页直接上传整站备份）只在**站点还没初始化**时开放，
且默认要求携带**初始化密钥**（字段 `setupKey`，密钥在日志目录的 `setup.key` 与启动日志里），
见 [初始化](../guide/init.md#初始化密钥setup-key)。
