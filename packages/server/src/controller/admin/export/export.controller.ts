import { Body, Controller, Logger, Post, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AdminGuard } from 'src/provider/auth/auth.guard';
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
}
