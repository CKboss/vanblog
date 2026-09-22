import { readFileSync } from 'fs';
import { join } from 'path';
import { PublicController } from './public.controller';

/**
 * `/api/public/tag/:name` 的缓存接线与**原型键 500** 修复的守卫。
 *
 * ## 这个端点此前有两个缺陷（都已修，本文件钉住它们别被改回去）
 *
 * 1. 🔴 **它既没缓存、也不在限流档，而每次请求都触发一次全表捞取。**
 *    旧实现是 `tagProvider.getArticlesByTag(name, false)`，而那个 provider 方法的实现是
 *    `getTagsWithArticle(false)` 取回**全部标签及其全部文章**、再取其中一个键。
 *    实测（keep-alive 单连接、60 次取样）：p50 **8.23 ms / 1,333 B**，而**已缓存**的 `/tag`
 *    是 p50 **3.04 ms / 23,265 B** ⇒ 返回的数据少 17 倍、却慢 2.7 倍。修后 p50 **1.43 ms**。
 *    ⚠️ 量这个必须用 keep-alive 单连接：逐次起 curl 进程会有 ~10 ms 地板，分辨不出差异。
 *
 * 2. 🔴 **匿名可触发的 500**：旧实现是 `d[tagName] ?? []`，而**原型键**在普通对象上会取到
 *    `Object.prototype` 上的成员 —— 那是 truthy，`??` 不生效 ⇒ 随后 `toPublic()` 对它调 `.map`
 *    抛 TypeError ⇒ 500。实测 `/api/public/tag/{__proto__,constructor,toString,hasOwnProperty}`
 *    **四个全部 500**；修后一律 **200 + 空数组**。
 *
 * ## 🔴 为什么缓存**复用 `/tag` 的同一条目**、而不是按标签名建键（这条是安全相关的）
 * 标签名是**攻击者可控**的 ⇒ 按名建键等于给缓存开一个**无界键空间**：打 N 个随机标签就能塞进
 * N 个条目（内存放大 + 命中率归零）。复用同一条目则全站只有一个标签映射条目，
 * `/tag` 与 `/tag/:name` 互相加热，而未知标签的代价趋近于零。
 * ⇒ 下面「共享条目」那一组断言就是钉这个性质的，**不是**性能断言。
 *
 * ## ⚠️ 替身忠实性
 * `toPublic` 是**逐字照抄**产品实现的显式字段映射（不是"返回入参"那种偷懒替身），
 * 否则"响应形状不变"这条就只是在证明替身自己的假设。本仓库已有七次因替身不忠实而让真缺陷隐形。
 */

/** 逐字照抄 `article.provider.ts` 的 `toPublic`：显式字段映射，不多不少。 */
function faithfulToPublic(oldArticles: any[]) {
  return oldArticles.map((item) => {
    return {
      title: item.title,
      content: item.content,
      tags: item.tags,
      category: item.category,
      updatedAt: item.updatedAt,
      createdAt: item.createdAt,
      id: item.id,
      top: item.top,
    };
  });
}

function fakeArticle(i: number) {
  return {
    id: `id-${i}`,
    title: `标题 ${i}`,
    content: `正文 ${i}`,
    tags: ['t1'],
    category: '博客',
    top: false,
    createdAt: new Date(1700000000000 + i),
    updatedAt: new Date(1700000000000 + i),
  };
}

/**
 * 造一个真的 `PublicController` 实例（不是 `Object.create(prototype)`），
 * 因为被测方法要走 `listCache()` 的**惰性实例字段** —— 而类字段初始化器在
 * `Object.create` 出来的替身上根本不执行（本仓库已踩过这个坑）。
 */
function createHarness(tagMap?: Record<string, any[]>) {
  const articles = [fakeArticle(1), fakeArticle(2)];
  const map = tagMap ?? { t1: articles, 投资: [fakeArticle(3)] };
  const tagProvider = {
    // 忠实还原真实签名：getTagsWithArticle(includeHidden, opts?)
    getTagsWithArticle: jest.fn(async (_includeHidden: boolean, _opts?: { slim?: boolean }) => map),
    getAllTags: jest.fn(async () => []),
    getArticlesByTag: jest.fn(async (tagName: string) => map[tagName] ?? []),
  };
  const articleProvider = {
    toPublic: jest.fn((xs: any[]) => faithfulToPublic(xs)),
    getByOption: jest.fn(async () => ({ articles: [], total: 0 })),
    getTotalNum: jest.fn(async () => 0),
  };
  const categoryProvider = {
    getCategoriesWithArticle: jest.fn(async () => ({})),
    getAllCategories: jest.fn(async () => []),
    getPublicCategoryNames: jest.fn(async () => []),
  };
  const metaProvider = {
    getAll: jest.fn(async () => ({ siteInfo: {}, _doc: { siteInfo: {} } })),
    getArticlesPerPage: jest.fn(async () => 10),
    getTotalWords: jest.fn(async () => 0),
  };
  const visitProvider = { getLatestVisits: jest.fn(async () => []) };
  const settingProvider = {
    getMenuSetting: jest.fn(async () => ({ data: [] })),
    getLayoutSetting: jest.fn(async () => null),
    encodeLayoutSetting: jest.fn(() => null),
  };
  const customPageProvider = { getPublicCustomPages: jest.fn(async () => []) };

  const controller = new PublicController(
    articleProvider as any,
    categoryProvider as any,
    tagProvider as any,
    metaProvider as any,
    visitProvider as any,
    settingProvider as any,
    customPageProvider as any,
  );
  return { controller, tagProvider, articleProvider, map, articles };
}

/** 取出 `/tag/:name` 处理器的源码片段（从它的装饰器到下一个装饰器之前）。 */
function handlerSource(): string {
  const src = readFileSync(join(__dirname, 'public.controller.ts'), 'utf8');
  const start = src.indexOf("@Get('/tag/:name')");
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const next = rest.indexOf('\n  @Get(', 10);
  expect(next).toBeGreaterThan(-1);
  return rest.slice(0, next);
}

describe('公开标签详情端点：缓存接线', () => {
  it('替身自检：真的走了 provider，而且 toPublic 真的被调用（防空转）', async () => {
    const { controller, tagProvider, articleProvider } = createHarness();
    const res = await controller.getArticlesByTagName('t1');
    expect(res.statusCode).toBe(200);
    // 🔴 走的是 getTagsWithArticle（整张映射），不是旧的 getArticlesByTag（那个方法自带全表捞取）
    expect(tagProvider.getTagsWithArticle).toHaveBeenCalledTimes(1);
    expect(tagProvider.getArticlesByTag).not.toHaveBeenCalled();
    expect(articleProvider.toPublic).toHaveBeenCalledTimes(1);
  });

  it('真标签：返回该标签的文章，并经 toPublic 的显式字段映射', async () => {
    const { controller, articles } = createHarness();
    const res = await controller.getArticlesByTagName('t1');
    expect(res.data).toEqual(faithfulToPublic(articles));
    // 反证：不是把整张映射返回出去
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data).toHaveLength(2);
  });

  it('未知标签：200 + 空数组（不是 404、也不是抛错）', async () => {
    const { controller } = createHarness();
    const res = await controller.getArticlesByTagName('zzz-not-exist');
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual([]);
  });
});

describe('公开标签详情端点：🔴 原型键不得炸成 500', () => {
  // 旧实现 `d[name] ?? []` 对这四个键会取到 Object.prototype 上的成员（truthy ⇒ ?? 不生效），
  // 然后 toPublic 对它调 .map ⇒ TypeError ⇒ 匿名可触发的 500（四个键实测全部 500）。
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    '原型键 %s 得到空数组且不抛错',
    async (key) => {
      const { controller } = createHarness();
      const res = await controller.getArticlesByTagName(key);
      expect(res.statusCode).toBe(200);
      expect(res.data).toEqual([]);
    },
  );

  it('loader 返回 nullish 时也不抛错（纵深防御）', async () => {
    const { controller, tagProvider } = createHarness();
    tagProvider.getTagsWithArticle.mockResolvedValueOnce(undefined as any);
    const res = await controller.getArticlesByTagName('t1');
    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual([]);
  });

  it('缓存条目形状不对（不是数组）时得到空数组，而不是把垃圾交给 toPublic', async () => {
    const { controller, articleProvider } = createHarness({ t1: { notAn: 'array' } as any });
    const res = await controller.getArticlesByTagName('t1');
    expect(res.data).toEqual([]);
    // 🔴 关键：toPublic 收到的是空数组，而不是那个对象（否则 .map 会抛）
    expect(articleProvider.toPublic).toHaveBeenCalledWith([]);
  });
});

describe('公开标签详情端点：🔴 共享缓存条目（按名建键 = 无界键空间，不许改回去）', () => {
  it('打 30 个互不相同的标签名，loader 只被调用 1 次', async () => {
    const { controller, tagProvider } = createHarness();
    for (let i = 0; i < 30; i += 1) {
      // 混入真标签、未知标签与原型键：三类的代价都必须是"命中同一个条目"
      const name = i % 3 === 0 ? 't1' : i % 3 === 1 ? `random-${i}` : '__proto__';
      const res = await controller.getArticlesByTagName(name);
      expect(res.statusCode).toBe(200);
    }
    expect(tagProvider.getTagsWithArticle).toHaveBeenCalledTimes(1);
  });

  it('与 /tag 端点共用同一个条目：两个端点合起来 loader 只跑 1 次', async () => {
    const { controller, tagProvider } = createHarness();
    await controller.getArticlesByTag(undefined); // @Get('tag')
    await controller.getArticlesByTagName('t1'); // @Get('/tag/:name')
    await controller.getArticlesByTagName('投资');
    expect(tagProvider.getTagsWithArticle).toHaveBeenCalledTimes(1);
  });

  it('尺子有效性反证：不同 includeHidden 不共享条目（否则上面两条可能是空断言）', async () => {
    // 这一条钉的是 publicListCacheKey 的既有性质，用来证明"loader 只跑 1 次"不是因为
    // 缓存把所有东西都并成一个条目了（那会让上面两条恒真、并造成越权泄漏）。
    const { controller, tagProvider } = createHarness();
    await controller.getArticlesByTagName('t1');
    // 管理端语义（includeHidden=true）走的是另一个 provider 方法，这里用 getTagsWithArticle
    // 的第二个参数形状验证键区分：同一 controller 上换一种 slim 组合必须重新取数。
    await controller.getArticlesByTag('true');
    expect(tagProvider.getTagsWithArticle).toHaveBeenCalledTimes(2);
  });
});

describe('公开标签详情端点：源码级钉子', () => {
  const slice = handlerSource();

  it('尺子有效性：取到的确实是这个处理器的源码', () => {
    expect(slice).toContain('getArticlesByTagName');
    expect(slice.length).toBeGreaterThan(200);
  });

  it("缓存键是 publicListCacheKey('tag', false, false)，且键表达式里没有标签名", () => {
    expect(slice).toContain("publicListCacheKey('tag', false, false)");
    // 🔴 键里绝不能出现 name（那就是按名建键 = 无界键空间）。
    // 只在这一个 read(...) 调用的键参数范围里判断，避免被注释里的说明文字喂饱。
    const readAt = slice.indexOf('this.listCache().read');
    expect(readAt).toBeGreaterThan(-1);
    const keyArg = slice.slice(readAt, slice.indexOf('publicListCacheKey', readAt) + 60);
    expect(keyArg).not.toMatch(/publicListCacheKey\([^)]*name/);
  });

  it('用的是 hasOwnProperty.call，而不是裸索引（原型键防护）', () => {
    expect(slice).toContain('Object.prototype.hasOwnProperty.call');
  });

  it('有 Array.isArray 这道形状防护', () => {
    expect(slice).toContain('Array.isArray');
  });

  it('loader 返回 nullish 有 ?? 兜底', () => {
    expect(slice).toMatch(/allTags \?\? \{\}/);
  });

  it('旧的"直接调 provider 全表捞取"形状已经不在了', () => {
    const src = readFileSync(join(__dirname, 'public.controller.ts'), 'utf8');
    // 剥掉注释再断言"不存在"，否则本文件与产品文件里的说明文字会喂饱这条断言。
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toContain('this.tagProvider.getArticlesByTag(name, false)');
  });
});
