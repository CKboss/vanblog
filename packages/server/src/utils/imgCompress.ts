import { BadRequestException } from '@nestjs/common';
import { compressImgToWebp, CWEBP_QUALITY } from './webp';
import { compressImgToAvif, tryLoadSharp } from './avif';
import { attachmentHeadersFor, isAttachmentPath } from './attachment';

export const COMPRESS_FORMATS = ['webp', 'avif'] as const;
export type CompressFormat = (typeof COMPRESS_FORMATS)[number];
export const DEFAULT_COMPRESS_FORMAT: CompressFormat = 'webp';

export const COMPRESS_MIME: Record<CompressFormat, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
};

export function isCompressFormat(value: unknown): value is CompressFormat {
  return value === 'webp' || value === 'avif';
}

/**
 * Missing / empty values keep today's WebP default.
 * Anything else that is not webp|avif is rejected (do not silently coerce).
 */
export function parseCompressFormat(value: unknown): CompressFormat {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_COMPRESS_FORMAT;
  }
  const normalized = String(value).trim().toLowerCase();
  if (isCompressFormat(normalized)) {
    return normalized;
  }
  throw new BadRequestException(`不支持的图片压缩格式：${value}，可选 webp 或 avif`);
}

/** Read path: missing or corrupt stored values keep WebP. Write path still rejects. */
export function resolveCompressFormat(value: unknown): CompressFormat {
  try {
    return parseCompressFormat(value);
  } catch {
    return DEFAULT_COMPRESS_FORMAT;
  }
}

export function compressExt(format: CompressFormat): CompressFormat {
  return format;
}

export function compressMime(format: CompressFormat): string {
  return COMPRESS_MIME[format];
}

export function contentTypeForExt(ext: string): string | undefined {
  const normalized = String(ext || '')
    .replace(/^\./, '')
    .trim()
    .toLowerCase();
  if (isCompressFormat(normalized)) {
    return COMPRESS_MIME[normalized];
  }
  return undefined;
}

/**
 * 图片（`<static>/img/**`）文件名带内容 md5 前缀，天然适合长缓存；
 * 但「替换图片」功能会**用同名文件覆盖新内容**，所以不能写 `immutable`，
 * 用「1 小时新鲜 + 7 天 stale-while-revalidate」：会话内翻页/回退都是内存命中，
 * 过期后浏览器先用旧图立即渲染、后台再校验，替换过的图最迟下一次访问就更新。
 */
export const IMG_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=604800';
/** 其余静态文件（自定义页面、导出包等）会被原地覆盖，只做短缓存。 */
export const STATIC_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

export function cacheControlFor(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return normalized.includes('/img/') ? IMG_CACHE_CONTROL : STATIC_CACHE_CONTROL;
}

export function applyStaticAssetHeaders(
  res: { setHeader(name: string, value: string): void },
  filePath: string,
) {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.') + 1) : '';
  const type = contentTypeForExt(ext);
  if (type) {
    res.setHeader('Content-Type', type);
  }
  // 没有缓存头时浏览器每次都要重新请求（原来只有 max-age=0），翻页/回退会反复拉图
  res.setHeader('Cache-Control', cacheControlFor(filePath));
  // 附件目录（<static>/file）里的文件：一律 nosniff；
  // html/svg/js 这类能在本站源上执行的类型再强制下载，避免上传变成存储型 XSS。
  if (isAttachmentPath(filePath)) {
    const headers = attachmentHeadersFor(filePath);
    for (const name of Object.keys(headers)) {
      res.setHeader(name, headers[name]);
    }
  }
}

export async function compressImg(
  srcImage: Buffer,
  format: unknown = DEFAULT_COMPRESS_FORMAT,
): Promise<Buffer> {
  const resolved = parseCompressFormat(format);
  if (resolved === 'avif') {
    return compressImgToAvif(srcImage);
  }
  try {
    return await compressImgToWebp(srcImage);
  } catch (err) {
    const sharp = tryLoadSharp();
    if (!sharp) {
      throw err;
    }
    return sharp(srcImage).webp({ quality: Number(CWEBP_QUALITY) }).toBuffer();
  }
}
