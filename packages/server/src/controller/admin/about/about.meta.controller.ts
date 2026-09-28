import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { codedBody } from 'src/utils/serverErrorCodes';
import { ApiTags } from '@nestjs/swagger';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { config } from 'src/config';
import { ApiToken } from 'src/provider/swagger/token';
@ApiTags('about')
@ApiToken
@UseGuards(...AdminGuard)
@Controller('/api/admin/meta/about')
export class AboutMetaController {
  constructor(
    private readonly metaProvider: MetaProvider,
    private readonly isrProvider: ISRProvider,
  ) {}

  @Get()
  async getAbout() {
    const data = await this.metaProvider.getAbout();
    return {
      statusCode: 200,
      data,
    };
  }

  @Put()
  async updateAbout(@Body() updateAboutDto: { content: string }) {
    if (config.demo && config.demo == 'true') {
      return codedBody('demoSiteBlocked');
    }
    const data = await this.metaProvider.updateAbout(updateAboutDto.content);
    this.isrProvider.activeAbout('更新 about 触发增量渲染！');
    return {
      statusCode: 200,
      data,
    };
  }
}
