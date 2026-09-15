import { Request, Response } from 'express';
import { pickClientIp, pickSocketIp } from 'src/provider/log/utils';
import { consumeAttempt } from './attemptLimit';
import { scaleLimit } from './clusterRole';

/**
 * 粗粒度的全局速率限制 + 安全响应头。
 *
 * 之前只有「登录」（LoginGuard）和「文章解锁」「发表评论」两处有次数限制，
 * 其它公开接口可以被任意高频调用：既能打爆 CPU / 数据库，也方便扫目录。
 * 这里补一层**兜底**限流（不是替代专用限流，专用限流更严）。
 *
 * 分档（都是每 IP）：
 * - `/api/admin/init*`        10 分钟 5 次   —— 初始化一辈子只该成功一次
 * - `/api/public/**` 的写操作  1 分钟 30 次   —— 评论、访客计数这类匿名可写的口子
 * - 其它                       1 分钟 600 次  —— 只用来挡扫描器 / 失控客户端
 *
 * **容器内部调用直接放行**：前台 SSR、waline、ISR 触发都是从 127.0.0.1 发起、
 * 且不带 `X-Forwarded-For` 的（经 caddy 转发的一定带 XFF）。判据同时要求
 * 「socket 是回环」和「没有 XFF」，所以反代后面的真实客户端不会被误放行。
 *
 * 限流组件自己出问题时**放行**（fail-open）：宁可少挡一次，也不能因为一个
 * 计数器把整站搞成 500。
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

/** 读一个正整数环境变量：非法/缺失/越界都夹回合理范围（导出去给 main.ts 复用，别再写一份） */
export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(raw), min), max);
}

export const INIT_LIMIT_PER_10MIN = envInt('VANBLOG_INIT_LIMIT_PER_10MIN', 5, 1, 1000);
export const PUBLIC_WRITE_LIMIT_PER_MIN = envInt('VANBLOG_PUBLIC_WRITE_LIMIT_PER_MIN', 30, 1, 100000);
export const GLOBAL_LIMIT_PER_MIN = envInt('VANBLOG_RATE_LIMIT_PER_MIN', 600, 1, 1000000);
/**
 * 静态资源（`/static/**`：图床图片、缩略图、附件、自定义页面资源）的独立预算，
 * 默认是全局值的 **10 倍**。
 *
 * 为什么必须分开：全局限流挂在 `path: '*'` 上，**每一次图片请求都算一次**。
 * 一篇带 10 张图的文章 = 11 次计数，600/分钟 只够 **~50 次页面浏览/分钟/IP** ——
 * 在公司 NAT、校园网、或者 CDN 回源 IP 没被正确识别（所有访客共用一个 IP）的场景下，
 * 正常读者会被成片 429，看起来像"站点挂了"。压测时第一眼看到的就是这个：
 * 2000 个请求里 1600 多个是 429，全被限流器挡住，测的根本不是栈的容量。
 *
 * 不给"无限"是因为静态目录仍然是最便宜的刷流量入口；给一个宽 10 倍的独立桶，
 * 既能扛住正常的图片密集页面，又不至于让某个人把带宽刷爆。
 */
export const STATIC_LIMIT_PER_MIN = envInt(
  'VANBLOG_STATIC_LIMIT_PER_MIN',
  GLOBAL_LIMIT_PER_MIN * 10,
  1,
  10000000,
);

/** 这个路径算不算"静态资源"（只认前缀，别用正则去猜后缀，省 CPU 也少误判） */
/**
 * ⚠️ 上面这些阈值都是**每进程**的内存计数器：多进程（VANBLOG_CLUSTER_WORKERS>1）时，
 * 同一个 IP 的请求被轮流分到 N 个 worker，每个都只看到 1/N，于是"每分钟 600 次"
 * 实际上会变成 N×600 次 —— 限流器等于被悄悄放宽了 N 倍（登录爆破那一条更是安全问题）。
 * 所以取用时统一过一道 `scaleLimit()`（按 worker 数摊薄，单进程时除数是 1，值不变）。
 * 摊薄是近似的（round-robin 不均匀），但偏差方向是"更严"，对限流来说是安全的那一侧。
 */
export function isStaticAssetPath(path: string): boolean {
  return typeof path === 'string' && path.startsWith('/static/');
}

export function isLoopbackRequest(req: any): boolean {
  const socketIp = pickSocketIp(req);
  if (!LOOPBACK.has(String(socketIp))) {
    return false;
  }
  const headers = req?.headers || {};
  // 经过反代（caddy / nginx）的请求一定带转发头，那种情况按真实客户端 IP 限流
  return !headers['x-forwarded-for'] && !headers['x-real-ip'];
}

/**
 * 是不是「本站内部服务」发来的请求：回环直连，或者带了约定的内部令牌。
 * 用于放开 `pageSize=-1` 这类只该给静态生成用的能力（前后端分离部署时
 * website 容器不在回环上，需要用 `VAN_BLOG_INTERNAL_TOKEN` 表明身份）。
 */
export function isInternalRequest(req: any): boolean {
  if (isLoopbackRequest(req)) {
    return true;
  }
  const expected = String(process.env.VAN_BLOG_INTERNAL_TOKEN || '');
  if (!expected) {
    return false;
  }
  const given = String(req?.headers?.['x-vanblog-internal'] || '');
  if (!given || given.length !== expected.length) {
    return false;
  }
  // 常量时间比较
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { timingSafeEqual } = require('node:crypto');
  return timingSafeEqual(a, b);
}

function tooManyRequests(res: Response, retryAfterSeconds: number, message: string) {
  res.setHeader('Retry-After', String(Math.max(1, retryAfterSeconds)));
  res.status(429).json({ statusCode: 429, message });
}

export function rateLimitMiddleware(req: Request, res: Response, next: () => void) {
  try {
    if (isLoopbackRequest(req)) {
      return next();
    }
    const ip = pickClientIp(req) || pickSocketIp(req) || 'unknown';
    const path = String((req as any).path || (req as any).url || '');
    const method = String(req.method || 'GET').toUpperCase();

    if (path.startsWith('/api/admin/init')) {
      const hit = consumeAttempt(`rl-init-${ip}`, {
        max: scaleLimit(INIT_LIMIT_PER_10MIN),
        windowMs: 10 * 60 * 1000,
      });
      if (!hit.allowed) {
        return tooManyRequests(res, hit.retryAfterSeconds, '初始化接口调用过于频繁，请稍后再试');
      }
    }

    if (path.startsWith('/api/public/') && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const hit = consumeAttempt(`rl-public-write-${ip}`, {
        max: scaleLimit(PUBLIC_WRITE_LIMIT_PER_MIN),
        windowMs: 60 * 1000,
      });
      if (!hit.allowed) {
        return tooManyRequests(res, hit.retryAfterSeconds, '请求过于频繁，请稍后再试');
      }
    }

    // 静态资源走独立桶：一张图也算一次请求，混在全局桶里会把正常的图文页面限死
    if (isStaticAssetPath(path)) {
      const hit = consumeAttempt(`rl-static-${ip}`, {
        max: scaleLimit(STATIC_LIMIT_PER_MIN),
        windowMs: 60 * 1000,
      });
      if (!hit.allowed) {
        return tooManyRequests(res, hit.retryAfterSeconds, '请求过于频繁，请稍后再试');
      }
      return next();
    }

    const global = consumeAttempt(`rl-global-${ip}`, {
      max: scaleLimit(GLOBAL_LIMIT_PER_MIN),
      windowMs: 60 * 1000,
    });
    if (!global.allowed) {
      return tooManyRequests(res, global.retryAfterSeconds, '请求过于频繁，请稍后再试');
    }
    return next();
  } catch {
    // 限流不该成为可用性风险
    return next();
  }
}

/**
 * 安全响应头。
 *
 * 不加 CSP：前台/后台都有大量内联样式、bytemd 注入的脚本与可选的第三方统计，
 * 一份严 CSP 会直接把站点搞坏，而松 CSP 又等于没有 —— 这件事应该单独做，
 * 需要先给内联样式发 nonce。这里只加**零风险**的几项。
 */
export function securityHeadersMiddleware(_req: Request, res: Response, next: () => void) {
  try {
    if (!res.getHeader('X-Content-Type-Options')) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (!res.getHeader('Referrer-Policy')) {
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    }
    if (!res.getHeader('X-Frame-Options')) {
      // SAMEORIGIN 而不是 DENY：后台会把同源的 waline /ui 放进 iframe
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
    if (!res.getHeader('Permissions-Policy')) {
      res.setHeader(
        'Permissions-Policy',
        'geolocation=(), microphone=(), camera=(), payment=(), interest-cohort=()',
      );
    }
  } catch {
    // 头部设置失败不该影响请求
  }
  return next();
}
