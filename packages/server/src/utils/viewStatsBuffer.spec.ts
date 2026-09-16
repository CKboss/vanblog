import {
  articleKeyOf,
  ViewStatsAggregator,
  ViewStatsBatch,
} from './viewStatsBuffer';

/**
 * 浏览统计的进程内累加器（`utils/viewStatsBuffer.ts`）。
 *
 * 这里钉住的是「攒」的语义：一次浏览该给哪些计数器加多少、同一条路径的多次浏览
 * 必须合并成一次 `$inc`、跨零点的批次必须按天分开、写库失败退回来的增量不能丢也不能翻倍。
 * 落库那一半（真实 Mongo 命令数）在 `provider/stats/viewStats.provider.spec.ts` 里钉。
 */

const ev = (
  pathname: string,
  opts: { isNewVisitor?: boolean; isNewForPath?: boolean; date?: string } = {},
) => ({
  pathname,
  isNewVisitor: !!opts.isNewVisitor,
  isNewForPath: !!opts.isNewForPath,
  date: opts.date || '2026-09-16',
});

describe('articleKeyOf：哪些路径算文章', () => {
  it('文章路径取出 /post/ 后面那一段', () => {
    expect(articleKeyOf('/post/hello-world')).toBe('hello-world');
    expect(articleKeyOf('/post/12')).toBe('12');
  });

  it('非文章路径返回 null', () => {
    expect(articleKeyOf('/')).toBeNull();
    expect(articleKeyOf('/about')).toBeNull();
    expect(articleKeyOf('/tag/node')).toBeNull();
  });

  it('与改动前的实现逐字一致（/post/ 不在开头时也会被替换掉第一处）', () => {
    // 改动前是 `pathname.replace('/post/', '')`，只替换第一处、且不要求在开头。
    // 这个行为不好，但改它等于改统计口径，所以这里把它**钉住**而不是"修好"。
    expect(articleKeyOf('/a/post/b')).toBe('/ab');
    expect(articleKeyOf('/post/')).toBe('');
  });
});

describe('ViewStatsAggregator：累加语义', () => {
  it('一次浏览 = metas.viewer +1，非新访客不动 visited', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello'));
    const batch = a.take();
    expect(batch.events).toBe(1);
    expect(batch.site).toEqual({ viewer: 1, visited: 0 });
  });

  it('isNew 才让站点级 visited +1；isNewByPath 才让文章与路径的 visited +1', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello', { isNewVisitor: true, isNewForPath: true }));
    const batch = a.take();
    expect(batch.site).toEqual({ viewer: 1, visited: 1 });
    expect(batch.articles.get('hello')).toEqual({ viewer: 1, visited: 1 });
    expect(batch.days[0].paths.get('/post/hello')).toEqual({ viewer: 1, visited: 1 });
  });

  it('isNewByPath 为 false 时文章只加 viewer（老访客重看同一篇）', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello', { isNewVisitor: true, isNewForPath: false }));
    const batch = a.take();
    // 站点级 visited 由 isNew 决定，文章级由 isNewByPath 决定，两者互不相干
    expect(batch.site).toEqual({ viewer: 1, visited: 1 });
    expect(batch.articles.get('hello')).toEqual({ viewer: 1, visited: 0 });
    expect(batch.days[0].paths.get('/post/hello')).toEqual({ viewer: 1, visited: 0 });
  });

  it('同一条路径的多次浏览合并成一条增量（这就是"少写库"的来源）', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello'));
    a.add(ev('/post/hello'));
    a.add(ev('/post/hello', { isNewForPath: true }));
    a.add(ev('/'));
    const batch = a.take();
    expect(batch.events).toBe(4);
    expect(batch.site).toEqual({ viewer: 4, visited: 0 });
    expect(batch.articles.size).toBe(1);
    expect(batch.articles.get('hello')).toEqual({ viewer: 3, visited: 1 });
    expect(batch.days[0].paths.size).toBe(2);
    expect(batch.days[0].paths.get('/post/hello')).toEqual({ viewer: 3, visited: 1 });
    expect(batch.days[0].paths.get('/')).toEqual({ viewer: 1, visited: 0 });
  });

  it('非文章路径不进 articles（首页不该去动文章集合）', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/'));
    a.add(ev('/about'));
    expect(a.take().articles.size).toBe(0);
  });

  it('take() 之后累加器是空的', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello'));
    a.take();
    expect(a.isEmpty()).toBe(true);
    expect(a.pending).toBe(0);
    expect(a.pendingSite()).toEqual({ viewer: 0, visited: 0 });
    expect(a.take().events).toBe(0);
  });

  it('pendingSite() 暴露还没落库的自增量（接口靠它投影当前真值）', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello', { isNewVisitor: true }));
    a.add(ev('/post/hello'));
    expect(a.pendingSite()).toEqual({ viewer: 2, visited: 1 });
    // pendingSite 不能把数据吃掉
    expect(a.pending).toBe(2);
  });

  it('跨零点的浏览按天分开，days 按日期升序（每日快照要靠这个顺序算）', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello', { date: '2026-09-17' }));
    a.add(ev('/post/hello', { date: '2026-09-16' }));
    const batch = a.take();
    expect(batch.days.map((d) => d.date)).toEqual(['2026-09-16', '2026-09-17']);
    expect(batch.days[0].site).toEqual({ viewer: 1, visited: 0 });
    expect(batch.days[1].site).toEqual({ viewer: 1, visited: 0 });
    // 各天的自增之和 === 站点总自增
    const sum = batch.days.reduce((acc, d) => acc + d.site.viewer, 0);
    expect(sum).toBe(batch.site.viewer);
  });
});

describe('ViewStatsAggregator.merge：写库失败时退回增量', () => {
  const batchOf = (a: ViewStatsAggregator): ViewStatsBatch => a.take();

  it('退回的增量与原来完全相同，不会翻倍也不会丢', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello', { isNewVisitor: true, isNewForPath: true }));
    a.add(ev('/post/hello'));
    const batch = batchOf(a);
    expect(a.isEmpty()).toBe(true);

    a.merge(batch);
    const again = batchOf(a);
    expect(again.site).toEqual({ viewer: 2, visited: 1 });
    expect(again.articles.get('hello')).toEqual({ viewer: 2, visited: 1 });
    expect(again.days[0].paths.get('/post/hello')).toEqual({ viewer: 2, visited: 1 });
  });

  it('可以只退回一部分（metas 写成功了就不该再写一遍）', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello'));
    const batch = batchOf(a);
    // metas 那一份已经写成功了，所以只退回文章与按天的那两份
    a.merge({ ...batch, events: 0, site: { viewer: 0, visited: 0 } });
    const again = batchOf(a);
    expect(again.site).toEqual({ viewer: 0, visited: 0 });
    expect(again.articles.get('hello')).toEqual({ viewer: 1, visited: 0 });
    expect(again.days[0].paths.get('/post/hello')).toEqual({ viewer: 1, visited: 0 });
  });

  it('退回时 events 记 0，但 isEmpty() 必须为 false（否则这批数据永远不会被写）', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello'));
    const batch = batchOf(a);
    a.merge({ ...batch, events: 0 });
    expect(a.pending).toBe(0);
    expect(a.isEmpty()).toBe(false);
  });

  it('退回的批次与新攒的增量合并，天数按日期排序', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello', { date: '2026-09-16' }));
    const old = batchOf(a);
    a.add(ev('/post/hello', { date: '2026-09-17' }));
    a.merge(old);
    const merged = batchOf(a);
    expect(merged.days.map((d) => d.date)).toEqual(['2026-09-16', '2026-09-17']);
    expect(merged.days[0].paths.get('/post/hello')).toEqual({ viewer: 1, visited: 0 });
    expect(merged.site).toEqual({ viewer: 2, visited: 0 });
  });

  it('同一天的退回会并进已有的那一天，而不是多出一天', () => {
    const a = new ViewStatsAggregator();
    a.add(ev('/post/hello'));
    const first = batchOf(a);
    a.add(ev('/post/hello'));
    a.merge(first);
    const merged = batchOf(a);
    expect(merged.days).toHaveLength(1);
    expect(merged.days[0].paths.get('/post/hello')).toEqual({ viewer: 2, visited: 0 });
  });
});

describe('ViewStatsAggregator：内存上限（写库一直失败时也不能无限长）', () => {
  /**
   * 这条为什么必须有：写库失败时增量会被 `merge()` 退回，而退回时 `events` 记 0，
   * 于是 `VANBLOG_VIEW_FLUSH_MAX_EVENTS`（靠 `pending` 判断）在失败期间**完全不生效** ——
   * Mongo 挂着的这段时间里，每 5 秒 take()→失败→merge() 回来，路径键只增不减，
   * 而唯一的清除路径（写成功）永远走不到。一个客户端在这段时间里刷 N 个不同路径
   * （`POST /api/public/viewer?pathname=/post/<随机串>` 就够，匿名可达），
   * 就能让常驻进程稳定长内存。
   */
  // 用非文章路径：一次 add 只产生一个 day.paths 键，数字才好算
  // （文章路径会同时产生 articles 键，那种"两种键共用预算"的情况由最后一条用例覆盖）
  const manyPaths = (a: ViewStatsAggregator, n: number, date = '2026-09-16') => {
    for (let i = 0; i < n; i += 1) {
      a.add(ev(`/flood-${i}`, { date }));
    }
  };

  it('默认不限（与改动前一致）：不设 maxRetainedKeys 时 30000 条路径全都留着', () => {
    const a = new ViewStatsAggregator();
    manyPaths(a, 30000);
    expect(a.retainedKeys()).toBe(30000);
    expect(a.countRetainedKeys()).toBe(30000);
    expect(a.dropped.pathEntries).toBe(0);
  });

  it('设了上限就封住：热路径上 add() 也不会让表长过上限', () => {
    const a = new ViewStatsAggregator({ maxRetainedKeys: 100 });
    manyPaths(a, 30000);
    expect(a.retainedKeys()).toBeLessThanOrEqual(100);
    expect(a.countRetainedKeys()).toBeLessThanOrEqual(100);
    // 30000 个路径键只有 100 个能留下
    expect(a.dropped.pathEntries + a.dropped.articleEntries).toBeGreaterThan(29000);
  });

  it('站点级累计值一条都不丢：被丢的只是"按路径"的那部分', () => {
    const a = new ViewStatsAggregator({ maxRetainedKeys: 50 });
    manyPaths(a, 5000);
    // metas 的 $inc 靠 site：5000 次浏览就是 5000，丢路径不能影响它
    expect(a.pendingSite()).toEqual({ viewer: 5000, visited: 0 });
    const batch = a.take();
    expect(batch.site).toEqual({ viewer: 5000, visited: 0 });
    // DayBatch 的不变量：各天 site 之和 === batch.site（跨零点算每日快照要靠它）
    const sum = batch.days.reduce((acc, d) => acc + d.site.viewer, 0);
    expect(sum).toBe(batch.site.viewer);
  });

  it('丢的是最老那天的路径，新的一天保住（趋势图的最近一段不能先没）', () => {
    const a = new ViewStatsAggregator({ maxRetainedKeys: 100 });
    // 用非文章路径：一次 add 只产生一个 day.paths 键，淘汰顺序才可预期
    // （文章路径会同时产生 articles 键，两种键共用同一个预算）
    for (let i = 0; i < 100; i += 1) {
      a.add(ev(`/old-${i}`, { date: '2026-09-15' }));
    }
    for (let i = 0; i < 100; i += 1) {
      a.add(ev(`/new-${i}`, { date: '2026-09-16' }));
    }
    expect(a.retainedKeys()).toBe(100);
    const batch = a.take();
    const oldDay = batch.days.find((d) => d.date === '2026-09-15');
    const newDay = batch.days.find((d) => d.date === '2026-09-16');
    expect(newDay?.paths.size).toBe(100);
    expect(oldDay?.paths.size).toBe(0);
    // 那一天的 site 仍然在（见上一条的不变量：各天 site 之和 === batch.site）
    expect(oldDay?.site.viewer).toBe(100);
    expect(batch.days.reduce((acc, d) => acc + d.site.viewer, 0)).toBe(batch.site.viewer);
  });

  it('merge() 退回时同样受上限约束（这才是那个洞：失败期间 pending 一直是 0）', () => {
    const a = new ViewStatsAggregator({ maxRetainedKeys: 100 });
    manyPaths(a, 5000);
    const batch = a.take();
    expect(a.isEmpty()).toBe(true);
    // 模拟"写库失败"：provider 就是这样把整批退回来的（events 记 0）
    a.merge({ ...batch, events: 0 });
    expect(a.pending).toBe(0);
    expect(a.isEmpty()).toBe(false);
    expect(a.retainedKeys()).toBeLessThanOrEqual(100);
    expect(a.countRetainedKeys()).toBeLessThanOrEqual(100);
    // 站点累计值仍然完好
    expect(a.pendingSite()).toEqual({ viewer: 5000, visited: 0 });
  });

  it('反复"退回 → 再攒"也不会累积（连续 20 轮失败后仍然在上限内）', () => {
    const a = new ViewStatsAggregator({ maxRetainedKeys: 200 });
    for (let round = 0; round < 20; round += 1) {
      manyPaths(a, 1000);
      const batch = a.take();
      a.merge({ ...batch, events: 0 });
      expect(a.retainedKeys()).toBeLessThanOrEqual(200);
    }
    expect(a.countRetainedKeys()).toBe(a.retainedKeys());
    expect(a.pendingSite().viewer).toBe(20000);
  });

  it('文章键与路径键共用同一个预算，且 O(1) 计数器不会漂移', () => {
    const a = new ViewStatsAggregator({ maxRetainedKeys: 10 });
    for (let i = 0; i < 100; i += 1) {
      a.add(ev(`/post/a-${i}`));
      a.add(ev(`/not-an-article-${i}`)); // 只进 days.paths，不进 articles
    }
    expect(a.retainedKeys()).toBeLessThanOrEqual(10);
    expect(a.countRetainedKeys()).toBe(a.retainedKeys());
    const batch = a.take();
    expect(batch.articles.size + batch.days[0].paths.size).toBeLessThanOrEqual(10);
    expect(a.retainedKeys()).toBe(0);
    expect(a.countRetainedKeys()).toBe(0);
  });

  it('非法的上限值（NaN / 负数）当作"不限"，不会把统计全丢光', () => {
    for (const bad of [NaN, -5, Infinity]) {
      const a = new ViewStatsAggregator({ maxRetainedKeys: bad as number });
      manyPaths(a, 500);
      expect(a.retainedKeys()).toBe(500);
      expect(a.dropped.pathEntries).toBe(0);
    }
  });
});
