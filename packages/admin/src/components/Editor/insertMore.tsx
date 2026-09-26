import { BytemdPlugin } from 'bytemd';
import { moreMarkerRehype } from './plugins/moreMarker';

/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。bytemd 插件的 action 是**纯对象**、
 * 在工厂函数里就构造好了，拿不到 React 上下文 ⇒ 由 `Editor/index.tsx` 在渲染期把 t 传进来。
 * 🔴 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前逐字相同。
 */
const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);
type EditorT = (id: string, defaultMessage: string, values?: Record<string, any>) => string;

export function insertMore(t: EditorT = IDENTITY_T): BytemdPlugin {
  return {
    rehype: (processor) => processor.use(moreMarkerRehype),
    actions: [
      {
        title: t('editor.insertMore', '插入 more 标记'),
        icon: icon, // 16x16 SVG icon
        handler: {
          type: 'action',
          click(ctx) {
            const pos = ctx.appendBlock(`<!-- more -->\n`);
            ctx.editor.setSelection(
              ctx.codemirror.Pos(pos.line, 0),
              ctx.codemirror.Pos(pos.line, 13),
            );
            ctx.editor.focus();
          },
        },
      },
    ],
  };
}
const icon = `<svg fill="currentColor" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="2605" width="16" height="16"><path d="M227.14123 413.647995c-52.14973 0-94.587262 42.439578-94.587262 94.587262 0 52.14973 42.437531 94.587262 94.587262 94.587262 52.147684 0 94.587262-42.437531 94.587262-94.587262C321.728492 456.087573 279.288914 413.647995 227.14123 413.647995z" p-id="2606"></path><path d="M510.903016 413.647995c-52.14973 0-94.587262 42.439578-94.587262 94.587262 0 52.14973 42.437531 94.587262 94.587262 94.587262 52.147684 0 94.587262-42.437531 94.587262-94.587262C605.490278 456.087573 563.051723 413.647995 510.903016 413.647995z" p-id="2607"></path><path d="M794.665825 413.647995c-52.14973 0-94.587262 42.439578-94.587262 94.587262 0 52.14973 42.437531 94.587262 94.587262 94.587262 52.147684 0 94.587262-42.437531 94.587262-94.587262C889.253086 456.087573 846.813508 413.647995 794.665825 413.647995z" p-id="2608"></path></svg>`;
