/**
 * 搜索索引生成器的单测。
 *
 * 三条主线：
 *  1. **"谁能进索引"完全复用 sitemap 的谓词**（不是我自己再写一遍 private/hidden/publishAt）——
 *     这里既用假 sitemap 钉住"白名单之外的一篇都不许出现"，也用**真的 SiteMapProvider**
 *     跑一遍种下去的 private / 私有分类文章，断言索引的 url 集合与 sitemap 的 `/post/**` 逐条相同。
 *  2. **摘要与体积有界**：正文再长，`s` 也不超过 `snippetChars`；索引文件里绝不出现整篇正文
 *     （§7.42 的 1.69 MB/请求 放大器不能再造一次）。
 *  3. **写盘纪律**：tmp + rename、没有 `.tmp-*` 残留、失败只记一条**带来源**的 ERROR 而不抛出去、
 *     `VANBLOG_SEARCH_INDEX=false` 时一个字节都不写。
 */

// 静态目录指到临时目录，否则测试会往真实图床/静态目录里写文件。
// ⚠️ jest.mock 会被提升到 import 之前，工厂里不能引用文件内的变量 —— 两边写死同一个字面量。
const TMP_STATIC = '/tmp/vanblog-search-index-spec';
jest.mock('src/config', () => ({
  config: {
    staticPath: '/tmp/vanblog-search-index-spec',
    demo: false,
  },
}));

import { promises as fs } from 'fs';
import * as path from 'path';

import { SearchIndexProvider } from './searchIndex.provider';
import {
  SEARCH_INDEX_MAX_DOCS_DEFAULT,
  SEARCH_INDEX_SNIPPET_CHARS_DEFAULT,
  SEARCH_INDEX_VERSION,
  buildSearchIndex,
  buildSearchSnippet,
  resolveSearchIndexMaxDocs,
  resolveSearchIndexSnippetChars,
  searchIndexEnabled,
  serializeSearchIndex,
} from './searchIndexBuild';
import { clampToChars, markdownToPlainText } from './markdownPlainText';
import { SiteMapProvider } from '../sitemap/sitemap.provider';
import { isGuardedStaticPath, GUARDED_STATIC_SEGMENTS } from 'src/utils/staticGuard';

const INDEX_DIR = path.join(TMP_STATIC, 'search');
const INDEX_FILE = path.join(INDEX_DIR, 'index.json');

const ENV_KEYS = [
  'VANBLOG_SEARCH_INDEX',
  'VANBLOG_SEARCH_INDEX_MAX_DOCS',
  'VANBLOG_SEARCH_INDEX_SNIPPET_CHARS',
];

function saveEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(async () => {
  await fs.rm(TMP_STATIC, { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(TMP_STATIC, { recursive: true, force: true });
});

/** 一篇"长得像 mongoose 文档返回值"的文章 */
function article(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    pathname: 'hello',
    title: '标题一',
    content: '正文一',
    category: '博客',
    tags: ['tag-a'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...over,
  };
}

/**
 * 造一个 SearchIndexProvider。
 *
 * `sitemapUrls` 是**合格文章的白名单**（真实运行时来自 SiteMapProvider.getSiteEntries），
 * 默认由传进来的文章列表全量生成 —— 也就是"全部合格"，各用例再按需收窄。
 */
function createProvider(
  articles: any[],
  opts: { sitemapUrls?: string[]; logger?: any } = {},
) {
  const getAll = jest.fn().mockResolvedValue(articles);
  const articleProvider = { getAll } as any;
  const urls =
    opts.sitemapUrls ??
    articles.map((a: any) => `/post/${a?.pathname || a?.id}`);
  const getSiteEntries = jest.fn().mockResolvedValue(
    urls.map((url) => ({ url, changefreq: 'weekly', priority: 0.8 })),
  );
  const sitemapProvider = { getSiteEntries } as any;
  const provider = new SearchIndexProvider(articleProvider, sitemapProvider);
  if (opts.logger) {
    (provider as any).logger = opts.logger;
  }
  return { provider, getAll, getSiteEntries, sitemapUrls: urls };
}

async function readIndex(): Promise<any> {
  return JSON.parse(await fs.readFile(INDEX_FILE, 'utf8'));
}

async function listDir(): Promise<string[]> {
  try {
    return await fs.readdir(INDEX_DIR);
  } catch {
    return [];
  }
}

describe('SearchIndexProvider：合格集合完全复用 sitemap 的谓词', () => {
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => restoreEnv(env));

  it('白名单之外的一篇都不进索引（private / hidden / 软删 / 未到点的定时文章都由 sitemap 挡掉）', async () => {
    const publicOne = article({ id: 1, pathname: 'public-one', title: '公开文章' });
    // 这四篇**不在** sitemap 的条目里 —— 真实运行时正是因为
    // getAll(…, includeHidden=false, includeDelete=false) 的 $and（deleted/hidden/visiblePublishFilter）
    // 与 getSiteEntries 的 private / 私有分类过滤把它们排掉了。
    const privateOne = article({ id: 2, pathname: 'private-one', title: '2026 年裁员名单' });
    const hiddenOne = article({ id: 3, pathname: 'hidden-one', title: '隐藏文章' });
    const deletedOne = article({ id: 4, pathname: 'deleted-one', title: '软删文章' });
    const scheduledOne = article({ id: 5, pathname: 'scheduled-one', title: '定时到 2030 年' });

    const { provider, getAll } = createProvider(
      [publicOne, privateOne, hiddenOne, deletedOne, scheduledOne],
      { sitemapUrls: ['/post/public-one'] },
    );

    const index = await provider.generateSearchIndexFn('单测：白名单');
    expect(index).not.toBeNull();
    expect(index!.docs.map((d: any) => d.u)).toEqual(['/post/public-one']);
    expect(index!.count).toBe(1);
    expect(index!.total).toBe(1);

    const raw = serializeSearchIndex(index!);
    // 负控：泄露的标题本身可能就是全部秘密（§7.57-H）
    for (const leaked of ['2026 年裁员名单', '隐藏文章', '软删文章', '定时到 2030 年']) {
      expect(raw).not.toContain(leaked);
    }
    // 我要的是"公开口径"：includeHidden=false、includeDelete=false，与 sitemap 用的同一组 $and
    expect(getAll).toHaveBeenCalledWith('public', false, false);
  });

  it('索引的 url 集合 == 真 SiteMapProvider 的 /post/** 集合（含 private 与私有分类）', async () => {
    const articles = [
      article({ id: 1, pathname: 'ok-1', title: '公开一' }),
      article({ id: 2, pathname: 'secret', title: '加密文章', private: true }),
      article({ id: 3, pathname: 'in-private-cat', title: '私有分类下的', category: '私密分类' }),
      article({ id: 4, pathname: 'ok-2', title: '公开二' }),
    ];
    const categories = [
      { name: '博客', private: false },
      { name: '私密分类', private: true },
    ];
    // 真 sitemap provider：article/category 用假数据源，tag/customPage/meta 与条目无关
    const sitemap = new SiteMapProvider(
      {
        getAll: jest.fn().mockResolvedValue(articles),
        getTotalNum: jest.fn().mockResolvedValue(articles.length),
      } as any,
      {
        getAllCategories: jest.fn().mockResolvedValue(categories),
        getPublicCategoryNames: jest.fn().mockResolvedValue(['博客']),
      } as any,
      { getAllTags: jest.fn().mockResolvedValue([]) } as any,
      { getAll: jest.fn().mockResolvedValue([]) } as any,
      { getArticlesPerPage: jest.fn().mockResolvedValue(5) } as any,
    );

    const entries = await sitemap.getSiteEntries();
    const sitemapPostUrls = entries
      .map((e) => e.url)
      .filter((u) => u.startsWith('/post/'))
      .sort();
    // 负控：这个断言只有在"sitemap 真的排掉了 private 与私有分类"时才有意义
    expect(sitemapPostUrls).toEqual(['/post/ok-1', '/post/ok-2']);

    const provider = new SearchIndexProvider(
      { getAll: jest.fn().mockResolvedValue(articles) } as any,
      sitemap as any,
    );
    const index = await provider.generateSearchIndexFn('单测：与 sitemap 对齐');
    expect(index!.docs.map((d: any) => d.u).sort()).toEqual(sitemapPostUrls);
    const raw = serializeSearchIndex(index!);
    expect(raw).not.toContain('加密文章');
    expect(raw).not.toContain('私有分类下的');
  });

  it('sitemap 拿不到条目（抛错）时整段被兜住：记一条带来源的 ERROR，不抛、不写坏文件', async () => {
    const error = jest.fn();
    const provider = new SearchIndexProvider(
      { getAll: jest.fn().mockResolvedValue([article()]) } as any,
      {
        getSiteEntries: jest.fn().mockRejectedValue(new Error('mongo 抖了一下')),
      } as any,
    );
    (provider as any).logger = { log: jest.fn(), error, debug: jest.fn() };

    await expect(provider.generateSearchIndexFn('单测：sitemap 抛错')).resolves.toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0][0]);
    // 来源必须出现在日志里（sitemap 那轮加固修的就是"一条没有出处的 rejection"）
    expect(message).toContain('单测：sitemap 抛错');
    expect(message).toContain('mongo 抖了一下');
    expect(await listDir()).not.toContain('index.json');
  });
});

describe('SearchIndexProvider：摘要与体积有界', () => {
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => restoreEnv(env));

  it('正文 20000 字、没有 <!-- more -->：摘要仍 ≤ snippetChars，且索引里不含整篇正文', async () => {
    const body = '这是一段很长的中文正文。'.repeat(2000); // 22000 字
    expect(body.length).toBeGreaterThan(20000);
    const marker = 'BODY_MARKER_SHIPPING_FULL_CONTENT_WOULD_BE_A_1_69MB_AMPLIFIER';
    const { provider } = createProvider([
      article({ content: `${body}${marker}${body}` }),
    ]);
    const index = await provider.generateSearchIndexFn('单测：长正文');
    const doc = index!.docs[0];
    expect(doc.s.length).toBeLessThanOrEqual(SEARCH_INDEX_SNIPPET_CHARS_DEFAULT);
    expect(doc.s.length).toBe(SEARCH_INDEX_SNIPPET_CHARS_DEFAULT);
    const raw = serializeSearchIndex(index!);
    expect(raw).not.toContain(marker);
    expect(raw.length).toBeLessThan(body.length);
  });

  it('<!-- more --> 在很靠后的位置：摘要照样有界（excerpt 那一路是无界的，这里必须兜住）', async () => {
    const before = '摘要之前的内容。'.repeat(3000); // 24000 字
    const after = 'MARKER_AFTER_MORE'.repeat(500);
    const { provider } = createProvider([
      article({ content: `${before}<!-- more -->${after}` }),
    ]);
    const index = await provider.generateSearchIndexFn('单测：more 很靠后');
    expect(index!.docs[0].s.length).toBeLessThanOrEqual(
      SEARCH_INDEX_SNIPPET_CHARS_DEFAULT,
    );
    expect(serializeSearchIndex(index!)).not.toContain('MARKER_AFTER_MORE');
  });

  it('摘要里没有 markdown 残渣（**、[]()、#、|、``` 都不许出现）', async () => {
    const content = [
      '# 一个大标题',
      '',
      '> 引用的话',
      '',
      '- 列表项 **加粗** 与 *斜体* 与 `inlineCode`',
      '1. 有序项',
      '',
      '[链接文字](https://example.com/a/b) 和 ![图片替代文字](/static/img/x.webp)',
      '',
      '| 表头 A | 表头 B |',
      '| --- | --- |',
      '| 单元格 | 值 |',
      '',
      '```ts',
      'const SHOULD_NOT_APPEAR = 1;',
      '```',
      '',
      '结尾的普通中文句子，包含 &amp; 与 &lt;tag&gt; 实体。',
    ].join('\n');
    const { provider } = createProvider([article({ content })]);
    const index = await provider.generateSearchIndexFn('单测：markdown 残渣');
    const s = index!.docs[0].s as string;
    expect(s).toContain('链接文字');
    expect(s).toContain('图片替代文字');
    expect(s).toContain('inlineCode'); // 行内代码保留内容
    expect(s).toContain('&');
    expect(s).toContain('<tag>');
    expect(s).not.toContain('SHOULD_NOT_APPEAR'); // 围栏代码块的内容丢掉
    expect(s).not.toContain('https://example.com/a/b');
    expect(s).not.toContain('/static/img/x.webp');
    for (const residue of ['**', '```', '#', '|', '](', '![', '&amp;', '&lt;']) {
      expect(s).not.toContain(residue);
    }
    expect(s).not.toMatch(/\s\n|\n/); // 单行
  });

  it('VANBLOG_SEARCH_INDEX_SNIPPET_CHARS 生效并被夹在 50…500', async () => {
    const content = '字'.repeat(4000);
    process.env.VANBLOG_SEARCH_INDEX_SNIPPET_CHARS = '80';
    const { provider } = createProvider([article({ content })]);
    const index = await provider.generateSearchIndexFn('单测：80 字摘要');
    expect(index!.snippetChars).toBe(80);
    expect(index!.docs[0].s.length).toBeLessThanOrEqual(80);

    expect(resolveSearchIndexSnippetChars({ VANBLOG_SEARCH_INDEX_SNIPPET_CHARS: '10' })).toBe(50);
    expect(resolveSearchIndexSnippetChars({ VANBLOG_SEARCH_INDEX_SNIPPET_CHARS: '99999' })).toBe(500);
    expect(resolveSearchIndexSnippetChars({ VANBLOG_SEARCH_INDEX_SNIPPET_CHARS: 'abc' })).toBe(
      SEARCH_INDEX_SNIPPET_CHARS_DEFAULT,
    );
    expect(resolveSearchIndexSnippetChars({ VANBLOG_SEARCH_INDEX_SNIPPET_CHARS: '' })).toBe(
      SEARCH_INDEX_SNIPPET_CHARS_DEFAULT,
    );
    expect(resolveSearchIndexSnippetChars({})).toBe(SEARCH_INDEX_SNIPPET_CHARS_DEFAULT);
  });
});

describe('SearchIndexProvider：文档上限与 truncated', () => {
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => restoreEnv(env));

  it('超过 maxDocs 时保留**最新**的 N 篇并置 truncated=true，total 仍是全量', async () => {
    const articles = Array.from({ length: 7 }, (_, i) =>
      article({
        id: i + 1,
        pathname: `p${i + 1}`,
        title: `文章 ${i + 1}`,
        // getAll 是 .sort({createdAt:-1}) 的：传进来的顺序就是新→旧
        createdAt: new Date(Date.UTC(2026, 0, 10 - i)),
      }),
    );
    process.env.VANBLOG_SEARCH_INDEX_MAX_DOCS = '3';
    const { provider } = createProvider(articles);
    const index = await provider.generateSearchIndexFn('单测：截断');
    expect(index!.truncated).toBe(true);
    expect(index!.maxDocs).toBe(3);
    expect(index!.count).toBe(3);
    expect(index!.total).toBe(7);
    expect(index!.docs.map((d: any) => d.u)).toEqual(['/post/p1', '/post/p2', '/post/p3']);
  });

  it('没有超过上限时 truncated=false，count == total', async () => {
    const { provider } = createProvider([article(), article({ id: 2, pathname: 'b' })]);
    const index = await provider.generateSearchIndexFn('单测：不截断');
    expect(index!.truncated).toBe(false);
    expect(index!.count).toBe(2);
    expect(index!.total).toBe(2);
    expect(index!.maxDocs).toBe(SEARCH_INDEX_MAX_DOCS_DEFAULT);
  });

  it('VANBLOG_SEARCH_INDEX_MAX_DOCS 的垃圾值回落默认，越界值被夹住', () => {
    expect(resolveSearchIndexMaxDocs({})).toBe(SEARCH_INDEX_MAX_DOCS_DEFAULT);
    expect(resolveSearchIndexMaxDocs({ VANBLOG_SEARCH_INDEX_MAX_DOCS: 'abc' })).toBe(
      SEARCH_INDEX_MAX_DOCS_DEFAULT,
    );
    expect(resolveSearchIndexMaxDocs({ VANBLOG_SEARCH_INDEX_MAX_DOCS: '0' })).toBe(
      SEARCH_INDEX_MAX_DOCS_DEFAULT,
    );
    expect(resolveSearchIndexMaxDocs({ VANBLOG_SEARCH_INDEX_MAX_DOCS: '-5' })).toBe(
      SEARCH_INDEX_MAX_DOCS_DEFAULT,
    );
    expect(resolveSearchIndexMaxDocs({ VANBLOG_SEARCH_INDEX_MAX_DOCS: '7' })).toBe(7);
    expect(resolveSearchIndexMaxDocs({ VANBLOG_SEARCH_INDEX_MAX_DOCS: '999999999' })).toBe(20000);
  });
});

describe('SearchIndexProvider：文件形状', () => {
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => restoreEnv(env));

  it('顶层键与文档键逐字符合约定（键是刻意压短的，改了就要升 version）', async () => {
    const { provider } = createProvider([
      article({
        id: 7,
        pathname: 'some-slug',
        title: '标题',
        content: '摘要来源',
        category: '分类',
        tags: ['标签'],
        updatedAt: new Date('2026-01-02T03:04:05.000Z'),
      }),
    ]);
    await provider.generateSearchIndexFn('单测：形状');
    const onDisk = await readIndex();
    expect(Object.keys(onDisk).sort()).toEqual(
      [
        'version',
        'generatedAt',
        'codeVersion',
        'truncated',
        'maxDocs',
        'snippetChars',
        'count',
        'total',
        'docs',
      ].sort(),
    );
    expect(onDisk.version).toBe(SEARCH_INDEX_VERSION);
    expect(typeof onDisk.codeVersion).toBe('string');
    expect(onDisk.codeVersion.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(onDisk.generatedAt))).toBe(false);
    expect(Object.keys(onDisk.docs[0]).sort()).toEqual(
      ['id', 'u', 't', 's', 'c', 'g', 'd', 'w'].sort(),
    );
    expect(onDisk.docs[0]).toEqual({
      id: 7,
      u: '/post/some-slug',
      t: '标题',
      s: '摘要来源',
      c: '分类',
      g: ['标签'],
      d: '2026-01-02',
      w: onDisk.docs[0].w,
    });
    expect(onDisk.docs[0].w).toBeGreaterThan(0);
  });

  it('没有 pathname 的文章回落数字 id；标签里的非字符串/空串被丢掉；wordCount 与 utils/wordCount 同值', async () => {
    const { wordCount } = await import('src/utils/wordCount');
    const content = '中文四个字 plus three words';
    const { provider } = createProvider([
      article({
        id: 42,
        pathname: undefined,
        tags: ['ok', '', '   ', 123 as any, null as any, 'ok2'],
        content,
        wordCount: undefined,
      }),
    ]);
    const index = await provider.generateSearchIndexFn('单测：脏数据');
    const doc = index!.docs[0];
    expect(doc.u).toBe('/post/42');
    expect(doc.g).toEqual(['ok', 'ok2']);
    expect(doc.w).toBe(wordCount(content));
  });

  it('标签数量有上限（不会有人拿 500 个标签把索引撑大）', async () => {
    const { SEARCH_INDEX_TAGS_PER_DOC } = await import('./searchIndexBuild');
    const tags = Array.from({ length: 500 }, (_, i) => `t${i}`);
    const { provider } = createProvider([article({ tags })]);
    const index = await provider.generateSearchIndexFn('单测：标签上限');
    expect(index!.docs[0].g).toHaveLength(SEARCH_INDEX_TAGS_PER_DOC);
  });

  it('序列化是紧凑的（不带缩进：这个文件是访客要下载的）', () => {
    const payload = buildSearchIndex([article()], { codeVersion: 'v-test' });
    const text = serializeSearchIndex(payload);
    expect(text).not.toContain('\n');
    expect(text).toBe(JSON.stringify(payload));
  });
});

describe('SearchIndexProvider：写盘纪律（tmp + 原子 rename）', () => {
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => restoreEnv(env));

  it('写完之后目录里只有 index.json，没有任何 .tmp-* 残留', async () => {
    const { provider } = createProvider([article()]);
    await provider.generateSearchIndexFn('单测：原子写');
    const files = await listDir();
    expect(files).toEqual(['index.json']);
    expect(files.filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('rename 失败时把 tmp 清掉、错误带来源地记下来，且不抛出 setTimeout', async () => {
    const error = jest.fn();
    const { provider } = createProvider([article()], { logger: { log: jest.fn(), error, debug: jest.fn() } });
    const realRename = fs.rename;
    const spy = jest
      .spyOn(fs, 'rename')
      .mockImplementationOnce(() => Promise.reject(new Error('EXDEV: 跨设备')) as any);
    try {
      await expect(provider.generateSearchIndexFn('单测：rename 失败')).resolves.toBeNull();
    } finally {
      spy.mockRestore();
      expect(fs.rename).toBe(realRename);
    }
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('单测：rename 失败');
    expect(String(error.mock.calls[0][0])).toContain('EXDEV');
    expect((await listDir()).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(await listDir()).not.toContain('index.json');
  });

  it('重复生成是覆盖而不是追加：第二次的文件只含第二次的文章', async () => {
    const first = createProvider([article({ id: 1, pathname: 'a', title: 'A' })]);
    await first.provider.generateSearchIndexFn('单测：第一次');
    expect((await readIndex()).docs.map((d: any) => d.t)).toEqual(['A']);

    const second = createProvider([article({ id: 2, pathname: 'b', title: 'B' })]);
    await second.provider.generateSearchIndexFn('单测：第二次');
    expect((await readIndex()).docs.map((d: any) => d.t)).toEqual(['B']);
  });

  it('目录不存在时会自己建出来（fresh install：staticPath/search 还没被 main.ts 建过）', async () => {
    expect(await listDir()).toEqual([]);
    const { provider } = createProvider([article()]);
    await provider.generateSearchIndexFn('单测：建目录');
    expect((await fs.stat(INDEX_DIR)).isDirectory()).toBe(true);
  });
});

describe('SearchIndexProvider：开关与防抖', () => {
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = saveEnv();
    jest.useFakeTimers();
  });
  afterEach(async () => {
    jest.useRealTimers();
    // ⚠️ 必须等一下：防抖计时器里"发出去就不管"地调了 generateSearchIndexFn，
    // 它里面的真 fs.promises 写盘会在计时器跑完之后才落地。不等的话，
    // 上一轮的写入会串到下一个用例里（实测把"真写盘"那条的文件盖成了上一篇的内容）。
    await new Promise((resolve) => setTimeout(resolve, 30));
    restoreEnv(env);
  });

  it('VANBLOG_SEARCH_INDEX=false：不查库、不写盘（一个字节都不写）', async () => {
    process.env.VANBLOG_SEARCH_INDEX = 'false';
    const { provider, getAll, getSiteEntries } = createProvider([article()]);
    await provider.generateSearchIndex('单测：关掉了', 0);
    jest.runAllTimers();
    await expect(provider.generateSearchIndexFn('单测：关掉了')).resolves.toBeNull();
    expect(getAll).not.toHaveBeenCalled();
    expect(getSiteEntries).not.toHaveBeenCalled();
    expect(await listDir()).toEqual([]);
    expect(searchIndexEnabled({ VANBLOG_SEARCH_INDEX: 'false' })).toBe(false);
    expect(searchIndexEnabled({ VANBLOG_SEARCH_INDEX: '0' })).toBe(false);
    expect(searchIndexEnabled({ VANBLOG_SEARCH_INDEX: 'off' })).toBe(false);
    expect(searchIndexEnabled({ VANBLOG_SEARCH_INDEX: 'nonsense' })).toBe(true);
    expect(searchIndexEnabled({})).toBe(true);
  });

  it('不传 delay 走 60s 防抖；连着触发只跑最后一次（前面的被顶掉）', async () => {
    const { provider, getAll } = createProvider([article()]);
    await provider.generateSearchIndex('单测：防抖 A');
    jest.advanceTimersByTime(30 * 1000);
    expect(getAll).not.toHaveBeenCalled();
    await provider.generateSearchIndex('单测：防抖 B');
    jest.advanceTimersByTime(30 * 1000);
    expect(getAll).not.toHaveBeenCalled(); // A 被 B 顶掉了，60s 也还没到
    jest.advanceTimersByTime(30 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('delay=0 时不等防抖（cron 与"后台刚保存"要立刻出新索引）', async () => {
    const { provider, getAll } = createProvider([article({ id: 9, pathname: 'now' })]);
    await provider.generateSearchIndex('单测：delay=0', 0);
    jest.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('delay 是垃圾值（NaN / 负数 / 非数字）时回落 60s，不会被 setTimeout 当成 1ms', async () => {
    for (const bad of [Number.NaN, -5, 'x' as any, undefined]) {
      const { provider, getAll } = createProvider([article()]);
      await provider.generateSearchIndex('单测：垃圾 delay', bad as any);
      jest.advanceTimersByTime(59 * 1000);
      expect(getAll).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(getAll).toHaveBeenCalledTimes(1);
    }
  });


  it('兜底 cron 存在、带主进程守卫（多进程时这份活只能干一次）', async () => {
    const src = await fs.readFile(path.join(__dirname, 'searchIndex.provider.ts'), 'utf8');
    expect(src).toContain("@Cron('0 5 * * * *')");
    expect(src).toContain('isPrimaryInstance(cluster)');
    // 位置要求：与 sitemap 同一条铁轨（fs.promises + tmp + rename）
    expect(src).toContain('fs.promises.writeFile');
    expect(src).toContain('fs.promises.rename');
    // 负控：不许退回同步 IO（这个文件在 1000 篇量级是 MB 级的，会把事件循环按住）
    expect(src).not.toContain('writeFileSync(');
    expect(src).not.toContain('renameSync(');
    expect(src).not.toContain('mkdirSync(');
  });
});

describe('SearchIndexProvider：真定时器 + 真写盘（不与 fake timers 混在一个 describe 里）', () => {
  let env: Record<string, string | undefined>;
  beforeEach(() => {
    env = saveEnv();
  });
  afterEach(() => restoreEnv(env));

  it('generateSearchIndexFn 直接 await：文件落地、内容能被 JSON.parse、没有 tmp 残留', async () => {
    const { provider } = createProvider([article({ id: 11, pathname: 'real-write' })]);
    const index = await provider.generateSearchIndexFn('单测：真写盘');
    expect(index).not.toBeNull();
    const onDisk = await readIndex();
    expect(onDisk.docs[0].u).toBe('/post/real-write');
    expect(onDisk.count).toBe(1);
    expect(await listDir()).toEqual(['index.json']);
  });

  it('VANBLOG_SEARCH_INDEX=false 时把**已有的**索引删掉（关掉就是真的关掉，不是停更）', async () => {
    const { provider } = createProvider([article({ id: 21, pathname: 'will-be-removed' })]);
    await provider.generateSearchIndexFn('单测：先生成一份');
    expect(await listDir()).toEqual(['index.json']);

    process.env.VANBLOG_SEARCH_INDEX = 'false';
    const log = jest.fn();
    (provider as any).logger = { log, error: jest.fn(), debug: jest.fn() };
    await provider.generateSearchIndex('单测：关掉了', 0);
    expect(await listDir()).not.toContain('index.json');
    // 前台因此拿到 404 → reason=missing → 干净地退回服务端搜索
    expect(String(log.mock.calls.map((c: any[]) => c[0]).join('\n'))).toContain('退回服务端搜索');

    // 再关一次（文件已经不在了）：ENOENT 不该被当成错误刷日志
    const error = jest.fn();
    (provider as any).logger = { log: jest.fn(), error, debug: jest.fn() };
    await provider.generateSearchIndex('单测：重复关闭', 0);
    expect(error).not.toHaveBeenCalled();
  });

  it('删除的范围收得很窄：只删那一个文件名，绝不 rm 目录、绝不用通配（源码钉子）', async () => {
    const src = await fs.readFile(path.join(__dirname, 'searchIndex.provider.ts'), 'utf8');
    expect(src).toContain("path.join(config.staticPath, 'search', 'index.json')");
    expect(src).toContain('fs.promises.unlink(filePath)');
    expect(src).toContain("err?.code !== 'ENOENT'");
    // 负控：这条断言不是空的 —— 任何"批量删"的 API 都不许出现在这个文件里
    for (const dangerous of ['rmSync', 'fs.promises.rm(', 'rmdir', 'rimraf', 'glob(', 'readdir']) {
      expect(src.indexOf(dangerous)).toBe(-1);
    }
  });

  it('防抖入口（真定时器 + delay=0）也会真的把文件写出来', async () => {
    const { provider } = createProvider([article({ id: 12, pathname: 'debounced-write' })]);
    await provider.generateSearchIndex('单测：真防抖', 0);
    // 等 setTimeout(0) 与它发出去的那串异步写盘都落地
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((await listDir()).includes('index.json')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const onDisk = await readIndex();
    expect(onDisk.docs[0].u).toBe('/post/debounced-write');
  });
});

describe('搜索索引的静态目录必须是匿名可读的（否则前台拿不到）', () => {
  it('staticGuard 的 403 名单里没有 search', () => {
    expect(GUARDED_STATIC_SEGMENTS.has('search')).toBe(false);
    expect(isGuardedStaticPath('/static/search/index.json', null)).toBe(false);
    // 负控：这套判定真的会挡东西，不是恒 false
    expect(isGuardedStaticPath('/static/export/x.zip', null)).toBe(true);
    expect(isGuardedStaticPath('/static/%74mp/x.ndjson', null)).toBe(true);
  });

  it('provider 写的就是 <staticPath>/search/index.json（源码钉子）', async () => {
    const src = await fs.readFile(path.join(__dirname, 'searchIndex.provider.ts'), 'utf8');
    expect(src).toContain("path.join(config.staticPath, 'search')");
    expect(src).toContain("path.join(dir, 'index.json')");
  });
});

describe('buildSearchIndex / markdownToPlainText：纯函数向量', () => {
  it('空列表也能产出一个合法的空索引（fresh install：一篇文章都还没写）', () => {
    const index = buildSearchIndex([], { codeVersion: 'v-test' });
    expect(index.count).toBe(0);
    expect(index.total).toBe(0);
    expect(index.docs).toEqual([]);
    expect(index.truncated).toBe(false);
    expect(index.version).toBe(SEARCH_INDEX_VERSION);
  });

  it('顺序原样保留（调用方给的是新→旧，构建函数不重排）', () => {
    const index = buildSearchIndex(
      [
        article({ id: 3, pathname: 'c' }),
        article({ id: 1, pathname: 'a' }),
        article({ id: 2, pathname: 'b' }),
      ],
      { codeVersion: 'v' },
    );
    expect(index.docs.map((d) => d.u)).toEqual(['/post/c', '/post/a', '/post/b']);
  });

  it('脏输入不抛：content/tags/category 缺失或类型不对都退化成安全的空值', () => {
    const index = buildSearchIndex(
      [
        { id: 1 } as any,
        { id: 2, title: null, content: 12345, tags: 'not-an-array', category: 42 } as any,
        null as any,
      ],
      { codeVersion: 'v' },
    );
    expect(index.count).toBe(3);
    expect(index.docs[0]).toEqual({
      id: 1,
      u: '/post/1',
      t: '',
      s: '',
      c: '',
      g: [],
      d: '',
      w: 0,
    });
    expect(index.docs[1].t).toBe('');
    expect(index.docs[1].s).toBe('');
    expect(index.docs[1].g).toEqual([]);
    expect(index.docs[1].c).toBe('');
  });

  it('markdownToPlainText：换行合并、CJK 之间不插空格、拉丁词之间保留空格', () => {
    expect(markdownToPlainText('中文\n中文')).toBe('中文中文');
    expect(markdownToPlainText('hello\nworld')).toBe('hello world');
    expect(markdownToPlainText('中文\nhello')).toBe('中文 hello');
    expect(markdownToPlainText('  多   空  格  ')).toBe('多 空 格');
    expect(markdownToPlainText('')).toBe('');
    expect(markdownToPlainText(undefined)).toBe('');
    expect(markdownToPlainText(42)).toBe('');
  });

  it('markdownToPlainText：未闭合的围栏吃到文末（CommonMark 语义），前面的内容保住', () => {
    expect(markdownToPlainText('前面的话\n```\n没闭合的代码')).toBe('前面的话');
    expect(markdownToPlainText('```\nwhole thing is code')).toBe('');
    expect(markdownToPlainText('a\n```js\nconst x = 1;\n```\nb')).toBe('a b');
    expect(markdownToPlainText('a\n~~~\nx\n~~~\nb')).toBe('a b');
    // 闭栏必须不短于开栏，且同种字符（CommonMark）
    expect(markdownToPlainText('````\n```\n还在代码里\n````\n出来了')).toBe('出来了');
    expect(markdownToPlainText('```\n~~~\n还在代码里\n```\n出来了')).toBe('出来了');
    // 缩进 4 格就不是围栏了（CommonMark 里那是缩进代码块）：内容当普通文本留下，
    // 但反引号本身会被"行内代码标记"那条规则吃掉 —— 摘要里留 `ab` 而不是 `` `ab` ``，
    // 这是有意的（读者要的是词，不是标记）。
    expect(markdownToPlainText('    ```\n不是围栏')).toBe('不是围栏');
    expect(markdownToPlainText('    const x = 1;\n    const y = 2;')).toBe('const x = 1; const y = 2;');
    // 反引号围栏的信息串里带反引号 ⇒ 不是开栏（CommonMark），同样按普通文本处理
    expect(markdownToPlainText('```a`b\n不是围栏')).toBe('ab 不是围栏');
  });

  it('markdownToPlainText：**不吃掉标识符里的下划线**（本机真语料踩到过的缺陷）', () => {
    // 第一版无条件剥掉每一个 `*` `_` `~`，于是 53 篇真语料里有两篇被改坏了：
    //   MODELSCOPE_CACHE → MODELSCOPECACHE、\\HKEY_LOCAL_MACHINE → \\HKEYLOCALMACHINE
    // 摘要看起来没问题，而"搜 MODELSCOPE_CACHE 搜不到"这件事没有任何报错 —— 静默失败。
    expect(markdownToPlainText('定义 MODELSCOPE_CACHE 与 MODELSCOPE_DISABLE_REMOTE')).toBe(
      '定义 MODELSCOPE_CACHE 与 MODELSCOPE_DISABLE_REMOTE',
    );
    expect(markdownToPlainText('计算机\\HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet')).toBe(
      '计算机\\HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet',
    );
    expect(markdownToPlainText('snake_case 与 a_b_c 与 __dunder__')).toBe(
      'snake_case 与 a_b_c 与 dunder',
    );
    // 数学与路径里的符号同样保住
    expect(markdownToPlainText('2*3 与 ~/.ssh 与 ~100')).toBe('2*3 与 ~/.ssh 与 ~100');
  });

  it('markdownToPlainText：真正的强调/删除线标记仍然被去掉', () => {
    expect(markdownToPlainText('*斜体* 与 **粗体** 与 ***又粗又斜***')).toBe(
      '斜体 与 粗体 与 又粗又斜',
    );
    expect(markdownToPlainText('__粗体__ 与 _斜体_')).toBe('粗体 与 斜体');
    expect(markdownToPlainText('~~删除线~~ 与 ~~~三个波浪~~~')).toBe('删除线 与 三个波浪');
    expect(markdownToPlainText('行内 `code` 保留内容')).toBe('行内 code 保留内容');
    // 负控：上面两条一起才说明规则不是"什么都不吃"或"什么都吃"
    expect(markdownToPlainText('*a* _b_ ~c~ `d` e_f')).toBe('a b ~c~ d e_f');
  });

  it('markdownPlainText 的模块级全局正则只用 replace（§7.55-H 的 lastIndex 纪律）', async () => {
    const src = await fs.readFile(path.join(__dirname, 'markdownPlainText.ts'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    // 用 .exec() 的只有那两个**非全局**的围栏正则
    const execReceivers = Array.from(
      (code.match(/([A-Z_][A-Z0-9_]*)\.exec\(/g) || []),
      (hit) => hit.split('.')[0],
    );
    expect(execReceivers.sort()).toEqual(['FENCE_CLOSE', 'FENCE_OPEN']);
    for (const name of execReceivers) {
      const decl = code.match(new RegExp(`const ${name} = /[^;]*`));
      // ⚠️ jest 的 expect 不接受第二个"消息"参数（vitest 才接受），所以把名字放进被比较的对象里
      const isGlobal = decl ? decl[0].endsWith('/g') || decl[0].endsWith('/gm') : true;
      expect({ regex: name, isGlobal }).toEqual({ regex: name, isGlobal: false });
    }
    // 负控：确实有模块级全局正则存在（否则上面那条断言是空的）
    expect((code.match(/^const [A-Z_]+ = \/.*\/[a-z]*g[a-z]*;$/gm) || []).length).toBeGreaterThan(5);
  });

  it('markdownToPlainText：正则都是线性的（(a+)+b 这类输入不会灾难性回溯）', () => {
    const bomb = `${'a'.repeat(40000)}b`;
    const started = Date.now();
    const out = markdownToPlainText(`[${bomb}](https://x.test/) ${bomb} **${bomb}**`);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(typeof out).toBe('string');
  });

  it('buildSearchSnippet：代理对不被切坏，截断处补 …', () => {
    const emoji = '😀'.repeat(400); // 800 个 code unit
    const s = buildSearchSnippet(emoji, 200);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.endsWith('…')).toBe(true);
    const body = s.slice(0, -1);
    // 负控：如果切坏了，末尾会是一个孤立的高代理，JSON 序列化后是 \ud83d 这种替换字符
    expect(body.length % 2).toBe(0);
    expect(body).toBe('😀'.repeat(body.length / 2));
    expect(JSON.parse(JSON.stringify({ s })).s).toBe(s);
  });

  it('clampToChars：边界值与非法值', () => {
    expect(clampToChars('abc', 5)).toBe('abc');
    expect(clampToChars('abc', 3)).toBe('abc');
    expect(clampToChars('abc', 2)).toBe('ab');
    expect(clampToChars('abc', 0)).toBe('');
    expect(clampToChars('abc', -1)).toBe('');
    expect(clampToChars('a😀b', 2)).toBe('a');
    expect(clampToChars(undefined as any, 3)).toBe('');
  });

  it('buildSearchSnippet：空正文 / 只有代码块的正文 → 空串（不是 "undefined"）', () => {
    expect(buildSearchSnippet('', 200)).toBe('');
    expect(buildSearchSnippet('   \n  ', 200)).toBe('');
    expect(buildSearchSnippet(undefined, 200)).toBe('');
    expect(buildSearchSnippet('```\nonly code\n```', 200)).toBe('');
  });
});
