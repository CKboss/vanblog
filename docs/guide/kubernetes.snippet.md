以下是一个 kubernetes 的部署参考：

::: tip 镜像标签：在集群里请钉死发布号

下面的 `image:` 用的是 **`ghcr.io/ckboss/vanblog:v2026.9.2`**（固定发布号，内容永不变）。

⚠️ **集群里不要用 `latest` / `dev-dsh` 这类会动的标签**。原因很实在：

- `kubectl rollout restart` 之外，Deployment 的 spec 没变 ⇒ 滚动更新根本不会触发，
  你会以为"升级了"，其实每个节点还跑着自己缓存里的旧镜像；
- 各节点在**不同时间**各自拉取，同一个 Deployment 下可能同时跑着两个不同版本；
- 出问题要回滚时，说不清"上一版"到底是哪个 digest。

配套地，`imagePullPolicy` 这样选：

| 你的标签 | 建议 | 为什么 |
| --- | --- | --- |
| `v2026.9.2` 这种发布号 | `IfNotPresent`（下面就是这么写的） | 标签永不变，本地有就不用再拉，省时间也保证跑的就是你钉的那版 |
| `latest` / `dev-dsh` | `Always` | 否则节点会一直用缓存，永远看不到新构建；⚠️ 但即便 `Always` 也解决不了上面的节点间漂移 |

升级 = 把 `image:` 的标签改成新发布号再 `kubectl apply`，回滚就是改回旧标签
（或者用 `kubectl rollout undo`）。

另外两点：镜像**只发布了 linux/amd64**，集群里有 arm64 节点的话要加 `nodeSelector`
（例如 `kubernetes.io/arch: amd64`）避开它们，或者自己构建 arm64 镜像；
ghcr 的包是 public（可匿名拉），如果哪天改成 private，要给集群配 `imagePullSecret`。

:::

```yaml
kind: Deployment
apiVersion: apps/v1
metadata:
  name: van-blog
  labels:
    app: van-blog
spec:
  # ⚠️ 必须是 1 个副本 + Recreate 策略。默认的 RollingUpdate 会**先起新 pod 再停旧 pod**，
  #    而下面的卷是 hostPath：那一小段时间里两个 server 进程会同时写同一份 static、同一个 mongo、
  #    同一份日志与 caddy 目录 —— 静态页面重建互相覆盖、备份归档交错、证书状态打架。
  #    代价是换镜像时会有几秒到十几秒的**中断**（单副本本来也没有高可用可言）。
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: van-blog
  template:
    spec:
      volumes:
        - name: host-time
          hostPath:
            path: /etc/localtime
            type: ''
        - name: static
          hostPath:
            path: /var/k8s/van-blog/static
            type: ''
        - name: log
          hostPath:
            path: /var/k8s/van-blog/log
            type: ''
        # ⚠️ caddy 的两个目录都要挂出来（与 docker compose 模板一致）。
        #    data 里是 **TLS 证书与私钥**：不挂的话每次重建 pod 都要重新向 Let's Encrypt 申请，
        #    而它有速率限制（同一域名每周重复证书数量有限），反复重建几次就可能被暂时拒签。
        #    config 里是 caddy 自己的配置状态，不挂也能跑（会重造），但挂上更省事。
        - name: caddy-config
          hostPath:
            path: /var/k8s/van-blog/caddy/config
            type: ''
        - name: caddy-data
          hostPath:
            path: /var/k8s/van-blog/caddy/data
            type: ''
      containers:
        - name: van-blog
          # 钉死发布号：内容永不变，可复现、好回滚（别用 latest / dev-dsh，理由见上面）
          image: 'ghcr.io/ckboss/vanblog:v2026.9.2'
          # ── 部署层加固：容器仍以 root 运行（裁定如此，本轮不改镜像）──
          # ⚠️ runAsNonRoot 如实写 false：这个镜像就是 root（caddy 要绑 80/443、流水线要 fork、
          #    数据目录是 hostPath）。写出来是为了**不误导**：PodSecurity 的 restricted 档要求
          #    runAsNonRoot:true，所以这份清单**过不了 restricted**，只能用在 baseline 或无策略的命名空间。
          # allowPrivilegeEscalation:false = no-new-privileges，挡的是"在已是 root 之上再提权"
          #    （setuid 二进制、文件 capability），**不是**"防止拿到 root"。已核实本项目安全：
          #    entrypoint.sh / start.js / Dockerfile 里 gosu、su、setpriv、setuid、newgrp 零命中，
          #    chown/chmod 也是 0 处 ⇒ 没有依赖提权的启动步骤。与 compose 模板的 security_opt 同口径。
          # seccompProfile: RuntimeDefault 在 k8s ≥1.25 本来就是默认值，这里显式写出来是为了
          #    "即使集群默认策略变了也不会静默放宽"。
          securityContext:
            runAsNonRoot: false
            allowPrivilegeEscalation: false
            seccompProfile:
              type: RuntimeDefault
            # ⚠️ capabilities 收窄本轮**故意没打开**（与 compose 模板同一理由）：容器以 root 写
            #    **宿主属主**的 hostPath（static / log / caddy / mongo 数据），靠的是 CAP_DAC_OVERRIDE。
            #    `drop: [ALL]` 只加回 NET_BIND_SERVICE 的话，宿主目录属主不是 root 时就**写不进去**
            #    （图片上传失败、日志写不出、备份失败，而且是"pod Running 但功能坏"的难查形状）。
            #    本轮没有集群可实测 ⇒ 想打开就连 DAC_OVERRIDE 一起加，并自己完整验证一遍：
            # capabilities:
            #   drop: [ALL]
            #   add: [NET_BIND_SERVICE, DAC_OVERRIDE, CHOWN, FOWNER]
          ports:
            - name: http-80
              containerPort: 80
              protocol: TCP
            - name: https-443
              containerPort: 443
              protocol: TCP
            # ⚠️ HTTP/3（QUIC）走的是 **UDP** 443，只列 TCP 的话这条路用不了。
            #    Service 与 Ingress/负载均衡那一侧也要放行 UDP 443，
            #    见 [HTTPS](../advanced/https.md)。不需要 HTTP/3 可以删掉这一段。
            - name: https-443-udp
              containerPort: 443
              protocol: UDP
          env:
            # 数据库连接串：换成你自己的 mongo 地址。
            #   不带账号密码： mongodb://van.example.com:27017/vanBlog?authSource=admin
            #   带账号密码：   mongodb://<用户名>:<密码>@van.example.com:27017/vanBlog?authSource=admin
            # ⚠️ 密码里有 @ : / ? 这些字符时要 URL 转义，否则会被当成地址的一部分。
            #    密码建议放 Secret，别明文写在 manifest 里。
            - name: VAN_BLOG_DATABASE_URL
              value: 'mongodb://van.example.com:27017/vanBlog?authSource=admin'
            - name: EMAIL
              value: 'vanblog@example.com'

            # ── 可选：零接触初始化（全新站点在监听前建好管理员，不走网页向导）──
            # 密码请放 Secret（VANBLOG_ADMIN_PASSWORD_FILE 指向挂载的文件路径，
            # 尾部换行会被自动去掉；文件读不到会大声失败，不会静默回落）
            # - name: VANBLOG_ADMIN_USER
            #   value: 'your-admin-name'
            # - name: VANBLOG_ADMIN_PASSWORD_FILE
            #   value: '/run/secrets/vanblog/admin-password'
          # 匿名的健康端点：数据库 ping 不通返回 503（start-period 给足，
          # 冷启动 + 首次连 mongo 很慢；镜像的 HEALTHCHECK 打的也是它）
          readinessProbe:
            httpGet:
              path: /api/public/health
              port: http-80
            initialDelaySeconds: 20
            periodSeconds: 15
            timeoutSeconds: 8
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /api/public/health
              port: http-80
            initialDelaySeconds: 180
            periodSeconds: 60
            timeoutSeconds: 8
            failureThreshold: 3
          # ⚠️ 这里修过一个真缺陷：`limits:` 原来缩进成**容器的同级键**（与 resources 平级），
          #    而它不是合法的 Kubernetes 字段 ⇒ `kubectl apply` 会被严格校验拒绝；若加了
          #    `--validate=false` 就被静默丢弃，**内存与 CPU 上限等于完全没设**。
          #    PyYAML 能解析（它是合法 YAML），所以只有解析后按 k8s 语义检查才发现得了。
          # ⚠️ 数值也别照抄小机器的直觉：整站备份用 `zstd -19 --long=27 -T0`（多线程 + 128MB 窗口），
          #    峰值能到 **1GB 上下**；实测这套站点在并发压测下 RSS 是 568MB～1.1GB。
          #    500Mi 的上限会让**备份被 OOM 杀**（compose 模板里对 mem_limit 有同样的警告）。
          #    节点内存真的紧张时，正确做法是**降低压缩等级**而不是压低上限：
          #    给容器加环境变量 VANBLOG_BACKUP_ZSTD_LEVEL: '12'。
          resources:
            requests:
              memory: '512Mi'
              cpu: '250m'
            limits:
              memory: '1536Mi'
              cpu: '1000m'
          volumeMounts:
            - name: host-time
              readOnly: true
              mountPath: /etc/localtime
            - name: static
              mountPath: /app/static
            - name: log
              mountPath: /var/log
            - name: caddy-config
              mountPath: /root/.config/caddy
            - name: caddy-data
              mountPath: /root/.local/share/caddy
          # 标签是固定发布号 ⇒ IfNotPresent 就够（本地有就不重复拉，且保证跑的是你钉的那版）。
          # 只有用 latest / dev-dsh 这种会动的标签才需要 Always，见上面的表。
          imagePullPolicy: IfNotPresent
```

::: warning 资源限额与整站备份

上面 500Mi 的 limit 是「空载能跑」的量级。**导出整站备份**用的是 `zstd -19 --long=27 -T0`
（多线程 + 128MB 窗口），峰值能到 1GB 上下 —— 要在集群里做整站备份，请把 limit 放宽，
或调低压缩等级（环境变量 `VANBLOG_BACKUP_ZSTD_LEVEL`，如 `'12'`）。

:::

::: note 2026-09-22 更正：`/api/public/health` 现在**也反映前台**了，但下面那条建议**仍然成立**

健康端点新增了公开的 `website` 字段（取值 `up` / `starting` / `down` / `disabled` / `unknown`），并且 🔴 **前台坏死
（`website: "down"`）时状态码会变成 503** ⇒ 只探 `/api/public/health` 的 `livenessProbe` 现在**能**看见前台坏死了。

🔴 **但下面那条 `exec` 探针的建议不要撤掉**，因为两个信号**不等价**：

- `website` 字段反映的是 **server 认为它拉起的那个子进程还在不在**；
- 直接探 `3001` 上的健康探针路径，证明的是**端到端 HTTP 真的能拿到响应**（端口在听、Next 能应答）。

⇒ **子进程活着但端口没在听、或 Next 卡死不响应时，字段会报 `up` 而直接探测会失败。** 另外多进程（cluster）部署下，
非 leader worker 只能报 `unknown`。

⚠️ 还有一个 **60 秒宽限窗口**：前台刚消失时会先报 `starting`（状态码仍 200），60 秒后才转 `down`。这是刻意的防抖动
取舍 —— 否则**每次在后台保存站点信息**（会重启前台子进程）都会让探针失败、进而触发不必要的 pod 重启。

⚠️ **前后端分离部署**（设了 `VANBLOG_DISABLE_WEBSITE=true`）里这个字段报 `disabled`，**保护不到你的前台** ⇒
请直接探测你自己的 website 容器。

:::

::: warning 🔴 只探 `/api/public/health` 不足以证明前台真的在服务，建议改用下面的 `exec` 探针

上面的 `livenessProbe` 打的是 `/api/public/health`。⚠️ **2026-09-22 更正**：这个端点**已经**能反映前台了
（前台坏死超过 60 秒宽限窗口 ⇒ `website: "down"` ⇒ 状态码 503 ⇒ 探针失败 ⇒ pod 会被重启），
所以旧版本这里写的"那个端点只反映数据库连通性、对前台一无所知、前台永久挂掉时探针会一直通过"**已经过时**。

🔴 **但这条建议本身仍然成立**，因为它现在针对的是另一件事 —— **这个端点证明不了"前台真的在服务"**：

- `website` 字段反映的是 **server 认为它拉起的那个子进程还在不在**；
- 直接探容器内 `3001` 上的健康探针路径，证明的才是**端到端 HTTP 真的能拿到响应**（端口在听、Next 能应答）。

⇒ **子进程活着但端口没在听、或 Next 卡死不响应时，字段会报 `up`、状态码仍是 200，而直接探测会失败。**
另外还有三个会让这个端点看不见问题的场景：多进程（cluster）部署下非 leader worker 只能报 `unknown`；
前后端分离部署（`VANBLOG_DISABLE_WEBSITE=true`）下报 `disabled`；以及前台刚坏死的 **60 秒宽限窗口**内报 `starting`
（状态码仍 200，那是刻意的防抖动取舍，否则每次在后台保存站点信息都会触发不必要的 pod 重启）。

这正是 compose 模板与镜像 `HEALTHCHECK` **同时探两处**的原因（80 的 `/api/public/health` + 3001 的
`/__vanblog_health_probe__`，两个都过才算健康），而 [Docker 部署那一页](./docker.snippet.md) 也明确写着
"在 k8s 里把 liveness probe 配成**上面那两个探测**" —— 本清单只配了一个，两份文档口径不一致，这里补齐。

⚠️ **一个容器只能有一个 `livenessProbe`**，所以不能用"再加一个 httpGet"的办法。忠实的等价做法是改用 `exec`，
把 compose 模板里那条**同时探两个端口**的检查原样搬过来：

```yaml
          livenessProbe:
            exec:
              command: ['node', '-e', '<把编排模板 healthcheck 里 test: 的那段 node 单行脚本原样贴进来>']
            initialDelaySeconds: 180
            periodSeconds: 60
            timeoutSeconds: 8
            failureThreshold: 3
```

那段脚本在仓库的 `docker-compose/docker-compose-template.yml` 里（vanblog 服务的 `healthcheck.test`），
它探 80 的 `/api/public/health`（状态码 <500 即过）与 3001 的 `/__vanblog_health_probe__`（**有任何 HTTP 响应即过**，
这个路径是故意不存在的，404 正好，约 1 毫秒）。⚠️ **第二个探测不要改成打首页**：打首页会触发一次真实渲染
（ISR 未命中要读库），高峰期或缓存冷时容易超时，会把"慢但活着"误判成"死了"从而触发重启 —— 那比不探更糟。

⚠️ 如果你不想用 `exec`，那就**明确接受这个盲区**：保留 httpGet 版本，但要知道"前台挂了不会自愈"，
需要靠外部监控（探 3001，或探首页）来发现。

:::

### 部署后确认

```bash
kubectl get pods -l app=van-blog         # READY 应该是 1/1（readinessProbe 打的就是 /api/public/health）
kubectl logs -l app=van-blog --tail=50   # 看启动日志里有没有报错
```

`READY` 一直是 `0/1`，多半是连不上数据库：检查 `VAN_BLOG_DATABASE_URL` 的地址与账号密码，
以及 pod 到那台 mongo 的网络是否放通（上面的示例用的是**集群外**的 mongo）。

### 初始化

启动完毕后，请 [完成初始化](./init.md)。两条路选一条：

- **零接触初始化**（集群里最省事）：把上文注释掉的 `VANBLOG_ADMIN_USER` 与
  `VANBLOG_ADMIN_PASSWORD_FILE`（密码放 Secret）打开，站点在开始监听之前就建好管理员，
  根本不存在"未初始化"窗口，也就不需要初始化密钥。
- **网页向导**：新版默认开启初始化保护。⚠️ 密钥输入框**不是一开始就有**：照常填完向导点提交，
  第一次会被拒绝并提示需要「初始化密钥」（防止别人抢先初始化你的新站），**这时**页面才出现输入框。
  在集群里这样取密钥：

  ```bash
  kubectl logs -l app=van-blog | grep '初始化密钥'
  # 或者读挂出来的日志目录里的 setup.key（上面 manifest 把 /var/log 挂在宿主机 /var/k8s/van-blog/log）
  ```

  密钥每次启动重新生成、未初始化期间每 10 分钟在日志里重印一次，初始化完成后自动失效并删掉文件。
