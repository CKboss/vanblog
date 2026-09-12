import {
  STEGO_MAGIC,
  STEGO_VERSION,
  bitsToBytes,
  blockCount,
  blockOrder,
  bytesToBits,
  crc32,
  decodePayload,
  embedStegoIntoRgba,
  encodePayload,
  extractStegoFromRgba,
  mulberry32,
  payloadByteLength,
  pickRepetition,
  stegoBitCapacity,
  stegoSeed,
} from './stego';

const KEY = 'unit-test-key';

/** 确定性伪随机中间调图片，避免测试里出现纯黑/纯白块（会触发裁剪）。 */
function makeRgba(width: number, height: number, seed = 42): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const random = mulberry32(seed);
  for (let i = 0; i < width * height; i += 1) {
    const base = 90 + Math.floor(random() * 80); // 90..169，±4 调整不会裁剪
    rgba[i * 4] = base;
    rgba[i * 4 + 1] = Math.min(255, base + Math.floor(random() * 20));
    rgba[i * 4 + 2] = Math.max(0, base - Math.floor(random() * 20));
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** 模拟有损压缩带来的轻微噪声（每个通道 ±2）。 */
function addNoise(rgba: Uint8Array, seed = 7, amount = 2) {
  const out = Uint8Array.from(rgba);
  const random = mulberry32(seed);
  for (let i = 0; i + 3 < out.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const delta = Math.round((random() * 2 - 1) * amount);
      out[i + c] = Math.max(0, Math.min(255, out[i + c] + delta));
    }
  }
  return out;
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789')).toString(16)).toBe('cbf43926');
    expect(crc32(Buffer.from(''))).toBe(0);
  });
});

describe('payload codec', () => {
  it('round-trips text', () => {
    const text = 'codebonobo.tech|JiangOil|2026-09-12T07:40:00Z';
    const bytes = encodePayload(text);
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!.slice(0, 4)).toString('ascii')).toBe(STEGO_MAGIC);
    expect(bytes![4]).toBe(STEGO_VERSION);
    expect(bytes![5]).toBe(Buffer.byteLength(text, 'utf8'));
    expect(decodePayload(bytes!)).toBe(text);
  });

  it('keeps CJK payloads intact', () => {
    const text = '酱_油 aka JiangOil|2026-09-12';
    expect(decodePayload(encodePayload(text)!)).toBe(text);
  });

  it('rejects tampered payloads instead of returning garbage', () => {
    const bytes = encodePayload('hello world');
    const tampered = Uint8Array.from(bytes!);
    tampered[8] ^= 0xff;
    expect(decodePayload(tampered)).toBeNull();

    const badMagic = Uint8Array.from(bytes!);
    badMagic[0] = 0x58;
    expect(decodePayload(badMagic)).toBeNull();

    expect(decodePayload(new Uint8Array(4))).toBeNull();
    expect(encodePayload('')).toBeNull();
    expect(encodePayload('x'.repeat(201))).toBeNull();
  });

  it('converts bytes and bits both ways', () => {
    const bytes = encodePayload('abc')!;
    expect(bitsToBytes(bytesToBits(bytes))).toEqual(bytes);
    expect(payloadByteLength('abc')).toBe(bytes.length);
    expect(payloadByteLength('')).toBe(0);
  });
});

describe('block geometry', () => {
  it('counts 8x8 blocks and derives a stable seed', () => {
    expect(blockCount(1920, 1080)).toBe(240 * 135);
    expect(blockCount(7, 100)).toBe(0);
    expect(stegoSeed(KEY, 100, 100)).toBe(stegoSeed(KEY, 100, 100));
    expect(stegoSeed(KEY, 100, 100)).not.toBe(stegoSeed(KEY, 100, 108));
    expect(stegoSeed('other', 100, 100)).not.toBe(stegoSeed(KEY, 100, 100));
  });

  it('produces a deterministic permutation of every block', () => {
    const count = 1000;
    const a = blockOrder(stegoSeed(KEY, 800, 80), count);
    const b = blockOrder(stegoSeed(KEY, 800, 80), count);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(new Set(Array.from(a)).size).toBe(count);
    expect(Math.min(...Array.from(a))).toBe(0);
    expect(Math.max(...Array.from(a))).toBe(count - 1);
  });

  it('reports capacity and picks the strongest repetition that fits', () => {
    expect(stegoBitCapacity(1920, 1080, 3)).toBe(Math.floor(32400 / 6));
    expect(stegoBitCapacity(100, 100, 1)).toBe(Math.floor(blockCount(100, 100) / 2));
    expect(stegoBitCapacity(10, 10, 3)).toBe(0);
    expect(pickRepetition('x'.repeat(40), 1920, 1080)).toBe(3);
    expect(pickRepetition('x'.repeat(40), 64, 64)).toBe(0); // 64 块，装不下
    expect(pickRepetition('', 1920, 1080)).toBe(0);
  });
});

describe('embed / extract', () => {
  const text = 'codebonobo.tech|JiangOil|2026-09-12T07:40:00Z';

  it('round-trips on a plain RGBA buffer', () => {
    const width = 640;
    const height = 480;
    const rgba = makeRgba(width, height);
    const clean = Uint8Array.from(rgba);

    const res = embedStegoIntoRgba(rgba, width, height, text, { key: KEY });

    expect(res.embedded).toBe(true);
    expect(res.repetition).toBe(3);
    expect(res.bits).toBe(payloadByteLength(text) * 8);

    const out = extractStegoFromRgba(rgba, width, height, { key: KEY });
    expect(out.found).toBe(true);
    expect(out.payload).toBe(text);
    expect(out.repetition).toBe(3);

    // 肉眼不可见：改动幅度很小
    let maxDiff = 0;
    let changed = 0;
    for (let i = 0; i < rgba.length; i += 1) {
      const diff = Math.abs(rgba[i] - clean[i]);
      if (diff > 0) {
        changed += 1;
        maxDiff = Math.max(maxDiff, diff);
      }
    }
    expect(maxDiff).toBeLessThanOrEqual(4);
    // 平均每个通道只动了一点点，肉眼不可见
    let totalDiff = 0;
    for (let i = 0; i < rgba.length; i += 1) {
      totalDiff += Math.abs(rgba[i] - clean[i]);
    }
    expect(totalDiff / rgba.length).toBeLessThan(1.5);
  });

  it('survives mild per-channel noise (lossy transcoding proxy)', () => {
    const width = 640;
    const height = 480;
    const rgba = makeRgba(width, height, 11);
    embedStegoIntoRgba(rgba, width, height, text, { key: KEY });

    const noisy = addNoise(rgba, 99, 2);
    const out = extractStegoFromRgba(noisy, width, height, { key: KEY });
    expect(out.found).toBe(true);
    expect(out.payload).toBe(text);
  });

  it('does not report a watermark on untouched images', () => {
    for (const seed of [1, 2, 3, 4]) {
      const rgba = makeRgba(320, 240, seed);
      expect(extractStegoFromRgba(rgba, 320, 240, { key: KEY }).found).toBe(false);
    }
  });

  it('needs the right key', () => {
    const width = 640;
    const height = 480;
    const rgba = makeRgba(width, height, 5);
    embedStegoIntoRgba(rgba, width, height, text, { key: KEY });

    expect(extractStegoFromRgba(rgba, width, height, { key: 'wrong-key' }).found).toBe(false);
    expect(extractStegoFromRgba(rgba, width, height, { key: KEY }).payload).toBe(text);
  });

  it('fails (by design) when the image is resized, because the seed binds to dimensions', () => {
    const rgba = makeRgba(640, 480, 6);
    embedStegoIntoRgba(rgba, 640, 480, text, { key: KEY });
    // 同一份像素换个尺寸解读 => 种子不同 => 读不出来
    expect(extractStegoFromRgba(rgba, 480, 640, { key: KEY }).found).toBe(false);
  });

  it('refuses images that are too small and leaves them untouched', () => {
    const rgba = makeRgba(48, 48, 8);
    const before = Uint8Array.from(rgba);

    const res = embedStegoIntoRgba(rgba, 48, 48, text, { key: KEY });

    expect(res.embedded).toBe(false);
    expect(res.reason).toBe('image-too-small');
    expect(Array.from(rgba)).toEqual(Array.from(before));
  });

  it('falls back to a weaker repetition on smaller images', () => {
    const width = 400;
    const height = 400;
    const rgba = makeRgba(width, height, 21);
    const res = embedStegoIntoRgba(rgba, width, height, text, { key: KEY });

    expect(res.embedded).toBe(true);
    expect(res.repetition).toBeLessThan(3);
    expect(extractStegoFromRgba(rgba, width, height, { key: KEY }).payload).toBe(text);
  });

  it('keeps embedding idempotent for the same input', () => {
    const a = makeRgba(320, 240, 31);
    const b = makeRgba(320, 240, 31);
    embedStegoIntoRgba(a, 320, 240, 'same', { key: KEY });
    embedStegoIntoRgba(b, 320, 240, 'same', { key: KEY });
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
