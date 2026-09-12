import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { config } from 'src/config';
import { SearchStaticOption } from 'src/types/setting.dto';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { ApiToken } from 'src/provider/swagger/token';
import { StaticProvider } from 'src/provider/static/static.provider';
import { ATTACHMENT_MAX_BYTES, displayFileName } from 'src/utils/attachment';
import { sanitizePagination } from 'src/utils/pagination';

/**
 * 列表里额外给出「去掉 md5 前缀」的展示名，前端不必再算一遍。
 * 注意 mongoose 文档不能直接展开（字段在原型上），要先 toObject()。
 */
export function withDisplayName(item: any) {
  const plain =
    item && typeof item.toObject === 'function' ? item.toObject({ virtuals: false }) : { ...item };
  return { ...plain, displayName: displayFileName(plain?.name || '') };
}

/**
 * 附件管理：和图片管理（ImgController）对称，但存的是任意文件。
 * 文件落在 `<static>/file/`，URL 为 `/static/file/<md5>.<原名>`。
 */
@ApiTags('file')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/file')
export class FileController {
  constructor(private readonly staticProvider: StaticProvider) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ATTACHMENT_MAX_BYTES } }))
  async upload(@UploadedFile() file: any) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    if (!file || !file.buffer) {
      throw new BadRequestException('没有收到文件！');
    }
    const data = await this.staticProvider.upload(file, 'file');
    return {
      statusCode: 200,
      data,
    };
  }

  @Get('all')
  async getAll() {
    const data = await this.staticProvider.getAll('file', 'public');
    return {
      statusCode: 200,
      data: (data || []).map(withDisplayName),
    };
  }

  @Get('')
  async getByOption(
    @Query('page') page: number,
    @Query('pageSize') pageSize = 10,
    @Query('name') name?: string,
  ) {
    const paging = sanitizePagination(page, pageSize);
    const option: SearchStaticOption = {
      page: paging.page,
      pageSize: paging.pageSize,
      staticType: 'file',
      view: 'public',
      name,
    };
    const res = await this.staticProvider.getByOption(option);
    return {
      statusCode: 200,
      data: {
        total: res.total,
        data: (res.data || []).map(withDisplayName),
      },
    };
  }

  @Post('export')
  async exportAllAttachments() {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const path = await this.staticProvider.exportAllAttachments();
    return {
      statusCode: 200,
      data: { path },
    };
  }

  @Delete('/:sign')
  async delete(@Param('sign') sign: string) {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    const data = await this.staticProvider.deleteOneBySign(sign, 'file');
    return {
      statusCode: 200,
      data,
    };
  }
}
