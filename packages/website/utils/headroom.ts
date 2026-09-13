/**
 * 安全地停掉一个 headroom.js 实例。
 *
 * 为什么不能直接 `headroom.destroy()`：
 * 1. headroom 0.12 的 `init()` 把 `scrollTracker` 的创建放在 `setTimeout(…, 100)` 里
 *    （为了等浏览器恢复上次的滚动位置）。所以「刚 init 就 destroy」时
 *    `this.scrollTracker` 还是 `undefined`，`destroy()` 里的
 *    `this.scrollTracker.destroy()` 会抛 TypeError。React 18 StrictMode 在开发模式下
 *    就是「挂载 → 立刻清理 → 再挂载」，正好命中这个窗口；清理函数里抛错会冒到
 *    React 的 commit 阶段，表现就是**一滚动页面就报错**。
 * 2. `destroy()` 还会把 `classes` 里的所有类名从元素上摘掉（`side-bar`、
 *    `side-bar-pinned`…）。StrictMode 下新实例挂在**同一个元素**上，
 *    旧实例的延迟清理会把新实例刚加上去的类一起删掉，侧栏样式就没了。
 *
 * 所以这里只停真正的 scroll 监听，并且在 100ms 竞态窗口之后再补一次。
 */
export function stopHeadroom(headroom: any): void {
  const stop = () => {
    try {
      headroom?.scrollTracker?.destroy?.();
    } catch {
      // 清理阶段绝不能抛
    }
  };
  stop();
  if (typeof setTimeout === "function") {
    setTimeout(stop, 250);
  }
}
