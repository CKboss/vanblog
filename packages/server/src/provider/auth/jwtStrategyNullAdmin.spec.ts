import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

/**
 * `JwtStrategy.validate()` 在"库里没有 id:0 管理员"时必须给 **401**，不是 500。
 *
 * 为什么这条值得单独钉：`validate()` 是**每个带 token 的请求**都要走的鉴权路径。
 * 以前 `payload.sub == 0` 那一支直接读 `user.nickname`，而 `getUser()` 是
 * `userModel.findOne({ id: 0 })` —— 库里没有这条文档时 resolve 成 `null` ⇒ TypeError ⇒ 500。
 * 触发条件不是臆想的：恢复出一份坏库/空库、`users` 集合被清空、或历史上"两条 id:0"竞态的
 * 残留被清掉，都会走到这里。后果是**整个后台变成一片 500**，而调用方会以为"服务端坏了"
 * 并重试；401 才是"你的凭据不再有效"这个真相。
 *
 * ⚠️ 同一行还有第二处解引用：`siteInfo.author`，而 `getSiteInfo()` 在 metas 没有 siteInfo 时
 * `return raw`（即 undefined）。两处一起修、一起钉。
 *
 * 这个家族（`auth.guard.ts` / `auth.provider.ts` / `jwt.strategy.ts` / `local.strategy.ts` /
 * `init.middleware.ts`）此前**一个 spec 都没有**；本文件只覆盖 validate 的空值路径，
 * 不是给整个家族补齐测试。
 */

/** 用 Object.create 而不是 new：构造函数里 super() 会真的去建一个 passport-jwt Strategy，
 *  而 validate() 用不到它（secretOrKeyProvider 只在验签阶段被 passport 调用）。 */
function makeStrategy(user: any, siteInfo: any) {
  const strategy = Object.create(JwtStrategy.prototype) as JwtStrategy;
  const getUser = jest.fn(async () => user);
  const getSiteInfo = jest.fn(async () => siteInfo);
  (strategy as any).userProvider = { getUser };
  (strategy as any).metaProvider = { getSiteInfo };
  return { strategy, getUser, getSiteInfo };
}

describe('JwtStrategy.validate：管理员与站点信息缺失时的降级', () => {
  it('库里没有 id:0 的管理员 ⇒ 抛 401（不是 TypeError/500）', async () => {
    const { strategy } = makeStrategy(null, { author: '作者名' });
    await expect(strategy.validate({ sub: 0, username: 'admin' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('401 的消息说清了什么坏了、以及可能的原因（可照做，不是裸 TypeError）', async () => {
    const { strategy } = makeStrategy(null, { author: 'x' });
    await expect(strategy.validate({ sub: 0, username: 'admin' })).rejects.toThrow(
      /管理员账号不存在[\s\S]*id=0[\s\S]*(损坏|空|坏)/,
    );
  });

  it('user 为 undefined（不是 null）时同样 401 —— 判空要覆盖两种"没有"', async () => {
    const { strategy } = makeStrategy(undefined, { author: 'x' });
    await expect(strategy.validate({ sub: 0, username: 'admin' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('siteInfo 缺失时**不崩**，昵称回落到 user.nickname', async () => {
    const { strategy } = makeStrategy({ nickname: '管理员昵称' }, undefined);
    const result = await strategy.validate({ sub: 0, username: 'admin' });
    expect(result).toMatchObject({ id: 0, name: 'admin', nickname: '管理员昵称' });
  });

  it('siteInfo 存在但没有 author 字段时也不崩（`siteInfo?.author` 为 undefined ⇒ 回落）', async () => {
    const { strategy } = makeStrategy({ nickname: '昵称B' }, {});
    const result = await strategy.validate({ sub: 0, username: 'admin' });
    expect(result.nickname).toBe('昵称B');
  });

  it('正常情况：作者名优先于 user.nickname（既有语义不变）', async () => {
    const { strategy } = makeStrategy({ nickname: '昵称C' }, { author: '作者C' });
    const result = await strategy.validate({ sub: 0, username: 'admin' });
    expect(result.nickname).toBe('作者C');
  });

  it('协作者分支（sub != 0）不受影响：协作者不存在仍是 401，存在则带出权限', async () => {
    const { strategy: missing } = makeStrategy(null, { author: 'x' });
    (missing as any).userProvider = { getCollaboratorById: jest.fn(async () => null) };
    await expect(missing.validate({ sub: 7, username: 'collab' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const { strategy: ok } = makeStrategy(null, { author: 'x' });
    (ok as any).userProvider = {
      getCollaboratorById: jest.fn(async () => ({ permissions: ['all'], nickname: '协作者' })),
    };
    const result = await ok.validate({ sub: 7, username: 'collab' });
    expect(result).toMatchObject({ id: 7, nickname: '协作者', permissions: ['all'] });
  });

  it('管理员分支根本不去查协作者（判空发生在正确的分支里）', async () => {
    const getCollaboratorById = jest.fn(async () => ({ permissions: ['all'] }));
    const strategy = Object.create(JwtStrategy.prototype) as JwtStrategy;
    (strategy as any).userProvider = { getUser: jest.fn(async () => null), getCollaboratorById };
    (strategy as any).metaProvider = { getSiteInfo: jest.fn(async () => ({ author: 'x' })) };
    await expect(strategy.validate({ sub: 0, username: 'admin' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(getCollaboratorById).not.toHaveBeenCalled();
  });
});
