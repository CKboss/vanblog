::: tip 容器化的优点

VanBlog 的定位是简洁实用的，尽可能的减少复杂的配置。

VanBlog 内部由很多微服务组成，直接部署到裸机环境可能会由于硬件、系统版本不同、软件不同而出现很多意料之外的问题，容器化可以提供很好的隔离环境，避免因这些差异导致的问题。

使用容器部署 VanBlog 学习成本小，迁移和升级都非常方便，与一键部署近乎没区别。（容器化真的是很好的技术，我很推荐大家都去学习一下）

:::

::: warning 自行部署须知

裸机部署需要的知识储备以及常见问题（不同的 node 版本、端口被占用、不同的系统、部署路径的影响等等）可能远大于简单的学习 `docker-compose up -d` 这一个指令。

裸机部署需要的时间远远大于你起一个容器的时间，如果你执意要裸机部署，请继续往下看。裸机部署遇到的问题，请自行百度。

:::

### 环境要求

| 项目         | 要求  | 备注                                                              |
| ------------ | ----- | ----------------------------------------------------------------- |
| Nodejs       | >=24  | 与镜像基线一致（Dockerfile 全部 stage 基于 `node:24-alpine`），可用 nvm 管理 |
| pnpm         | v8    | pnpm 包管理器，其他管理器不能识别 pnpm-lock.yaml 可能导致问题     |
| 操作系统     | Linux | 主流 linux 发行版即可                                             |
| MongoDB      | 4.4–7.0 | 本项目按 `mongo:7.0` 实测；老机器 CPU 不支持 avx 时只能用 4.4。数据目录与大版本绑定，不要随手升级 |
| Caddy        | v2    | Caddy v2 反代各个微服务，其他的反代理论上可以，但是需要自己写配置 |
| 系统字体     | fontconfig + 一款 Latin 字体 + 一款中文字体 | **只影响可见水印**：水印文字是 SVG，要靠系统字体栅格化。Debian/Ubuntu：`apt-get install fontconfig fonts-dejavu fonts-wqy-zenhei`；Alpine：`apk add fontconfig ttf-dejavu wqy-zenhei`。不装的话上传不会失败，但水印会被跳过（日志里一条 WARN） |
| 后台运行程序 | -     | 可以让服务后台运行,比如 systemd、tmux 等                          |

### 部署

因为最近更新比较快，单独部署的老版文档已经不再合适，对于有能力的同学，直接参考 `Dockerfile` 即可
（五阶段构建：`admin_builder` / `server_builder` / `website_builder` / `waline_builder` / `runner`，
全部基于 `node:24-alpine`，产物约 890MB —— 其中约 32MB 是 v2026.9.2 起装进镜像的系统字体，
可见水印（含中文）靠它）。用官方 Dockerfile 自建镜像时，
前台 Alpine 阶段已包含 sharp / libvips 所需依赖，sharp 版本以 `packages/server/package.json`
（当前 `^0.35`）与 lockfile 为准；请保持 `--frozen-lockfile`。

::: tip 不想自己拼裸机环境

`Dockerfile` 的 runner 阶段就是"一份能跑的最小系统清单"（装了哪些 apk 包、哪些目录要有、
入口是 `entrypoint.sh` —— 它先生成 caddy 配置，再 `exec node start.js`，也就是仓库里的
`scripts/start.js`）。照着它 `apk add` / `apt-get install` 一遍，比自己踩坑快得多。
想先在本地把镜像构建出来验证一遍，见 [本地构建与验证镜像](../advanced/local-build.md)。

:::
