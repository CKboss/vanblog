import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { getArticlePath } from "../utils/getArticlePath";

/**
 * 🔴 钉住「标签页的取数形状」，防止一条**看起来是优化、其实是白传**的改动被接上去。
 *
 * ## 背景（2026-09-21 核实，别只看结论）
 *
 * `api/getArticles.ts` 里的 `getArticlesByTag(tagName)` **忽略自己的参数**，拉的是
 * `api/public/tag`（整个标签映射）⇒ 谁用它渲染一个标签页，就会下载**全部标签**的文章。
 * 但它**当前没有任何调用方**：标签页 `pages/tag/[tag].tsx` → `getTagPagesProps(currTag)`
 * 走的是 `getArticlesByOption({ tags: currTag, toListView: true })`，**服务端按标签过滤**。
 * ⇒ 所以那条白传**实际不存在**，而风险在于「将来有人把这个现成的函数接上去」。
 *
 * ## 为什么不直接删掉它
 * `packages/server/src/provider/tag/tag.provider.slimListView.spec.ts` **跨包**读取
 * `api/getArticles.ts` 的源码文本、断言里面出现带 `toListView=true` 的 URL 字面量，
 * 而那个字面量就在这个死函数里 ⇒ 删函数会让**另一个包**的守卫变红。
 * ⚠️ 这本身是一条守卫设计教训：**跨包的源码文本守卫会把死代码冻在原地**。
 *
 * ## 为什么也不能「修好」成调 `/api/public/tag/:name`
 * 实测那个端点每篇只返回 7 个字段（category、createdAt、id、tags、title、top、updatedAt），
 * **没有 `pathname`** ⇒ `getArticlePath` 会回落到 `id`，链接**静默**从 `/post/<拼音别名>`
 * 变成 `/post/<数字 id>`。下面有断言钉住这个回落行为与 `pathname` 的必需性。
 */

/** 网站根目录（本文件在 packages/website/__tests__/ 下）。 */
const websiteRoot = path.join(__dirname, "..");

/**
 * 单趟字符状态机剥注释与字符串。
 * ⚠️ **不用**「先 replace 块注释、再 replace 行注释」那种两趟写法 —— 本仓库已两次因此吃亏：
 * 行注释里出现 `src/` 加星号这种形状时，块注释剥离器会吃掉真实代码。
 * ⚠️ 保留换行以维持行号准确。
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let state: State = "code";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'") {
        state = "sq";
        i += 1;
        continue;
      }
      if (c === '"') {
        state = "dq";
        i += 1;
        continue;
      }
      if (c === "`") {
        state = "tpl";
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i += 2;
        continue;
      }
      // 保留换行，行号才准
      if (c === "\n") {
        out += c;
      }
      i += 1;
      continue;
    }
    // 三种引号：跳过内容，但保留换行
    const quote = state === "sq" ? "'" : state === "dq" ? '"' : "`";
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) {
      state = "code";
      i += 1;
      continue;
    }
    if (c === "\n") {
      out += c;
    }
    i += 1;
  }
  return out;
}

/**
 * 只剥注释、**保留字符串字面量**。
 * ⚠️ 与上面那把尺子并存是必需的：`TimelineArticleRef = Pick<Article, "id" | "title" | …>`
 * 的字段名**本身就是字符串字面量**，用「连字符串一起剥」的那把尺子去断言它，
 * 剥完就只剩 `Pick<Article,  |  |  | >`，断言恒假 —— 我第一版正是这么写红的。
 * 👉 教训：**选剥多少要看断言的目标**，钉「代码里有没有某个调用」要连字符串一起剥
 * （否则字符串里的同名字样会喂饱守卫），钉「类型声明的形状」则必须保留字符串。
 */
function stripCommentsOnly(src: string): string {
  let out = "";
  let i = 0;
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let state: State = "code";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'") {
        state = "sq";
        out += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        state = "dq";
        out += c;
        i += 1;
        continue;
      }
      if (c === "`") {
        state = "tpl";
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i += 2;
        continue;
      }
      if (c === "\n") {
        out += c;
      }
      i += 1;
      continue;
    }
    const quote = state === "sq" ? "'" : state === "dq" ? '"' : "`";
    if (c === "\\") {
      out += c + (n ?? "");
      i += 2;
      continue;
    }
    if (c === quote) {
      state = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 🔴 用拼接构造名字，避免本文件自己被下面的源码扫描命中（守卫不能被自己的文档喂饱）。 */
const DEAD_FN = "getArticlesBy" + "Tag";

/** 扫这些目录里的 .ts/.tsx（排除测试与构建产物）。 */
function scanWebsiteSource(): { rel: string; code: string }[] {
  const dirs = ["api", "utils", "pages", "components"];
  const out: { rel: string; code: string }[] = [];
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === ".next") {
          continue;
        }
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith(".d.ts")) {
        continue;
      }
      out.push({
        rel: path.relative(websiteRoot, p).split(path.sep).join("/"),
        code: stripCommentsAndStrings(fs.readFileSync(p, "utf-8")),
      });
    }
  };
  for (const d of dirs) {
    const abs = path.join(websiteRoot, d);
    if (fs.existsSync(abs)) {
      walk(abs);
    }
  }
  return out;
}

/**
 * 端到端用的 meta 桩。
 * 🔴 形状**照真实 `/api/public/meta` 造**（顶层 version/tags/meta/menus/totalArticles/
 * totalWordCount/layout，而 categories 与 siteInfo 在 **meta 里面**一层）—— 本仓库已**七次**
 * 因替身不忠实而让真缺陷隐形，其中第六次正是「按想象少写了一层 meta」。下面配了**桩自检**。
 */
function metaStub() {
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
      categories: ["博客"],
      totalWordCount: 41508,
      __v: 0,
    },
  };
}

/** 两篇「肥文章」：带上渲染链根本不读的字段，证明裁剪与取数形状都成立。 */
function fatArticle(id: number, createdAt: string, pathname: string) {
  return {
    id,
    title: `标题 ${id}`,
    createdAt,
    updatedAt: createdAt,
    pathname,
    content: "x".repeat(400),
    excerpt: "摘要",
    cover: "/static/img/c.webp",
    firstImage: "/static/img/f.webp",
    tags: ["Life"],
    category: "博客",
    author: "a",
    private: false,
    top: false,
    hidden: false,
    viewer: 10,
    visited: 5,
    wordCount: 400,
    readingMinutes: 2,
    lastVisitedTime: createdAt,
  };
}

describe("标签页的取数形状：服务端按标签过滤，绝不整包下载", () => {
  it("🔴 桩自检：meta 桩的形状与真实接口一致（否则下面全是在测一个坏桩）", () => {
    const data = metaStub() as any;
    expect(Array.isArray(data.meta.categories)).toBe(true);
    expect(typeof data.meta.siteInfo.showSubMenu).toBe("string");
    expect(typeof data.meta.siteInfo.articlesPerPage).toBe("number");
    expect(typeof data.totalWordCount).toBe("number");
    expect(typeof data.version).toBe("string");
    // categories 在 meta 里面一层 —— 这正是第六次替身事故踩掉的形状
    expect((data as any).categories).toBe(undefined);
  });

  it("🔴 getTagPagesProps 用 tags 让服务端过滤，且**从不**调用那个忽略参数的死函数", async () => {
    vi.resetModules();
    const byOption = vi.fn(async (option: any) => {
      // 桩自检：调用方必须真的把标签传下来，否则这条用例证明不了「服务端过滤」
      expect(option).toMatchObject({ tags: "Life", toListView: true });
      return {
        articles: [
          fatArticle(1, "2026-05-10T00:00:00.000Z", "p1"),
          fatArticle(2, "2024-07-07T00:00:00.000Z", "p2"),
        ],
        total: 2,
        totalWordCount: 800,
      };
    });
    const dead = vi.fn(async () => ({ Life: [fatArticle(9, "2020-01-01T00:00:00.000Z", "p9")] }));
    vi.doMock("../api/getAllData", () => ({ getPublicMeta: async () => metaStub() }));
    vi.doMock("../api/getArticles", () => ({
      getArticleByIdOrPathname: async () => ({}),
      getArticlesByCategory: async () => ({}),
      getArticlesByTimeLine: async () => ({}),
      getArticlesByOption: byOption,
      // 🔴 关键：把死函数也放进桩里。如果 getTagPagesProps 哪天改成用它，
      //    下面的 not.toHaveBeenCalled 就会红 —— 而不是等到线上多下载几十倍数据才发现。
      [DEAD_FN]: dead,
    }));
    const mod = await import("../utils/getPageProps");
    const props: any = await mod.getTagPagesProps("Life");

    expect(byOption).toHaveBeenCalledTimes(1);
    expect(dead).not.toHaveBeenCalled();
    // 数据真的流到了 pageProps（否则「没调用死函数」可能只是因为整条链没跑起来）
    expect(props.currTag).toBe("Life");
    expect(props.curNum).toBe(2);
    expect(props.wordTotal).toBe(800);
    const groups = props.sortedArticles as Record<string, any[]>;
    const all = Object.values(groups).flat();
    expect(all.length).toBe(2);
    // 窄类型：每篇恰好 4 个字段，肥字段一个都不许漏进 pageProps
    for (const a of all) {
      expect(Object.keys(a).sort()).toEqual(["createdAt", "id", "pathname", "title"]);
    }
    vi.doUnmock("../api/getArticles");
    vi.doUnmock("../api/getAllData");
    vi.resetModules();
  });

  it("🔴 源码棘轮：那个死函数在**定义文件之外**零引用（接上去就会红）", () => {
    const files = scanWebsiteSource();
    // 尺子有效性：必须真的扫到了东西，否则「零引用」在扫不到文件时恒真
    expect(files.length).toBeGreaterThan(60);
    expect(files.some((f) => f.rel === "api/getArticles.ts")).toBe(true);

    const hits = files
      .filter((f) => f.rel !== "api/getArticles.ts")
      .filter((f) => f.code.includes(DEAD_FN))
      .map((f) => f.rel);
    expect(hits).toEqual([]);

    // 定义本身还在（它被跨包守卫钉着，见文件头）—— 这条同时证明扫描器读到了真代码
    const def = files.find((f) => f.rel === "api/getArticles.ts");
    expect(def?.code.includes(`export const ${DEAD_FN} =`)).toBe(true);
  });

  it("🔴 尺子有效性反证：扫描器**真的**能数到引用（否则上一条恒绿）", () => {
    const synthetic = [
      { rel: "utils/getPageProps.ts", code: `import { ${DEAD_FN} } from "../api/getArticles";` },
      { rel: "pages/tag/[tag].tsx", code: `const d = await ${DEAD_FN}(t);` },
      // 注释与字符串里的同名字样**不算**引用（守卫不能被文档喂饱）
      { rel: "utils/x.ts", code: `// ${DEAD_FN} 只在注释里` },
      { rel: "utils/y.ts", code: `const s = "${DEAD_FN}";` },
    ];
    // ⚠️ 合成样本必须**真的过一遍剥离器**，否则「注释与字符串里的同名字样不算引用」
    //    这条根本没被验证（我第一版就是直接 filter 原始文本，于是四条全命中、反证失效）。
    const real = synthetic
      .map((f) => ({ rel: f.rel, code: stripCommentsAndStrings(f.code) }))
      .filter((f) => f.code.includes(DEAD_FN))
      .map((f) => f.rel);
    expect(real).toEqual(["utils/getPageProps.ts", "pages/tag/[tag].tsx"]);
    // 剥注释/剥字符串确实生效（上面两条被排除就是证据）
    expect(stripCommentsAndStrings(`// ${DEAD_FN}\nconst a = 1;`).includes(DEAD_FN)).toBe(false);
    expect(stripCommentsAndStrings(`const s = "${DEAD_FN}";`).includes(DEAD_FN)).toBe(false);
    expect(stripCommentsAndStrings(`const a = ${DEAD_FN}(1);`).includes(DEAD_FN)).toBe(true);
  });
});

describe("为什么不能改用 /api/public/tag/:name —— pathname 缺失会静默改链接", () => {
  it("🔴 getArticlePath 在没有 pathname 时回落到数字 id（这就是静默改链接的机制）", () => {
    expect(getArticlePath({ id: 7, pathname: "my-alias" } as any)).toBe("my-alias");
    // 实测 /api/public/tag/:name 每篇只有 category/createdAt/id/tags/title/top/updatedAt
    const fromTagByNameEndpoint = {
      id: 7,
      title: "t",
      createdAt: "2026-05-10T00:00:00.000Z",
      category: "博客",
      tags: ["Life"],
      top: false,
      updatedAt: "2026-05-10T00:00:00.000Z",
    };
    expect("pathname" in fromTagByNameEndpoint).toBe(false);
    expect(getArticlePath(fromTagByNameEndpoint as any)).toBe("7");
    // 两者不同 ⇒ 换数据源会改变渲染出的链接（多一跳 301、HTML 也变）
    expect(getArticlePath(fromTagByNameEndpoint as any)).not.toBe(
      getArticlePath({ id: 7, pathname: "my-alias" } as any)
    );
  });

  it("🔴 窄类型 TimelineArticleRef 把 pathname 列为**必需**字段", () => {
    // ⚠️ 这里必须用**只剥注释**的那把尺子：字段名是字符串字面量，
    //    连字符串一起剥会把它们抹掉、让断言恒假（见 stripCommentsOnly 的注释）。
    const src = stripCommentsOnly(
      fs.readFileSync(path.join(websiteRoot, "utils/timelineMonths.ts"), "utf-8")
    );
    // 必需（不是 pathname?:）—— 少一个问号，缺字段就会在编译期被发现
    expect(src).toMatch(/export type TimelineArticleRef = Pick<\s*Article,\s*"id" \| "title" \| "createdAt" \| "pathname"\s*>/);
    expect(src).not.toMatch(/"pathname\?"/);
  });

  it("⚠️ 标签页仍走 getTagPagesProps（换数据源必须先动这里，而它有上面的棘轮看着）", () => {
    const page = stripCommentsAndStrings(
      fs.readFileSync(path.join(websiteRoot, "pages/tag/[tag].tsx"), "utf-8")
    );
    expect(page).toMatch(/getTagPagesProps\(params\.tag\)/);
    expect(page.includes(DEAD_FN)).toBe(false);
  });
});
