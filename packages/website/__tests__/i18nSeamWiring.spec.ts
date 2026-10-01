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
