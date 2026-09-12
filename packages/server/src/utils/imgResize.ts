import Jimp from 'jimp';
import { tryLoadSharp } from './avif';

/**
 * 上传时把过大的图等比缩小到「长边 <= maxEdge」（默认 1920，即 1080p 级）。
 * 只缩不放：本来就小的图一个像素都不动，也不会重新编码。
 *
 * 动图（gif）和矢量图（svg）不处理：缩放会丢掉帧/失去矢量特性。
 */

export interface ResizeResult {
  buffer: Buffer;
  width?: number;
  height?: number;
  resized: boolean;
  /** 没缩放时的原因：disabled / already-small / unsupported / no-engine / decode-failed */
  skipped?: string;
}

const SKIP_TYPES = ['gif', 'svg', 'svgz'];

const ENCODE_OPTIONS: Record<string, any> = {
  jpeg: { quality: 90 },
  jpg: { quality: 90 },
  webp: { quality: 90 },
  avif: { quality: 70 },
  png: { compressionLevel: 9 },
};

export function shouldSkipResize(fileType?: string): boolean {
  return SKIP_TYPES.includes(String(fileType || '').toLowerCase());
}

export async function capImageResolution(
  srcImage: Buffer,
  maxEdge: number,
  fileType?: string,
): Promise<ResizeResult> {
  const limit = Math.floor(Number(maxEdge) || 0);
  if (limit <= 0) {
    return { buffer: srcImage, resized: false, skipped: 'disabled' };
  }
  if (shouldSkipResize(fileType)) {
    return { buffer: srcImage, resized: false, skipped: 'unsupported' };
  }
  const sharp: any = tryLoadSharp();
  if (sharp) {
    try {
      return await resizeWithSharp(sharp, srcImage, limit);
    } catch {
      // 落到 Jimp 兜底
    }
  }
  return resizeWithJimp(srcImage, limit);
}

async function resizeWithSharp(sharp: any, srcImage: Buffer, limit: number): Promise<ResizeResult> {
  const meta = await sharp(srcImage).metadata();
  const width = Number(meta?.width) || 0;
  const height = Number(meta?.height) || 0;
  if (!width || !height) {
    return { buffer: srcImage, resized: false, skipped: 'decode-failed' };
  }
  if (Math.max(width, height) <= limit) {
    return { buffer: srcImage, width, height, resized: false, skipped: 'already-small' };
  }
  const format = String(meta?.format || 'png').toLowerCase();
  const pipeline = sharp(srcImage)
    .rotate() // 按 EXIF 摆正，否则缩完方向就错了
    .resize({ width: limit, height: limit, fit: 'inside', withoutEnlargement: true });
  const buffer: Buffer = await pipeline.toFormat(format, ENCODE_OPTIONS[format]).toBuffer();
  const out = await sharp(buffer).metadata();
  return {
    buffer,
    width: Number(out?.width) || undefined,
    height: Number(out?.height) || undefined,
    resized: true,
  };
}

async function resizeWithJimp(srcImage: Buffer, limit: number): Promise<ResizeResult> {
  try {
    const image = await Jimp.read(srcImage);
    const width = image.bitmap.width;
    const height = image.bitmap.height;
    if (Math.max(width, height) <= limit) {
      return { buffer: srcImage, width, height, resized: false, skipped: 'already-small' };
    }
    image.scaleToFit(limit, limit);
    const mime = image.getMIME();
    if (!/image\/(jpeg|png|bmp|tiff)/.test(mime)) {
      return { buffer: srcImage, width, height, resized: false, skipped: 'no-engine' };
    }
    const buffer = await image.quality(90).getBufferAsync(mime);
    return {
      buffer,
      width: image.bitmap.width,
      height: image.bitmap.height,
      resized: true,
    };
  } catch {
    return { buffer: srcImage, resized: false, skipped: 'decode-failed' };
  }
}
