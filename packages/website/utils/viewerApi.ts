/**
 * 文章阅读量（每篇一个整数）的前台数据层。
 *
 * ## 为什么有这个文件
 *
 * 改动前：列表页每张卡都挂一个 `<PostViewer>`，它在 `useEffect` 里无条件
 * `GET /api/public/article/viewer/<id>`。首页 5 张卡 = 5 个 XHR，每个回一份
 * ~220–270 B 的**整份 visit 文档**（`_id` / `date` / `lastVisitedTime` / `visited` …）
 * 只为了显示一个整数，而这个整数 pageProps 里本来就有（`article.viewer`）。
 * 实测（headless Chrome，:3001，第三方请求已屏蔽）：5 个请求在 2237–2240 ms 之间
 * 一起发出、各耗时 70–79 ms，首屏因此多 5 个连接和 ~1.3 KB；
 * 而首屏 HTML 里那 5 个位置渲染的是 `...`，等 XHR 回来才跳成数字（闪烁 + 宽度变化）。
 *
 * ## 现在的做法
 *
 * 1. **seed**：`seedArticleViewer(id, article.viewer)` 把 pageProps 里的数直接写进
 *    模块级缓存，`<PostViewer>` 首帧就渲染真实数字（没有 `...`、没有宽度跳变、没有 XHR）。
 * 2. **合并**：确实需要刷新时（拿不到 seed 的场景，例如 `/about`），
 *    走 `requestArticleViewer()`：50 ms 窗口内的调用合并成一批，
 *    批内**并行**发出既有的 per-id 请求（server 没有批量接口，也不允许加），
 *    并且结果进模块级缓存 —— 同一次会话里来回跳转不会重复请求同一篇。
 *    这套「批窗口 + 模块级缓存」的写法与 `utils/commentApi.ts` 的
 *    `requestCommentCount` 一致（评论数早就是这么合并的）。
 *
 * ## ⚠️ 一个必须知道的语义坑（server 侧，前台改不了）
 *
 * `GET /api/public/article/viewer/:id` 返回的是 **visits 集合里「该 pathname 最近一天」
 * 的那份文档**（`visitProvider.getByArticleId` → `find({pathname}).sort({date:-1}).limit(1)`），
 * 而 visits 是**按 pathname 分家**的累计值。自从文章链接默认带拼音别名（§7.1）+
 * `/post/<数字id>` 301 到别名（§7.20）之后，同一篇文章有两本账：
 * `/post/53` 停在别名启用前，`/post/<别名>` 从 0 重新累计。
 * 而 pageProps 里的 `article.viewer` 是 `updateViewerByPathname()` 用原子 `$inc`
 * 维护的**唯一权威值**（两种路径进来都加到同一个字段上）。
 *
 * 本机实测同一篇文章：`article.viewer = 145`，而接口返回 `viewer = 38`
 * （首页 5 张卡分别是 145/123/87/71/86 vs 接口 38/10/2/1/3）。
 * 也就是说：改动前卡片上显示的那个数**是错的小值**，刷新等于把一个对的数换成一个错的数。
 * 所以 `PostViewer` 在拿得到 seed 时**根本不刷新**（`refresh: "never"`）；
 * 这个合并器只在拿不到 seed 时才用。等 server 把按 pathname 分家的两本账合掉
 * （或提供批量接口）之后，把 `refresh` 打开就能直接复用这里的批处理。
 */

import { getArticleViewer } from "../api/getArticleViewer";

/** 与 commentApi 的 50ms 窗口保持一致：够把同一帧里挂载的卡片合并成一批，又不影响体感。 */
export const VIEWER_BATCH_WINDOW_MS = 50;
/** 一批最多发多少个请求（和 commentApi 的 paths.slice(0, 50) 同一个量级）。 */
export const VIEWER_BATCH_MAX = 50;

/** 接口回来的原始记录；`null` 表示 server 没有这篇的 visit 记录。 */
export type ViewerRecord = { viewer?: number } | null;

const viewerCache = new Map<string, ViewerRecord>();
let pendingIds: string[] = [];
let pendingResolvers: Array<() => void> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function viewerKey(id: number | string): string {
  return String(id);
}

/**
 * 用 pageProps 里已有的阅读量给缓存播种。
 *
 * 只在**缓存里还没有这一篇**时写入：已经刷新过的值比 ISR 页面里的快照新，
 * 不能被覆盖回去（页面是静态生成的，可能是几分钟前渲染的）。
 */
export function seedArticleViewer(
  id: number | string,
  viewer: number | null | undefined,
): void {
  if (typeof viewer !== "number" || !Number.isFinite(viewer)) {
    return;
  }
  const key = viewerKey(id);
  if (!viewerCache.has(key)) {
    viewerCache.set(key, { viewer });
  }
}

export function getCachedViewerRecord(
  id: number | string,
): ViewerRecord | undefined {
  return viewerCache.get(viewerKey(id));
}

/** 缓存里现在有多少篇（测试用：验证批窗口确实把 N 次调用合成了一批） */
export function cachedViewerSize(): number {
  return viewerCache.size;
}

/** 还有多少个 id 在等这一批（测试用） */
export function pendingViewerIds(): string[] {
  return [...pendingIds];
}

export function clearViewerCache(): void {
  viewerCache.clear();
  pendingIds = [];
  pendingResolvers = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function scheduleFlush(): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = pendingResolvers;
    const ids = Array.from(new Set(pendingIds)).slice(0, VIEWER_BATCH_MAX);
    pendingIds = [];
    pendingResolvers = [];
    // server 没有批量接口（也不允许加），所以一批里仍然是 N 个请求 ——
    // 但它们**并行**发出、且都发生在首屏渲染之后，不再是一个个串起来的瀑布。
    void Promise.all(
      ids.map(async (id) => {
        try {
          const res = await getArticleViewer(id);
          viewerCache.set(
            id,
            res && typeof res === "object" ? (res as ViewerRecord) : null,
          );
        } catch {
          // 单篇失败不影响其它：缓存里留着 seed 的值（可能没有），
          // 组件会继续显示 seed / 占位符，不会把已经显示的数字抹掉。
          if (!viewerCache.has(id)) {
            viewerCache.set(id, null);
          }
        }
      }),
    ).then(() => {
      batch.forEach((done) => done());
    });
  }, VIEWER_BATCH_WINDOW_MS);
}

/**
 * 取一篇的阅读量：命中缓存直接返回，否则进当前批窗口。
 * 返回的是**原始记录**（不做 +1 / noViewer 处理），
 * 显示层的加减在 `utils/countPlaceholder.ts` 的 `resolveArticleViewer` 里做。
 */
export function requestArticleViewer(
  id: number | string,
): Promise<ViewerRecord> {
  const key = viewerKey(id);
  if (viewerCache.has(key)) {
    return Promise.resolve(viewerCache.get(key) ?? null);
  }
  return new Promise<ViewerRecord>((resolve) => {
    pendingIds.push(key);
    pendingResolvers.push(() => resolve(viewerCache.get(key) ?? null));
    scheduleFlush();
  });
}
