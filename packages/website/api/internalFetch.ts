/**
 * 前台 **SSR** 阶段调用 server 公开接口时，带上内部令牌头。
 *
 * ## 为什么需要它
 *
 * server 的 `controller/public/public.controller.ts` 只允许 `isInternalRequest(req)`
 * （回环直连 **或** 带 `x-vanblog-internal` 头）使用 `pageSize=-1`（拉全量）。
 * 而前台有三处依赖全量：`pages/post/[id].tsx` 的相关文章、`utils/getPageProps.ts` 的
 * 标签页与时间线（还有总字数统计）。
 *
 * 一体式镜像里前台与 server 同容器，SSR 请求走 `127.0.0.1` ⇒ 天然算内部，一切正常。
 * 但**前后端分离部署**时前台请求的是另一台机器上的 server，不再是回环；
 * 而以前前台的 `fetch` 是裸调用、**一个头都不带**（`VAN_BLOG_INTERNAL_TOKEN` 在整个
 * `packages/website` 里零命中），于是 `pageSize=-1` 被服务端夹到 `MAX_PAGE_SIZE=100`：
 * 标签页/时间线**静默少数据**，不报错、不留日志。而文档一直写着
 * "分离部署时给两边配同一个 `VAN_BLOG_INTERNAL_TOKEN` 即可" —— 配了也没用，
 * 因为没人把它发出去。这个模块就是补上"发出去"这一半。
 *
 * ## 安全边界（三条，缺一不可）
 *
 * 1. **只在服务端加头**：`typeof window === "undefined"` 才读环境变量。
 *    浏览器里即使这个模块被打进 bundle，也不会带上任何头。
 * 2. **变量名不是 `NEXT_PUBLIC_*`**：Next 只会把 `NEXT_PUBLIC_` 前缀的变量内联进客户端产物，
 *    所以令牌的字面值不会出现在任何 JS chunk 里（有 spec 钉住这一点）。
 * 3. **只用于打 server 的 SSR 请求**：浏览器侧那三个相对路径调用
 *    （文章解锁 `getArticles.ts`、阅读数 `getArticleViewer.ts`、搜索 `search.ts`）
 *    **不走这个封装** —— 它们从访客的浏览器发出，带上内部令牌等于把令牌交给访客。
 *
 * ⚠️ 令牌只在**调用时**读取（不是模块加载时），这样测试与运行时改环境变量都能生效，
 * 也避免"构建期把值固化进产物"这种事故。
 */

/** server 侧 `isInternalRequest` 认的头名（见 server 的 `utils/rateLimit.ts`） */
export const INTERNAL_HEADER = "x-vanblog-internal";

/** ⚠️ 不能改成 `NEXT_PUBLIC_*`：那会让 Next 把令牌内联进客户端产物 */
export const INTERNAL_TOKEN_ENV = "VAN_BLOG_INTERNAL_TOKEN";

/** 当前进程该不该带内部令牌头（纯判定，便于单测） */
export function shouldSendInternalToken(
  // ⚠️ 用 Partial：Next 的类型增强把 `NODE_ENV` 声明成 ProcessEnv 的**必填**字段，
  //    所以测试里传 `{ VAN_BLOG_INTERNAL_TOKEN: 'x' }` 这种最小对象会编译不过。
  //    本函数只读一个键，收窄成 Partial 既不影响调用方（process.env 可赋给它），
  //    也不用在测试里到处写 `as unknown as NodeJS.ProcessEnv` 把类型检查关掉。
  env: Partial<NodeJS.ProcessEnv> = process.env,
  isBrowser: boolean = typeof window !== "undefined",
): boolean {
  if (isBrowser) return false;
  const token = env[INTERNAL_TOKEN_ENV];
  return typeof token === "string" && token.trim() !== "";
}

/** 把任意形态的 headers 收敛成一个普通对象（不丢调用方已有的头，例如 Content-Type） */
function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  // Headers 实例
  if (typeof (headers as any).forEach === "function" && typeof (headers as any).get === "function") {
    const out: Record<string, string> = {};
    (headers as any).forEach((value: string, key: string) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [k, v] of headers) out[String(k)] = String(v);
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

/**
 * SSR 阶段的 `fetch`：设了 `VAN_BLOG_INTERNAL_TOKEN` 就带上 `x-vanblog-internal` 头，
 * 没设就与裸 `fetch` 完全等价（一体式部署的行为一点不变）。
 *
 * ⚠️ 只加头，**不改任何业务逻辑**：调用方原有的 try/catch、233 信封处理、
 * `process.env.isBuild` 降级分支都留在原地。
 */
export async function serverFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!shouldSendInternalToken()) {
    return fetch(url, init);
  }
  const token = String(process.env[INTERNAL_TOKEN_ENV] ?? "").trim();
  return fetch(url, {
    ...init,
    headers: { ...toHeaderRecord(init?.headers), [INTERNAL_HEADER]: token },
  });
}
