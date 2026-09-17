import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as http from 'http';
import { AddressInfo } from 'net';

import { sanitizeRequestPayloads, stripOperatorKeys } from './utils/sanitizeRequest';

/**
 * 第四轮安全审计 —— 「静态目录的匿名 403 护栏 / 中间件顺序」这一组。
 *
 * 两条 FINDING 都是**同一类根因**：`main.ts` 在 `app.listen()`（⇒ `app.init()`）
 * **之前**用 `app.use(...)` 挂了 json 解析、请求净化、静态目录 403 护栏与
 * `useStaticAssets`，而 `app.module.ts` 里那四处 `forRoutes({path:'*'})`
 * （request-id → 安全头+限流 → no-store → init）是 Nest 在 `init()` 里才装上的。
 * 于是 express 栈的真实顺序是：
 *
 *   [json][sanitize][静态403护栏][express.static /static][swagger] … [request-id][安全头][限流][no-store][init][路由]
 *                                └── 到这里响应就结束了，后面全都不会跑 ──┘
 *
 * 后果 1（R4-3，**已修**）：`/static/**`、`/swagger`、`/swagger-json` 曾经完全不经过
 *   限流与安全头，`utils/rateLimit.ts` 里那个"静态资源独立桶"（`isStaticAssetPath` 分支，
 *   默认 6000/分钟）曾经是**永远走不到的死代码**。
 * 后果 2（R4-4，已修）：那道 403 护栏用 `req.path.startsWith('/static/export/')` 判定，
 *   而 `req.path` 是 express 从 `url.parse(req.url).pathname` 取的**原始串** ——
 *   不百分号解码、不折叠 `.`/`..`、不合并重复斜杠；可 serve-static/send 在开文件
 *   **之前**会解码并归一化。两层对"这个路径是什么"的看法不一致 ⇒ 护栏可绕过。
 *
 * ⚠️ 2026-09-17：R4-3 与 R4-4 都已修复，上面的栈顺序图是**修复前**的形状（保留作证据）。
 * R4-3 的修法：main.ts 在 useStaticAssets/SwaggerModule.setup **之前**给
 * `/static/ /rss/ /sitemap/ /swagger` 四个前缀挂一遍 securityHeaders+rateLimit
 * （响应在 express 层就结束，Nest 那份中间件够不到 ⇒ 不会重复计数）+ `app.disable('x-powered-by')`。
 * 原 `xit('AFTER THE FIX …')` 已按文件头约定转成真实断言；`REGRESSION` 必须常绿。
 */

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

/** main.ts:87-108 那道护栏的**逐字复刻**（改动前实现的冻结参照物） */
function makeStaticGuardMiddleware(backupUnderStatic: string | null) {
  return (req: any, res: any, next: () => void) => {
    if (
      req.path.startsWith('/static/export/') ||
      req.path.startsWith('/static/tmp/') ||
      req.path.startsWith('/static/upload-tmp/') ||
      (backupUnderStatic && req.path.startsWith(backupUnderStatic))
    ) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ statusCode: 403, message: '整站备份只能通过后台的鉴权接口下载' }));
      return;
    }
    next();
  };
}

/** 发一个**原始**请求（不经过任何 URL 归一化），返回状态码与响应体 */
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('REGRESSION R4-4：/static 的匿名 403 护栏曾经可以被编码/点段/重复斜杠绕过（已修，这里钉住）', () => {
  it('main.ts 现在走 utils/staticGuard 的 isGuardedStaticPath，不再是裸 startsWith（源码钉子）', () => {
    const main = read('./main.ts');
    expect(main).toMatch(/isGuardedStaticPath\(req\.path, backupSegment\)/);
    expect(main).toMatch(/backupFirstSegmentUnderStatic\(/);
    expect(main).not.toMatch(/req\.path\.startsWith\('\/static\/export\/'\)/);
    expect(main).not.toMatch(/req\.path\.startsWith\('\/static\/tmp\/'\)/);
    expect(main).not.toMatch(/req\.path\.startsWith\('\/static\/upload-tmp\/'\)/);
  });

  it('新实现对全部 6 种绕过写法都判定为"该挡"，同时不误伤公开路径', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isGuardedStaticPath, guardedStaticFirstSegment, backupFirstSegmentUnderStatic, ESCAPED } = require('./utils/staticGuard');
    const guarded = [
      '/static/export/f.zip', // 字面拼写（旧实现唯一挡得住的那种）
      '/static/%65xport/f.zip', // %65 = 'e'
      '/static/%45XPORT/f.zip', // 大写十六进制
      '/static/export%2ff.zip', // %2f = '/'
      '/static/export%2Ff.zip',
      '/static/./export/f.zip', // 点段
      '/static/./export/./f.zip',
      '/static//export/f.zip', // 重复斜杠
      '/static///export///f.zip',
      '/static/%2e/export/f.zip', // %2e = '.'
      '/static/tmp/full-restore-Ab12Cd/vanblog.ndjson', // 整站恢复暂存（含密码哈希与 jwt 密钥）
      '/static/%74mp/full-restore-Ab12Cd/vanblog.ndjson',
      '/static/upload-tmp/a.tar.zst',
      '/static/upload-tmp%2fa.tar.zst',
      '/static/export', // 无尾斜杠（旧实现是 serve-static 的 301 → 再 403）
    ];
    for (const p of guarded) {
      expect([p, isGuardedStaticPath(p, null)]).toEqual([p, true]);
    }
    const allowed = [
      '/static/img/a.webp',
      '/static/img/thumb/a.webp',
      '/static/file/report.pdf',
      '/static/themes/warm-paper-28381fac.css',
      '/static/customPage/block1/index.html',
      '/static/exportx/innocent.txt', // 首段是 exportx，不是 export —— 前缀匹配会误伤，首段比较不会
      '/api/public/meta',
      '/rss/feed.xml',
      '/staticx/img/a.webp',
    ];
    for (const p of allowed) {
      expect([p, isGuardedStaticPath(p, null)]).toEqual([p, false]);
    }
    expect(guardedStaticFirstSegment('/static/%65xport/f.zip')).toBe('export');
    // 归一化后**逃出** /static 的：守卫不把判断权交给下游，直接当成受控路径 403
    expect(guardedStaticFirstSegment('/static/../etc/passwd')).toBe(ESCAPED);
    expect(guardedStaticFirstSegment('/static/%2e%2e/%2e%2e/etc/passwd')).toBe(ESCAPED);
    expect(isGuardedStaticPath('/static/%2e%2e/export/f.zip', null)).toBe(true);
    // 首段比较是小写的：大小写不敏感的文件系统上 `/static/Export/` 就是同一个目录
    expect(guardedStaticFirstSegment('/static/Export/f.zip')).toBe('export');
    expect(isGuardedStaticPath('/static/EXPORT/f.zip', null)).toBe(true);
    expect(isGuardedStaticPath('/static/exportx/innocent.txt', null)).toBe(false); // 前缀匹配会误伤，首段比较不会
    // backupPath 被配进静态目录时的兜底
    expect(backupFirstSegmentUnderStatic('/app/static', '/app/static/backups')).toBe('backups');
    expect(backupFirstSegmentUnderStatic('/app/static', '/var/log/vanblog-backups')).toBeNull();
    expect(isGuardedStaticPath('/static/%62ackups/full.tar.zst', 'backups')).toBe(true);
  });

  it('端到端：把新护栏 + express.static 串起来，6 种绕过写法全部 403，公开文件照常 200', async () => {
    const express = require('express');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isGuardedStaticPath } = require('./utils/staticGuard');
    const dir = mkdtempSync(join(tmpdir(), 'vb-audit4-fixed-'));
    const secret = 'FULL-BACKUP-NDJSON password-hash jwt-secret DO-NOT-SERVE';
    try {
      mkdirSync(join(dir, 'export'), { recursive: true });
      mkdirSync(join(dir, 'tmp', 'full-restore-Ab12Cd'), { recursive: true });
      mkdirSync(join(dir, 'img'), { recursive: true });
      writeFileSync(join(dir, 'export', 'export-file-2026-09-12.zip'), secret);
      writeFileSync(join(dir, 'tmp', 'full-restore-Ab12Cd', 'vanblog.ndjson'), secret);
      writeFileSync(join(dir, 'img', 'ok.txt'), 'public-image');
      const app = express();
      app.use((req: any, res: any, next: () => void) => {
        if (isGuardedStaticPath(req.path, null)) {
          res.statusCode = 403;
          return res.end('{"statusCode":403}');
        }
        next();
      });
      app.use('/static', express.static(dir));
      app.use((_req: any, res: any) => res.status(404).json({ message: 'Cannot GET' }));
      const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const port = (server.address() as AddressInfo).port;
      for (const p of [
        '/static/export/export-file-2026-09-12.zip',
        '/static/%65xport/export-file-2026-09-12.zip',
        '/static/export%2fexport-file-2026-09-12.zip',
        '/static/./export/export-file-2026-09-12.zip',
        '/static//export/export-file-2026-09-12.zip',
        '/static/%2e/export/export-file-2026-09-12.zip',
        '/static/%74mp/full-restore-Ab12Cd/vanblog.ndjson',
      ]) {
        const r = await rawGet(port, p);
        expect([p, r.status]).toEqual([p, 403]);
        expect(r.body).not.toContain('DO-NOT-SERVE');
      }
      expect((await rawGet(port, '/static/img/ok.txt')).body).toBe('public-image');
      await new Promise((r) => server.close(r));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('为什么必须有这条钉子：**旧实现**（逐字冻结在下面）真的能被绕过', async () => {
    // 这不是假想：活体（一次性实例 + 真 express.static）实测
    //   /static/%65xport/<file> -> 200 + 文件全部字节
    //   /static/%74mp/full-restore-*/vanblog.ndjson -> 200
    // 根因：req.path 是 url.parse(req.url).pathname（未解码/未归一化），
    // 而 send 在开文件前会 decode + normalize —— 两层口径不一致。
    const express = require('express');
    const dir = mkdtempSync(join(tmpdir(), 'vb-audit4-old-'));
    const secret = 'DO-NOT-SERVE';
    try {
      mkdirSync(join(dir, 'export'), { recursive: true });
      writeFileSync(join(dir, 'export', 'f.zip'), secret);
      const app = express();
      app.use(makeStaticGuardMiddleware(null)); // ← 旧实现
      app.use('/static', express.static(dir));
      app.use((_req: any, res: any) => res.status(404).end());
      const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const port = (server.address() as AddressInfo).port;
      expect((await rawGet(port, '/static/export/f.zip')).status).toBe(403); // 只挡住最老实的写法
      for (const p of ['/static/%65xport/f.zip', '/static/export%2ff.zip', '/static/./export/f.zip', '/static//export/f.zip']) {
        const r = await rawGet(port, p);
        expect([p, r.status, r.body]).toEqual([p, 200, secret]); // ← 绕过，真的拿到了字节
      }
      await new Promise((r) => server.close(r));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('REGRESSION R4-3（已修）：/static/** 与 /swagger 曾经完全绕过限流与安全头（那个"静态桶"曾是死代码）', () => {
  it('main.ts 把 useStaticAssets 与 SwaggerModule.setup 都放在 app.listen() 之前（顺序没变，变的是它们**前面**多了一层）', () => {
    const main = read('./main.ts');
    const iStatic = main.indexOf('app.useStaticAssets(globalConfig.staticPath');
    const iSwagger = main.indexOf("SwaggerModule.setup('swagger', app, document)");
    const iListen = main.indexOf('await app.listen(');
    expect(iStatic).toBeGreaterThan(-1);
    expect(iSwagger).toBeGreaterThan(-1);
    expect(iListen).toBeGreaterThan(-1);
    expect(iStatic).toBeLessThan(iListen);
    expect(iSwagger).toBeLessThan(iListen);
    // 修复：pre-Nest 的安全头+限流挂在 useStaticAssets **之前**（express 按注册顺序执行）
    const iPreNest = main.indexOf('const PRE_NEST_LIMITED_PREFIXES');
    expect(iPreNest).toBeGreaterThan(-1);
    expect(iPreNest).toBeLessThan(iStatic);
    expect(iPreNest).toBeLessThan(iSwagger);
    // Nest 的那份模块中间件仍然只在 init()（listen() 内部）里才装
    const appModule = read('./app.module.ts');
    expect(appModule).toMatch(/\.apply\(securityHeadersMiddleware, rateLimitMiddleware\)/);
    expect(appModule).toMatch(/forRoutes\(\{\s*path: '\*',\s*method: RequestMethod\.ALL,?\s*\}\)/);
  });

  it('限流里的静态桶分支现在真的会被走到（曾经是死代码；源码钉子）', () => {
    const rl = read('./utils/rateLimit.ts');
    expect(rl).toMatch(/if \(isStaticAssetPath\(path\)\) \{\s*\n\s*const hit = consumeAttempt\(`rl-static-\$\{ip\}`/);
    // isStaticAssetPath 的判定本身一直是对的 —— 修复前的问题是它永远走不到：
    // /static/** 的响应在 Nest 中间件之前的 express.static 就结束了。
    // 现在 main.ts 在静态层前面先跑一遍 securityHeaders+rateLimit
    // ⇒ `rl-static-<ip>`（VANBLOG_STATIC_LIMIT_PER_MIN，默认 6000/分钟）第一次成为活代码。
    // 修复前的活体实测（一次性实例，三档限流都设 5，留档）：
    //   12 × GET /static/img/probe.txt -> 200 × 12（一次都没限）
    //   12 × GET /swagger-json         -> 200 × 12（59 KB/次，无限速）
    //   12 × GET /api/public/meta      -> 200 × 5 然后 429 × 7（Nest 路由确实被限）
    expect(read('./main.ts')).toMatch(
      /securityHeadersMiddleware\(req, res, \(\) => rateLimitMiddleware\(req, res, next\)\);/,
    );
  });

  it('为什么必须有这条钉子：**修复前**的注册顺序（冻结复刻）下，静态请求根本走不到限流器', async () => {
    // ⚠️ 历史证据（与 REGRESSION R4-4 复刻旧 403 护栏同一做法）：main.ts 现在的顺序
    // 已经不是这样了（pre-Nest 中间件在前，见下一条用例），这里冻结的是**修复前**的形状。
    const express = require('express');
    const dir = mkdtempSync(join(tmpdir(), 'vb-audit4-order-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'img-bytes');
      // 用**真的**限流中间件，只把阈值压到 1（阈值在模块加载时读取，所以这里才第一次 require 它）
      // 阈值在模块加载时读取 ⇒ 先设 env 再第一次 require 这个模块（本文件别处没有 import 它）
      process.env.VANBLOG_RATE_LIMIT_PER_MIN = '1';
      process.env.VANBLOG_STATIC_LIMIT_PER_MIN = '1';
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const rl = require('./utils/rateLimit');
      const rateLimitMiddleware = rl.rateLimitMiddleware;
      const securityHeadersMiddleware = rl.securityHeadersMiddleware;
      // 桶的判定条件本身是对的 —— 问题在于它永远走不到
      expect(rl.isStaticAssetPath('/static/img/a.webp')).toBe(true);
      expect(rl.isStaticAssetPath('/api/public/meta')).toBe(false);

      const app = express();
      // ↓ 修复前 main.ts 在 listen() 之前挂的那些
      app.use('/static', express.static(dir));
      // ↓ app.module.ts 的中间件（Nest 在 init() 里才装，因此排在静态之后）
      app.use(securityHeadersMiddleware, rateLimitMiddleware);
      app.get('/api/public/meta', (_req: any, res: any) => res.json({ ok: true }));

      const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const port = (server.address() as AddressInfo).port;
      // 带上 XFF ⇒ isLoopbackRequest 为假，限流器真的会算（否则回环请求直接放行）
      const statuses: number[] = [];
      const headerSets: Array<string | undefined> = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
          const q = http.request({ host: '127.0.0.1', port, path: '/static/a.txt', headers: { 'X-Forwarded-For': '203.0.113.31' } }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers }));
          });
          q.on('error', reject);
          q.end();
        });
        statuses.push(r.status);
        headerSets.push(r.headers['x-frame-options'] as string | undefined);
      }
      expect(statuses).toEqual([200, 200, 200, 200]); // 阈值 1/分钟也照样 4 个 200
      expect(headerSets.every((h) => h === undefined)).toBe(true); // 安全头一个都没加上
      // 对照组：同一条栈上的 Nest 风格路由**会**被限流、**会**带安全头
      const apiStatuses: number[] = [];
      let apiFrame = '';
      for (let i = 0; i < 4; i += 1) {
        const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
          const q = http.request({ host: '127.0.0.1', port, path: '/api/public/meta', headers: { 'X-Forwarded-For': '203.0.113.32' } }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers }));
          });
          q.on('error', reject);
          q.end();
        });
        apiStatuses.push(r.status);
        apiFrame = String(r.headers['x-frame-options'] || '');
      }
      expect(apiStatuses[0]).toBe(200);
      expect(apiStatuses.slice(1)).toEqual([429, 429, 429]);
      expect(apiFrame).toBe('SAMEORIGIN');
      await new Promise((r) => server.close(r));
    } finally {
      delete process.env.VANBLOG_RATE_LIMIT_PER_MIN;
      delete process.env.VANBLOG_STATIC_LIMIT_PER_MIN;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('可执行证据：**修复后**的注册顺序下，静态请求过一次（且只过一次）安全头+限流', async () => {
    // 复刻 main.ts 修复后的形状：pre-Nest 前缀中间件 → express.static → （Nest 那份）中间件 → 路由。
    // 限流模块与上一条用例同一个（阈值 1/分钟在模块加载时已固化）。
    // 判定"没有重复计数"的方法很硬：阈值是 1/分钟，如果同一个请求被计了两次，
    // **第一个**请求就会 429（第二次 consumeAttempt 把 count 顶到 2 > 1）。
    const express = require('express');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rl = require('./utils/rateLimit');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { __resetAttemptLimitForTest, attemptLimitStats } = require('./utils/attemptLimit');
    const rateLimitMiddleware = rl.rateLimitMiddleware;
    const securityHeadersMiddleware = rl.securityHeadersMiddleware;
    const PRE_NEST_LIMITED_PREFIXES = ['/static/', '/rss/', '/sitemap/', '/swagger'];
    const dir = mkdtempSync(join(tmpdir(), 'vb-audit4-fixedorder-'));
    __resetAttemptLimitForTest();
    try {
      writeFileSync(join(dir, 'a.txt'), 'img-bytes');
      const app = express();
      // ↓ 修复后 main.ts 挂在 useStaticAssets 之前的那层（前缀白名单 + 安全头 → 限流）
      app.use((req: any, res: any, next: () => void) => {
        if (!PRE_NEST_LIMITED_PREFIXES.some((p) => req.path.startsWith(p))) return next();
        securityHeadersMiddleware(req, res, () => rateLimitMiddleware(req, res, next));
      });
      app.use('/static', express.static(dir));
      // ↓ Nest 那份中间件（静态/swagger 的响应在它之前就结束 ⇒ 够不到 ⇒ 不会重复计数）
      app.use(securityHeadersMiddleware, rateLimitMiddleware);
      app.get('/api/public/meta', (_req: any, res: any) => res.json({ ok: true }));
      const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const port = (server.address() as AddressInfo).port;
      const get = (path: string, xff: string) =>
        new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
          const q = http.request({ host: '127.0.0.1', port, path, headers: { 'X-Forwarded-For': xff } }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers }));
          });
          q.on('error', reject);
          q.end();
        });
      // 静态：第一个请求 200（若重复计数这里就会是 429）且带安全头；第二个 429（限流真的生效）
      const s1 = await get('/static/a.txt', '203.0.113.41');
      const s2 = await get('/static/a.txt', '203.0.113.41');
      expect(s1.status).toBe(200);
      expect(s1.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(s2.status).toBe(429);
      // 一个静态请求只建了一个桶（rl-static-<ip>）——重复计数会变成同桶 count=2
      expect(attemptLimitStats().size).toBe(1);
      // 对照：/api 路由不被 pre-Nest 层计数（前缀不匹配直接 next()），由第二层限流
      const a1 = await get('/api/public/meta', '203.0.113.42');
      const a2 = await get('/api/public/meta', '203.0.113.42');
      expect(a1.status).toBe(200);
      expect(a1.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(a2.status).toBe(429);
      expect(attemptLimitStats().size).toBe(2);
      await new Promise((r) => server.close(r));
    } finally {
      __resetAttemptLimitForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('X-Powered-By 现在被关掉了（app.disable），响应不再自报框架', () => {
    const main = read('./main.ts');
    expect(main).toMatch(/app\.disable\('x-powered-by'\);/);
    const rl = read('./utils/rateLimit.ts');
    expect(rl).not.toMatch(/X-Powered-By/i); // 摘这个头不归 rateLimit 管，就是 app.disable 一处
    // 活体核验（修 main.ts 的那一轮）：/static/img/__probe__.png 与 /swagger-json
    // 的响应里已经没有任何 X-Powered-By。
  });

  it('AFTER THE FIX（已实现）：静态与 swagger 也要过一遍安全头 + 限流，且**不能**重复计数', () => {
    const main = read('./main.ts');
    // 落地与占位文字的形状一致，但有三处**更严/更名**的出入（按约定如实说明）：
    //  1) 常量名是 PRE_NEST_LIMITED_PREFIXES（占位文字里叫 PRE_NEST_PREFIXES），前缀集合一致：
    expect(main).toMatch(/const PRE_NEST_LIMITED_PREFIXES = \['\/static\/', '\/rss\/', '\/sitemap\/', '\/swagger'\];/);
    //  2) 多了一层「百分号解码后再比一次」（matchesPreNestPrefix，与 staticGuard 同口径）——
    //     占位文字里的裸 startsWith 可以被 %2Fstatic%2F… 之类的编码溜过去，实现比占位更严：
    expect(main).toMatch(/const decoded = decodeURIComponent\(rawPath\);/);
    expect(main).toMatch(/candidates\.some\(\(p\) => PRE_NEST_LIMITED_PREFIXES\.some\(\(prefix\) => p\.startsWith\(prefix\)\)\)/);
    //  3) 占位文字说"挂在 useStaticAssets 之前；因为静态/swagger 永远走不到 Nest 中间件，
    //     所以两边不会重复计数"——实现正是如此（顺序钉子 + 上一条的可执行复刻都验证了）：
    const iPre = main.indexOf('const PRE_NEST_LIMITED_PREFIXES');
    const iStatic = main.indexOf('app.useStaticAssets(globalConfig.staticPath');
    expect(iPre).toBeGreaterThan(-1);
    expect(iPre).toBeLessThan(iStatic);
    expect(main).toMatch(/securityHeadersMiddleware\(req, res, \(\) => rateLimitMiddleware\(req, res, next\)\);/);
    expect(main).toMatch(/app\.disable\('x-powered-by'\);/);
    // 占位文字还提到另一条"更正"的路（把 useStaticAssets/SwaggerModule.setup 挪到 app.init()
    // 之后）以及它为什么 blast radius 更大（InitMiddleware 会挡住初始化向导的上传）——
    // 实现选了占位文字推荐的第一条路，这条评估原样留档。
    // 活体核验（修 main.ts 的那一轮，真实例）：/static/img/__probe__.png 与 /swagger-json
    // 现在返回 X-Frame-Options: SAMEORIGIN 且没有 X-Powered-By。
  });
});

describe('FINDING R4-8：sanitizeRequestPayloads 是黑名单，且有两处结构性盲区', () => {
  it('req.params 那一句是空转：app 级中间件跑在路由之前，此时 params 还是 {}', async () => {
    const express = require('express');
    const captured: any[] = [];
    const app = express();
    app.use((req: any, _res: any, next: () => void) => {
      captured.push({ at: 'middleware', params: { ...req.params } });
      sanitizeRequestPayloads(req, _res, next);
    });
    app.get('/api/public/article/:id', (req: any, res: any) => {
      captured.push({ at: 'handler', params: { ...req.params } });
      res.json({ ok: true });
    });
    const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = (server.address() as AddressInfo).port;
    await rawGet(port, '/api/public/article/007');
    await new Promise((r) => server.close(r));
    expect(captured[0]).toEqual({ at: 'middleware', params: {} }); // ← 净化的是这个空对象
    expect(captured[1]).toEqual({ at: 'handler', params: { id: '007' } }); // ← 路由之后 express 重新赋值
  });

  it('multipart 的**文本字段**不经过净化（multer 在路由内部才跑）', async () => {
    const express = require('express');
    const multer = require('multer');
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024, files: 1, fields: 8, parts: 16 } });
    let seen: any = null;
    const app = express();
    app.use(sanitizeRequestPayloads); // ← main.ts:76 的位置
    app.post('/api/admin/img/:sign/replace', upload.single('file'), (req: any, res: any) => {
      seen = req.body;
      res.json({ ok: true });
    });
    const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = (server.address() as AddressInfo).port;
    const boundary = '----vbaudit4';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="sign"\r\n\r\n` +
        '{"$ne":"anything"}\r\n' +
        `--${boundary}\r\nContent-Disposition: form-data; name="__proto__"\r\n\r\nx\r\n` +
        `--${boundary}--\r\n`,
    );
    await new Promise<void>((resolve, reject) => {
      const q = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/admin/img/abc/replace',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length },
        },
        (res) => { res.resume(); res.on('end', () => resolve()); },
      );
      q.on('error', reject);
      q.end(payload);
    });
    await new Promise((r) => server.close(r));
    // JSON body 会被净化掉的东西，从 multipart 字段进来时**原样保留**
    expect(seen).not.toBeNull();
    expect(seen.sign).toBe('{"$ne":"anything"}');
    expect(Object.keys(seen)).toContain('sign');
    // ⚠️ 当前没有匿名可达的 multipart 路由会把这些字段塞进 Mongo 过滤器
    // （/api/admin/init/upload 只读 @Query('favicon')，/init/restore 只读文件），
    // 所以今天不可利用；但 `img.controller.ts:159` 那种「FileInterceptor + @Body()」
    // 的组合确实是净化盲区，新增路由时这是一个真实的坑。
  });

  it('REGRESSION：黑名单本身对 query/body 仍然有效（§7.40/§7.48 那条修复没退化）', () => {
    expect(stripOperatorKeys({ category: { $ne: 'x' }, title: 'a$b' })).toEqual({ category: {}, title: 'a$b' });
    expect(stripOperatorKeys({ a: { __proto__: { polluted: 1 }, b: 1 } })).toEqual({ a: { b: 1 } });
    expect(stripOperatorKeys({ a: { constructor: 1, prototype: 2, ok: 3 } })).toEqual({ a: { ok: 3 } });
    expect(({} as any).polluted).toBeUndefined();
    // 深度上限 8：更深的子树被替换成 undefined，不会炸栈
    let deep: any = 'leaf';
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    const flattened = stripOperatorKeys(deep);
    // 深度上限 8：第 9 层开始变成 undefined（不会炸栈、也不会把 20 层原样带进业务代码）
    let cursor: any = flattened;
    let depth = 0;
    while (cursor && typeof cursor === 'object') { cursor = cursor.nested; depth += 1; }
    expect(cursor).toBeUndefined();
    expect(depth).toBeLessThanOrEqual(10);
    // 值里的 $ 不受影响（markdown 正文里的 $PATH 之类）
    expect(stripOperatorKeys({ content: 'echo $PATH && $HOME' })).toEqual({ content: 'echo $PATH && $HOME' });
    // 活体（一次性实例）：8 种运算符注入全部无效
    //   ?category[$ne]=zzz / ?category[$regex]=.* / ?tags[$ne]=x / ?sortCreatedAt[$ne]=1
    //   ?page[$ne]=1&pageSize[$gt]=0 -> 200，语义与不带参数完全相同
    //   /api/public/customPage?path[$ne]=/nope -> 404；/api/public/comments/?path[$ne]=x -> 400
  });
});
