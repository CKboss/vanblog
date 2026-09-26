/**
 * Relative time ("N秒前") from UTC instants so visitor TZ vs site TZ
 * cannot render a negative duration for a past event (#369).
 */

const NAIVE_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

function withSeconds(time) {
  return time.length === 5 ? `${time}:00` : time;
}

export function parseInstantMs(value) {
  if (value == null || value === '') {
    return Number.NaN;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
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

export function secondsAgo(value, now = Date.now()) {
  const then = parseInstantMs(value);
  if (Number.isNaN(then)) {
    return Number.NaN;
  }
  return Math.max(0, Math.floor((now - then) / 1000));
}

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）⇒ 不传 t 时输出与改造前逐字相同。
 * ⚠️ 英文那几条是 `{n, plural, one {# second} other {# seconds}} ago` 这种 ICU 复数形状；
 *    汉语没有复数变化 ⇒ zh-CN / zh-TW 保持 `{n}秒前` 的形状。
 */
const IDENTITY_T = (id, defaultMessage, values) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);

export { IDENTITY_T };

export function formatTimeAgo(value, now = Date.now(), t = IDENTITY_T) {
  if (value == null || value === '') {
    return '-';
  }
  const seconds = secondsAgo(value, now);
  if (Number.isNaN(seconds)) {
    return '-';
  }
  if (seconds <= 0) {
    return t('time.justNow', '刚刚');
  }
  if (seconds < 60) {
    return t('time.secondsAgo', '{n}秒前', { n: seconds });
  }
  if (seconds < 3600) {
    return t('time.minutesAgo', '{n}分钟前', { n: Math.floor(seconds / 60) });
  }
  if (seconds < 86400) {
    return t('time.hoursAgo', '{n}小时前', { n: Math.floor(seconds / 3600) });
  }
  return t('time.daysAgo', '{n}天前', { n: Math.floor(seconds / 86400) });
}
