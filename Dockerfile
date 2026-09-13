# 具体每个服务的去看 packages 里面的 Dockerfile
# 这个是 all in one 的。
FROM node:18-alpine AS admin_builder
ENV NODE_OPTIONS='--max_old_space_size=4096 --openssl-legacy-provider'
ENV EEE=production
WORKDIR /app
USER root
RUN apk add --update python3 make g++ && rm -rf /var/cache/apk/*
COPY ./packages/admin/ ./
# ⚠️ 必须把仓库根的 patches/ 一起拷进来：admin 直接依赖 remark-supersub 与
# remark-github-blockquote-alert，这两个包只有 exports 字段、没有 main/module，
# umi3 的 MFSU 用老解析器会报 `filePath not found of remark-github-blockquote-alert`
# 让构建直接失败。补丁声明写在 packages/admin/package.json 的 pnpm.patchedDependencies 里
# —— 这一层是**独立安装**（只 COPY 了 admin 目录，没有仓库根的 package.json），
# 看不到根上那份声明，所以两处都得写，路径都相对各自的 manifest。
COPY ./patches ./patches
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry https://registry.npmjs.org -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
RUN pnpm i
# RUN sed -i 's/\/assets/\/admin\/assets/g' dist/admin/index.html
RUN pnpm build

FROM node:18 AS server_builder
ENV NODE_OPTIONS=--max_old_space_size=4096
WORKDIR /app
COPY ./packages/server/ .
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry https://registry.npmmirror.com -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
RUN pnpm i
RUN pnpm build

# 前台：Alpine + sharp。musl 版本号可能是 1.2.4_git*，sharp 0.31 会报
# Installation error: Invalid Version。用 0.32.6 + 官方 musl prebuild，并装 vips 编译兜底。
FROM node:18-alpine AS website_builder
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
RUN pnpm config set registry https://registry.npmmirror.com -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
RUN pnpm install --frozen-lockfile
RUN pnpm build:website


#运行容器
FROM node:18-alpine AS runner
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
RUN pnpm config set registry https://registry.npmmirror.com -g
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
COPY --from=admin_builder /app/dist/ ./
COPY caddyTemplate.json /app/caddyTemplate.json
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
