---
title: Markdown 支持范围
icon: markdown
order: 6
---

编辑器（后台预览）和前台文章页走的是**同一条渲染流水线**（bytemd：remark-parse → remark-rehype → rehype-raw → sanitize → 插件），所见即所得。下面这张表是逐项实测的结果。

<!-- more -->

## 支持

| 语法 | 说明 |
| --- | --- |
| 标题 `#`~`######` | 前台会自动生成锚点 `id` 和悬停出现的 `#` 永久链接（编辑器预览不显示 `#`，属有意） |
| 粗体 / 斜体 / 粗斜体 / 删除线 | `**粗**`、`*斜*`、`***粗斜***`、`~~删除~~` |
| 行内代码 / 围栏代码块 | 代码块自带语言标签、**行号**、**一键复制按钮**、highlight.js 高亮 |
| 链接 / 自动链接 / 图片 | 站外链接自动加 `target="_blank" rel="noopener noreferrer"`，站内 `#` 锚点不会 |
| 引用块（含嵌套） | |
| 有序 / 无序 / 嵌套列表 | |
| **任务列表** | `- [ ]` / `- [x]`（GFM） |
| **表格与对齐** | `:--`、`:-:`、`--:`（GFM） |
| **脚注** | `正文[^1]` + `[^1]: 注释`（GFM，渲染成上标链接 + 文末脚注区） |
| **数学公式** | 行内 `$E=mc^2$`、块级 `$$…$$`，KaTeX 服务端渲染（不用等浏览器算） |
| **Mermaid** | 流程图 / 时序图 / 甘特图等，配色跟随深浅色主题 |
| **自定义容器** | `::: tip`、`::: info`、`::: note`、`::: warning`、`::: danger`，可自定义标题：`::: tip 我的标题` |
| 分隔线 | `---`（单独一行，且不在文档开头） |
| 内嵌 HTML | `u` `mark` `kbd` `center` `font` `section` `button` `details/summary` `iframe` `img`，以及 `style`、`width`、`title` 等属性 |
| `<!-- more -->` | 摘要截断标记；文章页渲染时会被移除 |
| **高亮** | `==重点==` → `<mark>重点</mark>`（深色模式会自动换底色） |
| **上标 / 下标** | `X^2^` → X<sup>2</sup>，`H~2~O` → H<sub>2</sub>O |
| **emoji 短代码** | `:smile:` → 😄，`:rocket:` → 🚀（认不出的名字保持原样） |
| **定义列表** | 术语单独一行，下一行以 `: ` 开头写定义 → `<dl><dt>…</dt><dd>…</dd></dl>` |
| **GitHub 提示块** | `> [!NOTE]` / `> [!TIP]` / `> [!IMPORTANT]` / `> [!WARNING]` / `> [!CAUTION]` |
| **文内目录** | 单独一行写 `[[toc]]`（或 `[toc]`）→ 就地生成指向各标题的嵌套列表，锚点与标题的 `#` 永久链接一致 |

## 一处行为变化：单个 `~`

为了让 `H~2~O` 这种下标能用，**单个波浪号不再是删除线**：

```markdown
~~这样才是删除线~~     →  <del>这样才是删除线</del>
H~2~O                  →  H<sub>2</sub>O
```

以前写 `~一句话~` 会得到删除线，现在会得到下标。如果确实想要删除线，请写成 `~~…~~`（这也是 CommonMark/GFM 的标准写法；单波浪删除线本来就是 GFM 的可选扩展）。

::: tip 提示块的图标

GitHub 官方渲染会在 `> [!NOTE]` 的标题前放一个内联 SVG 图标。这里的 SVG **被 sanitize 白名单挡掉了**——正文里能塞 `<svg>` 等于多开一个 XSS 面（svg 可以内嵌脚本和外部引用）。图标改由 CSS `::before` 绘制，观感一致但不引入新的信任面。

:::

::: warning 编辑器预览里的目录标记点不动

`[[toc]]` 在预览里会正常生成目录列表，但**点不动**：预览的标题不带 `id`（只有前台渲染时才生成锚点）。发布到前台后链接是正常的。

:::

## front matter（`--- title: … ---`）

有些平台导出的 `.md` 开头会带一段 YAML front matter。VanBlog 的文章元信息存在数据库字段里，所以：

- **编辑器**：由 frontmatter 插件解析掉，预览里不显示；
- **前台文章页 / 列表摘要 / RSS 描述**：渲染前会被剥掉，不会显示成正文（早期版本会把它渲染成一条分隔线加一个巨大的标题，已修）；
- **导入 Markdown 文件**时，front matter 里的 `title`、`category`/`categories`、`tags`、`pathname` 会被读取并写进对应字段。

也就是说：带 front matter 的文件可以直接导入、也可以直接粘贴进编辑器，但发布后**以数据库字段为准**，改标题请去「修改信息」而不是改正文里的那几行。

## 用的是哪些插件

前后端共用同一套（版本按 bytemd 1.21 所依赖的 unified 10 / mdast v3 世代挑选，不能用更高大版本）：

| 语法 | 插件 |
| --- | --- |
| `==高亮==` | `micromark-extension-mark` + `mdast-util-mark`（官方的 pandoc mark 扩展对；npm 上的 `remark-mark` 是 0.0.0 占位包，不能用） |
| 上标 / 下标 | `remark-supersub` |
| emoji 短代码 | `remark-gemoji` |
| 定义列表 | `remark-definition-list`（还要把 `defListHastHandlers` 传给 `remark-rehype`，否则会被当未知节点摊成 `<div>`） |
| GitHub 提示块 | `remark-github-blockquote-alert` |
| `[[toc]]` | 自带实现：标准 `remark-toc` 只认**标题**形式的标记（如 `## 目录`），而且用 github-slugger 生成锚点，和本站标题 id 规则不一致，点不动 |

## 安全

正文里的 HTML 会经过 sanitize 白名单（编辑器与前台**共用同一份**规则）：

- 允许：上表列出的常见排版/内嵌标签（含新增的 `mark` / `dl` / `dt` / `dd`），以及 `style`、`data:` 图片等属性；
- 剥掉：`<script>`、所有 `on*` 事件属性（`onclick`、`onerror`…）、`javascript:` 协议；
- 站点级的 JS / CSS / HTML 请放在 [定制化](../advanced/customizing.md)，不要写进文章正文。

::: tip 发现预览和前台不一致？

那属于 bug（两边共用插件与白名单，理论上不该有差异）。可以到 [GitHub Issues](https://github.com/Mereithhh/vanblog/issues) 反馈，附上出问题的 markdown 片段即可。

:::
