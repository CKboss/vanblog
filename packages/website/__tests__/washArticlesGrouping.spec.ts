import { describe, expect, it } from "vitest";
import { washArticlesByKey } from "../utils/washArticles";
import { groupTimelineByYearAndMonth, timelineTimestamp } from "../utils/timelineMonths";

/**
 * washArticlesByKey 从「每个键 filter 一遍全量（O(D×n) + 比较器里反复 new Date）」
 * 改成「单遍分桶 + 时间戳每篇解析一次」。这个 spec 钉住**输出形状与旧实现一致**：
 * 键顺序 = 首次出现顺序、组内 createdAt 倒序、只保留 5 个字段、
 * 宽松相等语义（null/undefined 同组、2024 与 "2024" 同组）。
 */
const arts = [
  { id: 1, title: "a", pathname: "aaa", createdAt: "2024-05-01T00:00:00Z", updatedAt: "u1", category: "博客", tags: ["x", "y"] },
  { id: 2, title: "b", pathname: undefined, createdAt: "2024-07-01T00:00:00Z", updatedAt: "u2", category: "生活", tags: ["y"] },
  { id: 3, title: "c", pathname: "ccc", createdAt: "2023-01-01T00:00:00Z", updatedAt: "u3", category: "博客", tags: [] },
];

describe("washArticlesByKey：单遍分桶与原实现输出一致", () => {
  it("键顺序 = 首次出现顺序，组内 createdAt 倒序，只保留 5 个字段", () => {
    const washed = washArticlesByKey(arts, (a) => a.category, false);
    expect(Object.keys(washed)).toEqual(["博客", "生活"]);
    expect(washed["博客"].map((a: any) => a.id)).toEqual([1, 3]); // 2024-05 > 2023-01
    expect(washed["生活"].map((a: any) => a.id)).toEqual([2]);
    expect(Object.keys(washed["博客"][0]).sort()).toEqual(
      ["createdAt", "id", "pathname", "title", "updatedAt"].sort(),
    );
    expect(washed["生活"][0].pathname).toBeUndefined();
  });

  it("数组键（标签）：一篇多标签进多个桶，桶内仍按时间倒序", () => {
    const washed = washArticlesByKey(arts, (a) => a.tags, true);
    expect(Object.keys(washed)).toEqual(["x", "y"]);
    expect(washed["y"].map((a: any) => a.id)).toEqual([2, 1]); // 2024-07 > 2024-05
    expect(washed["x"].map((a: any) => a.id)).toEqual([1]);
  });

  it("宽松相等语义保留：数字与同值字符串同组；null 与 undefined 同组", () => {
    const mixed = [
      { id: 1, title: "n", createdAt: "2024-01-02T00:00:00Z", year: 2024 },
      { id: 2, title: "s", createdAt: "2024-01-01T00:00:00Z", year: "2024" },
    ];
    const washed = washArticlesByKey(mixed, (a) => a.year, false);
    expect(Object.keys(washed)).toEqual(["2024"]);
    expect(washed["2024"].map((a: any) => a.id)).toEqual([1, 2]);

    const nullish = [
      { id: 1, title: "u", createdAt: "2024-01-02T00:00:00Z", cat: undefined },
      { id: 2, title: "n", createdAt: "2024-01-03T00:00:00Z", cat: null },
    ];
    const w2 = washArticlesByKey(nullish, (a) => a.cat, false);
    // 旧实现：dates 里 undefined 先出现，filter 用 ==，null 也进同一组，键是 "undefined"
    expect(Object.keys(w2)).toEqual(["undefined"]);
    expect(w2["undefined"].map((a: any) => a.id)).toEqual([2, 1]);
  });

  it("无效日期不再让比较器返回 NaN：按 0（epoch）排到最后，顺序确定", () => {
    const rows = [
      { id: 1, title: "bad", createdAt: "不是日期", category: "c" },
      { id: 2, title: "good", createdAt: "2024-01-01T00:00:00Z", category: "c" },
      { id: 3, title: "bad2", createdAt: "", category: "c" },
    ];
    const washed = washArticlesByKey(rows, (a) => a.category, false);
    // 好的在前；两个坏日期保持原有相对顺序（稳定排序，time 都是 0）
    expect(washed["c"].map((a: any) => a.id)).toEqual([2, 1, 3]);
  });

  it("空输入不炸", () => {
    expect(washArticlesByKey([], (a) => a.category, false)).toEqual({});
    expect(washArticlesByKey(undefined as any, (a) => a.category, false)).toEqual({});
  });
});

describe("timelineTimestamp：排序时间戳的 NaN 语义", () => {
  it("合法输入给毫秒数；null/undefined/空串/坏值给 0", () => {
    expect(timelineTimestamp("2024-07-07T00:00:00Z")).toBe(Date.parse("2024-07-07T00:00:00Z"));
    expect(timelineTimestamp(new Date("2024-07-07T00:00:00Z"))).toBe(
      Date.parse("2024-07-07T00:00:00Z"),
    );
    expect(timelineTimestamp(Date.parse("2024-07-07T00:00:00Z"))).toBe(
      Date.parse("2024-07-07T00:00:00Z"),
    );
    expect(timelineTimestamp(null)).toBe(0);
    expect(timelineTimestamp(undefined)).toBe(0);
    expect(timelineTimestamp("")).toBe(0);
    expect(timelineTimestamp("abc")).toBe(0);
  });
});

describe("groupTimelineByYearAndMonth：去掉第二次排序后行为不变", () => {
  it("月份桶天然保持倒序（从已排序数组按序分桶）", () => {
    const rows = {
      "2024": [
        { id: 1, title: "早", createdAt: "2024-03-01T00:00:00Z" },
        { id: 2, title: "晚", createdAt: "2024-03-20T00:00:00Z" },
        { id: 3, title: "更晚", createdAt: "2024-12-01T00:00:00Z" },
      ],
    };
    const groups = groupTimelineByYearAndMonth(rows as any);
    expect(groups).toHaveLength(1);
    expect(groups[0].months.map((m) => m.month)).toEqual([12, 3]);
    expect(groups[0].months[1].articles.map((a) => a.id)).toEqual([2, 1]);
    expect(groups[0].count).toBe(3);
  });
});
