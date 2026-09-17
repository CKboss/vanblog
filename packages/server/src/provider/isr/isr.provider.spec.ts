import axios from 'axios';
import { ISRProvider } from './isr.provider';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function createProvider(articles: Array<{ id: number; pathname?: string }>) {
  const articleProvider = {
    getAll: jest.fn().mockResolvedValue(articles),
    getById: jest.fn(async (id: number) => articles.find((item) => item.id === id) || null),
  };
  const settingProvider = {
    getISRSetting: jest.fn().mockResolvedValue({ mode: 'onDemand' }),
  };
  const sitemapProvider = {
    getCategoryUrls: jest.fn().mockResolvedValue([]),
    getPageUrls: jest.fn().mockResolvedValue([]),
    getTagUrls: jest.fn().mockResolvedValue([]),
    generateSiteMap: jest.fn(),
  };
  const rssProvider = {
    generateRssFeed: jest.fn(),
  };
  const provider = new ISRProvider(
    articleProvider as any,
    rssProvider as any,
    sitemapProvider as any,
    settingProvider as any,
  );
  return { provider, articleProvider, settingProvider };
}

describe('ISRProvider', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.get.mockResolvedValue({ data: { revalidated: true } });
  });

  it('getArticleUrls returns id and pathname for the same post', async () => {
    const { provider } = createProvider([{ id: 30, pathname: 'gitea' }]);
    await expect(provider.getArticleUrls()).resolves.toEqual(['/post/30', '/post/gitea']);
  });

  it('on-demand ISR revalidates both public URLs after an admin edit (#356)', async () => {
    const { provider } = createProvider([
      { id: 30, pathname: 'gitea' },
      { id: 2 },
    ]);

    await provider.activeAllFn('更新文章触发增量渲染！', { postId: 30 });

    const revalidated = mockedAxios.get.mock.calls.map((call) => {
      const url = String(call[0]);
      return decodeURIComponent(url.split('path=')[1] || '');
    });

    expect(revalidated).toContain('/post/30');
    expect(revalidated).toContain('/post/gitea');
    expect(revalidated.indexOf('/post/30')).toBeLessThan(revalidated.indexOf('/post/2'));
    expect(revalidated.indexOf('/post/gitea')).toBeLessThan(revalidated.indexOf('/post/2'));
  });

  it('revalidates the previous pathname when it changes', async () => {
    const { provider } = createProvider([{ id: 30, pathname: 'new-path' }]);

    await provider.activeAllFn('更新文章触发增量渲染！', {
      postId: 30,
      previousPathname: 'gitea',
    });

    const revalidated = mockedAxios.get.mock.calls.map((call) => {
      const url = String(call[0]);
      return decodeURIComponent(url.split('path=')[1] || '');
    });
    expect(revalidated).toEqual(expect.arrayContaining(['/post/30', '/post/new-path', '/post/gitea']));
  });

  it('skips on-demand ISR in delay mode unless forced', async () => {
    const { provider, settingProvider } = createProvider([{ id: 30, pathname: 'gitea' }]);
    settingProvider.getISRSetting.mockResolvedValue({ mode: 'delay' });

    await provider.activeAllFn('更新文章触发增量渲染！', { postId: 30 });
    expect(mockedAxios.get).not.toHaveBeenCalled();

    await provider.activeAllFn('手动触发 ISR', { postId: 30, forceActice: true });
    const revalidated = mockedAxios.get.mock.calls.map((call) => {
      const url = String(call[0]);
      return decodeURIComponent(url.split('path=')[1] || '');
    });
    expect(revalidated).toEqual(expect.arrayContaining(['/post/30', '/post/gitea']));
  });
});

describe('ISRProvider 全量渲染的互斥与超时', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.get.mockResolvedValue({ data: { revalidated: true } });
  });

  it('并发的 activeAllFn 只会跑一轮，多出来的合并成结束后补一轮', async () => {
    const { provider } = createProvider([{ id: 1, pathname: 'a' }]);
    // runStorm 就是"一轮全量渲染"的本体，数它被调了几次最直观
    const spy = jest.spyOn(provider as any, 'runStorm');
    await Promise.all([
      provider.activeAllFn('保存文章 1'),
      provider.activeAllFn('保存文章 2'),
      provider.activeAllFn('保存文章 3'),
    ]);
    // 一轮立即跑 + 一轮补跑（三次请求合并成一次），不是三轮
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('一轮 storm 抛错之后互斥量会释放，下一次还能跑', async () => {
    const { provider } = createProvider([{ id: 1, pathname: 'a' }]);
    const spy = jest
      .spyOn(provider as any, 'runStorm')
      .mockRejectedValueOnce(new Error('前台挂了'));
    await expect(provider.activeAllFn('第一轮')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const spy2 = jest.spyOn(provider as any, 'runStorm');
    await provider.activeAllFn('第二轮');
    expect(spy2).toHaveBeenCalledTimes(1);
  });

  it('连续追加有上限，不会无限串下去', async () => {
    const { provider } = createProvider([{ id: 1, pathname: 'a' }]);
    const spy = jest.spyOn(provider as any, 'runStorm').mockImplementation(async () => {
      // 每轮跑的时候都再塞一个请求进来，模拟"有人一直在改数据"
      provider.activeAllFn('又来了').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 0));
    });
    await provider.activeAllFn('第一轮');
    // 1 轮初始 + 最多 STORM_CHAIN_MAX 轮追加
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('每个 revalidate 请求都带超时（axios 默认不超时，前台卡住就会永久停在半路）', async () => {
    const { provider } = createProvider([{ id: 1, pathname: 'a' }]);
    await provider.activeAllFn('超时检查');
    const calls = mockedAxios.get.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, opts] of calls) {
      expect(typeof (opts as any)?.timeout).toBe('number');
      expect((opts as any).timeout).toBeGreaterThan(0);
    }
  });

  it('超时可以用 VANBLOG_ISR_TIMEOUT_MS 覆盖', async () => {
    const prev = process.env.VANBLOG_ISR_TIMEOUT_MS;
    process.env.VANBLOG_ISR_TIMEOUT_MS = '1234';
    try {
      const { provider } = createProvider([]);
      await provider.testConn();
      const last = mockedAxios.get.mock.calls[mockedAxios.get.mock.calls.length - 1];
      expect((last?.[1] as any)?.timeout).toBe(1234);
    } finally {
      if (prev === undefined) delete process.env.VANBLOG_ISR_TIMEOUT_MS;
      else process.env.VANBLOG_ISR_TIMEOUT_MS = prev;
    }
  });

  it('写错成非数字时回落默认值，不会把 NaN 交给 axios', async () => {
    const prev = process.env.VANBLOG_ISR_TIMEOUT_MS;
    process.env.VANBLOG_ISR_TIMEOUT_MS = 'abc';
    try {
      const { provider } = createProvider([]);
      await provider.testConn();
      const last = mockedAxios.get.mock.calls[mockedAxios.get.mock.calls.length - 1];
      expect((last?.[1] as any)?.timeout).toBe(10000);
    } finally {
      if (prev === undefined) delete process.env.VANBLOG_ISR_TIMEOUT_MS;
      else process.env.VANBLOG_ISR_TIMEOUT_MS = prev;
    }
  });
});

/* ================= ISR 产物清道夫（reapStaleArtifacts / 风暴收尾 / 周期对账） ================= */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SERVE_HTML_PAGES_DIR_ENV } from '../caddy/caddy.provider';
import { DEFAULT_REAP_INTERVAL_MS, MIN_REAP_INTERVAL_MS, REAP_INTERVAL_ENV } from './isr.provider';

describe('ISRProvider 产物清道夫集成', () => {
  let root: string;
  let savedDir: string | undefined;
  const FIXED_ENTRIES = ['/', '/timeline', '/category', '/tag', '/about', '/link'].map((url) => ({ url }));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-reaper-it-'));
    savedDir = process.env[SERVE_HTML_PAGES_DIR_ENV];
    process.env[SERVE_HTML_PAGES_DIR_ENV] = root;
  });
  afterEach(() => {
    if (savedDir === undefined) delete process.env[SERVE_HTML_PAGES_DIR_ENV];
    else process.env[SERVE_HTML_PAGES_DIR_ENV] = savedDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const touch = (rel: string) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  };
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));

  function createReaperProvider(opts: {
    entries?: Array<{ url: string }> | Error;
    cats?: string[];
    tags?: string[];
    pages?: string[];
  }) {
    const sitemapProvider = {
      getSiteEntries:
        opts.entries instanceof Error
          ? jest.fn().mockRejectedValue(opts.entries)
          : jest.fn().mockResolvedValue(opts.entries ?? []),
      getCategoryUrls: jest.fn().mockResolvedValue(opts.cats ?? []),
      getTagUrls: jest.fn().mockResolvedValue(opts.tags ?? []),
      getPageUrls: jest.fn().mockResolvedValue(opts.pages ?? []),
      generateSiteMap: jest.fn(),
    };
    const provider = new ISRProvider(
      { getAll: jest.fn().mockResolvedValue([]), getById: jest.fn().mockResolvedValue(null) } as any,
      { generateRssFeed: jest.fn() } as any,
      sitemapProvider as any,
      { getISRSetting: jest.fn().mockResolvedValue({ mode: 'onDemand' }) } as any,
    );
    jest.spyOn(provider.logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(provider.logger, 'debug').mockImplementation(() => undefined);
    return { provider, sitemapProvider };
  }

  it('对账删掉不可公开的产物；category/tag 的 URL 会 decodeURIComponent 后与盘上文件名对齐', async () => {
    touch('post/keep.html');
    touch('post/gone.html');
    touch('post/gone.json');
    touch('category/博客.html');
    touch('category/old-cat.html');
    touch('page/1.html');
    touch('page/2.html');
    touch('index.html'); // 固定页永远不碰
    const { provider } = createReaperProvider({
      entries: [...FIXED_ENTRIES, { url: '/post/keep' }],
      cats: ['/category/%E5%8D%9A%E5%AE%A2'], // encodeQuerystring 之后的形态
      pages: ['/page/1'],
    });
    await provider.reapStaleArtifacts('测试');
    expect(exists('post/keep.html')).toBe(true);
    expect(exists('post/gone.html')).toBe(false); // 不可公开 → 删
    expect(exists('post/gone.json')).toBe(false); // 三件套一起
    expect(exists('category/博客.html')).toBe(true); // 解码后命中 qualified
    expect(exists('category/old-cat.html')).toBe(false);
    expect(exists('page/1.html')).toBe(true);
    expect(exists('page/2.html')).toBe(false);
    expect(exists('index.html')).toBe(true);
    provider.onModuleDestroy();
  });

  it('全站文章删光（无 /post 条目但 6 个固定页条目都在）：post 产物照删 —— 这正是最需要清的场景', async () => {
    touch('post/x.html');
    touch('post/x.json');
    const { provider } = createReaperProvider({ entries: FIXED_ENTRIES });
    await provider.reapStaleArtifacts('测试');
    expect(exists('post/x.html')).toBe(false);
    provider.onModuleDestroy();
  });

  it('集合形状异常（固定页条目不齐）→ 跳过不删 + warn（拿不完整集合对账 = 误删正常文章）', async () => {
    touch('post/keep.html');
    const { provider } = createReaperProvider({ entries: FIXED_ENTRIES.slice(0, 5) });
    await provider.reapStaleArtifacts('测试');
    expect(exists('post/keep.html')).toBe(true);
    expect(provider.logger.warn).toHaveBeenCalledWith(expect.stringContaining('形状异常'));
    provider.onModuleDestroy();
  });

  it('getSiteEntries 抛错（DB 抖动）→ 跳过不删 + error，且不 crash', async () => {
    touch('post/keep.html');
    const { provider } = createReaperProvider({ entries: new Error('mongo down') });
    await expect(provider.reapStaleArtifacts('测试')).resolves.toBeUndefined();
    expect(exists('post/keep.html')).toBe(true);
    expect(provider.logger.error).toHaveBeenCalledWith(expect.stringContaining('读取可公开集合失败'));
    provider.onModuleDestroy();
  });

  it('pages 目录不存在（dev 机）→ 静默 no-op，连 DB 都不查', async () => {
    process.env[SERVE_HTML_PAGES_DIR_ENV] = path.join(root, 'no-such');
    const { provider, sitemapProvider } = createReaperProvider({ entries: FIXED_ENTRIES });
    await provider.reapStaleArtifacts('测试');
    expect(sitemapProvider.getSiteEntries).not.toHaveBeenCalled();
    provider.onModuleDestroy();
  });

  it('风暴收尾会跑对账：activeAllFn 之后过期产物已被清掉（事件驱动链路）', async () => {
    mockedAxios.get.mockResolvedValue({ data: { revalidated: true } });
    touch('post/gone.html');
    touch('post/gone.json');
    touch('post/gone.meta');
    const { provider } = createReaperProvider({ entries: FIXED_ENTRIES });
    await provider.activeAllFn('删除文章触发', { postId: 7 });
    expect(exists('post/gone.html')).toBe(false);
    expect(exists('post/gone.json')).toBe(false);
    expect(exists('post/gone.meta')).toBe(false);
    provider.onModuleDestroy();
  });

  it('周期定时器：构造即启动（主进程）、幂等、onModuleDestroy 清理；间隔用 envPositiveInt 收敛', () => {
    const { provider } = createReaperProvider({ entries: FIXED_ENTRIES });
    const first = (provider as any).reapTimer;
    expect(first).not.toBeNull();
    provider.startArtifactReaper();
    expect((provider as any).reapTimer).toBe(first); // 幂等：不叠第二个
    provider.onModuleDestroy();
    expect((provider as any).reapTimer).toBeNull();
    // 间隔常量钉子：默认 15 分钟、下限 60s（防误配置把 DB 打穿）
    expect(DEFAULT_REAP_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(MIN_REAP_INTERVAL_MS).toBe(60 * 1000);
    expect(REAP_INTERVAL_ENV).toBe('VANBLOG_ISR_REAP_INTERVAL_MS');
  });

  it('worker 守卫与风暴收尾调用点在源码里钉住（多进程重复删/漏调都是事故）', () => {
    const src = fs.readFileSync(path.join(__dirname, 'isr.provider.ts'), 'utf8');
    expect(src).toContain('isPrimaryInstance(cluster)'); // 周期对账只在主进程
    expect(src).toContain('await this.reapStaleArtifacts(`全量渲染收尾'); // runStorm 末尾
  });
});
