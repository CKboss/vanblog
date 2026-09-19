/**
 * `utils/dbLock.ts` 的语义测试。
 *
 * ⚠️ 这里的内存假集合**不是**"记录调用过什么"的 spy，而是忠实模拟 Mongo 在这条语句上的
 * 原子语义：`findOneAndUpdate({_id, expiresAt:{$lte:now}}, {$set}, {upsert:true})` 的三种结果
 * （匹配到过期锁 ⇒ 改写接管 / 匹配不到且不存在 ⇒ 插入成功 / 匹配不到但已存在 ⇒ duplicate key
 * E11000）。假实现内部不 await，所以一次操作对事件循环是原子的 —— 与 Mongo 的单文档原子性一致，
 * 于是 `Promise.all([acquire(), acquire()])` 这种**真并发形状**能测出"恰好一个赢"。
 * 只用 spy 断言"调用过 findOneAndUpdate"是测不出竞态的（本仓库已有先例：断言"某符号出现"
 * 是空断言，import 行就能让它过）。
 */
import {
  acquireDbLock,
  releaseDbLock,
  initLockTtlMs,
  DB_LOCK_COLLECTION,
  INIT_RESTORE_LOCK_NAME,
  INIT_LOCK_TTL_MINUTES_ENV,
  DEFAULT_INIT_LOCK_TTL_MINUTES,
  LockCollection,
} from './dbLock';

interface FakeOptions {
  /** 返回 `{value: doc}` 而不是 `doc`（老驱动/包装层的形状） */
  wrapValue?: boolean;
  /** 不提供 deleteOne（逼 releaseDbLock 走 findOneAndUpdate 兜底） */
  noDeleteOne?: boolean;
  /** findOneAndUpdate 抛这个错（用来测 unavailable 与各种 E11000 形状） */
  throwWith?: any;
}

function makeFake(opts: FakeOptions = {}) {
  const docs = new Map<string, any>();
  let clock = 1_700_000_000_000;

  const coll: LockCollection & {
    _docs: Map<string, any>;
    now: () => number;
    advance: (ms: number) => void;
    setNow: (ms: number) => void;
  } = {
    _docs: docs,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    setNow: (ms: number) => {
      clock = ms;
    },
    // ⚠️ 内部无 await ⇒ 对事件循环原子，等价于 Mongo 的单文档原子操作
    async findOneAndUpdate(filter: any, update: any, options?: any) {
      if (opts.throwWith !== undefined) throw opts.throwWith;
      const id = filter?._id;
      const existing = id === undefined ? undefined : docs.get(String(id));
      const set = update?.$set ?? {};
      const matches = (doc: any) => {
        if (!doc) return false;
        const cond = filter?.expiresAt;
        if (cond && typeof cond.$lte === 'number') return Number(doc.expiresAt) <= cond.$lte;
        for (const k of Object.keys(filter ?? {})) {
          if (k === '_id') continue;
          if (doc[k] !== filter[k]) return false;
        }
        return true;
      };
      if (existing && matches(existing)) {
        Object.assign(existing, set);
        const out = opts.wrapValue ? { value: { ...existing } } : { ...existing };
        return out;
      }
      if (existing) {
        // 匹配不到但文档存在 ⇒ upsert 会撞同一个 _id
        const err: any = new Error('E11000 duplicate key error collection: vanblog.vanblog_locks');
        err.code = 11000;
        throw err;
      }
      if (options?.upsert) {
        const doc: any = { _id: String(id), ...set };
        docs.set(String(id), doc);
        return opts.wrapValue ? { value: { ...doc } } : { ...doc };
      }
      return opts.wrapValue ? { value: null } : null;
    },
    async deleteOne(filter: any) {
      if (opts.noDeleteOne) throw new Error('deleteOne is not a function');
      const id = String(filter?._id);
      const existing = docs.get(id);
      if (!existing) return { deletedCount: 0 };
      for (const k of Object.keys(filter ?? {})) {
        if (k === '_id') continue;
        if (existing[k] !== filter[k]) return { deletedCount: 0 };
      }
      docs.delete(id);
      return { deletedCount: 1 };
    },
  } as any;

  if (opts.noDeleteOne) delete (coll as any).deleteOne;
  return coll;
}

const NAME = INIT_RESTORE_LOCK_NAME;

describe('dbLock：互斥语义', () => {
  it('空库上第一次抢到，第二次被拒（顺序形状）', async () => {
    const coll = makeFake();
    const a = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    expect(a.kind).toBe('acquired');
    const b = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    expect(b.kind).toBe('busy');
    expect(coll._docs.size).toBe(1); // ⚠️ 只有一个锁文档：唯一性靠 _id，不是插了两条
  });

  it('⚠️ 真并发：Promise.all 两个 acquire 恰好一个赢', async () => {
    const coll = makeFake();
    const rs = await Promise.all([
      acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now }),
      acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now }),
    ]);
    const won = rs.filter((r) => r.kind === 'acquired');
    const lost = rs.filter((r) => r.kind === 'busy');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(coll._docs.size).toBe(1);
  });

  it('⚠️ 真并发：8 个 worker 同时抢，恰好 1 个赢（cluster 的实际形状）', async () => {
    const coll = makeFake();
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now })),
    );
    expect(rs.filter((r) => r.kind === 'acquired')).toHaveLength(1);
    expect(rs.filter((r) => r.kind === 'busy')).toHaveLength(7);
    expect(coll._docs.size).toBe(1);
  });

  it('不同锁名互不影响（锁是按 _id 分的）', async () => {
    const coll = makeFake();
    expect((await acquireDbLock(coll, 'a', { now: coll.now })).kind).toBe('acquired');
    expect((await acquireDbLock(coll, 'b', { now: coll.now })).kind).toBe('acquired');
    expect(coll._docs.size).toBe(2);
  });
});

describe('dbLock：过期锁必须能被接管', () => {
  it('TTL 内抢不到，过期后能抢到，且 owner 换人', async () => {
    const coll = makeFake();
    const a = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    expect(a.kind).toBe('acquired');

    coll.advance(30_000); // 还没过期
    expect((await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now })).kind).toBe('busy');

    coll.advance(31_000); // 已过 61 秒 > TTL
    const b = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    expect(b.kind).toBe('acquired');
    if (a.kind === 'acquired' && b.kind === 'acquired') {
      expect(b.handle.owner).not.toBe(a.handle.owner);
    }
    // ⚠️ 接管是**改写同一个文档**，不是又插一条
    expect(coll._docs.size).toBe(1);
  });

  it('进程被硬杀（不释放）之后，锁不会永久卡死 —— 等到 TTL 就能重试', async () => {
    const coll = makeFake();
    const a = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    expect(a.kind).toBe('acquired');
    // 不调用 releaseDbLock，模拟 SIGKILL / OOM
    coll.advance(61_000);
    const b = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    expect(b.kind).toBe('acquired');
  });
});

describe('dbLock：释放必须校验持有者', () => {
  it('持有者能释放，释放后能再抢', async () => {
    const coll = makeFake();
    const a = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    expect(a.kind).toBe('acquired');
    if (a.kind !== 'acquired') return;
    expect(await releaseDbLock(coll, NAME, a.handle.owner)).toBe(true);
    expect(coll._docs.size).toBe(0);
    expect((await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now })).kind).toBe('acquired');
  });

  it('⚠️ 别人的锁删不掉（owner 不匹配 ⇒ deletedCount 0，文档还在）', async () => {
    const coll = makeFake();
    const a = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    if (a.kind !== 'acquired') throw new Error('前置失败');
    expect(await releaseDbLock(coll, NAME, 'someone-else')).toBe(false);
    expect(coll._docs.size).toBe(1);
    expect(coll._docs.get(NAME).owner).toBe(a.handle.owner);
    // 锁仍然有效：第三者抢不到
    expect((await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now })).kind).toBe('busy');
  });

  it('⚠️ A 超时被 B 接管后，A 姗姗来迟的 finally 不会把 B 的锁删掉', async () => {
    const coll = makeFake();
    const a = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    if (a.kind !== 'acquired') throw new Error('前置失败');
    coll.advance(61_000);
    const b = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    if (b.kind !== 'acquired') throw new Error('接管失败');
    // A 现在才释放
    expect(await releaseDbLock(coll, NAME, a.handle.owner)).toBe(false);
    expect(coll._docs.get(NAME).owner).toBe(b.handle.owner); // B 的锁还在
    expect((await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now })).kind).toBe('busy');
    // B 自己释放是可以的
    expect(await releaseDbLock(coll, NAME, b.handle.owner)).toBe(true);
  });

  it('没有 deleteOne 的包装层也能释放（走 findOneAndUpdate 兜底）', async () => {
    const coll = makeFake({ noDeleteOne: true });
    const a = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    if (a.kind !== 'acquired') throw new Error('前置失败');
    expect(await releaseDbLock(coll, NAME, a.handle.owner)).toBe(true);
    const doc = coll._docs.get(NAME);
    expect(doc.owner).toBe(''); // 已清空 ⇒ 下一次 acquire 能立刻接管
    expect(doc.expiresAt).toBe(0);
    expect((await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now })).kind).toBe('acquired');
  });

  it('owner 为空/非字符串时拒绝释放（不许变成"删掉任何锁"）', async () => {
    const coll = makeFake();
    const a = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    if (a.kind !== 'acquired') throw new Error('前置失败');
    expect(await releaseDbLock(coll, NAME, '')).toBe(false);
    expect(await releaseDbLock(coll, NAME, undefined as any)).toBe(false);
    expect(coll._docs.size).toBe(1);
  });
});

describe('dbLock：三态结果与故障归一', () => {
  it('没有集合 / 集合形状不对 ⇒ unavailable（不是 busy，也不是 acquired）', async () => {
    expect((await acquireDbLock(null, NAME)).kind).toBe('unavailable');
    expect((await acquireDbLock(undefined, NAME)).kind).toBe('unavailable');
    expect((await acquireDbLock({} as any, NAME)).kind).toBe('unavailable');
  });

  it('后端抛非 duplicate 错误 ⇒ unavailable（绝不假装自己拿到了锁）', async () => {
    const coll = makeFake({ throwWith: new Error('connect ECONNREFUSED') });
    const r = await acquireDbLock(coll, NAME);
    expect(r.kind).toBe('unavailable');
    if (r.kind === 'unavailable') expect(r.reason).toContain('ECONNREFUSED');
  });

  it('各种 E11000 形状都判成 busy（不是 unavailable）', async () => {
    const shapes: any[] = [
      Object.assign(new Error('dup'), { code: 11000 }),
      Object.assign(new Error('dup'), { code: 'E11000' }),
      new Error('E11000 duplicate key error collection'),
      Object.assign(new Error('wrapped'), { cause: { code: 11000 } }),
      Object.assign(new Error('wrapped'), { cause: { codeName: 'DuplicateKey' } }),
      Object.assign(new Error('x'), { errInfo: { code: 11000 } }),
    ];
    for (const err of shapes) {
      const coll = makeFake({ throwWith: err });
      expect((await acquireDbLock(coll, NAME)).kind).toBe('busy');
    }
  });

  it('驱动返回 {value: doc} 形状也算抢到', async () => {
    const coll = makeFake({ wrapValue: true });
    const r = await acquireDbLock(coll, NAME, { ttlMs: 60_000, now: coll.now });
    expect(r.kind).toBe('acquired');
  });

  it('⚠️ 返回的文档 owner 不是自己 ⇒ 判 busy（防御 returnDocument 语义差异）', async () => {
    const coll = makeFake();
    // 先塞一条**已过期**的锁，但让 findOneAndUpdate 返回别人的文档
    coll._docs.set(NAME, { _id: NAME, owner: 'other', expiresAt: 1 });
    const orig = coll.findOneAndUpdate.bind(coll);
    (coll as any).findOneAndUpdate = async (...args: any[]) => {
      await orig(...args);
      return { owner: 'other', expiresAt: Date.now() + 9999 }; // 谎报：返回的是别人的文档
    };
    expect((await acquireDbLock(coll, NAME, { now: coll.now })).kind).toBe('busy');
  });

  it('匹配不到又没插入（驱动返回 null）⇒ 判 busy，不假设自己拿到了', async () => {
    const coll = makeFake();
    (coll as any).findOneAndUpdate = async () => null;
    expect((await acquireDbLock(coll, NAME)).kind).toBe('busy');
  });
});

describe('dbLock：TTL 解析（写错值绝不变成"永不过期"）', () => {
  const MIN = 60_000;
  it('默认 30 分钟', () => {
    expect(DEFAULT_INIT_LOCK_TTL_MINUTES).toBe(30);
    expect(initLockTtlMs(undefined)).toBe(30 * MIN);
    expect(initLockTtlMs('')).toBe(30 * MIN);
  });
  it('合法值按分钟换算', () => {
    expect(initLockTtlMs('5')).toBe(5 * MIN);
    expect(initLockTtlMs(1)).toBe(MIN);
    expect(initLockTtlMs(' 12 ')).toBe(12 * MIN);
  });
  it('0 / 负数 / 非数字 / Infinity ⇒ 回落默认', () => {
    for (const v of ['0', 0, '-5', 'abc', 'NaN', Infinity, -Infinity, null, {}]) {
      expect(initLockTtlMs(v as any)).toBe(30 * MIN);
    }
  });
  it('上下限夹取：最小 1 分钟、最大 1440 分钟', () => {
    expect(initLockTtlMs('0.2')).toBe(MIN); // trunc(0.2)=0 → 回落默认？不：0.2>0 ⇒ trunc=0 ⇒ 夹到 1
    expect(initLockTtlMs('99999')).toBe(1440 * MIN);
    expect(initLockTtlMs('1440')).toBe(1440 * MIN);
  });
  it('环境变量名与默认值都对得上代码（守卫会查"文案里的变量名必须真被读到"）', () => {
    expect(INIT_LOCK_TTL_MINUTES_ENV).toBe('VANBLOG_INIT_LOCK_TTL_MINUTES');
    const prev = process.env[INIT_LOCK_TTL_MINUTES_ENV];
    try {
      process.env[INIT_LOCK_TTL_MINUTES_ENV] = '7';
      expect(initLockTtlMs()).toBe(7 * MIN); // 不传参 ⇒ 真读环境变量
      process.env[INIT_LOCK_TTL_MINUTES_ENV] = 'nonsense';
      expect(initLockTtlMs()).toBe(30 * MIN);
    } finally {
      if (prev === undefined) delete process.env[INIT_LOCK_TTL_MINUTES_ENV];
      else process.env[INIT_LOCK_TTL_MINUTES_ENV] = prev;
    }
  });
  it('ttlMs 传 0/负数时回落到解析值，不会造出"立刻过期"的锁', async () => {
    const coll = makeFake();
    const r = await acquireDbLock(coll, NAME, { ttlMs: 0, now: coll.now });
    expect(r.kind).toBe('acquired');
    if (r.kind === 'acquired') {
      expect(r.handle.expiresAt - coll.now()).toBe(30 * MIN);
    }
    // 锁在 TTL 内确实有效
    expect((await acquireDbLock(coll, NAME, { ttlMs: 0, now: coll.now })).kind).toBe('busy');
  });
});

describe('dbLock：集合与锁名的选择（有理由，别随手改）', () => {
  it('锁落在独立集合，不是 settings（settings 会被整站备份导出/恢复覆盖）', () => {
    expect(DB_LOCK_COLLECTION).toBe('vanblog_locks');
    expect(DB_LOCK_COLLECTION).not.toBe('settings');
    expect(DB_LOCK_COLLECTION).not.toBe('metas');
  });
  it('初始化与恢复共用同一个锁名（它们互斥的是同一件事：站点身份的确立）', () => {
    expect(INIT_RESTORE_LOCK_NAME).toBe('init-restore');
  });
  it('owner 是随机串，两次 acquire 不会撞（否则释放校验形同虚设）', async () => {
    const coll = makeFake();
    const a = await acquireDbLock(coll, 'x', { now: coll.now });
    const b = await acquireDbLock(coll, 'y', { now: coll.now });
    expect(a.kind).toBe('acquired');
    expect(b.kind).toBe('acquired');
    if (a.kind === 'acquired' && b.kind === 'acquired') {
      expect(a.handle.owner).not.toBe(b.handle.owner);
      expect(a.handle.owner.length).toBeGreaterThan(12);
    }
  });
});
