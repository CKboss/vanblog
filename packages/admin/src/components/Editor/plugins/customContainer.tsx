import { BytemdPlugin } from 'bytemd';
import remarkDirective from 'remark-directive';
import { applyCustomContainers, useDirectivePlugin } from './customContainerRemark';

const CUSTOM_CONTAINER_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 1024 1024"><path d="M157.4 966.004a99.435 99.435 0 0 1-99.334-99.287V668.09a99.468 99.468 0 0 1 99.333-99.287h709.323a99.425 99.425 0 0 1 99.282 99.287v198.626a99.393 99.393 0 0 1-99.282 99.287zm-14.2-297.913v198.626a14.234 14.234 0 0 0 14.2 14.199h709.322a14.233 14.233 0 0 0 14.199-14.2V668.092a14.266 14.266 0 0 0-14.2-14.199H157.4a14.266 14.266 0 0 0-14.198 14.2zm14.2-212.824a99.436 99.436 0 0 1-99.334-99.288V157.353a99.468 99.468 0 0 1 99.333-99.287h709.323a99.424 99.424 0 0 1 99.282 99.287V355.98a99.393 99.393 0 0 1-99.282 99.287zM143.2 157.353V355.98a14.233 14.233 0 0 0 14.2 14.199h709.32a14.233 14.233 0 0 0 14.2-14.2V157.354a14.266 14.266 0 0 0-14.2-14.199H157.4a14.267 14.267 0 0 0-14.198 14.2z"/></svg>';

const CUSTOM_CONTAINER_ACTIONS = [
  {
    title: 'info',
    code: `:::info{title="相关信息"}\n相关信息\n:::`,
  },
  {
    title: 'note',
    code: `:::note{title="注"}\n注\n:::`,
  },
  {
    title: 'warning',
    code: `:::warning{title="注意"}\n注意\n:::`,
  },
  {
    title: 'danger',
    code: `:::danger{title="警告"}\n警告\n:::`,
  },
  {
    title: 'tip',
    code: `:::tip{title="提示"}\n提示\n:::`,
  },
];
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

// 🔴 只有**菜单标签**（'自定义高亮块'）走 t。
// 🔴 下面那 6 条 `:::info{title="相关信息"}` 之类的**模板不动**：它们是被**插入用户文章正文**的 Markdown
//    （= 内容，不是界面文案），而且 `customContainerRemark.js` 靠这几个中文标题**识别**已有文章里的容器
//    ⇒ 翻译它们会让存量文章的容器不再渲染，也会往用户正文里写英文。属"内容 i18n"（站长裁定：暂不做）。
//    这 6 条在棘轮里是**有理由的预算**，并由 customContainer.test 里的跨文件断言钉住两边一致。
export function customContainer(t: EditorT = IDENTITY_T): BytemdPlugin {
  return {
    remark: (processor) =>
      useDirectivePlugin(processor, remarkDirective).use(() => applyCustomContainers),
    actions: [
      {
        title: t('editor.customContainer', '自定义高亮块'),
        icon: CUSTOM_CONTAINER_ICON,
        cheatsheet: `:::info{title="标题"}`,
        handler: {
          type: 'dropdown',
          actions: CUSTOM_CONTAINER_ACTIONS.map(({ title, code }) => ({
            title,
            handler: {
              type: 'action',
              click: ({ editor, appendBlock, codemirror }) => {
                const { line } = appendBlock(code);

                editor.setSelection(codemirror.Pos(line + 1, 0), codemirror.Pos(line + 1));
                editor.focus();
              },
            },
          })),
        },
      },
    ],
  };
}
