import { extractImageRefs } from './transferRemoteImages';

/**
 * 从正文里挑一张图当封面。
 *
 * 为什么需要：本站 53 篇文章**一张 cover 都没设**，前台列表页因此几乎没有图。
 * 与其在前台生成"渐变占位封面"这种假图（颜色不承载任何信息、还假装自己是缩略图），
 * 不如把真实的首图**写进 cover 字段** —— 一次性、可见、可撤销，作者之后也能在后台改。
 *
 * 取值规则与前台列表缩略图（packages/website/utils/firstImage.ts）保持一致：
 * **文档顺序里的第一张可用图**，这样封面和列表缩略图不会是两张不同的图。
 * `extractImageRefs` 已经屏蔽了代码块与行内代码，所以教程里的 `![示例](…)` 不会被选中。
 */
export function isUsableCoverUrl(url: unknown): boolean {
  const value = String(url ?? '').trim();
  if (!value || value.length > 2000) {
    return false;
  }
  // data: URI 一张就几十 KB，写进 cover 会让每次列表查询都拖着它跑
  if (/^data:/i.test(value)) {
    return false;
  }
  if (/^https?:\/\//i.test(value)) {
    return true;
  }
  if (value.startsWith('//')) {
    return true;
  }
  return value.startsWith('/static/');
}

/**
 * @param preferLocal 优先本站图床（`/static/…`）的图。默认开：外链首图随时可能失效
 *   （防盗链、CDN 下线、仓库改名），而且会把访客的 IP/Referer 泄露给第三方；
 *   只有整篇都没有本地图时才退回外链。
 */
export function pickCoverFromContent(
  content: unknown,
  options?: { preferLocal?: boolean },
): string | null {
  const text = String(content ?? '');
  if (!text) {
    return null;
  }
  const preferLocal = options?.preferLocal !== false;
  const refs = extractImageRefs(text);
  let firstUsable: string | null = null;
  for (const ref of refs) {
    const url = String(ref?.url ?? '').trim();
    if (!isUsableCoverUrl(url)) {
      continue;
    }
    if (!firstUsable) {
      firstUsable = url;
    }
    if (!preferLocal || url.startsWith('/static/')) {
      return url;
    }
  }
  return firstUsable;
}
