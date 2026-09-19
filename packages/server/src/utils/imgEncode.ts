import Jimp from 'jimp';
import { tryLoadSharp } from './avif';
import { sharpInputOptions } from './imageLimits';

/**
 * 按指定格式重新编码图片。
 *
 * 「替换图片」要用它：新内容必须写回**原来的 URL**（后缀都不能变），
 * 否则文章里已经插入的链接就全断了。
 */

const SHARP_OPTIONS: Record<string, any> = {
  jpeg: { quality: 90 },
  jpg: { quality: 90 },
  webp: { quality: 90 },
  avif: { quality: 70 },
  png: { compressionLevel: 9 },
  tiff: { quality: 90 },
  bmp: {},
};

export function normalizeImageFormat(format?: string): string {
  const raw = String(format || '').toLowerCase().replace(/^\./, '');
  return raw === 'jpg' ? 'jpeg' : raw;
}

/** 这个格式我们能不能重新编码（gif 不算：会丢掉动画）。 */
export function canEncodeFormat(format?: string): boolean {
  return Object.keys(SHARP_OPTIONS).includes(normalizeImageFormat(format));
}

export async function encodeImageToFormat(
  srcImage: Buffer,
  format: string,
  quality?: number,
): Promise<Buffer> {
  const target = normalizeImageFormat(format);
  if (!canEncodeFormat(target)) {
    return srcImage;
  }
  const options = { ...(SHARP_OPTIONS[target] || {}), ...(quality ? { quality } : {}) };
  const sharp: any = tryLoadSharp();
  if (sharp) {
    try {
      return await sharp(srcImage, sharpInputOptions()).rotate().toFormat(target, options).toBuffer();
    } catch {
      // 落到 Jimp 兜底
    }
  }
  return encodeWithJimp(srcImage, target);
}

async function encodeWithJimp(srcImage: Buffer, target: string): Promise<Buffer> {
  const image = await Jimp.read(srcImage);
  if (target === 'jpeg') {
    return image.quality(90).getBufferAsync(Jimp.MIME_JPEG);
  }
  if (target === 'png') {
    return image.getBufferAsync(Jimp.MIME_PNG);
  }
  if (target === 'bmp') {
    return image.getBufferAsync(Jimp.MIME_BMP);
  }
  if (target === 'tiff') {
    return image.getBufferAsync(Jimp.MIME_TIFF);
  }
  // webp / avif：Jimp 写不出来，原样返回（调用方会记一条警告）
  return srcImage;
}
