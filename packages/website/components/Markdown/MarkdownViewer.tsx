import { useEffect, useMemo, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { getProcessor } from "bytemd";
import type { ViewerProps } from "bytemd";

/**
 * 前台自己的 Markdown Viewer —— 把 `@bytemd/react` 里那 30 行 `Viewer` 内联过来，
 * 只导入渲染需要的 `getProcessor`。
 *
 * 为什么要内联（而不是继续 `import { Viewer } from "@bytemd/react"`）：
 * `@bytemd/react/dist/index.mjs` 第一行就是 `import * as bytemd from "bytemd"`，
 * 然后把 `Editor` 一起 re-export 出去。命名空间导入 + 用到 `bytemd.Editor` 会让
 * webpack 认为 bytemd 的**每个**导出都被用了，而 `bytemd/dist/index.mjs` 是个
 * 单文件 bundle，顶部静态 import 了编辑器的 codemirror-ssr / tippy.js /
 * select-files / word-count（`@popperjs/core` 由 tippy 带进来）。
 * 这三个包都没有 `sideEffects` 字段，能不能摇掉完全取决于 webpack 的
 * usedExports + terser 死代码消除 —— 实测**生产构建目前摇掉了**（客户端 chunk 里
 * 搜不到 `CodeMirror` / `tippy` / `popper` / bytemd 的 toolbar 字符串，
 * 见 __tests__/bytemdViewerOnly.spec.ts），但那是"碰巧成立"的性质，
 * 不是我们自己保证的。内联之后 `Editor` 这个导出根本不在依赖图里，
 * 编辑器代码进不来是**结构上**成立的，升级 bytemd 也不会突然把 codemirror 带回首屏。
 *
 * 行为与原实现逐条对齐（有意保留，别"顺手优化"）：
 * - `useMemo` 的依赖是 `[value, sanitize, plugins, remarkRehype]`；
 * - 渲染失败只 `console.error`，页面仍然出得来（`__html` 为空串）；
 * - `viewerEffect` 在 `useEffect` 里按插件顺序执行，返回的清理函数在卸载/依赖变化时调用
 *   （mermaid 懒加载、代码块复制按钮、图片放大都靠它）；
 * - 容器 class 仍是 `markdown-body`，ref 挂在这个容器上（插件拿到的 markdownBody 就是它）；
 * - 点击 `href="#..."` 的站内锚点时，先找 `#user-content-<id>`（bytemd 的历史前缀）。
 *   本站 sanitize 把 `clobberPrefix` 设成了空串，所以这个查询通常找不到元素、
 *   交给浏览器默认锚点跳转 —— 和改动前完全一致。
 */
export default function MarkdownViewer(props: ViewerProps) {
  const { value, sanitize, plugins, remarkRehype } = props;
  const elRef = useRef<HTMLDivElement>(null);

  const file = useMemo(() => {
    try {
      return getProcessor({ sanitize, plugins, remarkRehype }).processSync(value);
    } catch (err) {
      console.error(err);
      return undefined;
    }
  }, [value, sanitize, plugins, remarkRehype]);

  useEffect(() => {
    const markdownBody = elRef.current;
    if (!markdownBody || !file) {
      return;
    }
    const cbs = plugins?.map(({ viewerEffect }) =>
      viewerEffect?.({ markdownBody, file })
    );
    return () => {
      cbs?.forEach((cb) => cb && cb());
    };
  }, [file, plugins]);

  const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.tagName !== "A") {
      return;
    }
    const href = target.getAttribute("href");
    if (!href || !href.startsWith("#")) {
      return;
    }
    elRef.current
      ?.querySelector(`#user-content-${href.slice(1)}`)
      ?.scrollIntoView();
  };

  return (
    <div
      ref={elRef}
      className="markdown-body"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: file?.toString() ?? "" }}
    />
  );
}
