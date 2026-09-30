import {
  PageNavProps,
  pageCount,
  pageHref,
  shouldShowPageNav,
} from "./core";
import { IDENTITY_T, type TFunc } from "../../utils/i18n";

/** Landmark / form name for the jump-to-page control. */
export const PAGE_NAV_JUMP_LABEL = "跳转到页码";
export const PAGE_NAV_JUMP_PREFIX = "跳转";
export const PAGE_NAV_JUMP_UNIT = "页";
export const PAGE_NAV_JUMP_INPUT_LABEL = "页码";
export const PAGE_NAV_JUMP_GO_LABEL = "前往";

// 🔴 期 10 第四批：接上 i18n 接缝（常量保留当默认值，另加取文案的函数；规矩见 §7.205 A）。
// ⚠️ `PREFIX` / `UNIT` 是"跳转 [输入框] 页"这种**拼接式**文案的两半 ⇒
// 🔴 英文语序不同（`Go to page [input]`），**只翻这两半永远拼不对**。
// 所以除了逐条的取文案函数，还额外给一个**整句模板**接缝 `pageNavJumpSentence(t)`：
// 它用 `{input}` 占位符表示输入框的位置，接词典时英文可以整句重排。
// 现在（接缝期）它按中文语序拼回来 ⇒ 与今天的渲染结果**逐字节相同**。
export const PAGE_NAV_JUMP_LABEL_ID = "pageNav.jumpLabel";
export const PAGE_NAV_JUMP_PREFIX_ID = "pageNav.jumpPrefix";
export const PAGE_NAV_JUMP_UNIT_ID = "pageNav.jumpUnit";
export const PAGE_NAV_JUMP_INPUT_LABEL_ID = "pageNav.jumpInputLabel";
export const PAGE_NAV_JUMP_GO_LABEL_ID = "pageNav.jumpGoLabel";
export const PAGE_NAV_JUMP_SENTENCE_ID = "pageNav.jumpSentence";

export function pageNavJumpLabel(t: TFunc = IDENTITY_T): string {
  return t(PAGE_NAV_JUMP_LABEL_ID, PAGE_NAV_JUMP_LABEL);
}
export function pageNavJumpPrefix(t: TFunc = IDENTITY_T): string {
  return t(PAGE_NAV_JUMP_PREFIX_ID, PAGE_NAV_JUMP_PREFIX);
}
export function pageNavJumpUnit(t: TFunc = IDENTITY_T): string {
  return t(PAGE_NAV_JUMP_UNIT_ID, PAGE_NAV_JUMP_UNIT);
}
export function pageNavJumpInputLabel(t: TFunc = IDENTITY_T): string {
  return t(PAGE_NAV_JUMP_INPUT_LABEL_ID, PAGE_NAV_JUMP_INPUT_LABEL);
}
export function pageNavJumpGoLabel(t: TFunc = IDENTITY_T): string {
  return t(PAGE_NAV_JUMP_GO_LABEL_ID, PAGE_NAV_JUMP_GO_LABEL);
}
/** 🔴 整句模板：`{input}` 是输入框的位置（英文可以整句重排，中文就是"跳转 {input} 页"）。 */
export function pageNavJumpSentence(input: string, t: TFunc = IDENTITY_T): string {
  return t(PAGE_NAV_JUMP_SENTENCE_ID, `${PAGE_NAV_JUMP_PREFIX} {input} ${PAGE_NAV_JUMP_UNIT}`, {
    input,
  });
}
export const PAGE_NAV_JUMP_INPUT_ID = "page-nav-jump";
export const PAGE_NAV_JUMP_INPUT_ATTR = "data-page-nav-jump-input";

export type PageNavJumpOk = {
  ok: true;
  page: number;
  href: string;
};

export type PageNavJumpFail = {
  ok: false;
  reason: "empty" | "invalid" | "outofrange" | "unavailable";
};

export type PageNavJumpResult = PageNavJumpOk | PageNavJumpFail;

export type PageNavJumpProps = Pick<
  PageNavProps,
  "total" | "pageSize" | "base" | "more"
>;

/**
 * Parse a typed page number. Empty / non-integer strings return null so the
 * caller can refuse to navigate (no crash, no blank `/page/NaN`).
 */
export function parseJumpPage(raw: string): number | null {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") {
    return null;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const page = Number(trimmed);
  if (!Number.isFinite(page)) {
    return null;
  }
  return page;
}

export function shouldShowPageNavJump(
  total: number,
  pageSize?: number
): boolean {
  return shouldShowPageNav(total, pageSize);
}

export function describePageNavJump(props: PageNavJumpProps) {
  const totalPages = pageCount(props.total, props.pageSize);
  const visible = shouldShowPageNavJump(props.total, props.pageSize);
  return {
    visible,
    totalPages,
    label: PAGE_NAV_JUMP_LABEL,
    prefix: PAGE_NAV_JUMP_PREFIX,
    unit: PAGE_NAV_JUMP_UNIT,
    input: {
      tag: "input" as const,
      type: "number" as const,
      id: PAGE_NAV_JUMP_INPUT_ID,
      min: 1,
      max: Math.max(totalPages, 1),
      step: 1,
      focusable: true,
      ariaLabel: PAGE_NAV_JUMP_INPUT_LABEL,
      attr: PAGE_NAV_JUMP_INPUT_ATTR,
    },
    submit: {
      tag: "button" as const,
      type: "submit" as const,
      focusable: true,
      ariaLabel: PAGE_NAV_JUMP_GO_LABEL,
    },
  };
}

export function resolvePageNavJump(
  raw: string,
  props: PageNavJumpProps
): PageNavJumpResult {
  const totalPages = pageCount(props.total, props.pageSize);
  if (totalPages <= 1) {
    return { ok: false, reason: "unavailable" };
  }
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty" };
  }
  const parsed = parseJumpPage(raw);
  if (parsed === null) {
    return { ok: false, reason: "invalid" };
  }
  if (parsed < 1 || parsed > totalPages) {
    return { ok: false, reason: "outofrange" };
  }
  return {
    ok: true,
    page: parsed,
    href: pageHref(props.base, props.more, parsed),
  };
}

export function submitPageNavJump(
  raw: string,
  props: PageNavJumpProps,
  navigate: (href: string) => void
): PageNavJumpResult {
  const result = resolvePageNavJump(raw, props);
  if (result.ok) {
    navigate(result.href);
  }
  return result;
}

/** Form submit (mouse click on 前往, or native Enter in the input). */
export function handlePageNavJumpSubmit(
  event: { preventDefault: () => void },
  raw: string,
  props: PageNavJumpProps,
  navigate: (href: string) => void
): PageNavJumpResult {
  event.preventDefault();
  return submitPageNavJump(raw, props, navigate);
}

/**
 * Enter in the number field uses the same path as the form. Other keys
 * (including ArrowLeft / ArrowRight) are left alone so #542 page-link
 * arrows and the native spinner keep working.
 */
export function handlePageNavJumpKeyDown(
  event: { key: string; preventDefault: () => void },
  raw: string,
  props: PageNavJumpProps,
  navigate: (href: string) => void
): PageNavJumpResult | null {
  if (event.key !== "Enter") {
    return null;
  }
  event.preventDefault();
  return submitPageNavJump(raw, props, navigate);
}
