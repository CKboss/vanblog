import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { imageSize } from 'image-size';
import { isAvifBuffer } from './avif';
import { MAX_IMAGE_PIXELS } from './imageLimits';

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
/**
 * 像素上限：隐写水印要把整图解码成 raw RGBA，超大图会瞬间吃掉上 GB 堆内存。
 *
 * ⚠️ **常量本体与全部理由都在 `./imageLimits`**，这里只是 re-export，让既有
 * `from './uploadLimits'` 的导入继续可用。同一个数还被 sharp 的 `limitInputPixels` 用 ——
 * 两处必须同源，否则"更宽的那个"就是实际上限（见 imageLimits.ts 的说明）。
 */
export { MAX_IMAGE_PIXELS };

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
export function assertUploadedImage(
  buffer: Buffer,
  declaredName?: string,
  opts?: { maxPixels?: number; tooLargeHint?: string },
): VerifiedImage {
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
  // 上限可以被调用方收紧（例如隐写检测只要 8MP）；不传就仍是全站那个 40MP。
  const maxPixels = Number(opts?.maxPixels ?? MAX_IMAGE_PIXELS);
  if (pixels > maxPixels) {
    throw new BadRequestException(
      opts?.tooLargeHint || `图片尺寸过大（${meta.width}x${meta.height}），请缩小后再上传`,
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

/**
 * 隐写水印**检测**专用的像素上限：8MP。
 *
 * 为什么比上传那个 40MP 小得多：检测要把整图解码成 raw RGBA 再逐像素比对，
 * 实测 1MP → 23 ms，**36MP → 401 ms、heap 49MB、RSS 477MB** ⇒ 3 个并发就约 1.4GB RSS，
 * 常见的 1–2GB 容器直接 OOMKilled。而 `post-/api/admin/img/stego/detect` 在 publicRoutes 里
 * （零权限协作者可调，是有意为之：图片管理页要给协作者用），全局桶 600/分钟/IP 对它太宽
 * （等于每分钟 240 秒 CPU）。"验一张图"不需要 40MP —— 真要验更大的图，先上传到图床
 * （上传口仍是 40MP），再用列表里的按 sign 检测。
 *
 * ⚠️ 只作用于**上传来的字节**：按 sign 检测走的是图床里已存在的文件，那个体积在上传时
 * 已经付过代价了，对它再设 8MP 会让"验一张自己库里的 20MP 图"莫名失败。
 */
export const MAX_STEGO_DETECT_PIXELS = 8_000_000;

/** 上传前剩余空间下限的环境变量名（接受纯字节数或 `500mb` / `2gb` 这类写法）。 */
export const UPLOAD_MIN_FREE_ENV = 'VANBLOG_UPLOAD_MIN_FREE_BYTES';
/** 默认给磁盘留 500MB 余量。 */
export const DEFAULT_UPLOAD_MIN_FREE_BYTES = 500 * 1024 * 1024;
/** 上限 1TB：再大就等于"禁止上传"，而那是用错旋钮，不是配置意图。 */
const MAX_UPLOAD_MIN_FREE_BYTES = 1024 * 1024 * 1024 * 1024;

const BYTE_SIZE_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i;
const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
};

/**
 * 把"剩余空间下限"清洗成一个字节数。
 *  - 缺失 / 认不出 → 默认 500MB；
 *  - `0` → **0 表示关掉这道闸门**（这是它唯一允许的关闭方式，要显式写 0）；
 *  - 超过 1TB → 夹到 1TB。
 *
 * ⚠️ 默认参数刻意用 `process.env.VANBLOG_UPLOAD_MIN_FREE_BYTES` 这种点号字面量：
 * `utils/envVarMentions.spec.ts` 要求用户可见字符串里提到的变量名必须有真实读取点。
 */
export function resolveUploadMinFreeBytes(
  raw: unknown = process.env.VANBLOG_UPLOAD_MIN_FREE_BYTES,
): number {
  const text = String(raw ?? '').trim().replace(/\s+/g, '').toLowerCase();
  if (!text) return DEFAULT_UPLOAD_MIN_FREE_BYTES;
  const m = BYTE_SIZE_RE.exec(text);
  if (!m) return DEFAULT_UPLOAD_MIN_FREE_BYTES;
  const value = Number(m[1]) * (BYTE_UNITS[m[2] || 'b'] || 1);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_UPLOAD_MIN_FREE_BYTES;
  return Math.min(Math.round(value), MAX_UPLOAD_MIN_FREE_BYTES);
}

/**
 * 判定"这次上传会不会把磁盘写到余量以下"，返回给用户的可照做消息；允许则返回 null。
 *
 * ⚠️ 抽成**纯函数**是刻意的：`fs.statfsSync` 在 jest 里不可重定义（`Cannot redefine property`，
 * 已有代理踩过），所以"读剩余空间"与"判定+文案"必须分开，判定这一半才能被真正测到。
 *
 * ⚠️ `freeBytes === null` 与 `0` 必须分开（与 `utils/fullBackup.ts` 的 `freeSpaceBytes` 同口径）：
 * null 表示**读不到**剩余空间（平台没有 statfsSync、或目录不存在），这时**跳过闸门而不是拒绝**
 * —— 否则一个读不到 statfs 的部署会让所有上传都失败，那是把可用性换成一个并不存在的保证。
 *
 * @param freeBytes    目标卷剩余字节（`freeSpaceBytes(dir)` 的返回值，可能为 null）
 * @param incomingBytes 这次要写入的字节数（未知就传 0，只按"余量够不够下限"判）
 * @param minFree      余量下限（`resolveUploadMinFreeBytes()`）
 */
export function uploadSpaceShortfallMessage(
  freeBytes: number | null,
  incomingBytes: number,
  minFree: number,
): string | null {
  if (minFree <= 0) return null; // 显式关掉
  if (freeBytes === null || !Number.isFinite(freeBytes)) return null; // 读不到 ⇒ 不拦
  const incoming = Number.isFinite(incomingBytes) && incomingBytes > 0 ? incomingBytes : 0;
  const after = freeBytes - incoming;
  if (after >= minFree) return null;
  const mb = (n: number) => `${Math.max(0, Math.round(n / (1024 * 1024)))} MB`;
  return (
    `存储空间不足，已拒绝这次上传：写入 ${mb(incoming)} 后只剩 ${mb(Math.max(0, after))}，` +
    `低于保留下限 ${mb(minFree)}。请清理图床/附件/旧备份，或把数据目录换到更大的卷；` +
    `确实想在更低的余量下继续，可以把 ${UPLOAD_MIN_FREE_ENV} 调小（写 0 表示关掉这道检查）。`
  );
}
