import { safeDecodeURIComponent } from './safeDecode';

describe('safeDecodeURIComponent', () => {
  // 这个函数存在的原因：文章别名来自 URL，`decodeURIComponent('%')` 会抛 URIError，
  // 于是公开接口 GET /api/public/article/%25 直接 500（实测过）。
  it('解不开的输入原样返回，不抛异常', () => {
    expect(() => safeDecodeURIComponent('%')).not.toThrow();
    expect(safeDecodeURIComponent('%')).toBe('%');
    expect(safeDecodeURIComponent('%zz')).toBe('%zz');
    expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('正常百分号编码照常解码', () => {
    expect(safeDecodeURIComponent('%E4%B8%AD%E6%96%87')).toBe('中文');
    expect(safeDecodeURIComponent('a%2Fb')).toBe('a/b');
    expect(safeDecodeURIComponent('hello-world')).toBe('hello-world');
  });

  it('空值与非字符串不会炸', () => {
    expect(safeDecodeURIComponent(undefined)).toBe('');
    expect(safeDecodeURIComponent(null)).toBe('');
    expect(safeDecodeURIComponent(123)).toBe('123');
  });

  it('限长（默认 500），匿名请求塞不进任意长的键', () => {
    expect(safeDecodeURIComponent('a'.repeat(900))).toHaveLength(500);
    expect(safeDecodeURIComponent('a'.repeat(900), 32)).toHaveLength(32);
  });
});
