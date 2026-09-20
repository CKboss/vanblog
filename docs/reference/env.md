---
title: 环境变量
icon: leaf
order: 2
---

VanBlog 在三个环节读环境变量：**镜像构建期**（Dockerfile 的 build-arg）、**容器运行期**（server /
前台 / caddy），以及宿主机上的**一键脚本**。所有变量都有默认值，**不改也能跑**；这一页是全量清单，
每一项都对着代码核过默认值。

::: tip 怎么改、怎么生效

- docker / compose 部署：写进编排文件的 `environment:`，然后 `docker-compose up -d` 重建容器；
- 一键脚本部署：写进 `<安装目录>/docker-compose.yaml` 的 `environment:` 段再 `./vanblog.sh restart`。
  ⚠️ `./vanblog.sh config` 会按模板**重新生成**编排文件，覆盖你手写的 `environment:`
  （覆盖前会自动存一份 `.bak-<时间戳>`），自定义项记得加回去；
- 运行期变量改完都要**重启容器**才生效；构建期变量（build-arg）只在重新构建镜像时有意义。

:::

::: warning 值的写法

为避免特殊字符对 bash / YAML 的干扰，请务必把环境变量的值用引号围起来（如 `"https://example.com"`）。
布尔类开关只认文档写明的字面值（常见是 `true` / `false`，有的还认 `1/0/yes/on/no/off`），
**打错的值一律按默认处理**——多数解析处会打一条 WARN，不会静默生效。

:::

## 配置的加载方式

server 的配置来自 `config.yaml`（容器内 `/etc/van-blog/config.yaml` 或工作目录，可用
`VAN_BLOG_CONFIG_FILE` 指定别的路径）与环境变量，**环境变量优先**。规则：配置键里的小写点分路径
换成大写、`.` 换 `_`、加 `VAN_BLOG_` 前缀就是环境变量名（例如 `database.url` →
`VAN_BLOG_DATABASE_URL`）。Docker 部署不需要 config.yaml，全部走环境变量即可。

## 安装与初始化

| 名称 | 默认值 | 设置后会发生什么 |
| --- | --- | --- |
| `VANBLOG_ADMIN_USER` | 空 | **零接触初始化**：与下面两个密码变量一起，让全新站点在容器开始监听 HTTP 之前完成初始化（未初始化窗口整个消失）。站点已初始化时被忽略。详见 [初始化](../guide/init.md#零接触初始化环境变量直接建好管理员) |
| `VANBLOG_ADMIN_PASSWORD` | 空 | 零接触初始化的管理员密码（内联方式；密码会出现在编排文件与 `docker inspect` 里） |
| `VANBLOG_ADMIN_PASSWORD_FILE` | 空 | 密码文件路径（如 Docker secret 挂载）。**优先于**内联变量；内容只去掉**尾部**换行/空白；文件读不到时大声失败（ERROR + 站点保持未初始化），绝不静默回落 |
| `VANBLOG_INIT_REQUIRE_SETUP_KEY` | **`true`（开）** | 未初始化期间，两条匿名初始化接口（`POST /api/admin/init`、`/api/admin/init/restore`）必须携带**初始化密钥**（字段 `setupKey`）。密钥每次启动重新生成，写在 `<日志目录>/setup.key`（0600）并在启动日志 WARN，初始化成功后自动删除。设 `false/0/no/off` 显式关闭（公网不建议）；**无法识别的值回落到开启**并 WARN |
| `VANBLOG_SETUP_KEY_REMIND_MINUTES` | `10` | 站点未初始化期间，启动日志里重印初始化密钥的间隔（分钟）。显式 `0` = 只在启动时印一次；负数/垃圾值回落 10，绝不静默变 0 |
| `VANBLOG_INIT_LIMIT_PER_10MIN` | `5` | 每 IP 每 10 分钟对 `/api/admin/init*` 的调用上限（1–1000）。⚠️ 它**同时**管着「忘记密码」的恢复接口 `POST /api/admin/auth/restore`（同为匿名、同样能改写管理员凭据，所以共用一个桶）—— 调大它会把两处一起放宽 |
| `VANBLOG_INIT_CACHE_MS` | `300000`（5 分钟） | 「站点是否已初始化」查询结果的进程内缓存时长；`0` = 每次都查库 |
| `VANBLOG_INIT_LOCK_TTL_MINUTES` | `30` | 初始化 / 整站恢复的**跨进程互斥锁**存活时间（分钟），夹在 1–1440。多进程（`VANBLOG_CLUSTER_WORKERS` > 1）时靠它保证两个 worker 不会同时初始化或同时恢复同一个库；抢不到锁的一方得到 **409**。`0`、负数、非数字一律**回落 30**，绝不会变成"永不过期"。调大的唯一理由：整站恢复真的要超过 30 分钟（慢盘 + 大归档）；调小的代价：进程被硬杀（OOM / `kill -9`）后，站点要空等到锁过期才能重试 |

## 运行时核心

| 名称 | 默认值 | 设置后会发生什么 |
| --- | --- | --- |
| `VAN_BLOG_DATABASE_URL` | `mongodb://mongo:27017/vanBlog?authSource=admin` | MongoDB 连接串。内嵌 Waline 会复用该连接串的主机与 `authSource`；也可以不写整串，改用 config.yaml 的 `database.host` / `database.port` / `database.user` / `database.passwd` / `database.name` 分项（按上面的映射规则同样有对应环境变量） |
| `VAN_BLOG_SERVER_HOST` | 空（所有网卡） | Nest API（3000 端口）的监听地址。本机反代时可设 `127.0.0.1` 只接受回环连接，见 [反代](./reverse-proxy.md#仅接受来自本机反代的流量) |
| `VANBLOG_LISTEN_BACKLOG` | `4096` | Node 监听队列（listen backlog）长度，夹在 1–65535，写错值回落默认。⚠️ **实际生效值 = `min(这个值, 内核的 net.core.somaxconn)`**：很多发行版的 `somaxconn` 默认只有 **128**，那样即使这里写 4096 也只会有 128。要扛住上万并发连接，宿主机上先 `sysctl -w net.core.somaxconn=4096` 并写进 `/etc/sysctl.d/` 持久化，详见 [性能](../advanced/performance.md#c10k-与连接层)。改这个值之前它是 Node 默认的 **511**，那就是「静态图片能扛一万并发、而经反代到 Node 的接口大量 502」的原因 |
| `VAN_BLOG_WALINE_DB` | `waline` | 内嵌评论系统（Waline）的数据库名 |
| `static.path`（config.yaml） | `/app/static` | 图床/附件/自定义页面/主题的静态根目录（按映射规则也可以写成对应环境变量） |
| `VAN_BLOG_LOG` | `/var/log` | 日志目录（`restore.key`、`setup.key`、事件日志、整站备份归档都在它下面） |
| `VAN_BLOG_BACKUP_PATH` | `<日志目录>/vanblog-backups` | 整站备份与导出归档的存放目录。**必须在静态目录之外**（归档含密码哈希与 jwt 密钥） |
| `VAN_BLOG_CADDY_DATA_PATH` | `/root/.local/share/caddy` | caddy 的证书/数据目录。只有 `VANBLOG_BACKUP_INCLUDE_CADDY` 打开时整站备份才会打包它 |
| `codeRunner.path` / `pluginRunner.path`（config.yaml） | `/app/codeRunner` / `/app/pluginRunner` | 流水线脚本的工作目录 / picgo 插件的安装目录 |
| `VAN_BLOG_CDN_URL` | 空 | 前台 `/_next/static` 公共资源的 CDN 前缀。**不是**文章配图或本地图床的地址；未配置 CDN 前不要设 |
| `VAN_BLOG_ALLOW_DOMAINS` | 空 | `next/image` 允许优化的远程域名（逗号分隔）。空 = 只优化本站图片 |
| `demo`（config.yaml） | `false` | 演示站模式：后台所有写操作接口返回 401 |
| `VAN_BLOG_VERSION` | `dev` | 页脚与后台「关于」显示的版本号（镜像构建时写入。⚠️ Dockerfile 的构建参数是复数 `VAN_BLOG_VERSIONS`，两个名字**故意不一样**） |
| `EMAIL` | 空 | 自动申请 HTTPS 证书的 ACME 联系邮箱（不带前缀）。不像邮箱的值会被忽略；留空也能签发，只是收不到到期提醒 |
| `UV_THREADPOOL_SIZE` | `16`（镜像里） | libuv 线程池：sharp 编解码、fs 异步、scrypt 都在这个池子里（Node 默认只有 4）。CPU 核多、图片流量大时才值得调（经验值：核数的 2–4 倍） |
| `VANBLOG_CLUSTER_WORKERS` | `1` | 多进程（cluster）worker 数：正整数（上限 **32**），也可写 `auto` / `cpus` / `max` = 按 CPU 核数开（同样不超过 32）。空值、`0`、负数、垃圾值一律回落到 `1`（= 单进程）。⚠️ N>1 时：内存近似线性增长（每个 worker 一份完整应用）；限流与连接池会按 worker 数摊薄；初始化 / 整站恢复由数据库里的 [TTL 锁](../advanced/security.md#认证)互斥（抢不到锁的一方得到 **409**）。打开前请自己压一遍。<br>⚠️ **停机语义**：关停时若有 worker 在宽限期内没退出会被 SIGKILL，此时主进程以 **ExitCode 1** 退出并打一条 FATAL（本轮之前是退出 **0**，编排系统看不出异常）。⚠️ 这个宽限期是 **cluster 主进程等 worker** 的时间，写死在代码里（10000ms）、**没有**对应的环境变量；它与下面那行 `VAN_BLOG_SHUTDOWN_TIMEOUT_MS`（默认 8000，管的是**容器 start.js 等子进程**）是**两个不同层的超时**，别混。正常的 `docker stop` / `compose down` 仍退出 0，`restart: always` 也不会因此循环重启（重启策略不作用于显式 stop） |
| `VANBLOG_DISABLE_WEBSITE` | 空 | `true` = server 不拉起前台（Next）子进程。前后端分离部署 website 镜像时用 |
| `VANBLOG_WEBSITE_HOST` | `0.0.0.0` | 前台子进程的监听地址（一体式镜像保持默认即可） |
| `VANBLOG_ISR_STORM_CONCURRENCY` | `4` | 全量重渲染（ISR 风暴）时同时在途的请求数，夹在 1–32。以前是**严格串行**：1 万篇文章按每次 200ms 算要 33 分钟，期间新内容出不来静态页。4 是「比串行快数倍、又不至于把前台进程和磁盘压垮」的取值，小机器别调大 |
| `VANBLOG_ISR_ROUND_URL_BUDGET` | `5000` | 单轮重渲染的「规模预算」，最小 1。⚠️ **它不会让任何页面少渲染** —— 超过预算只是把这一轮**分批**处理，并打一条 WARN 加进度日志，目的是让「这一轮规模异常大」这件事可见，而不是静默丢内容 |
| `VANBLOG_MONGO_MAX_POOL_SIZE` | `100` | mongoose 连接池上限（多进程时按 worker 数摊薄） |
| `VANBLOG_MONGO_CONNECT_TIMEOUT_MS` | `10000` | Mongo 建连超时 |
| `VANBLOG_MONGO_SERVER_SELECTION_TIMEOUT_MS` | `10000` | Mongo 选主超时（连不上库时多久报错） |
| `VANBLOG_MONGO_SOCKET_TIMEOUT_MS` | `120000` | Mongo socket 超时（大备份导入导出的长操作靠它兜底） |
| `VAN_BLOG_SHUTDOWN_TIMEOUT_MS` | `8000` | 容器 `start.js` 收到 SIGTERM 后等子进程优雅退出的时间，超时硬退 |
| `VAN_BLOG_STDIO_LOG_MAX_BYTES` | `20971520`（20MB） | 容器内 server/前台 stdio 日志文件的大小上限，超了轮转成 `.old`（只留一份旧的）。容器 stdout 那一份由编排的 `logging.max-size` 管，两套是分开的 |
| `VAN_BLOG_VERSION_API` | **空（= 关闭）** | 后台「新版本提醒」要查询的地址。⚠️ **默认不再回连任何第三方**：旧默认值是上游作者的版本服务，于是每次启动（以及每次打开后台）都会向一个与本部署无关的域名发请求，带出去的是本站出口 IP 和「这里在运营一个 VanBlog」这个事实。现在**默认一个字节都不发**（DNS 都不查）。想启用就填自己的或任何信任的端点；`off` / `false` / `none` / `disabled` / `0` 与留空等价，都当关闭处理。判断有没有新版本请看仓库的 Releases 页面（后台「关于」页有链接）—— 上游返回的 `0.54.0` 与本项目的 `v2026.x@sha` 形状本来就不可比，只会产生假警报 |

## 安全、限流与可观测性

| 名称 | 默认值 | 设置后会发生什么 |
| --- | --- | --- |
| `VANBLOG_SWAGGER` | 关 | **只认字面 `true`**：打开 `/swagger` 与 `/swagger-json`（实时 API 文档）。默认关闭是有意的——它等于把整个后台 API 面摊给未登录用户；后台「关于」「Token 管理」的入口会自动探测，关着时改开仓库内的 API 文档 |
| `VANBLOG_HEALTH_DETAILS` | 关 | `true` 时匿名的 `GET /api/public/health` 额外返回 uptime 与内存（版本号**始终公开**，它本来就渲染在每个前台页面的页脚上）。带 `x-vanblog-internal` 令牌也能读到详情 |
| `VAN_BLOG_INTERNAL_TOKEN` | 空 | 内部令牌：请求头 `x-vanblog-internal` 带上它 = 内部调用（允许 `pageSize=-1` 拉全量、读健康检查的 uptime/内存字段）。**判定是"回环直连且不带转发头" 或 "令牌匹配"**：一体式镜像里前台进程就是从 127.0.0.1 直接调 server、不带转发头，所以**不需要配**；而访客经 caddy 反代过来的请求带 `X-Forwarded-For`，不会被误判成内部。⚠️ **前后端分离部署必须给 server 与 website 两边配同一个值** —— 前台的 SSR 请求会带上它（本轮之前前台一个头都不发，配了也没用：`pageSize=-1` 会被夹到 100，标签页 / 时间线 / 总字数**静默少数据**且不报错）。⚠️ 只有 SSR（服务端渲染）请求带；浏览器侧的请求（文章解锁、阅读数、搜索、pageview）**不带**，令牌不会进前端产物 |
| `VAN_BLOG_REVALIDATE_SECRET` | 空 | 前台 `/api/revalidate`（触发页面重渲染）的口令。⚠️ **本轮起改成"失败关闭"**：没设它时，只接受"套接字是回环 **且** 不带 `x-forwarded-for` / `x-real-ip`"的请求（一体式镜像正是这个形状，所以行为不变），其余一律 **403**；设了就必须带同名 `secret` 查询参数（server 触发时会自动带上）。**分离部署**要让别的机器也能触发重渲染，就给 server 与 website 两边配同一个值。以前是"没设 = 不校验"，等于分离部署下任何人都能反复触发重渲染 |
| `VANBLOG_RATE_LIMIT_PER_MIN` | `600` | 每 IP 每分钟的全局请求上限（`/api/**` 与 `/static/**` 等，兜底限流） |
| `VANBLOG_STATIC_LIMIT_PER_MIN` | 全局值 ×10（=6000） | 静态资源（`/static/**`）的独立限流桶。图片密集的站点不要让它们挤全局预算 |
| `VANBLOG_PUBLIC_WRITE_LIMIT_PER_MIN` | `30` | 每 IP 每分钟对 `/api/public/**` 写操作（POST/PUT/DELETE）的上限 |
| `VANBLOG_TRUST_FORWARDED_HEADERS` | `auto` | 限流按哪个 IP 分桶：`auto` = 只有对端是回环/私网时才采信 `X-Forwarded-For` 的**最右一跳**；`always` = 始终采信转发头（CDN/隧道**直连源站**、对端是公网代理 IP 时必须用）；`never` = 只认套接字地址（反代后面等于全站共用一个桶，会 429 风暴）。详见 [反代](./reverse-proxy.md) |
| `VANBLOG_BRUTE_FORCE_IP_SOURCE` | `trusted` | 登录防爆破 / 评论频率 / 加密文章解锁计数用哪个 IP：`trusted` = 与上面同一套可信判定（一体式部署里 caddy 追加的 XFF 最右一跳就是真实客户端）；`socket` = 只用套接字地址——你的反代是**覆盖**而不是追加 XFF 时的逃生口 |
| `VANBLOG_API_TOKEN_TTL_DAYS` | **`90`** | 新签发 API Token 的有效期（天，夹在 1–36500）。⚠️ **默认值从 365 天改成了 90 天**：Token 等价于超级管理员（它签的就是 `id: 0`），有效期就是「泄露之后攻击者能用的时长」上限，365 天意味着一次疏忽要背一整年。90 天短到「泄露会自然过期」、长到「正常的自动化集成不用每月去后台重签」。**已经签发出去的 Token 不受影响**（按签发时写下的到期时间走），要立刻收紧请到后台「Token 管理」吊销重签 |
| `VANBLOG_JWT_ROTATE_GRACE_DAYS` | `7` | 轮换 jwt 签名密钥后，**旧密钥还能用几天**（夹在 0–365）。宽限期内旧会话不掉线；**期满之后所有旧登录会话与全部 API Token 一起失效**，外部集成要在后台重新签发。`0` = 不留宽限、轮换后立刻踢掉所有会话（会当场断开集成，慎用）。⚠️ 留空、纯空白、负数、垃圾值一律**回落 7 天而不是 0** —— 因为 `Number('') === 0`，把「compose 里写了个空值」解释成「宽限期 0 天」等于把一次手误放大成全站下线 |
| `VANBLOG_LOGIN_GLOBAL_FAIL_PER_MIN` | `120` | **全局**每分钟登录失败次数超过它之后，给**所有**登录请求加一点延迟（每超一倍加 500ms），抬高撞库成本。⚠️ 这是**加延迟不是封号**：密码正确的人照样能登录，只是慢。按 worker 数摊薄（多进程时每进程只看到 1/N）。显式写 `0` 才关闭，垃圾值（`abc`、`12O`）回落默认而**不会**变成关闭，上限 1000000 |
| `VANBLOG_LOGIN_THROTTLE_MAX_MS` | `3000` | 上面那个延迟的封顶毫秒数，夹在 100–30000。⚠️ **代价要如实知道**：站点正被大规模撞库时，**站长自己登录也会慢最多这么多**（默认 3 秒）。这是有意的取舍 —— 慢 3 秒 vs 登不进来。之所以不做「按用户名锁定」，是因为那会让攻击者把真管理员永久锁在门外（而且可以无限续期），在「要持续对外发布」的场景下比撞库本身更致命 |
| `VANBLOG_ADMIN_LOGIN_ALLOW_CIDR` | 空（= 不限制） | 只允许这些网段**登录后台**（CIDR 列表，逗号或空格分隔，IPv4/IPv6 都认）。被拒时返回 **403**，而响应文案**故意含糊**（不告诉探测者「这里配了网络限制」），真实原因写在服务端日志里（含被拒 IP 与已配网段，每 10 秒最多一条，带被抑制的累计条数）。⚠️ **配错 = 全部拒绝**（fail-closed，不会「配错就放行」），所以第一次配完请**另开一个浏览器/隐身窗口先确认自己还能登录**再关掉当前会话。⚠️ 三条边界：①**只管登录**这一个接口，已经签发的会话与 API Token 不受限制（这也是把 Token 默认有效期压到 90 天的理由之一）；②「忘记密码」恢复接口**故意不纳入** —— 那是站长在 VPN 之外唯一的自救入口；③白名单的强度取决于转发头是否可信，如果 `VANBLOG_TRUST_FORWARDED_HEADERS=always` 而站点又是直接暴露的，攻击者能伪造一个白名单内的 IP，这种情况请把 `VANBLOG_BRUTE_FORCE_IP_SOURCE` 设成 `socket` |
| `VANBLOG_PIPELINE_TIMEOUT_MS` | `30000` | 单个流水线的执行上限，超时直接杀进程 |
| `VANBLOG_DEPS_INSTALL_TIMEOUT_MS` | `300000` | 流水线安装依赖（`pnpm add`）的上限 |
| `VANBLOG_ALLOW_PICGO_PLUGINS` | 关 | `true` 才允许安装 picgo 第三方插件。**默认关闭是有意的**：picgo 1.5.6 依赖的 git-clone（命令注入）与 decompress（路径穿越）都没有修复版本，而插件名来自后台输入框。内置图床都不需要插件 |
| `VANBLOG_REMOTE_FETCH_ALLOWED_PORTS` | `80,443` | 服务端**主动抓取外链**时允许连接的端口（逗号分隔）：外链图片转存、导出 md/mdz 时抓远程图片。⚠️ **这是行为变化**：图片挂在非标准端口的站点，这两个功能会开始失败——报错信息里写了怎么配（把那个端口加进来即可）。写错值**不会**变成"全部放行"：没设 / 空串 / 一个合法项都没有都回落 `80,443`；单个非法项（`80x`、`0`、`99999`、空项）被忽略，其余合法项照常生效。⚠️ 内网地址是**另一道**闸门（解析后判定，含 IPv4-mapped IPv6 / NAT64 / 6to4 / CGNAT），不在这个变量里 |
| `VANBLOG_DISABLE_IP_GEO` | 空 | `true` 完全关闭登录日志的 IP 归属地查询（不再把访客 IP 发给第三方 cip.cc） |
| `VAN_BLOG_IP_GEO_TIMEOUT` | `3000` | 归属地查询超时（毫秒，100–600000） |
| `VANBLOG_CADDY_ASK_ALLOW_ALL` | 空 | `true` 恢复「任何域名都批准按需证书」的旧行为（多域名/CDN 场景才需要；默认只批准本站已登记的域名） |
| `VANBLOG_HSTS_MAX_AGE` | `31536000`（一年） | 内置 caddy 在 **443** 上下发的 `Strict-Transport-Security` 的 max-age 秒数。写 `0` = **不发这个头**（这是唯一关闭它的方式），非法值回落默认。**只加在 443**：80 上不发（浏览器按 RFC 会忽略明文连接上的 HSTS），降级配置（证书校验不过时用的那份自签配置）**故意不发** —— 在证书本来就不可信的路径上要求「一年内只用 HTTPS」等于把站长锁在站外。⚠️ **设了之后这个域名在 max-age 窗口内无法退回纯 HTTP**，而且证书续签失败时浏览器是硬失败、不给「仍然前往」。所以务必确认证书目录真的持久化了（`./vanblog.sh doctor` 会查这一项） |
| `VANBLOG_CADDY_ACCESS_LOG` | 开 | 内置 caddy 的**访问日志**（每条请求一行 JSON，落在 `<日志目录>/caddy.log`，100MB 轮转、留 10 份）。写 `false` / `off` / `0` / `no` 关闭；留空、写错、写别的值一律**保持开启** —— 失败方向是「留住审计日志」。为什么给这个开关：①访问日志里有访客 IP，本身是个隐私面；②被打的时候它是每秒几千行的真实磁盘 IO。⚠️ 这是 **caddy** 的访问日志，与上面 `VANBLOG_ACCESS_LOG`（server 自己那份，默认关）是两回事 |
| `VANBLOG_ACCESS_LOG` | 关 | `true`/`1` 时每个非静态请求打一行 INFO 访问日志（容易刷屏，排障时再开） |
| `VANBLOG_SLOW_REQUEST_MS` | `5000` | 超过这个毫秒数的请求打 WARN 慢日志（`0` = 关；5xx 永远会打一条带 request-id 的 ERROR） |
| `VANBLOG_REQUEST_TIMEOUT_MS` | `300000` | Node HTTP server 的 `requestTimeout`（5000–3600000） |
| `VANBLOG_KEEP_ALIVE_TIMEOUT_MS` | `65000` | 上游 keep-alive 超时。**必须大于反代的空闲超时**（内置 caddy 是 60s），否则偶发 ECONNRESET/502 |
| `VANBLOG_JSON_BODY_LIMIT` | `1mb` | 全局 JSON 请求体上限（匿名接口不再敞着大解析上限） |
| `VANBLOG_JSON_BODY_LIMIT_LARGE` | `50mb` | 后台内容类前缀（文章/草稿/自定义页面/管线）的 JSON 上限——正文可以内嵌 base64 图片、整页 HTML。multipart（图片上传、备份恢复）不走这里。⚠️ **匿名请求拿不到这个大限额**：请求没带 `token` 头时，这四个前缀先按 `VANBLOG_JSON_BODY_LIMIT`（1mb）解析，超了直接 **413**。以前匿名攻击者可以朝 `/api/admin/article` 投一个 50MB 的 JSON，服务端会先花约 2.9 秒解析 + 约 4.6 秒净化**然后才** 401，而被限流挡下的 429 请求同样已经把 CPU 烧完了（解析与净化都跑在限流之前） |
| `VANBLOG_SANITIZE_MAX_NODES` | `50000` | 单次请求净化时最多允许访问多少个 JSON 节点（对象/数组/键值各算一个），夹在 1000–5000000，写错值回落默认。⚠️ **`0` 不是关闭** —— 它是安全边界，没有关闭档位，写 `0` 会被夹到 1000。超限时**拒绝请求（413）而不是跳过净化**：跳过就等于把 `$` 操作符与 `__proto__` 原样放过去。为什么 50000 够用：本站的大 body 大在**字符串值**上（正文内嵌 base64、整页 HTML），而净化只递归对象与数组、字符串原样返回，所以 50MB 的合法正文只花几十个节点。效果是把最坏情况的净化成本从「50MB ≈ 7.5 秒同步阻塞事件循环」压到约 **33 毫秒** |
| `VANBLOG_UPLOAD_MIN_FREE_BYTES` | `500mb` | 上传（图片/附件/JSON 导入）前要求目标卷至少剩这么多空间，不够就拒绝并说明差多少。接受纯字节数或 `500mb` / `2gb` 这类写法，认不出就回落默认，上限 1TB。⚠️ **`0` 是唯一的关闭方式**（要显式写 0）。⚠️ 读不到剩余空间时这道闸门**跳过**而不是拒绝（没有 `statfsSync` 的平台不该因此让所有上传失败） |
| `VANBLOG_LOG_SCAN_MAX_LINES` | `20000` | 后台「日志管理」单次读取日志文件的行数上限 |
| `VANBLOG_LOG_SCAN_MAX_BYTES` | `8388608`（8MB） | 后台「日志管理」单次读取日志文件的字节上限 |
| `VANBLOG_UNLOCK_GLOBAL_BUDGET_PER_10MIN` | `500` | **每篇**加密文章每 10 分钟允许的解锁尝试总次数，**与来源 IP 数无关**（小于 20 或写错值一律回落 500，上限 100000）。为什么需要它：按 IP 的那道限制（20 次/10 分钟/(IP×文章)）在僵尸网络下等于没有 —— N 个 IP 就是 N×20 次，而每次尝试都要算一次 scrypt（实测 63–65ms / 16MB 内存）。⚠️ 它统计**所有**尝试，包括密码正确的那次，所以默认 500 ≈「一篇文章 10 分钟内最多被 500 人试密码」；一篇爆文的加密贴可能真的会撞到，那就调大它。⚠️ 故意**没有**「全站预算」：那会让一篇爆文的合法读者把全站所有加密文章一起锁死，而本站的使用场景恰恰是「要在攻击下把内容发出去」 |
| `VANBLOG_IMG_SCAN_MAX_ARTICLES` | `5000` | 后台「扫描文章图片」一轮最多处理多少篇文章，夹在 1–1000000。⚠️ 撞上限时**会如实说明没扫完**（响应里带 `truncatedArticles`、日志有 WARN），别把结果当成全站结论 |
| `VANBLOG_IMG_SCAN_MAX_LINKS` | `2000` | 一轮最多处理多少个图片链接，夹在 1–10000000。上限存在的理由是**运行时间**：每个链接都要真去下载一次（单张上限 50MB、超时 15 秒），链接多时整轮可能跑几十分钟 |
| `VANBLOG_IMG_SCAN_CONCURRENCY` | `4` | 扫描时同时处理几个链接，夹在 1–32（以前是串行） |

## 备份与恢复

| 名称 | 默认值 | 设置后会发生什么 |
| --- | --- | --- |
| `VANBLOG_BACKUP_INTEGRITY` | 开 | 整站归档的成员级完整性数据（校验和清单）。`off` 是逃生舱：关掉后归档不再防「单成员损坏」 |
| `VANBLOG_BACKUP_PASSPHRASE` | **空（= 不加密）** | 整站归档的加密口令。设了之后归档名多一个 `.enc` 后缀（`vanblog-full-<时间戳>.tar.zst.enc`），内容是分块 AES-256-GCM。⚠️ **最短 12 字节**，短了**备份直接失败**（宁可不产出，也不写一份能离线爆破的弱归档）。⚠️ **忘了口令 = 归档永久不可恢复**，没有后门、没有找回；所以加密归档必须至少 `./vanblog.sh drill` 成功过一次才算"备份可用"。每次备份成功且**没有**加密时会打一条 WARN（说明现状 + 怎么开） |
| `VANBLOG_BACKUP_PASSPHRASE_FILE` | 空 | 从一个文件读口令（Docker secret / k8s Secret 挂载的标准用法），**优先于**上面那个内联变量。⚠️ 设了它却**读不到**（路径错、权限不够）时是**失败关闭** —— 直接报错拒绝继续，**绝不静默降级成明文备份**（那比不做这个功能更糟：站长以为归档是加密的）。文件内容只去掉**尾部**空白（前导空白理论上可能是口令的一部分，尾部换行几乎一定是 `echo`/编辑器带进来的） |
| `VANBLOG_BACKUP_VERIFY_DEEP` | 开 | 每次导出（手动与 cron 都算）写完立刻做**成员级深度自校验**，失败返回 HTTP 400 并把状态记进 `<备份目录>/backup-status.json`。关掉 = 回到「导出成功就等于文件没问题」的旧假设 |
| `VANBLOG_BACKUP_SWEEP_HOURS` | `24`（`0` = 关） | 定期巡检保留归档的节奏：每轮最多查 `VANBLOG_BACKUP_SWEEP_MAX` 份（最新的优先），成本可预测 |
| `VANBLOG_BACKUP_SWEEP_MAX` | `3` | 每轮巡检最多查几份归档 |
| `VANBLOG_BACKUP_SWEEP_DEEP` | 关 | 巡检时是否也做成员级哈希（≈1.4s/份）。默认关：巡检要的是「便宜到能天天跑」 |
| `VANBLOG_BACKUP_STALE_WARN_HOURS` | `48`（`0` = 关） | 太久没有「已校验的成功备份」就在启动与每次备份失败后 WARN |
| `VANBLOG_BACKUP_TIMEOUT_MINUTES` | `60`（`0` = 不限时） | 一整轮备份（导出 + 打包）的超时：到点即中止，状态记 `stage='timeout'`、**删掉半成品**、返回 HTTP 400。实测一次整站导出 28 秒（69MB 归档），几 GB 的站点也在分钟级，所以 60 分钟还没完基本就是卡住了；库特别大或盘特别慢可以调大（上限 `525600` = 一年），非法值与负数回落 60 |
| `VANBLOG_BACKUP_STALE_WORK_HOURS` | `6`（`0` = 关闭清理） | 启动时清理**上次崩溃遗留**的备份/恢复工作目录与上传暂存的年龄阈值：`<静态目录>/tmp/full-restore-*`（里面是**解包后的整站明文**）与 `<备份目录>/upload-tmp/restore-upload-*`（单个可达 8GB）。只删够旧的，正在跑的那次不受影响；跳过同名的**文件**与无关目录；删了什么、释放多少空间都记日志。上限 `8760`（一年）。⚠️ 这些目录匿名 HTTP 读不到（静态守卫对 `tmp`/`upload-tmp` 一律 403），所以它治的是"落盘的明文与每次崩溃漏一份磁盘"，不是远程泄露 |
| `VANBLOG_BACKUP_INCLUDE_CADDY` | 关 | `true` 时整站归档额外打包 caddy 的 TLS 材料（`VAN_BLOG_CADDY_DATA_PATH`，恢复时写回）。默认关：证书到期会自动重签，一般不用备 |
| `VANBLOG_BACKUP_ZSTD_LEVEL` | `19` | 整站归档的 zstd 压缩等级（夹在 **1–22**，越大越慢越小；非法值回落 19）。容器设了内存上限时建议调到 `12`（`-19 --long` 峰值能到 1GB 上下，可能被 OOM 杀） |
| `VANBLOG_RESTORE_PRUNE_STATIC` | **开** | 恢复时把四个静态目录（`img`、`file`、`customPage`、`themes`）**修剪成与归档完全一致**：归档里没有的文件会被删掉（在所有拷贝成功之后才执行）。这是「100% 保真恢复」的代价：恢复后不保留「备份之后新上传的图片」。`off` = 旧行为（只覆盖、不删多余） |
| `VANBLOG_RESTORE_DROP_ABSENT_COLLECTIONS` | 关 | 归档里**缺失**的集合默认只**报告**不删除。设 `true` 才真的 drop（恢复成「与备份那一刻完全一致」的库） |
| `VANBLOG_RESTORE_MAX_TOTAL_BYTES` | `107374182400`（100 GiB） | 整站恢复**解包后**允许的成员总字节上限（夹在 1 MiB–1 TiB，非法值回落默认），在解包**之前**按 tar 头里的成员大小算好再放行。为什么要它：匿名的恢复接口接受 8GB 上传（5 次/10 分钟/IP），一个高压缩比的 zstd 炸弹能解出远超磁盘的量，把数据库与日志一起写满。另有一条**不可配**的规则：目标卷剩余空间必须 ≥ 成员总字节 + 256 MiB。⚠️ 读不到剩余空间时这道闸门**跳过**而不是拒绝——把"读不到"当成 0 会让没有 `statfsSync` 的平台恢复全部失败 |

## 访问统计与日志

| 名称 | 默认值 | 设置后会发生什么 |
| --- | --- | --- |
| `VANBLOG_VIEW_FLUSH_MS` | `5000`（`0` = 立刻落库） | 浏览统计的缓冲落库节奏（毫秒，上限 600000）。一次落库固定 4–6 条 Mongo 命令；调大更省库，代价是看板计数最多落后一个周期 |
| `VANBLOG_VIEW_FLUSH_MAX_EVENTS` | `1000` | 攒够这么多条提前落库（给内存封顶） |
| `VANBLOG_VIEW_MAX_RETAINED_KEYS` | `20000`（`0` = 不限） | **写库持续失败**时内存里最多保留多少个「按路径/按文章」键（≈3.2MB）。路径名是匿名接口就能造的，不设上限进程会稳定长内存。超出的按「最老那天 → 文章」丢弃并 WARN；站点级总量与每日快照**永不丢** |
| `VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY` | `5000`（`0` = 不限） | 每天最多为多少个**新**路径建统计行。封住「匿名接口编造路径刷 visits 行数」；站点/每日总量不受影响 |
| `VANBLOG_VISIT_RETENTION_DAYS` | **`3650`**（10 年；`0` = 永不删除） | 按天统计行（visits/viewers）的保留窗口，超期的行会被每日任务删掉。⚠️ 默认从「永不删除」改成了 10 年：匿名接口能编造路径，每行永久留存等于无限增长。**站点级累计与文章阅读量不受影响**；最近 `VANBLOG_VISIT_RETENTION_MIN_KEEP_DAYS` 天一定保留 |
| `VANBLOG_VISIT_RETENTION_MIN_KEEP_DAYS` | `30` | 无论保留期设成多少，最近这些天的行一定保留 |
| `VANBLOG_VISITS_DEDUP` | 开 | 启动时合并 visits 表里 `{date,pathname}` 重复的行（历史并发首访产生的）并建唯一索引。`false` 关掉 |
| `VANBLOG_VISITS_DEDUP_DRY_RUN` | 关 | `true` 只打印会合并什么，不真的写 |
| `VANBLOG_VISITS_DROP_REDUNDANT_INDEXES` | 开 | 启动时删掉 visits 上两个被复合索引完全覆盖的单列前缀索引（只在替代索引确实存在时才删）。`false` 保留它们 |
| `VANBLOG_EVENT_LOG_MAX_MB` | `20` | 事件日志（`vanblog-event.log`，登录/系统事件）单份大小上限（MB）。到限轮转改名，总量上界 = MAX_MB × (KEEP+1) |
| `VANBLOG_EVENT_LOG_KEEP` | `3` | 轮转保留份数（默认总量 ≈ 80MB）。⚠️ 这个文件以前只增不减，跑久了会吃满磁盘 |

## 内容功能

| 名称 | 默认值 | 设置后会发生什么 |
| --- | --- | --- |
| `VANBLOG_ARTICLE_REVISIONS_KEEP` | `10`（`0` = 关） | 每篇文章保留多少个历史版本（改标题/正文才快照；回滚前会先存一份当前状态 ⇒ 回滚本身可回滚）。存量成本很小（实测单条均值 ≈3.1KB） |
| `VANBLOG_READING_SPEED_WPM` | `350` | 阅读时长的除数（字/分钟，夹在 50–2000）。私有/加密文章不给阅读时长 |
| `VANBLOG_SEARCH_INDEX` | 开 | 关掉后不再生成静态搜索索引 `/static/search/index.json`（盘上已有的也会被删掉），前台搜索干净地回退到服务端 `/api/public/search` |
| `VANBLOG_SEARCH_INDEX_MAX_DOCS` | `2000` | 索引最多收录多少篇文章（1–20000，最新的优先）。超出时索引会标记 truncated，前台据此提示并回退服务端搜索 |
| `VANBLOG_SEARCH_INDEX_SNIPPET_CHARS` | `200` | 每篇收进索引的纯文本摘要长度（50–500）。调小省字节（索引是每个搜索者都要下载的静态产物），代价是正文深处的关键词搜不到、要走服务端回退 |
| `VANBLOG_RSS_ITEM_LIMIT` | `50`（`0` = 不限） | RSS/Atom/JSON feed 里保留多少篇 |
| `VANBLOG_THUMB_AVIF` | 关 | `true` 时缩略图额外产一份 `.avif` 兄弟文件（比 webp 省 26–41% 字节，编码 0.6–1.3 秒/张）。**原图故意不做**（实测最高 241 秒/张 CPU）；极小图 AVIF 反而更大 |
| `VANBLOG_PUBLIC_META_CACHE_MS` | `5000`（`0` = 关） | `/api/public/meta` 的进程内缓存时长 |
| `VANBLOG_ISR_TIMEOUT_MS` | `10000` | server 触发前台 revalidate 的单次请求超时 |
| `VANBLOG_ISR_REAP_INTERVAL_MS` | `900000`（15 分钟） | 失效 ISR 产物清理器的对账周期：删掉「库里已不可见但磁盘上还留着」的静态 HTML（删除/隐藏/加密/未到点的文章）。与 caddy 直发开关解耦，始终运行 |
| `VANBLOG_CADDY_SERVE_HTML` | 关 | caddy 直接发 ISR 生成的 HTML（不过 Node）：`true` = 6 个固定页（实测 3.7–4.5× rps）；`all` = 再加 `/post/* /page/* /category/* /tag/*`（文章页突发 8.8×）。**要求 ISR 是 onDemand 模式**（delay 模式自动降级），并依赖上面的清理器保证不发已删除文章的旧页面 |
| `VANBLOG_CADDY_HTML_PAGES_DIR` | 镜像内前台 pages 目录 | caddy 直发时去哪找 ISR 产物（测试/特殊布局才需要动） |

### 可见水印

上传自动加**可见文字水印**（任何图床都生效；开关在后台「图床设置」）。渲染走 sharp/libvips + SVG，
文字大小按图片尺寸自动算。默认样式是 **tile（无缝斜排平铺）**：满图重复的小字水印（旋转 −26°、低不透明度、
白字 + 半透明深色阴影），「一眼能看出有水印但不破坏观感」，且裁不掉。下列变量微调样式
（非法值一律回默认）：

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `VANBLOG_WATERMARK_STYLE` | `tile` | `tile`（平铺）/ `corner`（右下角柔光底板）/ `bar`（底部渐变条） |
| `VANBLOG_WATERMARK_POSITION` | `bottom-right` | corner/bar 用的位置：`bottom-right` / `bottom-left` / `top-right` / `top-left` |
| `VANBLOG_WATERMARK_SCALE` | `1` | 整体缩放系数 |
| `VANBLOG_WATERMARK_OPACITY` | 按样式：tile `0.12` / corner `0.85` / bar `0.95` | 文字不透明度（0–1，越界回默认） |
| `VANBLOG_WATERMARK_COLOR` | `#ffffff` | 文字颜色（只认 `#rgb`/`#rrggbb`） |
| `VANBLOG_WATERMARK_SHADOW_COLOR` | `#000000` | 阴影颜色 |
| `VANBLOG_WATERMARK_SHADOW_OPACITY` | 样式不透明度的一半 | 阴影不透明度（0–1） |
| `VANBLOG_WATERMARK_MARGIN_RATIO` | `0.04` | corner/bar 的边距（占图短边比例） |
| `VANBLOG_WATERMARK_FONT_FAMILY` | `DejaVu Sans, 'Noto Sans CJK SC', 'WenQuanYi Zen Hei', sans-serif` | 字体栈（会做 SVG 注入清洗） |

字号本身**不是环境变量**：它按图片短边自动算，再夹进每个样式各自的上下限
（tile 14–54 / corner 16–64 / bar 14–96 px，是 `watermarkSvg.ts` 里的导出常量）。
想整体调大调小请用 `VANBLOG_WATERMARK_SCALE`（缩放系数会一起进夹取，所以不会缩到看不见、也不会大到出框）。
短边小于 **52px** 的图会跳过水印（服务端记一条 WARN，图片照常上传）；文字太长时字号先自动缩小，
缩到 8px 仍放不下也跳过。

::: warning 字体：VanBlog 镜像已自带，自建镜像要自己装

SVG 文字是经 libvips → librsvg → pango → **fontconfig** 栅格化的，所以要的是**系统字体**
（不是 npm 包，也不是前台自托管那份只给浏览器用的 woff2）。

- **VanBlog 镜像已经装了** `fontconfig ttf-dejavu wqy-zenhei`（Latin + 中文；
  容器内 `fc-list` 25 条、`fc-match "WenQuanYi Zen Hei"` → `wqy-zenhei.ttc`），中文水印可以直接用。
- **自己构建镜像 / 源码部署**时需要自己装这三个包（Debian/Ubuntu 是
  `apt-get install fontconfig fonts-dejavu fonts-wqy-zenhei`）。缺字体时**不会盖出乱码方块**：
  服务端会逐字符集探测（`Ag` / `水` 与私用区码点逐字节对比），探不到就打一条点名缺失字体与
  安装命令的 WARN 并**返回原图** —— 上传不失败，但也加不上水印。
  ⚠️ 如果你看到水印是**满图小方块**，说明跑的是没装字体的旧镜像：升级即可。
  当前版本的原则是「宁可不盖，也不盖满图方块」。

:::

## 前台（website 进程）

| 名称 | 默认值 | 设置后会发生什么 |
| --- | --- | --- |
| `VAN_BLOG_SERVER_URL` | `http://localhost:3000/` | 前台构建/渲染时回调 server 的地址（必须是合法 http/https URL；空串/非法值回落默认）。一体式镜像里已配好，分离部署 website 时要设。⚠️ **构建前台时这个地址必须连得通**：连不上时构建日志会先刷一串「无法连接，采用默认值」，然后以 `Error serializing .wordTotal … undefined cannot be serialized` **整个失败**（Next 不允许 `getStaticProps` 的返回值里有 `undefined`）。本轮已修掉这个崩溃点（四处推导全部补了兜底，总字数取不到就是 `0`），但"构建期要能连到 server"这个前提没变 —— 先起 server 再构建前台，CI 与 Docker 构建同理 |
| `VAN_BLOG_REVALIDATE` | 由 server 按 ISR 模式注入 | `"true"` = 延时 ISR（配 `VAN_BLOG_REVALIDATE_TIME`）；否则按需 ISR（24 小时长保险）。**不要手设**，由 server 依据后台「静态页面更新策略」管理 |
| `VAN_BLOG_REVALIDATE_TIME` | `60`（下限 60 秒） | 延时 ISR 的秒数。⚠️ 后台设置框里的旧提示「默认 10 秒」已作废：低于 60 的值会被抬到 60 |
| `VANBLOG_SKIP_TYPECHECK` | 关 | `true` 跳过前台构建期的类型检查（本地量产物体积用，生产构建不要开） |

## 镜像构建期（Dockerfile build-arg）

只在**自己构建镜像**时有意义（`docker build --build-arg ...`），详见 [本地构建镜像](../advanced/local-build.md)：

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `VAN_BLOG_VERSIONS` | 空 | 写进镜像的版本号（后台「关于」与页脚显示），如 `dev/dsh@1a2b3c4` |
| `VAN_BLOG_BUILD_SERVER` | `http://127.0.0.1:3000` | 构建期前台预渲染用的 server 地址，**必须是合法 URL** |
| `VAN_BLOG_NPM_REGISTRY` | `https://registry.npmmirror.com` | pnpm 源（海外机器建议改回 npmjs） |
| `VAN_BLOG_ADMIN_BUILD_SCRIPT` | `build` | admin 的 webpack 档位：`build`（堆 4096MB）/ `build:lowmem`（1536MB，小内存机器） |
| `VAN_BLOG_ALPINE_MIRROR` | 空（官方 dl-cdn） | Alpine 软件源；国内建议 `https://mirrors.aliyun.com/alpine`，`none` 强制官方 |
| `VAN_BLOG_NODE_DIST_URL` | 空 | node-gyp 的 Node 头文件源（用 npmmirror 时脚本会自动配 `cdn.npmmirror.com/binaries/node`） |
| `VAN_BLOG_SHARP_DIST_HOST` | 空 | sharp/libvips 预编译包源（`none` 用官方 GitHub） |
| `VAN_BLOG_SHARP_BINARY_HOST` | `https://github.com/lovell/sharp/releases/download` | sharp 二进制下载主机 |
| `VAN_BLOG_SHARP_LIBVIPS_HOST` | `https://github.com/lovell/sharp-libvips/releases/download` | libvips 二进制下载主机 |

## 一键脚本（宿主机侧，`vanblog.sh`）

这些是**脚本自己**读的变量（不是容器里的），全量说明在 `./vanblog.sh --help`：

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `VANBLOG_INSTALL_MODE` | `auto` | `auto` 先拉镜像、拉不到退回源码构建；`image` 只拉；`source` 只本地构建 |
| `VANBLOG_IMAGE_REF` | `ghcr.io/ckboss/vanblog:latest` | 用哪个镜像（可指具体发布号、本地 tag 或镜像加速地址）。`./vanblog.sh status` 会打印当前生效的「镜像来源」。⚠️ `latest` 与 `dev-dsh` 都是**会移动**的标签；要钉住内容就用发布号，最省事的写法是 `./vanblog.sh update v2026.9.2`（等价于 `VANBLOG_IMAGE_REF=ghcr.io/ckboss/vanblog:v2026.9.2 ./vanblog.sh update`），它会把编排文件里的 `image:` 一起改成这个 ref |
| `VANBLOG_USE_UPSTREAM_IMAGE` | `false` | `true` 时改用原作者发布的镜像 `mereith/van-blog:latest`（功能与本项目不同，一般只用于对照排查），优先级最高 |
| `VANBLOG_MONGO_IMAGE` | `mongo:7.0` | **只在全新安装时生效**；已有数据目录保持原 tag。老机器 CPU 不支持 avx 用 `mongo:4.4.16` |
| `VANBLOG_RESTORE_FROM` | 空 | `install` 之后自动 `reset`：把这份整站备份恢复上去（换机器一步到位） |
| `VANBLOG_RELEASE_TAG` | `latest` | 下载回退里 Release 附件用哪个 tag |
| `VANBLOG_BASE_PATH` | `/var/vanblog` | 安装目录（编排文件、离线备份 tar 包） |
| `VANBLOG_DATA_PATH` | `<安装目录>/data` | 数据目录（static/mongo/log） |
| `VANBLOG_BACKUP_DIR` | `<数据目录>/log/vanblog-backups` | 整站备份归档目录 |
| `VANBLOG_SRC_DIR` | `<安装目录>/src` | 源码构建时的克隆目录（默认 `/var/vanblog/src`） |
| `VANBLOG_REPO` / `VANBLOG_BRANCH` | `https://github.com/CKboss/vanblog.git` / `dev/dsh` | 源码构建 clone 哪个仓库、哪个分支（`VANBLOG_REPO` 要写**完整克隆地址**） |
| `VANBLOG_IMAGE_TAG` | `vanblog:dev-dsh` | 本地构建打什么 tag |
| `VANBLOG_NPM_REGISTRY` / `VANBLOG_ALPINE_MIRROR` / `VANBLOG_NODE_DIST_URL` / `VANBLOG_SHARP_DIST_HOST` | 空 = 实测延迟后选最快的源 | 源码构建时的四个源（`none` = 强制官方），海外机器什么都不用设 |
| `VANBLOG_FORCE_BUILD` | `false` | 可用内存 <1.8GB 时脚本会劝退源码构建；`true` 强行继续（后果自负） |
| `VANBLOG_ADMIN_TOKEN` | 空 | 备份/恢复接口免交互登录的 token（浏览器 F12 → Application → Local Storage → `token`） |
| `VANBLOG_API_BASE` | 从编排文件读端口 | 站点接口地址（站点在别的机器上时指定） |
| `VANBLOG_ASSUME_YES` | 空 | `1` 跳过所有 yes 确认（定时任务用） |
| `VANBLOG_SKIP_PULL` | 空 | `1` = 安装/更新时**绝不联网**，只用本机已有的镜像；本机没有就明确报错（不会偷偷去拉）。**完全离线的机房用这个** |
| `VANBLOG_BACKUP_MIRROR_DIR` | 空 | 备份成功后把归档（含 `.sha256`）再复制到**第二个目的地**（另一块盘 / NFS / 对象存储挂载点）。写法是先写 `.part` → 移动 → **逐个校验** sha256 与 zstd → 校验不过就删掉那份坏副本 → 按份数清理。⚠️ 目的地出问题**永远不影响本地备份的结果**（返回 0）：手里一份胜过远端一份，远端一份胜过没有 |
| `VANBLOG_BACKUP_MIRROR_KEEP` | 同 `VANBLOG_BACKUP_KEEP`（默认 7） | 第二目的地保留几份 |
| `VANBLOG_BACKUP_ALERT_WEBHOOK` | 空 | 定时备份**失败**时向这个 URL POST 一次告警。⚠️ 打不通绝不影响备份结果（只在屏幕上提示一句）。这是本项目**唯一**的告警通道 —— 以前备份失败只写进日志，没有任何人会知道 |
| `VANBLOG_VERBOSE` | 空 | `1` 打印完整 JSON |
| `VANBLOG_BACKUP_FORMAT` | `zstd` | `backup` 的压缩格式：`zstd`/`xz`/`gzip` |
| `VANBLOG_BACKUP_MODE` | `api` | `backup` 走整站备份接口还是 `--offline` 目录快照 |
| `VANBLOG_BACKUP_CONSISTENT` | 空 | `1` 等价于 `backup --offline --consistent`（先停 mongo 再打包） |
| `VANBLOG_BACKUP_KEEP` | 空（不清理） | 备份成功后只保留最新 N 份 |
| `VANBLOG_BACKUP_SPACE_MARGIN_MB` | `256` | 备份前磁盘空间预检的余量；剩余 < 估算+余量 → 拒绝备份 |
| `VANBLOG_BACKUP_SKIP_SPACE_CHECK` | 空 | `1` 完全跳过空间预检 |
| `VANBLOG_RESTORE_FILE` | 空 | 等价于 `restore <路径>`（老写法） |
| `VANBLOG_RESET_INIT_USER` / `VANBLOG_RESET_INIT_PASS` | 随机 | `reset` 自动初始化用的临时账号（恢复成功后被备份里的账号覆盖） |
| `VANBLOG_NO_COLOR` / `VANBLOG_FORCE_COLOR` | 空 | 脚本输出着色开关（非 tty 默认无色） |

## 恢复演练与校验（`vanblog.sh drill` / `verify-deep` / `backup-verify` / `backup-status`）

这四个子命令由 `scripts/vanblog-drill.sh` 实现（**不需要 root**），全部参数见
`./vanblog.sh drill --help`。常用环境变量：

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `VANBLOG_DRILL_ENGINE` | 自动探测 | `docker`/`podman`（docker daemon 连不上就用 podman） |
| `VANBLOG_DRILL_IMAGE` | 编排里的镜像 | 演练用哪个 vanblog 镜像 |
| `VANBLOG_DRILL_MONGO_IMAGE` | `mongo:7.0` | 演练用的一次性 mongo 镜像 |
| `VANBLOG_DRILL_PREFIX` | `vb-drill` | 一次性容器/卷/网络的命名前缀 |
| `VANBLOG_DRILL_PORT_BASE` / `VANBLOG_DRILL_PORT_SPAN` | `18500` / `400` | 临时端口选择的基址与跨度 |
| `VANBLOG_DRILL_TIMEOUT` | `240` | 等演练栈健康的秒数上限 |
| `VANBLOG_DRILL_KEEP` | `0` | `1` = 演练完把一次性栈留着（打印怎么访问、怎么拆） |
| `VANBLOG_DRILL_DRY_RUN` | `0` | `1` = 只打印计划，什么都不碰 |
| `VANBLOG_DRILL_NO_PULL` | `0` | `1` = 不拉镜像（用本地已有的） |
| `VANBLOG_DRILL_SKIP_PREFLIGHT` | `0` | `1` = 跳过归档预检（**坏归档也要演练**时用：截断归档应该得到 HTTP 400 + 完整清理） |
| `VANBLOG_DRILL_SKIP_HASH` | `0` | `1` = 预检时跳过**成员级**哈希比对（merkleRoot 与双清单等其它检查照做）。跳过时会 WARN，并在结论行里明说「这次 PASS 不含逐成员比对」；等价于 `drill --skip-hash` |
| `VANBLOG_DRILL_LOG_TAIL` | `80` | 失败时打印多少行容器日志 |
| `VANBLOG_DRILL_HOME` / `VANBLOG_DRILL_TMPDIR` | 真实 HOME / `$TMPDIR` | 给 podman 换 HOME / 临时目录（镜像存储放在仓库里之类的场景） |
| `VANBLOG_BACKUP_STALE_DAYS` | `7`（`0` = 不查） | `backup-verify`/`backup-status`：最新归档超过这么多天算「陈旧」 |
| `VANBLOG_BACKUP_REVERIFY_DAYS` | `0`（关） | 任何保留归档距上次「验证通过」超过这么多天算过期 |
| `VANBLOG_VERIFY_ALLOW_EMPTY` | `0` | `1` = 「归档里一条文档都没有」从 FAIL 降级成 WARN |

## 内部变量（不是对外契约，别设）

脚本/测试之间的内部交接与探测缓存，行为可能随版本变化：
`VANBLOG_SKIP_MAIN`（只加载函数不执行主流程，drill 复用同一份实现靠它）、
`VANBLOG_MAIN_LOADED`、`VANBLOG_MAIN_SCRIPT`、`VANBLOG_SELF_NAME`、`VANBLOG_SELF_PATH`、
`VANBLOG_SCRIPT_VERSION`、`VANBLOG_CRON_MARKER`、`VANBLOG_DATA_PATH_RAW`、
`VANBLOG_SPACE_EST_BYTES`、`VANBLOG_SPACE_EST_SRC`、`VANBLOG_BUILD_MODE`、
`VANBLOG_HOST_CPUS`、`VANBLOG_HOST_MEM_MB`、`VANBLOG_BUILD_PARALLEL`、
`VANBLOG_ADMIN_BUILD_SCRIPT`（脚本自动选档的内部结果；手动构建用 build-arg
`VAN_BLOG_ADMIN_BUILD_SCRIPT`）、`VANBLOG_BUILD_VIABLE`、`VANBLOG_BUILD_REASON`、
`VANBLOG_SRC_COMMIT`、`VANBLOG_COMPOSE_COND_SUPPORT`、`VANBLOG_CLUSTER_ROLE`、
`VAN_BLOG_SERVER_CWD`、`VAN_BLOG_EMAIL`（caddy 配置生成时的占位符）、
`VANBLOG_DRILL_SKIP_MAIN`，以及测试专用：
`VANBLOG_TEST_ENV_NUM`、`VANBLOG_SEARCH_MONGOD`、`VANBLOG_SEARCH_REALDB`、
`VANBLOG_SEARCH_REALDB_DBPATH`、`VANBLOG_SEARCH_REALDB_PORT`。
