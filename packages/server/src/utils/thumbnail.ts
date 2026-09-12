import Jimp from 'jimp';
import path from 'path';
import { tryLoadSharp } from './avif';
import { THUMB_WEBP_QUALITY } from './imageOptions';

/**
 * 图片管理列表用的缩略图：默认 300px 宽的 webp，一般 10~20KB。
 * 列表加载缩略图而不是原图，翻几十张图时流量和渲染都能快一个量级。
 *
 * 缩略图存在 `<static>/img/thumb/`，跟着图片一起备份；原图删除时一并删掉。
 */

export interface ThumbnailResult {
  ok: boolean;
  buffer?: Buffer;
  /** '.webp'（sharp）或 '.jpg'（Jimp 兜底，Jimp 不会写 webp） */
  ext?: string;
  mime?: string;
  width?: number;
  height?: number;
  /** 没生成时的原因：disabled / unsupported / no-engine / decode-failed */
  reason?: string;
}

const SKIP_TYPES = ['svg', 'svgz'];

/** `abc.png` + `.webp` -> `abc.webp`；没有扩展名就直接追加。 */
export function thumbNameFor(fileName: string, ext: string): string {
  const name = String(fileName || '');
  const suffix = ext.startsWith('.') ? ext : `.${ext}`;
  const parsed = path.parse(name);
  if (!parsed.ext) {
    return `${name}${suffix}`;
  }
  return `${parsed.name}${suffix}`;
}

export async function generateThumbnail(
  srcImage: Buffer,
  thumbWidth: number,
  fileType?: string,
): Promise<ThumbnailResult> {
  const width = Math.floor(Number(thumbWidth) || 0);
  if (width <= 0) {
    return { ok: false, reason: 'disabled' };
  }
  if (SKIP_TYPES.includes(String(fileType || '').toLowerCase())) {
    return { ok: false, reason: 'unsupported' };
  }
  const sharp: any = tryLoadSharp();
  if (sharp) {
    try {
      const buffer: Buffer = await sharp(srcImage)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: THUMB_WEBP_QUALITY })
        .toBuffer();
      const meta = await sharp(buffer).metadata();
      return {
        ok: true,
        buffer,
        ext: '.webp',
        mime: 'image/webp',
        width: Number(meta?.width) || width,
        height: Number(meta?.height) || undefined,
      };
    } catch {
      // 落到 Jimp 兜底
    }
  }
  try {
    const image = await Jimp.read(srcImage);
    image.scaleToFit(width, width);
    const buffer = await image.quality(THUMB_WEBP_QUALITY).getBufferAsync(Jimp.MIME_JPEG);
    return {
      ok: true,
      buffer,
      ext: '.jpg',
      mime: 'image/jpeg',
      width: image.bitmap.width,
      height: image.bitmap.height,
    };
  } catch {
    return { ok: false, reason: sharp ? 'decode-failed' : 'no-engine' };
  }
}
