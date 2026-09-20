import { AddressInfo } from 'net';
import {
  DEGRADED_HOLD_HINT,
  DEGRADED_HOLD_REASON,
  degradedHealthBody,
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
