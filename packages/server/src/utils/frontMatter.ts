/**
 * 与 website 的 `utils/frontMatter.ts` 保持一致：正文开头的 YAML front matter 不是内容，
 * RSS/摘要里不该出现（编辑器有 frontmatter 插件会解析掉，别的地方得自己剥）。
 */
const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * 只有「每一行都像 YAML」才当 front matter。
 *
 * 只看 `---` 会误伤：正文以分隔线开头、后面又有一条分隔线时
 * （`---\n\n# 大标题\n\n正文\n\n---\n\n后半部分`），中间整段都会被吃掉。
 */
const YAML_KEY_LINE = /^\s*[A-Za-z0-9_$.[\]"'-]+\s*:(\s|$)/;
const YAML_LIST_LINE = /^\s*[-?]\s+/;
const YAML_CONT_LINE = /^\s+\S/;

function looksLikeYaml(block: string): boolean {
  const lines = block.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) {
    return false;
  }
  let keyLines = 0;
  for (const line of lines) {
    if (YAML_KEY_LINE.test(line)) {
      keyLines += 1;
      continue;
    }
    if (YAML_LIST_LINE.test(line) || YAML_CONT_LINE.test(line)) {
      continue;
    }
    return false;
  }
  return keyLines > 0;
}

export function hasFrontMatter(content: string): boolean {
  const matched = FRONT_MATTER_RE.exec(String(content ?? ''));
  return Boolean(matched && looksLikeYaml(matched[1]));
}

export function stripFrontMatter(content: string): string {
  const text = String(content ?? '');
  const matched = FRONT_MATTER_RE.exec(text);
  if (!matched || !looksLikeYaml(matched[1])) {
    return text;
  }
  // 顺带吃掉紧随其后的空行：markdown 文档开头的空行没有语义，
  // 但留着会让摘要以换行开头
  return text.slice(matched[0].length).replace(/^[\r\n]+/, '');
}
