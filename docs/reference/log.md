---
title: 日志
icon: file-lines
order: 5
---

后台 **站点管理 / 日志管理** 里可以看三类记录：**登录日志**、**系统日志**与**流水线日志**。后台拉取它们走 `GET /api/admin/audit` —— 早先用的 `/api/admin/log` 会被不少广告拦截列表按"路径里带 log"误杀，所以换了名字；旧路径仍然可用，老脚本不用改。

登录日志里的访客 IP：若请求带有 Cloudflare 的 `CF-Connecting-IP`（或常见的 `True-Client-IP`），会优先用它，而不是反代 / 边缘节点写在 `X-Real-IP`、`X-Forwarded-For` 里的地址。没有这些头时按 `X-Real-IP` → `X-Forwarded-For` → 套接字地址解析，并跳过内网和回环地址。

⚠️ 这套取值**只用于日志归属**：上面几个头客户端都能自己伪造，所以限流与防爆破用的是另一套判定
（默认只在「对端是回环 / 私网」时才采信 `X-Forwarded-For` 的**最右一跳**），见
[`VANBLOG_TRUST_FORWARDED_HEADERS`](./env.md#安全限流与可观测性) 与 [反代](./reverse-proxy.md)。
换句话说：日志里的 IP 可能被人写假，但它**不会**因此放宽任何限制。

![日志管理](https://pic.mereith.com/img/a76cceb104214002da3c0c92d592bfff.clipboard-2023-06-26.webp)

## 日志目录里都有什么

`/var/log` 就是你映射出来的日志目录（环境变量 `VAN_BLOG_LOG` 可改；一键脚本部署时对应宿主机的
`<数据目录>/log`，默认 `/var/vanblog/data/log`，见 [目录映射](./dir.md)）：

| 文件 | 谁写的 | 内容 |
| --- | --- | --- |
| `vanblog-access.log` | **caddy** | 访问日志，JSON 一行一个请求。**默认开着**；给容器设 `VANBLOG_CADDY_ACCESS_LOG=false`（或 `off`/`0`/`no`）关掉 —— 被打的时候它是每秒几千行的真实磁盘 IO，而且里面有访客 IP。⚠️ 写错值、留空都**保持开启**（失败方向是留住审计日志）；关掉的只是访问日志，`caddy.log` 里的错误日志照常 |
| `caddy.log` | **caddy** | caddy 自己的运行 / 错误日志（证书签发、配置加载失败都在这里；访问日志被排除在外） |
| `vanblog-stdio.log` | 容器里的 `start.js` | server 与前台子进程的输出合流。**后台「日志管理 → 系统日志」读的就是这一份** |
| `vanblog-stdout.log`<br>`vanblog-stderr.log` | 容器里的 `start.js` | 同样的内容，但按标准输出 / 标准错误分开，排查时更好定位 |
| `vanblog-event.log` | server | 审计 / 事件日志（登录、本站安装归因记录等），后台「日志管理」的登录日志读它 |
| `restore.key` | server | 忘记密码用的恢复密钥（0600；**每次启动或被使用后重新生成**），见 [忘记密码](../faq/password.md) |
| `setup.key` | server | 初始化密钥（0600）。只在**站点未初始化期间**存在，初始化成功后自动删除，见 [初始化](../guide/init.md#初始化密钥setup-key) |
| `vanblog-backups/` | server / 脚本 | 整站备份归档；旁边有 `.manifest.json` 清单、`.sha256` 校验和，以及 `backup-status.json`（最近一次成功 / 失败）与 `vanblog-verify-log.jsonl`（每次校验一行台账），见 [整站备份](../advanced/backup.md) |

容器的 `stdout`（`docker logs` / `podman logs` 看到的）与上面这些文件是**两份**：`start.js`
一边把子进程输出转发到容器 stdout，一边追加进 `vanblog-*.log`。

::: tip 两个「访问日志」别搞混

- `vanblog-access.log` 是 **caddy** 的访问日志，格式是 JSON，**默认在写**（`VANBLOG_CADDY_ACCESS_LOG=false` 可关）；
- `VANBLOG_ACCESS_LOG=true` 打开的是 **API 服务（Nest）侧**的访问日志：每个非静态请求打一行 INFO。
  它走普通日志输出，所以落在 `vanblog-stdio.log` / `vanblog-stdout.log` 和容器 stdout 里，
  **不会**单独生成一个文件。默认关闭（容易刷屏），排障时再开。

:::

::: tip 三套日志都会轮转，不会把磁盘写满

- **事件日志**：单份上限 `VANBLOG_EVENT_LOG_MAX_MB`（默认 20MB），超限轮转**改名**为
  `.1` / `.2` / `.3`，保留份数 `VANBLOG_EVENT_LOG_KEEP`（默认 3），总量上界 ≈ 20 × (3+1) = **80MB**。
  这个文件早先只增不减，跑久了会吃满磁盘 —— 而磁盘满的表现是「备份写不出来、图片存不进去、
  mongod 变只读」，很难想到根因是日志。
- **stdio 日志**（上面那三份）：单份上限 `VAN_BLOG_STDIO_LOG_MAX_BYTES`（默认 20MB），
  超限轮转成同名 `.old`，**只留一份旧的**。
- **容器 stdout**：由编排文件的 `logging`（模板里是 json-file、`max-size: 10m`、`max-file: 3`）管，
  与上面两套是分开的。
- 后台「日志管理」单次读取也有上限（`VANBLOG_LOG_SCAN_MAX_LINES` 默认 20000 行、
  `VANBLOG_LOG_SCAN_MAX_BYTES` 默认 8MB），所以超大日志只显示最新一段 —— 那是读取上限，不是文件坏了。

:::

## 日志级别：什么算 ERROR（2026-09 起口径变了）

排查和告警都靠「数 ERROR」，所以级别口径要稳定。前台（Next）子进程的输出由 server 转发，这里曾经有个坑：

- **改动前**：前台子进程的 **stderr 一律被转成 ERROR**。而 stderr 是**诊断流**，不是错误流 ——
  Next 的 bundle 体积建议、deprecation 提示、以及「未设置 `VAN_BLOG_REVALIDATE_SECRET`」这类
  **正常配置状态**的提示都走 stderr，于是它们全变成了 ERROR。
- **后果很具体**：`./vanblog.sh doctor` 会统计近 24 小时的 ERROR/FATAL 行数，
  所以**每一个一体式部署都会被体检报成异常**，而站点其实完全正常；真正的错误反而被这类噪音淹没。
- **改动后**：前台子进程的 **stderr 记为 WARN**；而**前台异常退出记为 ERROR**
  （退出码非 0，或被信号打死），正常退出（码 0、无信号）仍是 WARN，不制造假警报。

⚠️ 这个改动**没有削弱**任何信号：前台崩溃的判定本来就走子进程的 `exit` 事件、**不看 stderr**，
而崩溃时的堆栈现在通过「异常退出 = ERROR」这条路径保留下来。另外四处真错误仍然是 ERROR：
重启前台出错、达到最大重启次数、重新拉起失败、异常退出。

⇒ 如果你在用 `doctor` 或自己的日志告警：**升级之后 ERROR 计数会明显下降，那是修正了误报，不是问题变少了**。

## 迁移台账（migrations）

除了日志文件，server 还维护一个**迁移台账**：每一项「对已有数据的自动修复」（统计行去重、
补建唯一索引、明文访问密码洗成 scrypt、按保留期清理统计……）都会在 `migrations` 集合里
记一行：做了什么、影响多少条、什么时候、成功还是跳过。本站是**怎样被初始化的**
（向导 / 上传备份恢复 / 环境变量零接触，含时间与来源 IP）也会记一条 `install:initialised`，
后台欢迎页（数据概览）顶部的横幅显示的就是它 —— 万一哪天发现「站点被人抢先初始化了」，
这里是第一个该看的地方（老站点升级上来的没有这一行，横幅不显示）。

台账可以通过 `GET /api/admin/migration/list`（管理员鉴权）读取。
