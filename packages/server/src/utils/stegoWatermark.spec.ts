import { compressImg } from './imgCompress';
import { buildStegoPayload, domainOf, parseMaxImageEdge, parseThumbWidth } from './imageOptions';
import { embedStegoWatermark, extractStegoWatermark, isStegoSupportedFormat } from './stegoWatermark';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');

// 造噪声图 + 多次转码很慢，放宽超时
jest.setTimeout(90000);

const KEY = 'stego-integration-key';
const TEXT = 'www.codebonobo.tech|JiangOil|2026-09-12T07:40:00Z';

async function makeNoiseImage(width: number, height: number, format = 'jpeg'): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  let seed = 24680;
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
  if (format === 'png') {
    return pipeline.png().toBuffer();
  }
  if (format === 'webp') {
    return pipeline.webp({ quality: 90 }).toBuffer();
  }
  return pipeline.jpeg({ quality: 90 }).toBuffer();
}

let jpeg900: Buffer;
let jpeg800: Buffer;
let jpeg400: Buffer;
let png700: Buffer;
let webp700: Buffer;
let tiny64: Buffer;

beforeAll(async () => {
  jpeg900 = await makeNoiseImage(900, 700);
  jpeg800 = await makeNoiseImage(800, 600);
  jpeg400 = await makeNoiseImage(400, 300);
  png700 = await makeNoiseImage(700, 500, 'png');
  webp700 = await makeNoiseImage(700, 500, 'webp');
  tiny64 = await makeNoiseImage(64, 64);
});

describe('image option parsing', () => {
  it('clamps and interprets the resize limit', () => {
    expect(parseMaxImageEdge('1920')).toBe(1920);
    expect(parseMaxImageEdge(0)).toBe(0);
    expect(parseMaxImageEdge(-5)).toBe(0);
    expect(parseMaxImageEdge('abc')).toBe(0);
    expect(parseMaxImageEdge(100)).toBe(320); // 太小的上限没意义，抬到下限
    expect(parseMaxImageEdge(99999)).toBe(8192);
  });

  it('clamps the thumbnail width', () => {
    expect(parseThumbWidth(undefined)).toBe(300);
    expect(parseThumbWidth('400')).toBe(400);
    expect(parseThumbWidth(10)).toBe(64);
    expect(parseThumbWidth(4096)).toBe(1024);
  });

  it('derives a domain and a default payload', () => {
    expect(domainOf('https://www.example.com/')).toBe('www.example.com');
    expect(domainOf('http://blog.local:3000/post/1')).toBe('blog.local:3000');
    expect(domainOf('')).toBe('');

    const payload = buildStegoPayload({
      baseUrl: 'https://www.example.com/',
      uploader: 'JiangOil',
      now: new Date('2026-09-12T07:40:00.123Z'),
    });
    expect(payload).toBe('www.example.com|JiangOil|2026-09-12T07:40:00Z');

    expect(
      buildStegoPayload({ custom: '  自定义水印  ', baseUrl: 'https://a.com', uploader: 'x' }),
    ).toBe('自定义水印');
    expect(buildStegoPayload({ baseUrl: '', uploader: '', now: new Date(0) })).toBe('1970-01-01T00:00:00Z');
    expect(buildStegoPayload({ custom: 'x'.repeat(400) }).length).toBeLessThanOrEqual(200);
  });
});

describe('stego watermark on real images', () => {
  it('supports the common raster formats only', () => {
    expect(isStegoSupportedFormat('jpeg')).toBe(true);
    expect(isStegoSupportedFormat('PNG')).toBe(true);
    expect(isStegoSupportedFormat('webp')).toBe(true);
    expect(isStegoSupportedFormat('gif')).toBe(false);
    expect(isStegoSupportedFormat('svg')).toBe(false);
    expect(isStegoSupportedFormat('')).toBe(false);
  });

  it('embeds invisibly and reads the payload back', async () => {
    // 用 png（无损）量像素差，才能把"水印本身的改动"和"重新编码的误差"分开
    const src = png700;

    const embedded = await embedStegoWatermark(src, TEXT, KEY);
    expect(embedded.embedded).toBe(true);
    expect(embedded.repetition).toBe(3);
    expect(embedded.buffer.length).toBeGreaterThan(0);

    const a = await sharp(src).ensureAlpha().raw().toBuffer();
    const b = await sharp(embedded.buffer).ensureAlpha().raw().toBuffer();
    let total = 0;
    let max = 0;
    for (let i = 0; i < a.length; i += 1) {
      const diff = Math.abs(a[i] - b[i]);
      total += diff;
      max = Math.max(max, diff);
    }
    // 每个像素最多被推移 STEGO_MAX_DELTA(4) 个色阶，平均不到 1 个色阶
    expect(max).toBeLessThanOrEqual(4);
    expect(total / a.length).toBeLessThan(1);

    const out = await extractStegoWatermark(embedded.buffer, KEY);
    expect(out.found).toBe(true);
    expect(out.payload).toBe(TEXT);
  });

  it('round-trips through a jpeg source as well', async () => {
    const embedded = await embedStegoWatermark(jpeg800, TEXT, KEY);
    expect(embedded.embedded).toBe(true);

    const out = await extractStegoWatermark(embedded.buffer, KEY);
    expect(out.found).toBe(true);
    expect(out.payload).toBe(TEXT);
  });

  it('survives the webp compression that runs right after upload', async () => {
    const src = jpeg900;

    const embedded = await embedStegoWatermark(src, TEXT, KEY);
    expect(embedded.embedded).toBe(true);

    const webp = await compressImg(embedded.buffer, 'webp');
    expect((await sharp(webp).metadata()).format).toBe('webp');

    const out = await extractStegoWatermark(webp, KEY);
    expect(out.found).toBe(true);
    expect(out.payload).toBe(TEXT);
  });

  it('survives a second lossy transcode (someone re-saving as jpeg)', async () => {
    const src = jpeg900;
    const embedded = await embedStegoWatermark(src, TEXT, KEY);

    const resaved = await sharp(embedded.buffer).jpeg({ quality: 75 }).toBuffer();

    const out = await extractStegoWatermark(resaved, KEY);
    expect(out.found).toBe(true);
    expect(out.payload).toBe(TEXT);
  });

  it('works on png and webp sources too', async () => {
    for (const [format, src] of [
      ['png', png700],
      ['webp', webp700],
    ] as [string, Buffer][]) {
      const embedded = await embedStegoWatermark(src, TEXT, KEY);
      expect(embedded.embedded).toBe(true);
      expect((await sharp(embedded.buffer).metadata()).format).toBe(format);

      const out = await extractStegoWatermark(embedded.buffer, KEY);
      expect(out.found).toBe(true);
      expect(out.payload).toBe(TEXT);
    }
  });

  it('does nothing without a key and leaves the bytes alone', async () => {
    const src = jpeg400;

    const res = await embedStegoWatermark(src, TEXT, '');
    expect(res.embedded).toBe(false);
    expect(res.reason).toBe('disabled');
    expect(res.buffer).toBe(src);
  });

  it('gives up on images too small to carry the payload', async () => {
    const src = tiny64;

    const res = await embedStegoWatermark(src, TEXT, KEY);

    expect(res.embedded).toBe(false);
    expect(res.reason).toBe('image-too-small');
    expect(res.buffer).toBe(src);
  });

  it('needs the right key and never reports a mark on a clean image', async () => {
    const src = jpeg800;
    const embedded = await embedStegoWatermark(src, TEXT, KEY);

    expect((await extractStegoWatermark(embedded.buffer, 'another-key')).found).toBe(false);
    expect((await extractStegoWatermark(src, KEY)).found).toBe(false);
    expect((await extractStegoWatermark(src, '')).reason).toBe('disabled');
  });
});
