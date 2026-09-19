import { CategoryProvider } from '../category/category.provider';
import { Injectable, Logger } from '@nestjs/common';

import { ArticleProvider } from '../article/article.provider';
import { Feed } from 'feed';
import { MetaProvider } from '../meta/meta.provider';
import { SettingProvider } from '../setting/setting.provider';
import fs from 'fs';
import path from 'path';
import { config } from 'src/config';
import { MarkdownProvider } from '../markdown/markdown.provider';
import { washUrl } from 'src/utils/washUrl';

/** 订阅源默认保留多少条（0 = 不限制）。可用 VANBLOG_RSS_ITEM_LIMIT 覆盖。 */
export const DEFAULT_RSS_ITEM_LIMIT = 50;

@Injectable()
export class RssProvider {
  logger = new Logger(RssProvider.name);
  timer = null;

  static itemLimit(): number {
    const raw = process.env.VANBLOG_RSS_ITEM_LIMIT;
    if (raw === undefined || raw === '') {
      return DEFAULT_RSS_ITEM_LIMIT;
    }
    const n = Number(raw);
    // 负数/NaN 一律当默认值；0 是合法的（表示不限制）
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RSS_ITEM_LIMIT;
  }
  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly metaProvider: MetaProvider,
    private readonly settingProvider: SettingProvider,
    private readonly markdownProvider: MarkdownProvider,
    private readonly categoryProvider: CategoryProvider,
  ) {}

  async generateRssFeed(info?: string, delay?: number) {
    // 生成 RSS 订阅需要遍历全部文章数据，所以防抖时间长一点吧。
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => {
        this.generateRssFeedFn(info);
      },
      delay || 3 * 60 * 1000,
    );
  }

  async generateRssFeedFn(info?: string) {
    this.logger.log(info + '重新生成 RSS 订阅');
    try {
      let articles = await this.articleProvider.getAll('public', false, false);
      // ⚠️ 订阅源只保留**最新 N 条**。以前是把全站文章连正文全部渲染一遍：
      // 实测 53 篇的 markdown-it + highlight.js + katex = **135ms 同步阻塞事件循环**，
      // 三份 feed 各约 350KB（全文、无条数上限），而这件事每小时跑一次、每次启动跑一次、
      // 每次编辑文章后 3 分钟再跑一次。文章只会越来越多，这是一条线性增长的定时炸弹。
      // 50 条对阅读器来说已经很宽裕（多数阅读器只显示最新几十条），
      // 想全量就把 VANBLOG_RSS_ITEM_LIMIT 设成 0。
      const limit = RssProvider.itemLimit();
      const totalArticles = articles.length;
      if (limit > 0 && articles.length > limit) {
        articles = [...articles]
          .sort((a: any, b: any) => {
            const ta = new Date(a?.createdAt || 0).getTime();
            const tb = new Date(b?.createdAt || 0).getTime();
            return tb - ta;
          })
          .slice(0, limit);
        this.logger.log(`订阅源只保留最新 ${limit} 条（共 ${totalArticles} 篇，其余不进 feed）`);
      }
      // 分类整体加密时，分类下的文章同样不能在 RSS 里给出全文。
      // 以前只判断了 article.private，加密分类的文章正文会被原样发布到订阅源。
      const allCategories = ((await this.categoryProvider.getAllCategories(true)) ||
        []) as any[];
      const privateCategories = new Set<string>(
        allCategories.filter((c) => c?.private).map((c) => String(c?.name)),
      );
      articles = articles.map((a: any) => {
        const article = a?._doc || a;
        if (article.private || privateCategories.has(String(article.category))) {
          return { ...article, content: '此文章已加密' };
        } else {
          return article;
        }
      });
      const meta = await this.metaProvider.getAll();
      const walineSetting = await this.settingProvider.getWalineSetting();
      let email = process.env.EMAIL;
      if (walineSetting && walineSetting?.authorEmail) {
        email = walineSetting?.authorEmail;
      }
      const author = {
        name: meta.siteInfo.author,
        email,
        link: meta.siteInfo.baseUrl,
      };
      const siteUrl = washUrl(meta.siteInfo.baseUrl);
      const favicon =
        meta.siteInfo.favicon ||
        meta.siteInfo.siteLogo ||
        meta.siteInfo.authorLogo ||
        `${siteUrl}logo.svg`;
      const siteLogo =
        meta.siteInfo.siteLogo ||
        meta.siteInfo.authorLogo ||
        meta.siteInfo.favicon ||
        `${siteUrl}logo.svg`;
      const date = new Date();
      const feed = new Feed({
        title: meta.siteInfo.siteName,
        description: meta.siteInfo.siteDesc,
        id: siteUrl,
        link: siteUrl,
        // 语言标签用规范写法（RFC 5646 是大小写不敏感，但 zh-CN 更常见也更保险）
        language: 'zh-CN',
        image: siteLogo,
        favicon: favicon,
        copyright: `All rights reserved ${date.getFullYear()}, ${meta.siteInfo.author}`,
        updated: date,
        generator: 'Feed for VanBlog',
        feedLinks: {
          rss2: `${siteUrl}rss/feed.xml`, // xml format
          json: `${siteUrl}rss/feed.json`, // json fromat
        },
        author,
      });
      for (const article of articles) {
        const url = `${siteUrl}post/${article.pathname || article.id}`;
        // siteUrl 已经被 washUrl 处理成带尾斜杠的形式，这里再拼一个 '/' 会变成双斜杠
        const base = siteUrl.replace(/\/+$/, '');
        const category = {
          name: article.category,
          domain: `${base}/category/${encodeURIComponent(article.category || '')}`,
        };
        // 标签也一并给出去：feed 阅读器（以及部分聚合站）会拿 category 做分组
        const categories = [category].concat(
          (Array.isArray(article.tags) ? article.tags : [])
            .filter((t: any) => typeof t === 'string' && t.trim())
            .slice(0, 10)
            .map((t: string) => ({
              name: t,
              domain: `${base}/tag/${encodeURIComponent(t)}`,
            })),
        );
        const html = `<div class="markdown-body rss">
      <link rel="stylesheet" href="${siteUrl}markdown.css">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.6.0/build/styles/default.min.css">
      ${this.markdownProvider
        .renderMarkdown(article.content)
        .replace(
          /<div class="mermaid">/g,
          `<div class="mermaid" style="background: #f3f3f3; padding: 8px;"> <p>Mermaid 图表 RSS 暂无法显示，具体请查看原文</p>`,
        )}</div>`;
        feed.addItem({
          title: article.title,
          id: url,
          link: url,
          description: this.markdownProvider.renderMarkdown(
            this.markdownProvider.getDescription(article.content),
          ),
          category: categories,
          content: html,
          author: [author],
          contributor: [author],
          date: new Date(article.createdAt),
          published: new Date(article.updatedAt || article.createdAt),
        });
      }
      const rssPath = path.join(config.staticPath, 'rss');

      await fs.promises.mkdir(rssPath, { recursive: true });
      // 三份序列化结果各约 350KB（大站更大），writeFileSync 会把事件循环按住一会儿；
      // 这里本来就在异步函数里，没有理由用同步 IO。
      //
      // ⚠️ **先写 pid 后缀的临时文件再 rename**，与 sitemap.provider 同款
      //    （`sitemap.xml.tmp-${process.pid}` → rename）。`fs.promises.writeFile` 是
      //    "先截断再写"，而 `/rss/feed.xml`、`/rss/atom.xml`、`/rss/feed.json` 都是
      //    **匿名可直接下载**的静态文件（caddy 直发，不经 Node）：原地覆盖会让正在拉的
      //    订阅器读到半截 XML/JSON —— 对阅读器来说"解析失败"比"读到旧内容"糟得多，
      //    多数阅读器会把解析失败的源标成错误并退避重试。同一文件系统内的 rename 是原子的，
      //    所以读者要么看到完整的旧文件、要么看到完整的新文件。
      //    tmp 名带 pid 是因为多进程（cluster）下两个 worker 可能同时在生成
      //    （主实例的整点 cron + 某个 worker 处理了文章保存），共用一个 tmp 名会互相截断。
      //
      // ⚠️ 这里**故意不加** `isPrimaryInstance(cluster)` 守卫（与 sitemap 保持一致）：
      //    会"乘以核数"的两个批量触发点已经在**上游**被主实例守卫挡住了 ——
      //    启动首轮全量渲染在 `main.ts` 的 `if (primary)` 里，整点 ISR cron 在
      //    `schedule/isr.task.ts` 的 `isPrimaryInstance(cluster)` 里，而 RSS/sitemap
      //    只由 ISR storm 触发（`provider/isr/isr.provider.ts` 调 generateRssFeed/generateSiteMap）。
      //    剩下的触发是**事件驱动**的：某个 worker 处理了文章保存 ⇒ 只有那个 worker 生成一次。
      //    如果在生成函数里再加一道主实例守卫，非主实例 worker 上的文章保存就**不会**刷新 RSS，
      //    订阅源要等到主实例下一个整点 cron 才更新（最长 1 小时）—— 那是把"省一次重复写"
      //    换成"订阅源变陈旧"，方向是错的。并发写的安全性由上面的原子 rename 保证。
      await Promise.all(
        (
          [
            ['feed.json', feed.json1()],
            ['feed.xml', feed.rss2()],
            ['atom.xml', feed.atom1()],
          ] as Array<[string, string]>
        ).map(async ([name, body]) => {
          const tmpPath = path.join(rssPath, `${name}.tmp-${process.pid}`);
          try {
            await fs.promises.writeFile(tmpPath, body);
            await fs.promises.rename(tmpPath, path.join(rssPath, name));
          } catch (err) {
            // 半成品 tmp 不能留在静态目录里（`<static>/rss/` 是匿名可读的，
            // 一个 `.tmp-<pid>` 文件对访客就是一条莫名的 404/下载项）
            await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
            throw err;
          }
        }),
      );
    } catch (err) {
      this.logger.error('生成订阅源失败！');
      this.logger.error(JSON.stringify(err, null, 2));
    }
  }
}
