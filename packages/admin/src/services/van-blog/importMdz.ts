/**
 * .mdz 导入的网络层。
 *
 * 为什么用裸 XHR 而不是 umi request：任务要求**真实的上传进度**（图片包可能几十 MB，
 * fetch/umi-request 拿不到 upload progress）。XHR 的 upload.onprogress 是真进度；
 * 上传完字节后切到 'ingest' 阶段（服务端解压 + 图床入库，这一段没有进度可拿，
 * 文案见 importMdzCore.IMPORT_PHASE_TEXT）。
 *
 * 鉴权：与 app.jsx 的 requestInterceptors 一致 —— HTTP 头 `token`，值取自 localStorage。
 */
// importMdzCore 是 CommonJS 纯模块（node:test 直接跑），与 exportFormats.js 同一取用方式
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mdzFailureMessage } = require('./importMdzCore');

export type MdzImportPhase = 'upload' | 'ingest';

export interface ImportMdzOptions {
  /** 服务端可见水印开关（默认 false：往返导入不重复盖印） */
  withWaterMark?: boolean;
  onProgress?: (info: { phase: MdzImportPhase; percent?: number }) => void;
}

export interface ImportMdzData {
  title: string;
  content: string;
  frontMatter: Record<string, any>;
  importedImages: number;
  dedupedImages: number;
  skippedImages: Array<{ name: string; reason: string }>;
  notes: string[];
  passwordDropped: boolean;
  markdownMember?: string;
}

const ENDPOINT = '/api/admin/article/import-mdz';

/** 成功时 resolve data（信封里的 data 字段）；失败时 reject，message 是服务端原因 */
export function importMdzFile(file: File | Blob, opts?: ImportMdzOptions): Promise<ImportMdzData> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    const name = (file as any)?.name || 'import.mdz';
    form.append('file', file, name);
    if (opts?.withWaterMark) {
      form.append('withWaterMark', 'true');
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', ENDPOINT);
    xhr.setRequestHeader('token', window.localStorage.getItem('token') || 'null');
    let ingestNotified = false;
    const notifyIngest = () => {
      if (!ingestNotified) {
        ingestNotified = true;
        opts?.onProgress?.({ phase: 'ingest' });
      }
    };
    xhr.upload.onprogress = (ev: ProgressEvent) => {
      if (!ingestNotified) {
        const percent = ev.total ? Math.round((ev.loaded / ev.total) * 100) : undefined;
        opts?.onProgress?.({ phase: 'upload', percent });
      }
    };
    // 上传字节全部出去之后，剩下的时间都花在服务端解包+图片入库上
    xhr.upload.onload = () => notifyIngest();
    xhr.onerror = () => reject(new Error('网络错误：请求没有到达服务端'));
    xhr.ontimeout = () => reject(new Error('请求超时'));
    xhr.onload = () => {
      notifyIngest();
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText || 'null');
      } catch (err) {
        body = null;
      }
      const ok = xhr.status >= 200 && xhr.status < 300;
      if (ok && body && body.data) {
        resolve(body.data as ImportMdzData);
        return;
      }
      const raw =
        (body && (body.message || body.error)) ||
        `HTTP ${xhr.status} ${xhr.statusText || ''}`.trim();
      reject(new Error(typeof raw === 'string' ? raw : JSON.stringify(raw)));
    };
    xhr.send(form);
  });
}

/** 给调用方的统一失败文案（分类逻辑在纯模块里，方便 node:test） */
export function importMdzErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err || '');
  return mdzFailureMessage(msg);
}

export const IMPORT_MDZ_ENDPOINT = ENDPOINT;
