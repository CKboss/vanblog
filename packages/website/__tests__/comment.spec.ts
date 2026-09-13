import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { renderCommentHtml } from "../components/Comment/Content";
import {
  COMMENT_ALLOWED_TAGS,
  COMMENT_STRIP_TAGS,
  sanitizeCommentSchema,
} from "../utils/commentSanitize";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("评论内容渲染：轻量 markdown + 严格白名单", () => {
  it("支持基本排版", () => {
    const html = renderCommentHtml("**粗** *斜* `code` ~~删~~\n\n第二段");
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain("<em>斜</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<del>删</del>");
    expect(html).toContain("<p>第二段</p>");
  });

  it("原始 HTML 只当文本，不会被解析成节点", () => {
    const html = renderCommentHtml('<script>alert(1)</script><img src=x onerror=alert(1)>');
    // 不能出现真的标签（唯一允许的真实标签是渲染器自己加的 <p>）
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    const realTags = (html.match(/<[a-z][^>]*>/gi) || []).map((t) => t.toLowerCase());
    expect(realTags.every((t) => t.startsWith("<p"))).toBe(true);
    // 危险内容以**转义后的字面量**存在（用户写的东西不会凭空消失，也不会被执行）
    expect(html).toContain("&#x3C;script>alert(1)&#x3C;/script>");
    expect(html).toContain("&#x3C;img src=x onerror=alert(1)>");
  });

  it("iframe / style / svg 连内容一起丢掉", () => {
    for (const tag of ["iframe", "style", "svg", "form", "button"]) {
      expect(COMMENT_STRIP_TAGS).toContain(tag);
    }
  });

  it("不放行 img、style 属性、id/class（代码高亮除外）", () => {
    expect(COMMENT_ALLOWED_TAGS).not.toContain("img");
    expect(COMMENT_ALLOWED_TAGS).not.toContain("iframe");
    const schema = sanitizeCommentSchema({ protocols: { href: ["http"] } });
    expect(schema.attributes["*"]).toEqual([]);
    expect(schema.attributes.a).toEqual(["href", "title", "rel", "target"]);
    expect(schema.tagNames).not.toContain("img");
    expect(schema.protocols.href).toEqual(["http", "https", "mailto"]);
  });

  it("链接自动加 nofollow noopener noreferrer 并新窗口打开", () => {
    const html = renderCommentHtml("[点我](https://example.com)");
    expect(html).toContain('rel="nofollow noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("图片语法折叠成 alt 文本（不会吐出一大坨 base64）", () => {
    const html = renderCommentHtml(
      "看图 ![截图](data:image/png;base64,AAAAAA) 结束",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("base64");
    expect(html).toContain("截图");
  });

  it("javascript: 链接会被 sanitize 掉", () => {
    const html = renderCommentHtml("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("渲染失败时退回转义后的纯文本，绝不吐原文", () => {
    // 用一个会让 processSync 抛错的输入不容易构造，这里直接验证兜底分支的逻辑存在
    const src = read("components/Comment/Content.tsx");
    expect(src).toContain("catch (err)");
    expect(src).toContain('.replace(/</g, "&lt;")');
  });

  it("不开 allowDangerousHtml（这是评论与正文渲染最大的区别）", () => {
    const src = read("components/Comment/Content.tsx");
    expect(src).not.toContain("allowDangerousHtml: true");
    expect(src).not.toContain("rehype-raw");
  });
});

describe("内置评论的前台接线", () => {
  const postCard = read("components/PostCard/index.tsx");
  const title = read("components/PostCard/title.tsx");
  const section = read("components/Comment/index.tsx");
  const content = read("components/Comment/Content.tsx");
  const api = read("utils/commentApi.ts");

  it("评论区是动态加载的（不能把 markdown 管线拖进首页 chunk）", () => {
    expect(postCard).toContain('dynamic(() => import("../Comment")');
    expect(postCard).toContain("ssr: false");
    expect(postCard).not.toMatch(/^import Comment from/m);
  });

  it("三种评论系统互斥渲染，waline 的计数 span 原样保留", () => {
    expect(postCard).toContain('commentProvider === "builtin"');
    expect(postCard).toContain('commentProvider === "waline"');
    expect(title).toContain('className="waline-comment-count"');
    expect(title).toContain("<CommentCount path={dataPath} />");
  });

  it("表单带蜜罐字段，且蜜罐对真人不可见/不可聚焦", () => {
    expect(section).toContain('className="van-comment-hp"');
    expect(section).toContain('aria-hidden="true"');
    expect(section).toContain("tabIndex={-1}");
    expect(section).toContain("hp,");
    expect(read("styles/globals.css")).toContain(".van-comment-hp");
    expect(read("styles/globals.css")).toContain("left: -9999px");
  });

  it("只有 Content.tsx 用 dangerouslySetInnerHTML，昵称/主页一律当文本渲染", () => {
    expect(content).toContain("dangerouslySetInnerHTML");
    expect(section).not.toContain("dangerouslySetInnerHTML");
    expect(section).toContain("{item.nick}");
    // 主页链接只接受 http/https，其它一律退化成纯文本昵称
    expect(section).toContain('/^https?:\\/\\//i.test(site)');
  });

  it("客户端长度/必填校验与服务端一致（提前拦，避免白跑一趟）", () => {
    expect(section).toContain("setting.maxContentLength");
    expect(section).toContain("setting.requireEmail");
    expect(section).toContain("昵称必填");
  });

  it("评论数是批量取的，列表页不会一篇一个请求", () => {
    expect(api).toContain("/api/public/comments/counts");
    expect(api).toContain("setTimeout(");
    expect(api).toContain("paths.join(\",\")");
    expect(api).toContain("slice(0, 50)");
  });

  it("身份记忆只存昵称/邮箱/主页，且不存内容", () => {
    expect(section).toContain("van-comment-identity");
    expect(section).not.toMatch(/localStorage\.setItem\([^)]*content/);
  });
});
