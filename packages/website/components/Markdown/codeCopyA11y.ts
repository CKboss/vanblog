import { activatesWithKey, isFocusableActionControl } from "../../utils/keyboardA11y";
import { readFencedCodeText } from "./codeBlockLines";
import { IDENTITY_T, type TFunc } from "../../utils/i18n";

// 🔴 期 10 第四批：接上 i18n 接缝 —— **常量原样保留当默认值**（模块级常量在 import 期求值，
//    那时词典还没注入 ⇒ 绝不能把常量本身改成 `t(...)` 的结果），另加"取文案的函数"（尾参 `t = IDENTITY_T`），
//    消费方在**渲染期**用 `useT()` 的结果调它。规矩见 §7.205 A。
export const CODE_COPY_LABEL = "复制代码";
export const CODE_COPY_LABEL_ID = "markdown.copyCode";

/** 🔴 取"复制代码"按钮的 aria-label（渲染期调用）。 */
export function codeCopyLabel(t: TFunc = IDENTITY_T): string {
  return t(CODE_COPY_LABEL_ID, CODE_COPY_LABEL);
}
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
