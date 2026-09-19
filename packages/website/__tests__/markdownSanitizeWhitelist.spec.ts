import { describe, expect, it } from "vitest";
import { getProcessor } from "bytemd";
import gfm from "@bytemd/plugin-gfm";
import rawHTML from "../components/Markdown/rawHTML";
import { LinkTarget } from "../components/Markdown/linkTarget";
import { Heading } from "../components/Markdown/heading";
import {
  MARKDOWN_FORBIDDEN_TAG_NAMES,
  MARKDOWN_STYLE_ALLOWED_TAG_NAMES,
  findUrlAttributesMissingProtocols,
  sanitizeMarkdownSchema,
} from "../utils/markdownSanitize";

/**
 * 正文 HTML 白名单收紧的回归钉子。
 *
 * ⚠️ 这里的断言**全部是行为级**的（真的跑一遍 bytemd 管线看输出 HTML），不是 grep 源码：
 * "源码里出现了某符号"是空断言（一行 import 就能让它通过），本仓库已经为此吃过亏。
 * 另外用 `capturedSchema` 直接断言 bytemd 传进来的**真实** schema 对象，
 * 而不是手搓一个 fixture —— fixture 会与库的默认值漂移，漂移之后测试就只是在测 fixture。
 *
 * 被收紧的三件事（都有实测依据，见 markdownSanitize.ts 的注释）：
 *  1. `src` 不再挂在全局 `*` 上（以前每个被放行的标签都能带 src）；
 *  2. `iframe` 的 src 只接受 http(s) 与协议相对写法 ⇒ `data:text/html` 的 iframe 被摘掉 src；
 *  3. 内联 `style` 只给排版类标签，`a` / `input` / `button` 不给。
 * ⚠️ 最重要的一条是**别把合法用法弄坏**：`https://` 与 `//` 的 iframe、`data:` 的 img、
 *    `<font style="color:…">`（本机 59 篇生产文章里 64 处的真实形状）都必须原样保留。
 */

function render(markdown: string) {
  let captured: any = null;
  const html = getProcessor({
    plugins: [rawHTML(), gfm(), LinkTarget(), Heading()],
    remarkRehype: { allowDangerousHtml: true },
    // 包一层，把 bytemd 真正传进来的 schema 抓出来做结构断言
    sanitize: (schema: any) => {
      captured = sanitizeMarkdownSchema(schema);
      return captured;
    },
  })
    .processSync(markdown)
    .toString();
  return { html, schema: captured };
}

/** 属性条目可能是 "style"，也可能是 ["src", /regex/]。 */
const nameOf = (entry: unknown) => (Array.isArray(entry) ? entry[0] : entry);
const entriesFor = (schema: any, tag: string): unknown[] =>
  (schema?.attributes?.[tag] || []) as unknown[];
const valueListFor = (schema: any, tag: string, prop: string): unknown[] => {
  const hit = entriesFor(schema, tag).find((e) => nameOf(e) === prop);
  return Array.isArray(hit) ? hit.slice(1) : [];
};

describe("正文白名单：data: 只留给 img，iframe 只准 http(s)", () => {
  it("保留 data: 的内联图片（既有文章可能这么写，不能弄坏）", () => {
    const { html } = render(
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="inline">',
    );
    expect(html).toMatch(/<img[^>]*src="data:image\/png;base64,iVBORw0KGgoAAAANSUhEUg=="/);
    expect(html).toContain('alt="inline"');
  });

  it("摘掉 data: 的 iframe src（元素保留，src 没了 ⇒ 内嵌不了第三方文档）", () => {
    const payload =
      '<iframe src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></iframe>';
    const { html } = render(payload);
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg");
    expect(html).not.toMatch(/<iframe[^>]*\ssrc=/i);
  });

  it("保留 https:// 的 iframe 与 allowfullscreen（B 站/YouTube 嵌入是合法用法）", () => {
    const { html } = render(
      '<iframe src="https://player.bilibili.com/player.html?bvid=1" allowfullscreen></iframe>',
    );
    expect(html).toMatch(
      /<iframe[^>]*src="https:\/\/player\.bilibili\.com\/player\.html\?bvid=1"/,
    );
    expect(html).toMatch(/allowfullscreen/);
  });

  it("保留协议相对写法 //host/… 的 iframe（常见嵌入写法，只认 ^https?:// 会弄坏它）", () => {
    const { html } = render('<iframe src="//player.bilibili.com/player.html"></iframe>');
    expect(html).toMatch(/<iframe[^>]*src="\/\/player\.bilibili\.com\/player\.html"/);
  });

  it("保留 http:// 的 iframe（老文章里还有明文嵌入）", () => {
    const { html } = render('<iframe src="http://example.com/embed"></iframe>');
    expect(html).toMatch(/<iframe[^>]*src="http:\/\/example\.com\/embed"/);
  });

  it("仍然拒绝 javascript: 的 src 与 href", () => {
    const { html } = render(
      [
        '<img src="javascript:alert(1)" alt="x">',
        "",
        '<a href="javascript:alert(2)">click</a>',
        "",
        '<iframe src="javascript:alert(3)"></iframe>',
      ].join("\n"),
    );
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/alert\(/);
  });

  it("src 不再发给所有标签：section / font / button 上的 src 被摘掉", () => {
    const { html } = render(
      [
        '<section src="https://example.com/a.js">s</section>',
        "",
        '<font src="https://example.com/b.js">f</font>',
        "",
        '<button type="button" src="https://example.com/c.js">b</button>',
      ].join("\n"),
    );
    expect(html).not.toMatch(/<(section|font|button)[^>]*\ssrc=/i);
    // 元素与文本本身保留（只摘属性，不删内容）
    expect(html).toContain(">s<");
    expect(html).toContain(">f<");
    expect(html).toContain(">b<");
  });

  it("img 的 https src 与内联 style 都保留（最常见的正文图片写法）", () => {
    const { html } = render(
      '<img src="https://example.com/a.png" alt="a" style="width:100%">',
    );
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/a\.png"/);
    expect(html).toMatch(/style="width:100%"/);
  });
});

describe("正文白名单：内联 style 只给排版类标签", () => {
  it("保留真实文章里的两种形状：<font style=color> 与 <div style=text-align>", () => {
    // 这两条就是本机 59 篇生产文章里 style= 的全部实际用法（font 64 次 / div 1 次）
    const { html } = render(
      [
        '<font style="color: #ff0000">红字</font>',
        "",
        '<div style="text-align: center">居中</div>',
        "",
        '<span style="color: blue">blue</span>',
      ].join("\n"),
    );
    expect(html).toMatch(/<font[^>]*style="color: #ff0000"[^>]*>红字<\/font>/);
    expect(html).toMatch(/<div[^>]*style="text-align: center"[^>]*>居中<\/div>/);
    expect(html).toMatch(/<span[^>]*style="color: blue"[^>]*>blue<\/span>/);
  });

  it("不给 <a> 内联 style（`<a style=position:fixed;inset:0>` 是覆盖整页诱导点击的最短路径）", () => {
    const { html } = render(
      '<a href="https://example.com" style="position:fixed;inset:0;z-index:9999">cover</a>',
    );
    expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"/); // 链接本身保留
    expect(html).not.toMatch(/<a[^>]*style=/i);
    expect(html).not.toMatch(/position:fixed/);
  });

  it("不给 <input> / <button> 内联 style，但保留它们的功能属性", () => {
    const { html } = render(
      [
        '<input type="checkbox" disabled style="position:fixed">',
        "",
        '<button type="button" style="position:fixed" disabled>copy</button>',
      ].join("\n"),
    );
    expect(html).not.toMatch(/<(input|button)[^>]*style=/i);
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain("disabled");
  });

  it("白名单本身是「排版类标签」，且明确不含 a / input / button", () => {
    const list = MARKDOWN_STYLE_ALLOWED_TAG_NAMES as readonly string[];
    for (const t of ["p", "div", "span", "font", "table", "td", "img", "iframe", "h1", "li"]) {
      expect(list).toContain(t);
    }
    for (const t of ["a", "input", "button", "script", "style", "form", "link", "meta"]) {
      expect(list).not.toContain(t);
    }
  });
});

describe("正文白名单：既有防线一条都没松", () => {
  it("仍然剥掉事件处理器（img onerror / iframe onload / a onclick）", () => {
    const { html } = render(
      [
        '<img src="https://example.com/a.png" onerror="alert(1)" alt="x">',
        "",
        '<iframe src="https://example.com/e" onload="alert(2)"></iframe>',
        "",
        '<a href="https://example.com" onclick="alert(3)">c</a>',
      ].join("\n"),
    );
    expect(html).not.toMatch(/\son(error|load|click)\s*=/i);
    expect(html).not.toMatch(/alert\(/);
  });

  it("仍然整段 strip 掉 <script>（连内容一起）", () => {
    const { html } = render("before <script>alert(1)</script> after");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("<style> 整段被 strip（元素与 CSS 文本都不留），正文文本不受影响", () => {
    // ⚠️ 光"不在 tagNames 里"不够：那样元素被丢掉但**子节点保留**，
    //    CSS 会当成可见文本渲染出来（`body{display:none}` 直接印在文章里）。
    const { html } = render("before <style>body{display:none}</style> after");
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toContain("display:none");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("MARKDOWN_FORBIDDEN_TAG_NAMES 同时含 script 与 style（strip 的依据）", () => {
    expect([...MARKDOWN_FORBIDDEN_TAG_NAMES]).toEqual(["script", "style"]);
  });
});

describe("schema 结构（断言 bytemd 传进来的真实 schema，不是手搓 fixture）", () => {
  const { schema } = render("probe");

  it("attributes['*'] 里既没有 src 也没有 style", () => {
    const star = entriesFor(schema, "*").map(nameOf);
    expect(star).not.toContain("src");
    expect(star).not.toContain("style");
  });

  it("img 仍然有 src（否则 data: 内联图片就废了），iframe 的 src 带值白名单", () => {
    expect(entriesFor(schema, "img").map(nameOf)).toContain("src");
    const iframeSrcValues = valueListFor(schema, "iframe", "src");
    expect(iframeSrcValues.length).toBeGreaterThan(0);
    const re = iframeSrcValues.find(
      (v) => v && typeof v === "object" && "flags" in (v as any),
    ) as RegExp | undefined;
    expect(re).toBeInstanceOf(RegExp);
    // 值白名单的语义（库用 allowed.test(value)）
    expect(re!.test("https://player.bilibili.com/x")).toBe(true);
    expect(re!.test("http://example.com/x")).toBe(true);
    expect(re!.test("//player.bilibili.com/x")).toBe(true);
    expect(re!.test("data:text/html;base64,AAA")).toBe(false);
    expect(re!.test("javascript:alert(1)")).toBe(false);
    expect(re!.test("blob:https://example.com/x")).toBe(false);
  });

  it("iframe 的展示属性从全局收回到了 iframe 自己身上，且用的是 hast 的驼峰属性名", () => {
    const iframe = entriesFor(schema, "iframe").map(nameOf);
    // ⚠️ 必须是 hast 属性名（allowFullScreen / frameBorder）：小写写法 rehype-sanitize 匹配不到，
    //    本文件以前就是小写的 ⇒ allowfullscreen 一直被摘掉（嵌入视频没有全屏按钮）。
    for (const a of ["allowFullScreen", "frameBorder", "framespacing", "scrolling"]) {
      expect(iframe).toContain(a);
      expect(entriesFor(schema, "*").map(nameOf)).not.toContain(a);
    }
    // 反证：小写的那两个确实不在（否则说明又退回了不生效的写法）
    expect(iframe).not.toContain("allowfullscreen");
    expect(iframe).not.toContain("frameborder");
  });

  it("iframe 的 frameborder / scrolling 也真的留得下来（不只是 allowfullscreen）", () => {
    const { html } = render(
      '<iframe src="https://example.com/e" frameborder="0" scrolling="no"></iframe>',
    );
    expect(html).toMatch(/<iframe[^>]*src="https:\/\/example\.com\/e"/);
    expect(html).toMatch(/frameborder="0"/i);
    expect(html).toMatch(/scrolling="no"/i);
  });

  it("a / input / button 上没有 style", () => {
    for (const tag of ["a", "input", "button"]) {
      expect(entriesFor(schema, tag).map(nameOf)).not.toContain("style");
    }
  });

  it("⚠️ protocols.src 非空且仍含 http/https/data —— 空表在库里等于「放行一切」", () => {
    // hast-util-sanitize 的 safeProtocol() 在 protocols.length === 0 时直接 return true，
    // 也就是**连 javascript: 都放行**。所以这个数组只能收窄，绝不能被删空。
    const src = schema?.protocols?.src as string[];
    expect(Array.isArray(src)).toBe(true);
    expect(src.length).toBeGreaterThan(0);
    expect(src).toContain("http");
    expect(src).toContain("https");
    expect(src).toContain("data");
    expect(src).not.toContain("javascript");
    const href = schema?.protocols?.href as string[];
    expect(href.length).toBeGreaterThan(0);
    expect(href).not.toContain("data");
    expect(href).not.toContain("javascript");
  });

  it("幂等：同一个 schema 对象处理两次不会堆出重复条目", () => {
    const once = sanitizeMarkdownSchema(schema);
    const twice = sanitizeMarkdownSchema(once);
    expect((twice.protocols.src as string[]).filter((p) => p === "data")).toHaveLength(1);
    const srcEntries = entriesFor(twice, "iframe").filter((e) => nameOf(e) === "src");
    expect(srcEntries).toHaveLength(1);
    const styleEntries = entriesFor(twice, "span").filter((e) => nameOf(e) === "style");
    expect(styleEntries).toHaveLength(1);
  });
});

/**
 * ⚠️ `sanitizeMarkdownSchema` 是**就地修改并返回同一个对象**的（bytemd 的契约如此），
 * 所以每个用例都要用新建的 fixture，不能复用同一个对象。
 */
function makeFutureSchema() {
  return {
    strip: [] as string[],
    clobberPrefix: "user-content-",
    tagNames: ["img", "p"],
    protocols: { src: ["http", "https"], href: ["http", "https"] } as Record<string, string[]>,
    attributes: { img: ["src"], "*": ["srcset"] } as Record<string, unknown[]>,
  };
}

describe("漂移守卫：放行了 URL 类属性，就必须有非空的协议白名单", () => {
  const { schema } = render("probe");

  it("当前 schema 里没有「放行了却没配协议」的 URL 属性", () => {
    expect(findUrlAttributesMissingProtocols(schema)).toEqual([]);
  });

  it("img 的 longDesc 正是那个潜在洞：默认 schema 放行它，protocols 里却没有它", () => {
    // 默认 GitHub schema 的 attributes.img = ["src","longDesc"]，protocols 只有 href/src/cite。
    // safeProtocol() 对"表里没有的属性"是放行一切 ⇒ longdesc="javascript:…" 本来能过。
    // 浏览器早就不导航 longdesc 了，所以今天打不开；但这是"放行属性时顺手开的洞"，已补上。
    expect(entriesFor(schema, "img").map(nameOf)).toContain("longDesc");
    const list = schema.protocols.longDesc as string[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list).toEqual(expect.arrayContaining(["http", "https"]));
  });

  it("已有的协议表不被覆盖（href 的 mailto 等必须留着）", () => {
    expect(schema.protocols.href).toContain("mailto");
    expect(schema.protocols.href).toContain("https");
  });

  it("反证：删掉一个协议表、或把它清空，守卫都要报出来（空数组与不存在同样危险）", () => {
    const deleted = { ...schema, protocols: { ...schema.protocols } };
    delete deleted.protocols.src;
    expect(findUrlAttributesMissingProtocols(deleted)).toContain("src");

    const emptied = { ...schema, protocols: { ...schema.protocols, href: [] } };
    expect(findUrlAttributesMissingProtocols(emptied)).toContain("href");
  });

  it("反证：守卫不是空的 —— 最小 schema 上它能精确指出缺哪个", () => {
    expect(findUrlAttributesMissingProtocols({ attributes: { img: ["src"] }, protocols: {} })).toEqual([
      "src",
    ]);
    expect(
      findUrlAttributesMissingProtocols({ attributes: { img: ["src"] }, protocols: { src: ["http"] } }),
    ).toEqual([]);
  });

  it("通用性：将来有人放行 srcset，协议表会被自动补上（不是钉死今天的属性清单）", () => {
    // 先看未处理的形状确实是有洞的（否则这条断言证明不了什么）
    expect(findUrlAttributesMissingProtocols(makeFutureSchema() as any)).toContain("srcset");
    // 再过一遍 sanitize：洞被自动补掉
    const out = sanitizeMarkdownSchema(makeFutureSchema());
    expect(Array.isArray(out.protocols.srcset)).toBe(true);
    expect((out.protocols.srcset as string[]).length).toBeGreaterThan(0);
    expect(findUrlAttributesMissingProtocols(out)).toEqual([]);
  });
});
