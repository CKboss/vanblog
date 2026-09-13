/**
 * server 的默认地址：构建期（SSG）与本地开发都用它兜底。
 *
 * ⚠️ **必须带尾斜杠**：调用方是 `` `${config.baseUrl}api/public/meta` `` 这种拼法
 * （路径不带前导斜杠，见 api/getAllData.ts、api/getArticles.ts），少了尾斜杠就会拼出
 * `http://localhost:3000api/public/meta` → `new URL()` 直接 ERR_INVALID_URL → 整站 500。
 * 以前这个尾斜杠是 `new URL(x).toString()` 顺带补上的，兜底分支绕过了它就漏了。
 */
export const DEFAULT_SERVER_URL = "http://localhost:3000/";

/**
 * 把环境变量里的 server 地址收敛成一个可用的绝对 URL。
 *
 * ⚠️ 这里以前是 `new URL(process.env.VAN_BLOG_SERVER_URL ?? "http://localhost:3000")`，
 * 而 `??` **只拦 undefined/null，拦不住空串**。Dockerfile 里是
 * `ARG VAN_BLOG_BUILD_SERVER` + `ENV VAN_BLOG_SERVER_URL=${VAN_BLOG_BUILD_SERVER}`：
 * 构建时不传这个 arg，环境变量就是**空串**，于是 `new URL('')` 抛
 * `TypeError [ERR_INVALID_URL]`，而且这行在**模块顶层**执行 —— 报错发生在
 * `next build` 的 "Collecting page data" 阶段（`Failed to collect page data for /about`），
 * 栈里只有一串 webpack chunk 编号，根本看不出是环境变量为空。
 *
 * 上游 CI 一直显式传 `VAN_BLOG_BUILD_SERVER=http://localhost:3000`，所以从没暴露过；
 * 一键脚本的默认路径不传，就必然踩到。现在空串 / 纯空白 / 非法 URL 一律回退默认值。
 */
export function resolveServerUrl(raw?: string | null): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return DEFAULT_SERVER_URL;
  }
  try {
    const url = new URL(value);
    // 只认 http/https：`new URL("localhost:3000")` 其实**不会抛**（它把 localhost 当成协议），
    // 但拿这种地址去 fetch 一定失败，所以显式校验协议，不合法就当没设。
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return DEFAULT_SERVER_URL;
    }
    // 统一补尾斜杠：`new URL("https://host/api").toString()` 是**不带**尾斜杠的，
    // 而调用方拼的是 `${baseUrl}api/public/meta`，那样会拼成 `…/apiapi/public/meta`。
    const normalized = url.toString();
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

// 从环境变量中读取.
export const config = {
  baseUrl: resolveServerUrl(process.env.VAN_BLOG_SERVER_URL),
};

// 改为服务端触发 isr
// export const revalidate = {};
export const revalidate =
  process.env.VAN_BLOG_REVALIDATE == "true"
    ? { revalidate: parseInt(process.env.VAN_BLOG_REVALIDATE_TIME || "10") }
    : {};
