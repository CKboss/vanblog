import { describe, it, expect, beforeAll } from "vitest";
import { parseNavStructure } from "../components/MarkdownTocBar/tools";
import {
  ensureTocMathLoaded,
  renderTocLabelHtml,
  tocLabelNeedsMath,
} from "../components/MarkdownTocBar/tocMath";

const COMPARE_MD = "## 比较 $A$<$B$\n\nbody\n";
const MIXED_MD =
  "## 由方程 $F(x,y)=0$ 确定的隐函数 $y=y(x)$\n\nbody\n";
const FRAC_MD = "## 偏导数 $\\frac{\\partial z}{\\partial x}$\n\nbody\n";
const DISPLAY_MD = "## Display $$E=mc^2$$\n\nbody\n";
const PLAIN_MD = "## Clean Title\n\nhello\n";
const NESTED_MD = `# 递归

## 顺序查找(线性查找)

# 排序

  ## 选择排序
`;

function visibleLabelWithoutKatex(html: string): string {
  return html
    .replace(/<span class="katex-mathml"[\s\S]*?<\/span>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x3C;/gi, "<")
    .trim();
}

describe("public TOC math labels (#264)", () => {
  // KaTeX 现在是按需 import 的，测试里先等它加载完
  beforeAll(async () => {
    await ensureTocMathLoaded();
  });

  it("keeps source $A$<$B$ on NavItem.text and renders KaTeX in the visible label", () => {
    const items = parseNavStructure(COMPARE_MD);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("比较 $A$<$B$");
    expect(items[0].text).toContain("$A$");
    expect(items[0].text).toContain("$B$");
    expect(tocLabelNeedsMath(items[0].text)).toBe(true);

    const html = renderTocLabelHtml(items[0].text);
    expect(html).toMatch(/class="katex"/);
    expect(html).toContain('class="katex"');
    expect((html.match(/class="katex"/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("$A$");
    expect(html).not.toContain("$B$");
    expect(visibleLabelWithoutKatex(html)).not.toMatch(/\$A\$/);
    expect(visibleLabelWithoutKatex(html)).not.toContain("$");
    expect(visibleLabelWithoutKatex(html)).toMatch(/A/);
    expect(visibleLabelWithoutKatex(html)).toMatch(/B/);
  });

  it("renders mixed prose plus multiple inline formulas", () => {
    const items = parseNavStructure(MIXED_MD);
    expect(items[0].text).toBe("由方程 $F(x,y)=0$ 确定的隐函数 $y=y(x)$");
    const html = renderTocLabelHtml(items[0].text);
    expect(html).toMatch(/class="katex"/);
    expect(html).toContain("由方程");
    expect(html).toContain("确定的隐函数");
    expect(html).not.toContain("$F(x,y)=0$");
    expect(html).not.toContain("$y=y(x)$");
  });

  it("renders TeX commands such as \\\\frac in the TOC label", () => {
    const items = parseNavStructure(FRAC_MD);
    expect(items[0].text).toContain("$\\frac{\\partial z}{\\partial x}$");
    const html = renderTocLabelHtml(items[0].text);
    expect(html).toMatch(/class="katex"/);
    expect(html).not.toContain("$\\frac");
  });

  it("renders $$display$$ math in a heading label when present", () => {
    const items = parseNavStructure(DISPLAY_MD);
    expect(items[0].text).toContain("$$E=mc^2$$");
    const html = renderTocLabelHtml(items[0].text);
    expect(html).toMatch(/class="katex"/);
    expect(html).not.toContain("$$E=mc^2$$");
  });

  it("leaves headings without math unchanged", () => {
    const items = parseNavStructure(PLAIN_MD);
    expect(items[0].text).toBe("Clean Title");
    expect(tocLabelNeedsMath(items[0].text)).toBe(false);
    // ⚠️ 这条以前断言 `toBe("Clean Title")`，也就是把"原样返回未转义标题文本"钉成了契约。
    // 那个契约本身就是漏洞：消费点 `core.tsx:190-191` 会把非 null 的返回值塞进
    // `dangerouslySetInnerHTML`，而标题文本是**已解码**的（`utils/headingText.ts`），
    // 里面可以有被 markdown 转义过的 `<img onerror=…>` ⇒ sanitize 之后又被当 HTML 二次注入（mXSS）。
    // 现在返回 null，消费点走"把 each.text 当 React 子节点渲染"的安全分支（`:193`），
    // 用户看到的仍然是 `Clean Title`（React 会转义），可见行为一字未变。
    // 详见 __tests__/tocMathXss.spec.ts。
    expect(renderTocLabelHtml(items[0].text)).toBeNull();
  });

  it("keeps nested TOC completeness for plain headings", () => {
    const toc = parseNavStructure(NESTED_MD);
    expect(toc.map((item) => `${item.level}:${item.text}`)).toEqual([
      "1:递归",
      "2:顺序查找(线性查找)",
      "1:排序",
      "2:选择排序",
    ]);
  });
});
