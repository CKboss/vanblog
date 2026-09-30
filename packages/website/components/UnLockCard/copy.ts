import { IDENTITY_T, type TFunc } from "../../utils/i18n";
/** Prompt shown while the article is still encrypted and a password is required. */
// 🔴 期 10 第四批：接上 i18n 接缝 —— **常量原样保留当默认值**（模块级常量在 import 期求值，
//    那时词典还没注入 ⇒ 绝不能把常量本身改成 `t(...)` 的结果），另加"取文案的函数"（尾参 `t = IDENTITY_T`），
//    消费方在**渲染期**用 `useT()` 的结果调它。规矩见 §7.205 A。
export const LOCKED_ARTICLE_PROMPT = "文章已加密，请输入密码后查看：";
export const LOCKED_ARTICLE_PROMPT_ID = "unlock.lockedPrompt";

/** 🔴 取"文章已加密"那句提示（渲染期调用）。 */
export function lockedArticlePrompt(t: TFunc = IDENTITY_T): string {
  return t(LOCKED_ARTICLE_PROMPT_ID, LOCKED_ARTICLE_PROMPT);
}
