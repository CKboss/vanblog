/**
 * 编辑器预览用的 sanitize schema。
 *
 * ⚠️ **canonical 版本在 `packages/website/utils/markdownSanitize.ts`**，两边必须一致：
 * 编辑器预览和前台文章页走的是同一条 bytemd 流水线
 * （remark-parse → remark-rehype(allowDangerousHtml) → rehype-raw → rehype-sanitize → 插件 rehype → stringify），
 * schema 不一致就会出现「预览里看不到、发布后有」或反过来的情况。
 *
 * 以前这里是编辑器自己手写的一份，比前台少了：
 * - `button` 标签 + `type` / `disabled` 属性 → 代码块的**复制按钮**在预览里被剥掉
 * - `dataLine` → 代码块**行号**（`<span class="code-line" data-line="1">`）在预览里失效
 * - `title` / `ariaLabel` / `ariaHidden` → tooltip 和无障碍属性丢失
 * - 事件处理属性过滤（`on*`）→ 前台有这道兜底，编辑器没有
 * `packages/admin/tests/unit/markdownConsistency.test.js` 会把两份文件的白名单对齐钉死。
 */
// mark = `==高亮==`；dl/dt/dd = 定义列表（remark-definition-list）
export const MARKDOWN_EXTRA_TAG_NAMES = [
  'center',
  'iframe',
  'section',
  'button',
  'u',
  'font',
  'mark',
  'dl',
  'dt',
  'dd',
] as const;

export const MARKDOWN_FORBIDDEN_TAG_NAMES = ['script'] as const;

const FORBIDDEN_TAG_NAME_SET = new Set<string>(MARKDOWN_FORBIDDEN_TAG_NAMES as readonly string[]);

/** `open`（details 的展开属性）只有 4 个字符，不能被当成事件处理器。 */
const EVENT_HANDLER_ATTR = /^on[a-z]{3,}$/i;

function withoutEventHandlers(attrs: unknown[] | undefined): unknown[] {
  return (attrs || []).filter((attr) => {
    const name = Array.isArray(attr) ? attr[0] : attr;
    return typeof name !== 'string' || !EVENT_HANDLER_ATTR.test(name);
  });
}

export const MARKDOWN_GLOBAL_ATTRIBUTES = [
  'ariaLabel',
  'ariaHidden',
  'title',
  // 代码块行号：<span class="code-line" data-line="1">
  'dataLine',
  'style',
  'src',
  'scrolling',
  'border',
  'frameborder',
  'framespacing',
  'allowfullscreen',
] as const;

export const sanitizeMarkdownSchema = (schema: any) => {
  schema.protocols.src.push('data');
  for (const tag of MARKDOWN_EXTRA_TAG_NAMES) {
    if (!schema.tagNames.includes(tag)) {
      schema.tagNames.push(tag);
    }
  }
  schema.tagNames = schema.tagNames.filter((tag: string) => !FORBIDDEN_TAG_NAME_SET.has(tag));
  schema.strip = Array.from(
    new Set([...(schema.strip || []), ...MARKDOWN_FORBIDDEN_TAG_NAMES]),
  );
  // 代码复制按钮是原生 <button type="button">
  if (!schema.tagNames.includes('button')) {
    schema.tagNames.push('button');
  }
  schema.attributes.button = Array.from(
    new Set([...(schema.attributes.button || []), 'type', 'disabled']),
  );
  schema.attributes.font = Array.from(
    new Set([...(schema.attributes.font || []), 'color', 'size', 'face']),
  );
  schema.attributes['*'] = Array.from(
    new Set([...(schema.attributes['*'] || []), ...MARKDOWN_GLOBAL_ATTRIBUTES]),
  );
  // remark-rehype 已经给脚注 id 加过前缀，再加一次会把 href 弄断
  schema.clobberPrefix = '';
  for (const key of Object.keys(schema.attributes)) {
    schema.attributes[key] = withoutEventHandlers(schema.attributes[key]);
  }
  return schema;
};
