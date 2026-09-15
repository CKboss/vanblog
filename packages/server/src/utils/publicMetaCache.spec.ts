import {
  PUBLIC_META_CACHE_MS,
  invalidatePublicMetaCache,
  readPublicMetaCache,
  writePublicMetaCache,
} from './publicMetaCache';

describe('公开 meta 的进程内短缓存', () => {
  afterEach(() => invalidatePublicMetaCache());

  it('默认 5 秒（可用 VANBLOG_PUBLIC_META_CACHE_MS 调，0 关掉）', () => {
    expect(PUBLIC_META_CACHE_MS).toBe(5000);
  });

  it('写入后能读到同一个对象，失效后读不到', () => {
    const payload = { statusCode: 200, data: { version: 'x' } };
    expect(readPublicMetaCache()).toBeNull();
    writePublicMetaCache(payload);
    expect(readPublicMetaCache()).toBe(payload);
    invalidatePublicMetaCache();
    expect(readPublicMetaCache()).toBeNull();
  });

  it('超过 TTL 自动过期', () => {
    writePublicMetaCache({ a: 1 });
    const real = Date.now;
    try {
      Date.now = () => real() + PUBLIC_META_CACHE_MS + 10;
      expect(readPublicMetaCache()).toBeNull();
    } finally {
      Date.now = real;
    }
  });

  it('TTL 之内不过期', () => {
    writePublicMetaCache({ a: 1 });
    const real = Date.now;
    try {
      Date.now = () => real() + Math.max(0, PUBLIC_META_CACHE_MS - 100);
      expect(readPublicMetaCache()).toEqual({ a: 1 });
    } finally {
      Date.now = real;
    }
  });
});
