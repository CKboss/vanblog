/**
 * 列表卡片的摘要里，把图床原图换成缩略图。
 *
 * 为什么：摘要只有 200 字，但里面的图片是**原图**。实测首页一个摘要里就嵌了
 * 一张 3.5MB 和一张 1.08MB 的 webp，而后者对应的 300px 缩略图只有 8KB（差 133 倍），
 * 并且同一张图的缩略图还被卡片右侧的 ListThumb 单独请求了一次 —— 也就是一张图下载两遍，
 * 一遍 8KB、一遍 1MB。`loading="lazy"` 只是把它推迟到滚动时，并没有省掉。
 *
 * 只改列表摘要（PostCard 的 overview 分支），**文章页正文一律保持原图** ——
 * 读者点开文章就是要看大图的。
 *
 * 点开放大不受影响：`components/Markdown/img.tsx` 会给 `/static/img/thumb/` 下的图
 * 补一个 `data-zoom-src` 指回原图，medium-zoom 支持这个属性；缩略图万一不存在
 * （老图片没补过缩略图），那边的 viewerEffect 会在 error 时换回原图。
 */
export const STATIC_IMG_PREFIX = "/static/img/";
export const STATIC_THUMB_PREFIX = "/static/img/thumb/";

/** 把一个图床地址换成它的缩略图地址；已经是缩略图、或者不是本站图床的就原样返回。 */
export function toThumbPath(src: string): string {
  const raw = String(src ?? "");
  if (!raw.startsWith(STATIC_IMG_PREFIX)) {
    return raw;
  }
  if (raw.startsWith(STATIC_THUMB_PREFIX)) {
    return raw;
  }
  const rest = raw.slice(STATIC_IMG_PREFIX.length);
  // 只处理"图床根目录下的文件"，别的子目录（例如自定义页面的资源）不动
  if (!rest || rest.includes("/") || rest.includes("?") || rest.includes("#")) {
    return raw;
  }
  return `${STATIC_THUMB_PREFIX}${rest}`;
}

/**
 * 把一段 markdown（摘要）里的本站图床图片都换成缩略图。
 * 同时处理两种写法：`![alt](src)` 与内联 HTML `<img src="src">`。
 */
export function withThumbnailImages(markdown: string): string {
  const text = String(markdown ?? "");
  if (!text.includes(STATIC_IMG_PREFIX)) {
    return text;
  }
  return text
    .replace(/(!\[[^\]]*\]\()([^)\s]+)(\s*["'][^)]*)?(\))/g, (all, head, src, title, tail) => {
      const next = toThumbPath(src);
      return next === src ? all : `${head}${next}${title || ""}${tail}`;
    })
    .replace(/(<img\b[^>]*?\bsrc=["'])([^"']+)(["'])/gi, (all, head, src, tail) => {
      const next = toThumbPath(src);
      return next === src ? all : `${head}${next}${tail}`;
    });
}
