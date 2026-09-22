import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
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
import {
  assertUploadedImage,
  IMAGE_UPLOAD_OPTIONS,
  MAX_STEGO_DETECT_PIXELS,
} from 'src/utils/uploadLimits';
import { consumeAttempt } from 'src/utils/attemptLimit';
import { bruteForceClientIp } from 'src/utils/trustedProxy';
import { scaleLimit } from 'src/utils/clusterRole';
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

/** 隐写检测的专用限流：10 次/分钟/IP（理由见 detectStego 里的注释）。 */
const STEGO_DETECT_LIMIT_PER_MIN = 10;
const STEGO_DETECT_WINDOW_MS = 60 * 1000;

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
  @UseInterceptors(FileInterceptor('file', IMAGE_UPLOAD_OPTIONS))
  async upload(
    @UploadedFile() file: any,
    @Query('favicon') favicon?: string,
    @Query('waterMarkText') waterMarkText?: string,
    @Query('withWaterMark') withWaterMark?: string,
    @Request() req?: any,
  ) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
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
  @UseInterceptors(FileInterceptor('file', IMAGE_UPLOAD_OPTIONS))
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
  @UseInterceptors(FileInterceptor('file', IMAGE_UPLOAD_OPTIONS))
  async detectStego(
    @UploadedFile() file: any,
    @Body() body: { sign?: string },
    @Request() request?: any,
  ) {
    // ⚠️ 专用限流：这条路由在免权限路由表的**②档**里（**勾了至少一项权限的**协作者可调，是有意为之
    //    —— 图片管理页要给协作者用），所以它只受全局桶 600/分钟/IP 保护；
    //    ⚠️ 2026-09-22 更正措辞：原文写"零权限协作者可调"，而 `AccessGuard` 拆两层之后
    //    零权限协作者**已经打不到这条**（见 `types/access/access.ts`）。🔴 **但这条限流必须保留**：
    //    有权限的协作者照样能调，而下面那个 CPU/内存代价一点没变。
    //    检测要把整图解码成 raw RGBA
    //    再逐像素比对（实测 36MP → 401ms、RSS 477MB），600 次/分钟 = 每分钟 240 秒 CPU，
    //    3 个并发就足以让 1–2GB 的容器 OOMKilled。这里压到 10 次/分钟/IP。
    //    计数用**套接字口径**的 IP（`bruteForceClientIp`，与登录/恢复那两个防爆破桶同源），
    //    因为"换个 X-Forwarded-For 就重新开始计数"正是这类桶要防的；`scaleLimit` 按 worker
    //    数摊薄（桶是进程内的，多 worker 时总量会翻倍）。
    const ip = bruteForceClientIp(request);
    const hit = consumeAttempt(`stego-detect-${ip}`, {
      max: scaleLimit(STEGO_DETECT_LIMIT_PER_MIN),
      windowMs: STEGO_DETECT_WINDOW_MS,
    });
    if (!hit.allowed) {
      // 与 rateLimit.ts 的 429 形状保持一致：带上 Retry-After，脚本不必解析中文消息
      const res = (request as any)?.res;
      if (typeof res?.setHeader === 'function') {
        res.setHeader('Retry-After', String(Math.max(1, hit.retryAfterSeconds)));
      }
      throw new HttpException(
        { statusCode: 429, message: '图片检测过于频繁，请稍后再试' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // ⚠️ 上传来的字节要先过内容校验（按内容判类型、拒 SVG），并且用**检测专用的 8MP 上限**：
    //    以前这里只有 IMAGE_UPLOAD_OPTIONS（50MB + 后缀过滤），一个 50MB 的合法图片就能让
    //    进程吃掉上 GB 内存。按 sign 检测走的是图床里已存在的文件（上传时已付过代价），
    //    所以那条路**不套 8MP**，否则"验一张自己库里的 20MP 图"会莫名失败。
    if (file?.buffer) {
      assertUploadedImage(file.buffer, file?.originalname, {
        maxPixels: MAX_STEGO_DETECT_PIXELS,
        tooLargeHint:
          `这张图太大了，没法在线检测（上限约 ${Math.round(
            MAX_STEGO_DETECT_PIXELS / 1_000_000,
          )}MP）。要验更大的图，请先把它上传到图床，然后在图片列表里用「检测水印」按 sign 验。`,
      });
    }
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
    const res = await this.staticProvider.deleteOneBySign(sign, 'img');
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
