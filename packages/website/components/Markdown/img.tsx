import { visit } from "unist-util-visit";
import { BytemdPlugin } from "bytemd";
import m from "medium-zoom"
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
        m(img)
      })
    }
  }
}
