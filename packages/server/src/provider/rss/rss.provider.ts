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
// 🔴 RSS 是服务端"原始 HTML 直通"渲染链唯一的对外出口，所以出口处必须消毒（依据见该文件头）。
import { sanitizeRenderedHtml } from 'src/utils/rssHtmlSanitize';

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
      // 🔴 `metaProvider.getAll()` 是**无 filter 的 `findOne()`**，`metas` 集合为空时返回 `null`。
      // 以前这里直接 `siteInfo.author` ⇒ TypeError，被本函数末尾那个 catch 吞掉，
      // 而 catch 用的是 `JSON.stringify(err)`，对 Error 对象得到的是 `{}` ⇒ 日志里只有
      // "生成订阅源失败！" + `{}`，**看不出发生了什么**（这次一并修掉了那个 catch）。
      //
      // ⚠️ 降级口径是"**大声报错 + 一个字节都不写**"，不是"生成一份空 feed"：
      // `/rss/*` 与 `/sitemap.xml` 现在**在降级驻留期由 caddy 直发磁盘产物**
      // （见 AGENTS.md §7.78c / docs/advanced/degraded-publishing.md），也就是说
      // **feed 是站点被打瘫时少数还能对外发布的通道之一**。如果这里写出一份空 feed，
      // 就会把磁盘上**上一份好的** feed 覆盖掉 ⇒ 降级期读者拿到的是一个空订阅源，
      // 而且等数据库恢复后也要等下一次 ISR 风暴才会重新生成。
      // 保留旧文件的代价只是"内容陈旧"，这比"没有内容"好得多。
      const siteInfo = meta?.siteInfo;
      if (!meta || !siteInfo) {
        this.logger.error(
          '生成订阅源失败：站点的 meta/siteInfo 文档不存在（metas 集合为空）。' +
            '这通常说明站点数据已损坏，或被恢复成了一份不完整/部分的归档。' +
            '⚠️ 本次**没有写任何 feed 文件**，磁盘上上一份好的 feed 保持不变（降级期 caddy 会继续直发它）。' +
            '下一步：先跑 ./vanblog.sh doctor 看体检；必要时用 ./vanblog.sh restore --offline-full <归档> 重建。',
        );
        return;
      }
      const walineSetting = await this.settingProvider.getWalineSetting();
      let email = process.env.EMAIL;
      if (walineSetting && walineSetting?.authorEmail) {
        email = walineSetting?.authorEmail;
      }
      const author = {
        name: siteInfo.author,
        email,
        link: siteInfo.baseUrl,
      };
      const siteUrl = washUrl(siteInfo.baseUrl);
      const favicon =
        siteInfo.favicon ||
        siteInfo.siteLogo ||
        siteInfo.authorLogo ||
        `${siteUrl}logo.svg`;
      const siteLogo =
        siteInfo.siteLogo ||
        siteInfo.authorLogo ||
        siteInfo.favicon ||
        `${siteUrl}logo.svg`;
      const date = new Date();
      const feed = new Feed({
        title: siteInfo.siteName,
        description: siteInfo.siteDesc,
        id: siteUrl,
        link: siteUrl,
        // 语言标签用规范写法（RFC 5646 是大小写不敏感，但 zh-CN 更常见也更保险）
        language: 'zh-CN',
        image: siteLogo,
        favicon: favicon,
        copyright: `All rights reserved ${date.getFullYear()}, ${siteInfo.author}`,
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
        // 🔴 2026-09-21：RSS 是服务端这条"原始 HTML 直通"渲染链**唯一的对外出口**，所以在这里消毒。
        //    背景与白名单依据见 `utils/rssHtmlSanitize.ts` 的文件头；接线由
        //    `utils/rssHtmlSanitizeWiring.spec.ts` 的**调用方枚举守卫**钉住（新增出口忘了消毒就会红）。
        //
        // 🔴 **消毒只作用于正文，绝不能作用到整个 html 外壳**（实测依据，不是推理）：
        //    `<link rel="stylesheet">` **不在白名单里**，整段消毒会把它摘掉
        //    （实测 `<link …>` 单独消毒后得到空串；带外壳消毒后三个 link 全部消失）。
        //    那会让 RSS 丢掉三份样式表（markdown.css / katex / highlight.js），
        //    **每个阅读器里的公式与代码高亮都变成无样式** —— 为了安全把功能弄坏，违背"每次迭代都要
        //    保证功能正常"。外壳（`div.markdown-body.rss` + 三个 link）是我们自己写的常量、
        //    不含作者内容，本来就不需要消毒。
        //
        // ⚠️ **mermaid 的 replace 放在消毒之前**（与改动前顺序一致）：它匹配的是 markdown-it 自己
        //    产出的那个 div 开标签，而消毒要经过"解析 → 序列化"，序列化后的属性写法理论上可能变
        //    （例如属性值不带引号），让 replace **静默失配**。实测两种顺序当前输出相同，
        //    但"先 replace 后消毒"不依赖序列化形状，更稳。有守卫钉住这条顺序。
        //
        // 🔴 **失败方向**：消毒抛错时 `sanitizeRenderedHtml` 返回**空串**（宁可这一篇少发正文，
        //    也绝不把未消毒的原文发出去），并由下面的 onError **大声记一条 ERROR**（含是哪一篇），
        //    否则"某篇文章的 RSS 正文莫名空了"会完全查不出原因。
        const onSanitizeError = (where: string) => (err: unknown) =>
          this.logger.error(
            `RSS ${where}消毒失败，这一篇已按空内容发出（宁可不发也不发未消毒的内容）：` +
              `文章 ${article.pathname || article.id}：` +
              (err instanceof Error ? err.stack || err.message : String(err)),
          );
        const renderedBody = sanitizeRenderedHtml(
          this.markdownProvider
            .renderMarkdown(article.content)
            .replace(
              /<div class="mermaid">/g,
              `<div class="mermaid" style="background: #f3f3f3; padding: 8px;"> <p>Mermaid 图表 RSS 暂无法显示，具体请查看原文</p>`,
            ),
          onSanitizeError('正文'),
        );
        const html = `<div class="markdown-body rss">
      <link rel="stylesheet" href="${siteUrl}markdown.css">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.6.0/build/styles/default.min.css">
      ${renderedBody}</div>`;
        feed.addItem({
          title: article.title,
          id: url,
          link: url,
          // ⚠️ description 也必须消毒：它是摘要（`<!-- more -->` 之前那一段），同样来自作者正文，
          //    很多阅读器**只显示 description**、不展开 content ⇒ 漏掉它等于留了半个口子。
          description: sanitizeRenderedHtml(
            this.markdownProvider.renderMarkdown(
              this.markdownProvider.getDescription(article.content),
            ),
            onSanitizeError('摘要'),
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
      // ⚠️ 以前这里是 `JSON.stringify(err, null, 2)`，而 `JSON.stringify(new TypeError('x'))`
      // 得到的是 **`{}`**（Error 的 message/stack 是不可枚举属性）⇒ 真正的失败原因被完全丢掉，
      // 日志里只剩"生成订阅源失败！"。上面那条 meta 为空的 TypeError 就是这样变成哑谜的。
      this.logger.error(err instanceof Error ? (err.stack || err.message) : String(err));
    }
  }
}
