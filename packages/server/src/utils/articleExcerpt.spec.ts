import {
  articleOverviewMarkdown,
  findMoreMarker,
  DEFAULT_OVERVIEW_CHARS,
  MORE_MARKER,
} from './articleExcerpt';

/**
 * server 侧列表摘要的语义测试。
 *
 * 这个函数是 website/utils/articleExcerpt.ts 的移植（两边必须逐字符一致，
 * 跨包对照测试在 packages/website/__tests__/articleExcerptParity.spec.ts）。
 * 这里钉的是**具体期望值**：如果两边被一起改错，parity 测试照样绿，
 * 只有这份硬编码期望能拦住。
 */

// issue #410 的复现形状：链接文字很长，200 字预算正好切进 [text](url) 中间
const LINK_TEXT_410 = '1'.repeat(DEFAULT_OVERVIEW_CHARS - 10);
const HREF_410 = 'https://example.com/post';
const LINK_MD_410 = `[${LINK_TEXT_410}](${HREF_410})`;

describe('articleOverviewMarkdown（server 移植版）', () => {
  it('常量与 website 保持一致（预算 200 字是产品决定，见 §7.3）', () => {
    expect(DEFAULT_OVERVIEW_CHARS).toBe(200);
    expect(MORE_MARKER).toBe('<!-- more -->');
  });

  it('有 <!-- more --> 时取标记之前的部分', () => {
    expect(articleOverviewMarkdown('摘要部分\n\n<!-- more -->\n\n后面的正文')).toBe(
      '摘要部分\n\n',
    );
    // 标记在前、正文超长也一样：标记优先于 200 字预算
    const content = `这是摘要<!-- more -->${'正文'.repeat(300)}`;
    expect(articleOverviewMarkdown(content)).toBe('这是摘要');
  });

  it('围栏代码块里的 <!-- more --> 不算标记（教程文章回归）', () => {
    const content =
      '教程开头\n\n```md\n<!-- more -->\n```\n\n真正的摘要<!-- more -->被吞掉的正文';
    const cut = findMoreMarker(content);
    // 截在**第二个**（真的）标记处；以前会截在代码示例里，卡片渲染出没闭合的 ```
    expect(cut).toBe(content.indexOf('真正的摘要') + '真正的摘要'.length);
    expect(articleOverviewMarkdown(content)).toBe(
      '教程开头\n\n```md\n<!-- more -->\n```\n\n真正的摘要',
    );
    // 未闭合的围栏：从围栏开始到文末都算代码，标记同样不生效，落到 200 字预算
    const unclosed = `前面\n\n\`\`\`text\n<!-- more -->\n${'x'.repeat(300)}`;
    expect(findMoreMarker(unclosed)).toBe(-1);
    expect(articleOverviewMarkdown(unclosed)).toBe(unclosed.slice(0, DEFAULT_OVERVIEW_CHARS));
  });

  it('行内代码里的 <!-- more --> 也不算标记', () => {
    const content = '用 `<!-- more -->` 表示截断<!-- more -->真的截断';
    expect(articleOverviewMarkdown(content)).toBe('用 `<!-- more -->` 表示截断');
  });

  it('front matter 被剥掉（元信息不进摘要，也不会被当成 setext 标题）', () => {
    const content = '---\ntitle: 测试\ntags: [a, b]\n---\n\n正文摘要<!-- more -->后面';
    expect(articleOverviewMarkdown(content)).toBe('正文摘要');
    // 以分隔线开头的正文不是 front matter，不能被误删（数据丢失回归）
    const hr = '---\n\n# 大标题\n\n正文';
    expect(articleOverviewMarkdown(hr)).toBe(hr);
  });

  it('没有标记时取前 200 字（9 篇老文章就走这条路）', () => {
    const content = '汉'.repeat(250);
    expect(articleOverviewMarkdown(content)).toBe('汉'.repeat(200));
    // 预算内的原样返回
    const short = '汉'.repeat(DEFAULT_OVERVIEW_CHARS);
    expect(articleOverviewMarkdown(short)).toBe(short);
    expect(articleOverviewMarkdown('汉'.repeat(199))).toBe('汉'.repeat(199));
    // 显式预算
    expect(articleOverviewMarkdown('abcdefg', 3)).toBe('abc');
  });

  it('截断落在 [text](url) 中间时补全整个链接（issue #410）', () => {
    expect(LINK_MD_410.length).toBeGreaterThan(DEFAULT_OVERVIEW_CHARS);
    // 朴素 slice 会切在 href 中间，露出裸括号 + 半个链接
    expect(LINK_MD_410.slice(0, DEFAULT_OVERVIEW_CHARS)).not.toContain(HREF_410);
    const excerpt = articleOverviewMarkdown(LINK_MD_410);
    expect(excerpt).toBe(LINK_MD_410);
    expect(excerpt).toContain(`](${HREF_410})`);
    // 补全一个链接之后不能把后文也吞进来
    expect(articleOverviewMarkdown(LINK_MD_410 + '\n\n第二段还在。')).toBe(LINK_MD_410);
    // 图片同理
    const img = `![图${'x'.repeat(DEFAULT_OVERVIEW_CHARS)}](/static/img/a.webp)`;
    expect(articleOverviewMarkdown(img)).toBe(img);
  });

  it('绝不把代理对（emoji）切成两半', () => {
    const content = '😀'.repeat(99) + 'a' + '😀'.repeat(60);
    const excerpt = articleOverviewMarkdown(content);
    expect(excerpt).toBe('😀'.repeat(99) + 'a');
    // 单独的高代理项 = 半个 emoji
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(excerpt)).toBe(false);
  });

  it('空内容 / undefined / null 原样返回（老数据有 content 缺失的文章）', () => {
    expect(articleOverviewMarkdown('')).toBe('');
    expect(articleOverviewMarkdown(undefined as any)).toBeUndefined();
    expect(articleOverviewMarkdown(null as any)).toBeNull();
  });

  it('CJK 正文按**字符数**而不是字节数截断', () => {
    const content = '汉字测试，标点符号；全角！'.repeat(30); // 每段 12 字符，共 360
    const excerpt = articleOverviewMarkdown(content);
    // UTF-8 下这段是 600+ 字节，按字节截会切出乱码；预算是 200 个 UTF-16 字符
    expect(Buffer.byteLength(content.slice(0, 200), 'utf8')).toBeGreaterThan(200);
    expect(excerpt.length).toBe(DEFAULT_OVERVIEW_CHARS);
    expect(excerpt).toBe(content.slice(0, DEFAULT_OVERVIEW_CHARS));
  });
});
