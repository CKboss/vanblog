import { capImageResolution, shouldSkipResize } from './imgResize';
import { generateThumbnail, thumbNameFor } from './thumbnail';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');

// 生成噪声图 + JPEG 编码本身就要几秒，别被默认的 5s 卡住
jest.setTimeout(60000);

/** 生成一张带噪声的真实位图（纯色图对压缩/缩放的测试没有意义）。 */
async function makeNoiseImage(width: number, height: number, format = 'jpeg'): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  let seed = 987654321;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < width * height; i += 1) {
    const base = 70 + Math.floor(rnd() * 110);
    data[i * 3] = base;
    data[i * 3 + 1] = Math.min(255, base + Math.floor(rnd() * 30));
    data[i * 3 + 2] = Math.max(0, base - Math.floor(rnd() * 30));
  }
  const pipeline = sharp(data, { raw: { width, height, channels: 3 } });
  return format === 'png' ? pipeline.png().toBuffer() : pipeline.jpeg({ quality: 90 }).toBuffer();
}

let bigLandscape: Buffer;
let bigPortrait: Buffer;
let smallImage: Buffer;
let tinyImage: Buffer;
let bigPng: Buffer;

beforeAll(async () => {
  bigLandscape = await makeNoiseImage(2400, 1600);
  bigPortrait = await makeNoiseImage(1200, 2400);
  smallImage = await makeNoiseImage(800, 600);
  tinyImage = await makeNoiseImage(120, 90);
  bigPng = await makeNoiseImage(2000, 1000, 'png');
});

describe('capImageResolution', () => {
  it('scales a big image down to the long edge and keeps the aspect ratio', async () => {
    const src = bigLandscape;

    const res = await capImageResolution(src, 1920, 'jpg');

    expect(res.resized).toBe(true);
    expect(res.width).toBe(1920);
    expect(res.height).toBe(1280);
    const meta = await sharp(res.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(res.buffer.length).toBeLessThan(src.length * 1.5);
  });

  it('caps by the long edge for portrait images too', async () => {
    const src = bigPortrait;

    const res = await capImageResolution(src, 1920, 'jpg');

    expect(res.resized).toBe(true);
    expect(res.height).toBe(1920);
    expect(res.width).toBe(960);
  });

  it('leaves images that already fit completely untouched', async () => {
    const src = smallImage;

    const res = await capImageResolution(src, 1920, 'jpg');

    expect(res.resized).toBe(false);
    expect(res.skipped).toBe('already-small');
    expect(res.buffer).toBe(src); // 同一个 buffer，没有重新编码
  });

  it('never upscales', async () => {
    const src = tinyImage;

    const res = await capImageResolution(src, 320, 'jpg');

    expect(res.resized).toBe(false);
    expect(res.width).toBe(120);
  });

  it('is a no-op when the limit is 0 or the type is animated/vector', async () => {
    const src = bigLandscape;

    expect((await capImageResolution(src, 0, 'jpg')).skipped).toBe('disabled');
    expect((await capImageResolution(src, 1920, 'gif')).skipped).toBe('unsupported');
    expect((await capImageResolution(src, 1920, 'svg')).skipped).toBe('unsupported');
    expect(shouldSkipResize('GIF')).toBe(true);
    expect(shouldSkipResize('png')).toBe(false);
  });

  it('keeps PNG as PNG', async () => {
    const src = bigPng;

    const res = await capImageResolution(src, 1000, 'png');

    expect(res.resized).toBe(true);
    expect(res.width).toBe(1000);
    const meta = await sharp(res.buffer).metadata();
    expect(meta.format).toBe('png');
  });
});

describe('generateThumbnail', () => {
  it('builds a small webp thumbnail', async () => {
    const src = bigLandscape;

    const res = await generateThumbnail(src, 300, 'jpg');

    expect(res.ok).toBe(true);
    expect(res.ext).toBe('.webp');
    expect(res.mime).toBe('image/webp');
    expect(res.width).toBe(300);
    expect(res.height).toBe(200);
    const meta = await sharp(res.buffer!).metadata();
    expect(meta.format).toBe('webp');
    expect(res.buffer!.length).toBeLessThan(src.length);
  });

  it('does not upscale small images', async () => {
    const src = tinyImage;

    const res = await generateThumbnail(src, 300, 'jpg');

    expect(res.ok).toBe(true);
    expect(res.width).toBe(120);
  });

  it('reports why it skipped', async () => {
    const src = smallImage;

    expect((await generateThumbnail(src, 0, 'jpg')).reason).toBe('disabled');
    expect((await generateThumbnail(src, 300, 'svg')).reason).toBe('unsupported');
  });

  it('names the thumbnail after the original file', () => {
    expect(thumbNameFor('0a1b.png', '.webp')).toBe('0a1b.webp');
    expect(thumbNameFor('0a1b.照片.jpeg', '.webp')).toBe('0a1b.照片.webp');
    expect(thumbNameFor('noext', '.webp')).toBe('noext.webp');
    expect(thumbNameFor('a.png', 'webp')).toBe('a.webp');
  });
});
