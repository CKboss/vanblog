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
./vanblog.sh verify                     # 校验备份目录里的全部归档（不解压落盘）
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

### 备份前：磁盘空间预检

导出大归档最怕磁盘满：server 那边 ENOSPC 会优雅失败并清掉半成品，但大站上你已经白等了几分钟；
`--offline` 的目录级快照更糟 —— 磁盘满会留下一个**截断的 tar.gz**。所以脚本在发起备份之前
先在宿主机侧量一次：

- **估算**：备份目录里有上一个整站归档就用它的大小（最有依据）；没有就用
  「静态目录实际占用 + 数据库导出按 64MB 估」；
- **判定**：目标文件系统剩余 < 估算 + 余量 → **拒绝备份**（非 0 退出）；只是偏紧 → 警告后继续；
- **诚实**：估算或 `df` 拿不到时会明说「跳过检查直接备份」，不会假装检查过。

余量默认 256MB，用 `VANBLOG_BACKUP_SPACE_MARGIN_MB` 覆盖；`VANBLOG_BACKUP_SKIP_SPACE_CHECK=1`
完全跳过（定时任务里宁可备出来也不被拦时用，但更建议配合 `--keep` 控制总量）。

### 这份归档还能用吗：verify 与 sha256

server 导出的 manifest 里**没有校验和**（损坏要等到恢复解包时才由 zstd/xz/gzip 的 CRC 发现），
所以脚本侧补了一层：

- 凡是**经脚本**做的备份（`backup` 与 `backup --offline`），成功后都会在归档旁边写一个
  `<归档>.sha256`（格式同 `sha256sum` 输出）。把归档拷去别处（scp/U 盘/对象存储）时
  **把 sidecar 一起带上**，异地也能验；
- `./vanblog.sh verify [归档名|路径]…` 做三件事，全程**不解压落盘**：
  1. 流式过一遍解压器（`zstd -t` / `xz -t` / `gzip -t`）—— 截断或损坏的归档当场抓住；
  2. 有 `.sha256` 记录就比对（没有记录会明说跳过 —— 后台/接口直接导出的归档没有 sidecar，
     **照常校验**，恢复也不受影响）；
  3. 列出归档成员，核对预期内容都在：`manifest.json`、各集合的 `db/<库>/<集合>.ndjson`、
     `static/` 树（空站点没有静态树属正常，只提示不算失败）。

```bash
./vanblog.sh verify                       # 校验备份目录里的全部归档
./vanblog.sh verify vanblog-full-20260913-140955.tar.zst   # 按名字（在备份目录里找）
./vanblog.sh verify /path/to/xxx.tar.zst  # 按路径（比如刚 scp 到新机器的）
```

输出是每归档一行的 OK/FAIL 摘要 + 总计；**任一归档 FAIL → 退出码非 0**，
可以直接放进监控或 cron（例如每周验一次最老的归档）。FAIL 的归档别拿来恢复 ——
重新备一份，或换更早的一份并先 verify。

### 换新机器：一条命令把整站搬过去

在**新机器**上最烦的是：装完之后还要打开后台走向导初始化、登录、再上传备份 —— 而初始化时建的
那个账号马上又会被备份里的真实账号覆盖，纯属白走一趟。更麻烦的是恢复接口在鉴权后面：
**没初始化就没法登录，也就没法恢复**（鸡生蛋）。

`reset` 把这条链全自动化了：

```bash
# 归档已经在新机器上（scp/U 盘拷过来都行）
./vanblog.sh reset /path/to/vanblog-full-20260913-140955.tar.zst

# 或者把归档放到服务器的备份目录里（<数据目录>/log/vanblog-backups/），然后按名字恢复
./vanblog.sh reset vanblog-full-20260913-140955.tar.zst

# 甚至可以在安装时一步到位：
VANBLOG_RESTORE_FROM=/path/to/vanblog-full-xxx.tar.zst ./vanblog.sh install
```

它依次做：探活 → **站点没初始化就用随机口令的临时账号自动初始化** → 登录拿 token →
打印备份清单让你确认 → 恢复（含图床/附件）→ **重启容器**（让 server 重新读取恢复后的 JWT 密钥）→
逐项核对（接口、站点名、首页、后台、robots、文章数）→ 打印站点地址与"用你原来的账号登录"。

```text
> 站点是全新的，已用临时账号 reset-init 完成初始化（恢复成功后会被备份里的账号覆盖）
> 备份清单：
    归档    ：vanblog-full-20260913-140955.tar.zst
    备份时间：2026-09-13T06:09:54.882Z
    格式 zstd，大小 65.91 MB，耗时 29.4s
    内容    ：15 个集合 / 9838 条文档 / 185 个静态文件
    各集合  ：articles 59 · statics 93 · visits 8746 …
恢复成功
> 核对结果
  ✓ /api/public/meta → 200     ✓ 站点名：示例站点 aka blogadmin
  ✓ / → 200                    ✓ /admin → 200
整站重置完成
  登录账号：用备份里原来的账号（初始化用的临时账号 reset-init 已被覆盖）
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--no-static` | 只恢复数据库，保留当前的图床/附件 |
| `--no-restart` | 恢复完不重启容器（那就要自己重启一次，否则用备份里的密钥签的 token 验不过） |
| `--verbose` | 打印完整清单 JSON（默认只给摘要，完整 JSON 有上百行） |
| `VANBLOG_ASSUME_YES=1` | 跳过 `yes` 确认（自动化用） |
| `VANBLOG_ADMIN_TOKEN` | 站点**已经**初始化过时用它免交互登录 |
| `VANBLOG_RESET_INIT_USER` / `_PASS` | 指定临时初始化账号（默认随机口令） |
| `VANBLOG_API_BASE` | 站点不在本机时指定接口地址 |

::: tip 恢复失败也不会把你锁在门外

如果恢复中途失败，脚本会把**临时管理员账号和口令打印出来** —— 新机器上这是你唯一能进后台的凭据，
所以它不会藏在子进程里丢掉。

:::

### 定时备份：install-cron 一条命令装好

手写 crontab 最容易错三件事：token 放哪、忘带 `VANBLOG_ASSUME_YES`/`VANBLOG_BACKUP_KEEP`、
以及 `crontab` 用法不对把已有任务覆盖掉。所以脚本内置了：

```bash
VANBLOG_ADMIN_TOKEN=<token> ./vanblog.sh install-cron     # 每天 03:00，保留 7 份
./vanblog.sh install-cron --hour 5 --keep 14              # 换时间/份数
./vanblog.sh install-cron --remove                        # 移除
./vanblog.sh install-cron --force --hour 5                # 参数变了，替换旧条目
```

它的行为，条条都是为了"不闯祸"：

- **幂等**：crontab 里已有一条同样的就明说"不会重复添加"；已有一条但参数不同时**拒绝**，
  要你显式 `--force`（或先 `--remove`），绝不悄悄出现两条每天各备一次的条目；
- **绝不覆盖已有 crontab**：只在末尾追加自己的行（带 `# vanblog-backup-cron` 标记）；
  `crontab -l` 读出**不是**"没有 crontab"的其它错误时，宁可拒绝安装也不写回；
  写入后还会回读确认，读不到就报失败，不假装装好了；
- **写入前先展示**将要添加的整行，确认后（`VANBLOG_ASSUME_YES=1` 跳过）才写；
- 备份输出记到 `<数据目录>/log/vanblog-backup-cron.log`，成功失败都留痕；
- 没有 `crontab` 命令的机器会明说，并给出可照抄的手工步骤。

**token 放哪（诚实的权衡）**：备份接口在登录态后面，cron 里没法交互输密码，所以
`VANBLOG_ADMIN_TOKEN`（环境变量或安装时交互输入，输入不回显）会写进
`<安装目录>/vanblog-cron.env`，权限 **0600（仅 root 可读）**，cron 行 source 它。
这意味着**一个长期有效的管理员 token 明文落盘**：拿到 root 的人本来就能为所欲为，所以这只在
"服务器被拿到 root"之外多暴露了一点（比如备份盘/快照被单独读走）。怀疑泄露就让它作废
（后台重新登录签发新 token、删掉旧的），再 `install-cron --force` 重写一次。
不给 token 也能装，但脚本会明说：备份会在登录一步失败（错误进日志），按 env 文件里的注释补上即可。

不想用 `install-cron` 的话，手写 crontab 的等价配方（token 千万别直接写在 crontab 行里，
`crontab -l` 谁都能看）：

```bash
# /root/vanblog-cron.env（chmod 600）：
#   export VANBLOG_ADMIN_TOKEN='<token>'
0 3 * * * . /root/vanblog-cron.env && VANBLOG_ASSUME_YES=1 VANBLOG_BACKUP_KEEP=7 /var/vanblog/vanblog.sh backup >> /var/vanblog/data/log/vanblog-backup.cron.log 2>&1
```

建议再配一个每周校验（退出码非 0 就是有归档坏了，可接监控）：

```bash
30 4 * * 0 /var/vanblog/vanblog.sh verify >> /var/vanblog/data/log/vanblog-backup-cron.log 2>&1
```

### 别把磁盘备满：保留策略

一份整站备份就是几十 MB（本站实测 66MB），配了 cron 每天备一次，一个月就是 2GB；
不带保留份数的话一年能吃掉 ~24GB。所以**自动备份一定要带保留份数**
（`install-cron` 默认就带 `KEEP=7`）：

```bash
# 备份成功后只保留最新 7 份，其余连 .manifest.json / .sha256 一起删掉
./vanblog.sh backup --keep 7

# cron 里用环境变量（等价；token 的放法见上面 install-cron 一节，别写进 crontab 行）
0 3 * * * . /root/vanblog-cron.env && VANBLOG_ASSUME_YES=1 VANBLOG_BACKUP_KEEP=7 /var/vanblog/vanblog.sh backup >> /var/vanblog/data/log/vanblog-backup.cron.log 2>&1
```

几条边界，都是为了"宁可少删，不可多删"：

- 只删它自己认识的归档名（`vanblog-full-*.tar.*` / 离线模式的 `vanblog-backup-*.tar.*`），
  备份目录里的其它文件一概不动；`.manifest.json` 与 `.sha256` 是 sidecar，不参与"份数"计数，
  正主的归档被删时才跟着删；
- 只在**新备份成功之后**才清理 —— 备份失败时删旧归档，等于把最后的恢复点也弄没了；
- `--keep` 留空或写 0 就是不清理（默认行为），写非数字也不清理；
- 离线模式（`--offline --keep N`）清理的是安装目录里的 `vanblog-backup-*`，两者互不干扰。

`./vanblog.sh status` 会显示当前有多少份整站备份、最近三个归档是哪些，以及磁盘还剩多少。

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
