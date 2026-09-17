---
title: 初始化
icon: rotate
order: 2
---

<!-- @include: ./init.snippet.md -->

![初始化指引](https://pic.mereith.com/img/c088fa93f4e7aeab33dac821d1dc7dc5.clipboard-2022-08-16.png)

## 初始化向导

初始化流程包含四部分：

- 配置用户: 必填
- 基本配置: 网站运行的必要配置
- 高级配置: 可选，用于开启一些高级功能
- 布局配置: 可选，配置前台布局

::: warning 初始化窗口是匿名的

站点**未初始化**期间，`POST /api/admin/init`（向导）与 `POST /api/admin/init/restore`
（备份恢复）都是匿名接口，唯一的闸门是「库里还没有用户」。也就是说：从容器启动到你走完
向导之间，任何知道地址的人只需要**一个请求**就能抢先把站点初始化成自己的（限流只约束
重试次数，约束不了那一次成功的请求）。现在有两条对策：

- **初始化密钥默认开启**：两条匿名接口都必须携带 `<日志目录>/setup.key` 里的密钥，
  抢先初始化从「一个请求」变成「先拿到你机器上的密钥文件/日志」，见下文；
- 用[零接触初始化](#零接触初始化环境变量直接建好管理员)让这个窗口**根本不存在**。

:::

## 从整站备份恢复（换新机器最省事）

手里已经有旧站的整站备份归档（`vanblog-full-*.tar.zst`）时，**不要**先走向导再登录再上传：
初始化页最上方有独立的「已有整站备份？直接恢复」卡片，直接上传归档即可。它会恢复数据库 +
静态目录（图床、附件、自定义页面、主题），自动拉起评论服务、重启前台并触发一次全量渲染，
完成后**用备份里原来的账号登录**。细节与注意事项（比如「归档里没有 users 时站点仍是未初始化」）
见 [导入导出 → 在新机器的初始化页直接恢复](../advanced/backup.md#在新机器的初始化页直接恢复不用先建管理员)。

用一键脚本装机的话，这一步还可以再省掉：安装时直接
`VANBLOG_RESTORE_FROM=/path/to/vanblog-full-xxx.tar.zst ./vanblog.sh install`，
或装完跑 `./vanblog.sh reset <归档>`，见 [备份与迁移](./backup.md#换新机器一条命令把整站搬过去)。

## 零接触初始化（环境变量直接建好管理员）

给容器设置这三个环境变量，全新站点会在**开始监听 HTTP 之前**就完成初始化 ——
「未初始化窗口」从部署流程里整个消失，也不需要打开浏览器走向导：

| 变量 | 说明 |
| --- | --- |
| `VANBLOG_ADMIN_USER` | 管理员用户名（必填，不能是空白） |
| `VANBLOG_ADMIN_PASSWORD` | 管理员密码（与 `_FILE` 二选一） |
| `VANBLOG_ADMIN_PASSWORD_FILE` | 密码文件路径（例如 Docker secret 挂载进来的文件）。**优先于**内联变量 |

行为契约（都写死在实现里，见 `packages/server/src/provider/init/envBootstrap.ts`）：

- `_FILE` 的内容按 secret-file 惯例只去掉**尾部**换行/空白（前导空白算密码本身）；
  文件读不到时**大声失败**（ERROR 日志 + 站点保持未初始化），绝不静默回落到内联变量；
- 站点**已经**初始化过时，这三个变量被忽略（日志里 INFO 说明一句），不会覆盖已有账号 ——
  改密码请登录后到后台「账号设置」；
- 校验口径与向导一致：缺用户名、空密码会被拒绝并打 ERROR（密码本身永不进日志）；
- 初始化成功后日志里会有一条 WARN，写明管理员用户名与密码来源（内联还是文件），
  并记入迁移台账（`install:initialised`，route=`env-bootstrap`）。

docker compose 示例（docker/宝塔/群晖部署同理，把变量加进编排的 `environment:`）：

```yml
services:
  vanblog:
    environment:
      VANBLOG_ADMIN_USER: 'your-admin-name'
      # 内联方式（简单，但密码会出现在编排文件与 docker inspect 里）：
      VANBLOG_ADMIN_PASSWORD: 'a-strong-unique-password'
      # 或者用文件方式（推荐；把 secret 挂进容器）：
      # VANBLOG_ADMIN_PASSWORD_FILE: '/run/secrets/vanblog_admin_password'
```

用一键脚本装机的话：`./vanblog.sh install` 生成编排文件后，把上面两行加进
`<安装目录>/docker-compose.yaml` 里 vanblog 服务的 `environment:` 段，再
`./vanblog.sh restart`。⚠️ 之后如果跑 `./vanblog.sh config` 重新生成编排，自定义的
environment 会被模板覆盖（脚本会先存一份 `.bak-<时间戳>`），记得把这几行加回去。

::: tip 初始化之后

零接触初始化只建账号，站点信息是最小集（站点名 `VanBlog`、作者 = 用户名）。
装完请登录后台，把 `站点管理/系统设置` 里的站点名、域名、布局等补齐，见 [站点设置](../features/config.md)。

:::

## 初始化密钥（setup key）

`VANBLOG_INIT_REQUIRE_SETUP_KEY` **默认就是开启的**（新版起）。只要站点还没初始化，
匿名初始化就必须携带一把只有你能拿到的密钥：

- 每次启动生成一把 32 字节随机密钥，写进 **`<日志目录>/setup.key`**（权限 0600；
  容器里是 `/var/log/setup.key`，脚本安装对应宿主机的 `<数据目录>/log/setup.key`，
  也就是你映射出来的日志目录），同时在启动日志里 **WARN 打印**，并且**每 10 分钟重印一次**
  直到完成初始化（间隔用 `VANBLOG_SETUP_KEY_REMIND_MINUTES` 调，显式设 `0` = 只在启动时印一次）；
- `POST /api/admin/init` 与 `POST /api/admin/init/restore` 都必须携带这把密钥
  （字段名 `setupKey`；初始化页会自动出现一个密钥输入框，脚本/接口调用则放进 JSON
  或 multipart 的文本字段）；
- 密钥**每次重启都重新生成**（旧密钥即刻作废），比较是常量时间的；
- 站点初始化成功后密钥文件被**自动删除**，重印定时器停止，之后启动也不再生成 ——
  它只在未初始化期间有意义；
- 开关值打错（比如 `ture`）会**回落到开启**（安全的一侧）并在启动日志 WARN 点名，
  绝不会因为一个 typo 把保护静默关掉。

::: warning 升级注意 / 怎么关

这是**有意的破坏性变更**：老版本的初始化页不发送 `setupKey` 字段，所以「正走到一半」
（容器已起、向导还没走完）的安装在升级后需要先从日志/`setup.key` 里取密钥填进初始化页。
已经完成初始化的站点**完全不受影响**（密钥只在未初始化期间生成与校验）。

确实不想要这层保护（例如全内网、自动化装机另有闸门）时显式关闭：

```yml
environment:
  VANBLOG_INIT_REQUIRE_SETUP_KEY: 'false'
```

关掉之后匿名初始化接口回到「只有限流兜底」的旧行为 —— 公网部署不建议。

:::

::: tip setup.key 和 restore.key 不是一回事

日志目录里可能出现两个密钥文件：`setup.key` 只服务于**未初始化期间**的初始化/恢复接口，
初始化成功即删除；`restore.key` 是**「忘记密码」**的恢复密钥，长期存在、每次启动重新生成，
见 [忘记密码](../faq/password.md)。

:::

## 装完之后的验证与安全清单

见 [快速上手 → 装完之后](./get-started.md#装完之后验证清单)：健康检查、登录、发一篇带图文章、
备份演练，以及一份新鲜安装的安全检查清单。
