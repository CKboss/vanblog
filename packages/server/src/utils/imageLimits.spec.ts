import { BadRequestException } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';
import { imageSize } from 'image-size';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import {
  MAX_IMAGE_PIXELS,
  SHARP_DEFAULT_LIMIT_INPUT_PIXELS,
  SHARP_LIMIT_INPUT_PIXELS,
  sharpInputOptions,
} from './imageLimits';
import { assertUploadedImage } from './uploadLimits';

jest.mock('image-size');

/**
 * 像素上限与 sharp 解码上限的**同源**钉子。
 *
 * 两件事要防：
 * 1. 上限本身被悄悄放宽（100MP → 更大），或者两个数分家 —— 一旦分家，**宽的那个就是实际上限**；
 * 2. 新增了一个 sharp 解码点却没带上限（库默认 268MP，比业务上限宽 6.7 倍），
 *    于是"业务检查失效"的那条路上又变成没有兜底。
 *
 * 为什么"业务检查会失效"不是假设：`assertUploadedImage` 靠 `image-size` 读文件头，
 * 读不出尺寸时（avif 的兜底分支）`meta` 只有 `{type:'avif'}`，`pixels` 算成 0 ⇒ **直接放行**。
 * 那条路上唯一还站着的就是 sharp 的 `limitInputPixels`。
 */

/** 1x1 的合法 PNG 字节（内容不重要，尺寸由 mock 决定）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const mockedImageSize = imageSize as unknown as jest.Mock;

function withDims(width: unknown, height: unknown, type = 'png') {
  mockedImageSize.mockImplementation(() => ({ type, width, height }));
}

describe('像素上限（MAX_IMAGE_PIXELS）与 sharp 的 limitInputPixels 同源', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('上限是 40MP，且注释里给了换算（40MP 解码后约 160MB RGBA）', () => {
    expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
    // 解码后 RGBA = 像素 × 4 字节；这条断言把"为什么是这个量级"钉住，
    // 免得有人只改数字却不知道自己在改内存预算
    expect(MAX_IMAGE_PIXELS * 4).toBe(160_000_000);
  });

  it('sharp 的上限与业务上限是**同一个值**（不是两个各自写死的数）', () => {
    expect(SHARP_LIMIT_INPUT_PIXELS).toBe(MAX_IMAGE_PIXELS);
    expect(sharpInputOptions().limitInputPixels).toBe(MAX_IMAGE_PIXELS);
  });

  it('我们的上限严格小于 sharp 的库默认值（否则"对齐"没有意义）', () => {
    expect(SHARP_DEFAULT_LIMIT_INPUT_PIXELS).toBe(268_402_689);
    expect(MAX_IMAGE_PIXELS).toBeLessThan(SHARP_DEFAULT_LIMIT_INPUT_PIXELS);
  });

  it('uploadLimits 的 re-export 与本体是同一个绑定（不会各写一个数）', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fromUploadLimits = require('./uploadLimits').MAX_IMAGE_PIXELS;
    expect(fromUploadLimits).toBe(MAX_IMAGE_PIXELS);
  });

  it('追加选项不会把 limitInputPixels 顶掉（覆盖就等于放宽）', () => {
    const opts = sharpInputOptions({ density: 72, limitInputPixels: 999_999_999 } as any);
    expect(opts.density).toBe(72);
    expect(opts.limitInputPixels).toBe(MAX_IMAGE_PIXELS);
  });

  it('旧值 100_000_000 在 src 里已经没有了（反证：这个字符串确实能被搜到）', () => {
    const srcDir = path.resolve(__dirname, '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
          // ⚠️ 必须跳过 spec：本文件下面的负向对照里就写着 `100_000_000` 这个字面量，
          //    不跳过的话这条断言会被自己的对照用例喂红（自指陷阱）。
          const text = stripCommentsForAnchor(readFileSync(full, 'utf-8'));
          if (/100_000_000|100000000/.test(text)) hits.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    expect(hits).toEqual([]);
    // 断言不是空转：把旧值写进一段合成代码，同一个正则必须命中
    expect(/100_000_000|100000000/.test('export const X = 100_000_000;')).toBe(true);
  });
});

describe('assertUploadedImage 的像素边界', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const side = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS)); // 6324，6324² = 39,992,976 ≤ 上限

  it('正好在上限内 → 通过', () => {
    withDims(side, side);
    expect(assertUploadedImage(PNG, 'a.png').type).toBe('png');
  });

  it('正好等于上限 → 通过（判据是 >，不是 >=）', () => {
    withDims(MAX_IMAGE_PIXELS, 1);
    expect(assertUploadedImage(PNG, 'a.png').type).toBe('png');
  });

  it('超过一个像素 → 400，且报文带上实际尺寸', () => {
    withDims(MAX_IMAGE_PIXELS + 1, 1);
    expect(() => assertUploadedImage(PNG, 'a.png')).toThrow(BadRequestException);
    try {
      assertUploadedImage(PNG, 'a.png');
    } catch (err) {
      expect(String((err as Error).message)).toContain('图片尺寸过大');
    }
  });

  it('刚刚超过"方形上限"的形状也拦得住（8000×5001 = 40,008,000）', () => {
    withDims(8000, 5001);
    expect(8000 * 5001).toBeGreaterThan(MAX_IMAGE_PIXELS);
    expect(() => assertUploadedImage(PNG, 'a.png')).toThrow(BadRequestException);
  });

  it('读不出尺寸（0 / 缺失 / 负数 / NaN）时**不拦** —— 这正是 sharp 上限必须同源的原因', () => {
    // ⚠️ 这条钉住的是**现状**，不是"这样最好"：image-size 读不出尺寸时 pixels 算成 0，
    //    于是超限图能从这道检查溜过去（avif 的兜底分支就是这个形状）。
    //    真正兜住它的是 sharp 的 limitInputPixels —— 所以两个数必须同源，
    //    谁把 sharp 那边的选项去掉，这条与上面的同源断言会一起红。
    for (const dims of [
      [0, 0],
      [undefined, undefined],
      [-5, -5],
      [NaN, NaN],
    ]) {
      withDims(dims[0], dims[1]);
      expect(() => assertUploadedImage(PNG, 'a.png')).not.toThrow();
    }
  });

  it('空内容仍然先被拒（像素检查之前）', () => {
    expect(() => assertUploadedImage(Buffer.alloc(0), 'a.png')).toThrow(BadRequestException);
  });
});

describe('漂移守卫：每个 sharp 解码点都带着像素上限', () => {
  const SRC = path.resolve(__dirname, '..');

  /**
   * ⚠️ 待办名单（**只允许这一个文件**）：`utils/watermark.ts` 本轮由另一个代理在改，
   * 它有 4 处解码调用方图片（`sharp(srcImage)` ×3 + `sharp(srcImage).metadata()`）
   * 和 6 处栅格化我们自己生成的 SVG。等它空出来要把 `sharpInputOptions()` 补上，
   * 然后把这个名单清空 —— 名单非空时下面那条"名单只有一个文件"的断言会提醒你别再往里加。
   */
  const PENDING = ['utils/watermark.ts'];

  function collectSharpSites(): { file: string; guarded: boolean }[] {
    const out: { file: string; guarded: boolean }[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
          const text = stripCommentsForAnchor(readFileSync(full, 'utf-8'));
          const rel = path.relative(SRC, full).split(path.sep).join('/');
          for (const m of text.matchAll(/\bsharp\s*\(/g)) {
            // 取调用点后面一小段窗口，看有没有我们的选项构造器
            const window = text.slice(m.index, m.index + 220);
            out.push({ file: rel, guarded: window.includes('sharpInputOptions') });
          }
        }
      }
    };
    walk(SRC);
    return out;
  }

  const sites = collectSharpSites();

  it('扫描本身没空转（真的找到了 sharp 调用点）', () => {
    expect(sites.length).toBeGreaterThan(8);
  });

  it('除待办名单外，每个 sharp 调用点都带 sharpInputOptions', () => {
    const unguarded = sites
      .filter((s) => !s.guarded && !PENDING.includes(s.file))
      .map((s) => s.file);
    expect([...new Set(unguarded)]).toEqual([]);
  });

  it('待办名单没有悄悄变长（要加文件必须是有意的决定）', () => {
    expect(PENDING).toEqual(['utils/watermark.ts']);
  });

  it('负向对照：一个不带上限的合成调用点会被判为 unguarded', () => {
    const synthetic = 'const sharp = tryLoadSharp();\nreturn sharp(srcImage).webp({}).toBuffer();';
    const window = synthetic.slice(synthetic.indexOf('sharp(srcImage)'), synthetic.indexOf('sharp(srcImage)') + 220);
    expect(window.includes('sharpInputOptions')).toBe(false);
    const guardedSame = synthetic.replace(
      'sharp(srcImage)',
      'sharp(srcImage, sharpInputOptions())',
    );
    const w2 = guardedSame.slice(
      guardedSame.indexOf('sharp(srcImage'),
      guardedSame.indexOf('sharp(srcImage') + 220,
    );
    expect(w2.includes('sharpInputOptions')).toBe(true);
  });

  it('六个已改文件的解码点数量与形状（防止有人把它们改回裸调用）', () => {
    const byFile = new Map<string, number>();
    for (const s of sites) {
      if (!s.guarded) continue;
      byFile.set(s.file, (byFile.get(s.file) || 0) + 1);
    }
    for (const f of [
      'utils/imgCompress.ts',
      'utils/avif.ts',
      'utils/thumbnail.ts',
      'utils/imgEncode.ts',
      'utils/stegoWatermark.ts',
      'utils/imgResize.ts',
    ]) {
      expect(byFile.get(f) || 0).toBeGreaterThan(0);
    }
  });

  it('imageLimits 是叶子模块（不 import 业务文件，避免 uploadLimits ↔ avif 循环依赖）', () => {
    const text = readFileSync(path.join(SRC, 'utils', 'imageLimits.ts'), 'utf-8');
    const imports = [...text.matchAll(/^import .*from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports).toEqual([]);
    // 反证：这个正则确实能从别的文件里抓到 import
    expect([...readFileSync(path.join(SRC, 'utils', 'uploadLimits.ts'), 'utf-8')
      .matchAll(/^import .*from '([^']+)';/gm)].length).toBeGreaterThan(0);
    expect(statSync(path.join(SRC, 'utils', 'imageLimits.ts')).size).toBeGreaterThan(0);
  });
});
