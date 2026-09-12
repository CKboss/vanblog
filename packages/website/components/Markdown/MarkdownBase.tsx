import { useMemo } from "react";
import gfm from "@bytemd/plugin-gfm";
import { highlightSsr } from "./highlightSsr";
import { customContainer } from "./customContainer";
import rawHTML from "./rawHTML";
import { customCodeBlock } from "./codeBlock";
import { LinkTarget } from "./linkTarget";
import { Heading } from "./heading";
import { Img } from "./img";
import MarkdownView from "./MarkdownView";
import { extraSyntax } from "./extraSyntax";

/**
 * 不含 KaTeX / mermaid 的渲染器。绝大多数文章（以及所有列表页摘要）都走这一份，
 * 因此这两个重依赖不会进入首屏 JS。
 */
export default function MarkdownBase(props: { content: string }) {
  const plugins = useMemo(
    () => [
      rawHTML(),
      // singleTilde:false —— 单个 `~x~` 让给下标（remark-supersub），删除线仍用 `~~x~~`
      gfm({ singleTilde: false }),
      extraSyntax(),
      highlightSsr(),
      customContainer(),
      customCodeBlock(),
      LinkTarget(),
      Heading(),
      Img(),
    ],
    [],
  );
  return <MarkdownView content={props.content} plugins={plugins} />;
}
