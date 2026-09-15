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

/**
 * ISR 的时间兜底（秒）。
 *
 * ## 为什么有下限
 *
 * 以前是 `parseInt(process.env.VAN_BLOG_REVALIDATE_TIME || "10")`，两个问题：
 *
 * 1. **没有 NaN 守卫**。这个环境变量是 server 从后台设置里读出来直接塞进子进程环境的
 *    （`website.provider.ts`：`VAN_BLOG_REVALIDATE_TIME: isrConfig.delay`），而后台那个
 *    输入框是自由填写的 `ProFormDigit`。填了空 / 非法值时 `parseInt` 得到 `NaN`，
 *    `{ revalidate: NaN }` 会被 Next 当成"没有 revalidate"，于是**延时模式静默退化成
 *    永不过期** —— 而延时模式恰恰会阻止按需 ISR（server 那边
 *    `isr.provider.ts`：`if (isrConfig?.mode == 'delay') { 阻止按需 ISR; return }`），
 *    结果是页面**再也不会更新**，而且没有任何报错。
 * 2. **下限太低**。`revalidate: 10` 意味着有流量时每个页面每 10 秒重渲染一次，
 *    本站一轮是 ~130 个路由（每篇文章的数字 id 与拼音别名两条路径 + 分页 + 分类 +
 *    标签 + 6 个固定页），而**每次重渲染都要回调 server 的公开接口**
 *    （`getPublicMeta` 有 5s 进程内缓存也扛不住 10s 一轮）。这正是 server 那边
 *    要加"风暴互斥 + 每小时兜底"的原因。
 *
 * 取 60 秒：博客正文改完 1 分钟内可见，重渲染频率降到原来的 1/6。
 * ⚠️ 后台那个输入框的 tooltip 还写着"默认为 10 秒"（`packages/admin` 不在本次改动范围内），
 * 文档与 tooltip 需要同步（见 docs/advanced/isr.md）。
 */
export const MIN_REVALIDATE_SECONDS = 60;
/** 延时模式下环境变量缺失 / 非法时的取值（以前是 10）。 */
export const DEFAULT_REVALIDATE_SECONDS = 60;
/**
 * 按需模式（server 主动触发 ISR）下的"长保险"：24 小时。
 *
 * 以前按需模式返回的是 `{}`（即 `revalidate: false`），配合 `fallback: "blocking"`，
 * 一个按需生成的页面**永远不会因为时间而过期**。正常路径下 server 每次保存都会触发
 * `/api/revalidate`，所以看不出问题；但只要那一次触发丢了（website 容器正在重启、
 * 网络抖了一下、或者那轮"风暴"被合并掉），这个页面就会**一直停在旧内容上**，
 * 除了手动点后台的"手动触发"没有任何自愈手段。
 * 24 小时的兜底让最坏情况从"永久陈旧"变成"最多陈旧一天"，代价是每天每页多一次
 * 后台重渲染（ISR 是懒触发 + 串行的，不会形成风暴）。
 */
export const ON_DEMAND_REVALIDATE_SECONDS = 24 * 60 * 60;

/**
 * 把环境变量里的秒数收敛成一个可用的 revalidate 值：
 * 空 / 非数字 / NaN / 小于下限 → 取下限；小数向下取整。
 */
export function resolveRevalidateSeconds(
  raw?: string | null,
  fallbackSeconds: number = DEFAULT_REVALIDATE_SECONDS,
): number {
  const floor = Math.max(1, Math.floor(MIN_REVALIDATE_SECONDS));
  const text = String(raw ?? "").trim();
  if (!text) {
    return Math.max(floor, Math.floor(fallbackSeconds));
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed)) {
    return Math.max(floor, Math.floor(fallbackSeconds));
  }
  return parsed < floor ? floor : Math.floor(parsed);
}

// 从环境变量中读取.
export const config = {
  baseUrl: resolveServerUrl(process.env.VAN_BLOG_SERVER_URL),
};

/**
 * `VAN_BLOG_REVALIDATE` 由 server 按后台的 ISR 模式设置：
 * 延时模式 → `"true"` + `VAN_BLOG_REVALIDATE_TIME=<秒>`；按需模式 → `"false"`（不带 TIME）。
 * 两种模式现在都返回一个**数字** revalidate，区别只是数值：
 * 延时模式用用户设的值（带下限），按需模式用 24 小时的长保险。
 */
export const revalidate =
  process.env.VAN_BLOG_REVALIDATE == "true"
    ? { revalidate: resolveRevalidateSeconds(process.env.VAN_BLOG_REVALIDATE_TIME) }
    : { revalidate: ON_DEMAND_REVALIDATE_SECONDS };
