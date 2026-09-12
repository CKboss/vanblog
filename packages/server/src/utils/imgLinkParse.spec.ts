import { parseImgLinksOfMarkdown } from './parseImgOfMarkdown';
import { extractImageRefs } from './transferRemoteImages';
import { maskCodeRegions, safeDecodeURIComponent } from './markdownExport';

describe('正文图片链接解析（误报会写垃圾 statics 记录）', () => {
  it('只取 URL 分组，不把 alt 文本或标题当成链接', () => {
    const md = '![参见 https://docs.example.com/a](https://cdn.example.com/real.png "标题")';
    const links = parseImgLinksOfMarkdown(md);
    expect(links).toEqual(['https://cdn.example.com/real.png']);
  });

  it('跳过围栏代码块与行内代码里的示例', () => {
    const md = [
      '真图：![a](https://cdn.example.com/yes.png)',
      '',
      '```md',
      '![b](https://cdn.example.com/in-fence.png)',
      '```',
      '',
      '行内 `![c](https://cdn.example.com/inline.png)` 也不算',
    ].join('\n');
    expect(parseImgLinksOfMarkdown(md)).toEqual(['https://cdn.example.com/yes.png']);
  });

  it('本站相对路径不进外链检查（保持旧行为）', () => {
    expect(parseImgLinksOfMarkdown('![a](/static/img/x.webp)')).toEqual([]);
  });

  it('extractImageRefs 同样跳过代码区，但保留正文里的 <img>', () => {
    const md = [
      '![a](https://cdn.example.com/yes.png)',
      '',
      '```md',
      '![b](https://cdn.example.com/no.png)',
      '```',
      '',
      '<img src="https://cdn.example.com/html.png" width="10">',
    ].join('\n');
    const urls = extractImageRefs(md).map((r) => r.url);
    expect(urls).toContain('https://cdn.example.com/yes.png');
    expect(urls).toContain('https://cdn.example.com/html.png');
    expect(urls).not.toContain('https://cdn.example.com/no.png');
  });

  it('extractImageRefs 返回的 raw 是原文（用于按偏移改写）', () => {
    const md = '前缀 ![alt](https://cdn.example.com/a.png) 后缀';
    const [ref] = extractImageRefs(md);
    expect(ref.raw).toBe('![alt](https://cdn.example.com/a.png)');
    expect(md.slice(ref.index, ref.index + ref.raw.length)).toBe(ref.raw);
  });

  it('坏的百分号转义不会让整个导出 500', () => {
    expect(safeDecodeURIComponent('/static/a%zb.png')).toBe('/static/a%zb.png');
    expect(safeDecodeURIComponent('/static/a%20b.png')).toBe('/static/a b.png');
  });

  it('maskCodeRegions 保持长度不变（偏移改写依赖这一点）', () => {
    const md = 'a `code` b\n```\nfence\n```\nc';
    expect(maskCodeRegions(md)).toHaveLength(md.length);
  });
});
