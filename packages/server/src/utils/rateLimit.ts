import { Request, Response } from 'express';
import { pickSocketIp } from 'src/provider/log/utils';
import { pickTrustedClientIp } from './trustedProxy';
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
 * - `/api/admin/init*` 的**写操作**  10 分钟 5 次   —— 初始化一辈子只该成功一次
 *   ⚠️ 只计**非安全方法**（见 SAFE_METHODS）：这个前缀下没有任何 GET 路由，
 *   而"用 GET 探测站点是否已初始化"的监控曾经把配额吃光、把真正的灾难恢复
 *   锁在门外最长 10 分钟（实测事故，详见下面 init 桶那段注释）。
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

/**
 * 「安全方法」（RFC 9110：语义上只读、不产生副作用）⇒ 用来区分
 * **"读取/探测"** 与 **"写入/消耗资源"** 这两类请求。
 *
 * 为什么需要这个区分：限流桶的额度应当只被"真的会消耗资源或改变状态"的请求吃掉。
 * 一个只读的探测请求既不写库也不解包归档，把它计入配额等于让监控和脚本
 * **替攻击者把站长自己的预算烧光**（init 桶上真实发生过，见下面那条注释）。
 *
 * ⚠️ 判据是"方法是不是安全的"，**不是**"路径在不在白名单里"：白名单式的写法在
 * 将来新增写路由时会**静默漏掉它**（失败方向是"少限流"，比"多限流"危险得多）。
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    // ⚠️ 体量类限流用 `pickTrustedClientIp()`（见 utils/trustedProxy.ts 的说明）：
    // 以前是 `pickClientIp(req) || pickSocketIp(req)`，而 pickClientIp 优先读
    // cf-connecting-ip / x-real-ip / x-forwarded-for —— 全是客户端可控的头，
    // 于是"每个请求换一个头"就能把四档限流全部绕过（实测 20/20 放行）。
    // ⚠️ 防爆破类的计数（登录 / 评论 / 文章解锁）**不要**换成这个函数，
    // 它们继续用 pickSocketIp()：那边的收益正是"换一个 key 重新开始"，理由见 trustedProxy.ts。
    const ip = pickTrustedClientIp(req);
    const path = String((req as any).path || (req as any).url || '');
    const method = String(req.method || 'GET').toUpperCase();

    // `/api/admin/init*`：初始化一辈子只该成功一次，而 `init/upload` 与 `init/restore`
    // 都接受**匿名**的整站归档上传 ⇒ 这个桶要防的是"反复初始化爆破"与"反复上传大归档做放大"。
    //
    // 🔴 判据是**方法**（只计非安全方法），不是"路径落在前缀里就算"。原因（活体实测过）：
    //    这个前缀下**只有三个路由，全是 POST**（`POST /api/admin/init`、`/init/upload`、`/init/restore`，
    //    见 controller/admin/init/init.controller.ts），**没有任何 GET 路由**。而以前是一律计数，
    //    于是任何"用 GET /api/admin/init 判断站点是否已初始化"的监控/脚本/探针都会白吃配额 ——
    //    实测 3 次探测就把 5 次/10 分钟吃光，之后**真正的初始化与灾难恢复被 429 锁死最长 10 分钟**。
    //    也就是"恢复窗口被自己的监控吃掉"，而这正是最不该发生的事（后台 InitPage 甚至为此
    //    专门写了"页面加载时不发探测请求"的注释来绕开它）。
    //    按方法判定之后：读取/探测不计数，写入/消耗资源照旧计数，配额**一点没放宽**。
    // ⚠️ 仍然在**请求进入时**计数，不是等响应出来再计：这个桶要防的正是"反复上传大归档"，
    //    等响应出来再记账，那次上传的开销已经花掉了。所以"只给非 404/405 的响应计数"那种
    //    修法在这里是**错的方向**（它会把防护变成事后统计）。
    // ⚠️ 未初始化时灾难恢复入口必须可用，这条性质不受影响：`init.middleware` 精确放行
    //    `/api/admin/init`，其余 init 子路径靠 app.module 的 exclude 放行，两者都与本桶无关；
    //    本桶只决定"同一个 IP 每 10 分钟能提交几次写请求"。
    if (path.startsWith('/api/admin/init') && !SAFE_METHODS.has(method)) {
      const hit = consumeAttempt(`rl-init-${ip}`, {
        max: scaleLimit(INIT_LIMIT_PER_10MIN),
        windowMs: 10 * 60 * 1000,
      });
      if (!hit.allowed) {
        return tooManyRequests(
          res,
          hit.retryAfterSeconds,
          `初始化/恢复接口调用过于频繁：每 10 分钟最多 ${scaleLimit(INIT_LIMIT_PER_10MIN)} 次写请求，` +
            `约 ${Math.max(1, Math.round(hit.retryAfterSeconds))} 秒后可以重试。` +
            '只有**写操作**（POST 等非安全方法）计入这个额度，GET/HEAD/OPTIONS 不计。' +
            '如果你是在做健康检查或"站点是否已初始化"的状态探测，请改用 GET /api/public/health —— ' +
            '它不占这个额度，也不会把真正的初始化/灾难恢复锁在门外。' +
            '确需更多次恢复尝试（例如反复试口令）可临时调高 VANBLOG_INIT_LIMIT_PER_10MIN。',
        );
      }
    }

    if (path.startsWith('/api/public/') && !SAFE_METHODS.has(method)) {
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
 * ## CSP：只加**零风险**的三条，完整的 script-src 仍然没上
 *
 * 前台/后台都有大量内联样式、bytemd 注入的脚本与可选的第三方统计，所以一份严 CSP
 * （`script-src 'self'`）会直接把站点搞坏，而松 CSP 又等于没有 —— 那件事要先给内联样式/脚本
 * 发 nonce，是另一个量级的工作，**本轮没做**。这里只加三条不依赖 nonce、且经核实不会弄坏任何
 * 现有功能的指令：
 *  - `frame-ancestors 'self'`：与下面既有的 `X-Frame-Options: SAMEORIGIN` **语义一致**
 *    （现代浏览器 CSP 优先，老浏览器读 XFO），所以不会新弄坏什么；后台把**同源**的 waline `/ui`
 *    放进 iframe 是"我们嵌别人"，由 `frame-src` 管、不受 `frame-ancestors` 影响。
 *  - `object-src 'none'`：正文白名单（`packages/website/utils/markdownSanitize.ts` 的 tagNames）
 *    里**没有** `object`/`embed`/`applet`（只有 `iframe`，而 iframe 归 `frame-src` 管），
 *    主题 CSS 也造不出插件内容 ⇒ 没有合法用途会被这条挡掉。
 *  - `base-uri 'none'`：全仓库（website + admin）`<base` **零命中** ⇒ 没人用它改相对 URL 基址。
 *
 * ⚠️ **覆盖面别夸大**：这个中间件在 `main.ts` 里只挂在 `matchesPreNestPrefix(req.path)` 上，
 * 也就是 `/static/`、`/rss/`、`/sitemap/`、`/swagger` 这几条 **pre-Nest** 前缀。前台是独立的
 * Next 进程（caddy 反代过去）、后台是另一套静态产物，**都不经过这里** ⇒ 这三条 CSP 保护的是
 * 静态资源/feed/sitemap/swagger 的响应，不是站点页面。要给全站页面上 CSP，正确的落点是
 * caddy 那一层（`caddyTemplate.json` 的 headers handler，那里能看到所有响应），不在本文件。
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
    if (!res.getHeader('Content-Security-Policy')) {
      // ⚠️ 只有这三条是"加了不可能弄坏功能"的（逐条核实理由见本函数上方的注释）。
      //    要加 script-src / style-src 必须先解决 nonce，别在这里顺手加。
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'none'");
    }
  } catch {
    // 头部设置失败不该影响请求
  }
  return next();
}
