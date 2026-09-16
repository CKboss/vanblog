import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { Article } from 'src/scheme/article.schema';
import { getAllArticlePublicPaths, getArticlePublicPaths } from 'src/utils/articlePublicPaths';
import { sleep } from 'src/utils/sleep';
import { ArticleProvider } from '../article/article.provider';
import { RssProvider } from '../rss/rss.provider';
import { SettingProvider } from '../setting/setting.provider';
import { SiteMapProvider } from '../sitemap/sitemap.provider';
export interface ActiveConfig {
  postId?: number;
  forceActice?: boolean;
  previousPathname?: string;
}
@Injectable()
export class ISRProvider {
  urlList = ['/', '/category', '/tag', '/timeline', '/about', '/link'];
  base = 'http://127.0.0.1:3001/api/revalidate?path=';
  logger = new Logger(ISRProvider.name);
  timer = null;
  /**
   * 全量渲染的互斥量。一轮 storm ≈ 130 次**串行**重渲染（每篇文章的 id 与别名两条路径
   * + 分页 + 分类 + 标签 + 6 个固定页），而触发点有 25 处以上（保存/删除文章、批量改标签、
   * 分类增删改、社交信息、菜单、站点配置、布局、主题切换、JSON 导入、整站恢复、初始化、手动…），
   * 每小时还有一次定时触发。以前只有 1 秒防抖、**没有互斥**：连着保存 10 篇文章就能叠出
   * 好几轮同时跑的 storm，把前台和 server 一起拖死（前台每个页面渲染又要回调 server 的公开接口）。
   */
  private stormRunning = false;
  private stormQueued: { info?: string; activeConfig?: ActiveConfig } | null = null;
  /** 单次请求最多允许连续追加几轮，避免"一直在改"时无限串下去 */
  private stormChain = 0;
  private static readonly STORM_CHAIN_MAX = 3;
  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly rssProvider: RssProvider,
    private readonly sitemapProvider: SiteMapProvider,
    private readonly settingProvider: SettingProvider,
  ) {}
  async activeAllFn(info?: string, activeConfig?: ActiveConfig) {
    const isrConfig = await this.settingProvider.getISRSetting();
    if (isrConfig?.mode == 'delay' && !activeConfig?.forceActice) {
      this.logger.debug(`延时自动更新模式，阻止按需 ISR`);
      return;
    }
    if (this.stormRunning) {
      // 已经有一轮在跑：把"还要再跑一轮"记下来，等它跑完再补一轮（多次请求合并成一次），
      // 绝不并发起第二轮。补的那一轮会重新读取当前数据，所以合并不会丢更新。
      this.stormQueued = { info, activeConfig };
      this.logger.warn(
        `上一轮全量渲染还在进行，本轮已合并到它结束后（来源：${info || '未注明'}）`,
      );
      return;
    }
    this.stormRunning = true;
    try {
      await this.runStorm(info, activeConfig);
    } catch (err) {
      // 全量渲染本质上是"尽力而为"：失败了不往上抛（调用方有 25 处以上，
      // 谁忘了 catch 就是一条 unhandledRejection），而且每小时的定时任务会兜底重跑。
      // 互斥量在 finally 里释放，所以下一次触发不会被一次失败永久卡住。
      this.logger.error(
        `全量渲染失败（来源：${info || '未注明'}）：${(err as Error)?.message || err}`,
      );
    } finally {
      this.stormRunning = false;
    }
    const queued = this.stormQueued;
    this.stormQueued = null;
    try {
      if (queued && this.stormChain < ISRProvider.STORM_CHAIN_MAX) {
        this.stormChain += 1;
        this.logger.log(
          `补跑一轮全量渲染（第 ${this.stormChain} 次追加，来源：${queued.info || '未注明'}）`,
        );
        await this.activeAllFn(queued.info, queued.activeConfig);
      } else if (queued) {
        this.logger.warn(
          `已连续追加 ${ISRProvider.STORM_CHAIN_MAX} 轮全量渲染，丢弃后续请求（来源：${
            queued.info || '未注明'
          }）——通常说明有人在批量改数据，下一小时的定时任务会兜底`,
        );
      }
    } finally {
      // ⚠️ 必须在 finally 里收：补跑那一轮如果抛错（例如读 ISR 设置时 Mongo 正好不可用），
      // 链计数就会永远停在 >0，之后每一轮 storm 都会少追加几次，
      // 而日志里只会看到"已连续追加 3 轮，丢弃后续请求"这种莫名其妙的话。
      if (this.stormChain > 0 && !this.stormQueued) {
        this.stormChain = 0;
      }
    }
  }

  private async runStorm(info?: string, activeConfig?: ActiveConfig) {
    if (info) {
      this.logger.log(info);
    } else {
      this.logger.log('首次启动触发全量渲染！');
    }
    // ! 配置差的机器可能并发多了会卡，所以改成串行的。

    await this.activeUrls(this.urlList, false);
    const requestedPostId = activeConfig?.postId;
    const articleWithThisId =
      requestedPostId != null ? await this.articleProvider.getById(requestedPostId, 'list') : null;
    const priorityUrls: string[] = articleWithThisId
      ? getArticlePublicPaths(articleWithThisId)
      : requestedPostId != null
      ? [`/post/${requestedPostId}`]
      : [];
    const previousPathname =
      typeof activeConfig?.previousPathname === 'string'
        ? activeConfig.previousPathname.trim()
        : '';
    if (previousPathname) {
      const oldPath = `/post/${previousPathname}`;
      if (!priorityUrls.includes(oldPath)) {
        priorityUrls.push(oldPath);
      }
    }
    await this.activePath('post', priorityUrls);
    await this.activePath('page');
    await this.activePath('category');
    await this.activePath('tag');
    this.logger.log('触发全量渲染完成！');
  }
  async activeAll(info?: string, delay?: number, activeConfig?: ActiveConfig) {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      // 订阅源与站点地图是 **server 自己生成的静态文件**，和前台 Next 进程无关。
      // 以前整个方法被 VANBLOG_DISABLE_WEBSITE 挡在最外面，于是「前台没起 / server 单独部署」时
      // sitemap.xml 与 feed.xml **永远不更新** —— 爬虫拿到的是旧数据（本站开发环境就复现了：
      // sitemap 里还留着早已删除的文章）。所以把这两个生成挪到守卫之前。
      this.rssProvider.generateRssFeed(info || '', delay);
      this.sitemapProvider.generateSiteMap(info || '', delay);
      if (process.env['VANBLOG_DISABLE_WEBSITE'] === 'true') {
        return;
      }
      // ⚠️ 箭头函数**必须 return**：`activeWithRetry` 里那句 `await fn(info)` 以前
      // await 的是 undefined（花括号里没有 return），于是它自己的 try/catch 与
      // "第 N 次重试"日志形同虚设 —— activeAllFn 的失败只能落到全局 unhandledRejection
      // 兜底里，看不出是哪一轮、哪个来源。现在真的 await 到 storm 结束，
      // 失败会带上来源被打出来，重试循环也不会在 storm 还在跑的时候就返回。
      this.activeWithRetry(() => this.activeAllFn(info, activeConfig), info);
    }, 1000);
  }

  /**
   * 拼 revalidate 请求地址。
   * 以前是 `encodeURI(this.base + url)`：encodeURI 不会编码 `#`、`&`、`?`，
   * 而文章别名里允许出现 `#`（见 utils/articlePathname.ts），那样后面的路径会被截断，
   * 增量渲染就悄悄失败了。改成 URLSearchParams，并且带上可选的共享密钥
   * （website 的 /api/revalidate 在单独部署时是公网可达的）。
   */
  buildRevalidateUrl(url: string): string {
    const params = new URLSearchParams({ path: url });
    const secret = process.env.VAN_BLOG_REVALIDATE_SECRET;
    if (secret) {
      params.set('secret', secret);
    }
    return `http://127.0.0.1:3001/api/revalidate?${params.toString()}`;
  }

  /**
   * 单次 revalidate 请求的超时。
   * ⚠️ 以前 axios 完全没有超时：前台卡住一个页面（比如某篇文章渲染要 500ms 变成几十秒），
   * 这个 await 就永远不返回 —— 串行的 storm 会**永久停在半路**，
   * 而下一小时的定时任务或下一次编辑又会起一轮，越堆越多。
   */
  private get requestTimeoutMs(): number {
    const raw = Number(process.env.VANBLOG_ISR_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10000;
  }

  async testConn() {
    try {
      await axios.get(this.buildRevalidateUrl('/'), { timeout: this.requestTimeoutMs });
      return true;
    } catch {
      return false;
    }
  }
  async activeWithRetry(fn: any, info?: string) {
    const max = 6;
    const delay = 3000;
    let succ = false;
    for (let t = 0; t < max; t++) {
      const r = await this.testConn();
      if (t > 0) {
        this.logger.warn(`第${t}次重试触发增量渲染！来源：${info || '首次启动触发全量渲染！'}`);
      }
      if (r) {
        // ⚠️ 以前是 `fn(info)` 就完事：不 await、不 catch。
        // fn 里是 activeAllFn（现在带互斥），不 await 的话调用方以为"触发完了"，
        // 而它抛出的 rejection 只能靠全局 unhandledRejection 兜着（日志里一行，谁也不知道哪轮失败了）。
        try {
          await fn(info);
        } catch (err) {
          this.logger.error(
            `触发全量渲染时出错（来源：${info || '未注明'}）：${(err as Error)?.message || err}`,
          );
        }
        succ = true;
        break;
      } else {
        // 延迟
        await sleep(delay);
      }
    }
    if (!succ) {
      this.logger.error(`达到最大增量渲染重试次数！来源：${info || '首次启动触发全量渲染！'}`);
    }
  }
  async activeUrls(urls: string[], log: boolean) {
    for (const each of urls) {
      await this.activeUrl(each, log);
    }
  }
  async activePath(type: 'category' | 'tag' | 'page' | 'post', priorityUrls?: string[]) {
    switch (type) {
      case 'category':
        const categoryUrls = await this.sitemapProvider.getCategoryUrls();
        await this.activeUrls(categoryUrls, false);
        break;
      case 'page':
        const pageUrls = await this.sitemapProvider.getPageUrls();
        await this.activeUrls(pageUrls, false);
        break;
      case 'tag':
        const tagUrls = await this.sitemapProvider.getTagUrls();
        await this.activeUrls(tagUrls, false);
        break;
      case 'post':
        const articleUrls = await this.getArticleUrls();
        if (priorityUrls?.length) {
          const rest = articleUrls.filter((u) => !priorityUrls.includes(u));
          await this.activeUrls([...priorityUrls, ...rest], false);
        } else {
          await this.activeUrls(articleUrls, false);
        }
        break;
    }
  }

  /**
   * ⚠️ **当前不可达**：全仓库没有任何调用方（"修改文章牵扯太多，暂时不用这个方法"）。
   * 保留是因为它是一个合理的未来入口（只重渲染受影响的几页，而不是全量 storm）。
   * 如果哪天要接上去，先注意：
   *  - 下面所有 `activeUrl()` 都是**故意不 await** 的（并发触发，互不等待），
   *    而 `activeUrl` 自己会 catch，所以不会漏 rejection；
   *  - 但 `activePath('page')` 会读库（`sitemapProvider.getPageUrls()` → 文章总数），
   *    以前既不 await 也不 catch ⇒ 一次 DB 抖动就是一条没有来源的 unhandledRejection，
   *    现在补了带来源的 `.catch`；
   *  - `article.tags` / `article.category` 在 `article` 为 null 时会抛（`getByIdOrPathnameWithPreNext`
   *    找不到文章时返回的 article 可能是空的），接上去之前要先判空。
   */
  async activeArticleById(id: number, event: 'create' | 'delete' | 'update', beforeObj?: Article) {
    const { article, pre, next } = await this.articleProvider.getByIdOrPathnameWithPreNext(
      id,
      'list',
    );
    // 无论是什么事件都先触发文章本身、标签和分类。
    for (const url of getArticlePublicPaths(article || { id })) {
      this.activeUrl(url, true);
    }
    if (beforeObj?.pathname && beforeObj.pathname !== article?.pathname) {
      this.activeUrl(`/post/${beforeObj.pathname}`, true);
    }
    if (pre) {
      for (const url of getArticlePublicPaths(pre)) {
        this.activeUrl(url, true);
      }
    }
    if (next) {
      for (const url of getArticlePublicPaths(next)) {
        this.activeUrl(url, true);
      }
    }
    const tags = article.tags;
    if (tags && tags.length > 0) {
      for (const each of tags) {
        this.activeUrl(`/tag/${each}`, true);
      }
    }
    const category = article.category;
    this.activeUrl(`/category/${category}`, true);

    if (event == 'update' && beforeObj) {
      // 更新文档需要考虑更新之前的标签和分类。
      const tags = beforeObj.tags;
      if (tags && tags.length > 0) {
        for (const each of tags) {
          this.activeUrl(`/tag/${each}`, true);
        }
      }
      const category = beforeObj.category;
      this.activeUrl(`/category/${category}`, true);
    }

    // 时间线、首页、标签页、tag 页

    this.activeUrl(`/timeline`, true);
    this.activeUrl(`/tag`, true);
    this.activeUrl(`/category`, true);
    this.activeUrl(`/`, true);
    // 如果是创建或者删除需要重新触发 page 页面
    // 如果更改了 hidden 或者 private 也需要触发全部 page 页面
    // 干脆就都触发了。
    // if (event == 'create' || event == 'delete') {
    this.logger.log('触发全部 page 页增量渲染！');
    // 不 await（与其它 activeUrl 一样是并发触发），但必须 catch：它会读库
    this.activePath('page').catch((err) =>
      this.logger.error(
        `触发全部 page 页增量渲染失败（activeArticleById, id=${id}）：${
          (err as Error)?.message || err
        }`,
      ),
    );
    // }
  }

  async activeAbout(info: string) {
    this.activeWithRetry(() => {
      this.logger.log(info);
      // 同上：不 return 就等于没 await，重试与错误归因都拿不到结果
      return this.activeUrl(`/about`, false);
    }, info);
  }
  async activeLink(info: string) {
    this.activeWithRetry(() => {
      this.logger.log(info);
      return this.activeUrl(`/link`, false);
    }, info);
  }

  async activeUrl(url: string, log: boolean) {
    try {
      await axios.get(this.buildRevalidateUrl(url), { timeout: this.requestTimeoutMs });
      if (log) {
        this.logger.log(`触发增量渲染成功！ ${url}`);
      }
    } catch (err) {
      // console.log(err);
      this.logger.error(`触发增量渲染失败！ ${url}`);
    }
  }

  async getArticleUrls() {
    const articles = await this.articleProvider.getAll('list', true, true);
    return getAllArticlePublicPaths(articles);
  }
}
