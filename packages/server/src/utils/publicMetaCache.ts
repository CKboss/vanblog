/**
 * `GET /api/public/meta` 的进程内短缓存 + **单飞（single-flight）**。
 *
 * 为什么值得缓存：这个接口是**全站最热的一次读**——前台每个页面渲染（SSR/ISR）都要调它，
 * 它自己又要跑 7 个 Mongo 查询（tags / meta / categories / menus / 文章数 / 总字数 / 布局）。
 * 压测里一万条连接同时打它时，30 秒只完成了 1600 个请求；换成 caddy 直服的静态图片，
 * 同样一万条连接 **0.8 秒全部 200**。差距不在网络层，而在"每个请求都要去数据库走一趟"。
 *
 * 内容只在后台改站点信息/菜单/布局时才变，所以缓存 5 秒完全看不出来，
 * 而收益是"同一秒内的一千个请求只查一次库"。
 *
 * ## 为什么光有 TTL 缓存还不够（本轮加的 single-flight）
 *
 * 裸 TTL 缓存有一个**周期性必然发生**的故障形状：TTL 到期的那一瞬间，所有在飞请求**同时未命中**，
 * 于是每个都各自去跑那 7 个查询。1 万并发 ⇒ 瞬时 **7 万个 Mongo 操作**，而连接池
 * `maxPoolSize` 默认只有 **100**（`app.module.ts`，且按 worker 数摊薄），并且**没有配
 * `waitQueueTimeoutMS`** ⇒ 排队等池是**无限等**。结果不是"快速失败"，而是**延迟雪崩**：
 * 请求在内存里堆积、p99 飙升、上游（caddy）等不到响应而 502。
 * 实测形状与此吻合：C10K 下静态路径 10000/10000 全成功，而 `/api/public/meta` 第二轮只有
 * 5033/10000（第一轮打的是热缓存，第二轮撞上 TTL 过期瞬间）。
 *
 * ⚠️ **多开 worker 解决不了这件事**：`scaleLimit()` 会把池大小按 worker 数**摊薄**
 * （`VANBLOG_MONGO_MAX_POOL_SIZE` 默认 100 ⇒ 6 个 worker 每个约 17），**总和仍然约 100**，
 * 这是有意设计（避免 N 个 worker 把 mongo 连接数放大 N 倍）。所以"加 worker"只会让每个进程
 * 各自击穿一次，总查询量不变。真正的修法就是这里：**同一时刻只允许一次取数在飞**。
 *
 * 仓库里已有正确范式可参照：`controller/public/health.controller.ts` 的 `mongoProbing`
 * （并发合并 + 短缓存 + 超时），本文件是同一个思路。
 *
 * ⚠️ 只缓存**公开只读**的这一个接口，不要拿去缓存后台接口（那边要求写后立刻可读）。
 * 设 `VANBLOG_PUBLIC_META_CACHE_MS=0` 可以关掉（关掉时 single-flight 也一并失效，语义与从前一致）。
 */
const RAW = Number(process.env.VANBLOG_PUBLIC_META_CACHE_MS);
export const PUBLIC_META_CACHE_MS = Number.isFinite(RAW) && RAW >= 0 ? Math.floor(RAW) : 5000;

let cache: { at: number; payload: any } | null = null;

/**
 * 在飞的取数 Promise。⚠️ 存 **Promise 而不是 payload** 是这条修复的全部要点：
 * 后来的并发调用者 await 同一个 Promise，于是 N 个请求只产生 1 次底层取数。
 */
let inflight: Promise<any> | null = null;

/**
 * 代号（generation）。`invalidatePublicMetaCache()` 会 +1，
 * 用来防止"在飞的那次取数"把**失效之前**读到的旧数据写回缓存：
 * 后台刚改了站点信息 ⇒  invalidate ⇒ 但一个早于改动就开始的查询稍后返回 ⇒
 * 如果不比对代号，这份**旧**结果会被写进缓存并再活一个 TTL，用户就会看到改之前的站点信息。
 */
let generation = 0;

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
  // ⚠️ 不动 `inflight`（那次取数已经在飞，取消不了），但抬代号 ⇒ 它返回时不会写缓存。
  generation += 1;
}

/**
 * 带单飞的取数：缓存命中直接返回；未命中时**复用同一个在飞 Promise**；
 * 都没有才真正调用 `loader()`。
 *
 * 契约（每一条都有 spec 钉住）：
 * - **N 个并发调用只产生 1 次 `loader()`**（这就是修复本身）；
 * - `loader()` **失败时绝不把 rejected Promise 留在缓存里** —— 否则一次 DB 抖动
 *   会把失败结果钉住整个 TTL，把"抖一下"放大成"5 秒内全站 500"；
 *   同时 `inflight` 必须清掉，让下一个请求能重试；
 * - 失败**不写缓存**（下一次调用会重新取数，而不是返回上一次的旧值）；
 * - 在飞期间被 `invalidate` ⇒ 那次结果**不写缓存**（代号不匹配），但**仍然返回给等待者**
 *   （它们已经在等了，给一份略旧的数据好过给一个错误）；
 * - `PUBLIC_META_CACHE_MS <= 0`（关闭缓存）时**不做单飞**：每次调用都直接走 `loader()`，
 *   与加这个函数之前的语义完全一致 —— 关掉缓存的人要的就是"每次都读库"。
 */
export async function readPublicMetaWithSingleFlight<T>(loader: () => Promise<T>): Promise<T> {
  const hit = readPublicMetaCache();
  if (hit) {
    return hit as T;
  }
  if (PUBLIC_META_CACHE_MS <= 0) {
    return loader();
  }
  if (inflight) {
    return (await inflight) as T;
  }

  const startedAt = generation;
  const pending = (async () => {
    const payload = await loader();
    // ⚠️ 只有代号没变才写缓存：期间被 invalidate 过就说明这份数据可能已经过期。
    if (generation === startedAt) {
      writePublicMetaCache(payload);
    }
    return payload;
  })();

  inflight = pending;
  try {
    return await pending;
  } finally {
    // ⚠️ 无论成功失败都要清 `inflight`：留着的话，失败会被后续所有调用者共享，
    //    变成"一次抖动 → 整个 TTL 内所有人都拿到同一个拒绝"。
    if (inflight === pending) {
      inflight = null;
    }
  }
}

/** 测试用：当前是否有在飞的取数（不要在业务代码里用） */
export function isPublicMetaInFlight(): boolean {
  return inflight !== null;
}
