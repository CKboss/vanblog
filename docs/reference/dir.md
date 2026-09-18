---
title: 目录映射
icon: folder-tree
order: 3
---

VanBlog 把所有**需要留下来的东西**都写在容器内的固定目录里。用 Docker 之类的容器部署时，
这些目录必须映射到宿主机，否则**升级镜像 / 重建容器时数据就没了**（容器本身是无状态的）。

下表是「容器内目录 → 装什么 → 一键脚本部署时在宿主机的哪里」。一键脚本的**安装目录**是
`VANBLOG_BASE_PATH`（默认 `/var/vanblog`），**数据目录**是 `VANBLOG_DATA_PATH`
（默认 `<安装目录>/data`，即 `/var/vanblog/data`）。

| 容器内目录 | 装什么 | 一键脚本部署时的宿主机路径 |
| --- | --- | --- |
| `/data/db` | **MongoDB 数据库文件**：文章、草稿、分类、标签、图床记录、设置、访问统计全在这里。⚠️ 最不能丢的一个 | `<数据目录>/data/mongo` |
| `/app/static` | 静态文件根目录（子目录见下）。用内置图床或附件的话**必须**映射 | `<数据目录>/data/static` |
| `/var/log` | 日志、密钥文件、整站备份归档（完整清单见 [日志](./log.md)） | `<数据目录>/log` |
| `/root/.config/caddy` | caddy 的配置存储 | `<数据目录>/caddy/config` |
| `/root/.local/share/caddy` | caddy 的**证书**存储（HTTPS 证书与 ACME 账号）。不映射的话每次重建容器都要重新签发证书 | `<数据目录>/caddy/data` |

::: note 那个「双 data」不是笔误

按默认值展开，图床的真实路径是 `/var/vanblog/data/data/static`、数据库是
`/var/vanblog/data/data/mongo`。编排模板与一键脚本两边都是这么拼的
（`vanblog_data_path/data/static`、`${VANBLOG_DATA_PATH}/data/mongo`），所以**不要**手动"修正"掉一层：
改了之后脚本的备份 / 恢复 / 状态检查会去另一个目录找文件，表现是"数据不见了"，其实是写到了两个地方。

:::

自己写编排文件的话，照仓库里 `docker-compose/docker-compose-template.yml` 的 `volumes:` 段抄即可
（vanblog 服务四条 + mongo 服务一条 `/data/db`）。

## `/app/static` 里有什么

| 子目录 | 内容 |
| --- | --- |
| `img/` | 图床图片；`img/thumb/` 是[缩略图](../features/image-storage.md#缩略图) |
| `file/` | [附件](../features/attachment.md) |
| `customPage/` | [自定义页面](../advanced/custom-page.md)（前台按 `/c/<路径>/` 访问） |
| `themes/` | 后台上传的[前台主题](../features/theme.md) CSS，文件名形如 `<主题id>-<hash8>.css` |
| `tmp/`、`upload-tmp/` | 上传与整站恢复的临时目录（可能临时放着备份内容，**匿名访问一律 403**） |
| `export/` | ⚠️ **历史遗留**：导出归档早已改放备份目录，这个目录里的旧文件匿名访问也一律 403 |

::: tip 整站备份故意不放在静态目录里

整站备份归档默认写在 **`<日志目录>/vanblog-backups/`**（容器内 `/var/log/vanblog-backups/`）。
这是刻意的：静态目录会被 web 层直接服务出去，而归档里含**密码哈希与 jwt 密钥**。
路径可以用 `backup.path`（环境变量 `VAN_BLOG_BACKUP_PATH`）改，但**别改到静态目录里面**，
见 [环境变量](./env.md#运行时核心) 与 [整站备份](../advanced/backup.md)。

:::

::: warning 换机器 / 重装

- 把上面几个宿主机目录整体拷到新机器的相同位置，再按 [快速上手](../guide/get-started.md) 起容器，站点就回来了；
- 更稳的做法是用**整站备份**：旧机器 `./vanblog.sh backup` 导出一个归档，新机器
  `VANBLOG_RESTORE_FROM=/路径/vanblog-full-xxx.tar.zst ./vanblog.sh install` 一步装好并恢复，
  见 [备份与迁移](../guide/backup.md)；
- ⚠️ 直接拷 MongoDB 数据目录**要先停容器**（或改用整站备份）：mongod 运行中拷贝可能得到不一致的文件，
  新机器上起来时会认为上次没有干净关闭，轻则要重放日志，重则拒绝启动。

:::
