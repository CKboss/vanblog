---
title: 主题（前台皮肤）
icon: palette
order: 9
---

# 主题（前台皮肤）

**一个主题就是一份 CSS 文件。** 在后台上传、点「启用」，前台刷新一下就能看到新皮肤 ——
不用改代码、不用重新构建、不用重启容器。

内置两个主题（`Apple 风格` 与 `默认`），另外可以在 `系统设置 → 主题` 里上传任意多个自定义主题，
随时切换。

<!-- more -->

## 快速开始（三步）

1. 下载示例主题：[theme-demo.css](/theme-demo.css)（一份完整可用的「暖纸」主题，约 130 行，注释很全）
2. 后台 `系统设置 → 主题 → 上传主题（.css）`：选这个文件，主题 id 填 `warm-paper`，点上传
3. 在列表里点它的「启用」→ 打开前台刷新

也可以在 `站点管理 → 系统设置 → 站点配置 → 布局设置 → 界面风格` 里直接选（下拉框会列出所有已上传的主题）。

::: tip 切回原来的样子

把主题切成 `Apple 风格` 或 `默认` 即可。主题**只改样式、不改 DOM 结构**，所以任何时候切回去都不会丢东西。

:::

## 从零写一个主题

### 第 0 步：知道 id 会被写到哪

前台会把当前主题的 id 同时写到两个地方：

```html
<html data-ui="warm-paper" class="...">
  ...
  <div class="vb-root" data-ui="warm-paper">...</div>
</html>
```

所以你的**每一条规则都应该挂在 `[data-ui="你的id"]` 下面**：

```css
[data-ui='warm-paper'] .vanblog-body {
  background: #f7f3ec;
}
```

这样做的收益：多个主题可以共存在同一台服务器上，切换时互不污染；切回 `default` 时你的样式整体失效，
不会留下"洗不掉的"痕迹。上传时如果服务端发现你一份 `[data-ui=` 都没写，会给一条警告
（不拦你，但切主题时可能残留）。

### 第 1 步：先定义一套设计令牌

把颜色、圆角、字体集中成 CSS 变量，后面所有规则都引用它们 —— 改配色时只动这一段：

```css
[data-ui='warm-paper'] {
  --wp-bg: #f7f3ec;
  --wp-surface: #fffdf8;
  --wp-text: #2f2a24;
  --wp-muted: #7d7367;
  --wp-accent: #b4552d;
  --wp-hairline: rgba(47, 42, 36, 0.12);
  --wp-radius: 10px;
}
```

### 第 2 步：暗色模式

站点本身有暗色机制：切换时会给 `<html>` 加 `.dark`。所以暗色只要**反转令牌**，下面的规则一条都不用改：

```css
html.dark [data-ui='warm-paper'] {
  --wp-bg: #1c1917;
  --wp-surface: #262220;
  --wp-text: #ece5da;
  --wp-muted: #a89c8d;
  --wp-accent: #e08a5f;
  --wp-hairline: rgba(236, 229, 218, 0.14);
}
```

### 第 3 步：用稳定的钩子选到你要改的地方

前台给主要区块都留了**稳定的 class**（不会因为改样式而变），按需用即可：

| 选择器 | 对应的位置 |
| --- | --- |
| `.vb-root` | 前台最外层容器（铺底色、设字体从这里下手） |
| `.vanblog-body` | 内容区整体 |
| `.vanblog-main` | 主栏（文章列表 / 文章正文所在的那一列） |
| `.vanblog-sider` | 侧栏 |
| `#author-card` | 侧栏的作者卡片 |
| `.vanblog-article-page` | 文章详情页 |
| `.vanblog-timeline` / `.vanblog-timeline-item` | 归档（时间线）页与其中每一项 |
| `.vanblog-category-list` | 分类列表 |
| `.vanblog-link-card` | 友链卡片 |
| `.vanblog-search-overlay` / `.vanblog-search-panel` | 搜索遮罩与面板 |
| `.vanblog-nav-dropdown` | 导航栏下拉 |
| `.vanblog-social-popover` | 社交账号弹层 |
| `.vanblog-notfound` | 404 页 |

一个最小但完整的例子：

```css
[data-ui='warm-paper'] .vb-root {
  background: var(--wp-bg);
  color: var(--wp-text);
}
[data-ui='warm-paper'] a {
  color: var(--wp-accent);
}
[data-ui='warm-paper'] .vanblog-article-page {
  line-height: 1.85;
}
[data-ui='warm-paper'] .vanblog-article-page blockquote {
  border-left: 3px solid var(--wp-accent);
  color: var(--wp-muted);
}
[data-ui='warm-paper'] #author-card,
[data-ui='warm-paper'] .vanblog-link-card {
  background: var(--wp-surface);
  border: 1px solid var(--wp-hairline);
  border-radius: var(--wp-radius);
}
```

### 第 4 步：窄屏

前台用的是 Tailwind 断点（sm 640 / md 768 / lg 1024），媒体查询照常用：

```css
@media (max-width: 767px) {
  [data-ui='warm-paper'] .vanblog-article-page {
    font-size: 16px;
    line-height: 1.75;
  }
}
```

### 第 5 步：上传前自查

- [ ] 每条规则都在 `[data-ui='你的id']` 下面
- [ ] 暗色写在 `html.dark [data-ui='你的id']` 下面
- [ ] 没有 `!important` 满天飞（内置样式优先级不高，一般用不着）
- [ ] 文件是 UTF-8、扩展名 `.css`、小于 512KB
- [ ] 引字体的 `@import` 写在**文件最前面**（CSS 规范要求，写在中间浏览器会忽略）

::: warning 不要做的事

- **不要给带 `.ua` 类名的元素加 `hover: scale(...)` 之类的缩放**：前台有一批元素靠
  `.ua` 统一约束变换行为，仓库里有测试守着 `.ua, .ua:hover { transform: none }`，
  你自己加缩放会和它打架（表现为悬停时抖动）。
- 不要写 `position: fixed` 盖住导航栏，也不要把 `.vanblog-*` 的 `display` 全改成 `none`
  —— 结构没变，藏掉之后切回别的主题会遇到"东西不见了"的错觉。
- 不要塞 base64 大图（512KB 很快就满了），图片请传到图床再用 URL 引用。

:::

## 规则与限制

| 项 | 限制 | 说明 |
| --- | --- | --- |
| 文件类型 | 只接受 `.css` | 主题就是样式表，不含 JS |
| 大小 | ≤ 512KB | 再大通常是把图片 base64 塞进来了 |
| 被拒的内容 | `javascript:`、`expression(`、`behavior:`、`-moz-binding`、`</style>`、`<script>` | 主题会注入到每一个前台页面，注入面必须堵住 |
| 远程 `@import` | 允许，但会警告 | 引字体是正当用法；注意它会把访客 IP 交给第三方 |
| 主题 id | 小写字母/数字开头，可含 `-` `_`，2–40 位 | 会同时用作 `data-ui` 的值和文件名的一部分 |
| 保留 id | `default`、`apple` | 内置主题的名字，不能占用 |
| 同 id 重复上传 | 覆盖 | 文件名带内容 hash，访客不会拿到旧缓存 |
| 删除 | 内置的、正在使用的不能删 | 先切到别的主题再删 |

## 生效时机与缓存

启用主题后 server 会**触发一次前台全量渲染**（ISR），不过即使渲染还没跑完，你刷新页面也已经是新皮肤了 ——
因为主题 CSS 是通过一个**固定地址**提供的：

```
GET /api/public/theme.css
```

它带 `ETag`（内容 hash）和 `Cache-Control: no-cache`，浏览器每次廉价地协商一下：
没变就是 304，变了就拿到新的。这样"换主题"这件事不依赖静态页面有没有重新生成。

上传/覆盖当前正在用的主题时同样会触发一次全量渲染（因为页面里的 `data-ui` 值可能变了）。

## 接口

公开（前台用）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/public/theme` | 当前生效的主题：`{ uiStyle, theme }` |
| GET | `/api/public/theme.css` | 当前主题的 CSS（内置主题返回 204；带 ETag / no-cache） |

后台（需要管理员 token）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/theme/all` | 主题列表（内置 + 上传）与当前生效的 id |
| POST | `/api/admin/theme/upload` | 上传主题，`multipart` 字段 `file`，可带 `id/name/description/author/version` |
| POST | `/api/admin/theme/active` | 启用：`{ "id": "warm-paper" }` |
| DELETE | `/api/admin/theme/:id` | 删除一个上传的主题 |
| GET | `/api/admin/theme/:id/css` | 看某个上传主题的 CSS 原文（内置主题没有独立文件，返回 404） |

命令行示例（token 在浏览器 F12 → Application → Local Storage → `token`）：

```bash
TOKEN=...
curl -H "token: $TOKEN" http://127.0.0.1/api/admin/theme/all
curl -H "token: $TOKEN" -F "file=@warm-paper.css" -F "id=warm-paper" -F "name=暖纸" \
  http://127.0.0.1/api/admin/theme/upload
curl -H "token: $TOKEN" -H 'Content-Type: application/json' -d '{"id":"warm-paper"}' \
  http://127.0.0.1/api/admin/theme/active
```

## 它是怎么实现的（想改代码的人看）

```
后台「系统设置 → 主题」
   │  POST /api/admin/theme/upload（multipart）
   ▼
ThemeProvider.upload()                       packages/server/src/provider/theme/theme.provider.ts
   │  ① validateThemeCss()：大小/NUL/注入面/作用域警告   src/types/theme.dto.ts
   │  ② id = 表单给的 || slugifyThemeId(文件名)；内置 id 拒绝
   │  ③ 写文件：<static>/themes/<id>-<hash8>.css       （hash = sha1 前 8 位）
   │  ④ 元数据写进 settings 集合的 { type: 'theme', value: { themes: [...] } }
   │  ⑤ 同 id 覆盖时删掉旧文件；如果改的是当前主题，触发 ISR 全量渲染
   ▼
启用：ThemeProvider.activate(id) → metaProvider.updateSiteInfo({ uiStyle: id }) + isrProvider.activeAll()
   ▼
前台                                         packages/website
   getLayoutProps.ts   uiStyle = siteInfo.uiStyle（原样透传，空值按 apple）
   Layout/index.tsx    <html data-ui> 与 .vb-root 的 data-ui；
                       非内置主题额外挂 <link href="/api/public/theme.css?v=<id>">
   PublicThemeController  GET /api/public/theme.css → 读 <static>/themes/… 并带 ETag/no-cache
```

几个设计取舍：

- **为什么主题 CSS 走接口而不是直接链 `/static/themes/xxx.css`**：前台是静态生成的，
  `<link>` 的 href 在渲染时就写进 HTML 了。href 里带 hash 的话，换主题必须等所有页面重新渲染
  才生效；用固定地址 + 协商缓存，刷新即生效。
- **为什么内置主题不入库**：`apple` 是仓库代码的一部分（`packages/website/styles/apple.css`，
  被 `globals.css` `@import` 进产物），享受构建期优化；上传的主题是运行期文件。
  两者用同一套 id 与 `data-ui` 约定，所以前台不需要区分对待。
- **为什么元数据放 settings 而不是新建集合**：只是一个小数组，`settings` 已经是
  "按 type 存一份 value" 的形状（`static`/`isr`/`menu`/`waline`…），加一个 `type: 'theme'`
  比新建 schema + 注册模块更省事，也不会让整站备份多一张表。
- **文件放在图床目录（`<static>/themes/`）**：这个目录本来就挂载到宿主机、由 caddy 直接服务，
  也会被 `vanblog.sh backup --offline` 一起打包；整站备份（`vanblog-full-*`）**现在**同样包含它
  （`BACKUP_STATIC_FOLDERS` 里的 `themes`，2026-09 才补上，此前主题 CSS 不进归档），
  所以换机器时主题会跟着走。⚠️ 用**旧归档**恢复时仍然会缺主题文件，见下面「常见问题」。

## 常见问题

**切了主题但前台没变？**
先硬刷新一次（Ctrl/Cmd + Shift + R）。如果还没变，去 `系统设置 → 主题` 看列表里的「使用中」标记是不是你选的那个；
再不行看容器日志有没有 `切换主题到 xxx，触发全量渲染`。ISR 全量渲染需要一点时间，
但主题 CSS 本身是协商缓存，正常情况下刷新就该生效。

**和「站点设置 → 定制化」里的自定义 CSS 有什么区别？**
自定义 CSS 是**全局**的，跟着站点走、不受主题切换影响（适合放统计代码、几行微调）；
主题是**成套的皮肤**，可以准备多份随时切换。两者都会生效，自定义 CSS 在后加载，所以同一条规则**以它为准**。

**主题会影响后台吗？**
不会。主题只作用于前台（`packages/website`）；后台的编辑器预览字体是另一套设置。

**能不能改文章页的排版宽度、字体大小？**
可以，`.vanblog-article-page` 就是为这个准备的。内置的 Apple 主题也是这么做的
（它把阅读栏收窄、正文调到 17px）。

**上传的主题会被备份吗？**
会 —— 但**这一条是后来才成立的**。CSS 文件在图床目录下的 `themes/` 里，整站备份（`./vanblog.sh backup`）
和目录级快照（`--offline`）现在都包含它；元数据在数据库的 `settings` 里，也一起备份。

⚠️ **早于该修复导出的整站归档里没有 `themes/`**（当时 `BACKUP_STATIC_FOLDERS` 只打包 `img/file/customPage`）。
用那种归档恢复到新机器，主题列表和"使用中"标记都在（它们在库里），CSS 却没了 ⇒
`/api/public/theme.css` 会返回 **204（没有内容）** —— 读文件失败被服务端 `catch` 掉了，
而内置主题本来就返回 204，所以两种情况**响应完全同形**（连 ETag 都不设），
前台静默用回默认皮肤，而且**一条报错都没有**：204 是成功状态码，网络面板里不是红色，
唯一的线索是"皮肤看起来不对"。
判断办法：`./vanblog.sh verify <归档>` 看成员里有没有 `static/themes/`；
补法：在后台把那几个主题的 CSS 重新上传一次（id 与启用状态不受影响）。
