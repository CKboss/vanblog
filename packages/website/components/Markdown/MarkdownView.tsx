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
        remarkRehype={{
          allowDangerousHtml: true,
          // 定义列表的 mdast 节点（defList/defListTerm/defListDescription）不是标准类型，
          // 要把官方给的 hast handler 传给 remark-rehype，否则会被当未知节点摊成 <div>
          handlers: defListHastHandlers,
        }}
        sanitize={sanitize}
      />
    </div>
  );
}
