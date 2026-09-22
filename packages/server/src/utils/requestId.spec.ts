import express from 'express';
import request from 'supertest';
import { isStaticAssetPath, normalizeRateLimitPath } from './rateLimit';
import {
  REQUEST_ID_HEADER,
  SLOW_REQUEST_MS_DEFAULT,
  makeRequestIdMiddleware,
  newRequestId,
  resolveAccessLogFlag,
  resolveSlowRequestMs,
  sanitizeInboundRequestId,
} from './requestId';

/**
 * request-id + 慢请求日志中间件。
 *
 * 钉住四件事：
 *  1. 入站 `x-request-id` 只有过了白名单才会被沿用 —— 那个头是客户端可控的，
 *     不校验就等于允许往日志里注入任意字符串（含换行伪造日志行）；
 *  2. 响应头一定带 id，响应体**一个字节都不变**；
 *  3. 慢请求 / 5xx / access log 三条日志各自的触发条件与关闭方式；
 *  4. 注册位置：app.module 里排在安全头与限流**之前**，且没有任何同步文件 I/O。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 日志行里"含有一个 uuid"（不带锚） */
const UUID_IN_LINE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function fakeLogger() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn(), debug: jest.fn() } as any;
}

function buildApp(config: { slowMs: number; accessLog: boolean }, logger = fakeLogger()) {
  const app = express();
  app.use(makeRequestIdMiddleware(config, logger));
  app.get('/api/ok', (_req, res) => res.json({ ok: true }));
  app.get('/api/echo-id', (req: any, res) => res.json({ id: req.requestId }));
  app.get('/api/slow', async (_req, res) => {
    await new Promise((r) => setTimeout(r, 60));
    res.json({ ok: true });
  });
  app.get('/api/boom', (_req, res) => {
    res.status(503).json({ statusCode: 503, message: 'boom' });
  });
  app.get('/static/img/x.webp', (_req, res) => res.json({ ok: true }));
  return { app, logger };
}

describe('sanitizeInboundRequestId：入站 id 白名单', () => {
  it('合法 id 原样沿用', () => {
    expect(sanitizeInboundRequestId('abc-123_XY.9')).toBe('abc-123_XY.9');
    expect(sanitizeInboundRequestId('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it('超长 / 非法字符 / 换行注入 → 拒绝（返回 null，由中间件生成新 id）', () => {
    expect(sanitizeInboundRequestId('a'.repeat(129))).toBeNull();
    expect(sanitizeInboundRequestId('bad id with spaces')).toBeNull();
    expect(sanitizeInboundRequestId('evil\r\nX-Injected: yes')).toBeNull();
    expect(sanitizeInboundRequestId('包含中文')).toBeNull();
    expect(sanitizeInboundRequestId('')).toBeNull();
  });

  it('非字符串 / 数组：取第一个合法值，没有就拒绝', () => {
    expect(sanitizeInboundRequestId(undefined)).toBeNull();
    expect(sanitizeInboundRequestId(null)).toBeNull();
    expect(sanitizeInboundRequestId(12345)).toBeNull();
    expect(sanitizeInboundRequestId(['bad one', 'good-1'])).toBe('good-1');
    expect(sanitizeInboundRequestId([])).toBeNull();
  });

  it('newRequestId 生成 uuid', () => {
    expect(newRequestId()).toMatch(UUID_RE);
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

describe('环境变量解析', () => {
  it('VANBLOG_SLOW_REQUEST_MS：默认 5000，0=关，非法回落', () => {
    expect(SLOW_REQUEST_MS_DEFAULT).toBe(5000);
    expect(resolveSlowRequestMs(undefined)).toBe(5000);
    expect(resolveSlowRequestMs('')).toBe(5000);
    expect(resolveSlowRequestMs('0')).toBe(0);
    expect(resolveSlowRequestMs('250')).toBe(250);
    expect(resolveSlowRequestMs('12.7')).toBe(12);
    expect(resolveSlowRequestMs('abc')).toBe(5000);
    expect(resolveSlowRequestMs('-5')).toBe(5000);
  });

  it('VANBLOG_ACCESS_LOG：默认关，只认 true/1', () => {
    expect(resolveAccessLogFlag(undefined)).toBe(false);
    expect(resolveAccessLogFlag('true')).toBe(true);
    expect(resolveAccessLogFlag('1')).toBe(true);
    expect(resolveAccessLogFlag('yes')).toBe(false);
  });
});

describe('中间件行为（express + supertest）', () => {
  it('没有入站头：生成 uuid，echo 到响应头，并挂到 req.requestId', async () => {
    const { app } = buildApp({ slowMs: 5000, accessLog: false });
    const res = await request(app).get('/api/echo-id').expect(200);
    const header = res.headers[REQUEST_ID_HEADER];
    expect(header).toMatch(UUID_RE);
    expect(res.body).toEqual({ id: header });
  });

  it('合法入站头：原样沿用（反代/前端可以把自己的 id 串进来）', async () => {
    const { app } = buildApp({ slowMs: 5000, accessLog: false });
    const res = await request(app)
      .get('/api/ok')
      .set(REQUEST_ID_HEADER, 'trace-42_abc')
      .expect(200);
    expect(res.headers[REQUEST_ID_HEADER]).toBe('trace-42_abc');
  });

  it('注入尝试的入站头被替换成生成的 id（响应头里不含空格/换行）', async () => {
    const { app } = buildApp({ slowMs: 5000, accessLog: false });
    const res = await request(app)
      .get('/api/ok')
      .set(REQUEST_ID_HEADER, 'bad id with spaces')
      .expect(200);
    expect(res.headers[REQUEST_ID_HEADER]).toMatch(UUID_RE);
    expect(res.headers[REQUEST_ID_HEADER]).not.toContain(' ');
  });

  it('响应体一个字节都不变', async () => {
    const { app } = buildApp({ slowMs: 5000, accessLog: false });
    const res = await request(app).get('/api/ok').expect(200);
    expect(res.text).toBe('{"ok":true}');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('5xx：打一条带 id 的 error 日志（默认配置下就有）', async () => {
    const { app, logger } = buildApp({ slowMs: 0, accessLog: false });
    const res = await request(app).get('/api/boom').expect(503);
    const id = res.headers[REQUEST_ID_HEADER];
    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = String(logger.error.mock.calls[0][0]);
    expect(line).toContain(id);
    expect(line).toContain('GET /api/boom');
    expect(line).toContain('503');
    // 5xx 已经报过了，不再重复报慢请求
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('慢请求：超过阈值打 WARN（带 id），阈值内不打', async () => {
    const { app, logger } = buildApp({ slowMs: 30, accessLog: false });
    await request(app).get('/api/slow').expect(200);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('慢请求');
    expect(String(logger.warn.mock.calls[0][0])).toMatch(UUID_IN_LINE_RE);
    await request(app).get('/api/ok').expect(200);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('slowMs=0：慢请求日志整个关掉', async () => {
    const { app, logger } = buildApp({ slowMs: 0, accessLog: false });
    await request(app).get('/api/slow').expect(200);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('access log：开着时 API 请求打 INFO、静态资源不打；关着时一条都不打', async () => {
    const on = buildApp({ slowMs: 5000, accessLog: true });
    await request(on.app).get('/api/ok').expect(200);
    await request(on.app).get('/static/img/x.webp').expect(200);
    expect(on.logger.log).toHaveBeenCalledTimes(1);
    expect(String(on.logger.log.mock.calls[0][0])).toContain('GET /api/ok 200');

    const off = buildApp({ slowMs: 5000, accessLog: false });
    await request(off.app).get('/api/ok').expect(200);
    expect(off.logger.log).not.toHaveBeenCalled();
  });

  it('入站 id 会出现在慢请求/5xx 日志行里（端到端归因）', async () => {
    const { app, logger } = buildApp({ slowMs: 30, accessLog: false });
    await request(app).get('/api/slow').set(REQUEST_ID_HEADER, 'upstream-trace-1').expect(200);
    expect(String(logger.warn.mock.calls[0][0])).toContain('upstream-trace-1');
  });
});

describe('源码断言（剥掉注释再查）', () => {
  const { readFileSync } = require('fs');
  const { join } = require('path');
  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l: string) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
  const requestIdSrc = strip(readFileSync(join(__dirname, 'requestId.ts'), 'utf8'));
  const appModuleSrc = strip(readFileSync(join(__dirname, '..', 'app.module.ts'), 'utf8'));

  it('中间件里没有任何同步文件 I/O（这是每个请求都要跑的路径）', () => {
    expect(requestIdSrc).not.toContain('readFileSync');
    expect(requestIdSrc).not.toContain('writeFileSync');
    expect(requestIdSrc).not.toContain("from 'fs'");
    expect(requestIdSrc).not.toContain("from 'node:fs'");
    // 计时用单调时钟，不用 new Date()
    expect(requestIdSrc).toContain('performance.now()');
    expect(requestIdSrc).not.toContain('new Date()');
  });

  it('app.module 里注册在所有中间件的最前面', () => {
    // 用"注册调用"定位，不能用裸标识符 —— 文件头的 import 语句会先匹配到
    const ridIdx = appModuleSrc.indexOf('makeRequestIdMiddleware({');
    const secIdx = appModuleSrc.indexOf('.apply(securityHeadersMiddleware');
    const initIdx = appModuleSrc.indexOf('.apply(InitMiddleware)');
    expect(ridIdx).toBeGreaterThan(-1);
    expect(secIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(-1);
    expect(ridIdx).toBeLessThan(secIdx);
    expect(secIdx).toBeLessThan(initIdx);
  });

  it('默认阈值 5000ms、access log 默认关（不改环境变量就不刷屏）', () => {
    expect(requestIdSrc).toContain("resolveSlowRequestMs(raw: string | undefined = process.env.VANBLOG_SLOW_REQUEST_MS)");
    expect(requestIdSrc).toContain("resolveAccessLogFlag(raw: string | undefined = process.env.VANBLOG_ACCESS_LOG)");
    expect(SLOW_REQUEST_MS_DEFAULT).toBe(5000);
    expect(resolveAccessLogFlag(undefined)).toBe(false);
  });
});

describe('访问日志的静态资源判定必须与限流分档同口径（2026-09-22）', () => {
  // 🔴 背景：`isStaticAssetPath` 是大小写敏感的 startsWith，而 Express 默认路由大小写不敏感、
  //    静态挂载前缀同样不敏感 ⇒ 传原始 req.path 会让"真的是静态资源"的大小写变体照常写访问日志。
  //    后果不是安全问题（这一行只决定写不写日志），而是**日志放大**：静态资源本就是访问量最大的
  //    一类路径，正因如此才被排除在访问日志外。
  it('静态资源的大小写变体也不写访问日志（与规范写法一致）', async () => {
    const { app, logger } = buildApp({ slowMs: 5000, accessLog: true });
    // 先证明 Express 的路由确实大小写不敏感（否则这条用例的前提不成立、会变成空的绿）
    await request(app).get('/STATIC/img/x.webp').expect(200);
    await request(app).get('/Static/Img/x.webp').expect(200);
    await request(app).get('/static/img/x.webp/').expect(200);
    await request(app).get('/static/img/x.webp').expect(200);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('非静态路径仍然照常写访问日志（反证：不是把所有日志都关掉了）', async () => {
    const { app, logger } = buildApp({ slowMs: 5000, accessLog: true });
    await request(app).get('/api/ok').expect(200);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(String(logger.log.mock.calls[0][0])).toContain('GET /api/ok 200');
  });

  it('🔴 同口径：两个调用点都用同一个归一化组合（跨文件源码级钉子）', () => {
    // ⚠️ 这条**不能**写成"在测试里各算一遍再比对" —— 两边用同一个表达式算出来的值必然相等，
    //    那是恒真断言（本仓库已多次栽在"尺子自己坏了"上）。真正的不变量是**两个文件的源码
    //    都用同一个组合**，所以这里钉源码，并在下面单独钉住期望值本身。
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const strip = (f: string) =>
      (readFileSync(join(__dirname, f), 'utf8') as string)
        .split('\n')
        .filter((l: string) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
    const reqId = strip('requestId.ts');
    const rate = strip('rateLimit.ts');
    // 访问日志侧
    expect(reqId).toContain('isStaticAssetPath(normalizeRateLimitPath(req.path))');
    // 限流分档侧：中间件里的 path 只能由归一化函数赋值，且静态判定吃的是那个 path
    expect(rate).toMatch(/const path = normalizeRateLimitPath\(/);
    expect(rate).toContain('isStaticAssetPath(path)');
    // 反证：两侧都不许再出现"喂原始路径"的形状
    expect(reqId).not.toMatch(/isStaticAssetPath\(String\(req\.path/);
    expect(reqId).not.toContain('isStaticAssetPath(req.path)');
  });

  it('静态判定的期望值本身（避免上面那条在两边都错时恒真）', () => {
    const cases: Array<[string, boolean]> = [
      ['/static/img/a.webp', true],
      ['/STATIC/img/a.webp', true],
      ['/Static/Img/a.webp/', true],
      ['/static/', false],
      ['/static', false],
      ['/statics/x', false],
      ['/api/public/category', false],
      ['/API/public/category', false],
      ['/', false],
      ['', false],
    ];
    for (const [p, want] of cases) {
      expect({ p, hit: isStaticAssetPath(normalizeRateLimitPath(p)) }).toEqual({ p, hit: want });
    }
    // 🔴 反向对照：不归一化时大小写变体会被判成非静态（这正是修复前的行为）
    expect(isStaticAssetPath('/STATIC/img/a.webp')).toBe(false);
  });

});
