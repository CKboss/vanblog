/**
 * `/api/public/tag` 的**精简投影**接线（`TagProvider.getTagsWithArticle(includeHidden, {slim})`）
 * 与它必须守住的不变量。与 `article.provider.slimListView.spec.ts`（`/api/public/category` 那一侧）
 * 是**同一套机制的同一条不变量**，两边都要钉，别只钉一边。
 *
 * ## 为什么要有 slim
 * `/api/public/tag` 把**全站文章 × 16 个字段**按标签分组返回，其中三个字段在公开响应里
 * **没有任何消费者**（逐个核实过，见 `ArticleProvider.slimListView` 的注释）：`hidden`（公开列表
 * 路径一律带 `hidden:false` 过滤 ⇒ 响应里恒为 false，零信息量）、`lastVisitedTime`（访问台账）、
 * `wordCount`（前台要的阅读时长是服务端算好的 `readingMinutes`）。
 * 活体实测（dev :3000，53 篇 / 7 个标签）：不传参数 **23,265 B**（= 改动前基线，逐字节相同），
 * `?toListView=true` **19,070 B / 13 字段**（**−18.0%**）；`=false`/`=1`/`=TRUE`/`=空` 全部 23,265 B。
 *
 * ## 🔴 本文件最要紧的一条：为什么"隐藏文章的标签不泄漏"**不能**用替身证明
 * 隐藏过滤（`{hidden:false} | {hidden:{$exists:false}}` 加 `visiblePublishFilter()`）在
 * **真实的 `ArticleProvider.getAll()` 里面**，而本文件的替身替换掉的正是 `getAll` ⇒
 * 用替身断言"hidden:true 的独门标签不在结果里"**只会证明我的替身按我的假设过滤**，
 * 什么产品性质都没证到（本仓库已六次因替身钉住作者假设而让真缺陷隐形）。
 * ⇒ 所以这里钉的是**真正承重且替身能证的那一半**：
 *   ① **slim 绝不改变 `includeHidden` 的传递**（四种组合逐个断言第二个实参原样传下去）；
 *   ② **源码级**钉住 `getAll(...)` 的第二个实参是 `includeHidden` 这个变量、而不是字面量
 *      （若有人写成 `getAll(view, false)`，隐藏文章就会在管理端路径上消失；写成 `true` 则会泄漏）；
 *   ③ **投影本身确实更窄、且没裁过头**（`slimListView` 不含那三个字段、但**必须仍含 `tags`** ——
 *      `getTagsWithArticle` 靠 `a.tags.forEach` 分组，少了它会静默变成"一个分组都没有"）。
 * 过滤语义本身由 `ArticleProvider.getAll` 自己的测试与 `visiblePublishFilter` 的守卫负责。
 */
import { ArticleProvider } from '../article/article.provider';
import { TagProvider } from './tag.provider';
import { PublicController } from 'src/controller/public/public.controller';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import * as fs from 'fs';
import * as path from 'path';

/** slim 相对 listView **应当少掉**的三个字段（与 category 那一侧同一份清单，逐个点名） */
const DROPPED = ['hidden', 'lastVisitedTime', 'wordCount'] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8');
}

/** 真实的 ArticleProvider 实例：只为读它的投影常量（类属性初始化器的产物） */
function makeRealArticleProvider(): ArticleProvider {
  // 后四个依赖在本文件用到的路径上不参与（只读投影字段），给空对象即可
  // ⚠️ 与 article.provider.slimListView.spec.ts 同一手法：必须用 new，
  //    Object.create(prototype) 拿不到类属性初始化器
  return new ArticleProvider({} as any, {} as any, {} as any, {} as any);
}

/**
 * 造一个只记录 `getAll` 调用形状的 TagProvider 替身。
 * ⚠️ 替身自检在每条用例里做（断言 calls 真的有记录），否则"传对了 view"可能只是因为
 *    替身根本没被调用（空转的绿）。
 */
function makeTagSpy(articles: any[] = []) {
  const calls: Array<{ view: string; includeHidden: boolean; includeDelete: unknown }> = [];
  const provider = Object.create(TagProvider.prototype) as TagProvider;
  (provider as any).articleProvider = {
    getAll: async (view: string, includeHidden: boolean, includeDelete?: unknown) => {
      calls.push({ view, includeHidden, includeDelete });
      return articles;
    },
  };
  return { provider, calls };
}

/** 造一个只记录 getTagsWithArticle 入参的 PublicController 替身 */
function makeControllerSpy() {
  const calls: Array<{ includeHidden: boolean; opts: unknown }> = [];
  const controller = Object.create(PublicController.prototype) as PublicController;
  (controller as any).tagProvider = {
    getTagsWithArticle: async (includeHidden: boolean, opts?: unknown) => {
      calls.push({ includeHidden, opts });
      return {};
    },
  };
  return { controller, calls };
}

describe('TagProvider 精简投影：/api/public/tag 的 opt-in slim 与它的不变量', () => {
  it('默认（不传 opts）走宽投影 list ⇒ 公开接口的默认形状不变（向后兼容）', async () => {
    const { provider, calls } = makeTagSpy();
    await provider.getTagsWithArticle(false);
    expect(calls).toHaveLength(1); // 替身自检：真的被调用了
    expect(calls[0].view).toBe('list');
    expect(calls[0].includeHidden).toBe(false);
  });

  it('{slim:true} 且 includeHidden=false ⇒ 走 listSlim（精简生效）', async () => {
    const { provider, calls } = makeTagSpy();
    await provider.getTagsWithArticle(false, { slim: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].view).toBe('listSlim');
    expect(calls[0].includeHidden).toBe(false);
  });

  it('🔴 {slim:true} 但 includeHidden=true ⇒ **强制忽略 slim**，仍走 list（不变量）', async () => {
    // 为什么：①管理端要靠 `hidden` 显示"这篇是隐藏的"，精简投影没这个字段 ⇒ 两者同时生效
    // 会让后台拿到一批**无法区分可见性**的文章（静默的错答案）；②`updateTagByName()` 与
    // `deleteOne()` 都走 includeHidden=true 并按 `article.id` 改 tags，宽投影保证将来谁把它
    // 改成"整份文档保存"也不会静默抹掉字段。
    const { provider, calls } = makeTagSpy();
    await provider.getTagsWithArticle(true, { slim: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].view).toBe('list');
    expect(calls[0].includeHidden).toBe(true);
  });

  it('🔴 slim 的四种取值都**原样传递 includeHidden**（过滤语义不因精简而改变）', async () => {
    // 这是"隐藏文章的标签不泄漏"这条安全性质里、替身**能**证明的那一半：
    // slim 只换投影，绝不碰第二个实参。
    for (const includeHidden of [false, true]) {
      for (const opts of [undefined, {}, { slim: false }, { slim: true }]) {
        const { provider, calls } = makeTagSpy();
        await provider.getTagsWithArticle(includeHidden, opts as any);
        expect(calls).toHaveLength(1);
        expect(calls[0].includeHidden).toBe(includeHidden);
      }
    }
  });

  it('slim 只在**严格 true** 时生效（truthy 的非 true 值不算，避免"顺手放宽"）', async () => {
    for (const [opts, expected] of [
      [{ slim: true }, 'listSlim'],
      [{ slim: false }, 'list'],
      [{ slim: 1 }, 'list'],
      [{ slim: 'true' }, 'list'],
      [{ slim: undefined }, 'list'],
      [{}, 'list'],
    ] as Array<[any, string]>) {
      const { provider, calls } = makeTagSpy();
      await provider.getTagsWithArticle(false, opts);
      expect(calls[0].view).toBe(expected);
    }
  });

  it('getAllTags 把 includeHidden 原样传下去（它只要标签名，但过滤语义必须与调用方一致）', async () => {
    // ⚠️ 这里**刻意不断言 view**：`getAllTags` 内部用哪个投影是实现细节
    //（将来可能换成只含 tags 的窄投影以省掉 96% 的传输），
    //    而"过滤语义随 includeHidden 走"是**不能变**的性质 ⇒ 只钉后者。
    for (const includeHidden of [false, true]) {
      const { provider, calls } = makeTagSpy();
      const names = await provider.getAllTags(includeHidden);
      expect(calls).toHaveLength(1);
      expect(calls[0].includeHidden).toBe(includeHidden);
      expect(Array.isArray(names)).toBe(true);
    }
  });

  it('分组行为不变：同一篇文章的多个标签各成一个分组，且文章对象原样进分组', async () => {
    const a1 = { id: 1, tags: ['甲', '乙'], title: 'A1' };
    const a2 = { id: 2, tags: ['乙'], title: 'A2' };
    const { provider } = makeTagSpy([a1, a2]);
    const data: any = await provider.getTagsWithArticle(false, { slim: true });
    expect(Object.keys(data).sort()).toEqual(['乙', '甲'].sort());
    expect(data['甲']).toEqual([a1]);
    expect(data['乙']).toEqual([a1, a2]);
  });

  it('没有标签的文章不会产生分组，tags 为空/缺失也不会抛', async () => {
    const { provider } = makeTagSpy([
      { id: 1, tags: [] },
      { id: 2, tags: ['甲'] },
    ]);
    const data: any = await provider.getTagsWithArticle(false);
    expect(Object.keys(data)).toEqual(['甲']);
  });
});

describe('PublicController 的 @Get(tag)：严格 isTrue 口径与默认不变', () => {
  /**
   * 🔴 14 个输入值逐个断言。口径**故意不同于** `@Get('article')` 的真值判断：
   * 那边 `?toListView=false` 会走列表视图（历史行为，失败方向是"给更小的响应"，无害），
   * 而这里若照抄真值判断，`?toListView=false` 会给出**比调用方预期更少的字段** ⇒ 静默的错答案。
   */
  const CASES: Array<[unknown, boolean]> = [
    [undefined, false],
    [null, false],
    ['', false],
    ['false', false],
    ['0', false],
    ['1', false],
    ['yes', false],
    ['TRUE', false],
    ['True', false],
    [0, false],
    [1, false],
    // ⚠️ 以下两条是**核实过 `utils/isTrue.ts` 的真实语义**才写的，不是猜的：
    //    `typeof v === 'boolean'` 直通（所以布尔 true ⇒ 精简），
    //    字符串则必须**恰好**等于 'true'（`v === 'true'`，**不 trim**）⇒ ' true ' 不精简。
    //    ⚠️ 查询参数正常不会是布尔，但内部调用可能传布尔，所以这条口径要钉住。
    [true, true],
    ['true', true],
    [' true ', false],
    ['true ', false],
  ];

  it.each(CASES)('@Get(tag) 收到 %p ⇒ slim=%p', async (input, expected) => {
    const { controller, calls } = makeControllerSpy();
    await (controller as any).getArticlesByTag(input);
    expect(calls).toHaveLength(1); // 替身自检
    expect(calls[0].includeHidden).toBe(false); // 公开端点绝不带隐藏文章
    expect(calls[0].opts).toEqual({ slim: expected });
  });
});

describe('投影本身：确实更窄、且没有裁过头（尺子有效性 + 防过度裁剪）', () => {
  const real = makeRealArticleProvider();

  it('slimListView 逐个不含那三个字段，而 listView **确实含**（反证：不是切错了地方）', () => {
    const slim: any = (real as any).slimListView;
    const wide: any = (real as any).listView;
    for (const f of DROPPED) {
      expect(slim[f]).toBeUndefined();
      expect(wide[f]).toBe(1); // 🔴 尺子有效性：宽投影里它确实在，否则上面的 undefined 没有意义
    }
  });

  it('🔴 slimListView **必须仍含 tags**：getTagsWithArticle 靠 a.tags 分组，少了它会静默变成"零分组"', () => {
    // 这是"防裁过头"那条：失败方向不是报错，而是**公开标签列表整个变空**（静默的错答案）。
    expect((real as any).slimListView.tags).toBe(1);
    // 顺带钉住 id：updateTagByName/deleteOne 要按 article.id 改 tags
    expect((real as any).slimListView.id).toBe(1);
  });

  it('slim ⊂ listView，且两者都不含 content 与 password（密文与全文都不该出现在列表投影里）', () => {
    const slim: any = (real as any).slimListView;
    const wide: any = (real as any).listView;
    // ⚠️ 比"同值"而不是"等于 1"：两个投影都含 `_id: 0`（排除 Mongo 的 _id），
    //    若断言 `wide[k]).toBe(1)` 会在 `_id` 上假红。
    for (const k of Object.keys(slim)) {
      expect(Object.prototype.hasOwnProperty.call(wide, k)).toBe(true);
      expect(wide[k]).toBe(slim[k]);
    }
    expect(Object.keys(slim).length).toBeLessThan(Object.keys(wide).length);
    for (const p of [slim, wide]) {
      expect(p.content).toBeUndefined();
      expect(p.password).toBeUndefined();
    }
    // 反证：adminView 确实 select 了 password ⇒ 上面那条"不含 password"不是恒真
    expect((real as any).adminView.password).toBe(1);
  });

  it('getView 的兜底仍 fail-closed（最窄投影），且 listSlim 正确分派到 slimListView', () => {
    // ⚠️ 兜底值上一轮已从 adminView 改成 slimListView；这里钉住它没被改回去，
    //    并且 listSlim 分派到的就是 slimListView（我的 slim 依赖这条）。
    expect((real as any).getView('listSlim')).toBe((real as any).slimListView);
    expect((real as any).getView('list')).toBe((real as any).listView);
    expect((real as any).getView('不存在的视图' as any)).toBe((real as any).slimListView);
    const fb: any = (real as any).getView('不存在的视图' as any);
    expect(fb.password).toBeUndefined();
    expect(fb.content).toBeUndefined();
  });
});

describe('源码级接线（剥注释后断言，每条都配反证）', () => {
  const tagSrc = stripCommentsForAnchor(read('provider/tag/tag.provider.ts'));
  const ctrlSrc = stripCommentsForAnchor(read('controller/public/public.controller.ts'));

  it('getTagsWithArticle 的签名带 opts?.slim，且 getAll 的第二个实参是 includeHidden 变量（不是字面量）', () => {
    expect(tagSrc).toMatch(/async getTagsWithArticle\(includeHidden: boolean, opts\?: \{ slim\?: boolean \}\)/);
    // 🔴 这条是安全相关的源码钉子：若有人写成 getAll(view, false) 管理端会看不到隐藏文章，
    //    写成 getAll(view, true) 则公开路径会泄漏隐藏文章的标签。
    expect(tagSrc).toMatch(/slim \? 'listSlim' : 'list',\s*\n\s*includeHidden,/);
    // 反证：不许出现把 includeHidden 写死成字面量的形状
    expect(tagSrc).not.toMatch(/getAll\(\s*slim \? 'listSlim' : 'list',\s*(true|false)\s*[,)]/);
  });

  it('slim 的判定是 `opts?.slim === true && !includeHidden`（互斥不变量写在代码里，不只是注释里）', () => {
    expect(tagSrc).toMatch(/const slim = opts\?\.slim === true && !includeHidden;/);
    // 反证：不许退化成"只看 opts.slim"
    expect(tagSrc).not.toMatch(/const slim = opts\?\.slim === true;/);
    expect(tagSrc).not.toMatch(/const slim = !!opts\?\.slim;/);
  });

  it("@Get('tag') 用严格 isTrue 解析 toListView，且把 includeHidden 写死为 false", () => {
    // 取出 @Get('tag') 那个 handler 的片段（到下一个 @Get 之前），避免匹配到 category 那一处
    const i = ctrlSrc.indexOf("@Get('tag')");
    expect(i).toBeGreaterThan(-1);
    const j = ctrlSrc.indexOf('@Get(', i + 10);
    const seg = ctrlSrc.slice(i, j > i ? j : undefined);
    expect(seg).toMatch(/async getArticlesByTag\(@Query\('toListView'\) toListView\?: unknown\)/);
    expect(seg).toMatch(/getTagsWithArticle\(false, \{\s*\n\s*slim: isTrue\(toListView\),/);
    // 🔴 反证：这个 handler 里不许出现真值判断（那正是与 @Get('article') 口径混淆的形状）
    expect(seg).not.toMatch(/slim: !!toListView/);
    expect(seg).not.toMatch(/slim: Boolean\(toListView\)/);
    expect(seg).not.toMatch(/slim: toListView/);
  });

  it("尺子有效性反证：@Get('article') 那一侧**仍是真值判断**（两边口径故意不同，别被顺手统一）", () => {
    // 这条断言的存在意义：如果有人"顺手统一"成 isTrue，本条会红，逼他先读注释。
    // ⚠️ 真实形状核实过：控制器里是 `const wantsFullContent = !toListView;`（:303 附近），
    //    provider 里是 `if (option.toListView)`（`article.provider.ts:983` 附近，注释里也点名了）。
    expect(ctrlSrc).toMatch(/const wantsFullContent = !toListView;/);
    const artSrc = stripCommentsForAnchor(read('provider/article/article.provider.ts'));
    expect(artSrc).toMatch(/if \(option\.toListView\)/);
  });

  it('@Get(category) 的既有接线没有被本次改动碰到（回归钉子）', () => {
    const i = ctrlSrc.indexOf("@Get('category')");
    expect(i).toBeGreaterThan(-1);
    const j = ctrlSrc.indexOf('@Get(', i + 10);
    const seg = ctrlSrc.slice(i, j > i ? j : undefined);
    expect(seg).toMatch(/getCategoriesWithArticle\(false, \{\s*\n\s*slim: isTrue\(toListView\),/);
  });
});

describe('前台接线：SSR 那一跳也要省（website/api/getArticles.ts）', () => {
  const webSrc = stripCommentsForAnchor(
    fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'website', 'api', 'getArticles.ts'),
      'utf-8',
    ),
  );

  it('getArticlesByCategory 与 getArticlesByTag 都带 toListView=true（两层裁剪：这层省进程间传输）', () => {
    expect(webSrc).toMatch(/api\/public\/category\?toListView=true/);
    expect(webSrc).toMatch(/api\/public\/tag\?toListView=true/);
    // 反证：不许留一个不带参数的旧形状（那会让 slim 白做）
    expect(webSrc).not.toMatch(/api\/public\/category`;/);
    expect(webSrc).not.toMatch(/api\/public\/tag`;/);
  });

  it('⚠️ 但 /api/public/tag/:name 与 /timeline 保持原样（它们已经是干净的 / 不在本轮范围）', () => {
    // tag/:name 走服务端 toPublic() 的显式 8 字段映射，不含那三个字段 ⇒ 不需要参数
    expect(webSrc).toMatch(/api\/public\/article\/\$\{encodeURIComponent/);
    expect(webSrc).toMatch(/api\/public\/timeline`;/);
    // 反证：timeline 不该被顺手加上参数（它没有 slim 支持，加了会被忽略，属于误导性改动）
    expect(webSrc).not.toMatch(/api\/public\/timeline\?toListView/);
  });
});

/**
 * 🔴 安全守卫：**slim 只换投影，过滤条件必须逐字不变**。
 *
 * 为什么这一节要用**真实的 `ArticleProvider.getAll`** 而不是替身：
 * 隐藏文章过滤（`{hidden:false} | {hidden:{$exists:false}}`）与定时发布过滤
 * （`utils/publishAt.ts` 的 `visiblePublishFilter()`，头注释明写"所有公开读路径共用同一段，
 * **漏一条就是泄露**"）都长在 `getAll` 里面。用替身替换掉 `getAll` 就**测不到它们** ——
 * 那只会证明"我的替身按我的假设过滤"。所以这里给 `ArticleProvider` 挂一个**假的 Mongoose model**
 * （记录 `find()` 收到的 filter 与 projection），让**真实的 getAll 代码**跑起来。
 *
 * ⚠️ 替身忠实性：`getAll` 的实际调用链是 `find(filter, projection).sort({createdAt:-1}).exec()`
 *    （核实自 `article.provider.ts:1043-1053`），所以假 model 必须提供 `.sort().exec()`，
 *    少一层就会抛 TypeError —— 那种"红"看起来像产品缺陷，其实是替身不忠实。
 */
function makeArticleProviderWithFakeModel(articles: any[] = []) {
  const seen: Array<{ filter: any; projection: any }> = [];
  const model = {
    find: (filter: any, projection: any) => {
      seen.push({ filter, projection });
      return { sort: () => ({ exec: async () => articles }) };
    },
  };
  const provider = new ArticleProvider(model as any, {} as any, {} as any, {} as any);
  return { provider, seen };
}

/** 从 $and 里找出"排除隐藏文章"那一支（形状核实自 getAll 的实现） */
function findHiddenClause(filter: any): any {
  const and = filter?.$and;
  if (!Array.isArray(and)) return undefined;
  return and.find(
    (c: any) =>
      Array.isArray(c?.$or) &&
      c.$or.some((o: any) => o && 'hidden' in o),
  );
}

describe('🔴 安全：slim 投影**绝不改变过滤语义**（真实 getAll + 假 model）', () => {
  it('公开路径（includeHidden=false）：slim 与宽投影发出的 filter **逐字相同**，且都排除隐藏文章与未到点文章', async () => {
    const wide = makeArticleProviderWithFakeModel();
    const slim = makeArticleProviderWithFakeModel();
    await wide.provider.getAll('list', false);
    await slim.provider.getAll('listSlim', false);
    // 替身自检：两边都真的发了一次查询
    expect(wide.seen).toHaveLength(1);
    expect(slim.seen).toHaveLength(1);
    // 🔴 核心：过滤条件完全一致 ⇒ 精简不可能让隐藏文章漏进公开响应
    expect(slim.seen[0].filter).toEqual(wide.seen[0].filter);
    // 且这一致的过滤里**确实**有隐藏排除子句（否则上面那条 toEqual 可能在比两个都没有过滤的东西）
    const hidden = findHiddenClause(slim.seen[0].filter);
    expect(hidden).toBeDefined();
    expect(hidden.$or).toEqual([{ hidden: false }, { hidden: { $exists: false } }]);
    // 定时发布过滤也必须在（publishAt.ts 头注释：漏一条就是泄露）
    const and = slim.seen[0].filter.$and;
    expect(and.length).toBeGreaterThanOrEqual(3); // deleted + hidden + publishAt
    expect(JSON.stringify(and[and.length - 1])).toContain('publishAt');
    // 投影确实不同（否则本条用例什么都没测到）
    expect(slim.seen[0].projection).not.toEqual(wide.seen[0].projection);
    expect(slim.seen[0].projection.hidden).toBeUndefined();
    expect(wide.seen[0].projection.hidden).toBe(1);
  });

  it('管理端路径（includeHidden=true）：**不带**隐藏排除子句（后台必须能看到隐藏文章）', async () => {
    const { provider, seen } = makeArticleProviderWithFakeModel();
    await provider.getAll('list', true);
    expect(seen).toHaveLength(1);
    expect(findHiddenClause(seen[0].filter)).toBeUndefined();
  });

  it('🔴 端到端：TagProvider 走 slim 时，发给 Mongo 的 filter 仍然排除隐藏文章（公开标签列表不会因精简而泄漏）', async () => {
    // 这条把"TagProvider 的 slim 接线"与"真实 getAll 的过滤"串起来测，
    // 是本文件里唯一一条**跨越替身边界**的用例：TagProvider 拿到的是真 ArticleProvider。
    const { provider: articleProvider, seen } = makeArticleProviderWithFakeModel([
      { id: 1, tags: ['公开标签'], title: 'P' },
    ]);
    const tagProvider = Object.create(TagProvider.prototype) as TagProvider;
    (tagProvider as any).articleProvider = articleProvider;
    const data: any = await tagProvider.getTagsWithArticle(false, { slim: true });
    expect(seen).toHaveLength(1);
    expect(findHiddenClause(seen[0].filter)).toBeDefined();
    expect(seen[0].projection.hidden).toBeUndefined(); // 用的是精简投影
    expect(seen[0].projection.tags).toBe(1); // 🔴 但没有裁掉分组必需的 tags
    expect(Object.keys(data)).toEqual(['公开标签']);
  });
});
