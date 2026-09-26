/**
 * Resolve a custom article pathname from Markdown Front Matter.
 *
 * Create-article accepts an optional `pathname` string. Import reuses that:
 * only string/number values are kept, whitespace is trimmed, and nothing else
 * is rewritten. The server validates the value (single segment, not a bare
 * number, not taken) and, when it is empty, derives a pinyin slug from the
 * title instead of falling back to `/post/<id>`.
 *
 * Preference:
 * 1. `pathname` — VanBlog's own field (re-import / explicit override)
 * 2. `slug` — Hugo `permalinks.post = "/post/:slug"` (#487)
 * 3. `url` — only a single segment or `/post/<slug>` (absolute `/post/<slug>`
 *    URLs included). Not `:year/:month/:title` templates.
 * 4. `abbrlink` — hexo-abbrlink / hexo-addlink, so archives/cb933e30.html
 *    can map to /post/cb933e30 (#383)
 *
 * Other hexo keys such as `permalink` are not recognized here; they are not
 * used by the existing importer.
 */

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

/** 🔴 "导出对象字面量"这一类的标准接法（§7.156 A / §7.157 B）：函数版 + identity 视图。 */
function pathnameField(t = IDENTITY_T) {
  return Object.freeze({
    name: 'pathname',
    label: t('pathname.label', '自定义路径名'),
    placeholder: t('pathname.placeholder', '例如 Hugo 的 slug；留空则按标题生成拼音，而不是数字 id'),
    tooltip: t(
      'pathname.tooltip',
      '发布后地址为 /post/[自定义路径名]，对应 Hugo 的 permalinks.post = "/post/:slug"。从 Hugo 迁移时把旧 slug 填到这里，可保持旧 URL、不影响 SEO。留空则按标题自动生成汉语拼音路径（重名依次追加 -2、-3，最后兜底 -文章id）；标题里没有可用字符时才退回数字 id。已填的别名不会随标题修改而变动，数字 id 地址始终可用；没有站点级固定链接模板。',
    ),
  });
}
const PATHNAME_FIELD = pathnameField();

function asPathname(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  return text || undefined;
}

/**
 * Accept a bare slug, `/post/<slug>`, or `https://host/post/<slug>`.
 * Nested templates such as `/post/:year/:month/:title` are ignored.
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
function extractPostSlug(value) {
  const text = asPathname(value);
  if (!text) {
    return undefined;
  }

  let raw = text;
  if (/^https?:\/\//i.test(raw)) {
    try {
      raw = new URL(raw).pathname;
    } catch {
      return undefined;
    }
  }

  raw = raw.split('?')[0].split('#')[0];
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 1) {
    return decodeSlugPart(parts[0]);
  }
  if (parts.length === 2 && parts[0] === 'post') {
    return decodeSlugPart(parts[1]);
  }
  return undefined;
}

function decodeSlugPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * @param {unknown} attributes Front Matter object from `front-matter`
 * @returns {string|undefined}
 */
function pathnameFromFrontMatter(attributes) {
  if (!attributes || typeof attributes !== 'object') {
    return undefined;
  }
  return (
    extractPostSlug(attributes.pathname) ||
    extractPostSlug(attributes.slug) ||
    extractPostSlug(attributes.url) ||
    extractPostSlug(attributes.abbrlink)
  );
}

module.exports = {
  IDENTITY_T,
  pathnameField,
  PATHNAME_FIELD,
  extractPostSlug,
  pathnameFromFrontMatter,
};
