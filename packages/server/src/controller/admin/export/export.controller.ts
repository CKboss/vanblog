import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { config } from 'src/config';
import { ApiToken } from 'src/provider/swagger/token';
import { MarkdownExportProvider } from 'src/provider/export/markdownExport.provider';

/**
 * 文章 / 草稿导出。
 *
 * `format`（可选，默认 `zip` = 一直以来的行为）决定回来的是哪一个文件：
 * - `zip`：外层 zip，里面是 `<标题>.md`（原样）+ `<标题>.mdz`（有图片时才有）+ `导出说明.md`（有跳过/失败时才有）
 * - `md`：**只要那一份原样 md**（图片链接仍指向站点）。⚠️ 服务端此时**完全不抓图**，
 *   所以既快也不碰外链（少一分 SSRF 面）
 * - `mdz`：只要 Typora 风格的图片包（相对路径 md + `<标题>.assets/`）。
 *   正文里没有可打包的图片时回 **400** 并说清原因 —— 静默改发 md 会让人以为拿到了图片包
 *
 * 三种格式都带 `X-Export-Report` 头（前端据此告诉用户识别到几个图片引用、打了几张、
 * 跳过/失败几个），也都在发完之后删掉临时目录。
 */
@ApiTags('export')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/export')
export class ExportController {
  private readonly logger = new Logger(ExportController.name);

  constructor(private readonly markdownExportProvider: MarkdownExportProvider) {}

  @Post('markdown')
  async exportMarkdown(
    @Body()
    body: {
      id?: number | string;
      type?: string;
      title?: string;
      content?: string;
      format?: string;
    },
    @Res() res: Response,
  ) {
    const type = body?.type === 'draft' ? 'draft' : body?.type === 'raw' ? 'raw' : 'article';
    const id = body?.id;
    // ⚠️ 未知格式**明确报错**，不要"顺手回落到 zip"：调用方写错字段名时，
    // 静默给一个压缩包比给一句 400 难查得多（前端还会按错的格式命名文件）。
    const rawFormat = body?.format;
    const format: 'zip' | 'md' | 'mdz' =
      rawFormat === undefined || rawFormat === null || rawFormat === ''
        ? 'zip'
        : rawFormat === 'md' || rawFormat === 'mdz' || rawFormat === 'zip'
          ? rawFormat
          : null as any;
    if (rawFormat !== undefined && rawFormat !== null && rawFormat !== '' && !format) {
      res.status(400).json({
        statusCode: 400,
        message: `不支持的导出格式：${String(rawFormat).slice(0, 40)}（只支持 md / mdz / zip）`,
      });
      return;
    }
    // raw 模式（编辑器未保存内容 / 关于页）不需要 id，但必须有正文
    if (type === 'raw') {
      if (typeof body?.content !== 'string') {
        res.status(400).json({ statusCode: 400, message: '缺少要导出的正文内容！' });
        return;
      }
    } else if (id === undefined || id === null || id === '') {
      res.status(400).json({ statusCode: 400, message: '缺少文章 id！' });
      return;
    }
    const built = await this.markdownExportProvider.build({
      id,
      type,
      title: body?.title,
      content: body?.content,
      format,
    });

    const { report } = built;
    // 前端读这个头就能告诉用户「打了几张图、几张外链没抓到」，不用再解包
    res.setHeader(
      'X-Export-Report',
      encodeURIComponent(
        JSON.stringify({
          title: report.title,
          type: report.type,
          imageRefs: report.imageRefs,
          packedImages: report.packedImages,
          localImages: report.localImages,
          remoteImages: report.remoteImages,
          skipped: report.skipped.length,
          failed: report.failed.length,
          failedUrls: report.failed.slice(0, 5).map((item) => item.url),
          hasMdz: report.hasMdz,
          // 前端靠它区分"这个格式本来就不含图片"与"想打包但失败了"
          assetsPacked: report.assetsPacked,
          format,
          entries: report.entries,
        }),
      ),
    );
    // 走 umi 代理/跨域时前端才读得到自定义头
    res.setHeader('Access-Control-Expose-Headers', 'X-Export-Report, Content-Disposition');

    // mdz 但正文里没有可打包的图片：说清楚，而不是静默改发 md
    if (format === 'mdz' && !built.mdzPath) {
      res.status(400).json({
        statusCode: 400,
        message:
          '这篇内容里没有可打包的图片，.mdz 与 .md 完全等价 —— 请改选 Markdown (.md)。',
      });
      fs.rmSync(built.tmpDir, { recursive: true, force: true });
      return;
    }

    const target =
      format === 'md' ? built.mdPath : format === 'mdz' ? built.mdzPath : built.zipPath;
    if (!target) {
      // 理论上到不了这里；真到了也不要留垃圾
      res.status(500).json({ statusCode: 500, message: '导出产物生成失败' });
      fs.rmSync(built.tmpDir, { recursive: true, force: true });
      return;
    }
    if (format === 'md') {
      // .md 用文本类型：浏览器能预览，命令行 curl 下来也不会被当成二进制
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    }

    res.download(target, built.fileName, (err) => {
      if (err) {
        this.logger.error(`导出下载失败（format=${format}）：${err?.message}`);
      }
      // 临时目录发完就删，别留在 /tmp 里（三种格式都要删）
      fs.rmSync(built.tmpDir, { recursive: true, force: true });
    });
  }

  /**
   * 下载「导出全部图片 / 导出全部附件」打出来的归档。
   *
   * 归档现在存在 `config.backupPath/export/`（静态目录之外），必须走这个鉴权接口：
   * 以前放在 `<static>/export/` 下，文件名只有日期，任何人都能匿名把整个图床和
   * 全部附件拖走（包括只被草稿/隐藏/已删除文章引用的文件）。
   */
  @Get('archive')
  async downloadArchive(@Query('name') name: string, @Res() res: Response) {
    const base = String(name || '').trim();
    if (!base || base !== path.basename(base) || !base.startsWith('export-')) {
      throw new BadRequestException('非法的归档名');
    }
    const dir = path.resolve(config.backupPath, 'export');
    const target = path.resolve(dir, base);
    if (!target.startsWith(dir + path.sep) || !fs.existsSync(target)) {
      throw new NotFoundException('归档不存在（可能已被清理，请重新导出）');
    }
    res.download(target, base, () => {
      // 下载完就删：这些归档里可能有只被隐藏文章引用的图片，不该长期留在磁盘上
      fs.rmSync(target, { force: true });
    });
  }
}
