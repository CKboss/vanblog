import { BadRequestException } from '@nestjs/common';
import * as dns from 'dns';
import { URL } from 'url';

/**
 * 文章导出成 Markdown 的公共逻辑（纯函数，方便单测）：
 * 图片引用识别、链接改写、front matter 生成、文件名安全化、远程目标安全校验。
 *
 * 约定：`.mdz` = 一个 zip 包，里面是 `<标题>.md`（图片链接已改成相对路径）+
 * `<标题>.assets/` 图片目录（Typora 风格）。另附一个**原样**的 `<标题>.md`（链接不改）。
 */

export const ASSETS_SUFFIX = '.assets';
export const MDZ_SUFFIX = '.mdz';

export interface ImageRef {
  /** 原文里的 url 文本 */
  url: string;
  /** url 在全文中的字符偏移（用于精确改写，不会误伤代码块里的同样文本） */
  start: number;
  end: number;
  syntax: 'md' | 'html' | 'reference';
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** 把代码块与行内代码「涂黑」成等长占位符，偏移量保持不变。 */
export function maskCodeRegions(source: string): string {
  const NUL = '\u0000';
  const lines = source.split('\n');
  let fence = '';
  const out: string[] = [];
  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
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
    out.push(maskInlineCode(line));
  }
  return out.join('\n');
}

function maskInlineCode(line: string): string {
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

function isMasked(masked: string, start: number, end: number): boolean {
  return masked.slice(start, end).includes('\u0000');
}

/**
 * 找出正文里所有图片引用（`![]()`、`<img src>`、`![][ref]` + 定义行）。
 * 代码块 / 行内代码里的「长得像图片」的文本会被跳过。
 */
export function extractImageRefs(source: string): ImageRef[] {
  if (!source) {
    return [];
  }
  const masked = maskCodeRegions(source);
  const refs: ImageRef[] = [];

  // 1) 引用式定义 [label]: url —— 改写时改定义行，用到处不用动
  const definitions = new Map<string, { url: string; start: number; end: number }>();
  const defRe = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/gm;
  let defMatch: RegExpExecArray | null;
  while ((defMatch = defRe.exec(masked))) {
    if (isMasked(masked, defMatch.index, defMatch.index + defMatch[0].length)) {
      continue;
    }
    const label = defMatch[1].trim().toLowerCase();
    const raw = defMatch[2].replace(/^<|>$/g, '');
    if (!raw) {
      continue;
    }
    // 定义行里 url 的偏移：整段匹配尾部就是 url
    const end = defMatch.index + defMatch[0].length;
    const start = end - defMatch[2].length + (defMatch[2].startsWith('<') ? 1 : 0);
    if (!definitions.has(label)) {
      definitions.set(label, { url: raw, start, end: start + raw.length });
    }
  }

  // 2) ![](...)
  const mdRe = /!\[([^\]]*)\]\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(masked))) {
    if (isMasked(masked, m.index, m.index + m[0].length)) {
      continue;
    }
    const inner = m[2];
    const lead = inner.length - inner.trimStart().length;
    const trimmed = inner.trimStart();
    let urlText = '';
    let urlOffsetInInner = lead;
    if (trimmed.startsWith('<')) {
      const close = trimmed.indexOf('>');
      if (close < 0) {
        continue;
      }
      urlText = trimmed.slice(1, close);
      urlOffsetInInner = lead + 1;
    } else {
      const spaceIdx = trimmed.search(/\s/);
      urlText = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
    }
    if (!urlText) {
      continue;
    }
    // m[0] = "![alt](" + inner + ")"，所以 inner 的起点是倒数第二段
    const innerStart = m.index + m[0].length - inner.length - 1;
    refs.push({
      url: urlText,
      start: innerStart + urlOffsetInInner,
      end: innerStart + urlOffsetInInner + urlText.length,
      syntax: 'md',
    });
  }

  // 3) <img src="...">
  const htmlRe = /<img\b[^>]*>/gi;
  while ((m = htmlRe.exec(masked))) {
    if (isMasked(masked, m.index, m.index + m[0].length)) {
      continue;
    }
    const srcRe = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;
    const sm = srcRe.exec(m[0]);
    if (!sm) {
      continue;
    }
    const value = sm[2] ?? sm[3] ?? sm[4] ?? '';
    if (!value) {
      continue;
    }
    // 值的起点 = 跳过 `src`、空白、`=`、空白和可能的引号。
    // 不能用「匹配长度 - 值长度」倒推：带引号时尾部还有一个引号，会整体偏移一位
    // （实测会把 `src="/static/x.webp"` 改成 `src="/assets/x.webp width=...`，吃掉闭引号）。
    const prefix = /^\s*src\s*=\s*["']?/i.exec(sm[0]);
    const valueOffset = sm.index + (prefix ? prefix[0].length : sm[0].length - value.length);
    refs.push({
      url: value,
      start: m.index + valueOffset,
      end: m.index + valueOffset + value.length,
      syntax: 'html',
    });
  }

  // 4) ![alt][label] —— 指向定义行里的 url
  const refUseRe = /!\[[^\]]*\]\[([^\]]*)\]/g;
  while ((m = refUseRe.exec(masked))) {
    if (isMasked(masked, m.index, m.index + m[0].length)) {
      continue;
    }
    const label = (m[1] || '').trim().toLowerCase();
    const def = definitions.get(label);
    if (!def) {
      continue;
    }
    if (!refs.some((r) => r.start === def.start && r.end === def.end)) {
      refs.push({ ...def, syntax: 'reference' });
    }
  }

  return refs.sort((a, b) => a.start - b.start);
}

/** 按偏移精确改写图片链接（同一 url 出现多次会全部改写）。 */
export function rewriteImageUrls(source: string, mapping: Map<string, string>): string {
  const refs = extractImageRefs(source).filter((ref) => mapping.has(ref.url));
  if (!refs.length) {
    return source;
  }
  let out = '';
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start < cursor) {
      continue;
    }
    out += source.slice(cursor, ref.start) + mapping.get(ref.url);
    cursor = ref.end;
  }
  return out + source.slice(cursor);
}

export type ImageKind = 'local' | 'remote' | 'skip';

export interface ClassifiedImage {
  kind: ImageKind;
  /** kind=local 时，相对静态目录的路径，例如 `img/abc.webp` */
  staticRel?: string;
  /** kind=remote 时，规范化后的绝对地址 */
  absolute?: string;
  reason?: string;
}

/**
 * 判断一个图片地址是「本站静态目录里的文件」还是「外链」。
 * 只有 `/static/...`（含带自己域名的绝对形式）才算本地，其余一律不外推。
 */
export function classifyImageUrl(rawUrl: string, baseUrl?: string): ClassifiedImage {
  const url = String(rawUrl || '').trim();
  if (!url) {
    return { kind: 'skip', reason: '空链接' };
  }
  if (/^data:/i.test(url)) {
    return { kind: 'skip', reason: 'data URI，已内嵌在正文里' };
  }
  if (url.startsWith('/static/')) {
    return { kind: 'local', staticRel: decodeURIComponent(url.slice('/static/'.length)) };
  }
  if (/^https?:\/\//i.test(url) || url.startsWith('//')) {
    const absolute = url.startsWith('//') ? `https:${url}` : url;
    let parsed: URL;
    try {
      parsed = new URL(absolute);
    } catch {
      return { kind: 'skip', reason: '链接解析失败' };
    }
    const sameSite = baseUrl ? sameOrigin(parsed, baseUrl) : false;
    if (parsed.pathname.startsWith('/static/') && sameSite) {
      return { kind: 'local', staticRel: decodeURIComponent(parsed.pathname.slice('/static/'.length)) };
    }
    return { kind: 'remote', absolute: parsed.toString() };
  }
  return { kind: 'skip', reason: '相对路径无法定位到具体文件' };
}

function sameOrigin(parsed: URL, baseUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    return parsed.origin === base.origin;
  } catch {
    return false;
  }
}

const PRIVATE_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
  /\.local$/i,
  /\.internal$/i,
];

export function isPrivateAddress(host: string): boolean {
  return PRIVATE_PATTERNS.some((re) => re.test(host));
}

/**
 * 外链抓取前的安全检查：只允许 http/https，且目标不能是内网/回环地址
 * （否则协作者可以借导出功能探测内网 —— 典型 SSRF）。
 */
export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException(`图片地址无法解析：${rawUrl}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BadRequestException(`只支持 http/https 图片：${rawUrl}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateAddress(host)) {
    throw new BadRequestException(`拒绝抓取内网地址：${host}`);
  }
  // 域名可能解析到内网 IP（DNS rebinding），也要挡
  try {
    const addresses = await new Promise<string[]>((resolve, reject) => {
      dns.lookup(host, { all: true }, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve((result || []).map((item) => item.address));
      });
    });
    if (addresses.some((addr) => isPrivateAddress(addr))) {
      throw new BadRequestException(`拒绝抓取解析到内网的地址：${host}`);
    }
  } catch (err) {
    if (err instanceof BadRequestException) {
      throw err;
    }
    throw new BadRequestException(`图片域名解析失败：${host}`);
  }
  return parsed;
}

/** 用文章对象拼 front matter（与后台导入用的 front-matter 格式对齐）。 */
export function buildFrontMatter(obj: Record<string, any>): string {
  const keys = [
    'title',
    'pathname',
    'category',
    'tags',
    'top',
    'createdAt',
    'updatedAt',
    'hidden',
    'private',
    'password',
    'cover',
  ];
  const lines: string[] = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj || {}, key)) {
      continue;
    }
    const value = obj[key];
    // 空值与 false 都不写：top/hidden/private 默认就是 false，写进去只是噪音
    if (value === undefined || value === null || value === '' || value === false) {
      continue;
    }
    if (key === 'tags') {
      if (Array.isArray(value) && value.length) {
        lines.push(`tags: [${value.map((tag) => yamlScalar(tag)).join(', ')}]`);
      }
      continue;
    }
    if (['createdAt', 'updatedAt'].includes(key)) {
      const iso = toIsoString(value);
      if (iso) {
        lines.push(`${key}: ${iso}`);
      }
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function toIsoString(value: any): string | null {
  try {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

/** 最小子集的 YAML 标量输出：需要时加引号，避免标题里有冒号就把 front matter 弄坏。 */
export function yamlScalar(value: any): string {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  const text = String(value ?? '');
  if (text === '') {
    return "''";
  }
  const needsQuote =
    /[\s]/.test(text) ||
    /[:#&*!|>'"%@`,\[\]{}]/.test(text) ||
    /^[-?](\s|$)/.test(text) ||
    ['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~'].includes(text.toLowerCase());
  if (!needsQuote) {
    return text;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * 文件名安全化：去掉路径分隔符/控制字符，限长，保证非空。
 *
 * 空格和 `()[]{}'"#%` 一并换成 `-`：这些字符出现在图片目录名里时，markdown 链接目标
 * 需要转义或百分号编码，而各家编辑器（Typora / Obsidian / VSCode）支持程度不一致，
 * 干脆在文件名层面消掉。标题原文仍在 front matter 里，导入回来不会丢。
 */
export function safeExportName(title: unknown, fallback = 'untitled'): string {
  let name = String(title ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\s()\[\]{}'"#%]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  if (!name) {
    name = fallback;
  }
  // Windows 保留名
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    name = `_${name}`;
  }
  // 还要给 `.assets/` 和 `.mdz` 留位置，所以标题限长 80
  if (name.length > 80) {
    name = name.slice(0, 80).trim();
  }
  return name;
}

/** assets 目录名（Typora 风格：与 md 同名 + .assets） */
export function assetsDirName(title: unknown): string {
  return `${safeExportName(title)}${ASSETS_SUFFIX}`;
}

/**
 * 给 assets 里的文件起名：保留原扩展名，冲突时加序号。
 * 返回 [文件名, 是否需要更新映射]。
 */
export function uniqueAssetName(baseName: string, taken: Set<string>): string {
  const cleaned = String(baseName || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const name = cleaned || 'image';
  if (!taken.has(name.toLowerCase())) {
    taken.add(name.toLowerCase());
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * markdown 里写的相对路径。目录名与文件名都已经被 `safeExportName` / `uniqueAssetName`
 * 洗过（没有空格、括号、`#`、`%`），所以这里不需要转义，也不做 encodeURI —— 中文保持原样，
 * Typora / Obsidian / VSCode 都能直接解析。
 */
export function toRelativeLink(assetsDir: string, fileName: string): string {
  return `${assetsDir}/${fileName}`;
}
