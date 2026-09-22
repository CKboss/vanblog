/**
 * Cache directives so Cloudflare / CDNs do not store admin HTML or admin API
 * responses when a broad "cache everything" page rule is in front of VanBlog.
 * @see https://github.com/Mereithhh/vanblog/issues/140
 */
export const NO_STORE_CACHE_CONTROL =
  'private, no-store, no-cache, must-revalidate';
export const CDN_NO_STORE = 'no-store';
export const PRAGMA_NO_CACHE = 'no-cache';
export const EXPIRES_IMMEDIATELY = '0';

export const ADMIN_NO_STORE_HEADER_MAP = {
  'Cache-Control': NO_STORE_CACHE_CONTROL,
  'CDN-Cache-Control': CDN_NO_STORE,
  'Cloudflare-CDN-Cache-Control': CDN_NO_STORE,
  Pragma: PRAGMA_NO_CACHE,
  Expires: EXPIRES_IMMEDIATELY,
} as const;

export type HeaderSetter = {
  setHeader(name: string, value: string): unknown;
};

export function normalizeRequestPath(input: string): string {
  if (!input) {
    return '/';
  }
  const withoutQuery = input.split('?')[0].split('#')[0];
  let path = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  if (path.length > 1) {
    path = path.replace(/\/+$/, '');
  }
  return path || '/';
}

export function pathFromRequest(req: {
  path?: string;
  originalUrl?: string;
  url?: string;
}): string {
  return normalizeRequestPath(req.originalUrl || req.url || req.path || '/');
}

/**
 * `/admin` SPA and `/api/admin/*` JSON (including `/api/admin/auth/login`).
 * Does not match public article HTML, `/api/public/*`, or `/_next/static`.
 */
export function isAdminNoStorePath(pathname: string): boolean {
  const path = normalizeRequestPath(pathname);
  // 🔴 2026-09-22 修：比较必须**大小写不敏感**。Express 路由默认大小写不敏感
  //    （`main.ts` 没有设 `case sensitive routing`），所以 `/API/admin/meta` 与 `/api/admin/meta`
  //    命中同一个处理器；而本函数此前用大小写敏感的比较 ⇒ 大写变体上的管理响应**拿不到 no-store**
  //    （活体已证实：`/api/admin/meta` 有 `Cache-Control: private, no-store, …` 与 `CDN-Cache-Control: no-store`，
  //    而 `/API/admin/meta` 同样返回 401 但**完全没有这两个头**）。
  //    ⚠️ 后果要说准：这一层的意义就是"**无条件** no-store"，而它能被大小写绕过 ⇒
  //    在**前面挂了共享缓存/CDN**的部署里，已认证的管理响应可能被存进共享缓存。
  //    ⚠️ 现实可利用性低（默认部署没有共享缓存，且多数 CDN 默认不缓存带凭据头的请求），
  //    但"能被绕过的无条件保证"就不是无条件保证。
  //    🔴 只在**本函数内**小写化，**不改共享的 `normalizeRequestPath`** —— 后者还有别的调用方
  //    （`pathFromRequest` 等），改它会扩大 blast radius 并可能影响别处对路径大小写的语义。
  //    ⚠️ 本函数**只返回布尔、不做 `slice`**，所以用小写副本比较是安全的（不存在偏移切错的问题）。
  const lower = path.toLowerCase();
  return (
    lower === '/admin' ||
    lower.startsWith('/admin/') ||
    lower === '/api/admin' ||
    lower.startsWith('/api/admin/')
  );
}

export function applyNoStoreCacheHeaders(res: HeaderSetter): void {
  res.setHeader('Cache-Control', NO_STORE_CACHE_CONTROL);
  res.setHeader('CDN-Cache-Control', CDN_NO_STORE);
  res.setHeader('Cloudflare-CDN-Cache-Control', CDN_NO_STORE);
  res.setHeader('Pragma', PRAGMA_NO_CACHE);
  res.setHeader('Expires', EXPIRES_IMMEDIATELY);
}

export function hasNoStoreCachePolicy(headers: {
  [key: string]: string | string[] | undefined;
}): boolean {
  const cacheControl = String(headers['cache-control'] || headers['Cache-Control'] || '');
  const cdn = String(
    headers['cdn-cache-control'] || headers['CDN-Cache-Control'] || '',
  );
  const cf = String(
    headers['cloudflare-cdn-cache-control'] ||
      headers['Cloudflare-CDN-Cache-Control'] ||
      '',
  );
  return (
    /no-store/i.test(cacheControl) &&
    /private/i.test(cacheControl) &&
    /no-store/i.test(cdn) &&
    /no-store/i.test(cf)
  );
}
