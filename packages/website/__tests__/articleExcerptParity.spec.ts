import { describe, expect, it } from "vitest";
import {
  articleOverviewMarkdown as websiteExcerpt,
  findMoreMarker as websiteFindMoreMarker,
  DEFAULT_OVERVIEW_CHARS as WEBSITE_CHARS,
  MORE_MARKER as WEBSITE_MARKER,
} from "../utils/articleExcerpt";
import { firstImageOfMarkdown } from "../utils/firstImage";
// 跨包 import：server 的摘要实现（相对路径直接进 packages/server/src，vitest 会一并转译）。
// 这两个文件**必须**给出逐字符相同的结果：前台卡片对老缓存页仍会本地计算摘要，
// 而新列表页用 server 下发的 excerpt —— 同一段正文两边算得不一样，ISR 重渲染前后
// 卡片文字就会跳变。改动任何一边，这组向量都会红。
import {
  articleOverviewMarkdown as serverExcerpt,
  findMoreMarker as serverFindMoreMarker,
  DEFAULT_OVERVIEW_CHARS as SERVER_CHARS,
  MORE_MARKER as SERVER_MARKER,
} from "../../server/src/utils/articleExcerpt";
import { pickCoverFromContent } from "../../server/src/utils/coverFromContent";

/**
 * 共享向量：覆盖任务要求的 8 类输入（more 标记 / 代码块里的标记 / front matter /
 * 200 字回退 / 截断落在 [text](url) 中间(#410) / 截断落在代理对中间 / 空与 undefined / CJK），
 * 外加围栏与行内代码、图片、转义括号等边界。
 */
const VECTORS: Array<{ name: string; content: string; maxChars?: number }> = [
  { name: "有 <!-- more --> 标记", content: "摘要部分\n\n<!-- more -->\n\n后面的正文" },
  {
    name: "标记在反引号围栏代码块里不算",
    content: "教程开头\n\n```md\n<!-- more -->\n```\n\n真正的摘要<!-- more -->被吞掉的正文",
  },
  {
    name: "标记在波浪线围栏里不算",
    content: "~~~text\n<!-- more -->\n~~~\n\n外面<!-- more -->里面",
  },
  {
    name: "标记在行内代码里不算",
    content: "用 `<!-- more -->` 表示截断<!-- more -->真的截断",
  },
  {
    name: "未闭合围栏：标记失效，落到字数预算",
    content: "前面\n\n```\n<!-- more -->\n" + "x".repeat(300),
  },
  {
    name: "front matter 被剥掉",
    content: "---\ntitle: 测试\ntags: [a, b]\n---\n\n正文摘要<!-- more -->后面",
  },
  {
    name: "以分隔线开头的正文不是 front matter",
    content: "---\n\n# 大标题\n\n正文第一段\n\n---\n\n后半部分",
  },
  { name: "无标记走 200 字回退", content: "汉".repeat(250) },
  { name: "无标记且不足预算原样返回", content: "很短的正文，没有标记" },
  {
    name: "截断落在 [text](url) 中间（issue #410）",
    content: `[${"1".repeat(WEBSITE_CHARS - 10)}](https://example.com/a)`,
  },
  {
    name: "截断落在链接文字中间",
    content: `[链接${"字".repeat(150)}文字](https://example.com/long-path?q=1)后续`,
  },
  {
    name: "截断落在图片语法中间",
    content: `![图${"x".repeat(220)}](/static/img/a.webp)后面的文字`,
  },
  {
    name: "截断落在代理对（emoji）中间",
    content: "😀".repeat(99) + "a" + "😀".repeat(60),
  },
  {
    name: "emoji 后接长链接",
    content: "😀".repeat(120) + `[链接${"y".repeat(100)}](https://e.com)`,
  },
  { name: "空字符串", content: "" },
  { name: "CJK 正文按字符截断", content: "汉字测试，标点符号；全角！".repeat(30) },
  {
    name: "中英混排加标点",
    content: "这是 English 混排 with 中文，还有标点符号！".repeat(12),
  },
  { name: "自定义 maxChars", content: "abcdefg", maxChars: 3 },
  { name: "转义括号不算链接起点", content: "\\[" + "z".repeat(210) + "](u)" },
  {
    name: "引用式链接定义行 + 长正文",
    content: "[label]: https://e.com\n\n" + "正文".repeat(150),
  },
  {
    name: "带 title 的链接被截断",
    content: `[${"t".repeat(195)}](https://e.com "标题")尾巴`,
  },
];

describe("常量两边一致", () => {
  it("预算与标记字符串相同", () => {
    expect(SERVER_CHARS).toBe(WEBSITE_CHARS);
    expect(SERVER_MARKER).toBe(WEBSITE_MARKER);
    expect(SERVER_CHARS).toBe(200);
  });
});

describe("articleOverviewMarkdown 跨包 parity（同一输入 → 同一输出）", () => {
  for (const v of VECTORS) {
    it(`一致：${v.name}`, () => {
      const server = serverExcerpt(v.content, v.maxChars as any);
      const website = websiteExcerpt(v.content, v.maxChars as any);
      expect(server).toBe(website);
      // 顺带钉住 findMoreMarker 的位置判定也一致（摘要的截断点由它决定）
      expect(serverFindMoreMarker(v.content)).toBe(websiteFindMoreMarker(v.content));
    });
  }

  it("一致：undefined / null 原样返回", () => {
    expect(serverExcerpt(undefined as any)).toBe(websiteExcerpt(undefined as any));
    expect(serverExcerpt(null as any)).toBe(websiteExcerpt(null as any));
    expect(serverExcerpt(undefined as any)).toBeUndefined();
  });

  it("摘要不是全文：有标记的向量两边都截在标记前", () => {
    const v = VECTORS[0];
    expect(serverExcerpt(v.content)).toBe("摘要部分\n\n");
  });
});

/**
 * 首图 parity：server 的 `pickCoverFromContent(content, {preferLocal:false})`
 * （列表接口 firstImage 字段的来源）必须与前台 `firstImageOfMarkdown` 一致 ——
 * 不一致时开了 withExcerpt 的卡片会换图（甚至丢图），肉眼可见。
 * preferLocal 必须关：前台取「文档顺序第一张可用图」，不按本站图床优先。
 */
const IMAGE_VECTORS: Array<{ name: string; content: string }> = [
  { name: "markdown 图片取第一张", content: "前 ![图](/static/img/a.webp) 后 ![图2](/static/img/b.webp)" },
  { name: "内联 HTML img", content: '<p><img src="/static/img/h.webp" alt="x"></p>' },
  {
    name: "markdown 与 html 混排取文档顺序最靠前的",
    content: '<img src="https://e.com/first.png">\n\n![l](/static/img/second.webp)',
  },
  {
    name: "代码块里的示例图不算",
    content: "```md\n![示例](/static/img/decoy.webp)\n```\n\n![真图](/static/img/real.webp)",
  },
  {
    name: "行内代码里的图不算",
    content: "用 `![x](/static/img/code.webp)` 表示\n\n![真图](/static/img/real2.webp)",
  },
  { name: "data: URI 不要", content: "![a](data:image/png;base64,AAAA)" },
  { name: "相对路径不要，继续找下一张", content: "![a](images/rel.png) ![b](/static/img/ok.webp)" },
  { name: "尖括号目的地", content: "![a](</static/img/angle.webp>)" },
  { name: "带 title 的图片", content: '![a](/static/img/t.webp "标题")' },
  { name: "协议相对地址", content: "![a](//cdn.example.com/p.webp)" },
  { name: "没有图", content: "纯文字，没有图片" },
  { name: "空内容", content: "" },
  {
    name: "外链在前就取外链（preferLocal 关闭时按文档顺序）",
    content: "![a](https://e.com/x.png) 中间 ![b](/static/img/y.webp)",
  },
];

describe("列表首图跨包 parity（server firstImage vs 前台 firstImageOfMarkdown）", () => {
  for (const v of IMAGE_VECTORS) {
    it(`一致：${v.name}`, () => {
      const server = pickCoverFromContent(v.content, { preferLocal: false });
      const website = firstImageOfMarkdown(v.content);
      expect(server).toBe(website);
    });
  }

  it("null / undefined 内容两边都不给图", () => {
    expect(pickCoverFromContent(undefined, { preferLocal: false })).toBe(
      firstImageOfMarkdown(undefined)
    );
    expect(pickCoverFromContent(null, { preferLocal: false })).toBeNull();
  });
});
