import {
  createKeyedSingleFlight,
  KeyedSingleFlight,
  KEYED_SINGLE_FLIGHT_DEFAULT_TTL_MS,
  KEYED_SINGLE_FLIGHT_MAX_TTL_MS,
} from './keyedSingleFlight';

/**
 * 每个用例一份**独立**的实例（工厂返回的对象自带自己的两个 Map）。
 * ⚠️ 这本身就是"实例级而不是模块级"这个设计选择的好处：用例之间天然隔离，不需要全局 clear。
 */
let sf: KeyedSingleFlight;

/**
 * `utils/keyedSingleFlight.ts` 的性质守卫。
 *
 * 🔴 **为什么全部用假定时器而不是真等待**：这个模块的语义就是"在 TTL 内复用、过期后重取"，
 * 用真实的 `setTimeout`/`sleep` 去测它会得到**依赖调度延迟的断言** —— 本仓库已经为此栽过：
 * `loginThrottle.spec.ts` 曾用 `expect(Date.now()-started).toBeLessThan(80)` 区分"睡没睡"，
 * 在全量并行负载下收到过**恰好 80** 而假红（而它的对照断言下界也是 80，两者只差一个数字）。
 * 假定时器让"过期"变成一个可以精确推进的量，断言与时钟无关。
 *
 * ⚠️ **本项目 `@types/jest` 缺 `advanceTimersByTimeAsync` 的类型**（运行时 jest 29.5 有它），
 * 用它会得到 TS2551 并让整个套件 "failed to run"（而那一行的 `Tests:` 数字属于别的文件，
 * 看起来像通过）。所以这里用**同步的 `advanceTimersByTime` + 显式冲微任务**。
 */

/** 推进假时间之后，把已经 resolve 的 promise 链冲刷干净。 */
async function flushMicrotasks(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

/** 推进假时间并冲微任务（等价于 async 版 advanceTimersByTime）。 */
async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

/** 造一个可计数、可控成败的 loader。 */
function makeLoader<T>(value: T) {
  const calls: number[] = [];
  const fn = jest.fn(async () => {
    calls.push(Date.now());
    return value;
  });
  return { fn, calls };
}

describe('keyedSingleFlight：单飞（这是它存在的唯一理由）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    sf = createKeyedSingleFlight();
  });
  afterEach(() => {
    sf.clear();
    jest.useRealTimers();
  });

  it('尺子有效性：loader 真的被调用了（否则下面所有"只调 1 次"都可能是空转）', async () => {
    const { fn } = makeLoader({ ok: 1 });
    await sf.read('ruler', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sf.stats().cached).toBe(1);
  });

  it('🔴 N 个并发请求 ⇒ loader 只被调用 1 次，且 N 个都拿到同一份结果', async () => {
    const payload = { list: ['a', 'b', 'c'] };
    const { fn } = makeLoader(payload);
    const N = 50;
    // 关键：**不 await** 地同时发起，让它们全部落在同一个 in-flight 窗口里
    const all = Array.from({ length: N }, () => sf.read('concurrent', fn));
    // 此刻还没有任何一个 resolve（loader 是 async）
    expect(fn).toHaveBeenCalledTimes(1);
    const results = await Promise.all(all);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(N);
    // 🔴 全部是**同一个对象引用** ⇒ 证明它们复用的是同一份结果，而不是各取了一份相等的副本
    for (const r of results) {
      expect(r).toBe(payload);
    }
  });

  it('并发期间 in-flight 计数为 1，落地后归零（不会泄漏成永久挂起）', async () => {
    const { fn } = makeLoader('v');
    const p = sf.read('inflight', fn);
    expect(sf.stats().inFlight).toBe(1);
    await p;
    expect(sf.stats().inFlight).toBe(0);
  });

  it('TTL 内的第二次调用命中缓存，不再调 loader', async () => {
    const { fn } = makeLoader('v1');
    await sf.read('ttl', fn);
    await advance(1000); // 远小于默认 5 秒
    const second = await sf.read('ttl', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(second).toBe('v1');
  });

  it('🔴 TTL 过期后重新调用 loader（否则它就变成永久缓存了）', async () => {
    const first = makeLoader('v1');
    await sf.read('expire', first.fn);
    expect(first.fn).toHaveBeenCalledTimes(1);

    await advance(KEYED_SINGLE_FLIGHT_DEFAULT_TTL_MS + 1);
    const second = makeLoader('v2');
    const got = await sf.read('expire', second.fn);
    expect(second.fn).toHaveBeenCalledTimes(1);
    expect(got).toBe('v2');
  });

  it('反证：推进到 TTL 之前的最后一毫秒仍然命中（尺子对边界敏感，不是"推进任意时间都算过期"）', async () => {
    const { fn } = makeLoader('v1');
    await sf.read('boundary', fn);
    await advance(KEYED_SINGLE_FLIGHT_DEFAULT_TTL_MS - 1);
    await sf.read('boundary', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    await advance(2);
    await sf.read('boundary', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('keyedSingleFlight：失败方向（两条都是硬要求）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    sf = createKeyedSingleFlight();
  });
  afterEach(() => {
    sf.clear();
    jest.useRealTimers();
  });

  it('🔴 loader 抛错时**不缓存错误**：下一次请求会重新尝试并能成功', async () => {
    let attempt = 0;
    const loader = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('mongo 抖了一下');
      return 'recovered';
    });
    await expect(sf.read('err', loader)).rejects.toThrow('mongo 抖了一下');
    // 🔴 关键判据：如果错误被缓存了，这次会直接拿到缓存的失败而**不再调用 loader**
    const got = await sf.read('err', loader);
    expect(got).toBe('recovered');
    expect(loader).toHaveBeenCalledTimes(2);
    expect(sf.stats().cached).toBe(1); // 只有成功那次进了缓存
  });

  it('🔴 loader 抛错后 in-flight 记录被清掉（否则该 key 永久挂起）', async () => {
    const loader = jest.fn(async () => {
      throw new Error('boom');
    });
    await expect(sf.read('leak', loader)).rejects.toThrow('boom');
    expect(sf.stats().inFlight).toBe(0);
    // 再发一次仍然会真的去调 loader（而不是 await 一个早已 rejected 的旧 promise）
    await expect(sf.read('leak', loader)).rejects.toThrow('boom');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('失败时所有等待者都拿到 rejection（快速失败），而不是无限等', async () => {
    const loader = jest.fn(async () => {
      await flushMicrotasks(3);
      throw new Error('shared failure');
    });
    const all = Array.from({ length: 5 }, () => sf.read('waiters', loader));
    const settled = await Promise.allSettled(all);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(5);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(sf.stats().inFlight).toBe(0);
  });
});

describe('keyedSingleFlight：键隔离（漏掉一个参数就是越权泄漏）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    sf = createKeyedSingleFlight();
  });
  afterEach(() => {
    sf.clear();
    jest.useRealTimers();
  });

  it('🔴 不同的键 ⇒ 各自独立取数，绝不共享条目', async () => {
    const a = makeLoader('public-view');
    const b = makeLoader('admin-view');
    const gotA = await sf.read('k|a', a.fn);
    const gotB = await sf.read('k|b', b.fn);
    expect(gotA).toBe('public-view');
    expect(gotB).toBe('admin-view');
    expect(a.fn).toHaveBeenCalledTimes(1);
    expect(b.fn).toHaveBeenCalledTimes(1);
    expect(sf.stats().cached).toBe(2);
  });

  it('🔴 反向对照：相同的键**确实**会共享（否则上面那条"不同键不共享"可能是空断言）', async () => {
    const { fn } = makeLoader('shared');
    await sf.read('same|key', fn);
    const again = await sf.read('same|key', fn);
    expect(again).toBe('shared');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sf.stats().cached).toBe(1);
  });

  it('空键被拒绝（空键会让所有调用方退化成共享一个全局单槽）', async () => {
    const { fn } = makeLoader('v');
    await expect(sf.read('', fn)).rejects.toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('keyedSingleFlight：TTL 取值的失败方向', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    sf = createKeyedSingleFlight();
  });
  afterEach(() => {
    sf.clear();
    jest.useRealTimers();
  });

  it('🔴 超大 TTL 被夹到上限（写错一个零不会让公开列表永久陈旧）', async () => {
    const { fn } = makeLoader('v1');
    await sf.read('clamp', fn, 10 * 60 * 1000); // 想写 10 分钟
    // 推进到上限之内 ⇒ 仍然命中
    await advance(KEYED_SINGLE_FLIGHT_MAX_TTL_MS - 1000);
    await sf.read('clamp', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    // 推进过上限 ⇒ 必须重新取数（证明它被夹住了，而不是真的缓存 10 分钟）
    await advance(2000);
    await sf.read('clamp', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('🔴 非法 TTL（NaN / 负数）落回默认值，而不是变成"永不过期"', async () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      sf.clear();
      const { fn } = makeLoader('v');
      await sf.read(`bad-${String(bad)}`, fn, bad as number);
      await advance(KEYED_SINGLE_FLIGHT_DEFAULT_TTL_MS + 1);
      await sf.read(`bad-${String(bad)}`, fn, bad as number);
      // 如果非法值被当成"永不过期"，这里会是 1
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('TTL=0 表示"不缓存"：每次都重新取数（这是合法配置，不是错误）', async () => {
    const { fn } = makeLoader('v');
    await sf.read('zero', fn, 0);
    await sf.read('zero', fn, 0);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
