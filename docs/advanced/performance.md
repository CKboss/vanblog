---
title: 前台性能
icon: gauge-high
---

前台（`packages/website`）按「首屏少下载、跳转不等网络、图片不重复拉」三条线做过一轮优化。下面是做法和实测数据，改前端时请照着维护，别把优化改回去。

<!-- more -->

## 首屏 JS：重依赖全部按需加载

Markdown 渲染管线里有三个「重」依赖，以前是**静态 import**，导致每个渲染 markdown 的页面（首页、文章页、关于页、友链页）都要下载它们，哪怕这篇文章根本没有公式和流程图：

| 依赖 | 体积（未压缩） | 现在的加载时机 |
| --- | --- | --- |
| mermaid（含 d3 等） | 1 MB+ | 正文里真的有 ` ```mermaid ` 代码块时才 `import()` |
| KaTeX | 275 KB | 正文里真的有公式（`$…$` / `$$…$$`）时才加载对应渲染器 |
| TOC 里的 KaTeX | 同上 | 目录标题里真的有 `$` 时才 `import()`，加载完自动重渲染标签 |

做法：

- `components/Markdown/` 现在是 **外壳 + 三个变体**：`MarkdownView.tsx`（共用外壳，不含任何重依赖）、
  `MarkdownPlain.tsx`（连 highlight.js 都不带）、`MarkdownBase.tsx`（GFM / 高亮 / 容器 / 原始 HTML / 标题 / 图片）、
  `MarkdownRich.tsx`（= Base + KaTeX + mermaid）。`index.tsx` 只做两件便宜的纯字符串嗅探（SSR 同步完成）
  再用 `next/dynamic` 三选一：
  **有公式 / 流程图 → Rich**；**有围栏代码块 → Base**（highlight.js 生产构建 185KB 原始 / 66KB gzip）；
  **都没有 → Plain**。大多数页面（友链页的申领说明、没有代码块的文章）走 Plain，
  首屏因此不会下载 highlight.js —— 它以前在**每个**渲染 markdown 的页面上都下载。
  实测页面引用到的全部资源 gzip 之和：首页 **458,979 → 398,286 B（−13.2%）**、`/link` −13.0%、`/about` −12.2%；
  全站 53 篇里仍有 8 篇照常带高亮（说明嗅探没有把该高亮的漏掉）。
- **列表页永远只用轻量渲染器**：摘要只有 200 字 / 4 行，不会有流程图，公式即使出现也只是显示成 `$E=mc^2$` 原文，点进文章页仍是完整渲染。
- `PostCard` **不能**直接 import 完整版渲染器（一 import，KaTeX 就会被算进所有列表页的首屏 JS，实测首页从 286 kB 涨回 432 kB）。文章页 / 关于页通过 `markdownRenderer` prop 把自己的懒加载渲染器传进去。
- 嗅探宁可误判也不能漏判：漏判会让公式显示成原文，误判只是多下载一个 chunk。

### 实测（`next build` 的 First Load JS）

::: warning 2026-09-21 标注：下面这张表的**绝对值是当时的实测**，不要当成今天的基线
代码后来长大了（`PostCard`/`Markdown` 那条链等），所以同一份代码在 **`next` 14** 下实测首页已经是 **360 kB**、
在 **`next` 15** 下是 **363 kB**（A/B 同代码构建，见 `benchmark.md` §2.1）。
🔴 **表里的相对结论仍然成立**：静态 import 完整版渲染器的代价、以及各路由的降幅比例。
👉 **方法论**：A/B 性能对比必须用**同一份代码分别构建两个版本**；文档里记着的旧数字描述的是**那一天的代码**，
拿它当"改前"那一侧，等于把此后所有的代码增长都算到被测对象头上。
:::

| 路由 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| `/` 首页 | 432 kB | **286 kB** | −34% |
| `/post/[id]` 文章页 | 427 kB | **281 kB** | −34% |
| `/about` 关于页 | 430 kB | **284 kB** | −34% |
| `/link` 友链页 | 418 kB | **172 kB** | −59% |
| `/category` `/tag` `/timeline` | 168 kB | 168 kB | 本来就不渲染 markdown |

首页实际下载的资源（**这一轮当时**的实测）：26 个文件、原始 1541 KB / gzip **459 KB**（优化前 1825 KB / 538 KB），且不再包含 KaTeX chunk。
⚠️ 这个 459 KB 后来又被三档渲染器压到 **398 KB**（见上面 `MarkdownPlain` 那条），别把两个数字当成同一次测量。

## 图片

- 正文图片一律 `loading="lazy"` + `decoding="async"`（由 `components/Markdown/img.tsx` 的 rehype 插件统一加），首屏不会被下面的图拖住，解码也不占主线程。
- 文章封面是 LCP 元素：`fetchpriority="high"` + `decoding="async"`。
- 服务端给静态资源加了缓存头（原来只有 `max-age=0`，等于每次翻页都要重新问一遍）：
  - 图床图片与缩略图：`public, max-age=3600, stale-while-revalidate=604800` —— 会话内翻页/回退直接内存命中，过期后先用旧图立即渲染、后台再校验。**不用 `immutable`**，因为「替换图片」功能是同名覆盖。
  - 其它静态文件（自定义页面、导出包等）：`public, max-age=300, must-revalidate`。
- 上传时已经做了 WebP/AVIF 压缩与长边 1920 缩放，列表页还有 300px 缩略图，见 [图床与本地存储](../features/image-storage.md)。

## 页面跳转

- 站内链接都用 `next/link`，生产环境默认 **prefetch**：鼠标还没点，下一页的 JS 和 HTML 已经在缓存里了。
- 页面是 SSG + ISR。后台「静态页面更新策略」**默认是「按需自动」**（改文章时由 server 主动触发重渲染，
  另有 24 小时兜底周期，万一某次触发丢了也能自愈）；改成「延时自动」才看
  `VAN_BLOG_REVALIDATE_TIME` 的秒数，而那个值有 **60 秒下限**（填更小按 60 算，非数字被忽略而不是让构建失败）。
  ⚠️ 早期的 10 秒默认意味着有流量时每页每 10 秒重渲染一轮（本站一轮约 130 个路由），已作废。
  实测首页/分类页 TTFB ≈ 5–11 ms，细节见 [静态页面更新策略](./isr.md)。
- 访客统计（`updatePageview`）改成 `requestIdleCallback` 里发，不和首屏渲染、水合、路由切换抢主线程。

## 其它

- `poweredByHeader: false`（少一个响应头）、`swcMinify: true`。
- Apple 风格皮肤是纯 CSS（`styles/apple.css`），不引入任何运行时 JS。
- 生产环境 Caddy 已开 `encode zstd gzip`，文本资源走压缩传输。

## 后台管理界面（`/admin`）

后台是 umi3 + antd4 的单页应用，优化重点是「进后台的第一屏」和「打开编辑器」：

| 项 | 优化前 | 优化后 |
| --- | --- | --- |
| `dist` 总体积 | 27 MB | **24 MB** |
| `umi.js`（每个页面都要下载） | 1133 KB | **1077 KB** |
| 编辑器路由首包 | ~1748 KB（内含 KaTeX、emoji 数据） | **~911 KB**，KaTeX(280 KB) / emoji(81 KB) / mermaid(2.8 MB) 全部按需 |
| dist 里的 mermaid 副本 | 3 份（约 5.6 MB） | **1 份** |

做法：

- **不再从 `@ant-design/pro-components` 这个巨型桶里导入**（35 个文件全部改成 `pro-table` / `pro-form` / `pro-layout` / `pro-card` / `pro-descriptions` 具体包）。桶会把用不到的 ProList、ProDescriptions 等一起拖进来。
- **KaTeX 按需**：编辑器只在正文里出现 `$…$` / `$$` 时才 `import('@bytemd/plugin-math-ssr')` 和 `katex.css`，嗅探规则与前台一致。
- **表情选择器按需**：以前一进编辑器就把 `@emoji-mart/data`（全量 emoji 元数据）渲染成隐藏的 Picker，现在**第一次点表情按钮**才下载并渲染。
- **mermaid 只留一条加载路径**：原来有 `mermaid.min.js` / `mermaid.js` / `mermaid` 三个 `import()` 回退，webpack 会**各打一份产物**（dist 里三份 mermaid，构建也更慢），而最后一个走的正是已知会导致 #391 崩溃的 core ESM 入口。mermaid 版本是锁定的，`dist/mermaid.min.js` 必然存在，不需要回退。
- **首页三个统计 tab 懒加载**：它们都用 `@ant-design/plots`（G2），静态导入会让一进后台就下载三份图表代码，而用户一次只看一个 tab。现在 `React.lazy` + `Suspense`。
- **不再兼容 IE11**：`targets: { ie: 11 }` 会把大量 core-js polyfill 打进每页都下载的 `umi.js`。后台改成 `chrome: 80` 基线（antd4 + ProComponents 在 IE11 下本来也问题一堆）。
- **图片管理页**：网格与列表的 `<Image>` 加 `loading="lazy"` + `decoding="async"`（一页最多 60 张），网格视图用的本来就是 300px 缩略图、点开预览才拉原图。

原本就开着、不要关掉的：`dynamicImport`（路由级分包）、`hash`（产物指纹 + 长缓存）、`ignoreMomentLocale`、`esbuild`（压缩器）、`mfsu` + `webpack5`（开发时编译加速）、`nodeModulesTransform: none`。

## 列表页的图片与数据（第二轮，实测）

第一轮压的是"首屏 JS 里有什么"，这一轮压的是"列表页到底下载了多少字节"。

**摘要里的图换成缩略图。** 列表卡片渲染的摘要（200 字那段 markdown）里嵌的是**原图**：
实测首页一个摘要里就有 3,497,836 B 和 1,076,400 B 两张 webp，而它们对应的 300px 缩略图
只有 14,098 B 和 8,076 B —— 同一张图的缩略图还被卡片右侧的 `ListThumb` 另外请求了一次，
等于一张图下载两遍（一遍 8KB、一遍 1MB）。`loading="lazy"` 只是把它推迟到滚动时，并没有省掉。

现在 `PostCard` 的 overview 分支会把摘要里的 `/static/img/<name>` 改写成
`/static/img/thumb/<name>`（`utils/excerptThumbs.ts`，markdown 与内联 `<img>` 两种写法都处理，
外链、别的目录、已经是缩略图的一律不动）。**首页那两张图：4.57 MB → 22 KB（208 倍）。**
文章页正文一律保持原图 —— 读者点开文章就是要看大图。

点开放大也不受影响：`components/Markdown/img.tsx` 的 rehype 插件会给缩略图补一个
`data-zoom-src` 指回原图（medium-zoom 1.1 支持这个属性），并且注册一次 `error` 监听 ——
老图片万一没生成过缩略图，加载失败会自动换回原图，不会在卡片上留一个破图标。
⚠️ `data-zoom-src` **必须在 rehype 插件里加**：bytemd 的管线是 `sanitize → 插件`，
写在 markdown 里的 `data-*` 会先被 `rehype-sanitize` 删掉。

**`getPublicMeta()` 加了 5 秒进程内缓存。** server 每次保存文章都会触发一轮全量重渲染，
一轮约 130 个页面（每篇文章的 id 与别名两条路径 + 分页 + 分类 + 标签 + 6 个固定页），
而**每个页面都会调一次** `getPublicMeta` —— 同一份 8.3KB 的 meta 被串行重复拉 130 次（约 1MB）。
接口只发 ETag、不发 Cache-Control，undici 也没法复用。现在加了 TTL 缓存 + 并发合并
（同一个模式在 `utils/commentApi.ts` 里早就有了）：一轮重渲染里 130 次变 1 次。
只缓存**成功**的结果 —— 构建期连不上 server 时走的是默认值分支，那个不能缓存，
否则整个构建过程都会拿着空数据渲染。

**封面图的布局位移（CLS）修掉了。** `ArticleCover` 的 `<img>` 没有 width/height，
而 `.article-cover` 在样式表里**一条规则都没有**，所以盒子高度先是 0、图片解码完再跳到
`min(缩放后高度, 320px)` —— 每次进文章页必然产生一次位移，而这恰好是
`pages/post/[id].tsx` 专门 preload 的 LCP 元素（53 篇里有 16 篇有封面）。
现在 `.article-cover img` 有 `aspect-ratio: 21/9; height: auto`：`object-cover` 本来就按这个比例裁，
视觉不变，只是不再跳。彻底的做法是上传时把宽高存下来（server 已经在跑 sharp），那是后话。

**认不出格式的 GA 测量 ID 不再注入。** `gaAnalysisId` 里填的如果不是 `G-…` / `UA-…`
（比如把别家统计的 id 填进了 GA 字段），以前照样会去请求
`gtag/js?id=<那串东西>` —— 实测返回 200 且 **242,542 B**，为一个根本不存在的 GA 媒体资源白下载。
现在 `shouldInjectGa` 与 `describeGaInjection` 用同一个判据：格式不对就什么都不注入。
⚠️ 两个函数必须一起改：组件实际调的是 `describeGaInjection`，只收紧 `shouldInjectGa` 没用。

**`experimental.largePageDataBytes` 从 10MB 收回 256KB。** Next 13/14 默认 128KB（14.2.35 实测同值），
抬到 10MB（80 倍）等于把**唯一会报警的机制**关掉了：列表页把全文塞进 pageProps、
`/timeline` 把没人读的文章数组塞两份，都不会再有任何提示。现有最大的页面是 `/timeline` 的 73KB，
256KB 绰绰有余；真超了说明有人往 pageProps 里塞了不该塞的东西，那时就该看到构建告警。

### 第二轮实测到的问题（含后来做完的与被推翻的）

⚠️ 这张表是**当时**的实测清单，后来有的做掉了、有的结论被更严谨的实测推翻。
「状态」列是当前事实，别照着"还没动"那列去重复劳动。

| 项 | 当时的实测 | 状态 |
| --- | --- | --- |
| 首页/分页把**全文**塞进 `__NEXT_DATA__` | 首页 HTML 114KB（gzip 33KB），其中 `__NEXT_DATA__` 占 31.8%（gzip 后占 **54.8%**）；5 篇文章的 content 共 25KB，而卡片只需要 3.3KB 摘要 —— **87% 是白送的** | ✅ **已做**：摘要改到 server 侧算（`utils/articleExcerpt.ts` 是前台那套逻辑的逐字符移植：围栏感知的 `<!-- more -->` 定位、200 字回退、截断链接补全、代理对安全），公开列表接口加 `withExcerpt` 开关（不传时响应一个字节都不变）。实测首页 HTML **114,485 → 92,228 B**、gzip **33,156 → 22,661 B（−31.7%）**、`__NEXT_DATA__` 36,297 → 14,040 B、正文 25,053 → **0 B**，卡片渲染逐字节不变；两边一致性由 38 个跨包对拍用例钉住 |
| ByteMD 的**编辑器**进了每个渲染 markdown 页面的首屏 JS | "服务端 chunk 里 1148 个模块，含 9 个 `codemirror-ssr`、57 个 `@popperjs/core`" | ❌ **结论被推翻（我们自己写错的）**：跑了真 `next build` 之后逐个客户端 chunk 搜 `CodeMirror` / `tippy` / `popper` / 编辑器工具栏字符串，**一个都没有** —— 那份"1148 个模块"的证据取自 **dev/server chunk**（未压缩、未 tree-shake）。编辑器本来就没进客户端包；真正的大头是 highlight.js（见上面三档渲染器）。顺带 `MarkdownView` 不再 import `@bytemd/react` 那个桶，并有 spec 防回归。⚠️ 另一个量具坑：Next 的 First Load JS 表**不统计** `dynamic(..., {ssr:true})` 的 chunk，只看那张表会以为什么都没变 |
| `/timeline` 带了 42.5KB 没人读的数据 | pageProps 73.5KB 里 `sortedArticles`（21.3KB）与 `yearGroup.articles`（21.2KB）都没有读者，占 58% | ⬜ 还没动：删字段要同步改 `utils/timelineMonths.ts` 的测试；gzip 后只省 6.6%（两份 JSON 高度相似），收益主要在解析与内存 |
| 每张卡片一个未合并的阅读量请求 | 5 次串行 XHR（89ms vs 并行 36ms），每次返回 220B 的**整个 visit 文档**只为显示一个整数，而这个数字 pageProps 里已经有了 | ✅ **已做**：卡片直接用 pageProps 里的 `article.viewer` 渲染，后台刷新走 50ms 合并器（抄评论数那套写法），首页客户端请求 **42 → 37**。**而且旧数字本身是错的** —— 那个接口读的是"按 pathname 记的台账"，引入拼音别名后同一篇文章被拆成两条（数字 id 一条、别名一条），卡片显示的是半截计数；`article.viewer` 才是原子累计值 |
| apple 皮肤 46KB CSS 在全局样式表里 | 全局 CSS 72.7KB（gzip 16.3KB），其中 apple 46.2KB + markdown 相关 43KB；用 `default` 或自定义主题时那 46KB 是纯浪费 | ⬜ 还没动：挪成按主题加载要处理"apple.css 依赖在 Tailwind 之后引入"的顺序问题，得对两种皮肤做视觉对比。⚠️ 被 Next 的 pages router 挡着（只允许在 `_app` 引第一方全局 CSS） |
| 字体走第三方 CDN | 本机 DNS 解析不出来，每页都有一次 preconnect + 一个 stylesheet 请求卡在 DNS 上；而且 CSS 是水合后才提升的，字体下载**最早也要等 JS 跑完** | 🟡 **做了一半**：拉丁子集（`Maple Mono`）已**自托管**到 `public/fonts/maple-mono-latin-400-normal.woff2`（74,088 B + OFL-1.1 许可证文本，版本钉死 `@fontsource/maple-mono@5.3.0`，`font-display: swap`，只在 apple 皮肤下加**一条** `preload` 且带 `crossOrigin="anonymous"`），**jsDelivr 那个 `@latest` 运行时依赖已经去掉**。中文 / Nerd Font 子集仍走 `static.zeoseven.com` 的 CSS，但是**异步**加载（`media="print"` → 水合后翻 `all`）、解析不了就退回系统字体栈；彻底自托管要按 unicode-range 分包，代码注释里写了做法（做完把 `APPLE_FONT_CSS_URL` 设成 null） |

## C10K 与连接层

「一万条并发连接」这件事要**分两层**看，混在一起就会得出错误的乐观或错误的悲观：

| 路径 | 谁在服务 | 一万条连接挂住、再一起发请求的实测 |
| --- | --- | --- |
| `/static/**`（图床图片、附件） | 内置 caddy **直接发**，不经 Node | **10000 / 10000 全部 200**，1.3 秒建连 + 1.4 秒发完 ✅ |
| `/api/**` 与页面 | caddy 反代到 Node | 修复前 **200 = 6437、502 = 3563**（17.2 秒） |

也就是说：**连接层（caddy）从来不是瓶颈** —— 一万条连接 1 秒多全部建立、0 拒绝；会塌的是"必须反代到 Node"的那部分。

### 那 3563 个 502 是怎么来的（已修）

失败全是 **502**，caddy 自己的日志写着 `dial tcp 127.0.0.1:3000: i/o timeout`。⚠️ 注意它**不是** `cannot assign requested address`，所以不是回环临时端口耗尽。真正的证据在容器内：`TcpExtListenOverflows` 与 `TcpExtListenDrops` 都涨了 **3745**，与 3563 个失败对得上 —— 内核因为**接受队列满了**在丢 SYN。

队列会满，是因为 `app.listen(port, host)` 没传 backlog，Node 用默认值 **511**，而内核取的是 `min(backlog, somaxconn)`。加上 `tcp_abort_on_overflow = 0` 时溢出是**静默**的（丢 SYN 而不是拒绝），客户端只会按 1s / 2s / 4s 重传，所以症状表现为"超时"而不是"被拒"。caddy 反代到 Node 走 HTTP/1.1、每个上游主机只保留 32 条空闲连接，于是一波 N 个并发请求几乎需要 N 条**新建**的上游连接 —— 一台机器、不需要任何技巧就能超过 511。

修复是三件事一起做，缺一件都只能改善一部分：

1. **Node 的 listen backlog 显式设成 4096**（`VANBLOG_LISTEN_BACKLOG`，夹在 1–65535）；
2. **caddy 的上游连接池放大**：`max_idle_conns_per_host` 32 → **512**、`max_idle_conns` 64 → **1024**（这两个值以前落在 Caddy 的默认值上，实测一次万级突发能堆出 **13,221 个 TIME_WAIT** 套接字）；
3. **公开 meta 接口的并发合并（single-flight）**：以前缓存 TTL（5 秒）到期的那一瞬间，一万个并发未命中会各自跑一遍 7 个查询的 `Promise.all`，一起压向 100 条连接的 Mongo 池；现在同一时刻只有一次底层取数，其余请求等同一个 Promise。

::: warning 这一条的验证状态，如实说明

上面第 1 条**单独**的效果有实测：把 backlog 从 511 提到 4096 之后，同样的万级突发里 502 明显减少，但**没有归零**。三条一起落地之后的万级复测**目前没有留在仓库里的可引用记录** —— 所以请不要把"反代路径的 C10K 已达标"当成已验证的结论。

已经确凿的是：**静态直服的 C10K 达标**（10000/10000 全 200），以及**建连层面一万条从来不是问题**。要自己复测，用仓库自带的采集脚本（约 15 分钟，需要一台空闲机器）：

```bash
scripts/benchmark/measure.sh --base http://127.0.0.1:18080 \
  --engine docker --container vb-app --c10k 10000
```

**看到什么算达标**：`## 5. C10K` 那一节里，两个目标都是 `成功建立: 10000`、`200=10000 失败=0`，并且末尾的 `TcpExt.ListenOverflows` 增量是 **Δ=0**。反过来，只要 `ListenOverflows` 在涨，就说明接受队列还在溢出（先查下面的 `somaxconn`）。

:::

### 生产环境要满足的前提（不做这几条，上面都白搭）

::: tip 1. 内核的 somaxconn

**实际生效的 backlog = `min(VANBLOG_LISTEN_BACKLOG, net.core.somaxconn)`。** 本机是 4096，但**很多发行版默认只有 128** —— 那样即使配了 4096 也会被夹到 128，万级并发必然大量 502。

```bash
sysctl net.core.somaxconn                      # 先看现在是多少
sudo sysctl -w net.core.somaxconn=4096         # 立刻生效
echo 'net.core.somaxconn = 4096' | sudo tee /etc/sysctl.d/99-vanblog.conf   # 重启后仍然生效
```

**看到什么算成功**：第一条命令输出 `net.core.somaxconn = 4096`。

:::

::: tip 2. 文件句柄数

一条连接一个句柄，一万条下游 + 一万条上游就要两万个。compose 模板已经给两个服务都设了 `nofile: 65536`，一般够用；要往上抬就改模板里那个值再 `./vanblog.sh config`。

⚠️ **k8s 部署没法在清单里设 nofile**，要靠节点配置（kubelet / containerd 的默认值，或 systemd 单元）。

查容器里**实际**的上限（不要看宿主机的）：

```bash
docker exec vb-app sh -c 'grep "open files" /proc/1/limits'
```

:::

::: tip 3. 采集时记得把限流抬掉

默认配置下同一 IP 每分钟 600 次请求就会被拦，压测测到的会是"限流器多快返回 429"而不是栈的容量。起压测栈时给容器加：

```
VANBLOG_RATE_LIMIT_PER_MIN=100000000
VANBLOG_STATIC_LIMIT_PER_MIN=1000000000
```

:::

### 连接层的超时与上限（caddy 侧，已显式钉住）

标准 Caddy **没有限流模块**，所以 L7 限流全在 Node 里 —— 这意味着攻击流量必须先被 caddy 完整解析一遍。因此连接层的限制要在 caddy 这一侧就收紧：

| 字段 | 现在的值 | Caddy / Go 的默认值 | 为什么这么设 |
| --- | --- | --- | --- |
| `read_header_timeout` | **10 秒** | 1 分钟 | 防 slowloris 的主力。请求头约 1KB，移动网络下 10 秒已经很宽 |
| `idle_timeout` | **60 秒** | 5 分钟 | 限制一堆空闲连接能占多久，同时不影响 keep-alive 复用 |
| `max_header_bytes` | **32768** | 1 MB（Go 默认） | 一万条连接 × 1MB 的请求头缓冲 = **10GB 内存放大器**。本站的令牌放在 `token` 请求头而不是 cookie，32KB 绰绰有余（nginx 默认才 8KB） |
| `read_timeout` / `write_timeout` | **故意不设** | 0（不限） | 见下 |

**为什么不设读写超时**：同一个 443 server 上挂着匿名的整站恢复上传（**8 GiB**）、图片上传（50 MiB）、附件与 JSON 导入（200 MiB），以及备份下载。任何有限的 `read_timeout` 都会把一次合法的大恢复掐断，`write_timeout` 会掐断备份下载。慢 body 的防线留在 Node 侧：`requestTimeout`（默认 300 秒，`VANBLOG_REQUEST_TIMEOUT_MS`）+ 请求体上限 + 恢复归档的体积与剩余空间闸门。

⚠️ **由此带来一个已知的恢复缺陷（别踩）**：`requestTimeout` 是 300 秒，所以走**匿名 HTTP 上传**恢复一个 8 GiB 归档，需要持续 **≥27 MB/s** 的上行；家用宽带必然超时，而且报出来的错是"超时"而不是"归档太大"，很容易排查错方向。**照做的办法**：把归档放进备份目录（`<数据目录>/log/vanblog-backups/`），然后用

```bash
./vanblog.sh reset <归档路径>
```

这条路是服务端**本地读文件**，不走 HTTP 上传，没有这个限制。详见 [备份与恢复](./backup.md)。

⚠️ 另外一条容易踩的坑：Caddy 的 JSON 配置里，超时是 server 对象上的**平铺字段**（`read_header_timeout` 等），而 `timeouts: { … }` 那种**嵌套写法是 Caddyfile 的语法**。Caddy 解码模块配置是**严格**的 —— 字段名写错会直接校验失败，于是 `entrypoint.sh` 回落到降级模板（自签证书、没有按需 TLS）。也就是说"加一个超时"加错了名字，代价是**静默失去 HTTPS**。超时也**只能设在 server 级**，没有按路由的超时。

### 日志的磁盘占用

三个文件型日志写入器都显式钉成 **100 MB / 保留 10 份 / 90 天**（caddy 访问日志、caddy 日志、server 的 stdio 日志）。这本来就是 Caddy 的默认值，写出来是因为镜像里的 caddy 是用**不锁版本**的 `apk add` 装的：万一哪天默认值变了，"这会不会写满小磁盘"的答案也会跟着变，所以把它固定住。

被打的时候访问日志是每秒几千行的真实磁盘 IO，而且里面有访客 IP。要关掉用 `VANBLOG_CADDY_ACCESS_LOG=false`（只关**访问**日志，错误日志仍然留着）。

## 想继续压的话

- `highlight.js` 用的是 lowlight 的 common 语言集（约 35 种），如果站点只用少数几种语言，可以换成 `highlight.js/lib/core` + 手动注册，能再省几十 KB。
- `polyfills`（89 KB / gzip 30 KB）是 Next 为老浏览器准备的，可按 browserslist 调整。
- 全局 CSS 目前一份（gzip 约 17 KB），其中 `code-light.css` / `code-dark.css` 只有文章页用得到，可以改成按页引入。
- 后台还有两个大头是**按需**加载的：monaco 编辑器（代码/自定义页面，约 2.7 MB + 各语言 worker）和 mermaid（2.8 MB）。它们只在对应页面/内容出现时才下载，但如果想进一步瘦身，可以考虑 monaco 只保留实际用到的语言 worker（`typescript` 的 worker 有 4.8 MB）。
- 后台的 `@ant-design/plots`（G2）目前只在首页统计用，换成轻量图表库可以再省几百 KB。

::: warning 别做的事

- 不要在 `PostCard` 或任何列表页组件里静态 import `components/Markdown`（会把 KaTeX 拖进首屏）。
- 不要把 `tocMath.ts` 的 `import("@bytemd/plugin-math-ssr")` 改回静态 import。
- 不要给图床图片加 `immutable` 缓存（替换图片是同名覆盖）。

:::
