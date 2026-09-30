import {
  activatesWithKey,
  isFocusableActionControl,
} from "../../utils/keyboardA11y";
import { IDENTITY_T, type TFunc } from "../../utils/i18n";

export const HEADER_ACTION_LABELS = {
  search: "搜索",
  theme: "切换主题",
  rss: "RSS 订阅",
  admin: "管理后台",
  menu: "打开菜单",
} as const;

// 🔴 期 10 第四批：接上 i18n 接缝。这个族是**一张 map**（不是一个个常量）⇒
// 规矩同上（map 保留当默认值），另加"按 kind 取文案"的函数与 id 表（规矩见 §7.205 A）。
export const HEADER_ACTION_LABEL_IDS: Record<keyof typeof HEADER_ACTION_LABELS, string> = {
  search: "nav.actionSearch",
  theme: "nav.actionTheme",
  rss: "nav.actionRss",
  admin: "nav.actionAdmin",
  menu: "nav.actionMenu",
};

/** 🔴 取导航栏某个动作按钮的 aria-label（渲染期调用；`t` 来自 `useT()`）。 */
export function headerActionLabel(
  kind: keyof typeof HEADER_ACTION_LABELS,
  t: TFunc = IDENTITY_T
): string {
  return t(HEADER_ACTION_LABEL_IDS[kind], HEADER_ACTION_LABELS[kind]);
}

export type HeaderActionKind = keyof typeof HEADER_ACTION_LABELS;

export type HeaderActionControl = {
  kind: HeaderActionKind;
  tag: "button" | "a";
  type?: "button";
  ariaLabel: string;
  href?: string;
  activateKeys: readonly string[];
  focusable: true;
};

const BUTTON_KEYS = ["Enter", " "] as const;
const LINK_KEYS = ["Enter"] as const;

/** Tailwind reset so icon <button>s keep the previous div hover/scale look. */
export const ICON_ACTION_BUTTON_CLASS =
  "bg-transparent border-0 p-0 appearance-none";

export function describeHeaderActions(options?: {
  showAdmin?: boolean;
  showRss?: boolean;
}): HeaderActionControl[] {
  const showAdmin = options?.showAdmin ?? true;
  const showRss = options?.showRss ?? true;
  const controls: HeaderActionControl[] = [
    {
      kind: "search",
      tag: "button",
      type: "button",
      ariaLabel: HEADER_ACTION_LABELS.search,
      activateKeys: BUTTON_KEYS,
      focusable: true,
    },
    {
      kind: "theme",
      tag: "button",
      type: "button",
      ariaLabel: HEADER_ACTION_LABELS.theme,
      activateKeys: BUTTON_KEYS,
      focusable: true,
    },
  ];
  if (showRss) {
    controls.push({
      kind: "rss",
      tag: "button",
      type: "button",
      ariaLabel: HEADER_ACTION_LABELS.rss,
      activateKeys: BUTTON_KEYS,
      focusable: true,
    });
  }
  if (showAdmin) {
    controls.push({
      kind: "admin",
      tag: "a",
      ariaLabel: HEADER_ACTION_LABELS.admin,
      href: "/admin",
      activateKeys: LINK_KEYS,
      focusable: true,
    });
  }
  controls.push({
    kind: "menu",
    tag: "button",
    type: "button",
    ariaLabel: HEADER_ACTION_LABELS.menu,
    activateKeys: BUTTON_KEYS,
    focusable: true,
  });
  return controls;
}

export function headerActionIsKeyboardActivatable(
  control: HeaderActionControl,
  key: string
): boolean {
  return (
    control.focusable &&
    isFocusableActionControl({
      tagName: control.tag,
      type: control.type,
      href: control.href,
    }) &&
    activatesWithKey(control.tag, key)
  );
}

export { activatesWithKey, isFocusableActionControl };
