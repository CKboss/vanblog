/**
 * 第四轮安全审计修复的**真库测量**（一次性 mongod 上的量具，env 门控）。
 *
 * 覆盖：
 *  - R4-13：expandPostPaths 的 {id:1,pathname:1,_id:0} 投影前后耗时（312 篇 × ~20KB 语料）；
 *  - B8：children 查询在「无索引无 limit」与「复合索引 + limit」下的耗时与 examinedDocs
 *    （1 条根评论 + 20,000 条已通过回复），以及 page=500 时根评论 skip 的成本；
 *  - B2：蜜罐评论的 DB 真值 —— 12 条正常 + 60 条 hp，修复前 {approved:10, spam:60}，
 *    修复后 spam 被限流桶封顶在 rateLimitPer10Min；
 *  - B3：500 个编造路径在「不限」（旧行为）与「每日上限 100」下的 visits 行数与 dataSize，
 *    metas.viewer 两种情况下都分毫不差（站点级累计一条不丢），以及默认保留期 365 的 prune。
 *
 * ⚠️ 默认**整套跳过**（CI 上没有 mongod）。要跑就起一个**一次性 mongod**（空闲端口）
 * 并给一个一次性库名（会 dropDatabase；有硬护栏：**拒绝 27017 端口**、拒绝真实库名、
 * 库名必须含 audit/scratch）：
 *
 *   VANBLOG_COMMENT_AUDIT_URL='mongodb://127.0.0.1:27199/vanblog_audit_scratch?directConnection=true' \
 *     ./node_modules/.bin/jest --config ./test/jest-audit-fixes-comment.json
 */
import mongoose from 'mongoose';
import dayjs from 'dayjs';
import { performance } from 'perf_hooks';

import { CommentProvider, COMMENT_LIST_INDEX_KEYS, COMMENT_LIST_INDEX_NAME } from 'src/provider/comment/comment.provider';
import { StatsMaintenanceProvider } from 'src/provider/stats/statsMaintenance.provider';
import { ViewStatsProvider } from 'src/provider/stats/viewStats.provider';
import { __resetAttemptLimitForTest } from 'src/utils/attemptLimit';
import { CommentSetting } from 'src/types/setting.dto';

const URL = process.env.VANBLOG_COMMENT_AUDIT_URL || '';
const d = URL ? describe : describe.skip;

/** 硬护栏：绝不许指向开发库（:27017 上有真数据）或任何真实库名 */
function assertThrowawayUrl(raw: string): string {
  // 故意不用 new URL（本套件的 ts 环境里全局 URL 类型不可构造），用严格正则：
  // 必须显式给 host 与端口 —— 缺端口就是默认 27017，直接拒绝
  const m = raw.match(/^mongodb:\/\/([^/:@]+):(\d+)\/([^?]+)/);
  if (!m) {
    throw new Error(
      `VANBLOG_COMMENT_AUDIT_URL 必须形如 mongodb://127.0.0.1:<显式非27017端口>/<一次性库名>（收到 "${raw.slice(0, 60)}"）`,
    );
  }
  const host = m[1];
  const port = m[2];
  const dbName = m[3];
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`只允许本机一次性 mongod（收到 "${host}"）`);
  }
  // 显式端口且绝不是 27017：开发栈的真库在 27017 上，指过去等于毁掉真数据
  if (port === '27017') {
    throw new Error('拒绝 27017：那是开发栈真库的端口');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(dbName) || /^(vanBlog|waline|admin|local|config|test)$/i.test(dbName)) {
    throw new Error(`库名必须是一次性临时库（解析出 "${dbName}"），拒绝执行`);
  }
  if (!/audit|scratch/i.test(dbName)) {
    throw new Error(`库名必须包含 audit 或 scratch（解析出 "${dbName}"），拒绝执行`);
  }
  return dbName;
}

d('audit round-4 fixes against a real mongod', () => {
  jest.setTimeout(180000);
  let conn: mongoose.Connection;
  let dbName = '';
  let articleModel: mongoose.Model<any>;
  let commentModel: mongoose.Model<any>;
  let metaModel: mongoose.Model<any>;
  let visitModel: mongoose.Model<any>;
  let viewerModel: mongoose.Model<any>;

  const SETTING: CommentSetting = {
    provider: 'builtin',
    moderation: 'post',
    keywords: [],
    requireEmail: false,
    pendingOnLink: true,
    maxContentLength: 2000,
    rateLimitPer10Min: 10,
  };
  const settingProvider: any = { getCommentSetting: async () => SETTING };
  const req = (ip: string) => ({ socket: { remoteAddress: ip }, headers: { 'user-agent': 'e2e' } } as any);

  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  beforeAll(async () => {
    dbName = assertThrowawayUrl(URL);
    conn = mongoose.createConnection(URL, { serverSelectionTimeoutMS: 4000, autoIndex: false } as any);
    await conn.asPromise();
    await conn.db.dropDatabase();

    // 最小 schema（故意不 import 真实 Article/Meta schema：那两处正在被别的改动触碰，
    // 而本量具只需要 id/pathname/content/deleted/hidden 这几个字段的真实 BSON 形状）
    articleModel = conn.model(
      'AuditArticle',
      new mongoose.Schema(
        {
          id: Number,
          pathname: String,
          content: String,
          deleted: { type: Boolean, default: false },
          hidden: { type: Boolean, default: false },
          viewer: { type: Number, default: 0 },
          visited: { type: Number, default: 0 },
        },
        { versionKey: false, minimize: false },
      ),
      'articles',
    );
    commentModel = conn.model(
      'AuditComment',
      new mongoose.Schema(
        {
          id: Number,
          path: String,
          articleId: { type: Number, default: 0 },
          rootId: { type: Number, default: 0 },
          parentId: { type: Number, default: 0 },
          replyToNick: { type: String, default: '' },
          nick: String,
          email: { type: String, default: '' },
          site: { type: String, default: '' },
          content: String,
          status: { type: String, default: 'approved' },
          reason: { type: String, default: '' },
          isAuthor: { type: Boolean, default: false },
          ip: { type: String, default: '' },
          ua: { type: String, default: '' },
          source: { type: String, default: '' },
          sourceId: { type: String, default: '' },
          likeCount: { type: Number, default: 0 },
          createdAt: Date,
          updatedAt: Date,
        },
        { versionKey: false, minimize: false },
      ),
      'comments',
    );
    metaModel = conn.model(
      'AuditMeta',
      new mongoose.Schema(
        { viewer: { type: Number, default: 0 }, visited: { type: Number, default: 0 }, siteInfo: Object },
        { versionKey: false, minimize: false },
      ),
      'metas',
    );
    visitModel = conn.model(
      'AuditVisit',
      new mongoose.Schema(
        { date: String, pathname: String, viewer: Number, visited: Number, createdAt: Date, lastVisitedTime: Date },
        { versionKey: false, minimize: false },
      ),
      'visits',
    );
    viewerModel = conn.model(
      'AuditViewer',
      new mongoose.Schema({ date: String, viewer: Number, visited: Number, createdAt: Date }, {
        versionKey: false,
        minimize: false,
      }),
      'viewers',
    );

    // 语料：312 篇 × ~20KB（与审计公开成本那一组同一形状）
    const filler = 'x'.repeat(20 * 1024);
    const docs = [];
    for (let i = 1; i <= 312; i += 1) {
      docs.push({
        id: i,
        pathname: `post-slug-${i}`,
        content: `${filler}-${i}`,
        deleted: false,
        hidden: false,
        viewer: 0,
        visited: 0,
      });
    }
    await articleModel.collection.insertMany(docs as any);
    // 与真实 Article schema 对齐的索引（id/pathname 都是 indexed —— 没有它们时
    // 两种查询都退化成 COLLSCAN，投影的收益会被全表扫的常数盖住，量出来不代表生产形状）
    await articleModel.collection.createIndex({ id: 1 }, { name: 'id_1' });
    await articleModel.collection.createIndex({ pathname: 1 }, { name: 'pathname_1' });
    await metaModel.collection.insertOne({ viewer: 0, visited: 0, siteInfo: { authorEmail: '' } } as any);
  });

  afterAll(async () => {
    if (conn) {
      await conn.db.dropDatabase();
      await conn.close();
    }
  });

  // -------------------------------------------------------------------------
  // B2：蜜罐评论的 DB 真值（先跑，comments 集合此时是干净的）
  // -------------------------------------------------------------------------

  it('B2：12 条正常 + 60 条 hp —— spam 被限流封顶在 10 条（修复前是 60/60 全入库）', async () => {
    __resetAttemptLimitForTest();
    const provider = new CommentProvider(
      commentModel as any,
      articleModel as any,
      metaModel as any,
      settingProvider,
    );
    let okNormal = 0;
    let rejectedNormal = 0;
    for (let i = 0; i < 12; i += 1) {
      try {
        await provider.create({ path: '/post/7', nick: 'human', content: `normal-comment-${i}` } as any, req('203.0.113.70'));
        okNormal += 1;
      } catch {
        rejectedNormal += 1;
      }
    }
    let okSpam = 0;
    let rejectedSpam = 0;
    for (let i = 0; i < 60; i += 1) {
      try {
        await provider.create({ path: '/post/7', nick: 'bot', content: `spam-comment-${i}`, hp: 'x' } as any, req('203.0.113.71'));
        okSpam += 1;
      } catch {
        rejectedSpam += 1;
      }
    }
    expect(okNormal).toBe(10); // rateLimitPer10Min=10
    expect(rejectedNormal).toBe(2);
    expect(okSpam).toBe(10); // ← 修复前这里是 60
    expect(rejectedSpam).toBe(50);
    const counts = await provider.countByStatus();
    // eslint-disable-next-line no-console
    console.log(`[B2] DB 真值 by status = ${JSON.stringify(counts)}`);
    expect(counts).toEqual({ pending: 0, approved: 10, spam: 10, deleted: 0 });
    // 修复前的活体基线（审计记录）：{approved: 10, spam: 60}
    __resetAttemptLimitForTest();
  });

  // -------------------------------------------------------------------------
  // R4-13：投影前后的查询耗时
  // -------------------------------------------------------------------------

  it('R4-13：{id:1,pathname:1,_id:0} 投影 —— 50 个 id 的 $in 查询，中位数 9 轮', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const old: number[] = [];
    const neu: number[] = [];
    const t = () => performance.now(); // ms（小数精度；Date.now 的 1ms 粒度会吃掉投影的收益）
    for (let round = 0; round < 9; round += 1) {
      let t0 = t();
      const oldRows = await articleModel.find({ id: { $in: ids } }).exec();
      old.push(t() - t0);
      t0 = t();
      const newRows = await articleModel.find({ id: { $in: ids } }, { id: 1, pathname: 1, _id: 0 }).exec();
      neu.push(t() - t0);
      expect(oldRows.length).toBe(50);
      expect(newRows.length).toBe(50);
      // 投影只裁字段，不动结果集
      expect(newRows.map((r: any) => r.id)).toEqual(oldRows.map((r: any) => r.id));
      expect((newRows[0] as any).content).toBeUndefined();
    }
    const oldMs = median(old);
    const newMs = median(neu);
    // eslint-disable-next-line no-console
    console.log(
      `[R4-13] find 50 ids（id 有索引，312×20KB 语料）无投影=${oldMs.toFixed(2)}ms 投影=${newMs.toFixed(2)}ms ` +
        `提速=${(oldMs / Math.max(newMs, 0.01)).toFixed(1)}×（审计基线 19.7→1.4ms=14×，本机 mongod 7.0.14）`,
    );
    expect(newMs).toBeLessThan(oldMs);
    expect(oldMs / Math.max(newMs, 0.01)).toBeGreaterThan(2.5);

    // 走真实 provider 的 expandPostPaths：展开语义不变，且确实带着投影跑
    const provider = new CommentProvider(commentModel as any, articleModel as any, metaModel as any, settingProvider);
    const paths = ids.slice(0, 50).map((i) => `/post/${i}`);
    const t1 = Date.now();
    const expanded = await (provider as any).expandPostPaths(paths);
    const expandMs = Date.now() - t1;
    expect(expanded.size).toBe(50);
    expect(expanded.get('/post/1')).toEqual(
      expect.arrayContaining(['/post/1', '/post/post-slug-1']),
    );
    // eslint-disable-next-line no-console
    console.log(`[R4-13] expandPostPaths(50 paths) 全函数=${expandMs}ms`);
  });

  // -------------------------------------------------------------------------
  // B8：children 查询（20,000 条回复）与复合索引
  // -------------------------------------------------------------------------

  it('B8：20,000 条回复的根评论 —— 复合索引 + .limit(100) 前后的查询成本', async () => {
    const ROOT = 900001;
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    const root = {
      id: ROOT, path: '/post/b8', rootId: 0, parentId: 0, status: 'approved',
      nick: 'root', content: 'root-comment', createdAt: new Date(base), updatedAt: new Date(base),
    };
    await commentModel.collection.insertOne(root as any);
    const CHUNK = 5000;
    for (let c = 0; c < 20000; c += CHUNK) {
      const rows = [];
      for (let i = c; i < c + CHUNK; i += 1) {
        rows.push({
          id: 1000000 + i, path: '/post/b8', rootId: ROOT, parentId: ROOT, status: 'approved',
          nick: `r${i}`, content: `reply-${i}`, createdAt: new Date(base + (i + 1) * 1000),
          updatedAt: new Date(base + (i + 1) * 1000),
        });
      }
      await commentModel.collection.insertMany(rows as any);
    }
    const filter = { path: '/post/b8', rootId: { $in: [ROOT] }, status: 'approved' };
    const sort = { createdAt: 1, id: 1 } as const;

    // ---- 修复前的形状：无复合索引、无 limit ----
    const oldIndexes = await commentModel.collection.indexes();
    expect(oldIndexes.some((i: any) => i.name === COMMENT_LIST_INDEX_NAME)).toBe(false);
    let t0 = Date.now();
    const oldRows = await commentModel.collection.find(filter).sort(sort).toArray();
    const oldMs = Date.now() - t0;
    const oldExplain: any = await commentModel.collection.find(filter).sort(sort).explain('executionStats');
    const oldExamined = oldExplain?.executionStats?.totalDocsExamined;
    const oldHasSortStage = JSON.stringify(oldExplain?.executionStats?.executionStages || oldExplain?.queryPlanner?.winningPlan).includes('SORT');
    expect(oldRows.length).toBe(20000);

    // ---- 建复合索引（与 CommentProvider.ensureListIndex 同一键与名字；计时）----
    t0 = Date.now();
    await commentModel.collection.createIndex(COMMENT_LIST_INDEX_KEYS, {
      name: COMMENT_LIST_INDEX_NAME,
      background: true,
    });
    const indexMs = Date.now() - t0;
    // 幂等：同键同名重跑是 no-op
    t0 = Date.now();
    await commentModel.collection.createIndex(COMMENT_LIST_INDEX_KEYS, {
      name: COMMENT_LIST_INDEX_NAME,
      background: true,
    });
    const indexAgainMs = Date.now() - t0;

    // ---- 修复后的形状：复合索引 + .limit(MAX_CHILDREN_PER_ROOT × roots.length) ----
    t0 = Date.now();
    const newRows = await commentModel.collection.find(filter).sort(sort).limit(100).toArray();
    const newMs = Date.now() - t0;
    const newExplain: any = await commentModel.collection.find(filter).sort(sort).limit(100).explain('executionStats');
    const newExamined = newExplain?.executionStats?.totalDocsExamined;
    const newKeys = newExplain?.executionStats?.totalKeysExamined;
    const newHasSortStage = JSON.stringify(newExplain?.executionStats?.executionStages || newExplain?.queryPlanner?.winningPlan).includes('SORT');
    expect(newRows.length).toBe(100);
    // 修复后拿到的正是修复前结果集的前 100 条（全局 (createdAt,id) 排序语义不变）
    expect(newRows.map((r: any) => r.id)).toEqual(oldRows.slice(0, 100).map((r: any) => r.id));

    // ---- 根评论分页的最深 skip（page=500 ⇒ skip 24,950）----
    t0 = Date.now();
    const deep = await commentModel.collection
      .find({ path: '/post/b8', rootId: 0, status: 'approved' })
      .sort({ createdAt: -1, id: -1 })
      .skip(24950)
      .limit(50)
      .toArray();
    const deepMs = Date.now() - t0;
    expect(deep.length).toBe(0);

    // eslint-disable-next-line no-console
    console.log(
      `[B8] children 20k 回复：修复前 ${oldMs}ms / docsExamined=${oldExamined} / 内存SORT=${oldHasSortStage}` +
        ` → 修复后(复合索引+limit100) ${newMs}ms / docsExamined=${newExamined} / keysExamined=${newKeys} / SORT=${newHasSortStage}` +
        `；建索引 ${indexMs}ms（幂等重跑 ${indexAgainMs}ms）；page=500 最深 skip ${deepMs}ms`,
    );
    expect(oldExamined).toBeGreaterThanOrEqual(20000);
    expect(newExamined).toBeLessThan(2000); // limit(100) + 排序键全在索引里 ⇒ FETCH 只剩要的那些
    expect(newMs).toBeLessThan(oldMs);
  });

  // -------------------------------------------------------------------------
  // B3：编造路径的行数增长（旧行为 vs 每日上限）+ 默认保留期
  // -------------------------------------------------------------------------

  it('B3：500 个编造路径 —— 不限时 visits +500 行（≈157B/行），上限 100 时只 +100 行，metas.viewer 两边都分毫不差', async () => {
    const mkProvider = () =>
      new ViewStatsProvider(metaModel as any, articleModel as any, viewerModel as any, visitModel as any);

    // ---- Phase A：VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY=0（旧行为 = 不限）----
    process.env.VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY = '0';
    // driver 6 的 Collection 没有 .stats()（statsMaintenance 里那处也是 try/catch 兜底的），
    // 用 db.command({collStats}) 直接取
    const collStats = async () => {
      try {
        return (await conn.db.command({ collStats: 'visits' })) as any;
      } catch {
        return null;
      }
    };
    const statsA0 = await collStats();
    const rowsA0 = await conn.db.collection('visits').countDocuments({});
    const unlimited = mkProvider();
    for (let i = 0; i < 500; i += 1) {
      await unlimited.record({ pathname: `/fake-page-number-${i}`, isNewVisitor: true, isNewForPath: true });
    }
    await unlimited.flush('e2e-A');
    const rowsA1 = await conn.db.collection('visits').countDocuments({});
    const statsA1 = await collStats();
    const metaA = await metaModel.collection.findOne({});
    expect(rowsA1 - rowsA0).toBe(500); // ← 审计复现：每个编造路径一行
    expect((metaA as any).viewer).toBe(500);
    // db.command({collStats}) 的未压缩文档字节数在 `size` 字段（shell 里叫 dataSize）
    const bytesPerRow =
      statsA0 && statsA1 && Number.isFinite(statsA1.size) && Number.isFinite(statsA0.size)
        ? Math.round((statsA1.size - statsA0.size) / 500)
        : -1;

    // ---- Phase B：每日上限 100（比默认 5000 更小的值，量具跑得快）----
    process.env.VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY = '100';
    const capped = mkProvider();
    for (let i = 0; i < 500; i += 1) {
      await capped.record({ pathname: `/fake-page-b-${i}`, isNewVisitor: true, isNewForPath: true });
    }
    await capped.flush('e2e-B');
    const rowsB = await conn.db.collection('visits').countDocuments({ pathname: { $regex: '^/fake-page-b-' } });
    const metaB: any = await metaModel.collection.findOne({});
    // eslint-disable-next-line no-console
    console.log(
      `[B3] 500 编造路径：不限=${rowsA1 - rowsA0} 行（size +${
        statsA0 && statsA1 && Number.isFinite(statsA1.size) && Number.isFinite(statsA0.size)
          ? statsA1.size - statsA0.size
          : '?'
      } B，≈${bytesPerRow} B/行，审计基线 157）；上限100=${rowsB} 行；` +
        `metas.viewer=${metaB.viewer}（两轮 1000 次浏览一条不丢）`,
    );
    expect(rowsB).toBe(100); // ← 磁盘侧被封住
    expect(metaB.viewer).toBe(1000); // ← 站点级累计一条不丢（含被丢掉路径明细的那 400 次）
    expect(metaB.visited).toBe(1000);
    // 每日快照也不丢：viewers 今天的行 = metas 累计值
    const today = dayjs().format('YYYY-MM-DD');
    const snap: any = await viewerModel.collection.findOne({ date: today });
    expect(snap.viewer).toBe(1000);
    delete process.env.VANBLOG_VIEW_MAX_NEW_PATHS_PER_DAY;
  });

  it('B3(a)：默认保留期 365 天在真实 BSON 上生效：删 400 天前的行，date 为 null/缺失与窗口内的都不动', async () => {
    const today = dayjs().format('YYYY-MM-DD');
    const ancient = dayjs().subtract(400, 'day').format('YYYY-MM-DD');
    await conn.db.collection('visits').insertMany([
      { date: ancient, pathname: '/b3-ancient', viewer: 9, visited: 9 },
      { date: today, pathname: '/b3-today', viewer: 1, visited: 1 },
      { pathname: '/b3-no-date', viewer: 5, visited: 5 },
    ] as any);
    await conn.db.collection('visits').updateOne({ pathname: '/b3-no-date' }, { $set: { date: null } });

    delete process.env.VANBLOG_VISIT_RETENTION_DAYS;
    const maintenance = new StatsMaintenanceProvider(visitModel as any, viewerModel as any);
    expect(maintenance.retentionDays).toBe(365); // 默认值就是修复本身
    const res = await maintenance.pruneStats('e2e-量具');
    expect(res.enabled).toBe(true);
    expect(res.effectiveDays).toBe(365);
    // 删掉的只有 /b3-ancient 一行（Phase A/B 的行都是今天的）
    expect(await conn.db.collection('visits').countDocuments({ pathname: '/b3-ancient' })).toBe(0);
    expect(await conn.db.collection('visits').countDocuments({ pathname: '/b3-today' })).toBe(1);
    // date 为 null 的行必须活着（BSON 里 null < 任何字符串，只写 $lt 会把它一起删掉）
    expect(await conn.db.collection('visits').countDocuments({ pathname: '/b3-no-date' })).toBe(1);
    // 显式 0 = 旧默认（永不删除）的逃生口
    process.env.VANBLOG_VISIT_RETENTION_DAYS = '0';
    const off = new StatsMaintenanceProvider(visitModel as any, viewerModel as any);
    const offRes = await off.pruneStats('e2e-量具');
    expect(offRes).toMatchObject({ enabled: false, visits: 0, viewers: 0 });
    delete process.env.VANBLOG_VISIT_RETENTION_DAYS;
  });
});
