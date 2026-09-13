import { Body, Controller, Delete, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { CommentProvider } from 'src/provider/comment/comment.provider';
import { ApiToken } from 'src/provider/swagger/token';
import { UpdateCommentDto } from 'src/types/comment.dto';
import { config } from 'src/config/index';

/** 内置评论的后台管理（只有管理员能进：不在 publicRoutes 里，走 AdminGuard） */
@ApiTags('comment')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/comment')
export class CommentController {
  constructor(private readonly commentProvider: CommentProvider) {}

  private demoBlock() {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    return null;
  }

  @Get('/')
  async list(@Query() query: any) {
    return {
      statusCode: 200,
      data: await this.commentProvider.listForAdmin({
        page: Number(query?.page) || 1,
        pageSize: Number(query?.pageSize) || 20,
        status: query?.status,
        path: query?.path,
        keyword: query?.keyword,
      }),
    };
  }

  @Get('/counts')
  async counts() {
    return { statusCode: 200, data: await this.commentProvider.countByStatus() };
  }

  @Put('/:id')
  async update(@Param('id') id: number, @Body() body: UpdateCommentDto) {
    const blocked = this.demoBlock();
    if (blocked) {
      return blocked;
    }
    const res = await this.commentProvider.updateById(Number(id), body || {});
    return { statusCode: 200, data: res };
  }

  @Delete('/:id')
  async delete(@Param('id') id: number) {
    const blocked = this.demoBlock();
    if (blocked) {
      return blocked;
    }
    return { statusCode: 200, data: await this.commentProvider.deleteById(Number(id)) };
  }
}
