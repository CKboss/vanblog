# 具体每个服务的去看 packages 里面的 Dockerfile
# 这个是 all in one 的。
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

FROM node:18-alpine AS admin_builder
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
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
# --frozen-lockfile：版本必须和仓库锁的一致，不一致就直接失败（而不是悄悄装个新版）
RUN pnpm install --frozen-lockfile
# RUN sed -i 's/\/assets/\/admin\/assets/g' dist/admin/index.html
# 堆上限写在 package.json 的脚本里（cross-env 会整体替换 NODE_OPTIONS，
# 镜像的 ENV 传不进去，见 §7.24）。低内存机器用 build:lowmem 那一档。
WORKDIR /app/packages/admin
RUN pnpm run ${VAN_BLOG_ADMIN_BUILD_SCRIPT}

FROM node:18 AS server_builder
ARG VAN_BLOG_NPM_REGISTRY
ENV NODE_OPTIONS=--max_old_space_size=4096
WORKDIR /app
COPY ./packages/server/ .
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
FROM node:18-alpine AS website_builder
ARG VAN_BLOG_NPM_REGISTRY
WORKDIR /app
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1
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
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
RUN pnpm install --frozen-lockfile
RUN pnpm build:website


#运行容器
FROM node:18-alpine AS runner
ARG VAN_BLOG_NPM_REGISTRY
WORKDIR /app
# zstd / xz：后台「整站备份」默认用 zstd -19（其次 xz，最后才 gzip），
# 镜像里没有这两个命令的话会静默降级成 gzip，压缩率和速度都差很多。
# tar 用 busybox 自带的即可（备份/恢复只用 -cf -/-xf -/-xOf 这些基础能力）。
RUN  apk add --no-cache --update tzdata caddy nss-tools libwebp-tools libavif-apps libc6-compat zstd xz \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo "Asia/Shanghai" > /etc/timezone \
  && apk del tzdata
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
ENV EMAIL="vanblog@mereith.com"
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
ENTRYPOINT [ "sh","entrypoint.sh" ]
# CMD [ "entrypoint.sh" ]
