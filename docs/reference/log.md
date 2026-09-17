---
title: 日志
icon: file-lines
order: 5
---

VanBlog 现在已上线登录日志、系统日志和流水线日志，可以在后台日志管理中查看。后台拉取这些记录走 `GET /api/admin/audit`（不再用会被广告拦截列表误杀的 `/api/admin/log`）。旧路径仍可用。

登录日志里的访客 IP：若请求带有 Cloudflare 的 `CF-Connecting-IP`（或常见的 `True-Client-IP`），会优先用它，而不是反代 / 边缘节点写在 `X-Real-IP`、`X-Forwarded-For` 里的地址。没有这些头时仍按原来的 `X-Real-IP` → `X-Forwarded-For` → 套接字地址解析，并跳过内网和回环地址。

![日志管理](https://pic.mereith.com/img/a76cceb104214002da3c0c92d592bfff.clipboard-2023-06-26.webp)

所有日志在容器内的位置如下（`/var/log` 就是你映射出来的日志目录）：

- access 日志： `/var/log/vanblog-access.log`（默认关，`VANBLOG_ACCESS_LOG=true` 打开）
- caddy 运行日志: `/var/log/caddy.log`
- 前台构建器运行日志: `/var/log/vanblog-website.log`
- 审计/事件日志（登录、安装记录等）: `/var/log/vanblog-event.log`
- API 服务器运行日志: `stdout`
- 忘记密码的恢复密钥: `/var/log/restore.key`（每次启动重新生成，见 [忘记密码](../faq/password.md)）
- 初始化密钥（站点未初始化期间）: `/var/log/setup.key`（0600，初始化成功后自动删除，见 [初始化](../guide/init.md#初始化密钥setup-key)）
- 整站备份归档: `/var/log/vanblog-backups/`（旁边是 `.manifest.json` 清单、`.sha256` 校验和与
  `backup-status.json` / `vanblog-verify-log.jsonl` 两份校验状态记录，见 [导入导出](../advanced/backup.md)）

::: tip 事件日志会轮转

`vanblog-event.log` 按大小轮转：单份上限 `VANBLOG_EVENT_LOG_MAX_MB`（默认 20MB）×
（保留份数 `VANBLOG_EVENT_LOG_KEEP` + 1，默认 3+1）≈ 80MB 上界，超限时轮转**改名**为
`.1` / `.2` / `.3`。这个文件以前只增不减，跑久了会吃满磁盘（磁盘满的表现是「备份写不出来、
图片存不进去、mongod 变只读」，很难想到根因是日志）。容器 stdout 那一份由编排的
`logging.max-size` 管，两套是分开的。后台「日志管理」单次读取有行数/字节上限
（`VANBLOG_LOG_SCAN_MAX_LINES` / `VANBLOG_LOG_SCAN_MAX_BYTES`），超大日志只显示最新一段。

:::

## 迁移台账（migrations）

除了日志文件，server 还维护一个**迁移台账**：每一项「对已有数据的自动修复」（统计行去重、
补建唯一索引、明文访问密码洗成 scrypt、按保留期清理统计……）都会在 `migrations` 集合里
记一行：做了什么、影响多少条、什么时候、成功还是跳过。本站是**怎样被初始化的**
（向导 / 上传备份恢复 / 环境变量零接触，含时间与来源 IP）也会记一条 `install:initialised`，
后台欢迎页（数据概览）顶部的横幅显示的就是它 —— 万一哪天发现「站点被人抢先初始化了」，
这里是第一个该看的地方（老站点升级上来的没有这一行，横幅不显示）。

台账可以通过 `GET /api/admin/migration/list`（管理员鉴权）读取。
