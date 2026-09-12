import dynamic from "next/dynamic";
import { sanitizeMarkdownSchema } from "../../utils/markdownSanitize";

// 保留原来的导出（有测试和外部引用在用）
export const sanitize = sanitizeMarkdownSchema;

/**
 * 数学 / mermaid 是整站最重的两个依赖（KaTeX + mermaid 及其 d3 等），
 * 但绝大多数文章根本没有公式和流程图。这里先做一次**极便宜的字符串嗅探**，
 * 再用 next/dynamic 把两种渲染器切成独立 chunk：
 *
 * - 没有 `$` 也没有 ```mermaid → MarkdownBase（不带 KaTeX / mermaid）
 * - 有                        → MarkdownRich（带 KaTeX；mermaid 仍由 mermaidViewer 二次懒加载）
 *
 * 嗅探宁可放宽也不要漏：误判的代价只是多下载一个 chunk，漏判会让公式渲染成原文。
 */
export const MERMAID_FENCE_RE = /(^|\n)\s{0,3}(?:`{3,}|~{3,})[ \t]*mermaid\b/i;
/**
 * 行内数学：`$` 后紧跟非空白、同一行内闭合 —— 和 remark-math 自己的规则一致。
 * 不能只判断「有没有 `$`」：正文里出现 `$PATH`、`$5` 太常见了，会把整站的
 * KaTeX chunk 都拖进来（实测首页就是这样白背了 270KB）。
 */
export const INLINE_MATH_RE = /(^|[^\\$\w])\$(?!\s)[^$\n]+?\$/;

export function needsRichMarkdown(content: string): boolean {
  const text = String(content ?? "");
  if (!text) {
    return false;
  }
  return (
    MERMAID_FENCE_RE.test(text) ||
    text.includes("$$") ||
    INLINE_MATH_RE.test(text)
  );
}

const MarkdownBase = dynamic(() => import("./MarkdownBase"), { ssr: true });
const MarkdownRich = dynamic(() => import("./MarkdownRich"), { ssr: true });

export default function Markdown(props: { content: string }) {
  const Renderer = needsRichMarkdown(props.content) ? MarkdownRich : MarkdownBase;
  return <Renderer content={props.content} />;
}
