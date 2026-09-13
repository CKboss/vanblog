import { Head, Html, Main, NextScript } from "next/document";
import { THEME_INIT_SCRIPT } from "../utils/theme";

export default function Document() {
  // lang 用规范的 BCP 47 标签 zh-CN（不是 zh，也不是 cn）：屏幕阅读器据此选发音规则，
  // 搜索引擎据此判断页面语言，浏览器据此决定是否提供翻译。
  // 与 og:locale=zh_CN、RSS 的 <language>zh-CN</language>、JSON-LD 的 inLanguage 保持一致。
  // ⚠️ 这段说明不能写成 return ( {/* … */} <Html …> ) 的形式：JSX 注释放在**返回表达式的
  // 顶层**会让整个括号变成一个对象字面量，页面直接 500（本次就踩过）。要注释就放在
  // return 之前，或者放在 <Html> 内部当第一个子节点。
  return (
    <Html lang="zh-CN" suppressHydrationWarning>
      <Head>
        <script
          id="vanblog-theme-init"
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
