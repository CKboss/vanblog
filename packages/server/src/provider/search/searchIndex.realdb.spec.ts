/**
 * 搜索索引的**真库**套件（默认跳过）。
 *
 * ## 为什么需要它
 *
 * `searchIndex.provider.spec.ts` 用假的 `ArticleProvider.getAll` 钉住了"我只收 sitemap 白名单里的文章"，
 * 但那条谓词的**数据库部分**（`deleted` / `hidden` / `publishAt <= now` 的 `$and`）是 Mongo 真跑的，
 * 假对象测不到。而这个索引是一份**世界可读的 JSON**：一篇定时文章的标题、一篇加密文章的标题
 * 出现在里面，就等于把 §7.57-E/H 修掉的泄露重新打开。所以这一条必须用真库证明一次。
 *
 * ## 怎么跑（默认 `describe.skip`，不影响 jest 基线）
 *
 * ```
 * VANBLOG_SEARCH_REALDB=1 \
 * VANBLOG_SEARCH_MONGOD=/path/to/mongod \
 * VANBLOG_SEARCH_REALDB_PORT=27099 \
 * VANBLOG_SEARCH_REALDB_DBPATH=/tmp/vanblog-search-realdb \
 *   ./node_modules/.bin/jest src/provider/search/searchIndex.realdb.spec.ts
 * ```
 *
 * ⚠️ **硬守卫**：端口等于 27017（开发栈那份真数据）时直接 fail，绝不连接、绝不写入。
 * 这个套件会在指定 dbpath 上建库、写文档、最后 dropDatabase；它只能对着一次性的空目录跑。
 */

const TMP_STATIC = '/tmp/vanblog-search-index-realdb-static';
jest.mock('src/config', () => ({
  config: {
    staticPath: '/tmp/vanblog-search-index-realdb-static',
    demo: false,
  },
}));

import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';

import { ArticleSchema } from 'src/scheme/article.schema';
import { CategorySchema } from 'src/scheme/category.schema';
import { ArticleProvider } from '../article/article.provider';
import { CategoryProvider } from '../category/category.provider';
import { SiteMapProvider } from '../sitemap/sitemap.provider';
import { SearchIndexProvider } from './searchIndex.provider';

const ENABLED = process.env.VANBLOG_SEARCH_REALDB === '1';
const MONGOD_BIN = process.env.VANBLOG_SEARCH_MONGOD || '';
const PORT = Number(process.env.VANBLOG_SEARCH_REALDB_PORT || 0);
const DBPATH = process.env.VANBLOG_SEARCH_REALDB_DBPATH || '';
const DEV_STACK_PORT = 27017;

const describeReal = ENABLED ? describe : describe.skip;

/** 硬守卫：不许碰开发栈那份真数据（在 suite 外面就判，跳过时也要能看见理由） */
function assertNotDevStack() {
  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
    throw new Error(`VANBLOG_SEARCH_REALDB_PORT 必须是一个合法端口，收到 "${process.env.VANBLOG_SEARCH_REALDB_PORT}"`);
  }
  if (PORT === DEV_STACK_PORT) {
    throw new Error(
      `拒绝在 ${DEV_STACK_PORT} 上跑真库套件：那是开发栈的真数据（53 篇文章），这个套件会写库并 dropDatabase`,
    );
  }
  if (!MONGOD_BIN) {
    throw new Error('VANBLOG_SEARCH_MONGOD 必须指向一个 mongod 可执行文件');
  }
  if (!DBPATH || DBPATH === '/' || !DBPATH.startsWith('/tmp/')) {
    throw new Error(`VANBLOG_SEARCH_REALDB_DBPATH 必须是 /tmp 下的一次性目录，收到 "${DBPATH}"`);
  }
}

describeReal('SearchIndexProvider（真 mongod）：公开资格过滤', () => {
  let mongod: ChildProcess | undefined;
  let url = '';
  let conn: mongoose.Connection | undefined;
  const indexDir = path.join(TMP_STATIC, 'search');

  beforeAll(async () => {
    assertNotDevStack();
    await fs.rm(DBPATH, { recursive: true, force: true });
    await fs.rm(TMP_STATIC, { recursive: true, force: true });
    await fs.mkdir(DBPATH, { recursive: true });

    url = `mongodb://127.0.0.1:${PORT}/vanblogSearchRealdb`;
    mongod = spawn(
      MONGOD_BIN,
      ['--dbpath', DBPATH, '--port', String(PORT), '--bind_ip', '127.0.0.1'],
      // ⚠️ 不传 --nojournal：MongoDB 6.0 起那个开关没了，传了 mongod 会直接退出
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    mongod.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    // 等它真的能接连接（最多 30s）
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        const probe = await mongoose.createConnection(url, { serverSelectionTimeoutMS: 500 }).asPromise();
        await probe.close();
        break;
      } catch {
        if (Date.now() > deadline) {
          throw new Error(`mongod 起不来（${MONGOD_BIN} --port ${PORT}）：${stderr.slice(-800)}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    conn = await mongoose.createConnection(url).asPromise();
  }, 90000);

  afterAll(async () => {
    try {
      if (conn) {
        await conn.dropDatabase();
        await conn.close();
      }
    } finally {
      if (mongod && mongod.exitCode === null) {
        mongod.kill('SIGKILL');
      }
      await fs.rm(DBPATH, { recursive: true, force: true });
      await fs.rm(TMP_STATIC, { recursive: true, force: true });
    }
  }, 60000);

  async function buildStack() {
    const articleModel = conn!.model('Article', ArticleSchema, 'articles');
    const categoryModel = conn!.model('Category', CategorySchema, 'categories');
    await articleModel.deleteMany({});
    await categoryModel.deleteMany({});

    const articleProvider = new ArticleProvider(
      articleModel as any,
      categoryModel as any,
      {} as any, // metaProvider：getAll / getTotalNum 用不到
      {} as any, // visitProvider：同上
    );
    const categoryProvider = new CategoryProvider(
      categoryModel as any,
      articleProvider as any,
      {} as any, // draftProvider：getAllCategories / getPublicCategoryNames 用不到
    );
    const sitemapProvider = new SiteMapProvider(
      articleProvider as any,
      categoryProvider as any,
      { getAllTags: async () => [] } as any,
      { getAll: async () => [] } as any,
      { getArticlesPerPage: async () => 5 } as any,
    );
    const searchProvider = new SearchIndexProvider(
      articleProvider as any,
      sitemapProvider as any,
    );
    return { articleModel, categoryModel, searchProvider, sitemapProvider };
  }

  it('private / hidden / 软删 / 未到点的 publishAt / 私有分类下的文章，一篇都不进索引', async () => {
    const { articleModel, categoryModel, searchProvider } = await buildStack();
    await categoryModel.create([
      { id: 1, name: '公开分类', private: false, hidden: false, order: 0, type: 'category' },
      { id: 2, name: '私密分类', private: true, hidden: false, order: 1, type: 'category' },
    ]);
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    await articleModel.create([
      {
        id: 1,
        title: 'PUBLIC-KEEP',
        pathname: 'public-keep',
        content: '这篇应该出现在索引里',
        category: '公开分类',
        tags: ['ok'],
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 2,
        title: 'PRIVATE-LEAK-2026年裁员名单',
        pathname: 'private-leak',
        content: '加密正文',
        category: '公开分类',
        createdAt: new Date('2026-01-02T00:00:00Z'),
        private: true,
      },
      {
        id: 3,
        title: 'HIDDEN-LEAK',
        pathname: 'hidden-leak',
        content: '隐藏正文',
        category: '公开分类',
        createdAt: new Date('2026-01-03T00:00:00Z'),
        hidden: true,
      },
      {
        id: 4,
        title: 'DELETED-LEAK',
        pathname: 'deleted-leak',
        content: '软删正文',
        category: '公开分类',
        createdAt: new Date('2026-01-04T00:00:00Z'),
        deleted: true,
        deletedAt: new Date('2026-01-05T00:00:00Z'),
      },
      {
        id: 5,
        title: 'SCHEDULED-LEAK-2030',
        pathname: 'scheduled-leak',
        content: '定时正文',
        category: '公开分类',
        createdAt: new Date('2026-01-06T00:00:00Z'),
        publishAt: future,
      },
      {
        id: 6,
        title: 'PRIVATECAT-LEAK',
        pathname: 'privatecat-leak',
        content: '私有分类下的正文',
        category: '私密分类',
        createdAt: new Date('2026-01-07T00:00:00Z'),
      },
    ]);

    const index = await searchProvider.generateSearchIndexFn('真库：资格过滤');
    expect(index).not.toBeNull();
    expect(index!.docs.map((d) => d.u)).toEqual(['/post/public-keep']);
    expect(index!.count).toBe(1);
    expect(index!.total).toBe(1);

    // 盘上的文件才是"世界可读"的那一份，断言它而不只是返回值
    const onDisk = JSON.parse(await fs.readFile(path.join(indexDir, 'index.json'), 'utf8'));
    const raw = JSON.stringify(onDisk);
    expect(onDisk.docs.map((d: any) => d.u)).toEqual(['/post/public-keep']);
    for (const leaked of [
      'PRIVATE-LEAK',
      'HIDDEN-LEAK',
      'DELETED-LEAK',
      'SCHEDULED-LEAK',
      'PRIVATECAT-LEAK',
      '2026年裁员名单',
      '加密正文',
      '隐藏正文',
      '软删正文',
      '定时正文',
      '私有分类下的正文',
    ]) {
      expect(raw).not.toContain(leaked);
    }
    // 负控：这个断言只有在"文件里真的有内容"时才有意义
    expect(raw).toContain('PUBLIC-KEEP');
    expect(await fs.readdir(indexDir)).toEqual(['index.json']);
  }, 120000);

  it('到点之后的定时文章会自己出现（查询级过滤，不依赖任何 cron 去翻 hidden）', async () => {
    const { articleModel, searchProvider } = await buildStack();
    await articleModel.create([
      {
        id: 10,
        title: 'DUE-NOW',
        pathname: 'due-now',
        content: '这篇的 publishAt 已经过去了',
        category: '公开分类',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        publishAt: new Date(Date.now() - 60 * 1000),
      },
    ]);
    const index = await searchProvider.generateSearchIndexFn('真库：已到点');
    expect(index!.docs.map((d) => d.u)).toEqual(['/post/due-now']);
  }, 120000);

  it('索引的 url 集合与 sitemap 的 /post/** 集合逐条相同（真库口径）', async () => {
    const { articleModel, categoryModel, searchProvider, sitemapProvider } = await buildStack();
    await categoryModel.create([
      { id: 1, name: '公开分类', private: false, hidden: false, order: 0, type: 'category' },
      { id: 2, name: '私密分类', private: true, hidden: false, order: 1, type: 'category' },
    ]);
    await articleModel.create([
      { id: 21, title: 'A', pathname: 'a', content: 'x', category: '公开分类', createdAt: new Date('2026-01-01') },
      { id: 22, title: 'B', pathname: 'b', content: 'x', category: '公开分类', createdAt: new Date('2026-01-02'), private: true },
      { id: 23, title: 'C', pathname: 'c', content: 'x', category: '私密分类', createdAt: new Date('2026-01-03') },
      { id: 24, title: 'D', pathname: 'd', content: 'x', category: '公开分类', createdAt: new Date('2026-01-04'), hidden: true },
      { id: 25, title: 'E', pathname: '', content: 'x', category: '公开分类', createdAt: new Date('2026-01-05') },
    ]);
    const entries = await sitemapProvider.getSiteEntries();
    const sitemapPostUrls = entries.map((e) => e.url).filter((u) => u.startsWith('/post/')).sort();
    const index = await searchProvider.generateSearchIndexFn('真库：与 sitemap 对齐');
    expect(index!.docs.map((d) => d.u).sort()).toEqual(sitemapPostUrls);
    // 负控：确实排掉了东西（否则这条断言是空的）
    expect(sitemapPostUrls.length).toBeLessThan(5);
    expect(sitemapPostUrls).toContain('/post/25'); // 没有 pathname 的文章回落数字 id
  }, 120000);
});

describe('真库套件的守卫本身（不依赖 mongod，永远跑）', () => {
  it('端口 27017 会被硬拒（开发栈的真数据不许被这个套件碰到）', () => {
    const source = require('fs').readFileSync(path.join(__dirname, 'searchIndex.realdb.spec.ts'), 'utf8');
    expect(source).toContain('DEV_STACK_PORT = 27017');
    expect(source).toContain('PORT === DEV_STACK_PORT');
    expect(source).toContain('dropDatabase');
    // 默认不启用：没有 VANBLOG_SEARCH_REALDB=1 时整个 suite 是 describe.skip
    expect(source).toContain('const describeReal = ENABLED ? describe : describe.skip;');
  });
});
