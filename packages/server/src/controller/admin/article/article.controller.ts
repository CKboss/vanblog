import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Optional,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
// 🔴 期 9（服务端错误码框架）：消息的**权威中文**在 `src/utils/serverErrorCodes.ts` 的登记表里，这里只写码。
//    响应体仍是 Nest 的规范形状 + `code`（`message` 逐字不变、`error` 字段保留），
//    admin 侧**有码用码、无码回落 message** ⇒ 渐进迁移任何时刻都可用。
import { codedError } from 'src/utils/serverErrorCodes';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiHeader, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { config } from 'src/config';
import { CreateArticleDto, UpdateArticleDto } from 'src/types/article.dto';
import { SortOrder } from 'src/types/sort';
import { UploadContext } from 'src/types/upload';
import { ArticleProvider } from 'src/provider/article/article.provider';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { PipelineProvider } from 'src/provider/pipeline/pipeline.provider';
import { RevisionProvider } from 'src/provider/revision/revision.provider';
import { StaticProvider } from 'src/provider/static/static.provider';
import { ApiToken } from 'src/provider/swagger/token';
import { sanitizePagination } from 'src/utils/pagination';
import { parseNumericId } from 'src/utils/numericId';
import { carryAccessSecretFields } from 'src/utils/accessPassword';
import { checkTrue } from 'src/utils/checkTrue';
import { MDZ_IMPORT_UPLOAD_OPTIONS, importMdzBuffer } from 'src/utils/mdzImport';
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
    /** .mdz 导入（图片入库走与手动上传完全相同的管线）。两个 provider 都已在 app.module 注册。 */
    private readonly staticProvider: StaticProvider,
    private readonly metaProvider: MetaProvider,
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
    const callerDto = updateDto;
    const result = await this.pipelineProvider.dispatchEvent('beforeUpdateArticle', updateDto);
    if (result.length > 0) {
      const lastResult = result[result.length - 1];
      const lastOuput = lastResult.output;
      if (lastOuput) {
        // 流水线**看不到**密码（事件 payload 已在 PipelineProvider.runCodeByPipelineId 里
        // 脱敏：日志 / IPC / logs 集合三个出口都不带 password），所以它返回的 output 里
        // 不会有 password/clearPassword；而这里是**整体替换**。不把调用方的密码意图透传
        // 回来，"用户改了密码 + 站点上正好挂着 beforeUpdateArticle 流水线"就会静默丢掉
        // 新密码（留空 = 不修改）。只透传顶层这两个键，且不覆盖脚本自己给的值。
        updateDto = carryAccessSecretFields(callerDto, lastOuput);
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
    const callerCreateDto = createDto;
    const result = await this.pipelineProvider.dispatchEvent('beforeUpdateArticle', createDto);
    if (result.length > 0) {
      const lastResult = result[result.length - 1];
      const lastOuput = lastResult.output;
      if (lastOuput) {
        // 同 update()：脱敏后的脚本回不出 password，整体替换会把新建时填的密码丢掉
        createDto = carryAccessSecretFields(callerCreateDto, lastOuput);
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
   * 导入 `.mdz`（Typora 风格图片包：zip 里一个 `<标题>.md` + `<标题>.assets/` 图片目录，
   * 即 `POST /api/admin/export/markdown` 的产物）。**只解析、不建文章**：
   * 返回编辑器填表所需的一切（title/content/frontMatter/图片报告），是否入库由管理员
   * 在编辑器里审阅后自己保存 —— 自动建文章会让一次误传变成破坏性操作。
   *
   * 图片通过 StaticProvider.upload 入图床（魔数校验、按 (sign,'img') 内容去重、
   * 缩略图、AVIF 兄弟、webp、隐写水印，与手动上传同一管线），正文里的相对链接
   * 改写成返回的服务 URL；zip-slip / zip 炸弹 / 成员选择在**写入任何东西之前**校验。
   * front matter 白名单外的字段（尤其 password —— 导出的是 scrypt 哈希）一律丢弃，
   * 契约与理由见 `utils/mdzImport.ts`。
   */
  @Post('import-mdz')
  @UseInterceptors(FileInterceptor('file', MDZ_IMPORT_UPLOAD_OPTIONS))
  async importMdz(
    @UploadedFile() file: any,
    @Req() req: any,
    @Body() body?: { withWaterMark?: string | boolean },
  ) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    if (!file?.buffer?.length) {
      throw codedError('articleImportMdzNoFile');
    }
    // 可见水印默认**不加**：.mdz 里的图片多半就是本站导出时的成品（当年该加的水印已经加上），
    // 再盖一层会毁掉「导出→导入」的往返保真；要加可以显式传 withWaterMark=true。
    // 隐写水印不吃这个参数：它由设置页开关驱动，在 upload 管线内部照常执行。
    const withWaterMark = checkTrue(body?.withWaterMark ?? false);
    let context: UploadContext = { uploader: req?.user?.nickname || req?.user?.name || '' };
    try {
      const siteInfo = await this.metaProvider.getSiteInfo();
      context = { ...context, baseUrl: siteInfo?.baseUrl, author: siteInfo?.author };
    } catch {
      // 站点信息拿不到只影响隐写水印的载荷文本，不值得让整个导入失败
    }
    const data = await importMdzBuffer(file.buffer, async (memberName, memberBuffer) => {
      const res: any = await this.staticProvider.upload(
        { buffer: memberBuffer, originalname: memberName.split('/').pop() || 'image' },
        'img',
        false,
        undefined,
        { withWaterMark },
        context,
      );
      return { src: res?.src, isNew: res?.isNew };
    });
    // ⚠️ 日志只落计数与标题：front matter 里可能有敏感值（password 已在 util 层丢弃，
    // 这里也不把 notes/skipped 原文写进日志，避免把用户内容抄进日志文件）。
    this.logger.log(
      `导入 .mdz《${data.title}》：图片入库 ${data.importedImages} 张（其中按内容去重命中 ${data.dedupedImages} 张），跳过 ${data.skippedImages.length} 个引用`,
    );
    return { statusCode: 200, data };
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
      throw codedError('articleNotInRecycleBin');
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
      throw codedError('articlePurgeRequiresRecycleBin');
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
      throw codedError('revisionFeatureUnavailable');
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
      throw codedError('revisionFeatureUnavailable');
    }
    const revision: any = await this.revisionProvider.getOne(numericId, revisionId);
    if (!revision) {
      throw codedError('revisionNotFound');
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
      throw codedError('revisionFeatureUnavailable');
    }
    const revision: any = await this.revisionProvider.getOne(numericId, revisionId);
    if (!revision) {
      throw codedError('revisionNotFound');
    }
    const current: any = await this.articleProvider.getById(numericId, 'admin');
    if (!current) {
      throw codedError('articleNotFoundForRevision');
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
