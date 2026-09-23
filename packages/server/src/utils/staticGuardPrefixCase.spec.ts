import {
  ESCAPED,
  GUARDED_STATIC_SEGMENTS,
  guardedStaticFirstSegment,
  isGuardedStaticPath,
} from './staticGuard';

/**
 * 🔴 2026-09-22：`/static/` **前缀**的大小写绕过。
 *
 * 缺陷：`guardedStaticFirstSegment()` 对**第一段**做了 `toLowerCase()`（所以 `/static/Export/x`
 * 早就被挡住、且 `audit-hardening-round4-security-staticguard.spec.ts` 里有一条钉着它），
 * 但对 `/static/` **前缀本身**用的是大小写敏感的 `startsWith` ⇒ `/STATIC/export/x` 会落到
 * `seg = null` 分支被**放行**。而 `main.ts` 用 `app.use(prefix, express.static(...))` 挂载，
 * Express 的前缀匹配**默认大小写不敏感**（没设 `case sensitive routing`）⇒ serve-static 真的会服务它。
 *
 * 🔴 活体已证实（dev server，HEAD 请求）：修前 `/STATIC/export/<归档>` 与 `/Static/export/<同一个>`
 * 都是 **200**（而 `/static/export/<同一个>` 是 403）；修后三种写法**全部 403**，
 * 且负对照 `/static/img/<真图>` 与 `/STATIC/img/<真图>` **仍都 200**（正常静态资源可达性未被破坏）。
 *
 * 🔴 暴露面：`GUARDED_STATIC_SEGMENTS` 是 `{export, tmp, upload-tmp}`，而本模块头注释记载
 * `<static>/tmp/full-restore-*` 是整站恢复的解包树（**含密码哈希与 JWT 密钥的 NDJSON 明文**）⇒
 * 绕过暴露的是全系统最敏感的数据（JWT 密钥可用于**伪造管理员会话**）。
 *
 * ⚠️ **为什么现有测试没覆盖这一维**：`audit-hardening-round4-security-staticguard.spec.ts` 里
 * （🔴 按符号指路，不写行号 —— 行号必然漂移且漂移后不会有任何东西变红；本行原先写着 `:123`，
 *  在 2026-09-23 那次给同文件补条数断言之后就漂到了 126，而没有任何守卫报红）
 * 钉的是 `guardedStaticFirstSegment('/static/Export/f.zip') === 'export'`，即**段**的大小写；
 * 而**前缀**的大小写（`/STATIC/export/…`）一条都没有 ⇒ 两套口径里只测了被修过的那一套。
 */
describe('staticGuard：/static/ 前缀的大小写不敏感（匿名可达的敏感文件下载绕过）', () => {
  /** 生成一个前缀大小写变体：把 `/static/` 的某些字母换成大写 */
  const variant = (i: number): string => {
    const base = '/static/';
    // 6 位掩码（s t a t i c），i 的每一位决定该字母是否大写 ⇒ 覆盖 64 种组合里的采样
    return (
      '/' +
      base
        .slice(1, -1)
        .split('')
        .map((ch, k) => ((i >> k) & 1 ? ch.toUpperCase() : ch))
        .join('') +
      '/'
    );
  };

  it('尺子有效性：variant() 真的产出了不同大小写的前缀，且小写形式就是 /static/', () => {
    expect(variant(0)).toBe('/static/');
    expect(variant(1)).toBe('/Static/');
    expect(variant(2)).toBe('/sTatic/');
    // 反空转：64 个变体去重后确实多于 1 个（否则下面的穷举是在重复测同一个东西）
    const all = new Set(Array.from({ length: 64 }, (_, i) => variant(i)));
    expect(all.size).toBeGreaterThan(30);
    // 且每个变体小写后都回到 /static/
    for (const v of all) expect(v.toLowerCase()).toBe('/static/');
  });

  it('受保护目录清单本身是已知的三个（反空转：穷举不是空的）', () => {
    expect([...GUARDED_STATIC_SEGMENTS].sort()).toEqual(['export', 'tmp', 'upload-tmp']);
    expect(GUARDED_STATIC_SEGMENTS.size).toBe(3);
  });

  // 🔴 穷举：受保护目录 × 前缀大小写变体。**将来往 GUARDED_STATIC_SEGMENTS 加目录会自动被覆盖。**
  describe.each([...GUARDED_STATIC_SEGMENTS].sort())('受保护目录 %s', (seg) => {
    it.each([0, 1, 2, 3, 8, 16, 21, 32, 42, 63])('前缀变体 #%i 也被判定为受保护', (i) => {
      const p = `${variant(i)}${seg}/some-file.bin`;
      expect(guardedStaticFirstSegment(p)).toBe(seg);
      expect(isGuardedStaticPath(p, null)).toBe(true);
    });
  });

  it('段本身的大小写变体也仍然被挡（既有性质，不许因为改前缀而回退）', () => {
    for (const p of ['/static/Export/f.zip', '/static/EXPORT/f.zip', '/STATIC/Export/f.zip', '/StAtIc/eXpOrT/f.zip']) {
      expect(guardedStaticFirstSegment(p)).toBe('export');
      expect(isGuardedStaticPath(p, null)).toBe(true);
    }
  });

  it('前缀大小写变体 + 已修的其它绕过维度叠加时，仍然全部被挡', () => {
    // 这些是头注释里记载的六种既有绕过形状，叠加大写前缀后必须仍然被挡
    // （证明"修大小写"没有把别的维度弄坏）
    const cases = [
      '/STATIC/%65xport/f.zip', // %65 = 'e'
      '/Static/export%2ff.zip', // %2f = '/'
      '/STATIC/./export/f.zip',
      '/STATIC//export/f.zip',
      '/Static/%2e/export/f.zip', // %2e = '.'
      '/STATIC/upload-tmp%2farchive.tar',
    ];
    for (const p of cases) {
      expect(isGuardedStaticPath(p, null)).toBe(true);
    }
  });

  it('逃出 /static/ 的仍然返回 ESCAPED（大写前缀下也一样）', () => {
    expect(guardedStaticFirstSegment('/STATIC/%2e%2e/export/f.zip')).toBe(ESCAPED);
    expect(isGuardedStaticPath('/Static/../etc/passwd', null)).toBe(true);
  });

  // 🔴 过度修复的反向断言：守卫不能变成"全都挡"，否则正常静态资源就没了
  it('🔴 负对照：正常静态资源（含大写前缀）绝不被挡', () => {
    for (const p of [
      '/static/img/a.webp',
      '/STATIC/img/a.webp',
      '/Static/img/a.webp',
      '/static/whatever/b.png',
      '/STATIC/exportx/f.zip', // 前缀匹配不会误伤 exportx（段级比较）
      '/static/exports/f.zip',
    ]) {
      expect(isGuardedStaticPath(p, null)).toBe(false);
    }
  });

  it('静态根本身（无尾斜杠，各种大小写）不算受保护，交给 serve-static 处理目录请求', () => {
    for (const p of ['/static', '/STATIC', '/Static']) {
      expect(guardedStaticFirstSegment(p)).toBeNull();
      expect(isGuardedStaticPath(p, null)).toBe(false);
    }
  });

  it('非 /static/ 的路径不受影响（各种大小写都不该被这个守卫挡）', () => {
    for (const p of ['/api/public/meta', '/API/public/meta', '/rss/feed.xml', '/RSS/feed.xml', '/', '']) {
      expect(isGuardedStaticPath(p, null)).toBe(false);
    }
  });

  it('非法输入不抛错，且失败方向是"不当成受保护"（由下游处理），但绝不放行逃出', () => {
    for (const bad of [undefined, null, 0, {}, [], NaN]) {
      expect(() => guardedStaticFirstSegment(bad)).not.toThrow();
      expect(() => isGuardedStaticPath(bad, null)).not.toThrow();
    }
  });

  it('兜底段（备份目录恰好在静态目录里）也按小写比较，且大写前缀下同样生效', () => {
    expect(isGuardedStaticPath('/static/Backups/x.tar', 'backups')).toBe(true);
    expect(isGuardedStaticPath('/STATIC/Backups/x.tar', 'backups')).toBe(true);
    expect(isGuardedStaticPath('/static/backups/x.tar', 'backups')).toBe(true);
    // 反向：兜底段不匹配时不误挡
    expect(isGuardedStaticPath('/STATIC/other/x.tar', 'backups')).toBe(false);
  });
});
