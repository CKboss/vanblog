import { stripFrontMatter } from "./frontMatter";
/**
 * Homepage / list cards render markdown before「阅读全文」.
 *
 * With `<!-- more -->`, everything before the marker is the excerpt (unchanged).
 * Without it, the card falls back to the first `DEFAULT_OVERVIEW_CHARS`
 * characters of the content — the editor tells authors this is the automatic
 * summary, so the budget is a product decision (200 chars), not a rendering
 * detail. The original 50-char cut also landed inside `[text](url)` (issue
 * #410): the Viewer then showed raw brackets plus a truncated autolink instead
 * of the complete href and link text.
 *
 * So: keep the character budget, but if the cut splits an inline link or image,
 * include the rest of that construct so parse and href stay complete.
 *
 * 🔴 With `<!-- more -->` the excerpt is now capped at `MARKER_EXCERPT_MAX_CHARS` (400).
 * The marker branch used to be `return content.slice(0, cut)`, where **`maxChars` took no
 * part at all**, so an author who put the marker at the end of a long post (or an import tool
 * that appends one) made the list page and the RSS description ship the **entire body**.
 * 400 rather than 200 because "the automatic card budget" and "where the author deliberately
 * put the marker" are different things — the latter is an intentional editorial act and earns
 * more room, but a card is still a card.
 *
 * 🔴 **The cap is a constant, not an environment variable, on purpose.** This function runs in
 * the browser: `PostCard` uses `useMemo`/`useState`, so `process.env.VANBLOG_*` is `undefined`
 * there (Next only inlines `NEXT_PUBLIC_*`, and that happens at **build** time while server and
 * website are built separately in the image). One side reading env and the other a constant would
 * make the two implementations disagree **in production** — exactly the "card text jumps across an
 * ISR re-render" failure this file's parity contract exists to prevent.
 *
 * ⚠️ The cap is `Math.max(maxChars, MARKER_EXCERPT_MAX_CHARS)`, never a bare 400, so a caller that
 * explicitly asked for a larger budget is not cut down. 🔴 Both packages must keep this value and
 * this branch identical; `__tests__/articleExcerptParity.spec.ts` pins the outputs byte-for-byte.
 */
export const DEFAULT_OVERVIEW_CHARS = 200;

/**
 * Hard cap on the excerpt when `<!-- more -->` is present. See the file header (R4-11).
 * 🔴 Must equal the server's value — the parity and cross-package-constant specs check it.
 */
export const MARKER_EXCERPT_MAX_CHARS = 400;

export function articleOverviewMarkdown(
  content: string,
  maxChars: number = DEFAULT_OVERVIEW_CHARS
): string {
  if (!content) {
    return content;
  }
  // front matter 是元信息不是正文，摘要里出现 `--- title: …` 会很难看，
  // 而且会被当成 setext 标题（编辑器里有 frontmatter 插件，前台没有）
  content = stripFrontMatter(content);
  const cut = findMoreMarker(content);
  if (cut >= 0) {
    // 🔴 The marker branch needs a cap too (R4-11): with the marker at the end of a long post this
    //    used to return the whole body as the "excerpt". `Math.max` keeps a caller's explicitly
    //    larger budget intact.
    const cap = Math.max(maxChars, MARKER_EXCERPT_MAX_CHARS);
    return cut <= cap ? content.slice(0, cut) : completeTruncatedInlineLinks(content, cap);
  }
  if (content.length <= maxChars) {
    return content;
  }
  return completeTruncatedInlineLinks(content, maxChars);
}

export const MORE_MARKER = "<!-- more -->";

/**
 * 找到真正起作用的 `<!-- more -->` 位置，跳过围栏代码块与行内代码里的。
 * 教程类文章经常把标记本身写在代码示例里，以前会在那里截断，
 * 于是列表卡片渲染出一个没闭合的 ``` ，把后面的内容全吞掉。
 */
export function findMoreMarker(content: string): number {
  const text = String(content ?? "");
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
    if (textClose === -1 || source[textClose + 1] !== "(") {
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
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const close = source.indexOf("`", i + 1);
      if (close === -1) {
        return -1;
      }
      i = close;
      continue;
    }
    if (c === "[") {
      return i;
    }
    if (c === "!" && source[i + 1] === "[") {
      return i;
    }
  }
  return -1;
}

function findMatchingRBracket(source: string, openIdx: number): number {
  const bracketStart = source[openIdx] === "!" ? openIdx + 1 : openIdx;
  let depth = 0;
  for (let i = bracketStart; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const close = source.indexOf("`", i + 1);
      if (close === -1) {
        return -1;
      }
      i = close;
      continue;
    }
    if (c === "[") {
      depth++;
    } else if (c === "]") {
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

  if (source[i] === "<") {
    const gt = indexOfUnescaped(source, ">", i + 1);
    if (gt === -1) {
      return -1;
    }
    i = gt + 1;
  } else {
    const destEnd = scanUnquotedDestination(source, i);
    if (destEnd === -1) {
      return -1;
    }
    if (source[destEnd] === ")" && destEnd === skipSpace(source, destEnd)) {
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
  } else if (source[i] === "(") {
    const close = indexOfUnescaped(source, ")", i + 1);
    if (close === -1) {
      return -1;
    }
    i = skipSpace(source, close + 1);
  }
  return source[i] === ")" ? i : -1;
}

function scanUnquotedDestination(source: string, start: number): number {
  let depth = 0;
  let i = start;
  if (i >= source.length) {
    return -1;
  }
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") {
      break;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      if (depth === 0) {
        return i;
      }
      depth--;
    }
  }
  return i === start ? -1 : i;
}

function skipSpace(source: string, i: number): number {
  while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\n")) {
    i++;
  }
  return i;
}

function indexOfUnescaped(source: string, ch: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === ch) {
      return i;
    }
  }
  return -1;
}
