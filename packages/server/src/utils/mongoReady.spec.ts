import {
  waitForMongoReady,
  describeReadyState,
  MONGO_READY_TIMEOUT_ENV,
  MONGO_READY_POLL_ENV,
  MONGO_READY_TIMEOUT_MS_DEFAULT,
  MONGO_READY_POLL_MS_DEFAULT,
  MongoReadyConnectionLike,
} from './mongoReady';

/**
 * 「启动期等数据库就绪」这道闸门的行为。
 *
 * 它存在的理由是一次实测事故：容器重启后 mongo 还在重连（health 仍 503），启动全量 ISR
 * 渲染立刻开跑并失败，把固定 6×3s ≈ 18 秒的重试窗口烧光后**永久放弃**那一轮预热。
 * 站点还能服务（ISR 缓存 + 按需渲染），但没有预热 —— 在敌意环境下，任何能让容器重启的
 * 手段都可能把站点长期留在"每页都靠访客第一次访问现场渲染"的状态。
 *
 * ⚠️ 所有用例都用**假时钟 + 假 sleep**：这个函数的默认上限是 60 秒，真睡的话一个用例
 *    就是一分钟（本仓库有过单个 spec 跑 400+ 秒拖垮 CI 的先例）。
 */

/** 可编程的假时钟：每次 sleep 把时间推进相应的毫秒数。 */
function makeFakeTime(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleepFn: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    get elapsed() {
      return t - start;
    },
  };
}

function makeConn(overrides: Partial<MongoReadyConnectionLike> = {}) {
  return { readyState: 1, db: { admin: () => ({ ping: async () => ({ ok: 1 }) }) }, ...overrides };
}

describe('waitForMongoReady：就绪判定', () => {
  it('readyState=1 且 ping 成功 ⇒ 立刻就绪，一次轮询、零等待', async () => {
    const clock = makeFakeTime();
    const r = await waitForMongoReady(makeConn(), {
      now: clock.now,
      sleepFn: clock.sleepFn,
    });
    expect(r).toMatchObject({ ready: true, reason: 'ready', waitedMs: 0, polls: 1 });
    expect(clock.sleeps).toEqual([]);
  });

  it('readyState=1 但 ping 失败 ⇒ 不算就绪（驱动自认为连着不代表服务端应答）', async () => {
    const clock = makeFakeTime();
    const ping = jest.fn().mockRejectedValue(new Error('server selection timeout'));
    const r = await waitForMongoReady(
      { readyState: 1, db: { admin: () => ({ ping }) } },
      { now: clock.now, sleepFn: clock.sleepFn, timeoutMs: 3000, pollMs: 1000 },
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('timeout');
    expect(ping.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['readyState=2（连接中）', 2],
    ['readyState=0（已断开）', 0],
    ['readyState=3（断开中）', 3],
  ])('%s ⇒ 不就绪，且**不会**去 ping（还没连上就没有 db）', async (_label, state) => {
    const clock = makeFakeTime();
    const ping = jest.fn().mockResolvedValue({ ok: 1 });
    const r = await waitForMongoReady(
      { readyState: state, db: { admin: () => ({ ping }) } },
      { now: clock.now, sleepFn: clock.sleepFn, timeoutMs: 2000, pollMs: 1000 },
    );
    expect(r.ready).toBe(false);
    expect(r.lastReadyState).toBe(state);
    expect(ping).not.toHaveBeenCalled();
  });

  it('db 还没挂上（已连接但 db 为 null）⇒ 当"还没就绪"，下一轮再看', async () => {
    const clock = makeFakeTime();
    let calls = 0;
    const conn: MongoReadyConnectionLike = {
      readyState: 1,
      get db() {
        calls += 1;
        return calls <= 2 ? null : { admin: () => ({ ping: async () => ({ ok: 1 }) }) };
      },
    };
    const r = await waitForMongoReady(conn, {
      now: clock.now,
      sleepFn: clock.sleepFn,
      timeoutMs: 10000,
      pollMs: 1000,
    });
    expect(r.ready).toBe(true);
    expect(r.polls).toBe(3);
  });

  it('conn 传 null/undefined 也不抛（启动期拿不到连接对象时应超时而不是崩）', async () => {
    const clock = makeFakeTime();
    for (const bad of [null, undefined]) {
      const r = await waitForMongoReady(bad as any, {
        now: clock.now,
        sleepFn: clock.sleepFn,
        timeoutMs: 1000,
        pollMs: 500,
      });
      expect(r.ready).toBe(false);
      expect(r.reason).toBe('timeout');
    }
  });
});

describe('waitForMongoReady：等待与超时', () => {
  it('库在第 3 轮才就绪 ⇒ 真的等到了，waitedMs 与轮数都对', async () => {
    const clock = makeFakeTime();
    let polls = 0;
    // ⚠️ 用**轮询次数**驱动状态变化，不要用 ping 的调用次数：readyState 不为 1 时
    //    probeOnce 会短路、根本不去 ping，那种 fixture 永远等不到就绪（我第一版就这么写错了）。
    const conn: MongoReadyConnectionLike = {
      get readyState() {
        return polls >= 2 ? 1 : 2;
      },
      db: { admin: () => ({ ping: async () => ({ ok: 1 }) }) },
    };
    const r = await waitForMongoReady(conn, {
      now: clock.now,
      sleepFn: async (ms) => {
        polls += 1;
        await clock.sleepFn(ms);
      },
      timeoutMs: 60000,
      pollMs: 1000,
    });
    expect(r).toMatchObject({ ready: true, reason: 'ready', polls: 3, waitedMs: 2000 });
    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  it('超时 ⇒ ready:false + reason:timeout，**不抛异常**（调用方要继续启动）', async () => {
    const clock = makeFakeTime();
    const r = await waitForMongoReady({ readyState: 2 }, {
      now: clock.now,
      sleepFn: clock.sleepFn,
      timeoutMs: 5000,
      pollMs: 1000,
    } as any);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('timeout');
    expect(r.waitedMs).toBe(5000);
    expect(r.polls).toBe(6); // 第 0/1/2/3/4 秒各探一次，第 5 秒判定超时
  });

  it('最后一轮只睡"剩下的时间"，不会多睡一整轮把总等待拉过上限', async () => {
    const clock = makeFakeTime();
    const r = await waitForMongoReady({ readyState: 0 }, {
      now: clock.now,
      sleepFn: clock.sleepFn,
      timeoutMs: 2500,
      pollMs: 1000,
    } as any);
    expect(clock.sleeps).toEqual([1000, 1000, 500]);
    expect(r.waitedMs).toBe(2500);
  });

  it('timeoutMs=0（编程传入）⇒ 只探一次、完全不睡', async () => {
    const clock = makeFakeTime();
    const r = await waitForMongoReady({ readyState: 0 }, {
      now: clock.now,
      sleepFn: clock.sleepFn,
      timeoutMs: 0,
      pollMs: 1000,
    } as any);
    expect(r.polls).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(r.ready).toBe(false);
  });

  it('进度回调按 progressEveryMs 节流（默认 5 秒），不是每秒刷一行', async () => {
    const clock = makeFakeTime();
    const seen: Array<[number, string]> = [];
    await waitForMongoReady(
      { readyState: 2 },
      {
        now: clock.now,
        sleepFn: clock.sleepFn,
        timeoutMs: 12000,
        pollMs: 1000,
        onProgress: (ms, state) => seen.push([ms, state]),
      } as any,
    );
    // 0s、5s、10s 各一次（12s 超时前）
    expect(seen.map((x) => x[0])).toEqual([0, 5000, 10000]);
    expect(seen[0][1]).toBe('2（连接中）');
  });
});

describe('waitForMongoReady：环境变量', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('未设置时用默认值：轮询 1 秒、总上限 60 秒', async () => {
    delete process.env[MONGO_READY_TIMEOUT_ENV];
    delete process.env[MONGO_READY_POLL_ENV];
    expect(MONGO_READY_TIMEOUT_MS_DEFAULT).toBe(60000);
    expect(MONGO_READY_POLL_MS_DEFAULT).toBe(1000);
    const clock = makeFakeTime();
    const r = await waitForMongoReady({ readyState: 0 }, {
      now: clock.now,
      sleepFn: clock.sleepFn,
    } as any);
    // 永远不就绪 ⇒ 一直等到默认上限，且每次都是默认轮询间隔
    expect(r.waitedMs).toBe(MONGO_READY_TIMEOUT_MS_DEFAULT);
    expect(r.polls).toBe(61); // 第 0..59 秒各探一次 + 第 60 秒判定超时
    expect(new Set(clock.sleeps)).toEqual(new Set([MONGO_READY_POLL_MS_DEFAULT]));
  });

  it.each([
    ['合法值', '5000', 5000],
    ['垃圾值回落默认（绝不当成 0）', 'abc', MONGO_READY_TIMEOUT_MS_DEFAULT],
    ['0 回落默认（envNumber 的既定规则：≤0 ⇒ fallback）', '0', MONGO_READY_TIMEOUT_MS_DEFAULT],
    ['负数回落默认', '-1', MONGO_READY_TIMEOUT_MS_DEFAULT],
    ['超上限被夹住', '99999999', 3600000],
  ])('%s ⇒ %s', async (_label, raw, expected) => {
    process.env[MONGO_READY_TIMEOUT_ENV] = raw;
    const clock = makeFakeTime();
    const r = await waitForMongoReady({ readyState: 0 }, {
      now: clock.now,
      sleepFn: clock.sleepFn,
      pollMs: expected > 0 ? Math.max(50, Math.floor(expected / 2)) : 50,
    } as any);
    // 超上限被夹到 3600000 时不真跑满：这里只断言"没有变成 0/无限"这个性质
    expect(r.reason).toBe('timeout');
    expect(r.waitedMs).toBeGreaterThan(0);
    if (raw === '5000') expect(r.waitedMs).toBe(expected);
  });

  it('⚠️ 环境变量写 0 得到的是**默认 60 秒**而不是"不等"（这条差异必须钉住）', async () => {
    process.env[MONGO_READY_TIMEOUT_ENV] = '0';
    const clock = makeFakeTime();
    const r = await waitForMongoReady({ readyState: 0 }, {
      now: clock.now,
      sleepFn: clock.sleepFn,
      pollMs: 30000,
    } as any);
    expect(r.waitedMs).toBe(MONGO_READY_TIMEOUT_MS_DEFAULT);
    expect(r.waitedMs).not.toBe(0);
  });
});

describe('describeReadyState', () => {
  it('四种已知状态各有可读文案，未知值原样带出', () => {
    expect(describeReadyState(0)).toBe('0（已断开）');
    expect(describeReadyState(1)).toBe('1（已连接）');
    expect(describeReadyState(2)).toBe('2（连接中）');
    expect(describeReadyState(3)).toBe('3（断开中）');
    expect(describeReadyState(9)).toBe('9');
    expect(describeReadyState(undefined)).toBe('未知');
  });
});
