/**
 * 编辑器预览用的 sanitize schema。
 *
 * ⚠️ **canonical 版本在 `packages/website/utils/markdownSanitize.ts`**，两边必须一致：
 * 编辑器预览和前台文章页走的是同一条 bytemd 流水线
 * （remark-parse → remark-rehype(allowDangerousHtml) → rehype-raw → rehype-sanitize → 插件 rehype → stringify），
 * schema 不一致就会出现「预览里看不到、发布后有」或反过来的情况。
 *
 * 以前这里是编辑器自己手写的一份，比前台少了：
 * - `button` 标签 + `type` / `disabled` 属性 → 代码块的**复制按钮**在预览里被剥掉
 * - `dataLine` → 代码块**行号**（`<span class="code-line" data-line="1">`）在预览里失效
 * - `title` / `ariaLabel` / `ariaHidden` → tooltip 和无障碍属性丢失
 * - 事件处理属性过滤（`on*`）→ 前台有这道兜底，编辑器没有
 * `packages/admin/tests/unit/markdownConsistency.test.js` 会把两份文件的白名单对齐钉死。
 *
 * ## 2026-09 收紧（与前台同步，四条）
 *
 * 1. `src` 不再挂在全局 `*` 上：默认 GitHub schema 的 `attributes['*']` **本来就不含 src**，
 *    是这份文件以前 `push('src')` 把它发给了**每一个**被放行的标签。现在只有 `img`
 *    （默认 schema 自带 `['src','longDesc']`）与 `iframe` 能有 src。
 * 2. `iframe` 的 src 加了**每标签的值白名单**（RegExp），只接受 `http(s)://` 与协议相对 `//host/…`
 *    ⇒ `<iframe src="data:text/html;base64,…">` 的 src 被摘掉（元素保留）。
 *    为什么不用"把 data 从 protocols.src 摘掉"：见下面第 3 条的库限制。
 * 3. ⚠️ **两条库限制**（`hast-util-sanitize@4.1.0`，改之前必读）：
 *    - `protocols` 是**按属性名**索引的（`lib/index.js:428-430`），不能按标签区分；
 *    - `safeProtocol()` 在协议表为空/缺失时**直接 return true**（`:434-442`），也就是放行一切
 *      协议（含 `javascript:`）⇒ `protocols.src` / `protocols.href` **只能收窄，绝不能删空**。
 *    好在库支持每标签的**属性值**白名单（`Attributes` 类型允许 `[name, ...RegExp]`，`:13`；
 *    匹配在 `handlePropertyValue()`，`:394-409`），且 tag-specific 条目**覆盖** `*` 条目
 *    （`:232-236`）⇒ "data: 只留给 img" 是能精确表达的。
 * 4. 内联 `style` 从全局收窄到排版类标签（`MARKDOWN_STYLE_ALLOWED_TAG_NAMES`），
 *    **`a` / `input` / `button` 不给**；`<style>` 标签进 strip（否则它的 CSS 会被当正文渲染出来）。
 *
 * ⚠️ 预览**不需要**比前台更严，但**必须不更宽** —— 更宽就会出现"预览里有、发布后没了"，
 * 而作者无从自查。所以这两份文件的白名单是逐项对齐的，由上面那个 consistency 测试钉住。
 */
// mark = `==高亮==`；dl/dt/dd = 定义列表（remark-definition-list）
export const MARKDOWN_EXTRA_TAG_NAMES = [
  'center',
  'iframe',
  'section',
  'button',
  'u',
  'font',
  'mark',
  'dl',
  'dt',
  'dd',
] as const;

/**
 * 整段删掉（连内容一起，即 rehype-sanitize 的 `strip`）的标签。
 *
 * ⚠️ `style` 是 2026-09 新加的：它从来不在默认 tagNames 里，所以元素本来就会被丢掉 ——
 * 但 rehype-sanitize 对"不在白名单里的标签"是**保留子节点**的，于是
 * `<style>body{display:none}</style>` 会把 `body{display:none}` 当成**可见文本**渲染出来。
 * 放进 strip 才会连内容一起删。正文里不存在合法的 `<style>` 块（站点级 CSS 归「定制化」）。
 */
export const MARKDOWN_FORBIDDEN_TAG_NAMES = ['script', 'style'] as const;

const FORBIDDEN_TAG_NAME_SET = new Set<string>(MARKDOWN_FORBIDDEN_TAG_NAMES as readonly string[]);

/** `open`（details 的展开属性）只有 4 个字符，不能被当成事件处理器。 */
const EVENT_HANDLER_ATTR = /^on[a-z]{3,}$/i;

function withoutEventHandlers(attrs: unknown[] | undefined): unknown[] {
  return (attrs || []).filter((attr) => {
    const name = Array.isArray(attr) ? attr[0] : attr;
    return typeof name !== 'string' || !EVENT_HANDLER_ATTR.test(name);
  });
}

/**
 * 挂在**所有**标签上的属性。
 *
 * ⚠️ 这里以前还有 `'style'`、`'src'`、`'frameborder'`、`'framespacing'`、`'allowfullscreen'`：
 * - `style` / `src` 已按标签收窄（见文件头 1 与 4）；
 * - `frameborder` / `allowfullscreen` 是**写错了名字**：rehype-sanitize 比的是 hast 属性名
 *   （property-information 的驼峰式 `frameBorder` / `allowFullScreen`），小写那两条
 *   **从来没生效过** ⇒ 嵌入视频的 `allowfullscreen` 一直被摘掉（表现是没有全屏按钮）。
 *   现在按驼峰写在 iframe 自己身上（同文件里 `dataLine` / `ariaLabel` 一直是驼峰的）。
 */
export const MARKDOWN_GLOBAL_ATTRIBUTES = [
  'ariaLabel',
  'ariaHidden',
  'title',
  // 代码块行号：<span class="code-line" data-line="1">
  'dataLine',
  // 表格/图片的边框宽度（默认 schema 的 `*` 里其实已有 border，这里显式写出意图）
  'border',
] as const;

/**
 * 允许携带内联 `style` 的标签（排版/布局用途）。与前台那份**逐项一致**。
 *
 * 依据（实测，不是猜的）：对一份 66MB 生产整站备份里的 **59 篇文章**逐篇扫描，正文中
 * `style=` 只出现在 **`<font>`（64 次，全是 `color`）** 与 **`<div>`（1 次，`text-align`）**，
 * 用到的 CSS 属性只有 `color` 与 `text-align`；`expression(`、`behavior:`、`-moz-binding`、
 * `javascript:`、`url(` 全部 **0 次**。两个标签都在下表 ⇒ 既有文章零破坏。
 *
 * ⚠️ **故意不含 `a` / `input` / `button`**：`<a style="position:fixed;inset:0;z-index:9999">`
 * 是"覆盖整页诱导点击"的最短路径，而链接没有需要内联样式的正当理由（外观归 CSS 类管）。
 *
 * ⚠️ 局限（如实记录）：这**拦不住** `<div style="position:fixed;inset:0">` 做同样的遮罩，
 * 因为 div/span/p 是合法排版必需。真要拦只能过滤 style 的**值**（拒 `position:fixed|sticky`、
 * 拒超大 `z-index`、拒 `url(...)`），那会误伤正常排版 —— 属站长待裁定项，本轮未实现。
 */
export const MARKDOWN_STYLE_ALLOWED_TAG_NAMES = [
  // 块级与行内排版
  'p',
  'div',
  'span',
  'section',
  'figure',
  'figcaption',
  'hr',
  'center',
  // 标题
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  // 列表
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  // 引用与代码
  'blockquote',
  'pre',
  'code',
  // 表格
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'col',
  'colgroup',
  // 行内强调（含 markdown 之外的老式排版标签）
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'del',
  'sub',
  'sup',
  'mark',
  'small',
  'font',
  // 媒体（tagNames 里目前只有 iframe；video/audio 留着以防将来放行）
  'img',
  'video',
  'audio',
  'iframe',
] as const;

/**
 * iframe 的 `src` 只接受 http(s)。
 *
 * ⚠️ **必须**同时接受协议相对写法 `//player.bilibili.com/…`：那是视频嵌入的常见写法，
 * 只写 `^https?:\/\/` 会弄坏这类既有文章（它跟随页面协议，本质仍是 http(s)，不构成新风险）。
 * 被挡掉的是 `data:` / `blob:` / `javascript:` / `file:`。
 */
const IFRAME_SRC_HTTPS_ONLY = /^(https?:)?\/\//i;

/** 允许携带 `src` 的额外标签（`img` 由默认 schema 自带，不需要在这里声明）。 */
const SRC_BEARING_EXTRA_TAGS = ['iframe'] as const;

/**
 * 「值是一个 URL」的属性名（含 hast 驼峰写法与 HTML 原写法）。
 *
 * ⚠️ `safeProtocol()` 对**不在 `schema.protocols` 里的属性**是放行一切协议（含 `javascript:`），
 * 所以"放行一个 URL 类属性"与"给它配协议白名单"必须同时发生。这张表 + 下面那个检查函数
 * 就是漂移守卫：将来谁放行了 `srcset`，协议表会被自动补上，而不需要有人记得这件事。
 */
export const URL_VALUED_ATTRIBUTE_NAMES = [
  'src',
  'href',
  'cite',
  'srcset',
  'poster',
  'longDesc',
  'longdesc',
  'xlinkHref',
  'xlink:href',
  'action',
  'formaction',
  'data',
  'background',
] as const;

const URL_PROTOCOL_FALLBACK = ['http', 'https'];

/** 属性名规范化：条目可能是 `'style'`，也可能是 `['src', /…/]`。 */
function attrName(entry: unknown): unknown {
  return Array.isArray(entry) ? entry[0] : entry;
}

/**
 * 合并属性条目并**按属性名去重**（后者优先）。
 * ⚠️ 不能直接 `new Set`：`['src', /regex/]` 每次都是新对象，Set 按引用比较
 * ⇒ 同一个 schema 被处理两次就会留下两条 src 定义。
 */
function mergeAttrs(existing: unknown[] | undefined, additions: unknown[]): unknown[] {
  const byName = new Map<unknown, unknown>();
  for (const entry of [...(existing || []), ...additions]) {
    byName.set(attrName(entry), entry);
  }
  return Array.from(byName.values());
}

/** schema 里所有被放行的属性名（跨全部标签，含 `*`）。 */
export function collectAllowedAttributeNames(schema: any): Set<string> {
  const out = new Set<string>();
  const attrs = schema?.attributes || {};
  for (const key of Object.keys(attrs)) {
    for (const entry of (attrs[key] || []) as unknown[]) {
      const n = attrName(entry);
      if (typeof n === 'string') out.add(n);
    }
  }
  return out;
}

/**
 * 漂移守卫：返回"已被放行、但 `protocols` 里没有非空白名单"的 URL 类属性名。
 * ⚠️ 判据是 `Array.isArray` **且** `length > 0` —— 空数组与键不存在在 `safeProtocol()` 里
 * 是同一件事（都等于放行一切协议），而空数组更危险，因为它看着像已经配好了。
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

function ensureUrlAttributeProtocols(schema: any): void {
  if (!schema || typeof schema !== 'object') return;
  if (!schema.protocols || typeof schema.protocols !== 'object') schema.protocols = {};
  const allowed = collectAllowedAttributeNames(schema);
  for (const attr of URL_VALUED_ATTRIBUTE_NAMES) {
    if (!allowed.has(attr)) continue;
    const existing = schema.protocols[attr];
    // 已有的（例如 href 带 mailto/xmpp/irc/ircs）不覆盖
    if (!Array.isArray(existing) || existing.length === 0) {
      schema.protocols[attr] = [...URL_PROTOCOL_FALLBACK];
    }
  }
}

export const sanitizeMarkdownSchema = (schema: any) => {
  // ⚠️ 只能往协议表里**加**，绝不能删/清空（空表 = 放行一切，含 javascript:）。
  //    幂等：同一个 schema 对象被处理多次也不会重复堆 'data'。
  if (Array.isArray(schema?.protocols?.src) && !schema.protocols.src.includes('data')) {
    schema.protocols.src.push('data');
  }
  for (const tag of MARKDOWN_EXTRA_TAG_NAMES) {
    if (!schema.tagNames.includes(tag)) {
      schema.tagNames.push(tag);
    }
  }
  schema.tagNames = schema.tagNames.filter((tag: string) => !FORBIDDEN_TAG_NAME_SET.has(tag));
  schema.strip = Array.from(
    new Set([...(schema.strip || []), ...MARKDOWN_FORBIDDEN_TAG_NAMES]),
  );
  // 代码复制按钮是原生 <button type="button">
  if (!schema.tagNames.includes('button')) {
    schema.tagNames.push('button');
  }
  schema.attributes.button = mergeAttrs(schema.attributes.button, ['type', 'disabled']);
  schema.attributes.font = mergeAttrs(schema.attributes.font, ['color', 'size', 'face']);

  schema.attributes['*'] = mergeAttrs(schema.attributes['*'], [...MARKDOWN_GLOBAL_ATTRIBUTES]);
  // ⚠️ 主动摘掉 `src` 与 `style`（即使调用方传进来的基础 schema 里带着），
  //    它们改为按标签发放：src → img + SRC_BEARING_EXTRA_TAGS；style → MARKDOWN_STYLE_ALLOWED_TAG_NAMES。
  schema.attributes['*'] = (schema.attributes['*'] || []).filter(
    (entry: unknown) => entry !== 'src' && entry !== 'style',
  );

  // iframe：src 只准 http(s)（值白名单，tag-specific 覆盖 `*`），
  // 并把 iframe 专属的展示属性收回到 iframe 自己身上（用 hast 的驼峰名，见 MARKDOWN_GLOBAL_ATTRIBUTES 注释）。
  for (const tag of SRC_BEARING_EXTRA_TAGS) {
    schema.attributes[tag] = mergeAttrs(schema.attributes[tag], [
      ['src', IFRAME_SRC_HTTPS_ONLY],
      'allowFullScreen',
      'frameBorder',
      'scrolling',
      'framespacing',
    ]);
  }

  // 内联 style：只给排版类标签。
  for (const tag of MARKDOWN_STYLE_ALLOWED_TAG_NAMES) {
    schema.attributes[tag] = mergeAttrs(schema.attributes[tag], ['style']);
  }
  // 防御性收口：`a` / `input` / `button` 上不许有 style。
  for (const tag of ['a', 'input', 'button']) {
    if (Array.isArray(schema.attributes[tag])) {
      schema.attributes[tag] = schema.attributes[tag].filter((entry: unknown) => entry !== 'style');
    }
  }

  // remark-rehype 已经给脚注 id 加过前缀，再加一次会把 href 弄断
  schema.clobberPrefix = '';
  for (const key of Object.keys(schema.attributes)) {
    schema.attributes[key] = withoutEventHandlers(schema.attributes[key]);
  }

  // ⚠️ 必须放在最后：属性集合定稿之后才能判断"哪些 URL 类属性被放行了"。
  ensureUrlAttributeProtocols(schema);

  return schema;
};
