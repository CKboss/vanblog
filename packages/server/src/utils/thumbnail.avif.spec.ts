import * as fs from 'fs';
import * as path from 'path';
import {
  THUMB_AVIF_ENV,
  generateAvifThumbIfEnabled,
  generateThumbnailAvif,
  resolveThumbAvifEnabled,
} from './thumbnail';
import { isAvifBuffer, tryLoadSharp } from './avif';

/**
 * P7 AVIF 缩略图：
 *  - env 开关默认**关**（负控：把 resolveThumbAvifEnabled 的 fallback 改成 true，
 *    "默认关"用例立刻红）；
 *  - 真 sharp 编出**真的是 AVIF**（魔数校验，不是"返回了个 buffer 就算过"的假量具）；
 *  - 关闭时 generateAvifThumbIfEnabled 根本不碰编码器（返回 null）；
 *  - static.provider 的三处接线（上传/删除/补图）用源码钉子钉住。
 */

const HAS_SHARP = (() => {
  try {
    return tryLoadSharp() !== null;
  } catch {
    return false;
  }
})();
const withSharp = HAS_SHARP ? describe : describe.skip;

async function makePng(width = 120, height = 80): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require('sharp');
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

describe('resolveThumbAvifEnabled（env 解析）', () => {
  const OLD = process.env[THUMB_AVIF_ENV];
  afterEach(() => {
    if (OLD === undefined) delete process.env[THUMB_AVIF_ENV];
    else process.env[THUMB_AVIF_ENV] = OLD;
  });

  it('默认关（不设 env → false）；显式开/关；非法值回落', () => {
    delete process.env[THUMB_AVIF_ENV];
    expect(resolveThumbAvifEnabled()).toBe(false); // ⚠️ 默认必须是关
    expect(resolveThumbAvifEnabled(undefined)).toBe(false);
    expect(resolveThumbAvifEnabled('')).toBe(false);
    for (const on of ['true', '1', 'yes', 'ON']) {
      expect(resolveThumbAvifEnabled(on)).toBe(true);
    }
    for (const off of ['false', '0', 'no', 'OFF']) {
      expect(resolveThumbAvifEnabled(off)).toBe(false);
    }
    expect(resolveThumbAvifEnabled('maybe')).toBe(false);
    expect(resolveThumbAvifEnabled('maybe', true)).toBe(true);
  });
});

withSharp('generateThumbnailAvif（真 sharp）', () => {
  it('编出真的是 AVIF 的缩略图：魔数、尺寸、ext/mime', async () => {
    const png = await makePng(120, 80);
    const res = await generateThumbnailAvif(png, 60, 'png');
    expect(res.ok).toBe(true);
    expect(res.ext).toBe('.avif');
    expect(res.mime).toBe('image/avif');
    expect(isAvifBuffer(res.buffer as Buffer)).toBe(true); // ⚠️ 真魔数校验，不是非空就算
    expect(res.width).toBe(60);
    expect(res.height).toBe(40);
  }, 30000);

  it('width<=0 → disabled；svg → unsupported；坏数据 → 明确 reason（不抛）', async () => {
    expect(await generateThumbnailAvif(Buffer.alloc(10), 0, 'png')).toEqual({
      ok: false,
      reason: 'disabled',
    });
    const png = await makePng();
    expect((await generateThumbnailAvif(png, 60, 'svg')).reason).toBe('unsupported');
    const bad = await generateThumbnailAvif(Buffer.from('这不是图片'), 60, 'png');
    expect(bad.ok).toBe(false);
    expect(String(bad.reason)).toMatch(/avif-encode-failed|decode/);
  }, 30000);

  it('generateAvifThumbIfEnabled：关 → null（不碰编码器）；开 → 真 AVIF', async () => {
    const png = await makePng(80, 60);
    expect(await generateAvifThumbIfEnabled(png, 40, 'png', 'false')).toBeNull();
    expect(await generateAvifThumbIfEnabled(png, 40, 'png', undefined)).toBeNull(); // 未设 env = 关
    const on = await generateAvifThumbIfEnabled(png, 40, 'png', 'true');
    expect(on?.ok).toBe(true);
    expect(isAvifBuffer(on?.buffer as Buffer)).toBe(true);
  }, 30000);
});

describe('static.provider 的 AVIF 接线（源码级钉子）', () => {
  // __dirname = packages/server/src/utils → 上 2 级到 packages/server
  const src = fs.readFileSync(
    path.resolve(__dirname, '../provider/static/static.provider.ts'),
    'utf8',
  );

  it('上传路径：webp 缩略图之后生成 AVIF 兄弟并写 meta.thumbAvif', () => {
    expect(src).toContain('generateAvifThumbIfEnabled(');
    expect(src).toContain('thumbAvif: avifPath');
    expect(src).toContain('thumbAvifBytes: avifThumb.buffer.length');
  });

  it('删除路径：thumbAvif 跟着原图一起删（不留孤儿）', () => {
    expect(src).toContain("const thumbAvif = (toDeleteData?.meta as any)?.thumbAvif;");
    expect(src).toContain('deleteStaticFile(thumbAvif)');
  });

  it('替换路径：旧 thumbAvif 被清理；补图路径：存量图片也能补 AVIF 兄弟', () => {
    expect(src).toContain('delete meta.thumbAvif;');
    expect(src).toContain('oldThumbAvif');
    expect(src).toContain('avifGenerated');
    expect(src).toContain('resolveThumbAvifEnabled()');
  });
});
