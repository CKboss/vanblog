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
> 在上游 master `ccd708ce`（v0.54.0+）之上有 **37 个提交、291 个文件、+27k 行**：
> 12 项新功能、一轮四路安全审计加两轮遗留项清理、前后台性能优化，以及一批真实使用中撞到的 UI/健壮性 bug 修复。
> 下面这段是本分支的内容，**其余部分（含文档站、演示站、打赏与捐赠名单）均归原作者所有**。
> 只想看改了什么 → [本分支新增内容](#本分支新增内容)；只想装 → [一键脚本部署](#一键脚本部署)。

## 本分支新增内容

**一句话版本**：内置评论系统（可替代外挂 Waline）· SEO 加固（canonical/301、JSON-LD、sitemap lastmod、动态 robots）· 补齐 6 种 markdown 语法 · 整站备份/恢复与单篇 `.mdz` 带图导出 ·
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
<td><b>整站备份 / 恢复</b></td><td>一个高压缩归档（zstd → xz → gzip 自动选择）打包<b>全部集合 + 评论库 + 图床/附件/自定义页面</b>；支持不解压查看清单、鉴权下载、上传恢复（逐集合原子替换 + 重建索引）</td><td><a href="docs/advanced/backup.md">备份</a></td></tr>
<tr><td><b>单篇导出 <code>.md</code> / <code>.mdz</code></b></td><td><code>.md</code> 是原样正文；<code>.mdz</code> 是 Typora 风格带图包（相对链接 + <code>&lt;标题&gt;.assets/</code>）；外链图片自动抓取，抓不到会保留原链接并生成说明清单；文章/草稿/编辑器未保存内容/关于页都能导</td><td><a href="docs/advanced/backup.md">备份</a></td></tr>
<tr><td>SEO</td>
<td><b>搜索引擎优化</b></td><td><code>/post/&lt;数字id&gt;</code> <b>301 到别名</b>（以前两个地址都返回 200，被当成重复内容拆权重）；全站 <code>canonical</code>（去 query/hash，<code>/page/1</code> 归一到 <code>/</code>）；文章页独立 <code>description</code>（正文前 160 字压成纯文本）+ <code>og:type=article</code> + <code>article:*</code>；<b>JSON-LD 结构化数据</b>（文章页 <code>BlogPosting</code> + 面包屑，首页 <code>WebSite</code>+<code>Blog</code>）；sitemap 补上 <code>lastmod</code>/<code>changefreq</code>/<code>priority</code> 且不再收录加密文章；<code>robots.txt</code> 改由 server 动态生成并带 <code>Sitemap:</code> 绝对地址；RSS 修掉双斜杠、补标签分类、<code>zh-CN</code>、KaTeX 样式表从失效的 0.5.1 升到 0.16.9</td><td><a href="docs/advanced/seo.md">SEO</a></td></tr>
<tr><td>评论</td>
<td><b>内置评论系统</b></td><td>不再必须外挂 Waline：评论存在本站 Mongo、走本站接口，前台是自研组件（两层回复、分页、基础 Markdown、博主标识、深色模式），后台是原生管理页（审核/编辑/删除/批量/按状态与关键词筛选）。可选 <code>内置 / Waline / 关闭</code>，<b>老站点升级默认保持 Waline</b>；支持从 Waline 导出文件<b>一键导入</b>（默认只导正式显示的、按 objectId 幂等、保留原始时间与点赞）与<b>只导出已通过评论</b></td><td><a href="docs/features/comment.md">评论系统</a></td></tr>
<tr><td rowspan="2">观感与部署</td>
<td><b>Apple 风格前台皮肤</b></td><td>后台「站点信息 → 界面风格」一键切换（默认开启）：纯 CSS、每条规则都带 <code>[data-ui="apple"]</code> 作用域，不影响自定义 CSS；深浅色都有令牌可调；列表页有<b>缩略图</b>（没设封面就取正文首图，自动用 300px 缩略图；没图的文章就是<b>纯文字卡</b>，不放假图；后台可<b>一键从正文首图批量补封面</b>，先预览、可逐篇取消、可精确撤销）、<b>标签彩色胶囊</b>（色相由标签名哈希，同名同色）、渐变作者条；深色模式重做了表面层级（顶边高光 + 1px 环，因为纯黑底上投影看不见），不再只有黑白灰；全站字体为 <b>Maple Mono</b>（写在 <code>--ap-font</code> / <code>--ap-font-mono</code> 令牌里，远程字体<b>非阻塞</b>加载，加载不上会自动退回 SF Pro / 苹方 / 雅黑）；<b>后台编辑器预览同字体</b>，所见即所得</td><td><a href="docs/features/config.md">配置</a></td></tr>
<tr><td><b>一键安装装的是本分支</b></td><td>脚本默认 <code>docker pull ghcr.io/ckboss/vanblog:dev-dsh</code>（GitHub Actions 构建发布，<b>小机器也能装</b>）；拉不到时自动退回「克隆源码 + 本地构建」，并按实测 CPU/内存决定并发还是串行。上游脚本拉的是官方镜像，<b>不含这里的任何改动</b></td><td><a href="#一键脚本部署">部署</a></td></tr>
</table>

### 修掉的 bug（都是真实撞到的）

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
| 一键脚本 | `backup` 支持 `--consistent`（先停 MongoDB）、`restore` 会校验压缩包完整性并自动删掉 `mongod.lock`；常规操作不再 `down -v`（那会删卷） |

细节见 [前台性能](docs/advanced/performance.md)。

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

### ⚠️ 行为变化（升级前看一眼）

| 变化 | 说明 |
| --- | --- |
| 单个 `~x~` 现在是**下标** | 为了让 `H~2~O` 可用，关掉了 GFM 的单波浪删除线。删除线请写 `~~x~~`（这本来就是 CommonMark/GFM 的标准写法） |
| 不存在的文章/页码返回 **404** | 以前是 200 + 软 404。如果你有监控按「200 才算正常」，注意这个变化 |
| 评论的 path 键用**数字 id** | 内置评论写入 `/post/<数字id>`；查询时服务端会把 `/post/<id>` 与 `/post/<别名>` 当同一篇展开，所以历史数据两种形式都认 |
| 后台 dev 依赖两个 **pnpm patch** | `patches/` 给 `remark-supersub`、`remark-github-blockquote-alert` 补了 `main` 字段（MFSU 需要）。升级这两个包时 patch 会失效并**明确报错**，重新 `pnpm patch` 一次即可；实在不行把 `mfsu` 设为 `false`（dev 冷启动 ~25s → ~2min） |
| 一键脚本装的是**本分支源码构建**的镜像 | 不再是 `mereith/van-blog:latest`。想回到官方镜像：`VANBLOG_USE_UPSTREAM_IMAGE=true ./vanblog.sh` |
| 「失效图片」报告变准了 | 以前会把 alt 文本里的 URL、代码块里的示例也当成图片去请求，于是误报 + 往 `statics` 插垃圾记录 |
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
| `VAN_BLOG_ADMIN_BUILD_SCRIPT` | `build` | Dockerfile 的构建参数：admin 用 `build`（堆 4096MB）还是 `build:lowmem`（1536MB） |

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

完整清单见 [安全与加固 · 已知未修项](docs/advanced/security.md)。

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
| server（jest） | `cd packages/server && ./node_modules/.bin/jest` | **610** 用例（1 个既有用例需联网拉字体，离线必失败） |
| website（vitest） | `cd packages/website && ./node_modules/.bin/vitest run` | **57 文件 / 543** 用例 |
| admin（node:test） | `cd packages/admin && node --test tests/unit/*.test.js` | **82 套件 / 326** 用例 |
| 部署脚本（bash） | `for t in scripts/tests/*.test.sh; do bash "$t"; done` | **10 文件 / 465** 条断言 |

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
