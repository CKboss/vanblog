import {
  ForbiddenException,
  Body,
  Controller,
  Get,
  Put,
  UseGuards,
  Logger,
  Delete,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { config } from 'src/config';
import { SettingProvider } from 'src/provider/setting/setting.provider';
import { HttpsSetting } from 'src/types/setting.dto';
import { CaddyProvider } from 'src/provider/caddy/caddy.provider';
import { MetaProvider } from 'src/provider/meta/meta.provider';
import { asQueryString } from 'src/utils/sanitizeRequest';
import { isIpv4 } from 'src/utils/ip';
import { ApiToken } from 'src/provider/swagger/token';

@ApiTags('caddy')
@ApiToken
@Controller('/api/admin/caddy')
export class CaddyController {
  private readonly logger = new Logger(CaddyController.name);
  constructor(
    private readonly settingProvider: SettingProvider,
    private readonly caddyProvider: CaddyProvider,
    private readonly metaProvider: MetaProvider,
  ) {}
  @UseGuards(...AdminGuard)
  @Get('https')
  async getHttpsConfig() {
    const config = await this.settingProvider.getHttpsSetting();
    return {
      statusCode: 200,
      data: config,
    };
  }

  /**
   * Caddy `on_demand_tls` 的回调（**必须无鉴权**，是 caddy 自己来问的）。
   *
   * 以前的逻辑是「只要不是 IPv4 就批准」，等于任何人都能把任意域名解析到这台机器，
   * 让本站去为它申请证书（ACME 速率限制被耗掉、还可能被拿去做钓鱼站）。
   * 现在只放行本站自己的域名：siteInfo.baseUrl、https 设置里的域名、caddy 已登记的 subjects。
   * 确实需要放开时设 `VANBLOG_CADDY_ASK_ALLOW_ALL=true`。
   */
  @Get('ask')
  async askOnDemand(@Query('domain') domain: unknown) {
    const raw = asQueryString(domain)?.trim().toLowerCase();
    if (!raw || isIpv4(raw)) {
      this.logger.log('试图通过 ip + https 访问，已驳回');
      throw new BadRequestException();
    }
    if (process.env.VANBLOG_CADDY_ASK_ALLOW_ALL === 'true') {
      return 'is Domain, on damand https';
    }
    const allowed = await this.getAllowedAskDomains();
    if (!allowed.has(raw)) {
      this.logger.warn(`拒绝为未登记的域名签发证书：${raw}`);
      throw new ForbiddenException('未授权的域名');
    }
    return 'is Domain, on damand https';
  }

  private async getAllowedAskDomains(): Promise<Set<string>> {
    const hosts = new Set<string>();
    const add = (value: unknown) => {
      const text = String(value || '').trim().toLowerCase();
      if (!text) {
        return;
      }
      try {
        hosts.add(new URL(text).hostname.toLowerCase());
      } catch {
        hosts.add(text.replace(/^\./, ''));
      }
    };
    try {
      const siteInfo = await this.metaProvider.getSiteInfo();
      add(siteInfo?.baseUrl);
    } catch {
      // 拿不到站点信息时按「不放行」处理
    }
    try {
      const httpsSetting: any = await this.settingProvider.getHttpsSetting();
      (httpsSetting?.domains || []).forEach?.(add);
      add(httpsSetting?.domain);
    } catch {
      // 同上
    }
    try {
      const subjects = await this.caddyProvider.getSubjects();
      (Array.isArray(subjects) ? subjects : []).forEach(add);
    } catch {
      // 本地没有 caddy 时忽略
    }
    return hosts;
  }
  @UseGuards(...AdminGuard)
  @Delete('log')
  async clearLog() {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    await this.caddyProvider.clearLog();
    return {
      statusCode: 200,
      data: '清除 Caddy 运行日志成功！',
    };
  }
  @UseGuards(...AdminGuard)
  @Get('log')
  async getCaddyLog() {
    const log = await this.caddyProvider.getLog();
    return {
      statusCode: 200,
      data: log,
    };
  }
  @UseGuards(...AdminGuard)
  @Get('config')
  async getCaddyConfig() {
    const caddyConfig = await this.caddyProvider.getConfig();
    return {
      statusCode: 200,
      data: JSON.stringify(caddyConfig, null, 2),
    };
  }
  @UseGuards(...AdminGuard)
  @Put('https')
  async updateHttpsConfig(@Body() dto: HttpsSetting) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const result = await this.caddyProvider.setRedirect(dto.redirect || false);
    if (!result) {
      return {
        statusCode: 500,
        message: '更新失败！请查看 Caddy 日志获取详细信息！',
      };
    }
    await this.settingProvider.updateHttpsSetting(dto);
    return {
      statusCode: 200,
      data: '更新成功！',
    };
  }
}
