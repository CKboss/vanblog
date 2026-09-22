::: warning 先选镜像标签（新手照抄第一行就行）

本项目的镜像发布在 **`ghcr.io/ckboss/vanblog`**。

**新手直接照抄这一行**（固定发布号，内容永不变，出问题好回滚）：

```
ghcr.io/ckboss/vanblog:v2026.9.2
```

标签怎么选（从上往下越来越"新"，也越来越不好复现）：

| 标签 | 它是什么 | 什么时候用 |
| --- | --- | --- |
| `v2026.9.3` | **固定发布号**，内容永不变（⚠️ 这不是"最新版"的权威出处 —— 最新发布号请看 [Releases 页面](https://github.com/CKboss/vanblog/releases)） | ✅ 推荐给新手：稳定、可复现，回滚就是换回旧标签 |
| `latest` | 最近一次**发布构建**（一键脚本的默认值） | 想自动跟上新发版又不想记版本号。⚠️ 有人在 Actions 里手动触发构建时它也会跟着走 |
| `dev-dsh` | 分支的上一次**手动**构建 | 明确想跟开发进度。⚠️ **可能落后于发布版**（写这段时它停在 4 天前的构建） |
| `dev-dsh-<短sha>` | 某一次构建对应的那个提交 | 回滚 / 钉死某一次构建 |

**三件容易踩的事**（新手最常卡在这里）：

1. 镜像**不是每次 push 都重建**（一次构建要 20–40 分钟 runner 时间，而多数提交只是文档改动）：
   只有推 `v*` 标签，或去仓库 **Actions → publish-ghcr → Run workflow** 手动触发时才会构建。
   所以 `dev-dsh` 对应的是"最后一次手动构建时的代码"，**不一定等于分支最新提交，还可能比发布版旧**。
2. 想要"装的就是我看到的这一版"，就**钉发布号**（`v2026.9.2`）而不是用 `latest`：
   `latest` 会被下一次发版或手动构建推走，出问题时你说不清自己跑的到底是哪一版。
   用一键脚本时加 `VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:v2026.9.2` 即可钉住
   （命令见[「脚本」那一种部署方式](./get-started.md#部署方式)与 [升级](./update.md)）。
3. 只发布了 **linux/amd64**。arm64 机器（部分 NAS、树莓派、Apple 芯片上的集群）要么自己构建
   （下面第 3 种方式），要么请维护者手动触发 workflow 时把架构填成 `linux/amd64,linux/arm64`
   （走 QEMU 模拟，慢好几倍）。

拿到镜像有三种方式：

1. **一键脚本（最省事，新手推荐）**：默认拉 `ghcr.io/ckboss/vanblog:latest`（最近一次发布构建，
   小机器也装得动），拉不到时自动退回「克隆源码 + 本地构建」。

   ```bash
   curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh \
     && chmod +x vanblog.sh && ./vanblog.sh
   ```

   这几行**在你的服务器上敲**（不是你自己的电脑），要 root；跑完会出一个中文菜单，按提示选数字就行。
   想钉住某个发布版而不是跟着 `latest` 走，就先
   `export VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:v2026.9.2` 再跑它。
   装完之后怎么升级见 [升级](./update.md)。

2. **直接拉镜像**，把编排文件里的 `image:` 换掉即可（不需要构建，1C1G 也能跑）：

   ```bash
   docker pull ghcr.io/ckboss/vanblog:v2026.9.2
   ```

   成功的样子：最后打印 `Status: Downloaded newer image for …`（已经拉过则是 `Image is up to date`），
   再用 `docker images | grep vanblog` 能看到它，大小约 890MB。

   **报 `denied` 或 `not found`？** 本项目的 ghcr package **是 public**（可以匿名 `docker pull`，
   实测取 manifest 返回 200），正常情况下不会碰到。真的报错通常是这三种：标签名打错（区分大小写，
   发布号长这样 `v2026.9.2`）、服务器连不上 ghcr（换网络，或把地址换成你信得过的镜像加速地址），
   或者 package 被改回了 private —— 那就去
   `https://github.com/CKboss/vanblog/pkgs/container/vanblog` → Package settings → Danger Zone →
   Change visibility → Public。拉不到镜像时，一键脚本会自动退回源码构建。

3. **自己构建镜像**，然后把编排文件里的 `image:` 换成本地 tag：

   ```bash
   git clone --depth 1 -b dev/dsh https://github.com/CKboss/vanblog.git
   cd vanblog
   # 可选的构建参数（全表见「参考 → 环境变量」的"镜像构建期"一节）：
   #   VAN_BLOG_VERSIONS             版本号标签（后台「关于」与页脚显示），如 dev/dsh@1a2b3c4
   #   VAN_BLOG_BUILD_SERVER         构建期的 server 地址，**必须是个合法 URL**（默认 http://127.0.0.1:3000）
   #   VAN_BLOG_NPM_REGISTRY         pnpm 源（默认 https://registry.npmmirror.com；海外机器可换 npmjs）
   #   VAN_BLOG_ADMIN_BUILD_SCRIPT   admin 构建档位：build（堆 4096MB）或 build:lowmem（1536MB，小内存机器用）
   #   VAN_BLOG_ALPINE_MIRROR        Alpine 软件源（留空=官方 dl-cdn；国内建议 https://mirrors.aliyun.com/alpine，
   #                                 否则构建会卡在 apk add 那一步十几分钟）
   docker build \
     --build-arg VAN_BLOG_VERSIONS=dev/dsh \
     --build-arg VAN_BLOG_ADMIN_BUILD_SCRIPT=build \
     -t vanblog:dev-dsh .

   # ⚠️ MongoDB 的版本不能随手换：数据目录与 featureCompatibilityVersion 绑定，
   #    4.4 的数据目录换成 mongo:7.0 会让 mongod 直接拒绝启动（看起来像数据全丢）。
   #    要升级走「整站备份 → 新 tag 起空库 → 恢复」，或 5.0→6.0→7.0 阶梯升级并逐级 setFCV。
   #    本项目按 mongo:7.0 实测，不要用 mongo:latest（8.x）。
   #    老机器 CPU 不支持 avx 的话，5.0+ 起不来，只能用 mongo:4.4.16。

   # 内存小于 6GB 的机器建议**串行**构建（一次只跑一个重活），否则四个 builder 并发会 OOM：
   for stage in admin_builder server_builder website_builder waline_builder; do
     docker build --target "$stage" . || break
   done
   docker build -t vanblog:dev-dsh .   # 前面几步都命中缓存，这一步只组装最终镜像
   ```

   构建要 20–40 分钟，产物约 **890MB**（v2026.9.2 起镜像里装了系统字体
   `fontconfig ttf-dejavu wqy-zenhei`，可见水印——含中文——才真的能用；这三个包占约 32MB）。
   想边构建边跑冒烟测试、把坑一次踩完，见 [本地构建与验证镜像](../advanced/local-build.md)。

:::

### 1.安装依赖

如果你没有安装 `docker` 和 `docker-compose`，用 Docker 官方的安装脚本最省事：

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

国内网络拉不动就加镜像参数：`curl -fsSL https://get.docker.com | sh -s docker --mirror Aliyun`。
（一键脚本检测到没有 docker 时走的正是这两条路之一：海外 `get.docker.com`、国内
`vanblog.mereith.com/docker.sh` 配 `--mirror Aliyun`；⚠️ 它**不会问你**，直接用 root 装。）

::: tip

如果你没有接触过 `docker`，可以查看 [Docker 入门教程](https://www.ruanyifeng.com/blog/2018/02/docker-tutorial.html)。

:::

::: warning 环境要求

只需安装 **`docker` 和 `docker-compose`** 即可，**不需要手动安装 `mongoDB`**，因为编排中已经包含了数据库（数据库是通过 docker 容器化运行的，不需要手动安装）。

:::

### 2.新建编排文件

在安装好了 `docker` 和 `docker-compose` 后，新建一个 `vanblog` 的目录，在这个目录下新建 `docker-compose.yaml`文件。

::: tip 直接用仓库里的模板

本分支维护着一份**逐行带注释**的编排模板：仓库里的
[`docker-compose/docker-compose-template.yml`](https://github.com/CKboss/vanblog/blob/dev/dsh/docker-compose/docker-compose-template.yml)
（每个 Release 的附件里也有同名文件，一键脚本装的就是它）。它比下面的最小示例多了
**vanblog 自身的健康检查**（同时探 80 的 `/api/public/health` 与 3001 的 `/__vanblog_health_probe__`，
见下面「健康检查」一节 —— 🔴 **podman 用户尤其需要它**，因为 podman 构建会丢掉镜像里的 `HEALTHCHECK`）、
mongo 健康检查、日志大小上限、`stop_grace_period`、ulimits 等生产细节，推荐以它为准，
把 `vanblog_image` / `vanblog_mongo_image` / 端口 / 数据目录几个占位符替换掉即可。

:::

最小示例（本分支镜像 + mongo 7）。下面这一整段是**一个文件的内容**：在你服务器上新建的
`vanblog` 目录里存成 `docker-compose.yaml`，改两处（`EMAIL` 和数据目录）就能用：

```yml
version: '3.4'

services:
  vanblog:
    # 钉住发布号：内容永不变，好复现也好回滚。
    # 想自动跟上新发版可以写 :latest，但出问题时你就说不清跑的是哪一版了。
    image: ghcr.io/ckboss/vanblog:v2026.9.2
    restart: always
    environment:
      TZ: 'Asia/Shanghai'
      # 邮箱地址，用于自动申请 https 证书
      EMAIL: 'someone@example.com'
      # 本机反代时仅监听回环。默认留空（所有网卡）
      # VAN_BLOG_SERVER_HOST: '127.0.0.1'
      # ── 零接触初始化（可选）：全新站点在容器开始监听前就建好管理员，
      #    站点不会暴露在「未初始化」状态；已初始化的站点会忽略这几项。──
      # VANBLOG_ADMIN_USER: 'your-admin-name'
      # VANBLOG_ADMIN_PASSWORD: 'a-strong-unique-password'
      # 推荐用文件（Docker secret）而不是内联；_FILE 优先于内联变量
      # VANBLOG_ADMIN_PASSWORD_FILE: '/run/secrets/vanblog_admin_password'
      # ── 初始化密钥：新版**默认开启**，匿名初始化必须携带 <日志目录>/setup.key 里的密钥
      #    （日志里每 10 分钟重印一次）。确认不需要时才显式关闭：──
      # VANBLOG_INIT_REQUIRE_SETUP_KEY: 'false'
    volumes:
      # 图床文件的存放地址，按需修改。
      - ${PWD}/data/static:/app/static
      # 日志文件（初始化密钥 setup.key、忘记密码的 restore.key、整站备份归档都在这里）
      - ${PWD}/log:/var/log
      # Caddy 配置存储
      - ${PWD}/caddy/config:/root/.config/caddy
      # Caddy 证书存储
      - ${PWD}/caddy/data:/root/.local/share/caddy
    ports:
      # 前面的是映射到宿主机的端口号，改端口的话改前面的。
      - 80:80
      - 443:443
      # HTTP/3(QUIC) 走 UDP；不开也不影响 HTTP/2
      - 443:443/udp
    depends_on:
      - mongo
  mongo:
    # ⚠️ 某些老机器 CPU 不支持 avx，跑不了 5.0+，那种情况用 mongo:4.4.16。
    # 数据目录与 MongoDB 大版本绑定，装好之后不要随手换 tag（见上面的警告）。
    image: mongo:7.0
    restart: always
    environment:
      TZ: 'Asia/Shanghai'
    volumes:
      - ${PWD}/data/mongo:/data/db
    healthcheck:
      test: ["CMD-SHELL", "mongosh --quiet --eval 'db.runCommand({ping:1}).ok' || mongo --quiet --eval 'db.runCommand({ping:1}).ok'"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 40s
```

> 所有可用的环境变量详见 [参考 → 环境变量](../reference/env.md)。

### 3.启动项目

按注释说明修改 `docker-compose.yaml` 的配置后运行（**在放这个文件的那个目录里**敲）：

```bash
docker-compose up -d
```

第一次会先拉镜像（约 890MB + mongo 约 500MB），视网速要几分钟，屏幕上一行行百分比是正常的。
跑完用这两条确认起来了：

```bash
docker-compose ps                    # 两个服务都应该是 Up（vanblog 还会带 (healthy)）
curl -s http://127.0.0.1/api/public/health   # 回一段 JSON，里面有 "status":"ok" 和版本号
```

看到 `status` 是 `ok` 就算成功，然后浏览器打开 `http://你的服务器IP` 去初始化。

::: info 起不来时先看这两条

- `Bind for 0.0.0.0:80 failed: port is already allocated` —— 80 端口被别的程序占了
  （宝塔的 nginx 最常见）。要么停掉它，要么把编排里 `- 80:80` 改成 `- 8880:80` 这种，
  之后用 `http://你的IP:8880` 访问。
- mongo 容器反复重启、日志里有 `Illegal instruction` 或提到 avx —— 老 CPU 不支持 avx，跑不了 5.0+，
  把 `image: mongo:7.0` 换成 `mongo:4.4.16`（⚠️ 只有**全新安装**能这么换；已经装好的站不要随手换
  mongo 大版本，数据目录会不认）。

其余报错先 `docker-compose logs --tail 100 vanblog` 看日志，常见问题的对照表在
[部署常见问题](../faq/deploy.md)。

:::

启动完毕后，请 [完成初始化](./init.md)（走向导、在初始化页上传整站备份恢复、或用上面注释里的
零接触环境变量，三选一）。

:::: tip 健康检查

镜像自带 `HEALTHCHECK`（每 60 秒一次，超时 10 秒，启动宽限 180 秒，连续 3 次失败才算 unhealthy）。
`docker ps` 的 STATUS 列会显示 `(healthy)` / `(unhealthy)`。也可以手动验证：

```bash
curl -s http://127.0.0.1/api/public/health
```

它**同时探两个地方**，两个都通过才算健康（以前只探第一个，于是前台进程永久挂掉时容器仍然显示健康，
而 `restart: always` 不会介入）：

| 探哪里 | 判定 |
| --- | --- |
| caddy 的 **80** 端口上的 `/api/public/health` | 状态码 **<500** 就算过 —— 数据库连不上时它返回 503，那是「server 活着但库不通」，不该被当成进程死了 |
| 前台进程所在的 **3001** 端口上的 `/__vanblog_health_probe__` | **只要有任何 HTTP 响应**就算活着（这个路径是**故意不存在**的，404 正好） |

⚠️ 第二个探测**不打首页**，这是有意的：打首页会触发一次真实渲染（ISR 未命中要读库），访问高峰或
缓存冷的时候容易超时，会把「慢但活着」误判成「死了」从而触发重启 —— 那比不探更糟。一个不存在的
路径走一次路由 404，大约 1 毫秒。

::: warning podman 用户要自己补两步，否则健康检查等于没有

用 **podman/buildah** 构建的镜像会**丢掉** Dockerfile 里的 `HEALTHCHECK` 指令（docker buildx 保留）。所以：

1. 跑一次 `./vanblog.sh config` 重新生成 `docker-compose.yaml` —— 新模板里带一份**等价**的健康检查；
2. **podman 还要自己加**才会真的自愈：`podman run --health-on-failure=restart …`（quadlet 里写 `HealthOnFailure=restart`）。不加的话，健康检查只是让 `podman ps` 能看出状态，**不会自动重启**。

⚠️ Docker 用户也别误会：**Docker 自身同样不会**因为 unhealthy 就重启容器（restart 策略只看退出码）。
健康检查是给人和编排系统（k8s 的 liveness probe、监控告警）看的信号。想让「前台挂了自动恢复」真的发生，
要么用 podman 的 `--health-on-failure`，要么在 k8s 里把 liveness probe 配成上面那两个探测。

:::

::::
