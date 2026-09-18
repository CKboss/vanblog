---
title: 使用常见问题
icon: wrench
order: 2
---

## 从 Hugo 迁移固定链接

Hugo 里常用 `permalinks.post = "/post/:slug"`。VanBlog **没有**全局固定链接模板，而是按篇设置「自定义路径名 / slug」（字段名 `pathname`）。

路径名留空时，VanBlog 会按标题自动生成汉语拼音地址（`/post/<pinyin-slug>`，重名追加 `-2`、`-3`）；标题里没有任何可用字符时才退回 `/post/<数字ID>`。把自定义路径名填成旧文章的 slug 后，发布地址就是 `/post/<slug>`，搜索引擎已收录的旧链接可以继续打开。数字 ID 地址（`/post/123`）始终可用，两种地址指向同一篇。

在这些地方填写：

- 新建文章
- 导入 Markdown 的确认表单（Front Matter 优先读 `pathname`，再读 Hugo 的 `slug`，再读形如 `/post/my-slug` 的 `url`；Hexo 的 `abbrlink` 仍可用）
- 发布草稿
- 文章表格「操作 → 修改信息」，或编辑器右上角「修改信息」

没有 `slug` 字段、只靠文件名生成 URL 的文章，导入后请手动补上自定义路径名，或在「文章管理」点 **生成拼音路径** 一次性批量补齐（只填空值，不覆盖已有别名）。VanBlog 不会解析 `/post/:year/:month/:title` 这类站点级规则，也不会改写数字 ID 路由。

见 [文章管理](../features/article.md)、[迁移助手](../advanced/migrate.md) 与 [搜索引擎优化](../advanced/seo.md)。

## 如何修改友链页 / 关于页的固定文案

到 **站点管理 / 系统设置 / 站点配置 / 布局设置**，改「友链页介绍文案」（列表上方）与「友链页底部文案」（列表下方的申领要求）。留空就用默认文案。底部那份支持 Markdown，并可用 `{{siteName}}`、`{{description}}`、`{{url}}`、`{{logo}}` 四个占位符插入本站信息。

关于页**正文**一直可以在文章管理点「编辑关于」修改。标题「关于我」可在同一处布局设置里改「关于页标题」。见 [友情链接](../advanced/friend-link.md)、[关于页面](../features/about.md) 与 [站点配置](../reference/config.md)。

## 时间线如何按月查看归档

前台导航里的「时间线」就是归档页（`/timeline`）。文章先按年份分组，年份之下再按月分类，例如 `2024` 下面出现 `12月`、`3月`。只有真正写过文章的月份会显示，不会补出没有文章的空月份。一篇里的创建日期决定它落在哪一年、哪一月。

分类页、标签页仍按原来的分组（分类名或年份），不会改成按月。隐藏文章不会出现在时间线里。见 [文章管理](../features/article.md)。

## 如何修改首页每页展示多少篇文章

后台进入 **站点管理 / 系统设置 / 站点配置**，打开 **布局设置**，找到「每页文章数」。默认 5 篇，可填 1–50。保存后前台首页和 `/page/n` 会按新数量分页；分类、标签、时间线仍是完整列表，不是按页切开。改完后会触发前台增量渲染。见 [站点配置](../reference/config.md)。

相关分页操作见 [前台分页跳转到指定页](#前台分页跳转到指定页)。第一页 / 最后一页时上一页 / 下一页会禁用，见 [最后一页还能点下一页](#最后一页还能点下一页)。

## 如何为文章设置题头图

文章可以有一张可选的题头图（封面）。后台进入 **文章管理**，点某篇的「操作 → 修改信息」，或在编辑器右上角「修改信息」，填写「题头图」URL，或点「上传图片」走现有图床。新建文章时也可以设。

设置后：

- 前台文章页顶部会显示这张图
- 分享到飞书、知乎等应用时，会带上 `og:image` / `twitter:image` 预览图

留空或点「清除题头图」则不显示，已有文章的版式不变。导入 Markdown 时，Front Matter 的 `cover` 或 `image` 会预填。见 [文章管理](../features/article.md) 与 [搜索引擎优化](../advanced/seo.md)。

## 如何在文章列表里隐藏 / 取消隐藏

后台「文章管理」一级表格有「是否隐藏」列，可直接开关，不必打开每篇文章的「修改信息」或编辑器。隐藏后前台不展示该文，也不计入总字数 / 时间线等；后台列表仍能看到。也可以在「操作 → 修改信息」或编辑器里改同一字段。见 [文章管理](../features/article.md)。

## 如何隐藏 / 取消隐藏分类

后台进入 **站点管理 / 数据管理 / 分类管理**，表格有「是否隐藏」列，可直接开关；也可以点「修改」改同一字段。隐藏后前台分类列表、导航分类子菜单、分类页和 sitemap 不再出现该分类；后台仍能看到。该分类下的文章不会因此被加密，仍按文章自己的隐藏 / 加密设置展示。见 [分类/标签管理](../features/tag.md)。

## 如何调整分类显示顺序

后台进入 **站点管理 / 数据管理 / 分类管理**，表格有「排序」列，点「上移 / 下移」即可。前台导航分类子菜单、分类列表和分类页会按这个顺序展示，不必靠删除再重建分类（已有文章的分类不能删）。隐藏分类不会出现在前台，但会留在后台列表里；可见分类之间保持你排好的相对顺序。自定义导航菜单的顺序仍在站点配置里改，和分类显示顺序不是一回事。见 [分类/标签管理](../features/tag.md) 与 [#152](https://github.com/Mereithhh/vanblog/issues/152)。

## 如何让分类页默认展开（或收起）全部分类

前台分类列表每一行都可以点（分类名、篇数或 `>` 箭头），展开后箭头变成 V。页上还有「全部展开 / 全部收起」。若希望每次打开都是展开状态，到 **站点管理 / 系统设置 / 站点配置 / 布局设置** 把「分类页默认展开全部分类」设为「默认展开」；默认是全部收起。这项设置只影响 `/category` 分类列表，点进某一个分类、标签页和时间线仍按原来的方式展开。见 [分类/标签管理](../features/tag.md) 与 [站点配置](../reference/config.md)。

## 如何把文章里的外链图片转到自己的图床

从 CSDN 等站点粘贴 Markdown 后，图片还是对方的 URL。打开后台文章（或草稿）编辑器，点工具栏「外链图片转存」。VanBlog 会下载远程图、走现有图床上传（含压缩设置），并改写当前这篇正文。相对路径、本站 `/static` 和已经在图床记录里的地址会跳过；失败的链接保持原样。这只处理当前编辑的文章，不会全站爬取。见 [图床](../features/image-storage.md#外链图片转存) 与 [#434](https://github.com/Mereithhh/vanblog/issues/434)。

## 域名变更后文章里的图片打不开

换域名（或换图床域名）后，文章里的图片可能全部裂开，后台又找不到「旧域名」存在哪个设置里。这是因为本地图床文件仍在容器的 `/static/...`，但编辑器插入时经常把**当时的访问域名**写成绝对地址，例如 `https://old.example.com/static/img/xxx.webp`。改 DNS、改「网站 Url」都不会改 Mongo 里已经存下来的正文。

本站提供批量改写（来历：[#475](https://github.com/Mereithhh/vanblog/issues/475)）：后台进入 **站点管理 / 系统设置 / 图床设置**，在「域名变更后改写文章图片链接」填入旧地址和新地址（需带 `http://` 或 `https://`），确认后会改写**文章和草稿**正文里以此前缀开头的链接，并显示更新篇数。相对路径 `/static/...` 不用改；未填写的第三方图床（如七牛）也不会动。磁盘上的图片文件不会迁移。

建议先到 **备份恢复** 导出一份数据。改完后：

1. 在 **站点配置** 把「网站 Url」改成带协议的新域名（给 RSS / sitemap 用）。
1. 确认新域名 DNS 已指向本站，必要时清 CDN 缓存。
1. 之后请用新域名打开后台再上传图片，新插入的链接才会指向新地址。

`VAN_BLOG_CDN_URL` 只给前台 `/_next/static` 静态资源加前缀，**不会**改文章图片。见 [部署常见问题](./deploy.md#域名变更后文章图片打不开)。

## 配置了 Google Analysis 后前台一直转圈

后台填了 Google Analytics 测量 ID 后，在中国大陆打开前台可能一直转圈或很久才出来，控制台出现 `GET https://www.googletagmanager.com/gtag/js?id=… net::ERR_CONNECTION_TIMED_OUT`。早先的实现会在页面可交互后立刻去拉谷歌脚本，超时会拖住整页加载。当前是 `async` 并在 `window.load` 之后空闲时加载（[#375](https://github.com/Mereithhh/vanblog/issues/375)），谷歌统计不可达时不再堵塞首屏。

站点配置说明见 [访客统计](../features/visitor.md#进阶分析)。谷歌后台没有数据见下一节。

## 配置了 Google Analytics 但谷歌显示尚未收到数据

后台 **站点管理 / 系统设置 / 站点配置 / 高级设置** 里填了测量 ID 后，Google Analytics 提示「尚未从您的网站收到任何数据」。

**`G-XXXXXXXXX` 就是 GA4 的正确格式**，VanBlog 会把它交给 `googletagmanager.com/gtag/js?id=…` 和 `gtag('config', …)`。旧版 `UA-XXXXXXXXX-X` 也可以。不是必须改成别的写法。

更常见的原因：

1. **大陆访问 Google API / `googletagmanager.com` 不通**。访客浏览器加载不了 gtag，谷歌就收不到事件。站长在大陆打开 Analytics 控制台通常也需要代理。这和 [#375](https://github.com/Mereithhh/vanblog/issues/375) 里前台超时是同一类网络问题，不是 ID 填错。
1. 新数据流默认报表可能要等几小时到一天。先看 Analytics 的 **实时** 报表，并用能访问 Google 的网络打开自己的站点。
1. 广告拦截扩展会拦 gtag。本地 `next dev` 也不会注入这段脚本，请用 Docker / 生产前台验证。

需要国内可访问的统计时，不必等 VanBlog 做内置 Umami：到 **站点管理 / 系统设置 / 定制化** 的「自定义 HTML (head)」粘贴 Umami 官方脚本即可，见 [定制化](../advanced/customizing.md#接入-umami-等第三方统计)。布局设置里「是否开启定制化功能」需保持开启。

相关：[访客统计](../features/visitor.md#进阶分析)、[站点配置](../reference/config.md)。

## 开启 uBlock 后日志管理无法加载

后台「站点管理 / 日志管理」打开后提示 `NetworkError when attempting to fetch resource`、表格或系统日志空白，关掉 uBlock Origin（Chrome / Firefox 都一样）又正常。这是广告拦截列表常会拦截路径里带 `log` 的请求（旧接口是 `/api/admin/log`），不是账号或权限问题。当前是请求 `/api/admin/audit`（[#289](https://github.com/Mereithhh/vanblog/issues/289)）；旧路径仍可用。

页面地址仍是 `/admin/site/log`，只改了拉取数据的 API。

## 登录日志里的 IP 是 VPS / Cloudflare 节点地址

站点套了 Cloudflare（或同类 CDN）后，登录日志有时会记下边缘节点或 VPS 自己的 IP，而不是访客。当前是优先读取请求头 `CF-Connecting-IP`（以及常见的 `True-Client-IP`）（[#127](https://github.com/Mereithhh/vanblog/issues/127)）；没有这些头时仍用原来的 `X-Real-IP` / `X-Forwarded-For`。若前面还有一层 Nginx，把 `CF-Connecting-IP` 原样转给 VanBlog，不要改写成边缘 IP。见 [日志](../reference/log.md) 与 [反代](../reference/reverse-proxy.md)。

## Cloudflare 缓存了后台页面或接口

源站对 `/admin` 与 `/api/admin/*` 都发 `private, no-store`，并额外发 CDN / Cloudflare 专用的 `no-store`，所以边缘节点不会缓存后台页面与后台接口。

⚠️ 如果你在 Cloudflare 用「缓存全部」覆盖 `/*`、再靠页面规则绕过：**`/admin*` 匹配不到 `/api/admin`**，两条规则都要写（`/admin*` 与 `/api/admin*`），改完清一次 CDN 缓存。来历：[#140](https://github.com/Mereithhh/vanblog/issues/140)。详见 [部署常见问题](./deploy.md#cloudflare-缓存了后台或后台-api) 与 [反代](../reference/reverse-proxy.md)。

「缓存全部」也会把**前台 HTML** 存进边缘：后台发布后公网站点仍显示旧文章。源站不会对文章页强制 no-store。见 [后台发布后前台不刷新仍显示旧文章](#后台发布后前台不刷新仍显示旧文章)。

## 前台夜间模式流程图看不清

夜间模式阅读文章时，mermaid / 流程图早先按 mermaid 默认浅色主题渲染，浅色节点和发灰的线条贴在深色正文底上，对比很差。当前行为（来历：[#404](https://github.com/Mereithhh/vanblog/issues/404)）：站点或后台预览为暗色时 mermaid 使用 `theme: 'dark'`，并提高文字/描边对比度；白天模式仍是原来的浅色图表。

相关：[前台代码块没有行号](#前台代码块没有行号)、[前台代码块对比度不足](#前台代码块对比度不足)；主题切换本身见 [黑暗模式与响应式](../advanced/darkmode.md)。

## 前台代码块没有行号

文章（以及后台预览里同一套 ByteMD 围栏）早先只包了语言标签和复制按钮，代码左侧没有行号。当前行为（来历：[#404](https://github.com/Mereithhh/vanblog/issues/404)）：每行有可见行号（`code-line` / `data-line`，gutter 带 `aria-hidden`），浅色和深色都保持可读对比；mermaid / 流程图围栏不加行号。

相关：流程图暗色对比度见上一节、围栏高亮对比度见 [前台代码块对比度不足](#前台代码块对比度不足)；`./vanblog.sh` 更新后仍是早先见 [升级常见问题](./update.md#一键脚本更新显示成功但仍是旧版本)。

## 前台代码块对比度不足

夜间模式阅读文章时，围栏代码块里部分高亮（常见是偏暗红的路径/正则、发暗的文档注释）会贴在深色底上，看起来像糊成一团。当前只调整了前台 `code-dark.css` 的 highlight 颜色，正文类 token（默认文字、关键字、字符串、注释等）相对代码块背景达到 WCAG AA（≥ 4.5:1），并保持接近 VS Code 暗色主题的配色（[#175](https://github.com/Mereithhh/vanblog/issues/175)）。

相关：[前台顶栏和代码复制按钮无法用键盘](#前台顶栏和代码复制按钮无法用键盘)、[前台搜索弹层无法用键盘](#前台搜索弹层无法用键盘)、[前台分页方向键和无障碍](#前台分页方向键和无障碍)、[前台分页跳转到指定页](#前台分页跳转到指定页)。

主题切换本身见 [黑暗模式与响应式](../advanced/darkmode.md)。

## 汇编代码块没有高亮

文章里写 ` ```asm `（或 `nasm` / `x86asm`）时，关键字、寄存器与注释都有颜色：highlight.js 的 common 集本身不含汇编，所以额外注册了 Intel/NASM（`asm` / `assembly` / `nasm` / `x86asm` / `intel` / `x86`）与 ARM（`arm` / `armasm`），前台与后台预览用的是同一套。来历：[#294](https://github.com/Mereithhh/vanblog/issues/294)。

语法标签见 [编辑器](../features/editor.md)。围栏行号见 [前台代码块没有行号](#前台代码块没有行号)。夜间对比度见 [前台代码块对比度不足](#前台代码块对比度不足)。

## 前台分页方向键和无障碍

首页或 `/page/n` 底部分页早先的表现是：方向键无效；`•••` 是可点的跳页链接；禁用的上一页/下一页仍是 `<a>`。当前行为（来历：[#175](https://github.com/Mereithhh/vanblog/issues/175) 的 Pagination issues）：焦点在分页内时，← / → 会在可聚焦的页码和上一页/下一页之间移动焦点（两端不循环，省略号和禁用按钮会跳过）；省略号改为装饰性文字，不再带链接；禁用控件不可聚焦，并有 `aria-label`。当前页仍带 `aria-current="page"`。跳转到指定页输入框见 [前台分页跳转到指定页](#前台分页跳转到指定页)。第一页 / 最后一页时上一页 / 下一页不可点见 [最后一页还能点下一页](#最后一页还能点下一页)。

相关：[前台代码块对比度不足](#前台代码块对比度不足)、[前台顶栏和代码复制按钮无法用键盘](#前台顶栏和代码复制按钮无法用键盘)、[前台搜索弹层无法用键盘](#前台搜索弹层无法用键盘)、[前台分页跳转到指定页](#前台分页跳转到指定页)。

## 前台分页跳转到指定页

首页或 `/page/n` 底部分页早先只能点附近页码，页数多时没法直接去第 N 页（例如第 90 页）。当前有跳转控件（来历：[#229](https://github.com/Mereithhh/vanblog/issues/229)）：多页时分页旁有「跳转」页码输入框，输入后回车或点「前往」会按现有路由跳到 `/`（第 1 页）或 `/page/n`。只接受 1..总页数的整数；空值、小数、非数字或超出范围都不会跳转，也不会打开空白页。总页数跟随后台「每页文章数」（[#346](https://github.com/Mereithhh/vanblog/issues/346)）。页码链接、当前页 `aria-current="page"`（[#448](https://github.com/Mereithhh/vanblog/issues/448)）以及第一页 / 最后一页禁用的上一页 / 下一页（[#331](https://github.com/Mereithhh/vanblog/issues/331)）不变。电脑和手机用同一套分页，窄屏会换行而不是撑破布局。

方向键、省略号和上一页/下一页无障碍见 [前台分页方向键和无障碍](#前台分页方向键和无障碍)。如何改每页篇数见 [如何修改首页每页展示多少篇文章](#如何修改首页每页展示多少篇文章)。

## 手机端顶栏网站名没有居中

手机上看前台时，顶栏网站名早先是在汉堡菜单右侧剩下的那一栏里居中（短站名时会明显偏一边），而不是相对整个页面宽度居中。当前行为（来历：[#262](https://github.com/Mereithhh/vanblog/issues/262)）：网站名相对整页 / 视口水平居中；左侧菜单和右侧搜索、主题等按钮位置不变。电脑端导航栏仍是左侧网站名或 logo，布局不变。

见 [站点配置](../reference/config.md) 的「网站名」与「导航栏左侧显示内容」。

## 前台顶栏和代码复制按钮无法用键盘

顶栏搜索、主题切换、RSS、管理后台图标和移动端汉堡菜单早先是带 `onClick` 的 `div`，Tab 到不了，Enter / 空格也点不了；文章代码块右上角复制同样是 `div.code-copy-btn`。当前行为（来历：[#175](https://github.com/Mereithhh/vanblog/issues/175) 的 Inaccessible buttons with keyboard）：这些控件改成真正的 `<button type="button">`（管理后台是指向 `/admin` 的链接），带中文 `aria-label`，可用键盘聚焦并激活。RSS 仍是复制订阅地址到剪贴板。搜索弹层内的方向键 / 焦点陷阱见 [前台搜索弹层无法用键盘](#前台搜索弹层无法用键盘)。

相关：[前台分页跳转到指定页](#前台分页跳转到指定页)。

## 前台搜索弹层无法用键盘

点顶栏搜索或按 <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd> 打开搜索后，早先 Tab 会跑到后面的页面，结果列表不能用方向键选，清除按钮只是带 `onClick` 的 `div`。当前行为（来历：[#175](https://github.com/Mereithhh/vanblog/issues/175) 的 Not interactive with keyboard）：打开后焦点进入对话框（搜索输入框），<kbd>Esc</kbd> 关闭（关闭时不再误拦截 Escape），<kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> 只在弹层内循环，清除是真正的按钮（Enter / 空格），<kbd>↑</kbd> / <kbd>↓</kbd> 在结果间移动，<kbd>Enter</kbd> 打开当前结果。弹层带 `role="dialog"`、`aria-modal` 和中文名称「搜索」。

相关：[前台分页跳转到指定页](#前台分页跳转到指定页)；iPhone Safari 点搜索后页面变暗但没有键盘，见 [iPhone Safari 点搜索没有键盘](#iphone-safari-点搜索没有键盘)。

## iPhone Safari 点搜索没有键盘

iPhone Safari（曾在 iPhone 11 Pro 上报告）点顶栏搜索图标后，页面会变暗（弹层已打开），但输入框没有焦点、系统键盘不出现。这是 Safari 的限制：只有在同一次点击里对输入框调用 `focus()` 才会弹出键盘；早先焦点写在 `useEffect` / 动画结束后，手势已经结束。当前是在点击处理函数里先显示弹层再聚焦搜索框（[#155](https://github.com/Mereithhh/vanblog/issues/155)），桌面 <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd>、<kbd>Esc</kbd> 和弹层内键盘导航不变。

搜索弹层键盘操作见 [前台搜索弹层无法用键盘](#前台搜索弹层无法用键盘)。搜索框 `type="search"`、Safari 输入属性和清除按钮动效见 [搜索框清除按钮动画很怪](#搜索框清除按钮动画很怪)。

## 搜索框清除按钮动画很怪

前台搜索输入框是 `type="search"`（移动端键盘显示「搜索」），并关闭了 Safari 的自动纠正 / 自动大写；清除是一个带「清除搜索」名称的真按钮，悬停只变颜色与透明度，不会突然放大；顶栏搜索图标描边略粗。打开弹层时会锁住页面滚动。⚠️ 目前还**没有**全屏移动端弹层与搜索自动补全。来历：[#173](https://github.com/Mereithhh/vanblog/issues/173)。

## 前台白天模式分页当前页看不清

首页或 `/page/n` 底部分页在白天/白色主题下，`‹ 1 2 3 ›` 可能都是一样的白底灰字，看不出当前页。夜间模式对比足够，这是浅色主题下当前页和普通页都带了 `bg-white`，Tailwind 不会保证后写的 `bg-gray-200` 生效。当前行为（来历：[#333](https://github.com/Mereithhh/vanblog/issues/333)）：当前页用更深底色和白色文字，并带 `aria-current="page"`。

主题切换本身见 [黑暗模式与响应式](../advanced/darkmode.md)。第一页 / 最后一页时上一页 / 下一页不可点见 [最后一页还能点下一页](#最后一页还能点下一页)。

## 最后一页还能点下一页

首页或 `/page/n` 底部分页早先在第一页仍能点「上一页」、最后一页仍能点「下一页」，看起来像还能再翻。当前是**禁用**而不是把按钮拿掉（来历：[#331](https://github.com/Mereithhh/vanblog/issues/331)）：第一页「上一页」不可点，最后一页「下一页」不可点，中间页两者都可用。控件还在，只是变淡、没有链接、没有悬停高亮。页码链接、当前页选中样式（`aria-current="page"`）和「每页文章数」不变。电脑和手机用同一套分页。

方向键与省略号见 [前台分页方向键和无障碍](#前台分页方向键和无障碍)。跳转到指定页见 [前台分页跳转到指定页](#前台分页跳转到指定页)。

## 最近访问时间显示成负数（如 `-113秒前`）

后台「访客统计 / 最近访问 TOP」或文章过期提示里的相对时间，在访客时区和站长/服务器时区不同时，可能把刚发生的访问显示成 `-113秒前` 这类负值。早先的实现用本地时区去解析时间再相减。当前是按 UTC 时间点计算，并且对过去的事件不会再得到负数（[#369](https://github.com/Mereithhh/vanblog/issues/369)）。

绝对时间仍按你浏览器的本地时区显示，只是「N秒前 / N分钟前」这类相对描述不再跨时区算成未来。

## 总字数比各篇文章编辑器字数加起来大很多

后台看板和前台时间线/分类页的「总字数」早先曾把 Markdown 里的空格、标点、链接等 ASCII 字符逐个计入，中文文章会看起来像按 UTF-8 字节统计（大约三倍）。当前是与编辑器右下角「字数」同一口径：中文按字、英文按词；只加总已发布（未隐藏、未删除）文章，草稿不计入。[#293](https://github.com/Mereithhh/vanblog/issues/293)

编辑或删除文章后，总字数会随字数缓存更新。

## 前台选了白色或自动，刷新还是先黑一下 / 变成夜间模式

早先首屏 HTML 会按服务器时间套上 `dark`，再等 `/initTheme.js` 读 localStorage 后改回来，所以选「白色」刷新会黑约半秒，选「自动」在浅色系统（尤其晚上）也会被强制成黑色。当前行为（来历：[#292](https://github.com/Mereithhh/vanblog/issues/292)、[#25](https://github.com/Mereithhh/vanblog/issues/25)、[#54](https://github.com/Mereithhh/vanblog/issues/54)）：记住的主题在首屏绘制前生效；自动模式跟随系统配色，系统为浅色时不会强制夜间模式。

## 如何更换评论系统通知邮箱

评论通知走内嵌 Waline 的 SMTP，VanBlog 没有另一套邮件系统。后台进入 **站点管理 / 系统设置 / 评论设置**，开启「是否启用邮件通知」，再填：

- **SMTP**（host / 端口 / 用户名 / 密码）：邮箱服务商的发信服务器。自定义域名邮箱填服务商给出的 SMTP，**不是**博客域名。用户名一般是完整邮箱；密码多数是 **授权码 / 应用专用密码**，不是登录密码。
- **博主邮箱（通知收件人）**：有新评论时通知这个地址，可填自定义域名邮箱，也可以和发件地址不同。
- **发件人显示名称 / 发件地址（From）**：收件箱里看到的发件人。自定义域名邮箱填进发件地址；多数服务商要求发件地址与 SMTP 用户名一致。

保存后会重启内嵌 Waline。最简单是 SMTP 用户名、发件地址、博主邮箱都填同一个域名邮箱。逐步说明见 [评论 · 更换通知邮箱](../features/comment.md#更换通知邮箱)，Waline 官方见 [评论通知](https://waline.js.org/guide/features/notification.html)。

## 评论登录跳到 localhost

外层 Nginx 反代后，Waline 评论登录或管理后台 OAuth 可能跳到 `localhost` / `0.0.0.0` 而不是站点域名（[#396](https://github.com/Mereithhh/vanblog/issues/396)）。反代需要转发 `Host`：`proxy_set_header Host $host;`。完整示例见 [反代](../reference/reverse-proxy.md)，说明见 [部署常见问题](./deploy.md#反代后-waline-登录跳到-localhost)。内置 Caddy、没有再套一层反代时一般不用改。

本机反代时若希望 API（`3000`）不监听公网网卡，可设 `VAN_BLOG_SERVER_HOST=127.0.0.1`（[#488](https://github.com/Mereithhh/vanblog/issues/488)），见 [部署常见问题](./deploy.md#如何让-vanblog-只接受本机反代的流量)。

## 后台设置了 Waline 自定义变量但不生效

在「评论设置」里填了 `imageUploader: false`（关掉评论图片上传）或 `IPQPS`（同一 IP 发言频率）后，早先不会把客户端选项传给前台评论组件，数字环境变量也可能没按字符串交给内嵌 Waline。当前行为：这些客户端选项会原样传给前台的评论组件，数字类环境变量也按字符串交给内嵌 Waline，所以 `imageUploader: false` 与 `IPQPS` 填了就生效（来历：[#139](https://github.com/Mereithhh/vanblog/issues/139)）。重新保存一次评论设置（会重启内嵌 Waline）即可。

布尔请写 `false` 而不是 `"false"`。`IPQPS` 的单位是「每分钟请求次数」，默认已经是 `60`，填 `60` 看起来会像没变化。

## 分类管理重命名后文章或草稿还是旧名称

在「站点管理 / 数据管理 / 分类管理」点「重命名」把分类从 `AAA` 改成 `BBB` 后，用过 `AAA` 的文章和草稿可能仍显示旧名称，或看起来像未分类。文章和草稿存的是分类名字符串，早先只改了分类表本身。当前行为（来历：[#324](https://github.com/Mereithhh/vanblog/issues/324)）：重命名会同步更新所有文章和草稿上的分类名。

## 多文件自定义页面上传失败或无法删除文件

在 Windows 上「上传文件 / 上传文件夹」可能直接报错（`ENOENT: no such file or directory, mkdir`），或上传成功后无法从文件树里删掉单个文件。早先的实现创建目录时按 `/` 硬拆路径，Windows 上 `path.join` 得到反斜杠，拆完变成空路径；同时后台没有删除单个文件的接口。当前行为：创建目录时按平台的路径分隔符处理，Windows 上不会再拆出空路径；后台也有删除单个文件的接口（`DELETE /api/admin/customPage/file`），文件树里可以直接删掉某一个文件（来历：[#338](https://github.com/Mereithhh/vanblog/issues/338)）。

## 多文件自定义页面上传后打开是白屏

把静态 zip（例如 [uptime-status](https://github.com/yb/uptime-status)）解压上传到 `/c/uptime/` 后，页面可能空白，控制台里 `/static/js/...` 404。自定义页面会正确返回根目录的 `index.html`，但 **Create React App 默认把资源写成站点根路径** `/static/...`，浏览器不会去 `/c/uptime/static/...` 找。把 `index.html` 里的地址改成 `./static/...`，或构建时设置 `homepage` / `base` 为 `/c/uptime/`。需要 API 或根路径时用反代旁挂，见 [自定义页面](../advanced/custom-page.md)。上传失败或删不掉文件是另一件事，见上一节。

## 水印文字带小数点或域名时不显示

带 `.` 的文字（`example.com` 这类域名）**能正常渲染**：水印文字按 SVG `<text>` 排版，结构上不会折行，点号、连字符与自动加的 `©` 前缀都照画；文字长度会参与字号计算，域名一类较长的「单词」会自动缩小字号，而不是被排到画布外看不见（来历：[#322](https://github.com/Mereithhh/vanblog/issues/322)）。

顺带把当前版本的水印行为说清（渲染在服务端做，任何图床都生效；开关在 **站点管理 / 系统设置 / 图床设置**）：

- 默认样式是 **tile（满图斜排平铺）**：满图重复的小字、旋转 −26°、低不透明度，「看得出有水印但不破坏观感」，而且**裁不掉**。另有 `corner`（角落柔光底板）与 `bar`（底部渐变条），用 `VANBLOG_WATERMARK_STYLE` / `VANBLOG_WATERMARK_POSITION` 切换，全表见 [环境变量 → 可见水印](../reference/env.md#可见水印)。
- **支持中文**：镜像自带 `fontconfig` 与 Latin + 中文字体，「可见水印文字」里直接填中文即可（早先的后台会弹「不支持中文」把中文挡掉，那是旧渲染器的限制）。
- 短边小于 **52px** 的图会跳过水印（服务端记一条 WARN，图片照常上传）；文字太长时字号先自动缩小，缩到 8px 仍放不下也跳过。
- 自建镜像 / 源码部署时若系统没装字体，服务端会**跳过水印并打一条点名安装命令的 WARN**，绝不会盖出满图小方块。⚠️ 真看到满图方块，说明跑的是没装字体的旧镜像，升级即可。

## 文章里写的 HTML 不生效

Markdown 里写了 `<u>下划线</u>`、`<font color="red">` 或 `<center>` 后，前台可能只剩纯文本、没有样式。原因是 ByteMD 默认的 GitHub sanitizer 会丢掉这些标签。当前行为：文章正文会解析 HTML，并保留常见的格式 / 嵌入标签；`<script>`、`onclick` / `onerror` 这类事件属性与 `javascript:` 链接仍会被去掉（来历：[#490](https://github.com/Mereithhh/vanblog/issues/490)）。

整站要插入脚本请用 [定制化](../advanced/customizing.md)，完整页面用 [自定义页面](../advanced/custom-page.md)，不要指望文章正文执行 JS。语法与允许范围见 [编辑器](../faq/usage.md#文章里写的-html-不生效)。

## 前台 Markdown 链接文字或网址显示不完整

文章里写了 `[很长的文字](https://example.com/很长的路径)` 这类链接后，前台首页「阅读全文」前可能露出 `[文字](https://www.` 这样的残缺 markdown，点进去详情页却是完整蓝字链接。没有 `<!-- more -->` 时会自动截取正文开头作为摘要（早先是 50 个字符，现在默认前 200 字），硬截会把 `[文字](网址)` 从中间切开，解析器再把剩下的 `https://www.` 当成自动链接。当前行为（来历：[#410](https://github.com/Mereithhh/vanblog/issues/410)）：截断点落在链接中间时会把这一条链接补全，可见文字和 `href` 都保持完整。链接文字里有反引号、URL 带查询参数或括号时同样适用。

想精确控制摘要长度，用编辑器工具栏插入 `more` 标记即可；不插入也不会被拦下，前台会自动取前 200 字。脚注点击新开一页是另一件事，见下一节。

## 点击脚注会新开一页，滚不到文末

正文用了 `[^1]` / `[^1]: 说明` 这类脚注后，前台点击编号可能新开同一篇文章并停在开头，返回链接也不生效；后台预览里脚注前有分隔线，前台没有。这是页内锚点被当成外链、以及脚注区块标签被过滤导致的，当前行为：脚注编号是**页内**跳转（不会新开同一篇文章），返回链接可用，前台也会渲染脚注上方的分隔线，与后台预览一致（来历：[#290](https://github.com/Mereithhh/vanblog/issues/290)）。目录点击跳不过去是另一件事，见下一节。

## 手机上后台编辑文章工具栏按钮太少

用手机打开后台文章编辑器时，ByteMD 会切到 tab 模式（左侧只剩「编辑 / 预览」），工具栏给出一组常用操作：标题、加粗 / 斜体、链接、图片上传、无序列表、代码、引用；工具栏可以横向滑动，不会把页面撑出横向滚动。⚠️ 表情、Mermaid、自定义高亮块等仍只在电脑端工具栏。来历：[#504](https://github.com/Mereithhh/vanblog/issues/504)。

电脑端分栏预览和完整工具栏不变。长文里目录跳转把工具栏滚走是另一件事（[#298](https://github.com/Mereithhh/vanblog/issues/298)）。

## 手机上看文章时目录只能回到顶部用

手机上文章目录早先只在正文最上方，读到后面再想跳标题只能先滚回去。当前有右侧目录抽屉（[#451](https://github.com/Mereithhh/vanblog/issues/451)）：有标题的文章会在「返回顶部」上方出现目录按钮，点开后从右侧滑出同一份目录，点标题会跳转并关闭抽屉。电脑端右侧目录不变。没有标题的文章不会出现这个按钮。

## 前台标题锚点 hash 无法复制，目录也不能用键盘

文章标题早先整段可点、地址栏 hash 也不编码，中文标题（如 `评论系统`）复制不到 `%E8%AF%84%E8%AE%BA%E7%B3%BB%E7%BB%9F` 这种链接，手动打开也不一定滚到对应标题；侧栏目录是普通 `div`，键盘 Tab / Enter 用不上。当前行为（来历：[#177](https://github.com/Mereithhh/vanblog/issues/177)）：每个标题旁有可复制的 `#` 永久链接，hash 用 `encodeURIComponent` 读写，打开带编码 hash 的地址会滚到该标题；目录项是真正的链接，可用键盘操作。

标题文字本身可以选中复制，不必整段点标题。目录当前项会带 `aria-current="true"`。

## 目录点击标题跳不过去

文章里某个标题后面多了空格（或 `#` 后多空格）时，前台目录点这项不会滚到对应标题。这是目录文案和标题锚点一边去空格、一边保留空格导致的，当前行为：目录文案与标题锚点走同一套规范化，标题里多出来的空格不会再让跳转失效（来历：[#308](https://github.com/Mereithhh/vanblog/issues/308)）。

标题本身没有多余空格时，目录跳转不受影响。截图很多的长文章里，图片还在懒加载时目录点到底部会停住；当前改为等上方图片撑开布局后再跳到标题（[#82](https://github.com/Mereithhh/vanblog/issues/82)）。

## 前台目录比后台编辑器大纲少标题

后台 ByteMD 右侧「目录」能看到的标题，发布后前台文章目录可能少几条，常见是嵌套的二级/三级标题，或行前多了空格的 ATX 标题（CommonMark 仍会渲染成标题）。早先的前台用正则抽目录，会把这类标题丢掉。当前是按正文实际渲染出的 `h1`–`h6` 生成目录（[#409](https://github.com/Mereithhh/vanblog/issues/409)）。

目录能列出来但点了跳不过去，见上一节。标题里的 `$...$` 在目录里显示成源码，见下一节。

## 前台目录里的 TeX 公式未解析

文章标题写成 `## 比较 $A$<$B$` 或 `## 由方程 $F(x,y)=0$ 确定的隐函数 $y=y(x)$` 后，正文里的公式会按 KaTeX 渲染，但前台「目录」可能把 `$...$` 原样显示成未解析的 TeX。当前行为（来历：[#264](https://github.com/Mereithhh/vanblog/issues/264)）：目录的可见文字走与正文相同的 `@bytemd/plugin-math-ssr`。目录条目用来跳转的键仍是未解析的标题原文（`NavItem.text`），不改正文标题锚点。

不含公式的标题、以及嵌套目录完整性（[#409](https://github.com/Mereithhh/vanblog/issues/409)）不受影响。后台编辑器右侧大纲不是同一套组件。

## 后台编辑器点目录后出现一大片空白

在后台编辑文章时，点编辑器右侧「目录」，再点某个标题下面的 Markdown 标题，编辑区可能变成一大片空白，只能刷新页面才能恢复。原因是编辑器大纲在 `scrollIntoView` 预览标题时，连带把 ByteMD / CodeMirror 的外壳一起滚了。当前版本点目录不会再让编辑区变空白（来历：[#370](https://github.com/Mereithhh/vanblog/issues/370)）；万一还遇到，刷新页面即可恢复。

这和前台文章目录不是同一件事；前台少标题或点了跳不过去，见上面两节。

## 自定义页面修改信息后刷新又变回去

在「站点管理 / 自定义页面」里点「修改信息」，接口返回 200，刷新后名称或路径仍是旧的。原因是更新时按**新**路径去查找文档，改路径就写不到原记录。当前版本按原记录更新，改名与改路径刷新后都会保留（来历：[#453](https://github.com/Mereithhh/vanblog/issues/453)）。

## 前台很快，后台却要转很久

后台每次打开都会请求 `/api/admin/meta`。这个接口早先会同步查询远程版本接口（`https://api.mereith.com/vanblog/version`）来提示更新；远程慢或不可达时，后台会被拖住大约 30 秒，前台不受影响。当前版本已修正（来历：[#343](https://github.com/Mereithhh/vanblog/issues/343)）：版本检查改为短超时 + 后台缓存，不再阻塞后台。

## 文章里有 Mermaid 图表时编辑器无法输入或预览报错

含 mermaid 代码块的文章在后台打开后，编辑器可能无法点击或输入，或左侧一改字右侧即时预览就抛异常。流程图里写了 `style A fill:#9fe1e7` 这类十六进制颜色（以及中文节点名）时，还可能弹出 `Yh is not a function or its return value is not iterable`，之后整篇无法再改。当前版本这几类都不会再出现：含 mermaid 的文章可以正常点击与输入，即时预览不再抛异常，十六进制颜色与中文节点名也能正常渲染（来历：[#477](https://github.com/Mereithhh/vanblog/issues/477)、[#424](https://github.com/Mereithhh/vanblog/issues/424)、[#391](https://github.com/Mereithhh/vanblog/issues/391)）。

万一在某篇老文章上仍遇到编辑器卡住，临时办法是用开发者工具挡住预览区，或把窗口缩到只显示编辑区，即可继续改正文。

## 备份恢复后分类为空、首页没有文章

从旧机器后台导出全部数据、在新机器导入后，文章上可能仍显示分类名，但「分类管理」是空的，首页刷新也不出文章。当前版本已修正（来历：[#496](https://github.com/Mereithhh/vanblog/issues/496)、[#280](https://github.com/Mereithhh/vanblog/issues/280)）。重新导入一次备份，导入完成后稍候刷新首页即可。

整机迁移更稳妥的方式仍是复制 Docker 持久化目录，见 [备份与迁移](../guide/backup.md)。

## 后台发布后前台不刷新仍显示旧文章

后台发布或更新文章后，公网首页 / 文章页不刷新、仍显示旧内容；整站迁移后也可能这样。先排除 VanBlog 自己的增量渲染：到 **站点管理 / 系统设置 / 高级设置** 手动触发一次静态页面更新，并确认直连容器映射端口能看到新内容。数字 ID 地址不更新见下一节。

若只有走 Nginx / 宝塔反代（或 Cloudflare 等 CDN）时是旧页，就是外层在缓存 HTML（[#469](https://github.com/Mereithhh/vanblog/issues/469)）。社区方案来自 [RubyXun](https://github.com/RubyXun) / [lateautumn233](https://github.com/lateautumn233)，相关 [#332](https://github.com/Mereithhh/vanblog/issues/332)：

- Nginx `location` 加 `proxy_no_cache 1;` 与 `proxy_cache_bypass 1;`
- 宝塔还可在 `/www/server/nginx/conf/proxy.conf` 把 `proxy_cache cache_one;` 注释掉
- CDN 不要对 HTML 开「缓存全部」，改完后清边缘缓存

源站已对后台和 `/api/admin/*` 发送 no-store，**前台 HTML 仍可能被代理/CDN 缓存**。完整片段见 [部署常见问题](./deploy.md#后台发布后前台不刷新仍显示旧文章) 与 [反代](../reference/reverse-proxy.md#后台发布后前台不刷新仍显示旧文章)。

## 后台改文章后，数字 ID 的前台地址不更新

文章设置了自定义路径时，`/post/自定义路径` 会更新，但 `/post/数字ID`（搜索结果常跳到这里）可能仍是旧内容。原因是按需 ISR 当时只失效了自定义路径那一个页面。当前版本发布 / 更新文章时会把这篇文章的**两个地址一起失效**（`/post/<数字ID>` 与 `/post/<自定义路径>`），改路径时旧地址也会一并处理（来历：[#356](https://github.com/Mereithhh/vanblog/issues/356)）。

临时办法：在「系统设置 / 高级设置」里手动触发静态页面更新。若直连已是新内容、走反代仍是旧页，见 [上一节](#后台发布后前台不刷新仍显示旧文章)。

## 后台编辑器填写信息时方向键无法移动光标

在编辑器右上角「操作 → 修改信息」里填写标题等字段时，方向键可以正常移动光标（来历：[#390](https://github.com/Mereithhh/vanblog/issues/390)、[#470](https://github.com/Mereithhh/vanblog/issues/470)）。

## 后台编辑器填写信息时无法使用退格键

在编辑器右上角「操作 → 修改信息」里填写标题等字段时，退格键与 Delete 都能正常删字（来历：[#233](https://github.com/Mereithhh/vanblog/issues/233)）。方向键移动光标见上一节。

## 后台编辑器主题颜色错乱

这是因为设置了浏览器主题颜色导致的，把浏览器主题颜色偏好设置成默认或者跟随切换就好了。

## 隔天打开草稿变成空白，但上传的图片还在

后台打开草稿或文章时，如果 URL 里的 `id` 缺失或不是数字，早先会把它 `Number()` 成 `NaN` 再去查 MongoDB，触发 `Cast to Number failed for value "NaN"`，编辑器拿不到正文就显示空白。图片在图床里，所以还能看到。当前版本已修正（来历：[#427](https://github.com/Mereithhh/vanblog/issues/427)）：非法 ID 会直接报错，不会再拿 `NaN` 去更新文档。

若正文其实还在数据库里，从草稿列表重新点「编辑」进入即可。

## 文章编辑器内容不对题

这是浏览器内实时缓存导致的，编辑器会实时保存内容到浏览器的 LocalStorage，这个标识符是以 文章 ID 为准的，如果你重装过或者迁移过，那么原来的文章 ID 和现在文章 ID 对应的内容是不同的，就会导致这个问题。

解决办法很简单：在后台编辑器右上角的下拉菜单中手动点击清理该篇文章的缓存即可。

## 图片（作者 logo）加载不出来

这类「图片加载不出来」多半是**没把图片所在的域名告诉前台**。前台用 next/image 优化远程图片，而 next/image 只优化**白名单里的主机名**，白名单来自环境变量 `VAN_BLOG_ALLOW_DOMAINS`：

- 留空（默认）＝只优化本站图片；此时作者 logo、网站 logo 若填的是**别的域名**上的绝对地址，就会加载失败。
- 用 `xyz.com` 访问、图片也在 `xyz.com` 上：设 `VAN_BLOG_ALLOW_DOMAINS: 'xyz.com'`；用 `localhost` 访问就填 `localhost`。
- 多个域名用英文逗号分隔，**只写主机名**（不写 `https://`、端口、路径），不支持通配符。
- 改完要**重建容器**才生效（前台在构建期读它），见 [环境变量](../reference/env.md#运行时核心)。

⚠️ 它只管「用 next/image 优化的远程图」；本站图床 `/static/img/...` 的图不走这条白名单。

## 按一次回车为什么不换行

后台文章编辑器默认跟标准 Markdown / CommonMark 一致：单独按 Enter 仍是同一段，要在行末加两个空格（或再空一行）才会软换行。这是为了和前台渲染、从标准 Markdown 迁过来的文章对齐。

如果写长文或粘贴多行时不想手打空格，打开编辑器右上角 **操作 → 偏好设置**，把「软换行」设为开启。之后按 Enter 或粘贴多行正文会自动补两个空格，源码仍是标准软换行，预览和前台行为一致。默认关闭；已发布的文章不会在打开或保存时被整篇改写。设置存在当前浏览器的 LocalStorage 里。见 [编辑器 · 偏好设置](../features/editor.md#偏好设置) 与 [#311](https://github.com/Mereithhh/vanblog/issues/311)。

## 在编辑器复制后格式错乱

默认粘贴的格式可能带有一些额外信息，你可以鼠标右键选择复制为纯文本，或者使用快捷键 <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd>。

![粘贴示例](https://pic.mereith.com/img/88b29bad4ad0ef7d6e411e43f80ec1bc.clipboard-2022-08-22.png)

## 开启了 https 自动重定向但仍走 http

后台打开「HTTPS 自动重定向」后，直接输入域名（不写 `https://`）仍是 http，手动加 `https://` 却能打开。早先的实现用 Caddy Admin API `POST` 往 `listener_wrappers` 上追加：wrappers 已存在时会把整段数组再套一层，开启成功日志还误写成「已关闭」。当前是用 `PATCH` / `PUT` **整段替换**成 `http_redirect`，写入后再读回确认；关闭则删除 wrappers（没有这项时的 404 视为已关）（[#150](https://github.com/Mereithhh/vanblog/issues/150)）。

开启后请用无痕窗口访问 `http://你的域名`，应跳到 `https://`。也可在后台点「查看 Caddy 配置」，`srv1` 下应有 `"listener_wrappers": [{"wrapper":"http_redirect"}]`。用外层 Nginx 反代 80 端口时请保持关闭，见 [反代](../reference/reverse-proxy.md)。关不掉时见下一节。

## 开启了 https 重定向后关不掉

开启「HTTPS 自动重定向」后，http 和用 IP 访问都会被跳到 https，证书对不上时站点会打不开。后台此时也进不去，需要在服务器上重置。

如果你是用一键脚本安装的，先更新到最新脚本，再选菜单 **9. 重置 https 设置**（或 `./vanblog.sh reset_https`）。新脚本会：

1. 清掉本机 Caddy 配置里的 `http_redirect` / 强制跳转；
2. 删除数据库 `settings` 里的 https 记录，避免重启后又自动打开跳转；
3. 调用 Caddy API 关掉正在生效的重定向，并重启 vanblog。

成功或失败都会打印明确提示。成功后请用 `http://IP` 或 `http://域名` 访问；浏览器若仍跳 https，清一下缓存。

```bash
curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh && ./vanblog.sh reset_https
```

如果你是自己用 docker 部署的，在 vanblog 容器里执行（无 TTY 也可，会用默认 MongoDB 地址）：

```bash
docker exec -i <vanblog容器名> node /app/cli/resetHttps.js
docker compose restart vanblog
```

当前的 `resetHttps.js` 会**同时**删数据库记录并关掉 Caddy 的强制跳转，执行完就能恢复 HTTP / IP 访问（早先的版本只删记录、不关跳转，必须重启容器才生效）。

## 卸载后脚本备份文件被删掉了

当前脚本的「卸载」（菜单 **8**）只删除安装数据（`data/`）与编排文件，**不会**删除 `vanblog-backup-*` 备份，也不会动安装目录以外的任何文件；删除前会列出将要保留的备份并要求确认。卸载完成后备份仍在 `/var/vanblog/vanblog-backup-*`（若安装目录里只剩备份，目录本身也会保留）—— 请尽快把它拷到别处再重装。

⚠️ 如果手上的脚本是 2026-09 之前下载的，先用菜单 **20. 更新此脚本** 换成新版再卸载：早先的脚本会 `rm -rf /var/vanblog`，而备份正好写在这个目录里，卸载会把刚做好的备份一起删掉（来历：[#408](https://github.com/Mereithhh/vanblog/issues/408)）。

```bash
curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh && ./vanblog.sh uninstall
```

