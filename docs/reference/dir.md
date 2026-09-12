---
title: 目录映射
icon: folder-tree
oder: 3
---

为了持久化配置，VanBlog 会将相关数据存储至相应文件夹。如果你在使用 Docker 之类的容器服务，你需要映射相关目录以确保更新镜像后相关文件不会丢失。

| 容器内目录                 | 说明                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `/app/static`              | 静态数据存放路径：`img/`（图床，其中 `img/thumb/` 是[缩略图](../features/image-storage.md#缩略图)）、`file/`（[附件](../features/attachment.md)）、`customPage/`（自定义页面）、`export/`（打包导出）。使用内置图床或附件请务必映射好！ |
| `/var/log`                 | 日志的存放路径，包括 access 日志、 Caddy 日志和前台服务日志 |
| `/root/.config/caddy`      | Caddy 配置存储路径                                          |
| `/root/.local/share/caddy` | Caddy 证书存储路径                                          |
