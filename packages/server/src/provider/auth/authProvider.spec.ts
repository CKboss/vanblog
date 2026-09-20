import { AuthProvider } from './auth.provider';

/**
 * `AuthProvider`：登录链路上唯一同时碰"口令校验结果"与"签发 token"的地方。
 *
 * 三条要钉的安全性质：
 * 1. **口令（scrypt 哈希）绝不进入 `req.user`，也绝不出现在登录响应里。**
 *    `validateUser` 把 `password` 从结果里摘掉；`login()` 返回的 `user` 对象是**手工挑字段**构造的。
 *    这两处只要有一处漏了，管理员的 scrypt 哈希就会被发给浏览器（而它能被离线爆破）。
 * 2. **token 必须先落库再返回响应**（`await createToken`）。
 *    本轮之前这里是 fire-and-forget：`tokenModel.create(...)` 没有 await，而吊销走
 *    `setTimeout(...disableAll(), 1000)` ⇒ "登录后立刻改密码/走恢复"时，
 *    那条 create 可能晚于 disableAll 落库，于是**新 token 不会被吊销**（旧的都失效了它还活着）。
 *    修法是 await，性质是"login() resolve 时 createToken 已经完成"。
 * 3. **payload 的形状**：`sub` 决定 jwt.strategy 走管理员分支还是协作者分支
 *    （`sub === 0` 是管理员），`permissions` 是协作者的权限来源之一
 *    （⚠️ 但 jwt.strategy 的协作者分支会用数据库当前值覆盖它，所以 token 里的旧权限不会生效）。
 *    mongoose 文档（有 `_doc`）与普通对象两种输入都要得到同样的 payload。
 */

function makeProvider(deps: { user?: any; token?: any; createToken?: any } = {}) {
  const provider = Object.create(AuthProvider.prototype) as any;
  const created: any[] = [];
  const validateUser = jest.fn(async () => deps.user);
  const createToken =
    deps.createToken ||
    jest.fn(async (payload: any) => {
      created.push(payload);
      return 'signed.jwt.token';
    });
  provider.usersService = { validateUser };
  provider.tokenProvider = { createToken };
  return { provider, validateUser, createToken, created };
}

describe('AuthProvider.validateUser：口令哈希不许外泄', () => {
  it('成功时返回用户对象，但**不含 password 字段**', async () => {
    const { provider } = makeProvider({
      user: { id: 0, name: 'admin', nickname: 'n', password: 'scrypt$N$r$p$salt$hash', salt: 's' },
    });
    const r = await provider.validateUser('admin', 'pw');
    expect(r).toBeTruthy();
    expect(r.id).toBe(0);
    expect(r.name).toBe('admin');
    expect('password' in r).toBe(false);
    expect(JSON.stringify(r)).not.toContain('scrypt$');
  });

  it('其余字段（含 salt / nickname / permissions）原样保留 —— 只摘 password，不要顺手摘掉鉴权要用的字段', async () => {
    const { provider } = makeProvider({
      user: { id: 3, name: 'c', nickname: 'nn', salt: 'ss', permissions: ['article:update'], password: 'x' },
    });
    const r = await provider.validateUser('c', 'pw');
    expect(r).toMatchObject({ id: 3, name: 'c', nickname: 'nn', salt: 'ss', permissions: ['article:update'] });
    expect('password' in r).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['false', false],
  ] as const)('user provider 返回 %s ⇒ 返回 null（而不是把 falsy 原样透传）', async (_l, falsy) => {
    const { provider } = makeProvider({ user: falsy });
    expect(await provider.validateUser('u', 'p')).toBeNull();
  });

  it('负向对照：上面那把"不含 password"的尺子真的能量出泄漏', () => {
    const leaky = { id: 0, name: 'a', password: 'scrypt$secret' };
    expect('password' in leaky).toBe(true);
    expect(JSON.stringify(leaky)).toContain('scrypt$');
  });
});

describe('AuthProvider.login：token 必须先落库，响应才返回', () => {
  it('🔴 login() resolve 时 createToken 已经完成（不是 fire-and-forget）', async () => {
    const order: string[] = [];
    const createToken = jest.fn(async (_payload: any) => {
      // 模拟"写库比返回响应慢"：晚一个宏任务才完成
      await new Promise((r) => setTimeout(r, 5));
      order.push('createToken-resolved');
      return 'signed.jwt.token';
    });
    const { provider } = makeProvider({ user: { id: 0, name: 'admin' }, createToken });
    const r = await provider.login({ id: 0, name: 'admin', type: 'admin', nickname: 'n' });
    order.push('login-resolved');
    expect(order).toEqual(['createToken-resolved', 'login-resolved']);
    expect(r.token).toBe('signed.jwt.token');
  });

  it('⚠️ 为什么上一条重要：token 未落库就返回 ⇒ "登录后立刻改密码"时它可能躲过 disableAll', async () => {
    // 这条不测实现，只把因果写进断言：createToken 必须在返回前被调用过（不是"最终会被调用"）
    let calledBeforeReturn = false;
    const createToken = jest.fn(async () => {
      calledBeforeReturn = true;
      return 't';
    });
    const { provider } = makeProvider({ createToken });
    await provider.login({ id: 0, name: 'admin' });
    expect(calledBeforeReturn).toBe(true);
    expect(createToken).toHaveBeenCalledTimes(1);
  });

  it('登录响应里的 user 对象**不含 password**，且字段是手工挑的（不是整份用户文档）', async () => {
    const { provider } = makeProvider({
      user: { id: 0, name: 'admin' },
    });
    const r = await provider.login({
      id: 0,
      name: 'admin',
      nickname: 'n',
      type: 'admin',
      permissions: ['all'],
      password: 'scrypt$N$r$p$salt$hash',
      salt: 's',
    });
    expect(Object.keys(r.user).sort()).toEqual(['id', 'name', 'nickname', 'permissions', 'type']);
    expect('password' in r.user).toBe(false);
    expect('salt' in r.user).toBe(false);
    expect(JSON.stringify(r)).not.toContain('scrypt$');
  });

  it('payload 形状：sub 来自 user.id、username 来自 user.name，并带上 type/nickname/permissions', async () => {
    const { provider, created } = makeProvider({ user: { id: 0 } });
    await provider.login({ id: 0, name: 'admin', type: 'admin', nickname: 'n', permissions: ['all'] });
    expect(created[0]).toMatchObject({ sub: 0, username: 'admin', type: 'admin', nickname: 'n', permissions: ['all'] });
  });

  it('🔴 sub 必须**严格**是 0 才代表管理员：空串/数组/undefined 都不能变成 0', async () => {
    // jwt.strategy 用 `payload.sub != 0`（松散）选分支，而 AccessGuard 用 isSuperAdminUser()（严格）。
    // 签发侧如果让 sub 变成 ''/[]/undefined，两侧就会对同一个 token 得出不同身份 ⇒
    // 这条断言钉住"签发侧只会写 user.id 的原值"，不做任何宽松转换。
    const { provider, created } = makeProvider({ user: { id: 0 } });
    await provider.login({ id: '', name: 'x' });
    await provider.login({ id: [], name: 'x' });
    await provider.login({ id: undefined, name: 'x' });
    expect(created.map((c: any) => c.sub)).toEqual(['', [], undefined]);
    // 负向对照：这些值在松散比较下都 == 0（正是危险所在）。
    // ⚠️ 用一个 any 参数的助手来写，直接写 `'' == 0` 会被 TS2367 判成"无意义比较"而编译失败 ——
    //    而这恰恰说明类型系统也认为这种比较不该出现，可 jwt.strategy 里就是有一处。
    const looseEqualsZero = (v: any) => v == 0; // eslint-disable-line eqeqeq
    expect(looseEqualsZero('')).toBe(true);
    expect(looseEqualsZero([])).toBe(true);
    expect(looseEqualsZero('0')).toBe(true);
    expect(looseEqualsZero(' 0 ')).toBe(true);
    expect(looseEqualsZero(false)).toBe(true);
    // ⚠️ **null 与 undefined 是仅有的两个"松散比较下也不等于 0"的常见值**
    //    （`null == 0` 为 false —— null 只与 undefined 松散相等）。
    //    这正好解释了 jwt.strategy 的行为：payload 缺 `sub` 时 `undefined != 0` 为 **true**
    //    ⇒ 走**协作者**分支，而那一支会把 undefined 当 id 去查库
    //    （`findOne({ id: undefined, type: 'collaborator' })` ⇒ Mongoose 丢掉 undefined 条件
    //     ⇒ 返回**任意一个**协作者，其 permissions 被赋给本次请求的身份）。
    //    该缺陷在 `jwt.strategy.ts` 与 `user.provider.ts` 里，两者都在本 spec 的禁改清单内 ⇒ 只报告不修。
    expect(looseEqualsZero(null)).toBe(false);
    expect(looseEqualsZero(undefined)).toBe(false);
    // 负向对照：这把尺子确实能区分"松散相等"与"严格相等"。
    // ⚠️ 不能直接写 `0 == '0'` —— TS2367 会把两个**字面量**之间的松散比较判成"无意义比较"而编译失败
    //    （这本身是个有用的信号：类型系统也认为这种比较不该出现在代码里，
    //    而 `jwt.strategy.ts:43` 的 `payload.sub != 0` 之所以没被拦住，是因为 `sub` 是 `any`）。
    const strictEqualsZero = (v: any) => v === 0;
    expect(looseEqualsZero('0')).toBe(true);
    expect(strictEqualsZero('0')).toBe(false);
    expect(strictEqualsZero(0)).toBe(true);
  });

  it('mongoose 文档（带 _doc）与普通对象得到同样的 payload（身份取自 _doc）', async () => {
    const { provider, created } = makeProvider({ user: { id: 0 } });
    await provider.login({
      id: 'outer-id-should-be-ignored',
      name: 'outer-name-should-be-ignored',
      _doc: { id: 0, name: 'admin', type: 'admin', nickname: 'n', permissions: ['all'] },
    });
    expect(created[0]).toMatchObject({ sub: 0, username: 'admin', type: 'admin', nickname: 'n' });
    const r = await provider.login({ _doc: { id: 0, name: 'admin' } });
    expect(r.user).toMatchObject({ id: 0, name: 'admin' });
  });

  it('缺失的可选字段落成 undefined 而不是 null/空串（jsonwebtoken 会省略 undefined 声明）', async () => {
    const { provider, created } = makeProvider({ user: { id: 0 } });
    await provider.login({ id: 0, name: 'admin' });
    expect(created[0].type).toBeUndefined();
    expect(created[0].nickname).toBeUndefined();
    expect(created[0].permissions).toBeUndefined();
  });

  it('负向对照：把 await 去掉后，上面"顺序"那条断言必须能抓到', async () => {
    // 模拟 fire-and-forget 的实现（不 await）：login 会先 resolve
    const order: string[] = [];
    // ⚠️ mock 的签名必须带参数：`jest.fn(async () => …)` 会被推断成零参数，
    //    于是 `createToken({sub})` 直接编译失败（TS2554），套件根本跑不起来。
    const createToken = jest.fn(async (_payload: any) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('createToken-resolved');
      return 't';
    });
    // 真正的坏形状：完全不 await（就是本轮之前的 fire-and-forget）
    const reallyBroken = async (user: any) => {
      createToken({ sub: user.id });
      return { token: 't', user };
    };
    await reallyBroken({ id: 0 });
    order.push('login-resolved');
    expect(order).toEqual(['login-resolved']); // ← login 先返回了，token 还没落库
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['login-resolved', 'createToken-resolved']);
  });
});
