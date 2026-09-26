'use strict';

/**
 * ByteMD `mode="auto"` switches to tab layout when the editor container is
 * narrower than 800px. In that mode the left formatting icons are replaced
 * by Write / Preview tabs, which is why phones only keep a handful of
 * buttons (#504). This plugin does not rewrite the editor: it keeps tab
 * mode and mounts a curated tool row next to those tabs.
 */
const BYTEMD_SPLIT_MIN_WIDTH = 800;
const MOBILE_TOOLBAR_CLASS = 'vanblog-mobile-toolbar';

// 🔴 多语言（2026-09-26 期 6 第一批）：这 11 个标题以前是**手抄的中文**，
//    实测与上游 `bytemd/locales/zh_Hans.json` 的值**逐字相同**（headingText=标题、bold=粗体、italic=斜体、
//    quote=引用、link=链接、image=图片、ul=无序列表、code=代码、h1/h2/h3=一级/二级/三级标题）。
//    ⇒ 🔴 不再自己维护一份：直接读 `pickEditorLocale()` 合成出来的那个对象（`Editor/index.tsx` 传进来），
//    繁中/英文由**上游**给（实测 zh_Hant 用 標題/粗體/連結/圖像/一級標題，是真正的地区用词）。
//    ⚠️ 兜底 `|| id`／`|| ('h' + level)` 只是"上游哪天删了 key"时的可见退化（不会静默空白）；
//    🔴 `editorLocales.test.js` 里有一条断言钉住"三种语言的 locale 都必须含这 11 个 key"。
const MOBILE_TOOLBAR_ACTION_KEYS = [
  { id: 'heading', localeKey: 'headingText' },
  { id: 'bold', localeKey: 'bold' },
  { id: 'italic', localeKey: 'italic' },
  { id: 'quote', localeKey: 'quote' },
  { id: 'link', localeKey: 'link' },
  { id: 'image', localeKey: 'image' },
  { id: 'ul', localeKey: 'ul' },
  { id: 'code', localeKey: 'code' },
];

const HEADING_LEVELS = [
  { level: 1, localeKey: 'h1' },
  { level: 2, localeKey: 'h2' },
  { level: 3, localeKey: 'h3' },
];

function buildMobileToolbarActions(locale) {
  const L = locale || {};
  return MOBILE_TOOLBAR_ACTION_KEYS.map((a) => ({ id: a.id, title: L[a.localeKey] || a.id }));
}

function buildHeadingLevels(locale) {
  const L = locale || {};
  return HEADING_LEVELS.map((h) => ({ level: h.level, title: L[h.localeKey] || `h${h.level}` }));
}

/**
 * 🔴 identity 视图：用**上游 zh_Hans** 合成（不是手抄一份中文）⇒ 既有测试
 * （`mobileToolbar.test.js` 里 `title === '粗体'` 那些断言）一个字都不用改，
 * 而这个文件里也**一条中文字面量都不剩**。
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BYTEMD_ZH_HANS = require('bytemd/locales/zh_Hans.json');
const MOBILE_TOOLBAR_ACTIONS = buildMobileToolbarActions(BYTEMD_ZH_HANS);

const ICONS = {
  bold: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M4 2.5h4.6c1.9 0 3.2 1.1 3.2 2.7 0 1-.6 1.9-1.5 2.3 1.2.4 2 1.4 2 2.6 0 1.8-1.5 3-3.5 3H4V2.5zm2.1 4.4h2.2c.9 0 1.4-.5 1.4-1.2S9.2 4.6 8.3 4.6H6.1v2.3zm0 4.6h2.6c1 0 1.6-.5 1.6-1.3s-.6-1.3-1.6-1.3H6.1V11.5z"/></svg>',
  italic:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7.2 2.5h5.3v1.8H10.4l-2.2 7.4h1.8v1.8H4.7v-1.8h1.9l2.2-7.4H7.2V2.5z"/></svg>',
  quote:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3 4.5h4.2v5.2c0 1.8-1.3 3-3.1 3.3l-.5-1.6c.8-.2 1.4-.8 1.4-1.6H3V4.5zm6.3 0H13.5v5.2c0 1.8-1.3 3-3.1 3.3l-.5-1.6c.8-.2 1.4-.8 1.4-1.6H9.3V4.5z"/></svg>',
  link: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6.3 9.7a.75.75 0 0 1 0-1.1l2.4-2.4a2.2 2.2 0 1 1 3.1 3.1l-1.1 1.1a.75.75 0 0 1-1.1-1.1l1.1-1.1a.7.7 0 0 0-1-1L7.4 8.6a.75.75 0 0 1-1.1 0zm3.4-3.4a.75.75 0 0 1 0 1.1L7.3 9.8a2.2 2.2 0 1 1-3.1-3.1l1.1-1.1a.75.75 0 1 1 1.1 1.1L5.3 7.8a.7.7 0 1 0 1 1l2.3-2.4a.75.75 0 0 1 1.1 0z"/></svg>',
  image:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M2.5 3.2h11a.8.8 0 0 1 .8.8v8a.8.8 0 0 1-.8.8h-11a.8.8 0 0 1-.8-.8v-8a.8.8 0 0 1 .8-.8zm1.2 1.5v6.2l2.6-2.4 1.6 1.5 2.4-2.7 2.8 3.6V4.7H3.7zm2.2 2.1a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2z"/></svg>',
  ul: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3 3.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm3 .4h7.2v1.6H6V4zm-3 3.4a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm3 .4h7.2v1.6H6V7.8zm-3 3.4a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm3 .4h7.2v1.6H6v-1.6z"/></svg>',
  code: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="m5.7 3.6 1.1 1.1-3.2 3.3 3.2 3.3-1.1 1.1L1.3 8l4.4-4.4zm4.6 0L14.7 8l-4.4 4.4-1.1-1.1 3.2-3.3-3.2-3.3 1.1-1.1z"/></svg>',
};

function isByteMDTabMode(root) {
  if (!root || typeof root.querySelector !== 'function') {
    return false;
  }
  return Boolean(root.querySelector('.bytemd-toolbar-tab'));
}

function applyToolbarAction(ctx, id, extra) {
  if (!ctx) {
    return;
  }
  const wrapText = typeof ctx.wrapText === 'function' ? ctx.wrapText.bind(ctx) : null;
  const replaceLines = typeof ctx.replaceLines === 'function' ? ctx.replaceLines.bind(ctx) : null;

  switch (id) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(extra) || 2));
      if (replaceLines) {
        replaceLines((line) => {
          const text = String(line || '')
            .trim()
            .replace(/^#*/, '')
            .trim();
          return `${'#'.repeat(level)} ${text}`;
        });
      }
      break;
    }
    case 'bold':
      if (wrapText) wrapText('**');
      break;
    case 'italic':
      if (wrapText) wrapText('*');
      break;
    case 'quote':
      if (replaceLines) replaceLines((line) => `> ${line}`);
      break;
    case 'link':
      if (wrapText) wrapText('[', '](url)');
      break;
    case 'ul':
      if (replaceLines) replaceLines((line) => `- ${line}`);
      break;
    case 'code':
      if (wrapText) wrapText('`');
      break;
    default:
      return;
  }

  if (ctx.editor && typeof ctx.editor.focus === 'function') {
    ctx.editor.focus();
  }
}

function insertUploadedImages(ctx, imgs) {
  if (!ctx || !Array.isArray(imgs) || !imgs.length || typeof ctx.appendBlock !== 'function') {
    return;
  }
  const markdown = imgs
    .map(({ url, alt, title }) => {
      const href = url || '';
      return `![${alt || ''}](${href}${title ? ` "${title}"` : ''})`;
    })
    .join('\n\n');
  const pos = ctx.appendBlock(markdown);
  if (ctx.editor && ctx.codemirror && pos && typeof ctx.editor.setSelection === 'function') {
    ctx.editor.setSelection(pos, ctx.codemirror.Pos(pos.line + imgs.length * 2 - 2));
  }
  if (ctx.editor && typeof ctx.editor.focus === 'function') {
    ctx.editor.focus();
  }
}

function pickAndUploadImages(ctx, uploadImages) {
  if (typeof document === 'undefined' || typeof uploadImages !== 'function') {
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.setAttribute('data-vanblog-mobile-upload', 'true');
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (!files.length) {
      return;
    }
    const imgs = await uploadImages(files);
    insertUploadedImages(ctx, imgs);
  });
  document.body.appendChild(input);
  input.click();
}

function createToolButton(action, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'vanblog-mobile-tool';
  button.setAttribute('data-tool', action.id);
  button.setAttribute('aria-label', action.title);
  button.title = action.title;
  button.innerHTML = ICONS[action.id] || '';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function createHeadingSelect(ctx, locale) {
  const L = locale || {};
  // 🔴 aria-label 与下拉占位项也读上游 locale（`headingText`）：这两处是**无障碍/占位**文案，
  //    漏掉的话读屏软件在英文界面下仍会念中文（"看不见的那部分文案"教训之一）
  const headingLabel = L.headingText || 'heading';
  const select = document.createElement('select');
  select.className = 'vanblog-mobile-heading';
  select.setAttribute('aria-label', headingLabel);
  select.setAttribute('data-tool', 'heading');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = headingLabel;
  select.appendChild(placeholder);
  buildHeadingLevels(locale).forEach(({ level, title }) => {
    const option = document.createElement('option');
    option.value = String(level);
    option.textContent = title;
    select.appendChild(option);
  });
  select.addEventListener('change', () => {
    if (!select.value) {
      return;
    }
    applyToolbarAction(ctx, 'heading', Number(select.value));
    select.value = '';
  });
  return select;
}

function createMobileToolbarElement(ctx, options) {
  const wrap = document.createElement('div');
  wrap.className = MOBILE_TOOLBAR_CLASS;
  wrap.setAttribute('data-vanblog-mobile-toolbar', 'true');
  const locale = (options && options.locale) || undefined;
  wrap.appendChild(createHeadingSelect(ctx, locale));
  buildMobileToolbarActions(locale)
    .filter((action) => action.id !== 'heading')
    .forEach((action) => {
    wrap.appendChild(
      createToolButton(action, () => {
        if (action.id === 'image') {
          pickAndUploadImages(ctx, options && options.uploadImages);
          return;
        }
        applyToolbarAction(ctx, action.id);
      }),
    );
    });
  return wrap;
}

function syncMobileToolbar(root, createBar) {
  if (!root || typeof root.querySelector !== 'function') {
    return { mounted: false };
  }
  const left = root.querySelector('.bytemd-toolbar-left');
  if (!left) {
    return { mounted: false };
  }
  const existing = left.querySelector(`.${MOBILE_TOOLBAR_CLASS}`);
  if (isByteMDTabMode(root)) {
    if (!existing && typeof createBar === 'function') {
      const bar = createBar();
      if (bar) {
        left.appendChild(bar);
      }
    }
    return { mounted: true };
  }
  if (existing && typeof existing.remove === 'function') {
    existing.remove();
  }
  return { mounted: false };
}

/**
 * 🔴 `options.locale` 是 `pickEditorLocale()` 合成的那个对象（期 6 第一批加的）：
 * 工具栏 11 个标题从它里面读，不再手抄中文（那些值与上游 bytemd 的 zh_Hans 逐字相同）。
 *
 * ⚠️🔴 **类型权威是同目录的 `mobileToolbar.d.ts`**：TS 解析这个模块时**优先用 .d.ts**，
 * 所以在 .js 里写 JSDoc `@param`/`@typedef` **不会生效**（本批实测：写了 typedef 之后
 * `components/Editor/index.tsx` 仍然报 TS2345，因为 .d.ts 里没有 `locale` 这个字段）。
 * 👉 **规矩：改 `.js` 模块的签名时，先看有没有同名 `.d.ts`；有就改它，别在 .js 里补 JSDoc 类型。**
 *
 * @param {{ uploadImages?: Function, locale?: Record<string, string> }} [options]
 */
function mobileToolbarPlugin(options) {
  const pluginOptions = options || {};
  return {
    editorEffect(ctx) {
      if (!ctx || !ctx.root) {
        return undefined;
      }
      const createBar = () => createMobileToolbarElement(ctx, pluginOptions);
      const sync = () => syncMobileToolbar(ctx.root, createBar);
      sync();

      const observers = [];
      if (typeof ResizeObserver === 'function') {
        const resize = new ResizeObserver(sync);
        resize.observe(ctx.root);
        observers.push(resize);
      }
      if (typeof MutationObserver === 'function') {
        const toolbar = ctx.root.querySelector('.bytemd-toolbar') || ctx.root;
        const mutate = new MutationObserver(sync);
        mutate.observe(toolbar, { childList: true, subtree: true });
        observers.push(mutate);
      }

      return () => {
        observers.forEach((observer) => observer.disconnect());
        const leftover = ctx.root.querySelector(`.${MOBILE_TOOLBAR_CLASS}`);
        if (leftover && typeof leftover.remove === 'function') {
          leftover.remove();
        }
      };
    },
  };
}

module.exports = {
  BYTEMD_SPLIT_MIN_WIDTH,
  MOBILE_TOOLBAR_ACTION_KEYS,
  HEADING_LEVELS,
  buildMobileToolbarActions,
  buildHeadingLevels,
  MOBILE_TOOLBAR_ACTIONS,
  MOBILE_TOOLBAR_CLASS,
  applyToolbarAction,
  createMobileToolbarElement,
  insertUploadedImages,
  isByteMDTabMode,
  mobileToolbarPlugin,
  syncMobileToolbar,
};
