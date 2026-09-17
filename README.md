<p align="center">
  <img src="img/logo.svg" width="200" alt="VanBlog" />
</p>

<h1 align="center">VanBlog</h1>

<p align="center">
  <strong>简洁、实用、优雅的个人博客系统</strong><br />
  全自动按需 HTTPS · 静态化前台（ISR 秒级增量渲染）· 内置图床与评论 · 整站备份可<b>演练</b>验证 · 一条命令部署
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/CKboss/vanblog?display_name=tag" alt="最新版本" />
  <img src="https://github.com/CKboss/vanblog/actions/workflows/server-test.yml/badge.svg" alt="server-test" />
  <img src="https://github.com/CKboss/vanblog/actions/workflows/admin-e2e.yml/badge.svg" alt="admin-e2e" />
  <img src="https://img.shields.io/badge/node-24%20LTS-3c873a" alt="Node 24" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-yellow" alt="GPL-3.0" />
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#访问性能实测可复现">性能实测</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="#与上游的关系">与上游的关系</a>
</p>

---

> **这个项目从哪里来**：VanBlog 由 [Mereithhh/van-blog](https://github.com/Mereithhh/vanblog)（GPL-3.0）继续开发而来，
> 上游项目的主页与演示见文末[「与上游的关系」](#与上游的关系)。
> 到今天两边已经差别很大：**133 个提交、552 个文件、+77,338 / −5,381 行**，依赖整体现代化
> （Node 24 · NestJS 10 · mongoose 8 · Next 14 · TypeScript 5.9 · sharp 0.35 · multer 2），
> 并补上了整站备份的**恢复演练**、迁移账本、文章版本历史、回收站、定时发布、健康检查、
> 事件日志轮转等一批能力，同时修掉了一批"看着成功其实没成"的真 bug。
>
> 逐版改动看 [CHANGELOG.md](CHANGELOG.md)，每项改动的**根因与踩过的坑**看 [AGENTS.md](AGENTS.md)（也是给 AI 编码代理的运行手册）。

## 预览

| 浅色 | 深色 |
| --- | --- |
| <img src="img/前台-白色.png" width="420" alt="前台浅色" /> | <img src="img/前台-黑色.png" width="420" alt="前台深色" /> |

## 特性

**写作与内容**

- Markdown 编辑器（bytemd，掘金同款）：图表（mermaid）、数学公式（KaTeX 服务端渲染）、代码高亮、TOC、`more` 摘要标记、
  自定义高亮块、Emoji 选择器、剪贴板与本地图片一键上传、导入 `.md`/`.mdz` 建文章/草稿（`.mdz` 图片自动入图床）、
  导出 `.md` / Typora 图片包 `.mdz` / `.zip` 三选一
- 草稿、加密文章与加密分类、隐藏文章、置顶、自定义文章路径（拼音别名 + 数字 id 自动 301）
- **文章版本历史**（改标题/正文才快照，上限可配，回滚前会先存一份当前状态 ⇒ 回滚本身可回滚）
- **定时发布**（`publishAt`；到期前在所有公开面都不可见，含搜索、RSS、sitemap、相关文章与密码解锁接口）
- **回收站**（文章与草稿都可恢复；彻底删除需要显式二次确认与 `article:delete` 权限）
- 分类、标签、友链、关于页、自定义页面（可上传 HTML/CSS/JS）、自定义导航栏、打赏

**读者与前台**

- 前台是静态页（SSG）+ **ISR 秒级增量渲染**：改一篇不用重建全站
- **站内搜索**：静态索引（零数据库成本、可被 CDN 缓存）+ `/search` 结果页（排序/高亮/分页），索引不可用时自动回退服务端搜索
- **阅读时长**、相关文章推荐、TOC 抽屉、代码复制、访客数/阅读量、暗黑模式（可自动切换）、响应式
- Apple 风格皮肤（后台一键切换）；也可上传自己的主题 CSS（主题文件会随整站备份一起走）
- SEO：自定义路径与 301、JSON-LD、OG/Twitter 卡片、sitemap、RSS（feed/atom/json）
- 内置评论系统（存在本站 Mongo，不必外挂），也可接 Waline

**图床与附件**

- 内置图床，也支持 OSS / 七牛 / 又拍云 / sm.ms / GitHub（外部图床基于 picgo）
- 上传自动压缩、自动水印（任何图床都生效）、自动生成缩略图，可选 AVIF 兄弟文件
- 附件管理与批量导出

**运维与安全**

- **全自动按需 HTTPS**（内置 caddy，连域名都可以不填），HTTP/2、HTTP/3
- **整站备份/恢复**：数据库（含 waline 评论）+ 图床 + 附件 + 自定义页面 + 主题，高压缩归档；
  支持定时备份、**导出后立刻自校验**、`verify-deep` 语义校验，以及 **`drill` 恢复演练**（在一次性栈上真恢复一遍并断言语义）
- **初始化页直接上传整站备份恢复**：全新安装不必再手填站点信息与账号
- 健康检查端点 `/api/public/health`（数据库 ping 不通返回 503，镜像 HEALTHCHECK 打的就是它）
- 事件日志按大小轮转、后台可直接查看登录/系统/Caddy 日志、迁移账本记录每一项数据修复
- 限流分档（全局/静态/公开写/初始化）、可信代理判定（限流不再能被一个请求头绕过）、登录防爆破、
  加密文章解锁限次、请求体上限、request-id 与慢请求日志、协作者细粒度权限、API Token 管理、忘记密码恢复密钥
- 内置访问统计与看板（访客/浏览量/每日快照），也可注入 GA、百度统计等

**部署**

- 一条命令部署（脚本自动决定拉镜像还是本地构建，构建前会实测 CPU 与可用内存，不够就直接劝退而不是让你白等）
- 单容器一体化（caddy + server + 前台 + waline + mongo），也支持 docker compose / 宝塔 / 群晖 / Kubernetes / 前后端分离
- 支持 ARM64

完整功能说明在 [`docs/features/`](docs/features/overview.md)。

## 快速开始

### 一键脚本

```bash
curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh \
  && chmod +x vanblog.sh && ./vanblog.sh
```

想用**发布版**而不是开发分支（更稳，且不受 raw 的分支缓存影响）：

```bash
curl -L https://github.com/CKboss/vanblog/releases/download/v2026.9.2/vanblog.sh -o vanblog.sh \
  && chmod +x vanblog.sh && ./vanblog.sh
```

> ⚠️ `raw.githubusercontent.com` 对**分支**地址有几分钟 CDN 缓存：刚推完就装可能拿到上一版脚本。
> 要确定版本就用上面的发布版地址，或把 `dev/dsh` 换成具体 commit sha。

脚本会：检测环境 → 默认**先拉镜像** `ghcr.io/ckboss/vanblog:dev-dsh`（1C1G 的小机器也装得动）→
拉不到就**自动退回源码构建**（构建前实测 CPU 与可用内存，决定并发还是串行、admin 用 4096MB 还是 1536MB 堆；
可用内存不足 1.8GB 时直接劝退并给出两条出路，不让你白等 20 分钟）→ 生成 compose → 起容器 → 打印访问地址。

之后常用命令：

| 命令 | 作用 |
| --- | --- |
| `./vanblog.sh` | 打开菜单 |
| `./vanblog.sh update` | 拉新镜像（或重新构建）；**失败不会动正在跑的容器** |
| `./vanblog.sh config` | 重新生成 compose（改了环境变量之后跑这个） |
| `./vanblog.sh backup` / `restore` | 整站备份 / 恢复 |
| `./vanblog.sh backup-verify` | 备份 + **立刻深度校验** + 陈旧检查 + 台账（适合放 cron） |
| `./vanblog.sh drill [归档]` | **恢复演练**：在一次性栈上真恢复一遍并断言语义（见下） |
| `./vanblog.sh verify-deep` | 不需要 root 的语义校验（清单、版本、成员穿越、计数自洽、主题是否在包里…） |
| `./vanblog.sh log` / `status` | 日志 / 状态 |
| `scripts/reset-waline.sh --generate` | 重置 waline 全部管理员密码（**不再有默认密码**；随机密码只显示一次，改库前要确认，邮箱默认不动）⚠️ 跑过 2026-09 之前的旧版就该视为凭据已泄露 —— 旧版把哈希硬编码在公开仓库里 |

首次部署后浏览器打开 `http://<你的IP>`，按向导初始化站点与管理员账号即可。
如果手上已有一份整站备份，**初始化页可以直接上传它恢复整站**，不用先填一遍向导；
也可以**零接触**：给容器设 `VANBLOG_ADMIN_USER` + `VANBLOG_ADMIN_PASSWORD`（或 `_FILE`），
站点在监听第一个请求之前就完成初始化。未初始化期间匿名初始化接口默认要求**初始化密钥**
（`VANBLOG_INIT_REQUIRE_SETUP_KEY`，新版默认开；密钥在日志目录 `setup.key` 与启动日志里，每 10 分钟重印），
防止「谁先请求谁就把新站初始化成自己的」。

### 其他部署方式

docker compose、宝塔面板、群晖、Kubernetes、前后端分离部署：见 [`docs/guide/get-started.md`](docs/guide/get-started.md)。
反代（Nginx / Caddy / Cloudflare）注意事项：见 [`docs/reference/reverse-proxy.md`](docs/reference/reverse-proxy.md)。

## 访问性能（实测，可复现）

完整报告在 **[docs/advanced/benchmark.md](docs/advanced/benchmark.md)**，采集脚本入库在
[`scripts/benchmark/`](scripts/benchmark/measure.sh)，每个数字都能重跑对账。
下面是生产镜像 + 真实数据（53 篇公开文章、93 个静态文件，从 66MB 整站备份恢复）在同机 podman 栈上的结果：

| 指标 | 实测 |
| --- | --- |
| 首页（ISR HTML） | **93,359 B / gzip 22,961 B，8–10 ms** |
| 文章页 | 78,830 B / gzip 23,729 B，**8 ms** |
| 公开列表接口（5 篇摘要） | 5,621 B，**12 ms** |
| 图床图片 / 缩略图（caddy 直服，不过 Node） | **1 ms** |
| 混合流量吞吐 | **456–506 rps / 673–763 Mbps**（并发 50→1000，**0 个 5xx、0 个 socket 错误**） |
| 持续加压（并发 200 × 20,000 请求 / 35.7 秒） | **560.9 rps / 820.5 Mbps**，p50 138 ms，0 错误 |
| 纯静态吞吐 | **1,487 rps / 3,432 Mbps（≈429 MB/s）**，p50 29 ms、p95 64 ms |
| **C10K**：一万条连接同时挂住 | 1.1–1.8 秒全部建立，**0 拒绝** |
| **C10K**：一万条连接同时取静态图 | **10,000/10,000 全部 200，1.4 秒，0 失败** |
| **C10K**：一万条连接同时打动态接口 | 10.7 秒完成 **5,872** 个（天花板是单进程 Node，不是网络层） |
| 一次文章页浏览的数据库开销 | **~1 条 Mongo 命令**（改造前 8 条 / 4 次写） |
| 容器内存 | mongo 142–162 MB；应用稳定加压时 **627 MB** |

⚠️ 读这些数字的三个前提：客户端与服务端**同机**（抢 CPU，绝对值偏保守）、走 **loopback 且无 TLS**、
页面都是 **ISR 缓存命中**。并发扫描是**抬掉限流**测的 —— 默认限流是每 IP 每分钟 600 次
（静态资源另有 10 倍独立桶），不抬的话测到的是"限流器多快返回 429"。报告第 0 节写了完整协议与复现命令。

还有一个**默认关闭**的开关 `VANBLOG_CADDY_SERVE_HTML`：让 caddy 直接发 6 个固定页的 ISR HTML，
实测 **3.7–4.5× rps、p95 降 78–84%**、首页单请求 p50 **8 → 1 ms**。为什么默认关、代价是什么、
为什么动态路由曾经明确不做、以及现在靠什么保证安全（失效产物清理器），都写在报告第 9.1 节。
⚠️ 顺便更正一句我早先写错的话：我曾说"开了直发这些路径就完全绕过限流"——**字面为真但暗示了一个不存在的损失**：
**HTML 页面本来就不在限流覆盖范围内**：反代模式下 caddy 把页面请求转给 Next(:3001)，缓存命中的页面根本不碰 Nest(:3000) —— 实测 700 个反代页面请求 **0 个 429**。所以直发**不改变限流覆盖率（0 个百分点）**；限流器覆盖的一直只有 `/api/*` 与 `/static/*` 这些。真正变化的是"爬虫烧谁的 CPU"：Node 的单个事件循环 → caddy 的 sendfile。

## 备份与恢复：能演练才算数

`verify` 只能证明"这个文件是完整的"（`zstd -t` + 成员清单 + sha256），**证明不了"它能被恢复成一个能用的站点"**。
这两件事差得很远 —— 本项目就踩过两次：一次是恢复直接报 `Unsupported BSON version`（编解码用的 BSON 构造器
与写库的驱动不是同一个大版本），一次是**上传的主题 CSS 从来不进归档**（元数据在库里、文件不在，
恢复后后台显示主题已启用，而 `/api/public/theme.css` 返回 204 + 空样式表，前台静默退回默认皮肤，**零报错**）。

所以现在有三层：

```bash
./vanblog.sh backup-verify      # 备份 + 立刻深度校验 + 陈旧检查 + 台账（服务端也会写完自校验，失败即 HTTP 400）
./vanblog.sh verify-deep <归档>  # 不需要 root 的语义校验：清单能否从归档内部读出、版本、成员穿越、计数自洽、主题在不在
./vanblog.sh drill <归档>        # 恢复演练：一次性 mongo + 一次性 vanblog，真上传真恢复，断言语义
```

`drill` 断言的不是"接口返回了 200"，而是**对账**：信封里的 counts 与归档 manifest 一致、
公开列表的 total 等于**从归档自己的 `articles.ndjson` 逐文档数出来的公开篇数**、
真实静态文件可取、**主题 CSS 可取**、日志里没有 BSON 指纹、第二次恢复必须 403。
最近一次真机演练：`RESULT: PASS pass=31 warn=0 fail=0 note=3`，HTTP 201、服务端 3.2 秒、端到端 4 秒。

细节与输出示例见 [`docs/advanced/backup.md`](docs/advanced/backup.md)。

## 文档

| 想了解 | 看这里 |
| --- | --- |
| 全部文档 | [`docs/README.md`](docs/README.md) · 项目介绍 [`docs/intro.md`](docs/intro.md) |
| 安装与初始化 | [`docs/guide/get-started.md`](docs/guide/get-started.md) · [`docs/guide/init.md`](docs/guide/init.md) |
| 升级与回滚 | [`docs/guide/update.md`](docs/guide/update.md) |
| 备份、恢复与演练 | [`docs/guide/backup.md`](docs/guide/backup.md) · [`docs/advanced/backup.md`](docs/advanced/backup.md) |
| 文章 / 编辑器 / Markdown | [`docs/features/article.md`](docs/features/article.md) · [`docs/features/editor.md`](docs/features/editor.md) · [`docs/features/markdown.md`](docs/features/markdown.md) |
| 图床与附件 | [`docs/features/image-storage.md`](docs/features/image-storage.md) · [`docs/features/attachment.md`](docs/features/attachment.md) |
| 评论 | [`docs/features/comment.md`](docs/features/comment.md) |
| 主题与定制化 | [`docs/features/theme.md`](docs/features/theme.md) · [`docs/advanced/customizing.md`](docs/advanced/customizing.md) · [`docs/advanced/custom-page.md`](docs/advanced/custom-page.md) |
| 加密、隐藏、置顶 | [`docs/advanced/encrypt.md`](docs/advanced/encrypt.md) · [`docs/advanced/hide.md`](docs/advanced/hide.md) · [`docs/advanced/sticky.md`](docs/advanced/sticky.md) |
| 流水线（事件驱动的自定义代码 / webhook） | [`docs/features/pipeline.md`](docs/features/pipeline.md) |
| 访问统计 | [`docs/features/visitor.md`](docs/features/visitor.md) |
| ISR 与性能调优 | [`docs/advanced/isr.md`](docs/advanced/isr.md) · [`docs/advanced/performance.md`](docs/advanced/performance.md) · [`docs/advanced/benchmark.md`](docs/advanced/benchmark.md) |
| HTTPS 与证书 | [`docs/advanced/https.md`](docs/advanced/https.md) |
| SEO 与 RSS | [`docs/advanced/seo.md`](docs/advanced/seo.md) · [`docs/advanced/rss.md`](docs/advanced/rss.md) |
| 安全与加固 | [`docs/advanced/security.md`](docs/advanced/security.md) · [`docs/reference/secure.md`](docs/reference/secure.md) |
| 协作者与权限、API Token | [`docs/advanced/collaborator.md`](docs/advanced/collaborator.md) · [`docs/advanced/token.md`](docs/advanced/token.md) |
| 反代 / 目录结构 / 日志 | [`docs/reference/reverse-proxy.md`](docs/reference/reverse-proxy.md) · [`docs/reference/dir.md`](docs/reference/dir.md) · [`docs/reference/log.md`](docs/reference/log.md) |
| API | [`docs/reference/api.md`](docs/reference/api.md)（运行时 `/swagger` **默认关闭**，需要时 `VANBLOG_SWAGGER=true` 打开） |
| 配置项与环境变量 | [`docs/reference/env.md`](docs/reference/env.md) · [`docs/reference/config.md`](docs/features/config.md) |
| 从别的系统迁移 | [`docs/advanced/migrate.md`](docs/advanced/migrate.md) |
| 常见问题 | [`docs/faq/deploy.md`](docs/faq/deploy.md) · [`docs/faq/usage.md`](docs/faq/usage.md) · [`docs/faq/update.md`](docs/faq/update.md) · [`docs/faq/password.md`](docs/faq/password.md) · [`docs/faq/customize.md`](docs/faq/customize.md) |

## 配置

绝大部分配置在后台界面里。环境变量都有默认值，**不改也能跑**；改完跑 `./vanblog.sh config` 重新生成 compose。
完整清单见 [`docs/reference/env.md`](docs/reference/env.md)，compose 模板里每一项都带注释：
[`docker-compose/docker-compose-template.yml`](docker-compose/docker-compose-template.yml)。

最常动的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VANBLOG_IMAGE_REF` | `ghcr.io/ckboss/vanblog:dev-dsh` | 用哪个镜像（可换成自己的 registry 或某个 sha / tag） |
| `VANBLOG_INSTALL_MODE` | `auto` | `auto` 先拉镜像、失败退回源码构建；`image` 只拉；`source` 只本地构建 |
| `VANBLOG_USE_UPSTREAM_IMAGE` | `false` | 设 `true` 回到上游官方镜像（**不含本仓库的任何改动**，优先级最高） |
| `VANBLOG_RATE_LIMIT_PER_MIN` | `600` | 每 IP 每分钟的全局请求上限（静态资源另有 10 倍独立桶） |
| `VANBLOG_TRUST_FORWARDED_HEADERS` | `auto` | 限流采信转发头的条件。⚠️ CDN/隧道**直连源站**（对端是公网代理 IP）要设 `always` |
| `VANBLOG_CLUSTER_WORKERS` | `1` | 多进程。⚠️ N>1 尚未实跑验证，打开前请自己压一遍 |
| `VANBLOG_ARTICLE_REVISIONS_KEEP` | `10` | 每篇文章保留多少历史版本（`0` = 关） |
| `VANBLOG_BACKUP_STALE_WARN_HOURS` | `48` | 太久没有"已校验的成功备份"就在启动与每次失败后 WARN（`0` = 关） |
| `VANBLOG_THUMB_AVIF` | `false` | 缩略图额外产 `.avif`（省 26–41% 字节）。⚠️ 原图故意不做（实测最高 241 秒/张 CPU） |
| `VANBLOG_CADDY_SERVE_HTML` | `false` | caddy 直发 ISR 生成的 HTML：`true` = 6 个固定页（3.7–4.5× rps），`all` = 再加 `/post` `/page` `/category` `/tag`（文章页突发 **8.8×**、p50 7→1–2 ms），其它值一律当关。要求 ISR 是 onDemand 模式（delay 模式会自动降级）。⚠️ 页面 HTML 本来就不经限流器（缓存命中不碰 Nest），所以直发不改变限流覆盖率 |
| `VANBLOG_HEALTH_DETAILS` | `false` | 设 `true` 才在匿名的 `/api/public/health` 里返回 uptime 与内存（**版本号始终公开**——它本来就渲染在每个前台页面的页脚上，藏它属于安全表演；uptime/内存能推断重启时机与负载，所以默认藏） |
| `VAN_BLOG_INTERNAL_TOKEN` | 空 | 内部令牌（`x-vanblog-internal` 头）。带上它也能读到上面的健康详情；⚠️ 回环地址**不**算内部 —— 一体式部署里 caddy 就是从 127.0.0.1 拨过来的 |
| `VAN_BLOG_VERSION` | `dev` | 页脚与后台「关于」显示的版本号（镜像构建时写入；⚠️ Dockerfile 的构建参数是复数 `VAN_BLOG_VERSIONS`，两个名字**故意不一样**，别顺手统一） |

## 升级与回滚

```bash
./vanblog.sh update     # 拉新镜像或重新构建；失败不会动正在跑的容器
./vanblog.sh config     # 改了环境变量之后重新生成 compose
```

⚠️ 升级前先看 [CHANGELOG.md](CHANGELOG.md) 里的**「行为变化」**与
[`docs/guide/update.md`](docs/guide/update.md) 的对照表：本项目有几处是**故意改了默认值**的
（访问密码改存 scrypt 哈希、**忘记即不可找回**；`/swagger` 默认关；访问统计默认只保留 10 年；
整站恢复默认把静态目录修剪成与归档一致；事件日志会轮转改名；文章版本历史默认开；
匿名初始化默认要求初始化密钥；限流的可信代理判定与覆盖范围；浏览统计的内存/行数封顶），
以及一批安全修复会让**以前能做的事现在被拒**（公开搜索不再返回私有文章标题、
上一篇/下一篇与相关文章不再包含私有文章、匿名登出不再触发流水线事件）。
回滚方式与升级后常见问题见 [`docs/guide/update.md`](docs/guide/update.md) 与 [`docs/faq/update.md`](docs/faq/update.md)。

## 开发

```bash
./dev-env.sh bootstrap   # 下载 Node 24 + pnpm 8 + MongoDB 7 到 .tools/，并建好本地骨架
./dev-env.sh install     # 装依赖
./dev-env.sh start       # MongoDB:27017 + server:3000 + website:3001 + admin:3002 一起起
./dev-env.sh status      # 状态；另有 logs / stop / restart / db / backup
```

**不需要 docker，也不需要 sudo**：工具链、数据库、数据目录、日志全部在仓库内（`.tools/`、`vanblog_dev/`，已本地忽略），
整套环境可以随目录搬走，不污染系统。

改了 `Dockerfile` / `entrypoint.sh` / `scripts/start.js` / caddy 模板这类**只有镜像里才会暴露**的东西时，别只跑单元测试：

```bash
./scripts/build-image-local.sh                       # 构建 + 冒烟测试（起临时 mongo 与容器，测完自动拆）
./scripts/build-image-local.sh --stage admin_builder # 只构建某一层，迭代快得多
ENGINE=podman ./scripts/build-image-local.sh         # 没有 docker 组权限时用 podman（rootless，免 sudo）
```

冒烟测试会逐个打关键端点，然后**扫容器日志里历史上真炸过的特征**（`Cannot find module`、`caddy process exited`、
`Reached heap limit`、`ERR_INVALID_URL`、`降级使用`…），再看重启次数、healthcheck 状态与 `stop` 的耗时
（接近宽限期就说明 SIGTERM 没被转发、进程是被硬杀的）。

### 测试

| 套件 | 命令 | 现状 |
| --- | --- | --- |
| server（jest） | `cd packages/server && ./node_modules/.bin/jest` | **169 套件 / 1951 用例**（1944 绿 + 7 跳过 + **0 失败**，59s；⚠️ 机器被压满时另有 2 条负载敏感用例会假红，单独跑就绿） |
| website（vitest） | `cd packages/website && ./node_modules/.bin/vitest run` | **84 文件 / 885 用例** |
| admin（node:test） | `cd packages/admin && node --test --test-reporter=tap tests/unit/*.test.js` | **148 套件 / 579 用例**（⚠️ Node 24 换了默认 reporter，不加 `--test-reporter=tap` 就没有汇总行）；⚠️ 这套里有**读 server 源码**的跨包锚点，只改 server 也要跑它 |
| admin（playwright e2e） | `cd packages/admin && ./node_modules/.bin/playwright test` | **111** 用例（37 个 spec，真浏览器渲染真组件；⚠️ 需要装浏览器，且默认的 3002 端口与开发栈冲突，本地跑要把 7 个 `*_E2E_PORT` 都改开） |
| 部署脚本（bash） | `for t in scripts/tests/*.test.sh; do bash "$t"; done` | **24 文件 / 1768 条断言** |
| 文档守卫 + 文档站 | `bash scripts/tests/docs-{links,consistency}.test.sh`；`cd docs && pnpm run docs:build` | 死链 5/5、一致性 52/0（含"文档写的每个 `VANBLOG_*` 代码里都真的读"）、构建 65 页 |
| 类型检查 | `cd packages/server && ./node_modules/.bin/tsc -p tsconfig.dev.json --noEmit`；`cd packages/website && ./node_modules/.bin/tsc --noEmit -p tsconfig.json` | 两包各 **0 错** |
| 访问性能 | `scripts/benchmark/measure.sh --base http://127.0.0.1:18080 …` | 见 [benchmark.md](docs/advanced/benchmark.md) |

用 `./dev-env.sh bootstrap` 装的工具链跑（Node 24 + pnpm 8 + MongoDB 7）；系统 Node 也可以，但版本要 ≥ 24
（本项目的 `@nestjs/cli` 已经升到 11，不再有上游那个 `util.isObject` 在新 Node 上崩溃的问题）。

### 项目结构

```
packages/server     NestJS 10 + mongoose 8：接口、图床、备份、流水线、统计、caddy 管理
packages/website    Next 14（pages router）+ React 18：读者看到的前台，ISR 静态化
packages/admin      umi 3 + antd 4 + React 17：后台
packages/waline     评论子系统（可选，内置评论之外的另一条路）
packages/cli        命令行工具
docs/               文档站源码（vuepress）
scripts/            部署与运维脚本（vanblog.sh 及其双胞胎、benchmark/、tests/）
docker-compose/     compose 模板（每一项环境变量都带注释）
Dockerfile          五阶段构建，全部基于 node:24-alpine
AGENTS.md           工程运行手册：环境、测试、排错速查、每一项改动的根因与踩过的坑
```

## 已知限制

诚实清单，详细的在 [`docs/advanced/security.md`](docs/advanced/security.md) 与 [AGENTS.md](AGENTS.md) §7.40 的待办里。

- **备份是明文、且只落在本机**：归档里含密码哈希与 jwt 密钥；**没有异地副本**（S3/OSS/WebDAV 都没有），
  机器一起丢就全丢 —— 这是目前最大的单点。（"能不能恢复"现在有证据了：导出后自校验 + `drill` 演练。）
- ~~文章/分类的访问密码仍是明文存储~~ —— **已修**：改存 scrypt 哈希、任何接口不回显（后台只给 `hasPassword` 布尔），
  表单语义变成「留空 = 不修改、清除要显式开关」。代价：**忘记访问密码不再可找回**，只能后台清除/重设。
- **没有 CSP**：内联样式 + bytemd 注入的脚本 + 可选第三方统计，严 CSP 会把站点搞坏，要先给内联样式发 nonce。
- **搜索仍是子串匹配**：现在有了静态索引（`/static/search/index.json`）+ `/search` 结果页（排序/高亮/分页，索引不可用时回退服务端搜索），
  但没有中文分词、没有拼写容错、没有拼音；摘要 ≤200 字，正文深处的词要走服务端回退。也没有 `/metrics`（Prometheus 指标）。
- **后台技术栈停更**：umi 3 + antd 4 + **React 17**；前台是 Next **14**（15/16 要 React 19，而 `@bytemd/react` 的 peer 只到 18）；
  Express 仍是 4.x（Nest 11 = Express 5 = path-to-regexp v8，而 `app.module.ts` 有 4 处 `path:'*'`）。
- **`cluster` 默认关且 N>1 从未实跑**：守卫都铺好了，但内存随 worker 数近似线性增长，打开前必须自己压一遍。
- **AVIF 只覆盖缩略图且默认关**（原图实测最高 241 秒/张 CPU，数学上不成立）；小图用 AVIF 反而更大。
- **caddy 直发 HTML 默认关**：`true` 覆盖 6 个固定页，`all` 再覆盖 `/post/* /page/* /category/* /tag/*`（要求 ISR onDemand 模式）。
  动态路由曾经的硬阻塞（删除文章的 HTML 永远留在磁盘上）现在由失效产物清理器（默认每 15 分钟对账）兜底，但这条路的活体验证还不如固定页充分。
- **waline 让镜像大了约 330MB**，其中约 170MB 是这个部署用不到的（MathJax 三件套、LeanCloud、better-sqlite3）。
- **前台全局 CSS 拆不开**：apple 皮肤 46KB + markdown 专用表约 27KB 对 `/link`、`/tag`、`/timeline` 是死重，
  被 Next 的 pages router 挡住（只允许在 `_app` 引第一方全局 CSS）。字体已自托管，
  但**站点数据里的自定义 CSS/HTML 仍可能引用第三方**（那是用户数据，只能在后台「定制化」里清）。
- 内置评论没有邮件 / webhook 通知（Waline 有）、没有点赞 UI（`likeCount` 已存着）、没有验证码。
- 没有全局 `ValidationPipe`（`class-validator` 不是依赖），参数校验靠各处手写；净化中间件是黑名单不是白名单。
- `/api/admin/init` 仍靠「库里有没有用户」判断是否已初始化，但现在有三层缓解：初始化密钥**默认开启**、
  10 分钟 5 次的限流、零接触初始化（`VANBLOG_ADMIN_USER` 等）可以让窗口根本不存在。

### 路线图（按性价比）

1. **异地备份**（S3/OSS/WebDAV 任选其一）—— 补上目前最大的单点
2. ~~**搜索质量**：构建期生成静态索引 + `/search` 结果页 + 关键词高亮~~ —— **已完成**（2026-09）
3. ~~**caddy 直发 HTML 扩到动态路由**~~ —— **已完成**（`VANBLOG_CADDY_SERVE_HTML=all` + 失效产物清理器；默认仍关）
4. **后台 2FA（TOTP）与会话管理**（"登出所有设备"）
5. **`/metrics`** + 外部 uptime 探测告警（打 `/api/public/health` 即可，不用改代码）
6. **cluster 压测**后再决定要不要默认开
7. 从 WordPress / Hexo / Hugo / Markdown 目录导入（迁移是高频需求，底座都在：front-matter 解析 + 图片本地化 + JSON 导入 + `.mdz` 往返）
8. 响应式图片 `srcset`（现在只有"缩略图 + 原图"两档）
9. ~~**可见水印在镜像里补上系统字体**~~ —— **已完成**（2026-09）：镜像装了 `fontconfig ttf-dejavu wqy-zenhei`（860 → 892 MB），中文水印可用；缺字体的自建镜像是"跳过 + WARN"而不是盖满 `.notdef` 方块（旧镜像实测会盖）
10. **自定义图片水印**（上传一张 logo 当水印）：文字水印已经够用，但品牌场景要图形；底座（sharp 合成 + 按图尺寸自适应 + 跳过过小图）都在

## 与上游的关系

- **上游项目**：[Mereithhh/van-blog](https://github.com/Mereithhh/vanblog) —— 本仓库是它的 fork（`CKboss/vanblog`，分支 `dev/dsh`），
  按 **GPL-3.0** 继续开发，版权归原作者所有。
- **上游的文档站与演示**：[vanblog.mereith.com](https://vanblog.mereith.com) ·
  [演示站](https://blog-demo.mereith.com)（后台账号密码均为 `demo`）。
  ⚠️ 那两个站点描述的是**上游版本**，与本仓库已经有明显差别（功能、默认值、镜像来源都不同）；
  本仓库的文档在 [`docs/`](docs/README.md)，以它为准。
- **上游社区**：[VanBlog 交流群](https://jq.qq.com/?_wv=1027&k=5NRyK2Sw)。
  ⚠️ 群里讨论的是上游版本，本 fork 的改动（尤其是默认值变化与新开关）在那里可能得不到答案。
- **差异概览**：133 个提交 / 552 个文件 / +77,338 −5,381 行。逐项改动与理由在 [CHANGELOG.md](CHANGELOG.md)
  （按版本分组）与 [AGENTS.md](AGENTS.md)（按轮次记录根因、实测数字与踩过的坑）。
  想只装上游原版：`VANBLOG_USE_UPSTREAM_IMAGE=true ./vanblog.sh install`。
- **与上游同步**：

  ```bash
  git fetch origin            # origin = 上游 Mereithhh/vanblog（只 fetch，不 push、不打 tag）
  git rebase origin/master    # 或 merge，按需
  git push ckboss dev/dsh     # ckboss = 本 fork
  ```

  上游的发版 tag（`v*` 产品、`doc*` 官网）是作者专用的，本分支不会向上游推送任何 tag。

## 问题反馈

请提到**本仓库**的 [issue](https://github.com/CKboss/vanblog/issues/new)。
报问题时请带上：`./vanblog.sh status` 的输出、容器日志里的相关片段（`./vanblog.sh log`）、
以及后台「关于」里显示的版本号（形如 `v2026.9.2@<短 sha>`：tag + 构建时的 commit，能直接对上）。

如果是上游版本的问题（比如你装的是 `VANBLOG_USE_UPSTREAM_IMAGE=true`），请到
[上游仓库](https://github.com/Mereithhh/van-blog/issues/new/choose)反馈。

## 许可

[GPL-3.0](LICENSE)，与上游一致。
