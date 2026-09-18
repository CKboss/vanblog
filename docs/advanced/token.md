---
title: API Token 管理
icon: key
---

VanBlog 的后台接口（`/api/admin/**`）除了浏览器登录态，也接受 **API Token** ——
适合脚本、定时任务、CI 与第三方集成这类"没有登录态"的调用方。

你可以在后台的 `系统设置/Token 管理` 里签发、查看与吊销 Token。

![](https://pic.mereith.com/img/8c27dee1b90fca797426c787350599b3.clipboard-2023-03-22.png)

## Token 怎么带

放在请求头 **`token`** 里（⚠️ 不是 `Authorization: Bearer`）：

```bash
curl -H "token: <你的 token>" "https://你的域名/api/admin/article?page=1&pageSize=5"
```

Token 缺失、无效或已过期一律返回 **401**。

## 有效期

- 新签发的 Token 默认有效期 **365 天**，可用 `VANBLOG_API_TOKEN_TTL_DAYS` 调（1 天 ~ 100 年，
  非法值回落 365）。
- ⚠️ 以前默认是 **100 年**（等于永不过期，泄露一次就长期有效）。**已经签发的 Token 不受这次改动影响** ——
  每个 Token 的有效期在签发时就写进库里了；介意的话到后台把它们吊销、重新签发。
- 登录态与 API Token 都存在同一个 `tokens` 集合里，会随[整站备份](./backup.md#整站备份推荐)一起走；
  恢复之后**需要重新登录**（jwt 密钥也来自备份），但 Token 本身跟着备份回来。

## API 文档

运行时的 `/swagger`（Swagger UI）与 `/swagger-json` **默认是关闭的**：它匿名可读，
等于把整个后台 API 面（一百多条路由 + 登录请求的形状）摊给未登录用户。

需要时给容器设 `VANBLOG_SWAGGER=true`（**只认字面 `true`**）并重启，排查完建议关回去。
后台「Token 管理」与「关于」两个页面会先探测 `/swagger-json`：开着就打开 `/swagger`，
关着就提示你该设哪个环境变量、并改开仓库里的接口文档，所以两种状态都不会留下死链接。

> 接口清单与说明见 [API 参考](../reference/api.md)。
