import { useContext, useMemo } from "react";
import gfm from "@bytemd/plugin-gfm";
import math from "@bytemd/plugin-math-ssr";
import "katex/dist/katex.min.css";
import { highlightSsr } from "./highlightSsr";
import { customContainer } from "./customContainer";
import rawHTML from "./rawHTML";
import { customCodeBlock } from "./codeBlock";
import { LinkTarget } from "./linkTarget";
import { Heading } from "./heading";
import { Img } from "./img";
import { mermaidForViewer } from "./mermaidViewer";
import { ThemeContext } from "../../utils/themeContext";
import MarkdownView from "./MarkdownView";
import { extraSyntax } from "./extraSyntax";

/** 正文里有数学公式或 mermaid 时才加载这一份（含 KaTeX；mermaid 再按需二次懒加载）。 */
export default function MarkdownRich(props: { content: string }) {
  const { theme } = useContext(ThemeContext);
  const plugins = useMemo(
    () => [
      rawHTML(),
      gfm({ singleTilde: false }),
      extraSyntax(),
      highlightSsr(),
      math(),
      mermaidForViewer({ theme }),
      customContainer(),
      customCodeBlock(),
      LinkTarget(),
      Heading(),
      Img(),
    ],
    [theme],
  );
  return <MarkdownView content={props.content} plugins={plugins} />;
}
