import { maskCodeRegions } from './markdownExport';

/**
 * 从正文里找出图片链接。
 *
 * 旧实现遍历正则的**每一个捕获分组**，只用 `includes('http')` 过滤，于是：
 * - `![参见 https://docs.xxx](https://cdn/real.png)` 会把 **alt 文本**当成链接返回；
 * - `![a](url "标题")` 会返回 `url "标题"` 这一整段；
 * - 代码块/行内代码里的示例也会被当成真图片。
 * 这些假链接随后被 `scanLinksOfArticles` 拿去请求：失败的会被报成「文章里有失效图片」，
 * 成功的还会往 statics 表里插一条垃圾记录（storageType 写成 picgo）。
 */
const IMG_RE = /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

export const parseImgLinksOfMarkdown = (content: string): string[] => {
  const text = String(content ?? '');
  if (!text) {
    return [];
  }
  // 代码区「涂黑」成等长占位，偏移量不变，因此可以用 masked 的位置回原文取真实内容
  const masked = maskCodeRegions(text);
  const res: string[] = [];
  const re = new RegExp(IMG_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const raw = text.slice(m.index, m.index + m[0].length);
    const exact = new RegExp(IMG_RE.source).exec(raw);
    const url = String(exact?.[2] || '').trim();
    // 保持旧行为：只关心外链（本站相对路径不进「失效图片」检查）
    if (url && url.includes('http') && !res.includes(url)) {
      res.push(url);
    }
  }
  return res;
};
