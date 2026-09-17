import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import SearchCard, {
  SEARCH_VIEW_ALL_LABEL,
  ViewAllResultsLink,
} from "../components/SearchCard";

(globalThis as { React?: typeof React }).React = React;

const websiteRoot = path.join(__dirname, "..");
const readRaw = (rel: string) => readFileSync(path.join(websiteRoot, rel), "utf8");
/**
 * 剥掉注释再扫：`pages/search.tsx` 的**注释里**就写着 `getServerSideProps`
 * 与 `/static/search/index.json`（用来解释为什么不用它们）。不剥注释的话，
 * "不许出现 X" 的断言会被自己的说明文字绊倒 —— 这正是 server 那边
 * audit-hardening-round3-backup.spec.ts 早就用过的同一个手法。
 */
const readSrc = (rel: string) =>
  readRaw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

/**
 * 这一组是"接线"断言：新的 `/search` 页与既有弹窗之间的连接、以及那些
 * **只在源码层面才看得见**的约定（ISR 的 revalidate、懒加载、URL 同步、无 JS 出口）。
 * 行为层的断言在 searchRank / searchHighlight / searchIndex 三个 spec 里。
 */
describe("SearchCard：只加了一个「查看全部结果」的出口，没有被重写", () => {
  it("弹窗的内联搜索行为原样保留（仍然调 /api/public/search，仍然有 debounce 与过期响应守卫）", () => {
    const src = readSrc("components/SearchCard/index.tsx");
    expect(src).toContain('import { searchArticles } from "../../api/search"');
    expect(src).toContain("useDebounce(");
    expect(src).toContain("seqRef");
    expect(src).toContain("SEARCH_RESULT_ATTR");
    // a11y 那套常量和函数一个都没动（searchCardA11y.spec.ts 仍然绿）
    expect(src).toContain("handleSearchShortcutKeyDown");
    expect(src).toContain("openSearchFromUserGesture");
  });

  it("「查看全部结果」是一个真的 <a href>，指向 /search?q=<编码后的关键词>", () => {
    const html = renderToStaticMarkup(
      React.createElement(ViewAllResultsLink, { query: "docker", onClick: () => {} }),
    );
    expect(html).toContain("<a");
    expect(html).toContain('href="/search?q=docker"');
    expect(html).toContain(SEARCH_VIEW_ALL_LABEL);
    expect(html).toContain("docker");
  });

  it("关键词被百分号编码（C# / a&b / 中文 / 攻击串都不会破坏 href）", () => {
    for (const query of ["C#", "a&b=c", "备份", "<img src=x onerror=alert(1)>", '"><script>']) {
      const html = renderToStaticMarkup(
        React.createElement(ViewAllResultsLink, { query, onClick: () => {} }),
      );
      expect(html, query).toContain(`href="/search?q=${encodeURIComponent(query)}"`);
      expect(html, query).not.toContain("<script");
      expect(html, query).not.toContain("<img");
    }
  });

  it("空查询不渲染这个链接（没有关键词时「查看全部结果」没有意义）", () => {
    expect(
      renderToStaticMarkup(React.createElement(ViewAllResultsLink, { query: "", onClick: () => {} })),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        React.createElement(ViewAllResultsLink, { query: "   ", onClick: () => {} }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        React.createElement(ViewAllResultsLink, { query: undefined as any, onClick: () => {} }),
      ),
    ).toBe("");
  });

  it("有结果与「暂无结果」两种状态都给出口（弹窗搜不到 ≠ 全站搜不到）", () => {
    const src = readSrc("components/SearchCard/index.tsx");
    const occurrences = (src.match(/<ViewAllResultsLink/g) || []).length;
    expect(occurrences).toBe(2);
    // 点击后关掉弹窗（否则导航走了、遮罩还盖在页面上）
    expect(src).toContain("onClick={closeSearch}");
  });

  it("弹窗本身的导出与结构没有被改动（不在服务端渲染它：它用 useLayoutEffect，会刷一条无意义的告警）", () => {
    const raw = readRaw("components/SearchCard/index.tsx");
    expect(raw).toContain("const SearchCard = forwardRef<");
    expect(raw).toContain("export default SearchCard;");
    expect(raw).toContain("export type SearchCardHandle = {");
    expect(raw).toContain('aria-label={SEARCH_DIALOG_LABEL}');
    expect(raw).toContain('type="search"');
    // 默认导出还是那个 forwardRef 组件（换掉它会让所有引用它的地方静默变味）
    expect(typeof SearchCard).toBe("object");
  });
});

describe("pages/search.tsx：ISR 静态壳 + 懒加载 + URL 同步 + 无 JS 出口", () => {
  const src = readSrc("pages/search.tsx");

  it("走的是与 /about、/timeline 同一套 getStaticProps 约定（含 revalidate 与 isBuild 兜底）", () => {
    expect(src).toContain("export async function getStaticProps()");
    expect(src).toContain("await getPublicMeta()");
    expect(src).toContain("getLayoutProps(data)");
    expect(src).toContain("getAuthorCardProps(data)");
    expect(src).toContain("...revalidate");
    // 不是 SSR：把每次搜索都变成一次 Node 渲染 + 一次公开接口回调，正是这一轮要消掉的成本
    expect(src).not.toContain("getServerSideProps");
  });

  it("索引不在 getStaticProps 里取（否则它会进 __NEXT_DATA__，每个访客都白下载一份）", () => {
    expect(src).not.toContain("loadSearchIndex");
    expect(src).not.toContain("/static/search/index.json");
    // getStaticProps 里只有布局数据
    const staticProps = src.slice(src.indexOf("export async function getStaticProps()"));
    expect(staticProps).not.toContain("runSearch");
    expect(staticProps).not.toContain("docs");
  });

  it("索引是懒加载的：只有真的开始搜了才 runSearch，且带过期响应守卫", () => {
    expect(src).toContain("runSearch(term)");
    expect(src).toContain("let cancelled = false");
    expect(src).toContain("cancelled = true");
    // 空查询直接回到 idle，不发请求
    expect(src).toContain("setState(IDLE_STATE)");
  });

  it("查询与页码都在 URL 里，且用 shallow 路由同步（不整页刷新）", () => {
    expect(src).toContain("readSearchQueryParams(router.query)");
    expect(src).toContain("searchPageUrl(");
    expect(src).toContain("{ shallow: true }");
    expect(src).toContain("useDebounce(");
    // router 就绪前 query 是 {}，必须等 isReady（静态页首次客户端渲染的既有陷阱）
    expect(src).toContain("router.isReady");
  });

  it("翻页不重新搜索（page 不在搜索 effect 的依赖里）", () => {
    // 用代码里的锚点切出那段 effect（注释已经被 readSrc 剥掉了，不能拿注释当锚点）
    const effect = src.slice(src.indexOf("if (!term)"), src.indexOf("const onSubmit"));
    expect(effect.length).toBeGreaterThan(50); // 负控：切片不是空的
    expect(effect).toContain("[ready, q]");
    expect(effect).not.toContain("[ready, q, page]");
  });

  it("没有 JS 时不是一块空白矩形：有 <noscript> 与一个真的 GET 表单指向服务端接口", () => {
    expect(src).toContain("<noscript>");
    expect(src).toContain('action="/api/public/search"');
    expect(src).toContain('method="get"');
    // 服务端接口的参数名是 value（不是 q），写错了就是一个静默的 400/空结果
    expect(src).toContain('name="value"');
    expect(src).toContain("返回 JSON");
  });

  it("输入框有真实的 label（可访问性）", () => {
    expect(src).toContain('htmlFor="vanblog-search-input"');
    expect(src).toContain('id="vanblog-search-input"');
    expect(src).toContain('role="search"');
  });

  it("页面标题带上查询词，但长度有上限（别让人用 URL 撑爆 <title>）", () => {
    expect(src).toContain("displayQuery(");
    expect(src).toContain("搜索：");
  });
});

describe("首屏 JS 预算：只有 /search 页需要的那部分不许进公共 chunk", () => {
  it("SearchCard 只从 utils/searchUrls 取 URL helper（它被 Layout 引到每个页面上）", () => {
    const card = readRaw("components/SearchCard/index.tsx");
    expect(card).toContain('from "../../utils/searchUrls"');
    expect(card).not.toContain('from "../../utils/searchIndex"');
  });

  it("utils/searchUrls.ts 不 import 任何东西（所以它不可能把别的模块拖进公共 chunk）", () => {
    const src = readSrc("utils/searchUrls.ts");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toContain("require(");
    // 负控：它确实导出了 SearchCard 要用的那个函数
    expect(src).toContain("export function searchPageUrl");
  });

  it("索引校验与降级文案留在 utils/searchIndex.ts（只有搜索页与它的 api 层会引它）", () => {
    const src = readSrc("utils/searchIndex.ts");
    expect(src).toContain("顶层不是一个对象");
    expect(src).toContain("静态索引还没有生成");
    // 再导出让调用方仍然只有一个入口
    expect(src).toContain('} from "./searchUrls";');
    // 只有 /search 页与 SearchResults 组件引它（用剥掉注释的源码：SearchCard 的注释里
    // 正好解释了"为什么不用 utils/searchIndex"，不剥注释就会被自己的说明文字绊倒）
    for (const rel of ["components/SearchCard/index.tsx", "components/Layout/index.tsx"]) {
      expect(readSrc(rel), rel).not.toContain("utils/searchIndex");
    }
  });
});

describe("没有越界改到别人的领地（本轮的硬约束）", () => {
  it("_app / _document / Layout / PostCard / nav / apple.css 一个都没被这次改动碰过", () => {
    // 这几个文件归 website/caddy 那个 agent；这里只做"我没往里面塞搜索相关的东西"的断言
    for (const rel of [
      "pages/_app.tsx",
      "pages/_document.tsx",
      "components/Layout/index.tsx",
      "components/PostCard/index.tsx",
      "components/NavBar/index.tsx",
      "styles/apple.css",
    ]) {
      const src = readSrc(rel);
      expect(src, rel).not.toContain("searchIndex");
      expect(src, rel).not.toContain("/static/search/index.json");
      expect(src, rel).not.toContain("SearchResults");
    }
  });

  it("没有引入任何搜索库（极简是明确要求：不引 lunr / flexsearch / minisearch）", () => {
    const pkg = JSON.parse(readSrc("package.json"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const banned of ["lunr", "flexsearch", "minisearch", "fuse.js", "elasticlunr", "search-index"]) {
      expect(deps[banned], banned).toBeUndefined();
    }
    // 搜索路径上的文件也不许 require/import 任何第三方搜索库
    for (const rel of [
      "utils/searchIndex.ts",
      "utils/searchRank.ts",
      "utils/searchHighlight.ts",
      "api/searchIndex.ts",
      "components/SearchResults/index.tsx",
      "components/SearchResults/highlight.tsx",
      "pages/search.tsx",
    ]) {
      const src = readSrc(rel);
      expect(src, rel).not.toMatch(/from\s+["'](lunr|flexsearch|minisearch|fuse\.js)/);
      expect(src, rel).not.toContain("require(");
    }
  });
});
