import { IDENTITY_T, type TFunc } from "../utils/i18n";
/** Public category-list page: collapsed by default, matching the previous hardcoded UI. */
export const DEFAULT_EXPAND_ALL_CATEGORIES = false;

// 🔴 期 10 第四批：接上 i18n 接缝 —— **常量原样保留当默认值**（模块级常量在 import 期求值，
//    那时词典还没注入 ⇒ 绝不能把常量本身改成 `t(...)` 的结果），另加"取文案的函数"（尾参 `t = IDENTITY_T`），
//    消费方在**渲染期**用 `useT()` 的结果调它。规矩见 §7.205 A。
export const CATEGORY_EXPAND_ALL_LABEL = "全部展开";
export const CATEGORY_COLLAPSE_ALL_LABEL = "全部收起";

export const CATEGORY_EXPAND_ALL_LABEL_ID = "category.expandAll";
export const CATEGORY_COLLAPSE_ALL_LABEL_ID = "category.collapseAll";

/** 🔴 取"全部展开 / 全部收起"按钮文案（渲染期调用）。 */
export function categoryExpandAllLabel(t: TFunc = IDENTITY_T): string {
  return t(CATEGORY_EXPAND_ALL_LABEL_ID, CATEGORY_EXPAND_ALL_LABEL);
}
export function categoryCollapseAllLabel(t: TFunc = IDENTITY_T): string {
  return t(CATEGORY_COLLAPSE_ALL_LABEL_ID, CATEGORY_COLLAPSE_ALL_LABEL);
}

/** Collapsed disclosure mark; CSS rotate-90 turns it into a downward "V". */
export const CATEGORY_EXPAND_CHEVRON = ">";

export function isDefaultExpandAllCategories(value: unknown): boolean {
  return value === true || value === "true";
}

export function initialCategoryOpenMap(
  names: string[],
  defaultExpandAll: boolean
): Record<string, boolean> {
  return Object.fromEntries(names.map((name) => [name, defaultExpandAll]));
}

export function setAllCategoryOpen(
  names: string[],
  open: boolean
): Record<string, boolean> {
  return Object.fromEntries(names.map((name) => [name, open]));
}

export function toggleCategoryOpen(
  map: Record<string, boolean>,
  name: string
): Record<string, boolean> {
  return { ...map, [name]: !Boolean(map[name]) };
}

export function nextOpenState(open: boolean): boolean {
  return !open;
}

export function expandControlIcon(open: boolean): string {
  return CATEGORY_EXPAND_CHEVRON;
}

export function expandControlAriaExpanded(open: boolean): "true" | "false" {
  return open ? "true" : "false";
}
