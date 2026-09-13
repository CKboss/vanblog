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
| `NPM_REGISTRY` | `https://registry.npmmirror.com` | 传给 `VAN_BLOG_NPM_REGISTRY` |
| `ALPINE_MIRROR` | `https://mirrors.aliyun.com/alpine` | 传给 `VAN_BLOG_ALPINE_MIRROR`，`none` 用官方源 |
| `NODE_DIST_URL` | `https://cdn.npmmirror.com/binaries/node` | node-gyp 的 Node 头文件源，`none` 用默认 |
| `SHARP_DIST_HOST` | `https://registry.npmmirror.com/-/binary` | sharp / libvips 预编译包源，`none` 用官方 GitHub |

构建参数和 CI（`.github/workflows/publish-ghcr.yml`）保持一致 —— 本地构建如果和 CI 参数不同，
"本地测过了"就毫无意义。

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
   ⚠️ 公共加速站拉**大 blob**（`node:20` 350MB、`mongo:7.0` 500MB）时可能传到一半就静默卡死
   —— 进度行不动、不报错、也不超时。遇到就多换几个站重试，或先单独 `pull` 再构建。

1. **Alpine 软件源**：官方 `dl-cdn.alpinelinux.org` 实测经常 8-10 秒才回一个索引，
   构建看起来"卡死"在 `apk add`。`VAN_BLOG_ALPINE_MIRROR` 换成 aliyun/tuna 即可
   （一键脚本会自动实测延迟后选最快的）。

1. **sharp 与 node-gyp 的下载**：sharp 默认从 `github.com` 下预编译包（国内直接 aborted），
   node-gyp 在 musl 下默认去 `unofficial-builds.nodejs.org`。两个都能换成 npmmirror
   （`SHARP_DIST_HOST` / `NODE_DIST_URL`），npmmirror 连 **musl 版**的 sharp 预编译包都有。
   ⚠️ sharp 只认**环境变量**：写 `.npmrc`（全局或项目级）都没用，pnpm 8 不会把自定义键
   转成 `npm_config_*` 传给 install 脚本，所以 Dockerfile 里是用 `ENV` 传的。

## 冒烟测试查什么

起一套临时 mongo + vanblog（测完自动拆，`SMOKE_KEEP=1` 可保留），然后：

- 逐个打关键路径：`/`、`/api/public/meta`、`/admin`、`/robots.txt`、`/sitemap.xml`、
  `/rss/feed.xml`、`/post/1`、`/timeline`。200/301/302/308/404 都算"链路通"
  （404 说明 caddy → server/前台这条链路是活的，比连接被拒强）。
- **扫容器日志里历史上真炸过的特征**：`Cannot find module`（缺依赖）、
  `caddy process exited` / `loading initial config`（caddy 配置加载失败）、
  `Reached heap limit`（构建/运行期内存不足）、`ERR_INVALID_URL`（空的 server 地址）、
  `Failed to collect page data`、`unhandledRejection`、`降级使用`
  （entrypoint 走了 caddy 降级模板 = 主配置没加载成功）。
- 容器状态：`RestartCount` 必须是 0、健康检查状态、`State.Running`。
- **优雅停机耗时**：`docker stop -t 20` 之后计时，明显小于宽限期才说明 SIGTERM 被正确转发；
  接近 20 秒说明信号没转发、进程是被硬杀的（正在写的备份/导出会被截断）。
- mongo 版本调一键脚本的 `pick_mongo_image()` 拿，和真实安装走同一条逻辑。

## 更进一步：真起一个站，导入整站备份

冒烟测试用的是空库。要验证"恢复出来的站点是不是真的能用"，可以起一套带数据的栈：

```bash
# 1) 起 mongo + vanblog（挂载数据目录、映射一个空闲端口）
podman network create vb-net
podman run -d --name vb-mongo --network vb-net -p 27117:27017 \
  -v /tmp/vb/mongo:/data/db mongo:7.0

# 2) 把整站备份放进容器能看到的备份目录（<数据目录>/log/vanblog-backups）
mkdir -p /tmp/vb/log/vanblog-backups && cp vanblog-full-*.tar.zst /tmp/vb/log/vanblog-backups/

podman run -d --name vb-app --network vb-net -p 18080:80 \
  -e TZ=Asia/Shanghai -e EMAIL= \
  -e VAN_BLOG_DATABASE_URL="mongodb://<mongo容器IP>:27017/vanBlog?authSource=admin" \
  -v /tmp/vb/static:/app/static -v /tmp/vb/log:/var/log \
  -v /tmp/vb/caddy/config:/root/.config/caddy -v /tmp/vb/caddy/data:/root/.local/share/caddy \
  vanblog:local-test

# 3) 首次初始化（建个临时管理员）→ 登录拿 token → 调恢复接口
curl -X POST http://127.0.0.1:18080/api/admin/init -H 'Content-Type: application/json' -d '{...}'
curl -X POST http://127.0.0.1:18080/api/admin/backup/full/restore -H "token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"vanblog-full-<时间戳>.tar.zst","confirm":"true","withStatic":"true"}'
```

踩过的坑（都会让你以为镜像坏了，其实是环境问题）：

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| server 报 `getaddrinfo EAI_AGAIN vb-mongo` | rootless podman 没装 `aardvark-dns`，**容器名解析不了** | 用 mongo 容器的 IP，或 `--add-host vb-mongo:<IP>` |
| 前台整站 502，`/admin` 与 `/api` 正常 | Next 13 standalone 用 `HOSTNAME` 决定监听地址，容器里那是容器 ID | server 已显式传 `HOSTNAME=0.0.0.0`；自己起 Next 时也要设 |
| 恢复后调 `/api/admin/**` 全是 401 | JWT 密钥是**启动时**读的，恢复把 `settings` 换成了备份里的 | 重启一次容器让密钥对齐（用户侧只需重新登录） |
| `/robots.txt` 404 但 `/sitemap.xml` 200 | caddy 模板有 `srv0(:443)` 和 `srv1(:80)` **两套路由**，只补了一套 | 两个 server 的路由必须一致（有测试守着） |
| `/sitemap.xml` 刚恢复完 404，一两分钟后 200 | 恢复后才开始生成 | 验证脚本要给足重试，别当故障 |
| `podman build` 被打断后仍报"构建成功" | 被 SIGTERM 打断的 `podman build` **退出码是 0** | 构建后必须再 `image exists` 复核（脚本已做） |

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

本地验证通过后，正式发布走 CI：Actions → `publish-ghcr` → **Run workflow**（选分支），
它会构建并推 `latest` / `dev-dsh` / `dev-dsh-<短sha>` 三个 tag。
服务器上用 `./vanblog.sh update` 拉新镜像（**先把镜像准备好，再停容器**，停机只有重启那几秒）。

::: tip ghcr 包默认是私有的

第一次发布后要去仓库的 package 页面（`https://github.com/<owner>/<repo>/pkgs/container/vanblog`）→
Package settings → Change visibility 改成 **Public**，否则别人 `docker pull` 会 `denied`。
⚠️ 这个 URL 在 Markdown 里**不要用尖括号自动链接**包起来：里面还有 `<owner>/<repo>` 占位，
vue 编译器会把 `<owner>` 当成没闭合的标签，整个文档站构建直接失败
（`[vite:vue] Element is missing end tag`）。

:::
