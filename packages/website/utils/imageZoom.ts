/**
 * 全站共享的 medium-zoom 单例。
 *
 * ## 为什么必须单例（这是一个真实的泄漏，不是洁癖）
 *
 * 每调用一次 `mediumZoom()`，实例创建时都会在 **document/window 上挂 4 个全局监听**
 * （`click` / `keyup` / `scroll` / `resize`），而 medium-zoom@1.1.0 **没有任何 API
 * 能移除它们**：`detach()` 只是把图片从实例内部列表里摘出来，那 4 个监听
 * （连同闭包里引用的图片数组、overlay 节点）会活到页面卸载为止
 * （见 medium-zoom.esm.js 实例尾部无条件的 4 个 addEventListener）。
 *
 * 改动前的两处调用都是"每图/每挂载一个实例、且无清理"：
 * - `components/Markdown/img.tsx` 的 viewerEffect 对**每张正文图片**调一次 `m(img)`；
 * - `components/ImageBox/index.tsx` 每次挂载调一次 `m(ref)`。
 * 于是每次客户端路由跳转（文章页 → 文章页）都会永久新增 4×(图片数+2) 个
 * 全局监听，每个 scroll 事件都要空跑几百个回调，闭包还钉着已卸载的 DOM。
 *
 * 现在：全站只创建**一个**实例（4 个全局监听，常数），图片随组件挂载/卸载
 * attach/detach，内存与监听数不再随导航次数增长。
 */
import mediumZoom from "medium-zoom";

export type SharedZoomApi = ReturnType<typeof mediumZoom>;

/** 结构化的最小接口：测试里可以注入假实现，不必真的建 medium-zoom 实例 */
export interface ZoomLike {
  attach(el: unknown): unknown;
  detach(el: unknown): unknown;
}

let zoomApi: ZoomLike | null = null;
let zoomFactory: () => ZoomLike = () => mediumZoom() as unknown as ZoomLike;

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** 取（并惰性创建）全站唯一的 zoom 实例；SSR / 非浏览器环境返回 null。 */
export function getSharedImageZoom(): ZoomLike | null {
  if (!isBrowser()) {
    return null;
  }
  if (!zoomApi) {
    zoomApi = zoomFactory();
  }
  return zoomApi;
}

/**
 * 把一张图挂到共享实例上，返回**解绑函数**（组件卸载/viewerEffect 清理时调用）。
 * 解绑是幂等的，且绝不抛错（清理阶段抛错会冒进 React 的 commit）。
 */
export function attachImageZoom(img: unknown): () => void {
  const api = getSharedImageZoom();
  if (!api) {
    return () => undefined;
  }
  api.attach(img);
  let detached = false;
  return () => {
    if (detached) {
      return;
    }
    detached = true;
    try {
      api.detach(img);
    } catch {
      // detach 失败（元素已被移除等）不影响任何东西，忽略
    }
  };
}

/** 当前是否已创建实例（测试用） */
export function sharedImageZoomCreated(): boolean {
  return zoomApi !== null;
}

/** 测试用：注入假工厂并重置单例；传 null 恢复真实实现。 */
export function __setImageZoomFactoryForTest(factory: (() => ZoomLike) | null): void {
  zoomApi = null;
  zoomFactory = factory ?? (() => mediumZoom() as unknown as ZoomLike);
}
