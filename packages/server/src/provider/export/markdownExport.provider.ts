import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { assertImageBuffer, fetchRemoteSafely } from 'src/utils/safeFetch';
import compressing from 'compressing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArticleProvider } from 'src/provider/article/article.provider';
import { DraftProvider } from 'src/provider/draft/draft.provider';
import { LocalProvider } from 'src/provider/static/local.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import {
  ASSETS_SUFFIX,
  ClassifiedImage,
  ImageRef,
  assetsDirName,
  assertSafeRemoteUrl,
  buildFrontMatter,
  classifyImageUrl,
  extractImageRefs,
  rewriteImageUrls,
  safeExportName,
  toRelativeLink,
  uniqueAssetName,
  safeDecodeURIComponent,
} from 'src/utils/markdownExport';

/** 单个外链图片的抓取上限：超时 / 体积 / 重定向次数 */
const REMOTE_TIMEOUT_MS = 15000;
const REMOTE_MAX_BYTES = 50 * 1024 * 1024;

export interface ExportReport {
  id: number | string;
  /** raw = 不查库，直接用调用方给的 title/content（编辑器未保存内容、关于页） */
  type: 'article' | 'draft' | 'raw';
  title: string;
  exportedAt: string;
  baseName: string;
  /** 正文里识别到的图片引用数（去重后） */
  imageRefs: number;
  localImages: number;
  remoteImages: number;
  packedImages: number;
  skipped: { url: string; reason: string }[];
  failed: { url: string; reason: string }[];
  hasMdz: boolean;
  entries: string[];
  /**
   * 本次导出**有没有真的去打包图片**。
   * `format='md'` 时是 false —— 那种格式的图片链接本来就指向站点，抓图纯属浪费，
   * 还会白白扩大 SSRF 面（外链抓取要走 `assertSafeRemoteUrl`）。
   * ⚠️ 前端要按这个字段决定文案：false 时 `packedImages=0` 不代表"打包失败"，
   * 而是"这个格式根本不含图片"，不能弹「有图片没打进包」。
   */
  assetsPacked: boolean;
}

export interface BuiltExport {
  /** 外层 zip（只有 format='zip' 时才生成 —— 其它格式不该为用不到的产物付打包成本） */
  zipPath?: string;
  /** 原样 md（format='md' 时是待下载的产物；图片链接仍指向站点） */
  mdPath?: string;
  /** Typora 风格图片包（format='mdz' 时是待下载的产物；正文没有可打包图片时不存在） */
  mdzPath?: string;
  /** 临时目录：控制器把文件发完之后整个删掉（发哪个格式都要删，别留在 /tmp） */
  tmpDir: string;
  fileName: string;
  report: ExportReport;
}

function toPlainObject(doc: any): any {
  return typeof doc?.toObject === 'function' ? doc.toObject() : doc;
}

interface ZipEntry {
  source: Buffer | string;
  relativePath: string;
}

async function writeZip(entries: ZipEntry[], destPath: string): Promise<void> {
  const stream = new compressing.zip.Stream();
  for (const entry of entries) {
    stream.addEntry(entry.source as any, { relativePath: entry.relativePath });
  }
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    stream.on('error', fail);
    out.on('error', fail);
    out.on('close', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    stream.pipe(out);
  });
}

/**
 * 文章 / 草稿导出成 Markdown：
 * - `<标题>.md`：**原样**导出（front matter + 正文，图片链接仍指向站点）
 * - `<标题>.mdz`：有图片时才生成 —— 一个 zip 包，里面是链接改成相对路径的 `<标题>.md`
 *   加上 `<标题>.assets/` 图片目录（Typora 风格，解压即用）
 * 两者一起打进一个外层 zip 返回，避免浏览器拦多文件下载。
 */
@Injectable()
export class MarkdownExportProvider {
  private readonly logger = new Logger(MarkdownExportProvider.name);

  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly draftProvider: DraftProvider,
    private readonly localProvider: LocalProvider,
    private readonly metaProvider: MetaProvider,
  ) {}

  async build(input: {
    id?: number | string;
    type?: 'article' | 'draft' | 'raw';
    /** 编辑器里可以带未保存的内容来导出，所见即所得 */
    title?: string;
    content?: string;
    /**
     * 产物格式，默认 `zip`（= 一直以来的行为：外层 zip 里装原样 md + 有图才有的 mdz + 导出说明）。
     * - `md`：只要那一份原样 md，**完全不抓图**（快，且不碰外链）
     * - `mdz`：只要 Typora 风格的图片包；正文没有可打包图片时 `mdzPath` 为空，由控制器回 400 说清楚
     */
    format?: 'zip' | 'md' | 'mdz';
  }): Promise<BuiltExport> {
    const type: 'article' | 'draft' | 'raw' =
      input.type === 'draft' ? 'draft' : input.type === 'raw' ? 'raw' : 'article';
    const format: 'zip' | 'md' | 'mdz' =
      input.format === 'md' ? 'md' : input.format === 'mdz' ? 'mdz' : 'zip';
    const id = input.id ?? 0;
    // raw：不查库，调用方（编辑器 / 关于页）直接把内容给过来
    const plain: any =
      type === 'raw' ? {} : toPlainObject(await this.loadDoc(id, type === 'draft' ? 'draft' : 'article'));
    const title = String(input.title ?? plain?.title ?? '').trim() || `untitled-${id}`;
    const content = input.content !== undefined ? String(input.content ?? '') : String(plain?.content ?? '');
    const baseName = safeExportName(title, `untitled-${input.id}`);

    let baseUrl = '';
    try {
      baseUrl = String((await this.metaProvider.getSiteInfo())?.baseUrl || '');
    } catch {
      baseUrl = '';
    }

    const frontMatter = buildFrontMatter({ ...plain, title });
    const mdOriginal = `${frontMatter}${content}`;

    const report: ExportReport = {
      id,
      type,
      title,
      exportedAt: new Date().toISOString(),
      baseName,
      imageRefs: 0,
      assetsPacked: format !== 'md',
      localImages: 0,
      remoteImages: 0,
      packedImages: 0,
      skipped: [],
      failed: [],
      hasMdz: false,
      entries: [`${baseName}.md`],
    };

    // 收集图片：同一 url 只处理一次，但改写时所有出现位置都会替换
    const refs: ImageRef[] = extractImageRefs(content);
    const byUrl = new Map<string, ImageRef>();
    // ⚠️ 去重表**照常建**：`report.imageRefs` 由它算出来，前端要靠这个数字解释
    // "识别到 N 个图片引用，但你选的 .md 格式不含图片"。第一版把跳过放在这里，
    // 结果 imageRefs 变成 0，用户看到的就成了"这篇文章没有图片"—— 那是错的。
    for (const ref of refs) {
      if (!byUrl.has(ref.url)) {
        byUrl.set(ref.url, ref);
      }
    }
    report.imageRefs = byUrl.size;

    const assetsDir = assetsDirName(title);
    const taken = new Set<string>();
    const mapping = new Map<string, string>();
    const assetEntries: ZipEntry[] = [];

    // 真正抓图/拷图的循环才是要跳过的那一个：format='md' 时图片链接本来就指向站点，
    // 抓图纯属白做功，而外链抓取还要过 SSRF 校验 —— 少一次网络请求就少一分风险面。
    for (const [url] of format === 'md' ? new Map<string, ImageRef>() : byUrl) {
      const classified: ClassifiedImage = classifyImageUrl(url, baseUrl);
      if (classified.kind === 'skip') {
        report.skipped.push({ url, reason: classified.reason || '跳过' });
        continue;
      }
      if (classified.kind === 'local') {
        const realPath = `/static/${classified.staticRel}`;
        try {
          const abs = this.localProvider.resolveStaticAbs(realPath);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            report.failed.push({ url, reason: '文件已不在磁盘上（可能被删过）' });
            continue;
          }
          const assetName = uniqueAssetName(path.basename(abs), taken);
          assetEntries.push({
            source: abs,
            relativePath: `${assetsDir}/${assetName}`,
          });
          mapping.set(url, toRelativeLink(assetsDir, assetName));
          report.localImages += 1;
          report.packedImages += 1;
        } catch (err) {
          report.failed.push({ url, reason: (err as Error)?.message || '读取失败' });
        }
        continue;
      }

      // 外链：抓一次，抓不到就保留原链接
      try {
        const safeUrl = await assertSafeRemoteUrl(classified.absolute || url);
        // fetchRemote 内部会逐跳重新校验重定向，并要求内容真的是图片
        const buffer = await this.fetchRemote(safeUrl.toString());
        const assetName = uniqueAssetName(this.remoteFileName(safeUrl.pathname), taken);
        assetEntries.push({ source: buffer, relativePath: `${assetsDir}/${assetName}` });
        mapping.set(url, toRelativeLink(assetsDir, assetName));
        report.remoteImages += 1;
        report.packedImages += 1;
      } catch (err) {
        report.failed.push({ url, reason: (err as Error)?.message || '抓取失败' });
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-md-export-'));
    try {
      const outerEntries: ZipEntry[] = [
        { source: Buffer.from(mdOriginal, 'utf8'), relativePath: `${baseName}.md` },
      ];

      if (assetEntries.length) {
        const mdRelative = `${frontMatter}${rewriteImageUrls(content, mapping)}`;
        const mdzPath = path.join(tmpDir, `${baseName}.mdz`);
        await writeZip(
          [
            { source: Buffer.from(mdRelative, 'utf8'), relativePath: `${baseName}.md` },
            ...assetEntries,
          ],
          mdzPath,
        );
        outerEntries.push({ source: mdzPath, relativePath: `${baseName}.mdz` });
        report.hasMdz = true;
        report.entries.push(`${baseName}.mdz`);
      }

      if (report.skipped.length || report.failed.length) {
        outerEntries.push({
          source: Buffer.from(this.renderReport(report), 'utf8'),
          relativePath: '导出说明.md',
        });
        report.entries.push('导出说明.md');
      }

      // md / mdz：把单个文件也落到临时目录里，控制器直接发它，不必先打外层 zip 再让前端解包
      let mdPath: string | undefined;
      let mdzPath: string | undefined;
      if (format !== 'zip') {
        if (format === 'md') {
          mdPath = path.join(tmpDir, `${baseName}.md`);
          fs.writeFileSync(mdPath, mdOriginal, 'utf8');
          report.entries.push(`${baseName}.md`);
        } else {
          // mdz 只在上真的有图片时才存在（assetEntries 为空 ⇒ 没有 mdz，交给控制器回 400）
          const candidate = path.join(tmpDir, `${baseName}.mdz`);
          if (fs.existsSync(candidate)) {
            mdzPath = candidate;
          }
        }
      }

      if (format !== 'zip') {
        this.logger.log(
          `导出${type === 'draft' ? '草稿' : type === 'raw' ? '编辑器内容' : '文章'} #${id}《${title}》为 .${format}：图片 ${report.packedImages} 张`,
        );
        return {
          mdPath,
          mdzPath,
          tmpDir,
          fileName: format === 'md' ? `${baseName}.md` : `${baseName}.mdz`,
          report,
        };
      }

      const zipPath = path.join(tmpDir, `${baseName}-markdown.zip`);
      await writeZip(outerEntries, zipPath);
      this.logger.log(
        `导出${type === 'draft' ? '草稿' : type === 'raw' ? '编辑器内容' : '文章'} #${id}《${title}》：图片 ${report.packedImages} 张（本地 ${report.localImages} / 外链 ${report.remoteImages}），失败 ${report.failed.length}`,
      );
      return { zipPath, tmpDir, fileName: `${baseName}-markdown.zip`, report };
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
  }

  private async loadDoc(id: number | string, type: 'article' | 'draft'): Promise<any> {
    const doc =
      type === 'draft'
        ? await this.draftProvider.getById(id)
        : await this.articleProvider.getById(id, 'admin');
    if (!doc) {
      throw new BadRequestException(type === 'draft' ? '草稿不存在！' : '文章不存在！');
    }
    return doc;
  }

  private async fetchRemote(url: string): Promise<Buffer> {
    // 不能用 axios 的自动重定向：assertSafeRemoteUrl 只校验第一跳，
    // 攻击者可以 302 到 127.0.0.1 / 169.254.169.254，把内网响应打进 zip 带回去。
    const { buffer } = await fetchRemoteSafely(url, {
      timeoutMs: REMOTE_TIMEOUT_MS,
      maxBytes: REMOTE_MAX_BYTES,
      maxRedirects: 3,
      userAgent: 'VanBlog-Export/1.0',
    });
    // 再验一次魔数：不是图片就说明是重定向/伪装拿到的别的东西，不能进 zip
    assertImageBuffer(buffer, url);
    return buffer;
  }

  private remoteFileName(pathname: string): string {
    const base = path.basename(String(pathname || '').split('?')[0]);
    return base && base !== '/' ? safeDecodeURIComponent(base) : 'image';
  }

  private renderReport(report: ExportReport): string {
    const lines: string[] = [
      '# 导出说明',
      '',
      `- 标题：${report.title}`,
      `- 类型：${
        report.type === 'draft' ? '草稿' : report.type === 'raw' ? '编辑器内容（未入库）' : '文章'
      }${report.type === 'raw' ? '' : `（id ${report.id}）`}`,
      `- 导出时间：${report.exportedAt}`,
      `- 正文里的图片引用：${report.imageRefs} 个（去重后）`,
      `- 已打包图片：${report.packedImages} 张（本站 ${report.localImages} 张 / 外链 ${report.remoteImages} 张）`,
      '',
      '## 包里有什么',
      '',
      `- \`${report.baseName}.md\`：**原样**导出的 Markdown（front matter + 正文），图片链接仍指向站点地址。`,
    ];
    if (report.hasMdz) {
      lines.push(
        `- \`${report.baseName}.mdz\`：带图片的版本，本质是个 zip（改后缀即可解开），里面是链接已改成相对路径的 \`${report.baseName}.md\` 和 \`${report.baseName}${ASSETS_SUFFIX}/\` 图片目录，解压后用 Typora / Obsidian / VSCode 打开即可。`,
      );
    } else {
      lines.push('- 这篇文章没有可打包的图片，所以没有生成 `.mdz`。');
    }

    if (report.skipped.length) {
      lines.push('', '## 跳过的图片（保留原样，未打包）', '');
      for (const item of report.skipped) {
        lines.push(`- \`${item.url}\` —— ${item.reason}`);
      }
    }
    if (report.failed.length) {
      lines.push('', '## 打包失败的图片（md 里仍是原链接）', '');
      for (const item of report.failed) {
        lines.push(`- \`${item.url}\` —— ${item.reason}`);
      }
      lines.push('', '> 外链图片失败常见原因：对方站点防盗链、超时、需要登录，或地址本身已失效。');
    }
    return `${lines.join('\n')}\n`;
  }
}
