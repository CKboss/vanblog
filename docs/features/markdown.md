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

## 不支持（写了会原样显示）

这些不是 CommonMark / GFM 的一部分，编辑器和前台**一致地不支持**：

| 语法 | 现状 | 替代写法 |
| --- | --- | --- |
| `==高亮==` | 原样输出 `==高亮==` | `<mark>高亮</mark>` |
| 上标 `X^2^` / 下标 `H~2~O` | 原样输出 | `X<sup>2</sup>` / `H<sub>2</sub>O` |
| emoji 短代码 `:smile:` | 原样输出 | 用编辑器工具栏的 emoji 按钮插入真实字符，或直接打 😀 |
| 定义列表（`术语` + `: 定义`） | 原样输出成一段文字 | 用表格，或 `<dl><dt>…</dt><dd>…</dd></dl>` |
| GitHub Alerts `> [!NOTE]` | 当普通引用处理，`[!NOTE]` 会显示出来 | 用 `::: note` / `::: info` / `::: warning` / `::: danger` 容器 |
| `[[toc]]` 目录指令 | 原样输出 | 不用写，文章页右侧（移动端是抽屉）自动生成目录 |

## front matter（`--- title: … ---`）

有些平台导出的 `.md` 开头会带一段 YAML front matter。VanBlog 的文章元信息存在数据库字段里，所以：

- **编辑器**：由 frontmatter 插件解析掉，预览里不显示；
- **前台文章页 / 列表摘要 / RSS 描述**：渲染前会被剥掉，不会显示成正文（早期版本会把它渲染成一条分隔线加一个巨大的标题，已修）；
- **导入 Markdown 文件**时，front matter 里的 `title`、`category`/`categories`、`tags`、`pathname` 会被读取并写进对应字段。

也就是说：带 front matter 的文件可以直接导入、也可以直接粘贴进编辑器，但发布后**以数据库字段为准**，改标题请去「修改信息」而不是改正文里的那几行。

## 安全

正文里的 HTML 会经过 sanitize 白名单（编辑器与前台**共用同一份**规则）：

- 允许：上表列出的常见排版/内嵌标签，以及 `style`、`data:` 图片等属性；
- 剥掉：`<script>`、所有 `on*` 事件属性（`onclick`、`onerror`…）、`javascript:` 协议；
- 站点级的 JS / CSS / HTML 请放在 [定制化](../advanced/customizing.md)，不要写进文章正文。

::: tip 发现预览和前台不一致？

那属于 bug（两边共用插件与白名单，理论上不该有差异）。可以到 [GitHub Issues](https://github.com/Mereithhh/vanblog/issues) 反馈，附上出问题的 markdown 片段即可。

:::
