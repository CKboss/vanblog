import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
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

  /**
   * 从 Waline 导出的 JSON 导入评论。
   * body 直接就是导出文件的内容（支持 VanBlog 的 waline 备份、`{Comment:[...]}`、裸数组三种形状），
   * 也可以包一层 `{ payload, includeNonApproved, dryRun }`。
   * 默认**只导入正式显示的（approved）**；`dryRun: true` 只统计不写库。
   */
  @Post('/import/waline')
  async importWaline(@Body() body: any) {
    const blocked = this.demoBlock();
    if (blocked) {
      return blocked;
    }
    const wrapped = body && typeof body === 'object' && 'payload' in body;
    const payload = wrapped ? body.payload : body;
    const options = {
      includeNonApproved: wrapped ? body.includeNonApproved === true : false,
      dryRun: wrapped ? body.dryRun === true : false,
    };
    const data = await this.commentProvider.importFromWaline(payload, options);
    return { statusCode: 200, data };
  }

  /**
   * 导出评论。**默认只导出正式显示的（approved）**，待审/垃圾/已删除不导出；
   * 要全部就传 `status=all`。`download=1` 会带上附件头，浏览器直接存文件。
   */
  @Get('/export')
  async exportComments(@Query('status') status: string, @Query('download') download: string, @Res() res: any) {
    const comments = await this.commentProvider.exportComments(String(status || 'approved'));
    const payload = {
      __version: '1.0',
      type: 'vanblog-comments',
      time: Date.now(),
      status: String(status || 'approved'),
      count: comments.length,
      comments,
    };
    if (String(download || '') === '1') {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vanblog-comments-${String(status || 'approved')}-${stamp}.json"`,
      );
      return res.send(JSON.stringify(payload, null, 2));
    }
    return res.json({ statusCode: 200, data: payload });
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
