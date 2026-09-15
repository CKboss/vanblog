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
