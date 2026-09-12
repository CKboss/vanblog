import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import dayjs from 'dayjs';
import { CacheProvider } from '../cache/cache.provider';
import { pickSocketIp } from '../log/utils';
import { SettingProvider } from '../setting/setting.provider';

/** 没有任何登录设置（全新站点）时用的默认值。 */
export const DEFAULT_MAX_LOGIN_RETRY = 5;
export const DEFAULT_LOGIN_WINDOW_SECONDS = 300;

interface AttemptWindow {
  count: number;
  firstFailTime: string;
}

/**
 * 登录防爆破。
 *
 * 旧实现有三个问题：
 * 1. **把成功登录也算成一次失败**：守卫在认证之前跑，无论结果都 `count+1`，
 *    于是正常用户一分钟内登录 4 次（比如换浏览器、退出重进）就被锁在门外；
 * 2. 阈值写死 3 次 / 60 秒，设置里的 `maxRetryTimes` / `durationSeconds` 根本没被读；
 * 3. 取 IP 用的是 `getNetIp()`——它会去请求第三方 `cip.cc`，没有超时，
 *    离线环境下每次登录都要等外网。限流只需要本地 IP（`pickClientIp`）。
 *
 * 现在：守卫只做「是否已超限」的判断，计数由 controller 在**认证失败**时调用
 * `recordFailure()`，成功时调用 `reset()`。
 */
@Injectable()
export class LoginGuard implements CanActivate {
  logger = new Logger(LoginGuard.name);
  constructor(
    private cacheProvider: CacheProvider,
    private settingProvider: SettingProvider,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const state = await this.inspect(request);
    if (!state.allowed) {
      this.logger.warn(
        `登录失败次数过多，已临时拒绝\nip: ${state.ip}\ncount: ${state.count}\nretryAfter: ${state.retryAfterSeconds}s`,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        message: `错误次数过多！请 ${state.retryAfterSeconds} 秒后再试！`,
      });
    }
    return true;
  }

  /** 取限流用的缓存 key；拿不到 IP 就不限流（返回空串）。 */
  /**
   * 限流的 key 必须用**套接字地址**：`pickClientIp()` 优先读 cf-connecting-ip /
   * x-real-ip / x-forwarded-for，这些都是客户端可伪造的 —— 攻击者每次换一个
   * X-Real-IP 就能无限次试密码，反过来还能用受害者的真实 IP 把对方锁在门外。
   * 部署在反代后面时套接字地址是反代本身，此时所有请求共用一个桶（更严格，不会更松）。
   */
  private keyOf(req: any): string {
    const ip = pickSocketIp(req);
    return ip ? `login-${ip}` : 'login-unknown';
  }

  /** 设置里没有登录配置时默认开启（老站点显式关掉的仍然尊重其选择）。 */
  private async resolveLimits() {
    const setting = await this.settingProvider.getLoginSetting();
    const enabled = setting ? setting.enableMaxLoginRetry !== false : true;
    const max =
      Number(setting?.maxRetryTimes) > 0
        ? Number(setting.maxRetryTimes)
        : DEFAULT_MAX_LOGIN_RETRY;
    const windowSeconds =
      Number(setting?.durationSeconds) > 0
        ? Number(setting.durationSeconds)
        : DEFAULT_LOGIN_WINDOW_SECONDS;
    return { enabled, max, windowSeconds };
  }

  private readWindow(key: string, windowSeconds: number): { count: number; expired: boolean } {
    const raw = this.cacheProvider.get(key) as AttemptWindow | Record<string, never>;
    const count = Number((raw as AttemptWindow)?.count) || 0;
    const firstFailTime = (raw as AttemptWindow)?.firstFailTime;
    if (!count || !firstFailTime) {
      return { count: 0, expired: true };
    }
    const diff = dayjs().diff(dayjs(firstFailTime), 'seconds');
    if (diff > windowSeconds) {
      return { count: 0, expired: true };
    }
    return { count, expired: false };
  }

  /** 只读判断：当前是否还允许尝试登录。 */
  async inspect(req: any): Promise<{ allowed: boolean; ip: string; count: number; retryAfterSeconds: number }> {
    const ip = pickSocketIp(req);
    const key = this.keyOf(req);
    const { enabled, max, windowSeconds } = await this.resolveLimits();
    if (!enabled || !key) {
      return { allowed: true, ip, count: 0, retryAfterSeconds: 0 };
    }
    const { count, expired } = this.readWindow(key, windowSeconds);
    if (expired || count < max) {
      return { allowed: true, ip, count, retryAfterSeconds: 0 };
    }
    const raw = this.cacheProvider.get(key) as AttemptWindow;
    const elapsed = dayjs().diff(dayjs(raw.firstFailTime), 'seconds');
    return {
      allowed: false,
      ip,
      count,
      retryAfterSeconds: Math.max(1, windowSeconds - Math.max(0, elapsed)),
    };
  }

  /** 认证失败时调用：开新窗口或累加。 */
  async recordFailure(req: any): Promise<number> {
    const key = this.keyOf(req);
    if (!key) {
      return 0;
    }
    const { enabled, windowSeconds } = await this.resolveLimits();
    if (!enabled) {
      return 0;
    }
    const { count, expired } = this.readWindow(key, windowSeconds);
    const next = expired ? 1 : count + 1;
    this.cacheProvider.set(key, {
      count: next,
      firstFailTime: expired ? new Date().toISOString() : (this.cacheProvider.get(key) as AttemptWindow).firstFailTime,
    });
    return next;
  }

  /** 登录成功时调用：清零，避免正常用户被历史失败拖累。 */
  async reset(req: any): Promise<void> {
    const key = this.keyOf(req);
    if (key) {
      this.cacheProvider.set(key, { count: 0, firstFailTime: '' });
    }
  }
}
