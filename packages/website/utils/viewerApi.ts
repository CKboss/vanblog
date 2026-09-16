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
 * `/post/<数字id>` 301 到别名（§7.20））之后，同一篇文章有两本账：
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
 *
 * ## 这轮加固修掉的三个问题（与 commentApi 同款，都有测试钉住）
 *
 * 1. **一批超过 50 个 id 时溢出会被静默丢弃**：以前 `slice(0, VIEWER_BATCH_MAX)`
 *    之后把整个 pending 清空，第 51 个之后的 id 不发请求、直接解析成 null（永远 `...`）。
 *    现在溢出部分留在队列里，下一个窗口继续发。
 * 2. **请求失败会被缓存成 null 且整个会话不再重试**：现在失败**不写缓存**，
 *    组件保持占位符，下一次挂载还能重试（接口恢复后自愈）。
 * 3. **缓存无上限**：模块级 Map 只增不减；现在超过 VIEWER_CACHE_MAX 按插入序
 *    淘汰最老条目（seed 会在下一次渲染时重新播种，淘汰是安全的）。
 */

import { getArticleViewer } from "../api/getArticleViewer";

/** 与 commentApi 的 50ms 窗口保持一致：够把同一帧里挂载的卡片合并成一批，又不影响体感。 */
export const VIEWER_BATCH_WINDOW_MS = 50;
/** 一批最多发多少个请求（和 commentApi 的 COUNT_BATCH_MAX 同一个量级）。 */
export const VIEWER_BATCH_MAX = 50;
/** 缓存上限：正常站点远用不满；防御长会话/异常输入下的无界增长 */
export const VIEWER_CACHE_MAX = 500;

/** 接口回来的原始记录；`null` 表示 server 没有这篇的 visit 记录。 */
export type ViewerRecord = { viewer?: number } | null;

type ViewerWaiter = (record: ViewerRecord) => void;

const viewerCache = new Map<string, ViewerRecord>();
/** id → 等待解析的回调（同一 id 可有多次调用） */
const pendingWaiters = new Map<string, ViewerWaiter[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function viewerKey(id: number | string): string {
  return String(id);
}

function setCachedViewer(id: string, record: ViewerRecord): void {
  viewerCache.set(id, record);
  while (viewerCache.size > VIEWER_CACHE_MAX) {
    // Map 迭代序 = 插入序：删掉最老的一个（不用 for..of：本项目 target 是 es5）
    const oldest = viewerCache.keys().next();
    if (oldest.done) {
      break;
    }
    viewerCache.delete(oldest.value);
  }
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
    setCachedViewer(key, { viewer });
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
  return Array.from(pendingWaiters.keys());
}

export function clearViewerCache(): void {
  viewerCache.clear();
  pendingWaiters.clear();
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
    void flushViewerBatch();
  }, VIEWER_BATCH_WINDOW_MS);
}

async function flushViewerBatch(): Promise<void> {
  // 每批最多 VIEWER_BATCH_MAX 个 id；剩下的**留在队列里等下一批**
  // （以前是 slice 之后整个清空 —— 第 51 个之后的 id 会永远停在占位符）
  const ids = Array.from(pendingWaiters.keys()).slice(0, VIEWER_BATCH_MAX);
  if (ids.length === 0) {
    return;
  }
  const taken = new Map<string, ViewerWaiter[]>();
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const waiters = pendingWaiters.get(id);
    if (waiters) {
      taken.set(id, waiters);
    }
    pendingWaiters.delete(id);
  }
  if (pendingWaiters.size > 0 && !flushTimer) {
    scheduleFlush();
  }
  // server 没有批量接口（也不允许加），所以一批里仍然是 N 个请求 ——
  // 但它们**并行**发出、且都发生在首屏渲染之后，不再是一个个串起来的瀑布。
  await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await getArticleViewer(id);
        setCachedViewer(
          id,
          res && typeof res === "object" ? (res as ViewerRecord) : null,
        );
      } catch {
        // 单篇失败**不写缓存**：以前会把 null 缓存下来，导致整个会话不再重试、
        // 组件永远停在占位符。现在失败只影响这一次解析（null → 占位符），
        // 已经缓存/播种过的值不受影响，下一次挂载还能重试。
      }
    }),
  );
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const record = viewerCache.has(id) ? viewerCache.get(id) ?? null : null;
    const waiters = taken.get(id) || [];
    for (let j = 0; j < waiters.length; j += 1) {
      waiters[j](record);
    }
  }
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
    const waiters = pendingWaiters.get(key);
    if (waiters) {
      waiters.push(resolve);
    } else {
      pendingWaiters.set(key, [resolve]);
    }
    scheduleFlush();
  });
}
