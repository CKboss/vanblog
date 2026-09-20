import {
  BadRequestException,
  Controller,
  HttpException,
  HttpStatus,
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
import { assertAccountPasswordStrength, UserProvider } from 'src/provider/user/user.provider';
import { LoginGuard } from 'src/provider/auth/login.guard';
import { TokenProvider } from 'src/provider/token/token.provider';
import { CacheProvider } from 'src/provider/cache/cache.provider';
import { InitProvider } from 'src/provider/init/init.provider';
import { PipelineProvider } from 'src/provider/pipeline/pipeline.provider';
import { ApiToken } from 'src/provider/swagger/token';
import { safeEqual } from 'src/utils/crypto';
import { consumeAttempt, resetAttempts } from 'src/utils/attemptLimit';
import { bruteForceClientIp } from 'src/utils/trustedProxy';
import { scaleLimit } from 'src/utils/clusterRole';
import { INIT_LIMIT_PER_10MIN } from 'src/utils/rateLimit';

/**
 * 「忘记密码」恢复接口的限流窗口：与 `/api/admin/init*` 同档（10 分钟）。
 * 阈值直接复用 `INIT_LIMIT_PER_10MIN`（默认 5，`VANBLOG_INIT_LIMIT_PER_10MIN` 可调，
 * 并经 `scaleLimit()` 按 worker 数摊薄）—— 两者是同一类"匿名、低频、能改写凭据"的接口，
 * 没必要再引入一个需要单独文档与单独默认值的旋钮。
 */
const RESTORE_WINDOW_MS = 10 * 60 * 1000;

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
    // ⚠️ 专用限流桶（与 `/api/admin/init*` 同档：5 次 / 10 分钟 / IP）。
    // 这条路由是**匿名**的，而且成功一次就等于改写管理员的用户名与口令 ——
    // 但它不在 `/api/admin/init` 前缀下，所以 `utils/rateLimit.ts` 的 init 桶管不到它，
    // 以前只剩全局的 600 次/分钟。恢复密钥是 32 字节随机（爆破不可行），
    // 真正要防的是：①拿着泄露的密钥反复试；②把它当免费的"改管理员口令"接口刷；
    // ③在 cluster 多进程下用大流量放大任何判定缺陷。
    // ⚠️ 计数用 `bruteForceClientIp`（套接字地址优先）而不是 `pickTrustedClientIp`：
    //    防爆破类计数的收益正是"换一个 key 就重新开始"，理由见 utils/trustedProxy.ts。
    //    `rateLimit.ts` 由别的改动负责，这里只用它导出的阈值常量，不去改它。
    const restoreIp = bruteForceClientIp(request);
    const restoreHit = consumeAttempt(`auth-restore-${restoreIp}`, {
      max: scaleLimit(INIT_LIMIT_PER_10MIN),
      windowMs: RESTORE_WINDOW_MS,
    });
    if (!restoreHit.allowed) {
      // 与 rateLimit.ts 的 429 形状保持一致：带上 Retry-After，脚本不必解析中文消息
      const res = (request as any)?.res;
      if (typeof res?.setHeader === 'function') {
        res.setHeader('Retry-After', String(Math.max(1, restoreHit.retryAfterSeconds)));
      }
      throw new HttpException(
        { statusCode: 429, message: '恢复接口调用过于频繁，请稍后再试' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const token = body.key;
    // ⚠️ 这里以前是：
    //     const keyInCache = await this.cacheProvider.get('restoreKey');
    //     if (!token || token != keyInCache) throw 401
    // 两个细节凑成一个**未认证的管理员接管**：`get()` 在键缺失时返回 `{}`，而
    // `"[object Object]" != {}` 在 JS 里是 **false**（对象被转成原始值再比）⇒ 校验通过。
    // 键缺失不是假设：`initRestoreKey()` 只在主实例跑，而 `CacheProvider.data` 是每进程一份，
    // 所以 `VANBLOG_CLUSTER_WORKERS>1` 时**每个 worker 上这条匿名接口都可被绕过**，
    // 攻击者能直接改写 id:0 管理员的用户名与口令。
    // 现在：只接受字符串密钥、常量时间比较、拿不到密钥就**失败关闭**（详见
    // `init.provider.ts` 的 `getRestoreKeyForVerification`）。
    const expectedKey = await this.initProvider.getRestoreKeyForVerification();
    if (!expectedKey) {
      this.logger.error(
        '「忘记密码」恢复密钥不可用（内存缓存与 <日志目录>/restore.key 都读不到），已拒绝本次请求。' +
          '这通常意味着本进程不是主实例且日志目录不可读；请检查 VAN_BLOG_LOG 与卷挂载。',
      );
      throw new UnauthorizedException({
        statusCode: 401,
        message: '恢复密钥错误！',
      });
    }
    if (typeof token !== 'string' || !safeEqual(token, expectedKey)) {
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
    // ⚠️ 口令校验走 user.provider 的**统一入口**（空值 / 超长 / 过短都在那里判），
    //    不在这里再抄一份 `!password || password.length > 200`：两份校验一定会漂移
    //    （本轮之前这里就是一份独立副本，所以下限只加在了一边）。
    //    下面那次 updateUser() 也会再校验一次，幂等，不会有两套结论。
    assertAccountPasswordStrength(password, '管理员');
    await this.userProvider.updateUser({
      name,
      password,
    });
    await this.initProvider.initRestoreKey();
    // ⚠️ 必须在返回响应**之前** await。旧实现是 `setTimeout(() => disableAll(), 1000)`
    //    （注释写"在前端清理 localStore 之后"），两个真实后果：
    //    ① 与未 await 的 `tokenModel.create` 竞态 ⇒ 新签发的 token 可能躲过这次吊销；
    //    ② 进程在这一秒内退出（重启/部署/OOM）⇒ 吊销**完全不发生**，且没有任何日志。
    //    前端并不需要这一秒：它拿到 200 后自己清 localStorage，服务端何时吊销与它无关；
    //    改成"响应返回时旧凭证已确定失效"只会更安全。详见 token.provider.ts 的 disableAll()。
    await this.tokenProvider.disableAll();
    // 成功了就清掉这个 IP 的计数：站长试错几次再成功，不该被自己的成功锁在门外。
    resetAttempts(`auth-restore-${restoreIp}`);

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
    // ⚠️ 同样改成 await（旧实现是 setTimeout(..., 1000)）：改完管理员口令之后，
    //    所有旧会话与**所有 API Token** 必须确定失效，否则"改密码"挡不住已泄露的长期凭证。
    //    理由与竞态细节见 restore() 里那段与 token.provider.ts 的 disableAll() 注释。
    await this.tokenProvider.disableAll();
    return {
      statusCode: 200,
      data,
    };
  }
}
