import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";

/**
 * 把「建站时间 → 现在」格式化成 `N天N小时N分N秒`。
 *
 * `since` 解析不出来（后台没填、填错格式）时返回 **null** —— 调用方整行不渲染。
 * ⚠️ 以前没有这个守卫：`dayjs("")` 是 Invalid Date，diff 全是 NaN，
 * 页脚会一直显示「本站居然运行了NaN天NaN小时NaN分NaN秒」，
 * 而且每秒刷新一次 —— 典型的 Invalid Date 静默流到 UI。
 */
export function formatRunningTime(
  since: string,
  now: dayjs.Dayjs = dayjs()
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
  return `${days}天${hours}小时${mins}分${secs}秒`;
}

/** 建站年份（Footer 的 © 行用）；无效日期返回 null 而不是 NaN。 */
export function sinceYear(since: string): number | null {
  const parsed = dayjs(since);
  return parsed.isValid() ? parsed.year() : null;
}

export default function (props: { since: string }) {
  const [t, setT] = useState<string | null>(null);
  // since 无效时整个组件不渲染（以前会显示一行每秒刷新的 NaN）
  const valid = useMemo(() => dayjs(props.since).isValid(), [props.since]);
  useEffect(() => {
    if (!valid) {
      return undefined;
    }
    const tick = () => {
      setT(formatRunningTime(props.since));
    };
    tick(); // 首帧就有值（以前要空着等第一个 1s tick）
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
    // ⚠️ 依赖是 props.since：以前没有依赖数组，每秒 setT 触发重渲染，
    // 每次重渲染都 clearInterval + setInterval 重建定时器（白费的抖动）
  }, [valid, props.since]);
  if (!valid) {
    return null;
  }
  return (
    <p>
      <span>本站居然运行了</span>
      <span>{t ?? ""}</span>
    </p>
  );
}
