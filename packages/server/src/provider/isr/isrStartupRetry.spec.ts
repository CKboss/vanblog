import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import {
  ISRProvider,
  ISR_RETRY_MAX_ENV,
  ISR_RETRY_BASE_DELAY_ENV,
  ISR_RETRY_MAX_DELAY_ENV,
  DEFAULT_ISR_RETRY_MAX,
  DEFAULT_ISR_RETRY_BASE_DELAY_MS,
  DEFAULT_ISR_RETRY_MAX_DELAY_MS,
  RevalidateProbeResult,
} from './isr.provider';

/**
 * `activeWithRetry` 的重试窗口：**有上限的指数退避**，而不是写死的 6×3s。
 *
 * 改动前是 `const max = 6; const delay = 3000;` ⇒ 总窗口约 **18 秒**。故障注入实测
 * （2026-09-20，镜像 `vanblog:hardened`）：容器重启后 mongo 还在重连、`/api/public/health`
 * 仍 503，启动全量 ISR 渲染立刻开跑并失败，18 秒内把 6 次重试烧光，打出
 * 「达到最大增量渲染重试次数！」后**永久放弃**那一轮预热。站点仍能服务（ISR 缓存 +
 * `fallback:'blocking'` 按需渲染），但每个页面都要等访客第一次访问才现场渲染 ——
 * 在敌意环境下这是最贵、最容易被放大的形状，而任何能让容器重启的手段都能造成它。
 *
 * ⚠️ 所有用例都把 `retrySleep` 换成立即 resolve 的假 sleep 并**记录每次睡了多久**：
 *    断言的是退避序列本身，而不是"跑得慢"。默认窗口有 135 秒，真睡的话一个用例就是两分钟。
 */

const ORIGINAL_ENV = { ...process.env };

type SleepRecord = number[];

function makeProvider(probeResults: RevalidateProbeResult[]) {
  // ⚠️ 用 Object.create 而不是 new：ISRProvider 的构造函数有一串 @InjectModel/@Optional 依赖，
  //    而本文件只测 activeWithRetry 这条纯逻辑路径（仓库里已有同款先例）。
  const provider = Object.create(ISRProvider.prototype) as ISRProvider & {
    retrySleep: (ms: number) => Promise<unknown>;
  };
  const warns: string[] = [];
  const errors: string[] = [];
  (provider as any).logger = {
    warn: (m: string) => warns.push(String(m)),
    error: (m: string) => errors.push(String(m)),
    log: () => undefined,
  };
  const sleeps: SleepRecord = [];
  provider.retrySleep = async (ms: number) => {
    sleeps.push(ms);
  };
  let probeCalls = 0;
  provider.probeRevalidate = jest.fn(async () => {
    const r = probeResults[Math.min(probeCalls, probeResults.length - 1)];
    probeCalls += 1;
    return r;
  }) as any;
  return { provider, warns, errors, sleeps, probeCalls: () => probeCalls };
}

const OK: RevalidateProbeResult = { ok: true, kind: 'ok' };
const UNREACHABLE: RevalidateProbeResult = {
  ok: false,
  kind: 'unreachable',
  detail: 'ECONNREFUSED',
};
const HTTP_ERROR: RevalidateProbeResult = {
  ok: false,
  kind: 'http-error',
  detail: 'HTTP 500',
};

beforeEach(() => {
  delete process.env[ISR_RETRY_MAX_ENV];
  delete process.env[ISR_RETRY_BASE_DELAY_ENV];
  delete process.env[ISR_RETRY_MAX_DELAY_ENV];
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('退避序列', () => {
  it('默认是 3s→6s→12s→24s→30s（封顶）→30s→30s，共 8 次尝试、纯等待 135 秒', async () => {
    const { provider, sleeps, errors } = makeProvider([UNREACHABLE]);
    await provider.activeWithRetry(async () => undefined, '启动');
    expect(sleeps).toEqual([3000, 6000, 12000, 24000, 30000, 30000, 30000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(135000);
    expect(sleeps).toHaveLength(DEFAULT_ISR_RETRY_MAX - 1);
    expect(errors).toHaveLength(1);
  });

  it('⚠️ 新窗口必须**显著大于**改动前的 18 秒（否则这次修复等于没做）', async () => {
    const { provider, sleeps } = makeProvider([UNREACHABLE]);
    await provider.activeWithRetry(async () => undefined, '启动');
    const total = sleeps.reduce((a, b) => a + b, 0);
    const OLD_WINDOW_MS = 5 * 3000; // 改动前：6 次尝试 ⇒ 5 次 3 秒等待
    expect(OLD_WINDOW_MS).toBe(15000);
    expect(total).toBeGreaterThan(OLD_WINDOW_MS * 5);
  });

  it('resolveRetryBackoffMs 逐次给出正确值，且封顶后不再增长', () => {
    const { provider } = makeProvider([OK]);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((a) => provider.resolveRetryBackoffMs(a))).toEqual([
      3000, 6000, 12000, 24000, 30000, 30000, 30000, 30000, 30000,
    ]);
  });

  it('负数/NaN/小数尝试次数都不会算出负数、NaN 或 0 的等待', () => {
    const { provider } = makeProvider([OK]);
    for (const bad of [-1, -100, NaN, Infinity, 0.5, 1.9]) {
      const v = provider.resolveRetryBackoffMs(bad);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(DEFAULT_ISR_RETRY_BASE_DELAY_MS);
      expect(v).toBeLessThanOrEqual(DEFAULT_ISR_RETRY_MAX_DELAY_MS);
    }
  });

  it('指数不会溢出成 NaN（尝试次数被配到很大时仍收敛到封顶值）', () => {
    const { provider } = makeProvider([OK]);
    expect(provider.resolveRetryBackoffMs(1000)).toBe(DEFAULT_ISR_RETRY_MAX_DELAY_MS);
    expect(provider.resolveRetryBackoffMs(Number.MAX_SAFE_INTEGER)).toBe(
      DEFAULT_ISR_RETRY_MAX_DELAY_MS,
    );
  });
});

describe('成功与放弃', () => {
  it('第 4 次尝试成功 ⇒ 只睡 3 次，且**不打**"达到最大重试次数"', async () => {
    const { provider, sleeps, errors, warns } = makeProvider([
      UNREACHABLE,
      UNREACHABLE,
      HTTP_ERROR,
      OK,
    ]);
    let ran = 0;
    await provider.activeWithRetry(async () => {
      ran += 1;
    }, '保存文章');
    expect(ran).toBe(1);
    expect(sleeps).toEqual([3000, 6000, 12000]);
    expect(errors).toEqual([]);
    expect(warns).toHaveLength(3);
  });

  it('第一次就成功 ⇒ 一次都不睡、不打 WARN（既有行为不变）', async () => {
    const { provider, sleeps, warns, errors } = makeProvider([OK]);
    await provider.activeWithRetry(async () => undefined, '保存文章');
    expect(sleeps).toEqual([]);
    expect(warns).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('放弃时那条 ERROR 说清了：尝试次数、累计等待、最后一次原因、以及两条兜底', async () => {
    const { provider, errors } = makeProvider([HTTP_ERROR]);
    await provider.activeWithRetry(async () => undefined, '首次启动触发全量渲染！');
    expect(errors).toHaveLength(1);
    const text = errors[0];
    expect(text).toContain('达到最大增量渲染重试次数');
    expect(text).toContain(`${DEFAULT_ISR_RETRY_MAX} 次`);
    expect(text).toContain('135 秒');
    expect(text).toContain('首次启动触发全量渲染！');
    expect(text).toContain('HTTP 500'); // 最后一次失败原因
    // 兜底必须写出来，否则运维以为"渲染彻底坏了"
    expect(text).toContain('每小时一次的定时 ISR');
    expect(text).toContain('按需渲染');
    // 可照做的旋钮
    expect(text).toContain(ISR_RETRY_MAX_ENV);
    expect(text).toContain('VANBLOG_MONGO_READY_TIMEOUT_MS');
  });

  it('fn 抛错时仍由 activeWithRetry 打带来源的 ERROR（既有性质不被退避改动破坏）', async () => {
    const { provider, errors } = makeProvider([OK]);
    await provider.activeWithRetry(async () => {
      throw new Error('mongo 抖动');
    }, '保存文章 42');
    const text = errors.join('\n');
    expect(text).toContain('触发全量渲染时出错');
    expect(text).toContain('保存文章 42');
    expect(text).toContain('mongo 抖动');
  });
});

describe('重试日志必须能区分"等前台进程"与"等数据库"', () => {
  it('unreachable ⇒ 日志说"连不上前台子进程"并带上错误码', async () => {
    const { provider, warns } = makeProvider([UNREACHABLE, OK]);
    await provider.activeWithRetry(async () => undefined, '启动');
    expect(warns[0]).toContain('连不上前台子进程');
    expect(warns[0]).toContain('ECONNREFUSED');
  });

  it('http-error ⇒ 日志说"前台有响应但返回 HTTP 500"并点明多半是数据库没就绪', async () => {
    const { provider, warns } = makeProvider([HTTP_ERROR, OK]);
    await provider.activeWithRetry(async () => undefined, '启动');
    expect(warns[0]).toContain('前台有响应但返回 HTTP 500');
    expect(warns[0]).toContain('数据库可能还没就绪');
  });

  it('每条重试日志都带"已等待 N 秒 / 共 M 次尝试"，便于判断还要等多久', async () => {
    const { provider, warns } = makeProvider([UNREACHABLE, UNREACHABLE, OK]);
    await provider.activeWithRetry(async () => undefined, '启动');
    expect(warns[0]).toContain('已等待 3 秒');
    expect(warns[0]).toContain(`共 ${DEFAULT_ISR_RETRY_MAX} 次尝试`);
    expect(warns[1]).toContain('已等待 9 秒');
  });
});

describe('probeRevalidate 与 testConn 的契约', () => {
  it('testConn 仍然返回**布尔**（isr.provider.spec.ts 直接调它，契约不能变）', async () => {
    const { provider } = makeProvider([OK]);
    const v = await provider.testConn();
    expect(v).toBe(true);
    expect(typeof v).toBe('boolean');
    const { provider: p2 } = makeProvider([UNREACHABLE]);
    expect(await p2.testConn()).toBe(false);
  });

  it('testConn 是 probeRevalidate 的薄封装（不是第二套实现）', async () => {
    const { provider } = makeProvider([HTTP_ERROR]);
    const spy = jest.spyOn(provider, 'probeRevalidate');
    await provider.testConn();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('环境变量', () => {
  it.each([
    [ISR_RETRY_MAX_ENV, '3', 3],
    [ISR_RETRY_MAX_ENV, 'abc', DEFAULT_ISR_RETRY_MAX],
    [ISR_RETRY_MAX_ENV, '0', DEFAULT_ISR_RETRY_MAX],
    [ISR_RETRY_MAX_ENV, '100000', 100],
    [ISR_RETRY_BASE_DELAY_ENV, '500', 500],
    [ISR_RETRY_BASE_DELAY_ENV, '垃圾', DEFAULT_ISR_RETRY_BASE_DELAY_MS],
    [ISR_RETRY_MAX_DELAY_ENV, '1000', 1000],
    [ISR_RETRY_MAX_DELAY_ENV, '-5', DEFAULT_ISR_RETRY_MAX_DELAY_MS],
  ])('%s=%s ⇒ %i（垃圾值/越界一律回落或夹取，绝不变成 0 或无界）', (name, raw, expected) => {
    process.env[name] = raw;
    const { provider } = makeProvider([OK]);
    if (name === ISR_RETRY_MAX_ENV) {
      expect(provider.resolveRetryMax()).toBe(expected);
    } else if (name === ISR_RETRY_BASE_DELAY_ENV) {
      expect(provider.resolveRetryBackoffMs(0)).toBe(expected);
    } else {
      expect(provider.resolveRetryBackoffMs(20)).toBe(expected);
    }
  });

  it('把次数配成 1 ⇒ 一次都不睡，失败就直接打 ERROR（不会出现"配了 1 却睡一次"）', async () => {
    process.env[ISR_RETRY_MAX_ENV] = '1';
    const { provider, sleeps, errors } = makeProvider([UNREACHABLE]);
    await provider.activeWithRetry(async () => undefined, '启动');
    expect(sleeps).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('调大 base 与 cap 会真的改变退避序列（旋钮不是装饰）', async () => {
    process.env[ISR_RETRY_BASE_DELAY_ENV] = '1000';
    process.env[ISR_RETRY_MAX_DELAY_ENV] = '2500';
    process.env[ISR_RETRY_MAX_ENV] = '5';
    const { provider, sleeps } = makeProvider([UNREACHABLE]);
    await provider.activeWithRetry(async () => undefined, '启动');
    expect(sleeps).toEqual([1000, 2000, 2500, 2500]);
  });
});

describe('源码级钉子（剥注释后断言）', () => {
  const SRC = stripCommentsForAnchor(
    readFileSync(resolve(__dirname, 'isr.provider.ts'), 'utf-8'),
  );

  it('写死的 6 次 / 3000 毫秒不许回来', () => {
    expect(SRC).not.toMatch(/const\s+max\s*=\s*6\s*;/);
    expect(SRC).not.toMatch(/const\s+delay\s*=\s*3000\s*;/);
    // 空转反证：同一把尺子在改动前的形状上必须命中
    const before = 'const max = 6;\n    const delay = 3000;\n';
    expect(before).toMatch(/const\s+max\s*=\s*6\s*;/);
    expect(before).toMatch(/const\s+delay\s*=\s*3000\s*;/);
  });

  it('重试等待必须走可注入的 this.retrySleep（直接调 sleep 会让单测真睡几分钟）', () => {
    expect(SRC).toMatch(/await\s+this\.retrySleep\(\s*delay\s*\)/);
    expect(SRC).not.toMatch(/await\s+sleep\(\s*delay\s*\)/);
    // 空转反证：旧形状必须被这把尺子抓到
    expect('await sleep(delay);').toMatch(/await\s+sleep\(\s*delay\s*\)/);
  });

  it('退避是指数而不是固定值（源码里要有 Math.pow(2, …) 与封顶 Math.min）', () => {
    expect(SRC).toMatch(/Math\.pow\(\s*2\s*,\s*safeAttempt\s*\)/);
    expect(SRC).toMatch(/Math\.min\(\s*cap\s*,/);
  });

  it('探活结果区分三种 kind（把两种失败压成 false 就退回改动前）', () => {
    expect(SRC).toMatch(/kind:\s*'http-error'/);
    expect(SRC).toMatch(/kind:\s*'unreachable'/);
    // 空转反证：改动前只有一个 catch 里 return false
    expect(stripCommentsForAnchor('} catch {\n      return false;\n    }')).not.toMatch(
      /kind:\s*'http-error'/,
    );
  });
});
