import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { hasFrontMatter, stripFrontMatter } from '../utils/frontMatter';
import { articleOverviewMarkdown } from '../utils/articleExcerpt';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('stripFrontMatter', () => {
  it('剥掉开头的 YAML front matter', () => {
    const src = '---\ntitle: 标题\ntags: [a, b]\n---\n\n# 正文\n';
    expect(hasFrontMatter(src)).toBe(true);
    expect(stripFrontMatter(src)).toBe('# 正文\n');
  });

  it('没有 front matter 时原样返回', () => {
    expect(stripFrontMatter('# 标题\n\n正文')).toBe('# 标题\n\n正文');
    expect(stripFrontMatter('')).toBe('');
    expect(hasFrontMatter('# 标题')).toBe(false);
  });

  it('只认文档最开头，正文中间的 --- 不动（那是分隔线）', () => {
    const src = '# 标题\n\n---\n\n后面还有\n';
    expect(hasFrontMatter(src)).toBe(false);
    expect(stripFrontMatter(src)).toBe(src);
  });

  it('CRLF、BOM、结尾没换行都能处理', () => {
    expect(stripFrontMatter('---\r\ntitle: x\r\n---\r\n\r\n正文')).toBe('正文');
    expect(stripFrontMatter('\uFEFF---\ntitle: x\n---\n正文')).toBe('正文');
    expect(stripFrontMatter('---\ntitle: x\n---')).toBe('');
  });

  it('正文以分隔线开头、后面又有一条分隔线时，**不能**被当成 front matter 吃掉', () => {
    // 这是审计发现的真实数据丢失：旧实现只看 `---`，于是
    // 「--- + 空行 + 标题 + 正文 + ---」会把标题和第一段整段删掉
    const src = '---\n\n# 大标题\n\n正文第一段\n\n---\n\n后半部分内容\n';
    expect(hasFrontMatter(src)).toBe(false);
    expect(stripFrontMatter(src)).toBe(src);
  });

  it('只有每行都像 YAML 才剥（markdown 标题、列表、句子都不算）', () => {
    expect(hasFrontMatter('---\n# 这是标题\n---\n正文')).toBe(false);
    expect(hasFrontMatter('---\n这是一句普通的话\n---\n正文')).toBe(false);
    expect(hasFrontMatter('---\ntitle: x\ntags:\n  - a\n  - b\n---\n正文')).toBe(true);
    expect(stripFrontMatter('---\ntitle: x\ntags:\n  - a\n---\n\n正文')).toBe('正文');
  });

  it('摘要也不会以 front matter 开头', () => {
    const src = '---\ntitle: 标题\n---\n\n这是真正的摘要文字。';
    expect(articleOverviewMarkdown(src)).toBe('这是真正的摘要文字。');
  });
});

describe('前台渲染链路上的 front matter 处理', () => {
  it('Viewer 渲染前先剥离（编辑器有 frontmatter 插件，前台没有）', () => {
    // 渲染外壳在 MarkdownView.tsx（Base / Rich 两个变体共用）
    const view = read('components/Markdown/MarkdownView.tsx');
    expect(view).toContain('stripFrontMatter');
    expect(view).toMatch(/value=\{stripFrontMatter\(props\.content\)\}/);
  });

  it('未知容器名回落到容器名本身，和后台编辑器一致', () => {
    expect(read('components/Markdown/customContainer.tsx')).toMatch(
      /CUSTOM_CONTAINER_TITLE\[tagName\] \|\| tagName/,
    );
  });
});
