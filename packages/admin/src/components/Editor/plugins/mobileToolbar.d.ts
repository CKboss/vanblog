import type { BytemdPlugin } from 'bytemd';

export const BYTEMD_SPLIT_MIN_WIDTH: number;
export const MOBILE_TOOLBAR_CLASS: string;
export const MOBILE_TOOLBAR_ACTIONS: ReadonlyArray<{ id: string; title: string }>;
/** 🔴 期 6 第一批：标题改成从**上游 bytemd locale** 读（不再手抄中文）⇒ 新增这几个导出 */
export const MOBILE_TOOLBAR_ACTION_KEYS: ReadonlyArray<{ id: string; localeKey: string }>;
export const HEADING_LEVELS: ReadonlyArray<{ level: number; localeKey: string }>;
export function buildMobileToolbarActions(
  locale?: Record<string, string> | null,
): Array<{ id: string; title: string }>;
export function buildHeadingLevels(
  locale?: Record<string, string> | null,
): Array<{ level: number; title: string }>;

export function isByteMDTabMode(
  root: { querySelector?: (selector: string) => unknown } | null | undefined,
): boolean;

export function applyToolbarAction(
  ctx: {
    wrapText?: (before: string, after?: string) => void;
    replaceLines?: (fn: (line: string, index: number) => string) => void;
    appendBlock?: (text: string) => { line: number };
    editor?: { focus?: () => void; setSelection?: (from: unknown, to: unknown) => void };
    codemirror?: { Pos: (line: number, ch?: number) => unknown };
  },
  id: string,
  extra?: number,
): void;

export function insertUploadedImages(
  ctx: { appendBlock?: (text: string) => { line: number } },
  imgs: Array<{ url?: string; alt?: string; title?: string }>,
): void;

export function syncMobileToolbar(
  root: { querySelector?: (selector: string) => any } | null | undefined,
  createBar?: () => { className?: string; remove?: () => void } | null,
): { mounted: boolean };

export function createMobileToolbarElement(
  ctx: unknown,
  options?: {
    uploadImages?: (files: File[]) => Promise<Array<{ url: string; alt?: string; title?: string }>>;
    /** 🔴 `pickEditorLocale()` 合成的那个对象：工具栏 11 个标题从它里面读 */
    locale?: Record<string, string>;
  },
): HTMLElement;

export function mobileToolbarPlugin(options?: {
  uploadImages?: (files: File[]) => Promise<Array<{ url: string; alt?: string; title?: string }>>;
  /** 🔴 `pickEditorLocale()` 合成的那个对象：工具栏 11 个标题从它里面读 */
  locale?: Record<string, string>;
}): BytemdPlugin;
