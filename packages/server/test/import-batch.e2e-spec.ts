/**
 * `visits` / `viewers` 的导入批量化 —— 在**真 mongod** 上跑的量具。
 *
 * 为什么要真库：这次的改动是"每条两次串行往返"→"每批一次 bulkWrite(upsert)"，
 * 关键问题只有真服务器能回答：
 *  1. `updateOne + upsert + ordered:true` 的结果与老的"findOne 再 update/insert"
 *     是否**逐字段相同**（含备份里没有 `createdAt` 时的默认值、以及备份里
 *     同一唯一键出现两行时的"先插后覆盖"语义）；
 *  2. 往返次数到底降了多少（用 mongod 自己的 `serverStatus().metrics.commands` 数，
 *     不是靠计时猜 —— 计时在负载高的机器上会抖）。
 *
 * ⚠️ 默认**整套跳过**（CI 上没有 mongod）。要跑就给一个**一次性库名**
 * （会 dropDatabase，代码里有硬护栏，绝不允许指向真实库）：
 *
 *   VANBLOG_IMPORT_BENCH_URL='mongodb://127.0.0.1:27017/vanblog_importbatch_scratch?directConnection=true' \
 *     ./node_modules/.bin/jest --config ./test/jest-import-batch.json
 */
import mongoose from 'mongoose';

import { VisitProvider } from 'src/provider/visit/visit.provider';
import { ViewerProvider } from 'src/provider/viewer/viewer.provider';
import { Visit, VisitSchema } from 'src/scheme/visit.schema';
import { Viewer, ViewerSchema } from 'src/scheme/viewer.schema';

const URL = process.env.VANBLOG_IMPORT_BENCH_URL || '';
const d = URL ? describe : describe.skip;

/** 与本机生产备份同量级：visits 8,770 条、viewers 800 条 */
const VISIT_ROWS = Number(process.env.VANBLOG_IMPORT_BENCH_VISITS || 8770);
const VIEWER_ROWS = Number(process.env.VANBLOG_IMPORT_BENCH_VIEWERS || 800);

/** 改动前的实现（逐字拷贝，作为参照物跑在同一个真库上） */
async function legacyVisitImport(model: mongoose.Model<any>, data: any[]) {
  for (const each of data) {
    const oldData = await model.findOne({ pathname: each.pathname, date: each.date });
    if (oldData) {
      await model.updateOne({ _id: oldData._id }, each);
    } else {
      const newData = new model(each);
      await newData.save();
    }
  }
}

async function legacyViewerImport(model: mongoose.Model<any>, data: any[]) {
  for (const each of data) {
    const oldData = await model.findOne({ date: each.date });
    if (oldData) {
      await model.updateOne({ _id: oldData._id }, each);
    } else {
      const newData = new model(each);
      await newData.save();
    }
  }
}

function makeVisits(n: number) {
  const out: any[] = [];
  const start = new Date('2024-07-07T00:00:00Z').getTime();
  for (let i = 0; i < n; i += 1) {
    const day = new Date(start + Math.floor(i / 11) * 86400000).toISOString().slice(0, 10);
    const doc: any = {
      date: day,
      pathname: `/post/${i % 11 === 0 ? 'about' : `slug-${i % 53}`}`,
      viewer: 100 + i,
      visited: 50 + i,
      lastVisitedTime: new Date(start + i * 1000),
    };
    // 九成的行带 createdAt（真实备份里都有），一成不带（考验 upsert 的默认值补齐）
    if (i % 10 !== 0) {
      doc.createdAt = new Date(start + i * 1000);
    }
    out.push(doc);
  }
  // 故意塞两行同 {date,pathname} 的重复数据：老库真有过（并发首访留下的），
  // 导入时"第一条插入、第二条覆盖"的语义必须在批量写法下保持不变
  out.push({ ...out[5], viewer: 999999, visited: 888888 });
  out.push({ ...out[5], viewer: 1, visited: 1 });
  return out;
}

function makeViewers(n: number) {
  const out: any[] = [];
  const start = new Date('2024-07-07T00:00:00Z').getTime();
  for (let i = 0; i < n; i += 1) {
    out.push({
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      viewer: 1000 + i * 3,
      visited: 500 + i * 2,
      ...(i % 10 === 0 ? {} : { createdAt: new Date(start + i * 1000) }),
    });
  }
  return out;
}

/**
 * 只比较业务字段：
 *  - `_id` 是各自生成的，不在比较范围内；
 *  - 备份里**没有** `createdAt` 的行，两条路径都是"插入那一刻"现生成的
 *    （老路走 schema 默认值，新路走 `$setOnInsert`），值必然差几十毫秒 ——
 *    这种行只比较"有没有"，不比较具体值；备份里**有** `createdAt` 的行必须逐毫秒相同。
 */
function normalize(rows: any[], autoCreatedKeys: Set<string>) {
  return rows
    .map((r) => {
      const key = `${r.date}|${r.pathname || ''}`;
      const auto = autoCreatedKeys.has(key);
      return {
        date: r.date,
        pathname: r.pathname,
        viewer: r.viewer,
        visited: r.visited,
        lastVisitedTime: r.lastVisitedTime ? new Date(r.lastVisitedTime).getTime() : null,
        createdAt: r.createdAt ? (auto ? 'auto' : new Date(r.createdAt).getTime()) : null,
      };
    })
    .sort((a, b) =>
      `${a.date}|${a.pathname || ''}`.localeCompare(`${b.date}|${b.pathname || ''}`),
    );
}

/** 备份里缺 createdAt 的那些行的键 */
function autoCreatedKeysOf(docs: any[]): Set<string> {
  const out = new Set<string>();
  for (const d of docs) {
    if (d && d.createdAt === undefined) {
      out.add(`${d.date}|${d.pathname || ''}`);
    }
  }
  return out;
}

/**
 * 逐行对拍，失败时只打印**第一处**差异。
 * ⚠️ 不要直接 `expect(JSON.stringify(a)).toBe(JSON.stringify(b))`：
 * 8770 行的 JSON 会把 jest 的输出撑到 2.6MB，真正的差异反而看不见。
 */
function expectSameRows(actual: any[], expected: any[], label: string) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const a = JSON.stringify(actual[i]);
    const b = JSON.stringify(expected[i]);
    if (a !== b) {
      throw new Error(`${label} 第 ${i} 行不一致：\n  批量=${a}\n  参照=${b}`);
    }
  }
}

/** 只统计数据面命令（心跳 / endSessions / 建索引都不算导入的开销） */
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

d('visits/viewers 导入批量化 against a real mongod', () => {
  jest.setTimeout(600000);
  let conn: mongoose.Connection;
  let visitModel: mongoose.Model<any>;
  let viewerModel: mongoose.Model<any>;
  let visitProvider: VisitProvider;
  let viewerProvider: ViewerProvider;
  const visits = makeVisits(VISIT_ROWS);
  const viewers = makeViewers(VIEWER_ROWS);
  const visitAutoKeys = autoCreatedKeysOf(visits);
  const viewerAutoKeys = autoCreatedKeysOf(viewers);

  /**
   * 命令计数走驱动的 `monitorCommands`（与 test/opscount.e2e-spec.ts 同一套办法）。
   * ⚠️ 不要用 `serverStatus().metrics.commands`：那是**全服务器**的累计值，
   * 本机同时跑着开发栈（每秒都有浏览统计在写），差值里全是别人的噪音，
   * 而且这台机器上取到的 find/update/insert 计数压根不动（实测差值 0）。
   */
  const recorded: string[] = [];
  let recording = false;
  const startRecording = () => {
    recorded.length = 0;
    recording = true;
  };
  const stopRecording = () => {
    recording = false;
    return recorded.length;
  };

  let dbName = '';
  beforeAll(async () => {
    dbName = URL.replace(/^[^/]*\/\/[^/]+\//, '').split('?')[0];
    if (
      !/^[A-Za-z0-9_-]+$/.test(dbName) ||
      /^(vanBlog|waline|admin|local|config|test)$/i.test(dbName) ||
      !/scratch|bench|tmp/i.test(dbName)
    ) {
      throw new Error(
        `VANBLOG_IMPORT_BENCH_URL 必须指向一次性临时库（库名里要有 scratch/bench/tmp，解析出 "${dbName}"），拒绝执行`,
      );
    }
    conn = mongoose.createConnection(URL, {
      serverSelectionTimeoutMS: 4000,
      autoIndex: false,
      monitorCommands: true,
    } as any);
    await conn.asPromise();
    const client = conn.getClient();
    client.on('commandStarted', (event: any) => {
      if (!recording) return;
      if (event.databaseName !== dbName) return;
      if (!DATA_COMMANDS.has(event.commandName)) return;
      recorded.push(event.commandName);
    });
    await conn.db.dropDatabase();
    visitModel = conn.model(Visit.name, VisitSchema);
    viewerModel = conn.model(Viewer.name, ViewerSchema);
    visitProvider = new VisitProvider(visitModel);
    viewerProvider = new ViewerProvider(viewerModel);
  });

  afterAll(async () => {
    if (conn) await conn.close();
  });

  let legacyVisits: any[] = [];
  let legacyViewers: any[] = [];
  let legacyCmds = { visits: 0, viewers: 0 };
  let batchedCmds = { visits: 0, viewers: 0 };
  let legacyMs = { visits: 0, viewers: 0 };
  let batchedMs = { visits: 0, viewers: 0 };

  it('参照组：改动前的串行导入（记录耗时与命令数）', async () => {
    await conn.db.collection('visits').deleteMany({});
    await conn.db.collection('viewers').deleteMany({});

    let t0 = Date.now();
    startRecording();
    await legacyVisitImport(visitModel, visits);
    legacyCmds.visits = stopRecording();
    legacyMs.visits = Date.now() - t0;
    legacyVisits = normalize(await conn.db.collection('visits').find({}).toArray(), visitAutoKeys);

    t0 = Date.now();
    startRecording();
    await legacyViewerImport(viewerModel, viewers);
    legacyCmds.viewers = stopRecording();
    legacyMs.viewers = Date.now() - t0;
    legacyViewers = normalize(await conn.db.collection('viewers').find({}).toArray(), viewerAutoKeys);

    // eslint-disable-next-line no-console
    console.log(
      `[参照组] visits ${visits.length} 条：${legacyCmds.visits} 次命令 / ${legacyMs.visits} ms；` +
        `viewers ${viewers.length} 条：${legacyCmds.viewers} 次命令 / ${legacyMs.viewers} ms`,
    );
    // 老写法每条至少 1 次 find + 1 次写
    expect(legacyCmds.visits).toBeGreaterThanOrEqual(visits.length * 2);
  });

  it('批量导入的结果与参照组逐字段相同（含缺 createdAt 与重复键两种边界）', async () => {
    await conn.db.collection('visits').deleteMany({});
    await conn.db.collection('viewers').deleteMany({});

    let t0 = Date.now();
    startRecording();
    await visitProvider.import(visits as any);
    batchedCmds.visits = stopRecording();
    batchedMs.visits = Date.now() - t0;
    const batchedVisits = normalize(await conn.db.collection('visits').find({}).toArray(), visitAutoKeys);

    t0 = Date.now();
    startRecording();
    await viewerProvider.import(viewers as any);
    batchedCmds.viewers = stopRecording();
    batchedMs.viewers = Date.now() - t0;
    const batchedViewers = normalize(await conn.db.collection('viewers').find({}).toArray(), viewerAutoKeys);

    expectSameRows(batchedVisits, legacyVisits, 'visits');
    expectSameRows(batchedViewers, legacyViewers, 'viewers');

    // eslint-disable-next-line no-console
    console.log(
      `[批量组] visits ${visits.length} 条：${batchedCmds.visits} 次命令 / ${batchedMs.visits} ms；` +
        `viewers ${viewers.length} 条：${batchedCmds.viewers} 次命令 / ${batchedMs.viewers} ms`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[结果] visits 命令数 ${legacyCmds.visits} → ${batchedCmds.visits}` +
        `（${(legacyCmds.visits / Math.max(1, batchedCmds.visits)).toFixed(1)}×），` +
        `耗时 ${legacyMs.visits} → ${batchedMs.visits} ms` +
        `（${(legacyMs.visits / Math.max(1, batchedMs.visits)).toFixed(1)}×）；` +
        `viewers 命令数 ${legacyCmds.viewers} → ${batchedCmds.viewers}，` +
        `耗时 ${legacyMs.viewers} → ${batchedMs.viewers} ms`,
    );
  });

  it('往返次数真的降了一个数量级（命令数 ≤ 批数 + 常数，而不是每条两次）', () => {
    const batches = Math.ceil(visits.length / 500);
    expect(batchedCmds.visits).toBeLessThanOrEqual(batches + 5);
    expect(batchedCmds.visits).toBeLessThan(legacyCmds.visits / 10);
    const viewerBatches = Math.ceil(viewers.length / 500);
    expect(batchedCmds.viewers).toBeLessThanOrEqual(viewerBatches + 5);
    expect(batchedCmds.viewers).toBeLessThan(legacyCmds.viewers / 10);
  });

  it('重复导入是幂等的（upsert + 绝对值 $set，再跑一遍结果不变）', async () => {
    const before = normalize(await conn.db.collection('visits').find({}).toArray(), visitAutoKeys);
    await visitProvider.import(visits as any);
    const after = normalize(await conn.db.collection('visits').find({}).toArray(), visitAutoKeys);
    expectSameRows(after, before, 'visits(重复导入)');
  });

  it('批量失败会回落到逐条写入，并且结果与批量一致（不让一条坏数据毁掉整次导入）', async () => {
    await conn.db.collection('visits').deleteMany({});
    const warn = jest.spyOn((visitProvider as any).logger, 'warn').mockImplementation(() => undefined);
    const realBulkWrite = visitModel.bulkWrite.bind(visitModel);
    let calls = 0;
    // 第一批就抛错，逼出回落路径
    (visitModel as any).bulkWrite = async (...args: any[]) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('模拟批量失败');
      }
      return realBulkWrite(...args);
    };
    try {
      await visitProvider.import(visits as any);
    } finally {
      (visitModel as any).bulkWrite = realBulkWrite;
    }
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('回落到逐条写入');
    const rows = normalize(await conn.db.collection('visits').find({}).toArray(), visitAutoKeys);
    expectSameRows(rows, legacyVisits, 'visits(回落路径)');
    warn.mockRestore();
  });
});
