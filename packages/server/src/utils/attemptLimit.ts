/**
 * 一个极小的内存计数器，用来给「没有登录态、又不该被无限试」的接口做限流。
 *
 * 目前用在 `POST /api/public/article/:id`（输密码解锁加密文章）：
 * 密码是明文比较、又没有任何限制，等于可以无限速爆破。
 * 另外 `utils/rateLimit.ts`（全局/静态/公开写/初始化四档）、
 * `provider/comment/comment.provider.ts`（评论频率、每日上限、同内容去重）、
 * 以及 `provider/auth/login.guard.ts`（登录失败窗口，经 `peekAttempts` /
 * `recordFailureAttempt` 这对只读+只写的入口）也用它。
 *
 * ⚠️ 登录窗口以前存在 `CacheProvider` 里 —— 那是一张**没有任何上界**的普通对象，
 *    而它的 key 是 `login-<客户端 IP>`，攻击者换着源 IP 打登录就能让堆单调增长到 OOM
 *    （匿名可达、无需任何凭据）。搬进这张表之后就受 `MAX_BUCKETS` 与"按 count 淘汰最冷"
 *    的保护：洪水用的一次性桶（count=1）先被淘汰，正在被限流的热桶一条都不动。
 *    ⇒ **规矩：任何"按外部输入分桶"的计数都必须放在这张表里**，不要新开一张 Map/对象。
 *
 * ⚠️ 这是**长驻进程里唯一一张会被外部输入撑大的表**，所以三件事必须成立：
 *  1. **有过期清扫**：桶只在"同一个 key 再次进来"时才会被替换，于是一个只来过一次的
 *     IP（扫描器、NAT 池、IPv6 /64）会把它的桶永远留在这张表里。现在每
 *     `SWEEP_INTERVAL_MS` 惰性扫一遍，把已经过窗口的桶删掉（不开定时器，
 *     免得把 jest / 优雅退出吊住）。
 *  2. **超限时绝不 `clear()`**：老实现是"超过 20000 个 key 就整张表清空"。
 *     key 里含**攻击者可控**的成分（`unlock-<ip>-<路径参数前 80 字>`、
 *     以及限流那四档用的 `pickClientIp()`——它读 cf-connecting-ip / x-forwarded-for，
 *     这两个头客户端想写什么就写什么），所以任何人都能用两万个一次性 key
 *     把**所有人**的计数器清零：正在被爆破的登录/解锁/评论限制全部重新开始，
 *     而且清完还能再清（每两万个请求一次）。现在改成"先扫过期，还超就按 count
 *     从小到大淘汰到 90% 水位"：洪水用的一次性桶（count=1）先走，
 *     正在被限流的热桶（count>1）一条都不动。
 *  3. **key 长度有上限**：调用方传进来的 key 可能带 URL 片段，长度不由我们决定。
 *
 * 实测内存（`vanblog_dev/audit-attemptlimit-mem.cjs`，`node --expose-gc`，20 万个一次性 key）：
 * 见 §7.54 的报告；表本身被 `MAX_BUCKETS` 封住，与插入了多少个不同 key 无关。
 */
interface Bucket {
  count: number;
  firstAt: number;
  /** 建桶时调用方给的窗口，只用于过期清扫（判定仍以调用方每次传的 windowMs 为准） */
  windowMs: number;
}

const buckets = new Map<string, Bucket>();

/** 表的硬上限（条数）。到顶时先扫过期、再按 count 淘汰最冷的，**不清空**。 */
export const MAX_BUCKETS = 20000;
/** 淘汰水位：一次淘汰到 90%，免得满了之后每插一个新 key 都要淘汰一次 */
const EVICT_WATERMARK = Math.floor(MAX_BUCKETS * 0.9);
/** 两次过期清扫之间的最小间隔（惰性触发，不开定时器） */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** 满表时那次"额外清扫"的节流间隔（见 consumeAttempt 里的说明） */
const CAP_SWEEP_INTERVAL_MS = 1000;
/** key 长度上限：key 里可能带用户可控的路径片段，不该由它决定内存占用 */
const MAX_KEY_LENGTH = 160;

let lastSweepAt = 0;
let lastCapSweepAt = 0;

const counters = {
  sweeps: 0,
  sweptExpired: 0,
  evicted: 0,
  /** 老实现"整表清空"的次数；新实现永远是 0，留着是给测试当反证用的 */
  cleared: 0,
};

export interface AttemptLimitOptions {
  max: number;
  windowMs: number;
}

/** 归一化 key：非字符串转成字符串，超长截断（限流是尽力而为，截断只会让桶更粗） */
export function normalizeAttemptKey(key: string): string {
  const raw = typeof key === 'string' ? key : String(key ?? '');
  return raw.length > MAX_KEY_LENGTH ? raw.slice(0, MAX_KEY_LENGTH) : raw;
}

/** 删掉所有已经过窗口的桶，返回删了多少条。O(n)，n ≤ MAX_BUCKETS。 */
function sweepExpired(now: number): number {
  let removed = 0;
  // Map 允许在迭代中 delete：被删的条目不会被再访问，后面的条目照常迭代
  for (const [key, bucket] of buckets) {
    if (now - bucket.firstAt > bucket.windowMs) {
      buckets.delete(key);
      removed += 1;
    }
  }
  counters.sweptExpired += removed;
  return removed;
}

/**
 * 淘汰到水位线，返回淘汰条数。
 *
 * 淘汰谁很讲究：这张表被顶满的唯一现实场景是"有人用一次性 key 洪水刷"
 * （`unlock-<ip>-<路径参数>` 的路径参数、伪造的 cf-connecting-ip 都算），
 * 那些桶的 `count` 全是 1；而真正需要被记住的桶（正在被限流的客户端、
 * 登录失败计数、评论频率）`count` 都大于 1。所以**按 count 从小到大淘汰**：
 * 洪水桶先走，热桶一条都不动。
 *
 * ⚠️ 不按 firstAt / 插入顺序淘汰：那样第一个被踢掉的恰好是"用得最久、
 *    count 最高"的那个桶 —— 等于攻击者能把正在被限流的客户端放出来。
 * 也不排序：O(n log n) 的排序正好发生在最不该烧 CPU 的时刻（被洪水打的时候）。
 * 两轮 O(n) 扫描（找最小 count + 删够为止）在两万条时实测约 2ms，
 * 而且只在表满时发生。最后一段按插入顺序兜底，保证 size 一定降到水位以下。
 */
function evictColdest(): number {
  let removed = 0;
  for (let round = 0; round < 3 && buckets.size > EVICT_WATERMARK; round += 1) {
    let min = Infinity;
    for (const bucket of buckets.values()) {
      if (bucket.count < min) min = bucket.count;
    }
    if (!Number.isFinite(min)) break;
    // Map 允许在迭代中 delete：被删的条目不会再被访问，其余条目照常迭代
    for (const [key, bucket] of buckets) {
      if (buckets.size <= EVICT_WATERMARK) break;
      if (bucket.count === min) {
        buckets.delete(key);
        removed += 1;
      }
    }
  }
  for (const key of buckets.keys()) {
    if (buckets.size <= EVICT_WATERMARK) break;
    buckets.delete(key);
    removed += 1;
  }
  counters.evicted += removed;
  return removed;
}

/** 惰性过期清扫：最多每 SWEEP_INTERVAL_MS 一次，且只在表非空时做。 */
function sweepIfDue(now: number): void {
  if (buckets.size && now - lastSweepAt >= SWEEP_INTERVAL_MS) {
    lastSweepAt = now;
    counters.sweeps += 1;
    sweepExpired(now);
  }
}

/**
 * 建新桶之前给表腾地方：先扫过期（一次性 key 的洪水下这里能回收掉绝大部分），
 * 还超就淘汰最冷的（count 最小的）。**绝不清空整张表**（见文件头的说明）。
 *
 * ⚠️ 这次清扫另有 1 秒节流：满表时每个新 key 都会走到这里，不节流就等于
 *    每次插入都扫两万个桶（实测一次 ~5ms 的事件循环阻塞）。
 *    节流期内直接走淘汰 —— 洪水场景下最冷的桶（count=1）本来就是一次性 key，
 *    少扫一遍两万个桶，把事件循环的阻塞从 ~5ms 降到 ~2ms。
 */
function ensureBucketCapacity(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  if (now - lastCapSweepAt >= CAP_SWEEP_INTERVAL_MS) {
    lastCapSweepAt = now;
    counters.sweeps += 1;
    sweepExpired(now);
  }
  if (buckets.size >= MAX_BUCKETS) {
    evictColdest();
  }
}

export function consumeAttempt(
  key: string,
  { max, windowMs }: AttemptLimitOptions,
): { allowed: boolean; retryAfterSeconds: number; count: number } {
  const now = Date.now();
  const bucketKey = normalizeAttemptKey(key);

  sweepIfDue(now);

  const hit = buckets.get(bucketKey);
  if (!hit || now - hit.firstAt > windowMs) {
    ensureBucketCapacity(now);
    buckets.set(bucketKey, { count: 1, firstAt: now, windowMs });
    return { allowed: true, retryAfterSeconds: 0, count: 1 };
  }
  hit.count += 1;
  if (hit.count > max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((hit.firstAt + windowMs - now) / 1000)),
      count: hit.count,
    };
  }
  return { allowed: true, retryAfterSeconds: 0, count: hit.count };
}

/** 只读快照（`peekAttempts` 的返回形状）。 */
export interface AttemptSnapshot {
  /** 窗口内的计数；没有桶或已过窗口 ⇒ 0 */
  count: number;
  /** 按调用方给的 max 判定：`count >= max` 即视为已超限 */
  blocked: boolean;
  retryAfterSeconds: number;
}

/**
 * **只读**地看一眼某个 key 的计数，不建桶、不计数、不改变任何状态。
 *
 * 为什么需要它：`consumeAttempt` 是"调用即计数"，而登录防爆破必须是两阶段的 ——
 * 守卫在**认证之前**只判断"还能不能试"（`LoginGuard.inspect`），计数由 controller 在
 * **认证失败之后**才记（`recordFailure`）。早期实现正是把两件事合成一件，结果
 * "成功登录也算一次失败"，正常用户一分钟内登录 4 次就被锁在门外（见 login.guard.ts 的头注释）。
 * 所以这里必须有一个不产生副作用的读法。
 *
 * ⚠️ 判据是 `count >= max`（与 LoginGuard 历史上的 `count < max ⇒ 放行` 完全一致）：
 *    max=5 时前 5 次失败都放行、**第 6 次**尝试被拒。别改成 `>`，那会白送一次尝试。
 * ⚠️ 只读 ⇒ 不触发淘汰/清扫（读路径必须是无副作用且 O(1) 的，它跑在每个登录请求上）。
 */
export function peekAttempts(
  key: string,
  { max, windowMs }: AttemptLimitOptions,
): AttemptSnapshot {
  const now = Date.now();
  const hit = buckets.get(normalizeAttemptKey(key));
  if (!hit || now - hit.firstAt > windowMs) {
    return { count: 0, blocked: false, retryAfterSeconds: 0 };
  }
  const blocked = hit.count >= max;
  return {
    count: hit.count,
    blocked,
    retryAfterSeconds: blocked
      ? Math.max(1, Math.ceil((hit.firstAt + windowMs - now) / 1000))
      : 0,
  };
}

/**
 * 记一次**失败**，返回新的计数（1 表示这是本窗口的第一次）。
 *
 * 与 `consumeAttempt` 的区别：它不做"是否超限"的判定（判定归 `peekAttempts`，
 * 因为登录的判定发生在认证之前、计数发生在认证之后），也不受 `max` 影响 ——
 * 超限之后继续失败仍然要累加，否则窗口会被无限续期成"永久锁定"。
 *
 * 走的是与 `consumeAttempt` 完全相同的**有界**表：过期清扫、满表按 count 淘汰最冷、
 * key 截断，一样都不少。这正是把登录失败窗口从 `CacheProvider`（一张没有任何上界的
 * 普通对象）搬过来的全部理由：攻击者换着源 IP 打登录，以前能让堆单调增长到 OOM。
 */
export function recordFailureAttempt(key: string, opts: { windowMs: number }): number {
  const { windowMs } = opts;
  const now = Date.now();
  const bucketKey = normalizeAttemptKey(key);

  sweepIfDue(now);

  const hit = buckets.get(bucketKey);
  if (!hit || now - hit.firstAt > windowMs) {
    ensureBucketCapacity(now);
    buckets.set(bucketKey, { count: 1, firstAt: now, windowMs });
    return 1;
  }
  hit.count += 1;
  return hit.count;
}

export function resetAttempts(key: string): void {
  buckets.delete(normalizeAttemptKey(key));
}

/** 只读的可观测面：表大小与清扫/淘汰次数（测试与排障用，不要在请求路径上打日志） */
export function attemptLimitStats(): {
  size: number;
  maxBuckets: number;
  sweeps: number;
  sweptExpired: number;
  evicted: number;
  cleared: number;
} {
  return { size: buckets.size, maxBuckets: MAX_BUCKETS, ...counters };
}

/** 测试专用：把表与计数器清干净（生产代码不要调） */
export function __resetAttemptLimitForTest(): void {
  buckets.clear();
  lastSweepAt = 0;
  lastCapSweepAt = 0;
  counters.sweeps = 0;
  counters.sweptExpired = 0;
  counters.evicted = 0;
  counters.cleared = 0;
}
