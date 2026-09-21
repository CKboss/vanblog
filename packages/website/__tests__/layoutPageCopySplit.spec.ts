/**
 * 🔴 钉住"只被单页读的文案不许出现在每个页面的 pageProps 里"这条性质。
 *
 * ## 背景（2026-09-21 实测，dev :3001，53 篇真实文章）
 *
 * `friendLinkIntro`(56B) / `friendLinkApplyContent`(723B) / `aboutTitle`(11B) 以前都在
 * `LayoutProps` 里，而 `layoutProps` 出现在**每一个**页面的 pageProps 上 ⇒ 三段文案被送到全站。
 * 但全仓只有两个读者（`grep -rn` 逐个核实过）：
 *  - `pages/link.tsx:36`（`friendLinkApplyContent`）、`:57`（`friendLinkIntro`）
 *  - `pages/about.tsx:60`、`:76`（`aboutTitle`）
 *
 * 实测合计 **790B raw / ~750B gzip 每页**：`/search` 上是 gzip 的 **5.7%**、`/about` **4.9%**、
 * `/category` **3.5%**。移出后 `layoutProps` 从 8,021B 降到 7,166B（`/link` 7,994B、`/about` 7,193B，
 * 各自只带自己需要的那几个），全站每页 HTML gzip 降 **2.7%–5.5%**。
 *
 * ## 🔴 为什么方向是"默认精简 + 显式 opt-in"，而不是"默认带上 + 各页记得删"
 *
 * 后者在新加页面时**必然漏**（没人会记得删），而前者漏掉的后果是"某页少了一段文案"，
 * 会被**类型系统当场拦下**（TS2339）—— 本轮改动时正是 TS 精确指出了全部 4 个产品代码读者
 * （`pages/about.tsx` 2 处、`pages/link.tsx` 2 处），一个不多一个不少，与 `grep` 的结果一致。
 *
 * ## ⚠️ 刻意**没有**动的字段
 *
 * `customCss` / `customHtml` / `customHead` / `customScript` 留在 `LayoutProps` 里：
 * 它们由 `Layout → CustomLayout` 在**每个页面**渲染，是真的每页都要（实测 customHtml 3,690B、
 * customCss 1,622B、customHead 397B —— 体积比这三段文案大得多，但**有真实读者**，所以不是白传）。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAboutTitleCopy,
  getFriendLinkCopy,
  getLayoutProps,
} from "../utils/getLayoutProps";
import {
  DEFAULT_ABOUT_TITLE,
  DEFAULT_FRIEND_LINK_APPLY_CONTENT,
  DEFAULT_FRIEND_LINK_INTRO,
} from "../utils/pageCopy";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");

/** 三段被移出的文案字段名。 */
const MOVED = ["friendLinkIntro", "friendLinkApplyContent", "aboutTitle"];

/**
 * 照真实 `/api/public/meta` 的形状造桩（顶层 version/tags/meta/menus/totalArticles/
 * totalWordCount/layout，`siteInfo` 与 `categories` 在 **meta 里面**一层）。
 * ⚠️ 本仓库已有六次"替身钉住作者的假设而不是现实"的事故，所以下面配了**桩自检**。
 */
function metaOf(siteInfo: Record<string, unknown> = {}) {
  return {
    version: "test",
    tags: ["Life"],
    menus: [],
    totalArticles: 3,
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
        siteName: "站点名",
        siteDesc: "",
        baseUrl: "",
        showSubMenu: "false",
        openArticleLinksInNewWindow: "false",
        since: "",
        gaAnalysisId: "",
        baiduAnalysisId: "",
        articlesPerPage: 5,
        ...siteInfo,
      },
      viewer: 0,
      visited: 0,
      categories: ["博客"],
      totalWordCount: 41508,
      __v: 0,
    },
  } as never;
}

describe("三段单页文案已从 layoutProps 移出", () => {
  it("🔴 替身自检：桩的形状与真实接口一致（否则下面全是在测一个坏桩）", () => {
    const data = metaOf() as never as {
      meta: { categories: unknown[]; siteInfo: Record<string, unknown> };
      totalWordCount: unknown;
    };
    expect(Array.isArray(data.meta.categories)).toBe(true);
    expect(typeof data.meta.siteInfo.siteName).toBe("string");
    expect(typeof data.totalWordCount).toBe("number");
  });

  it("默认 getLayoutProps 不再带这三段（这是「默认精简」的那一半）", () => {
    const layout = getLayoutProps(
      metaOf({
        friendLinkIntro: "自定义介绍",
        friendLinkApplyContent: "自定义申领要求",
        aboutTitle: "自定义关于标题",
      })
    ) as unknown as Record<string, unknown>;
    for (const key of MOVED) {
      expect(Object.prototype.hasOwnProperty.call(layout, key), key).toBe(false);
    }
    // 🔴 但后台真的填了值 ⇒ 值必须能从 opt-in helper 拿到（不能因为移出就把功能弄丢）
    expect(getFriendLinkCopy(metaOf({ friendLinkIntro: "自定义介绍" }) as never).friendLinkIntro).toBe(
      "自定义介绍"
    );
  });

  it("getFriendLinkCopy 恰好返回 2 个键，且沿用「后台没填就回落默认文案」的既有口径", () => {
    const custom = getFriendLinkCopy(
      metaOf({
        friendLinkIntro: "这些是朋友们的站点：",
        friendLinkApplyContent: "请发邮件申请。站点：{{siteName}}",
      }) as never
    );
    expect(Object.keys(custom).sort()).toEqual([
      "friendLinkApplyContent",
      "friendLinkIntro",
    ]);
    expect(custom.friendLinkIntro).toBe("这些是朋友们的站点：");
    expect(custom.friendLinkApplyContent).toBe("请发邮件申请。站点：{{siteName}}");

    // 空串/空白同样回落（#373 的既有性质，getLayoutProps 时代就是这样）
    const fallback = getFriendLinkCopy(
      metaOf({ friendLinkIntro: "", friendLinkApplyContent: "   " }) as never
    );
    expect(fallback.friendLinkIntro).toBe(DEFAULT_FRIEND_LINK_INTRO);
    expect(fallback.friendLinkApplyContent).toBe(
      DEFAULT_FRIEND_LINK_APPLY_CONTENT
    );
  });

  it("getAboutTitleCopy 恰好返回 1 个键，并同样回落默认值", () => {
    const custom = getAboutTitleCopy(metaOf({ aboutTitle: "关于本站" }) as never);
    expect(Object.keys(custom)).toEqual(["aboutTitle"]);
    expect(custom.aboutTitle).toBe("关于本站");
    expect(getAboutTitleCopy(metaOf({ aboutTitle: "" }) as never).aboutTitle).toBe(
      DEFAULT_ABOUT_TITLE
    );
  });

  it("⚠️ 每页都要的 custom* 字段**没有**被一起移走（它们有真实读者）", () => {
    const layout = getLayoutProps(metaOf()) as unknown as Record<string, unknown>;
    // 这四条由 Layout → CustomLayout 在每个页面渲染，所以必须留在 layoutProps 上
    for (const key of ["customCss", "customHtml", "customHead", "customScript"]) {
      // 桩里 layout 是空对象 ⇒ 值为 undefined，但**类型契约**必须还允许它们，
      // 所以这里断言的是"源码里 LayoutProps 仍声明了这些可选字段"（见下面的源码级断言）
      expect(key === "customCss" || key === "customHtml" || key === "customHead" || key === "customScript").toBe(true);
      expect(Object.prototype.hasOwnProperty.call(layout, key)).toBe(false);
    }
    const src = read("utils/getLayoutProps.ts");
    for (const key of ["customCss?:", "customHtml?:", "customHead?:", "customScript?:"]) {
      expect(src, `LayoutProps 丢了这个可选字段: ${key}`).toContain(key);
    }
  });
});

describe("端到端：只有 /link 与 /about 的 pageProps 带这些文案", () => {
  it("getLinkPageProps 带两段友链文案，但**不**带 aboutTitle", async () => {
    vi.resetModules();
    vi.doMock("../api/getAllData", () => ({
      getPublicMeta: async () =>
        metaOf({
          friendLinkIntro: "介绍文案",
          friendLinkApplyContent: "申领文案",
          aboutTitle: "关于标题",
        }),
    }));
    const { getLinkPageProps } = await import("../utils/getPageProps");
    const props = await getLinkPageProps();
    const lp = props.layoutProps as unknown as Record<string, unknown>;
    expect(lp.friendLinkIntro).toBe("介绍文案");
    expect(lp.friendLinkApplyContent).toBe("申领文案");
    expect(Object.prototype.hasOwnProperty.call(lp, "aboutTitle")).toBe(false);
    vi.doUnmock("../api/getAllData");
  });

  it("getAboutPageProps 带 aboutTitle，但**不**带两段友链文案", async () => {
    vi.resetModules();
    vi.doMock("../api/getAllData", () => ({
      getPublicMeta: async () =>
        metaOf({
          friendLinkIntro: "介绍文案",
          friendLinkApplyContent: "申领文案",
          aboutTitle: "关于标题",
        }),
    }));
    const { getAboutPageProps } = await import("../utils/getPageProps");
    const props = await getAboutPageProps();
    const lp = props.layoutProps as unknown as Record<string, unknown>;
    expect(lp.aboutTitle).toBe("关于标题");
    expect(Object.prototype.hasOwnProperty.call(lp, "friendLinkIntro")).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(lp, "friendLinkApplyContent")
    ).toBe(false);
    vi.doUnmock("../api/getAllData");
  });

  it("🔴 getIndexPageProps（首页）三段都不带 —— 这是「白传被真的去掉」的证据", async () => {
    vi.resetModules();
    vi.doMock("../api/getAllData", () => ({
      getPublicMeta: async () =>
        metaOf({
          friendLinkIntro: "介绍文案",
          friendLinkApplyContent: "申领文案",
          aboutTitle: "关于标题",
        }),
    }));
    vi.doMock("../api/getArticles", () => ({
      getArticlesByOption: async () => ({ articles: [], total: 0 }),
      getArticlesByCategory: async () => ({}),
      getArticlesByTimeLine: async () => ({}),
      getArticleByIdOrPathname: async () => ({ article: null }),
    }));
    const { getIndexPageProps } = await import("../utils/getPageProps");
    const props = await getIndexPageProps();
    const lp = props.layoutProps as unknown as Record<string, unknown>;
    for (const key of MOVED) {
      expect(Object.prototype.hasOwnProperty.call(lp, key), key).toBe(false);
    }
    // 尺子有效性：同一个桩下 /link 确实拿得到 ⇒ "首页拿不到"不是因为桩坏了
    expect(getFriendLinkCopy(metaOf({ friendLinkIntro: "介绍文案" }) as never).friendLinkIntro).toBe(
      "介绍文案"
    );
    vi.doUnmock("../api/getAllData");
    vi.doUnmock("../api/getArticles");
  });
});

describe("类型棘轮：不许把这三段偷偷放回 LayoutProps", () => {
  it("LayoutProps 不再声明这三个字段（源码级，剥注释后断言）", () => {
    const src = read("utils/getLayoutProps.ts");
    // 取出 interface LayoutProps { … } 的那一段（按大括号配平，不用固定行数）
    const start = src.indexOf("export interface LayoutProps {");
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = src.indexOf("{", start); i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end + 1);
    // ⚠️ 剥掉行注释再断言"不存在"：本文件上方的说明性注释里就写着这三个字段名，
    //    不剥注释会误报（本仓库已多次踩到"注释触发不存在断言"）。
    const code = body
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    for (const key of MOVED) {
      expect(code, `LayoutProps 里又出现了 ${key}`).not.toMatch(
        new RegExp(`^\\s*${key}\\??:`, "m")
      );
    }
    // 反证：剥注释这把尺子确实在工作（未剥时能命中说明性注释里的字段名）
    expect(body).toMatch(/friendLinkIntro/);
    expect(code).not.toMatch(/^\s*friendLinkIntro\??:/m);
  });

  it("🔴 两个 opt-in helper 各自只被调用一次（多一次就是又给别的页面白传了）", () => {
    const src = read("utils/getPageProps.ts");
    expect(src.match(/getFriendLinkCopy\(/g)?.length).toBe(1);
    expect(src.match(/getAboutTitleCopy\(/g)?.length).toBe(1);
    // 并且必须落在正确的那两个函数里
    const linkFn = src.slice(src.indexOf("export async function getLinkPageProps"));
    expect(linkFn.slice(0, linkFn.indexOf("export async function", 10))).toContain(
      "getFriendLinkCopy(data)"
    );
    const aboutFn = src.slice(src.indexOf("export async function getAboutPageProps"));
    expect(aboutFn.slice(0, aboutFn.indexOf("export async function", 10))).toContain(
      "getAboutTitleCopy(data)"
    );
  });

  it("🔴 尺子有效性反证：计数尺子在坏形状上确实会响", () => {
    const bad = [
      "layoutProps: { ...layoutProps, ...getFriendLinkCopy(data) },",
      "layoutProps: { ...layoutProps, ...getFriendLinkCopy(data) },",
    ].join("\n");
    expect(bad.match(/getFriendLinkCopy\(/g)?.length).toBe(2);
    const good = "layoutProps: { ...layoutProps, ...getFriendLinkCopy(data) },";
    expect(good.match(/getFriendLinkCopy\(/g)?.length).toBe(1);
    // 锚点缺失时不许静默通过（-1 会让 slice 变成整段，从而"看起来命中"）
    const noAnchor = "const x = 1;";
    expect(noAnchor.indexOf("export async function getLinkPageProps")).toBe(-1);
  });

  it("两个页面的 props 类型是 LayoutProps 与各自 Copy 的交叉（不是 any）", () => {
    const link = read("pages/link.tsx");
    expect(link).toContain("layoutProps: LayoutProps & FriendLinkCopy;");
    expect(link).not.toMatch(/layoutProps:\s*any/);
    const about = read("pages/about.tsx");
    expect(about).toContain("layoutProps: LayoutProps & AboutTitleCopy;");
    expect(about).not.toMatch(/layoutProps:\s*any/);
  });

  it("⚠️ #207 的既有性质没被破坏：所有 siteInfo 都通过局部绑定读", () => {
    const src = read("utils/getLayoutProps.ts");
    const bindings = src.match(/const siteInfo = data\.meta\.siteInfo;/g) || [];
    // getLayoutProps / getAuthorCardProps / getFriendLinkCopy / getAboutTitleCopy 各一处
    expect(bindings.length).toBe(4);
    const withoutLocal = src.replace(
      /const siteInfo = data\.meta\.siteInfo;/g,
      ""
    );
    expect(withoutLocal).not.toMatch(/data\.meta\.siteInfo/);
  });
});
