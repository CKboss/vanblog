import { setLocale, type FrontLocale } from "./i18n";
import { writeSavedLocale } from "./localePreference";

/**
 * 🔴 切换语种时要一起做的三件事（期 10 第五批）。
 *
 * 为什么抽成一个函数而不是写在按钮的 onClick 里：
 * 🔴 这三件事**必须同时做、且顺序固定**，漏掉任何一件都会出现"看起来切了、其实没切干净"：
 * ① `setLocale()` —— 通知接缝层（`useT()` 的订阅者会重渲染）；
 * ② 写 cookie —— 否则刷新就丢；
 * ③ 🔴 同步 `<html lang>` —— **屏幕阅读器据此选发音规则**，
 *    `lang="zh-CN"` 的页面里显示英文，读屏会用中文音素念英文（这正是 `_document.tsx` 那段注释在讲的事）。
 *    ⚠️ `_document.tsx` 里的 `<Html lang="zh-CN">` 是**构建期**写死的，客户端只能用 DOM 改
 *    （`document.documentElement.lang = …`）⇒ 这是"不做 locale 路由"这个方案的必然代价（见 §7.207）。
 *
 * `dir` 刻意**不动**：zh-CN / zh-TW / en-US 三种都是 `ltr`；
 * 🔴 但这一行要留着，因为将来若加阿拉伯语/希伯来语，`dir` 必须跟着变（漏了会整版镜像错乱）。
 */
export function applyFrontLocale(next: FrontLocale): FrontLocale {
  setLocale(next);
  writeSavedLocale(next);
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = next;
    // 🔴 三种语种都是 ltr；保留这行是为了将来加 rtl 语种时不会漏（现在写死 ltr 是**正确**的）
    document.documentElement.dir = "ltr";
  }
  return next;
}

/** 下一个语种（切换按钮用：zh-CN → zh-TW → en-US → zh-CN 循环）。 */
export function nextFrontLocale(current: FrontLocale): FrontLocale {
  const order: FrontLocale[] = ["zh-CN", "zh-TW", "en-US"];
  const i = order.indexOf(current);
  return order[(i + 1) % order.length];
}

/** 按钮上显示的短标签（🔴 刻意用各语言**自己**的写法，这样不需要翻译它本身）。 */
export function localeShortLabel(locale: FrontLocale): string {
  if (locale === "zh-TW") return "繁";
  if (locale === "en-US") return "EN";
  return "简";
}

/** 完整名字（给 title / aria-label 用；同样用各语言自己的写法）。 */
export function localeFullName(locale: FrontLocale): string {
  if (locale === "zh-TW") return "繁體中文";
  if (locale === "en-US") return "English";
  return "简体中文";
}
