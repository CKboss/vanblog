import {
  BAR_FONT_MAX_PX,
  BAR_FONT_MIN_PX,
  CORNER_FONT_MAX_PX,
  CORNER_FONT_MIN_PX,
  DEFAULT_WATERMARK_FONT_FAMILY,
  DEFAULT_WATERMARK_STYLE,
  TILE_FONT_MAX_PX,
  TILE_FONT_MIN_PX,
  TILE_ROTATION_DEG,
  TILE_STEP_MAX_PX,
  TILE_STEP_MIN_PX,
  WATERMARK_ENV,
  WATERMARK_STYLE_OPACITY,
  barMetrics,
  buildBarSvg,
  buildCornerSvg,
  buildTileSvg,
  charAdvanceEm,
  clampInt,
  containsCjk,
  cornerMetrics,
  envFloatInRange,
  escapeXml,
  estimateTextWidthPx,
  legacyBottomRightY,
  legacyLogoWidth,
  normalizeWatermarkText,
  parseWatermarkPosition,
  parseWatermarkStyleName,
  resolveWatermarkStyle,
  rotatedMarkExtent,
  sanitizeWatermarkColor,
  sanitizeWatermarkFontFamily,
  tileMetrics,
  watermarkCornerPoint,
  withCopyrightPrefix,
  WatermarkStyle,
} from './watermarkSvg';

const S = (over: Partial<WatermarkStyle> = {}): WatermarkStyle => ({
  ...DEFAULT_WATERMARK_STYLE,
  ...over,
});

describe('resolveWatermarkStyle：默认值', () => {
  it('默认是 tile 平铺、白字、低不透明度、半透明度阴影（= 文字的一半）', () => {
    const s = resolveWatermarkStyle(undefined, {});
    expect(s.style).toBe('tile');
    expect(s.position).toBe('bottom-right');
    expect(s.scale).toBe(1);
    expect(s.color).toBe('#ffffff');
    expect(s.opacity).toBe(WATERMARK_STYLE_OPACITY.tile);
    expect(s.shadowColor).toBe('#000000');
    expect(s.shadowOpacity).toBeCloseTo(WATERMARK_STYLE_OPACITY.tile / 2, 10);
    expect(s.marginRatio).toBe(0.04);
    expect(s.fontFamily).toBe(DEFAULT_WATERMARK_FONT_FAMILY);
  });

  it('font-family 链：Latin 打头（DejaVu Sans），CJK 断后，sans-serif 兜底', () => {
    const chain = DEFAULT_WATERMARK_FONT_FAMILY.split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(chain[0]).toBe('DejaVu Sans');
    expect(chain).toContain('Noto Sans CJK SC');
    expect(chain).toContain('WenQuanYi Zen Hei');
    expect(chain[chain.length - 1]).toBe('sans-serif');
  });

  it('每个样式有自己的默认文字不透明度；阴影默认跟随生效的 opacity', () => {
    for (const name of ['tile', 'corner', 'bar'] as const) {
      const s = resolveWatermarkStyle({ style: name }, {});
      expect(s.opacity).toBe(WATERMARK_STYLE_OPACITY[name]);
      expect(s.shadowOpacity).toBeCloseTo(WATERMARK_STYLE_OPACITY[name] / 2, 10);
    }
    // env 改了 opacity 而没改阴影 ⇒ 阴影跟随新值的一半
    const s = resolveWatermarkStyle(undefined, {
      [WATERMARK_ENV.style]: 'corner',
      [WATERMARK_ENV.opacity]: '0.4',
    });
    expect(s.opacity).toBe(0.4);
    expect(s.shadowOpacity).toBeCloseTo(0.2, 10);
  });
});

describe('resolveWatermarkStyle：env 与覆盖项（非法一律回默认）', () => {
  it('合法 env 生效', () => {
    const s = resolveWatermarkStyle(undefined, {
      [WATERMARK_ENV.style]: 'CORNER',
      [WATERMARK_ENV.position]: 'top-left',
      [WATERMARK_ENV.scale]: '1.5',
      [WATERMARK_ENV.opacity]: '0.3',
      [WATERMARK_ENV.color]: '#ABC',
      [WATERMARK_ENV.shadowColor]: '#002244',
      [WATERMARK_ENV.shadowOpacity]: '0.1',
      [WATERMARK_ENV.marginRatio]: '0.08',
      [WATERMARK_ENV.fontFamily]: 'Noto Serif',
    });
    expect(s.style).toBe('corner');
    expect(s.position).toBe('top-left');
    expect(s.scale).toBe(1.5);
    expect(s.opacity).toBe(0.3);
    expect(s.color).toBe('#aabbcc');
    expect(s.shadowColor).toBe('#002244');
    expect(s.shadowOpacity).toBe(0.1);
    expect(s.marginRatio).toBe(0.08);
    expect(s.fontFamily).toBe('Noto Serif');
  });

  it('显式覆盖项优先于 env', () => {
    const s = resolveWatermarkStyle({ style: 'bar' }, { [WATERMARK_ENV.style]: 'corner' });
    expect(s.style).toBe('bar');
  });

  it('非法 style/position 回默认，绝不"猜一个能跑的"', () => {
    const s = resolveWatermarkStyle(undefined, {
      [WATERMARK_ENV.style]: 'diagonal',
      [WATERMARK_ENV.position]: 'middle',
    });
    expect(s.style).toBe('tile');
    expect(s.position).toBe('bottom-right');
  });

  it('scale/opacity/marginRatio：非数字、NaN、越界 ⇒ 回默认（不是夹取）', () => {
    for (const bad of ['abc', '', 'NaN', 'Infinity', '0', '-1', '99', '1e999']) {
      const s = resolveWatermarkStyle(undefined, {
        [WATERMARK_ENV.scale]: bad,
        [WATERMARK_ENV.opacity]: bad,
        [WATERMARK_ENV.marginRatio]: bad,
      });
      expect(s.scale).toBe(DEFAULT_WATERMARK_STYLE.scale);
      expect(s.opacity).toBe(WATERMARK_STYLE_OPACITY.tile);
      expect(s.marginRatio).toBe(DEFAULT_WATERMARK_STYLE.marginRatio);
    }
    // '0'/'-1' 对 opacity 而言是"看不见/负数"—— 语义不明 ⇒ 同样回默认
    const edge = resolveWatermarkStyle(undefined, { [WATERMARK_ENV.opacity]: '0.02' });
    expect(edge.opacity).toBe(0.02); // 下界内合法
  });

  it('颜色白名单：只认 #rgb/#rrggbb；named color 与注入串一律回默认', () => {
    expect(sanitizeWatermarkColor('#fff', '#ffffff')).toBe('#ffffff');
    expect(sanitizeWatermarkColor('#AaBbCc', '#ffffff')).toBe('#aabbcc');
    for (const bad of ['red', 'rgb(1,2,3)', '#12345', '#1234567', '', 'url(x)', '" onload="x']) {
      expect(sanitizeWatermarkColor(bad, '#ffffff')).toBe('#ffffff');
    }
  });

  it('font-family 消毒：剥掉属性逃逸字符、限长 200、空回默认', () => {
    expect(sanitizeWatermarkFontFamily('Noto Sans, serif', 'F')).toBe('Noto Sans, serif');
    expect(sanitizeWatermarkFontFamily('a"<>&\';`b', 'F')).not.toMatch(/[<>"'&`;]/);
    expect(sanitizeWatermarkFontFamily('x'.repeat(500), 'F')).toHaveLength(200);
    expect(sanitizeWatermarkFontFamily('<<<>>>', 'F')).toBe('F');
    expect(sanitizeWatermarkFontFamily(undefined, 'F')).toBe('F');
  });

  it('envFloatInRange 与 envNumber.ts 口径一致：缺失/空串/非法 ⇒ fallback', () => {
    expect(envFloatInRange('X', 0.5, 0, 1, {})).toBe(0.5);
    expect(envFloatInRange('X', 0.5, 0, 1, { X: '' })).toBe(0.5);
    expect(envFloatInRange('X', 0.5, 0, 1, { X: 'abc' })).toBe(0.5);
    expect(envFloatInRange('X', 0.5, 0, 1, { X: '1.5' })).toBe(0.5); // 越界=非法=默认
    expect(envFloatInRange('X', 0.5, 0, 1, { X: '0.7' })).toBe(0.7);
  });

  it('parseWatermarkStyleName / parseWatermarkPosition 白名单', () => {
    expect(parseWatermarkStyleName(' Tile ')).toBe('tile');
    expect(parseWatermarkStyleName('x')).toBeUndefined();
    expect(parseWatermarkPosition('TOP-RIGHT')).toBe('top-right');
    expect(parseWatermarkPosition('center')).toBeUndefined();
  });
});

describe('度量：一切从 min(w,h) 派生（修 yMargin-from-width 的缺陷 3）', () => {
  it('tile：fontSize=clamp(round(min×0.022),14,54)，step=clamp(round(min×0.28),160,640)', () => {
    // 小图：双双落到下限
    const small = tileMetrics(400, 300, S());
    expect(small.fontSize).toBe(TILE_FONT_MIN_PX); // round(300×0.022)=7 → 14
    expect(small.step).toBe(TILE_STEP_MIN_PX); // round(84) → 160
    // 中图：公式区间内
    const mid = tileMetrics(1920, 1280, S());
    expect(mid.fontSize).toBe(28); // round(1280×0.022)
    expect(mid.step).toBe(358); // round(1280×0.28)
    // 大图：双双封顶 —— 6000px 级照片不会得到上千个 microscopic 标记
    const big = tileMetrics(6918, 4617, S());
    expect(big.fontSize).toBe(TILE_FONT_MAX_PX);
    expect(big.step).toBe(TILE_STEP_MAX_PX);
    // scale 倍率参与计算后再钳位
    const scaled = tileMetrics(1920, 1280, S({ scale: 2 }));
    expect(scaled.fontSize).toBe(54); // round(1280×0.022×2)=56 → 封顶 54
    expect(scaled.step).toBe(640); // round(716) → 封顶 640
  });

  it('corner/bar 的 margin 用 min(w,h)：4000×100 横幅的边距是 4px 而不是 160px', () => {
    const c = cornerMetrics(4000, 100, S());
    expect(c.margin).toBe(4); // round(100×0.04)
    expect(c.fontSize).toBe(CORNER_FONT_MIN_PX); // round(2.8) → 下限 16
    const b = barMetrics(4000, 100, S());
    expect(b.margin).toBe(4);
    expect(b.barHeight).toBeGreaterThanOrEqual(40);
    expect(b.barHeight).toBeLessThanOrEqual(100); // 不高于图片本身（BAR_HEIGHT_MAX_RATIO 参与钳位）
    // 旧实现同一张图：yMargin = 4000×0.05 = 200 ⇒ Y = 100−150−200 = −250（画布外）
    expect(legacyBottomRightY(4000, 100, 150)).toBe(-250);
  });

  it('corner 字号 = clamp(round(min×0.028),16,64)；bar 字号来自条高', () => {
    expect(cornerMetrics(800, 600, S()).fontSize).toBe(17); // round(16.8)
    expect(cornerMetrics(6000, 4000, S()).fontSize).toBe(CORNER_FONT_MAX_PX); // round(112) → 64
    const b = barMetrics(1920, 1080, S());
    expect(b.barHeight).toBe(130); // round(1080×0.12)
    expect(b.fontSize).toBe(clampInt(130 * 0.42, BAR_FONT_MIN_PX, BAR_FONT_MAX_PX)); // 55
    const tall = barMetrics(100, 4000, S());
    expect(tall.barHeight).toBeLessThanOrEqual(Math.round(4000 * 0.35));
  });

  it('watermarkCornerPoint：四个角 + 永不越界（clamp ≥ 0）', () => {
    expect(watermarkCornerPoint('bottom-right', 800, 600, 100, 20, 24)).toEqual({ left: 676, top: 556 });
    expect(watermarkCornerPoint('bottom-left', 800, 600, 100, 20, 24)).toEqual({ left: 24, top: 556 });
    expect(watermarkCornerPoint('top-right', 800, 600, 100, 20, 24)).toEqual({ left: 676, top: 24 });
    expect(watermarkCornerPoint('top-left', 800, 600, 100, 20, 24)).toEqual({ left: 24, top: 24 });
    // 标记比图大也不会给出负坐标（旧实现正是负 Y → jimp 整块裁掉 → changedPx=0）
    const p = watermarkCornerPoint('bottom-right', 100, 50, 200, 80, 4);
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });
});

describe('负对照（negative controls）：旧公式的失败形状被钉住', () => {
  it('缺陷 3：旧 yMargin=width×5% 让 4000×100 横幅的 Y=−250（水印整体画布外，实测 changedPx=0）', () => {
    expect(legacyBottomRightY(4000, 100, 150)).toBeLessThan(0);
    // 800×600 普通图旧公式"碰巧"正常（yMargin=40）—— 说明该 bug 只在 width≫height 时显形，
    // 这正是它潜伏这么久的原因
    expect(legacyBottomRightY(800, 600, 150)).toBe(410);
    // 修复后：任何几何下 corner 落点都在画布内（见 watermarkCornerPoint 的 clamp 测试）
  });

  it('缺陷 2：旧固定尺寸在 400px 图上占宽 90%，新比例字号 ≤ ~30%', () => {
    // 旧实现：'example.com' 128px 字实测宽 797px → 400px 图上被缩到 360 = 90%
    expect(legacyLogoWidth(797, 400)).toBe(360);
    expect(360 / 400).toBeCloseTo(0.9, 5);
    // 800×600 上旧实现同样是 90%（720/800）—— 不是"只有小图才丑"
    expect(legacyLogoWidth(797, 800)).toBe(720);
    // 新实现：tile 单标记外接宽 / 图宽
    const { fontSize } = tileMetrics(400, 400, S()); // 14
    const extent = rotatedMarkExtent(withCopyrightPrefix('example.com'), fontSize);
    expect(extent / 400).toBeLessThan(0.3);
    expect(extent / 400).toBeGreaterThan(0.05);
  });
});

describe('文字规整与转义（水印文字是不可信输入，会进 SVG）', () => {
  it('normalizeWatermarkText：控制字符/多空白折叠、按码点截 256、非字符串回空', () => {
    expect(normalizeWatermarkText('  a\t b\n c ')).toBe('a b c');
    expect(normalizeWatermarkText(123 as any)).toBe('');
    expect(normalizeWatermarkText(null)).toBe('');
    const long = '汉'.repeat(300);
    expect(Array.from(normalizeWatermarkText(long))).toHaveLength(256);
    // 代理对安全：emoji 算 1 个码点，截断不会切出半个代理对
    const emoji = '😀'.repeat(300);
    const cut = normalizeWatermarkText(emoji);
    expect(Array.from(cut)).toHaveLength(256);
    expect(cut.charCodeAt(cut.length - 1)).not.toBeLessThan(0xdc00); // 不以孤立低代理结尾
  });

  it('withCopyrightPrefix：没带 © 就补；已带的不重复', () => {
    expect(withCopyrightPrefix('VanBlog')).toBe('© VanBlog');
    expect(withCopyrightPrefix('© VanBlog')).toBe('© VanBlog');
    expect(withCopyrightPrefix('(c) x')).toBe('(c) x');
    expect(withCopyrightPrefix('(C) x')).toBe('(C) x');
    expect(withCopyrightPrefix('')).toBe('');
  });

  it('escapeXml：SVG 注入被转义', () => {
    expect(escapeXml(`</text><script>alert(1)</script>`)).not.toContain('<script>');
    expect(escapeXml(`a&b"'<>`)).toBe('a&amp;b&quot;&apos;&lt;&gt;');
  });

  it('containsCjk：汉字/全角标点 true，纯 Latin false', () => {
    expect(containsCjk('酱油的博客')).toBe(true);
    expect(containsCjk('，')).toBe(true); // 全角逗号 U+FF0C
    expect(containsCjk('example.com')).toBe(false);
  });
});

describe('宽度估计与 SVG 构造', () => {
  it('charAdvanceEm：CJK≈1em，W 比 i 宽得多（度量分档有效）', () => {
    expect(charAdvanceEm('汉')).toBeCloseTo(1.05, 5);
    expect(charAdvanceEm('W')).toBeGreaterThan(charAdvanceEm('i') * 2);
    expect(estimateTextWidthPx('WWWW', 100)).toBeGreaterThan(estimateTextWidthPx('iiii', 100));
    expect(estimateTextWidthPx('汉汉', 100)).toBeGreaterThan(estimateTextWidthPx('WW', 100));
    // 与 fontSize 线性
    expect(estimateTextWidthPx('abc', 200)).toBeCloseTo(estimateTextWidthPx('abc', 100) * 2, 5);
  });

  it('rotatedMarkExtent ≥ 未旋转宽度×cos26°（旋转包络更大）', () => {
    const w = estimateTextWidthPx('© example.com', 20);
    expect(rotatedMarkExtent('© example.com', 20)).toBeGreaterThan(w * Math.cos((-TILE_ROTATION_DEG * Math.PI) / 180) * 0.99);
  });

  it('buildTileSvg：step×step 画布、5 份旋转拷贝（中心+四角=无缝）、文字被转义', () => {
    const { svg, canvasWidth, canvasHeight } = buildTileSvg('<b>&', 20, 250, S());
    expect(canvasWidth).toBe(250);
    expect(canvasHeight).toBe(250);
    expect(svg).toContain('width="250"');
    expect(svg.match(/rotate\(/g)).toHaveLength(5);
    expect(svg).toContain(String(TILE_ROTATION_DEG));
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;b&gt;&amp;');
    // 双色调：每份拷贝 = 阴影 + 正文两个 <text>（阴影在下、正文在上，不用 stroke 方案）
    expect(svg.match(/<text /g)).toHaveLength(10);
    expect(svg).not.toContain('paint-order');
  });

  it('buildCornerSvg：withText=false 时无 <text>；widthFactor 加宽画布', () => {
    const full = buildCornerSvg('abc', 32, S(), 1, true);
    const bare = buildCornerSvg('abc', 32, S(), 1, false);
    expect(full.svg).toContain('<text ');
    expect(bare.svg).not.toContain('<text ');
    expect(full.canvasWidth).toBe(bare.canvasWidth);
    const wide = buildCornerSvg('abc', 32, S(), 1.6, true);
    expect(wide.canvasWidth).toBeGreaterThan(full.canvasWidth);
    expect(wide.svg).toContain('radialGradient'); // 柔光底板，无硬边框
  });

  it('buildBarSvg：底部条上透下深；顶部条反向；对齐随 position', () => {
    const bottom = buildBarSvg({
      text: 'x.com',
      width: 800,
      barHeight: 96,
      fontSize: 40,
      margin: 24,
      style: S({ style: 'bar', position: 'bottom-right' }),
    });
    expect(bottom.canvasWidth).toBe(800);
    expect(bottom.canvasHeight).toBe(96);
    const stops = bottom.svg.indexOf('stop-opacity="0"');
    const deep = bottom.svg.indexOf('stop-opacity="0.35"');
    expect(stops).toBeLessThan(deep); // 底条：先透明后深
    expect(bottom.svg).toContain('text-anchor="end"');
    const top = buildBarSvg({
      text: 'x.com',
      width: 800,
      barHeight: 96,
      fontSize: 40,
      margin: 24,
      style: S({ style: 'bar', position: 'top-left' }),
    });
    expect(top.svg.indexOf('stop-opacity="0.35"')).toBeLessThan(top.svg.indexOf('stop-opacity="0"'));
    expect(top.svg).toContain('text-anchor="start"');
  });

  it('clampInt 边界', () => {
    expect(clampInt(3.4, 1, 10)).toBe(3);
    expect(clampInt(0, 14, 54)).toBe(14);
    expect(clampInt(999, 14, 54)).toBe(54);
  });
});
