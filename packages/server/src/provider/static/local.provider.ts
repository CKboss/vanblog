import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
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
@Injectable()
export class LocalProvider {
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
    const srcPath = path.join(config.staticPath, storagePath, fileName);
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
      console.log('删除静态文件失败：', realPath);
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
      console.log('删除实际文件夹失败：', name);
    }
  }

  async deleteFile(fileName: string, type: StaticType) {
    try {
      const storagePath = StoragePath[type] || StoragePath['img'];
      const srcPath = path.join(config.staticPath, storagePath, fileName);
      fs.rmSync(srcPath);
    } catch (err) {
      console.log('删除实际文件失败：', fileName, '可能是更新版本后没映射静态文件目录导致的');
    }
  }
  async exportAllImg() {
    const src = path.join(config.staticPath, 'img');
    const dst = path.join(
      config.staticPath,
      'export',
      `export-img-${dayjs().format('YYYY-MM-DD')}.zip`,
    );
    const dstSrc = `/static/export/export-img-${dayjs().format('YYYY-MM-DD')}.zip`;

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
      console.log(r);
      return {
        success: true,
        path: dstSrc,
      };
    } catch (err) {
      console.log(err);
      return {
        success: false,
        error: err,
      };
    }
  }

  /** 打包全部附件（仿「导出全部图片」），产物放在 /static/export/ 下。 */
  async exportAllAttachments() {
    const folder = ATTACHMENT_FOLDER;
    const src = path.join(config.staticPath, folder);
    checkOrCreate(src);
    const zipName = `export-${folder}-${dayjs().format('YYYY-MM-DD')}.zip`;
    const dst = path.join(config.staticPath, 'export', zipName);
    checkOrCreateByFilePath(dst);
    const dstSrc = `/static/export/${zipName}`;
    try {
      await compressing.zip.compressDir(src, dst);
      return { success: true, path: dstSrc };
    } catch (err) {
      console.log(err);
      return { success: false, error: err };
    }
  }
}
