import { message } from 'antd';
import { BytemdPlugin } from 'bytemd';

const ATTACHMENT_UPLOAD_URL = '/api/admin/file/upload';

/** 上传一个附件，返回可写进正文的 URL（失败返回 null）。 */
export const uploadAttachment = async (file: File): Promise<string | null> => {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch(ATTACHMENT_UPLOAD_URL, {
      method: 'POST',
      body: formData,
      headers: {
        token: window.localStorage.getItem('token') || 'null',
      },
    });
    const data = await res.json();
    if (data && data.statusCode == 200 && data.data?.src) {
      return data.data.src as string;
    }
    message.error(data?.message || '附件上传失败！');
    return null;
  } catch (err) {
    message.error('附件上传失败！');
    return null;
  }
};

/** 编辑器工具栏「上传附件」：选文件 → 上传 → 在光标处插入 [文件名](/static/file/...) */
export function fileUploadPlugin(setLoading: (loading: boolean) => void): BytemdPlugin {
  return {
    actions: [
      {
        title: '上传附件并插入链接',
        icon,
        handler: {
          type: 'action',
          click(ctx) {
            const input = document.createElement('input');
            input.type = 'file';
            input.style.display = 'none';
            input.onchange = async () => {
              const file = input.files && input.files[0];
              input.remove();
              if (!file) {
                return;
              }
              setLoading(true);
              const url = await uploadAttachment(file);
              setLoading(false);
              if (!url) {
                return;
              }
              const pos = ctx.appendBlock(`[${file.name}](${url})`);
              ctx.editor.setSelection(pos, ctx.codemirror.Pos(pos.line + 1));
              ctx.editor.focus();
              message.success(`附件已上传：${url}`);
            };
            document.body.appendChild(input);
            input.click();
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
width="16"
height="16"
fill="currentColor"
>
<path
  d="M779.3 196.6c-94.2-94.2-247.6-94.2-341.7 0l-261 260.8c-1.7 1.7-2.6 4-2.6 6.4s.9 4.7 2.6 6.4l36.9 36.9a9 9 0 0 0 12.7 0l261-260.8c32.4-32.4 75.5-50.2 121.3-50.2s88.9 17.8 121.2 50.2c32.4 32.4 50.2 75.5 50.2 121.2 0 45.8-17.8 88.8-50.2 121.2l-266 265.9-43.1 43.1c-40.3 40.3-105.8 40.3-146.1 0-19.5-19.5-30.2-45.4-30.2-73s10.7-53.5 30.2-73l263.9-263.8c6.7-6.6 15.5-10.3 24.9-10.3h.1c9.4 0 18.1 3.7 24.7 10.3 6.7 6.7 10.3 15.5 10.3 24.9 0 9.3-3.7 18.1-10.3 24.7L372.4 653c-1.7 1.7-2.6 4-2.6 6.4s.9 4.7 2.6 6.4l36.9 36.9a9 9 0 0 0 12.7 0l215.6-215.6c19.9-19.9 30.8-46.3 30.8-74.4s-11-54.6-30.8-74.4c-41.1-41.1-107.9-41-149 0L463 364 219.3 607.7c-40.3 40.3-62.5 93.8-62.5 150.7s22.2 110.4 62.5 150.7c40.3 40.3 93.8 62.5 150.7 62.5 56.9 0 110.4-22.2 150.7-62.5l341.7-341.7c52.2-52.2 80.9-121.5 80.9-195.3s-28.7-143.1-80.9-195.3z"
></path>
</svg>`;
