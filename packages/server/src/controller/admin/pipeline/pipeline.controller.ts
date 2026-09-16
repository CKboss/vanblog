import { config } from 'src/config';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { Request } from 'express';
import { PipelineProvider } from 'src/provider/pipeline/pipeline.provider';
import { CreatePipelineDto } from 'src/types/pipeline.dto';
import { VanblogSystemEvents } from 'src/types/event';
import { ApiToken } from 'src/provider/swagger/token';

/**
 * 路径参数里的流水线 id：非法值直接 400，不再把 NaN 交给 Mongo。
 *
 * ⚠️ 以前四处都是裸的 `parseInt(idString)`：`/api/admin/pipeline/abc` 会得到 `{id: NaN}`，
 * 什么都匹配不到 ⇒ 查询返回 `{statusCode:200, data:null}`（与"没有这条流水线"完全分不出来），
 * 删除则是**静默 no-op**（`modifiedCount: 0`，接口照样回"成功"）。
 * 后台专用接口，但"错误与空结果不可区分"正是要消灭的那一类。
 */
function parsePipelineId(raw: string): number {
  const trimmed = String(raw ?? '').trim();
  if (!/^-?\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new BadRequestException(`流水线 id 不合法：${trimmed.slice(0, 40) || '(空)'}`);
  }
  return Number(trimmed);
}

@ApiTags('pipeline')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/pipeline')
export class PipelineController {
  constructor(private readonly pipelineProvider: PipelineProvider) {}
  @Get()
  async getAllPipelines(@Req() req: Request) {
    const pipelines = await this.pipelineProvider.getAll();
    return {
      statusCode: 200,
      data: pipelines,
    };
  }
  @Get('config')
  async getPipelineConfig(@Req() req: Request) {
    return {
      statusCode: 200,
      data: VanblogSystemEvents,
    };
  }
  @Get('/:id')
  async getPipelineById(@Param('id') idString: string) {
    const id = parsePipelineId(idString);
    const pipeline = await this.pipelineProvider.getPipelineById(id);
    return {
      statusCode: 200,
      data: pipeline,
    };
  }
  @Post()
  async createPipeline(@Body() createPipelineDto: CreatePipelineDto) {
    // 管线会 fork 子进程执行任意 JS，演示站必须禁掉（否则等于公开 RCE）
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const pipeline = await this.pipelineProvider.createPipeline(createPipelineDto);
    return {
      statusCode: 200,
      data: pipeline,
    };
  }
  @Delete('/:id')
  async deletePipelineById(@Param('id') idString: string) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const id = parsePipelineId(idString);
    const pipeline = await this.pipelineProvider.deletePipelineById(id);
    return {
      statusCode: 200,
      data: pipeline,
    };
  }
  @Put('/:id')
  async updatePipelineById(
    @Param('id') idString: string,
    @Body() updatePipelineDto: CreatePipelineDto,
  ) {
    // 同上
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const id = parsePipelineId(idString);
    const pipeline = await this.pipelineProvider.updatePipelineById(id, updatePipelineDto);
    return {
      statusCode: 200,
      data: pipeline,
    };
  }
  @Post('/trigger/:id')
  async triggerPipelineById(@Param('id') idString: string, @Body() triggerDto: { input?: any }) {
    // 触发即执行任意 JS
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const id = parsePipelineId(idString);
    const result = await this.pipelineProvider.triggerById(id, triggerDto.input);
    return {
      statusCode: 200,
      data: result,
    };
  }
}
