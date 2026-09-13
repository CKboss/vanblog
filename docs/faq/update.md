---
title: 升级常见问题
icon: cloud-arrow-up
order: 3
---

## 一键脚本更新显示成功但仍是旧版本

旧版 `./vanblog.sh` 选项 6 会在容器还在跑时 `docker rmi`，失败后仍继续 `pull` / `up`，并打印「VanBlog 更新并重启成功」。中国镜像的 `latest` 也可能停在 v0.53.0，所以后台看起来像更新成功，版本还是旧的（[#421](https://github.com/Mereithhh/vanblog/issues/421)、[#404](https://github.com/Mereithhh/vanblog/issues/404)）。

请先用选项 20 更新脚本，再选 6（或直接 `./vanblog.sh update`）。现在的行为是：

1. **先把新镜像准备好，再停容器** —— 拉取/构建失败时旧容器还在跑，不会出现"更新到一半站点没了"；
1. 只删除已经没人用的旧镜像（不会把正在用的删掉）；
1. 只有运行中的镜像 ID/版本确实前进了才提示成功，否则报错并以非 0 退出（自动化里能判断）；
1. 本分支默认镜像是 `ghcr.io/ckboss/vanblog:dev-dsh`；编排里如果还是上游的
   `mereith/van-blog:latest` 或阿里云 `latest`，`config`/`update` 会提示并改成本分支镜像
   （⚠️ 反过来说：**旧版脚本的 `config` 会把本分支镜像悄悄改回上游官方版**，所以先更新脚本）。

## 如何回滚

本分支的镜像由 GitHub Actions 发布，每次构建都会打三个 tag：`latest`、`dev-dsh`、
以及**带提交号的** `dev-dsh-<短 sha>`。所以回滚就是把编排里的 tag 换成某个具体的提交号：

```bash
# 1) 看有哪些版本（Actions → publish-ghcr 的运行记录，或 ghcr 的 package 页面）
# 2) 改编排里的 image:
#    ghcr.io/ckboss/vanblog:dev-dsh  →  ghcr.io/ckboss/vanblog:dev-dsh-<短sha>
# 3) 重启（不要用 -v！）
docker-compose pull && docker-compose down && docker-compose up -d
```

如果连镜像回滚都不够（比如数据结构已经被新版改过），就用整站备份回滚：

```bash
./vanblog.sh backup                                   # 平时就该定时做
./vanblog.sh restore vanblog-full-<时间戳>.tar.zst     # 一步恢复（不停服）
```

::: danger 不要用 `docker-compose down -v`

`-v` 会删除编排里的卷。现在是 bind mount 所以侥幸没事，但一旦改成命名卷就等于删库。
重启用不带 `-v` 的 `down`。

:::

## docker 镜像拉取慢

您可以 [设置 docker 镜像加速器](https://www.runoob.com/docker/docker-mirror-acceleration.html)。

## 升级后访问文章地址时出现 404 错误

由于本质上 VanBlog 基于静态页面，升级后容器内不存在按照新版本生成的静态页面。

容器每次启动时都会自动触发增量渲染，等待容器选软完成后，即可正常访问。

## 升级后后台报错或持续加载

请清空浏览器缓存再重新加载。大部分浏览器可以使用 <kbd>Ctrl</kbd> + <kbd>F5</kbd> 强制刷新以忽略缓存。

::: details 其他方案

如果是 `Chrome` 浏览器，您可以按 `F12` 打开开发者工具。在网络选项卡中勾选`停用缓存`，然后再刷新页面即可（刷新时开发者工具窗口不要关），正常后记得取消勾选`停用缓存`。

其他浏览器可以自行百度。

![Chrome 停用缓存](https://www.mereith.com/static/img/5efb32214a31c1003df5eeba217a5586.clipboard-2022-09-03.png)

:::

## 容器无限重启

有时由于作者疏忽，新版本可能由于存在 Bug 引发致命错误导致无限重启，此时可以优先考虑版本回滚。

有能力的同学可以记录一下无限重启的容器日志，提一个 [issue](https://github.com/Mereithhh/van-blog/issues/new/choose) 或者直接联系作者，十分感谢！
