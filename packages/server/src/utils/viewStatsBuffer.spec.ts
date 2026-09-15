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
