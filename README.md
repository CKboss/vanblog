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
> 在上游 master `ccd708ce`（v0.54.0+）之上增加了 10 项功能，并做了性能优化与安全加固。
> 下面这段是本分支的内容，**其余部分（含文档站、演示站、打赏与捐赠名单）均归原作者所有**。
> 想直接看本分支加了什么，跳到 [本分支新增内容](#本分支新增内容)。

## 本分支新增内容

### 功能

| 功能 | 说明 | 文档 |
| --- | --- | --- |
| **拼音文章路径** | 新建文章按标题自动生成 `/post/<pinyin-slug>`，重名自动 `-2`/`-3`；历史文章可在后台一键回填；`/post/<数字 id>` 永远可用，改标题不会改别名（已分享的链接不失效） | [文章](docs/features/article.md) |
| **标题可选中 + 一键复制** | 列表页/文章页/关于页的标题可复制标题与文章链接，导航栏站点名同样可复制 | [AGENTS.md §7.2](AGENTS.md) |
| **自动摘要** | 没写 `<!-- more -->` 时自动取正文前 200 字，不会切断链接和 emoji；草稿发布也不再因为没有 more 标记而报错 | [编辑器](docs/features/editor.md) |
| **附件管理** | 上传任意文件生成 URL（按内容去重），html/svg/js 等类型强制下载 + `nosniff`，可搜索引用、批量导出 | [附件](docs/features/attachment.md) |
| **图片管线** | 长边 1920 自动缩放、300px 缩略图、**隐写水印**（抗压缩/转码，可检测）、原地替换图片而 URL 不变、小图/大图/列表三种视图、批量引用查询；移除了「全部删除」按钮 | [图床](docs/features/image-storage.md) |
| **整站备份 / 恢复** | 一个高压缩归档（zstd → xz → gzip 自动选择）打包**全部集合 + 评论库 + 图床/附件/自定义页面**；支持不解压查看清单、鉴权下载、上传恢复（逐集合原子替换 + 重建索引） | [备份](docs/advanced/backup.md) |
| **单篇导出 `.md` / `.mdz`** | `.md` 是原样正文；`.mdz` 是 Typora 风格带图包（相对链接 + `<标题>.assets/`）；外链图片自动抓取，抓不到会保留原链接并生成说明清单；文章/草稿/编辑器未保存内容/关于页都能导 | [备份](docs/advanced/backup.md) |
| **Apple 风格前台皮肤** | 后台「站点信息 → 界面风格」一键切换（默认开启）：纯 CSS、每条规则都带 `[data-ui="apple"]` 作用域，不影响自定义 CSS；深浅色都有令牌可调 | [配置](docs/features/config.md) |
| **Markdown 一致性** | 编辑器预览与前台渲染对齐：front matter 不再被渲染成正文、两边共用同一份 sanitize 白名单（代码块复制按钮/行号在预览里也生效）、未知容器标题回落一致 | [Markdown](docs/features/markdown.md) |
| **内置评论系统** | 不再必须外挂 Waline：评论存在本站 Mongo，走本站接口，前台是自研组件（两层回复、分页、基础 Markdown、博主标识、深色模式），后台是原生管理页（审核/编辑/删除/按状态与关键词筛选）。可选 `内置 / Waline / 关闭`，老站点升级默认保持 Waline；支持**从 Waline 导出文件一键导入**（默认只导正式显示的、按 objectId 幂等、保留原始时间与点赞），以及**只导出已通过评论**的接口。整站备份自动包含评论（动态枚举集合）。安全上比正文更严：原始 HTML 不解析、白名单不含 `img`/`iframe`/`style`、链接强制 `nofollow noopener`、蜜罐 + 同 IP 限流 + 关键词转待审、公开接口不返回邮箱/IP/UA | [评论系统](docs/features/comment.md) |
| **补齐 6 种 markdown 语法** | `==高亮==`、`X^2^` / `H~2~O`、`:smile:` 短代码、定义列表、GitHub 提示块 `> [!NOTE]`、`[[toc]]` 文内目录；编辑器与前台用**同一套插件**（按 bytemd 的 unified 10 世代选版本），不会再出现预览与发布不一致。注意：单个 `~x~` 现在是下标，删除线要写 `~~x~~` | [Markdown](docs/features/markdown.md) |

### 性能

| 目标 | 结果 |
| --- | --- |
| 前台首屏 JS（`next build` First Load） | 首页 432 → **286 kB**，文章页 427 → **281 kB**，友链页 418 → **172 kB**；KaTeX / mermaid / TOC 数学全部按需加载 |
| 前台图片与静态资源 | 正文图片 `lazy` + `decoding=async`、封面 `fetchpriority=high`；图床图片改为 `max-age=3600, stale-while-revalidate=604800`（此前是 `max-age=0`，每次翻页都重新请求） |
| 后台 `dist` | 27 MB → **24 MB**；`umi.js` 1133 → **1077 KB**；编辑器路由首包 ~1748 → **~911 KB**；mermaid 从 3 份产物减到 1 份 |
| 一键脚本 | `backup` 支持 `--consistent`（先停 MongoDB）、`restore` 会校验压缩包完整性并自动删掉 `mongod.lock`；常规操作不再 `down -v`（那会删卷） |
| 第二轮 | 不存在的文章/页码返回**真 404**（原来是 200 软 404，还会污染 ISR 缓存）；后端故障不再被当成「文章不存在」；文章封面 `preload`；第三方统计改 `lazyOnload`；标签 `C++`、分类 `a&b`、搜索 `C#` 不再因为查询串没编码而查错；改站点信息不再无条件重启前台（环境变量没变就跳过） |

细节见 [前台性能](docs/advanced/performance.md)。

### 安全

做过一轮四路并行审计（认证与权限 / 文件与上传 / 注入与数据暴露 / 功能正确性），并做了第二轮清理。修复内容包括：

- 公开接口的 Mongo 操作符注入、搜索接口的正则注入与 500、图床上传任意文件导致的同源存储型 XSS、导出接口的重定向 SSRF；
- 加密文章经由搜索 / RSS / 解锁接口的三处泄露，解锁接口现在限次（同 IP + 同文章 10 分钟 20 次）；
- 导出归档匿名可下载、登录限流可被伪造头绕过、演示站下的管线 RCE、备份恢复的半恢复与进程崩溃；
- 流水线执行加了超时与 `error`/`exit` 监听（以前脚本不返回就会**永久卡住保存文章**）、依赖安装不再用 `spawnSync` 阻塞事件循环；
- 访问量计数改成原子 `$inc`（并发下不再互相覆盖、永久少算）、`getNewId()` 的锁改成 `try/finally`（一次查询失败不会让所有新建请求空转到重启）；
- 图片链接解析不再把 alt 文本 / 代码块里的示例当成真图片（以前会误报「失效图片」并往库里插垃圾记录）；
- `/swagger` 可用 `VANBLOG_SWAGGER=false` 关闭，`/api/revalidate` 支持共享密钥与路径校验。

约束、可调开关与**已知未修项**都写在 [安全与加固](docs/advanced/security.md)。

### 本地开发（不需要 docker，也不需要 sudo）

```bash
./dev-env.sh bootstrap   # 下载 Node 20 + pnpm 8 + MongoDB 7 到 .tools/，并建好本地骨架
./dev-env.sh install     # 装依赖（--frozen-lockfile，不改 lockfile）
./dev-env.sh start       # MongoDB:27017 + server:3000 + website:3001 + admin:3002 一起起
./dev-env.sh status      # 状态；另有 logs / stop / restart / db
```

工具链、数据库、数据目录、日志全部在仓库内（`.tools/`、`vanblog_dev/`，已本地忽略），整套环境可以随目录搬走，也不会污染系统。

**[AGENTS.md](AGENTS.md)** 是给人和 AI 编码代理看的运行手册：环境搭建、日常操作、跑测试、故障排查速查表、以及本分支每一项改动的**根因和踩过的坑**（改代码前请先读它）。

### 测试

| 套件 | 命令 | 现状 |
| --- | --- | --- |
| server（jest） | `cd packages/server && ./node_modules/.bin/jest` | 530 用例（1 个既有用例需联网拉字体，离线必失败） |
| website（vitest） | `cd packages/website && ./node_modules/.bin/vitest run` | 51 文件 / 462 用例 |
| admin（node:test） | `cd packages/admin && node --test tests/unit/*.test.js` | 65 文件 / 248 用例 |
| 部署脚本（bash） | `for t in scripts/tests/*.test.sh; do bash "$t"; done` | 7 文件 / 259 条断言 |

三套测试都要用 `.tools/node20`（系统 Node ≥ 23 会因为 `util.isObject` 被移除而崩）。

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
里面**没有**本 fork 的任何改动。本分支没有发布 Docker 镜像，所以这里的脚本改成：
**克隆 `CKboss/vanblog` 的 `dev/dsh` → 本地 `docker build` → 用本地 tag 起容器**。
首次构建大约 5–20 分钟（多阶段：admin / server / website 各自 `pnpm i` + build），
之后 `./vanblog.sh update` 会拉最新源码重新构建；构建失败不会动正在跑的容器。

:::

可用的环境变量（都有默认值，直接跑就行）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VANBLOG_REPO` | `https://github.com/CKboss/vanblog.git` | 源码仓库 |
| `VANBLOG_BRANCH` | `dev/dsh` | 分支 |
| `VANBLOG_SRC_DIR` | `/var/vanblog/src` | 源码目录（构建缓存，可反复更新） |
| `VANBLOG_IMAGE_TAG` | `vanblog:dev-dsh` | 本地构建出的镜像 tag |
| `VANBLOG_USE_UPSTREAM_IMAGE` | `false` | 设 `true` 就回到官方镜像（不含本分支改动） |
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
