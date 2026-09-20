/**
 * meta 的六个后台写方法：`metas` 为空时必须**大声失败且绝不写库**，
 * 有文档时写操作必须**带上那份文档的 `_id`**（不能再用 `{}`）。
 *
 * 🔴 两个缺陷叠在一起，都是"静默的错答案"这一族：
 *  1. `getAll()` 是**无 filter 的 `findOne()`** ⇒ 集合为空返回 null ⇒ 以前 `meta.rewards.forEach` 直接 TypeError（500）。
 *  2. 更糟的是修 1 时如果写成 `(meta?.rewards || [])` 然后照旧 `updateOne({}, …)`：
 *     空集合上 `updateOne({})` 匹配 **0 条** ⇒ **管理员点"保存"后静默无事发生，界面还提示成功**；
 *     而集合里若不止一条（历史上出现过竞态残留），`updateOne({})` 命中**自然顺序里的任意一条** ⇒ 改错文档。
 *     这正是 `utils/queryFilter.ts` 的 `assertSafeWriteFilter` 要拦的形状（它的文案就写着
 *     "空的查询条件会命中集合里的**任意一条**"），而这 6 处以前都没用它。
 *
 * ⚠️ **既有替身有盲区**：`meta.provider.spec.ts` 的内存 model 是 `findOne: jest.fn(() => ({...}))`，
 * **恒返回对象、永远不可能是 null** ⇒ "集合为空"这条路径在既有测试里完全不可见。
 * 所以这里造"真的能返回 null"的替身，并配**替身自检**。
 */
import fs from 'fs';
import path from 'path';
import { NotFoundException } from '@nestjs/common';
import { MetaProvider } from './meta.provider';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/** 造一个 MetaProvider 实例：不 new（它有一堆 @InjectModel），用 Object.create 手工挂字段。 */
function build(doc: any) {
  const calls: Array<{ filter: any; patch: any }> = [];
  const model = {
    // ⚠️ 与真实 Mongoose 一致：findOne() 返回一个 thenable（带 exec），集合为空时 exec 出 null
    findOne: () => ({ exec: async () => doc }),
    updateOne: async (filter: any, patch: any) => {
      calls.push({ filter, patch });
      return { acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    },
  };
  const provider = Object.create(MetaProvider.prototype) as MetaProvider;
  (provider as any).metaModel = model;
  (provider as any).logger = { log: () => undefined, warn: () => undefined, error: () => undefined };
  return { provider, calls, model };
}

const DOC = {
  _id: 'meta-doc-id-1',
  rewards: [{ name: 'r1', value: 'v1', updatedAt: new Date() }],
  socials: [{ type: 'email', value: 'a@b.c' }],
  links: [{ name: 'l1', url: 'https://x.example.com', avatar: '', desc: '' }],
};

/** 六个方法 + 调用它们所需的参数。 */
const CASES: Array<[string, (p: MetaProvider) => Promise<unknown>]> = [
  ['addOrUpdateReward', (p) => (p as any).addOrUpdateReward({ name: 'r2', value: 'v2' })],
  ['deleteReward', (p) => (p as any).deleteReward('r1')],
  ['deleteSocial', (p) => (p as any).deleteSocial('email')],
  ['addOrUpdateSocial', (p) => (p as any).addOrUpdateSocial({ type: 'email', value: 'z@y.x' })],
  ['addOrUpdateLink', (p) => (p as any).addOrUpdateLink({ name: 'l2', url: 'https://y.example.com' })],
  ['deleteLink', (p) => (p as any).deleteLink('l1')],
];

describe('meta 写路径：集合为空必须大声失败且绝不写库', () => {
  it('⚠️ 替身自检：findOne().exec() 真的 resolve 成 null（否则下面全是空转）', async () => {
    const { model } = build(null);
    await expect(model.findOne().exec()).resolves.toBeNull();
  });

  it.each(CASES)('%s：meta 为 null ⇒ 抛 NotFoundException、文案可照做、**updateOne 一次都没被调用**', async (_name, call) => {
    const { provider, calls } = build(null);
    await expect(call(provider)).rejects.toBeInstanceOf(NotFoundException);
    // 🔴 本体断言：不是"抛了"就算过，而是"**没有写库**"
    expect(calls).toHaveLength(0);
    await expect(call(provider)).rejects.toThrow(/meta 文档不存在/);
    await expect(call(provider)).rejects.toThrow(/doctor/);
    await expect(call(provider)).rejects.toThrow(/restore --offline-full/);
  });

  it('404 而不是 500：这是**数据状态**（文档不存在），不是服务端代码缺陷', async () => {
    const { provider } = build(null);
    await expect((provider as any).deleteReward('r1')).rejects.toMatchObject({
      status: 404,
    } as any);
  });

  it.each(CASES)('%s：有文档时 updateOne 带 **{_id}**，且不是空 filter', async (_name, call) => {
    const { provider, calls } = build(DOC);
    await call(provider);
    expect(calls).toHaveLength(1);
    expect(calls[0].filter).toEqual({ _id: DOC._id });
    // 🔴 反向钉住缺陷原形状：filter 绝不能是 {}
    expect(Object.keys(calls[0].filter).length).toBeGreaterThan(0);
  });

  it('requireMetaDocument 也拒绝"_id 缺失"的文档（恢复出来的畸形数据）', async () => {
    const { provider, calls } = build({ rewards: [], socials: [], links: [] });
    await expect((provider as any).deleteReward('r1')).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toHaveLength(0);
  });
});

describe('meta 写路径：源码级接线（每条都带负向对照，防止尺子失效）', () => {
  const src = stripCommentsForAnchor(
    fs.readFileSync(path.join(__dirname, 'meta.provider.ts'), 'utf-8'),
  );

  // 6 → 8（2026-09-21 第二批）：`updateAbout` 与 `updateSiteInfo` 也接上了 requireMetaDocument。
  const REQUIRE_META_SITES = [
    'addOrUpdateReward',
    'deleteReward',
    'deleteSocial',
    'addOrUpdateSocial',
    'addOrUpdateLink',
    'deleteLink',
    'updateAbout',
    'updateSiteInfo',
  ];

  it('八个后台写方法都走 requireMetaDocument（不是裸 getAll）', () => {
    expect(src.match(/requireMetaDocument\('MetaProvider\./g) || []).toHaveLength(
      REQUIRE_META_SITES.length,
    );
    for (const fn of REQUIRE_META_SITES) {
      expect(src).toContain(`requireMetaDocument('MetaProvider.${fn}')`);
    }
  });

  it('🔴 `update()` **刻意不在**上面那 8 个里：它的降级是 WARN + 不写，而不是 404', () => {
    // 这条钉住的是一个**有意的不对称**，不是漏改。`update()` 被启动期的
    // `updateTotalWords('首次启动')` 与"每次增删改文章"调用，而**未初始化站点的 metas 本来就是空的**
    // （`init.provider` 的 `metaModel.create(…)` 才建这份文档）⇒ 抛 404/500 会让每个未初始化站点
    // 每次启动都产生一条 ERROR，而 `./vanblog.sh doctor` 统计的正是近 24h 的 ERROR/FATAL，
    // 那会把体检信号淹掉（级别判据：诚实站长自己会撞上的 ⇒ WARN）。
    expect(src).not.toContain("requireMetaDocument('MetaProvider.update')");
    // 它走的是"取不到就记一条去重 WARN 并返回 null（不写、不 upsert）"这条路
    expect(src).toContain("this.warnMissingMetaOnce('MetaProvider.update')");
    expect(src).toContain('private warnMissingMetaOnce(');
    // ⚠️ 但它**照样**按 _id 精确写（不许退回空 filter），所以它出现在下面 metaWriteFilter 的清单里
    expect(src).toContain("this.metaWriteFilter(existing, 'MetaProvider.update')");
    // 尺子没空转：`src` 本身就是 `stripCommentsForAnchor(…)` 的结果，所以上面这几条
    // `expect(src).toContain(…)` 命中的**一定是真实代码**，不是注释里的字样。
    // ⚠️ 这一族在本仓库踩过 10 次以上（断言匹配到解释性注释，于是"修复被撤掉"也照样绿）。
    expect(src).toContain("this.warnMissingMetaOnce('MetaProvider.update')");
    expect(src).toContain('private warnMissingMetaOnce(');
  });

  it('九个写操作都走 metaWriteFilter（带 _id），且 metaWriteFilter 内部调用 assertSafeWriteFilter', () => {
    // ⚠️ 正则改成数**全部** `this.metaWriteFilter(`：第一批那 6 处传的都是 `meta`，
    //    而这一批 `update()` 传 `existing`、`updateSiteInfo()` 传 `metaDoc`（后者不能复用
    //    读侧的 `oldSiteInfo`，那是加工过的普通对象、没有 `_id`）⇒ 只匹配 `(meta, ` 会少数两处。
    expect(src.match(/this\.metaWriteFilter\(/g) || []).toHaveLength(REQUIRE_META_SITES.length + 1);
    for (const fn of [...REQUIRE_META_SITES, 'update']) {
      expect(src).toContain(`'MetaProvider.${fn}'`);
    }
    // 每个站点都必须**真的**把 metaWriteFilter 的结果当 filter 用（而不是只提了这个方法名）
    expect(src.match(/this\.metaWriteFilter\((?:meta|metaDoc|existing), 'MetaProvider\./g) || []).toHaveLength(
      REQUIRE_META_SITES.length + 1,
    );
    const i = src.indexOf('private metaWriteFilter(');
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, i + 400);
    expect(body).toContain('assertSafeWriteFilter(filter, context)');
    expect(body).toContain('_id: meta._id');
  });

  it('⚠️ 负向对照：剥注释后本文件里**一处 updateOne({}) 都没有了**', () => {
    // 3 → 0（2026-09-21 第二批）：上一轮这条断言刻意写成 `toBe(3)`，钉的是
    // "我没有顺手改到 `update` / `updateAbout` / `updateSiteInfo` 这三处"这个决定；
    // 这三处现在已经全部改掉（`update` 走 getAll + `_id`，另两个走 requireMetaDocument + `_id`），
    // 所以断言收紧到 **0**。⚠️ 这是**升级**而不是放宽：数字变小是因为缺陷变少，
    // 而且同一件事现在由 `queryFilterDrift.spec.ts` 的 C1/C2 层在**全仓**范围钉住。
    // ⚠️ 正则必须允许空白：`updateAbout` 改之前用的是**多行**写法 `updateOne(\n  {},\n …)`，
    //    写成 /updateOne\(\{\}/ 只会数到 2 处，把第三处漏掉 —— 第一版就是这么错的，
    //    而且错的方向是"少算"，如果不配这条计数断言就永远发现不了。
    const bare = (src.match(/updateOne\(\s*\{\}/g) || []).length;
    expect(bare).toBe(0);
    // 三个方法都还在（改的是 filter，不是把方法删了）
    for (const fn of ['async update(', 'async updateAbout(', 'async updateSiteInfo(']) {
      expect(src).toContain(fn);
    }
  });

  it('NotFoundException 真的被 import 了（不是只写在文案里）', () => {
    expect(src).toMatch(/import \{[^}]*NotFoundException[^}]*\} from '@nestjs\/common'/);
    expect(src).toMatch(/import \{[^}]*assertSafeWriteFilter[^}]*\} from 'src\/utils\/queryFilter'/);
  });
});
