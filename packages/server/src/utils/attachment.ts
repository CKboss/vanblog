import { BadRequestException } from '@nestjs/common';
import * as path from 'path';
import { formatBytes } from './size';

/**
 * Attachments ("附件管理") live next to the image bed but are not images:
 * arbitrary files uploaded from the admin, stored as `<static>/file/<md5>.<name>`
 * and served at `/static/file/<md5>.<name>`.
 *
 * Two things matter here:
 * 1. the stored name must be safe (no path traversal, no header-breaking chars);
 * 2. types that a browser would *execute* in our origin (html/svg/js/xml…) must
 *    be forced to download, otherwise an uploaded file is stored XSS on the blog.
 */

/** Folder name under the static root; also the `StaticType` value. */
export const ATTACHMENT_FOLDER = 'file';

/** Per-file upload cap (200 MB). Multer enforces it too; this is the fallback. */
export const ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024;

/** `<md5>.` prefix that the stored name carries but users should not see. */
const SIGN_PREFIX = /^[a-f0-9]{32}\./i;

/** Long names get truncated, extension first. */
const MAX_NAME_LENGTH = 160;

const FORCED_DOWNLOAD_EXTS = [
  'html',
  'htm',
  'shtml',
  'xhtml',
  'xht',
  'svg',
  'svgz',
  'xml',
  'xsl',
  'xslt',
  'js',
  'mjs',
  'cjs',
  'mhtml',
  'mht',
];

export function attachmentExtOf(fileName: unknown): string {
  const name = String(fileName ?? '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
}

/** True when serving this extension inline would run markup/script in our origin. */
export function isForcedDownloadExt(ext: unknown): boolean {
  return FORCED_DOWNLOAD_EXTS.includes(String(ext ?? '').toLowerCase());
}

/**
 * busboy/multer decodes the multipart `filename` as latin1, while browsers
 * actually send UTF-8 bytes — so 中文名.pdf arrives as "ä¸­æ–‡å.pdf".
 * Re-decode only when there are high bytes and the result is valid UTF-8,
 * which leaves pure-ASCII names untouched.
 */
export function decodeUploadFileName(originalName: unknown): string {
  const raw = String(originalName ?? '');
  if (!raw) {
    return '';
  }
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(raw)) {
    return raw;
  }
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? raw : decoded;
}

/**
 * Strip everything that could escape the attachment folder or break a header:
 * path separators (traversal), control chars and quotes, leading dots.
 */
export function sanitizeAttachmentName(originalName: unknown): string {
  const raw = String(originalName ?? '').trim();
  const base = raw.split(/[\\/]/).pop() || '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["']/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) {
    return 'attachment';
  }
  return truncateKeepingExt(cleaned, MAX_NAME_LENGTH);
}

function truncateKeepingExt(name: string, max: number): string {
  if (name.length <= max) {
    return name;
  }
  const ext = attachmentExtOf(name);
  const dot = ext ? `.${ext}` : '';
  const keep = Math.max(1, max - dot.length);
  return `${name.slice(0, keep)}${dot}`;
}

/** `<md5>.<name>` as it goes to disk / into the URL. */
export function buildStoredFileName(sign: string, originalName: unknown): string {
  return `${sign}.${sanitizeAttachmentName(originalName)}`;
}

/** What the user should see: the stored name without the hash prefix. */
export function displayFileName(storedName: string): string {
  const stripped = String(storedName ?? '').replace(SIGN_PREFIX, '');
  return stripped || String(storedName ?? '');
}

/**
 * `Content-Disposition` for forced-download types only; everything else (pdf,
 * zip, images, office docs…) stays inline so browsers can preview it.
 * Both `filename` (ASCII fallback) and RFC 5987 `filename*` are emitted.
 */
export function attachmentDisposition(storedName: string): string | undefined {
  if (!isForcedDownloadExt(attachmentExtOf(storedName))) {
    return undefined;
  }
  const name = displayFileName(storedName) || 'attachment';
  // eslint-disable-next-line no-control-regex
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** True when the served file sits in the attachment folder. */
export function isAttachmentPath(filePath: unknown): boolean {
  const p = String(filePath ?? '');
  if (!p) {
    return false;
  }
  return path.basename(path.dirname(p)) === ATTACHMENT_FOLDER;
}

/** Headers to add for attachment responses (nosniff always, disposition when needed). */
export function attachmentHeadersFor(filePath: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Content-Type-Options': 'nosniff' };
  const disposition = attachmentDisposition(path.basename(filePath));
  if (disposition) {
    headers['Content-Disposition'] = disposition;
  }
  return headers;
}

/** Reject empty and oversized uploads with a readable 400. */
export function assertAttachmentSize(bytes: unknown): void {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) {
    throw new BadRequestException('上传内容为空！');
  }
  if (size > ATTACHMENT_MAX_BYTES) {
    throw new BadRequestException(
      `附件超过单文件上限 ${formatBytes(ATTACHMENT_MAX_BYTES)}（当前 ${formatBytes(size)}）`,
    );
  }
}
