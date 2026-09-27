import { Modal, message } from 'antd';
import { serverErrorText } from '@/services/van-blog/requestError';
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

  /**
   * 🔴 处理服务端返回的**失败 JSON**（含 `code` / `imageRefs` / `message`）。
   *
   * ## 为什么要抽出来（2026-09-27 实测到的真缺陷）
   * 原来这段逻辑只写在"blob 嗅探"分支里（`blob.type.includes('application/json')`）——
   * 但 🔴 **服务端返回 4xx 时 umi-request 会直接 reject**（`ResponseError`，body 挂在 `err.data`），
   * 根本不会走到那个分支。实测：无图文章导 `.mdz` 时服务端返回 **400**，用户只看到一句
   * `http error`，而"这篇没有图片 ⇒ 一键改导 .md"那个出口是**死代码**（写下来了但永远进不去）。
   * ⇒ 两条路径（blob 嗅探 / catch 里的 err.data）共用这一个函数。
   *
   * @returns 是否**已经**把这件事处理掉了（弹了 Modal 或弹了 error）
   */
  const handleFailureJson = (parsed: any): boolean => {
    if (!parsed || typeof parsed !== 'object') return false;
    // ⚠️ 这里不能一律弹红色报错：「这篇文章没有图片所以没有 .mdz」不是失败，
    // 是一条提示，而且用户真正想要的东西一键就能拿到（改导 .md）。
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
      return true;
    }
    // 🔴 有错误码就走译文（`serverErrorText`），没有码才用分类器给的中文 message
    message.error(serverErrorText(parsed, t) || failure.message || t('export.failed', '导出失败！'));
    return true;
  };

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
      return handleFailureJson(await readErrorJson(blob)) ? false : false;
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
    // 🔴 服务端 4xx/5xx 会走到这里（umi-request 直接 reject）⇒ body 在 `err.data`（也可能是 `err.info`）。
    //    先按"失败 JSON"处理（无图导 .mdz 那条一键改导 .md 的出口就在这里被激活），
    //    处理不了再退回通用错误提示。
    let body: any =
      err && typeof err === 'object'
        ? (err as any).data && typeof (err as any).data === 'object'
          ? (err as any).data
          : (err as any).info && typeof (err as any).info === 'object'
            ? (err as any).info
            : null
        : null;
    // 🔴 关键一步（实测出来的）：这个请求的 `responseType` 是 **blob** ⇒ umi-request reject 时
    //    挂在 `err.data` 上的是一个 **Blob**，不是解析好的 JSON！直接读 `body.code` 永远是 undefined
    //    ⇒ 第一版修完仍然只弹一句笼统的"导出失败"，那个"一键改导 .md"的出口还是进不去。
    //    ⇒ 是 Blob 就先用既有的 `readErrorJson()` 把它读成 JSON（与嗅探分支同一个函数）。
    if (body && typeof Blob !== 'undefined' && body instanceof Blob) {
      body = await readErrorJson(body);
    }
    if (body && (body.code || body.message) && handleFailureJson(body)) {
      return false;
    }
    message.error(serverErrorText(err, t) || t('export.failed', '导出失败！'));
    return false;
  } finally {
    hide();
  }
}
