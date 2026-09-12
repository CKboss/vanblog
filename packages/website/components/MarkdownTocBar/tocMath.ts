import { getProcessor } from "bytemd";
import { sanitizeMarkdownSchema } from "../../utils/markdownSanitize";

/**
 * `@bytemd/plugin-math-ssr` 会把整个 KaTeX（~275KB / gzip ~75KB）拖进引用它的 chunk。
 * 而 TOC 标签里出现 TeX 是极少数情况，所以这里**改成按需 import**：
 * 只有真的遇到带 `$` 的标题才去加载，加载完通过订阅通知组件重渲染一次。
 * 在此之前标签先按原文显示（`$E=mc^2$` 也是可读的），不会白屏也不会闪。
 */
type MathPluginFactory = () => any;
let mathPluginFactory: MathPluginFactory | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function onTocMathReady(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function isTocMathLoaded(): boolean {
  return mathPluginFactory !== null;
}

export function ensureTocMathLoaded(): Promise<void> {
  if (mathPluginFactory) {
    return Promise.resolve();
  }
  if (!pending) {
    pending = import("@bytemd/plugin-math-ssr")
      .then((mod: any) => {
        mathPluginFactory = (mod?.default ?? mod) as MathPluginFactory;
        pending = null;
        listeners.forEach((cb) => {
          try {
            cb();
          } catch {
            // 单个订阅者出错不影响其它
          }
        });
      })
      .catch(() => {
        pending = null;
      });
  }
  return pending;
}

/** True when a TOC label may contain `$...$` / `$$...$$` TeX. */
export function tocLabelNeedsMath(text: string): boolean {
  return String(text || "").includes("$");
}

function unwrapSingleParagraph(html: string): string {
  const trimmed = html.trim();
  const wrapped = trimmed.match(/^<p>([\s\S]*)<\/p>$/i);
  return wrapped ? wrapped[1] : trimmed;
}

/**
 * Render a public TOC label with the same KaTeX path as the article body.
 * Scroll matching stays on the unparsed heading text; only the visible label
 * goes through `@bytemd/plugin-math-ssr`.
 */
export function renderTocLabelHtml(text: string): string {
  const source = String(text || "");
  if (!tocLabelNeedsMath(source)) {
    return source;
  }
  if (!mathPluginFactory) {
    // 首次遇到带公式的标题：触发加载，先返回原文；加载完订阅者会重渲染
    void ensureTocMathLoaded();
    return source;
  }
  const html = getProcessor({
    plugins: [mathPluginFactory()],
    sanitize: sanitizeMarkdownSchema,
  })
    .processSync(source)
    .toString();
  return unwrapSingleParagraph(html);
}
