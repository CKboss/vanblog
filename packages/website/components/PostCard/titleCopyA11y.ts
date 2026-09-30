import {
  activatesWithKey,
  isFocusableActionControl,
} from "../../utils/keyboardA11y";
import { IDENTITY_T, type TFunc } from "../../utils/i18n";

/**
 * Titles are content, not chrome: readers have to be able to select and copy
 * them, so the title nodes carry `select-text` and never `select-none`.
 */
export const TITLE_SELECTABLE_CLASS = "select-text";

/**
 * 🔴 期 10 第三批：**导出常量 = 默认文案**（保留原样，既有测试与调用点都不用改），
 * 另加 `*_ID` 与"按 kind 取文案"的函数 —— 这才是接缝。
 *
 * ## 为什么不能把常量本身改成 `t(...)` 的求值结果
 * 🔴 模块级常量在 **import 期**就求值，而那时词典还没注入（`setDictionary` 是运行时调的）
 * ⇒ 中文会被**永久固化**进这个模块，接了词典也没用。
 * 👉 规矩（本批定下，后面几批都照这个来）：**常量留作默认值 + 另加取文案的函数（尾参 `t = IDENTITY_T`）
 * + 消费方改调函数**。函数在**渲染期**被调用，那时 `useT()` 已经拿到当前语种。
 */
export const TITLE_COPY_LABEL = "复制标题";
export const TITLE_LINK_COPY_LABEL = "复制文章链接";
export const SITE_NAME_COPY_LABEL = "复制站点名";

export const TITLE_COPY_LABEL_ID = "postCard.copyTitle";
export const TITLE_LINK_COPY_LABEL_ID = "postCard.copyArticleLink";
export const SITE_NAME_COPY_LABEL_ID = "postCard.copySiteName";

export const TITLE_COPY_CLASS = "title-copy-btn";
export const TITLE_LINK_COPY_CLASS = "title-link-copy-btn";
export const SITE_NAME_COPY_CLASS = "site-name-copy-btn";

export const TITLE_COPY_TOAST = "已复制标题到剪切板！";
export const TITLE_LINK_COPY_TOAST = "已复制文章链接到剪切板！";
export const SITE_NAME_COPY_TOAST = "已复制站点名到剪切板！";

export const TITLE_COPY_TOAST_ID = "postCard.copiedTitle";
export const TITLE_LINK_COPY_TOAST_ID = "postCard.copiedArticleLink";
export const SITE_NAME_COPY_TOAST_ID = "postCard.copiedSiteName";

/** 🔴 按 kind 取"复制按钮的 aria-label/title"（渲染期调用，`t` 由组件的 `useT()` 传进来）。 */
export function titleCopyLabel(kind: TitleCopyKind, t: TFunc = IDENTITY_T): string {
  if (kind === "link") return t(TITLE_LINK_COPY_LABEL_ID, TITLE_LINK_COPY_LABEL);
  if (kind === "siteName") return t(SITE_NAME_COPY_LABEL_ID, SITE_NAME_COPY_LABEL);
  return t(TITLE_COPY_LABEL_ID, TITLE_COPY_LABEL);
}

/** 🔴 按 kind 取"复制成功的 toast 文案"。 */
export function titleCopyToast(kind: TitleCopyKind, t: TFunc = IDENTITY_T): string {
  if (kind === "link") return t(TITLE_LINK_COPY_TOAST_ID, TITLE_LINK_COPY_TOAST);
  if (kind === "siteName") return t(SITE_NAME_COPY_TOAST_ID, SITE_NAME_COPY_TOAST);
  return t(TITLE_COPY_TOAST_ID, TITLE_COPY_TOAST);
}

export type TitleCopyKind = "title" | "link" | "siteName";

export type TitleCopyControl = {
  kind: TitleCopyKind;
  tag: "button";
  type: "button";
  className: string;
  ariaLabel: string;
  toast: string;
  activateKeys: readonly string[];
  focusable: true;
};

const BUTTON_KEYS = ["Enter", " "] as const;

const CLASS_BY_KIND: Record<TitleCopyKind, string> = {
  title: TITLE_COPY_CLASS,
  link: TITLE_LINK_COPY_CLASS,
  siteName: SITE_NAME_COPY_CLASS,
};

/**
 * 🔴 造一个"复制按钮"的无障碍契约对象。`t` 默认 `IDENTITY_T` ⇒ 不传时与迁移前**逐字节相同**。
 * ⚠️ 这三个导出常量（`TITLE_COPY_CONTROL` 等）是**用默认 `t` 造出来的**，所以它们永远是中文 ——
 * 需要译文的调用方必须自己调 `buildTitleCopyControl(kind, t)`（`t` 来自 `useT()`）。
 */
export function buildTitleCopyControl(
  kind: TitleCopyKind,
  t: TFunc = IDENTITY_T
): TitleCopyControl {
  return {
    kind,
    tag: "button",
    type: "button",
    className: CLASS_BY_KIND[kind],
    ariaLabel: titleCopyLabel(kind, t),
    toast: titleCopyToast(kind, t),
    activateKeys: BUTTON_KEYS,
    focusable: true,
  };
}

export const TITLE_COPY_CONTROL: TitleCopyControl = buildTitleCopyControl("title");
export const TITLE_LINK_COPY_CONTROL: TitleCopyControl = buildTitleCopyControl("link");
export const SITE_NAME_COPY_CONTROL: TitleCopyControl = buildTitleCopyControl("siteName");

export function describeTitleCopyControls(t: TFunc = IDENTITY_T): TitleCopyControl[] {
  return [
    buildTitleCopyControl("title", t),
    buildTitleCopyControl("link", t),
    buildTitleCopyControl("siteName", t),
  ];
}

/** Native <button> contract: Enter and Space both activate. */
export function titleCopyIsKeyboardActivatable(key: string): boolean {
  return (
    isFocusableActionControl({
      tagName: TITLE_COPY_CONTROL.tag,
      type: TITLE_COPY_CONTROL.type,
    }) && activatesWithKey(TITLE_COPY_CONTROL.tag, key)
  );
}

/**
 * Absolute article URL for the clipboard. `origin` is empty during SSR (the
 * host is unknown), which still yields a usable root-relative path.
 */
export function articleUrl(origin: string, id: number | string): string {
  return `${origin}/post/${id}`;
}
