---
title: 搜索引擎优化
icon: dumbbell
---

VanBlog 内置一些搜索引擎优化策略，开箱即用，无需任何配置。具体有：

## 前台均为静态页面

前台均为静态页面，首屏加载和源代码均包含了全部信息。

## robots.txt

`/robots.txt` 由 **server 动态生成**（不再是仓库里的静态文件），因为 `Sitemap:` 指令必须是绝对 URL，
而静态文件不知道你的域名。当前内容：

```
User-agent: *
Disallow: /api/
Disallow: /admin/
Disallow: /admin
Disallow: /swagger
Disallow: /swagger-json
Disallow: /static/export/
Disallow: /static/tmp/
Disallow: /static/upload-tmp/
Allow: /static/

Sitemap: https://你的域名/sitemap.xml
```

- 屏蔽了接口、后台、`/swagger`（整个后台 API 面的文档）以及导出归档 / 临时目录，
  但**放开 `/static/`**（图床与附件需要被收录）。
- 站点 URL 没配（或配得不成样子）时不会写出一条错误的 `Sitemap:`，而是留一行注释提示。
- 带 `Cache-Control: public, max-age=3600`：爬虫请求很频繁，改完站点 URL 最多一小时后生效。
- 生产环境由内置 caddy 把 `/robots.txt` 转给 server；开发环境下 Next 也做了同样的 rewrite。

## sitemap

每次在后台更新数据时，会在几分钟内重新生成 `sitemap.xml`，包括所有页面的可见链接（不包括隐藏文章）。
设置了自定义路径名的文章会以 `/post/<pathname>` 出现在 sitemap 中。

每条 URL 都带 **`<lastmod>` / `<changefreq>` / `<priority>`**（以前只有 `<loc>`，
爬虫拿不到任何"什么时候变过"的信号，只能按自己的节奏重抓全站）：

| 页面 | lastmod | changefreq | priority |
| --- | --- | --- | --- |
| `/` | 最新文章更新时间 | daily | 1.0 |
| `/timeline` | 最新文章更新时间 | daily | 0.7 |
| `/category`、`/tag` | 最新文章更新时间 | weekly | 0.6 |
| `/about`、`/link` | — | monthly | 0.5 |
| 文章 `/post/<slug>` | `updatedAt`（无则 `createdAt`） | weekly | 0.8 |
| 分类页 / 标签页 | 最新文章更新时间 | weekly | 0.5 / 0.4 |
| 分页 `/page/N` | 最新文章更新时间 | daily | 第 1 页 0.4，之后逐页递减到 0.2 |
| 自定义页面 | — | monthly | 0.6 |

两个刻意的取舍：

- **加密文章（以及加密分类下的文章）不进 sitemap**：正文对爬虫不可见，收录进来既浪费抓取配额，
  又会被判成薄内容（thin content）拉低站点质量评分。隐藏文章本来就已经排除了。
- **`/page/1` 与首页内容相同**，sitemap 里按 URL 去重，只保留先出现的首页；前台另有 canonical 兜底。

::: warning 前台没起时也会更新

sitemap 与 RSS 是 **server 自己生成的静态文件**，与前台 Next 进程无关。以前它们的生成被
`VANBLOG_DISABLE_WEBSITE` 一起挡掉了，于是「server 单独部署 / 前台没起」时这两个文件**永远不更新**
（爬虫一直拿到旧数据）。现在生成逻辑挪到了那个守卫之前。

:::

## canonical 与重复内容

一篇文章有**两个**可访问地址：`/post/<数字id>` 和 `/post/<拼音别名>`（两个都曾经返回 200），
分页还有 `/page/1` 与 `/` 内容完全相同。搜索引擎会把它们当成重复内容，把权重拆成几份。现在：

1. **301 重定向**：访问 `/post/<数字id>` 而该文章有别名时，服务端直接 301 到 `/post/<别名>`
   （Next 对 `permanent: true` 返回 308，搜索引擎按 301 同等处理）。没有别名的文章仍用数字 id，不会跳。
2. **canonical 标签**：所有页面都输出 `<link rel="canonical">`（由当前路由算出，
   **去掉 query 与 hash**，`/page/1` 规范到 `/`，多余斜杠收敛）。这是第二道保险，
   也能挡住 `?from=rss` 这类带参数进来的重复地址。
3. 站点 URL 没配时**不输出** canonical —— 写一个错误的绝对地址比不写更糟。

## 结构化数据（JSON-LD）

页面里会输出 `application/ld+json`，这是拿到富摘要（发布时间、作者、配图、面包屑）的前提：

- **文章页**：`BlogPosting`（headline / description / image / datePublished / dateModified /
  author / publisher / articleSection / keywords / mainEntityOfPage / inLanguage）
  + `BreadcrumbList`（首页 → 分类 → 文章）。
- **首页**：`WebSite` + `Blog`（name / url / description / author / publisher / inLanguage）。

非法日期会被**直接省略**而不是写成 `Invalid Date`（那会让整段结构化数据校验失败）；
序列化走 `JSON.stringify` 并把 `<` 转义成 `\u003c`，所以不可能从 JSON-LD 里逃出 `</script>`。

上线后可以用 [Google 富媒体搜索结果测试](https://search.google.com/test/rich-results)
或 [Bing 站长工具](https://www.bing.com/webmasters) 验证。

## 从其他博客迁移时保留旧 URL

VanBlog 没有 Hugo 那种站点级 `permalinks` 模板。按篇文章设置「自定义路径名 / slug」后，发布地址就是 `/post/<slug>`；留空则会按标题自动生成汉语拼音路径（`/post/<pinyin-slug>`，重名追加 `-2`、`-3`），只有标题里没有可用字符时才退回 `/post/<数字ID>`。数字 ID 地址始终可用，所以补了别名也不会让旧链接失效。从 Hugo（`post = "/post/:slug"`）迁过来时，把旧 slug 填进去即可让搜索引擎已收录的链接继续打开。见 [从 Hugo 迁移固定链接](../faq/usage.md#从-hugo-迁移固定链接)。

## meta 标签

- **每篇文章有自己的 description**：取正文前 160 字并压成纯文本（剥掉 markdown 记号、
  整块丢掉代码块、图片换成 alt、`<!-- more -->` 不出现），超长时优先在句读处截断并补省略号。
  以前所有页面共用「站点描述」，搜索结果里的摘要千篇一律，点击率差，也浪费了正文里现成的信息。
- 网站描述作为其它页面的 description
- 会有 robots 的 meta 标签
- 文章页面和首页/列表页会有 keywords，具体是由当前页面文章的分类和标签经过去重后生成的
- 全站输出 `og:url`（= canonical）、`og:site_name`、`og:locale`、`og:title`、`og:description`
- 文章页额外输出 `og:type=article`、`article:published_time`、`article:modified_time`、
  `article:section`（分类）、`article:tag`（每个标签一条）、`twitter:title`、`twitter:description`
- 文章设置了[题头图](../features/article.md)时，文章页会带上 `og:image`、`twitter:image` 和 `twitter:card=summary_large_image`，方便飞书 / 知乎等抓取分享预览。相对路径会拼上站点「网站 Url」。没有题头图时不加这些标签。

## 语言标签

前台 `<html lang="zh-CN">`、后台同样 `zh-CN`，与 `og:locale=zh_CN`、RSS 的
`<language>zh-CN</language>` 和 JSON-LD 的 `inLanguage` 一致。
（之前前台是 `zh`、后台是 `cn`：`zh` 在 BCP 47 里是宏语言，简繁与发音规则都不明确；
`cn` 根本不是语言子标签，浏览器与读屏只能当未知语言处理。）

## a 标签

所有前台页面，能用 a 标签的都用了 a 标签，以方便爬取。

## 订阅源（RSS / Atom / JSON Feed）

三种格式同时生成在 `/rss/feed.xml`、`/rss/atom.xml`、`/rss/feed.json`，内容是渲染后的**全文 HTML**。
这一轮修了几处：

- 分类/标签的 `domain` 以前会拼出 `https://域名//category/xxx`（双斜杠），且中文没编码 → 现在收敛尾斜杠并 `encodeURIComponent`；
- **标签也作为 `<category>` 输出**（以前只有分类），feed 阅读器与聚合站可以按标签分组；
- 语言标签写成规范的 `zh-CN`；
- KaTeX 样式表从 2016 年的 0.5.1 升到 0.16.9（旧地址已经失效，公式在阅读器里会没有样式）；
- 加密文章与加密分类下的文章正文替换为「此文章已加密」，不会把受保护内容发进订阅源。

订阅源同样在**前台进程没起**时也会更新（见上面 sitemap 的警告框）。

## 平台对接支持

vanblog 内置了对接 GA 和 百度统计的配置，如需对接其他的平台，可以很简单利用自定义 JS 的功能来实现。
