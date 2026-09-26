/**
 * Shared tokenizers for article / draft tag Select fields (Ant Design mode="tags").
 *
 * Separators are English/Chinese commas, semicolons, and newlines — the usual
 * delimiters when pasting a list from notes or AI output (#489).
 *
 * Spaces are intentionally NOT separators so multi-word tags such as
 * "machine learning" stay a single tag. Trim around each token instead.
 */

const TAG_TOKEN_SEPARATORS = Object.freeze([',', '，', ';', '；', '\n', '\r']);

/**
 * 🔴 多语言：**注入式翻译器**（与 accessPassword.js / coverBackfill.js / batch.ts / revisionCore.js 同一套模式）。
 * 服务层是纯逻辑（模块加载期拿不到 umi 运行时）⇒ 翻译器由**组件在渲染期注入**。
 * 🔴 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前**逐字相同**（既有消费方与黄金样本一个字都不用改）。
 * 🔴 SCREAMING_CASE 常量保留为**同一份文案的 identity 视图**（中文只有一份，在 defaultMessage 里）；
 * 🔴 而且**函数体内不许再引用这些常量**（那就等于"注入了 t 也不生效"，localePackParity 有一条判据专门盯这件事）。
 */
function interpolate(template, values) {
  if (!values) return String(template);
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
  );
}
const IDENTITY_T = (id, defaultMessage, values) => interpolate(defaultMessage, values);

function tagFieldPlaceholder(t = IDENTITY_T) {
  return t('tagTokens.placeholder', '选择、输入或粘贴多个标签（逗号 / 分号 / 换行分隔）');
}
const TAG_FIELD_PLACEHOLDER = tagFieldPlaceholder();

function tagFieldTooltip(t = IDENTITY_T) {
  return t(
    'tagTokens.tooltip',
    '可一次粘贴多个标签。用英文/中文逗号、分号或换行分隔；空格不会拆开，以便保留「machine learning」这类多词标签。',
  );
}
const TAG_FIELD_TOOLTIP = tagFieldTooltip();

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TAG_TOKEN_SPLIT_PATTERN = new RegExp(
  TAG_TOKEN_SEPARATORS.map(escapeRegExp).join('|'),
);

/**
 * Split a pasted or typed tag list into trimmed, non-empty tags.
 * Consecutive separators and surrounding whitespace are dropped.
 *
 * @param {unknown} input
 * @returns {string[]}
 */
function splitTagInput(input) {
  if (input == null) {
    return [];
  }
  const text = String(input);
  if (!text.trim()) {
    return [];
  }
  return text
    .split(TAG_TOKEN_SPLIT_PATTERN)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

module.exports = {
  IDENTITY_T,
  tagFieldPlaceholder,
  tagFieldTooltip,
  TAG_TOKEN_SEPARATORS,
  TAG_FIELD_PLACEHOLDER,
  TAG_FIELD_TOOLTIP,
  splitTagInput,
};
