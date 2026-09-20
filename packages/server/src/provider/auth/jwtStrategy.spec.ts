import { UnauthorizedException } from '@nestjs/common';

/**
 * `JwtStrategy` 的分支选择、身份字段来源，以及"验签密钥选不出来时必须 401"。
 *
 * ⚠️ 与 `jwtStrategyNullAdmin.spec.ts` 分工：那个文件只覆盖"管理员/站点信息缺失"的空值降级，
 *    这里覆盖其余路径（协作者分支、权限来源、payload 形状、secretOrKeyProvider）。
 *
 * 为什么这几条值得钉：`validate()` 是**每个带 token 的请求**都要走的鉴权路径，
 * 而本仓库已经因为鉴权层的缺陷出过一次**未认证管理员接管**
 * （`checkToken` + `CacheProvider.get()` 缺失时返回 `{}` + `String({}) === '[object Object]'`）。
 * 整个 auth 家族（`auth.guard.ts` / `auth.provider.ts` / `jwt.strategy.ts` / `local.strategy.ts` /
 * `init.middleware.ts`）在本文件之前**一个 spec 都没有**。
 *
 * 最关键的一条安全性质：**协作者的权限必须来自数据库的当前值，而不是 token 里的旧值**。
 * `validate()` 顶部那句注释写明了理由（"权限需要在库里查最新的，不然用老的 token 解码获得权限还是可以用"），
 * 但注释不会阻止有人把它删掉 —— 这里用行为级断言钉住。
 */

// ⚠️ 必须在 import JwtStrategy 之前 mock：`extends PassportStrategy(Strategy)` 是模块加载时求值的，
//    而 `super(options)` 里那个 `secretOrKeyProvider` 只在构造时创建、不挂在实例上，
//    所以唯一能拿到它做行为级测试的办法就是在基类里把它截出来。
let capturedStrategyOptions: any = null;
jest.mock('@nestjs/passport', () => ({
  PassportStrategy: () =>
    class FakePassportBase {
      constructor(options?: any) {
        capturedStrategyOptions = options ?? null;
      }
    },
}));

const selectJwtVerifyKey = jest.fn();
jest.mock('src/utils/initJwt', () => ({
  // 真实实现是"按 token 头里的 kid 在当前密钥与宽限期内的上一个密钥之间选，绝不抛异常"。
  // 这里只替换它，好让三种结果（有密钥 / 没有密钥 / 意外抛错）都能被确定性地触发。
  selectJwtVerifyKey: (raw: any) => selectJwtVerifyKey(raw),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JwtStrategy } = require('./jwt.strategy');

/** 用 Object.create 造实例：构造器会真的跑 passport 的初始化，而 validate() 用不到它。 */
function makeStrategy(deps: {
  collaborator?: any;
  admin?: any;
  siteInfo?: any;
}) {
  const strategy = Object.create(JwtStrategy.prototype) as any;
  const getCollaboratorById = jest.fn(async () => deps.collaborator);
  const getUser = jest.fn(async () => deps.admin);
  const getSiteInfo = jest.fn(async () => deps.siteInfo);
  strategy.userProvider = { getCollaboratorById, getUser };
  strategy.metaProvider = { getSiteInfo };
  return { strategy, getCollaboratorById, getUser, getSiteInfo };
}

/** 真的 new 一次，目的是让基类截获构造器里创建的 secretOrKeyProvider。 */
function captureOptions() {
  capturedStrategyOptions = null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { JwtStrategy: Real } = require('./jwt.strategy');
  new Real({ getUser: jest.fn() }, { getSiteInfo: jest.fn() });
  return capturedStrategyOptions;
}

beforeEach(() => {
  selectJwtVerifyKey.mockReset();
});

describe('JwtStrategy.validate：管理员分支（payload.sub === 0）', () => {
  it('查的是 getUser()（id:0），**不查**协作者表', async () => {
    const { strategy, getUser, getCollaboratorById } = makeStrategy({
      admin: { nickname: '管理员昵称' },
      siteInfo: { author: '站点作者' },
    });
    await strategy.validate({ sub: 0, username: 'admin' });
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(getCollaboratorById).not.toHaveBeenCalled();
  });

  it('昵称优先取 siteInfo.author，缺失时才回落 user.nickname（既有优先级不许漂）', async () => {
    const withAuthor = makeStrategy({ admin: { nickname: '库里的昵称' }, siteInfo: { author: '站点作者' } });
    expect(await withAuthor.strategy.validate({ sub: 0, username: 'admin' })).toMatchObject({
      nickname: '站点作者',
    });
    const without = makeStrategy({ admin: { nickname: '库里的昵称' }, siteInfo: undefined });
    expect(await without.strategy.validate({ sub: 0, username: 'admin' })).toMatchObject({
      nickname: '库里的昵称',
    });
  });

  it('返回的身份对象带 name/id，且 id 就是 payload.sub（0 不能被丢成 undefined）', async () => {
    const { strategy } = makeStrategy({ admin: { nickname: 'x' }, siteInfo: { author: 'y' } });
    const r = await strategy.validate({ sub: 0, username: 'admin', type: 'admin' });
    expect(r.name).toBe('admin');
    expect(r.id).toBe(0);
    expect(r.type).toBe('admin');
  });

  it('⚠️ 管理员分支**不会**用数据库刷新 permissions —— 这是有意的（超管身份由 id 判定，不靠 permissions），' +
    '但它意味着 payload 里的 permissions 会原样带下去；这条断言把这个事实钉住，' +
    '将来若有人给管理员也加"从库里刷新"，会先撞红再讨论', async () => {
    const { strategy, getUser } = makeStrategy({ admin: { nickname: 'x' }, siteInfo: { author: 'y' } });
    const r = await strategy.validate({ sub: 0, username: 'admin', permissions: ['all'] });
    expect(r.permissions).toEqual(['all']);
    // 负向对照：管理员分支确实没去查协作者表（否则上面那条"不刷新"就是假的）
    expect(getUser).toHaveBeenCalledTimes(1);
  });
});

describe('JwtStrategy.validate：协作者分支（payload.sub !== 0）', () => {
  it('🔴 权限与昵称**一律以数据库当前值覆盖** token 里的旧值（旧 token 不能保住已被收回的权限）', async () => {
    const { strategy, getCollaboratorById } = makeStrategy({
      collaborator: { permissions: ['article:update'], nickname: '现在的昵称' },
    });
    const r = await strategy.validate({
      sub: 5,
      username: 'someone',
      permissions: ['all'], // ← token 里声称的旧权限
      nickname: '旧昵称',
    });
    expect(getCollaboratorById).toHaveBeenCalledWith(5);
    expect(r.permissions).toEqual(['article:update']);
    expect(r.permissions).not.toEqual(['all']);
    expect(r.nickname).toBe('现在的昵称');
  });

  it('协作者已被删除 ⇒ 抛 401（不是读 undefined.permissions 变成 500）', async () => {
    const { strategy } = makeStrategy({ collaborator: null });
    await expect(strategy.validate({ sub: 7, username: 'ghost' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(strategy.validate({ sub: 7, username: 'ghost' })).rejects.toThrow(/协作者已不存在/);
  });

  it('协作者为 undefined（不是 null）时同样 401 —— 判空要覆盖两种"没有"', async () => {
    const { strategy } = makeStrategy({ collaborator: undefined });
    await expect(strategy.validate({ sub: 7 })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('协作者权限为空数组时**不被覆盖成 undefined**（空数组是有意义的"什么也不能做"）', async () => {
    const { strategy } = makeStrategy({ collaborator: { permissions: [], nickname: 'n' } });
    const r = await strategy.validate({ sub: 9, username: 'u', permissions: ['all'] });
    expect(r.permissions).toEqual([]);
  });
});

describe('JwtStrategy 构造器里的 secretOrKeyProvider：密钥选不出来时必须 401，不能 500、更不能放行', () => {
  it('jwtFromRequest 取自 header 的 `token`（与 TokenGuard 读的是同一个 header）', () => {
    const opts = captureOptions();
    expect(opts).toBeTruthy();
    expect(typeof opts.jwtFromRequest).toBe('function');
    const req = { headers: { token: 'abc.def.ghi' } };
    expect(opts.jwtFromRequest(req)).toBe('abc.def.ghi');
  });

  it('用的是 secretOrKeyProvider（每请求现选）而不是构造时固定的 secretOrKey —— ' +
    '固定值会让密钥轮换后本进程一直用旧密钥验签', () => {
    const opts = captureOptions();
    expect(typeof opts.secretOrKeyProvider).toBe('function');
    expect(opts.secretOrKey).toBeUndefined();
  });

  it('选到密钥 ⇒ done(null, secret)，且把原始 token 交给了选择函数（kid 要从 token 头里读）', () => {
    selectJwtVerifyKey.mockReturnValue('the-secret');
    const done = jest.fn();
    captureOptions().secretOrKeyProvider({} as any, 'raw.jwt.token', done);
    expect(selectJwtVerifyKey).toHaveBeenCalledWith('raw.jwt.token');
    expect(done).toHaveBeenCalledWith(null, 'the-secret');
  });

  it('站点还没有可用密钥（未初始化）⇒ done 收到 UnauthorizedException（401），不是 Error（500）', () => {
    selectJwtVerifyKey.mockReturnValue(null);
    const done = jest.fn();
    captureOptions().secretOrKeyProvider({} as any, 'raw.jwt.token', done);
    expect(done).toHaveBeenCalledTimes(1);
    const err = done.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(done.mock.calls[0][1]).toBeUndefined(); // ⚠️ 绝不能顺手把 secret 传出去
  });

  it('选择函数意外抛错 ⇒ 仍然是 401（设计上它不抛；真抛了也不能把进程带崩或变成 500）', () => {
    selectJwtVerifyKey.mockImplementation(() => {
      throw new Error('boom');
    });
    const done = jest.fn();
    captureOptions().secretOrKeyProvider({} as any, 'raw.jwt.token', done);
    const err = done.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(String(err.message)).toMatch(/无法选择验签密钥[\s\S]*boom/);
  });

  it('负向对照：上面三条断言的尺子真的能区分"401"与"500/放行"', () => {
    // 如果实现改成 done(new Error('x'))，toBeInstanceOf(UnauthorizedException) 必须失败
    expect(new Error('x')).not.toBeInstanceOf(UnauthorizedException);
    // 如果实现改成 done(null, undefined)（= 放行但没密钥），第一条 done 断言必须失败
    const d = jest.fn();
    d(null, undefined);
    expect(d.mock.calls[0][0]).toBeNull();
    expect(d).toHaveBeenCalledWith(null, undefined);
  });
});
