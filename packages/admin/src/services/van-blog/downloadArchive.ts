/**
 * 🔴 多语言：**注入式翻译器**（尾参 `t = IDENTITY_T`）。这是服务层/工具模块，拿不到 hook
 * ⇒ 由调用方在渲染期把 t 传进来；🔴 不传 t ⇒ 输出与改造前**逐字相同**。
 */
const IDENTITY_T = (id: string, defaultMessage: string, values?: Record<string, any>) =>
  values
    ? String(defaultMessage).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole,
      )
    : String(defaultMessage);
type InjectedT = (id: string, defaultMessage: string, values?: Record<string, any>) => string;

import { message } from 'antd';
import { downloadExportArchive } from './api';

/**
 * 把「导出全部图片 / 导出全部附件」的归档下载到本地。
 *
 * 归档存放在服务器的备份目录（静态目录之外），不能再像以前那样直接给一个
 * `/static/export/xxx.zip` 的链接——那个目录匿名可读，文件名又只有日期，
 * 等于把整站图片和附件公开了。
 */
// 🔴 翻译器是**第 3 个**参数（尾参）：两个调用方（图床设置页、附件管理页）都已接 i18n ⇒ 都要传 t。
//    ⚠️ `message.*` 是脱离 React 树的独立根（§7.151）⇒ 这里只能传算好的字符串。
export async function saveExportArchive(name: string, successText?: string, t: InjectedT = IDENTITY_T) {
  const res: any = await downloadExportArchive(name);
  const blob: Blob = res?.data;
  if (!blob || blob.type === 'application/json') {
    // 出错时后端返回的是 JSON，直接当 blob 存下来会得到一个打不开的文件
    const text = blob ? await blob.text() : '';
    let msg = t('export.downloadFailed', '下载失败');
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
  message.success(successText || t('export.archiveDownloadStarted', '打包完成，已开始下载'));
  return true;
}
