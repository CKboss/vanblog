---
title: 访客统计
icon: eye
---

VanBlog 内置了访客统计，开箱即用。

具体而言，VanBlog 会统计每个页面的独立访客数和访问量：

- 访客数： 以浏览器内缓存 (localStorage) 的唯一标识符为衡量标准计算独立访客的数量。
- 访问量： 以每一次页面的访问及跳转为衡量标准计算的访问数量。就是每个页面的访问人次。

<!-- more -->

## 博客展示

文章卡片包含每篇文章的访问量：

![文章访问量](https://pic.mereith.com/img/3c2539ad7586a5a73a68e8cfb58e0957.clipboard-2022-08-16.png)

站点页脚包含全站的访客数和访问量：

![站点访问量](https://pic.mereith.com/img/35aa485d737c99ef73505a8ec3a5e2f9.clipboard-2022-08-16.png)

## 访问分析

::: tip

VanBlog 记录的信息远不止访客数和访问量，它还会记录最近访问的文章、最近访问的时间。每天、每个路径下访问的数量和独立访客的数量。

:::

所有统计数据可在后台的 `分析概览` 中的 `数据概览` 和 `访客统计` 两个标签页中查看。

![数据概览](https://pic.mereith.com/img/3614afa8057c2fb0c078c62cad4e89b1.clipboard-2022-09-23.png)

![访客统计](https://pic.mereith.com/img/067952d6fa53f62b10174690ed3b269a.clipboard-2022-08-16.png)

### 进阶分析

如果你不满足于内置的分析，那你可以选择开启 Google Analytics 和百度统计。也可以用 [定制化](../advanced/customizing.md#接入-umami-等第三方统计) 插入 Umami 等第三方脚本。

::: info 谷歌分析（Google Analytics）

1. 打开 [Google Analytics](https://analytics.google.com/analytics/web)，创建媒体资源 / 数据流。
1. 复制 **测量 ID**。GA4 的格式是 `G-XXXXXXXXX`（例如 `G-ABC12DEF34`）。旧版 Universal Analytics 的 `UA-XXXXXXXXX-X` 也可以，VanBlog 会原样交给 gtag。
1. 后台进入 **站点管理 / 系统设置 / 站点配置 / 高级设置**，粘贴到「Google Analytics 测量 ID」。只填这一串，不要整段粘贴 gtag HTML。留空则不启用。保存后无需重启。

gtag 脚本会以 `async` 在页面加载完成后空闲时注入，访问不到 `googletagmanager.com`（大陆常见超时）时不会卡住前台。

:::

::: warning 谷歌显示「尚未收到数据」？

`G-XXXXXXXXX` 这个格式是对的。更常见的原因是：

- **大陆访问 Google Analytics / Tag Manager API 不通**（控制台里 `googletagmanager.com/gtag/js` 超时）。访客的浏览器打不开这个域名，谷歌就收不到上报。站长在大陆看 Analytics 后台通常也需要代理。
- 新数据流要等一段时间；可先打开 Analytics 的 **实时** 报表，用能访问 Google 的网络打开自己的博客确认。
- 广告拦截、本机 `noViewer`、以及本地 `next dev` 不会注入 gtag（生产 / Docker 前台才会）。

前台转圈见 [FAQ](../faq/usage.md#配置了-google-analysis-后前台一直转圈)。收不到数据见 [FAQ](../faq/usage.md#配置了-google-analytics-但谷歌显示尚未收到数据)。

:::

::: info 百度统计

访问 [百度统计](https://tongji.baidu.com/web5/welcome/login) 官网，并新建站点，设置好之后把站点 ID 填写到 **站点管理 / 系统设置 / 站点配置 / 高级设置** 中的「百度统计 ID」即可，无需重启直接生效。

![ID 是什么](https://pic.mereith.com/img/add80e699b1de58fa55dc8f435077dc4.clipboard-2022-08-16.png)

:::

## 高级

::: tip 屏蔽本设备的访客记录

你可以屏蔽掉自己的访问记录。

请访问博客页面之后打开浏览器的控制台输入：

```js
window.localStorage.setItem('noViewer', true);
```

这样这台设备就不会加入任何的访问统计，同时页面底部的站点访问量将不可用。

:::

## 数据保留与上限（2026-09 起的默认值）

统计数据存在两张**按天**的表里（每天每个路径一行访问量、每天一行访客数）。由于计数接口是
匿名的、路径又可以是任意字符串，这一轮给它们加了几道默认生效的护栏 —— 都只影响
「按天的明细行」，**站点级累计（页脚的总访客/总浏览量）与每篇文章自己的阅读量永不删除**：

| 护栏 | 默认 | 说明 |
| --- | --- | --- |
| 保留期 | **3650 天（10 年）** | 超期的按天明细行会被每日任务删掉（最近 30 天无论如何保留）。⚠️ 旧版默认是「永不删除」：匿名接口能编造路径，每行永久留存等于无限增长。想回到旧行为设 `VANBLOG_VISIT_RETENTION_DAYS=0` |
| 每天新增路径行数上限 | 5000 | 一天之内超过这个数量的**新**路径不再建行（站点/当日总量照记）。防「编造海量路径刷行数」；`VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY=0` 不限 |
| 内存缓冲上限 | 20000 键 | **写库持续失败**期间，内存里的增量键位封顶（超出按「最老那天 → 文章」丢弃并 WARN）。防「Mongo 挂了之后进程稳定长内存」；`VANBLOG_VIEW_MAX_RETAINED_KEYS=0` 不限 |
| 落库节奏 | 5 秒或攒够 1000 条 | 浏览先进内存缓冲、批量落库（一次落库固定 4–6 条 Mongo 命令）；代价是看板计数最多落后一个周期。`VANBLOG_VIEW_FLUSH_MS=0` 改回每次浏览立刻写 |

另外启动时会对历史数据做一次性维护（幂等、记入[迁移台账](../reference/log.md#迁移台账migrations)）：
合并并发首访造成的 `{日期,路径}` 重复行、补建唯一索引、删掉两个被复合索引完全覆盖的冗余索引。
全部环境变量见 [环境变量 → 访问统计与日志](../reference/env.md#访问统计与日志)。
