import { LoginGuard } from './login.guard';
import {
  MAX_BUCKETS,
  __resetAttemptLimitForTest,
  attemptLimitStats,
  peekAttempts,
} from '../../utils/attemptLimit';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 登录失败窗口现在存在 `utils/attemptLimit.ts` 那张**有界**的表里。
 *
 * ## 钉的是什么事故
 *
 * 以前它存在 `CacheProvider`（一张没有 TTL、没有淘汰、没有上限的普通对象），
 * 键是 `login-<客户端 IP>`。攻击者不断换源 IP 打登录 ⇒ 堆单调增长 ⇒ OOM ⇒
 * 容器 crash-loop。匿名可达、不需要任何凭据。
 *
 * ## 这里要同时证明两件事
 *
 * 1. **搬完之后行为一条都没变**：还是 5 次失败、第 6 次尝试被拒、窗口 300 秒、
 *    成功登录清零。搬存储不能顺手改掉安全语义（尤其是"成功登录不算失败"——
 *    早期实现正是因为把判定和计数合成一步，才把正常用户锁在门外）。
 * 2. **有界**：灌注大量不同 IP 之后表大小不超过 `MAX_BUCKETS`，而且
 *    **正在被限流的热桶不会被洪水挤掉**（attemptLimit 的淘汰是按 count 从冷到热）。
 */
describe('登录失败窗口：有界存储 + 既有语义不变', () => {
  /** socket 是回环 ⇒ 在 trusted 模式下取 XFF 最右一跳，于是每个 IP 一个独立桶 */
  const reqOf = (ip: string) =>
    ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip } } as any);

  let savedEnv: NodeJS.ProcessEnv;
  let guard: LoginGuard;
  let setting: any;

  const makeGuard = (loginSetting: any = null) => {
    setting = loginSetting;
    const settingProvider = { getLoginSetting: async () => setting } as any;
    return new LoginGuard(settingProvider);
  };

  beforeEach(() => {
    __resetAttemptLimitForTest();
    savedEnv = { ...process.env };
    // scaleLimit 会按 worker 数摊薄阈值；测试要在确定的单进程语义下跑
    delete process.env.VANBLOG_CLUSTER_WORKERS;
    delete process.env.VANBLOG_BRUTE_FORCE_IP_SOURCE;
    guard = makeGuard(null); // 没有登录设置 ⇒ 默认开启、5 次 / 300 秒
  });

  afterEach(() => {
    process.env = savedEnv;
    __resetAttemptLimitForTest();
  });

  describe('既有语义（默认 5 次 / 300 秒）', () => {
    it('前 5 次失败都还允许尝试，第 6 次被拒 —— 与搬家之前逐位一致', async () => {
      const req = reqOf('203.0.113.7');
      for (let i = 1; i <= 5; i += 1) {
        expect((await guard.inspect(req)).allowed).toBe(true);
        expect(await guard.recordFailure(req)).toBe(i);
      }
      const sixth = await guard.inspect(req);
      expect(sixth.allowed).toBe(false);
      expect(sixth.count).toBe(5);
      expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
      expect(sixth.retryAfterSeconds).toBeLessThanOrEqual(300);
      expect(sixth.ip).toBe('203.0.113.7');
    });

    it('⚠️ inspect 是只读的：反复判断不会把正常用户自己锁掉', async () => {
      // 这是"判定在认证前、计数在认证失败后"这条性质的直接体现
      const req = reqOf('203.0.113.8');
      await guard.recordFailure(req);
      for (let i = 0; i < 100; i += 1) {
        expect((await guard.inspect(req)).allowed).toBe(true);
      }
      expect((await guard.inspect(req)).count).toBe(1);
    });

    it('成功登录清零（是**删除**桶，不是写一条 count:0）', async () => {
      const req = reqOf('203.0.113.9');
      for (let i = 0; i < 5; i += 1) await guard.recordFailure(req);
      expect((await guard.inspect(req)).allowed).toBe(false);
      const before = attemptLimitStats().size;
      await guard.reset(req);
      expect((await guard.inspect(req)).allowed).toBe(true);
      expect((await guard.inspect(req)).count).toBe(0);
      // 旧实现会给每个成功登录的 IP 留一条记录；现在必须一条都不留
      expect(attemptLimitStats().size).toBe(before - 1);
    });

    it('设置里的阈值与窗口真的被读到（不是写死 5/300）', async () => {
      guard = makeGuard({ enableMaxLoginRetry: true, maxRetryTimes: 2, durationSeconds: 60 });
      const req = reqOf('203.0.113.10');
      await guard.recordFailure(req);
      await guard.recordFailure(req);
      const state = await guard.inspect(req);
      expect(state.allowed).toBe(false);
      expect(state.retryAfterSeconds).toBeLessThanOrEqual(60);
    });

    it('老站点显式关掉防爆破仍然尊重（不会因为搬家而偷偷打开）', async () => {
      guard = makeGuard({ enableMaxLoginRetry: false });
      const req = reqOf('203.0.113.11');
      for (let i = 0; i < 20; i += 1) await guard.recordFailure(req);
      expect((await guard.inspect(req)).allowed).toBe(true);
      // 关掉时不该往表里写任何东西
      expect(peekAttempts('login-203.0.113.11', { max: 5, windowMs: 300_000 }).count).toBe(0);
    });

    it('每个 IP 各自计数，互不影响', async () => {
      const a = reqOf('203.0.113.20');
      const b = reqOf('203.0.113.21');
      for (let i = 0; i < 5; i += 1) await guard.recordFailure(a);
      expect((await guard.inspect(a)).allowed).toBe(false);
      expect((await guard.inspect(b)).allowed).toBe(true);
    });
  });

  describe('有界性（这才是这次搬家的全部理由）', () => {
    it('5 万个不同源 IP 各失败一次，表大小仍然被 MAX_BUCKETS 封住', async () => {
      for (let i = 0; i < 50_000; i += 1) {
        const ip = `203.0.${(i >> 8) & 255}.${i & 255}`;
        await guard.recordFailure(reqOf(ip));
      }
      const stats = attemptLimitStats();
      expect(stats.size).toBeLessThanOrEqual(MAX_BUCKETS);
      expect(stats.maxBuckets).toBe(MAX_BUCKETS);
      // 确实发生过淘汰（否则"没超上限"可能只是因为根本没写进去）
      expect(stats.evicted).toBeGreaterThan(0);
      // 老实现那种"整表清空"必须永远是 0：清空等于把所有正在生效的限制一起放行
      expect(stats.cleared).toBe(0);
    });

    it('⚠️ 正在被限流的热桶不会被一次性 key 的洪水挤掉', async () => {
      // 受害者：一个已经把攻击者关进小黑屋的热桶（count 高）
      const victim = reqOf('203.0.113.99');
      for (let i = 0; i < 5; i += 1) await guard.recordFailure(victim);
      expect((await guard.inspect(victim)).allowed).toBe(false);

      // 洪水：一堆 count=1 的一次性桶把表顶满
      for (let i = 0; i < MAX_BUCKETS + 5_000; i += 1) {
        await guard.recordFailure(reqOf(`198.18.${(i >> 8) & 255}.${i & 255}`));
      }

      // 淘汰按 count 从冷到热 ⇒ 受害者那条（count=5）必须还在，限制仍然生效
      expect((await guard.inspect(victim)).allowed).toBe(false);
      expect((await guard.inspect(victim)).count).toBe(5);
    });

    it('源码钉子：登录守卫里不许再出现"自己开一张表"的形状', () => {
      const guardSrc = stripCommentsForAnchor(
        readFileSync(join(__dirname, 'login.guard.ts'), 'utf-8'),
      );
      // 模块级 Map / 对象字面量表 = 下一张无界表（全局节流窗口是**单个对象**，不是表，见 loginThrottle.spec）
      expect(guardSrc).not.toMatch(/new Map\b/);
      expect(guardSrc).not.toMatch(/new Set\b/);
      expect(guardSrc).not.toContain('cacheProvider');
      // ⚠️ 空转反证：尺子必须能量到旧形状
      const legacy = stripCommentsForAnchor(
        'const t = new Map<string, number>(); this.cacheProvider.set(k, v);',
      );
      expect(legacy).toMatch(/new Map\b/);
      expect(legacy).toContain('cacheProvider');
      // 而且必须真的走 attemptLimit 的三个入口
      expect(guardSrc).toContain('peekAttempts(');
      expect(guardSrc).toContain('recordFailureAttempt(');
      expect(guardSrc).toContain('resetAttempts(');
    });
  });
});
