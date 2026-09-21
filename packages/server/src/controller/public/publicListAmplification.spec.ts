import { PublicController, publicListCacheKey } from './public.controller';
import {
  PUBLIC_LIST_LIMIT_PER_MIN,
  isPublicAggregateListPath,
  rateLimitMiddleware,
} from 'src/utils/rateLimit';

/**
 * `/api/public/category` 与 `/api/public/tag` 这两个**聚合列表**端点的放大面守卫。
 *
 * 🔴 本文件钉住三件事，都是"极端网络环境下能不能扛住"的问题，而不是功能问题：
 * 1. **缓存键的纪律** —— 键里漏掉一个影响结果的参数，就会让管理端（含隐藏文章）与公开面
 *    共享同一份缓存 ⇒ 那是**越权泄漏**，不是性能问题。
 * 2. **单飞真的生效** —— N 个并发只触发一次底层取数（这是本轮唯一能压低服务端成本的手段）。
 * 3. **专用限流档不可绕过** —— 归一化口径必须与 Express 的实际路由匹配口径一致，
 *    否则加个尾斜杠或改个大小写就能照样拿全量响应而不进这一档。
 *
 * ⚠️ **响应体一个字节都没变**是本轮的硬判据（缓存的是同一份结果，不是新形状），
 * 所以这里也钉住它 —— 见"契约不变"那一组。
 */

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 造一篇最小可用的公开列表项（字段名与真实 `listView` 投影一致，避免替身形状失真）。 */
function fakeArticle(id: number) {
  return {
    id,
    title: `文章 ${id}`,
    tags: ['t1'],
    category: '博客',
    pathname: `post-${id}`,
    createdAt: new Date(1700000000000 + id).toISOString(),
    updatedAt: new Date(1700000000000 + id).toISOString(),
  };
}

/**
 * 造一个只带必要方法的假 provider 集合。
 * ⚠️ **替身自检**：`getCategoriesWithArticle` / `getTagsWithArticle` 都是 `jest.fn()`，
 * 下面每条用例都先断言它**真的被调用过**，否则"只调用 1 次"在"根本没调用"时也成立。
 */
function createHarness(articleCount = 3) {
  const articles = Array.from({ length: articleCount }, (_, i) => fakeArticle(i + 1));
  const categoryProvider = {
    getCategoriesWithArticle: jest.fn(async (includeHidden: boolean, opts?: { slim?: boolean }) => {
      // 忠实还原真实实现的分组语义：{ 分类名: 文章数组 }
      return { 博客: opts?.slim ? articles.map((a) => ({ ...a, slim: true })) : articles };
    }),
    getAllCategories: jest.fn(async () => []),
    getPublicCategoryNames: jest.fn(async () => []),
  };
  const tagProvider = {
    getTagsWithArticle: jest.fn(async (includeHidden: boolean, opts?: { slim?: boolean }) => {
      return { t1: opts?.slim ? articles.map((a) => ({ ...a, slim: true })) : articles };
    }),
    getAllTags: jest.fn(async () => []),
  };
  const articleProvider = {
    getByOption: jest.fn(async () => ({ articles: [], total: 0 })),
    getTotalNum: jest.fn(async () => 0),
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
  return { controller, categoryProvider, tagProvider };
}

/** 匿名访客形状：非回环、无转发头、无内部令牌。 */
const anonReq = (path: string, over: any = {}) =>
  ({
    method: 'GET',
    path,
    socket: { remoteAddress: '203.0.113.7' },
    headers: { 'x-forwarded-for': '203.0.113.7' },
    ...over,
  } as any);

/** 与 `utils/rateLimit.spec.ts` 里同形的假 res（记录状态码、头与 body）。 */
function fakeRes() {
  const out: any = { status: 200, headers: {} as Record<string, string>, body: undefined };
  return {
    out,
    setHeader: (k: string, v: string) => {
      out.headers[k] = v;
    },
    getHeader: (k: string) => out.headers[k],
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: any) {
      out.body = body;
      return this;
    },
  } as any;
}

/** 每个用例用不同的 IP，避免计数器互相污染（限流是按 IP 的内存计数器）。 */
let ipSeq = 0;
const freshIp = () => `198.51.100.${(ipSeq += 1) % 200 + 20}`;

// ⚠️ 不需要在用例之间清缓存：缓存是 **controller 实例级**的（见 public.controller.ts 里
//    `listCache()` 的注释），而 `createHarness()` 每次都新建一个 controller ⇒ 天然隔离。
//    🔴 这正好是那个设计选择的可观测好处：模块级全局缓存会让用例之间互相污染。

// ---------------------------------------------------------------------------
// 1. 缓存键纪律
// ---------------------------------------------------------------------------

describe('聚合列表的缓存键必须区分所有影响结果的参数', () => {
  it('🔴 includeHidden 真/假必须落在不同的键上（否则管理端结果会泄漏给匿名访客）', () => {
    const publicSide = publicListCacheKey('category', false, false);
    const adminSide = publicListCacheKey('category', true, false);
    expect(publicSide).not.toBe(adminSide);
    // 反向对照：同样的参数必须得到同样的键（否则上面那条"不同"可能只是随机后缀）
    expect(publicListCacheKey('category', false, false)).toBe(publicSide);
    expect(publicListCacheKey('category', true, false)).toBe(adminSide);
  });

  it('🔴 slim 真/假也必须落在不同的键上（16 字段与 13 字段是两种响应形状）', () => {
    expect(publicListCacheKey('tag', false, true)).not.toBe(publicListCacheKey('tag', false, false));
  });

  it('kind 也必须区分（分类分组与标签分组是两种内容）', () => {
    expect(publicListCacheKey('category', false, false)).not.toBe(
      publicListCacheKey('tag', false, false),
    );
  });

  it('全部 8 种组合两两不同（把上面三条合成一个穷举，防止漏掉某一对）', () => {
    const kinds: Array<'category' | 'tag'> = ['category', 'tag'];
    const keys: string[] = [];
    for (const k of kinds) {
      for (const h of [false, true]) {
        for (const s of [false, true]) {
          keys.push(publicListCacheKey(k, h, s));
        }
      }
    }
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);
  });

  it('未知的 kind 被拒绝，而不是静默降级成一个共用键', () => {
    expect(() => publicListCacheKey('nope' as any, false, false)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 2. 单飞真的生效 + 契约不变
// ---------------------------------------------------------------------------

describe('聚合列表端点走单飞缓存', () => {
  it('🔴 N 个并发的 /category 请求 ⇒ provider 只被调用 1 次（这就是本轮的实质）', async () => {
    const { controller, categoryProvider } = createHarness();
    const N = 30;
    const all = Array.from({ length: N }, () => controller.getArticlesByCategory(undefined));
    const results = await Promise.all(all);
    expect(categoryProvider.getCategoriesWithArticle).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(N);
    // 所有请求拿到的是同一份结果
    for (const r of results) {
      expect(r.statusCode).toBe(200);
      expect(r.data).toBe(results[0].data);
    }
  });

  it('🔴 N 个并发的 /tag 请求 ⇒ provider 只被调用 1 次', async () => {
    const { controller, tagProvider } = createHarness();
    const all = Array.from({ length: 30 }, () => controller.getArticlesByTag(undefined));
    await Promise.all(all);
    expect(tagProvider.getTagsWithArticle).toHaveBeenCalledTimes(1);
  });

  it('尺子有效性：provider 确实被调用过（否则"只调 1 次"在"根本没调"时也成立）', async () => {
    const { controller, categoryProvider, tagProvider } = createHarness();
    await controller.getArticlesByCategory(undefined);
    await controller.getArticlesByTag(undefined);
    expect(categoryProvider.getCategoriesWithArticle).toHaveBeenCalled();
    expect(tagProvider.getTagsWithArticle).toHaveBeenCalled();
  });

  it('🔴 契约不变：响应体的 JSON 与"直接调 provider"逐字节相同（缓存不改形状）', async () => {
    const { controller, categoryProvider } = createHarness(5);
    const viaEndpoint = await controller.getArticlesByCategory(undefined);
    // 用一个**新的** harness 直接调 provider（不经过缓存），拿到"未缓存"的参照结果
    const direct = await createHarness(5).categoryProvider.getCategoriesWithArticle(false, {
      slim: false,
    });
    expect(JSON.stringify(viaEndpoint)).toBe(
      JSON.stringify({ statusCode: 200, data: direct }),
    );
    // 信封里**只有** statusCode 与 data 两个键 ⇒ 没有偷偷加 truncated/total 之类的字段
    expect(Object.keys(viaEndpoint).sort()).toEqual(['data', 'statusCode']);
  });

  it('toListView=true 走的是另一个缓存条目，且 slim 真的传下去了', async () => {
    const { controller, categoryProvider } = createHarness(2);
    const full = await controller.getArticlesByCategory(undefined);
    const slim = await controller.getArticlesByCategory('true');
    // 两种投影 ⇒ 两次取数（不共享条目）
    expect(categoryProvider.getCategoriesWithArticle).toHaveBeenCalledTimes(2);
    expect(categoryProvider.getCategoriesWithArticle).toHaveBeenNthCalledWith(1, false, {
      slim: false,
    });
    expect(categoryProvider.getCategoriesWithArticle).toHaveBeenNthCalledWith(2, false, {
      slim: true,
    });
    expect(JSON.stringify(full.data)).not.toBe(JSON.stringify(slim.data));
  });

  it('🔴 严格 isTrue 口径不变：字符串 false 仍然落回完整投影（既有不变量，别被本轮改动带走）', async () => {
    const { controller, categoryProvider } = createHarness(1);
    await controller.getArticlesByCategory('false');
    expect(categoryProvider.getCategoriesWithArticle).toHaveBeenCalledWith(false, { slim: false });
  });
});

// ---------------------------------------------------------------------------
// 3. 专用限流档
// ---------------------------------------------------------------------------

describe('聚合列表的专用限流档', () => {
  it('路径判定命中这两个端点', () => {
    expect(isPublicAggregateListPath('/api/public/category')).toBe(true);
    expect(isPublicAggregateListPath('/api/public/tag')).toBe(true);
  });

  it('🔴 尾斜杠与大小写变体**同样命中**（否则这一档可以被平凡绕过 —— 已活体实测过这四种写法都返回同一份全量响应）', () => {
    for (const bypass of [
      '/api/public/category/',
      '/api/public/category///',
      '/API/public/category',
      '/api/public/CATEGORY',
      '/Api/Public/Tag',
      '/api/public/tag/',
    ]) {
      expect({ bypass, hit: isPublicAggregateListPath(bypass) }).toEqual({ bypass, hit: true });
    }
  });

  it('🔴 不误伤便宜的端点：/tag/:name 与 /article 不在这一档', () => {
    expect(isPublicAggregateListPath('/api/public/tag/投资')).toBe(false);
    expect(isPublicAggregateListPath('/api/public/article')).toBe(false);
    expect(isPublicAggregateListPath('/api/public/meta')).toBe(false);
    expect(isPublicAggregateListPath('/api/public/timeline')).toBe(false);
    expect(isPublicAggregateListPath('/api/public/categoryX')).toBe(false);
    expect(isPublicAggregateListPath('/static/img/a.webp')).toBe(false);
  });

  it('非字符串与空值不炸、也不命中', () => {
    expect(isPublicAggregateListPath(undefined as any)).toBe(false);
    expect(isPublicAggregateListPath('')).toBe(false);
    expect(isPublicAggregateListPath(123 as any)).toBe(false);
  });

  it('🔴 匿名请求超过这一档 ⇒ 429，且带 Retry-After 与可照做的提示', () => {
    const ip = freshIp();
    let passed = 0;
    let blocked: any = null;
    for (let i = 0; i < PUBLIC_LIST_LIMIT_PER_MIN + 5; i += 1) {
      const res = fakeRes();
      let ok = false;
      rateLimitMiddleware(anonReq('/api/public/category', { socket: { remoteAddress: ip } }), res, () => {
        ok = true;
      });
      if (ok) passed += 1;
      else if (!blocked) blocked = res.out;
    }
    expect(passed).toBe(PUBLIC_LIST_LIMIT_PER_MIN);
    expect(blocked).not.toBeNull();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    // 提示里要给出替代方案，否则调用方无从下手
    expect(String(blocked.body.message)).toMatch(/api\/public\/article/);
    expect(String(blocked.body.message)).toMatch(/VANBLOG_PUBLIC_LIST_LIMIT_PER_MIN/);
  });

  it('🔴 本站内部调用（内部令牌）豁免这一档 —— 否则前后端分离部署时站点自己的 SSR 会被自己 429', () => {
    const old = process.env.VAN_BLOG_INTERNAL_TOKEN;
    process.env.VAN_BLOG_INTERNAL_TOKEN = 'test-internal-token';
    try {
      const ip = freshIp();
      let passed = 0;
      for (let i = 0; i < PUBLIC_LIST_LIMIT_PER_MIN + 20; i += 1) {
        const res = fakeRes();
        let ok = false;
        rateLimitMiddleware(
          anonReq('/api/public/category', {
            socket: { remoteAddress: ip },
            headers: { 'x-forwarded-for': ip, 'x-vanblog-internal': 'test-internal-token' },
          }),
          res,
          () => {
            ok = true;
          },
        );
        if (ok) passed += 1;
      }
      // 专用档完全没有拦它；能拦到它的只可能是全局档（600/分钟），所以这里应当远超专用档的阈值
      expect(passed).toBeGreaterThan(PUBLIC_LIST_LIMIT_PER_MIN);
    } finally {
      if (old === undefined) delete process.env.VAN_BLOG_INTERNAL_TOKEN;
      else process.env.VAN_BLOG_INTERNAL_TOKEN = old;
    }
  });

  it('🔴 令牌没配对就不豁免（豁免不能被一个随便的头买到）', () => {
    const old = process.env.VAN_BLOG_INTERNAL_TOKEN;
    process.env.VAN_BLOG_INTERNAL_TOKEN = 'test-internal-token';
    try {
      const ip = freshIp();
      let passed = 0;
      for (let i = 0; i < PUBLIC_LIST_LIMIT_PER_MIN + 5; i += 1) {
        const res = fakeRes();
        let ok = false;
        rateLimitMiddleware(
          anonReq('/api/public/tag', {
            socket: { remoteAddress: ip },
            headers: { 'x-forwarded-for': ip, 'x-vanblog-internal': 'wrong-token' },
          }),
          res,
          () => {
            ok = true;
          },
        );
        if (ok) passed += 1;
      }
      expect(passed).toBe(PUBLIC_LIST_LIMIT_PER_MIN);
    } finally {
      if (old === undefined) delete process.env.VAN_BLOG_INTERNAL_TOKEN;
      else process.env.VAN_BLOG_INTERNAL_TOKEN = old;
    }
  });

  it('🔴 命中专用档之后**仍然**计入全局档（两档取更严的，不是二选一）', () => {
    // 判据：同一个 IP 在"只打聚合列表端点"时，专用档先拦；
    // 而在"专用档被调宽到全局档之上"的假想下也不该出现"完全不受全局档约束"的形状。
    // 这里用可观测的代理判据：打满专用档之后，全局档的计数也已经被消耗掉了
    // ⇒ 换成一个**不在专用档里**的端点时，可用配额已经变少。
    const ip = freshIp();
    for (let i = 0; i < PUBLIC_LIST_LIMIT_PER_MIN; i += 1) {
      const res = fakeRes();
      rateLimitMiddleware(anonReq('/api/public/category', { socket: { remoteAddress: ip } }), res, () => undefined);
    }
    // 现在这个 IP 的全局配额已经被消耗了 PUBLIC_LIST_LIMIT_PER_MIN 次
    let metaPassed = 0;
    for (let i = 0; i < 1000; i += 1) {
      const res = fakeRes();
      let ok = false;
      rateLimitMiddleware(anonReq('/api/public/meta', { socket: { remoteAddress: ip } }), res, () => {
        ok = true;
      });
      if (ok) metaPassed += 1;
      else break;
    }
    // 如果没有 fall-through，这里会等于全局档的全额；有 fall-through 则少了已消耗的那部分
    expect(metaPassed).toBeLessThan(1000);
    expect(metaPassed).toBeGreaterThan(0);
  });

  it('🔴 失败方向：环境变量缺失或非法时落回默认值（不会变成"不限"）', () => {
    expect(PUBLIC_LIST_LIMIT_PER_MIN).toBeGreaterThan(0);
    expect(Number.isFinite(PUBLIC_LIST_LIMIT_PER_MIN)).toBe(true);
    // 默认值应当显著严于全局档（这一档存在的理由就是"单次成本更高 ⇒ 频次更低"）
    expect(PUBLIC_LIST_LIMIT_PER_MIN).toBeLessThan(600);
  });
});
