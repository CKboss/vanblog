import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_FRONT_LOCALE,
  getLocale,
  subscribeI18n,
  t as translate,
  type FrontLocale,
  type TFunc,
} from "../utils/i18n";

/**
 * 🔴 前台多语言的**组件接缝**（期 10 第一批，2026-09-30）。
 *
 * 用法（与后台 `useIntl()` 的位置纪律相同：**只能在渲染期调用**）：
 * ```tsx
 * const t = useT();
 * return <button aria-label={t('search.submit', '搜索')}>{t('search.submit', '搜索')}</button>;
 * ```
 *
 * ## 为什么要这个 hook，而不是直接 `import { t }`
 * 直接 import 的那个 `t` 在**语种切换后不会让组件重渲染**（它只是个函数，React 不知道它依赖了什么）。
 * 这个 hook 做两件事：① 订阅语种/词典变化 ⇒ 切换语言时**用到它的组件会重渲染**；
 * ② 把当前语种"读"进渲染（`useState` 的初值 + `useEffect` 同步）⇒ 依赖关系对 React 可见。
 *
 * ⚠️ **SSR/水合安全**：初值取自 `getLocale()`，而接缝期它恒为 `zh-CN`（`DEFAULT_FRONT_LOCALE`），
 * 且词典为空 ⇒ 服务端与客户端渲染出的字符串**逐字节相同**，不会触发 React 的水合不匹配告警。
 * 🔴 将来接词典时，语种必须**在服务端就能确定**（请求头 / cookie / 路径前缀），
 * 否则"服务端渲染中文、客户端水合成英文"会闪一下并报警告 —— 那一批要连 `getStaticProps`/`getServerSideProps`
 * 与 ISR 缓存键一起考虑（**同一份静态产物要服务多个语种**，这是前台 i18n 最大的架构约束）。
 *
 * @returns 一个稳定的 `TFunc`（`(id, 中文默认值, 插值参数?) => 字符串`）
 */
export default function useT(): TFunc {
  const [locale, setLocaleState] = useState<FrontLocale>(() => getLocale());

  useEffect(() => {
    // 订阅期间语种可能已经变过（例如在 effect 挂载前就 setLocale 了）⇒ 先同步一次再订阅
    setLocaleState(getLocale());
    return subscribeI18n(() => setLocaleState(getLocale()));
  }, []);

  // 🔴 把 locale 读进闭包：这样"语种变了"就会产出一个新的函数引用 ⇒ 依赖它的 memo/子组件会重算。
  //    ⚠️ 接缝期 locale 恒为 zh-CN，所以这个 callback 实际上是稳定的（不会造成额外渲染）。
  return useCallback(
    (id: string, defaultMessage: string, values?: Record<string, unknown>) => {
      void locale;
      void DEFAULT_FRONT_LOCALE;
      return translate(id, defaultMessage, values);
    },
    [locale],
  );
}
