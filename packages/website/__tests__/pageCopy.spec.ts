import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { PublicMetaProp } from "../api/getAllData";
import {
  getAboutTitleCopy,
  getFriendLinkCopy,
  getLayoutProps,
} from "../utils/getLayoutProps";
import {
  DEFAULT_ABOUT_TITLE,
  DEFAULT_FRIEND_LINK_APPLY_CONTENT,
  DEFAULT_FRIEND_LINK_INTRO,
  interpolatePageCopy,
  renderFriendLinkApplyContent,
  resolvePageCopy,
} from "../utils/pageCopy";

const websiteRoot = path.join(__dirname, "..");
const readSrc = (rel: string) =>
  readFileSync(path.join(websiteRoot, rel), "utf8");

const metaOf = (siteInfoExtra: Record<string, unknown> = {}): PublicMetaProp =>
  ({
    version: "test",
    tags: [],
    totalArticles: 0,
    totalWordCount: 0,
    menus: [],
    meta: {
      links: [],
      socials: [],
      rewards: [],
      categories: [],
      about: { updatedAt: "", content: "already editable about body" },
      siteInfo: {
        author: "a",
        authorDesc: "d",
        authorLogo: "/l.svg",
        siteLogo: "/s.svg",
        favicon: "/f.svg",
        siteName: "VanBlog",
        siteDesc: "desc",
        beianNumber: "",
        beianUrl: "",
        gaBeianNumber: "",
        gaBeianUrl: "",
        gaBeianLogoUrl: "",
        payAliPay: "",
        payWechat: "",
        since: "",
        baseUrl: "",
        copyrightAggreement: "",
        showDonateInfo: "true",
        enableComment: "true",
        defaultTheme: "auto",
        enableCustomizing: "true",
        showDonateButton: "true",
        showCopyRight: "true",
        showRSS: "true",
        openArticleLinksInNewWindow: "false",
        showExpirationReminder: "true",
        showEditButton: "false",
        ...siteInfoExtra,
      },
    },
  } as PublicMetaProp);

describe("pageCopy fallbacks (#373)", () => {
  it("defaults to the previous hardcoded friend-link and about copy", () => {
    expect(DEFAULT_FRIEND_LINK_INTRO).toBe("以下是本站的友情链接，排名不分先后：");
    expect(DEFAULT_ABOUT_TITLE).toBe("关于我");
    expect(resolvePageCopy(undefined, DEFAULT_FRIEND_LINK_INTRO)).toBe(
      DEFAULT_FRIEND_LINK_INTRO
    );
    expect(resolvePageCopy("", DEFAULT_FRIEND_LINK_INTRO)).toBe(
      DEFAULT_FRIEND_LINK_INTRO
    );
    expect(resolvePageCopy("   ", DEFAULT_ABOUT_TITLE)).toBe(DEFAULT_ABOUT_TITLE);
  });

  it("renders custom apply markdown and interpolates site placeholders", () => {
    const custom = "申请前先留言。\n名称：{{siteName}} 简介：{{description}}";
    expect(resolvePageCopy(custom, DEFAULT_FRIEND_LINK_APPLY_CONTENT)).toBe(
      custom
    );
    expect(
      interpolatePageCopy(custom, {
        siteName: "Demo",
        description: "hello",
        url: "https://blog.example",
        logo: "https://blog.example/logo.svg",
      })
    ).toBe("申请前先留言。\n名称：Demo 简介：hello");
  });

  it("default apply template still prints 本站信息 after interpolation", () => {
    const rendered = renderFriendLinkApplyContent(undefined, {
      siteName: "VanBlog",
      description: "desc",
      url: "https://blog.example",
      logo: "https://blog.example/logo.svg",
    });
    expect(rendered).toContain("请先添加本站为友链后再申请友链");
    expect(rendered).toContain("名称： VanBlog");
    expect(rendered).toContain("简介： desc");
    expect(rendered).toContain("[https://blog.example](https://blog.example)");
    expect(rendered).toContain(
      "[https://blog.example/logo.svg](https://blog.example/logo.svg)"
    );
    expect(rendered).not.toContain("{{siteName}}");
  });
});

describe("layout props expose resolved page copy (#373)", () => {
  it("falls back when siteInfo omits the new fields", () => {
    const data = metaOf();
    // 🔴 2026-09-21 升级（不是放宽）：#373 的性质是"后台没填这些字段时要回落到内置默认文案"，
    //    这条性质**原样保留**；变的只是承载者 —— 三段文案已从 LayoutProps 移到 opt-in helper，
    //    因为它们只被 /link 与 /about 读，却曾出现在每个页面的 pageProps 里（~750B gzip/页）。
    expect(getFriendLinkCopy(data).friendLinkIntro).toBe(DEFAULT_FRIEND_LINK_INTRO);
    expect(getFriendLinkCopy(data).friendLinkApplyContent).toBe(
      DEFAULT_FRIEND_LINK_APPLY_CONTENT
    );
    expect(getAboutTitleCopy(data).aboutTitle).toBe(DEFAULT_ABOUT_TITLE);
    // 并钉住新性质：默认路径不再带它们
    const layout = getLayoutProps(data);
    expect("friendLinkIntro" in layout).toBe(false);
    expect("friendLinkApplyContent" in layout).toBe(false);
    expect("aboutTitle" in layout).toBe(false);
  });

  it("uses custom text when the setting is set", () => {
    const data = metaOf({
      friendLinkIntro: "这些是朋友们的站点：",
      friendLinkApplyContent: "请发邮件申请。站点：{{siteName}}",
      aboutTitle: "About this blog",
    });
    const layout = { ...getLayoutProps(data), ...getFriendLinkCopy(data) };
    expect(layout.friendLinkIntro).toBe("这些是朋友们的站点：");
    expect(layout.friendLinkApplyContent).toBe("请发邮件申请。站点：{{siteName}}");
    expect(getAboutTitleCopy(data).aboutTitle).toBe("About this blog");
    expect(
      renderFriendLinkApplyContent(layout.friendLinkApplyContent, {
        siteName: "VanBlog",
        description: "desc",
        url: "https://x",
        logo: "/l.svg",
      })
    ).toBe("请发邮件申请。站点：VanBlog");
  });

  it("empty strings still fall back so existing sites look unchanged", () => {
    // 🔴 2026-09-21 升级（不是放宽）：这条的性质是"后台填了空串/空白 ⇒ 仍回落到内置默认文案，
    //    老站看起来不变"。性质**原样保留**，只是承载者从 LayoutProps 换成了 opt-in helper
    //    （三段文案只被 /link 与 /about 读，却曾出现在每个页面的 pageProps 里）。
    const data = metaOf({
      friendLinkIntro: "",
      friendLinkApplyContent: "  ",
      aboutTitle: "",
    });
    expect(getFriendLinkCopy(data).friendLinkIntro).toBe(DEFAULT_FRIEND_LINK_INTRO);
    expect(getFriendLinkCopy(data).friendLinkApplyContent).toBe(
      DEFAULT_FRIEND_LINK_APPLY_CONTENT
    );
    expect(getAboutTitleCopy(data).aboutTitle).toBe(DEFAULT_ABOUT_TITLE);
  });
});

describe("front pages read the site-config copy (#373)", () => {
  it("friend-link page renders intro and apply content from layout props", () => {
    const src = readSrc("pages/link.tsx");
    expect(src).toMatch(/props\.layoutProps\.friendLinkIntro/);
    expect(src).toMatch(/renderFriendLinkApplyContent/);
    expect(src).toMatch(/props\.layoutProps\.friendLinkApplyContent/);
    expect(src).not.toMatch(/以下是本站的友情链接，排名不分先后：/);
    expect(src).not.toMatch(/请先添加本站为友链后再申请友链/);
  });

  it("about page title comes from layout props; body stays meta.about.content", () => {
    const src = readSrc("pages/about.tsx");
    expect(src).toMatch(/props\.layoutProps\.aboutTitle/);
    expect(src).toMatch(/props\.about\.content/);
    expect(src).not.toMatch(/title="关于我"/);
    expect(src).not.toMatch(/title=\{"关于我"\}/);
  });
});
