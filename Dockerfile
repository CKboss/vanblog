# 具体每个服务的去看 packages 里面的 Dockerfile
# 这个是 all in one 的。
#
# ── 基础镜像版本为什么是 node:20 ──────────────────────────────────────────
# Node 18 已于 2025-04 EOL（不再有安全更新），所以四个 stage 全部升到 20。
# **没有直接上 22/24**，因为两条硬约束：
#   1. Node 23 移除了 `util.isObject`，而 @nestjs/cli 9 还在用它 →
#      Node 24 上 `nest build` 直接崩（本机开发环境就是因此固定在 node20，见 AGENTS §3.6）。
#   2. sharp 0.32.6 的预编译二进制只覆盖到 Node 20（NODE_MODULE_VERSION 115）；
#      Node 22 是 127 → 没有 prebuild，而 runner 阶段没装 vips-dev，
#      图片处理会在运行时加载失败。要升 22 必须同时把 sharp 升到 0.33+。
# Node 20 这一档是**本机开发环境验证过的**（node v20.19.5：server 610 用例、
# admin `umi build`、website `next build` 全通过），sharp 0.32.6 也有 20 的 prebuild。
#
# 全局构建参数（⚠️ BuildKit 的规则：FROM 之前声明的 ARG 属于"全局"，
#   在具体 stage 里要用必须**再 ARG 一次**，否则取到的是空值）。
#   scripts/vanblog.sh 会自动探测本机网络与配置后传这些参数。
#
# VAN_BLOG_NPM_REGISTRY  pnpm 源。默认 npmmirror（国内快一个数量级）；
#                        脚本会实测两个源的连通性与延迟，把更快的传进来。
#                        以前 admin 那层硬编码 registry.npmjs.org，是它 `pnpm i`
#                        比 website 层慢 4 倍的原因。
# VAN_BLOG_ADMIN_BUILD_SCRIPT  admin 用哪个构建脚本：`build`（堆上限 4096MB）或
#                        `build:lowmem`（1536MB，给小内存机器）。
ARG VAN_BLOG_NPM_REGISTRY=https://registry.npmmirror.com
ARG VAN_BLOG_ADMIN_BUILD_SCRIPT=build
# VAN_BLOG_ALPINE_MIRROR  Alpine 软件源镜像（留空 = 官方 dl-cdn.alpinelinux.org）。
#   国内直连官方源实测要 10 秒以上（构建会看起来"卡死"在 apk add 那一步），
#   换 mirrors.aliyun.com/alpine 实测 0.39s。三个 alpine stage 都会用到。
#   ⚠️ BuildKit 规则：FROM 之前的 ARG 是全局的，但 stage 里要用必须**再 ARG 一次**。
ARG VAN_BLOG_ALPINE_MIRROR=
# VAN_BLOG_NODE_DIST_URL  node-gyp 下载 Node 头文件的地址（留空 = node-gyp 自己的默认值）。
#   Alpine/musl 下 node-gyp 默认去 unofficial-builds.nodejs.org，国内经常连不上，
#   于是 tree-sitter / sharp 这类原生模块编译失败，`pnpm install` 整个 stage 就挂了
#   （报错是 FetchError: request to https://unofficial-builds.nodejs.org/... failed）。
#   npmmirror 有全套头文件：https://npmmirror.com/mirrors/node
ARG VAN_BLOG_NODE_DIST_URL=

FROM node:20-alpine AS admin_builder
ARG VAN_BLOG_NPM_REGISTRY
ARG VAN_BLOG_ADMIN_BUILD_SCRIPT
# ⚠️ 这里的 NODE_OPTIONS 对 `pnpm build` **不起作用**：admin 的 build 脚本是
# `cross-env NODE_OPTIONS=--openssl-legacy-provider umi build`，cross-env 会**整体替换**
# 而不是追加，于是 --max_old_space_size 被丢掉，Node 按"可用内存"启发式给了个很小的堆，
# 构建到一半就 `FATAL ERROR: Reached heap limit Allocation failed`（实测 ~486MB 就炸）。
# 真正的修复在 packages/admin/package.json 的 build 脚本里（两个 flag 都写死）。
# 这行保留是给 pnpm i / postinstall(umi g tmp) 这些不走 cross-env 的步骤用的。
ENV NODE_OPTIONS='--max_old_space_size=4096 --openssl-legacy-provider'
ENV EEE=production
WORKDIR /app
USER root
ARG VAN_BLOG_ALPINE_MIRROR
# 换 Alpine 源必须在第一条 apk add **之前**；留空就不动（用官方源）。
# ⚠️ 不用 sed 改 /etc/apk/repositories：Alpine 用的是 **busybox sed**，
#    它不支持 GNU 的 `\?` 可选分组，写 `s|https\?://dl-cdn…|` 匹配不上，
#    结果 apk 拿着空/错的源报 `python3 (no such package)`（实测踩过）。
#    直接按镜像自己的 Alpine 版本重写这个文件，确定性最高。
RUN if [ -n "${VAN_BLOG_ALPINE_MIRROR}" ]; then \
      . /etc/os-release; \
      # ⚠️ VERSION_ID 是三段（3.23.4），而仓库路径只有两段（v3.23）——
      #    直接拼会得到 .../v3.23.4/main → HTTP 404 → apk 报 "no such package"。
      apk_ver="$(printf '%s' "${VERSION_ID}" | cut -d. -f1,2)"; \
      printf '%s\n%s\n' \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/main" \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/community" \
        > /etc/apk/repositories; \
      echo "使用 Alpine 镜像源: ${VAN_BLOG_ALPINE_MIRROR} (v${apk_ver})"; \
    fi
RUN apk add --update python3 make g++ && rm -rf /var/cache/apk/*
# ⚠️ 这一层以前是 `COPY ./packages/admin/ ./` + `pnpm i`（**独立安装、没有 lockfile**），
# 结果每次构建都重新解析依赖版本，和仓库里锁定的版本对不上。真实事故：
#   Module not found: Package path ./dist/cytoscape.umd.js is not exported from
#   package .../mermaid@10.6.1/node_modules/cytoscape
# mermaid 10.6.1 要 `cytoscape/dist/cytoscape.umd.js`，而 lockfile 锁的是 cytoscape 3.27.0
# （exports 里有这个路径）；独立安装解析到了更新版的 cytoscape，exports 变了就找不到文件。
# website_builder 用 `--frozen-lockfile` 所以从来没这个问题 —— 这也说明**必须走 lockfile**。
# 现在改成和 website_builder 一样的 workspace 安装：拷根 manifest + lockfile + workspace +
# patches，`pnpm install --frozen-lockfile`，再进 packages/admin 构建。
# 好处：版本可复现、和本地开发完全一致、根 manifest 的 patchedDependencies 也直接生效
# （所以 packages/admin/package.json 里那份镜像声明已经删掉，不再需要，也不再打 WARN）。
COPY ./package.json ./
COPY ./pnpm-lock.yaml ./
COPY ./pnpm-workspace.yaml ./
COPY ./tsconfig.base.json ./
COPY ./patches ./patches
COPY ./packages/admin ./packages/admin
ARG VAN_BLOG_NODE_DIST_URL
# 原生模块（tree-sitter / sharp）编译时 node-gyp 要下 Node 头文件；musl 默认走
# unofficial-builds.nodejs.org，国内连不上会让整个 install 失败。设了就用镜像地址。
RUN if [ -n "${VAN_BLOG_NODE_DIST_URL}" ]; then \
      npm config set disturl "${VAN_BLOG_NODE_DIST_URL}" -g; \
      echo "node-gyp 头文件源: ${VAN_BLOG_NODE_DIST_URL}"; \
    fi
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
# --frozen-lockfile：版本必须和仓库锁的一致，不一致就直接失败（而不是悄悄装个新版）
# ⚠️ 只装 admin 及其依赖（`--filter <pkg>...`）：整仓安装会把 packages/server 的依赖
#    也拉进来（@swagger-api/apidom → tree-sitter/tree-sitter-yaml/tree-sitter-json 三个
#    原生模块），在 alpine 上要用 node-gyp 现编译，慢且容易卡；admin 构建根本用不到它们。
RUN pnpm install --frozen-lockfile --filter "@vanblog/admin..."

# RUN sed -i 's/\/assets/\/admin\/assets/g' dist/admin/index.html
# 堆上限写在 package.json 的脚本里（cross-env 会整体替换 NODE_OPTIONS，
# 镜像的 ENV 传不进去，见 §7.24）。低内存机器用 build:lowmem 那一档。
WORKDIR /app/packages/admin
RUN pnpm run ${VAN_BLOG_ADMIN_BUILD_SCRIPT}

FROM node:20 AS server_builder
ARG VAN_BLOG_NPM_REGISTRY
ENV NODE_OPTIONS=--max_old_space_size=4096
WORKDIR /app
COPY ./packages/server/ .
ARG VAN_BLOG_NODE_DIST_URL
# 原生模块（tree-sitter / sharp）编译时 node-gyp 要下 Node 头文件；musl 默认走
# unofficial-builds.nodejs.org，国内连不上会让整个 install 失败。设了就用镜像地址。
RUN if [ -n "${VAN_BLOG_NODE_DIST_URL}" ]; then \
      npm config set disturl "${VAN_BLOG_NODE_DIST_URL}" -g; \
      echo "node-gyp 头文件源: ${VAN_BLOG_NODE_DIST_URL}"; \
    fi
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
RUN pnpm i
RUN pnpm build

# 前台：Alpine + sharp。musl 版本号可能是 1.2.4_git*，sharp 0.31 会报
# Installation error: Invalid Version。用 0.32.6 + 官方 musl prebuild，并装 vips 编译兜底。
FROM node:20-alpine AS website_builder
ARG VAN_BLOG_NPM_REGISTRY
WORKDIR /app
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1
ARG VAN_BLOG_ALPINE_MIRROR
# 换 Alpine 源必须在第一条 apk add **之前**；留空就不动（用官方源）。
# ⚠️ 不用 sed 改 /etc/apk/repositories：Alpine 用的是 **busybox sed**，
#    它不支持 GNU 的 `\?` 可选分组，写 `s|https\?://dl-cdn…|` 匹配不上，
#    结果 apk 拿着空/错的源报 `python3 (no such package)`（实测踩过）。
#    直接按镜像自己的 Alpine 版本重写这个文件，确定性最高。
RUN if [ -n "${VAN_BLOG_ALPINE_MIRROR}" ]; then \
      . /etc/os-release; \
      # ⚠️ VERSION_ID 是三段（3.23.4），而仓库路径只有两段（v3.23）——
      #    直接拼会得到 .../v3.23.4/main → HTTP 404 → apk 报 "no such package"。
      apk_ver="$(printf '%s' "${VERSION_ID}" | cut -d. -f1,2)"; \
      printf '%s\n%s\n' \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/main" \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/community" \
        > /etc/apk/repositories; \
      echo "使用 Alpine 镜像源: ${VAN_BLOG_ALPINE_MIRROR} (v${apk_ver})"; \
    fi
RUN apk add --no-cache python3 make g++ libc6-compat vips-dev fftw-dev
COPY ./package.json ./
COPY ./pnpm-lock.yaml ./
COPY ./pnpm-workspace.yaml ./
COPY ./tsconfig.base.json ./
# 仓库根 package.json 的 pnpm.patchedDependencies 指向 patches/*.patch：
# 这一层是 workspace 安装（读得到根 manifest），少拷这个目录就会
# `ENOENT: no such file or directory, open '/app/patches/remark-supersub@1.0.0.patch'`
COPY ./patches ./patches
COPY ./packages/website ./packages/website
ENV isBuild=t
ENV VAN_BLOG_ALLOW_DOMAINS="pic.mereith.com"
# 默认值必须有：不传这个 build-arg 时 ENV 会变成**空串**，
# 前台 utils/loadConfig.ts 在模块顶层 new URL('') → next build 的
# "Collecting page data" 阶段直接 ERR_INVALID_URL 失败（栈里只有 chunk 编号，很难查）。
ARG VAN_BLOG_BUILD_SERVER=http://127.0.0.1:3000
ENV VAN_BLOG_SERVER_URL=${VAN_BLOG_BUILD_SERVER}
ARG VAN_BLOG_VERSIONS
ENV VAN_BLOG_VERSION=${VAN_BLOG_VERSIONS}
ARG VAN_BLOG_NODE_DIST_URL
# 原生模块（tree-sitter / sharp）编译时 node-gyp 要下 Node 头文件；musl 默认走
# unofficial-builds.nodejs.org，国内连不上会让整个 install 失败。设了就用镜像地址。
RUN if [ -n "${VAN_BLOG_NODE_DIST_URL}" ]; then \
      npm config set disturl "${VAN_BLOG_NODE_DIST_URL}" -g; \
      echo "node-gyp 头文件源: ${VAN_BLOG_NODE_DIST_URL}"; \
    fi
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
# 同理：只装 website 及其依赖（sharp 是它自己的依赖，仍然会装上）
# ⚠️ website 的包名是 @vanblog/theme-default（不是 @vanblog/website），过滤名写错会一个包都装不上
RUN pnpm install --frozen-lockfile --filter "@vanblog/theme-default..."
RUN pnpm build:website


#运行容器
FROM node:20-alpine AS runner
ARG VAN_BLOG_NPM_REGISTRY
WORKDIR /app
# zstd / xz：后台「整站备份」默认用 zstd -19（其次 xz，最后才 gzip），
# 镜像里没有这两个命令的话会静默降级成 gzip，压缩率和速度都差很多。
# tar 用 busybox 自带的即可（备份/恢复只用 -cf -/-xf -/-xOf 这些基础能力）。
ARG VAN_BLOG_ALPINE_MIRROR
# 换 Alpine 源必须在第一条 apk add **之前**；留空就不动（用官方源）。
# ⚠️ 不用 sed 改 /etc/apk/repositories：Alpine 用的是 **busybox sed**，
#    它不支持 GNU 的 `\?` 可选分组，写 `s|https\?://dl-cdn…|` 匹配不上，
#    结果 apk 拿着空/错的源报 `python3 (no such package)`（实测踩过）。
#    直接按镜像自己的 Alpine 版本重写这个文件，确定性最高。
RUN if [ -n "${VAN_BLOG_ALPINE_MIRROR}" ]; then \
      . /etc/os-release; \
      # ⚠️ VERSION_ID 是三段（3.23.4），而仓库路径只有两段（v3.23）——
      #    直接拼会得到 .../v3.23.4/main → HTTP 404 → apk 报 "no such package"。
      apk_ver="$(printf '%s' "${VERSION_ID}" | cut -d. -f1,2)"; \
      printf '%s\n%s\n' \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/main" \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/community" \
        > /etc/apk/repositories; \
      echo "使用 Alpine 镜像源: ${VAN_BLOG_ALPINE_MIRROR} (v${apk_ver})"; \
    fi
RUN  apk add --no-cache --update tzdata caddy nss-tools libwebp-tools libavif-apps libc6-compat zstd xz \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo "Asia/Shanghai" > /etc/timezone \
  && apk del tzdata
ARG VAN_BLOG_NODE_DIST_URL
# runner 也会 `pnpm i`（cli 与 waline），原生模块编译同样需要头文件源
RUN if [ -n "${VAN_BLOG_NODE_DIST_URL}" ]; then \
      npm config set disturl "${VAN_BLOG_NODE_DIST_URL}" -g; \
      echo "node-gyp 头文件源: ${VAN_BLOG_NODE_DIST_URL}"; \
    fi
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
# 复制 cli 工具
WORKDIR /app/cli
COPY ./packages/cli/ ./
RUN pnpm i
# 安装 waline
WORKDIR /app/waline
COPY ./packages/waline/ ./
RUN pnpm i
# 复制 server
WORKDIR /app/server
COPY --from=server_builder /app/node_modules ./node_modules
COPY --from=server_builder /app/dist/src/ ./
# 复制 website
WORKDIR /app/website
COPY --from=website_builder  /app/packages/website/.next/standalone/ ./
COPY --from=website_builder /app/packages/website/next.config.js ./packages/website/next.config.js
COPY --from=website_builder /app/packages/website/public ./packages/website/public
COPY --from=website_builder /app/packages/website/package.json ./packages/website/package.json
COPY --from=website_builder  /app/packages/website/.next/static ./packages/website/.next/static
RUN  cd  /app/website  && cd ..
ENV NODE_ENV=production
ENV VAN_BLOG_SERVER_URL="http://127.0.0.1:3000"
ENV VAN_BLOG_ALLOW_DOMAINS="pic.mereith.com"
ENV VAN_BLOG_DATABASE_URL="mongodb://mongo:27017/vanBlog?authSource=admin"
# ⚠️ 以前这里默认填了上游作者的邮箱：没设 EMAIL 的用户会拿**作者的地址**去注册
# Let's Encrypt 账户（到期提醒也发给作者）。留空是安全的 —— Caddy 的 acme issuer
# 允许没有联系邮箱，entrypoint.sh 也会把空值/占位符/非法值统一处理成空。
ENV EMAIL=""
ENV VAN_BLOG_WALINE_DB="waline"
# 复制静态文件
WORKDIR /app/admin
# admin 现在是 workspace 安装，产物在 packages/admin/dist 下（以前独立安装时是 /app/dist）
COPY --from=admin_builder /app/packages/admin/dist/ ./
COPY caddyTemplate.json /app/caddyTemplate.json
# 降级模板：主配置因为 Caddy 版本漂移加载失败时用它（去掉 apps.tls，HTTP 仍可用）。
# 没有它的话，一次 caddy 配置不兼容就会让整个站点没有任何监听，而容器看起来是"运行中"。
COPY caddyFallbackTemplate.json /app/caddyFallbackTemplate.json
# 复制入口文件
WORKDIR /app
COPY ./scripts/start.js ./
COPY ./entrypoint.sh ./
ENV PORT=3001
# 增加版本
ARG VAN_BLOG_VERSIONS
ENV VAN_BLOG_VERSION=${VAN_BLOG_VERSIONS}
VOLUME /app/static
VOLUME /var/log
VOLUME /root/.config/caddy
VOLUME /root/.local/share/caddy

EXPOSE 80
EXPOSE 443

# 健康检查探的是 **caddy 的 80 端口**而不是 server 的 3000：这样一条检查覆盖整条请求路径
# （caddy → server / 前台 / 后台静态文件）。前面两次事故（caddy 配置加载失败、server 缺
# multer 起不来）在这个检查下都会直接显示成 unhealthy/restarting，而不是"容器在跑但打不开"。
# ⚠️ 镜像里没有 curl，用自带的 node 发请求；start-period 给足，小机器冷启动 + 首次连 mongo 很慢。
# 注意 Docker 自身不会因为 unhealthy 就重启容器（restart 策略只看退出码），
# 所以这个检查纯粹是给人和编排系统看的信号，不会引入重启风暴。
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:80,path:'/',timeout:8000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1)).on('timeout',function(){this.destroy();process.exit(1)})" || exit 1
ENTRYPOINT [ "sh","entrypoint.sh" ]
# CMD [ "entrypoint.sh" ]
