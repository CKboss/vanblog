import type { BytemdPlugin, BytemdViewerContext } from "bytemd";
import {
  applyMermaidThemeToTree,
  detectPaintIsDark,
  isDarkPaintTheme,
  mermaidInitConfig,
  watchMermaidContainers,
} from "../../utils/mermaidTheme";

/** mermaid 代码块在 bytemd 里的落点：```mermaid -> <code class="language-mermaid"> */
export const MERMAID_BLOCK_SELECTOR = ".language-mermaid";

export function hasMermaidBlock(markdownBody: HTMLElement): boolean {
  return Boolean(markdownBody?.querySelector?.(MERMAID_BLOCK_SELECTOR));
}

/**
 * mermaid 本体（含 d3 等）有 1MB+，**不能静态 import**，否则每个渲染 markdown 的页面都要下载它。
 * 这里改成：viewerEffect 里先看正文有没有 `.language-mermaid`，有才 `import()`，
 * 加载完再调用官方插件的 viewerEffect 去渲染。没有流程图的文章一个字节都不会下载。
 */
export function mermaidForViewer(options?: { theme?: string }): BytemdPlugin {
  return {
    viewerEffect(ctx: BytemdViewerContext) {
      const { markdownBody } = ctx;
      if (!hasMermaidBlock(markdownBody)) {
        return;
      }
      const isDark =
        detectPaintIsDark(markdownBody) || isDarkPaintTheme(options?.theme);
      let cancelled = false;
      let cleanup: (() => void) | undefined;
      let stopWatch: (() => void) | undefined;

      void import("@bytemd/plugin-mermaid")
        .then((mod: any) => {
          if (cancelled) {
            return;
          }
          const mermaidPlugin = mod?.default ?? mod;
          const themed = mermaidPlugin(mermaidInitConfig(isDark));
          applyMermaidThemeToTree(markdownBody, isDark);
          const returned = themed?.viewerEffect?.(ctx);
          if (typeof returned === "function") {
            cleanup = returned;
          }
          stopWatch = watchMermaidContainers(markdownBody, isDark);
        })
        .catch(() => {
          // 加载失败就把代码块原样留着（可读的源码），不要让整页崩掉
        });

      return () => {
        cancelled = true;
        if (typeof cleanup === "function") {
          cleanup();
        }
        if (typeof stopWatch === "function") {
          stopWatch();
        }
      };
    },
  };
}
