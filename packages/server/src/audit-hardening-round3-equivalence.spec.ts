import {
  articleOverviewMarkdown,
  findMoreMarker,
  MARKER_EXCERPT_MAX_CHARS,
} from './utils/articleExcerpt';
import { maskCodeRegions } from './utils/markdownExport';
import { extractImageRefs } from './utils/transferRemoteImages';
import { pickCoverFromContent } from './utils/coverFromContent';

/**
 * 「热路径优化必须一个字节都不改输出」的对拍测试。
 *
 * 下面 `OLD_*` 那一组是**改动前实现的逐字拷贝**（冻结的参照物，不要跟着改）：
 *  - `OLD_findMoreMarker` / `OLD_articleOverviewMarkdown`：改动把"扫全文找代码区/链接区"
 *    变成"扫到最后一个标记就停"、"链接起点超过截断点就停"；
 *  - `OLD_maskCodeRegions` / `OLD_maskInlineCode`：改动把逐字符 `result += ch`
 *    换成 indexOf + slice，并加了"没有反引号也没有波浪线就直接返回原文"的快速路径；
 *  - `OLD_extractImageRefs`：改动把"每张图现场 `new RegExp`"换成模块级预编译。
 *
 * 为什么要对拍而不是只跑既有用例：这几条链上挂着
 * `packages/website/__tests__/articleExcerptParity.spec.ts`（server 与前台两份实现
 * 必须逐字符一致），任何一处语义漂移都会让"ISR 重渲染前后卡片文字不一样"。
 * 随机向量用**固定种子**生成，失败可复现。
 */

/* ------------------------------------------------------------------ *
 * 冻结的参照实现（改动前的逐字拷贝）
 * ------------------------------------------------------------------ */
const MORE_MARKER = '<!-- more -->';

function OLD_keepSurrogatePairsWhole(source: string, end: number): number {
  if (end <= 0 || end >= source.length) {
    return end;
  }
  const last = source.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

function OLD_skipSpace(source: string, i: number): number {
  while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\n')) {
    i++;
  }
  return i;
}

function OLD_indexOfUnescaped(source: string, ch: string, from: number): number {
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

function OLD_scanUnquotedDestination(source: string, start: number): number {
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

function OLD_findLinkCloseParen(source: string, destStart: number): number {
  let i = OLD_skipSpace(source, destStart);
  if (i >= source.length) {
    return -1;
  }
  if (source[i] === '<') {
    const gt = OLD_indexOfUnescaped(source, '>', i + 1);
    if (gt === -1) {
      return -1;
    }
    i = gt + 1;
  } else {
    const destEnd = OLD_scanUnquotedDestination(source, i);
    if (destEnd === -1) {
      return -1;
    }
    if (source[destEnd] === ')' && destEnd === OLD_skipSpace(source, destEnd)) {
      return destEnd;
    }
    i = destEnd;
  }
  i = OLD_skipSpace(source, i);
  if (source[i] === '"' || source[i] === "'") {
    const q = source[i];
    const close = OLD_indexOfUnescaped(source, q, i + 1);
    if (close === -1) {
      return -1;
    }
    i = OLD_skipSpace(source, close + 1);
  } else if (source[i] === '(') {
    const close = OLD_indexOfUnescaped(source, ')', i + 1);
    if (close === -1) {
      return -1;
    }
    i = OLD_skipSpace(source, close + 1);
  }
  return source[i] === ')' ? i : -1;
}

function OLD_findMatchingRBracket(source: string, openIdx: number): number {
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

function OLD_findLinkOpen(source: string, from: number): number {
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

function OLD_inlineLinkRanges(source: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < source.length) {
    const start = OLD_findLinkOpen(source, i);
    if (start === -1) {
      break;
    }
    const textClose = OLD_findMatchingRBracket(source, start);
    if (textClose === -1 || source[textClose + 1] !== '(') {
      i = start + 1;
      continue;
    }
    const destClose = OLD_findLinkCloseParen(source, textClose + 2);
    if (destClose === -1) {
      i = start + 1;
      continue;
    }
    ranges.push({ start, end: destClose + 1 });
    i = destClose + 1;
  }
  return ranges;
}

function OLD_completeTruncatedInlineLinks(source: string, maxChars: number): string {
  let end = maxChars;
  for (const range of OLD_inlineLinkRanges(source)) {
    if (range.start < maxChars && range.end > maxChars) {
      end = Math.max(end, range.end);
    }
  }
  return source.slice(0, OLD_keepSurrogatePairsWhole(source, end));
}

function OLD_findMoreMarker(content: string): number {
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

// stripFrontMatter 本轮没改，直接复用现网实现（它不在这次优化的范围里）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stripFrontMatter } = require('./utils/frontMatter');

function OLD_articleOverviewMarkdown(content: string, maxChars = 200): string {
  if (!content) {
    return content;
  }
  const body = stripFrontMatter(content);
  const cut = OLD_findMoreMarker(body);
  if (cut >= 0) {
    return body.slice(0, cut);
  }
  if (body.length <= maxChars) {
    return body;
  }
  return OLD_completeTruncatedInlineLinks(body, maxChars);
}

function OLD_maskInlineCode(line: string): string {
  const NUL = '\u0000';
  let result = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '`') {
      let run = 0;
      while (line[i + run] === '`') {
        run += 1;
      }
      const closer = line.indexOf('`'.repeat(run), i + run);
      if (closer >= 0) {
        result += NUL.repeat(closer + run - i);
        i = closer + run;
        continue;
      }
      result += ch.repeat(run);
      i += run;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

const OLD_FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

function OLD_maskCodeRegions(source: string): string {
  const NUL = '\u0000';
  const lines = source.split('\n');
  let fence = '';
  const out: string[] = [];
  for (const line of lines) {
    const fenceMatch = line.match(OLD_FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0].repeat(3);
      if (!fence) {
        fence = marker;
        out.push(NUL.repeat(line.length));
        continue;
      }
      if (marker === fence) {
        fence = '';
        out.push(NUL.repeat(line.length));
        continue;
      }
    }
    if (fence) {
      out.push(NUL.repeat(line.length));
      continue;
    }
    out.push(OLD_maskInlineCode(line));
  }
  return out.join('\n');
}

const OLD_MARKDOWN_IMAGE =
  /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const OLD_HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function OLD_extractImageRefs(content: string) {
  if (!content) {
    return [];
  }
  const masked = OLD_maskCodeRegions(content);
  const refs: Array<{ url: string; raw: string; index: number }> = [];
  const collect = (source: string, flags: string, pick: (m: RegExpExecArray) => string) => {
    const re = new RegExp(source, flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(masked)) !== null) {
      const raw = content.slice(match.index, match.index + match[0].length);
      const exact = new RegExp(source, flags.replace('g', '')).exec(raw);
      refs.push({ url: (exact ? pick(exact) : '').trim(), raw, index: match.index });
    }
  };
  collect(OLD_MARKDOWN_IMAGE.source, 'g', (m) => m[2] || '');
  collect(OLD_HTML_IMAGE.source, 'gi', (m) => m[1] || m[2] || m[3] || '');
  return refs.sort((a, b) => a.index - b.index);
}

function OLD_pickCoverFromContent(content: unknown, options?: { preferLocal?: boolean }) {
  const text = String(content ?? '');
  if (!text) {
    return null;
  }
  const preferLocal = options?.preferLocal !== false;
  const refs = OLD_extractImageRefs(text);
  let firstUsable: string | null = null;
  const usable = (url: string) => {
    const value = String(url ?? '').trim();
    if (!value || value.length > 2000) return false;
    if (/^data:/i.test(value)) return false;
    if (/^https?:\/\//i.test(value)) return true;
    if (value.startsWith('//')) return true;
    return value.startsWith('/static/');
  };
  for (const ref of refs) {
    const url = String(ref?.url ?? '').trim();
    if (!usable(url)) continue;
    if (!firstUsable) firstUsable = url;
    if (!preferLocal || url.startsWith('/static/')) return url;
  }
  return firstUsable;
}

/* ------------------------------------------------------------------ *
 * 向量
 * ------------------------------------------------------------------ */

/** 固定种子的伪随机（失败可复现，不依赖 Math.random） */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PIECES = [
  '普通中文段落，含标点。',
  'plain english text',
  '`inline code`',
  '``double ` tick``',
  '未闭合的反引号 ` 就这样',
  '```\nfenced block\n```\n',
  '```md\n![示例](/static/img/a.webp)\n<!-- more -->\n```\n',
  '~~~\ntilde fence\n~~~\n',
  '   ```\n缩进三格以内的围栏\n   ```\n',
  '    ```\n缩进四格 = 代码块但不是围栏\n    ```\n',
  '<!-- more -->',
  '前文 <!-- more --> 后文',
  '`<!-- more -->`',
  '[链接文字](https://example.com/a/1?x=1&y=2)',
  '[截断在中间的链接](https://example.com/very/long/path)',
  '![图片](/static/img/pic.webp)',
  '![图片 <带尖括号>](</static/img/space path.webp>)',
  '<img src="https://cdn.example.com/x.png" alt="x">',
  "<img src='/static/img/y.webp'>",
  '<img src=/static/img/z.webp>',
  '\\[转义的方括号\\](not-a-link)',
  '[嵌套 [方括号] 的链接](/a)',
  '[带标题的链接](/a "标题")',
  '[带括号标题](/a (标题))',
  '![引用式][ref]\n\n[ref]: /static/img/ref.webp\n',
  'emoji 😀🎉 代理对',
  '\r\nCRLF 行尾\r\n',
  '---\ntitle: x\n---\n',
  '',
  '\n\n',
  'data:image/png;base64,AAAA 这种不该被选中',
  '[未闭合的链接](/nope',
  '](反向的)',
  '![',
  '`',
  '``',
];

function randomDoc(rng: () => number, pieces: number): string {
  const out: string[] = [];
  for (let i = 0; i < pieces; i += 1) {
    out.push(PIECES[Math.floor(rng() * PIECES.length) % PIECES.length]);
  }
  return out.join(rng() < 0.5 ? '\n' : '\n\n');
}

const HANDPICKED = [
  '',
  '短文本',
  MORE_MARKER,
  `${MORE_MARKER}后面的内容`,
  `前面的内容${MORE_MARKER}`,
  '```md\n' + MORE_MARKER + '\n```\n真的正文',
  '```\n未闭合的围栏\n' + MORE_MARKER,
  '~~~\n' + MORE_MARKER + '\n~~~\n' + MORE_MARKER,
  '`' + MORE_MARKER + '` 之后 ' + MORE_MARKER,
  'x'.repeat(199) + '[链接](https://example.com/aaaaaaaaaaaaaaaaaaaa)',
  'y'.repeat(200) + ' 后面还有很多字'.repeat(50),
  'z'.repeat(198) + '😀' + 'w'.repeat(100),
  'a'.repeat(190) + '[文字](/u' + 'b'.repeat(500) + ')',
  '没有标记的长文' + 'x'.repeat(5000),
  '```' + '`'.repeat(10) + '\ncode\n```',
  '行内 `a` 与 ``b`c`` 与 ```d``` 混排',
  '<!-- more -->'.repeat(5),
  '前 `.split("\n")` 后 ' + MORE_MARKER + ' 再后 `x`',
  '\n'.repeat(50) + MORE_MARKER,
  '![图](/static/img/a.webp) 文字 ![图2](https://x.example/b.png) <img src="/static/img/c.webp">',
  '|'.repeat(300) + '[链接](' + '/'.repeat(2000) + ')',
];

function allVectors(): string[] {
  const rng = makeRng(20260916);
  const docs: string[] = [...HANDPICKED];
  for (let i = 0; i < 400; i += 1) {
    docs.push(randomDoc(rng, 2 + Math.floor(rng() * 12)));
  }
  // 长文：确保"提前停下"的分支真的被走到（正文远长于 200 字）
  for (let i = 0; i < 20; i += 1) {
    const body = randomDoc(rng, 40);
    docs.push(body + '\n\n' + 'x'.repeat(5000));
    docs.push(body.slice(0, 100) + MORE_MARKER + '\n\n' + body + 'y'.repeat(5000));
  }
  return docs;
}

describe('摘要/首图/代码区涂黑：优化后与改动前逐字节一致', () => {
  const docs = allVectors();

  it(`findMoreMarker：${docs.length} 个向量全部相同`, () => {
    let withMarker = 0;
    for (const doc of docs) {
      const now = findMoreMarker(doc);
      const before = OLD_findMoreMarker(doc);
      if (before >= 0) withMarker += 1;
      if (now !== before) {
        throw new Error(
          `findMoreMarker 不一致：new=${now} old=${before}\n---\n${JSON.stringify(
            doc.slice(0, 400),
          )}`,
        );
      }
    }
    // 反证：向量里确实有"标记在代码区里"的情况，否则这条对拍是空的
    expect(withMarker).toBeGreaterThan(50);
  });

  // 🔴 2026-09-22 升级（**不是放宽**）：这条对拍原本钉的是"一次纯优化重构没有改变输出"，
  //    所以要求全部向量逐字节相同。R4-11 给标记分支加了硬上限，**契约有意变了**，
  //    于是这里改成：上限不生效时仍要求逐字节相同；上限生效时只允许"内容一致、截得更早"这一种偏离。
  //    ⚠️ 断言因此仍然很强：偏离形状被逐个条件卡死，且必须真的被走到（capped > 0），
  //    否则"改坏了输出"照样红 —— 这与把对拍删掉或改成恒真是两回事。
  it(`articleOverviewMarkdown：${docs.length} 个向量在上限不生效时逐字节相同，生效时只允许截得更早`, () => {
    let nonTrivial = 0;
    let capped = 0;
    for (const doc of docs) {
      const now = articleOverviewMarkdown(doc);
      const before = OLD_articleOverviewMarkdown(doc);
      if (before.length > 0) nonTrivial += 1;
      if (now === before) continue;
      const shared = Math.min(now.length, before.length);
      const samePrefix = now.slice(0, shared) === before.slice(0, shared);
      if (
        !samePrefix ||
        before.length <= MARKER_EXCERPT_MAX_CHARS ||
        now.length >= before.length ||
        now.length < MARKER_EXCERPT_MAX_CHARS - 1 // -1：不把代理对切成两半时会少一个字符
      ) {
        throw new Error(
          `articleOverviewMarkdown 出现了上限解释不了的偏离：new(len ${now.length}) vs old(len ${
            before.length
          }) samePrefix=${samePrefix} cap=${MARKER_EXCERPT_MAX_CHARS}\nnew=${JSON.stringify(
            now.slice(0, 120),
          )}\nold=${JSON.stringify(before.slice(0, 120))}\n---\n${JSON.stringify(
            doc.slice(0, 400),
          )}`,
        );
      }
      capped += 1;
    }
    expect(nonTrivial).toBeGreaterThan(50);
    // 反证：向量集里必须真的有"标记超过上限"的文档，否则上面那条放宽是空的
    expect(capped).toBeGreaterThan(0);
  });

  it(`maskCodeRegions：${docs.length} 个向量全部相同（含长度不变这条硬约束）`, () => {
    let masked = 0;
    for (const doc of docs) {
      const now = maskCodeRegions(doc);
      const before = OLD_maskCodeRegions(doc);
      if (before.includes('\u0000')) masked += 1;
      if (now !== before) {
        throw new Error(
          `maskCodeRegions 不一致：\nnew=${JSON.stringify(now.slice(0, 200))}\nold=${JSON.stringify(
            before.slice(0, 200),
          )}\n---\n${JSON.stringify(doc.slice(0, 300))}`,
        );
      }
      // 偏移量语义的前提：涂黑前后长度必须相同（extractImageRefs 靠它回原文取内容）
      expect(now.length).toBe(doc.length);
    }
    expect(masked).toBeGreaterThan(50);
  });

  it(`extractImageRefs：${docs.length} 个向量全部相同`, () => {
    let found = 0;
    for (const doc of docs) {
      const now = extractImageRefs(doc);
      const before = OLD_extractImageRefs(doc);
      found += before.length;
      expect(JSON.stringify(now)).toBe(JSON.stringify(before));
    }
    expect(found).toBeGreaterThan(50);
  });

  it(`pickCoverFromContent：${docs.length} 个向量、两种 preferLocal 全部相同`, () => {
    let picked = 0;
    for (const doc of docs) {
      for (const preferLocal of [true, false]) {
        const now = pickCoverFromContent(doc, { preferLocal });
        const before = OLD_pickCoverFromContent(doc, { preferLocal });
        if (before) picked += 1;
        expect(now).toBe(before);
      }
    }
    expect(picked).toBeGreaterThan(20);
  });

  it('模块级复用的全局正则不会带着上一次的 lastIndex 进来（连续两次调用结果相同）', () => {
    const doc = '![a](/static/1.webp) 文字 ![b](/static/2.webp) <img src="/static/3.webp">';
    const first = extractImageRefs(doc);
    const second = extractImageRefs(doc);
    const third = extractImageRefs(doc);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    expect(first.length).toBe(3);
  });
});
