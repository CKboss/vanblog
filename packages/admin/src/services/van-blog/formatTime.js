/**
 * 后台列表/抽屉里通用的时间与体积格式化（回收站、历史版本、定时发布共用）。
 *
 * ⚠️ 刻意用 CommonJS（与 requestError.js、InitPage/restoreCore.js 同一模式）：
 * 后台代码由 babel 编译（CJS 可被 ESM import），而单元测试跑在裸 node 上，
 * require() 只认 CJS —— 写成 ESM 就没法直接测行为了。
 *
 * 原则：坏值（null / undefined / NaN / 非法日期串）一律渲染成 '-' 或 t('common.unknownSize', '未知大小')，
 * 绝不让 NaN / Invalid Date 流到界面上。
 */

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 把任意可解析的时间值格式化成 'YYYY-MM-DD HH:mm:ss'（浏览器本地时区）。
 * 解析不了 / 没值 → '-'。
 */
function formatDateTime(value) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return '-';
  }
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** 字节数 → '12.3 KB'；非有限数或 <=0 → t('common.unknownSize', '未知大小')（与 restoreCore.describeFileSize 同风格）。 */
/**
 * 🔴 多语言：**注入式翻译器**（与 accessPassword.js / coverBackfill.js / exportFormats.js 同一套模式）。
 * 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前**逐字相同**（既有消费方与黄金样本一个字都不用改）。
 * 🔴 函数体内不许引用 identity 常量（localePackParity 有一条判据专门盯这件事）。
 */
function interpolate(template, values) {
  if (!values) return String(template);
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}
const IDENTITY_T = (id, defaultMessage, values) => interpolate(defaultMessage, values);

function formatBytes(bytes, t = IDENTITY_T) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) {
    return t('common.unknownSize', '未知大小');
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

module.exports = { formatDateTime, formatBytes, pad2, IDENTITY_T };
