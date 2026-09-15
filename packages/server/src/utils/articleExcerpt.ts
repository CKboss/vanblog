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
 * 语义（与 website 相同的注释保留在这里，防止只改一边）：
 * - 有 `<!-- more -->`：标记之前的部分就是摘要（原样保留）；标记在围栏/行内代码里的不算。
 * - 没有标记：取前 `DEFAULT_OVERVIEW_CHARS`（200）字符 —— 编辑器告诉作者「不写 more
 *   就自动取前 200 字」，这个预算是产品决定，不是渲染细节。
 * - 截断落在 `[text](url)` 中间时把整个链接补全（issue #410：50 字时代截断露出裸括号
 *   和半个 autolink），并且绝不把代理对（emoji）切成两半。
 */
export const DEFAULT_OVERVIEW_CHARS = 200;

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
    return content.slice(0, cut);
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
 */
export function findMoreMarker(content: string): number {
  const text = String(content ?? '');
  let index = text.indexOf(MORE_MARKER);
  if (index < 0) {
    return -1;
  }
  const fence = /(^|\n)\s{0,3}(?:`{3,}|~{3,})[^\n]*\n/g;
  const codeRanges: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  let openStart = -1;
  while ((match = fence.exec(text)) !== null) {
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
  for (const range of inlineLinkRanges(source)) {
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

function inlineLinkRanges(source: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < source.length) {
    const start = findLinkOpen(source, i);
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

function findLinkOpen(source: string, from: number): number {
  for (let i = from; i < source.length; i++) {
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
