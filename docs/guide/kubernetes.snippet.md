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
      containers:
        - name: van-blog
          # 钉死发布号：内容永不变，可复现、好回滚（别用 latest / dev-dsh，理由见上面）
          image: 'ghcr.io/ckboss/vanblog:v2026.9.2'
          ports:
            - name: http-80
              containerPort: 80
              protocol: TCP
            - name: https-443
              containerPort: 443
              protocol: TCP
          env:
            - name: VAN_BLOG_DATABASE_URL
              value: >-
                mongodb://some@some@van.example.com:27017/vanBlog?authSource=admin


            - name: EMAIL
              value: >-
                vanblog@example.com

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
          resources:
            requests:
              memory: '300Mi'
              cpu: '250m'
          limits:
            memory: '500Mi'
            cpu: '500m'
          volumeMounts:
            - name: host-time
              readOnly: true
              mountPath: /etc/localtime
            - name: static
              mountPath: /app/static
            - name: log
              mountPath: /var/log
          # 标签是固定发布号 ⇒ IfNotPresent 就够（本地有就不重复拉，且保证跑的是你钉的那版）。
          # 只有用 latest / dev-dsh 这种会动的标签才需要 Always，见上面的表。
          imagePullPolicy: IfNotPresent
```

::: warning 资源限额与整站备份

上面 500Mi 的 limit 是「空载能跑」的量级。**导出整站备份**用的是 `zstd -19 --long=27 -T0`
（多线程 + 128MB 窗口），峰值能到 1GB 上下 —— 要在集群里做整站备份，请把 limit 放宽，
或调低压缩等级（环境变量 `VANBLOG_BACKUP_ZSTD_LEVEL`，如 `'12'`）。

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
- **网页向导**：新版默认开启初始化保护，向导会要你填一个「初始化密钥」
  （防止别人抢先初始化你的新站）。在集群里这样取：

  ```bash
  kubectl logs -l app=van-blog | grep '初始化密钥'
  # 或者读挂出来的日志目录里的 setup.key（上面 manifest 把 /var/log 挂在宿主机 /var/k8s/van-blog/log）
  ```

  密钥每次启动重新生成、未初始化期间每 10 分钟在日志里重印一次，初始化完成后自动失效并删掉文件。
