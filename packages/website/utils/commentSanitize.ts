/**
 * 评论内容的 sanitize 白名单 —— 比正文**严格得多**。
 *
 * 正文是登录用户写的，评论是**匿名任何人**写的，所以：
 * - 渲染时 remark-rehype 不开 `allowDangerousHtml`，正文里的原始 HTML 根本不会被解析，
 *   只会当成文本（`<b>x</b>` 显示成字面量）；这一层是第二道防线。
 * - 白名单只留排版标签：没有 `img`（防追踪像素/钓鱼图）、没有 `iframe`/`style`/`svg`/`math`、
 *   没有 `id`/`class`（除了代码高亮需要的 language-*）、没有 `data-*`、没有 `style` 属性。
 * - 链接只允许 http/https/mailto，且统一加 `rel="nofollow noopener noreferrer"`（见 Content.tsx）。
 */
export const COMMENT_ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "span",
  "sup",
  "sub",
  "mark",
];

/** 这些标签连内容一起丢掉（默认行为是保留子节点，对 script/style 显然不行） */
export const COMMENT_STRIP_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "svg",
  "math",
  "form",
  "input",
  "button",
];

export function sanitizeCommentSchema(schema: any) {
  const base = schema || {};
  const out: any = { ...base };
  out.tagNames = [...COMMENT_ALLOWED_TAGS];
  out.strip = [...COMMENT_STRIP_TAGS];
  out.attributes = {
    "*": [],
    a: ["href", "title", "rel", "target"],
    // 代码块高亮需要 language-xxx
    code: ["className"],
    pre: ["className"],
    span: ["className"],
  };
  out.protocols = {
    ...(base.protocols || {}),
    href: ["http", "https", "mailto"],
  };
  out.clobberPrefix = "";
  out.ancestors = {
    ...(base.ancestors || {}),
    li: ["ul", "ol"],
  };
  return out;
}
