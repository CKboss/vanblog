import { Viewer } from "@bytemd/react";
import { useContext } from "react";
import { sanitizeMarkdownSchema } from "../../utils/markdownSanitize";
import { stripFrontMatter } from "../../utils/frontMatter";
import { ThemeContext } from "../../utils/themeContext";
import { isDarkPaintTheme } from "../../utils/mermaidTheme";
import type { BytemdPlugin } from "bytemd";

export const sanitize = sanitizeMarkdownSchema;

/**
 * 编辑器/前台共用的渲染外壳。
 *
 * 刻意**不在这里 import 任何重量级插件**（math / mermaid）：这个文件会被
 * MarkdownBase 和 MarkdownRich 两边复用，重插件由各自的文件按需引入，
 * 这样 next/dynamic 才能把它们切成独立 chunk（见 ./index.tsx）。
 */
export default function MarkdownView(props: {
  content: string;
  plugins: BytemdPlugin[];
}) {
  const { theme } = useContext(ThemeContext);
  const paintKey = isDarkPaintTheme(theme) ? "dark" : "light";
  return (
    <div className="markdown-body">
      <Viewer
        key={paintKey}
        value={stripFrontMatter(props.content)}
        plugins={props.plugins}
        remarkRehype={{ allowDangerousHtml: true }}
        sanitize={sanitize}
      />
    </div>
  );
}
