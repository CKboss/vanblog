import { tagHue } from "./tagColor";

/**
 * 没有图的文章用「渐变占位封面」：色相由**标题**哈希得到（同一篇文章永远同一个颜色），
 * 纯 CSS 渐变 + 标题首字，**零网络请求**。
 *
 * 为什么要这个：本站 53 篇文章一张 cover 都没设，正文含图的也只有一部分，
 * 于是列表页会出现「一半卡片有图、一半没有」的破碎感。占位封面让每张卡都有一个色块，
 * 版面节奏统一，同时不给服务器/CDN 增加任何负担。
 */

/** 与标签胶囊共用同一套哈希（utils/tagColor.ts），保证「同名同色」的规则一致 */
export function coverHue(title: string): number {
  return tagHue(String(title ?? ""));
}

/** 去掉标题里的 markdown 记号与前缀方括号，取一个能代表这篇文章的短标识 */
export function coverGlyph(title: string): string {
  const text = String(title ?? "")
    .replace(/^\s*\[[^\]]*\]\s*/, "") // [摄影]xxx / [生存技能] xxx
    .replace(/[*_`~#>]/g, "") // markdown 记号
    .replace(/^\s+/, "")
    .trim();
  if (!text) {
    return "·";
  }
  const first = text.charAt(0);
  // 中日韩取第一个字；拉丁/数字标题取开头那串连续的字母数字（最多 8 个字符），
  // 这样 "2025冬日下的天马山" 得到 "2025"、"VanBlog: a blog" 得到 "VanBlog"，
  // 而不会把中文一起截进来变成 "2025冬日下的" 这种半截词
  if (/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(first)) {
    return first;
  }
  const word = text.match(/^[A-Za-z0-9&#+._-]+/)?.[0] || first;
  return word.slice(0, 8);
}

/** 以 CSS 变量下发色相：深浅两套配色都写在 CSS 里（内联样式做不了暗色适配） */
export function coverStyle(title: string): React.CSSProperties {
  return { ["--chip-h" as any]: String(coverHue(title)) };
}
