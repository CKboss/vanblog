/**
 * 与 website 的 `utils/frontMatter.ts` 保持一致：正文开头的 YAML front matter 不是内容，
 * RSS/摘要里不该出现（编辑器有 frontmatter 插件会解析掉，别的地方得自己剥）。
 */
const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function hasFrontMatter(content: string): boolean {
  return FRONT_MATTER_RE.test(String(content ?? ''));
}

export function stripFrontMatter(content: string): string {
  const text = String(content ?? '');
  if (!FRONT_MATTER_RE.test(text)) {
    return text;
  }
  // 顺带吃掉紧随其后的空行：markdown 文档开头的空行没有语义，
  // 但留着会让摘要以换行开头
  return text.replace(FRONT_MATTER_RE, '').replace(/^[\r\n]+/, '');
}
