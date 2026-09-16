import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import dayjs from 'dayjs';
import { Meta, MetaDocument } from 'src/scheme/meta.schema';
import { Article, ArticleDocument } from 'src/scheme/article.schema';
import { Viewer, ViewerDocument } from 'src/scheme/viewer.schema';
import { Visit, VisitDocument } from 'src/scheme/visit.schema';
import { safeDecodeURIComponent } from 'src/utils/safeDecode';
import { tryParseNumericId } from 'src/utils/numericId';
import {
  DayBatch,
  PathDelta,
  ViewStatsAggregator,
  ViewStatsBatch,
} from 'src/utils/viewStatsBuffer';

/**
 * 把"每次浏览各写一遍"改成"攒一批写一遍"。
 *
 * 改动前（实测：mongod `serverStatus().metrics.commands` 差值，扣掉背景噪音）
 * 一次文章页浏览 = **8 次 Mongo 命令 / 4 次写**：
 *   users 1 find（InitMiddleware） + metas 1 findAndModify + articles 2 find + 1 update
 *   + visits 1 findAndModify + viewers 1 find + 1 update。
 * 改动后一轮 flush 固定 **4 次命令 / 4 次写**（metas / articles / visits / viewers 各一次），
 * 与这一轮攒了多少次浏览**无关**；只有"某条路径当天第一次被访问"时多 2 次
 * （aggregate 取上一天的累计值 + 建当天那行）。
 *
 * 为什么可以攒：这四个集合写的都是**计数器**，`$inc` 满足结合律，
 * 而 `viewers`/`visits` 里存的是累计快照，只有"最后一次写"有意义。
 * 所以把 5 秒内的 N 次浏览合成一次 `$inc: N`，落库后的最终值与逐次自增**完全相同**。
 *
 * 三个不能丢的东西：
 *  1. **接口返回值**：`POST /api/public/viewer` 要回 `{visited, viewer}`（站点累计值）。
 *     这里维护一个 `base`（上一轮 flush 之后库里的权威值）+ 待写入增量，
 *     投影出来的数就是"这次浏览之后站点真实的累计值"，与改动前一致；
 *     每轮 flush 用 `findOneAndUpdate({new:true})` 把 `base` 重新对齐一次，
 *     多进程部署下各自的漂移最多存活一个 flush 周期。
 *  2. **SIGTERM 不能丢计数**：`main.ts` 的优雅退出里会在关库之前显式 `flush('SIGTERM')`，
 *     这里另外实现 `onModuleDestroy` / `onApplicationShutdown` 做兜底（幂等，空批次直接返回）。
 *  3. **写失败不能丢计数**：每个阶段各自 try/catch，失败的阶段把增量 `merge()` 回累加器，
 *     下一轮重写；阶段之间互不牵连（metas 写成功而 visits 写失败时不会把 metas 再算一遍）。
 *
 * 环境变量：
 *  - `VANBLOG_VIEW_FLUSH_MS`（默认 5000，与 `/api/public/meta` 的 5 秒进程内缓存同一个量级）；
 *    设成 `0` 表示**不缓冲**：每次浏览立刻落库（仍然走同一条批量代码，
 *    单次浏览 8 → 6 次命令，只是没有合并效果）。
 *  - `VANBLOG_VIEW_FLUSH_MAX_EVENTS`（默认 1000）：攒够这么多条提前 flush，给内存封顶。
 */

/** 「没被软删除」——与 `ArticleProvider.getByPathName` 的过滤条件逐字一致 */
const NOT_DELETED = { $or: [{ deleted: false }, { deleted: { $exists: false } }] };

/** 一次 aggregate 最多塞多少个路径（`$in` 太长会让 planner 放弃索引） */
const SEED_CHUNK = 500;

function buildInc(delta: PathDelta): Record<string, number> {
  const inc: Record<string, number> = {};
  if (delta.viewer) inc.viewer = delta.viewer;
  if (delta.visited) inc.visited = delta.visited;
  return inc;
}

/** 唯一索引冲突（并发 seed 同一天同一路径）——对方已经把行建好了，不是错误 */
function isDuplicateKeyError(err: any): boolean {
  if (!err) return false;
  if (err.code === 11000) return true;
  const writeErrors = err?.writeErrors || err?.result?.result?.writeErrors;
  if (Array.isArray(writeErrors) && writeErrors.length) {
    return writeErrors.every((e: any) => e?.code === 11000 || e?.err?.code === 11000);
  }
  return false;
}

function envNonNegativeInt(name: string, fallback: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.min(Math.trunc(raw), max);
}

/**
 * 写库失败时被退回累加器的增量，最多保留多少个"路径/文章"键（`0` = 不限）。
 *
 * ⚠️ 不设上限就是**常驻进程里唯一一条能无限长内存的路**：退回时 `events` 记 0
 * （免得日志虚高），所以 `VANBLOG_VIEW_FLUSH_MAX_EVENTS` 那个封顶在失败期间根本不生效 ——
 * Mongo 写不进去的这段时间里，每 5 秒 take()→失败→merge() 回来，路径键只增不减，
 * 而清除只在写成功时发生。默认 20000 条 ≈ 2.5 MB（实测每条 ~120 B：
 * 路径字符串 + PathDelta + Map 条目）。
 */
export const DEFAULT_VIEW_MAX_RETAINED_KEYS = 20000;
export const VIEW_MAX_RETAINED_KEYS = envNonNegativeInt(
  'VANBLOG_VIEW_MAX_RETAINED_KEYS',
  DEFAULT_VIEW_MAX_RETAINED_KEYS,
  10000000,
);

export interface FlushSummary {
  reason: string;
  events: number;
  ops: number;
  ms: number;
}

export interface ViewStatsCounters {
  views: number;
  flushes: number;
  ops: number;
  errors: number;
  events: number;
}

@Injectable()
export class ViewStatsProvider implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  logger = new Logger(ViewStatsProvider.name);
  private readonly aggregator = new ViewStatsAggregator({
    maxRetainedKeys: VIEW_MAX_RETAINED_KEYS,
  });
  /** 上一轮 flush 之后库里的 metas 累计值；null 表示库里根本没有 metas 文档（站点没初始化） */
  private base: PathDelta | null = null;
  /** base 到底读过没有（与"读过了但是 null"区分开，否则每次投影都要再查一次库） */
  private baseLoaded = false;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopping = false;
  /** 每日快照写失败、等着补写的日期 */
  private pendingSnapshots = new Set<string>();

  readonly flushMs = envNonNegativeInt('VANBLOG_VIEW_FLUSH_MS', 5000, 600000);
  readonly maxPending = envNonNegativeInt('VANBLOG_VIEW_FLUSH_MAX_EVENTS', 1000, 1000000);
  readonly counters: ViewStatsCounters = { views: 0, flushes: 0, ops: 0, errors: 0, events: 0 };

  constructor(
    @InjectModel('Meta') private metaModel: Model<MetaDocument>,
    @InjectModel('Article') private articleModel: Model<ArticleDocument>,
    @InjectModel('Viewer') private viewerModel: Model<ViewerDocument>,
    @InjectModel('Visit') private visitModel: Model<VisitDocument>,
  ) {}

  onModuleInit() {
    if (this.flushMs <= 0) {
      this.logger.log('浏览统计不缓冲（VANBLOG_VIEW_FLUSH_MS=0）：每次浏览立刻落库');
      return;
    }
    // unref：别让这个定时器把进程（或 jest）吊住
    this.timer = setInterval(() => void this.flush('timer'), this.flushMs);
    this.timer.unref?.();
    this.logger.log(
      `浏览统计已开启合并写入：每 ${this.flushMs}ms 或攒够 ${this.maxPending} 次浏览落一次库`,
    );
  }

  async onModuleDestroy() {
    await this.flush('module-destroy');
  }

  async onApplicationShutdown() {
    this.stopping = true;
    await this.flush('app-shutdown');
  }

  /** 停掉定时器（优雅退出用；flush 由调用方显式触发，保证顺序在关库之前） */
  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 记一次浏览，返回"这次浏览之后站点的累计值"（接口直接用它回包）。
   * 热路径上只碰内存；`VANBLOG_VIEW_FLUSH_MS=0` 时立刻落库。
   */
  async record(input: {
    pathname: string;
    isNewVisitor: boolean;
    isNewForPath: boolean;
  }): Promise<{ viewer: number; visited: number }> {
    this.aggregator.add({
      pathname: input.pathname,
      isNewVisitor: input.isNewVisitor,
      isNewForPath: input.isNewForPath,
      date: dayjs().format('YYYY-MM-DD'),
    });
    this.counters.views += 1;
    if (this.flushMs <= 0) {
      await this.flush('unbuffered');
    } else if (this.aggregator.pending >= this.maxPending) {
      void this.flush('max-pending');
    }
    return this.projection();
  }

  /** 库里还没写的那部分也算上：这才是"现在"的真实累计值 */
  async projection(): Promise<{ viewer: number; visited: number }> {
    if (!this.baseLoaded) {
      await this.refreshBase();
    }
    // 库里没有 metas 文档（站点还没初始化）时按 0 回，与改动前 `updated?.viewer || 0` 一致
    if (!this.base) {
      return { viewer: 0, visited: 0 };
    }
    const pending = this.aggregator.pendingSite();
    return {
      viewer: this.base.viewer + pending.viewer,
      visited: this.base.visited + pending.visited,
    };
  }

  /**
   * 让 `base` 失效：整站恢复 / 后台直接改 metas 之后必须调，
   * 否则投影出来的累计值会带着恢复前的旧基数。
   */
  invalidateBase() {
    this.base = null;
    this.baseLoaded = false;
  }

  private async refreshBase(): Promise<void> {
    try {
      // 只取两个数字：改动前 `getViewer()` 走的是 `findOne()` 全文档
      const doc = await this.metaModel
        .findOne({}, { viewer: 1, visited: 1 })
        .lean<{ viewer?: number; visited?: number } | null>()
        .exec();
      this.base = doc ? { viewer: doc.viewer || 0, visited: doc.visited || 0 } : null;
    } catch (err) {
      // 读不到就先按 0 算，别让统计接口 500；下一轮 flush 会重新对齐
      this.base = { viewer: 0, visited: 0 };
      this.logger.warn(`读取站点累计访问量失败：${(err as Error)?.message || err}`);
    } finally {
      this.baseLoaded = true;
    }
  }

  /** 串行化：两轮 flush 不重叠，否则旧批次的每日快照可能覆盖新批次的 */
  flush(reason: string): Promise<FlushSummary> {
    const run = this.chain.then(
      () => this.doFlush(reason),
      () => this.doFlush(reason),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doFlush(reason: string): Promise<FlushSummary> {
    if (this.aggregator.isEmpty() && this.pendingSnapshots.size === 0) {
      return { reason, events: 0, ops: 0, ms: 0 };
    }
    const startedAt = Date.now();
    const batch = this.aggregator.take();
    const now = new Date();
    let ops = 0;

    // 1) metas：一次 $inc 顺手拿回权威总数（同时纠正 base 的多进程漂移）
    let totals: PathDelta | null = this.base ? { ...this.base } : null;
    const metaInc = buildInc(batch.site);
    if (Object.keys(metaInc).length) {
      try {
        const updated = await this.metaModel
          .findOneAndUpdate({}, { $inc: metaInc }, { new: true, projection: { viewer: 1, visited: 1 } })
          .exec();
        ops += 1;
        if (updated) {
          totals = { viewer: updated.viewer || 0, visited: updated.visited || 0 };
          // $inc 的返回值就是权威值：顺手把 base 对齐，投影就不必再读一次库
          this.base = totals;
          this.baseLoaded = true;
        } else {
          totals = null;
        }
      } catch (err) {
        ops += 1;
        this.stageFailed('metas', err);
        this.aggregator.merge({ ...batch, events: 0, articles: new Map(), days: [] });
      }
    }

    // 2) articles：一批一次 bulkWrite
    try {
      ops += await this.flushArticles(batch, now);
    } catch (err) {
      this.stageFailed('articles', err);
      this.aggregator.merge({ ...batch, events: 0, site: { viewer: 0, visited: 0 }, days: [] });
    }

    // 3) visits + viewers：按天分组（跨零点的批次各归各的天）
    ops += await this.flushDays(batch, totals, now);

    this.counters.flushes += 1;
    this.counters.ops += ops;
    this.counters.events += batch.events;
    this.reportDropped();
    const ms = Date.now() - startedAt;
    this.logger.debug(
      `浏览统计落库（${reason}）：${batch.events} 次浏览 → ${ops} 次 Mongo 命令，耗时 ${ms}ms`,
    );
    return { reason, events: batch.events, ops, ms };
  }

  /**
   * 被内存上限丢掉的增量必须**看得见**：静默丢计数的表现是"统计数字比实际低"，
   * 而这种问题从来没人能事后查出来。每轮 flush 最多打一条（有增量才打）。
   */
  private lastReportedDropped = { pathEntries: 0, articleEntries: 0 };
  private reportDropped(): void {
    const dropped = this.aggregator.dropped;
    const newPaths = dropped.pathEntries - this.lastReportedDropped.pathEntries;
    const newArticles = dropped.articleEntries - this.lastReportedDropped.articleEntries;
    if (newPaths <= 0 && newArticles <= 0) {
      return;
    }
    this.lastReportedDropped = {
      pathEntries: dropped.pathEntries,
      articleEntries: dropped.articleEntries,
    };
    this.counters.errors += 1;
    this.logger.warn(
      `浏览统计的内存上限（VANBLOG_VIEW_MAX_RETAINED_KEYS=${VIEW_MAX_RETAINED_KEYS}）已经丢掉 ` +
        `${newPaths} 条路径增量、${newArticles} 条文章增量（累计 ${dropped.pathEntries}/${dropped.articleEntries}）——` +
        '说明写库连续失败了一段时间；站点总访问量（metas）没有丢，丢的是按路径/按文章的那部分',
    );
  }

  private stageFailed(stage: string, err: unknown) {
    this.counters.errors += 1;
    this.logger.error(
      `写入${stage}统计失败，增量已退回队列等下一轮重写（不影响访问）：${
        (err as Error)?.message || err
      }`,
    );
  }

  private async flushArticles(batch: ViewStatsBatch, now: Date): Promise<number> {
    if (batch.articles.size === 0) return 0;
    const byPathname: any[] = [];
    const numeric: Array<{ key: string; id: number; delta: PathDelta }> = [];
    for (const [key, delta] of batch.articles) {
      const numericId = tryParseNumericId(key);
      if (numericId === null) {
        byPathname.push({
          updateOne: {
            filter: { pathname: safeDecodeURIComponent(key), $and: [NOT_DELETED] },
            update: { $inc: buildInc(delta), $set: { lastVisitedTime: now } },
          },
        });
      } else {
        numeric.push({ key, id: numericId, delta });
      }
    }
    let ops = 0;
    if (byPathname.length) {
      await this.articleModel.bulkWrite(byPathname, { ordered: false });
      ops += 1;
    }
    // 数字 id 的老链接（/post/12）：与改动前一致，先按别名找，找不到再按 id 找。
    // 这种键一轮里通常一个都没有，所以单独走 updateOne 也不会变成开销。
    for (const item of numeric) {
      const update = { $inc: buildInc(item.delta), $set: { lastVisitedTime: now } };
      const byPath = await this.articleModel
        .updateOne({ pathname: safeDecodeURIComponent(item.key), $and: [NOT_DELETED] }, update)
        .exec();
      ops += 1;
      if (!byPath || byPath.matchedCount === 0) {
        await this.articleModel.updateOne({ id: item.id, $and: [NOT_DELETED] }, update).exec();
        ops += 1;
      }
    }
    return ops;
  }

  private async flushDays(
    batch: ViewStatsBatch,
    totals: PathDelta | null,
    now: Date,
  ): Promise<number> {
    let ops = 0;
    // 上一轮快照写失败、等着补写的日期。**在开始之前**取走，
    // 否则这一轮刚失败的日期会在同一轮里立刻重试（那等于没有重试）。
    const retrySnapshots = [...this.pendingSnapshots];
    this.pendingSnapshots.clear();
    for (let i = 0; i < batch.days.length; i += 1) {
      const day = batch.days[i];
      // visits 与 viewers 各自兜错：一个失败不该让另一个的数据被重复写一遍
      try {
        ops += await this.flushVisits(day, now);
      } catch (err) {
        this.stageFailed('visits', err);
        this.aggregator.merge({
          events: 0,
          site: { viewer: 0, visited: 0 },
          articles: new Map(),
          days: [day],
        });
      }
      // 跨零点的批次：早的那一天的快照不该包含晚的那些自增
      let laterViewer = 0;
      let laterVisited = 0;
      for (let j = i + 1; j < batch.days.length; j += 1) {
        laterViewer += batch.days[j].site.viewer;
        laterVisited += batch.days[j].site.visited;
      }
      ops += await this.writeViewerSnapshot(
        day.date,
        totals ? { viewer: totals.viewer - laterViewer, visited: totals.visited - laterVisited } : null,
        now,
      );
    }
    // 补写上一轮失败的每日快照（值取当前权威总数；没有新浏览时也要补，见 doFlush 的空批次判断）
    for (const date of retrySnapshots) {
      ops += await this.writeViewerSnapshot(date, totals, now);
    }
    return ops;
  }

  /**
   * `viewers` 那一行是 metas 累计值的**每日快照**（绝对值），后台的访问趋势图靠它。
   * 写失败不需要退回增量（下一轮会用更新的绝对值重写），但要记住这一天，
   * 免得站点随后安静下来、这一天的快照就一直停在旧值上。
   */
  private async writeViewerSnapshot(
    date: string,
    totals: PathDelta | null,
    now: Date,
  ): Promise<number> {
    if (!totals) return 0;
    try {
      await this.viewerModel
        .updateOne(
          { date },
          {
            $set: { viewer: totals.viewer, visited: totals.visited },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true },
        )
        .exec();
      return 1;
    } catch (err) {
      this.stageFailed('viewers', err);
      this.pendingSnapshots.add(date);
      return 1;
    }
  }

  /**
   * visits 是「按路径累计」而不是「当天计数」：新的一天那一行必须从上一天的值接着加，
   * 否则前台的阅读量会在每天零点掉回 1（证据：`visit.provider.add()` 建当天那行时用的就是
   * `getLastData(pathname)` 的 `lastViewer + 1`）。所以每一轮 flush 都要先问一次
   * "这批路径最近一行是哪天、累计到多少"，缺当天那行的先建出来，再统一 `$inc`。
   *
   * ⚠️ 这里**故意不缓存**"今天已经建过行了"：那种缓存会在整站恢复、手工清数据、
   * 多进程部署之下变成假的，一旦假了，`upsert` 就会建出一行**丢失累计基数**的记录
   * （表现为某条路径的阅读量突然掉回个位数，而且第二天会继续以它为基数，永久错下去）。
   * 一次 aggregate 走 `{pathname:1,date:-1}` 索引，代价远小于这个坑。
   */
  private async flushVisits(day: DayBatch, now: Date): Promise<number> {
    const entries = [...day.paths.entries()];
    if (!entries.length) return 0;
    let ops = 0;

    const seeds = await this.resolveSeeds(day.date, entries.map(([p]) => p));
    ops += 1;
    if (seeds.length) {
      try {
        await this.visitModel.bulkWrite(
          seeds.map((s) => ({
            updateOne: {
              filter: { date: day.date, pathname: s.pathname },
              update: {
                // 只在"真的要插入"时写基数：已经有人建好了就一个字都不改
                $setOnInsert: {
                  date: day.date,
                  pathname: s.pathname,
                  viewer: s.viewer,
                  visited: s.visited,
                  createdAt: now,
                  lastVisitedTime: now,
                },
              },
              upsert: true,
            },
          })),
          { ordered: false },
        );
      } catch (err) {
        // 唯一索引下并发建同一行会 E11000：对方已经建好了，不是错误
        if (!isDuplicateKeyError(err)) throw err;
      }
      ops += 1;
    }

    const res = await this.visitModel.bulkWrite(
      entries.map(([pathname, delta]) => ({
        updateOne: {
          filter: { date: day.date, pathname },
          update: {
            $inc: buildInc(delta),
            $set: { lastVisitedTime: now },
            $setOnInsert: { createdAt: now, date: day.date, pathname },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    ops += 1;
    if ((res as any)?.upsertedCount > 0) {
      // 走到这里说明上一步的建行没兜住：这一行是从 0 开始建的，累计基数丢了。
      // 计数没丢（所以只警告不回滚），但要能被人看见。
      this.logger.warn(
        `visits 有 ${(res as any).upsertedCount} 行是在没有累计基数的情况下新建的（${day.date}），` +
          '请检查该路径的历史行是否被外部删除过',
      );
    }
    return ops;
  }

  /**
   * 查这批路径"最近一行"的日期与累计值，返回**当天还缺行**的那些路径该用什么基数建行。
   * 走 `{pathname:1, date:-1}` 索引；`$in` 太长会分片，免得 planner 放弃索引。
   */
  private async resolveSeeds(
    date: string,
    pathnames: string[],
  ): Promise<Array<{ pathname: string; viewer: number; visited: number }>> {
    const out: Array<{ pathname: string; viewer: number; visited: number }> = [];
    for (let i = 0; i < pathnames.length; i += SEED_CHUNK) {
      const chunk = pathnames.slice(i, i + SEED_CHUNK);
      const rows = await this.visitModel
        .aggregate([
          { $match: { pathname: { $in: chunk } } },
          { $sort: { pathname: 1, date: -1 } },
          {
            $group: {
              _id: '$pathname',
              date: { $first: '$date' },
              viewer: { $first: '$viewer' },
              visited: { $first: '$visited' },
            },
          },
        ])
        .exec();
      const byPath = new Map<string, { date?: string; viewer?: number; visited?: number }>();
      for (const row of rows) {
        if (row && typeof row._id === 'string') byPath.set(row._id, row);
      }
      for (const pathname of chunk) {
        const last = byPath.get(pathname);
        if (last && last.date === date) continue; // 当天那行已经有了，直接 $inc
        out.push({ pathname, viewer: last?.viewer || 0, visited: last?.visited || 0 });
      }
    }
    return out;
  }
}
