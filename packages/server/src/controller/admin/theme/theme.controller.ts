import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { promises as fs } from 'fs';
import * as path from 'path';
import { config } from 'src/config';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { ApiToken } from 'src/provider/swagger/token';
import { ThemeProvider } from 'src/provider/theme/theme.provider';
import { THEME_MAX_BYTES } from 'src/types/theme.dto';

/**
 * 主题管理（后台「系统设置 → 主题」）。
 *
 * 上传的主题就是一份 CSS 文件，落在 `<static>/themes/`，由 caddy 直接服务；
 * 元数据（名字/作者/描述/hash/URL）存在 settings 的 `type: 'theme'` 里。
 * 生效方式是把 `siteInfo.uiStyle` 改成主题 id，然后触发一次全量渲染 ——
 * 所以"上传 → 启用 → 刷新前台"就完事了，不用重新构建、不用重启容器。
 */
@ApiTags('theme')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/theme')
export class ThemeController {
  constructor(private readonly themeProvider: ThemeProvider) {}

  private assertNotDemo() {
    if (config.demo && config.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改此项！' };
    }
    return null;
  }

  /** 列表：内置 + 上传的，另外带出当前生效的那个 */
  @Get('/all')
  async all() {
    const [themes, active] = await Promise.all([
      this.themeProvider.list(),
      this.themeProvider.getActive(),
    ]);
    return { statusCode: 200, data: { themes, active: active.uiStyle } };
  }

  /** 上传（或覆盖同 id 的）主题 */
  @Post('/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: THEME_MAX_BYTES, files: 1 } }))
  async upload(
    @UploadedFile() file: any,
    @Body()
    body: {
      id?: string;
      name?: string;
      description?: string;
      author?: string;
      version?: string;
    },
  ) {
    const demo = this.assertNotDemo();
    if (demo) {
      return demo;
    }
    const data = await this.themeProvider.upload(file, body || {});
    return { statusCode: 200, data, message: '上传成功' };
  }

  /** 启用某个主题 */
  @Post('/active')
  async active(@Body() body: { id?: string }) {
    const demo = this.assertNotDemo();
    if (demo) {
      return demo;
    }
    const id = String(body?.id || '').trim();
    if (!id) {
      throw new BadRequestException('缺少 id');
    }
    const data = await this.themeProvider.activate(id);
    return { statusCode: 200, data, message: `已切换到 ${id}` };
  }

  /** 删除一个上传的主题 */
  @Delete('/:id')
  async remove(@Param('id') id: string) {
    const demo = this.assertNotDemo();
    if (demo) {
      return demo;
    }
    const data = await this.themeProvider.remove(id);
    return { statusCode: 200, data, message: '已删除' };
  }

  /**
   * 看某个上传主题的 CSS 原文（后台「查看/复制」用；内置主题返回 404，它们在前台产物里）。
   *
   * ⚠️ 这里**必须**用和其它接口一样的 JSON 信封 `{statusCode, data}`，不能直接回 text/css：
   * 后台 umi 的 `request` 配了 `errorConfig.adaptor`，它会对**每一个**响应跑一遍
   * `adaptAdminResponse(resData)`，拿到的不是 `{statusCode,data}` 就判定失败并抛 **BizError**
   * （前台第一版点「查看 CSS」就是这么炸的，`parseResponse: false` 也救不回来 —— adaptor 在
   * 它之前就跑完了）。真正要给浏览器当样式表用的那份是公开的 `/api/public/theme.css`，
   * 那个才必须是 text/css。
   */
  @Get('/:id/css')
  async css(@Param('id') id: string) {
    const theme = await this.themeProvider.findOne(id);
    if (!theme) {
      throw new NotFoundException(`没有这个主题：${id}`);
    }
    if (!theme.url) {
      throw new NotFoundException(`「${id}」是内置主题，样式打包在前台产物里，没有单独的文件`);
    }
    const abs = path.join(config.staticPath, theme.url.replace(/^\/static\//, ''));
    let text = '';
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      throw new NotFoundException('主题文件不在了（可能被手工删掉），重新上传一次即可');
    }
    return {
      statusCode: 200,
      data: {
        id: theme.id,
        name: theme.name,
        url: theme.url,
        hash: theme.hash,
        // 用字节数而不是字符数：列表里显示的是上传时记的字节数，
        // 主题里有中文注释时两者会差一截，看着像"文件被改小了"
        size: Buffer.byteLength(text, 'utf8'),
        css: text,
      },
    };
  }
}
