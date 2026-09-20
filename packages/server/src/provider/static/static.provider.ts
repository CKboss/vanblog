import { assertImageBuffer, fetchRemoteSafely } from 'src/utils/safeFetch';
import { envPositiveInt } from 'src/utils/envNumber';

/**
 * 「扫描文章图片」时**同时在飞**的链接数上限。
 *
 * 为什么默认只有 4：每个在飞的链接最坏会持有一张远端图片的完整 buffer（单张上限
 * `MAX_REMOTE_IMAGE_BYTES` = 50 MB）⇒ 4 × 50 MB = 200 MB 峰值。再高就要拿内存换速度。
 * ⚠️ 并发只对**网络等待**有效：`encryptFileMD5`（utils/crypto.ts:361）与 `imageSize` 都是
 * 同步的，仍然串行占用事件循环 —— 这是已知的残余成本，不在本次修复范围内。
 */
const IMG_LINK_SCAN_CONCURRENCY = envPositiveInt('VANBLOG_IMG_SCAN_CONCURRENCY', 4, 1, 32);

/**
 * 一轮扫描最多处理多少个图片链接。
 *
 * 为什么要有：每个链接都要**真去下载一次**（`getImgInfoByLink` → `fetchImg` → `fetchRemoteSafely`，
 * 单张上限 50 MB、超时 15 s，而且失败时还会用 `encodeURI(link)` **再试一次** ⇒ 一个死链最多
 * 耗 30 s）。以前是**串行**且**无上限**：一篇被塞了几千个外链的文章就能让这一个请求跑上几小时，
 * 期间一直占着连接与内存，而调用方（后台「扫描文章图片」）只能干等。
 * ⚠️ 撞上限时必须如实报告（`truncatedLinks: true` + WARN），不能让调用方以为全站都扫过了。
 */
const IMG_LINK_SCAN_MAX_LINKS = envPositiveInt('VANBLOG_IMG_SCAN_MAX_LINKS', 2000, 1, 10000000);

/** 单张远端图片的体积上限：以前没有上限，一个大文件就能把内存吃光。 */
const MAX_REMOTE_IMAGE_BYTES = 50 * 1024 * 1024;
import {
  assertUploadedImage,
  resolveUploadMinFreeBytes,
  safeImageExtension,
  uploadSpaceShortfallMessage,
} from 'src/utils/uploadLimits';
import { freeSpaceBytes } from 'src/utils/fullBackup';
import { config } from 'src/config';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SearchStaticOption, StaticType, StorageType } from 'src/types/setting.dto';
import { Static, StaticDocument } from 'src/scheme/static.schema';
import { encryptFileMD5 } from 'src/utils/crypto';
import { ArticleProvider } from '../article/article.provider';
import { SettingProvider } from '../setting/setting.provider';
import { LocalProvider } from './local.provider';
import { PicgoProvider } from './picgo.provider';
import { imageSize } from 'image-size';
import { ImgMeta } from 'src/types/img';
import { formatBytes } from 'src/utils/size';
import { sanitizePagination } from 'src/utils/pagination';
import axios from 'axios';
import { UploadConfig, UploadContext } from 'src/types/upload';
import { addWaterMarkToIMG } from 'src/utils/watermark';
import { checkTrue } from 'src/utils/checkTrue';
import { compressExt, compressImg, resolveCompressFormat } from 'src/utils/imgCompress';
import { capImageResolution } from 'src/utils/imgResize';
import {
  generateAvifThumbIfEnabled,
  generateThumbnail,
  generateThumbnailAvif,
  resolveThumbAvifEnabled,
} from 'src/utils/thumbnail';
import { buildStegoPayload, parseThumbWidth, resolveMaxImageEdge } from 'src/utils/imageOptions';
// 显式标注删除方法的返回类型，避开 mongoose 自带 mongodb 副本的不可移植路径（TS2742）。
import type { DeleteResult } from 'mongodb';
import { embedStegoWatermark, extractStegoWatermark } from 'src/utils/stegoWatermark';
import { canEncodeFormat, encodeImageToFormat, normalizeImageFormat } from 'src/utils/imgEncode';
import { safeImageSize } from 'src/utils/imageMeta';
import { normalizeCustomPageRel } from 'src/utils/customPagePath';
import {
  assertAttachmentSize,
  attachmentExtOf,
  buildStoredFileName,
  decodeUploadFileName,
  displayFileName,
} from 'src/utils/attachment';
import { sanitizeStoredImageName } from 'src/utils/storedFileName';
import { escapeRegExp } from 'src/utils/regex';
import {
  applyImageUrlMap,
  classifyImageUrl,
  collectSiteHosts,
  emptyTransferResult,
  extractImageRefs,
  filenameFromRemote,
  looksLikeImage,
  TransferRemoteResult,
} from 'src/utils/transferRemoteImages';
@Injectable()
export class StaticProvider {
  logger = new Logger(StaticProvider.name);
  constructor(
    @InjectModel('Static')
    private staticModel: Model<StaticDocument>,
    private readonly settingProvider: SettingProvider,
    private readonly localProvider: LocalProvider,
    private readonly picgoProvider: PicgoProvider,
    private readonly articleProvder: ArticleProvider,
  ) {}
  publicView = {
    _id: 0,
  };
  adminView = undefined;
  getView(view: 'admin' | 'public') {
    if (view == 'admin') {
      return this.adminView;
    }
    return this.publicView;
  }
  /**
   * 图片处理管线，`upload()` 和 `replaceBySign()` 共用：
   * **可见水印 → 缩放 → 隐写水印 → 编码/压缩**。
   *
   * 顺序不能改：缩放会重采样、把隐写的块均值格点打乱，所以必须在隐写之前；
   * 隐写用的是块均值调制（不是 LSB），必须赶在有损压缩之前写进去才读得回来。
   *
   * `forceFormat` 只给「替换图片」用：新内容要写回原来的 URL，后缀必须保持一致。
   */
  private async runImagePipeline(
    input: Buffer,
    fileType: string,
    settings: any,
    options?: {
      updateConfig?: UploadConfig;
      context?: UploadContext;
      forceFormat?: string;
    },
  ): Promise<{ buffer: Buffer; sign: string; stego: boolean; compressSuccess: boolean }> {
    let buf = input;
    let compressSuccess = true;
    let stego = false;
    const compressFormat = resolveCompressFormat(settings?.compressFormat);
    const forceFormat = options?.forceFormat
      ? normalizeImageFormat(options.forceFormat)
      : undefined;

    try {
      // 双保险：只有调用方要求水印、并且设置里也开着，才会加可见水印。
      const updateConfig = options?.updateConfig;
      if (updateConfig && updateConfig.withWaterMark && fileType != 'gif') {
        if (settings && checkTrue(settings?.enableWaterMark)) {
          const waterMarkText = updateConfig.waterMarkText || settings.waterMarkText;
          if (waterMarkText && waterMarkText.trim() !== '') {
            buf = await addWaterMarkToIMG(buf, waterMarkText);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`可见水印失败，按原图继续：${(err as Error)?.message}`);
    }

    if (checkTrue(settings?.enableResize)) {
      try {
        const maxEdge = resolveMaxImageEdge(settings?.maxImageEdge);
        const resized = await capImageResolution(buf, maxEdge, fileType);
        if (resized.resized) {
          buf = resized.buffer;
        }
      } catch (err) {
        this.logger.warn(`缩放失败，按原图继续：${(err as Error)?.message}`);
      }
    }

    if (checkTrue(settings?.enableStegoWaterMark) && fileType != 'gif') {
      try {
        const key = await this.settingProvider.getStegoKey();
        const text = buildStegoPayload({
          custom: settings?.stegoWaterMarkText,
          baseUrl: options?.context?.baseUrl,
          author: options?.context?.author,
          uploader: options?.context?.uploader,
        });
        const stegoRes = await embedStegoWatermark(buf, text, key);
        if (stegoRes.embedded) {
          buf = stegoRes.buffer;
          stego = true;
        } else if (
          stegoRes.reason &&
          !['image-too-small', 'unsupported-format'].includes(stegoRes.reason)
        ) {
          this.logger.warn(`隐写水印未写入：${stegoRes.reason}`);
        }
      } catch (err) {
        this.logger.warn(`隐写水印失败，按原图继续：${(err as Error)?.message}`);
      }
    }

    if (forceFormat) {
      // 替换：后缀必须和原文件一致，否则文章里的链接就断了。
      try {
        if (forceFormat === 'webp' || forceFormat === 'avif') {
          buf = await compressImg(buf, forceFormat);
        } else if (canEncodeFormat(forceFormat)) {
          buf = await encodeImageToFormat(buf, forceFormat);
        }
        // gif 等不能重编码的格式：原样写入，免得丢掉动画
      } catch (err) {
        this.logger.warn(`替换时重新编码失败，写入原图：${(err as Error)?.message}`);
        compressSuccess = false;
      }
    } else if (checkTrue(settings?.enableWebp)) {
      try {
        buf = await compressImg(buf, compressFormat);
      } catch (err) {
        // console.log(err);
        compressSuccess = false;
      }
    }

    return { buffer: buf, sign: encryptFileMD5(buf), stego, compressSuccess };
  }

  async upload(
    file: any,
    type: StaticType,
    isFavicon?: boolean,
    customPathname?: string,
    updateConfig?: UploadConfig,
    context?: UploadContext,
  ) {
    if (type == 'file') {
      // 附件走独立分支：不加水印、不压缩、不按图片去重。
      return await this.uploadAttachment(file);
    }
    const { buffer } = file;
    // multer/busboy 按 latin1 解码文件名，中文名会变成 `æµ‹è¯•.png` 这种乱码
    // （附件分支早就修了，图片/自定义页面这条老路径一直没修）
    const originalName = decodeUploadFileName(file.originalname);
    const arr = originalName.split('.');
    let fileType = arr[arr.length - 1];
    if (type === 'img') {
      // 图片接口在 publicRoutes 里（协作者可调），而 /static/img/** 是同源匿名可读的。
      // 以前不校验内容：上传 evil.html 时管线每一步都失败并被 catch 掉，原始字节
      // 被存成 <md5>.evil.html，再以 text/html 同源返回 → 存储型 XSS（可偷管理员 token）。
      // 现在按**内容**判定类型，SVG 与非图片一律拒绝（要传非图片请走附件管理）。
      const verified = assertUploadedImage(buffer, originalName);
      fileType = safeImageExtension(fileType, verified.type);
    }
    let buf = buffer;
    let currentSign = encryptFileMD5(buf);
    const staticConfigInDB = await this.settingProvider.getStaticSetting();
    let compressSuccess = true;
    /** 这张图有没有成功写入隐写水印（返回给前端只是提示用）。 */
    let stegoEmbedded = false;
    const compressFormat = resolveCompressFormat(staticConfigInDB?.compressFormat);
    if (type == 'img') {
      const processed = await this.runImagePipeline(buf, fileType, staticConfigInDB, {
        updateConfig,
        context,
      });
      buf = processed.buffer;
      currentSign = processed.sign;
      compressSuccess = processed.compressSuccess;
      stegoEmbedded = processed.stego;

      // 按 (sign, staticType) 去重：同内容的**附件**不该被当成已存在的图片
      const hasFile = await this.getOneBySignAndType(currentSign, 'img');

      if (hasFile) {
        return {
          src: hasFile.realPath,
          isNew: false,
        };
      }
    }

    // ⚠️ 图片落盘名过一遍与**附件同一套**净化（剥路径分隔符/控制字符/引号/前导点，
    //    超长保留后缀截断）。以前这里直接用 `originalName`，而 `decodeUploadFileName()`
    //    只把 latin1 还原成 utf8（修中文名乱码），**不剥分隔符**。
    //    今天没出事的原因不在我们代码里：`preservePath` 全仓库未设置 ⇒ busboy 默认对
    //    multipart 的 filename 做 `basename()`，`/` 与 `..` 进不到 originalname。
    //    那是**依赖项的默认值**，一次配置改动或换上传库就变成任意路径写；
    //    而且 `transferRemoteImages()` 走的是 `filenameFromRemote()`（从远程 URL 造名字），
    //    压根不经过 busboy。落盘处（`local.provider.saveImg`）另有容器化校验兜底。
    const safeImageName = sanitizeStoredImageName(originalName);
    const safeNameArr = safeImageName.split('.');
    const pureFileName = safeNameArr.slice(0, safeNameArr.length - 1).join('.');
    let fileName = currentSign + '.' + safeImageName;
    if (type == 'customPage') {
      fileName = normalizeCustomPageRel(customPathname, originalName);
    }
    if (type == 'img' && checkTrue(staticConfigInDB.enableWebp) && compressSuccess) {
      fileName = currentSign + '.' + pureFileName + '.' + compressExt(compressFormat);
    }
    const storedType =
      type == 'img' && checkTrue(staticConfigInDB.enableWebp) && compressSuccess
        ? compressExt(compressFormat)
        : fileType;
    const storedFileName = isFavicon ? `favicon.${storedType}` : fileName;

    // 缩略图给后台图片管理用：列表加载小图而不是原图，翻几十张也快。
    let extraMeta: Record<string, any> | undefined;
    if (type == 'img' && !isFavicon && checkTrue(staticConfigInDB.enableThumb)) {
      try {
        const thumb = await generateThumbnail(
          buf,
          parseThumbWidth(staticConfigInDB.thumbWidth),
          fileType,
        );
        if (thumb.ok) {
          const thumbPath = await this.localProvider.saveThumb(
            storedFileName,
            thumb.buffer,
            thumb.ext,
          );
          extraMeta = { thumb: thumbPath, thumbWidth: thumb.width, thumbHeight: thumb.height };
        } else if (thumb.reason && !['disabled', 'unsupported'].includes(thumb.reason)) {
          this.logger.warn(`缩略图生成失败：${thumb.reason}`);
        }
      } catch (err) {
        this.logger.warn(`缩略图生成失败：${(err as Error)?.message}`);
      }
      // P7：AVIF 兄弟缩略图（VANBLOG_THUMB_AVIF，默认关；关闭时零成本 —— 不碰 sharp）。
      // 失败只 WARN：webp 缩略图已经能用，AVIF 是渐进增强，绝不把上传带崩。
      const avifThumb = await generateAvifThumbIfEnabled(
        buf,
        parseThumbWidth(staticConfigInDB.thumbWidth),
        fileType,
      );
      if (avifThumb?.ok) {
        const avifPath = await this.localProvider.saveThumb(
          storedFileName,
          avifThumb.buffer,
          avifThumb.ext,
        );
        extraMeta = {
          ...(extraMeta || {}),
          thumbAvif: avifPath,
          thumbAvifBytes: avifThumb.buffer.length,
        };
      } else if (avifThumb && !['disabled', 'unsupported'].includes(avifThumb.reason || '')) {
        this.logger.warn(`AVIF 缩略图生成失败：${avifThumb.reason}`);
      }
    }

    const realPath = await this.saveFile(
      storedType,
      storedFileName,
      buf,
      type,
      currentSign,
      isFavicon,
      extraMeta,
    );
    if (!realPath) {
      throw new HttpException('上传失败', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return {
      src: realPath,
      isNew: true,
      stego: stegoEmbedded,
    };
  }

  /**
   * 附件上传（任意文件）：
   * - 只存本地（`<static>/file/`），不走 PicGo/OSS，多数图床不支持非图片文件；
   * - 按内容 MD5 去重，同一份文件重复上传返回同一个 URL；
   * - 文件名安全化后存成 `<md5>.<原名>`，URL 里保留原名便于识别。
   */
  async uploadAttachment(file: any) {
    const buffer = file?.buffer;
    assertAttachmentSize(buffer?.byteLength);
    const sign = encryptFileMD5(buffer);
    const existing = await this.getOneBySignAndType(sign, 'file');
    if (existing) {
      return {
        src: existing.realPath,
        isNew: false,
        name: displayFileName(existing.name),
      };
    }
    const fileName = buildStoredFileName(sign, decodeUploadFileName(file?.originalname));
    const realPath = await this.saveFile(
      attachmentExtOf(fileName),
      fileName,
      buffer,
      'file',
      sign,
    );
    if (!realPath) {
      throw new HttpException('上传失败', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return {
      src: realPath,
      isNew: true,
      name: displayFileName(fileName),
    };
  }

  async importItems(items: Static[]) {
    for (const each of items) {
      // 单条失败不应该让整次导入崩掉：以前这里既不 await、更新文档又写成 `{ each }`
      // （`each` 不是 schema 字段，strict 模式剥掉后 driver 抛
      // "Update document requires atomic operators"），未 await 就变成 unhandledRejection，
      // Node 20 默认直接退出进程——接口已经回了「导入成功」，server 却在半路挂掉。
      try {
        const oldItem = await this.getOneBySign(each.sign);
        if (!oldItem) {
          await this.createInDB(each);
        } else {
          const { _id, ...fields } = each as any;
          await this.staticModel.updateOne({ _id: oldItem._id }, { $set: fields });
        }
      } catch (error) {
        this.logger.warn(
          `导入图片记录失败，已跳过：sign=${(each as any)?.sign} reason=${error?.message || error}`,
        );
      }
    }
  }
  async fetchImg(link: string): Promise<Buffer | null> {
    const fetched = await this.fetchRemoteImage(link);
    return fetched?.buffer || null;
  }

  async fetchRemoteImage(
    link: string,
  ): Promise<{ buffer: Buffer; contentType?: string } | null> {
    // 「转移外链图片」/「扫描文章图片」都走这里。以前是裸 axios + maxRedirects:5，
    // 既不校验目标是不是内网，也不跟随重定向复查 → 管理员（或拿到 API token 的人）
    // 可以让服务器去请求 169.254.169.254 / 127.0.0.1:2019，并把响应存进公开图床。
    const tryGet = async (url: string) => {
      const res = await fetchRemoteSafely(url, {
        timeoutMs: 15000,
        maxBytes: MAX_REMOTE_IMAGE_BYTES,
        maxRedirects: 3,
        userAgent: 'Mozilla/5.0 (compatible; VanBlog/1.0; +https://vanblog.mereith.com)',
      });
      // 必须是真图片（魔数），否则丢弃：防止把内网文本响应存成图床文件
      assertImageBuffer(res.buffer, url);
      return { buffer: res.buffer, contentType: res.contentType };
    };
    try {
      return await tryGet(link);
    } catch (err) {
      try {
        return await tryGet(encodeURI(link));
      } catch (retryErr) {
        this.logger.warn(
          `抓取远端图片失败：${link} reason=${(retryErr as Error)?.message || retryErr}`,
        );
        return null;
      }
    }
  }

  async transferRemoteImages(
    content: string,
    opts: { siteHosts?: string[]; siteBaseUrl?: string } = {},
  ): Promise<TransferRemoteResult> {
    const source = content || '';
    if (!source.trim()) {
      return emptyTransferResult(source);
    }
    const stored = await this.getAll('img', 'public');
    const knownRealPaths = (stored || []).map((item) => item.realPath).filter(Boolean);
    const siteHosts = collectSiteHosts(opts.siteBaseUrl, opts.siteHosts);
    const refs = extractImageRefs(source);
    const uniqueUrls = [...new Set(refs.map((ref) => ref.url).filter(Boolean))];
    const transferred: TransferRemoteResult['transferred'] = [];
    const skipped: TransferRemoteResult['skipped'] = [];
    const failed: TransferRemoteResult['failed'] = [];
    const urlMap = new Map<string, string>();

    for (const url of uniqueUrls) {
      const classified = classifyImageUrl(url, { siteHosts, knownRealPaths });
      if (classified.kind === 'skip') {
        skipped.push({ url, reason: classified.reason || 'skip' });
        continue;
      }
      try {
        const fetched = await this.fetchRemoteImage(url);
        if (!fetched || !looksLikeImage(fetched.buffer, fetched.contentType)) {
          failed.push({ url, reason: 'download-failed' });
          continue;
        }
        const originalname = filenameFromRemote(url, fetched.contentType);
        const uploaded = await this.upload(
          { originalname, buffer: fetched.buffer },
          'img',
          false,
          undefined,
          { withWaterMark: true },
        );
        if (!uploaded?.src) {
          failed.push({ url, reason: 'upload-failed' });
          continue;
        }
        urlMap.set(url, uploaded.src);
        transferred.push({ from: url, to: uploaded.src });
      } catch (err) {
        failed.push({ url, reason: 'error' });
      }
    }

    return {
      content: applyImageUrlMap(source, urlMap),
      transferred,
      skipped,
      failed,
    };
  }
  async getImgInfoByLink(link: string) {
    const buffer = await this.fetchImg(link);
    if (!buffer) {
      return null;
    }
    const result = imageSize(buffer);
    const meta: ImgMeta = { ...result, size: formatBytes(buffer.byteLength) };
    const filename = link.split('/').pop();
    const fileType = filename?.split('.')?.pop() || '';
    const currentSign = encryptFileMD5(buffer);
    return {
      meta,
      staticType: 'img' as StaticType,
      storageType: 'picgo' as StorageType,
      fileType: result?.type || fileType,
      realPath: link,
      name: filename,
      sign: currentSign,
    };
  }
  /**
   * 扫描全站文章正文里的图片链接，把没入库的补进图床、把抓不到的报成失效链接。
   *
   * ## 这一版改了三件事（都是资源边界问题）
   *  1. **不再把全库正文一次性拉进堆**：改调 `articleProvider.scanAllImageLinks()`，
   *     它按 `_id` keyset 分批（50 篇/批）+ 只投影 `content` 等必要字段。
   *  2. **链接处理从串行改成有界并发**（默认 4，`VANBLOG_IMG_SCAN_CONCURRENCY`）。
   *     以前是一个一个 `await`：每个链接最坏要下载 50 MB、超时 15 s、失败还会重试一次，
   *     于是"几千个外链"就能让这一个请求跑上几小时。
   *  3. **链接总数有上限**（默认 2000，`VANBLOG_IMG_SCAN_MAX_LINKS`），撞上限时
   *     `truncatedLinks: true` + WARN —— 绝不静默返回不完整结果让调用方以为扫全了。
   *
   * ⚠️ 可达性：这条路由（`POST /api/admin/img/scan`）**勾了「所有权限」的协作者也能调**
   * （`/api/admin/img` 不在 `SUPER_ADMIN_ONLY_ROUTE_PREFIXES` 里），所以它必须被当作
   * "低权限账号也能触发的重活"来设防，而不是"管理员自己不会乱点"。
   *
   * ⚠️ 返回形状是**追加**的：`total`（发现的链接总数，语义不变）与 `errorLinks`
   * （元素形状不变，含既有的 `artcileId` 拼写——已被外部消费，不能改）都保留。
   */
  async scanLinksOfArticles() {
    const scan = await this.articleProvder.scanAllImageLinks();

    // 先把 (文章, 链接) 摊平，这样并发与截断都好算；`total` 仍是"发现的链接总数"
    const tasks: Array<{ articleId: number; title: string; link: string }> = [];
    for (const linkObj of scan.items) {
      for (const link of linkObj.links) {
        tasks.push({ articleId: linkObj.articleId, title: linkObj.title, link });
      }
    }
    const total = tasks.length;
    const truncatedLinks = total > IMG_LINK_SCAN_MAX_LINKS;
    const work = truncatedLinks ? tasks.slice(0, IMG_LINK_SCAN_MAX_LINKS) : tasks;

    if (truncatedLinks) {
      this.logger.warn(
        `扫描文章图片**未处理完全部链接**：共发现 ${total} 个，单轮上限 ${IMG_LINK_SCAN_MAX_LINKS} 个，` +
          `本次只处理了前 ${work.length} 个（另有 ${total - work.length} 个没碰）。` +
          `结果不完整，请勿据此认为"全站图片都已入库/没有失效图"。` +
          `要一次扫完，调大 VANBLOG_IMG_SCAN_MAX_LINKS（注意每个链接都要真下载一次，单张上限 50 MB）。`,
      );
    }

    const errorLinks: Array<{ artcileId: number; title: string; link: string }> = [];
    let processed = 0;
    let created = 0;
    let cursor = 0;

    const runOne = async (task: { articleId: number; title: string; link: string }) => {
      try {
        const dto = await this.getImgInfoByLink(task.link);
        if (!dto) {
          errorLinks.push({
            // ⚠️ 拼写沿用既有契约（`artcileId`）：已被外部消费，改名会静默打断消费方
            artcileId: task.articleId,
            title: task.title,
            link: task.link,
          });
          return;
        }
        const hasPicture = await this.getOneBySign(dto?.sign || '');
        if (!hasPicture) {
          await this.createInDB(dto);
          created += 1;
        }
      } catch (err) {
        // 单个链接失败不能整轮失败：记成失效链接，继续处理其余的
        errorLinks.push({ artcileId: task.articleId, title: task.title, link: task.link });
        this.logger.warn(
          `扫描文章图片：处理链接失败 ${task.link} reason=${(err as Error)?.message || err}`,
        );
      } finally {
        processed += 1;
      }
    };

    // 有界并发的 worker 池：每个 worker 从共享游标取任务，取不到就退出。
    // ⚠️ `cursor++` 在单线程事件循环里是原子的（没有 await 夹在中间），不会重复取。
    const workerCount = Math.max(1, Math.min(IMG_LINK_SCAN_CONCURRENCY, work.length));
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= work.length) return;
        await runOne(work[i]);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    this.logger.log(
      `扫描文章图片完成：文章 ${scan.scannedArticles} 篇、发现链接 ${total} 个、` +
        `实际处理 ${processed} 个、新入库 ${created} 张、失效 ${errorLinks.length} 个` +
        `${truncatedLinks ? `（链接被截断，上限 ${IMG_LINK_SCAN_MAX_LINKS}）` : ''}` +
        `${scan.truncated ? `（文章被截断，上限 ${scan.articleCap} 篇）` : ''}`,
    );

    return {
      total,
      errorLinks,
      // 以下为**追加**字段：让调用方能如实区分"扫全了"与"被截断了"
      processed,
      created,
      scannedArticles: scan.scannedArticles,
      scannedLinks: scan.scannedLinks,
      truncatedLinks,
      truncatedArticles: scan.truncated,
      linkCap: IMG_LINK_SCAN_MAX_LINKS,
      articleCap: scan.articleCap,
      concurrency: workerCount,
    };
  }

  async exportAllImg() {
    const storageSetting = await this.settingProvider.getStaticSetting();
    const storageType = storageSetting?.storageType || 'local';
    if (storageType == 'local') {
      const { success, path } = await this.localProvider.exportAllImg();
      if (success && path) {
        return path;
      } else {
        throw new HttpException({ statusCode: 500, message: '打包错误！' }, 500);
      }
    } else {
      throw new NotImplementedException('其他图床暂不支持打包导出！');
    }
  }

  /** 打包全部附件；附件只存本地，所以不受图床设置影响。 */
  async exportAllAttachments() {
    const { success, path } = await this.localProvider.exportAllAttachments();
    if (success && path) {
      return path;
    }
    throw new HttpException({ statusCode: 500, message: '打包错误！' }, 500);
  }

  async saveFile(
    fileType: string,
    fileName: string,
    buffer: Buffer,
    type: StaticType,
    sign: string,
    toRootPath?: boolean,
    extraMeta?: Record<string, any>,
  ) {
    const storageSetting = await this.settingProvider.getStaticSetting();
    let storageType = storageSetting?.storageType || 'local';
    if (type == 'customPage' || type == 'file') {
      // 自定义页面和附件都只落本地：PicGo/OSS 图床基本只接受图片。
      storageType = 'local';
    }
    if (storageType === 'local') {
      // ⚠️ 上传**总量配额**：以前只有"单文件不超过 50MB/200MB"，没有任何"磁盘还剩多少"的概念
      //    （全仓库 quota|totalBytes|diskUsage|statfs 在 static/uploadLimits 里零命中），而
      //    `post-/api/admin/img/upload`(50MB) 与 `post-/api/admin/file/upload`(200MB) 都在
      //    publicRoutes 里 ⇒ 零权限协作者可以无限次上传，一台 20GB 盘的小机器几分钟就写满。
      //    磁盘满的连锁反应比"上传失败"严重得多：mongo 的 WiredTiger 写失败、备份写流 ENOSPC、
      //    日志写不进 ⇒ 站点进入"容器 Up 但什么都写不了"的半死状态，而 restart 策略不会介入。
      //    所以在落盘之前查一次剩余空间，低于下限就拒绝并给出可照做的消息。
      //    判定抽在 `uploadLimits.ts` 的**纯函数**里（`fs.statfsSync` 在 jest 不可重定义），
      //    剩余空间读不到时**跳过而不是拒绝**（与 fullBackup 的恢复闸门同口径）。
      //    ⚠️ 图片还会派生缩略图与 webp/avif，实际占用可达 buffer 的 2–3 倍；默认下限 500MB
      //    已经把这个余量算进去了。
      const minFree = resolveUploadMinFreeBytes();
      if (minFree > 0) {
        const shortfall = uploadSpaceShortfallMessage(
          freeSpaceBytes(config.staticPath),
          buffer?.length || 0,
          minFree,
        );
        if (shortfall) {
          throw new BadRequestException(shortfall);
        }
      }
    }
    switch (storageType) {
      case 'local':
        const { realPath, meta } = await this.localProvider.saveFile(
          fileName,
          buffer,
          type,
          toRootPath,
          extraMeta,
        );
        if (type != 'customPage') {
          await this.createInDB({
            fileType: (meta as any)?.type || fileType,
            staticType: type,
            storageType: storageType,
            sign,
            name: fileName,
            realPath,
            meta,
          });
        }
        return realPath;
      case 'picgo':
        const picgoRes = await this.picgoProvider.saveFile(fileName, buffer, type);
        await this.createInDB({
          fileType: picgoRes.meta?.type || fileType,
          staticType: type,
          storageType: storageType,
          sign,
          name: fileName,
          realPath: picgoRes.realPath,
          meta: picgoRes.meta,
        });
        return picgoRes.realPath;
    }
  }
  async createInDB(dto: Partial<Static>) {
    const newModal = new this.staticModel(dto);
    return await newModal.save();
  }
  async getOneBySign(sign: string) {
    return await this.staticModel.findOne({ sign }).exec();
  }
  /**
   * 同一份内容既可能是图片也可能是附件，去重要按类型区分，
   * 否则上传附件会命中同内容的图片记录、返回 /static/img/... 的路径。
   */
  async getOneBySignAndType(sign: string, staticType: StaticType) {
    return await this.staticModel.findOne({ sign, staticType }).exec();
  }
  async getAll(type: StaticType, view: 'admin' | 'public') {
    return await this.staticModel.find({ staticType: type }, this.getView(view)).exec();
  }
  async exportAll() {
    return await this.staticModel.find({}, this.getView('public')).exec();
  }
  async getByOption(option: SearchStaticOption) {
    const query: any = {};
    if (option.staticType) {
      query.staticType = option.staticType;
    }
    const keyword = String(option.name ?? '').trim();
    if (keyword) {
      // 存的是 `<md5>.<原名>`，按子串匹配即可；转义避免用户输入变成非法正则。
      query.name = { $regex: escapeRegExp(keyword), $options: 'i' };
    }
    const paging = sanitizePagination(option.page, option.pageSize);
    // mongoose 8 删掉了 Model.count()（走 `count` 命令），换成 countDocuments()
    // （`$match + $group` 聚合）；同一个 query，计数语义不变。
    const total = await this.staticModel.countDocuments(query);
    const items = await this.staticModel
      .find(query, this.getView(option.view))
      .sort({ updatedAt: -1 })
      .limit(paging.pageSize)
      .skip(paging.skip);
    return {
      total,
      data: items,
    };
  }
  async deleteCustomPage(path: string) {
    // 以前是 path.replace('/', '')：只去掉**第一个**斜杠，也不检查 `..`，
    // 于是 `/a/../../../<目标>` 会被拼进 staticPath 再递归删除（rmSync recursive）。
    // 统一走 normalizeCustomPageRel：任何 `..` 段直接 403。
    const folderName = normalizeCustomPageRel(path);
    await this.localProvider.deleteCustomPageFolder(folderName);
  }

  async getFolderFiles(path: string) {
    return this.localProvider.getFolderFiles(path);
  }
  async getFileContent(path: string, subPath: string) {
    return this.localProvider.getFileContent(path, subPath);
  }
  async createFile(path: string, subPath: string) {
    return this.localProvider.createFile(path, subPath);
  }
  async createFolder(path: string, subPath: string) {
    return this.localProvider.createFolder(path, subPath);
  }
  async updateCustomPageFileContent(pathname: string, filePath: string, content: string) {
    return this.localProvider.updateCustomPageFileContent(pathname, filePath, content);
  }
  async deleteCustomPageFile(pathname: string, filePath: string) {
    return this.localProvider.deleteCustomPageFile(pathname, filePath);
  }

  async deleteOneBySign(sign: string, staticType?: string): Promise<DeleteResult> {
    // 先删除实际上的。
    // 1) 记录不存在（重复点删除 / 列表过期）以前会在 .storageType 上抛 TypeError → 500；
    // 2) 图片与附件可能同内容同 sign，必须按 staticType 限定，
    //    否则「删图片」会把同 sign 的附件记录一起删掉（§7.4 明确禁止串味）。
    const toDeleteData = await this.staticModel
      .findOne(staticType ? { sign, staticType } : { sign })
      .exec();
    if (!toDeleteData) {
      throw new BadRequestException('找不到该文件（可能已经被删除）');
    }
    const storageType = toDeleteData.storageType;
    switch (storageType) {
      case 'local': {
        await this.localProvider.deleteFile(toDeleteData.name, toDeleteData.staticType);
        // 缩略图跟着原图一起删，别留孤儿文件（webp 与 AVIF 兄弟都算）
        const thumb = (toDeleteData?.meta as any)?.thumb;
        if (thumb) {
          await this.localProvider.deleteStaticFile(thumb);
        }
        const thumbAvif = (toDeleteData?.meta as any)?.thumbAvif;
        if (thumbAvif) {
          await this.localProvider.deleteStaticFile(thumbAvif);
        }
        break;
      }
      case 'picgo':
        console.log('实际上只删了数据库，网盘上还有的。');
    }
    return await this.staticModel.deleteOne({ sign }).exec();
  }

  /**
   * 替换图片：新内容走同一套管线，但**写回原来的 URL**（文件名和后缀都不变），
   * 文章里已经插入的链接因此不用改。只支持本地存储。
   *
   * 磁盘上的文件名仍然带着**旧内容**的 md5 前缀 —— 这是为了保住 URL；
   * 数据库里的 sign 会更新成新内容的 md5（去重是按 sign 走的）。
   */
  async replaceBySign(
    sign: string,
    file: any,
    updateConfig?: UploadConfig,
    context?: UploadContext,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('没有收到文件！');
    }
    const item = await this.staticModel.findOne({ sign, staticType: 'img' }).exec();
    if (!item) {
      throw new BadRequestException('找不到这张图片！');
    }
    if (item.storageType && item.storageType !== 'local') {
      throw new BadRequestException('远程图床（PicGo / OSS）暂不支持替换，请删除后重新上传！');
    }
    const settings = await this.settingProvider.getStaticSetting();
    const arr = String(file.originalname || '').split('.');
    const fileType = arr.length > 1 ? arr[arr.length - 1].toLowerCase() : '';
    const targetFormat = normalizeImageFormat(item.fileType);

    const processed = await this.runImagePipeline(file.buffer, fileType, settings, {
      updateConfig,
      context,
      forceFormat: targetFormat,
    });

    const realPath = item.realPath;
    await this.localProvider.overwriteStaticFile(realPath, processed.buffer);

    // 缩略图跟着重做（同名覆盖）；关掉缩略图时把旧的删掉，别留下和内容不一致的小图
    const oldThumb = (item.meta as any)?.thumb;
    const oldThumbAvif = (item.meta as any)?.thumbAvif;
    let meta: any = { ...(item.meta as any) };
    delete meta.thumb;
    delete meta.thumbWidth;
    delete meta.thumbHeight;
    delete meta.thumbAvif;
    delete meta.thumbAvifBytes;
    if (checkTrue(settings?.enableThumb)) {
      try {
        const thumb = await generateThumbnail(
          processed.buffer,
          parseThumbWidth(settings?.thumbWidth),
          targetFormat,
        );
        if (thumb.ok) {
          const baseName = String(realPath).split('/').pop();
          const thumbPath = await this.localProvider.saveThumb(baseName, thumb.buffer, thumb.ext);
          if (oldThumb && oldThumb !== thumbPath) {
            await this.localProvider.deleteStaticFile(oldThumb);
          }
          meta = { ...meta, thumb: thumbPath, thumbWidth: thumb.width, thumbHeight: thumb.height };
        }
        // P7：替换后 AVIF 兄弟缩略图同样重做（开关关着就把旧的删掉，别留过期小图）
        const avifThumb = await generateAvifThumbIfEnabled(
          processed.buffer,
          parseThumbWidth(settings?.thumbWidth),
          targetFormat,
        );
        if (avifThumb?.ok) {
          const baseName = String(realPath).split('/').pop();
          const avifPath = await this.localProvider.saveThumb(baseName, avifThumb.buffer, avifThumb.ext);
          if (oldThumbAvif && oldThumbAvif !== avifPath) {
            await this.localProvider.deleteStaticFile(oldThumbAvif);
          }
          meta = { ...meta, thumbAvif: avifPath, thumbAvifBytes: avifThumb.buffer.length };
        } else if (oldThumbAvif) {
          await this.localProvider.deleteStaticFile(oldThumbAvif);
        }
      } catch (err) {
        this.logger.warn(`替换后生成缩略图失败：${(err as Error)?.message}`);
      }
    } else {
      if (oldThumb) {
        await this.localProvider.deleteStaticFile(oldThumb);
      }
      if (oldThumbAvif) {
        await this.localProvider.deleteStaticFile(oldThumbAvif);
      }
    }

    const sizeInfo = safeImageSize(processed.buffer, targetFormat);
    meta = { ...meta, ...sizeInfo, size: formatBytes(processed.buffer.byteLength) };

    const date = new Date();
    await this.staticModel
      .updateOne(
        { sign, staticType: 'img' },
        {
          $set: {
            sign: processed.sign,
            fileType: targetFormat || item.fileType,
            meta,
            updatedAt: date,
          },
        },
      )
      .exec();

    // sign 只是普通索引：新内容万一是库里已有的另一张图，这里只记日志不报错
    const sameSign = await this.staticModel.find({ sign: processed.sign, staticType: 'img' }).exec();
    if (sameSign.length > 1) {
      this.logger.warn(`替换后 sign 与另外 ${sameSign.length - 1} 条记录重复：${processed.sign}`);
    }

    this.logger.log(`图片已替换：${realPath}（sign ${sign} -> ${processed.sign}）`);
    return {
      realPath,
      sign: processed.sign,
      oldSign: sign,
      stego: processed.stego,
      meta,
    };
  }

  /** 批量查这些图片被哪些文章引用（列表页用；相对路径也能匹配到绝对链接）。 */
  async countReferences(realPaths: string[]) {
    return await this.articleProvder.countArticlesByLinks(realPaths);
  }

  /** 缩略图地址；没生成过就是 null（前端回退到原图）。 */
  static thumbOf(item: any): string | null {
    const thumb = item?.meta?.thumb;
    return typeof thumb === 'string' && thumb ? thumb : null;
  }

  /** P7：AVIF 兄弟缩略图的 URL（meta.thumbAvif；没有就是 null —— 前台按"可选字段"处理）。 */
  static thumbAvifOf(item: any): string | null {
    const thumb = item?.meta?.thumbAvif;
    return typeof thumb === 'string' && thumb ? thumb : null;
  }

  /**
   * 为存量图片补缩略图（新上传的会自动生成）。
   * 只处理本地存储的图片；远程图床（PicGo/OSS）没有本地文件，直接跳过。
   */
  async backfillThumbnails(options?: { force?: boolean }) {
    const setting = await this.settingProvider.getStaticSetting();
    const width = parseThumbWidth(setting?.thumbWidth);
    const all = await this.getAll('img', 'admin');
    // P7：AVIF 兄弟缩略图（VANBLOG_THUMB_AVIF，默认关）。
    // 开关刚打开时，已有 webp 缩略图的存量图片也会在下一轮补图里带上 .avif 兄弟。
    const avifEnabled = resolveThumbAvifEnabled();
    const result = {
      total: all.length,
      generated: 0,
      existed: 0,
      skipped: 0,
      failed: 0,
      avifGenerated: 0,
      width,
      avifEnabled,
    };
    for (const item of all) {
      const existing = StaticProvider.thumbOf(item);
      const existingAvif = StaticProvider.thumbAvifOf(item);
      if (existing && !options?.force && (await this.localProvider.staticFileExists(existing))) {
        // webp 缩略图已经在：只补缺失的 AVIF 兄弟（不重做 webp）
        if (avifEnabled && !existingAvif) {
          try {
            const buffer = await this.localProvider.readStaticFile(item.realPath);
            const avif = await generateThumbnailAvif(buffer, width, item.fileType);
            if (avif.ok) {
              const baseName = String(item.realPath || '').split('/').pop();
              const avifPath = await this.localProvider.saveThumb(baseName, avif.buffer, avif.ext);
              await this.staticModel
                .updateOne(
                  { sign: item.sign, staticType: 'img' },
                  {
                    $set: {
                      'meta.thumbAvif': avifPath,
                      'meta.thumbAvifBytes': avif.buffer.length,
                    },
                  },
                )
                .exec();
              result.avifGenerated += 1;
            }
          } catch {
            // AVIF 是增强项：失败不影响"webp 已存在"的结论，也不计入 failed
          }
        }
        result.existed += 1;
        continue;
      }
      if (item?.storageType && item.storageType !== 'local') {
        result.skipped += 1;
        continue;
      }
      try {
        const buffer = await this.localProvider.readStaticFile(item.realPath);
        const thumb = await generateThumbnail(buffer, width, item.fileType);
        if (!thumb.ok) {
          result.failed += 1;
          continue;
        }
        const baseName = String(item.realPath || '').split('/').pop();
        const thumbPath = await this.localProvider.saveThumb(baseName, thumb.buffer, thumb.ext);
        const set: Record<string, unknown> = {
          'meta.thumb': thumbPath,
          'meta.thumbWidth': thumb.width,
          'meta.thumbHeight': thumb.height,
        };
        if (avifEnabled) {
          const avif = await generateThumbnailAvif(buffer, width, item.fileType);
          if (avif.ok) {
            const avifPath = await this.localProvider.saveThumb(baseName, avif.buffer, avif.ext);
            set['meta.thumbAvif'] = avifPath;
            set['meta.thumbAvifBytes'] = avif.buffer.length;
            result.avifGenerated += 1;
          }
        }
        await this.staticModel
          .updateOne({ sign: item.sign, staticType: 'img' }, { $set: set })
          .exec();
        result.generated += 1;
      } catch (err) {
        result.failed += 1;
      }
    }
    this.logger.log(`补缩略图完成：${JSON.stringify(result)}`);
    return result;
  }

  /**
   * 检测隐写水印：
   * - 传 sign：读本站图床里那张（仅本地存储）；
   * - 传 buffer：直接检测上传上来的文件（后台「上传一张图验证」）。
   * magic + CRC 都对才算命中，所以不会误报。
   */
  async detectStegoWatermark(input: { sign?: string; buffer?: Buffer }) {
    let buffer = input?.buffer;
    let item: any = null;
    if (!buffer && input?.sign) {
      item = await this.staticModel.findOne({ sign: input.sign, staticType: 'img' }).exec();
      if (!item) {
        throw new BadRequestException('找不到这张图片！');
      }
      if (item.storageType && item.storageType !== 'local') {
        return {
          found: false,
          reason: 'not-local',
          name: item.name,
          realPath: item.realPath,
        };
      }
      buffer = await this.localProvider.readStaticFile(item.realPath);
    }
    if (!buffer) {
      throw new BadRequestException('没有可检测的图片！');
    }
    const key = await this.settingProvider.getStegoKey();
    const res = await extractStegoWatermark(buffer, key);
    return {
      ...res,
      name: item?.name,
      realPath: item?.realPath,
    };
  }
  async deleteAllIMG() {
    // 调试用的
    const all = await this.getAll('img', 'admin');
    for (const each of all) {
      await this.deleteOneBySign(each.sign);
    }
  }
}
