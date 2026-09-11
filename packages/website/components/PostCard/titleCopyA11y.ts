import {
  activatesWithKey,
  isFocusableActionControl,
} from "../../utils/keyboardA11y";

/**
 * Titles are content, not chrome: readers have to be able to select and copy
 * them, so the title nodes carry `select-text` and never `select-none`.
 */
export const TITLE_SELECTABLE_CLASS = "select-text";

export const TITLE_COPY_LABEL = "复制标题";
export const TITLE_LINK_COPY_LABEL = "复制文章链接";
export const SITE_NAME_COPY_LABEL = "复制站点名";

export const TITLE_COPY_CLASS = "title-copy-btn";
export const TITLE_LINK_COPY_CLASS = "title-link-copy-btn";
export const SITE_NAME_COPY_CLASS = "site-name-copy-btn";

export const TITLE_COPY_TOAST = "已复制标题到剪切板！";
export const TITLE_LINK_COPY_TOAST = "已复制文章链接到剪切板！";
export const SITE_NAME_COPY_TOAST = "已复制站点名到剪切板！";

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

export const TITLE_COPY_CONTROL: TitleCopyControl = {
  kind: "title",
  tag: "button",
  type: "button",
  className: TITLE_COPY_CLASS,
  ariaLabel: TITLE_COPY_LABEL,
  toast: TITLE_COPY_TOAST,
  activateKeys: BUTTON_KEYS,
  focusable: true,
};

export const TITLE_LINK_COPY_CONTROL: TitleCopyControl = {
  kind: "link",
  tag: "button",
  type: "button",
  className: TITLE_LINK_COPY_CLASS,
  ariaLabel: TITLE_LINK_COPY_LABEL,
  toast: TITLE_LINK_COPY_TOAST,
  activateKeys: BUTTON_KEYS,
  focusable: true,
};

export const SITE_NAME_COPY_CONTROL: TitleCopyControl = {
  kind: "siteName",
  tag: "button",
  type: "button",
  className: SITE_NAME_COPY_CLASS,
  ariaLabel: SITE_NAME_COPY_LABEL,
  toast: SITE_NAME_COPY_TOAST,
  activateKeys: BUTTON_KEYS,
  focusable: true,
};

export function describeTitleCopyControls(): TitleCopyControl[] {
  return [TITLE_COPY_CONTROL, TITLE_LINK_COPY_CONTROL, SITE_NAME_COPY_CONTROL];
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
