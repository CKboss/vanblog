import {
  DEFAULT_FRONT_LOCALE,
  FRONT_LOCALES,
  type FrontLocale,
} from "./i18n";

/**
 * 🔴 前台语种的**持久化**（期 10 第五批，2026-09-30）。
 *
 * ## 站长裁定的方案
 * 站长裁定：「**前台界面上增加一个切换按钮就可以了**」⇒
 * 🔴 **不做 locale 路由**（不加 `/zh/…`、`/en/…` 前缀，不改 Next 的 `i18n` 配置，不动任何 `getStaticProps` 路径），
 * 语种只是一个**客户端偏好**：存在 cookie 里、切换时重渲染。
 *
 * ## 这个选择带来的三条后果（都如实记下，别当下一个人不知道）
 * 1. 🔴 **URL 不变** ⇒ 同一篇文章的中英文界面是同一个地址（分享出去的链接不带语种）。
 *    好处：不需要 🔴 locale 前缀的安全审计（不会把 `/zh/` 漏进鉴权与路径判断）、
 *    sitemap / RSS / feed 的 URL 一个都不用改、ISR 缓存**不用**按语种分键。
 * 2. 🔴 **首屏一定是默认语种（zh-CN）**：静态产物是构建期生成的，服务端不知道访客偏好；
 *    cookie 只能在**客户端**读到（`useEffect` 里）⇒ 挂载后才切成访客上次的语种。
 *    ⚠️ 这意味着"刷新页面时会先看到一帧中文再切换"。要消掉这一帧只有两条路：
 *    ① 在 `_document` 里注入一段**内联脚本**在绘制前读 cookie 并设 `<html lang>`（会造成 CSP 与内联脚本问题）；
 *    ② 改成 SSR/边缘渲染按请求头决定（那就不是"只加个按钮"了）。
 *    👉 本批**不做**这两条，如实登记为已知限制（§7.207 D）。
 * 3. 🔴 **构建期/管线期的文案不跟着切换**：`getStaticProps` 里构造的数据（例如 `api/getAllData.ts` 的导航标题）
 *    与 markdown 处理管线里写进 AST 的属性（`codeBlock.tsx` 的复制按钮 aria-label）
 *    在**构建期/处理期**就已经是中文了 ⇒ 切换语种不会改变它们，除非改成"渲染期取文案"。
 *    这两处已在收口台账里登记为欠条并写明原因。
 *
 * ## 为什么用 cookie 而不是 localStorage
 * 🔴 因为 cookie **将来能被服务端读到**（如果哪天要做 SSR 首屏就对，或加 `Vary: Cookie`），
 * 而 localStorage 永远只有客户端能读。现在虽然只在客户端读，但选 cookie 不给将来堵路。
 * ⚠️ 刻意**不设** `Secure` / `SameSite=None`：这是个纯前端偏好，不是凭据；
 * 设 `SameSite=Lax`（默认）即可，避免跨站请求带上它。
 * 🔴 也刻意**不设过期时间之外的任何身份信息**：值只有 `zh-CN` / `zh-TW` / `en-US` 三种，
 * 读出来还要过一遍白名单（`normalizeLocale`）—— 🔴 **cookie 是不可信输入**，
 * 直接把它塞进 `<html lang>` 或词典查询是注入面（例如 `"><script>`）。
 */

export const LOCALE_COOKIE_NAME = "vanblog_locale";

/** 🔴 cookie 的存活时间：一年（这是个偏好，不是会话状态；关掉浏览器还应该记得）。 */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * 🔴 把任意输入收敛成受支持的语种；不认就返回默认语种。
 * 这一步**必须**有：cookie 与 URL 参数都是不可信输入，
 * 而语种值会被写进 `<html lang>`（屏幕阅读器据此选发音规则）。
 */
export function normalizeLocale(raw: unknown): FrontLocale {
  if (typeof raw !== "string") return DEFAULT_FRONT_LOCALE;
  const v = raw.trim();
  // 精确匹配优先（zh-CN / zh-TW / en-US）
  const exact = FRONT_LOCALES.find((x) => x.toLowerCase() === v.toLowerCase());
  if (exact) return exact;
  // 🔴 宽容匹配：浏览器给的是 `zh`、`zh-Hans-CN`、`en-GB` 这类 ⇒ 按主语言与脚本推断
  const lower = v.toLowerCase();
  if (lower.startsWith("zh")) {
    // 繁体信号：tw / hk / mo / hant（🔴 `zh-CN` 与 `zh-Hans` 一定是简体）
    if (/(^|-)(tw|hk|mo|hant)(-|$)/.test(lower)) return "zh-TW";
    return "zh-CN";
  }
  if (lower.startsWith("en")) return "en-US";
  return DEFAULT_FRONT_LOCALE;
}

/** 🔴 从 cookie 串里取一个值（不做 decode 之外的任何解释）。 */
export function readCookieValue(cookieString: string, name: string): string | null {
  if (typeof cookieString !== "string" || !cookieString) return null;
  for (const part of cookieString.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * 🔴 读当前保存的语种偏好（只在客户端有意义；SSR 期返回默认语种）。
 * 返回 `null` 表示"访客从没选过"——调用方据此决定要不要跟随浏览器语言（见 `detectInitialLocale`）。
 */
export function readSavedLocale(): FrontLocale | null {
  if (typeof document === "undefined" || typeof document.cookie !== "string") return null;
  const raw = readCookieValue(document.cookie, LOCALE_COOKIE_NAME);
  if (raw == null || raw.trim() === "") return null;
  return normalizeLocale(raw);
}

/** 🔴 写语种偏好（切换按钮调它）。`path=/` 保证站内任何页面都能读到。 */
export function writeSavedLocale(locale: FrontLocale): void {
  if (typeof document === "undefined") return;
  if (!FRONT_LOCALES.includes(locale)) return; // 🔴 白名单：绝不把非法值写进 cookie
  document.cookie = [
    `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}`,
    "path=/",
    `max-age=${LOCALE_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ].join("; ");
}

/**
 * 🔴 首次访问时决定用哪个语种：**先看 cookie，没有再看浏览器语言**。
 * ⚠️ 刻意**不**默认跟随浏览器语言去改站点默认语种：站点内容本身是中文的
 * （文章正文不做多语言，站长裁定），所以"浏览器是英文就把界面切英文"会让
 * 英文界面里夹着中文正文 —— 这是**站长要权衡**的事，不能替他决定。
 * 👉 因此这里的策略是保守的：**只有访客自己按过切换按钮（有 cookie）才生效**；
 * 没有 cookie 就一律用站点默认语种（zh-CN）。
 * 🔴 这条策略是有意为之，改动它之前先读上面这段理由。
 */
export function detectInitialLocale(): FrontLocale {
  return readSavedLocale() ?? DEFAULT_FRONT_LOCALE;
}
