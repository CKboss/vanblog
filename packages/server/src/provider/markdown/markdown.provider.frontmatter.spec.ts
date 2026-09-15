import { stripFrontMatter, hasFrontMatter } from 'src/utils/frontMatter';
import { articleOverviewMarkdown } from 'src/utils/articleExcerpt';
import { MarkdownProvider } from './markdown.provider';

describe('front matter（RSS/摘要用）', () => {
  it('剥掉开头的 YAML front matter，正文中间的 --- 不动', () => {
    expect(hasFrontMatter('---\ntitle: x\n---\n\n正文')).toBe(true);
    expect(stripFrontMatter('---\ntitle: x\n---\n\n正文')).toBe('正文');
    expect(stripFrontMatter('# 标题\n\n---\n\n后面')).toBe('# 标题\n\n---\n\n后面');
    expect(stripFrontMatter('')).toBe('');
  });

  it('getDescription 先剥 front matter 再按 more 截断', () => {
    const provider = new MarkdownProvider();
    expect(provider.getDescription('---\ntitle: x\n---\n\n摘要部分<!-- more -->后面的')).toBe(
      '摘要部分',
    );
    expect(provider.getDescription('没有 front matter<!-- more -->后面')).toBe('没有 front matter');
  });

  it('getDescription 委托共享的 articleOverviewMarkdown（两份实现不许再漂）', () => {
    // 行为等价：RSS 描述与前台列表摘要必须逐字符一致（website 的
    // __tests__/articleExcerptParity.spec.ts 再把这条链钉到前台实现上）
    const provider = new MarkdownProvider();
    const samples = [
      '---\ntitle: x\n---\n\n摘要部分<!-- more -->后面的',
      '没有标记的短文',
      'x'.repeat(500),
      '代码块里的标记不算：\n\n```md\n<!-- more -->\n```\n\n真正的<!-- more -->在这',
    ];
    for (const s of samples) {
      expect(provider.getDescription(s)).toBe(articleOverviewMarkdown(s));
    }
    // 没有 `<!-- more -->` 的长文现在取前 200 字（产品语义，见 §7.3），不再是全文
    expect(provider.getDescription('y'.repeat(500))).toBe('y'.repeat(200));
  });

  it('以分隔线开头的正文不会被误删（数据丢失回归）', () => {
    const src = '---\n\n# 大标题\n\n正文第一段\n\n---\n\n后半部分内容\n';
    expect(hasFrontMatter(src)).toBe(false);
    expect(stripFrontMatter(src)).toBe(src);
  });

  it('server 端 RSS 描述确实走了共享摘要实现', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(
      require('path').join(__dirname, 'markdown.provider.ts'),
      'utf8',
    );
    expect(src).toContain("import { articleOverviewMarkdown } from 'src/utils/articleExcerpt'");
    // ⚠️ 反向断言前先剥注释：上面解释「旧实现会漂移」的注释里就写着旧的 split 语句，
    //    不剥掉的话 not.toContain 会被自己的注释满足（本仓库踩过 9 次的坑）。
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    expect(stripped).toContain('return articleOverviewMarkdown(content);');
    expect(stripped).not.toContain("split('<!-- more -->')");
  });
});
