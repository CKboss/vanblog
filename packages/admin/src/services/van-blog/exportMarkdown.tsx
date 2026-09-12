import { Modal, message } from 'antd';
import { exportMarkdownZip } from './api';

/**
 * 文章 / 草稿导出：服务端把 `<标题>.md`（原样）和 `<标题>.mdz`（md + `<标题>.assets/` 图片，
 * Typora 风格）打成一个 zip 回来，这里负责触发下载并把打包明细告诉用户。
 *
 * 为什么放服务端：图片本来就在服务器磁盘上，前端逐张 fetch 再打包既慢又要引入 zip 库；
 * 服务端还能顺手抓外链图片、拦内网地址（SSRF）。
 */
export interface MarkdownExportOptions {
  id?: number | string;
  /** article（默认）| draft | raw（不查库，直接用给的 title/content，编辑器未保存内容与关于页用） */
  type?: 'article' | 'draft' | 'raw';
  title?: string;
  content?: string;
}

interface ExportReport {
  title?: string;
  type?: string;
  imageRefs?: number;
  packedImages?: number;
  localImages?: number;
  remoteImages?: number;
  skipped?: number;
  failed?: number;
  failedUrls?: string[];
  hasMdz?: boolean;
  entries?: string[];
}

function safeName(title: string): string {
  return (
    String(title || 'article')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\s()\[\]{}'"#%]+/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(0, 80) || 'article'
  );
}

function fileNameFrom(headerValue: string | null | undefined, fallback: string): string {
  if (!headerValue) {
    return fallback;
  }
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch (err) {
      // 落到 ascii 分支
    }
  }
  const ascii = /filename="?([^";]+)"?/i.exec(headerValue);
  return ascii?.[1] || fallback;
}

async function readErrorBody(blob: Blob): Promise<string> {
  try {
    const text = await blob.text();
    const parsed = JSON.parse(text);
    return parsed?.message || text.slice(0, 200);
  } catch (err) {
    return '';
  }
}

export async function downloadMarkdownExport(opts: MarkdownExportOptions): Promise<boolean> {
  const hide = message.loading('正在打包 Markdown 与图片…', 0);
  try {
    const res: any = await exportMarkdownZip({
      id: opts.id,
      type: opts.type || 'article',
      title: opts.title,
      content: opts.content,
    });
    const blob: Blob | undefined = res?.data;
    const response = res?.response;
    if (!blob) {
      message.error('导出失败：服务端没有返回文件');
      return false;
    }
    // 出错时服务端返回的是 JSON，但 responseType 是 blob，得先嗅探一下
    if (blob.type && blob.type.includes('application/json')) {
      const detail = await readErrorBody(blob);
      message.error(detail || '导出失败！');
      return false;
    }

    const fallback = `${safeName(opts.title || '')}-markdown.zip`;
    const name = fileNameFrom(response?.headers?.get?.('content-disposition'), fallback);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    const rawReport = response?.headers?.get?.('x-export-report');
    let report: ExportReport | null = null;
    if (rawReport) {
      try {
        report = JSON.parse(decodeURIComponent(rawReport));
      } catch (err) {
        report = null;
      }
    }

    if (!report) {
      message.success('导出成功！');
      return true;
    }
    const problems = (report.failed || 0) + (report.skipped || 0);
    if (problems > 0) {
      Modal.info({
        title: '导出完成，但有图片没打进包',
        width: 560,
        content: (
          <div>
            <p>
              正文里识别到 {report.imageRefs || 0} 个图片引用，成功打包 {report.packedImages || 0} 张
              （本站 {report.localImages || 0} / 外链 {report.remoteImages || 0}）。
            </p>
            {report.failed ? <p>抓取失败 {report.failed} 张，md 里保留了原链接。</p> : null}
            {report.skipped ? <p>跳过 {report.skipped} 个（data URI、无法定位的相对路径等）。</p> : null}
            {report.failedUrls?.length ? (
              <ul style={{ paddingLeft: 20, wordBreak: 'break-all' }}>
                {report.failedUrls.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            ) : null}
            <p style={{ color: '#888' }}>压缩包里的「导出说明.md」有完整清单。</p>
          </div>
        ),
      });
    } else {
      message.success(
        report.hasMdz
          ? `已导出：${(report.entries || []).join('、')}（图片 ${report.packedImages || 0} 张）`
          : `已导出 ${(report.entries || [])[0] || 'Markdown'}（这篇文章没有图片，所以没有 .mdz）`,
      );
    }
    return true;
  } catch (err: any) {
    message.error(err?.message || '导出失败！');
    return false;
  } finally {
    hide();
  }
}
