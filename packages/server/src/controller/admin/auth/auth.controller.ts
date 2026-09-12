import {
  BadRequestException,
  Controller,
  Request,
  Post,
  UseGuards,
  Put,
  Body,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags } from '@nestjs/swagger';
import { config } from 'src/config/index';
import { UpdateUserDto } from 'src/types/user.dto';
import { AdminGuard } from 'src/provider/auth/auth.guard';
import { AuthProvider } from 'src/provider/auth/auth.provider';
import { LogProvider } from 'src/provider/log/log.provider';
import { UserProvider } from 'src/provider/user/user.provider';
import { LoginGuard } from 'src/provider/auth/login.guard';
import { TokenProvider } from 'src/provider/token/token.provider';
import { CacheProvider } from 'src/provider/cache/cache.provider';
import { InitProvider } from 'src/provider/init/init.provider';
import { PipelineProvider } from 'src/provider/pipeline/pipeline.provider';
import { ApiToken } from 'src/provider/swagger/token';

@ApiTags('tag')
@Controller('/api/admin/auth/')
export class AuthController {
  constructor(
    private readonly authProvider: AuthProvider,
    private readonly userProvider: UserProvider,
    private readonly logProvider: LogProvider,
    private readonly tokenProvider: TokenProvider,
    private readonly cacheProvider: CacheProvider,
    private readonly initProvider: InitProvider,
    private readonly pipelineProvider: PipelineProvider,
    private readonly loginGuard: LoginGuard,
  ) {}

  @UseGuards(LoginGuard, AuthGuard('local'))
  @Post('/login')
  async login(@Request() request: any) {
    if (request?.user?.fail) {
      // 只有**失败**才计数（旧实现连成功登录也计数，正常用户会被自己锁在门外）
      await this.loginGuard.recordFailure(request);
      this.logProvider.login(request, false);
      throw new UnauthorizedException({
        statusCode: 401,
        message: '用户名或密码错误！',
      });
    }
    // 能到这里登陆就成功了
    await this.loginGuard.reset(request);
    this.logProvider.login(request, true);
    const data = await this.authProvider.login(request.user);
    this.pipelineProvider.dispatchEvent('login', data);
    return {
      statusCode: 200,
      data,
    };
  }

  @Post('/logout')
  async logout(@Request() request: any) {
    const token = request.headers['token'];
    if (!token) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: '无登录凭证！',
      });
    }
    this.pipelineProvider.dispatchEvent('logout', {
      token,
    });
    await this.tokenProvider.disableToken(token);
    return {
      statusCode: 200,
      data: '登出成功！',
    };
  }

  @Post('/restore')
  async restore(
    @Request() request: Request,
    @Body() body: { key: string; name: string; password: string },
  ) {
    const token = body.key;
    const keyInCache = await this.cacheProvider.get('restoreKey');
    if (!token || token != keyInCache) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: '恢复密钥错误！',
      });
    }
    // 这是「忘记密码」的自救通道，参数不校验的话：空密码会把账号密码哈希写成空串，
    // 之后**任何密码都登不进来**，只能再去改库——自救工具反而把人锁死。
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!name || name.length > 50) {
      throw new BadRequestException('用户名不合法（1-50 个字符）');
    }
    if (!password || password.length > 200) {
      throw new BadRequestException('密码不合法（1-200 个字符）');
    }
    await this.userProvider.updateUser({
      name,
      password,
    });
    await this.initProvider.initRestoreKey();
    setTimeout(() => {
      // 在前端清理 localStore 之后
      this.tokenProvider.disableAll();
    }, 1000);

    return {
      statusCode: 200,
      data: '重置成功！',
    };
  }

  @UseGuards(...AdminGuard)
  @ApiToken
  @Put()
  async updateUser(@Body() updateUserDto: UpdateUserDto) {
    if (config?.demo == true || config?.demo == 'true') {
      return { statusCode: 401, message: '演示站禁止修改账号密码！' };
    }
    const data = await this.userProvider.updateUser(updateUserDto);
    setTimeout(() => {
      // 在前端清理 localStore 之后
      this.tokenProvider.disableAll();
    }, 1000);
    return {
      statusCode: 200,
      data,
    };
  }
}
