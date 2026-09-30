import { useEffect, useState } from "react";

import useT from "../../hooks/useT";
import {
  applyFrontLocale,
  localeFullName,
  localeShortLabel,
  nextFrontLocale,
} from "../../utils/applyFrontLocale";
import { getLocale, type FrontLocale } from "../../utils/i18n";

/**
 * 🔴 前台**语言切换按钮**（期 10 第五批，2026-09-30；站长裁定「前台界面上增加一个切换按钮就可以了」）。
 *
 * ## 交互
 * 一个图标按钮，显示**当前**语种的短标签（`简` / `繁` / `EN`），点一下切到下一个
 * （zh-CN → zh-TW → en-US → 循环）。`title` 与 `aria-label` 给出完整名字与"切换到 X"的提示。
 *
 * ## 🔴 三个刻意的设计决定
 * 1. **短标签用各语言自己的写法**（`简` / `繁` / `EN`），不翻译它本身 ——
 *    🔴 否则会出现"要读得懂这个按钮，先得懂它指向的那种语言"的鸡生蛋问题
 *    （这是语言切换器的通用做法：endonym，自称）。
 * 2. **首帧一定显示默认语种**（`useState(() => getLocale())` + 挂载后同步一次）：
 *    cookie 只能在客户端读 ⇒ SSR 出来的 HTML 里它是 `简`，挂载后才可能变成 `繁`/`EN`。
 *    🔴 这是"不做 locale 路由"的必然代价，如实登记为已知限制（§7.207 D）：
 *    刷新页面时会先看到一帧中文界面再切换。
 * 3. **`aria-label` 走接缝**（`t("locale.switcher", …)`）而**短标签不走** ——
 *    短标签是"语言自称"，属数据；aria-label 是"这个控件是干什么的"，属界面文案。
 *    🔴 两者性质不同，别一并处理。
 *
 * ## ⚠️ 切换之后什么会变、什么不会变（如实说明，别让人以为坏了）
 * **会变**：所有已经过接缝的文案（`useT()` 的订阅者会重渲染）—— 目前是导航栏动作按钮的 aria-label、
 * 标题/链接/站点名的复制按钮与 toast、文章密码提示、相对时间、阅读时长、时间线月份等。
 * 🔴 **不会变**：① 文章/页面**正文**（站长裁定内容不做多语言）；
 * ② `getStaticProps` 里构造的数据（导航标题等，构建期就固化了）；
 * ③ markdown 管线里写进 AST 的属性（代码块复制按钮的 aria-label）；
 * ④ 还没过接缝的文案（收口台账里 206 条欠条）。
 * 👉 所以"按了按钮只有一部分文字变了"是**当前阶段的预期行为**，不是缺陷；
 * 覆盖率由 `__tests__/i18nDictionaryCoverage.spec.ts` 量化（词典 key 数 / 代码里用到的 id 数）。
 */
export default function LocaleSwitcher(props: { className?: string }) {
  const t = useT();
  const [locale, setLocaleState] = useState<FrontLocale>(() => getLocale());
  // 🔴 挂载前（SSR 与首帧）不读 cookie：`document` 不存在，而且读了也会造成水合不匹配。
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setLocaleState(getLocale());
  }, []);

  const onClick = () => {
    const next = nextFrontLocale(locale);
    // 🔴 三件事一起做（setLocale + 写 cookie + 同步 <html lang>），见 applyFrontLocale 的注释
    applyFrontLocale(next);
    setLocaleState(next);
  };

  const full = localeFullName(locale);
  const next = nextFrontLocale(locale);
  const label = t("locale.switcher", "切换语言：当前 {current}，点击切换到 {next}", {
    current: full,
    next: localeFullName(next),
  });

  return (
    <button
      type="button"
      onClick={onClick}
      className={
        props.className ||
        "locale-switcher bg-transparent border-0 appearance-none p-1 cursor-pointer text-gray-400 hover:text-gray-700 dark:text-dark-400 dark:hover:text-dark-200 transform transition-all hover:scale-125 text-sm leading-none font-medium"
      }
      aria-label={label}
      title={label}
      // 🔴 首帧刻意用默认语种渲染（`mounted` 之前不显示"已从 cookie 恢复的语种"），
      //    这样 SSR 与客户端首帧**逐字节相同** ⇒ 不会触发 React 的水合不匹配告警。
      data-mounted={mounted ? "true" : "false"}
      data-locale={locale}
    >
      {localeShortLabel(locale)}
    </button>
  );
}
