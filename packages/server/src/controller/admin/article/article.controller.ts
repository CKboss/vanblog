import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { config } from 'src/config';
import { CreateArticleDto, UpdateArticleDto } from 'src/types/article.dto';
import { SortOrder } from 'src/types/sort';
import { ArticleProvider } from 'src/provider/article/article.provider';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { PipelineProvider } from 'src/provider/pipeline/pipeline.provider';
import { ApiToken } from 'src/provider/swagger/token';
import { sanitizePagination } from 'src/utils/pagination';
@ApiTags('article')
@ApiToken
@UseGuards(...AdminGuard)
@Controller('/api/admin/article')
export class ArticleController {
  private readonly logger = new Logger(ArticleController.name);
  constructor(
    private readonly articleProvider: ArticleProvider,
    private readonly isrProvider: ISRProvider,
    private readonly pipelineProvider: PipelineProvider,
  ) {}

  @Get('/')
  async getByOption(
    @Query('page') page: number,
    @Query('pageSize') pageSize = 5,
    @Query('toListView') toListView = false,
    @Query('regMatch') regMatch = true,
    @Query('category') category?: string,
    @Query('tags') tags?: string,
    @Query('title') title?: string,
    @Query('sortCreatedAt') sortCreatedAt?: SortOrder,
    @Query('sortTop') sortTop?: SortOrder,
    @Query('sortViewer') sortViewer?: SortOrder,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    const paging = sanitizePagination(page, pageSize, { allowUnlimited: true });
    const option = {
      page: paging.page,
      pageSize: paging.pageSize,
      category,
      tags,
      title,
      sortCreatedAt,
      sortTop,
      startTime,
      endTime,
      toListView,
      regMatch,
      sortViewer,
    };
    const data = await this.articleProvider.getByOption(option, false);
    return {
      statusCode: 200,
      data,
    };
  }

  @Get('/:id')
  async getOneByIdOrPathname(@Param('id') id: string) {
    const data = await this.articleProvider.getByIdOrPathname(id, 'admin');
    return {
      statusCode: 200,
      data,
    };
  }

  @Put('/:id')
  async update(@Param('id') id: number, @Body() updateDto: UpdateArticleDto) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改文章！',
      };
    }
    // 质量赋值防护：`deleted` 只能由删除接口设置（否则只有 article:update 权限的
    // 协作者可以 {"deleted":true} 批量软删全站，绕过 article:delete）；
    // `viewer`/`visited`/`id` 是服务端维护的计数与主键，客户端不该能改。
    delete (updateDto as any)?.deleted;
    delete (updateDto as any)?.viewer;
    delete (updateDto as any)?.visited;
    delete (updateDto as any)?.id;
    const result = await this.pipelineProvider.dispatchEvent('beforeUpdateArticle', updateDto);
    if (result.length > 0) {
      const lastResult = result[result.length - 1];
      const lastOuput = lastResult.output;
      if (lastOuput) {
        updateDto = lastOuput;
      }
    }
    const before = await this.articleProvider.getById(id, 'list');
    const data = await this.articleProvider.updateById(id, updateDto);
    this.isrProvider.activeAll('更新文章触发增量渲染！', undefined, {
      postId: id,
      previousPathname: before?.pathname,
    });
    const updatedArticle = await this.articleProvider.getById(id, 'admin');
    // 事后事件故意不 await（不该拖慢保存接口），但必须 catch：
    // `dispatchEvent` 的第一句 `getPipelinesByEvent()` 在它自己的 try **之外**，
    // 一次 DB 抖动就是一条没有来源的 unhandledRejection（`before*` 事件是 await 的，会正常 500）
    this.pipelineProvider.dispatchEvent('afterUpdateArticle', updatedArticle).catch((err) =>
      this.logger.error(
        `流水线事件 afterUpdateArticle 分发失败（文章 ${id}）：${(err as Error)?.message || err}`,
      ),
    );
    return {
      statusCode: 200,
      data,
    };
  }

  @Post()
  async create(@Req() req: any, @Body() createDto: CreateArticleDto) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止创建文章！',
      };
    }
    const author = req?.user?.nickname || undefined;
    if (!createDto.author) {
      createDto.author = author;
    }
    const result = await this.pipelineProvider.dispatchEvent('beforeUpdateArticle', createDto);
    if (result.length > 0) {
      const lastResult = result[result.length - 1];
      const lastOuput = lastResult.output;
      if (lastOuput) {
        createDto = lastOuput;
      }
    }
    const data = await this.articleProvider.create(createDto);
    this.isrProvider.activeAll('创建文章触发增量渲染！', undefined, {
      postId: data.id,
    });
    this.pipelineProvider.dispatchEvent('afterUpdateArticle', data).catch((err) =>
      this.logger.error(
        `流水线事件 afterUpdateArticle 分发失败（新建文章 ${data?.id}）：${
          (err as Error)?.message || err
        }`,
      ),
    );
    return {
      statusCode: 200,
      data,
    };
  }
  @Post('searchByLink')
  async searchArtcilesByLink(@Body() searchDto: { link: string }) {
    const data = await this.articleProvider.searchArticlesByLink(searchDto?.link || '');
    return {
      statusCode: 200,
      data,
    };
  }

  /**
   * 给历史上没有路径别名的文章批量补上标题拼音，链接从 `/post/<id>` 变成
   * `/post/<pinyin-slug>`。只填空值，不会覆盖已有别名，因此可以重复执行；
   * 旧的 `/post/<id>` 依旧能访问（getByIdOrPathname 会回退到数字 id）。
   * `dryRun: true` 时只返回将要发生的改动，不写库。
   */
  /**
   * 从正文首图批量回填封面。默认 dryRun=false 会真的写库，所以后台会先自己发一次
   * dryRun=true 拿预览；演示站禁止。
   */
  @Post('covers/from-content')
  async backfillCoversFromContent(
    @Body() body: { dryRun?: boolean; onlyMissing?: boolean; ids?: number[] },
  ) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const data = await this.articleProvider.backfillCoversFromContent({
      dryRun: body?.dryRun === true,
      onlyMissing: body?.onlyMissing !== false,
      ids: Array.isArray(body?.ids) ? body.ids : undefined,
    });
    // 封面变了要触发增量渲染，否则前台得等下一次 ISR 才看得到（用户会以为没生效）
    if (!data.dryRun && data.changed > 0) {
      this.isrProvider.activeAll(`回填封面 ${data.changed} 篇，触发增量渲染`);
    }
    return { statusCode: 200, data };
  }

  /** 撤销一次回填：把 cover 写回之前记录的旧值 */
  @Post('covers/revert')
  async revertCovers(@Body() body: { items?: Array<{ id: number; cover: string }> }) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const data = await this.articleProvider.revertCovers(Array.isArray(body?.items) ? body.items : []);
    if (data.reverted > 0) {
      this.isrProvider.activeAll(`撤销封面回填 ${data.reverted} 篇，触发增量渲染`);
    }
    return { statusCode: 200, data };
  }

  @Post('backfill-pathname')
  async backfillPathname(@Body() body: { dryRun?: boolean | string }) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改文章！' };
    }
    const dryRun = body?.dryRun === true || body?.dryRun === 'true';
    const data = await this.articleProvider.backfillPathname({ dryRun });
    if (!dryRun && data.updated > 0) {
      this.isrProvider.activeAll('回填文章路径别名触发增量渲染！');
    }
    return {
      statusCode: 200,
      data,
    };
  }
  @Delete('/:id')
  async delete(@Param('id') id: number) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止删除文章！' };
    }
    const toDeleteArticle = await this.articleProvider.getById(id, 'admin');
    this.pipelineProvider.dispatchEvent('deleteArticle', toDeleteArticle).catch((err) =>
      this.logger.error(
        `流水线事件 deleteArticle 分发失败（文章 ${id}）：${(err as Error)?.message || err}`,
      ),
    );

    const data = await this.articleProvider.deleteById(id);
    this.isrProvider.activeAll('删除文章触发增量渲染！', undefined, {
      postId: id,
      previousPathname: toDeleteArticle?.pathname,
    });
    return {
      statusCode: 200,
      data,
    };
  }
}
