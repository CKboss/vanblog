<p align="center">
	<img src="/img/logo.svg" style="width: 200px"></img>
</p>
<p align="center">
	<strong>VanBlog是一款简洁、实用、优雅的个人博客系统，支持全自动按需申请HTTPS证书、黑暗模式、移动端自适应和评论功能。它内置了流量统计和图床，并集成了评论系统。此外，VanBlog还具有无限的可扩展性，提供完备的后台管理面板，支持黑暗模式、移动端、一键上传剪贴板图片到图床，并带有强大的编辑器。</strong>
</p>
<p align="center">
	现在这个项目由 AI 全自动维护：可复现的代码问题会复现、补测试并开 PR，changelog 与官网文档会同步更新。合并到 master 以及打发版 tag（<code>v*</code> 部署产品、<code>doc*</code> 部署官网）仍由作者完成。演示站和官网会停留在最近一次已打 tag 的版本。欢迎继续提 issue 和 PR。
</p>
<p align="center">
  <img src="https://img.shields.io/github/v/release/mereithhh/van-blog?display_name=tag" />
  <img src="https://img.shields.io/docker/pulls/mereith/van-blog" />
  <img src="https://img.shields.io/github/stars/mereithhh/van-blog" />
  <img src="https://img.shields.io/bitbucket/issues/mereithhh/van-blog" />
  <img src="https://github.com/mereithhh/van-blog/workflows/release/badge.svg" />
  <img src="https://img.shields.io/badge/license-GPL%20v3-yellow.svg" />
</p>
<p align="center">
	<strong>项目主页: </strong>  <a target="_blank" href='https://vanblog.mereith.com'>vanblog.mereith.com</a>
</p>
<p align="center">
	<strong>Demo(后台账号密码均为 demo): </strong>  <a target="_blank" href='https://blog-demo.mereith.com'>blog-demo.mereith.com</a>
</p>

> **🍴 这是 [Mereithhh/van-blog](https://github.com/Mereithhh/vanblog) 的 fork（`CKboss/vanblog`，分支 `dev/dsh`）**
> 在上游 master `ccd708ce`（v0.54.0+）之上有 **133 个提交、552 个文件、+77,338 / −5,381 行**：
> 十几项新功能、四路安全审计加多轮遗留项清理、前后台与数据库的性能优化、整套依赖现代化
> （Node 24 / NestJS 10 / mongoose 8 / Next 14 / TypeScript 5.9 / sharp 0.35 / multer 2），
> 以及一批真实撞到的 bug 修复。**所有结论都带实测数字**，过程与陷阱记录在 `AGENTS.md`。
> 下面这段是本分支的内容，**其余部分（含文档站、演示站、打赏与捐赠名单）均归原作者所有**。
> 只想看改了什么 → [本分支新增内容](#本分支新增内容)；只想装 → [一键脚本部署](#一键脚本部署)。

## 本分支新增内容

**一句话版本**：内置评论系统（可替代外挂 Waline）· SEO 加固（canonical/301、JSON-LD、sitemap lastmod、动态 robots）· 补齐 6 种 markdown 语法 · 整站备份/恢复与单篇 `.mdz` 带图导出 · · **初始化页直接上传整站备份恢复**（不用先填向导） · **健康检查端点**（mongo 不通返回 503，镜像 HEALTHCHECK 打它） · 事件日志按大小轮转 · 限流改可信代理模式（不再能被一个请求头绕过） · **可复现的压测台与访问性能报告**（`docs/advanced/benchmark.md`）
图片管线（缩放/缩略图/隐写水印/原地替换）· 拼音文章别名 · Apple 风格前台皮肤 ·
前台首屏 JS 砍掉约 1/3 · 一键安装改成构建**本分支**源码 · 一批会让站点卡死/白屏/数据少算的 bug 修掉了。

### 功能

<table>
<tr><th>分组</th><th>功能</th><th>说明</th><th>文档</th></tr>
<tr><td rowspan="4">内容创作</td>
<td><b>拼音文章路径</b></td><td>新建文章按标题自动生成 <code>/post/&lt;pinyin-slug&gt;</code>，重名自动 <code>-2</code>/<code>-3</code>；历史文章可在后台一键回填；<code>/post/&lt;数字 id&gt;</code> 永远可用，改标题不会改别名（已分享的链接不失效）</td><td><a href="docs/features/article.md">文章</a></td></tr>
<tr><td><b>补齐 6 种 markdown 语法</b></td><td><code>==高亮==</code>、<code>X^2^</code> / <code>H~2~O</code>、<code>:smile:</code> 短代码、定义列表、GitHub 提示块 <code>&gt; [!NOTE]</code>、<code>[[toc]]</code> 文内目录。编辑器与前台用<b>同一套插件</b>（按 bytemd 的 unified 10 世代挑版本），不会再出现预览与发布不一致</td><td><a href="docs/features/markdown.md">Markdown</a></td></tr>
<tr><td><b>Markdown 一致性</b></td><td>编辑器预览与前台渲染对齐：front matter 不再被渲染成正文、两边共用同一份 sanitize 白名单（代码块复制按钮/行号在预览里也生效）、未知容器标题回落一致</td><td><a href="docs/features/markdown.md">Markdown</a></td></tr>
<tr><td><b>标题可选中 + 一键复制</b> / <b>自动摘要</b></td><td>列表页、文章页、关于页的标题可复制标题与链接，导航栏站点名同样可复制；没写 <code>&lt;!-- more --&gt;</code> 时自动取正文前 200 字，不会切断链接和 emoji</td><td><a href="docs/features/editor.md">编辑器</a></td></tr>
<tr><td rowspan="2">媒体与附件</td>
<td><b>图片管线</b></td><td>长边 1920 自动缩放、300px 缩略图、<b>隐写水印</b>（抗压缩/转码，可检测）、原地替换图片而 URL 不变、小图/大图/列表三种视图、批量引用查询；移除了「全部删除」按钮</td><td><a href="docs/features/image-storage.md">图床</a></td></tr>
<tr><td><b>附件管理</b></td><td>上传任意文件生成 URL（按内容去重），html/svg/js 等类型强制下载 + <code>nosniff</code>，可搜索引用、批量导出</td><td><a href="docs/features/attachment.md">附件</a></td></tr>
<tr><td rowspan="2">备份与迁移</td>
<td><b>整站备份 / 恢复（`./vanblog.sh backup` 出一致性快照、`./vanblog.sh restore <归档名>` 一步恢复、`./vanblog.sh reset <归档>` 在新机器上自动初始化+恢复+核对）、**插件式前台主题**（后台上传一份 CSS 即可换肤，`data-ui` 作用域隔离，刷新即生效，见 `docs/features/theme.md`）</b></td><td>一个高压缩归档（zstd → xz → gzip 自动选择）打包<b>全部集合 + 评论库 + 图床/附件/自定义页面</b>；支持不解压查看清单、鉴权下载、上传恢复（逐集合原子替换 + 重建索引）</td><td><a href="docs/advanced/backup.md">备份</a></td></tr>
<tr><td><b>单篇导出 <code>.md</code> / <code>.mdz</code></b></td><td><code>.md</code> 是原样正文；<code>.mdz</code> 是 Typora 风格带图包（相对链接 + <code>&lt;标题&gt;.assets/</code>）；外链图片自动抓取，抓不到会保留原链接并生成说明清单；文章/草稿/编辑器未保存内容/关于页都能导</td><td><a href="docs/advanced/backup.md">备份</a></td></tr>
<tr><td>SEO</td>
<td><b>搜索引擎优化</b></td><td><code>/post/&lt;数字id&gt;</code> <b>301 到别名</b>（以前两个地址都返回 200，被当成重复内容拆权重）；全站 <code>canonical</code>（去 query/hash，<code>/page/1</code> 归一到 <code>/</code>）；文章页独立 <code>description</code>（正文前 160 字压成纯文本）+ <code>og:type=article</code> + <code>article:*</code>；<b>JSON-LD 结构化数据</b>（文章页 <code>BlogPosting</code> + 面包屑，首页 <code>WebSite</code>+<code>Blog</code>）；sitemap 补上 <code>lastmod</code>/<code>changefreq</code>/<code>priority</code> 且不再收录加密文章；<code>robots.txt</code> 改由 server 动态生成并带 <code>Sitemap:</code> 绝对地址；RSS 修掉双斜杠、补标签分类、<code>zh-CN</code>、KaTeX 样式表从失效的 0.5.1 升到 0.16.9</td><td><a href="docs/advanced/seo.md">SEO</a></td></tr>
<tr><td>评论</td>
<td><b>内置评论系统</b></td><td>不再必须外挂 Waline：评论存在本站 Mongo、走本站接口，前台是自研组件（两层回复、分页、基础 Markdown、博主标识、深色模式），后台是原生管理页（审核/编辑/删除/批量/按状态与关键词筛选）。可选 <code>内置 / Waline / 关闭</code>，<b>老站点升级默认保持 Waline</b>；支持从 Waline 导出文件<b>一键导入</b>（默认只导正式显示的、按 objectId 幂等、保留原始时间与点赞）与<b>只导出已通过评论</b></td><td><a href="docs/features/comment.md">评论系统</a></td></tr>
<tr><td rowspan="2">观感与部署</td>
<td><b>Apple 风格前台皮肤</b></td><td>后台「站点信息 → 界面风格」一键切换（默认开启）：纯 CSS、每条规则都带 <code>[data-ui="apple"]</code> 作用域，不影响自定义 CSS；深浅色都有令牌可调；列表页有<b>缩略图</b>（没设封面就取正文首图，自动用 300px 缩略图；没图的文章就是<b>纯文字卡</b>，不放假图；后台可<b>一键从正文首图批量补封面</b>，先预览、可逐篇取消、可精确撤销）、<b>标签彩色胶囊</b>（色相由标签名哈希，同名同色）、渐变作者条；深色模式重做了表面层级（顶边高光 + 1px 环，因为纯黑底上投影看不见），不再只有黑白灰；全站字体为 <b>Maple Mono</b>（写在 <code>--ap-font</code> / <code>--ap-font-mono</code> 令牌里，远程字体<b>非阻塞</b>加载，加载不上会自动退回 SF Pro / 苹方 / 雅黑）；<b>后台编辑器预览同字体</b>，所见即所得</td><td><a href="docs/features/config.md">配置</a></td></tr>
<tr><td><b>一键安装装的是本分支</b></td><td>脚本默认 <code>docker pull ghcr.io/ckboss/vanblog:dev-dsh</code>（GitHub Actions 构建发布，<b>小机器也能装</b>）；拉不到时自动退回「克隆源码 + 本地构建」，并按实测 CPU/内存决定并发还是串行。上游脚本拉的是官方镜像，<b>不含这里的任何改动</b></td><td><a href="#一键脚本部署">部署</a></td></tr>
<tr><td rowspan="2">运维与可观测</td>
<td><b>初始化页直接上传整站备份恢复</b></td><td>全新安装不必再手填站点信息与账号：<code>POST /api/admin/init/restore</code>（匿名、只在未初始化时开放）把数据库 + 图床 + 附件 + 自定义页面 + 主题一起搬过来，随后自动拉起评论服务、按新库重启前台并触发全量渲染。有单飞锁（并发第二个 409）、文件名白名单、清单校验与<b>归档成员穿越检查</b>；老归档缺字段照样能恢复，只有"版本比本程序新"才拒</td></tr>
<tr><td><b>健康检查 + 事件日志轮转</b></td><td><code>GET /api/public/health</code>：mongo ping 不通返回 <b>503</b>（镜像的 HEALTHCHECK 判据是 <code>&lt;500</code>，所以这样才有意义），未初始化仍返回 200（否则全新安装会被编排系统反复重启）；事件日志按大小轮转（默认 20MB × 4 份 ≈ 80MB 上界），以前那个文件<b>只增不减</b>，磁盘满的表现是"备份写不出来、图片存不进去、mongod 变只读"</td></tr>
<tr><td>压测与报告</td>
<td><b>可复现的访问性能报告</b></td><td><code>scripts/benchmark/</code>（并发扫描 / 静态吞吐 / C10K / 单请求延迟）+ <a href="docs/advanced/benchmark.md">docs/advanced/benchmark.md</a>：首页 gzip 22,961B / 8–10ms，混合流量 456–506 rps，静态 1,487 rps（3,432 Mbps），<b>一万条连接同时取图 10,000/10,000 全 200、1.4 秒</b></td></tr>
<tr><td rowspan="4">内容管理</td>
<td><b>回收站（文章与草稿）</b></td><td>软删除本来就有（<code>deleted</code> 标记 + "只有删除接口能设它"的权限守卫），缺的是看/恢复/彻底删。
现在文章管理页有「回收站」抽屉：分页列表（不含正文与密码）、一键恢复（并重算字数、重新激活 ISR、触发文章更新流水线）、
永久删除（<b>必须先软删</b>，权限与既有删除同档，连带删掉该文章的历史版本）。按 <code>user.permissions</code> 门控，
没权限就<b>不渲染</b>按钮。⚠️ 草稿回收站有个既有语义的坑：<b>发布草稿会软删该草稿</b>，所以里面会出现"其实已发布成功"的条目，
而恢复它<b>不会动那篇已发布的文章</b> —— UI 里用了常驻告警条 + 发布成功时的即时说明来讲清这件事</td></tr>
<tr><td><b>文章版本历史</b></td><td>按"极简"做：不做 diff、不做分支、不做逐键保存。独立的 <code>revisions</code> 集合
（<b>不嵌进文章文档</b>，否则每次列表查询与每份备份都要背上 N 份正文），<b>只在标题或正文真的变了</b>才快照改之前的状态，
上限 <code>VANBLOG_ARTICLE_REVISIONS_KEEP</code>（默认 10，<code>0</code>=关）。后台可列出（只给元数据 + "来源"列区分
保存更新/恢复前自动保存）、只读查看正文（纯 <code>&lt;pre&gt;</code>，不引入新渲染器）、<b>回滚 —— 回滚前会先把当前状态存成一个
<code>pre-restore</code> 版本，所以回滚本身可回滚</b>。存量成本实测：单条均值 3.1KB，59 篇 × 10 ≈ <b>1.76MB</b></td></tr>
<tr><td><b>定时发布</b></td><td>文章/草稿可设 <code>publishAt</code>。语义是<b>查询级"到期前视为未发布"</b>而不是翻 <code>hidden</code> ——
这样"到点即可见"<b>自动成立</b>、不依赖任何"必须成功的写入"：cron 挂了、进程挂了、容器没起来，文章到点照样可见。
每分钟的 cron 只由主实例跑，只做三件轻活（记录、作废 meta 缓存、触发渲染），扫描窗口<b>只在查询成功后才前移</b>（崩溃不漏发）。
保存语义：<code>null</code> 清除、键缺失=不变、垃圾值 → <b>400</b>（绝不静默变成 Invalid Date）。
后台列表有橙色「定时待发布」列，点"查看"会先提醒"现在打开是 404"</td></tr>
<tr><td><b>阅读时长 + 相关文章</b></td><td>卡片与文章页显示"约 N 分钟"（除数 350 字/分钟，<code>VANBLOG_READING_SPEED_WPM</code> 可调；
⚠️ <b>私有/加密文章不给</b> —— 正文藏着，长度也就藏着，所以绝不会出现"0 分钟"标签）；文章页末尾最多 5 条相关文章
（共有标签 → 同分类 → 时间新近，<b>一次查询</b>、投影不含正文与密码，缩略图只用 thumb 尺寸）。
实测相关查询中位 <b>5.2ms</b>，列表侧阅读时长开销 <b>37.6µs</b>/整份 53 篇列表</td></tr>
<tr><td rowspan="2">运维与可证明性</td>
<td><b>恢复演练 <code>./vanblog.sh drill</code></b></td><td>把"备份能不能恢复"从信仰变成一条命令的证据：起一套<b>一次性</b>的
mongo + vanblog（命名卷、端口选择器跳过后听端口、mongo 端口永不为 27017、冲突硬拒绝、trap 保证清理），
等健康端点，然后<b>真的</b>把归档上传到 <code>POST /api/admin/init/restore</code>（走用户会走的生产路径），
再断言<b>语义</b>：信封 counts 与归档 manifest 对账、manifest 自洽、meta 是真实站点、<b>公开列表 total 与"从归档自己的
<code>articles.ndjson</code> 逐文档数出来的公开篇数"相等</b>、真实静态文件 200、<b>主题 CSS 能否取到</b>、日志扫 BSON 指纹、
第二次恢复必须 403。另有 <code>verify-deep</code>（<b>不需要 root</b> 的语义校验）、<code>backup-verify</code>（备份+立刻校验+陈旧检查+台账）、
<code>backup-status</code>（<b>不需要 token</b> 回答"上次备份何时成功、校验过没有"）。旧的 <code>verify</code> 故意保持不变
（严格版顶替它会静默改掉现有 cron 的退出码）</td></tr>
<tr><td><b>迁移账本 + 备份自校验</b></td><td><code>migrations</code> 集合记录每一项数据修复（<b>一 key 一行</b>，
带 <code>runs/firstRanAt/lastError</code>；不做"一次运行一行"是因为 watcher 一天能重启上百次 ⇒ 会无界增长），
<code>GET /api/admin/migration/list</code> 可读，⚠️ <b>账本只做可观测性、绝不用来跳过 wash</b>（有源码级测试钉住）。
备份现在<b>写完就自校验</b>（六道检查，含"归档内部的 manifest 能解析"—— 只有 sidecar 不算，因为恢复读的是内部那份），
失败 ⇒ 记录状态 + 带原因的 ERROR + <b>HTTP 400</b>；状态写在 <code>backup-status.json</code>
（⚠️ <b>故意不写进数据库</b>：恢复会覆盖库，状态跟着回退就等于"恢复后看不到恢复前那次备份失败了"）</td></tr>
<tr><td>性能（默认关）</td>
<td><b>caddy 直接发 6 个固定页的 ISR HTML</b></td><td><code>VANBLOG_CADDY_SERVE_HTML=true</code> 时，
<code>/</code>、<code>/about</code>、<code>/link</code>、<code>/timeline</code>、<code>/category</code>、<code>/tag</code>
由 caddy 直发不过 Node：首页扫描 <b>279.8–316.1 → 1171.0–1246.9 rps（3.7–4.5×）</b>、<b>p95 −78…−84%</b>、
单请求 <code>/</code> 的 p50 <b>8 → 1ms</b>。⚠️ <b>建议保持默认关</b>：开了以后这 6 条路径<b>完全不受限流</b>
（请求根本不进 Nest，而镜像里的标准 caddy 没有任何限流模块），且只在 ISR 是 onDemand 模式时生效（哨兵文件每 60 秒对账，
模式不符会自动摘掉）。<b>动态路由故意不支持</b>：删掉的文章的 HTML 会永远留在磁盘上（Next 14 的缓存层没有 unlink，
而 Next 自己从内存回 404 ⇒ caddy 会无限期用 200 提供已删除内容），308 与 404 也不留任何磁盘产物</td></tr>
</table>

### 修掉的 bug（都是真实撞到的）

**整站备份与恢复（这一轮的重点，都是"看着成功其实没成"的那类）**

- **整站恢复直接 400**：`Unsupported BSON version, bson types must be from bson 6.x.x` —— 编解码用的 BSON 构造器来自直接依赖的 `mongodb@5`（bson 5），而写库走的是 mongoose 8 自带的 driver 6（bson 6）。mongoose 7 时代两边同版本所以一直潜伏，升级才暴露；而备份的 e2e **只覆盖 JSON 导入导出、从来没有 BSON 往返**。
- **每一份归档里的正则字段都被写成了 `{}`**：driver 把 BSON regex 提升成原生 RegExp，而原生 RegExp 没有 `_bsontype`、`Object.keys()` 也是空的 ⇒ 编码时掉进"普通对象"分支，值被静默清空、零报错。
- **后台上传的主题 CSS 从来不进整站备份**：静态目录是**手写清单**（`img/file/customPage`），主题在 `themes/`。而主题的元数据在库里 ⇒ 恢复后**后台显示主题存在且已启用**、`/api/public/theme.css` 却返回 **204 + 一份空样式表**（读文件失败被服务端 catch 掉了，浏览器拿到的是合法的空 CSS、控制台零报错、网络面板也不是红色），前台静默退回默认皮肤。现在清单里有了 `themes`，并加了"任何未登记的静态子目录都会让测试红"的分类守卫。
- **恢复之后流水线跑不起来**：脚本正文在磁盘上（`<codeRunner>/<id>.js`）而执行时 fork 的就是它，新机器上启动时库是空的 ⇒ 恢复后集合有数据、磁盘没文件，保存文章会卡到超时。
- **恢复之后 RSS/sitemap 迟到**：`activeAll` 的防抖默认 3 分钟且会被后续调用重置，两条恢复路由都没传 delay ⇒ `/feed.xml` 一度 404。

**前台**

- 顶部导航：悬停别的标签时，那条下划线会**比当前页的低约 2px 并且更宽更粗** —— 下划线是画在带 `hover:scale-110` 的 `<li>` 上的伪元素，一放大整条线就跟着位移。缩放挪到文字上，并加了 CSS 兜底与源码守卫。
- 侧栏作者卡：`headroom` 每次渲染都新建一个实例并再挂一个 scroll 监听（越用越多）；补清理时又踩到 headroom 0.12 的 `init()` 把 `scrollTracker` 放在 `setTimeout(100)` 里，StrictMode 的「挂载→清理→再挂载」会让 `destroy()` 抛 `TypeError`（表现是**一滚动就报错**），现在统一走安全的 `stopHeadroom()`。
- 文章目录高亮：客户端从文章 A 跳到 B 之后仍用 A 的标题列表 → 高亮错行，而且每次滚动都把地址栏 hash 改成上一篇文章的标题。
- 摘要：`<!-- more -->` 写在代码块里时会被当成截断标记，列表卡片渲染出**没闭合的围栏**，把后面的内容全吞掉。
- 不存在的文章、`/page/abc`、`/page/0`、超范围页码以前都返回 **200 + 软 404**（骗搜索引擎，还会在后端抖动时把 ISR 缓存里的好页面替换掉）→ 现在是真 404；后端 5xx/网络错误不再被当成「文章不存在」。
- 标签 `C++` 显示「此标签不存在」、分类 `a&b` 只查到 `a`、搜索 `C#` 实际搜 `C`：查询串是手拼的且只转义了 `#` 和 `/` → 统一 `URLSearchParams`。
- 内置评论刚上线时 `/link` 页写死了 Waline 组件（切到内置后子进程已停 → 评论区一片空白），以及评论按「别名」存、按「数字 id」查导致**明明有评论却一条都不显示** → 现在所有评论区走同一个入口，评论统一以数字 id 为键、服务端把两种路径当同一篇展开。

**后台**

- **转圈卡死一族**（6 处）：`.then(() => setLoading(false))` 没有 `catch`，请求一失败就永远转圈；其中改文章路径冲突（400）会让**编辑器整页冻住**；旧版 JSON 导出用了 `skipErrorHandler`（全局 handler 会把错误抛回来）同样卡死。统一 try/catch/finally + 共享的错误提示helper（不会双重弹窗）。
- 「导出全部本地图床内容」按钮一直抛 `ReferenceError`（用了 `saveExportArchive` 却没 import）。
- 登出返回 401（token 已失效）时既不跳转也不清 localStorage → 半登录状态。
- `<Link to="/admin/site/setting">` 在 umi `base:'/admin/'` 下渲染成 `/admin/admin/...` → catch-all 404；`?subTab=layout` 是**没人读的 key**（应读 `tab`/`siteInfoTab`），深链一直落错标签页。
- 标签管理里任何搜索都会**凭空造出一个不存在的标签**，它的重命名/删除在服务端 no-op 却提示成功。
- 三个概览 tab 共用同一个 localStorage key（`van-blog-admin-num-undefined`），在「概览」改近 30 天会**悄悄改掉另外两个 tab 的条数**。
- HTTPS 设置页在 `await` **之前**就排好了 `location.replace('http://…')` 且失败不取消 → 更新失败浏览器照样切协议。
- 初始化页把 `statusCode == 500` 当成功，但服务端是用 `throw HttpException('已初始化', 500)` 表达的 → 那个分支是死代码，现在会正确引导去登录。
- 评论管理页在 dev 下指向一个**硬编码的内网地址**（上游遗留）→ 改成按当前主机名推导。
- 后台整页白屏（`ScriptExternalLoadError: timeout /mf-va_remoteEntry.js`）：umi3 的 MFSU 解析不了只有 `exports`、没有 `main` 的 ESM 包 → 用 `patches/` 里两个 pnpm patch 补上 `main`，MFSU 恢复，dev 冷启动保持 ~25s。

### 性能

| 目标 | 结果 |
| --- | --- |
| 前台首屏 JS（`next build` First Load） | 首页 432 → **286 kB**，文章页 427 → **281 kB**，友链页 418 → **172 kB**；KaTeX / mermaid / TOC 数学全部按需加载 |
| 前台图片与静态资源 | 正文图片 `lazy` + `decoding=async`、封面 `preload` + `fetchpriority=high`；图床图片改为 `max-age=3600, stale-while-revalidate=604800`（此前是 `max-age=0`，每次翻页都重新请求） |
| 后台 `dist` | 27 MB → **24 MB**；`umi.js` 1133 → **1077 KB**；编辑器路由首包 ~1748 → **~911 KB**；mermaid 从 3 份产物减到 1 份；`lodash` 桶式导入改按需 |
| 第三方脚本 | 百度统计改 `strategy="lazyOnload"`，不再和水合抢资源 |
| 服务端 | 访问量计数改**原子 `$inc`**（并发下不再互相覆盖、永久少算）；改站点信息不再无条件重启前台进程（环境变量没变就跳过，省掉几秒停站）；流水线依赖安装不再用 `spawnSync` 阻塞事件循环 |
| 服务端热路径 | 摘要+首图 **3.7×**（一页 5 篇 0.407 → 0.110 ms）、493KB 长文无 more 标记时 **96×**（O(正文) → O(200)）；markdown 不再每次重渲染整篇重解析（原本同一页会解析 **3 遍**）；时间线排序 n=20,000 **308 → 26 ms**；`washArticles` n=10,000 **118 → 19 ms** |
| 数据库往返 | 一次文章页浏览 **8 条命令 / 4 次写 → ~1 条**；整站 JSON 导入 8,772 条 visits **17,544 → 18 次命令（975×）**；后台 31 天趋势 **31 次串行 findOne → 1 次 `$in`**；`/api/public/meta` 7 个查询从串行改并行 + 5 秒缓存 |
| 一键脚本 | `backup` 支持 `--consistent`（先停 MongoDB）、`restore` 会校验压缩包完整性并自动删掉 `mongod.lock`；常规操作不再 `down -v`（那会删卷） |

细节见 [前台性能](docs/advanced/performance.md)。

#### 当前版本的访问性能（实测，可复现）

完整报告在 **[docs/advanced/benchmark.md](docs/advanced/benchmark.md)**，采集脚本入库
（`scripts/benchmark/measure.sh`），每个数字都能重跑对账。下面是生产镜像 + 真实数据
（53 篇公开文章、93 个静态文件，从 66 MB 整站备份恢复）在同机 podman 栈上的结果：

| 指标 | 实测 |
|---|---|
| 首页（ISR HTML） | **93,359 B / gzip 22,961 B，8–10 ms** |
| 文章页 | 78,830 B / gzip 23,729 B，**8 ms** |
| 公开列表接口（5 篇摘要） | 5,621 B，**12 ms** |
| 图床图片 / 缩略图（caddy 直服） | **1 ms** |
| 混合流量吞吐 | **456–506 rps / 673–763 Mbps**（并发 50→1000，**0 个 5xx、0 个 socket 错误**） |
| 持续加压（并发 200 × 20,000 请求） | **560.9 rps / 820.5 Mbps**，p50 138 ms，0 错误 |
| 纯静态吞吐 | **1,487 rps / 3,432 Mbps（≈429 MB/s）**，p95 64 ms |
| **C10K**：一万条连接同时挂住 | 1.1–1.8 秒全部建立，**0 拒绝** |
| **C10K**：一万条连接同时取静态图 | **10,000/10,000 全部 200，1.4 秒，0 失败** |
| **C10K**：一万条连接同时打动态接口 | 10.7 秒完成 **5,872** 个（天花板是单进程 Node，不是网络层） |
| 容器内存 | mongo 142–162 MB；应用稳定加压时 **627 MB**（`podman stats` 含页缓存） |
| 一次文章页浏览的 DB 开销 | **~1 条 Mongo 命令**（改造前 8 条 / 4 次写） |

⚠️ 三条读数字的前提：客户端与服务端**同机**（抢 CPU，绝对值偏保守）、走 **loopback 且无 TLS**、
页面都是 **ISR 缓存命中**。并发扫描是**抬掉限流**测的 —— 默认限流是每 IP 每分钟 600 次
（静态资源另有 10 倍独立桶），不抬的话测到的是"限流器多快返回 429"。报告第 0 节写了完整协议与复现命令。

### 安全

做过一轮四路并行审计（认证与权限 / 文件与上传 / 注入与数据暴露 / 功能正确性），之后又清了两轮遗留项：

- 公开接口的 Mongo 操作符注入、搜索接口的正则注入与 500、图床上传任意文件导致的同源存储型 XSS、导出接口的重定向 SSRF；
- 加密文章经由搜索 / RSS / 解锁接口的三处泄露；解锁接口现在**限次**（同 IP + 同文章 10 分钟 20 次）；
- 导出归档匿名可下载、登录限流可被伪造头绕过、演示站下的管线 RCE、备份恢复的半恢复与进程崩溃；
- 流水线执行加了超时与 `error`/`exit` 监听（以前脚本不返回就会**永久卡住保存文章**）；`getNewId()` 的锁改成 `try/finally`（一次查询失败不会让所有新建请求空转到重启进程）；
- 图片链接解析不再把 alt 文本 / 代码块里的示例当成真图片（以前会误报「失效图片」并往库里插垃圾记录）；「本地化远程图片」也不再改坏教程里的 ```md 示例；
- `/swagger` 可用 `VANBLOG_SWAGGER=false` 关闭；`/api/revalidate` 支持共享密钥与路径校验（单独部署 website 镜像时它是公网可达的）；ISR 触发地址改用 `URLSearchParams`（`encodeURI` 不编码 `#`，而文章别名允许 `#`，以前会静默失效）；
- **管理员口令改存 scrypt**（原来是 sha256 套 sha256 的快哈希，库泄露后可被 GPU 高速爆破）。**迁移是透明的**：新旧格式都认，登录成功时自动升级，用户不用改密码；
- **全局限流**：`/api/admin/init*` 10 分钟 5 次、`/api/public/**` 写操作每分钟 30 次、全局每分钟 600 次（都可调），命中返回 429 + `Retry-After`；容器内部回环调用放行（判据要求「回环 **且** 无 `X-Forwarded-For`」，反代后的真实客户端不会被误放行），限流组件出错时 fail-open；
- **安全响应头**：`nosniff`、`X-Frame-Options: SAMEORIGIN`（后台要 iframe 同源的 waline `/ui`，所以不是 DENY）、`Referrer-Policy`、`Permissions-Policy`，并隐藏 caddy 的 `Server` 头；
- 公开文章列表的 `pageSize=-1`（一次拉走全站正文）现在只允许内部调用；**API Token 有效期从 100 年改成默认 1 年**（`VANBLOG_API_TOKEN_TTL_DAYS` 可调，已签发的不受影响）；文章解锁密码改成常量时间比较；
- **评论系统**（匿名可写，所以比正文严得多）：原始 HTML 根本不解析、白名单不含 `img`/`iframe`/`style`/`svg`、链接强制 `rel="nofollow noopener noreferrer"`、服务端重新校验每个字段（含显式拒绝 `javascript:` 等非 http(s) scheme、剥掉双向控制符防 RLO 伪装）、蜜罐 + 同 IP 频率/每日/重复内容三重限制、公开接口不返回邮箱/IP/UA。

约束、可调开关与**已知未修项**都写在 [安全与加固](docs/advanced/security.md)。

- **限流可以被一个请求头绕过**：四档体量限流用 `pickClientIp()` 当 key，而它优先读 `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for` —— 全是客户端可控的，caddy 也不剥。现在默认 `VANBLOG_TRUST_FORWARDED_HEADERS=auto`：只有对端是回环/私网时才采信转发头，且只信一跳（XFF 最右一项）。**登录防爆破、评论频率与文章解锁仍然只用套接字地址**（那三类的攻击收益正是"换个 key 重新开始"）。
- **限流表"一满就把所有人清零"**：超过 20000 个 key 就 `buckets.clear()`，而 key 里有匿名可控成分 ⇒ 实测 20 万个一次性 key 触发 **9 次全表清空**，每次把进程里所有人的登录爆破窗口一起归零。改成惰性过期 + 按 count 淘汰（正在被限流的桶 count>1，不会被踢）。
- **后台日志页的存储型 XSS**：`ansi-to-html` 的 `escapeXML` 默认是 `false`，日志里的尖括号会原样变成标签，而那是全后台唯一一处 `dangerouslySetInnerHTML`；日志里完全可能出现访客可控字符串（404 路径、上传文件名、评论作者）⇒ 谁打开那个页面谁中招，而 token 就在 localStorage 里。
- **picgo 插件安装默认关闭**：picgo 1.5.6 依赖的 `git-clone`（命令注入）与 `decompress`（路径穿越）**都没有修复版本**，而插件名来自后台一个输入框 ⇒ 拿到后台会话就等于容器内 root 执行代码。内置图床（本地/OSS/七牛/又拍云/sm.ms/github）都不需要插件。
- **后台仪表盘一个 GET 就能把进程 OOM**：`?overviewDataNum=999999999` 会先 push 十亿个日期字符串再把十亿元素的 `$in` 发给 Mongo（实测 num=300000 卡住事件循环 **4.62 秒**）；`=abc` 则得到 **200 + 一整屏 0**，与"没有访问量"分不出来。已夹到 `[0,3650]`。
- **multer 升到 2.4.0**（1.x 停更、带已知漏洞，而它在每一条上传路径上）。⚠️ 顺带躲过一个坑：`@nestjs/platform-express@10.4.22` 精确依赖的是 **multer 2.0.2，而它自己有 8 个 2026 年披露的 CVE**（≥2.3.0 才修完），只改自己的 package.json 会装上有漏洞的那份 ⇒ 用根 override 收敛成单份 2.4.0。

- **私有文章的元数据泄露**：把文章设为私有后，**上一篇/下一篇导航里仍带着它的标题与别名**（实测计数 3→2 而不是 →0）—— `getPreArticleByArticle` 过滤了 `hidden`/`deleted`，**没过滤 `private` 与私有分类**。只是元数据，但加密文章的标题往往就是全部秘密（公开页面上挂一条"2026 年裁员名单"的邻居链接，不用密码也把事说了）。现在上一篇/下一篇、公开搜索、相关文章三处都排除。⚠️ 选"整个略去"而不是"按解锁状态显示"，因为解锁状态是**按 IP 的尝试次数桶**，而这三处是**被 ISR 静态化的共享页面**，每个访客不同的解锁状态在那里结构上不可能实现。⚠️ 这是**有意的默认行为变更**（不提供回退开关）：公开搜索不再返回私有文章标题，从此与 `getTotalNum`/RSS/sitemap 口径一致。
- **一句遗留的 `console.log(staticSetting)` 每次启动都把完整图床设置（含 OSS/七牛/又拍云的 accessKey）打进 stdout** ⇒ 进容器日志、进任何日志采集。已删。
- **一个能让整站恢复功能被永久锁死的既有 bug**：`listArchiveMembers` 在**截断归档**上**永不 settle**（tar 的 close 先把 `settled=true` 置上，随后的 `fail()` 因已 settled 变成 no-op）。后果不止校验挂住：匿名路由 `/api/admin/init/restore` 的 `assertRestorableArchive` 会**一直吊着请求并占着单飞锁直到进程重启** ⇒ **任何人上传一个坏归档就能永久锁死整站的恢复功能**。已修（gzip 与 zstd 两种格式都有回归钉子），并由脚本侧的负向演练从外部证明：坏归档 400 之后，**紧接着的好归档演练仍然通过**。

### ⚠️ 行为变化（升级前看一眼）

| 变化 | 说明 |
| --- | --- |
| 单个 `~x~` 现在是**下标** | 为了让 `H~2~O` 可用，关掉了 GFM 的单波浪删除线。删除线请写 `~~x~~`（这本来就是 CommonMark/GFM 的标准写法） |
| 不存在的文章/页码返回 **404** | 以前是 200 + 软 404。如果你有监控按「200 才算正常」，注意这个变化 |
| 评论的 path 键用**数字 id** | 内置评论写入 `/post/<数字id>`；查询时服务端会把 `/post/<id>` 与 `/post/<别名>` 当同一篇展开，所以历史数据两种形式都认 |
| 后台 dev 依赖两个 **pnpm patch** | `patches/` 给 `remark-supersub`、`remark-github-blockquote-alert` 补了 `main` 字段（MFSU 需要）。升级这两个包时 patch 会失效并**明确报错**，重新 `pnpm patch` 一次即可；实在不行把 `mfsu` 设为 `false`（dev 冷启动 ~25s → ~2min） |
| 一键脚本装的是**本分支源码构建**的镜像 | 不再是 `mereith/van-blog:latest`。想回到官方镜像：`VANBLOG_USE_UPSTREAM_IMAGE=true ./vanblog.sh` |
| 「失效图片」报告变准了 | 以前会把 alt 文本里的 URL、代码块里的示例也当成图片去请求，于是误报 + 往 `statics` 插垃圾记录 |
| **限流用哪个 IP** | `VANBLOG_TRUST_FORWARDED_HEADERS` 默认 `auto`：只有对端是回环/私网时才采信转发头（一体式部署正好如此）。CDN/隧道直连源站、对端是公网代理 IP 的部署要显式设 `always`，否则所有流量会挤在少数几个出口 IP 的桶里 |
| **Nest 内置错误体的 JSON 键顺序** | `{"statusCode":401,"message":…}` → `{"message":…,"statusCode":401}`（键、值、字节长度都不变，只是 ETag 变）。控制器自己拼的 `{statusCode:200,data}` 一个字节没变 |
| **RSS 里没有 `<!-- more -->` 的文章** | description 从"渲染后的全文"变成"渲染后的 200 字摘要"（与全站摘要语义一致，全文仍在 `content:encoded` 里） |
| **浏览统计的可见延迟** | 改成合并写入后，直接读库的地方（`/api/public/meta`、后台趋势图）最多落后一个 flush 周期（默认 5 秒，与 meta 缓存同量级） |
| **事件日志会轮转了** | `vanblog-event.log` 超过 `VANBLOG_EVENT_LOG_MAX_MB`（默认 20）就轮转，保留 `VANBLOG_EVENT_LOG_KEEP`（默认 3）份历史。如果你有外部工具在 tail 这个文件，要知道它会被改名 |
| **生产镜像构建开始做类型检查** | 以前 `isBuild=t` 同时关掉了 tsc 与 lint（而注释写着"正式构建不要开"）。现在类型检查只由 `VANBLOG_SKIP_TYPECHECK=true` 控制；`isBuild` 保留它本来的职责（构建期连不上 server 时的数据兜底）。lint 仍然跳过：**website 包根本没有 `.eslintrc`** |
| **`visits` 的冗余索引会被删掉** | 启动维护会删掉 `date_1` 与 `pathname_1`（被 `{date,pathname}` 唯一索引与 `{pathname,date}` 复合索引完全覆盖），实测索引总量 1.18MB → 0.90MB。`VANBLOG_VISITS_DROP_REDUNDANT_INDEXES=false` 可关 |
| **文章版本历史默认是开的** | `VANBLOG_ARTICLE_REVISIONS_KEEP` 默认 **10**（`0` = 关 = 旧行为）。每次改标题/正文都会多存一份改前状态，存量约 1.76MB / 59 篇 |
| **公开搜索、上一篇/下一篇、相关文章不再包含私有文章** | 安全修复，**不提供回退开关**。如果你有"用搜索找自己的加密文章"的习惯，现在要从后台找 |
| **启动时可能多一条 WARN** | `VANBLOG_BACKUP_STALE_WARN_HOURS` 默认 48：没有近期"已校验的成功备份"就会在启动与每次失败后告警（只写日志、不改行为，`0` = 关掉回到沉默） |
| **只读子命令不再要 root** | `drill` / `verify-deep` / `backup-verify` / `backup-status` 在 root 门槛**之前**转交出去（那个门槛在子命令派发之前，所以以前连"校验自己的归档"都要 root）。会写 `/var/vanblog`、生成 compose、以 root 跑 docker-compose 或改 root crontab 的子命令**照旧**要 root |
| 改站点信息不再重启前台 | 只有影响前台环境变量的字段（图床域名白名单、ISR 设置）变了才重启 |

### 新增环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VANBLOG_SWAGGER` | 空（开启） | 设 `false` 关闭 `/swagger` 与 `/swagger-json`（生产环境建议关） |
| `VAN_BLOG_REVALIDATE_SECRET` | 空 | 设了之后前台 `/api/revalidate` 必须带同名 `secret`（server 会自动带上） |
| `VANBLOG_PIPELINE_TIMEOUT_MS` | `30000` | 单个流水线的执行上限，超时直接杀进程 |
| `VANBLOG_DEPS_INSTALL_TIMEOUT_MS` | `300000` | 流水线安装依赖的上限 |
| `VAN_BLOG_BACKUP_PATH` | `<log>/vanblog-backups` | 整站备份与导出归档目录（必须在静态目录之外） |
| `VANBLOG_BACKUP_ZSTD_LEVEL` | `19` | 整站备份的 zstd 压缩等级 |
| `VANBLOG_DISABLE_IP_GEO` | 空 | 设 `true` 关闭登录日志的 IP 归属地查询（不再把访客 IP 发给第三方） |
| `VANBLOG_CADDY_ASK_ALLOW_ALL` | 空 | 设 `true` 恢复「任何域名都批准按需证书」（多域名/CDN 场景） |
| `VANBLOG_REPO` / `VANBLOG_BRANCH` / `VANBLOG_SRC_DIR` / `VANBLOG_IMAGE_TAG` | `CKboss/vanblog` / `dev/dsh` / `<base>/src` / `vanblog:dev-dsh` | 一键脚本的源码来源与本地镜像 tag |
| `VANBLOG_BUILD_MODE` | `auto` | 镜像构建档位：`auto` 按实测 CPU/内存决定；`fast` 并发构建（≥7GB 且 ≥4 核）；`balanced` 串行；`lowmem` 串行 + admin 堆降到 1536MB |
| `VANBLOG_FORCE_BUILD` | `false` | 可用内存 <1.8GB 时脚本会**直接劝退**（源码构建几乎必然 OOM）；设 `true` 强行构建 |
| `VANBLOG_NPM_REGISTRY` | 空（自动探测） | 构建用的 pnpm 源。留空时脚本会实测 `npmmirror` 与 `npmjs` 的延迟，取更快的那个 |
| `VANBLOG_ALPINE_MIRROR` | 空（自动探测） | 构建时容器内的 Alpine 软件源。国内直连官方 `dl-cdn` 会让构建"卡死"在 `apk add`；留空时实测 aliyun / tuna / 官方取最快，设 `none` 强制用官方源 |
| `VAN_BLOG_ADMIN_BUILD_SCRIPT` | `build` | Dockerfile 的构建参数：admin 用 `build`（堆 4096MB）还是 `build:lowmem`（1536MB） |
| `VANBLOG_MONGO_IMAGE` | `mongo:7.0` | **只在全新安装时生效**：已有 MongoDB 数据的安装会保持原 tag（换大版本 mongod 会拒绝启动）。老机器不支持 avx 就设 `mongo:4.4.16` |

### 版本号（页脚与后台「关于」显示的那个）

页脚的 `Powered By VanBlog xxx` 和后台「关于」页的版本标签，都来自 server 的
`process.env.VAN_BLOG_VERSION`，**没设就显示 `dev`**（`packages/server/src/utils/loadConfig.ts`）。
这是上游就有的机制，不是本分支新增的变量，列在这里是因为很多人会问「这个 dev 是什么」：

| 部署方式 | 版本号从哪来 | 显示成 |
| --- | --- | --- |
| 官方镜像 | 镜像构建时写死 | 形如 `v0.54.0` |
| 本仓库的 `vanblog.sh` 源码构建 | 构建时传 `--build-arg VAN_BLOG_VERSIONS=dev/dsh@<sha>` | `dev/dsh@1a2b3c4` |
| 本地开发（`./dev-env.sh`） | 启动时按当前 git 提交算 | `dev/dsh@dd4414a3` |
| 什么都不设 | 回退 | `dev` |

⚠️ 两个名字**故意不一样**，别"顺手统一"：Dockerfile 的构建参数是复数
`VAN_BLOG_VERSIONS`，注入容器的环境变量是单数 `VAN_BLOG_VERSION`
（`ARG VAN_BLOG_VERSIONS` → `ENV VAN_BLOG_VERSION ${VAN_BLOG_VERSIONS}`）。改一边就会让版本号退回 `dev`。

前台是从接口拿版本号的（`/api/admin/meta` 与站点信息里的 `version`），取不到同样退回 `dev`，
不会渲染成 `undefined`。
| `VANBLOG_USE_UPSTREAM_IMAGE` | `false` | 设 `true` 用官方镜像（不含本分支改动） |
| `VANBLOG_RATE_LIMIT_PER_MIN` | `600` | 每 IP 每分钟的全局请求上限（兜底限流） |
| `VANBLOG_PUBLIC_WRITE_LIMIT_PER_MIN` | `30` | 每 IP 每分钟对 `/api/public/**` 写操作的上限 |
| `VANBLOG_INIT_LIMIT_PER_10MIN` | `5` | 每 IP 每 10 分钟对 `/api/admin/init*` 的上限 |
| `VAN_BLOG_INTERNAL_TOKEN` | 空 | 前后端分离部署时的内部令牌：带 `x-vanblog-internal` 头才允许 `pageSize=-1`（一体式镜像回环直连自动放行） |
| `VANBLOG_TRUST_FORWARDED_HEADERS` | `auto` | 限流采信转发头的条件：`auto`（对端回环/私网才信，只信 XFF 最右一跳）/ `always` / `never` |
| `VANBLOG_STATIC_LIMIT_PER_MIN` | 全局 ×10 | 静态资源的独立限流桶（图片和 API 抢同一个桶时，一篇带 10 图的文章 = 11 次计数） |
| `VANBLOG_VIEW_FLUSH_MS` / `_MAX_EVENTS` | `5000` / `1000` | 浏览统计的落库节奏；一轮固定 4–6 条命令，与攒了多少次浏览无关。`0` = 每次浏览立刻写 |
| `VANBLOG_VIEW_MAX_RETAINED_KEYS` | `20000` | 写库持续失败时累加器最多保留多少个"按路径/按文章"的键（≈3.2MB）；站点级累计与每日快照永不丢。`0` = 不限（旧行为） |
| `VANBLOG_VISIT_RETENTION_DAYS` | `0`（永不删） | 访问统计保留天数；最近 30 天无论怎么设都保留 |
| `VANBLOG_VISITS_DROP_REDUNDANT_INDEXES` | 开 | 启动时删掉 `visits` 的两个冗余前缀索引 |
| `VANBLOG_JSON_BODY_LIMIT` / `_LARGE` | `1mb` / `50mb` | JSON 请求体上限：全局 1mb，后台 4 个内容前缀（文章/草稿/自定义页面/管线）50mb |
| `VANBLOG_SLOW_REQUEST_MS` | `5000` | 慢请求 WARN 阈值（`0` = 关）；5xx 永远会打一条带 request-id 的 ERROR |
| `VANBLOG_ACCESS_LOG` | 关 | 每个非静态请求一行 INFO |
| `VANBLOG_EVENT_LOG_MAX_MB` / `_KEEP` | `20` / `3` | 事件日志的大小轮转（总量上界 ≈ 80MB） |
| `VANBLOG_CLUSTER_WORKERS` | `1` | 多进程；cron / 子进程 / 首轮渲染都只在主实例跑，限流与连接池按 worker 数摊薄。⚠️ N>1 尚未实跑验证 |
| `VANBLOG_ALLOW_PICGO_PLUGINS` | 关 | picgo 第三方插件安装（其依赖链带两个无修复版本的漏洞） |
| `VANBLOG_INIT_CACHE_MS` | `300000` | "是否已初始化"的缓存（以前每个 API 请求都查一次库、还把密码哈希读进内存） |
| `VANBLOG_LOG_SCAN_MAX_LINES` / `_BYTES` | `20000` / `8MB` | 后台翻日志的扫描上限（从尾部往前读） |
| `VANBLOG_KEEP_ALIVE_TIMEOUT_MS` | `65000` | 上游 keep-alive 超时，必须**大于**反代的空闲超时（caddy 是 60s），否则偶发 ECONNRESET/502 |
| `VANBLOG_PUBLIC_META_CACHE_MS` | `5000` | `/api/public/meta` 的进程内缓存（全站最热的一次读；`0` = 关） |
| `UV_THREADPOOL_SIZE` | `16`（镜像内） | sharp 编解码 / fs 异步 / scrypt 都在这个池里，Node 默认只有 4 |
| `VANBLOG_ARTICLE_REVISIONS_KEEP` | `10` | 每篇文章保留多少个历史版本（`0` = 关 = 旧行为） |
| `VANBLOG_BACKUP_STALE_WARN_HOURS` | `48` | 距上次"已校验的成功备份"超过这么多小时就 WARN（`0` = 关） |
| `VANBLOG_READING_SPEED_WPM` | `350` | 阅读时长的除数（夹在 50–2000） |
| `VANBLOG_THUMB_AVIF` | `false` | 缩略图额外产 `.avif`（省 26–41% 字节，编码 0.6–1.3s/张）。⚠️ 小图反而更大；**原图故意不做**（实测最高 241s/张 CPU） |
| `VANBLOG_CADDY_SERVE_HTML` | `false` | caddy 直发 6 个固定页的 ISR HTML（3.7–4.5× rps）。⚠️ 开了以后这 6 条路径**完全不受限流**，且要求 ISR 是 onDemand 模式 |
| `VANBLOG_CADDY_HTML_PAGES_DIR` | 自动 | 上面那个哨兵文件所在目录的覆盖（测试/前后端分离用） |
| `VANBLOG_DRILL_*` / `VANBLOG_VERIFY_ALLOW_EMPTY` | — | 演练的引擎/镜像/端口/超时/干跑等覆盖，见 `scripts/vanblog-drill.sh help` |
| `VANBLOG_API_TOKEN_TTL_DAYS` | `365` | 新签发 API Token 的有效期（原来是 100 年） |

完整清单（含上游原有的）见 [安全与加固](docs/advanced/security.md) 和 [配置](docs/features/config.md)。

### 已知限制（还没做的）

- **评论**：内置系统目前没有邮件 / webhook 通知（Waline 有）、没有点赞 UI（`likeCount` 已经存着）、没有验证码；从 Waline 迁移需要手动调导入接口。
- `/post/<数字id>` 与 `/post/<别名>` 仍然都返回 200，没有 canonical / 301，阅读量按 pathname 分开统计。
- 公开列表接口仍支持 `pageSize=-1` 全量拉取（前端静态生成依赖它）。
- **文章 / 分类的访问密码仍是明文存储**（校验已常量时间、解锁接口已限次）。没直接换哈希是因为后台表单会把密码回填到输入框，改哈希必须同时改前端语义（留空 = 不修改），要做得前后端一起改。
- **没有 CSP**：内联样式 + bytemd 注入的脚本 + 可选第三方统计，严 CSP 会把站点搞坏，要先给内联样式发 nonce 才能上。
- 没有全局 `ValidationPipe`（`class-validator` 不是依赖），参数校验靠各处手写；净化中间件是黑名单不是白名单。
- `/api/admin/init` 仍靠「库里有没有用户」判断是否已初始化（现在有 10 分钟 5 次的限流兜着）。
- `/swagger` 默认公开（可用 `VANBLOG_SWAGGER=false` 关）。

- **依赖仍有停更的部分**：后台是 umi 3 + antd 4 + **React 17**（全部已出上游支持窗口），前台是 Next **14**（15/16 要 React 19，而 `@bytemd/react` 的 peer 只到 18）；Express 仍是 4.x（Nest 11 = Express 5 = path-to-regexp v8，而 `app.module.ts` 有 4 处 `path:'*'`）。详见 `AGENTS.md` §7.50 的盘点表。
- **`cluster` 默认关且 N>1 从未实跑**：守卫都铺好了，但内存随 worker 数近似线性增长，打开前必须自己压一遍（`scripts/benchmark/`）。
- ~~文章没有版本历史、没有定时发布、没有迁移账本~~ **本轮已补**（版本历史 / `publishAt` 定时发布 / `migrations` 账本）。
- **搜索仍是子串匹配**（无索引、无排序、无中文分词、无独立结果页 `/search`）；没有 `/metrics`（Prometheus 指标）。
- **AVIF 只覆盖缩略图且默认关**：原图实测最高 **241 秒/张 CPU**，数学上不成立，故意没做（唯一合理的形状是夜间任务）。小图（如 60×40）用 AVIF 反而更大（约 294B 容器底噪）。
- **caddy 直发 HTML 只覆盖 6 个固定页且默认关**：动态路由有硬阻塞（删除的文章的 HTML 永远留在磁盘上、308/404 不留产物），要先把"notFound 时删文件"的语义做进服务端才可能扩大。
- **相关文章的候选查询是 FETCH+filter**（examined ≈ 集合大小）：59–5000 篇没问题且在 ISR 缓存里，语料再涨 10 倍该上复合索引。
- `countTotalWords` 仍把私有文章的字数算进**站点总字数**（既有；只影响聚合值、不暴露单篇）。
- **后台仍是 umi3 + antd4 + React 17**，前台仍是 Next 14（见上面那条依赖天花板）；后台包里的预览字体仍走 jsDelivr CDN（只是把 `@latest` 钉成了 `@5.3.0`）—— 后台要登录、不在读者关键路径上，为预览再塞 74KB 进第二个包没有可测收益。
- **备份是明文、且只落在本机** `backupPath`（按用户要求本轮**不做加密**）：归档里含密码哈希与 jwt 密钥；**没有异地副本**（S3/OSS/WebDAV 都没有），机器一起丢就全丢 —— 这是目前最大的单点。不过"能不能恢复"现在有证据了：导出**写完就自校验**（失败即 HTTP 400 + 状态落盘 + ERROR 日志），`./vanblog.sh drill` 能在一次性栈上真恢复一遍并断言语义，`verify-deep` 做不需要 root 的语义校验。
- **waline 让镜像大了 ~330MB**，其中约 170MB 是这个部署用不到的（MathJax 三件套 ≈102MB 用于邮件通知里的公式渲染、LeanCloud ≈57MB、better-sqlite3 12MB）。裁剪需要"构建后真的启动 waline 打接口"的验收，没做。
- **前台全局 CSS 拆不开**：apple 皮肤 46KB + markdown 专用表 ~27KB 对 `/link`、`/tag`、`/timeline` 是死重，但 Next 的 pages router 只允许在 `_app` 引第一方全局 CSS（三种绕法都被编译器拒）。字体也未自托管（每页 3 次字体 CSS、2 次 woff2）。
- **站点数据里的第三方脚本**（不是代码问题，但首屏影响最大）：一个 798KB 的 MathJax（公式已由 KaTeX 服务端渲染，纯重复）、gtag 与百度统计各加载两次、两个 51la 属性且开着 `screenRecord`、一个超时的计数器图片 —— 只能在后台「定制化」里删。

完整清单见 [安全与加固 · 已知未修项](docs/advanced/security.md)。

### 本地构建并冒烟测试镜像

改到 `Dockerfile` / `entrypoint.sh` / `scripts/start.js` / `caddyTemplate.json` 这类**只有镜像里才会暴露**的东西时，
别只跑单元测试 —— 前面几个镜像问题（缺依赖、caddy 配置加载失败、构建 OOM）在本地测试里全是绿的：

```bash
./scripts/build-image-local.sh                       # 构建 + 冒烟测试（起临时 mongo + 容器，测完自动拆）
./scripts/build-image-local.sh --stage admin_builder # 只构建某一层，迭代快得多
./scripts/build-image-local.sh --build-only          # 只构建
ENGINE=podman ./scripts/build-image-local.sh         # 没有 docker 组权限时用 podman（rootless，免 sudo）
```

冒烟测试会逐个打 `/`、`/api/public/meta`、`/admin`、`/robots.txt`、`/sitemap.xml`、`/rss/feed.xml`，
然后**扫容器日志里历史上真炸过的特征**（`Cannot find module`、`caddy process exited`、
`Reached heap limit`、`ERR_INVALID_URL`、`降级使用`…），再看 `RestartCount`、healthcheck 状态，
以及 `docker stop` 的耗时（接近宽限期就说明 SIGTERM 没被转发，进程是被硬杀的）。

> docker.io 在国内常常直连超时。podman 配 `~/.config/containers/registries.conf`、
> docker 配 `/etc/docker/daemon.json` 的 `registry-mirrors` 指到一个可用的加速地址即可；
> 脚本本身不写死任何镜像站。

### 本地开发（不需要 docker，也不需要 sudo）

```bash
./dev-env.sh bootstrap   # 下载 Node 20 + pnpm 8 + MongoDB 7 到 .tools/，并建好本地骨架
./dev-env.sh install     # 装依赖（--frozen-lockfile，不改 lockfile）
./dev-env.sh start       # MongoDB:27017 + server:3000 + website:3001 + admin:3002 一起起
./dev-env.sh status      # 状态；另有 logs / stop / restart / db / backup
```

工具链、数据库、数据目录、日志全部在仓库内（`.tools/`、`vanblog_dev/`，已本地忽略），整套环境可以随目录搬走，也不会污染系统。

**[AGENTS.md](AGENTS.md)** 是给人和 AI 编码代理看的运行手册：环境搭建、日常操作、跑测试、故障排查速查表，以及本分支每一项改动的**根因和踩过的坑**（改代码前请先读它）。

### 测试

| 套件 | 命令 | 现状 |
| --- | --- | --- |
| server（jest） | `cd packages/server && ./node_modules/.bin/jest` | **1275** 用例 / 132 套件（1 个既有用例需联网拉字体；⚠️ 并发压满机器时另有 2 条负载敏感用例会假红，单独跑 43/43 全绿） |
| website（vitest） | `cd packages/website && ./node_modules/.bin/vitest run` | **79 文件 / 788** 用例 |
| admin（node:test） | `cd packages/admin && node --test --test-reporter=tap tests/unit/*.test.js` | **127 套件 / 488** 用例（⚠️ Node 24 换了默认 reporter，不加 `--test-reporter=tap` 就没有汇总行） |
| 部署脚本（bash） | `for t in scripts/tests/*.test.sh; do bash "$t"; done` | **23 文件 / 1495** 条断言（含 `vanblog-drill.test.sh`；开活体段是 397 条） |

三套 JS 测试都要用 `.tools/node20`（系统 Node ≥ 23 会因为 `util.isObject` 被移除而崩）。

### 与上游同步

```bash
git fetch origin            # origin = 上游 Mereithhh/vanblog（只 fetch，不 push、不打 tag）
git rebase origin/master    # 或 merge，按需
git push ckboss dev/dsh     # ckboss = 本 fork
```

上游的发版 tag（`v*` 产品、`doc*` 官网）是作者专用的，本分支不会推送任何 tag。

---

## 预览图

![前台-白色](/img/合并.png)

## 特性

- [x] 快到极致的响应速度，Lighthouse 接近满分。
- [x] 独一份的按需全自动 HTTPS，甚至不用填域名。
- [x] 包括完整的前后台和服务端。
- [x] 前台和后台都为响应式设计，完美适配移动端和多尺寸设备。
- [x] 前台和后台都支持黑暗模式，并可自动切换。
- [x] 前台为静态网页（SSG），并支持秒级的增量渲染，每次改动无需重新构建全部页面。
- [x] SEO 和无障碍友好，支持自定义文章路径。
- [x] 静态网页，CDN 友好。
- [x] 版本号展示和更新提醒。
- [x] 基于 React，项目工程化，二次开发友好。
- [x] 内置强大的分析功能，可统计访客等数据。并配有精美看板。
- [x] 内嵌评论系统。
- [x] 强大的 Markdown 编辑器，支持图表和数学公式，一键插入 more 标记，一键剪切板及本地图片上传，支持自定义高亮块语法，支持 Emoji 表情选取。
- [x] TOC、草稿、代码复制、访客数、评论数、分类、标签、搜索、加密、友链、打赏、自定义导航栏。
- [x] 多个布局设置，可自定义页面细节。
- [x] 高度定制化，可添加自定义 CSS、HTML 和 JS 代码。
- [x] 支持自定义页面。
- [x] 可添加具有指定权限的协作者。
- [x] 内置图床，并支持各种 OSS 图床、github 图床（外部图床基于 picgo）等
- [x] 支持上传图片自动添加水印，无论何种图床
- [x] 支持上传图片自动压缩，无论何种图床
- [x] 极致轻量化，没有花里胡哨。页面秒切换、图片懒加载。
- [x] 脚本一键部署，多种部署方式，支持 ARM 平台。
- [x] 支持 GA、百度分析
- [x] 简单易用的后台，支持数据的导出与导入。
- [x] 支持 RSS 订阅
- [x] 完善的 API，完全利用本项目后台和服务端，自己写前端或适配其他页面生成器
- [x] 有较完善的日志记录，后台可直接查看登录日志和 Caddy 日志。

## 快速上手/部署教程

### 一键脚本部署

```bash
curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh && ./vanblog.sh
```

> `raw.githubusercontent.com` 对**分支**地址有几分钟的 CDN 缓存：刚推完就装可能拿到上一版脚本。
> 想确保拿到最新的，把 `dev/dsh` 换成具体 commit：
> `https://raw.githubusercontent.com/CKboss/vanblog/<commit-sha>/scripts/vanblog.sh`
> （脚本自己的 `update_script` 也走同一组地址，同样受这个缓存影响。）

::: warning 装的是本分支，不是上游镜像

上游那份脚本（`vanblog.mereith.com/vanblog.sh`）拉的是官方镜像 `mereith/van-blog:latest`，
里面**没有**本 fork 的任何改动。这里的脚本装的是 `CKboss/vanblog` 的 `dev/dsh`：

1. **默认先拉镜像**：`ghcr.io/ckboss/vanblog:dev-dsh`（由 `.github/workflows/publish-ghcr.yml`
   在 GitHub 的 runner 上构建发布）。本机只需要 `docker pull`，**1C1G 的小机器也装得动**。
   镜像**不是每次 push 都重建**（一次要 20–40 分钟 runner，而多数提交只是文档）：
   要发新版就去 Actions 页面手动 `Run workflow`，或者推一个 `v*` 标签。
2. **拉不到就自动退回源码构建**（镜像还没发布、网络到不了 ghcr.io、或没有对应架构的镜像）：
   克隆 `dev/dsh` → 本地 `docker build` → 用本地 tag 起容器。构建前会实测 CPU 与可用内存，
   决定并发还是串行、admin 用 4096MB 还是 1536MB 的堆；可用内存不足 1.8GB 时直接劝退
   （并给出「用官方镜像」与「强行构建」两条出路），不让你白等 20 分钟。

之后 `./vanblog.sh update` 会拉新镜像（或重新构建）；失败不会动正在跑的容器。

:::

可用的环境变量（都有默认值，直接跑就行）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VANBLOG_REPO` | `https://github.com/CKboss/vanblog.git` | 源码仓库 |
| `VANBLOG_BRANCH` | `dev/dsh` | 分支 |
| `VANBLOG_SRC_DIR` | `/var/vanblog/src` | 源码目录（构建缓存，可反复更新） |
| `VANBLOG_IMAGE_TAG` | `vanblog:dev-dsh` | 本地构建出的镜像 tag |
| `VANBLOG_IMAGE_REF` | `ghcr.io/ckboss/vanblog:dev-dsh` | 本分支镜像地址（可换成自己的 registry 或某个 sha 标签） |
| `VANBLOG_INSTALL_MODE` | `auto` | `auto` 先拉镜像、失败退回源码构建；`image` 只拉（拉不到就报错）；`source` 只本地构建 |
| `VANBLOG_USE_UPSTREAM_IMAGE` | `false` | 设 `true` 就回到官方镜像（不含本分支改动，优先级最高） |
| `VANBLOG_BUILD_SERVER` | 空 | 构建期写入前台访问后端的地址（`VAN_BLOG_SERVER_URL`） |

```bash
# 例：换分支 / 换镜像 tag
VANBLOG_BRANCH=dev/dsh VANBLOG_IMAGE_TAG=vanblog:dev-dsh ./vanblog.sh install
# 例：只想先用官方镜像把站点跑起来
VANBLOG_USE_UPSTREAM_IMAGE=true ./vanblog.sh install
```

将来如果需要再次运行脚本，可以运行：

```bash
./vanblog.sh
```

### 其他部署方式

具体请移步项目文档：[快速上手](https://vanblog.mereith.com/guide/get-started.html)

## 反代

请参考： [反代](https://vanblog.mereith.com/reference/reverse-proxy.html)

## 常见问题

> [备份与迁移](https://vanblog.mereith.com/guide/backup.html)
>
> [作者 logo 无法加载](https://vanblog.mereith.com/faq/usage.html#图片-作者-logo-加载不出来)
>
> [http error](https://vanblog.mereith.com/faq/deploy.html#部署后-http-error)
>
> [docker 镜像拉取慢](https://vanblog.mereith.com/faq/deploy.html#docker-镜像拉取慢)
>
> [如何外部访问数据库](https://vanblog.mereith.com/faq/deploy.html#如何在外部访问数据库)
>
> [如何回滚](https://vanblog.mereith.com/faq/update.html#如何回滚)
>
> [如何升级](https://vanblog.mereith.com/guide/update.html)
>
> [更新后后台报错||一直加载中](https://vanblog.mereith.com/faq/update.html#升级后后台报错或持续加载)
>
> [开启了 https 重定向后关不掉](https://vanblog.mereith.com/faq/usage.html#开启了-https-重定向后关不掉)
>
> [更多常见问题](https://vanblog.mereith.com/faq/)

## 关于更新

现在这个项目由 AI 全自动维护：可复现的代码问题会复现、补测试并以 PR 提交，changelog 和官网文档会跟着改。

正式发版仍由作者打 tag：`v*` 部署产品，`doc*` 部署官网。演示站和官网会停留在最近一次已打 tag 的版本，直到作者发版。

如果遇到了问题，可以先更新到已发布版本试试看。

## 交流群

- [VanBlog 交流群](https://jq.qq.com/?_wv=1027&k=5NRyK2Sw)

## 说明与文档

请移步项目主页： [https://vanblog.mereith.com](https://vanblog.mereith.com)

## CHANGELOG

[CHANGELOG](CHANGELOG.md)

## 开发指南

- [开发指南](https://vanblog.mereith.com/contribution.html)

## 谁在使用

现在可能用的人有一些了吧 - -

如果您想把自己加进来，请提一个 [issue](https://github.com/Mereithhh/van-blog/issues/new/choose)，我会尽快添加的。

- [Mereith's Blog](https://www.mereith.com)
- [GT 的官方博客](https://gt-it.net)
- [無糧不聚兵‘s Blog](https://www.wongcw.cn)
- [oldmoon](https://www.oldmoon.top/)
- [seek.wiki](https://seek.wiki)
- [SnailBlog](https://blog.mldd521.com)
- [Peter's blog](https://niuery.com)
- [我本无罪的博客](https://blog.rnaan.com/)
- [青菜的杂货铺](https://211222.xyz)
- [花菜的博客](https://blog.huacai.one)
- [智芯物联的空间](https://www.tingshuo.online)
- [Done](https://www.dong-blog.fun/)
- [SpaceX](https://tech.twjblog.top/)
- [没想好的个人博客](https://blog.shizhuoran.top/)
- [宁骑播客](https://blog.xintianyuehui.cn/)
- [fanyang](https://fuis.me/)

## TODO

- [x] 精简前台 js 体积，优化性能
- [x] 精简打包体积
- [x] 集成 HTTPS 和自动证书申请续期
- [x] 后台增加登录日志
- [x] 内嵌评论系统
- [x] 支持 ARM64
- [x] 支持 mermaid 语法
- [x] 替换编辑器为 bytemd（掘金同款）（老的编辑器有些臃肿，复制偶尔会有格式会错乱的问题）
- [x] 导入 md 创建文章/草稿功能
- [x] 标签管理
- [x] 黑暗模式图标样式优化
- [x] 内嵌评论的邮件通知和 webhook
- [x] 自定义 css
- [x] 添加自定义 script 标签
- [x] 添加自定义 html 代码
- [x] 可添加具有自定义权限的协作者
- [x] 自定义页面
- [x] RSS 订阅
- [x] 自定义高亮块语法支持
- [x] Emoji 表情选择器
- [x] 自定义导航栏
- [x] 后端性能优化一期（减少不必要的查询， ISR 防抖等）
- [x] Token 管理
- [x] picgo 插件安装
- [x] 忘记密码
- [x] 分类加密
- [x] 自定义文字路径
- [x] 系统日志查看
- [ ] 快捷分享按钮
- [x] 完善可自定义上传文件的自定义页面功能（现在的自定义页面有潜在的 css 污染问题）
- [x] 图片上传自动添加水印
- [x] 迁移到 pnpm，使用 workspace
- [x] 增加在特定事件后触发执行自定义代码或 webhook 的扩展能力
- [x] 上传图片自动压缩功能
- [x] 批量操作文章草稿
- [ ] 插件系统
- [ ] 自定义主题（前端渲染器）系统
- [ ] 浏览器消息通知
- [ ] 文章/草稿的历史版本管理
- [ ] 精简配置项，尽可能移动到运行时配置
- [ ] 增加 ORM 层，适配更多数据库
- [ ] 增加一些 e2e 测试，集成到 CI
- [ ] 国际化

## 问题反馈

请提 [issue](https://github.com/Mereithhh/van-blog/issues/new/choose)。可复现的代码问题会进入 AI 全自动排查和修复流程并开出 PR；「样例提交」仍由作者处理。合并与发版由作者完成。

## 打赏

如果觉得项目不错的话可以打赏哦。您的支持就是我最大的动力！

打赏时您可以备注名称，我会将您添加至打赏列表中。

<p align="center">
  <img alt="打赏-微信" src="/img/wechat.jpg" style="width: 200px;margin-right: 4px;" />
  <img alt="打赏-支付宝" src="/img/ali-pay.jpg" style="width: 200px" />
</p>

## 捐赠信息

PS：如果打赏时请备注捐赠者，如有遗漏请联系我添加（有时候消息多可能会漏掉，十分抱歉）

PS2: 不好意思中间有段时间没管，有些记录找不到了，后续有时间补上。

| 捐赠者    | 捐赠金额 | 捐赠日期   |
| --------- | -------- | ---------- |
| Sirit     | 6.66 元  | 2022-09-01 |
| jingcheng | 100 元   | 2022-09-06 |
| mosuzi    | 100 元   | 2022-09-08 |
| ym679     | 20 元    | 2022-09-08 |
| wangcw    | 100 元   | 2022-09-13 |
| ziva      | 8.80 元  | 2022-09-15 |
| Velen     | 50 元    | 2022-09-18 |
| pcz       | 50 元    | 2022-10-19 |
| fanyang   | 100 元    | 2025-06-12 |




## Star 趋势图

[![Star History Chart](https://api.star-history.com/svg?repos=mereithhh/van-blog&type=Date)](https://star-history.com/#mereithhh/van-blog&Date)

## LightHouse 截图

<p align="center"> 
  <img src="/img/lighthouse.png" style="width: 400px"></img>
</p>
