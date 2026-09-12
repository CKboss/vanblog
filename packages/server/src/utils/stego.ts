import { createHash } from 'crypto';

/**
 * 隐写水印（盲提取）：把一小段文本藏进图片的 **块平均亮度差** 里。
 *
 * 为什么不用 LSB：本站上传默认要压成有损 webp（q80），LSB 会被量化直接抹掉，
 * 而且只能配无损格式存（体积翻几倍）。块均值调制改的是每个 8x8 块的低频分量，
 * 常规转码/截图之后仍然读得出来，肉眼完全看不出（每块亮度只动 <=4 个色阶）。
 *
 * 编码方式：
 * - 图片切成 8x8 块，块数 = floor(W/8) * floor(H/8)；
 * - 用 sha256(key + 尺寸) 做种子生成块的全排列，第 i 个 bit 用排列里第 2i、2i+1 两块；
 * - 把两块的亮度差 d 量化到格点（bit=0 落在 DELTA 整数倍，bit=1 落在半格），两块各动 <=4 个色阶；
 * - 每个 bit 重复 REPETITION 次（不同的块对），提取时多数表决；
 * - 载荷 = magic "VBL1" + 版本 + 长度 + UTF-8 文本 + CRC32，提取时靠 magic/CRC 判定命中，
 *   所以不知道内容也不会误报。
 *
 * 限制（有意为之）：种子和图片尺寸绑定，**缩放/裁剪之后取不出来**；有损转码能扛住。
 */

/** 块边长（像素）。和 JPEG/WebP 的 MCU 对齐，低频最稳。 */
export const STEGO_BLOCK = 8;
/** 载荷魔数，用来确认"这是我们埋的"。 */
export const STEGO_MAGIC = 'VBL1';
export const STEGO_VERSION = 1;
/** 文本最长 200 字节（长度占 1 字节）。 */
export const STEGO_MAX_PAYLOAD_BYTES = 200;
/**
 * 格点间距：两块平均亮度差 d 被量化到
 *   bit=0 -> d 是 DELTA 的整数倍
 *   bit=1 -> d 是 DELTA/2 的奇数倍
 * 提取时把 d 折回 [-DELTA/2, DELTA/2)，离 0 近就是 0，离 ±DELTA/2 近就是 1，
 * 因此能容忍 ±DELTA/4 的噪声（有损转码通常在 1~2 个色阶以内）。
 */
export const STEGO_DELTA = 16;
/** 判决门限 = DELTA/4；顺带用来统计"擦边"的 bit 数。 */
export const STEGO_THRESHOLD = STEGO_DELTA / 4;
/** 单个块最多调整多少亮度，再大就可能被肉眼察觉（= DELTA/4，刚好够一次落到格点上）。 */
export const STEGO_MAX_DELTA = 4;
/** 每个 bit 的重复次数候选，从最稳到最省容量。 */
export const STEGO_REPETITIONS = [3, 2, 1];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** 文本 -> magic + version + length + utf8 + crc32(大端 4 字节) */
export function encodePayload(text: string): Uint8Array | null {
  const body = Buffer.from(String(text ?? ''), 'utf8');
  if (body.length === 0 || body.length > STEGO_MAX_PAYLOAD_BYTES) {
    return null;
  }
  const magic = Buffer.from(STEGO_MAGIC, 'ascii');
  const head = Buffer.from([STEGO_VERSION, body.length]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([magic, head, body])), 0);
  return new Uint8Array(Buffer.concat([magic, head, body, crc]));
}

/** 校验 magic/版本/长度/CRC，通过才返回文本，否则 null（不会误报）。 */
export function decodePayload(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 10) {
    return null;
  }
  const magic = Buffer.from(bytes.slice(0, 4)).toString('ascii');
  if (magic !== STEGO_MAGIC) {
    return null;
  }
  const version = bytes[4];
  if (version !== STEGO_VERSION) {
    return null;
  }
  const length = bytes[5];
  if (length === 0 || length > STEGO_MAX_PAYLOAD_BYTES) {
    return null;
  }
  if (bytes.length < 10 + length) {
    return null;
  }
  const body = bytes.slice(6, 6 + length);
  const tail = bytes.slice(6 + length, 10 + length);
  const expected = Buffer.alloc(4);
  expected.writeUInt32BE(crc32(bytes.slice(0, 6 + length)), 0);
  if (Buffer.compare(Buffer.from(tail), expected) !== 0) {
    return null;
  }
  return Buffer.from(body).toString('utf8');
}

/** 载荷的总字节数（含头尾），text 为空时返回 0。 */
export function payloadByteLength(text: string): number {
  const bytes = encodePayload(text);
  return bytes ? bytes.length : 0;
}

export function bytesToBits(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    for (let b = 7; b >= 0; b -= 1) {
      bits.push((bytes[i] >> b) & 1);
    }
  }
  return bits;
}

export function bitsToBytes(bits: number[]): Uint8Array {
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i += 1) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) {
      byte = (byte << 1) | (bits[i * 8 + b] ? 1 : 0);
    }
    out[i] = byte;
  }
  return new Uint8Array(out);
}

/** mulberry32：小而稳定的 PRNG，嵌入和提取必须得到同一串数。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 种子 = sha256(key|宽|高|块大小) 的前 4 字节，尺寸变了种子就变（提取会失败，属预期）。 */
export function stegoSeed(key: string, width: number, height: number): number {
  const digest = createHash('sha256')
    .update(`${key}|${width}|${height}|${STEGO_BLOCK}`)
    .digest();
  return digest.readUInt32BE(0);
}

export function blockCount(width: number, height: number): number {
  const cols = Math.floor(width / STEGO_BLOCK);
  const rows = Math.floor(height / STEGO_BLOCK);
  return cols > 0 && rows > 0 ? cols * rows : 0;
}

/** Fisher-Yates 全排列：同样的种子 + 块数 => 同样的块顺序（与像素内容无关，转码后仍一致）。 */
export function blockOrder(seed: number, count: number): Uint32Array {
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    order[i] = i;
  }
  const random = mulberry32(seed);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

/** 给定尺寸与重复次数，最多能藏多少 bit。 */
export function stegoBitCapacity(width: number, height: number, repetition: number): number {
  const blocks = blockCount(width, height);
  if (blocks <= 0 || repetition <= 0) {
    return 0;
  }
  return Math.floor(blocks / (2 * repetition));
}

/** 为这段文本挑一个能装下的重复次数；装不下返回 0。 */
export function pickRepetition(text: string, width: number, height: number): number {
  const bytes = payloadByteLength(text);
  if (!bytes) {
    return 0;
  }
  const bits = bytes * 8;
  for (const repetition of STEGO_REPETITIONS) {
    if (stegoBitCapacity(width, height, repetition) >= bits) {
      return repetition;
    }
  }
  return 0;
}

type Rgba = Uint8Array | Buffer;

function blockMeanLuma(rgba: Rgba, width: number, blockIndex: number): number {
  const cols = Math.floor(width / STEGO_BLOCK);
  const bx = (blockIndex % cols) * STEGO_BLOCK;
  const by = Math.floor(blockIndex / cols) * STEGO_BLOCK;
  let sum = 0;
  let n = 0;
  for (let y = by; y < by + STEGO_BLOCK; y += 1) {
    for (let x = bx; x < bx + STEGO_BLOCK; x += 1) {
      const i = (y * width + x) * 4;
      sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

/** 整块加/减同一个值（RGB 三通道一起，alpha 不动），自动裁剪到 0..255。 */
function shiftBlock(rgba: Rgba, width: number, blockIndex: number, delta: number) {
  if (!delta) {
    return;
  }
  const cols = Math.floor(width / STEGO_BLOCK);
  const bx = (blockIndex % cols) * STEGO_BLOCK;
  const by = Math.floor(blockIndex / cols) * STEGO_BLOCK;
  for (let y = by; y < by + STEGO_BLOCK; y += 1) {
    for (let x = bx; x < bx + STEGO_BLOCK; x += 1) {
      const i = (y * width + x) * 4;
      rgba[i] = clamp255(rgba[i] + delta);
      rgba[i + 1] = clamp255(rgba[i + 1] + delta);
      rgba[i + 2] = clamp255(rgba[i + 2] + delta);
    }
  }
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

export interface EmbedOptions {
  key: string;
  /** 格点间距，默认 STEGO_DELTA。嵌入与提取必须一致。 */
  delta?: number;
  maxDelta?: number;
  repetition?: number;
}

export interface EmbedResult {
  embedded: boolean;
  repetition: number;
  bits: number;
  /** 没埋进去时的原因，便于日志与后台提示。 */
  reason?: string;
}

/**
 * 在 RGBA 像素上就地嵌入文本。返回是否成功；容量不够或图片太小时不修改像素。
 */
export function embedStegoIntoRgba(
  rgba: Rgba,
  width: number,
  height: number,
  text: string,
  options: EmbedOptions,
): EmbedResult {
  const delta = options?.delta ?? STEGO_DELTA;
  const maxDelta = options?.maxDelta ?? STEGO_MAX_DELTA;
  const payload = encodePayload(text);
  if (!payload) {
    return { embedded: false, repetition: 0, bits: 0, reason: 'payload-empty-or-too-long' };
  }
  const bits = bytesToBits(payload);
  const repetition =
    options?.repetition || pickRepetition(text, width, height);
  if (!repetition) {
    return { embedded: false, repetition: 0, bits: bits.length, reason: 'image-too-small' };
  }
  const blocks = blockCount(width, height);
  const need = bits.length * repetition * 2;
  if (need > blocks) {
    return { embedded: false, repetition, bits: bits.length, reason: 'not-enough-blocks' };
  }
  const order = blockOrder(stegoSeed(options.key, width, height), blocks);
  let cursor = 0;
  // 必须和 readBits 的遍历顺序完全一致（bit 外层、重复内层），否则块对会错位。
  for (let i = 0; i < bits.length; i += 1) {
    for (let r = 0; r < repetition; r += 1) {
      const a = order[cursor++];
      const b = order[cursor++];
      applyBit(rgba, width, a, b, bits[i], delta, maxDelta);
    }
  }
  return { embedded: true, repetition, bits: bits.length };
}

/** 离 diff 最近的目标格点：bit=0 是 delta 的整数倍，bit=1 是半格（奇数倍 delta/2）。 */
export function nearestLattice(diff: number, bit: number, delta: number): number {
  if (bit) {
    const half = delta / 2;
    return Math.round((diff - half) / delta) * delta + half;
  }
  return Math.round(diff / delta) * delta;
}

/** 把亮度差折回 [-delta/2, delta/2)，用来判决 bit。 */
export function foldDiff(diff: number, delta: number): number {
  const half = delta / 2;
  return ((((diff + half) % delta) + delta) % delta) - half;
}

function applyBit(
  rgba: Rgba,
  width: number,
  blockA: number,
  blockB: number,
  bit: number,
  delta: number,
  maxDelta: number,
) {
  const diff = blockMeanLuma(rgba, width, blockA) - blockMeanLuma(rgba, width, blockB);
  const target = nearestLattice(diff, bit, delta);
  const need = target - diff;
  if (Math.abs(need) < 0.5) {
    return; // 已经在格点上，不动像素
  }
  // 两块各承担一半；|need| <= delta/2，所以 delta/4 的调整量一定够
  const shift = Math.max(-maxDelta, Math.min(maxDelta, Math.round(need / 2)));
  shiftBlock(rgba, width, blockA, shift);
  shiftBlock(rgba, width, blockB, -shift);
}

export interface ExtractOptions {
  key: string;
  /** 格点间距，必须和嵌入时一致。 */
  delta?: number;
  /** 只试某个重复次数；默认按 STEGO_REPETITIONS 依次尝试。 */
  repetition?: number;
}

export interface ExtractResult {
  found: boolean;
  payload?: string;
  repetition?: number;
  /** 参与投票但落在死区里的 bit 数，越多说明图被压得越狠。 */
  uncertain?: number;
}

/** 从 RGBA 像素里盲提取水印文本；magic/CRC 不对就当没有。 */
export function extractStegoFromRgba(
  rgba: Rgba,
  width: number,
  height: number,
  options: ExtractOptions,
): ExtractResult {
  const delta = options?.delta ?? STEGO_DELTA;
  const blocks = blockCount(width, height);
  if (blocks < 2) {
    return { found: false };
  }
  const order = blockOrder(stegoSeed(options.key, width, height), blocks);
  const repetitions = options?.repetition ? [options.repetition] : STEGO_REPETITIONS;
  const headerBits = 6 * 8; // magic(4) + version(1) + length(1)

  for (const repetition of repetitions) {
    const header = readBits(rgba, width, order, repetition, headerBits, delta);
    if (!header) {
      continue;
    }
    const headerBytes = bitsToBytes(header.bits);
    if (Buffer.from(headerBytes.slice(0, 4)).toString('ascii') !== STEGO_MAGIC) {
      continue;
    }
    if (headerBytes[4] !== STEGO_VERSION) {
      continue;
    }
    const length = headerBytes[5];
    if (!length || length > STEGO_MAX_PAYLOAD_BYTES) {
      continue;
    }
    const totalBits = (10 + length) * 8;
    const all = readBits(rgba, width, order, repetition, totalBits, delta);
    if (!all) {
      continue;
    }
    const payload = decodePayload(bitsToBytes(all.bits));
    if (payload) {
      return { found: true, payload, repetition, uncertain: all.uncertain };
    }
  }
  return { found: false };
}

function readBits(
  rgba: Rgba,
  width: number,
  order: Uint32Array,
  repetition: number,
  bitCount: number,
  delta: number,
): { bits: number[]; uncertain: number } | null {
  const need = bitCount * repetition * 2;
  if (need > order.length || repetition <= 0) {
    return null;
  }
  const gate = delta / 4;
  const bits: number[] = [];
  let uncertain = 0;
  let cursor = 0;
  for (let i = 0; i < bitCount; i += 1) {
    let ones = 0;
    let zeros = 0;
    for (let r = 0; r < repetition; r += 1) {
      const a = order[cursor++];
      const b = order[cursor++];
      const diff = blockMeanLuma(rgba, width, a) - blockMeanLuma(rgba, width, b);
      const folded = Math.abs(foldDiff(diff, delta));
      if (Math.abs(folded - gate) < 1) {
        uncertain += 1; // 擦边：这一票不太可信
      }
      if (folded > gate) {
        ones += 1;
      } else {
        zeros += 1;
      }
    }
    if (ones === zeros) {
      uncertain += 1;
      bits.push(0); // 平票：交给 CRC 判定整段是否可信
    } else {
      bits.push(ones > zeros ? 1 : 0);
    }
  }
  return { bits, uncertain };
}
