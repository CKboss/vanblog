/**
 * 带 key 的**进程内短缓存 + 单飞（single-flight）**。
 *
 * ## 为什么需要它（而不是复用 `utils/publicMetaCache.ts`）
 *
 * `publicMetaCache.ts` 里的 `readPublicMetaWithSingleFlight<T>(loader)` 虽然是泛型，但它的存储是
 * **无键的单槽**（`readPublicMetaCache()` / `writePublicMetaCache(payload)` 都不接受 key），而且还带着
 * 一套**绑定 meta 失效的"代号"比对**。⇒ 直接拿它缓存别的端点，两个端点的载荷会**互相覆盖**，
 * 而且 meta 的失效逻辑会把别人的缓存一起清掉。
 *
 * 🔴 之所以**新建**一个而不是把 `publicMetaCache.ts` 改成带键的：那个模块是 `GET /api/public/meta`
 * 的**在用**依赖，而 `/meta` 是全站最热的一次读（前台每个页面渲染都要调它），并且已有守卫钉着它的形状。
 * 在一个有守卫的热路径模块上动手术，风险高于新写一个小工具。
 *
 * ## 单飞为什么不是优化而是必需
 *
 * 裸 TTL 缓存有一个**周期性必然发生**的故障形状：TTL 到期的那一瞬间，所有在飞请求**同时未命中**，
 * 于是每个都各自去跑一遍底层查询。这条在本仓库已经实测过（`publicMetaCache.ts` 的头注释记录了
 * `/api/public/meta` 的形状：一万条连接下静态路径 10000/10000 全成功，而 `/meta` 第二轮只有
 * 5033/10000，因为撞上了过期瞬间）。
 *
 * 单飞把"N 个并发请求 ⇒ N 次底层查询"压成"⇒ 1 次"，其余 N-1 个复用同一个 in-flight promise。
 *
 * ## 🔴 失败方向（两条都是硬要求）
 *
 * 1. **loader 抛错时绝不缓存错误**：否则一次瞬时故障（Mongo 抖一下）会把这个端点钉死整整一个 TTL，
 *    把"抖一下"放大成"TTL 内所有人都失败"。⇒ 只有**成功**的结果才写进 cache。
 * 2. **loader 失败时绝不泄漏 in-flight 记录**：否则那个 key 会永久挂起（后来的请求全都 await 一个
 *    已经 rejected 且再也不会被清理的 promise）。⇒ 用 `finally` 清理，无论成功失败。
 *
 * ⚠️ 这两条合起来的语义：**失败时所有已经在等的调用方都会拿到同一个 rejection**（它们共享那个
 * promise），但**下一个新请求会重新触发 loader**。这是有意的：让等待者快速失败，而不是无限等。
 *
 * ## 🔴 为什么是「工厂 + 实例」而不是模块级全局
 *
 * 第一版把 `cache` / `inFlight` 做成了模块级的两个 `Map`。**实测这会打破既有守卫**：
 * `article.provider.slimListView.spec.ts` 与 `tag.provider.slimListView.spec.ts` 都用
 * "每次迭代新建一个 controller + 新的 provider 替身"的手法来观察 `slim` 到底传了什么，
 * 而模块级缓存会让**第二次及以后的迭代直接命中缓存、根本不调用新的替身** ⇒ 断言拿到空数组。
 * 那不是守卫写错了，而是"进程级全局状态在测试之间泄漏"。
 *
 * 改成工厂之后：**生产行为完全相同**（Nest 的 controller 默认是单例、每个进程一个实例，
 * 与模块级 Map 等价；多 worker 时本来就是每进程各一份），而**每个新建的 controller 自带一份空缓存**
 * ⇒ 既有守卫不必改动就继续成立。👉 这也说明一条通用教训：
 * **给一个已被大量白盒守卫覆盖的类加进程级全局状态之前，先想想那些守卫是怎么观察它的。**
 */

/** 默认的 TTL。与 `/api/public/meta` 同量级（它也是 5 秒）。 */
const DEFAULT_TTL_MS = 5000;

/**
 * TTL 的可配置上限。
 *
 * ⚠️ 为什么要有上限：TTL 从环境变量读，而**写错一个零**（想写 5000 写成 50000，
 * 或把毫秒当秒写成 300）就会让公开列表端点陈旧到用户可感知的程度。
 * 🔴 失败方向：非法/缺失 ⇒ 落回 `DEFAULT_TTL_MS`；超出上限 ⇒ 夹到上限。
 * **任何输入都得不到"永不过期"。**
 */
const MAX_TTL_MS = 60000;

function readEnvTtl(): number {
  const raw = Number(process.env.VANBLOG_PUBLIC_LIST_CACHE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_TTL_MS;
  return Math.min(Math.floor(raw), MAX_TTL_MS);
}

function resolveTtl(requested?: number): number {
  if (requested === undefined) return readEnvTtl();
  if (!Number.isFinite(requested) || requested < 0) return readEnvTtl();
  return Math.min(Math.floor(requested), MAX_TTL_MS);
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface KeyedSingleFlight {
  /**
   * 读一个带键的值：命中未过期的缓存就直接返回；否则如果有同键请求正在飞，复用它的 promise
   * （**这就是单飞**）；否则自己发起一次 loader。
   *
   * @param key    缓存键。🔴 **必须包含所有会影响结果的参数**（见 `publicListCacheKey`）——
   *               漏掉一个就会让两种不同语义的调用共享同一份结果。
   * @param loader 真正取数的函数。**只有它成功返回时结果才会被缓存。**
   * @param ttlMs  可选，覆盖默认 TTL（主要给测试用）。同样受 `MAX_TTL_MS` 夹制。
   */
  read<T>(key: string, loader: () => Promise<T>, ttlMs?: number): Promise<T>;
  /** 让某个 key 立刻失效。⚠️ 不影响正在飞的请求。 */
  invalidate(key: string): void;
  /** 清空全部条目（测试用，或将来接显式失效钩子时用）。 */
  clear(): void;
  /** 观测用：活条目数与正在飞的条目数。 */
  stats(): { cached: number; inFlight: number };
}

/** 创建一份独立的单飞缓存。⚠️ 每个持有者一份，不要跨不相关的调用方共享。 */
export function createKeyedSingleFlight(): KeyedSingleFlight {
  const cache = new Map<string, CacheEntry<unknown>>();
  const inFlight = new Map<string, Promise<unknown>>();

  async function read<T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T> {
    if (typeof key !== 'string' || key.length === 0) {
      // 🔴 空 key 会让所有调用方共享一个条目 ⇒ 直接拒绝，不要静默降级成"全局单槽"。
      throw new TypeError('keyedSingleFlight.read: key 必须是非空字符串');
    }
    const ttl = resolveTtl(ttlMs);

    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value as T;
    }
    // ⚠️ 过期条目主动删掉：Map 不会自己回收，而"过期即删"能让 stats() 如实反映活条目数。
    if (hit) cache.delete(key);

    const pending = inFlight.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    const task = (async () => {
      try {
        const value = await loader();
        cache.set(key, { value, expiresAt: Date.now() + ttl });
        return value;
      } finally {
        // 🔴 失败方向 2：无论成功还是抛错都要清掉 in-flight，否则这个 key 永久挂起。
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, task);
    return task;
  }

  return {
    read,
    invalidate(key: string): void {
      cache.delete(key);
    },
    clear(): void {
      cache.clear();
      inFlight.clear();
    },
    stats(): { cached: number; inFlight: number } {
      return { cached: cache.size, inFlight: inFlight.size };
    },
  };
}

export const KEYED_SINGLE_FLIGHT_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
export const KEYED_SINGLE_FLIGHT_MAX_TTL_MS = MAX_TTL_MS;
