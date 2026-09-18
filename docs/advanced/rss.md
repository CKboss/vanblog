---
title: RSS
icon: rss
---

VanBlog 内置了 `RSS feed 生成器` ，开箱即用。

<!-- more -->

## 简介

你可以从站点的以下地址获取 RSS:

- `<your-site-url>/feed.xml`: RSS 2.0 格式
- `<your-site-url>/feed.json`: JSON 1.1 格式
- `<your-site-url>/atom.xml`: Atom 1.0 格式

这三个短地址由 caddy 改写到 `/rss/...`（`/feed.xml → /rss/feed.xml`、`/atom.xml → /rss/atom.xml`、
`/feed.json → /rss/feed.json`），直接访问 `/rss/` 下的原始地址也一样。

导航栏右上角会默认出现 `RSS` 按钮。您可以在后台的 `布局设置` 中关闭此按钮。

VanBlog 包含后端 Markdown 渲染器，因此你可以在支持 HTML 内容的 RSS 阅读器上获得与网页相近的体验。

::: tip 刚发布的文章不会立刻出现在 feed 里（最多等 3 分钟）

feed 是 server 生成的静态文件，改动后有 **3 分钟防抖**。这是故意的：以前不设条数上限时，
几十篇文章的全站渲染就要 **135ms 同步阻塞事件循环**、三份 feed 各约 350KB，而这件事每小时兜底跑一次、
每次启动跑一次 —— 文章只会越来越多，所以既加了防抖，也把默认条数限到最新 50 条
（`VANBLOG_RSS_ITEM_LIMIT`，设成 0 就是全量）。

实测：新建一篇文章后 60 秒内 `static/rss/` 还是空目录、`/feed.xml` 回 404，**3 分钟后**才出现。

⚠️ 别把它和另外两个产物搞混：**sitemap 与搜索索引的防抖是 60 秒**，只有 RSS 是 3 分钟。
所以「已经搜得到、feed 里却还没有」是正常的，不是 RSS 坏了。

:::

您可以用喜欢的阅读器来浏览和阅读 RSS：

![Feedbro Reader 浏览效果](https://www.mereith.com/static/img/bf84404095bdcf8c4a186e0bb1e48429.clipboard-2022-09-04.png)

![irreader 阅读效果](https://www.mereith.com/static/img/4b1ab8a59a5b6f0d28eef449db64cbfa.clipboard-2022-09-04.png)

::: note

RSS 订阅中的 HTML 暂不支持 mermaid 图表。(如果您有好的解决方案请联系我)

:::

## 信息生成

- 作者: RSS 订阅中的作者邮箱优先取自 `评论设置` 中的作者邮箱，其次是启动 VanBlog 时传递的 `EMAIL` 环境变量。

- 图标:

  订阅中的 `favicon` 和 `images` 属性的优先级如下：

  ![图标/图片优先级](https://www.mereith.com/static/img/27f6636bfe5a53cf51544ab8affd6961.clipboard-2022-09-04.png)

- 摘要

  订阅中每篇文章的 `description` 字段取自文章摘要，与前台列表**同一个口径**：
  `<!-- more -->` 之前的部分；**没有这个标记时取前 200 字**（不是全文）。
  全文在 `content:encoded` 里，阅读器照样能拿到完整正文。

  ⚠️ 截断点如果落在 `[文字](链接)` 中间，会把整个链接补全再截（否则会露出裸括号和半个链接），
  emoji 也不会被切成两半 —— 所以摘要**偶尔略多于 200 字**是正常行为，不是 bug。

  > 以前的实现是"没有 `<!-- more -->` 就把全文塞进 `description`"，而且会在**代码块里的示例标记**处
  > 错误截断。现在两边共用同一份实现，不会再各自漂移。

- 条数

  默认只保留**最新 50 篇**（`VANBLOG_RSS_ITEM_LIMIT`，设 `0` = 不限制）。
  文章很多时这能显著减小 feed 体积；想让老文章也进订阅就调大它或设 0。
