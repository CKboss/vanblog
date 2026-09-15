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

  add(event: ViewEvent): void {
    const viewerInc = 1;
    const visitedInc = event.isNewVisitor ? 1 : 0;
    const pathVisitedInc = event.isNewForPath ? 1 : 0;

    this.count += 1;
    bump(this.site, viewerInc, visitedInc);

    const key = articleKeyOf(event.pathname);
    if (key !== null && key !== '') {
      const article = this.articles.get(key) || emptyDelta();
      bump(article, viewerInc, pathVisitedInc);
      this.articles.set(key, article);
    }

    let day = this.days.get(event.date);
    if (!day) {
      day = { date: event.date, site: emptyDelta(), paths: new Map<string, PathDelta>() };
      this.days.set(event.date, day);
      this.dayOrder.push(event.date);
    }
    bump(day.site, viewerInc, visitedInc);
    const path = day.paths.get(event.pathname) || emptyDelta();
    bump(path, viewerInc, pathVisitedInc);
    day.paths.set(event.pathname, path);
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
    return batch;
  }

  /**
   * 把一个批次（或它的一部分）退回累加器——写库失败时用，计数不能就这么丢掉。
   * 只退回失败的那一部分，否则成功的部分会被重复写一遍。
   */
  merge(batch: ViewStatsBatch): void {
    this.count += batch.events;
    bump(this.site, batch.site.viewer, batch.site.visited);
    for (const [key, delta] of batch.articles) {
      const current = this.articles.get(key) || emptyDelta();
      bump(current, delta.viewer, delta.visited);
      this.articles.set(key, current);
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
        const current = target.paths.get(pathname) || emptyDelta();
        bump(current, delta.viewer, delta.visited);
        target.paths.set(pathname, current);
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
