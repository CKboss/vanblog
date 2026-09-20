import { hashSecretAsync } from 'src/utils/crypto';
import { UserProvider } from './user.provider';

/**
 * 登录路径的两条性质：**口令校验不再阻塞事件循环**，以及**用户名枚举的时序差被抹平**。
 *
 * 修复前的形状：`validateUser` 先 `find({name})`，`if (!user) return null` **在任何哈希之前**
 * ⇒ 用户存在 ≈ 63ms（一次 scrypt）、用户不存在 ≈ 1ms（只有一次 DB 查询），可以按时序枚举用户名。
 * 修复后：用户不存在时也跑一次**等价成本**的 dummy scrypt（`runDummyPasswordWork`）并丢弃结果。
 *
 * ⚠️ 这条只能在 scrypt 异步化**之后**做：同步的 dummy 哈希会让枚举防护本身变成 DoS 放大器
 * （攻击者用不存在的用户名就能白拿 63ms 阻塞，比用真用户名还便宜）。
 *
 * ⚠️ 断言刻意**不比较毫秒数**（那会 flaky）：判据是"两条路径都真的做了 KDF 工作"
 * （都远大于 1ms 的纯查询成本），以及"透明升级确实被 await 了"（用可控制的 deferred 证明顺序）。
 */

const KDF_FLOOR_MS = 20; // 真实成本约 63ms；阈值放宽到 20ms 以吸收机器差异，仍远高于"没算"的 ~1ms

function makeUserModel(users: any[], opts?: { updateOneImpl?: () => Promise<any> }) {
  const state: any = {};
  const chain: any = {
    sort: jest.fn((spec: any) => {
      state.sort = spec;
      return chain;
    }),
    limit: jest.fn((n: number) => {
      state.limit = n;
      return chain;
    }),
    exec: jest.fn(async () => {
      const matched = users.filter((u) => u.name === state.name);
      const sorted = [...matched].sort((a, b) => {
        // 只支持 {id:1} 这一种排序（生产实现就是它）
        return state.sort?.id === 1 ? a.id - b.id : 0;
      });
      return state.limit ? sorted.slice(0, state.limit) : sorted;
    }),
  };
  const model: any = {
    find: jest.fn((q: any) => {
      state.name = q?.name;
      return chain;
    }),
    findOne: jest.fn(async () => null),
    updateOne: jest.fn(opts?.updateOneImpl ?? (async () => ({ acknowledged: true }))),
  };
  return { model, chain, state };
}

function makeProvider(model: any) {
  const provider: any = Object.create(UserProvider.prototype);
  const warn = jest.fn();
  const error = jest.fn();
  provider.logger = { log: jest.fn(), warn, error, debug: jest.fn(), verbose: jest.fn() };
  provider.userModel = model;
  return { provider, warn, error };
}

describe('登录：用户名存在与不存在两条路径的成本被抹平', () => {
  let storedHash: string;
  const browserPassword = 'browser-derived-value';

  beforeAll(async () => {
    storedHash = await hashSecretAsync(browserPassword);
  });

  it(
    '用户不存在 ⇒ 拒绝登录，但**仍然跑了一次真实 KDF**（不再是 1ms 的快速返回）',
    async () => {
      const { model } = makeUserModel([{ id: 0, name: 'JiangOil', password: storedHash, salt: 's' }]);
      const { provider } = makeProvider(model);
      const started = Date.now();
      const result = await provider.validateUser('nobody-here', browserPassword);
      const elapsed = Date.now() - started;
      expect(result).toBeNull();
      // 关键判据：耗时落在"真的算了 scrypt"的量级，而不是"只查了一次库"
      expect(elapsed).toBeGreaterThan(KDF_FLOOR_MS);
    },
    30000,
  );

  it(
    '用户存在但密码错 ⇒ 同样跑一次真实 KDF（两条路径耗时同量级，无法按时序区分）',
    async () => {
      const { model } = makeUserModel([{ id: 0, name: 'JiangOil', password: storedHash, salt: 's' }]);
      const { provider } = makeProvider(model);
      const started = Date.now();
      const result = await provider.validateUser('JiangOil', 'wrong-password');
      const elapsed = Date.now() - started;
      expect(result).toBeNull();
      expect(elapsed).toBeGreaterThan(KDF_FLOOR_MS);
    },
    30000,
  );

  it('空用户名 / 空口令在**任何哈希之前**就挡掉（这不是枚举信号：两者都不花 KDF 成本）', async () => {
    const { model } = makeUserModel([{ id: 0, name: 'JiangOil', password: storedHash, salt: 's' }]);
    const { provider } = makeProvider(model);
    expect(await provider.validateUser('', browserPassword)).toBeNull();
    expect(await provider.validateUser('   ', browserPassword)).toBeNull();
    expect(await provider.validateUser('JiangOil', '')).toBeNull();
    expect(await provider.validateUser(undefined as any, browserPassword)).toBeNull();
    // 连库都没查（入参校验在最前面）
    expect(model.find).not.toHaveBeenCalled();
  });

  it('密码正确 ⇒ 返回用户，且触发一次透明升级（盐轮换 + 旧格式升 scrypt）', async () => {
    const { model } = makeUserModel([{ id: 0, name: 'JiangOil', password: storedHash, salt: 's' }]);
    const { provider } = makeProvider(model);
    const user = await provider.validateUser('JiangOil', browserPassword);
    expect(user).not.toBeNull();
    expect(user.id).toBe(0);
    expect(model.updateOne).toHaveBeenCalledTimes(1);
    const written = model.updateOne.mock.calls[0][1];
    expect(typeof written.password).toBe('string');
    expect(written.password.startsWith('scrypt$')).toBe(true);
    // 绝不把空哈希写进库（空哈希曾经等于"空密码可登录"）
    expect(written.password.length).toBeGreaterThan(20);
  }, 30000);
});

describe('透明升级必须被 await（旧实现是 fire-and-forget）', () => {
  let storedHash: string;
  beforeAll(async () => {
    storedHash = await hashSecretAsync('browser-derived-value');
  });

  it('validateUser 在升级落库**之后**才返回（用可控 deferred 证明顺序，不靠计时）', async () => {
    const order: string[] = [];
    let releaseUpdate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseUpdate = r;
    });
    const { model } = makeUserModel([{ id: 0, name: 'JiangOil', password: storedHash, salt: 's' }], {
      updateOneImpl: async () => {
        order.push('update-started');
        await gate;
        order.push('update-finished');
        return { acknowledged: true };
      },
    });
    const { provider } = makeProvider(model);
    const pending = provider.validateUser('JiangOil', 'browser-derived-value').then((u) => {
      order.push('validate-returned');
      return u;
    });
    // ⚠️ 不在中途断言 order 的状态：validateUser 里有一次真实 scrypt（约 63ms，落在
    //    libuv 线程池），所以"两个 setImmediate 之后 update 已经开始"并不成立
    //    （我第一版就这么写了，收到的是空数组）。真正有区分力的是**最终顺序**：
    //    若 updateSalt 没被 await，'validate-returned' 会排在 'update-started' 之前
    //    （因为 updateSalt 内部要先 await 一次 scrypt 才会调 updateOne），断言就会红。
    releaseUpdate();
    await pending;
    expect(order).toEqual(['update-started', 'update-finished', 'validate-returned']);
  }, 30000);

  it('升级失败**不该**让一次合法登录失败（尽力而为 + WARN，不是静默吞掉）', async () => {
    const { model } = makeUserModel([{ id: 0, name: 'JiangOil', password: storedHash, salt: 's' }], {
      updateOneImpl: async () => {
        throw new Error('mongo 抖动');
      },
    });
    const { provider, warn } = makeProvider(model);
    const user = await provider.validateUser('JiangOil', 'browser-derived-value');
    expect(user).not.toBeNull(); // 登录仍然成功
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    expect(text).toContain('透明升级失败');
    expect(text).toContain('mongo 抖动');
    // WARN 里不许把口令或哈希写出来
    expect(text).not.toContain('browser-derived-value');
    expect(text).not.toContain('scrypt$');
  }, 30000);
});

describe('同名账号的确定性（既有性质不能被这轮改动弄坏）', () => {
  it('重名时固定命中 id 最小的那条（管理员 id:0 优先），并大声 ERROR', async () => {
    const adminHash = await hashSecretAsync('browser-derived-value');
    const { model } = makeUserModel([
      { id: 7, name: 'JiangOil', password: 'collaborator-hash', salt: 's', type: 'collaborator' },
      { id: 0, name: 'JiangOil', password: adminHash, salt: 's', type: 'admin' },
    ]);
    const { provider, error } = makeProvider(model);
    const user = await provider.validateUser('JiangOil', 'browser-derived-value');
    // 命中的是管理员（id 0），而不是"自然顺序里排在前面"的协作者
    expect(user.id).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('多条');
    // 排序与 limit 确实被用上了（否则确定性只是巧合）
    expect(model.find).toHaveBeenCalledWith({ name: 'JiangOil' });
  }, 30000);
});
