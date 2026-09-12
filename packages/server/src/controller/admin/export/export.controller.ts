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
 * 产物是一个 zip，里面：
 * - `<标题>.md`   原样导出（图片链接仍指向站点）
 * - `<标题>.mdz`  有图片时才有：zip 包 = 链接改成相对路径的 md + `<标题>.assets/` 图片目录
 * - `导出说明.md` 有跳过 / 抓取失败的图片时才有
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
    @Body() body: { id?: number | string; type?: string; title?: string; content?: string },
    @Res() res: Response,
  ) {
    const type = body?.type === 'draft' ? 'draft' : body?.type === 'raw' ? 'raw' : 'article';
    const id = body?.id;
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
          entries: report.entries,
        }),
      ),
    );
    // 走 umi 代理/跨域时前端才读得到自定义头
    res.setHeader('Access-Control-Expose-Headers', 'X-Export-Report, Content-Disposition');

    res.download(built.zipPath, built.fileName, (err) => {
      if (err) {
        this.logger.error(`导出下载失败：${err?.message}`);
      }
      // 临时目录（含 .mdz 与外层 zip）发完就删，别留在 /tmp 里
      fs.rmSync(path.dirname(built.zipPath), { recursive: true, force: true });
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
