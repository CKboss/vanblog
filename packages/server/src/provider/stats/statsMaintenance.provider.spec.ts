import { StatsMaintenanceProvider } from './statsMaintenance.provider';

/**
 * 统计表维护：去重合并 → 建唯一索引 → 按保留期清理。
 *
 * 用一个内存假 Mongo（能报索引列表、能建/删索引、能跑那条固定的去重 aggregate）
 * 把三件事的行为钉住：
 *  - **幂等**：已经建好唯一索引时整轮只花一次 listIndexes，一行数据都不动；
 *  - **顺序**：先去重再建索引（反过来 createIndex 必然 E11000 失败）；
 *  - **不在请求路径上**：启动钩子 fire-and-forget，且只跑一次；
 *  - **保留期默认关**：`VANBLOG_VISIT_RETENTION_DAYS` 不给值时一行都不删。
 */

type Doc = Record<string, any>;

function createFakeCollection(name: string, docs: Doc[] = [], indexes: Doc[] = []) {
  const state = {
    docs,
    indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }, ...indexes],
    log: [] as string[],
  };
  const collection: any = {
    collectionName: name,
    indexes: async () => {
      state.log.push(`${name}.indexes`);
      return state.indexes.map((i) => ({ ...i }));
    },
    createIndex: async (keys: Doc, options: any = {}) => {
      state.log.push(`${name}.createIndex(${JSON.stringify(keys)},unique=${!!options.unique})`);
      const clash = state.indexes.find(
        (i) => i.name === options.name && JSON.stringify(i.key) !== JSON.stringify(keys),
      );
      if (clash) throw new Error(`Index with name: ${options.name} already exists with a different name`);
      state.indexes.push({ v: 2, key: keys, name: options.name, unique: options.unique });
      return options.name;
    },
    dropIndex: async (indexName: string) => {
      state.log.push(`${name}.dropIndex(${indexName})`);
      const before = state.indexes.length;
      state.indexes = state.indexes.filter((i) => i.name !== indexName);
      if (state.indexes.length === before) throw new Error(`index not found with name [${indexName}]`);
      return true;
    },
    stats: async () => {
      state.log.push(`${name}.stats`);
      return { totalIndexSize: state.indexes.length * 40960 };
    },
  };
  return { state, collection };
}

function createFake(options: {
  visitDocs?: Doc[];
  viewerDocs?: Doc[];
  visitIndexes?: Doc[];
  viewerIndexes?: Doc[];
  env?: Record<string, string | undefined>;
}) {
  const visits = createFakeCollection('visits', options.visitDocs ?? [], options.visitIndexes ?? []);
  const viewers = createFakeCollection(
    'viewers',
    options.viewerDocs ?? [],
    options.viewerIndexes ?? [],
  );
  const opLog: string[] = [];
  const deleted: Doc[] = [];

  const makeModel = (fake: ReturnType<typeof createFakeCollection>, kind: string) => {
    const model: any = {
      collection: fake.collection,
      aggregate: (pipeline: Doc[]) => ({
        allowDiskUse: () => ({
          exec: async () => {
            opLog.push(`${kind}.aggregate`);
            // 只实现去重那一条管道：group by {date,pathname} + match n>1
            const groups = new Map<string, Doc[]>();
            for (const doc of fake.state.docs) {
              const key = JSON.stringify([doc.date, doc.pathname]);
              groups.set(key, [...(groups.get(key) || []), doc]);
            }
            return [...groups.values()]
              .filter((g) => g.length > 1)
              .map((g) => ({ _id: { date: g[0].date, pathname: g[0].pathname }, n: g.length }));
          },
        }),
      }),
      find: (filter: Doc) => ({
        lean: () => ({
          exec: async () => {
            opLog.push(`${kind}.find`);
            return fake.state.docs.filter(
              (d) => d.date === filter.date && d.pathname === filter.pathname,
            );
          },
        }),
      }),
      updateOne: (filter: Doc, update: Doc) => ({
        exec: async () => {
          opLog.push(`${kind}.updateOne`);
          const doc = fake.state.docs.find((d) => String(d._id) === String(filter._id));
          if (doc && update.$set) Object.assign(doc, update.$set);
          return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
        },
      }),
      deleteMany: (filter: Doc) => ({
        exec: async () => {
          opLog.push(`${kind}.deleteMany`);
          if (filter._id?.$in) {
            const ids = filter._id.$in.map(String);
            const before = fake.state.docs.length;
            fake.state.docs = fake.state.docs.filter((d) => !ids.includes(String(d._id)));
            return { deletedCount: before - fake.state.docs.length };
          }
          // 保留期那一条：{date: {$gte, $lt}}
          const range = filter.date as any;
          const before = fake.state.docs.length;
          const removed = fake.state.docs.filter(
            (d) =>
              typeof d.date === 'string' &&
              (!range.$gte || d.date >= range.$gte) &&
              (!range.$lt || d.date < range.$lt),
          );
          deleted.push(...removed);
          fake.state.docs = fake.state.docs.filter((d) => !removed.includes(d));
          return { deletedCount: before - fake.state.docs.length };
        },
      }),
    };
    return model;
  };

  const savedEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(options.env || {})) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const provider = new StatsMaintenanceProvider(
    makeModel(visits, 'visits'),
    makeModel(viewers, 'viewers'),
  );
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { provider, visits, viewers, opLog, deleted, restoreEnv };
}

/** 本机线上实测到的那两对重复行（createdAt 相差 9 毫秒） */
const dupDocs = (): Doc[] => [
  { _id: 'k1', date: '2026-02-28', pathname: '/', viewer: 2270, visited: 898, lastVisitedTime: new Date('2026-02-28T15:42:24.345Z'), createdAt: new Date('2026-02-28T01:12:06.529Z') },
  { _id: 'k2', date: '2026-02-28', pathname: '/', viewer: 2266, visited: 898, lastVisitedTime: new Date('2026-02-28T01:12:06.538Z'), createdAt: new Date('2026-02-28T01:12:06.538Z') },
  { _id: 'k3', date: '2025-02-03', pathname: '/', viewer: 624, visited: 222, lastVisitedTime: new Date('2025-02-03T10:28:04.389Z'), createdAt: new Date('2025-02-03T07:07:39.272Z') },
  { _id: 'k4', date: '2025-02-03', pathname: '/', viewer: 623, visited: 221, lastVisitedTime: new Date('2025-02-03T07:07:39.280Z'), createdAt: new Date('2025-02-03T07:07:39.280Z') },
  { _id: 'ok', date: '2026-09-16', pathname: '/post/1', viewer: 295, visited: 257, lastVisitedTime: new Date('2026-09-16T01:00:00Z'), createdAt: new Date('2026-09-16T00:00:00Z') },
];

describe('StatsMaintenanceProvider：去重 + 唯一索引', () => {
  it('合并重复行（取 max）并建上 {date,pathname} 唯一索引', async () => {
    const fake = createFake({
      visitDocs: dupDocs(),
      viewerIndexes: [{ v: 2, key: { date: 1 }, name: 'date_1' }],
    });
    try {
      const res = await fake.provider.runStartupMaintenance('测试');
      expect(res.dedup.groups).toBe(2);
      expect(res.dedup.dropped).toBe(2);
      expect(fake.visits.state.docs).toHaveLength(3);
      // 保留 lastVisitedTime 最新的那一行，值是两行的 max
      const kept2026 = fake.visits.state.docs.find((d) => d.date === '2026-02-28');
      expect(kept2026).toMatchObject({ _id: 'k1', viewer: 2270, visited: 898 });
      const kept2025 = fake.visits.state.docs.find((d) => d.date === '2025-02-03');
      expect(kept2025).toMatchObject({ _id: 'k3', viewer: 624, visited: 222 });
      // 没有重复的行不能被动
      expect(fake.visits.state.docs.find((d) => d._id === 'ok')?.viewer).toBe(295);

      const uniq = fake.visits.state.indexes.find(
        (i) => JSON.stringify(i.key) === JSON.stringify({ date: 1, pathname: 1 }),
      );
      expect(uniq?.unique).toBe(true);
      expect(res.indexes.find((i) => i.collection === 'visits')?.created).toBe(true);
      expect(res.indexes.find((i) => i.collection === 'visits')?.error).toBeUndefined();
    } finally {
      fake.restoreEnv();
    }
  });

  it('viewers 的非唯一 date_1 被换成唯一索引（同名替换，不增加索引体积）', async () => {
    const fake = createFake({
      visitDocs: [],
      visitIndexes: [{ v: 2, key: { date: 1, pathname: 1 }, name: 'date_1_pathname_1', unique: true }],
      viewerIndexes: [{ v: 2, key: { date: 1 }, name: 'date_1' }],
    });
    try {
      const res = await fake.provider.runStartupMaintenance('测试');
      const viewerIdx = res.indexes.find((i) => i.collection === 'viewers')!;
      expect(viewerIdx.replaced).toBe(true);
      expect(viewerIdx.created).toBe(true);
      expect(fake.viewers.state.log).toContain('viewers.dropIndex(date_1)');
      expect(fake.viewers.state.indexes.find((i) => i.name === 'date_1')?.unique).toBe(true);
      // 同一个键不能留下两个索引
      expect(
        fake.viewers.state.indexes.filter((i) => JSON.stringify(i.key) === JSON.stringify({ date: 1 })),
      ).toHaveLength(1);
    } finally {
      fake.restoreEnv();
    }
  });

  it('幂等：唯一索引已经在了，就一次 listIndexes 也不动数据', async () => {
    const fake = createFake({
      visitDocs: dupDocs(),
      visitIndexes: [{ v: 2, key: { date: 1, pathname: 1 }, name: 'date_1_pathname_1', unique: true }],
      viewerIndexes: [{ v: 2, key: { date: 1 }, name: 'date_1', unique: true }],
    });
    try {
      const res = await fake.provider.runStartupMaintenance('测试');
      expect(res.dedup.skipped).toBe(true);
      expect(res.dedup.groups).toBe(0);
      expect(fake.visits.state.docs).toHaveLength(5);
      expect(fake.opLog).not.toContain('visits.aggregate');
      expect(fake.opLog).not.toContain('visits.deleteMany');
      expect(res.indexes.every((i) => i.created === false)).toBe(true);
      expect(fake.visits.state.log).toEqual(['visits.indexes']);
      expect(fake.viewers.state.log).toEqual(['viewers.indexes']);
    } finally {
      fake.restoreEnv();
    }
  });

  it('同一个进程里只跑一次（启动钩子被反复调用也不会重复扫全表）', async () => {
    const fake = createFake({ visitDocs: dupDocs() });
    try {
      await fake.provider.runStartupMaintenance('第一次');
      const scans = fake.opLog.filter((l) => l === 'visits.aggregate').length;
      const second = await fake.provider.runStartupMaintenance('第二次');
      expect(second.dedup.skipped).toBe(true);
      expect(fake.opLog.filter((l) => l === 'visits.aggregate').length).toBe(scans);
    } finally {
      fake.restoreEnv();
    }
  });

  it('dry run 只打印不动数据，也不建索引', async () => {
    const fake = createFake({
      visitDocs: dupDocs(),
      env: { VANBLOG_VISITS_DEDUP_DRY_RUN: 'true' },
    });
    try {
      expect(fake.provider.dedupDryRun).toBe(true);
      const res = await fake.provider.runStartupMaintenance('测试');
      expect(res.dedup.groups).toBe(2);
      expect(res.dedup.dropped).toBe(0);
      expect(fake.visits.state.docs).toHaveLength(5);
      expect(
        fake.visits.state.indexes.some(
          (i) => JSON.stringify(i.key) === JSON.stringify({ date: 1, pathname: 1 }),
        ),
      ).toBe(false);
    } finally {
      fake.restoreEnv();
    }
  });

  it('VANBLOG_VISITS_DEDUP=false 时不去重（但仍然尝试建索引，并把风险写进日志）', async () => {
    const fake = createFake({ visitDocs: dupDocs(), env: { VANBLOG_VISITS_DEDUP: 'false' } });
    try {
      const res = await fake.provider.runStartupMaintenance('测试');
      expect(res.dedup.skipped).toBe(true);
      expect(fake.visits.state.docs).toHaveLength(5);
      expect(fake.opLog).not.toContain('visits.aggregate');
    } finally {
      fake.restoreEnv();
    }
  });

  it('建唯一索引失败（期间又产生了重复行）时把原来的非唯一索引补回去', async () => {
    const fake = createFake({
      visitDocs: dupDocs(),
      visitIndexes: [{ v: 2, key: { pathname: 1 }, name: 'pathname_1' }],
      viewerIndexes: [{ v: 2, key: { date: 1 }, name: 'date_1' }],
    });
    try {
      // 让 createIndex 第一次就失败：模拟"去重之后又有并发插入了重复行"
      const realCreate = fake.visits.collection.createIndex;
      let failed = false;
      fake.visits.collection.createIndex = async (keys: Doc, opts: Doc) => {
        if (!failed && opts?.unique) {
          failed = true;
          throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
        }
        return realCreate(keys, opts);
      };
      const res = await fake.provider.ensureUniqueIndex(
        'visits',
        { collection: fake.visits.collection } as any,
        { pathname: 1 },
        'pathname_1',
      );
      expect(res.error).toContain('E11000');
      expect(res.error).toContain('已恢复原来的非唯一索引');
      // 补回来的是**非唯一**的那个，查询不会退化成全表扫
      const restored = fake.visits.state.indexes.find((i) => i.name === 'pathname_1');
      expect(restored).toBeDefined();
      expect(restored?.unique).toBeFalsy();
    } finally {
      fake.restoreEnv();
    }
  });

  it('启动钩子不 await（不阻塞 listen），里面失败也不往外抛', async () => {
    const fake = createFake({ visitDocs: dupDocs() });
    try {
      fake.visits.collection.indexes = async () => {
        throw new Error('boom');
      };
      fake.viewers.collection.indexes = async () => {
        throw new Error('boom');
      };
      // 同步返回（不是 Promise）=> Nest 不会等它，listen 不被拖住
      expect(fake.provider.onApplicationBootstrap()).toBeUndefined();
      await new Promise((r) => setTimeout(r, 30));
      // 内部错误被 catch 住了（没有变成 unhandledRejection）。
      // 读不到索引列表时按"还没有唯一索引"处理，所以去重照常跑了一遍——
      // 它本身是幂等的，重复行该合并还是合并了
      expect(fake.visits.state.docs).toHaveLength(3);
    } finally {
      fake.restoreEnv();
    }
  });
});

describe('StatsMaintenanceProvider：保留期清理', () => {
  const NOW = new Date('2026-09-16T12:00:00+08:00');
  const rows = () => [
    { _id: 'a', date: '2024-07-07', pathname: '/', viewer: 1, visited: 1 },
    { _id: 'b', date: '2026-06-18', pathname: '/', viewer: 2, visited: 2 },
    { _id: 'c', date: '2026-06-19', pathname: '/', viewer: 3, visited: 3 },
    { _id: 'd', date: '2026-09-16', pathname: '/', viewer: 4, visited: 4 },
    { _id: 'e', date: null, pathname: '/', viewer: 5, visited: 5 },
    { _id: 'f', pathname: '/', viewer: 6, visited: 6 },
  ];

  it('默认不设环境变量：一行都不删', async () => {
    const fake = createFake({ visitDocs: rows(), viewerDocs: rows(), env: { VANBLOG_VISIT_RETENTION_DAYS: undefined } });
    try {
      expect(fake.provider.retentionDays).toBe(0);
      const res = await fake.provider.pruneStats('测试', NOW);
      expect(res).toEqual({ enabled: false, effectiveDays: 0, cutoff: null, visits: 0, viewers: 0 });
      expect(fake.visits.state.docs).toHaveLength(6);
      expect(fake.opLog).not.toContain('visits.deleteMany');
    } finally {
      fake.restoreEnv();
    }
  });

  it('保留 90 天：删掉 cutoff 之前的，边界那一天留下，date 为 null/缺失的也留下', async () => {
    const fake = createFake({
      visitDocs: rows(),
      viewerDocs: rows(),
      env: { VANBLOG_VISIT_RETENTION_DAYS: '90' },
    });
    try {
      const res = await fake.provider.pruneStats('测试', NOW);
      expect(res.enabled).toBe(true);
      expect(res.effectiveDays).toBe(90);
      expect(res.cutoff).toBe('2026-06-19');
      expect(res.visits).toBe(2); // 2024-07-07 与 2026-06-18
      expect(res.viewers).toBe(2);
      const left = fake.visits.state.docs.map((d) => d._id).sort();
      expect(left).toEqual(['c', 'd', 'e', 'f']);
      expect(fake.deleted.map((d) => d._id).sort()).toEqual(['a', 'a', 'b', 'b']);
    } finally {
      fake.restoreEnv();
    }
  });

  it('保留期设得再短也不会动最近 30 天', async () => {
    const fake = createFake({
      visitDocs: rows(),
      env: { VANBLOG_VISIT_RETENTION_DAYS: '1', VANBLOG_VISIT_RETENTION_MIN_KEEP_DAYS: '30' },
    });
    try {
      const res = await fake.provider.pruneStats('测试', NOW);
      expect(res.effectiveDays).toBe(30);
      expect(res.cutoff).toBe('2026-08-18');
      // 2024-07-07 / 2026-06-18 / 2026-06-19 三行都在 30 天之外
      expect(res.visits).toBe(3);
      expect(fake.visits.state.docs.map((d) => d._id)).toContain('d');
    } finally {
      fake.restoreEnv();
    }
  });

  it('非法值回落到默认（0 = 不删）', async () => {
    const fake = createFake({
      visitDocs: rows(),
      env: { VANBLOG_VISIT_RETENTION_DAYS: 'abc' },
    });
    try {
      expect(fake.provider.retentionDays).toBe(0);
      const res = await fake.provider.pruneStats('测试', NOW);
      expect(res.enabled).toBe(false);
      expect(fake.visits.state.docs).toHaveLength(6);
    } finally {
      fake.restoreEnv();
    }
  });

  it('重复跑是幂等的（第二次删 0 行）', async () => {
    const fake = createFake({
      visitDocs: rows(),
      viewerDocs: rows(),
      env: { VANBLOG_VISIT_RETENTION_DAYS: '90' },
    });
    try {
      await fake.provider.pruneStats('第一次', NOW);
      const second = await fake.provider.pruneStats('第二次', NOW);
      expect(second.visits).toBe(0);
      expect(second.viewers).toBe(0);
    } finally {
      fake.restoreEnv();
    }
  });
});

describe('StatsMaintenanceProvider：删除 visits 冗余前缀索引', () => {
  /** 本机线上（2026-09-16）的真实索引列表：两个单列前缀 + 两个复合 + 两个时间列 */
  const liveIndexes = (): Doc[] => [
    { v: 2, key: { date: 1 }, name: 'date_1' },
    { v: 2, key: { pathname: 1 }, name: 'pathname_1' },
    { v: 2, key: { lastVisitedTime: 1 }, name: 'lastVisitedTime_1' },
    { v: 2, key: { createdAt: 1 }, name: 'createdAt_1' },
    { v: 2, key: { pathname: 1, date: -1 }, name: 'pathname_1_date_-1' },
    { v: 2, key: { date: 1, pathname: 1 }, name: 'date_1_pathname_1', unique: true },
  ];
  const viewerUniq = (): Doc[] => [{ v: 2, key: { date: 1 }, name: 'date_1', unique: true }];
  const names = (fake: ReturnType<typeof createFake>) =>
    fake.visits.state.indexes.map((i) => i.name).sort();

  it('替代复合索引都在时：date_1 与 pathname_1 都被删掉，其它索引一根毫毛不动', async () => {
    const fake = createFake({ visitIndexes: liveIndexes(), viewerIndexes: viewerUniq() });
    try {
      const res = await fake.provider.runStartupMaintenance('测试');
      expect(res.dropped.skipped).toBe(false);
      expect(res.dropped.dropped.sort()).toEqual(['date_1', 'pathname_1']);
      expect(res.dropped.kept).toEqual([]);
      expect(res.dropped.errors).toEqual([]);
      // fake 的 stats 是 indexes.length * 40960：删完剩 5 个（含 _id_）
      expect(res.dropped.totalIndexSize).toBe(5 * 40960);
      expect(names(fake)).toEqual([
        '_id_',
        'createdAt_1',
        'date_1_pathname_1',
        'lastVisitedTime_1',
        'pathname_1_date_-1',
      ]);
      expect(fake.visits.state.log).toContain('visits.dropIndex(date_1)');
      expect(fake.visits.state.log).toContain('visits.dropIndex(pathname_1)');
    } finally {
      fake.restoreEnv();
    }
  });

  it('幂等：删过之后再跑一次启动维护，一个索引都不动、连多余的 listIndexes/stats 都没有', async () => {
    // 模拟"删完之后重启"：索引列表里已经没有两个单列前缀
    const after = liveIndexes().filter((i) => i.name !== 'date_1' && i.name !== 'pathname_1');
    const fake = createFake({ visitIndexes: after, viewerIndexes: viewerUniq() });
    try {
      const res = await fake.provider.runStartupMaintenance('第二次启动');
      expect(res.dropped.dropped).toEqual([]);
      expect(res.dropped.kept).toEqual([]);
      // 没有候选 => 不重新 listIndexes、不读 stats、更不 dropIndex
      expect(fake.visits.state.log).toEqual(['visits.indexes']);
    } finally {
      fake.restoreEnv();
    }
  });

  it('安全护栏：{pathname:1,date:-1} 不存在时绝不删 pathname_1（date_1 有替代就照删）', async () => {
    const fake = createFake({
      visitIndexes: [
        { v: 2, key: { date: 1 }, name: 'date_1' },
        { v: 2, key: { pathname: 1 }, name: 'pathname_1' },
        { v: 2, key: { date: 1, pathname: 1 }, name: 'date_1_pathname_1', unique: true },
      ],
      viewerIndexes: viewerUniq(),
    });
    try {
      const res = await fake.provider.runStartupMaintenance('测试');
      expect(res.dropped.dropped).toEqual(['date_1']);
      expect(res.dropped.kept).toEqual([
        { name: 'pathname_1', reason: '替代索引 {"pathname":1,"date":-1} 不存在' },
      ]);
      expect(names(fake)).toContain('pathname_1');
    } finally {
      fake.restoreEnv();
    }
  });

  it('唯一索引是这一轮刚建的（启动时那份列表里没有）：重新 listIndexes 之后再删', async () => {
    const fake = createFake({
      // 启动时读到的列表：只有 date_1，还没有唯一复合索引
      visitIndexes: [{ v: 2, key: { date: 1 }, name: 'date_1' }],
      viewerIndexes: viewerUniq(),
    });
    try {
      // ensureUniqueIndex 刚把 date_1_pathname_1 建出来 —— 之后 listIndexes 就能看到它
      fake.visits.collection.indexes = async () => [
        { v: 2, key: { _id: 1 }, name: '_id_' },
        { v: 2, key: { date: 1 }, name: 'date_1' },
        { v: 2, key: { date: 1, pathname: 1 }, name: 'date_1_pathname_1', unique: true },
      ];
      const res = await fake.provider.dropRedundantVisitIndexes(
        [{ v: 2, key: { date: 1 }, name: 'date_1' }],
        { collection: 'visits', name: 'date_1_pathname_1', created: true, replaced: false },
      );
      expect(res.dropped).toEqual(['date_1']);
      expect(res.kept).toEqual([]);
    } finally {
      fake.restoreEnv();
    }
  });

  it('VANBLOG_VISITS_DROP_REDUNDANT_INDEXES=false：一个都不删（kill-switch）', async () => {
    const fake = createFake({
      visitIndexes: liveIndexes(),
      viewerIndexes: viewerUniq(),
      env: { VANBLOG_VISITS_DROP_REDUNDANT_INDEXES: 'false' },
    });
    try {
      expect(fake.provider.dropRedundantIndexes).toBe(false);
      const res = await fake.provider.runStartupMaintenance('测试');
      expect(res.dropped.skipped).toBe(true);
      expect(res.dropped.dropped).toEqual([]);
      expect(names(fake)).toEqual([
        '_id_',
        'createdAt_1',
        'date_1',
        'date_1_pathname_1',
        'lastVisitedTime_1',
        'pathname_1',
        'pathname_1_date_-1',
      ]);
      expect(fake.visits.state.log).not.toContain('visits.dropIndex(date_1)');
    } finally {
      fake.restoreEnv();
    }
  });

  it('dry run 时整个删除步骤不跑（跟建索引同一个门槛）', async () => {
    const fake = createFake({
      visitIndexes: liveIndexes(),
      viewerIndexes: viewerUniq(),
      env: { VANBLOG_VISITS_DEDUP_DRY_RUN: 'true' },
    });
    try {
      const res = await fake.provider.runStartupMaintenance('测试');
      expect(res.dropped.skipped).toBe(true);
      expect(names(fake)).toContain('date_1');
      expect(names(fake)).toContain('pathname_1');
    } finally {
      fake.restoreEnv();
    }
  });

  it('dropIndex 报"不存在"按成功处理；其它错误记进 errors 不往外抛', async () => {
    const fake = createFake({ visitIndexes: liveIndexes(), viewerIndexes: viewerUniq() });
    try {
      const realDrop = fake.visits.collection.dropIndex;
      fake.visits.collection.dropIndex = async (name: string) => {
        if (name === 'date_1') throw new Error('index not found with name [date_1]');
        if (name === 'pathname_1') throw new Error('SomeWeirdError: busy');
        return realDrop(name);
      };
      const res = await fake.provider.runStartupMaintenance('测试');
      // 别的实例已经删了 = 目的达成
      expect(res.dropped.dropped).toEqual(['date_1']);
      expect(res.dropped.errors).toEqual(['pathname_1: SomeWeirdError: busy']);
    } finally {
      fake.restoreEnv();
    }
  });
});

describe('集合还不存在时不要报"失败"', () => {
  // 全新站点（刚装完 / 刚 reset 完）的第一次启动，visits 与 viewers 都还没被创建，
  // Mongo 对 listIndexes 回 `ns does not exist`（错误码 26）。这是正常状态，
  // 以前却一律打 WARN，于是新装站点的第一屏日志里挂着两条"读取索引列表失败"，
  // 看着像出了事。现在要降级成一条说明性的 LOG，而真正的故障仍然是 WARN。
  const { isNamespaceMissing } = require('./statsMaintenance.provider');

  it('认得出各种形态的"命名空间不存在"', () => {
    expect(isNamespaceMissing({ code: 26 })).toBe(true);
    expect(isNamespaceMissing({ codeName: 'NamespaceNotFound' })).toBe(true);
    expect(isNamespaceMissing({ message: 'ns does not exist: vanBlog.visits' })).toBe(true);
    expect(isNamespaceMissing(new Error('ns does not exist: vanBlog.viewers'))).toBe(true);
  });

  it('不会把别的错误误判成"集合不存在"', () => {
    expect(isNamespaceMissing(null)).toBe(false);
    expect(isNamespaceMissing(undefined)).toBe(false);
    expect(isNamespaceMissing({})).toBe(false);
    expect(isNamespaceMissing({ code: 13, message: 'not authorized' })).toBe(false);
    expect(isNamespaceMissing(new Error('connection refused'))).toBe(false);
  });

  it('listIndexes 遇到 ns 不存在时打 LOG 而不是 WARN，并返回空列表', async () => {
    const { StatsMaintenanceProvider } = require('./statsMaintenance.provider');
    const logs: string[] = [];
    const warns: string[] = [];
    const provider = Object.create(StatsMaintenanceProvider.prototype);
    provider['logger'] = { log: (m: string) => logs.push(m), warn: (m: string) => warns.push(m) };
    const model = {
      collection: {
        indexes: async () => {
          const err: any = new Error('ns does not exist: vanBlog.visits');
          err.code = 26;
          throw err;
        },
      },
    };
    const out = await provider['listIndexes'](model, 'visits');
    expect(out).toEqual([]);
    expect(warns).toEqual([]);
    expect(logs.join(' ')).toContain('还不存在');
  });

  it('真正的失败仍然走 WARN', async () => {
    const { StatsMaintenanceProvider } = require('./statsMaintenance.provider');
    const logs: string[] = [];
    const warns: string[] = [];
    const provider = Object.create(StatsMaintenanceProvider.prototype);
    provider['logger'] = { log: (m: string) => logs.push(m), warn: (m: string) => warns.push(m) };
    const model = {
      collection: {
        indexes: async () => {
          throw new Error('not authorized on vanBlog');
        },
      },
    };
    const out = await provider['listIndexes'](model, 'visits');
    expect(out).toEqual([]);
    expect(logs).toEqual([]);
    expect(warns.join(' ')).toContain('索引列表失败');
  });
});
