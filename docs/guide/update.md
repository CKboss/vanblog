---
title: 升级
icon: cloud-arrow-up
order: -3
---

## 升级提示

::: info 本分支的截图与上游不同

下面几张截图来自上游版本，本分支有这些区别：

- **不会再弹"有新版本！"的假警报**：源码构建的版本号是 `dev/dsh@<短sha>`，上游用字符串比较
  （`'dev/dsh@…' >= 'v0.54.0'`，首字符 `d` < `v`）会永远判定"有新版本"，本分支只在两边都是
  正式发布号时才按数字段比较。
- **版本信息指向本分支**：前台页脚与后台「关于」页显示的是本 fork 的仓库与「增强修改版」说明，
  不是上游文档站。
- **备份页多了「整站备份」**：`站点管理/系统设置/备份恢复` 除了原来的 JSON 导出，还有
  整站备份（导出/查看清单/上传恢复/下载/删除），见 [整站备份](../advanced/backup.md#整站备份推荐)。

:::

目前 VanBlog 处于快速迭代期，如果后台出现新版本提醒，推荐进行升级。

![升级提醒](https://pic.mereith.com/img/e314ee92dd1ad9b5b6c0b814b014c247.clipboard-2022-08-22.png)

升级前建议先备份。**推荐用整站备份**（跨版本可恢复、恢复不用停服）：

```bash
./vanblog.sh backup        # 或后台「系统设置 → 备份恢复 → 导出整站备份」
```

![备份数据](https://pic.mereith.com/img/4eba8540c5a7a5ae41885289abf98514.clipboard-2022-08-15.png)

:::: tabs#deploy

@tab 脚本

你可以直接运行安装脚本来升级 VanBlog，启动后请输入 6 并回车。

```bash
./vanblog.sh
```

![脚本一键升级](https://pic.mereith.com/img/fbbf5dde011f9dec13cdb25ad741765f.clipboard-2022-09-20.png)

::: warning 限制

使用一键脚本升级的前提是：**部署也是使用的一键脚本**

如果您不是通过一键脚本部署的，可以先在后台手动备份后，改为通过 [脚本部署](./get-started.md#部署方式)。

目前暂不支持热升级（后面会有的），需要手动关闭容器，切换新版镜像后重启。

:::

@tab docker

请切换到部署 VanBlog 的目录下（docker-compose.yaml 存放的路径下），然后运行下面的命令。

```bash
# 拉取新镜像（本分支的镜像；上游官方镜像是 mereith/van-blog:latest）
docker-compose pull
# 关闭原有服务 —— ⚠️ 不要加 -v，那会删掉编排里的卷
docker-compose down
# 用新镜像重新启动
docker-compose up -d
# 确认没问题后再清理悬空的旧镜像（可选）
docker image prune -f
```

::: danger 不要写 `docker-compose down -v`

`-v` 会**删除编排里的卷**。现在默认是 bind mount（数据在宿主机目录）所以侥幸没事，
但只要编排被改成命名卷，`-v` 就等于删库。升级请用不带 `-v` 的 `down`。

:::

::: note

其他部署方式升级步骤类似，如果你实在看不懂，你可以在后台导出数据备份一下（记得单独备份图片），然后删除所有的容器/镜像，按照安装教程重新部署一遍，如果发现数据丢了（不乱改编排的话一般丢不了），再导入数据也行。

后面有计划会做热升级（在后台点一下按钮自动就升级了），敬请期待。

:::

### 自动升级 Docker

推荐使用 [watchtower](https://github.com/containrrr/watchtower) 自动监控升级。在此给出一个简单指引。

1. 首先在用户目录下创建 `watchtower.list` 文件，里面用空格隔开写入需要监控自动更新的容器名
1. 运行下面的命令

   ```bash
   docker run -d \
       --name watchtower \
       --restart unless-stopped \
       -v /var/run/docker.sock:/var/run/docker.sock \
       containrrr/watchtower -c \
       $(cat ~/watchtower.list)
   ```

上方指引是否有效取决于你具体的运行环境，如果按照指引不能自动升级，请阅读下方参考文章了解相关知识自行处理。

::: info 教程

Watchtower 使用可参考 [Watchtower - 自动更新 Docker 镜像与容器](https://www.jianshu.com/p/eefbc08d9dc8)

:::

@tab 宝塔面板

宝塔面板推荐用一键脚本部署，直接用脚本升级就行了。

如果想用图形化升级的话，备份后，先删除原有镜像和容器，再重新创建即可。

@tab 群晖 NAS

群晖 NAS 请参照 Dockers 升级。

如果想用图形化升级的话，备份后，先删除原有镜像和容器，再重新创建即可。

::::

## 更多

::: info 当前版本查看

VanBlog 会在前台和后台的最下方展示版本信息。

![前台版本信息](https://pic.mereith.com/img/720d4503f7ca23cfb035061d0927b088.clipboard-2022-08-16.png)

![后台版本信息](https://pic.mereith.com/img/0f97b214de4965f69db68b935d993f07.clipboard-2022-08-16.png)

:::

::: tip 如何回滚

本分支每次构建都会打三个 tag：`latest`、`dev-dsh`、以及带提交号的 `dev-dsh-<短sha>`。
回滚就是把编排里的 `image:` 换成某个具体提交号，然后
`docker-compose pull && docker-compose down && docker-compose up -d`（**不要加 `-v`**）。

如果数据也需要回滚，用整站备份：`./vanblog.sh restore vanblog-full-<时间戳>.tar.zst`，
详见 [备份与迁移](./backup.md)。

:::

::: info 原理

`./vanblog.sh update` 的顺序是：**先准备新镜像，再停旧容器** ——
拉取（或源码构建）失败时旧容器还在跑，不会出现"更新到一半站点没了"；
成功之后才 `down` / `up -d`，停机时间只有重启那几秒，并且只删除已经没人用的旧镜像。

数据都映射在宿主机目录里，所以删除容器/镜像不会丢数据（容器本身是无状态的）。

:::

## 常见问题

- 详见 [升级常见问题](../faq/update.md)。
