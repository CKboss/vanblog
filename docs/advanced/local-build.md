---
title: 本地构建与验证镜像
icon: docker
order: 8
---

# 本地构建与验证镜像

改到 `Dockerfile`、`entrypoint.sh`、`scripts/start.js`、`caddyTemplate.json` 这类
**只有镜像里才会暴露**的东西时，别只跑单元测试：缺依赖、caddy 配置加载失败、构建 OOM、
Node 版本不匹配这些问题，在本地测试里全是绿的，只有真把镜像构建出来跑一遍才会现形。

<!-- more -->

## 快速开始

```bash
./scripts/build-image-local.sh                       # 构建 + 冒烟测试（默认）
./scripts/build-image-local.sh --build-only          # 只构建
./scripts/build-image-local.sh --smoke-only          # 只测已有镜像
./scripts/build-image-local.sh --stage admin_builder # 只构建某一层（迭代时快得多，层缓存照样留着）
./scripts/build-image-local.sh --lowmem              # admin 用 1536MB 堆（小内存机器）
./scripts/build-image-local.sh --help
```

可用环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ENGINE` | 自动探测 | `docker` 或 `podman`。探测看的是 `docker info`（有命令不等于 daemon 连得上） |
| `IMAGE_TAG` | `vanblog:local-test` | 构建出来的镜像 tag |
| `SMOKE_HTTP_PORT` | `18080` | 冒烟测试映射的宿主机端口（避开正在跑的站点） |
| `SMOKE_KEEP` | `0` | 设 `1` 则测完不拆容器，方便进去排查 |
| `VANBLOG_MONGO_IMAGE` | `mongo:7.0` | 冒烟测试用哪个 mongo 镜像。⚠️ 不是 `MONGO_IMAGE` —— 那个名字是脚本**内部算出来的**（调一键脚本的 `pick_mongo_image()`：优先沿用编排文件里的 tag，否则用 `VANBLOG_MONGO_IMAGE`），你在环境里设 `MONGO_IMAGE` 会被无条件覆盖掉 |
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | 传给 `VAN_BLOG_NPM_REGISTRY` |
| `ALPINE_MIRROR` | `https://mirrors.aliyun.com/alpine` | 传给 `VAN_BLOG_ALPINE_MIRROR`，`none` 用官方源 |
| `NODE_DIST_URL` | `https://cdn.npmmirror.com/binaries/node` | node-gyp 的 Node 头文件源，`none` 用默认 |
| `SHARP_DIST_HOST` | `https://registry.npmmirror.com/-/binary` | sharp / libvips 预编译包源，`none` 用官方 GitHub |

构建参数和 CI（`.github/workflows/publish-ghcr.yml`）保持一致 —— 本地构建如果和 CI 参数不同，
"本地测过了"就毫无意义。

**怎么算成功**：一次完整的构建 + 冒烟，最后应该看到这两行（缺任何一行都别当成功）：

```
镜像构建成功：vanblog:local-test          ← 脚本还会再 `image exists` 复核一次
冒烟测试全部通过：vanblog:local-test
```

⚠️ 被 `Ctrl-C` 打断的 `podman build` **退出码是 0**、日志停在半截却看着像成功，所以脚本在构建后
一定会再查一次镜像是否真的存在；你自己手动构建时也要这样复核。产物约 890MB
（v2026.9.2 起镜像里装了 `fontconfig ttf-dejavu wqy-zenhei` 三个字体包，占约 32MB —— 可见水印靠它）。

## 没有 docker 权限？用 podman（免 sudo）

很多机器上 docker daemon 在跑，但当前用户不在 `docker` 组里（组甚至是空的），
于是 `docker` 命令一律 `permission denied /var/run/docker.sock`。两种解法：

```bash
# A. 一次性加入 docker 组，然后重新登录
sudo usermod -aG docker $USER

# B. 直接用 podman（rootless，不需要 sudo、不需要加组）
ENGINE=podman ./scripts/build-image-local.sh
```

rootless podman 需要 `/etc/subuid` 里有你的用户（发行版一般已经配好）。
本仓库的 `Dockerfile` 没有用任何 BuildKit 专属语法（没有 `# syntax=`、没有 `--mount=type=cache`），
所以 podman 能直接构建。

## 国内网络

三个地方会卡：

1. **拉基础镜像**：`docker.io` 直连经常超时。podman 配 `~/.config/containers/registries.conf`：

   ```toml
   unqualified-search-registries = ["docker.io"]

   [[registry]]
   prefix = "docker.io"
   location = "<你的加速地址>"
   ```

   docker 则配 `/etc/docker/daemon.json` 的 `registry-mirrors`。
   ⚠️ 公共加速站拉**大 blob**时可能传到一半就静默卡死（进度行不动、不报错、也不超时）。
   本仓库五个 stage 的基础镜像全是 `node:24-alpine`（本地解包后约 **170 MB**），冒烟测试还要拉
   `mongo:7.0`（本地解包后约 **870 MB**）；下载的压缩 blob 比这两个数小，但都是几百 MB 量级。
   遇到就多换几个站重试，或先单独 `pull` 再构建。

1. **Alpine 软件源**：官方 `dl-cdn.alpinelinux.org` 实测经常 8-10 秒才回一个索引，
   构建看起来"卡死"在 `apk add`。`VAN_BLOG_ALPINE_MIRROR` 换成 aliyun/tuna 即可
   （一键脚本会自动实测延迟后选最快的）。

1. **sharp 与 node-gyp 的下载**：sharp 默认从 `github.com` 下预编译包（国内直接 aborted），
   node-gyp 在 musl 下默认去 `unofficial-builds.nodejs.org`。两个都能换成 npmmirror
   （`SHARP_DIST_HOST` / `NODE_DIST_URL`），npmmirror 连 **musl 版**的 sharp 预编译包都有。
   ⚠️ sharp 只认**环境变量**：写 `.npmrc`（全局或项目级）都没用，pnpm 8 不会把自定义键
   转成 `npm_config_*` 传给 install 脚本，所以 Dockerfile 里是用 `ENV` 传的。

## 冒烟测试查什么

起一套临时 mongo + vanblog（专用网络 + 容器 IP + `--add-host`，mongo 数据放**命名卷**；
测完自动拆，`SMOKE_KEEP=1` 可保留），然后：

- 逐个打关键路径：`/`、`/api/public/meta`、`/admin`、`/robots.txt`、`/sitemap.xml`、
  `/rss/feed.xml`、`/post/1`、`/timeline`。200/301/302/308/404 都算"链路通"
  （404 说明 caddy → server/前台这条链路是活的，比连接被拒强）。
- **扫容器日志里历史上真炸过的特征**：`Cannot find module`（缺依赖）、
  `caddy process exited` / `loading initial config`（caddy 配置加载失败）、
  `Reached heap limit`（构建/运行期内存不足）、`ERR_INVALID_URL`（空的 server 地址）、
  `Failed to collect page data`、`unhandledRejection`、`降级使用`
  （entrypoint 走了 caddy 降级模板 = 主配置没加载成功）。
- 容器状态：`RestartCount` 必须是 0、健康检查状态、`State.Running`。
- **优雅停机耗时**：`docker stop -t 20`（podman 同）之后计时，明显小于宽限期才说明 SIGTERM
  被正确转发；接近 20 秒说明信号没转发、进程是被硬杀的（正在写的备份/导出会被截断）。
- mongo 版本调一键脚本的 `pick_mongo_image()` 拿，和真实安装走同一条逻辑。

## 更进一步：真起一个站，导入整站备份

冒烟测试用的是空库。要验证"恢复出来的站点是不是真的能用"，**别手搓 curl**，直接用仓库里的
恢复演练（它就是干这个的，而且会逐项断言语义、结束自动拆）：

```bash
# --keep：演练完把这套一次性栈留着，方便自己点进去看；--http-port 指定宿主机端口
./vanblog.sh drill vanblog-full-<时间戳>.tar.zst --image vanblog:local-test --http-port 18080 --keep
```

它会起一套**一次性**的 mongo + vanblog（命名卷、专用网络、`--add-host` 直连容器 IP），
等 `/api/public/health`，然后把归档上传到 `POST /api/admin/init/restore`（用户真正会走的那条路），
再断言恢复出来的站点与归档清单对得上。结束时打印 `RESULT: PASS pass=… warn=… fail=…`，
`--keep` 时还会把"怎么访问、怎么拆"一并打印出来。

⚠️ **手搓 curl 会踩的一个坑**：`POST /api/admin/init` 与 `/api/admin/init/restore` 现在
**默认要求「初始化密钥」**（防止别人抢先初始化你的新站）。不带 `setupKey` 字段会得到 400，
而错误信息很容易被误读成"归档坏了"。密钥在容器里的 `/var/log/setup.key`（0600），
也会打印在容器日志里（标签是「初始化密钥：」，未初始化期间每 10 分钟重印）：

```bash
podman exec <容器名> cat /var/log/setup.key      # 或：podman logs <容器名> | grep 初始化密钥
```

`vanblog.sh drill` 已经自动做了这一步（先读文件、读不到再从日志兜底，并且密钥不进命令行、不写台账）。
细节见 [初始化](../guide/init.md)。

如果只是想让站点**跳过**这道保护（例如临时调试），在容器的 `environment:` 里把它显式关掉即可
（开关名与取值见 [环境变量 → 安装与初始化](../reference/env.md#安装与初始化)）—— 公网环境不要这么干。

手搓栈时踩过的坑（都会让你以为镜像坏了，其实是环境问题）：

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| server 报 `getaddrinfo EAI_AGAIN vb-mongo` | rootless podman 没装 `aardvark-dns`，**容器名解析不了** | 用 mongo 容器的 IP，或 `--add-host vb-mongo:<IP>` |
| 前台整站 502，`/admin` 与 `/api` 正常 | Next 13/14 standalone 用 `HOSTNAME` 决定监听地址，容器里那是容器 ID | server 已显式传 `HOSTNAME=0.0.0.0`；自己起 Next 时也要设 |
| 恢复后调 `/api/admin/**` 全是 401 | JWT 密钥是**启动时**读的，恢复把 `settings` 换成了备份里的 | 重启一次容器让密钥对齐（用户侧只需重新登录） |
| `/robots.txt` 404 但 `/sitemap.xml` 200 | caddy 模板有 `srv0(:443)` 和 `srv1(:80)` **两套路由**，只补了一套 | 两个 server 的路由必须一致（有测试守着） |
| `/sitemap.xml` 刚恢复完 404，一两分钟后 200 | 恢复后才开始生成 | 验证脚本要给足重试，别当故障 |
| `podman build` 被打断后仍报"构建成功" | 被 SIGTERM 打断的 `podman build` **退出码是 0** | 构建后必须再 `image exists` 复核（脚本已做） |
| `podman run` 报 `unknown flag: --link` | `--link` 是 docker 专有的旧式互联，podman 4.9 不认（构建成功、冒烟第一步就 die） | 专用网络 + 容器 IP + `--add-host`（冒烟脚本与 `drill` 都是这么做的） |
| 跑完 `/tmp` 里留下删不掉的目录（要 sudo 才清得掉） | mongo 在容器里是 root，rootless 引擎把它映射成宿主机上一个谁也不是的 uid | mongo 数据用**命名卷**（引擎自己回收），别 bind mount 到宿主机临时目录 |
| 手搓 curl 打初始化/恢复接口得到 400 | 这两条匿名接口**默认要求「初始化密钥」**（这道保护默认开启） | 带上 `setupKey` 字段（值取容器内 `/var/log/setup.key`，或日志里「初始化密钥：」那行）；`drill` 已自动处理 |

## 完全不能构建镜像时的替代办法

按 `Dockerfile` 里某一层的**目录结构和命令**在 `/tmp` 复刻一遍。例如验 `admin_builder`：

```bash
rm -rf /tmp/absim && mkdir -p /tmp/absim/packages
cp package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json /tmp/absim/
cp -r patches /tmp/absim/ && cp -r packages/admin /tmp/absim/packages/
cd /tmp/absim && pnpm install --frozen-lockfile     # 与镜像里完全相同的命令
cd packages/admin && pnpm run build                 # EXIT=0 才算过
```

这招抓到过 `cytoscape` 版本漂移（独立安装解析出比 lockfile 更新的版本，
mermaid 要的 `./dist/cytoscape.umd.js` 没被导出）—— 那种问题只有真的装一遍才会出现。

## 发布

本地验证通过后，正式发布走 CI（`.github/workflows/publish-ghcr.yml` + `release-fork.yml`）。
**推分支不会构建镜像** —— workflow 里的 `branches:` 段是注释掉的，只有下面两条路会真的构建：

| 怎么做 | 会推出哪些镜像标签 | 还会发生什么 |
| --- | --- | --- |
| 推一个 `v*` 标签（例如 `v2026.9.2`） | `latest` + 该标签本身 | `release-fork.yml` 建 GitHub Release（发布说明取 `CHANGELOG.md` 里 `## [同名标签]` 那一节，附件带 `vanblog.sh` 与 compose 模板） |
| Actions → `publish-ghcr` → **Run workflow**（选分支） | `latest` / `dev-dsh` / `dev-dsh-<短sha>` | 没有 Release |

⚠️ 两个容易踩的点：

- 打 `v*` 标签前，先在 `CHANGELOG.md` 里把 `[Unreleased]` 切成 `## [v2026.9.2] - <日期>` 这样的一节。
  找不到同名小节时 workflow 会**退回用 `[Unreleased]` 的正文**，再找不到就只给自动生成的提交列表 ——
  发布说明因此可能不是你想要的那份，而且它不会报错。
- 只构建 **linux/amd64**（默认值）。要 arm64 得在手动触发时把 `platforms` 填成
  `linux/amd64,linux/arm64`，走 QEMU 模拟，慢好几倍且容易超时。

服务器上怎么拉新镜像见 [升级](../guide/update.md)（要点是**先把新镜像准备好、再停旧容器**，
停机只有重启那几秒）。

::: tip ghcr 包的可见性

本项目的 package 现在是 **Public**（实测：匿名取 token 后拉 `v2026.9.2` 的 manifest 返回 200，
`tags/list` 也能读到），所以谁都能 `docker pull`。如果哪天被改回 private，别人拉镜像会报 `denied`；
改回来的地方是 `https://github.com/CKboss/vanblog/pkgs/container/vanblog` →
Package settings → Danger Zone → Change visibility。

⚠️ 顺带记一条写文档的坑（真的炸过）：这类 URL 如果带 `<owner>/<repo>` 占位符，
**不要用尖括号自动链接**（`<https://…/<owner>/…>`）包起来 —— vue 编译器会把 `<owner>`
当成没闭合的标签，整个文档站构建直接失败（`[vite:vue] Element is missing end tag`）。
占位符要么放进反引号，要么就写具体地址。`scripts/tests/docs-consistency.test.sh`
里有一条守卫专门扫这个（它会跳过代码块与行内代码，只查正文里的裸尖括号）。

:::
