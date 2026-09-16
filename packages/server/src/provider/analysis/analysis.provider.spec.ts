import { AnalysisProvider } from './analysis.provider';

/**
 * 后台仪表盘（/api/admin/analysis）三个 tab 的数据聚合。
 *
 * 这一轮把每个 tab 里"互不依赖的串行 await"改成了 Promise.all（与 §7.44 给
 * /api/public/meta 做的是同一件事）。这里钉住两件事：
 *  1. **响应逐字节不变**：JSON.stringify 的键顺序与值和串行版完全一致
 *     （后台图表代码对字段很挑剔）；
 *  2. **读真的并行了**：每个依赖都人为延迟几毫秒，重叠度（同时在飞的读数量）
 *     必须达到该 tab 的读数量 —— 串行实现的重叠度永远是 1。
 */

interface Tracker {
  active: number;
  max: number;
}

function delayed<T>(tracker: Tracker, value: T, ms = 6): () => Promise<T> {
  return async () => {
    tracker.active += 1;
    tracker.max = Math.max(tracker.max, tracker.active);
    await new Promise((r) => setTimeout(r, ms));
    tracker.active -= 1;
    return value;
  };
}

function createDeps(overrides: {
  lastVisitItem?: any;
  topViewer?: any[];
  topVisited?: any[];
  tags?: any[];
  categories?: any[];
} = {}) {
  const tracker: Tracker = { active: 0, max: 0 };
  const siteInfo = {
    baseUrl: 'https://example.com/',
    enableComment: 'true',
    gaAnalysisId: 'GA-TEST',
    baiduAnalysisId: '',
  };
  const grid = {
    grid: {
      total: [{ date: '2026-09-15', visited: 10, viewer: 5 }],
      each: [{ date: '2026-09-16', visited: 2, viewer: 1 }],
    },
    add: { viewer: 1, visited: 2 },
    now: { viewer: 6, visited: 12 },
  };
  const metaProvider: any = {
    getTotalWords: delayed(tracker, 41508),
    getSiteInfo: delayed(tracker, siteInfo),
    getViewer: delayed(tracker, { viewer: 999, visited: 8888 }),
  };
  const articleProvider: any = {
    getTotalNum: delayed(tracker, 53),
    getTopViewer: delayed(tracker, overrides.topViewer ?? [{ id: 1, viewer: 300 }]),
    getTopVisited: delayed(tracker, overrides.topVisited ?? [{ id: 2, visited: 250 }]),
    getRecentVisitedArticles: delayed(tracker, [{ id: 3, lastVisitedTime: 'T3' }]),
  };
  const viewProvider: any = { getViewerGrid: delayed(tracker, grid) };
  const visitProvider: any = {
    getLastVisitItem: delayed(
      tracker,
      overrides.lastVisitItem !== undefined
        ? overrides.lastVisitItem
        : { lastVisitedTime: 'TVISIT', pathname: '/post/7' },
    ),
  };
  const tagProvider: any = {
    getAllTags: delayed(
      tracker,
      overrides.tags !== undefined ? overrides.tags : [{ name: 'a' }, { name: 'b' }],
    ),
    getColumnData: delayed(tracker, [{ tag: 'a', count: 2 }]),
  };
  const categoryProvider: any = {
    getAllCategories: delayed(
      tracker,
      overrides.categories !== undefined ? overrides.categories : [{ name: 'c' }],
    ),
    getPieData: delayed(tracker, [{ name: 'c', value: 53 }]),
  };
  const provider = new AnalysisProvider(
    metaProvider,
    articleProvider,
    viewProvider,
    visitProvider,
    tagProvider,
    categoryProvider,
  );
  return { provider, tracker, grid, siteInfo };
}

describe('AnalysisProvider：三个 tab 并行聚合，响应形状不变', () => {
  it('overview：键顺序与值和串行版逐字节一致，4 个读全部并行', async () => {
    const { provider, tracker, grid, siteInfo } = createDeps();
    const data = await provider.getOverViewTabData(5);
    const expected = {
      total: { wordCount: 41508, articleNum: 53 },
      viewer: grid,
      link: { baseUrl: siteInfo.baseUrl, enableComment: 'true' },
    };
    expect(JSON.stringify(data)).toBe(JSON.stringify(expected));
    expect(tracker.max).toBeGreaterThanOrEqual(4);
  });

  it('overview：enableComment 缺失时回落字符串 "true"（旧语义）', async () => {
    const { provider } = createDeps();
    (provider as any).metaProvider.getSiteInfo = async () => ({ baseUrl: 'https://x/' });
    const data: any = await provider.getOverViewTabData(5);
    expect(data.link).toEqual({ baseUrl: 'https://x/', enableComment: 'true' });
  });

  it('viewer：12 个字段一个不多一个不少，顺序一致，6 个读全部并行', async () => {
    const { provider, tracker } = createDeps();
    const data = await provider.getViewerTabData(7);
    const expected = {
      enableGA: true,
      enableBaidu: false,
      topViewer: [{ id: 1, viewer: 300 }],
      topVisited: [{ id: 2, visited: 250 }],
      recentVisitArticles: [{ id: 3, lastVisitedTime: 'T3' }],
      siteLastVisitedTime: 'TVISIT',
      siteLastVisitedPathname: '/post/7',
      totalViewer: 999,
      totalVisited: 8888,
      maxArticleVisited: 250,
      maxArticleViewer: 300,
    };
    expect(JSON.stringify(data)).toBe(JSON.stringify(expected));
    expect(tracker.max).toBeGreaterThanOrEqual(6);
  });

  it('viewer：空榜单 / 没有最近访问时 max=0、siteLastVisited* 回落（旧语义）', async () => {
    const { provider } = createDeps({
      topViewer: [],
      topVisited: [],
      lastVisitItem: null,
    });
    const data: any = await provider.getViewerTabData(7);
    expect(data.maxArticleViewer).toBe(0);
    expect(data.maxArticleVisited).toBe(0);
    expect(data.siteLastVisitedTime).toBeNull();
    expect(data.siteLastVisitedPathname).toBe('');
  });

  it('article：tagNum/categoryNum 还是数组长度，6 个读全部并行', async () => {
    const { provider, tracker } = createDeps();
    const data = await provider.getArticleTabData(9);
    const expected = {
      articleNum: 53,
      wordNum: 41508,
      tagNum: 2,
      categoryNum: 1,
      categoryPieData: [{ name: 'c', value: 53 }],
      columnData: [{ tag: 'a', count: 2 }],
    };
    expect(JSON.stringify(data)).toBe(JSON.stringify(expected));
    expect(tracker.max).toBeGreaterThanOrEqual(6);
  });

  it('article：tags/categories 为 null 时数量回落 0（旧语义的 ?. 链保留）', async () => {
    const { provider } = createDeps({ tags: null as any, categories: null as any });
    const data: any = await provider.getArticleTabData(9);
    expect(data.tagNum).toBe(0);
    expect(data.categoryNum).toBe(0);
  });

  it('getWelcomePageData 按 tab 路由，并把对应的 num 传进去', async () => {
    const { provider } = createDeps();
    const seen: Record<string, any> = {};
    (provider as any).getOverViewTabData = async (n: number) => (seen.overview = n);
    (provider as any).getViewerTabData = async (n: number) => (seen.viewer = n);
    (provider as any).getArticleTabData = async (n: number) => (seen.article = n);
    await provider.getWelcomePageData('overview', 1, 2, 3);
    await provider.getWelcomePageData('viewer', 1, 2, 3);
    await provider.getWelcomePageData('article', 1, 2, 3);
    expect(seen).toEqual({ overview: 1, viewer: 2, article: 3 });
    await expect(
      provider.getWelcomePageData('nope' as any, 1, 2, 3),
    ).resolves.toBeUndefined();
  });
});
