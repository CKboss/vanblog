import { Modal, message } from 'antd';
import { getIntl, getLocale } from 'umi';
import { exportMarkdownZip } from './api';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  normalizeExportFormat,
  fallbackFileName,
  loadingText,
  describeExportOutcome,
  classifyExportFailure,
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

/** 读出错误体的**完整 JSON**（需要 code / imageRefs，不只是 message） */
async function readErrorJson(blob: Blob): Promise<any> {
  try {
    const text = await blob.text();
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return { message: text.slice(0, 200) };
  } catch (err) {
    return {};
  }
}

export async function downloadMarkdownExport(opts: MarkdownExportOptions): Promise<boolean> {
  // 🔴 这个函数弹的全是 `message.*` / `Modal.*` —— 它们渲染进**脱离 React 树的独立根**，
  //    umi 不会给它们套 IntlProvider（§7.151 那条实测缺陷）⇒ 这里必须用 `getIntl(getLocale())`
  //    （**调用期**取当前语言），不能用 `useIntl()`（这不是组件，没有 hook 上下文）。
  //    ⚠️ values 的类型必须是 `Record<string, any>`（写成 `unknown` 会撞 TS2769）。
  const intl = getIntl(getLocale());
  const t = (id: string, defaultMessage: string, values?: Record<string, any>) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const format = normalizeExportFormat(opts.format);
  const hide = message.loading(loadingText(format, t), 0);
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
      message.error(t('export.noFileFromServer', '导出失败：服务端没有返回文件'));
      return false;
    }
    // 出错时服务端返回的是 JSON，但 responseType 是 blob，得先嗅探一下
    if (blob.type && blob.type.includes('application/json')) {
      // ⚠️ 这里不能一律弹红色报错：「这篇文章没有图片所以没有 .mdz」不是失败，
      // 是一条提示，而且用户真正想要的东西一键就能拿到（改导 .md）。
      const parsed = await readErrorJson(blob);
      const failure = classifyExportFailure(parsed, format, t);
      if (failure.kind === 'no-images') {
        Modal.confirm({
          title: t('export.noImagesModalTitle', '这篇内容没有图片，所以没有 .mdz'),
          width: 520,
          okText: t('export.noImagesModalOk', '改为导出 Markdown (.md)'),
          cancelText: t('init.restore.confirmCancel', '取消'),
          content: (
            <div>
              <p>{failure.detail}</p>
              <p style={{ color: '#888' }}>
                {t(
                  'export.noImagesModalNote',
                  '.mdz 的意义就是把图片一起带走并改成相对路径；没有图片时它与 .md 完全等价。',
                )}
              </p>
            </div>
          ),
          onOk: () => downloadMarkdownExport({ ...opts, format: 'md' }),
        });
        return false;
      }
      message.error(failure.message || t('export.failed', '导出失败！'));
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
      message.success(t('export.success', '导出成功！'));
      return true;
    }
    // ⚠️ 按格式解释结果：.md 本来就不含图片，不能弹「有图片没打进包」
    const outcome = describeExportOutcome(report, format, t);
    if (!outcome) {
      message.success(t('export.success', '导出成功！'));
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
    message.error(err?.message || t('export.failed', '导出失败！'));
    return false;
  } finally {
    hide();
  }
}
