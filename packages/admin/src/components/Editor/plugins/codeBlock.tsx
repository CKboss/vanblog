import type { BytemdPlugin } from 'bytemd';
import { visit } from 'unist-util-visit';
import copy from 'copy-to-clipboard';
import { message } from 'antd';
import {
  CODE_BLOCK_LINE_NUMBERS_CLASS,
  applyLineNumbersToCodeNode,
  findFencedCodeNode,
  readFencedCodeText,
} from './codeBlockLines';
// FIXME: Addd Types
const codeBlockPlugin = () => (tree) => {
  visit(tree, (node) => {
    if (node.type === 'element' && node.tagName === 'pre') {
      const oldChildren = JSON.parse(JSON.stringify(node.children || []));
      const codeNode = findFencedCodeNode(oldChildren);
      const codeProperties = codeNode && codeNode.properties ? codeNode.properties : {};
      let language = '';
      if (codeProperties.className) {
        const classNames = Array.isArray(codeProperties.className)
          ? codeProperties.className
          : [codeProperties.className];
        for (const each of classNames) {
          if (String(each).startsWith('language-')) {
            language = String(each).replace('language-', '');
            break;
          }
        }
      }
      if (language === 'mermaid') return;
      applyLineNumbersToCodeNode(codeNode);
      // 复制按钮
      const codeCopyBtn = {
        type: 'element',
        tagName: 'div',
        properties: {
          class: 'code-copy-btn',
        },
        children: [],
      };
      const languageTag = {
        type: 'element',
        tagName: 'span',
        properties: {
          class: 'language-tag mr-1',
          style: 'line-height: 21px',
        },
        children: [
          {
            type: 'text',
            value: language,
          },
        ],
      };
      // 上方右侧 header
      const headerRight = {
        type: 'element',
        tagName: 'div',
        properties: {
          class: 'header-right flex',
          style: 'color: #6f7177',
        },
        children: [languageTag, codeCopyBtn],
      };
      // 包裹的 div
      const wrapperDiv = {
        type: 'element',
        tagName: 'div',
        properties: {
          class: `code-block-wrapper relative ${CODE_BLOCK_LINE_NUMBERS_CLASS}`,
        },
        children: [headerRight, ...oldChildren],
      };
      node.children = [wrapperDiv];
    }
  });
};

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

// 🔴 '复制成功' 是 `message.success` 的文案 —— `message.*` 渲染进**脱离 React 树的独立根**（§7.151）
//    ⇒ 只能是调用期算好的字符串；这里通过工厂参数把 t 传进来（闭包捕获），不要在模块加载期取 intl。
// 🔴 变量名必须叫 `t`：共享分类器 `collectTCalls` 只认 `t(...)` / `formatMessage(...)` 两种被调名，
//    第一版叫 `copyToastT` ⇒ 那条 defaultMessage 既不算"已接 i18n"、也仍被算成裸中文（两头都不认）。
let t: EditorT = IDENTITY_T;

const onClickCopyCode = (e: PointerEvent) => {
  const copyBtn = e.target as HTMLElement;
  const codeEl = copyBtn.parentElement?.parentElement?.querySelector('code');
  const code = readFencedCodeText(codeEl);
  copy(code);
  message.success(t('editor.copied', '复制成功'));
};

export function customCodeBlock(injectedT: EditorT = IDENTITY_T): BytemdPlugin {
  // 🔴 工厂参数不能也叫 t（会遮蔽模块级那个 t ⇒ 赋给自己、永远是 IDENTITY_T，而且看不出来）
  t = injectedT;
  return {
    rehype: (processor) => processor.use(codeBlockPlugin),
    viewerEffect: ({ markdownBody }) => {
      markdownBody.querySelectorAll('.code-block-wrapper').forEach((codeBlock) => {
        const copyBtn = codeBlock.querySelector('.code-copy-btn');
        if (!copyBtn) {
          return;
        }
        copyBtn.removeEventListener('click', onClickCopyCode);
        copyBtn.addEventListener('click', onClickCopyCode);
      });
    },
  };
}
