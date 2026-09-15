import { visit } from "unist-util-visit";
import { BytemdPlugin } from "bytemd";
import m from "medium-zoom"
import { STATIC_THUMB_PREFIX, STATIC_IMG_PREFIX } from "../../utils/excerptThumbs";

/** 缩略图地址 → 原图地址（列表摘要用的是缩略图，点开放大要看原图） */
export function fullSizeOfThumb(src: string): string | null {
  const raw = String(src ?? "");
  if (!raw.startsWith(STATIC_THUMB_PREFIX)) return null;
  const name = raw.slice(STATIC_THUMB_PREFIX.length);
  if (!name || name.includes("/")) return null;
  return `${STATIC_IMG_PREFIX}${name}`;
}

const ImgZoomPlugin = () => (tree) => {
  visit(tree, (node) => {
    if (node.type === "element" && node.tagName === "img") {
      // className 可能不存在，直接 += 会得到 "undefined img-zoom"
      const prev = Array.isArray(node.properties.className)
        ? node.properties.className.join(" ")
        : String(node.properties.className ?? "");
      node.properties.className = `${prev} img-zoom`.trim()
      // 正文图片一律懒加载 + 异步解码：首屏不被下面的图拖住，解码也不卡主线程
      if (!node.properties.loading) node.properties.loading = "lazy"
      if (!node.properties.decoding) node.properties.decoding = "async"
      // 列表摘要里用的是 300px 缩略图（见 utils/excerptThumbs.ts）：
      // 补一个 data-zoom-src 指回原图，medium-zoom 会用这个地址放大，
      // 所以「省流量」和「点开看大图」两件事不冲突。
      // ⚠️ 这个属性必须在 rehype 插件里加：sanitize 在插件之前跑，
      //    写在 markdown 里的 data-* 会被 rehype-sanitize 直接删掉。
      const src = node.properties.src
      const full = typeof src === "string" ? fullSizeOfThumb(src) : null
      if (full && !node.properties.dataZoomSrc) {
        node.properties.dataZoomSrc = full
      }
    }
  })
}

export function Img(): BytemdPlugin {
  return {
    rehype: (processor) => processor.use(ImgZoomPlugin),
    viewerEffect: ({ markdownBody }) => {
      markdownBody.querySelectorAll(".img-zoom").forEach((img: HTMLImageElement) => {
        if (img.getAttribute("data-zoomed")) return
        img.setAttribute("data-zoomed", "true")
        // 老图片可能没生成过缩略图（图床里有原图、thumb/ 下没有）：
        // 加载失败就换回原图，别让列表卡片上出现一个破图标。
        const full = img.getAttribute("data-zoom-src")
        if (full && img.getAttribute("src") !== full) {
          img.addEventListener(
            "error",
            () => {
              img.removeAttribute("data-zoom-src")
              img.src = full
            },
            { once: true },
          )
        }
        m(img)
      })
    }
  }
}
