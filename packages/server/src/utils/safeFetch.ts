import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { assertSafeRemoteUrlDetailed, SafeRemoteUrl } from './markdownExport';

/**
 * 每一跳都重新做安全校验、并且**连的就是校验过的那个 IP** 的远程抓取。
 *
 * 为什么不能用 axios 自带的重定向：`assertSafeRemoteUrl()` 只校验**第一个** URL，
 * 而 axios 默认会跟随 302。攻击者用自己的域名过检，再 302 到
 * `http://127.0.0.1:8360/`、`http://127.0.0.1:2019/`（caddy admin）或
 * `http://169.254.169.254/latest/meta-data/...`，响应体会被原样带回
 * （导出接口还会把它打进 zip 给调用方下载）——这是**可读回显**的 SSRF，不是盲打。
 * 所以这里 `maxRedirects: 0`，自己一跳一跳地走，每跳都重新过校验。
 *
 * ⚠️ 光"每跳都校验"还不够：校验时 `dns.lookup` 解析一次，连接时 axios/Node **再解析一次**，
 * 两次之间 DNS 答案可以变（rebinding、多 A 记录轮流返回、TTL=0 的权威服务器），于是
 * "校验通过的是公网 IP、真正连上的是 127.0.0.1"。所以下面用自定义 Agent 的 `lookup` 钩子
 * 把**已校验的那个地址**钉死；Host 头与 TLS 的 SNI 仍然用域名（只替换 TCP 连到哪），
 * 因此正常的虚拟主机 / CDN 不受影响。
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

/**
 * 从已校验的地址里挑一个去连。
 *
 * 优先 IPv4：容器与不少云主机/家宽的**出向 IPv6 并不存在**，而 `dns.lookup(all:true)`
 * 会把 AAAA 一起返回，钉到 AAAA 上会把本来能成的抓取变成超时。
 * 只有纯 IPv6 目标（没有 A 记录）才用 IPv6。
 */
export function pickPinnedAddress(addresses: string[]): string | null {
  const list = (addresses || []).map((a) => String(a).trim()).filter(Boolean);
  if (!list.length) {
    return null;
  }
  return list.find((a) => net.isIPv4(a)) || list[0];
}

/**
 * 造一个"永远返回同一个 IP"的 `dns.lookup` 钩子。导出是为了能单测（不需要网络）。
 *
 * ⚠️ **必须同时支持两种回调形状**，这是踩出来的：
 *  - `all: false`（旧默认）：`callback(null, address, family)`
 *  - `all: true`：`callback(null, [{ address, family }])`
 *    Node 20 起 `autoSelectFamily`（Happy Eyeballs）默认开启，`net.Socket` 会以 `all: true`
 *    调 lookup —— 只按第一种形状回，Node 会把字符串当成地址数组去取 `[0].address`，
 *    于是每一次外链抓取都失败在 `TypeError: Invalid IP address: undefined`。
 *    容器里跑的是 Node 24，所以这不是理论问题：本机 e2e 钉子（真起一个 127.0.0.1 的
 *    HTTP 服务器、用一个永远解析不了的 `.invalid` 域名钉过去）就是这么抓到的。
 */
export function pinnedLookup(pinnedIp: string) {
  const family = net.isIPv6(pinnedIp) ? 6 : 4;
  return function lookup(
    _hostname: string,
    options: unknown,
    callback?: (err: Error | null, ...args: any[]) => void,
  ): void {
    // Node 也允许省略 options：lookup(host, cb)
    const opts = (typeof options === 'function' ? {} : options) as { all?: boolean } | undefined;
    const cb = (typeof options === 'function' ? options : callback) as
      | ((err: Error | null, ...args: any[]) => void)
      | undefined;
    if (typeof cb !== 'function') {
      return;
    }
    if (opts?.all) {
      cb(null, [{ address: pinnedIp, family }]);
      return;
    }
    cb(null, pinnedIp, family);
  };
}

/** 带 IP pinning 的 Agent。⚠️ 用完必须 `destroy()`，否则每跳漏一个 socket 池。 */
export function createPinnedAgent(pinnedIp: string, secure: boolean): http.Agent {
  const options = { lookup: pinnedLookup(pinnedIp) as any, keepAlive: false };
  return secure ? new https.Agent(options) : new http.Agent(options);
}

export async function fetchRemoteSafely(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  let current: SafeRemoteUrl = await assertSafeRemoteUrlDetailed(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const secure = current.url.protocol === 'https:';
    const pinned = pickPinnedAddress(current.addresses);
    // 校验放行了却挑不出可用地址 ⇒ 直接失败，**绝不**退回"让 Node 自己解析"（那等于没 pinning）
    if (!pinned) {
      throw new Error(`校验通过的地址无法用于连接：${current.url.hostname}`);
    }
    const agent = createPinnedAgent(pinned, secure);
    let res;
    try {
      res = await axios.get(current.url.toString(), {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        maxRedirects: 0,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        httpAgent: agent,
        httpsAgent: agent,
        headers: {
          'User-Agent': options.userAgent || 'VanBlog/1.0',
          Accept: options.accept || 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        // 3xx 也接住，自己处理重定向
        validateStatus: () => true,
      });
    } finally {
      agent.destroy();
    }
    const status = Number(res.status);
    if (status >= 300 && status < 400) {
      const location = res.headers?.location;
      if (!location) {
        throw new Error(`重定向（${status}）缺少 Location`);
      }
      let next: URL;
      try {
        next = new URL(String(location), current.url);
      } catch {
        throw new Error(`重定向地址无法解析：${location}`);
      }
      // 关键：每一跳都重新校验（协议 / 端口白名单 / 解析结果），并重新钉住新的 IP
      current = await assertSafeRemoteUrlDetailed(next.toString());
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
      finalUrl: current.url.toString(),
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
