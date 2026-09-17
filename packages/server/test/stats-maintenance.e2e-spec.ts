/**
 * `visits` 重复行合并 / 唯一索引 / 保留期清理 —— 在**真 mongod** 上跑的量具。
 *
 * 为什么不只用假 Mongo：这两件事的正确性恰恰取决于真实服务器的行为
 *  - 唯一索引到底能不能挡住并发首访的重复插入（假 Mongo 只能"假装"挡住）；
 *  - 删除条件 `{date: {$gte:'0000-00-00', $lt: cutoff}}` 在真实 BSON 排序下
 *    会不会把 `date` 缺失/为 null 的行一起删掉（null 在 BSON 里排在字符串前面）。
 *
 * ⚠️ 默认**整套跳过**（CI 上没有 mongod）。要跑就给一个**一次性库名**（会 dropDatabase，
 * 代码里有硬护栏，绝不允许指向真实库）：
 *
 *   VANBLOG_STATS_MAINT_URL='mongodb://127.0.0.1:27017/vanblog_statsmaint_scratch?directConnection=true' \
 *     ./node_modules/.bin/jest --config ./test/jest-stats-maintenance.json
 */
import mongoose from 'mongoose';
import dayjs from 'dayjs';

import { StatsMaintenanceProvider } from 'src/provider/stats/statsMaintenance.provider';
import { VisitProvider } from 'src/provider/visit/visit.provider';
import { Visit, VisitSchema } from 'src/scheme/visit.schema';
import { Viewer, ViewerSchema } from 'src/scheme/viewer.schema';

const URL = process.env.VANBLOG_STATS_MAINT_URL || '';
const d = URL ? describe : describe.skip;

d('stats maintenance against a real mongod', () => {
  jest.setTimeout(60000);
  let conn: mongoose.Connection;
  let dbName = '';
  let visitModel: mongoose.Model<any>;
  let viewerModel: mongoose.Model<any>;
  let maintenance: StatsMaintenanceProvider;
  let visitProvider: VisitProvider;

  const today = dayjs().format('YYYY-MM-DD');
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const old = dayjs().subtract(400, 'day').format('YYYY-MM-DD');

  beforeAll(async () => {
    dbName = URL.replace(/^[^/]*\/\/[^/]+\//, '').split('?')[0];
    if (!/^[A-Za-z0-9_-]+$/.test(dbName) || /^(vanBlog|waline|admin|local|config|test)$/i.test(dbName)) {
      throw new Error(`VANBLOG_STATS_MAINT_URL 必须指向一次性临时库（解析出 "${dbName}"），拒绝执行`);
    }
    conn = mongoose.createConnection(URL, { serverSelectionTimeoutMS: 4000, autoIndex: false } as any);
    await conn.asPromise();
    await conn.db.dropDatabase();
    visitModel = conn.model(Visit.name, VisitSchema);
    viewerModel = conn.model(Viewer.name, ViewerSchema);
    visitProvider = new VisitProvider(visitModel);
    maintenance = new StatsMaintenanceProvider(visitModel, viewerModel);
  });

  afterAll(async () => {
    if (conn) await conn.close();
  });

  const count = async () => conn.db.collection('visits').countDocuments({});
  let racedRows: any[] = [];

  it('并发首访会造出重复行 —— 这就是那个逻辑洞（先证明它存在）', async () => {
    await conn.db.collection('visits').deleteMany({});
    // 没有唯一索引时，8 个并发的"当天第一次访问"会各插一行
    await Promise.all(
      Array.from({ length: 8 }, () => visitProvider.add({ pathname: '/post/race', isNew: false })),
    );
    racedRows = await conn.db
      .collection('visits')
      .find({ pathname: '/post/race', date: today })
      .toArray();
    // eslint-disable-next-line no-console
    console.log(
      `[没有唯一索引] 8 个并发首访产生了 ${racedRows.length} 行，viewer 分别是 ${racedRows
        .map((r) => r.viewer)
        .join(',')}`,
    );
    expect(racedRows.length).toBeGreaterThan(1);
  });

  it('合并重复行：计数取 max（不是求和），只留一行', async () => {
    const maxViewerBefore = Math.max(...racedRows.map((r) => r.viewer || 0));
    const sumViewerBefore = racedRows.reduce((acc, r) => acc + (r.viewer || 0), 0);
    const res = await maintenance.dedupVisits();
    expect(res.groups).toBe(1);
    expect(res.dropped).toBe(racedRows.length - 1);
    const rows = await conn.db
      .collection('visits')
      .find({ pathname: '/post/race', date: today })
      .toArray();
    expect(rows).toHaveLength(1);
    // 取 max，不是求和：visits 存的是**累计值**，求和会把阅读量凭空翻好几倍
    expect(rows[0].viewer).toBe(maxViewerBefore);
    expect(rows[0].viewer).toBeLessThan(sumViewerBefore);
    // eslint-disable-next-line no-console
    console.log(
      `[合并后] viewer=${rows[0].viewer}（合并前 max=${maxViewerBefore}、sum=${sumViewerBefore}）visited=${rows[0].visited}，剩 ${rows.length} 行`,
    );
  });

  it('建上唯一索引之后，并发首访只会留下一行', async () => {
    const idx = await maintenance.ensureUniqueIndex(
      'visits',
      visitModel,
      { date: 1, pathname: 1 },
      'date_1_pathname_1',
    );
    expect(idx.error).toBeUndefined();
    expect(idx.created).toBe(true);

    await conn.db.collection('visits').deleteMany({});
    await Promise.all(
      Array.from({ length: 8 }, () => visitProvider.add({ pathname: '/post/race2', isNew: true })),
    );
    const rows = await conn.db
      .collection('visits')
      .find({ pathname: '/post/race2', date: today })
      .toArray();
    // eslint-disable-next-line no-console
    console.log(`[有唯一索引] 8 个并发首访留下了 ${rows.length} 行，viewer=${rows[0]?.viewer}`);
    expect(rows).toHaveLength(1);
    // 8 次访问一次都不能少（重复键兜底那条 $inc 路径生效了）
    expect(rows[0].viewer).toBe(8);
    expect(rows[0].visited).toBe(8);
  });

  it('再跑一遍去重是幂等的（0 组、0 行）', async () => {
    const res = await maintenance.dedupVisits();
    expect(res).toMatchObject({ groups: 0, dropped: 0 });
  });

  it('保留期清理：真实 BSON 下 date 为 null / 缺失的行不会被顺手删掉', async () => {
    await conn.db.collection('visits').deleteMany({});
    await conn.db.collection('viewers').deleteMany({});
    const rows = [
      { date: old, pathname: '/', viewer: 1, visited: 1 },
      { date: dayjs().subtract(100, 'day').format('YYYY-MM-DD'), pathname: '/', viewer: 2, visited: 2 },
      { date: yesterday, pathname: '/', viewer: 3, visited: 3 },
      { date: today, pathname: '/', viewer: 4, visited: 4 },
      { pathname: '/no-date', viewer: 5, visited: 5 },
    ];
    await conn.db.collection('visits').insertMany(rows as any);
    await conn.db.collection('visits').updateOne(
      { pathname: '/no-date' },
      { $set: { date: null } },
    );
    await conn.db.collection('viewers').insertMany(rows.map((r) => ({ ...r })) as any);

    // 保留 90 天（含今天）
    process.env.VANBLOG_VISIT_RETENTION_DAYS = '90';
    const scoped = new StatsMaintenanceProvider(visitModel, viewerModel);
    expect(scoped.retentionDays).toBe(90);
    const res = await scoped.pruneStats('量具');
    // eslint-disable-next-line no-console
    console.log(`[retention=90] ${JSON.stringify(res)}`);
    expect(res.enabled).toBe(true);
    expect(res.cutoff).toBe(dayjs().subtract(89, 'day').format('YYYY-MM-DD'));
    const left = await conn.db
      .collection('visits')
      .find({})
      .project({ date: 1, pathname: 1 })
      .toArray();
    // eslint-disable-next-line no-console
    console.log(`[retention=90] 剩下 ${JSON.stringify(left.map((r) => [r.date, r.pathname]))}`);
    expect(res.visits).toBe(2);
    // date 为 null 的那一行必须活着（只写 $lt 会把它一起删掉：BSON 里 null < 任何字符串）
    expect(left.some((r) => r.pathname === '/no-date')).toBe(true);
    expect(left.some((r) => r.date === today)).toBe(true);
    expect(left.some((r) => r.date === yesterday)).toBe(true);
    delete process.env.VANBLOG_VISIT_RETENTION_DAYS;
  });

  it('默认（不设环境变量）：保留期 3650 天（10 年），只删窗口外的按天行', async () => {
    // 各插一条 4000 天前（约 11 年，落在 3650 天窗口之外）与今天的行：
    // 默认 prune 应该只删前者（以前的默认是 0 = 一行都不删）。
    // ⚠️ 这里必须比 3650 天更老 —— 默认值从 365 抬到 3650 之后，400 天前的行已经在窗口内了。
    const ancient = dayjs().subtract(4000, 'day').format('YYYY-MM-DD');
    const before = await count();
    await conn.db.collection('visits').insertMany([
      { date: ancient, pathname: '/b3-default-probe', viewer: 1, visited: 1 },
      { date: today, pathname: '/b3-default-probe', viewer: 1, visited: 1 },
    ] as any);
    const scoped = new StatsMaintenanceProvider(visitModel, viewerModel);
    expect(scoped.retentionDays).toBe(3650);
    const res = await scoped.pruneStats('量具');
    expect(res).toMatchObject({ enabled: true, effectiveDays: 3650 });
    expect(res.visits).toBe(1); // 只有 4000 天前那行
    expect(await count()).toBe(before + 1); // 插 2 删 1
    const left = await conn.db
      .collection('visits')
      .find({ pathname: '/b3-default-probe' })
      .toArray();
    expect(left).toHaveLength(1);
    expect((left[0] as any).date).toBe(today);
    // 显式设 0 的逃生口（旧默认行为）仍然成立：一行都不删
    process.env.VANBLOG_VISIT_RETENTION_DAYS = '0';
    const off = new StatsMaintenanceProvider(visitModel, viewerModel);
    expect(off.retentionDays).toBe(0);
    const offRes = await off.pruneStats('量具');
    expect(offRes).toMatchObject({ enabled: false, visits: 0, viewers: 0 });
    delete process.env.VANBLOG_VISIT_RETENTION_DAYS;
  });

  it('viewers.date 也能换成唯一索引（同名替换，不新增索引）', async () => {
    await viewerModel.collection.createIndex({ date: 1 }, { name: 'date_1', background: true });
    const before = (await viewerModel.collection.indexes()).length;
    const res = await maintenance.ensureUniqueIndex('viewers', viewerModel, { date: 1 }, 'date_1');
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ created: true, replaced: true });
    const after = await viewerModel.collection.indexes();
    expect(after).toHaveLength(before);
    expect(after.find((i: any) => i.name === 'date_1')?.unique).toBe(true);
    // 再跑一次是 no-op
    const again = await maintenance.ensureUniqueIndex('viewers', viewerModel, { date: 1 }, 'date_1');
    expect(again).toMatchObject({ created: false, replaced: false });
  });
});
