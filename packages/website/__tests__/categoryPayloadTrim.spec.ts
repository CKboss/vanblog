/**
 * 🔴 钉住 `/category`、`/category/[category]`、`/tag/[tag]` 三页的**白传量**：
 * 进 pageProps 的每篇文章只许带渲染真正读到的 4 个字段。
 *
 * ## 为什么需要这条守卫（2026-09-21 实测，dev :3001，53 篇真实文章）
 *
 * | 页面 | 取数路径 | 改前每篇字段 | 改前数组 | 改后数组 | HTML 改前 → 改后 |
 * | --- | --- | --- | --- | --- | --- |
 * | `/category` | `getArticlesByCategory()` **原样透传** server 的 `/api/public/category` | **16** | **23,795B** | **9,046B** | 92,125 → **78,642B**（−14.6%） |
 * | `/category/[category]` | `getArticlesByOption(toListView)` → `washArticlesByKey` | 5 | 11,207B | 9,046B | 80,089 → **78,022B** |
 * | `/tag/[tag]` | 同上 | 5 | 359B（2 篇） | 287B | 37,671 → **37,593B** |
 *
 * `/category` 是最大的一块：`__NEXT_DATA__` 从 30,499B（占 HTML 33.1%）降到 17,016B（21.6%），
 * gzip 从 23,746B 降到 20,460B。16 个字段里 `lastVisitedTime`(2,385B)、`updatedAt`(2,067B)、
 * `cover`(1,548B)、`tags`(1,068B)、`author`(1,060B)、`category`(1,060B)、`wordCount`(861B)、
 * `private`(848B)、`hidden`(795B)、`visited`(713B)、`viewer`(660B)、`top`(424B) **一个都没被读**
 * ⇒ 23,795B 里只有 8,504B（36%）是渲染需要的。
 *
 * 🔴 其中 `hidden`、`lastVisitedTime`、`wordCount` 在**整个 website 包里零读者**
 * （`grep -rn '\.hidden\b'` / `'\.lastVisitedTime\b'` / `'\.wordCount\b'` 排除类型声明与测试后命中 0）。
 * `cover`/`author` 只在 `pages/post/[id].tsx`（详情页）被读；`visited` 只由
 * `api/pageview.ts` 从**统计接口**的响应里读，不是从列表文章上读。
 *
 * ## 渲染链路每篇实际读的 4 样（逐个核实过，不是照抄 /timeline）
 *
 * `CategoryList` → `TimeLineItem` → `ArticleList`：
 * 1. `getArticlePath(article)` ⇒ 只读 `pathname`（缺失回落 `id`）
 * 2. `article.id` ⇒ React 的 `key`
 * 3. `article.createdAt` ⇒ `dayjs(...).format("YYYY-MM-DD" | "MM-DD")`
 * 4. `article.title` ⇒ 链接文字
 * `TimeLineItem` 另外只读 `articles.length`（篇数）；`CategoryList` 只读 `Object.keys` 与透传。
 *
 * ⚠️ 这类"省字节"的改动**极易被悄悄改回去**（有人给分类页的条目加个封面或阅读量，
 * 顺手把 props 类型放宽回 `Article`，字节就回来了而且没人会发现）⇒ 所以本文件钉的是
 * **字段集合**（不随内容变化假红）**加一条类型棘轮**（见最后一个 describe）。
 * 类型棘轮是必需的：行为测试只能证明"裁剪函数是对的"，但如果有人把 props 类型放宽，
 * 下一次给卡片加字段时 TS 就不再拦，肥对象会顺着 props 流回 pageProps，
 * **而所有行为测试仍然全绿**。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  trimArticleRecord,
  toTimelineArticleRef,
  type TimelineArticleRef,
} from "../utils/timelineMonths";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");

/** 与实测的"改前形状"一致：`/api/public/category` 透传下来的 16 字段。 */
function fatArticle(id: number, iso: string, pathname?: string) {
  return {
    id,
    title: `文章 ${id}`,
    createdAt: iso,
    updatedAt: iso,
    pathname,
    cover: `/static/img/cover-${id}.webp`,
    tags: [`tag${id}`, "common"],
    category: `分类${id}`,
    author: "author",
    hidden: false,
    private: false,
    top: 0,
    viewer: 100 + id,
    visited: 10 + id,
    wordCount: 1234,
    lastVisitedTime: iso,
  };
}

/** 渲染链路真正读的 4 个字段，顺序无关（断言时用 sort 比较）。 */
const EXPECTED_KEYS = ["createdAt", "id", "pathname", "title"];

/** 改前实测存在、而渲染链路一个都不读的字段（逐个点名，不许笼统断言）。 */
const FORBIDDEN_KEYS = [
  "content",
  "excerpt",
  "cover",
  "firstImage",
  "tags",
  "category",
  "author",
  "hidden",
  "private",
  "top",
  "viewer",
  "visited",
  "wordCount",
  "lastVisitedTime",
  "updatedAt",
  "readingMinutes",
  "thumbAvif",
  "meta",
];

describe("trimArticleRecord：每篇只留 4 个字段", () => {
  it("🔴 替身自检：fatArticle 真的很肥（否则下面所有断言都是空转）", () => {
    const fat = fatArticle(1, "2026-01-02T03:04:05.000Z", "slug-1");
    // 必须真的带上那些"白传"字段，否则"裁掉了"只是因为桩本来就没有
    expect(Object.keys(fat).length).toBeGreaterThanOrEqual(16);
    for (const key of [
      "cover",
      "tags",
      "category",
      "author",
      "hidden",
      "private",
      "top",
      "viewer",
      "visited",
      "wordCount",
      "lastVisitedTime",
      "updatedAt",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(fat, key)).toBe(true);
    }
    expect(typeof fat.cover).toBe("string");
    expect(Array.isArray(fat.tags)).toBe(true);
    expect(typeof fat.wordCount).toBe("number");
  });

  it("每篇恰好 4 个键，且逐个点名禁止的字段一个都不在", () => {
    const out = trimArticleRecord({
      "2026": [fatArticle(1, "2026-05-10T00:00:00.000Z", "p1")],
    });
    const first = out["2026"][0];
    expect(Object.keys(first).sort()).toEqual(EXPECTED_KEYS);
    for (const key of FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(first, key)).toBe(false);
    }
  });

  it("🔴 键顺序逐字保留（CategoryList 直接按 Object.keys 渲染，washArticlesByKey 的注释明写分类页依赖这个顺序）", () => {
    const out = trimArticleRecord({
      博客: [fatArticle(1, "2026-05-10T00:00:00.000Z", "p1")],
      生活: [fatArticle(2, "2026-04-10T00:00:00.000Z", "p2")],
      技术: [fatArticle(3, "2026-03-10T00:00:00.000Z", "p3")],
    });
    expect(Object.keys(out)).toEqual(["博客", "生活", "技术"]);
  });

  it("组内顺序与篇数不变（裁剪只动字段，不动结构）", () => {
    const out = trimArticleRecord({
      "2026": [
        fatArticle(3, "2026-05-10T00:00:00.000Z", "p3"),
        fatArticle(1, "2026-04-10T00:00:00.000Z", "p1"),
        fatArticle(2, "2026-03-10T00:00:00.000Z"),
      ],
    });
    expect(out["2026"].map((a) => a.id)).toEqual([3, 1, 2]);
    expect(out["2026"]).toHaveLength(3);
  });

  it("pathname 缺失或为空串时**不带上这个键**（塞 undefined 会让 Object.keys 不稳定）", () => {
    const absent = trimArticleRecord({
      g: [fatArticle(1, "2026-05-10T00:00:00.000Z", undefined)],
    })["g"][0];
    expect(Object.prototype.hasOwnProperty.call(absent, "pathname")).toBe(false);
    expect(Object.keys(absent).sort()).toEqual(["createdAt", "id", "title"]);

    const empty = trimArticleRecord({
      g: [fatArticle(2, "2026-05-10T00:00:00.000Z", "")],
    })["g"][0];
    expect(Object.prototype.hasOwnProperty.call(empty, "pathname")).toBe(false);

    const present = trimArticleRecord({
      g: [fatArticle(3, "2026-05-10T00:00:00.000Z", "real-slug")],
    })["g"][0];
    expect(present.pathname).toBe("real-slug");
  });

  it("空/null/缺组一律安全，且不抛", () => {
    expect(trimArticleRecord(null)).toEqual({});
    expect(trimArticleRecord(undefined)).toEqual({});
    expect(trimArticleRecord({})).toEqual({});
    // 某组是 null（server 异常形状）⇒ 该组变空数组，不影响其它组
    const out = trimArticleRecord({
      a: null as unknown as ReturnType<typeof fatArticle>[],
      b: [fatArticle(1, "2026-05-10T00:00:00.000Z", "p1")],
    });
    expect(out.a).toEqual([]);
    expect(out.b).toHaveLength(1);
  });

  it("纯函数：不改动入参（getStaticProps 的返回会被序列化，就地改会造成跨页耦合）", () => {
    const input = {
      "2026": [fatArticle(1, "2026-05-10T00:00:00.000Z", "p1")],
    };
    const snapshot = JSON.stringify(input);
    trimArticleRecord(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    // 入参那篇仍然是肥的（没有被就地瘦身）
    expect(Object.keys(input["2026"][0]).length).toBeGreaterThanOrEqual(16);
  });

  it("裁完的序列化体积不到原来的一半（钉相对比例，不钉绝对字节，避免随内容假红）", () => {
    const input = {
      "2026": Array.from({ length: 20 }, (_, i) =>
        fatArticle(i, "2026-05-10T00:00:00.000Z", `slug-${i}`)
      ),
    };
    const before = JSON.stringify(input).length;
    const after = JSON.stringify(trimArticleRecord(input)).length;
    expect(after).toBeLessThan(before / 2);
  });

  it("与 toTimelineArticleRef 逐字段一致（两者必须是同一套口径，否则会各自漂移）", () => {
    const fat = fatArticle(7, "2026-05-10T00:00:00.000Z", "p7");
    const viaRecord = trimArticleRecord({ g: [fat] })["g"][0];
    const viaSingle = toTimelineArticleRef(fat);
    expect(viaRecord).toEqual(viaSingle);
  });
});

/**
 * 端到端用的 meta 桩。
 * 🔴 形状**照真实 `/api/public/meta` 造**（顶层 version/tags/meta/menus/totalArticles/
 * totalWordCount/layout，而 categories 与 siteInfo 在 **meta 里面**一层）—— 上一轮就因为
 * 按想象少写了一层 meta 而踩了本仓库第 6 次"替身不忠实"。下面配了**桩自检**。
 */
function metaStub(categories: string[]) {
  return {
    version: "test",
    tags: ["Life"],
    menus: [],
    totalArticles: 2,
    totalWordCount: 41508,
    layout: {},
    meta: {
      _id: "x",
      links: [],
      socials: {},
      menus: {},
      rewards: [],
      about: "",
      siteInfo: {
        author: "a",
        authorDesc: "",
        authorLogo: "",
        favicon: "",
        siteName: "s",
        siteDesc: "",
        baseUrl: "",
        showSubMenu: "false",
        openArticleLinksInNewWindow: "false",
        since: "",
        gaAnalysisId: "",
        baiduAnalysisId: "",
        showExpirationReminder: "false",
        articlesPerPage: 5,
        friendLinkIntro: "",
        friendLinkApplyContent: "",
        aboutTitle: "",
        uiStyle: "default",
      },
      viewer: 0,
      visited: 0,
      categories,
      totalWordCount: 41508,
      __v: 0,
    },
  };
}

/** 三个取数函数共用的"肥文章"响应形状。 */
const FAT_LIST = [
  fatArticle(1, "2026-05-10T00:00:00.000Z", "p1"),
  fatArticle(2, "2024-07-07T00:00:00.000Z", "p2"),
];

describe("三个取数函数真的把裁剪接上了（端到端）", () => {
  it("🔴 桩自检：meta 桩的形状与真实接口一致（否则下面全是在测一个坏桩）", () => {
    const data = metaStub(["博客"]) as any;
    expect(Array.isArray(data.meta.categories)).toBe(true);
    expect(typeof data.meta.siteInfo.showSubMenu).toBe("string");
    expect(typeof data.totalWordCount).toBe("number");
    expect(typeof data.version).toBe("string");
  });

  it("getCategoryPageProps：sortedArticles 里没有任何肥字段", async () => {
    vi.resetModules();
    vi.doMock("../api/getAllData", () => ({
      getPublicMeta: async () => metaStub(["博客"]),
    }));
    vi.doMock("../api/getArticles", () => ({
      // 🔴 /category 走的是这条：改前它把 server 的返回**原样**塞进 pageProps
      getArticlesByCategory: async () => ({ 博客: FAT_LIST }),
      getArticlesByOption: async () => ({
        articles: FAT_LIST,
        total: FAT_LIST.length,
        totalWordCount: 2000,
      }),
      getArticlesByTimeLine: async () => ({}),
      getArticleByIdOrPathname: async () => ({ article: null }),
    }));
    const { getCategoryPageProps } = await import("../utils/getPageProps");
    const props = await getCategoryPageProps();
    const all = Object.values(props.sortedArticles).flat();
    expect(all.length).toBe(2);
    for (const a of all) {
      expect(Object.keys(a).sort()).toEqual(EXPECTED_KEYS);
      for (const key of FORBIDDEN_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(a, key)).toBe(false);
      }
    }
    // 结构与计数不许被裁剪影响
    expect(Object.keys(props.sortedArticles)).toEqual(["博客"]);
    expect(props.wordTotal).toBe(41508);
    vi.doUnmock("../api/getAllData");
    vi.doUnmock("../api/getArticles");
  });

  it("getCategoryPagesProps：wash 之后仍要再裁掉没人读的 updatedAt", async () => {
    vi.resetModules();
    vi.doMock("../api/getAllData", () => ({
      getPublicMeta: async () => metaStub(["博客"]),
    }));
    vi.doMock("../api/getArticles", () => ({
      getArticlesByCategory: async () => ({}),
      getArticlesByOption: async () => ({
        articles: FAT_LIST.map((a) => ({ ...a, category: "博客" })),
        total: FAT_LIST.length,
        totalWordCount: 2000,
      }),
      getArticlesByTimeLine: async () => ({}),
      getArticleByIdOrPathname: async () => ({ article: null }),
    }));
    const { getCategoryPagesProps } = await import("../utils/getPageProps");
    const result = await getCategoryPagesProps("博客");
    if ("notFound" in result) {
      throw new Error("桩里的 categories 必须包含被测分类，否则走 notFound 分支");
    }
    const all = Object.values(result.sortedArticles).flat();
    expect(all.length).toBe(2);
    for (const a of all) {
      expect(Object.keys(a).sort()).toEqual(EXPECTED_KEYS);
      // 🔴 这一条是本用例的重点：washArticlesByKey 会留下 updatedAt，
      //    而 ArticleList 只读 createdAt ⇒ updatedAt 必须在进 pageProps 前被裁掉
      expect(Object.prototype.hasOwnProperty.call(a, "updatedAt")).toBe(false);
    }
    expect(result.curNum).toBe(2);
    expect(result.wordTotal).toBe(2000);
    vi.doUnmock("../api/getAllData");
    vi.doUnmock("../api/getArticles");
  });

  it("getTagPagesProps：同样裁到 4 字段，且按年份分组的键保留", async () => {
    vi.resetModules();
    vi.doMock("../api/getAllData", () => ({
      getPublicMeta: async () => metaStub(["博客"]),
    }));
    vi.doMock("../api/getArticles", () => ({
      getArticlesByCategory: async () => ({}),
      getArticlesByOption: async () => ({
        articles: FAT_LIST.map((a) => ({ ...a, tags: ["Life"] })),
        total: FAT_LIST.length,
        totalWordCount: 2000,
      }),
      getArticlesByTimeLine: async () => ({}),
      getArticleByIdOrPathname: async () => ({ article: null }),
    }));
    const { getTagPagesProps } = await import("../utils/getPageProps");
    const props = await getTagPagesProps("Life");
    const all = Object.values(props.sortedArticles).flat();
    expect(all.length).toBe(2);
    for (const a of all) {
      expect(Object.keys(a).sort()).toEqual(EXPECTED_KEYS);
    }
    // FAT_LIST 是 2026 与 2024 两篇 ⇒ 两个年份键
    expect(Object.keys(props.sortedArticles).sort()).toEqual(["2024", "2026"]);
    expect(props.currTag).toBe("Life");
    vi.doUnmock("../api/getAllData");
    vi.doUnmock("../api/getArticles");
  });
});

describe("类型棘轮：props 类型必须是窄类型（防「裁了数据但类型放宽回去」）", () => {
  /**
   * 为什么必须有这一层：`Article` 结构上**可以**赋给 `TimelineArticleRef`
   * （它有全部 4 个字段），所以只裁数据、不收窄类型时 TS 一声不响；
   * 而一旦有人把 props 类型改回 `Article[]`，下一次给卡片加字段就不会被拦，
   * 肥对象会顺着 props 流回 pageProps，**行为测试全绿**。
   * ⚠️ 反向禁止里必须包含 `any[]`：上一轮的教训是"放宽成 any 恰恰是更可能的真实漂移"
   * （改的人只想让编译过），只禁 `Article[]` 会让那条变异 NOT_RED。
   */
  const NARROW_FILES = [
    "components/CategoryList/index.tsx",
    "pages/category.tsx",
    "pages/category/[category].tsx",
    "pages/tag/[tag].tsx",
  ];

  it("四个文件都声明了 Record<string, TimelineArticleRef[]>", () => {
    for (const file of NARROW_FILES) {
      const src = read(file);
      expect(src, file).toContain("Record<string, TimelineArticleRef[]>");
      expect(src, file).toContain("utils/timelineMonths");
    }
  });

  it("🔴 四个文件都不许再出现宽类型（Article[] 与 any[] 都禁）", () => {
    for (const file of NARROW_FILES) {
      const src = read(file);
      expect(src, `${file} 出现了 Record<string, Article[]>`).not.toContain(
        "Record<string, Article[]>"
      );
      expect(src, `${file} 出现了 any[]`).not.toMatch(/sortedArticles:\s*any\[\]/);
      expect(src, `${file} 出现了 Record<string, any[]>`).not.toContain(
        "Record<string, any[]>"
      );
    }
  });

  it("🔴 尺子有效性反证：这两把尺子在坏形状上确实会响", () => {
    // 合成样本：故意写成宽类型，断言上面的判据能抓到
    const badNarrow = "sortedArticles: Record<string, Article[]>;";
    expect(badNarrow).toContain("Record<string, Article[]>");
    const badAny = "sortedArticles: Record<string, any[]>;";
    expect(badAny).toContain("Record<string, any[]>");
    const badAny2 = "sortedArticles: any[];";
    expect(/sortedArticles:\s*any\[\]/.test(badAny2)).toBe(true);
    // 而窄类型样本不该被误报
    const good = "sortedArticles: Record<string, TimelineArticleRef[]>;";
    expect(good).not.toContain("Record<string, Article[]>");
    expect(good).not.toContain("Record<string, any[]>");
    expect(/sortedArticles:\s*any\[\]/.test(good)).toBe(false);
  });

  it("getPageProps 里三个取数函数都调了 trimArticleRecord（少一处就是漏裁）", () => {
    const src = read("utils/getPageProps.ts");
    // 恰好 3 个调用点：getCategoryPageProps / getTagPagesProps / getCategoryPagesProps。
    // ⚠️ import 那一行是 `trimArticleRecord,`（不带括号），所以不计入这个 match ——
    //    第一版我误以为它会被 `trimArticleRecord\(` 匹配到而写了 4，被这条红抓出来了。
    const calls = src.match(/trimArticleRecord\(/g) || [];
    expect(calls.length).toBe(3);
    // import 单独断言（否则"3 个调用点"也可能来自一个根本没 import 的坏文件）
    expect(src).toMatch(/import\s*\{[^}]*\btrimArticleRecord\b[^}]*\}\s*from\s*"\.\/timelineMonths"/);
  });

  it("🔴 /category 那条必须裁的是 getArticlesByCategory 的返回（改前它是原样透传）", () => {
    const src = read("utils/getPageProps.ts");
    expect(src).toMatch(/trimArticleRecord\(\s*await getArticlesByCategory\(\)\s*\)/);
    // 反证：不许再出现"把 getArticlesByCategory 的结果直接赋给 sortedArticles"
    expect(src).not.toMatch(
      /const sortedArticles = await getArticlesByCategory\(\)/
    );
  });

  it("⚠️ washArticlesByKey 的 5 字段契约没被动（它的测试钉着，改它等于改公共工具）", () => {
    const src = read("utils/washArticles.ts");
    expect(src).toContain("updatedAt: each.updatedAt");
    // 裁剪发生在 pageProps 边界，不是在公共工具里
    expect(src).not.toContain("trimArticleRecord");
  });
});
