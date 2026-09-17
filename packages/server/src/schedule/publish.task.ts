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
 */

/** 首次 tick 的回看窗口 */
export const PUBLISH_FIRST_TICK_LOOKBACK_MS = 120 * 1000;
/** 后续 tick 的重叠余量（cron 触发有毫秒级抖动） */
export const PUBLISH_TICK_SLACK_MS = 5 * 1000;

@Injectable()
export class PublishTask {
  private readonly logger = new Logger(PublishTask.name);
  /** 进程内记忆：上一次窗口边界（null = 还没跑过） */
  private lastRunAt: Date | null = null;

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
      ? new Date(this.lastRunAt.getTime() - PUBLISH_TICK_SLACK_MS)
      : new Date(now.getTime() - PUBLISH_FIRST_TICK_LOOKBACK_MS);
    const filter: any = {
      publishAt: { $gt: windowStart, $lte: now },
      deleted: { $ne: true },
    };
    const rows = await this.articleModel
      .find(filter, { id: 1, title: 1, pathname: 1, publishAt: 1 })
      .sort({ publishAt: 1 })
      .limit(500)
      .exec();
    // ⚠️ 窗口只在查询**成功后**才前移：查询失败时 lastRunAt 不动，
    // 下一次 tick 用同一个（或更宽的）窗口重查，到点的文章不会被一次抖动漏掉。
    this.lastRunAt = now;
    const due = (rows || []).map((row: any) => {
      const doc = row?._doc || row;
      return {
        id: Number(doc?.id),
        title: String(doc?.title ?? ''),
        pathname: String(doc?.pathname ?? ''),
        publishAt: doc?.publishAt instanceof Date ? doc.publishAt : new Date(doc?.publishAt),
      };
    });
    if (!due.length) {
      return due;
    }
    this.logger.log(
      `定时发布到点 ${due.length} 篇：${due
        .map((a) => `${a.id}《${a.title}》(publishAt=${a.publishAt?.toISOString?.() || a.publishAt})`)
        .join('；')}`,
    );
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
