import { envPositiveInt } from 'src/utils/envNumber';
import { sleep } from 'src/utils/sleep';

/**
 * 等数据库就绪 —— 给"启动期那些**必须**在库可用时才有意义的一次性动作"用的闸门。
 *
 * ## 为什么需要它（实测事故，不是假想）
 * 容器重启时 mongo 可能还在重连（`/api/public/health` 返回 503 degraded），而 `main.ts`
 * 在主实例上会立刻触发**启动全量 ISR 渲染**。那一轮渲染要经前台 SSR 回源查库，库没就绪
 * 就失败，于是 `ISRProvider.activeWithRetry` 把固定 6 次 × 3 秒 ≈ **18 秒**的重试窗口
 * 全部烧光，打出「达到最大增量渲染重试次数！」后**永久放弃**这一轮全量渲染。
 * 站点仍然能对外服务（ISR 缓存 + `fallback:'blocking'` 按需渲染），但**没有预热**：
 * 在敌意环境下，任何能让容器重启的手段（崩溃循环、OOM、`docker restart`）都可能把站点
 * 长期留在"每个页面都靠访客第一次访问才现场渲染"的状态 —— 那正是最贵、最容易被放大攻击的形状。
 *
 * ## 它**不做**什么（同样重要）
 * - **不阻塞 listen**：调用点在 `await listenWithBacklog(...)` 之后，站点先能对外提供
 *   已缓存内容，再慢慢预热。顺序反了就是"为了预热而拒绝服务"。
 * - **不因为超时而放弃启动**：超时只打 WARN 并返回 `ready:false`，调用方继续往下走。
 *   等不到库就宁可退化成按需渲染，也不能让站点起不来。
 * - **不抛异常**：任何一步失败都变成返回值，让调用方决定后果。
 */

/** 等待数据库就绪的总上限（毫秒）。默认 60 秒。 */
export const MONGO_READY_TIMEOUT_ENV = 'VANBLOG_MONGO_READY_TIMEOUT_MS';
/** 轮询间隔（毫秒）。默认 1 秒。 */
export const MONGO_READY_POLL_ENV = 'VANBLOG_MONGO_READY_POLL_MS';

export const MONGO_READY_TIMEOUT_MS_DEFAULT = 60000;
export const MONGO_READY_POLL_MS_DEFAULT = 1000;

/**
 * 只依赖 `Connection` 上我们真的会读的两个成员，便于用假对象测试。
 * `readyState` 的取值沿用 mongoose：0 断开 / 1 已连接 / 2 连接中 / 3 断开中。
 */
export interface MongoReadyConnectionLike {
  readyState?: number;
  db?: { admin(): { ping(): Promise<unknown> } } | null;
}

export interface MongoReadyOptions {
  /** 覆盖总上限（毫秒）。不传则读环境变量，非法值回落默认。 */
  timeoutMs?: number;
  /** 覆盖轮询间隔（毫秒）。不传则读环境变量，非法值回落默认。 */
  pollMs?: number;
  /** 可注入的 sleep：测试里换成立即 resolve，否则单测会真睡一分钟。 */
  sleepFn?: (ms: number) => Promise<unknown>;
  /** 可注入的时钟：测试里用假时间，不必真等。 */
  now?: () => number;
  /** 进度回调（已等待毫秒数 + 当前状态描述）。调用方负责打日志。 */
  onProgress?: (waitedMs: number, stateText: string) => void;
  /** 进度回调的最小间隔（毫秒），避免每秒刷一行日志。默认 5000。 */
  progressEveryMs?: number;
}

export interface MongoReadyResult {
  /** 数据库是否已就绪（`readyState===1` **且** 一次真实的 `ping()` 成功）。 */
  ready: boolean;
  /** 实际等待了多少毫秒。 */
  waitedMs: number;
  /** `ready` = 就绪；`timeout` = 等到上限仍未就绪（调用方应打 WARN 并继续）。 */
  reason: 'ready' | 'timeout';
  /** 最后一次看到的 `readyState`，用于日志（可能是 undefined）。 */
  lastReadyState: number | undefined;
  /** 轮询了多少次，用于日志与测试断言。 */
  polls: number;
}

/**
 * 判定"就绪"用两步，而不只看 `readyState`：
 * 1. `readyState === 1` —— 驱动认为自己连着；
 * 2. `db.admin().ping()` 成功 —— 服务端真的应答。
 *
 * 第 2 步不是多余的：`readyState` 在重连过程中可能停留在 1 而对端已经不再应答，
 * 而启动全量渲染恰恰要在这个窗口里做**几十次**回源查询。`health.controller.ts`
 * 判 `status` 时也是"readyState + ping"两步（本仓库既有口径），这里复用同一个判据，
 * 不再另写一套。ping 失败**不算错误**，只算"还没就绪"，继续轮询。
 */
async function probeOnce(conn: MongoReadyConnectionLike): Promise<boolean> {
  if (conn?.readyState !== 1) {
    return false;
  }
  const db = conn.db;
  if (!db || typeof db.admin !== 'function') {
    // 已连接但 `db` 还没挂上（极短的中间态）：当"还没就绪"，下一轮再看。
    return false;
  }
  try {
    await db.admin().ping();
    return true;
  } catch {
    return false;
  }
}

export function describeReadyState(readyState: number | undefined): string {
  switch (readyState) {
    case 0:
      return '0（已断开）';
    case 1:
      return '1（已连接）';
    case 2:
      return '2（连接中）';
    case 3:
      return '3（断开中）';
    default:
      return `${readyState ?? '未知'}`;
  }
}

/**
 * 轮询等待数据库就绪。**永不抛异常**，超时返回 `ready:false`。
 */
export async function waitForMongoReady(
  conn: MongoReadyConnectionLike | undefined | null,
  options: MongoReadyOptions = {},
): Promise<MongoReadyResult> {
  const sleepFn = options.sleepFn ?? sleep;
  const now = options.now ?? (() => Date.now());
  const timeoutMs =
    options.timeoutMs ??
    envPositiveInt(
      MONGO_READY_TIMEOUT_ENV,
      MONGO_READY_TIMEOUT_MS_DEFAULT,
      0,
      3600000,
    );
  const pollMs =
    options.pollMs ??
    envPositiveInt(MONGO_READY_POLL_ENV, MONGO_READY_POLL_MS_DEFAULT, 50, 60000);
  const progressEveryMs = options.progressEveryMs ?? 5000;

  const startedAt = now();
  let polls = 0;
  let lastReadyState = conn?.readyState;
  let lastProgressAt = -Infinity;

  // ⚠️ `timeoutMs === 0` 是合法的"只探一次、不等待"，不是"无限等"。
  //    无限等在启动路径上是灾难：库永远不回来就永远不预热、也永远不打那条 WARN。
  //    ⚠️ 但只有**编程传入** `options.timeoutMs = 0` 才是这个语义：走环境变量时
  //    `envPositiveInt` 的既定规则是"缺失/空/非数字/NaN/Infinity/**≤0** ⇒ fallback"
  //    （见 utils/envNumber.ts:18），所以 `VANBLOG_MONGO_READY_TIMEOUT_MS=0` 得到的是
  //    **默认 60000**，不是 0。想要"几乎不等"就写 `1`。这条差异写在这里，
  //    是因为"0 到底是关掉还是没配"正是 envNumber 注释里点名要避免的歧义。
  for (;;) {
    polls += 1;
    lastReadyState = conn?.readyState;
    if (await probeOnce(conn as MongoReadyConnectionLike)) {
      return {
        ready: true,
        waitedMs: Math.max(0, now() - startedAt),
        reason: 'ready',
        lastReadyState,
        polls,
      };
    }

    const waited = Math.max(0, now() - startedAt);
    if (waited >= timeoutMs) {
      return {
        ready: false,
        waitedMs: waited,
        reason: 'timeout',
        lastReadyState,
        polls,
      };
    }

    if (options.onProgress && waited - lastProgressAt >= progressEveryMs) {
      lastProgressAt = waited;
      options.onProgress(waited, describeReadyState(lastReadyState));
    }

    // 剩的时间不够一整个轮询间隔时只睡剩下的，避免"多睡一轮"把总等待拉过上限。
    const remaining = timeoutMs - waited;
    await sleepFn(Math.max(0, Math.min(pollMs, remaining)));
  }
}
