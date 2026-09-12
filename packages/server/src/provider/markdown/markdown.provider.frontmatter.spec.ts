import { stripFrontMatter, hasFrontMatter } from 'src/utils/frontMatter';

describe('front matter（RSS/摘要用）', () => {
  it('剥掉开头的 YAML front matter，正文中间的 --- 不动', () => {
    expect(hasFrontMatter('---\ntitle: x\n---\n\n正文')).toBe(true);
    expect(stripFrontMatter('---\ntitle: x\n---\n\n正文')).toBe('正文');
    expect(stripFrontMatter('# 标题\n\n---\n\n后面')).toBe('# 标题\n\n---\n\n后面');
    expect(stripFrontMatter('')).toBe('');
  });

  it('getDescription 先剥 front matter 再按 more 截断', () => {
    // 直接测逻辑，避免拉起整个 provider 的依赖
    const getDescription = (content: string) =>
      stripFrontMatter(content).split('<!-- more -->')[0];
    expect(getDescription('---\ntitle: x\n---\n\n摘要部分<!-- more -->后面的')).toBe(
      '摘要部分',
    );
    expect(getDescription('没有 front matter<!-- more -->后面')).toBe('没有 front matter');
  });

  it('以分隔线开头的正文不会被误删（数据丢失回归）', () => {
    const src = '---\n\n# 大标题\n\n正文第一段\n\n---\n\n后半部分内容\n';
    expect(hasFrontMatter(src)).toBe(false);
    expect(stripFrontMatter(src)).toBe(src);
  });

  it('server 端 RSS 描述确实走了 stripFrontMatter', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'markdown.provider.ts'),
      'utf8',
    );
    expect(src).toContain("import { stripFrontMatter } from 'src/utils/frontMatter'");
    expect(src).toContain("stripFrontMatter(content).split('<!-- more -->')[0]");
  });
});
