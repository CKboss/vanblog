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

/**
 * 从文章对象里取缩略图的 AVIF 地址（可选契约，server 侧 `VANBLOG_THUMB_AVIF` 默认关）。
 *
 * ⚠️ server 的**最终契约把字段嵌在 `meta.thumbAvif`**（静态项 meta 子对象，伴生
 * `meta.thumbAvifBytes`），不是顶层 `thumbAvif`。这里两个位置都认、meta 优先：
 * 只读顶层的话，字段上线那天 <picture> 也永远不会出现，而「缺失 = 输出不变」的保证
 * 会让所有测试继续绿 —— 可选字段最坏的失败方式就是"存在但没被读到"，所以
 * __tests__/readingTimeUi.spec.ts 用**带 meta.thumbAvif 的向量**钉住读取路径
 * （那条测试在"字段存在却没被读"时必须红）。
 *
 * 只接受可用 URL（isUsableImageUrl 同一口径）；缺失/非法一律 null，
 * ListThumb 收到 null 时渲染输出与没有这个契约时逐字节一致（有金标对照测试）。
 */
export function articleThumbAvif(source: unknown): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }
  const s = source as {
    thumbAvif?: unknown;
    meta?: { thumbAvif?: unknown } | null;
  };
  for (const cand of [s.meta?.thumbAvif, s.thumbAvif]) {
    if (typeof cand === "string") {
      const t = cand.trim();
      if (t && isUsableImageUrl(t)) {
        return t;
      }
    }
  }
  return null;
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
 *
 * `serverFirstImage`：列表接口带 withExcerpt 时 server 已经算好的「正文首图」
 * （server 用 pickCoverFromContent(content, {preferLocal:false})，取值规则与这里的
 * firstImageOfMarkdown 一致，对照测试见 __tests__/articleExcerptParity.spec.ts）。
 * 给了它就不用再扫正文 —— 那种响应里 content 已被剥掉，本地根本扫不到；
 * 没给（老缓存页 / 文章页）就照旧从 content 里找。
 */
export function listCardImage(
  cover: string | null | undefined,
  content: string | null | undefined,
  serverFirstImage?: string | null,
  thumbAvif?: string | null,
): { src: string; fallback: string | null; avif?: string } | null {
  const firstImage =
    serverFirstImage != null ? String(serverFirstImage).trim() : null;
  const raw =
    String(cover ?? "").trim() ||
    (firstImage != null ? firstImage : firstImageOfMarkdown(content));
  if (!raw || !isUsableImageUrl(raw)) return null;
  const thumb = toThumbnailUrl(raw);
  const out: { src: string; fallback: string | null; avif?: string } = {
    src: thumb,
    fallback: thumb === raw ? null : raw,
  };
  // AVIF 可选契约（article.thumbAvif，server 可能不发）：只在**选中的图就是 server 首图**
  // 且地址可用时才带上 —— cover 胜出时 thumbAvif 不是那张图的 AVIF 版本，混用会让
  // <picture> 的 <source> 与 <img> 显示两张不同的图。
  // 字段缺失时返回对象**不含 avif 键**：ListThumb 的输出与没有这个契约时逐字节一致
  // （旧断言 toEqual({src,fallback}) 也正是靠这一点保持绿色，没有为它放宽任何既有钉子）。
  const avif =
    firstImage && raw === firstImage ? String(thumbAvif ?? "").trim() : "";
  if (avif && isUsableImageUrl(avif)) {
    out.avif = avif;
  }
  return out;
}
