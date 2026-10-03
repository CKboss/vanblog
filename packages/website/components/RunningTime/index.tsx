import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";

import useT from "../../hooks/useT";
import { IDENTITY_T, type TFunc } from "../../utils/i18n";

/**
 * 🔴 期 12 第二批：过 i18n 接缝。
 *
 * **站长裁定（2026-10-03）**：`接受1days` ⇒ 英文**不做单复数**（`1 days` 照发），
 * 也**不引入 ICU**（本仓库不装 `intl-messageformat`，接缝层刻意只实现 `{name}` 插值）。
 * 👉 于是这一族用**一条整句模板 + 四个占位符**，而不是一段段拼：
 * 🔴 拼接式文案（`${days}` + `天` + `${hours}` + `小时` …）在英文里语序与分隔符都不同
 * （`452 days, 3 hours, 12 minutes and 5 seconds`），**只翻单位词永远拼不对**
 * （与 `PageNav` 那族「跳转 {input} 页」同一个教训）。
 */
export const RUNNING_TIME_PREFIX_ID = "runningTime.prefix";
export const RUNNING_TIME_PREFIX = "本站居然运行了";
export const RUNNING_TIME_DURATION_ID = "runningTime.duration";
export const RUNNING_TIME_DURATION = "{days}天{hours}小时{mins}分{secs}秒";

/** 🔴 取前缀文案（渲染期调用）。常量保留当默认值 —— 规矩见手册 §7.205 A。 */
export function runningTimePrefix(t: TFunc = IDENTITY_T): string {
  return t(RUNNING_TIME_PREFIX_ID, RUNNING_TIME_PREFIX);
}

/**
 * 把「建站时间 → 现在」格式化成 `N天N小时N分N秒`（英文按词典里的整句模板）。
 *
 * `since` 解析不出来（后台没填、填错格式）时返回 **null** —— 调用方整行不渲染。
 * ⚠️ 以前没有这个守卫：`dayjs("")` 是 Invalid Date，diff 全是 NaN，
 * 页脚会一直显示「本站居然运行了NaN天NaN小时NaN分NaN秒」，
 * 而且每秒刷新一次 —— 典型的 Invalid Date 静默流到 UI。
 *
 * 🔴 尾参 `t: TFunc = IDENTITY_T`（**注入式**，不是 hook）：本函数是纯函数，
 * 会被组件（渲染期，有语种）与单测/构建期（没有语种）同时调用 ⇒ 默认恒等翻译器
 * 保证"不传 t 时输出与改造前**逐字节相同**"。
 */
export function formatRunningTime(
  since: string,
  now: dayjs.Dayjs = dayjs(),
  t: TFunc = IDENTITY_T
): string | null {
  const start = dayjs(since);
  if (!start.isValid()) {
    return null;
  }
  const days = now.diff(start, "days");
  const hours = now.diff(start, "hours") - days * 24;
  const mins = now.diff(start, "minutes") - days * 24 * 60 - hours * 60;
  const secs =
    now.diff(start, "seconds") -
    days * 24 * 60 * 60 -
    hours * 60 * 60 -
    mins * 60;
  return t(RUNNING_TIME_DURATION_ID, RUNNING_TIME_DURATION, {
    days,
    hours,
    mins,
    secs,
  });
}

/** 建站年份（Footer 的 © 行用）；无效日期返回 null 而不是 NaN。 */
export function sinceYear(since: string): number | null {
  const parsed = dayjs(since);
  return parsed.isValid() ? parsed.year() : null;
}

export default function (props: { since: string }) {
  // 🔴 `useT()` 必须在**所有 early return 之前**（rules of hooks：下面那个 `if (!valid) return null`
  //    在它之后，把 hook 放到 return 之后就会"有时调有时不调"⇒ React 直接报错）。
  const t = useT();
  // ⚠️ 这个 state 原来叫 `t` —— 与 i18n 的 `t` **同名**（那个存的是"已格式化的时长字符串"）。
  //    🔴 改名成 `elapsed`：同名会让"把翻译器当字符串用/把字符串当翻译器调"这类错误
  //    在类型检查里看起来完全合法（`t(...)` 与 `t ?? ""` 都能编译过一部分），是最难查的一类影子变量。
  const [elapsed, setElapsed] = useState<string | null>(null);
  // since 无效时整个组件不渲染（以前会显示一行每秒刷新的 NaN）
  const valid = useMemo(() => dayjs(props.since).isValid(), [props.since]);
  useEffect(() => {
    if (!valid) {
      return undefined;
    }
    const tick = () => {
      setElapsed(formatRunningTime(props.since, dayjs(), t));
    };
    tick(); // 首帧就有值（以前要空着等第一个 1s tick）
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
    // ⚠️ 依赖是 props.since：以前没有依赖数组，每秒 setT 触发重渲染，
    // 每次重渲染都 clearInterval + setInterval 重建定时器（白费的抖动）
    // 🔴 依赖里**必须有 `t`**：`useT()` 返回的是 `useCallback([locale])`（同一语种内引用稳定），
    //    所以切语种时 `t` 会变 ⇒ effect 重跑 ⇒ 时长立刻按新语种重算。
    //    ⚠️ 不放进依赖也不会无限循环（正因为它是稳定的），但那样**切换语种后这一行会一直停在旧语种**
    //    直到下一秒 tick —— 属于"看起来接了、其实只在部分路径上生效"。
  }, [valid, props.since, t]);
  if (!valid) {
    return null;
  }
  return (
    <p>
      <span>{runningTimePrefix(t)}</span>
      <span>{elapsed ?? ""}</span>
    </p>
  );
}
