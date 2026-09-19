/**
 * ByteMD / rehype-sanitize schema used by the public article Viewer
 * and (kept in sync with) the admin editor preview.
 *
 * Pipeline (bytemd 1.21): remark-parse → remark-rehype({ allowDangerousHtml: true })
 * → rehype-raw → **rehype-sanitize(this schema)** → plugin rehype hooks → stringify.
 * Raw HTML is parsed; tags/attributes missing from the schema are dropped
 * (children are kept). That is why `<u>` previously “didn’t take effect”:
 * it is not in the default GitHub tag list.
 *
 * Safety stance (article Markdown only — not 定制化 / 自定义页面):
 * - Allowed: common formatting/embed HTML (`u`, `font`, `center`, `iframe`,
 *   `section`, `button`, plus the default GitHub tags) and existing extras
 *   (`style` on typographic tags, `data:` images).
 * - Not allowed: `<script>`, event-handler attributes (`onclick`, `onerror`,
 *   …), `javascript:` URLs (blocked by default protocol lists), `data:` URLs on
 *   anything that is not an `<img>`, and inline `style` on `<a>` / `<input>` /
 *   `<button>`.
 * - Site-wide JS/HTML still belongs in 定制化, not the article body.
 * - Admins are trusted authors; this is not a comment-field sanitizer.
 *   ⚠️ "Trusted" still excludes collaborators with only article write access
 *   (`article:create` / `article:update`), whose output is rendered to every
 *   visitor from the same origin — so this schema is a real boundary, not a formality.
 *
 * ## 三条必须知道的库限制（改这个文件前先读）
 *
 * 1. **`protocols` 是按「属性名」索引的，不能按标签区分**
 *    （`hast-util-sanitize@4.1.0` `lib/index.js:428-430`：`schema.protocols[prop]`）。
 *    所以"只让 img 用 data:"没法写在 protocols 里。
 * 2. **协议表为空 = 放行一切**：`safeProtocol()` 在 `protocols.length === 0` 时直接
 *    `return true`（同一个文件 `lib/index.js:434-442`）。⇒ `protocols.src` /
 *    `protocols.href` **只能收窄，绝不能删掉或清空**，否则 `javascript:` 也会被放行。
 * 3. **每标签的「值」白名单是支持的**，且可以放 RegExp：
 *    `Attributes = Record<string, Array<string | [string, ...Array<Primitive|RegExp>]>>`
 *    （`lib/index.js:13`），匹配逻辑在 `handlePropertyValue()`（`:394-409`，
 *    RegExp 走 `allowed.test(value)`），而 tag-specific 条目**覆盖** `*` 条目
 *    （`Object.assign({}, toPropertyValueMap(attrs['*']), toPropertyValueMap(attrs[name]))`，
 *    `:232-236`，后者胜出）。⇒ "iframe 的 src 只准 http(s)" 就是这么表达的。
 *    ⚠️ 值不匹配时**属性被丢掉、元素保留**（返回 undefined），不是整段删掉。
 */
// mark = `==高亮==`；dl/dt/dd = 定义列表（remark-definition-list）
export const MARKDOWN_EXTRA_TAG_NAMES = [
  "center",
  "iframe",
  "section",
  "button",
  "u",
  "font",
  "mark",
  "dl",
  "dt",
  "dd",
] as const;

/**
 * 整段删掉（连内容一起，即 rehype-sanitize 的 `strip`）的标签。
 *
 * ⚠️ `style` 是本轮新加的，理由不是"它危险"而是"它现在的行为很难看"：
 * `style` 从来就不在默认 tagNames 里，所以 `<style>` 元素本来就会被丢掉 ——
 * 但 rehype-sanitize 对"不在白名单里的标签"是**保留子节点**的，于是
 * `<style>body{display:none}</style>` 会把 `body{display:none}` 当成**可见文本**渲染出来。
 * 放进 `strip` 才会连内容一起删。正文里不存在合法的 `<style>` 块（站点级 CSS 归「定制化」，
 * 见文件头），所以这是纯改善。
 */
export const MARKDOWN_FORBIDDEN_TAG_NAMES = ["script", "style"] as const;

const FORBIDDEN_TAG_NAME_SET = new Set<string>(MARKDOWN_FORBIDDEN_TAG_NAMES);

/**
 * 允许携带内联 `style` 的标签（排版/布局用途）。
 *
 * 为什么从"全局 `*`"收窄成这张表 —— 有实测依据，不是猜的：
 * 对本机一份 66MB 生产整站备份里的 **59 篇文章**逐篇扫描，正文中 `style=` 只出现在
 * **`<font>`（64 次，全部是 `color`）** 与 **`<div>`（1 次，`text-align`）** 上，
 * 用到的 CSS 属性只有 `color` 与 `text-align` 两种；`expression(`、`behavior:`、
 * `-moz-binding`、`javascript:`、`url(` 全部 **0 次**。两个标签都在下表里 ⇒ 零破坏。
 *
 * ⚠️ **故意不含 `a` / `input` / `button`**：
 * `<a style="position:fixed;inset:0;z-index:9999">` 是"覆盖整页做点击劫持/诱导点击"的
 * 最短路径，而链接没有任何需要内联样式的正当理由（外观归 CSS 类管）。
 *
 * ⚠️ 诚实说明这条改动的**局限**：它拦不住 `<div style="position:fixed;…">` 做同样的遮罩，
 * 因为 div/span/p 是合法排版必需、必须留在表里。真要拦遮罩只能过滤 `style` 的**值**
 * （拒 `position:fixed|sticky`、拒 `z-index` 超阈值、拒 `url(...)`），那会误伤正常排版，
 * 属于另一个量级的改动 —— 见本轮汇报里给站长的 (b′) 方案与代价。
 */
export const MARKDOWN_STYLE_ALLOWED_TAG_NAMES = [
  // 块级与行内排版
  "p",
  "div",
  "span",
  "section",
  "figure",
  "figcaption",
  "hr",
  "center",
  // 标题
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  // 列表
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  // 引用与代码
  "blockquote",
  "pre",
  "code",
  // 表格
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "col",
  "colgroup",
  // 行内强调（含 markdown 之外的老式排版标签）
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "del",
  "sub",
  "sup",
  "mark",
  "small",
  "font",
  // 媒体（tagNames 里目前只有 iframe；video/audio 留着以防将来放行）
  "img",
  "video",
  "audio",
  "iframe",
] as const;

/**
 * iframe 的 `src` 只接受 http(s)。
 *
 * ⚠️ 这**不是**把 iframe 从白名单里删掉 —— 嵌视频（B 站 / YouTube / 腾讯视频）是博客的
 * 常见合法用法，删掉会弄坏既有文章（本机那 59 篇里的 2 个 iframe 都是 `https://`，实测保留）。
 * 拦掉的是 `<iframe src="data:text/html;base64,…">`：它虽然是 opaque origin（`srcdoc`
 * 不在白名单，所以读不到本站 localStorage，**不构成同源 XSS**），但能在文章页里内嵌
 * 任意第三方文档，用于钓鱼/挂马，而 `data:` 对 iframe 没有任何正当用途。
 *
 * 为什么用「每标签的值白名单」而不是「把 data 从 protocols.src 摘掉」：见文件头的库限制 1 与 2
 * —— protocols 不能按标签区分，而清空它等于放行 `javascript:`。
 *
 * ⚠️ 正则**必须**同时接受协议相对写法 `//player.bilibili.com/…`：那是视频嵌入的常见写法，
 * 只写 `^https?:\/\/` 会把这类既有文章弄坏（它跟随页面协议，本质仍是 http(s)，不构成新风险）。
 * 被挡掉的是 `data:` / `blob:` / `javascript:` / `file:` 这些非 http(s) 协议。
 */
const IFRAME_SRC_HTTPS_ONLY = /^(https?:)?\/\//i;

/**
 * 允许携带 `src` 的标签。
 *
 * `img` 不需要在这里声明：默认 GitHub schema 里 `attributes.img = ["src","longDesc"]`
 * 本来就有（而 `attributes["*"]` 默认**不含** src）。以前这个文件往 `*` 里 push 了 `src`，
 * 等于给**每一个**被放行的标签都发了 src —— 那些标签（section/button/font/u/…）上的 src
 * 浏览器根本不读，但它把"哪个标签能有 src"这件事从白名单变成了黑名单。现在收回来了。
 */
const SRC_BEARING_EXTRA_TAGS = ["iframe"] as const;

/** `open` (details) is 4 chars and must not be treated as an event handler. */
const EVENT_HANDLER_ATTR = /^on[a-z]{3,}$/i;

/**
 * 「值是一个 URL」的属性名（含 hast 的驼峰写法与 HTML 的原写法）。
 *
 * ⚠️ 为什么需要这张表 —— `safeProtocol()` 对**不在 `schema.protocols` 里的属性**是
 * `protocols.length === 0 → return true`，也就是**放行一切协议**，包括 `javascript:`。
 * 所以"放行一个 URL 类属性"与"给它配协议白名单"必须**同时**发生，否则每放行一个新属性
 * 就自动开一个洞。这张表 + `findUrlAttributesMissingProtocols()` 就是那道漂移守卫。
 *
 * 今天它是**潜在**问题而非可利用漏洞：默认 schema 只给 `img` 配了 `src`/`longDesc`，
 * 而 `longDesc` 恰恰没有协议表（浏览器早已不导航 longdesc，所以打不开），
 * `srcset`/`poster`/`action`/`formaction`/`data`/`background` 目前都没被放行
 * （`video`/`audio`/`form` 不在 tagNames 里）。但下一个人放行 `srcset` 时就会踩。
 */
export const URL_VALUED_ATTRIBUTE_NAMES = [
  "src",
  "href",
  "cite",
  "srcset",
  "poster",
  "longDesc",
  "longdesc",
  "xlinkHref",
  "xlink:href",
  "action",
  "formaction",
  "data",
  "background",
] as const;

/** 给"没有协议表"的 URL 属性补的默认白名单（相对 URL 永远放行，所以不影响站内路径）。 */
const URL_PROTOCOL_FALLBACK = ["http", "https"];

function withoutEventHandlers(attrs: unknown[] | undefined): unknown[] {
  return (attrs || []).filter((attr) => {
    const name = Array.isArray(attr) ? attr[0] : attr;
    return typeof name !== "string" || !EVENT_HANDLER_ATTR.test(name);
  });
}

/** 属性名的规范化：条目可能是 `"style"`，也可能是 `["src", /…/]`。 */
function attrName(entry: unknown): unknown {
  return Array.isArray(entry) ? entry[0] : entry;
}

/** schema 里**所有**被放行的属性名（跨全部标签，含 `*`）。 */
export function collectAllowedAttributeNames(schema: any): Set<string> {
  const out = new Set<string>();
  const attrs = schema?.attributes || {};
  for (const key of Object.keys(attrs)) {
    for (const entry of (attrs[key] || []) as unknown[]) {
      const n = attrName(entry);
      if (typeof n === "string") out.add(n);
    }
  }
  return out;
}

/**
 * 漂移守卫：返回"已被放行、但 `protocols` 里没有非空白名单"的 URL 类属性名。
 *
 * ⚠️ 判据是 **`Array.isArray` 且 `length > 0`**，不是"键存在"—— 空数组与不存在
 * 在 `safeProtocol()` 里是同一件事（都等于放行一切协议）。
 * 空数组 = 没有洞的错觉，比没有键更危险。
 */
export function findUrlAttributesMissingProtocols(schema: any): string[] {
  const allowed = collectAllowedAttributeNames(schema);
  const protocols = schema?.protocols || {};
  const bad: string[] = [];
  for (const attr of URL_VALUED_ATTRIBUTE_NAMES) {
    if (!allowed.has(attr)) continue;
    const list = protocols[attr];
    if (!Array.isArray(list) || list.length === 0) bad.push(attr);
  }
  return bad;
}

/** 给已放行的 URL 属性补协议白名单；已有的（如 href 带 mailto）不动。 */
function ensureUrlAttributeProtocols(schema: any): void {
  if (!schema || typeof schema !== "object") return;
  if (!schema.protocols || typeof schema.protocols !== "object") schema.protocols = {};
  const allowed = collectAllowedAttributeNames(schema);
  for (const attr of URL_VALUED_ATTRIBUTE_NAMES) {
    if (!allowed.has(attr)) continue;
    const existing = schema.protocols[attr];
    if (!Array.isArray(existing) || existing.length === 0) {
      schema.protocols[attr] = [...URL_PROTOCOL_FALLBACK];
    }
  }
}

/**
 * 合并属性条目并**按属性名去重**（后者优先）。
 * ⚠️ 必须按名字去重而不是用 `new Set`：`["src", /regex/]` 每次都是新对象，
 * Set 按引用比较 ⇒ 同一个 schema 被处理两次就会留下两条 src 定义。
 */
function mergeAttrs(existing: unknown[] | undefined, additions: unknown[]): unknown[] {
  const byName = new Map<unknown, unknown>();
  for (const entry of [...(existing || []), ...additions]) {
    byName.set(attrName(entry), entry);
  }
  return Array.from(byName.values());
}

export const sanitizeMarkdownSchema = (schema) => {
  // ⚠️ 只能往协议表里**加**，绝不能删/清空（空表 = 放行一切，含 javascript:）。
  //    幂等：同一个 schema 对象被处理多次也不会重复堆 "data"。
  if (Array.isArray(schema?.protocols?.src) && !schema.protocols.src.includes("data")) {
    schema.protocols.src.push("data");
  }
  for (const tag of MARKDOWN_EXTRA_TAG_NAMES) {
    if (!schema.tagNames.includes(tag)) {
      schema.tagNames.push(tag);
    }
  }
  schema.tagNames = schema.tagNames.filter(
    (tag) => !FORBIDDEN_TAG_NAME_SET.has(tag),
  );
  schema.strip = Array.from(
    new Set([...(schema.strip || []), ...MARKDOWN_FORBIDDEN_TAG_NAMES]),
  );
  // Code-copy control is a native <button type="button">.
  if (!schema.tagNames.includes("button")) {
    schema.tagNames.push("button");
  }
  schema.attributes.button = mergeAttrs(schema.attributes.button, ["type", "disabled"]);
  schema.attributes.font = mergeAttrs(schema.attributes.font, ["color", "size", "face"]);

  schema.attributes["*"] = mergeAttrs(schema.attributes["*"], [
    "ariaLabel",
    "ariaHidden",
    "title",
    // Fenced-code line numbers: <span class="code-line" data-line="1">
    "dataLine",
    // 表格/图片的边框宽度（默认 schema 的 `*` 里其实已有 border，这里显式写出意图）
    "border",
  ]);
  // ⚠️ **不再**把 `src` 与 `style` 挂在全局 `*` 上；并且主动摘掉它们，
  //    这样即使调用方传进来的基础 schema 里带着，也不会漏给所有标签。
  //    - `src` 改为按标签发放：img（默认 schema 自带）+ SRC_BEARING_EXTRA_TAGS；
  //    - `style` 改为按 MARKDOWN_STYLE_ALLOWED_TAG_NAMES 发放。
  schema.attributes["*"] = (schema.attributes["*"] || []).filter(
    (entry) => entry !== "src" && entry !== "style",
  );

  // iframe：src 只准 http(s)（值白名单，tag-specific 覆盖 `*`），
  // 并把原来挂在全局的 iframe 专属属性收回到 iframe 自己身上。
  //
  // ⚠️ 属性名必须用 **hast 的属性名**（property-information 的驼峰式），不是 HTML 里的写法：
  //    `allowfullscreen` → `allowFullScreen`、`frameborder` → `frameBorder`。
  //    本文件以前 push 的是小写的 `"allowfullscreen"` / `"frameborder"`，而 rehype-sanitize
  //    比的是 hast 属性名 ⇒ **那两条从来就没生效过**，B 站/YouTube 嵌入的 `allowfullscreen`
  //    一直被摘掉（表现是嵌入视频没有全屏按钮）。本轮实测输出 HTML 才发现。
  //    `scrolling` 与 `framespacing` 本来就是小写（前者是标准属性、后者是非标准属性，
  //    property-information 里没有对应驼峰名，原样保留）。
  for (const tag of SRC_BEARING_EXTRA_TAGS) {
    schema.attributes[tag] = mergeAttrs(schema.attributes[tag], [
      ["src", IFRAME_SRC_HTTPS_ONLY],
      "allowFullScreen",
      "frameBorder",
      "scrolling",
      "framespacing",
    ]);
  }

  // 内联 style：只给排版类标签。
  for (const tag of MARKDOWN_STYLE_ALLOWED_TAG_NAMES) {
    schema.attributes[tag] = mergeAttrs(schema.attributes[tag], ["style"]);
  }
  // 防御性收口：`a` / `input` / `button` 上不许有 style，
  // 哪怕基础 schema 或将来某次改动又把它塞回全局。
  for (const tag of ["a", "input", "button"]) {
    if (Array.isArray(schema.attributes[tag])) {
      schema.attributes[tag] = schema.attributes[tag].filter(
        (entry) => entry !== "style",
      );
    }
  }

  // remark-rehype already prefixes footnote ids; a second prefix breaks hrefs.
  schema.clobberPrefix = "";

  for (const key of Object.keys(schema.attributes)) {
    schema.attributes[key] = withoutEventHandlers(schema.attributes[key]);
  }

  // ⚠️ 必须放在最后：属性集合定稿之后，才能判断"哪些 URL 类属性被放行了"。
  //    这一步保证「放行 URL 属性」与「给它配协议白名单」永远同时发生 ——
  //    否则 `safeProtocol()` 对表里没有的属性是**放行一切协议**（含 javascript:）。
  ensureUrlAttributeProtocols(schema);

  return schema;
};
