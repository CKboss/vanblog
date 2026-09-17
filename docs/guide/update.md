---
title: 升级
icon: cloud-arrow-up
order: -3
---

## 升级前要知道的行为变化

这一轮（2026-09）有几处**故意改了默认值/行为**的地方，升级后你会注意到它们。
每条都给了逃生口；完整的环境变量清单见 [环境变量](../reference/env.md)。

| 变化 | 你会看到什么 | 不想要怎么办 |
| --- | --- | --- |
| **文章/分类访问密码改存 scrypt 哈希** | 后台表单不再回填密码；**留空 = 不修改**，解除加密要显式勾「清除密码」。⚠️ 从此**忘记访问密码无法找回** | 无法回退（这是安全修复）；忘了密码在后台清除/重设，见 [加密文章](../advanced/encrypt.md) |
| **`/swagger` 默认关闭** | 实时 API 文档 404；后台「关于」「Token 管理」的入口改开仓库里的 API 文档并提示 | `VANBLOG_SWAGGER=true`（只认字面 `true`）打开，见 [API 参考](../reference/api.md) |
| **访问统计默认只保留 10 年** | 超过 `VANBLOG_VISIT_RETENTION_DAYS`（默认 3650）的按天统计行会被每日任务删掉；站点级累计与文章阅读量**不受影响** | `VANBLOG_VISIT_RETENTION_DAYS=0` 回到「永不删除」 |
| **恢复会修剪静态目录** | 整站恢复后，图床/附件/自定义页面/主题四个目录与归档**完全一致**：备份之后新上传的文件会被删掉（拷贝全部成功后才执行） | 容器环境里关掉修剪开关（`off`），见 [环境变量 → 备份与恢复](../reference/env.md#备份与恢复) |
| **事件日志开始轮转** | `vanblog-event.log` 超过 `VANBLOG_EVENT_LOG_MAX_MB`（默认 20）就轮转改名，只留 `VANBLOG_EVENT_LOG_KEEP`（默认 3）份旧的 —— 升级后原来的单个大文件会被轮转掉 | 调大两个值；这个文件以前只增不减，跑久了会吃满磁盘 |
| **限流覆盖到了静态/feed/sitemap/swagger** | 这些路径以前完全绕过限流与安全响应头，现在都进桶（静态资源有独立的 10 倍桶，正常读者无感）；扫描器会开始看到 429 | `VANBLOG_RATE_LIMIT_PER_MIN` / `VANBLOG_STATIC_LIMIT_PER_MIN` 调预算 |
| **防爆破计数按「可信客户端 IP」分桶** | 一体式部署下登录/评论/解锁的限次终于按真实访客算了（以前所有访客共用 127.0.0.1 一个桶，5 个请求就能把真管理员锁在门外）；覆盖式 XFF 反代的部署行为会变 | 逃生口与判定细节见 [安全与加固 → 认证](../advanced/security.md#认证) |
| **匿名初始化默认要求「初始化密钥」** | **只影响还没初始化的站点**：初始化页会多一个密钥输入框（密钥在日志目录 `setup.key` 与启动日志里）。已初始化的站点完全无感 | 容器环境里可以显式关掉这个开关（公网不建议），开关名与细节见 [初始化](./init.md#初始化密钥setup-key) |
| **文章版本历史默认开启** | 改标题/正文时自动存快照，编辑器多了「历史版本」入口；每篇最多 `VANBLOG_ARTICLE_REVISIONS_KEEP`（默认 10）条，实测存量成本 ≈1.8MB/59 篇 | `VANBLOG_ARTICLE_REVISIONS_KEEP=0` 关闭 |
| **启动可能多一条 WARN** | 太久（默认 48 小时）没有「已校验的成功备份」时，启动与每次备份失败后会 WARN 点名 | `VANBLOG_BACKUP_STALE_WARN_HOURS=0` 关；更推荐顺手把定时备份装上 |
| **浏览统计有了内存与行数上限** | 只在**写库持续失败**或**被匿名接口编造路径刷**时才有感：内存键位封顶（默认 20000），每天新增路径行封顶（默认 5000）；站点/每日总量永不丢 | 上限都可以调（0 = 不限），见 [环境变量 → 访问统计与日志](../reference/env.md#访问统计与日志) |
| **新增匿名健康端点** | `GET /api/public/health`（数据库 ping 不通返回 503）；镜像 HEALTHCHECK 与编排健康检查打的就是它。版本号公开，uptime/内存默认不给匿名调用者 | 详情字段的开关见 [环境变量](../reference/env.md#安全限流与可观测性) |

同一轮还**新增**了这些能力（不是行为变化，升级即有）：文章[回收站](../features/article.md#删除文章与回收站)、
[历史版本](../features/article.md#历史版本revisions)、[定时发布](../features/article.md#定时发布publishat)、
[/search 结果页与静态搜索索引](../features/search.md)、[.mdz 导入](../features/article.md#导入文章)、
[阅读时长与相关文章](../features/article.md#阅读时长与相关文章)、
[备份恢复演练 drill](../advanced/backup.md#证明备份真的能恢复vanblogsh-drill)、
迁移台账（后台欢迎页会显示本站的初始化记录，接口 `GET /api/admin/migration/list`）。
安全修复的完整清单在 [安全与加固 → 2026-09 这一轮的修复清单](../advanced/security.md#_2026-09-这一轮的修复清单)。

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
