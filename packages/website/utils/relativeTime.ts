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

/**
 * 🔴 期 10 第十批：**合并两份 `timeAgo` 实现**（站长裁定：`超过 30 天显示日期`）。
 *
 * ## 之前的问题
 * `components/Comment/index.tsx` 里有一个**本地的** `timeAgo()`，与本文件的 `formatTimeAgo()` 是
 * **同一件事的两份实现**，而且已经开始漂了：
 * - 措辞：本地版 `{n} 分钟前`（**有空格**）vs 这里 `{n}分钟前`（无空格，也是后台的口径，
 *   `__tests__/relativeTime.spec.ts` 里有**两边的对等断言**钉着 `45秒前`）；
 * - 行为：本地版超过 30 天**改用 `toLocaleDateString()`**，这里一直是 `{n}天前`；
 * - 兜底：本地版解析失败返回 `""`，这里返回 `"-"`。
 * 🔴 "两份实现会漂"是本仓库的老问题（§7.42 那条教训），而 i18n 让它更糟：
 * 两份实现 ⇒ **两套词典 key**（`comment.time*` 与 `relativeTime.*`），译文各写一遍、迟早不一致。
 *
 * ## 站长裁定与落实
 * 裁定：**超过 30 天显示日期**（不是"N 天前"）⇒ 这个函数就是裁定后的**唯一**实现，
 * 评论区改成调它，本地那份删掉，`comment.time*` 那 4 个 key 从两份词典里**移除**（否则就是孤儿 key）。
 * 🔴 **刻意保留的两个差异**（用参数表达，不是用第二份实现表达）：
 * ① `invalidText`：解析不出来时返回什么 —— 默认 `"-"`（与 `formatTimeAgo` 一致），
 *    评论区传 `""`（保持它今天的行为：坏日期就什么都不显示，而不是多一个 `-`）；
 * ② 🔴 **日期那一段跟浏览器 locale 走**（`toLocaleDateString()` 不传 locale）——
 *    这是站长 2026-10-01 的另一条裁定（"时间跟着浏览器的 locale 走"），
 *    所以它**不过接缝**：那是**平台的格式化结果**，不是我们写的文案。
 * ⚠️ 合并带来一处**刻意的界面文案变化**（如实报）：评论时间从 `30 分钟前` 变成 `30分钟前`
 *    （少一个空格）—— 因为统一到"无空格"这个口径（与后台一致、且有对等断言钉着）。
 *    🔴 这类"看得见的变化"必须单独点明：它不会让任何测试变红，只有人读 CHANGELOG 才能发现。
 */
export function formatTimeAgoOrDate(
  value: unknown,
  now: number = Date.now(),
  t: TFunc = IDENTITY_T,
  invalidText = "-",
): string {
  if (value == null || value === "") {
    return invalidText;
  }
  const then = parseInstantMs(value);
  if (Number.isNaN(then)) {
    return invalidText;
  }
  const seconds = Math.floor((now - then) / 1000);
  // 🔴 30 天以上：改用**日期**（站长裁定），并且跟浏览器 locale 走（另一条裁定）⇒ 不过接缝
  if (seconds >= 30 * 86400) {
    return new Date(then).toLocaleDateString();
  }
  // 30 天以内：与 `formatTimeAgo` **完全同一套 key 与措辞**（一份实现、一套译文）
  return formatTimeAgo(value, now, t);
}
