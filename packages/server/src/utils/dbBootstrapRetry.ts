import { MongoClient } from 'mongodb';
import { envPositiveInt } from 'src/utils/envNumber';
import { sleep } from 'src/utils/sleep';

/**
 * 启动期"数据库不可达"的**分类 + 退避重试**。
 *
 * ## 为什么需要它（实测，不是假想）
 * 启动路径上有两个**串行**的硬依赖，任何一个失败都会让进程退出：
 *  1. `main.ts` 的 `await initJwt()` —— `utils/initJwt.ts` 内部重试 10 次，每次是
 *     `serverSelectionTimeoutMS`(10s) + `sleep(3000)` ⇒ 约 **130 秒**后 `throw`；
 *  2. `await NestFactory.create(AppModule)` —— 已核实本机安装的 `@nestjs/mongoose@10.1.0`
 *     在 `mongoose-core.module.js:114-119` 里 `return connection.asPromise()`，而 provider 的
 *     `useFactory`（:40）**await** 它 ⇒ **Nest 不可能在数据库不可达时完成 bootstrap**，
 *     约 `serverSelectionTimeoutMS`(10s) 后 reject。
 * 而 `bootstrap()` 的调用点以前是**裸调用、没有 `.catch()`**，`unhandledRejection` 处理器又注册在
 * `initJwt()` 之后 ⇒ 数据库不可达时的现场是"一坨原始 stack + 退出码 1"，没有任何解释。
 *
 * 后果（活体实测）：mongo 在 app **启动期间**不可达 ⇒ 容器约 2 分钟后退出；而 mongo 在**运行期**
 * 被杀 ⇒ health 转 503、**前台首页仍 200**（ISR 缓存继续发布）、mongo 回来 5 秒内自动恢复。
 * **同一场故障，发生在运行期是"降级但仍在发布"，发生在启动期是"完全下线"** —— 这个不对称就是本模块要消除的。
 * 而它在生产里可达：compose 模板为了兼容 docker-compose 1.25 用的是**列表形式** `depends_on`
 * （不做健康门控，模板注释自己写着"最坏只是不等 mongo 就绪"），主机重启 / `docker restart` /
 * 崩溃循环都会走到"app 与 mongo 同时冷启动"这条路。
 *
 * ## 它**不做**什么（同样重要）
 * - **不吞掉非数据库错误**。配置写错、依赖注入失败、代码 bug 一律**立刻**抛出：
 *   对这类错误重试只是把"启动失败"变成"看起来在启动但其实在空转"，排查成本更高。
 *   判据因此是**白名单式**的（见 `isDbUnreachableError`），宁可漏判成"不重试"（快速失败、
 *   日志清楚），也不要误判成"重试"（无限空转）。
 * - **不无限重试**：总窗口有上限，超了就把决定权交给调用方（`main.ts` 进入降级驻留）。
 * - **不阻塞信号处理**：调用方负责在重试期间保持进程可被 SIGTERM 打断。
 */

/** 总重试窗口（毫秒）。默认 5 分钟。 */
export const BOOTSTRAP_DB_RETRY_WINDOW_ENV = 'VANBLOG_BOOTSTRAP_DB_RETRY_WINDOW_MS';
/** 首次重试间隔（毫秒），之后每次翻倍。默认 5 秒。 */
export const BOOTSTRAP_DB_RETRY_BASE_ENV = 'VANBLOG_BOOTSTRAP_DB_RETRY_BASE_MS';
/** 重试间隔封顶（毫秒）。默认 30 秒。 */
export const BOOTSTRAP_DB_RETRY_MAX_ENV = 'VANBLOG_BOOTSTRAP_DB_RETRY_MAX_MS';

export const BOOTSTRAP_DB_RETRY_WINDOW_MS_DEFAULT = 300000;
export const BOOTSTRAP_DB_RETRY_BASE_MS_DEFAULT = 5000;
export const BOOTSTRAP_DB_RETRY_MAX_MS_DEFAULT = 30000;

/**
 * **只有这些错误名**才算"数据库不可达"。
 *
 * ⚠️ 刻意**不含** `MongoParseError`（URI 写错 = 配置错误，重试一万次也不会好，
 * 而且必须让站长立刻看到）、也不含 Nest 的 `UnknownDependenciesException` 之类。
 */
const DB_UNREACHABLE_ERROR_NAMES = new Set([
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoNotConnectedError',
  'MongoTopologyClosedError',
  'MongooseServerSelectionError',
  'MongooseConnectionError',
]);

/**
 * 消息级判据（兜底）：驱动/操作系统的错误名不一定被保留下来，
 * 但 `initJwt` 抛的是**原始** driver 错误，`code` 与 message 里通常带这些标记。
 * ⚠️ 只列"连不上/找不到/网络重置"这类**瞬态**形状，不列"认证失败""权限不足"——
 * 那两种是配置/凭据问题，重试无用且会把真正的错误埋在日志里。
 */
const DB_UNREACHABLE_MESSAGE_PATTERNS: RegExp[] = [
  /server selection timed out/i,
  /connect timed out/i,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /getaddrinfo/i,
];

/** 也认这些 `code`（Node 的网络错误把码放在 `code` 上，message 里不一定有）。 */
const DB_UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * 判断一个错误是不是"数据库暂时不可达"（⇒ 值得重试）。
 *
 * 会顺着 `cause` 链往下看最多 3 层：Node 的 `AggregateError`、mongoose 的包装、
 * 以及 `initJwt` 里"最后一次错误"这种转手抛出，都可能把真实原因埋在下面一层。
 * ⚠️ **绝不抛异常**：判定本身出错就当"不可重试"，让错误按原样冒出去（快速失败优于空转）。
 */
export function isDbUnreachableError(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    try {
      const name = typeof current?.name === 'string' ? current.name : '';
      if (name && DB_UNREACHABLE_ERROR_NAMES.has(name)) {
        return true;
      }
      const code = typeof current?.code === 'string' ? current.code : '';
      if (code && DB_UNREACHABLE_CODES.has(code)) {
        return true;
      }
      const message = typeof current?.message === 'string' ? current.message : '';
      if (message && DB_UNREACHABLE_MESSAGE_PATTERNS.some((re) => re.test(message))) {
        return true;
      }
    } catch {
      // 取值本身出错（例如 getter 抛异常）⇒ 当作不匹配，继续看下一层
    }
    current = current?.cause;
  }
  return false;
}

export interface BootstrapRetryConfig {
  windowMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * 读重试配置。**垃圾值/0/负数一律回落默认**（`envPositiveInt` 的既定语义：≤0 ⇒ fallback），
 * 所以 ⚠️ `VANBLOG_BOOTSTRAP_DB_RETRY_WINDOW_MS=0` 得到的是**默认 5 分钟**而不是"不重试"。
 * 想要"几乎不重试"请写 `1`。这条歧义在本仓库已经被点名过一次（见 `utils/envNumber.ts`），
 * 所以在这里再写一遍而不是让读者去翻。
 */
export function resolveBootstrapRetryConfig(): BootstrapRetryConfig {
  // ⚠️ 不收 env 参数：`envPositiveInt` 本身就是直接读 `process.env` 的（与 `utils/mongoReady.ts`
  //    同一个口径），多收一个参数会造成"看起来可注入、其实注入不进去"的假象。
  //    测试里直接改 `process.env` 再调即可（本仓库既有 spec 就是这么做的）。
  const windowMs = envPositiveInt(
    BOOTSTRAP_DB_RETRY_WINDOW_ENV,
    BOOTSTRAP_DB_RETRY_WINDOW_MS_DEFAULT,
    0,
    3600000,
  );
  const baseDelayMs = envPositiveInt(
    BOOTSTRAP_DB_RETRY_BASE_ENV,
    BOOTSTRAP_DB_RETRY_BASE_MS_DEFAULT,
    0,
    600000,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    envPositiveInt(BOOTSTRAP_DB_RETRY_MAX_ENV, BOOTSTRAP_DB_RETRY_MAX_MS_DEFAULT, 0, 3600000),
  );
  return { windowMs, baseDelayMs, maxDelayMs };
}

/**
 * 第 `attempt` 次失败后要等多久（attempt 从 1 开始）。
 * 指数退避 + 封顶：5s → 10s → 20s → 30s → 30s …
 * ⚠️ 用 `Math.min` 而不是 `Math.pow` 直接返回：`attempt` 很大时 `2^attempt` 会溢出成 `Infinity`，
 * 而 `Infinity` 传进 `setTimeout` 会变成"立刻触发"（Node 的行为），退避就没了。
 */
export function bootstrapBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  if (!Number.isFinite(attempt) || attempt < 1) {
    return Math.min(baseDelayMs, maxDelayMs);
  }
  const raw = baseDelayMs * 2 ** (attempt - 1);
  if (!Number.isFinite(raw)) {
    return maxDelayMs;
  }
  return Math.min(Math.max(0, Math.floor(raw)), maxDelayMs);
}

export interface BootstrapRetryOptions {
  /** 覆盖总窗口（毫秒）。不传则读环境变量。 */
  windowMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 可注入的 sleep：测试里换成立即 resolve，否则单测要真睡几分钟。 */
  sleepFn?: (ms: number) => Promise<unknown>;
  /** 可注入的时钟。 */
  now?: () => number;
  /** 每次决定重试前的回调（调用方负责打日志）。 */
  onRetry?: (info: {
    attempt: number;
    elapsedMs: number;
    nextDelayMs: number;
    windowMs: number;
    error: unknown;
  }) => void;
  /** 遇到"不可重试"的错误时的回调（在抛出之前调用，便于打一条明确的日志）。 */
  onNonRetryable?: (error: unknown) => void;
}

export interface BootstrapSuccessOutcome {
  ok: true;
  attempts: number;
  elapsedMs: number;
}

export interface BootstrapFailureOutcome {
  ok: false;
  attempts: number;
  elapsedMs: number;
  lastError: unknown;
  /** false = 不是数据库问题（配置/代码错误），调用方应当快速失败。 */
  retryable: boolean;
}

export type BootstrapRetryOutcome = BootstrapSuccessOutcome | BootstrapFailureOutcome;

/**
 * 显式类型守卫。
 *
 * ⚠️ 为什么不直接写 `if (!outcome.ok) { outcome.lastError }`：本项目 server 的 tsconfig 关掉了
 * `strictNullChecks`，在那个配置下**字面量判别式（`ok: true` / `ok: false`）不收窄联合类型**，
 * 直接访问 `lastError` 会报 TS2339（实测）。用户自定义的类型守卫是显式断言，不受这个影响。
 */
export function isBootstrapFailure(
  outcome: BootstrapRetryOutcome,
): outcome is BootstrapFailureOutcome {
  return outcome.ok === false;
}

/**
 * 跑 `fn`，只在"数据库不可达"时按退避重试，直到总窗口耗尽。
 *
 * ⚠️ **绝不抛异常**：所有结果都变成返回值，由调用方决定后果（`main.ts` 在窗口耗尽后进入
 * 降级驻留，而不是退出）。唯一例外是 `fn` 抛出的**非数据库**错误 —— 那种必须原样抛出，
 * 因为吞掉它等于把配置错误伪装成"数据库还没好"。
 */
export async function runBootstrapWithDbRetry(
  fn: () => Promise<unknown>,
  options: BootstrapRetryOptions = {},
): Promise<BootstrapRetryOutcome> {
  const fromEnv = resolveBootstrapRetryConfig();
  const windowMs = options.windowMs ?? fromEnv.windowMs;
  const baseDelayMs = options.baseDelayMs ?? fromEnv.baseDelayMs;
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? fromEnv.maxDelayMs);
  const sleepFn = options.sleepFn ?? sleep;
  const now = options.now ?? (() => Date.now());

  const startedAt = now();
  let attempt = 0;
  let lastError: unknown = null;

  for (;;) {
    attempt += 1;
    try {
      await fn();
      return { ok: true, attempts: attempt, elapsedMs: Math.max(0, now() - startedAt) };
    } catch (err) {
      lastError = err;
      if (!isDbUnreachableError(err)) {
        // 不是数据库问题 ⇒ 立刻交回调用方（并让它抛出），不要重试
        if (options.onNonRetryable) {
          options.onNonRetryable(err);
        }
        throw err;
      }
      const elapsedMs = Math.max(0, now() - startedAt);
      if (elapsedMs >= windowMs) {
        return {
          ok: false,
          attempts: attempt,
          elapsedMs,
          lastError,
          retryable: true,
        };
      }
      const nextDelayMs = Math.min(
        bootstrapBackoffDelayMs(attempt, baseDelayMs, maxDelayMs),
        Math.max(0, windowMs - elapsedMs),
      );
      if (options.onRetry) {
        options.onRetry({ attempt, elapsedMs, nextDelayMs, windowMs, error: err });
      }
      await sleepFn(nextDelayMs);
    }
  }
}

/**
 * 一次性探活：能不能连上 mongo 并 ping 通。
 *
 * 用途是**降级驻留期间的重试判据**：不能每 60 秒就跑一次完整 bootstrap ——
 * `initJwt` 自己会重试 10 次共约 130 秒，那样每轮探测都要占着端口空转两分钟
 * （而降级驻留的占位监听器必须先让出端口，空转期间站点连 503 都给不出来）。
 * 先花 3 秒探一次，通了才真正尝试 bootstrap。
 *
 * ⚠️ 判据与 `utils/mongoReady.ts` / `health.controller.ts` 同源：**连接 + 真实 ping** 两步，
 * 因为"TCP 能连上"不等于"mongod 能应答查询"（初始化数据目录、恢复中都会出现这种中间态）。
 * ⚠️ **绝不抛异常**，也不泄漏 client（`finally` 里关掉，否则每轮探测漏一个连接池 + SDAM 定时器，
 * 这正是 `initJwt` 头注释里记过的那个坑）。
 */
export async function probeMongoOnce(mongoUrl: string, timeoutMs = 3000): Promise<boolean> {
  if (typeof mongoUrl !== 'string' || !mongoUrl.trim()) {
    return false;
  }
  let client: MongoClient | null = null;
  try {
    client = new MongoClient(mongoUrl, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    await client.connect();
    await client.db().admin().ping();
    return true;
  } catch {
    return false;
  } finally {
    if (client) {
      await client.close().catch(() => undefined);
    }
  }
}
