import { describe, expect, it } from "vitest";

import {
  MAX_QUERY_CHARS,
  MAX_TERMS,
  TIER_SNIPPET,
  TIER_TAG_OR_CATEGORY,
  TIER_TITLE,
  compareRankedDocs,
  countOccurrences,
  foldCase,
  paginate,
  rankServerResults,
  searchIndexDocs,
  serverItemToIndexDoc,
  splitSearchTerms,
} from "../utils/searchRank";
import { SEARCH_MAX_RESULTS, SearchIndexDoc } from "../utils/searchIndex";

/** 造一篇索引文档（默认值都是"什么都匹配不上"的中性值） */
function doc(over: Partial<SearchIndexDoc> = {}): SearchIndexDoc {
  const id = over.id ?? 1;
  return {
    id,
    u: over.u ?? `/post/${id}`,
    t: over.t ?? "",
    s: over.s ?? "",
    c: over.c ?? "",
    g: over.g ?? [],
    d: over.d ?? "2026-01-01",
    w: over.w ?? 0,
  };
}

describe("折叠规则：locale 无关的 toLowerCase()", () => {
  it("拉丁字母大小写折叠，且**不受运行环境 locale 影响**", () => {
    expect(foldCase("Docker")).toBe("docker");
    expect(foldCase("DOCKER")).toBe("docker");
    expect(foldCase("docker")).toBe("docker");
    // 负控：这一条正是"为什么不用 toLocaleLowerCase"的证据 ——
    // 土耳其语 locale 下 'I'.toLocaleLowerCase() 是 'ı'（U+0131，无点 i），
    // 而我们用的是 locale 无关的 toLowerCase()，永远是 'i'。
    expect("I".toLowerCase()).toBe("i");
    expect("I".toLocaleLowerCase("tr")).toBe("ı");
    expect(foldCase("I")).not.toBe("I".toLocaleLowerCase("tr"));
    expect(foldCase("TITLE")).toBe("title"); // 与 toLocaleLowerCase('tr') 的结果不同
  });

  it("非字符串与空值一律当空串（公开接口给什么都不能抛）", () => {
    expect(foldCase(undefined)).toBe("");
    expect(foldCase(null)).toBe("");
    expect(foldCase(42)).toBe("");
    expect(foldCase({})).toBe("");
    expect(foldCase("")).toBe("");
  });

  it("CJK 不受折叠影响（中文没有大小写）", () => {
    expect(foldCase("整站备份")).toBe("整站备份");
  });
});

describe("查询切词：按空白切、AND 语义、有上限", () => {
  it("按空白切成词，折叠并去重", () => {
    expect(splitSearchTerms("Docker 备份")).toEqual(["docker", "备份"]);
    expect(splitSearchTerms("  备份   备份  ")).toEqual(["备份"]);
    expect(splitSearchTerms("a\tb\nc")).toEqual(["a", "b", "c"]);
  });

  it("空 / 全空白 / 非字符串 → 空数组（页面据此显示「请输入关键词」）", () => {
    expect(splitSearchTerms("")).toEqual([]);
    expect(splitSearchTerms("   ")).toEqual([]);
    expect(splitSearchTerms(undefined)).toEqual([]);
    expect(splitSearchTerms(42)).toEqual([]);
  });

  it("词数与长度有上限：粘贴一整段不会变成一次几万个词的搜索", () => {
    const many = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    expect(splitSearchTerms(many)).toHaveLength(MAX_TERMS);
    const long = "x".repeat(5000);
    const terms = splitSearchTerms(long);
    expect(terms).toHaveLength(1);
    expect(terms[0].length).toBeLessThanOrEqual(64);
    expect(splitSearchTerms("y".repeat(MAX_QUERY_CHARS + 500))[0].length).toBeLessThanOrEqual(64);
  });

  it("正则元字符原样保留（不构造正则，所以不需要转义，也不会抛）", () => {
    expect(splitSearchTerms("(a+)+b")).toEqual(["(a+)+b"]);
    expect(splitSearchTerms(".*+?^${}()|[]\\")).toEqual([".*+?^${}()|[]\\"]);
  });

  it("countOccurrences 是不重叠计数，且对空串安全", () => {
    expect(countOccurrences("aaa", "a")).toBe(3);
    expect(countOccurrences("aaa", "aa")).toBe(1); // 不重叠
    expect(countOccurrences("备份备份", "备份")).toBe(2);
    expect(countOccurrences("", "a")).toBe(0);
    expect(countOccurrences("abc", "")).toBe(0);
  });
});

describe("排序：标题 > 标签/分类 > 摘要，档位内按命中次数，再按新近度", () => {
  const docs = [
    doc({ id: 1, t: "只是正文里提到那个词", s: "docker 出现在正文摘要", d: "2026-01-01" }),
    doc({ id: 2, t: "Docker 部署指南", s: "", d: "2025-01-01" }),
    doc({ id: 3, t: "无关标题", g: ["docker"], d: "2026-06-01" }),
    doc({ id: 4, t: "无关标题", c: "docker", d: "2026-06-01" }),
    doc({ id: 5, t: "docker docker docker", s: "", d: "2020-01-01" }),
  ];

  it("三档的相对顺序与需求写的一致", () => {
    const outcome = searchIndexDocs(docs, "docker");
    const ids = outcome.results.map((r) => r.doc.id);
    // 档位 1（标题命中）：2 与 5；档位 2（标签/分类）：3、4；档位 3（摘要）：1
    expect(ids.slice(0, 2).sort()).toEqual([2, 5]);
    expect(ids.slice(2, 4).sort()).toEqual([3, 4]);
    expect(ids[4]).toBe(1);
    expect(outcome.results.map((r) => r.tier)).toEqual([
      TIER_TITLE,
      TIER_TITLE,
      TIER_TAG_OR_CATEGORY,
      TIER_TAG_OR_CATEGORY,
      TIER_SNIPPET,
    ]);
  });

  it("同一档位内命中次数多的在前（即使它更旧）", () => {
    const outcome = searchIndexDocs(docs, "docker");
    const tierOne = outcome.results.filter((r) => r.tier === TIER_TITLE);
    // id=5 的标题里有 3 次 docker，id=2 只有 1 次；5 是 2020 年的，仍然排在 2025 年的前面
    expect(tierOne.map((r) => r.doc.id)).toEqual([5, 2]);
    expect(tierOne.map((r) => r.hits)).toEqual([3, 1]);
  });

  it("同档位同命中数时按日期新→旧，同日期按 id 大→小（确定性，翻页不会重复/漏项）", () => {
    const same = [
      doc({ id: 1, t: "docker a", d: "2026-01-01" }),
      doc({ id: 2, t: "docker b", d: "2026-01-01" }),
      doc({ id: 3, t: "docker c", d: "2026-05-01" }),
    ];
    const outcome = searchIndexDocs(same, "docker");
    expect(outcome.results.map((r) => r.doc.id)).toEqual([3, 2, 1]);
    // 负控：把输入顺序打乱，结果不变（说明排序不依赖输入顺序）
    const shuffled = searchIndexDocs([same[2], same[0], same[1]], "docker");
    expect(shuffled.results.map((r) => r.doc.id)).toEqual([3, 2, 1]);
    expect(compareRankedDocs({ doc: same[0], tier: 1, hits: 1 }, { doc: same[0], tier: 1, hits: 1 })).toBe(0);
  });

  it("多个词是 AND：有一个词哪儿都不出现，这篇就出局", () => {
    const andDocs = [
      doc({ id: 1, t: "docker 与备份", s: "" }),
      doc({ id: 2, t: "docker 部署", s: "这里也讲了备份" }),
      doc({ id: 3, t: "只讲备份", s: "" }),
    ];
    const both = searchIndexDocs(andDocs, "docker 备份");
    expect(both.results.map((r) => r.doc.id).sort()).toEqual([1, 2]);
    expect(searchIndexDocs(andDocs, "docker").results.map((r) => r.doc.id).sort()).toEqual([1, 2]);
    expect(searchIndexDocs(andDocs, "备份").results.map((r) => r.doc.id).sort()).toEqual([1, 2, 3]);
    expect(searchIndexDocs(andDocs, "不存在的词").results).toEqual([]);
  });

  it("一篇的档位取它所有命中词里最好的那一档", () => {
    const mixed = [doc({ id: 1, t: "docker 指南", s: "还讲了备份" })];
    const outcome = searchIndexDocs(mixed, "docker 备份");
    expect(outcome.results[0].tier).toBe(TIER_TITLE);
    expect(outcome.results[0].hits).toBe(2);
  });

  it("标签之间不会因为拼接产生跨标签的假命中", () => {
    const tagged = [doc({ id: 1, t: "标题", g: ["ab", "cd"] })];
    expect(searchIndexDocs(tagged, "bc").results).toEqual([]);
    expect(searchIndexDocs(tagged, "ab").results.map((r) => r.doc.id)).toEqual([1]);
  });

  it("没有查询词 / 空索引时给出空结果而不是抛错", () => {
    expect(searchIndexDocs(docs, "").results).toEqual([]);
    expect(searchIndexDocs([], "docker").results).toEqual([]);
    expect(searchIndexDocs(undefined as any, "docker").results).toEqual([]);
    expect(searchIndexDocs(docs, "docker").backend).toBe("index");
  });

  it("CJK 子串匹配不需要分词（这是极简的、刻意的选择）", () => {
    const cjk = [
      doc({ id: 1, t: "整站备份与恢复演练", s: "" }),
      doc({ id: 2, t: "备份失败了怎么办", s: "" }),
      doc({ id: 3, t: "完全无关的文章", s: "结尾提了一句恢复" }),
    ];
    expect(searchIndexDocs(cjk, "备份").results.map((r) => r.doc.id).sort()).toEqual([1, 2]);
    expect(searchIndexDocs(cjk, "恢复").results.map((r) => r.doc.id).sort()).toEqual([1, 3]);
    expect(searchIndexDocs(cjk, "整站").results.map((r) => r.doc.id)).toEqual([1]);
  });

  it("单字查询（中文最常见的「的」）被截在上限内，并如实报告 capped", () => {
    const many = Array.from({ length: SEARCH_MAX_RESULTS + 500 }, (_, i) =>
      doc({ id: i + 1, t: `第 ${i} 篇的标题`, d: `2026-01-01` }),
    );
    const outcome = searchIndexDocs(many, "的");
    expect(outcome.matched).toBe(SEARCH_MAX_RESULTS + 500);
    expect(outcome.results).toHaveLength(SEARCH_MAX_RESULTS);
    expect(outcome.capped).toBe(true);
    // 截断保留的是**排序后**的前 N 条，不是随便前 N 条
    expect(outcome.results[0].tier).toBe(TIER_TITLE);
  });

  it("没有超过上限时 capped=false", () => {
    const outcome = searchIndexDocs([doc({ id: 1, t: "docker" })], "docker");
    expect(outcome.capped).toBe(false);
    expect(outcome.matched).toBe(1);
  });

  it("性能：2000 篇 × 200 字摘要，单词查询在几十毫秒内（这是每次按键都要跑的）", () => {
    const corpus: SearchIndexDoc[] = Array.from({ length: 2000 }, (_, i) => doc({
      id: i + 1,
      t: `文章标题 ${i} 关于 docker 与备份`,
      s: "这是一段两百字左右的中文摘要，".repeat(14) + `docker${i}`,
      g: [`tag${i % 50}`, "备份"],
      c: `分类${i % 7}`,
      d: `2026-0${(i % 9) + 1}-01`,
    }));
    const started = Date.now();
    const outcome = searchIndexDocs(corpus, "docker1999");
    const cost = Date.now() - started;
    expect(outcome.matched).toBeGreaterThan(0);
    // 阈值故意宽松（CI 机器慢），但它必须远远小于"一次服务端全表 $regex 扫描 + 网络往返"
    expect(cost, `2000 篇搜索耗时 ${cost}ms`).toBeLessThan(500);
  });
});

describe("降级路径：服务端结果也走同一套排序", () => {
  const items = [
    { id: 1, title: "只是正文里提到那个词", category: "随笔", tags: [], createdAt: "2026-01-01T00:00:00Z" },
    { id: 2, title: "Docker 部署指南", category: "随笔", tags: ["docker"], createdAt: "2025-01-01T00:00:00Z" },
    { id: 3, title: "无关标题", category: "docker", tags: [], createdAt: "2026-06-01T00:00:00Z" },
  ];

  it("toSearchResult 的形状被映射成索引文档形状（没有 pathname 就回落数字 id）", () => {
    const mapped = serverItemToIndexDoc(items[1] as any, 0);
    expect(mapped).toEqual({
      id: 2,
      u: "/post/2",
      t: "Docker 部署指南",
      s: "",
      c: "随笔",
      g: ["docker"],
      d: "2025-01-01",
      w: 0,
    });
  });

  it("排序档位与索引路径一致；命中在正文里的落到最低档但仍保留", () => {
    const outcome = rankServerResults(items as any, "docker");
    expect(outcome.backend).toBe("server");
    expect(outcome.results.map((r) => r.doc.id)).toEqual([2, 3, 1]);
    expect(outcome.results.map((r) => r.tier)).toEqual([
      TIER_TITLE,
      TIER_TAG_OR_CATEGORY,
      TIER_SNIPPET,
    ]);
    // id=1 的标题里没有 docker，但服务端确实在正文里匹配到了它 —— 不能丢
    expect(outcome.results[2].hits).toBe(0);
  });

  it("脏输入不抛：非数组、缺字段、日期是垃圾", () => {
    expect(rankServerResults(undefined as any, "x").results).toEqual([]);
    const junk = rankServerResults(
      [{ id: "abc" }, null, { title: 42, tags: "nope", createdAt: "不是日期" }] as any,
      "x",
    );
    expect(junk.results).toHaveLength(3);
    expect(junk.results.every((r) => typeof r.doc.u === "string")).toBe(true);
  });

  it("没有查询词时原样返回（顺序按新近度），不抛", () => {
    const outcome = rankServerResults(items as any, "");
    expect(outcome.results).toHaveLength(3);
    expect(outcome.terms).toEqual([]);
  });
});

describe("分页：纯客户端切片，页码越界夹回", () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1);

  it("每页 20 条，共 3 页", () => {
    expect(paginate(items, 1)).toMatchObject({ page: 1, totalPages: 3, total: 45, perPage: 20 });
    expect(paginate(items, 1).items).toHaveLength(20);
    expect(paginate(items, 3).items).toEqual([41, 42, 43, 44, 45]);
  });

  it("越界页码夹回最后一页并标 clamped（手改 URL 到 p=99 不该看到空白页）", () => {
    const over = paginate(items, 99);
    expect(over.page).toBe(3);
    expect(over.clamped).toBe(true);
    expect(over.items).toHaveLength(5);
    expect(paginate(items, 0).page).toBe(1);
    expect(paginate(items, -3).page).toBe(1);
    expect(paginate(items, Number.NaN).page).toBe(1);
    expect(paginate(items, 2).clamped).toBe(false);
  });

  it("空列表也有 1 页（totalPages 不会是 0，分页 UI 因此不用特判）", () => {
    const empty = paginate([], 1);
    expect(empty).toMatchObject({ page: 1, totalPages: 1, total: 0, items: [] });
    expect(paginate(undefined as any, 1).totalPages).toBe(1);
  });

  it("perPage 的垃圾值回落默认 20", () => {
    expect(paginate(items, 1, 0).perPage).toBe(20);
    expect(paginate(items, 1, -5).perPage).toBe(20);
    expect(paginate(items, 1, Number.NaN).perPage).toBe(20);
    expect(paginate(items, 1, 5).perPage).toBe(5);
    expect(paginate(items, 2, 5).items).toEqual([6, 7, 8, 9, 10]);
  });
});
