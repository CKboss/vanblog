import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { StaticType, StoragePath, THUMB_FOLDER } from 'src/types/setting.dto';
import { ATTACHMENT_FOLDER } from 'src/utils/attachment';
import { thumbNameFor } from 'src/utils/thumbnail';
import * as fs from 'fs';
import * as path from 'path';
import { config } from 'src/config';
import { fallbackTypeFromName, safeImageSize } from 'src/utils/imageMeta';
import { formatBytes } from 'src/utils/size';
import { ImgMeta } from 'src/types/img';
import { isProd } from 'src/utils/isProd';
import compressing from 'compressing';
import dayjs from 'dayjs';
import { checkOrCreate, checkOrCreateByFilePath } from 'src/utils/checkFolder';
import { rmDir } from 'src/utils/deleteFolder';
import { readDirs } from 'src/utils/readFileList';
import { checkOrCreateFile } from 'src/utils/checkFile';
import { normalizeCustomPageRel, resolveCustomPageAbs } from 'src/utils/customPagePath';
import {
  describeUnsafeNameForLog,
  resolveStoredFileAbs,
  resolveWithinStorageAbs,
} from 'src/utils/storedFileName';
@Injectable()
export class LocalProvider {
  private readonly logger = new Logger(LocalProvider.name);

  async saveFile(
    fileName: string,
    buffer: Buffer,
    type: StaticType,
    toRootPath?: boolean,
    extraMeta?: Record<string, any>,
  ) {
    if (type == 'img') {
      return await this.saveImg(fileName, buffer, type, toRootPath, extraMeta);
    } else if (type == 'file') {
      return await this.saveAttachment(fileName, buffer, type);
    } else if (type == 'customPage') {
      const storagePath = StoragePath[type];
      const realName = normalizeCustomPageRel(fileName);
      const srcPath = resolveCustomPageAbs(fileName);
      const byteLength = buffer.byteLength;
      const realPath = `/static/${storagePath}/${realName}`;
      checkOrCreateByFilePath(srcPath);
      fs.writeFileSync(srcPath, buffer);
      const meta = { size: formatBytes(byteLength) };
      return {
        meta,
        realPath,
      };
    }
  }

  async getFolderFiles(p: string) {
    const absPath = resolveCustomPageAbs(p);
    return readDirs(absPath, absPath);
  }
  async createFile(p: string, subPath: string) {
    checkOrCreateFile(resolveCustomPageAbs(p, subPath));
  }
  async createFolder(p: string, subPath: string) {
    checkOrCreate(resolveCustomPageAbs(p, subPath));
  }
  async getFileContent(p: string, subPath: string) {
    return fs.readFileSync(resolveCustomPageAbs(p, subPath), { encoding: 'utf-8' });
  }
  async updateCustomPageFileContent(pathname: string, filePath: string, content: string) {
    fs.writeFileSync(resolveCustomPageAbs(pathname, filePath), content, { encoding: 'utf-8' });
  }
  async deleteCustomPageFile(pathname: string, filePath: string) {
    const absPath = resolveCustomPageAbs(pathname, filePath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      throw new HttpException('文件不存在', HttpStatus.NOT_FOUND);
    }
    fs.rmSync(absPath);
  }

  async saveImg(
    fileName: string,
    buffer: Buffer,
    type: StaticType,
    toRootPath?: boolean,
    extraMeta?: Record<string, any>,
  ) {
    const storagePath = StoragePath[type] || StoragePath['img'];
    // ⚠️ 落盘前**证明**路径没跑出 `<static>/<storagePath>`：`resolveStoredFileAbs` 会先拒掉
    //    含分隔符 / `..` / NUL 的名字，再用 path.resolve + path.relative 做容器化校验。
    //    以前这里是裸的 `path.join(...)` + `writeFileSync`，而图片名只经过
    //    `decodeUploadFileName()`（只修 latin1→utf8，不剥分隔符）⇒ 唯一挡住路径穿越的是
    //    busboy 默认对 filename 做 basename()。那是**依赖项的默认值**，不是我们的防线：
    //    一个 `preservePath: true` 或换上传库就变成任意路径写。
    //    附件（saveAttachment）与缩略图（saveThumb）早就有这道检查，图片这条路一直没有。
    const srcPath = resolveStoredFileAbs(config.staticPath, storagePath, fileName);
    let realPath = `/static/${type}/${fileName}`;

    if (isProd()) {
      if (toRootPath) {
        realPath = `/${fileName}`;
      }
    }
    const result = safeImageSize(buffer, fallbackTypeFromName(fileName));
    const byteLength = buffer.byteLength;

    fs.writeFileSync(srcPath, buffer);
    const meta: ImgMeta = { ...result, size: formatBytes(byteLength), ...(extraMeta || {}) };
    return {
      meta,
      realPath,
    };
  }

  /**
   * 把 `/static/img/xxx.webp` 这类站内地址换成磁盘绝对路径。
   * 只接受本站静态目录里的相对地址，越界（`..`、绝对路径、外链）一律拒绝。
   */
  resolveStaticAbs(realPath: string): string {
    const raw = String(realPath || '');
    if (!raw.startsWith('/static/')) {
      throw new BadRequestException('只能处理本站 /static/ 下的文件！');
    }
    const rel = raw.slice('/static/'.length);
    if (!rel || rel.includes('\0')) {
      throw new BadRequestException('非法的静态文件路径！');
    }
    const abs = path.resolve(config.staticPath, rel);
    const root = path.resolve(config.staticPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new BadRequestException('非法的静态文件路径！');
    }
    return abs;
  }

  /** 覆盖写入已有静态文件（「替换图片」用：URL 不变，只换内容）。 */
  async overwriteStaticFile(realPath: string, buffer: Buffer) {
    const abs = this.resolveStaticAbs(realPath);
    checkOrCreateByFilePath(abs);
    fs.writeFileSync(abs, buffer);
    return realPath;
  }

  async readStaticFile(realPath: string): Promise<Buffer> {
    const abs = this.resolveStaticAbs(realPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new HttpException('文件不存在', HttpStatus.NOT_FOUND);
    }
    return fs.readFileSync(abs);
  }

  async staticFileExists(realPath: string): Promise<boolean> {
    try {
      const abs = this.resolveStaticAbs(realPath);
      return fs.existsSync(abs) && fs.statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 缩略图存到 `<static>/img/thumb/`，返回可访问的 `/static/...` 地址。
   * baseFileName 用原图落盘名（含 md5 前缀），保证一一对应、不会撞名。
   */
  async saveThumb(baseFileName: string, buffer: Buffer, ext: string): Promise<string> {
    if (!baseFileName || /[\\/]/.test(baseFileName) || baseFileName.includes('..')) {
      throw new BadRequestException('非法的缩略图文件名！');
    }
    const dir = path.join(config.staticPath, StoragePath['img'], THUMB_FOLDER);
    checkOrCreate(dir);
    const name = thumbNameFor(baseFileName, ext || '.webp');
    fs.writeFileSync(path.join(dir, name), buffer);
    return `/static/${StoragePath['img']}/${THUMB_FOLDER}/${name}`;
  }

  async deleteStaticFile(realPath: string) {
    try {
      const abs = this.resolveStaticAbs(realPath);
      if (fs.existsSync(abs)) {
        fs.rmSync(abs);
      }
    } catch (err) {
      // 以前是 console.log：只进 stdout，后台日志页里看不到，
      // 于是"图床记录删了、文件还躺在磁盘上"这种半成功状态查不出来
      this.logger.warn(
        `删除静态文件失败（${realPath}）：${(err as Error)?.message || err}`,
      );
    }
  }

  /**
   * 附件（任意文件）：原样落盘，不做压缩、不探测尺寸，只记录大小。
   * fileName 由上层 `buildStoredFileName()` 生成（`<md5>.<安全文件名>`），
   * 这里再挡一次分隔符，避免有人直接调用 provider 写出目录外。
   */
  async saveAttachment(fileName: string, buffer: Buffer, type: StaticType) {
    if (!fileName || /[\\/]/.test(fileName) || fileName.includes('..')) {
      throw new BadRequestException('非法的附件文件名！');
    }
    const storagePath = StoragePath[type] || ATTACHMENT_FOLDER;
    const dir = path.join(config.staticPath, storagePath);
    checkOrCreate(dir);
    const byteLength = buffer.byteLength;
    fs.writeFileSync(path.join(dir, fileName), buffer);
    return {
      meta: { size: formatBytes(byteLength), bytes: byteLength },
      realPath: `/static/${storagePath}/${fileName}`,
    };
  }

  async deleteCustomPageFolder(name: string) {
    const storagePath = StoragePath['customPage'];
    const srcPath = path.join(config.staticPath, storagePath, name);
    try {
      rmDir(srcPath);
    } catch (err) {
      this.logger.warn(`删除实际文件夹失败（${name}）：${(err as Error)?.message || err}`);
    }
  }

  async deleteFile(fileName: string, type: StaticType) {
    const storagePath = StoragePath[type] || StoragePath['img'];
    // ⚠️ 删除前先**证明**目标在 `<static>/<storagePath>` 里面。
    //    名字来自数据库记录，而记录可以由「导入 JSON」写入 ⇒ `../../..` 这种名字
    //    是可能真的出现在库里的；`fs.rmSync` 又是不可逆操作，所以这里既不能照删
    //    （会删到静态目录外），也不能悄悄当没事发生（要留下可查的 WARN）。
    //    用 resolveWithinStorageAbs 而不是 resolveStoredFileAbs：自定义页面的名字
    //    legitimately 是多段的（`sub/page.html`），不能一律拒分隔符。
    let srcPath: string;
    try {
      srcPath = resolveWithinStorageAbs(config.staticPath, storagePath, fileName);
    } catch (err) {
      this.logger.warn(
        `拒绝删除目录外的路径（${storagePath}）：${describeUnsafeNameForLog(fileName)} —— ` +
          `记录里的文件名非法（可能来自导入的 JSON），已跳过删除：${(err as Error)?.message || err}`,
      );
      return;
    }
    try {
      fs.rmSync(srcPath);
    } catch (err) {
      this.logger.warn(
        `删除实际文件失败（${fileName}）：${(err as Error)?.message || err}` +
          '（可能是更新版本后没映射静态文件目录导致的）',
      );
    }
  }
  async exportAllImg() {
    const src = path.join(config.staticPath, 'img');
    // 归档不能再放在 <static>/export/ 下面：静态目录是**匿名可读**的，
    // 而文件名只有日期（export-img-2026-09-12.zip），任何人都能猜出来把整个图床拖走
    // （包括只被草稿/隐藏/已删除文章引用的图）。改放 config.backupPath/export/。
    const zipName = `export-img-${dayjs().format('YYYY-MM-DD')}.zip`;
    const exportDir = path.join(config.backupPath, 'export');
    checkOrCreate(exportDir);
    const dst = path.join(exportDir, zipName);
    const dstSrc = zipName;

    const compressPromise = new Promise((resolve, reject) => {
      compressing.zip
        .compressDir(src, dst)
        .then((v) => {
          resolve(v);
        })
        .catch((e) => {
          reject(e);
        });
    });
    try {
      const r = await Promise.all([compressPromise]);
      this.logger.debug(`导出图床压缩包完成：${JSON.stringify(r)}`);
      return {
        success: true,
        path: dstSrc,
      };
    } catch (err) {
      // 以前是 console.log(err) 然后返回 success:false —— 调用方只看 success 标志，
      // 失败原因只进 stdout，后台日志页里查不到
      this.logger.error(`导出图床压缩包失败：${(err as Error)?.message || err}`);
      return {
        success: false,
        error: err,
      };
    }
  }

  /**
   * 打包全部附件（仿「导出全部图片」）。
   * ⚠️ 产物落在**备份目录**下的 export 子目录（`config.backupPath`，见下面两行），
   * **不在静态目录里**：静态目录是匿名可读的，而归档里可能是整站数据。所以静态目录下的
   * export、tmp、upload-tmp 三段都被 `utils/staticGuard` 拦成匿名 403，下载一律走鉴权接口。
   * （⚠️ 别在这条注释里把那个静态路径拼出来：admin 的 securityHardening.test.js 有一条
   * 反证断言钉着"这个文件里不许再出现它"，而它匹配的是**整份文件的文本**，注释也算。）
   */
  async exportAllAttachments() {
    const folder = ATTACHMENT_FOLDER;
    const src = path.join(config.staticPath, folder);
    checkOrCreate(src);
    const zipName = `export-${folder}-${dayjs().format('YYYY-MM-DD')}.zip`;
    // 同上：不放静态目录，下载走鉴权接口
    const exportDir = path.join(config.backupPath, 'export');
    checkOrCreate(exportDir);
    const dst = path.join(exportDir, zipName);
    const dstSrc = zipName;
    try {
      await compressing.zip.compressDir(src, dst);
      return { success: true, path: dstSrc };
    } catch (err) {
      this.logger.error(`导出全部图片失败：${(err as Error)?.message || err}`);
      return { success: false, error: err };
    }
  }
}
