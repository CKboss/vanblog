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
 * 需要大 JSON body 的路由前缀（全部在 AdminGuard 后面，匿名请求到不了解析器之后的处理器）：
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
