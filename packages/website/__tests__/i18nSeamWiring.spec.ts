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
