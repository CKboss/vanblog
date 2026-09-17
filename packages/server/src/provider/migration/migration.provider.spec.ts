import { MigrationProvider, detailToString, DETAIL_MAX_CHARS } from './migration.provider';
import { MigrationController } from 'src/controller/admin/migration/migration.controller';
import {
  StatsMaintenanceProvider,
  LEDGER_KEYS,
  VISIT_UNIQUE_INDEX_NAME,
} from '../stats/statsMaintenance.provider';
import * as fs from 'fs';
import * as path from 'path';

/**
 * P1 迁移台账：
 *  - record() 的 upsert 形状（一个 key 一行、$inc runs、$setOnInsert firstRanAt、
 *    error 时 lastError/lastErrorAt 落盘 + WARN，绝不静默）；
 *  - record() 自己失败时绝不抛（台账不能把清洗带崩）；
 *  - run() 计时、成功记 ok、失败记 error 并**原样重抛**（调用方错误语义不变）；
 *  - warnAboutErrors 点名所有 error 条目；
 *  - 控制器信封 {statusCode,data} 与字段契约；
 *  - statsMaintenance 的接线：跳过/执行两条路都会记账（负控：把 recording 拆掉这些断言全红）。
 */

type Doc = Record<string, any>;

function createFakeMigrationModel(initial: Doc[] = []) {
  const docs: Doc[] = initial.map((d) => ({ ...d }));
  const calls: Array<{ filter: Doc; update: Doc; options: Doc }> = [];
  const matches = (doc: Doc, filter: Doc) =>
    Object.entries(filter).every(([k, v]) => doc[k] === v);
  const model: any = {
    docs,
    calls,
    failNextWrite: false,
    updateOne: jest.fn(async (filter: Doc, update: Doc, options: Doc = {}) => {
      calls.push({ filter, update, options });
      if (model.failNextWrite) {
        model.failNextWrite = false;
        throw new Error('mongo 抖动（测试注入）');
      }
      let doc = docs.find((d) => matches(d, filter));
      if (!doc) {
        if (!options.upsert) {
          return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
        }
        doc = { _id: `oid-${docs.length + 1}`, ...filter };
        docs.push(doc);
      }
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          doc[k] = Number(doc[k] || 0) + Number(v);
        }
      }
      if (update.$setOnInsert) {
        for (const [k, v] of Object.entries(update.$setOnInsert)) {
          if (doc[k] === undefined) doc[k] = v;
        }
      }
      return { matchedCount: 1, modifiedCount: 1, upsertedId: doc._id };
    }),
    find: jest.fn((filter: Doc = {}, projection?: Doc) => {
      const q = filter?.outcome ? docs.filter((d) => d.outcome === filter.outcome) : [...docs];
      const chain: any = {
        sort: () => chain,
        exec: async () =>
          q.map((d) => (projection ? { ...d, _projected: true } : { ...d })),
      };
      return chain;
    }),
  };
  return model;
}

describe('MigrationProvider.record', () => {
  it('一个 key 只有一行：upsert + $inc runs + $setOnInsert firstRanAt', async () => {
    const model = createFakeMigrationModel();
    const provider = new MigrationProvider(model);
    await provider.record({
      key: 'wash:test',
      kind: 'wash',
      outcome: 'ok',
      durationMs: 12,
      detail: { changed: 2 },
    });
    await provider.record({
      key: 'wash:test',
      kind: 'wash',
      outcome: 'ok',
      durationMs: 7,
      detail: 'second run',
    });
    expect(model.docs).toHaveLength(1);
    const doc = model.docs[0];
    expect(doc.key).toBe('wash:test');
    expect(doc.runs).toBe(2);
    expect(doc.detail).toBe('second run');
    expect(doc.durationMs).toBe(7);
    expect(doc.firstRanAt).toBeInstanceOf(Date);
    // 两次都必须是真的 upsert（唯一索引在 key 上，见 migration.schema.ts）
    expect(model.calls.every((c: any) => c.options.upsert === true)).toBe(true);
    expect(model.calls.every((c: any) => c.filter.key === 'wash:test')).toBe(true);
    expect(model.calls[0].update.$setOnInsert.firstRanAt).toBeInstanceOf(Date);
  });

  it('outcome=error 时写 lastError/lastErrorAt 并且 WARN（绝不静默）', async () => {
    const model = createFakeMigrationModel();
    const provider = new MigrationProvider(model);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    await provider.record({
      key: 'index:x',
      kind: 'index',
      outcome: 'error',
      durationMs: 3,
      detail: 'E11000 duplicate key',
    });
    const doc = model.docs[0];
    expect(doc.outcome).toBe('error');
    expect(doc.lastError).toBe('E11000 duplicate key');
    expect(doc.lastErrorAt).toBeInstanceOf(Date);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('index:x');
    warn.mockRestore();
  });

  it('成功不会清掉历史失败（lastError 保留），但 outcome 变回 ok', async () => {
    const model = createFakeMigrationModel();
    const provider = new MigrationProvider(model);
    jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    await provider.record({ key: 'k', kind: 'wash', outcome: 'error', durationMs: 1, detail: 'boom' });
    await provider.record({ key: 'k', kind: 'wash', outcome: 'ok', durationMs: 1, detail: 'fine' });
    expect(model.docs).toHaveLength(1);
    expect(model.docs[0].outcome).toBe('ok');
    expect(model.docs[0].lastError).toBe('boom');
    expect(model.docs[0].runs).toBe(2);
  });

  it('台账写入失败绝不抛、绝不把清洗带崩（只 WARN）', async () => {
    const model = createFakeMigrationModel();
    const provider = new MigrationProvider(model);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    model.failNextWrite = true;
    await expect(
      provider.record({ key: 'k', kind: 'wash', outcome: 'ok', durationMs: 1 }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('写迁移台账失败');
    warn.mockRestore();
  });

  it('detail 截断到 DETAIL_MAX_CHARS（台账不存大对象）', () => {
    const long = 'x'.repeat(DETAIL_MAX_CHARS + 500);
    const text = detailToString({ long });
    expect(text.length).toBeLessThan(long.length);
    expect(text).toContain('截断');
    expect(detailToString('short')).toBe('short');
    expect(detailToString(undefined)).toBe('');
    const circular: any = { name: 'loop' };
    circular.self = circular;
    expect(typeof detailToString(circular)).toBe('string'); // JSON 失败退化为 String()，不抛
  });
});

describe('MigrationProvider.run', () => {
  it('成功：返回任务结果，记 ok + detail(result) + durationMs', async () => {
    const model = createFakeMigrationModel();
    const provider = new MigrationProvider(model);
    const result = await provider.run(
      { key: 'wash:x', kind: 'wash' },
      async () => ({ washed: 3 }),
      { detail: (r) => r },
    );
    expect(result).toEqual({ washed: 3 });
    expect(model.docs[0].outcome).toBe('ok');
    expect(model.docs[0].detail).toBe(JSON.stringify({ washed: 3 }));
    expect(typeof model.docs[0].durationMs).toBe('number');
    expect(model.docs[0].codeVersion).toBeTruthy();
  });

  it('失败：记 error 并**原样重抛**（调用方今天的错误语义一个字不变）', async () => {
    const model = createFakeMigrationModel();
    const provider = new MigrationProvider(model);
    jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const boom = new Error('清洗炸了');
    await expect(
      provider.run({ key: 'wash:x', kind: 'wash' }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom); // 必须是同一个错误对象，不许包装
    expect(model.docs[0].outcome).toBe('error');
    expect(model.docs[0].lastError).toBe('清洗炸了');
  });

  it('recordSkipped 记 skipped 且 durationMs=0', async () => {
    const model = createFakeMigrationModel();
    const provider = new MigrationProvider(model);
    await provider.recordSkipped({ key: 'k', kind: 'index' }, '已存在');
    expect(model.docs[0]).toMatchObject({ outcome: 'skipped', durationMs: 0, detail: '已存在' });
  });
});

describe('MigrationProvider.warnAboutErrors', () => {
  it('点名所有 outcome=error 的 key 并 WARN', async () => {
    const model = createFakeMigrationModel([
      { key: 'a', outcome: 'error', lastError: 'boom-a' },
      { key: 'b', outcome: 'ok' },
      { key: 'c', outcome: 'error', lastError: 'boom-c' },
    ]);
    const provider = new MigrationProvider(model);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const keys = await provider.warnAboutErrors('启动后检查');
    expect(keys.sort()).toEqual(['a', 'c']);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('a（boom-a）');
    expect(message).toContain('c（boom-c）');
    warn.mockRestore();
  });

  it('读库失败返回 [] 且 WARN，不抛', async () => {
    const model = createFakeMigrationModel();
    model.find.mockImplementation(() => {
      throw new Error('读不了');
    });
    const provider = new MigrationProvider(model);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    await expect(provider.warnAboutErrors('x')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('MigrationController（后台读台账）', () => {
  it('标准 {statusCode,data} 信封 + 契约字段（不吐 _id/__v 之外的内部结构）', async () => {
    const ranAt = new Date('2026-09-17T00:00:00Z');
    const rows = [
      {
        toObject: () => ({
          _id: 'oid',
          key: 'wash:test',
          kind: 'wash',
          ranAt,
          durationMs: 5,
          outcome: 'ok',
          detail: '{"changed":1}',
          codeVersion: 'dev',
          runs: 3,
          firstRanAt: ranAt,
          lastError: '',
          lastErrorAt: null,
          __v: 0,
        }),
      },
    ];
    const controller = new MigrationController({ list: async () => rows } as any);
    const res: any = await controller.list();
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual([
      {
        key: 'wash:test',
        kind: 'wash',
        ranAt,
        durationMs: 5,
        outcome: 'ok',
        detail: '{"changed":1}',
        codeVersion: 'dev',
        runs: 3,
        firstRanAt: ranAt,
        lastError: '',
        lastErrorAt: null,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// statsMaintenance 的台账接线（真实现 + 假 mongo + 假 recorder）
// ---------------------------------------------------------------------------

function createStatsFakeCollection(indexes: Doc[]) {
  const state = { indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }, ...indexes] };
  const collection: any = {
    indexes: async () => state.indexes.map((i) => ({ ...i })),
    createIndex: async (keys: Doc, options: any = {}) => {
      state.indexes.push({ v: 2, key: keys, name: options.name, unique: options.unique });
      return options.name;
    },
    dropIndex: async (name: string) => {
      state.indexes = state.indexes.filter((i) => i.name !== name);
      return true;
    },
    stats: async () => ({ totalIndexSize: 1 }),
  };
  return { state, collection };
}

function createStatsModels(options: { visitsUnique?: boolean } = {}) {
  const visitIndexes = options.visitsUnique
    ? [{ v: 2, key: { date: 1, pathname: 1 }, name: VISIT_UNIQUE_INDEX_NAME, unique: true }]
    : [];
  const visits = createStatsFakeCollection(visitIndexes);
  const viewers = createStatsFakeCollection([{ v: 2, key: { date: 1 }, name: 'date_1', unique: true }]);
  const makeModel = (fake: ReturnType<typeof createStatsFakeCollection>) =>
    ({
      collection: fake.collection,
      aggregate: () => ({ allowDiskUse: () => ({ exec: async () => [] }) }),
      find: () => ({ lean: () => ({ exec: async () => [] }) }),
      updateOne: () => ({ exec: async () => ({ matchedCount: 1, modifiedCount: 1 }) }),
      deleteMany: () => ({ exec: async () => ({ deletedCount: 0 }) }),
    }) as any;
  return { visitModel: makeModel(visits), viewerModel: makeModel(viewers), visits, viewers };
}

function createFakeRecorder() {
  const entries: Doc[] = [];
  return {
    entries,
    recorder: {
      record: jest.fn(async (entry: Doc) => {
        entries.push({ ...entry });
      }),
      recordSkipped: jest.fn(async (spec: Doc, detail?: unknown) => {
        entries.push({ ...spec, outcome: 'skipped', durationMs: 0, detail });
      }),
      run: jest.fn(async (_spec: Doc, task: () => Promise<any>) => task()),
      list: jest.fn(async () => []),
      warnAboutErrors: jest.fn(async () => []),
    } as any,
  };
}

describe('StatsMaintenanceProvider × 迁移台账', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('常态（唯一索引已存在）：dedupe 与两个索引都记 skipped，一行数据不动', async () => {
    const { visitModel, viewerModel } = createStatsModels({ visitsUnique: true });
    const { recorder, entries } = createFakeRecorder();
    const provider = new StatsMaintenanceProvider(visitModel, viewerModel, recorder);
    await provider.runStartupMaintenance('测试');
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey[LEDGER_KEYS.dedupeVisits].outcome).toBe('skipped');
    expect(byKey[LEDGER_KEYS.visitsUniqueIndex].outcome).toBe('skipped');
    expect(byKey[LEDGER_KEYS.viewersUniqueIndex].outcome).toBe('skipped');
    expect(byKey[LEDGER_KEYS.dropRedundant].outcome).toBe('skipped');
  });

  it('首次收敛（无唯一索引）：dedupe 记 ok、索引记 ok(created)，kind 正确', async () => {
    const { visitModel, viewerModel, viewers } = createStatsModels({ visitsUnique: false });
    const { recorder, entries } = createFakeRecorder();
    const provider = new StatsMaintenanceProvider(visitModel, viewerModel, recorder);
    await provider.runStartupMaintenance('测试');
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey[LEDGER_KEYS.dedupeVisits]).toMatchObject({ outcome: 'ok', kind: 'wash' });
    expect(byKey[LEDGER_KEYS.visitsUniqueIndex]).toMatchObject({ outcome: 'ok', kind: 'index' });
    // 假 recorder 存的是原始 entry（detail 还是对象）；真 provider 会 detailToString 成 JSON，
    // 那个形状由上面 MigrationProvider.record 的用例钉住
    expect(byKey[LEDGER_KEYS.visitsUniqueIndex].detail).toMatchObject({ created: true });
    // viewers 的假索引里已有唯一 date_1 → skipped（负控：如果接线断了，entries 是空的）
    expect(byKey[LEDGER_KEYS.viewersUniqueIndex].outcome).toBe('skipped');
    expect(viewers.state.indexes.some((i: any) => i.name === 'date_1')).toBe(true);
    expect(recorder.record).toHaveBeenCalled();
  });

  it('pruneStats 默认（保留期未启用）记 skipped，绝不删行', async () => {
    // ⚠️ env 必须在构造 provider **之前**清掉：retentionDays 是构造期读的 readonly 字段
    delete process.env.VANBLOG_VISIT_RETENTION_DAYS;
    const { visitModel, viewerModel } = createStatsModels({ visitsUnique: true });
    const { recorder, entries } = createFakeRecorder();
    const provider = new StatsMaintenanceProvider(visitModel, viewerModel, recorder);
    const result = await provider.pruneStats('测试');
    expect(result.enabled).toBe(false);
    const prune = entries.find((e) => e.key === LEDGER_KEYS.pruneStats);
    expect(prune).toBeDefined();
    expect(prune.outcome).toBe('skipped');
    expect(prune.kind).toBe('prune');
  });

  it('没有注入台账时行为与从前一致（可选注入，不抛）', async () => {
    const { visitModel, viewerModel } = createStatsModels({ visitsUnique: true });
    const provider = new StatsMaintenanceProvider(visitModel, viewerModel);
    const result = await provider.runStartupMaintenance('测试');
    expect(result.dedup.skipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// main.ts 接线钉住（源码级）：五个启动清洗都必须包进台账，且台账绝不反过来当跳过闸门
// ---------------------------------------------------------------------------

describe('main.ts 的台账接线（源码级钉子）', () => {
  // ⚠️ repoRoot 数法：__dirname = packages/server/src/provider/migration，
  // 上 **3** 级到 packages/server（migration→provider→src→server），再接 src/main.ts。
  // （AGENTS §7.56 记过这个 off-by-one 坑，这里把数法写出来。）
  const mainTs = fs.readFileSync(
    path.resolve(__dirname, '../../../src/main.ts'),
    'utf8',
  );

  it('每个启动清洗都用 wash(key, kind, task) 包了一层', () => {
    for (const key of [
      'wash:staticSetting',
      'wash:customPageType',
      'wash:categoryFromMeta',
      'wash:userSalt',
      'wash:defaultMenu',
    ]) {
      expect(mainTs).toContain(`'${key}', 'wash'`);
    }
    // 启动期的总字数重算走 updateTotalWords 的 migration 选项
    expect(mainTs).toContain("key: 'recompute:totalWords', kind: 'recompute'");
  });

  it('台账缺失时清洗照跑（app.get 包在 try/catch 里，绝不因台账让启动挂掉）', () => {
    expect(mainTs).toContain('app.get(MigrationProvider)');
    expect(mainTs).toMatch(/try \{\s*migrations = app\.get\(MigrationProvider\);\s*\} catch \{/);
  });

  it('绝不按台账跳过清洗：main.ts 里不存在"读了台账再决定跑不跑"的调用', () => {
    // 负控钉子：如果有人以后写了 `if (await ledgerDone(key)) skip`，这条会红。
    expect(mainTs).not.toMatch(/warnAboutErrors\([^)]*\)\s*\)?\s*(\.then)?\([^)]*skip/i);
    expect(mainTs).not.toContain('migrations.list()');
    // wash() 帮助函数在台账缺失时直接跑任务（而不是跳过）
    expect(mainTs).toContain('return task();');
  });
});
