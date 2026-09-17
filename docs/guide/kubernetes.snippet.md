以下是一个 kubernetes 的部署参考：

::: tip 镜像选择

下面的 `image:` 用的是本分支镜像 `ghcr.io/ckboss/vanblog:dev-dsh`（也可钉
`v2026.9.2` 这类发布号或 `dev-dsh-<短sha>`）。要装上游官方版就换成 `mereith/van-blog:latest`，
但本分支的功能（整站备份/演练、健康检查语义、零接触初始化等）不在上游镜像里。
ghcr 的包如果是 private，记得给集群配 imagePullSecret。

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
          image: 'ghcr.io/ckboss/vanblog:dev-dsh'
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
          imagePullPolicy: Always
```

::: warning 资源限额与整站备份

上面 500Mi 的 limit 是「空载能跑」的量级。**导出整站备份**用的是 `zstd -19 --long=27 -T0`
（多线程 + 128MB 窗口），峰值能到 1GB 上下 —— 要在集群里做整站备份，请把 limit 放宽，
或调低压缩等级（环境变量 `VANBLOG_BACKUP_ZSTD_LEVEL`，如 `'12'`）。

:::

启动完毕后，请 [完成初始化](./init.md)（也可以用上文的零接触环境变量跳过向导）。
