/**
 * 图片像素上限，以及让 sharp 的**库级**解码上限与它对齐的唯一入口。
 *
 * 单独放一个叶子模块（不 import 任何业务文件）是为了避免循环依赖：
 * `uploadLimits.ts` 要 import `avif.ts`（`isAvifBuffer`），而 `avif.ts` 需要这里的常量，
 * 所以常量必须住在两边都依赖不到的地方。
 *
 * ## 为什么是 40MP
 *
 * 解码后的位图是 `像素数 × 4` 字节（RGBA），40MP ≈ **160MB 一份**；而上传管线会同时持有
 * 好几份副本（大图缩放、可见水印、隐写水印、webp/avif 编码、缩略图各一份），单次上传的
 * 峰值内存是它的数倍。`UV_THREADPOOL_SIZE=16` 意味着最多 16 路并行解码。
 * ⇒ 这个上限本质上是**内存预算**，不是画质标准。
 *
 * 40MP 覆盖 8K（7680×4320 ≈ 33MP）与绝大多数用于网络发布的照片。更高像素的相机原片
 * （45MP / 61MP）会被拒 —— 而这类图上传后本来也会被 `utils/imgResize.ts` 按长边 1920
 * 等比缩小，所以损失的是"原图全分辨率留档"，不是页面观感。要放开就改这一个常量
 * （sharp 的上限会跟着走），别在两处各写一个数。
 *
 * ⚠️ 原来是 100MP：解码后约 **400MB 一份**。配合 50MB 的上传体积上限，
 * 一张几十 KB 的纯色 PNG 就能**声明** 100MP（文件体积与像素数无关），
 * 而 `POST /api/admin/img/upload` 在 `types/access/access.ts` 的 publicRoutes 里
 * ⇒ 最低权限的协作者也能触发。这是纵深防御：不是当前可利用的洞，
 * 但"一次请求吃掉半个 G 堆内存、还能开 16 路"不该是默认允许的形状。
 *
 * ## 为什么 sharp 那边也必须设
 *
 * 业务侧的像素检查靠 `image-size` 读文件头，而**读不出尺寸时会跳过这项检查**
 * （见 `uploadLimits.assertUploadedImage` 里 avif 的兜底分支：`meta = { type: 'avif' }`，
 * 没有 width/height ⇒ `pixels` 算成 0 ⇒ 直接放行）。这时唯一的兜底就是 sharp 自己的
 * `limitInputPixels`，而它的默认值是 **268402689（≈268MP）**，比业务上限宽 6.7 倍。
 * 留一个比业务上限更宽的库级兜底，等于在"业务检查失效"的那条路上没有兜底。
 */

/** 业务侧像素上限（`assertUploadedImage` 用），同时也是 sharp 的解码上限。 */
export const MAX_IMAGE_PIXELS = 40_000_000;

/**
 * 传给 sharp 构造函数的 `limitInputPixels`。**故意与 `MAX_IMAGE_PIXELS` 同源**：
 * 两个数一旦分家，宽的那个就是实际上限。
 */
export const SHARP_LIMIT_INPUT_PIXELS = MAX_IMAGE_PIXELS;

/** sharp 默认 `limitInputPixels`（0.35.x）：留着当对照，守卫会钉住"我们的值不大于它"。 */
export const SHARP_DEFAULT_LIMIT_INPUT_PIXELS = 268_402_689;

/** sharp 构造函数的第二个参数里我们用到的那部分（不是 sharp 的完整选项集）。 */
export interface SharpInputLimits {
  limitInputPixels?: number;
  density?: number;
  animated?: boolean;
  failOn?: string;
  /** 隐写水印回写时喂进去的裸 RGBA（宽高通道已知，见 stegoWatermark.ts）。 */
  raw?: { width: number; height: number; channels: number };
}

/**
 * 构造 sharp 实例时用的选项：把像素上限钉进去，并允许调用方追加自己的选项
 * （例如 `sharpInputOptions({ density: 72 })`）。
 *
 * ⚠️ 追加的选项**不许**覆盖 `limitInputPixels` —— 覆盖就回到"库级兜底比业务上限宽"，
 * 所以这里显式把它放在展开之后。
 */
export function sharpInputOptions<T extends SharpInputLimits = SharpInputLimits>(
  extra?: T,
): T & { limitInputPixels: number } {
  return { ...(extra || ({} as T)), limitInputPixels: SHARP_LIMIT_INPUT_PIXELS };
}
