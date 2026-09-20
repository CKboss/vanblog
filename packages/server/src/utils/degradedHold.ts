import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';

/**
 * **降级驻留**：数据库在启动期一直不可达时，用一个极小的占位 HTTP 服务把端口接住，
 * 让容器**不退出**、让运维能**看出发生了什么**。
 *
 * ## 为什么需要它（实测的不对称）
 * mongo 在**运行期**被杀：`/api/public/health` 转 503 degraded，而**前台首页仍 200**
 * （ISR 缓存继续对外发布），mongo 回来 5 秒内自动恢复、app 的 `RestartCount` 不变。
 * mongo 在**启动期**不可达：`initJwt()` 约 130 秒后抛出，而 `NestFactory.create` 也会因为
 * `@nestjs/mongoose` 的 `connection.asPromise()` 被 await 而失败 ⇒ 进程退出码 1 ⇒
 * `scripts/start.js` 让容器一起退出（这是它有意的设计，见其头注释）⇒ **caddy 也死了**，
 * 连 `/static/*`（图片、附件）都发不出去。
 *
 * 也就是说：**同一场故障，发生在运行期是"降级但仍在发布"，发生在启动期是"完全下线"**。
 * 本模块把启动期拉回到运行期的那一档：进程不退、端口有人接、health 给出**与真实契约同形状**的
 * 503 degraded，后台继续探测数据库，一旦可达就关掉占位服务、完成真正的 bootstrap。
 *
 * ## ⚠️ 它的能力边界（必须如实，不能夸大）
 * - **能**保住：容器存活 ⇒ caddy 存活 ⇒ `/static/*`（图片/附件，caddy 直接 file_server，不经 Node）
 *   继续可发；health 是"可诊断的 503"而不是 connection refused；`restart: always` 不会被无意义地反复触发。
 * - **不能**保住：**页面**（`/`、`/post/*`）。前台 Next 子进程是 `websiteProvider.init()` 在 bootstrap
 *   里拉起的，bootstrap 没完成就没有它 ⇒ 页面请求由 caddy 反代到 3001 失败 ⇒ 502。
 *   要让页面在这种状态下也能发，唯一现成的机制是 `VANBLOG_CADDY_SERVE_HTML`
 *   （`provider/caddy/caddy.provider.ts`：caddy 按**哨兵文件**直服 `.next/server/pages/**.html`，
 *   默认 **off**；哨兵写在挂载卷上，且代码明确"读不到设置时绝不删哨兵"⇒ 上一次成功运行留下的哨兵
 *   在重启后仍在）。是否把默认值改成 on/all 属于产品决定（绕过 Next ⇒ 依赖 SSR 的功能会失效），
 *   本模块**不擅自改默认值**。
 * - 它**绝不**假装站点可用：除了 health 之外一律 503，且响应体里写清原因与下一步。
 *   ⚠️ 本仓库有过"容器 Up 但站点坏了、没人知道"的事故（`scripts/start.js` 的头注释就是为它重写的），
 *   所以这里宁可响得难听，也不能安静地装死。
 */

/** 占位服务对非 health 路径返回的原因（也用于日志，两处口径必须一致）。 */
export const DEGRADED_HOLD_REASON =
  'VanBlog 正在启动，但数据库不可达：站点处于「降级驻留」状态，只有 /api/public/health 与 caddy 直服的 /static/* 可用。';

/** 给运维的下一步提示（写进响应体，因为灾难现场未必看得到容器日志）。 */
export const DEGRADED_HOLD_HINT =
  '排查顺序：①./vanblog.sh doctor（会直接说"server 活着但 mongo 连不上"）②确认 mongo 容器在跑且数据目录没坏 '
  + '③数据库起不来时用 ./vanblog.sh restore --offline-full <归档> 恢复 ④进程会持续自动重试，数据库一通就自己恢复，不需要重启容器。';

export interface DegradedHoldOptions {
  port: number;
  /** 监听地址；不传则监听所有网卡（与 server 的默认口径一致）。 */
  host?: string;
  /** 触发降级的原因（**不要**把 mongo URL 放进来：它可能含口令）。 */
  reason: string;
  /** 版本号，放进 health 的 `data.version`，与真实端点同字段。 */
  versionText: string;
  log?: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export interface DegradedHoldHandle {
  /** 关掉占位服务并释放端口（真正的 bootstrap 要接管端口前**必须**先调它）。 */
  close(): Promise<void>;
  /** 实际监听地址，仅用于日志。绑定失败时为 null。 */
  address(): string | null;
}

/**
 * health 的降级响应体，**逐字段对齐** `controller/public/health.controller.ts` 的 503 分支：
 * `statusCode` / `data.status` / `data.mongo` / `data.mongoState` / `data.mongoStateText` /
 * `data.mongoPingMs` / `data.now` / `data.version`。
 *
 * ⚠️ 对齐不是洁癖：镜像的 HEALTHCHECK、`vanblog.sh drill` 与 `doctor` 都读这几个字段
 * （判据是 HTTP `statusCode < 500` 才算健康），字段名或形状一变，那些工具就会**误判**——
 * 而"工具说健康、其实不健康"是本仓库最忌讳的失败方向。
 * ⚠️ 刻意**不加**新字段（例如 `degraded:'bootstrap'`）：真实端点的键集合是被依赖的契约，
 * 多一个键会让"按精确键集合断言"的测试与消费者困惑。启动期的区分信息放在**日志**与
 * 非 health 路径的响应体里，不放在 health 里。
 * `mongoState` 用 mongoose 的 0（disconnected），`mongoPingMs` 用 null（没 ping 过）。
 */
export function degradedHealthBody(versionText: string, now: () => string = () => new Date().toISOString()) {
  return {
    statusCode: 503,
    data: {
      status: 'degraded',
      mongo: 'down',
      mongoState: 0,
      mongoStateText: 'disconnected',
      mongoPingMs: null,
      now: now(),
      version: versionText,
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // ⚠️ 降级状态**绝不能被缓存**：否则数据库恢复后，CDN/浏览器还会继续拿着 503。
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/**
 * 起占位服务。⚠️ **绑定失败不抛异常**，返回 null 并打日志：
 * 端口被占（例如上一次的占位服务还没关干净、或有别的进程）时，
 * "继续重试 bootstrap"仍然比"进程崩掉"好 —— 崩掉就回到"完全下线"那一档了。
 */
export function startDegradedHoldServer(
  options: DegradedHoldOptions,
): Promise<DegradedHoldHandle | null> {
  const log = options.log ?? {
    // eslint-disable-next-line no-console
    log: (m: string) => console.log(m),
    // eslint-disable-next-line no-console
    warn: (m: string) => console.warn(m),
    // eslint-disable-next-line no-console
    error: (m: string) => console.error(m),
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (handle: DegradedHoldHandle | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(handle);
    };

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = (req.url || '/').split('?')[0];
      // ⚠️ 尾斜杠要等价：`/api/public/health/` 也得认，否则健康检查会看到一个 503 JSON
      //    而不是它期待的形状（caddy 与 compose 的探测路径都可能带斜杠）。
      const normalized = url.length > 1 ? url.replace(/\/+$/, '') : url;
      if (req.method === 'GET' && normalized === '/api/public/health') {
        sendJson(res, 503, degradedHealthBody(options.versionText));
        return;
      }
      sendJson(res, 503, {
        statusCode: 503,
        message: DEGRADED_HOLD_REASON,
        hint: DEGRADED_HOLD_HINT,
        reason: options.reason,
      });
    });

    // ⚠️ 必须有 error 监听：没有它，EADDRINUSE 会以"EventEmitter 'error' 无监听者"的形式
    //    变成 uncaughtException ⇒ 进程退出 ⇒ 正是本模块要避免的"完全下线"。
    //    （本仓库已经因为"流没有 error 监听"吃过一次挂死的亏，同一个道理。）
    server.once('error', (err: NodeJS.ErrnoException) => {
      log.error(
        `[degraded-hold] 占位服务绑定失败（${err?.code || ''} ${err?.message || err}）：` +
          `端口 ${options.port} 可能被占用。进程不会退出，会继续重试真正的启动流程。`,
      );
      finish(null);
    });

    const onListening = () => {
      const addr = server.address() as AddressInfo | null;
      log.warn(
        `[degraded-hold] 已进入降级驻留：占位服务监听 ${addr ? `${addr.address}:${addr.port}` : `端口 ${options.port}`}，` +
          `/api/public/health` + ` 返回 503 degraded，其它路径返回 503 并说明原因。`,
      );
      finish({
        close: () =>
          new Promise<void>((resolveClose) => {
            // Node 18+：先把 keep-alive 连接全部断掉，否则 close() 会一直等空闲连接自然超时，
            // 而"关不掉占位服务"就意味着真正的 bootstrap 拿不到端口。
            try {
              (server as any).closeAllConnections?.();
            } catch {
              // 老版本没有这个方法：忽略，close() 仍然会在连接空闲后完成
            }
            server.close(() => resolveClose());
          }),
        address: () => {
          const a = server.address() as AddressInfo | null;
          return a ? `${a.address}:${a.port}` : null;
        },
      });
    };

    if (options.host) {
      server.listen(options.port, options.host, onListening);
    } else {
      server.listen(options.port, onListening);
    }
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 驻留控制器：把「进入 / 让出端口 / 收尾 / 抖动重入」这四件事的**顺序与幂等**收在一处
 * ══════════════════════════════════════════════════════════════════════════ */

/** 何时进入降级驻留。 */
export const DEGRADED_HOLD_MODE_ENV = 'VANBLOG_DEGRADED_HOLD_MODE';
export type DegradedHoldMode = 'immediate' | 'after-window';
export const DEGRADED_HOLD_MODE_DEFAULT: DegradedHoldMode = 'immediate';

/**
 * 解析 `VANBLOG_DEGRADED_HOLD_MODE`。
 *
 * 🔴 **垃圾值回落默认（immediate），绝不当成"关闭"** —— 与本仓库既有口径一致
 * （`VANBLOG_CSP_MODE`、`VANBLOG_HSTS_MAX_AGE` 都是这个方向）：解析失败时应当落到
 * **更安全/更可用**的那一侧，而不是把功能悄悄关掉。
 *
 * ⚠️ 两种模式的差别（实测数字，2026-09-20，mongo 全程不可达、默认配置）：
 *  - `after-window`（旧行为）：先把 `VANBLOG_BOOTSTRAP_DB_RETRY_WINDOW_MS` 整个窗口烧完才驻留。
 *    实测 `+127s` 第 1 次失败 → `+259s` 第 2 次 → `+396s` 才进入驻留 ⇒
 *    **前 6.6 分钟 health 与页面都是 502**（caddy 活着所以 `/static/*` 可用，但页面发不出去）。
 *  - `immediate`（默认）：**先探一次库**，不可达就立刻驻留 ⇒ 502 窗口降到秒级。
 *
 * 🔴 取舍必须如实（这是产品行为变化）：`immediate` 下，一次**短暂**的数据库抖动也会让站点
 * 短暂进入"caddy 直发磁盘上旧 HTML"的模式，期间依赖 SSR 的功能失效（访问密码文章、站内搜索、
 * 阅读数、按需渲染新文章、评论），且 `artifactReaper` 不在跑（那条残余风险已记录在
 * `degradedServeHtml.ts` 的头注释里）。判断：在"极端环境下要持续发布信息"的目标下，
 * **短暂的旧内容远优于 6 分钟的完全不可用**，所以默认 immediate；不接受这个取舍的部署
 * 可以显式设 `after-window` 回到旧行为。
 */
export function resolveDegradedHoldMode(
  raw: unknown = process.env[DEGRADED_HOLD_MODE_ENV],
  log?: { warn(message: string): void },
): DegradedHoldMode {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (text === '') return DEGRADED_HOLD_MODE_DEFAULT;
  if (text === 'immediate' || text === 'after-window') return text;
  try {
    log?.warn(
      `[degraded-hold] ${DEGRADED_HOLD_MODE_ENV}='${String(raw)}' 不是 immediate / after-window 之一，` +
        `已回落到默认 '${DEGRADED_HOLD_MODE_DEFAULT}'（第一次探到数据库不可达就进入降级驻留）。` +
        `⚠️ 回落方向是"更快开始发布缓存内容"，不是"关闭降级驻留"。`,
    );
  } catch {
    /* 日志器坏了也不影响解析结果 */
  }
  return DEGRADED_HOLD_MODE_DEFAULT;
}

export interface DegradedHoldControllerOptions {
  port: number;
  host?: string;
  versionText: string;
  /** 基础探活间隔（`VANBLOG_DEGRADED_HOLD_PROBE_MS`）。 */
  probeMs: number;
  /** 抖动护栏：进出驻留超过这个次数后开始拉长探活间隔。默认 5。 */
  maxFlaps?: number;
  /** 拉长倍率。默认 2。 */
  flapFactor?: number;
  /** 探活间隔上限。默认 600000（10 分钟）。 */
  flapProbeMaxMs?: number;
  log?: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  /**
   * 进入驻留时的**尽力而为**动作（写 caddy 直服哨兵）。
   * ⚠️ 抛异常不会中断驻留：它失败只意味着"页面发不出去"，而占位服务的 health 契约更重要。
   */
  onEnter?: (reason: string) => void | Promise<void>;
  /**
   * 真正启动成功后的**尽力而为**动作（按快照还原哨兵）。
   * ⚠️ 抛异常不会让"已经成功的启动"被回滚成退出码 1。
   */
  onCommit?: () => void | Promise<void>;
}

export interface DegradedHoldController {
  /** 进入驻留：起占位服务 + `onEnter`。**幂等**（已在驻留中则只更新原因）。 */
  enter(reason: string): Promise<void>;
  /**
   * 只**让出端口**（关掉占位服务），哨兵**保留**。
   *
   * 🔴 顺序是有意的：真正的 bootstrap 要 listen 同一个端口，所以必须先关占位；
   * 但哨兵要**留着**，这样 bootstrap 进行期间 caddy 仍在直发磁盘 HTML ⇒
   * **不产生新的 502 空窗**。哨兵的还原推迟到 `commit()`。
   */
  releasePort(): Promise<void>;
  /** 启动成功后收尾：执行 `onCommit`（还原哨兵），标记退出驻留。**幂等**。 */
  commit(): Promise<void>;
  /** 启动又失败（数据库类）：重新起占位服务并记一次抖动。哨兵还在 ⇒ 页面持续可发。 */
  reenter(reason: string): Promise<void>;
  isActive(): boolean;
  flapCount(): number;
  /** 下一次探活该等多久（含抖动退避）。 */
  nextProbeMs(): number;
  address(): string | null;
}

/**
 * 造一个驻留控制器。
 *
 * ## 为什么要有这个东西（而不是把逻辑摊在 main.ts 里）
 * 「立即驻留 + 后台重试」把三件本来串行的事变成了并发：占位服务在监听、哨兵在盘上、
 * 而重试随时可能成功。于是出现两个必须显式处理的形状：
 *  1. **端口冲突**：占位服务还占着端口时 bootstrap 去 listen ⇒ EADDRINUSE ⇒
 *     而这会被 `runBootstrapWithDbRetry` 判成"非数据库错误"⇒ 直接退出码 1。
 *     所以 `releasePort()` 必须在 bootstrap **之前**、且只能由它来关。
 *  2. **重复进出**：数据库通一下又断 ⇒ 驻留→恢复→再驻留来回打转，每轮都写/删哨兵、
 *     每轮都打一堆日志。`reenter()` 记抖动次数，超过阈值后**拉长探活间隔**（指数、有上限）
 *     并 WARN 一次，于是抖动会被"降频"而不是被放大。
 * 把这些收在一个可单测的对象里，`main.ts` 只负责编排 —— 也因为这个对象**能真起 HTTP 被测**，
 * 而 `main.ts` 不能被 import（它在模块加载时就调用 `main()`）。
 */
export function createDegradedHoldController(
  options: DegradedHoldControllerOptions,
): DegradedHoldController {
  const maxFlaps = options.maxFlaps ?? 5;
  const flapFactor = options.flapFactor ?? 2;
  const flapProbeMaxMs = options.flapProbeMaxMs ?? 600000;
  const log = options.log ?? {
    // eslint-disable-next-line no-console
    log: (m: string) => console.log(m),
    // eslint-disable-next-line no-console
    warn: (m: string) => console.warn(m),
    // eslint-disable-next-line no-console
    error: (m: string) => console.error(m),
  };

  let handle: DegradedHoldHandle | null = null;
  let active = false;
  let flaps = 0;
  let flapWarned = false;
  let reason = '';
  /**
   * 本轮"进入驻留"是否还欠一次收尾（还原哨兵）。
   *
   * 🔴 不能用 `active` 代替：`releasePort()` 会把 `active` 置 false（端口必须先让给真正的
   * bootstrap），但那时哨兵**还没**还原 —— 收尾是欠着的。而 `commit()` 必须**每轮只跑一次**：
   * 重复还原会重复打"已退出降级发布"、重复触发 readFailed 的 WARN，也和它自己的文档
   * 承诺（幂等）矛盾。实测就是被这条守卫抓到的：连调两次 commit，onCommit 跑了两次。
   */
  let commitPending = false;

  /** 尽力而为地跑一个回调：它抛异常绝不能让驻留/启动流程死掉。 */
  const bestEffort = async (label: string, fn?: () => void | Promise<void>) => {
    if (!fn) return;
    try {
      await fn();
    } catch (err) {
      log.warn(
        `[degraded-hold] ${label} 失败（${(err as Error)?.message || err}）：` +
          `这是尽力而为的一步，降级驻留与启动流程**继续进行**。`,
      );
    }
  };

  const startPlaceholder = async (why: string) => {
    handle = await startDegradedHoldServer({
      port: options.port,
      host: options.host,
      reason: why,
      versionText: options.versionText,
      log,
    });
    // ⚠️ 绑定失败时 handle 为 null（端口被占）：进程仍然不退出、仍然继续重试，
    //    这与 `startDegradedHoldServer` 自己的契约一致（见其头注释）。
    active = true;
    commitPending = true; // 起了一轮驻留 ⇒ 欠一次收尾
  };

  return {
    async enter(why: string) {
      reason = why;
      if (active) {
        return; // 幂等：已经在驻留中，不重复起监听、不重复写哨兵
      }
      await startPlaceholder(why);
      await bestEffort('进入降级发布（写 caddy 直服哨兵）', () => options.onEnter?.(reason));
    },

    async releasePort() {
      if (!active) return;
      active = false;
      if (handle) {
        const h = handle;
        handle = null;
        try {
          await h.close();
        } catch (err) {
          // ⚠️ 关不掉占位服务就意味着真正的 bootstrap 拿不到端口 ⇒ 必须说出来，
          //    但也不该在这里抛（抛出去会变成"启动流程本身出错"⇒ 退出码 1）。
          log.error(
            `[degraded-hold] 关闭占位服务失败（${(err as Error)?.message || err}）：` +
              `端口 ${options.port} 可能仍被占用，接下来的 listen 可能 EADDRINUSE。`,
          );
        }
      }
    },

    async commit() {
      if (!commitPending) {
        return; // 🔴 幂等：本轮已经收过尾（或从来没进入过驻留）⇒ 不重复还原、不重复打日志
      }
      commitPending = false;
      if (active) {
        // 正常路径下 releasePort() 已经先跑过；这里是兜底（例如调用方漏了）
        await this.releasePort();
      }
      await bestEffort('退出降级发布（还原 caddy 直服哨兵）', () => options.onCommit?.());
    },

    async reenter(why: string) {
      reason = why;
      flaps += 1;
      if (flaps > maxFlaps && !flapWarned) {
        flapWarned = true;
        log.warn(
          `[degraded-hold] ⚠️ 数据库反复通断：已经进出降级驻留 ${flaps} 次（阈值 ${maxFlaps}）。` +
            `为避免"驻留→恢复→再驻留"来回打转（每轮都写/删哨兵、刷日志），` +
            `探活间隔将按 ${flapFactor} 倍逐步拉长，上限 ${Math.round(flapProbeMaxMs / 1000)} 秒。` +
            `这通常意味着数据库本身在抖（副本集选举、OOM 重启、网络分区），` +
            `请查数据库侧而不是本站。`,
        );
      }
      if (active) return; // 幂等
      await startPlaceholder(why);
      // ⚠️ 哨兵在 releasePort() 时被有意保留，所以这里不需要再写一次；
      //    但如果从没进入过（例如占位服务绑定失败过），onEnter 还是要跑。
      await bestEffort('进入降级发布（写 caddy 直服哨兵）', () => options.onEnter?.(reason));
    },

    isActive: () => active,
    flapCount: () => flaps,
    nextProbeMs() {
      if (flaps <= maxFlaps) return options.probeMs;
      const over = flaps - maxFlaps;
      const grown = options.probeMs * Math.pow(flapFactor, over);
      // ⚠️ 指数可能溢出到 Infinity：必须夹到上限，否则"永远不再探活"= 永不自愈
      if (!Number.isFinite(grown)) return flapProbeMaxMs;
      return Math.min(Math.round(grown), flapProbeMaxMs);
    },
    address: () => (handle ? handle.address() : null),
  };
}
