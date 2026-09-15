/**
 * `GET /api/public/meta` 的进程内短缓存。
 *
 * 为什么值得缓存：这个接口是**全站最热的一次读**——前台每个页面渲染（SSR/ISR）都要调它，
 * 它自己又要跑 7 个 Mongo 查询（tags / meta / categories / menus / 文章数 / 总字数 / 布局）。
 * 压测里一万条连接同时打它时，30 秒只完成了 1600 个请求；换成 caddy 直服的静态图片，
 * 同样一万条连接 **0.8 秒全部 200**。差距不在网络层，而在"每个请求都要去数据库走一趟"。
 *
 * 内容只在后台改站点信息/菜单/布局时才变，所以缓存 5 秒完全看不出来，
 * 而收益是"同一秒内的一千个请求只查一次库"。
 *
 * ⚠️ 只缓存**公开只读**的这一个接口，不要拿去缓存后台接口（那边要求写后立刻可读）。
 * 设 `VANBLOG_PUBLIC_META_CACHE_MS=0` 可以关掉。
 */
const RAW = Number(process.env.VANBLOG_PUBLIC_META_CACHE_MS);
export const PUBLIC_META_CACHE_MS = Number.isFinite(RAW) && RAW >= 0 ? Math.floor(RAW) : 5000;

let cache: { at: number; payload: any } | null = null;

export function readPublicMetaCache(): any | null {
  if (!cache || PUBLIC_META_CACHE_MS <= 0) {
    return null;
  }
  if (Date.now() - cache.at > PUBLIC_META_CACHE_MS) {
    cache = null;
    return null;
  }
  return cache.payload;
}

export function writePublicMetaCache(payload: any): void {
  if (PUBLIC_META_CACHE_MS <= 0) {
    return;
  }
  cache = { at: Date.now(), payload };
}

/** 后台改了站点信息/菜单/布局时调用，让下一次请求立刻看到新值（不用等 TTL 过期） */
export function invalidatePublicMetaCache(): void {
  cache = null;
}
