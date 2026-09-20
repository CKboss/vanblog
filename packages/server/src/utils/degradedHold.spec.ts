import { AddressInfo } from 'net';
import {
  DEGRADED_HOLD_HINT,
  DEGRADED_HOLD_MODE_DEFAULT,
  DEGRADED_HOLD_MODE_ENV,
  DEGRADED_HOLD_REASON,
  createDegradedHoldController,
  degradedHealthBody,
  resolveDegradedHoldMode,
  startDegradedHoldServer,
} from './degradedHold';

/**
 * 降级驻留的占位服务。
 *
 * ⚠️ 这些用例**真起 HTTP 服务、真发请求**（端口用 0 让内核分配），因为本模块的全部价值就在
 * "端口真的被接住了、响应形状真的对"——只断言源码里出现了什么，证明不了任何一件事。
 *
 * ⚠️ health 的响应形状必须与 `controller/public/health.controller.ts` 的 503 分支**逐字段一致**：
 * 镜像 HEALTHCHECK、`vanblog.sh drill`、`./vanblog.sh doctor` 都读它（判据是 HTTP `statusCode < 500`
 * 才算健康）。形状一变，那些工具就会误判 —— 而"工具说健康、其实不健康"是本仓库最忌讳的方向。
 */

const SILENT_LOG = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 真健康端点 503 分支会有的键（不含 detailed 才出现的那几个）。 */
const REAL_HEALTH_KEYS = [
  'status',
  'mongo',
  'mongoState',
  'mongoStateText',
  'mongoPingMs',
  'now',
  'version',
].sort();

async function withServer<T>(
  fn: (base: string, close: () => Promise<void>) => Promise<T>,
  options: Partial<Parameters<typeof startDegradedHoldServer>[0]> = {},
): Promise<T> {
  const handle = await startDegradedHoldServer({
    port: 0,
    reason: 'test-reason',
    versionText: 'test-version',
    log: SILENT_LOG,
    ...options,
  });
  expect(handle).not.toBeNull();
  const addr = handle!.address()!;
  // port:0 时 address() 给的是内核分配的真实端口
  const port = Number(addr.split(':').pop());
  try {
    return await fn(`http://127.0.0.1:${port}`, handle!.close);
  } finally {
    await handle!.close();
  }
}

describe('降级驻留：/api/public/health 与真实端点同形状', () => {
  it('返回 503，且 data 的键集合与真实健康端点的 503 分支**完全一致**', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/health`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.statusCode).toBe(503);
      expect(Object.keys(body.data).sort()).toEqual(REAL_HEALTH_KEYS);
      expect(body.data.status).toBe('degraded');
      expect(body.data.mongo).toBe('down');
      // mongoose 的 0 = disconnected（health.controller.ts 的注释专门强调过这个语义，别写反）
      expect(body.data.mongoState).toBe(0);
      expect(body.data.mongoStateText).toBe('disconnected');
      expect(body.data.mongoPingMs).toBeNull();
      expect(body.data.version).toBe('test-version');
      expect(typeof body.data.now).toBe('string');
      expect(() => new Date(body.data.now).toISOString()).not.toThrow();
    });
  });

  it('⚠️ 刻意**不加**任何真实端点没有的键（启动期的解释信息不进 health，进日志与其它路径）', async () => {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/api/public/health`)).json();
      expect(body.data).not.toHaveProperty('reason');
      expect(body.data).not.toHaveProperty('hint');
      expect(body.data).not.toHaveProperty('degraded');
      expect(body).not.toHaveProperty('message');
    });
  });

  it('带尾斜杠的路径也认（caddy 与 compose 的探测路径可能带斜杠）', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/health/`);
      expect(res.status).toBe(503);
      expect((await res.json()).data.status).toBe('degraded');
    });
  });

  it('Cache-Control: no-store —— 降级状态绝不能被缓存，否则数据库恢复后 CDN/浏览器还拿着 503', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/public/health`);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });
});

describe('降级驻留：其它路径一律 503 并说清原因与下一步', () => {
  it.each([
    ['GET /', '/'],
    ['GET /post/1', '/post/1'],
    ['GET /api/public/meta', '/api/public/meta'],
    ['GET /admin', '/admin'],
    ['POST /api/admin/auth/login', '/api/admin/auth/login'],
  ])('%s ⇒ 503 + 原因 + 排查提示', async (_label, path) => {
    await withServer(async (base) => {
      const res = await fetch(`${base}${path}`, {
        method: path.includes('login') ? 'POST' : 'GET',
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.statusCode).toBe(503);
      expect(body.message).toBe(DEGRADED_HOLD_REASON);
      expect(body.hint).toBe(DEGRADED_HOLD_HINT);
      expect(body.reason).toBe('test-reason');
    });
  });

  it('⚠️ 绝不假装可用：没有任何路径会返回 200（"容器 Up 但站点坏了却看不出来"是本仓库的历史事故）', async () => {
    await withServer(async (base) => {
      for (const p of ['/', '/api/public/health', '/static/img/x.webp', '/feed.xml', '/api/admin/setting']) {
        const res = await fetch(`${base}${p}`);
        expect(res.status).toBe(503);
      }
    });
  });

  it('原因文本不会把 mongo 连接串带出去（连接串可能含口令）', async () => {
    await withServer(
      async (base) => {
        const body = await (await fetch(`${base}/`)).json();
        const text = JSON.stringify(body);
        expect(text).not.toContain('mongodb://');
        expect(text).toContain('test-reason');
      },
      { reason: 'test-reason' },
    );
  });
});

describe('降级驻留：端口的生命周期（真正的 bootstrap 要接管端口）', () => {
  it('close() 之后端口被释放，可以在同一个端口上再起一个（否则 EADDRINUSE，恢复不了）', async () => {
    const first = await startDegradedHoldServer({
      port: 0,
      reason: 'r',
      versionText: 'v',
      log: SILENT_LOG,
    });
    expect(first).not.toBeNull();
    const port = Number(first!.address()!.split(':').pop());
    await first!.close();

    const second = await startDegradedHoldServer({
      port,
      reason: 'r2',
      versionText: 'v2',
      log: SILENT_LOG,
    });
    expect(second).not.toBeNull();
    const res = await fetch(`http://127.0.0.1:${port}/api/public/health`);
    expect(res.status).toBe(503);
    expect((await res.json()).data.version).toBe('v2');
    await second!.close();
  });

  it('close() 之后 keep-alive 连接也被断掉（否则 close 会一直等空闲连接，端口拿不回来）', async () => {
    const handle = await startDegradedHoldServer({
      port: 0,
      reason: 'r',
      versionText: 'v',
      log: SILENT_LOG,
    });
    const port = Number(handle!.address()!.split(':').pop());
    // 先发一个请求建立 keep-alive 连接
    await fetch(`http://127.0.0.1:${port}/api/public/health`);
    const t0 = Date.now();
    await handle!.close();
    // 如果没有 closeAllConnections，这里会等到对端空闲超时（Node 默认 5s 起）
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('🔴 端口被占用时**不抛异常、不崩进程**，返回 null 并继续（崩掉就回到"完全下线"那一档）', async () => {
    const occupier = await startDegradedHoldServer({
      port: 0,
      reason: 'occupy',
      versionText: 'v',
      log: SILENT_LOG,
    });
    const port = Number(occupier!.address()!.split(':').pop());

    const errors: string[] = [];
    const uncaught = (e: Error) => errors.push(String(e?.message || e));
    process.on('uncaughtException', uncaught);
    try {
      const dup = await startDegradedHoldServer({
        port,
        reason: 'dup',
        versionText: 'v',
        log: { log: () => undefined, warn: () => undefined, error: (m) => errors.push(m) },
      });
      expect(dup).toBeNull();
    } finally {
      process.removeListener('uncaughtException', uncaught);
      await occupier!.close();
    }
    // 绑定失败必须被 server 的 'error' 监听接住，不能变成 uncaughtException
    expect(errors.some((e) => /EADDRINUSE/.test(e))).toBe(true);
  });
});

describe('degradedHealthBody：纯函数形状（供上层复用与断言）', () => {
  it('可注入时钟，字段与真实端点一致', () => {
    const body = degradedHealthBody('v1', () => '2026-09-20T00:00:00.000Z');
    expect(body).toEqual({
      statusCode: 503,
      data: {
        status: 'degraded',
        mongo: 'down',
        mongoState: 0,
        mongoStateText: 'disconnected',
        mongoPingMs: null,
        now: '2026-09-20T00:00:00.000Z',
        version: 'v1',
      },
    });
  });

  it('⚠️ 与真实端点的键集合对齐这件事本身有反证：多一个键就不再相等', () => {
    const body = degradedHealthBody('v1', () => 'x') as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(REAL_HEALTH_KEYS);
    body.data.extra = 1;
    expect(Object.keys(body.data).sort()).not.toEqual(REAL_HEALTH_KEYS);
  });
});

describe('地址绑定', () => {
  it('给了 host 就绑在那个地址上（与 server 的 getListenTarget 口径一致）', async () => {
    const handle = await startDegradedHoldServer({
      port: 0,
      host: '127.0.0.1',
      reason: 'r',
      versionText: 'v',
      log: SILENT_LOG,
    });
    expect(handle).not.toBeNull();
    expect(handle!.address()).toMatch(/^127\.0\.0\.1:\d+$/);
    await handle!.close();
  });
});

// 让 AddressInfo 的 import 不被 tree-shake 警告（类型用途）
export type _Unused = AddressInfo;

/* ══════════════════════════════════════════════════════════════════════════
 * 驻留控制器：immediate 模式、幂等、端口/哨兵顺序、抖动护栏
 * ══════════════════════════════════════════════════════════════════════════ */

/** 起一个控制器（端口 0 让内核分配），跑完保证关掉。 */
async function withController<T>(
  fn: (c: ReturnType<typeof createDegradedHoldController>, base: string) => Promise<T>,
  over: Partial<Parameters<typeof createDegradedHoldController>[0]> = {},
): Promise<T> {
  const c = createDegradedHoldController({
    port: 0,
    versionText: 'test-version',
    probeMs: 1000,
    log: SILENT_LOG,
    ...over,
  });
  try {
    await c.enter('test-reason');
    const addr = c.address();
    expect(addr).not.toBeNull();
    const port = Number(String(addr).split(':').pop());
    return await fn(c, `http://127.0.0.1:${port}`);
  } finally {
    await c.releasePort();
  }
}

async function get(base: string, path: string) {
  const res = await fetch(base + path);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

describe('🔴 immediate 模式：第一次失败就拿到同形状 503，而不是等窗口烧完', () => {
  it('enter() 之后**立刻**能拿到 503，且 data 的键集合与真实端点一致', async () => {
    await withController(async (_c, base) => {
      const r = await get(base, '/api/public/health');
      expect(r.status).toBe(503);
      expect(Object.keys(r.body.data).sort()).toEqual(REAL_HEALTH_KEYS);
      expect(r.body.data.status).toBe('degraded');
      expect(r.body.data.mongo).toBe('down');
    });
  });

  it('⚠️ 反证（证明上一条不是恒真）：enter 之前那个端口上**什么都没有**', async () => {
    // 先占一个端口拿到号码，关掉，然后在"没有驻留"的状态下请求它 ⇒ 必须连不上。
    const probe = await startDegradedHoldServer({
      port: 0,
      reason: 'x',
      versionText: 'v',
      log: SILENT_LOG,
    });
    const addr = probe!.address()!;
    await probe!.close();
    await expect(fetch(`http://127.0.0.1:${Number(addr.split(':').pop())}/api/public/health`)).rejects.toBeTruthy();
  });
});

describe('驻留控制器：幂等与端口/哨兵顺序', () => {
  it('enter 两次只起一个监听、onEnter 只跑一次（重复起会 EADDRINUSE）', async () => {
    const calls: string[] = [];
    await withController(
      async (c, base) => {
        await c.enter('again');
        await c.enter('again-2');
        expect(calls).toEqual(['enter']);
        expect((await get(base, '/api/public/health')).status).toBe(503);
      },
      { onEnter: () => void calls.push('enter') },
    );
  });

  it('🔴 releasePort 只让出端口，**不**还原哨兵（否则 bootstrap 期间会出现新的 502 空窗）', async () => {
    const calls: string[] = [];
    const c = createDegradedHoldController({
      port: 0,
      versionText: 'v',
      probeMs: 1000,
      log: SILENT_LOG,
      onEnter: () => void calls.push('enter'),
      onCommit: () => void calls.push('commit'),
    });
    await c.enter('r');
    const addr = String(c.address());
    await c.releasePort();
    expect(calls).toEqual(['enter']); // commit 还没跑
    expect(c.isActive()).toBe(false);
    // 端口真的被让出来了：同一个端口能再绑一次
    const again = await startDegradedHoldServer({
      port: Number(addr.split(':').pop()),
      reason: 'x',
      versionText: 'v',
      log: SILENT_LOG,
    });
    expect(again).not.toBeNull();
    await again!.close();
  });

  it('commit 才还原哨兵，且**幂等**（跑两次只还原一次）', async () => {
    const calls: string[] = [];
    const c = createDegradedHoldController({
      port: 0,
      versionText: 'v',
      probeMs: 1000,
      log: SILENT_LOG,
      onCommit: () => void calls.push('commit'),
    });
    await c.enter('r');
    await c.commit();
    await c.commit();
    expect(calls).toEqual(['commit']);
  });

  it('🔴 onEnter 抛异常时：enter 仍然完成、health 仍然 503（尽力而为的步骤不许打死驻留）', async () => {
    const warns: string[] = [];
    const log = {
      log: () => undefined,
      warn: (m: string) => warns.push(m),
      error: () => undefined,
    };
    const c = createDegradedHoldController({
      port: 0,
      versionText: 'v',
      probeMs: 1000,
      log,
      onEnter: () => {
        throw new Error('sentinel boom');
      },
    });
    // ⚠️ 必须 try/finally 关掉监听：`enter()` 里占位服务是**先起监听、再跑 onEnter** 的，
    //    所以一旦 onEnter 抛异常（变异体就会），断言失败会让测试体中断，
    //    而那个已经绑好的监听就成了泄漏的 handle ⇒ **jest 跑完不退出**（我第一版就这样把
    //    变异对照挂住了 10 分钟）。这也是"变异体不该让测试框架卡死"的一条通用要求。
    try {
      await expect(c.enter('r')).resolves.toBeUndefined();
      const addr = String(c.address());
      const r = await get(`http://127.0.0.1:${Number(addr.split(':').pop())}`, '/api/public/health');
      expect(r.status).toBe(503);
      expect(warns.join('\n')).toContain('sentinel boom');
    } finally {
      await c.releasePort();
    }
  });

  it('🔴 onCommit 抛异常时：commit 仍然完成（"启动已成功"不能被还原失败回滚成退出码 1）', async () => {
    const c = createDegradedHoldController({
      port: 0,
      versionText: 'v',
      probeMs: 1000,
      log: SILENT_LOG,
      onCommit: () => {
        throw new Error('restore boom');
      },
    });
    await c.enter('r');
    await expect(c.commit()).resolves.toBeUndefined();
  });

  it('reenter 重新接住端口并记一次抖动', async () => {
    const c = createDegradedHoldController({
      port: 0,
      versionText: 'v',
      probeMs: 1000,
      log: SILENT_LOG,
    });
    await c.enter('r');
    await c.releasePort();
    expect(c.flapCount()).toBe(0);
    await c.reenter('r2');
    expect(c.flapCount()).toBe(1);
    expect(c.isActive()).toBe(true);
    // ⚠️ 必须**重新**取地址：控制器用 port:0，reenter 会绑到一个新端口。
    //    我第一版沿用了 enter 时的旧地址，于是请求打到一个已经关掉的端口上（ECONNREFUSED）。
    const addr2 = String(c.address());
    const r = await get(`http://127.0.0.1:${Number(addr2.split(':').pop())}`, '/api/public/health');
    expect(r.status).toBe(503);
    await c.releasePort();
  });
});

describe('抖动护栏：数据库反复通断时不许把日志与磁盘打爆', () => {
  function ctl(over: Partial<Parameters<typeof createDegradedHoldController>[0]> = {}) {
    return createDegradedHoldController({
      port: 0,
      versionText: 'v',
      probeMs: 1000,
      maxFlaps: 3,
      flapFactor: 2,
      flapProbeMaxMs: 8000,
      log: SILENT_LOG,
      ...over,
    });
  }

  // ⚠️ 这两个用例只测 `nextProbeMs()` 的算术，但 `reenter()` 会**真起一个监听**
  //    （第一次之后 active=true 就不再起了）。所以必须在 finally 里 releasePort，
  //    否则留下一个打开的 handle ⇒ jest 跑完不退出（我第一版就是这样挂住的）。
  it('阈值之内探活间隔不变；超过后按倍率拉长并**夹到上限**', async () => {
    const c = ctl();
    try {
      expect(c.nextProbeMs()).toBe(1000);
      for (let i = 0; i < 3; i += 1) await c.reenter('r');
      expect(c.nextProbeMs()).toBe(1000); // 恰好等于阈值，还不算超
      await c.reenter('r');
      expect(c.nextProbeMs()).toBe(2000); // 超 1 次 ⇒ ×2
      await c.reenter('r');
      expect(c.nextProbeMs()).toBe(4000);
      await c.reenter('r');
      expect(c.nextProbeMs()).toBe(8000); // 到上限
      await c.reenter('r');
      expect(c.nextProbeMs()).toBe(8000); // 夹住，不再涨
    } finally {
      await c.releasePort();
    }
  });

  it('⚠️ 指数溢出时夹到上限，而不是 Infinity（Infinity = 永远不再探活 = 永不自愈）', async () => {
    const c = ctl({ probeMs: 1000, maxFlaps: 0, flapFactor: 10, flapProbeMaxMs: 5000 });
    try {
      for (let i = 0; i < 400; i += 1) await c.reenter('r');
      expect(Number.isFinite(c.nextProbeMs())).toBe(true);
      expect(c.nextProbeMs()).toBe(5000);
    } finally {
      await c.releasePort();
    }
  });

  it('抖动 WARN 只打一次（每轮都打就等于没有信息量）', async () => {
    const warns: string[] = [];
    const c = ctl({
      log: { log: () => undefined, warn: (m: string) => warns.push(m), error: () => undefined },
    });
    for (let i = 0; i < 8; i += 1) await c.reenter('r');
    expect(warns.filter((w) => w.includes('反复通断'))).toHaveLength(1);
    await c.releasePort();
  });
});

describe('VANBLOG_DEGRADED_HOLD_MODE：垃圾值回落默认，而不是关掉降级驻留', () => {
  const saved = process.env[DEGRADED_HOLD_MODE_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[DEGRADED_HOLD_MODE_ENV];
    else process.env[DEGRADED_HOLD_MODE_ENV] = saved;
  });

  it('未设置 ⇒ immediate（默认）', () => {
    delete process.env[DEGRADED_HOLD_MODE_ENV];
    expect(resolveDegradedHoldMode()).toBe('immediate');
    expect(DEGRADED_HOLD_MODE_DEFAULT).toBe('immediate');
  });

  it('after-window ⇒ 保留旧行为（这个旋钮必须是真的，不能是装饰）', () => {
    expect(resolveDegradedHoldMode('after-window')).toBe('after-window');
    expect(resolveDegradedHoldMode('  AFTER-WINDOW  ')).toBe('after-window'); // trim + 大小写不敏感
  });

  it('🔴 垃圾值 ⇒ 回落 immediate + WARN，**绝不当成"关闭"**', () => {
    const warns: string[] = [];
    for (const bad of ['off', 'no', '0', 'false', 'immediate ', 'x']) {
      const got = resolveDegradedHoldMode(bad, { warn: (m: string) => warns.push(m) });
      // ⚠️ 'immediate ' 带尾空格，trim 后是合法值 ⇒ 不该 WARN
      if (bad.trim() === 'immediate') {
        expect(got).toBe('immediate');
      } else {
        expect(got).toBe('immediate');
      }
    }
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.join('\n')).toContain(DEGRADED_HOLD_MODE_ENV);
    // WARN 要说清回落方向是"更快开始发布缓存内容"，不是"关掉"
    expect(warns.join('\n')).toContain('不是"关闭降级驻留"');
  });

  it('非字符串（undefined/null/数字/数组）⇒ 默认值，且不抛', () => {
    for (const bad of [undefined, null, 123, ['immediate'], {}]) {
      expect(() => resolveDegradedHoldMode(bad)).not.toThrow();
      expect(resolveDegradedHoldMode(bad)).toBe('immediate');
    }
  });
});
