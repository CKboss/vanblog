import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Optional,
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
import { RevisionProvider } from 'src/provider/revision/revision.provider';
import { ApiToken } from 'src/provider/swagger/token';
import { sanitizePagination } from 'src/utils/pagination';
import { parseNumericId } from 'src/utils/numericId';
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
    /** 历史版本（P4）。@Optional：模块未注册的过渡期里接口回 404 语义，其余路由不受影响。 */
    @Optional() private readonly revisionProvider?: RevisionProvider,
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

  /**
   * 回收站列表（P3）：软删文章，按最近删除排序。
   * ⚠️ 必须声明在 `@Get('/:id')` **之前**：否则 'deleted' 会被当成 id 参数匹配走。
   * 投影不含 content/password（见 ArticleProvider.deletedListView）。
   */
  @Get('deleted')
  async getDeleted(@Query('page') page?: number, @Query('pageSize') pageSize?: number) {
    const data = await this.articleProvider.getDeleted(page, pageSize);
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
    // 同理：deletedAt 只由删除/恢复接口维护（P3），wordCount 是服务端算的存储副本（P6），
    // 客户端塞值会污染回收站排序与 readingMinutes
    delete (updateDto as any)?.deletedAt;
    delete (updateDto as any)?.wordCount;
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

  // ---------------------------------------------------------------------------
  // 回收站（P3）：恢复 / 彻底删除。
  // 权限：restore 走 article:update、purge 走 article:delete（见 types/access/access.ts；
  // purge 与既有软删同一权限档，任务要求）。
  // ---------------------------------------------------------------------------

  /** 从回收站恢复：撤销软删，并把删除路径做过的副作用对称地做回来（字数缓存、ISR、事后事件）。 */
  @Put('/:id/restore')
  async restore(@Param('id') id: number) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改文章！' };
    }
    const restored: any = await this.articleProvider.restoreById(id);
    if (!restored) {
      throw new NotFoundException('回收站里没有这篇文章（可能已恢复或已彻底删除）');
    }
    // 与删除对称：删除时发过 deleteArticle 事件、重算过总字数、触发过 ISR，
    // 恢复同样要让流水线/缓存/静态页知道"这篇文章回来了"。
    this.pipelineProvider.dispatchEvent('afterUpdateArticle', restored).catch((err) =>
      this.logger.error(
        `流水线事件 afterUpdateArticle 分发失败（恢复文章 ${restored?.id}）：${
          (err as Error)?.message || err
        }`,
      ),
    );
    this.isrProvider.activeAll('恢复文章触发增量渲染！', undefined, {
      postId: restored.id,
      previousPathname: restored.pathname,
    });
    return {
      statusCode: 200,
      data: restored,
    };
  }

  /**
   * 彻底删除（硬删）：**只对回收站里的文章生效**（先 DELETE /:id 软删，再 purge）。
   * 这是全站唯一的文章硬删除入口；连带清理历史版本（见 ArticleProvider.purgeById）。
   */
  @Delete('/:id/purge')
  async purge(@Param('id') id: number) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止删除文章！' };
    }
    // 先取软删文档（普通 getById 过滤 deleted，这里要反过来）：purge 之后文档就没了，
    // ISR 需要它的 pathname 去失效 /post/<pathname> 与 /post/<id> 两条路径。
    const target: any = await this.articleProvider.findDeletedById(id, 'list');
    if (!target) {
      throw new NotFoundException('只能彻底删除回收站里的文章（请先移入回收站）');
    }
    const data = await this.articleProvider.purgeById(id);
    this.isrProvider.activeAll('彻底删除文章触发增量渲染！', undefined, {
      postId: target.id,
      previousPathname: target.pathname,
    });
    return {
      statusCode: 200,
      data,
    };
  }

  // ---------------------------------------------------------------------------
  // 历史版本（P4，极简）：列表（元数据）/ 单条（含正文）/ 恢复。
  // 快照本身由 ArticleProvider.updateById 在"保存真的改了 title/content"时自动写。
  // ---------------------------------------------------------------------------

  /** 某篇文章的历史版本列表（**不含 content**）。`enabled=false` 表示功能被 env 关闭（KEEP=0）。 */
  @Get('/:id/revisions')
  async listRevisions(
    @Param('id') id: number,
    @Query('page') page?: number,
    @Query('pageSize') pageSize?: number,
  ) {
    const numericId = parseNumericId(id);
    if (!this.revisionProvider) {
      throw new NotFoundException('历史版本功能不可用（RevisionProvider 未注册）');
    }
    const data = await this.revisionProvider.listMeta(numericId, page, pageSize);
    return {
      statusCode: 200,
      data: { ...data, enabled: this.revisionProvider.enabled() },
    };
  }

  /** 单条历史版本（含 content）。revisionId 不属于这篇文章时按 404 处理（防跨文章越权读）。 */
  @Get('/:id/revisions/:revisionId')
  async getRevision(@Param('id') id: number, @Param('revisionId') revisionId: string) {
    const numericId = parseNumericId(id);
    if (!this.revisionProvider) {
      throw new NotFoundException('历史版本功能不可用（RevisionProvider 未注册）');
    }
    const revision: any = await this.revisionProvider.getOne(numericId, revisionId);
    if (!revision) {
      throw new NotFoundException('找不到这条历史版本（或它不属于这篇文章）');
    }
    const doc = typeof revision.toObject === 'function' ? revision.toObject() : revision;
    return {
      statusCode: 200,
      data: {
        _id: String(doc._id),
        articleId: Number(doc.articleId),
        savedAt: doc.savedAt,
        title: doc.title,
        content: doc.content,
        wordCount: doc.wordCount,
        sizeBytes: doc.sizeBytes,
        reason: doc.reason,
      },
    };
  }

  /**
   * 恢复到某条历史版本。恢复本身**可撤销**：先把"恢复前的当前状态"记一条
   * reason='pre-restore' 的快照，再写回历史版本的 title/content，
   * 副作用与保存接口一致（字数缓存、ISR、afterUpdateArticle 事件）。
   */
  @Put('/:id/revisions/:revisionId/restore')
  async restoreRevision(
    @Param('id') id: number,
    @Param('revisionId') revisionId: string,
  ) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改文章！' };
    }
    const numericId = parseNumericId(id);
    if (!this.revisionProvider) {
      throw new NotFoundException('历史版本功能不可用（RevisionProvider 未注册）');
    }
    const revision: any = await this.revisionProvider.getOne(numericId, revisionId);
    if (!revision) {
      throw new NotFoundException('找不到这条历史版本（或它不属于这篇文章）');
    }
    const current: any = await this.articleProvider.getById(numericId, 'admin');
    if (!current) {
      throw new NotFoundException('找不到文章（回收站里的文章请先恢复再还原历史版本）');
    }
    // 1) 先给"恢复前的当前状态"拍快照（appendIfChanged：与目标一致时不会白记一条）
    const snapshot = await this.revisionProvider.appendSafe(
      numericId,
      { title: current.title, content: current.content },
      { title: revision.title, content: revision.content },
      'pre-restore',
    );
    // 2) 写回历史版本（skipRevision：快照上一步已经记过，别让 updateById 再记一条重复的）
    await this.articleProvider.updateById(
      numericId,
      { title: revision.title, content: revision.content },
      false,
      { skipRevision: true },
    );
    // 3) 与保存接口相同的对外副作用
    const updated = await this.articleProvider.getById(numericId, 'admin');
    this.isrProvider.activeAll('恢复历史版本触发增量渲染！', undefined, {
      postId: numericId,
      previousPathname: updated?.pathname,
    });
    this.pipelineProvider.dispatchEvent('afterUpdateArticle', updated).catch((err) =>
      this.logger.error(
        `流水线事件 afterUpdateArticle 分发失败（恢复历史版本，文章 ${numericId}）：${
          (err as Error)?.message || err
        }`,
      ),
    );
    return {
      statusCode: 200,
      data: {
        restored: true,
        articleId: numericId,
        revisionId: String(revision._id),
        snapshotRevisionId: snapshot ? String((snapshot as any)._id) : null,
      },
    };
  }
}
