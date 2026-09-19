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
let loadFailureLogged = false;
const listeners = new Set<() => void>();

/**
 * 订阅"公式插件已加载"。
 *
 * ⚠️ 这里必须是**粘性**的（已加载就立刻回调），否则会丢通知：
 * `renderTocLabelHtml()` 在组件**首次渲染**的 useMemo 里就会调用 `ensureTocMathLoaded()`，
 * 而订阅是在 `useEffect` 里才发生的 —— 也就是说"发起加载"早于"订阅通知"。
 * 只要那个 import 在 effect 跑之前就 resolve（打包器把动态 import 内联时是微任务级、
 * 或者分块已被浏览器缓存命中），`listeners.forEach` 面对的就是一个空集合，
 * 通知发给了没人听 ⇒ `mathTick` 永不递增 ⇒ **TOC 标签永远停在 `$A$<$B$` 原文**，
 * 而且一条报错都没有（`ensureTocMathLoaded` 的 `.catch` 还是静默的）。
 * 生产环境之所以一直没暴露，只是因为真实网络分块比 effect 订阅慢 —— 那是运气，不是设计。
 * admin 的 e2e（`toc-heading.spec.js`，esbuild 内联了动态 import）确定性地复现了它。
 */
export function onTocMathReady(cb: () => void): () => void {
  listeners.add(cb);
  if (mathPluginFactory) {
    try {
      cb();
    } catch {
      // 单个订阅者出错不影响其它，也不影响已加载状态
    }
  }
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
      .catch((err) => {
        pending = null;
        // ⚠️ 以前这里是空 catch：公式插件加载失败时，TOC 标签会静默停在 `$...$` 原文，
        // 排查时唯一线索是"看起来没渲染公式"。留一条 warn，成本是一次性的。
        if (typeof console !== 'undefined' && !loadFailureLogged) {
          loadFailureLogged = true;
          console.warn('[tocMath] @bytemd/plugin-math-ssr 加载失败，TOC 里的公式将按原文显示：', err);
        }
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
 *
 * ⚠️ 返回 `null` 表示"没有可以安全当 HTML 用的东西"，调用方（`core.tsx`）必须走
 * "把标题文本当 React 子节点渲染"那条分支。**任何情况下都不要返回未转义的原文** ——
 * 详见下面两个回退分支里的说明。
 */
export function renderTocLabelHtml(text: string): string | null {
  const source = String(text || "");
  if (!tocLabelNeedsMath(source)) {
    // 不含 `$` ⇒ 根本没有非走 HTML 不可的理由，返回 null 让调用方渲染纯文本。
    //
    // ⚠️ 这里以前是 `return source`，那是一个**公开站源的存储型 XSS**：
    // 调用方把非 null 的返回值直接塞进 `dangerouslySetInnerHTML`（`core.tsx:190-191`），
    // 而 `source` 是标题的 `data-id` —— 来自 `utils/headingText.ts` 的 `collectHeadingText`，
    // 它返回的是**已解码**的 text 节点值。用反斜杠转义（`\<img src=1 onerror=…\>`）、
    // HTML 实体或行内代码都能让 `<img onerror=…>` 落进 text 节点：markdown 阶段它是纯文本、
    // sanitize 也放行（因为不是 html 节点），到了这里却被当 HTML 二次注入 ⇒ 典型 mXSS。
    // 触发者不限于管理员：有 `article:create` / `article:update` 的协作者就行
    // （`server/src/types/access/access.ts`），而后台 token 在同源 localStorage 里，
    // 管理员用同一浏览器打开那篇文章即被接管。
    return null;
  }
  if (!mathPluginFactory) {
    // 首次遇到带公式的标题：触发加载，加载完订阅者会重渲染。
    void ensureTocMathLoaded();
    // ⚠️ 同样**不能**返回原文（理由同上，而且这条分支更危险）：首次渲染**必然**走它 ——
    // SSR 阶段动态 import 还没 resolve，所以 payload 会直接进服务端渲染出的 HTML，
    // 不需要等客户端水合。返回 null 时用户看到的是纯文本标题（`$E=mc^2$` 也可读），
    // 功能不丢：`onTocMathReady` 通知一到就会重渲染成 KaTeX。
    return null;
  }
  const html = getProcessor({
    plugins: [mathPluginFactory()],
    sanitize: sanitizeMarkdownSchema,
  })
    .processSync(source)
    .toString();
  return unwrapSingleParagraph(html);
}
