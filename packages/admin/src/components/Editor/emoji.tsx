import { BytemdPlugin } from 'bytemd';
import { render, unmountComponentAtNode } from 'react-dom';

/**
 * 表情选择器改成**首次点击才加载**：`@emoji-mart/data` 是全量 emoji 元数据（几百 KB），
 * 以前 `editorEffect` 一进来就把 Picker 渲染好（只是用 CSS 藏起来），
 * 于是每次打开编辑器都要下载它，而绝大多数人从不点表情按钮。
 *
 * ⚠️ 缓存的是 **import() 的模块**（modsPromise），不是"渲染这件事"：
 * 以前缓存的是一个绑定在第一个容器上的 pickerPromise —— 离开编辑器再回来
 * （admin 是 SPA，编辑器会重建 DOM），新容器没有 data-emoji-ready，
 * 但 pickerPromise 已存在且渲染进的是**上一个已卸载的容器**，
 * 于是第二个及以后的编辑器会话里点表情按钮永远没反应（只能整页刷新）。
 * 现在每个容器各自渲染一次，模块与数据仍只下载一份。
 */
let currentEditor: any = null;
let modsPromise: Promise<any[]> | null = null;

function loadEmojiMods(): Promise<any[]> {
  if (!modsPromise) {
    modsPromise = Promise.all([
      import('@emoji-mart/react'),
      // @ts-ignore 数据文件没有类型声明
      import('@emoji-mart/data'),
      // @ts-ignore 同上
      import('@emoji-mart/data/i18n/zh.json'),
    ]).catch((err) => {
      // 失败要把 promise 清掉，否则再点也不会有反应
      modsPromise = null;
      throw err;
    });
  }
  return modsPromise;
}

function ensurePicker(container: Element): Promise<void> {
  if (container.getAttribute('data-emoji-ready') === 'true') {
    return Promise.resolve();
  }
  return loadEmojiMods().then((mods: any[]) => {
    // 并发双击：另一个调用可能已经渲染过了
    if (container.getAttribute('data-emoji-ready') === 'true') {
      return;
    }
    const Picker = mods[0]?.default ?? mods[0];
    const data = mods[1]?.default ?? mods[1];
    const i18n = mods[2]?.default ?? mods[2];
    const el = (
      // @ts-ignore
      <Picker
        i18n={i18n}
        data={data}
        onEmojiSelect={(c: any) => {
          if (c?.native && currentEditor) {
            currentEditor.replaceSelection(c.native);
          }
        }}
      />
    );
    render(el, container);
    container.setAttribute('data-emoji-ready', 'true');
  });
}

const EMOJI_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 1024 1024"><path d="M510.944 960c-247.04 0-448-200.96-448-448s200.992-448 448-448 448 200.96 448 448-200.96 448-448 448zm0-832c-211.744 0-384 172.256-384 384s172.256 384 384 384 384-172.256 384-384-172.256-384-384-384z"/><path d="M512 773.344c-89.184 0-171.904-40.32-226.912-110.624-10.88-13.92-8.448-34.016 5.472-44.896 13.888-10.912 34.016-8.48 44.928 5.472 42.784 54.688 107.136 86.048 176.512 86.048 70.112 0 134.88-31.904 177.664-87.552 10.784-14.016 30.848-16.672 44.864-5.888 14.016 10.784 16.672 30.88 5.888 44.864C685.408 732.32 602.144 773.344 512 773.344zM368 515.2c-26.528 0-48-21.472-48-48v-64c0-26.528 21.472-48 48-48s48 21.472 48 48v64c0 26.496-21.504 48-48 48zm288 0c-26.496 0-48-21.472-48-48v-64c0-26.528 21.504-48 48-48s48 21.472 48 48v64c0 26.496-21.504 48-48 48z"/></svg>';

const handleClick = (event: Event) => {
  event.stopPropagation();
  event.preventDefault();

  const el = document.querySelector('.emoji-container');

  if (el && !el.contains(event.target as HTMLElement)) {
    // ev.target
    // 关了应该

    el.className = 'emoji-container hidden';
    document.removeEventListener('click', handleClick);
  }
};

export const emoji = (): BytemdPlugin => ({
  editorEffect: (ctx) => {
    // 只建容器、不渲染 Picker（见文件头注释）；编辑器实例留给 onEmojiSelect 用
    currentEditor = ctx.editor;
    const container = ctx.root.querySelector('.bytemd-toolbar-left');
    if (!container) {
      return () => {
        if (currentEditor === ctx.editor) {
          currentEditor = null;
        }
      };
    }
    const targetEl = document.createElement('div');
    targetEl.className = 'emoji-container hidden';
    // 获取一下 left 的位置
    const actionEl = ctx.root.querySelector(`div[bytemd-tippy-path="18"]`) as any;
    if (actionEl) {
      targetEl.style.left = `${actionEl.offsetLeft}px`;
    }
    container.appendChild(targetEl);
    // ⚠️ 以前 editorEffect 没有清理函数：离开编辑器页后，
    // 1) 模块级 currentEditor 一直钉着已卸载的 CodeMirror 实例（连带它的整棵 DOM）；
    // 2) 渲染进 targetEl 的 Picker React 树（含几百 KB 的 emoji 数据）没有 unmount；
    // 3) 面板开着时卸载，document 上的「点外面关闭」监听永远留着
    //    （它只在 .emoji-container 还在文档里时才会自我移除）。
    return () => {
      if (currentEditor === ctx.editor) {
        currentEditor = null;
      }
      document.removeEventListener('click', handleClick);
      try {
        unmountComponentAtNode(targetEl);
      } catch (err) {
        // 还没渲染过 Picker 时 unmount 返回 false，不抛；兜底不外溢
      }
      if (targetEl.parentNode) {
        targetEl.parentNode.removeChild(targetEl);
      }
    };
  },
  actions: [
    {
      title: '表情',
      icon: EMOJI_ICON,
      handler: {
        type: 'action',
        click: ({ root }) => {
          const el = root.querySelector('.emoji-container');
          if (!el) {
            return;
          }
          // 第一次点才去下载 emoji 数据并渲染选择器
          ensurePicker(el).catch(() => undefined);

          if (el.classList.contains('hidden')) {
            // 显示的话点击外面就关闭
            setTimeout(() => {
              document.addEventListener('click', handleClick);
            }, 100);
          } else {
            document.removeEventListener('click', handleClick);
          }
          if (el) {
            el.classList.toggle('hidden');
          }
        },
      },
    },
  ],
});
