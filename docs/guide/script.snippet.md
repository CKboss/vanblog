你可以运行下方命令，通过脚本一键部署 VanBlog（本分支 `CKboss/vanblog` 的 `dev/dsh`）。

```bash
curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh && ./vanblog.sh
```

想用**发布版**而不是开发分支（更稳，且不受 raw 的分支缓存影响）：

```bash
curl -L https://github.com/CKboss/vanblog/releases/download/v2026.9.2/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh && ./vanblog.sh
```

::: warning raw 地址有几分钟的 CDN 缓存

`raw.githubusercontent.com` 对**分支**地址（`dev/dsh`）有 CDN 缓存：刚推完就装，拿到的可能是
上一版脚本。要确定拿到哪个版本，就用上面的 Release 附件地址（每个发布版的附件里都有
`vanblog.sh` 与 `docker-compose-template.yml`），或把 URL 里的 `dev/dsh` 换成具体 commit sha。

:::

::: info 也可以用文档站的地址

`curl -L https://vanblog.mereith.com/vanblog.sh -o vanblog.sh` 下载到的是**上游作者的脚本**：
它会装官方镜像 `mereith/van-blog:latest`，不含本分支的任何改动（整站备份/恢复、SEO、
封面回填、镜像里的十几处部署修复……）。要用本分支，就用上面那条 GitHub 地址。

:::

脚本下载编排模板（以及更新脚本自身）时按「**fork 优先**」的顺序尝试：**本分支 GitHub raw →
本分支 jsDelivr（`gh/CKboss/vanblog@dev/dsh`）→ 本分支 GitHub Release 附件 → 上游文档站 →
上游 GitHub raw → 上游 jsDelivr**，任一成功即继续并打印实际用的 URL。前三个 fork 源都排在
上游之前：raw.githubusercontent.com 在部分网络（尤其中国大陆）经常不通，以前的顺序会在那里
**静默退到上游**，装出来的就是不含本分支任何加固的官方产物。⚠️ 如果最后落到上游那三个兜底源，
拿到的是上游模板（mongo 写死 4.4.16、没有日志上限、没有 healthcheck / `depends_on`），
脚本会提示一句"模板里没有 mongo 占位符"，功能仍可用，但建议排查网络后重跑 `config`。
详见 [部署常见问题](../faq/deploy.md#一键脚本下载编排文件失败)。

## 装的是什么

| 项 | 默认值 | 怎么改 |
| --- | --- | --- |
| 安装模式 | `auto`：先拉镜像，拉不到再 clone 源码本地构建 | `VANBLOG_INSTALL_MODE=image\|source\|auto` |
| 镜像 | `ghcr.io/ckboss/vanblog:latest`（最近一次发布构建） | `./vanblog.sh update <发布号>` 钉版本，或 `VANBLOG_IMAGE_REF=...`（也可指向本地 tag / 镜像加速地址） |
| MongoDB | 全新安装用 `mongo:7.0`；**已有数据目录时保持你现在的版本不变** | `VANBLOG_MONGO_IMAGE=mongo:4.4.16`（老机器 CPU 不支持 avx 时用这个） |
| 数据目录 | `/var/vanblog` | 安装时交互输入，或 `VANBLOG_DATA_PATH` / `VANBLOG_BASE_PATH` |
| 端口 | 安装时交互输入（HTTP/HTTPS） | 之后用 `./vanblog.sh config` 改 |

镜像由 GitHub Actions（`publish-ghcr`）构建发布，仓库是 `ghcr.io/ckboss/vanblog`，可用标签
（⚠️ 往分支 push **不会**自动构建镜像：只有"手动触发的分支构建"和"打 `v*` 标签发版"会推）：

| 标签 | 指向 | 什么时候用 |
| --- | --- | --- |
| `v2026.9.2` 等**发布号** | 对应 tag 的发版构建，**永远不变** | ✅ **推荐**：`./vanblog.sh update v2026.9.2` |
| `latest`（脚本默认） | 最近一次发布构建（会被下次发版/手动分支构建挪走） | 不想每次写版本号时可用 |
| `dev-dsh` | 最近一次**手动触发**的分支构建（push 不触发，所以可能比发布版旧） | 明确想试还没发版的改动 |
| `dev-dsh-<短sha>` | 每次分支构建额外打的按提交号标签 | **回滚 / 钉死某一次构建**用这个 |

升级时怎么选标签、怎么把版本钉住、怎么回滚，见 [升级](./update.md#升到指定发布版-一行命令)。

本项目的 ghcr 包**是 public 的**，可以匿名 `docker pull`（实测匿名取 manifest 返回 200）。
真的报 `denied` / `not found` 通常是三种情况：标签名打错（发布号长这样 `v2026.9.2`，区分大小写）、
服务器连不上 ghcr（换网络，或配好镜像加速后用
`VANBLOG_IMAGE_REF=<加速地址>/ckboss/vanblog:latest ./vanblog.sh`），或者包被改回了 private
（维护者去 <https://github.com/CKboss/vanblog/pkgs/container/vanblog> → Package settings →
Change visibility 改回 Public）。

## 源码构建（拉不到镜像时）

`auto` 模式会自动退回源码构建，也可以直接指定：

```bash
VANBLOG_INSTALL_MODE=source ./vanblog.sh
```

构建要 15-40 分钟、比较吃内存，脚本会按**实测的 CPU 与可用内存**自动选档位（admin 的 webpack 堆：
可用内存 <3.5GB 用 1536MB，否则 4096MB；资源够才并行构建三个前端；可用内存 <1.8GB 直接劝退，
`VANBLOG_FORCE_BUILD=true` 可以强行继续），并自动探测最快的源：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `VANBLOG_NPM_REGISTRY` | pnpm 源 | 空 = 实测 `npmmirror` 与 `npmjs` 延迟后取快的 |
| `VANBLOG_ALPINE_MIRROR` | 容器内 Alpine 软件源 | 空 = 实测 aliyun / tuna / 官方后取快的（`none` 强制官方） |
| `VANBLOG_NODE_DIST_URL` | node-gyp 的 Node 头文件源 | 空 = 用 npmmirror 时自动配 `cdn.npmmirror.com/binaries/node` |
| `VANBLOG_SHARP_DIST_HOST` | sharp / libvips 预编译包源 | 空 = 用 npmmirror 时自动配 `registry.npmmirror.com/-/binary`（`none` 用官方 GitHub） |
| `VAN_BLOG_ADMIN_BUILD_SCRIPT` | admin 构建档位 | `build`（4096MB）/ `build:lowmem`（1536MB） |
| `VANBLOG_BUILD_PARALLEL` | 是否并行构建三个前端 | 内存够才并行 |

这几个源都是可选的：海外机器什么都不设也行（默认走官方源，更快）。

## 装完之后

启动完毕请 [完成初始化](./init.md)。之后常用命令：

```bash
./vanblog.sh              # 交互菜单
./vanblog.sh install      # 安装/重装（也可以直接用交互菜单选 1）
./vanblog.sh status       # 状态
./vanblog.sh log          # 日志
./vanblog.sh backup       # 整站备份（一致性快照，见下；导出前有磁盘空间预检）
./vanblog.sh verify       # 校验备份归档（完整性 + sha256 + 内容清单，不解压落盘）
./vanblog.sh backup-verify # 备份 + 立刻深度校验 + 陈旧检查 + 台账（适合放 cron）
./vanblog.sh drill        # 恢复演练：在一次性栈上真恢复一遍并断言语义
./vanblog.sh restore      # 从整站备份恢复
./vanblog.sh reset        # 换新机器：自动初始化 + 恢复整站备份 + 重启 + 核对（一条命令）
./vanblog.sh install-cron # 定时备份：每天一次写进 root 的 crontab（幂等；--remove 移除）
./vanblog.sh update       # 升级（先把新镜像准备好，再停容器）；不带参数 = 默认的 latest 标签
./vanblog.sh update v2026.9.2   # ✅ 升到**指定发布版**（推荐：发布号永远不变）
./vanblog.sh --help       # 全部命令
```

⚠️ 上面两行的区别很重要：**不带版本号的 `update` 用的是默认标签 `latest`**（最近一次发布构建，
会随下次发版移动）；带发布号才是钉死不动的版本。参数打错会直接拒绝（退出码 2），不会静默按默认升级。
标签阶梯、"钉住的版本会写进编排文件"、降级时的 WARN 与回滚写法，见
[升级](./update.md#升到指定发布版-一行命令)。

`drill` / `verify-deep` / `backup-verify` / `backup-status` 这四条**不受脚本的 root 检查拦截**
（它们在检查之前就转交给 `scripts/vanblog-drill.sh` 执行）：「校验/演练一份自己拥有的归档」
是只读操作，不该要求 root —— 而且 root 跑 podman 看到的是另一套镜像存储，演练反而跑不了。
其中 `backup-verify` 因为要真的做一次备份，备份动作本身仍需要相应权限。
这四条的详情见 [导入导出 → 相关的四个子命令](../advanced/backup.md#相关的四个子命令)。

::: tip 从旧机器的整站备份直接装起

```bash
# 装完顺手把整站备份恢复上去，不用再进后台走向导
VANBLOG_RESTORE_FROM=/path/to/vanblog-full-xxx.tar.zst ./vanblog.sh install
# 或者装完之后单独跑
./vanblog.sh reset /path/to/vanblog-full-xxx.tar.zst
```

`reset` 会自动处理"没初始化就没法登录、没法登录就没法恢复"这个死结：站点是全新的时候，
它用一个随机口令的临时账号完成初始化，恢复成功后那个账号就被备份里的真实账号覆盖了。
详见 [备份与迁移 → 换新机器](./backup.md#换新机器一条命令把整站搬过去)。

:::

数据都在安装目录里（默认 `/var/vanblog`）：`data/static` 图床与附件、`data/mongo` 数据库、
`log` 日志（**整站备份归档也在 `log/vanblog-backups/`**，旁边可能有两个附属文件：
`.manifest.json` 清单是 **server 导出时**写的、`.sha256` 校验和是**用脚本备份时**写的，
拷归档去别处时把 `.sha256` 一起带上；`install-cron` 的备份日志是 `log/vanblog-backup-cron.log`）、`caddy/` 证书与配置、
`docker-compose.yaml` 编排文件、`vanblog-cron.env`（`install-cron` 写的定时备份 token，0600）。
备份/恢复/定时备份见 [备份与迁移](./backup.md)。

![脚本演示](https://pic.mereith.com/img/74047a8387a2d2ba4e3e7cefca67815f.clipboard-2023-06-27.webp)

::: tip

1. 只推荐在纯 Linux 环境下使用此脚本，宝塔面板也可以用。脚本需要 root（会检查 `id -u`；
   上面说的 `drill` / `verify-deep` / `backup-verify` / `backup-status` 四条除外）。
1. ⚠️ 机器上没有 docker 时，脚本会把**上游作者主机**的 `docker.sh` 用 root 管道进 bash 执行
   （`bash <(curl …)`，上游遗留行为）；不放心就先自己装好 docker 再跑脚本，见
   [部署常见问题](../faq/deploy.md#如何安装-docker)。
1. 如果你想在外部访问数据库，请参考 [部署常见问题 → 如何从外部访问数据库](../faq/deploy.md#如何在外部访问数据库)（**注意不要用 `down -v`**）。
1. 反代时只需要反代映射的 HTTP 端口，详见 [反代配置](../reference/reverse-proxy.md)。由于 VanBlog 是一个整体，无需考虑内部的 Caddy。
1. 想在本机构建并冒烟测试镜像（不发布、不装到生产），用 `./scripts/build-image-local.sh`，
   见 [本地构建镜像](../advanced/local-build.md)。

:::
