import { SiteMapProvider } from './sitemap.provider';

function createProvider(total: number, articlesPerPage: number) {
  const articleProvider = {
    getTotalNum: jest.fn().mockResolvedValue(total),
  };
  const metaProvider = {
    getArticlesPerPage: jest.fn().mockResolvedValue(articlesPerPage),
  };
  const provider = new SiteMapProvider(
    articleProvider as any,
    {} as any,
    {} as any,
    {} as any,
    metaProvider as any,
  );
  return { provider, articleProvider, metaProvider };
}

describe('SiteMapProvider.getCategoryUrls (#359)', () => {
  it('omits hidden categories from sitemap paths', async () => {
    const categoryProvider = {
      getPublicCategoryNames: jest.fn().mockResolvedValue(['随笔', '教程']),
    };
    const provider = new SiteMapProvider(
      { getTotalNum: jest.fn() } as any,
      categoryProvider as any,
      {} as any,
      {} as any,
      { getArticlesPerPage: jest.fn() } as any,
    );

    await expect(provider.getCategoryUrls()).resolves.toEqual([
      '/category/随笔',
      '/category/教程',
    ]);
    expect(categoryProvider.getPublicCategoryNames).toHaveBeenCalled();
  });
});

describe('SiteMapProvider.getPageUrls (#346)', () => {
  it('builds /page/n paths using the configured articles-per-page size', async () => {
    const { provider } = createProvider(23, 10);
    await expect(provider.getPageUrls()).resolves.toEqual(['/page/1', '/page/2', '/page/3']);
  });

  it('keeps a single page when total fits in the default size of 5', async () => {
    const { provider } = createProvider(5, 5);
    await expect(provider.getPageUrls()).resolves.toEqual(['/page/1']);
  });
});

describe('SiteMapProvider.getSiteEntries（lastmod / changefreq / priority）', () => {
  function createEntriesProvider(articles: any[], categories: any[] = []) {
    const provider = new SiteMapProvider(
      {
        getAll: jest.fn().mockResolvedValue(articles),
        getTotalNum: jest.fn().mockResolvedValue(articles.length),
      } as any,
      {
        getPublicCategoryNames: jest.fn().mockResolvedValue([]),
        getAllCategories: jest.fn().mockResolvedValue(categories),
      } as any,
      { getAllTags: jest.fn().mockResolvedValue([]) } as any,
      { getAll: jest.fn().mockResolvedValue([]) } as any,
      { getArticlesPerPage: jest.fn().mockResolvedValue(5) } as any,
    );
    return provider;
  }

  const articles = [
    {
      id: 1,
      pathname: 'hello-world',
      title: 'A',
      category: '博客',
      updatedAt: '2026-03-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 2,
      pathname: '',
      title: 'B',
      category: '博客',
      updatedAt: null,
      createdAt: '2026-02-01T00:00:00.000Z',
    },
    { id: 3, pathname: 'locked', title: 'C', category: '博客', private: true, createdAt: '2026-02-02' },
    { id: 4, pathname: 'in-private-cat', title: 'D', category: '私密分类', createdAt: '2026-02-03' },
  ];

  it('文章带 lastmod（updatedAt 优先，其次 createdAt）、changefreq 与 priority', async () => {
    const entries = await createEntriesProvider(articles).getSiteEntries();
    const first = entries.find((e) => e.url === '/post/hello-world');
    expect(first).toMatchObject({ changefreq: 'weekly', priority: 0.8 });
    expect(first.lastmod.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    const second = entries.find((e) => e.url === '/post/2');
    expect(second.lastmod.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('加密文章与加密分类下的文章不进 sitemap（正文对爬虫不可见，收录只会被判薄内容）', async () => {
    const entries = await createEntriesProvider(articles, [
      { name: '私密分类', private: true },
    ]).getSiteEntries();
    const urls = entries.map((e) => e.url);
    expect(urls).not.toContain('/post/locked');
    expect(urls).not.toContain('/post/in-private-cat');
    expect(urls).toContain('/post/hello-world');
  });

  it('首页/时间线/分类页用「最新文章更新时间」当 lastmod，且首页优先级最高', async () => {
    const entries = await createEntriesProvider(articles).getSiteEntries();
    const home = entries.find((e) => e.url === '/');
    expect(home.priority).toBe(1.0);
    expect(home.changefreq).toBe('daily');
    expect(home.lastmod.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    const timeline = entries.find((e) => e.url === '/timeline');
    expect(timeline.lastmod.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(timeline.priority).toBe(0.7);
  });

  it('分页优先级递减，且同一 url 只出现一次（/page/1 与首页重复时保留先出现的）', async () => {
    const provider = createEntriesProvider(articles);
    (provider as any).getPageUrls = async () => ['/page/1', '/page/2', '/page/3'];
    const entries = await provider.getSiteEntries();
    const urls = entries.map((e) => e.url);
    expect(urls.filter((u) => u === '/page/1')).toHaveLength(1);
    const p2 = entries.find((e) => e.url === '/page/2');
    const p3 = entries.find((e) => e.url === '/page/3');
    expect(p2.priority).toBeGreaterThan(p3.priority);
  });

  it('拿不到分类信息时不让整份 sitemap 生成失败', async () => {
    const provider = createEntriesProvider(articles);
    (provider as any).categoryProvider = {
      getPublicCategoryNames: async () => [],
      getAllCategories: async () => {
        throw new Error('db down');
      },
    };
    const entries = await provider.getSiteEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.url)).toContain('/post/hello-world');
  });

  it('非法时间不会变成 1970（宁可没有 lastmod）', async () => {
    const provider = createEntriesProvider([
      { id: 9, pathname: 'bad-date', title: 'X', category: 'c', updatedAt: '乱七八糟', createdAt: '' },
    ]);
    const entries = await provider.getSiteEntries();
    const entry = entries.find((e) => e.url === '/post/bad-date');
    expect(entry.lastmod).toBeUndefined();
  });
});
