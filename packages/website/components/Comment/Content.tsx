import React, { useMemo } from "react";
import { getProcessor } from "bytemd";
import gfm from "@bytemd/plugin-gfm";
import { visit } from "unist-util-visit";
import { sanitizeCommentSchema } from "../../utils/commentSanitize";

/**
 * 评论里的链接统一新窗口打开，并且带上 nofollow / noopener / noreferrer：
 * - noopener：防止 `window.opener` 反向操控本页（tab-nabbing）
 * - nofollow：评论区是匿名可写的，不给它传递权重的能力（否则会变成 SEO  spam 目标）
 */
/**
 * 把评论里的原始 HTML 节点转成**文本**节点。
 *
 * 关掉 `allowDangerousHtml` 后，remark 仍然会把 `<b>x</b>` 解析成 html 节点，
 * 而 remark-rehype 默认**直接丢弃** html 节点 —— 结果是用户写的东西凭空消失
 * （安全，但很困惑）。转成 text 之后，stringify 会做实体转义，
 * 页面上看到的就是字面量 `<b>x</b>`，既不会被执行也不会丢内容。
 */
const htmlAsText = (node: any): void => {
  if (!node || !Array.isArray(node.children)) {
    return;
  }
  node.children = node.children.map((child: any) =>
    child?.type === "html" ? { type: "text", value: String(child.value ?? "") } : child,
  );
  node.children.forEach(htmlAsText);
};

const escapeRawHtmlPlugin = {
  remark: (processor: any) => processor.use(() => (tree: any) => htmlAsText(tree)),
};

/** bytemd 插件要用 `{ remark }` / `{ rehype }` 包一层，裸的 unified transformer 塞进 plugins 数组会报类型错 */
const commentLinkGuardPlugin = {
  rehype: (processor: any) => processor.use(commentLinkGuard),
};

const commentLinkGuard = () => (tree: any) => {
  visit(tree, "element", (node: any) => {
    if (node?.tagName !== "a") {
      return;
    }
    node.properties = node.properties || {};
    node.properties.target = "_blank";
    node.properties.rel = "nofollow noopener noreferrer";
  });
};

let processor: any = null;
function getCommentProcessor() {
  if (!processor) {
    processor = getProcessor({
      // 只用 gfm：评论不需要公式、流程图、代码高亮这些重家伙。
      // ⚠️ 不要开 remarkRehype.allowDangerousHtml —— 评论是匿名可写的，
      // 原始 HTML 必须留在文本里而不是被解析成节点。
      plugins: [
        gfm({ singleTilde: false }),
        escapeRawHtmlPlugin,
        commentLinkGuardPlugin,
      ],
      sanitize: sanitizeCommentSchema,
    });
  }
  return processor;
}

export function renderCommentHtml(content: string): string {
  const text = String(content ?? "");
  if (!text) {
    return "";
  }
  try {
    return getCommentProcessor().processSync(text).toString();
  } catch (err) {
    // 渲染失败就退回纯文本（转义后），绝不能把原文直接塞进 HTML
    return `<p>${text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/\n/g, "<br/>")}</p>`;
  }
}

export default function CommentContent({ content }: { content: string }) {
  const html = useMemo(() => renderCommentHtml(content), [content]);
  return (
    <div
      className="van-comment-content markdown-body"
      // 这里的内容已经过 commentSanitize 白名单 + 链接加固，
      // 并且渲染阶段根本不解析原始 HTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
