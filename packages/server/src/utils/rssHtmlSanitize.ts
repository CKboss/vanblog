import { defaultSchema } from 'hast-util-sanitize';
import { fromHtml } from 'hast-util-from-html';
import { sanitize } from 'hast-util-sanitize';
import { toHtml } from 'hast-util-to-html';

/**
 * RSS 正文的 HTML 消毒白名单 —— `packages/website/utils/markdownSanitize.ts`（下称 **canonical**）的**镜像**。
 *
 * ## 为什么需要它（2026-09-21，站长裁定）
 * 文章正文允许写原始 HTML（`markdown.provider.ts` 里 markdown-it 的 `html: true`），而服务端这条渲染路径
 * **只喂 RSS**（`renderMarkdown` 的唯一产品调用方是 `provider/rss/rss.provider.ts`），且**此前完全没有消毒**。
 * 实测（W1 差分语料）：正文里一个 script 元素会**原样透传**进 `<staticPath>/rss/{feed.xml,atom.xml,feed.json}`，
 * 而这些文件由 `main.ts` 的 `useStaticAssets(…, {prefix:'/rss/'})` **从本站源直接提供**，
 * 降级期还会被 caddy 直发磁盘产物（`scripts/caddyConfig.js` 的 `/rss/*` 分支）。
 * ⇒ 协作者（只有 `article:create`/`article:update`）可以借此把脚本送进与本站同源的响应里。
 * 前台文章页**早就**由 canonical 白名单挡住了（bytemd 管线 → `rehype-sanitize`），RSS 是**唯一**没挡住的一条。
 *
 * ## 为什么是"镜像"而不是"直接 import canonical"（两条硬阻碍，都实测过）
 * 1. 🔴 **`nest build` 的产物布局会被破坏**：`packages/server/tsconfig.json` 的 `rootDir` 是**注释掉的**
 *    （第 14 行 `// "rootDir": "./src"`），`nest-cli.json` 是 `sourceRoot: "src"`。一旦 import 了 `src/` 之外的
 *    文件，TS 推断的 rootDir 会上移，产物从 `dist/src/…` 变成 `dist/packages/server/src/…`，
 *    而 `scripts/start.js`、Dockerfile、降级驻留代码与"`dist/src/main.js` 里不许出现 `require("src/`"那条判据
 *    **全部硬依赖前者**。
 * 2. 🔴 **Dockerfile 的 server 构建阶段只 COPY `./packages/server`**（与 admin 阶段只 COPY `./packages/admin`
 *    同一形状）⇒ 构建时 canonical 那个文件**根本不存在**。
 * ⇒ 所以这里放一份镜像，并用**行为级跨包一致性守卫**钉住两边不漂移
 *   （`utils/rssHtmlSanitizeParity.spec.ts`：server 的 jest **可以** import canonical —— 实测通过，
 *    因为 canonical 没有任何 import、且 jest 的 rootDir 只影响用例发现不影响模块解析）。
 * ⚠️ 真正的单一真相方案是"抽一个共享包给 website/admin/server 三方 import"，blast radius 更大，已单独登记。
 *
 * ## 🔴 className 陷阱（镜像最容易踩的一个坑，已实测）
 * 镜像**不能**直接拿 `hast-util-sanitize` 的 `defaultSchema` 当基底就用：它比 bytemd 传进 canonical 的基底
 * **少一个 `attributes["*"]` 里的 `"className"`**。逐键比对的结果（bytemd 1712 字节 vs hast 1700 字节）：
 *   · 顶层 7 个键 `strip`/`clobberPrefix`/`clobber`/`ancestors`/`protocols`/`tagNames`/`required` **逐个相同**；
 *   · `tagNames` 都是 **61** 个；
 *   · **唯一差异**就是 `attributes["*"]` 末尾那一个 `className`。
 * 少了它的后果很具体：RSS 里**所有 class 都会被摘掉**，直接毁掉 katex 的排版
 * （`katex`/`katex-display`/`katex-html`）、代码高亮（`hljs`/`hljs-keyword`）与
 * `rss.provider.ts` 自己加的 `<div class="markdown-body rss">`。⇒ 见下面 `rssBaseSchema()` 里那一步。
 *
 * ## ⚠️ 两条**继承自 canonical 的已知局限**（有意不修，别在这里"顺手修好"）
 * 1. ~~**MathML 会被 drop**~~ —— 🔴 **2026-09-21 已修，本条不再是局限**（原文保留在下面以免历史断层）：
 *    原文是"katex 输出里 `<span class="katex-mathml">` 内部的 math/semantics/mrow 等元素不在白名单里，
 *    消毒后只剩文本 ⇒ 读屏器支持会丢（视觉渲染不受影响，因为 katex 的 `.katex-mathml` 本来就是视觉隐藏的）。
 *    canonical 也是同一份白名单，所以**前台很可能一直在丢**；MathML 有自己的 XSS 史，加白需要单独评估"。
 *    ⚠️ **原文里有两处事实是错的，都被实测更正了**：
 *      · 🔴 **`.katex-mathml` 并不是"视觉隐藏所以对读屏器无关"** —— 它**没有** `aria-hidden`
 *        （只有 `.katex-html` 有），**读屏器读的正是它**；而 drop 之后 rehype-sanitize 保留子节点，
 *        于是里面塌成**乱码重复文本**（实测 `$E=mc^2$` → `E=mc2E=mc^2`）。
 *        所以旧行为的准确描述是"**给读屏器喂垃圾**"，比"丢支持"更糟。
 *      · 🔴 **前台并没有丢**：前台是"先消毒、后由 katex 的 plugin rehype hook 产出"，
 *        MathML 在消毒**之后**才生成 ⇒ 天然活下来（已在镜像里印证：公式页 katex 30 处、math 元素 10 处）。
 *    ⇒ 修法见下面的 `RSS_MATHML_TAG_NAMES`（**窄白名单 + 逐属性定值**，18 个标签、
 *    刻意排除 `annotation-xml`/`mglyph`/`malignmark` 这些 mXSS 载体，以及 `mathcolor`/`mathbackground`）。
 *    ⚠️ **这也意味着服务端这份白名单现在是 canonical 的严格超集**，差异**仅限 MathML**，
 *    由 `rssHtmlSanitizeParity.spec.ts` 按"超集 + 差异集合恰好等于 MathML 那组"钉住（不是放宽成空断言）。
 * 2. **拦不住 `position:fixed` 之类的内联样式遮罩**：`div`/`span`/`p` 是合法排版必需、必须留在
 *    `RSS_STYLE_ALLOWED_TAG_NAMES` 里，所以一个带 `position:fixed;inset:0;z-index:9999` 的 div 会原样保留。
 *    canonical 的注释里明写了这条局限（真要拦只能过滤 style 的**值**，会误伤正常排版）。
 *
 * ## ⚠️ 刻意**不做**角色分支（偏离裁定字面表述，已获站长确认）
 * 裁定原文是"对**非超管**作者的内容消毒"，但 canonical 在文章页上是**对所有作者一视同仁地消毒**
 * （包括超管），比裁定的字面表述**更严**，而"超管内容保持原样"这个要求**在文章页上从来没有被实现过**。
 * 若在服务端引入角色分支，就会出现两套策略（文章页对超管消毒、RSS 对超管不消毒），
 * 还要在渲染路径上引入一个"作者是谁"的身份预言机 —— 而本仓库出过**未认证管理员接管**，
 * 这一族的失败方向必须是"判不出来 ⇒ 当成不可信"。⇒ 统一按"所有人都消毒"实现，与前台一致。
 * ⚠️ 行为变化：超管内容在 RSS 里也会被消毒。按实测统计（53 篇真实文章，排除回收站里的探针），
 * 危险构造 `script`/`onerror`/`onclick`/`onload`/`javascript:`/`expression(`/`behavior:`/`-moz-binding`
 * **全部 0 次**、`iframe` **0 个** ⇒ **实际零破坏**。
 */

/** 额外放行的标签（与 canonical 的 `MARKDOWN_EXTRA_TAG_NAMES` 逐项一致）。 */
export const RSS_EXTRA_TAG_NAMES = [
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
 * 整段删掉（连内容一起，即 `strip`）的标签。
 * ⚠️ 与 canonical 一致：`style` 进 strip 的理由不是"它危险"，而是"不在白名单里的标签 rehype-sanitize
 * 会**保留子节点**"，于是一个 style 元素里的 CSS 文本会被当成**可见文本**渲染出来。
 */
export const RSS_FORBIDDEN_TAG_NAMES = ['script', 'style'] as const;

const FORBIDDEN_TAG_NAME_SET = new Set<string>(RSS_FORBIDDEN_TAG_NAMES);

/** 允许携带内联 `style` 的标签（与 canonical 的 `MARKDOWN_STYLE_ALLOWED_TAG_NAMES` 逐项一致，49 个）。 */
export const RSS_STYLE_ALLOWED_TAG_NAMES = [
  'p',
  'div',
  'span',
  'section',
  'figure',
  'figcaption',
  'hr',
  'center',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'pre',
  'code',
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
  'img',
  'video',
  'audio',
  'iframe',
] as const;

/** 「值是一个 URL」的属性名（与 canonical 的 `URL_VALUED_ATTRIBUTE_NAMES` 逐项一致）。 */
export const RSS_URL_VALUED_ATTRIBUTE_NAMES = [
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

/**
 * iframe 的 `src` 只接受 http(s) 与协议相对写法。
 * ⚠️ 正则**必须**同时接受 `//player.bilibili.com/…` 这种协议相对写法：那是视频嵌入的常见写法，
 * 只写 `^https?:\/\/` 会把这类既有文章弄坏。被挡掉的是 `data:`/`blob:`/`javascript:`/`file:`。
 * ⚠️ 与 canonical 逐字一致（含 `i` 标志）。
 */
const RSS_IFRAME_SRC_HTTPS_ONLY = /^(https?:)?\/\//i;

/** 允许携带 `src` 的额外标签。`img` 不需要在这里声明（基底 schema 的 `attributes.img` 本来就有）。 */
const RSS_SRC_BEARING_EXTRA_TAGS = ['iframe'] as const;

/**
 * 🔴 **RSS 独有**：katex 实际会产出的那一组 MathML 标签（2026-09-21 实测清点，不是照规范抄的）。
 *
 * ## 为什么 RSS 需要它、而前台不需要
 * 两条管线里 katex 与消毒的**先后顺序不同**：
 *   · 前台（bytemd）：`rehype-raw` → **消毒** → **katex（plugin rehype hook）** → stringify
 *     ⇒ katex 的 MathML 在消毒**之后**才生成，天然活下来，所以 canonical 白名单里**一个 MathML 标签都没有**。
 *   · RSS（服务端）：markdown-it + `@mdit/plugin-katex` **先出 HTML 字符串** → parse → **消毒** → stringify
 *     ⇒ MathML 消毒时**已经在树里**，不在白名单就会被 drop。
 * ⇒ 所以这一组是**服务端独有**的、用于抵消管线顺序差异；它让两条路径的**最终效果**一致
 *   （katex 的 MathML 都活下来），而不是让两份白名单逐字相同。
 *
 * ## 🔴 不修它会造成什么（比"丢读屏支持"更糟）
 * `.katex-mathml` **没有** `aria-hidden`（只有 `.katex-html` 有）⇒ **读屏器读的正是它**。
 * 而 MathML 元素被 drop 时 rehype-sanitize 会**保留子节点**，于是里面塌成一串**乱码重复文本**：
 * 实测 `$E=mc^2$` 消毒后 `.katex-mathml` 里是 `E=mc2E=mc^2`（MathML 摊平的文本 + annotation 里的 LaTeX 源），
 * 块级公式更糟（`∫0∞e−x2dx=π2\int_{0}^{\infty}…`）。⇒ **读屏器不是"读不到公式"，而是"读到垃圾"。**
 *
 * ## 🔴 为什么是"精确的 18 个"，而不是"把 MathML 加白"
 * 这 18 个就是 katex 实测会产出的全集（`math semantics mrow mi mn mo msup msub msubsup mfrac msqrt mroot`
 * `mtext mstyle mtable mtr mtd annotation mpadded`）。MathML 有自己的 **mXSS 史**，而**经典的 mXSS 载体
 * 一个都不在里面**，并且都**刻意不放行**：
 *   · `annotation-xml` —— 当 `encoding` 是 `text/html`/`application/xhtml+xml` 时**内部按 HTML 规则解析**，
 *     是命名空间混淆型 mXSS 的主要载体；
 *   · `mglyph` / `malignmark` —— MathML 文本集成点里的"特殊元素"，`mtext` + `table` + `mglyph` + style
 *     是教科书式的那条利用链；
 *   · `maction` / `menclose` / `mover` / `munder` / `munderover` / `mspace` / `ms` / `mprescripts` / `none`
 *     —— katex 当前版本用不到（实测 0 次），所以**按"实测需要"最小化放行**，将来 katex 真的产出了再逐个评估。
 * ⚠️ 放行的判据是**"katex 实测会产出"**，不是"规范里存在"。
 *
 * ## 🔴 为什么不能改用"抽走 katex 子树、消毒后再放回"（那条路已被实测否掉）
 * 直觉上更好的方案是：因为 MathML 是我们自己的 katex 生成的、可信，所以消毒前抽走、消毒后放回
 * （这样白名单一个字都不用改）。🔴 **但"可信"这个前提不成立**：markdown-it 是 `html: true`，
 * 作者写的原始 HTML 会**原样透传**，而 `class` 在白名单里 ⇒ 作者在正文里写一段
 * `<span class="katex-mathml">…</span>` 就能**伪装成 katex 的输出**（实测确认：伪造的 span 消毒后
 * 原样保留）。要让标记不可伪造，就得在**渲染阶段**打一个作者拿不到的标记，而那要改
 * `provider/markdown/markdown.provider.ts`（不在本轮授权范围，且它是前台/后台共用的渲染入口）。
 * ⇒ 所以选"窄白名单 + 逐属性定值"这条**不依赖信任假设**的路。
 */
export const RSS_MATHML_TAG_NAMES = [
  'math',
  'semantics',
  'mrow',
  'mi',
  'mn',
  'mo',
  'msup',
  'msub',
  'msubsup',
  'mfrac',
  'msqrt',
  'mroot',
  'mtext',
  'mstyle',
  'mtable',
  'mtr',
  'mtd',
  'annotation',
  'mpadded',
] as const;

/**
 * MathML 属性的**定值白名单**（每个属性都带正则，不是"给了名字就什么值都收"）。
 *
 * 🔴 **属性名用小写原名**（实测结论，别照 HTML 的习惯改成驼峰）：`hast-util-sanitize` 对
 * HTML 属性会走 property-information 的驼峰名（本文件上面 iframe 那条注释就记着
 * `allowfullscreen` → `allowFullScreen` 这个坑），但 **MathML 属性不在那张表里**，
 * 实测按小写原名挂白名单，katex 产出的 16 个属性**全部原样存活**。
 *
 * ## 🔴 刻意**排除**的两个（katex 会产出，但不给）
 * `mstyle@mathcolor` 与 `mpadded@mathbackground` —— 它们接受**颜色值**，而颜色值是可以塞
 * `url(javascript:…)` 这类东西的属性族。**排除的代价是零视觉损失**：katex 同时产出
 * `.katex-html` 那份**视觉**副本，颜色在那一份里是用内联 `style` 表达的（而 `style` 对
 * `span` 是放行的）⇒ `\textcolor{red}{x}` 在 RSS 里**看起来仍然是红的**，只是 MathML 那份
 * （给读屏器的）不带颜色 —— 而颜色对读屏器本来就没有意义。
 *
 * ## 🔴 定值正则挡住了什么（都实测过）
 * `xmlns` 只收 MathML 那一个 URI ⇒ **命名空间混淆**（换成 `…/1999/xhtml`）会被整条摘掉；
 * `encoding` 只收 `application/x-tex` ⇒ `text/html` 那种"内部按 HTML 解析"的值进不来；
 * 长度类只收数字+单位 ⇒ `expression(…)`、`url(…)` 进不来；
 * `mathvariant` 只收字母 ⇒ 引号与标记（`a" onmouseover="…`）进不来。
 * ⚠️ 而"过紧"这一侧也实测过：katex 实际产出的 18 个属性里 **16 个全部存活**、
 * 只有上面那两个刻意排除的没活 ⇒ **没有误杀真公式**。
 */
const RSS_MATHML_NS_URI = /^http:\/\/www\.w3\.org\/1998\/Math\/MathML$/;
const RSS_MATHML_BOOL = /^(true|false)$/;
const RSS_MATHML_LENGTH = /^[-+]?[0-9]*\.?[0-9]+(pt|em|ex|px|cm|mm|in|%)?$/;
const RSS_MATHML_LENGTH_LIST = /^([-+]?[0-9]*\.?[0-9]+(pt|em|ex|px|cm|mm|in|%)(\s+|$))+$/;
const RSS_MATHML_ALIGN_LIST = /^((left|right|center)(\s+|$))+$/;
const RSS_MATHML_INTEGER = /^[-+]?[0-9]+$/;

export const RSS_MATHML_ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlyArray<unknown>>> = {
  math: [['xmlns', RSS_MATHML_NS_URI], ['display', /^(block|inline)$/]],
  // ⚠️ `annotation` 的内容在 HTML 解析里**不是**原始文本（实测：里面写 `<b>` 会被当标记解析，
  //    并且序列化后**迁移到 annotation 外面**成为兄弟节点）。它无害（迁出去的仍受同一份白名单约束），
  //    但这条行为是"知道的、钉住的"，不是"没想到的"——见 rssHtmlSanitize.spec.ts 里那条断言。
  annotation: [['encoding', /^application\/x-tex$/]],
  mi: [['mathvariant', /^[a-z]+$/i]],
  mo: [
    ['fence', RSS_MATHML_BOOL],
    ['stretchy', RSS_MATHML_BOOL],
    ['separator', RSS_MATHML_BOOL],
    ['accent', RSS_MATHML_BOOL],
    ['form', /^(prefix|infix|postfix)$/],
    ['lspace', RSS_MATHML_LENGTH],
    ['rspace', RSS_MATHML_LENGTH],
    ['maxsize', RSS_MATHML_LENGTH],
    ['minsize', RSS_MATHML_LENGTH],
  ],
  mtable: [
    ['rowspacing', RSS_MATHML_LENGTH_LIST],
    ['columnspacing', RSS_MATHML_LENGTH_LIST],
    ['columnalign', RSS_MATHML_ALIGN_LIST],
    ['rowalign', RSS_MATHML_ALIGN_LIST],
    ['displaystyle', RSS_MATHML_BOOL],
    ['frame', /^(none|solid|dashed)$/],
    ['align', /^(axis|top|bottom|center|baseline)$/],
    ['width', RSS_MATHML_LENGTH],
  ],
  mtr: [
    ['rowalign', RSS_MATHML_ALIGN_LIST],
    ['columnalign', RSS_MATHML_ALIGN_LIST],
  ],
  mtd: [
    ['rowalign', RSS_MATHML_ALIGN_LIST],
    ['columnalign', RSS_MATHML_ALIGN_LIST],
    ['rowspan', RSS_MATHML_INTEGER],
    ['columnspan', RSS_MATHML_INTEGER],
  ],
  mstyle: [
    ['scriptlevel', RSS_MATHML_INTEGER],
    ['displaystyle', RSS_MATHML_BOOL],
    ['scriptsizemultiplier', RSS_MATHML_LENGTH],
    ['scriptminsize', RSS_MATHML_LENGTH],
  ],
  mpadded: [
    ['width', RSS_MATHML_LENGTH],
    ['height', RSS_MATHML_LENGTH],
    ['depth', RSS_MATHML_LENGTH],
    ['lspace', RSS_MATHML_LENGTH],
    ['voffset', RSS_MATHML_LENGTH],
  ],
  mfrac: [['linethickness', RSS_MATHML_LENGTH]],
};

/**
 * 把 MathML 那组挂进 schema。
 * ⚠️ **必须在 `withoutEventHandlers` 与 `ensureUrlAttributeProtocols` 之前调用**：
 * 前者要对所有属性键过一遍事件属性过滤（多一层兜底），后者只看 URL 属性名（MathML 这组一个都不是，
 * 所以不会被误加协议表 —— 但顺序仍然要保持，以免将来有人往 MathML 里加 URL 属性时静默绕过协议白名单）。
 */
function applyRssMathmlSchema(schema: any): void {
  for (const tag of RSS_MATHML_TAG_NAMES) {
    if (!schema.tagNames.includes(tag)) schema.tagNames.push(tag);
  }
  for (const [tag, attrs] of Object.entries(RSS_MATHML_ALLOWED_ATTRIBUTES)) {
    schema.attributes[tag] = mergeAttrs(schema.attributes[tag], [...attrs]);
  }
}

/** `open`（details）只有 4 个字符，必须不被当成事件处理器。 */
const RSS_EVENT_HANDLER_ATTR = /^on[a-z]{3,}$/i;

/** 给"没有协议表"的 URL 属性补的默认白名单（相对 URL 永远放行，所以不影响站内路径）。 */
const RSS_URL_PROTOCOL_FALLBACK = ['http', 'https'];

function withoutEventHandlers(attrs: unknown[] | undefined): unknown[] {
  return (attrs || []).filter((attr) => {
    const name = Array.isArray(attr) ? attr[0] : attr;
    return typeof name !== 'string' || !RSS_EVENT_HANDLER_ATTR.test(name);
  });
}

function attrName(entry: unknown): unknown {
  return Array.isArray(entry) ? entry[0] : entry;
}

/**
 * 合并属性条目并**按属性名去重**（后者优先）。
 * ⚠️ 必须按名字去重而不是用 `new Set`：`['src', /regex/]` 每次都是新对象，Set 按引用比较
 * ⇒ 同一个 schema 被处理两次就会留下两条 src 定义。（与 canonical 的 `mergeAttrs` 同理。）
 */
function mergeAttrs(existing: unknown[] | undefined, additions: unknown[]): unknown[] {
  const byName = new Map<unknown, unknown>();
  for (const entry of [...(existing || []), ...additions]) {
    byName.set(attrName(entry), entry);
  }
  return Array.from(byName.values());
}

function collectAllowedAttributeNames(schema: any): Set<string> {
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

/** 给已放行的 URL 属性补协议白名单；已有的（如 href 带 mailto）不动。**必须最后调用**。 */
function ensureUrlAttributeProtocols(schema: any): void {
  if (!schema || typeof schema !== 'object') return;
  if (!schema.protocols || typeof schema.protocols !== 'object') schema.protocols = {};
  const allowed = collectAllowedAttributeNames(schema);
  for (const attr of RSS_URL_VALUED_ATTRIBUTE_NAMES) {
    if (!allowed.has(attr)) continue;
    const existing = schema.protocols[attr];
    // ⚠️ 判据是 `Array.isArray` 且 `length > 0`：空数组与不存在在库的 `safeProtocol()` 里是同一件事
    //    （都等于**放行一切协议**，含 javascript:）。空数组 = "没有洞"的错觉，比没有键更危险。
    if (!Array.isArray(existing) || existing.length === 0) {
      schema.protocols[attr] = [...RSS_URL_PROTOCOL_FALLBACK];
    }
  }
}

/**
 * 基底 schema：`hast-util-sanitize` 的 `defaultSchema` **深拷贝** + 补上 bytemd 基底里那个 `className`。
 *
 * 🔴 深拷贝是必须的：canonical 与这里都是**就地修改**传进来的 schema，直接用 `defaultSchema`
 * 会让"同一进程内第二次调用"看到被上一次改过的对象（而 `defaultSchema` 是模块级单例）。
 * 🔴 `className` 那一步的理由见文件头的"className 陷阱"。⚠️ 顺序无关紧要，但必须在
 * `applyRssMarkdownSchema` **之前**做完，因为那一步会从 `attributes['*']` 里摘掉 `src`/`style`。
 */
export function rssBaseSchema(): any {
  const base = JSON.parse(JSON.stringify(defaultSchema));
  if (Array.isArray(base?.attributes?.['*']) && !base.attributes['*'].includes('className')) {
    base.attributes['*'].push('className');
  }
  return base;
}

/**
 * 与 canonical 的 `sanitizeMarkdownSchema` **逐步等价**的变换（就地修改并返回同一个对象）。
 * ⚠️ 步骤顺序与 canonical 一致，尤其是最后两步：
 *   · 事件属性过滤要在"属性集合定稿"之后（否则后加的属性不会被过滤）；
 *   · `ensureUrlAttributeProtocols` 必须**最后**（它要看到最终放行了哪些 URL 属性）。
 */
export function applyRssMarkdownSchema(schema: any): any {
  // ⚠️ 只能往协议表里**加**，绝不能删/清空（空表 = 放行一切，含 javascript:）。
  //    幂等：同一个 schema 被处理多次也不会重复堆 'data'。
  if (Array.isArray(schema?.protocols?.src) && !schema.protocols.src.includes('data')) {
    schema.protocols.src.push('data');
  }
  for (const tag of RSS_EXTRA_TAG_NAMES) {
    if (!schema.tagNames.includes(tag)) {
      schema.tagNames.push(tag);
    }
  }
  schema.tagNames = schema.tagNames.filter((tag) => !FORBIDDEN_TAG_NAME_SET.has(tag));
  schema.strip = Array.from(new Set([...(schema.strip || []), ...RSS_FORBIDDEN_TAG_NAMES]));
  // 代码复制按钮是原生 button（与 canonical 同一理由）。
  if (!schema.tagNames.includes('button')) {
    schema.tagNames.push('button');
  }
  schema.attributes.button = mergeAttrs(schema.attributes.button, ['type', 'disabled']);
  schema.attributes.font = mergeAttrs(schema.attributes.font, ['color', 'size', 'face']);

  schema.attributes['*'] = mergeAttrs(schema.attributes['*'], [
    'ariaLabel',
    'ariaHidden',
    'title',
    // 围栏代码块的行号：`<span class="code-line" data-line="1">`
    'dataLine',
    'border',
  ]);
  // ⚠️ **不**把 `src` 与 `style` 挂在全局 `*` 上，并主动摘掉它们（即使基底里带着）：
  //    `src` 改为按标签发放（img 由基底自带 + RSS_SRC_BEARING_EXTRA_TAGS），
  //    `style` 改为按 RSS_STYLE_ALLOWED_TAG_NAMES 发放。
  schema.attributes['*'] = (schema.attributes['*'] || []).filter(
    (entry) => entry !== 'src' && entry !== 'style',
  );

  for (const tag of RSS_SRC_BEARING_EXTRA_TAGS) {
    schema.attributes[tag] = mergeAttrs(schema.attributes[tag], [
      ['src', RSS_IFRAME_SRC_HTTPS_ONLY],
      // ⚠️ 属性名必须用 **hast 的驼峰名**（property-information 的写法），不是 HTML 里的小写写法：
      //    `allowfullscreen` → `allowFullScreen`、`frameborder` → `frameBorder`。
      //    canonical 曾经写成小写 ⇒ 那两条**从来没生效过**，嵌入视频的全屏按钮一直被静默摘掉。
      'allowFullScreen',
      'frameBorder',
      'scrolling',
      'framespacing',
    ]);
  }

  for (const tag of RSS_STYLE_ALLOWED_TAG_NAMES) {
    schema.attributes[tag] = mergeAttrs(schema.attributes[tag], ['style']);
  }
  // 防御性收口：a / input / button 上不许有 style（点击劫持的最短路径是
  // `<a style="position:fixed;inset:0;z-index:9999">`，而链接没有需要内联样式的正当理由）。
  for (const tag of ['a', 'input', 'button']) {
    if (Array.isArray(schema.attributes[tag])) {
      schema.attributes[tag] = schema.attributes[tag].filter((entry) => entry !== 'style');
    }
  }

  // 🔴 MathML 那组必须在事件属性过滤与协议收口**之前**挂上（理由见 applyRssMathmlSchema 的注释）。
  applyRssMathmlSchema(schema);

  // remark-rehype 已经给脚注 id 加过前缀，再加一次会弄断 href。
  schema.clobberPrefix = '';

  for (const key of Object.keys(schema.attributes)) {
    schema.attributes[key] = withoutEventHandlers(schema.attributes[key]);
  }

  // ⚠️ 必须放在最后。
  ensureUrlAttributeProtocols(schema);

  return schema;
}

/** 构造 RSS 用的、已解析完成的消毒 schema（每次调用都返回新对象，互不污染）。 */
export function buildRssSanitizeSchema(): any {
  return applyRssMarkdownSchema(rssBaseSchema());
}

/**
 * 消毒一段**已经渲染好的 HTML**（markdown-it 的输出）。
 *
 * ⚠️ 为什么是"渲染后消毒"而不是"渲染前过滤 markdown"：
 *   · 原始 HTML 是 markdown-it 在 `html: true` 下**原样透传**的，渲染前无法可靠区分
 *     "作者写的原始 HTML"与"代码块里的字面文本"；渲染后代码块里的内容已经被转义成文本，
 *     消毒器不会碰它 ⇒ **代码块里演示用的 script 字面量仍然显示为文本**（有守卫钉住这条）。
 *   · 这也与 canonical 的位置一致（前台是在 rehype 管线里消毒渲染结果）。
 *
 * ⚠️ `fragment: true` 是必须的：RSS 的正文是**片段**（没有 html/head/body），
 * 不传的话解析器会按完整文档处理并可能补出结构标签。
 *
 * 🔴 **失败方向**：解析抛错时**返回空串**（而不是把未消毒的原文返回）。
 * 理由：这个函数的调用方是"把内容发给访客"，宁可少发也不能漏发未消毒的内容。
 * ⚠️ 但"少发"必须**大声**，所以调用方（`rss.provider.ts`）要记一条 ERROR 并说明是哪篇文章。
 */
export function sanitizeRenderedHtml(html: string, onError?: (err: unknown) => void): string {
  // 非字符串与空串都直接返回空串：空输入不需要消毒，而非字符串是调用方的 bug，
  // 失败方向同样是"少发"（绝不把收到的东西原样返回）。
  if (typeof html !== 'string' || html.length === 0) return '';
  try {
    const tree = fromHtml(html, { fragment: true });
    const clean = sanitize(tree, buildRssSanitizeSchema());
    return toHtml(clean);
  } catch (err) {
    onError?.(err);
    return '';
  }
}
