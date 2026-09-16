import dayjs from 'dayjs';
import { ViewStatsProvider } from './viewStats.provider';

/**
 * 「一次浏览到底打几次 Mongo」的行为测试。
 *
 * 用一个**极简的内存 Mongo**（能认 $inc / $set / $setOnInsert / upsert / $and / $or / $exists，
 * 以及 visits 那条固定的 aggregate 管道）把真实的 Provider 跑起来，
 * 于是每一次 flush 发出的命令都能一条条数出来、落库结果也能逐个字段核对。
 *
 * 改动前的基线是**实测**的（mongod `serverStatus().metrics.commands` 差值，扣掉背景噪音）：
 * 一次文章页浏览 = 8 次命令 / 4 次写。这里钉住改动后的：
 *   - 稳态一轮 flush = **4 次命令**，与这一轮攒了多少次浏览无关；
 *   - 某条路径当天第一次被访问 = 6 次（多一次 aggregate 取上一天累计值 + 一次建行）；
 *   - 落库后的最终值与"逐次浏览各写一次"**完全相同**（这是不能变的口径）。
 */

type Doc = Record<string, any>;

// ⚠️ 这两个值必须是**动态**的，不能写死：Provider 给每次浏览打日期用的是
// `dayjs().format('YYYY-MM-DD')`（真实当天），而这里以前写死了 `'2026-09-16'`。
// 写死的那一天一旦过去（本机就是在 00:24 跨过零点时炸的），种下去的 fixtures 全成了
// "昨天"的数据 ⇒ 每一条按 TODAY 取的断言都红，看起来像"浏览统计被改坏了"，
// 实际与代码无关。CI 在什么时刻跑就什么时候炸，是个纯粹的定时炸弹。
const TODAY = dayjs().format('YYYY-MM-DD');
const YESTERDAY = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
/** "更早的某一天"（测试种子数据里的历史行），同样要跟着当前日期走 */
const LAST_WEEK = dayjs().subtract(6, 'day').format('YYYY-MM-DD');

function matches(doc: Doc, filter: Doc): boolean {
  for (const [key, value] of Object.entries(filter || {})) {
    if (key === '$and') {
      if (!(value as Doc[]).every((f) => matches(doc, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!(value as Doc[]).some((f) => matches(doc, f))) return false;
      continue;
    }
    if (value && typeof value === 'object' && '$exists' in (value as Doc)) {
      const exists = key in doc && doc[key] !== undefined;
      if (Boolean((value as Doc).$exists) !== exists) return false;
      continue;
    }
    if (value && typeof value === 'object' && '$in' in (value as Doc)) {
      if (!(value as Doc).$in.includes(doc[key])) return false;
      continue;
    }
    if (doc[key] !== value) return false;
  }
  return true;
}

function applyUpdate(doc: Doc, update: Doc, inserted: boolean): void {
  const inc = update.$inc as Doc | undefined;
  const set = update.$set as Doc | undefined;
  const setOnInsert = update.$setOnInsert as Doc | undefined;
  if (inserted && setOnInsert) Object.assign(doc, setOnInsert);
  if (inc) {
    for (const [k, v] of Object.entries(inc)) doc[k] = (doc[k] || 0) + (v as number);
  }
  if (set) Object.assign(doc, set);
}

function equalityFields(filter: Doc): Doc {
  const out: Doc = {};
  for (const [k, v] of Object.entries(filter || {})) {
    if (k.startsWith('$')) continue;
    if (v && typeof v === 'object') continue;
    out[k] = v;
  }
  return out;
}

class FakeCollection {
  constructor(readonly name: string, public docs: Doc[] = []) {}

  findOne(filter: Doc): Doc | null {
    return this.docs.find((d) => matches(d, filter)) || null;
  }

  /** 返回 matchedCount，供 upsert / 数字 id 回退那条路径判断 */
  updateOne(filter: Doc, update: Doc, options: { upsert?: boolean } = {}) {
    const doc = this.findOne(filter);
    if (doc) {
      applyUpdate(doc, update, false);
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
    }
    if (options.upsert) {
      const created: Doc = { _id: `${this.name}-${this.docs.length}`, ...equalityFields(filter) };
      applyUpdate(created, update, true);
      this.docs.push(created);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: created._id };
    }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
  }

  bulkWrite(ops: any[], options: { ordered?: boolean } = {}) {
    let matchedCount = 0;
    let upsertedCount = 0;
    const writeErrors: any[] = [];
    ops.forEach((op, index) => {
      const spec = op.updateOne;
      if (!spec) throw new Error(`fake: 不支持的 bulkWrite 操作 ${Object.keys(op).join(',')}`);
      if (this.uniqueViolation) {
        // 真实 Mongo：撞唯一索引的那条什么也不写，其余（ordered:false）照常执行
        writeErrors.push({ index, code: 11000, err: { code: 11000 } });
        return;
      }
      const res = this.updateOne(spec.filter, spec.update, { upsert: spec.upsert });
      matchedCount += res.matchedCount;
      upsertedCount += res.upsertedCount;
    });
    if (writeErrors.length) {
      const err: any = new Error('E11000 duplicate key error');
      err.code = 11000;
      err.writeErrors = writeErrors;
      throw err;
    }
    return { matchedCount, modifiedCount: matchedCount, upsertedCount, insertedCount: 0 };
  }

  uniqueViolation = false;
}

interface FakeOptions {
  metas?: Doc[];
  articles?: Doc[];
  viewers?: Doc[];
  visits?: Doc[];
}

function createFake(options: FakeOptions = {}) {
  const metas = new FakeCollection('metas', options.metas ?? [{ viewer: 100, visited: 50 }]);
  const articles = new FakeCollection('articles', options.articles ?? []);
  const viewers = new FakeCollection('viewers', options.viewers ?? []);
  const visits = new FakeCollection('visits', options.visits ?? []);
  const log: string[] = [];
  /** 让某一类命令失败 n 次，用来测"写失败不能丢计数" */
  const fail = new Map<string, number>();
  const failNext = (key: string, times = 1) => fail.set(key, (fail.get(key) || 0) + times);
  const guard = (key: string) => {
    const left = fail.get(key) || 0;
    if (left > 0) {
      fail.set(key, left - 1);
      throw new Error(`fake failure: ${key}`);
    }
  };

  const metaModel: any = {
    findOne: (filter: Doc, projection: Doc) => ({
      lean: () => ({
        exec: async () => {
          log.push('metas.findOne');
          guard('metas.findOne');
          const doc = metas.findOne(filter);
          if (!doc) return null;
          if (!projection) return { ...doc };
          const out: Doc = {};
          for (const k of Object.keys(projection)) out[k] = doc[k];
          return out;
        },
      }),
    }),
    findOneAndUpdate: (filter: Doc, update: Doc, opts: any) => ({
      exec: async () => {
        log.push('metas.findOneAndUpdate');
        guard('metas.findOneAndUpdate');
        const doc = metas.findOne(filter);
        if (!doc) return null;
        applyUpdate(doc, update, false);
        if (!opts?.new) return { ...doc };
        const projection = opts?.projection;
        if (!projection) return doc as any;
        const out: Doc = {};
        for (const k of Object.keys(projection)) out[k] = doc[k];
        return out as any;
      },
    }),
  };

  const articleModel: any = {
    bulkWrite: async (ops: any[], options: any) => {
      log.push(`articles.bulkWrite(${ops.length})`);
      guard('articles.bulkWrite');
      return articles.bulkWrite(ops, options);
    },
    updateOne: (filter: Doc, update: Doc) => ({
      exec: async () => {
        log.push(`articles.updateOne(${JSON.stringify(Object.keys(filter))})`);
        guard('articles.updateOne');
        return articles.updateOne(filter, update);
      },
    }),
  };

  const viewerModel: any = {
    updateOne: (filter: Doc, update: Doc, opts: any) => ({
      exec: async () => {
        log.push('viewers.updateOne');
        guard('viewers.updateOne');
        return viewers.updateOne(filter, update, opts);
      },
    }),
  };

  const visitModel: any = {
    aggregate: (pipeline: any[]) => ({
      exec: async () => {
        log.push(`visits.aggregate(${JSON.stringify(pipeline[0]?.$match?.pathname?.$in)})`);
        guard('visits.aggregate');
        const wanted: string[] = pipeline[0]?.$match?.pathname?.$in || [];
        const byPath = new Map<string, Doc>();
        for (const doc of visits.docs) {
          if (!wanted.includes(doc.pathname)) continue;
          const cur = byPath.get(doc.pathname);
          // $sort {pathname:1, date:-1} + $group $first === 每条路径取 date 最大的那一行
          if (!cur || String(doc.date) > String(cur.date)) byPath.set(doc.pathname, doc);
        }
        return [...byPath.entries()].map(([_id, last]) => ({
          _id,
          date: last.date,
          viewer: last.viewer,
          visited: last.visited,
        }));
      },
    }),
    bulkWrite: async (ops: any[], options: any) => {
      const kinds = ops.every((o) => o.updateOne?.update?.$setOnInsert && !o.updateOne.update.$inc)
        ? 'seed'
        : 'inc';
      log.push(`visits.bulkWrite.${kinds}(${ops.length})`);
      guard(`visits.bulkWrite.${kinds}`);
      const prev = visits.uniqueViolation;
      if (fail.get('visits.dup') && kinds === 'seed') {
        visits.uniqueViolation = true;
        fail.set('visits.dup', (fail.get('visits.dup') || 0) - 1);
      }
      try {
        return visits.bulkWrite(ops, options);
      } finally {
        visits.uniqueViolation = prev;
      }
    },
  };

  const provider = new ViewStatsProvider(metaModel, articleModel, viewerModel, visitModel);
  return {
    provider,
    log,
    failNext,
    metas,
    articles,
    viewers,
    visits,
    resetLog: () => {
      log.length = 0;
    },
  };
}

const record = (
  provider: ViewStatsProvider,
  pathname = '/post/hello',
  opts: { isNewVisitor?: boolean; isNewForPath?: boolean } = {},
) =>
  provider.record({
    pathname,
    isNewVisitor: !!opts.isNewVisitor,
    isNewForPath: !!opts.isNewForPath,
  });

describe('ViewStatsProvider：一轮 flush 的命令数', () => {
  it('稳态下 5 次命令，且与攒了多少次浏览无关', async () => {
    const fake = createFake({
      articles: [{ id: 1, pathname: 'hello', deleted: false, viewer: 10, visited: 5 }],
      viewers: [{ date: TODAY, viewer: 100, visited: 50 }],
      visits: [{ date: TODAY, pathname: '/post/hello', viewer: 10, visited: 5 }],
    });
    // 第一轮要为这条路径确认"当天那行在不在"，所以多一次 aggregate（每条路径每天一次）
    await record(fake.provider);
    fake.resetLog();
    await fake.provider.flush('warmup');
    expect(fake.log).toEqual([
      'metas.findOneAndUpdate',
      'articles.bulkWrite(1)',
      `visits.aggregate(["/post/hello"])`,
      'visits.bulkWrite.inc(1)',
      'viewers.updateOne',
    ]);
    expect(fake.provider.counters.ops).toBe(5);

    for (const n of [1, 5, 50]) {
      fake.resetLog();
      for (let i = 0; i < n; i += 1) await record(fake.provider);
      const summary = await fake.provider.flush('timer');
      // metas 1 + articles 1 + visits（aggregate + $inc）2 + viewers 1 = 5，与 n 无关
      expect(summary.ops).toBe(5);
      expect(fake.log).toHaveLength(5);
    }
  });

  it('当天第一次访问某条路径时 6 次命令（多一次 aggregate + 一次建行）', async () => {
    const fake = createFake({
      articles: [{ id: 1, pathname: 'hello', deleted: false, viewer: 10, visited: 5 }],
      visits: [{ date: YESTERDAY, pathname: '/post/hello', viewer: 42, visited: 7 }],
    });
    await record(fake.provider);
    fake.resetLog();
    const summary = await fake.provider.flush('first-of-day');
    expect(summary.ops).toBe(6);
    expect(fake.log).toEqual([
      'metas.findOneAndUpdate',
      'articles.bulkWrite(1)',
      `visits.aggregate(["/post/hello"])`,
      'visits.bulkWrite.seed(1)',
      'visits.bulkWrite.inc(1)',
      'viewers.updateOne',
    ]);
  });

  it('攒着不写：100 次浏览只有 1 次读（第一次投影要拿基数），一次写都没有', async () => {
    const fake = createFake();
    for (let i = 0; i < 100; i += 1) await record(fake.provider);
    // 那一次 metas.findOne 是"库里的累计值"这个基数，进程生命周期内只读一次
    expect(fake.log).toEqual(['metas.findOne']);
    expect(fake.log.filter((l) => l !== 'metas.findOne')).toEqual([]);
    expect(fake.metas.docs[0]).toMatchObject({ viewer: 100, visited: 50 });
  });

  it('空批次 flush 是 no-op', async () => {
    const fake = createFake();
    const summary = await fake.provider.flush('timer');
    expect(summary).toEqual({ reason: 'timer', events: 0, ops: 0, ms: expect.any(Number) });
    expect(fake.log).toEqual([]);
  });
});

describe('ViewStatsProvider：落库结果与"逐次写"完全一致', () => {
  it('metas 用一次 $inc 加上这一轮的全部浏览量', async () => {
    const fake = createFake();
    await record(fake.provider, '/post/hello', { isNewVisitor: true });
    await record(fake.provider, '/post/hello');
    await record(fake.provider, '/', { isNewVisitor: true });
    await fake.provider.flush('timer');
    expect(fake.metas.docs[0]).toMatchObject({ viewer: 103, visited: 52 });
  });

  it('visits 是"按路径累计"：新的一天从上一天的值接着加，不会在零点掉回 1', async () => {
    const fake = createFake({
      visits: [
        { date: LAST_WEEK, pathname: '/post/hello', viewer: 30, visited: 4 },
        { date: YESTERDAY, pathname: '/post/hello', viewer: 42, visited: 7 },
      ],
    });
    await record(fake.provider, '/post/hello');
    await record(fake.provider, '/post/hello', { isNewForPath: true });
    await fake.provider.flush('timer');
    const today = fake.visits.docs.find((d) => d.date === TODAY);
    // 上一天是 42/7，这一轮 +2 viewer / +1 visited
    expect(today).toMatchObject({ pathname: '/post/hello', viewer: 44, visited: 8 });
    expect(today!.lastVisitedTime).toBeInstanceOf(Date);
    expect(today!.createdAt).toBeInstanceOf(Date);
    // 昨天的行不能被动过
    expect(fake.visits.docs.find((d) => d.date === YESTERDAY)).toMatchObject({
      viewer: 42,
      visited: 7,
    });
  });

  it('这条路径历史上没有任何记录时，从 0 开始建当天那行', async () => {
    const fake = createFake();
    await record(fake.provider, '/post/brand-new');
    await fake.provider.flush('timer');
    expect(fake.visits.docs.find((d) => d.date === TODAY)).toMatchObject({
      pathname: '/post/brand-new',
      viewer: 1,
      visited: 0,
    });
  });

  it('articles 用 $inc 而不是写回绝对值，并更新 lastVisitedTime', async () => {
    const fake = createFake({
      articles: [{ id: 1, pathname: 'hello', deleted: false, viewer: 10, visited: 5 }],
    });
    await record(fake.provider, '/post/hello');
    await record(fake.provider, '/post/hello', { isNewForPath: true });
    await fake.provider.flush('timer');
    expect(fake.articles.docs[0]).toMatchObject({ viewer: 12, visited: 6 });
    expect(fake.articles.docs[0].lastVisitedTime).toBeInstanceOf(Date);
  });

  it('一篇文章的多次浏览合并成 bulkWrite 里的一个操作', async () => {
    const fake = createFake({
      articles: [
        { id: 1, pathname: 'hello', deleted: false, viewer: 0, visited: 0 },
        { id: 2, pathname: 'world', deleted: false, viewer: 0, visited: 0 },
      ],
    });
    for (let i = 0; i < 10; i += 1) await record(fake.provider, '/post/hello');
    for (let i = 0; i < 3; i += 1) await record(fake.provider, '/post/world');
    fake.resetLog();
    await fake.provider.flush('timer');
    expect(fake.log).toContain('articles.bulkWrite(2)');
    expect(fake.articles.docs[0]).toMatchObject({ viewer: 10 });
    expect(fake.articles.docs[1]).toMatchObject({ viewer: 3 });
  });

  it('软删除的文章不加计数（与改动前 getByPathName 的过滤一致）', async () => {
    const fake = createFake({
      articles: [{ id: 1, pathname: 'hello', deleted: true, viewer: 10, visited: 5 }],
    });
    await record(fake.provider, '/post/hello');
    await fake.provider.flush('timer');
    expect(fake.articles.docs[0]).toMatchObject({ viewer: 10, visited: 5 });
  });

  it('没有 deleted 字段的老文章也要算（$exists:false 那一支）', async () => {
    const fake = createFake({ articles: [{ id: 3, pathname: 'legacy', viewer: 1 }] });
    await record(fake.provider, '/post/legacy');
    await fake.provider.flush('timer');
    expect(fake.articles.docs[0]).toMatchObject({ viewer: 2 });
  });

  it('查不到的路径不会碰 articles（垃圾路径不该产生写）', async () => {
    const fake = createFake({ articles: [{ id: 1, pathname: 'hello', deleted: false }] });
    await record(fake.provider, '/post/nope-not-here');
    fake.resetLog();
    await fake.provider.flush('timer');
    expect(fake.log).toContain('articles.bulkWrite(1)');
    expect(fake.articles.docs[0].viewer).toBeUndefined();
  });

  it('数字 id 的老链接：先按别名找，找不到再按 id 找（与改动前一致）', async () => {
    const fake = createFake({
      articles: [{ id: 12, pathname: 'real-slug', deleted: false, viewer: 3 }],
    });
    await record(fake.provider, '/post/12');
    fake.resetLog();
    await fake.provider.flush('timer');
    expect(fake.log.filter((l) => l.startsWith('articles.updateOne'))).toHaveLength(2);
    expect(fake.articles.docs[0]).toMatchObject({ viewer: 4 });
  });

  it('别名本身就是数字时优先按别名命中，只发一次 updateOne', async () => {
    const fake = createFake({
      articles: [
        { id: 99, pathname: '12', deleted: false, viewer: 1 },
        { id: 12, pathname: 'other', deleted: false, viewer: 100 },
      ],
    });
    await record(fake.provider, '/post/12');
    fake.resetLog();
    await fake.provider.flush('timer');
    expect(fake.log.filter((l) => l.startsWith('articles.updateOne'))).toHaveLength(1);
    expect(fake.articles.docs[0]).toMatchObject({ viewer: 2 });
    expect(fake.articles.docs[1]).toMatchObject({ viewer: 100 });
  });

  it('viewers 那一行是 metas 累计值的每日快照（绝对值，不是增量）', async () => {
    const fake = createFake();
    await record(fake.provider, '/post/hello', { isNewVisitor: true });
    await record(fake.provider, '/post/hello');
    await fake.provider.flush('timer');
    expect(fake.viewers.docs.find((d) => d.date === TODAY)).toMatchObject({
      viewer: 102,
      visited: 51,
    });
  });

  it('跨零点的一批浏览：各归各的天，早的那天的快照不含晚的自增', async () => {
    const fake = createFake();
    // 直接往累加器里塞一条"昨天"的事件，模拟这一轮 flush 正好横跨零点
    (fake.provider as any).aggregator.add({
      pathname: '/post/hello',
      isNewVisitor: true,
      isNewForPath: false,
      date: YESTERDAY,
    });
    await record(fake.provider, '/post/hello');
    await record(fake.provider, '/post/hello');
    await fake.provider.flush('midnight');
    expect(fake.visits.docs.find((d) => d.date === YESTERDAY)?.viewer).toBe(1);
    // visits 是按路径**累计**的：今天那行从刚建出来的昨天那行（1）接着加 2
    expect(fake.visits.docs.find((d) => d.date === TODAY)?.viewer).toBe(3);
    const yesterdaySnap = fake.viewers.docs.find((d) => d.date === YESTERDAY);
    const todaySnap = fake.viewers.docs.find((d) => d.date === TODAY);
    // metas 一共 +3；昨天那一行只该看到 +1
    expect(yesterdaySnap).toMatchObject({ viewer: 101, visited: 51 });
    expect(todaySnap).toMatchObject({ viewer: 103, visited: 51 });
  });
});

describe('ViewStatsProvider：接口返回值', () => {
  it('投影 = 库里的基数 + 还没落库的增量，flush 前后不跳变', async () => {
    const fake = createFake();
    const first = await record(fake.provider, '/post/hello', { isNewVisitor: true });
    expect(first).toEqual({ viewer: 101, visited: 51 });
    const second = await record(fake.provider, '/post/hello');
    expect(second).toEqual({ viewer: 102, visited: 51 });
    await fake.provider.flush('timer');
    expect(await fake.provider.projection()).toEqual({ viewer: 102, visited: 51 });
  });

  it('metas 为空时返回 0（与改动前 `updated?.viewer || 0` 一致）', async () => {
    const fake = createFake({ metas: [] });
    expect(await record(fake.provider)).toEqual({ viewer: 0, visited: 0 });
    await fake.provider.flush('timer');
    expect(fake.viewers.docs).toHaveLength(0);
  });

  it('invalidateBase() 之后重新读库（整站恢复会整份替换 metas）', async () => {
    const fake = createFake();
    await record(fake.provider);
    fake.metas.docs[0].viewer = 9999;
    fake.metas.docs[0].visited = 8888;
    // 没失效之前用的是缓存的基数
    expect(await fake.provider.projection()).toEqual({ viewer: 101, visited: 50 });
    fake.provider.invalidateBase();
    expect(await fake.provider.projection()).toEqual({ viewer: 10000, visited: 8888 });
  });
});

describe('ViewStatsProvider：不能丢计数', () => {
  it('visits 写失败时增量退回队列，下一轮补写且 metas 不重复自增', async () => {
    const fake = createFake({
      articles: [{ id: 1, pathname: 'hello', deleted: false, viewer: 0, visited: 0 }],
      visits: [{ date: TODAY, pathname: '/post/hello', viewer: 5, visited: 1 }],
    });
    await record(fake.provider);
    await record(fake.provider);
    fake.failNext('visits.bulkWrite.inc');
    await fake.provider.flush('timer');
    // metas 与 articles 已经写成功了
    expect(fake.metas.docs[0].viewer).toBe(102);
    expect(fake.articles.docs[0].viewer).toBe(2);
    expect(fake.visits.docs[0].viewer).toBe(5);
    expect(fake.provider.counters.errors).toBe(1);

    await fake.provider.flush('retry');
    expect(fake.visits.docs[0]).toMatchObject({ viewer: 7 });
    // metas 不能被重复 +2
    expect(fake.metas.docs[0].viewer).toBe(102);
    expect(fake.articles.docs[0].viewer).toBe(2);
  });

  it('metas 写失败时只退回站点级增量（visits/articles 照常写）', async () => {
    const fake = createFake({
      articles: [{ id: 1, pathname: 'hello', deleted: false, viewer: 0, visited: 0 }],
      visits: [{ date: TODAY, pathname: '/post/hello', viewer: 5, visited: 1 }],
    });
    await record(fake.provider);
    fake.failNext('metas.findOneAndUpdate');
    await fake.provider.flush('timer');
    expect(fake.metas.docs[0].viewer).toBe(100);
    expect(fake.articles.docs[0].viewer).toBe(1);
    expect(fake.visits.docs[0].viewer).toBe(6);

    await fake.provider.flush('retry');
    expect(fake.metas.docs[0].viewer).toBe(101);
    // 文章与路径的增量不该被写第二遍
    expect(fake.articles.docs[0].viewer).toBe(1);
    expect(fake.visits.docs[0].viewer).toBe(6);
  });

  it('viewers 快照写失败会被记住，下一轮补写（哪怕那之后没有新浏览）', async () => {
    const fake = createFake();
    await record(fake.provider);
    fake.failNext('viewers.updateOne');
    await fake.provider.flush('timer');
    expect(fake.viewers.docs).toHaveLength(0);
    await fake.provider.flush('retry');
    expect(fake.viewers.docs.find((d) => d.date === TODAY)).toMatchObject({ viewer: 101 });
  });

  it('并发 seed 撞唯一索引（E11000）不算错误，增量照常写上去', async () => {
    const fake = createFake({
      visits: [{ date: YESTERDAY, pathname: '/post/hello', viewer: 42, visited: 7 }],
    });
    await record(fake.provider);
    fake.failNext('visits.dup');
    await fake.provider.flush('timer');
    expect(fake.provider.counters.errors).toBe(0);
    // seed 那一步"失败"了（别人先建好了），增量这一步仍然把行建了出来
    expect(fake.visits.docs.find((d) => d.date === TODAY)?.viewer).toBe(1);
  });

  it('优雅退出（onApplicationShutdown）会把待写入的计数落库', async () => {
    const fake = createFake({
      visits: [{ date: TODAY, pathname: '/post/hello', viewer: 5, visited: 1 }],
    });
    await record(fake.provider);
    await record(fake.provider);
    expect(fake.metas.docs[0].viewer).toBe(100);
    await fake.provider.onApplicationShutdown();
    expect(fake.metas.docs[0].viewer).toBe(102);
    expect(fake.visits.docs[0].viewer).toBe(7);
    // 幂等：再来一次不会重复写
    await fake.provider.onApplicationShutdown();
    expect(fake.metas.docs[0].viewer).toBe(102);
  });

  it('onModuleDestroy 也会 flush（app.close() 那条路）', async () => {
    const fake = createFake({
      visits: [{ date: TODAY, pathname: '/post/hello', viewer: 5, visited: 1 }],
    });
    await record(fake.provider);
    await fake.provider.onModuleDestroy();
    expect(fake.metas.docs[0].viewer).toBe(101);
  });
});

describe('ViewStatsProvider：VANBLOG_VIEW_FLUSH_MS=0（不缓冲）', () => {
  const OLD = process.env.VANBLOG_VIEW_FLUSH_MS;
  afterEach(() => {
    if (OLD === undefined) delete process.env.VANBLOG_VIEW_FLUSH_MS;
    else process.env.VANBLOG_VIEW_FLUSH_MS = OLD;
  });

  it('每次浏览立刻落库，单次浏览 8 → 5 次命令（没有合并效果，但也少了那几次多余的读）', async () => {
    process.env.VANBLOG_VIEW_FLUSH_MS = '0';
    const fake = createFake({
      articles: [{ id: 1, pathname: 'hello', deleted: false, viewer: 0, visited: 0 }],
      visits: [{ date: TODAY, pathname: '/post/hello', viewer: 5, visited: 1 }],
      viewers: [{ date: TODAY, viewer: 100, visited: 50 }],
    });
    expect(fake.provider.flushMs).toBe(0);
    await record(fake.provider);
    // 第一轮仍要确认当天那行在不在（aggregate）。注意没有 metas.findOne：
    // 不缓冲模式下 flush 先跑，base 直接取自 $inc 的返回值，投影不需要再读一次库
    expect(fake.log).toEqual([
      'metas.findOneAndUpdate',
      'articles.bulkWrite(1)',
      `visits.aggregate(["/post/hello"])`,
      'visits.bulkWrite.inc(1)',
      'viewers.updateOne',
    ]);
    expect(fake.metas.docs[0].viewer).toBe(101);
    fake.resetLog();
    await record(fake.provider);
    expect(fake.log).toEqual([
      'metas.findOneAndUpdate',
      'articles.bulkWrite(1)',
      `visits.aggregate(["/post/hello"])`,
      'visits.bulkWrite.inc(1)',
      'viewers.updateOne',
    ]);
    expect(fake.metas.docs[0].viewer).toBe(102);
    expect(fake.visits.docs[0].viewer).toBe(7);
  });

  it('非法值回落到默认的 5000ms（不能把 NaN 交给 setInterval）', () => {
    process.env.VANBLOG_VIEW_FLUSH_MS = 'abc';
    const fake = createFake();
    expect(fake.provider.flushMs).toBe(5000);
  });
});
