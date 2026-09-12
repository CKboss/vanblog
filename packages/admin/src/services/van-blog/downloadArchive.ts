import { message } from 'antd';
import { downloadExportArchive } from './api';

/**
 * 把「导出全部图片 / 导出全部附件」的归档下载到本地。
 *
 * 归档存放在服务器的备份目录（静态目录之外），不能再像以前那样直接给一个
 * `/static/export/xxx.zip` 的链接——那个目录匿名可读，文件名又只有日期，
 * 等于把整站图片和附件公开了。
 */
export async function saveExportArchive(name: string, successText?: string) {
  const res: any = await downloadExportArchive(name);
  const blob: Blob = res?.data;
  if (!blob || blob.type === 'application/json') {
    // 出错时后端返回的是 JSON，直接当 blob 存下来会得到一个打不开的文件
    const text = blob ? await blob.text() : '';
    let msg = '下载失败';
    try {
      msg = JSON.parse(text)?.message || msg;
    } catch {
      // 保持默认文案
    }
    message.error(msg);
    return false;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  message.success(successText || '打包完成，已开始下载');
  return true;
}
