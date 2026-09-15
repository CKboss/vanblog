import {
  HttpException,
  HttpStatus,
  NotFoundException, Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { SortOrder } from 'src/types/sort';
import { ArticleProvider } from 'src/provider/article/article.provider';
import { CategoryProvider } from 'src/provider/category/category.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { SettingProvider } from 'src/provider/setting/setting.provider';
import { TagProvider } from 'src/provider/tag/tag.provider';
import { VisitProvider } from 'src/provider/visit/visit.provider';
import { version } from 'src/utils/loadConfig';
import { CustomPageProvider } from 'src/provider/customPage/customPage.provider';
import { encode } from 'js-base64';
import { asQueryString } from 'src/utils/sanitizeRequest';
import { consumeAttempt, resetAttempts } from 'src/utils/attemptLimit';
import { scaleLimit } from 'src/utils/clusterRole';
import { pickSocketIp } from 'src/provider/log/utils';
import { getWalinePublicCommentSetting } from 'src/utils/walineExtra';
import { sanitizeArticlesPerPage } from 'src/utils/articlesPerPage';
import { sanitizePagination } from 'src/utils/pagination';
import { isInternalRequest } from 'src/utils/rateLimit';
import { readPublicMetaCache, writePublicMetaCache } from 'src/utils/publicMetaCache';

@ApiTags('public')
@Controller('/api/public/')
export class PublicController {
  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly categoryProvider: CategoryProvider,
    private readonly tagProvider: TagProvider,
    private readonly metaProvider: MetaProvider,
    private readonly visitProvider: VisitProvider,
    private readonly settingProvider: SettingProvider,
    private readonly customPageProvider: CustomPageProvider,
  ) {}
  @Get('/comment-setting')
  async getCommentSetting() {
    const waline = await this.settingProvider.getWalineSetting();
    return {
      statusCode: 200,
      data: getWalinePublicCommentSetting(waline),
    };
  }

  @Get('/customPage/all')
  async getAll() {
    return {
      statusCode: 200,
      data: await this.customPageProvider.getAll(),
    };
  }
  @Get('/customPage')
  async getOneByPath(@Query('path') path: unknown) {
    // path 来自查询串：`?path[$ne]=/x` 会被解析成对象，直接进 findOne 会 500。
    const rawPath = asQueryString(path);
    if (!rawPath) {
      throw new NotFoundException('找不到自定义页面');
    }
    const doc: any = await this.customPageProvider.getCustomPageByPath(rawPath);
    if (!doc) {
      throw new NotFoundException('找不到自定义页面');
    }
    // 不能 `{...doc}`：mongoose 文档展开后会把 `$__` / `$isNew` / `_doc` 这些内部结构
    // 一起吐给公网（实测过），只挑真正需要的字段返回。
    const data = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    return {
      statusCode: 200,
      data: {
        name: data?.name,
        path: data?.path,
        type: data?.type,
        html: data?.html ? encode(data.html) : '',
      },
    };
  }
  @Get('/article/:id')
  async getArticleByIdOrPathname(@Param('id') id: string) {
    const data = await this.articleProvider.getByIdOrPathnameWithPreNext(id, 'public');
    return {
      statusCode: 200,
      data: data,
    };
  }
  @Post('/article/:id')
  async getArticleByIdOrPathnameWithPassword(
    @Param('id') id: number | string,
    @Body() body: { password: string },
    @Req() req?: any,
  ) {
    // 加密文章的密码是明文比较，接口又完全公开：不限次数的话可以无限速爆破。
    const key = `unlock-${pickSocketIp(req)}-${String(id).slice(0, 80)}`;
    // 加密文章的密码尝试次数：计数器是每进程一份，多进程时要摊薄，
    // 否则 N 个 worker = N 倍的爆破预算
    const attempt = consumeAttempt(key, { max: scaleLimit(20), windowMs: 10 * 60 * 1000 });
    if (!attempt.allowed) {
      throw new HttpException(
        `尝试次数过多，请 ${attempt.retryAfterSeconds} 秒后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const data = await this.articleProvider.getByIdWithPassword(id, body?.password);
    if (data) {
      resetAttempts(key);
    }
    return {
      statusCode: 200,
      data: data,
    };
  }

  @Get('/search')
  async searchArticle(@Query('value') search: string) {
    const data = await this.articleProvider.searchByString(search, false);

    return {
      statusCode: 200,
      data: {
        total: data.length,
        data: this.articleProvider.toSearchResult(data),
      },
    };
  }
  @Post('/viewer')
  async addViewer(
    @Query('isNew') isNew: boolean,
    @Query('isNewByPath') isNewByPath: boolean,
    @Req() req: Request,
  ) {
    // referer 可能缺失或是畸形百分号编码，`new URL(undefined)` / `decodeURIComponent('%')`
    // 都会抛异常 → 这个未鉴权接口以前会直接 500
    const refer = req.headers.referer;
    let pathname = '';
    try {
      if (refer) {
        pathname = new URL(String(refer)).pathname || '';
      }
    } catch {
      pathname = '';
    }
    if (!pathname) {
      pathname = asQueryString((req.query as any)?.path) || '';
    }
    let decoded = pathname;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = pathname;
    }
    // 路径限长，避免匿名调用往 visits 表里塞任意长的键
    decoded = decoded.slice(0, 500);
    const data = await this.metaProvider.addViewer(isNew, decoded, isNewByPath);
    return {
      statusCode: 200,
      data: data,
    };
  }

  @Get('/viewer')
  async getViewer() {
    const data = await this.metaProvider.getViewer();
    return {
      statusCode: 200,
      data: data,
    };
  }
  @Get('/article/viewer/:id')
  async getViewerByArticleIdOrPathname(@Param('id') id: number | string) {
    const data = await this.visitProvider.getByArticleId(id);
    return {
      statusCode: 200,
      data: data,
    };
  }

  @Get('/tag/:name')
  async getArticlesByTagName(@Param('name') name: string) {
    const data = await this.tagProvider.getArticlesByTag(name, false);
    return {
      statusCode: 200,
      data: this.articleProvider.toPublic(data),
    };
  }
  @Get('article')
  async getByOption(
    @Req() req: any,
    @Query('page') page: number,
    @Query('pageSize') pageSize: number | undefined,
    @Query('toListView') toListView = false,
    @Query('regMatch') regMatch = false,
    @Query('withWordCount') withWordCount = false,
    @Query('withExcerpt') withExcerpt = false,
    @Query('category') category?: string,
    @Query('tags') tags?: string,
    @Query('sortCreatedAt') sortCreatedAt?: SortOrder,
    @Query('sortTop') sortTop?: SortOrder,
  ) {
    const defaultPageSize = await this.metaProvider.getArticlesPerPage();
    // `pageSize=-1` 会把**全部文章连正文**一次性拉走（前台静态生成需要它），
    // 但匿名访客也能调，等于一个现成的「拖库 + 打爆内存」按钮。
    // 现在只允许本站内部调用（回环直连，或带 VAN_BLOG_INTERNAL_TOKEN），
    // 其它一律夹到 MAX_PAGE_SIZE；正常翻页与分类/标签页都不受影响。
    const unlimited = isInternalRequest(req);
    const paging = sanitizePagination(page, pageSize, {
      allowUnlimited: unlimited,
      defaultPageSize,
    });
    const option = {
      page: paging.page,
      pageSize: paging.pageSize,
      category,
      tags,
      toListView,
      regMatch,
      sortTop,
      sortCreatedAt,
      withWordCount,
      // 前台首页/分页用「toListView + withExcerpt」拿摘要而不再拿全文（见 getByOption）
      withExcerpt,
    };
    // 三个 sort 是完全排他的。
    const data = await this.articleProvider.getByOption(option, true);
    return {
      statusCode: 200,
      data,
    };
  }
  @Get('timeline')
  async getTimeLineInfo() {
    const data = await this.articleProvider.getTimeLineInfo();
    return {
      statusCode: 200,
      data,
    };
  }
  @Get('category')
  async getArticlesByCategory() {
    const data = await this.categoryProvider.getCategoriesWithArticle(false);
    return {
      statusCode: 200,
      data,
    };
  }
  @Get('tag')
  async getArticlesByTag() {
    const data = await this.tagProvider.getTagsWithArticle(false);
    return {
      statusCode: 200,
      data,
    };
  }

  @Get('/meta')
  async getBuildMeta() {
    // 这个接口是全站最热的一次读（前台每个页面渲染都要调），内容却只在后台改配置时才变，
    // 所以先查进程内短缓存（默认 5 秒，见 utils/publicMetaCache.ts）。
    const cached = readPublicMetaCache();
    if (cached) {
      return cached;
    }
    // ⚠️ 这 7 个读互相独立，以前是**串行 await**（7 次 Mongo 往返排队等），
    // 高并发下延迟直接翻好几倍。改成并行后总耗时≈最慢的那一个。
    const [tags, meta, categories, menuRes, totalArticles, totalWordCount, LayoutSetting] =
      await Promise.all([
        this.tagProvider.getAllTags(false),
        this.metaProvider.getAll(),
        this.categoryProvider.getPublicCategoryNames(),
        this.settingProvider.getMenuSetting(),
        this.articleProvider.getTotalNum(false),
        this.metaProvider.getTotalWords(),
        this.settingProvider.getLayoutSetting(),
      ]);
    const metaDoc = (meta as any)?._doc || meta;
    const { data: menus } = menuRes;
    const LayoutRes = this.settingProvider.encodeLayoutSetting(LayoutSetting);
    const siteInfo = {
      ...(metaDoc?.siteInfo || {}),
      articlesPerPage: sanitizeArticlesPerPage(metaDoc?.siteInfo?.articlesPerPage),
    };
    const data = {
      version: version,
      tags,
      meta: {
        ...metaDoc,
        siteInfo,
        categories,
      },
      menus,
      totalArticles,
      totalWordCount,
      ...(LayoutSetting ? { layout: LayoutRes } : {}),
    };
    const res = {
      statusCode: 200,
      data,
    };
    writePublicMetaCache(res);
    return res;
  }
}
