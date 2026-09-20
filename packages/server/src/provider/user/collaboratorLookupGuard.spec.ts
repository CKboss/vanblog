import { readFileSync } from 'fs';
import { resolve } from 'path';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import { UserProvider } from './user.provider';

/**
 * `getCollaboratorById` / `getCollaboratorByName` 在标识符不可用时**必须直接返回 null，不发查询**。
 *
 * 这是"Mongoose 丢掉值为 `undefined` 的查询条件"这一族的**第二道防线**（第一道在
 * `provider/auth/jwt.strategy.ts`：`sub` 不是整数就 401，根本不会走到这里）。
 * 为什么还要第二道：`findOne({ id: undefined, type:'collaborator' })` 的 id 条件会被丢弃 ⇒
 * 退化成 `{ type:'collaborator' }` ⇒ 返回**自然顺序里任意一个协作者**。这一族已经复发 6 次，
 * 根因每次都是"靠调用方记得校验"。**不变量应该长在查询旁边。**
 *
 * ⚠️ 断言的本体是"`findOne` 零调用"，不是"返回了 null"：一个"照发查询、拿到任意一个协作者、
 * 然后因为别的理由返回 null"的实现同样能让 `toBeNull()` 通过，而它已经把别人的身份读进了内存。
 */

/** 忠实复现 Mongoose 的两步真实行为：①丢掉值为 undefined 的键；②空条件匹配自然顺序第一条。
 *  ⚠️ 这一点很关键：本仓库既有的内存 model 对 `{}` 查询返回 null，于是在它上面跑**有缺陷的**
 *  代码同样是绿的（缺陷隐形）。测试替身必须比生产更忠实，否则它保护的是自己的假设。 */
function makeFakeModel(docs: Array<Record<string, unknown>>) {
  const findOne = jest.fn(async (filter: Record<string, unknown>) => {
    const effective: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(filter || {})) {
      if (v !== undefined) effective[k] = v; // ← Mongoose 的行为
    }
    return docs.find((d) => Object.keys(effective).every((k) => d[k] === effective[k])) ?? null;
  });
  return { findOne, model: { findOne } as any };
}

function makeProvider(docs: Array<Record<string, unknown>>) {
  const provider = Object.create(UserProvider.prototype) as UserProvider;
  const { findOne, model } = makeFakeModel(docs);
  (provider as any).userModel = model;
  return { provider, findOne };
}

const COLLABS = [
  { id: 1, name: '第一个协作者', type: 'collaborator', permissions: ['all'] },
  { id: 2, name: '第二个协作者', type: 'collaborator', permissions: ['article:update'] },
];

describe('getCollaboratorById：标识符不可用时不发查询', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['空串', ''],
    ['字符串 "7"（mongoose 会把它 cast 成 7 并**真的匹配上**，所以类型违规比 undefined 更隐蔽）', '7'],
    ['小数 7.5', 7.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['布尔 true', true],
    ['空对象', {}],
    ['数组 [1]', [1]],
  ])('id 是 %s ⇒ 返回 null 且 findOne 零调用', async (_label, id) => {
    const { provider, findOne } = makeProvider(COLLABS);
    await expect(provider.getCollaboratorById(id as any)).resolves.toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('合法整数 id ⇒ 照旧查询，filter 里 id 与 type 都在', async () => {
    const { provider, findOne } = makeProvider(COLLABS);
    const found = await provider.getCollaboratorById(2);
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith({ id: 2, type: 'collaborator' });
    expect(found).toMatchObject({ id: 2, name: '第二个协作者' });
  });

  it('id=0 仍然照查（0 是整数；filter 带 type:"collaborator"，而管理员不是协作者 ⇒ 查不到，安全）', async () => {
    const { provider, findOne } = makeProvider([...COLLABS, { id: 0, name: 'admin', type: 'admin' }]);
    await expect(provider.getCollaboratorById(0)).resolves.toBeNull();
    expect(findOne).toHaveBeenCalledWith({ id: 0, type: 'collaborator' });
  });

  it('🔴 对照：如果**绕过**防呆直接把 undefined 交给 findOne，就会拿到任意一个协作者（证明这道防线不是装饰）', async () => {
    const { findOne } = makeFakeModel(COLLABS);
    const degraded = await findOne({ id: undefined, type: 'collaborator' });
    // 退化后的条件是 { type:'collaborator' } ⇒ 命中自然顺序第一条，而它恰好是 permissions:['all']
    expect(degraded).toMatchObject({ id: 1, permissions: ['all'] });
    // 尺子有效性反证：同一个假 model 对**合法** filter 必须精确命中，否则上面的"命中第一条"没有意义
    expect(await findOne({ id: 2, type: 'collaborator' })).toMatchObject({ id: 2 });
    expect(await findOne({ id: 999, type: 'collaborator' })).toBeNull();
  });
});

describe('getCollaboratorByName：同一族的姊妹方法（超出交办范围，一并加防呆）', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['空串', ''],
    ['纯空白', '   '],
    ['数字 1', 1],
    ['对象', {}],
  ])('name 是 %s ⇒ 返回 null 且 findOne 零调用', async (_label, name) => {
    const { provider, findOne } = makeProvider(COLLABS);
    await expect(provider.getCollaboratorByName(name as any)).resolves.toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('合法 name ⇒ 照旧查询（既有两个调用方 create/update 的行为不变）', async () => {
    const { provider, findOne } = makeProvider(COLLABS);
    const found = await provider.getCollaboratorByName('第一个协作者');
    expect(findOne).toHaveBeenCalledWith({ name: '第一个协作者', type: 'collaborator' });
    expect(found).toMatchObject({ id: 1 });
  });
});

describe('源码级钉子：校验必须在查询之前（剥注释后断言）', () => {
  const RAW = readFileSync(resolve(__dirname, 'user.provider.ts'), 'utf-8');
  const SRC = stripCommentsForAnchor(RAW);

  /** 取出某个方法体（从方法签名到下一个同级方法签名为止），避免"全文件出现即可"这种空断言。 */
  function bodyOf(signature: string): string {
    const start = SRC.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const next = SRC.indexOf('\n  async ', start + signature.length);
    return SRC.slice(start, next === -1 ? undefined : next);
  }

  it('getCollaboratorById：整数校验在 findOne 之前', () => {
    const body = bodyOf('async getCollaboratorById(id: number) {');
    const iCheck = body.indexOf("typeof id !== 'number' || !Number.isInteger(id)");
    const iQuery = body.indexOf('this.userModel.findOne(');
    expect(iCheck).toBeGreaterThan(-1);
    expect(iQuery).toBeGreaterThan(-1);
    expect(iCheck).toBeLessThan(iQuery);
  });

  it('getCollaboratorByName：非空字符串校验在 findOne 之前', () => {
    const body = bodyOf('async getCollaboratorByName(name: string) {');
    const iCheck = body.indexOf("typeof name !== 'string' || !name.trim()");
    const iQuery = body.indexOf('this.userModel.findOne(');
    expect(iCheck).toBeGreaterThan(-1);
    expect(iQuery).toBeGreaterThan(-1);
    expect(iCheck).toBeLessThan(iQuery);
  });

  it('⚠️ 空转反证：bodyOf 真的把范围收窄了，且"先后"这把尺子量得到坏形状', () => {
    // bodyOf 不该把整个文件都当成方法体（否则"在查询之前"就退化成了"文件里某处有校验"）
    const body = bodyOf('async getCollaboratorById(id: number) {');
    expect(body.length).toBeLessThan(1200);
    expect(body).not.toContain('getAllCollaborators');
    // 坏形状：查询在前、校验在后（这正是"看起来加了校验其实没用"的形状）
    const bad = 'async getCollaboratorById(id) {\n  const r = await this.userModel.findOne({ id });\n  if (typeof id !== "number") return null;\n  return r;\n}\n  async next() {}';
    const iCheck = bad.indexOf('typeof id !== "number"');
    const iQuery = bad.indexOf('this.userModel.findOne(');
    expect(iCheck).toBeGreaterThan(iQuery); // 尺子能分辨顺序 ⇒ 不是恒真
    // 剥注释器确实在工作（双向）：`isUsableFilterValue` 只出现在**解释"为什么不用它"的注释**里，
    // 所以原文必须命中、剥注释后必须不命中。⚠️ 这条同时也是一把有意义的尺子：它证明本方法
    // 真的没有调用那个助手（我按契约差异刻意没复用），而不只是"注释里提了一嘴"。
    expect(RAW).toContain('isUsableFilterValue');
    expect(SRC).not.toContain('isUsableFilterValue');
    expect(stripCommentsForAnchor('// typeof id !== "number"\nconst a = 1;')).not.toContain('typeof id');
  });
});
