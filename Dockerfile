# 具体每个服务的去看 packages 里面的 Dockerfile
# 这个是 all in one 的。
#
# ── 基础镜像版本为什么是 node:24 ──────────────────────────────────────────
# 官方生命周期（github.com/nodejs/Release/blob/main/schedule.json）：
#   v20 Iron    EOL 2026-04-30  ← 已过期，不再有安全补丁（本仓库曾在它过期后还用了四个多月）
#   v22 Jod     EOL 2027-04-30
#   v24 Krypton EOL 2028-04-30（2025-10-28 起 LTS）
# 所以五个 stage 全部用 node:24-alpine。⚠️ 2027 年之后要再往上抬，
# 别像 node:20 那样悄悄过期了才发现（scripts/tests/image-runtime.test.sh 会拦住）。
#
# 曾经挡住升级的两条硬约束现在都解除了，**别再拿它们当理由停在旧版本**：
#   1. Node 23 移除了 `util.isObject`，而 @nestjs/cli **9** 的依赖链在用它 ⇒
#      Node 24 上 `nest build` 直接 `Error  (0 , util_1.isObject) is not a function`。
#      修法：`@nestjs/cli` / `@nestjs/schematics` 升到 **11**。
#      ⚠️ 它们是**只在构建期用**的 devDependency，运行时的 `@nestjs/core` 仍然是 9，
#      所以运行时行为一点没变（这也是为什么这个升级风险很低）。
#      注：CLI 11 自带的 TypeScript 是 5.x，而本项目声明的是 4.9.5 ——
#      `nest build` 用 CLI 自带的那个，本机 `tsc -p tsconfig.dev.json` 用项目的 4.9.5，
#      两者都要保持 0 错误（AGENTS §3.6 说了本机那份 tsconfig 为什么必须存在）。
#   2. sharp 0.32.6 的预编译二进制只到 NODE_MODULE_VERSION 115（Node 20），
#      而 runner 阶段没装 vips-dev，升 22 会让图片处理在**运行时**加载失败。
#      修法：sharp 升到 **0.35**，预编译改成 N-API + npm optionalDependencies
#      （`@img/sharp-<平台>`），一份产物跨 Node 版本通用、musl 版也在
#      （已在镜像里实测 webp 编解码往返正常）。
# admin 的 umi3/webpack4 需要 `--openssl-legacy-provider`（webpack4 用 md4 算 chunk hash），
# 这个开关在 Node 24 上**仍然有效**（OpenSSL 3 的 legacy provider 里带 MD4），实测构建通过。
# waline 的 better-sqlite3 在 musl 上没有预编译包、每次都要 node-gyp 现场编译，
# Node 24 的头文件在 unofficial-builds 上有（已实测编译通过），
# 但那个 stage 必须装 `py3-setuptools`（Alpine 的 Python 3.12+ 没有 distutils，node-gyp 9 还要它）。
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
# VAN_BLOG_SHARP_DIST_HOST  sharp / sharp-libvips 预编译二进制的下载源（留空 = 官方 GitHub Releases）。
#   sharp 的 install 脚本默认从 github.com/lovell/sharp{,-libvips}/releases 下载，
#   国内直接 `Installation error: aborted` → 整个 pnpm install 失败（本地构建实测）。
#   npmmirror 把两套二进制都镜像了，而且**musl 版也有**：
#     <host>/sharp/v0.32.6/sharp-v0.32.6-napi-v7-linuxmusl-x64.tar.gz
#     <host>/sharp-libvips/v8.14.5/libvips-8.14.5-linuxmusl-x64.tar.gz
#   用预编译包就不需要在镜像里装 gcc + vips-dev 从源码编 —— 那可是 200 多个 apk 包，
#   而 apk 拉大包恰恰是本地构建最容易卡死的地方。
ARG VAN_BLOG_SHARP_DIST_HOST=
# 上面这个是给脚本用的"一个开关"（npmmirror 的 binary 根地址）；真正生效的是下面两个，
# 它们分别对应 sharp 自己的 prebuild 和它依赖的 libvips 预编译包，默认就是官方 GitHub Releases。
ARG VAN_BLOG_SHARP_BINARY_HOST=https://github.com/lovell/sharp/releases/download
ARG VAN_BLOG_SHARP_LIBVIPS_HOST=https://github.com/lovell/sharp-libvips/releases/download

FROM node:24-alpine AS admin_builder
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
# ⚠️ 这里以前是 `npm config set disturl "${VAN_BLOG_NODE_DIST_URL}" -g`，而它在 node 24 自带的
#    npm 11 上是**失败**的：`npm error \`disturl\` is not a valid npm option`（这个配置项已被 npm 移除）。
#    更糟的是这条 RUN 的最后一个命令是 echo，退出码取的是 echo 的 ⇒ **失败被吞掉**，
#    日志里照样打印"node-gyp 头文件源: …"，看起来像设置成功了。于是 node-gyp 一直用默认的
#    unofficial-builds.nodejs.org（国内连不上），只是此前没有任何 stage 真的走到 node-gyp：
#    tree-sitter 被 never-built-dependencies 跳过、sharp 用预编译包（它走的是
#    npm_config_sharp_binary_host 这个 **ENV**，所以那条一直是好的）。
#    等 waline 的 better-sqlite3 拿不到预编译包、需要现场编译时，这个洞就炸了
#    （实测：`gyp http GET https://unofficial-builds.nodejs.org/...headers.tar.gz` → FetchError）。
#    现在改成写进 /app/.npmrc：pnpm 会把 npmrc 里的配置以 npm_config_* 环境变量传给生命周期脚本，
#    而 node-gyp 读的正是 npm_config_disturl。并且**校验写入结果**、失败就非 0 退出，
#    不再让末尾的 echo 把错误吞掉（"看起来设置了"比"没设置"更难查）。
RUN if [ -n "${VAN_BLOG_NODE_DIST_URL}" ]; then \
      printf 'disturl=%s\n' "${VAN_BLOG_NODE_DIST_URL}" >> /app/.npmrc && \
      grep -q '^disturl=' /app/.npmrc && \
      echo "node-gyp 头文件源（写入 /app/.npmrc，pnpm 以 npm_config_disturl 传给脚本）: ${VAN_BLOG_NODE_DIST_URL}"; \
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
# ⚠️ alpine/musl 下这三个原生模块（tree-sitter 系列，来自 @swagger-api/apidom 的传递依赖）
# 用 node-gyp 现场编译时会**卡死**：实测 node-gyp 进程活着、11 个线程全在 sleep、
# 没有任何 make/cc1plus 子进程，十分钟不动，整个 stage 挂住（同样的 Dockerfile 在
# GitHub Actions 的 glibc 宿主 + BuildKit 下能正常编过，所以这是 rootless podman/musl
# 这一侧的问题）。admin 的产物是纯静态文件、website 也不会 import 它们，
# 所以在**这两个 alpine stage 里跳过编译**最省事：用 pnpm 的 never-built-dependencies，
# 只影响镜像构建，不动仓库里的 package.json（本机开发照常编译）。
# 注意 sharp 不在名单里 —— 它靠预编译二进制，跳过 install 脚本反而会坏。
RUN printf 'never-built-dependencies[]=tree-sitter\nnever-built-dependencies[]=tree-sitter-json\nnever-built-dependencies[]=tree-sitter-yaml\n' >> /app/.npmrc
RUN pnpm install --frozen-lockfile --filter "@vanblog/admin..."

# RUN sed -i 's/\/assets/\/admin\/assets/g' dist/admin/index.html
# 堆上限写在 package.json 的脚本里（cross-env 会整体替换 NODE_OPTIONS，
# 镜像的 ENV 传不进去，见 §7.24）。低内存机器用 build:lowmem 那一档。
WORKDIR /app/packages/admin
RUN pnpm run ${VAN_BLOG_ADMIN_BUILD_SCRIPT}

# server 也用 **alpine**（和 runner 同一个 libc）。以前这里是 glibc 的 node:20，有两个真问题：
#   1. sharp 的 install 脚本要从 github.com 下 libvips 预编译包，国内网络直接
#      `Installation error: aborted` → 整个 `pnpm i` 失败（本地构建实测）。
#      alpine 这条线有现成解法：装 vips-dev 从源码编（和 website_builder 一样），全程不碰 GitHub。
#   2. glibc 编出来的 node_modules 被 COPY 进 alpine 的 runner，原生模块（sharp）根本加载不了，
#      只能靠"回退去用前台那份 musl sharp"绕路兜底。同一个 libc 构建就没这问题。
FROM node:24-alpine AS server_builder
ARG VAN_BLOG_NPM_REGISTRY
ENV NODE_OPTIONS=--max_old_space_size=4096
# 强制 sharp 用它自己下载的 libvips，别去链系统的（和 website_builder 一致）
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1
WORKDIR /app
ARG VAN_BLOG_ALPINE_MIRROR
# 换 Alpine 源必须在第一条 apk add **之前**（同 admin/website 两个 stage 的说明）
RUN if [ -n "${VAN_BLOG_ALPINE_MIRROR}" ]; then \
      . /etc/os-release; \
      apk_ver="$(printf '%s' "${VERSION_ID}" | cut -d. -f1,2)"; \
      printf '%s\n%s\n' \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/main" \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/community" \
        > /etc/apk/repositories; \
      echo "使用 Alpine 镜像源: ${VAN_BLOG_ALPINE_MIRROR} (v${apk_ver})"; \
    fi
# 只装 libc6-compat（musl 兼容层，很小）。
# ⚠️ 以前这里还装 python3/make/g++/vips-dev/fftw-dev 好让 sharp 从源码编（218 个 apk 包）：
#    一是 apk 拉 gcc 这种大包在本地构建时反复静默卡死，二是既然 sharp 有 musl 预编译包，
#    就没必要在镜像里现编。真编不了的时候报错也比卡二十分钟强。
RUN apk add --no-cache libc6-compat
# ⚠️ 下面这组 sharp 预编译源的 ARG/ENV 从 **sharp 0.33 起已经不起作用**（现在是 0.35.x）：
#    0.33 之前 sharp 有 install 脚本，会按 npm_config_sharp_binary_host / _libvips_binary_host
#    去下载 libvips 的 tar.gz；0.33 起预编译二进制改成 npm 的 optionalDependencies
#    （@img/sharp-linuxmusl-x64 + @img/sharp-libvips-linuxmusl-x64），装包时不下载、不跑脚本，
#    只认 registry。所以这些 ENV 现在只是**无害的历史遗留**：留着是为了不打断
#    vanblog.sh / build-image-local.sh / docs 里那条已经公开的环境变量链路
#    （VANBLOG_SHARP_DIST_HOST / SHARP_DIST_HOST），真要清理得连脚本、文档、测试一起改。
#    历史背景（#413）：Alpine 上 musl 版本号形如 1.2.4_git20230717，不是合法 semver，
#    0.32 的安装脚本拿它跑 semver.lt 会抛 Invalid Version 把构建搞挂 —— 这条路径随安装脚本一起消失了。
ARG VAN_BLOG_SHARP_DIST_HOST
# sharp 走预编译二进制（含 musl 版），不用在镜像里编译 → 不需要 vips-dev/gcc。
# ⚠️ 必须用 **ENV**，不要指望 npmrc：sharp 的 install/libvips.js 直接读
#    `process.env.npm_config_sharp_libvips_binary_host`（本地翻过它的源码确认），
#    而 pnpm 8 并不会把 .npmrc 里的自定义键转成 npm_config_* 传给 install 脚本 ——
#    实测无论写全局 npmrc（npm config set -g）还是项目 /app/.npmrc，sharp 照样去
#    github.com 下载然后 `Installation error: aborted`。ENV 是进程环境，一定传得到。
ARG VAN_BLOG_SHARP_BINARY_HOST
ARG VAN_BLOG_SHARP_LIBVIPS_HOST
ENV npm_config_sharp_binary_host=${VAN_BLOG_SHARP_BINARY_HOST}
ENV npm_config_sharp_libvips_binary_host=${VAN_BLOG_SHARP_LIBVIPS_HOST}
RUN echo "sharp 预编译源: ${npm_config_sharp_binary_host}" && \
    echo "libvips 预编译源: ${npm_config_sharp_libvips_binary_host}"
# ⚠️ 以前这里是 `COPY ./packages/server/ .` + `pnpm i`：packages/server 底下**没有 lockfile**，
# 于是每次构建都现场解析 `^` 范围 —— mongoose/axios/express/@nestjs 全都可能漂到新版本。
# 后果是镜像不可复现，而且"依赖升级"是在构建时随机发生的（可能意外修好一个漏洞，
# 也可能意外炸掉一个 API）。现在和 admin_builder / website_builder 一样走
# workspace + `--frozen-lockfile`：装的就是仓库里 pnpm-lock.yaml 钉住的那些版本。
COPY ./package.json ./
COPY ./pnpm-lock.yaml ./
COPY ./pnpm-workspace.yaml ./
COPY ./tsconfig.base.json ./
COPY ./patches ./patches
COPY ./packages/server ./packages/server
# tree-sitter 系列（swagger-ui-react 带进来的幽灵传递依赖，源码里没有任何地方 import）
# 在 musl 下用 node-gyp 编译会卡死，这里跳过；不影响运行时。sharp 不在名单里。
RUN printf 'never-built-dependencies[]=tree-sitter\nnever-built-dependencies[]=tree-sitter-json\nnever-built-dependencies[]=tree-sitter-yaml\n' >> /app/.npmrc
ARG VAN_BLOG_NODE_DIST_URL
# 原生模块（tree-sitter / sharp）编译时 node-gyp 要下 Node 头文件；musl 默认走
# unofficial-builds.nodejs.org，国内连不上会让整个 install 失败。设了就用镜像地址。
# ⚠️ 这里以前是 `npm config set disturl "${VAN_BLOG_NODE_DIST_URL}" -g`，而它在 node 24 自带的
#    npm 11 上是**失败**的：`npm error \`disturl\` is not a valid npm option`（这个配置项已被 npm 移除）。
#    更糟的是这条 RUN 的最后一个命令是 echo，退出码取的是 echo 的 ⇒ **失败被吞掉**，
#    日志里照样打印"node-gyp 头文件源: …"，看起来像设置成功了。于是 node-gyp 一直用默认的
#    unofficial-builds.nodejs.org（国内连不上），只是此前没有任何 stage 真的走到 node-gyp：
#    tree-sitter 被 never-built-dependencies 跳过、sharp 用预编译包（它走的是
#    npm_config_sharp_binary_host 这个 **ENV**，所以那条一直是好的）。
#    等 waline 的 better-sqlite3 拿不到预编译包、需要现场编译时，这个洞就炸了
#    （实测：`gyp http GET https://unofficial-builds.nodejs.org/...headers.tar.gz` → FetchError）。
#    现在改成写进 /app/.npmrc：pnpm 会把 npmrc 里的配置以 npm_config_* 环境变量传给生命周期脚本，
#    而 node-gyp 读的正是 npm_config_disturl。并且**校验写入结果**、失败就非 0 退出，
#    不再让末尾的 echo 把错误吞掉（"看起来设置了"比"没设置"更难查）。
RUN if [ -n "${VAN_BLOG_NODE_DIST_URL}" ]; then \
      printf 'disturl=%s\n' "${VAN_BLOG_NODE_DIST_URL}" >> /app/.npmrc && \
      grep -q '^disturl=' /app/.npmrc && \
      echo "node-gyp 头文件源（写入 /app/.npmrc，pnpm 以 npm_config_disturl 传给脚本）: ${VAN_BLOG_NODE_DIST_URL}"; \
    fi
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
RUN pnpm install --frozen-lockfile --filter "@vanblog/server..."
WORKDIR /app/packages/server
RUN pnpm build
# ── 构建产物瘦身：删掉 .d.ts（.map 已由 tsconfig.build.json 关掉 sourceMap，压根不生成）──
# ⚠️ 必须在**这个阶段**删。runner 是 `COPY --from=server_builder /app/packages/server/dist/src/ ./`，
#    如果放到 runner 里"COPY 完再 RUN rm"，**一点体积都省不下来** —— 文件已经在 COPY 那一层里了，
#    后续层只是给它加一个 whiteout 标记，镜像总大小不变。这是 Dockerfile 的经典陷阱。
# ⚠️ 为什么是"生成后删"而不是在 tsconfig 里关掉 declaration：`packages/server/tsconfig.json`
#    有 `"composite": true`，而 TS 规定复合项目不允许关闭 declaration emit（TS6304）。
#    这个错误**只在镜像构建里暴露** —— 本地 `tsc --noEmit` 不产出文件，所以不报。
#    不动 composite（它牵涉整个仓库的项目引用与 jest 编译方式，收益不抵风险）。
# 能删的依据（三条都核过，详见 tsconfig.build.json 的注释）：全仓库没有 --enable-source-maps；
#    CI 的 server-test.yml 不构建 server；没有任何包依赖 @vanblog/server（它也没有 main/types 字段）。
# 下面顺手自检：删完 .js 必须还在、入口 main.js 必须还能找到，否则当场失败，
#    别等到容器起不来才发现（那时已经浪费了整个构建）。
RUN before_dts="$(find dist -name '*.d.ts' | wc -l)" && \
    before_map="$(find dist -name '*.map' | wc -l)" && \
    find dist \( -name '*.d.ts' -o -name '*.map' \) -delete && \
    echo "dist 瘦身：删掉 .d.ts ${before_dts} 个、.map ${before_map} 个（.map 期望是 0，因为 sourceMap 已关）" && \
    test "$(find dist -name '*.js' | wc -l)" -gt 100 && \
    test -n "$(find dist -name 'main.js' | head -1)" && \
    echo "✓ 自检通过：$(find dist -name '*.js' | wc -l) 个 .js 仍在，入口 $(find dist -name 'main.js' | head -1)"
# ⚠️ 别想着用 node-linker=hoisted 把 node_modules 摊平后直接拷给 runner（试过了，两个坑）：
#   1) 扁平布局会让 `types-ramda` 这种**间接**依赖出现在顶层，TypeScript 就能解析到它了 ——
#      而 `types-ramda@0.29.6` 的 .d.ts 用了 **TS 5.0 的 `const` 类型参数**，本仓库是 TS 4.9.5，
#      `nest build` 当场报 24 个 TS1434 语法错误（`skipLibCheck` 救不了：它跳过类型检查，不跳过解析）。
#      默认的符号链接布局下它躺在 `.pnpm/` 里、顶层看不见，TS 解析不到就当 any 放过，所以一直没炸。
#   2) hoisted + --filter 实测装出 **2313 个包 / 2.0GB**，比原来的独立安装（~300MB）大得多，
#      而且 `pnpm prune --prod` 在 workspace 里会弹交互确认（"will be removed and reinstalled
#      from scratch. Proceed?"），非 TTY 构建里它什么也没干就退出了 —— dev 依赖一个没少。
# 正解是 `pnpm deploy`：它就是为"把某个 workspace 包连同**生产依赖**导出成一个自包含目录"设计的。
# 产物 /deploy/node_modules 里的符号链接全部指向**同一棵** .pnpm/（相对路径、自包含），
# 所以 runner 只拷这一份就能跑；实测 175MB、34 个顶层包，typescript/jest/webpack/ts-node 全都不在。
WORKDIR /app
RUN pnpm --filter @vanblog/server deploy --prod /deploy && \
    echo "deploy 产物：$(du -sh /deploy/node_modules | cut -f1)，顶层包 $(ls /deploy/node_modules | wc -l) 个" && \
    for m in typescript jest webpack ts-node @nestjs/cli; do \
      if [ -e /deploy/node_modules/$m ]; then echo "⚠️ dev 依赖没摘干净：$m"; fi; \
    done && \
    for m in @nestjs/core mongoose express axios sharp; do \
      if [ ! -e /deploy/node_modules/$m ]; then echo "✗ 缺运行时依赖：$m"; exit 1; fi; \
    done

# 前台：Alpine + sharp。musl 版本号可能是 1.2.4_git*，sharp 0.31 会报
# Installation error: Invalid Version。用 0.32.6 + 官方 musl prebuild，并装 vips 编译兜底。
FROM node:24-alpine AS website_builder
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
# 去掉 vips-dev/fftw-dev：sharp 用 musl 预编译包（见上面的 sharp_binary_host），
# 不再需要从源码编；保留 python3/make/g++ 给其它可能要编译的原生模块兜底。
RUN apk add --no-cache python3 make g++ libc6-compat
# ⚠️ 下面这组 sharp 预编译源的 ARG/ENV 从 **sharp 0.33 起已经不起作用**（现在是 0.35.x）：
#    0.33 之前 sharp 有 install 脚本，会按 npm_config_sharp_binary_host / _libvips_binary_host
#    去下载 libvips 的 tar.gz；0.33 起预编译二进制改成 npm 的 optionalDependencies
#    （@img/sharp-linuxmusl-x64 + @img/sharp-libvips-linuxmusl-x64），装包时不下载、不跑脚本，
#    只认 registry。所以这些 ENV 现在只是**无害的历史遗留**：留着是为了不打断
#    vanblog.sh / build-image-local.sh / docs 里那条已经公开的环境变量链路
#    （VANBLOG_SHARP_DIST_HOST / SHARP_DIST_HOST），真要清理得连脚本、文档、测试一起改。
#    历史背景（#413）：Alpine 上 musl 版本号形如 1.2.4_git20230717，不是合法 semver，
#    0.32 的安装脚本拿它跑 semver.lt 会抛 Invalid Version 把构建搞挂 —— 这条路径随安装脚本一起消失了。
ARG VAN_BLOG_SHARP_DIST_HOST
# sharp 走预编译二进制（含 musl 版），不用在镜像里编译 → 不需要 vips-dev/gcc。
# ⚠️ 必须用 **ENV**，不要指望 npmrc：sharp 的 install/libvips.js 直接读
#    `process.env.npm_config_sharp_libvips_binary_host`（本地翻过它的源码确认），
#    而 pnpm 8 并不会把 .npmrc 里的自定义键转成 npm_config_* 传给 install 脚本 ——
#    实测无论写全局 npmrc（npm config set -g）还是项目 /app/.npmrc，sharp 照样去
#    github.com 下载然后 `Installation error: aborted`。ENV 是进程环境，一定传得到。
ARG VAN_BLOG_SHARP_BINARY_HOST
ARG VAN_BLOG_SHARP_LIBVIPS_HOST
ENV npm_config_sharp_binary_host=${VAN_BLOG_SHARP_BINARY_HOST}
ENV npm_config_sharp_libvips_binary_host=${VAN_BLOG_SHARP_LIBVIPS_HOST}
RUN echo "sharp 预编译源: ${npm_config_sharp_binary_host}" && \
    echo "libvips 预编译源: ${npm_config_sharp_libvips_binary_host}"
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
# ⚠️ 以前默认值是上游作者的图床域名 pic.mereith.com：那意味着**每个 fork 部署**的
# next/image 优化器都会去别人的域名取图（域名一旦过期被别人注册，就等于让第三方
# 通过你的 /_next/image 提供内容，还白白多一个 SSRF 面）。默认留空 = 只优化本站图片；
# 真要允许远程域名，在编排文件里设 VAN_BLOG_ALLOW_DOMAINS=a.com,b.com。
ENV VAN_BLOG_ALLOW_DOMAINS=""
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
# ⚠️ 这里以前是 `npm config set disturl "${VAN_BLOG_NODE_DIST_URL}" -g`，而它在 node 24 自带的
#    npm 11 上是**失败**的：`npm error \`disturl\` is not a valid npm option`（这个配置项已被 npm 移除）。
#    更糟的是这条 RUN 的最后一个命令是 echo，退出码取的是 echo 的 ⇒ **失败被吞掉**，
#    日志里照样打印"node-gyp 头文件源: …"，看起来像设置成功了。于是 node-gyp 一直用默认的
#    unofficial-builds.nodejs.org（国内连不上），只是此前没有任何 stage 真的走到 node-gyp：
#    tree-sitter 被 never-built-dependencies 跳过、sharp 用预编译包（它走的是
#    npm_config_sharp_binary_host 这个 **ENV**，所以那条一直是好的）。
#    等 waline 的 better-sqlite3 拿不到预编译包、需要现场编译时，这个洞就炸了
#    （实测：`gyp http GET https://unofficial-builds.nodejs.org/...headers.tar.gz` → FetchError）。
#    现在改成写进 /app/.npmrc：pnpm 会把 npmrc 里的配置以 npm_config_* 环境变量传给生命周期脚本，
#    而 node-gyp 读的正是 npm_config_disturl。并且**校验写入结果**、失败就非 0 退出，
#    不再让末尾的 echo 把错误吞掉（"看起来设置了"比"没设置"更难查）。
RUN if [ -n "${VAN_BLOG_NODE_DIST_URL}" ]; then \
      printf 'disturl=%s\n' "${VAN_BLOG_NODE_DIST_URL}" >> /app/.npmrc && \
      grep -q '^disturl=' /app/.npmrc && \
      echo "node-gyp 头文件源（写入 /app/.npmrc，pnpm 以 npm_config_disturl 传给脚本）: ${VAN_BLOG_NODE_DIST_URL}"; \
    fi
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
# 同理：只装 website 及其依赖（sharp 是它自己的依赖，仍然会装上）
# ⚠️ website 的包名是 @vanblog/theme-default（不是 @vanblog/website），过滤名写错会一个包都装不上
# ⚠️ alpine/musl 下这三个原生模块（tree-sitter 系列，来自 @swagger-api/apidom 的传递依赖）
# 用 node-gyp 现场编译时会**卡死**：实测 node-gyp 进程活着、11 个线程全在 sleep、
# 没有任何 make/cc1plus 子进程，十分钟不动，整个 stage 挂住（同样的 Dockerfile 在
# GitHub Actions 的 glibc 宿主 + BuildKit 下能正常编过，所以这是 rootless podman/musl
# 这一侧的问题）。admin 的产物是纯静态文件、website 也不会 import 它们，
# 所以在**这两个 alpine stage 里跳过编译**最省事：用 pnpm 的 never-built-dependencies，
# 只影响镜像构建，不动仓库里的 package.json（本机开发照常编译）。
# 注意 sharp 不在名单里 —— 它靠预编译二进制，跳过 install 脚本反而会坏。
RUN printf 'never-built-dependencies[]=tree-sitter\nnever-built-dependencies[]=tree-sitter-json\nnever-built-dependencies[]=tree-sitter-yaml\n' >> /app/.npmrc
RUN pnpm install --frozen-lockfile --filter "@vanblog/theme-default..."
RUN pnpm build:website


#运行容器
# ── waline 的依赖单独编 ────────────────────────────────────────────────────
# @waline/vercel 依赖 think-model-sqlite → sqlite3@5.1.7，而 sqlite3 5.1.7 **没有
# Node 20（NODE_MODULE_VERSION 115）的预编译包**（node:18 时代是有的，所以以前不用编），
# 于是它会退回 node-gyp 现场编译 —— 需要 python3/make/g++。
# 放在独立的构建阶段里编，编完只把 node_modules 拷进 runner：
# 最终镜像里不会留下编译器（体积、攻击面都更小），这一层也容易被缓存复用。
FROM node:24-alpine AS waline_builder
ARG VAN_BLOG_NPM_REGISTRY
ARG VAN_BLOG_ALPINE_MIRROR
# 换 Alpine 源必须在第一条 apk add **之前**（同其它 stage 的说明）
RUN if [ -n "${VAN_BLOG_ALPINE_MIRROR}" ]; then \
      . /etc/os-release; \
      apk_ver="$(printf '%s' "${VERSION_ID}" | cut -d. -f1,2)"; \
      printf '%s\n%s\n' \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/main" \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/community" \
        > /etc/apk/repositories; \
      echo "使用 Alpine 镜像源: ${VAN_BLOG_ALPINE_MIRROR} (v${apk_ver})"; \
    fi
# ⚠️ 必须带 py3-setuptools：@waline/vercel 硬依赖 better-sqlite3，而它在 musl 上没有预编译包
#    （只有 glibc 的 linux-x64），所以每次都要现场 node-gyp 编译。Alpine 3.20+ 自带的是
#    Python 3.12，**distutils 已被移除**，而 corepack 里 pnpm 8 带的 node-gyp 9.4.1 仍然
#    `from distutils.version import StrictVersion` ⇒ 编译必挂（ModuleNotFoundError: distutils），
#    整个 stage 的 `pnpm i` 直接 exit 1。setuptools 会把 distutils 补回来。
RUN apk add --no-cache python3 py3-setuptools make g++
# ⚠️ 这一层以前是 `WORKDIR /app/waline` + `COPY ./packages/waline/ ./` + `pnpm i`：
#    一个**孤立目录**里现场解析依赖，构建上下文里既没有 pnpm-lock.yaml 也没有根 package.json。
#    两个后果（第二个更要紧）：
#      1) 不可复现 —— 同一个 commit 两次构建可能装到不同版本；
#      2) **根 package.json 的 `pnpm.overrides` 完全不生效**。overrides 是通过根 manifest +
#         lockfile 起作用的，孤立安装两个都看不到 ⇒ 就算仓库里把 mysql2 / tar-fs / axios 这些
#         （waline 子树里有 critical/high 通告的包）用 override 抬到安全版本，
#         **镜像里 /app/waline/node_modules 装的仍然是旧的**。而这份 node_modules 会被原样
#         拷进 runner 并作为子进程运行。
#    现在和 admin/server/website 三层一样走 workspace + `--frozen-lockfile`，再用 `pnpm deploy`
#    导出自包含产物（见 server_builder 里那段关于为什么不用 node-linker=hoisted 的说明）。
# ⚠️ 这一层**不能**加 `--ignore-scripts`：@waline/vercel 硬依赖 sqlite3/better-sqlite3，
#    musl 上没有预编译包，必须现场 node-gyp 编译（这就是上面装 python3/py3-setuptools/make/g++ 的原因）。
WORKDIR /app
COPY ./package.json ./
COPY ./pnpm-lock.yaml ./
COPY ./pnpm-workspace.yaml ./
COPY ./tsconfig.base.json ./
COPY ./patches ./patches
COPY ./packages/waline ./packages/waline
ARG VAN_BLOG_NODE_DIST_URL
# sqlite3 现场编译同样要下 Node 头文件（musl 默认走 unofficial-builds，国内连不上）
# ⚠️ 这里以前是 `npm config set disturl "${VAN_BLOG_NODE_DIST_URL}" -g`，而它在 node 24 自带的
#    npm 11 上是**失败**的：`npm error \`disturl\` is not a valid npm option`（这个配置项已被 npm 移除）。
#    更糟的是这条 RUN 的最后一个命令是 echo，退出码取的是 echo 的 ⇒ **失败被吞掉**，
#    日志里照样打印"node-gyp 头文件源: …"，看起来像设置成功了。于是 node-gyp 一直用默认的
#    unofficial-builds.nodejs.org（国内连不上），只是此前没有任何 stage 真的走到 node-gyp：
#    tree-sitter 被 never-built-dependencies 跳过、sharp 用预编译包（它走的是
#    npm_config_sharp_binary_host 这个 **ENV**，所以那条一直是好的）。
#    等 waline 的 better-sqlite3 拿不到预编译包、需要现场编译时，这个洞就炸了
#    （实测：`gyp http GET https://unofficial-builds.nodejs.org/...headers.tar.gz` → FetchError）。
#    现在改成写进 /app/.npmrc：pnpm 会把 npmrc 里的配置以 npm_config_* 环境变量传给生命周期脚本，
#    而 node-gyp 读的正是 npm_config_disturl。并且**校验写入结果**、失败就非 0 退出，
#    不再让末尾的 echo 把错误吞掉（"看起来设置了"比"没设置"更难查）。
RUN if [ -n "${VAN_BLOG_NODE_DIST_URL}" ]; then \
      printf 'disturl=%s\n' "${VAN_BLOG_NODE_DIST_URL}" >> /app/.npmrc && \
      grep -q '^disturl=' /app/.npmrc && \
      echo "node-gyp 头文件源（写入 /app/.npmrc，pnpm 以 npm_config_disturl 传给脚本）: ${VAN_BLOG_NODE_DIST_URL}"; \
    fi
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
RUN pnpm install --frozen-lockfile --filter "@vanblog/waline..."
# deploy 产物的 node_modules 是自包含的（符号链接都指向同一棵 .pnpm/），runner 只拷这一份就能跑。
# 顺手验证两件事：@waline/vercel 在，且 sqlite3 的原生 .node 真的编出来了
# （编不出来的话 waline 子进程会在启动时才炸，那时已经浪费了整个构建）。
RUN pnpm --filter @vanblog/waline deploy --prod /deploy && \
    echo "waline deploy 产物：$(du -sh /deploy/node_modules | cut -f1)" && \
    test -e /deploy/node_modules/@waline/vercel/vanilla.js && \
    echo "✓ @waline/vercel/vanilla.js 在（server 按 ../waline/node_modules/@waline/vercel/vanilla.js 找它）" && \
    NATIVE="$(find /deploy/node_modules -name '*.node' | head -5)" && \
    if [ -z "${NATIVE}" ]; then echo "✗ 没有任何原生 .node 产物：sqlite3 没编出来"; exit 1; fi && \
    printf '%s\n' "${NATIVE}" | sed 's/^/  native: /'

# cli：镜像内的运维小工具（resetHttps.js）。以前是 runner 里 `WORKDIR /app/cli` + `pnpm i`，
# 同样是孤立安装、同样看不到 lockfile 与 overrides（它只有一个依赖 mongodb ^5.9.1，
# `^` 意味着构建当天解析到什么就是什么）。挪到独立 stage 走 workspace + frozen lockfile，
# 并且**可以**加 `--ignore-scripts`：mongodb 驱动是纯 JS，没有 install 脚本要跑，
# 关掉脚本等于把"依赖被投毒时在构建期以 root 执行 postinstall"这条路一起关掉。
FROM node:24-alpine AS cli_builder
ARG VAN_BLOG_NPM_REGISTRY
ARG VAN_BLOG_ALPINE_MIRROR
# 换 Alpine 源必须在第一条 apk add **之前**（同其它 stage 的说明）
RUN if [ -n "${VAN_BLOG_ALPINE_MIRROR}" ]; then \
      . /etc/os-release; \
      apk_ver="$(printf '%s' "${VERSION_ID}" | cut -d. -f1,2)"; \
      printf '%s\n%s\n' \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/main" \
        "${VAN_BLOG_ALPINE_MIRROR}/v${apk_ver}/community" \
        > /etc/apk/repositories; \
      echo "使用 Alpine 镜像源: ${VAN_BLOG_ALPINE_MIRROR} (v${apk_ver})"; \
    fi
WORKDIR /app
COPY ./package.json ./
COPY ./pnpm-lock.yaml ./
COPY ./pnpm-workspace.yaml ./
COPY ./tsconfig.base.json ./
COPY ./patches ./patches
COPY ./packages/cli ./packages/cli
ARG VAN_BLOG_NODE_DIST_URL
# ⚠️ cli 目前只有一个纯 JS 依赖（mongodb 驱动），而且下面用了 --ignore-scripts，
#    所以**今天**根本不会触发 node-gyp、这个 disturl 用不上。仍然照着其它 stage 写上，理由有二：
#      1) dockerfile-patches.test.sh 有一条通用不变量："每个 node stage 都必须先设 disturl 再
#         pnpm install"。为 cli 开一个例外就要给守卫加白名单，而白名单正是这类检查开始腐烂的方式；
#      2) 哪天 cli 多了一个原生依赖、或有人把 --ignore-scripts 去掉，musl 下 node-gyp 默认去连
#         unofficial-builds.nodejs.org（国内连不上 ⇒ 整个 stage 挂住），那时这里的配置已经就位。
# ⚠️ 这里以前是 `npm config set disturl "${VAN_BLOG_NODE_DIST_URL}" -g`，而它在 node 24 自带的
#    npm 11 上是**失败**的：`npm error \`disturl\` is not a valid npm option`（这个配置项已被 npm 移除）。
#    更糟的是这条 RUN 的最后一个命令是 echo，退出码取的是 echo 的 ⇒ **失败被吞掉**，
#    日志里照样打印"node-gyp 头文件源: …"，看起来像设置成功了。于是 node-gyp 一直用默认的
#    unofficial-builds.nodejs.org（国内连不上），只是此前没有任何 stage 真的走到 node-gyp：
#    tree-sitter 被 never-built-dependencies 跳过、sharp 用预编译包（它走的是
#    npm_config_sharp_binary_host 这个 **ENV**，所以那条一直是好的）。
#    等 waline 的 better-sqlite3 拿不到预编译包、需要现场编译时，这个洞就炸了
#    （实测：`gyp http GET https://unofficial-builds.nodejs.org/...headers.tar.gz` → FetchError）。
#    现在改成写进 /app/.npmrc：pnpm 会把 npmrc 里的配置以 npm_config_* 环境变量传给生命周期脚本，
#    而 node-gyp 读的正是 npm_config_disturl。并且**校验写入结果**、失败就非 0 退出，
#    不再让末尾的 echo 把错误吞掉（"看起来设置了"比"没设置"更难查）。
RUN if [ -n "${VAN_BLOG_NODE_DIST_URL}" ]; then \
      printf 'disturl=%s\n' "${VAN_BLOG_NODE_DIST_URL}" >> /app/.npmrc && \
      grep -q '^disturl=' /app/.npmrc && \
      echo "node-gyp 头文件源（写入 /app/.npmrc，pnpm 以 npm_config_disturl 传给脚本）: ${VAN_BLOG_NODE_DIST_URL}"; \
    fi
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
RUN pnpm install --frozen-lockfile --filter "vanblog-cli..." --ignore-scripts
RUN pnpm --filter vanblog-cli deploy --prod /deploy && \
    echo "cli deploy 产物：$(du -sh /deploy/node_modules | cut -f1)" && \
    test -e /deploy/node_modules/mongodb && \
    echo "✓ mongodb 驱动在（resetHttps.js 要 require 它）"

FROM node:24-alpine AS runner
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
# fontconfig / ttf-dejavu / wqy-zenhei：**可见水印**要的。
#   水印文字是 SVG <text>，由 sharp 内置的 libvips → librsvg → pango → fontconfig 栅格化，
#   所以它要的是**系统字体**，不是 npm 包、也不是前台自托管的那份 woff2（那份只给浏览器用）。
#   ⚠️ 缺字体不是"渲染成空白"：实测 node:24-alpine 零字体时 librsvg 会画**满屏 .notdef 豆腐块**
#   （'Ag…' 576 ink px、'水' 180 ink px），stderr 只有一句 Fontconfig error 就"成功"返回 ——
#   所以 `utils/watermark.ts` 是**逐字符集探测**（`Ag` / `水` 与私用区 U+E001 逐字节对比），
#   探测不过就 WARN + 返回原图（宁可不盖，也不盖一张豆腐块图）。
#   后果很直接：**镜像里没有这三个包 ⇒ 可见水印这个功能在生产环境等于不存在**（上传不失败，但一张都盖不上）。
#   ttf-dejavu 管 Latin，wqy-zenhei 管中文（字体栈里 `Noto Sans CJK SC` 优先，但 font-noto-cjk
#   体积是它的十几倍，为一个水印字段不值；装了 wqy-zenhei 后 fontconfig 会自动回落到它）。
# ⚠️ 这里以前还装着 `nss-tools`（提供 certutil），全仓库没有任何地方调用 certutil/pk12util，
#    而且实测 `apk info -R caddy` 显示 caddy 只依赖 `ca-certificates` / `/bin/sh` / `so:libc.musl`，
#    `apk info -r nss-tools` 也是"没有任何包依赖它"⇒ 纯属白装的 688 KiB + 攻击面，已删。
#    要临时排查证书问题，用 `docker run --entrypoint sh … apk add nss-tools` 现装即可。
RUN  apk add --no-cache --update tzdata caddy libwebp-tools libavif-apps libc6-compat zstd xz \
  fontconfig ttf-dejavu wqy-zenhei \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo "Asia/Shanghai" > /etc/timezone \
  && apk del tzdata
ARG VAN_BLOG_NODE_DIST_URL
# ⚠️ runner 里仍然要留着 corepack/pnpm 与头文件源，但**不再用于构建期安装**：
#    cli 与 waline 的依赖现在都来自各自的 builder stage（走 lockfile，见上面两段说明）。
#    留在这里是因为**运行期**「流水线」功能会执行 `pnpm add` 往 codeRunner/pluginRunner 装依赖
#    （provider/pipeline），那时可能需要 node-gyp 编译原生模块 ⇒ 头文件源仍然有用。
# ⚠️ 这里以前是 `npm config set disturl "${VAN_BLOG_NODE_DIST_URL}" -g`，而它在 node 24 自带的
#    npm 11 上是**失败**的：`npm error \`disturl\` is not a valid npm option`（这个配置项已被 npm 移除）。
#    更糟的是这条 RUN 的最后一个命令是 echo，退出码取的是 echo 的 ⇒ **失败被吞掉**，
#    日志里照样打印"node-gyp 头文件源: …"，看起来像设置成功了。于是 node-gyp 一直用默认的
#    unofficial-builds.nodejs.org（国内连不上），只是此前没有任何 stage 真的走到 node-gyp：
#    tree-sitter 被 never-built-dependencies 跳过、sharp 用预编译包（它走的是
#    npm_config_sharp_binary_host 这个 **ENV**，所以那条一直是好的）。
#    等 waline 的 better-sqlite3 拿不到预编译包、需要现场编译时，这个洞就炸了
#    （实测：`gyp http GET https://unofficial-builds.nodejs.org/...headers.tar.gz` → FetchError）。
#    现在改成写进 /app/.npmrc：pnpm 会把 npmrc 里的配置以 npm_config_* 环境变量传给生命周期脚本，
#    而 node-gyp 读的正是 npm_config_disturl。并且**校验写入结果**、失败就非 0 退出，
#    不再让末尾的 echo 把错误吞掉（"看起来设置了"比"没设置"更难查）。
RUN if [ -n "${VAN_BLOG_NODE_DIST_URL}" ]; then \
      printf 'disturl=%s\n' "${VAN_BLOG_NODE_DIST_URL}" >> /app/.npmrc && \
      grep -q '^disturl=' /app/.npmrc && \
      echo "node-gyp 头文件源（写入 /app/.npmrc，pnpm 以 npm_config_disturl 传给脚本）: ${VAN_BLOG_NODE_DIST_URL}"; \
    fi
RUN corepack enable
RUN corepack prepare pnpm@8.11.0 --activate
RUN pnpm config set network-timeout 600000 -g
RUN pnpm config set registry ${VAN_BLOG_NPM_REGISTRY} -g
RUN pnpm config set fetch-retries 20 -g
RUN pnpm config set fetch-timeout 600000 -g
# 复制 cli 工具（依赖来自 cli_builder 的 frozen-lockfile + deploy 产物，不再在镜像里现场 pnpm i）
# ⚠️ 落点必须仍然是 /app/cli/resetHttps.js：scripts/vanblog.sh 的 reset_https 第 4 级兜底
#    和 packages/cli/README.md、docs/faq/usage.md 都是按这个绝对路径调它的。
WORKDIR /app/cli
COPY ./packages/cli/ ./
COPY --from=cli_builder /deploy/node_modules ./node_modules
# waline：依赖在 waline_builder 阶段按 lockfile 装好并编好了（sqlite3 需要编译器，别塞进最终镜像），
# 这里只拷 package.json 与 deploy 出来的自包含 node_modules
WORKDIR /app/waline
COPY ./packages/waline/package.json ./
COPY --from=waline_builder /deploy/node_modules ./node_modules
# 复制 server
WORKDIR /app/server
# node_modules 来自 `pnpm deploy --prod` 的自包含产物（只有生产依赖，175MB 而不是 2.0GB）
COPY --from=server_builder /deploy/node_modules ./node_modules
COPY --from=server_builder /app/packages/server/dist/src/ ./
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
# ⚠️ 以前默认值是上游作者的图床域名 pic.mereith.com：那意味着**每个 fork 部署**的
# next/image 优化器都会去别人的域名取图（域名一旦过期被别人注册，就等于让第三方
# 通过你的 /_next/image 提供内容，还白白多一个 SSRF 面）。默认留空 = 只优化本站图片；
# 真要允许远程域名，在编排文件里设 VAN_BLOG_ALLOW_DOMAINS=a.com,b.com。
ENV VAN_BLOG_ALLOW_DOMAINS=""
# libuv 线程池：sharp 的图片解码/编码、fs 的异步操作、crypto 的 scrypt/pbkdf2 都跑在这个池子里，
# 而 Node 的默认大小是 **4**。图片站一并发上传/补缩略图时，4 个线程就是硬瓶颈
# （表现是"CPU 明明很闲，图片处理却在排队"）。16 是个稳妥的默认：吃得下并发图片处理，
# 又不至于在小机器上把内存和上下文切换打爆；要调就在编排文件里覆盖。
# ⚠️ 必须设在**进程启动前**（ENV / 容器环境变量），运行时改无效 —— libuv 只在初始化时读一次。
# ⚠️ 这个 ENV 必须放在 **runner** 阶段：放在 website_builder 里对最终镜像毫无作用
#    （第一版就放错了 stage，容器里 `echo $UV_THREADPOOL_SIZE` 是空的才发现）。
ENV UV_THREADPOOL_SIZE=16
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
# 生成 caddy 配置的小工具：on-demand TLS 在 Caddy 2.11 换了写法（ask → permission），
# 由它按 caddy 自己的 validate 结果挑形式，避免 apk 的 caddy 版本漂移把 HTTPS 弄坏。
COPY ./scripts/caddyConfig.js /app/caddyConfig.js
# 复制入口文件
WORKDIR /app
COPY ./scripts/start.js ./
COPY ./entrypoint.sh ./
ENV PORT=3001
# 增加版本
ARG VAN_BLOG_VERSIONS
ENV VAN_BLOG_VERSION=${VAN_BLOG_VERSIONS}
# ⚠️ 显式写 OCI 版本标签，别让它由 CI 的 metadata-action 用"第一个标签"去猜。
#    实测已发布的 v2026.9.2：config blob 里 `revision` 是对的，而
#    `org.opencontainers.image.version` 字面就是 **latest**（因为 publish-ghcr 的 type=raw 列表里
#    latest 排第一，metadata-action 默认拿第一个标签当 version）。后果：任何按 image.version
#    判断"我装的是哪个版本"的工具都读到 latest —— 包括我们自己文档里教的比版本方法。
#    这里用与镜像内 ENV VAN_BLOG_VERSION **完全相同**的值（同一个 build-arg），
#    所以本地构建（build-image-local.sh 也传这个 arg）与 CI 构建口径一致。
#    CI 侧还会用 metadata-action 的 labels 覆写一次（同值），两边不会打架。
LABEL org.opencontainers.image.version="${VAN_BLOG_VERSIONS}"
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
  CMD node -e "require('http').get({host:'127.0.0.1',port:80,path:'/api/public/health',timeout:8000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1)).on('timeout',function(){this.destroy();process.exit(1)})" || exit 1
ENTRYPOINT [ "sh","entrypoint.sh" ]
# CMD [ "entrypoint.sh" ]
