import {
  DUMMY_SCRYPT_HASH,
  hashAccessPasswordAsync,
  hashSecret,
  hashSecretAsync,
  runDummyPasswordWork,
  safeEqual,
  verifyAccessPassword,
  verifyAccessPasswordAsync,
  verifySecret,
  verifySecretAsync,
  verifyUserPassword,
  verifyUserPasswordAsync,
} from 'src/utils/crypto';
import {
  hashAccessPasswordIdempotent,
  hashAccessPasswordIdempotentAsync,
  resolveAccessPasswordWrite,
  resolveAccessPasswordWriteAsync,
} from 'src/utils/accessPassword';

/**
 * scrypt 异步化的**行为级**守卫。
 *
 * 为什么这件事值得一个专门的文件：同步 `scryptSync`（N=16384,r=8,p=1,keylen=64）本机实测
 * **63 ms/次**，而 Nest 每个 worker 是单线程事件循环。文章解锁是**匿名可达**的，预算
 * 20 次/10 分钟/(IP×文章) ⇒ 攻击者不需要猜中密码，只要用足够多的 (IP×文章) 组合，
 * 就能让事件循环长期停摆；连带把 `/api/public/health`（要 ping mongo）拖超时 ⇒
 * 容器判 unhealthy ⇒ `restart: always` 重启风暴，而**重启不能缓解**。
 *
 * ⚠️ 这里刻意**不用**"源码里出现了 promisify/Async 字样"这种断言 —— import 行就能让它过，
 * 把调用包进 `if (false && …)` 也能让它过（本仓库已经踩过两次这种空断言）。
 * 下面每条都断言**可观测行为**。
 */

/** 让事件循环有机会转动的最小等待（不做真实计时断言，避免 flaky） */
function nextTurns(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = () => {
      left -= 1;
      if (left <= 0) {
        resolve();
      } else {
        setImmediate(step);
      }
    };
    setImmediate(step);
  });
}

describe('scrypt 异步化：事件循环不再被口令校验独占', () => {
  const CONCURRENCY = 6;

  it(
    '并发跑多次异步校验时，事件循环仍然在转（定时器回调按时执行）',
    async () => {
      const stored = await hashSecretAsync('correct-horse-battery-staple');
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 0);
      // 6 次 scrypt ≈ 6 × 63ms ≈ 380ms 的 CPU 工作。落到 libuv 线程池时事件循环是自由的，
      // 几百个 tick 轻轻松松；落在事件循环上则一个都轮不到。
      await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) => verifySecretAsync(stored, `wrong-${i}`)),
      );
      clearInterval(timer);
      expect(ticks).toBeGreaterThanOrEqual(20);
    },
    30000,
  );

  it(
    '空转反证：同样的负载走**同步**版时事件循环几乎不转（证明上面那条判据真的有区分力）',
    async () => {
      const stored = hashSecret('correct-horse-battery-staple');
      await nextTurns(2);
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 0);
      for (let i = 0; i < CONCURRENCY; i += 1) {
        verifySecret(stored, `wrong-${i}`);
      }
      clearInterval(timer);
      // 同步版本把 ~380ms 全部压在事件循环上，期间定时器一个都跑不了
      expect(ticks).toBeLessThanOrEqual(2);
    },
    30000,
  );
});

describe('异步版与同步版语义逐条一致（迁移不能顺手改掉安全性质）', () => {
  const secret = 'p@ssw0rd-正确-密码';

  it('hashSecretAsync 产出的格式与同步版一致，且能被两版互相校验', async () => {
    const viaAsync = await hashSecretAsync(secret);
    const viaSync = hashSecret(secret);
    expect(viaAsync.split('$')[0]).toBe('scrypt');
    expect(viaAsync.split('$')).toHaveLength(6);
    // 参数必须与同步版完全相同，否则"同一个库里的哈希"会有两种成本/强度
    expect(viaAsync.split('$').slice(1, 4)).toEqual(viaSync.split('$').slice(1, 4));
    // 交叉校验：异步哈希能被同步版验，同步哈希能被异步版验
    expect(verifySecret(viaAsync, secret)).toBe(true);
    expect(await verifySecretAsync(viaSync, secret)).toBe(true);
    expect(await verifySecretAsync(viaAsync, `${secret}x`)).toBe(false);
  });

  it('空口令两版都返回空串/ false（绝不产出"空哈希"）', async () => {
    expect(await hashSecretAsync('')).toBe('');
    expect(hashSecret('')).toBe('');
    expect(await verifySecretAsync('', '')).toBe(false);
    const stored = await hashSecretAsync(secret);
    expect(await verifySecretAsync(stored, '')).toBe(false);
  });

  it('攻击者可控的 scrypt 参数仍然被夹上限（异步版同样拒绝，且不抛错）', async () => {
    const salt = Buffer.alloc(16, 1).toString('base64');
    const hash = Buffer.alloc(64, 2).toString('base64');
    const hostile = [
      `scrypt$1073741824$8$1$${salt}$${hash}`, // N = 2^30 ⇒ 会 OOM
      `scrypt$16384$4096$1$${salt}$${hash}`, // r 超上限
      `scrypt$16384$8$4096$${salt}$${hash}`, // p 超上限
      `scrypt$1048576$64$1$${salt}$${hash}`, // 128*N*r 超 maxmem
      `scrypt$0$8$1$${salt}$${hash}`, // N <= 0
      `scrypt$-1$8$1$${salt}$${hash}`,
      `scrypt$abc$8$1$${salt}$${hash}`, // 非数字
      `scrypt$16384$8$1$${salt}`, // 段数不对
      `not-scrypt$16384$8$1$${salt}$${hash}`, // 前缀不对
    ];
    for (const stored of hostile) {
      // 关键：既不抛错（匿名接口抛错=500，本身就是一种可利用信号），也不误判为通过
      await expect(verifySecretAsync(stored, 'anything')).resolves.toBe(false);
      expect(verifySecret(stored, 'anything')).toBe(false);
    }
  });

  it('verifyAccessPasswordAsync：历史明文与 scrypt 哈希都认，比较仍是常量时间口径', async () => {
    // 历史明文
    expect(await verifyAccessPasswordAsync('plain-123', 'plain-123')).toBe(true);
    expect(await verifyAccessPasswordAsync('plain-123', 'plain-124')).toBe(false);
    // scrypt 哈希
    const hashed = await hashAccessPasswordAsync('article-key');
    expect(await verifyAccessPasswordAsync(hashed, 'article-key')).toBe(true);
    expect(await verifyAccessPasswordAsync(hashed, 'Article-key')).toBe(false);
    // 两头空值都挡（目标为空 = 没设密码，绝不能"空对空"通过）
    expect(await verifyAccessPasswordAsync('', '')).toBe(false);
    expect(await verifyAccessPasswordAsync('', 'x')).toBe(false);
    expect(await verifyAccessPasswordAsync('y', '')).toBe(false);
    // 与同步版逐条一致
    expect(await verifyAccessPasswordAsync(hashed, 'article-key')).toBe(
      verifyAccessPassword(hashed, 'article-key'),
    );
    expect(await verifyAccessPasswordAsync('plain-123', 'nope')).toBe(
      verifyAccessPassword('plain-123', 'nope'),
    );
    // safeEqual 的语义没被绕过：长度不同直接 false，但绝不用 !== 短路比较明文
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('verifyUserPasswordAsync：旧 sha256 格式与新 scrypt 格式都与同步版一致', async () => {
    const scryptStored = await hashSecretAsync('browser-derived-value');
    expect(await verifyUserPasswordAsync(scryptStored, 'jiang', 'browser-derived-value', 'salt'))
      .toBe(true);
    expect(await verifyUserPasswordAsync(scryptStored, 'jiang', 'wrong', 'salt')).toBe(false);
    expect(
      await verifyUserPasswordAsync(scryptStored, 'jiang', 'browser-derived-value', 'salt'),
    ).toBe(verifyUserPassword(scryptStored, 'jiang', 'browser-derived-value', 'salt'));
    // 空 stored / 非字符串口令两版都 false
    expect(await verifyUserPasswordAsync('', 'jiang', 'x', 's')).toBe(false);
    expect(await verifyUserPasswordAsync(scryptStored, 'jiang', '', 's')).toBe(false);
    expect(await verifyUserPasswordAsync(scryptStored, 'jiang', undefined as any, 's')).toBe(false);
  });
});

describe('时序均衡（用户名枚举）：dummy 哈希的成本与真实校验**由构造保证**等价', () => {
  it('DUMMY_SCRYPT_HASH 的 KDF 参数与生产参数逐项相同（不是靠比毫秒数）', () => {
    const dummy = DUMMY_SCRYPT_HASH.split('$');
    const real = hashSecret('whatever').split('$');
    expect(dummy[0]).toBe('scrypt');
    expect(dummy).toHaveLength(6);
    // N / r / p 必须与生产一致 ⇒ 单次成本一致 ⇒ "用户不存在"与"密码错"耗时同量级
    expect(dummy.slice(1, 4)).toEqual(real.slice(1, 4));
    // 盐与哈希长度也要一致（keylen 由 expected.length 决定，短了成本就低了）
    expect(Buffer.from(dummy[4], 'base64')).toHaveLength(Buffer.from(real[4], 'base64').length);
    expect(Buffer.from(dummy[5], 'base64')).toHaveLength(Buffer.from(real[5], 'base64').length);
  });

  it('dummy 哈希不可能被"猜中"：任何输入都校验失败，runDummyPasswordWork 也永不返回真值', async () => {
    for (const input of ['', 'admin', 'password', 'timing-equalizer', 'x'.repeat(200)]) {
      expect(await verifySecretAsync(DUMMY_SCRYPT_HASH, input)).toBe(false);
    }
    // 返回值是 void：调用方拿不到任何可用信息（结构上就不可能"用 dummy 结果登录"）
    await expect(runDummyPasswordWork('admin')).resolves.toBeUndefined();
    // 畸形输入不抛错（登录路径抛错会变成 500）
    await expect(runDummyPasswordWork(undefined as any)).resolves.toBeUndefined();
    await expect(runDummyPasswordWork({} as any)).resolves.toBeUndefined();
  });

  it('runDummyPasswordWork 确实做了真实的 KDF 工作（不是空函数）', async () => {
    // 用"能不能与真实校验互相替换"来证明，而不是比毫秒：
    // dummy 走的正是 verifySecretAsync(DUMMY_SCRYPT_HASH, …) 这条真实 scrypt 路径。
    const started = Date.now();
    await runDummyPasswordWork('admin');
    const elapsed = Date.now() - started;
    // 阈值给得很宽（真实成本约 63ms，这里只要求 > 10ms），既证明"真的算了"，
    // 又不会因为机器负载而 flaky。
    expect(elapsed).toBeGreaterThan(10);
  }, 30000);
});

describe('accessPassword 的异步入口与同步入口决策一致（共用同一份 intent 解析）', () => {
  const cases: Array<[string, any, 'create' | 'update']> = [
    ['create 留空 = 不加密', { password: '' }, 'create'],
    ['update 留空 = 不动', {}, 'update'],
    ['全空白按没填处理', { password: '   ' }, 'update'],
    ['显式清除', { clearPassword: true }, 'update'],
    ["clearPassword 只认字符串 'true'", { clearPassword: 'true' }, 'update'],
    ['真值 1 不算清除', { clearPassword: 1, password: 'x' }, 'update'],
    ['非字符串密码报错', { password: 123 }, 'update'],
    ['设新密码 + 清除同时给要报错', { password: 'x', clearPassword: true }, 'update'],
  ];

  it.each(cases)('%s：同步与异步给出完全相同的写入决策', async (_label, input, mode) => {
    let syncResult: any;
    let syncError: any;
    try {
      syncResult = resolveAccessPasswordWrite(input, mode);
    } catch (err) {
      syncError = (err as Error).message;
    }
    let asyncResult: any;
    let asyncError: any;
    try {
      asyncResult = await resolveAccessPasswordWriteAsync(input, mode);
    } catch (err) {
      asyncError = (err as Error).message;
    }
    expect(asyncError).toEqual(syncError);
    if (syncResult) {
      expect(asyncResult.hashed).toBe(syncResult.hashed);
      expect(asyncResult.cleared).toBe(syncResult.cleared);
      // 哈希值本身带随机盐，逐字节比不了；比"形状"：是否同为 scrypt 格式
      expect(typeof asyncResult.password).toBe(typeof syncResult.password);
      if (typeof syncResult.password === 'string' && syncResult.password) {
        expect(asyncResult.password.startsWith('scrypt$')).toBe(syncResult.password.startsWith('scrypt$'));
      } else {
        expect(asyncResult.password).toBe(syncResult.password);
      }
    }
  });

  it('幂等：已经是 scrypt 的值不会被二次哈希（否则文章永久锁死且无法还原）', async () => {
    const once = await hashAccessPasswordIdempotentAsync('secret-key');
    expect(once.startsWith('scrypt$')).toBe(true);
    const twice = await hashAccessPasswordIdempotentAsync(once);
    expect(twice).toBe(once);
    // 与同步版一致
    expect(hashAccessPasswordIdempotent(once)).toBe(once);
    // 空值
    expect(await hashAccessPasswordIdempotentAsync('')).toBe('');
    expect(await hashAccessPasswordIdempotentAsync(undefined)).toBe('');
  });

  it('异步写入口产出的哈希能被解锁校验认出来（端到端闭环）', async () => {
    const written = await resolveAccessPasswordWriteAsync({ password: 'reader-key' }, 'create');
    expect(written.hashed).toBe(true);
    expect(await verifyAccessPasswordAsync(written.password, 'reader-key')).toBe(true);
    expect(await verifyAccessPasswordAsync(written.password, 'wrong-key')).toBe(false);
  });
});
