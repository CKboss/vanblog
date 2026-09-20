import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import axios from 'axios';
import cluster from 'node:cluster';
import * as fs from 'fs';
import { Article } from 'src/scheme/article.schema';
import { getAllArticlePublicPaths, getArticlePublicPaths } from 'src/utils/articlePublicPaths';
import { sleep } from 'src/utils/sleep';
import { envPositiveInt } from 'src/utils/envNumber';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import { ArticleProvider } from '../article/article.provider';
import { RssProvider } from '../rss/rss.provider';
import { SettingProvider } from '../setting/setting.provider';
import { SiteMapProvider } from '../sitemap/sitemap.provider';
import { SearchIndexProvider } from '../search/searchIndex.provider';
import { reconcileArtifacts, reaperPagesDir } from './artifactReaper';
export interface ActiveConfig {
  postId?: number;
  forceActice?: boolean;
  previousPathname?: string;
}

/** 周期对账间隔的 env（毫秒）。下限 60s：再短就是拿 DB 查询换安心，风暴收尾那次已经够了 */
export const REAP_INTERVAL_ENV = 'VANBLOG_ISR_REAP_INTERVAL_MS';
export const DEFAULT_REAP_INTERVAL_MS = 15 * 60 * 1000;
export const MIN_REAP_INTERVAL_MS = 60 * 1000;
/** 删除日志最多列几个文件名（再多就是刷屏；完整清单没有价值，计数才有） */
export const REAP_LOG_NAMES_MAX = 10;

/* ------------------- 全量风暴的有界并发与单轮预算 -------------------
 * 背景：`activeUrls` 以前是 `for (const u of urls) { await this.activeUrl(u) }` —— **严格串行**，
 * 一次一个 revalidate 往返。59 篇文章没问题；但 1 万篇的全量风暴按 200ms/次算就是 **33 分钟**，
 * 期间新内容出不来静态页，而触发点有 34 处分布在 12 个文件（发文/改分类/改标签/换主题/整站恢复/
 * 定时发布…），有文章权限的协作者可以反复触发 ⇒ 这既是规模问题也是攻击面。
 * ⚠️ 但 :120 那条历史注释（"配置差的机器可能并发多了会卡，所以改成串行的"）是对的，
 * 所以**不是**改成无界并发，而是：有界并发（默认 4，可调 1–32）+ 单轮预算 + 进度日志。
 * 每个 activeUrl 是一次到 website(3001) 的 HTTP 往返，那边是真渲染（读库 + 生成 HTML + 写盘），
 * 并发太高会把 Next 进程与磁盘打满，反而更慢 —— 4 是"比串行快数倍、又不至于压垮小机器"的取值。
 * ------------------------------------------------------------------ */
/** 全量风暴里同时在途的 revalidate 数量上限（env 可调） */
export const ISR_STORM_CONCURRENCY_ENV = 'VANBLOG_ISR_STORM_CONCURRENCY';
export const DEFAULT_ISR_STORM_CONCURRENCY = 4;
export const MIN_ISR_STORM_CONCURRENCY = 1;
export const MAX_ISR_STORM_CONCURRENCY = 32;
/**
 * 单次 activeUrls 的"单轮预算"：超过就分批并打 WARN + 进度日志。
 * ⚠️ 预算**不是**"超出的就不渲染了"——那等于静默丢内容。所有 URL 都会被处理，
 * 预算只用来把"这一轮规模异常大"这件事说清楚，并给出可读的进度。
 */
export const ISR_STORM_ROUND_BUDGET_ENV = 'VANBLOG_ISR_ROUND_URL_BUDGET';
export const DEFAULT_ISR_STORM_ROUND_BUDGET = 5000;
export const MIN_ISR_STORM_ROUND_BUDGET = 1;

@Injectable()
export class ISRProvider implements OnModuleDestroy {
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
  /** 产物清道夫的周期定时器（只在主进程存在；见 startArtifactReaper） */
  private reapTimer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly rssProvider: RssProvider,
    private readonly sitemapProvider: SiteMapProvider,
    private readonly settingProvider: SettingProvider,
    // ⚠️ @Optional()：SearchIndexProvider 没注册时注入 undefined，配合调用处的 ?. 安全跳过。
    // 加在最后，不动前四个参数的位置（有源码钉子按位置断言过）。
    @Optional() private readonly searchIndexProvider?: SearchIndexProvider,
  ) {
    this.startArtifactReaper();
  }
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
    // 风暴收尾 = 事件驱动的清道夫触发点：25+ 个调用方（删文/加密/隐藏/定时/改分类…）
    // 全部汇到 runStorm，所以「实体不再可公开」必然在这一轮之后被清掉盘上产物。
    // reapStaleArtifacts 自己吞错（清道夫失败不能把风暴标记成失败），周期对账会兜底。
    await this.reapStaleArtifacts(`全量渲染收尾（${info || '未注明来源'}）`);
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
      // 搜索索引与 RSS/sitemap 走同一条轨：必须留在 VANBLOG_DISABLE_WEBSITE 守卫与
      // delay 模式拦截**之前**（§7.57-E 的教训：delay 模式下守卫之后的一切永远不会执行，
      // 索引会静默停更，而"自信地给出过期结果"比没有索引更糟）。
      // `delay` 原样转发 —— 恢复与后台编辑要立刻出新索引，不能等默认防抖。
      this.searchIndexProvider?.generateSearchIndex(info || '', delay);
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
  /**
   * 读并发上限：非法值回落默认，并夹在 1–32（0/负数/垃圾都不会变成"无界并发"）。
   * ⚠️ 整数性由 `envPositiveInt` 保证（它内部是 `Math.floor(clamped)`，见 utils/envNumber.ts:36），
   * 所以这里不再多包一层取整 —— 冗余代码会让下一个人以为"这个工具不取整"。
   * 但**调用点仍然有断言钉住整数性**（`VANBLOG_ISR_STORM_CONCURRENCY=1.5` 必须得到 1），
   * 这样将来有人换掉这个工具函数时，分数并发不会静默溜进来：`Array.from({ length: 1.5 })`
   * 会被悄悄截断成 1，等于"配了个没人能预测的值"。
   */
  resolveStormConcurrency(): number {
    return envPositiveInt(
      ISR_STORM_CONCURRENCY_ENV,
      DEFAULT_ISR_STORM_CONCURRENCY,
      MIN_ISR_STORM_CONCURRENCY,
      MAX_ISR_STORM_CONCURRENCY,
    );
  }

  /**
   * 读单轮预算：同样回落 + 夹取（最小 1，否则 `done % budget` 会除零）。
   * 整数性同上由 `envPositiveInt` 保证；预算参与 `done % budget` 与 `Math.ceil(total / budget)`，
   * 小数值会让"分批数"和"进度日志的触发点"都变成不可预期的东西，所以调用点也有断言钉住。
   */
  resolveStormRoundBudget(): number {
    return envPositiveInt(
      ISR_STORM_ROUND_BUDGET_ENV,
      DEFAULT_ISR_STORM_ROUND_BUDGET,
      MIN_ISR_STORM_ROUND_BUDGET,
    );
  }

  /**
   * 把一批 URL 送去重渲染：**有界并发** + 单轮预算 + 可观测日志。
   *
   * 为什么不是无界并发：见文件头那段常量注释（:120 的历史结论"并发多了会卡"仍然成立，
   * 只是"串行"矫枉过正）。为什么不是"超出预算就丢弃"：那会静默少渲染内容，
   * 表现是"文章能打开但静态页没更新"，极难排查。
   *
   * ⚠️ 语义保持不变的部分：每个 URL 都恰好处理一次；`activeUrl` 自己吞错（单个失败不影响其余）；
   * 调用方 await 到"整批处理完"才返回（runStorm 的顺序依赖这一点）。
   */
  async activeUrls(urls: string[], log: boolean) {
    const total = urls.length;
    if (total === 0) {
      return;
    }
    const concurrency = Math.min(this.resolveStormConcurrency(), total);
    const budget = this.resolveStormRoundBudget();
    const startedAt = Date.now();
    if (total > budget) {
      this.logger.warn(
        `增量渲染规模异常大：本轮 ${total} 个 URL（单轮预算 ${budget}），将分 ${Math.ceil(
          total / budget,
        )} 批处理，并发 ${concurrency}。常见原因是批量导入、批量改分类/标签或整站恢复；` +
          `期间新内容可能暂时看不到静态页。可调 ${ISR_STORM_CONCURRENCY_ENV} 提高并发。`,
      );
    }
    let next = 0;
    let done = 0;
    let failed = 0;
    // 每个 worker 从共享游标取下一个 URL：在途数量恒 <= concurrency，
    // 且不需要把数组切片（切片会让"每批固定大小"与慢 URL 互相拖累）。
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= total) {
          return;
        }
        const ok = await this.activeUrl(urls[index], log);
        done += 1;
        if (!ok) {
          failed += 1;
        }
        if (done % budget === 0 && done < total) {
          this.logger.log(
            `增量渲染进度：${done}/${total}（失败 ${failed}，已用 ${Date.now() - startedAt}ms）`,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    this.logger.log(
      `增量渲染完成：${total} 个 URL，失败 ${failed}，用时 ${
        Date.now() - startedAt
      }ms，并发 ${concurrency}`,
    );
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

  /**
   * 触发单个 URL 的增量渲染。**返回是否成功**（以前返回 void）：
   * 调用方（activeUrls）要统计失败条数，否则"这一轮渲染了多少、坏了多少"在日志里根本看不到 ——
   * 而全量风暴一次可能是上万个 URL，没有汇总就等于没有可观测性。
   * ⚠️ 仍然自己吞错：单个 URL 失败不能中断整批（既有语义，34 处触发点都依赖它）。
   */
  async activeUrl(url: string, log: boolean): Promise<boolean> {
    try {
      await axios.get(this.buildRevalidateUrl(url), { timeout: this.requestTimeoutMs });
      if (log) {
        this.logger.log(`触发增量渲染成功！ ${url}`);
      }
      return true;
    } catch (err) {
      // 以前只打 URL 不打原因：超时、连接被拒、website 返回 500 在日志里长得一样，
      // 而这三者的处置完全不同（等它、查 website 进程、查那条 URL 的渲染错误）。
      const e = err as { code?: string; message?: string; response?: { status?: number } };
      const reason = e?.response?.status
        ? `website 返回 ${e.response.status}`
        : e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT'
        ? `超时（>${this.requestTimeoutMs}ms）`
        : e?.code === 'ECONNREFUSED'
        ? '连不上 website(3001)：前台进程可能没起来'
        : e?.message || String(err);
      this.logger.error(`触发增量渲染失败！ ${url} —— ${reason}`);
      return false;
    }
  }

  async getArticleUrls() {
    const articles = await this.articleProvider.getAll('list', true, true);
    return getAllArticlePublicPaths(articles);
  }

  /* ======================= ISR 产物清道夫（stale-artifact reaper） =======================
   * 背景与安全边界全部写在 ./artifactReaper.ts 的文件头（一句话版本：Next 的
   * file-system-cache 只写不删，caddy 按文件直服动态路由的前提是有人把"不再可公开"
   * 的路径的 .html/.json/.meta 从盘上删掉）。
   *
   * 两个触发时机，缺一不可：
   *  1. 事件驱动：每轮全量风暴收尾（runStorm 末尾）—— 25+ 个改动入口都汇到那里；
   *  2. 周期对账：主进程每 VANBLOG_ISR_REAP_INTERVAL_MS（默认 15 分钟）一次，兜住
   *     "风暴和 DB 写入之间进程崩了"、"整站恢复把库整个换掉"、"批量操作漏了触发"
   *     这类事件路径永远看不到的场景。
   * 与 caddy 开关（VANBLOG_CADDY_SERVE_HTML）**解耦**：即使直服关着也照跑 ——
   * 它同时修掉一个今天就能观察到的老毛病（website 重启后内存 404 丢失，Next 自己
   * 会短暂把已删文章从盘上 serve 回来），并且让直服开关随时可以安全打开。
   * ---------------------------------------------------------------------------------- */

  /** 启动周期对账（幂等；多进程时只有主进程启动，约定同 isr.task.ts 的 cron 守卫） */
  startArtifactReaper() {
    if (this.reapTimer || !isPrimaryInstance(cluster)) {
      return;
    }
    const interval = envPositiveInt(
      REAP_INTERVAL_ENV,
      DEFAULT_REAP_INTERVAL_MS,
      MIN_REAP_INTERVAL_MS,
    );
    this.reapTimer = setInterval(() => {
      // reapStaleArtifacts 内部吞错并带来源打日志，这里的 catch 只是最后一道保险
      this.reapStaleArtifacts('周期对账').catch((err) => {
        this.logger.error(`[artifact-reaper] 周期对账异常：${(err as Error)?.message || err}`);
      });
    }, interval);
    // 别让对账定时器吊住进程退出（优雅停机 / jest）
    this.reapTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  /**
   * 一次对账：算出「当前可公开发布」的 URL 路径集合，把四个动态目录里不在集合中的
   * 产物三件套删掉。**永不 throw**（清道夫失败不能拖垮风暴/定时器，下一轮会兜底）。
   *
   * 可公开集合直接复用 SitemapProvider —— 它已经编码了全部资格规则：
   * `getAll('list', false, false)` 排除 deleted/hidden/publishAt 未到（visiblePublishFilter），
   * getSiteEntries 再跳过 private 与加密分类下的文章。**不复制谓词**：复制的第二份
   * 实现一定会漂（§7.42 的教训），而 sitemap 的语义就是"可公开索引的路径全集"。
   *
   * ⚠️ DB 读失败或集合空得可疑时**跳过删除**：拿一份不完整的 qualified 集合去对账
   * 等于把正常文章的产物全删了（下一次风暴会重建，但期间动态直服全部退化成回源，
   * 而"空集合"恰恰是 Mongo 刚恢复/刚抖动时最可能出现的形状）。
   */
  async reapStaleArtifacts(source: string): Promise<void> {
    try {
      const dir = reaperPagesDir();
      if (!fs.existsSync(dir)) {
        // dev 机 / website 分离部署：没有产物目录就没有可删的东西（不是错误）
        this.logger.debug?.(`[artifact-reaper] pages 目录不存在，跳过（来源：${source}）`);
        return;
      }
      const qualified = new Set<string>();
      // 健康检查用：getSiteEntries **无条件**包含 6 个固定页条目（读代码确认过，
      // 与文章数无关），所以"6 个都在"= 这次读取是健康的；缺任何一个都说明
      // 数据源形状不对（半初始化/DB 抖动），此时拿着不完整的集合去对账
      // 等于把正常文章的产物全删了 —— 宁可跳过，下一轮再兜。
      const FIXED_ENTRY_URLS = ['/', '/timeline', '/category', '/tag', '/about', '/link'];
      let fixedSeen = 0;
      try {
        const entries = await this.sitemapProvider.getSiteEntries();
        for (const entry of entries || []) {
          const url = (entry as { url?: unknown })?.url;
          if (typeof url !== 'string') {
            continue;
          }
          if (FIXED_ENTRY_URLS.includes(url)) {
            fixedSeen += 1;
          }
          if (url.startsWith('/post/')) {
            qualified.add(url); // getSiteEntries 的文章路径是解码后的原始 pathname
          }
        }
        const [cats, tags, pages] = await Promise.all([
          this.sitemapProvider.getCategoryUrls(),
          this.sitemapProvider.getTagUrls(),
          this.sitemapProvider.getPageUrls(),
        ]);
        for (const url of [...(cats || []), ...(tags || []), ...(pages || [])]) {
          if (typeof url !== 'string') {
            continue;
          }
          // category/tag 的 URL 是 encodeQuerystring 过的，盘上文件名是解码后的
          try {
            qualified.add(decodeURIComponent(url));
          } catch {
            qualified.add(url); // 解码不了（孤立 %）就按原样，宁可少删不误删
          }
        }
      } catch (err) {
        this.logger.error(
          `[artifact-reaper] 读取可公开集合失败，本轮跳过（来源：${source}）：${
            (err as Error)?.message || err
          }`,
        );
        return;
      }
      if (fixedSeen < FIXED_ENTRY_URLS.length) {
        this.logger.warn(
          `[artifact-reaper] 可公开集合形状异常（固定页条目 ${fixedSeen}/${FIXED_ENTRY_URLS.length}），本轮跳过不删（来源：${source}）`,
        );
        return;
      }
      // ⚠️ 这里**不**要求存在 /post/* 路径：全站文章被删光恰恰是最需要清产物的场景
      //（"没有可公开文章"是合法状态，"读取失败"才是跳过理由，两者靠 fixedSeen 区分）。
      const result = reconcileArtifacts(dir, qualified);
      if (result.deleted.length > 0) {
        const shown = result.deleted.slice(0, REAP_LOG_NAMES_MAX).join('、');
        const more = result.deleted.length > REAP_LOG_NAMES_MAX ? ' …' : '';
        this.logger.log(
          `[artifact-reaper] 删除 ${result.deleted.length} 个过期 ISR 产物（来源：${source}）：${shown}${more}`,
        );
      }
      for (const e of result.errors) {
        this.logger.warn(`[artifact-reaper] ${e}（来源：${source}）`);
      }
    } catch (err) {
      this.logger.error(
        `[artifact-reaper] 对账异常（来源：${source}）：${(err as Error)?.message || err}`,
      );
    }
  }
}
