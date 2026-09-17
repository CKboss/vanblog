/**
 * 定时发布（publishAt）的纯逻辑：判定、保存值归一化、文案。
 *
 * ⚠️ 刻意 CommonJS（同 requestError.js / InitPage/restoreCore.js 模式），
 * 裸 node --test 可直接 require 测行为；组件（UpdateModal / columns / Editor）只接线。
 *
 * 契约：文章多一个可空的 `publishAt`（ISO 字符串），走现有的文章保存接口
 * （PUT /api/admin/article/:id）；列表 payload 会带 publishAt。
 * **以 publishAt 为准自行推导「定时待发布」**：publishAt 存在且晚于当前时间。
 * 到了时刻由服务端 cron 在一分钟内自动发布；在那之前文章在所有前台页面不可见。
 *
 * 防御性：坏值（空串 / null / 非法日期串 / NaN）一律按「没有定时」处理，
 * 绝不让 Invalid Date / NaN 流到界面；保存时清空必须真的发 null 给服务端
 * （undefined 会被 JSON 序列化丢掉 → 服务端永远清不掉定时）。
 */
const { formatDateTime } = require('./formatTime');

const SCHEDULED_TAG_TEXT = '定时待发布';

const PUBLISH_AT_PLACEHOLDER = '留空 = 不定时（立即发布）';

const PUBLISH_AT_TOOLTIP =
  '设置一个未来时间后，文章在到点之前对所有前台页面不可见（列表、搜索、RSS、sitemap 都不出现），' +
  '到点后由服务端定时任务在一分钟内自动发布。清空此字段 = 取消定时（立即发布/保持已发布）。';

const PUBLISH_AT_HELP =
  '定时发布：到点之前这篇文章在前台完全不可见，服务端会在设定时刻起一分钟内自动把它发布出来。';

/**
 * 解析 publishAt 为毫秒时间戳；解析不了 → NaN。
 * 兼容三种来源：ISO 串（服务端存的）、'YYYY-MM-DD HH:mm:ss'（pro-form
 * dateFormatter="string" 提交的本地 naive 串）、Date/moment 对象、数字时间戳。
 * naive 串（无时区后缀）按**本地时间**解析 —— 用户在 DatePicker 里选的就是本地时刻，
 * 按 UTC 解析会整体偏移一个时区。
 */
function parsePublishAt(value) {
  if (value === null || value === undefined || value === '') {
    return Number.NaN;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : Number.NaN;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  // moment 或任何带 valueOf 的时间对象
  if (typeof value === 'object' && typeof value.valueOf === 'function') {
    const ms = value.valueOf();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : Number.NaN;
  }
  const raw = String(value).trim();
  if (!raw) {
    return Number.NaN;
  }
  if (/^\d{4}-\d{2}-\d{2}[ ]\d{2}:\d{2}/.test(raw)) {
    // 'YYYY-MM-DD HH:mm(:ss)' → 本地时间
    return new Date(raw.replace(' ', 'T')).getTime();
  }
  return Date.parse(raw);
}

/** 「定时待发布」判定：publishAt 有效且严格晚于 now。坏值/过去时间都不算。 */
function isScheduled(publishAt, now = Date.now()) {
  const ms = parsePublishAt(publishAt);
  if (Number.isNaN(ms)) {
    return false;
  }
  return ms > now;
}

/** 用户选了一个已经过去的时间：不算「定时待发布」，但保存前要警告（见 UpdateModal）。 */
function isPastSchedule(publishAt, now = Date.now()) {
  const ms = parsePublishAt(publishAt);
  if (Number.isNaN(ms)) {
    return false;
  }
  return ms <= now;
}

/**
 * 保存前归一化：moment/Date/字符串 → ISO 串（UTC）；空/坏值 → **null**（必须显式发
 * null 才能把服务端已有的定时清掉；undefined 会在 JSON 序列化时整个键消失）。
 */
function normalizePublishAtForSave(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  // moment：优先用它自己的 ISO 输出（toISOString 存在且 isValid 时才可信）
  if (typeof value === 'object' && typeof value.toISOString === 'function') {
    if (typeof value.isValid === 'function' && !value.isValid()) {
      return null;
    }
    try {
      return value.toISOString();
    } catch (err) {
      return null;
    }
  }
  const ms = parsePublishAt(value);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

/** 列表/编辑器里的定时徽标文案：'定时待发布 · 2026-09-20 09:00:00'；没定时 → null。 */
function describeScheduledTag(publishAt, now = Date.now()) {
  if (!isScheduled(publishAt, now)) {
    return null;
  }
  return `${SCHEDULED_TAG_TEXT} · ${formatDateTime(publishAt)}`;
}

/** 选了过去时间的警告文案（Modal.confirm 的 content；确认后才继续保存）。 */
function pastScheduleWarningText(publishAt, now = Date.now()) {
  return (
    `你选择的定时发布时间「${formatDateTime(publishAt)}」早于当前时间` +
    `（${formatDateTime(new Date(now))}）。它不会处于「定时待发布」状态：` +
    '保存后服务端会认为它已到期，未发布的文章会在一分钟内直接发布出去。仍要使用这个时间吗？'
  );
}

const PAST_SCHEDULE_WARNING_TITLE = '定时时间早于当前时间';

module.exports = {
  SCHEDULED_TAG_TEXT,
  PUBLISH_AT_PLACEHOLDER,
  PUBLISH_AT_TOOLTIP,
  PUBLISH_AT_HELP,
  PAST_SCHEDULE_WARNING_TITLE,
  parsePublishAt,
  isScheduled,
  isPastSchedule,
  normalizePublishAtForSave,
  describeScheduledTag,
  pastScheduleWarningText,
};
