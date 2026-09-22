import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { isStaticAssetPath, normalizeRateLimitPath } from './rateLimit';

/**
 * request-id + 慢请求日志 + （默认关闭的）API 访问日志。
 *
 * 背景（§7.40 B-10）：以前既没有 request-id，也没有任何请求级日志 ——
 * ISR 风暴或 mongo 30 秒 serverSelection 卡顿时，日志里无法把一条错误归因到某次请求。
 *
 * 设计约束（这个中间件跑在**每一个**请求上，开销必须接近零）：
 *  - 没有任何同步文件 I/O；日志走 Nest Logger（与其它组件同一条管道）；
 *  - 每请求分配：一个 id 字符串 + 一个 'finish' 监听器，仅此而已；
 *    `performance.now()` 是单调时钟，两次调用 ~100ns 量级；
 *  - 不改响应体，只加一个响应头；
 *  - 阈值判断只做一次比较；access log 默认**关**，关着时每请求只多一次布尔判断。
 *
 * 入站 `x-request-id` 会被沿用（反代/CDN/前端排障时能把自己的 id 串进来），
 * 但必须通过白名单校验 —— 那个头是客户端可控的，不校验就等于把
 * "往日志里注入任意字符串（含换行伪造日志行）"的口子开在每一个请求上。
 *
 * 环境变量：
 *  - `VANBLOG_SLOW_REQUEST_MS`（默认 **5000**，`0` = 关闭慢请求日志）：
 *    超过这个时长的请求打一条 WARN（含 id、方法、路径、状态码、耗时）。
 *    默认 5 秒：比正常 API 慢一个数量级才报，不会刷屏；又能抓到
 *    mongo 卡顿（serverSelection 默认 10s）这类以前无法归因的事故。
 *  - `VANBLOG_ACCESS_LOG=true`（默认**关**）：每个非静态请求打一行 INFO
 *    （id、方法、路径、状态码、耗时）。排障时打开，平时别开。
 *  - 5xx 永远会打一条 ERROR（不受上面两个开关影响）：这是"错误日志里带 request-id"
 *    的那一条，用户报障时拿着响应头里的 id 就能在日志里定位到同一行。
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/** 入站 id 白名单：字母数字与 . _ -，最长 128（够用且杜绝换行/控制字符注入） */
const INBOUND_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export const SLOW_REQUEST_MS_DEFAULT = 5000;

export interface RequestIdConfig {
  /** >0 时启用慢请求日志（毫秒阈值）；0 = 关 */
  slowMs: number;
  /** 每个非静态请求打一行 INFO */
  accessLog: boolean;
}

export function resolveSlowRequestMs(raw: string | undefined = process.env.VANBLOG_SLOW_REQUEST_MS): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n) || n < 0) {
    return SLOW_REQUEST_MS_DEFAULT;
  }
  return Math.trunc(n);
}

export function resolveAccessLogFlag(raw: string | undefined = process.env.VANBLOG_ACCESS_LOG): boolean {
  return raw === 'true' || raw === '1';
}

/**
 * 清洗入站的 `x-request-id`：合法就沿用，否则返回 null（由调用方生成）。
 * express 对重复头会给数组（`a, b` 或 ['a','b']），取第一个合法值。
 */
export function sanitizeInboundRequestId(value: unknown): string | null {
  if (typeof value === 'string') {
    return INBOUND_ID_RE.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && INBOUND_ID_RE.test(item)) return item;
    }
  }
  return null;
}

export function newRequestId(): string {
  return randomUUID();
}

/** 下游代码（控制器、审计日志）想拿 id 时用这个 */
export function getRequestId(req: any): string | undefined {
  return req?.requestId;
}

export interface RequestIdMiddleware extends RequestIdConfig {
  (req: Request, res: Response, next: NextFunction): void;
}

export function makeRequestIdMiddleware(
  config: RequestIdConfig,
  logger: Logger = new Logger('Request'),
): RequestIdMiddleware {
  const { slowMs, accessLog } = config;
  const middleware = ((req: Request, res: Response, next: NextFunction) => {
    const inbound = sanitizeInboundRequestId(req.headers?.[REQUEST_ID_HEADER]);
    const id = inbound || newRequestId();
    (req as any).requestId = id;
    try {
      res.setHeader(REQUEST_ID_HEADER, id);
    } catch {
      // setHeader 失败（理论上白名单已经挡住了非法字符）不能影响请求本身
    }
    const start = performance.now();
    res.on('finish', () => {
      const ms = Math.round(performance.now() - start);
      const status = res.statusCode;
      const line = `${id} ${req.method} ${req.originalUrl || req.url} ${status} ${ms}ms`;
      if (status >= 500) {
        logger.error(`5xx 请求：${line}`);
        return;
      }
      if (slowMs > 0 && ms >= slowMs) {
        logger.warn(`慢请求（>= ${slowMs}ms）：${line}`);
        return;
      }
      // 🔴 2026-09-22：这里必须喂**归一化后**的路径，与限流分档保持同一口径。
      //    原来传的是原始 `req.path`，而 `isStaticAssetPath` 是**大小写敏感**的 `startsWith('/static/')`；
      //    但 Express 默认 `strict routing=false` 且 `case sensitive routing=false`，静态挂载前缀
      //    同样大小写不敏感（实测 `/STATIC/img/<真文件>` 返回 200 且字节完整）⇒
      //    `/STATIC/...` 这类**真的是静态资源**的请求，在限流侧被归到静态松档、在这里却**不被认出来**，
      //    于是照常写一行访问日志。
      //    ⚠️ 后果不是安全问题（这一行只决定要不要写日志，不参与鉴权/限流/响应），
      //    而是**日志放大**：静态资源是访问量最大的一类路径，正因为如此才被排除在访问日志之外；
      //    留一个"改个大小写就能让每条静态请求都写日志"的口子，等于给磁盘与日志轮转开了一个廉价放大器。
      //    ⚠️ 函数名叫 `normalizeRateLimitPath` 但它其实是**中间件层唯一的路径归一化口径**
      //    （去尾斜杠 + 转小写 + 切掉 query/hash，且**刻意不做百分号解码、不折叠内部斜杠** ——
      //    那会让判定比路由器更宽）。🔴 不要给它改名：`rateLimitPathNormalization.spec.ts`
      //    有三条断言钉着这个名字、中间件里的赋值形状与函数体。
      if (accessLog && !isStaticAssetPath(normalizeRateLimitPath(req.path))) {
        logger.log(`访问：${line}`);
      }
    });
    next();
  }) as RequestIdMiddleware;
  middleware.slowMs = slowMs;
  middleware.accessLog = accessLog;
  return middleware;
}
