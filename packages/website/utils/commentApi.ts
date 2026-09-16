/**
 * 内置评论的前台数据层。
 *
 * 安全前提：这里拿到的所有文本都是**匿名可写**的，渲染时必须过
 * `utils/commentSanitize.ts` 的白名单（见 components/Comment/Content.tsx），
 * 任何字段都不要直接塞进 dangerouslySetInnerHTML 或 href。
 */

export type CommentProviderKind = "builtin" | "waline" | "off";

export interface PublicCommentSetting {
  provider: CommentProviderKind;
  moderation: "post" | "pre" | "none";
  requireEmail: boolean;
  maxContentLength: number;
}

export interface PublicCommentItem {
  id: number;
  path: string;
  rootId: number;
  parentId: number;
  replyToNick?: string;
  nick: string;
  site?: string;
  content: string;
  status: string;
  isAuthor: boolean;
  createdAt: string;
  children?: PublicCommentItem[];
  replyCount?: number;
}

let settingPromise: Promise<PublicCommentSetting | null> | null = null;

/**
 * 评论设置全站只需要取一次（并发调用共享同一个 Promise）。
 *
 * ⚠️ **只缓存成功结果**：以前 `.catch(() => null)` 之后 Promise 被永久缓存，
 * 一次网络抖动（或 server 重启窗口）就会把 null 钉死 —— 这个 SPA 会话里
 * 评论区/评论数**永久**静默失效，刷新前没有任何恢复手段。现在失败/空结果
 * 会把缓存清掉，下一次挂载会重试（getAllData.ts 的 getPublicMeta 同一原则）。
 */
export function loadCommentSetting(): Promise<PublicCommentSetting | null> {
  if (!settingPromise) {
    const promise: Promise<PublicCommentSetting | null> = fetch(
      "/api/public/comments/setting",
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => (json && json.data ? (json.data as PublicCommentSetting) : null))
      .catch(() => null)
      .then((value) => {
        if (value === null && settingPromise === promise) {
          settingPromise = null;
        }
        return value;
      });
    settingPromise = promise;
  }
  return settingPromise;
}

/** 测试/主题切换后强制重新读取 */
export function resetCommentSettingCache(): void {
  settingPromise = null;
}

export async function fetchComments(
  path: string,
  page = 1,
  pageSize = 20,
): Promise<{ total: number; page: number; pageSize: number; data: PublicCommentItem[] }> {
  const query = new URLSearchParams({
    path,
    page: String(page),
    pageSize: String(pageSize),
  });
  const res = await fetch(`/api/public/comments?${query.toString()}`);
  if (!res.ok) {
    throw new Error(`读取评论失败（${res.status}）`);
  }
  const json = await res.json();
  return json?.data || { total: 0, page, pageSize, data: [] };
}

export async function createComment(body: {
  path: string;
  parentId?: number;
  nick: string;
  email?: string;
  site?: string;
  content: string;
  hp?: string;
}): Promise<{ pending: boolean; message?: string }> {
  const res = await fetch("/api/public/comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (json && (json.message || json.error)) || `提交失败（HTTP ${res.status}）`;
    throw new Error(Array.isArray(message) ? message.join("；") : String(message));
  }
  return {
    pending: !!json?.data?.pending,
    message: json?.data?.message,
  };
}

/**
 * 批量取评论数。
 *
 * 列表页一屏可能有十几篇文章，逐篇请求太浪费；这里把 50ms 内的请求合并成一次
 * `/counts?paths=a,b,c`（和 waline 客户端的做法一致），并对结果做内存缓存。
 *
 * ⚠️ 这轮加固修掉的三个问题（都有测试钉住）：
 * 1. **一批超过 50 个 path 时，溢出的会被静默丢掉**：以前 `slice(0, 50)` 之后
 *    `pendingPaths` 整个清空，第 51 个之后的 path 既不发请求、也永远解析成 0
 *    （组件显示"0 条评论"——把"没查"渲染成了"没有"）。现在溢出部分留在队列里，
 *    下一个 50ms 窗口继续发，直到全部取完。
 * 2. **请求失败被缓存成 0，且永久**：以前 `.catch` 里给每个 path `set(p, 0)`，
 *    一次网络抖动就让这些文章的评论数在整个会话里显示 0。现在失败**不写缓存**
 *    （下次挂载可重试），并解析成 `undefined`，组件保持 "…" 占位符 ——
 *    "请求失败"和"确实没有评论"不再渲染成同一个样子。
 * 3. **缓存无上限**：模块级 Map 只增不减，长会话/大站点会无界增长。现在超过
 *    COUNT_CACHE_MAX 时按插入序淘汰最老的条目（评论数会由下一次访问重新取回，
 *    淘汰是安全的）。
 */
const countCache = new Map<string, number>();
/** 缓存上限：正常站点远用不满；防御长会话/异常输入下的无界增长 */
export const COUNT_CACHE_MAX = 500;
/** 一批最多合并多少个 path（server 侧对 paths 数量同样有这个量级的预期） */
export const COUNT_BATCH_MAX = 50;

type CountWaiter = (count: number | undefined) => void;
/** path → 等待这个 path 的解析回调（同一路径可有多次调用） */
const pendingWaiters = new Map<string, CountWaiter[]>();
let flushTimer: any = null;

function setCachedCount(path: string, count: number): void {
  countCache.set(path, count);
  while (countCache.size > COUNT_CACHE_MAX) {
    // Map 迭代序 = 插入序：删掉最老的一个（不用 for..of：本项目 target 是 es5）
    const oldest = countCache.keys().next();
    if (oldest.done) {
      break;
    }
    countCache.delete(oldest.value);
  }
}

export function getCachedCount(path: string): number | undefined {
  return countCache.get(path);
}

/** 缓存条目数（测试用：验证上限与淘汰） */
export function cachedCountSize(): number {
  return countCache.size;
}

/** 还在等待的路径（测试用：验证溢出会留到下一批） */
export function pendingCountPaths(): string[] {
  return Array.from(pendingWaiters.keys());
}

/**
 * 取一条路径的评论数：命中缓存直接返回；否则进 50ms 合并窗口。
 * 解析值 `undefined` 表示**这次没取到**（请求失败），调用方应保持占位符，
 * 不要把它当成 0 渲染。
 */
export function requestCommentCount(path: string): Promise<number | undefined> {
  if (countCache.has(path)) {
    return Promise.resolve(countCache.get(path));
  }
  return new Promise<number | undefined>((resolve) => {
    const waiters = pendingWaiters.get(path);
    if (waiters) {
      waiters.push(resolve);
    } else {
      pendingWaiters.set(path, [resolve]);
    }
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushCountBatch();
    }, 50);
  });
}

async function flushCountBatch(): Promise<void> {
  // 每批最多 COUNT_BATCH_MAX 个 path；剩下的留在 pendingWaiters 里等下一批
  // （以前是直接丢弃 —— 一页超过 50 篇时第 51 篇之后全部静默显示 0）
  const paths = Array.from(pendingWaiters.keys()).slice(0, COUNT_BATCH_MAX);
  if (paths.length === 0) {
    return;
  }
  const taken = new Map<string, CountWaiter[]>();
  for (let i = 0; i < paths.length; i += 1) {
    const p = paths[i];
    const waiters = pendingWaiters.get(p);
    if (waiters) {
      taken.set(p, waiters);
    }
    pendingWaiters.delete(p);
  }
  if (pendingWaiters.size > 0 && !flushTimer) {
    // 还有溢出的 path：排下一批
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushCountBatch();
    }, 50);
  }
  let data: Record<string, number> | null = null;
  try {
    const query = new URLSearchParams({ paths: paths.join(",") });
    const res = await fetch(`/api/public/comments/counts?${query.toString()}`);
    if (res.ok) {
      const json = await res.json();
      data = (json?.data || {}) as Record<string, number>;
    }
  } catch {
    data = null;
  }
  for (let i = 0; i < paths.length; i += 1) {
    const p = paths[i];
    const waiters = taken.get(p) || [];
    if (data) {
      const count = Number(data[p]) || 0;
      setCachedCount(p, count);
      for (let j = 0; j < waiters.length; j += 1) {
        waiters[j](count);
      }
    } else {
      // 失败：不写缓存（下次可重试），解析 undefined → UI 保持占位符
      for (let j = 0; j < waiters.length; j += 1) {
        waiters[j](undefined);
      }
    }
  }
}

export function clearCommentCountCache(): void {
  countCache.clear();
  pendingWaiters.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
