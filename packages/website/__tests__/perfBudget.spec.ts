import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { MERMAID_FENCE_RE, INLINE_MATH_RE, needsRichMarkdown } from "../components/Markdown";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("性能：重依赖必须按需加载", () => {
  it("MarkdownBase 不含 KaTeX / mermaid（列表页用的就是它）", () => {
    const base = read("components/Markdown/MarkdownBase.tsx");
    expect(base).not.toContain("katex");
    expect(base).not.toContain("plugin-math");
    // 注意：MarkdownView 会 import utils/mermaidTheme（纯工具、不含 mermaid 本体），
    // 所以要断言的是「没引 mermaid 渲染插件」，而不是「文件里不出现 mermaid 这个词」
    expect(base).not.toContain("@bytemd/plugin-mermaid");
    expect(base).not.toContain("mermaidViewer");
    // 但基础渲染能力要在
    for (const dep of ["plugin-gfm", "highlightSsr", "customContainer", "rawHTML", "Heading"]) {
      expect(base).toContain(dep);
    }
  });

  it("只有 MarkdownRich 引 KaTeX，且两个变体都由 index 用 next/dynamic 挂载", () => {
    expect(read("components/Markdown/MarkdownRich.tsx")).toContain("@bytemd/plugin-math-ssr");
    const index = read("components/Markdown/index.tsx");
    expect(index).toContain('dynamic(() => import("./MarkdownBase")');
    expect(index).toContain('dynamic(() => import("./MarkdownRich")');
    expect(index).not.toContain("@bytemd/plugin-math-ssr");
  });

  it("PostCard 不许引用完整版渲染器（否则 KaTeX 会回到列表页首屏）", () => {
    const card = read("components/PostCard/index.tsx");
    // 列表摘要只用懒加载的轻量渲染器
    expect(card).toContain('dynamic(() => import("../Markdown/MarkdownBase")');
    // 完整渲染器由页面通过 markdownRenderer 传进来，PostCard 自己不能 import ../Markdown
    expect(card).not.toContain('import("../Markdown")');
    expect(card).not.toMatch(/^import Markdown from "\.\.\/Markdown/m);
    expect(card).toContain("markdownRenderer?: React.ComponentType<{ content: string }>");
    // 文章页与关于页负责把完整渲染器传下去（同样是懒加载）
    for (const page of ["pages/post/[id].tsx", "pages/about.tsx"]) {
      const src = read(page);
      expect(src).toContain("markdownRenderer={FullMarkdown}");
      expect(src).toMatch(/dynamic\(\(\) => import\("\.\.\/(\.\.\/)?components\/Markdown"\)/);
    }
  });

  it("TOC 的 KaTeX 也是按需 import（以前是静态引入，首页白背 275KB）", () => {
    const toc = read("components/MarkdownTocBar/tocMath.ts");
    expect(toc).not.toMatch(/^import math from "@bytemd\/plugin-math-ssr"/m);
    expect(toc).toContain('import("@bytemd/plugin-math-ssr")');
    expect(toc).toContain("export function onTocMathReady");
    // 组件订阅加载完成事件，加载后重渲染标签
    expect(read("components/MarkdownTocBar/core.tsx")).toContain("onTocMathReady");
  });

  it("mermaid 只在正文真的有流程图时才下载", () => {
    const mermaid = read("components/Markdown/mermaidViewer.ts");
    expect(mermaid).not.toMatch(/^import mermaidPlugin from "@bytemd\/plugin-mermaid"/m);
    expect(mermaid).toContain('import("@bytemd/plugin-mermaid")');
    expect(mermaid).toContain("hasMermaidBlock");
  });
});

describe("性能：rich/base 嗅探（宁可误判也不能漏判）", () => {
  it("普通正文（单个 $，如 $PATH、价格）走轻量渲染器", () => {
    expect(needsRichMarkdown("")).toBe(false);
    expect(needsRichMarkdown("纯文本，没有特殊符号")).toBe(false);
    expect(needsRichMarkdown("正文里的 $PATH 变量")).toBe(false);
    expect(needsRichMarkdown("价格 5$ 起，含税")).toBe(false);
  });

  it("已知的可接受误判：同一行出现两个 $ 会走完整渲染器", () => {
    // 代价只是多下载一个 KaTeX chunk，渲染结果仍然正确；
    // 反过来漏判会让公式显示成原文，那个代价大得多，所以嗅探故意放宽。
    expect(needsRichMarkdown("对比 `$PATH` 和 5$ 的价格")).toBe(true);
  });

  it("行内公式、块级公式、mermaid 围栏走完整渲染器", () => {
    expect(needsRichMarkdown("能量公式 $E=mc^2$ 很重要")).toBe(true);
    expect(needsRichMarkdown("$$\\int_0^1 x^2 dx$$")).toBe(true);
    expect(needsRichMarkdown("```mermaid\ngraph TD;A-->B;\n```")).toBe(true);
    expect(needsRichMarkdown("~~~mermaid\ngraph TD;\n~~~")).toBe(true);
  });

  it("正则本身的行为", () => {
    expect(INLINE_MATH_RE.test("$E=mc^2$")).toBe(true);
    expect(INLINE_MATH_RE.test("$PATH")).toBe(false);
    expect(INLINE_MATH_RE.test("价格 5$ 起")).toBe(false);
    expect(MERMAID_FENCE_RE.test("```mermaid")).toBe(true);
    expect(MERMAID_FENCE_RE.test("``` mermaidx")).toBe(false);
  });
});

describe("性能：图片与首屏", () => {
  it("正文图片一律 lazy + async 解码", () => {
    const img = read("components/Markdown/img.tsx");
    expect(img).toContain('loading = "lazy"');
    expect(img).toContain('decoding = "async"');
  });

  it("封面图是 LCP 元素：高优先级 + 异步解码", () => {
    const cover = read("components/ArticleCover/index.tsx");
    expect(cover).toContain('fetchPriority="high"');
    expect(cover).toContain('decoding="async"');
  });

  it("ImageBox 保留 lazy 并加上异步解码，且不重复声明 loading", () => {
    const box = read("components/ImageBox/index.tsx");
    expect(box).toContain('decoding="async"');
    expect(box.match(/loading=\{/g)?.length).toBe(2); // 两处 <img>，各一个
  });

  it("访客统计延后到浏览器空闲，不和首屏抢主线程", () => {
    const app = read("pages/_app.tsx");
    expect(app).toContain("requestIdleCallback");
    expect(app.match(/idle\(\(\) => reloadViewer/g)?.length).toBe(2);
  });
});

describe("性能：构建配置", () => {
  it("关掉 X-Powered-By、SWC 压缩是 Next 14 默认、类型检查只认显式逃生口", () => {
    const cfg = read("next.config.js");
    expect(cfg).toContain("poweredByHeader: false");
    // Next 14 起 swcMinify 默认就是 true（Next 15 移除了该配置项），
    // 配置里**不应该再写** `swcMinify: true`——写了也只是复述默认值。
    // 压缩没被关掉的证据：没有出现 swcMinify: false。
    expect(cfg).not.toContain("swcMinify: false");
    expect(cfg).toContain("VANBLOG_SKIP_TYPECHECK");
    // 类型检查不许再挂在 isBuild=t 上（那会让官方镜像构建跳过 tsc）；
    // isBuild 只剩 api/*.ts 的「构建期连不上 server 用默认数据」兜底语义（§7.23）。
    const code = cfg
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/skipChecks[\s\S]*isBuild|isBuild[\s\S]*skipChecks/);
    expect(code).toContain(
      'process.env.VANBLOG_SKIP_TYPECHECK === "true"',
    );
    // images 的允许名单迁到了 remotePatterns（Next 14 弃用 domains），语义不变：
    // VAN_BLOG_ALLOW_DOMAINS 为空 ⇒ 生产只优化本站图片（空数组，不是放行所有）。
    expect(code).toContain("remotePatterns: getImageRemotePatterns()");
    expect(code).not.toMatch(/^\s*domains:/m);
  });

  it("next 已升到 14.x 且 react 仍是 18（Next 15 要 React 19，@bytemd 的 peer 只到 18）", () => {
    // 读**已安装**的 package.json，不是声明的范围
    const next = require("next/package.json");
    const react = require("react/package.json");
    expect(String(next.version)).toMatch(/^14\./);
    expect(String(react.version)).toMatch(/^18\./);
  });
});
