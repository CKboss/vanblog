import dayjs from 'dayjs';

/**
 * `visits` / `viewers` 这两张统计表的维护逻辑：**去重合并**与**保留期清理**。
 *
 * 这一份是纯函数（不碰 Mongo、不读 process.env），所以边界都能被单测钉住；
 * 真正落库的部分在 `provider/stats/statsMaintenance.provider.ts`。
 */

/** visits 的一行（只列出合并关心的字段） */
export interface VisitLike {
  _id: any;
  date?: string;
  pathname?: string;
  viewer?: number;
  visited?: number;
  lastVisitedTime?: Date | string | null;
  createdAt?: Date | string | null;
}

export interface MergedVisit {
  /** 保留哪一行（把合并后的值写回它） */
  keeperId: any;
  /** 删掉哪些行 */
  dropIds: any[];
  /** 合并后要写到 keeper 上的字段 */
  patch: {
    viewer: number;
    visited: number;
    lastVisitedTime: Date | string | null;
    createdAt: Date | string | null;
  };
  /** 合并后的值与 keeper 原值有没有差别（没差别就不必发那次 updateOne） */
  changed: boolean;
}

const toTime = (value: Date | string | null | undefined): number => {
  if (!value) return 0;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
};

const toNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 把同一个 `{date, pathname}` 下的多行合并成一行。
 *
 * ⚠️ **计数取 max，不是求和**。`visits.viewer/visited` 存的是「这条路径到目前为止的
 * **累计值**」，不是当天增量 —— 证据在 `visit.provider.add()`：当天没有行时，
 * 它先 `getLastData(pathname)` 取最近一天的行，再用 `lastViewer + 1` 建新行。
 * 线上实测也印证了这一点：`/post/1` 当天那行是 viewer=295，
 * 而文章自己的累计阅读量是 289（如果按天计数，这里应该是 1~5）。
 *
 * 重复行是并发首访产生的：两行几乎是同一毫秒建出来的（实测 `2026-02-28T01:12:06.529Z`
 * 与 `.538Z`），之后 `findOneAndUpdate({date,pathname})` 只命中其中一行，
 * 所以**两行各自拿到了一部分自增**，真正接近事实的是较大的那个值。
 * 本机的两对重复行是 2270/2266 与 624/623 —— 求和会得到 4536 和 1247，
 * 等于凭空把这条路径的阅读量翻倍，所以这里**必须取 max**。
 *
 * 取 max 还带来一个好性质：合并是**幂等**的（`max(max(a,b),b) === max(a,b)`），
 * 于是"启动时跑一遍"可以随便重跑、多实例同时跑也不会把计数弄坏。
 */
export function mergeVisitGroup(docs: VisitLike[]): MergedVisit | null {
  if (!Array.isArray(docs) || docs.length === 0) return null;
  const rows = [...docs];
  // keeper：lastVisitedTime 最新的那一行；并列时取 createdAt 更新的，再并列取 _id 字典序更大的，
  // 保证多个进程独立跑也会选中同一行（幂等的前提）
  rows.sort((a, b) => {
    const byLast = toTime(b.lastVisitedTime) - toTime(a.lastVisitedTime);
    if (byLast !== 0) return byLast;
    const byCreated = toTime(b.createdAt) - toTime(a.createdAt);
    if (byCreated !== 0) return byCreated;
    return String(b._id).localeCompare(String(a._id));
  });
  const keeper = rows[0];
  const dropIds = rows.slice(1).map((r) => r._id);

  const viewer = rows.reduce((acc, r) => Math.max(acc, toNumber(r.viewer)), 0);
  const visited = rows.reduce((acc, r) => Math.max(acc, toNumber(r.visited)), 0);
  const lastVisitedTime = rows.reduce<Date | string | null>((acc, r) => {
    if (!r.lastVisitedTime) return acc;
    if (!acc) return r.lastVisitedTime;
    return toTime(r.lastVisitedTime) > toTime(acc) ? r.lastVisitedTime : acc;
  }, null);
  const createdAt = rows.reduce<Date | string | null>((acc, r) => {
    if (!r.createdAt) return acc;
    if (!acc) return r.createdAt;
    return toTime(r.createdAt) < toTime(acc) ? r.createdAt : acc;
  }, null);

  const changed =
    toNumber(keeper.viewer) !== viewer ||
    toNumber(keeper.visited) !== visited ||
    toTime(keeper.lastVisitedTime) !== toTime(lastVisitedTime) ||
    toTime(keeper.createdAt) !== toTime(createdAt);

  return {
    keeperId: keeper._id,
    dropIds,
    patch: { viewer, visited, lastVisitedTime, createdAt },
    changed,
  };
}

export interface RetentionInput {
  /** `VANBLOG_VISIT_RETENTION_DAYS`：0（默认）= 永不删除 */
  retentionDays: number;
  /** `VANBLOG_VISIT_RETENTION_MIN_KEEP_DAYS`：无论如何都保留最近这么多天 */
  minKeepDays: number;
  /** 当前时间（注入进来才好测边界） */
  now?: Date;
}

export interface RetentionPlan {
  /** false 表示"不清理"（默认行为，不会偷偷删用户数据） */
  enabled: boolean;
  /** 实际生效的保留天数（取 retentionDays 与 minKeepDays 的较大值） */
  effectiveDays: number;
  /**
   * 删除条件：`date < cutoff`（字符串比较，YYYY-MM-DD 天然可比）。
   * 保留的天数**含今天**，所以 effectiveDays=90 时 cutoff = 今天 - 89 天。
   * 配合 `$gte: '0000-00-00'` 使用，可以把 date 缺失/为 null 的行排除在删除之外
   * （BSON 里 null 排在字符串前面，只写 `$lt` 会把它们一起删掉）。
   */
  cutoff: string | null;
  /** 交给 Mongo 的过滤条件 */
  filter: Record<string, unknown> | null;
}

export const RETENTION_FLOOR = '0000-00-00';

/**
 * 算出"该删哪些天"。
 *
 * 三条硬规则：
 *  1. `retentionDays <= 0`（默认）→ **完全不清理**，行为与改动前一致；
 *  2. 生效天数取 `max(retentionDays, minKeepDays)`，所以哪怕把保留期设成 1 天，
 *     最近 `minKeepDays` 天也一定还在（后台的访问趋势图不会突然只剩一天）；
 *  3. 非法值（NaN / 负数 / 小数）一律回落默认，绝不把 NaN 交给 Mongo。
 */
export function planRetention(
  input: RetentionInput,
  defaults: { retentionDays: number; minKeepDays: number },
): RetentionPlan {
  const now = input.now ? dayjs(input.now) : dayjs();
  const sanitize = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  const retentionDays = sanitize(input.retentionDays, defaults.retentionDays);
  const minKeepDays = Math.max(1, sanitize(input.minKeepDays, defaults.minKeepDays));

  if (retentionDays <= 0) {
    return { enabled: false, effectiveDays: retentionDays, cutoff: null, filter: null };
  }
  const effectiveDays = Math.max(retentionDays, minKeepDays);
  const cutoff = now.subtract(effectiveDays - 1, 'day').format('YYYY-MM-DD');
  return {
    enabled: true,
    effectiveDays,
    cutoff,
    filter: { date: { $gte: RETENTION_FLOOR, $lt: cutoff } },
  };
}
