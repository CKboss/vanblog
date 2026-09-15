/**
 * 每次页面浏览到底打了几次 Mongo —— 实测用的量具，不是普通单测。
 *
 * 为什么要它：`POST /api/public/viewer` 这条路径横跨 metas / articles / viewers / visits
 * 四个集合，改任何一处都很难"看出来"少了几次往返。这里直接把真实的 Provider 接到一个
 * **独立的临时库**上，用驱动的 `monitorCommands` 把命令一条条记下来，
 * 于是"每次浏览 N 次操作、M 次写"是数出来的，不是推出来的。
 *
 * ⚠️ 默认**整套跳过**（不连库）：CI 上没有 mongod，普通 `jest` 也不该依赖外部服务。
 * 要跑就显式给一个**一次性库名**（别指向真实数据）：
 *
 *   VANBLOG_OPSCOUNT_URL='mongodb://127.0.0.1:27017/vanblog_opscount_scratch?directConnection=true' \
 *     ./node_modules/.bin/jest --config ./test/jest-opscount.json
 *
 * 跑完可以把那个临时库删掉（它只由本文件创建，里面只有几条种子数据）。
 */
import mongoose from 'mongoose';
import dayjs from 'dayjs';

import { MetaProvider } from 'src/provider/meta/meta.provider';
import { ArticleProvider } from 'src/provider/article/article.provider';
import { ViewerProvider } from 'src/provider/viewer/viewer.provider';
import { VisitProvider } from 'src/provider/visit/visit.provider';
import { ViewStatsProvider } from 'src/provider/stats/viewStats.provider';
import { Meta, MetaSchema } from 'src/scheme/meta.schema';
import { Article, ArticleSchema } from 'src/scheme/article.schema';
import { Category, CategorySchema } from 'src/scheme/category.schema';
import { Viewer, ViewerSchema } from 'src/scheme/viewer.schema';
import { Visit, VisitSchema } from 'src/scheme/visit.schema';

const URL = process.env.VANBLOG_OPSCOUNT_URL || '';
const d = URL ? describe : describe.skip;

/** 只统计数据面命令：心跳（hello/isMaster）、endSessions、建索引都不算"一次浏览的开销"。 */
const DATA_COMMANDS = new Set([
  'find',
  'insert',
  'update',
  'delete',
  'findAndModify',
  'aggregate',
  'count',
  'distinct',
  'getMore',
]);
const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify']);

/** 从命令体里挑出真正被碰的那个集合（`findAndModify` 用的是 commandName 之外的字段名）。 */
function namespaceOf(commandName: string, command: any): string {
  const first = command?.[commandName];
  if (typeof first === 'string') return first;
  return String(command?.[commandName] ?? '?');
}

d('per-view Mongo operation count (real providers, scratch db)', () => {
  jest.setTimeout(60000);
  let conn: mongoose.Connection;
  let dbName = '';
  let metaProvider: MetaProvider;
  let visitProvider: VisitProvider;
  let viewerProvider: ViewerProvider;
  let viewStats: ViewStatsProvider;

  const recorded: Array<{ name: string; ns: string; write: boolean }> = [];
  let recording = false;

  const startRecording = () => {
    recorded.length = 0;
    recording = true;
  };
  const stopRecording = () => {
    recording = false;
    return {
      ops: recorded.length,
      writes: recorded.filter((r) => r.write).length,
      byNs: recorded.reduce((acc, r) => {
        acc[r.ns] = (acc[r.ns] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      list: recorded.map((r) => `${r.name} ${r.ns}${r.write ? ' (write)' : ''}`),
    };
  };

  const today = dayjs().format('YYYY-MM-DD');

  beforeAll(async () => {
    dbName = URL.replace(/^[^/]*\/\/[^/]+\//, '').split('?')[0];
    // 硬护栏：这个量具会 dropDatabase，绝不允许指向真实库
    if (!/^[A-Za-z0-9_-]+$/.test(dbName) || /^(vanBlog|waline|admin|local|config|test)$/i.test(dbName)) {
      throw new Error(
        `VANBLOG_OPSCOUNT_URL 必须指向一个一次性的临时库（当前解析出 "${dbName}"），拒绝执行`,
      );
    }
    conn = mongoose.createConnection(URL, {
      monitorCommands: true,
      serverSelectionTimeoutMS: 4000,
      autoIndex: false,
    } as any);
    await conn.asPromise();
    const client = conn.getClient();
    client.on('commandStarted', (event: any) => {
      if (!recording) return;
      if (event.databaseName !== dbName) return;
      if (!DATA_COMMANDS.has(event.commandName)) return;
      recorded.push({
        name: event.commandName,
        ns: namespaceOf(event.commandName, event.command),
        write: WRITE_COMMANDS.has(event.commandName),
      });
    });

    const metaModel = conn.model(Meta.name, MetaSchema);
    const articleModel = conn.model(Article.name, ArticleSchema);
    const categoryModel = conn.model(Category.name, CategorySchema);
    const viewerModel = conn.model(Viewer.name, ViewerSchema);
    const visitModel = conn.model(Visit.name, VisitSchema);

    visitProvider = new VisitProvider(visitModel);
    viewerProvider = new ViewerProvider(viewerModel);
    const articleProvider = new ArticleProvider(
      articleModel,
      categoryModel,
      undefined as any,
      visitProvider,
    );
    viewStats = new ViewStatsProvider(metaModel, articleModel, viewerModel, visitModel);
    metaProvider = new MetaProvider(
      metaModel,
      undefined as any,
      articleProvider,
      viewStats,
    );
    (articleProvider as any).metaProvider = metaProvider;

    await conn.db.dropDatabase();
    await metaModel.create({
      siteInfo: { siteName: 'scratch', baseUrl: 'http://127.0.0.1:9/' },
      links: [],
      socials: [],
      rewards: [],
      categories: [],
      viewer: 1000,
      visited: 500,
      totalWordCount: 10,
    });
    await articleModel.create({
      id: 1,
      title: 'hello',
      content: '# hello',
      pathname: 'hello-world',
      tags: ['a'],
      category: 'c',
      author: 'admin',
      viewer: 10,
      visited: 5,
      deleted: false,
    });
    await categoryModel.create({ name: 'c', id: 1 });
  });

  afterEach(async () => {
    // 浏览统计现在是攒一批再写的：每个用例结束前显式 flush 一次，
    // 否则待写入的增量会串到下一个用例里
    startRecording();
    await viewStats.flush('test');
    recording = false;
  });

  afterAll(async () => {
    if (conn) {
      await conn.close();
    }
  });

  /** 把当天那两条统计行准备好（= 老访客第二次看同一篇文章的"热路径"）。 */
  const seedToday = async () => {
    await viewerProvider.createOrUpdate({ date: today, viewer: 1000, visited: 500 });
    await visitProvider.add({ pathname: '/post/hello-world', isNew: false });
  };

  const report = (label: string, views: number, recordOps: any, flushOps: any) => {
    const total = recordOps.ops + flushOps.ops;
    // eslint-disable-next-line no-console
    console.log(
      [
        `[${label}] views=${views}`,
        `  record 阶段: ${recordOps.ops} 次命令（${recordOps.writes} 次写） ${JSON.stringify(
          recordOps.list,
        )}`,
        `  flush  阶段: ${flushOps.ops} 次命令（${flushOps.writes} 次写） ${JSON.stringify(
          flushOps.list,
        )}`,
        `  合计 ${total} 次命令 / ${(total / views).toFixed(2)} 次每次浏览；写 ${
          recordOps.writes + flushOps.writes
        } 次 / ${((recordOps.writes + flushOps.writes) / views).toFixed(2)} 次每次浏览`,
      ].join('\n'),
    );
    return total;
  };

  it('一次文章页浏览（热路径，当天那行已存在）', async () => {
    await seedToday();
    startRecording();
    const res = await metaProvider.addViewer(false, '/post/hello-world', false);
    const recordOps = stopRecording();
    startRecording();
    await viewStats.flush('measure');
    const flushOps = stopRecording();
    const total = report('warm article view', 1, recordOps, flushOps);
    expect(res).toEqual({ visited: expect.any(Number), viewer: expect.any(Number) });
    // 改动前这里是 6 次命令 / 4 次写（不含 InitMiddleware 那次 users.findOne）。
    // record 阶段那一次 `find metas` 是"库里的累计值"这个投影基数，
    // 进程生命周期内只读一次（之后由 $inc 的返回值维护），不是每次浏览的开销。
    expect(total).toBeLessThanOrEqual(6);
    expect(recordOps.ops).toBeLessThanOrEqual(1);
    expect(recordOps.writes).toBe(0);
  });

  it('一次文章页浏览（当天还没有这条路径的行）', async () => {
    await conn.db.collection('viewers').deleteMany({ date: today });
    await conn.db.collection('visits').deleteMany({ date: today });
    startRecording();
    await metaProvider.addViewer(true, '/post/hello-world', true);
    const recordOps = stopRecording();
    startRecording();
    await viewStats.flush('measure');
    const flushOps = stopRecording();
    report('cold article view', 1, recordOps, flushOps);
    // 冷路径要多两次：aggregate 取上一天的累计值 + 建当天那行
    expect(flushOps.ops).toBeLessThanOrEqual(6);
    const row = await conn.db
      .collection('visits')
      .findOne({ date: today, pathname: '/post/hello-world' });
    expect(row?.viewer).toBeGreaterThan(0);
  });

  it('一次非文章页浏览（首页）', async () => {
    await seedToday();
    startRecording();
    await metaProvider.addViewer(false, '/', false);
    const recordOps = stopRecording();
    startRecording();
    await viewStats.flush('measure');
    const flushOps = stopRecording();
    report('homepage view', 1, recordOps, flushOps);
    expect(recordOps.ops).toBe(0);
  });

  it('100 次浏览攒成一轮：每次浏览摊到多少次命令', async () => {
    await seedToday();
    startRecording();
    for (let i = 0; i < 100; i += 1) {
      await metaProvider.addViewer(i % 3 === 0, '/post/hello-world', i % 7 === 0);
    }
    const recordOps = stopRecording();
    startRecording();
    await viewStats.flush('measure');
    const flushOps = stopRecording();
    const total = report('100 warm article views in one batch', 100, recordOps, flushOps);
    // 一轮 flush 的命令数与攒了多少次浏览无关：需要建新行时 6 次，稳态 5 次
    expect(flushOps.ops).toBeLessThanOrEqual(6);
    expect(total / 100).toBeLessThan(0.1);
    const row = await conn.db
      .collection('visits')
      .findOne({ date: today, pathname: '/post/hello-world' });
    // 100 次浏览一次都不能少
    expect(row?.viewer).toBeGreaterThanOrEqual(100);
    const meta = await conn.db.collection('metas').findOne({});
    expect(meta?.viewer).toBeGreaterThanOrEqual(1100);
  });

  it('稳态：路径当天已经建过行之后，一轮 flush 固定 5 次命令', async () => {
    await seedToday();
    await viewStats.flush('warmup');
    startRecording();
    for (let i = 0; i < 20; i += 1) {
      await metaProvider.addViewer(false, '/post/hello-world', false);
    }
    const recordOps = stopRecording();
    startRecording();
    await viewStats.flush('measure');
    const flushOps = stopRecording();
    report('20 warm views, steady state', 20, recordOps, flushOps);
    expect(recordOps.ops).toBe(0);
    expect(flushOps.ops).toBe(5);
    expect(flushOps.writes).toBe(4);
    expect(flushOps.list).toEqual([
      'findAndModify metas (write)',
      'update articles (write)',
      'aggregate visits',
      'update visits (write)',
      'update viewers (write)',
    ]);
  });

  it('攒一批之后落库的值，与逐次浏览各写一次完全相同', async () => {
    await conn.db.collection('visits').deleteMany({});
    await conn.db.collection('viewers').deleteMany({});
    await conn.db.collection('articles').updateOne({ id: 1 }, { $set: { viewer: 10, visited: 5 } });
    await conn.db.collection('metas').updateOne({}, { $set: { viewer: 1000, visited: 500 } });
    viewStats.invalidateBase();

    // 5 次浏览：2 个新访客、1 个对该路径的新访客
    await metaProvider.addViewer(true, '/post/hello-world', true);
    await metaProvider.addViewer(false, '/post/hello-world', false);
    await metaProvider.addViewer(true, '/post/hello-world', false);
    await metaProvider.addViewer(false, '/post/hello-world', false);
    await metaProvider.addViewer(false, '/post/hello-world', false);
    await viewStats.flush('measure');

    const meta = await conn.db.collection('metas').findOne({});
    expect({ viewer: meta?.viewer, visited: meta?.visited }).toEqual({
      viewer: 1005,
      visited: 502,
    });
    const article = await conn.db.collection('articles').findOne({ id: 1 });
    // isNewByPath 只出现过一次 → visited +1；viewer +5
    expect({ viewer: article?.viewer, visited: article?.visited }).toEqual({
      viewer: 15,
      visited: 6,
    });
    const visit = await conn.db.collection('visits').findOne({
      date: today,
      pathname: '/post/hello-world',
    });
    expect({ viewer: visit?.viewer, visited: visit?.visited }).toEqual({ viewer: 5, visited: 1 });
    const viewer = await conn.db.collection('viewers').findOne({ date: today });
    expect({ viewer: viewer?.viewer, visited: viewer?.visited }).toEqual({
      viewer: 1005,
      visited: 502,
    });
  });
});
