import {
  LoginGuard,
  computeLoginThrottleDelayMs,
  resolveGlobalFailThreshold,
  noteGlobalLoginFailure,
  currentGlobalLoginFailures,
  __resetLoginThrottleForTest,
  LOGIN_GLOBAL_WINDOW_MS,
  LOGIN_THROTTLE_STEP_MS,
  DEFAULT_LOGIN_GLOBAL_FAIL_PER_MIN,
  DEFAULT_LOGIN_THROTTLE_MAX_MS,
  LOGIN_GLOBAL_FAIL_ENV,
  LOGIN_THROTTLE_MAX_ENV,
} from './login.guard';
import { __resetAttemptLimitForTest } from '../../utils/attemptLimit';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 全局登录失败节流：**加延迟，不加锁**。
 *
 * ## 钉的是什么问题
 *
 * per-IP 的"5 次 / 300 秒"在僵尸网络面前等于没有：对某一个用户名的实际爆破预算是
 * `5 × IP 数 / 300 秒`。一万个肉鸡就是每分钟一万次尝试。
 *
 * ## 为什么响应是"变慢"而不是"拒绝"
 *
 * "全局失败太多就锁住这个用户名"听起来更硬，但它给了攻击者一件比撞库更好用的武器：
 * **用错误密码把真管理员锁在门外，而且可以无限续期**。对一个"要在敌意环境下持续发布信息"
 * 的站点来说，站长进不去后台比密码被慢慢试更致命。所以这里只抬高成本：
 * 所有登录请求都慢一点（封顶 3 秒），拿着正确密码的人**永远还是能登进来**。
 *
 * ⚠️ 这三条性质是这个设计的全部意义，任何一条被改坏都算回归：
 *  1. 正常水位下**零延迟**（不能为了防攻击让日常登录变慢）；
 *  2. 延迟**有封顶**（不能叠加到不可用）；
 *  3. 节流期间登录**仍然成功**（是变慢，不是拒绝）。
 */
describe('全局登录失败节流', () => {
  let savedEnv: NodeJS.ProcessEnv;

  const reqOf = (ip: string) =>
    ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip } } as any);
  const ctxOf = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) } as any);
  const makeGuard = (loginSetting: any = null) =>
    new LoginGuard({ getLoginSetting: async () => loginSetting } as any);

  beforeEach(() => {
    __resetLoginThrottleForTest();
    __resetAttemptLimitForTest();
    savedEnv = { ...process.env };
    delete process.env.VANBLOG_CLUSTER_WORKERS;
    delete process.env[LOGIN_GLOBAL_FAIL_ENV];
    delete process.env[LOGIN_THROTTLE_MAX_ENV];
  });

  afterEach(() => {
    process.env = savedEnv;
    __resetLoginThrottleForTest();
    __resetAttemptLimitForTest();
  });

  describe('纯函数：延迟曲线', () => {
    it('阈值以下一律 0 延迟（正常用户与小型站点完全不受影响）', () => {
      expect(computeLoginThrottleDelayMs(0, 120, 3000)).toBe(0);
      expect(computeLoginThrottleDelayMs(1, 120, 3000)).toBe(0);
      expect(computeLoginThrottleDelayMs(119, 120, 3000)).toBe(0);
      expect(computeLoginThrottleDelayMs(120, 120, 3000)).toBe(0); // ratio 恰好 1 ⇒ 还不该罚
    });

    it('超过阈值后线性爬坡，每多一倍加一个 step', () => {
      expect(computeLoginThrottleDelayMs(240, 120, 3000)).toBe(LOGIN_THROTTLE_STEP_MS);
      expect(computeLoginThrottleDelayMs(360, 120, 3000)).toBe(LOGIN_THROTTLE_STEP_MS * 2);
    });

    it('单调不降，且封顶', () => {
      let prev = -1;
      for (let failures = 0; failures <= 5000; failures += 25) {
        const d = computeLoginThrottleDelayMs(failures, 120, 3000);
        expect(d).toBeGreaterThanOrEqual(prev);
        expect(d).toBeLessThanOrEqual(3000);
        prev = d;
      }
      expect(computeLoginThrottleDelayMs(1_000_000, 120, 3000)).toBe(3000);
    });

    it('threshold<=0 表示关闭，必须返回 0', () => {
      expect(computeLoginThrottleDelayMs(99999, 0, 3000)).toBe(0);
      expect(computeLoginThrottleDelayMs(99999, -1, 3000)).toBe(0);
    });

    it('垃圾输入不会变成"无限延迟"', () => {
      expect(computeLoginThrottleDelayMs(NaN, 120, 3000)).toBe(0);
      expect(computeLoginThrottleDelayMs(-5, 120, 3000)).toBe(0);
      // capMs 写坏时回落默认封顶，而不是变成 NaN（NaN 会让 setTimeout 当 1ms 处理）
      const d = computeLoginThrottleDelayMs(100000, 120, NaN);
      expect(d).toBe(DEFAULT_LOGIN_THROTTLE_MAX_MS);
      expect(computeLoginThrottleDelayMs(100000, 120, 0)).toBe(DEFAULT_LOGIN_THROTTLE_MAX_MS);
    });
  });

  describe('阈值解析：⚠️ 写错的值绝不能静默关掉防护', () => {
    it('没设 / 空串 → 默认值', () => {
      expect(resolveGlobalFailThreshold({})).toBe(DEFAULT_LOGIN_GLOBAL_FAIL_PER_MIN);
      expect(resolveGlobalFailThreshold({ [LOGIN_GLOBAL_FAIL_ENV]: '  ' })).toBe(
        DEFAULT_LOGIN_GLOBAL_FAIL_PER_MIN,
      );
    });

    it('垃圾值 → 默认值（**不是**关闭）', () => {
      for (const bad of ['abc', '12O', 'NaN', 'Infinity', '1e999']) {
        expect(resolveGlobalFailThreshold({ [LOGIN_GLOBAL_FAIL_ENV]: bad })).toBe(
          DEFAULT_LOGIN_GLOBAL_FAIL_PER_MIN,
        );
      }
    });

    it('显式 0 / 负数 → 关闭（这是唯一表达"我不要"的方式）', () => {
      expect(resolveGlobalFailThreshold({ [LOGIN_GLOBAL_FAIL_ENV]: '0' })).toBe(0);
      expect(resolveGlobalFailThreshold({ [LOGIN_GLOBAL_FAIL_ENV]: '-5' })).toBe(0);
    });

    it('合法值照用，超大值被夹住', () => {
      expect(resolveGlobalFailThreshold({ [LOGIN_GLOBAL_FAIL_ENV]: '50' })).toBe(50);
      expect(resolveGlobalFailThreshold({ [LOGIN_GLOBAL_FAIL_ENV]: '1e12' })).toBe(1_000_000);
    });
  });

  describe('全局窗口：一个对象，不是一张表', () => {
    it('窗口内累加，窗口过后归零', () => {
      const t0 = 1_700_000_000_000;
      expect(noteGlobalLoginFailure(t0)).toBe(1);
      expect(noteGlobalLoginFailure(t0 + 1000)).toBe(2);
      expect(currentGlobalLoginFailures(t0 + 2000)).toBe(2);
      expect(currentGlobalLoginFailures(t0 + LOGIN_GLOBAL_WINDOW_MS + 1)).toBe(0);
      // 过期之后再来一次是重开窗口，不是接着加
      expect(noteGlobalLoginFailure(t0 + LOGIN_GLOBAL_WINDOW_MS + 2)).toBe(1);
    });

    it('⚠️ 一百万个不同 IP 的失败也只占同样多的状态（与 per-IP 桶不同，这里没有键）', () => {
      // 这条是"为了防 DoS 又造一个无界 Map"的反面教材：全局计数必须是 O(1) 内存
      const t0 = 1_800_000_000_000;
      for (let i = 0; i < 1_000_000; i += 1) noteGlobalLoginFailure(t0 + (i % 1000));
      expect(currentGlobalLoginFailures(t0 + 1000)).toBe(1_000_000);
      // 没有任何按 IP 的键被创建（attemptLimit 的表也一条没多）
      const guardSrc = stripCommentsForAnchor(
        readFileSync(join(__dirname, 'login.guard.ts'), 'utf-8'),
      );
      expect(guardSrc).not.toMatch(/new Map\b/);
      expect(guardSrc).not.toMatch(/new Set\b/);
    });
  });

  describe('cluster 摊薄', () => {
    it('多 worker 时阈值被摊薄（每进程只看到 1/N 的失败）⇒ 更严，不会更松', () => {
      process.env[LOGIN_GLOBAL_FAIL_ENV] = '120';
      const single = makeGuard();
      delete process.env.VANBLOG_CLUSTER_WORKERS;
      for (let i = 0; i < 40; i += 1) noteGlobalLoginFailure();
      const delaySingle = single.globalThrottleDelayMs();

      process.env.VANBLOG_CLUSTER_WORKERS = '4';
      const clustered = makeGuard();
      const delayClustered = clustered.globalThrottleDelayMs();

      // 4 个 worker ⇒ 阈值 120/4=30 ⇒ 同样的 40 次失败更容易越线
      expect(delayClustered).toBeGreaterThan(delaySingle);
    });

    it('⚠️ "关闭"必须真的是关闭：scaleLimit(0) 会被兜成 1，所以 0 要在摊薄**之前**处理', () => {
      // 这条钉的是实现顺序：先判 <=0 返回，再 scaleLimit。
      // 反过来的话 `VANBLOG_LOGIN_GLOBAL_FAIL_PER_MIN=0` 会变成"阈值 1"——
      // 一次失败就给全站登录加延迟，正是站长显式关掉时最不想要的行为。
      process.env[LOGIN_GLOBAL_FAIL_ENV] = '0';
      process.env.VANBLOG_CLUSTER_WORKERS = '4';
      for (let i = 0; i < 50; i += 1) noteGlobalLoginFailure();
      expect(makeGuard().globalThrottleDelayMs()).toBe(0);
      delete process.env.VANBLOG_CLUSTER_WORKERS;
      expect(makeGuard().globalThrottleDelayMs()).toBe(0);
    });
  });

  describe('守卫集成', () => {
    it('正常水位：canActivate 立刻放行，零延迟', async () => {
      const guard = makeGuard();
      const started = Date.now();
      await expect(guard.canActivate(ctxOf(reqOf('203.0.113.5')))).resolves.toBe(true);
      expect(Date.now() - started).toBeLessThan(50);
    });

    it('⚠️ 节流期间登录**仍然成功**，只是变慢（是加延迟，不是拒绝）', async () => {
      process.env[LOGIN_GLOBAL_FAIL_ENV] = '1';
      process.env[LOGIN_THROTTLE_MAX_ENV] = '100'; // envPositiveInt 的下限就是 100
      const guard = makeGuard();
      for (let i = 0; i < 6; i += 1) noteGlobalLoginFailure();
      expect(guard.globalThrottleDelayMs()).toBeGreaterThan(0);

      const started = Date.now();
      await expect(guard.canActivate(ctxOf(reqOf('203.0.113.6')))).resolves.toBe(true);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(80); // 真的等了（定时器没有 unref 成空转）
      expect(elapsed).toBeLessThan(2000); // 但被封顶住了，不会无限拖
    });

    it('全局计数由 recordFailure 驱动，且**不受** per-IP 开关影响', async () => {
      __resetLoginThrottleForTest();
      expect(currentGlobalLoginFailures()).toBe(0);
      // 老站点关掉了 per-IP 防爆破 ⇒ 全局节流仍然要工作（否则关掉一个防护把另一个也带走了）
      const guard = makeGuard({ enableMaxLoginRetry: false });
      await guard.recordFailure(reqOf('203.0.113.30'));
      await guard.recordFailure(reqOf('203.0.113.31'));
      expect(currentGlobalLoginFailures()).toBe(2);
    });

    it('成功登录不清空全局窗口（否则有一个号就能一直抹掉"正在被打"的证据）', async () => {
      __resetLoginThrottleForTest();
      const guard = makeGuard();
      for (let i = 0; i < 10; i += 1) noteGlobalLoginFailure();
      await guard.reset(reqOf('203.0.113.40'));
      expect(currentGlobalLoginFailures()).toBe(10);
    });

    it('per-IP 已超限时立刻拒绝，不再叠加节流延迟', async () => {
      process.env[LOGIN_GLOBAL_FAIL_ENV] = '1';
      process.env[LOGIN_THROTTLE_MAX_ENV] = '100';
      const guard = makeGuard();
      const req = reqOf('203.0.113.50');
      for (let i = 0; i < 5; i += 1) await guard.recordFailure(req);
      for (let i = 0; i < 20; i += 1) noteGlobalLoginFailure();

      const started = Date.now();
      await expect(guard.canActivate(ctxOf(req))).rejects.toThrow(/错误次数过多/);
      // 已经要拒了，就别再拖 100ms（拖了只是浪费自己的连接与内存）
      expect(Date.now() - started).toBeLessThan(80);
    });

    it('节流日志有间隔限制（被打的时候不能自己制造日志炸弹）', async () => {
      process.env[LOGIN_GLOBAL_FAIL_ENV] = '1';
      process.env[LOGIN_THROTTLE_MAX_ENV] = '100';
      const guard = makeGuard();
      const warn = jest.spyOn((guard as any).logger, 'warn').mockImplementation(() => undefined);
      for (let i = 0; i < 5; i += 1) noteGlobalLoginFailure();
      for (let i = 0; i < 3; i += 1) await guard.canActivate(ctxOf(reqOf(`203.0.113.${60 + i}`)));
      const throttleLogs = warn.mock.calls.filter((c) => String(c[0]).includes('全局登录失败速率偏高'));
      expect(throttleLogs.length).toBe(1);
      // 日志里要给出可照做的旋钮名，否则站长只能干看着
      expect(String(throttleLogs[0][0])).toContain(LOGIN_GLOBAL_FAIL_ENV);
      expect(String(throttleLogs[0][0])).toContain(LOGIN_THROTTLE_MAX_ENV);
      warn.mockRestore();
    });
  });

  it('源码钉子：两个旋钮都真的有读取点（不是只写进日志的死名字）', () => {
    const src = stripCommentsForAnchor(readFileSync(join(__dirname, 'login.guard.ts'), 'utf-8'));
    // ⚠️ 这里必须匹配**标识符**写法。用模板字符串插值常量会得到它的**值**
    //    （`env[VANBLOG_LOGIN_GLOBAL_FAIL_PER_MIN]`），那个形状源码里根本不存在 ——
    //    第一版就是这么写红的（而它的"空转反证"当时还假绿了）。
    expect(src).toContain('env[LOGIN_GLOBAL_FAIL_ENV]');
    expect(src).toContain('LOGIN_THROTTLE_MAX_ENV');
    expect(src).toContain('envPositiveInt(');
    expect(src).toContain('scaleLimit(');
    // 两个名字也必须真的是那两个环境变量（防止把读取点改名后与文档漂移）
    expect(LOGIN_GLOBAL_FAIL_ENV).toBe('VANBLOG_LOGIN_GLOBAL_FAIL_PER_MIN');
    expect(LOGIN_THROTTLE_MAX_ENV).toBe('VANBLOG_LOGIN_THROTTLE_MAX_MS');
    // ⚠️ 空转反证：尺子必须量不到不含读取点的代码
    const noRead = stripCommentsForAnchor(
      "export function f(env: NodeJS.ProcessEnv): number { return 120; }",
    );
    expect(noRead).not.toContain('env[LOGIN_GLOBAL_FAIL_ENV]');
    // 而同一把尺子能量到真实形状（否则 not.toContain 永远为真，等于没测）
    expect(src).toContain('env[LOGIN_GLOBAL_FAIL_ENV]');
  });
});
