import { readFileSync } from 'fs';
import { resolve } from 'path';
import { UnauthorizedException } from '@nestjs/common';
import { isSuperAdminUser } from 'src/types/access/access';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { JwtStrategy } from './jwt.strategy';

/**
 * `JwtStrategy.validate()` 的分支判定：`sub` 缺失/非整数时必须 **401**，而且**根本不去查协作者**。
 *
 * ## 缺陷（本仓库"Mongoose 丢掉 undefined 查询条件"这一族的第 6 例）
 * 原来是 `if (payload.sub != 0)`。JS 里 **`undefined != 0` 与 `null != 0` 都是 true**
 * （`null` 只与 `undefined` 松散相等，与 `0` 不等）⇒ payload **缺 `sub`** 时会掉进协作者分支，
 * 而 `getCollaboratorById(undefined)` 是 `findOne({ id: undefined, type:'collaborator' })`
 * ⇒ id 条件被丢弃 ⇒ 返回**自然顺序里任意一个协作者** ⇒ 本次请求的身份变成
 * `id: undefined` + `name: payload.username` + **那个人的 permissions**。
 * 若那个人恰好是 `['all']`，AccessGuard 会放行除超管专属前缀外的一切。
 *
 * ## 可达性（写测试也要如实，别把"坏库才可达"写成"远程可利用"）
 * 需要一张**本站签发**、payload 里没有 `sub`、且 `tokens` 集合里有记录的令牌。签发侧是
 * `sub: user.id`（`provider/auth/auth.provider.ts:24`），而 `jsonwebtoken` 会省略值为 undefined 的
 * 声明 ⇒ 只有"用户文档缺 `id` 字段"才会签出这种令牌：恢复出字段不全的归档、手工改库、
 * 或历史上"两条 id:0"竞态的清理残留。所以真实性质是"**坏库 ⇒ 权限错乱**"，
 * 与 `jwtStrategyNullAdmin.spec.ts` 钉的"坏库 ⇒ 明确 401"是同一条路径上的姊妹缺陷。
 *
 * ## 为什么断言的是"零调用"而不是"抛了错"
 * 抛错只是症状消失；本体是**那个会退化的查询压根没被执行**。只断言 `rejects.toBeInstanceOf(401)`
 * 的话，一个"先查库、拿到任意协作者、然后再因为别的原因抛 401"的实现同样能过 —— 而那个实现
 * 仍然把别人的 permissions 读进了内存，离泄露只差一行。
 */

/** 用 Object.create 而不是 new：构造函数里 super() 会真的去建一个 passport-jwt Strategy，
 *  而 validate() 用不到它（secretOrKeyProvider 只在验签阶段被 passport 调用）。
 *  与既有 `jwtStrategyNullAdmin.spec.ts` 同款做法。 */
function makeStrategy(opts?: { admin?: any; siteInfo?: any; collaborator?: any }) {
  const strategy = Object.create(JwtStrategy.prototype) as JwtStrategy;
  const getUser = jest.fn(async () => opts?.admin ?? { nickname: '管理员昵称' });
  const getCollaboratorById = jest.fn(async () => opts?.collaborator ?? null);
  const getSiteInfo = jest.fn(async () => opts?.siteInfo ?? { author: '作者名' });
  (strategy as any).userProvider = { getUser, getCollaboratorById };
  (strategy as any).metaProvider = { getSiteInfo };
  return { strategy, getUser, getCollaboratorById, getSiteInfo };
}

describe('JwtStrategy.validate：sub 缺失或不是整数时不得进入协作者分支', () => {
  // ⚠️ 每一条都断言两件事：401 + `getCollaboratorById` **零调用**（后者是本体）。
  it.each([
    ['payload 完全没有 sub', { username: 'x' }],
    ['sub 是 undefined', { sub: undefined, username: 'x' }],
    ['sub 是 null', { sub: null, username: 'x' }],
    ['sub 是字符串 "7"（类型违规，且会被 mongoose cast 成 7 真的匹配上）', { sub: '7', username: 'x' }],
    ['sub 是小数 7.5', { sub: 7.5, username: 'x' }],
    ['sub 是 NaN', { sub: NaN, username: 'x' }],
    ['sub 是 Infinity', { sub: Infinity, username: 'x' }],
    ['sub 是布尔 true（`true != 0` 为 true，旧代码会走协作者分支）', { sub: true, username: 'x' }],
    ['sub 是空对象', { sub: {}, username: 'x' }],
    ['sub 是数组 [0]（`[0] != 0` 为 false ⇒ 旧代码会把它当管理员！）', { sub: [0], username: 'x' }],
  ])('%s ⇒ 401 且 getCollaboratorById 零调用', async (_label, payload) => {
    // 库里放一个 `['all']` 权限的协作者：如果实现真的去查了，它会命中并把 all 带出去，
    // 那么下面"结果里没有 permissions"这条断言就是抓住泄露的那把尺子。
    const { strategy, getCollaboratorById } = makeStrategy({
      collaborator: { permissions: ['all'], nickname: '某个协作者' },
    });
    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(getCollaboratorById).not.toHaveBeenCalled();
  });

  it('401 的文案说清了"令牌缺少有效的用户标识"并给出照做的办法（不是裸 TypeError）', async () => {
    const { strategy } = makeStrategy();
    await expect(strategy.validate({ username: 'x' })).rejects.toThrow(
      /令牌缺少有效的用户标识[\s\S]*sub[\s\S]*(损坏|旧版本)[\s\S]*重新登录/,
    );
  });

  it('泄露方向的断言：坏 sub 的结果里绝不带任何人的 permissions/nickname', async () => {
    const { strategy } = makeStrategy({ collaborator: { permissions: ['all'], nickname: '某个协作者' } });
    // 抛了就取不到返回值，所以这条是对"万一将来有人把 401 改成降级放行"的绊线：
    // 断言 rejects 的同时，用一个不会抛的旁路确认协作者对象从未被读到。
    const spy = jest.fn();
    (strategy as any).userProvider.getCollaboratorById = async (id: unknown) => {
      spy(id);
      return { permissions: ['all'], nickname: '某个协作者' };
    };
    await expect(strategy.validate({ username: 'x' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('JwtStrategy.validate：合法形状不受影响（别把修复做成一刀切）', () => {
  it('sub 是正整数 ⇒ 走协作者分支，权限与昵称照旧带出', async () => {
    const { strategy, getCollaboratorById, getUser } = makeStrategy({
      collaborator: { permissions: ['article:update'], nickname: '协作者甲' },
    });
    const result = await strategy.validate({ sub: 7, username: 'collab' });
    expect(result).toMatchObject({ id: 7, name: 'collab', nickname: '协作者甲', permissions: ['article:update'] });
    expect(getCollaboratorById).toHaveBeenCalledWith(7);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('协作者是负数 id 也照旧放行（本仓库不假定 id 为正；判定只要求是整数）', async () => {
    const { strategy, getCollaboratorById } = makeStrategy({
      collaborator: { permissions: ['all'], nickname: '负数 id 协作者' },
    });
    const result = await strategy.validate({ sub: -3, username: 'c' });
    expect(getCollaboratorById).toHaveBeenCalledWith(-3);
    expect(result.nickname).toBe('负数 id 协作者');
  });

  it('协作者已不存在 ⇒ 仍是既有的 401 文案（本轮没有改这条）', async () => {
    const { strategy } = makeStrategy({ collaborator: null });
    await expect(strategy.validate({ sub: 9, username: 'c' })).rejects.toThrow(/该协作者已不存在/);
  });

  it('sub 是数字 0 ⇒ 走管理员分支，且不查协作者', async () => {
    const { strategy, getUser, getCollaboratorById } = makeStrategy();
    const result = await strategy.validate({ sub: 0, username: 'admin' });
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(getCollaboratorById).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 0, name: 'admin' });
  });

  it('sub 是字面字符串 "0" ⇒ 也走管理员分支（与 AccessGuard 的尺子一致）', async () => {
    const { strategy, getUser, getCollaboratorById } = makeStrategy();
    await strategy.validate({ sub: '0', username: 'admin' });
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(getCollaboratorById).not.toHaveBeenCalled();
  });
});

describe('分支判定与 AccessGuard 用同一把尺子（跨文件一致性，这是本条修复的第三个目的）', () => {
  // ⚠️ 这条是"统一口径"的本体：validate() 选哪一支，必须与下游 AccessGuard 认不认它是超管**完全一致**。
  //    自己写一个 `payload.sub === 0` 会让 `sub:"0"` 在这里走协作者分支、在 AccessGuard 却被判成超管 ——
  //    两处身份判定不一致本身就是缺陷，而且只会以"某条路由莫名放行/莫名 403"的形式暴露。
  const CASES: Array<[string, unknown]> = [
    ['数字 0', 0],
    ['字面字符串 "0"', '0'],
    ['字符串 "00"（能转成 0，但不是 0）', '00'],
    ['字符串 " 0 "（带空白）', ' 0 '],
    ['字符串 "0x0"', '0x0'],
    ['数字 7', 7],
    ['字符串 "7"', '7'],
    ['undefined', undefined],
    ['null', null],
    ['布尔 false', false],
    ['数组 [0]', [0]],
    ['空对象', {}],
    ['NaN', NaN],
  ];

  it.each(CASES)('sub=%s ⇒ validate 走的分支 == isSuperAdminUser 的判定', async (_label, sub) => {
    const { strategy, getUser, getCollaboratorById } = makeStrategy({
      admin: { nickname: 'A' },
      collaborator: { permissions: ['all'], nickname: 'C' },
    });
    // 管理员与协作者都存在 ⇒ 不会因为"账号不存在"而抛，分支由"调了哪个 spy"唯一确定。
    // ⚠️ 但 sub 不是整数时**会**抛 401（这正是本轮加的校验），所以要把抛与不抛都纳入判据。
    let threw = false;
    try {
      await strategy.validate({ sub, username: 'u' } as any);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(UnauthorizedException);
    }
    const tookAdminBranch = getUser.mock.calls.length === 1;
    const tookCollabBranch = getCollaboratorById.mock.calls.length === 1;

    // ① 走管理员分支 ⟺ AccessGuard 认它是超管（这条就是"同一把尺子"）
    expect(tookAdminBranch).toBe(isSuperAdminUser({ id: sub }));
    // ② 不可能两支都走
    expect(tookAdminBranch && tookCollabBranch).toBe(false);
    if (!tookAdminBranch) {
      // ③ 非超管时只有两种合法结局：查了协作者（sub 是整数），或 401（sub 不是整数）——必居其一
      expect(tookCollabBranch || threw).toBe(true);
      expect(tookCollabBranch && threw).toBe(false);
      // ④ 而且"查了协作者"当且仅当 sub 是整数：这条把"校验在查库之前"钉成了跨用例的不变量
      expect(tookCollabBranch).toBe(typeof sub === 'number' && Number.isInteger(sub));
    }
  });

  it('⚠️ 上面那张表里必须有"是超管"和"不是超管"两类，否则一致性断言恒真', () => {
    const verdicts = CASES.map(([, sub]) => isSuperAdminUser({ id: sub }));
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
    // 尺子有效性：`[0] != 0` 在旧代码里为 false（会被当管理员），而 isSuperAdminUser 判它不是超管 ⇒
    // 这一格正是"松散比较"与"严格判定"分歧的地方，必须留在表里。
    expect(isSuperAdminUser({ id: [0] })).toBe(false);
    // 记录缺陷本身的形状（用 any 包一层，否则 TS 会因"两个类型没有重叠"拒绝这个比较）：
    const legacyBranchCheck = (v: any) => v != 0; // 旧代码：`if (payload.sub != 0)` 走协作者分支
    expect(legacyBranchCheck([0])).toBe(false); // ⇒ 旧代码把 [0] 当成管理员
    expect(legacyBranchCheck(undefined)).toBe(true); // ⇒ 旧代码把"缺 sub"送进协作者分支（本条修复的起因）
    expect(legacyBranchCheck(null)).toBe(true);
  });
});

describe('源码级钉子（剥注释后断言）', () => {
  const RAW = readFileSync(resolve(__dirname, 'jwt.strategy.ts'), 'utf-8');
  const SRC = stripCommentsForAnchor(RAW);

  it('旧的松散比较 `payload.sub != 0` 不许回来', () => {
    expect(SRC).not.toMatch(/payload\.sub\s*!=\s*0/);
    expect(SRC).not.toMatch(/payload\?\.sub\s*!=\s*0/);
    // 空转反证：同一把尺子在**未剥注释**的原文上必须能命中 —— 解释性注释里必然写着旧形状，
    // 不剥注释就会永远红（本仓库已踩 9 次这个坑）。
    expect(RAW).toMatch(/payload\.sub\s*!=\s*0/);
    expect(stripCommentsForAnchor('// if (payload.sub != 0) {\nconst a = 1;')).not.toContain('payload.sub != 0');
  });

  it('分支判定调用的是 isSuperAdminUser，且传的是 payload 的 sub（不是别的字段）', () => {
    // ⚠️ 断言**调用形状**而不是"符号出现"：只写 `expect(SRC).toContain('isSuperAdminUser')` 的话，
    //    一行 import 就能让它通过（本仓库踩过"符号出现≠调用形状"）。
    expect(SRC).toMatch(/if \(isSuperAdminUser\(\{ id: payload\?\.sub \}\)\) \{/);
  });

  it('协作者分支在查库之前校验 sub 是整数（顺序是本条修复的关键）', () => {
    const iCheck = SRC.indexOf("typeof sub !== 'number' || !Number.isInteger(sub)");
    const iQuery = SRC.indexOf('getCollaboratorById(sub)');
    expect(iCheck).toBeGreaterThan(-1);
    expect(iQuery).toBeGreaterThan(-1);
    // 校验必须在查询**之前**；只断言两者都存在的话，把校验挪到查询之后就仍然绿。
    expect(iCheck).toBeLessThan(iQuery);
    // 负向对照：这把"先后"尺子量得到坏形状。
    const bad = 'const u = await p.getCollaboratorById(sub);\nif (typeof sub !== "number") throw e;';
    expect(bad.indexOf('typeof sub !== "number"')).toBeGreaterThan(bad.indexOf('getCollaboratorById(sub)'));
  });
});
