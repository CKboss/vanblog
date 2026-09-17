::: warning 先选镜像：本分支还是上游官方版

本 fork（`CKboss/vanblog` 的 `dev/dsh` 分支）的镜像发布在 **`ghcr.io/ckboss/vanblog`**，
上游官方镜像是 `mereith/van-blog:latest`（另有阿里云镜像源
`registry.cn-beijing.aliyuncs.com/mereith/van-blog:latest`）。**两边不通用**：本分支的整站备份/恢复、
恢复演练、安全加固与下面提到的新安装方式都不在上游镜像里。想用本分支有三种方式：

1. **一键脚本（推荐）**：默认 `docker pull ghcr.io/ckboss/vanblog:dev-dsh`（GitHub Actions 构建发布，
   小机器也装得动），拉不到时自动退回「克隆源码 + 本地构建」。

   ```bash
   curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh \
     && chmod +x vanblog.sh && ./vanblog.sh
   ```

2. **直接拉本分支镜像**，把编排文件里的 `image:` 换掉即可（不需要构建，1C1G 也能跑）：

   ```bash
   docker pull ghcr.io/ckboss/vanblog:dev-dsh
   # 标签：v2026.9.1 等发布号 / latest / dev-dsh / dev-dsh-<短sha>（钉版本、回滚用）；只发布了 linux/amd64
   ```

   镜像**不是每次 push 都重建**（一次构建 20–40 分钟 runner 时间，而多数提交只是文档改动）：
   要发新版就去仓库的 **Actions → publish-ghcr → Run workflow** 手动触发，或者推一个 `v*` 标签。
   所以 `dev-dsh` 标签对应的是**最后一次手动发版时的代码**，不一定等于分支最新提交；
   想要最新提交就自己构建（见下面第 3 种方式），或用 `VANBLOG_INSTALL_MODE=source ./vanblog.sh`。

   ::: tip 拉不动？

   ghcr 的 package 默认是 **private**。如果 `docker pull` 报 `denied` 或 `not found`，
   说明仓库主还没把它改成公开：`https://github.com/CKboss/vanblog/pkgs/container/vanblog`
   → Package settings → Danger Zone → Change visibility → Public。
   在那之前脚本会自动退回源码构建。

   :::

3. **自己构建镜像**，然后把编排文件里的 `image:` 换成本地 tag：

   ```bash
   git clone --depth 1 -b dev/dsh https://github.com/CKboss/vanblog.git
   cd vanblog
   # 可选的构建参数：
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

   # 内存小于 6GB 的机器建议**串行**构建（一次只跑一个重活），否则三个 stage 并发会 OOM：
   for stage in admin_builder server_builder website_builder; do
     docker build --target "$stage" . || break
   done
   docker build -t vanblog:dev-dsh .   # 前三步命中缓存，只组装最终镜像
   ```

:::

### 1.安装依赖

如果你没有安装 `docker` 和 `docker-compose`，可以通过以下命令一键安装：

```bash
curl -sSL https://get.daocloud.io/docker | sh
systemctl enable --now docker
```

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
mongo 健康检查、日志大小上限、`stop_grace_period`、ulimits 等生产细节，推荐以它为准，
把 `vanblog_image` / `vanblog_mongo_image` / 端口 / 数据目录几个占位符替换掉即可。

:::

最小示例（本分支镜像 + mongo 7）：

```yml
version: '3.4'

services:
  vanblog:
    # 本分支镜像；上游官方镜像是 mereith/van-blog:latest
    image: ghcr.io/ckboss/vanblog:dev-dsh
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

按注释说明修改 `docker-compose.yaml` 的配置后运行：

```bash
docker-compose up -d
```

启动完毕后，请 [完成初始化](./init.md)（走向导、在初始化页上传整站备份恢复、或用上面注释里的
零接触环境变量，三选一）。

::: tip 健康检查

镜像自带 `HEALTHCHECK`（每 60 秒打一次匿名的 `GET /api/public/health`，数据库 ping 不通返回 503）。
`docker ps` 的 STATUS 列会显示 `(healthy)` / `(unhealthy)`。也可以手动验证：

```bash
curl -s http://127.0.0.1/api/public/health
```

⚠️ 两个已知边界：用 **podman/buildah** 构建的镜像会**丢掉** Dockerfile 里的 `HEALTHCHECK`
指令（docker buildx 保留），跑在 podman 系编排上要自己配健康检查；另外 Docker 自身不会因为
unhealthy 就重启容器（restart 策略只看退出码），这个信号是给人和编排系统看的。

:::
