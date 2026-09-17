import { envPositiveInt } from './envNumber';

/**
 * 可见水印的**纯函数层**：样式解析（env / 覆盖项）、按图片尺寸的度量、SVG 构造。
 * 不依赖 sharp/jimp，全部可单测；栅格化与合成在 `utils/watermark.ts`。
 *
 * 为什么重做（2026-09，「这个明水印功能是不是很低效且难看」）：
 * 旧实现是 jimp + BMFont open-sans-128-white，实测有四个硬伤 ——
 *  1. 纯 JS 合成：800×600 一次合成 13.3s（spec 实测），而本项目早就有 sharp 0.35/libvips 8.18；
 *  2. 字号/画布固定（128px 字、150px 高、min 500px 宽）：400px 小图上水印占宽 90%，
 *     大图上又相对过小 —— 只在很窄的尺寸带里"看着还行"；
 *  3. `yMargin` 用的是 **width** 而不是 height（旧 watermark.ts:21）：4000×100 的横幅
 *     Y = 100−150−200 = **−250**，水印整个落到画布外，实测 changedPx=0（静默消失）；
 *  4. BMFont 无 CJK 字形：'酱油的博客' 实测 measureText=0，5 个字各渲染成**同一个
 *     59×93 的空心豆腐块**（.notdef），而后台是中文产品、站名水印几乎必然是中文。
 *     （admin 的 WaterMarkForm 甚至用 checkNoChinese 直接把中文水印拦掉了。）
 *
 * 新默认样式是 **tile（无缝斜排平铺）**：满图重复的小字水印（旋转 −26°、低不透明度、
 * 白字 + 半透明深色阴影的双色调），"一眼能看出有水印，但第一眼不破坏观感"，且裁不掉。
 * 另有 corner（右下角柔光底板）与 bar（底部渐变条）两种可选样式，见 VANBLOG_WATERMARK_STYLE。
 *
 * ⚠️ SVG <text> 经 libvips→librsvg→pango→fontconfig 栅格化，**依赖系统字体**。
 * 生产镜像（node:24-alpine runner）目前一个字体都没装 —— 需要在 Dockerfile runner
 * 阶段的 apk add 里加：`fontconfig ttf-dejavu wqy-zenhei`（Latin + 中文，实测增量见交付报告）。
 * 没有字体时水印会渲染成空白，watermark.ts 会 WARN（点名缺失的字体）并**返回原图**，
 * 绝不让上传失败。
 */

// ---------------------------------------------------------------------------
// 样式与默认值
// ---------------------------------------------------------------------------

export type WatermarkStyleName = 'tile' | 'corner' | 'bar';

export const WATERMARK_STYLE_NAMES: readonly WatermarkStyleName[] = ['tile', 'corner', 'bar'];

export type WatermarkPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export const WATERMARK_POSITIONS: readonly WatermarkPosition[] = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
];

export interface WatermarkStyle {
  /** tile=无缝平铺（默认）；corner=角上柔光底板；bar=底/顶部渐变条 */
  style: WatermarkStyleName;
  /** corner 用：四个角。bar 用：top-*=条在顶部、*-left/right=文字对齐。tile 不用。 */
  position: WatermarkPosition;
  /** 尺寸倍率（乘在各样式的基准比例上），默认 1 */
  scale: number;
  /** 文字颜色（#rgb/#rrggbb），默认白 */
  color: string;
  /** 文字不透明度；默认按样式（tile 0.12 / corner 0.85 / bar 0.95） */
  opacity: number;
  /** 阴影颜色，默认黑（双色调：白字 + 深色 1px 偏移阴影，深浅背景都读得出） */
  shadowColor: string;
  /** 阴影不透明度；默认 = opacity × 0.5 */
  shadowOpacity: number;
  /** corner/bar 的边距比例（× min(w,h)）——**永远从短边算**，修旧实现从 width 算的 bug */
  marginRatio: number;
  /** SVG font-family 链：Latin 打头，CJK 断后，最后 generic */
  fontFamily: string;
}

/**
 * font-family 链（也是给 Dockerfile 报缺口的依据）：
 *  - `DejaVu Sans`：Alpine `ttf-dejavu`，Latin 主力（无衬线、度量与旧 Open Sans 接近）；
 *  - `Noto Sans CJK SC`：开发机/桌面 Linux 常见（`font-noto-cjk`，镜像里**不装**，太大）；
 *  - `WenQuanYi Zen Hei`：Alpine `wqy-zenhei`（文泉驿正黑），镜像里装的 CJK 字体；
 *  - `sans-serif`：fontconfig 兜底。
 * pango 是**逐字符**回退的：Latin 走 DejaVu，汉字自动落到后面第一个有该字形的字体。
 */
export const DEFAULT_WATERMARK_FONT_FAMILY =
  "DejaVu Sans, 'Noto Sans CJK SC', 'WenQuanYi Zen Hei', sans-serif";

/** 各样式的默认文字不透明度（阴影默认取一半） */
export const WATERMARK_STYLE_OPACITY: Record<WatermarkStyleName, number> = {
  tile: 0.12,
  corner: 0.85,
  bar: 0.95,
};

export const DEFAULT_WATERMARK_STYLE: WatermarkStyle = {
  style: 'tile',
  position: 'bottom-right',
  scale: 1,
  color: '#ffffff',
  opacity: WATERMARK_STYLE_OPACITY.tile,
  shadowColor: '#000000',
  shadowOpacity: WATERMARK_STYLE_OPACITY.tile / 2,
  marginRatio: 0.04,
  fontFamily: DEFAULT_WATERMARK_FONT_FAMILY,
};

/** tile 的旋转角（度）。SVG y 轴向下，负角 = 文字右上倾斜。 */
export const TILE_ROTATION_DEG = -26;

// 样式基准比例与钳位（owner 指定的公式，勿随手改）：
export const TILE_FONT_RATIO = 0.022;
export const TILE_FONT_MIN_PX = 14;
export const TILE_FONT_MAX_PX = 54;
export const TILE_STEP_RATIO = 0.28;
export const TILE_STEP_MIN_PX = 160;
export const TILE_STEP_MAX_PX = 640;

export const CORNER_FONT_RATIO = 0.028;
export const CORNER_FONT_MIN_PX = 16;
export const CORNER_FONT_MAX_PX = 64;

export const BAR_HEIGHT_RATIO = 0.12;
export const BAR_HEIGHT_MAX_RATIO = 0.35;
export const BAR_HEIGHT_MIN_PX = 40;
export const BAR_FONT_RATIO = 0.42;
export const BAR_FONT_MIN_PX = 14;
export const BAR_FONT_MAX_PX = 96;
/** bar 渐变最深处（贴边一侧）的黑色 alpha */
export const BAR_GRADIENT_ALPHA = 0.35;

// ---------------------------------------------------------------------------
// env 解析（口径与 utils/envNumber.ts / envBool.ts 一致：非法一律回默认）
// ---------------------------------------------------------------------------

export const WATERMARK_ENV = {
  style: 'VANBLOG_WATERMARK_STYLE',
  position: 'VANBLOG_WATERMARK_POSITION',
  scale: 'VANBLOG_WATERMARK_SCALE',
  opacity: 'VANBLOG_WATERMARK_OPACITY',
  color: 'VANBLOG_WATERMARK_COLOR',
  shadowColor: 'VANBLOG_WATERMARK_SHADOW_COLOR',
  shadowOpacity: 'VANBLOG_WATERMARK_SHADOW_OPACITY',
  marginRatio: 'VANBLOG_WATERMARK_MARGIN_RATIO',
  fontFamily: 'VANBLOG_WATERMARK_FONT_FAMILY',
  fontMinPx: 'VANBLOG_WATERMARK_FONT_MIN_PX',
  fontMaxPx: 'VANBLOG_WATERMARK_FONT_MAX_PX',
} as const;

/**
 * [0,1] 之外的小数没有合法语义（不像 envPositiveInt 可以夹取）⇒ 越界=非法=回默认。
 * 语义与 envNumber.ts 一致：缺失/空串/非数字/NaN/Infinity ⇒ fallback。
 */
export function envFloatInRange(
  name: string,
  fallback: number,
  min: number,
  max: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    return fallback;
  }
  return n;
}

export function parseWatermarkStyleName(raw: unknown): WatermarkStyleName | undefined {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  return (WATERMARK_STYLE_NAMES as readonly string[]).includes(text)
    ? (text as WatermarkStyleName)
    : undefined;
}

export function parseWatermarkPosition(raw: unknown): WatermarkPosition | undefined {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  return (WATERMARK_POSITIONS as readonly string[]).includes(text)
    ? (text as WatermarkPosition)
    : undefined;
}

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** 颜色只认 #rgb/#rrggbb（白名单），其余（含 named color、url()、引号）一律回默认 —— 这个值会进 SVG 属性。 */
export function sanitizeWatermarkColor(raw: unknown, fallback: string): string {
  const text = String(raw ?? '').trim();
  if (!COLOR_RE.test(text)) {
    return fallback;
  }
  return text.length === 4
    ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase()
    : text.toLowerCase();
}

/**
 * font-family 会整段进 SVG 属性：剥掉所有可能逃逸属性/注入标签的字符
 * （< > " ' & 反引号、控制字符、分号），并限长 200。清完为空 ⇒ 回默认。
 */
export function sanitizeWatermarkFontFamily(raw: unknown, fallback: string): string {
  const text = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>"'&`;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return text || fallback;
}

function firstFinite(...candidates: Array<number | undefined | null>): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) {
      return c;
    }
  }
  return undefined;
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * 汇总样式：默认值 ← env ← 显式覆盖项，每一层都过同一套白名单/范围校验，
 * 非法值**回默认**而不是回"某个能跑的宽限值"。
 * opacity/shadowOpacity 的默认值依赖 style，所以先定 style 再逐字段解析；
 * shadowOpacity 未显式给出时 = 生效 opacity 的一半（跟随 env 改过的 opacity）。
 */
export function resolveWatermarkStyle(
  overrides?: Partial<WatermarkStyle> | null,
  env: NodeJS.ProcessEnv = process.env,
): WatermarkStyle {
  const o = overrides || {};
  const styleName =
    parseWatermarkStyleName(o.style) ??
    parseWatermarkStyleName(env[WATERMARK_ENV.style]) ??
    DEFAULT_WATERMARK_STYLE.style;
  const baseOpacity = WATERMARK_STYLE_OPACITY[styleName];

  const position =
    parseWatermarkPosition(o.position) ??
    parseWatermarkPosition(env[WATERMARK_ENV.position]) ??
    DEFAULT_WATERMARK_STYLE.position;

  const scale = firstFinite(
    inRange(o.scale, 0.4, 3),
    envFloatInRange(WATERMARK_ENV.scale, NaN, 0.4, 3, env),
  );

  const opacity = firstFinite(
    inRange(o.opacity, 0.02, 1),
    envFloatInRange(WATERMARK_ENV.opacity, NaN, 0.02, 1, env),
  );
  const effectiveOpacity = opacity ?? baseOpacity;

  const shadowOpacity = firstFinite(
    inRange(o.shadowOpacity, 0, 1),
    envFloatInRange(WATERMARK_ENV.shadowOpacity, NaN, 0, 1, env),
  );

  const marginRatio = firstFinite(
    inRange(o.marginRatio, 0.005, 0.25),
    envFloatInRange(WATERMARK_ENV.marginRatio, NaN, 0.005, 0.25, env),
  );

  const color = sanitizeWatermarkColor(
    o.color ?? env[WATERMARK_ENV.color],
    DEFAULT_WATERMARK_STYLE.color,
  );
  const shadowColor = sanitizeWatermarkColor(
    o.shadowColor ?? env[WATERMARK_ENV.shadowColor],
    DEFAULT_WATERMARK_STYLE.shadowColor,
  );
  const fontFamily = sanitizeWatermarkFontFamily(
    o.fontFamily ?? env[WATERMARK_ENV.fontFamily],
    DEFAULT_WATERMARK_STYLE.fontFamily,
  );

  return {
    style: styleName,
    position,
    scale: scale ?? DEFAULT_WATERMARK_STYLE.scale,
    color,
    opacity: effectiveOpacity,
    shadowColor,
    shadowOpacity: shadowOpacity ?? effectiveOpacity / 2,
    marginRatio: marginRatio ?? DEFAULT_WATERMARK_STYLE.marginRatio,
    fontFamily,
  };
}

function inRange(n: unknown, min: number, max: number): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    return undefined;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 文字规整（进 SVG 之前必须过这里：水印文字来自后台设置/上传参数，是不可信输入）
// ---------------------------------------------------------------------------

export const WATERMARK_TEXT_MAX_CODEPOINTS = 256;

/** 控制字符转空格、连续空白折叠、去首尾；按**码点**（代理对安全）截到 256。 */
export function normalizeWatermarkText(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0020\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const cps = Array.from(cleaned);
  return cps.length > WATERMARK_TEXT_MAX_CODEPOINTS
    ? cps.slice(0, WATERMARK_TEXT_MAX_CODEPOINTS).join('')
    : cleaned;
}

/** 没带 © 就补一个前缀（版权意图明确；已有 ©/Ⓒ/(c) 的不重复加）。 */
export function withCopyrightPrefix(text: string): string {
  const t = text.trim();
  if (!t) {
    return t;
  }
  if (t.startsWith('©') || t.startsWith('Ⓒ') || /^\((c|C)\)\s*/.test(t)) {
    return t;
  }
  return `© ${t}`;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CJK（含全角标点/兼容区）——用于"是否需要 CJK 字体"的探测判断。 */
export const CJK_RE =
  /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}

// ---------------------------------------------------------------------------
// 按图片尺寸的度量（全部从 min(w,h) 派生 —— 修 yMargin-from-width 的 bug）
// ---------------------------------------------------------------------------

export interface TileMetrics {
  fontSize: number;
  step: number;
}

export function tileMetrics(width: number, height: number, style: WatermarkStyle): TileMetrics {
  const min = Math.max(1, Math.min(width, height));
  return {
    fontSize: clampInt(min * TILE_FONT_RATIO * style.scale, TILE_FONT_MIN_PX, TILE_FONT_MAX_PX),
    step: clampInt(min * TILE_STEP_RATIO * style.scale, TILE_STEP_MIN_PX, TILE_STEP_MAX_PX),
  };
}

export interface CornerMetrics {
  fontSize: number;
  margin: number;
}

export function cornerMetrics(
  width: number,
  height: number,
  style: WatermarkStyle,
): CornerMetrics {
  const min = Math.max(1, Math.min(width, height));
  return {
    fontSize: clampInt(min * CORNER_FONT_RATIO * style.scale, CORNER_FONT_MIN_PX, CORNER_FONT_MAX_PX),
    margin: Math.max(1, Math.round(min * style.marginRatio * style.scale)),
  };
}

export interface BarMetrics {
  barHeight: number;
  fontSize: number;
  margin: number;
}

export function barMetrics(width: number, height: number, style: WatermarkStyle): BarMetrics {
  const min = Math.max(1, Math.min(width, height));
  const barHeight = clampInt(
    height * BAR_HEIGHT_RATIO * style.scale,
    BAR_HEIGHT_MIN_PX,
    Math.max(BAR_HEIGHT_MIN_PX, Math.round(height * BAR_HEIGHT_MAX_RATIO)),
  );
  return {
    barHeight,
    fontSize: clampInt(barHeight * BAR_FONT_RATIO, BAR_FONT_MIN_PX, BAR_FONT_MAX_PX),
    margin: Math.max(1, Math.round(min * style.marginRatio * style.scale)),
  };
}

/** 角标落点：ink 盒的 left/top（调用方保证 left/top ≥ 0 已由 clamp 处理）。 */
export function watermarkCornerPoint(
  position: WatermarkPosition,
  imgWidth: number,
  imgHeight: number,
  markWidth: number,
  markHeight: number,
  margin: number,
): { left: number; top: number } {
  const left = position.endsWith('right')
    ? imgWidth - margin - markWidth
    : margin;
  const top = position.startsWith('bottom')
    ? imgHeight - margin - markHeight
    : margin;
  return { left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) };
}

// ---------------------------------------------------------------------------
// 文本宽度估计（只为画布尺寸与"缩字号装得下"的判断；最终 ink 盒靠栅格化后实测）
// ---------------------------------------------------------------------------

/** 每字符前进宽度（em），按 DejaVu Sans / Noto CJK 的度量分档；宁可高估。 */
export function charAdvanceEm(cp: string): number {
  if (cp.length > 1 || CJK_RE.test(cp)) {
    return 1.05; // 代理对/CJK/全角：≈1em
  }
  const code = cp.charCodeAt(0);
  if (code === 0x20) return 0.34;
  if (cp >= 'A' && cp <= 'Z') return cp === 'W' || cp === 'M' ? 0.9 : 0.7;
  if (cp >= 'a' && cp <= 'z') return cp === 'i' || cp === 'l' || cp === 'j' ? 0.32 : 0.6;
  if (cp >= '0' && cp <= '9') return 0.64;
  if ('.,:;!\'|'.includes(cp)) return 0.32;
  if ('©®℗'.includes(cp)) return 0.85;
  return 0.68;
}

export function estimateTextWidthPx(text: string, fontSize: number, letterSpacingPx = 0): number {
  const cps = Array.from(text);
  let em = 0;
  for (const cp of cps) {
    em += charAdvanceEm(cp);
  }
  return em * fontSize + Math.max(0, cps.length - 1) * letterSpacingPx;
}

export function letterSpacingFor(fontSize: number): number {
  return Math.round(fontSize * 0.06 * 100) / 100;
}

/** 阴影偏移：≈1px 起，大字号按 fs/28 微增（双色调的"深色半边"）。 */
export function shadowOffsetFor(fontSize: number): number {
  return Math.max(1, Math.round(fontSize / 28));
}

function fmtNum(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

interface DualToneTextOptions {
  anchor?: 'middle' | 'start' | 'end';
}

/** 双色调文字：深色阴影在下（+offset 偏移），正文在上。深浅背景都读得出的关键。 */
function dualToneText(
  x: number,
  baselineY: number,
  text: string,
  fontSize: number,
  style: WatermarkStyle,
  opts: DualToneTextOptions = {},
): string {
  const off = shadowOffsetFor(fontSize);
  const ls = letterSpacingFor(fontSize);
  const anchor = opts.anchor || 'middle';
  const common =
    `font-family="${escapeXml(style.fontFamily)}" font-size="${fontSize}"` +
    ` letter-spacing="${fmtNum(ls)}" text-anchor="${anchor}"`;
  const escaped = escapeXml(text);
  return (
    `<text x="${fmtNum(x + off)}" y="${fmtNum(baselineY + off)}" ${common}` +
    ` fill="${style.shadowColor}" fill-opacity="${fmtNum(style.shadowOpacity)}">${escaped}</text>` +
    `<text x="${fmtNum(x)}" y="${fmtNum(baselineY)}" ${common}` +
    ` fill="${style.color}" fill-opacity="${fmtNum(style.opacity)}">${escaped}</text>`
  );
}

/**
 * 单个水印标记的**旋转变换角度与中心基线**：
 * 视觉中心 (cx, cy)，基线取 cy + 0.36×fs（大写字母视觉居中，DejaVu cap-height≈0.73em）。
 */
function rotatedMark(
  cx: number,
  cy: number,
  text: string,
  fontSize: number,
  style: WatermarkStyle,
  angleDeg: number,
): string {
  const baselineY = cy + fontSize * 0.36;
  return (
    `<g transform="rotate(${fmtNum(angleDeg)} ${fmtNum(cx)} ${fmtNum(cy)})">` +
    dualToneText(cx, baselineY, text, fontSize, style) +
    `</g>`
  );
}

// ---------------------------------------------------------------------------
// tile：一块 step×step 的无缝砖
// ---------------------------------------------------------------------------

/**
 * 无缝平铺的关键：文字放在砖的**中心 + 四个角**（5 份拷贝）。角上的四份被砖边界裁掉的部分，
 * 恰好由相邻砖对角的拷贝补上 —— 平铺后整个图案以 step 为周期连续，砖缝不可见。
 * （watermark.spec.ts 用"周期平移逐像素相等"+"跨缝标记完整"两组断言钉住这一点。）
 *
 * 标记宽高受 step 约束：估计宽度超过 0.95×step 时由 watermark.ts 缩字号重装（不裁字）。
 */
export function buildTileSvg(
  text: string,
  fontSize: number,
  step: number,
  style: WatermarkStyle,
): { svg: string; canvasWidth: number; canvasHeight: number } {
  const s = Math.max(8, Math.round(step));
  const half = s / 2;
  const marks = [
    rotatedMark(half, half, text, fontSize, style, TILE_ROTATION_DEG),
    rotatedMark(0, 0, text, fontSize, style, TILE_ROTATION_DEG),
    rotatedMark(s, 0, text, fontSize, style, TILE_ROTATION_DEG),
    rotatedMark(0, s, text, fontSize, style, TILE_ROTATION_DEG),
    rotatedMark(s, s, text, fontSize, style, TILE_ROTATION_DEG),
  ].join('');
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">${marks}</svg>`,
    canvasWidth: s,
    canvasHeight: s,
  };
}

/** 旋转 −26° 后标记的近似外接宽度（用于 tile 装不下时缩字号）。 */
export function rotatedMarkExtent(text: string, fontSize: number, angleDeg = TILE_ROTATION_DEG): number {
  const ls = letterSpacingFor(fontSize);
  const w = estimateTextWidthPx(text, fontSize, ls);
  const h = fontSize * 1.05;
  const rad = (Math.abs(angleDeg) * Math.PI) / 180;
  return w * Math.cos(rad) + h * Math.sin(rad);
}

// ---------------------------------------------------------------------------
// corner：柔光底板 + 双色调文字（画布四周留透明 pad，栅格化后实测 ink 盒再定位）
// ---------------------------------------------------------------------------

/**
 * @param widthFactor 估计文本宽度失真导致 ink 贴到画布边时，watermark.ts 会 ×1.6 重渲染。
 * @param withText false = 只画底板不画字 —— 与整图逐字节对比即可判定"文字渲染出来没有"
 *                 （无字体容器里底板照常渲染，光数 ink 会把"有板无字"误判为成功，
 *                 那正是要避免的**静默失败**）。
 */
export function buildCornerSvg(
  text: string,
  fontSize: number,
  style: WatermarkStyle,
  widthFactor = 1,
  withText = true,
): { svg: string; canvasWidth: number; canvasHeight: number } {
  const ls = letterSpacingFor(fontSize);
  const est = estimateTextWidthPx(text, fontSize, ls);
  const padX = Math.ceil(fontSize * 1.0);
  const padY = Math.ceil(fontSize * 1.0);
  const cw = Math.max(16, Math.ceil(est * widthFactor + padX * 2));
  const ch = Math.max(16, Math.ceil(fontSize * 1.7 + padY * 2));
  // 柔光底板：径向渐变椭圆（中心 0.42 → 边缘 0），没有硬边框；白字压在上面深浅背景都能读。
  const scrim =
    `<defs><radialGradient id="wb-scrim" cx="50%" cy="50%" r="50%">` +
    `<stop offset="0%" stop-color="#141414" stop-opacity="0.42"/>` +
    `<stop offset="55%" stop-color="#141414" stop-opacity="0.30"/>` +
    `<stop offset="100%" stop-color="#141414" stop-opacity="0"/>` +
    `</radialGradient></defs>` +
    `<ellipse cx="${fmtNum(cw / 2)}" cy="${fmtNum(ch / 2)}" rx="${fmtNum(cw / 2)}" ry="${fmtNum(ch / 2)}" fill="url(#wb-scrim)"/>`;
  const mark = withText
    ? dualToneText(cw / 2, ch / 2 + fontSize * 0.36, text, fontSize, style)
    : '';
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}">${scrim}${mark}</svg>`,
    canvasWidth: cw,
    canvasHeight: ch,
  };
}

// ---------------------------------------------------------------------------
// bar：底/顶渐变条（整宽画布，文字画在条内；条本身随 position 放底或顶）
// ---------------------------------------------------------------------------

export interface BarSvgOptions {
  text: string;
  width: number;
  barHeight: number;
  fontSize: number;
  margin: number;
  style: WatermarkStyle;
  /** false = 只画渐变条不画字（空白字体检测的对照组，见 buildCornerSvg 的同名参数） */
  withText?: boolean;
}

/**
 * 渐变从透明到 rgba(0,0,0,BAR_GRADIENT_ALPHA)：底部条 = 上透下深；顶部条（position top-*）反向。
 * 文字水平位置由 position 的 left/right 决定（margin 内缩）；居中兜底。
 */
export function buildBarSvg(opts: BarSvgOptions): { svg: string; canvasWidth: number; canvasHeight: number } {
  const { text, width, barHeight, fontSize, margin, style } = opts;
  const w = Math.max(16, Math.round(width));
  const bh = Math.max(16, Math.round(barHeight));
  const top = style.position.startsWith('top');
  const deep = `<stop offset="100%" stop-color="#000000" stop-opacity="${fmtNum(BAR_GRADIENT_ALPHA)}"/>`;
  const clear = `<stop offset="0%" stop-color="#000000" stop-opacity="0"/>`;
  const grad =
    `<defs><linearGradient id="wb-bar" x1="0" y1="0" x2="0" y2="1">` +
    (top ? `${deep}${clear}` : `${clear}${deep}`) +
    `</linearGradient></defs>` +
    `<rect x="0" y="0" width="${w}" height="${bh}" fill="url(#wb-bar)"/>`;
  const ls = letterSpacingFor(fontSize);
  const est = estimateTextWidthPx(text, fontSize, ls);
  let x: number;
  let anchor: 'middle' | 'start' | 'end' = 'middle';
  if (style.position.endsWith('left')) {
    x = margin;
    anchor = 'start';
  } else if (style.position.endsWith('right')) {
    x = w - margin;
    anchor = 'end';
  } else {
    x = w / 2;
  }
  // 装不下就贴边收进来（不裁字；缩字号在 watermark.ts 里按 est 先做）
  const maxHalf = Math.max(8, w / 2 - margin);
  if (anchor === 'middle' && est / 2 > maxHalf) {
    x = w / 2;
  }
  const baselineY = bh / 2 + fontSize * 0.36;
  const mark =
    opts.withText === false
      ? ''
      : dualToneText(x, baselineY, text, fontSize, style, { anchor });
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${bh}">${grad}${mark}</svg>`,
    canvasWidth: w,
    canvasHeight: bh,
  };
}

// ---------------------------------------------------------------------------
// 负对照（negative controls）：旧实现的公式，**仅供 spec 证明修复有效**，勿在生产路径使用
// ---------------------------------------------------------------------------

/**
 * 旧 yMargin-from-width（缺陷 3）：yMargin = width×5%，Y = height − logoHeight − yMargin。
 * 实测 4000×100 横幅 → Y = −250（整个水印在画布外，changedPx=0，静默消失）；
 * 100×4000 竖条 → 边距只剩 5px（贴边）。修复后所有边距都从 min(w,h) 派生。
 */
export function legacyBottomRightY(imgWidth: number, imgHeight: number, logoHeight: number): number {
  const yMargin = imgWidth * 0.05;
  return imgHeight - logoHeight - yMargin;
}

/**
 * 旧固定尺寸（缺陷 2）：logo 画布 max(500, textWidth)×150，128px 字，
 * 超宽时**缩**到 width−2×5%×width。实测 400×400 图上 'example.com'（797px）被缩到 360px
 * = **90% 图宽**；800×600 上也有 90%。新实现按 min(w,h) 比例出字号，400px 图上 ≤ ~25%。
 */
export function legacyLogoWidth(textWidthPx: number, imgWidth: number): number {
  const logoW = Math.max(500, Math.ceil(textWidthPx));
  const maxLogoWidth = imgWidth - 2 * (imgWidth * 0.05);
  return maxLogoWidth > 0 && logoW > maxLogoWidth ? maxLogoWidth : logoW;
}
