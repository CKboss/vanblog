/**
 * `TagProvider.getAllTags()` 的**窄投影**（`view: 'tagsOnly'` / `ArticleProvider.tagsOnlyView`）
 * 与它必须守住的不变量。
 *
 * ## 为什么要改这一处（收益最大的那条服务端白传）
 * `getAllTags()` 只要**标签名**，但它以前经 `getTagsWithArticle()` → `getAll('list', …)`
 * 把**全站文章 × 16 个字段**捞回来，再 `Object.keys()` 把其余全丢掉。而它的调用方之一是
 * `buildPublicMeta()`（`controller/public/public.controller.ts`）—— **全站最热的一次读**：
 * 每个页面渲染都调，5 秒 single-flight 缓存。按 5s TTL 上限估，每天最多 17,280 次重建
 * × 约 20 KB ≈ **350 MB/天**的无谓 Mongo→Node 传输。
 *
 * 🔴 **验收判据（别搞错）**：`/api/public/meta` 的**响应字节数不会变**（活体实测改前改后都是
 * **8,274 B**，sha256 前 16 位都是 `afce8f29d68fb53c`），因为它本来就只用标签名。
 * ⇒ 判据是"**响应逐字节不变 + 发给 model 的投影确实变窄**"，**不要拿响应字节当收益证据**。
 * 本文件钉的正是后半条（前半条是活体实测，记录在提交信息里，9 个端点全部逐字节相同）。
 *
 * ## 🔴 为什么"隐藏文章的标签不泄漏"这里钉的是 **filter**，而不是模拟 Mongo 的结果
 * 隐藏过滤（`{hidden:false} | {hidden:{$exists:false}}`）与定时发布过滤
 * （`utils/publishAt.ts` 的 `visiblePublishFilter()`，头注释明写"所有公开读路径共用同一段，
 * **漏一条就是泄露**"）都长在**真实的 `ArticleProvider.getAll()`** 里面。
 * 用替身替换掉 `getAll` 就测不到它们（只会证明"我的替身按我的假设过滤"，本仓库已**七次**
 * 因替身不忠实而让真缺陷隐形）；而**在假 model 里自己实现一遍过滤**同样是把自己的假设当被测对象。
 * ⇒ 所以与 `tag.provider.slimListView.spec.ts` 同一手法：给**真实 ArticleProvider** 挂一个
 * **假 Mongoose model**（只记录 `find()` 收到的 filter 与 projection），让**真实的 getAll 代码**
 * 跑起来，然后断言：①`tagsOnly` 与宽投影发出的 **filter 逐字相同**（⇒ 换投影不可能改变过滤）；
 * ②那个 filter 里**确实**有隐藏排除子句与 `publishAt` 子句（否则 ① 可能在比两个都没过滤的东西）；
 * ③`includeHidden` 四种组合都**原样传递**。过滤语义本身由 `getAll` 自己的测试与
 * `article.provider.publishAt.spec.ts`（12/12）负责。
 *
 * ⚠️ 替身忠实性：`getAll` 的实际调用链是 `find(filter, projection).sort({createdAt:-1}).exec()`
 *    （核实自 `article.provider.ts` 的 `getAll`），所以假 model 必须提供 `.sort().exec()`，
 *    少一层就会抛 TypeError —— 那种"红"看起来像产品缺陷，其实是替身不忠实。
 */
import { ArticleProvider } from '../article/article.provider';
import { TagProvider } from './tag.provider';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import * as fs from 'fs';
import * as path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8');
}

/** 只为读投影常量（类属性初始化器的产物）⇒ 必须用 new，Object.create 拿不到 */
function makeRealArticleProvider(): ArticleProvider {
  return new ArticleProvider({} as any, {} as any, {} as any, {} as any);
}

/**
 * 真实的 ArticleProvider + 假 Mongoose model（记录 find 收到的 filter 与 projection）。
 * ⚠️ `.sort().exec()` 两层都必须有，见文件头"替身忠实性"。
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

/**
 * 🔴 **`visiblePublishFilter()` 里带的是墙上时钟**（`publishAt: {$lte: new Date()}`），
 * 所以两次 `getAll()` 即使过滤逻辑完全相同，只要跨过一个毫秒，filter 就**不逐字相等**。
 * ⇒ 直接 `toEqual` 两个 filter 是**天生会偶发红**的断言（本文件与
 * `tag.provider.slimListView.spec.ts` 都曾这样写，实测在并发跑时约每几次红一次，
 * 红的差异只有 `"$lte"` 那一行）。
 *
 * 正确做法：把 `publishAt.$lte` 归一化后再比，**并且**单独断言两边的 `$lte` 都是
 * "接近当前时间的 Date"（否则归一化会把"一边根本没有这个子句"也一起藏掉）。
 */
function normalizePublishAt(input: any): any {
  if (Array.isArray(input)) return input.map(normalizePublishAt);
  if (input instanceof Date) return 'DATE';
  if (input && typeof input === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(input)) {
      out[k] = k === '$lte' && input[k] instanceof Date ? 'NOW' : normalizePublishAt(input[k]);
    }
    return out;
  }
  return input;
}

/** 取出 filter 里的 `publishAt.$lte`（用来证明归一化没有把"子句缺失"藏掉） */
function extractPublishAtLte(filter: any): any {
  // ⚠️ 真实形状（实测 dump 出来的，别按猜的写）：
  //   $and: [ {$or:[deleted…]}, {$or:[hidden…]},
  //           {$or:[{publishAt:null},{publishAt:{$exists:false}},{publishAt:{$lte:<Date>}}]} ]
  // ⇒ `$lte` 在**第三支 $or 的第三个元素**里，不是 `$and` 元素的直接键，所以必须递归找。
  const stack: any[] = [filter];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    const pa = (cur as any).publishAt;
    if (pa && typeof pa === 'object' && pa.$lte instanceof Date) return pa.$lte;
    for (const k of Object.keys(cur)) stack.push((cur as any)[k]);
  }
  return undefined;
}

/** 从 $and 里找出"排除隐藏文章"那一支（形状核实自 getAll 的实现） */
function findHiddenClause(filter: any): any {
  const and = filter?.$and;
  if (!Array.isArray(and)) return undefined;
  return and.find(
    (c: any) => Array.isArray(c?.$or) && c.$or.some((o: any) => o && 'hidden' in o),
  );
}

/** 把文章数组接到一个真 TagProvider 上（TagProvider 侧用真实现，只替换它的 articleProvider） */
function makeTagProvider(articleProvider: ArticleProvider): TagProvider {
  const p = Object.create(TagProvider.prototype) as TagProvider;
  (p as any).articleProvider = articleProvider;
  return p;
}

/**
 * 🔴 **改前实现的参照**（parity 尺子）：`Object.keys(分组).sort(localeCompare)`。
 * 这不是"我的假设"，而是逐字照抄改动前的两行：
 *   const d = await this.getTagsWithArticle(includeHidden);
 *   return Object.keys(d).sort((a, b) => a.localeCompare(b));
 * 分组部分同样照抄 `getTagsWithArticle` 的 `forEach`（含它**裸** `a.tags.forEach`，
 * 即改前遇到没有 tags 的文档会抛 —— 那条差异本文件另有专门用例）。
 */
function legacyGetAllTags(articles: any[]): string[] {
  const data: Record<string, any[]> = {};
  articles.forEach((a) => {
    a.tags.forEach((t) => {
      if (!Object.keys(data).includes(t)) data[t] = [a];
      else data[t].push(a);
    });
  });
  return Object.keys(data).sort((a, b) => a.localeCompare(b));
}

const SAMPLES: Array<{ name: string; articles: any[] }> = [
  { name: '空库', articles: [] },
  { name: '单篇单标签', articles: [{ id: 1, tags: ['甲'] }] },
  {
    name: '多篇 + 重复标签（去重）',
    articles: [
      { id: 1, tags: ['乙', '甲'] },
      { id: 2, tags: ['甲', '丙'] },
      { id: 3, tags: ['乙'] },
    ],
  },
  {
    name: 'CJK 与 ASCII 混排（排序口径敏感）',
    articles: [
      { id: 1, tags: ['中', 'b', 'A', '甲'] },
      { id: 2, tags: ['z', '乙'] },
    ],
  },
  {
    name: '含空标签数组',
    articles: [
      { id: 1, tags: [] },
      { id: 2, tags: ['丁'] },
    ],
  },
];

describe('getAllTags：窄投影后**返回值与改前逐字相同**（parity）', () => {
  it.each(SAMPLES)('$name：与改前实现逐字相同（内容与顺序）', async ({ articles }) => {
    const { provider, seen } = makeArticleProviderWithFakeModel(articles);
    const tagProvider = makeTagProvider(provider);
    const actual = await tagProvider.getAllTags(false);
    // 替身自检：真的发了一次查询，否则"结果相同"可能是因为什么都没跑
    expect(seen).toHaveLength(1);
    expect(actual).toEqual(legacyGetAllTags(articles));
  });

  it('🔴 排序口径必须是 localeCompare，不是默认 sort()（用户可见的标签顺序）', async () => {
    // ['C','b'] 在任何 ICU locale 下 localeCompare 都给出 ['b','C']（大小写是三级差异，
    // 主差异是 b<c），而默认 sort() 按 UTF-16 码元给出 ['C','b']（'C'=67 < 'b'=98）
    // ⇒ 这一组输入能在**任何** locale 下区分两种口径，不依赖测试环境的语言设置。
    const { provider } = makeArticleProviderWithFakeModel([{ id: 1, tags: ['C', 'b'] }]);
    const actual = await makeTagProvider(provider).getAllTags(false);
    expect(actual).toEqual(['b', 'C']);
    expect(actual).not.toEqual(['C', 'b']); // ← 默认 sort() 的结果，必须不同
  });

  it('🔴 文档缺 tags 字段时**不崩**（窄投影下 Mongoose 读时不补默认值）', async () => {
    const { provider } = makeArticleProviderWithFakeModel([
      { id: 1 }, // 没有 tags
      { id: 2, tags: ['甲'] },
      { id: 3, tags: undefined },
    ]);
    const actual = await makeTagProvider(provider).getAllTags(false);
    expect(actual).toEqual(['甲']);
  });

  it('⚠️ 对照：`getTagsWithArticle` 仍是**裸** `a.tags.forEach`（本方法刻意没照抄那个形状）', async () => {
    // 这条钉住"两个方法的容错口径不同"是**有意的**：getTagsWithArticle 的行为一个字都不许变
    // （它有 3 个消费者依赖完整文章），而 getAllTags 换投影后必须自己容错。
    const { provider } = makeArticleProviderWithFakeModel([{ id: 1 }]);
    await expect(
      makeTagProvider(provider).getTagsWithArticle(false),
    ).rejects.toThrow();
  });
});

describe('🔴 安全：tagsOnly 只换投影，**过滤语义逐字不变**（真实 getAll + 假 model）', () => {
  it('公开路径：tagsOnly 与宽投影发出的 filter **逐字相同**，且确实排除隐藏文章与未到点文章', async () => {
    const wide = makeArticleProviderWithFakeModel();
    const narrow = makeArticleProviderWithFakeModel();
    await wide.provider.getAll('list', false);
    await narrow.provider.getAll('tagsOnly', false);
    // 替身自检：两边都真的发了一次查询
    expect(wide.seen).toHaveLength(1);
    expect(narrow.seen).toHaveLength(1);
    // 🔴 核心：过滤条件完全一致 ⇒ 换投影不可能让隐藏/未到点文章漏进公开标签列表。
    // ⚠️ 必须归一化 `publishAt.$lte`：它是墙上时钟，两次调用跨毫秒就会假红（见 normalizePublishAt）。
    expect(normalizePublishAt(narrow.seen[0].filter)).toEqual(
      normalizePublishAt(wide.seen[0].filter),
    );
    // 归一化的反面守卫：两边的 `$lte` 都**真的存在**、都是 Date、且相差在 60 秒内
    // ⇒ 证明"相等"不是因为一边缺了这个子句而被归一化藏掉。
    const nLte = extractPublishAtLte(narrow.seen[0].filter);
    const wLte = extractPublishAtLte(wide.seen[0].filter);
    expect(nLte).toBeInstanceOf(Date);
    expect(wLte).toBeInstanceOf(Date);
    expect(Math.abs(nLte.getTime() - wLte.getTime())).toBeLessThan(60_000);
    // 且这一致的过滤里**确实**有隐藏排除子句（否则上面那条 toEqual 可能在比两个都没过滤的东西）
    const hidden = findHiddenClause(narrow.seen[0].filter);
    expect(hidden).toBeDefined();
    expect(hidden.$or).toEqual([{ hidden: false }, { hidden: { $exists: false } }]);
    // 定时发布过滤也必须在（publishAt.ts 头注释：漏一条就是泄露）
    const and = narrow.seen[0].filter.$and;
    expect(and.length).toBeGreaterThanOrEqual(3); // deleted + hidden + publishAt
    expect(JSON.stringify(and[and.length - 1])).toContain('publishAt');
  });

  it('🔴 投影确实变窄：发给 model 的 projection **恰好**是 { tags: 1, _id: 0 }', async () => {
    const { provider, seen } = makeArticleProviderWithFakeModel();
    await provider.getAll('tagsOnly', false);
    expect(seen).toHaveLength(1);
    // 用 toEqual 而不是 toMatchObject：多一个字段（例如顺手带上 id/title）就该红
    expect(seen[0].projection).toEqual({ tags: 1, _id: 0 });
    // 尺子有效性反证：宽投影确实比它宽得多（否则"变窄"无从谈起）
    const wide = makeArticleProviderWithFakeModel();
    await wide.provider.getAll('list', false);
    expect(Object.keys(wide.seen[0].projection).length).toBeGreaterThan(
      Object.keys(seen[0].projection).length,
    );
    expect(wide.seen[0].projection.title).toBe(1);
    expect(seen[0].projection.title).toBeUndefined();
  });

  it.each([
    [false, 'getAllTags(false)'],
    [true, 'getAllTags(true)'],
  ])('includeHidden 原样传递到 getAll：%s（%s）', async (includeHidden) => {
    const { provider, seen } = makeArticleProviderWithFakeModel([]);
    await makeTagProvider(provider).getAllTags(includeHidden as boolean);
    expect(seen).toHaveLength(1);
    // filter 里"有没有隐藏排除子句"必须跟着 includeHidden 走：
    // false ⇒ 有（公开面不许看到隐藏文章）；true ⇒ 没有（后台必须看得到）
    if (includeHidden) {
      expect(findHiddenClause(seen[0].filter)).toBeUndefined();
    } else {
      expect(findHiddenClause(seen[0].filter)).toBeDefined();
    }
  });

  it('🔴 源码级：getAllTags 走 tagsOnly、**不再**经 getTagsWithArticle、且 includeHidden 是变量不是字面量', () => {
    const src = stripCommentsForAnchor(read('provider/tag/tag.provider.ts'));
    const start = src.indexOf('async getAllTags(includeHidden: boolean)');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('async getColumnData', start));
    expect(block.length).toBeGreaterThan(40); // 尺子有效性：真的切到了一段代码
    expect(block).toMatch(/getAll\(\s*'tagsOnly',\s*includeHidden\s*\)/);
    // ⚠️ 不许写成 getAll('tagsOnly', false)（管理端会看不到隐藏文章的标签）
    //    也不许写成 getAll('tagsOnly', true)（公开标签列表会泄漏隐藏文章）
    expect(block).not.toMatch(/getAll\(\s*'tagsOnly',\s*(false|true)\s*\)/);
    // 🔴 不许退回经 getTagsWithArticle（那就是这次要消除的白传）
    expect(block).not.toContain('getTagsWithArticle');
    // 排序口径钉在源码上（行为层已另有用例，这里防"换成默认 sort()"的漂移）
    expect(block).toMatch(/localeCompare/);
  });

  it('🔴 为什么不让 TagProvider 自己注入 model：那条推理必须留在代码注释里', () => {
    // 注释里必须写清"过滤逻辑长在 getAll 里、复制它 = 静默信息暴露"，
    // 否则下一个人会想"既然只要 tags，不如自己 find 一下"。
    // ⚠️ 这条断言的是**未剥注释**的原文（它钉的正是注释本身）。
    const raw = read('provider/tag/tag.provider.ts');
    expect(raw).toContain('宁可多传字段，也不复制过滤逻辑');
    expect(raw).toContain('漏一条就是泄露');
    // 反证：这段推理不在别的文件里凑数（它必须在 getAllTags 的上方）
    const at = raw.indexOf('宁可多传字段，也不复制过滤逻辑');
    const fn = raw.indexOf('async getAllTags(');
    expect(at).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(at); // 注释在函数之前
  });
});

describe('tagsOnlyView 投影形状', () => {
  it('恰好只有 tags 与 _id:0 —— 不含 id/title/content/password/hidden', () => {
    const p: any = makeRealArticleProvider();
    expect(p.tagsOnlyView).toEqual({ tags: 1, _id: 0 });
    for (const k of ['id', 'title', 'content', 'password', 'hidden', 'lastVisitedTime', 'wordCount']) {
      expect(p.tagsOnlyView[k]).toBeUndefined();
    }
    // 尺子有效性反证：这些字段在别的投影里确实存在（否则上面的 undefined 是废断言）
    expect(p.adminView.password).toBe(1);
    expect(p.listView.title).toBe(1);
  });

  it('🔴 getView("tagsOnly") 分派到 tagsOnlyView，且兜底**仍是** slimListView（不许被顺手改成 tagsOnlyView）', () => {
    const p: any = makeRealArticleProvider();
    expect(p.getView('tagsOnly')).toBe(p.tagsOnlyView);
    const fallback = p.getView('not-a-real-view');
    expect(fallback).toBe(p.slimListView);
    expect(fallback).not.toBe(p.tagsOnlyView);
    // 漏 case 的失败方向必须是"少发几个字段"而不是"只发 tags"
    expect(fallback.title).toBe(1);
    expect(fallback.password).toBeUndefined();
  });

  it('源码级：case 存在，且兜底那行仍是 slimListView', () => {
    const src = stripCommentsForAnchor(read('provider/article/article.provider.ts'));
    const block = src.slice(
      src.indexOf('getView(view: ArticleView) {'),
      src.indexOf('return thisView;'),
    );
    expect(block.length).toBeGreaterThan(40);
    expect(block).toMatch(/case 'tagsOnly':/);
    expect(block).toMatch(/let thisView: any = this\.slimListView;/);
    expect(block).not.toMatch(/let thisView: any = this\.tagsOnlyView;/);
    expect(block).not.toMatch(/let thisView: any = this\.adminView;/);
  });
});

describe('getTagsWithArticle 的默认行为**一个字都没变**（3 个消费者依赖完整文章）', () => {
  it('不传 opts ⇒ 走 list 投影、返回分组映射且元素是完整文章对象', async () => {
    const arts = [
      { id: 1, title: 'A', tags: ['甲', '乙'] },
      { id: 2, title: 'B', tags: ['甲'] },
    ];
    const { provider, seen } = makeArticleProviderWithFakeModel(arts);
    const data: any = await makeTagProvider(provider).getTagsWithArticle(false);
    expect(seen).toHaveLength(1); // 替身自检：真的发了一次查询
    // 投影是 listView（不是 tagsOnly）⇒ 完整字段仍然可用
    expect(seen[0].projection.title).toBe(1);
    expect(seen[0].projection).not.toEqual({ tags: 1, _id: 0 });
    expect(Object.keys(data).sort()).toEqual(['乙', '甲'].sort());
    expect(data['甲']).toHaveLength(2);
    expect(data['甲'][0].title).toBe('A'); // 🔴 元素仍是完整文章（getColumnData 要 length、getArticlesByTag 要文章）
  });

  it('源码级：getTagsWithArticle 仍然只用 list/listSlim 两种视图，没有 tagsOnly', () => {
    const src = stripCommentsForAnchor(read('provider/tag/tag.provider.ts'));
    const start = src.indexOf('async getTagsWithArticle(');
    const block = src.slice(start, src.indexOf('async getAllTags(', start));
    expect(block.length).toBeGreaterThan(40);
    expect(block).toMatch(/slim \? 'listSlim' : 'list'/);
    expect(block).not.toContain('tagsOnly');
  });
});
