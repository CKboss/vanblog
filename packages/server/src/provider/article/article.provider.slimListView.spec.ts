/**
 * 公开列表的**精简投影**（`view: 'listSlim'` / `ArticleProvider.slimListView`）与它的接线。
 *
 * ## 这条投影解决什么
 * `/api/public/category`、`/api/public/tag`、`/api/public/timeline` 每篇文章都带 16 个字段，
 * 其中三个在**公开响应里没有任何消费者**（逐个核实过，见 `slimListView` 的注释）：
 *   - `hidden`：公开列表路径一律带 `hidden:false` 过滤 ⇒ 响应里**恒为 false**（实测 53/53），零信息量；
 *   - `lastVisitedTime`：访问台账，前台不显示（sitemap 的 lastmod 用 `updatedAt || createdAt`）；
 *   - `wordCount`：前台要的阅读时长是服务端算好的 `readingMinutes`，搜索索引走的是 `publicView`
 *     且本来就有"取不到就现算"的回落。
 * 实测这三个字段占 `/api/public/category` 响应的 **19.2%**（3,882 B / 20,255 B，53 篇）。
 *
 * ## 三条必须钉住的性质
 *  1. **默认不变**（向后兼容）：`/api/public/category` 是公开接口，第三方主题/脚本可能在调它，
 *     所以精简**必须显式 opt-in**；不传参数时响应形状与体积要与改动前**逐字节一致**
 *     （活体实测：不传 = 22,131 B / 16 字段 = 改动前基线；`?toListView=true` = 18,090 B / 13 字段）。
 *  2. 🔴 **`includeHidden=true` 时强制忽略 slim**：精简投影不含 `hidden`，而管理端正是靠它显示
 *     "这篇是隐藏的"。两者同时生效会让后台拿到一批**无法区分可见性**的文章 —— 静默的错答案，
 *     比多传几个字段糟得多。
 *  3. 🔴 **`getView` 的兜底必须 fail-closed**：它以前默认返回 `adminView`（唯一 select 了
 *     `password` 的投影）。今天不可达（五个 case 覆盖全部 union 成员、调用方都传字面量；
 *     第五个 `'tagsOnly'` 是 2026-09-21 为 `TagProvider.getAllTags()` 加的窄投影），
 *     但"投影选择器的兜底是最宽投影"是只要有人加一个 view 忘了加 case 就静默成立的形状，
 *     而失败方向是**多下发字段**。
 *
 * ⚠️ 替身说明：`ArticleProvider` 用 `new`（四个构造参数，后三个可以是空对象）—— 因为要测的
 *    `slimListView`/`listView` 是**类属性初始化器**的产物，`Object.create(prototype)` 拿不到它们
 *    （本仓库既有做法，见 `article.provider.spec.ts:46`）。`CategoryProvider` 同理需要属性，
 *    但它的方法只用到注入的 `articleProvider`，所以用 `Object.create` + 手工挂字段即可。
 */
import { ArticleProvider } from './article.provider';
import { CategoryProvider } from '../category/category.provider';
import { PublicController } from 'src/controller/public/public.controller';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import * as fs from 'fs';
import * as path from 'path';

/** 精简投影相对 listView **应当少掉**的三个字段（逐个点名，不许用"少几个"这种模糊断言） */
const DROPPED = ['hidden', 'lastVisitedTime', 'wordCount'] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8');
}

function makeProvider(): ArticleProvider {
  // 后三个依赖在本文件测的路径上用不到（只读投影与 getView），给空对象即可
  return new ArticleProvider({} as any, {} as any, {} as any, {} as any);
}

/** 造一个只记录 getAll 调用的 CategoryProvider 替身 */
function makeCategorySpy() {
  const calls: Array<{ view: string; includeHidden: boolean; includeDelete: unknown }> = [];
  const provider = Object.create(CategoryProvider.prototype) as CategoryProvider;
  (provider as any).articleProvider = {
    getAll: async (view: string, includeHidden: boolean, includeDelete?: unknown) => {
      calls.push({ view, includeHidden, includeDelete });
      return [];
    },
  };
  // getAllCategories 会读 categoryModal；返回空数组即可（分组结果为空对象）
  (provider as any).categoryModal = { find: async () => [] };
  return { provider, calls };
}

/** 造一个只记录 getCategoriesWithArticle 入参的 PublicController 替身 */
function makeControllerSpy() {
  const calls: Array<{ includeHidden: boolean; opts: unknown }> = [];
  const controller = Object.create(PublicController.prototype) as PublicController;
  (controller as any).categoryProvider = {
    getCategoriesWithArticle: async (includeHidden: boolean, opts?: unknown) => {
      calls.push({ includeHidden, opts });
      return {};
    },
  };
  return { controller, calls };
}

describe('slimListView：投影形状（相对 listView 恰好少三个字段）', () => {
  it('⚠️ 替身/前提自检：listView 确实含这三个字段，且 slim 确实是对象（否则下面全是空转）', () => {
    const p = makeProvider();
    expect(p.listView).toBeTruthy();
    expect(p.slimListView).toBeTruthy();
    for (const f of DROPPED) {
      // 这条是**尺子有效性**：如果 listView 本来就没有某字段，"slim 不含它"就是废断言
      expect([f, (p.listView as any)[f]]).toEqual([f, 1]);
    }
  });

  it('🔴 slim 相对 listView 恰好少 hidden / lastVisitedTime / wordCount（不多不少）', () => {
    const p = makeProvider();
    const listKeys = Object.keys(p.listView);
    const slimKeys = Object.keys(p.slimListView);
    const missing = listKeys.filter((k) => !slimKeys.includes(k)).sort();
    expect(missing).toEqual([...DROPPED].sort());
    const extra = slimKeys.filter((k) => !listKeys.includes(k));
    expect(extra).toEqual([]); // slim ⊂ listView：不许凭空多出一个 listView 没有的字段
  });

  it('slim 与 listView 共有的键取值一致（都是 1，只有 _id 是 0）', () => {
    const p = makeProvider();
    for (const [k, v] of Object.entries(p.slimListView)) {
      expect([k, v, (p.listView as any)[k]]).toEqual([k, v, v]);
    }
    expect((p.slimListView as any)._id).toBe(0); // 仍然排除 Mongo 的 _id
  });

  it('🔴 反向：slim 不含 content / password（它是**列表**投影，绝不能变成全文或带密码）', () => {
    const p = makeProvider();
    const slim = p.slimListView as any;
    expect(slim.content).toBeUndefined();
    expect(slim.password).toBeUndefined();
  });

  it('🔴 防"裁过头"：分组必需的 tags 与 category 必须保留（否则 /tag 与 /category 直接坏掉）', () => {
    // `tag.provider.getTagsWithArticle` 读 `a.tags` 做分组，
    // `category.provider.getCategoriesWithArticle` 读 `a.category` 做分组。
    // 少任何一个，响应都会变成"一个空分组"—— 而且不报错。
    const p = makeProvider();
    expect((p.slimListView as any).tags).toBe(1);
    expect((p.slimListView as any).category).toBe(1);
  });

  it('卡片/列表真要用的字段一个没少（id/pathname/title/createdAt/updatedAt/top/private/viewer/visited/author/cover/copyright）', () => {
    const p = makeProvider();
    for (const f of [
      'id',
      'pathname',
      'title',
      'createdAt',
      'updatedAt',
      'top',
      'private',
      'viewer',
      'visited',
      'author',
      'cover',
      'copyright',
    ]) {
      expect([f, (p.slimListView as any)[f]]).toEqual([f, 1]);
    }
  });

  it('⚠️ 没有动到别的投影：adminListView 仍带 password，publicView 仍带 hidden', () => {
    const p = makeProvider();
    expect((p.adminListView as any).password).toBe(1);
    expect((p.publicView as any).hidden).toBe(1); // 详情路径的形状本轮不变
    expect((p.deletedListView as any).wordCount).toBe(1); // 回收站要字数
  });
});

describe('getView：分派正确，且兜底 fail-closed', () => {
  it('五个 view 各归各的投影（同一对象引用，不是"形状像"）', () => {
    const p = makeProvider();
    expect(p.getView('listSlim')).toBe(p.slimListView as any);
    expect(p.getView('list')).toBe(p.listView as any);
    expect(p.getView('admin')).toBe(p.adminView as any);
    expect(p.getView('public')).toBe(p.publicView as any);
    // 🔴 2026-09-21 新增：`tagsOnly` 必须分派到它自己的窄投影，
    //    而且**不能**与别的投影是同一个对象（否则"窄"就是假的）。
    expect(p.getView('tagsOnly')).toBe(p.tagsOnlyView as any);
    expect(p.getView('tagsOnly')).not.toBe(p.listView as any);
    expect(p.getView('tagsOnly')).not.toBe(p.slimListView as any);
  });

  it('🔴 未知 view 兜底到**最窄**的公开投影：不含 password、不含 content', () => {
    const p = makeProvider();
    const fallback: any = p.getView('not-a-real-view' as any);
    expect(fallback).toBe(p.slimListView as any);
    expect(fallback.password).toBeUndefined();
    expect(fallback.content).toBeUndefined();
    // 反证：adminView 确实含 password（否则上面两条 not.toBeUndefined 是废断言）
    expect((p.adminView as any).password).toBe(1);
  });
});

describe('CategoryProvider.getCategoriesWithArticle：slim 的接线与不变量', () => {
  it('⚠️ 替身自检：getAll 真的被调用并记录下来（否则下面的断言全是空转）', async () => {
    const { provider, calls } = makeCategorySpy();
    await provider.getCategoriesWithArticle(false);
    expect(calls.length).toBe(1);
  });

  it('默认（不传 opts）⇒ 仍用 list 视图：响应形状与改动前一致', async () => {
    const { provider, calls } = makeCategorySpy();
    await provider.getCategoriesWithArticle(false);
    expect(calls[0]).toEqual({ view: 'list', includeHidden: false, includeDelete: undefined });
  });

  it('opts.slim=true 且 includeHidden=false ⇒ 用 listSlim', async () => {
    const { provider, calls } = makeCategorySpy();
    await provider.getCategoriesWithArticle(false, { slim: true });
    expect(calls[0].view).toBe('listSlim');
    expect(calls[0].includeHidden).toBe(false);
  });

  it('🔴 不变量：includeHidden=true 时**忽略** slim（管理端必须能看到 hidden 标记）', async () => {
    const { provider, calls } = makeCategorySpy();
    await provider.getCategoriesWithArticle(true, { slim: true });
    expect(calls[0]).toEqual({ view: 'list', includeHidden: true, includeDelete: undefined });
  });

  it('opts.slim=false / 空对象 ⇒ 与默认一致（严格 true 才生效）', async () => {
    for (const opts of [{ slim: false }, {}, { slim: 'true' as any }, { slim: 1 as any }]) {
      const { provider, calls } = makeCategorySpy();
      await provider.getCategoriesWithArticle(false, opts);
      expect([JSON.stringify(opts), calls[0].view]).toEqual([JSON.stringify(opts), 'list']);
    }
  });
});

describe('PublicController /api/public/category：toListView 的布尔口径（严格 isTrue）', () => {
  it('⚠️ 替身自检：controller 真的把入参透传给了 provider', async () => {
    const { controller, calls } = makeControllerSpy();
    await (controller as any).getArticlesByCategory(undefined);
    expect(calls.length).toBe(1);
    expect(calls[0].includeHidden).toBe(false); // 公开端点永远不含隐藏文章
  });

  it("🔴 只有 true / 'true' 会精简；缺省与一切其它值都落回今天的完整形状", async () => {
    const slim: Array<[string, unknown]> = [['true', 'true'], ['boolean true', true]];
    const full: Array<[string, unknown]> = [
      ['缺省', undefined],
      ["'false'", 'false'],
      ["'1'", '1'],
      ['number 1', 1],
      ["'TRUE'", 'TRUE'],
      ["'True'", 'True'],
      ["'yes'", 'yes'],
      ["'on'", 'on'],
      ["''", ''],
      ['null', null],
      ["['true']（数组）", ['true']],
      ['{}（对象）', {}],
    ];
    for (const [label, value] of slim) {
      const { controller, calls } = makeControllerSpy();
      await (controller as any).getArticlesByCategory(value);
      expect([label, calls[0].opts]).toEqual([label, { slim: true }]);
    }
    for (const [label, value] of full) {
      const { controller, calls } = makeControllerSpy();
      await (controller as any).getArticlesByCategory(value);
      // 🔴 这条同时钉住"向后兼容"：任何非严格 true 的输入都必须是 { slim: false }，
      //    也就是与改动前逐字节相同的响应形状。
      expect([label, calls[0].opts]).toEqual([label, { slim: false }]);
    }
  });

  it('🔴 与 /api/public/article 的 toListView **口径不同**这件事被写进了源码（防止有人"顺手统一"）', () => {
    // /article 那边是 `if (option.toListView)` 的真值判断（历史行为，`?toListView=false` 会走列表视图）。
    // 这边用严格 isTrue。两边失败方向不同，所以**不该**被统一 —— 这条断言钉住差异存在，
    // 谁要统一就得先读注释、并且有意识地改掉这条测试。
    const src = stripCommentsForAnchor(read('controller/public/public.controller.ts'));
    const categoryBlock = src.slice(
      src.indexOf('async getArticlesByCategory('),
      src.indexOf("@Get('tag')"),
    );
    expect(categoryBlock.length).toBeGreaterThan(40); // 切片没切空
    expect(categoryBlock).toMatch(/slim: isTrue\(toListView\)/);
    expect(categoryBlock).not.toMatch(/slim: !!toListView/);
    expect(categoryBlock).not.toMatch(/slim: Boolean\(toListView\)/);
    // 反证：/article 那条仍然是真值判断（口径差异确实存在，不是我编的）
    expect(src).toMatch(/const wantsFullContent = !toListView;/);
  });
});

describe('源码接线（剥注释后断言，防"只改了注释"）', () => {
  it('article.provider：listSlim 有 case，且 getView 的兜底是最窄投影', () => {
    const src = stripCommentsForAnchor(read('provider/article/article.provider.ts'));
    expect(src).toMatch(/case 'listSlim':/);
    const getViewBlock = src.slice(
      src.indexOf('getView(view: ArticleView) {'),
      src.indexOf('return thisView;'),
    );
    expect(getViewBlock.length).toBeGreaterThan(40);
    expect(getViewBlock).toMatch(/let thisView: any = this\.slimListView;/);
    expect(getViewBlock).not.toMatch(/let thisView: any = this\.adminView;/);
    // 🔴 2026-09-21 新增两条：
    //  ① `tagsOnly` 必须真的有 case（否则它落到兜底，窄投影就成了死代码，
    //     `getAllTags()` 会静默退回"传 22 个字段"—— 正是这次要消除的白传）；
    //  ② 兜底**不许**被改成 `tagsOnlyView`。漏 case 的失败方向应当是"少发几个字段"
    //     （slimListView，调用方测试抓得到），而不是"只发 tags"（列表页渲染出一堆空对象，
    //     症状离根因很远、更难诊断）。
    expect(getViewBlock).toMatch(/case 'tagsOnly':/);
    expect(getViewBlock).not.toMatch(/let thisView: any = this\.tagsOnlyView;/);
  });

  it("ArticleView 联合类型含 'listSlim'", () => {
    const src = stripCommentsForAnchor(read('provider/article/article.provider.ts'));
    expect(src).toMatch(
      /export type ArticleView = 'admin' \| 'public' \| 'list' \| 'listSlim' \| 'tagsOnly';/,
    );
  });

  it('🔴 slimListView 的字面量里不含那三个字段（剥注释后 —— 注释里当然会提到它们）', () => {
    const raw = read('provider/article/article.provider.ts');
    const start = raw.indexOf('slimListView = {');
    const end = raw.indexOf('toPublic(oldArticles', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start); // 切片有效
    const body = stripCommentsForAnchor(raw.slice(start, end));
    for (const f of DROPPED) {
      expect([f, new RegExp(`${f}:\\s*1`).test(body)]).toEqual([f, false]);
    }
    // 反证：同一段切片里确实能看到保留的字段（证明尺子在量东西，不是切空了）
    expect(body).toMatch(/pathname:\s*1/);
    expect(body).toMatch(/title:\s*1/);
    // 反证：listView 的同名切片里这三个字段**是**存在的（证明"不含"不是因为我切错了地方）
    const lStart = raw.indexOf('listView = {');
    const lEnd = raw.indexOf('deletedListView = {');
    const lBody = stripCommentsForAnchor(raw.slice(lStart, lEnd));
    for (const f of DROPPED) {
      expect([f, new RegExp(`${f}:\\s*1`).test(lBody)]).toEqual([f, true]);
    }
  });

  it('category.provider：slim 与 includeHidden 的互斥写在源码里', () => {
    const src = stripCommentsForAnchor(read('provider/category/category.provider.ts'));
    expect(src).toMatch(/const slim = opts\?\.slim === true && !includeHidden;/);
    expect(src).toMatch(/slim \? 'listSlim' : 'list'/);
  });
});
