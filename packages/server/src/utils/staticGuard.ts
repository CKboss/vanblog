import * as path from 'path';

/**
 * `/static/**` 上"匿名一律 403"的那几个目录的判定。
 *
 * ⚠️ 为什么必须有这个模块，而不是在中间件里写 `req.path.startsWith('/static/export/')`：
 * `req.path` 是 Express 给的**原始**路径 —— 没有百分号解码、也没有做 `.`/`..`/重复斜杠归一化，
 * 而下游的 `serve-static`/`send` 在打开文件之前**会**解码并归一化。两边口径不一致，
 * 守卫就只在"字面拼写完全一致"时才生效，于是这些全都能绕过并真的拿到文件字节（都活体验证过）：
 *
 *     /static/%65xport/<file>        （%65 = 'e'）
 *     /static/export%2f<file>        （%2f = '/'）
 *     /static/./export/<file>
 *     /static//export/<file>
 *     /static/%2e/export/<file>      （%2e = '.'）
 *     /static/%74mp/full-restore-xxx/vanblog.ndjson   ← 整站恢复的暂存目录，
 *                                                       里面是含密码哈希与 jwt 密钥的 NDJSON
 *     /static/upload-tmp%2f<archive>
 *
 * 而 `/static/export/<file>` 与 `/static/export/../export/<file>` 反而是**正确 403** 的 ——
 * 也就是说旧守卫只挡住了最老实的那一种写法。这条守卫是早先一轮加的（当时的结论是
 * "导出归档匿名可下载已修"），所以这不只是漏了一个 case，而是**那次修复本身是装饰性的**。
 *
 * 修法：先按 serve-static 的口径把路径**解码 + 合并重复斜杠 + posix 归一化**，
 * 然后比较 `/static/` 之后的**第一个路径段**（而不是做字符串前缀匹配 ——
 * 前缀匹配还会把 `/static/exportx/` 这种无辜目录一起挡掉）。
 */

/** 归一化后逃出了 `/static/`（例如 `/static/%2e%2e/…`）：当作受控处理，直接 403 */
export const ESCAPED = '\u0000escaped';

/** 匿名一律 403 的静态子目录（第一段，小写） */
export const GUARDED_STATIC_SEGMENTS = new Set(['export', 'tmp', 'upload-tmp']);

/**
 * 取出 `/static/` 之后的第一个路径段；不属于 `/static/` 或取不到就返回 null。
 * 解码失败（畸形百分号序列）时按**字面**继续判定 —— 宁可多挡，不可漏放。
 */
export function guardedStaticFirstSegment(rawPath: unknown): string | null {
  let p = String(rawPath ?? '');
  if (!p) {
    return null;
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // 解不开就按原样判定（下面还会合并斜杠与归一化）
  }
  // Windows 风格分隔符与重复斜杠都要收掉：`//export/` 与 `/export/` 是同一个目录
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (p === '/static') {
    // 静态根本身（没有尾斜杠）：不是"逃出"，也不需要挡，交给 serve-static 处理目录请求
    return null;
  }
  const hadStaticPrefix = p.startsWith('/static/');
  p = path.posix.normalize(p);
  if (!p.startsWith('/static/')) {
    if (hadStaticPrefix) {
      // ⚠️ 原本以 /static 开头、归一化后却逃出去了（`/static/%2e%2e/export/x` → `/export/x`）。
      // serve-static 的 send 层会拒这种"恶意路径"，但**守卫不该把判断权交出去** ——
      // 返回 ESCAPED 让调用方直接 403，比"交给下游、指望它也挡住"稳。
      return ESCAPED;
    }
    // `/static` 本身（没有尾斜杠）不算：那是目录列表请求，由 serve-static 处理
    return null;
  }
  const rest = p.slice('/static/'.length);
  const seg = rest.split('/')[0];
  // ⚠️ 小写化再比：部署在 Linux 上时 `Export` 与 `export` 是两个目录，
  // 但大小写不敏感的文件系统（macOS/Windows，以及某些挂载选项）上是同一个 ——
  // 守卫的成本是一次 toLowerCase，换掉一整类"换个大小写就绕过去"。
  return seg ? seg.toLowerCase() : null;
}

/**
 * 这个请求是否该被 403 挡掉。
 *
 * @param rawPath      `req.path`（原始、未解码）
 * @param backupFirstSegment 当 `backupPath` 恰好在 `staticPath` 里面时，它相对 static 的第一段；
 *                           否则传 null。这是"万一有人把备份目录配到静态目录里"的兜底。
 */
export function isGuardedStaticPath(rawPath: unknown, backupFirstSegment: string | null): boolean {
  const seg = guardedStaticFirstSegment(rawPath);
  if (!seg) {
    return false;
  }
  if (seg === ESCAPED || GUARDED_STATIC_SEGMENTS.has(seg)) {
    return true;
  }
  return !!backupFirstSegment && seg === backupFirstSegment;
}

/**
 * 由 backupPath / staticPath 算出上面那个"兜底第一段"。
 * 备份目录不在静态目录里时返回 null（正常部署就是这样）。
 */
export function backupFirstSegmentUnderStatic(staticPath: string, backupPath: string): string | null {
  const staticRoot = path.resolve(staticPath);
  const backupRoot = path.resolve(backupPath);
  if (!backupRoot.startsWith(staticRoot + path.sep)) {
    return null;
  }
  const rel = path.relative(staticRoot, backupRoot).split(path.sep).join('/');
  return (rel.split('/')[0] || '').toLowerCase() || null;
}
