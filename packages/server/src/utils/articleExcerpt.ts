import { stripFrontMatter } from './frontMatter';

/**
 * 列表摘要（server 侧）—— 与 `packages/website/utils/articleExcerpt.ts` **逐字符一致**。
 *
 * 为什么要移植到 server：首页/分页页以前把每篇列表文章的**全文**塞进 `__NEXT_DATA__`
 * （实测首页 5 篇正文 25,053 B，而卡片只渲染 3,263 B 摘要，87% 白送；`__NEXT_DATA__`
 * 占首页 gzip 体积的 54.8%）。现在列表接口直接在 server 出 `excerpt`（见
 * `ArticleProvider.getByOption` 的 `withExcerpt`），浏览器不再下载正文。
 *
 * ⚠️ 两边必须一致：前台对老缓存/文章页仍会本地计算摘要，同一段正文在两边算出不同结果
 * 就会出现「ISR 重渲染前后卡片文字不一样」。website 的
 * `__tests__/articleExcerptParity.spec.ts` 用同一组向量钉住两个实现，改这里必须同步改那边。
 *
 * 语义（与 website 相同的注释保留在这里，防止只改两边漂移）：
 * - 有 `<!-- more -->`：标记之前的部分就是摘要，**但以 `MARKER_EXCERPT_MAX_CHARS`（400）为硬上限**；
 *   标记在围栏/行内代码里的不算。
 * - 没有标记：取前 `DEFAULT_OVERVIEW_CHARS`（200）字符 —— 编辑器告诉作者「不写 more
 *   就自动取前 200 字」，这个预算是产品决定，不是渲染细节。
 *
 * 🔴 为什么标记分支需要上限（R4-11）：原来那条分支是 `return content.slice(0, cut)`，
 * **`maxChars` 根本不参与** ⇒ 作者把标记放在文末（或导入工具批量在末尾追加标记）时，
 * **列表页与 RSS 的 description 会下发整篇正文**，而 §7.42/§7.48 的整个目的正是不要下发全文。
 * 实测过的一次性实例：`withExcerpt` 把响应从 37,884 B 撑到 1,685,104 B（44×）。
 * 上限取 400 而不是 200：「卡片摘要的自动预算」与「作者手写的 more 位置」是两件事，
 * 后者是**有意的编辑行为**，值得比自动回退更宽 —— 但仍然是「一张卡片」，不该是全文。
 *
 * 🔴 **上限是常量、不是环境变量**，这是有意的：前台那份实现在 `PostCard` 里被调用，而
 * `PostCard` 用了 `useMemo`/`useState` ⇒ **它跑在浏览器里**，`process.env.VANBLOG_*`
 * 在客户端是 `undefined`（Next 只内联 `NEXT_PUBLIC_*`，且那是**构建期**内联，而 server 与
 * website 是镜像里分开构建的）。⇒ 一侧读 env、另一侧用常量会让两边**在生产环境算出不同摘要**，
 * 正好触发上面那条「ISR 重渲染前后卡片文字跳变」。要可配，得两侧都能读到同一个值，
 * 那需要把上限放进站点设置并随列表响应下发 —— 与本条护栏的收益不成比例。
 *
 * ⚠️ 上限用 `Math.max(maxChars, MARKER_EXCERPT_MAX_CHARS)` 而不是直接 400：调用方**显式**要了
 * 更大预算时不能把它砍小。搜索索引就是这么调的（`searchIndexBuild.ts` 传
 * `budget * SEARCH_SNIPPET_OVERSCAN`，OVERSCAN=4），所以那条路径的行为**逐字不变**。
 * - 截断落在 `[text](url)` 中间时把整个链接补全（issue #410：50 字时代截断露出裸括号
 *   和半个 autolink），并且绝不把代理对（emoji）切成两半。
 */
export const DEFAULT_OVERVIEW_CHARS = 200;

/**
 * 有 `<!-- more -->` 时摘要的硬上限（字符数）。见上面文件头对 R4-11 的说明。
 * 🔴 两个包必须同值：`packages/website/__tests__/articleExcerptParity.spec.ts` 与
 * `utils/crossPackageConstants.spec.ts` 都会核对，改一边不改另一边会红。
 */
export const MARKER_EXCERPT_MAX_CHARS = 400;

export function articleOverviewMarkdown(
  content: string,
  maxChars: number = DEFAULT_OVERVIEW_CHARS,
): string {
  if (!content) {
    return content;
  }
  // front matter 是元信息不是正文，摘要里出现 `--- title: …` 会很难看，
  // 而且会被当成 setext 标题（编辑器里有 frontmatter 插件，前台没有）
  content = stripFrontMatter(content);
  const cut = findMoreMarker(content);
  if (cut >= 0) {
    // 🔴 标记分支也必须有上限（R4-11）：作者把标记放在文末时，原来这里会把整篇正文当摘要返回。
    //    `Math.max` 保证不砍小调用方**显式**要的预算（搜索索引传的是 budget × 4）。
    const cap = Math.max(maxChars, MARKER_EXCERPT_MAX_CHARS);
    return cut <= cap ? content.slice(0, cut) : completeTruncatedInlineLinks(content, cap);
  }
  if (content.length <= maxChars) {
    return content;
  }
  return completeTruncatedInlineLinks(content, maxChars);
}

export const MORE_MARKER = '<!-- more -->';

/**
 * 找到真正起作用的 `<!-- more -->` 位置，跳过围栏代码块与行内代码里的。
 * 教程类文章经常把标记本身写在代码示例里，以前会在那里截断，
 * 于是列表卡片渲染出一个没闭合的 ``` ，把后面的内容全吞掉。
 *
 * ⚠️ 复杂度：这个函数在**每一次公开列表请求**上对**每一篇文章**跑一遍
 * （见 ArticleProvider.getByOption 的 withExcerpt），所以扫描范围必须与
 * "标记在哪"成正比，而不是与"文章多长"成正比。做法是先用最便宜的
 * `indexOf`（memchr 级）找出**最后一个**标记的位置，然后两个代码区正则
 * 都在越过它之后立刻停：
 *  - 一个代码区要包含某个标记，它的**起点必然 ≤ 该标记的位置**；
 *  - 正则的匹配是按起点递增返回的，所以"起点已经超过最后一个标记"之后
 *    再匹配到的区间不可能包含任何标记；
 *  - 围栏只找到开栏、还没找到闭栏就停下时，走的是原来那句
 *    `codeRanges.push([openStart, text.length])` —— 区间反而更大，
 *    "标记在这个未闭合围栏里"的判定与扫全文时**完全一致**。
 * 输出与扫全文逐字节相同（spec 里用"旧实现逐字拷贝 + 随机/构造向量"对拍钉住）。
 */
export function findMoreMarker(content: string): number {
  const text = String(content ?? '');
  let index = text.indexOf(MORE_MARKER);
  if (index < 0) {
    return -1;
  }
  // 最后一个标记的位置：代码区扫描的右边界
  let lastMarker = index;
  for (let next = text.indexOf(MORE_MARKER, lastMarker + MORE_MARKER.length); next >= 0; ) {
    lastMarker = next;
    next = text.indexOf(MORE_MARKER, next + MORE_MARKER.length);
  }
  const bound = lastMarker + MORE_MARKER.length;
  const fence = /(^|\n)\s{0,3}(?:`{3,}|~{3,})[^\n]*\n/g;
  const codeRanges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  let openStart = -1;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastMarker) {
      break;
    }
    if (openStart < 0) {
      openStart = match.index;
    } else {
      codeRanges.push([openStart, match.index + match[0].length]);
      openStart = -1;
    }
  }
  if (openStart >= 0) {
    codeRanges.push([openStart, text.length]);
  }
  const inline = /`[^`\n]*`/g;
  while ((match = inline.exec(text)) !== null) {
    if (match.index > lastMarker) {
      break;
    }
    codeRanges.push([match.index, match.index + match[0].length]);
  }
  const inCode = (at: number) => codeRanges.some(([from, to]) => at >= from && at < to);
  while (index >= 0) {
    if (!inCode(index)) {
      return index;
    }
    index = text.indexOf(MORE_MARKER, index + MORE_MARKER.length);
  }
  return -1;
}

function completeTruncatedInlineLinks(source: string, maxChars: number): string {
  let end = maxChars;
  for (const range of inlineLinkRanges(source, maxChars)) {
    if (range.start < maxChars && range.end > maxChars) {
      end = Math.max(end, range.end);
    }
  }
  return source.slice(0, keepSurrogatePairsWhole(source, end));
}

/** Never cut between a surrogate pair, or the excerpt ends with a broken emoji. */
function keepSurrogatePairsWhole(source: string, end: number): number {
  if (end <= 0 || end >= source.length) {
    return end;
  }
  const last = source.charCodeAt(end - 1);
  // High surrogate at the boundary means its low surrogate got cut off.
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

/**
 * 列出正文里的行内链接区间。
 *
 * @param limit 只关心"起点 < limit"的区间（摘要只需要跨过截断点的那一个）。
 *   给了 limit 之后扫描在 limit 处停下，于是这个函数的代价与 `limit`（200）成正比，
 *   而不是与正文长度成正比 —— 它跑在**每次公开列表请求 × 每篇没有 `<!-- more -->`
 *   的文章**上，正文越长省得越多（实测 493KB 的合成正文：6.07ms → 2.1ms）。
 *   默认 `Infinity` = 扫全文，与没有这个参数时逐字节一致。
 */
function inlineLinkRanges(
  source: string,
  limit: number = Infinity,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < source.length) {
    const start = findLinkOpen(source, i, limit);
    if (start === -1) {
      break;
    }
    const textClose = findMatchingRBracket(source, start);
    if (textClose === -1 || source[textClose + 1] !== '(') {
      i = start + 1;
      continue;
    }
    const destClose = findLinkCloseParen(source, textClose + 2);
    if (destClose === -1) {
      i = start + 1;
      continue;
    }
    ranges.push({ start, end: destClose + 1 });
    i = destClose + 1;
  }
  return ranges;
}

function findLinkOpen(source: string, from: number, stopAt: number = source.length): number {
  const stop = stopAt < source.length ? stopAt : source.length;
  for (let i = from; i < stop; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`') {
      const close = source.indexOf('`', i + 1);
      // 找不到闭合反引号、或者闭合已经在界限之外：后面的 `[` 起点必然 ≥ stopAt，
      // 与"扫全文再按 start >= limit 过滤"的结果一致（那种区间本来就会被丢掉）
      if (close === -1 || close >= stop) {
        return -1;
      }
      i = close;
      continue;
    }
    if (c === '[') {
      return i;
    }
    if (c === '!' && source[i + 1] === '[') {
      return i;
    }
  }
  return -1;
}

function findMatchingRBracket(source: string, openIdx: number): number {
  const bracketStart = source[openIdx] === '!' ? openIdx + 1 : openIdx;
  let depth = 0;
  for (let i = bracketStart; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`') {
      const close = source.indexOf('`', i + 1);
      if (close === -1) {
        return -1;
      }
      i = close;
      continue;
    }
    if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function findLinkCloseParen(source: string, destStart: number): number {
  let i = skipSpace(source, destStart);
  if (i >= source.length) {
    return -1;
  }

  if (source[i] === '<') {
    const gt = indexOfUnescaped(source, '>', i + 1);
    if (gt === -1) {
      return -1;
    }
    i = gt + 1;
  } else {
    const destEnd = scanUnquotedDestination(source, i);
    if (destEnd === -1) {
      return -1;
    }
    if (source[destEnd] === ')' && destEnd === skipSpace(source, destEnd)) {
      return destEnd;
    }
    i = destEnd;
  }

  i = skipSpace(source, i);
  if (source[i] === '"' || source[i] === "'") {
    const q = source[i];
    const close = indexOfUnescaped(source, q, i + 1);
    if (close === -1) {
      return -1;
    }
    i = skipSpace(source, close + 1);
  } else if (source[i] === '(') {
    const close = indexOfUnescaped(source, ')', i + 1);
    if (close === -1) {
      return -1;
    }
    i = skipSpace(source, close + 1);
  }
  return source[i] === ')' ? i : -1;
}

function scanUnquotedDestination(source: string, start: number): number {
  let depth = 0;
  let i = start;
  if (i >= source.length) {
    return -1;
  }
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      break;
    }
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth === 0) {
        return i;
      }
      depth--;
    }
  }
  return i === start ? -1 : i;
}

function skipSpace(source: string, i: number): number {
  while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\n')) {
    i++;
  }
  return i;
}

function indexOfUnescaped(source: string, ch: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
      continue;
    }
    if (source[i] === ch) {
      return i;
    }
  }
  return -1;
}
