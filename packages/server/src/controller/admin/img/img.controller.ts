import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { SearchStaticOption } from 'src/types/setting.dto';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { StaticProvider } from 'src/provider/static/static.provider';
import { ArticleProvider } from 'src/provider/article/article.provider';
import { DraftProvider } from 'src/provider/draft/draft.provider';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { config } from 'src/config';
import { checkTrue } from 'src/utils/checkTrue';
import { ApiToken } from 'src/provider/swagger/token';
import { sanitizePagination } from 'src/utils/pagination';

@ApiTags('img')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/img')
export class ImgController {
  constructor(
    private readonly staticProvider: StaticProvider,
    private readonly articleProvider: ArticleProvider,
    private readonly draftProvider: DraftProvider,
    private readonly isrProvider: ISRProvider,
    private readonly metaProvider: MetaProvider,
  ) {}
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: any,
    @Query('favicon') favicon?: string,
    @Query('waterMarkText') waterMarkText?: string,
    @Query('withWaterMark') withWaterMark?: string,
    @Request() req?: any,
  ) {
    let isFavicon = false;
    if (favicon && favicon == 'true') {
      isFavicon = true;
    }
    // 只有这里开启水印，并且设置里也开启水印，才能触发水印，双保险。避免后台某些表单上传图片也触发了水印。
    const updateConfig = {
      withWaterMark: checkTrue(withWaterMark),
      waterMarkText,
    };
    // 隐写水印默认写「域名|上传者|时间」，这两样只有控制器里拿得到。
    const siteInfo = await this.metaProvider.getSiteInfo();
    const context = {
      uploader: req?.user?.nickname || req?.user?.name || '',
      baseUrl: siteInfo?.baseUrl,
      author: siteInfo?.author,
    };
    const res = await this.staticProvider.upload(
      file,
      'img',
      isFavicon,
      undefined,
      updateConfig,
      context,
    );
    return {
      statusCode: 200,
      data: res,
    };
  }

  /**
   * 为存量图片补缩略图（新上传的会自动生成）。只处理本地存储的图片。
   */
  @Post('thumb/backfill')
  async backfillThumbnails(@Body() body: { force?: boolean }) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const res = await this.staticProvider.backfillThumbnails({ force: checkTrue(body?.force) });
    return {
      statusCode: 200,
      data: res,
    };
  }

  /**
   * 批量查这批图片各被哪些文章引用（列表视图的「引用文章」列）。
   * 传相对路径即可，正文里写绝对 URL 的也能命中。
   */
  @Post('references')
  async references(@Body() body: { links?: string[] }) {
    const links = Array.isArray(body?.links) ? body.links : [];
    const res = await this.staticProvider.countReferences(links);
    return {
      statusCode: 200,
      data: res,
    };
  }

  /**
   * 替换图片：新内容走完整管线（缩放 / 隐写 / 压缩），但写回**原来的 URL**，
   * 文章里已插入的链接不用改。仅本地存储，需要 img:replace 权限。
   */
  @Post(':sign/replace')
  @UseInterceptors(FileInterceptor('file'))
  async replace(
    @Param('sign') sign: string,
    @UploadedFile() file: any,
    @Query('withWaterMark') withWaterMark?: string,
    @Query('waterMarkText') waterMarkText?: string,
    @Request() req?: any,
  ) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const siteInfo = await this.metaProvider.getSiteInfo();
    const res = await this.staticProvider.replaceBySign(
      sign,
      file,
      { withWaterMark: checkTrue(withWaterMark), waterMarkText },
      {
        uploader: req?.user?.nickname || req?.user?.name || '',
        baseUrl: siteInfo?.baseUrl,
        author: siteInfo?.author,
      },
    );
    return {
      statusCode: 200,
      data: res,
    };
  }

  /**
   * 检测隐写水印：body 里给 sign 就查图床里那张，或者直接上传一张图来验。
   * 只读操作，不写任何文件。
   */
  @Post('stego/detect')
  @UseInterceptors(FileInterceptor('file'))
  async detectStego(
    @UploadedFile() file: any,
    @Body() body: { sign?: string },
  ) {
    const res = await this.staticProvider.detectStegoWatermark({
      sign: body?.sign,
      buffer: file?.buffer,
    });
    return {
      statusCode: 200,
      data: res,
    };
  }

  @Get('all')
  async getAll() {
    const res = await this.staticProvider.getAll('img', 'public');
    return {
      statusCode: 200,
      data: res,
    };
  }

  @Post('scan')
  async scanImgsOfArticles() {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const res = await this.staticProvider.scanLinksOfArticles();
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Post('transfer-remote')
  async transferRemote(@Body() body: { content?: string; siteHost?: string }) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const siteInfo = await this.metaProvider.getSiteInfo();
    const res = await this.staticProvider.transferRemoteImages(body?.content || '', {
      siteBaseUrl: siteInfo?.baseUrl,
      siteHosts: body?.siteHost ? [body.siteHost] : [],
    });
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Post('rewrite-base-url')
  async rewriteBaseUrl(@Body() body: { oldBase?: string; newBase?: string }) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const articles = await this.articleProvider.rewriteBaseUrl(body?.oldBase, body?.newBase);
    const drafts = await this.draftProvider.rewriteBaseUrl(body?.oldBase, body?.newBase);
    if (articles.updated > 0) {
      this.isrProvider.activeAll('域名改写触发增量渲染！');
    }
    return {
      statusCode: 200,
      data: {
        articlesUpdated: articles.updated,
        draftsUpdated: drafts.updated,
        replacements: articles.replacements + drafts.replacements,
      },
    };
  }
  @Post('export')
  async exportAllImgs() {
    const res = await this.staticProvider.exportAllImg();
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Delete('/all/delete')
  async deleteALL() {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const res = await this.staticProvider.deleteAllIMG();
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Delete('/:sign')
  async delete(@Param('sign') sign: string) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const res = await this.staticProvider.deleteOneBySign(sign);
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Get('')
  async getByOption(@Query('page') page: number, @Query('pageSize') pageSize = 5) {
    const paging = sanitizePagination(page, pageSize);
    const option: SearchStaticOption = {
      page: paging.page,
      pageSize: paging.pageSize,
      staticType: 'img',
      view: 'public',
    };
    const data = await this.staticProvider.getByOption(option);
    return {
      statusCode: 200,
      data,
    };
  }
}
