import { Modal, message } from 'antd';
import { exportMarkdownZip } from './api';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  normalizeExportFormat,
  fallbackFileName,
  loadingText,
  describeExportOutcome,
} = require('./exportFormats');

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
  /**
   * 产物格式：`md`（只要正文，服务端不抓图）/ `mdz`（Typora 图片包）/ `zip`（默认，老行为）。
   * 不传 = `zip`，所以老调用点一个都不用改也不会变行为。
   */
  format?: 'md' | 'mdz' | 'zip';
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
  const format = normalizeExportFormat(opts.format);
  const hide = message.loading(loadingText(format), 0);
  try {
    const res: any = await exportMarkdownZip({
      id: opts.id,
      type: opts.type || 'article',
      title: opts.title,
      content: opts.content,
      format,
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

    const fallback = fallbackFileName(safeName(opts.title || ''), format);
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
    // ⚠️ 按格式解释结果：.md 本来就不含图片，不能弹「有图片没打进包」
    const outcome = describeExportOutcome(report, format);
    if (!outcome) {
      message.success('导出成功！');
      return true;
    }
    if (outcome.tone === 'info') {
      Modal.info({
        title: outcome.title,
        width: 520,
        content: (
          <div>
            {outcome.lines.map((line: string) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ),
      });
      return true;
    }
    Modal.info({
      title: outcome.title,
      width: 560,
      content: (
        <div>
          {outcome.lines.map((line: string) => (
            <p key={line}>{line}</p>
          ))}
          {outcome.failedUrls?.length ? (
            <ul style={{ paddingLeft: 20, wordBreak: 'break-all' }}>
              {outcome.failedUrls.map((u: string) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ),
    });
    return true;
  } catch (err: any) {
    message.error(err?.message || '导出失败！');
    return false;
  } finally {
    hide();
  }
}
