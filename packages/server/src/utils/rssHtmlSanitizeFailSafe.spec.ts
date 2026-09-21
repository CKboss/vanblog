// 🔴 这个文件**整体**用 mock 替换掉 HTML 解析器，目的是测那条"消毒失败时的失败方向"。
//    ⚠️ jest.mock 是**文件级**的，所以必须单独一个 spec 文件，不能与正常路径的用例混在一起。
jest.mock('hast-util-from-html', () => ({
  fromHtml: () => {
    throw new Error('PROBE parse failure');
  },
}));

import { sanitizeRenderedHtml } from './rssHtmlSanitize';

describe('RSS 消毒：解析失败时的失败方向（宁可少发，绝不漏发未消毒内容）', () => {
  it('🔴 解析抛错时返回**空串**，而不是把未消毒的原文原样返回', () => {
    const dirty = '<script>alert(1)</script><p>正文</p>';
    const out = sanitizeRenderedHtml(dirty);
    expect(out).toBe('');
    // 判据本身：返回值绝不等于输入（那才是"失败方向错了"的形状）
    expect(out).not.toBe(dirty);
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('正文');
  });

  it('🔴 失败必须**大声**：onError 回调被调用，且带着原始错误', () => {
    const seen: unknown[] = [];
    sanitizeRenderedHtml('<p>x</p>', (err) => seen.push(err));
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeInstanceOf(Error);
    expect((seen[0] as Error).message).toContain('PROBE parse failure');
  });

  it('不传 onError 时也不抛（调用方不该因为日志回调缺失而崩）', () => {
    expect(() => sanitizeRenderedHtml('<p>x</p>')).not.toThrow();
    expect(sanitizeRenderedHtml('<p>x</p>')).toBe('');
  });

  it('⚠️ 反证：这条路径不是"因为输入本来就空"才返回空串', () => {
    // 输入非空、且是合法 HTML，仍然返回空 ⇒ 说明确实走到了 catch，而不是提前返回
    const input = '<p>这是一段非空的合法 HTML</p>';
    expect(input.length).toBeGreaterThan(10);
    expect(sanitizeRenderedHtml(input)).toBe('');
  });
});
