import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  escapeRegExp,
  foldWithOffsets,
  highlightSegments,
  matchSpans,
  mergeSpans,
  snippetWindow,
  displayQuery,
} from "../utils/searchHighlight";
import { renderHighlighted } from "../components/SearchResults/highlight";
import SearchResults from "../components/SearchResults";
import { RankedDoc } from "../utils/searchRank";

(globalThis as { React?: typeof React }).React = React;

const websiteRoot = path.join(__dirname, "..");
const readSrc = (rel: string) => readFileSync(path.join(websiteRoot, rel), "utf8");
/**
 * 剥掉注释再扫源码：这些文件的**注释里**就写着 "dangerouslySetInnerHTML"、"new RegExp"
 * （用来解释为什么不用它们），不剥注释的话断言会被自己的说明文字绊倒。
 * 与 server 的 audit-hardening-round3-backup.spec.ts 同一个手法。
 */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/** 搜索这条路径上的所有源文件："不许构造 HTML"是源码级约束，不只是行为级 */
const SEARCH_SOURCES = [
  "utils/searchHighlight.ts",
  "utils/searchRank.ts",
  "utils/searchIndex.ts",
  "api/searchIndex.ts",
  "components/SearchResults/index.tsx",
  "components/SearchResults/highlight.tsx",
  "pages/search.tsx",
];

describe("高亮：只产出数据，绝不产出 HTML", () => {
  it("源码里没有 dangerouslySetInnerHTML / innerHTML / insertAdjacentHTML / document.write", () => {
    for (const rel of SEARCH_SOURCES) {
      const src = codeOnly(readSrc(rel));
      expect(src, rel).not.toContain("dangerouslySetInnerHTML");
      expect(src, rel).not.toContain("innerHTML");
      expect(src, rel).not.toContain("insertAdjacentHTML");
      expect(src, rel).not.toContain("document.write");
      expect(src, rel).not.toContain("outerHTML");
    }
  });

  it("整条搜索路径上不构造正则（查询里的正则炸弹因此无处可炸）", () => {
    for (const rel of SEARCH_SOURCES) {
      const src = codeOnly(readSrc(rel));
      expect(src, rel).not.toContain("new RegExp");
      expect(src, rel).not.toMatch(/\beval\s*\(/);
      expect(src, rel).not.toMatch(/new\s+Function\s*\(/);
      // 唯一允许的正则是**字面量**（写死在源码里的），绝不能由查询拼出来。
      // `.replace(x, …)` / `.match(x)` / `.split(x)` 的第一个实参必须以 `/` 开头；
      // 唯一的例外是 next/router 的 `router.replace(...)` —— 那是导航 API，不是字符串替换。
      const receivers = (src.match(/([A-Za-z_$][\w$]*)\.replace\(\s*[^/)]/g) || [])
        .map((hit) => hit.split(".")[0])
        .filter((name) => name !== "router");
      expect(receivers, `${rel} 里有非字面量正则的字符串 replace`).toEqual([]);
      expect(src, rel).not.toMatch(/\.match\(\s*[^/)]/);
      expect(src, rel).not.toMatch(/\.split\(\s*[^/)"'`]/);
    }
    // 负控：这条断言不是空的 —— escapeRegExp 确实导出了、而本模块自己一次都没调它
    const highlightSrc = codeOnly(readSrc("utils/searchHighlight.ts"));
    expect(highlightSrc).toContain("export function escapeRegExp");
    expect((highlightSrc.match(/escapeRegExp\(/g) || []).length).toBe(1);
  });

  it("escapeRegExp 本身是正确的（留给「以后真要写 new RegExp 的人」）", () => {
    expect(escapeRegExp("(a+)+b")).toBe("\\(a\\+\\)\\+b");
    expect(escapeRegExp(".*+?^${}()|[]\\")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
    expect(escapeRegExp("备份")).toBe("备份");
    expect(escapeRegExp(undefined)).toBe("");
  });

  it("片段拼回来与原文逐字符相同（一个字符都不丢、不改、不转义）", () => {
    const samples = [
      "整站备份与恢复演练",
      "Docker 部署 VanBlog 的 12 个坑",
      "emoji 😀🇨🇳 与代理对",
      "<img src=x onerror=alert(1)>",
      '"><script>alert(1)</script>',
      "a<b>c&d\"e'f",
      "",
      "　全角空格　",
    ];
    for (const text of samples) {
      for (const query of ["a", "备份", "docker", "<img", "😀", ""]) {
        const segments = highlightSegments(text, query);
        expect(segments.map((s) => s.text).join("")).toBe(text);
      }
    }
  });

  it("命中的片段被标成 match=true，且保留原文的大小写", () => {
    const segments = highlightSegments("Docker 与 docker 与 DOCKER", "docker");
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual([
      "Docker",
      "docker",
      "DOCKER",
    ]);
    expect(segments.map((s) => s.text).join("")).toBe("Docker 与 docker 与 DOCKER");
  });

  it("多个词各自高亮，重叠区间被合并（不会嵌套 <mark>）", () => {
    // "备份"(2..4)、"备份与"(2..5)、"恢复"(5..7)：相接的区间合并成一个 [2,7)，
    // 于是渲染出**一个** <mark>备份与恢复</mark> 而不是两个相邻的 mark（后者会有可见的缝）
    const spans = mergeSpans(matchSpans("整站备份与恢复", ["备份", "恢复", "备份与"]));
    expect(spans).toEqual([[2, 7]]);
    const segments = highlightSegments("整站备份与恢复", "备份 恢复 备份与");
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(["备份与恢复"]);
    // 负控：不相接的区间不会被合并
    expect(mergeSpans(matchSpans("备份与恢复", ["备份", "恢复"]))).toEqual([
      [0, 2],
      [3, 5],
    ]);
    expect(mergeSpans([])).toEqual([]);
  });

  it("没有命中 / 没有查询时返回单个 match=false 片段（不是空数组）", () => {
    expect(highlightSegments("正文", "不存在的词")).toEqual([{ text: "正文", match: false }]);
    expect(highlightSegments("正文", "")).toEqual([{ text: "正文", match: false }]);
    expect(highlightSegments("正文", "   ")).toEqual([{ text: "正文", match: false }]);
    expect(highlightSegments("", "x")).toEqual([]);
    expect(highlightSegments(undefined, "x")).toEqual([]);
  });

  it("折叠后长度会变的字符（İ U+0130）不会让高亮错位", () => {
    // 'İ'.toLowerCase() 是 'i' + U+0307：1 个码元变 2 个。
    // 直接用折叠串的下标去切原文，就会整体右移一位、切出错误的片段。
    const text = "İ docker 部署";
    expect(text.length).toBe(11);
    expect("İ".toLowerCase().length).toBe(2); // 负控：这个字符确实会变长
    const segments = highlightSegments(text, "docker");
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(["docker"]);
    expect(segments.filter((s) => !s.match).map((s) => s.text)).toEqual(["İ ", " 部署"]);
  });

  it("如实记录：İ 折叠成 i+U+0307，所以搜 istanbul 搜不到 İstanbul（这是选定的折叠规则的后果）", () => {
    // 这就是文件头写的那条分歧：我们用 locale 无关的 toLowerCase()，
    // 而服务端 JS 复筛用 toLocaleLowerCase()（土耳其语 locale 下 İ → i，会命中）。
    // 不假装两边一样，把差异钉在这里。
    expect(highlightSegments("İstanbul", "istanbul").filter((s) => s.match)).toEqual([]);
    expect(matchSpans("İstanbul", ["istanbul"])).toEqual([]);
  });

  it("emoji 代理对不会被高亮切成两半", () => {
    const text = "a😀b😀c";
    const segments = highlightSegments(text, "😀");
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(["😀", "😀"]);
    for (const seg of segments) {
      // 负控：任何一段都不该以孤立的高代理结尾、或以孤立的低代理开头
      const last = seg.text.charCodeAt(seg.text.length - 1);
      const first = seg.text.charCodeAt(0);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
  });

  it("foldWithOffsets：映射可用时给出原文区间，输入非字符串时给空串", () => {
    const mapped = foldWithOffsets("Abc");
    expect(mapped.unmappable).toBe(false);
    expect(mapped.folded).toBe("abc");
    expect(mapped.starts).toEqual([0, 1, 2]);
    expect(mapped.ends).toEqual([1, 2, 3]);
    const expanded = foldWithOffsets("İ");
    expect(expanded.unmappable).toBe(false);
    expect(expanded.starts).toEqual([0, 0]);
    expect(foldWithOffsets(undefined).folded).toBe("");
    expect(foldWithOffsets(42).folded).toBe("");
  });

  it("snippetWindow：命中不在开头时开窗，返回的仍是原文切片（所以高亮下标继续有效）", () => {
    const text = `${"前".repeat(100)}关键词${"后".repeat(100)}`;
    const win = snippetWindow(text, "关键词", 60, 20);
    expect(win.length).toBeLessThanOrEqual(61); // 60 + 可能的前导 …
    expect(win).toContain("关键词");
    expect(win.startsWith("…")).toBe(true);
    // 开窗结果必须是原文的子串（去掉前导 …）
    expect(text.includes(win.replace(/^…/, ""))).toBe(true);
    // 短文本原样返回
    expect(snippetWindow("短文本", "短", 140)).toBe("短文本");
    expect(snippetWindow("", "x")).toBe("");
    expect(snippetWindow(undefined, "x")).toBe("");
  });

  it("displayQuery：查询回显有长度上限（别让人拿 URL 撑爆标题）", () => {
    expect(displayQuery("  备份 ")).toBe("备份");
    expect(displayQuery("x".repeat(500)).length).toBe(200);
    expect(displayQuery(undefined)).toBe("");
    expect(displayQuery(42)).toBe("");
  });
});

/**
 * 逐标签扫描渲染结果：只允许白名单里的标签，且任何标签都不许带 on* 事件属性或 javascript: URL。
 *
 * ⚠️ 这比 `expect(html).not.toContain("onerror=")` 严格得多也**准确**得多：
 * 攻击串被 React 转义成文本之后，`&lt;img src=x onerror=alert(1)&gt;` 里
 * 字面上仍然含有 "onerror="（那是**文本**，不是属性，完全安全）。
 * 真正要断言的是"页面里不存在一个带事件属性的标签"，所以必须解析标签而不是找子串。
 */
const ALLOWED_RESULT_TAGS = new Set([
  "div", "mark", "p", "ol", "li", "h2", "nav", "span", "ul", "a",
]);

function assertOnlyAllowedHtml(html: string, allowed: Set<string>): number {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  let found = 0;
  // eslint-disable-next-line no-cond-assign
  while ((match = tagRe.exec(html)) !== null) {
    found++;
    const name = match[1].toLowerCase();
    const attrs = match[2] || "";
    expect(allowed.has(name), `渲染出了白名单之外的标签 <${name}>（属性：${attrs}）`).toBe(true);
    expect(attrs, `<${name}> 带了事件属性`).not.toMatch(/\son[a-z-]+\s*=/i);
    expect(attrs, `<${name}> 带了 javascript: URL`).not.toMatch(/javascript\s*:/i);
  }
  // 负控：确实扫到了标签，否则上面的循环可能是空的
  expect(found, "一个标签都没扫到，说明这条断言是空的").toBeGreaterThan(0);
  return found;
}

describe("高亮：XSS 负控（用户输入绝不变成 HTML）", () => {
  const ATTACKS = [
    "<img src=x onerror=alert(1)>",
    '"><script>alert(1)</script>',
    "'-alert(1)-'",
    "<svg/onload=alert(1)>",
    "javascript:alert(1)",
    '<mark onmouseover="alert(1)">x</mark>',
    "\\u003cscript\\u003ealert(1)\\u003c/script\\u003e",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "]]&gt;&lt;script&gt;",
    // 正则炸弹：如果哪里把查询拼进了 new RegExp，这一条会挂住整个测试进程
    "(a+)+b",
    "(x+x+)+y",
    "((((((((((a))))))))))",
    "a{1000000}b",
  ];

  it("把攻击串当**查询**：渲染结果里不出现任何真实标签，也不卡住", () => {
    const text = "这是一篇讲 Docker 部署的文章，正文里有 <b> 这样的字样。";
    for (const attack of ATTACKS) {
      const started = Date.now();
      const html = renderToStaticMarkup(
        React.createElement("div", null, renderHighlighted(text, attack)),
      );
      // 正则炸弹的计时断言：结构上不可能回溯，所以必须秒回
      expect(Date.now() - started, attack).toBeLessThan(500);
      // 原文里的 <b> 只能以转义形式出现
      expect(html, attack).toContain("&lt;b&gt;");
      // 原文里的 <b> 被 React 转义成了 &lt;b&gt;（文本），所以白名单里**不需要** b：
      // 如果它真的以标签形式出现，这条断言就该红。
      assertOnlyAllowedHtml(html, ALLOWED_RESULT_TAGS);
      // 攻击串自己要么被转义成文本，要么根本没命中（这两种都安全）
      expect(html, attack).not.toContain("<script");
      expect(html, attack).not.toContain("<img");
      expect(html, attack).not.toContain("<svg");
    }
  });

  it("把攻击串当**正文**（索引里被写入的标题/摘要）：同样只是文本", () => {
    for (const attack of ATTACKS) {
      const html = renderToStaticMarkup(
        React.createElement("div", null, renderHighlighted(attack, "a")),
      );
      expect(html, attack).not.toContain("<script");
      expect(html, attack).not.toContain("<img");
      assertOnlyAllowedHtml(html, ALLOWED_RESULT_TAGS);
      // 内容没丢：把 React 的转义还原回来、去掉我们自己加的 <mark>，必须逐字符等于原文
      const unescaped = html
        .replace(/<\/?mark[^>]*>/g, "")
        .replace(/^<div>|<\/div>$/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&");
      expect(unescaped, attack).toBe(attack);
    }
  });

  it("查询与正文同时是攻击串：仍然只有文本与 <mark>", () => {
    const attack = '<img src=x onerror=alert(1)>';
    const html = renderToStaticMarkup(
      React.createElement("div", null, renderHighlighted(attack, attack)),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("<mark");
    assertOnlyAllowedHtml(html, ALLOWED_RESULT_TAGS);
  });

  it("整个结果区（含标题、摘要、分类、标签、状态行）喂攻击串也不产出 HTML", () => {
    const attack = '<img src=x onerror=alert(1)>';
    const script = '"><script>alert(1)</script>';
    const hits: RankedDoc[] = [
      {
        doc: {
          id: 1,
          u: "/post/1",
          t: attack,
          s: `${script} 摘要正文`,
          c: attack,
          g: [script, attack],
          d: "2026-01-02",
          w: 100,
        },
        tier: 1,
        hits: 3,
      },
    ];
    const html = renderToStaticMarkup(
      React.createElement(SearchResults, {
        query: attack,
        page: 1,
        results: hits,
        matched: 1,
        capped: false,
        backend: "index" as const,
        notice: script,
        indexNotices: [attack],
        loading: false,
        failed: false,
        idle: false,
        openInNewWindow: false,
        pageHref: (p: number) => `/search?p=${p}`,
      } as any),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    // 结果链接是真的 <a href>，而且 href 来自索引的 u 字段（不是查询）
    expect(html).toContain('href="/post/1"');
    // 降级原因（notice）与索引提示也是用户可控文本，同样只能是文本
    expect(html).toContain("&lt;script&gt;");
    assertOnlyAllowedHtml(html, ALLOWED_RESULT_TAGS);
  });

  it("结果区有 aria-live，输入框有 label，结果链接是真链接（可访问性 + 无 JS 语义）", () => {
    const hits: RankedDoc[] = [
      {
        doc: { id: 1, u: "/post/1", t: "标题", s: "摘要", c: "分类", g: [], d: "2026-01-02", w: 10 },
        tier: 1,
        hits: 1,
      },
    ];
    const html = renderToStaticMarkup(
      React.createElement(SearchResults, {
        query: "标题",
        page: 1,
        results: hits,
        matched: 1,
        capped: false,
        backend: "index" as const,
        notice: "",
        indexNotices: [],
        loading: false,
        failed: false,
        idle: false,
        openInNewWindow: false,
        pageHref: (p: number) => `/search?p=${p}`,
      } as any),
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain("<mark");
    expect(html).toContain('href="/post/1"');

    const pageSrc = readSrc("pages/search.tsx");
    expect(pageSrc).toContain('htmlFor="vanblog-search-input"');
    expect(pageSrc).toContain("<label");
    expect(pageSrc).toContain("<noscript>");
    expect(pageSrc).toContain('action="/api/public/search"');
    // 无 JS 的出口是一个真的 GET 表单，参数名与服务端接口一致（value，不是 q）
    expect(pageSrc).toContain('name="value"');
  });
});
