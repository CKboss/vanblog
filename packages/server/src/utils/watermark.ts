import { Logger } from '@nestjs/common';
import { isAvifBuffer, tryLoadSharp } from './avif';
import {
  WatermarkStyle,
  barMetrics,
  buildBarSvg,
  buildCornerSvg,
  buildTileSvg,
  clampInt,
  containsCjk,
  cornerMetrics,
  DEFAULT_WATERMARK_FONT_FAMILY,
  estimateTextWidthPx,
  letterSpacingFor,
  normalizeWatermarkText,
  resolveWatermarkStyle,
  rotatedMarkExtent,
  tileMetrics,
  watermarkCornerPoint,
  withCopyrightPrefix,
} from './watermarkSvg';

/**
 * 可见文字水印（sharp/libvips 实现，2026-09 重写替换 jimp）。
 *
 * 公共接缝保持不变：`addWaterMarkToIMG(srcImage, waterMarkText) => Promise<Buffer>`，
 * 唯一调用方是 `provider/static/static.provider.ts` 的上传管线（gif 在调用方就被排除）。
 *
 * 三条铁律：
 *  1. **绝不让上传失败**：任何异常（图坏了、格式不支持、系统没字体、sharp 缺失）都
 *     WARN（带来源标签）并**返回原 buffer**。旧实现是直接 throw 的 —— 只是 static.provider
 *     调用点自己包了 try/catch 才没炸上传；保护现在内建在这一层，调用点之外也成立。
 *  2. **保持输入格式**：jpeg→jpeg(q90)、png→png(level9)、webp→webp(q90)、avif→avif(q70)、
 *     tiff→tiff(q90)（质量口径与 utils/imgResize.ts 的 ENCODE_OPTIONS 一致）。
 *     sharp 编不了的（bmp/heic/ico/svg）WARN 后返回原图。⚠️ 行为差异：旧 jimp 能写 bmp，
 *     现在 bmp 不再加水印（sharp 无 bmp 编码器；改存 png 字节会破坏 .bmp 扩展名契约）。
 *  3. **不放大、不重采样**：只做 EXIF 摆正 + 合成 + 同格式重编码。
 *
 * EXIF 方向：`.rotate()`（无参）按 EXIF 摆正像素并**去掉 orientation 标签** —— 与
 * utils/thumbnail.ts、utils/imgResize.ts 的既有 sharp 路径一致。旧 jimp 路径是在**未摆正**
 * 的像素上合成、EXIF 原样带回：手机竖拍照片（orientation=6）的水印会显示在错误角落、
 * 文字横躺。新行为对竖拍照片是可见修复，不是回归。
 *
 * 默认样式 tile：整图无缝斜排平铺（旋转 −26°、白字 opacity 0.12 + 半透明深色阴影的双色调），
 * 裁不掉、"一眼有水印但不破坏观感"。corner / bar 可选（VANBLOG_WATERMARK_STYLE）。
 * 度量公式、样式、env 解析全部在 utils/watermarkSvg.ts（纯函数、全单测）。
 *
 * 字体依赖：SVG <text> 由 libvips 内置的 librsvg+pango+fontconfig 栅格化，**要系统字体**。
 * 官方镜像**已经装了**（Dockerfile runner 阶段 `apk add fontconfig ttf-dejavu wqy-zenhei`，
 * 2026-09 起；实测镜像 860 → 892 MB，`/usr/share/fonts` 28 MB，`fc-list` 0 → 25 条，
 * `fc-match 'WenQuanYi Zen Hei'` → wqy-zenhei.ttc）。源码部署 / 自建镜像仍需要自己装，
 * 所以下面的探测与 WARN 保留：它保护的是"没装字体的那台机器"。
 * ⚠️ 容器实测（node:24-alpine 零字体）：librsvg **不会渲染成空白**，而是满屏 .notdef 豆腐块
 * （'Ag…' 576 ink px、'水' 180 ink px），stderr 只有一句 Fontconfig error 就"成功"返回。
 * 在**装字体之前**的镜像里实测过后果：`example.com` 盖出 20,684 个变化像素、中文 8,170 个，
 * 而且两段不同的中文（'酱油的博客' 与 '鼠标键盘垫'）产出**逐字节相同** —— 铁证是方块不是字。
 * 所以缺字体的降级不能靠"数 ink"，而是逐字符集探测（`Ag`/`水` vs **等码点数**的私用区串逐字节对比）：
 * Latin 探测失败 ⇒ WARN + 原图返回；文本含 CJK 且 CJK 探测失败 ⇒ WARN 点名 wqy-zenhei + 原图返回。
 * **宁可不盖，也不能盖满图豆腐块。** 探测每进程一次（memo），ink 判空只是第二道防线。
 * ⚠️ 探测的比较基准必须与探测文本**码点数相同**：第一版拿 `Ag` 比单个 U+E001，零字体时
 * "两个方块 vs 一个方块"逐字节当然不同 ⇒ latinOk 恒真 ⇒ 照样盖满图方块（镜像内实测
 * changedPx 32,699）。注入探测结果的单测当时全绿 —— 所以 spec 里另有一条**真跑探测**的用例
 * （FONTCONFIG_FILE 指向空配置 + 子进程，因为 fontconfig 在进程内只初始化一次）。
 */

const logger = new Logger('Watermark');

/** sharp 能编码、且上传白名单里真实会出现的格式 → 编码参数（质量口径与 imgResize.ts 一致）。 */
const ENCODE_FORMATS: Record<string, any> = {
  jpeg: { quality: 90 },
  jpg: { quality: 90 },
  png: { compressionLevel: 9 },
  // ⚠️ webp 特意加 effort:2（imgResize 用的是默认 effort:4）：水印这步是**在缩放之前**
  // 按原始尺寸编码的，libwebp q90 在大图上极慢 —— 实测 6918×4617：effort:4 = 24.7s，
  // effort:2 = 4.6s（5.4×），字节只 +2.0%；1920×1440：959→558ms，+0.3%；800×600：191→117ms，−1.2%。
  // imgResize 不需要这个是因为它先缩到 ≤1920 再编码，永远碰不到大图 effort 成本。
  webp: { quality: 90, effort: 2 },
  avif: { quality: 70 },
  tiff: { quality: 90 },
};

/** tile 标记必须放进一块砖：外接宽超过 0.95×step 就缩字号（缩到 8px 还放不下则跳过）。 */
const TILE_EXTENT_FACTOR = 0.95;
const MIN_RENDER_FONT_PX = 8;

/**
 * 短边小于这个像素数的图**不加水印**（原图返回 + WARN）。
 *
 * ⚠️ 这个常量同时是"砖的下限"与"跳过阈值"，两者必须是同一个数，否则代码与日志/文档会各说一套 ——
 * 以前判定写的是 `Math.max(48, minSide - 4)`（⇒ 实际只有 minSide < 48 才跳过），
 * 而 WARN 文案与三份文档都写 52px，中间 48…51px 那段属于"日志说跳过了、其实照盖"。
 * 现在判定与文案都取这一个常量，边界由 `watermark.spec.ts` 钉住（51 跳过 / 52 照盖）。
 *
 * 为什么要跳过而不是硬缩：这么小的图上一块砖只有几十像素，字号会被压到不可读，
 * 盖上去只是"糊一团墨点"，既没有署名效果又毁图；缩略图（默认 300px 宽）不受影响。
 */
export const WATERMARK_MIN_SHORT_SIDE_PX = 52;

/**
 * 小图的砖边长：图比一块砖还小时，把砖缩到图内（单标记居中）。
 * 缩不下（短边 < `WATERMARK_MIN_SHORT_SIDE_PX`）就返回 `null`，调用方据此**跳过水印、原图返回**。
 *
 * 抽成导出函数有两个理由：①阈值判定与 WARN 文案必须同源（见上面的常量注释）；
 * ②退化输入要可测 —— `NaN`/负数/`0`/`Infinity` 都不可能从真实图片的宽高进来，
 * 但一旦有人改了上游的取值逻辑，这里必须**明确拒绝**而不是把 NaN 带进 SVG 尺寸计算
 * （那会让 sharp 抛错，把一次上传变成 500）。宁可不打水印，也不能炸。
 */
export function smallImageTileStep(minSide: number): number | null {
  if (typeof minSide !== 'number' || !Number.isFinite(minSide) || minSide <= 0) {
    return null;
  }
  const step = Math.max(WATERMARK_MIN_SHORT_SIDE_PX, minSide - 4);
  return step > minSide ? null : step;
}

export interface WatermarkOptions {
  /** 显式样式覆盖（优先于 env；非法字段同样回默认，见 resolveWatermarkStyle） */
  style?: Partial<WatermarkStyle>;
  /** 指定 env 来源（默认 process.env；测试注入用） */
  env?: NodeJS.ProcessEnv;
}

export interface WatermarkInk {
  left: number;
  top: number;
  width: number;
  height: number;
  pixels: number;
}

export interface WatermarkOverlay {
  /** PNG（带 alpha）画布；合成输入 */
  buffer: Buffer;
  canvasWidth: number;
  canvasHeight: number;
  /** 实测 ink 包围盒（alpha 超过阈值的像素），定位与断言都靠它 */
  ink: WatermarkInk;
  fontSize: number;
}

export interface GenerateWaterMarkOptions extends WatermarkOptions {
  /** 直接指定字号（默认 64px 参考值，供 spec 断言用） */
  fontSize?: number;
  /** 画布加宽倍数（估计宽度失真时重渲染用） */
  widthFactor?: number;
}

// ---------------------------------------------------------------------------
// 字体覆盖探测（每进程一次；结果 memo 化）
// ---------------------------------------------------------------------------

export interface FontCoverage {
  latinOk: boolean;
  cjkOk: boolean;
}

let coveragePromise: Promise<FontCoverage> | null = null;
let cjkWarned = false;
let latinWarned = false;
let blankWarned = false;

/** 测试钩子：清掉 memo 的探测结果与"只 WARN 一次"标志；可注入固定探测结果。 */
export function __resetWatermarkCachesForTest(forced?: FontCoverage): void {
  coveragePromise = forced === undefined ? null : Promise.resolve(forced);
  cjkWarned = false;
  latinWarned = false;
  blankWarned = false;
}

const LATIN_PROBE_CHAR = 'Ag';
const CJK_PROBE_CHAR = '水';
/** 私用区码点：任何字体都不会给它真字形，只会渲染 .notdef（豆腐块）或空白。 */
const NOTDEF_PROBE_CHAR = '\uE001';

/**
 * 与 `text` **码点数相同**的私用区串，用作"这串到底有没有被真渲染出来"的比较基准。
 *
 * ⚠️ 字数必须对等，否则判据是坏的：零字体时 `Ag` 画成**两个**方块、单个 U+E001 画成**一个**方块，
 * 两者逐字节当然不同 ⇒ 探测会得出"Latin 有字体"，于是照样把满图 .notdef 合成进去。
 * 这不是推理，是**镜像内实测**（`FONTCONFIG_FILE` 指向不含任何字体目录的配置 ⇒ `fc-list` 0 条）：
 * 单字基准下 `latinOk` 仍为 true，Latin 水印盖出 32,699 个变化像素；换成等长基准后正确跳过。
 * CJK 那条一直是单字对单字（`水` vs U+E001），所以它没这个毛病 —— 也正因如此，
 * 单元测试注入 `{latinOk:false}` 时全绿，而真探测在真容器里是错的：**注入探测结果的测试
 * 证明不了探测本身**。下面配了一条真跑探测的用例（`watermark.spec.ts` 的 FONTCONFIG_FILE 那条）。
 *
 * 用 `[...text]` 而不是 `text.length`：代理对（emoji、CJK 扩展 B）是一个码点、两个 UTF-16 单元。
 */
export function notdefComparatorFor(text: string): string {
  return NOTDEF_PROBE_CHAR.repeat([...String(text ?? '')].length);
}

async function renderProbeRaw(sharp: any, text: string): Promise<Buffer | null> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="72">` +
    `<text x="12" y="58" font-family="${DEFAULT_WATERMARK_FONT_FAMILY}" font-size="48" fill="#ffffff">${text}</text>` +
    `</svg>`;
  const { data } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data as Buffer;
}

/**
 * 系统字体能不能渲染 Latin / CJK：分别比较 `Ag`、`水` 与**等码点数**的私用区串的栅格结果。
 * 有对应字体 ⇒ 真字形 ≠ .notdef/空白；没有 ⇒ 两者逐字节相等（同为豆腐块或同为空白）。
 *
 * ⚠️ 为什么不能只"数 ink 像素"：**实测（node:24-alpine 容器，零字体）librsvg/pango
 * 会把文字渲染成 .notdef 豆腐块而不是空白** —— 'Ag…' 576 ink px、'水' 180 ink px、
 * stderr 打一句 `Fontconfig error: Cannot load default config file` 然后"成功"返回。
 * 只数像素会把满图豆腐块当成"水印成功"合成进图片（比不加水印更糟的静默失败）。
 * 豆腐块与真汉字的 ink **数量**也是重叠区间（48px 豆腐块 36px ink vs 真字 300+），
 * 数量阈值分不开；同字体下 `水` 与 U+E001 的**逐字节相等**才是可靠判据。
 */
export async function probeFontCoverage(sharp: any): Promise<FontCoverage> {
  try {
    const [latin, cjk, latinNotdef, cjkNotdef] = await Promise.all([
      renderProbeRaw(sharp, LATIN_PROBE_CHAR),
      renderProbeRaw(sharp, CJK_PROBE_CHAR),
      renderProbeRaw(sharp, notdefComparatorFor(LATIN_PROBE_CHAR)),
      renderProbeRaw(sharp, notdefComparatorFor(CJK_PROBE_CHAR)),
    ]);
    if (!latin || !cjk || !latinNotdef || !cjkNotdef) {
      return { latinOk: false, cjkOk: false };
    }
    return { latinOk: !latin.equals(latinNotdef), cjkOk: !cjk.equals(cjkNotdef) };
  } catch {
    return { latinOk: false, cjkOk: false };
  }
}

function getFontCoverage(sharp: any): Promise<FontCoverage> {
  if (!coveragePromise) {
    coveragePromise = probeFontCoverage(sharp);
  }
  return coveragePromise;
}

const FONT_INSTALL_HINT =
  'Alpine 镜像请在 runner 阶段安装：apk add --no-cache fontconfig ttf-dejavu wqy-zenhei' +
  '（Debian/Ubuntu: apt-get install fontconfig fonts-dejavu fonts-wqy-zenhei）。' +
  `期望的 font-family 链：${DEFAULT_WATERMARK_FONT_FAMILY}`;

function warnNoFonts(): void {
  if (latinWarned) {
    return;
  }
  latinWarned = true;
  logger.warn(
    '[watermark] 系统没有可用字体：SVG 文字只会渲染成 .notdef 豆腐块（实测零字体容器如此），' +
      `已跳过水印、按原图返回（上传不受影响）。${FONT_INSTALL_HINT}`,
  );
}

function warnCjkFontMissing(): void {
  if (cjkWarned) {
    return;
  }
  cjkWarned = true;
  logger.warn(
    '[watermark] 水印文字含 CJK，但系统没有能渲染汉字的字体（探测字 "水" 与 .notdef 逐字节相同），' +
      `已跳过水印、按原图返回（上传不受影响）——宁可不盖，也不能盖满图豆腐块。${FONT_INSTALL_HINT}`,
  );
}

function warnBlankRender(reason: string): void {
  if (blankWarned) {
    return;
  }
  blankWarned = true;
  logger.warn(
    `[watermark] ${reason} —— 水印文字未渲染出任何像素，按原图返回（上传不受影响）。` +
      FONT_INSTALL_HINT,
  );
}

// ---------------------------------------------------------------------------
// 栅格化辅助
// ---------------------------------------------------------------------------

interface RawCanvas {
  data: Buffer;
  width: number;
  height: number;
}

async function rasterizeSvgRaw(sharp: any, svg: string): Promise<RawCanvas> {
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: data as Buffer, width: info.width, height: info.height };
}

/**
 * 渲染"带字/不带字"两份同画布 SVG，逐字节对比判定文字是否真的画出来了。
 * 返回带字版本的 raw（ink 扫描继续用它）。两份栅格化都是确定性输出，
 * 没有字体时两份完全一致（底板/渐变条照画，文字零像素）。
 */
async function rasterizeWithTextCheck(
  sharp: any,
  svgFull: string,
  svgNoText: string,
): Promise<{ raw: RawCanvas; hasText: boolean }> {
  const [full, bare] = await Promise.all([
    rasterizeSvgRaw(sharp, svgFull),
    rasterizeSvgRaw(sharp, svgNoText),
  ]);
  const hasText =
    full.width !== bare.width || full.height !== bare.height || !full.data.equals(bare.data);
  return { raw: full, hasText };
}

/** alpha 超过阈值的 ink 统计（单趟：像素数 + 包围盒）。画布都是标记级小图，JS 扫描 ~ms。 */
export function scanInk(raw: RawCanvas | { data: Buffer; width: number; height: number }, alphaThreshold = 2): WatermarkInk {
  const { data, width, height } = raw;
  let pixels = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0, idx = 3; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, idx += 4) {
      if (data[idx] > alphaThreshold) {
        pixels += 1;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (pixels === 0) {
    return { left: 0, top: 0, width: 0, height: 0, pixels: 0 };
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1, pixels };
}

/**
 * corner 画布的 ink 扫描阈值取 8：底板径向渐变的最外圈 alpha≈1–8（肉眼不可见），
 * 用它算包围盒会让 margin 定位到"看不见的雾边"上，还会在小画布上误判 ink 贴边。
 */
const CORNER_INK_THRESHOLD = 8;

// ---------------------------------------------------------------------------
// generateWaterMark：渲染"一个文字标记"（corner 底板画布）→ PNG + 实测 ink 盒
// ---------------------------------------------------------------------------

/**
 * 旧版返回 jimp 对象（500×150 固定画布）；新版返回 PNG 画布 + ink 统计（WatermarkOverlay）。
 * watermark.spec.ts 的旧断言（能渲染、单行、域名比短词宽、ink>1000px）都按新返回类型保留。
 * 渲染空白（没字体）时返回 **null** 并 WARN —— 调用方必须处理。
 */
export async function generateWaterMark(
  waterMark: string,
  options: GenerateWaterMarkOptions = {},
): Promise<WatermarkOverlay | null> {
  const sharp: any = tryLoadSharp();
  if (!sharp) {
    logger.warn('[watermark] sharp 不可用（no-engine），无法渲染水印标记');
    return null;
  }
  const style = resolveWatermarkStyle(
    { style: 'corner', ...options.style },
    options.env || process.env,
  );
  const text = withCopyrightPrefix(normalizeWatermarkText(waterMark));
  if (!text) {
    return null;
  }
  // 与 addWaterMarkToIMG 同一道字体防线：缺字体时返回 null（而不是豆腐块画布）
  const coverage = await getFontCoverage(sharp);
  if (!coverage.latinOk) {
    warnNoFonts();
    return null;
  }
  if (containsCjk(text) && !coverage.cjkOk) {
    warnCjkFontMissing();
    return null;
  }
  const fontSize = clampInt(options.fontSize ?? 64, 4, 4096);
  let widthFactor = options.widthFactor ?? 1;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const full = buildCornerSvg(text, fontSize, style, widthFactor, true);
    const bare = buildCornerSvg(text, fontSize, style, widthFactor, false);
    const { raw, hasText } = await rasterizeWithTextCheck(sharp, full.svg, bare.svg);
    if (!hasText) {
      warnBlankRender(`文字 "${text.slice(0, 32)}" 在 ${fontSize}px 下`);
      return null;
    }
    const ink = scanInk(raw, CORNER_INK_THRESHOLD);
    const touchesEdge =
      ink.left <= 0 ||
      ink.top <= 0 ||
      ink.left + ink.width >= full.canvasWidth ||
      ink.top + ink.height >= full.canvasHeight;
    if (touchesEdge) {
      // 估计宽度偏小导致 ink 贴边（字可能被裁）→ 画布加宽重渲染
      widthFactor *= 1.6;
      continue;
    }
    const buffer: Buffer = await sharp(Buffer.from(full.svg), { density: 72 }).png().toBuffer();
    return {
      buffer,
      canvasWidth: full.canvasWidth,
      canvasHeight: full.canvasHeight,
      ink,
      fontSize,
    };
  }
  warnBlankRender('文本宽度估计连续 4 次失真（ink 贴画布边）');
  return null;
}

// ---------------------------------------------------------------------------
// addWaterMarkToIMG：公共接缝
// ---------------------------------------------------------------------------

function outputFormatFor(meta: any, srcImage: Buffer): string | null {
  const format = String(meta?.format || '').toLowerCase();
  if (format === 'heif') {
    // AVIF 也是 heif 容器：ftyp 里带 avif 才能用 sharp 的 avif 编码器写回；真 HEIC 编不了
    return isAvifBuffer(srcImage) ? 'avif' : null;
  }
  if (format === 'jpg') {
    return 'jpeg';
  }
  return ENCODE_FORMATS[format] ? format : null;
}

async function compositeTile(
  sharp: any,
  srcImage: Buffer,
  text: string,
  width: number,
  height: number,
  style: WatermarkStyle,
  format: string,
): Promise<Buffer | null> {
  const metrics = tileMetrics(width, height, style);
  let step = metrics.step;
  // 小图适配：图比一块砖还小时，砖缩到图内（单标记居中）；短边小于
  // WATERMARK_MIN_SHORT_SIDE_PX 的图直接跳过（判定在 smallImageTileStep 里，与常量同源）。
  const minSide = Math.min(width, height);
  if (step > minSide) {
    const shrunk = smallImageTileStep(minSide);
    if (shrunk === null) {
      logger.warn(
        `[watermark] 图片过小（短边 ${minSide}px < ${WATERMARK_MIN_SHORT_SIDE_PX}px），无法排版水印，按原图返回`,
      );
      return null;
    }
    step = shrunk;
  }
  let fontSize = metrics.fontSize;
  const maxExtent = step * TILE_EXTENT_FACTOR;
  let extent = rotatedMarkExtent(text, fontSize);
  if (extent > maxExtent) {
    fontSize = Math.max(MIN_RENDER_FONT_PX, Math.floor((fontSize * maxExtent) / extent));
    extent = rotatedMarkExtent(text, fontSize);
  }
  if (extent > step) {
    logger.warn(
      `[watermark] 水印文字过长（${Array.from(text).length} 码点），${fontSize}px 下外接宽 ` +
        `${Math.round(extent)}px 仍超出砖宽 ${step}px，按原图返回`,
    );
    return null;
  }
  const { svg } = buildTileSvg(text, fontSize, step, style);
  // tile 画布上只有文字（无底板/渐变），scanInk 就能判定"字有没有画出来"
  const raw = await rasterizeSvgRaw(sharp, svg);
  const ink = scanInk(raw);
  if (ink.pixels === 0) {
    warnBlankRender(`tile 样式在 ${fontSize}px 下`);
    return null;
  }
  const tilePng: Buffer = await sharp(Buffer.from(svg), { density: 72 }).png().toBuffer();
  // ⚠️ tile:true 由 libvips 原生重复这块 step×step 的小砖（≤640²，≈1.6MB RGBA），
  //    不是先展开成整图覆盖层 —— 6918×4617 的整图 RGBA 覆盖层要 ~128MB，那是被明确否掉的实现。
  // ⚠️ 必须显式 top:0/left:0：sharp 0.35 实测 tile:true 且省略 top/left 时砖格锚点会偏移
  //    （1920×1280 上标记中心从 (179,179) 漂到 ~(173,192) 且窗口内混入相邻标记），
  //    显式给 (0,0) 后砖格与标记位置和 tile 栅格逐像素一致（watermark.spec 的周期性断言钉住）。
  return sharp(srcImage)
    .rotate()
    .composite([{ input: tilePng, tile: true, top: 0, left: 0, blend: 'over' }])
    .toFormat(format, ENCODE_FORMATS[format])
    .toBuffer();
}

async function renderCornerOverlay(
  sharp: any,
  text: string,
  fontSize: number,
  style: WatermarkStyle,
  imgWidth: number,
  imgHeight: number,
): Promise<WatermarkOverlay | null> {
  const margin = Math.max(1, Math.round(Math.min(imgWidth, imgHeight) * style.marginRatio * style.scale));
  const availW = Math.max(16, imgWidth - 2 * margin);
  const availH = Math.max(16, imgHeight - 2 * margin);
  let fs = fontSize;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let widthFactor = 1;
    let overlay: WatermarkOverlay | null = null;
    for (let widen = 0; widen < 4; widen += 1) {
      const full = buildCornerSvg(text, fs, style, widthFactor, true);
      const bare = buildCornerSvg(text, fs, style, widthFactor, false);
      const { raw, hasText } = await rasterizeWithTextCheck(sharp, full.svg, bare.svg);
      if (!hasText) {
        warnBlankRender(`corner 样式在 ${fs}px 下`);
        return null;
      }
      const ink = scanInk(raw, CORNER_INK_THRESHOLD);
      const touchesEdge =
        ink.left <= 0 ||
        ink.top <= 0 ||
        ink.left + ink.width >= full.canvasWidth ||
        ink.top + ink.height >= full.canvasHeight;
      if (touchesEdge) {
        widthFactor *= 1.6;
        continue;
      }
      const buffer: Buffer = await sharp(Buffer.from(full.svg), { density: 72 }).png().toBuffer();
      overlay = {
        buffer,
        canvasWidth: full.canvasWidth,
        canvasHeight: full.canvasHeight,
        ink,
        fontSize: fs,
      };
      break;
    }
    if (!overlay) {
      warnBlankRender('corner 画布连续加宽后 ink 仍贴边');
      return null;
    }
    if (overlay.ink.width <= availW && overlay.ink.height <= availH) {
      return overlay;
    }
    const factor = Math.min(availW / overlay.ink.width, availH / overlay.ink.height);
    const next = Math.max(MIN_RENDER_FONT_PX, Math.floor(fs * factor));
    if (next >= fs) {
      logger.warn('[watermark] corner 水印在最小字号下仍放不下这张图，按原图返回');
      return null;
    }
    fs = next;
  }
  return null;
}

async function compositeCorner(
  sharp: any,
  srcImage: Buffer,
  text: string,
  width: number,
  height: number,
  style: WatermarkStyle,
  format: string,
): Promise<Buffer | null> {
  const metrics = cornerMetrics(width, height, style);
  const overlay = await renderCornerOverlay(sharp, text, metrics.fontSize, style, width, height);
  if (!overlay) {
    return null;
  }
  // 以**实测 ink 盒**对到角上（画布透明 pad 不参与定位），margin 从 min(w,h) 派生
  const point = watermarkCornerPoint(
    style.position,
    width,
    height,
    overlay.ink.width,
    overlay.ink.height,
    metrics.margin,
  );
  const left = point.left - overlay.ink.left;
  const top = point.top - overlay.ink.top;
  return sharp(srcImage)
    .rotate()
    .composite([{ input: overlay.buffer, left, top, blend: 'over' }])
    .toFormat(format, ENCODE_FORMATS[format])
    .toBuffer();
}

async function compositeBar(
  sharp: any,
  srcImage: Buffer,
  text: string,
  width: number,
  height: number,
  style: WatermarkStyle,
  format: string,
): Promise<Buffer | null> {
  const metrics = barMetrics(width, height, style);
  let fs = metrics.fontSize;
  const avail = Math.max(16, width - 2 * metrics.margin);
  const est = estimateTextWidthPx(text, fs, letterSpacingFor(fs));
  if (est > avail) {
    fs = Math.max(MIN_RENDER_FONT_PX, Math.floor((fs * avail) / est));
  }
  const barOpts = {
    text,
    width,
    barHeight: metrics.barHeight,
    fontSize: fs,
    margin: metrics.margin,
    style,
  };
  const full = buildBarSvg(barOpts);
  const bare = buildBarSvg({ ...barOpts, withText: false });
  const { hasText } = await rasterizeWithTextCheck(sharp, full.svg, bare.svg);
  if (!hasText) {
    warnBlankRender(`bar 样式在 ${fs}px 下`);
    return null;
  }
  const barPng: Buffer = await sharp(Buffer.from(full.svg), { density: 72 }).png().toBuffer();
  const top = style.position.startsWith('top') ? 0 : Math.max(0, height - full.canvasHeight);
  return sharp(srcImage)
    .rotate()
    .composite([{ input: barPng, left: 0, top, blend: 'over' }])
    .toFormat(format, ENCODE_FORMATS[format])
    .toBuffer();
}

export async function addWaterMarkToIMG(
  srcImage: Buffer,
  waterMarkText: string,
  options: WatermarkOptions = {},
): Promise<Buffer> {
  const env = options.env || process.env;
  try {
    if (!srcImage || !srcImage.length) {
      return srcImage;
    }
    const text = withCopyrightPrefix(normalizeWatermarkText(waterMarkText));
    if (!text) {
      return srcImage;
    }
    const sharp: any = tryLoadSharp();
    if (!sharp) {
      logger.warn('[watermark] sharp 不可用（no-engine），按原图返回');
      return srcImage;
    }
    const style = resolveWatermarkStyle(options.style, env);

    // 字体覆盖探测（每进程一次，~15ms）：缺字体时**宁可不盖也不能盖豆腐块** ——
    // 实测零字体容器里 librsvg/pango 会把所有字画成 .notdef 方块（不是空白），
    // 所以这里必须逐字符集探测，失败就 WARN + 原图返回。见 probeFontCoverage 的注释。
    const coverage = await getFontCoverage(sharp);
    if (!coverage.latinOk) {
      warnNoFonts();
      return srcImage;
    }
    if (containsCjk(text) && !coverage.cjkOk) {
      warnCjkFontMissing();
      return srcImage;
    }

    const meta = await sharp(srcImage).metadata();
    const orientation = Number(meta?.orientation) || 1;
    const swapped = orientation >= 5 && orientation <= 8;
    const width = Number(swapped ? meta?.height : meta?.width) || 0;
    const height = Number(swapped ? meta?.width : meta?.height) || 0;
    if (!width || !height) {
      logger.warn('[watermark] 无法读取图片尺寸（decode-failed），按原图返回');
      return srcImage;
    }
    const format = outputFormatFor(meta, srcImage);
    if (!format) {
      logger.warn(
        `[watermark] 格式 "${meta?.format || 'unknown'}" 无 sharp 编码器（支持 jpeg/png/webp/avif/tiff），按原图返回`,
      );
      return srcImage;
    }

    let out: Buffer | null = null;
    if (style.style === 'tile') {
      out = await compositeTile(sharp, srcImage, text, width, height, style, format);
    } else if (style.style === 'bar') {
      out = await compositeBar(sharp, srcImage, text, width, height, style, format);
    } else {
      out = await compositeCorner(sharp, srcImage, text, width, height, style, format);
    }
    if (!out) {
      // 具体原因（空白渲染/文字过长/放不下）已在各自的 WARN 里点名
      return srcImage;
    }
    return out;
  } catch (err) {
    logger.warn(
      `[watermark] 可见水印失败，按原图继续：${String((err as Error)?.message || err).slice(0, 200)}`,
    );
    return srcImage;
  }
}
