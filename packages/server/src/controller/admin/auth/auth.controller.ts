import {
  BadRequestException,
  Controller,
  Logger,
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
import { TokenGuard } from 'src/provider/auth/token.guard';
import { AuthProvider } from 'src/provider/auth/auth.provider';
import { LogProvider } from 'src/provider/log/log.provider';
import { UserProvider } from 'src/provider/user/user.provider';
import { LoginGuard } from 'src/provider/auth/login.guard';
import { TokenProvider } from 'src/provider/token/token.provider';
import { CacheProvider } from 'src/provider/cache/cache.provider';
import { InitProvider } from 'src/provider/init/init.provider';
import { PipelineProvider } from 'src/provider/pipeline/pipeline.provider';
import { ApiToken } from 'src/provider/swagger/token';

@ApiTags('auth')
@Controller('/api/admin/auth/')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

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

  /**
   * 登出。⚠️ 必须挂 TokenGuard（第四轮审计 B7/R4-9）：这条路由在 `/api/admin`
   * 前缀下，却曾经没有任何守卫 —— 它按值吊销，所以不是提权口子，但匿名请求
   * 就能触发 `dispatchEvent('logout')`，也就是**匿名调用方能启动管理员编写的
   * 流水线脚本**；而且它不受「公开写 30/分钟」那把桶管（只受全局 600/分钟）。
   * TokenGuard 只验证 token 在库里且未被吊销（不要求完整 AdminGuard 的
   * jwt+access 两道），正好是这条路由需要的最小守卫。
   * blast radius：拿已失效/伪造 token 调 logout 从 200 变成 401 ——
   * 后台前端的 LogoutButton 早就容忍这一点（try/catch + 无条件清 localStorage
   * + 跳登录页，失败时提示「已退出登录（服务端会话已失效）」）。
   */
  @UseGuards(TokenGuard)
  @Post('/logout')
  async logout(@Request() request: any) {
    const token = request.headers['token'];
    if (!token) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: '无登录凭证！',
      });
    }
    await this.tokenProvider.disableToken(token);
    // ⚠️ 事件必须在**吊销成功之后**才触发（以前在之前：吊销还没发生，
    // 流水线脚本就已经跑起来了，而且匿名请求也能触发）。
    // 不 await（登出响应不该等流水线），但要 catch：dispatchEvent 的第一句 DB 读
    // 在它自己的 try 之外，不接住就是一条无来源的 unhandledRejection（§7.55 J-4 同款）。
    void this.pipelineProvider
      .dispatchEvent('logout', {
        token,
      })
      .catch((err) => {
        this.logger.error(`logout 流水线事件失败：${(err as Error)?.message || err}`);
      });
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
