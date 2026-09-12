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

- `components/Markdown/` 拆成 **外壳 + 两个变体**：`MarkdownView.tsx`（共用外壳，不含任何重依赖）、`MarkdownBase.tsx`（GFM / 高亮 / 容器 / 原始 HTML / 标题 / 图片）、`MarkdownRich.tsx`（= Base + KaTeX + mermaid）。`index.tsx` 只做一件便宜的事：**嗅探正文**（`needsRichMarkdown`）再用 `next/dynamic` 挑变体。
- **列表页永远只用轻量渲染器**：摘要只有 200 字 / 4 行，不会有流程图，公式即使出现也只是显示成 `$E=mc^2$` 原文，点进文章页仍是完整渲染。
- `PostCard` **不能**直接 import 完整版渲染器（一 import，KaTeX 就会被算进所有列表页的首屏 JS，实测首页从 286 kB 涨回 432 kB）。文章页 / 关于页通过 `markdownRenderer` prop 把自己的懒加载渲染器传进去。
- 嗅探宁可误判也不能漏判：漏判会让公式显示成原文，误判只是多下载一个 chunk。

### 实测（`next build` 的 First Load JS）

| 路由 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| `/` 首页 | 432 kB | **286 kB** | −34% |
| `/post/[id]` 文章页 | 427 kB | **281 kB** | −34% |
| `/about` 关于页 | 430 kB | **284 kB** | −34% |
| `/link` 友链页 | 418 kB | **172 kB** | −59% |
| `/category` `/tag` `/timeline` | 168 kB | 168 kB | 本来就不渲染 markdown |

首页实际下载的资源：26 个文件、原始 1541 KB / gzip **459 KB**（优化前 1825 KB / 538 KB），且不再包含 KaTeX chunk。

## 图片

- 正文图片一律 `loading="lazy"` + `decoding="async"`（由 `components/Markdown/img.tsx` 的 rehype 插件统一加），首屏不会被下面的图拖住，解码也不占主线程。
- 文章封面是 LCP 元素：`fetchpriority="high"` + `decoding="async"`。
- 服务端给静态资源加了缓存头（原来只有 `max-age=0`，等于每次翻页都要重新问一遍）：
  - 图床图片与缩略图：`public, max-age=3600, stale-while-revalidate=604800` —— 会话内翻页/回退直接内存命中，过期后先用旧图立即渲染、后台再校验。**不用 `immutable`**，因为「替换图片」功能是同名覆盖。
  - 其它静态文件（自定义页面、导出包等）：`public, max-age=300, must-revalidate`。
- 上传时已经做了 WebP/AVIF 压缩与长边 1920 缩放，列表页还有 300px 缩略图，见 [图床与本地存储](../features/image-storage.md)。

## 页面跳转

- 站内链接都用 `next/link`，生产环境默认 **prefetch**：鼠标还没点，下一页的 JS 和 HTML 已经在缓存里了。
- 页面是 SSG + ISR（`VAN_BLOG_REVALIDATE` / `VAN_BLOG_REVALIDATE_TIME`，默认 10 秒），实测首页/分类页 TTFB ≈ 5–11 ms。
- 访客统计（`updatePageview`）改成 `requestIdleCallback` 里发，不和首屏渲染、水合、路由切换抢主线程。

## 其它

- `poweredByHeader: false`（少一个响应头）、`swcMinify: true`。
- Apple 风格皮肤是纯 CSS（`styles/apple.css`），不引入任何运行时 JS。
- 生产环境 Caddy 已开 `encode zstd gzip`，文本资源走压缩传输。

## 想继续压的话

- `highlight.js` 用的是 lowlight 的 common 语言集（约 35 种），如果站点只用少数几种语言，可以换成 `highlight.js/lib/core` + 手动注册，能再省几十 KB。
- `polyfills`（89 KB / gzip 30 KB）是 Next 为老浏览器准备的，可按 browserslist 调整。
- 全局 CSS 目前一份（gzip 约 17 KB），其中 `code-light.css` / `code-dark.css` 只有文章页用得到，可以改成按页引入。

::: warning 别做的事

- 不要在 `PostCard` 或任何列表页组件里静态 import `components/Markdown`（会把 KaTeX 拖进首屏）。
- 不要把 `tocMath.ts` 的 `import("@bytemd/plugin-math-ssr")` 改回静态 import。
- 不要给图床图片加 `immutable` 缓存（替换图片是同名覆盖）。

:::
