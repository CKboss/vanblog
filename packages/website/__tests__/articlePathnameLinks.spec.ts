import { describe, expect, it } from "vitest";
import { getArticlePath } from "../utils/getArticlePath";
import { washArticlesByKey } from "../utils/washArticles";

const raw = [
  {
    id: 53,
    title: "QDII基金限购",
    pathname: "qdii-ji-jin-xian-gou",
    category: "博客",
    tags: ["投资"],
    createdAt: "2026-08-04T17:17:43.000Z",
    updatedAt: "2026-08-04T17:17:43.000Z",
  },
  {
    id: 7,
    title: "没有别名的老文章",
    pathname: "",
    category: "博客",
    tags: ["投资", "生活"],
    createdAt: "2024-07-07T07:24:34.000Z",
    updatedAt: "2024-07-07T07:24:34.000Z",
  },
];

describe("washArticlesByKey keeps the custom pathname", () => {
  it("category pages still link to /post/<pathname>", () => {
    const washed = washArticlesByKey(raw, (a) => a.category, false);
    const paths = washed["博客"].map((a: any) => getArticlePath(a));
    expect(paths).toEqual(["qdii-ji-jin-xian-gou", "7"]);
  });

  it("tag pages (array keys) keep it too", () => {
    const washed = washArticlesByKey(raw, (a) => a.tags, true);
    expect(getArticlePath(washed["投资"][0])).toBe("qdii-ji-jin-xian-gou");
    expect(getArticlePath(washed["生活"][0])).toBe("7");
  });

  it("keeps sorting and the fields the list renders", () => {
    const washed = washArticlesByKey(raw, (a) => a.category, false);
    const [first, second] = washed["博客"];
    expect(first.id).toBe(53); // createdAt 倒序
    expect(second.id).toBe(7);
    expect(first).toMatchObject({
      title: "QDII基金限购",
      pathname: "qdii-ji-jin-xian-gou",
    });
    expect(first.createdAt).toBe(raw[0].createdAt);
    expect(first.updatedAt).toBe(raw[0].updatedAt);
  });

  it("does not invent a pathname when the article has none", () => {
    const washed = washArticlesByKey(
      [{ id: 9, title: "x", createdAt: "2026-01-01", updatedAt: "2026-01-01", category: "c" }],
      (a) => a.category,
      false
    );
    expect(washed["c"][0].pathname).toBeUndefined();
    expect(getArticlePath(washed["c"][0])).toBe("9");
  });
});
