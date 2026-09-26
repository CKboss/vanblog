import { copyImgLink, getImgLink } from '@/pages/Static/img/tools';
import { getClipboardContents } from '@/services/van-blog/clipboard';
import { message } from 'antd';
import { BytemdPlugin } from 'bytemd';
// 🔴 文案在**模块级导出函数**里（不在插件工厂里）⇒ 它自己收尾参 t，由调用方（插件工厂 / Editor/index.tsx）转发。
//    ⚠️ IDENTITY_T 声明在本文件更下面（const 有 TDZ），但这里是**函数体内**引用 ⇒ 运行时早已初始化，安全。
export const uploadImg = async (file: File, t: any = IDENTITY_T) => {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/admin/img/upload?withWaterMark=true', {
      method: 'POST',
      body: formData,
      headers: {
        token: (() => {
          return window.localStorage.getItem('token') || 'null';
        })(),
      },
    });
    const data = await res.json();
    if (data && data.statusCode == 200) {
      const url = getImgLink(data.data.src, false);
      // 🔴 `copyImgLink` 的翻译器是**第 5 个**参数（第 4 个是 autoCompleteHost）⇒ 这里要显式补 undefined。
      //    ⚠️ '上传成功！ ' 结尾那个**空格是源码原样**（笔误，已登记交站长裁定）⇒ defaultMessage 必须逐字保留，
      //    否则"逐字对账"那条判据会红，而且等于在翻译批次里悄悄改了中文文案。
      copyImgLink(data.data.src, true, t('editor.uploadSuccess', '上传成功！ '), undefined, t);
      return url;
    } else {
      message.error(t('common.uploadFailed', '上传失败！'));
      return null;
    }
  } catch (err) {
    message.error(t('common.uploadFailed', '上传失败！'));
    return null;
  } finally {
  }
};
/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。bytemd 插件的 action 是纯对象、在工厂里就构造好，
 * 拿不到 React 上下文 ⇒ 由 `components/Editor/index.tsx` 在渲染期把 t 传进来。
 * 🔴 不传 t ⇒ 落到 IDENTITY_T ⇒ 输出与改造前逐字相同。
 * ⚠️ `message.*` / `Modal.*` 渲染进**脱离 React 树的独立根**（§7.151）⇒ 只能传算好的字符串。
 */
const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);
type EditorT = (id: string, defaultMessage: string, values?: Record<string, any>) => string;

export function imgUploadPlugin(
  setLoading: (loading: boolean) => void,
  t: EditorT = IDENTITY_T,
): BytemdPlugin {
  return {
    actions: [
      {
        title: t('editor.clipboardUpload', '剪切板图片上传'),
        icon: icon, // 16x16 SVG icon
        handler: {
          type: 'action',
          click(ctx) {
            setLoading(true);
            getClipboardContents()
              .then((file) => {
                if (file) {
                  uploadImg(file, t).then((url: string) => {
                    if (url) {
                      const imgs = [{ url: url, alt: file.name, title: file.name }];
                      const pos = ctx.appendBlock(
                        imgs
                          .map(({ url, alt, title }, i) => {
                            return `![${alt}](${url}${title ? ` "${title}"` : ''})`;
                          })
                          .join('\n\n'),
                      );
                      ctx.editor.setSelection(
                        pos,
                        ctx.codemirror.Pos(pos.line + imgs.length * 2 - 2),
                      );
                      ctx.editor.focus();
                    }
                  });
                } else {
                  // ⚠️ '剪切板没的图片！' 是源码原文（应为「没有」，笔误已登记交站长裁定）⇒ 逐字保留
                  message.warn(t('editor.clipboardEmpty', '剪切板没的图片！'));
                }
              })
              .catch(() => {
                message.warn(t('editor.clipboardUploadFailed', '剪切板图片上传失败！'));
              })
              .finally(() => {
                setLoading(false);
              });
            // to be implement:
            // the `ctx` is an instance of `BytemdEditorContext`, which has
            // several utility methods to help operate the CodeMirror editor state.
            // remember to call `focus` to avoid lost of focus
            // editor.focus()
          },
        },
      },
    ],
  };
}
const icon = `<svg
viewBox="0 0 1024 1024"
version="1.1"
xmlns="http://www.w3.org/2000/svg"
p-id="1689"
width="16"
fill="currentColor"
height="16"
>
<path
  d="M768 128h-50.090667A128 128 0 0 0 597.333333 42.666667h-170.666666a128 128 0 0 0-120.576 85.333333H256a128 128 0 0 0-128 128v597.333333a128 128 0 0 0 128 128h512a128 128 0 0 0 128-128V256a128 128 0 0 0-128-128z m-341.333333 0h170.666666a42.666667 42.666667 0 0 1 0 85.333333h-170.666666a42.666667 42.666667 0 0 1 0-85.333333z m384 725.333333a42.666667 42.666667 0 0 1-42.666667 42.666667H256a42.666667 42.666667 0 0 1-42.666667-42.666667V256a42.666667 42.666667 0 0 1 42.666667-42.666667h50.090667A128 128 0 0 0 426.666667 298.666667h170.666666a128 128 0 0 0 120.576-85.333334H768a42.666667 42.666667 0 0 1 42.666667 42.666667v597.333333z"
  p-id="1690"
></path>
</svg>`;
