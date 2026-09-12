---
title: 备份与迁移
icon: retweet
---

以下是备份或迁移 VanBlog 的方法。

<!-- more -->

:::: tabs#deploy

@tab 脚本部署时

迁移 `/var/vanblog` 目录到新机器，然后运行脚本重启服务即可。

```bash
# 执行一键脚本自动打包备份文件
curl -L https://vanblog.mereith.com/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh && ./vanblog.sh backup
# 复制备份文件到新机器后，再次执行一键脚本恢复备份即可
curl -L https://vanblog.mereith.com/vanblog.sh -o vanblog.sh && chmod +x vanblog.sh && ./vanblog.sh restore
```

脚本备份写在安装目录（默认 `/var/vanblog/vanblog-backup-*.tar.gz`）。卸载只会删除 `data/` 和编排文件，**不会**删掉这些备份，也不会动安装目录外的备份目录。卸载前仍建议先把备份拷到别处。

@tab docker 手动部署时

`docker` 部署的 VanBlog 所有的状态都存储在持久化目录中，所以只需要备份/迁移持久化目录。

将映射到宿主机的持久化目录进行备份或迁移到新机器上即可。

::: tip

迁移映射的目录到新机器的对应目录后，再用一模一样的 `docker-compose` 启动就好了。

:::

::::

## 后台整站备份（不想登宿主机时）

不方便执行脚本、或者想跨部署方式迁移（脚本部署 ↔ Docker）时，用后台的 **整站备份**：
`站点管理/系统设置/备份恢复 → 导出整站备份`，得到一个高压缩归档（默认 `zstd -19`），里面含
**数据库全部集合 + waline 评论 + 图床图片与缩略图 + 附件 + 自定义页面**。

在新机器上装好 VanBlog、走完初始化向导后，进同一个页面点 **上传备份并恢复**，就能把整站还原出来（含索引）。详见 [导入导出](../advanced/backup.md#整站备份推荐)。

::: tip 两种方式怎么选

- 目录级快照（`vanblog.sh backup` / 直接拷持久化目录）：最完整，但恢复时 MongoDB 版本要对得上。
- 后台整站备份：逻辑备份，跨版本、跨部署方式都能恢复，体积也更小；不含 Caddy 证书与日志。

:::

## 更多

VanBlog 后台还内置有 [导入导出](../advanced/backup.md) 功能（JSON），只搬数据库记录、不含任何文件，适合在两站之间迁移文章。它会一并恢复分类管理中的分类（含旧备份里只保存在文章上的分类名），导入后前台会重新渲染；导入不会覆盖当前后台登录账号，新机器上刚配好的账户可以继续登录。它的局限（不含图床图片、附件、自定义页面文件和评论）正是上面「整站备份」要解决的。
