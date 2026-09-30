import { IDENTITY_T, type TFunc } from "./i18n";

/**
 * Relative time ("N秒前") from UTC instants so visitor TZ vs site TZ
 * cannot render a negative duration for a past event (#369).
 */

const NAIVE_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

function withSeconds(time: string): string {
  return time.length === 5 ? `${time}:00` : time;
}

export function parseInstantMs(value: unknown): number {
  if (value == null || value === "") {
    return Number.NaN;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  const raw = String(value).trim();
  if (!raw) {
    return Number.NaN;
  }
  const naive = raw.match(NAIVE_DATE_TIME);
  if (naive) {
    return Date.parse(`${naive[1]}T${withSeconds(naive[2])}Z`);
  }
  return Date.parse(raw);
}

export function secondsAgo(value: unknown, now: number = Date.now()): number {
  const then = parseInstantMs(value);
  if (Number.isNaN(then)) {
    return Number.NaN;
  }
  return Math.max(0, Math.floor((now - then) / 1000));
}

export function daysAgo(value: unknown, now: number = Date.now()): number {
  const then = parseInstantMs(value);
  if (Number.isNaN(then)) {
    return 0;
  }
  return Math.max(0, Math.floor((now - then) / 86400000));
}

/**
 * 🔴 期 10 第二批：接上多语言**接缝** —— 尾参 `t` 默认 `IDENTITY_T`（原样返回中文默认值）
 * ⇒ 既有调用点与测试（含与后台 `relativeTime.js` 的**对等断言**）都不用改、行为逐字节相同。
 * ⚠️ 这一族**语序会随语言变**（`3 小时前` vs `3 hours ago`）⇒ 整句进词典、不是只翻单位词；
 * 而且英文需要复数。⚠️ 与后台 `services/van-blog/relativeTime.js` 是**一对** ⇒
 * 🔴 两边的 key 命名要对齐（后台那批用的是 `relativeTime.*`），便于将来复用同一份译文。
 */
export function formatTimeAgo(
  value: unknown,
  now: number = Date.now(),
  t: TFunc = IDENTITY_T,
): string {
  if (value == null || value === "") {
    return "-";
  }
  const seconds = secondsAgo(value, now);
  if (Number.isNaN(seconds)) {
    return "-";
  }
  if (seconds <= 0) {
    return t("relativeTime.justNow", "刚刚");
  }
  if (seconds < 60) {
    return t("relativeTime.seconds", "{n}秒前", { n: seconds });
  }
  if (seconds < 3600) {
    return t("relativeTime.minutes", "{n}分钟前", { n: Math.floor(seconds / 60) });
  }
  if (seconds < 86400) {
    return t("relativeTime.hours", "{n}小时前", { n: Math.floor(seconds / 3600) });
  }
  return t("relativeTime.days", "{n}天前", { n: Math.floor(seconds / 86400) });
}
