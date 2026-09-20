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
# ⚠️ tsconfig.dev.json 是**本机专用、没有入库**；CI 检查的是入库的那两份：
(cd packages/server  && ./node_modules/.bin/tsc -p tsconfig.json      --noEmit)   # 含 227 个 spec 与 test/
(cd packages/server  && ./node_modules/.bin/tsc -p tsconfig.build.json --noEmit)   # 镜像里 nest build 的真实形状
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

⚠️ 这一节在 2026-09-20 重写过了。旧版写的是「CI 只跑 6 套 shell 守卫、不跑任何类型检查，`docs/**` 不触发 CI」——
那时是真的，现在是假的：**27 个守卫全部进了 CI**，类型检查与真实构建也进了，文档改动有了自己的 workflow。

现在有六个 workflow：

| workflow | 什么时候跑 | 跑什么 |
| --- | --- | --- |
| `server-test` | push / pull_request 到 `master`、`dev/dsh`，且改动落在代码路径里（`packages/**`、`scripts/**`、`Dockerfile`、`entrypoint.sh`、两份 caddy 模板、`docker-compose/**`、`pnpm-lock.yaml`、`package.json`、`patches/**`） | 三个**并行** job，见下 |
| `admin-e2e` | 触发条件与 `server-test` 完全一样 | 后台单元测试 → 装 playwright chromium → `playwright test --list` 先做一次便宜的配置自检 → mermaid e2e → 失败时把报告与 trace 当 artifact 上传 |
| `docs-test` | push / pull_request 到 `dev/dsh`，且改动落在 `docs/**`、`README.md`、`scripts/vanblog.sh` | 三个文档守卫（`docs-links`、`docs-consistency`、`reverse-proxy-host-header`，合计约 2 秒、无依赖）+ `docs:build` |
| `nightly` | 每天定时（`30 19 * * *`）+ 手动 `workflow_dispatch` | 真 `caddy validate`、真镜像构建 + 冒烟、`docs:build`、以及一个 `if: always()` 的汇总 job |
| `publish-ghcr` / `release-fork` | 打 `v*` 标签或手动触发 | 发镜像 / 发 Release |

`server-test` 的三个 job 是**并行**的，所以 PR 的墙钟时间没变（仍由那个 20–30 分钟的主 job 决定）：

| job | 内容 |
| --- | --- |
| `server-test` | **两份 tsconfig 的类型检查**（`tsconfig.json` 覆盖 473 个文件、含 227 个 spec 与 `test/`；`tsconfig.build.json` 覆盖 245 个、零 spec，是镜像里 `nest build` 的真实形状）→ website 类型检查 → **真实的 `nest build`** → 两套需要依赖或 `dist` 的守卫（备份加密/口令/密钥轮换、`vanblog.sh restore`）→ 三个包的单元测试 → **10 套要真 mongod 的 e2e** |
| `guards-core` | **23 个**不需要依赖、容器引擎或 caddy 二进制的守卫（约 114 秒守卫时间、整个 job 约 2.6 分钟）：文档两条、caddy 两条、Dockerfile 两条、镜像运行时、`start.js`、`build-image-local` 静态契约、基准工具、脚本加固、生成的 compose、`install-cron`、`reset`、`verify`、`backup-restore`、灾难恢复/离线安装、waline reset、`update`、`https reset`、`uninstall`、`download fallback`、反代 Host 头 |
| `guards-slow` | 2 个较慢的：恢复演练逻辑（620 条断言；**真起容器那部分默认不跑**，要显式打开活体开关并提供一份真归档与镜像，见 `scripts/tests/vanblog-drill.test.sh` 里 `LIVE` 那一段）、源码安装路径（用假的 git/docker/compose，不联网不碰守护进程） |

⇒ 27 个守卫 = `guards-core` 的 23 + `guards-slow` 的 2 + 主 job 里那 2 个需要依赖的。
两个 job 都会先确保 `zstd` 存在：`vanblog-verify` 没有它会**硬失败**（实测 `passed=0 failed=1`），
而 `vanblog-restore` 与备份加密那套在缺依赖或缺 `dist` 时会**静默少跑断言** —— 后者因此被放在已经装依赖并构建过的
job 里，并且断言 `note=0`，让"退化"算失败而不是算通过。

⚠️ 三条如实写明的残余风险：

1. **nightly 红了要靠有人订阅通知**。汇总 job 会把结果写进 step summary 与 artifact、并把整个 run 标红，
   GitHub 也会给 watcher 发邮件，但**仓库没有 CI 侧的主动告警**（`VANBLOG_BACKUP_ALERT_WEBHOOK` 是产品功能，
   与 CI 无关）。`cancel-in-progress: false` 是有意的：下一次定时开始时取消一个 40 分钟的构建，
   等于它永远跑不完、也永远不报告。
2. **nightly 也覆盖不到两件事**：恢复演练的**真容器**部分、以及「加密归档到底能不能被恢复」——
   两者都需要一份真实的整站归档，那是站点数据，不能放进仓库。别因为"有 nightly"就以为这两条被守住了。
3. **admin 的类型检查故意没进 CI**：它现在有 115 个错，一个常年红着的检查会训练所有人忽略红色，
   那比没有检查更糟。要加得先清完。

⚠️ 两个会绊人的坑（都是本轮真踩到的）：

- **`packages/server/tsconfig.dev.json` 没有入库**（本机专用，用来绕开家目录里的 `@types/bun`，
  已在 `.git/info/exclude` 里），所以 CI 不能用它 —— 上面那两份才是提交进仓库的配置。
- **不要用伞形 `--strict` 评估「离严格模式还有多远」**：tsconfig 里显式写的 `false` 会**压过**命令行的
  `--strict`，实测 `tsc --strict` 只报 **6** 个错，而逐项显式打开开关是约 **380** 个 —— 差 60 多倍。
  照着 6 这个数字做计划会严重低估工作量。

📌 加类型检查当天就抓到一个**一直在的错误**：`test/backup-restore.e2e-spec.ts` 用 12 个参数构造
`BackupController`，而本轮给它加了第 13 个（密钥轮换要的 `JwtService`）—— 两个单元 spec 当时改了，这个 e2e 漏了。
它一直没被发现，是因为本地类型检查用的是 `tsconfig.dev.json`（继承 build 配置，因此**不含 `test/`**），
而 CI 当时什么都不查；运行时也不崩（缺的那个参数是 `undefined`，只有轮换路径会读它），ts-jest 也不报诊断。


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
