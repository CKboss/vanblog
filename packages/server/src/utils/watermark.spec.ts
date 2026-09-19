import { Logger } from '@nestjs/common';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  __resetWatermarkCachesForTest,
  addWaterMarkToIMG,
  generateWaterMark,
  notdefComparatorFor,
  probeFontCoverage,
  scanInk,
  smallImageTileStep,
  WATERMARK_MIN_SHORT_SIDE_PX,
} from './watermark';
import { tileMetrics, cornerMetrics, resolveWatermarkStyle, withCopyrightPrefix, buildTileSvg } from './watermarkSvg';

/**
 * 可见水印 spec（2026-09 sharp 重写版）。
 *
 * 旧版这里用 jimp 做合成与逐像素断言，两条 addWaterMarkToIMG 用例实测 13.3s / 20.8s
 * （jimp 纯 JS：解码、合成、编码、扫描全在 JS 里）。重写后同样的断言走 sharp/raw Buffer，
 * 单条用例目标 <1s —— 实测数字见交付报告；这里保留 30s 上限只是给并行 CI 的余量，
 * **不是用来掩盖慢的**（旧注释里"20 秒不够"的时代结束了）。
 *
 * 旧断言的性质全部保留（换了新返回类型的度量方式，一条没删）：
 *  - 带点域名能渲染、ink > 1000px（#322）
 *  - 不会被折行裁到第二行（SVG <text> 结构上不折行 + 单行高度断言）
 *  - 落在右下角、改变 >1000 像素（corner 样式 —— 旧默认位置语义由 corner 承接；
 *    新默认样式是 tile 平铺，有单独的周期性/无缝断言）
 */

const TEXT_WITHOUT_DOT = 'VanBlog';
const TEXT_WITH_DOT_SHORT = 'site.com';
const TEXT_WITH_DOT_DOMAIN = 'example.com';

// ---------------------------------------------------------------------------
// 工具：sharp 解码 + 单趟 diff（沿用旧 changedPixelsStats 的语义：比 RGB、统计包围盒）
// ---------------------------------------------------------------------------

const sharp: any = require('sharp');

interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

async function decodeRaw(buf: Buffer): Promise<Raw> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function solidPng(width: number, height: number, gray: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: gray, g: gray, b: gray } },
  })
    .png()
    .toBuffer();
}

/** RGB 任一通道变化即算 changed；单趟统计数量 + 包围盒（与旧 changedPixelsStats 相同定义）。 */
function diffStats(a: Raw, b: Raw, channelThreshold = 0) {
  let changed = 0;
  let minX = b.width;
  let minY = b.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0, idx = 0; y < b.height; y += 1) {
    for (let x = 0; x < b.width; x += 1, idx += 4) {
      if (
        Math.abs(a.data[idx] - b.data[idx]) > channelThreshold ||
        Math.abs(a.data[idx + 1] - b.data[idx + 1]) > channelThreshold ||
        Math.abs(a.data[idx + 2] - b.data[idx + 2]) > channelThreshold
      ) {
        changed += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { changed, bounds: { minX, minY, maxX, maxY } };
}

/** 窗口内 changed 像素的包围盒与数量（大图上避免全图多趟扫描）。 */
function windowDiffStats(a: Raw, b: Raw, cx: number, cy: number, rx: number, ry: number) {
  const x0 = Math.max(0, cx - rx);
  const x1 = Math.min(b.width - 1, cx + rx);
  const y0 = Math.max(0, cy - ry);
  const y1 = Math.min(b.height - 1, cy + ry);
  let count = 0;
  let minX = x1;
  let minY = y1;
  let maxX = -1;
  let maxY = -1;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0, idx = (y * b.width + x) * 4; x <= x1; x += 1, idx += 4) {
      if (
        a.data[idx] !== b.data[idx] ||
        a.data[idx + 1] !== b.data[idx + 1] ||
        a.data[idx + 2] !== b.data[idx + 2]
      ) {
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    count,
    box: count ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}

function lum(data: Buffer, idx: number): number {
  return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
}

// ---------------------------------------------------------------------------
// generateWaterMark：旧三条断言的性质（新返回类型：PNG 画布 + 实测 ink 盒）
// ---------------------------------------------------------------------------

describe('generateWaterMark', () => {
  jest.setTimeout(30000);

  it('renders watermark text without a dot', async () => {
    const logo = await generateWaterMark(TEXT_WITHOUT_DOT, { fontSize: 64 });
    expect(logo).not.toBeNull();
    // 旧断言 ink>1000 保留（现在含柔光底板；文字本身单独再验一条）
    expect(logo!.ink.pixels).toBeGreaterThan(1000);
    // 文字层（alpha>150 只有正文，底板 alpha≤107）：单行、高度 ≤1.8×字号、ink>1000
    const raw = await decodeRaw(logo!.buffer);
    const textInk = scanInk(raw, 150);
    expect(textInk.pixels).toBeGreaterThan(1000);
    expect(textInk.height).toBeLessThanOrEqual(1.8 * 64);
    expect(textInk.width).toBeGreaterThan(64); // 不是豆腐块/空白
  });

  it('renders watermark text that contains a dot (#322)', async () => {
    const short = await generateWaterMark(TEXT_WITH_DOT_SHORT, { fontSize: 64 });
    expect(short).not.toBeNull();
    expect(short!.ink.pixels).toBeGreaterThan(1000);

    const domain = await generateWaterMark(TEXT_WITH_DOT_DOMAIN, { fontSize: 64 });
    expect(domain).not.toBeNull();
    expect(domain!.ink.pixels).toBeGreaterThan(1000);
    // 旧断言"域名比 500px 最小画布宽"的等价物：更长的文本得到更宽的实际 ink 盒
    expect(domain!.ink.width).toBeGreaterThan(short!.ink.width);

    const rawDomain = await decodeRaw(domain!.buffer);
    const textInk = scanInk(rawDomain, 150);
    expect(textInk.height).toBeLessThanOrEqual(1.8 * 64); // 仍是单行
  });

  it('does not drop a domain-length word onto a clipped second line', async () => {
    // 旧 bug 形状：jimp print(maxWidth=500) 把超宽单词折到第二行，150px 画布把它裁没。
    // SVG <text> 结构上不折行：长域名在一行内完整渲染（画布按估计宽度自动放宽），
    // ink 盒不贴画布边 = 没有被裁。
    const longText = 'some.long.domain.example.com';
    const logo = await generateWaterMark(longText, { fontSize: 64 });
    expect(logo).not.toBeNull();
    const raw = await decodeRaw(logo!.buffer);
    const textInk = scanInk(raw, 150);
    expect(textInk.height).toBeLessThanOrEqual(1.8 * 64); // 单行：不是 2 行的高度
    // 完整渲染：ink 宽 ≈ 估计宽（±30%），且四周不贴边（贴边=被裁）
    expect(textInk.left).toBeGreaterThan(0);
    expect(textInk.left + textInk.width).toBeLessThan(logo!.canvasWidth);
    expect(textInk.width).toBeGreaterThan(longText.length * 64 * 0.4);
  });
});

// ---------------------------------------------------------------------------
// addWaterMarkToIMG：旧两条断言的性质（corner 样式承接"右下角"语义）
// ---------------------------------------------------------------------------

describe('addWaterMarkToIMG (corner style, legacy properties)', () => {
  jest.setTimeout(30000);

  it('composites text without a dot at the bottom-right', async () => {
    const srcBuf = await solidPng(800, 600, 32);
    const original = await decodeRaw(srcBuf);
    const markedBuf = await addWaterMarkToIMG(srcBuf, TEXT_WITHOUT_DOT, {
      style: { style: 'corner' },
    });
    const marked = await decodeRaw(markedBuf);
    expect(marked.width).toBe(800);
    expect(marked.height).toBe(600);

    const stats = diffStats(original, marked);
    expect(stats.changed).toBeGreaterThan(1000);
    expect(stats.bounds.maxX).toBeGreaterThan(800 * 0.5);
    expect(stats.bounds.maxY).toBeGreaterThan(600 * 0.5);
    expect(stats.bounds.minX).toBeGreaterThan(800 * 0.2);
    // margin 来自 min(w,h)：ink 右缘贴到 w−margin 附近（margin=round(600×0.04)=24）
    expect(Math.abs(stats.bounds.maxX - (800 - 24))).toBeLessThanOrEqual(6);
    expect(Math.abs(stats.bounds.maxY - (600 - 24))).toBeLessThanOrEqual(6);
  });

  it('composites text with a dot the same way (#322)', async () => {
    const srcBuf = await solidPng(800, 600, 32);
    const original = await decodeRaw(srcBuf);

    const withDot = await decodeRaw(
      await addWaterMarkToIMG(srcBuf, TEXT_WITH_DOT_DOMAIN, { style: { style: 'corner' } }),
    );
    const withoutDot = await decodeRaw(
      await addWaterMarkToIMG(srcBuf, TEXT_WITHOUT_DOT, { style: { style: 'corner' } }),
    );

    const dotted = diffStats(original, withDot);
    const control = diffStats(original, withoutDot);
    expect(dotted.changed).toBeGreaterThan(1000);
    expect(control.changed).toBeGreaterThan(1000);

    expect(dotted.bounds.maxX).toBeGreaterThan(800 * 0.5);
    expect(dotted.bounds.maxY).toBeGreaterThan(600 * 0.5);
    // 旧断言：两种文本底缘一致（同一基线/margin 定位）
    expect(Math.abs(dotted.bounds.maxY - control.bounds.maxY)).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
// tile（新默认）：周期性 = 无缝；覆盖全图 = 裁不掉
// ---------------------------------------------------------------------------

describe('addWaterMarkToIMG (tile style, default)', () => {
  jest.setTimeout(30000);

  const W = 1200;
  const H = 900;

  async function tiledOnGray(gray = 128) {
    const srcBuf = await solidPng(W, H, gray);
    const markedBuf = await addWaterMarkToIMG(srcBuf, 'v.blog'); // 默认样式 = tile
    return { srcBuf, markedBuf, original: await decodeRaw(srcBuf), marked: await decodeRaw(markedBuf) };
  }

  it('pattern is exactly periodic with period = step（无缝的数学证明）', async () => {
    const { original, marked } = await tiledOnGray();
    const { step } = tileMetrics(W, H, resolveWatermarkStyle(undefined, {}));
    expect(step).toBe(252); // round(900×0.28)
    let mismatchesX = 0;
    let mismatchesY = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W - step; x += 1) {
        const i = (y * W + x) * 4;
        const j = i + step * 4;
        if (
          marked.data[i] !== marked.data[j] ||
          marked.data[i + 1] !== marked.data[j + 1] ||
          marked.data[i + 2] !== marked.data[j + 2]
        ) {
          mismatchesX += 1;
        }
      }
    }
    for (let y = 0; y < H - step; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        const j = i + step * W * 4;
        if (
          marked.data[i] !== marked.data[j] ||
          marked.data[i + 1] !== marked.data[j + 1] ||
          marked.data[i + 2] !== marked.data[j + 2]
        ) {
          mismatchesY += 1;
        }
      }
    }
    // PNG 无损 + 整数平移合成 ⇒ 必须逐字节相等；任何砖缝伪影都会在这里现形
    expect(mismatchesX).toBe(0);
    expect(mismatchesY).toBe(0);
    // 阴性对照：原图自身没有任何 changed 像素，水印确实加了
    expect(diffStats(original, marked).changed).toBeGreaterThan(1000);
  });

  it('marks straddling a tile seam are complete（角上四份拷贝跨缝拼合）', async () => {
    const { original, marked } = await tiledOnGray();
    const { step } = tileMetrics(W, H, resolveWatermarkStyle(undefined, {}));
    // 0.32×step：装得下整个旋转标记（半宽 ≈0.26×step），又隔离相邻格点的标记
    const rx = Math.round(step * 0.32);
    // 砖中心标记（完整落在单块砖内）
    const center = windowDiffStats(original, marked, step / 2, step / 2, rx, rx);
    // 砖角标记 = 四块相邻砖各贡献 1/4，在 (step, step) 格点上拼合
    const seam = windowDiffStats(original, marked, step, step, rx, rx);
    expect(center.box).not.toBeNull();
    expect(seam.box).not.toBeNull();
    // 跨缝拼出来的标记必须与砖内标记**同形同量**：缺任何一份角拷贝都会显著变小/缺角
    expect(seam.box!.width).toBe(center.box!.width);
    expect(seam.box!.height).toBe(center.box!.height);
    expect(Math.abs(seam.count - center.count)).toBeLessThanOrEqual(center.count * 0.02);
    // 阴性对照：rx 窗口确实只罩住一个标记（窗口内 ink 远小于窗口面积）
    expect(center.count).toBeLessThan(rx * rx); // 旋转文字带 ≪ 90×90 满窗
  });

  it('covers every region of the image（裁不掉：3×3 每格都有 ink）', async () => {
    const { original, marked } = await tiledOnGray(200);
    const cw = Math.floor(W / 3);
    const chh = Math.floor(H / 3);
    for (let gy = 0; gy < 3; gy += 1) {
      for (let gx = 0; gx < 3; gx += 1) {
        let changed = 0;
        for (let y = gy * chh; y < (gy + 1) * chh; y += 2) {
          for (let x = gx * cw; x < (gx + 1) * cw; x += 2) {
            const i = (y * W + x) * 4;
            if (
              original.data[i] !== marked.data[i] ||
              original.data[i + 1] !== marked.data[i + 1] ||
              original.data[i + 2] !== marked.data[i + 2]
            ) {
              changed += 1;
            }
          }
        }
        expect(changed).toBeGreaterThan(100);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 比例布局：400 / 1920 / 6000 三种尺寸（缺陷 2 的修复证明）
// ---------------------------------------------------------------------------

describe('proportional sizing at 400px / 1920px / 6000px', () => {
  jest.setTimeout(60000); // 6000×4000 的 PNG 编解码是大头，其余用例都 <1s

  const TEXT = 'v.blog';

  async function measureAt(w: number, h: number) {
    const srcBuf = await solidPng(w, h, 128);
    const t0 = Date.now();
    const markedBuf = await addWaterMarkToIMG(srcBuf, TEXT); // tile 默认
    const ms = Date.now() - t0;
    const original = await decodeRaw(srcBuf);
    const marked = await decodeRaw(markedBuf);
    const style = resolveWatermarkStyle(undefined, {});
    const { fontSize, step } = tileMetrics(w, h, style);
    // 在砖中心窗口里实测单个标记的 ink 盒（0.32×step：罩住整个标记、隔离相邻格点）
    const rx = Math.round(step * 0.32);
    const win = windowDiffStats(original, marked, Math.round(step / 2), Math.round(step / 2), rx, rx);
    return { w, h, ms, fontSize, step, win, marked, original };
  }

  it('mark size and tile count stay proportional（数字进交付报告）', async () => {
    const results = [];
    for (const [w, h] of [
      [400, 300],
      [1920, 1280],
      [6000, 4000],
    ]) {
      results.push(await measureAt(w, h));
    }
    for (const r of results) {
      // 单个标记实测到了；旋转 −26° 的文字带 bbox 高度 ∈ [0.4, 4]×fontSize
      // （结构上排除"两行/巨型 blob"；单行性质的精确断言在 generateWaterMark 那组）
      expect(r.win.box).not.toBeNull();
      expect(r.win.box!.height).toBeGreaterThan(r.fontSize * 0.4);
      expect(r.win.box!.height).toBeLessThan(r.fontSize * 4);
      // 标记（em 高）占图高比例在 [0.3%, 5%]：小图不糊脸、大图不消失
      const glyphPct = (r.fontSize * 0.73) / r.h;
      expect(glyphPct).toBeGreaterThan(0.003);
      expect(glyphPct).toBeLessThan(0.05);
      // 砖数（≈标记密度）：2~150 块之间 —— 400px 缩略图 2~3 个标记、6000px 大图几十个，
      // 不会出现"上千个微缩标记"或"整图一个大水印"
      const tiles = Math.ceil(r.w / r.step) * Math.ceil(r.h / r.step);
      expect(tiles).toBeGreaterThanOrEqual(2);
      expect(tiles).toBeLessThanOrEqual(150);
      // eslint-disable-next-line no-console
      console.log(
        `[watermark] ${r.w}x${r.h}: fontSize=${r.fontSize} (${((r.fontSize * 0.73) / r.h * 100).toFixed(2)}% of height), step=${r.step}, tiles=${tiles}, markBox=${r.win.box!.width}x${r.win.box!.height}, watermark took ${r.ms}ms`,
      );
    }
    // 旧实现对照（负控制，公式级）：同一张 400px 图，旧 logo 占宽 90%（见 watermarkSvg.spec）
    const small = results[0];
    expect(small.win.box!.width / small.w).toBeLessThan(0.45);
  });
});

// ---------------------------------------------------------------------------
// 四个角（corner 样式）
// ---------------------------------------------------------------------------

describe('corner positions', () => {
  jest.setTimeout(30000);

  async function cornerAt(position: string) {
    const srcBuf = await solidPng(800, 600, 128);
    const markedBuf = await addWaterMarkToIMG(srcBuf, TEXT_WITH_DOT_DOMAIN, {
      style: { style: 'corner', position: position as any },
    });
    const original = await decodeRaw(srcBuf);
    const marked = await decodeRaw(markedBuf);
    return diffStats(original, marked).bounds;
  }

  it('bottom-right / bottom-left / top-right / top-left 各归其角', async () => {
    const br = await cornerAt('bottom-right');
    expect(br.minX).toBeGreaterThan(400);
    expect(br.minY).toBeGreaterThan(300);

    const bl = await cornerAt('bottom-left');
    expect(bl.maxX).toBeLessThan(400);
    expect(bl.minY).toBeGreaterThan(300);

    const tr = await cornerAt('top-right');
    expect(tr.minX).toBeGreaterThan(400);
    expect(tr.maxY).toBeLessThan(300);

    const tl = await cornerAt('top-left');
    expect(tl.maxX).toBeLessThan(400);
    expect(tl.maxY).toBeLessThan(300);
  });

  it('position 也可以从 env 来（VANBLOG_WATERMARK_POSITION）', async () => {
    const srcBuf = await solidPng(800, 600, 128);
    const markedBuf = await addWaterMarkToIMG(srcBuf, TEXT_WITH_DOT_DOMAIN, {
      env: { VANBLOG_WATERMARK_STYLE: 'corner', VANBLOG_WATERMARK_POSITION: 'top-left' },
    });
    const original = await decodeRaw(srcBuf);
    const marked = await decodeRaw(markedBuf);
    const b = diffStats(original, marked).bounds;
    expect(b.maxX).toBeLessThan(400);
    expect(b.maxY).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// bar 样式
// ---------------------------------------------------------------------------

describe('bar style', () => {
  jest.setTimeout(30000);

  it('底部渐变条：下半压暗、上半一个像素不动、条内有高亮文字', async () => {
    const srcBuf = await solidPng(900, 600, 255); // 白底：最容易暴露"白条上白字"
    const markedBuf = await addWaterMarkToIMG(srcBuf, 'v.blog', { style: { style: 'bar' } });
    const original = await decodeRaw(srcBuf);
    const marked = await decodeRaw(markedBuf);

    // 上半（y < 600−72−10）零变化：条只碰底部
    const stats = diffStats(original, marked);
    expect(stats.bounds.minY).toBeGreaterThanOrEqual(600 - Math.round(600 * 0.12) - 1);
    // 最底行被渐变压暗（alpha 0.35 黑 on 白 ≈ 166）
    let bottomSum = 0;
    for (let x = 100; x < 800; x += 1) {
      bottomSum += lum(marked.data, ((599 * 900) + x) * 4);
    }
    expect(bottomSum / 700).toBeLessThan(200);
    expect(bottomSum / 700).toBeGreaterThan(120);
    // 条内有接近纯白的文字像素（白底图上"看得见的字"只能是水印自己带来的）
    let brightInBar = 0;
    for (let y = 600 - 72; y < 600; y += 1) {
      for (let x = 0; x < 900; x += 1) {
        if (lum(marked.data, (y * 900 + x) * 4) > 235) {
          brightInBar += 1;
        }
      }
    }
    // 上缘附近本来就接近 255（渐变还浅）—— 只数条的下半，避免把渐变浅区算进来
    let brightInLowerBar = 0;
    for (let y = 600 - 40; y < 600; y += 1) {
      for (let x = 0; x < 900; x += 1) {
        if (lum(marked.data, (y * 900 + x) * 4) > 235) {
          brightInLowerBar += 1;
        }
      }
    }
    expect(brightInBar).toBeGreaterThan(brightInLowerBar - 1); // sanity
    expect(brightInLowerBar).toBeGreaterThan(50);
  });

  it('position top-left：条在顶部、文字左对齐', async () => {
    const srcBuf = await solidPng(900, 600, 255);
    const markedBuf = await addWaterMarkToIMG(srcBuf, 'v.blog', {
      style: { style: 'bar', position: 'top-left' },
    });
    const original = await decodeRaw(srcBuf);
    const marked = await decodeRaw(markedBuf);
    const stats = diffStats(original, marked);
    expect(stats.bounds.maxY).toBeLessThanOrEqual(Math.round(600 * 0.12) + 1);
    // 顶行压暗
    let topSum = 0;
    for (let x = 100; x < 800; x += 1) {
      topSum += lum(marked.data, x * 4);
    }
    expect(topSum / 700).toBeLessThan(200);
    // 文字靠左：亮像素的重心在左半
    let sumX = 0;
    let n = 0;
    for (let y = 0; y < 40; y += 1) {
      for (let x = 0; x < 900; x += 1) {
        if (lum(marked.data, (y * 900 + x) * 4) > 235) {
          sumX += x;
          n += 1;
        }
      }
    }
    expect(n).toBeGreaterThan(50);
    expect(sumX / n).toBeLessThan(450);
  });
});

// ---------------------------------------------------------------------------
// 深浅背景可读性（双色调证明：白/中灰/黑三种底都要"看得见"）
// ---------------------------------------------------------------------------

describe('legibility on light and dark backgrounds (dual-tone)', () => {
  jest.setTimeout(30000);

  async function visibleOn(gray: number, styleName: 'tile' | 'corner') {
    const srcBuf = await solidPng(1200, 900, gray);
    const markedBuf = await addWaterMarkToIMG(srcBuf, 'example.com', {
      style: styleName === 'tile' ? undefined : { style: 'corner' },
    });
    const marked = await decodeRaw(markedBuf);
    let visible = 0; // |Δ亮度| ≥ 3 才算"人眼可辨"
    let sumDelta = 0;
    let maxDelta = 0;
    for (let i = 0; i < marked.data.length; i += 4) {
      const delta = Math.abs(lum(marked.data, i) - gray);
      if (delta >= 3) {
        visible += 1;
        sumDelta += delta;
        if (delta > maxDelta) maxDelta = delta;
      }
    }
    return { visible, meanDelta: visible ? sumDelta / visible : 0, maxDelta };
  }

  it('tile：白底/中灰底/黑底都有 ≥2000 个可辨像素（数字进交付报告）', async () => {
    for (const gray of [255, 128, 0]) {
      const r = await visibleOn(gray, 'tile');
      // eslint-disable-next-line no-console
      console.log(
        `[watermark] tile on gray=${gray}: visiblePx=${r.visible}, meanDelta=${r.meanDelta.toFixed(1)}, maxDelta=${r.maxDelta.toFixed(1)}`,
      );
      expect(r.visible).toBeGreaterThan(2000);
      expect(r.maxDelta).toBeGreaterThan(5);
    }
  });

  it('corner：白底/中灰底/黑底都有 ≥500 个可辨像素', async () => {
    for (const gray of [255, 128, 0]) {
      const r = await visibleOn(gray, 'corner');
      // eslint-disable-next-line no-console
      console.log(
        `[watermark] corner on gray=${gray}: visiblePx=${r.visible}, meanDelta=${r.meanDelta.toFixed(1)}, maxDelta=${r.maxDelta.toFixed(1)}`,
      );
      expect(r.visible).toBeGreaterThan(500);
      expect(r.maxDelta).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// 格式保持 / EXIF / 不放大
// ---------------------------------------------------------------------------

describe('format preservation and EXIF orientation', () => {
  jest.setTimeout(30000);

  async function fixture(format: 'jpeg' | 'png' | 'webp'): Promise<Buffer> {
    const base = sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 120, b: 160 } },
    });
    if (format === 'jpeg') return base.jpeg({ quality: 90 }).toBuffer();
    if (format === 'webp') return base.webp({ quality: 90 }).toBuffer();
    return base.png().toBuffer();
  }

  it.each([
    ['jpeg', 'jpeg'],
    ['png', 'png'],
    ['webp', 'webp'],
  ])('%s in → %s out，尺寸不变（不放大不缩小）', async (input, expected) => {
    const src = await fixture(input as any);
    const out = await addWaterMarkToIMG(src, 'v.blog');
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe(expected);
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
  });

  it('EXIF orientation=6 的手机照片：像素被摆正、标签被去掉、水印落在**视觉**右下角', async () => {
    // 300×200 存储像素 + orientation 6（显示为 200×300 竖图）。
    // 旧 jimp 路径在未摆正的像素上合成并把 EXIF 原样带回 ⇒ 显示时水印在错误角落、文字横躺。
    const grad = Buffer.alloc(300 * 200 * 3);
    for (let y = 0; y < 200; y += 1) {
      for (let x = 0; x < 300; x += 1) {
        const i = (y * 300 + x) * 3;
        grad[i] = Math.round((x / 300) * 255);
        grad[i + 1] = Math.round((y / 200) * 255);
        grad[i + 2] = 128;
      }
    }
    const fixtureBuf: Buffer = await sharp(grad, { raw: { width: 300, height: 200, channels: 3 } })
      .jpeg({ quality: 92 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const fixtureMeta = await sharp(fixtureBuf).metadata();
    expect(fixtureMeta.orientation).toBe(6);

    const out = await addWaterMarkToIMG(fixtureBuf, 'v.blog', { style: { style: 'corner' } });
    const meta = await sharp(out).metadata();
    // 摆正后写死：宽高转置、orientation 标签不再存在（与 thumbnail/imgResize 的 .rotate() 口径一致）
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(300);
    expect(!meta.orientation || meta.orientation === 1).toBe(true);

    // 水印在**摆正后**坐标系的右下角（阈值 16 滤掉 jpeg 重编码噪声）
    const ref = await decodeRaw(await sharp(fixtureBuf).rotate().png().toBuffer());
    const marked = await decodeRaw(out);
    expect(marked.width).toBe(200);
    expect(marked.height).toBe(300);
    const stats = diffStats(ref, marked, 16);
    expect(stats.changed).toBeGreaterThan(200);
    expect(stats.bounds.maxY).toBeGreaterThan(300 * 0.7);
    expect(stats.bounds.maxX).toBeGreaterThan(200 * 0.55);
  });

  it('小图（100×80，比一块标准砖还小）：砖自动缩小，仍然加上水印、尺寸不变', async () => {
    const src = await solidPng(100, 80, 100);
    const out = await addWaterMarkToIMG(src, 'v.blog');
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);
    // 单砖居中：确有 ink（白字 0.12 on gray100 → Δ≥10）
    const original = await decodeRaw(src);
    const marked = await decodeRaw(out);
    expect(diffStats(original, marked).changed).toBeGreaterThan(50);
  });

  it('极小图（40×40，连 48px 砖下限都放不下）：原 buffer 原样返回（同一引用）+ WARN', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const src = await solidPng(40, 40, 100);
      const out = await addWaterMarkToIMG(src, 'v.blog');
      expect(out).toBe(src);
      expect(String(warnSpy.mock.calls[0][0])).toContain('[watermark]');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // -----------------------------------------------------------------------
  // 小图阈值的**边界**：代码、WARN 文案与三份文档必须说同一个数。
  //
  // 这条钉子是有来历的：判定原来写死 `Math.max(48, minSide - 4)`，于是真正跳过的只有
  // 短边 < 48 的图，而 WARN 文案与文档（features/image-storage.md、faq/usage.md、
  // reference/env.md）都写 52px ⇒ 48…51px 这段是"日志说跳过了、其实照盖"，
  // 而且没有任何 spec 钉这个边界（搜 47/48/51/52 全 0 命中），所以它一直没人发现。
  // 现在阈值是导出的常量，判定与文案同源，边界两侧各钉一条。
  // -----------------------------------------------------------------------
  it(`阈值常量就是文档写的那个值（${WATERMARK_MIN_SHORT_SIDE_PX}px），改它必须同时改文档`, () => {
    expect(WATERMARK_MIN_SHORT_SIDE_PX).toBe(52);
  });

  it('边界：短边 51px ⇒ 跳过（返回 null，不打水印）', () => {
    expect(smallImageTileStep(WATERMARK_MIN_SHORT_SIDE_PX - 1)).toBeNull();
  });

  it('边界：短边 52px ⇒ 照盖（砖缩到 52，正好放得下）', () => {
    expect(smallImageTileStep(WATERMARK_MIN_SHORT_SIDE_PX)).toBe(WATERMARK_MIN_SHORT_SIDE_PX);
  });

  it('边界：53…60px 也照盖，且砖不会小于阈值（避免糊成墨点）', () => {
    for (const s of [53, 56, 60]) {
      const step = smallImageTileStep(s);
      expect(step).not.toBeNull();
      expect(step as number).toBeGreaterThanOrEqual(WATERMARK_MIN_SHORT_SIDE_PX);
      expect(step as number).toBeLessThanOrEqual(s);
    }
  });

  it('以前会漏掉的 48…51px 整段：现在一律跳过（这就是修掉的那个洞）', () => {
    for (const s of [48, 49, 50, 51]) {
      expect(smallImageTileStep(s)).toBeNull();
    }
  });

  it('退化输入不炸：0 / 负数 / NaN / ±Infinity / 非数字一律跳过', () => {
    for (const bad of [0, -1, -52, NaN, Infinity, -Infinity, '52' as any, null as any, undefined as any]) {
      expect(smallImageTileStep(bad as number)).toBeNull();
    }
  });

  it('空转反证：同一个判据跑在**旧写法**上必须给出不同答案（否则上面几条都是空的）', () => {
    // 旧实现：step = Math.max(48, minSide - 4)，skip 当且仅当 step > minSide
    const legacySkips = (minSide: number) => Math.max(48, minSide - 4) > minSide;
    // 48…51px：旧写法不跳过（照盖），新写法跳过 ⇒ 两者结论相反，证明这组断言真的在测东西
    for (const s of [48, 49, 50, 51]) {
      expect(legacySkips(s)).toBe(false);
      expect(smallImageTileStep(s)).toBeNull();
    }
    // 47px 两边都跳过（这一档行为没变）
    expect(legacySkips(47)).toBe(true);
    expect(smallImageTileStep(47)).toBeNull();
  });

  it('端到端：51×51 的原图原样返回（同一引用）且 WARN 里的数字与常量一致', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const src = await solidPng(51, 51, 100);
      const out = await addWaterMarkToIMG(src, 'a.b');
      expect(out).toBe(src);
      const msg = String(warnSpy.mock.calls[0][0]);
      expect(msg).toContain('短边 51px');
      expect(msg).toContain(`< ${WATERMARK_MIN_SHORT_SIDE_PX}px`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('端到端：52×52 不再被当成"过小"（不会打出那条 WARN）', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const src = await solidPng(52, 52, 100);
      await addWaterMarkToIMG(src, 'a.b');
      const tooSmall = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('图片过小'));
      expect(tooSmall).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('极小图（24×24）corner 放不下 ⇒ 原 buffer 原样返回（同一引用）', async () => {
    const src = await solidPng(24, 24, 100);
    const out = await addWaterMarkToIMG(src, 'example.com', { style: { style: 'corner' } });
    expect(out).toBe(src);
  });
});

// ---------------------------------------------------------------------------
// 失败路径：永远不让上传失败
// ---------------------------------------------------------------------------

describe('failure paths return the original buffer and WARN', () => {
  jest.setTimeout(30000);
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetWatermarkCachesForTest();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('损坏输入：原 buffer 原样返回（同一引用）+ WARN 带来源标签', async () => {
    const garbage = Buffer.from('this is definitely not an image');
    const out = await addWaterMarkToIMG(garbage, 'v.blog');
    expect(out).toBe(garbage);
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0][0])).toContain('[watermark]');
  });

  it('无 sharp 编码器的格式（svg）：WARN + 原样返回', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#336699"/></svg>',
    );
    const out = await addWaterMarkToIMG(svg, 'v.blog');
    expect(out).toBe(svg);
    expect(String(warnSpy.mock.calls[0][0])).toContain('[watermark]');
  });

  it('空文本 / 非字符串文本：静默原样返回（调用方已挡，双保险）', async () => {
    const src = await solidPng(120, 80, 100);
    expect(await addWaterMarkToIMG(src, '   ')).toBe(src);
    expect(await addWaterMarkToIMG(src, undefined as any)).toBe(src);
  });

  it('文字过长（tile 砖装不下且缩到下限仍超）：WARN + 原样返回', async () => {
    const src = await solidPng(400, 300, 100);
    const out = await addWaterMarkToIMG(src, 'x'.repeat(256));
    expect(out).toBe(src);
    expect(String(warnSpy.mock.calls[0][0])).toContain('[watermark]');
  });
});

// ---------------------------------------------------------------------------
// CJK：有字体就渲染，没字体就点名 WARN（本 spec 两条都测）
// ---------------------------------------------------------------------------

describe('CJK watermark text', () => {
  jest.setTimeout(30000);
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetWatermarkCachesForTest();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    __resetWatermarkCachesForTest();
    warnSpy.mockRestore();
  });

  it('本机有 CJK 字体时：中文水印真的渲染出来了（对比旧实现的 5 个豆腐块）', async () => {
    const sharpMod: any = require('sharp');
    const coverage = await probeFontCoverage(sharpMod);
    if (!coverage.cjkOk) {
      // 本机没有 CJK 字体：行为必须是"跳过 + WARN"（宁可不盖也不盖豆腐块）
      // eslint-disable-next-line no-console
      console.warn(
        '[watermark][SKIP] 本机没有 CJK 字体（fc-list :lang=zh 为空？），走"跳过+WARN"分支；本机实测有 Noto Sans CJK SC 时走渲染分支',
      );
      const srcBuf0 = await solidPng(400, 300, 128);
      const out0 = await addWaterMarkToIMG(srcBuf0, '酱油的博客');
      expect(out0).toBe(srcBuf0);
      expect(String(warnSpy.mock.calls[0][0])).toContain('wqy-zenhei');
      return;
    }
    const srcBuf = await solidPng(800, 600, 128);
    const markedBuf = await addWaterMarkToIMG(srcBuf, '酱油的博客');
    expect(markedBuf).not.toBe(srcBuf);
    const original = await decodeRaw(srcBuf);
    const marked = await decodeRaw(markedBuf);
    const stats = diffStats(original, marked);
    // 旧实现：'酱油的博客' measureText=0、5 个字全是同一个 59×93 空心豆腐块；
    // 新实现：pango 逐字符回退到 Noto Sans CJK SC，渲染真字形
    expect(stats.changed).toBeGreaterThan(1000);
    // 真汉字笔画密度远高于豆腐块：单个标记 ink（砖中心窗口）
    const { step, fontSize } = tileMetrics(800, 600, resolveWatermarkStyle(undefined, {}));
    const rx = Math.round(step * 0.4);
    const win = windowDiffStats(original, marked, Math.round(step / 2), Math.round(step / 2), rx, rx);
    expect(win.count).toBeGreaterThan(fontSize * fontSize * 0.2);
    expect(warnSpy).not.toHaveBeenCalled(); // 有字体 ⇒ 不该有任何 WARN
  });

  it('探测不到 CJK 字体时：跳过水印 + WARN 点名缺失字体与安装命令（宁可不盖，不盖豆腐块）', async () => {
    __resetWatermarkCachesForTest({ latinOk: true, cjkOk: false });
    const srcBuf = await solidPng(400, 300, 128);
    const out = await addWaterMarkToIMG(srcBuf, '酱油的博客');
    expect(out).toBe(srcBuf); // 原 buffer 同一引用：绝不产出豆腐块图
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('wqy-zenhei'); // 点名要装的字体
    expect(warned).toContain('fontconfig');
    expect(warned).toContain('水'); // 说明探测字
  });

  it('零字体容器（Latin 也渲染不出）：任何水印文字都跳过 + WARN 给出安装命令', async () => {
    // 容器实测形状：零字体时 librsvg 输出满屏 .notdef 豆腐块（Latin 576 ink px、CJK 180 ink px），
    // 只数 ink 会误判成功 —— 探测（vs U+E001 逐字节）才是防线
    __resetWatermarkCachesForTest({ latinOk: false, cjkOk: false });
    const srcBuf = await solidPng(400, 300, 128);
    const out = await addWaterMarkToIMG(srcBuf, 'example.com');
    expect(out).toBe(srcBuf);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('[watermark]');
    expect(warned).toContain('ttf-dejavu');
    expect(warned).toContain('fontconfig');
  });
});

// ---------------------------------------------------------------------------
// 旧实现回归锚点：新代码在旧 bug 场景下必须给出**不同**（正确）的结果
// ---------------------------------------------------------------------------

describe('regression anchors for the old jimp defects', () => {
  jest.setTimeout(30000);

  it('缺陷 3 场景（4000×100 横幅）：水印仍在画布内（旧实现 Y=−250 ⇒ changedPx=0）', async () => {
    const srcBuf = await solidPng(4000, 100, 32);
    const markedBuf = await addWaterMarkToIMG(srcBuf, TEXT_WITH_DOT_DOMAIN, {
      style: { style: 'corner' },
    });
    const original = await decodeRaw(srcBuf);
    const marked = await decodeRaw(markedBuf);
    const stats = diffStats(original, marked);
    // 旧实现这里是 0（水印整个落在画布外）；新实现 margin=round(100×0.04)=4，完整可见
    expect(stats.changed).toBeGreaterThan(100);
    expect(stats.bounds.maxY).toBeLessThanOrEqual(99);
    expect(stats.bounds.minY).toBeGreaterThanOrEqual(0);
    // 右缘贴到 w−margin 附近
    expect(Math.abs(stats.bounds.maxX - (4000 - 4))).toBeLessThanOrEqual(6);
  }, 30000);

  it('缺陷 2 场景（400×400 小图）：单个标记宽度 ≪ 旧实现的 90% 图宽', async () => {
    const srcBuf = await solidPng(400, 400, 32);
    const markedBuf = await addWaterMarkToIMG(srcBuf, TEXT_WITH_DOT_DOMAIN); // tile
    const original = await decodeRaw(srcBuf);
    const marked = await decodeRaw(markedBuf);
    const { step } = tileMetrics(400, 400, resolveWatermarkStyle(undefined, {}));
    const rx = Math.round(step * 0.32);
    const win = windowDiffStats(original, marked, Math.round(step / 2), Math.round(step / 2), rx, rx);
    expect(win.box).not.toBeNull();
    // 旧实现：360/400 = 90%；新实现：单标记 ≤ 45%（含旋转包络）
    expect(win.box!.width / 400).toBeLessThan(0.45);
  });

  it('cornerMetrics 的 margin 永远来自 min(w,h)（不再出现 width 派生的荒谬边距）', () => {
    // 4000×100：margin=4（旧实现 yMargin=200 > 图高）
    expect(cornerMetrics(4000, 100, resolveWatermarkStyle(undefined, {})).margin).toBe(4);
    // 100×4000：margin=4（旧实现 yMargin=5，贴边）
    expect(cornerMetrics(100, 4000, resolveWatermarkStyle(undefined, {})).margin).toBe(4);
    // 正常图：margin 与短边成比例
    expect(cornerMetrics(1920, 1080, resolveWatermarkStyle(undefined, {})).margin).toBe(43);
  });

  it('© 前缀：默认样式下站点名自动带 ©（tile 画布里能找到两份 text 节点 = 双色调）', async () => {
    // 走 buildTileSvg 的纯函数验证（SVG 字符串层面）
    const { svg } = buildTileSvg(withCopyrightPrefix('v.blog'), 20, 200, resolveWatermarkStyle(undefined, {}));
    expect(svg).toContain('© v.blog');
    expect(svg.match(/<text /g)).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// 字体覆盖探测：**真跑一遍**
//
// ⚠️ 上面 CJK 那组用例是**注入**探测结果的（`__resetWatermarkCachesForTest({latinOk:false,…})`），
// 它们证明的是"探测说没字体时，行为是跳过 + WARN"，**证明不了探测本身对不对**。
// 这个差别不是理论上的：探测的第一版拿 `Ag`（2 个字符）去和单个 U+E001 比，
// 零字体时"两个方块 vs 一个方块"逐字节当然不同 ⇒ `latinOk` 恒为 true ⇒
// 镜像里照样把满图 .notdef 合成进图片（容器内实测 changedPx 32,699）。注入结果的单测全绿。
// 所以下面这条**在真环境里真跑探测**：用 FONTCONFIG_FILE 指向一个不含任何字体目录的配置，
// 造出"零字体容器"，并且必须开子进程 —— fontconfig 在进程内只初始化一次，
// jest 的 worker 可能已经渲染过别的用例，那时改环境变量根本不生效。
// ---------------------------------------------------------------------------

describe('字体覆盖探测（真环境，不注入结果）', () => {
  it('notdefComparatorFor：比较基准必须与探测文本**码点数相同**', () => {
    expect(notdefComparatorFor('Ag')).toBe('\uE001\uE001');
    expect(notdefComparatorFor('水')).toBe('\uE001');
    expect([...notdefComparatorFor('example.com')].length).toBe([...'example.com'].length);
    // 代理对是一个码点、两个 UTF-16 单元：用 .length 会造出双倍基准，
    // 逐字节比较就永远不相等 ⇒ 探测永远说"有字体"（与上面那个 bug 同一个形状）
    expect('😀'.length).toBe(2);
    expect([...notdefComparatorFor('😀')].length).toBe(1);
    expect(notdefComparatorFor('')).toBe('');
  });

  it(
    '零字体环境：真探测判 Latin 与 CJK 都不可用；而旧判据（单字基准）会说"有字体"',
    () => {
      const serverRoot = join(__dirname, '..', '..');
      const watermarkPath = JSON.stringify(join(__dirname, 'watermark.ts'));
      const svgPath = JSON.stringify(join(__dirname, 'watermarkSvg.ts'));
      const script = [
        "const sharp = require('sharp');",
        `const { probeFontCoverage } = require(${watermarkPath});`,
        `const { DEFAULT_WATERMARK_FONT_FAMILY } = require(${svgPath});`,
        'const raster = (text) => {',
        '  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="72">' +
          '<text x="12" y="58" font-family="${DEFAULT_WATERMARK_FONT_FAMILY}" font-size="48" ' +
          'fill="#ffffff">${text}</text></svg>`;',
        '  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })',
        '    .then((r) => r.data);',
        '};',
        '(async () => {',
        '  const [latin, notdef1, notdef2, coverage] = await Promise.all([',
        "    raster('Ag'), raster('\\uE001'), raster('\\uE001\\uE001'), probeFontCoverage(sharp),",
        '  ]);',
        "  process.stdout.write('PROBE ' + JSON.stringify({",
        '    coverage,',
        '    oldShapeSaysLatinOk: !latin.equals(notdef1),',
        '    newShapeSaysLatinOk: !latin.equals(notdef2),',
        '  }) + String.fromCharCode(10));',
        '})().catch((e) => process.stdout.write("PROBE-ERR " + (e && e.message) + String.fromCharCode(10)));',
      ].join('\n');

      const runProbe = (extraEnv: NodeJS.ProcessEnv) => {
        const res = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
          cwd: serverRoot,
          env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', ...extraEnv },
          encoding: 'utf8',
          timeout: 180000,
        });
        const line = `${res.stdout || ''}\n${res.stderr || ''}`
          .split('\n')
          .find((l) => l.startsWith('PROBE '));
        if (!line) {
          return null;
        }
        try {
          return JSON.parse(line.slice('PROBE '.length));
        } catch {
          return null;
        }
      };

      const dir = mkdtempSync(join(tmpdir(), 'vanblog-fontprobe-'));
      const cfg = join(dir, 'empty-fonts.conf');
      try {
        writeFileSync(
          cfg,
          [
            '<?xml version="1.0"?>',
            '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
            '<fontconfig>',
            '  <!-- 负向对照：不含任何字体目录 ⇒ 这个进程里等价于"零字体容器" -->',
            '  <dir>/nonexistent-font-dir-for-negative-control</dir>',
            '</fontconfig>',
            '',
          ].join('\n'),
        );
        const control = runProbe({});
        const noFonts = runProbe({ FONTCONFIG_FILE: cfg });
        if (!control || !noFonts) {
          // 跑不起来（没有 ts-node、spawn 失败…）就说清楚并跳过，绝不假装验过
          // eslint-disable-next-line no-console
          console.warn(
            '[watermark][SKIP] 子进程真探测跑不起来（ts-node 不可用？）—— 这条用例的价值就在于真跑，' +
              '所以不做退化的假断言；镜像内的等价验证见交付记录',
          );
          return;
        }
        if (!control.coverage.latinOk) {
          // eslint-disable-next-line no-console
          console.warn('[watermark][SKIP] 本机对照组都没有 Latin 字体，形不成对照（零字体那半边无从证明）');
          return;
        }
        // 对照组（本机有字体）：真字形 ≠ 方块，两种判据都说"有字体"
        expect(control.newShapeSaysLatinOk).toBe(true);
        expect(control.oldShapeSaysLatinOk).toBe(true);
        // 零字体：等码点数判据必须说"没有"，于是上层跳过水印 + WARN + 返回原图
        expect(noFonts.coverage).toEqual({ latinOk: false, cjkOk: false });
        expect(noFonts.newShapeSaysLatinOk).toBe(false);
        // ⚠️ 反证：旧判据（单字 U+E001 比 'Ag'）在**同一个零字体环境**里会说"有字体" ——
        //    这就是那个 bug 本身，钉在这里，谁把基准改回单字就会红
        expect(noFonts.oldShapeSaysLatinOk).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    240000,
  );
});
