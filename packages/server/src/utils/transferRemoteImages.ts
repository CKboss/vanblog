import { maskCodeRegions } from './markdownExport';
export type ImageRef = {
  url: string;
  raw: string;
  index: number;
};

export type ImageUrlKind = 'remote' | 'skip';

export type ClassifyImageUrlResult = {
  kind: ImageUrlKind;
  reason?: string;
};

export type TransferRemoteResult = {
  content: string;
  transferred: Array<{ from: string; to: string }>;
  skipped: Array<{ url: string; reason: string }>;
  failed: Array<{ url: string; reason: string }>;
};

const MARKDOWN_IMAGE =
  /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
/**
 * 同两个模式的「非全局」版本。
 *
 * ⚠️ 以前是每匹配到一张图就 `new RegExp(source, flags)` **现场编译一个**：
 * 一篇有 20 张图的文章 = 2 + 2×20 = 42 次正则编译，而 `extractImageRefs`
 * 现在跑在**每一次公开列表请求的每一篇文章**上（`pickCoverFromContent` 取首图，
 * 见 ArticleProvider.getByOption 的 withExcerpt）。模式是模块级常量，编译一次就够。
 */
const MARKDOWN_IMAGE_ONCE = new RegExp(MARKDOWN_IMAGE.source, '');
const HTML_IMAGE_ONCE = new RegExp(HTML_IMAGE.source, 'i');

export function extractImageRefs(content: string): ImageRef[] {
  if (!content) {
    return [];
  }
  // 「本地化远程图片」以前会连代码块/行内代码里的示例一起改写并去下载，
  // 教程类文章里的 ```md 示例会被悄悄改成本地链接（内容损坏）。
  // 做法与导出功能一致：把代码区涂黑成等长占位，用占位串跑正则拿偏移，再回原文取真实内容。
  const masked = maskCodeRegions(content);
  const refs: ImageRef[] = [];
  const collect = (re: RegExp, once: RegExp, pick: (m: RegExpExecArray) => string) => {
    // 复用的是模块级的全局正则：必须每次归零 lastIndex（上一次调用中途抛错也会留下状态）。
    // 这里全程同步、没有 await，所以不存在两次调用交错的问题。
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(masked)) !== null) {
      const raw = content.slice(match.index, match.index + match[0].length);
      const exact = once.exec(raw);
      refs.push({ url: (exact ? pick(exact) : '').trim(), raw, index: match.index });
    }
    re.lastIndex = 0;
  };
  collect(MARKDOWN_IMAGE, MARKDOWN_IMAGE_ONCE, (m) => m[2] || '');
  collect(HTML_IMAGE, HTML_IMAGE_ONCE, (m) => m[1] || m[2] || m[3] || '');
  return refs.sort((a, b) => a.index - b.index);
}

export function collectSiteHosts(siteBaseUrl?: string, extraHosts?: Array<string | undefined>): string[] {
  const hosts = new Set<string>();
  const add = (raw?: string) => {
    if (!raw || typeof raw !== 'string') {
      return;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    try {
      if (/^https?:\/\//i.test(trimmed)) {
        hosts.add(new URL(trimmed).hostname.toLowerCase());
        return;
      }
      const host = trimmed
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '')
        .toLowerCase();
      if (host) {
        hosts.add(host);
      }
    } catch {
      // ignore unparseable values
    }
  };
  add(siteBaseUrl);
  extraHosts?.forEach(add);
  // Array.from 而不是 [...hosts]：本文件还会被 website 项目（target es5，无
  // downlevelIteration）跨包类型检查（__tests__/articleExcerptParity.spec.ts），
  // Set 的展开语法在那里报 TS2802。两者运行时语义完全一致（同样的插入顺序），
  // server 自己的产物（target es2017）行为不变。
  return Array.from(hosts);
}

export function classifyImageUrl(
  url: string,
  opts: { siteHosts?: string[]; knownRealPaths?: string[] } = {},
): ClassifyImageUrlResult {
  const raw = (url || '').trim();
  if (!raw) {
    return { kind: 'skip', reason: 'empty' };
  }
  if (/^data:/i.test(raw)) {
    return { kind: 'skip', reason: 'data-url' };
  }
  if (/^(blob:|javascript:|about:)/i.test(raw)) {
    return { kind: 'skip', reason: 'non-http' };
  }
  if (!/^https?:\/\//i.test(raw)) {
    return { kind: 'skip', reason: 'relative' };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { kind: 'skip', reason: 'invalid' };
  }

  const host = parsed.hostname.toLowerCase();
  const siteHosts = (opts.siteHosts || []).map((h) => h.toLowerCase());
  if (siteHosts.includes(host)) {
    return { kind: 'skip', reason: 'same-origin' };
  }

  const known = (opts.knownRealPaths || []).filter(Boolean);
  if (known.includes(raw) || known.includes(stripUrlExtras(raw))) {
    return { kind: 'skip', reason: 'already-stored' };
  }

  return { kind: 'remote' };
}

export function stripUrlExtras(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('#')[0].split('?')[0];
  }
}

export function filenameFromRemote(url: string, contentType?: string): string {
  let name = 'remote';
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || 'remote';
    name = decodeURIComponent(last);
  } catch {
    const last = url.split('/').pop() || 'remote';
    name = last.split('?')[0].split('#')[0];
  }
  name = name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'remote';
  if (!/\.[a-zA-Z0-9]{2,8}$/.test(name)) {
    name = `${name}.${extFromContentType(contentType)}`;
  }
  return name.slice(0, 180);
}

export function extFromContentType(contentType?: string): string {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
  };
  return map[type] || 'png';
}

export function looksLikeImage(buffer: Buffer, contentType?: string): boolean {
  if (!buffer || buffer.length < 4) {
    return false;
  }
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('image/')) {
    return true;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return true;
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return true;
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49) {
    return true;
  }
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer.slice(8, 12).toString() === 'WEBP') {
    return true;
  }
  if (buffer.length > 12 && buffer.slice(4, 8).toString() === 'ftyp') {
    return true;
  }
  return false;
}

export function applyImageUrlMap(content: string, urlMap: Map<string, string>): string {
  if (!content || !urlMap.size) {
    return content || '';
  }
  const refs = extractImageRefs(content).sort((a, b) => b.index - a.index);
  let out = content;
  for (const ref of refs) {
    const next = urlMap.get(ref.url);
    if (!next || next === ref.url) {
      continue;
    }
    const replaced = ref.raw.includes(ref.url) ? ref.raw.replace(ref.url, next) : ref.raw;
    out = out.slice(0, ref.index) + replaced + out.slice(ref.index + ref.raw.length);
  }
  return out;
}

export function emptyTransferResult(content = ''): TransferRemoteResult {
  return {
    content: content || '',
    transferred: [],
    skipped: [],
    failed: [],
  };
}
