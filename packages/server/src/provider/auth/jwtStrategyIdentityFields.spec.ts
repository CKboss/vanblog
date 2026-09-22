import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { JwtStrategy } from './jwt.strategy';

/**
 * `JwtStrategy.validate()` 返回的 user 对象里，**权威身份字段不许被 payload 覆盖**。
 *
 * ## 缺陷形状（2026-09-22 修，此前是潜在的静默提权）
 * 原来是 `return { name: payload.username, id: payload.sub, ...moreDto }`，而 `moreDto = { ...payload }`
 * ⇒ **展开在最后，payload 里若含 `id` 或 `name` 就会覆盖前面那两个权威值**。
 * 而下游 `AccessGuard` 判超管用 `isSuperAdminUser(user)`，它认 `user.id === 0` **或字面字符串 `"0"`**
 * ⇒ 🔴 **一张 payload 带 `id: 0` 的令牌会被判成超管**。
 *
 * ## 可达性（如实写，别把"潜在"写成"漏洞"）
 * **当前不可利用**，而且是**穷举核实过**的：全仓只有两处真的签 JWT ——
 * `provider/token/token.provider.ts:61`（API token，payload `{ sub, username, role }`）与
 * `:83` 的 `createToken`（**全仓唯一调用方**是 `provider/auth/auth.provider.ts:33`，
 * payload `{ username, sub, type, nickname, permissions }`）⇒ **都不含 `id`/`name`**；
 * `utils/backupSigning.ts` 里的 `.sign(` 是 `crypto.sign`（归档签名），与 JWT 无关。
 * 而且令牌是**本站签名**的，攻击者无法自行注入 payload 字段。
 * ⇒ 所以本次修复**行为逐字节不变**（下面有一条断言专门证明这一点），
 * 收益是把"**未来某条新签发路径往 payload 放了 `id`**"从**静默提权成超管**变成**不可能**。
 *
 * ## 为什么这条性质值得单独钉住
 * 它与本仓库那条"守卫把死代码冻在原地"是镜像关系：这里没有活的缺陷，
 * 但**代码的形状本身就是陷阱** —— 一行 spread 的顺序决定了身份字段能不能被覆盖，
 * 而任何既有测试都观察不到（因为现有 payload 里没有 `id`/`name`）。
 * 🔴 没有这条守卫，将来加一条签发路径时不会有任何东西变红。
 */

/** 用 Object.create 而不是 new：构造函数里 super() 会真的去建一个 passport-jwt Strategy，
 *  而 validate() 用不到它。与既有 `jwtStrategySubValidation.spec.ts` 同款做法。
 *  ⚠️ 注意 Object.create 既不跑构造函数也不跑类字段初始化器，所以依赖注入的字段要手工赋。 */
function makeStrategy(opts?: { admin?: any; siteInfo?: any; collaborator?: any }) {
  const strategy = Object.create(JwtStrategy.prototype) as JwtStrategy;
  const getUser = jest.fn(async () => opts?.admin ?? { nickname: '管理员昵称' });
  const getCollaboratorById = jest.fn(async () => opts?.collaborator ?? null);
  const getSiteInfo = jest.fn(async () => opts?.siteInfo ?? { author: '作者名' });
  (strategy as any).userProvider = { getUser, getCollaboratorById };
  (strategy as any).metaProvider = { getSiteInfo };
  return { strategy, getUser, getCollaboratorById, getSiteInfo };
}

/**
 * 🔴 修复前那个顺序的**参考实现**，用来证明"本次改动对现有 payload 形状行为逐字节不变"。
 * ⚠️ 它只在这里作为对照存在，不是产品代码的复刻漂移风险点：
 * 下面那条断言同时钉住"两者对现有形状一致"与"两者对含 id/name 的 payload **不一致**"
 * ⇒ 如果这份参考实现写错了（例如顺序抄反），第二条断言会红。
 */
function oldOrderReference(payload: any, extra: Record<string, any>) {
  const moreDto = { ...payload, ...extra };
  return { name: payload.username, id: payload.sub, ...moreDto };
}

function newOrderReference(payload: any, extra: Record<string, any>) {
  const moreDto = { ...payload, ...extra };
  return { ...moreDto, name: payload.username, id: payload.sub };
}

describe('JwtStrategy.validate：payload 不得覆盖权威身份字段（id / name）', () => {
  // 🔴 超管分支：payload 带 `id: 0` 时，返回的 id 必须仍是权威的 payload.sub。
  it('🔴 超管分支：payload 里塞 id/name 也不会改变返回的权威身份', async () => {
    const { strategy } = makeStrategy({ admin: { nickname: '真管理员' }, siteInfo: { author: '站主' } });
    // sub: 0 ⇒ 走超管分支；同时恶意塞入 id 与 name
    const user = await (strategy as any).validate({
      sub: 0,
      username: '真用户名',
      id: 999,
      name: '冒名者',
    });
    expect(user.id).toBe(0); // 🔴 权威值，不是 999
    expect(user.name).toBe('真用户名'); // 🔴 权威值，不是 '冒名者'
  });

  it('🔴 反向：协作者分支里 payload 塞 id:0 也**不能**把自己变成超管', async () => {
    const { strategy } = makeStrategy({
      collaborator: { id: 7, nickname: '协作者昵称', permissions: ['article:update'] },
    });
    const user = await (strategy as any).validate({
      sub: 7,
      username: '协作者',
      id: 0, // 🔴 若被覆盖，下游 isSuperAdminUser 会判成超管
      name: '冒名者',
    });
    expect(user.id).toBe(7); // 🔴 仍然是协作者自己的 id
    expect(user.name).toBe('协作者');
    // ⚠️ 并且它**确实**不是超管（用下游那把尺子判，而不是自己再写一个 === 0）
    const { isSuperAdminUser } = require('src/types/access/access');
    expect(isSuperAdminUser(user)).toBe(false);
  });

  it('⚠️ 协作者分支**故意**覆盖的 permissions / nickname 仍然生效（修复没有连带改掉它们）', async () => {
    const { strategy } = makeStrategy({
      collaborator: { id: 7, nickname: '库里的昵称', permissions: ['article:update', 'comment:read'] },
    });
    const user = await (strategy as any).validate({
      sub: 7,
      username: 'u',
      // payload 里也带这两个字段（旧令牌可能有），但**库里的值必须赢**
      permissions: ['all'],
      nickname: 'payload 里的旧昵称',
    });
    expect(user.permissions).toEqual(['article:update', 'comment:read']); // 🔴 库里的值，不是 payload 的 ['all']
    expect(user.nickname).toBe('库里的昵称');
  });

  it('⚠️ 超管分支的 nickname 取站点作者名（回退到用户昵称），修复没有改掉这条', async () => {
    const withAuthor = makeStrategy({ admin: { nickname: '管理员昵称' }, siteInfo: { author: '站主' } });
    expect((await (withAuthor.strategy as any).validate({ sub: 0, username: 'u' })).nickname).toBe('站主');
    const noAuthor = makeStrategy({ admin: { nickname: '管理员昵称' }, siteInfo: {} });
    expect((await (noAuthor.strategy as any).validate({ sub: 0, username: 'u' })).nickname).toBe('管理员昵称');
  });

  it('🔴 零回归证明：对**穷举核实过的两种真实 payload 形状**，新旧顺序返回的对象逐字段相同', () => {
    // 这两条就是全仓仅有的两个签发点产出的 payload 形状（见文件头）。
    const realShapes: any[] = [
      { sub: 0, username: 'admin', role: 'admin' }, // token.provider.ts:61（API token）
      { sub: 0, username: 'admin', type: 'admin', nickname: '昵称', permissions: [] }, // auth.provider.ts:33
      { sub: 7, username: 'co', type: 'collaborator', nickname: '协作者', permissions: ['all'] },
    ];
    for (const payload of realShapes) {
      const extra = payload.sub === 0 ? { nickname: '站主' } : { permissions: ['all'], nickname: '库昵称' };
      expect(newOrderReference(payload, extra)).toEqual(oldOrderReference(payload, extra));
    }
  });

  it('🔴 尺子有效性：上面那份参考实现没抄错 —— 对**含 id 的 payload**，新旧顺序确实不同', () => {
    const hostile = { sub: 7, username: 'u', id: 0, name: 'x' };
    const before = oldOrderReference(hostile, {});
    const after = newOrderReference(hostile, {});
    expect(before.id).toBe(0); // 旧顺序：被 payload 覆盖 ⇒ 会被判成超管
    expect(after.id).toBe(7); // 新顺序：权威值赢
    expect(before).not.toEqual(after);
    // ⚠️ 反空转：这条断言本身必须真的在比较两个不同的对象
    expect(Object.keys(before).sort()).toEqual(Object.keys(after).sort());
  });
});

describe('源码级：spread 必须在权威字段之前（防止有人把顺序改回去）', () => {
  const SRC = stripCommentsForAnchor(readFileSync(resolve(__dirname, 'jwt.strategy.ts'), 'utf-8'));

  it('🔴 返回语句的形状是「先展开 moreDto，再赋 name 与 id」', () => {
    // ⚠️ 锚点必须唯一命中**代码**（注释已剥除，所以文件头那段解释不会被算进来）
    const anchor = 'return { ...moreDto, name: payload.username, id: payload.sub };';
    expect(SRC.split(anchor).length - 1).toBe(1);
  });

  it('🔴 反方向：源码里不许再出现「权威字段在前、moreDto 展开在后」那个旧形状', () => {
    // 那个形状正是缺陷本身：展开在后会覆盖前面两个权威字段。
    expect(SRC).not.toMatch(/\{\s*name:\s*payload\.username,\s*id:\s*payload\.sub,\s*\.\.\.moreDto\s*\}/);
  });

  it('⚠️ moreDto 仍然来自 payload 的展开（这条性质没被顺手改掉）', () => {
    expect(SRC).toMatch(/const moreDto = \{ \.\.\.payload \};/);
  });
});
