import axios from 'axios';

/**
 * 版本检查的上游地址。**默认关闭**（空 = 不回连任何第三方）。
 *
 * ## 为什么默认从"指向 api.mereith.com"改成"关闭"
 *
 * 旧默认值是上游作者的 `https://api.mereith.com/vanblog/version`，于是：
 *
 * 1. **每次启动都会回连第三方**：`getCachedVersionFromServer()` 还被放在
 *    `controller/admin/meta/meta.controller.ts` 的**构造函数**里（DI 时就触发），
 *    之后每次打开后台也会触发（缓存 1 小时）。回连带出去的是**本站的出口 IP** 与
 *    "这里有人在运营一个 VanBlog"这个事实 —— 在敌意网络里，把这两件事告诉一个
 *    与本部署无关的第三方是不可接受的默认行为（可被用于关联/定位运营者）。
 * 2. **拿到的版本号对本 fork 没有意义**：上游返回的是 `0.54.0` 这类号，而本项目是
 *    `v2026.9.2@23f2e9c` 形状，比较结果只会产生"有新版本"的假警报
 *    （文档里早就记过这个现象）。也就是说这个默认值既有害又无用。
 *
 * 想要这个功能的人显式设置 `VAN_BLOG_VERSION_API` 即可（指向自己的、或任何信任的端点）。
 * 判断"有没有新版"的准确入口是仓库的 Releases 页面，后台「关于」页已经给了链接。
 *
 * ⚠️ 关闭时**一个字节都不发**：`fetchVersionFromServer` 与 `getCachedVersionFromServer`
 *    都会直接短路返回 null，不建连接、不查 DNS、不写缓存。
 */
const RAW_VERSION_API_URL = (process.env.VAN_BLOG_VERSION_API || '').trim();

/** 这些值都当"关闭"处理（大小写不敏感），避免 `VAN_BLOG_VERSION_API=false` 被当成 URL 去请求。 */
const DISABLED_TOKENS = new Set(['', 'off', 'false', 'none', 'disabled', '0']);

export const VERSION_API_ENABLED = !DISABLED_TOKENS.has(RAW_VERSION_API_URL.toLowerCase());

/** 空串 = 关闭。⚠️ 消费方必须先判空，不要把它直接交给 axios。 */
export const VERSION_API_URL = VERSION_API_ENABLED ? RAW_VERSION_API_URL : '';

export const VERSION_FETCH_TIMEOUT_MS = 1500;
export const VERSION_CACHE_TTL_MS = 60 * 60 * 1000;
export const VERSION_FAILURE_CACHE_TTL_MS = 30 * 1000;

export type RemoteVersionInfo = {
  version: string;
  updatedAt: string | Date;
};

let cache: { value: RemoteVersionInfo | null; fetchedAt: number; ttl: number } | null = null;
let inflight: Promise<RemoteVersionInfo | null> | null = null;
let cacheEpoch = 0;

export function resetVersionCache() {
  cache = null;
  inflight = null;
  cacheEpoch += 1;
}

export async function fetchVersionFromServer(): Promise<RemoteVersionInfo | null> {
  // ⚠️ 关闭时一个字节都不发：不建连接、不查 DNS。这是"默认不回连第三方"的实现点，
  //    别把这句挪到 axios 调用之后（那样 DNS 查询已经发生了）。
  if (!VERSION_API_URL) {
    return null;
  }
  try {
    let { data } = await axios.get(VERSION_API_URL, {
      timeout: VERSION_FETCH_TIMEOUT_MS,
    });
    data = data?.data || {};
    if (!data?.version) {
      return null;
    }
    return {
      version: data.version,
      updatedAt: data?.updatedAt || data?.upadtedAt,
    };
  } catch (err) {
    return null;
  }
}

export function refreshVersionCache(): Promise<RemoteVersionInfo | null> {
  if (inflight) {
    return inflight;
  }
  const epoch = cacheEpoch;
  inflight = fetchVersionFromServer()
    .then((value) => {
      if (epoch !== cacheEpoch) {
        return cache?.value ?? null;
      }
      if (value) {
        cache = { value, fetchedAt: Date.now(), ttl: VERSION_CACHE_TTL_MS };
      } else {
        cache = {
          value: cache?.value ?? null,
          fetchedAt: Date.now(),
          ttl: VERSION_FAILURE_CACHE_TTL_MS,
        };
      }
      return cache.value;
    })
    .finally(() => {
      if (epoch === cacheEpoch) {
        inflight = null;
      }
    });
  return inflight;
}

function isCacheFresh() {
  return Boolean(cache && Date.now() - cache.fetchedAt < cache.ttl);
}

/**
 * Instant snapshot of the latest known remote version.
 * Starts a background refresh when the cache is empty or stale.
 * Never waits on the remote API.
 */
export function getCachedVersionFromServer(): RemoteVersionInfo | null {
  // 关闭时连缓存与 inflight 都不碰，直接返回 null（消费方会回落到本站自己的版本号）。
  if (!VERSION_API_URL) {
    return null;
  }
  if (!isCacheFresh()) {
    refreshVersionCache();
  }
  return cache?.value ?? null;
}

/**
 * Same as getCachedVersionFromServer, kept as an async helper so existing
 * callers do not block the request path on the remote version API.
 */
export const getVersionFromServer = async () => getCachedVersionFromServer();
