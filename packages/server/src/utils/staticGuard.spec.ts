import {
  GUARDED_STATIC_SEGMENTS,
  backupFirstSegmentUnderStatic,
  guardedStaticFirstSegment,
  isGuardedStaticPath,
} from './staticGuard';

/**
 * `/static/**` 匿名 403 守卫的判定。
 *
 * ⚠️ 这些用例里的每一条绕过写法都是**活体证明过能拿到文件字节**的（不是理论构造）：
 * 旧实现用 `req.path.startsWith('/static/export/')` 比较**未解码**的原始路径，
 * 而 serve-static 打开文件前会解码 + 归一化，两边口径不一致 ⇒ 守卫只挡得住最老实的拼写。
 */
describe('静态目录的匿名 403 守卫', () => {
  const GUARDED = [
    // 字面写法（旧实现唯一能挡住的那一种）
    '/static/export/backup-2026-09-12.zip',
    '/static/tmp/full-restore-abc123/vanblog.ndjson',
    '/static/upload-tmp/vanblog-full-20260917.tar.zst',
    // 百分号编码绕过
    '/static/%65xport/backup.zip', // %65 = 'e'
    '/static/%45xport/backup.zip', // %45 = 'E'（大小写不敏感的文件系统上同样是 export）
    '/static/%74mp/full-restore-abc/vanblog.ndjson', // %74 = 't'
    '/static/export%2fbackup.zip', // %2f = '/'
    '/static/upload-tmp%2farchive.zst',
    '/static/%2e/export/backup.zip', // %2e = '.'
    '/static/%2e%2e/export/backup.zip',
    // 点段与重复斜杠绕过
    '/static/./export/backup.zip',
    '/static//export/backup.zip',
    '/static///tmp///x.ndjson',
    '/static/img/../export/backup.zip',
    '/static/img/./../tmp/x.ndjson',
    // 反斜杠（Windows 风格分隔符）
    '/static/\\export\\backup.zip',
  ];

  it.each(GUARDED)('挡住 %s', (p) => {
    expect(isGuardedStaticPath(p, null)).toBe(true);
  });

  const ALLOWED = [
    '/static/img/a.webp',
    '/static/img/thumb/a.webp',
    '/static/file/doc.pdf',
    '/static/customPage/x.html',
    '/static/themes/warm-paper-28381fac.css',
    '/static/exportx/legit-dir/a.webp', // ⚠️ 前缀匹配会误伤这种目录，比第一段就不会
    '/static/EXPORTX/not-guarded.webp', // 小写化只用于比较受控名，不该把无辜目录也挡掉
    '/static/tmporary/not-the-tmp-dir/a.webp',
    '/api/public/meta',
    '/static/',
    '/static',
    '/',
    '',
  ];

  it.each(ALLOWED)('放行 %s', (p) => {
    expect(isGuardedStaticPath(p, null)).toBe(false);
  });

  it('没有尾斜杠的 /static/export 也要挡（serve-static 会 301，但别指望它）', () => {
    expect(guardedStaticFirstSegment('/static/export')).toBe('export');
    expect(isGuardedStaticPath('/static/export', null)).toBe(true);
  });

  it('畸形百分号序列按字面判定，宁可多挡不可漏放', () => {
    // decodeURIComponent('%zz') 会抛；守卫不能因为解码失败就放行
    expect(() => decodeURIComponent('/static/%zz/export/x')).toThrow();
    expect(isGuardedStaticPath('/static/%zz/export/x', null)).toBe(false); // 字面第一段是 %zz，不是受控目录
    expect(isGuardedStaticPath('/static/export%zz/x', null)).toBe(false);
    // 但真正的受控目录仍然被挡
    expect(isGuardedStaticPath('/static/export/%zz', null)).toBe(true);
  });

  it('backupPath 被配到 staticPath 里面时，那一段也进兜底名单', () => {
    const seg = backupFirstSegmentUnderStatic('/app/static', '/app/static/vanblog-backups');
    expect(seg).toBe('vanblog-backups');
    expect(isGuardedStaticPath('/static/vanblog-backups/full.tar.zst', seg)).toBe(true);
    expect(isGuardedStaticPath('/static/%76anblog-backups/full.tar.zst', seg)).toBe(true); // %76='v'
    expect(isGuardedStaticPath('/static/img/a.webp', seg)).toBe(false);
  });

  it('backupPath 在 staticPath 之外时不需要兜底（正常部署）', () => {
    expect(backupFirstSegmentUnderStatic('/app/static', '/var/vanblog/backups')).toBeNull();
    expect(backupFirstSegmentUnderStatic('/app/static', '/app/static2/x')).toBeNull(); // 前缀相似但不是子目录
  });

  it('受控目录名单就是那三个（新增静态目录时会被这条提醒去分类）', () => {
    expect([...GUARDED_STATIC_SEGMENTS].sort()).toEqual(['export', 'tmp', 'upload-tmp']);
  });
});
