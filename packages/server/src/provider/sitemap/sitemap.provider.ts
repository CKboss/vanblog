import { Injectable, Logger } from '@nestjs/common';
import { ArticleProvider } from '../article/article.provider';
import { encodeQuerystring, washUrl } from 'src/utils/washUrl';
import { CustomPageProvider } from '../customPage/customPage.provider';
import { CategoryProvider } from '../category/category.provider';
import { TagProvider } from '../tag/tag.provider';
import { MetaProvider } from '../meta/meta.provider';
import { SitemapStream, streamToPromise } from 'sitemap';
import { config } from 'src/config';
import path from 'path';
import fs from 'fs';

@Injectable()
export class SiteMapProvider {
  logger = new Logger(SiteMapProvider.name);
  timer = null;
  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly categoryProvider: CategoryProvider,
    private readonly tagProvider: TagProvider,
    private readonly customPageProvider: CustomPageProvider,
    private readonly metaProvider: MetaProvider,
  ) {}

  async generateSiteMap(info?: string, delay?: number) {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => {
        this.generateSiteMapFn(info);
      },
      delay || 60 * 1000,
    );
  }

  async generateSiteMapFn(info?: string) {
    this.logger.log(info + '重新生成 SiteMap ');
    // ⚠️ 这个方法是从 setTimeout 里"发出去就不管"地调的（见 generateSiteMap），
    // 所以它**必须自己兜住所有错误**：以前整段既没有 try/catch，
    // `streamToPromise(...).then(...)` 也没有 `.catch`，于是
    //  - Mongo 抖一下（getSiteEntries / getSiteInfo 抛错）⇒ 只留一条全局 unhandledRejection，
    //    日志里看不出是 sitemap，而 sitemap.xml 会一直停在旧内容上（爬虫继续拿到已删除的文章）；
    //  - 写盘失败（ENOSPC / 只读挂载）⇒ 同样是一条没有来源的 rejection。
    // RSS 那边（rss.provider.generateRssFeedFn）一直是有 try/catch 的，这里是漏掉的孪生兄弟。
    try {
      const entries = await this.getSiteEntries();
      const siteInfo = await this.metaProvider.getSiteInfo();
      const baseUrl = siteInfo?.baseUrl || '';
      const smStream = new SitemapStream({ hostname: washUrl(baseUrl) });
      entries.forEach((entry) => {
        smStream.write(entry);
      });
      // 先挂上 promise 再 end()（顺序不能反），然后 await 它 —— 原来是
      // `.then(...)` 且不 catch，写盘失败就是一条无主的 rejection
      const done = streamToPromise(smStream);
      smStream.end();
      const sm = await done;
      const sitemapPath = path.join(config.staticPath, 'sitemap');
      // 本来就在 async 函数里，没有理由用同步 IO 把事件循环按住（大站的 sitemap 有几百 KB）。
      await fs.promises.mkdir(sitemapPath, { recursive: true });
      // 先写临时文件再 rename：`/sitemap/sitemap.xml` 是匿名可直接下载的静态文件，
      // 原地覆盖会让并发的爬虫读到半截 XML（解析失败比读到旧文件糟得多）；
      // 同一文件系统内的 rename 是原子的。
      const tmpPath = path.join(sitemapPath, `sitemap.xml.tmp-${process.pid}`);
      await fs.promises.writeFile(tmpPath, sm);
      await fs.promises.rename(tmpPath, path.join(sitemapPath, 'sitemap.xml'));
    } catch (err) {
      this.logger.error(
        `生成 SiteMap 失败（来源：${info || '未注明'}）：${(err as Error)?.message || err}`,
      );
    }
  }
  async getArticleUrls() {
    const articles = await this.articleProvider.getAll('list', false, false);
    return articles.map((a) => {
      return `/post/${a.pathname || a.id}`;
    });
  }
  async getCategoryUrls() {
    const categories = await this.categoryProvider.getPublicCategoryNames();
    return categories.map((c) => {
      return `/category/${encodeQuerystring(c)}`;
    });
  }
  async getPageUrls() {
    const num = await this.articleProvider.getTotalNum(false);
    const pageSize = await this.metaProvider.getArticlesPerPage();
    const total = Math.ceil(num / pageSize);
    const paths = [];
    for (let i = 1; i <= total; i++) {
      paths.push(`/page/${i}`);
    }
    return paths;
  }
  async getCustomUrls() {
    const data = await this.customPageProvider.getAll();
    return data.map((c) => {
      return `/c${c.path}`;
    });
  }
  async getTagUrls() {
    const tags = await this.tagProvider.getAllTags(false);
    return tags.map((c) => {
      return `/tag/${encodeQuerystring(c)}`;
    });
  }
  /**
   * 带元信息的站点地图条目。
   *
   * 原来只写 `<url><loc>`，爬虫拿不到任何「什么时候变过」的信号，只能按自己的节奏重抓全站。
   * `lastmod` 是 sitemap 里最有价值的字段（Google/Bing 都用它决定重抓顺序），
   * 所以文章用 `updatedAt || createdAt`，首页/归档/分类页用「最新文章更新时间」。
   *
   * 另外**加密文章（以及加密分类下的文章）不进 sitemap**：正文对爬虫不可见，
   * 收录进来既浪费抓取配额，又会被判成薄内容（thin content）拉低站点质量评分。
   * 隐藏文章本来就已经被 `getAll('list', false, false)` 排除了。
   */
  async getSiteEntries(): Promise<
    Array<{ url: string; lastmod?: Date; changefreq?: string; priority?: number }>
  > {
    const articles = (await this.articleProvider.getAll('list', false, false)) as any[];
    let privateCategories = new Set<string>();
    try {
      const allCategories = ((await this.categoryProvider.getAllCategories(true)) || []) as any[];
      privateCategories = new Set(
        allCategories.filter((c) => c?.private).map((c) => String(c?.name)),
      );
    } catch {
      // 拿不到分类信息时按「没有加密分类」处理，别让 sitemap 整个生成失败
    }

    let newest = 0;
    const articleEntries: Array<{ url: string; lastmod?: Date; changefreq?: string; priority?: number }> = [];
    for (const raw of articles) {
      const article = raw?._doc || raw;
      if (article?.private || privateCategories.has(String(article?.category))) {
        continue;
      }
      const lastmod = toDate(article?.updatedAt) || toDate(article?.createdAt);
      const time = lastmod ? lastmod.getTime() : 0;
      if (time > newest) {
        newest = time;
      }
      articleEntries.push({
        url: `/post/${article?.pathname || article?.id}`,
        lastmod,
        changefreq: 'weekly',
        priority: 0.8,
      });
    }

    const siteLastmod = newest ? new Date(newest) : undefined;
    const entries: Array<{ url: string; lastmod?: Date; changefreq?: string; priority?: number }> = [
      // 首页与聚合页：内容随文章变化，优先级最高
      { url: '/', lastmod: siteLastmod, changefreq: 'daily', priority: 1.0 },
      { url: '/timeline', lastmod: siteLastmod, changefreq: 'daily', priority: 0.7 },
      { url: '/category', lastmod: siteLastmod, changefreq: 'weekly', priority: 0.6 },
      { url: '/tag', lastmod: siteLastmod, changefreq: 'weekly', priority: 0.6 },
      { url: '/about', changefreq: 'monthly', priority: 0.5 },
      { url: '/link', changefreq: 'monthly', priority: 0.5 },
    ];
    for (const entry of articleEntries) {
      entries.push(entry);
    }
    for (const url of await this.getCategoryUrls()) {
      entries.push({ url, lastmod: siteLastmod, changefreq: 'weekly', priority: 0.5 });
    }
    for (const url of await this.getTagUrls()) {
      entries.push({ url, lastmod: siteLastmod, changefreq: 'weekly', priority: 0.4 });
    }
    const pageUrls = await this.getPageUrls();
    pageUrls.forEach((url, index) => {
      // 分页越往后价值越低；第 1 页其实等于首页，给低一点避免与首页争权重
      entries.push({
        url,
        lastmod: siteLastmod,
        changefreq: 'daily',
        priority: index === 0 ? 0.4 : Math.max(0.2, 0.5 - index * 0.02),
      });
    });
    for (const url of await this.getCustomUrls()) {
      entries.push({ url, changefreq: 'monthly', priority: 0.6 });
    }
    // 去重：同一个 url 只保留第一次出现（首页与 /page/1 内容重复，留首页）
    const seen = new Set<string>();
    return entries.filter((entry) => {
      if (seen.has(entry.url)) {
        return false;
      }
      seen.add(entry.url);
      return true;
    });
  }

  async getSiteUrls() {
    let urlList = ['/', '/category', '/tag', '/timeline', '/about', '/link'];
    urlList = urlList.concat(await this.getArticleUrls());
    urlList = urlList.concat(await this.getTagUrls());
    urlList = urlList.concat(await this.getCategoryUrls());
    urlList = urlList.concat(await this.getPageUrls());
    urlList = urlList.concat(await this.getCustomUrls());
    return urlList;
  }
}


/** 各种来源的时间（Date / ISO 串 / 毫秒数 / 空值）统一成 Date，非法值返回 undefined */
function toDate(value: unknown): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
