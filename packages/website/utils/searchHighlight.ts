/**
 * 关键词高亮：**只产出数据，绝不产出 HTML**。
 *
 * ## 为什么这个文件长这样
 *
 * 本仓库已经出过一个存储型 XSS（后台日志页用 `ansi-to-html`，而它的 `escapeXML`
 * **默认是 false**，AGENTS §7.43.1）。一个把用户输入回显到页面上的搜索框，正是下一个
 * 会长出来的地方 —— 最自然的写法
 *
 * ```tsx
 * <div dangerouslySetInnerHTML={{ __html: text.replace(re, "<mark>$&</mark>") }} />
 * ```
 *
 * 一旦 `text` 或 `query` 里带 `<`，就是自伤。所以这里从结构上让它做不出来：
 *  - 本模块是**纯数据**：返回 `Array<{ text: string; match: boolean }>`，
 *    `text` 一律是**原文的切片**（没有经过任何拼接、替换、转义或反转义）。
 *  - 组件（`components/SearchResults`）把这些片段交给 React 当**子节点**渲染
 *    （`<mark>{seg.text}</mark>`），React 自己会转义 —— 没有任何一处用到
 *    `dangerouslySetInnerHTML` / `innerHTML` / `insertAdjacentHTML` / `document.write`。
 *  - **整条搜索路径上不构造任何正则**。匹配全部是 `String.indexOf`：
 *    所以查询里的 `(`、`[`、`*`、`\` 不需要转义也不会让 `new RegExp` 抛错，
 *    而 `(a+)+b` 这种"正则炸弹"在结构上无处可炸（有专门的用例喂它并计时）。
 *    `escapeRegExp` 仍然导出，是给"以后有人真要用正则"时准备的正确工具，
 *    本模块自己一次都没调它。
 */

import { MAX_QUERY_CHARS, foldCase, splitSearchTerms } from "./searchRank";

/** 一段文本：`match=true` 的部分由组件包 `<mark>` */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * 转义正则元字符。
 *
 * ⚠️ 本模块**不使用**它（见文件头：这里一个正则都不构造）。导出它是为了
 * "下一个想在这里写 `new RegExp(query)` 的人"手边就有正确的工具，
 * 以及给 `__tests__` 一个可以对照的参照物。
 */
export function escapeRegExp(value: unknown): string {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 原文 → 折叠串的下标映射 */
interface FoldOffsets {
  folded: string;
  /** `starts[j]` / `ends[j]`：折叠串第 j 个字符来自原文的 `[starts[j], ends[j])` */
  starts: number[];
  ends: number[];
  /** 映射不可用（长度对不上）时为 true，调用方必须退回"不高亮" */
  unmappable: boolean;
}

/**
 * 折叠文本并记住每个折叠字符对应原文的哪一段。
 *
 * 为什么需要映射而不只是 `text.toLowerCase()`：少数字符折叠后**长度会变**
 * （`İ` U+0130 → `i` + U+0307，1 变 2），于是折叠串里的下标不能直接当原文下标用，
 * 否则高亮会错位、甚至切出半个代理对。
 *
 * 折叠规则与匹配用的 `foldCase` **是同一条**（整串 `toLowerCase()`）：
 * 这里只额外按字符统计每段的长度来建映射。万一长度对不上（未来某个 Unicode 版本里
 * 出现了上下文相关的长度变化），返回 `unmappable`，调用方退回"整段不高亮"——
 * 少一个高亮是外观问题，高亮错位置是正确性问题，宁可退。
 */
export function foldWithOffsets(text: unknown): FoldOffsets {
  const source = typeof text === "string" ? text : "";
  const folded = foldCase(source);
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const lower = source[i].toLowerCase();
    const len = Math.max(1, lower.length);
    for (let k = 0; k < len; k++) {
      starts.push(i);
      ends.push(i + 1);
    }
  }
  return { folded, starts, ends, unmappable: starts.length !== folded.length };
}

/** 找出所有（不重叠的）命中区间，返回**原文**下标的 `[from, to)`，已排序 */
export function matchSpans(text: unknown, terms: string[]): Array<[number, number]> {
  const source = typeof text === "string" ? text : "";
  if (!source || !terms.length) {
    return [];
  }
  const { folded, starts, ends, unmappable } = foldWithOffsets(source);
  if (unmappable || !folded) {
    return [];
  }
  const raw: Array<[number, number]> = [];
  for (const term of terms) {
    if (!term) {
      continue;
    }
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at < 0) {
        break;
      }
      const last = at + term.length - 1;
      const start = starts[at] ?? at;
      const end = ends[last] ?? last + 1;
      raw.push([start, Math.max(end, start + 1)]);
      from = at + term.length; // 不重叠
    }
  }
  return mergeSpans(raw);
}

/** 合并重叠/相接的区间，并按起点排序（多词查询时同一段可能被两个词都命中） */
export function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  if (!spans.length) {
    return [];
  }
  const sorted = [...spans].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  const merged: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current[0] <= last[1]) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

/**
 * 把一段文本按查询切成"要包 `<mark>` 的"与"不用包的"片段。
 *
 * 保证：
 *  - `segments.map(s => s.text).join("") === text`（逐字符还原，一个字符都不丢不改）；
 *  - `text` 全部来自**原文切片**（大小写、标点、emoji 原样保留）；
 *  - 没有命中时返回 `[{ text, match: false }]`（空串返回 `[]`）。
 */
export function highlightSegments(text: unknown, query: unknown): HighlightSegment[] {
  const source = typeof text === "string" ? text : "";
  if (!source) {
    return [];
  }
  const terms = splitSearchTerms(query);
  if (!terms.length) {
    return [{ text: source, match: false }];
  }
  const spans = matchSpans(source, terms);
  if (!spans.length) {
    return [{ text: source, match: false }];
  }
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [from, to] of spans) {
    const start = Math.max(cursor, Math.min(from, source.length));
    const end = Math.max(start, Math.min(to, source.length));
    if (start > cursor) {
      segments.push({ text: source.slice(cursor, start), match: false });
    }
    if (end > start) {
      segments.push({ text: source.slice(start, end), match: true });
    }
    cursor = end;
  }
  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor), match: false });
  }
  return segments;
}

/**
 * 摘要开窗：命中往往不在摘要开头，直接把 200 字全渲染出来，用户看不到"为什么这篇命中了"。
 *
 * 取第一个命中位置往前 `lead` 个字开窗，长度 `windowChars`；前面还有内容就补 `…`。
 * ⚠️ 返回的仍然是**原文切片**（不是拼接出来的字符串），所以高亮下标继续有效。
 */
export function snippetWindow(
  text: unknown,
  query: unknown,
  windowChars = 140,
  lead = 40,
): string {
  const source = typeof text === "string" ? text : "";
  if (!source) {
    return "";
  }
  const size = Math.max(20, Math.floor(windowChars));
  if (source.length <= size) {
    return source;
  }
  const spans = matchSpans(source, splitSearchTerms(query));
  const first = spans.length ? spans[0][0] : 0;
  const from = Math.max(0, Math.min(first - Math.max(0, lead), source.length - size));
  return `${from > 0 ? "…" : ""}${source.slice(from, from + size)}`;
}

/** 查询回显（结果页标题"关于 xxx 的搜索结果"）也要有长度上限，别让人拿 URL 撑爆标题 */
export function displayQuery(query: unknown): string {
  const text = typeof query === "string" ? query : "";
  const clipped = text.slice(0, MAX_QUERY_CHARS);
  return clipped.trim();
}
