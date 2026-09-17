/**
 * 每次页面浏览的统计增量，先在进程内攒着，再批量落库。
 *
 * 为什么要它：`POST /api/public/viewer` 是全站最热的写路径，一次文章页浏览要横跨
 * metas / articles / viewers / visits 四个集合。实测（mongod `serverStatus().metrics.commands`
 * 差值，扣掉背景噪音，N=6）：**8 次 Mongo 命令、其中 4 次写**——
 * users 1 次 find（InitMiddleware，见 init.middleware）、metas 1 次 findAndModify、
 * articles 2 次 find + 1 次 update、visits 1 次 findAndModify、viewers 1 次 find + 1 次 update。
 * 每一次浏览都独立跑完这 8 次往返，而其中绝大多数在 5 秒内是可以合并的。
 *
 * 合并之后（同样实测量具 `test/opscount.e2e-spec.ts` + 真实 mongod）：
 * 一轮 flush 固定 **4 次命令**（metas 1 + articles 1 + visits 1 + viewers 1），
 * 与这一轮攒了多少次浏览无关；只有"某条路径当天第一次被访问"时多 2 次
 * （查上一天的累计值 + 建当天那行）。
 *
 * ⚠️ 这个文件是**纯逻辑**（不 import mongoose、不碰 process.env 之外的东西），
 * 所有落库动作都由 `provider/stats/viewStats.provider.ts` 拿 `take()` 的结果去做，
 * 于是"怎么攒、攒成什么形状"可以被单测逐条钉住。
 *
 * 语义上必须保持不变的两件事：
 *  1. `visits.viewer/visited` 是**按路径累计**的（每天那一行都从上一天的值接着加），
 *     不是当天计数——所以新的一天必须先拿到上一天的累计值再建行（seed）；
 *  2. `viewers.viewer/visited` 是 metas 累计值的**每日快照**（绝对值，不是增量），
 *     所以它只能在一轮 flush 里、metas 自增拿到权威总数之后再写。
 */

/** 一次浏览带来的增量 */
export interface PathDelta {
  viewer: number;
  visited: number;
}

/** 一次浏览事件（已由调用方归一化：解码过、限过长） */
export interface ViewEvent {
  /** 访问的路径，例如 `/post/hello-world`、`/`、`/about` */
  pathname: string;
  /** 站点级新访客（query 里的 `isNew`）：metas.visited +1 */
  isNewVisitor: boolean;
  /** 对该路径来说是新访客（query 里的 `isNewByPath`）：文章与 visits 的 visited +1 */
  isNewForPath: boolean;
  /** 事件发生时的日期（YYYY-MM-DD，服务器本地时区） */
  date: string;
}

/** 一轮 flush 要落库的全部内容 */
export interface ViewStatsBatch {
  /** 这一轮总共攒了多少次浏览 */
  events: number;
  /** metas 的自增量（与日期无关） */
  site: PathDelta;
  /** 文章自增量，key 是 `/post/` 后面那一段（可能是拼音别名，也可能是数字 id） */
  articles: Map<string, PathDelta>;
  /** 按天分组的 visits/viewers 增量（跨零点的批次会分成两组，各归各的天） */
  days: DayBatch[];
}

export interface DayBatch {
  date: string;
  /** 这一天里 metas 的自增量（各天之和 === batch.site） */
  site: PathDelta;
  /** 这一天里每条路径的自增量 */
  paths: Map<string, PathDelta>;
}

const ARTICLE_MARKER = '/post/';

/**
 * 从访问路径里取出"文章键"：不是文章路径就返回 null。
 *
 * ⚠️ 故意与改动前的 `MetaProvider.addViewer` 逐字一致（`/\/post\//.test(pathname)` +
 * `pathname.replace('/post/', '')`）：`replace` 只替换**第一处**，所以 `/a/post/b` 会得到
 * `/ab` 这种查不到的键（然后什么也不写）。这不是好行为，但改动它等于改动统计语义，
 * 本轮不做——先把开销降下来，别顺手改口径。
 */
export function articleKeyOf(pathname: string): string | null {
  if (typeof pathname !== 'string' || !pathname.includes(ARTICLE_MARKER)) {
    return null;
  }
  return pathname.replace(ARTICLE_MARKER, '');
}

const emptyDelta = (): PathDelta => ({ viewer: 0, visited: 0 });

function bump(target: PathDelta, viewer: number, visited: number): void {
  target.viewer += viewer;
  target.visited += visited;
}

export interface ViewStatsAggregatorOptions {
  /**
   * 写库失败时被 `merge()` 退回的增量，最多保留多少个"键"
   * （各天的路径条目 + 文章条目之和）。`0` = 不限（改动前的行为）。
   *
   * ⚠️ 为什么必须有这个上限：退回时 `events` 记的是 **0**（免得日志里的"多少次浏览"虚高），
   * 而 `pending`（也就是 `VANBLOG_VIEW_FLUSH_MAX_EVENTS` 那个封顶）返回的就是 `events` 累计值 ——
   * 于是在 Mongo 持续写不进去的这段时间里，**没有任何东西给这张表封顶**：
   * 每 5 秒 take() 出去、失败、再 merge() 回来，路径键只增不减。
   * 一个客户端在这段时间里刷 N 个不同路径（`/post/<随机串>` 就够），
   * 就能让常驻进程按 N 条 ×（键字符串 + PathDelta + Map 条目）稳定长内存，
   * 而且**移除路径永远不可达**（只有写成功才会清空）。
   */
  maxRetainedKeys?: number;
  /**
   * **每天最多新建多少个"路径键"**（= 每天最多在 visits 里新建多少行）。
   * `0` = 不限（改动前的行为）。缺省时读环境变量
   * `VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY`（默认 5000，非法值回落默认）。
   *
   * ⚠️ 为什么必须有（第四轮审计 B3）：`maxRetainedKeys` 只封住了**内存**
   * （而且主要针对写库失败那条路）；`POST /api/public/viewer` 的 pathname
   * 是匿名的、只限长 500 字、不校验是不是本站真实路径 ⇒ 每个编造路径
   * 每天在 visits 里永久多一行（实测 ≈157 B/请求；30 次/分钟/IP ≈ 6.8 MB/天/IP，
   * 换源 IP 线性放大）。这个上限封的是**磁盘**：同一天里超过上限之后，
   * **站点级与每日累计照旧一条不丢**（metas 的 $inc、viewers 的每日快照、
   * day.site 都不受影响），只是不再为新的 pathname 建行 —— 与 §7.55 G-2
   * 建立的取舍完全一致：丢的是攻击者编造路径的按天明细，绝不静默
   * （计入 `dropped.pathEntries`/`dropped.newPathEntries`，由 provider 每轮
   * flush 最多打一条 WARN，带增量与累计）。
   *
   * 与 `maxRetainedKeys` 的区别：那个封的是"**此刻**攒着多少键"（take() 清零），
   * 这个封的是"**这一天**总共新建过多少个路径键"（跨 take() 持续记账，
   * 靠一张按日期分组的 seen 表；只保留最近 2 个日期 ⇒ 内存上界 = 2 × cap × 路径长）。
   */
  maxNewPathsPerDay?: number;
}

/** `maxNewPathsPerDay` 的默认值（`VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY` 未设置时） */
export const DEFAULT_VIEW_MAX_NEW_PATHS_PER_DAY = 5000;
/** 环境变量名（导出给测试与排障；语义见 ViewStatsAggregatorOptions.maxNewPathsPerDay） */
export const VIEW_MAX_NEW_PATHS_PER_DAY_ENV = 'VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY';

/**
 * 把"选项值 / 环境变量值"收敛成生效上限：
 * 非法（NaN、负数、Infinity、解析不出、**空串**）一律回落默认 5000；显式 `0` = 不限。
 * ⚠️ 与 §7.55 J-3 同一条纪律：env 里的数字必须有 NaN 兜底，绝不静默退化。
 * 空串按"未设置"处理（`VANBLOG_X=` 是 compose 文件里的常见形状）——
 * 对一个安全护栏来说，空串静默变成 `0=不限` 是 fail-open，方向反了。
 */
export function resolveMaxNewPathsPerDay(raw: unknown): number {
  if (typeof raw === 'string' && raw.trim() === '') {
    return DEFAULT_VIEW_MAX_NEW_PATHS_PER_DAY;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_VIEW_MAX_NEW_PATHS_PER_DAY;
  }
  return Math.floor(n);
}

/** 被上限丢掉的东西（累计值，供调用方打日志/上报；只增不减） */
export interface ViewStatsDropped {
  /** 丢掉了多少条"某天某路径"的增量（两种上限共用：内存上限 + 每日新路径上限） */
  pathEntries: number;
  /** 丢掉了多少条"某篇文章"的增量 */
  articleEntries: number;
  /**
   * `pathEntries` 里有多少条是**每日新路径上限**丢的（诊断用的细分计数；
   * 同时计入 pathEntries，所以 provider 既有的"每轮 flush 最多一条 WARN"
   * 机制不需要改就会响 —— 绝不静默）。
   */
  newPathEntries: number;
}

/**
 * 进程内的浏览增量累加器。
 *
 * `add()` 是同步的、且只碰内存（一次 Map 查找 + 两次加法），所以热路径上
 * 一次浏览的数据库开销是 **0**；`take()` 取走当前批次并清空，交给 flush 去写。
 */
export class ViewStatsAggregator {
  private site = emptyDelta();
  private articles = new Map<string, PathDelta>();
  private days = new Map<string, DayBatch>();
  private dayOrder: string[] = [];
  private count = 0;
  /**
   * `articles.size + Σ day.paths.size` 的增量维护值。
   * ⚠️ 必须在 O(1) 内拿到：`add()` 是每次页面浏览都跑的热路径，
   * 不能为了封顶检查去遍历所有天。`retainedKeys()` 与它的对账由单测钉住。
   */
  private keyCount = 0;
  private readonly maxRetainedKeys: number;
  private readonly maxNewPathsPerDay: number;
  /**
   * 按日期记"这一天已经放行过哪些路径键"。必须**跨 take() 存活**：
   * take() 会清空 days，而同一天的后续 flush 轮次里，已经建过行的 pathname
   * 再来时不该再消耗每日预算（它在库里已经有行了，只是 $inc）。
   * 只保留最近 2 个日期（跨零点的批次会短暂带着昨天），所以内存上界
   * = 2 × maxNewPathsPerDay × 路径字符串长度（默认 2×5000，路径已在入口限长 500 字）。
   */
  private readonly seenPaths = new Map<string, Set<string>>();
  readonly dropped: ViewStatsDropped = { pathEntries: 0, articleEntries: 0, newPathEntries: 0 };

  constructor(options: ViewStatsAggregatorOptions = {}) {
    const raw = Number(options.maxRetainedKeys);
    this.maxRetainedKeys = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
    // 选项没给就读环境变量（生产路径：provider 构造时不传这个选项）；
    // 非法值回落默认 5000，显式 0 = 不限 = 旧行为。
    this.maxNewPathsPerDay = resolveMaxNewPathsPerDay(
      options.maxNewPathsPerDay !== undefined
        ? options.maxNewPathsPerDay
        : process.env[VIEW_MAX_NEW_PATHS_PER_DAY_ENV],
    );
  }

  add(event: ViewEvent): void {
    const viewerInc = 1;
    const visitedInc = event.isNewVisitor ? 1 : 0;
    const pathVisitedInc = event.isNewForPath ? 1 : 0;

    this.count += 1;
    bump(this.site, viewerInc, visitedInc);

    const key = articleKeyOf(event.pathname);
    if (key !== null && key !== '') {
      const article = this.articles.get(key);
      if (article) {
        bump(article, viewerInc, pathVisitedInc);
      } else {
        this.articles.set(key, { viewer: viewerInc, visited: pathVisitedInc });
        this.keyCount += 1;
      }
    }

    let day = this.days.get(event.date);
    if (!day) {
      day = { date: event.date, site: emptyDelta(), paths: new Map<string, PathDelta>() };
      this.days.set(event.date, day);
      this.dayOrder.push(event.date);
    }
    bump(day.site, viewerInc, visitedInc);
    const path = day.paths.get(event.pathname);
    if (path) {
      bump(path, viewerInc, pathVisitedInc);
    } else if (this.admitNewPath(event.date, event.pathname)) {
      day.paths.set(event.pathname, { viewer: viewerInc, visited: pathVisitedInc });
      this.keyCount += 1;
    } else {
      // 当天的"新路径键"预算用完了：站点级与当天累计（上面两行 bump）照旧记，
      // 只是不再为这个 pathname 建行。计数进 dropped ⇒ provider 的 WARN 会响。
      this.dropped.pathEntries += 1;
      this.dropped.newPathEntries += 1;
    }
    // 正常的热路径上也要有界：除了"写库失败退回"，
    // "flush 追不上请求"（Mongo 卡住但没报错）同样会让这张表长大。
    // 上限没到时这里只是一次整数比较。
    this.enforceCap();
  }

  /** 攒了多少次浏览还没落库 */
  get pending(): number {
    return this.count;
  }

  /**
   * 还有没有没落库的东西。
   * ⚠️ 不能只看 `count`：写库失败时增量会被 `merge()` 退回来，
   * 那时 `events` 记 0（免得日志里的"多少次浏览"虚高）但数据还在。
   */
  isEmpty(): boolean {
    return (
      this.count === 0 &&
      this.site.viewer === 0 &&
      this.site.visited === 0 &&
      this.articles.size === 0 &&
      this.days.size === 0
    );
  }

  /** 还没落库的 metas 自增量（用来把"库里的值 + 待写入的值"投影成当前真值） */
  pendingSite(): PathDelta {
    return { viewer: this.site.viewer, visited: this.site.visited };
  }

  /** 取走当前批次并清空自己；没有内容时返回 `events: 0` 的空批次 */
  take(): ViewStatsBatch {
    const batch: ViewStatsBatch = {
      events: this.count,
      site: { viewer: this.site.viewer, visited: this.site.visited },
      articles: this.articles,
      days: this.orderedDays(),
    };
    this.site = emptyDelta();
    this.articles = new Map<string, PathDelta>();
    this.days = new Map<string, DayBatch>();
    this.dayOrder = [];
    this.count = 0;
    this.keyCount = 0;
    return batch;
  }

  /**
   * 把一个批次（或它的一部分）退回累加器——写库失败时用，计数不能就这么丢掉。
   * 只退回失败的那一部分，否则成功的部分会被重复写一遍。
   * ⚠️ 退回的路径条目**不消耗**"每日新路径"预算（它们此前都已放行/登记过，
   * 见 admitNewPath 上的说明）；内存上限（enforceCap）照旧生效。
   */
  merge(batch: ViewStatsBatch): void {
    this.count += batch.events;
    bump(this.site, batch.site.viewer, batch.site.visited);
    for (const [key, delta] of batch.articles) {
      const current = this.articles.get(key);
      if (current) {
        bump(current, delta.viewer, delta.visited);
      } else {
        this.articles.set(key, { viewer: delta.viewer, visited: delta.visited });
        this.keyCount += 1;
      }
    }
    for (const day of batch.days || []) {
      let target = this.days.get(day.date);
      if (!target) {
        target = { date: day.date, site: emptyDelta(), paths: new Map<string, PathDelta>() };
        this.days.set(day.date, target);
        this.dayOrder.push(day.date);
      }
      bump(target.site, day.site.viewer, day.site.visited);
      for (const [pathname, delta] of day.paths) {
        const current = target.paths.get(pathname);
        if (current) {
          bump(current, delta.viewer, delta.visited);
        } else {
          target.paths.set(pathname, { viewer: delta.viewer, visited: delta.visited });
          this.keyCount += 1;
        }
      }
    }
    // 退回是这张表唯一"可能一次长大很多"的入口（一批最多 maxPending 条），必须封顶
    this.enforceCap();
  }

  /** 当前保留了多少个"路径/文章"键（O(1)；与真实条数的对账由单测钉住） */
  retainedKeys(): number {
    return this.keyCount;
  }

  /** 真实条数（遍历用，只给测试与诊断用，别放进热路径） */
  countRetainedKeys(): number {
    let n = this.articles.size;
    for (const day of this.days.values()) {
      n += day.paths.size;
    }
    return n;
  }

  /**
   * 这一天还能不能为 `pathname` **新建**一个路径键（= 在 visits 里新建一行）。
   *
   * 判定与记账（都是 O(1) 摊还，add() 是热路径）：
   *  - 上限 ≤ 0（不限）⇒ 永远放行，不碰 seen 表（旧行为零开销）；
   *  - 这一天的 seen 表里已经有它 ⇒ 放行且**不消耗预算**：库里的行早在
   *    之前的 flush 轮次建好了（或本轮已放行过），现在只是继续 $inc；
   *  - 预算没用完 ⇒ 登记进 seen 并放行；
   *  - 预算用完 ⇒ 拒绝（调用方把增量记进 dropped，站点级/每日累计不受影响）。
   *
   * ⚠️ seen 表跨 take() 存活（否则每 5 秒一轮 flush 会把预算重新装满，
   * 上限就名存实亡了）；只保留最近 2 个日期，见 seenPaths 字段上的说明。
   * ⚠️ `merge()` 退回的条目**不经过**这里：它们都是此前已放行/已登记的路径，
   * 再拦一道会把"已经收下的计数"静默丢掉（那正是本仓库最忌讳的失败形状）。
   */
  private admitNewPath(date: string, pathname: string): boolean {
    if (this.maxNewPathsPerDay <= 0) {
      return true;
    }
    const seen = this.seenPathsFor(date);
    if (seen.has(pathname)) {
      return true;
    }
    if (seen.size >= this.maxNewPathsPerDay) {
      return false;
    }
    seen.add(pathname);
    return true;
  }

  /** 取（或建）某一天的 seen 表；顺手把只保留最近 2 个日期的约定维护住 */
  private seenPathsFor(date: string): Set<string> {
    let seen = this.seenPaths.get(date);
    if (!seen) {
      seen = new Set<string>();
      this.seenPaths.set(date, seen);
      if (this.seenPaths.size > 2) {
        // ISO 日期字符串按字典序就是按时间序；留下最近的 2 个。
        // （时钟回拨送来更老的日期时，老日期自己会被立刻淘汰，
        //  那次事件按"不限"处理 —— 退化是安全的，内存仍然有界。）
        const dates = Array.from(this.seenPaths.keys()).sort();
        for (let i = 0; i < dates.length - 2; i += 1) {
          this.seenPaths.delete(dates[i]);
        }
      }
    }
    return seen;
  }

  /**
   * 超过上限时丢掉一部分增量，把内存封住。
   *
   * 丢什么、留什么（都是"尽量不丢事实"的取舍）：
   *  - **站点级累计值一条不丢**（`site` 只有两个数字，而它决定 metas 的 `$inc`
   *    与每日快照的绝对值 —— 后台首页那个总访问量必须继续是对的）；
   *  - **每天的 `day.site` 一条不丢**：`DayBatch` 的不变量是"各天 site 之和 === batch.site"，
   *    跨零点时靠它算每天的快照，丢了会让趋势图出现假的跳变，所以宁可留着一个
   *    "路径表为空的那一天"（几乎不占内存，`flushVisits` 对空表直接返回 0）；
   *  - 先丢**最老那天**的路径条目，再丢文章条目（文章的 viewer 是累计值，
   *    少一次自增只是那篇文章的阅读量偏低，不会像趋势图那样出现跳变）。
   *
   * 丢了多少记在 `dropped` 里，由 provider 打一条 WARN —— **绝不静默丢**，
   * 否则"统计数字比实际低"这件事永远查不出来（这一类静默失败本仓库踩过很多次）。
   */
  private enforceCap(): void {
    if (this.maxRetainedKeys <= 0) {
      return;
    }
    let over = this.keyCount - this.maxRetainedKeys;
    if (over <= 0) {
      return;
    }
    // ⚠️ 全程用 Map 的**惰性迭代器**，不要 `Array.from(keys())`：
    // 这个函数在每次 add() 之后都会跑，而稳态下 `over` 通常只有 1 ——
    // 物化一份两万个键的数组再删一条，实测把 40 万次 add 从 0.9 秒拖到 138 秒。
    // （Map 允许在迭代中 delete：被删的条目不会再被访问，其余条目照常迭代。）
    // 单天时（绝大多数情况）不必物化 + 排序：这也是"超过上限之后每次 add 都要淘汰"的
    // 热路径，第一版每次都 `Array.from(keys()).sort()`，实测 40 万次 add 从 0.94s 变成 138s
    // （配合惰性迭代器之后降到 16.7s，加上这条快速路径才回到与不设上限同一量级）
    const dates =
      this.days.size === 1 ? [this.dayOrder[this.dayOrder.length - 1]] : Array.from(this.days.keys()).sort();
    for (const date of dates) {
      if (over <= 0) break;
      const day = this.days.get(date);
      if (!day) continue;
      for (const pathname of day.paths.keys()) {
        if (over <= 0) break;
        day.paths.delete(pathname);
        this.keyCount -= 1;
        this.dropped.pathEntries += 1;
        over -= 1;
      }
    }
    if (over > 0) {
      for (const key of this.articles.keys()) {
        if (over <= 0) break;
        this.articles.delete(key);
        this.keyCount -= 1;
        this.dropped.articleEntries += 1;
        over -= 1;
      }
    }
  }

  /** 按日期升序：跨零点退回的批次可能比已有的更早，落库时要靠这个顺序算每日快照 */
  private orderedDays(): DayBatch[] {
    return [...this.dayOrder]
      .sort()
      .map((d) => this.days.get(d))
      .filter(Boolean) as DayBatch[];
  }
}
