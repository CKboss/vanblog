import { readFileSync } from 'fs';
import { resolve } from 'path';
import { UnauthorizedException } from '@nestjs/common';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { TokenGuard } from './token.guard';

/**
 * `TokenGuard` **只**从 `token` 这一个 header 取凭据 —— 不许新增第二个来源。
 *
 * ## 为什么这条值得一个独立守卫（它保护的性质不在本文件里）
 * `provider/token/token.provider.ts` 的 `checkToken` 是 `findOne({ token, disabled: false })`，
 * 而 Mongoose 会**丢掉值为 `undefined` 的查询条件** ⇒ 退化成 `{ disabled: false }` =
 * "库里存在任意一个未吊销 token 就算通过"。`checkToken` 已经在源头挡掉了非字符串/空串，
 * 本仓库也已经因为这一族出过一次**未认证管理员接管**。
 * 但那层防的是"**没有**凭据"；如果 guard 这里多一个取值来源，就会出现
 * "某个来源有值、`token` 头没有"的组合 —— 传进 `checkToken` 的是哪个值取决于谁先写，
 * 而只要有一条路径能把 `undefined` 送进去，那个已修的绕过就**原地复活**。
 * 所以性质是：**取值来源必须恰好一个**。
 *
 * ⚠️ 这条守卫同时是行为级与源码级：只钉源码文本的话，一个"从 cookie 取值但变量名不叫 cookie"
 * 的实现能溜过去；只钉行为的话，将来新增的来源如果恰好在我的用例之外（例如 `x-token`）也溜得过去。
 */

function makeGuard(checkToken: jest.Mock) {
  const guard = new TokenGuard({ checkToken } as any);
  return guard;
}

/** 造一个最小的 ExecutionContext（canActivate 的真实入口）。 */
function ctxOf(request: any) {
  return { switchToHttp: () => ({ getRequest: () => request }) } as any;
}

describe('TokenGuard：凭据来源恰好一个（`token` header）', () => {
  it('只有 token 头 ⇒ checkToken 收到它的值，通过则放行', async () => {
    const checkToken = jest.fn(async (_token?: unknown) => true);
    const guard = makeGuard(checkToken);
    const req = { headers: { token: 'abc123' }, query: {} };
    await expect(guard.canActivate(ctxOf(req))).resolves.toBe(true);
    expect(checkToken).toHaveBeenCalledTimes(1);
    expect(checkToken).toHaveBeenCalledWith('abc123');
  });

  it('🔴 没有 token 头、但 Authorization / Cookie / query 里都有"看起来像凭据"的值 ⇒ 一个都不许被当成凭据', async () => {
    const checkToken = jest.fn(async (_token?: unknown) => true);
    const guard = makeGuard(checkToken);
    const req = {
      headers: {
        authorization: 'Bearer attacker-supplied-value',
        cookie: 'token=cookie-supplied-value; session=xyz',
        'x-token': 'header-supplied-value',
        'x-api-key': 'key-supplied-value',
      },
      query: { token: 'query-supplied-value' },
    };
    // checkToken 被桩成"总是通过"，所以如果 guard 从任何其它来源取到了值，这个请求就会被放行；
    // 断言的重点是**送进 checkToken 的必须是 undefined**（= 没有任何来源被当凭据），
    // 以及因此必须抛 401（真实的 checkToken 对 undefined 返回 false）。
    const realCheck = jest.fn(async (t: unknown) => typeof t === 'string' && t.trim().length > 0);
    const strictGuard = makeGuard(realCheck);
    await expect(strictGuard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(realCheck).toHaveBeenCalledTimes(1);
    expect(realCheck.mock.calls[0][0]).toBeUndefined();
    // 宽松桩下同样只被调用一次、且参数是 undefined（证明没有"先试 token 再试别的"这种回退链）
    await expect(guard.canActivate(ctxOf(req))).resolves.toBe(true);
    expect(checkToken).toHaveBeenCalledTimes(1);
    expect(checkToken.mock.calls[0][0]).toBeUndefined();
  });

  it('token 头与其它来源同时存在 ⇒ 只用 token 头的值，且只调一次（没有回退链）', async () => {
    const checkToken = jest.fn(async (_token?: unknown) => true);
    const guard = makeGuard(checkToken);
    const req = {
      headers: { token: 'real-token', authorization: 'Bearer other', cookie: 'token=other' },
      query: { token: 'other' },
    };
    await guard.canActivate(ctxOf(req));
    expect(checkToken).toHaveBeenCalledTimes(1);
    expect(checkToken).toHaveBeenCalledWith('real-token');
  });

  it('checkToken 返回 false ⇒ 401（既有语义不变）', async () => {
    const guard = makeGuard(jest.fn(async (_token?: unknown) => false));
    await expect(guard.canActivate(ctxOf({ headers: { token: 'revoked' } }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('headers 存在但为空 ⇒ token 是 undefined ⇒ 401（不是 TypeError/500）', async () => {
    const checkToken = jest.fn(async (t: unknown) => typeof t === 'string' && !!t);
    const guard = makeGuard(checkToken);
    await expect(guard.canActivate(ctxOf({ headers: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(checkToken).toHaveBeenCalledTimes(1);
    expect(checkToken.mock.calls[0][0]).toBeUndefined();
  });

  // ⚠️ 故意**不**测「整个 headers 对象缺失」：Express/Nest 保证 `request.headers` 一定存在，
  //    所以那不是可达形状；为它加 `request?.headers?.['token']` 只会把「调用方传了个假请求对象」
  //    这种编程错误静默变成一次 401。本文件第一版就写了这么一条用例，结果它测的是**我发明的契约**
  //    而不是产品的契约（实现抛 TypeError，用例红）。教训：写防御性断言之前先问「这个形状可达吗」，
  //    不可达就既不要加防御代码、也不要为它写测试。

  it('validateRequest 与 canActivate 是同一条路径（canActivate 只是拆了 context）', async () => {
    const checkToken = jest.fn(async (_token?: unknown) => true);
    const guard = makeGuard(checkToken);
    const req = { headers: { token: 'v' } };
    await expect(guard.validateRequest(req as any)).resolves.toBe(true);
    await expect(guard.canActivate(ctxOf(req))).resolves.toBe(true);
    expect(checkToken).toHaveBeenCalledTimes(2);
    expect(checkToken.mock.calls.map((c) => c[0])).toEqual(['v', 'v']);
  });
});

describe('TokenGuard：源码级漂移守卫（剥注释后断言）', () => {
  const RAW = readFileSync(resolve(__dirname, 'token.guard.ts'), 'utf-8');
  const SRC = stripCommentsForAnchor(RAW);

  // ⚠️ 这些词**必然**出现在解释性注释里（注释正是在说"不许从这些地方取值"），
  //    所以断言必须打在剥注释后的源码上 —— 本仓库已踩 9 次"断言匹配到自己的注释"。
  const FORBIDDEN_SOURCES = ['authorization', 'cookie', 'query', 'x-token', 'x-api-key', 'params'];

  it.each(FORBIDDEN_SOURCES)('剥注释后不许出现第二个取值来源：%s', (word) => {
    expect(SRC.toLowerCase()).not.toContain(word);
  });

  it('⚠️ 空转反证：未剥注释的原文**必须**命中这些词，否则说明上面那组断言恒真', () => {
    const raw = RAW.toLowerCase();
    // 注释里提到了 authorization / cookie / query（解释为什么不许用）⇒ 原文一定命中。
    expect(raw).toContain('authorization');
    expect(raw).toContain('cookie');
    expect(raw).toContain('query');
    // 并且证明剥注释器真的把它们剥掉了（不是"本来就没有"）。
    expect(SRC.toLowerCase()).not.toContain('authorization');
    // 再用一段合成源码证明这把尺子的方向是对的：
    const bad = stripCommentsForAnchor(
      "// 注释里写 cookie 不该影响判定\nconst t = request.headers['token'] || request.headers['cookie'];\n",
    );
    expect(bad.toLowerCase()).toContain('cookie');
    const good = stripCommentsForAnchor(
      "// 注释里写 cookie 不该影响判定\nconst t = request.headers['token'];\n",
    );
    expect(good.toLowerCase()).not.toContain('cookie');
  });

  it('取值形状就是 `request.headers[\'token\']`（钉调用形状，不是钉符号出现）', () => {
    expect(SRC).toMatch(/const token = request\.headers\['token'\];/);
    // checkToken 拿到的必须就是这个变量，而不是别的表达式（防止"读了 token 头但传了别的东西"）
    expect(SRC).toMatch(/this\.tokenProvider\.checkToken\(token\)/);
  });

  it('⚠️ 负向对照：上面两把尺子量得到坏形状（否则它们是装饰）', () => {
    const fellBackToCookie = "const token = request.headers['token'] || request.headers['cookie'];";
    expect(fellBackToCookie).not.toMatch(/const token = request\.headers\['token'\];/);
    expect(fellBackToCookie.toLowerCase()).toContain('cookie');

    const readFromQuery = "const token = (request as any).query?.token;";
    expect(readFromQuery).not.toMatch(/const token = request\.headers\['token'\];/);
    expect(readFromQuery.toLowerCase()).toContain('query');

    const passedSomethingElse = "const ok = await this.tokenProvider.checkToken(request.headers['authorization']);";
    expect(passedSomethingElse).not.toMatch(/this\.tokenProvider\.checkToken\(token\)/);
  });
});
