---
title: 命令速查表（安装 / 更新 / 备份 / 恢复）
icon: terminal
order: 1.5
---

这一页只放**能直接复制的命令**：装一个新的、升级到指定版本、备份、验证备份、恢复、回滚、出事先看哪三条。
不讲原理，每条都写清「看到什么算成功」；想深入了解就点表格下面的链接。

<!-- more -->

::: tip 开始之前，先记住三件事

1. **所有命令都在服务器上跑**，用 root（或者每条前面加 `sudo`）。在哪个目录敲都行。
2. **动手之前先备份**（下面第 3 节），备份完最好再验一次它真能恢复（第 4 节）。
3. 下面的 `./vanblog.sh` 指你下载的那个一键脚本。如果它不在当前目录，就写完整路径，
   例如 `/var/vanblog/vanblog.sh status`。

:::

## 0. 你需要准备什么

| 东西 | 说明 |
| --- | --- |
| 一台 Linux 服务器 | 能上网就行，1 核 1G 也够（默认是**下载现成镜像**，不在你机器上编译） |
| root 或 sudo 权限 | 脚本要写 `/var/vanblog`、要管容器 |
| Docker | **没装也能装**：脚本发现没有 docker 时会**直接装**（不打断问你），装完继续。⚠️ 它是用 root 把 `get.docker.com`（国内线路是 `vanblog.mereith.com/docker.sh`）的脚本管道进 bash 执行的；不放心就先自己装好 docker 再跑脚本 |
| 域名（可选） | 只有想用 `https://你的域名` 才需要；先用 `http://服务器IP` 完全可以 |

::: warning 数据都在你自己的服务器上

文章、图片、数据库都在服务器的 `/var/vanblog/data/` 里（第 9 节有目录一览）。
**升级、重装、删容器都不会动它**；但备份归档默认也只在这台机器上，所以第 3 节最后一条很重要。

:::

## 1. 装一个全新博客

| 你想做什么 | 敲这条命令 | 看到什么算成功 |
| --- | --- | --- |
| 下载一键脚本 | `curl -L https://raw.githubusercontent.com/CKboss/vanblog/dev/dsh/scripts/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh` | 当前目录出现 `vanblog.sh`，且 `ls -l vanblog.sh` 里带 `x`（可执行） |
| 打开菜单 | `./vanblog.sh` | 出现一个数字菜单（`1. 安装 / 重装 VanBlog` …） |
| 开始安装 | 在菜单里输入 `1` 再回车 | 最后回到菜单，中间没有红色报错；机器上没有 docker 时它会**自己装**（不问你，见上一行） |
| 看它跑起来没有 | 打开菜单 `./vanblog.sh`（**顶部**就有一行状态），或菜单里输入 `13`、或敲 `./vanblog.sh status` | 菜单顶部：`状态    ：● 运行中  http://<域名或服务器IP>:<端口>`；`13` / `status` 打的是状态总览，看 `站点接口  ：http://127.0.0.1:<端口> → 200` 这一行 |
| 初始化站点 | 浏览器打开 `http://<服务器IP>/admin/init`，按向导填站点名和管理员账号密码 | 页面提示初始化成功，并跳到后台登录页。⚠️ **第一次提交可能被拒绝**并提示要「初始化密钥」—— 这是新版的默认保护，见下面那条 |
| 填「初始化密钥」（第一次装会遇到） | 被拒绝后页面会出现「初始化密钥」输入框；用 `cat /var/vanblog/data/log/setup.key` 取密钥，**完整一行**粘进去再提交 | 提示初始化成功。密钥每次重启都会换，也在容器日志里（`grep 初始化密钥`），每 10 分钟重印一次 |
| 登录后台 | 浏览器打开 `http://<服务器IP>/admin`，用刚设的账号密码登录 | 进得去后台首页 |

- 向导里每一项填什么、初始化密钥是什么：见 [初始化](./init.md)。
- 除了脚本，也可以用 docker compose / 宝塔 / 群晖 / Kubernetes 装：见 [快速上手](./get-started.md#部署方式)。
- ⚠️ 装完**尽快**完成初始化：没初始化的站点摆在公网上，别人可能抢先把它初始化成自己的
  （新版默认要求「初始化密钥」来挡这件事，密钥在 `/var/vanblog/data/log/setup.key` 和启动日志里）。

## 2. 更新到某个版本

| 你想做什么 | 敲这条命令 | 看到什么算成功 |
| --- | --- | --- |
| **升到指定发布版（最推荐，最可复现）** | `./vanblog.sh update v2026.9.2` | 打印 `VanBlog 更新并重启成功`，下面一行 `版本：旧版本 -> v2026.9.2@23f2e9c`；前台页脚与后台「关于」也变成这个号 |
| 同上的等价写法（效果完全一样） | `VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:v2026.9.2 ./vanblog.sh update` | 同上 |
| 升到最新发布版（不想记版本号） | `./vanblog.sh update` | 同上；不带版本号时用的是 `latest`，也就是**最近一次发布构建** |
| 看自己现在是什么版本 | `curl -s http://127.0.0.1/api/public/health` | 返回的 JSON 里有 `"version":"v2026.9.2@23f2e9c"` 这样的字段（也可以直接看前台页脚或后台「关于」） |
| 更新前先备份 | 见下面第 3 节第一条 | `整站备份成功` |
| 想手动钉版本（不通过脚本） | 把 `/var/vanblog/docker-compose.yaml` 里的 `image:` 那行改成 `ghcr.io/ckboss/vanblog:v2026.9.2`，然后 `docker-compose pull && docker-compose down && docker-compose up -d` | 容器重建后版本号变了。⚠️ `down` **千万不要加 `-v`**，那会删数据卷 |

::: warning dev-dsh 这个标签可能落后于发布版

镜像有几个标签，含义不一样（第 8 节有完整对照）：

- `v2026.9.2` 这样的**发布号**：内容固定不变，最可复现，推荐新手用它。
- `latest`：最近一次**发布**构建（脚本默认就是它）。
- `dev-dsh`：开发分支的**上一次手动构建** —— 它只在有人手动触发构建时才更新，所以**可能比发布版旧**。
  写这一页时实测：`dev-dsh` 停在 2026-09-13 的 `dev-dsh@b31a1ec`，而发布版是 2026-09-17 的
  `v2026.9.2@23f2e9c`，用它等于往回退。

只有你**明确想跟开发进度**时才用它，并且要显式写出来：

```bash
VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:dev-dsh ./vanblog.sh update
```

:::

::: caution 别随手跑 vanblog.sh config

它会**按模板重新生成** `/var/vanblog/docker-compose.yaml`：`image:` 会被重置回默认标签，
你自己加的 `environment:` 条目也会被覆盖（覆盖前它会存一份 `.bak-<时间戳>` 备份）。
只是想升级的话用 `update`，不要用 `config`。

:::

- 这一版有哪些**故意的行为变化**（比如 `/swagger` 默认关了、访问密码忘记就找不回了）：
  升级前请先看 [升级 → 升级前要知道的行为变化](./update.md#升级前要知道的行为变化)。
- 更新的完整说明与自动更新（watchtower）：见 [升级](./update.md)；升级踩坑见 [升级常见问题](../faq/update.md)。

## 3. 备份

「整站备份」= 数据库 + 图片附件 + 主题，打成一个压缩包（文件名形如 `vanblog-full-20260918-031500.tar.zst`）。

| 你想做什么 | 敲这条命令 | 看到什么算成功 |
| --- | --- | --- |
| 立刻备份一次 | `./vanblog.sh backup` | 打印 `整站备份成功` |
| 备份 + 马上深度校验（**推荐**，适合手动备份） | `./vanblog.sh backup-verify` | 最后一行是校验通过；任何一步不对都会红字 + 退出码非 0 |
| 每天自动备份（写进定时任务） | `VANBLOG_ADMIN_TOKEN=<你的token> ./vanblog.sh install-cron` | 先展示将要添加的 crontab 整行、写入后回读确认；重复跑会显示 `已经装过了：crontab 里已有同样的条目，不会重复添加` |
| 改自动备份的时间 / 保留份数 | `VANBLOG_ADMIN_TOKEN=<你的token> ./vanblog.sh install-cron --hour 4 --keep 14` | 同上。⚠️ 参数与已有条目不同时会**拒绝**并提示加 `--force`（免得悄悄改掉你的定时任务） |
| 取消自动备份 | `./vanblog.sh install-cron --remove` | 打印 `已从 root 的 crontab 移除定时备份条目`（token 文件保留，路径会打印出来） |
| 上次备份成功了吗、校验过没有 | `./vanblog.sh backup-status` | 打印最近一次成功备份的时间与校验状态 |
| 让监控能发现"备份从来没校验过" | `./vanblog.sh backup-status --strict` | 最新归档没有"已验证"记录时**退出码非 0**（不加 `--strict` 时这种情况算正常，监控就看不出来） |
| 把备份目录里的归档全查一遍 | `./vanblog.sh verify-deep --all` | 结论行 `VERIFY-RESULT total=<份数> ok=<份数> fail=0` |
| 看归档放在哪 | `ls -lh /var/vanblog/data/log/vanblog-backups/` | 能看到 `vanblog-full-*.tar.zst` 文件 |

**`<你的token>` 从哪来**：浏览器登录后台 → 按 `F12` 打开开发者工具 → `Application`（应用）标签 →
左边 `Local Storage` → 选你的站点 → 找到名为 `token` 的那一项，复制它的值。
（定时备份要拿它去调备份接口；它会以 root 权限存在 `/var/vanblog/vanblog-cron.env` 里，作废办法见详细文档。）

::: danger 备份只在这台机器上，一定要拷一份到别处

归档默认落在 `/var/vanblog/data/log/vanblog-backups/`，**没有异地副本**：机器一起丢就全丢。
备份完把它下载到本地电脑，或传到你自己的网盘 / 对象存储：

```bash
scp root@<服务器IP>:/var/vanblog/data/log/vanblog-backups/vanblog-full-*.tar.zst ~/vanblog-backup/
```

:::

- 备份里到底有什么、能不能不停服恢复、保留策略怎么配：见 [备份与迁移](./backup.md) 与
  [整站备份（详细）](../advanced/backup.md)。

## 4. 验证备份真的能恢复

「备份成功」不等于「能恢复」。这条命令会**另起一套一次性容器**，把你指定的归档真恢复一遍，
再逐项检查恢复出来的站点对不对，测完自动拆掉，**不影响正在跑的博客**。

| 你想做什么 | 敲这条命令 | 看到什么算成功 |
| --- | --- | --- |
| 演练恢复最新那份备份 | `./vanblog.sh drill` | 最后一行 `RESULT: PASS pass=… warn=… fail=0 note=…` |
| 演练恢复指定归档 | `./vanblog.sh drill /var/vanblog/data/log/vanblog-backups/vanblog-full-20260918-031500.tar.zst` | 同上 |
| 只校验归档本身（不起容器，最快） | `./vanblog.sh verify-deep` | 结论行 `VERIFY-RESULT total=… ok=… fail=0` |

::: warning fail 不为 0 就别指望这份备份

`RESULT:` 那一行里 **`fail=0` 才算通过**。`warn` 和 `note` 是提醒（会写清提醒什么），
`fail` 不为 0 说明这份归档恢复不出来 —— 别等到真要换机器时才发现。
这条命令**不需要 root**，也不会碰你正在跑的站点。

:::

## 5. 恢复 / 换机器

| 你想做什么 | 敲这条命令 | 看到什么算成功 |
| --- | --- | --- |
| 用某份归档恢复当前站点（不停服） | `./vanblog.sh restore vanblog-full-20260918-031500.tar.zst` | 提示恢复完成；刷新前台能看到归档里的内容 |
| 不知道归档叫什么名字 | `./vanblog.sh restore` | 列出可选的归档让你挑 |
| **换新机器一步到位** | 在新机器上：`VANBLOG_RESTORE_FROM=/path/to/vanblog-full-20260918-031500.tar.zst ./vanblog.sh install` | 装完自动初始化 + 恢复 + 重启，最后逐项核对通过 |
| 不开命令行，用浏览器恢复 | 全新站点打开 `http://<服务器IP>/admin/init`，用页面**最上方**「已有整站备份？直接恢复」那张卡片上传归档 | 上传完提示恢复成功，不用再填一遍向导。⚠️ 这条接口同样默认要「初始化密钥」：第一次上传被拒绝后卡片里会出现密钥输入框，填 `setup.key` 的内容再传一次 |

- 恢复会不会覆盖图片、恢复后要不要重启、跨版本恢复注意什么：见 [备份与迁移](./backup.md)。
- 换机器 / 迁移的完整流程：见 [备份与迁移](./backup.md) 与 [部署常见问题](../faq/deploy.md)。

## 6. 回滚（升坏了怎么退回去）

| 你想做什么 | 敲这条命令 | 看到什么算成功 |
| --- | --- | --- |
| 退回旧版本代码 | `./vanblog.sh update <旧版本号>`（例如 `./vanblog.sh update v2026.9.1`） | 先打红字 `⚠️⚠️ 这是**降级**` 并问 `确认继续? [y/N]` —— 输 `y` 才继续；成功后打印 `VanBlog 更新并重启成功` 与 `版本：<新> -> <旧>`。自动化场景加 `VANBLOG_ASSUME_YES=1`（WARN 照打，只是不阻塞） |
| 同上的等价写法 | `VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:<旧版本号> ./vanblog.sh update` | 同上 |
| 或者手改编排再重启 | 把 `/var/vanblog/docker-compose.yaml` 的 `image:` 改回旧标签，然后 `docker-compose pull && docker-compose down && docker-compose up -d` | 同上。⚠️ **不要加 `-v`**，那会删数据卷 |
| 数据也要退回去 | `./vanblog.sh restore <升级前那份归档>` | 恢复完成，内容是备份时的样子 |

「旧版本号」怎么知道：升级前记一下 `curl -s http://127.0.0.1/api/public/health` 里的 `version`
（形如 `v2026.9.1@0ec01a5`，取 `@` 前面那半就是版本号），或者看前台页脚。

## 7. 出问题了，先看这三条

| 你想做什么 | 敲这条命令 | 怎么读结果 |
| --- | --- | --- |
| 看整体状态 | `./vanblog.sh status` | 看 `站点接口  ：… → 200`（不是 200 就往下看日志）、`编排镜像`（当前钉的版本）、`整站备份`（几份、最近三个）、`磁盘剩余` |
| 看日志 | `./vanblog.sh log` | 找 `ERROR` / `WARN` 行，报障时把相关片段一起贴上 |
| 看服务本身活着没 | `curl -s http://127.0.0.1/api/public/health` | 返回 JSON 且 `"status":"ok"` = 服务活着；**HTTP 503 + `"status":"degraded"` = 数据库连不上** |

- 还是不行：见 [部署常见问题](../faq/deploy.md) 与 [升级常见问题](../faq/update.md)。
- 提 issue 时请附上 `./vanblog.sh status` 的输出、日志片段，以及后台「关于」里的版本号。

## 8. 镜像标签怎么选（大白话）

`ghcr.io/ckboss/vanblog:` 后面跟的那个词叫「标签」，决定你拉到的是哪一版：

| 标签 | 它是什么 | 什么时候用 |
| --- | --- | --- |
| `v2026.9.2` | 固定发布号，内容**永不变** | **推荐**：想要稳定、可复现、好回滚 |
| `latest` | 最近一次**发布**构建（**脚本默认就是这个**） | 不想记版本号，跟着发布走 |
| `dev-dsh` | 开发分支的**上一次手动构建**，⚠️ 可能落后于发布版 | 只有明确想跟开发进度时（要显式写 `VANBLOG_IMAGE_REF`） |
| `dev-dsh-<短sha>` | 某一次构建的快照 | 回滚到某个具体提交 |

想知道当前有哪些发布版：打开 [Releases 页面](https://github.com/CKboss/vanblog/releases)。

## 9. 常用目录一览

| 路径 | 里面是什么 |
| --- | --- |
| `/var/vanblog/docker-compose.yaml` | 编排文件（`image:` 那行决定用哪个版本） |
| `/var/vanblog/data/static/` | 你上传的图片、附件、主题 |
| `/var/vanblog/data/mongo/` | 数据库文件（**不要手动改**） |
| `/var/vanblog/data/log/` | 日志，以及 `setup.key`（初始化密钥）、`restore.key`（找回密码用） |
| `/var/vanblog/data/log/vanblog-backups/` | 整站备份归档 |

::: tip 全部环境变量与子命令

`./vanblog.sh --help` 会打印全部子命令、参数与环境变量；文档版见
[环境变量](../reference/env.md) 与 [一键脚本用法](./script.snippet.md)。

:::
