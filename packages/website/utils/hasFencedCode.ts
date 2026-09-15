/**
 * 正文/摘要里有没有**围栏代码块**（``` 或 ~~~）。
 *
 * 用途：列表卡的摘要几乎不可能有代码块，而代码高亮（highlight.js 的 common
 * 语言集 + 本站加的 armasm/x86asm）在生产构建里是一个 222KB / gzip 66KB 的独立
 * chunk，并且因为 `dynamic(..., { ssr: true })` 会进首页的初始 script 列表。
 * 所以 PostCard 先嗅一下：没有围栏就用不含高亮的轻量渲染器（MarkdownPlain），
 * 有围栏才用 MarkdownBase（渲染结果与改动前完全一致）。
 *
 * 与 components/Markdown/index.tsx 里 mermaid 的嗅探同一个原则：**宁可误判也不能漏判**。
 * 误判的代价是多下载一个 chunk；漏判的代价是摘要里的代码失去高亮。
 * 所以这里只看"有没有围栏起始符"，不要求它闭合 —— 摘要可能在代码块中间被截断
 * （server 的 withExcerpt 按 200 字截，会修截断的链接但不会补全围栏）。
 */
export const FENCED_CODE_RE = /(^|\n)\s{0,3}(?:`{3,}|~{3,})/;

export function hasFencedCode(content: string | null | undefined): boolean {
  const text = String(content ?? "");
  // 便宜的快速出口：连反引号和波浪号都没有，就不必跑正则
  if (!text || (!text.includes("`") && !text.includes("~"))) {
    return false;
  }
  return FENCED_CODE_RE.test(text);
}
