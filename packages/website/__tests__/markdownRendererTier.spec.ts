import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { FENCED_CODE_RE, hasFencedCode } from "../utils/hasFencedCode";
import { needsRichMarkdown } from "../components/Markdown";

/**
 * 三档渲染器：Plain（无高亮）/ Base（有 highlight.js）/ Rich（+ KaTeX / mermaid）。
 *
 * 为什么要加第三档：`@bytemd/plugin-highlight-ssr` → `rehype-highlight` → `lowlight`
 * → `highlight.js/lib/common`（约 35 种语言）+ 本站额外注册的 armasm / x86asm，
 * 在生产构建里是一个 **222,215 B 原始 / 65,890 B gzip** 的独立 chunk；
 * 而 `dynamic(..., { ssr: true })` 会把它写进页面的**初始 script 列表**（一点都不 defer）。
 * 首页、`/link`、`/page/n` 以前每个访客都要下载它，而列表摘要只有 200 字。
 *
 * ⚠️ Next 13 的 "First Load JS" 表**不包含**这些 ssr:true 的 dynamic chunk
 * （实测 `/` 那一栏在去掉 highlight.js 前后都是 292 kB 不变），
 * 所以别拿那张表当首屏体积的依据 —— 要看 `.next/server/pages/*.html` 里真实的
 * `<script src>` 列表。
 */
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("hasFencedCode（决定要不要下载 highlight.js）", () => {
  it("``` 与 ~~~ 围栏都认，带不带语言都认", () => {
    expect(hasFencedCode("```js\nconst a=1;\n```")).toBe(true);
    expect(hasFencedCode("```\nplain\n```")).toBe(true);
    expect(hasFencedCode("~~~py\nprint(1)\n~~~")).toBe(true);
    expect(hasFencedCode("前面有文字\n\n```sh\nls\n```")).toBe(true);
    expect(hasFencedCode("   ```js\nindented fence\n```")).toBe(true);
  });

  it("没有围栏的一律 false（列表摘要绝大多数走这条）", () => {
    expect(hasFencedCode("")).toBe(false);
    expect(hasFencedCode("纯文字摘要，没有任何代码")).toBe(false);
    // 行内代码不算：它不需要 highlight.js
    expect(hasFencedCode("点击 `阅读全文` 并输入密码后方可查看。")).toBe(false);
    expect(hasFencedCode("行内 `code` 与 ~~删除线~~ 和 $E=mc^2$")).toBe(false);
    // 缩进代码块（4 空格）没有 language-* 类，rehype-highlight 本来也不会高亮它
    expect(hasFencedCode("    const a = 1;\n")).toBe(false);
    expect(hasFencedCode(null)).toBe(false);
    expect(hasFencedCode(undefined)).toBe(false);
  });

  it("宁可误判也不能漏判：被截断的围栏（只有开头）也算有", () => {
    // server 的 withExcerpt 按 200 字截断，摘要可能停在代码块中间
    expect(hasFencedCode("开头\n\n```python\nimport os\n")).toBe(true);
    expect(FENCED_CODE_RE.test("```")).toBe(true);
    expect(FENCED_CODE_RE.test("``")).toBe(false);
    expect(FENCED_CODE_RE.test("正文里的 ``` 反引号")).toBe(false);
  });

  it("与 rich 嗅探互不干扰（有公式/流程图时优先 Rich，Rich 自带高亮）", () => {
    expect(needsRichMarkdown("$E=mc^2$")).toBe(true);
    expect(hasFencedCode("$E=mc^2$")).toBe(false);
    expect(needsRichMarkdown("```js\nx\n```")).toBe(false);
    expect(hasFencedCode("```js\nx\n```")).toBe(true);
  });
});

describe("三档渲染器的接线", () => {
  it("MarkdownPlain 不含 highlight / KaTeX / mermaid，但其它插件与 Base 完全一致", () => {
    const plain = strip(read("components/Markdown/MarkdownPlain.tsx"));
    const base = strip(read("components/Markdown/MarkdownBase.tsx"));
    expect(plain).not.toContain("highlightSsr");
    expect(plain).not.toContain("plugin-highlight");
    expect(plain).not.toContain("katex");
    expect(plain).not.toContain("plugin-math");
    expect(plain).not.toContain("mermaid");
    // 除高亮之外的插件一个都不能少（否则摘要的容器/图片/链接渲染会变）
    for (const dep of [
      "rawHTML()",
      "gfm({ singleTilde: false })",
      "extraSyntax()",
      "customContainer()",
      "customCodeBlock()",
      "LinkTarget()",
      "Heading()",
      "Img()",
    ]) {
      expect(plain).toContain(dep);
      expect(base).toContain(dep);
    }
    // 插件顺序也要一致：base 只比 plain 多一个 highlightSsr
    const order = (src: string) =>
      [
        "rawHTML()",
        "gfm({ singleTilde: false })",
        "extraSyntax()",
        "highlightSsr()",
        "customContainer()",
        "customCodeBlock()",
        "LinkTarget()",
        "Heading()",
        "Img()",
      ].filter((d) => src.includes(d));
    expect(order(plain)).toEqual(order(base).filter((d) => d !== "highlightSsr()"));
  });

  it("Markdown 入口按 公式/流程图 → 围栏 → 都没有 三档挑渲染器", () => {
    const index = strip(read("components/Markdown/index.tsx"));
    expect(index).toContain('dynamic(() => import("./MarkdownPlain")');
    expect(index).toContain('dynamic(() => import("./MarkdownBase")');
    expect(index).toContain('dynamic(() => import("./MarkdownRich")');
    expect(index).toContain("needsRichMarkdown(props.content)");
    expect(index).toContain("hasFencedCode(props.content)");
    // 入口自己不能静态引重依赖
    expect(index).not.toContain("@bytemd/plugin-math-ssr");
    expect(index).not.toContain("highlightSsr");
  });

  it("PostCard 默认用 Plain，摘要里真有围栏才用 Base", () => {
    const card = strip(read("components/PostCard/index.tsx"));
    expect(card).toContain('dynamic(() => import("../Markdown/MarkdownPlain")');
    expect(card).toContain('dynamic(() => import("../Markdown/MarkdownBase")');
    expect(card).toContain(
      "hasFencedCode(calContent) ? OverviewCodeMarkdown : OverviewMarkdown"
    );
    // 仍然不许 import 完整入口（那会把 KaTeX 算进列表页首屏）
    expect(card).not.toContain('import("../Markdown")');
    expect(card).not.toMatch(/^import Markdown from "\.\.\/Markdown/m);
  });
});
