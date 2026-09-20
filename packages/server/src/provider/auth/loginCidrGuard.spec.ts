import { ForbiddenException } from '@nestjs/common';
import {
  LOGIN_CIDR_DENIED_MESSAGE,
  LoginGuard,
  __resetLoginThrottleForTest,
} from './login.guard';
import { ADMIN_LOGIN_ALLOW_CIDR_ENV, resetCidrPolicyCacheForTest } from '../../utils/ip';
import { __resetAttemptLimitForTest } from '../../utils/attemptLimit';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 「只允许某些网段登录后台」在**守卫这一层**的行为。
 *
 * 纯解析/判定逻辑在 `utils/cidrAllowList.spec.ts`；这里钉的是集成性质：
 *
 *  1. **没配就完全不影响现有行为**（升级不能把站长锁在门外）；
 *  2. 被拒时返回 **403**，而且**在 `inspect()` 之前**就返回 —— 也就是不读设置、
 *     不进入 `AuthGuard('local')`、不消耗一次 scrypt（约 63ms）。这一条是"白名单不能
 *     变成放大器"的关键：如果判定发生在口令校验之后，攻击者用不在白名单里的 IP
 *     猛打登录仍然能白拿哈希算力；
 *  3. 配错 ⇒ **全部拒绝**（失败关闭）+ 一条点名非法项的 ERROR；
 *  4. 文案不泄露机制（403 + 中性文案），排障信息只进服务端日志。
 */
describe('LoginGuard：网段白名单', () => {
  let savedEnv: NodeJS.ProcessEnv;
  let settingCalls: number;

  // 一体式部署的真实形状：caddy 从回环拨过来，真实客户端在 X-Forwarded-For 的最右一跳
  const reqOf = (ip: string) =>
    ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip } } as any);
  const ctxOf = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) } as any);
  const makeGuard = () => {
    const guard = new LoginGuard({
      getLoginSetting: async () => {
        settingCalls += 1;
        return null;
      },
    } as any);
    return guard;
  };

  beforeEach(() => {
    __resetLoginThrottleForTest();
    __resetAttemptLimitForTest();
    resetCidrPolicyCacheForTest();
    savedEnv = { ...process.env };
    settingCalls = 0;
    delete process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV];
    delete process.env.VANBLOG_CLUSTER_WORKERS;
    delete process.env.VANBLOG_LOGIN_GLOBAL_FAIL_PER_MIN;
  });

  afterEach(() => {
    process.env = savedEnv;
    __resetLoginThrottleForTest();
    __resetAttemptLimitForTest();
    resetCidrPolicyCacheForTest();
  });

  it('未配置 ⇒ 放行，且行为与本轮之前一致（照常读设置、照常走限流判定）', async () => {
    const guard = makeGuard();
    await expect(guard.canActivate(ctxOf(reqOf('8.8.8.8')))).resolves.toBe(true);
    expect(settingCalls).toBe(1); // inspect() 确实跑了
  });

  it('配置为空串 / 全空白 ⇒ 同样放行（"没配"不等于"配错"）', async () => {
    for (const raw of ['', '   ']) {
      process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV] = raw;
      const guard = makeGuard();
      await expect(guard.canActivate(ctxOf(reqOf('8.8.8.8')))).resolves.toBe(true);
    }
  });

  it('配了网段 + IP 在内 ⇒ 放行', async () => {
    process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV] = '203.0.113.0/24';
    const guard = makeGuard();
    await expect(guard.canActivate(ctxOf(reqOf('203.0.113.9')))).resolves.toBe(true);
    expect(settingCalls).toBe(1);
  });

  it('配了网段 + IP 在外 ⇒ 403，且**没有读设置**（判定在 inspect 之前）', async () => {
    process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV] = '203.0.113.0/24';
    const guard = makeGuard();
    const warn = jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);
    let caught: any = null;
    try {
      await guard.canActivate(ctxOf(reqOf('203.0.114.9')));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(caught.getStatus()).toBe(403);
    expect(caught.getResponse().message).toBe(LOGIN_CIDR_DENIED_MESSAGE);
    // ⚠️ 这条是"不消耗下游成本"的证据：inspect() 会读一次登录设置，没读到就说明判定在它之前
    expect(settingCalls).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('文案不泄露机制：不含 IP、不含"白名单/网段/CIDR"字样', () => {
    expect(LOGIN_CIDR_DENIED_MESSAGE).not.toMatch(/203\.|白名单|网段|CIDR|allowlist/i);
    // 但要给站长指路（否则他只会看到一个莫名的 403）
    expect(LOGIN_CIDR_DENIED_MESSAGE).toMatch(/日志/);
  });

  it('IPv6 网段与 IPv4-mapped 形式都能正确判定', async () => {
    process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV] = '2001:db8::/32,203.0.113.0/24';
    const guard = makeGuard();
    jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);
    await expect(guard.canActivate(ctxOf(reqOf('2001:db8::1')))).resolves.toBe(true);
    await expect(guard.canActivate(ctxOf(reqOf('::ffff:203.0.113.9')))).resolves.toBe(true);
    await expect(guard.canActivate(ctxOf(reqOf('2001:db9::1')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('拿不到客户端 IP（unknown）⇒ 403（证明不了来源就不放行）', async () => {
    process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV] = '203.0.113.0/24';
    const guard = makeGuard();
    jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);
    // 没有套接字地址也没有转发头 ⇒ bruteForceClientIp 返回 'unknown'
    const req = { socket: {}, headers: {} } as any;
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(ForbiddenException);
    expect(settingCalls).toBe(0);
  });

  it('非法配置 ⇒ 对**网段内**的 IP 也 403（失败关闭），并打一条点名非法项的 ERROR', async () => {
    process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV] = '203.0.113.0/24,not-an-ip';
    const guard = makeGuard();
    const error = jest.spyOn(guard.logger, 'error').mockImplementation(() => undefined);
    await expect(guard.canActivate(ctxOf(reqOf('203.0.113.9')))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(error).toHaveBeenCalledTimes(1);
    const text = String(error.mock.calls[0][0]);
    expect(text).toContain('not-an-ip'); // 点名哪一项非法
    expect(text).toContain(ADMIN_LOGIN_ALLOW_CIDR_ENV); // 点名该改哪个变量
    expect(text).toMatch(/合法形状/); // 给出可照做的形状
  });

  it('日志节流：连续被拒不刷屏，但累计条数会带在下一条里', async () => {
    process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV] = '203.0.113.0/24';
    const guard = makeGuard();
    const warn = jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);
    const realNow = Date.now;
    try {
      let clock = 1_000_000;
      Date.now = () => clock;
      for (let i = 0; i < 12; i += 1) {
        await expect(guard.canActivate(ctxOf(reqOf('203.0.114.9')))).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      }
      expect(warn).toHaveBeenCalledTimes(1); // 同一时刻只打一条
      clock += 11_000; // 过了 10 秒的节流窗口
      await expect(guard.canActivate(ctxOf(reqOf('203.0.114.9')))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1][0])).toMatch(/另有 11 次被拒/); // 量级没丢
    } finally {
      Date.now = realNow;
    }
  });

  it('判定到的地址是回环/私网而白名单里没有私网段 ⇒ WARN 带排障提示（最常见的自我锁死原因）', async () => {
    process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV] = '203.0.113.0/24';
    const guard = makeGuard();
    const warn = jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);
    // 直接暴露、没有转发头 ⇒ 判定到的就是套接字地址本身（这里是回环）
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} } as any;
    await expect(guard.canActivate(ctxOf(req))).rejects.toBeInstanceOf(ForbiddenException);
    const text = String(warn.mock.calls[0][0]);
    expect(text).toContain('VANBLOG_TRUST_FORWARDED_HEADERS');
    expect(text).toContain('127.0.0.1');
    expect(text).toContain('203.0.113.0/24');
  });

  it('白名单里含私网段时不给那条提示（此时回环来源是正常的）', async () => {
    process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV] = '127.0.0.1/32,203.0.113.0/24';
    const guard = makeGuard();
    const warn = jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} } as any;
    await expect(guard.canActivate(ctxOf(req))).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('被网段拒掉的请求**不计入**登录失败窗口（它根本没尝试口令）', async () => {
    process.env[ADMIN_LOGIN_ALLOW_CIDR_ENV] = '203.0.113.0/24';
    const guard = makeGuard();
    jest.spyOn(guard.logger, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 8; i += 1) {
      await expect(guard.canActivate(ctxOf(reqOf('203.0.114.9')))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    // 换一个白名单内的 IP：如果上面 8 次被记进了全局窗口，这里会出现节流延迟/计数
    const state = await guard.inspect(reqOf('203.0.113.9'));
    expect(state.count).toBe(0);
    expect(state.allowed).toBe(true);
  });

  it('与防爆破计数用的是**同一个** IP 口径（不允许出现第三种"客户端 IP"定义）', () => {
    const src = stripCommentsForAnchor(
      readFileSync(join(__dirname, 'login.guard.ts'), 'utf-8'),
    );
    const networkMethod = src.slice(
      src.indexOf('private assertLoginNetworkAllowed'),
      src.indexOf('private logCidrDenied'),
    );
    expect(networkMethod.length).toBeGreaterThan(0);
    expect(networkMethod).toMatch(/bruteForceClientIp\(req\)/);
    // ⚠️ 不许直接读套接字或转发头：那会造出与限流不一致的第二种口径，
    //    而且在一体式部署下（caddy 从回环拨过来）套接字地址对所有访客都相同 ⇒ 功能形同虚设
    expect(networkMethod).not.toMatch(/pickSocketIp|x-forwarded-for|x-real-ip|cf-connecting-ip/i);
  });

  it('源码锚点：网段判定确实排在 canActivate 的最前面（在 inspect 之前）', () => {
    const src = stripCommentsForAnchor(
      readFileSync(join(__dirname, 'login.guard.ts'), 'utf-8'),
    );
    const canActivateAt = src.indexOf('async canActivate(');
    const networkAt = src.indexOf('this.assertLoginNetworkAllowed(request)');
    const inspectAt = src.indexOf('await this.inspect(request)');
    expect(canActivateAt).toBeGreaterThan(-1);
    expect(networkAt).toBeGreaterThan(canActivateAt);
    expect(inspectAt).toBeGreaterThan(networkAt); // ← 顺序就是这条断言的本体
  });

  it('负向对照：上面那条顺序断言在"判定被挪到 inspect 之后"时必须失败', () => {
    // ⚠️ 空断言检查：如果 indexOf 返回 -1 也能让 `>` 成立，那条断言就是装饰。
    //    这里用**同一个判据**跑在一个真的被挪后的形状上，证明尺子能量到东西。
    const movedAfter = `async canActivate(context) {
      const request = context.switchToHttp().getRequest();
      const state = await this.inspect(request);
      this.assertLoginNetworkAllowed(request);
      return true;
    }`;
    const c = movedAfter.indexOf('async canActivate(');
    const n = movedAfter.indexOf('this.assertLoginNetworkAllowed(request)');
    const i = movedAfter.indexOf('await this.inspect(request)');
    // 三个位置都真的找到了（不是 -1 蒙过去的）
    expect(c).toBeGreaterThan(-1);
    expect(n).toBeGreaterThan(-1);
    expect(i).toBeGreaterThan(-1);
    // 主断言的判据是 `inspectAt > networkAt`；坏形状下它必须**不成立**
    expect(i > n).toBe(false);
    expect(n > c).toBe(true); // 坏形状里 network 仍然在 canActivate 之内，说明只有顺序变了
  });
});

describe('登录路由的守卫顺序：网段判定必须真的能挡住口令校验', () => {
  it('auth.controller 上 LoginGuard 排在 AuthGuard("local") 之前', () => {
    // LoginGuard 抛异常 ⇒ passport 的 local strategy 根本不会跑 ⇒ 不消耗 scrypt。
    // 这个顺序一旦被人调换（或删掉 LoginGuard），网段白名单就退化成"拒绝之前先算一次哈希"。
    const src = stripCommentsForAnchor(
      readFileSync(join(__dirname, '../../controller/admin/auth/auth.controller.ts'), 'utf-8'),
    );
    expect(src).toMatch(/@UseGuards\(LoginGuard,\s*AuthGuard\('local'\)\)\s*@Post\('\/login'\)/);
  });

  it('负向对照：顺序反过来时上面那条必须匹配不上', () => {
    const wrong = stripCommentsForAnchor(
      "@UseGuards(AuthGuard('local'), LoginGuard)\n  @Post('/login')\n",
    );
    expect(wrong).not.toMatch(/@UseGuards\(LoginGuard,\s*AuthGuard\('local'\)\)\s*@Post\('\/login'\)/);
  });
});
