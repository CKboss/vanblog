import Jimp from 'jimp';
import path from 'path';
import { AVIF_QUALITY, tryLoadSharp } from './avif';
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

// ---------------------------------------------------------------------------
// AVIF 兄弟缩略图（P7）—— env 开关，默认**关**
// ---------------------------------------------------------------------------

export const THUMB_AVIF_ENV = 'VANBLOG_THUMB_AVIF';

/**
 * `VANBLOG_THUMB_AVIF`（默认 **false = 关**）。
 *
 * 为什么默认关：本机实测（sharp 0.35.4 / libvips 8.18.6，6 张真实图片，见交付报告）
 * 300px 缩略图的 AVIF 比 webp q70 小 26–41%（3.7–8.3KB vs 5.6–14.2KB），
 * 但每张要多花 **0.6–1.3s CPU**；原图尺寸更夸张（4000px 级照片 44–241s，体积 −37…−52%）
 * ⇒ 原图 AVIF 明确不做，缩略图做成可选项，等生产形态的磁盘/CPU 数据再决定默认值。
 */
export function resolveThumbAvifEnabled(
  raw: string | undefined = process.env[THUMB_AVIF_ENV],
  fallback = false,
): boolean {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const text = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(text)) {
    return false;
  }
  return fallback;
}

/**
 * 生成 AVIF 缩略图（`.avif`）。**只走 sharp**：Jimp 不会写 AVIF，
 * avifenc CLI 兜底留给 compressImgToAvif 那条"整图转码"路径（缩略图需要 resize，
 * 用 CLI 还得先落盘中间文件，不值得）。没有 sharp 就明确报 no-engine。
 */
export async function generateThumbnailAvif(
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
  if (!sharp) {
    return { ok: false, reason: 'no-engine' };
  }
  try {
    const buffer: Buffer = await sharp(srcImage)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .avif({ quality: AVIF_QUALITY })
      .toBuffer();
    const meta = await sharp(buffer).metadata();
    return {
      ok: true,
      buffer,
      ext: '.avif',
      mime: 'image/avif',
      width: Number(meta?.width) || width,
      height: Number(meta?.height) || undefined,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `avif-encode-failed: ${String((err as Error)?.message || err).slice(0, 160)}`,
    };
  }
}

/**
 * 开关 + 生成合一（上传/补图路径直接调这个）：
 * 关闭时返回 null 且**根本不碰 sharp**（默认路径零额外成本）。
 */
export async function generateAvifThumbIfEnabled(
  srcImage: Buffer,
  thumbWidth: number,
  fileType?: string,
  envRaw?: string,
): Promise<ThumbnailResult | null> {
  if (!resolveThumbAvifEnabled(envRaw)) {
    return null;
  }
  return generateThumbnailAvif(srcImage, thumbWidth, fileType);
}
