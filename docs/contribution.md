---
title: 开发指南
icon: signs-post
order: 7
---

::: info 提示

欢迎提交 issue 和 PR：issue 请看 [CKboss/vanblog 的 issue 页](https://github.com/CKboss/vanblog/issues)
（⚠️ 仓库的 issue 功能目前是关闭的，`/issues/new` 会 404 —— 在那之前提问走
[VanBlog 开发群](https://jq.qq.com/?_wv=1027&k=mf2CguM8)），PR 提到 `dev/dsh` 分支。
合并与打发版 tag 由维护者完成。

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
├── docker-compose  # docker-compose 编排模板
├── Dockerfile  # 五阶段构建，全部基于 node:24-alpine
├── docs # 项目文档的代码（vuepress）
├── entrypoint.sh # 容器入口文件
├── LICENSE # 开源协议
├── package.json
├── packages # 代码主体
|  ├── admin # 后台前端代码（umi 3 + antd 4 + React 17）
|  ├── cli # 命令行工具
|  ├── server # 后端代码（NestJS 10 + mongoose 8）
|  ├── waline # 内嵌 waline 评论系统
|  └── website # 前台前端代码（Next 14 + React 18）
├── patches # pnpm 补丁（构建时必须进上下文）
├── scripts # 部署与运维脚本（vanblog.sh、vanblog-drill.sh、build-image-local.sh、benchmark/、tests/）
├── dev-env.sh # 本机开发环境一键脚本（不需要 docker，也不需要 sudo）
├── AGENTS.md # 工程运行手册：环境、测试、排错速查、每一项改动的根因与踩过的坑
├── README.md
└── pnpm-workspace.yaml # pnpm workspace 文件
```

### 技术栈

只列出大体上框架级别的，一些细节就直接看代码吧。

- 前台： [next.js](https://nextjs.org/)（14，pages router）、[react.js](https://reactjs.org/)（18）、[tailwind-css](https://tailwindcss.com/)
- 后台： [ant design pro](https://pro.ant.design/zh-CN/)、[ant design](https://ant.design/)（umi 3 + antd 4 + React 17）
- 后端： [nest.js](https://nestjs.com/)（10）、[mongoDB](https://www.mongodb.com/)（mongoose 8）
- CI / 发布： [github-actions](https://docs.github.com/cn/actions)（`server-test` 跑 shell 守卫 + 三个包的单元测试 + 10 套要真 mongod 的 e2e、`admin-e2e` 跑后台单元测试 + playwright、
  `publish-ghcr` 用 docker buildx 构建并推镜像、`release-fork` 建 Release）；本机验证镜像用
  [podman](https://podman.io/) 或 docker 跑 `scripts/build-image-local.sh`
- 文档： [vuepress](https://vuejs.press/zh/)、[vuepress-theme-hope](https://theme-hope.vuejs.press/zh/)

## 本地开发

### 环境准备

#### 推荐：一条命令把工具链准备好（不需要 docker，也不需要 sudo）

```bash
./dev-env.sh bootstrap   # 下载 Node 24 + pnpm 8 + MongoDB 7 到 .tools/，并建好本地目录骨架
./dev-env.sh install     # 装依赖
./dev-env.sh start       # mongod:27017 + server:3000 + website:3001 + admin:3002 一起起
./dev-env.sh status      # 状态；另有 logs [server|website|admin|mongod] / stop / restart / db
```

工具链、数据库、数据目录、日志全部落在仓库内（`.tools/`、`vanblog_dev/`，已在 `.git/info/exclude` 里），
整套环境可以随目录搬走，不污染系统。`bootstrap` 还会顺手写好 `packages/server/config.yaml`
（内容见下面「添加 server 配置文件」）与前台出图要用的软链。

#### 或者自己准备数据库

要有一个 `mongodb` 数据库，版本用 **7.0**（与生产镜像一致）：

```bash
docker run --name mongodb-vanblog -d --restart unless-stopped \
  -p 27017:27017 mongo:7.0
```

⚠️ 不要写不带 tag 的 `mongo`（等于 `latest`）：本项目对 mongo 的大版本敏感 ——
`featureCompatibilityVersion` 只能沿升级链走，用高版本 mongod 打开过低版本的数据目录之后，
再想换回低版本就得手动降 FCV。生产侧同样钉 `mongo:7.0`（老 CPU 不支持 avx 时用 `mongo:4.4.16`）。

#### node 要求

- Node **24**（CI 用的就是 24；低版本会在 `@nestjs/cli` 与 Next 14 上出问题）
- pnpm **8.11.0**（`package.json` 的 `packageManager` 钉的就是这个版本，corepack 会自动用对）

#### 克隆项目并安装依赖

```bash
git clone https://github.com/CKboss/vanblog.git
cd vanblog
pnpm i
```

### 添加 server 配置文件

跑过 `./dev-env.sh bootstrap` 的话这一步已经自动做好了。手动开发的话，在 `packages/server` 下创建
`config.yaml`（⚠️ 这个文件在 `.gitignore` 里，不会进版本库；路径按你自己的机器改，
下面用的是仓库内目录，好处是不需要 root）：

```yaml
database:
  # 数据库连接
  url: mongodb://localhost:27017/vanBlog?authSource=admin
static:
  # 图床等静态文件保存的位置
  path: /path/to/vanblog/vanblog_dev/static
# 是否开启演示站模式，会限制很多权限
demo: 'false'
# waline 用的表名，会自动创建
waline:
  db: waline
# 日志位置
log: /path/to/vanblog/vanblog_dev/logs
# 流水线脚本与 picgo 插件的工作目录（缺了这两项，流水线与插件安装会没有落脚的地方）
codeRunner:
  path: /path/to/vanblog/vanblog_dev/codeRunner
pluginRunner:
  path: /path/to/vanblog/vanblog_dev/pluginRunner
```

环境变量优先于这个文件；映射规则（`database.url` → `VAN_BLOG_DATABASE_URL`）与全量清单见
[环境变量](./reference/env.md)。

### 开发相关命令

#### 开发全部

四个进程一起起（mongod + server + 前台 + 后台），用仓库自带的脚本：

```bash
./dev-env.sh start
```

端口：server `3000`、前台 `3001`、后台 `3002`、mongod `27017`（只监听 127.0.0.1）。

⚠️ 根目录的 `pnpm dev` **只起 server 与后台**（`--filter @vanblog/server --filter @vanblog/admin`），
既不起前台也不起数据库 —— 想四个都要就用上面的 `./dev-env.sh start`，或者按下面分别起。

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

## 测试

改完代码**必须**跑对应的那一套；跨包改动（例如同时动了 server 与文档）全都跑一遍。
命令与最新基线数字在 [README 的测试表](../README.md#测试)，这里只说怎么跑与两个坑：

```bash
cd packages/server  && ./node_modules/.bin/jest                 # server 单元测试（约 1 分钟）
cd packages/server  && ./node_modules/.bin/jest src/utils/watermark.spec.ts   # 只跑一个文件
cd packages/website && ./node_modules/.bin/vitest run           # 前台（⚠️ pnpm test 是 watch 模式，脚本里要用 run）
cd packages/admin   && node --test --test-reporter=tap tests/unit/*.test.js   # 后台
for t in scripts/tests/*.test.sh; do bash "$t"; done            # 部署脚本与文档守卫（约 3 分钟）
(cd packages/server  && ./node_modules/.bin/tsc -p tsconfig.dev.json --noEmit)   # 类型检查，两条都要 0 错
(cd packages/website && ./node_modules/.bin/tsc --noEmit -p tsconfig.json)
```

⚠️ 两个反复踩的坑：

- **Node 24 换了 `node --test` 的默认 reporter**：不加 `--test-reporter=tap` 就没有 `# pass / # fail` 汇总行，
  看上去像"什么都没跑"。
- **admin 那套里有读 server 源码的跨包锚点**（`tests/unit/fullBackup.test.js`、`securityHardening.test.js` 等）：
  只改了 server 也会让它变红。所以"我只动了后端"不是跳过 admin 测试的理由。

要真库的 e2e 在 `packages/server/test/` 下，各有独立的 `pnpm test:*-e2e` 命令，并且都带硬护栏
（拒绝指向 27017 那个开发库、拒绝真实库名），要跑得先按文件头注释起一个一次性的 mongod。
`admin` 的 playwright e2e 需要先装浏览器，且默认的 3002 端口与开发栈冲突（本地跑要把 7 个 `*_E2E_PORT` 都改开）。

### CI 会跑什么、什么时候跑

两个测试 workflow（`.github/workflows/server-test.yml`、`admin-e2e.yml`）的触发条件**完全一样**：
push 或 pull_request 到 `master` / `dev/dsh`，**且**改动落在这些路径里 ——
`packages/**`、`scripts/**`、`Dockerfile`、`entrypoint.sh`、`caddyTemplate.json`、
`caddyFallbackTemplate.json`、`docker-compose/**`、`pnpm-lock.yaml`、`package.json`、`patches/**`。

⚠️ **`docs/**` 不在这个清单里**：只改文档的提交**不会触发任何 CI**。所以两条文档守卫必须本地跑
（`bash scripts/tests/docs-links.test.sh` 与 `bash scripts/tests/docs-consistency.test.sh`），
CI 不会替你兜底。

| workflow | 跑什么 |
| --- | --- |
| `server-test` | 6 套 shell 守卫（`dockerfile-alpine-sharp`、`vanblog-update`、`vanblog-reset-https`、`vanblog-uninstall`、`vanblog-download-fallback`、`reverse-proxy-host-header`）→ 三个包的单元测试（server jest、website vitest、admin `node --test`）→ **10 套要真 mongod 的 e2e**（backup-restore、post-ISR、admin-meta、force-login-comment、waline-extra-options、CDN-URL、word-count、friend-link、page-copy、admin-cache-control） |
| `admin-e2e` | 后台单元测试 → 装 playwright chromium → `playwright test --list` 先做一次便宜的配置自检 → mermaid e2e → 失败时把 playwright 报告与 trace 当 artifact 上传 |

两边都用 **Node 24** 与 `pnpm install --frozen-lockfile`，所以"本机过了 CI 没过"通常是 Node 版本或
lockfile 没提交导致的。剩下的 shell 守卫（`scripts/tests/` 下共 24 个文件）CI **只跑上面那 6 个**，
其余要本地 `for t in scripts/tests/*.test.sh; do bash "$t"; done` 全跑一遍。

## 镜像构建

直接在根目录用 `Dockerfile` 打包就行，具体看下面第二点。

### act（本地跑 GitHub Actions）

维护者会用 [act](https://github.com/nektos/act) 在本地跑 GitHub Actions 来验证镜像构建。
它需要一个 `.env` 文件存放密钥（`GITHUB_TOKEN` 之类），**属于自用工具，仓库里没有对应的 npm script，
也没有把 `.env` 的格式写进文档** —— 具体调用方式看 act 自己的 README。

⚠️ 旧文档这里写的是 `pnpm build:test`，但根 `package.json` 里**没有这个 script**（照着敲只会得到
`Command "build:test" not found`）。想在本地验证镜像，用下面「手动打包」那条就够了：它构建完还会自动
跑一遍冒烟测试，不需要 act，也不需要任何密钥。

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
VAN_BLOG_BUILD_SERVER="https://your-server.example.com"
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
| `latest` | 最近一次**发布构建**；⚠️ 但手动触发 `publish-ghcr` 也会推 `latest`（它的 enable 条件同时包含 `refs/heads/dev/dsh`），所以手动构建过一次之后，`latest` 就不再等于最新发布号了 —— 要可复现请用发布号 |
| `dev-dsh` | `dev/dsh` 分支的**手动**构建（分支推送不会自动构建，所以它可能落后于发布版） |
| `dev-dsh-<短sha>` | 某一次手动构建，按提交号回滚用 |
