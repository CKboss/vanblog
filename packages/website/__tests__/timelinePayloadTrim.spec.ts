/**
 * 🔴 钉住 `/timeline` 的**白传量**：pageProps 里每篇文章只许带渲染真正读到的 4 个字段。
 *
 * ## 为什么需要这条守卫
 *
 * 实测（dev :3001，53 篇真实文章）：裁剪前 `/timeline` 的 `pageProps.yearGroups` 是
 * **23,722B**（占该页 `__NEXT_DATA__` 32,112B 的 74%），每篇带 **16 个字段**
 * （title/tags/top/category/hidden/author/pathname/private/viewer/visited/createdAt/
 * updatedAt/id/lastVisitedTime/cover/wordCount）；而渲染链路
 * `TimelineArchives → TimeLineItem → ArticleList` 每篇**只读 4 样**：
 * `getArticlePath()` 要的 `pathname`（缺失回落 `id`）、React `key` 要的 `id`、
 * 日期要的 `createdAt`、链接文字要的 `title`。
 * 裁剪后 yearGroups 降到 **10,239B**、HTML 从 114,868B 降到 101,385B（gzip 24,838 → 22,255）。
 *
 * ⚠️ 这类"省字节"的改动**极易被悄悄改回去**（有人给卡片加个封面、加个阅读量，
 * 顺手把 props 类型放宽回 `Article`，字节就回来了而且没人会发现），所以守卫要钉的是
 * **字段集合**而不是字节数 —— 字节数会随内容变化假红，字段集合不会。
 */
import { describe, expect, it, vi } from "vitest";
import {
  toTimelineArticleRef,
  trimTimelineYearGroups,
  groupTimelineByYearAndMonth,
  type TimelineArticleRef,
} from "../utils/timelineMonths";

/** 一篇**故意很肥**的文章：16 个字段，与实测的改前形状一致。 */
function fatArticle(id: number, iso: string, pathname?: string) {
  return {
    id,
    title: `文章 ${id}`,
    createdAt: iso,
    updatedAt: iso,
    pathname,
    // 🔴 这几个是"白传"的主体：content 与 excerpt 在真实数据里最大
    content: `# 标题 ${id}\n\n${"正文正文正文".repeat(40)}`,
    excerpt: `摘要 ${id} ${"摘要文字".repeat(30)}`,
    cover: `/static/img/cover-${id}.webp`,
    firstImage: `/static/img/first-${id}.webp`,
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
    readingMinutes: 3,
  };
}

const EXPECTED_KEYS = ["id", "title", "createdAt", "pathname"];

describe("toTimelineArticleRef：每篇只留 4 个字段", () => {
  it("🔴 替身自检：fatArticle 真的很肥（否则下面所有断言都是空转）", () => {
    const fat = fatArticle(1, "2026-01-02T03:04:05.000Z", "some-slug");
    expect(Object.keys(fat).length).toBeGreaterThanOrEqual(16);
    expect(typeof fat.content).toBe("string");
    expect(fat.content.length).toBeGreaterThan(100);
    expect(fat.excerpt).toBeTruthy();
    expect(fat.cover).toBeTruthy();
  });

  it("裁完恰好是 id/title/createdAt/pathname 四个键，一个不多一个不少", () => {
    const ref = toTimelineArticleRef(fatArticle(7, "2026-03-04T05:06:07.000Z", "slug-7"));
    expect(Object.keys(ref).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(ref).toEqual({
      id: 7,
      title: "文章 7",
      createdAt: "2026-03-04T05:06:07.000Z",
      pathname: "slug-7",
    });
  });

  it("🔴 肥字段一个都不许漏过去（逐个点名，含最大的 content/excerpt）", () => {
    const ref = toTimelineArticleRef(fatArticle(8, "2026-03-04T05:06:07.000Z", "s")) as Record<string, unknown>;
    for (const banned of [
      "content", "excerpt", "cover", "firstImage", "tags", "category",
      "author", "viewer", "visited", "wordCount", "updatedAt",
      "lastVisitedTime", "readingMinutes", "hidden", "private", "top",
    ]) {
      expect(ref, `字段 ${banned} 不该出现在 /timeline 的 pageProps 里`).not.toHaveProperty(banned);
    }
  });

  it("pathname 缺失或空串时**不带上这个键**（而不是塞 undefined）", () => {
    // ⚠️ 这关系到守卫的稳定性：JSON.stringify 会丢掉 undefined 值，
    //    但 Object.keys() 不会 —— 键集合不稳定会让"恰好四个键"这条断言时好时坏。
    const noPath = toTimelineArticleRef(fatArticle(9, "2026-03-04T05:06:07.000Z", undefined));
    expect(Object.keys(noPath).sort()).toEqual(["createdAt", "id", "title"]);
    expect(noPath).not.toHaveProperty("pathname");
    // 回落行为仍然正确：getArticlePath 在没有 pathname 时用 id
    const emptyPath = toTimelineArticleRef(fatArticle(10, "2026-03-04T05:06:07.000Z", ""));
    expect(emptyPath).not.toHaveProperty("pathname");
  });

  it("不改动入参（纯函数）", () => {
    const fat = fatArticle(11, "2026-03-04T05:06:07.000Z", "slug-11");
    const snapshot = JSON.stringify(fat);
    toTimelineArticleRef(fat);
    expect(JSON.stringify(fat)).toBe(snapshot);
  });
});

describe("trimTimelineYearGroups：结构与顺序逐字保留，只裁字段", () => {
  const groups = () =>
    groupTimelineByYearAndMonth({
      "2026": [
        fatArticle(1, "2026-05-10T00:00:00.000Z", "a"),
        fatArticle(2, "2026-05-02T00:00:00.000Z", "b"),
        fatArticle(3, "2026-01-15T00:00:00.000Z", "c"),
      ],
      "2025": [fatArticle(4, "2025-12-01T00:00:00.000Z", "d")],
    });

  it("🔴 尺子有效性：未裁剪时 yearGroups 里确实带着肥字段（否则「省了」是假的）", () => {
    const raw = groups();
    const first = raw[0].months[0].articles[0] as Record<string, unknown>;
    expect(first).toHaveProperty("content");
    expect(Object.keys(first).length).toBeGreaterThanOrEqual(16);
  });

  it("month 级与 year 级**都**被裁（months 非空时 year 级是空数组）", () => {
    const trimmed = trimTimelineYearGroups(groups());
    for (const yearGroup of trimmed) {
      for (const month of yearGroup.months) {
        for (const article of month.articles) {
          expect(Object.keys(article).sort()).toEqual([...EXPECTED_KEYS].sort());
        }
      }
      for (const article of yearGroup.articles) {
        expect(Object.keys(article).sort()).toEqual([...EXPECTED_KEYS].sort());
      }
    }
  });

  it("🔴 `months.length === 0` 的兜底分支也被裁（这条最容易漏）", () => {
    // 整年都解析不出日期 ⇒ groupTimelineByYearAndMonth 走 year 级兜底，
    // articles 才有内容，而 TimelineArchives 正是靠这个分支渲染。
    // 只裁 month 级的话，这个分支会把完整对象原样带出去。
    const fallback = groupTimelineByYearAndMonth({
      "2024": [fatArticle(20, "不是日期" as unknown as string, "x")],
    });
    expect(fallback[0].months.length).toBe(0); // 替身自检：确实走了兜底
    expect(fallback[0].articles.length).toBe(1);
    const trimmed = trimTimelineYearGroups(fallback);
    expect(trimmed[0].months.length).toBe(0);
    expect(Object.keys(trimmed[0].articles[0]).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(trimmed[0].articles[0]).not.toHaveProperty("content");
  });

  it("🔴 `count` 原样保留，**不是**从 articles.length 推出来的", () => {
    // 有月份分组时 year 级 articles 是空数组（组件在 months 非空时不读它），
    // 所以 count 是唯一可靠的篇数来源。谁把 count 改成 articles.length 就会变成 0。
    const trimmed = trimTimelineYearGroups(groups());
    expect(trimmed[0].count).toBe(3);
    expect(trimmed[0].articles.length).toBe(0);
    expect(trimmed[1].count).toBe(1);
  });

  it("年份顺序、月份顺序、月内文章顺序都不变", () => {
    const raw = groups();
    const trimmed = trimTimelineYearGroups(raw);
    expect(trimmed.map((g) => g.year)).toEqual(raw.map((g) => g.year));
    expect(trimmed.map((g) => g.label)).toEqual(raw.map((g) => g.label));
    for (let i = 0; i < raw.length; i++) {
      expect(trimmed[i].months.map((m) => m.key)).toEqual(raw[i].months.map((m) => m.key));
      for (let j = 0; j < raw[i].months.length; j++) {
        expect(trimmed[i].months[j].articles.map((a) => a.id)).toEqual(
          raw[i].months[j].articles.map((a) => a.id)
        );
      }
    }
  });

  it("不改动入参（纯函数：同一份数据被两个页面共用时不会互相影响）", () => {
    const raw = groups();
    const snapshot = JSON.stringify(raw);
    trimTimelineYearGroups(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it("裁完的序列化体积显著变小（相对比例，不钉绝对字节数以免随内容假红）", () => {
    const raw = groups();
    const before = Buffer.byteLength(JSON.stringify(raw));
    const after = Buffer.byteLength(JSON.stringify(trimTimelineYearGroups(raw)));
    expect(after).toBeLessThan(before * 0.5);
    expect(after).toBeGreaterThan(0);
  });
});

describe("getTimeLinePageProps 真的把裁剪接上了（端到端）", () => {
  it("pageProps.yearGroups 里没有任何肥字段", async () => {
    // ⚠️ 本仓库 vitest 是 0.29（没有 vi.hoisted），既有先例只 mock 过裸包名。
    //    这里用**自包含 factory**（不引用外层变量）mock 相对路径的取数模块。
    // 🔴 桩必须**照真实形状**造（本机对着 /api/public/meta 核实过）：
    //    顶层 {version,tags,meta,menus,totalArticles,totalWordCount,layout}，
    //    meta 里 {links,socials,menus,rewards,about,siteInfo,viewer,visited,categories,totalWordCount}。
    //    第一版我按想象写成 {siteInfo,socials,links,tags,categories}（少了一层 meta），
    //    于是 getLayoutProps 读 data.meta.categories 就炸了 —— 这是本仓库第 6 次
    //    "替身钉住作者的假设而不是现实"，所以这里额外加一条**桩自检**。
    vi.doMock("../api/getAllData", () => ({
      getPublicMeta: async () => ({
        version: "test",
        tags: [],
        menus: [],
        totalArticles: 1,
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
          categories: [],
          totalWordCount: 41508,
          __v: 0,
        },
      }),
    }));
    vi.doMock("../api/getArticles", () => ({
      getArticlesByTimeLine: async () => ({
        "2026": [
          {
            id: 1, title: "T1", createdAt: "2026-05-10T00:00:00.000Z",
            pathname: "p1", content: "正文".repeat(200), excerpt: "摘要".repeat(100),
            cover: "/static/img/c.webp", tags: ["x"], category: "c", viewer: 9,
          },
        ],
      }),
      getArticleByIdOrPathname: async () => null,
      getArticlesByCategory: async () => [],
      getArticlesByOption: async () => [],
    }));
    vi.resetModules();
    const { getTimeLinePageProps } = await import("../utils/getPageProps");
    // 🔴 桩自检：如果这条红了，说明上面的桩形状与真实 /api/public/meta 脱节了，
    //    那么下面的"裁掉了肥字段"就可能是**因为桩坏了根本没走到渲染数据**，而不是因为裁剪生效。
    const { getPublicMeta } = await import("../api/getAllData");
    const metaProbe = (await getPublicMeta()) as Record<string, any>;
    expect(Array.isArray(metaProbe.meta?.categories)).toBe(true);
    expect(typeof metaProbe.meta?.siteInfo?.showSubMenu).toBe("string");
    expect(typeof metaProbe.totalWordCount).toBe("number");

    const props = await getTimeLinePageProps();
    const article = (props.yearGroups[0].months[0]?.articles[0] ??
      props.yearGroups[0].articles[0]) as Record<string, unknown>;
    expect(article).toBeTruthy();
    expect(Object.keys(article).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(article).not.toHaveProperty("content");
    expect(article).not.toHaveProperty("excerpt");
    expect(props.yearGroups[0].count).toBe(1);
    vi.doUnmock("../api/getAllData");
    vi.doUnmock("../api/getArticles");
    vi.resetModules();
  });
});

/** 类型层面的钉子：ref 必须能满足 timelineMonths 的约束，且 Article 仍可赋值给它 */
describe("类型契约", () => {
  it("TimelineArticleRef 是 Article 的结构子集（传完整 Article 仍然合法）", () => {
    const fat = fatArticle(30, "2026-05-10T00:00:00.000Z", "z");
    const asRef: TimelineArticleRef = fat; // 编译期就是断言
    expect(asRef.id).toBe(30);
    expect(asRef.pathname).toBe("z");
  });
});

/**
 * 🔴 源码级钉子：**类型收窄本身**不许被放宽回去。
 *
 * 为什么行为级断言不够：`trimTimelineYearGroups` 的行为测试只能证明"这个函数裁得对"，
 * 但如果有人把 `ArticleList`/`TimeLineItem`/`TimelineArchives`/`TimeLinePageProps` 的
 * props 类型改回完整 `Article`，那么**下一次**给卡片加字段时 TS 不会再拦，
 * 肥对象就能顺着 props 一路流回 pageProps —— 而所有行为测试仍然全绿。
 * 类型是这里的"棘轮"，所以必须钉住。
 *
 * ⚠️ 断言"某文本不存在"必须先剥注释：这几个文件里都有**解释为什么不用 `Article`** 的注释，
 *    注释里就写着 `Article` 这个词（本仓库已 10 次踩到"断言匹配到解释性注释"）。
 */
import { readFileSync } from "fs";
import { join } from "path";

/**
 * 剥注释：⚠️ **先按行剥掉整行注释，再剥块注释**。
 * 反过来的顺序（先剥块注释）在「行注释里含块注释起止符」时会把真实代码一起吃掉 ——
 * 本仓库踩过这个坑（⚠️ 而且我第一版就在这条注释里写了那个终止符字面量，
 * 于是**这段块注释自己提前结束了**、把下面的 import 变成语法错，正好现场复现了一次）。
 * 这里再配一条反证证明剥离器真的在工作。
 */
function stripCommentsForAnchor(src: string): string {
  const withoutLineComments = src
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
      return line;
    })
    .join("\n");
  return withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
}

const NARROWED_FILES = [
  "components/ArticleList/index.tsx",
  "components/TimeLineItem/index.tsx",
  "components/TimelineArchives/index.tsx",
  "pages/timeline.tsx",
];

describe("类型收窄不许被放宽（棘轮）", () => {
  it("🔴 剥离器反证：未剥注释时这些文件里确实能命中 Article（否则下面的「不命中」是空的）", () => {
    // 这几个文件都在注释里解释了"为什么不用 Article"，所以**原始文本**必然命中；
    // 如果哪天连注释都不提了，这条会红 —— 那时说明钉子失去了它要保护的上下文，需要人来看一眼。
    const root = join(__dirname, "..");
    const hits = NARROWED_FILES.filter((f) =>
      readFileSync(join(root, f), "utf-8").includes("Article")
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it("剥掉注释后，四个文件都不再把 props/pageProps 声明成完整 Article", () => {
    const root = join(__dirname, "..");
    for (const rel of NARROWED_FILES) {
      const code = stripCommentsForAnchor(readFileSync(join(root, rel), "utf-8"));
      // ⚠️ 钉的是**声明形状**，不是"Article 这个词不许出现"：
      //    `TimelineArticleRef` 里也含 "Article" 子串，所以必须按声明来匹配。
      expect(code, `${rel} 不该出现 articles: Article[]`).not.toMatch(/articles:\s*Article\[\]/);
      expect(code, `${rel} 不该出现 TimelineYearGroup<Article>`).not.toMatch(
        /TimelineYearGroup<Article>/
      );
      // 🔴 放宽成 `any[]` 是**比放宽成 Article[] 更可能**的真实漂移（改的人只想让编译过），
      //    而它同样会让肥对象一路流回 pageProps。第一版守卫漏了它 —— 变异对照 M6 抓到：
      //    把 `articles: TimelineArticleRef[]` 改成 `articles: any[]` 时守卫**全绿**。
      //    所以这里既要**反向禁止** any，也要**正向钉住**必须就是那个窄类型。
      expect(code, `${rel} 不该把 articles 放宽成 any[]`).not.toMatch(/articles:\s*any\[\]/);
    }
    // 正向钉子：ArticleList 与 TimeLineItem 的 articles **必须**声明成 TimelineArticleRef[]
    for (const rel of [
      "components/ArticleList/index.tsx",
      "components/TimeLineItem/index.tsx",
    ]) {
      const code = stripCommentsForAnchor(readFileSync(join(root, rel), "utf-8"));
      expect(code, `${rel} 必须把 articles 声明成 TimelineArticleRef[]`).toMatch(
        /articles:\s*TimelineArticleRef\[\]/
      );
    }
    // 正向钉子：TimelineArchives 与 timeline 页面必须用窄泛型
    for (const rel of [
      "components/TimelineArchives/index.tsx",
      "pages/timeline.tsx",
    ]) {
      const code = stripCommentsForAnchor(readFileSync(join(root, rel), "utf-8"));
      expect(code, `${rel} 必须用 TimelineYearGroup<TimelineArticleRef>`).toMatch(
        /TimelineYearGroup<TimelineArticleRef>\[\]/
      );
    }
  });

  it("🔴 接线钉子：getTimeLinePageProps 真的把 groupTimelineByYearAndMonth 包在 trimTimelineYearGroups 里", () => {
    const code = stripCommentsForAnchor(
      readFileSync(join(__dirname, "..", "utils/getPageProps.ts"), "utf-8")
    );
    expect(code).toMatch(/trimTimelineYearGroups\(\s*groupTimelineByYearAndMonth\(/);
    // 反证：剥注释前能命中的"解释性文本"不该成为唯一命中来源
    expect(code).toContain("trimTimelineYearGroups");
  });
});
