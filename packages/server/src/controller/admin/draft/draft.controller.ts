import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
// 🔴 期 9（服务端错误码框架）：消息的**权威中文**在 `src/utils/serverErrorCodes.ts` 的登记表里，这里只写码。
//    响应体仍是 Nest 的规范形状 + `code`（`message` 逐字不变、`error` 字段保留），
//    admin 侧**有码用码、无码回落 message** ⇒ 渐进迁移任何时刻都可用。
import { codedError } from 'src/utils/serverErrorCodes';
import { ApiTags } from '@nestjs/swagger';
import { CreateDraftDto, PublishDraftDto, UpdateDraftDto } from 'src/types/draft.dto';
import { SortOrder } from 'src/types/sort';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { DraftProvider } from 'src/provider/draft/draft.provider';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { config } from 'src/config';
import { PipelineProvider } from 'src/provider/pipeline/pipeline.provider';
import { ApiToken } from 'src/provider/swagger/token';
import { sanitizePagination } from 'src/utils/pagination';
import { carryAccessSecretFields } from 'src/utils/accessPassword';

@ApiTags('draft')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/draft')
export class DraftController {
  constructor(
    private readonly draftProvider: DraftProvider,
    private readonly isrProvider: ISRProvider,
    private readonly pipelineProvider: PipelineProvider,
  ) {}

  @Get('/')
  async getByOption(
    @Query('page') page: number,
    @Query('pageSize') pageSize = 5,
    @Query('toListView') toListView = false,
    @Query('category') category?: string,
    @Query('tags') tags?: string,
    @Query('title') title?: string,
    @Query('sortCreatedAt') sortCreatedAt?: SortOrder,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    const paging = sanitizePagination(page, pageSize);
    const option = {
      page: paging.page,
      pageSize: paging.pageSize,
      category,
      tags,
      title,
      sortCreatedAt,
      startTime,
      endTime,
      toListView,
    };
    const data = await this.draftProvider.getByOption(option);
    return {
      statusCode: 200,
      data,
    };
  }

  /**
   * 回收站列表（P3）：软删草稿，按最近删除排序，投影不含 content。
   * ⚠️ 必须声明在 `@Get('/:id')` **之前**：Nest 按声明顺序匹配路由，
   * 否则 'deleted' 会被当成 :id 参数（parseNumericId 直接 400）。
   * ⚠️ 注意：发布草稿会软删它（既有语义），所以这里也会列出"已发布"的草稿，
   * 恢复这样的草稿只是把草稿副本拿回来，不影响已发布的文章。
   */
  @Get('deleted')
  async getDeleted(@Query('page') page?: number, @Query('pageSize') pageSize?: number) {
    const data = await this.draftProvider.getDeleted(page, pageSize);
    return {
      statusCode: 200,
      data,
    };
  }

  @Get('/:id')
  async getOne(@Param('id') id: number) {
    const data = await this.draftProvider.findById(id);
    return {
      statusCode: 200,
      data,
    };
  }

  @Put('/:id')
  async update(@Param('id') id: number, @Body() updateDto: UpdateDraftDto) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    // 同文章接口：deleted 只能由删除接口设置，id 是服务端主键；deletedAt 同 deleted（P3）
    delete (updateDto as any)?.deleted;
    delete (updateDto as any)?.id;
    delete (updateDto as any)?.deletedAt;
    const result = await this.pipelineProvider.dispatchEvent('beforeUpdateDraft', updateDto);
    if (result.length > 0) {
      const lastResult = result[result.length - 1];
      const lastOuput = lastResult.output;
      if (lastOuput) {
        updateDto = lastOuput;
      }
    }
    const data = await this.draftProvider.updateById(id, updateDto);
    const updated = await this.draftProvider.findById(id);
    this.pipelineProvider.dispatchEvent('afterUpdateDraft', updated);
    return {
      statusCode: 200,
      data,
    };
  }

  @Post()
  async create(@Req() req: any, @Body() createDto: CreateDraftDto) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const author = req?.user?.nickname || undefined;
    if (!createDto.author) {
      createDto.author = author;
    }
    const result = await this.pipelineProvider.dispatchEvent('beforeUpdateDraft', createDto);
    if (result.length > 0) {
      const lastResult = result[result.length - 1];
      const lastOuput = lastResult.output;
      if (lastOuput) {
        createDto = lastOuput;
      }
    }
    const data = await this.draftProvider.create(createDto);
    this.pipelineProvider.dispatchEvent('afterUpdateDraft', data);
    return {
      statusCode: 200,
      data,
    };
  }
  @Post('/publish')
  async publish(@Query('id') id: number, @Body() publishDto: PublishDraftDto) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止发布草稿！',
      };
    }
    const callerPublishDto = publishDto;
    const result = await this.pipelineProvider.dispatchEvent('beforeUpdateArticle', publishDto);
    if (result.length > 0) {
      const lastResult = result[result.length - 1];
      const lastOuput = lastResult.output;
      if (lastOuput) {
        // 与 ArticleController 同一条规矩：事件 payload 已脱敏（脚本看不到 password），
        // 整体替换会丢掉用户在「发布草稿」弹窗里填的密码，所以把顶层的密码意图透传回来。
        // ⚠️ 只有这一处需要：`beforeUpdateDraft` 传的是 Create/UpdateDraftDto，
        //    草稿 schema 根本没有 password 字段，没什么可透传的。
        publishDto = carryAccessSecretFields(callerPublishDto, lastOuput);
      }
    }
    const data = await this.draftProvider.publish(id, publishDto);
    this.isrProvider.activeAll('发布草稿触发增量渲染！');
    this.pipelineProvider.dispatchEvent('afterUpdateArticle', data);
    return {
      statusCode: 200,
      data,
    };
  }
  @Delete('/:id')
  async delete(@Param('id') id: number) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const toDeleteDraft = await this.draftProvider.findById(id);
    const data = await this.draftProvider.deleteById(id);
    this.pipelineProvider.dispatchEvent('deleteDraft', toDeleteDraft);
    return {
      statusCode: 200,
      data,
    };
  }

  /** 从回收站恢复草稿（P3）。草稿不上前台，没有 ISR/字数副作用。 */
  @Put('/:id/restore')
  async restore(@Param('id') id: number) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const restored: any = await this.draftProvider.restoreById(id);
    if (!restored) {
      throw codedError('draftNotInRecycleBin');
    }
    this.pipelineProvider.dispatchEvent('afterUpdateDraft', restored);
    return {
      statusCode: 200,
      data: restored,
    };
  }

  /** 彻底删除草稿（P3）：只对回收站里的草稿生效；全站唯一的草稿硬删除入口。 */
  @Delete('/:id/purge')
  async purge(@Param('id') id: number) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const target = await this.draftProvider.findDeletedById(id);
    if (!target) {
      throw codedError('draftPurgeRequiresRecycleBin');
    }
    const data = await this.draftProvider.purgeById(id);
    return {
      statusCode: 200,
      data,
    };
  }
}
