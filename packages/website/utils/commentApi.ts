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

/** 评论设置全站只需要取一次（并发调用共享同一个 Promise） */
export function loadCommentSetting(): Promise<PublicCommentSetting | null> {
  if (!settingPromise) {
    settingPromise = fetch("/api/public/comments/setting")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => (json && json.data ? (json.data as PublicCommentSetting) : null))
      .catch(() => null);
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
 */
const countCache = new Map<string, number>();
let pendingPaths = new Set<string>();
let pendingResolvers: Array<() => void> = [];
let flushTimer: any = null;

export function getCachedCount(path: string): number | undefined {
  return countCache.get(path);
}

export function requestCommentCount(path: string): Promise<number> {
  if (countCache.has(path)) {
    return Promise.resolve(countCache.get(path) as number);
  }
  return new Promise<number>((resolve) => {
    pendingPaths.add(path);
    pendingResolvers.push(() => resolve(countCache.get(path) ?? 0));
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      const paths = Array.from(pendingPaths).slice(0, 50);
      const resolvers = pendingResolvers;
      flushTimer = null;
      pendingPaths = new Set();
      pendingResolvers = [];
      const query = new URLSearchParams({ paths: paths.join(",") });
      fetch(`/api/public/comments/counts?${query.toString()}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          const data = (json?.data || {}) as Record<string, number>;
          for (const p of paths) {
            countCache.set(p, Number(data[p]) || 0);
          }
        })
        .catch(() => {
          for (const p of paths) {
            countCache.set(p, 0);
          }
        })
        .finally(() => {
          resolvers.forEach((done) => done());
        });
    }, 50);
  });
}

export function clearCommentCountCache(): void {
  countCache.clear();
}
