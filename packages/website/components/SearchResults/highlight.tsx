import { Fragment, ReactNode } from "react";
import { HighlightSegment, highlightSegments } from "../../utils/searchHighlight";

/**
 * 把纯数据的高亮片段渲染成 React 节点。
 *
 * ⚠️ **这里是整条搜索路径上唯一"把用户查询变成页面内容"的地方**，所以它的写法就是安全边界：
 *  - 片段文本一律作为 **React 子节点**传入（`{seg.text}`），React 会做 HTML 转义；
 *  - 全文件没有 `dangerouslySetInnerHTML`、没有 `innerHTML`、没有字符串拼接 HTML
 *    （`__tests__/searchHighlight.spec.ts` 有源码级断言 + 喂 `<img src=x onerror=…>`
 *    与 `"><script>` 的渲染断言）。
 *  - `key` 用**下标**而不是文本：同一段文本可能重复出现，用文本当 key 会撞。
 *    这里列表是静态的（一次渲染内不会重排），下标 key 是安全的。
 */
export function renderHighlighted(
  text: unknown,
  query: unknown,
  markClassName?: string,
): ReactNode[] {
  const segments: HighlightSegment[] = highlightSegments(text, query);
  return segments.map((segment, index) =>
    segment.match ? (
      <mark
        key={index}
        className={
          markClassName ??
          "vanblog-search-mark bg-yellow-200/70 dark:bg-yellow-500/40 text-inherit rounded-[2px] px-[1px]"
        }
      >
        {segment.text}
      </mark>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}

export default renderHighlighted;
