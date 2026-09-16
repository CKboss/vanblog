import MarkdownViewer from "./MarkdownViewer";
import { useContext } from "react";
import { sanitizeMarkdownSchema } from "../../utils/markdownSanitize";
import { stripFrontMatter } from "../../utils/frontMatter";
import { ThemeContext } from "../../utils/themeContext";
import { isDarkPaintTheme } from "../../utils/mermaidTheme";
import type { BytemdPlugin } from "bytemd";
import { defListHastHandlers } from "remark-definition-list";

export const sanitize = sanitizeMarkdownSchema;

/**
 * remark-rehype 的选项**必须是模块级常量**。
 *
 * MarkdownViewer 的 useMemo 依赖是 `[value, sanitize, plugins, remarkRehype]`
 * （按引用比较）。以前这个对象字面量写在 JSX 里，MarkdownView 每次重渲染都产生
 * 一个新引用 → memo 必失效 → **每次重渲染都重建 unified 管线并把整篇文章重新
 * processSync 一遍**。而重渲染并不罕见：_app 的访客统计 setState、主题 context、
 * 父组件任何 state 变化都会波及到这里。本机实测（31KB 的正文，负载中）：
 * 一次 processSync ≈ 200ms 量级，白白重复。提出来之后，只有 content / plugins /
 * 主题真的变了才会重新处理。渲染结果逐字节不变（同一份选项对象）。
 */
const REMARK_REHYPE_OPTIONS = {
  allowDangerousHtml: true,
  // 定义列表的 mdast 节点（defList/defListTerm/defListDescription）不是标准类型，
  // 要把官方给的 hast handler 传给 remark-rehype，否则会被当未知节点摊成 <div>
  handlers: defListHastHandlers,
};

/**
 * 前台渲染 markdown 的共用外壳（Base / Rich / Plain 三个变体都走这里）。
 *
 * 刻意**不在这里 import 任何重量级插件**（math / mermaid / highlight）：这个文件会被
 * 各个变体复用，重插件由各自的文件按需引入，
 * 这样 next/dynamic 才能把它们切成独立 chunk（见 ./index.tsx）。
 *
 * 渲染器是 ./MarkdownViewer（内联的 Viewer），**不是** `@bytemd/react`：
 * 那个包的入口会把 bytemd 的 Editor 一起拖进依赖图，详见 MarkdownViewer.tsx 的注释。
 */
export default function MarkdownView(props: {
  content: string;
  plugins: BytemdPlugin[];
}) {
  const { theme } = useContext(ThemeContext);
  const paintKey = isDarkPaintTheme(theme) ? "dark" : "light";
  return (
    <div className="markdown-body">
      <MarkdownViewer
        key={paintKey}
        value={stripFrontMatter(props.content)}
        plugins={props.plugins}
        remarkRehype={REMARK_REHYPE_OPTIONS}
        sanitize={sanitize}
      />
    </div>
  );
}
