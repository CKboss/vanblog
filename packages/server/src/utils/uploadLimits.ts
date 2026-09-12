import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { imageSize } from 'image-size';
import { isAvifBuffer } from './avif';

/**
 * 上传体积上限与「真的是图片吗」校验。
 *
 * 背景（安全审计）：
 * - 图片上传接口以前**没有任何 multer 限制**（默认内存存储、无 fileSize），
 *   几个并发的超大 multipart 就能把进程内存打爆；
 * - 更严重的是它不校验内容：上传 `evil.html` 时缩放/隐写/压缩每一步都失败并被 catch 掉，
 *   原始字节被原样存成 `/static/img/<md5>.evil.html`，再由静态服务以 `text/html` 同源返回
 *   → **存储型 XSS**（生产环境后台与前台同源，等于偷管理员 token）。`.svg` 同理（能内嵌脚本）。
 */
export const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_GENERIC_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_JSON_IMPORT_BYTES = 200 * 1024 * 1024;
/** 像素上限：隐写水印要把整图解码成 raw RGBA，超大图会瞬间吃掉上 GB 堆内存。 */
export const MAX_IMAGE_PIXELS = 100_000_000;

/** 允许作为「图片」落盘的类型；svg 故意不在里面（可执行脚本）。 */
export const ALLOWED_IMAGE_TYPES = [
  'jpg',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'ico',
] as const;

export const DANGEROUS_INLINE_EXTENSIONS = [
  'html',
  'htm',
  'svg',
  'xml',
  'xhtml',
  'js',
  'mjs',
  'cjs',
  'css',
  'swf',
];

function isSvgish(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 512).toString('utf8').toLowerCase();
  return head.includes('<svg') || head.includes('<!doctype svg');
}

export interface VerifiedImage {
  type: string;
  width?: number;
  height?: number;
}

/**
 * 校验一段字节确实是允许的图片，返回**由内容判定**的类型（不要相信客户端给的后缀）。
 * 不是图片 / 是 svg / 像素超限时抛 400。
 */
export function assertUploadedImage(buffer: Buffer, declaredName?: string): VerifiedImage {
  if (!buffer || !buffer.length) {
    throw new BadRequestException('上传内容为空');
  }
  if (isSvgish(buffer)) {
    throw new BadRequestException('图床不接受 SVG（可内嵌脚本），请作为附件上传');
  }
  let meta: { type?: string; width?: number; height?: number };
  try {
    meta = imageSize(buffer) as any;
  } catch {
    if (isAvifBuffer(buffer)) {
      meta = { type: 'avif' };
    } else {
      throw new BadRequestException(
        `这不是可识别的图片文件${declaredName ? `：${declaredName}` : ''}。非图片请走「附件管理」上传`,
      );
    }
  }
  const type = String(meta?.type || '').toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(type as any)) {
    throw new BadRequestException(`不支持的图片类型：${type || '未知'}`);
  }
  const pixels = Number(meta?.width || 0) * Number(meta?.height || 0);
  if (pixels > MAX_IMAGE_PIXELS) {
    throw new BadRequestException(
      `图片尺寸过大（${meta.width}x${meta.height}），请缩小后再上传`,
    );
  }
  return { type, width: meta?.width, height: meta?.height };
}

/** 落盘用的后缀：只允许图片白名单里的值，其它一律用内容判定出来的类型。 */
export function safeImageExtension(declared: unknown, verifiedType: string): string {
  const ext = String(declared ?? '')
    .replace(/^\./, '')
    .toLowerCase();
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(ext) ? ext : verifiedType;
}

function makeOptions(fileSize: number, fileFilter?: any) {
  const options: any = { limits: { fileSize } };
  if (fileFilter) {
    options.fileFilter = fileFilter;
  }
  return options;
}

/** 图片上传（upload / replace / stego 检测）用：50MB 上限 + 拒绝明显的非图片后缀。 */
export const IMAGE_UPLOAD_OPTIONS = makeOptions(MAX_IMAGE_UPLOAD_BYTES, (
  _req: Request,
  file: any,
  cb: (err: Error | null, accept?: boolean) => void,
) => {
  const name = String(file?.originalname || '').toLowerCase();
  if (DANGEROUS_INLINE_EXTENSIONS.some((ext) => name.endsWith(`.${ext}`))) {
    cb(new BadRequestException('图床只接受图片文件，非图片请走「附件管理」'));
    return;
  }
  cb(null, true);
});

/** 自定义页面（HTML/JS/CSS）上传：不限类型，但限体积。 */
export const CUSTOM_PAGE_UPLOAD_OPTIONS = makeOptions(MAX_GENERIC_UPLOAD_BYTES);

/** 旧版 JSON 备份导入：不限类型，但限体积（整个文件会进内存再 JSON.parse）。 */
export const JSON_IMPORT_UPLOAD_OPTIONS = makeOptions(MAX_JSON_IMPORT_BYTES);
