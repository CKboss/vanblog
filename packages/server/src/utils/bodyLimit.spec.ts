import express, { json } from 'express';
import request from 'supertest';
import {
  DEFAULT_JSON_BODY_LIMIT,
  DEFAULT_JSON_BODY_LIMIT_LARGE,
  LARGE_JSON_BODY_PREFIXES,
  resolveBodyLimit,
} from './bodyLimit';

/**
 * JSON body 限额：全局 1mb + 内容类前缀 50mb。
 *
 * 三块内容：
 *  1. `resolveBodyLimit` 的清洗规则（非法值必须回落默认，绝不能把 NaN/怪字符串交给 body-parser）；
 *  2. 用与 main.ts **完全相同的挂载顺序**搭一个最小 express 应用做集成验证：
 *     小 body 到处都收、大 body 只在放宽的前缀上收（其它路由 413）、每个请求只被解析一次；
 *  3. 源码断言：main.ts 不再有全局 50mb，且大解析器挂在全局解析器**之前**。
 */

describe('resolveBodyLimit：环境变量清洗', () => {
  it('缺失/空白回落默认值', () => {
    expect(resolveBodyLimit(undefined, DEFAULT_JSON_BODY_LIMIT)).toBe('1mb');
    expect(resolveBodyLimit('', DEFAULT_JSON_BODY_LIMIT)).toBe('1mb');
    expect(resolveBodyLimit('   ', DEFAULT_JSON_BODY_LIMIT_LARGE)).toBe('50mb');
  });

  it('bytes 认识的写法原样通过（去空白、小写化）', () => {
    expect(resolveBodyLimit('10mb', '1mb')).toBe('10mb');
    expect(resolveBodyLimit(' 512KB ', '1mb')).toBe('512kb');
    expect(resolveBodyLimit('1.5gb', '1mb')).toBe('1.5gb');
    expect(resolveBodyLimit('100', '1mb')).toBe('100'); // 纯数字 = 字节
    expect(resolveBodyLimit('256b', '1mb')).toBe('256b');
  });

  it('非法值一律回落默认（绝不让怪字符串进解析器）', () => {
    for (const bad of ['abc', '-5mb', '1tb', '1e9', 'Infinity', 'NaN', '0x10', '1 mb;', 'mb', '1;DROP']) {
      expect(resolveBodyLimit(bad, '1mb')).toBe('1mb');
    }
  });
});

describe('LARGE_JSON_BODY_PREFIXES：只有后台内容类路由放宽', () => {
  it('包含四个内容前缀', () => {
    expect([...LARGE_JSON_BODY_PREFIXES].sort()).toEqual(
      [
        '/api/admin/article',
        '/api/admin/customPage',
        '/api/admin/draft',
        '/api/admin/pipeline',
      ].sort(),
    );
  });

  it('匿名可达的路由（登录/评论/访客计数/备份导入）都不在放宽名单里', () => {
    for (const prefix of [
      '/api/admin/auth',
      '/api/public',
      '/api/admin/backup',
      '/api/admin/img',
      '/api/admin/setting',
      '/api/admin/theme',
    ]) {
      expect(LARGE_JSON_BODY_PREFIXES).not.toContain(prefix);
    }
  });
});

describe('与 main.ts 相同的挂载顺序（集成）', () => {
  const SMALL = '1mb';
  const LARGE = '5mb';

  function buildApp() {
    const counting = (limit: string) =>
      json({
        limit,
        verify: (req: any) => {
          req.__parses = (req.__parses || 0) + 1;
        },
      });
    const app = express();
    const largeParser = counting(LARGE);
    for (const prefix of LARGE_JSON_BODY_PREFIXES) {
      app.use(prefix, largeParser);
    }
    app.use(counting(SMALL));
    const echo = (req: any, res: any) =>
      res.json({ bytes: JSON.stringify(req.body || {}).length, parses: req.__parses || 0 });
    app.post('/api/public/comments', echo);
    app.post('/api/admin/auth/login', echo);
    app.post('/api/admin/article', echo);
    app.post('/api/admin/article/123', echo);
    app.post('/api/admin/customPage', echo);
    // 413 也走 JSON（便于断言；真实应用里由 express/Nest 的错误层接管，形状不重要，状态码才重要）
    app.use((err: any, _req: any, res: any, next: any) => {
      if (err?.type === 'entity.too.large' || err?.status === 413) {
        return res.status(413).json({ statusCode: 413, message: 'payload too large' });
      }
      return next(err);
    });
    return app;
  }

  const bodyOf = (bytes: number) => ({ pad: 'x'.repeat(Math.max(0, bytes - 12)) });

  it('小 body 在任何路由都照收', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/public/comments')
      .send({ content: 'hi', nick: 'a' })
      .expect(200);
    expect(res.body.parses).toBe(1);
  });

  it('1.2mb 的 body：评论/登录路由 413，内容路由 200', async () => {
    const app = buildApp();
    await request(app).post('/api/public/comments').send(bodyOf(1.2 * 1024 * 1024)).expect(413);
    await request(app).post('/api/admin/auth/login').send(bodyOf(1.2 * 1024 * 1024)).expect(413);
    const ok = await request(app).post('/api/admin/article').send(bodyOf(1.2 * 1024 * 1024)).expect(200);
    expect(ok.body.bytes).toBeGreaterThan(1.2 * 1024 * 1024 - 64);
    // 前缀挂载对子路径也生效（PUT /api/admin/article/:id）
    await request(app).post('/api/admin/article/123').send(bodyOf(1.2 * 1024 * 1024)).expect(200);
    await request(app).post('/api/admin/customPage').send(bodyOf(1.2 * 1024 * 1024)).expect(200);
  });

  it('大 body 只被解析一次（全局小解析器跳过已解析的请求，不产生二次开销）', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/admin/article').send(bodyOf(2 * 1024 * 1024)).expect(200);
    expect(res.body.parses).toBe(1);
  });

  it('超过大限额的路由同样 413（5mb 上限仍然生效）', async () => {
    const app = buildApp();
    await request(app).post('/api/admin/article').send(bodyOf(5.5 * 1024 * 1024)).expect(413);
  });
});

describe('main.ts 源码断言（剥掉注释再查）', () => {
  const { readFileSync } = require('fs');
  const { join } = require('path');
  const src: string = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l: string) => !/^\s*\/\//.test(l))
    .join('\n');

  it('不再有全局 50mb 的 json 解析器', () => {
    expect(code).not.toMatch(/json\(\{\s*limit:\s*'50mb'\s*\}\)/);
    expect(code).not.toMatch(/json\(\{\s*limit:\s*"50mb"\s*\}\)/);
  });

  it('大解析器按前缀挂载，且在全局小解析器之前', () => {
    const largeIdx = code.indexOf('app.use(prefix, largeJsonParser);');
    const globalIdx = code.indexOf('app.use(json({ limit: jsonLimit }));');
    expect(largeIdx).toBeGreaterThan(-1);
    expect(globalIdx).toBeGreaterThan(-1);
    expect(largeIdx).toBeLessThan(globalIdx);
    // 全局解析器还得在 sanitizeRequestPayloads 之前（净化器读的是解析好的 body）
    expect(globalIdx).toBeLessThan(code.indexOf('app.use(sanitizeRequestPayloads);'));
  });

  it('默认值是 1mb / 50mb，环境变量可以改', () => {
    expect(code).toContain("DEFAULT_JSON_BODY_LIMIT");
    expect(code).toContain("DEFAULT_JSON_BODY_LIMIT_LARGE");
    expect(code).toContain('VANBLOG_JSON_BODY_LIMIT');
    expect(code).toContain('VANBLOG_JSON_BODY_LIMIT_LARGE');
    expect(DEFAULT_JSON_BODY_LIMIT).toBe('1mb');
    expect(DEFAULT_JSON_BODY_LIMIT_LARGE).toBe('50mb');
  });
});
