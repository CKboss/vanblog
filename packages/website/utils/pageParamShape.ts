/**
 * 动态路由入参的**廉价形状校验**（`fallback: "blocking"` 的必备护栏）。
 *
 * ## 为什么需要它
 * `packages/website/pages/page/[p].tsx` 与 `pages/post/[id].tsx` 都用
 * `getStaticPaths() → { fallback: "blocking" }`：任何**没在构建期生成过**的路径，
 * 第一次被访问时会现场跑一遍完整的 `getStaticProps`（取数 + SSR + 往 Next 的
 * file-system-cache 写一条），然后把结果缓存下来。
 *
 * 于是攻击者只要不停地请求**互不相同**的随机 URL（`/page/8f3k2`、`/post/zz9-1`、…），
 * 每一个都要付一次完整 SSR 的成本，而且：
 *  - **按 IP 限流挡不住**：每个 URL 只打一次，永远碰不到"同一 IP 每分钟 600 次"那条线；
 *  - **成本落在三面**：CPU（SSR）、Mongo（一次页面渲染要查 meta/settings/文章列表）、
 *    磁盘（Next 14 的 fs cache **没有淘汰上限**，每条都留下 `.html`/`.json`/`.meta`）；
 *  - 磁盘那条尤其阴：写满之后坏的不只是前台，备份、日志、静态产物一起遭殃。
 *
 * 护栏的做法：在 `getStaticProps` **最前面**做一次纯字符串判定，不合法直接
 * `notFound`，**不打 server、不查库、不做 SSR**。合法形状照常渲染（这条最重要 ——
 * 护栏绝不能把真文章/真分页挡掉）。
 *
 * ## ⚠️ 为什么这类校验**不能**用字符白名单
 * 文章有两个入口：`/post/<数字 id>` 与 `/post/<别名>`。别名默认是拼音（ASCII），
 * 但**站长可以自定义成中文** —— `utils/encodeLocationPath.ts` 存在的理由就是
 * "自定义别名是中文时，Location 头里出现非 Latin-1 字符会让 Node 的 setHeader 抛
 * Cannot convert argument to a ByteString"（真实数据里踩过）。
 * 所以这里**只拒"绝不可能是合法别名"的形状**（空、超长、含路径分隔符/`..`/控制字符），
 * 而不是"只允许 [A-Za-z0-9-_]"。后者会把所有中文别名的文章变成 404 —— 那是功能事故，
 * 比它想防的攻击严重得多。
 *
 * ## 校验的是"框架解码之后"的值
 * Next 交给 `getStaticProps` 的 `params.*` 已经解过一层百分号编码，所以 `%2F` 到这里
 * 就是 `/`，会被下面的分隔符检查抓到。**不要再解第二层**：过度解码会把合法的、
 * 字面含 `%` 的别名弄坏，而且双层解码本身就是经典绕过手法（`%252F`）。
 */

/** 别名/入参的长度上限。真实别名是 slug（几十个字符量级），256 已经极其宽裕。 */
export const MAX_ROUTE_PARAM_LENGTH = 256;

/**
 * 控制字符与路径危险字符。
 * ⚠️ 这里**不是**"允许的字符白名单"，而是"绝不可能合法"的黑名单 —— 见文件头。
 *  - `\0`–`\x1f` 与 `\x7f`：控制字符（含换行 ⇒ 日志注入 / 响应头注入的原料）
 *  - `/` 与 `\`：路径分隔符（`%2F` 解码后就是它）
 *  - `..`：路径穿越片段（单独判，因为它由两个合法字符组成）
 */
const FORBIDDEN_PARAM_CHARS = /[\u0000-\u001f\u007f/\\]/;

/** 分页参数：必须是纯十进制数字（`/page/1`、`/page/23`）。 */
const PAGE_NUMBER_SHAPE = /^\d+$/;

/**
 * 两个动态路由共用的"绝不可能是合法入参"判定。
 * 返回 `null` 表示形状可接受；返回字符串表示拒绝原因（便于日志与测试断言）。
 */
export function inspectRouteParamShape(raw: unknown): string | null {
  if (typeof raw !== "string") {
    // 数组形状（catch-all 路由）与非字符串都不是这两个页面会产生的东西
    return "not-a-string";
  }
  if (raw.length === 0) {
    return "empty";
  }
  if (raw.length > MAX_ROUTE_PARAM_LENGTH) {
    return "too-long";
  }
  if (FORBIDDEN_PARAM_CHARS.test(raw)) {
    return "forbidden-char";
  }
  if (raw.includes("..")) {
    return "dot-dot-segment";
  }
  return null;
}

/**
 * `/page/[p]` 的入参校验。
 *
 * @returns 合法时返回页码（≥1 的整数）；非法时返回 `null`。
 *
 * 三条拒绝理由都是真实踩过的：
 *  - 非数字（`/page/abc`）：以前会渲染成第 1 页并返回 **200**，`current` 还是 NaN
 *    ⇒ 分页高亮丢失、"下一页"链接变成 `/page/NaN`；
 *  - `0` / 负数：同上，而且 `skip` 会算出负数；
 *  - **超过 `Number.MAX_SAFE_INTEGER`**：`parseInt("99999999999999999999")` 得到 1e20，
 *    后续 `(page - 1) * pageSize` 的算术就不可靠了（可能得到 Infinity 再传给 Mongo 的 skip）。
 *    2^53 页对任何站点都是荒谬的，所以这条不可能误杀。
 */
export function parsePageNumberParam(raw: unknown): number | null {
  if (inspectRouteParamShape(raw) !== null) {
    return null;
  }
  const text = raw as string;
  if (!PAGE_NUMBER_SHAPE.test(text)) {
    return null;
  }
  const page = parseInt(text, 10);
  if (!Number.isSafeInteger(page) || page < 1) {
    return null;
  }
  return page;
}

/* ⚠️ 这里**故意不提供** post 侧的校验函数。
 *
 * 文章标识的校验已经有唯一的权威实现：`api/getArticles.ts` 的 `isSafeArticleParam()`
 * （黑名单：非空、≤200 字符、不含 `/`、`\`、`..`、`#`、`?`），`pages/post/[id].tsx`
 * 与取数层都在用它。再造一个"post 入参校验"就是第二份真相 —— 本仓库已经因为
 * "同名副本各自演化"吃过亏（两份 markdownSanitize.ts），所以这里只留**分页**与
 * **通用形状判定**，post 侧一律用 `isSafeArticleParam`。
 *
 * 两者的分工与差异（写给要改任一边的人）：
 *  - `isSafeArticleParam`：post 侧权威，黑名单里**没有**控制字符（`\n`、`\0`、`\x7f`）；
 *    那是日志/响应头注入的原料，建议由它的维护者补上（本文件不改别人的模块）。
 *  - `inspectRouteParamShape`：更严的通用形状判定（含控制字符），目前只服务分页参数。
 *  - 两者都**不用字符白名单**：站长的自定义别名可以是中文
 *    （`utils/encodeLocationPath.ts` 存在的理由就是真实数据里有中文别名），
 *    白名单会把那些文章全部变成 404 —— 那是比它想防的攻击严重得多的功能事故。
 *    这条约束由 `__tests__/pageParamShape.spec.ts` 里的跨文件断言钉住。
 */

export default inspectRouteParamShape;
