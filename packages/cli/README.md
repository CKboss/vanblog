# VanBlog CLI

镜像里的运维小工具，构建时被拷进容器的 **`/app/cli/`**（Dockerfile 的 runner 阶段）。
目前只有一个：

## `resetHttps.js` —— 重置 https 设置（关掉强制跳转，恢复 HTTP / IP 访问）

证书签不出来、域名换过、或 caddy 配置被改坏导致站点只肯走 https 时用。它做两件事：

1. 删掉 `settings` 集合里 `type: 'https'` 的行（会打印删掉了多少条）；
2. 调容器内 caddy 的 admin API（`DELETE 127.0.0.1:2019/config/apps/http/servers/srv1/listener_wrappers`）
   关掉 https 自动重定向；调不通就提示「重启 vanblog 后生效」（返回 404 视为已关，不算失败）。

运行时会先问一句 MongoDB 连接串，**直接回车**就用默认的
`mongodb://mongo:27017/vanBlog?authSource=admin` —— `mongo` 是编排里的服务名，所以这个默认值
**只在容器内有效**；stdin 不是 tty 时不等输入、直接用默认值（因此可以被脚本化调用）。

### 在容器里怎么跑

```bash
docker exec -it <vanblog 容器名> node /app/cli/resetHttps.js     # docker
podman exec -it <vanblog 容器名> node /app/cli/resetHttps.js     # podman
```

跑完如果页面还在跳转，重启一次 vanblog 容器即可。

### 这个包不是库

`package.json` 里**故意没有 `main`**：包里的东西是给人（和一键脚本）用 `node <文件>` 直接跑的脚本，
没有任何地方 `require('vanblog-cli')`（全仓库搜过，包名只出现在它自己的 package.json 里）。
以前写着 `"main": "index.js"`，而 `index.js` 根本不存在 —— 那只会让人以为可以 import。
`license` 也从 npm init 的默认值 `ISC` 改成了 **`GPL-3.0`**，与仓库根的 `LICENSE` 一致。

### 与 `./vanblog.sh reset_https` 的关系

⚠️ 子命令是**下划线**的 `reset_https`（不是 `reset-https`）。用一键脚本部署的话优先用它，
它把这件事包得更完整：清本机的 caddy / https 重定向配置文件 → 清库里的 https 设置 →
重启容器 → 复查「确实不再强制跳转」，任一步没成都会明确报错而不是静默通过。
其中「清库」那一步有四级兜底：`mongo` shell → `mongosh` → 一段内联 node → **最后才是本脚本**。

也就是说：这个工具既是脚本的**最后一道兜底**，也是没有一键脚本时（K8s、自己写的 compose、裸机）
的等价手动做法。
