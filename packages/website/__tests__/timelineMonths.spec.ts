import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import TimelineArchives from "../components/TimelineArchives";
import {
  describeTimelineArchives,
  formatTimelineMonthLabel,
  groupTimelineByYearAndMonth,
  parseTimelineDate,
  timelineMonthKey,
} from "../utils/timelineMonths";

vi.mock("next/link", () => ({
  default: (props: { href: string; children?: React.ReactNode }) =>
    createElement("a", { href: props.href }, props.children),
}));

(globalThis as { React?: typeof React }).React = React;

const websiteRoot = path.join(__dirname, "..");
const readSrc = (rel: string) =>
  readFileSync(path.join(websiteRoot, rel), "utf8");

const articleOf = (
  id: number,
  title: string,
  year: number,
  month: number,
  day = 15
) => ({
  id,
  title,
  createdAt: new Date(year, month - 1, day, 12, 0, 0),
});

const multiMonthArticles = {
  "2024": [
    articleOf(4, "十二月下旬", 2024, 12, 20),
    articleOf(3, "十二月上旬", 2024, 12, 3),
    articleOf(2, "三月", 2024, 3, 15),
  ],
  "2023": [articleOf(1, "八月", 2023, 8, 15)],
};

describe("parseTimelineDate / month labels", () => {
  it("reads year and 1-based month from ISO dates", () => {
    expect(parseTimelineDate(new Date(2024, 11, 20, 12))).toMatchObject({
      year: 2024,
      month: 12,
    });
    expect(parseTimelineDate(new Date(2024, 2, 15, 12))).toMatchObject({
      year: 2024,
      month: 3,
    });
    expect(formatTimelineMonthLabel(12)).toBe("12月");
    expect(formatTimelineMonthLabel(3)).toBe("3月");
    expect(timelineMonthKey(2024, 3)).toBe("2024-03");
  });

  it("rejects empty or invalid dates instead of inventing a month", () => {
    expect(parseTimelineDate("")).toBeNull();
    expect(parseTimelineDate(null)).toBeNull();
    expect(parseTimelineDate(undefined)).toBeNull();
    expect(parseTimelineDate("not-a-date")).toBeNull();
  });
});

describe("groupTimelineByYearAndMonth (#302)", () => {
  it("groups articles by year and month when they span multiple months", () => {
    const groups = groupTimelineByYearAndMonth(multiMonthArticles);
    expect(groups.map((year) => year.year)).toEqual([2024, 2023]);
    expect(groups[0].months.map((month) => month.month)).toEqual([12, 3]);
    expect(groups[0].months.map((month) => month.label)).toEqual([
      "12月",
      "3月",
    ]);
    expect(groups[0].months[0].articles.map((item) => item.title)).toEqual([
      "十二月下旬",
      "十二月上旬",
    ]);
    expect(groups[0].months[1].articles.map((item) => item.title)).toEqual([
      "三月",
    ]);
    expect(groups[1].months).toHaveLength(1);
    expect(groups[1].months[0]).toMatchObject({
      month: 8,
      label: "8月",
      key: "2023-08",
    });
  });

  it("does not invent phantom month groups for empty months", () => {
    const groups = groupTimelineByYearAndMonth(multiMonthArticles);
    const months2024 = groups[0].months.map((month) => month.month);
    expect(months2024).toEqual([12, 3]);
    expect(months2024).not.toContain(1);
    expect(months2024).not.toContain(2);
    expect(months2024).not.toContain(4);
    expect(months2024).not.toContain(11);
    expect(
      groups.flatMap((year) => year.months).every((month) => month.articles.length > 0)
    ).toBe(true);
  });

  it("keeps a year-only fallback when dates are missing instead of NaN months", () => {
    const groups = groupTimelineByYearAndMonth({
      "2022": [{ id: 9, title: "无日期", createdAt: "" } as any],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].year).toBe(2022);
    expect(groups[0].months).toEqual([]);
    expect(groups[0].articles.map((item) => item.title)).toEqual(["无日期"]);
  });

  it("returns no groups for empty or ungrouped input", () => {
    expect(groupTimelineByYearAndMonth({})).toEqual([]);
    expect(groupTimelineByYearAndMonth(undefined)).toEqual([]);
    expect(groupTimelineByYearAndMonth(null)).toEqual([]);
  });
});

describe("TimelineArchives markup (#302)", () => {
  it("renders month sections when articles span multiple months", () => {
    const yearGroups = groupTimelineByYearAndMonth(multiMonthArticles) as any;
    const html = renderToStaticMarkup(
      createElement(TimelineArchives, {
        yearGroups,
        openArticleLinksInNewWindow: false,
      })
    );
    expect(html).toContain('data-timeline-year="2024"');
    expect(html).toContain('data-timeline-year="2023"');
    expect(html).toContain('data-timeline-month="2024-12"');
    expect(html).toContain('data-timeline-month="2024-03"');
    expect(html).toContain('data-timeline-month="2023-08"');
    expect(html).toContain("12月");
    expect(html).toContain("3月");
    expect(html).toContain("8月");
    expect(html).toContain("十二月下旬");
    expect(html).toContain("三月");
    expect(html).toContain("八月");
    expect(html).not.toContain('data-timeline-month="2024-01"');
    expect(html).not.toContain('data-timeline-month="2024-02"');
    expect(html).not.toContain('data-timeline-month="2024-11"');
    expect(html).not.toContain(">1月<");
    expect(html).not.toContain(">2月<");
    expect(html).not.toContain(">11月<");
  });

  it("does not invent month sections for empty input", () => {
    const html = renderToStaticMarkup(
      createElement(TimelineArchives, {
        yearGroups: [],
        openArticleLinksInNewWindow: false,
      })
    );
    expect(html).toBe("");
  });
});

describe("describeTimelineArchives outline used by the page", () => {
  it("exposes month sections and titles for multi-month years", () => {
    const outline = describeTimelineArchives(multiMonthArticles);
    expect(outline.years[0]).toMatchObject({
      year: 2024,
      label: "2024",
      count: 3,
      fallbackYearOnly: false,
    });
    expect(outline.years[0].months).toEqual([
      {
        month: 12,
        label: "12月",
        key: "2024-12",
        count: 2,
        titles: ["十二月下旬", "十二月上旬"],
      },
      {
        month: 3,
        label: "3月",
        key: "2024-03",
        count: 1,
        titles: ["三月"],
      },
    ]);
    expect(outline.years[1].months.map((month) => month.key)).toEqual([
      "2023-08",
    ]);
    const allMonthKeys = outline.years.flatMap((year) =>
      year.months.map((month) => month.key)
    );
    expect(allMonthKeys).not.toContain("2024-01");
    expect(allMonthKeys).not.toContain("2024-02");
    expect(allMonthKeys).not.toContain("2023-01");
  });
});

describe("timeline page wires year and month sections", () => {
  const page = readSrc("pages/timeline.tsx");
  const archives = readSrc("components/TimelineArchives/index.tsx");
  const pageProps = readSrc("utils/getPageProps.ts");
  const category = readSrc("pages/category.tsx");
  const tag = readSrc("pages/tag/[tag].tsx");

  it("builds yearGroups in page props and renders TimelineArchives", () => {
    expect(pageProps).toMatch(/groupTimelineByYearAndMonth\(sortedArticles\)/);
    expect(pageProps).toMatch(/yearGroups/);
    expect(page).toMatch(/TimelineArchives/);
    expect(page).toMatch(/yearGroups=\{props\.yearGroups\}/);
    expect(page).not.toMatch(/timeline-dateitem-/);
  });

  it("renders month sections from yearGroups and skips empty months", () => {
    expect(archives).toMatch(/data-timeline-year/);
    expect(archives).toMatch(/data-timeline-month=\{monthGroup\.key\}/);
    expect(archives).toMatch(/yearGroup\.months\.map/);
    expect(archives).toMatch(/monthGroup\.label/);
    expect(archives).toMatch(/compact=\{true\}/);
    expect(archives).toMatch(/yearGroup\.months\.length === 0/);
  });

  it("does not change category or tag year-only grouping", () => {
    expect(category).not.toMatch(/groupTimelineByYearAndMonth/);
    expect(category).not.toMatch(/TimelineArchives/);
    expect(tag).not.toMatch(/groupTimelineByYearAndMonth/);
    expect(tag).not.toMatch(/TimelineArchives/);
    expect(category).toMatch(/CategoryList/);
    expect(category).toMatch(/sortedArticles=\{props\.sortedArticles\}/);
    expect(tag).toMatch(/Object\.keys\(props\.sortedArticles\)/);
  });
});

describe("时间线不再往 pageProps 里塞重复数据", () => {
  // 实测：/timeline 的 __NEXT_DATA__ 从 73.8KB 降到 30.5KB（-59%），
  // HTML 从 156,653B 降到 114,160B。省下来的是"同一批文章的两份拷贝"：
  // 年份组里既带 months（按月分好的文章）又带 articles（整年的文章），
  // 而组件只在 months 为空时才读 articles。
  const dated = {
    "2026": [
      { id: 1, title: "a", createdAt: "2026-03-05T00:00:00.000Z" },
      { id: 2, title: "b", createdAt: "2026-03-06T00:00:00.000Z" },
      { id: 3, title: "c", createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  };

  it("有月份分组时 articles 为空，count 仍然准确", () => {
    const groups = groupTimelineByYearAndMonth(dated as any);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].articles).toEqual([]);
    expect(groups[0].months.map((m) => m.month)).toEqual([3, 1]);
    expect(groups[0].months[0].articles.map((a: any) => a.id)).toEqual([2, 1]);
  });

  it("整年都解析不出日期时，兜底分支仍然带上 articles（组件这时才读它）", () => {
    const undated = {
      "2021": [
        { id: 9, title: "x", createdAt: "不是日期" },
        { id: 8, title: "y" },
      ],
    };
    const groups = groupTimelineByYearAndMonth(undated as any);
    expect(groups).toHaveLength(1);
    expect(groups[0].months).toEqual([]);
    expect(groups[0].count).toBe(2);
    expect(groups[0].articles.map((a: any) => a.id)).toEqual([9, 8]);
  });

  it("describeTimelineArchives 的计数来自 count，不再依赖 articles.length", () => {
    const outline = describeTimelineArchives(dated as any);
    expect(outline.years[0].count).toBe(3);
  });

  it("组件显示的是 count（articles 已经是空数组了）", () => {
    const html = renderToStaticMarkup(
      createElement(TimelineArchives, {
        yearGroups: groupTimelineByYearAndMonth(dated as any),
        openArticleLinksInNewWindow: false,
      } as any)
    );
    expect(html).toContain("3篇");
  });

  it("timeline 页的 props 里没有 sortedArticles，取数函数也不再返回它", () => {
    const page = readSrc("pages/timeline.tsx");
    const props = readSrc("utils/getPageProps.ts");
    expect(page).not.toMatch(/^\s*sortedArticles: Record<string, Article\[\]>;/m);
    // 取数函数内部仍然要用它来分组，但不能再放进返回值
    const fn = props.slice(
      props.indexOf("export async function getTimeLinePageProps"),
      props.indexOf("export async function getTagPageProps")
    );
    expect(fn).toContain("groupTimelineByYearAndMonth(sortedArticles)");
    // ⚠️ 断言前剥注释：return 块上方那句解释"为什么不再返回 sortedArticles"的注释
    //    本身就含这个词，不剥掉的话 not.toContain 会被自己的注释满足（本仓库第 9 次踩）。
    const noComments = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n");
    expect(noComments(fn.slice(fn.indexOf("return {")))).not.toContain(
      "sortedArticles"
    );
  });

  it("分类页与标签页的 sortedArticles 不受影响（它们真的在用）", () => {
    const category = readSrc("pages/category/[category].tsx");
    const tag = readSrc("pages/tag/[tag].tsx");
    expect(category).toMatch(/sortedArticles/);
    expect(tag).toMatch(/sortedArticles/);
  });
});
