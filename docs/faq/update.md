---
title: 升级常见问题
icon: cloud-arrow-up
order: 3
---

想直接抄命令的话看[命令速查表](../guide/cheatsheet.md)；升级的完整步骤与这一版的行为变化在[升级](../guide/update.md)。

## 怎么更新到某个版本（一行命令）

```bash
./vanblog.sh update v2026.9.2
```

把 `v2026.9.2` 换成你要的版本号即可（有哪些版本：[Releases 页面](https://github.com/CKboss/vanblog/releases)）。
等价的写法是带环境变量，效果完全一样：

```bash
VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:v2026.9.2 ./vanblog.sh update
```

脚本会**先把新镜像拉好，再重启容器**（拉取失败时旧容器一直在跑，不会"更新到一半站点没了"），
并把 `/var/vanblog/docker-compose.yaml` 里的 `image:` 一起改成这个版本，所以钉住的版本是持久的。

**看到什么算成功**：重启前会打印一行 `当前运行: <旧版本> → 新镜像: <新版本>`，
结束时报更新成功；前台页脚与后台「关于」的版本号变成 `v2026.9.2@<短sha>`。
也可以直接问接口：

```bash
curl -s http://127.0.0.1/api/public/health     # 看 "version" 字段
```

::: tip 更新前先备份

```bash
./vanblog.sh backup-verify    # 备份 + 立刻深度校验，任一步失败都非零退出
./vanblog.sh drill            # 恢复演练：真起一次性栈恢复一遍，证明这份备份能用
```

两条都不需要 root。"备份成功"和"备份能恢复成一个能用的站点"是两件事，`drill` 验的是后者。
`drill` 结论行 `RESULT: PASS pass=… warn=… fail=…` 里 **fail 不为 0 就先别升级**。

:::

## 不带版本号时，`./vanblog.sh update` 会升到哪

升到 `ghcr.io/ckboss/vanblog:latest`，也就是**最近一次发布构建**。镜像标签的含义：

| 标签 | 它是什么 | 什么时候用 |
| --- | --- | --- |
| `v2026.9.2` | 固定发布号，内容永不变 | **推荐**：稳定、可复现、好回滚 |
| `latest` | 最近一次发布构建（脚本默认） | 想要"最新正式版"又不想记版本号 |
| `dev-dsh` | 开发分支的上一次构建 | 明确想跟开发进度时才用 |
| `dev-dsh-<短sha>` | 某一次构建的快照 | 回滚到具体提交 |

::: warning dev-dsh 可能比发布版更旧

镜像不是每次提交都重建的：构建只在**推发布标签**或**有人在 Actions 页面手动触发**时发生。
所以 `dev-dsh` 指向的是"上一次有人手动构建时"的分支代码，它可能落后于最新发布版。

写这段时的实测（直接读镜像仓库里各标签的 manifest 与镜像内版本号）：

| 标签 | 镜像内版本 | 构建时间 |
| --- | --- | --- |
| `v2026.9.2` | `v2026.9.2@23f2e9c` | 2026-09-17 |
| `latest` | `v2026.9.2@23f2e9c`（与发布号同一份） | 2026-09-17 |
| `dev-dsh` | `dev-dsh@b31a1ec` | **2026-09-13（比发布版旧 4 天）** |

要用开发分支的构建，显式指定即可：

```bash
VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:dev-dsh ./vanblog.sh update
```

如果目标镜像比正在跑的**更旧**，脚本会在重启前打一条醒目 WARN 并要求确认
（自动化场景设 `VANBLOG_ASSUME_YES=1` 时不阻塞，但 WARN 照打），所以降级不会再静默发生。

:::

## 一键脚本更新显示成功但仍是旧版本

先确认两件事：

1. **脚本本身是不是旧的**：跑 `./vanblog.sh`，选 **20（更新脚本）**，再选 6 更新。
   旧脚本的更新流程有缺陷（会在容器还跑着时删镜像、失败也继续、然后照样报成功）。
2. **你要的标签是不是真的变了**：如果镜像仓库里那个标签还指向同一份镜像，
   脚本会告诉你「已经是最新版本」并打印当前版本号 —— 这不是失败。

现在（新脚本）的行为是：

1. **先准备新镜像，再停容器** —— 拉取/构建失败时旧容器还在跑；
2. 重启前打印 `当前运行: … → 新镜像: …`，两个版本号摆在一起；
3. 只有镜像 ID/版本确实变了才报成功，否则明确说「已经是最新版本」；
4. 只清理已经没人用的旧镜像（不会把正在用的删掉）。

## 如何回滚

**回滚代码（换个镜像版本）**：

```bash
./vanblog.sh update v2026.9.1        # 换成你要回去的那个版本号
```

也可以手工改 `/var/vanblog/docker-compose.yaml` 里的 `image:` 行，然后：

```bash
docker-compose pull && docker-compose down && docker-compose up -d
```

::: danger 千万不要写 docker-compose down -v

`-v` 会删除编排里的卷。现在数据是 bind mount（在宿主机目录里）所以侥幸没事，
但只要编排被改成命名卷，`-v` 就等于删库。重启请用不带 `-v` 的 `down`。

:::

**回滚数据**（比如新版已经改过数据结构，光换镜像不够）：

```bash
./vanblog.sh backup                                   # 平时就该定时做
./vanblog.sh restore vanblog-full-<时间戳>.tar.zst     # 一步恢复，不停服
```

::: warning 别随手跑 vanblog.sh config

它会按模板**重新生成**编排文件：`image:` 会被重置回默认标签，你手加的 `environment:` 也会被覆盖
（覆盖前会自动存一份 `.bak-<时间戳>`）。要改环境变量就直接编辑编排文件，然后 `./vanblog.sh restart`。

:::

## 镜像拉取慢

可以[设置 docker 镜像加速器](https://www.runoob.com/docker/docker-mirror-acceleration.html)。
也可以从你自己的镜像仓库/加速地址拉，例如：

```bash
VANBLOG_IMAGE_REF=<你的镜像地址>/ckboss/vanblog:v2026.9.2 ./vanblog.sh update
```

⚠️ 镜像只发布了 `linux/amd64`。ARM 机器（含部分 NAS）拉不到能用的镜像，
需要先确认 CPU 架构：`uname -m` 应该是 `x86_64`。

## 升级后访问文章地址时出现 404

前台页面是静态生成的，新容器里还没有按新版本生成的页面。容器每次启动都会自动触发增量渲染，
**等渲染跑完**再访问就正常了（文章多时要等一会儿，进度看 `./vanblog.sh log`）。

## 升级后后台报错或一直加载

先强制刷新忽略缓存：大部分浏览器是 <kbd>Ctrl</kbd> + <kbd>F5</kbd>（Mac 上 <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd>）。

::: details 还不行的话

`Chrome`：按 <kbd>F12</kbd> 打开开发者工具 → 网络选项卡勾选「停用缓存」→ 刷新页面
（刷新时开发者工具别关），正常后记得取消勾选。

其他浏览器请在设置里清除该站点的缓存与 Cookie，或用无痕窗口打开后台确认是不是缓存问题。

:::

## 容器无限重启

先回滚到上一个能跑的版本（见上面「如何回滚」），再排查。取日志：

```bash
./vanblog.sh log                     # 或：docker logs <容器名> --tail 200
./vanblog.sh status                  # 看运行状态、HTTP/HTTPS 端口、编排里的镜像与数据目录
```

带着日志到[本仓库提 issue](https://github.com/CKboss/vanblog/issues/new/choose)——
日志里的报错行比"起不来"这三个字有用得多。
