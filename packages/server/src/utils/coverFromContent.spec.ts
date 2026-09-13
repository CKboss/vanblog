import { isUsableCoverUrl, pickCoverFromContent } from './coverFromContent';

describe('从正文挑封面图', () => {
  it('取文档顺序里的第一张可用图（与前台列表缩略图一致，封面和缩略图不会是两张图）', () => {
    expect(pickCoverFromContent('前 ![a](/static/img/first.webp) 中 ![b](/static/img/second.webp)')).toBe(
      '/static/img/first.webp',
    );
    expect(pickCoverFromContent('<img src="/static/img/html.webp"> 后 ![a](/static/img/md.webp)')).toBe(
      '/static/img/html.webp',
    );
  });

  it('代码块与行内代码里的示例不算（教程文章常写图片语法当例子）', () => {
    const md = ['```md', '![示例](/static/img/fence.webp)', '```', '', '真图 ![a](/static/img/real.webp)'].join('\n');
    expect(pickCoverFromContent(md)).toBe('/static/img/real.webp');
    expect(pickCoverFromContent('用 `![x](/static/img/inline.webp)` 写图片')).toBeNull();
  });

  it('data: URI 与相对路径不要（前者几十 KB 会被每次列表查询拖着跑）', () => {
    expect(isUsableCoverUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isUsableCoverUrl('./img/x.png')).toBe(false);
    expect(isUsableCoverUrl('')).toBe(false);
    expect(isUsableCoverUrl('x'.repeat(3000))).toBe(false);
    expect(isUsableCoverUrl('/static/img/x.webp')).toBe(true);
    expect(isUsableCoverUrl('//cdn.example/x.png')).toBe(true);
    expect(pickCoverFromContent('![a](data:image/png;base64,AAAA)')).toBeNull();
  });

  it('默认优先本站图床：外链首图随时可能失效，还会把访客 IP/Referer 泄露给第三方', () => {
    const md = '![a](https://cdn.example/remote.png) 中 ![b](/static/img/local.webp)';
    expect(pickCoverFromContent(md)).toBe('/static/img/local.webp');
    // 明确关掉优先本地时，就按文档顺序取第一张
    expect(pickCoverFromContent(md, { preferLocal: false })).toBe('https://cdn.example/remote.png');
  });

  it('整篇只有外链时才退回外链（总比没有封面好）', () => {
    expect(pickCoverFromContent('![a](https://cdn.example/only.png)')).toBe('https://cdn.example/only.png');
  });

  it('没有图 / 空内容 → null', () => {
    expect(pickCoverFromContent('纯文字')).toBeNull();
    expect(pickCoverFromContent('')).toBeNull();
    expect(pickCoverFromContent(null)).toBeNull();
    expect(pickCoverFromContent(undefined)).toBeNull();
  });
});
