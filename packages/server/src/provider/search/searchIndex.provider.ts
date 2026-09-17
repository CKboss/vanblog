import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import cluster from 'node:cluster';
import fs from 'fs';
import path from 'path';

import { config } from 'src/config';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import { version as codeVersion } from 'src/utils/loadConfig';
import { ArticleProvider } from '../article/article.provider';
import { SiteMapProvider } from '../sitemap/sitemap.provider';
import {
  SEARCH_INDEX_ENABLED_ENV,
  SearchIndexFile,
  buildSearchIndex,
  resolveSearchIndexMaxDocs,
  resolveSearchIndexSnippetChars,
  searchIndexEnabled,
  searchIndexUrl,
  serializeSearchIndex,
} from './searchIndexBuild';

/**
 * 构建期/事件驱动的**静态搜索索引**：`<staticPath>/search/index.json`。
 *
 * ## 为什么是静态文件，不是一个搜索接口
 *
 * 今天的搜索是 `GET /api/public/search` → `ArticleProvider.searchByString`：
 * 对 title/tags/category/**content** 四个字段各跑一次 Mongo `$regex`（匿名接口、无分页、
 * `limit(200)` + `maxTimeMS(5000)`），然后把候选整批拉进 Node 再做一次 JS `includes` 复筛。
 * 也就是说**每一次按键都是一轮全表正则扫描**，而正则扫不了索引、只能用 CPU；
 * 一个热门词被 20 个人同时搜，就是 20 轮全表扫描。它也没有排序（返回顺序 = 库的返回顺序）、
 * 没有结果页、没有高亮。
 *
 * 改成"server 生成一份紧凑索引 + 浏览器里搜"之后：
 *  - **匿名请求的数据库成本降到 0**（索引是 caddy/serve-static 直接发的静态文件，还能被 CDN 缓存）；
 *  - 排序、分页、高亮都成了纯客户端的、可以单测的函数；
 *  - 生成成本被**合并**到本来就要跑的那一轮 ISR 风暴里（RSS 要渲染 50 篇全文 markdown = 135 ms，
 *    索引这点开销在同一条路上，见下面的实测）。
 *
 * ## 实测（本机真库 53 篇，只读；量具 vanblog_dev/search-index-live.ts）
 *
 * | | 值 |
 * | --- | --- |
 * | 生成一轮（中位数，含查库） | **33 ms**（冷启动第一轮 70 ms） |
 * | ↳ 查库（`getSiteEntries` + `getAll('public')`） | 28 ms |
 * | ↳ 纯构建 + 序列化（CPU） | **5 ms** |
 * | 每篇 | 0.62 ms（其中 CPU 部分 0.09 ms） |
 * | `index.json` | **29,222 B**，gzip **13,705 B**（551 B/篇，gzip 259 B/篇） |
 * | 1000 篇外推（999/1000 篇摘要互不相同） | 原始 **611 KB**，gzip **126 KB** |
 * | 对照：一次 `/api/public/search?value=的` | 19–28 ms（客户端索引搜索 **1 ms**） |
 * | 对照：既有静态产物 | `rss/feed.xml` 285 KB→81 KB gzip；`sitemap.xml` 15 KB→2.5 KB |
 *
 * ⚠️ 报的是**字节**（`Buffer.byteLength`），不是 JS 的 `string.length` —— 后者是 UTF-16 码元数，
 * 中文一个字算 1 而 UTF-8 占 3 字节，第一版量具就是这么把 29 KB 报成了 16 KB。
 * ⚠️ 1000 篇的 gzip 有两个口径：滑动窗口取真文本是 126 KB（偏乐观，窗口之间仍有重叠），
 * 按 53 篇实测的每篇字节线性外推是 253 KB（偏悲观，小文件的压缩比天然差）。真值在这两者之间。
 * ⚠️ CJK 摘要压不动：53 篇时 gzip/raw = 0.469（对照 sitemap.xml 的 0.164，那是重复的 ASCII URL）。
 * 语料涨上去之后这个文件会变成"每个搜索者都要下载的最大静态产物"，
 * 到那时先调小 `VANBLOG_SEARCH_INDEX_SNIPPET_CHARS`（200 → 120 大约能省 40% 字节），
 * 再考虑 `VANBLOG_SEARCH_INDEX_MAX_DOCS`。
 *
 * ## 刻意沿用的既有机制（不要另造一套）
 *
 * 与 `provider/rss/rss.provider.ts` / `provider/sitemap/sitemap.provider.ts` **同一条铁轨**：
 *  - `generateSearchIndex(info?, delay?)` 防抖 → `generateSearchIndexFn(info?)`；
 *  - 从 setTimeout 里"发出去就不管"地调 ⇒ **整段必须自己 try/catch**，错误带上来源
 *    （sitemap 那次加固修的就是"一条没有出处的 unhandledRejection"，见 sitemap.provider.ts:39-45）；
 *  - `fs.promises`（不用 `writeFileSync`：这个文件在 1000 篇量级是 MB 级的，同步写会把事件循环按住）；
 *  - 先写 `index.json.tmp-<pid>` 再 `rename`（同文件系统内 rename 是原子的）。
 *    ⚠️ 这一条不是洁癖：`/static/search/index.json` 是匿名可直接下载的，原地覆盖会让
 *    正在搜索的访客读到半截 JSON —— `JSON.parse` 直接抛错，前端就以为"索引坏了"而回退，
 *    而这恰恰是 sitemap 那轮已经修掉的同一个故障。
 *  - `<staticPath>` 下的东西已经由 `main.ts` 的 `useStaticAssets(staticPath, {prefix:'/static/'})`
 *    发出去了 ⇒ **不需要新的 mount，也不需要改 caddy**：写完就是 `/static/search/index.json`。
 *    并且 `utils/staticGuard.ts` 的匿名 403 名单是 `{export, tmp, upload-tmp}`，
 *    `search` 不在里面（有 spec 钉住）。
 *
 * ## "谁能进索引"这件事，我一行谓词都没写
 *
 * 索引收录的文章集合 = **`SiteMapProvider.getSiteEntries()` 给出的 `/post/**` 条目集合**。
 * 也就是说：软删、`hidden`、`private`、私有分类下的文章、`publishAt` 还没到点的定时文章，
 * 全部由 sitemap 那一个谓词挡掉（§7.57-E/H 的口径），我只是拿它的输出当**白名单**去过滤
 * `ArticleProvider.getAll('public', false, false)` 的结果。
 *
 * 为什么值得多花那几个查询：这是一份**世界可读的 JSON 文件**。一篇定时文章的标题、
 * 或者一篇加密文章的标题出现在里面，就等于把 §7.57-E/H 修掉的泄露重新打开
 * （"2026 年裁员名单"这种标题本身就是全部秘密）。自己再写一遍 private/publishAt 判定，
 * 得到的不是"多一层保险"，而是"两个谓词慢慢漂开"——§7.57-H 那张
 * 「每个公开面 × private × publishAt」审计表存在的原因正是它。
 * 有 spec 直接断言"索引的 url 集合 == sitemap 的 /post/** 集合"。
 */
@Injectable()
export class SearchIndexProvider {
  logger = new Logger(SearchIndexProvider.name);
  timer = null;

  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly sitemapProvider: SiteMapProvider,
  ) {}

  /**
   * 兜底 cron：每小时第 5 分钟。
   *
   * 为什么需要它：正常路径是 `ISRProvider.activeAll` 里那一行
   * （`isr.provider.ts` 的 `TODO(search-index)` 注释已经写好了位置与要求，
   * 本轮由另一个 agent 落地），但**在它接上之前**，索引只有这个 cron 会生成。
   * 接上之后它继续留着当保险：activeAll 的那次触发要是丢了（website 容器正在重启、
   * 网络抖一下、风暴被合并掉），索引不至于永远停在旧内容上 ——
   * 这与 §7.57 给 `revalidate` 加"24 小时长保险"是同一个理由。
   *
   * 选 :05 而不是 :00：`schedule/isr.task.ts` 的整点 ISR cron 在 :00 触发，
   * 而那一轮风暴本身就会（接上之后）顺带生成索引；错开 5 分钟免得两件事挤在同一秒。
   *
   * ⚠️ `isPrimaryInstance(cluster)` 守卫与 ISRTask 同理：多进程部署时这份活只能干一次
   * （写的是同一个文件），单进程时 `cluster.isPrimary === true`，判断恒真。
   */
  @Cron('0 5 * * * *')
  async handleCron() {
    if (!isPrimaryInstance(cluster)) {
      return;
    }
    await this.generateSearchIndex('定时触发（每小时兜底）', 0);
  }

  /**
   * 防抖入口，与 `generateRssFeed` / `generateSiteMap` 同形状。
   *
   * 默认防抖 60s（与 sitemap 一致，不是 RSS 的 3 分钟）：索引比 feed 便宜得多，
   * 而且"改完文章 1 分钟内能搜到"比"省一次生成"更符合搜索的预期。
   * ⚠️ `delay=0` 是合法的（cron 与"后台刚保存"要立刻出新索引），而 rss/sitemap 那句
   * `delay || 60*1000` 会把 0 变成 60s —— 这里换成显式的"是有限非负数才用它"。
   * 垃圾值（NaN / 负数 / 非数字）回落 60s，**不会**被 `setTimeout` 当成 1ms 立刻跑。
   */
  async generateSearchIndex(info?: string, delay?: number) {
    if (!searchIndexEnabled()) {
      // ⚠️ 关掉必须**真的**关掉：只"不再生成"是不够的 —— 盘上那份旧索引还在，
      // `/static/search/index.json` 还是 200，前台会继续用它，于是"关掉搜索索引"
      // 变成"索引永远停在关掉那一刻"，而页面上只有一行"索引已有 N 小时没更新"。
      // 所以要顺手把旧文件删掉（它是可再生产物，备份分类里也登记成 DERIVED）。
      this.logger.debug(`${SEARCH_INDEX_ENABLED_ENV} 关掉了搜索索引，跳过生成`);
      await this.removeIndexWhenDisabled(info);
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const wait = typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? delay : 60 * 1000;
    this.timer = setTimeout(() => {
      // ⚠️ 不 await、也不 .catch：generateSearchIndexFn 自己兜住所有错误。
      this.generateSearchIndexFn(info);
    }, wait);
  }

  /**
   * 功能被关掉时清掉旧索引，让前台干净地退回服务端搜索。
   *
   * ⚠️ 删除的范围被刻意收得很窄：**只** `unlink` `<staticPath>/search/index.json` 这一个
   * 写死的文件名 —— 不删目录、不用通配、不先列目录再挨个删。
   * 自己兜住所有错误（它可能是从 fire-and-forget 的路径上调进来的）。
   */
  async removeIndexWhenDisabled(info?: string): Promise<void> {
    try {
      const filePath = path.join(config.staticPath, 'search', 'index.json');
      await fs.promises.unlink(filePath);
      this.logger.log(
        `搜索索引已关闭（来源：${info || '未注明'}），删掉了旧的 index.json，前台将退回服务端搜索`,
      );
    } catch (err: any) {
      // ENOENT = 本来就没有，这是最常见的情况，不该刷屏
      if (err?.code !== 'ENOENT') {
        this.logger.error(
          `删除旧搜索索引失败（来源：${info || '未注明'}）：${err?.message || err}`,
        );
      }
    }
  }

  /**
   * 真正干活的那个。**必须自己兜住所有错误**（它是从 setTimeout 里发出去的）。
   *
   * 返回构建好的索引对象（成功时）或 `null`（关闭 / 失败）—— 只是为了可测，
   * 调用方一律不看返回值。
   */
  async generateSearchIndexFn(info?: string): Promise<SearchIndexFile | null> {
    const startedAt = Date.now();
    this.logger.log(`${info || '未注明来源'}：重新生成搜索索引`);
    try {
      if (!searchIndexEnabled()) {
        // 直接调 Fn（比如单测、或以后的手动触发）也要遵守"关掉就是真的关掉"
        await this.removeIndexWhenDisabled(info);
        return null;
      }
      const maxDocs = resolveSearchIndexMaxDocs();
      const snippetChars = resolveSearchIndexSnippetChars();

      // ① 合格文章白名单：直接复用 sitemap 的条目（含 private / 私有分类 / publishAt / hidden / 软删 过滤）
      const entries = await this.sitemapProvider.getSiteEntries();
      const allowed = new Set<string>();
      for (const entry of entries || []) {
        const url = String((entry as any)?.url || '');
        if (url.startsWith('/post/')) {
          allowed.add(url);
        }
      }

      // ② 内容：`getAll('public', …)` 的投影带 content，且已按 createdAt 倒序（= 最新的在前），
      //    过滤条件与 sitemap 用的 `getAll('list', …)` 是同一个方法、同一组 $and。
      const articles = (await this.articleProvider.getAll('public', false, false)) as any[];
      const qualified = (articles || []).filter((raw) => {
        const article = raw?._doc || raw;
        return allowed.has(searchIndexUrl(article));
      });

      // ③ 构建（纯函数）+ 原子写盘
      const index = buildSearchIndex(qualified, {
        maxDocs,
        snippetChars,
        codeVersion: String(codeVersion || 'dev'),
        generatedAt: new Date(),
      });
      await this.writeIndexAtomically(serializeSearchIndex(index));

      const cost = Date.now() - startedAt;
      this.logger.log(
        `搜索索引已生成：${index.count}/${index.total} 篇` +
          `${index.truncated ? `（已截断到最新 ${maxDocs} 篇）` : ''}，` +
          `摘要 ${snippetChars} 字，耗时 ${cost} ms`,
      );
      return index;
    } catch (err) {
      // 带上来源：这条日志是"索引为什么停在旧内容上"的唯一线索（sitemap 那轮的教训）
      this.logger.error(
        `生成搜索索引失败（来源：${info || '未注明'}）：${(err as Error)?.message || err}`,
      );
      return null;
    }
  }

  /**
   * tmp + rename 的原子写。失败时**尽力**把 tmp 清掉（否则静态目录里会攒一堆
   * `index.json.tmp-<pid>`，而备份分类守卫会把它当成"没人认领的目录内容"）。
   */
  async writeIndexAtomically(payload: string): Promise<void> {
    const dir = path.join(config.staticPath, 'search');
    await fs.promises.mkdir(dir, { recursive: true });
    const finalPath = path.join(dir, 'index.json');
    const tmpPath = path.join(dir, `index.json.tmp-${process.pid}`);
    try {
      await fs.promises.writeFile(tmpPath, payload);
      await fs.promises.rename(tmpPath, finalPath);
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }
}
