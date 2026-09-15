import { useMemo } from "react";
import gfm from "@bytemd/plugin-gfm";
import { customContainer } from "./customContainer";
import rawHTML from "./rawHTML";
import { customCodeBlock } from "./codeBlock";
import { LinkTarget } from "./linkTarget";
import { Heading } from "./heading";
import { Img } from "./img";
import MarkdownView from "./MarkdownView";
import { extraSyntax } from "./extraSyntax";

/**
 * 列表摘要专用的渲染器：**不含 highlight.js**。
 *
 * 为什么值得单独一份：`@bytemd/plugin-highlight-ssr` → `rehype-highlight` → `lowlight`
 * → `highlight.js/lib/common`（约 35 种语言）+ 本站额外注册的 armasm/x86asm，
 * 生产构建里是 **222,215 B 原始 / 65,890 B gzip** 的一个独立 chunk，
 * 而它会被 `dynamic(..., { ssr: true })` 放进首页的**初始 script 列表**
 * （ssr:true 的 chunk 一点都不 defer，见 docs/advanced/performance.md）。
 * 列表摘要只有 200 字 / 4 行，几乎不可能出现围栏代码块 —— 首页为此白背 66KB gzip。
 *
 * 与 MarkdownBase 的唯一区别就是少了 `highlightSsr()`，其余插件、顺序完全一致，
 * 所以没有代码块的摘要渲染结果**逐字节相同**。摘要里真的有围栏（作者在
 * `<!-- more -->` 之前贴了代码）时，PostCard 会改用 MarkdownBase，
 * 高亮照旧 —— 见 components/PostCard/index.tsx 的 hasFencedCode 嗅探。
 *
 * ⚠️ 不要在这里 import highlightSsr / plugin-math / mermaid：这个文件存在的意义
 * 就是让列表页的首屏 JS 里没有它们（测试：__tests__/perfBudget.spec.ts）。
 */
export default function MarkdownPlain(props: { content: string }) {
  const plugins = useMemo(
    () => [
      rawHTML(),
      // singleTilde:false —— 单个 `~x~` 让给下标（remark-supersub），删除线仍用 `~~x~~`
      gfm({ singleTilde: false }),
      extraSyntax(),
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
