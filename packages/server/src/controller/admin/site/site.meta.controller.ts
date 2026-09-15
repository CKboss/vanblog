import { Body, Controller, Get, Logger, Put, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UpdateSiteInfoDto } from 'src/types/site.dto';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { WalineProvider } from 'src/provider/waline/waline.provider';
import { config } from 'src/config';
import { WebsiteProvider } from 'src/provider/website/website.provider';
import { PipelineProvider } from 'src/provider/pipeline/pipeline.provider';
import { ApiToken } from 'src/provider/swagger/token';
@ApiTags('site')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/meta/site')
export class SiteMetaController {
  private readonly logger = new Logger(SiteMetaController.name);
  constructor(
    private readonly metaProvider: MetaProvider,
    private readonly isrProvider: ISRProvider,
    private readonly walineProvider: WalineProvider,
    private readonly websiteProvider: WebsiteProvider,
    private readonly pipelineProvider: PipelineProvider,
  ) {}

  @Get()
  async get() {
    const data = await this.metaProvider.getSiteInfo();
    return {
      statusCode: 200,
      data,
    };
  }

  @Put()
  async update(@Body() updateDto: UpdateSiteInfoDto) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const data = await this.metaProvider.updateSiteInfo(updateDto);
    this.pipelineProvider.dispatchEvent('updateSiteInfo', updateDto);
    this.isrProvider.activeAll('更新站点配置触发增量渲染！');
    // 这两个都是"发出去就不管"的重启，但必须挂 catch：
    // 否则一次失败就是一条没人认领的 unhandledRejection，而前台/评论可能已经停在半路
    this.walineProvider
      .restart('更新站点，')
      .catch((err) => this.logger.error(`重启 waline 失败：${err?.message || err}`));
    this.websiteProvider
      .restart('更新站点信息')
      .catch((err) => this.logger.error(`重启前台失败：${err?.message || err}`));
    return {
      statusCode: 200,
      data,
    };
  }
}
