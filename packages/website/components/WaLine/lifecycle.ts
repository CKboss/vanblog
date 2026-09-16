/**
 * Waline 会话生命周期（纯逻辑，与 React / DOM 解耦，可直接单测）。
 *
 * ## 为什么要抽出来
 *
 * 旧的 core.tsx 把生命周期写在一个 `useEffect(..., [current, props])` 里，
 * 有三个叠加的缺陷（waline 模式下评论区会**静默变空白**）：
 *
 * 1. **依赖是 props 对象**：父组件任何一次重渲染都产生新引用 → effect
 *    cleanup → `wa.destroy()` 把评论组件销毁；
 * 2. **hasInit 门闩在 ref 上**：cleanup 之后 effect 重跑时 `hasInit` 已是 true，
 *    **不会重新 init** —— 销毁了就再也回不来；
 * 3. **异步竞态**：`loadCommentSetting()` 还在飞的时候如果发生一次重渲染，
 *    cleanup 把 `cancelled` 置 true，随后 resolve 的 init 被跳过，
 *    而门闩已经落下 → 这个页面上 waline 永远不会初始化。
 *
 * 现在的契约：
 * - session 只跟 `(enabled, visible)` 两个**值**绑定（组件里做依赖），
 *   父组件重渲染不再触碰它；
 * - `startWalineSession()` 返回 teardown；teardown 之后即使异步 init 才落地，
 *   也会因为 `cancelled` 被跳过，不会留下没人销毁的实例；
 * - visible 翻转（列表页 ↔ 文章页）时先 teardown 旧的再起新的，两边都干净。
 */
/** init() 的固定基础参数（与旧 core.tsx 里那份字面量逐项一致） */
export interface WalineInitBase {
  el: string;
  serverURL: string;
  comment: boolean;
  pageview: boolean;
  dark: string;
  lang: string;
}

export interface WalineSessionDeps {
  /** true = 文章/关于页的完整评论区；false = 列表页的隐形计数实例 */
  visible: boolean;
  serverURL: string;
  loadSetting: () => Promise<Record<string, unknown> | null | undefined>;
  buildOptions: (
    setting: Record<string, unknown>
  ) => Record<string, string | boolean | number>;
  init: (
    base: WalineInitBase,
    extra: Record<string, string | boolean | number>
  ) => { destroy?: () => void } | undefined | null;
  commentCount: (
    options: { serverURL: string }
  ) => (() => void) | undefined | null;
}

/**
 * 起一个 waline 会话，返回 teardown 函数（幂等、绝不抛错）。
 */
export function startWalineSession(deps: WalineSessionDeps): () => void {
  let cancelled = false;
  let instance: { destroy?: () => void } | null = null;
  let cancelCount: (() => void) | null = null;
  let tornDown = false;

  if (deps.visible) {
    void (async () => {
      let setting: Record<string, unknown> = {};
      try {
        setting = (await deps.loadSetting()) || {};
      } catch {
        // 设置接口挂了就按 waline 默认值来（与旧行为一致）
        setting = {};
      }
      if (cancelled) {
        return;
      }
      const extra = deps.buildOptions(setting);
      const created = deps.init(
        {
          el: "#waline",
          serverURL: deps.serverURL,
          comment: true,
          pageview: false,
          dark: ".dark",
          lang: "zh",
        },
        extra,
      );
      instance = created || null;
    })();
  } else {
    const cancel = deps.commentCount({ serverURL: deps.serverURL });
    cancelCount = typeof cancel === "function" ? cancel : null;
  }

  return () => {
    if (tornDown) {
      return;
    }
    tornDown = true;
    cancelled = true;
    if (instance) {
      try {
        instance.destroy?.();
      } catch {
        // teardown 里不抛
      }
      instance = null;
    }
    if (cancelCount) {
      try {
        cancelCount();
      } catch {
        // 同上
      }
      cancelCount = null;
    }
  };
}
