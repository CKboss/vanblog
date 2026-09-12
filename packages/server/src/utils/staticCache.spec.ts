import { IMG_CACHE_CONTROL, STATIC_CACHE_CONTROL, applyStaticAssetHeaders, cacheControlFor } from './imgCompress';

describe('静态资源缓存头', () => {
  it('图床图片（含缩略图）走长缓存 + stale-while-revalidate', () => {
    expect(cacheControlFor('/data/static/img/abc.webp')).toBe(IMG_CACHE_CONTROL);
    expect(cacheControlFor('/data/static/img/thumb/abc.webp')).toBe(IMG_CACHE_CONTROL);
    expect(IMG_CACHE_CONTROL).toContain('max-age=3600');
    expect(IMG_CACHE_CONTROL).toContain('stale-while-revalidate=604800');
    // 「替换图片」会用同名文件覆盖新内容，所以不能写 immutable
    expect(IMG_CACHE_CONTROL).not.toContain('immutable');
  });

  it('其它静态文件只做短缓存（会被原地覆盖）', () => {
    expect(cacheControlFor('/data/static/file/x.pdf')).toBe(STATIC_CACHE_CONTROL);
    expect(cacheControlFor('/data/static/customPage/a/index.html')).toBe(STATIC_CACHE_CONTROL);
    expect(STATIC_CACHE_CONTROL).toContain('must-revalidate');
  });

  it('Windows 风格路径也能识别', () => {
    expect(cacheControlFor('C:\\data\\static\\img\\a.webp')).toBe(IMG_CACHE_CONTROL);
  });

  it('applyStaticAssetHeaders 会真的把 Cache-Control 写进响应', () => {
    const headers: Record<string, string> = {};
    applyStaticAssetHeaders({ setHeader: (k, v) => (headers[k] = v) }, '/data/static/img/a.webp');
    expect(headers['Cache-Control']).toBe(IMG_CACHE_CONTROL);
  });
});
