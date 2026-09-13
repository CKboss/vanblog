/**
 * 从正文里取第一张图片，用来给列表卡当缩略图。
 *
 * 为什么需要：本站 53 篇文章**一张 cover 都没设**，而 Apple 皮肤的列表页是
 * 「纯白底 + 发丝线 + 灰字」，没有图就只剩黑白灰 —— 观感非常单调。
 * 用正文首图当封面是零成本的补法（作者不用去后台逐篇上传封面）。
 */

const FENCE_RE = /(^|\n)\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\s{0,3}\2[^\n]*|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*?(?<![-\w])src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** 把代码区涂成等长占位，避免把教程里的示例图片当成真图 */
function maskCode(source: string): string {
  return source
    .replace(FENCE_RE, (m) => "\u0000".repeat(m.length))
    .replace(INLINE_CODE_RE, (m) => "\u0000".repeat(m.length));
}

/** 只接受 http(s)、协议相对与本站 /static 路径；data: 与相对路径一律不要 */
export function isUsableImageUrl(url: string): boolean {
  if (!url) return false;
  if (/^data:/i.test(url)) return false;
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith("//")) return true;
  return url.startsWith("/static/");
}

/**
 * 本站图床的图优先换成 300px 缩略图（`<static>/img/thumb/<同名>.webp`，见 §7.5）：
 * 列表页一屏十几张图，用原图（长边 1920 的 webp，动辄几百 KB）太浪费。
 * 缩略图可能不存在（老图没跑过「补缩略图」），所以调用方要配 onError 回退。
 */
export function toThumbnailUrl(src: string): string {
  if (!src.startsWith("/static/img/")) return src;
  if (src.startsWith("/static/img/thumb/")) return src;
  return `/static/img/thumb/${src.slice("/static/img/".length)}`;
}

export function firstImageOfMarkdown(content: string | null | undefined): string | null {
  const text = String(content ?? "");
  if (!text) return null;
  const masked = maskCode(text);

  const scan = (re: RegExp, pick: (m: RegExpExecArray) => string): string | null => {
    re.lastIndex = 0;
    let best: { index: number; url: string } | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      // 用偏移量回原文取真实 URL（masked 里是占位符）
      const raw = text.slice(m.index, m.index + m[0].length);
      const exact = new RegExp(re.source, re.flags.replace("g", "")).exec(raw);
      const url = exact ? pick(exact).trim() : "";
      if (url && isUsableImageUrl(url) && (!best || m.index < best.index)) {
        best = { index: m.index, url };
      }
      if (best && best.index <= m.index) {
        // 已经拿到更靠前的可用图，后面的不用再看
        break;
      }
    }
    return best ? best.url : null;
  };

  const fromMarkdown = scan(MD_IMAGE_RE, (m) => m[1] || "");
  const fromHtml = scan(HTML_IMAGE_RE, (m) => m[1] || m[2] || m[3] || "");
  if (fromMarkdown && fromHtml) {
    return text.indexOf(fromMarkdown) <= text.indexOf(fromHtml) ? fromMarkdown : fromHtml;
  }
  return fromMarkdown || fromHtml;
}

/**
 * 列表卡的缩略图地址：有 cover 用 cover，否则用正文首图；本站图床的换成缩略图。
 * 返回 null 表示这张卡不显示图（版面保持原样，不留空框）。
 */
export function listCardImage(
  cover: string | null | undefined,
  content: string | null | undefined,
): { src: string; fallback: string | null } | null {
  const raw = String(cover ?? "").trim() || firstImageOfMarkdown(content);
  if (!raw || !isUsableImageUrl(raw)) return null;
  const thumb = toThumbnailUrl(raw);
  return { src: thumb, fallback: thumb === raw ? null : raw };
}
