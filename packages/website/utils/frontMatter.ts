/**
 * YAML front matter 处理。
 *
 * VanBlog 的文章元信息存在数据库字段里，正文正常不该带 front matter；但**导入 .md 文件**、
 * 从别的平台粘贴、或用「导出 Markdown」再导回来时，正文开头就会出现：
 *
 *     ---
 *     title: xxx
 *     tags: [a, b]
 *     ---
 *
 * 后台编辑器装了 `@bytemd/plugin-frontmatter`，会把它解析掉、预览里不显示；
 * 前台 Viewer 以前没装，于是这三行被当成 markdown 渲染成 `<hr>` + 一个巨大的
 * `<h2>title: xxx tags: [a, b]</h2>`（`---` 下面是文字就成了 setext 标题）。
 * 这里在渲染和摘要之前先把它剥掉，让两边表现一致。
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
  const matched = FRONT_MATTER_RE.exec(String(content ?? ""));
  return Boolean(matched && looksLikeYaml(matched[1]));
}

/** 去掉开头的 YAML front matter；没有就原样返回。 */
export function stripFrontMatter(content: string): string {
  const text = String(content ?? "");
  const matched = FRONT_MATTER_RE.exec(text);
  if (!matched || !looksLikeYaml(matched[1])) {
    return text;
  }
  // 顺带吃掉紧随其后的空行：markdown 文档开头的空行没有语义，
  // 但留着会让摘要以换行开头
  return text.slice(matched[0].length).replace(/^[\r\n]+/, "");
}
