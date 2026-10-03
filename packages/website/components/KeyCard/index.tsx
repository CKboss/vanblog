import { useEffect, useState } from "react";
import { isMac } from "../../utils/ua";

import useT from "../../hooks/useT";
import { IDENTITY_T, type TFunc } from "../../utils/i18n";

/**
 * 🔴 期 12 第二批：快捷键提示的**读屏文案**过接缝。
 *
 * 改之前这 4 段是**硬编码英文**（`Press ` / ` and ` / ` to search` / ` to close`），
 * 而本站默认语种是 zh-CN、其余文案全是中文 ⇒ 中文用户用读屏软件听到的是
 * 「Press Ctrl + K to search」这种夹生英文。
 *
 * ⚠️ 为什么尺子（`bareChinese`）**从来没报过它**：那把尺子只量"裸中文"，
 * 🔴 而这是**反方向的同类问题**（裸英文）。👉 所以它不是被判据抓到的，
 * 而是**真浏览器探针把渲染出来的文本打出来**才看见的（弹窗文本里那句 `Press esc to close`）——
 * 这正是"UI 可见的改动必须真浏览器验证"的又一个理由：**判据量不到的方向，只能靠看**。
 *
 * 🔴 接缝的形状：`t(id, 中文默认值)` ⇒ **代码里的默认值必须是中文**（zh-CN 没有词典文件，
 * 代码默认值就是简中文案），英文/繁中住在 `locales/*.ts`。
 * ⚠️ 于是这一改会让**尺子的计数上升**（文件里多了 4 条中文字面量）：
 * 这不是退步，而是"把原本只有英文的文案补上了中文默认值"⇒ 台账如实登记为 `seamed`，
 * 并在棘轮那条注释里写明总数为什么涨（🔴 上调预算必须写原因，否则棘轮就失去意义）。
 *
 * ⚠️ 刻意**不做整句模板**：这几段是围着 `<kbd>` 元素拼的（`Press` + 键帽 + `and` + 键帽 + `to search`），
 * 要整句就得把 `<kbd>` 也塞进字符串（用 dangerouslySetInnerHTML 或拆成占位符组件）——
 * 🔴 站长裁定"前台 i18n 不用做太复杂"⇒ 保留分段，只把每段过接缝。
 * 实际影响：英文语序与中文语序在这里**恰好一致**（都是"按 X 和 Y 做某事"），
 * 所以分段拼不会拼错；⚠️ 若将来某种语言语序不同，这一族要改成整句模板（与 `PageNav` 同一条教训）。
 */
export const KEY_HINT_PRESS_ID = "keyHint.press";
export const KEY_HINT_PRESS = "按下 ";
export const KEY_HINT_AND_ID = "keyHint.and";
export const KEY_HINT_AND = " 和 ";
export const KEY_HINT_TO_SEARCH_ID = "keyHint.toSearch";
export const KEY_HINT_TO_SEARCH = " 搜索";
export const KEY_HINT_TO_CLOSE_ID = "keyHint.toClose";
export const KEY_HINT_TO_CLOSE = " 关闭";

/** 🔴 取快捷键提示的读屏文案（纯函数版，便于单测；组件里走 `useT()`）。 */
export function keyHint(
  part: "press" | "and" | "toSearch" | "toClose",
  t: TFunc = IDENTITY_T
): string {
  switch (part) {
    case "press":
      return t(KEY_HINT_PRESS_ID, KEY_HINT_PRESS);
    case "and":
      return t(KEY_HINT_AND_ID, KEY_HINT_AND);
    case "toSearch":
      return t(KEY_HINT_TO_SEARCH_ID, KEY_HINT_TO_SEARCH);
    default:
      return t(KEY_HINT_TO_CLOSE_ID, KEY_HINT_TO_CLOSE);
  }
}

export default function (props: { type: "search" | "esc" }) {
  const t = useT();
  const [keyString, setKeyString] = useState("Ctrl");
  useEffect(() => {
    if (isMac()) {
      setKeyString("⌘");
    }
  }, [])
  if (props.type == "search") {
    return (
      <div className="flex items-center">
        <span
          style={{ opacity: 1, height: 24 }}
          className="hidden sm:flex items-center  text-gray-500 text-sm leading-5 py-0.5 px-1.5 border border-gray-300 rounded-md dark:text-dark dark:border-dark"
        >
          <span className="sr-only">{keyHint("press", t)}</span>
          <kbd className="font-sans ">
            <abbr className="no-underline ">{keyString}</abbr>
          </kbd>
          <span className="mx-1">+</span>
          <span className="sr-only">{keyHint("and", t)}</span>
          <kbd className="font-sans ">K</kbd>
          <span className="sr-only">{keyHint("toSearch", t)}</span>
        </span>
      </div>
    );
  } else {
    return (
      <div className="flex items-center select-none ml-2">
        <span
          style={{ opacity: 1, height: 24, lineHeight: "17.73px" }}
          className="hidden sm:block text-gray-500 text-sm leading-5 py-0.5 px-1.5 border border-gray-300 rounded-md dark:text-dark dark:border-dark"
        >
          <span className="sr-only">{keyHint("press", t)}</span>
          <kbd className="font-sans">esc</kbd>
          <span className="sr-only">{keyHint("toClose", t)}</span>
        </span>
      </div>
    );
  }
}
