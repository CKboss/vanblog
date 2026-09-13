import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { getProcessor } from "bytemd";
import gfm from "@bytemd/plugin-gfm";
import { defListHastHandlers } from "remark-definition-list";
import { extraSyntax, mdastText, TOC_MARKER_RE } from "../components/Markdown/extraSyntax";
import { Heading } from "../components/Markdown/heading";
import { sanitizeMarkdownSchema } from "../utils/markdownSanitize";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** 与 MarkdownBase/MarkdownView 完全一致的管线，用来验证真实渲染结果 */
function render(md: string): string {
  return getProcessor({
    plugins: [gfm({ singleTilde: false }), extraSyntax(), Heading()],
    remarkRehype: { allowDangerousHtml: true, handlers: defListHastHandlers },
    sanitize: sanitizeMarkdownSchema,
  })
    .processSync(md)
    .toString();
}

describe("新增的 6 种 markdown 语法（前台渲染）", () => {
  it("==高亮== 渲染成 <mark>", () => {
    expect(render("正文 ==重点== 结束")).toContain("<mark>重点</mark>");
  });

  it("^上标^ 与 ~下标~ 渲染成 <sup> / <sub>，而 ~~删除线~~ 仍然可用", () => {
    const html = render("X^2^ 与 H~2~O 与 ~~旧~~");
    expect(html).toContain("X<sup>2</sup>");
    expect(html).toContain("H<sub>2</sub>O");
    expect(html).toContain("<del>旧</del>");
  });

  it(":emoji: 短代码转成真实字符（不认识的保持原样）", () => {
    const html = render(":smile: :+1: :不存在的名字:");
    expect(html).toContain("😄");
    expect(html).toContain("👍");
    expect(html).toContain(":不存在的名字:");
  });

  it("定义列表渲染成 dl/dt/dd（需要把官方 hast handler 传给 remark-rehype）", () => {
    const html = render("术语甲\n: 定义甲\n\n术语乙\n: 定义乙");
    expect(html).toContain("<dl>");
    expect(html).toContain("<dt>术语甲</dt>");
    expect(html).toContain("<dd>定义甲");
    // 不能被当成未知节点摊平成一堆 div
    expect(html).not.toContain("<div><div>术语甲</div>");
  });

  it("GitHub 提示块 > [!NOTE] 渲染成 markdown-alert（五种类型都要）", () => {
    for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
      const html = render(`> [!${kind}]\n> 内容`);
      expect(html).toContain(`markdown-alert-${kind.toLowerCase()}`);
      expect(html).toContain("markdown-alert-title");
      expect(html).not.toContain(`[!${kind}]`);
    }
  });

  it("普通引用不受提示块插件影响", () => {
    expect(render("> 只是引用")).toContain("<blockquote>");
  });

  it("[[toc]] 生成目录，锚点与标题 id 对得上", () => {
    const html = render("# 一级标题\n\n## 小节 A\n\n[[toc]]");
    expect(html).not.toContain("[[toc]]");
    // 标题 id 用的是原文（normalizeHeadingText），所以链接必须是编码后的同一段文字
    expect(html).toContain('id="一级标题"');
    expect(html).toContain(`href="#${encodeURIComponent("一级标题")}"`);
    expect(html).toContain(`href="#${encodeURIComponent("小节 A")}"`);
    // 嵌套列表
    expect(html.match(/<ul>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("[toc] 与大小写混写也算标记；正文里的 [[tocx]] 不算", () => {
    expect(TOC_MARKER_RE.test("[[toc]]")).toBe(true);
    expect(TOC_MARKER_RE.test(" [TOC] ")).toBe(true);
    expect(TOC_MARKER_RE.test("[toc]")).toBe(true);
    expect(TOC_MARKER_RE.test("[[tocx]]")).toBe(false);
    expect(render("[toc]")).not.toContain("[toc]");
    expect(render("正文里提到 [[tocx]] 时保留原样")).toContain("[[tocx]]");
  });

  it("没有标题时 [[toc]] 直接消失，不留空列表", () => {
    const html = render("只有正文\n\n[[toc]]");
    expect(html).not.toContain("[[toc]]");
    expect(html).not.toContain("<ul>");
  });

  it("mdastText 能拼出混合内容的标题文本", () => {
    expect(
      mdastText({
        type: "heading",
        depth: 2,
        children: [
          { type: "text", value: "标题 " },
          { type: "inlineCode", value: "code" },
          { type: "emphasis", children: [{ type: "text", value: " 斜体" }] },
        ],
      }),
    ).toBe("标题 code 斜体");
  });
});

describe("编辑器与前台必须完全一致", () => {
  const site = read("components/Markdown/extraSyntax.ts");
  const admin = read("../admin/src/components/Editor/plugins/extraSyntax.ts");

  it("两边挂的插件与顺序一致", () => {
    // 插件都带 `as any` 断言（bytemd 的 unified 类型不认「返回 transformer 的函数」）
    const chain = (src: string) =>
      (src.match(/\.use\(([A-Za-z]+)(?: as any)?\)/g) || [])
        .map((call) => call.replace(/\.use\(| as any\)|\)/g, ""))
        .join(" > ");
    expect(chain(admin)).toBe(chain(site));
    expect(chain(site)).toContain("remarkMark");
    expect(chain(site)).toContain("remarkSupersub");
    expect(chain(site)).toContain("remarkGemoji");
    expect(chain(site)).toContain("remarkDefinitionList");
    expect(chain(site)).toContain("remarkAlert");
    expect(chain(site)).toContain("remarkTocMarker");
  });

  it("两边都用 unified 10 世代的 data 字段名（写错会静默失效）", () => {
    // 只看代码行：注释里正好写了「不要用的那个名字」作为提醒
    const codeOnly = (src: string) =>
      src
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
    for (const src of [site, admin]) {
      expect(src).toContain('"fromMarkdownExtensions"');
      expect(src).toContain('"toMarkdownExtensions"');
      expect(codeOnly(src)).not.toContain("mdastUtilFromMarkdownExtensions");
    }
  });

  it("两边都关掉了 GFM 的单波浪删除线，并把 defList 的 hast handler 传给 remark-rehype", () => {
    for (const p of [
      "components/Markdown/MarkdownBase.tsx",
      "components/Markdown/MarkdownRich.tsx",
      "../admin/src/components/Editor/index.tsx",
    ]) {
      expect(read(p)).toContain("singleTilde: false");
    }
    expect(read("components/Markdown/MarkdownView.tsx")).toContain("handlers: defListHastHandlers");
    expect(read("../admin/src/components/Editor/index.tsx")).toContain("handlers: defListHastHandlers");
  });

  it("两边 sanitize 白名单都放行了 mark / dl / dt / dd", () => {
    for (const p of [
      "utils/markdownSanitize.ts",
      "../admin/src/components/Editor/markdownSanitize.ts",
    ]) {
      const src = read(p);
      const block = (src.match(/MARKDOWN_EXTRA_TAG_NAMES = \[([\s\S]*?)\] as const/) || ["", ""])[1];
      for (const tag of ["mark", "dl", "dt", "dd"]) {
        expect(block).toContain(tag);
      }
      // svg 故意不放行：提示块的图标改用 CSS ::before 补
      expect(block).not.toContain("svg");
    }
  });

  it("提示块样式两边都引了（官方 alert.css + 自己的补充样式）", () => {
    expect(read("pages/_app.tsx")).toContain("remark-github-blockquote-alert/alert.css");
    expect(read("pages/_app.tsx")).toContain("markdown-extra.css");
    expect(read("../admin/src/components/Editor/index.tsx")).toContain(
      "remark-github-blockquote-alert/alert.css",
    );
    expect(read("../admin/src/components/Editor/index.tsx")).toContain("markdown-extra.css");
  });
});
