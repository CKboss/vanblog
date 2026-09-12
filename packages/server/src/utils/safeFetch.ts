import axios from 'axios';
import { assertSafeRemoteUrl } from './markdownExport';

/**
 * 每一跳都重新做安全校验的远程抓取。
 *
 * 为什么不能用 axios 自带的重定向：`assertSafeRemoteUrl()` 只校验**第一个** URL，
 * 而 axios 默认会跟随 302。攻击者用自己的域名过检，再 302 到
 * `http://127.0.0.1:8360/`、`http://127.0.0.1:2019/`（caddy admin）或
 * `http://169.254.169.254/latest/meta-data/...`，响应体会被原样带回
 * （导出接口还会把它打进 zip 给调用方下载）——这是**可读回显**的 SSRF，不是盲打。
 * 所以这里 `maxRedirects: 0`，自己一跳一跳地走，每跳都重新过 `assertSafeRemoteUrl`。
 */
export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  accept?: string;
}

export interface SafeFetchResult {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
}

export async function fetchRemoteSafely(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  let current = await assertSafeRemoteUrl(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await axios.get(current.toString(), {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxRedirects: 0,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      headers: {
        'User-Agent': options.userAgent || 'VanBlog/1.0',
        Accept: options.accept || 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      // 3xx 也接住，自己处理重定向
      validateStatus: () => true,
    });
    const status = Number(res.status);
    if (status >= 300 && status < 400) {
      const location = res.headers?.location;
      if (!location) {
        throw new Error(`重定向（${status}）缺少 Location`);
      }
      let next: URL;
      try {
        next = new URL(String(location), current);
      } catch {
        throw new Error(`重定向地址无法解析：${location}`);
      }
      // 关键：每一跳都重新校验，内网/回环地址一律拒绝
      current = await assertSafeRemoteUrl(next.toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new Error(`远端返回 ${status}`);
    }
    const buffer = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
    if (!buffer.length) {
      throw new Error('抓到的是空文件');
    }
    return {
      buffer,
      contentType: String(res.headers?.['content-type'] || ''),
      finalUrl: current.toString(),
    };
  }
  throw new Error('重定向次数过多');
}

const IMAGE_MAGIC: Array<{ ext: string; test: (b: Buffer) => boolean }> = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'gif', test: (b) => b.subarray(0, 3).toString('latin1') === 'GIF' },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ext: 'bmp', test: (b) => b[0] === 0x42 && b[1] === 0x4d },
  { ext: 'tif', test: (b) => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00) },
  { ext: 'ico', test: (b) => b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) },
  { ext: 'heic', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
];

/** 按魔数判断是不是图片；顺便给出真实类型。SVG 没有魔数，一律不当图片（能内嵌脚本）。 */
export function detectImageByMagic(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 4) {
    return null;
  }
  if (buffer.subarray(0, 512).toString('utf8').toLowerCase().includes('<svg')) {
    return null;
  }
  // avif/heif 都是 ftyp box，靠 brand 区分
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1').toLowerCase();
    if (brand.startsWith('avi')) {
      return 'avif';
    }
    return 'heic';
  }
  for (const entry of IMAGE_MAGIC) {
    try {
      if (entry.test(buffer)) {
        return entry.ext;
      }
    } catch {
      // 单个判定出错不影响其它
    }
  }
  return null;
}

/** 远端抓回来的东西必须真的是图片，否则不打进 zip / 不落图床（防 SSRF 回显任意内容）。 */
export function assertImageBuffer(buffer: Buffer, source?: string): string {
  const type = detectImageByMagic(buffer);
  if (!type) {
    throw new Error(`抓到的内容不是图片${source ? `（${source}）` : ''}，已丢弃`);
  }
  return type;
}
