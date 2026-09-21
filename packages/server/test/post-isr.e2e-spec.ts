import axios from 'axios';
import { ISRProvider } from '../src/provider/isr/isr.provider';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * End-to-end of issue #356: after an admin edit, every public URL of the
 * article must show the new content — not only /post/<pathname>.
 */
describe('admin edit refreshes all public post URLs (e2e)', () => {
  it('updates /post/<id> and /post/<pathname> after save', async () => {
    const article = {
      id: 30,
      pathname: 'gitea',
      title: 'Gitea 笔记',
      content: '旧内容：安装步骤',
      hidden: false,
      deleted: false,
    };
    const articles = [article];

    const publicCache = new Map<string, string>();
    const render = () => `${article.title}\n${article.content}`;
    const visit = (path: string) => {
      if (!publicCache.has(path)) {
        publicCache.set(path, render());
      }
      return publicCache.get(path);
    };
    const revalidate = (path: string) => {
      publicCache.set(path, render());
    };

    mockedAxios.get.mockImplementation(async (url: string) => {
      // ⚠️ 必须按 query 参数解析，不能 `split('path=')[1]` 拿尾巴：2026-09-20 起
      //    buildRevalidateUrl 用 URLSearchParams 组 `?path=…&secret=…`（ab66caa2，
      //    revalidate 共享密钥修复），旧写法会把 `&secret=…` 一起当 path，
      //    revalidate 写进带毒的缓存键 ⇒ /post/<id> 永远是旧内容。
      //    真前台的 /api/revalidate 也是按参数取 path 的，这里与它同口径。
      const params = new URLSearchParams(String(url).split('?')[1] || '');
      const path = params.get('path') || '';
      if (path.startsWith('/post/')) {
        revalidate(path);
      }
      return { data: { revalidated: true } };
    });

    expect(visit('/post/30')).toContain('旧内容：安装步骤');
    expect(visit('/post/gitea')).toContain('旧内容：安装步骤');

    article.content = '新内容：升级到 1.20';

    expect(visit('/post/30')).toContain('旧内容：安装步骤');
    expect(visit('/post/gitea')).toContain('旧内容：安装步骤');

    const articleProvider = {
      getAll: jest.fn().mockResolvedValue(articles),
      getById: jest.fn(async (id: number) => articles.find((item) => item.id === id) || null),
    };
    const isr = new ISRProvider(
      articleProvider as any,
      { generateRssFeed: jest.fn() } as any,
      {
        getCategoryUrls: async () => [],
        getPageUrls: async () => [],
        getTagUrls: async () => [],
        generateSiteMap: jest.fn(),
      } as any,
      { getISRSetting: async () => ({ mode: 'onDemand' }) } as any,
    );

    await isr.activeAllFn('更新文章触发增量渲染！', {
      postId: 30,
      previousPathname: 'gitea',
    });

    expect(visit('/post/30')).toContain('新内容：升级到 1.20');
    expect(visit('/post/gitea')).toContain('新内容：升级到 1.20');
    expect(visit('/post/30')).not.toContain('旧内容');
    expect(visit('/post/gitea')).not.toContain('旧内容');
  });

  it('old pathname-only ISR leaves the numeric-id page stale', async () => {
    const article = {
      id: 30,
      pathname: 'gitea',
      content: '旧内容',
    };
    const publicCache = new Map<string, string>([
      ['/post/30', '旧内容'],
      ['/post/gitea', '旧内容'],
    ]);
    article.content = '新内容';
    const oldUrls = [`/post/${article.pathname || article.id}`];
    for (const path of oldUrls) {
      publicCache.set(path, article.content);
    }
    expect(publicCache.get('/post/gitea')).toBe('新内容');
    expect(publicCache.get('/post/30')).toBe('旧内容');
  });
});
