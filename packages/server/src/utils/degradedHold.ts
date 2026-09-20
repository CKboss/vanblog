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
