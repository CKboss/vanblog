---
title: 备份与迁移
icon: retweet
---

以下是备份或迁移 VanBlog 的方法。

<!-- more -->

:::: tabs#deploy

@tab 脚本部署时

`./vanblog.sh backup` 默认做的**就是后台那套「整站备份」**（同一个接口、同一种归档），
产出 `vanblog-full-<时间戳>.tar.zst`，落在 `<数据目录>/log/vanblog-backups/`：

```bash
./vanblog.sh backup                     # 整站备份（默认 zstd，一致性快照）
./vanblog.sh backup --format xz         # 换压缩格式：zstd / xz / gzip
./vanblog.sh restore                    # 不带参数：列出服务器上的归档，选一个恢复
./vanblog.sh restore vanblog-full-20260913-140955.tar.zst     # 一步恢复（不上传，秒级开始）
./vanblog.sh restore /path/to/vanblog-full-xxx.tar.zst        # 本地文件（走上传）
./vanblog.sh restore <归档名> --no-static                     # 只恢复数据库，保留当前图床/附件
```

**它比"打包数据目录"好在哪**：由 server 在运行中导出，不会拍到 mongod 写了一半的数据文件；
格式是 NDJSON，**不绑 MongoDB 版本**（4.4 → 6.0 → 7.0 都能恢复进去，而数据目录 tar 换个大版本
mongod 会直接拒绝启动）；恢复前还能读清单看每个集合多少条，不会恢复错版本。
恢复走接口、**不需要停服**，结束后自动触发一次全量渲染。

```bash
# 定时任务（不交互）：token 从浏览器 F12 → Application → Local Storage → token 取
VANBLOG_ADMIN_TOKEN=<token> VANBLOG_ASSUME_YES=1 ./vanblog.sh backup
# 不想用 token 就让脚本交互问账号密码（本地按后台同一套算法派生口令，明文不出本机）
./vanblog.sh backup
```

::: warning 整站备份不含 caddy 证书

归档里是**数据库全部集合 + waline 评论库 + 图床/附件/自定义页面**，不含 caddy 的证书与配置
（那些在数据目录里，证书到期会自动重签，一般不用备）。要连证书一起备，用下面的 `--offline`。

:::

### 目录级快照（兜底：站点起不来时）

```bash
./vanblog.sh backup --offline                # 打包整个数据目录（热备份，最快）
./vanblog.sh backup --offline --consistent   # 先停 MongoDB 再打包（一致性好，几十秒不可写）
./vanblog.sh restore /var/vanblog/vanblog-backup-<时间戳>.tar.gz   # 恢复：停服 → 解压覆盖 → 起服
```

产出 `vanblog-backup-<时间戳>.tar.gz`，内容是整个数据目录：图床 `data/static`、
MongoDB 数据文件 `data/mongo`、日志 `log`（整站备份的归档也在里面）、caddy 证书 `caddy/`。
脚本会自动处理几件容易踩的事：校验压缩包完整性、删掉热备份带出来的 `mongod.lock`
（不删 mongod 会拒绝启动）、**停不下来就不解压**（mongod 还在写的时候覆盖它的数据文件会直接损坏数据库）。

::: tip 两种方式怎么选

| | 整站备份（默认） | 目录级快照（`--offline`） |
| --- | --- | --- |
| 一致性 | server 运行中导出，一致 | 热备份不一致；`--consistent` 要停库 |
| 跨版本恢复 | ✅ NDJSON，不绑 MongoDB 版本 | ❌ 换大版本 mongod 拒绝启动 |
| 含 caddy 证书 | ❌ | ✅ |
| 需要站点在跑 | ✅（要调接口） | ❌ |
| 恢复是否停服 | 不停 | 停 |

**日常备份用默认的整站备份**；站点起不来、或者要连证书一起搬机器时才用 `--offline`。
两种都留一份最稳妥（它们互不通用）。

:::

卸载只会删除数据目录和编排文件，**不会**删掉这些备份。卸载前仍建议先把备份拷到别处。

::: warning 恢复之后要重新登录后台

整站恢复会把 `settings`（含 JWT 密钥）和 `tokens` 一起换成备份里的内容，而 server 的 JWT 密钥是
**启动时**读的 —— 所以恢复前登录的会话会失效，重新登录一次即可（登录/签发/校验仍然自洽，不影响使用）。
如果你有"恢复后立刻调 `/api/admin/**`"的自动化脚本，需要先重启容器让密钥对齐，否则会拿到 401。

:::

@tab docker 手动部署时

`docker` 部署的 VanBlog 所有状态都在持久化目录里，所以**目录级**备份就是把它整个拷走：

```bash
docker-compose stop                                   # 建议先停，避免拍到写了一半的数据文件
tar czf vanblog-data-$(date +%Y%m%d%H%M%S).tar.gz -C /path/to/vanblog .
```

迁移到新机器：解包到对应目录，用同一份 `docker-compose.yaml` 起起来即可
（⚠️ MongoDB 大版本要和原来一致，否则 mongod 会拒绝启动）。

**更推荐**的是用后台/接口做整站备份（跨版本、跨部署方式都能恢复）：
`站点管理/系统设置/备份恢复 → 导出整站备份`，或者在容器里直接调接口，
详见 [整站备份](../advanced/backup.md#整站备份推荐)。

::::

## 后台整站备份（不想登宿主机时）

不方便执行脚本、或者想跨部署方式迁移（脚本部署 ↔ Docker）时，用后台的 **整站备份**：
`站点管理/系统设置/备份恢复 → 导出整站备份`，得到一个高压缩归档（默认 `zstd -19`），里面含
**数据库全部集合 + waline 评论 + 图床图片与缩略图 + 附件 + 自定义页面**。

在新机器上装好 VanBlog、走完初始化向导后，进同一个页面点 **上传备份并恢复**，就能把整站还原出来（含索引）。详见 [导入导出](../advanced/backup.md#整站备份推荐)。

## 更多

VanBlog 后台还内置有 [导入导出](../advanced/backup.md) 功能（JSON），只搬数据库记录、不含任何文件，适合在两站之间迁移文章。它会一并恢复分类管理中的分类（含旧备份里只保存在文章上的分类名），导入后前台会重新渲染；导入不会覆盖当前后台登录账号，新机器上刚配好的账户可以继续登录。它的局限（不含图床图片、附件、自定义页面文件和评论）正是上面「整站备份」要解决的。
