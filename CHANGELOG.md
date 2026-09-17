# Changelog

## [Unreleased]

> 下面是 `v2026.9.1` 打标之后累积的改动，还没发版。

- **文章导出可以选格式了，不再"永远一个压缩包"**：列表行内与编辑器里的「导出」变成**下拉三选一** —— **Markdown (.md)**（只要正文，图片链接仍指向站点；服务端此时**完全不抓图**，所以最快也不碰外链）、**Typora 图片包 (.mdz)**（相对路径 md + `<标题>.assets/`，离线可用）、**全部打包 (.zip)**（原样 md + mdz + 导出说明，即一直以来的行为，**不传 format 就是它**，所以老脚本/老前端零改动）。同一篇带 1 张图的文章实测 **.md 9,908 B / .mdz 46,587 B / .zip 51,257 B** —— 只要文字时少下载 5 倍。两个刻意决定：**未知格式明确 400**（不静默回落到 zip，否则调用方写错字段名时"莫名拿到一个压缩包"最难查）；**选了 .mdz 但这篇没有图片也明确 400** 并说清"请改选 .md"，绝不静默改发别的文件。响应头 `X-Export-Report` 三种格式都带，并新增 `assetsPacked` 字段用来区分"这个格式本来就不含图片"与"想打包但失败了"（少了它，选 .md 导出带图文章会弹出「有图片没打进包」，看着像出了错）；临时目录现在**每种格式**发完都删（以前只对 zip 那条路径负责）。下拉里每一项都直接显示代价说明，选错格式的代价在选择那一刻就看得见。⚠️ 批量导出是**另一条路**（浏览器端逐篇转 md 直接下载、不含图片），本轮未改动，只在文档里写清两者区别。
- **修复：`admin-e2e` 抓到的一个真竞态 —— TOC 里的公式会静默退化成原文**。`MarkdownTocBar` 的标签在 `useMemo`（渲染期）里就会触发公式插件的懒加载，而订阅"已加载"通知发生在 `useEffect`（渲染后）；只要 import 先 resolve，`listeners.forEach` 面对的就是空集合，**通知永久丢失**，TOC 标签永远停在 `$A$<$B$` 原文，而且**一条报错都没有**（loader 的 `.catch` 当时是空的）。e2e 夹具里 esbuild 把动态 import 内联了 ⇒ 微任务级 resolve ⇒ 确定性失败；生产里那是真的网络分块（KaTeX ~275KB / gzip ~75KB，当初正是为了不拖首屏才懒加载），比订阅慢 ⇒ **靠运气一直没暴露**，而一次缓存命中或将来打包器内联就会让它在线上静默退化。修法是把通知做成**粘性**的（`onTocMathReady` 里若已加载就立刻回调一次，按类修而不是按调用点修），并把空 `.catch` 换成一次性 `console.warn`。`admin-e2e` 因此**恢复门禁**（摘掉上一轮临时加的 `continue-on-error`），本地 **111 passed**、CI 的 `Run admin mermaid e2e` 步骤在门禁恢复后 `success`。⚠️ 教训：**带 `continue-on-error` 的步骤在 API 里显示 `success`**，"步骤绿了"不等于"测试过了"。

- **新功能：恢复演练 `./vanblog.sh drill`** —— 把"备份能不能恢复"从信仰变成一条命令的证据。它起一套**一次性**的 mongo + vanblog（命名卷、容器 IP + `--add-host`、端口选择器跳过后听端口、mongo 端口永不为 27017、任何名字/端口冲突硬拒绝、trap 保证每条路径都清理），等 `/api/public/health`，然后**真的**把归档上传到 `POST /api/admin/init/restore`（走用户会走的那条生产路径，不是内部函数调用），再断言**语义**而不只是完整性：信封的 `counts` 与归档 manifest 对账、manifest 自身求和一致、meta 是真实站点（不是未初始化的 233）、**公开列表的 total 与"从归档自己的 `articles.ndjson` 逐文档数出来的公开篇数"相等**、一个真实静态文件 200 且非空、**主题 CSS 能否取到**、容器日志里扫 BSON 指纹、第二次恢复必须 403。动机很具体：本轮开头的两个 P0（BSON 大版本导致恢复 400、主题从来不进归档）都是"备份看着成功、恢复才发现坏了"，而 `verify` 只验 `zstd -t` + 成员清单 + sha256，**验不出这两类**。真机结果（podman 4.9.3 rootless、修复后的 65.9 MB 归档）：`RESULT: PASS pass=31 warn=0 fail=0 note=3`，HTTP 201 / 服务端 3.2 s / 端到端 4 s，`/static/themes/warm-paper-28381fac.css → 200, 5,521 B` 与 manifest 的 `themes.bytes=5521` 相符。**负向演练也做了**：半截归档 → HTTP 400 + 退出 1 + 完整清理，**紧接着的好归档演练仍然通过**（证明单飞锁没被坏归档卡死）。另有 `verify-deep`（**不需要 root**，在旧 `verify` 的输出之上加语义层）、`backup-verify`（备份 + 立刻深度校验 + 陈旧检查 + 台账，任何一步失败都非零退出）、`backup-status`（**不需要 token** 就能回答"上次备份什么时候成功的、校验过没有"）。旧的 `verify` **故意保持不变**（仍 root 门槛、仍宽松），因为让严格版顶替它会静默改掉现有用户 cron 的退出码。**本轮又做了第二轮扩展（成员级完整性）**：server 侧归档清单现在带一个 `integrity` 块（每成员 sha256+字节数、按成员名排序拼接算出的 **merkle root**（与 server `computeMerkleRoot` 逐字节同构，bash 里重算）、zstd 流是否带帧校验和、含目录项的 `memberCount`、以及与 `manifest.json` 逐字节相同的**双清单** `./MANIFEST.copy.json` 互为对照），drill/verify-deep 相应升级到"每个成员的字节都能证明"而不只是"归档能解开"。⚠️ 旧归档没有 integrity 块 ⇒ 一切成员级检查**大声降级**，绝不让人把"没查"读成"查过且通过"。成员名踩平了两个真雷（都实测过）：GNU tar 的 `tar -tf` 会把不可打印字节**渲染**成 `\302\233` 这种文本（真站静态目录里就有 10 个双重编码 CJK 图名，拿渲染名去 GET 必然 404/400）⇒ 哈希路径改用 `--to-command` 的 `TAR_FILENAME` 原始字节名 + NUL 分隔记录（bash 变量与行式列表都装不下带换行的名字）；名字里有换行时 GNU 打 1 行、busybox 打 2 行 ⇒ 加"不以 `./` 开头的行"碎片检测。还把"0 匹配的校验器照样通过"这个**最危险的形状**固化成自检：任何成员断言匹配到 0 条就 FAIL（曾有一个锚定 `^static/themes/` 的检查对 182 个 img 成员匹配了 0 条还报"通过"）。另有 `drill --skip-hash` / `VANBLOG_DRILL_SKIP_HASH=1`（跳过成员级哈希，会打 WARN）、`backup-verify --all` + `VANBLOG_BACKUP_REVERIFY_DAYS`（对保留中的归档定期复验，默认 0=关）、cron-safe 着色（stdout 不是 tty 自动去色，`VANBLOG_FORCE_COLOR=1` 强制保留）。
- **新功能：文章版本历史**（按"极简"的要求做：不做 diff、不做分支、不做逐键保存）。独立的 `revisions` 集合（**不嵌进文章文档** —— 那会让每次列表查询与每份备份都背上 N 份正文），**只在标题或正文真的变了**才快照改之前的状态，上限 `VANBLOG_ARTICLE_REVISIONS_KEEP`（默认 10，`0` = 关），超出淘汰最老；后台可列出（只给元数据）、查看正文（只读纯文本，不引入新渲染器）、以及**回滚 —— 回滚前会先把当前状态存成一个 `pre-restore` 版本，所以回滚本身可回滚**。存量实测：单条均值 3,130 B，59 篇 × 10 = **约 1.76 MB**。
- **新功能：回收站**（文章**与草稿**都有）。既有 `DELETE /api/admin/article/:id` 本来就是软删（`deleted:true` + `deletedAt`），只是没有办法看到、恢复或彻底删。新增 `GET /api/admin/article/deleted`（分页、按 `deletedAt` 倒序、投影**不含正文与密码**）、`PUT …/:id/restore`（恢复并重算字数、重新激活 ISR、触发 `afterUpdateArticle` 流水线事件）、`DELETE …/:id/purge`（**必须已经软删**，权限与既有删除同档，连带删掉该文章的 revisions；⚠️ 故意不删访问记录/评论/图片文件，与既有删除的副作用范围一致）。⚠️ **草稿回收站有个既有语义的坑**：发布草稿会软删该草稿，所以草稿回收站里会出现"其实已经成功发布"的条目，而**恢复它不会动那篇已发布的文章**。
- **新功能：定时发布**（`publishAt`）。语义选的是**查询级"到期前视为未发布"，而不是翻 `hidden`** —— 这样"到点即可见"自动成立、不依赖任何"必须成功的写入"：cron 挂了、进程挂了、容器没起来，文章到点照样可见；而翻标记需要状态机外加 cron 与后台对同一字段的竞争。每分钟的 cron 只由主实例跑，且只做三件轻活（记录、作废 meta 缓存、触发渲染），扫描窗口**只在查询成功后才前移**（崩溃不会漏发）。保存语义：`null` 清除、键缺失 = 不变、垃圾值 → **400**（绝不静默变成 Invalid Date）。⚠️ **泄露是活体验过的**：建了一篇排到 2030 年的临时文章，逐个面确认——公开列表（find 与 aggregate 两条路径）、按 id 详情、按别名详情、**密码解锁 POST（`allowOpenHiddenPostByUrl` 也绕不过）**、搜索、时间线、标签页、相关文章、`meta.totalArticles` 全部看不到它，然后完整还原。
- **新功能：迁移账本**（`migrations` 集合）。此前所有数据修复都是**启动期的幂等 wash 且不记录**：不知道某台机器跑过哪些、跑了多久、有没有失败，将来做破坏性迁移也没有安全网。现在每个 key 一行（`kind/ranAt/durationMs/outcome/detail/codeVersion/runs/firstRanAt/lastError`），13 项启动/定时/后台触发的修复都报进去，`GET /api/admin/migration/list` 可读（协作者不可见），`outcome=error` 立刻 WARN 且**原样重抛原始错误**。⚠️ **账本只做可观测性，绝不用来跳过 wash**（有源码级测试钉住）—— 索引创建与幂等去重必须每次都跑。⚠️ 选"一 key 一行"而不是"一次运行一行"：wash 每次启动都跑，开发时 watcher 一天能重启上百次，一次一行会无界增长。
- **新功能：阅读时长与相关文章**。`readingMinutes` 出现在公开列表与详情（除数 350 字/分钟，`VANBLOG_READING_SPEED_WPM` 可调；⚠️ **私有/加密文章不给** —— 正文藏着，长度也就藏着，所以前台绝不会出现"0 分钟"标签）；`relatedArticles` 最多 5 条，排序 = 共有标签 → 同分类 → 时间新近，**一次查询**、投影不含正文与密码。实测：相关查询中位 **5.2 ms**（explain examined 57），列表侧阅读时长的开销 **37.6 µs**/整份 53 篇列表；两者都跑在 ISR 缓存的页面里。
- **安全：私有文章的元数据泄露已堵**（既有问题，本轮由前后台联调时撞见）。把文章设为私有之后，**上一篇/下一篇导航里仍然带着它的标题与别名**（实测计数 3→2 而不是 →0）：`getPreArticleByArticle` 过滤了 `hidden`/`deleted`，**没过滤 `private` 与私有分类**。只是元数据，但加密文章的标题往往就是全部秘密 —— 公开页面上挂一条"2026 年裁员名单"的邻居链接，不用密码也把事说了。现在上一篇/下一篇、公开搜索、相关文章三处都排除私有与私有分类的文章。⚠️ **选"整个略去"而不是"按解锁状态显示"**，理由钉在代码里：解锁状态是**按 IP 的尝试次数桶**，而这三处属于**被 ISR 静态化的共享页面**，每个访客不同的解锁状态在那里结构上不可能实现。⚠️ 这是**有意的默认行为变更**（安全边界，不提供回退开关）：公开搜索不再返回私有文章的标题，从此与 `getTotalNum`/RSS/sitemap 口径一致。
- **安全：一句遗留的 `console.log(staticSetting)` 每次启动都把完整图床设置（含 OSS/七牛/又拍云的 accessKey）打进 stdout** ⇒ 进容器日志、进任何日志采集。已删。
- **修复：一个能让整站恢复功能被永久锁死的既有 bug**。`listArchiveMembers` 在**截断归档**上**永不 settle**（tar 的 close 先把 `settled=true` 置上，随后的 `fail()` 因已 settled 变成 no-op）。后果不止是校验挂住：匿名路由 `/api/admin/init/restore` 的 `assertRestorableArchive` 会**一直吊着请求并占着单飞锁直到进程重启** ⇒ **任何人上传一个坏归档就能永久锁死整站的恢复功能**。已修，gzip 与 zstd 两种格式都加了回归钉子，并由脚本侧的负向演练从外部证明（坏归档 400 之后，紧接着的好归档演练仍然通过）。
- **备份现在写完就自校验**（不加密，按要求）。六道检查：解压器能读完整个流且 tar 能走完每个头；**归档内部**的 manifest 能解析并通过校验（只有 sidecar 不算 —— 恢复读的是内部那份）；sidecar 与内部一致且字节数等于真实大小；`totals` == 各集合计数之和且每个声明的集合都有对应 `.ndjson`；静态文件数 == tar 清单里的实际条目数；计数非零（⚠️ 静态文件**不**要求非零，全新站点可能一张图都没有）。挂在导出路径上 ⇒ **手动与 cron 都覆盖**；失败则记录状态（`stage='verify'`）+ 带原因的 ERROR + **HTTP 400**（归档保留用于取证）。状态写在 `<backupPath>/backup-status.json`（⚠️ **故意不写进数据库**：恢复会把库覆盖掉，状态跟着回退就等于"恢复之后看不到恢复之前那次备份失败了"）。`GET /api/admin/backup/full/status` 可读，导出响应新增 `verified`/`verifySeconds`；陈旧告警 `VANBLOG_BACKUP_STALE_WARN_HOURS`（默认 48，`0`=关，⚠️ 这是一条**新的默认启动 WARN**）。实测：真的 69 MB / 226 成员归档校验 **265–302 ms**。**本轮又做了什么**：自校验从"结构六道"升级到**成员级哈希**（默认开）—— 导出时把每成员 sha256、merkle root、zstd 帧校验和与双清单写进归档的 `integrity` 块，正是上面 drill 第二轮扩展要验的那份数据；另加一个**定期巡检**（默认每 24 小时一轮、每轮最多查最新 3 份，默认只做便宜的结构校验；完整性数据、深度校验、巡检、告警的节奏全都有环境变量可调，见 [docs/reference/env.md](docs/reference/env.md)）。
- **性能（默认关，需显式开启）：caddy 直接发 6 个固定页的 ISR HTML** —— 首页扫描 **279.8–316.1 → 1171.0–1246.9 rps（3.7–4.5×）**、**p95 −78…−84%**、单请求 `/` 的 p50 **8 → 1 ms**，500/500 全 200、0 socket 错误。⚠️ **只做了固定页（`/`、`/about`、`/link`、`/timeline`、`/category`、`/tag`），动态路由经调研后明确不做**，五个阻塞点全部在活体真数据栈上证过：**删掉的文章的 HTML 永远留在磁盘上**（Next 14.2.35 的 file-system-cache 里没有任何 unlink，而 Next 自己从内存回 404 ⇒ caddy 会无限期用 200 提供已删除内容）、308 与 404 **不留任何磁盘产物**（`file_server` 无法还原状态码）、notFound 只在内存里、delay 模式下新鲜度 100% 靠流量驱动（直发会让页面**永久冻结**）、加密文章的明文留在磁盘上直到重渲染风暴重写它。实现是**双重门控**：`VANBLOG_CADDY_SERVE_HTML=true` **且** ISR 是 onDemand 模式时，provider 才写一个哨兵文件，每 60 秒对账（切到 delay 会自动摘掉，自愈、不用重启）；带 preview cookie、非 GET/HEAD、文件缺失都落回反代。⚠️ **开了以后这 6 条路径完全不受限流**（请求根本不进 Nest），而**镜像里的标准 caddy 2.11.4 没有任何限流模块**（`caddy list-modules | grep -ci 'rate.?limit'` → 0，要限流得用 xcaddy 自编）—— **这正是默认关的正当理由**。**本轮又做了什么（含一条对自己结论的更正）**：① 上面那句"不受限流"字面为真、**实质误导**，已在四处（README 正文与 env 表、AGENTS env 表并加了"不许再这么写"的注记、compose 模板注释、benchmark.md）更正 —— **页面 HTML 本来就不在限流器覆盖里**：代理模式下 caddy 把页面请求转给 Next(:3001)，缓存命中的页面根本不碰 Nest(:3000)，限流器从来只覆盖 `/api/*` 与 `/static/*`；本轮实测 700 请求的代理模式页面突发 **0 个 429**。直发真正改变的是"谁为扫描器烧 CPU"（Node 单事件循环 vs caddy sendfile）；caddy 没有限流模块仍是事实，但那不是这个开关的代价，降级成脚注。② **动态路由直发做了**：`VANBLOG_CADDY_SERVE_HTML=all` 在 6 个固定页之外再直发 `/post/* /page/* /category/* /tag/*`（`true` 仍只有固定页；其它任何值**包括 typo** 一律当关），前提是一个新的**ISR 失效产物清理器**（`artifactReaper`：每轮渲染风暴收尾跑一次 + 主实例 15 分钟一次对账（`VANBLOG_ISR_REAP_INTERVAL_MS`），删掉"库里已不可见但磁盘上还留着"的路径的 `.html`/`.json`/`.meta` 三件套；合格集直接取自 `SitemapProvider.getSiteEntries()` ⇒ **清理器、sitemap、搜索索引三者不可能漂移**，删除/私有化/未到点的文章同时从三处消失；⚠️ 与直发开关**解耦、始终运行**）。当初"明确不做"的五个阻塞点各自有了被点名的保证：已删文章留盘 ⇒ 清理器（负向对照记录在案 —— 没有 unlink 时 caddy 对已删文章回 200 且正文匹配命中 10 处）；308 与 404 不留磁盘产物 ⇒ `try_files` 落回反代，状态码仍由 Node 发（`/post/53` 仍 308 到别名、`/post/never-existed` 与 `/page/999` 仍 404）；delay 模式冻结 ⇒ onDemand 门控自动摘哨兵；加密明文留盘 ⇒ 重渲染风暴重写 + 清理器兜底（实测私有化文章被重写成 44,463 B 的门控文件、`content.length=0` 无明文，随后被回收、经反代发解锁页）。模板形状"墙"测试现在点名允许集，并写清 `/api/*`、`/admin/*`、`/c/*` 与更深通配**永远不能加入**的理由。真镜像栈 + 53 篇真语料实测：文章页 p50 **7 ms → 1–2 ms**（identity）/ **7 → 3 ms**（gzip）；c=50 突发 **323.9 → 2861.2 rps（8.8×）**，2000/2000 全 200、0.7 s。⚠️ 两行**如实标注未活体验证**（要重建镜像才有）：未来 `publishAt` 的文章不可从磁盘发出（结构上有保证 —— 合格集继承 `visiblePublishFilter`，跳过与回收两道门都有单元证明）；完整的"删除 → 风暴 → 自动 unlink"链（集成测试在真实临时文件系统上证了风暴收尾回收，容器内的自动链要等清理器进镜像才存在）—— 把"harness 证过"与"镜像证过"分开写，正是这个项目以前栽过的地方。
- **前台字体自托管，去掉一个第三方运行时依赖**：apple 皮肤的 Maple Mono 原来从 `cdn.jsdelivr.net/fontsource/fonts/maple-mono@latest/…` 取 —— 自托管博客引入第三方运行时依赖、**版本钉在 `@latest`**（CDN 侧一次发布就能静默改掉或弄坏排版）、还在关键路径上多一次跨源连接。现在 vendored 到 `public/fonts/`（woff2 74,088 B + OFL-1.1 许可证 4,406 B，**仓库净增 78,494 B**），版本钉死 `@fontsource/maple-mono@5.3.0`（= maple-font v7.8），**jsDelivr 与 npm 两份文件的 SHA-256 相同**、许可证文本与上游 OFL.txt 逐字节一致（SIL OFL 1.1 可再分发，声明随文件附带即满足要求，不需要网站可见署名）。`font-display: swap`，SSR head 里加**一条**且只在 apple 皮肤下加的 `preload`（`crossOrigin="anonymous"` 必须带，否则同源字体会**下载两次**）。效果：代码侧 **0 个第三方字体请求/连接**，同源且与 CSS 解析并行。⚠️ **`.woff` 回退被彻底删掉了（有意的）**：Next 14 支持的浏览器全都有 woff2，退化路径是 swap + 完整系统字体栈。验证是在**全新的生产构建**上做的（不是开发缓存）：产出的 CSS 里 0 处 jsdelivr、preload 在 head 里、字体 200 且 SHA-256 相符。⚠️ 后台包里同一处 `@font-face` 只把 `@latest` **钉成 `@5.3.0`、继续走 CDN**（后台要登录、不在读者关键路径上，为预览再塞 74 KB 进第二个包没有可测收益）。
- ⚠️ **一个只有跨包联调才暴露的坑（值得单独记）**：前台的可选载荷归一化第一版会**显式写出值为 `undefined` 的键**（空封面 → `cover: undefined`）。`JSON.stringify` 静默丢掉它、React 渲染它也没事、所有单测都绿 —— 而 **Next 的 `getStaticProps` 序列化器拒绝它**，线上 SSR 直接 500：`Error serializing .relatedArticles[3].cover`。只有当服务端的真实载荷（`cover:""`）撞上前台时才暴露。**可选载荷的归一化必须按 Next 序列化器的约束来测，不能只测 `JSON.stringify`。**
- ⚠️ **AVIF：先量后做，原图故意不做**。缩略图 avif q50 vs webp q70 = **−26.2…−41.3% 字节**（编码 0.6–1.3 s/张），已实现为 `VANBLOG_THUMB_AVIF`（**默认关**）下的可选 `meta.thumbAvif` 兄弟文件；⚠️ **极小图反而更大**（60×40 的图 +242%，AVIF 有约 294 B 容器底噪 ⇒ 小图标该继续用 webp）。**原图** −36.6…−51.9% 字节，但**每张 2.1 s 到 241 s CPU**（7360px 那张要 241 秒）⇒ 上传路径与回填都不可接受，**故意不实现**（唯一合理的形状是夜间任务）。前台的 `<picture>` 按"字段缺失 ⇒ HTML 逐字节不变"实现，并有金样对拍测试；⚠️ 字段是**嵌在 `meta` 里的**，前台第一版按顶层读 ⇒ 那条"缺失即无变化"的保证会让功能**永远静默不生效而测试全绿**，现在补了"字段存在却没被读到就红"的全链路用例。
- **非 root 也能跑只读子命令了**：`vanblog.sh:381` 的 root 门槛在**子命令派发之前**，所以连"校验一个用户自己的归档"都要 root（`mkdir /var/vanblog` 先失败、然后 `必须使用root用户运行此脚本`、退出 1）。现在 `drill` / `verify-deep` / `backup-verify` / `backup-status` 在 `pre_check` **之前**转交给 `scripts/vanblog-drill.sh`（⚠️ 放在 dispatcher 里是没用的，dispatcher 在 `pre_check` 之后）。会写 `/var/vanblog`、生成 compose、以 root 跑 docker-compose 或改 root crontab 的子命令**照旧**要 root。
- **`admin-e2e` 这条 CI 从此可诊断**：它自加入以来 **19/20 次失败、从未绿过**，而拉 job 日志需要 token，所以失败原因一直无法回收 —— 一条永久红又没人能诊断的工作流比没有更糟，因为它让每次推送和每次发布都看起来是坏的。现在加了便宜的早期信号（`playwright test --list`）、7 个 webServer 的清单打印（任何一个起不来，37 个用例都会以"页面打不开"的形式失败，而真正的原因只在那个 server 的 stderr 里）、`--reporter=list`、以及 `if: always()` 上传 `playwright-report/` 与 `test-results/`（含配置里已开的 trace）保留 14 天。⚠️ 同时暂时标成 `continue-on-error`，注释里写明**拿到 artifact 定位后必须去掉**。已排除的原因：webServer 本身没坏（`serve-admin.mjs` 跑的是 `umi dev`，本地空闲端口上 4.6 s 编译完并返回 200，Node 24 + `--openssl-legacy-provider` 也可以），37 个用例全是 API mock、不需要数据库或栈。
- **安全：匿名健康端点收口 —— 版本号一度藏掉、随后裁定公开，uptime/内存默认门控**。审计自己刚加的端点时撞见：匿名 `GET /api/public/health` 把 `version`（形如 `v2026.9.1@0ec01a5`，**精确 tag + commit**）连同 `uptimeSeconds`、`memoryRssMb`、`heapUsedMb` 一起回给任何来问的人，而健康检查根本不需要这些（镜像 HEALTHCHECK 只判 `statusCode < 500`，`vanblog.sh drill` 只读 `status` 和 `mongo`）—— 它们给未认证扫描器的是**对着已知漏洞比对的精确指纹**，外加推断重启时机与负载的旁路。第一步全部收进 `detailsAllowed()`：正确的 `x-vanblog-internal` 令牌（常量时间比较）或显式 `VANBLOG_HEALTH_DETAILS=true`（只认字面 `true`，`TRUE`/`1` 不会因为一个 typo 静默开放）；匿名调用者只拿到 `status`、`mongo`、`mongoState`、`mongoStateText`、`mongoPingMs`、`now`，mongo-down-503、`no-store`、5 秒探测缓存与并发探测合并都不变。⚠️ **差点踩进的陷阱值得单独记**：判"是不是内部请求"最顺手的 helper 是 `rateLimit.ts:isInternalRequest()`，而它对**任何回环请求返回 true** —— 一体式部署里 caddy 就是从 `127.0.0.1` 拨到 `:3000` 的，用它当门等于对**每个匿名访客**敞开（与限流器当年选错 IP 是同一个混淆）。所以 `detailsAllowed` 只认令牌，spec 钉死"`socket.remoteAddress = 127.0.0.1` 也拿不到 details"，长度不对、差一个字节、缺头、服务端未设令牌全部拒绝。随后站长对版本号那半做出裁定：**build version 不是秘密** —— 它本来就渲染在每个前台页面的页脚里、也从 `/api/public/meta` 下发，只在健康端点藏它属于安全表演（攻击者从页脚就能读到 commit），于是 `version` 回到匿名 payload；**uptime 与内存仍然门控**（那两项不在任何别处公开，且真能推断重启时机与负载）。这个区分写进了 controller 的文档注释，防止下一个人在任一方向"再修一遍"。顺带修掉一条错误注释：原注释声称未初始化站点会带 `initialized:false` —— 这个字段从来不存在（初始化信号一直是 `/api/public/meta` 的 233 信封），错误的注释比没有注释更糟。验证：controller spec 10/10（5 条新门控用例）、活体匿名请求返回恰为 `[mongo, mongoPingMs, mongoState, mongoStateText, now, status, version]`、服务端未设令牌时带假令牌也拿不到 details。[docs/reference/env.md](docs/reference/env.md)
- **安全：三个未认证的口子堵上（全部在一次性实例上逐个实证，不是推演）**：一次性 mongod(27099) + 临时端口起一套即弃实例，开发栈与 :27017 一个请求都没挨。① **`/static/export/`、`/static/tmp/`、`/static/upload-tmp/` 的匿名 403 守卫可绕过，绕过后是 HTTP 200 + 真实文件字节**：守卫比较 `req.path.startsWith('/static/export/')`，而 `req.path` 是 Express 的**原始路径名**（不百分号解码、不点段归一化），serve-static/send 却会先解码归一再开文件。在 `<static>/export/` 下种一个文件实证出的绕过：`/static/%65xport/<file>`、`/static/export%2f<file>`、`/static/./export/<file>`、`/static//export/<file>`、`/static/%2e/export/<file>`、`/static/%74mp/full-restore-<id>/vanblog.ndjson`（**整站备份的恢复暂存目录** —— 数据库 NDJSON，里面是密码哈希与 jwt 密钥）、`/static/upload-tmp%2f<archive>`。平拼写法正确 403 —— 这正是它一直没被发现的原因：守卫在"任何人会手打的那一种拼法"上是好的。生产里经 caddy 可达（只有 `/static/img/*.{webp,png,jpg,jpeg,gif,avif,ico}` 直服，其余 `/static/*` 带原始目标反代给 Node）。上一轮曾记录"匿名下载导出归档已修复"—— **那次修复是装饰性的**，这里如实记账而不是悄悄改口。守卫现在住在 `utils/staticGuard.ts`：解码（畸形转义按字面判）、反斜杠与连续斜杠折叠、`path.posix.normalize`，然后比较 `/static/` 后的**第一段**（而不是字符串前缀）。两个超出报告的加固：归一化后**逃出** `/static/` 的路径（`%2e%2e`）返回哨兵直接拒绝（不委托给 send 自己的恶意路径检查）；段比较前转小写（大小写不敏感文件系统上 `%45xport` 骗不过去）。按第一段比较还顺带修了旧代码的误伤：`/static/exportx/` 以前被前缀判 403，现在正确 404。修后活体验证九种绕过拼法全部 403、零内容泄露。② **加密文章解锁的 20 次/10 分钟限次，换一个 id 拼法就整个绕过**：限次 key 用原始路径参数，而 `article.provider.ts` 用 `parseNumericId = Number(id)` 解析 —— 同一个整数有**无界多种**拼法。实证：`7` 打满（429）之后，`07`、`007`、`7.0`、`0x7`、`7e0`、`0b111`、`0o7`、`%207`、`0000000007` **每一种都拿到全新的 20 次**，且 `POST /api/public/article/0000000000007` 带正确密码返回了全文明文、而拼法 `7` 仍在 429。前导零没有上界 ⇒ 预算实际无限，只剩 30/min 公开写桶兜底 ≈ 单 IP 每天 4.3 万次猜测（再乘上源 IP 轮换）；文章密码是用户自选的明文串 ⇒ 这等于**每篇加密文章都可爆破**。key 现在过 provider 同一个 `tryParseNumericId` 归一化（数字拼法全部归 `#7`，别名归 `p:<slug,80字符>`），总预算 = 每 10 分钟数字 20 次 + 别名 20 次，合法访客无感。③ **三个防爆破计数共用一个全站桶**：登录（`login-<ip>`）、评论（`comment-<ip>`/`comment-day-<ip>`）、解锁（`unlock-<ip>-<id>`）全按 `pickSocketIp()` 键控，而在出厂的 caddy-回环拓扑下它对**每个访客都是 127.0.0.1**。实证：5 个**不同**客户端 IP 各失败登录一次之后，第 6 个客户端带**正确密码**被锁在门外（401「错误次数过多！请 300 秒后再试」），且每 5 分钟 5 个请求可无限续期 = **后台永久 DoS**；同形状地，20 个请求能把任意一篇加密文章对全部读者锁 10 分钟、10 个请求/10 分钟（或 50/天）能全站禁评。评论落库的 `ip` 也来自 `pickSocketIp` ⇒ 生产部署里每条评论的 IP 都是 127.0.0.1，后台 IP 列与任何按 IP 的 moderation 形同虚设。修它需要**收回我上一轮写下并用测试钉住的一个论据**（"把这些计数改到 header 派生 IP 会重开'轮换头无限尝试 + 栽赃受害者 IP'"）：它对旧 `pickClientIp()`（优先客户端可控的 `cf-connecting-ip`/`x-real-ip`）成立，对默认 `auto` 模式的 `pickTrustedClientIp()` **不成立** —— 后者只在 socket 对端是回环/内网时才采信转发头，且取 XFF 的**最右一条**（受信代理追加的那条）：客户端伪造的 `X-Forwarded-For: <victim>` 到 caddy 手里变成 `<victim>, <attacker>`，key 仍是攻击者自己的地址，轮换头一无所获、也栽赃不了任何人。新入口 `bruteForceClientIp()`，`VANBLOG_BRUTE_FORCE_IP_SOURCE=trusted|socket`（默认 `trusted`）；逃生口只为一种部署存在：**覆盖**（而非追加）XFF 的反代会把最右一条交回客户端控制，那种站长应设 `socket` 并接受共享桶 —— 只有字面 `socket` 生效，typo 停在更安全的一侧。登录（`keyOf` 与 `inspect`）、评论（限流器与落库 IP）、解锁 key 三处全换。断言过旧决定的 round-3 spec 被**原地反转**，错误的论据与它的代价记录在上面而不是删掉。测试：`staticGuard.spec` 24 条（九种绕过拼法拒绝、`/static/exportx/` 与 `/static/EXPORTX/` 这类无辜目录放行、裸 `/static` 不误判、畸形转义按字面判、备份兜底前缀含 `%76` 编码形、**守卫名单本身钉死** —— 新增静态目录会强制做一次分类决定）、`bruteForceIp.spec` 6 条、`unlockBruteforce.spec` 3 条（`7` 的十一种拼法经生产解析器归并成一个 key）、反转后的 round-3 spec 51/51。⚠️ 破坏性变化：评论记录从此存真实客户端 IP，后台 IP 列显示的内容会变。[docs/advanced/security.md](docs/advanced/security.md)
- **安全：静态资源、feed、sitemap、swagger 真正进限流器与安全头 —— 顺带收回我们自己两个"实测"结论**。发现本身推翻了本仓库连续几轮的一个说法：`app.useStaticAssets()` 与 `SwaggerModule.setup()` 在 `app.listen()` **之前**调用，而 Nest 要到 `listen()` 触发的 `init()` 里才安装 `app.module.ts` 的中间件链 ⇒ 真实的 Express 栈里 `[express.static /static][/rss][/sitemap][swagger]` 排在 `[request-id][securityHeaders][rateLimit]` **前面** —— 静态与 swagger 的响应在限流器运行之前就结束了。一次性实例上实测（所有限额设 5、每个请求带 XFF 避开回环豁免）：12× `GET /api/public/meta` → 前 5 个 200 随后全 429（Nest 路由有限流）；12× `/static/img/probe.txt` → **200×12**（完全没限流）；12× `/swagger-json` → **200×12**（每个 59.3 KB，没限流）；12× `/robots.txt` → 429×12（走同一个已经满了的全局桶）。所以 `rateLimit.ts` 里那个 `rl-static-<ip>` 桶（`VANBLOG_STATIC_LIMIT_PER_MIN`，默认 6000/min）是**永远执行不到的死代码**，而曾经"证明"静态桶生效的两份测量记录 —— §7.44 的"图片流量不再挤 API 桶"与 §7.55-F 的"轮换 CDN 头时 `/static/**` 桶数 20 → 1" —— 都是**拿合成请求直接调 `rateLimitMiddleware`** 得出的：这就是它们看起来像活体的原因，在真实 HTTP 栈上它们从来不是。现实后果：`/static/file/**` 附件、`/static/themes/**`、`/static/customPage/**` 没有任何限流（只有 `/static/img/*.{…}` 由 caddy 直服），而镜像里的 caddy 2.11.4 没有限流模块 ⇒ 这是全机最便宜的带宽耗尽向量；这些响应也从来拿不到 `X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`、`X-Content-Type-Options`。修法：在 `useStaticAssets` 紧前面装一个 **pre-Nest 中间件**，匹配 `/static/`、`/rss/`、`/sitemap/`、`/swagger`，先跑 `securityHeadersMiddleware` 再跑 `rateLimitMiddleware`，外加 `app.disable('x-powered-by')`。两个要紧的细节：**不会双重计数**（这些路径的响应在这里就结束，到不了 Nest 侧同名中间件）；**前缀匹配同时看原始与解码两种形式**（与 staticGuard 同一个理由 —— 只匹配字面拼法的 matcher 会被 `%2Fstatic%2F…` 类变体绕过，否则等于把一小时前刚修掉的错误在上一层重犯）。内部流量不受影响：SSR/ISR 与 waline 子进程走回环且**不带**转发头回调，`isLoopbackRequest` 整体豁免 —— 这是故意的，否则前台渲染页面时会自己限流自己。修后活体验证：`/static/img/__probe__.png` 与 `/swagger-json` 都带四个安全头、`X-Powered-By` 消失；限流那一半由 `audit-hardening-round4-security-staticguard.spec.ts` 钉住（⚠️ 没有水淹共享开发栈去实证 429 —— 在那里触发限流会破坏其它代理依赖的工作，明说而不是做了）。影响面如实交代：`/static/**` 从此消耗静态桶（默认 6000/min 是全局 10 倍，§7.44 实测图多的页面扛得住，但单一 NAT 出口 IP 后面的图站应**有意识地**核一遍 `VANBLOG_STATIC_LIMIT_PER_MIN` 而不是继承它）；`/swagger*` 落进全局 600/min 桶（人类够用，抓 spec 的 CI 可能被烦到）。结构上更干净的替代方案 —— 把 `useStaticAssets`/swagger 注册挪到 `await app.init()` 之后 —— 被否掉：那会让静态请求穿过 `InitMiddleware`，未初始化站点回 233，把向导里刚上传 logo 的预览弄坏，除非再加一批 exclude，这笔交换不值。⚠️ 破坏性变化：任何以前超预算抓这些路径的东西（配置成逐资源回源的 CDN、抓 spec 的 CI 作业）会开始见到 429。
- **安全：第四轮审计的其余修复包**（与下面"四项决定"挤在同一个提交里）。① **整站恢复与 `.mdz` 导入的归档成员校验拒绝符号链接与不安全硬链**：软链成员会被拷进静态目录、再被 web 层跟随 = **匿名任意文件读**；两条路径复用同一套判定。② **硬链静态树的 `cp -al` 改走 `fs.realpathSync` 解析后的源**：以前图床目录是软链的站点，归档里产出的是**一个软链成员 + 0 字节图片数据**，写后一致性校验必然失败 = 这种站点**根本备份不了**；跨文件系统硬链失败时回落 `fs.cpSync` 真实拷贝。③ **`theme.css` 读取侧路径收敛**：`..` 逃逸、绝对路径、`themes/` 之外一律按"没有这个主题文件"处理（204），不再依赖写入侧校验的自觉。④ **蜜罐评论也消耗限流预算**：以前蜜罐命中会在任何限流**之前**落库并返回 ⇒ 机器人填上蜜罐字段就能白嫖无限次写库；现在三道限流跑在最前面，蜜罐只改判定（`status:'spam'`）不改配额。顺带给评论列表建了复合索引（状态+时间，启动期幂等 `createIndex` 并记迁移台账），按状态的列表查询不再全表扫。⑤ **登出需要有效 token**：`POST /api/admin/auth/logout` 挂上 TokenGuard —— 以前**匿名**请求就能触发 `logout` 流水线事件，等于未认证调用方能启动管理员写的自定义代码。⑥ **浏览统计的每天新增路径行封顶**（`VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY`，默认 5000，`0`=不限）：这是真正按住 `visits` 无界增长的闸门（账算在下面保留期那条），真实站点每天的路径数等于真实页面数、远碰不到上限；被匿名接口编造路径猛刷的站点，从此即便保留期十年也不会无限写行。站点级与每日总量永不丢，丢掉的部分打 WARN 不静默。
- **配置：访问统计默认保留期 0（永不删）→ 3650 天（10 年）—— 站长"四项决定"之一**（9601faa4）。第四轮审计发现 `POST /api/public/viewer` 用编造的路径名就能让 `visits` 集合**永久**增长（每请求 ≈148 B，按 30/min 公开写限额 ≈6.8 MB/天/IP，再乘源 IP 轮换），而 `RETENTION_DEFAULTS.retentionDays` 默认是 0 = 永不删除。审计建议 365 天，站长定了 **10 年**（保住长期趋势）。诚实的代价写在常量旁边：持续攻击下的理论稳态上限 = 5000 行/天 × 3650 × ~157 B ≈ **2.87 GB**（365 天方案的十倍）—— 真正按住它的是上面那条每日新增路径封顶，**不是保留窗口**。删除范围只有**按天的行**：站点级累计（`metas.viewer/visited`）与每篇文章的累计阅读量**都不动**，`minKeepDays=30` 仍兜底，仪表盘最长回看变成 3650 天。`VANBLOG_VISIT_RETENTION_DAYS=0` 回到旧行为（永不删除）。测试的处理方式也记一下：钉 365 的 spec **更新而不是删掉**；凡验"清理逻辑本身"的用例都**显式设**保留期（365/90/0），默认值将来再改也不会让覆盖失效；e2e 的"远古"种子行从 400 天前挪到 4000 天前 —— 400 天现在落在窗口**内**，原断言会一行不删也通过。⚠️ 这个决定在 HEAD 上留下了三个红套件（钉子还写着 365、另一个文件整个编译不过），本会话已收敛 —— 见下面"测试健康"那条。
- **配置：`/swagger` 默认关闭，只认字面 `true`**（9601faa4）。以前 `VANBLOG_SWAGGER` 设成字面 `false` 以外的一切值（包括不设）都开启：59 KB 的 `/swagger-json` 匿名可达，等于把 **111 条后台路由 + 登录请求形状**的地图递给扫描器（当时还完全不限流，见上面那条）。它一直没关只有一个原因：后台有两个页面深链 `/swagger`，直接关会留死链。本轮两个都修了 ——「关于」改链仓库里的 API 文档，「Token 管理」先探测 `/swagger-json`：开着就打开 `/swagger`，关着就弹出**点名确切环境变量**的提示并打开文档。`VANBLOG_SWAGGER=true` 恢复旧行为。[docs/reference/api.md](docs/reference/api.md)
- **新功能：文章/分类的访问密码改存 scrypt 哈希 —— 忘记即不可找回**（实现挤在 9601faa4 里，存量清洗在 e845c7a6 注册）。以前这个字段**明文**存进 Mongo：拿到库或整站备份 = 拿到所有加密文章的密码，后台表单还会回填。现在写入一律走 scrypt（与登录口令同一套参数，`scrypt$16384$8$1$<salt>$<hash>`），读取走 `verifyAccessPassword`（新哈希与历史明文都认，常量时间比较）。两件事一次说清：**密文永不下发** —— 哈希也不是"可以下发的东西"（拿到响应就能离线爆破），而且表单一回填就把"服务端必须能读出密码"这个前提焊死，所以所有会序列化成响应的形状（`redactAccessSecret()` + schema 的 toJSON transform）都把 `password` 换成布尔 `hasPassword`，UI 只需要知道"有没有设"；**表单语义随之改变** —— 留空保存 = **不修改**（否则任何一次不碰密码字段的保存都会把加密悄悄抹掉），解除加密必须显式勾「清除密码」，既给密码又勾清除 = **400**（两种意图冲突），`clearPassword` 只认布尔 `true` 与字符串 `'true'`、其它真值（`1`、`'yes'`）一律当没传（宁可"没清掉"也不要"意外清掉"）。存量明文不用动手：启动 wash 链在 `wash:userSalt` 旁边注册了一个**幂等**清洗任务（仅主实例、fire-and-forget、由既有 wash() 包装器记进迁移台账 `wash:accessPasswords`，provider 自己刻意不记账），articles 与 categories 两个集合都洗，第二次运行 washed=0；**中途被打断在构造上就是安全的** —— verify 两种形状都认，半迁移的站点照常解锁。⚠️ 代价说清楚：**忘记访问密码从此无法找回**（明文时代后台好歹能翻库；登录的"恢复密钥"也救不了它），只能登录后台显式清除/重设；没有回退开关，这是有意的安全修复。`.mdz` 导入会直接丢弃 front matter 里的 `password`（明文不进新库、不进日志），`private: true` 保留、文章维持加密。测试四层：utils 单测、provider 单测、admin 表单单测、独立的 access-password e2e（自带 jest 配置）。[docs/advanced/encrypt.md](docs/advanced/encrypt.md)
- **新功能：零接触初始化与初始化密钥 —— 把"谁先请求谁初始化"的匿名窗口关掉或干脆消掉**（挤在 9601faa4 里）。站点**未初始化**期间，`POST /api/admin/init`（向导）与 `POST /api/admin/init/restore`（备份恢复）都是匿名接口，唯一闸门是"库里还没有用户"：从容器启动到走完向导之间，任何知道地址的人**一个请求**就能抢先把你的新站初始化成自己的（限流只约束重试次数，约束不了那一次成功的请求）。两条对策：① **初始化密钥，默认开启**（`VANBLOG_INIT_REQUIRE_SETUP_KEY`）—— 未初始化期间每次启动生成一把 32 字节随机密钥，写进 `<日志目录>/setup.key`（0600；容器里是 `/var/log/setup.key`，脚本安装对应宿主机映射出来的日志目录），启动日志 WARN 打印并**每 10 分钟重印**直到完成初始化（`VANBLOG_SETUP_KEY_REMIND_MINUTES`，显式 `0` = 只在启动时印一次）；两条匿名接口都必须携带（字段 `setupKey`，初始化页自动出现密钥输入框），密钥**每次重启重新生成**（旧钥即刻作废）、常量时间比较，初始化成功后密钥文件**自动删除**（之后启动不再生成与重印 —— 它只在未初始化期间有意义）；开关值打错（`ture`）**回落到开启**并 WARN 点名，绝不因为一个 typo 把保护静默关掉。抢先初始化从"一个请求"变成"先拿到你机器上的密钥文件/日志"。② **零接触初始化**（`envBootstrap.ts`）—— 设 `VANBLOG_ADMIN_USER` + `VANBLOG_ADMIN_PASSWORD`（或 `VANBLOG_ADMIN_PASSWORD_FILE`；`_FILE` 适合 Docker secret 挂载，**优先于**内联变量），全新站点在**开始监听 HTTP 之前**就完成初始化，窗口整个不存在。行为契约都写死在实现里：`_FILE` 按 secret-file 惯例只去掉**尾部**换行/空白（前导空白算密码本身）、读不到就**大声失败**（ERROR + 保持未初始化，绝不静默回落内联变量）、站点已初始化时三个变量**被忽略**（INFO 说明一句，不覆盖已有账号 —— 改密码走后台）、校验口径与向导一致（缺用户名/空密码拒绝并打 ERROR，密码本身永不进日志）、成功后一条 WARN 写明用户名与密码来源并记迁移台账（`install:initialised`，route=`env-bootstrap`）。⚠️ 升级注意：只影响**还没初始化**的站点 —— 老版初始化页不发送 `setupKey` 字段，"正走到一半"（容器已起、向导没走完）的安装升级后要从启动日志或 `setup.key` 里取密钥填进初始化页；已初始化站点完全无感。确实不要这层保护（全内网、自动化装机另有闸门）就显式 `VANBLOG_INIT_REQUIRE_SETUP_KEY=false`（公网不建议）。测试四层：`setupKey.spec`、`init.setupkey.spec`、`envBootstrap.spec`、独立 setup-key-init e2e。[docs/guide/init.md](docs/guide/init.md)
- **新功能：站内搜索 —— 静态索引 + `/search` 结果页（零数据库成本、可被 CDN 缓存）**（挤在 9601faa4 里）。顶栏搜索弹层（Ctrl/⌘+K，走服务端 `GET /api/public/search`）原来就有，本轮补上**独立结果页**：弹层给出「查看全部结果」入口，跳 `/search?q=<关键词>`。结果页是 **ISR 静态壳 + 浏览器内搜索** —— server 生成一份紧凑的静态索引 `/static/search/index.json`（每篇只收标题、路径、标签、分类与 ≤200 字纯文本摘要），页面加载后在浏览器里对着它做匹配、排序、高亮与分页 ⇒ **搜索本身零数据库成本**，索引是静态文件、还能被 CDN 缓存。排序三档（标题命中 > 标签/分类命中 > 仅摘要命中，档内按命中次数、再按新近度），命中词在标题与摘要里用 `<mark>` 高亮，多词 **AND**（按空白切词，每个词至少要在标题/标签/分类/摘要之一出现）。**收录范围与 sitemap 完全一致** —— 隐藏、加密/私有、私有分类下、软删、`publishAt` 未到点的文章都**不进索引**，且有测试钉住这两个集合相等（静态索引不会成为新的泄露面，口径与上面"私有文章元数据"那条一致）。索引更新走 RSS/sitemap 同一条触发链（后台保存、整站渲染等，60 秒防抖）+ 每小时兜底 cron ⇒「刚发布就搜」最多延迟一分钟量级。**回退是设计出来的**：索引缺失、过期或被截断时结果页干净地回退服务端搜索接口（顶栏弹层一直用的就是它），搜索永远不会变成一块空白；没有 JS 也留了一个直接打接口的出口。开关与预算：`VANBLOG_SEARCH_INDEX`（总开关，默认开）、`VANBLOG_SEARCH_INDEX_MAX_DOCS`（默认 2000 篇、最新优先，超了页面会提示只含一部分）、`VANBLOG_SEARCH_INDEX_SNIPPET_CHARS`（默认 200 字）。⚠️ 诚实的局限（文档里也写了）：**子串匹配，不分词、没有拼音、不容错拼写**（搜「备份」命中「整站备份」，`dockre` 搜不到 docker）—— 这是刻意不引搜索库换来的极简，不是 bug；关键词在正文深处时客户端索引可能搜不到（摘要只有 ≤200 字），请用服务端回退；新鲜度 = 索引最后一次生成的时间。[docs/features/search.md](docs/features/search.md)
- **新功能：`.mdz` 导入 —— 导出格式从此是往返格式**（挤在 9601faa4 里）。前面"导出可以选 Typora 图片包 (.mdz)"现在能搬回来了：编辑器的「导入内容」接受 `.md,.mdz`，`.mdz`（一个 zip：相对链接的 md + `<标题>.assets/` 图片目录）的导入是导出的**精确逆操作** —— 图片走正常上传管线入图床（按内容去重、自动生成缩略图）、正文里的相对链接改写成图床 URL、标题/正文/Front Matter 填进编辑器，⚠️ **不自动建文章**，由你审阅后自己保存（列表页那条 `.md` 导入不变）。Front Matter 里的 `password` 被**直接丢弃**（不回填、不进日志 —— 访问密码只存哈希，导入的明文没有意义），`private: true` 保留、文章维持加密状态（密码导入后重设）。安全判定复用整站恢复同一套归档成员检查（symlink/不安全 hardlink 一律拒绝）+ zip-slip 防护 + zip 炸弹三道上限。测试：`mdzImport.spec` + controller spec（含 demo 模式变体）+ admin 侧 `importMdz.test.js`。[docs/features/article.md](docs/features/article.md)
- **新功能：整站恢复变成"100% 保真"、且被打断能看见**（挤在 9601faa4 里；这是"四项决定"的第四项 —— 提交信息只完整写了保留期/版本号/swagger 三项，这一项从 `staticPrune.ts` 的注释对号：owner 要的是"100% 恢复原站点"）。① **静态目录修剪成与归档完全一致**（`VANBLOG_RESTORE_PRUNE_STATIC` 默认开）：以前恢复是 `fs.cpSync(force:true)` = **并集**而不是替换 —— 归档里没有、磁盘上有的文件**原样留下**，于是"把上周的备份恢复到今天的站点"之后，文章回到了上周、这一周新上传的图/附件/主题 CSS 还躺在磁盘上（还能被 statics 集合之外的路径继续访问到），站点既不是备份那一刻也不是恢复前那一刻。现在 `img`/`file`/`customPage`/`themes` 四个目录里归档中不存在的文件会被删掉。⚠️ **顺序铁律：所有拷贝成功之后才修剪** —— 一次失败的恢复不能顺手删掉用户的东西。⚠️ 安全边界（每条都有测试钉住）：只在传入目录内动手、且用 **realpath 后的根**做包含判断（`img` 本身软链到别的磁盘也跑不出去）；**永不跟随符号链接** —— 链接一律当叶子（unlink 链接本身、不碰目标），指向目录外的链接**连删都不删**、只记进 `skipped` 报告出来（"站点上有一个不知道指向哪的链接"必须让人看见）；递归删除自己实现（不用 `fs.rmSync(recursive:true)`），"会不会跟着链接跑出去"不依赖 Node 内部实现；单次删除失败只记 `errors` 不中断其余修剪（修剪是收尾动作，不该反过来把恢复判失败）。`off` = 旧的"只覆盖、不删多余"。② **归档里缺失的集合只报告、不删除**（默认）：库里有而归档里没有的集合会出现在恢复报告里；要"恢复成与备份那一刻完全一致的库"需显式 `VANBLOG_RESTORE_DROP_ABSENT_COLLECTIONS=true`。③ **恢复断点日志**（`restore-journal.json`）：恢复是逐集合原子的（先写 `<coll>__vanblog_restore` 再 rename），但**跨集合不是** —— 进程在两张表之间被杀（OOM、`docker stop`、断电），库里就是"一半归档内容、一半恢复前内容"的混合状态且**没有任何痕迹**（接口没返回、日志停在"恢复 vanBlog.articles ..."那行，运维看不出到底换了几张表）。现在每换完一张表就原子落一次 journal（tmp + rename），成功删掉、失败/被打断留着；启动时（仅主实例）看到就打一条**点名归档与进度**的 WARN，并塞进 `backup-status.json`（后台与 `vanblog.sh backup-status` 不翻日志也能看见）。⚠️ 这是**检测，不是修复**：绝不触发自动回滚 —— 回滚需要另一份数据，而"另一份"正是已经被 rename 覆盖掉的恢复前库；它只保证"混合状态不会被静默"。journal 与 backup-status 同理**故意写在 `config.backupPath` 而不是数据库里**（恢复会把整库换成归档内容，状态写库里等于抹掉最需要看的现场）。[docs/advanced/backup.md](docs/advanced/backup.md)
- **可见水印渲染重写：jimp + `.fnt` 位图字体 → sharp/libvips + SVG `<text>`**（挤在 9601faa4 里）。修掉旧实现一串老毛病：手机竖拍照片不再"水印横躺/落错角落"（新实现先按 EXIF 摆正再合成）、字号按图片尺寸自适应（400px 小图不会被一个 128px 大字糊满、大图也不会小到看不见）、`example.com` 这类长单词不再被排到画布外。**默认样式换成 tile（无缝斜排平铺）**：满图重复的小字（旋转 −26°、低不透明度、白字 + 半透明深色阴影），"一眼能看出有水印但不破坏观感"，而且**裁不掉**；另有 `corner`（右下角柔光底板，最接近旧版观感）与 `bar`（底部渐变条），位置只对后两者有意义。样式/颜色/不透明度/边距/字体栈用九个 `VANBLOG_WATERMARK_*` 环境变量微调（非法值一律回默认）；**字号本身不是环境变量**：按图片短边自动算、再夹进每样式各自的上下限（tile 14–54 / corner 16–64 / bar 14–96 px，`watermarkSvg.ts` 的导出常量），文字太长先自动缩字号（下限 `MIN_RENDER_FONT_PX = 8`）、缩完仍放不下才跳过这一张（WARN，不影响上传）。结构上把样式解析/按图度量/SVG 构造全部放进**纯函数层** `watermarkSvg.ts`（不依赖 sharp/jimp、全部可单测，字体栈做 SVG 注入清洗），栅格化与合成留在 `watermark.ts`。⚠️ 行为差异：sharp 编不了的格式（bmp/heic/ico/svg）WARN 后返回原图 —— **旧 jimp 实现能写 bmp**。本机那条著名的既有失败 —— `utils/watermark.spec.ts` 的 `#322` 用例（`Jimp.loadFont` 要连 CDN 拉字体，断网就卡满 20s 超时）—— 随 jimp 依赖一起消失，server 套件从此全绿。[docs/features/image-storage.md](docs/features/image-storage.md)
- **安全：`reset-waline.sh` 不再有内置默认密码，新增 `--generate` 随机强密码**（挤在 9601faa4 里）。旧版（已随 v2026.9.1 发布）把一段**内容公开的 bcrypt 哈希**（cost 8、可离线爆破、对应一个尽人皆知的弱密码）和一个硬编码占位管理员邮箱写死在脚本里：任何人跑一次，就把 waline 的**每一个**管理员行静默改成**公开仓库里的已知凭据**，还顺手覆盖掉能用来找回密码的邮箱 —— 那是事故不是功能。新版：密码只能来自 `--password` / `WALINE_NEW_PASSWORD` / `--generate` 现场随机生成（24 位字母数字，约 143 bit），三者都没有就**拒绝执行**（退出码 2），绝不回落任何默认值；随机密码只在改库成功后打印**一次**，脚本自身不留存；**邮箱默认不动**（`--email` 显式给了才改，避免覆盖找回密码用的邮箱）；动库前打印将要发生什么并要求交互确认（`--yes` / `WALINE_RESET_YES=1` 跳过；stdin 不可用视为拒绝 —— cron 里绝不悬挂等待输入）；bcrypt cost 默认 10（旧版的 8 太低，合法范围 4–31）；`/dev/urandom` 不可用拒绝继续；哈希用本机**现成**工具算（python3-bcrypt → htpasswd 依次探测，不新增安装依赖）。⚠️ **跑过 2026-09 之前的旧版就该视为 waline 管理员凭据已泄露**，尽快用新版重置一次。配套 `scripts/tests/reset-waline.test.sh` 守卫。
- **本会话：可见水印"宁可不盖"的字体防线 —— 数 ink 判不出缺字体**。容器实测（node:24-alpine、零字体）推翻了"缺字体 = 文字不产生像素"的旧假设：librsvg/pango 会**画满屏 .notdef 豆腐块**（'Ag…' 576 ink px、'水' 180 ink px），stderr 只有一句 Fontconfig error 就"成功"返回 —— 所以"数 ink 像素"根本判不出缺字体（corner 的底板、bar 的渐变条没字体也照常渲染；豆腐块与真字的 ink **数量**还是阈值分不开的重叠区间），只会把满图豆腐块当"水印成功"合成进去，**比不加水印更糟的静默失败**。现在改成**逐字符集探测**：把 `Ag`（Latin）、`水`（CJK）分别与**等码点数**的私用区 U+E001 串（任何字体都不给它真字形、只会渲染 .notdef 或空白）在同一画布栅格化后**逐字节对比** —— 有对应字体时真字形与豆腐块必然不同，没有时两者逐字节相等。⚠️ "等码点数"这四个字是**镜像里实测换来的**：第一版拿 `Ag`（2 个字符）去比**单个** U+E001，零字体时"两个方块 vs 一个方块"逐字节当然不同 ⇒ `latinOk` 恒为真 ⇒ 已经装好字体的新镜像在人为零字体（`FONTCONFIG_FILE` 指向空配置）下照样盖了 **32,699 px** 的方块；CJK 那条一直是单字对单字，所以没这个毛病。而**注入探测结果的单元测试当时全绿** —— 它们证明的是"探测说没字体时行为对"，**证明不了探测本身对不对**。修法是 `notdefComparatorFor(text)`：按 `[...text].length` 重复 U+E001（用码点数而不是 UTF-16 单元数，代理对才算得对），并新增一条**真跑探测**的用例（子进程 + 空 fontconfig 配置；必须开子进程，因为 fontconfig 在进程内只初始化一次，jest worker 里改环境变量可能不生效），同时钉住"新判据在零字体下说没字体"与"旧判据在同一个环境下会说有字体"（反证）。本机对拍：正常环境 `latin_equals_notdef2=false`（真字形）、零字体 `latin_equals_notdef2=true` 而 `latin_equals_notdef1=false`（旧判据错）；顺带印证 ink 数量分不开（零字体方块 72 px vs 真字形 949 px，同为非零）。Latin 探测失败 ⇒ WARN + 返回原图；文本含 CJK 且 CJK 探测失败 ⇒ WARN 点名 wqy-zenhei + 返回原图。**宁可不盖，也不能盖满图豆腐块。** 探测每进程 memo 一次（单次 ~15ms），ink 判空降级成第二道防线，独立的 `generateWaterMark` 也过同一道防线（缺字体返回 null）。同批两个实测驱动的修正：② **webp 编码加 `effort:2`** —— 水印这步是**在缩放之前**按原始尺寸编码的，libwebp q90 在大图上极慢：实测 6918×4617 effort:4 = 24.7s → effort:2 = 4.6s（**5.4×**），字节只 +2.0%；1920×1440：959→558ms（+0.3%）；800×600：191→117ms（−1.2%）。缩略图那条 `imgResize` 不需要这个（它先缩到 ≤1920 再编码，永远碰不到大图的 effort 成本），质量口径仍与它一致。③ **小图自动缩砖**：图比一块砖还小时砖缩到图内（下限 48px，避免糊成墨点），100×80 的图现在能盖上了；短边 <52px 才放弃（WARN + 原图返回）。
- **本会话：Dockerfile runner 阶段补上 `fontconfig ttf-dejavu wqy-zenhei` —— 在此之前，可见水印在生产镜像里等于不存在**。生产镜像（node:24-alpine runner）此前**一个字体包都没装**，配合上面"宁可不盖"的探测，后果很直接：**镜像里可见水印这个功能等于没有** —— 上传不失败、一张也盖不上、唯一痕迹是日志里一条 WARN。水印文字是 SVG `<text>`，由 sharp 内置的 libvips → librsvg → pango → fontconfig 栅格化，要的是**系统字体** —— 不是 npm 包、也不是前台自托管的那份 woff2（那份只给浏览器用）。现在 runner 阶段 `apk add` 这三个包：ttf-dejavu 管 Latin、wqy-zenhei 管中文；字体栈首选 `Noto Sans CJK SC` 但**故意不装 font-noto-cjk** —— 体积是 wqy-zenhei 的十几倍，为一个水印字段不值，装了 wqy-zenhei 后 fontconfig/pango 会逐字符自动回落。⚠️ 镜像体积代价（本机真构建实测，podman 4.9.3 rootless + `scripts/build-image-local.sh`）：**860 MB → 892 MB（+32 MB，+3.7%）**，其中 `/usr/share/fonts` 占 27,989,228 B；装完 `fc-list` 从 **0 条变 25 条**，`fc-match "DejaVu Sans"` → `DejaVuSans.ttf`、`fc-match "WenQuanYi Zen Hei"` → `wqy-zenhei.ttc`（中文是真有字体，不是回落成方块）。同一次构建的冒烟测试全绿：8 条关键路径全通、8 条已知故障特征全空、0 重启、SIGTERM **1s** 内优雅停机。防回归守卫加进 `scripts/tests/dockerfile-alpine-sharp.test.sh`：⚠️ 断言打在**真正那条 `apk add` 命令**上（解析 RUN 续行、剥掉注释，含续行里的 shell 注释），而不是 grep runner stage 的文本 —— stage 里恰好有一段注释写着「fontconfig ttf-dejavu wqy-zenhei：可见水印要的」，grep 文本会匹配到那段**解释为什么要装的注释** = 与本文件此前 vips-dev 假绿**同一个坑**；再加漂移守卫（代码 `FONT_INSTALL_HINT` 叫用户去装的那批包 == 镜像实际装的那批；字体栈点名的家族必须有对应包 —— DejaVu Sans ← ttf-dejavu、WenQuanYi Zen Hei ← wqy-zenhei），以及「把字体行删掉守卫必须变红」的负向对照演练。该文件现在 **32 条全绿**（本轮实测）。
- **本会话：后台「图床设置」的中文水印闸门拆掉 —— 拦截的理由已不存在**（bfcdf331）。表单以前在保存时硬拦含中文的水印文字（`checkNoChinese` + Modal「目前水印文字不支持中文！因为用了纯 js 库节约资源，后面会加上自定义图片作为水印」）—— 这在 jimp + `.fnt` 位图字体时代是真的（确实渲染不了汉字），重写成 sharp/libvips + SVG 之后前提不成立：服务端按字体栈栅格化、**中文照常能盖**，官方镜像也装了 Latin + 中文字体（上一条的守卫钉着）—— 留着闸门等于**前端白白禁用了服务端支持的功能**。helper 只有这一个调用方、用的还是早已废弃的 `escape()`，整个文件删掉（`checkString.ts`）而不是留着烂。同表单两处过时文案一并改成事实：默认样式早已不是"右下角"而是满图斜排平铺（位置只对 corner/bar 有意义，文案点名 `VANBLOG_WATERMARK_STYLE` / `VANBLOG_WATERMARK_POSITION` 两个真实存在的旋钮 —— 它们是服务端 env，故意不做成表单字段），门槛也不是"宽高小于 128px"而是"短边小于 52px"。新增钉子 `packages/admin/tests/unit/watermarkText.test.js`：**跨包**把文案里的 52px 钉到服务端真实的 WARN 文本（`图片过小（短边 ${minSide}px < 52px）`）与 `MIN_RENDER_FONT_PX = 8`（文字太长先缩字号、缩到底才跳过），并钉住旧文案（"不支持中文"、"纯 js 库"、"右下角"、"128px"）不许回来。⚠️ 第一版写成裸 `doesNotMatch(/checkNoChinese/)`，结果被**自己那段解释为什么拆闸门的注释**弄红（注释里就写着这个词）—— 与 server 侧假块注释四连、dockerfile 守卫 vips-dev 假绿是同一个坑；现在先剥注释再做不存在断言，并带负向对照（把闸门放回去必须红）。验证：admin `node --test` 148 套件 / 579 用例全绿、文件零语法诊断、umi dev 重编译成功（479.53ms）；⚠️ **未在真实浏览器里点验**（本机没装 playwright 浏览器）。
- **本会话：把 HEAD 上红着的测试套件全部修绿 —— 都是"四项决定"那个大提交留下的半成品**（d79dea7e、08f89e6e、fdd7913a）。① **保留期钉子还写着 365**（常量已是 3650）：`audit-hardening-round4-fixes-viewstats.spec.ts` 两处断言 `{retentionDays: 365}`，`statsMaintenance.provider.ts` 里三处注释也还写着 365 —— 正是会让下一个读者"把代码改回符合注释"的漂移。已更新到 3650、把理由留在钉子旁边（审计建议 365、站长要 10 年、2.87 GB 的诚实成本照记），并新增"凡提到默认值/环境变量的行不许出现裸 365"的钉子（刻意不误伤"365 天对一个想看十年趋势的站长太短"这类推理句）。② **`statsMaintenance.provider.spec.ts:224` 调用了不在作用域的 `rows()`** —— 那是**另一个** describe 里的局部 fixture —— TS2304 让整个文件编译失败，于是那个套件**一条用例都没跑过**（在计数里看着存在、其实什么都没断言）。改用本节真正创建的 `dupDocs()` 断言幂等语义，顺带把"那两组重复行也原样没动"按 id 钉死（唯一索引已存在时去重整个跳过，既无 aggregate 也无 deleteMany）。回落用例还补上缺失的反证行：原 fixture 最老的一行（2024-07-07，距今 ~800 天）落在**任何**合理窗口内 ⇒ 回落值写成 36500（100 年）甚至退回"永不删但仍报 enabled"都能全绿；现在种一行 2014-01-01 并断言恰好它被删（visits 与 viewers 各一行）—— 窗口必须**真的有限且真的是 3650** 才会绿。③ **"假块注释"第四次咬人**：`caddy.provider.ts` 的直发日志文案里有模板字符串包着的 `/post/* /page/* /category/* /tag/*`，裸三步正则从那里开一个假块注释、一路吞到 138 行外下一个真的 `*/`，**把整个 `clearLog()`（约 134 行真代码）吃掉** —— "caddy 的 clearLog 不再是空 catch"这条钉子因此变红，**而树上的代码是对的**。前三次的修法都是"调整三步正则的顺序"，那只是把雷换个位置埋：只要源码里能写出 `/*` 这两个字节（日志文案、路径 glob、正则字面量都会写），裸正则就永远会误判。这次**按类修**：共享的单遍扫描器 `src/test-utils/anchorCode.ts`（跟踪行注释、块注释、单/双引号字符串、模板字符串（含 `${}` 递归嵌套）、正则字面量（按前一个有效 token 与除号区分）），8 个 spec 里各抄一份的裸正则全部改成 import 它 —— 下一段日志文案里再出现 `/*`，不能再静默弄松别的钉子。删除规则刻意照抄旧实现（整行注释连缩进带换行删、行尾注释保留前面空白、块注释连换行整个删），几十条既有钉子不用改写；与旧实现只有两处不同且都是旧 bug：字符串/模板/正则里的斜杠不再被当注释，以及 `foo();// bar` 这种斜杠前没有空白的行尾注释现在也剥（旧的 `(\s|^)` 匹配不上）。自带 **17 条钉子**：真实回归（含负向对照 —— 断言旧实现**确实**丢了这段代码，所以对拍不是"两边都错"的空比较）、全仓库 200+ 源文件对拍（**旧实现保留的每一行真代码，新实现都还在** —— 第一轮报出的 11 行"丢失"逐行核实全是旧实现截断字符串产生的残渣、不是真实源码行）、新实现在 `caddy.provider.ts` 上救回 >50 行真代码的证明（实测真源码行 **194 → 328**）、60 个文件上的幂等（剥两次与剥一次相同）。`src/test-utils` 加进 `tsconfig.build.json` 的 exclude（只给测试用的工具不进 dist；jest 走没有 exclude 的 `tsconfig.json`，照常编译导入）。④ **admin 的三条跨包锚点也连带红了**（admin 的 `node --test` 会读 **server** 源文件，server 侧重构就把 admin 套件弄红 —— 当时 575 用例 3 失败）：staticGuard 抽取之后 `main.ts` 里不再有 `backupUnderStatic` 与 `/static/export/` 字面量，钉子改成钉"接线"（`isGuardedStaticPath(req.path, backupSegment)`、`statusCode = 403`）与"什么让守卫可靠"（`GUARDED_STATIC_SEGMENTS`、`decodeURIComponent`、`path.posix.normalize`、`ESCAPED`），并带负向对照（裸 `req.path.startsWith('/static/export/')` 前缀比较不许回来）；`fullBackup.ts` 的钉子从钉变量名改成钉**行为**（`cp -al` 用 realpath 后的 `realSrc` + 跨文件系统失败时 `fs.cpSync` 兜底）。⚠️ 教训记进 runbook：**"只改了 server"不是跳过 admin 套件的借口**。修完：admin 148 套件 / 579 用例全绿，server 三个红套件全绿（完整基线见下面"验证"条）。
- **本会话：CI 的 server 测试从 80 项白名单改成默认全跑**。workflow 以前用一条 80 项的 `--testPathPattern` 白名单跑 src 下的 spec。盘点结果：**src 下 169 个 spec 里有 47 个从来没在 CI 跑过** —— 包括 setupKey / accessPassword / staticGuard / bruteForceIp / artifactReaper / searchIndex / publishAt / revision / migration / health.controller / unlockBruteforce / mdzImport / logRotate / backupVerify，恰恰是最近几轮补的安全与备份钉子。白名单的问题是它**只会烂**：新增 spec 默认不跑，而"CI 绿了"让人以为全跑过了 —— 本项目已经因此让一条永久红的 e2e 混过 20 次。现在改成**默认全跑**、确实不能在 CI 跑的才排除 —— 而目前排除清单为**空**，三条理由全写进 workflow 注释：要真库的 `searchIndex.realdb.spec.ts` 自己默认 `describe.skip`（`VANBLOG_SEARCH_REALDB_URL` 指到一次性库才跑）；`test/` 下要 mongod 的 e2e 被 jest 的 `rootDir=src` + testRegex 天然排除，各有独立的 `test:*-e2e` 命令、独立端口与"拒绝 27017/拒绝真实库名"的硬护栏；walineMongo / fullBackup / initJwt / audit-hardening-round2 里的 MongoClient 都是假的、不需要真库（本来就在白名单里、CI 一直绿）。
- **本会话：`scripts/build-image-local.sh` 的冒烟测试在 podman 上一步都跑不了 —— `--link` 是 docker 专有 flag**。本轮真去构建镜像才撞上：镜像建好了（892 MB），冒烟第一步就 `Error: unknown flag: --link` 直接 die。也就是说**在只有 rootless podman 的机器上（本机 docker 组是空的），这个"构建 + 冒烟"脚本的冒烟半边从来没跑过** —— 而它存在的理由正写在脚本开头："镜像里的问题在本地跑测试是发现不了的，前面连着四轮都是用户装的时候才炸"。容器名 DNS 也不是出路：rootless podman 常常没有 aardvark-dns（本机就没有）。改成 `scripts/vanblog-drill.sh` 里那条**本机验证过**的路：专用网络 + `inspect` 取 mongo 的容器 IP（最多重试 30 秒，拿不到就明确失败而不是静默用空值）+ `--add-host` 把名字写进 `/etc/hosts`，拆容器时连网络一起拆（`SMOKE_KEEP=1` 时把拆网络的命令一起打印出来）。修完冒烟**真跑通了**：8 条关键路径（`/`、`/api/public/meta`、`/admin`、`/robots.txt`、`/sitemap.xml`、`/rss/feed.xml`、`/post/1`→404、`/timeline`）、8 条已知故障特征全空、容器 0 重启、SIGTERM **1s** 内优雅停机。守卫 `scripts/tests/build-image-local.test.sh` 加 6 条（35 → **41 条全绿**）：⚠️ "不许再用 `--link`"这条负向断言必须打在**剥掉注释之后**的代码上 —— 解释这个坑的注释本身就写着 `--link`，grep 整个文件会自己把自己判红（同一类坑本仓库已记了五处）。
- **本会话：`vanblog.sh drill`（恢复演练）被同一提交里的初始化密钥默认值打断了 —— 它从来不传 `setupKey`**。`VANBLOG_INIT_REQUIRE_SETUP_KEY` 默认开启意味着**两条**匿名初始化接口都要带密钥，其中就包括演练走的 `POST /api/admin/init/restore` ⇒ 恢复必然 400 `setupKeyRequired`。而这个命令的全部意义就是"把"备份能不能恢复"从信仰变成一条命令的证据"，它与那个默认值是**同一个提交**（9601faa4）落地的。它自己的 573 条断言全绿也没发现：那些用例驱动的是**假 HTTP 层**，只有真起容器才撞得到这道闸门（本轮真跑了一次才炸出来，与字体、`--link` 两个问题同一批）。修法是按运维真会走的路取密钥：`exec` 进容器 `cat /var/log/setup.key`（0600，在**命名卷**里，宿主机读不到；`VAN_BLOG_LOG` 可能指到 `/app/log`，两个路径都试），拿不到再从容器日志兜底（密钥块启动印一次、之后每 `VANBLOG_SETUP_KEY_REMIND_MINUTES`（默认 10 分钟）重印）。⚠️ 兜底锚在字面标签 `初始化密钥： ` 上而不是裸抓 base64 —— 同一份日志里还有 `restore.key` 与 jwt 材料，形状一样，而**送错密钥比不送更难查**（400 长得完全相同），这条有专门的钉子（放两个诱饵秘密 + 真密钥，必须取出真的）。密钥全程当秘密处理：`umask 077` 写 0600 临时文件、用 curl 的 `-F "setupKey=<文件"` 送（**值不进命令行**，否则 `ps` 里谁都能看）、发完就删、变量立刻清空、台账只记**字节数**（实测 44 = 32 字节随机数的 base64）不记内容；两路都拿不到就 WARN 后不带密钥上传，绝不猜一个值。另加一条诊断：4xx 且响应体提到 `setupKey` 时点名 `setupKeyRequired` 与密钥来源，免得用户去怀疑自己的备份。**活体证据**（新镜像 + 69 MB 生产整站备份 + `--keep`）：`RESULT: PASS pass=37 warn=1 fail=0 note=5`，恢复出的站点在 `:18080` 上 200 且是真语料，第二次恢复正确 403，唯一那条 WARN 是 `migrations` 集合的往返（归档早于该集合，8 条是新 server 自己建的）；初始化成功后 `setup.key` 被 server 自己删掉（只剩 `restore.key`），与该功能的生命周期一致。守卫 573 → **587 条断言全绿**。⚠️ 教训与 CI 白名单那条同源：**假 HTTP 层证明得了编排逻辑，证明不了 wire 契约** —— 凡是"打真接口"的命令，必须至少真打一次。
- **本会话：两个脚本测试套件的 hermetic 修复 —— 环境造成的假红，不是产品回归**。① `vanblog-install-cron.test.sh` 的 tty 用例：**有 `script` 命令 ≠ 能起 pty** —— 沙箱不给 `/dev/ptmx` 时 `script` 报 `failed to create pseudo-terminal`，pty 里的程序根本没跑起来，三条断言以"没提示 token / env 文件没写"的形式假红，看着像产品坏了（实测探测退出码 1）。现在先真起一次 pty 探测（`script -qec true`），起不来就打印 NOTE 跳过（在能起 pty 的机器 —— 普通终端 / CI —— 这几条照跑），**源码级断言（token 的 `read` 带 `-s` 静默）无条件保留** —— 跳过 pty 用例时覆盖不至于归零。② `vanblog-drill.test.sh` A14 的 4 条 dry-run 断言：dry-run 虽然一个容器都不建，但**仍然会探测引擎**，探不到就 FAIL + rc=1 —— 沙箱不给 `/dev/shm` 时 rootless podman 起不来（`failed to open 2048 locks in /libpod_rootless_lock_1000`）、没有 docker 组时 docker 一律 EACCES，受限环境里这是常态而不是异常；A14 要钉的是"vanblog.sh 把子命令转发给 drill、退出码原样穿回来"，不是"这台机器装了引擎" ⇒ 改用**本节专用假引擎**（按 `drill_resource_exists` 的四种调用形状逐一给答案：容器/卷/网络都不存在、镜像在本地）。⚠️ 不能复用已有的 `FAKE_BIN` stub：它已被 A11 改写成"inspect 一律成功"（那节演的是"容器起不来但必须拆干净"），名字冲突预检会认为 vb-drill-* 全都已存在 ⇒ 假 FAIL。另加两条 not-contains 断言：截断归档那条 rc=1 必须来自**预检**，不是"没有可用的容器引擎"也不是"名字冲突"—— 否则环境不对的机器上它会因为错误的原因变绿（rc 都是 1）。
- **本会话：文档补齐轮 —— 上面这些功能与行为变化全部收进文档站**。20 个 docs + README 共 **+797/−116 行**：搜索（结果页/静态索引/回退路径/诚实局限）、初始化密钥与零接触初始化（含 compose 示例与"怎么关"）、swagger 默认关、health 详情字段新口径（"版本号始终公开"及其理由）、访问密码 scrypt（**不可找回** + 表单语义对照表）、`.mdz` 导入、可见水印重写（样式表 + `VANBLOG_WATERMARK_*` 全表）、恢复修剪与缺失集合开关、drill 的四个子命令表、以及**升级对照表**（`docs/guide/update.md` 顶部新增"升级前要知道的行为变化"—— 每行"你会看到什么 / 不想要怎么办"）。环境变量全量清单（`docs/reference/env.md` 净增 252 行，+266/−14）按"可见水印（2026-09 重写）"等分块重排。⚠️ 守卫抓到一条**真 FAIL**：`docs/reference/env.md` 曾把 `VANBLOG_WATERMARK_FONT_MIN_PX` / `_MAX_PX` 写成环境变量 —— 代码**从来没读过**它们（设了不会有任何效果），它们实际是 `watermarkSvg.ts` 里的导出常量（每样式的字号上下限）；env 登记与文档条目都已删除，env.md 留了一段"历史说明"。
- **验证（本轮本机实测）**：server `jest` **169 套件 / 1951 用例 —— 1944 绿 + 7 跳过 + 0 失败**（59s；修复前 3 个套件红，且旧基线里唯一的既有失败 —— `#322` 水印字体用例 —— 随 jimp 移除而消失转绿）。website `vitest run` **84 文件 / 885 用例全绿**（26.6s）。admin `node --test tests/unit` **148 套件 / 579 用例全绿**（修跨包锚点前 575 用例 3 失败）。`scripts/tests/*.test.sh` **24 文件 / 1768 条断言全绿**（drill 587、install-cron 96、build-image-local 44、dockerfile-alpine-sharp 32，均为本轮实测）。类型检查：server `tsc -p tsconfig.dev.json --noEmit` 0 错、website `tsc --noEmit` 0 错。文档守卫：`docs-links` 5/5；`cd docs && pnpm run docs:build` 成功（65 页 / 19.5s）。⚠️ 两件事如实记录：**admin 的 playwright e2e 未跑**（本机没装 playwright 浏览器；表单类改动只验证到"编译通过 + 单元钉子"）。`docs-consistency` 现在 **52 过 / 0 挂**：那条 FAIL 的起因是 env.md 的"历史说明"仍**拼出** `VANBLOG_WATERMARK_FONT_MIN_PX` 全名、而代码侧 `WATERMARK_ENV` 登记已删除 —— 收敛办法是把历史从文档里挪走（留在本 CHANGELOG 与提交信息里），文档只写现在的事实，并补上"字号夹取范围是 `watermarkSvg.ts` 的导出常量、要调请用 `VANBLOG_WATERMARK_SCALE`"。⚠️ 顺着这条 FAIL 还挖出**该脚本里一条从来没跑过的守卫**（"文档不能有裸尖括号占位符"）：它的 heredoc 参数写在结束符**之后**，bash 把 `"${ROOT}"` 当成一条新命令执行（屏幕上那句 `line 242: …: Is a directory` 就是它），python 拿不到 `argv[1]` ⇒ IndexError ⇒ stdout 空 ⇒ `[[ -z … ]]` 成立 ⇒ **PASS**，而它实际扫描的文档份数是 **0**。修法是参数前置 + python 先打一行 `SCANNED=<份数>` 当"我真跑了"的凭据（<20 判 FAIL）+ 检查子进程退出码；修完第一次真扫 **73 份**，立刻抓出一条 `<https://github.com/CKboss/vanblog/pkgs/container/vanblog>` —— 那是**合法**的 Markdown 自动链接（文档站带着它构建过、65 页全绿），会炸的是里面再套一层尖括号的形状，所以规则收窄成"`<http(s)://…>`/`<mailto:…>` 且内部不含 `<` 才放行"，并做了四种形状的负向对照。**教训：凡是把子进程输出当判据的守卫，必须同时钉住"子进程真跑了、而且扫到了东西"，否则它绿不绿与代码质量无关。**

**行为变化**

> 每条按「以前怎样 → 现在怎样 → 怎么回到旧行为（如果有开关）」写。本节只收 Unreleased 范围内的**故意默认值/默认行为变更**；
> 另有几条未在本节单列的（整站恢复默认修剪静态目录、缺失集合只报告不删除、防爆破计数改按可信客户端 IP 分桶、
> 文章版本历史默认开、无近期已校验备份时启动多一条 WARN），见上面对应条目与 [docs/guide/update.md](docs/guide/update.md) 的升级对照表。

1. **`/swagger` 默认从开变关**。以前：`/swagger` 与 `/swagger-json` 默认匿名可访问，`VANBLOG_SWAGGER` 设成字面 `false` 才关。现在：**默认关**，只认字面 `true` 才开；后台「关于」「Token 管理」两个深链点自动探测，关着时改开仓库里的 API 文档并提示确切的环境变量名。回到旧行为：`VANBLOG_SWAGGER=true`。
2. **匿名 `/api/public/health` 字段收口 —— 版本号回来了，uptime/内存门控**。以前：匿名可读 `version`（含精确 commit）、`uptimeSeconds`、`memoryRssMb`、`heapUsedMb`；本轮中段曾把四样**全部**藏掉，最终站长裁定**版本号不是秘密**（它本来就渲染在每个前台页面的页脚、也从 `/api/public/meta` 下发，只在这里藏属于安全表演）。现在：匿名 payload **又包含 `version`**，`uptime` 与内存**仍需要** `x-vanblog-internal` 令牌（常量时间比较；⚠️ 回环地址**不算**内部）或显式 `VANBLOG_HEALTH_DETAILS=true`（只认字面 `true`）。相对 v2026.9.1 的净变化：匿名调用者少了 uptime/内存，版本号不变。回到旧行为：`VANBLOG_HEALTH_DETAILS=true`（或带内部令牌）。
3. **访问统计默认保留期 0（永不删）→ 3650 天（10 年）**。以前：`VANBLOG_VISIT_RETENTION_DAYS` 默认 0，按天的访问/浏览行永久保留（匿名接口能用编造路径把 `visits` 无界撑大）。现在：默认 3650，每日维护任务删窗口外的**按天行**；站点级累计与每篇文章的累计阅读量不受影响，`minKeepDays=30` 兜底。回到旧行为：`VANBLOG_VISIT_RETENTION_DAYS=0`。
4. **文章/分类访问密码改存 scrypt 哈希 —— 忘记即不可找回**。以前：明文存库（拿到数据库或整站备份 = 拿到所有加密文章的密码），后台表单会回填密码。现在：只存 scrypt 哈希（与登录口令同参数），任何接口不回显密码或哈希（表单只拿到 `hasPassword` 布尔）；**留空 = 不修改**，解除加密必须显式勾「清除密码」；存量明文由启动期幂等清洗自动收敛，不用动手。⚠️ **没有任何找回通道**（登录用的恢复密钥也救不了它），忘了只能登录后台显式清除/重设。无回退开关（安全修复，有意为之）。
5. **静态资源、feed、sitemap、swagger 进限流器与安全头**。以前：这些响应在 Nest 中间件安装之前就结束，**完全绕过限流**（静态独立桶是从未执行到的死代码），也没有 `X-Frame-Options` 等安全响应头。现在：pre-Nest 中间件统一先跑安全头 + 限流 —— `/static/**` 进独立桶（默认 6000/min，全局的 10 倍），`/rss/**`、`/sitemap/**`、`/swagger*` 进全局桶（默认 600/min），`X-Powered-By` 移除；容器内部回环直连（SSR/ISR/waline，不带转发头）仍整体豁免。影响：以前超预算抓这些路径的东西（误配的 CDN 回源、抓 spec 的 CI）会开始收到 429。没有关闭开关；预算用 `VANBLOG_STATIC_LIMIT_PER_MIN` / `VANBLOG_RATE_LIMIT_PER_MIN` 调。
6. **匿名初始化默认要求初始化密钥（只影响未初始化的站点）**。以前：未初始化期间向导（`POST /api/admin/init`）与恢复（`POST /api/admin/init/restore`）纯匿名，谁先请求谁就能把新站初始化成自己的。现在：`VANBLOG_INIT_REQUIRE_SETUP_KEY` **默认开**，两条匿名接口都必须携带 `<日志目录>/setup.key` 里的密钥（每次启动生成、重启作废、每 10 分钟在日志里重印、初始化成功后自动删除）；初始化页自动出现密钥输入框；「正走到一半」的安装升级后要从日志/文件取一次密钥。也可以用零接触初始化（`VANBLOG_ADMIN_USER` + `VANBLOG_ADMIN_PASSWORD[_FILE]`）让这个窗口根本不存在。已初始化站点完全无感。回到旧行为：`VANBLOG_INIT_REQUIRE_SETUP_KEY=false`（公网不建议）。
7. **可见水印默认样式与渲染实现都换了（jimp → sharp/libvips + SVG）**。以前：jimp + `.fnt` 位图字体，右下角半透明灰色小字，不支持中文，"宽高小于 128px 的图片可能加不上"。现在：sharp/libvips + SVG（先按 EXIF 摆正、字号按图自适应），默认样式 **tile（满图斜排平铺、旋转 −26°、裁不掉）**，另有 corner/bar；短边 <52px 跳过（WARN + 原图），sharp 编不了的格式（bmp/heic/ico/svg）返回原图（⚠️ 旧实现能写 bmp），缺字体时返回原图（宁可不盖也不盖满图豆腐块）。没有回到 jimp 实现的开关；最接近旧版观感 = `VANBLOG_WATERMARK_STYLE=corner` + `VANBLOG_WATERMARK_POSITION=bottom-right`。
8. **后台不再拦中文水印文字**。以前：保存含中文的水印文字被 Modal 拒绝（「目前水印文字不支持中文！因为用了纯 js 库节约资源」）。现在：闸门与其 helper（`checkString.ts`）删除 —— 渲染重写后拦截的前提不存在了，中文照常能盖（官方镜像已装 Latin + 中文字体）；两处过时文案（"右下角"、"128px"）改成事实（满图斜排平铺、短边 52px）。无开关，也不需要回退。
9. **生产镜像新增三个字体包**。以前：runner 阶段（node:24-alpine）**一个字体包都没装** ⇒ 可见水印在镜像里等于功能不存在（上传不失败、一张也盖不上，只有一条 WARN）。现在：`apk add fontconfig ttf-dejavu wqy-zenhei`（Latin + 中文；故意不装 font-noto-cjk —— 体积是 wqy-zenhei 的十几倍，pango 逐字符回落够用），守卫脚本解析真正的 `apk add` 命令钉住这三个包（含"删掉字体行守卫必须变红"的负向对照）。⚠️ 镜像体积代价：**860 MB → 892 MB（+32 MB，+3.7%）**（本机真构建实测；`/usr/share/fonts` 28 MB，`fc-list` 0 → 25 条）。装字体**之前**的行为也实测过，比"功能静默失效"更糟：旧镜像里 `example.com` 会盖出 **20,684 个变化像素的 .notdef 方块**（2,804 → 22,263 B）、中文 8,170 个，而且两段不同的等长中文（`酱油的博客` 与 `鼠标键盘垫`）产出**逐字节相同** —— 铁证画的是方块不是字，也就是说旧镜像在给**每一张上传图**盖满方块。装完之后：Latin 17,521 px、中文 19,250 px，两段不同中文**不再相同**（真字形）；再把镜像里的 fontconfig 指向一个空配置做负向对照，Latin 与中文都**跳过 + WARN、0 px**（宁可不盖也不盖方块）。这条没有开关 —— 回到旧行为等于删掉三个包，后果是水印重新静默失效。

## [v2026.9.1] - 2026-09-17

> `v2026.09` 之后的全部改动。这一轮的主线是**把整站备份/恢复真正修好**（三个"看着成功其实没成"的 bug）、
> **一整轮逻辑与性能加固**（限流可被一个请求头绕过、三处无界内存增长、热路径 3.7–96×、导入 975× 往返），
> 以及**整套依赖现代化**（Node 24 / NestJS 10 / mongoose 8 / Next 14 / TypeScript 5.9 / sharp 0.35 / multer 2）。
> 访问性能的实测数字与复现命令见 [docs/advanced/benchmark.md](docs/advanced/benchmark.md)。

**新功能**

- **插件式前台主题（换肤）**：后台 `系统设置 → 主题` 里上传一份 CSS 就是一个新主题，点「启用」后前台**刷新即生效** —— 不用改代码、不用重新构建、不用重启容器。主题 id 会写到 `<html data-ui="…">` 与 `.vb-root` 上，所以每份主题都用 `[data-ui="<id>"]` 收窄作用域，多个主题共存、随时切换、互不残留；暗色跟着站点已有的 `html.dark` 机制走。内置的 `Apple 风格` 与 `默认` 仍打包在前台产物里，上传的主题存 `<图床目录>/themes/<id>-<hash8>.css`（跟着静态目录一起备份），由 `GET /api/public/theme.css` 以**固定地址 + ETag/no-cache** 提供 —— 这样换主题不依赖静态页面有没有重新渲染完。上传时做安全校验（≤512KB、只收 `.css`、拒绝 `javascript:` / `expression()` / `behavior:` / `-moz-binding` / `</style>` / `<script>`，远程 `@import` 允许但警告），并且**扫描的是去掉注释之后的文本**：示例主题的注释里就会写"javascript: 会被拒绝"，扫原文会把它自己拒掉。`站点配置 → 界面风格` 的下拉框也会列出上传的主题。附一份可直接上传的示例主题与开发文档（含从零写一个主题的教程、稳定钩子表、限制与接口）。[主题](docs/features/theme.md)

**运维 / 部署（一键脚本 v0.6.0 与编排模板）**

- **mongo 健康检查 + vanblog 按本机 compose 能力决定要不要等它**：编排模板给 mongo 加了 `healthcheck`（`mongosh … || mongo …` 的 ping —— 4.4 没有 mongosh、6.0/7.0 没有 legacy mongo shell，必须两个都试；`interval 10s / timeout 5s / retries 5 / start_period 40s`），干掉了模板注释里自己承认的"首次启动 server 连不上库、容器要重启几次才稳"。`depends_on` 的 `condition: service_healthy` 长格式要 docker-compose ≥1.27 / compose v2（**实测** 1.25.5 的 v3.x schema 里 `depends_on` 只是 list_of_strings），Ubuntu 20.04 自带的 1.25 会解析失败 —— 所以模板**提交的是所有版本都解析得了的列表形式**，由 `./vanblog.sh config` 在生成编排文件时拿一个带 `condition:` 的最小临时文件跑一次 `docker-compose config` **实测**本机（不猜版本号）：支持就升级成长格式，不支持就保持列表形式并打印一行原因；已生成长格式的文件遇到老 compose 会被降级回去。⚠️ 顺带把模板 `version` 从 `'3'` 提到 `'3.4'`：`start_period` 在 docker-compose v1 的 3.0–3.3 schema 里**不存在**（`additionalProperties:false`，1.25 直接拒绝整个文件），3.4 起才有（compose v2 忽略 version；3.4 需要 docker-compose ≥1.16 / Engine ≥17.09）。
- **`./vanblog.sh verify`：备份归档校验（不解压落盘）**。server 导出的 manifest 里**没有校验和**（`fullBackup.ts` 只写 `archiveBytes`，已核实），归档坏了要等恢复解包时才由 CRC 发现。现在三步校验：流式过一遍解压器（`zstd -t --long=27` / `xz -t` / `gzip -t`，截断当场抓住）、比对 sha256（见下一条）、列成员清单核对预期内容（`./manifest.json`、各集合 `db/<库>/<集合>.ndjson`、`static/` 树；空站点没有静态树只提示不算失败）。不带参数 = 校验备份目录里的全部归档；任一 FAIL → 退出码非 0（可进监控/cron）。没有 sha256 记录的归档（后台/接口导出的）照常校验并明说"跳过比对"，**恢复不受任何影响**。
- **脚本做的备份会记 sha256 sidecar**：`backup`（整站）与 `backup --offline` 成功后在归档旁写 `<归档>.sha256`（格式同 `sha256sum` 输出，拷归档去别处时带上它，异地也能验）；`verify` 优先用它。保留策略清理时连带删 sidecar，且 `.sha256` **不再被当成一份归档**参与计数（它匹配 `vanblog-full-*.tar.*` 这个 glob，不过滤会把份数算错）；`restore` 的归档选择列表同样排除它。
- **备份前的磁盘空间预检**：估算值（有上一个整站归档用它的大小；没有 = 静态目录实际占用 + 数据库导出按 64MB 猜；offline = 数据目录实际占用）加余量（默认 256MB，`VANBLOG_BACKUP_SPACE_MARGIN_MB` 覆盖）超过目标文件系统剩余就**拒绝备份**（非 0 退出），只是偏紧（剩余 < 估算×2+余量）则警告后继续；`VANBLOG_BACKUP_SKIP_SPACE_CHECK=1` 跳过。估算或 `df` 拿不到时**明说"跳过检查"并放行**，不假装检查过。server 侧 ENOSPC 本来会优雅失败并清掉半成品，但大站上已经白等几分钟；offline 的 tar 更会留下截断的归档。
- **`./vanblog.sh install-cron`：内置的定时整站备份**（菜单 14）。写进 root 的 crontab，默认每天 03:00、`VANBLOG_BACKUP_KEEP=7`、`VANBLOG_ASSUME_YES=1`，日志到 `<数据目录>/log/vanblog-backup-cron.log`；支持 `--hour N` / `--keep N` / `--remove` / `--force`。**幂等**：已有同样的条目不重复加（rc 0），参数不同则拒绝、要显式 `--force`；**绝不覆盖已有 crontab**（只在带 `# vanblog-backup-cron` 标记的行上追加/过滤，`crontab -l` 报"没有 crontab"以外的错误时宁可不装，写入后回读确认）；写入前展示将添加的整行。token 的处理是诚实的权衡：`VANBLOG_ADMIN_TOKEN`（环境变量或交互输入，不回显）写进 `<安装目录>/vanblog-cron.env`（**0600 仅 root**）由 cron 行 source —— 一个长期有效的管理员 token 明文落盘，文件头与文档都写明了作废方法；不给 token 也能装，但会明说"备份会在登录一步失败"。没有 `crontab` 命令时给出可照抄的手工步骤。
- **下载回退改成 fork 优先**：编排模板与脚本自更新的回退顺序从「本分支 raw → 上游文档站 → 上游 raw → 上游 jsDelivr」改成「本分支 raw → **本分支 jsDelivr**（`gh/CKboss/vanblog@dev/dsh`）→ **本分支 Release 附件**（`release-fork.yml` 挂的 `vanblog.sh` / `docker-compose-template.yml`，默认 `releases/latest/download/`，`VANBLOG_RELEASE_TAG` 可钉 tag）→ 上游三源兜底」。以前本分支 raw（就是 raw.githubusercontent.com，大陆网络常常不通）一失败就**静默退到上游产物**，丢掉本分支全部加固；现在 fork 的三个源全部试过才轮到上游，照旧打印实际用的 URL、照旧做下载后校验（`bash -n` / 占位符）。实测 fork 的 jsDelivr 分支 URL 返回 200、`releases/latest/download/vanblog.sh` 302 到 `v2026.09` 的附件。
- 文档同步：`docs/guide/backup.md`（verify / 空间预检 / install-cron 与 token 权衡）、`docs/faq/deploy.md`（新回退顺序、healthcheck 与 depends_on 两种形状的对照表、**一键脚本用 root 管道执行作者主机 `docker.sh` 的警告**）、`docs/guide/script.snippet.md`（回退顺序、常用命令、docker.sh 警告）；`show_usage` 与交互菜单加了 `verify`（15）与 `install-cron`（14），老编号全部不变。

**性能（IO 与并发，全部有压测前后对比）**

- **前台首屏再降 12–13%（生产构建实测）**：markdown 渲染器从两档变三档，新增 **`MarkdownPlain`**（不含 highlight.js / KaTeX / mermaid），由"正文里到底有没有围栏代码块"决定走哪一档 —— 以前只要渲染 markdown 就会带上 **65,890 B gzip 的 highlight.js**，哪怕整篇一个代码块都没有。实测页面引用到的全部资源 gzip 之和：首页 **458,979 → 398,286 B（−13.2%）**、`/link` −13.0%、`/about` −12.2%；53 篇文章里**仍有 8 篇**照常带高亮；全局 CSS 的 hash 前后一致（纯 JS 改动，不可能影响样式）。嗅探刻意"宁可误判不可漏判"：误判只是多下载一个 chunk，漏判会让代码块没高亮。
- **阅读量不再串行请求、也不再是错的**：以前每张列表卡都在 `useEffect` 里请求一次 `/api/public/article/viewer/:id`（首页 5 次串行 XHR，每次回一个 ~220B 的整条 visit 文档只为显示一个整数），卡片先显示 `"..."` 再跳成数字。现在直接用 pageProps 里已有的 `article.viewer` 渲染、后台刷新走 50ms 合并器（抄评论数那套写法）。浏览器实测首页客户端请求 **42 → 37**，首屏就是真实数字。**而且旧数字本身是错的**：那个接口读的是"按 pathname 记的台账"，引入拼音别名后同一篇文章被拆成两条（数字 id 一条、别名一条），卡片显示的是半截计数；`article.viewer` 才是原子累计值。
- **`revalidate` 加下限与 NaN 兜底**：delay 模式以前默认 **10 秒**（有流量的页面每 10 秒一次完整 SSR + 两次 API），非数字还会让 Next 构建期报错；另外 `fallback:"blocking"` + `revalidate:{}` 意味着按需生成的页面**永不过期**，revalidate 触发一丢就一直旧 —— 现在有了很长的兜底周期，能自愈。
- **浏览统计：每次浏览 8 条 Mongo 命令 / 4 次写 → 约 1 条**（metas/articles/viewers/visits 四个集合原来各记一遍同一件事）。改成内存合并 + 定时/退出/超阈值三种时机落库；用 mongod 的 `serverStatus().metrics.commands` 差值实测：1 浏览/秒时 **8.00 → ~1.0 命令**，一个窗口 20 次浏览时 0.20，100 次时 0.05；**SIGTERM 会把缓冲落库**（实测"6 次浏览 → 4 次 Mongo 命令"），硬杀也不再丢计数。
- **去掉每请求的固定开销**：`InitMiddleware` 以前每个 API 请求都 `users.findOne({})`（顺带把密码哈希读进内存），现在缓存"是否已初始化"，公开接口从 2 次 find 降到 1 次；`initJwt` 以前启动时**连两次** Mongo 且两个 MongoClient 都不关（泄漏客户端与它的 SDAM 定时器），现在只连一次并复用密钥；后台日志页以前每次都**整文件逐行读 + 逐行 JSON.parse**，现在按尾部限界读取。
- **`visits` 重复行修掉（数据完整性）**：`VisitProvider.add` 的"重复键兜底"依赖一个**根本不存在**的 `{date,pathname}` 唯一索引，并发首访会静默产生重复行（真 mongod 复现：8 个并发首访 → 8 行），之后 `findOneAndUpdate` 改的是任意一行。现在启动时合并重复组并建唯一索引（幂等、有日志、不在请求路径里）。⚠️ 合并取 **max 而不是 sum**：这两个字段是**按路径的累计快照**而非当天增量，线上那两组同一天是 2270 与 2266，**求和会得到 4536，正好是真实值的两倍**。合并后重复组 2 → 0。另加可选保留期 `VANBLOG_VISIT_RETENTION_DAYS`（默认 **0 = 永不删除**，挂在已有的每日 cron 上，无论设多少都保留最近若干天）。
- **website 子进程的重启竞态**：`stop()` 置空 ctx 并 kill，但子进程的 exit 处理器会无条件 respawn —— 优雅停机时可能留下一个 detached 孤儿进程（还在继续服务、还会跑定时任务）。现在照 waline 的做法加了 `stopping` 标志，那个**从未被赋值**的 `starting` 互斥量变成真的，respawn 也加了有限退避。
- **前台/后台代码健康一轮：23 项修复（泄漏 · 复杂度 · 静默失败），website 测试 69 文件/686 → 77/748、admin 87 套件/347 → 94/363**。泄漏侧：**medium-zoom 改全站单例**（每个旧实例会在 document/window 上挂 **4 个无法移除**的全局监听，而以前每张正文图、每个 ImageBox 各建一个且零清理 ⇒ 10 图文章 + 2 个 ImageBox ≈ 每次导航永久多 48 个监听，200 次导航 ≈ 9600 个死监听且闭包钉着已卸载 DOM）；文章页 TOC 的 headroom 补上清理（AuthorCard 同款 bug 的漏网之鱼）；**waline 生命周期重写**（旧实现父组件重渲染一次就销毁评论区且**永不重建**，若重渲染发生在设置请求在飞时则**永不初始化**）；**评论数/阅读量两个合并器的三处同款缺陷**（一批超过 50 个 id 时溢出部分被静默丢弃 ⇒ 评论数显示成假的 0、阅读量永远 `...`；请求失败被永久缓存 ⇒ 一次抖动让整个会话评论数全 0 或评论区静默关闭；模块级 Map 无上限）；admin 表情选择器"从第二个编辑器会话起静默失灵"+ 编辑器实例与整棵 Picker 树被模块变量钉住；Code/Editor 页的 Ctrl+S 监听**每敲一键重注册一轮**；BackToTop 的节流未取消、依赖抖动，以及它在 document **捕获**监听里 `stopPropagation()` 把滚动事件从 TOC 高亮手里拦走；**前后台的"自动主题 10s 轮询"其实都是死功能**（effect 依赖里混着每次渲染新建的闭包 ⇒ cleanup 每次都清掉 interval 而门闩不重建，从未生效且无报错）。复杂度侧：**markdown 在每次重渲染时整篇重解析**（JSX 里现建的 remarkRehype 选项对象让下游 useMemo 必然失效；同一篇文章页上全文解析实际发生**三遍** —— 正文 viewer + TOC 提取 + `hasToc`；实测 7.9KB 文章一遍 ≈66ms）已改成模块常量 + 按内容 memo，渲染输出逐字节不变；时间线排序不再在比较器里反复 `new Date()`（装饰-排序-还原，n=20,000 实测 **308ms → 26ms**）；`washArticlesByKey` 从 O(键数×n) 改单遍分桶（n=10,000/20 键实测 **118ms → 19ms**，输出含键序与旧实现逐字节一致）；另清扫 9 处"`useMemo` 依赖写 `props` 整个对象"的失效 memo。静默失败侧：meta 接口异常 payload 不再被当成功返回并缓存 5s、构建期兜底值也不再入缓存（以前一次瞬时抖动会把占位数据烤进静态产物）；搜索失败不再永远"搜索中..."（并加过期响应守卫与独立失败文案）；访客统计的解构 TypeError 不再变成无人处理的 rejection，且 `noViewer` 在 `_app` 与 PostViewer 两处**语义不一致**（一处 truthy 一处 `=== "true"`）已对齐；页脚不再渲染 `© NaN`、运行时长不再每秒刷 `NaN天…`、文章页坏日期不再让**整篇 SSR 500**（新增 `utils/safeDate.ts`）；TOC 在 items 为空时不再每个滚动事件抛一次；admin 日志查看器的空 `catch {}` 改成 Alert + console.error（失败不再与"没有日志"长得一样）；图片删除失败不再把整页卡在 Spin 里；`useNum` 的 NaN 直通、JWT `expiresIn` 的 0/负值（**原样进 JWT ⇒ token 出生即死**，登录看着成功、下个请求被踢）都在表单层夹住。所有修复默认行为不变，只有失败路径的渲染从"假的 0 / 卡死的转圈 / NaN"变成占位符或明确错误文案。
- **request-id 与请求级日志**：每个响应回显 `x-request-id`（入站的合法 id 会沿用 —— 但要过 `^[A-Za-z0-9._-]{1,128}$` 白名单，因为那个头客户端可控，不校验就是一个日志注入口子；否则生成 UUID），5xx **必打**一条带 id 的 ERROR，超过 `VANBLOG_SLOW_REQUEST_MS`（默认 5000ms，0=关）打慢请求 WARN，`VANBLOG_ACCESS_LOG=true`（默认关）可开"每个非静态请求一行"的访问日志。中间件挂在链路**最前**，所以连 429 也带 id；无同步文件 I/O、用单调钟、响应体零改动。用户报障时报出响应头里的 id，就能在日志里定位到同一行。⚠️ express 层的早退（body 解析器的 413、直发的 `/static/**`、静态目录的 403 兜底）在 Nest 中间件之前结束，这些响应没有 id。
- **前台允许缩放（WCAG 1.4.4）**：viewport 去掉 `user-scalable=no`，低视力用户可以在手机上放大正文。代价是 iOS Safari 聚焦小字号输入框时会自动放大页面（可双指缩回）；仓库里没有任何测试或注释依赖旧行为（查过），新 spec 把 viewport 字符串钉死并全树扫描防回归。把输入框字号抬到 16px 能避免自动放大，但那是视觉变更，本轮没动。
- **修好一个先于本轮就红着的 CI 套件**：`test/backup-restore.e2e-spec.ts` 少传 `BackupController` 的第 12 个构造参数（整站备份那轮加的），整个套件编译失败 ⇒ CI 里的 `test:backup-e2e` **在本轮之前就是红的**；补上后 6/6 绿。
- **picgo 插件安装默认关闭**（`VANBLOG_ALLOW_PICGO_PLUGINS=true` 才开）：picgo 1.5.6 拖进来的 `git-clone@0.1.0`（命令注入，**上游无修复**）与 `decompress`（路径穿越，无修复）意味着"后台可配的插件字符串"= 拿到后台会话就能在容器里以 root 执行代码。关着时给明确报错，其余上传链路不受影响。
- **cluster 模式（默认关）**：`VANBLOG_CLUSTER_WORKERS` 默认 **1 = 与今天完全一致**。单进程 Node 是动态请求的实测天花板，开多进程才能真正乘以核数；两个 cron、两次子进程 spawn、启动期 wash、首轮全量 ISR/RSS、统计维护都限定在 primary，限流与连接池预算按 worker 数均摊，primary 先解出 JWT 密钥再 fork 并转发 SIGTERM。⚠️ 多进程路径只有注入假对象的单元测试，**没有真以 N>1 跑过**，且内存随 worker 数近似线性增长（与"占用更低"相反），要自己压测过再开。
- **更正一条我们自己写错的结论**：AGENTS §7.38.2 曾说"ByteMD 编辑器进了每个 markdown 页面的首屏 JS，估计 150–250KB"。跑了真 `next build` 之后逐个 chunk 搜 `CodeMirror`/`tippy`/`popper`/编辑器工具栏字符串，**一个都没有** —— 那份"1148 个模块"的证据取自 **dev/server chunk**（未压缩、未 tree-shake）。编辑器本来就没进客户端包；真正的大头是 highlight.js。（`MarkdownView` 仍改成不 import `@bytemd/react` 那个桶并加了 spec，属于防回归。）顺带一条经验：Next 的 First Load JS 表**不统计 `dynamic(...,{ssr:true})` 的 chunk**，看那张表会以为什么都没变。
- **`visits` 索引瘦身 + 后台仪表盘去 N+1**：删掉 `visits.date_1` 与 `visits.pathname_1` 两个纯前缀重复索引（删除前把代码里**每一条** visits 查询都 explain 过一遍，winningPlan 全部不变；保留期清理自动改走 `{date,pathname}` 唯一索引的前缀，仍是索引扫描），`totalIndexSize` **1,183,744 → 897,024 B**（低于上一轮改动前的 937,984 B），每次写少维护两个索引；在启动维护里幂等执行、**只在替代复合索引确实存在时才删**（`VANBLOG_VISITS_DROP_REDUNDANT_INDEXES=false` 可关），4 次重启实测第二次起都是"无可删"。后台仪表盘的 `getViewerGrid` 从 num+1 次串行 `findOne` 改成一次 `$in` 查询（31 天 = 31 次往返 → 1 次），响应与旧实现**逐字节相同**（新旧算法对拍 8 个场景 + 活体接口 diff 3,307 B 一致，连"今天回落到昨天"那个顺序怪癖都保留）；`AnalysisProvider` 三个 tab 的独立读全部并行化（4/6/6 个读）。
- **JSON body 限额收口**：`express.json({limit:'50mb'})` 以前挂在**每一个**路由上 —— 登录、公开评论、访客计数这些**匿名可达**的接口都敞着 50MB 的解析上限（内存风险 + 现成的 DoS 面）。现在全局默认 **1mb**，只有后台 4 个内容前缀（文章/草稿/自定义页面/管线，全在 AdminGuard 之后）保留 **50mb**，因为正文可以内嵌 base64 图片、整页 HTML、脚本体；`VANBLOG_JSON_BODY_LIMIT` / `VANBLOG_JSON_BODY_LIMIT_LARGE` 可调，非法值回落默认。实现是"先给前缀挂大解析器、再全局挂小的"，body-parser 解析过就置 `req._body`，**每请求最多解析一次**（有测试钉住）。⚠️ 图片上传、整站备份恢复/导入全是 multipart(multer)，**不经过 express.json**，那些限额（8GB 恢复 / 200MB JSON 导入 / 50MB 图片）一行没动。实测：1.17MB 打登录与公开评论 **413**；1.2MB 打文章/自定义页面路由照常过解析器（401 是 guard 拦的）；51MB 仍 **413**；2MB multipart 打上传接口是 401 不是 413（证明 json 解析器确实跳过了）。
- **图床图片改由 caddy 直接发**（`file_server`），不再穿过 Node：只匹配 `/static/img/` 与 `/static/img/thumb/` 下的**图片扩展名**，缓存头与 server 原来发的完全一致（`public, max-age=3600, stale-while-revalidate=604800`）。附件、导出、临时目录一律继续走 server（那边有 nosniff、对 html/svg/js 强制下载、匿名 403），实测 `/static/export/x.zip` 仍然是 403。收益（1.08MB 的 webp，并发 50 × 800 请求）：**718.8 → 1556.4 rps（2.17 倍）、p50 37 → 24ms、p95 183 → 56ms（−69%）**，单请求 18.4ms → 2.4ms，而且这些字节不再占用 Node 的事件循环。
- **静态资源不再和 API 抢同一个限流桶**：全局限流挂在 `path:'*'` 上，**一张图也算一次** —— 一篇带 10 张图的文章 = 11 次计数，600/分钟只够约 50 次浏览/分钟/IP；在公司 NAT、校园网或 CDN 回源 IP 未被识别（访客共用出口 IP）时，正常读者会成片 429，看着像站点挂了。压测第一眼看到的就是这个：2000 个请求里 1600+ 个是 429，**测的根本不是栈**。现在 `/static/**` 走独立桶（默认全局的 10 倍，`VANBLOG_STATIC_LIMIT_PER_MIN` 可调）。实测：纯静态 3000 请求**全部 200**；混合流量成功响应 375/2000 → **1426/2000**（限流参数不变）。
- **上游 keep-alive 超时对齐**：Node 的 `server.keepAliveTimeout` 默认只有 **5 秒**，而 caddy 的上游空闲超时是 60 秒 —— 反代把连接留在池里、Node 先关，于是偶发 ECONNRESET/502，且只在"流量有间歇"时出现。现在显式 65s（`VANBLOG_KEEP_ALIVE_TIMEOUT_MS`）、`headersTimeout` 再大 1s、`requestTimeout` 300s，并有一条测试**直接对比 caddy 模板里的 `idle_timeout` 与 Node 的默认值**。
- **`/api/public/meta` 并行化 + 5 秒进程内缓存**：它是全站最热的一次读（前台每个页面渲染都要调），内部 7 个互相独立的 Mongo 查询以前是**串行 await**，现在 `Promise.all`；再加进程内短缓存（`VANBLOG_PUBLIC_META_CACHE_MS`，0 可关），后台改站点信息/总字数时主动失效。
- **`UV_THREADPOOL_SIZE=16`**（镜像 ENV）：sharp 编解码、fs 异步操作、crypto 的 scrypt 都在 libuv 线程池里，Node 默认只有 **4**，图片站并发处理时表现为"CPU 很闲但一直在排队"。
- 编排模板给两个服务加 `ulimits.nofile: 65536`（高并发下 fd 是第一道天花板，mongod 低于 64000 自己也会告警），vanblog 服务加 `stop_grace_period: 30s`（start.js 给子进程 8 秒优雅退出，docker 默认只等 10 秒）。
- **压测结果**（真镜像起的真栈 + 那份 66MB 生产数据，客户端与服务端同机所以绝对值偏保守，但前后对比有效）：混合流量 c=200 **259 → 359 rps / 407 → 513 Mbps**；c=1000 **200 → 377 rps（+88%）/ 250 → 593 Mbps（+137%），并且 101 个 502 → 0**。**C10K**：一万条连接同时挂住全部建立成功（1.1s，0 拒绝）；一万条连接上同时请求 caddy 直服的静态图片 **10000/10000 全部 200，用时 1.2 秒**；同一万条连接请求需要反代到 Node 的 `/api/public/meta`，完成数从 1600 提升到 **3672（2.3 倍）**、耗时 30.4s → 16.9s，但仍无法全部完成 —— **连接层早就够 C10K，天花板是单进程的 Node 应用层**，要继续抬只能上 cluster（前提是先解决 cron/ISR/子进程 spawn 的多实例问题，见 AGENTS §7.44）。
- **列表页不再下发文章全文（服务端摘要 `withExcerpt`）**：首页与 `/page/n` 以前把每篇文章的**全文**塞进 `__NEXT_DATA__`（5 篇正文 25,053 B），而卡片只渲染 3,263 B 摘要 —— **87% 是白送的**，`__NEXT_DATA__` 占首页 gzip 的 54.8%。现在摘要在 server 算：新增 `packages/server/src/utils/articleExcerpt.ts`（前台那套逻辑的**逐字符移植**：围栏感知的 `<!-- more -->` 定位、200 字回退、截断链接补全（#410）、代理对安全），公开列表接口加了显式的 `withExcerpt` 开关（**不传时响应一个字节都不变**），配合 `toListView` 返回 `excerpt` + `firstImage` 并剥掉 `content`/`password`；**先过滤私密文章再算摘要**，加密正文不会漏进公开列表。前台 `PostCard` 保留本地回退（`props.excerpt ?? articleOverviewMarkdown(content)`），老 ISR 缓存页照常工作。两边一致性由 38 个跨包 parity 用例钉住（同一组向量跑两个实现，含全站 53 篇的首图对比，0 处不一致）。**实测：首页 HTML 114,485 → 92,228 B，gzip 33,156 → 22,661 B（−31.7%）；`__NEXT_DATA__` 36,297 → 14,040 B；正文 25,053 → 0 B；卡片渲染逐字节不变。** RSS 的 `getDescription` 也改为委托共享实现，于是 9 篇没有 `<!-- more -->` 的文章 description 从全文变成 200 字摘要（与全站摘要语义一致，全文仍在 `content:encoded`），44 篇有标记的逐字节不变。
- **镜像里的 server 依赖改成 lockfile 安装 + 只带生产依赖**：`server_builder` 以前是 `COPY ./packages/server/ .` + `pnpm i` —— **没有 lockfile**，每次构建现场解析 `^` 范围（mongoose / axios / express / @nestjs 都可能漂），镜像不可复现；而且装的是全量依赖，runner 把整个 `node_modules` 拷进生产镜像（394 个 dev 包 ≈ 121MB，typescript 自己 64MB）。现在走 workspace + `--frozen-lockfile --filter "@vanblog/server..."`，构建完用 **`pnpm deploy --prod`** 导出自包含的生产依赖树，runner 只拷那一份：**191.6MB / 34 个顶层包**，typescript、jest、webpack、ts-node、@nestjs/cli 全都不在。验证过：完整镜像构建通过，用新镜像起真栈后 `/`、`/admin`、`/api/public/meta`、`/api/public/theme`、`/robots.txt`、`/sitemap.xml`、`/feed.xml` 全 200，容器内 `require.resolve('@nestjs/core')` 与 `sharp` 都成功、sharp 的 musl 预编译 `.node` 在。
- **列表页摘要里的图改用缩略图**：摘要只有 200 字，里面嵌的却是**原图** —— 实测首页两张图 3,497,836 B + 1,076,400 B，而对应缩略图只有 14,098 B 与 8,076 B，同一张图的缩略图还被卡片右侧的 `ListThumb` 另外请求了一次（一张图下载两遍）。现在 `PostCard` 的 overview 分支把 `/static/img/<name>` 改写成 `/static/img/thumb/<name>`，**首页那两张图 4.57 MB → 22 KB（208 倍）**；文章页正文保持原图。点开放大不受影响（rehype 插件补 `data-zoom-src` 指回原图，medium-zoom 支持），缩略图缺失时 `error` 事件自动回退原图。
- **`getPublicMeta()` 加 5 秒进程内缓存 + 并发合并**：一轮 ISR 全量重渲染要约 130 个页面，每个页面都调一次这个接口，同一份 8.3KB 的 meta 被串行重复拉 130 次（约 1MB）。只缓存成功结果（构建期连不上 server 时走默认值分支，那个不能缓存）。
- **封面图的 CLS 修掉**：`ArticleCover` 的 `<img>` 没有 width/height，`.article-cover` 又一条 CSS 都没有，于是每次进文章页必然一次布局位移，而这正是被 preload 的 LCP 元素（53 篇里 16 篇有封面）。加了 `aspect-ratio: 21/9`（`object-cover` 本来就按这个比例裁，视觉不变）。
- **认不出格式的 GA 测量 ID 不再注入**：以前"非空就注入"，把别家统计的 id 填进 GA 字段也会去请求 `gtag/js?id=…` —— 实测返回 200 且 **242,542 B**，为一个不存在的媒体资源白下载。`shouldInjectGa` 与 `describeGaInjection` 现在用同一个判据（组件调的是后者，只改前者没用）。
- **`largePageDataBytes` 从 10MB 收回 256KB**：Next 13 默认 128KB，抬到 80 倍等于把唯一会报警的机制关掉（现有最大页面是 `/timeline` 的 73KB）。
- **让 HTTP/3(QUIC) 真的能用，并给 caddy 的上游加连接池**：容器里的 caddy 在 `:443` 上**本来就是 HTTP/1.1 + HTTP/2 + HTTP/3**（实测 caddy 2.11.4：不写 `protocols` 时默认就是 `["h1","h2","h3"]`，并且已经在发 `alt-svc: h3=":443"`），明文 `:80` 才是只有 HTTP/1.1（caddy 会打印 "HTTP/2 skipped because it requires TLS"）。**真正挡住 HTTP/3 的是编排文件没有映射 UDP 443** —— QUIC 跑在 UDP 上，端口没发布，浏览器收到 Alt-Svc 也连不上，只能永远用 HTTP/2。现在模板加了 `vanblog_https_port:443/udp`（TCP 那条保留），老安装跑一次 `./vanblog.sh config` 再 `restart` 就有，`./vanblog.sh status` 会直接告诉你 QUIC 端口映射了没有。UDP 没放行也**不会坏**：浏览器试连失败自动退回 HTTP/2。另外在 `:443` 上把 `protocols: ["h1","h2","h3"]` **显式写出来**，这不是"打开"而是"钉住"—— 免得将来某个版本改默认值时悄悄把 h3 拿掉。caddy → Node 的上游仍是 HTTP/1.1（Nest/Next 默认不支持 h2c），但补上了连接池 `keep_alive{idle_timeout 60s, max_idle_conns 64, max_idle_conns_per_host 32}` —— Go 的默认值只有 2，并发一上来就不停地开关上游连接。实测（本机跑真 caddy 2.11.4，与镜像同版本）：日志出现 `protocols:["h1","h2","h3"]`、`curl --http2` 拿到 `HTTP/2 200` 且响应头带 `alt-svc: h3=":443"; ma=2592000`、gzip 生效、20 个并发 0.47s。压缩仍是 zstd+gzip（Caddy 不支持 brotli，zstd 已是最优）。`/docs`、反向代理文档里都写清了"外层再套一层反代时，访客用的是外层的协议"。
- **全站补上安全响应头**：caddy 模板里原来**只有** `/admin*` 与 `/api/admin*` 的 `Cache-Control`，一个安全头都没有 —— server 自己会给 `/api/**`、`/static/**` 下发 `nosniff` 等头，但**前台页面（caddy → website:3001 的 HTML）一个都没有**。现在两个 server 的全局路由（`route[0]`，无 matcher，与 `encode` 并列）都加了 `headers` 处理器：`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Frame-Options: SAMEORIGIN`（不是 DENY，后台要 iframe 同源的 waline `/ui`）、`Permissions-Policy`，并 `delete: ["Server"]`；`deferred: true` 保证反代响应和 caddy 自己的 5xx 也带上。`set` 是覆盖不是追加，所以 `/api/**` 上不会和 server 已有的头重复。

- **备份保留策略 `--keep N`**：`./vanblog.sh backup --keep 7`（或 `VANBLOG_BACKUP_KEEP=7`）在备份**成功之后**只保留最新 N 份，其余连同 `.manifest.json` 一起删掉，并打印删了哪些、释放了多少。以前脚本和 server 都只管写不管删，一份整站备份几十 MB，配 cron 每天备一次一个月就是 2GB，小盘机器迟早被撑满（而磁盘满会让 mongod、caddy、导出一齐出各种奇怪的错）。边界都朝"宁可少删"的方向定：只删自己认识的归档名、只在备份成功后清理、`--keep` 为空/0/非数字时完全不清理（默认行为不变），离线模式清理的是安装目录里的 `vanblog-backup-*`，与整站备份互不干扰。

**安全 / 仓库卫生**

- **基础包盘点 + TypeScript 4.9 → 5.9.3**：逐个包对比"声明的范围 / 实际解析版本 / registry 最新版"做了盘点，结论是**整条栈落后 2–3 个大版本**（`@nestjs/*` 9 vs 12、`next` 13 vs 16、`umi` 3 vs 4、`antd` 4 vs 6、`mongoose` 7 vs 9、`express` 4 vs 5、`multer` 1.x vs 2.x、`typescript` 4.9 vs 7.0），其中 **Nest 9 / Next 13 / umi 3 / antd 4 / React 17 都已经不在上游维护范围内**（和 Node 20 一样属于"运行时没有安全补丁"）。本轮先落地风险最低、收益明确的一项：server 与 website 的 `typescript` → **5.9.3**、`ts-jest` → **29.4.12**（29.0.x 的 peer 是 `typescript >=4.3 <5`，不升它装不上 TS 5）、`@types/node` → **24**。**admin 故意留在 4.9**（绑着 umi 3 + antd 4 + React 17，umi 3 自己的 `.d.ts` 就不是 TS 5 干净的）；也没升 TS 6/7（TS 7 是 Go 重写的新编译器，工具链还没跟上）。
- **TS 5 挖出 48 个类型错误，其中一个是真 bug**：`collaborator.controller.ts` 里 `data: [adminUser, ...data] || [adminUser]` 被 TS2872「这个表达式恒为真」抓出来 —— 数组字面量永远为真，那个 `||` 兜底**从来不可达**，而且 `data` 万一为 nullish 会**先在展开处抛异常**、根本走不到兜底。其余：`fullBackup.ts` 两处（`@types/node` 24 给 `fs.WriteStream` 事件加了强类型；旁边那句 `stream.end(resolve)` 更阴 —— 它以前能编译只是落进了 `end(chunk: any, cb?)` 重载，**类型上把 resolve 当成数据块**、运行时当回调用）；5 处 TS2742 是 mongoose 的 `deleteOne` 返回类型泄漏了它自己嵌套的 mongodb，TS 5.9 的声明发射没法可移植地命名，改成显式标注 `Promise<DeleteResult>`（从 server 自己直接依赖的 mongodb 引入，结构相同、运行时零变化）；website 侧把跨包 parity spec 引用的 server 源码**显式列进 `include`**（不是把 spec 排除掉），给 `mdast-util-mark`（**把源码 `index.ts` 一起发进了 npm 包**，TS 解析 main 时会先做 `.js→.ts` 替代于是永远命中它，而 `skipLibCheck` 只管 `.d.ts`）用 tsconfig `paths` 映射到包内**编译成品 `index.d.ts`** + 一个 ESM 再导出漏斗收拢导入（ambient `declare module` 实测无效：文件解析成功时轮不到它；`require()` 中转也不行：该包是 `"type":"module"`，Next 会直接拒绝并让前台 500），其余约 30 个 spec 里的错误一律**把 mock 与类型写诚实**，不用 `any`/`@ts-ignore` 压掉。验证：server 与 website 的 `tsc --noEmit` 在**全新 tsBuildInfoFile** 下都是 0 错误，server jest 942/941 + 1 个既有、website vitest **69 文件 / 684**、admin 347、脚本 22 文件 / 1110。⚠️ 两个可复用的教训：① **`incremental: true` 会让编译器版本审计少算错误**（本机第一次只量到 2 个、实际 7 个，因为 buildinfo 是 nest watcher 用 CLI 自带 TS 写的、5 个文件回放了空诊断）—— 审计必须用全新 buildinfo；② `nest build` 一直用 CLI 自带的 TS 5.x，而项目声明 4.9.5，也就是构建与本机类型检查用的不是同一个编译器，现在两边统一到 5.9。
- **基础镜像从 `node:20-alpine` 升到 `node:24-alpine`（Node 20 已经 EOL 四个多月）**：官方生命周期里 v20 的 EOL 是 **2026-04-30**，也就是**运行时本身早就不再有安全补丁**了 —— 这跟前面几轮修的依赖漏洞是同一类问题，只是藏在 `FROM` 那一行里不显眼。没有停在 v22（EOL 2027-04-30、已进 maintenance），直接上 **v24**（当前 active LTS，EOL 2028-04-30）。挡路的两条硬约束都实测撞过并解掉了：① **Node 23 移除了 `util.isObject`**，而 `@nestjs/cli` 9 的依赖链在用它，Node 24 上 `nest build` 直接 `Error (0 , util_1.isObject) is not a function` ⇒ 把 `@nestjs/cli` / `@nestjs/schematics` 升到 **11**（它们只在构建期用，运行时的 `@nestjs/core` 仍是 9，运行时行为不变）；② sharp 0.32.6 的预编译只到 Node 20 的 ABI ⇒ 已由上一批的 **sharp 0.35** 解决（0.33 起是 N-API + `@img/sharp-<平台>` optionalDependencies，一份产物跨 Node 版本通用）。另外确认：admin 的 umi3/webpack4 依赖的 `--openssl-legacy-provider` 在 Node 24 上**仍然有效**（OpenSSL 3 的 legacy provider 带 MD4），waline 的 `better-sqlite3` 在 musl 上按 Node 24 头文件**现场编译通过**，`require('punycode')` 仍可用（只是 DEP0040 警告）。**验证**：五个 stage 完整构建成功；起真栈灌入 66MB 生产备份后，容器内 Node v24.21.0 / Alpine 3.24.1，sharp webp 编解码往返正常，SSR 文章页 200 / 78,767 B / 17.8ms，`/`、`/admin`、`/timeline`、`/link`、`/tag`、waline 评论接口全 200，重启后 `/feed.xml` 291,675 B、`/atom.xml` 298,575 B、`/sitemap.xml` 15,397 B（日志确认首轮全量渲染与 50 条上限仍生效），`x-request-id` 与 1.2MB→413 照常，容器日志里**没有**任何 `is not a function` / `Cannot find module`；本机三套测试**在 Node 24 上重跑**结果与 Node 20 一致（server 942/941 + 1 个既有字体用例、website 68 文件 / 679、admin 347、脚本 22 文件 / 1110）。代价：镜像 808 → **854 MB**（基础镜像本体更大 + better-sqlite3 按新 ABI 重编）。
- **开发环境与 CI 一并对齐到 Node 24**（否则就是"生产跑 24、测试跑 20"的盲点）：`dev-env.sh` 改用 `.tools/node24` 并把引导安装版本抬到 24.21.0（目录名由版本号推导）；两个 workflow 的 `node-version: 20` → `24`；`image-runtime.test.sh` 里"必须停在 node:20、出现 node:22+ 就 fail"整段换成"**所有 stage 大版本一致且 ≥ 24**、出现已 EOL 的 node:18/node:20 就 fail、Dockerfile 必须留着 `util.isObject` 这条历史说明"，并在注释里写清 v20/v22/v24 的 EOL 日期（**2027 年之后要记得往上抬**）；`dockerfile-patches` 与 `dockerfile-alpine-sharp` 两个测试里写死 `node:20-alpine` 的匹配改成 `node:[0-9]+-alpine`（断言的是"每个 alpine stage 都有换源步骤"这个不变量，不是具体版本），以后升 Node 不用再改测试。⚠️ **Node 24 换了 `node --test` 的默认 reporter**：admin 那套测试不再输出 `# tests / # pass / # fail` 汇总行（默认从 TAP 换成 spec），看着像"什么都没跑"，要汇总得显式加 `--test-reporter=tap`。
- **事件日志不再无限增长**：`LogProvider` 用 pino 往 `vanblog-event.log` 追加，且是一个长开的 `a+` 流 ⇒ 这个文件**只增不减**，跑久了会吃满磁盘，而磁盘满的表现是"备份写不出来、图片存不进去、mongod 变只读"，根因极难联想到（`logTail` 只限界了**读**，没限界**写**；容器 stdout 那一份早就有 `logging.max-size` 管着，这份没有）。现在按大小轮转：`VANBLOG_EVENT_LOG_MAX_MB`（默认 20）× (`VANBLOG_EVENT_LOG_KEEP`+1)（默认 3+1）⇒ **总量上界约 80MB**，停机时 `onModuleDestroy` 先 flush 再关（否则最后几条会丢，而那往往正是关机前那次失败的原因）。⚠️ 两个实现陷阱都被测试抓出来了：`createWriteStream` 是**异步打开文件**的，所以"超过阈值就立刻 rename"会白转一次（那一刻原路径上还没文件可改名，旧流的写入落进新文件 ⇒ 历史文件是空的、当前文件混着两轮内容），而"重启时日志已超阈值、第一条写入就触发轮转"正是现实场景 ⇒ 改成"标记 + 在流已 open 且无在飞写入的安全点执行"；而**只等安全点会把轮转饿死**（日志密集时 pending 永不为 0），所以加了 64KB 的强制余量。
- **健康检查终于能反映"服务是否活着"**：镜像里本来就有 `HEALTHCHECK`，但它打的是 `/`、判据是 `statusCode < 500` ⇒ **前台 404、API 全挂、连不上 mongo 都算健康**。新增 `GET /api/public/health`（返回 status/version/uptime/mongo 状态与 ping 耗时/内存占用），**mongo ping 不通时返回 503**（这样 `<500` 的判据才有意义），Dockerfile 的 HEALTHCHECK 改成打它（走 caddy 的 80 端口，顺带把反代通不通一起验了）。三个设计取舍：**未初始化也返回 200**（否则全新安装在走完向导前会一直被判定为不健康、可能被反复重启，所以它进了 `InitMiddleware` 的 exclude）、**`Cache-Control: no-store`**（健康检查的意义就在"此刻"）、**探测便宜**（ping 带 800ms 超时、结果缓存 5 秒、并发探测合并 —— 这个端点是匿名的，别人也能拿它打你）。⚠️ 顺带更正一个我自己说错的判断：vanblog 的 healthcheck **在镜像里、编排里没有**，而且这是仓库的**约定**（`vanblog-compose-health.test.sh` 就有一条断言钉着"编排里不重复"）—— 我按自己的判断往 compose 里加了一份，那条测试立刻红了；同时也差点加了第二份 `logging` 块（两个服务早就有 `max-size: 10m / max-file: 3`，而 YAML 的重复键会静默覆盖）。
- **查过但降级/不做的**（连同理由，避免下一个人重新评估）：远程图片本地化的 **SSRF**（`transferRemoteImages` 抓正文外链、没有内网地址过滤）—— 调用方是**后台**路径，而后台本来就能通过流水线执行任意代码，所以不构成提权；真要修应与 picgo 的外链抓取一起加"目标不得是回环/私网/云元数据"的过滤。`/api/admin/init` 的 check-then-act 竞态 —— init/restore 已有单飞锁，`initSystem` 还没有，但窗口被 5 次/10 分钟的 init 限流压得很小、最坏结果是两个并发初始化写同一条 meta（不是数据损坏），留给下一轮照抄同一把锁。死依赖 `swagger-ui-express`（全树 0 处 import，`@nestjs/swagger` 8 用自带的 `swagger-ui-dist 5.18.2`）—— 删除要改 package.json 并重装，而本机 pnpm store 里 `path-to-regexp` 那个内容地址仍是坏的，不在这轮冒险。
- **新功能：初始化页直接上传整站备份恢复**（`POST /api/admin/init/restore`，multipart 字段 `file`，匿名可用、**只在站点未初始化时开放**）。全新安装不必再手填站点信息与账号：一份 `vanblog-full-*.tar.zst` 就把数据库、图床、附件、自定义页面与主题一起搬过来，随后自动拉起评论服务、按恢复后的库重启前台、触发全量渲染，返回 `{statusCode:200,data:{counts,initialized,adminUserFromArchive,needsRestartForPipelineDeps,seconds,databases,static,notes[]}}`（`counts` 取自归档清单，前台不用再查一次；⚠️ **要看 `data.initialized` 而不是 HTTP 200** —— 归档里没有 users 时恢复会成功但站点仍未初始化，此时应继续走向导）。护栏：处理器内复查"是否已初始化"（403）、**同步单飞锁**（并发第二个 409；锁必须在第一个 await 之前拿到、释放必须判断归属，两个坑都踩过并有并发用例钉住）、文件名白名单 + 清单校验 + **归档成员穿越检查**（`tar -tf` 列成员，拒绝绝对路径与任何 `..` 段；不依赖 tar 的实现，因为容器里是 busybox tar 而这条接口匿名）、临时归档在 `finally` 里删、上传限额与后台那条恢复接口**共用同一份** `RESTORE_UPLOAD_OPTIONS`（8GB/1 文件/32 parts）。老归档照样能恢复：清单缺字段一律回落不拒绝，**只有"版本比本程序新"才拒**。后台 init 页新增恢复卡片（在向导**之前**、不需要填任何字段，确认后用 XHR 上传并显示真实进度与"正在恢复…"独立阶段，进行中禁用按钮；成功按 `initialized` 分支，失败按 409/403/429/400-版本过新 分别给提示）。
- **限流不再能被一个请求头绕过**（`VANBLOG_TRUST_FORWARDED_HEADERS`，默认 `auto`，**默认行为变更**）：全局/静态/公开写/初始化四档限流以前用 `pickClientIp()` 当 key，而它优先读 `cf-connecting-ip` / `true-client-ip` / `x-real-ip` / `x-forwarded-for` —— **全是客户端可控的**，caddy 也不剥客户端自带的 `cf-connecting-ip` ⇒ 每个请求换一个头就能无限绕过（仓库自己就矛盾：`pickSocketIp` 的文档写"供限流等安全判定使用"，`pickClientIp` 的写"限流等关键路径不要用这个函数"）。现在 `auto` 只在**套接字对端是回环/私网**时采信转发头、且只信一跳（取 XFF **最右**一项，即可信代理亲眼看到的对端）；对端是公网地址就一律用套接字地址。`always` 保留旧行为（CDN/隧道直连源站），`never` 只认套接字地址（⚠️ 反代后面全站共用一个桶会 429 风暴）。私网判定是新写的真 CIDR（docker 的 172.17/16、podman 的 10.88/16、Docker Desktop 的 192.168.65.x 都天然落在里面），**故意排除** `169.254/16`（云元数据地址所在）与 CGNAT `100.64/10`（公网侧共享段）。实测（限额 5/分钟、每场景 20 请求）：公网对端轮换 `cf-connecting-ip` 从 **20 通过/20 个桶** 变成 **5 通过/15 拦/1 个桶**；回环对端 + 两个固定客户端从 **1 个桶**（互相顶替，且任何人可伪造最左项**栽赃**某个 IP）变成 **2 个独立桶**。⚠️ **登录防爆破、评论频率与文章解锁仍然只用套接字地址**：那三类是防爆破计数，攻击者的收益正是"换一个 key 重新开始"，而 all-in-one 部署下对端就是 127.0.0.1 ⇒ `auto` 会采信头，换过去等于把"无限试密码 + 用受害者 IP 把对方锁在门外"重新打开。
- **内存限流表不再"一满就把所有人清零"**：`utils/attemptLimit.ts` 以前超过 20000 个 key 就 `buckets.clear()`，而 key 里含**匿名可控**成分（`POST /api/public/article/<80个任意字符>`）⇒ 实测 20 万个一次性 key 触发 **9 次全表清空**，每次把进程里所有人的登录爆破窗口、评论频率与全局限流一起归零（匿名客户端可以不停给自己重新武装限流）。现在惰性清扫过期桶 + **按 count 从小到大淘汰**到 90% 水位（洪水桶 count=1，正在被限流的桶 count>1 ⇒ 热桶一条不动；按插入序淘汰会把"用得最久、count 最高"的那个先踢掉，等于放出正在被限流的客户端），表恒定封顶 20000 条 ≈ **7.3 MB**；同样 20 万 key：**0 次清空 / 18 万次优雅淘汰**，插入中位数 1.3 µs。
- **写库持续失败时浏览统计不再无限吃内存**（`VANBLOG_VIEW_MAX_RETAINED_KEYS`，默认 20000，`0` = 旧行为）：失败的增量退回累加器时 `events` 记 0，于是原有封顶在失败期间**完全不生效**，而路径名是匿名接口就能造的 ⇒ 实测 40 万个不同路径滞留 80 万键 / **+92.4 MB** 线性增长，唯一清除路径（写成功）不可达。现在 `add()` 与 `merge()` 两条路都封顶，同样场景 **3.2 MB**；**站点级累计值与每日快照一条不丢**（丢的只是"按路径/按文章"那部分），丢了多少打 WARN，绝不静默。
- **后台仪表盘的数量参数被夹住**（`sanitizeDataNum`，上限 3650）：`?overviewDataNum=999999999` 以前会先 push 十亿个日期字符串、再把十亿元素的 `$in` 发给 Mongo —— 实测每单位 num 15.4–26 µs，num=300000 卡住事件循环 **4.62 秒**，一个后台 GET（或一枚泄漏的 API token，而 `/swagger` 默认公开）就能把单进程 server OOM 掉；`=abc` 则得到 **200 + 一整屏 0**（错误与"没有访问量"分不出来）。实测修复后 `=30` 的响应与改动前**逐字节同长（3307 B）**、`=999999999` 变成 **119 ms** 返回、`=abc` 返回真数据。
- **公开列表的热路径快 3.7–96 倍，输出逐字节不变**：一页 5 篇的摘要+首图 0.407 → **0.110 ms**；53 篇的首图 6.404 → **1.75 ms**、代码区涂黑 5.803 → 1.602、图片引用提取 6.030 → 1.277；合成的 493 KB 单篇、无 `<!-- more -->` 时摘要 6.072 → **0.063 ms（96×）**（"补全被截断的链接"以前要把整篇一个字符一个字符走完，现在只扫到截断点，O(正文) → O(200)）。另外 `extractImageRefs` 以前**每匹配到一张图就现场 `new RegExp`**（一篇 20 图的文章 = 42 次正则编译，跑在每次列表请求的每篇文章上），4 个正则已提到模块级并每次归零 `lastIndex`。零行为变化的证据有两层：把**改动前的实现逐字冻结在 spec 里**、在 **461 个向量**上对拍全同（每条都带"向量确实覆盖到这条分支"的反证断言，免得对拍是空的）；以及活体把 53 篇公开文章走一遍列表接口，`excerpt`/`firstImage` 与冻结实现**逐字节相同**。顺手把公开搜索的去重从 **O(k²) 降到 O(k)**（`resData.includes(e)`，k 上限 800 ⇒ 最多 32 万次引用比较，而搜索是匿名接口）。
- **整站 JSON 导入的 `visits`/`viewers` 批量化**：8772 条 visits 从 **17544 次串行命令 → 18 次（975×）**、viewers 800 条从 1600 → 2 次（墙钟 2.26 s → 0.48 s）；真 mongod 上与老的逐条写法**逐行逐字段相同**，含两个刻意边界（备份里没有 `createdAt` 的行 —— upsert 不会自动套 schema 默认值；两行共用同一个 `{date,pathname}` —— `ordered:true` 保住"第一条插入、第二条覆盖"）。批量失败会**回落到原样的逐条写法**并打 WARN（回落幂等），一条坏数据不会让整次导入白跑。
- **整站恢复报 `Unsupported BSON version, bson types must be from bson 6.x.x`（恢复功能完全不可用）**：`utils/backupCodec.ts` 的 12 个 BSON 构造器来自 server **直接依赖的 `mongodb@5.9.1`**（bson 5.x），而恢复走的是 **mongoose 8 自带的 driver 6.20.0**（bson 6.x），bson 6 的序列化器拒绝外来主版本的实例 ⇒ 恢复第一个集合就 400。mongoose 7 时代两边同为 bson 5，所以这个坑一直潜伏，而备份 e2e 只覆盖 JSON 导入导出、**没有 BSON 往返**，升级时测不出来。现在构造器从 `mongoose.mongo`（mongoose 实际在用的那份 driver）取，直接依赖只作兜底；**导出侧一行没改**（`encodeDoc` 按 `_bsontype` 鸭子判别），所以已有归档照常能恢复、归档格式不变。**反证跑过**：把候选顺序改回直接依赖，3 条用例当场红并报出生产那句错。真归档实测：隔离 mongod 上 2750 ms 恢复 13 集合 / 9830 条（articles 59、公开 53、statics 93）；**容器里也验过**：全新空库 → `POST /api/admin/init/restore` 上传 69MB 真归档 → HTTP 201 / 3.75 s / `initialized:true`，恢复后 meta、列表 `total:53`、SSR 文章页 200/78,830B、原图 200/1,076,400B、`/`、`/admin`、`/timeline`、`/link`、`/tag`、`/sitemap.xml`、waline 全 200，**再调一次 403**，日志零异常。
- **每个归档里的正则字段都被写成了 `{}`**：driver 读库时把 BSON regex 提升成**原生 RegExp**，而原生 RegExp 没有 `_bsontype`、`Object.keys()` 也是空的 ⇒ `encodeDoc` 让它掉进"普通对象"分支、值被静默清空（恢复后是个空对象，一条报错都没有）。现在按 canonical EJSON 写成 `{$regularExpression:{pattern,options}}`（解码侧本来就认）。
- **后台上传的主题 CSS 从来不进整站备份**：`BACKUP_STATIC_FOLDERS` 是手写清单，只有 `img/file/customPage`，而主题在 `<static>/themes/`。主题元数据在 settings、启用状态在 metas（都随库备份），所以换机器恢复后**后台显示主题存在且已启用**、`/api/public/theme` 照常列出它，只有 `/static/themes/…` 没了 ⇒ `/api/public/theme.css` **返回 204 + 一份空样式表**（读文件失败被服务端 `catch`，内置主题本来也走 204）、浏览器拿到合法的空 CSS、控制台零报错、前台静默退回默认皮肤：一次"看起来成功"的恢复。已把 `themes` 加进清单（老归档没有这个目录也照常恢复），并加了**分类守卫**：代码里会建的每一个静态子目录、以及本机真实静态目录里的每一个子目录，都必须被登记成"用户数据（进归档）"或"可再生/临时（不进归档，且写明理由）"，出现第三类就让测试红并点名 —— **反证跑过**（把 `themes` 从分类里删掉，3 条用例红）。⚠️ `fullBackup.spec.ts` 里原来钉死三元素清单的那条断言**本身即 bug**，已改。
- **恢复之后流水线跑不起来**：流水线脚本正文在磁盘上（`<codeRunnerPath>/<id>.js`），`runCodeByPipelineId` fork 的就是它，而它只在**启动时**（`PipelineProvider` 构造函数里的 `init()`）与后台编辑时写。全新机器上启动时库是空的 ⇒ 一个脚本都没写过，随后恢复把 `pipelines` 集合填上了、磁盘上却没有文件，而 `dispatchEvent` 是被 await 的 ⇒ 表现为"保存文章卡到超时"。现在恢复成功后按库里的数据重写一遍脚本（**只**调 `saveAllScripts()`，不在请求路径上跑 `pnpm add`），两条恢复路由都生效。⚠️ 诚实的限制：**带第三方依赖的流水线仍要等一次重启**（依赖只在启动时与后台新建/编辑时安装），所以响应里加了 `needsRestartForPipelineDeps`。顺带修掉一个 cluster 隐患：构造期的 `init()` 现在只由主实例跑（以前 N 个 worker 各跑一遍 ⇒ N 个 `pnpm add` 同时改同一个 `node_modules`）。
- **恢复后 RSS/sitemap 迟到（最多 3 分钟且会被反复推迟）**：`activeAll(info, delay)` 会把 `delay` 转发给 `generateRssFeed`/`generateSiteMap`，而它们默认 **3 分钟 / 1 分钟**、且任何后续 `activeAll` 都会重置定时器；两条恢复路由都没传 delay ⇒ 容器演练时 `/feed.xml` 是 **404**、`/app/static/rss/` 是空的，sitemap 只是碰巧被整点 cron 补上。现在两条路由都传 `1000`（与 `main.ts` 启动时一致）。顺带查清：`generateRssFeed` 只被 `ISRProvider.activeAll` 的防抖定时器调用，所以每小时的 ISR cron 也会重新生成 RSS（不是"只有改文章才生成"），它从来不会永远缺失，只是迟到并被反复推迟。
- **`sitemap.xml` 生成失败是一条没有来源的 unhandledRejection，而文件会一直停在旧内容上**：`generateSiteMapFn` 从 `setTimeout` 里发出去就不管，整段没有 try/catch，`streamToPromise(...).then(...)` 也没有 `.catch`（RSS 那边一直是有的，这是漏掉的孪生兄弟）；它还在 async 函数里用 `mkdirSync`/`writeFileSync` 按住事件循环，并**原地覆盖** `sitemap.xml`（并发爬虫可能读到半截 XML）。现在整段兜错并打带来源的 ERROR、改异步 IO、写临时文件再 `rename`（原子）；活体验证过没有残留 `.tmp-<pid>`。
- **ISR 的"已经 await 且 catch 了"是假的**：`activeAll` 传给 `activeWithRetry` 的回调是花括号包住、**没有 return** 的，于是 `await fn(info)` await 的是 `undefined` —— try/catch、重试日志与成功标志形同虚设，而 `activeAllFn` 第一句（读 ISR 设置，在内部 try 之外）一 reject 就溜成无来源的 unhandledRejection。三处回调都补了 return 并带上来源；"补跑一轮"的递归也包进 try/finally（以前它抛错会让链计数永远停在 >0，之后每轮都少追加几次还打一句莫名其妙的"已连续追加 3 轮"）。
- **写错的 env 会让两个超时静默失效**：`VAN_BLOG_IP_GEO_TIMEOUT=3s` → NaN → axios 把 `timeout: NaN` 当成**没设超时**（"离线时每次登录干等外网"这个修过的 bug 会回来）；`VANBLOG_PIPELINE_TIMEOUT_MS` / `VANBLOG_DEPS_INSTALL_TIMEOUT_MS` 同理 → `setTimeout(fn, NaN)` ≈ 1ms ⇒ **流水线刚 fork 出来就被判超时杀掉**，报错还印着"超过 **NaN**s 未返回结果"。三处改用带校验的 `envPositiveInt`（非数字/NaN/±Infinity/≤0 一律回落默认，合法值夹到区间内）。
- **字数缓存会静默停在旧值**：`MetaProvider.updateTotalWords()` 的 `setTimeout` 回调是 async 且没有 try/catch，30 秒后 Mongo 抖一下就是一条无上下文的 unhandledRejection，而后台首页的"总字数"从此不更新（直到下次增删改文章）。同类：`dispatchEvent('afterUpdateArticle'|'deleteArticle')` 三处不 await 也不 catch（而 `dispatchEvent` 的第一句 DB 读在 try 之外）、`init.provider` 里的 `walineProvider.init()`。都补上带来源标签的 catch/try。日志卫生一并清掉：caddy 的空 `catch {}`、markdown 高亮失败与 local.provider 七处 `console.log`（含删文件/删目录/导出三条失败路径）、RSS 里一句死代码。
- **打错流水线 id 得到的是"没有这条"而不是错误**：四处裸 `parseInt(idString)`，NaN 进 `{id: NaN}` 什么都匹配不到 ⇒ `{statusCode:200,data:null}`，删除则是静默 no-op。改成 400 + 明确文案（10 种垃圾输入都测：`12abc`、`1e3`、`0x10`、30 位数字…），新旧两种行为都钉住。另删掉两个零调用方、又是 N+1 形状、还直接改统计口径的死方法（`washViewerInfoByVisitProvider` / `washViewerInfoToVisitProvider`）。
- **拆掉一个会在任何日期过去之后炸的测试**：`viewStats.provider.spec.ts` 硬编码了 `TODAY = '2026-09-16'` / `YESTERDAY = '2026-09-15'`，而 provider 用 `dayjs()` 打日期 ⇒ **过了午夜，9 条断言在零代码改动的情况下变红**，看起来完全像"viewStats 被改坏了"（本轮就发生在 00:24）。现在日期由 `dayjs()` 计算。⚠️ 通用教训：任何断言里出现字面日期，都要问一句"明天还成立吗"。
- **入库的可复现压测台**：`scripts/benchmark/loadtest.cjs`（并发扫描 / 静态吞吐 / C10K / 单请求延迟四种模式）+ `scripts/benchmark/measure.sh`（一条命令采集环境事实、延迟、页面重量、并发扫描、静态吞吐、C10K、容器资源占用），`docs/advanced/benchmark.md` 里的每个数字都由它产生。
- **multer 1.4.4-lts.1 → 2.4.0（离开每一条上传路径上的停更依赖），并且躲过一个"升级反而装上有漏洞版本"的陷阱**：`@nestjs/platform-express@10.4.22` 声明的是**精确的 `multer: 2.0.2`**，而 2.0.2 有 **8 条 2026-03…2026-09 公布的高/中危 CVE**（≥2.3.0 才修）—— 只改自己的 `package.json` 会让 pnpm 给 platform-express 装它自己那份 2.0.2，树里两份 multer，而真正跑 `FileInterceptor` 的正是有漏洞的那份。修法是根 override 加 `"multer@2.0.2": "^2.4.0"` 收敛成**单份 2.4.0**；`@types/multer` 一起升到 `^2.2.0`（**multer 2 自己不带类型**，实测 `types`/`typings` 为空）。连带：`@nestjs/platform-express` 精确钉 10.4.17 → `^10.4.22`；express 4.21.2 → **4.22.3 单份**（override 键改成 `express@4.22.1`，用 `readlink` 核过 platform-express 指向的就是它；4.21.2 与 4.22.x 都没有在世通告，CVE-2024-51999 已被撤回）；body-parser 加 `"body-parser@1.20.4": "^1.20.8"`（platform-express 精确钉的 1.20.4 有 CVE-2026-12590），并删掉已失效的 `body-parser@1.20.2` 键。⚠️ `"send@0.18.0": "^0.19.0"` **差点被当成失效删掉，删了之后 lockfile 立刻证明它不是** —— send 0.18.0 会从 `serve-static@1.15.0 ← @umijs/plugin-openapi ← umi` 那条链重新冒出来（CVE-2024-43799），已恢复；判断一条 override 是否失效，唯一可靠的方法是删掉再看 lockfile。**multer 2.4 的一个真实行为变化**已加用例钉住：它对上传文件名的 WHATWG unescape 处理与 1.x 不同（CJK 文件名、`%22` 转义），`uploadPipeline.spec.ts` 的版本钉子也更新成 multer ^2（谁再动就会红）。
- **Next 13.5.11 → 14.2.35（离开 Vercel 支持窗口之外的版本），刻意不上 15**：15 要 React 19，而 `@bytemd/react` 的 peer 只到 React 18，会把编辑器/渲染器一起拖下水；React 保持 **18.2.0**，`@next/bundle-analyzer` 与 `eslint-config-next` 同步升到 14.2.35。`next.config.js` 三处迁移：`images.domains` → **`images.remotePatterns`**（只写 hostname 的条目与原来"任意协议/端口"语义一致，**`VAN_BLOG_ALLOW_DOMAINS` 为空时仍只允许本站图片**这条硬化不变）；**删掉 `swcMinify`**（14 起是默认值、选项被忽略）；保留 `experimental.largePageDataBytes`（它是"列表页不许再塞全文"的回归护栏）。⚠️ 前台 dev 进程跑的还是旧 next 的 inode（`dev-env.sh` 没有 supervisor，不会自换），升级后必须重启 dev 栈才能做前台活体测量。
- **生产镜像构建不再跳过类型检查**：Dockerfile 的 website stage 设了 `ENV isBuild=t`，而 `next.config.js` 把它同时映射成 `typescript.ignoreBuildErrors = true` **和** `eslint.ignoreDuringBuilds = true` —— 也就是官方镜像构建一直在跳过前台类型检查，而它上面那行注释写的恰恰是"正式构建不要开"。现在类型检查**只**由显式的 `VANBLOG_SKIP_TYPECHECK=true` 控制（本地量体积时用），镜像构建从此会真的做检查（TS 5.9 清零之后这个拐杖已不需要）。⚠️ `isBuild=t` 这个 ENV **本身保留**：`api/getAllData.ts` 等处用它做"构建期后端不可达"的降级，去掉会破坏构建 —— 这次只解开它与类型检查的耦合。`eslint.ignoreDuringBuilds` 仍为 true，原因很实在：**`packages/website` 根本没有 `.eslintrc`**（仓库里只有 server 与 admin 有 lint 配置），没有可开启的 lint 路径。
- **NestJS 9 → 10、mongoose 7 → 8（离开无补丁的框架层）**：`@nestjs/common|core|testing` 9.4.3 → **10.4.22**、`@nestjs/mongoose` → **10.1.0**、`@nestjs/swagger` 6.3.0 → **8.1.1**、`@nestjs/schedule` 2.2.3 → **5.0.1**（cron 3.5.0，且不再拖 uuid）、`@nestjs/passport` → **10.0.3**、`@nestjs/jwt` → **11.0.2**、`mongoose` 7.8.12 → **8.24.4**（自带 driver 5.9.2 → **6.20.0**）。**刻意停在 Nest 10**：11 起默认 Express 5，而 Express 5 换的 path-to-regexp v8 不再接受裸 `*`，`app.module.ts` 有 **4 处** `forRoutes({ path: '*' })` 挂着 request-id / 安全头+限流 / NoStoreCache / 初始化中间件，失配的表现是"限流悄悄不生效"这类静默故障。装完后 lockfile 里只有 path-to-regexp 0.1.x 与 3.3.0、**没有 v8**，express 仍是**单份 4.21.2**、multer 仍是 1.x、**根 overrides 一条没改**。⚠️ `@nestjs/platform-express` **精确钉在 `10.4.17`**：逐版本读 registry 才发现 10.4.18+ 已把依赖换成 **multer 2.x**、10.4.22 还把 express 抬到 **4.22.1**（override 键是 `express@4.18.2`，匹配不上精确的 4.22.1 ⇒ 会出现两份 express）—— 顺带推翻了我自己"multer 2 要等 Nest 11"的判断。**唯一必须改的生产代码**是 mongoose 8 删掉的 `count()`（实测 `Model.count` 与 `Query.prototype.count` 都是 `undefined`，`ensureIndex`/`Model.remove` 也没了）：4 个调用点换成 `countDocuments()`，计数**一个都没变**（53/53、53/53、0/0、91/91，各 30 次交替取中位数），中位耗时 **+0.19…+0.40 ms/次**，explain 显示仍走同一批索引（`deleted_1`/`hidden_1`/`private_1`，statics 是纯索引的 `COUNT_SCAN[staticType_1]`）、`collectionScans: 0`；`strictQuery` 默认值仍是 `false`（源码同一行 + 运行时探针对真实 schema 都验过），否则非 schema 字段的过滤条件会被**静默丢弃**。**mongoose 8 的 `autoIndex` 与上一轮的索引瘦身没有打架**：换完原样重启，13 个集合的索引**一个都没变**、文档数也没变，启动日志仍是"冗余前缀索引：无可删"+"唯一索引=已存在"，即没把删掉的 `date_1`/`pathname_1` 建回来、也没在去重前抢建唯一索引。
- **接口行为逐条对拍（48 个只读抓取，升级前后各跑两次）**：**37/48 逐字节相同**，11 处差异全部有解释且都不影响数据 —— ① **10 个错误响应的 JSON 键顺序**变了（`{"statusCode":401,"message":…}` → `{"message":…,"statusCode":401}`；键、值、字节长度都不变，只有顺序 ⇒ ETag 变；机制在 `@nestjs/common` 的 `HttpException.createBody()`），**所有 200 响应逐字节相同**（`/api/public/meta`、文章列表 `total:53`、`article/viewer/:id`、`/theme`、`/theme.css` 204、评论设置、`robots.txt`、`feed.xml` **仍 50 条**、atom/feed.json/sitemap、5 个前台页面、后台首页、一张 1.7MB 图床图）；② **`/swagger-json`** 71,183 → 71,241 B：嵌套 DTO 的 `required` 从"每个属性写 `required:true`"（OpenAPI 3 里不合法）改成父级数组、两条路由补上 `tags`、重名 `operationId` 消歧成 `[0]`/`[1]` —— `openapi` 仍 3.0.0、**121 条 path 与 16 个 schema 的名字列表完全一致**，`/swagger` 的 HTML 逐字节相同。响应头逐个核对未变（`x-request-id` 连 404 都有、4 个安全头、后台路径 5 个 no-store 头、`Keep-Aliven: timeout=65`、图床缓存头）；body 解析器顺序也用探针钉住（200KB 打 `/api/admin/article` = **401** 说明 50mb 解析器先跑、200KB/900KB 打公开路由 = **201**、1.3MB = **413**，前后一致）。另用一个只读量具把 21 个 provider 调用产生的 **38 条查询**的 filter/projection/options 与 explain 全量落盘做 7 vs 8 对拍：**38/38 条相同、35/35 个 `planCacheKey`+`queryHash` 相同**（唯一差异是 SBE 计划串里内嵌的 `NOW` 时间戳与槽位渲染顺序，归一化后为 0）。⚠️ 过程中抓到两个会让审计**假绿**的量具 bug：explain 摘要用**白名单**漏掉了顶层 `queryPlanner`/`executionStats`/`stages`，38 条全变成 `{}`（"完全一致"当时是空结论）；以及 `countDocuments()` **会忽略 explain 选项直接返回数字**，两边都拿到 `0` 看着也"完全一致"。
- **补上三块以前根本测不到的面（17 条新用例，942 → 959）**：`uploadPipeline.spec.ts`（6 条）用仓库真实的 multer 配置发**真的 multipart**，钉住 buffer/mimetype/size、`assertUploadedImage` 认出 png、fileFilter 拒 `.html` → **400**、`limits.fileSize` → **413**、`diskStorage` 落盘字节一致，外加一条**版本钉子**（谁抬 platform-express 就会红）—— 以前这块零覆盖，因为 **Nest 的 guard 跑在 interceptor 之前**，上传接口全在 `AdminGuard` 后面，匿名请求连 multer 都碰不到；`cronRegistration.spec.ts`（6 条）向 `SchedulerRegistry` 要证据：恰好 2 个 job、表达式与源码一致、都已 start、下次触发严格整点/间隔 1 小时与 00:00/间隔 24 小时，并用 `fireOnTick()` 真的打到两个 `handleCron`（⚠️ schedule 5 里不写 name 的 `@Cron`，job 键是 `crypto.randomUUID()`，**别断言名字**）—— 调度器升级最坏的失败是"应用照常起、接口全 200、cron 从此不跑"，日志里一个字都没有；`token.provider.jwt.spec.ts`（5 条）用与 `app.module.ts` 同形状的 `JwtModule.registerAsync` + 真 `JwtService` 验签发与校验（HS256、`exp-iat` 等于设置的 `expiresIn`、7 天默认与 60 秒覆盖、API token 365 天、换密钥与篡改 payload 都验不过）—— 这条路本机无法用 HTTP 验，坏了只会表现为"下次登不进后台"。
- **复活 3 个早就编译不过的 e2e**：`word-count` / `friend-link` / `page-copy` 都报 `TS2554: Expected 4 arguments, but got 5`（`MetaProvider` 只有 4 个构造参数），修完又接连暴露 `viewStats.invalidateBase is not a function`、`categoryModal.find is not a function`、`walineProvider.restart(...).catch` 的 `Cannot read properties of undefined`（桩返回 `undefined` ⇒ 接口 500）。**烂了这么久没人知道的原因**：这三份文件同时被两道关卡漏掉 —— 默认 `jest` 是 `rootDir: src` + `testRegex .*\.spec\.ts$`（不含 `test/`），而 `tsconfig.build.json` 又 `exclude: ["test", "**/*spec.ts"]`。现在 1/1 + 4/4 + 2/2 全绿，桩模型也**只**留 `countDocuments`（留着 `count` 会让"退回旧 API"这种回归静默通过）。**建议给 CI 补一条把 spec 与 `test/` 一起 typecheck 的命令**（本轮那份临时配置实测 0 错误，且已经抓出这 3 个 TS2554）。
- **两条旧记录更正**：`swagger-ui-express` 是**死依赖**（全树 0 处 import，`@nestjs/swagger` 8.1.1 用的是自带的 `swagger-ui-dist 5.18.2`，6.3.0 当年也一样），白占一份 `swagger-ui-dist@4.19.1` + 一个 express peer 链接，可以删；AGENTS §7.47 说"express 4.17.1 是 swagger-ui-express 带的"**归属错了**，lockfile 显示它在 **umi-dev/umi-core**（admin 工具链）下面。
- **修掉后台的一处存储型 XSS**：「日志管理 → 系统日志」用 `ansi-to-html` 把日志转成 HTML 再 `dangerouslySetInnerHTML` 渲染，而这个库的 `escapeXML` **默认是 false** —— 日志里的尖括号会原样变成标签。日志里完全可能出现访客可控的字符串（404 路径、上传文件名、评论作者、子进程输出里的 URL），谁打开那个页面谁中招，而后台 token 就在 localStorage 里，等于交出管理员会话。现在显式 `escapeXML: true`（ANSI 颜色照常），并加了测试：用真库验证 `<img src=x onerror=…>` 被转义、默认配置的对照组仍然漏出真标签（证明不是白改）、且全后台只允许这一处 `dangerouslySetInnerHTML`。
- **依赖升级第二批**（第一批之后 server stage 已按 lockfile 安装，所以这些**真的会进镜像**；每条都读了装好的 `package.json` 确认解析结果）：**sharp `0.32.6 → 0.35.4`**（0.32.6 那串 libvips/libheif CVE 终于能修；顺带把"只能停在 Node 20"的锁解开了 —— 0.32.6 的预编译包只到 NODE_MODULE_VERSION 115）、**`markdown-it-katex` → `@traptitech/markdown-it-katex` 3.6.0**（原包 2016 年起无人维护、带着**无修复版本**的 XSS、内部钉 katex 0.6，而前台样式表是 0.16 —— 换掉之后服务端渲染的数学标记与前台样式对齐，RSS 里的公式 HTML 会变，这是有意的）、**express 4.18.2 → 4.21.2** 连带 **body-parser 1.20.3+**（CVE-2024-45590，每个 urlencoded POST 包括登录都过它）与 **send 0.19**、**@waline/vercel 1.31.7 → 1.41.6**（拖进来的 koa 有 **critical ReDoS**，打在**匿名**评论接口上）、**mermaid 10.6.1 → 10.9.3**、**katex → 0.16.47**、**dompurify → 3.4.15 / 2.5.9**（按大版本分别钉：有消费者钉 `^2`，不强推到 3）、**prismjs → 1.30.0**，并删掉已经没人用的 `line-reader` 与 `@types/line-reader`。override 全部按**版本作用域**写（`express@4.18.2`、`dompurify@3`…），因为仓库里同时有 express 4.17.1 / send 0.17.1 / qs 6.5.3 属于别的消费者，全局 override 只有改动量没有安全收益。
- **sharp 0.33+ 是结构性变化，顺手退休了一个老修法**：0.33 之前 sharp 有 install 脚本会去下载 libvips，**0.33 起预编译二进制改成 npm 的 optionalDependencies**（`@img/sharp-<平台>`），装包时不下载、不跑脚本。于是 **#413 那类故障从根上不可能再发生**（当年 Alpine 上 musl 版本号 `1.2.4_git20230717` 不是合法 semver，安装脚本拿它跑 `semver.lt` 抛 `Invalid Version` 把构建搞挂，修法是把 sharp 钉死在 0.32.6）。实测新包：没有任何 install/preinstall/postinstall 脚本、`install/libvips.js` 不存在、musl 的两个预编译包都在 optionalDependencies 里。⚠️ 平台预编译包是 **optional** 依赖，装不上时只 warn 不 fail、**要到第一次 `require('sharp')` 才炸**，所以测试里必须真跑一次编解码。Dockerfile 里那套 `VAN_BLOG_SHARP_DIST_HOST` / `npm_config_sharp_*_host` 从此**失效但故意保留**（牵连 `vanblog.sh`、`build-image-local.sh`、`dev-env.sh`、三份文档与两个测试里已公开的变量名，清理它是独立的一次改动），已就地注明。
- **修掉一个会让镜像构建失败的坑（升 waline 时撞到）**：`@waline/vercel` **硬依赖** `better-sqlite3`，而它在 musl 上**没有预编译包**，每次都要现场 node-gyp 编译；Alpine 3.20+ 自带 Python 3.12、**distutils 已被移除**，而 corepack 里 pnpm 8 带的 node-gyp 9.4.1 仍然 `from distutils.version import StrictVersion` ⇒ `ModuleNotFoundError` ⇒ waline stage 的 `pnpm i` exit 1。修法是在那个 stage 加 **`py3-setuptools`**（把 distutils 补回来），已单独构建该 stage 验证通过。⚠️ 同样的 distutils 报错在 admin stage 的 tree-sitter 上也有，但那是**幻影依赖**、不影响构建结果 —— 看到 gyp 报 distutils 要先分清是不是致命路径。
- 两处"钉住旧世界"的测试改成钉新世界而不是删掉：website 的 `sharpAlpineInstall.spec.ts`（4 → 6 条：sharp ≥ 0.33、无 install 脚本、`install/libvips.js` 不存在、musl 预编译包在 optionalDependencies 里、lockfile 无 0.31/0.32、真跑一次 webp 编解码）与 `scripts/tests/dockerfile-alpine-sharp.test.sh`（23 → 27 条断言）。⚠️ 升级后旧 spec 报的**不是版本不匹配**而是 `Package subpath './package.json' is not defined by "exports"` —— sharp 0.33+ 的 `exports` 只导出 `"."`，读已安装包的 package.json 要用**文件路径**而不是 `require.resolve` 的子路径。
- **补上一批 semver 范围内的安全升级**（server stage 已经改成按 lockfile 安装，所以这些升级**这次真的会进镜像**）：`axios` `^1.6.2 → ^1.16.0`（实装 1.20.0；SSRF CVE-2024-39338 等 12+ 条高危，它负责抓远程图片与查 IP 归属地）、`mongoose` `^7.6.6 → ^7.8.9`（实装 7.8.12；3 条搜索/`sanitizeFilter` 注入公告，仍是 7.x，与 @nestjs/mongoose 9、TS 4.9、Node 20 都兼容）、`next` `^13.5.6 → ^13.5.9`（实装 13.5.11；缓存投毒 GHSA-gp8f-8m3g-qvj9，零代码补丁版本），以及两条 `pnpm.overrides` 处理**间接**依赖：`jws → ^3.2.3`（GHSA-869p-cjfg-cm3x，**HMAC 签名校验缺陷**，而它就是后台会话的签名链，由 jsonwebtoken 带进来）、`form-data → ^4.0.6`（可预测的 multipart 边界 + CRLF 注入，由 axios 带进来）。全部 4 套测试在升级后重跑：server 690（689 绿 + 1 个既有的离线字体用例）、website 62 文件 / 622、admin 344、脚本 22 文件 / 1105，开发栈三个端口也都正常。
  ⚠️ 过程中的两个坑：改了 `pnpm.overrides` 之后 pnpm 会要求"清空并重装 node_modules"，**在非交互环境里它会弹确认然后什么也不做**（日志里只有 `Proceed? (Y/n) ‣ true` 就结束，版本一个没变）—— 要 `CI=true`；而 `CI=true` 又会让 pnpm 默认 `--frozen-lockfile`，与刚改的 overrides 冲突报 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`，所以要显式 `--no-frozen-lockfile`。另外重装时 sharp 的 install 脚本会去 GitHub 拉 libvips（本机拉不动而失败），必须像 Dockerfile 那样带上 `npm_config_sharp_binary_host` / `npm_config_sharp_libvips_binary_host` 指向 npmmirror。**第一次失败的那次运行已经把 node_modules 清空了**（`Recreating .../node_modules` 之后才报配置不匹配），开发环境当场瘫掉 —— 所以这类操作要么先确认参数、要么准备好重装命令。
- **镜像不再默认允许上游作者的图床域名**：`Dockerfile` 里两处 `ENV VAN_BLOG_ALLOW_DOMAINS="pic.mereith.com"` 改成空。原值意味着每个 fork 部署的 `next/image` 优化器都会去别人的域名取图 —— 那个域名一旦过期被注册，就等于让第三方通过你的 `/_next/image` 提供内容（还放大了 next 13 图片优化器的那批公告）。空值在生产环境等于"只优化本站图片"（`getAllowDomains()` 已验证），要允许远程域名在编排文件里设 `VAN_BLOG_ALLOW_DOMAINS`。
- **入库文件里的生产标识脱敏**：生产域名与真实后台用户名以前出现在 3 个 server spec、1 个脚本测试、2 篇文档与 AGENTS 里，统一换成 `example.com` / `blogadmin`。另外 `build-image-local.test.sh` 里那条"不许有内网地址"的断言原本把**具体那个内网 IP** 写进了测试文件（等于把地址提交进公开仓库），改成匹配整个 RFC1918 段的正则。
- **`.dockerignore` 补上本机目录**：本地构建上下文从 **27GB**（`.tools` 1.9G + `vanblog_dev` 25G）降到与 CI 干净 checkout 相当的量级；顺带不再把 `AGENTS.local.md`（含代理地址、生产域名、密钥路径）随上下文 tar 包送进 daemon。
- **mongo 加 `stop_grace_period: 60s`**：docker 默认 10 秒就 SIGKILL，慢盘或库大一点会在 flush 中途被杀（WiredTiger 有 journal，真损坏不多见，但这是免费保险）。`mem_limit` 的注释补上了关键的相互作用：整站备份在容器里跑 `zstd -19 --long=27 -T0`，峰值近 1GB，**开了内存限制又不降压缩等级，备份会被 OOM 杀掉**。
- **CI 从"六个从没跑过的工作流"收敛到四个有用的**（GitHub API 实测这个 fork 一共只跑过 3 次）：删掉 `test.yml` / `test-arm.yml` / `local-build.yml` / `deploy-docs.yml`（都是作者的基础设施 —— 推 `mereith/van-blog`、`kubectl set image` 到作者的集群、刷作者的 CDN，用的还是不存在的 secrets 与已废弃的 `::set-output`）与 `scripts/sync-aliyuncs.sh`；`server-test.yml` / `admin-e2e.yml` 以前只在 `pull_request → master` 触发而开发全在 `dev/dsh` 上 ⇒ **永远不跑**，现在加了 `push: dev/dsh`（带 paths 过滤）、`concurrency`、超时 15→30 分钟，并把新增的 spec 加进 jest 的 `testPathPattern`；删掉那个**必然失败**的 `alpine-sharp-install` job（grep 的是 `node:18-alpine AS WEBSITE_BUILDER`，早已改成 `node:20-alpine AS website_builder`）。
- **修掉 3 条假绿断言**：`dockerfile-alpine-sharp.test.sh` 在整个 stage 文本里搜 `vips-dev`/`fftw-dev`，而 stage 里正好有一行注释写着"去掉 vips-dev/fftw-dev…" —— 断言匹配到的是**解释为什么没装**的注释，结论正好反了（删掉 `libc6-compat` 它照样绿）。现在先剥注释、只取真正的 `RUN apk add` 行做正反两向断言。

**修复**

- **`stego.spec.ts` 的降级用例隐式依赖测试数据长度**：断言 `repetition < 3`，而载荷从 45 字节缩到 42 字节后 400×400 就放得下 3 份了（脱敏之后才暴露）。改成显式构造 70 字节载荷，并把窗口写进注释（≤50 字节 → 3 份放得下；200 字节 → 1 份都放不下）。
- **`/atom.xml` 一直是 404**：caddy 里这条路由的 rewrite 是从 `/feed.xml` 复制来的，`find` 写成了 `/feed.xml`，永远匹配不上，于是请求原样打到 server 上 404 —— 而 `/feed.xml`、`/feed.json` 都是好的，文档里也把 `/atom.xml` 当公开地址写着，所以特别隐蔽。现在三条短地址（`/feed.xml`、`/atom.xml`、`/feed.json`）都正确改写到 `/rss/...`，并写进了测试。

## [v2026.09] - 2026-09-14

本 fork 的第一个正式版本。基线是上游 master `ccd708ce`（v0.54.0+），在此之上累积了
内置评论系统、整站备份/恢复、图片管线、SEO、Apple 风格前台皮肤、以及一整轮部署与镜像加固。


### 🍴 本 fork（`CKboss/vanblog` 分支 `dev/dsh`）的改动

> 下面这些**只存在于本 fork**，不在上游 `Mereithhh/vanblog` 的任何发布里。
> 详细说明见 [README · 与上游的关系](README.md#与上游的关系)、[CHANGELOG.md](CHANGELOG.md)、[AGENTS.md](AGENTS.md) 与各功能文档。
> （README 已改成以本项目为主视角，原来的「本分支新增内容」章节已并入 CHANGELOG 与 AGENTS。）

**新功能**

- **内置评论系统**：评论存在本站 Mongo、走本站接口，前台自研组件（两层回复、分页、基础 Markdown、博主标识、深色模式），后台原生管理页（审核 / 编辑 / 删除 / 批量 / 按状态与关键词筛选）。后台「评论设置」三选一：`内置 / Waline / 关闭`；老站点升级默认保持 Waline，切换不迁移数据。支持从 Waline 导出文件**一键导入**（默认只导正式显示的、按 objectId 幂等、保留原始时间与点赞、`data:` 图片折叠成 alt）与**只导出已通过评论**。[评论系统](docs/features/comment.md)
- **补齐 6 种 markdown 语法**：`==高亮==`、`X^2^` / `H~2~O`、`:smile:` 短代码、定义列表、GitHub 提示块 `> [!NOTE]`、`[[toc]]`。编辑器与前台用同一套插件（按 bytemd 的 unified 10 世代挑版本）。⚠️ 单个 `~x~` 现在是下标，删除线要写 `~~x~~`。[Markdown](docs/features/markdown.md)
- **整站备份 / 恢复**：一个高压缩归档（zstd → xz → gzip）打包全部集合 + 评论库 + 图床/附件/自定义页面，支持不解压看清单、鉴权下载、上传恢复（逐集合原子替换 + 重建索引）。[备份](docs/advanced/backup.md)
- **单篇导出 `.md` / `.mdz`**：`.mdz` 是 Typora 风格带图包（相对链接 + `<标题>.assets/`），外链图片自动抓取，抓不到会保留原链接并生成说明清单。
- **图片管线**：长边 1920 自动缩放、300px 缩略图、隐写水印（抗压缩/转码、可检测）、原地替换而 URL 不变、小图/大图/列表三种视图、批量引用查询。[图床](docs/features/image-storage.md)
- **附件管理**：任意文件上传生成 URL（按内容去重），html/svg/js 强制下载 + `nosniff`，可搜索引用、批量导出。[附件](docs/features/attachment.md)
- **拼音文章路径**：新建文章自动生成 `/post/<pinyin-slug>`，重名自动 `-2`/`-3`，历史文章可一键回填；`/post/<数字 id>` 永远可用。[文章](docs/features/article.md)
- **Apple 风格前台皮肤**：后台一键切换，纯 CSS 且每条规则都带 `[data-ui="apple"]` 作用域，不影响自定义 CSS。[配置](docs/features/config.md)
- **自动摘要**：没写 `<!-- more -->` 时取正文前 200 字，不会切断链接与 emoji。
- **标题可选中 + 一键复制**（标题与文章链接），导航栏站点名同样可复制。

**性能**

- 前台首屏 JS：首页 432 → 286 kB、文章页 427 → 281 kB、友链页 418 → 172 kB（KaTeX / mermaid / TOC 数学按需加载）；正文图片 `lazy`、封面 `preload` + `fetchpriority=high`；图床静态资源从 `max-age=0` 改成 `max-age=3600, stale-while-revalidate=604800`。[前台性能](docs/advanced/performance.md)
- 后台 `dist` 27 → 24 MB，`umi.js` 1133 → 1077 KB，编辑器路由首包 ~1748 → ~911 KB，mermaid 从 3 份产物减到 1 份，`lodash` 改按需引入。
- 访问量计数改成原子 `$inc`（并发下不再互相覆盖、永久少算）；改站点信息不再无条件重启前台（环境变量没变就跳过，省掉几秒停站）；流水线装依赖不再用 `spawnSync` 阻塞事件循环。

**修复**
- **自定义主题会被 `getSiteInfo()` 吃掉**：`meta.provider` 里 `uiStyle` 的归一化写的是"非 `default` 一律压成 `apple`"，于是上传的主题一启用，凡是走 `getSiteInfo()` 的地方（后台表单初值等）都显示成 Apple 风格，看着像没存上。现在原样保留主题 id，缺省仍是 `apple`。
- **前台页脚署名**，而 `/admin` 与 `/api` 正常**：Next 13 的 standalone server 用 `HOSTNAME` 决定监听地址，容器里那是容器 ID，于是它只绑那个网卡 IP，而 caddy 反代的是 `127.0.0.1:3001`。现在 `WebsiteProvider` 显式传 `HOSTNAME=0.0.0.0`（可用 `VANBLOG_WEBSITE_HOST` 覆盖）。
- **中文别名的文章 500**：规范地址 308 重定向把中文直接塞进 `Location`，而 HTTP 头只能是 Latin-1 → Node `setHeader` 抛 `Cannot convert argument to a ByteString`。新增 `utils/encodeLocationPath.ts`（纯 ASCII 原样返回，避免把已编码的 `%xx` 再编成 `%25xx`；含非 ASCII 时按 `/` 分段编码）。**假数据永远测不出来**，只有真实数据里有中文别名才会踩到。
- **`/robots.txt` 404**：动态 robots 由 server 提供，但 caddy 模板没有这条路由，落到 catch-all 转给前台。⚠️ 而且模板里有 `srv0(:443)` 与 `srv1(:80)` **两套路由**，只补一套就变成"HTTPS 正常、HTTP 404"。现在两个都补了，并有守卫测试要求两套路由完全对齐。
- **前台页脚署名**：`Powered By VanBlog <版本>` 改指本分支仓库，后面跟一个「增强修改版」链到 README 的改动清单（以前指向上游文档站，访客点进去看到的说明与本站实际行为对不上）。
- **后台「有新版本！」假警报**：源码构建的版本号是 `dev/dsh@<sha>`，老代码用字符串比较（`'dev/dsh@…' >= 'v0.54.0'` 首字符 d<v）判定"有新版本"，于是每次进后台都弹一次。现在只有两边都是正式发布号时才按数字段比较。
- **后台 14 处帮助文档链接**改指仓库内 `docs/**.md`（与运行的代码同版本）：上游文档站改过目录结构，其中 **6 处已经 404**（编辑器帮助文档、协作者、ISR、评论设置、HTTPS 等页签）。另有两处 anchor 在本分支文档里不存在（`升级方法`、`外置图床`），改为只链到文件。

- 前台：导航栏悬停下划线与当前页那条**不在同一水平线**（缩放画在了带下划线的 `<li>` 上）；侧栏 headroom 实例与 scroll 监听泄漏，以及 StrictMode 下 `destroy()` 抛错导致「一滚动就报错」；文章目录高亮在客户端跳转后仍用上一篇的标题（还会把地址栏 hash 改成上一篇文章）；代码块里的 `<!-- more -->` 会把摘要截成半个围栏；不存在的文章与非法页码返回 200 软 404（还会污染 ISR 缓存）；标签 `C++` / 分类 `a&b` / 搜索 `C#` 因查询串未编码而查错。
- 后台：6 处「请求失败就永远转圈」（其中改路径冲突会让编辑器整页冻住）；「导出全部本地图床内容」按钮抛 `ReferenceError`（漏 import）；登出 401 时半登录状态；`/admin/admin/...` 死链与没人读的 `?subTab=` 深链；标签搜索凭空造出不存在的标签；三个概览 tab 共用同一个 localStorage key 互相串数；HTTPS 设置更新失败仍切换协议；初始化页把 500 当成功（死分支）；评论管理页 dev 下指向硬编码内网地址；后台整页白屏（MFSU 解析不了 exports-only 的 ESM 包，用 `patches/` 两个 pnpm patch 修好）。
- 服务端：流水线不返回时会**永久卡住保存文章**（补超时与 `error`/`exit` 监听）；`getNewId()` 一次查询失败就让所有新建请求空转到重启（改 `try/finally`）；图片链接解析把 alt 文本与代码块示例当成真图片（误报失效图片 + 往库里插垃圾记录）；「本地化远程图片」会改坏教程里的 ```md 示例；导出时 `\bsrc=` 误匹配 `data-src`、坏的百分号转义让整个导出 500；备份恢复时非法 `$date` 被写成 1970。

**安全**

- 公开接口的 Mongo 操作符注入、搜索接口正则注入与 500、图床上传任意文件导致的同源存储型 XSS、导出接口重定向 SSRF；加密文章经搜索 / RSS / 解锁接口的三处泄露；导出归档匿名可下载；登录限流可被伪造头绕过；演示站下的管线 RCE；备份恢复的半恢复与进程崩溃。
- 加密文章解锁接口限次（同 IP + 同文章 10 分钟 20 次）；`/swagger` 可用 `VANBLOG_SWAGGER=false` 关闭；`/api/revalidate` 支持共享密钥与路径校验；ISR 触发地址改用 `URLSearchParams`（`encodeURI` 不编码 `#`，而文章别名允许 `#`）。
- 评论（匿名可写）的渲染链路比正文严得多：原始 HTML 不解析、白名单不含 `img`/`iframe`/`style`/`svg`、链接强制 `nofollow noopener noreferrer`、服务端重新校验每个字段（显式拒绝 `javascript:` 等 scheme、剥双向控制符）、蜜罐 + 三重限流、公开接口不返回邮箱/IP/UA。[安全与加固](docs/advanced/security.md)

**部署与开发**

- 一键脚本 **v0.5.0**：
  - `backup` **默认改成整站备份**（调 server 接口，产出 `vanblog-full-*.tar.zst`：一致性快照、NDJSON 跨版本可恢复、可预览清单）；原来的"打包数据目录"降级为 `backup --offline`（另有 `--offline --consistent` 先停 mongo）。`--format zstd|xz|gzip` 可选。站点没起时**不静默降级**，而是报错并给出两条路。
  - `restore` 支持**一步恢复整站备份**：不带参数会列出服务器上的归档让你选；给名字时不上传（接口直接读服务器上的文件），给本地路径才 multipart 上传；`--no-static` 只恢复数据库。恢复前先 `full/inspect` 打印清单，恢复走接口**不停服**（server 自己按集合原子替换 + 重建索引 + 触发全量渲染）。认证支持 `VANBLOG_ADMIN_TOKEN`，或交互输入账号密码由脚本**本地派生口令**（明文不出本机，且只试一次不触发登录限流）。
  - 新增 **`reset`：新机器上从整站备份一步重置整站**（`./vanblog.sh reset <归档名|本地路径>`，或 `VANBLOG_RESTORE_FROM=<归档> ./vanblog.sh install` 装完顺手恢复）。它自动解开"恢复接口在鉴权后面、而全新站点没有账号"这个死结：站点没初始化时用**随机口令的临时账号**初始化 → 登录 → 打印备份清单 → 恢复 → **重启容器**（让 server 重新读取恢复后的 JWT 密钥）→ 逐项核对（接口/站点名/首页/后台/robots/sitemap/文章数）→ 告诉你"用备份里原来的账号登录"。恢复失败时会把临时账号打印出来，不至于把你锁在新机器外面。参数：`--no-static`、`--no-restart`、`--verbose`。
  - 备份清单默认只打**摘要**（归档名/备份时间/格式大小耗时/集合文档文件数/各集合条数），`--verbose` 才给完整 JSON —— 原来一次恢复要刷 114 行，屏幕上全是 `},`。
  - **交互菜单与 `--help` 重写**：菜单门头改指本分支（上游只作为出处提及）、"安装来源"不再谎称默认本地构建（现在默认拉 ghcr 镜像、拉不到才构建）、新增 `13. 状态总览`，并在顶部加一行**运行状态**（未安装 / ● 运行中 + 访问地址 / ○ 接口不通 + 排查提示）；条目按「安装与日常 / 备份与恢复 / 其它」分组，每项都写清现在到底做什么（备份=整站备份、恢复=不停服、卸载=不删备份）。**编号全部保持不变**（文档与老用户都按编号操作）。`--help` 从 30 行流水账重写成分组详解：每个子命令的全部参数与注意事项、环境变量按用途分组、常见场景配方（新机器装机、换机器一步搬站、cron 定时备份、升级、回滚、站点打不开怎么查、磁盘满了）、退出码与路径约定；原来 `backup`/`restore` 各有两条互相矛盾的条目、还写着"默认从源码构建本分支"。
  - 新增 `status` 子命令与 `--help`：一屏看清脚本版本、安装/数据目录、编排里的 vanblog 与 mongo 镜像、mongo 数据是否存在、HTTP 端口、接口探活、`docker-compose ps`、各目录占用、整站备份数量与最近三个归档、磁盘剩余（含挂载点）。全部只读。
  - `config` **不再把镜像悄悄换回上游官方版**（以前改个邮箱/端口就会把本分支镜像替换成 `mereith/van-blog:latest`，所有分支功能消失且无提示）；现在沿用编排里现有的镜像。
  - MongoDB 版本按"有没有数据"决定：全新安装用 `mongo:7.0`（上游钉的 4.4.16 早已 EOL），**已有数据目录时保持原 tag**（数据目录与 FCV 绑定，直接换大版本 mongod 会拒绝启动），并打印两条升级路径；`VANBLOG_MONGO_IMAGE` 可覆盖（老机器不支持 avx 就用 4.4.16）。
  - `restart`/`start`/`stop` **如实返回 docker-compose 的退出码**（以前永远返回 0，到处打印"成功"；离线恢复还会因此在 mongod 没停的情况下解压覆盖数据目录）。现在停不下来就不解压。
  - 自更新加固：`bash -n` + 首尾标志校验（截断的下载不再能覆盖掉唯一一份可用脚本）、下载到 `mktemp`（不再用固定的 `/tmp/vanblog.sh`）、版本相同不替换、覆盖与 `exec` 都用脚本自身的绝对路径。
  - 下载不再关闭 TLS 校验（原来 wget 带 `--no-check-certificate`，而下载的正是编排模板与脚本自己）；wget 失败退 curl，而不是退到"不校验"。
  - 构建时自动探测四个下载源并传给 Dockerfile：pnpm 源、Alpine 软件源（官方 dl-cdn 实测 8 秒起，会让构建看起来卡死在 `apk add`）、node-gyp 的 Node 头文件源、sharp/libvips 预编译包源。
  - 其它修复：`VANBLOG_DATA_PATH_RAW` 以前写死 `/var/vanblog/data`（换数据目录后编排文件与 backup/restore 各写各的地方）；邮箱里的 `&` 会被 sed 展开成整个匹配（ACME 拿到非法地址、HTTPS 一直签不出来）；`get_compose_http_port` 会把 `"3000:8080"` 当成映射到 80；`clone_or_update_source` 克隆前无条件 `rm -rf` 源码目录；编排模板校验太松（截断的模板能过，会生成一份没有 mongo 的编排文件）；docker 装不上时 `exit 0`；卸载只删上游镜像（现在连本分支镜像、本地 tag 与自建 shim 一起清，且只删自己写的 shim）；SELinux Enforcing 时给出提示。
- **镜像**：
  - 四个构建阶段 `node:18` → **`node:20`**（18 已于 2025-04 EOL）。**没有升到 22/24**：Node 23 移除了 `util.isObject`（`@nestjs/cli` 9 在用），而 sharp 0.32.6 没有 Node 22 的 prebuild。
  - server 阶段从 glibc 换成 **alpine**（与 runner 同一个 libc：以前 glibc 编出来的原生模块拷进 alpine runner 根本加载不了，只能靠"回退去用前台那份 musl sharp"绕路）。
  - 新增 **`waline_builder`** 阶段：`sqlite3@5.1.7` 没有 Node 20（ABI 115）的预编译包（node:18 时代有，所以是升 Node 暴露出来的），必须现场编译；放在独立阶段编好、runner 只拷 `node_modules`，**编译器不进最终镜像**。
  - sharp 走 **npmmirror 的预编译包**（含 musl 版），不再从 github.com 下载（国内直接 aborted）。⚠️ sharp 只认环境变量，写 npmrc 没用（pnpm 8 不会把自定义键转成 `npm_config_*`），所以是用 Dockerfile 的 `ENV` 传的。server/website 两个阶段因此不再需要 gcc + vips-dev，**server 阶段的 apk 从 218 个包降到 1 个**。
  - admin/website 两个 alpine 阶段跳过 `tree-sitter{,-json,-yaml}` 的编译：它们是 `swagger-ui-react@3.52.5` 带进来的**幽灵传递依赖**（源码与 dist 里没有任何一处 import），而在 musl 下 node-gyp 会**卡死**（进程活着、线程全 sleep、没有 make 子进程）。admin 的 `pnpm install` 从"永远不结束"变成 2m24s。
  - 两个阶段改成按包过滤安装（`--filter "@vanblog/admin..."` / `"@vanblog/theme-default..."`），不再把整仓依赖都装一遍；仍然 `--frozen-lockfile`。
  - **caddy 配置自适应**：Caddy 2.11 把 on-demand TLS 的 `ask` 换成了 `permission` 模块，旧写法会让它**拒绝加载整份配置**。新增 `scripts/caddyConfig.js` 生成两种写法，entrypoint 各跑一次 `caddy validate`，用通过的那个（结构是拿镜像里 `caddy adapt` 的输出对照的）。邮箱替换也在解析后的对象上做，不再是文本 sed。
  - caddy 主配置起不来时**降级**到 `caddyFallbackTemplate.json`（同一份路由、去掉 `apps.tls`，HTTP 仍可用、443 走自签），而不是像以前那样整个容器"在跑但 80/443 全没监听"。
  - `HEALTHCHECK` 探 **caddy 的 80 端口**（一条检查覆盖 caddy → server → 前台 → 后台静态文件），用镜像自带的 node（镜像里没有 curl），`start-period=180s`；补 `EXPOSE 443`。
  - 镜像默认 `EMAIL` 从上游作者的邮箱改成空（没设 EMAIL 的用户以前会拿作者地址去注册 Let's Encrypt 账户）；caddy 的 admin API 从 `0.0.0.0:2019` 收到 `127.0.0.1`。
- **容器运行时**：
  - server 崩了容器**跟着退出**（以前 `start.js` 只打印一行"已停止"就不管了，容器停在 Up 状态而里面没有任何服务，`restart: always` 永远不触发）。
  - `docker stop` 现在**真的优雅**：entrypoint 用 `exec node start.js`（node 当 PID 1 直接收 SIGTERM）、`start.js` 接 SIGTERM/SIGINT/SIGHUP 并转发给子进程、`main.ts` 同样接三个信号依次停 waline / 前台 / `app.close()`。以前三处都只接 SIGINT，而且转发用的 `process.kill(-pid)` 会抛 ESRCH（子进程没有独立进程组），每次停容器都等满 10 秒宽限期再 SIGKILL，**正在写的备份/导出/恢复上传会被截断**。
  - `/var/log` 里的 stdio 日志按 20MB 轮转（以前无限追加，而 `/var/log` 是挂到宿主机数据目录的卷，跑几个月能把磁盘写满进而拖垮 mongo）。`vanblog-stdio.log` 保留 —— 后台「查看日志」读的就是它。
  - waline 崩溃后**自动重启**（2s×n 退避、5 次上限、稳定运行 1 分钟后重置计数、主动 stop 时不重启）。以前只打一行日志，评论会一直 502 而容器看起来正常。
  - `initJwt`（启动后第一次碰库）连不上 mongo 时重试 10 次×3 秒，不再一次失败就让容器崩溃循环；`depends_on` 只保证启动顺序，不保证 mongod 已可连接。
  - 「忘记密码」的恢复密钥 `restore.key` 以 **0600** 写入（它在挂到宿主机的 `/var/log` 下，还会被脚本备份一起打包）。
- **compose**：两个服务都加 json-file 日志上限（`10m × 3`，否则容器 stdout 也会无限增长写满宿主机分区）；vanblog `depends_on: mongo`；mongo 版本改成占位符由脚本决定，并写明"不要直接换 `latest`"（4.4 → 8.x 没有直升路径）；示例 compose 的镜像改成本分支的 ghcr。
- **本地构建与验证**：新增 `./scripts/build-image-local.sh`（构建 + 冒烟测试，支持 docker 与 **podman rootless 免 sudo**、单层构建、小内存档位）。冒烟测试起临时 mongo + 容器，逐个打关键路径，然后**扫日志里历史上真炸过的特征**（`Cannot find module` / `caddy process exited` / `Reached heap limit` / `ERR_INVALID_URL` / `降级使用` …），再看 `RestartCount`、健康检查与 `docker stop` 耗时（接近宽限期就说明 SIGTERM 没转发）。构建后必须 `image exists` 复核 —— **被 SIGTERM 打断的 `podman build` 会返回 0**，只信退出码会宣布"构建成功"而镜像根本不存在。
- **文档**：安装/备份/升级/FAQ 与脚本的真实行为对齐（原来还在教 `docker-compose down -v`，那会删卷；安装地址指向上游脚本，装出来是官方版）；新增 [本地构建与验证镜像](docs/advanced/local-build.md)；补 [整站备份](docs/advanced/backup.md) 的脚本用法与三种备份对比表；修 7 处死锚点与 README 预览图路径。

- **后台「关于」页指向本分支**：标注「增强修改版」，列出 9 条主要增强点，链接改指 `CKboss/vanblog` 的 `dev/dsh`（Github / 提交历史 / CHANGELOG / 改动总览 / 仓库内文档 / 开发手册 / 本分支 Issues）；底部单独一块**致谢原始项目**（@Mereithhh 的上游仓库、官方文档站、交流群、打赏），并注明上游文档描述的是官方镜像的行为。

- 一键脚本 `vanblog.sh` v0.4.0：**从本分支源码克隆并本地 `docker build`**（本 fork 没有发布镜像），`update` 改成 fetch + 重建且构建失败不停机，编排模板优先用仓库里那份，卸载会清源码目录；`VANBLOG_USE_UPSTREAM_IMAGE=true` 可回到官方镜像。
- 一键脚本 v0.3.7 体检：`backup --consistent`、`restore` 校验压缩包并清 `mongod.lock`、常规操作不再 `down -v`（那会删卷）。
- `./dev-env.sh bootstrap`：一条命令备好 Node 20 + pnpm 8 + MongoDB 7，全程不需要 docker 与 sudo。
- 测试：server 610 用例（609 绿 + 1 个既有离线字体用例）、website 59 文件 / 550、admin 82 套件 / 326、部署脚本 **19 文件 / 858 条断言**；文档站 `vuepress build` 通过

### ✨ Features | 新功能

- 前台文章页底部的标签链接前增加标签图标，避免被当成普通文字链接。图标跟随现有灰色文字、悬停下划线和夜间模式颜色；加密未解锁时仍不展示标签。首页列表卡片本来就不显示这行标签，行为不变。[#178](https://github.com/Mereithhh/vanblog/issues/178)
- 前台时间线（归档）在年份之下按月分组：跨月的文章落到对应「N月」分组，没有文章的月份不会出现空分组。分类页和标签页仍按原来的方式分组。[#302](https://github.com/Mereithhh/vanblog/issues/302)
- 文章增加可选题头图：后台新建 /「修改信息」可上传或填写封面 URL，前台文章页顶部显示；留空则不占版面。设置后文章页带上 `og:image` / `twitter:image`，方便分享到飞书、知乎等。导入 Markdown 时 Front Matter 的 `cover` / `image` 会预填。[#288](https://github.com/Mereithhh/vanblog/issues/288)
- 前台文章（以及同一套 ByteMD 的后台预览）围栏代码块支持汇编高亮：`asm` / `assembly` / `nasm` / `x86asm` / `intel` / `x86` 走 Intel/NASM（highlight.js `x86asm`），`arm` / `armasm` 走 ARM。原先 common 语言集不含汇编，这些围栏几乎没有关键字/寄存器/注释颜色。RSS 用的 markdown-it 也会把 `asm` 当成 `x86asm`。[#294](https://github.com/Mereithhh/vanblog/issues/294)
- 后台文章编辑器「偏好设置」增加「软换行」：默认关闭，保持标准 Markdown（单独回车仍是同一段）。开启后，按 Enter 或粘贴多行时会自动补行末两个空格，写成 CommonMark 软换行；预览和前台仍按标准渲染。设置存在当前浏览器 LocalStorage，打开或保存已有文章时不会整篇改写历史正文。[#311](https://github.com/Mereithhh/vanblog/issues/311)
- 前台首页和 `/page/n` 分页增加跳转到指定页：多页时在现有页码旁显示「跳转」输入框，回车或点「前往」按现有路由跳到 `/`（第 1 页）或 `/page/n`。只接受 1..总页数的整数，空值、非整数或超出范围不跳转。总页数跟随「每页文章数」。页码链接、当前页 `aria-current="page"` 以及第一页 / 最后一页禁用的上一页 / 下一页不变。[#229](https://github.com/Mereithhh/vanblog/issues/229)
- 后台分类管理增加「是否隐藏」：可开关隐藏状态（也可在「重命名」弹窗里改）。隐藏后前台分类列表、导航、分类页和 sitemap 不再展示该分类；后台仍可见。该分类下的文章仍按各自的隐藏 / 加密规则，不会因此被额外加密。[#359](https://github.com/Mereithhh/vanblog/issues/359)
- 后台分类管理增加「上移 / 下移」：可自定义分类显示顺序，前台导航分类子菜单、分类列表和分类页按该顺序展示。已有文章的分类也能改序，不必删除再建。隐藏分类仍只出现在后台，可见分类之间保持相对顺序。[#152](https://github.com/Mereithhh/vanblog/issues/152)
- 后台文章管理一级表格增加「是否隐藏」列，可直接开关隐藏状态，不必打开「修改信息」或编辑器。仍走现有更新文章接口。[#268](https://github.com/Mereithhh/vanblog/issues/268)
- 手机上后台文章编辑器不再只剩「编辑 / 预览」切换：窄屏（ByteMD tab 模式，编辑器宽度 < 800px）工具栏会补上一组常用按钮（标题、加粗 / 斜体、链接、图片上传、列表、代码、引用）。电脑端分栏工具栏不变，也不会把表情、Mermaid、高亮块等整排桌面按钮塞到手机上。[#504](https://github.com/Mereithhh/vanblog/issues/504)
- 后台文章编辑器工具栏增加「外链图片转存」：扫描正文里的远程 `![...](http...)` 和 `<img src>`，经现有图床上传管线下载并改写为本站 / 配置图床地址。已是本站 `/static`、已入库图床、相对路径和 `data:` 图片会跳过；失败的链接保持原样并提示。开启自动压缩时仍按 WebP / AVIF 设置处理。不会在保存时静默改写。[#434](https://github.com/Mereithhh/vanblog/issues/434)
- 后台「图床设置」在原有「图片自动压缩」旁增加压缩格式：默认仍是 WebP，可选 AVIF（通常更小）。只影响新上传，不改写历史文件。AVIF 优先用 sharp 0.32.6；官方 Alpine 镜像若加载不到 musl sharp，则使用 `libavif-apps` 的 `avifenc`。[#423](https://github.com/Mereithhh/vanblog/issues/423)
- 手机阅读文章时，有目录的文章会在「返回顶部」上方出现目录按钮，点开后从右侧滑出同一份文章目录，点标题会跳转并收起抽屉。电脑端右侧目录不变；没有标题的文章不显示该按钮。[#451](https://github.com/Mereithhh/vanblog/issues/451)
- 后台「自定义路径名」标明对应 Hugo 的 `/post/:slug`：tooltip / 占位提示从 Hugo 迁移时填旧 slug 以保留 SEO。导入 Markdown 时，Front Matter 优先读 `pathname`，再读 Hugo 的 `slug`，再读单段或 `/post/<slug>` 的 `url`，最后仍读 hexo `abbrlink`。没有全局固定链接模板，仍是按篇文章设置。[#487](https://github.com/Mereithhh/vanblog/issues/487)
- 后台从 Markdown 导入文章时，确认表单也有与新建文章相同的「自定义路径名」。Front Matter 若有 `pathname` 或 hexo-addlink 的 `abbrlink`，会预填该路径（`abbrlink: cb933e30` → `/post/cb933e30`），仍可改。[#383](https://github.com/Mereithhh/vanblog/issues/383)
- 可通过环境变量 `VAN_BLOG_SERVER_HOST`（或配置项 `server.host`）指定 Nest API 监听网卡。默认留空，与升级前一样监听所有接口；本机 Nginx / Caddy 反代时可设为 `127.0.0.1`，只接受回环连接。官方镜像内置 Caddy 仍反代 `127.0.0.1:3000`。宿主机映射的 80/443 需改编排端口绑定，见反代文档。[#488](https://github.com/Mereithhh/vanblog/issues/488)
- 前台文章（以及同一套 ByteMD 的后台预览）会渲染 Markdown 里嵌入的常见 HTML：`<u>`、`<font>`、`<center>`、带 `style` 的标签、`<iframe>` 等。`<script>`、事件属性（`onclick` / `onerror`）和 `javascript:` 链接会被消毒去掉；整站脚本仍走定制化，不在文章正文执行。[#490](https://github.com/Mereithhh/vanblog/issues/490)
- 后台「自定义页面」新建提示、帮助和文件编辑器标明：只托管静态资源、入口是根目录 `index.html`、SPA 需要相对路径；路径必须是单级（如 `/uptime` → `/c/uptime/`）。[#337](https://github.com/Mereithhh/vanblog/issues/337)
- 后台「站点配置 / 高级设置」将「Google Analysis ID」改为「Google Analytics 测量 ID」，占位与 tooltip 标明 GA4 的 `G-XXXXXXXXX`（旧版 `UA-` 也可），并提示大陆访问 Google 可能导致控制台「尚未收到数据」。前台注入 gtag 前会去掉首尾空白，若误粘贴整段脚本或 URL 则抽出 `G-` / `UA-` ID。[#350](https://github.com/Mereithhh/vanblog/issues/350)
- 后台「系统设置 / 评论设置」SMTP 表单标明博主邮箱（通知收件人）、发件地址（From）和 SMTP 授权码/应用专用密码的用途，便于换成自定义域名邮箱；仍走内嵌 Waline，不另建邮件系统。[#342](https://github.com/Mereithhh/vanblog/issues/342)
- 后台新建 / 修改 / 导入文章和草稿时，标签输入框支持一次粘贴或输入多个标签：用英文/中文逗号、分号或换行分隔。空格不会拆开，以便「machine learning」这类多词标签保持完整。[#489](https://github.com/Mereithhh/vanblog/issues/489)
- 后台「数据管理 / 社交媒体」支持自定义社交媒体：除 GitHub / 邮箱 / 微信 / Bilibili / Gitee 外，可添加 Telegram、Twitter/X 等任意链接，填写显示名称、URL，以及可选的图标 URL。内置类型仍每种一条，自定义可以有多条；已有站点的旧数据不用改。[#394](https://github.com/Mereithhh/vanblog/issues/394)
- 后台「站点配置 / 布局设置」可改友链页介绍、友链页底部 Markdown（申领要求 / 本站信息）以及关于页标题。留空仍用升级前的硬编码中文；底部可用 `{{siteName}}`、`{{description}}`、`{{url}}`、`{{logo}}`。关于页正文仍在文章管理「编辑关于」里改。[#373](https://github.com/Mereithhh/vanblog/issues/373)
- 前台分类列表把原来的 `+` 改成 `>` 箭头（展开后旋转成 V），点分类名称、篇数或箭头都能展开 / 收起。布局设置增加「分类页默认展开全部分类」（默认仍全部收起）；页上还有「全部展开 / 全部收起」。单篇分类页、标签页和时间线不受这项默认值影响。[#260](https://github.com/Mereithhh/vanblog/issues/260)
- 后台「站点配置 / 布局设置」增加「每页文章数」：前台首页和 `/page/n` 分页按该数字展示文章。默认仍是 5 篇（与升级前硬编码一致），可在 1–50 之间调整；超出范围会夹紧，避免一次拉太多文章。[#346](https://github.com/Mereithhh/vanblog/issues/346)

### 🐛 Bug Fixes | Bug 修复

- 前台搜索输入框改为 `type="search"`（移动端键盘显示「搜索」），并加上 Safari 需要的 `spellcheck` / `autocapitalize` / `autocorrect` 关闭，避免自动纠正干扰关键词。清除按钮悬停不再突然放大，改为透明度和颜色过渡，仍是带「清除搜索」名称的真正按钮。顶栏和弹层里的搜索图标描边略加粗，接近旁边的菜单/主题图标。打开弹层时仍会锁住页面滚动。不含全屏移动端弹层和自动补全。[#173](https://github.com/Mereithhh/vanblog/issues/173)
- 后台文案将「客制化」改为「定制化」、「联系方式」改为「社交媒体」，与文档用语一致。系统设置选项卡、布局设置开关/提示、定制化保存确认，以及数据管理选项卡、社交媒体表格标题和自定义条目校验文案均已同步。路由 key（`customizing` / `socials`）和字段名不变。[#197](https://github.com/Mereithhh/vanblog/issues/197)
- 后台分类管理和标签管理的改名用语统一为「重命名」（不再写「修改分类」「批量改名」）。弹窗标题、确认文案和文档同步；接口、路由和改名逻辑不变。[#194](https://github.com/Mereithhh/vanblog/issues/194)
- 前台文章页和文章列表的阅读数、评论数在数据加载完成前显示 `...`，不再先闪 `0`；加载完成后显示真实数字（包括确实为 0）。[#230](https://github.com/Mereithhh/vanblog/issues/230)
- 手机端顶栏网站名改为相对整个页面宽度居中，不再只在汉堡菜单右侧的剩余栏里居中（短站名时错位更明显）。电脑端左侧网站名 / logo 布局不变。[#262](https://github.com/Mereithhh/vanblog/issues/262)
- 前台分页在第一页时「上一页」、最后一页时「下一页」不再可点：仍显示但禁用（无链接、无悬停高亮），不能翻出范围。页码链接、当前页选中样式和「每页文章数」不变。[#331](https://github.com/Mereithhh/vanblog/issues/331)
- 加密文章密码框提示误写成「文章已解锁」，现改为「文章已加密，请输入密码后查看：」。Related to [#414](https://github.com/Mereithhh/vanblog/pull/414)
- 多文件自定义页面访问带查询参数的目录（如 `/c/uptime/?x=1`）不再把 `?x=1` 当成文件名；缺失的 `index.html` 返回 404 而不是 `sendFile` 失败。[#337](https://github.com/Mereithhh/vanblog/issues/337)
- 后台编辑很长的 Markdown 时，用右侧目录跳到靠后的标题后，顶部工具栏（加粗、标题、上传等功能键）会整行消失。现把编辑器锁在视口高度内，工具栏 sticky 在编辑区顶部，目录跳转也不再把页面/外层容器滚走。[#298](https://github.com/Mereithhh/vanblog/issues/298)
- 换域名后文章/草稿里写成绝对地址的图片（如 `https://旧域名/static/...`）不会跟着 DNS 或「网站 Url」一起改。后台「图床设置」增加旧地址 → 新地址改写，只替换以此前缀开头的链接，并统计更新篇数；相对路径和未填写的第三方图床不动。[#475](https://github.com/Mereithhh/vanblog/issues/475)
- 内置 Caddy「HTTPS 自动重定向」开启后可能仍走 HTTP：`setRedirect(true)` 原先 `POST` 追加 `listener_wrappers`（形状不对、重启会再套一层），成功日志还误写成「已关闭」。现改为 `PATCH`/`PUT` 整段替换为 `http_redirect`，写入后再读回确认；关闭则删除 wrappers（404 视为已关）。[#150](https://github.com/Mereithhh/vanblog/issues/150)
- 外层 Nginx 反代未转发 `Host` 时，Waline 评论登录 / 管理后台 OAuth 会跳到 `localhost` 或 `0.0.0.0`。官方反代示例已补上 `proxy_set_header Host $host`（以及 `X-Forwarded-For`）。[#396](https://github.com/Mereithhh/vanblog/issues/396)
- 源站对 `/admin` 和 `/api/admin/*`（含登录等后台 API）返回 `Cache-Control: private, no-store` 以及 `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control: no-store`，避免 Cloudflare「缓存全部」把后台 HTML/JSON 存进边缘。前台文章页和 `/_next/static` 不强制 no-store。仍建议页面规则绕过 `/admin*` 与 `/api/admin*`。[#140](https://github.com/Mereithhh/vanblog/issues/140)
- 前台菜单栏（自定义菜单、分类子菜单、移动端侧栏）和分页会标出当前项：匹配当前路由的菜单链接以及当前页码带可见选中样式和 `aria-current="page"`，其他项不再看起来像选中。[#448](https://github.com/Mereithhh/vanblog/issues/448)
- 登录 / 访客 IP 在 Cloudflare 等 CDN 后优先使用 `CF-Connecting-IP`（以及常见的 `True-Client-IP`），不再把边缘节点或 VPS 地址记成访客 IP；没有这些头时仍按原来的 `X-Real-IP` / `X-Forwarded-For` / 套接字地址解析，并跳过内网和回环地址。[#127](https://github.com/Mereithhh/vanblog/issues/127)
- 一键脚本下载 `docker-compose` 模板（以及更新脚本自身）时，若 `vanblog.mereith.com` 不可达，会依次回退到 GitHub raw 与 jsDelivr；全部失败才报错并以非 0 退出。[#115](https://github.com/Mereithhh/vanblog/issues/115)
- 配置了 Google Analysis ID 后，前台不再同步等待 `googletagmanager.com/gtag/js`：脚本改为 `async` 并在页面 load 后空闲时加载（`lazyOnload`）。大陆访问该域名超时（`net::ERR_CONNECTION_TIMED_OUT`）时，不再堵塞首屏和 hydration。[#375](https://github.com/Mereithhh/vanblog/issues/375)
- 后台登录过期后再登录，不再同时弹出「登录成功」和「登录失效」：成功登录会清掉未关闭的错误提示，登录页上以及刚登录成功后的过期 401 不再弹出失败 toast。[#316](https://github.com/Mereithhh/vanblog/issues/316)
- 后台文章列表（以及草稿/图片/日志等同样用 page 算 skip 的列表）在 page / pageSize 被 CDN 或代理改成 NaN、负数或溢出时，不再把负数 skip 传给 Mongo（`Skip value must be non-negative, but received: -9223372036854775808`），避免文章管理整页「内部服务错误」。[#400](https://github.com/Mereithhh/vanblog/issues/400)
- 官方 all-in-one Dockerfile 在 Alpine 上自建镜像时，`pnpm install --frozen-lockfile` 不再因 `sharp@0.31.3` 解析 musl `1.2.4_git*` 失败（`Installation error: Invalid Version: 1.2.4_git20230717`）。前台构建阶段安装 `vips-dev` / `libc6-compat` 等依赖，设置 `SHARP_IGNORE_GLOBAL_LIBVIPS=1` 走官方 musl prebuild，并把 website 的 sharp 固定为 `0.32.6`（有意更新 lockfile）。各阶段的 corepack 也改为 `pnpm@8.11.0`（与仓库 `packageManager` 一致），避免 `pnpm@latest` 拉到不兼容的 pnpm 12。[#413](https://github.com/Mereithhh/vanblog/issues/413)
- 后台编辑「Markdown 语法测试」这类含 `:::tip` 高亮块和 `<!-- more -->` 的文章时，在 more 标记和后面的 `----` / 标题之间按回车不再白屏（`C of Yh is not a function`）。预览把 more 注释换成普通节点，高亮块/代码块插件不再因缺字段抛错，viewerEffect 异常也不会拆掉编辑器。[#429](https://github.com/Mereithhh/vanblog/issues/429)
- 一键脚本「卸载」只删除安装数据与编排文件，不再 `rm -rf` 整个安装目录；脚本生成的 `vanblog-backup-*` 以及安装目录外的备份会保留，删除前会明确提示。[#408](https://github.com/Mereithhh/vanblog/issues/408)
- 一键脚本「重置 https 设置」会清除 Caddy `http_redirect` / 数据库 https 强制跳转并重启，使 HTTP 和 IP 访问恢复；成功或失败都会明确提示。Related to [#408](https://github.com/Mereithhh/vanblog/issues/408)
- 后台「操作 → 修改信息」标题等输入框无法使用退格/删除键：焦点在 input/textarea/contenteditable 时全局快捷键和菜单不再拦截 Backspace / Delete，光标与删字恢复正常。[#233](https://github.com/Mereithhh/vanblog/issues/233)
- iPhone Safari 点顶栏搜索后页面变暗但呼不出键盘：打开搜索时在同一次点击里先显示弹层再聚焦输入框，不再等到 `useEffect` / 动画结束；桌面快捷键与 Escape / Tab / 方向键行为保持不变。[#155](https://github.com/Mereithhh/vanblog/issues/155)
- 后台日志管理改为请求 `/api/admin/audit`，避免 uBlock Origin 等广告拦截列表因路径含 `log` 而拦截请求（`NetworkError when attempting to fetch resource`）；旧 `/api/admin/log` 仍可用。[#289](https://github.com/Mereithhh/vanblog/issues/289)
- 一键脚本「更新」先停并移除容器，再 `compose pull vanblog` / `up`，只删除未再被占用的旧镜像；成功文案仅在运行中的 vanblog 镜像/版本确实前进后打印，失败以非 0 退出。中国镜像 `latest` 未同步时改拉 `mereith/van-blog:latest`。[#421](https://github.com/Mereithhh/vanblog/issues/421) Related to [#404](https://github.com/Mereithhh/vanblog/issues/404)
- 前台（以及同样套了 ByteMD 的后台预览）围栏代码块重新显示行号：每行带 `code-line` / `data-line` 和 `aria-hidden` 的 gutter，浅色/深色对比可读；mermaid 围栏不加行号。覆盖 [#404](https://github.com/Mereithhh/vanblog/issues/404) 的代码块行号（更新脚本见上一项）
- 前台夜间模式（以及同样套了暗色的后台预览）里 mermaid / 流程图不再用浅色主题画在深色底上：站点为暗色时 mermaid 使用 `theme: 'dark'` 和提高对比度的 themeVariables，容器带 `mermaid-theme-dark`；白天模式仍是默认浅色主题。覆盖 [#404](https://github.com/Mereithhh/vanblog/issues/404) 的流程图对比度（更新脚本见上一项）
- 后台编辑器写入带 `style` / 十六进制颜色 / 中文标签的 mermaid 流程图后再按键，不再抛 `Yh is not a function or its return value is not iterable` 并导致无法继续编辑。预览改为加载 mermaid 的 UMD 包并解开 default/namespace 导入，避免 `khroma` 等 ESM 依赖被 webpack 绑错 [#391](https://github.com/Mereithhh/vanblog/issues/391)
- 后台编辑文章标题时左右方向键无法移动光标：全局快捷键不再拦截输入框里的方向键 [#390](https://github.com/Mereithhh/vanblog/issues/390)
- 后台删除目录改用 `fs.rmSync`，webp 压缩用 `spawnSync` 传参数数组，不再把路径拼进 shell 命令，避免命令注入 [#482](https://github.com/Mereithhh/vanblog/issues/482)
- 前台搜索弹层可用键盘操作：打开后焦点进入对话框，Escape 关闭且不再在关闭时误拦截 Escape，Tab / Shift+Tab 只在弹层内循环，清除改为真正的按钮（Enter/空格），方向键浏览结果并用 Enter 打开；只覆盖 [#175](https://github.com/Mereithhh/vanblog/issues/175) 的「Not interactive with keyboard」一项（不含跳转到第 N 页），其余无障碍项仍开放
- 前台顶栏搜索、主题、RSS、管理后台、移动端菜单和代码块复制改为真正的按钮/链接，可用键盘 Tab 聚焦并用 Enter/空格激活（RSS 仍复制订阅地址）；只覆盖 [#175](https://github.com/Mereithhh/vanblog/issues/175) 的「Inaccessible buttons with keyboard」一项（不含搜索框内键盘导航），其余无障碍项仍开放
- 前台分页支持方向键在页码控件间移动焦点，省略号不再是链接，禁用的上一页/下一页不可聚焦；只覆盖 [#175](https://github.com/Mereithhh/vanblog/issues/175) 的「Pagination issues」一项（不含跳转到第 N 页），其余无障碍项仍开放
- 前台夜间模式文章代码块部分高亮（如正则、文档注释）过暗，现提高到 WCAG AA 对比度；只覆盖 [#175](https://github.com/Mereithhh/vanblog/issues/175) 的「代码块对比度」一项，其余无障碍项仍开放
- 前台文章标题旁增加可复制的 `#` 锚点链接，地址栏 hash 对中文/空格做 encodeURIComponent，打开编码 hash 会滚到对应标题；目录项改为真正的链接，可用键盘 Tab/Enter 操作 [#177](https://github.com/Mereithhh/vanblog/issues/177)
- 前台文章目录标题里的 `$...$` / `$$...$$` 会按正文同一套 KaTeX 渲染，不再把 `$A$<$B$` 原样显示出来；点击仍按未解析的标题原文跳转 [#264](https://github.com/Mereithhh/vanblog/issues/264)
- 前台白天模式分页当前页与其他页码看起来一样（都是白底），现用更深底色和白色文字标出当前页，夜间模式仍可读 [#333](https://github.com/Mereithhh/vanblog/issues/333)
- 前台 Markdown 链接 `[文字](网址)` 文字或 URL 过长时，首页摘要和正文都会保留完整可见文字与 href，不再截断网址或把链接拆成残缺 markdown [#410](https://github.com/Mereithhh/vanblog/issues/410)
- 前台文章目录会漏掉正文里已渲染的标题（含缩进的嵌套标题），现与后台编辑器大纲对齐 [#409](https://github.com/Mereithhh/vanblog/issues/409)
- 后台文章编辑器点目录再点子标题后，编辑区不再变成只能刷新才能恢复的空白 [#370](https://github.com/Mereithhh/vanblog/issues/370)
- 访客时区与站长时区不同时，相对时间（如后台「最近访问」）不再显示成负值（例如 `-113秒前`）[#369](https://github.com/Mereithhh/vanblog/issues/369)
- 点击 Markdown 脚注（`[^1]` / `[^1]:`）会在当前页滚到对应脚注，返回链接也能回到原文，不再新开同一篇文章；前台脚注区也会显示分隔线 [#290](https://github.com/Mereithhh/vanblog/issues/290)
- 伙伴名为 URL（如 `https://testbug`）时，后台友情链接可以删除，编辑会更新原条目而不是新增 [#252](https://github.com/Mereithhh/vanblog/issues/252)
- 截图很多的长文章里，目录点击或 hash 会等上方图片撑开后再跳到标题，而不是停在未加载完的位置 [#82](https://github.com/Mereithhh/vanblog/issues/82)
- 前台选择白色后刷新不再先闪暗色；自动模式跟随系统配色，浅色系统下不再因夜间时段强制黑色 [#292](https://github.com/Mereithhh/vanblog/issues/292)
- 后台「自定义环境变量」未生效：`imageUploader: false` 未传到前台评论组件，数字 `IPQPS` 也未作为字符串环境变量传给内嵌 Waline [#139](https://github.com/Mereithhh/vanblog/issues/139)
- 站点总字数与后台编辑器使用同一口径（中文按字、英文按词，不是 UTF-8 字节），且只统计已发布文章 [#293](https://github.com/Mereithhh/vanblog/issues/293)
- 文章标题末尾或多余空格时，前台目录点击无法跳转到对应标题 [#308](https://github.com/Mereithhh/vanblog/issues/308)
- 后台分类管理重命名后，文章和草稿仍保留旧分类名 [#324](https://github.com/Mereithhh/vanblog/issues/324)
- 后台多文件自定义页面上传文件/文件夹失败，且无法删除已上传文件 [#338](https://github.com/Mereithhh/vanblog/issues/338)
- 水印文字含 `.`（如域名）时不再整段消失 [#322](https://github.com/Mereithhh/vanblog/issues/322)
- 非法或缺失的文章/草稿 ID 不再以 `NaN` 查询 MongoDB，避免打开草稿变成空文档 [#427](https://github.com/Mereithhh/vanblog/issues/427)
- 导入备份不再覆盖当前后台账号，避免新机器刚配好的登录被旧数据顶掉 [#280](https://github.com/Mereithhh/vanblog/issues/280)
- 使用外部 MongoDB（Atlas）时，内嵌 Waline 不再强制 `authSource=admin` [#493](https://github.com/Mereithhh/vanblog/issues/493)
- Docker 环境变量 `VAN_BLOG_CDN_URL` 启动时未生效，前台 `/_next/static` 仍走主站相对路径 [#450](https://github.com/Mereithhh/vanblog/issues/450)
- 开启「强制登录后评论」后匿名评论仍可提交 [#446](https://github.com/Mereithhh/vanblog/issues/446)
- 后台自定义页面「修改信息」保存后刷新仍是旧名称/路径 [#453](https://github.com/Mereithhh/vanblog/issues/453)
- 后台编辑器填写文章信息时方向键无法移动光标 [#470](https://github.com/Mereithhh/vanblog/issues/470)
- 后台 `/api/admin/meta` 不再被远程版本检查拖慢 [#343](https://github.com/Mereithhh/vanblog/issues/343)
- 后台修改文章后，数字 ID 前台地址不更新 [#356](https://github.com/Mereithhh/vanblog/issues/356)
- 备份恢复后分类未导入，导致分类管理为空、首页刷新不出文章 [#496](https://github.com/Mereithhh/vanblog/issues/496) [#280](https://github.com/Mereithhh/vanblog/issues/280)
- 后台文章编辑页即时预览遇到 mermaid 时不再抛异常，左侧可继续输入 [#424](https://github.com/Mereithhh/vanblog/issues/424)
- 文章含 mermaid 图表时后台编辑器无法输入 [#477](https://github.com/Mereithhh/vanblog/issues/477)

### ✏️ Documentation | 文档

- `docs/features/search.md`：说明搜索输入框为 `type="search"`、Safari 关闭自动纠正，以及清除按钮悬停只变颜色和透明度。[#173](https://github.com/Mereithhh/vanblog/issues/173)
- `docs/faq/usage.md`（FAQ「搜索框清除按钮动画很怪」）：说明 `type="search"`、Safari 输入属性和清除按钮动效。[#173](https://github.com/Mereithhh/vanblog/issues/173)
- 定制化 / 社交媒体：后台文案与文档对齐为「定制化」「社交媒体」（不再写「客制化」「联系方式」）。`docs/advanced/customizing.md`、`docs/faq/usage.md`、`docs/features/social.md` [#197](https://github.com/Mereithhh/vanblog/issues/197)
- 分类 / 标签：后台改名按钮、弹窗标题和确认文案统一为「重命名」（不再写「修改分类」「批量改名」）。`docs/features/tag.md`、`docs/faq/usage.md` [#194](https://github.com/Mereithhh/vanblog/issues/194)
- 文章 / 标签：说明前台文章页底部标签链接前有标签图标。[#178](https://github.com/Mereithhh/vanblog/issues/178)
- 文章 / FAQ：说明前台时间线按年再按月归档，只有有文章的月份会显示。`docs/features/article.md`、`docs/faq/usage.md` [#302](https://github.com/Mereithhh/vanblog/issues/302)
- 文章 / FAQ / SEO：说明可选题头图的设置位置、上传或填写 URL、前台展示以及 `og:image` / `twitter:image` 分享预览。导入 Front Matter 可读 `cover` / `image`。[#288](https://github.com/Mereithhh/vanblog/issues/288)
- 编辑器 / FAQ：说明汇编围栏可用的语言标签（`asm`、`nasm`、`x86asm`、`arm` 等），前台和后台预览同一套 highlight.js。[#294](https://github.com/Mereithhh/vanblog/issues/294)
- 编辑器 / FAQ：说明「软换行」偏好（默认关，开启后 Enter / 粘贴自动补两个空格），以及为什么单独回车不换行。[#311](https://github.com/Mereithhh/vanblog/issues/311)
- FAQ / 站点配置：说明前台分页可输入页码跳转，非法或超出范围不跳转；总页数跟随「每页文章数」。`docs/faq/usage.md`、`docs/features/config.md` [#229](https://github.com/Mereithhh/vanblog/issues/229)
- FAQ / 站点配置：说明手机端顶栏网站名相对整页宽度居中，电脑端左侧网站名 / logo 不变。[#262](https://github.com/Mereithhh/vanblog/issues/262)
- 分类 / FAQ / 隐藏文章：说明可在分类管理开关「是否隐藏」，前台不再展示该分类入口；文章仍按各自规则。`docs/features/tag.md`、`docs/faq/usage.md`、`docs/advanced/hide.md` [#359](https://github.com/Mereithhh/vanblog/issues/359)
- 分类 / FAQ / 站点配置：说明前台分类列表用 `>` / V 箭头展开、可点整行，以及布局设置「分类页默认展开全部分类」和页上「全部展开 / 全部收起」。`docs/features/tag.md`、`docs/faq/usage.md`、`docs/reference/config.md` [#260](https://github.com/Mereithhh/vanblog/issues/260)
- 分类 / FAQ：说明可在分类管理用「上移 / 下移」调整前台分类显示顺序，已有文章的分类也能改序。`docs/features/tag.md`、`docs/faq/usage.md`、`docs/reference/config.md` [#152](https://github.com/Mereithhh/vanblog/issues/152)
- 文章 / FAQ：说明可在文章管理一级表格直接开关「是否隐藏」。`docs/features/article.md`、`docs/faq/usage.md` [#268](https://github.com/Mereithhh/vanblog/issues/268)
- FAQ / 黑暗模式：说明前台分页在第一页 / 最后一页会禁用上一页 / 下一页（仍显示、不可跳转）。`docs/faq/usage.md`、`docs/advanced/darkmode.md` [#331](https://github.com/Mereithhh/vanblog/issues/331)
- 编辑器 / FAQ：说明手机后台编辑可用精简工具栏（标题、加粗、链接、图片、列表、代码、引用），电脑端工具栏不变。[#504](https://github.com/Mereithhh/vanblog/issues/504)
- 编辑器 / 图床 / FAQ：说明后台工具栏「外链图片转存」会把当前文章里的远程图下载到本站图床并改写链接；相对路径、本站 `/static` 和已入库地址会跳过，失败的链接保持原样。不会在保存时静默改写。[#434](https://github.com/Mereithhh/vanblog/issues/434)
- 图床 / 贡献：说明自动压缩可选 WebP 或 AVIF（只影响新上传），以及官方 Alpine 镜像上 sharp / `libavif-apps`（`avifenc`）依赖。[#423](https://github.com/Mereithhh/vanblog/issues/423)
- 编辑器 / FAQ：说明手机上可通过「返回顶部」上方的按钮打开右侧目录抽屉，电脑端目录不变。[#451](https://github.com/Mereithhh/vanblog/issues/451)
- FAQ / 文章 / 迁移 / SEO：说明如何用「自定义路径名 / slug」（`pathname`）对应 Hugo `post = "/post/:slug"`，默认是数字 id，以及导入时 Front Matter 的 `slug` / 简单 `url` 映射。没有站点级 permalink 引擎。[#487](https://github.com/Mereithhh/vanblog/issues/487)
- FAQ / 反代：后台发布后前台仍显示旧文章时，先查 Nginx / 宝塔 `proxy_cache` 或 CDN 是否在缓存 HTML；示例增加 `proxy_no_cache` / `proxy_cache_bypass`，宝塔可注释 `proxy.conf` 里的 `proxy_cache`。源站后台/API 已发 no-store，前台 HTML 仍可能被代理缓存。[#469](https://github.com/Mereithhh/vanblog/issues/469)
- 文章导入与迁移助手：Front Matter 增加 `pathname` / hexo `abbrlink` → 自定义路径名的说明。[#383](https://github.com/Mereithhh/vanblog/issues/383)
- 环境变量 / 反代 / 部署 FAQ：说明 `VAN_BLOG_SERVER_HOST=127.0.0.1` 以及 Docker 编排把 80/443 绑到 `127.0.0.1` 的用法（同机反代时避免把源站暴露到公网）。[#488](https://github.com/Mereithhh/vanblog/issues/488)
- 编辑器 / 文章 / FAQ：说明可以在 Markdown 正文里写常见 HTML，以及哪些标签会被消毒去掉。[#490](https://github.com/Mereithhh/vanblog/issues/490)
- 自定义页面文档 / FAQ：说明只托管静态 HTML/CSS/JS、`/c/<name>/` 的入口是根目录 `index.html`、SPA 需要相对 `base`/`homepage`（uptime-status 一类 zip 的 `/static/...` 会白屏），以及一键部署后如何用反代或独立容器旁挂其他站点。[#337](https://github.com/Mereithhh/vanblog/issues/337)
- FAQ / 访客统计 / 站点配置：说明 Google Analytics 测量 ID 填 `G-XXXXXXXXX`、后台路径，以及「尚未收到数据」常见原因（大陆访问 Google API、需等待或看实时）。Umami 等第三方统计通过定制化「自定义 HTML (head)」插入，不做单独集成。[#350](https://github.com/Mereithhh/vanblog/issues/350)
- FAQ / 评论：说明如何在「系统设置 / 评论设置」更换 Waline 通知邮箱、使用自定义域名邮箱（SMTP + 博主邮箱 + 发件地址）。[#342](https://github.com/Mereithhh/vanblog/issues/342)
- 文章 / 草稿 / 标签：标签输入框支持粘贴逗号、分号或换行分隔的多个标签；空格不会拆开多词标签。[#489](https://github.com/Mereithhh/vanblog/issues/489)
- 社交媒体：可在「数据管理 / 社交媒体」里添加自定义条目（显示名称 + 链接 + 可选图标），不再仅限内置的几种。[#394](https://github.com/Mereithhh/vanblog/issues/394)
- FAQ / 友情链接 / 关于 / 站点配置：布局设置可改友链页介绍与底部 Markdown、关于页标题；关于正文仍走「编辑关于」。[#373](https://github.com/Mereithhh/vanblog/issues/373)
- FAQ / 站点配置：可在布局设置里改前台「每页文章数」（默认 5，范围 1–50）。[#346](https://github.com/Mereithhh/vanblog/issues/346)
- FAQ：域名变更后如何改写文章图片链接，以及如何正确设置网站 Url / 静态访问地址。[#475](https://github.com/Mereithhh/vanblog/issues/475)
- HTTPS 文档「自动重定向」段两句粘连已拆开：初始化后到 `站点管理/系统设置/HTTPS` 确认证书，再按需开启重定向。
- FAQ / HTTPS：开启自动重定向后请用无痕窗口访问 `http://域名` 确认跳到 https；「查看 Caddy 配置」里 `srv1.listener_wrappers` 应含 `http_redirect`。[#150](https://github.com/Mereithhh/vanblog/issues/150)
- 说明本项目现由 AI 全自动维护，合并与 `v*` / `doc*` 发版仍由作者完成
- 反代 Nginx 示例补上 `Host $host`；部署 FAQ 说明未转发 Host 时 Waline 登录会跳到 localhost。[#396](https://github.com/Mereithhh/vanblog/issues/396)
- FAQ / 反代补充：Cloudflare「缓存全部」时后台与 `/api/admin/*` 可能被边缘缓存；源站现已发送 no-store，页面规则仍建议绕过 `/admin*` 与 `/api/admin*`。[#140](https://github.com/Mereithhh/vanblog/issues/140)

## [0.54.0](https://github.com/Mereithhh/vanblog/compare/v0.53.0...v0.54.0) (2023-06-27)

### 🐛 Bug Fixes | Bug 修复

- icp 备案文案错误 ([29d0e09](https://github.com/Mereithhh/vanblog/commit/29d0e09606868a4bd610f69e86f9962c8b8005cf))
- public api 文章字段过滤错误 ([fdbd26a](https://github.com/Mereithhh/vanblog/commit/fdbd26a8e1228e77cf51fa345baad5ac6432d9ac))

### ✨ Features | 新功能

- 增加一键脚本来关闭 https 重定向 ([ea41ea8](https://github.com/Mereithhh/vanblog/commit/ea41ea8535ddaaaebc5052951d34e45f6dc31d83))
- 文章或草稿支持批量导出markdown或批量删除操作 [#296](https://github.com/Mereithhh/vanblog/issues/296) ([7dec2f8](https://github.com/Mereithhh/vanblog/commit/7dec2f8f98a8c67f34ba5b8755b9e8fde08e9c21))
- 文章支持锚点定位 [#309](https://github.com/Mereithhh/vanblog/issues/309) ([0ab9fdb](https://github.com/Mereithhh/vanblog/commit/0ab9fdbf31246712a6fad07066d975eb7711de4f))
- 文章标题过长自动截断 [#291](https://github.com/Mereithhh/vanblog/issues/291) ([32df7cd](https://github.com/Mereithhh/vanblog/commit/32df7cd1153278cd8ee99fc1992310300a856dc5))
- 本地图床复制和插入markdown链接改为相对url [#303](https://github.com/Mereithhh/vanblog/issues/303) ([3290dec](https://github.com/Mereithhh/vanblog/commit/3290dece37a3f331d44ac7ec62e9bfd416c6ab59))
- 本地编辑器缓存增加时间戳校验，只有比服务器更新时才会采用本地缓存。另外默认关闭本地缓存，可在编辑器右上角偏好设置中开启 ([7010d32](https://github.com/Mereithhh/vanblog/commit/7010d3217d8aaa5288169995fadfc9801df644b3))
- 系统日志查看功能 ([872930d](https://github.com/Mereithhh/vanblog/commit/872930d75a63faa2b82e12cdadc6327723acc9e6))

### 🚀 Chore | 构建/工程依赖/工具

- 一键脚本增加中国ip检测，分流国内外下载地址 ([a352ad7](https://github.com/Mereithhh/vanblog/commit/a352ad7fd301efba467fe6cdf10de62734278056))
- 一键脚本增加备份恢复功能 ([752f467](https://github.com/Mereithhh/vanblog/commit/752f4670500a8596c81fcc770e35cb686ebefc8f))
- 优化一键脚本 ([784a414](https://github.com/Mereithhh/vanblog/commit/784a41408b909541766a2f2c880b6ed721a1665c))

### ✏️ Documentation | 文档

- 更新备份恢复文档和脚本演示图片 ([f07fc18](https://github.com/Mereithhh/vanblog/commit/f07fc189becf843a31d039658aa041a7f44cd981))
- 更新批量操作相关文档 ([760fce9](https://github.com/Mereithhh/vanblog/commit/760fce953ae721140ecc5b1ee569b146f1543a42))
- 更新文档 ([9fefb8e](https://github.com/Mereithhh/vanblog/commit/9fefb8e2fb1ac998df2f7916cb7a019b8ff7984c))
- 更新文档 ([104a93f](https://github.com/Mereithhh/vanblog/commit/104a93f84810b43628d47ffcb525e4261d750781))
- 更新文档 ([005a246](https://github.com/Mereithhh/vanblog/commit/005a2464a39cd891d58acaf16d81328b89cf6099))
- 更新样例 [#295](https://github.com/Mereithhh/vanblog/issues/295) ([3ca4b7a](https://github.com/Mereithhh/vanblog/commit/3ca4b7a79c4a6f96f39630faed674f74420809a1))
- 更新系统日志文档 ([51e21d8](https://github.com/Mereithhh/vanblog/commit/51e21d8d41a267ab47d7c6bf6827dbdd6aabe058))
- 更新谁在使用 ([8d91726](https://github.com/Mereithhh/vanblog/commit/8d91726986d1c2e4ffb0d3ce49ee7b808c062830))
- 更新谁在使用 [#307](https://github.com/Mereithhh/vanblog/issues/307) ([e085035](https://github.com/Mereithhh/vanblog/commit/e08503541d18284289cd5c399bc6e58cb2a8dc13))
- 更新谁在使用 [#315](https://github.com/Mereithhh/vanblog/issues/315) ([f52aa07](https://github.com/Mereithhh/vanblog/commit/f52aa07e12955bab30c207aa7ddd8dda4ad8b1a4))
- 更新谁在使用 [#317](https://github.com/Mereithhh/vanblog/issues/317) ([3fbca1c](https://github.com/Mereithhh/vanblog/commit/3fbca1c6ef94ef16c7ba7cd1446f8163907d8a92))
- 更新谁在使用 [#320](https://github.com/Mereithhh/vanblog/issues/320) ([fb2097b](https://github.com/Mereithhh/vanblog/commit/fb2097b4926d4bbdcd2631410041683b3ea3a979))

## [0.53.0](https://github.com/Mereithhh/vanblog/compare/v0.52.0...v0.53.0) (2023-05-05)

### 🐛 Bug Fixes | Bug 修复

- 分析面板中分类数量不准确 ([d8ebe73](https://github.com/Mereithhh/vanblog/commit/d8ebe73d32e0a849d559f0929cebf2c7f2be9a3b))

### 💄 Styles | 风格

- z-index 使用保守的数值 ([80fe17c](https://github.com/Mereithhh/vanblog/commit/80fe17c879b9f839ba54fcba06a7580e835ec865))
- 扩大pc导航栏可点击范围，优化体验 ([50ac020](https://github.com/Mereithhh/vanblog/commit/50ac0206cea8f65d7bfb0ac1f3e059406b2f2109))

### ✨ Features | 新功能

- **admin:** 管理后台文章和草稿列表页的导入按钮可以多选导入了 ([4690cbf](https://github.com/Mereithhh/vanblog/commit/4690cbfd97a488d7edab409c89bd9d017527be2b))
- gif 格式图片上传 & 修复某些情况下上传图片报错 [#285](https://github.com/Mereithhh/vanblog/issues/285) ([43f84e6](https://github.com/Mereithhh/vanblog/commit/43f84e63a48ab3b483bc58ea5c5ab75bc4cffcc8))
- markdown 内允许 script（虽然后台预览无效但前台生效） 和 iframe ([24b7e5f](https://github.com/Mereithhh/vanblog/commit/24b7e5fda5955a107183f6e9d27699881805f73c))
- 前台编辑按钮登录态判断优化 ([de45b90](https://github.com/Mereithhh/vanblog/commit/de45b9069285d91f0539a2b6bac1d55f87de9b41))
- 增加一些类名，便于进行自定义 CSS ([20d7075](https://github.com/Mereithhh/vanblog/commit/20d7075174fe4e17010e92cc1f5b4458bc996706))
- 文章卡片标题和子标题增加类名 ([b97289b](https://github.com/Mereithhh/vanblog/commit/b97289bdfd15ee574901bbae69a78252f1b148eb))
- 登录时，前台展示编辑按钮 [#234](https://github.com/Mereithhh/vanblog/issues/234) ([6af8a1b](https://github.com/Mereithhh/vanblog/commit/6af8a1be9586f2cbd3d509ee5d31a96e1553e4af))

### ✏️ Documentation | 文档

- 更新前台编辑按钮相关文档 ([bff5ded](https://github.com/Mereithhh/vanblog/commit/bff5ded1df1302c6858e9576b7a9b2115d861d60))
- 更新谁在使用 [#286](https://github.com/Mereithhh/vanblog/issues/286) ([ee58831](https://github.com/Mereithhh/vanblog/commit/ee58831f65ef311fceb5df94ca154472e4fb9cdf))

## [0.52.0](https://github.com/Mereithhh/vanblog/compare/v0.51.1...v0.52.0) (2023-04-14)

### 🚀 Chore | 构建/工程依赖/工具

- pnpm lock version ([85c5412](https://github.com/Mereithhh/vanblog/commit/85c54125931a139127c4e251dff83e4445ef1374))

### 🐛 Bug Fixes | Bug 修复

- https 自动跳转失效 [#273](https://github.com/Mereithhh/vanblog/issues/273) ([8b6f416](https://github.com/Mereithhh/vanblog/commit/8b6f41615fba22e45a0954c770296b489734c2e7))
- 当前浏览器不计入统计的 bug [#261](https://github.com/Mereithhh/vanblog/issues/261) ([d153465](https://github.com/Mereithhh/vanblog/commit/d153465d4a96c65d4ec6408dced69b7d88c82b2e))

### ✨ Features | 新功能

- 上传图片时自动压缩（webp） [#276](https://github.com/Mereithhh/vanblog/issues/276) ([cd88c08](https://github.com/Mereithhh/vanblog/commit/cd88c0871eb28a402d08d8f66b1faebad6f8ff27))

### 💄 Styles | 风格

- 微调 UI ([98de0f7](https://github.com/Mereithhh/vanblog/commit/98de0f7b6844ee1ddf4e87ccbb00c458d6cdf5d8))

### ✏️ Documentation | 文档

- site verify ([4dcf8b0](https://github.com/Mereithhh/vanblog/commit/4dcf8b0ce7bc7f5aaec27ee1905f181ed1a189bc))
- update ([2dd8b6b](https://github.com/Mereithhh/vanblog/commit/2dd8b6ba52a396d3cc04a8d4a6c7cfef80bf9c6e))
- 图片自动压缩文档和文案 ([82fad8c](https://github.com/Mereithhh/vanblog/commit/82fad8c690067af2eebcb739863e16c2fc9cfb37))
- 增加QQ邮件消息配置参数说明 ([#278](https://github.com/Mereithhh/vanblog/issues/278)) ([4896a50](https://github.com/Mereithhh/vanblog/commit/4896a5048bf7ea3dbc9ffd85d53624a5f6189b57))
- 增加案例 ([a55b8f5](https://github.com/Mereithhh/vanblog/commit/a55b8f5e7fe946bafa031b9a14e4215c02c9167e))
- 文档样式修改 ([1ad0946](https://github.com/Mereithhh/vanblog/commit/1ad0946f12ba941803f8e3a0613435de94273351))
- 更新使用样例 ([caab272](https://github.com/Mereithhh/vanblog/commit/caab2729c2a27130ff8a2d63bf44e293281c209f))
- 更新描述 [#227](https://github.com/Mereithhh/vanblog/issues/227) ([354676b](https://github.com/Mereithhh/vanblog/commit/354676b8ffd94b93a02ce496106d2d36b2603e4f))
- 更新文档 ([fab6e5a](https://github.com/Mereithhh/vanblog/commit/fab6e5a7d772bfd25820b6ceba30690604e5eab9))
- 更新文档 ([3550a06](https://github.com/Mereithhh/vanblog/commit/3550a06724b6f8830fd1bf5f22bed56d06fa5924))
- 更新文档 ([d9432a1](https://github.com/Mereithhh/vanblog/commit/d9432a1afbac05f6187e5d1f8d5311bc25c49fff))
- 更新文档 ([e0baffb](https://github.com/Mereithhh/vanblog/commit/e0baffbaca1686b7720d650dee3a2b386c8ce520))
- 更新文档 ([86b8e90](https://github.com/Mereithhh/vanblog/commit/86b8e90ec549d8413d6aa87d6800aa9de45f2204))
- 更新谁在使用 [#267](https://github.com/Mereithhh/vanblog/issues/267) ([79d48b7](https://github.com/Mereithhh/vanblog/commit/79d48b74014ec3a00ced698f0d87d8303e88191f))
- 添加样例 [#279](https://github.com/Mereithhh/vanblog/issues/279) ([46787bd](https://github.com/Mereithhh/vanblog/commit/46787bd8869e7717e162b2709c5ff0db7c82d11d))

### [0.51.1](https://github.com/Mereithhh/vanblog/compare/v0.51.0...v0.51.1) (2023-03-27)

### ✏️ Documentation | 文档

- 更新宝塔部署文档，增加缓存配置提醒 ([ed2bc8b](https://github.com/Mereithhh/vanblog/commit/ed2bc8b0750e6475e5ea4f4af1db5af4e0d5e66c))
- 更新文档 ([3fa4c7e](https://github.com/Mereithhh/vanblog/commit/3fa4c7efebbd990312109a77ce22f1346ce3297a))
- 更新文档 ([b30454b](https://github.com/Mereithhh/vanblog/commit/b30454baa9a40588337b5e386540481e0c8d0f66))
- 更新直接部署文档 ([fff1f34](https://github.com/Mereithhh/vanblog/commit/fff1f3413a98c9c215251208512b09961c921094))
- 替换文档内有水印的图片 ([9beb31c](https://github.com/Mereithhh/vanblog/commit/9beb31c460fe09aa42e2705ce64a2d226c204e55))

### 🐛 Bug Fixes | Bug 修复

- **admin:** 后台为配置百度和谷歌统计跳转到对应配置项的地址错误 ([51211a8](https://github.com/Mereithhh/vanblog/commit/51211a8ca72a48adfab47aba36d15e965f848dc5))
- 图片放大失效、作者头像取消旋转效果、图片加载失败时增加一个原有src属性的展示属性 ([b6aad90](https://github.com/Mereithhh/vanblog/commit/b6aad901233e3f7c152e86e7411e43095ff2037d))

### 🚀 Chore | 构建/工程依赖/工具

- **docs:** 部署成功后自动刷新 CDN ([74f56dc](https://github.com/Mereithhh/vanblog/commit/74f56dc9b1acdd3e7a231c43d686a768954b45b3))
- **website:** 前台构建类型错误 ([3dfa57a](https://github.com/Mereithhh/vanblog/commit/3dfa57affb027082a21c3941de74c0f7b615ea54))
- 一键脚本更新前自动删除老镜像 ([402d451](https://github.com/Mereithhh/vanblog/commit/402d451748fdaf3066f684edc622b82a37480223))
- 测试tag自动打包部署到测试环境 ([ebe1c14](https://github.com/Mereithhh/vanblog/commit/ebe1c14f73b5a1ead609895f934a299a00aa35f6))
- 测试流水线部署失败 ([3847fd5](https://github.com/Mereithhh/vanblog/commit/3847fd5d997224025cb958f4348d1f87dd5bea8f))

## [0.51.0](https://github.com/Mereithhh/vanblog/compare/v0.50.0...v0.51.0) (2023-03-22)

### 🚀 Chore | 构建/工程依赖/工具

- update pnpm lock ([3a15f32](https://github.com/Mereithhh/vanblog/commit/3a15f3247a23527aaad899116789492e8504111a))

### ✏️ Documentation | 文档

- 更新文档 ([7b31b0f](https://github.com/Mereithhh/vanblog/commit/7b31b0f983a8698f3504030da4c305a8953d3839))
- 更新文档 ([cb163d4](https://github.com/Mereithhh/vanblog/commit/cb163d47467c0995a913a6feeced0a72864f7149))

### 💄 Styles | 风格

- markdown 代码块单行代码时会跑偏 ([f583898](https://github.com/Mereithhh/vanblog/commit/f583898ad992f48a4c7b23ddfc3a28e8ddbf07a5))

### ✨ Features | 新功能

- markdown 内写html标签时，允许使用 style 属性（之前不行），允许 center 标签 ([688172b](https://github.com/Mereithhh/vanblog/commit/688172b6e70aaae5e233315290a5ed5c3badbda0))
- markdown 图片语法中支持 dataURL 格式 ([971de9a](https://github.com/Mereithhh/vanblog/commit/971de9a50fcda344529671ffc6e487eb9a3d46d3))
- 后台编辑器增加保存快捷键提示 ([70a6895](https://github.com/Mereithhh/vanblog/commit/70a6895bb436a65e662e09c9b0faaa86df551664))

### 🐛 Bug Fixes | Bug 修复

- 搜索 API 报错 [#174](https://github.com/Mereithhh/vanblog/issues/174) ([d58aeb8](https://github.com/Mereithhh/vanblog/commit/d58aeb88a8bea92047699ee2229026a6b92bc8c0))
- 流水线页面是否异步标签展示不准确 ([dec024b](https://github.com/Mereithhh/vanblog/commit/dec024b26ff82367bca1fa9403567f5960677e20))
- 点击站点logo或打赏图片不会触发全屏预览 [#172](https://github.com/Mereithhh/vanblog/issues/172) ([ce90009](https://github.com/Mereithhh/vanblog/commit/ce90009c62b61774acd90006ae505be6a3a56d3b))

## [0.50.0](https://github.com/Mereithhh/vanblog/compare/v0.49.0...v0.50.0) (2023-03-21)

### ✏️ Documentation | 文档

- 更新文档 ([8392dc3](https://github.com/Mereithhh/vanblog/commit/8392dc3cc5cababd7e5ac8c70a850d23551229b8))

### ✨ Features | 新功能

- 前后台统一Markdown组件，展示效果完全一致；解决了主题重影问题 [#136](https://github.com/Mereithhh/vanblog/issues/136) ([4c09630](https://github.com/Mereithhh/vanblog/commit/4c09630461939503ba00ef204b2632304825e9bf))

### 💄 Styles | 风格

- 前台目录增加最大高度 ([e6e05ea](https://github.com/Mereithhh/vanblog/commit/e6e05ea06c513c409fafad87532cca4f73bbf587))

### 🐛 Bug Fixes | Bug 修复

- **admin:** 代码编辑器中流水线帮助文档打不开 ([5d0a7fb](https://github.com/Mereithhh/vanblog/commit/5d0a7fb866230f2d03be5ff2c082e585a33647c6))
- 开始加载时导航栏右上角样式闪动 [#188](https://github.com/Mereithhh/vanblog/issues/188) ([7d5a82c](https://github.com/Mereithhh/vanblog/commit/7d5a82cb463e26ff49badded9ec444b187ece236))

## [0.49.0](https://github.com/Mereithhh/vanblog/compare/v0.48.4...v0.49.0) (2023-03-17)

### ✨ Features | 新功能

- API Token 管理功能 ([e1adcf1](https://github.com/Mereithhh/vanblog/commit/e1adcf1c2fcb90dbd24ccff50a671123fed40d98))
- jwt 密钥持久化存数据库 ([6440732](https://github.com/Mereithhh/vanblog/commit/644073205445821879ccbcefdddd7cdf50606917))
- 更新 API 文档 ([4444d54](https://github.com/Mereithhh/vanblog/commit/4444d541cd52403d787501ca0f2481139760c738))
- 流水线功能,可在特定事件发生后执行自定义的任意js代码 ([63263fa](https://github.com/Mereithhh/vanblog/commit/63263fa24fbe4e03e251d883051a72d320cba886))

### 🚀 Chore | 构建/工程依赖/工具

- **server:** 单独开发模式时，不触发 isr ([757abba](https://github.com/Mereithhh/vanblog/commit/757abbafb6c794ac08ef1642c0d04f27b582510e))
- 构建报错 ([27434d1](https://github.com/Mereithhh/vanblog/commit/27434d1cc6ddfc7647c5ddf5c98fa2945126913d))

### ✏️ Documentation | 文档

- 更新API token相关文档 ([0d8d04d](https://github.com/Mereithhh/vanblog/commit/0d8d04d9a875b5fd5f8acac153b235dc087043a5))
- 更新文档 ([5ebf893](https://github.com/Mereithhh/vanblog/commit/5ebf8931a9acde32716b94a87b6e855b40020f53))
- 更新文档todo ([810bfac](https://github.com/Mereithhh/vanblog/commit/810bfac6e784ff5b4ec58943291308c32279277d))
- 更新流水线相关文档 ([287e9b1](https://github.com/Mereithhh/vanblog/commit/287e9b1be0e655cb3fedd7fa36195bb2c9de888d))
- 更新谁在使用 [#255](https://github.com/Mereithhh/vanblog/issues/255) ([ff2fa61](https://github.com/Mereithhh/vanblog/commit/ff2fa619b74707c741567a6003e0ae0c7def0338))

### [0.48.4](https://github.com/Mereithhh/vanblog/compare/v0.48.3...v0.48.4) (2023-03-14)

### ✏️ Documentation | 文档

- 更新文档 ([3623f68](https://github.com/Mereithhh/vanblog/commit/3623f683014b605a3ac4acbb56bdbcbcbd61316b))
- 更新文档 ([6911c48](https://github.com/Mereithhh/vanblog/commit/6911c484c5391aa2a55e17550feea7e8b17c63d5))
- 更新案例 [#232](https://github.com/Mereithhh/vanblog/issues/232) ([cf01aa7](https://github.com/Mereithhh/vanblog/commit/cf01aa7e013c0e0893c2998699b5b5cafb4105b5))
- 补充访客统计文档 ([fa29dd9](https://github.com/Mereithhh/vanblog/commit/fa29dd9ad7e28cf1ce1818390316b9bc05657808))

### 🐛 Bug Fixes | Bug 修复

- 前台不展示自定义高亮块 ([dae79f9](https://github.com/Mereithhh/vanblog/commit/dae79f95d7cfdd05049708c34b73af14006eb17e))

### 🚀 Chore | 构建/工程依赖/工具

- 更新依赖 ([76a5c45](https://github.com/Mereithhh/vanblog/commit/76a5c45babe30666d6d153c4d057bb5c11390f7e))

### [0.48.3](https://github.com/Mereithhh/vanblog/compare/v0.48.1...v0.48.3) (2023-03-13)

### ♻️ Code Refactoring | 代码重构

- **admin:** refine CustomPageModal ([#243](https://github.com/Mereithhh/vanblog/issues/243)) ([ed2689f](https://github.com/Mereithhh/vanblog/commit/ed2689f0712c2c343e6ff52e1835b5f63d4efb8c))

### 🐛 Bug Fixes | Bug 修复

- **admin:** style error ([679d50d](https://github.com/Mereithhh/vanblog/commit/679d50d248687e03682bd58093dcca6fa69b1ab9))
- **website:** 作者头像无法显示 ([29eb22e](https://github.com/Mereithhh/vanblog/commit/29eb22e13677ed418d56e34bae25bb9ab704065c))
- 修复auto、dark模式下在刷新后，code模块未同步的情况 ([#227](https://github.com/Mereithhh/vanblog/issues/227)) ([c615d81](https://github.com/Mereithhh/vanblog/commit/c615d819bbbda2147683fc990612673775a43a6a))
- 自定义高亮块不展示 ([82c1ceb](https://github.com/Mereithhh/vanblog/commit/82c1ceb38a8fdbc47a49f2dbe9e6fcaa8dfa02e0))

### ✏️ Documentation | 文档

- **docs:** update workflow ([2aa9c81](https://github.com/Mereithhh/vanblog/commit/2aa9c81a7096a8fae2ca303eb0730a3ae7e988a3))
- fix changelog ([#224](https://github.com/Mereithhh/vanblog/issues/224)) ([afa684d](https://github.com/Mereithhh/vanblog/commit/afa684dd4f95c2140346a97684627d253d81ce3d))
- 更新文档 ([cad2fc6](https://github.com/Mereithhh/vanblog/commit/cad2fc6bf13cca66eda2a549eab1bd8488570dd2))
- 更新文档 ([b12d3c6](https://github.com/Mereithhh/vanblog/commit/b12d3c666f950cfc0cdd77a55d1b7a994854b5d9))
- 更新文档 ([b49f040](https://github.com/Mereithhh/vanblog/commit/b49f0408def53c1afdcda42c99ce22f03432cc62))
- 更新文档 ([79cee57](https://github.com/Mereithhh/vanblog/commit/79cee57a93699afee0b508aed622b12a315975e8))
- 更新谁在使用 [#246](https://github.com/Mereithhh/vanblog/issues/246) ([b413dfe](https://github.com/Mereithhh/vanblog/commit/b413dfe4e37b520af37be32100ab7bafeefd420a))

### 🚀 Chore | 构建/工程依赖/工具

- add clean script and pnpm workspace yaml ([7ce9293](https://github.com/Mereithhh/vanblog/commit/7ce929379239474cdf30099649db9a2433ab4d3e))
- **admin:** refine ArticleList ([#235](https://github.com/Mereithhh/vanblog/issues/235)) ([f26ed55](https://github.com/Mereithhh/vanblog/commit/f26ed55b280a4731ae568fb0d73d3c35da28ef39))
- **admin:** refine AuthorField ([#239](https://github.com/Mereithhh/vanblog/issues/239)) ([6c480d8](https://github.com/Mereithhh/vanblog/commit/6c480d8dcf7111f0bd592a84695bc378a42a14fe))
- **admin:** refine CodeEditor ([#240](https://github.com/Mereithhh/vanblog/issues/240)) ([eac9a8d](https://github.com/Mereithhh/vanblog/commit/eac9a8d29a63a513da89be59fd04a69dfb6f2fa5))
- **admin:** refine collaborator-modal ([#237](https://github.com/Mereithhh/vanblog/issues/237)) ([ecb5259](https://github.com/Mereithhh/vanblog/commit/ecb5259bf21644dfd92093b4c659235f4753236a))
- **admin:** refine ColumnsToolBar ([#241](https://github.com/Mereithhh/vanblog/issues/241)) ([e97768c](https://github.com/Mereithhh/vanblog/commit/e97768c638c1c338e871b19ceee2e43a0345cbb3))
- **admin:** refine CopyUploadBtn ([#242](https://github.com/Mereithhh/vanblog/issues/242)) ([72e4ef3](https://github.com/Mereithhh/vanblog/commit/72e4ef37c79874190da22dfc16764f249568b8cf))
- **admin:** refine custom-container plugin ([#244](https://github.com/Mereithhh/vanblog/issues/244)) ([982a41b](https://github.com/Mereithhh/vanblog/commit/982a41b230d5f4b6bba24ab89d7131797a8dabfc))
- **admin:** update emoji plugin ([#245](https://github.com/Mereithhh/vanblog/issues/245)) ([ec38f5b](https://github.com/Mereithhh/vanblog/commit/ec38f5b3f5a18846b72ee51b2ddc293472a57599))
- **release:** 0.48.2 ([dfafd04](https://github.com/Mereithhh/vanblog/commit/dfafd04e9089f6fc22a88b8208a584a2a5e06115))
- **release:** 0.48.3 ([06a8c2c](https://github.com/Mereithhh/vanblog/commit/06a8c2c174f4a99aa8e3526dc14b4aafcdc923d2))
- **release:** 0.48.3 ([dbf501e](https://github.com/Mereithhh/vanblog/commit/dbf501e8b7397abb3168a0fa07efe68e43ce5c4e))
- transform to pnpm workspace, refine tsconfig, update dev docs [#179](https://github.com/Mereithhh/vanblog/issues/179) [#199](https://github.com/Mereithhh/vanblog/issues/199) ([8cf6cba](https://github.com/Mereithhh/vanblog/commit/8cf6cba33517bf1b089a493539795db2ef53fd61))
- update workflow ([4740457](https://github.com/Mereithhh/vanblog/commit/474045792d0acfa42d043d054b3dba64d4c2cf67))
- update workflow , increase timeout ([f809852](https://github.com/Mereithhh/vanblog/commit/f809852e64ec498d32c9c81131b1b3beada7b80b))
- 迁移到 pnpm + monorepo, tsconfig 结构优化 ([3be68d0](https://github.com/Mereithhh/vanblog/commit/3be68d0b66ad34a0e49033a175a32e8092341da8))

### ⏪ Revert | 回退

- workflow error ([70ab21b](https://github.com/Mereithhh/vanblog/commit/70ab21b67489fbc0d327d06ff644f13c958d374d))
- workflow timeout error ([6cf6aa6](https://github.com/Mereithhh/vanblog/commit/6cf6aa6b051dfc1d802b1f87e9c49ad19318b22c))

### [0.48.2](https://github.com/Mereithhh/vanblog/compare/v0.48.1...v0.48.2) (2023-03-11)

### ♻️ Code Refactoring | 代码重构

- **admin:** refine CustomPageModal ([#243](https://github.com/Mereithhh/vanblog/issues/243)) ([ed2689f](https://github.com/Mereithhh/vanblog/commit/ed2689f0712c2c343e6ff52e1835b5f63d4efb8c))

### 🚀 Chore | 构建/工程依赖/工具

- add clean script and pnpm workspace yaml ([7ce9293](https://github.com/Mereithhh/vanblog/commit/7ce929379239474cdf30099649db9a2433ab4d3e))
- **admin:** refine ArticleList ([#235](https://github.com/Mereithhh/vanblog/issues/235)) ([f26ed55](https://github.com/Mereithhh/vanblog/commit/f26ed55b280a4731ae568fb0d73d3c35da28ef39))
- **admin:** refine AuthorField ([#239](https://github.com/Mereithhh/vanblog/issues/239)) ([6c480d8](https://github.com/Mereithhh/vanblog/commit/6c480d8dcf7111f0bd592a84695bc378a42a14fe))
- **admin:** refine CodeEditor ([#240](https://github.com/Mereithhh/vanblog/issues/240)) ([eac9a8d](https://github.com/Mereithhh/vanblog/commit/eac9a8d29a63a513da89be59fd04a69dfb6f2fa5))
- **admin:** refine collaborator-modal ([#237](https://github.com/Mereithhh/vanblog/issues/237)) ([ecb5259](https://github.com/Mereithhh/vanblog/commit/ecb5259bf21644dfd92093b4c659235f4753236a))
- **admin:** refine ColumnsToolBar ([#241](https://github.com/Mereithhh/vanblog/issues/241)) ([e97768c](https://github.com/Mereithhh/vanblog/commit/e97768c638c1c338e871b19ceee2e43a0345cbb3))
- **admin:** refine CopyUploadBtn ([#242](https://github.com/Mereithhh/vanblog/issues/242)) ([72e4ef3](https://github.com/Mereithhh/vanblog/commit/72e4ef37c79874190da22dfc16764f249568b8cf))
- **admin:** refine custom-container plugin ([#244](https://github.com/Mereithhh/vanblog/issues/244)) ([982a41b](https://github.com/Mereithhh/vanblog/commit/982a41b230d5f4b6bba24ab89d7131797a8dabfc))
- **admin:** update emoji plugin ([#245](https://github.com/Mereithhh/vanblog/issues/245)) ([ec38f5b](https://github.com/Mereithhh/vanblog/commit/ec38f5b3f5a18846b72ee51b2ddc293472a57599))
- transform to pnpm workspace, refine tsconfig, update dev docs [#179](https://github.com/Mereithhh/vanblog/issues/179) [#199](https://github.com/Mereithhh/vanblog/issues/199) ([8cf6cba](https://github.com/Mereithhh/vanblog/commit/8cf6cba33517bf1b089a493539795db2ef53fd61))
- 迁移到 pnpm + monorepo, tsconfig 结构优化 ([3be68d0](https://github.com/Mereithhh/vanblog/commit/3be68d0b66ad34a0e49033a175a32e8092341da8))

### 🐛 Bug Fixes | Bug 修复

- **admin:** style error ([679d50d](https://github.com/Mereithhh/vanblog/commit/679d50d248687e03682bd58093dcca6fa69b1ab9))
- 修复auto、dark模式下在刷新后，code模块未同步的情况 ([#227](https://github.com/Mereithhh/vanblog/issues/227)) ([c615d81](https://github.com/Mereithhh/vanblog/commit/c615d819bbbda2147683fc990612673775a43a6a))

### ✏️ Documentation | 文档

- **docs:** update workflow ([2aa9c81](https://github.com/Mereithhh/vanblog/commit/2aa9c81a7096a8fae2ca303eb0730a3ae7e988a3))
- fix changelog ([#224](https://github.com/Mereithhh/vanblog/issues/224)) ([afa684d](https://github.com/Mereithhh/vanblog/commit/afa684dd4f95c2140346a97684627d253d81ce3d))
- 更新文档 ([79cee57](https://github.com/Mereithhh/vanblog/commit/79cee57a93699afee0b508aed622b12a315975e8))
- 更新谁在使用 [#246](https://github.com/Mereithhh/vanblog/issues/246) ([b413dfe](https://github.com/Mereithhh/vanblog/commit/b413dfe4e37b520af37be32100ab7bafeefd420a))

### [0.48.1](https://github.com/Mereithhh/van-blog/compare/v0.48.0...v0.48.1) (2023-03-06)

### ✏️ Documentation | 文档

- bump deps ([c242819](https://github.com/Mereithhh/van-blog/commit/c242819ed18a8577995cd3f047e6a6fc505f7082))
- capitalize Markdown ([90b5457](https://github.com/Mereithhh/van-blog/commit/90b545775263b227146a1368d828959d817a3d53))
- fix footer copyright on homepage ([f5f2658](https://github.com/Mereithhh/van-blog/commit/f5f2658f92288c6fb753cb8569306f6165d6ed72))
- fix intro typos and docs improvement ([9b9578d](https://github.com/Mereithhh/van-blog/commit/9b9578df06223917c15de65a17eca60b3a5b1909))
- fix typo ([#195](https://github.com/Mereithhh/van-blog/issues/195)) ([008e4e5](https://github.com/Mereithhh/van-blog/commit/008e4e50f3975666947d9ca6de4a90018b16d074))
- rebuild ([#191](https://github.com/Mereithhh/van-blog/issues/191)) ([896253a](https://github.com/Mereithhh/van-blog/commit/896253a7f8fcb33032dc10e6ef0305ed1994799f))
- rebuild ([#196](https://github.com/Mereithhh/van-blog/issues/196)) ([6fcc40b](https://github.com/Mereithhh/van-blog/commit/6fcc40b2e68020c5277d584f675cecd54940947e))
- rebuild docker and http ([cf3c667](https://github.com/Mereithhh/van-blog/commit/cf3c66778643115c44bfa35095ffd6337603beb5))
- update docs ([#192](https://github.com/Mereithhh/van-blog/issues/192)) ([a4446be](https://github.com/Mereithhh/van-blog/commit/a4446be0da0e28437c851793e8eefb0307eb9a44))
- update guide and fix typos ([3f34bbe](https://github.com/Mereithhh/van-blog/commit/3f34bbeb03a6d52fd2ea9f3c97f27e963e98e70d))
- update readme, close [#213](https://github.com/Mereithhh/van-blog/issues/213) ([87ffcb7](https://github.com/Mereithhh/van-blog/commit/87ffcb75db2fc40cb68299c478aef72f96ab754e))
- update reference ([c24503b](https://github.com/Mereithhh/van-blog/commit/c24503ba9262bb4b8ab6e59413d0f73b76d27885))
- update some of the advance files ([75e585f](https://github.com/Mereithhh/van-blog/commit/75e585f6be97ec0a7b0d77246cdab6148b284db5))
- update who use ([c8d677b](https://github.com/Mereithhh/van-blog/commit/c8d677b5cb031e93f27f7f8d035315f073c35675))
- 更新文档 ([b1b9cb4](https://github.com/Mereithhh/van-blog/commit/b1b9cb46699dc20627d4d074f26aae1050ce8a55))
- 更新文档 ([1e0ac79](https://github.com/Mereithhh/van-blog/commit/1e0ac796482695f1429d3cd73c27c6055ed87e3d))
- 更新文档 ([8922137](https://github.com/Mereithhh/van-blog/commit/89221379de7464913c4298a919e33d9307db556c))

### 🚀 Chore | 构建/工程依赖/工具

- **server:** remove unused import ([#205](https://github.com/Mereithhh/van-blog/issues/205)) ([18ee51e](https://github.com/Mereithhh/van-blog/commit/18ee51e17e20facb047a3110a51d5a7018450dc3))
- **website:** refine AlertCard ([#216](https://github.com/Mereithhh/van-blog/issues/216)) ([65f99ae](https://github.com/Mereithhh/van-blog/commit/65f99ae648dc613ffbb263a78165ea92ac3158d3))
- **website:** refine ArticleList ([#217](https://github.com/Mereithhh/van-blog/issues/217)) ([cfc8a3f](https://github.com/Mereithhh/van-blog/commit/cfc8a3ffb52e458c2d09df29c8f1cf0f3fe73a53))
- **website:** refine BackToTop ([#219](https://github.com/Mereithhh/van-blog/issues/219)) ([bf171b7](https://github.com/Mereithhh/van-blog/commit/bf171b7042e8c52e8919c7227a664333e3728f15))
- **website:** refine CustomLayout ([#221](https://github.com/Mereithhh/van-blog/issues/221)) ([8d0ea62](https://github.com/Mereithhh/van-blog/commit/8d0ea62fe67a15186ebacc5c3c409fa72b307504))
- **website:** refine Footer ([#222](https://github.com/Mereithhh/van-blog/issues/222)) ([7f9ba2b](https://github.com/Mereithhh/van-blog/commit/7f9ba2bafa4e999a39da12b5b055e8ada1982613))
- **website:** refine unused apiroute [#210](https://github.com/Mereithhh/van-blog/issues/210) ([1a250cc](https://github.com/Mereithhh/van-blog/commit/1a250cc167ec63b7198631a2c578f6e3b8315093))
- **website:** tweaks ([#201](https://github.com/Mereithhh/van-blog/issues/201)) ([c6ba12e](https://github.com/Mereithhh/van-blog/commit/c6ba12e718846e009d4e94cd0558ba619782c7d8))
- **website:** tweaks ([#206](https://github.com/Mereithhh/van-blog/issues/206)) ([79ce1f9](https://github.com/Mereithhh/van-blog/commit/79ce1f9d4586d15bc8bd145749703425ef5a6d03))
- **website:** tweaks pageview ([#212](https://github.com/Mereithhh/van-blog/issues/212)) ([22efeb8](https://github.com/Mereithhh/van-blog/commit/22efeb8115a380b4b9aaa0a0c67506e73d3d9e1f))

### 🐛 Bug Fixes | Bug 修复

- type error ([2bd7f86](https://github.com/Mereithhh/van-blog/commit/2bd7f86eee6697b3046a5c57352c6f86eb56796b))
- 修复dark模式刷新页面后，Code代码阴影问题 ([#226](https://github.com/Mereithhh/van-blog/issues/226)) ([b4774e5](https://github.com/Mereithhh/van-blog/commit/b4774e51af61a4920851bf60ba67bbb5278903f2))

## [0.48.0](https://github.com/Mereithhh/van-blog/compare/v0.47.0...v0.48.0) (2023-02-27)

### ✨ Features | 新功能

- 图片增加水印功能 [#163](https://github.com/Mereithhh/van-blog/issues/163) ([8d6e8f3](https://github.com/Mereithhh/van-blog/commit/8d6e8f3eedf4b0e7c1879361bf5192bb2ef384a9))

### ✏️ Documentation | 文档

- 增加关于水印功能的文档 ([2fb2da4](https://github.com/Mereithhh/van-blog/commit/2fb2da44fa1cdfae56cd2995153e41e8396d61bc))
- 增加备份与迁移文档说明 ([37fcfb9](https://github.com/Mereithhh/van-blog/commit/37fcfb92d98649f1d3abe41e556d4b1c8e95239d))
- 增加自定义路径相关的文档 ([788bf86](https://github.com/Mereithhh/van-blog/commit/788bf86bd63678b2d52010c1e0f91b184d03d016))
- 更新文档 ([5bc5ebf](https://github.com/Mereithhh/van-blog/commit/5bc5ebf7ee6a85c38437f73dcbcf3d5d46194ae9))

### 🐛 Bug Fixes | Bug 修复

- 图片管理中剪切板上传图片失效&水印距离下面位置调高一点 ([646884d](https://github.com/Mereithhh/van-blog/commit/646884d624169077d1f431f932f08408ab98f11a))

## [0.47.0](https://github.com/Mereithhh/vanblog/compare/v0.46.0...v0.47.0) (2023-02-26)

### ✨ Features | 新功能

- use search-pro plugin ([d5a2ab4](https://github.com/Mereithhh/vanblog/commit/d5a2ab455146d7592dfd6a7f0b4cd0f4d3984a26))
- 自定义文章路径 [#159](https://github.com/Mereithhh/vanblog/issues/159) ([14394b5](https://github.com/Mereithhh/vanblog/commit/14394b596d1933069b02dced14d757b3ad1825d8))

### 🚀 Chore | 构建/工程依赖/工具

- fix typos ([88a30b6](https://github.com/Mereithhh/vanblog/commit/88a30b6effbcbaf6f4f4dc774fc7bc0b4a092722))
- update lockfile ([c74e339](https://github.com/Mereithhh/vanblog/commit/c74e3393b6490396bab3042b64a6dc91148727d2))

### ✏️ Documentation | 文档

- tweaks ([30c5758](https://github.com/Mereithhh/vanblog/commit/30c5758831663eb7d9f8ed81644e86204d46ac46))
- update docs ([8bae067](https://github.com/Mereithhh/vanblog/commit/8bae0677981ceee6c620071f1ceb6e9be983cef2))
- 增加关于接口鉴权的描述文字 ([8eda958](https://github.com/Mereithhh/vanblog/commit/8eda9587685c7ff7138311e909858c255c2589e8))
- 更新文档 ([900890f](https://github.com/Mereithhh/vanblog/commit/900890f5c86a24cdefc7970b951fa1b8beb1ff7c))
- 更新文档 ([b728912](https://github.com/Mereithhh/vanblog/commit/b728912a9255070a5d057275f5edb4c66f4c9bb2))
- 更新谁在使用' ([900ca4c](https://github.com/Mereithhh/vanblog/commit/900ca4c481517dda9cd54bd27c22ef806391b3a2))

## [0.46.0](https://github.com/Mereithhh/vanblog/compare/v0.45.6...v0.46.0) (2023-02-25)

### 🐛 Bug Fixes | Bug 修复

- 左右切换页面时，内容不更新[#161](https://github.com/Mereithhh/vanblog/issues/161) ([94acb32](https://github.com/Mereithhh/vanblog/commit/94acb322f967f04fd6ca7d0473ed5095b672c5cd))
- 暗色模式刷新页面代码块重影问题（盲修，不一定完全修好）[#162](https://github.com/Mereithhh/vanblog/issues/162) ([8d888c6](https://github.com/Mereithhh/vanblog/commit/8d888c6cfe72bd45e759c43714f521ec597bf889))

### ♻️ Code Refactoring | 代码重构

- 更新 nextjs 13 后按照新规范修改 Link 标签的使用" ([b453665](https://github.com/Mereithhh/vanblog/commit/b4536650174ed11ce82b7e519e4573e770f36291))

### ✨ Features | 新功能

- 升级到 nextjs 13 ([4632b1b](https://github.com/Mereithhh/vanblog/commit/4632b1bdc71965643aff32fbca8f877c22fabe1f))
- 支持 mac 的 command + k 开启搜索 ([f6ded59](https://github.com/Mereithhh/vanblog/commit/f6ded59de2ec9f8f92de756e71ce4617372f220a))
- 新建文章或草稿自动跳转到编辑页面 ([baf4e3c](https://github.com/Mereithhh/vanblog/commit/baf4e3c0028067d97020386a0842ee3ac4d5bcf7))

### 💄 Styles | 风格

- 后台登录框居中&不自动记录密码 ([7174f11](https://github.com/Mereithhh/vanblog/commit/7174f11b8e1d511c7c160f6b3f8d94f232478676))

### 🚀 Chore | 构建/工程依赖/工具

- server 增加一个不启动 website 前台的模式 ([b2f0b15](https://github.com/Mereithhh/vanblog/commit/b2f0b150d47190c3089b7654afe3a1942f10eb92))
- server 开发时未制定配置 logs 为当前路径 ([57684a4](https://github.com/Mereithhh/vanblog/commit/57684a40d7c8a05e201fb5c21f8a1b88c090b59d))
- website 锁定 nextjs 版本 ([a93cb65](https://github.com/Mereithhh/vanblog/commit/a93cb65492e8178e5f66ddd1886bb9def5d72360))
- 增加一个取消所有进程的命令 ([ee0f564](https://github.com/Mereithhh/vanblog/commit/ee0f5644f48a52eb246fd693177ff53d1d8448fa))

### [0.45.6](https://github.com/Mereithhh/van-blog/compare/v0.45.5...v0.45.6) (2023-02-15)

### 🐛 Bug Fixes | Bug 修复

- 加密文章解密后目录未加载 ([cd6d43b](https://github.com/Mereithhh/van-blog/commit/cd6d43b9ad1fcc60eabfeb2a7de733468418a172))
- 大文本数据报错 ([92714c9](https://github.com/Mereithhh/van-blog/commit/92714c92ea37ce882543b4240fb4829861071883))
- 特殊情况报错 ([f4d3bd0](https://github.com/Mereithhh/van-blog/commit/f4d3bd0f23ae574599c12107f20a03fcae5baf99))

### ✏️ Documentation | 文档

- 更新文档 ([6ffc8c2](https://github.com/Mereithhh/van-blog/commit/6ffc8c2f710b8fca1fcc95849053f1e3183a3fdc))
- 更新文档 ([50729a5](https://github.com/Mereithhh/van-blog/commit/50729a5d9abbcc94ad0e8ed0249ded963b711135))
- 更新文档 ([7e5f9fd](https://github.com/Mereithhh/van-blog/commit/7e5f9fd992c14c33337fbbce9a2646aa53f2c20a))

### 🚀 Chore | 构建/工程依赖/工具

- **release:** 0.45.6 ([8bd73d8](https://github.com/Mereithhh/van-blog/commit/8bd73d8247ed52f5ae1666c672209f95dd936f88))
- **release:** 0.45.7 ([60fd157](https://github.com/Mereithhh/van-blog/commit/60fd1575382b49240eafe60860109de995612ac2))
- 构建报错 ([72ff966](https://github.com/Mereithhh/van-blog/commit/72ff96691053f484019ec4fe9ace72b6655fcd4b))

### ⏪ Revert | 回退

- 构建错误重新发版 ([8cd4cca](https://github.com/Mereithhh/van-blog/commit/8cd4ccac36ec2d0b46cd07c21bf044f44674f100))

### [0.45.5](https://github.com/Mereithhh/van-blog/compare/v0.45.4...v0.45.5) (2023-02-08)

### ✏️ Documentation | 文档

- 更新文档 ([7f27784](https://github.com/Mereithhh/van-blog/commit/7f27784f0603167e7dd3e9d22de7eef6dab3388f))

### 🐛 Bug Fixes | Bug 修复

- 前台挂掉 [#149](https://github.com/Mereithhh/van-blog/issues/149) ([6a136aa](https://github.com/Mereithhh/van-blog/commit/6a136aaa45f3d73dd15deff8dba8699a5c1be2f3))

### [0.45.4](https://github.com/Mereithhh/van-blog/compare/v0.45.3...v0.45.4) (2023-02-07)

### ✏️ Documentation | 文档

- 更新文档 ([bee0f58](https://github.com/Mereithhh/van-blog/commit/bee0f585b73c384e733bd801085c459fd5077983))

### 🐛 Bug Fixes | Bug 修复

- 分类数量显示不准确 [#146](https://github.com/Mereithhh/van-blog/issues/146) ([9a20c05](https://github.com/Mereithhh/van-blog/commit/9a20c051f804328f7a7720d25a1e5c14625a5664))

### ✨ Features | 新功能

- 后台编辑器换行与前台保持统一，两个回车才换行 [#148](https://github.com/Mereithhh/van-blog/issues/148) ([c4939b6](https://github.com/Mereithhh/van-blog/commit/c4939b6e867a9a691f1937be642b05ba4b0b3da3))

### [0.45.3](https://github.com/Mereithhh/van-blog/compare/v0.45.2...v0.45.3) (2023-02-04)

### ✏️ Documentation | 文档

- 更新文档 ([b730bf1](https://github.com/Mereithhh/van-blog/commit/b730bf1bac87a5e2eddca03463a9ede9dd4a5127))

### 🐛 Bug Fixes | Bug 修复

- 在设置自动主题的浏览器或设备上，后台编辑器预览的暗色主题无法切换 ([02e757e](https://github.com/Mereithhh/van-blog/commit/02e757ee1724132345e56d1bed35ef495bc699f5))

### [0.45.2](https://github.com/Mereithhh/van-blog/compare/v0.45.1...v0.45.2) (2023-02-04)

### ✏️ Documentation | 文档

- 更新文档 ([ac6fbc9](https://github.com/Mereithhh/van-blog/commit/ac6fbc900e9895c159a2c93f6d2357dab14f2ac1))

### 🐛 Bug Fixes | Bug 修复

- 域名带有端口号的情况下内置图床无法加载作者头像 ([4a9d507](https://github.com/Mereithhh/van-blog/commit/4a9d5076d2ea609e1385e0179f262a518e87733f))

### ✨ Features | 新功能

- 增加撤销重做按钮 ([1fa3829](https://github.com/Mereithhh/van-blog/commit/1fa382900534a0de845f3479de958da4f2b2542d))

### [0.45.1](https://github.com/Mereithhh/van-blog/compare/v0.45.0...v0.45.1) (2023-02-03)

### ✏️ Documentation | 文档

- 更新文档 ([3e8fcac](https://github.com/Mereithhh/van-blog/commit/3e8fcac72e5840493b78c408ff5be1af897acffa))

### 🐛 Bug Fixes | Bug 修复

- isr 更新报错导致 server 不正常退出 ([9efe654](https://github.com/Mereithhh/van-blog/commit/9efe6540775a471d3fa40c69204c7e5fd903e227))

## [0.45.0](https://github.com/Mereithhh/van-blog/compare/v0.44.0...v0.45.0) (2023-02-02)

### ⚡ Performance Improvements | 性能优化

- 增加索引 ([a4fcaca](https://github.com/Mereithhh/van-blog/commit/a4fcaca69bdb907f0d58b04bc246e4dc8c4791da))

### 🚀 Chore | 构建/工程依赖/工具

- 固定 admin 构建镜像版本，防止构建报错 ([5c6111c](https://github.com/Mereithhh/van-blog/commit/5c6111c519e571006658af75f5eb41d26878ddbc))

### ✨ Features | 新功能

- isr 默认按需更新，非按需时特定情况强制渲染 ([0e8539c](https://github.com/Mereithhh/van-blog/commit/0e8539cf44cc7c1a37624d293063bfe2eed44ee3))
- 分类加密 ([374e6ef](https://github.com/Mereithhh/van-blog/commit/374e6efac60786d5d2ec767277b15662e92658e4))
- 基于文件管理的自定义页面功能 ([eae6a8b](https://github.com/Mereithhh/van-blog/commit/eae6a8b88e7dd6fd1fe0c2e42fff201b309a47d6))
- 定制化可自定义 head 下标签，会跟随前台进行静态页面生成，可用于验证网站所有权 ([041eea4](https://github.com/Mereithhh/van-blog/commit/041eea47abb90405486f6f95014c88c867ec3c6e))
- 新增静态资源更新策略配置，默认采用 nextjs 自动模式以节约资源 ([5fe6898](https://github.com/Mereithhh/van-blog/commit/5fe68982a102ee840dc2eb877adfb748e610d529))
- 更新内置 picgo-core 到 1.5.0 ([e587a4e](https://github.com/Mereithhh/van-blog/commit/e587a4ef5643440c6402a024d376b49882820eac))
- 更新内置 waline 到 1.26.0 ([c28ec1f](https://github.com/Mereithhh/van-blog/commit/c28ec1f2d03c738023f3e8b7fd9d7612e123370c))
- 点击导航栏站点名称时返回首页 ([2a338c2](https://github.com/Mereithhh/van-blog/commit/2a338c2cd250e2e1107aa314ad00b723cddac828))

### ✏️ Documentation | 文档

- 增加静态页面更新策略文档 ([1366eb3](https://github.com/Mereithhh/van-blog/commit/1366eb35110821d4167b7929f6e2dd3e200b24af))
- 新版自定义页面文档 ([2282634](https://github.com/Mereithhh/van-blog/commit/2282634c7035fec74e70edce2a889829a0c24c33))
- 更新图床文档 ([df792e8](https://github.com/Mereithhh/van-blog/commit/df792e824288679a81d3f4c77d8d3a6cb711c39e))
- 更新开发指南 ([8a95244](https://github.com/Mereithhh/van-blog/commit/8a95244c80b31b8843d1e2c29316ce246a7212a5))
- 更新文档 ([385841e](https://github.com/Mereithhh/van-blog/commit/385841e7c6b4aacab1896c04eb271bfdf9513275))
- 更新文档 ([0c3d5ef](https://github.com/Mereithhh/van-blog/commit/0c3d5ef761c884ffc54d89167c9760dfb84f4d65))
- 更新谁在使用 ([939f560](https://github.com/Mereithhh/van-blog/commit/939f560e139e7db6fb0f4635ef2322b1470408df))
- 更新谁在使用 ([c90a17e](https://github.com/Mereithhh/van-blog/commit/c90a17ef9074c6dea7e6c51de9acfc5be641fe7b))

### 🐛 Bug Fixes | Bug 修复

- firefox 浏览器目录滚动条白条 [#132](https://github.com/Mereithhh/van-blog/issues/132) ([23d753c](https://github.com/Mereithhh/van-blog/commit/23d753cc78dc32b4467a4db81497240f55f703d6))
- isr 配置表单初始值未带入 ([f56f828](https://github.com/Mereithhh/van-blog/commit/f56f828f56afe7b26a7f486d4b8c173cc3eb75c1))
- isr 配置读取报错 ([2534cec](https://github.com/Mereithhh/van-blog/commit/2534cec1019ca68c0335dd0cf72675e70bc6062a))
- 分类接口获取报错 ([772ed36](https://github.com/Mereithhh/van-blog/commit/772ed362ea3d768f8bd4c323d779b8a2ae195537))
- 更新后台 isr 帮助文档指向' ([84bdcf3](https://github.com/Mereithhh/van-blog/commit/84bdcf3d6288da38bc05ba13eeeac3176e313989))
- 目录丢失问题 [#117](https://github.com/Mereithhh/van-blog/issues/117) ([72659f6](https://github.com/Mereithhh/van-blog/commit/72659f65173a8f1309e2dfa39eafcb19dd33ba47))
- 目录标题相同时，显示跳转异常 [#112](https://github.com/Mereithhh/van-blog/issues/112) ([5ac2f5f](https://github.com/Mereithhh/van-blog/commit/5ac2f5ff7cc80c5de0c4f700341fbee6a02fa5c5))
- 获取分类接口报错 ([dcd9083](https://github.com/Mereithhh/van-blog/commit/dcd908355bd28f0ac16d81777534b59ac51eb147))

## [0.44.0](https://github.com/Mereithhh/van-blog/compare/v0.43.1...v0.44.0) (2022-12-19)

### 💄 Styles | 风格

- 一级标题目录加缩进&移动端目录样式优化 [#100](https://github.com/Mereithhh/van-blog/issues/100) ([fb6dc9b](https://github.com/Mereithhh/van-blog/commit/fb6dc9b0bda2d0786fd2195b0535cccca40f7d25))

### ✨ Features | 新功能

- 升级内置 waline 到 v1.25.1 ([0379b1c](https://github.com/Mereithhh/van-blog/commit/0379b1c127dcd3cbbea1f0bcaf16f9d83979a41b))
- 联系方式中增加 gitee [#81](https://github.com/Mereithhh/van-blog/issues/81) ([7a00bb6](https://github.com/Mereithhh/van-blog/commit/7a00bb6b4ec1a59e76fa9d1dd33aa24ad8d47331))

### 🚀 Chore | 构建/工程依赖/工具

- **release:** 0.44.0 ([c64efdd](https://github.com/Mereithhh/van-blog/commit/c64efdd437ef6d8fec8d7d785bcd3a51f0bfb4e4))
- 增加一个方便开发的一键命令&脚本 ([f9c945e](https://github.com/Mereithhh/van-blog/commit/f9c945e2314bccf5db628f42408ab14b8f914b53))

### ✏️ Documentation | 文档

- 增加一个外置 cos 图床配置指南 ([177c318](https://github.com/Mereithhh/van-blog/commit/177c31811a4cccafbea69a9284f03457f851d0fc))
- 更新文档 ([cb01dfe](https://github.com/Mereithhh/van-blog/commit/cb01dfe0cec2429a658096aba1b08ef5b8c23826))
- 更新文档 ([4b37839](https://github.com/Mereithhh/van-blog/commit/4b378395c7cbad1bf68bff2ad7a980333fdbed2e))
- 更新文档 ([8660fe9](https://github.com/Mereithhh/van-blog/commit/8660fe9c200053cf462c5410ae2f32ef621d3f36))
- 更新文档 ([f22178f](https://github.com/Mereithhh/van-blog/commit/f22178f5d456e7e81d3c949514d0fa0ab3d70f66))
- 更新文档 ([1fc1ab9](https://github.com/Mereithhh/van-blog/commit/1fc1ab9ab41713744e2402171bb05fa10850ba2d))
- 更新谁在使用 ([098ba5b](https://github.com/Mereithhh/van-blog/commit/098ba5b8d51d041a3d81b93a6f466f1baaa8b2ba))
- 添加样例 ([3590efd](https://github.com/Mereithhh/van-blog/commit/3590efd7067eeedd967c494ca593d72c25a29624))

### 🐛 Bug Fixes | Bug 修复

- type error ([69db2a5](https://github.com/Mereithhh/van-blog/commit/69db2a5cc46b8f417b12f4e8973e9f5792b1fc8f))
- 个别分类无法删除修改 [#107](https://github.com/Mereithhh/van-blog/issues/107) ([fdb4ec2](https://github.com/Mereithhh/van-blog/commit/fdb4ec2101f9ee74d45bc42d64947dc1be161252))
- 修改文章信息时，修改后再次弹窗信息并未及时更新 [#111](https://github.com/Mereithhh/van-blog/issues/111) ([eb46785](https://github.com/Mereithhh/van-blog/commit/eb46785e4cf32e1a8bca3327672bbf96656a4584))
- 恢恢复后文章 post 后面数字的顺序与原来相反 [#80](https://github.com/Mereithhh/van-blog/issues/80) ([3828d1e](https://github.com/Mereithhh/van-blog/commit/3828d1ef2f927286d38bca6f46eb158f40e81a5d))
- 目录的滚动条自动跟随失效 [#87](https://github.com/Mereithhh/van-blog/issues/87) ([27db88b](https://github.com/Mereithhh/van-blog/commit/27db88bd5a9a5271ba000042fa045519f052bafc))
- 重启或更新服务时，一键脚本将删除匿名卷 ([0ff1761](https://github.com/Mereithhh/van-blog/commit/0ff176198bd31fbb948e75ae3c4d063861391bda))

### ⏪ Revert | 回退

- 回退改个 bug 重新发版 ([fdd82a1](https://github.com/Mereithhh/van-blog/commit/fdd82a1056e49e852b0134362f581a07a2637005))

### [0.43.1](https://github.com/Mereithhh/van-blog/compare/v0.43.0...v0.43.1) (2022-11-22)

### ✏️ Documentation | 文档

- 更新谁在使用 ([a16424d](https://github.com/Mereithhh/van-blog/commit/a16424db86faed7b0285466170648bc6140b8435))

### 🐛 Bug Fixes | Bug 修复

- 容器内 website 服务无限重启，导致 inode 缓慢增加占满硬盘空间 [#93](https://github.com/Mereithhh/van-blog/issues/93) [#85](https://github.com/Mereithhh/van-blog/issues/85) ([76c17cb](https://github.com/Mereithhh/van-blog/commit/76c17cb6c4be1ca05facbc3e9e27b11337c5f0d6))

## [0.43.0](https://github.com/Mereithhh/van-blog/compare/v0.42.0...v0.43.0) (2022-11-06)

### ✏️ Documentation | 文档

- 样例提交 ([39c66b8](https://github.com/Mereithhh/van-blog/commit/39c66b8447d50661b6a08b3333f46f1d0f14b850))
- 增加一个 docker pull 数量的图标 ([45caef7](https://github.com/Mereithhh/van-blog/commit/45caef7bf0d59ea54e91c4168d0a036aa75cebf9))
- 增加关于更新的描述 ([a1994f4](https://github.com/Mereithhh/van-blog/commit/a1994f45034a7f9c0964856dde6789fadba664c7))
- 更新文档 ([81e8bf6](https://github.com/Mereithhh/van-blog/commit/81e8bf68d00e6c6e890a229c5403f93439b9cb13))
- 更新文档 ([aff561a](https://github.com/Mereithhh/van-blog/commit/aff561af416d2e6b4039b7720dfcc75c733ca86d))
- 更新文档 ([5c0ab9d](https://github.com/Mereithhh/van-blog/commit/5c0ab9dfe012407b7ad09df8a2d94ad468ea8bb1))
- 更新文档 ([c219a77](https://github.com/Mereithhh/van-blog/commit/c219a77bfd74a20a5e70b483d9f11d7f7575c9af))
- 更新样例 ([289675e](https://github.com/Mereithhh/van-blog/commit/289675e57ba0762deab735b77c2474a985311b81))
- 更新样例 ([be4761d](https://github.com/Mereithhh/van-blog/commit/be4761d283076012ac4e38bfe99cb989aec7542a))
- 编辑此页失效 ([3393cbb](https://github.com/Mereithhh/van-blog/commit/3393cbb45bbeb89364de927596eb2a5d532fa72a))

### ✨ Features | 新功能

- mac 可以 command + s 保存文章 ([5cc4086](https://github.com/Mereithhh/van-blog/commit/5cc4086fa6ad982b26d013bca63d8f6cdeb0ee18))
- 增加是否显示文章内容过时提示框的配置项 ([6cac2e0](https://github.com/Mereithhh/van-blog/commit/6cac2e065c33bbdf76c035dd924c73c673544ba4))
- 屏蔽一些可忽略的 warning 日志 ([d982d4f](https://github.com/Mereithhh/van-blog/commit/d982d4f5e6b089bdbbc270962d43689e558ae1ae))
- 每篇文章都可设置独立的自定义版权声明文字 ([91ea94a](https://github.com/Mereithhh/van-blog/commit/91ea94a3a2f9504796b747f8c3bd82bcfaf9637d))
- 移动端文章页面自动生成目录放到最上方 ([dcdee68](https://github.com/Mereithhh/van-blog/commit/dcdee6852db3632d564ee473264c6beb917fad7f))

### 🐛 Bug Fixes | Bug 修复

- 一键脚本报错 ([8afab4d](https://github.com/Mereithhh/van-blog/commit/8afab4d9fb71a0f06f5f01bb432e97d59adf303f))
- 修复一键部署脚本下载编排报错 ([cb99533](https://github.com/Mereithhh/van-blog/commit/cb99533adfcf89257c29e12c9efbbcf1dbe38d1a))
- 编辑器预览的换行行为和前台换行行为不一致（编辑器预览换行但前台页面不换行） [#78](https://github.com/Mereithhh/van-blog/issues/78) ([680e9a3](https://github.com/Mereithhh/van-blog/commit/680e9a3ae7a4c3e61710cd32106a64476d3d296b))
- 部署脚本报错选项不为空 ([94eadc2](https://github.com/Mereithhh/van-blog/commit/94eadc28f74f61d41eee8e785270b35c4b3b449a))

## [0.42.0](https://github.com/Mereithhh/van-blog/compare/v0.41.5...v0.42.0) (2022-10-24)

### 🚀 Chore | 构建/工程依赖/工具

- 增加日志文件配置项 ([ae1e260](https://github.com/Mereithhh/van-blog/commit/ae1e260545a2285e7b0b3eceb4032cae100d770b))

### ✏️ Documentation | 文档

- 更新一些 faq ([f507ad1](https://github.com/Mereithhh/van-blog/commit/f507ad1d5f5288fb2e6b6e2ad7b7120dfb0af344))
- 更新捐赠信息 ([551cb00](https://github.com/Mereithhh/van-blog/commit/551cb00902c4b12c4e7fe8c09bd592d7f1f75cb4))
- 更新文档 ([7639869](https://github.com/Mereithhh/van-blog/commit/7639869b405f83081166de54ae8c60326791a75a))

### ✨ Features | 新功能

- 优化代码块样式: 减少滚动条高度、增加语言显示、复制按钮置顶以免挡住代码 [#72](https://github.com/Mereithhh/van-blog/issues/72) [#71](https://github.com/Mereithhh/van-blog/issues/71) [#73](https://github.com/Mereithhh/van-blog/issues/73) ([ae8cae4](https://github.com/Mereithhh/van-blog/commit/ae8cae4693f666b8bc3e35f638e6d81b731adf2c))
- 去掉 ALLOW_DOMAINS 环境变量，精简配置，自动读取图片允许域名，避免再出现作者 logo 无法显示问题 ([dfd1a94](https://github.com/Mereithhh/van-blog/commit/dfd1a9491acb3010da2bec067f7d3806b573466a))
- 增加版权协议的配置项 ([c9d1d18](https://github.com/Mereithhh/van-blog/commit/c9d1d18c31a66ee8b71d259a2430abc537cd1833))
- 增加页脚公安备案号展示的配置项 ([9a43d7f](https://github.com/Mereithhh/van-blog/commit/9a43d7f4582a35a6962a97871df3972ff2f46c74))
- 编辑器页面可按 ctrl+s 快捷保存 ([e92f2ba](https://github.com/Mereithhh/van-blog/commit/e92f2baf743fa139580d14a6db172b8754ecdfba))

### 🐛 Bug Fixes | Bug 修复

- 主题切换闪屏 [#54](https://github.com/Mereithhh/van-blog/issues/54) ([dfd9aca](https://github.com/Mereithhh/van-blog/commit/dfd9acaebbba914ef7c0bf608bf2a6a4daede24a))
- 代码块操作符背景颜色块不一致 ([c961883](https://github.com/Mereithhh/van-blog/commit/c961883ddb069a4c78ff0f5353f70b97ed6da1f2))
- 减少本地浏览器主题和服务端默认主题不一致时的闪屏时间 [#54](https://github.com/Mereithhh/van-blog/issues/54) ([b581f07](https://github.com/Mereithhh/van-blog/commit/b581f07103131465ce68f186f069167b32794424))
- 禁止发布草稿时自动填充密码以避免发布报错 ([02754c7](https://github.com/Mereithhh/van-blog/commit/02754c77e01983d7465a58b0302f91fd905aa1b9))

### [0.41.5](https://github.com/Mereithhh/van-blog/compare/v0.41.4...v0.41.5) (2022-10-07)

### ✏️ Documentation | 文档

- 更新文档 ([7feeb23](https://github.com/Mereithhh/van-blog/commit/7feeb23199d4d36ed72b2dd6f87b16fabe08068d))

### 💄 Styles | 风格

- 多个标签时溢出会换行展示（原来不会） ([0f8cfc6](https://github.com/Mereithhh/van-blog/commit/0f8cfc695261a1314b296367f16c3214c6e7fef3))

### 🐛 Bug Fixes | Bug 修复

- encodeQuerystring 报错 ([b208daf](https://github.com/Mereithhh/van-blog/commit/b208dafb2b693c5cf8cd95c720c824874e9c8ef1))
- markdown 内部 img 标签加 style 属性报错 [#63](https://github.com/Mereithhh/van-blog/issues/63) ([f94f5cf](https://github.com/Mereithhh/van-blog/commit/f94f5cff9a9ee7751dc5aec833fe2516e1994156))

### [0.41.4](https://github.com/Mereithhh/vanblog/compare/v0.41.3...v0.41.4) (2022-09-30)

### ✏️ Documentation | 文档

- 更新文档 ([9bd2c03](https://github.com/Mereithhh/vanblog/commit/9bd2c03da6fba370721d672fb119b0328b634a24))
- 更新样例 ([d053df0](https://github.com/Mereithhh/vanblog/commit/d053df07fc15fef9b4cf8367f0adc1da5210e53d))

### 👷 Continuous Integration | CI 配置

- window 开发后端无法正常启动 ([a80eca8](https://github.com/Mereithhh/vanblog/commit/a80eca82abe81aec637e064c2854c1dbc067deaa))

### 🐛 Bug Fixes | Bug 修复

- 导航栏下级与副导航栏渲染图层问题[#60](https://github.com/Mereithhh/vanblog/issues/60) ([0cf2f67](https://github.com/Mereithhh/vanblog/commit/0cf2f67ca6db55b06c8c19d1d3f14ad03b117975))
- 二级导航栏未适配黑色主题 ([0e471b3](https://github.com/Mereithhh/vanblog/commit/0e471b3405aa4a62370d5bfa9b1288cb5182c041))

### [0.41.3](https://github.com/Mereithhh/van-blog/compare/v0.41.2...v0.41.3) (2022-09-28)

### ✏️ Documentation | 文档

- 更新文档 ([fda963d](https://github.com/Mereithhh/van-blog/commit/fda963dd6cf93bfd70d25b8c78f06364a1dd25d6))

### 🐛 Bug Fixes | Bug 修复

- markdown 中的 img 标签无法调整图片大小 ([3e2dbfa](https://github.com/Mereithhh/van-blog/commit/3e2dbfaf9ad8fe61da91cf64be076e080833db68))

### [0.41.2](https://github.com/Mereithhh/van-blog/compare/v0.41.1...v0.41.2) (2022-09-28)

### ✏️ Documentation | 文档

- 增加案例 ([bfa52b8](https://github.com/Mereithhh/van-blog/commit/bfa52b8121dc85d593eec0d66b37f378ceb91d63))
- 更新宝塔部署教程 ([80bf1ec](https://github.com/Mereithhh/van-blog/commit/80bf1ec53a45daa0817d3af77aa9e30ce6ff338f))
- 更新文档 ([c00d36f](https://github.com/Mereithhh/van-blog/commit/c00d36f5c94bbc78e424400b9b9eaa6aaf4b7971))
- 更新文档 ([6b78fce](https://github.com/Mereithhh/van-blog/commit/6b78fce71f5a84b434b111c261f6177a1a024fde))
- 更新文档 ([c79552e](https://github.com/Mereithhh/van-blog/commit/c79552ef6c3800b5b1772d7c40b1f644b55d7fd4))
- 更新部署文档 ([48e1ae8](https://github.com/Mereithhh/van-blog/commit/48e1ae8b19c8267dc9e690f1709ac2c00ebf5d4e))

### 🐛 Bug Fixes | Bug 修复

- 特殊情形 markdown 标题解析失败会阻塞前台页面更新 ([10db49c](https://github.com/Mereithhh/van-blog/commit/10db49c7938a148c2b5d91bebc35fdf1a2046a99))

### ✨ Features | 新功能

- 进入后台编辑页面时，页面标题以编辑内容标题为准 [#56](https://github.com/Mereithhh/van-blog/issues/56) ([0ec23c1](https://github.com/Mereithhh/van-blog/commit/0ec23c1b83c2c96c362c617b011cd144bf4393d6))

### [0.41.1](https://github.com/Mereithhh/van-blog/compare/v0.41.0...v0.41.1) (2022-09-26)

### ✏️ Documentation | 文档

- 更新 TODO ([882240b](https://github.com/Mereithhh/van-blog/commit/882240b276bd91078b2b9496d6bc4f360a7c6835))
- 更新文档 ([0b04c04](https://github.com/Mereithhh/van-blog/commit/0b04c044459b31866a412c474e236eabfde06a14))
- 更新文档 ([256be97](https://github.com/Mereithhh/van-blog/commit/256be973172bef83019e61a1055e851fc1c17f41))
- 更新文档 ([d194055](https://github.com/Mereithhh/van-blog/commit/d1940558a4f6fc3d1d5eedb1cd90b6e5343defbb))
- 更新文档 ([197d84d](https://github.com/Mereithhh/van-blog/commit/197d84de60e76d1c7f4c335e776c57505867ea40))
- 更新文档 ([0b668a4](https://github.com/Mereithhh/van-blog/commit/0b668a47715332b365aa42950f6871138dfffa28))
- 预览图更新 ([4a7bd6f](https://github.com/Mereithhh/van-blog/commit/4a7bd6fd392a64c0487d6e54bf968707d55cde48))

### 🐛 Bug Fixes | Bug 修复

- markdown 中标题带有链接时目录无法正常展示 ([1cb79ba](https://github.com/Mereithhh/van-blog/commit/1cb79baa003631eeac6fefeef56b90b104310348))
- sitemap 失效 ([4e3cddd](https://github.com/Mereithhh/van-blog/commit/4e3cdddc29e944797e8a359acfe6f1c8311f45f1))
- 一键脚本错误 ([5deb9fa](https://github.com/Mereithhh/van-blog/commit/5deb9fa704da7a49c29a07a1ec53b0cfa4ed5eee))
- 优化 waline 重启逻辑 ([8e9325c](https://github.com/Mereithhh/van-blog/commit/8e9325cea0dd375db006e683509cf7edae1c6094))
- 修正一键脚本版本号显示问题 ([b30be89](https://github.com/Mereithhh/van-blog/commit/b30be89a694adf1246240b2bf85fb1b5a9ad68a7))
- 修正一键脚本的更新错误 ([f25db21](https://github.com/Mereithhh/van-blog/commit/f25db211daca043f8c4be6d5e6f0fa4c4b89f4ca))

## [0.41.0](https://github.com/Mereithhh/van-blog/compare/v0.40.2...v0.41.0) (2022-09-23)

### ✨ Features | 新功能

- 前台 next.js 服务增加意外退出自动重启机制（website 由后端通过 child_process 控制） ([930adc8](https://github.com/Mereithhh/van-blog/commit/930adc80f6358d152ebcef529a92b795b4c2a845))
- 后台增加控制页面链接点击跳转行为配置（可选择为在新窗口打开） ([7d214c8](https://github.com/Mereithhh/van-blog/commit/7d214c8dff2d08fa43393fc9baf769c36f1eccc7))
- 增加单天访客/访问数的趋势图 ([b55d603](https://github.com/Mereithhh/van-blog/commit/b55d603f72632fa98fbedea4a7f4bd1057a62bbe))
- 文章内的跳转链接会在新窗口/标签页打开 ([7a63eb4](https://github.com/Mereithhh/van-blog/commit/7a63eb43d2c1d6a32ed12cbcd37fb012bdd99b41))

### 🚀 Chore | 构建/工程依赖/工具

- **release:** 0.41.0 ([0d4568c](https://github.com/Mereithhh/van-blog/commit/0d4568c309839cba3d6fde3318e3dc5e502ca625))

### 👷 Continuous Integration | CI 配置

- 增加提交样例的 ISSUE 模板 ([7a4bb21](https://github.com/Mereithhh/van-blog/commit/7a4bb2185ea4dcaef0c8121a4009a1c53d1a96da))

### ✏️ Documentation | 文档

- 提交使用案例 ([9fb01d8](https://github.com/Mereithhh/van-blog/commit/9fb01d81c827aa5c03b2495e615c2488c46b70d9))
- 更新宝塔部署和升级文档 ([5e244a2](https://github.com/Mereithhh/van-blog/commit/5e244a2e42f65721f0d923e1273c85f770b17186))
- 更新文档 ([f288e1e](https://github.com/Mereithhh/van-blog/commit/f288e1ee1d7fa77d349bec78081857c4693888c8))
- 更新文档 ([b9d9eed](https://github.com/Mereithhh/van-blog/commit/b9d9eed8c3193b89d9f4af6859678f78d85efeae))
- 更新文档 ([e51b161](https://github.com/Mereithhh/van-blog/commit/e51b16170bff35c074dc9a8fbc39eee9d0150b30))
- 更新文档 ([0e0e482](https://github.com/Mereithhh/van-blog/commit/0e0e482c254ac5a6fa3fd7c1043fd3721313aea7))
- 更新文档 ([7297bbc](https://github.com/Mereithhh/van-blog/commit/7297bbce2d2b0e40a1370396e20461ee9c6ada3c))
- 更新文档 ([35199c9](https://github.com/Mereithhh/van-blog/commit/35199c9562b59ab246c78ee719bed668c6fe4625))
- 更新文档 ([edc519f](https://github.com/Mereithhh/van-blog/commit/edc519f4ef454194548d6302dbff28055f405b30))
- 补充文档关于 Caddy 的描述 ([9cc7e70](https://github.com/Mereithhh/van-blog/commit/9cc7e70fbafa3770b974db4d63c58d6d5adc4f9d))

### 🐛 Bug Fixes | Bug 修复

- 全文无标题但代码块内有 # 开头注释会被目录组件误识别成标题 ([bba4b48](https://github.com/Mereithhh/van-blog/commit/bba4b48a020e91d5199506dd186af3dbbde2d26b))
- 前台 markdown 组件渲染时报错 ([42892c1](https://github.com/Mereithhh/van-blog/commit/42892c1f5c1321ccdcb1d79566bcb9480d7005de))
- 后台编辑器渲染行内公式导致页面溢出 ([a9fb466](https://github.com/Mereithhh/van-blog/commit/a9fb4668acd01158f67a304653b1ec21c8f29f58))
- 图片名有空格编辑器无法预览 ([afab503](https://github.com/Mereithhh/van-blog/commit/afab50386fda610b83c0e9c9a05e9cdd05471aa0))
- 精简前台 next.js 配置文件去掉多余的报错 ([8c355f7](https://github.com/Mereithhh/van-blog/commit/8c355f781499e3b517fb378b4b983f9f0d9fc92f))

### ⏪ Revert | 回退

- 加个 fix 重新发版 ([7a94c34](https://github.com/Mereithhh/van-blog/commit/7a94c347546417fc6f67dcaa1297d32ed6a0f9e8))

### [0.40.2](https://github.com/Mereithhh/van-blog/compare/v0.40.1...v0.40.2) (2022-09-20)

### ⚡ Performance Improvements | 性能优化

- 调整一下 ISR 页面静态化顺序，这样串行 ISR 的时候修改的文章页和首页会优先更新 ([13641b6](https://github.com/Mereithhh/van-blog/commit/13641b6eb622d11e48d6207cbb7f9168a1112513))

### ✏️ Documentation | 文档

- j 优化一键脚本 ([9f93939](https://github.com/Mereithhh/van-blog/commit/9f939395b4e16da5b93d7bea668b5e32e211508a))
- README 增加一键部署脚本 ([1502a8b](https://github.com/Mereithhh/van-blog/commit/1502a8b94b622eabb52ca63019a4ac074cf73051))
- 更新文档 ([20ae6d2](https://github.com/Mereithhh/van-blog/commit/20ae6d27087dd98235ccb1d2925c4525632fbe68))
- 更新文档 ([8693c9b](https://github.com/Mereithhh/van-blog/commit/8693c9b672ae95e7cc17248b88bb47fc1c392842))
- 更新文档 ([b09cad8](https://github.com/Mereithhh/van-blog/commit/b09cad889dc3fba4b55612ae1ee969527939f6aa))
- 更新文档 ([e463729](https://github.com/Mereithhh/van-blog/commit/e4637296c35bb8aa75f9f1ede75d43faa1da6b5d))
- 部署脚本加个截图 ([4846520](https://github.com/Mereithhh/van-blog/commit/4846520934dc6da1e1eac10f15465a1cd41c87d1))

### [0.40.1](https://github.com/Mereithhh/van-blog/compare/v0.40.0...v0.40.1) (2022-09-20)

### ✏️ Documentation | 文档

- 更新文档 ([5763ae4](https://github.com/Mereithhh/van-blog/commit/5763ae4c28a68d192131aed03d9e7208a1c7bf5e))

### 🐛 Bug Fixes | Bug 修复

- 更新字数缓存防抖错误 & ISR 触发改为串行 ([d8311ac](https://github.com/Mereithhh/van-blog/commit/d8311ac55213ce09d6b9d68833529b1a1358e65c))
- 第一个一级标题不在目录中出现 ([da898ac](https://github.com/Mereithhh/van-blog/commit/da898acf9ac58f93ec834933713f8029166e904c))

## [0.40.0](https://github.com/Mereithhh/van-blog/compare/v0.39.0...v0.40.0) (2022-09-20)

### ⚡ Performance Improvements | 性能优化

- ISR 触发和 RSS 生成增加防抖 ([45f39f0](https://github.com/Mereithhh/van-blog/commit/45f39f050c7c2bfb312c3b8f4166fefd39829e73))
- 增加一些数据库索引 ([2e23496](https://github.com/Mereithhh/van-blog/commit/2e234967003393966daad0b94969b022e2bcf086))

### ✨ Features | 新功能

- picgo 可后台配置安装插件 [#48](https://github.com/Mereithhh/van-blog/issues/48) ([2a49110](https://github.com/Mereithhh/van-blog/commit/2a49110f705940656867519b66e7d47ed82d897e))
- 删除 JWT 密钥配置，每次启动完全随机 ([5ceefd1](https://github.com/Mereithhh/van-blog/commit/5ceefd17cd0e7c34d21d9be45439582593bdfb3d))
- 增加一个 robots.txt （原来是 robot.txt） ([0bf6563](https://github.com/Mereithhh/van-blog/commit/0bf65638480766dbbde70b0f65c4248e0e7c259c))
- 增加内置 Token 管理，登出或修改用户会强制失效所有已签发 Token [#45](https://github.com/Mereithhh/van-blog/issues/45) ([4984981](https://github.com/Mereithhh/van-blog/commit/4984981f0df3fab1fe3e29e766f7c1a2a7384ad2))
- 忘记密码恢复功能 ([48f2728](https://github.com/Mereithhh/van-blog/commit/48f272848de955c60844b4c7c4a2af093dd89773))
- 登录凭证有效期后台可配置 [#44](https://github.com/Mereithhh/van-blog/issues/44) ([853ca38](https://github.com/Mereithhh/van-blog/commit/853ca38968d13538784659d899b48adaaa202077))
- 自动生成 SiteMap ([2f4397c](https://github.com/Mereithhh/van-blog/commit/2f4397c542b6a785f0ff3ed1ef8f53f5cec3cdf1))

### ✏️ Documentation | 文档

- 先屏蔽一下一键脚本，测试后再打开 ([484e183](https://github.com/Mereithhh/van-blog/commit/484e1836c8bd46df446eb8ed4488be7471dfd87f))
- 增加全自动部署脚本 ([e7b7325](https://github.com/Mereithhh/van-blog/commit/e7b73253f0a0357e762445a1eac7ec63df327abc))
- 开放一键部署脚本 ([50f17f0](https://github.com/Mereithhh/van-blog/commit/50f17f058bf9aba7aa3d70eb4fd0835c1058ef11))
- 更新 tudo ([08670b7](https://github.com/Mereithhh/van-blog/commit/08670b7ca95ab18538dea73712c824b21f7b0205))
- 更新打赏信息 ([bd1cc23](https://github.com/Mereithhh/van-blog/commit/bd1cc235291b0c494dd9ff593cf09f90facc1ab0))
- 更新文档 ([b97ec09](https://github.com/Mereithhh/van-blog/commit/b97ec0998017d13ef8b600aac2a6a65c18bf5de9))
- 更新文档 ([417a48f](https://github.com/Mereithhh/van-blog/commit/417a48f1aaaec4fc3b561d128d54dfae5a7bfe58))
- 更新文档 ([8ef4869](https://github.com/Mereithhh/van-blog/commit/8ef486907498ffaa24ef8222e5b6a065038c98d8))
- 更新文档 ([cf49a85](https://github.com/Mereithhh/van-blog/commit/cf49a852c9cea5651ec56ff6045171300253a8e8))
- 更新文档 ([a3fd9ab](https://github.com/Mereithhh/van-blog/commit/a3fd9ab7cf2da916ea316eeeca89aea5506bf186))
- 更新文档 ([4681052](https://github.com/Mereithhh/van-blog/commit/46810526248110fc44f5c22fe97ddf91f6c4fd98))
- 更新文档 ([a3989aa](https://github.com/Mereithhh/van-blog/commit/a3989aa3fa2be251b5ac9e9d057edd7f92bd3585))
- 更新文档（FAQ） ([ead35db](https://github.com/Mereithhh/van-blog/commit/ead35dbae039ff2792c383081564184834fa2dbd))
- 更新新功能的文档 ([74e689d](https://github.com/Mereithhh/van-blog/commit/74e689d946d220b7a717f55d562a652a43463e23))
- 精简编排配置项 ([64ad8a8](https://github.com/Mereithhh/van-blog/commit/64ad8a857fb811c8385607d96b4b1dcff767eef0))
- 群晖和宝塔部署默认推荐映射存储防止数据丢失 ([99f6edc](https://github.com/Mereithhh/van-blog/commit/99f6edc1f730dc8d9defa24a8fb99e355f56010e))

## [0.39.0](https://github.com/Mereithhh/van-blog/compare/v0.38.2...v0.39.0) (2022-09-17)

### ✨ Features | 新功能

- SEO 优化：文章页、首页和列表页会根据标签和分类增加 keywords 的 meta 标签 ([26733ff](https://github.com/Mereithhh/van-blog/commit/26733ff89c1666032160a9154fbe3d9450892fe4))
- 内置 waline 支持传递自定义的环境变量配置 ([99e4305](https://github.com/Mereithhh/van-blog/commit/99e4305badc67bf21b54f3a9c84c3391cf19c9ce))
- 后台增加迁移助手，可批量导入草稿/文章 ([d1e3166](https://github.com/Mereithhh/van-blog/commit/d1e3166dd13d7503cdbbaced82823343f5015bcd))

### ✏️ Documentation | 文档

- 更新一下 faq ([87dd17c](https://github.com/Mereithhh/van-blog/commit/87dd17c69927e4fc1f678c64af44800656613612))
- 更新一个群晖部署文档 ([9d9f4ae](https://github.com/Mereithhh/van-blog/commit/9d9f4aee1b4177b2dc347710c69ea7cd3260be52))
- 更新文档 ([d9844a7](https://github.com/Mereithhh/van-blog/commit/d9844a79e2aaee4c1064500230b1efcbf8e02986))
- 更新文档 ([4096b34](https://github.com/Mereithhh/van-blog/commit/4096b345dcaa68f54dbb660b3a4a6aa9a90de144))
- 更新文档 ([7f3c2f8](https://github.com/Mereithhh/van-blog/commit/7f3c2f86ee719e4ba10eab19c118e5307b8d176d))
- 更新文档 ([fc4686c](https://github.com/Mereithhh/van-blog/commit/fc4686c9a8f536e54c0512636aa544b39f579d7b))
- 更新文档 ([ba56bf5](https://github.com/Mereithhh/van-blog/commit/ba56bf5efb10ae554d0891b384e6ec498848d9be))
- 更新文档&捐赠信息 ([1137404](https://github.com/Mereithhh/van-blog/commit/113740425b2d64337b562b671029a4e00074a0df))

### 🐛 Bug Fixes | Bug 修复

- 分类导航栏显示时，分类过长导致的排版错乱 ([f42469d](https://github.com/Mereithhh/van-blog/commit/f42469d893e7583ba61a3ebeba9ea5e81de981b0))
- 分类或标签中含有 # 或 / 出现的 404 问题 ([5e4ae6c](https://github.com/Mereithhh/van-blog/commit/5e4ae6c5c1a2bb8755f21d2e720438496eb458ab))
- 友链申领要求重复 ([81c03dd](https://github.com/Mereithhh/van-blog/commit/81c03dd9abd2258dccb4419d388fa108f512ab27))
- 群晖系统无法登录评论后台 ([450d6c6](https://github.com/Mereithhh/van-blog/commit/450d6c6a68a2911dbf3b442b8b7c39c639cb4adf))

### [0.38.2](https://github.com/Mereithhh/van-blog/compare/v0.38.1...v0.38.2) (2022-09-14)

### ✏️ Documentation | 文档

- 更新捐赠信息 ([398c08c](https://github.com/Mereithhh/van-blog/commit/398c08caa817ce8d880b538ca62e51c7e419058d))
- 更新文档 ([3c2cfde](https://github.com/Mereithhh/van-blog/commit/3c2cfdeddf04bbe9de4ea474bc1a4500cb2a7095))
- 更新文档 ([2316912](https://github.com/Mereithhh/van-blog/commit/23169127576d93c5ca433b9a98b0c9fff44a594c))

### 🐛 Bug Fixes | Bug 修复

- 标题和标签中携带"#"导致目录和标签页显示不正常 ([81baad5](https://github.com/Mereithhh/van-blog/commit/81baad553342b0e7dd2ce041a90b69be5efe3de7))

### [0.38.1](https://github.com/Mereithhh/van-blog/compare/v0.38.0...v0.38.1) (2022-09-13)

### ✏️ Documentation | 文档

- 更新文档 ([4bd795a](https://github.com/Mereithhh/van-blog/commit/4bd795a47dc1e438e7343070cb96041dfdf7dd4b))

### 🐛 Bug Fixes | Bug 修复

- RSS 订阅中的 HTML 出现了不合时宜的 a 标签 ([dc86650](https://github.com/Mereithhh/van-blog/commit/dc866501c2f58b169383fbca9b653e7b77050217))

## [0.38.0](https://github.com/Mereithhh/van-blog/compare/v0.37.2...v0.38.0) (2022-09-13)

### ✨ Features | 新功能

- 后台编辑器预览内嵌 HTML [#47](https://github.com/Mereithhh/van-blog/issues/47) ([c920a2e](https://github.com/Mereithhh/van-blog/commit/c920a2e8aded13297a2721032ea85b09796c8bee))

### 🚀 Chore | 构建/工程依赖/工具

- **release:** 0.38.0 ([d16e10b](https://github.com/Mereithhh/van-blog/commit/d16e10b28528610b24639f51bd2236e8d8d6adc2))

### ✏️ Documentation | 文档

- 更新 TODO ([a571cfa](https://github.com/Mereithhh/van-blog/commit/a571cfa37063bffaedb04622e9dd928fff64878d))
- 更新文档 ([883696f](https://github.com/Mereithhh/van-blog/commit/883696f42303dd0ed118c0b9846fa897f5284154))
- 更新文档 ([4b20720](https://github.com/Mereithhh/van-blog/commit/4b20720d1a64bbc857b1367635e2017712d046a6))

### 🐛 Bug Fixes | Bug 修复

- 初始化未添加默认菜单信息导致前台无法更新 ([8064dbb](https://github.com/Mereithhh/van-blog/commit/8064dbbd41a8c1db5d6c224cfdbff4a417b7c3e3))

### [0.37.2](https://github.com/Mereithhh/van-blog/compare/v0.37.1...v0.37.2) (2022-09-13)

### ✏️ Documentation | 文档

- 更新文档 ([d1cd10c](https://github.com/Mereithhh/van-blog/commit/d1cd10c5467aba2002b9f168a7dc4347acdd2362))

### 🐛 Bug Fixes | Bug 修复

- 无凭证首次进入后台出现登录失效 [#46](https://github.com/Mereithhh/van-blog/issues/46) ([6af8093](https://github.com/Mereithhh/van-blog/commit/6af8093176507d819bcd0496b7595c9eda79c41a))

### [0.37.1](https://github.com/Mereithhh/van-blog/compare/v0.37.0...v0.37.1) (2022-09-12)

### ✏️ Documentation | 文档

- 更新文档 ([88dab53](https://github.com/Mereithhh/van-blog/commit/88dab53b14b416e1ee4e9458982be5aadcbb46c1))
- 更新文档 ([5419976](https://github.com/Mereithhh/van-blog/commit/54199760cfe86817ea855ea4c3ddfac443562e39))
- 更新文档 ([baacf31](https://github.com/Mereithhh/van-blog/commit/baacf31d175b672162268b2ada7c7ca778e15610))

### 🐛 Bug Fixes | Bug 修复

- 目录组件 hover 态不填满卡片 ([580d78d](https://github.com/Mereithhh/van-blog/commit/580d78da9599799963eb6f0ccd2081c11a825978))

## [0.37.0](https://github.com/Mereithhh/van-blog/compare/v0.36.2...v0.37.0) (2022-09-10)

### ✏️ Documentation | 文档

- 更新文档 ([833baeb](https://github.com/Mereithhh/van-blog/commit/833baeb685afe0d0181ab4db25f870515a59283b))
- 更新文档 ([1ac5dc0](https://github.com/Mereithhh/van-blog/commit/1ac5dc0a2240abce713ccd91f42b7ccaa02ce638))
- 部署编排更新一个初始化数据库的环境变量 ([72213c8](https://github.com/Mereithhh/van-blog/commit/72213c880caad9a55a63e0a7aa4e4708f99b3e5e))

### 🐛 Bug Fixes | Bug 修复

- 关闭用户缩放 [#40](https://github.com/Mereithhh/van-blog/issues/40) ([3bb1117](https://github.com/Mereithhh/van-blog/commit/3bb1117cce24ca2c3f1499a16847a0ae40cc96ef))
- 草稿导入 ID 重复 [#42](https://github.com/Mereithhh/van-blog/issues/42) ([a69d028](https://github.com/Mereithhh/van-blog/commit/a69d028ba5d0346a94dbc9eb392dcaa386fb0636))

### ✨ Features | 新功能

- 前台代码块随主题亮暗切换 [#43](https://github.com/Mereithhh/van-blog/issues/43) ([fe3c09e](https://github.com/Mereithhh/van-blog/commit/fe3c09e29ae49ebc5baa31fa22feebe03ab8b2f1))
- 升级提示可跳过某个版本 ([35f9f00](https://github.com/Mereithhh/van-blog/commit/35f9f00dd63b62e9c70331b3eb52ee4e82ccde5a))
- 导航菜单完全自定义&二级菜单 [#34](https://github.com/Mereithhh/van-blog/issues/34) ([12f4577](https://github.com/Mereithhh/van-blog/commit/12f4577b2fc5a65e156351275148b93b76d85963))

### ♻️ Code Refactoring | 代码重构

- 代码组件抽离原子化 ([187e48a](https://github.com/Mereithhh/van-blog/commit/187e48ae197fc7f999bc8829f3ec6ecf669a33b1))
- 文章卡片组件抽离 ([7df186a](https://github.com/Mereithhh/van-blog/commit/7df186abe88b62a543076f06564ca83905caaf4d))

### [0.36.2](https://github.com/Mereithhh/van-blog/compare/v0.36.1...v0.36.2) (2022-09-08)

### ✏️ Documentation | 文档

- 更新打赏列表 ([73bc1ab](https://github.com/Mereithhh/van-blog/commit/73bc1ab69358298631fe7e4390c6e814801581b9))
- 更新文档 ([aab5979](https://github.com/Mereithhh/van-blog/commit/aab59793e668bd18086c8ecc0981f2b194705e14))
- 更新文档 ([85a9cdc](https://github.com/Mereithhh/van-blog/commit/85a9cdc7027082b8734dd1e0e3537e3b47b156af))

### 🐛 Bug Fixes | Bug 修复

- 友链超过 5 个无法添加[#39](https://github.com/Mereithhh/van-blog/issues/39) ([a2b60f2](https://github.com/Mereithhh/van-blog/commit/a2b60f262c0ffdca0da0455fe471587eaaf2a877))

### [0.36.1](https://github.com/Mereithhh/van-blog/compare/v0.36.0...v0.36.1) (2022-09-08)

### ✏️ Documentation | 文档

- 更新捐赠信息&修复错误 ([9cc25af](https://github.com/Mereithhh/van-blog/commit/9cc25af7833fb4cd214dc22aa07aa47c829ebbff))
- 更新文档 ([39bf2dc](https://github.com/Mereithhh/van-blog/commit/39bf2dc56b2fbf7ced6ea85f192236ba45d1f298))
- 更新文档 ([50aa999](https://github.com/Mereithhh/van-blog/commit/50aa999222b20ce66c26187869ad04db937ef367))

### ✨ Features | 新功能

- 编辑器后台增加清理缓存按钮 [#38](https://github.com/Mereithhh/van-blog/issues/38) ([647bd08](https://github.com/Mereithhh/van-blog/commit/647bd080a332c9718270ca5645355f3b48752368))

## [0.36.0](https://github.com/Mereithhh/van-blog/compare/v0.35.0...v0.36.0) (2022-09-07)

### 🐛 Bug Fixes | Bug 修复

- 多个 more 标记时前台内容截取了指定字符 ([953d354](https://github.com/Mereithhh/van-blog/commit/953d3549ecc7e4b626e18486682b60022c77ab55))

### ✨ Features | 新功能

- 后台编辑器可以选择 emoji 表情啦 ([55b73b1](https://github.com/Mereithhh/van-blog/commit/55b73b12df6a9c4a38fb25c54303260c97fbd2cf))

### ✏️ Documentation | 文档

- 更新文档 ([f678882](https://github.com/Mereithhh/van-blog/commit/f6788823bfdbc9cb93119bdd2d044b107ff5287b))
- 更新表情选择器文档 ([ca5509a](https://github.com/Mereithhh/van-blog/commit/ca5509a5e1575367965fc608d384ce687f26fce8))

## [0.35.0](https://github.com/Mereithhh/van-blog/compare/v0.34.0...v0.35.0) (2022-09-07)

### ✨ Features | 新功能

- 支持高亮块语法（老费劲了） [#37](https://github.com/Mereithhh/van-blog/issues/37) ([ccf6356](https://github.com/Mereithhh/van-blog/commit/ccf6356294c913401c45accc592e75027c2d2e4f))

### ✏️ Documentation | 文档

- 更新文档 ([bcbf7e6](https://github.com/Mereithhh/van-blog/commit/bcbf7e6a0aba4ba9bb1d9a93f5e392f6a7d6b823))
- 更新文档 ([3589feb](https://github.com/Mereithhh/van-blog/commit/3589feb9ddfd766d3d785d1eb9277be3942ecf06))

### 🐛 Bug Fixes | Bug 修复

- mac 下侧边栏卡片溢出滚动下会出现样式问题 ([d452b56](https://github.com/Mereithhh/van-blog/commit/d452b5655af885784840663973987bf5506f086c))
- mac 下长目录无法跟随滚动 & 优化滚动效果 ([9296820](https://github.com/Mereithhh/van-blog/commit/929682098a10b772708545f58eb0abd98ab74855))
- 获取协作者列表报错 ([33a1501](https://github.com/Mereithhh/van-blog/commit/33a15017fa1e3831828888b1e8b3b5724f7ea9c8))
- 返回顶部按钮触发不丝滑 ([8d086f2](https://github.com/Mereithhh/van-blog/commit/8d086f2fd3ecf39f0b53bf49f6d23c8b142158e9))

## [0.34.0](https://github.com/Mereithhh/van-blog/compare/v0.33.0...v0.34.0) (2022-09-06)

### ✏️ Documentation | 文档

- 修改项目主页文档配置 ([a258328](https://github.com/Mereithhh/van-blog/commit/a258328168c61d59943c7c8ac8fcf14fa22f6a9c))
- 修正错别字 ([87fcaed](https://github.com/Mereithhh/van-blog/commit/87fcaedc3d33674c9345d0ec79b9e15b836bc10e))
- 更新文档 ([b7eee7a](https://github.com/Mereithhh/van-blog/commit/b7eee7a16f8b6ad9dc4c49e7fcd22438a818467e))
- 更新文档 ([0f6fd97](https://github.com/Mereithhh/van-blog/commit/0f6fd9743adafccf7e96aba9074066b30a5d2be9))
- 更新文档 ([5310877](https://github.com/Mereithhh/van-blog/commit/5310877bca6b1a012ed5b2fe98a1cfceb80d0c73))

### ✨ Features | 新功能

- 加一个交流群 ([548bee7](https://github.com/Mereithhh/van-blog/commit/548bee778d804d6596358280e6a96fdef3ffe9e0))
- 密码加盐&去除所有明文密码 ([61ab13d](https://github.com/Mereithhh/van-blog/commit/61ab13dc2d4a52f281530c5276cda775b66c2404))

### ♻️ Code Refactoring | 代码重构

- 删除一些前台未使用的引用和代码 ([ac1eb31](https://github.com/Mereithhh/van-blog/commit/ac1eb3199c21570319ff39397349b525e1891bc9))
- 在前台 Layout 组件中抽离一些组件 ([445c00b](https://github.com/Mereithhh/van-blog/commit/445c00bc012c1ec911d27ad5953690cbc469ac81))

## [0.33.0](https://github.com/Mereithhh/van-blog/compare/v0.32.2...v0.33.0) (2022-09-06)

### 🐛 Bug Fixes | Bug 修复

- http 访问后台无法拷贝链接到截切版 ([6292fc4](https://github.com/Mereithhh/van-blog/commit/6292fc414695ae5dacfecacafd92fbb25a4a48dd))

### 👷 Continuous Integration | CI 配置

- 精简镜像体积 [#36](https://github.com/Mereithhh/van-blog/issues/36) ([250c248](https://github.com/Mereithhh/van-blog/commit/250c248e09cd4ff35b549bdc31d8dae927383c78))

### ✏️ Documentation | 文档

- 文档中替换掉 sudo（有时候加上反而起不来） ([e85e2da](https://github.com/Mereithhh/van-blog/commit/e85e2da2de176aceb54025ea247dc75dbf0c8fa9))
- 更新 TODO ([9c592a1](https://github.com/Mereithhh/van-blog/commit/9c592a17ffe671bb35fc88aa49f6c354df640173))
- 更新开发指南 ([5254186](https://github.com/Mereithhh/van-blog/commit/5254186233dc6aaa4f6965a936517a7e107ec755))
- 更新文档 ([470f54d](https://github.com/Mereithhh/van-blog/commit/470f54d1672923fe73837d48e3808f640aaf1453))
- 更新文档 ([3005034](https://github.com/Mereithhh/van-blog/commit/30050345f342876f96549846bcde16940fad59c9))
- 更新文档 ([442557b](https://github.com/Mereithhh/van-blog/commit/442557bd2c58a9c35e85c984242ebe3793e9abd1))

### ✨ Features | 新功能

- 后台创建修改文章或草稿时增加首次使用先创建分类的提示 ([360e2a5](https://github.com/Mereithhh/van-blog/commit/360e2a57431b64ec14e2e5b7d07caf18c93c75da))
- 后端会在库里记录当前版本信息，方便修改数据结构后的清洗 ([781d747](https://github.com/Mereithhh/van-blog/commit/781d7474d570e4451888e293c0d1d4da750c0b1b))
- 文章草稿可指定作者，默认为登录用户 [#31](https://github.com/Mereithhh/van-blog/issues/31) ([e2a23e2](https://github.com/Mereithhh/van-blog/commit/e2a23e29fcbbbf644f2d3fb474c373ce6f59d9f9))
- 编辑器偏好设置（可选择保存按钮点击后的行为）[#35](https://github.com/Mereithhh/van-blog/issues/35) ([d3907e8](https://github.com/Mereithhh/van-blog/commit/d3907e87022f39251ca737a9916dab14b2f71759))
- 编辑器页面增加一个返回按钮 [#35](https://github.com/Mereithhh/van-blog/issues/35) ([987a8cb](https://github.com/Mereithhh/van-blog/commit/987a8cbaf07366070b70807ab0599b7403bad127))

### [0.32.2](https://github.com/Mereithhh/van-blog/compare/v0.32.1...v0.32.2) (2022-09-05)

### ✏️ Documentation | 文档

- 增加 issue 模板 ([9eb44d9](https://github.com/Mereithhh/van-blog/commit/9eb44d9ef0a61dcfa628d39ce47676530aa59004))
- 更新 issues 模板 ([e806f86](https://github.com/Mereithhh/van-blog/commit/e806f86537f687c1bacac419d03d60315291caa3))
- 更新一下 issue 链接 ([1d2f9e4](https://github.com/Mereithhh/van-blog/commit/1d2f9e49ff034776a651681be62ca8a9df67dd06))
- 更新文档 ([3f6d568](https://github.com/Mereithhh/van-blog/commit/3f6d5682c88c6c98ced2a3c692d5a51825957ba2))

### ♻️ Code Refactoring | 代码重构

- 自己实现目录导航组件 [#29](https://github.com/Mereithhh/van-blog/issues/29) ([7648c1e](https://github.com/Mereithhh/van-blog/commit/7648c1e5351b482d252fb061b045b9321e412db9))

### 🐛 Bug Fixes | Bug 修复

- 修复后台布局设置时提示 URL 不合法的问题 [#32](https://github.com/Mereithhh/van-blog/issues/32) ([3b37cbb](https://github.com/Mereithhh/van-blog/commit/3b37cbb518f7d48c83191fa0f71c099e2720e19a))
- 协作者提示没权限发布草稿 [#31](https://github.com/Mereithhh/van-blog/issues/31) ([708d80a](https://github.com/Mereithhh/van-blog/commit/708d80aeff57373b941ec616c5e61ca8dfe9f2ea))

### [0.32.1](https://github.com/Mereithhh/van-blog/compare/v0.32.0...v0.32.1) (2022-09-04)

### ✏️ Documentation | 文档

- 更新 todo ([9a813d8](https://github.com/Mereithhh/van-blog/commit/9a813d8121c3f13f9add1a80580f239af074c09b))
- 更新 tudo ([592b5ef](https://github.com/Mereithhh/van-blog/commit/592b5ef39d289277bcd058f1a920ccb4040f648d))
- 更新文档 ([2efd18f](https://github.com/Mereithhh/van-blog/commit/2efd18f78f5eb192811d554600f9045b95cde4e7))
- 更新文档 ([6794d6a](https://github.com/Mereithhh/van-blog/commit/6794d6a21085e92ba192648f0dd639241a8852f5))

### 🐛 Bug Fixes | Bug 修复

- 增加传输 json 请求体大小限制 ([4a4df3e](https://github.com/Mereithhh/van-blog/commit/4a4df3e4c7880c5d1f013145e9bf53be7d80a1d2))
- 由于网站 URL 填写格式错误导致的老版本升级后容器无限重启[#27](https://github.com/Mereithhh/van-blog/issues/27) ([4c33704](https://github.com/Mereithhh/van-blog/commit/4c337040ca5ee94a25b641d5b2fd7f17ba6ab96c))

### ✨ Features | 新功能

- 首次进入后台时检查 ALLOW_DOMAINS 和 baseUrl，如不合法会弹窗提示 ([15ee5a7](https://github.com/Mereithhh/van-blog/commit/15ee5a733f95fe57d0f513cd1b2f37dcfe309b36))

## [0.32.0](https://github.com/Mereithhh/van-blog/compare/v0.31.0...v0.32.0) (2022-09-04)

### ✏️ Documentation | 文档

- 更新文档 ([9e3fdab](https://github.com/Mereithhh/van-blog/commit/9e3fdab5afea3fcdbeae95452cb93bfa9b5d40d3))

### 🐛 Bug Fixes | Bug 修复

- 评论组件下拉拖动卡顿 ([94f6a3a](https://github.com/Mereithhh/van-blog/commit/94f6a3abadc6277775d2dd375e5bb5b3034f3d87))

### ✨ Features | 新功能

- 优化初始化表单样式&文案 || 优化 rss 订阅生成字段取值 ([43d0c93](https://github.com/Mereithhh/van-blog/commit/43d0c932d592837b6026ff509f8c7809beda13e4))
- 修复 README 中的坏链 ([78f11ef](https://github.com/Mereithhh/van-blog/commit/78f11efe6539a263dfdcf55f7552a5503bd393a9))
- 导航栏的按钮增加 hover 态的文案（title 属性） ([866456a](https://github.com/Mereithhh/van-blog/commit/866456af1ca3fd26627fa1457cec1b1a1cdf303a))
- 支持 RSS 订阅（小尺寸管理员按钮转移到了抽屉导航栏中） ([5e08dbf](https://github.com/Mereithhh/van-blog/commit/5e08dbf723d7c4ebfc0f42a88b20e585b204ad37))

## [0.31.0](https://github.com/Mereithhh/van-blog/compare/v0.30.1...v0.31.0) (2022-09-03)

### ✏️ Documentation | 文档

- 更新 FAQ ([a703299](https://github.com/Mereithhh/van-blog/commit/a70329939b3ab75832e2ce4468189c981a990f3a))
- 更新文档 ([994c603](https://github.com/Mereithhh/van-blog/commit/994c603726422cf9202792c97c114e1bdb4bc39e))
- 更新文档 ([9c8913e](https://github.com/Mereithhh/van-blog/commit/9c8913e187e788cca90fcf94fb1461b5a3b262ea))
- 更新文档 ([14ffe90](https://github.com/Mereithhh/van-blog/commit/14ffe90ae160b777c5ff730897cf9d4c7d59a59a))
- 自定义页面文档 ([a0ea105](https://github.com/Mereithhh/van-blog/commit/a0ea1053e2ee4252bcc0bbd6c325e749bf8ef105))

### ✨ Features | 新功能

- 完整的自定义页面功能 ([c53321a](https://github.com/Mereithhh/van-blog/commit/c53321ab9c50ab60dc2bae852073ca4502b86ea0))
- 更新提示增加清理浏览器缓存提醒 ([ac65bc2](https://github.com/Mereithhh/van-blog/commit/ac65bc20152a3333e3f0e248b9f395c1cf1543cf))
- 演示站不可自定义页面（怕有人搞事情） ([a826d46](https://github.com/Mereithhh/van-blog/commit/a826d46b5fc1c70a63d7080cace6aa05ec3a1239))
- 自定义页面的代码编辑器增加查看按钮 ([7a32948](https://github.com/Mereithhh/van-blog/commit/7a32948c8ce745c1466e556a81679c79c7aa5aca))

### [0.30.1](https://github.com/Mereithhh/van-blog/compare/v0.30.0...v0.30.1) (2022-09-03)

### 🐛 Bug Fixes | Bug 修复

- 更新后无法登录[#26](https://github.com/Mereithhh/van-blog/issues/26) ([040cfe9](https://github.com/Mereithhh/van-blog/commit/040cfe9e42f6ffca711d5755d4dd36046db6293a))

### ✏️ Documentation | 文档

- 更新文档 ([b0dcd7a](https://github.com/Mereithhh/van-blog/commit/b0dcd7af7c04f09a72076c72d362e26fdf5343b8))
- 更新文档 ([ab44644](https://github.com/Mereithhh/van-blog/commit/ab4464427cc5ee357fda9b46138cb320d1628e44))

## [0.30.0](https://github.com/Mereithhh/van-blog/compare/v0.29.4...v0.30.0) (2022-09-03)

### ✏️ Documentation | 文档

- mongo 默认用 v4 版本（某些机器不支持 avx 无法启动大于 v5 版本） ([9b1295c](https://github.com/Mereithhh/van-blog/commit/9b1295cc3c628b019a4fe7e526e07fd08ad9b76a))
- 增加宝塔面板部署教程 ([ebe7628](https://github.com/Mereithhh/van-blog/commit/ebe76287b25974585c65d94b35928207f2ea9b5c))
- 更新文档 ([30dab24](https://github.com/Mereithhh/van-blog/commit/30dab24272f5d8fb2b82b842ac019ec0c8d82601))
- 更新文档 ([e658519](https://github.com/Mereithhh/van-blog/commit/e65851942410043fd8901f50f7acc530cb985ab3))
- 更新文档 ([49725f4](https://github.com/Mereithhh/van-blog/commit/49725f461a411a09d524d0d4016f10cfbedd4820))

### 👷 Continuous Integration | CI 配置

- 完善构建测试镜像脚本 ([cd5dc19](https://github.com/Mereithhh/van-blog/commit/cd5dc199cee15905583cd96705207a29681766d4))

### 🐛 Bug Fixes | Bug 修复

- 分类页面不显示 404 ([519f7fd](https://github.com/Mereithhh/van-blog/commit/519f7fdb21b643bba81a2b225e71815667fb9f58))
- 未设置站点图标时友情链接的站点信息用作者头像或默认头像 ([7b5e8c3](https://github.com/Mereithhh/van-blog/commit/7b5e8c37416c67919e0d4a4dc8bcc83a2ad270f8))

### ✨ Features | 新功能

- 协作者模式：添加指定权限的协作者账号 ([ebc8543](https://github.com/Mereithhh/van-blog/commit/ebc85431323cdb66b7c65bf4ff16e52985da5b9e))
- 后台关于页面增加更新日志跳转链接 ([ac1647c](https://github.com/Mereithhh/van-blog/commit/ac1647cfd239360c4dfd3696e3609aeaca908125))
- 后台可手动触发增量渲染 ([acb8718](https://github.com/Mereithhh/van-blog/commit/acb87184e34262ff2e1207f448214ee799090b8c))
- 增加实验性登录安全策略配置（暂不开放） ([70cf98b](https://github.com/Mereithhh/van-blog/commit/70cf98b92fa706ba32e3f69b8fdbea072fab8fa4))
- 增加是否显示打赏按钮和版权声明的配置项 ([fbfa930](https://github.com/Mereithhh/van-blog/commit/fbfa930fe03280af2241c3c46a7cf6441ee13b38))
- 增加登录失败检测，同一个 ip 连续三次登录失败需要等 60 秒 ([ba6b663](https://github.com/Mereithhh/van-blog/commit/ba6b663dbf6e1b36f1666938bc17de678dd7d7ee))
- 每到整点触发一次 ISR（避免某些情况下自动主题模式闪屏） ([cf367a2](https://github.com/Mereithhh/van-blog/commit/cf367a22dd44ad7e23971d704c838521e65465fe))

### [0.29.4](https://github.com/Mereithhh/van-blog/compare/v0.29.3...v0.29.4) (2022-09-02)

### ✏️ Documentation | 文档

- 更新文档 ([642fc2a](https://github.com/Mereithhh/van-blog/commit/642fc2af8a05d1340a1a7973e93817e071aceaef))

### ✨ Features | 新功能

- 演示站禁止发布草稿 ([5727dfb](https://github.com/Mereithhh/van-blog/commit/5727dfb6077475f3f77db4242ff5ea6e1f007ba9))

### [0.29.3](https://github.com/Mereithhh/van-blog/compare/v0.29.2...v0.29.3) (2022-09-02)

### ✏️ Documentation | 文档

- 修正 readme 错误 ([ef7ea39](https://github.com/Mereithhh/van-blog/commit/ef7ea395c10b6e6f3844daf8d1f8587c2dd22104))
- 更新文档 ([c63fcd6](https://github.com/Mereithhh/van-blog/commit/c63fcd636d8a3b77989d8ce88359d55e55698429))

### ✨ Features | 新功能

- 演示站紧急收缩权限（因为有人放黄色信息） ([8bdb47e](https://github.com/Mereithhh/van-blog/commit/8bdb47e8c0a9641ac44cf4dad7eaeed5c3fc4c2b))

### [0.29.2](https://github.com/Mereithhh/van-blog/compare/v0.29.1...v0.29.2) (2022-09-02)

### ✏️ Documentation | 文档

- 更新文档 ([744f928](https://github.com/Mereithhh/van-blog/commit/744f928c332d2a017b9e08fc2b5f258037eed7a7))
- 更新文档 ([b6f92d7](https://github.com/Mereithhh/van-blog/commit/b6f92d7868898d61bd07b8a0cb71bb994ca12ba7))

### 🐛 Bug Fixes | Bug 修复

- 后台定制化页面帮助文档指向错误 ([b3ce96e](https://github.com/Mereithhh/van-blog/commit/b3ce96e0819f80ff37f604ace1cb2c0ab736b80b))

### [0.29.1](https://github.com/Mereithhh/van-blog/compare/v0.29.0...v0.29.1) (2022-09-02)

### ✏️ Documentation | 文档

- 更新文档 ([4cbe723](https://github.com/Mereithhh/van-blog/commit/4cbe7239d9818da9aab7446305d4faf4efd6ac19))

### ✨ Features | 新功能

- 优化代码块展示样式（超出不会截断而是会横向滚动） ([61e968c](https://github.com/Mereithhh/van-blog/commit/61e968c30e123773e69457fcb5c798bfb57947a2))

## [0.29.0](https://github.com/Mereithhh/van-blog/compare/v0.28.1...v0.29.0) (2022-09-02)

### ✨ Features | 新功能

- 后台和 server 的自定义 CSS、HTML、Script 框架搭建 ([279f018](https://github.com/Mereithhh/van-blog/commit/279f0182251c1ecb7209cafc9f0f5251dfd99b9a))
- 完善定制化功能（可自定义 HTML、CSS、Script） ([889533f](https://github.com/Mereithhh/van-blog/commit/889533f0876cd38633969a8a9f0dd9b9f0a6a61b))

### ✏️ Documentation | 文档

- 完善一下部署教程 ([c2fbeb3](https://github.com/Mereithhh/van-blog/commit/c2fbeb3a853f36418399a35d9e132f24a9da51d8))
- 更新文档 ([bbf0f85](https://github.com/Mereithhh/van-blog/commit/bbf0f850c37dae0a8aa704bb5849e61534ff09ba))
- 更新文档 ([3d2007b](https://github.com/Mereithhh/van-blog/commit/3d2007bd22ab50819632b5be4880d5fb991869f6))
- 更新新功能文档 ([68ef6c1](https://github.com/Mereithhh/van-blog/commit/68ef6c135a4a42c9fee95687b950a8a83e32b3f3))

### [0.28.1](https://github.com/Mereithhh/van-blog/compare/v0.28.0...v0.28.1) (2022-09-02)

### 🚀 Chore | 构建/工程依赖/工具

- **release:** 0.28.1 ([837bf67](https://github.com/Mereithhh/van-blog/commit/837bf67d172eb2cdbc4c83e529e7d217b0f0933f))

### ✏️ Documentation | 文档

- 更新 tudo ([9556b3f](https://github.com/Mereithhh/van-blog/commit/9556b3f32c92198c0f2fae130363a6b4509c9086))
- 更新文档 ([57c4aed](https://github.com/Mereithhh/van-blog/commit/57c4aedf14fe52bf60aaf97a0bf8b350b13baf6c))
- 更新文档 ([3dbb04a](https://github.com/Mereithhh/van-blog/commit/3dbb04a5d12fdd2e97c54c372b5bea202b3c074b))
- 更新文档 ([3b5cb58](https://github.com/Mereithhh/van-blog/commit/3b5cb58b5901ce9ce941cdcb5caab049f3096a97))

### ⏪ Revert | 回退

- 多改一个 bug 再发版 ([d9c322b](https://github.com/Mereithhh/van-blog/commit/d9c322b2512d639d9c776f240e4af414a92d405b))

### 🐛 Bug Fixes | Bug 修复

- 建站时间不够精确 [#21](https://github.com/Mereithhh/van-blog/issues/21) ([1098765](https://github.com/Mereithhh/van-blog/commit/1098765480384c8d664f67fd3b5a7dfb4a0b0fc7))
- 隐藏文章会出现在其他文章的上一篇/下一篇 [#19](https://github.com/Mereithhh/van-blog/issues/19) ([9033e4a](https://github.com/Mereithhh/van-blog/commit/9033e4a2bed0f296a90b71c96fe8494f3a490c36))

## [0.28.0](https://github.com/Mereithhh/van-blog/compare/v0.27.3...v0.28.0) (2022-09-01)

### ✏️ Documentation | 文档

- update todo’ ([b32d7ce](https://github.com/Mereithhh/van-blog/commit/b32d7ceb430e54704e5963964a9918e80f0fe115))
- 增加裸机部署指南 ([dcdc94e](https://github.com/Mereithhh/van-blog/commit/dcdc94e86be63b5bc70945d0b36bde463980ff7f))
- 更新文档 ([2abe492](https://github.com/Mereithhh/van-blog/commit/2abe492e5dda2aace2196ed54df43a01c91de613))
- 更新文档 ([b00597f](https://github.com/Mereithhh/van-blog/commit/b00597fbe4519f7090f7d7f04bfd59d69ed7501d))
- 更新文档 ([a58a7a9](https://github.com/Mereithhh/van-blog/commit/a58a7a97f5ea9c3fd3e3960e4b85a1167ebe2ab3))
- 部署说明增加 sudo; ([13bcbc2](https://github.com/Mereithhh/van-blog/commit/13bcbc2e7e378107f869171f35bc4dd97a5801f5))

### ✨ Features | 新功能

- 创建或修改文章/草稿时可指定创建时间 [#18](https://github.com/Mereithhh/van-blog/issues/18) ([f886d4b](https://github.com/Mereithhh/van-blog/commit/f886d4be1d829b915cd3260c2bb585d3a7a5303c))
- 编辑器页面发布草稿后跳转到文章管理页面 ([f1fb898](https://github.com/Mereithhh/van-blog/commit/f1fb898a568b9282b922cabc87da11cc804c49af))

### 🐛 Bug Fixes | Bug 修复

- 文章下方本文链接携带了锚点 [#18](https://github.com/Mereithhh/van-blog/issues/18) ([279e0fe](https://github.com/Mereithhh/van-blog/commit/279e0fe6b7cbd7fd854aa0ecffc210395d300d1e))

### [0.27.3](https://github.com/Mereithhh/van-blog/compare/v0.27.2...v0.27.3) (2022-09-01)

### ✏️ Documentation | 文档

- 更新文档 ([9a5ec77](https://github.com/Mereithhh/van-blog/commit/9a5ec77ef6946f3042097fa2f4fca2c81b78b39d))
- 更新文档 ([b6fd212](https://github.com/Mereithhh/van-blog/commit/b6fd212acb8964fc7d29badb9999df68c84d3d27))
- 更新文档 ([1ce9efc](https://github.com/Mereithhh/van-blog/commit/1ce9efc05222100529315c8eafb7d60738fef383))

### ✨ Features | 新功能

- 当在后台点击访问隐藏文章时，出现人性化提示[#13](https://github.com/Mereithhh/van-blog/issues/13) ([cbf2a56](https://github.com/Mereithhh/van-blog/commit/cbf2a56ebee3cb3d686bac4fbe5f293d4332c3fa))

### 🐛 Bug Fixes | Bug 修复

- 放宽过滤 waline 错误日志的条件 ([57dfbb3](https://github.com/Mereithhh/van-blog/commit/57dfbb389770d33ac7f0c6c3dbc8bac52df090d8))

### [0.27.2](https://github.com/Mereithhh/van-blog/compare/v0.27.1...v0.27.2) (2022-09-01)

### ✏️ Documentation | 文档

- 更新文档 ([c5f919b](https://github.com/Mereithhh/van-blog/commit/c5f919b4d319d85f868ed2848a04eedf08049650))

### ✨ Features | 新功能

- 增加是否可通过 URL 打开隐藏文章配置项[#13](https://github.com/Mereithhh/van-blog/issues/13) ([c77e233](https://github.com/Mereithhh/van-blog/commit/c77e233bc4807d577035a6dd7ccbf7e5c9ee9880))
- 文章/分类管理可以搜索标签（标签太多了选择不过来） ([f4aa62b](https://github.com/Mereithhh/van-blog/commit/f4aa62bcc4b0bcc4461c08a562e763ecd1b36b7a))
- 标签管理页面可以搜索/筛选标签 ([cb9e079](https://github.com/Mereithhh/van-blog/commit/cb9e0797e3dadac78a3d83712ce3551a45e93b10))

### [0.27.1](https://github.com/Mereithhh/van-blog/compare/v0.27.0...v0.27.1) (2022-09-01)

### 🐛 Bug Fixes | Bug 修复

- 目录内联代码块被错误识别 [#12](https://github.com/Mereithhh/van-blog/issues/12) ([8cd4f56](https://github.com/Mereithhh/van-blog/commit/8cd4f5675fbcb7d82749f3d004d33f69bec98a5a))
- 隐藏页面输入地址依然可以打开&增加其他一些 404 页面 [#13](https://github.com/Mereithhh/van-blog/issues/13) ([51e58e7](https://github.com/Mereithhh/van-blog/commit/51e58e7729dec7611c8155aa44bd8365b08bfc44))

### 🚀 Chore | 构建/工程依赖/工具

- **release:** 0.27.1 ([823c445](https://github.com/Mereithhh/van-blog/commit/823c445247d51a9c1fb35c9ba937047807b36b6b))

### ⏪ Revert | 回退

- 新加个功能再发版 ([ba89ee1](https://github.com/Mereithhh/van-blog/commit/ba89ee115ed5f1305612371e8cbb79ed085b5888))

### ✨ Features | 新功能

- demo 站无法查看 waline 配置 ([211137c](https://github.com/Mereithhh/van-blog/commit/211137cecdd0b9db3c0960cd6d1646ec7243f912))
- 演示站禁止删除文章 ([0ca1bb2](https://github.com/Mereithhh/van-blog/commit/0ca1bb2b7fbc40540e51501180606abf040c26ba))

### ✏️ Documentation | 文档

- revert changelog ([03633ab](https://github.com/Mereithhh/van-blog/commit/03633ab261990fa3744feea170c4bd9a747c9a92))
- 更新文档 ([881fe87](https://github.com/Mereithhh/van-blog/commit/881fe876882c5f65515fe810713d55481d10455f))
- 更新文档 ([717f026](https://github.com/Mereithhh/van-blog/commit/717f026e0f4ab057d3bdf720a283238a5b469ef6))

## [0.27.0](https://github.com/Mereithhh/van-blog/compare/v0.26.1...v0.27.0) (2022-09-01)

### ⚡ Performance Improvements | 性能优化

- 优化滚动监听，减少可能的性能问题 ([df5d308](https://github.com/Mereithhh/van-blog/commit/df5d308241af88548c0ca0491af13a2f6bc2a001))
- 去掉 jsx 里面的随机 key ([29fdb23](https://github.com/Mereithhh/van-blog/commit/29fdb2385635101102ce1f098690e4509137c99b))

### ✨ Features | 新功能

- 后台系统设置页面统一卡片样式 ([d52e5c7](https://github.com/Mereithhh/van-blog/commit/d52e5c79eee908a8365c66a0eef68a906cdf831f))
- 增加 robots 和 viewport 标签 ([c5f5c6f](https://github.com/Mereithhh/van-blog/commit/c5f5c6fe7c14b0396619755d59176a72c6479a88))
- 更新站点重启 waline 服务 ([2c982b0](https://github.com/Mereithhh/van-blog/commit/2c982b0a3ae33fe84f36ed94136ffd9654413edb))
- 编辑器页面删除文章/草稿 ([ec13d53](https://github.com/Mereithhh/van-blog/commit/ec13d53287e8dcc5f79800bd0348262dd9cefa41))
- 评论支持邮件通知&webhook 了 ([17b50c6](https://github.com/Mereithhh/van-blog/commit/17b50c62927a7fa0c3d8a22c0c589d2011c5a635))

### 🐛 Bug Fixes | Bug 修复

- viewport warning ([17ffa74](https://github.com/Mereithhh/van-blog/commit/17ffa74ca56f51a11c6ce1c77a1e9834fdac2bef))
- 增加一点前台滚动监听防抖时间 ([db311ae](https://github.com/Mereithhh/van-blog/commit/db311aee8dea4444994d89d60a34e24168cfbecc))
- 无法新建捐赠条目 ([1cd9f2a](https://github.com/Mereithhh/van-blog/commit/1cd9f2aa2c2c23bc4bf771da4a7c8de3915890b4))
- 由于愚蠢的单词拼写问题导致的更新时间错误 ([0dff565](https://github.com/Mereithhh/van-blog/commit/0dff5658b54fc319186fdd107bef302a3d648ea6))

### ✏️ Documentation | 文档

- 更新 todo ([a4700af](https://github.com/Mereithhh/van-blog/commit/a4700afaff6765673aaf975f84c6e2022d866081))
- 更新 todo ([fde68ab](https://github.com/Mereithhh/van-blog/commit/fde68ab8018df784aa593594739d8dc54761dd0f))
- 更新文档 ([8e92532](https://github.com/Mereithhh/van-blog/commit/8e925321775fdb2e940c9da48ae32cbab461e05e))
- 更新文档 ([c5c297b](https://github.com/Mereithhh/van-blog/commit/c5c297b03211ac0baab4ad9f5acc2855e5c86658))
- 更新新功能文档 ([3330a92](https://github.com/Mereithhh/van-blog/commit/3330a92877da502b69f57c1d1a04dd7cb9ccc34b))

### [0.26.1](https://github.com/Mereithhh/van-blog/compare/v0.26.0...v0.26.1) (2022-08-31)

### 👷 Continuous Integration | CI 配置

- 修复同步阿里云的脚本错误 ([7ca0bf3](https://github.com/Mereithhh/van-blog/commit/7ca0bf3df1bc57069bd30bcb38c1ab6e4ff8d6fa))
- 增加本地发布脚本和 workflow（通过 act） ([f4a3819](https://github.com/Mereithhh/van-blog/commit/f4a3819b00f1a6fafd9f54f8e51087da30cfdd38))

### 🐛 Bug Fixes | Bug 修复

- 优化导出图片文案 ([12ab4ca](https://github.com/Mereithhh/van-blog/commit/12ab4ca2a3f43c742579b6c54a33af3b4631af19))

### ✨ Features | 新功能

- 优化备份页面文案 ([62ae234](https://github.com/Mereithhh/van-blog/commit/62ae234924776658a25a51d3fbfafca8a5fa233f))
- 支持打包导出本地图床全部文件 ([46ce000](https://github.com/Mereithhh/van-blog/commit/46ce0003648f84dcf5a2cebd5b9cce11868cc49c))

### ✏️ Documentation | 文档

- 修复项目主页导航栏坏链 ([2e342b6](https://github.com/Mereithhh/van-blog/commit/2e342b6940d3440a6cb615ed4737e997fcff1b05))
- 更新文档 ([d553905](https://github.com/Mereithhh/van-blog/commit/d553905635ee557ef1e17ff44f9d722bb451d515))
- 更新文档 ([ef4c55d](https://github.com/Mereithhh/van-blog/commit/ef4c55d2932424f5ae586d96f202a4918a199b7f))
- 更新新功能文档 ([28bc10d](https://github.com/Mereithhh/van-blog/commit/28bc10dfd5ff75ec967a8d54a3562aca7b15801e))

## [0.26.0](https://github.com/Mereithhh/van-blog/compare/v0.25.5...v0.26.0) (2022-08-31)

### ✨ Features | 新功能

- 文章管理和草稿管理上方工具栏中，标签可以通过下拉选择进行筛选 ([274591a](https://github.com/Mereithhh/van-blog/commit/274591a2ff914ef9e34ceeec52a6ed14426e0fed))
- 新增关于页面可配置是否显示打赏按钮配置项 ([f51ec7c](https://github.com/Mereithhh/van-blog/commit/f51ec7c13d00ed32b00524cf088f4dcac1af269e))
- 标签和分类管理可以快速跳转到相应的前台页面” ([8b7ea89](https://github.com/Mereithhh/van-blog/commit/8b7ea8905d669d33fc106867ffd605be53808b6f))
- 标签管理：可批量重命名或删除标签了 ([b0946f6](https://github.com/Mereithhh/van-blog/commit/b0946f604df22a8047a9543fc53c786372078bed))
- 演示站禁止修改捐赠信息&联系方式&导航配置&友情链接 ([063ce9c](https://github.com/Mereithhh/van-blog/commit/063ce9cc93f50e0d04f35d74009adeeac8a14c43))
- 编辑器实时保存到本地缓存并恢复 ([6c638db](https://github.com/Mereithhh/van-blog/commit/6c638db90371add47c6bf829772e8f7a109b11b2))
- 编辑器页面增加快速查看前台页面入口 ([42631db](https://github.com/Mereithhh/van-blog/commit/42631db754c962fb89177fee14febc99010009ad))
- 评论管理加载态 ([6b8c80e](https://github.com/Mereithhh/van-blog/commit/6b8c80ef581c5aba5e1e9e6a551a466053374444))

### 🐛 Bug Fixes | Bug 修复

- 上传站点图标透明度消失 ([a76e720](https://github.com/Mereithhh/van-blog/commit/a76e720db2eace7a4bbc726ae6142af0d8550f93))
- 关于页面默认隐藏打赏按钮和现在逻辑保持一致 ([2a9b048](https://github.com/Mereithhh/van-blog/commit/2a9b0489665ac3ae4dffd79f1de6e2dd783c3261))
- 前台略微加深滚动条颜色 ([fb9608d](https://github.com/Mereithhh/van-blog/commit/fb9608dd5daa0d6bc946b9f8a4f6b7c371ce4040))
- 前台评论无法登录 ([9ea66c8](https://github.com/Mereithhh/van-blog/commit/9ea66c810d15b31f7595715515af44921c6956b0))
- 后台侧边栏主题切换按钮点击有效区域过小 ([71276e3](https://github.com/Mereithhh/van-blog/commit/71276e378d1d496b447845d6513177ab3d45971e))
- 后台滚动条样式不美观&编辑器页面不该出现的滚动条 ([a1d8530](https://github.com/Mereithhh/van-blog/commit/a1d853020cdd67dd952d167b5e6902738a299b00))
- 调整前台滚动条宽度&样式 ([4f17152](https://github.com/Mereithhh/van-blog/commit/4f171527117d09ca8ce8d006f03ceb0cca3401b2))

### ✏️ Documentation | 文档

- 增加一个打赏二维码 😘 ([81319e0](https://github.com/Mereithhh/van-blog/commit/81319e0b5ef8f15a7bf7a650847060417e69332e))
- 更新截图 ([16257ba](https://github.com/Mereithhh/van-blog/commit/16257ba7b55dc3e47e3571dbc416cc2c7af671ad))
- 更新文档 ([9cb9ce2](https://github.com/Mereithhh/van-blog/commit/9cb9ce2e62e09d24e23e1f658f7f52a341908aec))
- 更新文档 ([a0a63e0](https://github.com/Mereithhh/van-blog/commit/a0a63e0543d3f44f25094ac9bccbfa8615a0bbbe))
- 更新文档 ([9dd7cd6](https://github.com/Mereithhh/van-blog/commit/9dd7cd6f4ba1c90469fad5d2ecab8c53aba2c788))
- 更新文档 ([d121b56](https://github.com/Mereithhh/van-blog/commit/d121b569cb305f2d02ce6adc486484d0ad719618))
- 更新文档 ([1e16bba](https://github.com/Mereithhh/van-blog/commit/1e16bba5d077298972a55a76c9b772e268883c96))
- 更新文档 ([d74e91f](https://github.com/Mereithhh/van-blog/commit/d74e91f7797b61e422ecd42e4ac4e1fd189ae7b5))
- 更新新版本对应文档 ([4cb73d3](https://github.com/Mereithhh/van-blog/commit/4cb73d3c44bca946174db8748e10908541ba5d91))
- 调整图片大小 ([f5beb5b](https://github.com/Mereithhh/van-blog/commit/f5beb5b1e58d4d7ada3364146b8db93785eaa363))

### 👷 Continuous Integration | CI 配置

- 延长 yarn 的超时时间 ([6c89be6](https://github.com/Mereithhh/van-blog/commit/6c89be6365bc851bbec120fc2adfdc4c507a30e2))

## [0.25.0](https://github.com/Mereithhh/van-blog/compare/v0.24.0...v0.25.0) (2022-08-30)

### ♻️ Code Refactoring | 代码重构

- 后台抽离修改信息弹窗组件 ([3838c48](https://github.com/Mereithhh/van-blog/commit/3838c48877ba0f76480d874847dece91ec424790))

### ✨ Features | 新功能

- 文章管理页面支持导出文章和修改文章信息 ([f8b820b](https://github.com/Mereithhh/van-blog/commit/f8b820b8af852f247a18552f962db1dd6b87886a))
- 编辑器页面从文件导入内容 ([be73e60](https://github.com/Mereithhh/van-blog/commit/be73e6015cff71d357dfdf5b87cd85f950c0493d))
- 编辑器页面可导出文章 ([32fd874](https://github.com/Mereithhh/van-blog/commit/32fd874b6a9287f27b91e9effdb7db9ecce8f771))
- 草稿管理页面支持导出草稿和修改草稿信息 ([2dd5245](https://github.com/Mereithhh/van-blog/commit/2dd5245814bc852fdd12a53c6a8a395f84a3fa85))
- 设置前台用户默认主题模式 ([582df60](https://github.com/Mereithhh/van-blog/commit/582df602112b5c0c80f55eda6d53dd799f233418))

### 🐛 Bug Fixes | Bug 修复

- 前台主题切换按钮显示和实际主题不一致 ([4a2f943](https://github.com/Mereithhh/van-blog/commit/4a2f943bee92228c1022d8cdc0b60e50396549cf))

### ⚡ Performance Improvements | 性能优化

- 优化一下主题初始化逻辑 ([bf12394](https://github.com/Mereithhh/van-blog/commit/bf1239466c92242597716a5c085b514d61021214))

### ✏️ Documentation | 文档

- 换一个好看点的 star history 图 ([c4c8f44](https://github.com/Mereithhh/van-blog/commit/c4c8f443f4c21f0f1d600616767bc79d8be27bf8))
- 更新 TODO ([66e5796](https://github.com/Mereithhh/van-blog/commit/66e5796c6b5de08f9e54496efc253e53ffb68ade))
- 更新文档 ([842c005](https://github.com/Mereithhh/van-blog/commit/842c00570d9a8b0814ddc62552fb0f83f79fe9cb))
- 更新文档 ([75c8b0a](https://github.com/Mereithhh/van-blog/commit/75c8b0a4296c2c34fc96e26ee1c4f5abf1817b4b))
- 更新文档 ([f637216](https://github.com/Mereithhh/van-blog/commit/f637216ea4525b46eeef02e3320f507680e35910))
- 更新文档截图和描述 ([1961aad](https://github.com/Mereithhh/van-blog/commit/1961aadeafa308c1a6e1f03fa9adc794f35d4828))

### 🚀 Chore | 构建/工程依赖/工具

- **release:** 0.25.0 ([5158055](https://github.com/Mereithhh/van-blog/commit/5158055d7882341f2ca2dedffe2e62a3ba912e57))
- 修复生成 note 脚本错误 ([92bf19f](https://github.com/Mereithhh/van-blog/commit/92bf19f22f5e8edf51ad25ec6a1063e8c2ce488a))
- 修正 releaseNote 脚本错误 ([570a527](https://github.com/Mereithhh/van-blog/commit/570a527de33e839363bf216caf2445df18708f45))

### ⏪ Revert | 回退

- 因为 note 脚本错误回退版本再重发 ([af0fa06](https://github.com/Mereithhh/van-blog/commit/af0fa06a42e957b83bded98d9982f77217d22903))

## [0.24.0](https://github.com/Mereithhh/van-blog/compare/v0.23.4...v0.24.0) (2022-08-29)

### 🚀 Chore | 构建/工程依赖/工具

- 发版自动生成 releaseNote ([78bac47](https://github.com/Mereithhh/van-blog/commit/78bac4735e59067f84c6c83137d6db23592e10d7))

### ⚡ Performance Improvements | 性能优化

- 内置提示图片由外链改成项目自带 ([bb4422a](https://github.com/Mereithhh/van-blog/commit/bb4422a14c418a537131db8ba593c157ea25e245))

### 🐛 Bug Fixes | Bug 修复

- Google Analytics 配置好不生效 ([4feb16b](https://github.com/Mereithhh/van-blog/commit/4feb16be48b98d10eb86e922841db414486994a6))
- 前台目录关闭自动加序号&前台目录锚点以文字为准 ([dac811c](https://github.com/Mereithhh/van-blog/commit/dac811c1bba383304203c849ff2a8fdbff469598))

### ✨ Features | 新功能

- 从 md 文件导入创建文章 ([2cbd974](https://github.com/Mereithhh/van-blog/commit/2cbd97458cfaa6b0ca0ec8ef57d0b9c40e6995a1))
- 从 md 文件导入创建草稿 ([297bc4f](https://github.com/Mereithhh/van-blog/commit/297bc4f7e809694fd679736abd4aac0e028bcdf5))
- 侧边栏的 API 文档和项目文档挪到关于卡片 ([a3324a8](https://github.com/Mereithhh/van-blog/commit/a3324a83633fc0b387997470030672167d30159e))
- 前台目录锚点使用标题 ([4052701](https://github.com/Mereithhh/van-blog/commit/40527019d2c0c36f11383a7cc155b65c2b9ec145))
- 去掉 footer ([0c8f4d1](https://github.com/Mereithhh/van-blog/commit/0c8f4d18db726fc10568bdaa86f55fab81716bc3))
- 后台关于页面增加 loading ([2e5b472](https://github.com/Mereithhh/van-blog/commit/2e5b47208d5981ad7c2e770fe73c6eff762ce7a7))
- 后台系统设置增加 关于 tab ([2d62ee1](https://github.com/Mereithhh/van-blog/commit/2d62ee1c3a729702c0814da61d5b7011827de2ba))

### ✏️ Documentation | 文档

- 为新功能写文档 ([3ce0acc](https://github.com/Mereithhh/van-blog/commit/3ce0acc63be111119911ff6ac44cb1772952789b))
- 更新文档 ([7d1f1d3](https://github.com/Mereithhh/van-blog/commit/7d1f1d3bfab46aaff92f432b0aecb4c312489234))

### [0.23.4](https://github.com/Mereithhh/van-blog/compare/v0.23.3...v0.23.4) (2022-08-29)

### ✏️ Documentation | 文档

- 更新文档 ([9ffe4ea](https://github.com/Mereithhh/van-blog/commit/9ffe4ea2f8b2cb94b0b835f7d676bbd41e22a55e))

### 🐛 Bug Fixes | Bug 修复

- 草稿中用剪切板一键上传图片后失焦并闪一下 ([6b44e80](https://github.com/Mereithhh/van-blog/commit/6b44e80e8f90ea983aac7791f2532888eb56e39f))

### ✨ Features | 新功能

- 编辑器页面保存按钮和操作并列 ([241a48e](https://github.com/Mereithhh/van-blog/commit/241a48e223574a126b2f48ca3da39cb70ede65c2))

### [0.23.3](https://github.com/Mereithhh/van-blog/compare/v0.23.2...v0.23.3) (2022-08-29)

### ✏️ Documentation | 文档

- 更新 api 文档描述 ([291ba73](https://github.com/Mereithhh/van-blog/commit/291ba73a90b76feb1a171c86e1d432d0934eb24c))
- 更新文档 ([200b037](https://github.com/Mereithhh/van-blog/commit/200b03799cc6ca4a37d27b2685ff607da9c0d46d))
- 更新文档 ([6704e44](https://github.com/Mereithhh/van-blog/commit/6704e446c775f3471b25f3ce59fac80de6237303))
- 补充截图 ([e521615](https://github.com/Mereithhh/van-blog/commit/e521615f9e0610436aea0b1cd955e64bb6721d80))

### 🐛 Bug Fixes | Bug 修复

- 有序列表与无序列表的前后台展示不一致 ([079f66a](https://github.com/Mereithhh/van-blog/commit/079f66a981e6091917948adeefa93c4e14b08ddc))

### [0.23.2](https://github.com/Mereithhh/van-blog/compare/v0.23.1...v0.23.2) (2022-08-29)

### ✏️ Documentation | 文档

- 更新文档 ([ba40cbc](https://github.com/Mereithhh/van-blog/commit/ba40cbcdfdc2a006b04d53772ec61ddf37b01f2a))

### 🐛 Bug Fixes | Bug 修复

- 后台图片管理右键无法下载图片 ([28a1bc4](https://github.com/Mereithhh/van-blog/commit/28a1bc4366555182d8a864b1f6948012ef4fe1e1))

### [0.23.1](https://github.com/Mereithhh/van-blog/compare/v0.23.0...v0.23.1) (2022-08-29)

### ✏️ Documentation | 文档

- 更新文档 ([f75a3bc](https://github.com/Mereithhh/van-blog/commit/f75a3bc6918e162f7c9fcea6a2085ea88869d454))

### ✨ Features | 新功能

- 完善缺少 more 标记的提示并增加截图 ([a8f3d10](https://github.com/Mereithhh/van-blog/commit/a8f3d106ceb5b7c9e9d211bfd73a2c2e6638c50e))

## [0.23.0](https://github.com/Mereithhh/van-blog/compare/v0.22.1...v0.23.0) (2022-08-29)

### ✨ Features | 新功能

- 优化编辑器页面结构，更多位置留给编辑器本身 ([8212ade](https://github.com/Mereithhh/van-blog/commit/8212ade8964a446e588ad299763d3389259806de))
- 后台优化滚动条样式 ([17609e7](https://github.com/Mereithhh/van-blog/commit/17609e756e86c2268522db5bae9973b5d9cea29d))
- 移动端编辑器页面文章标题过长的显示优化 ([3b45059](https://github.com/Mereithhh/van-blog/commit/3b4505953198b7536d6df50f4aa69a7100c1f283))
- 进入编辑器默认收起侧边栏 ([63ed7c4](https://github.com/Mereithhh/van-blog/commit/63ed7c471597918d995fc6ef6323ce4ece3f7d72))

### ✏️ Documentation | 文档

- 更新文档 ([ad9f4ee](https://github.com/Mereithhh/van-blog/commit/ad9f4eeea4b1879468b7701dacb59ed5b2327d74))
- 更新文档 ([891f423](https://github.com/Mereithhh/van-blog/commit/891f42366044dd55989cf392a9a163efce7eb2e4))
- 更新编辑器截图 ([18ec43d](https://github.com/Mereithhh/van-blog/commit/18ec43d5e44f47bac0c490262d87938dd3413edc))
- 补充常见问题 ([6b8cf69](https://github.com/Mereithhh/van-blog/commit/6b8cf69e5a512ae0e5a8e06ad4330a75a9bbc71c))

### [0.22.1](https://github.com/Mereithhh/van-blog/compare/v0.22.0...v0.22.1) (2022-08-28)

### 🚀 Chore | 构建/工程依赖/工具

- 完善同步镜像脚本 ([85d4216](https://github.com/Mereithhh/van-blog/commit/85d4216bc3f89df3db197375727aeaadd6778a19))

### 🐛 Bug Fixes | Bug 修复

- 编辑器黑暗模式 toolbar 颜色不对 ([3ad0988](https://github.com/Mereithhh/van-blog/commit/3ad09888bf820246d8eef43bfbeaeec5a728d979))
- 设置站点图标失效 ([89dfdd6](https://github.com/Mereithhh/van-blog/commit/89dfdd600dacea976e64bf0d43ce43c3c85d5d71))

### ✏️ Documentation | 文档

- update todo ([0ef3075](https://github.com/Mereithhh/van-blog/commit/0ef3075c3eb211c373977671ba5d8419c78697c6))
- 修正文档错误 ([7984c94](https://github.com/Mereithhh/van-blog/commit/7984c9462efd5b76dd55353e647eca267bb1f51a))
- 更新文档 ([f88d643](https://github.com/Mereithhh/van-blog/commit/f88d643bb67e0234320c18e4db9a13fd234cc613))
- 更新文档 ([01066a5](https://github.com/Mereithhh/van-blog/commit/01066a5801a7a16c59b436f26c0e588c1a9e97f1))
- 更新文档 ([e2f29bf](https://github.com/Mereithhh/van-blog/commit/e2f29bfc7babad39826f08a755f6f29e31473d26))
- 补充 faq ([a225ba0](https://github.com/Mereithhh/van-blog/commit/a225ba0de6aee4436958f9f7314f997bec170b80))

## [0.22.0](https://github.com/Mereithhh/van-blog/compare/v0.21.1...v0.22.0) (2022-08-28)

### 🚀 Chore | 构建/工程依赖/工具

- 手动发版文档 ([e7f4b4c](https://github.com/Mereithhh/van-blog/commit/e7f4b4c2efac8df6f34a11d822869424196fe0fd))

### ✨ Features | 新功能

- mermaid 图片全屏预览 ([8576e40](https://github.com/Mereithhh/van-blog/commit/8576e408335fc96711de21212e8afddd2b309321))
- 后台编辑器改为 bytemd，性能更好支持更多语法 ([e72caf0](https://github.com/Mereithhh/van-blog/commit/e72caf0d137611766e9f37d1ed2f31abf57382c5))
- 完整支持 mermaid 图表语法 ([846cc19](https://github.com/Mereithhh/van-blog/commit/846cc1994e5f8b4bb4c5fdbb977e6f7a4d765630))

### 🐛 Bug Fixes | Bug 修复

- 修复缺少 mermaid 类型导致的构建报错 ([16e33a0](https://github.com/Mereithhh/van-blog/commit/16e33a04e9e9893919cc1b222cdab5d3e5f7c996))

### ✏️ Documentation | 文档

- 修正文档中的反代配置 ([3d12b20](https://github.com/Mereithhh/van-blog/commit/3d12b20b965e2669514c05b8b446b87c963f4ddb))
- 手动修改一下 changelog ([3f67ffd](https://github.com/Mereithhh/van-blog/commit/3f67ffd41718dc367161a40f00f0c6119bb46d24))
- 更新文档 ([3592378](https://github.com/Mereithhh/van-blog/commit/3592378750afc8421eaadb21c16f660bf41ba617))
- 更新文档 ([e4426a5](https://github.com/Mereithhh/van-blog/commit/e4426a506414ce793ebb8bb1bc5c2ed3e034b131))
- 更新文档 ([80f5d58](https://github.com/Mereithhh/van-blog/commit/80f5d58c1f032949aa6dd3f6b424937ab8e89649))
- 补充一下常见问题 ([219e638](https://github.com/Mereithhh/van-blog/commit/219e6389e8b80357e7d186f7b5936e8b15763213))

### [0.21.1](https://github.com/Mereithhh/van-blog/compare/v0.21.0...v0.21.1) (2022-08-27)

### ✨ Features | 新功能

- 外置图床配置中帮助链接指向项目文档 ([176e9f5](https://github.com/Mereithhh/van-blog/commit/176e9f53d070850c5be3ce1180c82e4e1e3998d1))

### 🐛 Bug Fixes | Bug 修复

- 修复了隔了多层反代无法获取真实 ip 问题 ([feee634](https://github.com/Mereithhh/van-blog/commit/feee634a8456815d4e297b1046f03d0e93944a26))

### 👷 Continuous Integration | CI 配置

- 加一个同步到阿里云的脚本 ([25acdbe](https://github.com/Mereithhh/van-blog/commit/25acdbeb6b4a0f46443dbaf974941d439852332b))
- 文档切换到 dockerhub ([92db955](https://github.com/Mereithhh/van-blog/commit/92db95569560190e02317dba4179ca4374dcfc2a))
- 调试测试流水线&整理文件 ([feee634](https://github.com/Mereithhh/van-blog/commit/feee634a8456815d4e297b1046f03d0e93944a26))

### ✏️ Documentation | 文档

- 修改图片宽度 ([e9ba718](https://github.com/Mereithhh/van-blog/commit/e9ba718acb6f69a7e41e4ed381d58261210abd53))
- 修改大小写 ([26904b4](https://github.com/Mereithhh/van-blog/commit/26904b45ae41c67be76b281543898b18c7eaf274))
- 修改措辞 ([1ce0a53](https://github.com/Mereithhh/van-blog/commit/1ce0a53d97792489e0a74f4dd68cdb071ea24414))
- 大小写 ([e1401c9](https://github.com/Mereithhh/van-blog/commit/e1401c985a6f70291bae25e9e0dccba977d0155b))
- 更新文档 ([3bccc55](https://github.com/Mereithhh/van-blog/commit/3bccc55228161f443b55da3b316aae4da8cba961))
- 更新文档 ([2d2e330](https://github.com/Mereithhh/van-blog/commit/2d2e3302b9365a13bcb9ea694eac13c47a08db9b))
- 更新文档 ([494a6d7](https://github.com/Mereithhh/van-blog/commit/494a6d73a2abe9d7d84fd552ed12ce3cb5484f74))
- 更新文档 ([c052ad2](https://github.com/Mereithhh/van-blog/commit/c052ad2ee8b31483bd32eb3b1d511bf2ad49e2c6))
- 更新文档 ([426fd31](https://github.com/Mereithhh/van-blog/commit/426fd3131a7e36021e5a1b983ee01f0953aa0efa))
- 更新文档&logo ([3876b2c](https://github.com/Mereithhh/van-blog/commit/3876b2ccdcb2fb14780c1b082965af56b0197622))
- 补充 LightHouse 评分截图 ([48e866d](https://github.com/Mereithhh/van-blog/commit/48e866da05825fe642eca93593ad2e27e2f60e54))

## [0.21.0](https://github.com/Mereithhh/van-blog/compare/v0.20.8...v0.21.0) (2022-08-27)

### ✨ Features | 新功能

- 本地图床上传网站图标时自动防止到根目录 ([5ac6f82](https://github.com/Mereithhh/van-blog/commit/5ac6f822d865f73eee244557daacc0c192d4786b))

### ⏪ Revert | 回退

- actions 运行失败 ([23c7726](https://github.com/Mereithhh/van-blog/commit/23c7726db89e148307f15bfd6e35df51fc492097))

### 👷 Continuous Integration | CI 配置

- Caddy 增加默认 valume ([c2f0d30](https://github.com/Mereithhh/van-blog/commit/c2f0d30c0de6ebfebe9cd3eee59465bd90b44fe8))
- 因为 runner 推阿里云镜像超时，改用 selfhost runner ([8c743b3](https://github.com/Mereithhh/van-blog/commit/8c743b3d40bf186b1500a0ea218217437e41e793))
- 增加测试流水线 ([9ab30d6](https://github.com/Mereithhh/van-blog/commit/9ab30d6b0bf5231413fec52fcd11107cec62226b))
- 支持 arm64 ([f0fa4f4](https://github.com/Mereithhh/van-blog/commit/f0fa4f4bf45997b725e55c7739684635b28172ca))

### ✏️ Documentation | 文档

- 更新文档 ([eb8682f](https://github.com/Mereithhh/van-blog/commit/eb8682ff658a011220cd8ff6fc617f8d14994eb5))
- 更新文档 ([6b4bb75](https://github.com/Mereithhh/van-blog/commit/6b4bb7522135dc5e90f42681982c20dde60e4fcd))
- 更新文档 ([17d7f36](https://github.com/Mereithhh/van-blog/commit/17d7f367214d02b98032b78dded5e43740bdedef))
- 更新文档 ([8b111b2](https://github.com/Mereithhh/van-blog/commit/8b111b2edfe3e382df8e98df0fdd7c65e5aaa4f5))
- 镜像切换成 dockerHub（阿里云 ci 推不上去了) ([dff2ba7](https://github.com/Mereithhh/van-blog/commit/dff2ba7c4d81b229274a69f4ada032e2e51090c7))

### [0.20.8](https://github.com/Mereithhh/van-blog/compare/v0.20.7...v0.20.8) (2022-08-26)

### ✏️ Documentation | 文档

- 更新文档 ([4ade609](https://github.com/Mereithhh/van-blog/commit/4ade609b7d088b058418e19aec970b58a34635a8))

### 🐛 Bug Fixes | Bug 修复

- ICP 文案错误 ([a09486e](https://github.com/Mereithhh/van-blog/commit/a09486efcb5185c9c61c7412fdc60be71a30b5ac))

### ✨ Features | 新功能

- 初始化后增加注册评论管理员提示 ([44e8021](https://github.com/Mereithhh/van-blog/commit/44e802111a083f2a9fa392230fb61203c7b7a5e0))

### [0.20.7](https://github.com/Mereithhh/van-blog/compare/v0.20.6...v0.20.7) (2022-08-26)

### ✏️ Documentation | 文档

- 更新文档 ([ae1e6eb](https://github.com/Mereithhh/van-blog/commit/ae1e6eb783d3a671839d40e8a649dc80a3c549af))

### 🐛 Bug Fixes | Bug 修复

- 修复内置 waline 后台的一些问题 ([dbd25b9](https://github.com/Mereithhh/van-blog/commit/dbd25b9a63e73512c42d6ec5561a99309733d1e7))

### [0.20.6](https://github.com/Mereithhh/van-blog/compare/v0.20.5...v0.20.6) (2022-08-26)

### ✏️ Documentation | 文档

- 更新文档 ([c786b5f](https://github.com/Mereithhh/van-blog/commit/c786b5f7e20f29aebe883bb1a1b8d2b134408811))

### 🐛 Bug Fixes | Bug 修复

- 关闭评论系统导致报错 ([bad6bd4](https://github.com/Mereithhh/van-blog/commit/bad6bd422d4fef5e5cbf7a0821689b35a7ac2649))

### [0.20.5](https://github.com/Mereithhh/van-blog/compare/v0.20.4...v0.20.5) (2022-08-26)

### ✏️ Documentation | 文档

- 更新文档 ([69cad9c](https://github.com/Mereithhh/van-blog/commit/69cad9c2f87ef0c501bb8f1ca6421f89eceb44c3))

### 👷 Continuous Integration | CI 配置

- 优化 caddyfile 反代配置 ([891f1b0](https://github.com/Mereithhh/van-blog/commit/891f1b069a7ee8904217db4c0b6cbb538f29ef18))

### 🐛 Bug Fixes | Bug 修复

- 首次启动错误 ([7eaa6fa](https://github.com/Mereithhh/van-blog/commit/7eaa6fa328e3d96f0c22bada5066e06f33efd4fb))

### [0.20.4](https://github.com/Mereithhh/van-blog/compare/v0.20.3...v0.20.4) (2022-08-26)

### ✏️ Documentation | 文档

- 更新文档 ([07a0d88](https://github.com/Mereithhh/van-blog/commit/07a0d887e3bdd85cc090444643ab4ab58f326694))

### 🐛 Bug Fixes | Bug 修复

- 内嵌评论无法获取真实 ip ([85bc564](https://github.com/Mereithhh/van-blog/commit/85bc56432ad6f256fd57a5dbc530ebe05290890b))

### [0.20.3](https://github.com/Mereithhh/van-blog/compare/v0.20.2...v0.20.3) (2022-08-26)

### ✏️ Documentation | 文档

- 更新文档 ([c480fb3](https://github.com/Mereithhh/van-blog/commit/c480fb3f6453cf058ede1e0ded7357247ccb40b0))

### 🐛 Bug Fixes | Bug 修复

- 作者 logo 无法正常显示 ([8365275](https://github.com/Mereithhh/van-blog/commit/8365275ef0218c17e15f0f29a9e9c63b3e534ff9))

### [0.20.2](https://github.com/Mereithhh/van-blog/compare/v0.20.1...v0.20.2) (2022-08-26)

### ✏️ Documentation | 文档

- 切换成 dockerbub 源(aliyun 的被限流了) ([b307a2a](https://github.com/Mereithhh/van-blog/commit/b307a2a2ab6682def5a27ff1796d1b897ccf21d4))
- 更新文档 ([51c9cd8](https://github.com/Mereithhh/van-blog/commit/51c9cd81a6cf9d71ccfa1bc08f7a5dd24aa86419))
- 更新文档 ([3c71ace](https://github.com/Mereithhh/van-blog/commit/3c71ace3c3e314522d987c30b5d64687b3f23ee7))
- 更新文档 ([a0031b7](https://github.com/Mereithhh/van-blog/commit/a0031b7850e28c3581ce0aa3631693045b2cfba3))

### 🐛 Bug Fixes | Bug 修复

- 初始化不触发增量渲染 ([31fca3b](https://github.com/Mereithhh/van-blog/commit/31fca3be64e84baae855a713f673c0bd7c5f90bd))
- 前台构建器减少初始化边缘情况引起的错误日志 ([f28525b](https://github.com/Mereithhh/van-blog/commit/f28525bd8d8055612c84dcb93c782183aa64a15b))

### [0.20.1](https://github.com/Mereithhh/van-blog/compare/v0.20.0...v0.20.1) (2022-08-26)

### ✏️ Documentation | 文档

- 更新文档 ([9630c59](https://github.com/Mereithhh/van-blog/commit/9630c590a58669e784d0b13048e192b160d86a98))

### 🐛 Bug Fixes | Bug 修复

- 首次使用无法加载 waline 导致报错 ([cb9b11e](https://github.com/Mereithhh/van-blog/commit/cb9b11e0aa303c1367aab1678742d20f4873bfa3))

## [0.20.0](https://github.com/Mereithhh/van-blog/compare/v0.19.1...v0.20.0) (2022-08-25)

### ✏️ Documentation | 文档

- 更新文档 ([6386a6b](https://github.com/Mereithhh/van-blog/commit/6386a6bfd43ec6e92e314eabba3a3a341d50c00e))

### ⚡ Performance Improvements | 性能优化

- 页面跳转有时候不反应 ([889f6ad](https://github.com/Mereithhh/van-blog/commit/889f6ada261695e7be258cf51ddf7adda488e6ad))

### [0.19.1](https://github.com/Mereithhh/van-blog/compare/v0.19.0...v0.19.1) (2022-08-25)

### ✏️ Documentation | 文档

- 更新文档 ([c58d717](https://github.com/Mereithhh/van-blog/commit/c58d717789ce9b339acc2a10f1fa8877373e2798))

### 🐛 Bug Fixes | Bug 修复

- 因为反代 waline 加路径前缀会出现功能不正常，所以在没路径冲突的前提下，把内嵌 waline 的 uri 直接反代到根级别了 ([1c9aa3c](https://github.com/Mereithhh/van-blog/commit/1c9aa3c0c7a3c32ca98279df5a0c9c8ac86dd7b9))

### ✨ Features | 新功能

- 默认显示管理员按钮 ([c25606b](https://github.com/Mereithhh/van-blog/commit/c25606befb3363cc91c111914ac126214c8e136e))

## [0.19.0](https://github.com/Mereithhh/van-blog/compare/v0.18.1...v0.19.0) (2022-08-25)

### ✏️ Documentation | 文档

- 更新文档 ([394bde7](https://github.com/Mereithhh/van-blog/commit/394bde71dcd5b9e144460ff27249c57021221ef2))

### 👷 Continuous Integration | CI 配置

- 去掉多余 webhook ([065d042](https://github.com/Mereithhh/van-blog/commit/065d042dfcb48d22e869e537332b07c3cb27aaa1))

### ✨ Features | 新功能

- 优化上传图片提示（合二为一) ([f7aa86a](https://github.com/Mereithhh/van-blog/commit/f7aa86aec8e95f46d8bfe0fb058076285a8ee9eb))
- 内嵌评论系统 ([0874a85](https://github.com/Mereithhh/van-blog/commit/0874a850e381baf8f9a325f6c30cda39dfb2e2d3))
- 自定义评论所用 db 名 ([1723fe6](https://github.com/Mereithhh/van-blog/commit/1723fe6a39c8445a8c8cafb41e82a76e2312dedd))

### [0.18.1](https://github.com/Mereithhh/van-blog/compare/v0.18.0...v0.18.1) (2022-08-24)

### ✏️ Documentation | 文档

- 更新文档 ([a8ea4fb](https://github.com/Mereithhh/van-blog/commit/a8ea4fb30af4c5c8f6b78780808a2c51336ada7b))

### 🐛 Bug Fixes | Bug 修复

- 减少数据量但是没考虑边缘情况引起的构建错误 ([748cfe5](https://github.com/Mereithhh/van-blog/commit/748cfe55d6810cd4aa5198f68ec7455610296cb4))

## [0.18.0](https://github.com/Mereithhh/van-blog/compare/v0.17.0...v0.18.0) (2022-08-24)

### ✏️ Documentation | 文档

- 更新文档 ([340dd99](https://github.com/Mereithhh/van-blog/commit/340dd996a913316cf9c22b80fea43e1e491b7bfd))

### 👷 Continuous Integration | CI 配置

- 更新脚本 ([b5a876f](https://github.com/Mereithhh/van-blog/commit/b5a876fe78ada1c53d6b1ace9c7568074e4fd967))

### 🐛 Bug Fixes | Bug 修复

- 因为接口类型转换错误导致的页面显示数量过多 ([3c3258c](https://github.com/Mereithhh/van-blog/commit/3c3258cae2265697863c468db9837d603bfdc999))

### ⚡ Performance Improvements | 性能优化

- 去掉多余的评论获取请求 ([63a712b](https://github.com/Mereithhh/van-blog/commit/63a712b1b5f8b9cb9fb5c1d57f5352d83fddbf8e))

### ✨ Features | 新功能

- 优化 logo 展示&404 页面优化 ([3191e0f](https://github.com/Mereithhh/van-blog/commit/3191e0f262f8186c6ba29e751b44abd53a3ec338))

## [0.17.0](https://github.com/Mereithhh/van-blog/compare/v0.16.2...v0.17.0) (2022-08-24)

### ✏️ Documentation | 文档

- 更新文档 ([6d9945a](https://github.com/Mereithhh/van-blog/commit/6d9945a476c6b5df6f128771b770a655790a3db1))

### ✨ Features | 新功能

- 按需触发 ISR，优化增量渲染体验&优化字数缓存日志 ([6f11f83](https://github.com/Mereithhh/van-blog/commit/6f11f831bf5222a5f93d46bc3dc641712ee3d8e6))
- 按需触发 ISR，优化增量渲染体验&优化字数缓存日志(2) ([d494f76](https://github.com/Mereithhh/van-blog/commit/d494f766d2db06fc48a2bde7972866ebdc587d72))
- 触发 ISR 之前测试链接并超时重试 ([2b5777c](https://github.com/Mereithhh/van-blog/commit/2b5777c0bfb4a32beab3d287d6cb450ce9986a6e))

### [0.16.2](https://github.com/Mereithhh/van-blog/compare/v0.16.1...v0.16.2) (2022-08-23)

### ✏️ Documentation | 文档

- 更新文档截图&修复文档错误 ([a20835e](https://github.com/Mereithhh/van-blog/commit/a20835e67361ec0f21c919982948c7d1c88543b3))

### 🐛 Bug Fixes | Bug 修复

- 图片管理鼠标右键菜单栏跑位 ([943fad2](https://github.com/Mereithhh/van-blog/commit/943fad299c6ce4025e6cfe6c7ed19f7e9b7e0434))

### [0.16.1](https://github.com/Mereithhh/van-blog/compare/v0.16.0...v0.16.1) (2022-08-23)

### ✏️ Documentation | 文档

- 更新文档 ([01c563d](https://github.com/Mereithhh/van-blog/commit/01c563d5ae497e265f2b8da9841694f4ad31ecdc))

### 🐛 Bug Fixes | Bug 修复

- 初次更新后日志接口超时 ([c91e411](https://github.com/Mereithhh/van-blog/commit/c91e4114799f693e6b2dcc50c19bbcfbe7f08032))
- 更新后第一次进入获取登录日志接口超时 ([360590a](https://github.com/Mereithhh/van-blog/commit/360590af0540e44f569520ec8d52dd20fa3efd07))

## [0.16.0](https://github.com/Mereithhh/van-blog/compare/v0.15.0...v0.16.0) (2022-08-23)

### ✏️ Documentation | 文档

- 更新文档 ([2f3f67c](https://github.com/Mereithhh/van-blog/commit/2f3f67cd98da095207a49cfc603dff483da48c13))

### ✨ Features | 新功能

- 后台加载页面去掉大 logo ([b09937a](https://github.com/Mereithhh/van-blog/commit/b09937ad17bf0d369ef6be0416ca4333f873f503))
- 登录日志' ([c320761](https://github.com/Mereithhh/van-blog/commit/c3207619daf4b430569d0ea45dd93e5a5582c6ad))

## [0.15.0](https://github.com/Mereithhh/van-blog/compare/v0.14.0...v0.15.0) (2022-08-23)

### 🐛 Bug Fixes | Bug 修复

- 还是不展示大纲 ([a1826f8](https://github.com/Mereithhh/van-blog/commit/a1826f8270e263689a6015f6162ec976f2622c1d))

### ✏️ Documentation | 文档

- 更新文档 ([8a2f394](https://github.com/Mereithhh/van-blog/commit/8a2f394391b389d25ce6262f5363f83e0823a4e1))
- 更新文档 ([0f51dff](https://github.com/Mereithhh/van-blog/commit/0f51dff931a181e690485a42728b472f808b1973))

### ✨ Features | 新功能

- 后台编辑器增加参考文档按钮 ([18cc4ab](https://github.com/Mereithhh/van-blog/commit/18cc4ab21364704dca11b77972d8e2772edb315c))
- 大尺寸下编辑器展示大纲 ([a4661c4](https://github.com/Mereithhh/van-blog/commit/a4661c4d034ae01061e04f6b4def0b98e3c5b2fc))
- 失焦自动保存草稿 ([4a4a26d](https://github.com/Mereithhh/van-blog/commit/4a4a26d4a42f1f5c42de19a5c9ea7e34737033d5))
- 拆分站点管理为多个菜单 ([b858e00](https://github.com/Mereithhh/van-blog/commit/b858e00f1715ffc42c215e50036a86f8fab0b0d4))
- 文章页面和草稿页面默认展示 10 行 ([1918050](https://github.com/Mereithhh/van-blog/commit/19180501dcedfe7f89732b9f2f1de79e5dca9b6f))
- 编辑器移动端工具栏删减 ([e7e0e65](https://github.com/Mereithhh/van-blog/commit/e7e0e6593b09e560b8d8afbd1a539de6985694d8))
- 调整编辑器工具栏 ([97b90ee](https://github.com/Mereithhh/van-blog/commit/97b90eea9b090ef138c9d3c6aa4189a4ee6ba016))

## [0.14.0](https://github.com/Mereithhh/van-blog/compare/v0.13.3...v0.14.0) (2022-08-22)

### ✏️ Documentation | 文档

- 更新文档 ([da05ee9](https://github.com/Mereithhh/van-blog/commit/da05ee9555a86b5bc6e2e6e5b02d61c37b344ba1))

### 👷 Continuous Integration | CI 配置

- 增加发版 doc 脚本” ([1d32329](https://github.com/Mereithhh/van-blog/commit/1d3232991bebcee303aa1fd36908dfb9b90f2bea))

### ✨ Features | 新功能

- 优化布局，大尺寸不显示顶栏，主题切换放到侧边栏 ([193403f](https://github.com/Mereithhh/van-blog/commit/193403fa8eaaf0901a6e96a20c050fad323173b4))

### [0.13.3](https://github.com/Mereithhh/van-blog/compare/v0.13.2...v0.13.3) (2022-08-22)

### ✏️ Documentation | 文档

- 更新 changelog ([0ae0447](https://github.com/Mereithhh/van-blog/commit/0ae04471ae178535b592529a07bb046035d12b93))

### 🐛 Bug Fixes | Bug 修复

- 过度编码导致图片无法显示 ([18cfd82](https://github.com/Mereithhh/van-blog/commit/18cfd8221842c13cd8915364b969a8f1bbc6be0a))

### [0.13.2](https://github.com/Mereithhh/van-blog/compare/v0.13.1...v0.13.2) (2022-08-22)

### 🐛 Bug Fixes | Bug 修复

- 图片 url 特殊字符未转义导致无法正常显示 ([920e5fa](https://github.com/Mereithhh/van-blog/commit/920e5faca039013f6af992bb20b4a779cd35c2e7))

### [0.13.1](https://github.com/Mereithhh/van-blog/compare/v0.13.0...v0.13.1) (2022-08-22)

### ✏️ Documentation | 文档

- 更新文档 ([9f92bb9](https://github.com/Mereithhh/van-blog/commit/9f92bb906c74a28fa465275251e0318a387d70eb))

### 🐛 Bug Fixes | Bug 修复

- 图片名称包含有括号的时候 markdown 链接无法加载成功 ([a11d9b5](https://github.com/Mereithhh/van-blog/commit/a11d9b55f4f56ca535575661824cdf9bd3c82caf))

## [0.13.0](https://github.com/Mereithhh/van-blog/compare/v0.12.3...v0.13.0) (2022-08-22)

### 🐛 Bug Fixes | Bug 修复

- 全称标题过长导致在微信电脑浏览器中侧边栏标题换行 ([0431e97](https://github.com/Mereithhh/van-blog/commit/0431e97b865143806510403d9b8c1b1fcd32623a))
- 文档脚本错误 ([19bb12f](https://github.com/Mereithhh/van-blog/commit/19bb12ff5f92be12643dba410cd4f2ee1943adfa))

### ✏️ Documentation | 文档

- 文档增加 faq ([c53fc56](https://github.com/Mereithhh/van-blog/commit/c53fc56f0f0847bdbb0e13c9c140868dc8767d36))
- 更新 changelog 文档 ([fcec8ef](https://github.com/Mereithhh/van-blog/commit/fcec8ef10bca37abf031a7bdd82db0d35aa40065))

### ✨ Features | 新功能

- console.log 增加求 star 文案 🙏’ ([78aa2bc](https://github.com/Mereithhh/van-blog/commit/78aa2bc659abdbd2e8c71a9d861d433afc3f0030))
- 优化 more 标记提醒逻辑，点击确认依然可以保存 ([a1870db](https://github.com/Mereithhh/van-blog/commit/a1870db4ed9835046e49e5acecee80f3f7dbde7e))
- 后台更新提示的更新日志切换成项目文档中的链接 ([c98878c](https://github.com/Mereithhh/van-blog/commit/c98878c784b0d7ab67b35985aeaaa7a093d0c5f3))
- 后台编辑器切换预览模式持久化保存到设备 ([270beb5](https://github.com/Mereithhh/van-blog/commit/270beb52138dc3d0743cf59730b7fa330e6c275b))
- 后台编辑器自动满屏幕 ([f49a99e](https://github.com/Mereithhh/van-blog/commit/f49a99e649ac9ddec73d15f1f5530104decaec87))
- 后台编辑器页面增加宽度提升体验 ([c14bd6c](https://github.com/Mereithhh/van-blog/commit/c14bd6c7359e2d40df689f4bf3c44fc438fc59ab))
- 编辑器右上角增加字数统计 ([9f29f30](https://github.com/Mereithhh/van-blog/commit/9f29f30f162c4f1c6925063ff0dc7bbf918eb3e3))

### [0.12.3](https://github.com/Mereithhh/van-blog/compare/v0.12.2...v0.12.3) (2022-08-22)

### 🐛 Bug Fixes | Bug 修复

- React Hydration Error ([e47e3f2](https://github.com/Mereithhh/van-blog/commit/e47e3f29fcce1c8aff90ba5e94f00514a8e9a83d))
- 切换页面控制台重复说 hello ([a693a06](https://github.com/Mereithhh/van-blog/commit/a693a06c5ce3736952c59cf011554ad99a4fe2e2))
- 因后端客户端时区不同导致的 Hydration Error ([1f82816](https://github.com/Mereithhh/van-blog/commit/1f82816ed4fb0affdcaa16cfbf991d5093023654))
- 没映射静态文件目录时无法删除本地图床文件 ([80203d7](https://github.com/Mereithhh/van-blog/commit/80203d7a454b38f7d5179ebeba8dc7bac359a46d))
- 长标题+顶置情况下，文章标题样式稍微错位 ([d4c228e](https://github.com/Mereithhh/van-blog/commit/d4c228e2a1e66c884457722b60eaa8e62c32cf0a))

### 👷 Continuous Integration | CI 配置

- 拆分多个 job 并行提高效率 ([d8e8cb9](https://github.com/Mereithhh/van-blog/commit/d8e8cb929cb182ad6216371d4a7a9e63d3c5d934))

### ✏️ Documentation | 文档

- 更新了文档 ([6e5e2df](https://github.com/Mereithhh/van-blog/commit/6e5e2dff3da2468c7d0ead432cddbf72bf586491))
- 更新文档 ([1373781](https://github.com/Mereithhh/van-blog/commit/13737813b65a1c8320d44dfff673effaab2e24a1))

### ✨ Features | 新功能

- 升级提示展示文档和更新日志链接&项目文档增加更新日志 ([aa4514c](https://github.com/Mereithhh/van-blog/commit/aa4514c8ff25042dd1ae193685255f6dcb5e0bbf))
- 后台增加项目文档、API 文档跳转按钮 ([3f2a49e](https://github.com/Mereithhh/van-blog/commit/3f2a49e8cc3eae158000727720e760dab71cd933))
- 后台编辑器工具栏默认固定在最顶端 ([49b44dc](https://github.com/Mereithhh/van-blog/commit/49b44dc9492438fbcc35eb984979cb0895f39410))
- 容器启动时触发两次增量渲染 ([65de8f3](https://github.com/Mereithhh/van-blog/commit/65de8f375a4ed51a13aaf5f3d897a9ae16266df8))

### [0.12.2](https://github.com/Mereithhh/van-blog/compare/v0.12.1...v0.12.2) (2022-08-21)

### ✨ Features | 新功能

- https 自动重定向增加提示 ([9ce2dd8](https://github.com/Mereithhh/van-blog/commit/9ce2dd8c76ba230a7d35059cb16317b5fb3adf2f))
- 开启 https 自动重定向前增加提示文案 ([5896121](https://github.com/Mereithhh/van-blog/commit/5896121b4176131a4caa510af0ecacf005c1db33))
- 演示站禁止修改 https 自动重定向 ([4fe65e7](https://github.com/Mereithhh/van-blog/commit/4fe65e718584347d86b456625348759599e1dd09))

### [0.12.1](https://github.com/Mereithhh/van-blog/compare/v0.12.0...v0.12.1) (2022-08-21)

### ✏️ Documentation | 文档

- 修复文档错误 ([9276de9](https://github.com/Mereithhh/van-blog/commit/9276de9c9aca19a7f6c21498962920d311b68757))

### 🐛 Bug Fixes | Bug 修复

- 老版本迁移无法启动服务 ([1daee14](https://github.com/Mereithhh/van-blog/commit/1daee14c59e46c7567a373f789d98fb2623c1211))

## [0.12.0](https://github.com/Mereithhh/van-blog/compare/v0.11.1...v0.12.0) (2022-08-21)

### ✏️ Documentation | 文档

- 更新文档 ([55e8974](https://github.com/Mereithhh/van-blog/commit/55e89748e7fd1fc5d187d19b64ff52ae67869776))

### ✨ Features | 新功能

- https 证书全自动按需申请&文档更新 ([ac36e7a](https://github.com/Mereithhh/van-blog/commit/ac36e7abfcdc3c5b3c9792cf22741325535afa7c))

### [0.11.1](https://github.com/Mereithhh/van-blog/compare/v0.11.0...v0.11.1) (2022-08-19)

### 🐛 Bug Fixes | Bug 修复

- 演示站修改密码锁定用环境变量传参不生效 ([be663bf](https://github.com/Mereithhh/van-blog/commit/be663bfaeb89e84b03003e7364c404201661f900))

## [0.11.0](https://github.com/Mereithhh/van-blog/compare/v0.10.24...v0.11.0) (2022-08-19)

### ✨ Features | 新功能

- 增加演示站禁止修改账号密码的配置项 ([8c52fa6](https://github.com/Mereithhh/van-blog/commit/8c52fa61faa9f5bd15b4c7e9ee9dac1d5caffc2e))

### ⚡ Performance Improvements | 性能优化

- 优化构建，镜像体积倍减 ([6b2d54d](https://github.com/Mereithhh/van-blog/commit/6b2d54dc03e1ef6f2dccdb426474d510bf0eefbc))

### ✏️ Documentation | 文档

- 修复 README 坏链 ([e9d74ce](https://github.com/Mereithhh/van-blog/commit/e9d74ce0ca6ecca354b07d87465dd12544b9a1e8))
- 修复文档错字 ([8a206bc](https://github.com/Mereithhh/van-blog/commit/8a206bc563f5e4cb70dfccf858b282f846b55c5e))
- 更新文档 ([fb72e15](https://github.com/Mereithhh/van-blog/commit/fb72e15135cc7dc3e7a81901b39fe2f0d7da04cc))
- 更新文档 ([761eef5](https://github.com/Mereithhh/van-blog/commit/761eef51898f68240ee85b953e67379c8e3769f4))

### [0.10.24](https://github.com/Mereithhh/van-blog/compare/v0.10.23...v0.10.24) (2022-08-18)

### 🐛 Bug Fixes | Bug 修复

- 图片加载失败情况下样式不一致 ([f714b22](https://github.com/Mereithhh/van-blog/commit/f714b2232436f90e51a6988aff9e56ececf41029))

### 👷 Continuous Integration | CI 配置

- 调整 ci 顺序 ([9fb6859](https://github.com/Mereithhh/van-blog/commit/9fb68591de95a7f77f0da53478a0b20ce41a5911))

### [0.10.23](https://github.com/Mereithhh/van-blog/compare/v0.10.22...v0.10.23) (2022-08-18)

### 🐛 Bug Fixes | Bug 修复

- 后台前往主站不依赖设置中的 baseUrl ([075334a](https://github.com/Mereithhh/van-blog/commit/075334a9434b8fc30cc8a243db73642fe36d1d27))
- 用 ip 地址时本地图床前端无法正常展示 ([da50209](https://github.com/Mereithhh/van-blog/commit/da502097c4cb12e742190e7bc419e07502c86b06))

### [0.10.22](https://github.com/Mereithhh/van-blog/compare/v0.10.21...v0.10.22) (2022-08-18)

### 🐛 Bug Fixes | Bug 修复

- 本地图床图片上传不显示问题 ([9f5bdfb](https://github.com/Mereithhh/van-blog/commit/9f5bdfbbdb89b69caf20b4ebbd65be05c0a7b0c8))

### [0.10.21](https://github.com/Mereithhh/van-blog/compare/v0.10.20...v0.10.21) (2022-08-18)

### ✏️ Documentation | 文档

- README 预览图调整到前面 ([1162446](https://github.com/Mereithhh/van-blog/commit/1162446ea844470ba20e6358ad52eeede1fbb916))
- 修复文档错误 ([ae85336](https://github.com/Mereithhh/van-blog/commit/ae853367553a79b38f334264257d0e4c0587743d))
- 修复项目文档失效链接&增加预览图 ([e221772](https://github.com/Mereithhh/van-blog/commit/e2217722361c211e148dcec5abe35efeb3de7ac4))
- 更新 README ([ac0ff9d](https://github.com/Mereithhh/van-blog/commit/ac0ff9dd130941307ba3bf3cd2d831a1b61469df))
- 更新 readme 预览图 ([4182cc0](https://github.com/Mereithhh/van-blog/commit/4182cc0a02d714ebbc07815d7ea5a304bde6005e))

### 🐛 Bug Fixes | Bug 修复

- 初始化没办法上传图片 ([5d41997](https://github.com/Mereithhh/van-blog/commit/5d41997acce516b00589d3e610dfb9334ee48b2e))

### [0.10.20](https://github.com/Mereithhh/van-blog/compare/v0.10.19...v0.10.20) (2022-08-18)

### 🐛 Bug Fixes | Bug 修复

- 只有一页隐藏分页按钮 ([89afcbc](https://github.com/Mereithhh/van-blog/commit/89afcbca096e23ceb3b25e986e59ac5af2ad39b5))
- 链接卡片 hover 时图片不旋转 ([285efb5](https://github.com/Mereithhh/van-blog/commit/285efb5b57a6c05e47f32381fa0bb74317baac9d))

### [0.10.19](https://github.com/Mereithhh/van-blog/compare/v0.10.18...v0.10.19) (2022-08-17)

### ✏️ Documentation | 文档

- 更新 README 错字 ([956eda7](https://github.com/Mereithhh/van-blog/commit/956eda7349dad5803a27c99196bb8c49c0ac206c))

### ✨ Features | 新功能

- url 表单输入也会更新图片预览 ([14b6b62](https://github.com/Mereithhh/van-blog/commit/14b6b62f8d789355709f1ada8e640e1d59cbef8f))

### [0.10.18](https://github.com/Mereithhh/van-blog/compare/v0.10.17...v0.10.18) (2022-08-17)

### 🐛 Bug Fixes | Bug 修复

- ci 报错 ([9b1f167](https://github.com/Mereithhh/van-blog/commit/9b1f1675d740bfa2132a3c451ce2c9615e7f0fa2))
- 保存关于提示没有标签 ([701ab8f](https://github.com/Mereithhh/van-blog/commit/701ab8fb95c25b649bf0545e72cc7a2eeedf0a39))

### [0.10.17](https://github.com/Mereithhh/van-blog/compare/v0.10.16...v0.10.17) (2022-08-17)

### ✨ Features | 新功能

- 一页时不显示分页器 ([e091ad4](https://github.com/Mereithhh/van-blog/commit/e091ad4365b2d5243bd30301a1d0c13e7ba8fbde))
- 优化构建模板信息 ([27a264b](https://github.com/Mereithhh/van-blog/commit/27a264b7c560b108ad531699c649fcc262dbf1eb))

### [0.10.16](https://github.com/Mereithhh/van-blog/compare/v0.10.15...v0.10.16) (2022-08-17)

### 🐛 Bug Fixes | Bug 修复

- 完善访客记录逻辑&增加一个洗数据脚本 ([ea7f5c1](https://github.com/Mereithhh/van-blog/commit/ea7f5c13d8fb9c98555166ed01cf51bb44638089))

### [0.10.15](https://github.com/Mereithhh/van-blog/compare/v0.10.14...v0.10.15) (2022-08-17)

### ✨ Features | 新功能

- 优化 console.log 提示语 ([cce36ba](https://github.com/Mereithhh/van-blog/commit/cce36baec0d24351ae3e57aa1155f81e6837bf0c))
- 后台优化文案细节 ([f58fc32](https://github.com/Mereithhh/van-blog/commit/f58fc325fe2b7511cf776834c9fb3c1163b04dcf))

### 🐛 Bug Fixes | Bug 修复

- 修复访客信息展示&增加 console.log 欢迎语 ([210bc93](https://github.com/Mereithhh/van-blog/commit/210bc93fc93f24bc6495692b5843e12f70993ffc))
- 修复顶置失效问题 ([c5a1d66](https://github.com/Mereithhh/van-blog/commit/c5a1d66ed433663bc7a86dc0026950f8c4112915))
- 后台第一次登录后不显示版本“ ([07d6654](https://github.com/Mereithhh/van-blog/commit/07d66544d3514da571628f48482ac5510d47f997))
- 更改文章排序逻辑为排他性 ([b9085d3](https://github.com/Mereithhh/van-blog/commit/b9085d3f0d75d5fbb9c9e17e4b532542908e866e))

### [0.10.14](https://github.com/Mereithhh/van-blog/compare/v0.10.13...v0.10.14) (2022-08-17)

### 👷 Continuous Integration | CI 配置

- 锁定版本 ([f78d582](https://github.com/Mereithhh/van-blog/commit/f78d5826628c0abf56ec86141975d16dde8ad41e))

### [0.10.13](https://github.com/Mereithhh/van-blog/compare/v0.10.12...v0.10.13) (2022-08-17)

### ✏️ Documentation | 文档

- 修改图标 ([fcbbdb2](https://github.com/Mereithhh/van-blog/commit/fcbbdb2a4ef3f2da3a446ef5a8ff4a5f7cbc31e9))
- 增加图标 ([e805a74](https://github.com/Mereithhh/van-blog/commit/e805a747d07a43f2182be538c86fbebd28bb5b00))
- 增加构建图标 ([72392b8](https://github.com/Mereithhh/van-blog/commit/72392b8059d0241432db42111b10882d92f09ca8))

### ✨ Features | 新功能

- 增加趋势图 ([924cf3b](https://github.com/Mereithhh/van-blog/commit/924cf3b5f49d6de1fcc307d180cad97fdf3f725a))

### 🐛 Bug Fixes | Bug 修复

- 修改文档 ([abdb7bb](https://github.com/Mereithhh/van-blog/commit/abdb7bb8f25eb72ca5ed5f55d24f6853fcd10248))
- 登录页面主题自适应 ([e6e88d4](https://github.com/Mereithhh/van-blog/commit/e6e88d4ae29d3488515818c66b22bffefc1bce80))
- 配置文件报错 ([6f2cd92](https://github.com/Mereithhh/van-blog/commit/6f2cd9299d3200d748e69c3c72439725af868fa3))

### [0.10.12](https://github.com/Mereithhh/van-blog/compare/v0.10.11...v0.10.12) (2022-08-16)

### 🐛 Bug Fixes | Bug 修复

- 尝试修复后台切换页面报错 ([f25f380](https://github.com/Mereithhh/van-blog/commit/f25f380f257432fe4c24a52b39df5367b04e945f))

### [0.10.11](https://github.com/Mereithhh/van-blog/compare/v0.10.10...v0.10.11) (2022-08-16)

### 👷 Continuous Integration | CI 配置

- demo 站不用自用镜像 ([559ef38](https://github.com/Mereithhh/van-blog/commit/559ef38778616b67be006df907c742e425d823c0))

### 🐛 Bug Fixes | Bug 修复

- 尝试修复构建后后台切换页面报错 ([df47e26](https://github.com/Mereithhh/van-blog/commit/df47e26c5814d0b1575b200a575018601aa2d59a))

### [0.10.10](https://github.com/Mereithhh/van-blog/compare/v0.10.9...v0.10.10) (2022-08-16)

### 👷 Continuous Integration | CI 配置

- 增加部署 demo 的 job ([4cd838c](https://github.com/Mereithhh/van-blog/commit/4cd838c2dc98d26bec7d2b8335b58761d23f06e1))

### 🐛 Bug Fixes | Bug 修复

- 修复初始化后预览面板报错 ([84f5b11](https://github.com/Mereithhh/van-blog/commit/84f5b110296496f5bc454bde96ce7d373eee9e1d))
- 登录态失效 ([43ea345](https://github.com/Mereithhh/van-blog/commit/43ea345fded8d140ee411d08cec35fca730d594d))
- 默认隐藏后台按钮 ([4da6c5b](https://github.com/Mereithhh/van-blog/commit/4da6c5bae747ee3ec880067c2cf41d1d7849c0d6))

### ✨ Features | 新功能

- 拆分初始化页面&初始化页面自动根据实际适配主题 ([1c92868](https://github.com/Mereithhh/van-blog/commit/1c9286810e13c2282fca8fda975b624e6519ccba))
- 默认上传图片复制 markdown 链接而不是 url ([3addf1c](https://github.com/Mereithhh/van-blog/commit/3addf1ca1681630afde72f9fbe6bec18d563f353))

### ✏️ Documentation | 文档

- 增加初始化文档 ([47e5c55](https://github.com/Mereithhh/van-blog/commit/47e5c550f8926f88b837400b54e7d0205f8aac41))
- 更新 README.md ([1a7fc4c](https://github.com/Mereithhh/van-blog/commit/1a7fc4ce954d58a63d83d6c7dcdd59b873340977))

### [0.10.9](https://github.com/Mereithhh/van-blog/compare/v0.10.8...v0.10.9) (2022-08-16)

### ✏️ Documentation | 文档

- 更新大量文档 ([ffed346](https://github.com/Mereithhh/van-blog/commit/ffed346253c4b15b52fc3b5bc5e835d08180a9d6))

### 🐛 Bug Fixes | Bug 修复

- 修复顶置失效 ([85c98c9](https://github.com/Mereithhh/van-blog/commit/85c98c9e11eec72d966b05b9ba0dbaad33c62f57))

### [0.10.8](https://github.com/Mereithhh/van-blog/compare/v0.10.7...v0.10.8) (2022-08-14)

### 👷 Continuous Integration | CI 配置

- 安装 sharp ([8b46504](https://github.com/Mereithhh/van-blog/commit/8b46504e2356510b3b68ca3ffefadab89dcaed7b))

### [0.10.7](https://github.com/Mereithhh/van-blog/compare/v0.10.6...v0.10.7) (2022-08-14)

### 🐛 Bug Fixes | Bug 修复

- 删除导致 ci 报错的无用代码 ([c4a0514](https://github.com/Mereithhh/van-blog/commit/c4a0514b62f7183c0ea3285fbafef8c5f5f9242a))

### [0.10.6](https://github.com/Mereithhh/van-blog/compare/v0.10.5...v0.10.6) (2022-08-14)

### ✨ Features | 新功能

- 优化主题切换，减少报错 ([cbb5bdb](https://github.com/Mereithhh/van-blog/commit/cbb5bdbd62d4b9a1b16313209a1c8cc91af42f97))
- 前台图片预览增加小工具 ([1460536](https://github.com/Mereithhh/van-blog/commit/146053657f88f6077672d82a4764150bc59540bd))
- 图片增加灯箱 ([c811c5a](https://github.com/Mereithhh/van-blog/commit/c811c5a3f5ea9b4ef3bd7f9cc9425218c32199fd))
- 增加 cdn 配置 ([138c72a](https://github.com/Mereithhh/van-blog/commit/138c72a54f951d0f02c5c739a15aa0bfb3343ae4))

### [0.10.5](https://github.com/Mereithhh/van-blog/compare/v0.10.4...v0.10.5) (2022-08-14)

### 👷 Continuous Integration | CI 配置

- 增加 sharp ([ea1865d](https://github.com/Mereithhh/van-blog/commit/ea1865d79ec39137fd196e36eed641e57da5ddd1))
- 增加 sharp ([425258e](https://github.com/Mereithhh/van-blog/commit/425258e8a794d890ace8eacebd4b46786cc709f7))

### [0.10.4](https://github.com/Mereithhh/van-blog/compare/v0.10.3...v0.10.4) (2022-08-14)

### 👷 Continuous Integration | CI 配置

- prod 安装 sharp ([5339c5a](https://github.com/Mereithhh/van-blog/commit/5339c5a1b2846ce67d4c07d8a51534fd46fea578))

### 🐛 Bug Fixes | Bug 修复

- next 多余的无用 Link ([9984d93](https://github.com/Mereithhh/van-blog/commit/9984d930e9358cc6106e097222bcb75479fa49fe))
- 当无新增访客时，新增访客为负数的问题 ([6c6ab01](https://github.com/Mereithhh/van-blog/commit/6c6ab016c2114b8a636ac6b9e8b6b6afe2c69c1e))
- 每天晚上 0 点定时更新当天的访客记录 ([8810907](https://github.com/Mereithhh/van-blog/commit/881090743bb07aba90105fad2b0ce630e92a6cfb))

### [0.10.3](https://github.com/Mereithhh/van-blog/compare/v0.10.2...v0.10.3) (2022-08-13)

### ✨ Features | 新功能

- 移除 sweetalert2，优化 toast ([4a7620c](https://github.com/Mereithhh/van-blog/commit/4a7620c6322d69049c27e7bd878347b5fc8b7f71))

### [0.10.2](https://github.com/Mereithhh/van-blog/compare/v0.10.1...v0.10.2) (2022-08-13)

### 🐛 Bug Fixes | Bug 修复

- 修复友情链接站点信息错误 ([03a5769](https://github.com/Mereithhh/van-blog/commit/03a5769624b05c85fc0de52eda0c72df3ac0f4f5))

### [0.10.1](https://github.com/Mereithhh/van-blog/compare/v0.10.0...v0.10.1) (2022-08-13)

### 🐛 Bug Fixes | Bug 修复

- 修复未加 props 导致的构建报错 ([a3bea70](https://github.com/Mereithhh/van-blog/commit/a3bea707a7ceb51732eca6b9b908eff7dfde6acd))

## [0.10.0](https://github.com/Mereithhh/van-blog/compare/v0.9.0...v0.10.0) (2022-08-13)

### 🐛 Bug Fixes | Bug 修复

- 修复使用了 admin 相对路由导致的跳转问题 ([215c32e](https://github.com/Mereithhh/van-blog/commit/215c32eeb45239fd457952364bd98282f78398b4))
- 修复文案错误 ([ad8d0ea](https://github.com/Mereithhh/van-blog/commit/ad8d0ea5ad2bf357e832e39e32e25823a4e8875e))

### ✨ Features | 新功能

- 上传图片增加 loading 态 ([f5db57a](https://github.com/Mereithhh/van-blog/commit/f5db57a18bb0ed373942bb55f7e2ab987fdce148))
- 优化初始化提示文案” ([375e130](https://github.com/Mereithhh/van-blog/commit/375e130a953f4425a3bd8705d5aa68d5de528322))
- 优化加密文章显示样式 ([853e882](https://github.com/Mereithhh/van-blog/commit/853e882ca60e26eb313453d77b9c12cfde6eabe7))
- 优化后台友联设置 ([2aedf1d](https://github.com/Mereithhh/van-blog/commit/2aedf1d50219d1787b8e51763066b60c6d6e83ac))
- 优化后台页容器展示 ([1a96f62](https://github.com/Mereithhh/van-blog/commit/1a96f6238e3f1a2f08d983af765cfa780bdb32f5))
- 友链展示 ([71c28fc](https://github.com/Mereithhh/van-blog/commit/71c28fce718a5338c04019966bc354649849bbb3))
- 后台编辑器代码主题随亮暗切换 ([af7adf6](https://github.com/Mereithhh/van-blog/commit/af7adf62893c291f6557960bb52d0932c5798781))
- 增加是否展示友链和捐赠信息的选项 ([542a068](https://github.com/Mereithhh/van-blog/commit/542a0689ea96fe349061ea6494da0d64c1eba302))
- 捐赠信息展示 ([b0cfcc2](https://github.com/Mereithhh/van-blog/commit/b0cfcc2eb83db5c2e6d8ae653b51d38c1bd0a824))
- 文案优化 ([765e8e9](https://github.com/Mereithhh/van-blog/commit/765e8e9607f91138a7f43e6a5e0a7828cf5dfa01))
- 略微优化初始化页面样式 ([631e1ea](https://github.com/Mereithhh/van-blog/commit/631e1ea41fd5f2ef0e014fef3a649085f6fc93b3))
- 调整 markdown 分界线样式 ([1b54021](https://github.com/Mereithhh/van-blog/commit/1b540211bc40cc3a1fc822aeb006c6d9d2807439))
- 隐藏文章功能 ([98d0c23](https://github.com/Mereithhh/van-blog/commit/98d0c23233883e5f6d97c4e8dd68c0f337b52082))

## [0.9.0](https://github.com/Mereithhh/van-blog/compare/v0.8.0...v0.9.0) (2022-08-12)

### 👷 Continuous Integration | CI 配置

- 增加更新版本到 api server 的操作 ([5cf678d](https://github.com/Mereithhh/van-blog/commit/5cf678d0ce1b6cbf0b28b16b857cc58e49765927))

## [0.8.0](https://github.com/Mereithhh/van-blog/compare/v0.7.8...v0.8.0) (2022-08-12)

### 🐛 Bug Fixes | Bug 修复

- 图片信息显示错误 ([b3fb7d4](https://github.com/Mereithhh/van-blog/commit/b3fb7d402014f4f0849857ca7714b1a023da9abc))

### ✨ Features | 新功能

- 优化主题切换定时器“ ([91820e9](https://github.com/Mereithhh/van-blog/commit/91820e9c406a1ae7a73116fd4eacf82e0eb5b7b3))
- 优化后台图片最大高度展示 ([6fbcd48](https://github.com/Mereithhh/van-blog/commit/6fbcd487226e9e02ad646f4b198c1b9ada811b7b))
- 优化图床 meta 信息和后台央视 ([5a9c67d](https://github.com/Mereithhh/van-blog/commit/5a9c67dbb6ae139932fc2080cc474f79a1b53825))
- 优化图片管理展示页面 ([9d6efd8](https://github.com/Mereithhh/van-blog/commit/9d6efd818e3457ae0f74421aee45439fcf74d868))
- 初步增加本地图床 ([939c405](https://github.com/Mereithhh/van-blog/commit/939c4057c717a24d1f069d2a02539b3b3168f023))
- 可查看被引用图片的文章了 ([805d5c6](https://github.com/Mereithhh/van-blog/commit/805d5c6c3ffea2670bfdaca7fa4b7bbbc286c412))
- 后台剪切板图片上传 ([9922314](https://github.com/Mereithhh/van-blog/commit/992231487482d0b582e69ca6c5275f656a259149))
- 后台图片管理完善剪切板复制和右键菜单删除 ([9a27a60](https://github.com/Mereithhh/van-blog/commit/9a27a60c8d2db92718e93d53ec9aa3e2d9d91238))
- 后台图片部分支持内置图床&优化设置表单 ([023fed9](https://github.com/Mereithhh/van-blog/commit/023fed90385c8c68543b82c1f34042e28ab4978f))
- 后台完善右键菜单和剪切板删除 ([15b9bca](https://github.com/Mereithhh/van-blog/commit/15b9bca5615bb702e8536a1d17a93b900f3dcf02))
- 后台编辑器上传 toolbar ([d1d924e](https://github.com/Mereithhh/van-blog/commit/d1d924e13dd02c18f039f7f0dfdce41489e3a9d3))
- 后台设置增加裁剪支持 ([c705397](https://github.com/Mereithhh/van-blog/commit/c7053976a23644742e6b15f4d080bb49f86a6319))
- 图床可以下载图片 ([691c946](https://github.com/Mereithhh/van-blog/commit/691c9468c9a00b1199e5ca88f6f5c00b9ca73805))
- 增加图床设置界面和接口 ([032a0f0](https://github.com/Mereithhh/van-blog/commit/032a0f00855ce0e08b957c7c6cd70f166fb34ec8))
- 备份恢复图床支持 ([2dd253d](https://github.com/Mereithhh/van-blog/commit/2dd253dd946134b7a8b7205dd16e323009f93691))
- 完善图片信息展示&增加删除二次确认弹窗 ([e685250](https://github.com/Mereithhh/van-blog/commit/e6852509009f0416005c5360ba10d8e07d3f7eea))
- 支持扫描文章已存在的图片到图床 ([8fd9b5a](https://github.com/Mereithhh/van-blog/commit/8fd9b5ab9f347b3ab5cbf9912857852747df9163))
- 隐藏多余的设置抽屉 ([7dbf9b7](https://github.com/Mereithhh/van-blog/commit/7dbf9b78276c92885862b2b6f6d946671676a776))

### [0.7.8](https://github.com/Mereithhh/van-blog/compare/v0.7.7...v0.7.8) (2022-08-09)

### ✨ Features | 新功能

- 后台增加黑暗模式 ([c92996a](https://github.com/Mereithhh/van-blog/commit/c92996a3a1824e5b58d008ef9d890f1c32c7344e))

### [0.7.7](https://github.com/Mereithhh/van-blog/compare/v0.7.6...v0.7.7) (2022-08-08)

### 🐛 Bug Fixes | Bug 修复

- 修复接口错误 ([cf0b81e](https://github.com/Mereithhh/van-blog/commit/cf0b81ec4fdfbceec36aabb04882251812819199))

### [0.7.6](https://github.com/Mereithhh/van-blog/compare/v0.7.5...v0.7.6) (2022-08-08)

### 🐛 Bug Fixes | Bug 修复

- 文章卡片展示创建日期 ([51936a1](https://github.com/Mereithhh/van-blog/commit/51936a141f65ae507a63fc03939c7ad66f428df6))

### [0.7.5](https://github.com/Mereithhh/van-blog/compare/v0.7.4...v0.7.5) (2022-08-08)

### 🐛 Bug Fixes | Bug 修复

- 显示后台按钮配置没按预期显示 ([cbbe6fe](https://github.com/Mereithhh/van-blog/commit/cbbe6fe005c0fd4b8fa9727eb012a663c54b8a13))

### [0.7.4](https://github.com/Mereithhh/van-blog/compare/v0.7.3...v0.7.4) (2022-08-08)

### ✨ Features | 新功能

- 优化文章获取接口 ([2e83b41](https://github.com/Mereithhh/van-blog/commit/2e83b41e09a9cce0fef7000e64d1bbd575e8bc85))
- 保存和发布草稿默认检测 more 标记 ([3e684df](https://github.com/Mereithhh/van-blog/commit/3e684dfc90cbd75e6deae8b00673dfa951ce12d6))
- 前台展示版本号 ([c81850b](https://github.com/Mereithhh/van-blog/commit/c81850b4cdadadd9a009fc439fea5a6ed1058d84))

### [0.7.3](https://github.com/Mereithhh/van-blog/compare/v0.7.2...v0.7.3) (2022-08-05)

### ✨ Features | 新功能

- 如果有 noViewer 的标记则不更新访客 ([758398d](https://github.com/Mereithhh/van-blog/commit/758398dd893eef279bcfcabb9b7536c98a4b6740))

### [0.7.2](https://github.com/Mereithhh/van-blog/compare/v0.7.1...v0.7.2) (2022-08-05)

### 👷 Continuous Integration | CI 配置

- 修改脚本 ([2757229](https://github.com/Mereithhh/van-blog/commit/2757229fc67b1b7cdee97be50dbf5d7c59508b8e))

### 🐛 Bug Fixes | Bug 修复

- 修复主站按钮显示 ([ab22fca](https://github.com/Mereithhh/van-blog/commit/ab22fcad4c723096f0e1dcd314b4f16ea36be38e))
- 搜索接口会带上已删除的文章 ([2d66b67](https://github.com/Mereithhh/van-blog/commit/2d66b670c3541a5a050858567f6701b4e5140de7))

### ✨ Features | 新功能

- 增加展示后台按钮配置项 ([6105162](https://github.com/Mereithhh/van-blog/commit/6105162133e33ce983522c5f8650bfc98d9eef94))
- 增加清洗数据脚本 ([76b47f9](https://github.com/Mereithhh/van-blog/commit/76b47f9c4c2fcd4e249dc4c85e79ceb343f536b9))

### [0.7.1](https://github.com/Mereithhh/van-blog/compare/v0.7.0...v0.7.1) (2022-08-04)

### ♻️ Code Refactoring | 代码重构

- 后台优化 query 获取逻辑 ([98b8600](https://github.com/Mereithhh/van-blog/commit/98b8600917d9e1b869faffdebadd931183fe50a8))

### 🐛 Bug Fixes | Bug 修复

- 后台关闭密码自动补全 ([b9f1272](https://github.com/Mereithhh/van-blog/commit/b9f12725f23e4bebdd6dbb59bf038347abd7c1ff))

### ✨ Features | 新功能

- 发布草稿增加成功提示 ([29e4943](https://github.com/Mereithhh/van-blog/commit/29e4943794f69606e79285985d708af4fc4b5af0))
- 后台会持久记忆表格 pageSize ([6ae55e9](https://github.com/Mereithhh/van-blog/commit/6ae55e9ab54db1033a67fc58cb082726b0362fbb))
- 后台编辑器增加快速插入 more 标记按钮 ([b6065c8](https://github.com/Mereithhh/van-blog/commit/b6065c8319df54f5d4040a23109e1b2a092fff7b))
- 增加并完善导航栏配置项，可配置显示网站名/logo ([9f9b79e](https://github.com/Mereithhh/van-blog/commit/9f9b79e9b3b3d6a718b783c3af1b41c27cde0180))
- 增加过时文章提醒 ([c0fa233](https://github.com/Mereithhh/van-blog/commit/c0fa233e30ad7af9bffe11d6338fc98f6444cc84))

## [0.7.0](https://github.com/Mereithhh/van-blog/compare/v0.6.0...v0.7.0) (2022-07-31)

### ✨ Features | 新功能

- 后台管理页面基本适配移动端 ([577ae12](https://github.com/Mereithhh/van-blog/commit/577ae123e8e4265ecfb77cca4ea16db04bad5254))
- 后台文章编辑页面移动端优化 ([dcdb423](https://github.com/Mereithhh/van-blog/commit/dcdb42370f72352c276dfba01939dac79c076919))
- 进一步优化后台移动端样式 ([c4bdac2](https://github.com/Mereithhh/van-blog/commit/c4bdac28e899a6b5c38e362899c93f9a64902714))
- 优化后台文章和草稿页的移动端展示 ([ec96722](https://github.com/Mereithhh/van-blog/commit/ec967224f2558603a9e7940ce5a94350d6ce436d))
- 优化后台移动端表单工具栏样式 ([9889732](https://github.com/Mereithhh/van-blog/commit/9889732ed364f790f87a2505f3b0a43a56214a99))
- 优化后台移动端卡片 extra 区域展示 ([1aac513](https://github.com/Mereithhh/van-blog/commit/1aac513fed7d3fbae244ec75a8731d829acd9bd2))
- 优化平板显示比例 ([09ea652](https://github.com/Mereithhh/van-blog/commit/09ea65255c4a5fabda8a140bfefd1322f2167887))

## [0.6.0](https://github.com/Mereithhh/van-blog/compare/v0.5.11...v0.6.0) (2022-07-31)

### ✨ Features | 新功能

- 后台增加文章分析卡片 ([0617528](https://github.com/Mereithhh/van-blog/commit/061752826cb55875cbf47635f4b599cf51444791))

### [0.5.11](https://github.com/Mereithhh/van-blog/compare/v0.5.10...v0.5.11) (2022-07-31)

### ✨ Features | 新功能

- 访客统计卡片增加更多信息展示 ([cbc5627](https://github.com/Mereithhh/van-blog/commit/cbc56278ac706c4249908b9ad3157a351c7ba37d))
- 后台访客相关数据可选择天数/条数 ([8189497](https://github.com/Mereithhh/van-blog/commit/8189497f671b5ebd0f4352319a72ce8c46eb4be6))
- 后台完善分析卡片&增加提示' ([11485cf](https://github.com/Mereithhh/van-blog/commit/11485cffb09cf8eff0a9c2d26755f9f52c87893b))
- 记录所有的 tabKey ([9fb7464](https://github.com/Mereithhh/van-blog/commit/9fb74649cd45c0850784f9822ee8861ad4c16982))

### [0.5.10](https://github.com/Mereithhh/van-blog/compare/v0.5.9...v0.5.10) (2022-07-31)

### ♻️ Code Refactoring | 代码重构

- 精简访客查询逻辑 ([0332821](https://github.com/Mereithhh/van-blog/commit/033282140111145c9b66e6744ea96a103d9ac91f))
- 文章增加 viewer 字段 ([f70ffc0](https://github.com/Mereithhh/van-blog/commit/f70ffc061b69dc9d0a45adbf0f8be4628765f96d))
- 优化访客记录查询逻辑 ([b15c85a](https://github.com/Mereithhh/van-blog/commit/b15c85afe97e95e652092474988c36da3a229510))
- 优化访客记录分析能力 ([9bca268](https://github.com/Mereithhh/van-blog/commit/9bca2687e49b9f58e33f54b27ce0eccd33612aa3))
- 优化分析接口返回数据 ([449bec0](https://github.com/Mereithhh/van-blog/commit/449bec0c3c7f2d408bf303c324c1e10192377d80))
- 重构-> analysisProvider ([bc9b2ea](https://github.com/Mereithhh/van-blog/commit/bc9b2ea956d7408fdc4f419ece53a7abf9b74ee7))

### ✨ Features | 新功能

- 后台首页拆分 part1 ([976f16e](https://github.com/Mereithhh/van-blog/commit/976f16ee69554b45c81af0ce6988ee8acb8f1208))
- 后台文章列表页访客数可排序 ([03870d3](https://github.com/Mereithhh/van-blog/commit/03870d3ef84548d018f601014324b691e31161d1))
- 后台文章页列表展示浏览量 ([37e2745](https://github.com/Mereithhh/van-blog/commit/37e2745db50bd80466a6287c5d32013cf3aa2fd2))
- 后台优化展示列表列宽 ([ccef55f](https://github.com/Mereithhh/van-blog/commit/ccef55f26d54eea347157a371ade001d095b472d))
- 记录全站最近访问时间 ([d262879](https://github.com/Mereithhh/van-blog/commit/d262879a5a8d33f546dfc1739d6402d70148b8a3))
- 记录最近访问文章的时间 ([4311b93](https://github.com/Mereithhh/van-blog/commit/4311b93a781404726df6861a0dd867334b4c6508))
- 实现了一部分概览分析接口 ([97e4176](https://github.com/Mereithhh/van-blog/commit/97e4176f8fa4c13ee5552303295bf7a05c025de2))
- 拓展分析接口查询能力，可查询指定数量 ([8bb56e9](https://github.com/Mereithhh/van-blog/commit/8bb56e9f2ed49326eff0b0ebebd9c2120c1ff34f))
- 完善 analysis 获取 viewerData 接口 ([f1386b1](https://github.com/Mereithhh/van-blog/commit/f1386b1d5db98c94c10bb883f120a6cefaa281c5))
- 完善方可分析 tab ([984359c](https://github.com/Mereithhh/van-blog/commit/984359c002943f376546d1c99f0783c5e6afa6e3))
- 增加更新最近访问文章逻辑 ([65b2a3b](https://github.com/Mereithhh/van-blog/commit/65b2a3bccfd037691092ad30aba861eb2407a288))

### [0.5.9](https://github.com/Mereithhh/van-blog/compare/v0.5.8...v0.5.9) (2022-07-30)

### ✨ Features | 新功能

- 优化 markdown 标题大小 ([3afcc6e](https://github.com/Mereithhh/van-blog/commit/3afcc6eda1dc9b3043718df66ad6688878c01821))

### [0.5.8](https://github.com/Mereithhh/van-blog/compare/v0.5.7...v0.5.8) (2022-07-30)

### 🐛 Bug Fixes | Bug 修复

- markdown 黑暗模式颜色不对 ([f8bd642](https://github.com/Mereithhh/van-blog/commit/f8bd6422a35792bb7a5c9063113a5e3d76bce3e3))

### [0.5.7](https://github.com/Mereithhh/van-blog/compare/v0.5.6...v0.5.7) (2022-07-30)

### ✨ Features | 新功能

- 导入功能适配新版 dto ([cb84bec](https://github.com/Mereithhh/van-blog/commit/cb84bec8bfefb9116a0091a7f0c993c1fbd216af))

### [0.5.6](https://github.com/Mereithhh/van-blog/compare/v0.5.5...v0.5.6) (2022-07-30)

### 🐛 Bug Fixes | Bug 修复

- 导出按钮点了没反应 ([edf96f2](https://github.com/Mereithhh/van-blog/commit/edf96f25f41a216ee8ce4cd324bd1f6bb8268da5))

### ✨ Features | 新功能

- 备案号变为可选配置 ([57f9900](https://github.com/Mereithhh/van-blog/commit/57f99009ddf7fef9e8e4b7aaa847bc0fe5777062))
- 备份导出访客信息 ([177a909](https://github.com/Mereithhh/van-blog/commit/177a909fceae049b2f5303756e8fc523885d8f54))
- 拆分站点配置 ([11b86d3](https://github.com/Mereithhh/van-blog/commit/11b86d3e4423d5c85df3a259f6d3a81024cee122))
- 继续抽离必填项&修复更新站点信息接口覆盖问题 ([d252796](https://github.com/Mereithhh/van-blog/commit/d2527962ba4d36d197bf45a9085ea3b4b735a9bf))
- 建站时间变为可选项 ([11a3685](https://github.com/Mereithhh/van-blog/commit/11a3685a5950e795e55afea4cebe41f1ad7110f7))
- 修改站点描述表单 ([ea2ec11](https://github.com/Mereithhh/van-blog/commit/ea2ec11f6129d706fdc476b1fdde546f77fcdb06))
- 优化初始化页面 ([4b2ba9f](https://github.com/Mereithhh/van-blog/commit/4b2ba9f2b85be6dcbd9a251702a00422b9342d6e))
- 增加不显示 submenu 的配置 ([0f66bfa](https://github.com/Mereithhh/van-blog/commit/0f66bfaaaaab26be12fd4f2243a8002ed672bc1f))
- 子导航栏没有分类不渲染 ([24c53e8](https://github.com/Mereithhh/van-blog/commit/24c53e8c56bcf44d48e7d9495b437c2b40582ed0))

### [0.5.5](https://github.com/Mereithhh/van-blog/compare/v0.5.4...v0.5.5) (2022-07-30)

### 🐛 Bug Fixes | Bug 修复

- 优化访客记录逻辑&移除定时任务 ([d5197de](https://github.com/Mereithhh/van-blog/commit/d5197de79e92d77db14ff12acf48de48a71e97de))

### [0.5.4](https://github.com/Mereithhh/van-blog/compare/v0.5.3...v0.5.4) (2022-07-30)

### ✨ Features | 新功能

- 优化单独每个页面的访客记录逻辑 ([0c528fa](https://github.com/Mereithhh/van-blog/commit/0c528fa25c39e1e3cab4c6c3e7ce02f44cd1337e))
- 自己实现文章访客记录 ([06a2966](https://github.com/Mereithhh/van-blog/commit/06a2966912636fd55d544304c42812bd18817a6b))

### [0.5.3](https://github.com/Mereithhh/van-blog/compare/v0.5.2...v0.5.3) (2022-07-30)

### ♻️ Code Refactoring | 代码重构

- 前台提升 globalState ([72f6460](https://github.com/Mereithhh/van-blog/commit/72f646013a1f41c6436ab27f43957d6c699d569f))
- themeContext -> globalConext ([b36a254](https://github.com/Mereithhh/van-blog/commit/b36a254fc3022098c1c96e27cf55c28a714ec421))

### ✨ Features | 新功能

- 前台监听路由跳转以优化访客记录逻辑 ([2899f51](https://github.com/Mereithhh/van-blog/commit/2899f51c0c5087153c0f8f7a98db8a991226b5aa))

### [0.5.2](https://github.com/Mereithhh/van-blog/compare/v0.5.1...v0.5.2) (2022-07-30)

### ✨ Features | 新功能

- 自己实现分页器以便调用 next/link ([b5f7505](https://github.com/Mereithhh/van-blog/commit/b5f750519a7756275ac13fd450fcf931f47381b0))
- markdown 样式改为模块导入以减少体积 ([da4713e](https://github.com/Mereithhh/van-blog/commit/da4713ee62a30f35a0b2400736e85c54acf5c612))

### 🐛 Bug Fixes | Bug 修复

- 分页展示问题 ([e770caf](https://github.com/Mereithhh/van-blog/commit/e770caf1ca1d1064bd8e5d58c147eaa306eb88c7))
- 修复记录浏览量逻辑 ([083d569](https://github.com/Mereithhh/van-blog/commit/083d569240fd7b09e75933185406a2cf7c48e337))

### [0.5.1](https://github.com/Mereithhh/van-blog/compare/v0.5.0...v0.5.1) (2022-07-30)

### 👷 Continuous Integration | CI 配置

- 删除通知 step ([24b23b9](https://github.com/Mereithhh/van-blog/commit/24b23b9311f9c4c84fb9991c6c3c14a11754db32))
- 增加一个测试 webhook 的 ci ([239a224](https://github.com/Mereithhh/van-blog/commit/239a224d711c211d29fa4ec687618e4b17392bf9))
- delete test ci ([cdda87b](https://github.com/Mereithhh/van-blog/commit/cdda87b836e25ffe85ab2dc9f92eacfb9b7c79d3))
- fix self use ([fb695f3](https://github.com/Mereithhh/van-blog/commit/fb695f37d1efbf89f8a47324d836319765b565a6))
- fix self use build ([445a8eb](https://github.com/Mereithhh/van-blog/commit/445a8eb96ac67fe88f8849c46980cce9c52305f7))
- test ([aaf6e81](https://github.com/Mereithhh/van-blog/commit/aaf6e81df304c331bdbb38575e4fae6f392f89bf))

### 🐛 Bug Fixes | Bug 修复

- 登录态没能持续保存的问题 ([45ad14e](https://github.com/Mereithhh/van-blog/commit/45ad14e2b8998bcdc32b25171399b67674c8ae59))

### ✨ Features | 新功能

- 按需更新字数缓存，不用定时了 ([3b47eda](https://github.com/Mereithhh/van-blog/commit/3b47eda7a6abc56efda9dc38561fbc550f15ce6c))
- 尝试为后台增加 pwa ([8fba5f3](https://github.com/Mereithhh/van-blog/commit/8fba5f35ace8eedfbdfccc2bb581d2814acde7ce))

## [0.5.0](https://github.com/Mereithhh/van-blog/compare/v0.4.2...v0.5.0) (2022-07-29)

### ♻️ Code Refactoring | 代码重构

- 前台渲染分离各个页面的接口和 props ([d223a76](https://github.com/Mereithhh/van-blog/commit/d223a76ffffcaaf1baacd6dad404bf6a3825ad69))

### 🐛 Bug Fixes | Bug 修复

- 修复前台分类 hover 样式问题 ([889103d](https://github.com/Mereithhh/van-blog/commit/889103da57994317ec8a11492674320964f0c7d4))

### [0.4.2](https://github.com/Mereithhh/van-blog/compare/v0.4.1...v0.4.2) (2022-07-29)

### 🐛 Bug Fixes | Bug 修复

- 修复 updatedAt 日期构建错误 ([8ce03e7](https://github.com/Mereithhh/van-blog/commit/8ce03e7dcc652cd7951ade582317ead8a80ea76d))

### [0.4.1](https://github.com/Mereithhh/van-blog/compare/v0.4.0...v0.4.1) (2022-07-29)

### 🐛 Bug Fixes | Bug 修复

- 备份后删除临时文件 ([26e317d](https://github.com/Mereithhh/van-blog/commit/26e317d73c3a5697172d34b4a8736a9339d6045d))

### 👷 Continuous Integration | CI 配置

- 构建版本号显示不正确 ([4c784b7](https://github.com/Mereithhh/van-blog/commit/4c784b7ef5c1db6dd0123037a55453daea58945c))

## [0.4.0](https://github.com/Mereithhh/van-blog/compare/v0.3.6...v0.4.0) (2022-07-29)

### ♻️ Code Refactoring | 代码重构

- 查询时指定不同的 viewer 以优化性能 ([5fbdbc0](https://github.com/Mereithhh/van-blog/commit/5fbdbc0b33bed846b09a7fe15bfdfbe1019c8c80))
- 分类设置界面分离接口 ([cf2db34](https://github.com/Mereithhh/van-blog/commit/cf2db34194f7307eabaa2fb81193b21c029bb575))
- 分离用户设置 ([5e8b813](https://github.com/Mereithhh/van-blog/commit/5e8b813cd98aed6198568e693abc90f36ad8640d))
- 后台 edit 页面解耦 initState ([b4ca1ad](https://github.com/Mereithhh/van-blog/commit/b4ca1ad358454f08e5d8d8fc4b9ebec8eca76ab5))
- 后台 welcome 页分离接口 ([8c781be](https://github.com/Mereithhh/van-blog/commit/8c781be0f0eb3f9b38aba7028627227ed2553a0a))
- 后台编辑关于我入口 ([dba9b8e](https://github.com/Mereithhh/van-blog/commit/dba9b8e1860067d11e1cfc247f9a74be33d1df50))
- 后台草稿页重构 ([2ade50b](https://github.com/Mereithhh/van-blog/commit/2ade50b9191a8c8093d7ec9759af2d72e2d2e93d))
- 后台分离导航菜单配置接口 ([9be4cf7](https://github.com/Mereithhh/van-blog/commit/9be4cf7ef5a3b401c0215b011cdf9c6e1e093b74))
- 后台分离捐赠管理接口 ([c95b9d0](https://github.com/Mereithhh/van-blog/commit/c95b9d0b4f7f81914acd159696c642cec7c4c7b9))
- 后台分离联系方式卡片接口 ([2d6870d](https://github.com/Mereithhh/van-blog/commit/2d6870d08267e4a5ead6a94ea0767d649a636846))
- 后台分离站点信息配置 ([db8b915](https://github.com/Mereithhh/van-blog/commit/db8b9150b248af1af172824c6856d9df81d389d7))
- 后台欢迎页接口适配 ([03dc24e](https://github.com/Mereithhh/van-blog/commit/03dc24e39e2179f2c2da935f7e17e2c73c2fc4e5))
- 后台获取分类解耦 initState ([9f79ef9](https://github.com/Mereithhh/van-blog/commit/9f79ef9ade95df4130e47a64ad385a15b4485fad))
- 后台接口完全分离 ([38d8911](https://github.com/Mereithhh/van-blog/commit/38d89115542d572130bee6f029e53d7c87821d86))
- 后台进一步解耦分类获取接口 ([3560d02](https://github.com/Mereithhh/van-blog/commit/3560d02a03e3292eb50d58a5f1f0ae81d27007ca))
- 后台文章页分离为单独的接口,以适应大批量的页面 ([b8eafce](https://github.com/Mereithhh/van-blog/commit/b8eafceee83ceec9851d071fb3381b54d0e95725))
- 后台友情链接分离接口 ([53c931c](https://github.com/Mereithhh/van-blog/commit/53c931c8880f82de700c9f36cfce2017be4ac269))
- 后台重构一部分编辑界面 ([a804088](https://github.com/Mereithhh/van-blog/commit/a8040889c994f776728fa9437d1e339c41c06d32))
- 文章查询应用视图 ([3745833](https://github.com/Mereithhh/van-blog/commit/37458332a344fd02b5e305ade13e10bb37d53ee4))
- 优化查询逻辑&时间段查询 ([eef2394](https://github.com/Mereithhh/van-blog/commit/eef2394177973dcda6a8b1950237064eceb06510))
- 优化查询文章字段范围 ([cefb4f1](https://github.com/Mereithhh/van-blog/commit/cefb4f173d97de48a55fa03bb720cabfdfd23dbf))
- 重构导出接口 ([376224e](https://github.com/Mereithhh/van-blog/commit/376224ef09f912f54d60be0ca5f7d998f6c92f57))
- server 调整 controller 规则 ([a5b8290](https://github.com/Mereithhh/van-blog/commit/a5b8290c268513e189eb5aea6d886b448a3716cf))

### ✨ Features | 新功能

- 编辑界面增加提示语和加载态 ([937c02c](https://github.com/Mereithhh/van-blog/commit/937c02c46fcf3eccc80b5dea3e8460cdf27d1f44))
- 草稿发布增加置顶优先级选项 ([9c11940](https://github.com/Mereithhh/van-blog/commit/9c119409433f89c4212daf4f90f54cc00a4d21f4))
- 调整后台布局&去掉 header ([889028d](https://github.com/Mereithhh/van-blog/commit/889028d28bd43607fef0f46d01543e7dedcccf56))
- 后台站点配置优化创建选项 ([95b5df3](https://github.com/Mereithhh/van-blog/commit/95b5df39413162c4c776cb3eeeb31f357a25d95f))
- 优化后台首页图表样式 ([7f50b05](https://github.com/Mereithhh/van-blog/commit/7f50b05bd4054d12c65580c0454d5be50d7a617b))
- 增加版本展示 ([a7c0ff6](https://github.com/Mereithhh/van-blog/commit/a7c0ff6ac5ac8fbf1e101f37148acdbaff6fef21))
- 增加总字数缓存 ([0857ea1](https://github.com/Mereithhh/van-blog/commit/0857ea1580ead74930a57f1bf669aa85f6169e2a))

### 🐛 Bug Fixes | Bug 修复

- 后台分类获取接口调用问题 ([188d2dd](https://github.com/Mereithhh/van-blog/commit/188d2ddcc713753460525871e7b47040041a55a8))
- 修改版本号文案 ([da6ac06](https://github.com/Mereithhh/van-blog/commit/da6ac06844011195a172d945c96603a811d91229))

### [0.3.6](https://github.com/Mereithhh/van-blog/compare/v0.3.5...v0.3.6) (2022-07-28)

### 🐛 Bug Fixes | Bug 修复

- 根目录误引入依赖 ([1441ded](https://github.com/Mereithhh/van-blog/commit/1441dedfdd930342529b40b1c41c3a28ecd344eb))
- 后台列表样式显示出错 ([5f8caec](https://github.com/Mereithhh/van-blog/commit/5f8caeccfc2cdf43d062854cfb1b9ca5a9a88b15))

### ✨ Features | 新功能

- 后台增加访客与访问量趋势图 ([320c296](https://github.com/Mereithhh/van-blog/commit/320c2967aa8ad05a1b18d8c152d2c402fd8356c4))
- 修改后台侧边栏图标 ([46d4b40](https://github.com/Mereithhh/van-blog/commit/46d4b40502185d0396c7f12818ba322672fbfae0))

### ♻️ Code Refactoring | 代码重构

- 后台草稿页抽离组件 ([b3d7552](https://github.com/Mereithhh/van-blog/commit/b3d7552ef28127cd030ecc911e51d1563d2d424c))
- 后台抽离发布草稿组件 ([3e96652](https://github.com/Mereithhh/van-blog/commit/3e9665217f6788b68d7981b5ab862eee9841ac63))
- 后台代码抽离组件(article) ([49e58ee](https://github.com/Mereithhh/van-blog/commit/49e58eeb5b736960c781b1cbd3188b58656d1ba5))
- 后台修复抽离组件问题 ([1da3656](https://github.com/Mereithhh/van-blog/commit/1da36566808446e1646addaaa3db3dad655bbb35))

### [0.3.5](https://github.com/Mereithhh/van-blog/compare/v0.3.4...v0.3.5) (2022-07-28)

### ✨ Features | 新功能

- 后台精简代码 ([a7f2158](https://github.com/Mereithhh/van-blog/commit/a7f215839ad87cca6092bd22f6717be4a898fe3b))
- 后台优化 editor 布局和样式 ([68f6b67](https://github.com/Mereithhh/van-blog/commit/68f6b67c10114d87d8c4a22f3d25450d583f9bbc))
- 后台增加加载状态 ([9de19c4](https://github.com/Mereithhh/van-blog/commit/9de19c4728495ab6da38a556f703dd8161357ba4))
- 删除后台 i18n 代码，精简一下 ([2b33c27](https://github.com/Mereithhh/van-blog/commit/2b33c270db18e1475f05cae44a7d99964f67acda))

### 🐛 Bug Fixes | Bug 修复

- 修复记录访客逻辑 ([792defa](https://github.com/Mereithhh/van-blog/commit/792defa8c7c8b5d40485a83ea3e1d89fd37de007))

### [0.3.4](https://github.com/Mereithhh/van-blog/compare/v0.3.3...v0.3.4) (2022-07-27)

### ✨ Features | 新功能

- 增加本站运行时间动态计算 ([273b0e8](https://github.com/Mereithhh/van-blog/commit/273b0e87bd97fb8afde2b1010ef609a6c3b5103a))

### 🐛 Bug Fixes | Bug 修复

- 主题切换定时器改为 10s 一次 ([8659611](https://github.com/Mereithhh/van-blog/commit/865961183e6de16aadb5eebb040292ba2b01be25))

### [0.3.3](https://github.com/Mereithhh/van-blog/compare/v0.3.2...v0.3.3) (2022-07-26)

### ✨ Features | 新功能

- 导航栏增加动效 ([9772e39](https://github.com/Mereithhh/van-blog/commit/9772e3922347aa88b2979bd4337f529c43ebf137))
- 文章标题可点击 ([80ffbad](https://github.com/Mereithhh/van-blog/commit/80ffbadb5b101dffc09cee5ca33907b012810a13))

### 🐛 Bug Fixes | Bug 修复

- 后台查看文章路由不对 ([1c046d4](https://github.com/Mereithhh/van-blog/commit/1c046d49ac4a4849fabb7b87406abed2bae79424))
- 文章卡片分类点击效果 ([9b172cf](https://github.com/Mereithhh/van-blog/commit/9b172cf9dfa8960182a9ef5b800d2df66ef401d7))

### [0.3.2](https://github.com/Mereithhh/van-blog/compare/v0.3.1...v0.3.2) (2022-07-24)

### 🐛 Bug Fixes | Bug 修复

- nginx 301 带端口问题 ([131f470](https://github.com/Mereithhh/van-blog/commit/131f470840e3144fef4f05cea7c5b568287f2776))

### 0.3.1 (2022-07-24)

### 🎉 Init | 初始化

- 初始化项目后端 ([cbc1c2d](https://github.com/Mereithhh/van-blog/commit/cbc1c2d7ffb262c57380d9c98078adb50edea2e5))

### 🐛 Bug Fixes | Bug 修复

- a min 修复图片 logo 不显示 ([0e7604f](https://github.com/Mereithhh/van-blog/commit/0e7604f870e06a728834b6c6897e810ce285a2e6))
- markdown 内部不显示项目符号 ([eccf3f1](https://github.com/Mereithhh/van-blog/commit/eccf3f1d862192ce491b3e1afde8403e2d404c43))
- markdown 溢出&toc 样式调整 ([dc4fada](https://github.com/Mereithhh/van-blog/commit/dc4fada5b59b0ff444092bb30f2d8c20c923eaf1))
- toc 增加目录文字 ([914b42b](https://github.com/Mereithhh/van-blog/commit/914b42b2bd4a794e2adc35cdd8a4fd9928a97665))
- website 加速打包 ([c925ac9](https://github.com/Mereithhh/van-blog/commit/c925ac9c3ff84cc43e10d6915ecbeb3b79cad61b))
- 不能正常显示初始化页面 ([3e1d082](https://github.com/Mereithhh/van-blog/commit/3e1d082e7fc344e54038072fc7c2e23d3095a3b6))
- 代码复制按钮错位 ([8bf5f5a](https://github.com/Mereithhh/van-blog/commit/8bf5f5a7936f9f97b0ce00936975368e9bf7b465))
- 侧边导航栏按钮样式 ([696d6d8](https://github.com/Mereithhh/van-blog/commit/696d6d8e947a4d1fcf98b7381c7917ab442e7cbf))
- 修复 type ，顺利启动 ([af70db4](https://github.com/Mereithhh/van-blog/commit/af70db43f0b1c396721ad17bfdbc24ab878cdf09))
- 修复主题切换闪屏 ([4ca5a24](https://github.com/Mereithhh/van-blog/commit/4ca5a243d110b368e22f7f238c92e6ae184a23dc))
- 修复了搜索卡片快捷键滚动条消失的问题 ([1b3a882](https://github.com/Mereithhh/van-blog/commit/1b3a8823fff3bbf64c896232a50b8e62dbb8fd9e))
- 修复可能存在的主题切换定时器问题 ([198f28a](https://github.com/Mereithhh/van-blog/commit/198f28a87bb5153d4efd5e3986d810eee1077ef2))
- 修复打赏二维码样式 ([297aec1](https://github.com/Mereithhh/van-blog/commit/297aec1c7531ef03fb028f4c2ba289713483f52b))
- 修改 google 标签为 Script ([0c30421](https://github.com/Mereithhh/van-blog/commit/0c30421c9c889203013461c470f1d4ffe13376ff))
- 修改日落时间判断 && 修复发布文章报错 ([9010db2](https://github.com/Mereithhh/van-blog/commit/9010db20a07108f0c12c66abc2c881a7caa506b1))
- 公共 API 暴漏信息过多 ([5d3cf17](https://github.com/Mereithhh/van-blog/commit/5d3cf172d07d417d2b903658befe7ec0fd85aba3))
- 初始化表单增加用户名选项&导入报错 ([f3d1a0b](https://github.com/Mereithhh/van-blog/commit/f3d1a0b5021985421eddee857f022e9e26aed3ac))
- 前台改为客户端运行时获取链接 ([5aa333a](https://github.com/Mereithhh/van-blog/commit/5aa333ae23b030e0635d540c6b90c35f93d5ab77))
- 去掉 next/image ([c15f1b5](https://github.com/Mereithhh/van-blog/commit/c15f1b56a22e59b20df7f7f12108b6ce89c01600))
- 反代端口不对 ([6719a42](https://github.com/Mereithhh/van-blog/commit/6719a42ff7cb1683c85918afd2620bbe109b66a4))
- 后台主站链接 ([570bb24](https://github.com/Mereithhh/van-blog/commit/570bb24dcb6c87187f0d389a2d058cabe57fda33))
- 后台编辑器默认分屏，全名 zindex 修复 ([26362bb](https://github.com/Mereithhh/van-blog/commit/26362bb92976399e2c6ddf91a59aebbfbf11c25f))
- 图片允许 domain 问题无法显示图片 ([038d933](https://github.com/Mereithhh/van-blog/commit/038d9330be67ebc7daac8a33106946c0733509f3))
- 增加销毁实例 ([ffbdfa0](https://github.com/Mereithhh/van-blog/commit/ffbdfa096cde8ff4d9ac3bface8d0bd626685fc1))
- 导航栏点击范围过小 ([e827caa](https://github.com/Mereithhh/van-blog/commit/e827caa17cf75b9fc67fbea506e11bc1a9540750))
- 尝试修复主题切换摆平 ([3a5c4b5](https://github.com/Mereithhh/van-blog/commit/3a5c4b5b89e6dda62854224cce1756eac0eefc16))
- 工具站跳转为外部链接 ([e9ddbe6](https://github.com/Mereithhh/van-blog/commit/e9ddbe606fb64266f4c4861e7a52a8511d65c3f1))
- 搜索接口大小写不敏感; ([371bdcf](https://github.com/Mereithhh/van-blog/commit/371bdcf66420b52e723ea06277a81d8c3d76dfab))
- 无障碍优化 & 修复 dayjs 报错 ([e12bb1f](https://github.com/Mereithhh/van-blog/commit/e12bb1fb8fc2a50dd371adfa2bf41f9deb70adcb))
- 有序列表显示异常 ([bc78612](https://github.com/Mereithhh/van-blog/commit/bc78612c38ae85c11637e37084e20ae7fb9fa986))
- 有序列表显示异常 ([98d3e75](https://github.com/Mereithhh/van-blog/commit/98d3e752c145993b789614556c9ac3be431802e7))
- 本地开发不计入统计分析 ([f2a25e8](https://github.com/Mereithhh/van-blog/commit/f2a25e82de832813c937b0f09118666f6506e0b3))
- 极端情况页面展示顺序 ([a93a6a2](https://github.com/Mereithhh/van-blog/commit/a93a6a275f2d69886a35939216b6a29acfafad34))
- 构建时带缓存 ([bfda43e](https://github.com/Mereithhh/van-blog/commit/bfda43e7095148e220a0447f11ae69ed23b11a65))
- 某些卡片被撑大 ([ad4ce5b](https://github.com/Mereithhh/van-blog/commit/ad4ce5b938566741699a41f731eb26b8f8a297d9))
- 某些文章卡片撑大问题 ([39dceb5](https://github.com/Mereithhh/van-blog/commit/39dceb5a77baa95721dca555d441301c6118e6be))
- 登录用户名和密码表单逻辑 ([3ee0f4b](https://github.com/Mereithhh/van-blog/commit/3ee0f4bb283b95201aa55ce3d2c94699a2d3c2a0))
- 移动端打赏显示不出来 ([712103d](https://github.com/Mereithhh/van-blog/commit/712103d70762667c8e9a620c74382ff4bbcd6f69))
- 联系方式二维码新弹窗口 ([a5f85a2](https://github.com/Mereithhh/van-blog/commit/a5f85a20282b9e1f9edae192394ab58ec312c4f9))
- 自动切换主题 ([e6ada0f](https://github.com/Mereithhh/van-blog/commit/e6ada0f9057e21f7b2518fcacbe8d8a0afbd637a))
- 自动切换主题时的图标显示 ([e58825c](https://github.com/Mereithhh/van-blog/commit/e58825cf2455a9938d02ce9fda3dfff92512019a))
- 调整 about 卡片样式 ([f6d0073](https://github.com/Mereithhh/van-blog/commit/f6d00734bfd032b498483a693b3c68c330ba1a76))
- 调整 markdown 样式 ([3ddc6cf](https://github.com/Mereithhh/van-blog/commit/3ddc6cf4765d6e2f1fc5d61eb3530d6c1c6a61f1))
- 调整字体大小 ([560260f](https://github.com/Mereithhh/van-blog/commit/560260f19c09829b5ae30f3781a6ced1013fa703))

### ✨ Features | 新功能

- 前台 api 不用 route 用代理 ([33efe2a](https://github.com/Mereithhh/van-blog/commit/33efe2ad162a9b2b96883c564edde739dbe2f2dc))
- appModule 添加 provider 和 controller，顺利启动 ([47425b5](https://github.com/Mereithhh/van-blog/commit/47425b5a812bcb78a2e183ed942deda0c8ad2ce7))
- hover 状态优化 ([bbcdfa2](https://github.com/Mereithhh/van-blog/commit/bbcdfa2c6ee36182fdedec7759388f3889fdea8a))
- init admin 项目 ([359bf84](https://github.com/Mereithhh/van-blog/commit/359bf8473a424bf7bc8734958742866875a1bb82))
- proxy 容器通过环境变量传入主机名 ([d6118ae](https://github.com/Mereithhh/van-blog/commit/d6118ae1f2d669bda3680f84a7e101f6ead120ce))
- SEO 增加站点描述 ([4889da6](https://github.com/Mereithhh/van-blog/commit/4889da6a81b1e75ef4cafc29e966cd1239f0ec84))
- theme 重构为 context ([8ff1c26](https://github.com/Mereithhh/van-blog/commit/8ff1c26be6d2a8167785acbc7a5a54a206595b62))
- TOC 和作者卡片适配暗色模式 ([ebadd1d](https://github.com/Mereithhh/van-blog/commit/ebadd1dbafa381cc3e021781fc3e38e76a90cdf1))
- waline 地址可配置化 ([2f6d412](https://github.com/Mereithhh/van-blog/commit/2f6d41250425e826606d625bdc18ea05080bc9fc))
- 不切换主题自动根据时间切换 ([0fe3881](https://github.com/Mereithhh/van-blog/commit/0fe3881455fd899776c6bcb10c23ea2c4ea2dead))
- 主题切换按钮样式 ([72a0c8f](https://github.com/Mereithhh/van-blog/commit/72a0c8f999915e7a56d8cf683af855724a81b9f7))
- 主题初始化白屏减少' ([efe289d](https://github.com/Mereithhh/van-blog/commit/efe289d4786782afea6dd6a5767b16406ac95f7b))
- 主题自动切换模式 ([1afb52e](https://github.com/Mereithhh/van-blog/commit/1afb52e1e43f5aa37fde3b892f60682d3d160e23))
- 付款码黑暗模式适配 ([67a89ba](https://github.com/Mereithhh/van-blog/commit/67a89ba5f4124e419efe071315f21e570f822bb4))
- 优化 ga 和百度分析加载 ([7c6fd88](https://github.com/Mereithhh/van-blog/commit/7c6fd88e9ab35ab8f7f9dc08820c291ffe989ead))
- 优化后台管理页面 ([ccc013b](https://github.com/Mereithhh/van-blog/commit/ccc013b318d824b45b2193bd93fd803b32ddcd9c))
- 优化搜索接口&修改优先级 ([b13e8f7](https://github.com/Mereithhh/van-blog/commit/b13e8f742e5b2f33745138694ca8ab0e91937ebd))
- 作者 logo 适配暗色模式 ([a3ac5d5](https://github.com/Mereithhh/van-blog/commit/a3ac5d54fd746243a7d148b2347eb6d61cb87776))
- 侧边栏和站点名称展示 ([555d8af](https://github.com/Mereithhh/van-blog/commit/555d8af9e20cb8728990a96e0c1b53bc3d7a2b09))
- 修复文章排序&修复文章没 Toc 的展示 ([5221d76](https://github.com/Mereithhh/van-blog/commit/5221d769b00cd8d8fa056e068fed28b28bd8ca58))
- 修改初始化 midware ([786959c](https://github.com/Mereithhh/van-blog/commit/786959cc72ff43f0de1e5f9935d4ddc4112e9735))
- 分页器适配黑暗模式 ([98c59b2](https://github.com/Mereithhh/van-blog/commit/98c59b211e498cc96b366863b9432bb58b5a3093))
- 切换回 headroom.js 并完美适配 ([1590d89](https://github.com/Mereithhh/van-blog/commit/1590d89c5e7b7542a9980f8072d406913666f0bc))
- 初步添加 swagger ([a2d6062](https://github.com/Mereithhh/van-blog/commit/a2d6062744d57cd2848685f743a48b09e552f4ab))
- 前台去掉一些报错，文章卡片展示改为最近修改时间 ([9ffa7c4](https://github.com/Mereithhh/van-blog/commit/9ffa7c46c5aea5b2a5c3aac2913709777defdadd))
- 前台增加 ISR 选项 ([02ed98e](https://github.com/Mereithhh/van-blog/commit/02ed98ec6cd402a0ff1c0d7f26061bf0eb6f98c6))
- 前台完善了一些基础组件和样式 ([fa183e7](https://github.com/Mereithhh/van-blog/commit/fa183e741cd9c56f5d8c81288b1e982e84290c4a))
- 前台文章卡片子标题改为 icon ([ab71a72](https://github.com/Mereithhh/van-blog/commit/ab71a72f14061cc5008b8cd30a9285ee427c90bc))
- 前台根据配置渲染导航栏 ([a50def6](https://github.com/Mereithhh/van-blog/commit/a50def6d2328a82b7f46da01bf942a119812319e))
- 前台适配 headroom ([ab3f4b7](https://github.com/Mereithhh/van-blog/commit/ab3f4b79e313ed27058a0a4f0fabd16a7d43332b))
- 前台适配评论框 ([b1dfcdd](https://github.com/Mereithhh/van-blog/commit/b1dfcdd9b9811b1deee725db0647bb633006f551))
- 可以正常登录后台 ([fe207cd](https://github.com/Mereithhh/van-blog/commit/fe207cdbc2f364b4781181e3428d540b34f44c69))
- 可以跑的一版 docker-compose ([0df43ed](https://github.com/Mereithhh/van-blog/commit/0df43ed58f0aa35a6dfc5e565181b2d8bf1159a2))
- 后台完善一部分编辑器 ([0e81d4e](https://github.com/Mereithhh/van-blog/commit/0e81d4ea984c70178ea5766107c3d2080d39df8b))
- 后台完善编辑器相关功能 ([7fb5ab6](https://github.com/Mereithhh/van-blog/commit/7fb5ab6f8c7a136b3580a43923d4d2111b584085))
- 后台捐赠管理 ([9d2c1fe](https://github.com/Mereithhh/van-blog/commit/9d2c1fea1426d26b05bf75bf0a3b06b477e43968))
- 后台管理完善关于页面的编辑修改 ([008e58c](https://github.com/Mereithhh/van-blog/commit/008e58c0601f22b4e47fa08fec88be54cd609861))
- 后台设置可修改密码和用户 ([ec3c7f7](https://github.com/Mereithhh/van-blog/commit/ec3c7f794f2931a9a857679ef532809ea3e82ba1))
- 因为图片未知大小，所以 markdown 内用原生的 img 标签，并增加延迟加载 ([034c3ba](https://github.com/Mereithhh/van-blog/commit/034c3ba8753eb6f9d89d173b7b62809d54b0c3d2))
- 图标颜色统一 ([dd48286](https://github.com/Mereithhh/van-blog/commit/dd482860babc75328bb23ab2f19cb748961b4194))
- 图片延迟加载 ([b6ac00c](https://github.com/Mereithhh/van-blog/commit/b6ac00c67fb32d453ff76b34f78fe33234d5a20d))
- 基本完善时间线 ([ec729c6](https://github.com/Mereithhh/van-blog/commit/ec729c6fe5c5cc0f2af5d3f4f89c9619083a525e))
- 基本完善首页 ([3a454b2](https://github.com/Mereithhh/van-blog/commit/3a454b22a9a3750a048fb2ab5b3e63864f11e5e9))
- 基本样式（导航栏和末尾) ([8d921d3](https://github.com/Mereithhh/van-blog/commit/8d921d31f66f5c0151cc38f2081f0db7369a9130))
- 增加 favicon 修改功能 ([15b0e8d](https://github.com/Mereithhh/van-blog/commit/15b0e8d14e60df2695611af772f64edacb8a646b))
- 增加 markdown 组件 ([58c61a0](https://github.com/Mereithhh/van-blog/commit/58c61a04b30837811dff83c35ce733ee2b96ff5b))
- 增加 poweredBy ，调整 footer 顺序 ([1d75ad0](https://github.com/Mereithhh/van-blog/commit/1d75ad0ebe09f0107b204879b8cfa20f241bc4d4))
- 增加 sdk ([ce5786b](https://github.com/Mereithhh/van-blog/commit/ce5786be8e17b9f7cf765585ab85e34f64e750d3))
- 增加 users 和初始化模块/接口 ([7f6f882](https://github.com/Mereithhh/van-blog/commit/7f6f882a5ce21bd8e507113efe83823dcecc50b5))
- 增加 robot.txt&整理代码 ([32dddb3](https://github.com/Mereithhh/van-blog/commit/32dddb32e5fbe4da6f6bff17e5c36caa008964b0))
- 增加 server dockerfile ([b995768](https://github.com/Mereithhh/van-blog/commit/b9957687700d331eb6373f852bc1529c1a1b44d8))
- 增加 server 和 admin 的 dockerfile ([f62d745](https://github.com/Mereithhh/van-blog/commit/f62d745984eb6e4e359560170ad8c4f1445958a9))
- 增加一些运行时的环境变量配置' ([6a6a22a](https://github.com/Mereithhh/van-blog/commit/6a6a22ac33fbba6ecd42e1359b6fcf2f8fc61c13))
- 增加不启用评论系统的选择 ([a2b7407](https://github.com/Mereithhh/van-blog/commit/a2b74072338cb8823a977defb8d8cc135f078fad))
- 增加了一部分 dto 和 schemes ([1edaf0f](https://github.com/Mereithhh/van-blog/commit/1edaf0f013009a267899959cc233f98aeafa8e0b))
- 增加初始化管道&未初始化自动重定向至 /admin/init ([69c8e30](https://github.com/Mereithhh/van-blog/commit/69c8e30655c2ab35d2e6e721474e04fa558b3e0d))
- 增加前端页面 ([ffd3dea](https://github.com/Mereithhh/van-blog/commit/ffd3deac90634b4009f432520a21de8f2b11c3e0))
- 增加导航栏接口 ([0a30832](https://github.com/Mereithhh/van-blog/commit/0a308329b8bd995f3143fe1fb10551144e66f479))
- 增加快捷键图标 ([faa2553](https://github.com/Mereithhh/van-blog/commit/faa25534fc815fd94ae772c0992af4a67efd4a5b))
- 增加数学公式支持 ([c76f562](https://github.com/Mereithhh/van-blog/commit/c76f56238f51bc803c1210df32a585d5158b763f))
- 增加百度与 GA 分析选项 ([f156475](https://github.com/Mereithhh/van-blog/commit/f156475904a6ede0133c48e3a4e5563fedc234a5))
- 增加管理的 all 接口 ([fedcb64](https://github.com/Mereithhh/van-blog/commit/fedcb6464e1339dd6e96bd205492ec938bc8a944))
- 增加置顶选项 ([63ccfcf](https://github.com/Mereithhh/van-blog/commit/63ccfcf640c7b8f987e92a1809dd67872a1e7b6d))
- 增加获取访客数的接口 ([bd97905](https://github.com/Mereithhh/van-blog/commit/bd9790553440251cffeccbdf4083b1c3b9bc9612))
- 增加访客和访问数统计 logo ([3545839](https://github.com/Mereithhh/van-blog/commit/3545839f91588e12148ac96a393657a19bcfd302))
- 增加返回顶部按钮 ([79f4105](https://github.com/Mereithhh/van-blog/commit/79f410541fe7978ff48bd24789d23d817043d39e))
- 增加配置文件 ([101e43a](https://github.com/Mereithhh/van-blog/commit/101e43aa77b1b4e0b6dfcd980c815091f736cb9c))
- 增加黑暗模式相关的一些配置项 ([5921d04](https://github.com/Mereithhh/van-blog/commit/5921d04c22166a5e1db41a40a712ff0ece6c3230))
- 复制弹窗适配暗色模式 ([f0cdeb5](https://github.com/Mereithhh/van-blog/commit/f0cdeb552c5789e5d1d04c4eed9724cb293864eb))
- 完善 markdown 主题 ([32adb62](https://github.com/Mereithhh/van-blog/commit/32adb62b2e0dec5b1a7d7b2a72f463d7ee8672b0))
- 完善一部分前端框架 ([8b7927e](https://github.com/Mereithhh/van-blog/commit/8b7927e424d991547b6a0e059cc394b44d227a81))
- 完善上下页切换 ([c8af7ba](https://github.com/Mereithhh/van-blog/commit/c8af7bacd888cbb22eedb2fc6568701bfb85b702))
- 完善代码高亮" ([c6f70f6](https://github.com/Mereithhh/van-blog/commit/c6f70f65582ea1951e184ee330f1fe4ae2ae5d82))
- 完善初始化相关逻辑，可顺利初始化 ([6a7ddfe](https://github.com/Mereithhh/van-blog/commit/6a7ddfebe2c4ecd601b25dffe10ebc0611fdca76))
- 完善后台品牌化替换 ([b95ea79](https://github.com/Mereithhh/van-blog/commit/b95ea79300950f67d05df1ccae4e47d30517818e))
- 完善导入功能 ([690dca7](https://github.com/Mereithhh/van-blog/commit/690dca7f0d903295d57a30132d1b30547c90d378))
- 完善导出功能，增加导入接口 ([3e36110](https://github.com/Mereithhh/van-blog/commit/3e36110229440bf09186717a5399da181479afc6))
- 完善报错 ([d93bc07](https://github.com/Mereithhh/van-blog/commit/d93bc07e14d2af31e50e37b204b94196d5ac9e4b))
- 完善捐赠逻辑 ([a931627](https://github.com/Mereithhh/van-blog/commit/a931627c24f884a44254a03276583c0e43bba66c))
- 完善搜索卡片 ([5afcf91](https://github.com/Mereithhh/van-blog/commit/5afcf91cf3de213a616cbc387ca3f5ae85bfc1f5))
- 完善搜索卡片状态管理 ([bd2a2ff](https://github.com/Mereithhh/van-blog/commit/bd2a2ffc0e45714dc9b1c99ca69f86906d590129))
- 完善文章页和 TOC ([07c5896](https://github.com/Mereithhh/van-blog/commit/07c589606d026af594b7b7e5378a756b6ddc9793))
- 完善登录和 jwt 认证模块 & 增加守卫 & 验证初始化 ([4ac32f1](https://github.com/Mereithhh/van-blog/commit/4ac32f185f450dc7a71d31396030cc4302a800a5))
- 完善登录登出逻辑 ([e79366d](https://github.com/Mereithhh/van-blog/commit/e79366d8d8ca8ef244359bbd9bb344b6d4db865a))
- 完善编排 ([f6ee1e3](https://github.com/Mereithhh/van-blog/commit/f6ee1e3d162a2b2bd70931512c656abb6c7dba62))
- 完善部分联系方式卡片 ([200a986](https://github.com/Mereithhh/van-blog/commit/200a98602403d812f0efe8db1bd2b3d3a77ca16d))
- 完善预览卡片 ([c2b368c](https://github.com/Mereithhh/van-blog/commit/c2b368c5168129eb1ac06c756ea2acf1b8aedaf2))
- 完善首页页面列表 ([e450e92](https://github.com/Mereithhh/van-blog/commit/e450e9219ea27f1b485c65b31613291124c4720b))
- 完成一部分 controller ([69b8ad8](https://github.com/Mereithhh/van-blog/commit/69b8ad85cec7881ec95d01a7f2e006a4310faa29))
- 导航栏 hover 区域增大 ([7f9d2ed](https://github.com/Mereithhh/van-blog/commit/7f9d2ed551d825ede2d73531f34f266bdc7d45b7))
- 小尺寸搜索框样式 ([1b67d7b](https://github.com/Mereithhh/van-blog/commit/1b67d7bc1304c0f9e15f4c59bf17ed5ab02370ad))
- 小尺寸样式优化 ([e204ef9](https://github.com/Mereithhh/van-blog/commit/e204ef972751beaf7087cd06d41764ad7d28402d))
- 开发了一部分最近评论 ([7b32982](https://github.com/Mereithhh/van-blog/commit/7b32982fbf8e75613bfb164a6d59995be710c7d3))
- 微信二维码暗色模式&优化主题切换逻辑 ([20e3c30](https://github.com/Mereithhh/van-blog/commit/20e3c30562dbc8815aeb822ae2a0103b0e889295))
- 快捷键关闭搜索框 ([ff76407](https://github.com/Mereithhh/van-blog/commit/ff7640715c4b3383dafe28f98358effe0e96116d))
- 快速搜索快捷键 ([3aaafc4](https://github.com/Mereithhh/van-blog/commit/3aaafc4283b381217cca7bb63f01e07dc3af3f2f))
- 总览标签页 ([edf6543](https://github.com/Mereithhh/van-blog/commit/edf6543ce51fdeefec4e012e34fb6a7e3a44ba0e))
- 抽取评论组件&去掉没用的引用 ([e0ed165](https://github.com/Mereithhh/van-blog/commit/e0ed1657120208097b27e134ac1c231a3072f351))
- 搜索框适配暗色模式 ([d8fb9cd](https://github.com/Mereithhh/van-blog/commit/d8fb9cdf1db947d74ca33f1db02a03d06e92dbfc))
- 整理目录结构，去除未引用的代码 ([4b315e6](https://github.com/Mereithhh/van-blog/commit/4b315e61880d7614749ebd7a02bb73ce17d1e292))
- 文章管理:标题搜索和删除" ([39dbb09](https://github.com/Mereithhh/van-blog/commit/39dbb09ff107f9c3f6ff90ce232509f6e84d78c4))
- 文章管理适配了列表页和新建文章 ([3a3ce69](https://github.com/Mereithhh/van-blog/commit/3a3ce697d9fe784efd3aab6b2331ecaf5d73b0dd))
- 文章页全面适配黑暗模式 ([2660b2c](https://github.com/Mereithhh/van-blog/commit/2660b2c68a6f06fd9e1f90d9855836d30b6d4c24))
- 时间线溢出格式 ([94ae4f0](https://github.com/Mereithhh/van-blog/commit/94ae4f093ae2a25bb9d459d0131c266aa456a032))
- 暗色模式调整正文颜色&阅读全文按钮 ([95ac333](https://github.com/Mereithhh/van-blog/commit/95ac333d74251a84e0232d3d2ed659a3f1c90ab1))
- 更新 all in one 编排 ([b46b7cb](https://github.com/Mereithhh/van-blog/commit/b46b7cbc1e31aec59f8320ccc967929730a0975e))
- 标题顶置功能 ([eeda38b](https://github.com/Mereithhh/van-blog/commit/eeda38b7c5e48a6d462f7d42ab9465a1b7ed93ec))
- 注释没用的 console.log ([fd4282f](https://github.com/Mereithhh/van-blog/commit/fd4282f909ae1be09df5328173430228d3a82a9d))
- 现有的图片采用 next/future/image 优化 ([6a8b400](https://github.com/Mereithhh/van-blog/commit/6a8b400effc3257b0ac8063907d24d0a02231c7a))
- 用 context 实现了主题切换 logo 跟随 ([a2ee508](https://github.com/Mereithhh/van-blog/commit/a2ee508d33ad54e76aeb32e70e1961d9df416348))
- 略微修改黑暗模式配色 ([c7cb809](https://github.com/Mereithhh/van-blog/commit/c7cb8098ec7d038ac578b75068224f9e22b4fd2a))
- 目录超长的溢出展示& 跟随滚动 ([e7efcfe](https://github.com/Mereithhh/van-blog/commit/e7efcfe830f485d54689825ce5c16b64ec08c86a))
- 移动端滑动菜单框架 ([05b9062](https://github.com/Mereithhh/van-blog/commit/05b9062a3de978defb91e33e16d5b41612b73903))
- 移动端点完导航收回去 ([96668c0](https://github.com/Mereithhh/van-blog/commit/96668c09a589145ba4c319d72954e49820c1c65a))
- 管理后台友情链接&联系方式 ([ac7fc6e](https://github.com/Mereithhh/van-blog/commit/ac7fc6e18d97ecabb3c83b53ade383f84d441f9b))
- 管理后台完善分类相关逻辑和站点配置 ([054dd3f](https://github.com/Mereithhh/van-blog/commit/054dd3fe37ec79644e68d269a1a8767b496b2042))
- 管理后台完善草稿相关逻辑 ([0e342dc](https://github.com/Mereithhh/van-blog/commit/0e342dc9edaeca37333999b31870053e81829bfb))
- 管理后台时间筛选和分类获取 ([4748770](https://github.com/Mereithhh/van-blog/commit/4748770d112ee616ca59323fd9e6b535d39a394a))
- 管理后台标签搜索 ([9ce8d67](https://github.com/Mereithhh/van-blog/commit/9ce8d67d044bd7cdef6ebd6008fe34e779c862ff))
- 管理后台标签的创建筛选和搜索 ([bea9f73](https://github.com/Mereithhh/van-blog/commit/bea9f7374208122ae32dfa30e1393814121a6928))
- 管理后台设置面板保存 tab ([df41a48](https://github.com/Mereithhh/van-blog/commit/df41a48596f789452b16e35bcee58e638586ea2f))
- 管理后台适配导航配置接口 ([20b2b1a](https://github.com/Mereithhh/van-blog/commit/20b2b1ab0b8e29f94538de7cad18ad1abd4bc9a3))
- 网站 logo 黑暗模式切换 ([3d8289b](https://github.com/Mereithhh/van-blog/commit/3d8289b0b4bf9de20aa17e5a20296d1aca462e5a))
- 联系方式二维码弹窗 ([4b7647e](https://github.com/Mereithhh/van-blog/commit/4b7647eb060b1892035cfc95e08bc48b8c6592fc))
- 自己实现了访问量统计 ([7e6194a](https://github.com/Mereithhh/van-blog/commit/7e6194a6393dc9fb8d7c1c4d3519dbb9b00353b9))
- 补全一些 provider ([068ea53](https://github.com/Mereithhh/van-blog/commit/068ea53762081e40dcd65a9d29cdf46ce7dc92cd))
- 补全接口和 provider ([16e3e3a](https://github.com/Mereithhh/van-blog/commit/16e3e3af3521f30f957489aa49566fe3a2287b71))
- 规范返回格式 ([9b63666](https://github.com/Mereithhh/van-blog/commit/9b63666e44434c334e7eaf3a4e782f3b255733c8))
- 访客数接口实现 ([a034e67](https://github.com/Mereithhh/van-blog/commit/a034e67c46dba2c10c676ddc36178acc17951292))
- 评论区表情搜索暗色 ([de87e6e](https://github.com/Mereithhh/van-blog/commit/de87e6ea9bfd1f52225db22df0d2105faea27f04))
- 调整字体大小 ([1e017ff](https://github.com/Mereithhh/van-blog/commit/1e017ff303d4374b57089f894d973c8a3f8f0d89))
- 调试增量渲染配置 ([cad86b1](https://github.com/Mereithhh/van-blog/commit/cad86b14a5e14b080f26dfb56ca1256e7fdecd03))
- 适配了一部分黑暗主题 ([33c6b93](https://github.com/Mereithhh/van-blog/commit/33c6b9329f15f8c93f2c3190e112f09544ceed2c))
- 适配百度分析 ([d2627f1](https://github.com/Mereithhh/van-blog/commit/d2627f172399275f11edde201e3e5ad98d9e78d8))
- 适配移动端导航栏相关 ([abdced0](https://github.com/Mereithhh/van-blog/commit/abdced08fc5afe6eccf2969f987479ee4a02ab15))
- 集成谷歌分析 ([ab6999d](https://github.com/Mereithhh/van-blog/commit/ab6999d9a2c8cc855c3be0b1011a528582834688))
- 页面内增加项目主页 ([30c34f2](https://github.com/Mereithhh/van-blog/commit/30c34f25e2c3ba2abae8dc8218886bddbbda7acc))

### 🚀 Chore | 构建/工程依赖/工具

- **release:** 0.1.1 ([28b7973](https://github.com/Mereithhh/van-blog/commit/28b7973ccf2f9841656f6ec363a5be7a00f809c0))
- **release:** 0.1.1 ([e86da48](https://github.com/Mereithhh/van-blog/commit/e86da488e1b0ced05382b5282812de36659f52b2))
- **release:** 0.3.1 ([d73b82f](https://github.com/Mereithhh/van-blog/commit/d73b82f469d4300dd7cd7b1c7dc6fda9adc95152))
- **release:** 0.3.1 ([ff3989c](https://github.com/Mereithhh/van-blog/commit/ff3989c32b5ad4f3ea3bea5f7573fbfaaf630e5c))

### 👷 Continuous Integration | CI 配置

- fix ([4fb4051](https://github.com/Mereithhh/van-blog/commit/4fb4051cdeaf9751279dc8f2563df7ebfa718994))
- fix ([8ac8923](https://github.com/Mereithhh/van-blog/commit/8ac89230d111ade8a49b01ceb604549644f264a3))
- revert ([5f30659](https://github.com/Mereithhh/van-blog/commit/5f3065955fc49362b0b4bd9798b3d898224d51f5))
- revert version ([7ab137f](https://github.com/Mereithhh/van-blog/commit/7ab137f249a1428e0226406c56504584347a0320))
- update ([a994df9](https://github.com/Mereithhh/van-blog/commit/a994df94713640da9049852bbe525315c5d7efdb))
- update ([00a24e8](https://github.com/Mereithhh/van-blog/commit/00a24e869c0b143df5a27a68f80b8c6ec242ef26))
- update ([6a86f98](https://github.com/Mereithhh/van-blog/commit/6a86f98bbbc4e1376edbb6e6d38632fa43d4bd0c))
- update ([3b1c447](https://github.com/Mereithhh/van-blog/commit/3b1c44791ff6b87794f6d6611742a6261e824e1e))
- update ([c672969](https://github.com/Mereithhh/van-blog/commit/c6729690fe2a5b880602310de6b372edc43e0b7f))
- 修改自用镜像 ([e5d7d1b](https://github.com/Mereithhh/van-blog/commit/e5d7d1b09d63ff43e76816fae0063f07849e1a78))
- 启动 ci ([58102ae](https://github.com/Mereithhh/van-blog/commit/58102ae06c9bf5cb554f1a9452c788c62cf74727))
- 回退版本测试 ([fd0ed23](https://github.com/Mereithhh/van-blog/commit/fd0ed23f104f1462fd1c31ea786a86b890296f35))
- 增加 .yarnrc.yml ([9c1b8e7](https://github.com/Mereithhh/van-blog/commit/9c1b8e7ab8890666e6a72a67a367d1b11c3a5c3e))
- 增加 all in one Dockerfile ([b0179f5](https://github.com/Mereithhh/van-blog/commit/b0179f5cac0a2e8e52d2717b536dae94038e13d3))
- 增加 release ([10862ad](https://github.com/Mereithhh/van-blog/commit/10862ad9f4f6da0daa21c8779210e4637aab12bf))
- 完善 all in one 镜像 ([af10133](https://github.com/Mereithhh/van-blog/commit/af1013346b7b4df31ac66bbe12610ba36b615b89))
- 完善文档部署 ci ([fa3f9e3](https://github.com/Mereithhh/van-blog/commit/fa3f9e31e5d7b900815887b63954e90b58c5d23b))
- 提交 lock 文件 ([bdbb674](https://github.com/Mereithhh/van-blog/commit/bdbb674853a11c43467366a8bf05a765e1efa146))
- 更改超时时间 ([f3ade54](https://github.com/Mereithhh/van-blog/commit/f3ade547fa2028bba58484e2785a452194491a0a))
- 更新 ci ([85fbeea](https://github.com/Mereithhh/van-blog/commit/85fbeea8cbf6df0d236605290735036203c8d6a2))
- 更新发布功能 ([858a1c2](https://github.com/Mereithhh/van-blog/commit/858a1c2dbcdd0f966c11f42a8db1bc99503aad3e))
- 更新文档 dockerfile ([97ec516](https://github.com/Mereithhh/van-blog/commit/97ec51653c4f7edc5061b81c1a0445202d1639c7))
- 更新构建配置 ([c42e998](https://github.com/Mereithhh/van-blog/commit/c42e9989e9df230ce345936cf1f8c14a28e74a51))
- 更新超时时间 ([d3f1e6a](https://github.com/Mereithhh/van-blog/commit/d3f1e6a935b5d686735992f880f6473f0df296bf))
- 更新部署文档的 actions ([403bbf3](https://github.com/Mereithhh/van-blog/commit/403bbf399744d86a35a1a0fc4c3ad5d8f692d1e9))
- 更新默认后端参数 ([662bd09](https://github.com/Mereithhh/van-blog/commit/662bd097918c8d6d1a0e8fd4896f105c04d56601))
- 设置淘宝源 ([d886eca](https://github.com/Mereithhh/van-blog/commit/d886ecad767d0312ef8715d9b9270603ee913f39))
- 调试 ci ([9fdf423](https://github.com/Mereithhh/van-blog/commit/9fdf42337a37df994ed130aa19c133dcaa5a100f))
- 调试 ci ([dec4bb8](https://github.com/Mereithhh/van-blog/commit/dec4bb8180f868aba3f0df76dcca7d0aa6202c35))
- 调试 ci ([c4c5dec](https://github.com/Mereithhh/van-blog/commit/c4c5dec54aa5ae3e53824da76c684350087bc883))
- 验证更新文档脚本 ([34096b3](https://github.com/Mereithhh/van-blog/commit/34096b3523d9bcf5f06d7ba9c6a84c37b430f0bb))
