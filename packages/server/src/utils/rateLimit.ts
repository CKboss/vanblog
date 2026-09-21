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
 * - `/api/public/category`、`/api/public/tag`  1 分钟 60 次
 *   —— 🔴 这两个是全站**单次成本最高**的匿名读（一次返回全部分类/标签及其下全部文章），
 *   所以频次上限比全局档**严 10 倍**。⚠️ 命中这一档之后**仍然会继续走全局档**（取两者中更严的），
 *   不是"二选一"。⚠️ 这一档**豁免本站内部调用**（`isInternalRequest`：回环或内部令牌），
 *   否则前后端分离部署时站点自己的 SSR 会被自己限流。详见 `PUBLIC_LIST_LIMIT_PER_MIN`。
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

/**
 * 🔴 "聚合列表"端点（`/api/public/category`、`/api/public/tag`）的独立预算。
 *
 * ## 为什么这两个端点要单开一档，而不是靠全局的 600/分钟
 * 它们是全站**单次成本最高**的匿名读：一次请求返回**全部分类/标签及其下全部文章**，
 * 服务端要把所有文章从 Mongo 捞回来（`getAll()` 没有 limit/skip，永远捞全表）、在 Node 里分组、
 * 再序列化成 JSON。实测本机 53 篇时单次 22,131 B / p50 22.8 ms；按每条目 417.6 B 线性外推，
 * **50000 篇时单次响应 ≈ 19.9 MB**，而全局桶允许 600 次/分钟/IP
 * ⇒ 修之前**单个 IP 每分钟可造成 ≈ 11.9 GB** 的序列化与出口流量，还不算 Mongo 与分组开销。
 *
 * ## 为什么单飞缓存不足以替代这一档
 * 缓存（`utils/keyedSingleFlight.ts`，默认 5 秒 TTL）消掉的是**Mongo 与分组**那部分成本 ——
 * 同一个 TTL 窗口内无论多少请求，底层只跑一次。
 * 🔴 **但它消不掉"每个请求各自序列化并发送一份完整响应"这件事**：命中缓存的请求仍然要
 * `JSON.stringify` 一遍那 19.9 MB 并写出去。⇒ **频次必须由限流来上界**，两者相乘才是真实上界：
 * 60 次/分钟 × 19.9 MB ≈ **1.19 GB/分钟/IP**（对 50000 篇的极端站点），
 * 而本机这个规模（53 篇）下是 60 × 22 KB ≈ **1.3 MB/分钟/IP**。
 *
 * ## 取 60 的依据
 * ①正常的第三方消费者（主题、聚合器、监控）轮询一个分类/标签列表，**每分钟 60 次已经远超需要**
 * （即每秒一次）；②前台 SSR **完全不受影响** —— 见下面的豁免说明；
 * ③与全局桶 600/分钟相比是**收紧 10 倍**，方向与"单次成本更高的端点应当有更低的频次上限"一致
 * （对照：静态资源那条是**放宽** 10 倍，因为它单次成本极低）。
 * ⚠️ 想放宽就调 `VANBLOG_PUBLIC_LIST_LIMIT_PER_MIN`。
 *
 * 🔴 **失败方向**：`envInt()` 在环境变量**缺失或非法**（非数字、≤0）时返回 fallback，
 * 而 fallback 就是这个较严的 60；超过 `max` 会被夹住 ⇒ **没有任何输入能得到"不限"**。
 */
export const PUBLIC_LIST_LIMIT_PER_MIN = envInt(
  'VANBLOG_PUBLIC_LIST_LIMIT_PER_MIN',
  60,
  1,
  100000,
);

/**
 * 这两个路径算不算"聚合列表"端点。
 *
 * 🔴 **必须先归一化，否则这一档可以被平凡地绕过（活体实测过）**：
 * Express 的默认路由选项是 `strict routing = false` 且 `case sensitive routing = false`，
 * 而本项目**没有**改这两个选项（`main.ts` 里只有 body parser 的设置）。实测四种写法
 * **全部命中同一个处理器、返回同一份 22,131 B 的响应**：
 * `/api/public/category`、`/api/public/category/`、`/API/public/category`、`/api/public/CATEGORY`。
 * ⇒ 如果用"精确相等"判断，攻击者只要加一个尾斜杠或改一个字母的大小写，
 * 就能**照样拿到全量响应、却完全不进这一档**（只剩全局的 600/分钟），限流等于装饰。
 * 所以这里**先去掉尾斜杠、再转小写**，让判定口径与路由的实际匹配口径一致。
 *
 * ⚠️ 归一化只做这两件事，不做百分号解码之类 —— `req.path` 已经是解码后的路径，
 * 而多做一层解码只会引入新的不一致。
 *
 * 🔴 **2026-09-21 更正：上面那句"`req.path` 已经是解码后的路径"是错的**（结论"不要解码"仍然对，
 * 但理由不是这个）。实测（本地起真 Express 逐个打）：`GET /api/public/%63omments` 的
 * `req.path` 是 **`/api/public/%63omments`（原样未解码）**，而且 **HTTP 404** ——
 * 因为 Express 的路由匹配用的就是**未解码**的 pathname。
 * ⇒ 所以"不要解码"的真正理由是：**编码变体根本不会命中任何路由（404）**，
 * 如果我们解码，限流器就会把一批 404 请求算进比路由器更严的档里（口径不一致，方向偏严但没意义）。
 * ⚠️ 同时实测：`//api//public//comments`（内部双斜杠）也是 **404** ⇒ **不要折叠内部斜杠**，
 * 理由同上（折叠会让 404 被算进档里）。只有**尾斜杠**要处理，因为 `strict routing=false`
 * 时尾斜杠是可选的、`/api/public/comments/` 确实 **200**。
 *
 * 🔴 **仍然用相等而不是 `startsWith`**：`/api/public/tag/:name`（单个标签下的文章）也以
 * `/api/public/tag` 开头，但它的形状完全不同 —— 实测 p50 12.8 ms、响应只有 **1,333 B**
 * （只含一个标签下的文章），所以它**不是**同一量级的放大面。
 * 用 `startsWith` 会把它一起卷进这一档，白白收紧一个便宜的端点。
 * ⚠️ **已登记为待办**：`/tag/:name` 目前既不在这一档、也没有单飞缓存，
 * 而它同样会触发一次全表捞取（成本 ≈ 12.8 ms）。它没进本轮范围是因为响应体很小、放大倍数低；
 * 将来若要收，记得连 `Cache-Control` 一起考虑（它也是公开列表）。
 */
export function isPublicAggregateListPath(path: string): boolean {
  const normalized = normalizeRateLimitPath(path);
  if (!normalized) return false;
  return normalized === '/api/public/category' || normalized === '/api/public/tag';
}

/**
 * 🔴 把请求路径归一化成**与 Express 路由匹配口径一致**的形状，供所有"按路径分档"的判定共用。
 *
 * ## 为什么必须有这个函数
 * Express 默认 `case sensitive routing=false` 且 `strict routing=false`，而本项目 `main.ts`
 * 两项都没有改（只读核实过：`main.ts` 里没有 `app.set('case sensitive routing', …)` 与
 * `app.set('strict routing', …)`）⇒ **路由匹配是大小写不敏感、尾斜杠可选的**。
 * 活体实测（dev :3000，全 GET 只读）：
 * `/api/public/category`、`/API/public/category`、`/api/public/CATEGORY`、`/api/public/category/`
 * **四种写法全部 200、且返回逐字节相同的 22,131 B** ⇒ 它们打到的是同一个处理器。
 *
 * 🔴 而限流器的分档判定历史上是**大小写敏感**的 `startsWith`，于是"加个尾斜杠或改个大小写"
 * 就能让请求**照样命中处理器、却完全不进那个更严的档**，只落进全局档（600/分钟）。
 * 受影响的两个严档：`/api/admin/init`（5 次/10 分钟的**初始化/恢复爆破防护**）与
 * `/api/public/`（30/分钟的匿名写档）。
 *
 * ## 口径（三条，每条都有实测依据）
 * 1. **去 query 与 hash**：中间件取的是 `req.path || req.url`，而实测 `req.url` **带 query**
 *    （`req.url="/api/public/comments?x=1"` 而 `req.path="/api/public/comments"`）。
 *    Express 下 `req.path` 总是存在，所以这一条是纵深防御：万一某个调用方只有 `req.url`，
 *    带 query 的路径不会因为多了 `?x=1` 就逃出档位。
 * 2. **去尾斜杠**（`strict routing=false` ⇒ 尾斜杠可选，实测 `/api/public/comments/` 是 200）。
 * 3. **转小写**（`case sensitive routing=false` ⇒ 实测 `/API/public/comments` 是 200）。
 *
 * ⚠️ **刻意不做**的两件事（都实测过，做了反而错）：
 * - **不做百分号解码**：`/api/public/%63omments` 的 `req.path` 原样未解码且 **404** ⇒
 *   解码会把 404 算进档里，与路由器口径不一致。
 * - **不折叠内部斜杠**：`//api//public//comments` 也是 **404** ⇒ 同理。
 *
 * ## 失败方向
 * 非字符串 / 空串 / 归一化后为空 ⇒ 返回 `''`。🔴 `''` **不匹配任何专用档，但仍会落进全局档**
 * （中间件末尾那个 `rl-global-<ip>` 是无条件的）⇒ **绝不存在"因为路径奇怪就不限流"这条路**。
 *
 * ⚠️ **各档的"宽严方向"不一样，所以归一化对它们的影响要分别看**（这条写下来是因为它不显然）：
 * - **严档**（init / public-write / public-list）：归一化让它们**变宽**（更多写法被算进档）⇒ **更安全**。
 * - 🔴 **松档**（static，额度是全局的 10 倍且命中后 `return next()` 跳过全局档）：归一化会让
 *   `/STATIC/x` 也进这一档。实测 `/STATIC/img/<真文件>` 确实 **200 并返回完整 199,304 B**
 *   （`useStaticAssets` 的挂载前缀匹配同样大小写不敏感）⇒ 把它算成静态请求是**符合事实的**；
 *   而且**攻击者并没有获得新能力**：规范写法 `/static/x` 本来就能拿到 6000/分钟，
 *   额度上限没有变，只是大小写变体不再额外消耗全局桶。
 * - ⚠️ **一处刻意的窄化**：裸前缀 `POST /api/public/`（无后续段）归一化成 `/api/public`，
 *   不再匹配 `startsWith('/api/public/')` ⇒ 从 30/分钟落到全局 600/分钟。
 *   这个路径**没有任何处理器**（404），所以消耗的只是一次 404；
 *   而**所有真实路由**（`/api/public/comments` 等）归一化后仍以 `/api/public/` 开头 ⇒ **额度一点没放宽**。
 *   🔴 之所以不改成 `path === '/api/public' || path.startsWith('/api/public/')` 来保住这一格：
 *   `audit-hardening-round4-security-anonymous-writes.spec.ts:57` 钉着
 *   `path.startsWith\('/api/public/'\) && !SAFE_METHODS\.has\(method\)` 这个**逐字形状**，
 *   而那个文件不在本次改动的授权范围内 ⇒ 保留原文，把这一格的取舍显式记在这里并加断言钉住。
 */
export function normalizeRateLimitPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) return '';
  let p = path;
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  p = p.replace(/\/+$/, '');
  return p.toLowerCase();
}

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
    // 🔴 归一化后再分档：Express 的路由匹配大小写不敏感且尾斜杠可选（活体实测过四种写法
    //    返回同一份响应），而下面几档的判定是大小写敏感的 startsWith ⇒ 不归一化就能被
    //    "加个尾斜杠或改个大小写"平凡绕过。口径、失败方向与各档宽严影响见
    //    normalizeRateLimitPath 的文档注释。
    // ⚠️ 下面四个判定的**源码文本一律保持不变**（`path.startsWith('/api/admin/init')`、
    //    `path.startsWith('/api/public/')`、`isStaticAssetPath(path)`、`isPublicAggregateListPath(path)`）：
    //    它们被多条既有守卫按逐字形状钉住，改文本会打红不属于本次授权范围的文件。
    const path = normalizeRateLimitPath((req as any).path || (req as any).url);
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

    // 🔴 聚合列表端点（`/api/public/category`、`/api/public/tag`）的独立预算。
    //    理由、取值依据与"为什么单飞缓存不足以替代这一档"见 PUBLIC_LIST_LIMIT_PER_MIN 的注释。
    //
    // ⚠️ **本站内部调用豁免**：前台 SSR 要渲染分类页/标签页，会调这两个端点。
    //    单容器部署下 website→server 是回环，上面的 `isLoopbackRequest` 已经提前 return 了；
    //    但**前后端分离部署**下 website 容器不在回环上，靠 `VAN_BLOG_INTERNAL_TOKEN` 表明身份
    //    ⇒ 这里必须用 `isInternalRequest()`（它同时覆盖回环与令牌两条路），
    //    否则**站点自己的渲染会被自己的限流器 429 掉**（ISR 批量重渲染时尤其容易撞上）。
    //    ⚠️ `isInternalRequest` 的失败方向是安全的：令牌未配置时它返回 false，
    //    所以"忘了配令牌"只会让内部调用**被限流**（可见的故障），不会让攻击者**被豁免**（静默的漏洞）。
    //
    // 🔴 **通过后故意不 `return next()`，而是继续往下走全局桶**：这两个端点应当**同时**受
    //    "专用档"与"全局档"约束。如果在这里直接放行，就等于把它们从全局桶里摘出去
    //    ⇒ 专用档（60）比全局档（600）严，所以看起来没区别，但那是巧合而不是设计；
    //    一旦有人把专用档调宽到 600 以上，"摘出去"就会静默放宽限流。继续往下走则永远取两者中更严的。
    if (isPublicAggregateListPath(path) && !isInternalRequest(req)) {
      const listHit = consumeAttempt(`rl-public-list-${ip}`, {
        max: scaleLimit(PUBLIC_LIST_LIMIT_PER_MIN),
        windowMs: 60 * 1000,
      });
      if (!listHit.allowed) {
        return tooManyRequests(
          res,
          listHit.retryAfterSeconds,
          '分类/标签列表接口调用过于频繁，请稍后再试。' +
            `这一档默认每 IP 每分钟 ${scaleLimit(PUBLIC_LIST_LIMIT_PER_MIN)} 次，` +
            '可用 VANBLOG_PUBLIC_LIST_LIMIT_PER_MIN 调整。' +
            '若你在做站点聚合，请改用 /api/public/article?category=…&page=…&pageSize=…（那是数据库级分页）。',
        );
      }
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
