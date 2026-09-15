import { useEffect, useMemo, useState } from "react";
import {
  formatCountDisplay,
  resolveArticleViewer,
} from "../../utils/countPlaceholder";
import {
  getCachedViewerRecord,
  requestArticleViewer,
  seedArticleViewer,
  type ViewerRecord,
} from "../../utils/viewerApi";

/**
 * 什么时候去后台刷新阅读量。
 *
 * - `never`：pageProps 里已经有权威值（`article.viewer`），不再发请求。
 *   列表卡与文章页都走这条 —— 首页因此从 5 个 XHR 变成 0 个。
 * - `idle`：拿不到 seed（`/about` 的 pageProps 里没有阅读量、或 ISR 缓存里的老页面
 *   还没有这个字段）时，等浏览器空闲再取一次，并走 `utils/viewerApi.ts` 的
 *   50ms 合并窗口 + 模块级缓存。
 *
 * 不传 `refresh` 时按"有没有 seed"自动选（有 → never，没有 → idle）。
 * ⚠️ 别在有 seed 的地方开刷新：`GET /api/public/article/viewer/:id` 返回的是
 * **按 pathname 分家**的 visit 台账，拼音别名启用后它比 `article.viewer` 小得多
 * （本机实测 145 vs 38），刷新等于把一个对的数字换成一个错的。详见 viewerApi.ts 顶部。
 */
export type ViewerRefreshMode = "never" | "idle";

/** 与 pages/_app.tsx 里同一个写法：有 requestIdleCallback 就用它，没有就退化成 setTimeout。 */
function onIdle(cb: () => void, timeout: number): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  if ("requestIdleCallback" in window) {
    const handle = (window as any).requestIdleCallback(cb, { timeout });
    return () => (window as any).cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(cb, timeout);
  return () => window.clearTimeout(handle);
}

export default function PostViewer(props: {
  shouldAddViewer: boolean;
  id: number | string;
  /**
   * pageProps 里已有的阅读量（列表接口与文章接口都会下发 `article.viewer`）。
   * 有它，**首帧就是真实数字**：没有 `...` 占位、没有宽度跳变、也不需要 XHR。
   */
  initialViewer?: number | null;
  refresh?: ViewerRefreshMode;
}) {
  const hasSeed =
    typeof props.initialViewer === "number" && Number.isFinite(props.initialViewer);
  // ⚠️ 初始值只能来自 props：模块级缓存是进程内共享的，SSR 时读它会把上一个请求
  //    的数据带进这一次的 HTML（还会造成水合不一致）。缓存只在 effect（客户端）里碰。
  const [record, setRecord] = useState<ViewerRecord | null>(
    hasSeed ? { viewer: props.initialViewer as number } : null,
  );
  // `noViewer` 是浏览器本地的"别把我算进阅读量"开关（仓库里只有读、没有写，
  // 属于手工调试用的逃生口）。只能在客户端读 localStorage，所以先按 false 渲染，
  // 挂载后再纠正 —— 绝大多数访客不会有任何变化。
  const [noViewer, setNoViewer] = useState(false);
  const refresh: ViewerRefreshMode = props.refresh ?? (hasSeed ? "never" : "idle");

  useEffect(() => {
    // 把 pageProps 的值播进模块级缓存：同一次会话里来回跳转不必重复请求
    seedArticleViewer(props.id, hasSeed ? (props.initialViewer as number) : null);
    try {
      setNoViewer(localStorage?.getItem("noViewer") === "true");
    } catch {
      // 隐私模式 / 被禁用的 localStorage
    }
  }, [props.id, props.initialViewer, hasSeed]);

  useEffect(() => {
    if (refresh === "never") {
      return;
    }
    // ⚠️ 这里**不能**再加 `useRef({hasInit:false})` 那种"只跑一次"的门闩：
    // 这个 effect 有清理函数（取消 idle 回调），而 React 18 的 StrictMode 在开发模式下
    // 会 mount → unmount → remount，门闩会让第一次的调度被取消后**再也不重排**，
    // `/about` 的阅读量就永远停在 `...`（实测踩过，headless Chrome 抓到的）。
    // 重复请求由 utils/viewerApi.ts 的模块级缓存 + 50ms 合并窗口兜住，不需要门闩。
    const cancel = onIdle(() => {
      const cached = getCachedViewerRecord(props.id);
      if (cached) {
        setRecord(cached);
        return;
      }
      void requestArticleViewer(props.id).then((res) => setRecord(res ?? null));
    }, 2000);
    return cancel;
  }, [refresh, props.id]);

  const viewer = useMemo(
    () =>
      record === null
        ? null
        : resolveArticleViewer(record, {
            shouldAddViewer: props.shouldAddViewer,
            noViewer,
          }),
    [record, props.shouldAddViewer, noViewer],
  );

  return (
    <span data-article-viewer aria-busy={viewer === null}>
      {formatCountDisplay(viewer)}
    </span>
  );
}
