import { describe, expect, it } from "vitest";

import { formatReadingTime } from "../utils/readingTime";
import { formatTimeAgo } from "../utils/relativeTime";
import { formatTimelineMonthLabel } from "../utils/timelineMonths";
import { IDENTITY_T, type TFunc } from "../utils/i18n";

/**
 * 🔴 期 10 第二批：证明"注入尾参 `t`"这个接缝**真的接通了**（不是装饰）。
 *
 * 三件事各钉一条：
 * ① **默认行为逐字节不变**：不传 `t` 时（= `IDENTITY_T`）输出与迁移前完全一样；
 * ② **传进词典就能换语言**：用一个假 `t` 返回英文模板 ⇒ 输出真的变成英文，且 `{n}` / `{m}` 被插值；
 * ③ 🔴 **反向**：如果哪天有人把 `t(...)` 改回硬编码中文，②就会红 ——
 *    这正是"接缝有没有被偷偷拆掉"的唯一可判定信号（①是看不出来的，因为默认值就是中文）。
 */
const EN: Record<string, string> = {
  "readingTime.minutes": "About {n} min read",
  "relativeTime.justNow": "just now",
  "relativeTime.seconds": "{n}s ago",
  "relativeTime.minutes": "{n} minutes ago",
  "relativeTime.hours": "{n} hours ago",
  "relativeTime.days": "{n} days ago",
  "timeline.monthLabel": "Month {m}",
};

/** 极简假翻译器：查得到就用（并做 {name} 插值），查不到就退回中文默认值。 */
const fakeT: TFunc = (id, defaultMessage, values) => {
  const hit = EN[id];
  const tpl = typeof hit === "string" && hit ? hit : defaultMessage;
  let out = tpl;
  for (const [k, v] of Object.entries(values || {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
};

describe("前台 i18n 接缝 · 注入尾参 t（readingTime / relativeTime / timelineMonths）", () => {
  it("① 不传 t 时行为与迁移前逐字节相同（IDENTITY_T 是默认值）", () => {
    expect(formatReadingTime(7)).toBe("约 7 分钟");
    expect(formatReadingTime(7, IDENTITY_T)).toBe("约 7 分钟");
    expect(formatReadingTime(null)).toBeNull();
    expect(formatReadingTime("abc")).toBeNull();

    const now = Date.parse("2026-09-30T10:00:00Z");
    const at = (iso: string) => formatTimeAgo(iso, now);
    expect(at("2026-09-30T10:00:00Z")).toBe("刚刚");
    expect(at("2026-09-30T09:59:30Z")).toBe("30秒前");
    expect(at("2026-09-30T09:30:00Z")).toBe("30分钟前");
    expect(at("2026-09-30T07:00:00Z")).toBe("3小时前");
    expect(at("2026-09-28T10:00:00Z")).toBe("2天前");
    expect(formatTimeAgo(null, now)).toBe("-");

    expect(formatTimelineMonthLabel(12)).toBe("12月");
    expect(formatTimelineMonthLabel(3)).toBe("3月");
  });

  it("② 传入词典就能换语言，且占位符被真的插值（接缝是通的）", () => {
    expect(formatReadingTime(7, fakeT)).toBe("About 7 min read");
    expect(String(formatReadingTime(7, fakeT))).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);

    const now = Date.parse("2026-09-30T10:00:00Z");
    const at = (iso: string) => formatTimeAgo(iso, now, fakeT);
    expect(at("2026-09-30T10:00:00Z")).toBe("just now");
    expect(at("2026-09-30T09:59:30Z")).toBe("30s ago");
    expect(at("2026-09-30T09:30:00Z")).toBe("30 minutes ago");
    expect(at("2026-09-30T07:00:00Z")).toBe("3 hours ago");
    expect(at("2026-09-28T10:00:00Z")).toBe("2 days ago");
    // 🔴 词典里没有的 key ⇒ 回落中文默认值（不是裸 key、不是 undefined）
    expect(formatTimeAgo(null, now, fakeT)).toBe("-");

    expect(formatTimelineMonthLabel(12, fakeT)).toBe("Month 12");
  });

  it("③ 🔴 反向：三个函数都必须**把 t 用在返回值上**（有人改回硬编码中文就会红）", () => {
    // 用一个"总是返回哨兵"的 t：如果函数没有把 t 用在返回值上，哨兵就不会出现。
    const SENTINEL = "__I18N_SEAM_WAS_USED__";
    const sentinelT: TFunc = () => SENTINEL;
    expect(formatReadingTime(7, sentinelT)).toBe(SENTINEL);
    expect(formatTimeAgo("2026-09-30T09:30:00Z", Date.parse("2026-09-30T10:00:00Z"), sentinelT)).toBe(SENTINEL);
    expect(formatTimelineMonthLabel(3, sentinelT)).toBe(SENTINEL);
    // ⚠️ "不可展示"的分支不该过 t（它返回 null / "-"，不是文案）
    expect(formatReadingTime(null, sentinelT)).toBeNull();
  });
});

// ── 期 10 第三批：`titleCopyA11y` 那一族（导出常量 + 工厂函数）的接缝验证 ──────────────
import {
  SITE_NAME_COPY_LABEL,
  TITLE_COPY_LABEL,
  TITLE_LINK_COPY_LABEL,
  buildTitleCopyControl,
  describeTitleCopyControls,
  titleCopyLabel,
  titleCopyToast,
} from "../components/PostCard/titleCopyA11y";

const COPY_EN: Record<string, string> = {
  "postCard.copyTitle": "Copy title",
  "postCard.copyArticleLink": "Copy article link",
  "postCard.copySiteName": "Copy site name",
  "postCard.copiedTitle": "Title copied to the clipboard!",
  "postCard.copiedArticleLink": "Article link copied to the clipboard!",
  "postCard.copiedSiteName": "Site name copied to the clipboard!",
};
const copyT: TFunc = (id, defaultMessage, values) => {
  const hit = COPY_EN[id];
  let out = typeof hit === "string" && hit ? hit : defaultMessage;
  for (const [k, v] of Object.entries(values || {})) out = out.split("{" + k + "}").join(String(v));
  return out;
};

describe("前台 i18n 接缝 · 导出常量族（titleCopyA11y）", () => {
  it("① 常量与默认行为不变（既有调用点/测试零改动）", () => {
    expect(TITLE_COPY_LABEL).toBe("复制标题");
    expect(titleCopyLabel("title")).toBe("复制标题");
    expect(titleCopyLabel("link")).toBe("复制文章链接");
    expect(titleCopyLabel("siteName")).toBe("复制站点名");
    expect(titleCopyToast("title")).toMatch(/已复制标题到剪切板/);
    const c = buildTitleCopyControl("siteName");
    expect(c.ariaLabel).toBe("复制站点名");
    expect(c.className).toBe("site-name-copy-btn");
    expect(c.tag).toBe("button");
    expect(describeTitleCopyControls()).toHaveLength(3);
  });

  it("② 传入词典就换语言（三个 kind 各自对，不许串）", () => {
    expect(titleCopyLabel("title", copyT)).toBe("Copy title");
    expect(titleCopyLabel("link", copyT)).toBe("Copy article link");
    expect(titleCopyLabel("siteName", copyT)).toBe("Copy site name");
    expect(titleCopyToast("link", copyT)).toBe("Article link copied to the clipboard!");
    const c = buildTitleCopyControl("title", copyT);
    expect(c.ariaLabel).toBe("Copy title");
    expect(c.toast).toBe("Title copied to the clipboard!");
    // 🔴 className / tag / activateKeys 这些**不是文案**，不许被词典影响
    expect(c.className).toBe("title-copy-btn");
    expect(describeTitleCopyControls(copyT).map((x) => x.ariaLabel)).toEqual([
      "Copy title",
      "Copy article link",
      "Copy site name",
    ]);
  });

  it("③ 🔴 反向：哨兵 t 证明「接缝真的接上了」（把 t(...) 改回常量就会红）", () => {
    const SENTINEL = "__I18N_SEAM_WAS_USED__";
    const sentinelT: TFunc = () => SENTINEL;
    expect(titleCopyLabel("title", sentinelT)).toBe(SENTINEL);
    expect(titleCopyLabel("link", sentinelT)).toBe(SENTINEL);
    expect(titleCopyLabel("siteName", sentinelT)).toBe(SENTINEL);
    expect(titleCopyToast("title", sentinelT)).toBe(SENTINEL);
    expect(titleCopyToast("link", sentinelT)).toBe(SENTINEL);
    expect(titleCopyToast("siteName", sentinelT)).toBe(SENTINEL);
    const c = buildTitleCopyControl("link", sentinelT);
    expect(c.ariaLabel).toBe(SENTINEL);
    expect(c.toast).toBe(SENTINEL);
    // 🔴 但**非文案字段**不许被 t 影响（否则哨兵会污染 className ⇒ 样式与测试锚点全坏）
    expect(c.className).toBe("title-link-copy-btn");
    expect(c.kind).toBe("link");
    expect(describeTitleCopyControls(sentinelT).every((x) => x.ariaLabel === SENTINEL)).toBe(true);
  });

  it("④ 🔴 词典缺 key 时回落中文默认值（不是裸 key、不是 undefined）", () => {
    const partial: TFunc = (id, dm) => (id === "postCard.copyTitle" ? "Copy title" : dm);
    expect(titleCopyLabel("title", partial)).toBe("Copy title");
    expect(titleCopyLabel("link", partial)).toBe(TITLE_LINK_COPY_LABEL);
    expect(titleCopyLabel("siteName", partial)).toBe(SITE_NAME_COPY_LABEL);
  });
});

// ── 期 10 第四批：map 形状的族（`NavBar/a11y`）与单条常量（`UnLockCard/copy`）──
import {
  HEADER_ACTION_LABELS,
  headerActionLabel,
} from "../components/NavBar/a11y";
import {
  LOCKED_ARTICLE_PROMPT,
  lockedArticlePrompt,
} from "../components/UnLockCard/copy";

const NAV_EN: Record<string, string> = {
  "nav.actionSearch": "Search",
  "nav.actionTheme": "Toggle theme",
  "nav.actionRss": "RSS feed",
  "nav.actionAdmin": "Admin panel",
  "nav.actionMenu": "Open menu",
  "unlock.lockedPrompt": "This article is password protected. Enter the password to view it:",
};
const navT: TFunc = (id, dm) => (typeof NAV_EN[id] === "string" && NAV_EN[id] ? NAV_EN[id] : dm);

describe("前台 i18n 接缝 · map 形状的族（headerActionLabel）与单条常量", () => {
  it("① 默认行为不变（map 与常量都原样，五个 kind 各自对）", () => {
    expect(HEADER_ACTION_LABELS.search).toBe("搜索");
    expect(headerActionLabel("search")).toBe("搜索");
    expect(headerActionLabel("theme")).toBe("切换主题");
    expect(headerActionLabel("rss")).toBe("RSS 订阅");
    expect(headerActionLabel("admin")).toBe("管理后台");
    expect(headerActionLabel("menu")).toBe("打开菜单");
    expect(lockedArticlePrompt()).toBe(LOCKED_ARTICLE_PROMPT);
    expect(LOCKED_ARTICLE_PROMPT).toBe("文章已加密，请输入密码后查看：");
  });

  it("② 传词典就换语言，五个 kind 不许串", () => {
    expect(headerActionLabel("search", navT)).toBe("Search");
    expect(headerActionLabel("theme", navT)).toBe("Toggle theme");
    expect(headerActionLabel("rss", navT)).toBe("RSS feed");
    expect(headerActionLabel("admin", navT)).toBe("Admin panel");
    expect(headerActionLabel("menu", navT)).toBe("Open menu");
    expect(lockedArticlePrompt(navT)).toBe(
      "This article is password protected. Enter the password to view it:"
    );
    // 🔴 词典缺 key 时回落中文默认值
    expect(headerActionLabel("search", (id, dm) => dm)).toBe("搜索");
  });

  it("③ 🔴 哨兵反向：五个 kind 与那条提示都必须过 t（改回 map/常量就会红）", () => {
    const SENTINEL = "__I18N_SEAM_WAS_USED__";
    const sentinelT: TFunc = () => SENTINEL;
    for (const kind of ["search", "theme", "rss", "admin", "menu"] as const) {
      expect(headerActionLabel(kind, sentinelT), `kind=${kind} 没有过接缝`).toBe(SENTINEL);
    }
    expect(lockedArticlePrompt(sentinelT)).toBe(SENTINEL);
  });
});

// ── 期 10 第七批：分页跳转那一族（组件 + **纯函数描述符工厂**两种形状）──
import {
  PAGE_NAV_JUMP_GO_LABEL,
  PAGE_NAV_JUMP_LABEL,
  pageNavJumpGoLabel,
  pageNavJumpInputLabel,
  pageNavJumpLabel,
  pageNavJumpPrefix,
  pageNavJumpSentence,
  pageNavJumpUnit,
} from "../components/PageNav/jump";
import { describeSearchJumpForm } from "../components/SearchResults/jumpForm";

const JUMP_EN: Record<string, string> = {
  "pageNav.jumpLabel": "Go to page number",
  "pageNav.jumpPrefix": "Go to",
  "pageNav.jumpUnit": "page",
  "pageNav.jumpInputLabel": "Page number",
  "pageNav.jumpGoLabel": "Go",
  "pageNav.jumpSentence": "Go to page {input}",
};
const jumpT: TFunc = (id, dm, values) => {
  const hit = JUMP_EN[id];
  let out = typeof hit === "string" && hit ? hit : dm;
  for (const [k, v] of Object.entries(values || {})) out = out.split("{" + k + "}").join(String(v));
  return out;
};

describe("前台 i18n 接缝 · 分页跳转族（组件 + 纯函数描述符工厂）", () => {
  const baseProps = { total: 100, perPage: 10, pageHref: "/page/{p}", currentPage: 2, totalPages: 10 } as never;

  it("① 默认行为不变（常量原样，描述符工厂不传 t 时逐字节相同）", () => {
    expect(PAGE_NAV_JUMP_LABEL).toBe("跳转到页码");
    expect(pageNavJumpLabel()).toBe("跳转到页码");
    expect(pageNavJumpPrefix()).toBe("跳转");
    expect(pageNavJumpUnit()).toBe("页");
    expect(pageNavJumpGoLabel()).toBe("前往");
    expect(pageNavJumpSentence("[INPUT]")).toBe("跳转 [INPUT] 页");
    const d = describeSearchJumpForm(baseProps);
    expect(d.labels.form).toBe("跳转到页码");
    expect(d.labels.go).toBe(PAGE_NAV_JUMP_GO_LABEL);
    expect(d.input.ariaLabel).toBe("页码");
    expect(d.submit.label).toBe("前往");
  });

  it("② 传词典就换语言（🔴 整句模板那条语序要真的重排）", () => {
    expect(pageNavJumpLabel(jumpT)).toBe("Go to page number");
    expect(pageNavJumpSentence("[INPUT]", jumpT)).toBe("Go to page [INPUT]");
    const d = describeSearchJumpForm(baseProps, jumpT);
    expect(d.labels).toEqual({
      form: "Go to page number",
      prefix: "Go to",
      unit: "page",
      input: "Page number",
      go: "Go",
    });
    expect(d.input.ariaLabel).toBe("Page number");
    expect(d.submit.ariaLabel).toBe("Go");
    // 🔴 非文案字段不许被词典影响（参数名 / id / min / max / method）
    expect(d.input.name).toBe("p");
    expect(d.input.id).toBe("vanblog-search-jump");
    expect(d.input.max).toBe(10);
    expect(d.form.method).toBe("get");
  });

  it("③ 🔴 哨兵反向：5 条文案 + 描述符工厂里的每一处都必须过 t", () => {
    const SENTINEL = "__I18N_SEAM_WAS_USED__";
    const sentinelT: TFunc = () => SENTINEL;
    expect(pageNavJumpLabel(sentinelT)).toBe(SENTINEL);
    expect(pageNavJumpPrefix(sentinelT)).toBe(SENTINEL);
    expect(pageNavJumpUnit(sentinelT)).toBe(SENTINEL);
    expect(pageNavJumpInputLabel(sentinelT)).toBe(SENTINEL);
    expect(pageNavJumpGoLabel(sentinelT)).toBe(SENTINEL);
    expect(pageNavJumpSentence("X", sentinelT)).toBe(SENTINEL);
    const d = describeSearchJumpForm(baseProps, sentinelT);
    // 🔴 labels 的 5 个字段 + input.ariaLabel + submit.ariaLabel + submit.label 全都要是哨兵
    expect(Object.values(d.labels)).toEqual([SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL]);
    expect(d.input.ariaLabel).toBe(SENTINEL);
    expect(d.submit.ariaLabel).toBe(SENTINEL);
    expect(d.submit.label).toBe(SENTINEL);
    // 🔴 但**非文案字段**不许被哨兵污染（否则参数名/id 变了，表单会提交到错的地方）
    expect(d.input.name).toBe("p");
    expect(d.input.id).toBe("vanblog-search-jump");
    expect(d.form.attr).toBe("data-search-jump-form");
  });
});

// ── 期 10 第十批：合并两份 `timeAgo` 实现（站长裁定「超过 30 天显示日期」）──
import { readFileSync } from "fs";
import path from "path";
import { formatTimeAgoOrDate } from "../utils/relativeTime";

const websiteRoot = path.join(__dirname, "..");

describe("前台 i18n 接缝 · 相对时间的**唯一**实现（formatTimeAgoOrDate）", () => {
  const NOW = Date.parse("2026-10-01T12:00:00Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("① 30 天以内：与 `formatTimeAgo` **同一套 key 与措辞**（一份实现、一套译文）", () => {
    // 🔴 **合并带来第二处刻意的行为变化**（如实报，别藏）：一分钟以内现在显示 `N秒前`，
    //    而评论区原来那份本地实现是"**一分钟内一律显示 刚刚**"。
    //    统一到共享实现后取**更精确**的那个口径（也与后台一致：后台 `formatTimeAgo` 同样是 `45秒前`，
    //    `relativeTime.spec.ts` 里有两边的对等断言钉着）。`刚刚` 只在 `seconds <= 0`
    //    （同一秒、或客户端时钟略快于服务器）时出现。
    expect(formatTimeAgoOrDate(ago(10 * 1000), NOW)).toBe("10秒前");
    expect(formatTimeAgoOrDate(ago(0), NOW)).toBe("刚刚");
    expect(formatTimeAgoOrDate(ago(45 * 1000), NOW)).toBe("45秒前");
    expect(formatTimeAgoOrDate(ago(30 * MIN), NOW)).toBe("30分钟前");
    expect(formatTimeAgoOrDate(ago(3 * HOUR), NOW)).toBe("3小时前");
    expect(formatTimeAgoOrDate(ago(5 * DAY), NOW)).toBe("5天前");
    // 🔴 合并后**没有空格**（统一到与后台一致的口径；`relativeTime.spec.ts` 里有对等断言钉着 `45秒前`）
    expect(formatTimeAgoOrDate(ago(30 * MIN), NOW)).not.toContain(" 分钟前");
    // 传词典就换语言（证明它把 t 透传给了 formatTimeAgo，而不是自己另写一套）
    const en: TFunc = (id, dm, values) => {
      const table: Record<string, string> = {
        "relativeTime.justNow": "just now",
        "relativeTime.seconds": "{n}s ago",
        "relativeTime.minutes": "{n} minutes ago",
        "relativeTime.hours": "{n} hours ago",
        "relativeTime.days": "{n} days ago",
      };
      let out = table[id] || dm;
      for (const [k, v] of Object.entries(values || {})) out = out.split("{" + k + "}").join(String(v));
      return out;
    };
    expect(formatTimeAgoOrDate(ago(3 * HOUR), NOW, en)).toBe("3 hours ago");
  });

  it("② 🔴 超过 30 天：**显示日期**（站长裁定），而且**不过接缝**（那是平台的格式化结果）", () => {
    const out = formatTimeAgoOrDate(ago(31 * DAY), NOW);
    const expected = new Date(NOW - 31 * DAY).toLocaleDateString();
    expect(out).toBe(expected);
    expect(out).not.toBe("31天前");
    // 🔴 哨兵：日期那一段**不许**过 t（它是 `toLocaleDateString()` 的输出，不是我们写的文案；
    //    站长另一条裁定是"时间跟着浏览器的 locale 走"⇒ 它由平台决定，不由词典决定）
    const SENTINEL = "__I18N_SEAM_WAS_USED__";
    expect(formatTimeAgoOrDate(ago(31 * DAY), NOW, () => SENTINEL)).not.toBe(SENTINEL);
    expect(formatTimeAgoOrDate(ago(31 * DAY), NOW, () => SENTINEL)).toBe(expected);
    // 而 30 天以内**必须**过 t
    expect(formatTimeAgoOrDate(ago(5 * DAY), NOW, () => SENTINEL)).toBe(SENTINEL);
  });

  it("③ 🔴 边界与兜底：正好 30 天算「以内」，坏日期用调用方给的 invalidText", () => {
    // 边界：29.9 天 → 相对时间；30 天整 → 日期（实现是 `seconds >= 30 * 86400`）
    expect(formatTimeAgoOrDate(ago(30 * DAY - 1000), NOW)).toBe("29天前");
    expect(formatTimeAgoOrDate(ago(30 * DAY), NOW)).toBe(new Date(NOW - 30 * DAY).toLocaleDateString());
    // 兜底：默认 "-"（与 formatTimeAgo 一致），评论区传 "" 保持它今天的行为
    expect(formatTimeAgoOrDate(null, NOW)).toBe("-");
    expect(formatTimeAgoOrDate("", NOW)).toBe("-");
    expect(formatTimeAgoOrDate("不是日期", NOW)).toBe("-");
    expect(formatTimeAgoOrDate("不是日期", NOW, undefined, "")).toBe("");
    expect(formatTimeAgoOrDate(null, NOW, undefined, "")).toBe("");
  });

  it("④ 🔴 源码级钉子：评论区里**不许再有第二份实现**（合并的意义就在于此）", () => {
    // ⚠️ **先剥掉注释再断言**（本仓库的老规矩）：我在评论区写的那段说明里就提到了
    //    "从 `30 分钟前` 变成 `30分钟前`" ⇒ 不剥注释的话，这条断言会被**我自己的解释文字**打红。
    //    👉 🔴 "源码里不许出现某个字符串"这类判据，必须先剥注释（文档里的引用是合法的，代码里的才是违规）。
    const src = readFileSync(path.join(websiteRoot, "components/Comment/index.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(src).not.toMatch(/function timeAgo\(/);
    // 🔴 也不许把相对时间的中文措辞再写一遍（那等于又开了一份实现）
    expect(src).not.toContain("分钟前");
    expect(src).not.toContain("小时前");
    expect(src).not.toContain("天前");
    expect(src).toMatch(/formatTimeAgoOrDate\(item\.createdAt, Date\.now\(\), t, ""\)/);
    // 🔴 `comment.time*` 那 4 个 key 必须真的从两份词典里移除（否则就是孤儿 key，
    //    覆盖率对账第 ② 条也会红 —— 这里是**双保险**，因为孤儿 key 判据只看"代码里有没有用"，
    //    而这条还钉住"评论区不许再引用它们"）
    for (const loc of ["zh-TW", "en-US"]) {
      const dict = readFileSync(path.join(websiteRoot, "locales/" + loc + ".ts"), "utf8");
      expect(dict, `${loc} 词典里不应再有 comment.time*`).not.toMatch(/'comment\.time/);
    }
    expect(src).not.toMatch(/comment\.time[A-Z]/);
  });
});

// ── 期 10 第十二批：404 页那个**语言中立**的大数字（站长裁定："让所有语言的人都能看懂这是 404"）──
describe("404 页的语言中立数字（不进词典，但要醒目）", () => {
  const src = readFileSync(path.join(websiteRoot, "pages/404.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("① 有一个 class 为 vanblog-notfound-code 的元素，内容就是 404", () => {
    expect(src).toMatch(/vanblog-notfound-code/);
    expect(src).toMatch(/>\s*404\s*</);
  });

  it("② 🔴 它**够醒目**（字号 ≥64px、字重 ≥700）—— " + '"醒目"必须是可量的，不是形容词', () => {
    const fontSize = src.match(/fontSize:\s*(\d+)/);
    const fontWeight = src.match(/fontWeight:\s*(\d+)/);
    expect(fontSize, "404 那个数字必须显式设定字号").toBeTruthy();
    expect(fontWeight, "404 那个数字必须显式设定字重").toBeTruthy();
    expect(Number(fontSize![1])).toBeGreaterThanOrEqual(64);
    expect(Number(fontWeight![1])).toBeGreaterThanOrEqual(700);
  });

  it("③ 🔴 它**不进词典**（语言中立；塞进词典只会让覆盖率虚高）", () => {
    // 不许出现 t("…", "404") 这类调用，也不许有 notFound.code 之类的 key
    expect(src).not.toMatch(/t\(\s*"[^"]*"\s*,\s*"404"/);
    expect(src).not.toMatch(/notFound\.code/);
    for (const loc of ["zh-TW", "en-US"]) {
      const dict = readFileSync(path.join(websiteRoot, "locales/" + loc + ".ts"), "utf8");
      expect(dict, `${loc} 词典里不该有 404 这个条目`).not.toMatch(/:\s*'404'/);
    }
  });

  it("④ 🔴 它**不加 aria-hidden**（数字对读屏同样有意义），也不加会与可见文本不一致的 aria-label", () => {
    const block = src.slice(src.indexOf("vanblog-notfound-code"), src.indexOf("vanblog-notfound-code") + 400);
    expect(block).not.toMatch(/aria-hidden/);
    expect(block).not.toMatch(/aria-label/);
  });

  it("⑤ 🔴 这一页仍然**没有**语言切换按钮（站长裁定的另一半，别只记住一半）", () => {
    expect(src).not.toMatch(/LocaleSwitcher/);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 🔴 期 12 第二批：`RunningTime`（页脚运行时长）与 `SearchCard`（查看全部结果）两族接缝
//
// 这两族各自代表一种"**看起来接了、其实没接**"的坏法：
// ① `RunningTime` 需要**英文复数**，站长裁定 `接受1days` ⇒ 不上 ICU，用整句模板 + 四个占位符；
// ② `SearchCard` 的接缝函数与词典条目**期 10 就有了**，但消费方一直在用常量（死接缝）⇒
//    英文界面下永远中文。所以这里除了哨兵反向，还**渲染一次组件**证明消费方真的接上了。
// ═══════════════════════════════════════════════════════════════════════════════
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import dayjs from "dayjs";

import {
  formatRunningTime,
  runningTimePrefix,
  RUNNING_TIME_DURATION,
  RUNNING_TIME_PREFIX,
} from "../components/RunningTime";
import {
  searchViewAllLabel,
  ViewAllResultsLink,
  SEARCH_VIEW_ALL_LABEL,
} from "../components/SearchCard";

// 🔴 `renderToStaticMarkup` 走的是经典 JSX 运行时 ⇒ 渲染期要在**全局**找 React
//    （与 `searchPageWiring.spec.ts` 同一手法）。少了这一行会报 `React is not defined`。
(globalThis as { React?: typeof React }).React = React;

describe("前台 i18n 接缝 · RunningTime（页脚运行时长）", () => {
  const SINCE = "2024-07-07T00:00:00Z";
  const NOW = dayjs("2026-10-03T05:06:07Z");
  const EN_RT: Record<string, string> = {
    "runningTime.prefix": "This site has been running for",
    "runningTime.duration": "{days} days, {hours} hours, {mins} minutes, {secs} seconds",
  };
  const enT: TFunc = (id, defaultMessage, values) => {
    const tpl = EN_RT[id] || defaultMessage;
    let out = tpl;
    for (const [k, v] of Object.entries(values || {})) out = out.split("{" + k + "}").join(String(v));
    return out;
  };

  it("① 不传 t 时与改造前**逐字节相同**（IDENTITY_T 是默认值；老站点行为不变）", () => {
    const out = formatRunningTime(SINCE, NOW);
    expect(out).toBe("818天5小时6分7秒");
    // 反证：这个字符串确实是"数字 + 单位"拼出来的（不是巧合对上一个常量）
    expect(out).toMatch(/^\d+天\d+小时\d+分\d+秒$/);
    expect(RUNNING_TIME_PREFIX).toBe("本站居然运行了");
    expect(runningTimePrefix()).toBe("本站居然运行了");
  });

  it("② 传入词典就换成英文，且**四个占位符都被真的插值**", () => {
    const out = String(formatRunningTime(SINCE, NOW, enT));
    expect(out).toBe("818 days, 5 hours, 6 minutes, 7 seconds");
    expect(out).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
    expect(runningTimePrefix(enT)).toBe("This site has been running for");
    // 🔴 站长裁定「接受 1 days」⇒ 这里如实钉住：1 天时英文**就是** `1 days`（不是漏翻）
    const oneDay = String(formatRunningTime("2026-10-02T05:06:07Z", NOW, enT));
    expect(oneDay).toContain("1 days");
  });

  it("③ 🔴 哨兵反向：两处文案都必须过 t（把 t(...) 改回硬编码中文就会红）", () => {
    const SENTINEL = "__SENTINEL_RT__";
    const sentinelT: TFunc = () => SENTINEL;
    expect(runningTimePrefix(sentinelT)).toBe(SENTINEL);
    expect(formatRunningTime(SINCE, NOW, sentinelT)).toBe(SENTINEL);
    // 反证：哨兵真的被调用了两次（前缀 + 时长各一次），不是"只有一处过 t"
    const seen: string[] = [];
    const spyT: TFunc = (id, dm) => {
      seen.push(id);
      return dm;
    };
    runningTimePrefix(spyT);
    formatRunningTime(SINCE, NOW, spyT);
    expect(seen).toEqual(["runningTime.prefix", "runningTime.duration"]);
  });

  it("④ 无效日期仍然返回 null（不许因为接了 i18n 就把 NaN 渲染出来）", () => {
    expect(formatRunningTime("", NOW, enT)).toBeNull();
    expect(formatRunningTime("不是日期", NOW, enT)).toBeNull();
    expect(RUNNING_TIME_DURATION).toContain("{days}");
  });
});

describe("前台 i18n 接缝 · SearchCard「查看全部结果」（原来是**死接缝**）", () => {
  it("① 默认（不传 t）渲染出中文整句，且 `{query}` 已被替换", () => {
    expect(searchViewAllLabel("docker")).toBe("查看全部结果（docker）");
    expect(SEARCH_VIEW_ALL_LABEL).toBe("查看全部结果（{query}）");
  });

  it("② 传入词典就换成英文整句（🔴 语序由模板决定，不是代码拼括号）", () => {
    const enT: TFunc = (id, dm, values) => {
      const tpl = id === "search.viewAllResultsFor" ? "View all results for {query}" : dm;
      let out = tpl;
      for (const [k, v] of Object.entries(values || {})) out = out.split("{" + k + "}").join(String(v));
      return out;
    };
    expect(searchViewAllLabel("docker", enT)).toBe("View all results for docker");
    // 🔴 反证：英文里**不许**出现全角括号（那正是"代码里拼括号"的老形状）
    expect(searchViewAllLabel("docker", enT)).not.toContain("（");
  });

  it("③ 🔴 **消费方真的接上了**（渲染组件，而不只是调用函数）—— 死接缝就是死在这一条上", () => {
    const html = renderToStaticMarkup(
      React.createElement(ViewAllResultsLink, { query: "docker", onClick: () => {} })
    );
    expect(html).toContain("查看全部结果（docker）");
    expect(html).not.toContain("{query}");
    // 🔴 源码级：组件里不许再出现"常量 + 代码拼括号"那个老形状
    // ⚠️ 必须传 "utf8"：不传编码 `readFileSync` 返回 **Buffer**，
    //    而 `expect(buffer).not.toContain("字符串")` 会报"参数组合非法"（那不是断言红，是尺子用错了）。
    const src = readFileSyncForSeam(
      joinForSeam(resolveForSeam(__dirname, ".."), "components/SearchCard/index.tsx"),
      "utf8"
    );
    // ⚠️ **必须先剥注释再断言 not.toContain**：那个文件里的说明注释**逐字引用了老形状**
    //    （用来解释为什么改），不剥的话这条 `not.toContain` 会被我自己的注释打红
    //    （本项目已因此踩过多次：「断言被自己的注释绊倒」）。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("${SEARCH_VIEW_ALL_LABEL}（${query}）");
    expect(code).toContain("searchViewAllLabel(query, t)");
    expect(code).toContain("const t = useT();");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🔴 期 12 第二批新增的**性质守卫**：不许拿"中文字面量"当状态判据
//
// 起因（真 bug，已用真浏览器复现）：`SearchCard` 里原来写
//     text = t("search.stateHasResults", "有结果");
//     …
//     if (text == "有结果") { return <ArticleList … /> }
// 切到英文/繁中后 `text` 是 `Has results`／`有結果` ⇒ 分支永远进不去 ⇒
// **搜到 7 条也一条都不渲染**（zh-CN 7 条 / en-US 0 条），而 `/search` 页是好的 ⇒ 看起来像"搜索坏了"。
// 👉 一般化：🔴 **`t()` 的返回值只能拿去显示，绝不能拿去比较**。
// 这条守卫钉的是**整个前台源码**（不是那一个文件），因为同一类错误可以在任何地方再犯。
// ⚠️ 加它之前先量过：全站命中 **0 处**（唯一一处"命中"是注释里的 `==高亮==`）⇒ 不是给既有代码开豁免，
//    而是**把已经修好的性质钉住**（这类守卫最值：它防的是"下次有人再写一遍"）。
// ═══════════════════════════════════════════════════════════════════════════════
import { readdirSync as readdirSyncForSeam, readFileSync as readFileSyncForSeam, statSync as statSyncForSeam } from "node:fs";
import { join as joinForSeam, relative as relativeForSeam, resolve as resolveForSeam } from "node:path";

describe("🔴 前台源码里不许出现「与中文字面量比较」（拿译文当状态判据那一类 bug）", () => {
  const websiteRoot = resolveForSeam(__dirname, "..");
  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");

  function scan(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSyncForSeam(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
      const full = joinForSeam(dir, entry);
      const st = statSyncForSeam(full);
      if (st.isDirectory()) scan(full, out);
      else if (
        /\.(ts|tsx)$/.test(entry) &&
        !/\.(spec|test)\.(ts|tsx)$/.test(entry) &&
        !full.includes("__tests__")
      )
        out.push(full);
    }
    return out;
  }

  it("① 全站扫描：`== / === / != / !== / case` 右边不许是含中文的字面量", () => {
    const files = scan(websiteRoot);
    expect(files.length).toBeGreaterThan(120); // 反空转：扫描本身必须真的扫到东西
    const bad: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSyncForSeam(f, "utf8"));
      src.split("\n").forEach((line, i) => {
        const re = /(===?|!==?)\s*("[^"]*[\u4e00-\u9fff][^"]*"|'[^']*[\u4e00-\u9fff][^']*'|`[^`]*[\u4e00-\u9fff][^`]*`)|\bcase\s+("[^"]*[\u4e00-\u9fff][^"]*"|'[^']*[\u4e00-\u9fff][^']*')/;
        if (re.test(line)) bad.push(`${relativeForSeam(websiteRoot, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(
      bad,
      "🔴 这些行在拿**中文字面量**当判据。如果左边是 t(...) 的结果，那么切语种后分支就永远进不去" +
        "（本仓库已因此出过一个真 bug：搜索弹窗在英文下搜到结果也不渲染）。" +
        "修法：判据换成**状态**（布尔/枚举/数量），中文只留在 t() 的默认值里。命中：\n" +
        bad.join("\n")
    ).toEqual([]);
  });

  it("② 🔴 尺子有效性反证：那个真 bug 的形状必须被上面这条抓到", () => {
    const buggy = 'if (text == "有结果") {';
    const fixed = "if (hasResults) {";
    const re = /(===?|!==?)\s*("[^"]*[\u4e00-\u9fff][^"]*"|'[^']*[\u4e00-\u9fff][^']*'|`[^`]*[\u4e00-\u9fff][^`]*`)|\bcase\s+("[^"]*[\u4e00-\u9fff][^"]*"|'[^']*[\u4e00-\u9fff][^']*')/;
    expect(re.test(buggy)).toBe(true); // 老形状 ⇒ 红
    expect(re.test(fixed)).toBe(false); // 新形状 ⇒ 绿
    // 且"注释里提到这个形状"不会误报（尺子剥注释）
    expect(stripComments('// if (text == "有结果") {\nconst a = 1;')).not.toContain("有结果");
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// 🔴 期 12 第二批（后半）：`KeyCard`（快捷键提示的**读屏文案**）
//
// 这一族与前面几族**方向相反**：原来是**硬编码英文**，中文用户用读屏软件听到夹生英文。
// 🔴 而尺子（`bareChinese`）只量"裸中文"⇒ **从来没报过它**。它是真浏览器探针打出来的
// （弹窗渲染文本里那句 `Press esc to close`）。👉 判据量不到的方向，只能靠看。
// ═══════════════════════════════════════════════════════════════════════════════
import KeyCard, { keyHint } from "../components/KeyCard";

describe("前台 i18n 接缝 · KeyCard（快捷键提示的读屏文案）", () => {
  const EN_KH: Record<string, string> = {
    "keyHint.press": "Press ",
    "keyHint.and": " and ",
    "keyHint.toSearch": " to search",
    "keyHint.toClose": " to close",
  };
  const enT: TFunc = (id, dm) => EN_KH[id] || dm;

  it("① 默认（不传 t）是**中文**（zh-CN 的载体就是代码里的默认值）", () => {
    expect(keyHint("press")).toBe("按下 ");
    expect(keyHint("and")).toBe(" 和 ");
    expect(keyHint("toSearch")).toBe(" 搜索");
    expect(keyHint("toClose")).toBe(" 关闭");
  });

  it("② 传入词典就换成英文（且**前后空格保留** —— 它们是围着 <kbd> 拼的片段）", () => {
    expect(keyHint("press", enT)).toBe("Press ");
    expect(keyHint("and", enT)).toBe(" and ");
    expect(keyHint("toSearch", enT)).toBe(" to search");
    expect(keyHint("toClose", enT)).toBe(" to close");
  });

  it("③ 🔴 哨兵反向：四段都必须过 t（改回硬编码就会红）", () => {
    const SENTINEL = "__SENTINEL_KH__";
    const sentinelT: TFunc = () => SENTINEL;
    for (const part of ["press", "and", "toSearch", "toClose"] as const) {
      expect(keyHint(part, sentinelT), `${part} 没有过接缝`).toBe(SENTINEL);
    }
    // 反证：哨兵确实被调了 4 次、而且 id 各不相同（不是"四段共用一个 key"）
    const seen: string[] = [];
    const spyT: TFunc = (id, dm) => {
      seen.push(id);
      return dm;
    };
    for (const part of ["press", "and", "toSearch", "toClose"] as const) keyHint(part, spyT);
    expect(seen).toEqual(["keyHint.press", "keyHint.and", "keyHint.toSearch", "keyHint.toClose"]);
  });

  it("④ 🔴 **消费方**（组件）也接上了：两种 type 的 sr-only 文本都来自接缝", () => {
    const search = renderToStaticMarkup(React.createElement(KeyCard, { type: "search" }));
    const esc = renderToStaticMarkup(React.createElement(KeyCard, { type: "esc" }));
    expect(search).toContain("按下 ");
    expect(search).toContain(" 搜索");
    expect(esc).toContain("按下 ");
    expect(esc).toContain(" 关闭");
    // 🔴 老形状（硬编码英文）不许再出现 —— 这才是"死接缝"与"真接上"的分界
    expect(search).not.toContain("Press ");
    expect(search).not.toContain(" to search");
    expect(esc).not.toContain(" to close");
    // 反证：键帽本身（可见部分）不受影响
    expect(search).toContain("<kbd");
    expect(esc).toContain("esc");
  });
});
