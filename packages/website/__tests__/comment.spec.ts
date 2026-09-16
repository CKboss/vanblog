import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { renderCommentHtml } from "../components/Comment/Content";
import { COUNT_BATCH_MAX } from "../utils/commentApi";
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
    const area = read("components/CommentArea/index.tsx");
    expect(area).toContain('dynamic(() => import("../Comment")');
    expect(area).toContain("ssr: false");
    // PostCard 只静态引入很轻的 CommentArea，不许直接静态引入 Comment
    expect(postCard).toContain('import CommentArea from "../CommentArea"');
    expect(postCard).not.toMatch(/^import Comment from/m);
    expect(postCard).not.toContain('import("../Comment")');
  });

  it("三种评论系统互斥渲染，waline 的计数 span 原样保留", () => {
    const area = read("components/CommentArea/index.tsx");
    expect(area).toContain('provider === "builtin"');
    expect(area).toContain('provider === "waline"');
    expect(area).toContain('provider === "off"');
    expect(postCard).toContain("<CommentArea");
    expect(title).toContain('className="waline-comment-count"');
    expect(title).toContain("<CommentCount path={builtinCommentPath} />");
  });

  it("直接渲染 waline 组件的地方必须被 provider 条件门住", () => {
    // /link 页踩过这个坑：写死 waline 组件，切到内置评论后子进程已停 → 评论区一片空白。
    // 规则：除了统一入口 CommentArea，任何渲染 WaLine/Waline 的文件都必须带
    // `commentProvider === "waline"` 这个条件（列表页那个 visible={false} 的隐形实例也一样）。
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...walk(full));
        } else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of [
      ...walk(join(__dirname, "..", "pages")),
      ...walk(join(__dirname, "..", "components")),
    ]) {
      if (file.includes("components/WaLine/") || file.includes("components/CommentArea/")) {
        continue; // WaLine 自身与统一入口除外
      }
      const raw = readFileSync(file, "utf8");
      // 剔除注释：JS 行注释、块注释、以及 JSX 的 {/* … */}（注释里提到组件名不算渲染）
      const src = raw
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
      if (/<WaLine[\s>]/.test(src) || /<Waline[\s>]/.test(src)) {
        if (!src.includes('commentProvider === "waline"')) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("列表页那个「隐形 waline」只在 waline 模式下初始化（内置模式评论数走本站接口）", () => {
    for (const page of ["pages/index.tsx", "pages/page/[p].tsx"]) {
      const src = read(page);
      expect(src).toContain('commentProvider === "waline"');
      expect(src).toContain("visible={false}");
    }
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
    expect(api).toContain("slice(0, COUNT_BATCH_MAX)");
    expect(COUNT_BATCH_MAX).toBe(50);
  });

  it("内置评论用数字 id 当规范键（别名可以改，数字 id 不会）", () => {
    // 一篇文章有 /post/<数字id> 和 /post/<别名> 两个入口；用别名存评论的话，
    // 改一次别名就等于把评论弄丢（waline 时代的历史评论也全是数字形式）
    expect(postCard).toContain('"/post/" + (props.numericId ?? props.id)');
    expect(postCard).toContain("numericId={props.numericId}");
    expect(title).toContain('"/post/" + (props.numericId ?? props.id)');
    expect(title).toContain("<CommentCount path={builtinCommentPath} />");
    // waline 那条路径保持不变，别把它已有的评论弄丢
    expect(title).toContain('data-path={dataPath}');
  });

  it("身份记忆只存昵称/邮箱/主页，且不存内容", () => {
    expect(section).toContain("van-comment-identity");
    expect(section).not.toMatch(/localStorage\.setItem\([^)]*content/);
  });
});
