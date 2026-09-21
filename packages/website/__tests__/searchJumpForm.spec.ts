import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import SearchResults, { SearchResultsProps } from "../components/SearchResults";
import {
  SEARCH_JUMP_FORM_ATTR,
  SEARCH_JUMP_INPUT_ATTR,
  SEARCH_JUMP_INPUT_ID,
  SEARCH_JUMP_PAGE_PARAM,
  SEARCH_JUMP_QUERY_PARAM,
  SearchJumpResult,
  describeSearchJumpForm,
  handleSearchJumpSubmit,
  readSearchJumpTarget,
  resolveSearchJump,
  submitSearchJump,
} from "../components/SearchResults/jumpForm";
import { PAGE_NAV_ITEM_ATTR } from "../components/PageNav/a11y";
import { pageHref as pageNavHref } from "../components/PageNav/core";
import {
  PAGE_NAV_JUMP_GO_LABEL,
  PAGE_NAV_JUMP_INPUT_LABEL,
  PAGE_NAV_JUMP_LABEL,
  PAGE_NAV_JUMP_PREFIX,
  PAGE_NAV_JUMP_UNIT,
  PageNavJumpResult,
  resolvePageNavJump,
} from "../components/PageNav/jump";
import { MAX_QUERY_CHARS } from "../utils/searchRank";
import type { RankedDoc } from "../utils/searchRank";
import { displayQuery } from "../utils/searchHighlight";
import {
  readSearchQueryParams,
  searchPageUrl,
} from "../utils/searchUrls";

(globalThis as { React?: typeof React }).React = React;

const websiteRoot = path.join(__dirname, "..");
const readRaw = (rel: string) => readFileSync(path.join(websiteRoot, rel), "utf8");
/**
 * 剥掉注释再扫：本文件有几条"不许出现 X"的断言，而 `jumpForm.ts` 与 `index.tsx` 的
 * **注释里**正好解释了那些形状（例如为什么参数名不是 page、为什么不复用 PageNavJump）。
 * 不剥注释就会被自己的说明文字绊倒 —— 这是本仓库反复踩过的坑。
 */
const readSrc = (rel: string) =>
  readRaw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** 与 searchHighlight.spec.ts 里同一份形状（照着真实 RankedDoc 造，不照想象造） */
const docOf = (id: number) => ({
  id,
  u: `/post/${id}`,
  t: `标题 ${id}`,
  s: `摘要 ${id}`,
  c: "分类",
  g: ["标签"],
  d: "2026-01-02",
  w: 100,
});

const hitsOf = (count: number): RankedDoc[] =>
  Array.from({ length: count }, (_, index) => ({
    doc: docOf(index + 1),
    tier: 1 as RankedDoc["tier"],
    hits: 1,
  }));

/**
 * ⚠️ 造桩的口径：`query` 传**展示形**（与 pages/search.tsx 一致，它传的是
 * `displayQuery(state.query || q)`），而 `pageHref` 用**真实**查询词构造。
 * 这两者不同正是本轮要防的那个坑，所以桩必须把它们分开，否则测不出区别。
 */
const propsOf = (
  query: string,
  results: RankedDoc[],
  extra?: Partial<SearchResultsProps>
): SearchResultsProps =>
  ({
    query: displayQuery(query),
    page: 1,
    results,
    matched: results.length,
    capped: false,
    backend: "index",
    notice: "",
    indexNotices: [],
    loading: false,
    failed: false,
    idle: false,
    openInNewWindow: false,
    pageHref: (next: number) => searchPageUrl(query, next),
    ...extra,
  } as SearchResultsProps);

const renderResults = (props: SearchResultsProps) =>
  renderToStaticMarkup(React.createElement(SearchResults, props));

/** 从渲染出的 HTML 里取出隐藏 q 的值（精确取值，不用 toContain —— 截断形是完整形的前缀） */
const hiddenQueryOf = (html: string): string | null => {
  const match = html.match(/<input[^>]*type="hidden"[^>]*>/);
  if (!match) {
    return null;
  }
  const value = match[0].match(/value="([^"]*)"/);
  return value ? value[1] : null;
};

/** 表单原生提交会得到的查询串（按 HTML 规范：GET 提交用字段重建整个查询串） */
const submittedSearchOf = (model: ReturnType<typeof describeSearchJumpForm>, page: number) => {
  const params: string[] = [];
  if (model.target.query !== null) {
    params.push(`${SEARCH_JUMP_QUERY_PARAM}=${encodeURIComponent(model.target.query)}`);
  }
  params.push(`${SEARCH_JUMP_PAGE_PARAM}=${page}`);
  return `${model.form.action}?${params.join("&")}`;
};

const TOTAL_PAGES_3 = 45; // perPage 默认 20 ⇒ 3 页

describe("搜索结果页的跳转控件：渲染出来的是一个完整可用的原生 GET 表单", () => {
  it("替身自检：桩真的驱动了渲染（否则下面所有断言都是空转）", () => {
    const html = renderResults(propsOf("关键词", hitsOf(TOTAL_PAGES_3)));
    // 结果列表真的渲染了
    expect(html).toContain("/post/1");
    expect(html).toContain("标题 1");
    // 状态行真的算出了 3 页（证明 perPage 与总数的关系如预期）
    expect(html).toContain("共 3 页");
    // 分页那一行真的在
    expect(html).toContain("搜索结果分页");
  });

  it("有 method=get、有 action、页码 input 有 name —— 不是一个只有 onClick 的壳", () => {
    const html = renderResults(propsOf("关键词", hitsOf(TOTAL_PAGES_3)));
    expect(html).toContain(SEARCH_JUMP_FORM_ATTR);
    expect(html).toMatch(/<form[^>]*method="get"/);
    expect(html).toMatch(/<form[^>]*action="\/search"/);
    // 🔴 页码字段必须有 name，否则原生提交不会带上它（浏览器只会提交有 name 的字段）
    expect(html).toMatch(new RegExp(`<input[^>]*name="${SEARCH_JUMP_PAGE_PARAM}"`));
    expect(html).toContain(`type="number"`);
    expect(html).toContain(`min="1"`);
    expect(html).toContain(`max="3"`);
    expect(html).toContain(`type="submit"`);
  });

  it("页码参数名是 p —— 并且 readSearchQueryParams 能把它读回来（端到端闭环）", () => {
    // 🔴 这条是"看着能跳、其实没跳"的守门人：参数名写错（例如写成 page）时，
    // 表单仍然会渲染、点击仍然会导航，但页面读不到页码、永远回落第 1 页。
    const model = describeSearchJumpForm({
      pageHref: (next) => searchPageUrl("关键词", next),
      total: TOTAL_PAGES_3,
      perPage: 20,
      totalPages: 3,
    });
    expect(SEARCH_JUMP_PAGE_PARAM).toBe("p");
    const url = submittedSearchOf(model, 3);
    const query = url.slice(url.indexOf("?") + 1);
    const parsed = readSearchQueryParams(
      Object.fromEntries(new URLSearchParams(query)) as Record<string, string>
    );
    expect(parsed).toEqual({ q: "关键词", page: 3 });
  });

  it("隐藏 q 带的是真实查询词；空查询时不渲染隐藏字段（与 searchPageUrl 同口径）", () => {
    const withQuery = renderResults(propsOf("关键词", hitsOf(TOTAL_PAGES_3)));
    expect(hiddenQueryOf(withQuery)).toBe("关键词");

    const empty = renderResults(propsOf("", hitsOf(TOTAL_PAGES_3)));
    expect(hiddenQueryOf(empty)).toBe(null);
    // 正对照：这一页确实渲染了表单（否则"没有隐藏字段"可能只是"整个表单都没渲染"）
    expect(empty).toMatch(/<form[^>]*method="get"/);
  });

  it("🔴 超过 MAX_QUERY_CHARS 的长查询：隐藏 q 是完整的真实查询词，不是 displayQuery 的截断形", () => {
    const long = `长${"询".repeat(MAX_QUERY_CHARS + 50)}`;
    // 自检：这两个值确实不同，否则本用例是空的（测不出"用错了哪一个"）
    expect(long.length).toBeGreaterThan(MAX_QUERY_CHARS);
    expect(displayQuery(long)).not.toBe(long);
    expect(displayQuery(long).length).toBe(MAX_QUERY_CHARS);

    const html = renderResults(propsOf(long, hitsOf(TOTAL_PAGES_3)));
    expect(hiddenQueryOf(html)).toBe(long);
    // 传给组件的展示形确实是被截断的那个（证明桩复现了真实分歧）
    expect(html).not.toContain(`value="${displayQuery(long)}"`);
  });

  it("input 有可访问的名字（label 关联 + aria-label），并且不是 PageNav 的箭头翻页目标", () => {
    const html = renderResults(propsOf("关键词", hitsOf(TOTAL_PAGES_3)));
    expect(html).toContain(`id="${SEARCH_JUMP_INPUT_ID}"`);
    expect(html).toMatch(
      new RegExp(`<label[^>]*for="${SEARCH_JUMP_INPUT_ID}"[^>]*>${PAGE_NAV_JUMP_PREFIX}`)
    );
    expect(html).toContain(`aria-label="${PAGE_NAV_JUMP_INPUT_LABEL}"`);
    expect(html).toContain(`aria-label="${PAGE_NAV_JUMP_LABEL}"`);
    expect(html).toContain(`aria-label="${PAGE_NAV_JUMP_GO_LABEL}"`);
    expect(html).toContain(PAGE_NAV_JUMP_UNIT);
    expect(html).toContain(SEARCH_JUMP_INPUT_ATTR);
    expect(html).toContain("inputMode");
    // 🔴 不能带 PageNav 那个 data 属性：否则 #542 的方向键翻页会把这个输入框当成翻页目标，
    // 用户在里面按左右箭头移光标就会翻页。
    expect(html).not.toContain(PAGE_NAV_ITEM_ATTR);
  });

  it("上一页/下一页链接没有被跳转控件替换掉（三者共存）", () => {
    const html = renderResults(
      propsOf("关键词", hitsOf(TOTAL_PAGES_3), { page: 2 })
    );
    expect(html).toContain("上一页");
    expect(html).toContain("下一页");
    expect(html).toMatch(/<form[^>]*method="get"/);
    // 中间那个「当前页 / 总页数」的文本也还在
    expect(html).toContain("2 / 3");
  });

  it("单页时整个分页行不渲染，跳转判定也为 false（与 shouldShowPageNavJump 同一个判据）", () => {
    const html = renderResults(propsOf("关键词", hitsOf(20)));
    expect(html).not.toContain("搜索结果分页");
    expect(html).not.toMatch(/<form[^>]*method="get"/);
    // 逻辑层同口径：单页不可用
    expect(
      describeSearchJumpForm({
        pageHref: (next) => searchPageUrl("关键词", next),
        total: 20,
        perPage: 20,
        totalPages: 1,
      }).visible
    ).toBe(false);
    expect(
      describeSearchJumpForm({
        pageHref: (next) => searchPageUrl("关键词", next),
        total: TOTAL_PAGES_3,
        perPage: 20,
        totalPages: 3,
      }).visible
    ).toBe(true);
  });

  it("不传 onJumpHref 时表单仍然是完整的原生表单（无浅路由也能提交）", () => {
    // ⚠️ 这条钉住"可选 prop"的意义：既有调用方不传回调，控件也不该退化成死的壳
    const html = renderResults(propsOf("关键词", hitsOf(TOTAL_PAGES_3)));
    expect(html).toMatch(/<form[^>]*method="get"/);
    expect(html).toMatch(new RegExp(`name="${SEARCH_JUMP_PAGE_PARAM}"`));
    const src = readSrc("components/SearchResults/index.tsx");
    // 没有回调就不拦截提交（让浏览器原生 GET 提交）
    expect(src).toMatch(/const navigate = props\.onJumpHref;/);
    expect(src).toMatch(/if \(!navigate\) \{/);
  });
});

describe("🔴 与 searchPageUrl 的平价：表单提交产出的 URL 与翻页链接逐字相同", () => {
  const queries = [
    "关键词",
    "C# 编程",
    "a&b=c",
    "井#号",
    "百分之%百",
    "加号+空格 查询",
    "?问号=等号",
    "日文のテスト",
    `超长${"询".repeat(MAX_QUERY_CHARS + 30)}`,
  ];

  it("各种会被编码咬到的查询词，表单产出的 URL 与 searchPageUrl 完全一致", () => {
    for (const query of queries) {
      const model = describeSearchJumpForm({
        pageHref: (next) => searchPageUrl(query, next),
        total: TOTAL_PAGES_3,
        perPage: 20,
        totalPages: 3,
      });
      for (const page of [2, 3]) {
        expect(submittedSearchOf(model, page), `query=${query} page=${page}`).toBe(
          searchPageUrl(query, page)
        );
      }
      // 第 1 页：searchPageUrl 刻意省略 p，而原生表单一定会带上 p=1。
      // 所以这里比的是**读回来的语义**，不是字符串（readSearchQueryParams 必须得到同一个 (q, page)）。
      const first = submittedSearchOf(model, 1);
      const parsedForm = readSearchQueryParams(
        Object.fromEntries(
          new URLSearchParams(first.slice(first.indexOf("?") + 1))
        ) as Record<string, string>
      );
      const canonical = searchPageUrl(query, 1);
      const parsedLink = readSearchQueryParams(
        Object.fromEntries(
          new URLSearchParams(canonical.slice(canonical.indexOf("?") + 1))
        ) as Record<string, string>
      );
      expect(parsedForm, `query=${query} page=1`).toEqual(parsedLink);
    }
  });

  it("空查询也不漂移（searchPageUrl 会省略 q，表单同样不带隐藏字段）", () => {
    const model = describeSearchJumpForm({
      pageHref: (next) => searchPageUrl("", next),
      total: TOTAL_PAGES_3,
      perPage: 20,
      totalPages: 3,
    });
    expect(model.target.query).toBe(null);
    expect(submittedSearchOf(model, 2)).toBe(searchPageUrl("", 2));
  });

  it("action 取自 pageHref 的路径部分，不是硬编码的字符串", () => {
    const model = describeSearchJumpForm({
      pageHref: (next) => searchPageUrl("关键词", next),
      total: TOTAL_PAGES_3,
      perPage: 20,
      totalPages: 3,
    });
    expect(model.form.action).toBe("/search");
    expect(model.form.method).toBe("get");
  });

  it("pageHref 产出垃圾地址时退回 /search 且不带 q（宁可少带，也不要指向别处）", () => {
    // ⚠️ 带基址的 new URL 几乎不抛：垃圾串会被解析成一个路径。所以兜底靠的是"只接受
    // 路径绝对的 href"这一步，而不是 try/catch。这条用例钉的就是那个行为。
    const broken = readSearchJumpTarget(() => "not a url at all");
    expect(broken.action).toBe("/search");
    expect(broken.query).toBe(null);
    const empty = readSearchJumpTarget(() => "");
    expect(empty.action).toBe("/search");
    expect(empty.query).toBe(null);
  });

  it("🔴 pageHref 产出外部绝对 URL 时，action 也不会指向站外（表单不可能被用来提交到别的源）", () => {
    const external = readSearchJumpTarget(() => "https://evil.example/search?q=steal");
    expect(external.action).toBe("/search");
    expect(external.query).toBe(null);
    const protocolRelative = readSearchJumpTarget(() => "//evil.example/search?q=steal");
    expect(protocolRelative.action).toBe("/search");
    expect(protocolRelative.query).toBe(null);
  });

  it("action 取自 href 的路径，所以部署在 next basePath 下也正确", () => {
    const based = readSearchJumpTarget((next) =>
      next <= 1 ? "/blog/search?q=%E5%85%B3%E9%94%AE%E8%AF%8D" : `/blog/search?q=%E5%85%B3%E9%94%AE%E8%AF%8D&p=${next}`
    );
    expect(based.action).toBe("/blog/search");
    expect(based.query).toBe("关键词");
  });

  it("隐藏 q 的来源是 pageHref 反解，不是 props.query —— 源码层面也钉住", () => {
    const src = readSrc("components/SearchResults/index.tsx");
    // 表单里的隐藏字段取的是 model.target.query（来自 pageHref 反解）
    expect(src).toContain("value={model.target.query}");
    // 🔴 反向钉住：不许把展示形 props.query 直接塞进隐藏字段
    expect(src).not.toContain(`name={SEARCH_JUMP_QUERY_PARAM} value={props.query}`);
    const logic = readSrc("components/SearchResults/jumpForm.ts");
    expect(logic).toContain("url.searchParams.get(SEARCH_JUMP_QUERY_PARAM)");
  });
});

describe("判定口径与 PageNavJump 完全一致（不允许两套口径各自漂移）", () => {
  const raws = ["", "   ", "abc", "2.5", "-1", "0", "1", "2", "3", "4", "99", "1e3", "3 "];

  /**
   * 把两边的判定结果归一成同一个形状再比。
   * ⚠️ 为什么要这两个助手：①`if (!mine.ok && !theirs.ok)` 这种**跨变量**的判别式收窄不生效；
   * ②🔴 实测还有一条 tsc 行为值得记：对这两个 `{ok:true}|{ok:false}` 的联合，
   * `result.ok ? A : B` 只在 **true 分支**收窄，**false 分支不收窄**（报 reason 不存在于联合）——
   * 这也解释了为什么 jump.ts 里的 `submitPageNavJump` 只在 true 分支取 `result.href`。
   * 拆成两个各自只吃单一联合的助手**也不够**，所以这里改用 **`"reason" in result`** 收窄
   * （不依赖布尔判别式在负分支的行为，也不需要类型断言）。
   * ⚠️ 别"顺手简化"回 `result.ok ? … : …`，那会编译不过。
   * 顺带让平价断言变成"整个判定结果相等"，比逐个字段比更强。
   */
  const verdictMine = (result: SearchJumpResult) =>
    "reason" in result
      ? { ok: false as const, reason: result.reason }
      : { ok: true as const, page: result.page };
  const verdictTheirs = (result: PageNavJumpResult) =>
    "reason" in result
      ? { ok: false as const, reason: result.reason }
      : { ok: true as const, page: result.page };

  it("同样的输入给出同样的 ok / reason / page", () => {
    for (const raw of raws) {
      const mine = resolveSearchJump(raw, 3);
      const theirs = resolvePageNavJump(raw, {
        total: TOTAL_PAGES_3,
        pageSize: 20,
        base: "/",
        more: "/page",
      });
      expect(verdictMine(mine), `raw=${JSON.stringify(raw)}`).toEqual(verdictTheirs(theirs));
      // PageNavJump 那边还会构造 href；确认它构造的是**文章列表**的形状
      // （`/page/N`）—— 这正是它不能被搜索页直接复用的原因。
      if (theirs.ok) {
        expect(theirs.href, `raw=${JSON.stringify(raw)}`).toBe(
          pageNavHref("/", "/page", theirs.page)
        );
      }
    }
  });

  it("越界是**拒绝**而不是夹取（与 PageNavJump 同口径；夹取只发生在 paginate 那条既有路径上）", () => {
    expect(resolveSearchJump("99", 3)).toEqual({ ok: false, reason: "outofrange" });
    expect(resolveSearchJump("0", 3)).toEqual({ ok: false, reason: "outofrange" });
    expect(resolveSearchJump("-2", 3)).toEqual({ ok: false, reason: "outofrange" });
  });

  it("单页时是 unavailable（不是 outofrange）", () => {
    expect(resolveSearchJump("1", 1)).toEqual({ ok: false, reason: "unavailable" });
    expect(resolveSearchJump("1", 0)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("submitSearchJump 只在解析成功时导航，且导航到搜索 URL（不是 /page/N）", () => {
    const seen: string[] = [];
    const navigate = (href: string) => {
      seen.push(href);
    };
    const pageHrefFn = (next: number) => searchPageUrl("关键词", next);
    expect(submitSearchJump("3", 3, navigate, pageHrefFn)).toEqual({ ok: true, page: 3 });
    expect(seen).toEqual(["/search?q=%E5%85%B3%E9%94%AE%E8%AF%8D&p=3"]);
    expect(submitSearchJump("99", 3, navigate, pageHrefFn).ok).toBe(false);
    expect(submitSearchJump("", 3, navigate, pageHrefFn).ok).toBe(false);
    expect(submitSearchJump("x", 3, navigate, pageHrefFn).ok).toBe(false);
    // 后面三次都不该导航
    expect(seen).toHaveLength(1);
  });

  it("handleSearchJumpSubmit 会 preventDefault（有 JS 时改走浅路由，不整页刷新）", () => {
    let prevented = 0;
    const seen: string[] = [];
    const result = handleSearchJumpSubmit(
      {
        preventDefault: () => {
          prevented += 1;
        },
      },
      "2",
      3,
      (href) => {
        seen.push(href);
      },
      (next) => searchPageUrl("关键词", next)
    );
    expect(prevented).toBe(1);
    expect(result).toEqual({ ok: true, page: 2 });
    expect(seen).toHaveLength(1);
  });

  it("解析失败时也会 preventDefault，但不导航（与 PageNavJump 的行为一致：什么都不发生）", () => {
    let prevented = 0;
    const seen: string[] = [];
    const result = handleSearchJumpSubmit(
      {
        preventDefault: () => {
          prevented += 1;
        },
      },
      "99",
      3,
      (href) => {
        seen.push(href);
      },
      (next) => searchPageUrl("关键词", next)
    );
    expect(prevented).toBe(1);
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("文案全部复用 PAGE_NAV_JUMP_* 常量，没有另写一套字符串", () => {
    const model = describeSearchJumpForm({
      pageHref: (next) => searchPageUrl("关键词", next),
      total: TOTAL_PAGES_3,
      perPage: 20,
      totalPages: 3,
    });
    expect(model.labels.form).toBe(PAGE_NAV_JUMP_LABEL);
    expect(model.labels.prefix).toBe(PAGE_NAV_JUMP_PREFIX);
    expect(model.labels.unit).toBe(PAGE_NAV_JUMP_UNIT);
    expect(model.labels.input).toBe(PAGE_NAV_JUMP_INPUT_LABEL);
    expect(model.labels.go).toBe(PAGE_NAV_JUMP_GO_LABEL);
    expect(model.submit.label).toBe(PAGE_NAV_JUMP_GO_LABEL);
    // 解析器也是复用的：jumpForm 自己没有再写一份整数正则
    const logic = readSrc("components/SearchResults/jumpForm.ts");
    expect(logic).toContain("parseJumpPage(raw)");
    expect(logic).not.toContain("new RegExp");
    expect(logic).toContain("shouldShowPageNavJump(");
  });
});

describe("接线：页面用浅路由接上，且没有破坏「翻页不重新搜索」这个既有性质", () => {
  it("pages/search.tsx 传了 onJumpHref，走 shallow replace", () => {
    const src = readSrc("pages/search.tsx");
    expect(src).toContain("onJumpHref=");
    expect(src).toMatch(/router\.replace\(href, undefined, \{ shallow: true \}\)/);
  });

  it("搜索 effect 的依赖里仍然没有 page（翻页不该重新搜索）", () => {
    const src = readSrc("pages/search.tsx");
    // 那条 effect 以 }, [ready, q]); 收尾；page 不在依赖里
    expect(src).toMatch(/\}, \[ready, q\]\);/);
    expect(src).not.toMatch(/\}, \[ready, q, page\]\);/);
  });

  it("跳转逻辑留在 SearchResults 里，没有渗到每个页面都背的公共模块", () => {
    // SearchCard 被 Layout 引到**每一个**页面上，所以它不许引跳转逻辑（首屏 JS 预算）
    const card = readSrc("components/SearchCard/index.tsx");
    expect(card).not.toContain("jumpForm");
    expect(card).not.toContain("SearchResults");
    // 而 utils/searchUrls.ts 仍然不 import 任何东西（它被公共 chunk 引用）
    const urls = readSrc("utils/searchUrls.ts");
    expect(urls).not.toMatch(/^\s*import\s/m);
  });

  it("新文件在搜索路径上，所以同样不许构造 HTML、不许 require、不许引搜索库", () => {
    const src = readSrc("components/SearchResults/jumpForm.ts");
    for (const banned of [
      "dangerouslySetInnerHTML",
      "innerHTML",
      "insertAdjacentHTML",
      "document.write",
      "outerHTML",
      "require(",
    ]) {
      expect(src, banned).not.toContain(banned);
    }
    expect(src).not.toMatch(/from\s+["'](lunr|flexsearch|minisearch|fuse\.js)/);
    // 尺子有效性反证：这把尺子确实量得到东西（喂一段坏源码进去会命中）
    const bad = `const x = { dangerouslySetInnerHTML: {} }; require("lunr");`;
    expect(bad).toContain("dangerouslySetInnerHTML");
    expect(bad).toContain("require(");
  });
});
