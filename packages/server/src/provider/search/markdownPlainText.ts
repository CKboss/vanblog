/**
 * Markdown → 纯文本（**只给搜索索引的摘要用**）。
 *
 * 为什么不复用现成的东西：
 *  - `utils/articleExcerpt.ts` 的 `articleOverviewMarkdown` 给出的是**markdown 片段**
 *    （它服务的是列表卡片，那边会渲染 markdown）。搜索索引要下发给浏览器的是一个
 *    纯文本摘要：既要能被 `String.includes` 直接匹配，又要能在结果页里原样显示而
 *    不出现 `**加粗**`、`[](http…)`、`|---|` 这类残渣。
 *  - `MarkdownProvider.renderMarkdown` 走 markdown-it + highlight.js + katex，
 *    实测 53 篇 = **135 ms 同步阻塞事件循环**（见 rss.provider.ts:56 的注释）。
 *    搜索索引在**每次 ISR 风暴**上都要重算一遍全站文章，绝不能把那份开销再搬进来；
 *    而且渲染出 HTML 再剥标签，等于绕一大圈还要处理实体转义。
 *
 * 所以这里是一份**刻意的、有限的**纯文本化：只处理摘要里真会出现的 markdown 构造，
 * 全部是线性扫描（没有嵌套量词 ⇒ 不存在灾难性回溯），而且输入长度已经被调用方
 * 兜住了（见 `searchIndexBuild.buildSearchSnippet` 的 `snippetStripInputCap`）。
 *
 * ⚠️ **模块级全局正则只许用 `String.prototype.replace`**（它每次调用前后都会把 `lastIndex`
 * 归零），一次都没有用 `.exec()` / `.test()` —— §7.55-H 记过这个坑：复用模块级 `/g` 正则时
 * 上一次调用中途抛错会留下 `lastIndex` 状态，下一次就从半截开始扫。
 * 唯一用 `.exec()` 的 `FENCE_OPEN` / `FENCE_CLOSE` 都是**非全局**的，本来就没有 `lastIndex`。
 * `searchIndex.provider.spec.ts` 里有源码级断言钉住这条。
 *
 * ⚠️ 有意丢弃的东西（都是"在 200 字摘要里只会是噪音"的）：
 *  - **围栏代码块的内容**（``` / ~~~）：一段 `import { x } from 'y';` 占满整个摘要，
 *    对读者没有信息量。行内代码（单反引号）**保留内容、只去掉反引号** —— 那通常正是
 *    读者会去搜的标识符。
 *    代价（如实说明）：只在围栏代码块里出现过的词，客户端索引搜不到，
 *    要落到服务端 `/api/public/search` 那条全文回退路径上。前台结果页给了这个出口。
 *  - 图片的地址（`![alt](url)` 只留 alt）：url 是 `/static/img/xxx.webp`，匹配上也没意义。
 *  - HTML 注释（`<!-- more -->` 已经被 excerpt 阶段处理掉了，这里兜住正文里其它的）。
 */

/** HTML 注释 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/** `![alt](url)` / `[text](url)` / `[text](<url> "t")` → 只留方括号里的文字 */
const MD_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
/** 引用式：`[text][ref]` / `![alt][ref]` → 只留文字 */
const MD_REF_LINK = /!?\[([^\]]*)\]\[[^\]]*\]/g;
/** 裸自动链接 `<https://…>` → 丢掉（URL 不是可搜索的正文） */
const MD_AUTOLINK = /<((?:https?|mailto):[^>\s]*)>/g;
/** 脚注引用 `[^1]` 与行内的 `^[注]` */
const MD_FOOTNOTE_REF = /\[\^[^\]]*\]|\^\[[^\]]*\]/g;
/** 行内 HTML 标签：只认"看起来真像标签"的（`<a href=…>`、`</div>`、`<!--`、`<br/>`），
 *  免得把正文里的 `a < b` 吃掉 */
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
/** 表格分隔行 `|---|:--:|` */
const MD_TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-{2,}[^\n]*$/gm;
/** 标题标记 `## x` */
const MD_HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/gm;
/** 引用标记 `> x`（连续的 `>>` 一起去掉） */
const MD_BLOCKQUOTE = /^[ \t]{0,3}(?:>[ \t]?)+/gm;
/** 无序/有序列表标记 `- x` `* x` `+ x` `1. x` `1) x` */
const MD_LIST_MARKER = /^[ \t]{0,3}(?:[-*+][ \t]+|\d{1,9}[.)][ \t]+)/gm;
/**
 * 强调 / 删除线 / 行内代码的**标记字符**。
 *
 * ⚠️ 第一版是 `(\*\*\*|___|\*\*|__|~~|[*_`~])` —— 无条件吃掉每一个 `*` `_` `~`，
 * 于是在真语料上直接把标识符改坏了（本机 53 篇里就有两篇中招）：
 *   `MODELSCOPE_CACHE`            → `MODELSCOPECACHE`
 *   `\HKEY_LOCAL_MACHINE\SYSTEM` → `\HKEYLOCALMACHINE\SYSTEM`
 * 搜 `MODELSCOPE_CACHE` 就再也搜不到那篇文章了 —— 摘要"看起来没问题"，
 * 而索引的可匹配性被悄悄改坏了（正是 §7.54 那一轮"静默失败"的形状）。
 *
 * 现在的规则与 CommonMark 一致：**`_` 在单词内部不是强调标记**（intraword emphasis）。
 * 推广到 `*` 与 `~`：一段连续的 `*_~` 只有在**不是被单词字符左右夹住**时才算标记。
 * 于是 `snake_case` / `2*3` / `~/.ssh` 原样保留，而 `*斜体*` / `__粗体__` / `~~删除线~~`
 * 的标记被去掉。反引号仍然无条件去掉（`` a`b`c `` 里的反引号在 markdown 里就是行内代码定界符）。
 */
const MD_EMPHASIS_RUN = /(?<![A-Za-z0-9_])[*_]+|[*_]+(?![A-Za-z0-9_])/g;
/**
 * 删除线单独一条规则：**只吃 `~~` 及以上**，单个 `~` 一律保留。
 * GFM 的删除线是 `~~x~~`，而单个 `~` 在正文里几乎都是字面量（`~/.ssh`、`~100`、`a~b`）。
 * 第一版把它并进上面那条"非单词内部就吃"的规则里，于是 `~/.ssh` 被削成了 `/.ssh`。
 */
const MD_STRIKETHROUGH = /~~+/g;
const MD_BACKTICK = /`/g;
/** 转义的反斜杠：`\*` → `*` */
const MD_ESCAPE = /\\([\\`*_{}[\]()#+\-.!>~|<>])/g;
/** 常见 HTML 实体（摘要里出现别的实体的概率极低，不值得引一个解码表） */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
  '#47': '/',
};
const HTML_ENTITY = /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * 去掉围栏代码块（``` 与 ~~~）**连同它的内容**。
 *
 * ⚠️ 这里刻意用"逐行扫描"而不是一个大正则。第一版写的是
 * `/(^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*)?/g`
 * ——**它是错的**，而且错得很安静：中间那段是懒惰量词、后面那段闭栏又是可选的，
 * 于是正则引擎优先取最短，`"```\nonly code\n```"` 只匹配掉开头那一行 ```` ``` ````，
 * 代码内容原封不动地留在摘要里（spec 里那条"只有代码块的正文 → 空串"就是这么红的）。
 * 把闭栏改成必需又会引入嵌套量词与回溯 —— 而这个函数跑在匿名可触发的路径上。
 * 逐行扫描两个问题都没有：单趟、O(n)、判定与 CommonMark 一致。
 *
 * 语义（与 CommonMark 对齐，也与 `articleExcerpt.findMoreMarker` 对未闭合围栏的处理一致）：
 *  - 开栏：行首最多 3 个空白 + ≥3 个连续的同种围栏字符；反引号围栏的信息串里不能再出现反引号。
 *  - 闭栏：同种字符、长度 ≥ 开栏、后面只能是空白。
 *  - **没有闭栏就吃到文本末尾**（整块都算代码）。
 */
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;

export function stripFencedCodeBlocks(text: string): string {
  // 快路径：正文里既没有 ``` 也没有 ~~~ 时一个字都不用动
  // （与 §7.55-H 给 maskInlineCode 加的那条同型优化：省掉 split+join 的多份全量拷贝）
  if (text.indexOf('```') === -1 && text.indexOf('~~~') === -1) {
    return text;
  }
  const kept: string[] = [];
  let openChar = '';
  let openLen = 0;
  let i = 0;
  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    if (openChar) {
      const close = FENCE_CLOSE.exec(line);
      if (
        close &&
        close[1][0] === openChar &&
        close[1].length >= openLen
      ) {
        openChar = '';
        openLen = 0;
      }
      // 在代码块里：这一行（含闭栏本身）一律丢掉
    } else {
      const open = FENCE_OPEN.exec(line);
      if (open && !(open[1][0] === '`' && open[2].indexOf('`') !== -1)) {
        openChar = open[1][0];
        openLen = open[1].length;
      } else {
        kept.push(line);
      }
    }
    if (nl === -1) {
      break;
    }
    i = nl + 1;
  }
  return kept.join('\n');
}

/**
 * 把一段 markdown 变成单行纯文本。
 *
 * 输出保证：不含换行、不含 markdown 标记、首尾已 trim、连续空白压成一个空格。
 * **不做长度截断**（那是 `buildSearchSnippet` 的职责，它还要负责代理对安全）。
 */
export function markdownToPlainText(input: unknown): string {
  let text = typeof input === 'string' ? input : '';
  if (!text) {
    return '';
  }
  // 顺序有讲究：先去掉"整块"的东西（围栏代码、注释、图片），再拆行内标记。
  // 反过来会让代码块里的 `**` 先被当成强调标记处理，剩下半截残渣。
  text = stripFencedCodeBlocks(text);
  text = text.replace(HTML_COMMENT, ' ');
  text = text.replace(MD_IMAGE, '$1');
  text = text.replace(MD_LINK, '$1');
  text = text.replace(MD_REF_LINK, '$1');
  text = text.replace(MD_AUTOLINK, ' ');
  text = text.replace(MD_FOOTNOTE_REF, ' ');
  text = text.replace(HTML_TAG, ' ');
  text = text.replace(MD_TABLE_SEPARATOR, ' ');
  text = text.replace(MD_HEADING, '');
  text = text.replace(MD_BLOCKQUOTE, '');
  text = text.replace(MD_LIST_MARKER, '');
  text = text.replace(MD_ESCAPE, '$1');
  text = text.replace(MD_STRIKETHROUGH, '');
  text = text.replace(MD_EMPHASIS_RUN, '');
  text = text.replace(MD_BACKTICK, '');
  text = text.replace(HTML_ENTITY, (whole, name: string) => {
    const direct = HTML_ENTITIES[name] ?? HTML_ENTITIES[String(name).toLowerCase()];
    if (direct !== undefined) {
      return direct;
    }
    const numeric = parseNumericEntity(name);
    return numeric === undefined ? whole : numeric;
  });
  // 表格竖线当分隔符而不是删掉：`| a | b |` → `a b`（删掉会粘成 `ab`）
  text = text.replace(/\|/g, ' ');
  // CJK 之间被换行分开时不要插入空格（"中文\n中文" → "中文中文"）：
  // 拉丁文字的空格是词边界，必须保留；中文本来就没有空格。
  text = text.replace(/[ \t\r\f\v]+/g, ' ');
  text = text.replace(/\n+/g, '\n');
  text = text
    .split('\n')
    .map((line) => line.trim())
    .reduce((acc, line) => {
      if (!line) {
        return acc;
      }
      if (!acc) {
        return line;
      }
      const needsSpace = !isCjkChar(acc[acc.length - 1]) || !isCjkChar(line[0]);
      return acc + (needsSpace ? ' ' : '') + line;
    }, '');
  return text.trim();
}

function isCjkChar(ch: string | undefined): boolean {
  if (!ch) {
    return false;
  }
  const code = ch.codePointAt(0) ?? 0;
  // CJK 统一表意文字（含扩展 A）、假名、谚文、CJK 标点
  return (
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/** `&#65;` / `&#x41;` → 'A'；解不出来（越界、孤立代理）返回 undefined，调用方保留原样 */
function parseNumericEntity(name: string): string | undefined {
  const text = String(name);
  if (!text.startsWith('#')) {
    return undefined;
  }
  const isHex = text[1] === 'x' || text[1] === 'X';
  const digits = isHex ? text.slice(2) : text.slice(1);
  if (!digits || !/^[0-9a-fA-F]+$/.test(digits)) {
    return undefined;
  }
  const code = isHex ? Number.parseInt(digits, 16) : Number.parseInt(digits, 10);
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return undefined;
  }
  // 代理区不能单独成字符（会产出畸形字符串）
  if (code >= 0xd800 && code <= 0xdfff) {
    return undefined;
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return undefined;
  }
}

/**
 * 代理对安全地截到 `maxChars` 个 **UTF-16 code unit**（与 `articleExcerpt` 的口径一致：
 * 那边也是按 `string.length` 预算的）。绝不把 emoji 切成两半。
 */
export function clampToChars(text: string, maxChars: number): string {
  const safe = String(text ?? '');
  if (maxChars <= 0) {
    return '';
  }
  if (safe.length <= maxChars) {
    return safe;
  }
  let end = maxChars;
  const last = safe.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return safe.slice(0, end);
}
