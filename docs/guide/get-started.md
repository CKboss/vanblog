---
title: 快速上手
icon: lightbulb
order: 1
---

欢迎使用 VanBlog ，只需几个步骤，你就可以在你的服务器搭建自己的博客服务了。**想直接抄命令**（安装 / 更新 / 备份 / 恢复 / 回滚 / 排错）的话，看[命令速查表](./cheatsheet.md)。

<!-- more -->

::: tip

目前 VanBlog 还在快速迭代中，如果后台出现升级提示，推荐进行升级。

:::

## 介绍

<!-- @include: @/info.snippet.md -->

## 配置要求

跑起来很省资源：**不算数据库，空载大约几百 MB 内存**（server + 前台 + caddy + mongo 四个进程），
启动那一阵会吃到一个核心的 30% 左右，其余时间基本不占 CPU。

![资源占用](https://www.mereith.com/static/img/bd2a2c983aa92288106652294a892494.clipboard-2022-09-03.png)

::: info 1核1G 的小机器能装吗

能。一键脚本默认是**拉现成镜像**（不在你的机器上编译），所以 1C1G 也装得下。
只有拉不到镜像时才会退回"下载源码本地构建"，那时后台的打包步骤很吃内存 ——
脚本会先**实测你的 CPU 与可用内存**再决定怎么构建：

- 可用内存 < 3.5GB：后台打包降到 1536MB 堆（慢一点，但不会 OOM）；
- 内存与核数都够：三个前端并行构建，否则串行；
- 可用内存 < 1.8GB：直接劝退并给出两条出路，不让你白等 20 分钟。

自己手动构建时也可以用 `VAN_BLOG_ADMIN_BUILD_SCRIPT=build:lowmem` 指定低内存档位。
2GB 以下的机器，更省事的办法是[在别处构建好镜像再搬过去](../advanced/local-build.md)。

:::

带宽小的话页面首次加载会慢一些（之后有缓存就快了），可以考虑配一下 [CDN](../faq/deploy.md#如何部署到-cdn)。

## 部署方式

:::: tabs#deploy

@tab 脚本

<!-- @include: ./script.snippet.md -->

@tab docker

<!-- @include: ./docker.snippet.md -->

@tab kubernetes

<!-- @include: ./kubernetes.snippet.md -->

@tab 宝塔面板

<!-- @include: ./bt-panel.snippet.md -->

@tab 群晖 NAS

<!-- @include: ./dsm.snippet.md -->

@tab 直接部署

<!-- @include: ./direct.snippet.md -->

::::

## 初始化

无论用哪种方式部署，装完的第一步都是[初始化](./init.md)。有三条路：

- **初始化向导**：打开 `http://<你的域名>/admin/init` 按指引填写；
- **从整站备份恢复**：手里有旧站的 `vanblog-full-*.tar.zst` 时，初始化页最上方的卡片直接上传恢复，不用先走向导；
- **零接触**：给容器设 `VANBLOG_ADMIN_USER` + `VANBLOG_ADMIN_PASSWORD`（或 `VANBLOG_ADMIN_PASSWORD_FILE`），
  站点在监听第一个请求之前就完成初始化，全程不开浏览器。

::: warning 别把「未初始化」的站点长时间暴露在公网

未初始化期间，匿名初始化接口是开着的，谁先请求谁就能把站点初始化成自己的。
新版**默认开启初始化密钥**（`VANBLOG_INIT_REQUIRE_SETUP_KEY`，密钥在日志目录 `setup.key`
与启动日志里，每 10 分钟重印），匿名请求必须携带它；要彻底关掉这个窗口，用零接触初始化
（`VANBLOG_ADMIN_USER` + `VANBLOG_ADMIN_PASSWORD`/`_FILE`）。详见 [初始化](./init.md)。

:::

## 装完之后：验证清单

按顺序过一遍，每一项都能独立暴露一类问题：

1. **健康检查**：

   ```bash
   curl -s http://127.0.0.1:<HTTP端口>/api/public/health
   ```

   正常返回 `statusCode: 200`、`mongo: "up"`（还会带版本号）。返回 **503** = 数据库连不上，
   先查 mongo 容器与 `VAN_BLOG_DATABASE_URL`。这个端点匿名、`no-store` 不缓存，
   镜像的 `HEALTHCHECK` 与编排的健康检查打的就是它，也可以直接接外部 uptime 探测。
   ⚠️ 用 **podman/buildah 构建**的镜像会丢掉 Dockerfile 里的 `HEALTHCHECK` 指令
   （docker buildx 会保留），跑在 podman 系编排上的要自己配健康检查。

2. **登录后台**：`http://<你的域名>/admin`，用初始化时的账号登录，顺手看一眼
   「系统设置 → 关于」里的版本号是否符合预期。

3. **发一篇带图测试文章**：新建草稿 → 上传一张图片 → 发布 → 前台首页与文章页能看到、
   图片能打开。这一步同时验证了图床、静态目录挂载、ISR 增量渲染三条链路。
   测完删掉即可（进回收站，可恢复）。

4. **备份真的能恢复**（脚本部署）：

   ```bash
   ./vanblog.sh backup-verify    # 备份 + 立刻深度校验 + 陈旧检查 + 台账
   ./vanblog.sh drill            # 恢复演练：一次性栈上真恢复一遍并断言语义
   ```

   两条都**不需要 root**。「备份成功」和「备份能恢复成能用的站点」是两件事，
   `drill` 验证的是后者，见 [导入导出 → drill](../advanced/backup.md#证明备份真的能恢复vanblogsh-drill)。

5. **装上定时备份**：

   ```bash
   VANBLOG_ADMIN_TOKEN=<token> ./vanblog.sh install-cron   # 每天 03:00，保留 7 份
   ```

   token 从浏览器 F12 → Application → Local Storage → `token` 取，详见 [备份与迁移](./backup.md#定时备份install-cron-一条命令装好)。

## 新鲜安装的安全清单

- [ ] **初始化窗口已经关上**：新版默认开启初始化密钥（`VANBLOG_INIT_REQUIRE_SETUP_KEY`），
      确认你没有把它显式关掉；自动化装机可以直接用零接触初始化（见 [初始化](./init.md)）。
- [ ] **反代 / CDN 场景**：确认 `VANBLOG_TRUST_FORWARDED_HEADERS`。默认 `auto`（对端是回环/私网才采信
      `X-Forwarded-For` 最右一跳）适合内置 caddy 与本机反代；**CDN/隧道直连源站**（对端是公网代理 IP）要设
      `always`，否则限流与登录防爆破会按代理的 IP 分桶，见 [反代](../reference/reverse-proxy.md)。
- [ ] **swagger 保持关闭**：实时 API 文档默认**关**（这是安全默认值），需要时临时
      `VANBLOG_SWAGGER=true` 打开、用完关掉，见 [API 参考](../reference/api.md)。
- [ ] **备份已定时 + 已验证**：`install-cron` 装上，且跑过一次 `backup-verify`（更严格）与 `drill`。
- [ ] **异地副本**：归档目前只落在本机（`<数据目录>/log/vanblog-backups/`），机器一起丢就全丢 ——
      定期把归档（连同 `.sha256`）拷到另一台机器/对象存储。
- [ ] **强管理员密码 + HTTPS**：内置 caddy 会自动按需签发证书；管理员口令一旦忘记只能走
      日志里的 `restore.key` 恢复流程，见 [忘记密码](../faq/password.md)。
- [ ] 文章/分类的**访问密码不可找回**（服务端只存 scrypt 哈希，任何接口都不回显）：忘了只能在后台
      显式清除/重设，见 [加密文章](../advanced/encrypt.md)。
