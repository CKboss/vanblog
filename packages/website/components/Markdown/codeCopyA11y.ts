import { activatesWithKey, isFocusableActionControl } from "../../utils/keyboardA11y";
import { readFencedCodeText } from "./codeBlockLines";

// 🔴 **站长裁定（2026-10-01）：markdown 管线保持现状** ⇒ 「复制代码」这条**不接多语言**（永久例外）。
//    原因与 `customContainer.tsx` 那 5 条完全相同：唯一的消费方 `codeBlock.tsx` 是在
//    **markdown 处理管线里构造 AST 节点**（`properties: { ariaLabel: CODE_COPY_LABEL }`），
//    不在 React 渲染期；而且两个消费方的插件数组是 `useMemo(…, [])`（空依赖）⇒ 切语种不会重建插件。
//    ⚠️ 如实说明后果：英文/繁中界面下，代码块复制按钮的 aria-label / title 仍是中文「复制代码」。
//    🔴 期 10 第四批曾给它加过接缝函数（`codeCopyLabel(t)` + `CODE_COPY_LABEL_ID`），
//    本批按裁定**一并删掉**，并把词典里的 `markdown.copyCode` 也移除 ——
//    👉 **留着"没有消费方的接缝函数 + 词典条目"是有害的**：它让人以为这里已经支持多语言了
//    （而实际渲染出来的永远是中文），比"根本没接"更难发现。
//    ⚠️ 若将来裁定改了，恢复方式见 §7.213 F（要连 `useMemo` 依赖与 `perfBudget` 判据一起评估）。
export const CODE_COPY_LABEL = "复制代码";

export const CODE_COPY_CLASS = "code-copy-btn";

export const CODE_COPY_CONTROL = {
  tag: "button" as const,
  type: "button" as const,
  className: CODE_COPY_CLASS,
  // 🔴 这个对象是**模块级常量**，`ariaLabel` 只能是中文默认值（import 期求值，词典还没注入）。
  //    ⚠️ 唯一的消费方 `Markdown/codeBlock.tsx` 是在 **markdown 处理管线里构造 AST 节点**
  //    （不是 React 渲染期）⇒ 用不了 hook，也没法在那里调 `codeCopyLabel(t)`。
  //    🔴 要让它过接缝，必须把 `t`（或已取好的字符串）从组件**透传进 processor 的配置** ——
  //    那是一次跨层改造，单独排一批（台账里登记为欠条并写明了这个原因）。
  ariaLabel: CODE_COPY_LABEL,
  activateKeys: ["Enter", " "] as const,
  focusable: true,
};

export function describeCodeCopyControl() {
  return CODE_COPY_CONTROL;
}

export function codeCopyIsKeyboardActivatable(key: string): boolean {
  return (
    isFocusableActionControl({
      tagName: CODE_COPY_CONTROL.tag,
      type: CODE_COPY_CONTROL.type,
    }) && activatesWithKey(CODE_COPY_CONTROL.tag, key)
  );
}

export function readCodeFromCopyButton(copyBtn: {
  parentElement?: {
    parentElement?: {
      querySelector?: (selector: string) => {
        innerText?: string;
        textContent?: string;
        querySelectorAll?: (
          selector: string
        ) => ArrayLike<{ textContent?: string; innerText?: string }>;
      } | null;
    } | null;
  } | null;
}): string {
  return readFencedCodeText(
    copyBtn.parentElement?.parentElement?.querySelector?.("code")
  );
}
