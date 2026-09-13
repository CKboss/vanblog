import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';

import { ApiTags } from '@nestjs/swagger';
import { config } from 'src/config/index';
import {
  CommentSetting,
  LayoutSetting,
  LoginSetting,
  StaticSetting,
  WalineSetting,
} from 'src/types/setting.dto';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { SettingProvider } from 'src/provider/setting/setting.provider';
import { WalineProvider } from 'src/provider/waline/waline.provider';
import { ApiToken } from 'src/provider/swagger/token';

@ApiTags('setting')
@UseGuards(...AdminGuard)
@ApiToken
@Controller('/api/admin/setting')
export class SettingController {
  constructor(
    private readonly settingProvider: SettingProvider,
    private readonly walineProvider: WalineProvider,
    private readonly isrProvider: ISRProvider,
  ) {}

  @Get('static')
  async getStaticSetting() {
    const res = await this.settingProvider.getStaticSetting();
    return {
      statusCode: 200,
      data: res,
    };
  }

  @Put('static')
  async updateStaticSetting(@Body() body: Partial<StaticSetting>) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const res = await this.settingProvider.updateStaticSetting(body);
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Get('comment')
  async getCommentSetting() {
    return {
      statusCode: 200,
      data: await this.settingProvider.getCommentSetting(),
    };
  }

  /**
   * 切换评论系统：
   * - 切到 `waline` → 把 waline 子进程拉起来；
   * - 切到 `builtin` / `off` → 停掉它（省一个 node 进程和 8360 端口）。
   * 两边的评论数据互不影响（内置在 vanBlog 库的 comments 集合，waline 在 waline 库）。
   */
  @Put('comment')
  async updateCommentSetting(@Body() body: CommentSetting) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const before = await this.settingProvider.getCommentSetting();
    const res = await this.settingProvider.updateCommentSetting(body || ({} as CommentSetting));
    const after = await this.settingProvider.getCommentSetting();
    if (before.provider !== after.provider) {
      if (after.provider === 'waline') {
        await this.walineProvider.restart('评论系统切换为 waline，');
      } else {
        await this.walineProvider.stop();
        this.walineProvider.logger.log(`评论系统切换为 ${after.provider}，已停止 waline 子进程`);
      }
    }
    return {
      statusCode: 200,
      data: after,
      res,
    };
  }

  @Put('waline')
  async updateWalineSetting(@Body() body: WalineSetting) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改此项！',
      };
    }
    const res = await this.settingProvider.updateWalineSetting(body);
    await this.walineProvider.restart('更新 waline 设置，');
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Get('waline')
  async getWalineSetting() {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 200,
        data: null,
      };
    }
    const res = await this.settingProvider.getWalineSetting();
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Put('layout')
  async updateLayoutSetting(@Body() body: LayoutSetting) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改定制化设置！',
      };
    }
    const res = await this.settingProvider.updateLayoutSetting(body);
    this.isrProvider.activeAll('更新 layout 设置');
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Get('layout')
  async getLayoutSetting() {
    const res = await this.settingProvider.getLayoutSetting();
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Put('login')
  async updateLoginSetting(@Body() body: LoginSetting) {
    if (config.demo && config.demo == 'true') {
      return {
        statusCode: 401,
        message: '演示站禁止修改登录安全策略设置！',
      };
    }
    const res = await this.settingProvider.updateLoginSetting(body);
    return {
      statusCode: 200,
      data: res,
    };
  }
  @Get('login')
  async getLoginSetting() {
    const res = await this.settingProvider.getLoginSetting();
    return {
      statusCode: 200,
      data: res,
    };
  }
}
