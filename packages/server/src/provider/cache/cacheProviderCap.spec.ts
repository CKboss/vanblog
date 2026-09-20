import { CacheProvider, MAX_ENTRIES } from './cache.provider';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `CacheProvider` 的条数上限。
 *
 * ## 钉的是什么事故
 *
 * 这张表曾经存**登录防爆破的失败窗口**，键形如 `login-<客户端 IP>`。它没有 TTL、
 * 没有淘汰、没有上限，而键里有**攻击者完全可控**的成分 ⇒ 换着源 IP 打登录就能让
 * 堆单调增长到 OOM，把容器打成 crash-loop。匿名可达、不需要任何凭据，
 * 在"要在敌意环境下持续发布信息"的前提下属于必须堵的那一类。
 *
 * 那份状态已经搬去 `utils/attemptLimit.ts`（有界 + 过期清扫 + 按 count 淘汰最冷）。
 * 这里钉的是**第二道防线**：即使以后有人再往这张表里塞一个按外部输入分桶的键，
 * 也会在第 65 个键上被拒并打 ERROR，而不是安静地把内存吃光。
 *
 * ⚠️ 所以这些断言必须是**行为级**的（灌注一堆键，然后看条目数），
 *    不能只断言"常量存在"——常量存在而 `set()` 不看它，是最容易骗过审查的形状。
 */
describe('CacheProvider 的条数上限（防"按外部输入分桶"导致的无界堆增长）', () => {
  let cache: CacheProvider;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    cache = new CacheProvider();
    errorSpy = jest.spyOn((cache as any).logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('上限内的不同键都能写进去', () => {
    for (let i = 0; i < MAX_ENTRIES; i += 1) {
      expect(cache.set(`k${i}`, i)).toBe(true);
    }
    expect(cache.stats().size).toBe(MAX_ENTRIES);
    expect(cache.stats().refused).toBe(0);
  });

  it('灌注 5 万个"每个 IP 一个键"之后，条目数仍然被上限封住（这就是原来的 OOM 路径）', () => {
    // 攻击形状：每个请求换一个源 IP ⇒ 每个请求一个新键。
    // ⚠️ 用 5,000 而不是 50,000：`set()` 每次新增键都要 `Object.keys().length`（O(n)），
    //    上限**生效**时 n≤64 所以无所谓；但万一哪天上限被改坏，5 万次插入就是 O(n²)
    //    ≈ 12.5 亿次操作、这条用例要跑 7 分钟（实测过）。5,000 已经远超上限 64，
    //    证明力一样，而坏掉时几秒就红 —— 让回归**快速**失败比让回归"规模逼真"更重要。
    const ATTEMPTS = 5_000;
    for (let i = 0; i < ATTEMPTS; i += 1) {
      cache.set(`login-203.0.113.${i % 256}-${i}`, { count: 1 });
    }
    const stats = cache.stats();
    expect(stats.size).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(stats.size).toBe(MAX_ENTRIES);
    // 被拒的写入必须被计数，否则"防住了"和"根本没写进来"分不开
    expect(stats.refused).toBe(ATTEMPTS - MAX_ENTRIES);
  });

  it('拒绝是**响亮的**：打 ERROR，且指出该用 attemptLimit', () => {
    for (let i = 0; i < MAX_ENTRIES + 1; i += 1) cache.set(`k${i}`, i);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain('attemptLimit');
    // 消息里必须说清"这不是通用缓存"，否则下一个人只会把上限调大
    expect(message).toContain('不是通用缓存');
  });

  it('同一个被拒的键只打一次 ERROR（被洪水打时日志本身也会变成资源消耗）', () => {
    for (let i = 0; i < MAX_ENTRIES; i += 1) cache.set(`k${i}`, i);
    for (let i = 0; i < 500; i += 1) cache.set('login-1.2.3.4', { count: i });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('表满时**覆盖已有键仍然成功**（否则恢复密钥重生成会被自己拒掉）', () => {
    for (let i = 0; i < MAX_ENTRIES; i += 1) cache.set(`k${i}`, i);
    expect(cache.set('k0', 'new-value')).toBe(true);
    expect(cache.get('k0')).toBe('new-value');
    // 真正的凭据键必须在满表时也能写入
    // ⚠️ restoreKey 是**豁免**的：站长被锁在门外时唯一的自救通道，
    //    不能因为别人把表塞满就写不进去（键名是代码常量，攻击者造不出第 65 个键）
    expect(cache.set('restoreKey', 'x'.repeat(44))).toBe(true);
    expect(cache.getString('restoreKey')).toBe('x'.repeat(44));
    // 而一个普通的新键在满表时必须被拒（这才是上限的意义）
    expect(cache.set('someNewKey', 1)).toBe(false);
  });

  it('⚠️ 上限是"拒绝写入"而不是"淘汰最旧的"：先写的凭据不会被后来者挤掉', () => {
    // restoreKey 是站长被锁在后台外时唯一的自救通道，静默淘汰它比拒绝一次误用严重得多
    expect(cache.set('restoreKey', 'y'.repeat(44))).toBe(true);
    for (let i = 0; i < MAX_ENTRIES * 3; i += 1) cache.set(`flood-${i}`, 1);
    expect(cache.getString('restoreKey')).toBe('y'.repeat(44));
  });

  describe('既有语义一条都没变（上限只加在"新增不同键"这一条路上）', () => {
    it('get() 缺失键仍然返回 {}（历史陷阱，保留但已无生产调用方）', () => {
      expect(cache.get('nope')).toEqual({});
      // 这个陷阱本身要被记住：`"x" != {}` 在 JS 里是 false
      // 陷阱的确切形状：字符串**正好**是 "[object Object]" 时，`!=` 会是 false
      // （对象先 ToPrimitive）。换成别的字符串就不成立了 —— 别把这个断言写宽。
      expect('[object Object]' != (cache.get('nope') as any)).toBe(false);
      expect('whatever' != (cache.get('nope') as any)).toBe(true);
    });

    it('getString() 仍然做类型与长度校验，拿不到就 null（失败关闭）', () => {
      cache.set('obj', { a: 1 });
      cache.set('short', 'abc');
      cache.set('ok', ` ${'z'.repeat(40)} `);
      expect(cache.getString('obj')).toBeNull();
      expect(cache.getString('missing')).toBeNull();
      expect(cache.getString('short')).toBeNull();
      expect(cache.getString('ok')).toBe('z'.repeat(40));
      expect(cache.getString('ok', 64)).toBeNull();
    });
  });

  it('源码钉子：登录守卫已经不再把状态写进这张无界表', () => {
    const guard = stripCommentsForAnchor(
      readFileSync(join(__dirname, '..', 'auth', 'login.guard.ts'), 'utf-8'),
    );
    expect(guard).not.toContain('cacheProvider');
    expect(guard).not.toContain('CacheProvider');
    // ⚠️ 空转反证：尺子本身必须能量到旧形状，否则上面两条 not.toContain 永远为真
    expect(stripCommentsForAnchor('this.cacheProvider.set(key, { count: 1 });')).toContain(
      'cacheProvider',
    );
    // 而且它必须真的在用有界的那张表
    expect(guard).toContain('recordFailureAttempt');
    expect(guard).toContain('peekAttempts');
    expect(guard).toContain('resetAttempts');
  });
});
