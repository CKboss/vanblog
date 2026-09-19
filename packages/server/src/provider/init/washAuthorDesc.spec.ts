/**
 * `InitProvider.washAuthorDesc()` —— 把上游遗留的 `siteInfo.authDesc` 迁到真正有人读的
 * `siteInfo.authorDesc`。
 *
 * 为什么值得单独一套钉子：这类"写的一侧和读的一侧用了不同键名"的 bug **不会报错**，
 * 只会让某个字段永远是空的（这里是零接触初始化出来的站点没有作者描述）。
 * 而且洗数据函数有两个经典翻车方式，都必须钉住：
 *   1. **不幂等** ⇒ 每次启动都重写一遍库（台账里一堆重复迁移记录，大站上还拖慢启动）；
 *   2. **覆盖用户数据** ⇒ 把站长在后台填好的值冲成遗留的空串。
 * 所以这里用一个**内存版 metaModel**（真的按 `$set`/`$unset` 改文档），而不是只断言"调用了 updateOne"。
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { InitProvider } from './init.provider';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

function setPath(doc: any, dotted: string, value: unknown) {
  const parts = dotted.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(doc: any, dotted: string) {
  const parts = dotted.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur[parts[i]] !== 'object') return;
    cur = cur[parts[i]];
  }
  if (cur) delete cur[parts[parts.length - 1]];
}

/** 内存版 Meta model：只实现 wash 用到的 find / updateOne，语义与 mongo 一致。 */
function makeHarness(docs: any[]) {
  const updates: any[] = [];
  const metaModel = {
    find: jest.fn(async (query: any) => {
      // 只支持 wash 用的那个查询：{ 'siteInfo.authDesc': { $exists: true } }
      expect(query).toEqual({ 'siteInfo.authDesc': { $exists: true } });
      return docs
        .filter((d) => d.siteInfo && Object.prototype.hasOwnProperty.call(d.siteInfo, 'authDesc'))
        .map((d) => ({ ...d, siteInfo: { ...d.siteInfo } }));
    }),
    updateOne: jest.fn(async (filter: any, update: any) => {
      updates.push({ filter, update });
      const doc = docs.find((d) => String(d._id) === String(filter._id));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      for (const [k, v] of Object.entries(update.$set || {})) setPath(doc, k, v);
      for (const k of Object.keys(update.$unset || {})) unsetPath(doc, k);
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  };
  const provider = new InitProvider(
    metaModel as any,
    { create: jest.fn() } as any,
    {} as any,
    {} as any,
    { init: jest.fn(async () => undefined) } as any,
    {} as any,
    { set: jest.fn() } as any,
    { restart: jest.fn(async () => undefined) } as any,
  );
  // 日志静音（wash 会 log 迁移结果）
  jest.spyOn((provider as any).logger, 'log').mockImplementation(() => undefined);
  return { provider, metaModel, updates, docs };
}

describe('washAuthorDesc · 迁移遗留的 authDesc', () => {
  it('有内容且 authorDesc 缺失 ⇒ 搬过去，并把死键删掉', async () => {
    const h = makeHarness([{ _id: 1, siteInfo: { authDesc: '老描述', author: 'me' } }]);
    const r = await h.provider.washAuthorDesc();
    expect(r).toEqual({ moved: 1, dropped: 0 });
    expect(h.docs[0].siteInfo.authorDesc).toBe('老描述');
    expect('authDesc' in h.docs[0].siteInfo).toBe(false);
    expect(h.docs[0].siteInfo.author).toBe('me'); // 别的字段不受影响
  });

  it('authorDesc 是空串或纯空白 ⇒ 也算"没填过"，照搬', async () => {
    for (const blank of ['', '   ']) {
      const h = makeHarness([{ _id: 1, siteInfo: { authDesc: '老描述', authorDesc: blank } }]);
      const r = await h.provider.washAuthorDesc();
      expect(r.moved).toBe(1);
      expect(h.docs[0].siteInfo.authorDesc).toBe('老描述');
    }
  });

  it('⚠️ 绝不覆盖站长填过的 authorDesc（只删死键）', async () => {
    const h = makeHarness([{ _id: 1, siteInfo: { authDesc: '遗留值', authorDesc: '站长自己写的' } }]);
    const r = await h.provider.washAuthorDesc();
    expect(r).toEqual({ moved: 0, dropped: 1 });
    expect(h.docs[0].siteInfo.authorDesc).toBe('站长自己写的');
    expect('authDesc' in h.docs[0].siteInfo).toBe(false);
  });

  it('遗留键是空串/非字符串 ⇒ 没内容可搬，只删死键，不会写出一个空 authorDesc', async () => {
    const h = makeHarness([
      { _id: 1, siteInfo: { authDesc: '' } },
      { _id: 2, siteInfo: { authDesc: 123 } },
      { _id: 3, siteInfo: { authDesc: null } },
    ]);
    const r = await h.provider.washAuthorDesc();
    expect(r).toEqual({ moved: 0, dropped: 3 });
    for (const d of h.docs) {
      expect('authDesc' in d.siteInfo).toBe(false);
      expect('authorDesc' in d.siteInfo).toBe(false);
    }
  });

  it('幂等：连跑三次，只有第一次动库', async () => {
    const h = makeHarness([{ _id: 1, siteInfo: { authDesc: '老描述' } }]);
    const first = await h.provider.washAuthorDesc();
    const second = await h.provider.washAuthorDesc();
    const third = await h.provider.washAuthorDesc();
    expect(first).toEqual({ moved: 1, dropped: 0 });
    expect(second).toEqual({ moved: 0, dropped: 0 });
    expect(third).toEqual({ moved: 0, dropped: 0 });
    expect(h.metaModel.updateOne).toHaveBeenCalledTimes(1);
    expect(h.docs[0].siteInfo.authorDesc).toBe('老描述');
  });

  it('没有死键的站点：零成本（一次 updateOne 都不发）', async () => {
    const h = makeHarness([{ _id: 1, siteInfo: { authorDesc: '正常站点' } }]);
    const r = await h.provider.washAuthorDesc();
    expect(r).toEqual({ moved: 0, dropped: 0 });
    expect(h.metaModel.updateOne).not.toHaveBeenCalled();
  });

  it('meta 表是空的（全新站点，还没初始化）⇒ 不炸、不动库', async () => {
    const h = makeHarness([]);
    await expect(h.provider.washAuthorDesc()).resolves.toEqual({ moved: 0, dropped: 0 });
    expect(h.metaModel.updateOne).not.toHaveBeenCalled();
  });

  it('siteInfo 整个缺失的畸形文档 ⇒ 只删死键，不会因为读 undefined 炸掉', async () => {
    const h = makeHarness([{ _id: 1, siteInfo: undefined }]);
    // find 的过滤条件要求有 siteInfo，所以这条文档根本不会被捞出来
    const r = await h.provider.washAuthorDesc();
    expect(r).toEqual({ moved: 0, dropped: 0 });
  });
});

describe('washAuthorDesc · 源码级钉子（写了函数却不挂上去 = 死代码）', () => {
  // __dirname = <root>/packages/server/src/provider/init ⇒ 到仓库根是 **5** 层
  // （写成 4 层会指到 packages/，读文件直接 ENOENT，三条源码级断言全红）
  const repoRoot = path.resolve(__dirname, '../../../../..');
  const read = (p: string) => stripCommentsForAnchor(readFileSync(path.join(repoRoot, p), 'utf-8'));

  it('main.ts 真的把这条 wash 挂进了启动流程', () => {
    const main = read('packages/server/src/main.ts');
    expect(main).toContain("wash('wash:authorDesc'");
    expect(main).toContain('initProvider.washAuthorDesc()');
    // 与其它 wash 一样只在主实例上跑（多副本同时洗库没有意义）
    expect(main).toMatch(/if \(primary\)\s*\n\s*await wash\('wash:authorDesc'/);
  });

  it('写的一侧已经改名：DTO 与零接触初始化里不许再出现 authDesc', () => {
    // ⚠️ 断言"不存在"必须在**剥注释之后**做：这两个文件里都有解释这次改名的注释，
    //    注释里必然写着旧键名。本仓库已经六次踩到"断言匹配到解释性注释"。
    const dto = read('packages/server/src/types/site.dto.ts');
    const bootstrap = read('packages/server/src/provider/init/envBootstrap.ts');
    expect(dto).not.toContain('authDesc');
    expect(bootstrap).not.toContain('authDesc');
    expect(dto).toContain('authorDesc');
    expect(bootstrap).toContain('authorDesc');
  });

  it('空转反证：上面那条"不存在"断言在旧内容上必须命中（否则它什么都没证明）', () => {
    const legacyDto = stripCommentsForAnchor('export class SiteInfo {\n  authDesc: string;\n}\n');
    expect(legacyDto).toContain('authDesc');
    const legacyBootstrap = stripCommentsForAnchor("return { authDesc: '' } as Partial<SiteInfo>;");
    expect(legacyBootstrap).toContain('authDesc');
  });

  it('读的一侧一直用的是 authorDesc（这次改名是对齐现实，不是改现实）', () => {
    const form = read('packages/admin/src/components/SiteInfoForm/index.tsx');
    const layout = read('packages/website/utils/getLayoutProps.ts');
    expect(form).toContain('authorDesc');
    expect(layout).toContain('authorDesc');
    expect(form).not.toContain('authDesc');
    expect(layout).not.toContain('authDesc');
  });
});
