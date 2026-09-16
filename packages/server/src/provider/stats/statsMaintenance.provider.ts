import cluster from 'node:cluster';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { isPrimaryInstance } from 'src/utils/clusterRole';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { VisitDocument } from 'src/scheme/visit.schema';
import { ViewerDocument } from 'src/scheme/viewer.schema';
import { mergeVisitGroup, planRetention, RetentionPlan, VisitLike } from 'src/utils/statsMaintenance';

/**
 * `visits` / `viewers` 两张统计表的维护：去重合并、唯一索引、按保留期清理。
 *
 * 三件事为什么必须一起做：
 *
 * 1. **`VisitProvider.add()` 的"重复键兜底"一直是空的**。它 catch 住 duplicate key 之后
 *    退回 `$inc`，前提是 `{date,pathname}` 上有唯一索引 —— 但 `listIndexes` 实测只有
 *    非唯一的 `date_1` / `pathname_1` / `pathname_1_date_-1`。于是并发首访会**静默产生重复行**，
 *    之后 `findOneAndUpdate({date,pathname})` 只更新其中一行（另一行的累计值就永久停在旧值上）。
 *    本机线上数据里实测到 **2 组重复**：`{2026-02-28, "/"}` 与 `{2025-02-03, "/"}`，
 *    每组 2 行，两行的 `createdAt` 相差 9 毫秒 —— 正是并发首访的指纹。
 *
 * 2. **合并计数取 max 而不是求和**，理由与实测证据写在 `utils/statsMaintenance.ts` 的
 *    `mergeVisitGroup()` 上（visits 存的是累计值，求和会把阅读量翻倍）。
 *
 * 3. **唯一索引必须在去重之后建**，否则 `createIndex` 直接失败。所以这里不是往 schema 上
 *    贴 `unique: true`（那样 `autoIndex` 会在启动时先撞上重复行、报一次错、要等下一次启动才建好），
 *    而是显式 `createIndex` + 前置检查，一次启动就收敛，且**已经建好时只花一次 `listIndexes`**。
 *
 * 4. **删掉两个纯前缀重复的单列索引**（`visits.date_1` / `visits.pathname_1`）：
 *    它们分别是 `{date:1,pathname:1}`（唯一）与 `{pathname:1,date:-1}` 的前缀，
 *    explain 全量扫过一遍后没有任何查询会选它们（{date,pathname} 走唯一索引或
 *    pathname_1_date_-1，{pathname} 走 pathname_1_date_-1，{date:$range} 走
 *    date_1_pathname_1 的 date 前缀，实测删除前后 winningPlan 不变），
 *    却各占 ~150KB 并给每次写多加一个索引维护操作。
 *    **只在替代的复合索引确实存在时才删**，绝不无条件删；schema 里那两个 `@Prop`
 *    已经去掉 `index: true`，`autoIndex` 不会再把它们建回来。
 *
 * ⚠️ 全部都不在请求路径上：去重与建索引只在启动时跑一次（`onApplicationBootstrap` 里
 * fire-and-forget，不阻塞 listen），清理挂在已有的每日 `ViewerTask` cron 上。
 *
 * 环境变量：
 *  - `VANBLOG_VISITS_DEDUP=false` 关掉启动去重（默认开）
 *  - `VANBLOG_VISITS_DEDUP_DRY_RUN=true` 只打印会合并什么，不真的写
 *  - `VANBLOG_VISITS_DROP_REDUNDANT_INDEXES=false` 关掉冗余前缀索引的删除（默认开）
 *  - `VANBLOG_VISIT_RETENTION_DAYS`（默认 **0 = 永不删除**，行为与改动前完全一致）
 *  - `VANBLOG_VISIT_RETENTION_MIN_KEEP_DAYS`（默认 30）：无论上面设成多少，最近这些天一定保留
 */

/** 一次启动最多处理多少个重复组（正常站点是个位数；给个上限免得异常数据把启动拖死） */
const MAX_DUP_GROUPS = 20000;

export const VISIT_UNIQUE_INDEX_KEYS = { date: 1, pathname: 1 };
export const VISIT_UNIQUE_INDEX_NAME = 'date_1_pathname_1';
/** schema 里显式声明的复合索引（`VisitSchema.index({pathname:1,date:-1})`），替代单列 pathname_1 */
export const VISIT_COMPOUND_INDEX_KEYS = { pathname: 1, date: -1 };
export const VIEWER_UNIQUE_INDEX_KEYS = { date: 1 };
export const VIEWER_UNIQUE_INDEX_NAME = 'date_1';

/** visits 上"单列前缀重复"的候选，以及各自必须由哪个复合索引替代才允许删 */
const REDUNDANT_VISIT_INDEXES: Array<{
  keys: Record<string, number>;
  replacement: Record<string, number>;
}> = [
  { keys: { date: 1 }, replacement: VISIT_UNIQUE_INDEX_KEYS },
  { keys: { pathname: 1 }, replacement: VISIT_COMPOUND_INDEX_KEYS },
];

export const RETENTION_DEFAULTS = { retentionDays: 0, minKeepDays: 30 };

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function envNonNegative(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.floor(raw);
}

function sameKeySpec(a: Record<string, unknown> | undefined, b: Record<string, unknown>): boolean {
  if (!a) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return false;
    if (Number(a[ka[i]]) !== Number(b[kb[i]])) return false;
  }
  return true;
}

export interface DedupResult {
  /** 找到的重复组数 */
  groups: number;
  /** 实际删掉的行数 */
  dropped: number;
  /** 只打印不写（dry run） */
  dryRun: boolean;
  skipped: boolean;
  details: Array<{ date: string; pathname: string; rows: number; kept: any; dropped: any[] }>;
}

export interface IndexResult {
  collection: string;
  name: string;
  /** 这次建了（或替换成唯一的） */
  created: boolean;
  /** 原本已经有一个非唯一的同键索引，被替换掉了 */
  replaced: boolean;
  error?: string;
}

export interface PruneResult {
  enabled: boolean;
  effectiveDays: number;
  cutoff: string | null;
  visits: number;
  viewers: number;
}

export interface DropRedundantResult {
  /** kill-switch 关着（`VANBLOG_VISITS_DROP_REDUNDANT_INDEXES=false`）或 dry run */
  skipped: boolean;
  /** 这次实际删掉的索引名 */
  dropped: string[];
  /** 找到了候选但"替代复合索引不存在"而保留的（安全护栏，绝不无条件删） */
  kept: Array<{ name: string; reason: string }>;
  /** 删完之后 collStats 的 totalIndexSize（读不到就是 null） */
  totalIndexSize: number | null;
  errors: string[];
}

@Injectable()
export class StatsMaintenanceProvider implements OnApplicationBootstrap {
  logger = new Logger(StatsMaintenanceProvider.name);
  private startupDone = false;

  readonly dedupEnabled = envFlag('VANBLOG_VISITS_DEDUP', true);
  readonly dedupDryRun = envFlag('VANBLOG_VISITS_DEDUP_DRY_RUN', false);
  readonly dropRedundantIndexes = envFlag('VANBLOG_VISITS_DROP_REDUNDANT_INDEXES', true);
  readonly retentionDays = envNonNegative(
    'VANBLOG_VISIT_RETENTION_DAYS',
    RETENTION_DEFAULTS.retentionDays,
  );
  readonly minKeepDays = envNonNegative(
    'VANBLOG_VISIT_RETENTION_MIN_KEEP_DAYS',
    RETENTION_DEFAULTS.minKeepDays,
  );

  constructor(
    @InjectModel('Visit') private visitModel: Model<VisitDocument>,
    @InjectModel('Viewer') private viewerModel: Model<ViewerDocument>,
  ) {}

  /**
   * 启动时跑一次：去重 + 建唯一索引。
   * 故意**不 await**（Nest 会等 `onApplicationBootstrap` 返回才继续），
   * 免得一个大站的去重把启动时间拖长；它不在请求路径上，慢一点没关系。
   */
  onApplicationBootstrap() {
    // 去重会删行、建索引会改集合元数据：多进程时只让主实例做一遍
    if (!isPrimaryInstance(cluster)) {
      return;
    }
    void this.runStartupMaintenance('启动').catch((err) => {
      this.logger.error(`统计表启动维护失败（不影响服务）：${(err as Error)?.message || err}`);
    });
  }

  async runStartupMaintenance(reason: string): Promise<{
    dedup: DedupResult;
    indexes: IndexResult[];
    dropped: DropRedundantResult;
  }> {
    if (this.startupDone) {
      return {
        dedup: { groups: 0, dropped: 0, dryRun: false, skipped: true, details: [] },
        indexes: [],
        dropped: { skipped: true, dropped: [], kept: [], totalIndexSize: null, errors: [] },
      };
    }
    this.startupDone = true;

    // 每张表只读一次索引列表：既用来判断"要不要去重"，也用来判断"要不要建索引"
    const visitIndexes = await this.listIndexes(this.visitModel, 'visits');
    const viewerIndexes = await this.listIndexes(this.viewerModel, 'viewers');
    const visitsUnique = visitIndexes.some(
      (i: any) => sameKeySpec(i.key, VISIT_UNIQUE_INDEX_KEYS) && i.unique === true,
    );
    let dedup: DedupResult = {
      groups: 0,
      dropped: 0,
      dryRun: this.dedupDryRun,
      skipped: true,
      details: [],
    };
    // 唯一索引已经在了 => 库里不可能有重复行，跳过整轮扫描（这是重跑时的常态）
    if (!visitsUnique) {
      if (this.dedupEnabled) {
        dedup = await this.dedupVisits({ dryRun: this.dedupDryRun });
      } else {
        this.logger.warn(
          'visits 缺少 {date,pathname} 唯一索引，但 VANBLOG_VISITS_DEDUP=false 跳过了去重；' +
            '并发首访仍可能产生重复行',
        );
      }
    }

    const indexes: IndexResult[] = [];
    let dropped: DropRedundantResult = {
      skipped: true,
      dropped: [],
      kept: [],
      totalIndexSize: null,
      errors: [],
    };
    if (!this.dedupDryRun) {
      const visitsUnique = await this.ensureUniqueIndex(
        'visits',
        this.visitModel,
        VISIT_UNIQUE_INDEX_KEYS,
        VISIT_UNIQUE_INDEX_NAME,
        visitIndexes,
      );
      indexes.push(visitsUnique);
      // 冗余前缀索引只有在"替代的复合索引确实存在"时才删（唯一索引刚建好也算存在）
      dropped = await this.dropRedundantVisitIndexes(visitIndexes, visitsUnique);
    }
    // viewers 的每日快照同理：upsert 要有唯一索引才不会被并发插成两行
    indexes.push(
      await this.ensureUniqueIndex(
        'viewers',
        this.viewerModel,
        VIEWER_UNIQUE_INDEX_KEYS,
        VIEWER_UNIQUE_INDEX_NAME,
        viewerIndexes,
      ),
    );

    this.logger.log(
      `[${reason}] 统计表维护完成：重复组 ${dedup.groups} 个、合并删除 ${dedup.dropped} 行` +
        `${dedup.dryRun ? '（dry run，未写入）' : ''}；索引 ${indexes
          .map((i) => `${i.collection}.${i.name}=${i.error ? `失败(${i.error})` : i.created ? (i.replaced ? '已改为唯一' : '已建唯一') : '已存在'}`)
          .join(', ')}`,
    );
    return { dedup, indexes, dropped };
  }

  private async listIndexes(model: Model<any>, collection: string): Promise<any[]> {
    try {
      return await model.collection.indexes();
    } catch (err) {
      this.logger.warn(`读取 ${collection} 索引列表失败：${(err as Error)?.message || err}`);
      return [];
    }
  }

  /**
   * 删掉 visits 上两个纯前缀重复的单列索引（`{date:1}` 与 `{pathname:1}`）。
   *
   * 安全护栏（每一条都有测试钉住）：
   *  - **替代复合索引不存在就不删**：`{date:1}` 必须有 `{date:1,pathname:1}`（唯一），
   *    `{pathname:1}` 必须有 `{pathname:1,date:-1}`；缺任何一个就保留并 WARN
   *    （schema 去掉 `index: true` 之后 `autoIndex` 不会再建单列的，
   *    复合的则一个来自 schema 声明、一个来自本 provider 的 ensureUniqueIndex）。
   *  - 唯一索引是**这一轮刚建的**时，启动时那份索引列表里还没有它 —— 所以候选存在而
   *    替代索引"看不到"时，会**重新 listIndexes 一次**再下结论（幂等重跑时没有候选，
   *    一次多余的读取都不会发生）。
   *  - `dropIndex` 报 "index not found"（别的实例已经删了）按成功处理；
   *    其它错误记进 errors，不往外抛（启动维护失败不能影响服务）。
   *  - 删完读一次 collStats，把 `totalIndexSize` 写进日志（本机实测
   *    1,183,744 B → 预期 ~897,024 B，低于加唯一索引之前的 937,984 B）。
   */
  async dropRedundantVisitIndexes(
    knownIndexes: any[],
    visitsUniqueResult?: IndexResult | null,
  ): Promise<DropRedundantResult> {
    const out: DropRedundantResult = {
      skipped: false,
      dropped: [],
      kept: [],
      totalIndexSize: null,
      errors: [],
    };
    if (!this.dropRedundantIndexes) {
      out.skipped = true;
      return out;
    }
    let indexes = Array.isArray(knownIndexes) ? knownIndexes : [];
    const findCandidate = (keys: Record<string, number>) =>
      indexes.find((i: any) => sameKeySpec(i.key, keys) && i.unique !== true);
    // 常态（已经删过 / 全新安装）：一个候选都没有，直接返回，不多花任何一次数据库调用
    if (!REDUNDANT_VISIT_INDEXES.some((c) => findCandidate(c.keys))) {
      this.logger.log('[visits] 冗余前缀索引：无可删（date_1 / pathname_1 都不存在）');
      return out;
    }
    // 唯一索引可能是这一轮 ensureUniqueIndex 刚建出来的（knownIndexes 里看不到）；
    // ensureUniqueIndex 失败时它也可能真的不存在 —— 两种情况都重新读一次列表，以库里的真值为准
    const uniqueJustCreated = Boolean(
      visitsUniqueResult && !visitsUniqueResult.error && visitsUniqueResult.created,
    );
    const replacementMissing = REDUNDANT_VISIT_INDEXES.some(
      (c) => findCandidate(c.keys) && !indexes.some((i: any) => sameKeySpec(i.key, c.replacement)),
    );
    if (uniqueJustCreated || replacementMissing) {
      indexes = await this.listIndexes(this.visitModel, 'visits');
    }
    for (const cand of REDUNDANT_VISIT_INDEXES) {
      const idx = findCandidate(cand.keys);
      if (!idx) continue;
      if (!indexes.some((i: any) => sameKeySpec(i.key, cand.replacement))) {
        out.kept.push({
          name: idx.name,
          reason: `替代索引 ${JSON.stringify(cand.replacement)} 不存在`,
        });
        continue;
      }
      try {
        await this.visitModel.collection.dropIndex(idx.name);
        out.dropped.push(idx.name);
      } catch (err) {
        const msg = String((err as Error)?.message || err);
        if (/index not found/i.test(msg)) {
          out.dropped.push(idx.name); // 别的实例已经删了：目的达成
        } else {
          out.errors.push(`${idx.name}: ${msg.slice(0, 200)}`);
        }
      }
    }
    if (out.dropped.length) {
      try {
        const stats: any = await (this.visitModel.collection as any).stats();
        const size = Number(stats?.totalIndexSize);
        out.totalIndexSize = Number.isFinite(size) ? size : null;
      } catch {
        // collStats 读不到不影响删除本身
      }
      this.logger.log(
        `[visits] 已删除冗余前缀索引：${out.dropped.join(', ')}` +
          (out.totalIndexSize != null ? `；totalIndexSize 现为 ${out.totalIndexSize} B` : '') +
          (out.errors.length ? `；失败 ${out.errors.join('; ')}` : ''),
      );
    }
    if (out.kept.length) {
      this.logger.warn(
        `[visits] 冗余前缀索引暂不删除（安全护栏）：${out.kept
          .map((k) => `${k.name}（${k.reason}）`)
          .join(', ')}`,
      );
    }
    return out;
  }

  /**
   * 把 `{date,pathname}` 的重复行合并成一行：计数取 max、`lastVisitedTime` 取最新、
   * `createdAt` 取最早，然后删掉多余的行。**可以重复执行**（取 max 天然幂等），
   * 多实例同时执行也安全。
   */
  async dedupVisits(opts: { dryRun?: boolean } = {}): Promise<DedupResult> {
    const dryRun = !!opts.dryRun;
    const result: DedupResult = {
      groups: 0,
      dropped: 0,
      dryRun,
      skipped: false,
      details: [],
    };
    const groups = await this.visitModel
      .aggregate([
        { $group: { _id: { date: '$date', pathname: '$pathname' }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $limit: MAX_DUP_GROUPS },
      ])
      .allowDiskUse(true)
      .exec();
    result.groups = groups.length;
    if (!groups.length) {
      return result;
    }
    for (const group of groups) {
      const docs = (await this.visitModel
        .find({ date: group._id?.date, pathname: group._id?.pathname })
        .lean()
        .exec()) as unknown as VisitLike[];
      const merged = mergeVisitGroup(docs);
      if (!merged || merged.dropIds.length === 0) continue;
      result.details.push({
        date: String(group._id?.date),
        pathname: String(group._id?.pathname),
        rows: docs.length,
        kept: merged.keeperId,
        dropped: merged.dropIds,
      });
      this.logger.warn(
        `visits 重复行：date=${group._id?.date} pathname=${group._id?.pathname} 共 ${
          docs.length
        } 行 → 保留 ${String(merged.keeperId)}，合并后 viewer=${merged.patch.viewer} visited=${
          merged.patch.visited
        }，删除 ${merged.dropIds.length} 行${dryRun ? '（dry run）' : ''}`,
      );
      if (dryRun) continue;
      if (merged.changed) {
        await this.visitModel
          .updateOne({ _id: merged.keeperId }, { $set: merged.patch })
          .exec();
      }
      const deleted = await this.visitModel
        .deleteMany({ _id: { $in: merged.dropIds } })
        .exec();
      result.dropped += deleted?.deletedCount || 0;
    }
    return result;
  }

  /**
   * 保证 `{keys}` 上有一个**唯一**索引。已经唯一就什么都不做（只花一次 listIndexes）；
   * 有一个同键的非唯一索引就先删掉再建（Mongo 不允许同一个键模式存在两个索引，
   * 所以只能替换，不能并存）。
   *
   * 删掉之后建失败了会把原来的非唯一索引补回去，绝不让集合处于"没有索引"的状态。
   */
  async ensureUniqueIndex(
    collection: string,
    model: Model<any>,
    keys: Record<string, number>,
    name: string,
    knownIndexes?: any[],
  ): Promise<IndexResult> {
    const out: IndexResult = { collection, name, created: false, replaced: false };
    let droppedName: string | null = null;
    try {
      const indexes = knownIndexes ?? (await model.collection.indexes());
      const sameKey = indexes.find((i: any) => sameKeySpec(i.key, keys));
      if (sameKey && sameKey.unique === true) {
        out.name = sameKey.name;
        return out;
      }
      // 名字被别的键占了（不太可能，但会让 createIndex 报冲突）
      const nameClash = indexes.find((i: any) => i.name === name && !sameKeySpec(i.key, keys));
      if (nameClash) {
        await model.collection.dropIndex(nameClash.name);
      }
      if (sameKey) {
        droppedName = sameKey.name;
        await model.collection.dropIndex(sameKey.name);
        out.replaced = true;
      }
      await model.collection.createIndex(keys, { unique: true, name, background: true });
      out.created = true;
      return out;
    } catch (err) {
      out.error = String((err as Error)?.message || err).slice(0, 300);
      if (droppedName) {
        // 建唯一索引失败（多半是又出现了重复行）：把原来的非唯一索引补回去，别把查询变成全表扫
        try {
          await model.collection.createIndex(keys, { name: droppedName, background: true });
          out.error += '（已恢复原来的非唯一索引）';
        } catch (restoreErr) {
          out.error += `（恢复非唯一索引也失败：${(restoreErr as Error)?.message}）`;
        }
      }
      this.logger.error(`${collection} 建唯一索引 ${name} 失败：${out.error}`);
      return out;
    }
  }

  /**
   * 按保留期删掉老的统计行。默认 `VANBLOG_VISIT_RETENTION_DAYS=0` = **永不删除**，
   * 所以不改环境变量的用户行为一点都不会变（不会偷偷删数据）。
   * 挂在已有的每日 cron 上（`schedule/viewer.task.ts`），不额外开定时器。
   */
  async pruneStats(reason: string, now: Date = new Date()): Promise<PruneResult> {
    const plan: RetentionPlan = planRetention(
      { retentionDays: this.retentionDays, minKeepDays: this.minKeepDays, now },
      RETENTION_DEFAULTS,
    );
    if (!plan.enabled || !plan.filter) {
      return {
        enabled: false,
        effectiveDays: plan.effectiveDays,
        cutoff: null,
        visits: 0,
        viewers: 0,
      };
    }
    const [visitsRes, viewersRes] = await Promise.all([
      this.visitModel.deleteMany(plan.filter as any).exec(),
      this.viewerModel.deleteMany(plan.filter as any).exec(),
    ]);
    const visits = visitsRes?.deletedCount || 0;
    const viewers = viewersRes?.deletedCount || 0;
    this.logger.log(
      `[${reason}] 统计保留期 ${plan.effectiveDays} 天（含今天，删除 ${plan.cutoff} 之前的行）：` +
        `visits 删 ${visits} 行、viewers 删 ${viewers} 行`,
    );
    return {
      enabled: true,
      effectiveDays: plan.effectiveDays,
      cutoff: plan.cutoff,
      visits,
      viewers,
    };
  }
}
