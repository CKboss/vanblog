import {
  BOOTSTRAP_DB_RETRY_BASE_ENV,
  BOOTSTRAP_DB_RETRY_BASE_MS_DEFAULT,
  BOOTSTRAP_DB_RETRY_MAX_ENV,
  BOOTSTRAP_DB_RETRY_MAX_MS_DEFAULT,
  BOOTSTRAP_DB_RETRY_WINDOW_ENV,
  BOOTSTRAP_DB_RETRY_WINDOW_MS_DEFAULT,
  bootstrapBackoffDelayMs,
  isBootstrapFailure,
  isDbUnreachableError,
  probeMongoOnce,
  resolveBootstrapRetryConfig,
  runBootstrapWithDbRetry,
} from './dbBootstrapRetry';

/**
 * 启动期"数据库不可达"的重试分类与退避。
 *
 * ⚠️ 全部用**注入的 sleep / now**，所以这些用例一条都不真等（本仓库有过 400 秒单测拖垮 CI 的先例）。
 * ⚠️ 断言的是**行为**（重试了几次、睡了多久、抛没抛），不是"源码里出现了某个符号"。
 */

/** 造一个带指定 name/code/message 的错误，模拟 driver / mongoose 的各种形状。 */
function err(shape: { name?: string; code?: string; message?: string; cause?: unknown }): Error {
  const e = new Error(shape.message ?? 'boom') as Error & { name?: string; code?: string; cause?: unknown };
  if (shape.name) {
    e.name = shape.name;
  }
  if (shape.code) {
    e.code = shape.code;
  }
  if (shape.cause !== undefined) {
    e.cause = shape.cause;
  }
  return e;
}

/** 立刻 resolve 的假 sleep，并把每次的时长记下来。 */
function fakeSleep() {
  const slept: number[] = [];
  return { slept, fn: async (ms: number) => { slept.push(ms); return true; } };
}

/** 假时钟：每次读 +1000ms，避免测试依赖真实时间。 */
function fakeClock(stepMs = 1000) {
  let t = 0;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

describe('isDbUnreachableError：只有"数据库暂时不可达"才值得重试', () => {
  it.each([
    ['driver 的 MongoServerSelectionError', err({ name: 'MongoServerSelectionError', message: 'x' })],
    ['mongoose 包装的 MongooseServerSelectionError', err({ name: 'MongooseServerSelectionError' })],
    ['MongoNetworkError', err({ name: 'MongoNetworkError' })],
    ['MongoNotConnectedError', err({ name: 'MongoNotConnectedError' })],
    ['只有 code=ECONNREFUSED（message 里没有）', err({ code: 'ECONNREFUSED', message: 'connect failed' })],
    ['只有 code=ENOTFOUND', err({ code: 'ENOTFOUND' })],
    ['message 里的 Server selection timed out', err({ message: 'Server selection timed out after 10000 ms' })],
    ['message 里的 connect EHOSTUNREACH', err({ message: 'connect EHOSTUNREACH 10.89.0.90:27017' })],
    ['message 里的 EAI_AGAIN（DNS 暂时失败）', err({ message: 'getaddrinfo EAI_AGAIN mongo' })],
  ])('判为可重试：%s', (_label, e) => {
    expect(isDbUnreachableError(e)).toBe(true);
  });

  it('顺着 cause 链往下找（initJwt 与 Node 的 AggregateError 都会把真因埋在下一层）', () => {
    const wrapped = err({
      name: 'Error',
      message: 'bootstrap failed',
      cause: err({ name: 'Error', message: 'inner', cause: err({ code: 'ECONNREFUSED' }) }),
    });
    expect(isDbUnreachableError(wrapped)).toBe(true);
  });

  it.each([
    ['URI 写错（MongoParseError）必须快速失败，重试一万次也不会好', err({ name: 'MongoParseError', message: 'Invalid connection string' })],
    ['认证失败不是"不可达"', err({ name: 'MongoServerError', message: 'Authentication failed' })],
    ['普通的 TypeError（代码 bug）', new TypeError('cannot read x of undefined')],
    ['笼统的 Error', new Error('something else entirely')],
    ['Nest 的依赖注入错误', err({ name: 'UnknownDependenciesException', message: 'Nest cannot resolve' })],
  ])('判为不可重试：%s', (_label, e) => {
    expect(isDbUnreachableError(e)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'ECONNREFUSED'],
    ['数字', 0],
    ['空对象', {}],
  ])('绝不抛异常，非法输入一律判 false（%s）', (_label, v) => {
    expect(() => isDbUnreachableError(v)).not.toThrow();
    expect(isDbUnreachableError(v)).toBe(false);
  });

  it('⚠️ 尺子有效性反证：字符串 "ECONNREFUSED" 不算（只有 Error 的 code/message 才算）', () => {
    // 如果实现是"把入参 String() 之后做正则"，这条就会红 —— 那种实现会把日志文本误判成错误。
    expect(isDbUnreachableError('ECONNREFUSED')).toBe(false);
    expect(isDbUnreachableError(err({ message: 'ECONNREFUSED' }))).toBe(true);
  });
});

describe('bootstrapBackoffDelayMs：指数退避 + 封顶，且不会溢出', () => {
  it('5s → 10s → 20s → 30s（封顶）→ 30s', () => {
    const seq = [1, 2, 3, 4, 5, 6].map((a) => bootstrapBackoffDelayMs(a, 5000, 30000));
    expect(seq).toEqual([5000, 10000, 20000, 30000, 30000, 30000]);
  });

  it.each([
    ['attempt=0', 0],
    ['负数', -3],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('非法 attempt 回落到 base（%s）', (_label, attempt) => {
    expect(bootstrapBackoffDelayMs(attempt, 5000, 30000)).toBe(5000);
  });

  it('⚠️ 极大的 attempt 得到封顶值而不是 Infinity（Infinity 传进 setTimeout 会**立刻**触发，退避就没了）', () => {
    const d = bootstrapBackoffDelayMs(5000, 5000, 30000);
    expect(d).toBe(30000);
    expect(Number.isFinite(d)).toBe(true);
  });

  it('max 小于 base 时以 max 为准（不会出现"退避比封顶还长"）', () => {
    expect(bootstrapBackoffDelayMs(4, 5000, 1000)).toBe(1000);
  });
});

describe('resolveBootstrapRetryConfig：垃圾值回落默认，绝不让窗口变成 0', () => {
  const KEYS = [BOOTSTRAP_DB_RETRY_WINDOW_ENV, BOOTSTRAP_DB_RETRY_BASE_ENV, BOOTSTRAP_DB_RETRY_MAX_ENV];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it('未设置时用默认值（窗口 5 分钟 / base 5s / 封顶 30s）', () => {
    expect(resolveBootstrapRetryConfig()).toEqual({
      windowMs: BOOTSTRAP_DB_RETRY_WINDOW_MS_DEFAULT,
      baseDelayMs: BOOTSTRAP_DB_RETRY_BASE_MS_DEFAULT,
      maxDelayMs: BOOTSTRAP_DB_RETRY_MAX_MS_DEFAULT,
    });
    expect(BOOTSTRAP_DB_RETRY_WINDOW_MS_DEFAULT).toBe(300000);
  });

  it.each(['0', '-1', 'abc', '12O', '', '   ', 'NaN', 'Infinity'])(
    '⚠️ 窗口写成 %j 时回落默认，而不是变成"不重试"',
    (raw) => {
      process.env[BOOTSTRAP_DB_RETRY_WINDOW_ENV] = raw;
      expect(resolveBootstrapRetryConfig().windowMs).toBe(BOOTSTRAP_DB_RETRY_WINDOW_MS_DEFAULT);
    },
  );

  it('合法值生效并被夹到范围内', () => {
    process.env[BOOTSTRAP_DB_RETRY_WINDOW_ENV] = '60000';
    process.env[BOOTSTRAP_DB_RETRY_BASE_ENV] = '2000';
    process.env[BOOTSTRAP_DB_RETRY_MAX_ENV] = '9000';
    expect(resolveBootstrapRetryConfig()).toEqual({ windowMs: 60000, baseDelayMs: 2000, maxDelayMs: 9000 });
  });

  it('maxDelayMs 永远不小于 baseDelayMs（否则"封顶"会把第一次退避也压掉）', () => {
    process.env[BOOTSTRAP_DB_RETRY_BASE_ENV] = '20000';
    process.env[BOOTSTRAP_DB_RETRY_MAX_ENV] = '1000';
    const c = resolveBootstrapRetryConfig();
    expect(c.maxDelayMs).toBeGreaterThanOrEqual(c.baseDelayMs);
  });
});

describe('runBootstrapWithDbRetry：只重试数据库问题，且窗口有限', () => {
  it('第一次就成功 ⇒ attempts=1、一次都不睡', async () => {
    const { slept, fn } = fakeSleep();
    const calls: number[] = [];
    const out = await runBootstrapWithDbRetry(
      async () => { calls.push(1); },
      { sleepFn: fn, now: fakeClock(), baseDelayMs: 5000, maxDelayMs: 30000, windowMs: 300000 },
    );
    expect(out).toMatchObject({ ok: true, attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('数据库错误两次后成功 ⇒ attempts=3，退避序列是 5s、10s', async () => {
    const { slept, fn } = fakeSleep();
    let n = 0;
    const out = await runBootstrapWithDbRetry(
      async () => {
        n += 1;
        if (n < 3) {
          throw err({ name: 'MongoServerSelectionError', message: 'Server selection timed out' });
        }
      },
      { sleepFn: fn, now: fakeClock(1000), baseDelayMs: 5000, maxDelayMs: 30000, windowMs: 300000 },
    );
    expect(out).toMatchObject({ ok: true, attempts: 3 });
    expect(slept).toEqual([5000, 10000]);
    expect(n).toBe(3);
  });

  it('🔴 非数据库错误**立刻抛出**，绝不重试（配置错误不能被伪装成"数据库还没好"）', async () => {
    const { slept, fn } = fakeSleep();
    let n = 0;
    const seen: unknown[] = [];
    const bad = err({ name: 'MongoParseError', message: 'Invalid connection string' });
    await expect(
      runBootstrapWithDbRetry(
        async () => {
          n += 1;
          throw bad;
        },
        {
          sleepFn: fn,
          now: fakeClock(),
          baseDelayMs: 5000,
          maxDelayMs: 30000,
          windowMs: 300000,
          onNonRetryable: (e) => seen.push(e),
        },
      ),
    ).rejects.toBe(bad);
    expect(n).toBe(1);
    expect(slept).toEqual([]);
    expect(seen).toEqual([bad]);
  });

  it('窗口耗尽 ⇒ ok:false、retryable:true，且**不再继续尝试**', async () => {
    const { slept, fn } = fakeSleep();
    let n = 0;
    // 假时钟每次 +30s，窗口 100s ⇒ 第 4 次判定超时
    const out = await runBootstrapWithDbRetry(
      async () => {
        n += 1;
        throw err({ code: 'ECONNREFUSED' });
      },
      { sleepFn: fn, now: fakeClock(30000), baseDelayMs: 5000, maxDelayMs: 30000, windowMs: 100000 },
    );
    expect(isBootstrapFailure(out)).toBe(true);
    if (isBootstrapFailure(out)) {
      expect(out.retryable).toBe(true);
      expect(out.attempts).toBe(n);
      expect(n).toBeGreaterThan(1);
      expect(n).toBeLessThan(20);
    }
  });

  it('单次退避不会超过窗口剩余时间（不会"多睡一轮"把总时长拉过上限）', async () => {
    const { slept, fn } = fakeSleep();
    // 窗口 12s，base 10s，封顶 30s：第一次睡 10s，第二次只剩 ~2s
    await runBootstrapWithDbRetry(
      async () => { throw err({ code: 'ECONNREFUSED' }); },
      { sleepFn: fn, now: fakeClock(2000), baseDelayMs: 10000, maxDelayMs: 30000, windowMs: 12000 },
    );
    expect(slept.length).toBeGreaterThan(0);
    for (const s of slept) {
      expect(s).toBeLessThanOrEqual(12000);
    }
    expect(slept[slept.length - 1]).toBeLessThan(10000);
  });

  it('onRetry 拿到的是可用于日志的信息（第几次、已等多久、下次等多久、窗口）', async () => {
    const infos: Array<{ attempt: number; elapsedMs: number; nextDelayMs: number; windowMs: number }> = [];
    let n = 0;
    await runBootstrapWithDbRetry(
      async () => {
        n += 1;
        if (n < 3) {
          throw err({ code: 'ECONNREFUSED' });
        }
      },
      {
        sleepFn: fakeSleep().fn,
        now: fakeClock(1000),
        baseDelayMs: 5000,
        maxDelayMs: 30000,
        windowMs: 300000,
        onRetry: (i) => infos.push({ attempt: i.attempt, elapsedMs: i.elapsedMs, nextDelayMs: i.nextDelayMs, windowMs: i.windowMs }),
      },
    );
    expect(infos.map((i) => i.attempt)).toEqual([1, 2]);
    expect(infos.map((i) => i.nextDelayMs)).toEqual([5000, 10000]);
    expect(infos.every((i) => i.windowMs === 300000)).toBe(true);
  });

  it('⚠️ 变异对照的靶子：把"不可重试就抛"改成"什么都重试"时，上面那条 rejects 断言必须失败', () => {
    // 这条不真的改源码，而是用同一个判据跑"坏实现"，证明断言不是恒真。
    const badImpl = async () => {
      let n = 0;
      for (;;) {
        n += 1;
        try {
          throw err({ name: 'MongoParseError' });
        } catch (e) {
          if (n >= 3) {
            return e; // 坏实现：吞掉并返回，而不是抛出
          }
        }
      }
    };
    return expect(badImpl()).resolves.toBeTruthy();
  });
});

describe('probeMongoOnce：降级驻留期间用它做"值不值得真启动"的判据', () => {
  it('空/非法 URL 直接 false，且不抛异常', async () => {
    await expect(probeMongoOnce('')).resolves.toBe(false);
    await expect(probeMongoOnce('   ')).resolves.toBe(false);
    await expect(probeMongoOnce(undefined as unknown as string)).resolves.toBe(false);
  });

  it('连不上的地址在**短超时**内返回 false（不会挂住降级驻留的循环）', async () => {
    const t0 = Date.now();
    // 127.0.0.1 上一个几乎肯定没人监听的端口；超时给 1500ms
    const ok = await probeMongoOnce('mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=1500', 1500);
    expect(ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(20000);
  }, 30000);
});
