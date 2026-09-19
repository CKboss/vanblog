import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import cluster from 'node:cluster';
import { ArticleDocument } from 'src/scheme/article.schema';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import { invalidatePublicMetaCache } from 'src/utils/publicMetaCache';

/**
 * 定时发布（publishAt）到点处理。
 *
 * 语义（在 P5 里选定并全链路钉住）：**"到点前视为未发布"是查询层的事** ——
 * 所有公开读路径都带 `publishAt <= now` 过滤，文章一到点**自动可见**，
 * 不需要任何人去翻 `hidden` 字段（也就没有"cron 挂了导致文章永远不出现"这种失败模式，
 * 更没有"cron 把管理员手动隐藏的文章翻出来"的误伤）。
 *
 * 那这个 cron 还剩下什么必须做的？三件：
 *  1. **触发 ISR 重渲染**：前台页面是增量静态化的，不触发就停留在旧页面
 *     （新文章不上首页/分页/tag/category/timeline，直到每小时的全量 cron 兜底）；
 *  2. **失效进程内的 publicMeta 缓存**（totalArticles 变了；5s TTL 本来也会过期，这里求即时）；
 *  3. **打日志点名**：哪些文章刚刚定时发布，运维要能查。
 *
 * 每分钟跑一次、只由主实例跑（沿用 isPrimaryInstance(cluster) 约定）。
 * 窗口 = (上一次 tick - 5s 余量, now]，进程内记 lastRunAt 保证每篇只点名一次；
 * 首次 tick 回看 PUBLISH_FIRST_TICK_LOOKBACK_MS（覆盖"启动前后刚好到点"的文章）。
 * 停机期间到点的文章不依赖这里：查询过滤让它们**立即可见**，
 * 页面重渲染由启动时的 activeAll 与每小时 ISR cron 兜底。
 *
 * ## 2026-09-19 复查：为什么"首次 tick 只回看 2 分钟"**不是**缺陷，而截断推进才是
 *
 * 审查提出过"停机期间到点的文章最长要 1 小时才进列表，应把首轮回看改成持久化的上次 tick 时间"。
 * 顺着调用链核完，这个结论不成立，**不采纳**，理由全部可验证：
 *  - 停机期间到点的文章，**可见性**由查询层负责（`utils/publishAt.ts` 的 `visiblePublishFilter`
 *    按 `publishAt <= now` 过滤，直接访问文章 URL 立刻能看到）；
 *  - **页面重渲染**由启动时的全量 storm 负责：`main.ts` 在主实例上调
 *    `isrProvider.activeAll('首次启动触发全量渲染！', 1000, { forceActice: true })`，
 *    而 `runStorm` 渲染的是 urlList + `post` + `page` + **`category`** + **`tag`** + 清道夫，
 *    `activeAll` 另外还会重新生成 RSS 与 sitemap（`isr.provider.ts` 调 generateRssFeed/generateSiteMap）。
 *    `forceActice: true` 保证它不会被"延时自动"模式挡掉。
 *    ⇒ 重启后首页/分类/标签/RSS/sitemap 都会重渲染，**不需要等下一个整点**。
 *  - 持久化游标还会带来新麻烦：游标若存在 `settings` 里，**整站恢复会把 settings 一起带回来**
 *    （归档是全库导出），于是每次恢复后首个 tick 都会用一个很旧的时间戳，
 *    把几百篇早已发布的文章当成"刚刚到点"点名一遍 —— 那是误导性的噪音，不是修复。
 *
 * 真正被漏掉的是另一件事：**窗口在结果被 `limit` 截断时仍然推进到 now**，
 * 于是一个窗口里到点超过 PUBLISH_TICK_LIMIT 篇时，第 501 篇之后永久落在窗口左边
 * （不点名、也不触发这一轮的增量渲染，要等整点 cron）。已修：截断时只推进到
 * 最后一篇已处理文章的 publishAt，并且不打 slack（`$gt` 严格大于 ⇒ 正好从下一篇继续，不重复点名），
 * 同时 WARN 说清"还剩多少没处理、什么时候接着处理、可见性不受影响"。
 */

/** 首次 tick 的回看窗口 */
export const PUBLISH_FIRST_TICK_LOOKBACK_MS = 120 * 1000;
/** 后续 tick 的重叠余量（cron 触发有毫秒级抖动） */
export const PUBLISH_TICK_SLACK_MS = 5 * 1000;
/**
 * 单次 tick 最多处理多少篇。
 *
 * ⚠️ 这个上限**必须**参与窗口推进的决策（见 publishDue 里的 truncated 分支）：
 * 以前不管查回来多少条都把 `lastRunAt` 推到 `now`，于是一个窗口里到点超过 500 篇时
 * （批量导入 + 统一排期、或者迁移时把 publishAt 都设在同一分钟），第 501 篇之后的
 * 文章会被**永久跳过**：它们的 publishAt 已经落在窗口左边，之后的任何窗口都不会再包含它们。
 * 文章本身仍然可见（查询层按 `publishAt <= now` 过滤），但"点名日志"没有了，
 * 而且不会触发这一轮的增量渲染 —— 要等下一个整点的全量 ISR 才补上。
 */
export const PUBLISH_TICK_LIMIT = 500;

@Injectable()
export class PublishTask {
  private readonly logger = new Logger(PublishTask.name);
  /** 进程内记忆：上一次窗口边界（null = 还没跑过） */
  private lastRunAt: Date | null = null;
  /**
   * 上一次 tick 是否被 PUBLISH_TICK_LIMIT 截断。
   * 截断时窗口起点**不减 slack**：`$gt` 是严格大于，用"最后一篇已处理文章的 publishAt"
   * 当起点就正好从下一篇继续，既不漏也不重复点名。
   */
  private lastRunTruncated = false;

  constructor(
    @InjectModel('Article')
    private readonly articleModel: Model<ArticleDocument>,
    private readonly isrProvider: ISRProvider,
  ) {}

  @Cron('0 * * * * *')
  async handleCron() {
    // 只能跑一次：ISR 触发与日志点名都不该乘以 worker 数（同 ISRTask 的理由）
    if (!isPrimaryInstance(cluster)) {
      return;
    }
    try {
      await this.publishDue();
    } catch (err) {
      // cron 里的失败必须留痕（§7.55 J 的教训：fire-and-forget 不 catch = 无来源 rejection）
      this.logger.error(`定时发布检查失败：${(err as Error)?.message || err}`);
    }
  }

  /**
   * 找出 (windowStart, now] 内到点的文章并触发渲染。
   * 返回本次点名的文章（供测试断言）；窗口自动前移。
   */
  async publishDue(now: Date = new Date()): Promise<
    Array<{ id: number; title: string; pathname: string; publishAt: Date }>
  > {
    const windowStart = this.lastRunAt
      ? new Date(
          this.lastRunAt.getTime() - (this.lastRunTruncated ? 0 : PUBLISH_TICK_SLACK_MS),
        )
      : new Date(now.getTime() - PUBLISH_FIRST_TICK_LOOKBACK_MS);
    const filter: any = {
      publishAt: { $gt: windowStart, $lte: now },
      deleted: { $ne: true },
    };
    const rows = await this.articleModel
      .find(filter, { id: 1, title: 1, pathname: 1, publishAt: 1 })
      .sort({ publishAt: 1 })
      .limit(PUBLISH_TICK_LIMIT)
      .exec();
    const due = (rows || []).map((row: any) => {
      const doc = row?._doc || row;
      return {
        id: Number(doc?.id),
        title: String(doc?.title ?? ''),
        pathname: String(doc?.pathname ?? ''),
        publishAt: doc?.publishAt instanceof Date ? doc.publishAt : new Date(doc?.publishAt),
      };
    });
    // 查到上限条数 ⇒ 窗口里可能还有没处理的（find 按 publishAt 升序，所以剩下的是**较晚**的那些）
    const truncated = (rows || []).length >= PUBLISH_TICK_LIMIT;
    // ⚠️ 窗口只在查询**成功后**才前移：查询失败时 lastRunAt 不动，
    // 下一次 tick 用同一个（或更宽的）窗口重查，到点的文章不会被一次抖动漏掉。
    // ⚠️ 被上限截断时**只推进到最后一篇已处理文章的 publishAt**，不是 now ——
    //    否则剩下的那些会永久落在窗口左边，再也不会被点名或触发渲染（见 PUBLISH_TICK_LIMIT 注释）。
    if (truncated && due.length) {
      this.lastRunAt = due[due.length - 1].publishAt;
    } else {
      this.lastRunAt = now;
    }
    this.lastRunTruncated = truncated;
    if (!due.length) {
      return due;
    }
    this.logger.log(
      `定时发布到点 ${due.length} 篇：${due
        .map((a) => `${a.id}《${a.title}》(publishAt=${a.publishAt?.toISOString?.() || a.publishAt})`)
        .join('；')}`,
    );
    if (truncated) {
      // 大声说出来：这一轮没处理完，下一次 tick（最多 1 分钟后）会从
      // `${this.lastRunAt}` 之后接着处理。文章本身**已经可见**（查询层过滤），
      // 只是增量渲染要等下一轮 —— 静默截断才是真正的问题。
      this.logger.warn(
        `这一轮到点的文章超过 ${PUBLISH_TICK_LIMIT} 篇，已处理最早的 ${due.length} 篇` +
          `（到 ${this.lastRunAt?.toISOString?.() || this.lastRunAt}），` +
          '剩余的在下一次 tick 接着处理。文章可见性不受影响（公开查询按 publishAt 过滤），' +
          '但首页/分类/标签的静态页要等下一轮增量渲染才会带上它们',
      );
    }
    // totalArticles 等公开 meta 变了：立刻失效进程内缓存（其它进程靠 5s TTL 自然过期）
    invalidatePublicMetaCache();
    // 一轮全量渲染就够（storm 会重渲染全部文章路径 + 分页 + RSS + sitemap），
    // delay=1000 与 main.ts 启动时一致：不给的话 RSS 要 3 分钟后才更新（§7.55 E 的坑）。
    // activeAll 自带 1s 防抖 + 互斥合并，多篇同分钟到点也只跑一轮。
    this.isrProvider.activeAll(
      `定时发布 ${due.length} 篇文章触发增量渲染（ids: ${due.map((a) => a.id).join(',')}）`,
      1000,
    );
    return due;
  }
}
