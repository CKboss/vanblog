---
title: 升级
icon: cloud-arrow-up
order: -3
---

## 升到指定发布版（一行命令）

用一键脚本装的站点，升到某个**发布版**只要一行（版本号换成你要的那个，列表见
[Releases](https://github.com/CKboss/vanblog/releases)）：

```bash
./vanblog.sh update v2026.9.2
```

其它几种写法（效果都一样，挑顺手的）：

```bash
./vanblog.sh update ghcr.io/ckboss/vanblog:v2026.9.2                     # 写完整镜像地址
VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:v2026.9.2 ./vanblog.sh update   # 等价的老写法
./vanblog.sh update dev-dsh-abc1234                                      # 回到某一次具体的构建（回滚用）
./vanblog.sh update                                                      # 不带参数 = 默认的 latest 标签
```

⚠️ 参数打错（例如 `--v2026.9.2`，或者一次给两个版本号）会**直接拒绝**并打印用法、退出码 2 ——
不会静默按默认值升级。

**看到什么算成功**（三行，按出现顺序）：

1. `> 目标镜像：ghcr.io/ckboss/vanblog:v2026.9.2（发布号：内容固定不变…）` —— 拉镜像**之前**
   就告诉你这次会得到什么；
2. `> 当前运行: <旧版本号> → 新镜像: v2026.9.2@23f2e9c` —— 停旧容器**之前**的版本对比；
3. `VanBlog 更新并重启成功` 与 `版本：<旧版本号> -> v2026.9.2@23f2e9c`。

之后前台页脚与后台「关于」页显示的就是这个版本号。停机只有重启那几秒（脚本**先把新镜像准备好、
再停旧容器**；拉取失败时旧容器全程不动，站点不会因为升级失败而停摆）。

::: warning 新镜像比当前旧时，脚本会拦你一下

停容器之前脚本会比对两个版本号，两种情况会打**醒目 WARN 并要求确认**：

- **能证明更旧**：例如 `v2026.9.2@23f2e9c → v2026.9.1@…`；
- **证明不了不更旧**：当前跑的是发布号，而目标是个会移动的标签（`latest` / `dev-dsh`），
  或者镜像里读不出版本号。

交互终端下要敲 `y` 才继续；非交互（cron / 管道）没人能回答，就打完 WARN 继续，
`VANBLOG_ASSUME_YES=1` 同理（**WARN 照打**，只是不阻塞）。取消的话旧容器原样在跑，什么都没动。
这一整套就是为了让"以为是升级、其实是降级"再也不会静默发生。

:::

::: danger 不带版本号 = 升到 latest，它会随下次发版移动

`./vanblog.sh update`（不带参数）用默认镜像 `ghcr.io/ckboss/vanblog:latest`，也就是
**最近一次发布构建**（此刻就是 `v2026.9.2`）。它不是钉死的版本：下次发版后会跟着走。
想永远说得清"我在哪一版"，就带上发布号。

⚠️ 还有个标签叫 `dev-dsh`，它**只在有人手动触发构建时才更新**（往分支 push 不会自动构建镜像），
所以可能比发布版旧。实测过一次：

| 标签 | 镜像里的版本号 | 构建于 |
| --- | --- | --- |
| `v2026.9.2` | `v2026.9.2@23f2e9c` | 2026-09-17 |
| `latest`（**脚本默认**） | `v2026.9.2@23f2e9c`（与发布版同一个 digest） | 2026-09-17 |
| `dev-dsh` | `dev-dsh@b31a1ec` | ⚠️ **2026-09-13，比发布版旧 4 天** |

所以显式用 `dev-dsh`（`./vanblog.sh update dev-dsh` 或 `VANBLOG_IMAGE_REF=…:dev-dsh`）时，
拿到的可能比现在跑的还旧 —— 上面那条 WARN 会拦你。脚本的默认值曾经就是 `dev-dsh`，
那等于让 `./vanblog.sh update` 变成一次静默降级、把整轮安全修复回滚掉，现在改成了 `latest`。

:::

### 四个标签怎么选（大白话）

| 标签 | 它指向什么 | 什么时候用 |
| --- | --- | --- |
| `v2026.9.2` 这类**发布号** | 那一次发版时的代码，**永远不变** | ✅ **推荐新手**：`./vanblog.sh update v2026.9.2` |
| `latest`（**脚本默认**） | 最近一次发布构建（会被下次发版挪走） | 不想每次写版本号时可用 |
| `dev-dsh` | 最近一次**手动触发**的分支构建（push 不触发，可能比发布版旧） | 明确想试还没发版的改动时 |
| `dev-dsh-<短sha>` | 某一次具体的分支构建 | **回滚**，或钉死"就是这一次构建" |

想知道某个标签此刻到底是哪一版：看升级输出里的 `当前运行: … → 新镜像: …` 那行，或前台页脚 /
后台「关于」页（版本号形如 `v2026.9.2@23f2e9c`，前半是标签、后半是构建时的 commit，能直接对上代码）。

### 钉住的版本会写进编排文件（这点最容易困惑）

`update` 不只是拉镜像，它还会把 `/var/vanblog/docker-compose.yaml` 里的 `image:` 改成你这次指定的
ref。所以之后 `./vanblog.sh restart`、`docker-compose up -d` 起的仍然是这个版本 —— 这是好事，
可以用 `./vanblog.sh status` 看「编排镜像」那一行确认。

⚠️ 但**下次再跑不带版本号的 `./vanblog.sh update`，又会回到默认的 `latest`**（它会跟着下次发版走）。
想彻底钉死不动，可以直接改一次编排文件，之后用 docker 命令升级：

```bash
# 先把 /var/vanblog/docker-compose.yaml 里的 image: 行改成
#   image: ghcr.io/ckboss/vanblog:v2026.9.2
cd /var/vanblog
docker-compose pull
docker-compose down          # ⚠️ 不要加 -v，那会删掉编排里的卷
docker-compose up -d
```

::: danger 别随手跑 ./vanblog.sh config

`config` 会按模板**重新生成**编排文件：`image:` 会被重置回默认的 `latest`，你手写的
`environment:` 也会被覆盖（覆盖前会自动存一份 `docker-compose.yaml.bak-<时间戳>`）。
改版本号不需要跑 `config`。

:::

::: tip 拉不到镜像时，别让它悄悄退化成"源码构建"

`update` 默认是 `auto` 模式：先 `docker pull`，拉不到就**退回克隆源码本地构建**（15–40 分钟），
而源码构建出来的是**分支最新代码**，不是你要的那个发布号（网络到不了 ghcr.io 时最容易发生）。
钉版本时建议加上 `VANBLOG_INSTALL_MODE=image`：拉不到就直接失败、旧容器一动不动，
不会升出一个"看着成功、其实不是那一版"的结果。

```bash
VANBLOG_INSTALL_MODE=image ./vanblog.sh update v2026.9.2
```

:::

升级前请先备份，并读一遍下面的**行为变化**（这一轮有 9 处故意改了默认值，其中"访问密码改存
scrypt 哈希"是不可逆的）。

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
| **匿名初始化默认要求「初始化密钥」** | **只影响还没初始化的站点**：向导第一次提交会被 400 拒绝，页面**这时**才出现「初始化密钥」输入框（密钥在日志目录 `setup.key` 与启动日志里，每 10 分钟重印）。已初始化的站点完全无感 | 容器环境里可以显式关掉这个开关（公网不建议），开关名与细节见 [初始化](./init.md#初始化密钥setup-key) |
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

::: info 版本号、「有新版本」提醒、以及升级前该做的备份

- **版本号形如 `v2026.9.2@23f2e9c`**（标签 + 构建时的 commit），前台页脚与后台「关于」页都显示；
  报问题时带上它，就能直接对上代码。
- 后台的「有新版本」提醒**只在两边都是正式发布号时**才按数字段比较，所以源码构建出来的
  `dev/dsh@<短sha>` 这类版本号不会一直弹提醒。
- **升级前用整站备份**：后台 `站点管理 → 系统设置 → 备份恢复` 里可以导出/查看清单/上传恢复/下载/删除。
  一个归档就含数据库、图床与附件、自定义页面、主题，跨版本可恢复、恢复不用停服，
  详见 [整站备份](../advanced/backup.md#整站备份推荐)。

:::

目前 VanBlog 处于快速迭代期，如果后台出现新版本提醒，推荐进行升级。

升级前建议先备份。**推荐用整站备份**（跨版本可恢复、恢复不用停服）：

```bash
./vanblog.sh backup        # 或后台「系统设置 → 备份恢复 → 导出整站备份」
```

:::: tabs#deploy

@tab 脚本

你可以直接运行安装脚本来升级 VanBlog，启动后请输入 6 并回车。

```bash
./vanblog.sh
```

⚠️ 菜单里的「6. 更新」等价于不带参数的 `./vanblog.sh update`，用的是**默认标签 `latest`**
（最近一次发布构建，会随下次发版移动）。要钉死某一版，用
[本页开头那一行命令](#升到指定发布版-一行命令)：`./vanblog.sh update v2026.9.2`。

::: warning 限制

使用一键脚本升级的前提是：**部署也是使用的一键脚本**

如果您不是通过一键脚本部署的，可以先在后台手动备份后，改为通过 [脚本部署](./get-started.md#部署方式)。

目前暂不支持热升级（后面会有的），需要手动关闭容器，切换新版镜像后重启。

:::

@tab docker

请切换到部署 VanBlog 的目录下（docker-compose.yaml 存放的路径下），然后运行下面的命令。

⚠️ 先确认编排文件里的 `image:` 是你要的版本：写 `dev-dsh` 或 `latest` 会跟着分支跑，
要钉住发布版就写成 `ghcr.io/ckboss/vanblog:v2026.9.2` 这样的**发布号**
（各标签的区别见 [本页开头的标签表](#四个标签怎么选-大白话)）。

```bash
# 拉取新镜像（编排文件里 image: 写的那个 ref）
docker-compose pull
# 关闭原有服务 —— ⚠️ 不要加 -v，那会删掉编排里的卷
docker-compose down
# 用新镜像重新启动
docker-compose up -d
# 确认没问题后再清理悬空的旧镜像（可选）
docker image prune -f
```

::: danger 不要写 docker-compose down -v

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

:::

::: tip 如何回滚

**代码回滚**（换回旧版本的镜像）—— 把版本号换成旧的，再跑一次升级命令就行：

```bash
./vanblog.sh update v2026.9.1        # 换成你要回去的那个发布号
./vanblog.sh update dev-dsh-abc1234  # 或回到某一次具体的分支构建
```

（每次分支构建都会额外打一个 `dev-dsh-<短sha>` 标签，所以能精确回到某一次构建。）
可用的标签见 [Releases](https://github.com/CKboss/vanblog/releases) 与
[本页开头的标签表](#四个标签怎么选-大白话)。

不知道现在钉的是哪一版？`./vanblog.sh status` 的「编排镜像」那一行就是当前 ref；
实际跑着的版本号在前台页脚或后台「关于」页。

手动改编排文件的话步骤一样，只是命令换成
`docker-compose pull && docker-compose down && docker-compose up -d`（**不要加 `-v`**）。

**数据回滚**（升级后发现数据不对）：`./vanblog.sh restore vanblog-full-<时间戳>.tar.zst`，
详见 [备份与迁移](./backup.md)。⚠️ 整站恢复默认会把静态目录修剪成与归档一致 ——
备份之后新上传的图片会被删掉，所以先确认归档时间点是你要的那个。

:::

::: info 原理

`./vanblog.sh update` 的顺序是：**先准备新镜像，再停旧容器** ——
拉取（或源码构建）失败时旧容器还在跑，不会出现"更新到一半站点没了"；
成功之后才 `down` / `up -d`，停机时间只有重启那几秒，并且只删除已经没人用的旧镜像。

数据都映射在宿主机目录里，所以删除容器/镜像不会丢数据（容器本身是无状态的）。

:::

## 常见问题

- 详见 [升级常见问题](../faq/update.md)。
