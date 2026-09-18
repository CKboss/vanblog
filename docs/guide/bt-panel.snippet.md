::: tip 温馨提示

VanBlog 现在支持一键脚本部署了。经过测试，宝塔也可以通过一键脚本进行部署。

建议您通过[一键脚本部署](./get-started.md#部署方式)，这样后期可以通过脚本一键升级会方便一些。

如果您想通过图形化部署，请看下文。

宝塔面板自带的 nginx 会占用 80 端口，所以以下教程用的 8880 端口，如果您想关闭 nginx，可以输入 `nginx -s stop`，并把端口映射改为默认的 80 和 443。

否则默认需要您反代 `8880` 端口。

:::

::: warning 下面的模板已经填好本项目的镜像

模板里的 `image: ghcr.io/ckboss/vanblog:v2026.9.2` 就是本项目的镜像（`v2026.9.2` 是固定发布号，
内容永不变，最好复现也最好回滚；标签怎么选见[「docker」那一种部署方式](./get-started.md#部署方式)）。

图形化部署最容易卡在**拉镜像**这一步：宝塔的界面只会告诉你"失败"。所以建议先在宝塔的终端里
手动拉一次，看到 `Status: Downloaded newer image for …` 再回界面创建项目：

```bash
docker pull ghcr.io/ckboss/vanblog:v2026.9.2
```

拉不动（超时、`denied`）通常是服务器连不上 ghcr。两条出路：换一台能访问的机器
`docker pull` + `docker save -o vanblog.tar ghcr.io/ckboss/vanblog:v2026.9.2`，把 tar 传到服务器再
`docker load -i vanblog.tar`；或者干脆用上面的[一键脚本](./get-started.md#部署方式)
（它拉不到镜像时会自动退回源码构建）。

:::

你也可以通过宝塔面板图形化操作部署 VanBlog，具体步骤如下：

### 安装依赖

进入宝塔后台，点击侧边栏 `Docker` ，点击安装按钮。

![安装 Docker](https://www.mereith.com/static/img/ea11d7d7f754edf2303c710071ce540b.clipboard-2022-09-02.png)

耐心等一会，宝塔会自动安装好这些：

![等待安装完成](https://www.mereith.com/static/img/e5b15c94a2a0d38c1f9b9b4ca1dcc8dd.clipboard-2022-09-02.png)

### 添加 docker-compose 模板

如图所示，添加 `docker-compose` 模板，模板名称为 `vanblog`，描述随意。

![安装 Docker Compose](https://www.mereith.com/static/img/d4a56888230de79cc31bbeb603578e02.clipboard-2022-09-03.png)

![等待安装完成](https://www.mereith.com/static/img/9a207817805fb0f0a4b65a85edb699b4.clipboard-2022-09-02.png)

模板内容请复制下面的代码。**只需要改一处**：把 `EMAIL` 换成你自己的邮箱（用于自动申请 https 证书）。
数据目录默认在 `/var/vanblog`，想放别处就整段一起改：

```yaml
version: '3.4'

services:
  vanblog:
    # 本项目的镜像，钉住发布号（内容永不变，好复现也好回滚）
    image: ghcr.io/ckboss/vanblog:v2026.9.2
    restart: always
    environment:
      TZ: 'Asia/Shanghai'
      # 邮箱地址，用于自动申请 https 证书
      EMAIL: 'someone@example.com'
    volumes:
      # 图床文件的存放地址，按需修改。
      - /var/vanblog/data/static:/app/static
      # 日志目录：初始化密钥 setup.key、忘记密码用的 restore.key、整站备份归档都在这里
      - /var/vanblog/log:/var/log
      # Caddy 配置存储
      - /var/vanblog/caddy/config:/root/.config/caddy
      # Caddy 证书存储
      - /var/vanblog/caddy/data:/root/.local/share/caddy
    ports:
      # 前面的是映射到宿主机的端口号，改端口就改前面那个数字。
      # 这里用 8880/4443 是因为宝塔自带的 nginx 占着 80（见本页开头）。
      - 8880:80
      - 4443:443
    depends_on:
      - mongo
  mongo:
    # 本项目按 mongo:7.0 实测。⚠️ 有些老机器 CPU 不支持 avx，跑不了 5.0+，
    #    那种情况才换成 mongo:4.4.16；已经装好的站不要随手换大版本（数据目录会不认）。
    image: mongo:7.0
    restart: always
    environment:
      TZ: 'Asia/Shanghai'
    volumes:
      - /var/vanblog/data/mongo:/data/db
    healthcheck:
      test: ["CMD-SHELL", "mongosh --quiet --eval 'db.runCommand({ping:1}).ok' || mongo --quiet --eval 'db.runCommand({ping:1}).ok'"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 40s
```

所有可用的环境变量详见 [参考 → 环境变量](../reference/env.md)

::: tip 上面两处"多出来的"东西是干什么的

- `depends_on` + mongo 的 `healthcheck`：让 vanblog **等数据库真的能应答了再启动**。
  少了它，第一次启动时 vanblog 常常比 mongo 先起来，日志里一堆连接失败、容器反复重启
  （看着像装坏了，其实等一会儿自己就好了 —— 但新手很难分辨）。
- `version: '3.4'`：`healthcheck` 里的 `start_period` 需要 3.4 及以上的编排格式，
  写 `'3'` 有些旧版 docker-compose 会直接拒绝整个文件。
- ⚠️ 这里 `depends_on` 故意用**最简单的列表写法**（`- mongo`）：带 `condition:` 的长格式
  要 docker-compose ≥ 1.27，宝塔上装的版本不一定够，写长了会整个文件解析失败。

:::

### 启动

如下图所示，新建 `Compose` 项目，名称写 `vanblog`，模板选择刚刚创建的。

![创建项目](https://www.mereith.com/static/img/920dd318b4073cc793c11caa4700d7b9.clipboard-2022-09-02.png)

然后会弹出窗口拉取镜像启动容器（第一次要拉约 890MB 的镜像 + mongo，视网速等几分钟）。

![创建日志](https://www.mereith.com/static/img/193a1acb5f783923ffc83dc67de6fced.clipboard-2022-09-02.png)

**怎么算成功了**：宝塔的 Docker → 容器列表里，`vanblog` 与 `mongo` 两个都是"运行中"。
再到终端里敲这一条确认服务真的活着：

```bash
curl -s http://127.0.0.1:8880/api/public/health
```

回一段带 `"status":"ok"` 和版本号的 JSON 就对了（版本号形如 `v2026.9.2@23f2e9c`）。
如果连接被拒绝，先看容器日志：宝塔界面点容器的"日志"，或 `docker logs --tail 100 vanblog`。

启动完毕后，请 [完成初始化](./init.md)（浏览器打开 `http://你的服务器IP:8880`；
按本页开头说的，用 nginx 反代 8880 之后就可以直接用域名访问了）。

### 调整 nginx 缓存

宝塔用 nginx 反代后，后台发布或更新文章，前台可能仍显示旧内容。这是 `proxy_cache` 在缓存 HTML，缩短缓存时间不够可靠。

请在站点反代的 `location` 里加上：

```nginx
proxy_set_header Host $host;
proxy_no_cache 1;
proxy_cache_bypass 1;
```

并检查 `/www/server/nginx/conf/proxy.conf`：把 `proxy_cache cache_one;` 注释掉（`# proxy_cache cache_one;`），再重载 Nginx。完整说明见 [后台发布后前台不刷新仍显示旧文章](../faq/deploy.md#后台发布后前台不刷新仍显示旧文章)（这个问题最早的报告在上游仓库的 [#469](https://github.com/Mereithhh/vanblog/issues/469)；本项目的问题请到[本仓库的 issue](https://github.com/CKboss/vanblog/issues) 提）。

如果宝塔已有项目较少，还是推荐使用 [nginx-proxy-manager](https://nginxproxymanager.com/) 进行反代管理会更方便。

### 常见问题

::: info 部署失败

请查看容器的日志进行排查。

:::

::: info 端口被占用

需要修改编排文件里的端口映射，改为非常用端口。

![修改端口](https://pic.mereith.com/img/47a03229d46e9120ad1e7bf1abf4b504.clipboard-2022-09-14.png)

如果你只部署 VanBlog ，并想关闭 Ngnix ，请输入以下命令关闭 Ngnix:

```bash
nginx -s stop
```

:::
