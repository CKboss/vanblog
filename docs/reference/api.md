---
title: API 参考
icon: plug
order: 6
---

目前还没写专门的 API 参考，但是可以用生成的 `swagger` 做为参考。其中 `public` 标签下的都是不需要鉴权的。

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

所有需要鉴权的接口是通过 `请求头` 中 `token` 字段鉴权的，你可以在后台的 `系统设置/Token 管理` 中进行管理。
