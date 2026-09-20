import { json } from 'express';

/**
 * JSON body 体积限制：**全局小默认 + 少数后台内容路由单独放宽**。
 *
 * 背景（安全审计 §7.40 B-10）：`express.json({ limit: '50mb' })` 以前挂在**每一个**路由上，
 * 登录、评论、访客计数这些匿名接口也各自敞着 50MB 的解析上限 ——
 * 既是内存风险（并发几个 50MB JSON 就能把堆吃掉），也是现成的 DoS 面。
 * 真正需要大 JSON body 的只有后台的"内容类"路由（文章/草稿正文可以内嵌 base64 图片、
 * 自定义页面的整页 HTML、管线的脚本），它们**全部在 AdminGuard 后面**。
 *
 * 实现方式（main.ts）：
 *  1. 先给这几个前缀挂一个大限额的 `json()`（`app.use(prefix, bigJson)`）；
 *  2. 再挂全局小限额的 `json()` —— body-parser 解析过一次就会置 `req._body`，
 *     第二个解析器直接跳过，所以每个请求最多被解析一次，没有额外开销。
 *
 * ⚠️ 上传类接口（图片、附件、主题、备份恢复、JSON 导入）走的是 **multipart + multer**，
 * 根本不经过 `express.json`，它们的限额在 `utils/uploadLimits.ts` 与
 * `backup.controller.ts` 的 RESTORE_UPLOAD_OPTIONS 里，这里管不着也不需要管。
 *
 * 环境变量（都接受 body-parser/bytes 认识的写法：纯数字=字节，或 `1mb` / `512kb` 这类字符串；
 * 非法值一律回落默认，绝不让 NaN 进解析器）：
 *  - `VANBLOG_JSON_BODY_LIMIT`（默认 **1mb**）：全局 JSON body 上限
 *  - `VANBLOG_JSON_BODY_LIMIT_LARGE`（默认 **50mb**，= 改动前的全局值）：下面这些前缀的上限
 */

/** 全局默认：评论/登录/设置这类 JSON 全都远小于 1MB（express 官方默认是 100kb） */
export const DEFAULT_JSON_BODY_LIMIT = '1mb';
/** 内容类路由默认：与改动前的全局值一致，升级后大文章照常能存 */
export const DEFAULT_JSON_BODY_LIMIT_LARGE = '50mb';

/**
 * 需要大 JSON body 的路由前缀。
 *
 * ⚠️ **这里以前写着"全部在 AdminGuard 后面，匿名请求到不了解析器之后的处理器"，那句话只对
 * 一半，而错的一半正是安全论证的关键**，所以按实测改写：
 *  - 对**处理器**成立：匿名请求确实拿不到 `article.controller` 里的任何逻辑，最终会 401；
 *  - 对**解析与净化不成立**：`main.ts` 的中间件顺序是
 *    `[json][sanitize][static403]…[rateLimit][init][router]`，也就是说 `express.json` 的解析
 *    与 `sanitizeRequestPayloads` 的递归净化都跑在**限流器与鉴权之前**，而这里的四个大限额
 *    解析器是**按路径**挂的（`app.use(prefix, largeJsonParser)`），完全不看身份。
 *    ⇒ 匿名攻击者可以向 `/api/admin/article` 投一个 50MB 的 JSON，我们会先花
 *    **解析 ≈ 2.9 秒 + 净化（无上界时 ≈ 4.6 秒）**，然后才 401；被限流 429 挡下的请求
 *    **同样已经把 CPU 烧完了**，限流器对这条路径零保护。
 *
 * 两道防线（本轮）：
 *  1. 净化侧的**成本上界**在 `utils/sanitizeRequest.ts`（超限直接 413，不是跳过净化）；
 *  2. 解析侧的**匿名限额**就是本文件下面的 `anonymousLargeBodyGuard`：只认"有没有声称身份"
 *     （`token` 头，与 `jwt.strategy.ts` 的 `ExtractJwt.fromHeader('token')` 同源），
 *     没有就用小限额解析器先把 body 解掉并置 `req._body`，后面的大限额解析器会自动跳过。
 *     ⚠️ 这只是粗判：伪造 token 的请求仍会拿到大限额、烧掉解析成本，然后在鉴权层被拒 ——
 *     所以它**必须与第 1 道一起做**，两者互补，任何一道单独都不够。
 *     ⚠️ 这个 guard 需要在 `main.ts` 里挂到大限额解析器**之前**（接线方式见它的文档注释）。
 *
 * 前缀清单：
 *  - `/api/admin/article`    文章创建/更新：正文可内嵌 base64 图片（POST /、PUT /:id、covers/from-content）
 *  - `/api/admin/draft`      草稿创建/更新：同一个编辑器，同样可能带 base64
 *  - `/api/admin/customPage` 自定义页面：整页 HTML/JS 作为 JSON 字符串提交（POST /、PUT /、PUT /file）
 *  - `/api/admin/pipeline`   管线：代码脚本正文（POST /、PUT /:id）
 */
export const LARGE_JSON_BODY_PREFIXES: readonly string[] = [
  '/api/admin/article',
  '/api/admin/draft',
  '/api/admin/customPage',
  '/api/admin/pipeline',
];

/**
 * 声称身份用的请求头名。
 * ⚠️ 必须与鉴权层同源：`jwt.strategy.ts` 是 `ExtractJwt.fromHeader('token')`，
 * `provider/auth/token.guard.ts` 读的也是 `request.headers['token']`。任一侧改名，
 * 这个粗判就会**对所有请求都判成匿名**，把合法的大正文一起拒掉（有守卫钉住）。
 */
export const AUTH_TOKEN_HEADER = 'token';

/**
 * 匿名请求的大 body 挡板：给"需要大 JSON body 的前缀"在**大限额解析器之前**再挂一层。
 *
 * 做法：请求没带 `token` 头时，先用**小限额**（默认 1mb，与全局一致）的 `json()` 解析器把
 * body 解掉 —— body-parser 解析过就会置 `req._body = true`，后面那个大限额解析器会直接跳过，
 * 所以每个请求仍然最多被解析一次。超过小限额时 body-parser 自己抛 413，正是我们要的结果。
 * 带了 `token` 头就原样 `next()`，交给大限额解析器（伪造的 token 会在鉴权层被拒）。
 *
 * ⚠️ **接线（需要 `main.ts` 改两行，本轮那个文件不归我改）**：
 * ```ts
 * const anonymousGuard = anonymousLargeBodyGuard(jsonLimit);   // jsonLimit = 全局小限额
 * for (const prefix of LARGE_JSON_BODY_PREFIXES) {
 *   app.use(prefix, anonymousGuard);   // ← 必须在大限额解析器**之前**
 *   app.use(prefix, largeJsonParser);
 * }
 * ```
 * 顺序反了就没有效果（大限额解析器会先把 body 解掉并置 `req._body`，guard 再进来只会跳过）。
 *
 * @param smallLimit 匿名请求的上限，直接传全局那个 `jsonLimit` 即可（`resolveBodyLimit` 的产物）。
 */
export function anonymousLargeBodyGuard(smallLimit: string): any {
  // 解析器只创建一次：body-parser 的实例是无状态的，复用既省内存也避免每次请求重新编译 limit。
  const smallJsonParser = json({ limit: resolveBodyLimit(smallLimit, DEFAULT_JSON_BODY_LIMIT) });
  return function anonymousLargeBodyGuardMiddleware(req: any, res: any, next: any) {
    // 已经解析过（例如别的解析器抢先跑过）就不再插手，保持"每个请求最多解析一次"的性质。
    if (req?._body) {
      next();
      return;
    }
    const claimed = req?.headers?.[AUTH_TOKEN_HEADER];
    const claimsIdentity = typeof claimed === 'string' ? claimed.trim().length > 0 : Array.isArray(claimed) && claimed.length > 0;
    if (claimsIdentity) {
      next();
      return;
    }
    smallJsonParser(req, res, next);
  };
}

/** bytes 认的写法：`100`、`1mb`、`512kb`、`1.5gb`（大小写不敏感） */
const LIMIT_RE = /^\d+(?:\.\d+)?(?:b|kb|mb|gb)?$/i;

/**
 * 把环境变量清洗成 body-parser 能吃的 limit：
 * 合法就原样用（去掉空白、统一小写），非法/缺失就回落默认值。
 */
export function resolveBodyLimit(raw: string | undefined, fallback: string): string {
  const value = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
  if (!value) return fallback;
  if (!LIMIT_RE.test(value)) return fallback;
  return value;
}
