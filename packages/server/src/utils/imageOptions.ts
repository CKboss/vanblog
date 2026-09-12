import { DEFAULT_MAX_IMAGE_EDGE, DEFAULT_THUMB_WIDTH } from 'src/types/setting.dto';
import { STEGO_MAX_PAYLOAD_BYTES } from './stego';

/** 长边上限的可选范围；0 表示不缩放。 */
export const MIN_IMAGE_EDGE = 320;
export const MAX_IMAGE_EDGE = 8192;
export const MIN_THUMB_WIDTH = 64;
export const MAX_THUMB_WIDTH = 1024;
export const THUMB_WEBP_QUALITY = 70;

export function parseBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(text)) {
    return false;
  }
  return fallback;
}

/** 长边上限：0/负数/非法值 -> 0（不缩放）；正常值裁剪到 [320, 8192]。 */
export function parseMaxImageEdge(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }
  return Math.round(Math.min(MAX_IMAGE_EDGE, Math.max(MIN_IMAGE_EDGE, num)));
}

/** 没设置过就用默认 1920。 */
export function resolveMaxImageEdge(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_MAX_IMAGE_EDGE;
  }
  return parseMaxImageEdge(value);
}

export function parseThumbWidth(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return DEFAULT_THUMB_WIDTH;
  }
  return Math.round(Math.min(MAX_THUMB_WIDTH, Math.max(MIN_THUMB_WIDTH, num)));
}

/** https://www.example.com/path -> www.example.com */
export function domainOf(baseUrl?: string): string {
  const raw = String(baseUrl || '').trim();
  if (!raw) {
    return '';
  }
  const withoutProtocol = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return withoutProtocol.split(/[/?#]/)[0].toLowerCase();
}

export interface StegoPayloadInput {
  /** 后台自定义文本，优先。 */
  custom?: string;
  baseUrl?: string;
  /** 站点作者（siteInfo.author）。 */
  author?: string;
  /** 上传者昵称/用户名。 */
  uploader?: string;
  now?: Date;
}

/**
 * 隐写载荷：默认「域名|上传者|UTC 时间」，方便日后追到是谁什么时候传的；
 * 也可以在后台写死一段自定义文本。超过 200 字节会按字符边界截断。
 */
export function buildStegoPayload(input: StegoPayloadInput): string {
  const custom = String(input?.custom || '').trim();
  if (custom) {
    return truncateToBytes(custom, STEGO_MAX_PAYLOAD_BYTES);
  }
  const domain = domainOf(input?.baseUrl);
  const who = String(input?.uploader || input?.author || '').trim();
  const when = (input?.now || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const text = [domain, who, when].filter(Boolean).join('|');
  return truncateToBytes(text, STEGO_MAX_PAYLOAD_BYTES);
}

function truncateToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return text;
  }
  let out = text;
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}
