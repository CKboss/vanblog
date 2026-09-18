---
title: 开发指南
icon: signs-post
order: 7
---

::: info 提示

欢迎提交 issue 和 PR：issue 请开在 [CKboss/vanblog](https://github.com/CKboss/vanblog/issues/new)，
PR 提到 `dev/dsh` 分支。合并与打发版 tag 由维护者完成。

:::

本项目使用了 `JavaScript` 和 `TypeScript` 实现。

如果你想参与 VanBlog 开发，可以进群哦：

- [VanBlog 开发群](https://jq.qq.com/?_wv=1027&k=mf2CguM8)

## 准备知识

### 整体架构

Vanblog 分为以下几个部分，构建后将整合到一个 `docker` 容器内：

> website: Vanblog 默认的主题，使用了 `nextjs` 框架，有运行时。
>
> server: Vanblog 的后端服务，有运行时。
>
> waline: Vanblog 内嵌的评论服务，有运行时。
>
> admin: Vanblog 后台面板，打包后为静态页面，无运行时。
>
> caddy: 作为对外的网关，按照规则反代上述几个服务，并提供全自动的 https。

### 进程依赖和启动关系

打包后，启动关系如图：

![架构图](./assets/vanblog.svg)

### 路径结构

本项目采用了 `pnpm` 作为包管理器，项目使用 `monorepo(pnpm workspace)` 组织和管理。

精简版目录结构：

```bash
├── docker-compose  # docker-compose 编排
├── Dockerfile  # Dockerfile
├── docs # 项目文档的代码
├── entrypoint.sh # 容器入口文件
├── LICENSE # 开源协议
├── package.json
├── packages # 代码主体
|  ├── admin # 后台前端代码
|  ├── server # 后端代码
|  ├── waline # 内嵌 waline 评论系统
|  └── website # 前台前端代码
├── README.md
└── pnpm-workspace.yaml # pnpm workspace 文件
```

### 技术栈

只列出大体上框架级别的，一些细节就直接看代码吧。

- 前台： [next.js](https://nextjs.org/)、[react.js](https://reactjs.org/)、[tailwind-css](https://tailwindcss.com/)
- 后台： [ant design pro](https://pro.ant.design/zh-CN/)、[ant design](https://ant.design/)
- 后端： [nest.js](https://nestjs.com/)、[mongoDB](https://www.mongodb.com/)
- CI： [docker](https://www.docker.com/)、[nginx](https://www.nginx.com/)、[github-actions](https://docs.github.com/cn/actions)
- 文档： [vuepress](https://vuejs.press/zh/)、[vuepress-theme-hope](https://theme-hope.vuejs.press/zh/)

## 本地开发

### 环境准备

#### 准备数据库

开发之前，要有一个 `mongodb` 数据库。推荐用 `docker` 起一个：

```bash
docker run --name mongodb-vanblog -d --restart unless-stopped \
  -p 27017:27017 mongo
```

#### node 要求

- Node **24**（CI 用的就是 24；低版本会在 `@nestjs/cli` 与 Next 14 上出问题）
- pnpm **8.11.0**（`package.json` 的 `packageManager` 钉的就是这个版本，corepack 会自动用对）

不想自己装工具链的话，仓库自带一条命令，会把 Node 24 + pnpm 8 + MongoDB 7 下载到 `.tools/`：

```bash
./dev-env.sh bootstrap
```

#### 克隆项目并安装依赖

```bash
git clone https://github.com/CKboss/vanblog.git
cd vanblog
pnpm i
```

### 添加 server 配置文件

在 `packages/server` 下，创建 `config.yaml` 文件，内容如下：

```yaml
database:
  # 数据库连接
  url: mongodb://localhost:27017/vanBlog?authSource=admin
static:
  # 图床等静态文件保存的位置
  path: /var/vanblog-dev/static
# 是否开启演示站模式，会限制很多权限
demo: 'false'
# waline 用的表名，会自动创建
waline:
  db: waline
# 日志位置
log: /var/vanblog-dev/logs
```

### 开发相关命令

#### 开发全部

在根目录下：

```bash
# 开发全部（前台、后台、server）
pnpm dev
# 前台为 3001 端口
# server 为 3000 端口
# 后台为 3002 端口
```

::: info 开发后台要用剪贴板功能时

可能需要开启 `https`：把 `packages/admin/config/config.js` 里的 `https` 改成 `true`，再重启开发进程。

```js
 devServer: { https: true, port: 3002 },
```

:::

#### 单独开发前后台（前端）

必须要先启动 server：

```bash
# 端口 3000
pnpm dev:server
```

然后在启动前台后者后台

```bash
# 启动前台 端口 3001
pnpm dev:website
# 启动后台 端口 3002
pnpm dev:admin
```

### 文档开发

根目录下：

```bash
pnpm docs:dev
```

端口号为: `8080`

## 镜像构建

直接在根目录用 `Dockerfile` 打包就行，具体看下面第二点。

### act（本地跑 GitHub Actions）

我一般会用 [act](https://github.com/nektos/act) 来做验证镜像，act 可以在本地运行 `Github Actions`。

这个方法需要 `.env` 文件存放密钥，目前仅自用。

```bash
pnpm build:test
```

### 手动打包

根目录 `Dockerfile` 的**每一个阶段都是 `node:24-alpine`**（admin_builder / server_builder / website_builder / waline_builder / runner）。前台阶段会设置 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`，让 `sharp`（`^0.35`）走 npm 的 optionalDependencies 拿 musl 预编译包（`@img/sharp-linuxmusl-x64` + `@img/sharp-libvips-linuxmusl-x64`），因此**不需要**在镜像里装 `vips-dev` / `fftw-dev` 从源码编（那是 200 多个 apk 包，构建会慢很多）。⚠️ sharp 必须 `>= 0.33`：更早的版本带一个会在 Alpine 上崩的安装脚本（musl 版本号形如 `1.2.4_git*`，不是合法 semver）。corepack 用仓库钉的 `pnpm@8.11.0`，不要改成 `pnpm@latest`；依赖一律走 `pnpm-lock.yaml` + `--frozen-lockfile`。这几条都有守卫看着：`bash scripts/tests/dockerfile-alpine-sharp.test.sh`。

图床 AVIF 压缩（后台「压缩格式」）优先 `require('sharp')`，并会依次尝试几个候选路径（含镜像里前台 standalone 的 `/app/website/node_modules/sharp`）；sharp 不可用时回退到 `avifenc`（runner 里的 `libavif-apps`）。**不要去掉 runner 的 `libavif-apps` 或 `libwebp-tools`** —— WebP 那条路仍然要 `cwebp`。runner 还装了 `fontconfig ttf-dejavu wqy-zenhei`：可见水印的文字是 SVG 经 librsvg/pango/fontconfig 栅格化的，要的是系统字体，缺字体会退化成「跳过水印 + WARN」。

推荐用仓库自带的脚本构建（构建完还会自动跑一遍冒烟测试）：

```bash
# 构建 + 冒烟测试（起一套临时 mongo + vanblog，打完关键路径再拆掉）
./scripts/build-image-local.sh
# 只构建 / 只测已有镜像 / 只构建某一层（迭代时快得多）
./scripts/build-image-local.sh --build-only
./scripts/build-image-local.sh --smoke-only
./scripts/build-image-local.sh --stage admin_builder
```

想直接用 docker/podman 也行（`VAN_BLOG_BUILD_SERVER` 是构建期前台预渲染要回调的 server 地址，不写就得等容器起来后增量渲染）：

```bash
VAN_BLOG_BUILD_SERVER="https://some.vanblog-server.com"
docker build --build-arg VAN_BLOG_BUILD_SERVER=$VAN_BLOG_BUILD_SERVER -t vanblog:local-test .
```

## 文档

文档站在 `docs/`（VuePress 2 + vuepress-theme-hope）。改完文档**必须**本地构建一次，再跑两条守卫：

```bash
cd docs && pnpm run docs:build        # 约 20 秒；构建失败就是写坏了（裸尖括号占位符是最常见的原因）
bash scripts/tests/docs-links.test.sh        # 死链：相对链接、#锚点、@include 片段、站内图片
bash scripts/tests/docs-consistency.test.sh  # 一致性：文档写的每个 VANBLOG_* 变量代码里都真的读、默认值与脚本一致等
```

⚠️ `docs/changelog.md` 是**生成物**（由根目录的 `CHANGELOG.md` 拷过来），不要手改：

```bash
pnpm release-doc     # 把根 CHANGELOG.md 同步成 docs/changelog.md，并 bump doc-version（维护者用）
```

## Release

发版靠 **`v*` tag**，推上去会自动触发两条流水线：

| 流水线 | 做什么 |
| --- | --- |
| `release-fork.yml` | 建 GitHub Release：发布说明取 `CHANGELOG.md` 里**与 tag 同名**的那一节（找不到才退回 `[Unreleased]`），附件是 `vanblog.sh` 与 `docker-compose-template.yml` |
| `publish-ghcr.yml` | 构建镜像并推到 `ghcr.io/ckboss/vanblog`：发版 tag 会同时更新 `latest` 与该 tag（只发 linux/amd64） |

所以发版前要先把 `CHANGELOG.md` 的 `[Unreleased]` 切成 `## [vX.Y.Z] - 日期`，否则 Release 说明会是空的。
版本号用 [standard-version](https://github.com/conventional-changelog/standard-version) 按 Conventional Commits 生成：

```bash
# 仅维护者使用：生成 CHANGELOG + 打 v* tag（tag 要自己 git push 上去才会触发流水线）
pnpm release
```

⚠️ 请不要自行执行 `pnpm release` 或推送 `v*` tag —— 那是真的发版：会公开建 Release 并推镜像。

镜像标签的含义：

| 标签 | 含义 |
| --- | --- |
| `v2026.9.2` 这类发布号 | 对应 tag 的发版构建，**钉版本 / 回滚用这个** |
| `latest` | 最近一次发版构建（与最新发布号同一个 digest） |
| `dev-dsh` | `dev/dsh` 分支的**手动**构建（分支推送不会自动构建，所以它可能落后于发布版） |
| `dev-dsh-<短sha>` | 某一次手动构建，按提交号回滚用 |
