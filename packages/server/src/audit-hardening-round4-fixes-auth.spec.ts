import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { UnauthorizedException } from '@nestjs/common';

/**
 * 第四轮安全审计修复钉子（登出那一组）：B7/R4-9 ——
 * `POST /api/admin/auth/logout` 挂上 TokenGuard，且 `dispatchEvent('logout')`
 * 挪到吊销**成功之后**。
 *
 * 修复前：这条路由在 /api/admin 前缀下却没有任何守卫 ⇒ 匿名请求就能触发
 * 管理员编写的 logout 流水线脚本（dispatchEvent），而且不受「公开写 30/分钟」桶管。
 * TokenGuard 只验证 token 在库里且未被吊销（checkToken = findOne({token, disabled:false})），
 * 不要求完整 AdminGuard 的 jwt+access 两道 —— 正好是这条路由需要的最小守卫。
 */

jest.mock('src/config/index', () => ({ config: { demo: 'false' } }), { virtual: true });

import { AuthController } from './controller/admin/auth/auth.controller';
import { TokenGuard } from './provider/auth/token.guard';
import { LoginGuard } from './provider/auth/login.guard';

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

function makeController(over: {
  disableToken?: (t: string) => Promise<any>;
  dispatchEvent?: (ev: string, data?: any) => Promise<any>;
} = {}) {
  const calls: string[] = [];
  const tokenProvider: any = {
    disableToken: async (t: string) => {
      calls.push(`disable:${t}`);
      return over.disableToken ? over.disableToken(t) : { acknowledged: true, modifiedCount: 1 };
    },
  };
  const pipelineProvider: any = {
    dispatchEvent: async (ev: string, data?: any) => {
      calls.push(`event:${ev}:${JSON.stringify(data)}`);
      return over.dispatchEvent ? over.dispatchEvent(ev, data) : [];
    },
  };
  const controller = new AuthController(
    {} as any,
    {} as any,
    {} as any,
    tokenProvider,
    {} as any,
    {} as any,
    pipelineProvider,
    {} as any,
  );
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  (controller as any).logger = logger;
  return { controller, calls, logger };
}

describe('FIX B7/R4-9：logout 挂 TokenGuard、事件在吊销之后', () => {
  it('路由元数据钉子：logout 的守卫就是 TokenGuard（不是完整 AdminGuard）', () => {
    const guards = Reflect.getMetadata('__guards__', AuthController.prototype.logout);
    expect(Array.isArray(guards)).toBe(true);
    expect(guards).toContain(TokenGuard);
    expect(guards).toHaveLength(1); // 只要 token 有效性这一道
  });

  it('源码顺序钉子：@UseGuards(TokenGuard) 在 @Post(\'/logout\') 上；先 disableToken 后 dispatchEvent', () => {
    const src = read('./controller/admin/auth/auth.controller.ts');
    const iGuards = src.indexOf('@UseGuards(TokenGuard)');
    const iLogout = src.indexOf("@Post('/logout')");
    expect(iGuards).toBeGreaterThan(-1);
    expect(iLogout).toBeGreaterThan(iGuards);
    expect(iLogout - iGuards).toBeLessThan(80); // 守卫就挂在这条路由上，不是别的
    const iDisable = src.indexOf('await this.tokenProvider.disableToken(token);');
    const iDispatch = src.indexOf("this.pipelineProvider\n      .dispatchEvent('logout', {");
    expect(iDisable).toBeGreaterThan(-1);
    expect(iDispatch).toBeGreaterThan(iDisable); // ← 修复点：以前 dispatch 在 disable 之前
  });

  it('其它三条路由的守卫形状没被改动（login=LoginGuard+local、PUT=AdminGuard、restore 仍按设计匿名）', () => {
    const src = read('./controller/admin/auth/auth.controller.ts');
    expect(src).toMatch(/@UseGuards\(LoginGuard, AuthGuard\('local'\)\)\s*\n\s*@Post\('\/login'\)/);
    expect(src).toMatch(/@UseGuards\(\.\.\.AdminGuard\)\s*\n\s*@ApiToken\s*\n\s*@Put\(\)/);
    // restore（忘记密码）由 256 位随机恢复密钥把守，匿名是设计决定
    const iRestore = src.indexOf("@Post('/restore')");
    const restoreBlock = src.slice(iRestore - 200, iRestore);
    expect(restoreBlock).not.toMatch(/@UseGuards/);
    expect(src).toMatch(/const keyInCache = await this\.cacheProvider\.get\('restoreKey'\);/);
  });

  it('行为钉子：合法 token 登出 ⇒ 先吊销、后事件、返回 200 信封（顺序逐条钉住）', async () => {
    const { controller, calls } = makeController();
    const res = await controller.logout({ headers: { token: 'tok-valid' } } as any);
    expect(res).toEqual({ statusCode: 200, data: '登出成功！' });
    await new Promise((r) => setImmediate(r)); // dispatchEvent 是 fire-and-forget
    expect(calls).toEqual(['disable:tok-valid', 'event:logout:{"token":"tok-valid"}']);
  });

  it('行为钉子：没有 token 头 ⇒ 401，什么都不触发', async () => {
    const { controller, calls } = makeController();
    await expect(controller.logout({ headers: {} } as any)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(calls).toEqual([]);
  });

  it('dispatchEvent 失败被 catch 住（带来源的 ERROR，不是无来源的 unhandledRejection），响应照常 200', async () => {
    const { controller, calls, logger } = makeController({
      dispatchEvent: () => Promise.reject(new Error('mongo down')),
    });
    const res = await controller.logout({ headers: { token: 'tok-x' } } as any);
    expect(res).toEqual({ statusCode: 200, data: '登出成功！' });
    await new Promise((r) => setImmediate(r));
    expect(calls[0]).toBe('disable:tok-x'); // 吊销已经发生
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('mongo down'));
  });

  it('TokenGuard 的语义：只查「token 在库里且未吊销」（checkToken），无效即 401', async () => {
    // token.provider.checkToken 的实现钉子（TokenGuard 依赖的就是它）
    expect(read('./provider/token/token.provider.ts')).toMatch(
      /const result = await this\.tokenModel\.findOne\(\{ token, disabled: false \}\);/,
    );
    const guard = new TokenGuard({
      checkToken: async (t: string) => t === 'good',
    } as any);
    await expect(guard.validateRequest({ headers: { token: 'good' } } as any)).resolves.toBe(true);
    await expect(guard.validateRequest({ headers: { token: 'bad' } } as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.validateRequest({ headers: {} } as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('blast radius（只读了 packages/admin，没有改它）：SPA 的登出对 401 是容忍的', () => {
    // LogoutButton 的 loginOut()：try { await logout({skipErrorHandler:true}) } catch { ok=false }
    // → 无条件 removeItem('token') + 跳登录页，失败时提示「已退出登录（服务端会话已失效）」。
    // 它的注释里甚至写着「token 早就失效时服务端返回 401」——401 是被预期的形状。
    // __dirname = packages/server/src ⇒ 上 **2** 级到 packages/（§7.56 记过 off-by-one 的坑，这里写明数法）
    const src = readFileSync(
      join(__dirname, '..', '..', 'admin', 'src', 'components', 'LogoutButton', 'index.jsx'),
      'utf8',
    );
    expect(src).toContain('await logout({ skipErrorHandler: true })');
    expect(src).toMatch(/catch \(err\) \{\s*\n\s*ok = false;/);
    expect(src).toContain("window.localStorage.removeItem('token')");
    expect(src).toContain('已退出登录（服务端会话已失效）');
    // LoginGuard 仍然守着 login（本轮没有动它 —— 它在 do-not-touch 清单里）
    expect(LoginGuard).toBeDefined();
  });
});
