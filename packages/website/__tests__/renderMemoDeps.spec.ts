import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * 「useMemo 依赖写了 props 对象本身 = memo 失效」这一类问题的回归钉。
 *
 * props 对象每次渲染都是新引用，以它为依赖等于**每次重渲染都重算**。
 * 对这几个调用点，重算的不是小东西：
 * - MarkdownView：remarkRehype 选项对象在 JSX 里现建 → MarkdownViewer 的
 *   useMemo([value, sanitize, plugins, remarkRehype]) 必失效 → 每次重渲染都把
 *   整篇文章重新 processSync（本机实测 31KB 正文一次 ~200ms，负载中）；
 * - MarkdownTocBar/index：parseNavStructure 把全文过一遍 unified 管线提取标题；
 * - pages/post/[id].tsx：hasToc(content) 同样全文过管线，以前直接写在 JSX 里；
 * - PostCard：calContent/showDonate 每次重渲染重算。
 * 而重渲染在真实会话里很频繁：_app 的访客统计 setState、主题 context、
 * 任何父组件 state 变化都会整树波及。
 */
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .join("\n");

describe("MarkdownView：remarkRehype 选项是模块级常量", () => {
  it("选项对象在模块作用域声明，JSX 里引用常量", () => {
    const src = strip(read("components/Markdown/MarkdownView.tsx"));
    expect(src).toMatch(/^const REMARK_REHYPE_OPTIONS = \{/m);
    expect(src).toContain("remarkRehype={REMARK_REHYPE_OPTIONS}");
    // JSX 里不许再现建对象字面量
    expect(src).not.toMatch(/remarkRehype=\{\{/);
  });
  it("handlers 仍然是 defListHastHandlers（渲染结果不变的根据）", () => {
    const src = read("components/Markdown/MarkdownView.tsx");
    expect(src).toContain("handlers: defListHastHandlers");
    expect(src).toContain("allowDangerousHtml: true");
  });
});

describe("MarkdownTocBar：全文解析只对 content 变化敏感", () => {
  it("useMemo 依赖是 [props.content] 而不是 [props]", () => {
    const src = strip(read("components/MarkdownTocBar/index.tsx"));
    expect(src).toContain("parseNavStructure(props.content)");
    expect(src).toMatch(/\}, \[props\.content\]\);/);
    expect(src).not.toMatch(/\}, \[props\]\);/);
  });
});

describe("文章页：hasToc 有 memo，JSON-LD 依赖具体字段", () => {
  it("sideBar 判断走 useMemo", () => {
    const src = strip(read("pages/post/[id].tsx"));
    expect(src).toMatch(/const sideBarHasToc = useMemo\(\(\) => hasToc\(content\), \[content\]\);/);
    expect(src).toContain("sideBarHasToc ? (");
    // JSX 里不再裸调 hasToc（每次重渲染 = 全文重解析）
    expect(src).not.toContain("hasToc(content) ? (");
  });
  it("jsonLd 的依赖不再是 props 整个对象", () => {
    const src = strip(read("pages/post/[id].tsx"));
    expect(src).not.toContain("}, [props, articleDescription]);");
    expect(src).toMatch(
      /\}, \[props\.siteUrl, props\.article, props\.author, props\.layoutProps, articleDescription\]\);/,
    );
  });
});

describe("PostCard：calContent/showDonate 的依赖是具体字段", () => {
  it("不再以 props 对象为依赖", () => {
    const src = strip(read("components/PostCard/index.tsx"));
    expect(src).not.toContain("}, [props, lock]);");
    expect(src).not.toContain("}, [props, lock, content]);");
    expect(src).toMatch(
      /\}, \[lock, props\.hideDonate, props\.pay, props\.type, props\.showDonateInAbout\]\);/,
    );
    expect(src).toMatch(
      /\}, \[props\.type, props\.private, props\.excerpt, content\]\);/,
    );
  });
});
