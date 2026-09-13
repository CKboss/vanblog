::: warning 下面的镜像是上游官方版

下面的 `image: mereith/van-blog:latest` 是**上游官方镜像**，不包含本 fork（`CKboss/vanblog` 的
`dev/dsh` 分支）的任何改动。想用本分支有三种方式：

1. **一键脚本（推荐）**：默认 `docker pull ghcr.io/ckboss/vanblog:dev-dsh`（GitHub Actions 构建发布，
   小机器也装得动），拉不到时自动退回「克隆源码 + 本地构建」。

   ```bash
   curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh \
     && chmod +x vanblog.sh && ./vanblog.sh
   ```

2. **直接拉本分支镜像**，把编排文件里的 `image:` 换掉即可（不需要构建，1C1G 也能跑）：

   ```bash
   docker pull ghcr.io/ckboss/vanblog:dev-dsh
   # 也有 dev-dsh-<短sha> 与 latest 两个标签；只发布了 linux/amd64
   ```

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
   docker build \
     --build-arg VAN_BLOG_VERSIONS=dev/dsh \
     --build-arg VAN_BLOG_ADMIN_BUILD_SCRIPT=build \
     -t vanblog:dev-dsh .

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

在安装好了 `docker` 和 `docker-compose` 后，新建一个 `vanblog` 的目录，在这个目录下新建 `docker-compose.yaml`文件，内容如下：

```yml
version: '3'

services:
  vanblog:
    # 阿里云镜像源
    # image: registry.cn-beijing.aliyuncs.com/mereith/van-blog:latest
    image: mereith/van-blog:latest
    restart: always
    environment:
      TZ: 'Asia/Shanghai'
      # 邮箱地址，用于自动申请 https 证书
      EMAIL: 'someone@mereith.com'
      # 本机反代时仅监听回环。默认留空（所有网卡）
      # VAN_BLOG_SERVER_HOST: '127.0.0.1'
    volumes:
      # 图床文件的存放地址，按需修改。
      - ${PWD}/data/static:/app/static
      # 日志文件
      - ${PWD}/log:/var/log
      # Caddy 配置存储
      - ${PWD}/caddy/config:/root/.config/caddy
      # Caddy 证书存储
      - ${PWD}/caddy/data:/root/.local/share/caddy
    ports:
      # 前面的是映射到宿主机的端口号，改端口的话改前面的。
      - 80:80
      - 443:443
  mongo:
    # 某些机器不支持 avx 会报错，所以默认用 v4 版本。有的话用最新的。
    image: mongo:4.4.16
    restart: always
    environment:
      TZ: 'Asia/Shanghai'
    volumes:
      - ${PWD}/data/mongo:/data/db
```

> 所有可用的环境变量详见 [参考 → 环境变量](../reference/env.md)。

### 3.启动项目

按注释说明修改 `docker-compose.yaml` 的配置后运行：

```bash
docker-compose up -d
```

启动完毕后，请 [完成初始化](./init.md)。
