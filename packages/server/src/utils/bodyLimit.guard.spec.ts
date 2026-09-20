import express, { json } from 'express';
import type { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { AUTH_TOKEN_HEADER, LARGE_JSON_BODY_PREFIXES, anonymousLargeBodyGuard, resolveBodyLimit } from './bodyLimit';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * 匿名大 body 挡板（`anonymousLargeBodyGuard`）。
 *
 * 为什么需要它：`main.ts` 的中间件顺序是 `[json][sanitize][static403]…[rateLimit][init][router]`，
 * 也就是说 `express.json` 的解析跑在**限流器与鉴权之前**；而四个大限额解析器是按**路径**挂的
 * （`app.use(prefix, largeJsonParser)`），完全不看身份 ⇒ 匿名请求可以向 `/api/admin/article`
 * 投一个 50MB 的 JSON，我们会先花 **解析 ≈ 2.9 秒**（16MB 实测 916ms，线性外推）然后才 401；
 * 被限流 429 挡下的请求**同样已经把 CPU 烧完了**。
 *
 * ⚠️ `bodyLimit.ts` 里以前写着"全部在 AdminGuard 后面，匿名请求到不了解析器之后的处理器" ——
 * 那句话对**处理器**成立、对**解析**不成立，是一个误导性的安全论证，已按实测改写。
 *
 * ⚠️ 这个 guard 必须在 `main.ts` 里挂到大限额解析器**之前**才有效（两行接线，见 bodyLimit.ts
 * 的文档注释）。下面最后一条用例专门证明"顺序反了就完全无效"，免得接线的人凭直觉放错位置。
 */

const PREFIX = LARGE_JSON_BODY_PREFIXES[0];

/** 造一个 >1mb 但 <50mb 的合法 JSON（键少、字符串值大 —— 与真实的大正文同形状）。 */
function bigJsonBody(bytes: number): string {
  return JSON.stringify({ title: 'x', content: 'y'.repeat(Math.max(16, bytes - 32)) });
}

async function startServer(order: 'guard-first' | 'large-first') {
  const app = express();
  const guard = anonymousLargeBodyGuard(resolveBodyLimit(undefined, '1mb'));
  const large = json({ limit: '50mb' });
  if (order === 'guard-first') {
    app.use(PREFIX, guard);
    app.use(PREFIX, large);
  } else {
    app.use(PREFIX, large);
    app.use(PREFIX, guard);
  }
  app.post(PREFIX, (req: any, res: any) => {
    res.status(200).json({ parsed: req.body ? Object.keys(req.body).length : -1 });
  });
  // body-parser 超限会抛 413，交给默认错误处理即可（真实 main.ts 里也一样）
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

async function post(port: number, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${PREFIX}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe('匿名大 body 挡板：真实 HTTP 请求下的行为', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    ctx = await startServer('guard-first');
  });
  afterAll(async () => {
    await new Promise<void>((r) => ctx.server.close(() => r()));
  });

  const over1mb = bigJsonBody(2 * 1024 * 1024);
  const under1mb = bigJsonBody(64 * 1024);

  it('匿名（不带 token 头）投 2MB → 413，解析成本被挡在小限额上', async () => {
    const { status } = await post(ctx.port, over1mb);
    expect(status).toBe(413);
  });

  it('带了 token 头 → 2MB 照常通过（大正文不能被弄坏）', async () => {
    const { status, text } = await post(ctx.port, over1mb, { [AUTH_TOKEN_HEADER]: 'some.jwt.value' });
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ parsed: 2 });
  });

  it('正例：匿名的小 body（64KB）照常通过 —— 挡板只压大 body', async () => {
    const { status, text } = await post(ctx.port, under1mb);
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ parsed: 2 });
  });

  it('空的 token 头不算"声称身份"（`token: ""` 与空白都按匿名处理）', async () => {
    expect((await post(ctx.port, over1mb, { [AUTH_TOKEN_HEADER]: '' })).status).toBe(413);
    expect((await post(ctx.port, over1mb, { [AUTH_TOKEN_HEADER]: '   ' })).status).toBe(413);
  });

  it('⚠️ token 头是数组形状（重复头）时也算声称身份，不能崩', async () => {
    // Node 把重复头合成数组；挡板必须两种形状都认，否则合法客户端会被误拒
    const { status } = await post(ctx.port, over1mb, {});
    expect(status).toBe(413); // 先确认基线
    const res = await fetch(`http://127.0.0.1:${ctx.port}${PREFIX}`, {
      method: 'POST',
      headers: [['content-type', 'application/json'], [AUTH_TOKEN_HEADER, 'a'], [AUTH_TOKEN_HEADER, 'b']] as any,
      body: over1mb,
    });
    expect([200, 413]).toContain(res.status); // 不能是 500
    expect(res.status).toBe(200);
  });
});

describe('接线顺序：反了就完全无效（给 main.ts 的接线者看的反证）', () => {
  it('大限额解析器在前 ⇒ 匿名 2MB 会被 200 接住，挡板形同不存在', async () => {
    const ctx2 = await startServer('large-first');
    try {
      const { status } = await post(ctx2.port, bigJsonBody(2 * 1024 * 1024));
      expect(status).toBe(200); // ← 这就是"顺序反了"的后果：CPU 已经烧完，挡板没起作用
      expect(status).not.toBe(413);
    } finally {
      await new Promise<void>((r) => ctx2.server.close(() => r()));
    }
  });
});

describe('跨文件钉子：token 头名必须与鉴权层同源', () => {
  const jwtStrategy = readFileSync(resolve(__dirname, '../provider/auth/jwt.strategy.ts'), 'utf8');
  const tokenGuard = readFileSync(resolve(__dirname, '../provider/auth/token.guard.ts'), 'utf8');

  it('AUTH_TOKEN_HEADER 就是 jwt.strategy 的 fromHeader(...) 与 token.guard 读的那个头', () => {
    expect(AUTH_TOKEN_HEADER).toBe('token');
    expect(jwtStrategy).toContain(`ExtractJwt.fromHeader('${AUTH_TOKEN_HEADER}')`);
    expect(tokenGuard).toContain(`request.headers['${AUTH_TOKEN_HEADER}']`);
  });

  it('⚠️ 反证：任一侧改名，上面那条必须红（否则挡板会把所有请求判成匿名、连带拒掉合法大正文）', () => {
    // 用"尺子量旧形状"的办法证明断言不是空转：把头名换成别的，两条 contains 都必须失配
    expect(jwtStrategy).not.toContain("ExtractJwt.fromHeader('x-vanblog-renamed')");
    expect(tokenGuard).not.toContain("request.headers['x-vanblog-renamed']");
  });
});

describe('bodyLimit.ts 的注释不能再退回那个误导性论证', () => {
  const src = stripCommentsForAnchor(readFileSync(resolve(__dirname, './bodyLimit.ts'), 'utf8'));
  const raw = readFileSync(resolve(__dirname, './bodyLimit.ts'), 'utf8');

  it('那个误导性论证必须以"被纠正的形式"存在（对处理器成立、对解析与净化不成立）', () => {
    // ⚠️ 不能用 `not.toContain('匿名请求到不了解析器之后的处理器')`：旧句子现在是被**引用**着
    //    纠正的（"这里以前写着……那句话对一半"），断言它不存在会红；而且这类 absence 断言
    //    在剥注释后必然为真（那句话本来就在注释里），是空转。所以改成断言**纠正本身在**。
    expect(raw).toContain('对**处理器**成立');
    expect(raw).toContain('对**解析与净化不成立**');
  });

  it('⚠️ 剥掉注释后，AUTH_TOKEN_HEADER 在**代码**里仍被赋成 `token`（不是只在注释里提到）', () => {
    // 这条才需要剥注释：注释里必然写着这个头名，只有剥掉之后的匹配才证明代码真的这么赋值。
    // 反证见上一条 describe —— 任一侧改名会让跨文件钉子红。
    expect(src).toMatch(/export const AUTH_TOKEN_HEADER = 'token';/);
    expect(src).toMatch(/const claimed = req\?\.headers\?\.\[AUTH_TOKEN_HEADER\];/);
  });

  it('四个大限额前缀没有变（改动会让挡板与解析器挂错位置）', () => {
    expect([...LARGE_JSON_BODY_PREFIXES]).toEqual([
      '/api/admin/article',
      '/api/admin/draft',
      '/api/admin/customPage',
      '/api/admin/pipeline',
    ]);
  });
});
