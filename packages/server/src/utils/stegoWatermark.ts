import Jimp from 'jimp';
import { tryLoadSharp } from './avif';
import { embedStegoIntoRgba, extractStegoFromRgba } from './stego';

/**
 * 隐写水印的图片适配层：把「像素级的 embed/extract」（utils/stego.ts）接到真实图片上。
 *
 * 优先用 sharp（server 自带，能读 raw RGBA 并按原格式写回）；没有 sharp 时用 Jimp 兜底。
 * 只处理静态位图：gif（会丢帧）、svg（矢量）一律跳过。
 */

const SUPPORTED_FORMATS = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif', 'tiff', 'bmp']);

const REENCODE_OPTIONS: Record<string, any> = {
  jpeg: { quality: 92 },
  jpg: { quality: 92 },
  webp: { quality: 92 },
  avif: { quality: 70 },
  png: { compressionLevel: 9 },
  tiff: { quality: 92 },
  bmp: {},
};

export interface StegoEmbedResult {
  /** 处理后的图片；没嵌进去时就是原图。 */
  buffer: Buffer;
  embedded: boolean;
  /** disabled / unsupported-format / no-engine / decode-failed / image-too-small / payload-empty-or-too-long / not-enough-blocks */
  reason?: string;
  repetition?: number;
  width?: number;
  height?: number;
}

export interface StegoExtractResult {
  found: boolean;
  payload?: string;
  reason?: string;
  width?: number;
  height?: number;
  repetition?: number;
  /** 判决擦边的 bit 数，越大说明图被压得越狠。 */
  uncertain?: number;
}

interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  format: string;
}

export function isStegoSupportedFormat(format?: string): boolean {
  return SUPPORTED_FORMATS.has(String(format || '').toLowerCase());
}

async function readRawWithSharp(sharp: any, src: Buffer): Promise<RawImage | null> {
  const meta = await sharp(src).metadata();
  const format = String(meta?.format || '').toLowerCase();
  const { data, info } = await sharp(src)
    .rotate() // 按 EXIF 摆正，避免写回后方向变化
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (!info?.width || !info?.height) {
    return null;
  }
  return { data: new Uint8Array(data), width: info.width, height: info.height, format };
}

async function readRawWithJimp(src: Buffer): Promise<RawImage | null> {
  try {
    const image = await Jimp.read(src);
    const mime = String(image.getMIME() || '');
    const format = mime.includes('png')
      ? 'png'
      : mime.includes('jpeg')
      ? 'jpeg'
      : mime.includes('bmp')
      ? 'bmp'
      : mime.includes('tiff')
      ? 'tiff'
      : '';
    return {
      data: new Uint8Array(image.bitmap.data),
      width: image.bitmap.width,
      height: image.bitmap.height,
      format,
    };
  } catch {
    return null;
  }
}

/** 解码成 RGBA 像素 + 原格式；失败返回 null。 */
export async function readImageRgba(src: Buffer): Promise<RawImage | null> {
  const sharp: any = tryLoadSharp();
  if (sharp) {
    try {
      const raw = await readRawWithSharp(sharp, src);
      if (raw) {
        return raw;
      }
    } catch {
      // 落到 Jimp
    }
  }
  return readRawWithJimp(src);
}

/**
 * 把文本藏进图片。返回的 buffer 已经是可保存的图片（保持原格式）；
 * 任何一步不成立都原样返回输入，绝不因为水印失败而丢图。
 */
export async function embedStegoWatermark(
  srcImage: Buffer,
  text: string,
  key: string,
): Promise<StegoEmbedResult> {
  if (!text || !key) {
    return { buffer: srcImage, embedded: false, reason: 'disabled' };
  }
  const sharp: any = tryLoadSharp();
  const raw = await readImageRgba(srcImage);
  if (!raw) {
    return { buffer: srcImage, embedded: false, reason: sharp ? 'decode-failed' : 'no-engine' };
  }
  if (!isStegoSupportedFormat(raw.format)) {
    return {
      buffer: srcImage,
      embedded: false,
      reason: 'unsupported-format',
      width: raw.width,
      height: raw.height,
    };
  }

  const result = embedStegoIntoRgba(raw.data, raw.width, raw.height, text, { key });
  if (!result.embedded) {
    return {
      buffer: srcImage,
      embedded: false,
      reason: result.reason,
      width: raw.width,
      height: raw.height,
    };
  }

  try {
    const buffer = sharp
      ? await sharp(raw.data, {
          raw: { width: raw.width, height: raw.height, channels: 4 },
        })
          .toFormat(raw.format, REENCODE_OPTIONS[raw.format])
          .toBuffer()
      : await writeWithJimp(raw, srcImage);
    if (!buffer) {
      return { buffer: srcImage, embedded: false, reason: 'no-engine' };
    }
    return {
      buffer,
      embedded: true,
      repetition: result.repetition,
      width: raw.width,
      height: raw.height,
    };
  } catch {
    return { buffer: srcImage, embedded: false, reason: 'decode-failed' };
  }
}

async function writeWithJimp(raw: RawImage, srcImage: Buffer): Promise<Buffer | null> {
  if (!['png', 'jpeg', 'bmp', 'tiff'].includes(raw.format)) {
    return null;
  }
  const image = await Jimp.read(srcImage);
  // Jimp 的 bitmap 就是 RGBA，直接把改好的像素拷回去
  Buffer.from(raw.data).copy(image.bitmap.data as Buffer);
  return image.quality(92).getBufferAsync(image.getMIME());
}

/** 从图片里盲提取水印；magic + CRC 都对才算命中，所以不会误报。 */
export async function extractStegoWatermark(
  srcImage: Buffer,
  key: string,
): Promise<StegoExtractResult> {
  if (!key) {
    return { found: false, reason: 'disabled' };
  }
  const raw = await readImageRgba(srcImage);
  if (!raw) {
    return { found: false, reason: 'decode-failed' };
  }
  const result = extractStegoFromRgba(raw.data, raw.width, raw.height, { key });
  return {
    found: result.found,
    payload: result.payload,
    repetition: result.repetition,
    uncertain: result.uncertain,
    width: raw.width,
    height: raw.height,
    reason: result.found ? undefined : 'not-found',
  };
}
