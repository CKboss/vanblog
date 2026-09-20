import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { bruteForceClientIp, isPrivateOrLoopback } from '../../utils/trustedProxy';
import {
  ADMIN_LOGIN_ALLOW_CIDR_ENV,
  isIpAllowedByPolicy,
  resolveAdminLoginCidrPolicy,
} from '../../utils/ip';
import {
  peekAttempts,
  recordFailureAttempt,
  resetAttempts,
} from '../../utils/attemptLimit';
import { envPositiveInt } from '../../utils/envNumber';
import { scaleLimit } from 'src/utils/clusterRole';
import { SettingProvider } from '../setting/setting.provider';

/** 没有任何登录设置（全新站点）时用的默认值。 */
export const DEFAULT_MAX_LOGIN_RETRY = 5;
export const DEFAULT_LOGIN_WINDOW_SECONDS = 300;

/**
 * 全局登录失败速率节流（见 `computeLoginThrottleDelayMs`）。
 *
 * ## 为什么需要它
 *
 * 上面那套"5 次 / 300 秒"是**按源 IP** 计的。僵尸网络换着 IP 打的时候，
 * 对**某一个用户名**的实际爆破预算是 `5 × IP 数 / 300 秒` —— 一万个肉鸡就是
 * 每分钟一万次尝试，per-IP 限制一点忙都帮不上。
 *
 * ## 为什么是"加延迟"而不是"锁账号"
 *
 * 直觉的做法是"全局失败太多就锁住这个用户名"，但那正好给了攻击者一件比撞库更厉害的武器：
 * **用错误密码把真管理员锁在门外**。在"要在这个站点上持续发布信息"的场景下，
 * 站长被锁在后台外面比密码被慢慢试更致命（而且攻击者可以无限续期）。
 * 所以这里的响应是**抬高成本**而不是**拒绝服务**：所有登录请求都变慢一点（封顶 3 秒），
 * 撞库的总吞吐被压下来，而拿着正确密码的人**永远还是能登进来**。
 *
 * ## 代价（如实记录）
 *
 * 被大规模爆破期间，站长自己登录也会慢最多 `VANBLOG_LOGIN_THROTTLE_MAX_MS`（默认 3 秒）。
 * 这是有意选择的取舍：慢 3 秒 vs 登不进来。
 */
export const LOGIN_GLOBAL_FAIL_ENV = 'VANBLOG_LOGIN_GLOBAL_FAIL_PER_MIN';
export const LOGIN_THROTTLE_MAX_ENV = 'VANBLOG_LOGIN_THROTTLE_MAX_MS';
/** 默认阈值：全局每分钟 120 次失败才开始加延迟。 */
export const DEFAULT_LOGIN_GLOBAL_FAIL_PER_MIN = 120;
/** 默认封顶：3 秒。再长就开始影响正常可用性，而且拖着一堆挂起请求。 */
export const DEFAULT_LOGIN_THROTTLE_MAX_MS = 3000;
/** 全局窗口固定 1 分钟（不做成旋钮：窗口越长，攻击结束后惩罚正常用户的时间越久）。 */
export const LOGIN_GLOBAL_WINDOW_MS = 60 * 1000;
/** 每超出阈值一倍加多少毫秒（线性爬坡到封顶）。 */
export const LOGIN_THROTTLE_STEP_MS = 500;
/** 节流日志的最小间隔：被打的时候每个请求都打一条 WARN 等于自己给自己上日志炸弹。 */
const THROTTLE_LOG_INTERVAL_MS = 10 * 1000;

/**
 * 网段白名单（`VANBLOG_ADMIN_LOGIN_ALLOW_CIDR`）拒绝时返回的文案。
 *
 * ⚠️ **故意不说"你的 IP 不在白名单里"**：那等于告诉匿名探测者"这个站点配了网络限制"，
 * 于是他就知道该把力气花在别处（例如去研究 `VANBLOG_TRUST_FORWARDED_HEADERS` 的信任链，
 * 或者干脆不打登录接口）。403 这个状态码本身已经足够让**站长**区分"密码错"（401）与
 * "网络不允许"（403），而站长排障看的是服务端日志 —— 那里有一条写清 IP 与已配网段的 WARN。
 * 用"泄露更少"换"文案更含糊"在这里是划算的：被拒的人本来就不是我们要服务的人。
 */
export const LOGIN_CIDR_DENIED_MESSAGE = '登录请求被拒绝（原因见服务端日志）';

/** 网段拒绝的日志最小间隔：与节流同一个理由（被扫的时候不能自己制造日志炸弹）。 */
const CIDR_DENY_LOG_INTERVAL_MS = 10 * 1000;

/**
 * 解析全局阈值。
 *
 * ⚠️ 三种输入要分清，方向都是"别静默关掉防护"：
 *  - 没设 / 空串 → 默认值（120）；
 *  - **垃圾值**（`12O`、`abc`、NaN、Infinity）→ 默认值，**不是**关掉；
 *  - 显式 `0`（或负数）→ 关掉（这是唯一表达"我确实不想要"的方式）。
 */
export function resolveGlobalFailThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[LOGIN_GLOBAL_FAIL_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_LOGIN_GLOBAL_FAIL_PER_MIN;
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return DEFAULT_LOGIN_GLOBAL_FAIL_PER_MIN;
  if (n <= 0) return 0;
  return Math.min(Math.floor(n), 1_000_000);
}

/**
 * 纯函数：给定"窗口内全局失败数 / 阈值 / 封顶"，算出该给这次登录加多少毫秒延迟。
 *
 * 形状是线性爬坡：`ratio <= 1` ⇒ **0**（正常水位下任何人都不受影响），
 * 之后每超出阈值一倍加 `LOGIN_THROTTLE_STEP_MS`，到 `capMs` 封顶。
 * 默认值下：240 次/分 → 500ms，840 次/分及以上 → 3000ms。
 *
 * ⚠️ `threshold <= 0` 表示"关闭"，必须返回 0。别在这里再套 `scaleLimit()`：
 *    `scaleLimit(0)` 会被 `Math.max(1, …)` 兜成 **1**，于是"关掉"变成"1 次失败就节流全站"。
 *    摊薄由调用方在**传入之前**做（见 `globalThrottleDelayMs`）。
 */
export function computeLoginThrottleDelayMs(
  failures: number,
  threshold: number,
  capMs: number,
): number {
  if (!(threshold > 0)) return 0;
  if (!(failures > 0) || !Number.isFinite(failures)) return 0;
  const ratio = failures / threshold;
  const cap = Number.isFinite(capMs) && capMs > 0 ? capMs : DEFAULT_LOGIN_THROTTLE_MAX_MS;
  // ⚠️ `ramped > 0` 这一句同时承担两件事，别再单独加一条 `ratio <= 1` 的分支：
  //    ① 阈值以下（ratio<=1）时 `(ratio-1)*STEP` 是**负数**，floor 之后仍 <=0 ⇒ 返回 0；
  //    ② 恰好等于阈值（ratio==1）时 ramped=0 ⇒ 也是 0（"刚好到线"还不该罚）。
  //    变异对照实测过：单独那条 `ratio <= 1` 分支删掉后 20 条断言全绿 —— 它是**冗余**的，
  //    留着只会让人以为"零延迟"是靠它保证的，从而在改公式时漏掉真正的守卫。
  const ramped = Math.floor((ratio - 1) * LOGIN_THROTTLE_STEP_MS);
  if (!(ramped > 0)) return 0;
  return Math.min(cap, ramped);
}

/**
 * 全局失败计数：**一个对象，不是一张表**。
 *
 * ⚠️ 这是本文件唯一的模块级可变状态，而它必须是 O(1) 内存 ——
 *    "为了防止 DoS 又造一个无界 Map"是这类加固最常犯的自伤（本轮修的
 *    `CacheProvider` 无界增长就是这么来的）。这里只记"当前窗口的起点与总数"，
 *    与多少个不同 IP 无关，所以一百万个肉鸡也占同样多的内存。
 */
interface GlobalFailWindow {
  start: number;
  count: number;
}
let globalFailWindow: GlobalFailWindow = { start: 0, count: 0 };
let lastThrottleLogAt = 0;

/**
 * 网段白名单拒绝的日志节流状态。
 *
 * ⚠️ 与 `globalFailWindow` 同样的纪律：**一个对象，不是一张表**（不做 `Map<ip, …>`），
 * 整体替换而不是增量 mutate，所以它不可能无界增长 —— 这个判定跑在限流**之前**，
 * 是匿名可达的，任何按对端 IP 建键的状态都会变成内存 DoS。
 * `suppressed` 让"被扫了 4 万次"这件事在日志里仍然看得见（下一条 WARN 会带上累计条数），
 * 而不是只留下每 10 秒一条、看不出量级的记录。
 */
let cidrDenyLog: { at: number; suppressed: number } = { at: 0, suppressed: 0 };

/** 记一次全局失败，返回当前窗口内的累计数。窗口过期就重开。 */
export function noteGlobalLoginFailure(now: number = Date.now()): number {
  if (now - globalFailWindow.start >= LOGIN_GLOBAL_WINDOW_MS) {
    globalFailWindow = { start: now, count: 1 };
  } else {
    globalFailWindow.count += 1;
  }
  return globalFailWindow.count;
}

/** 当前窗口内的全局失败数（窗口已过 ⇒ 0）。只读，不改状态。 */
export function currentGlobalLoginFailures(now: number = Date.now()): number {
  if (now - globalFailWindow.start >= LOGIN_GLOBAL_WINDOW_MS) return 0;
  return globalFailWindow.count;
}

/** 测试专用：清掉全局窗口与日志节流时间戳。 */
export function __resetLoginThrottleForTest(): void {
  globalFailWindow = { start: 0, count: 0 };
  lastThrottleLogAt = 0;
  cidrDenyLog = { at: 0, suppressed: 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 别让一个节流用的定时器把进程吊住（优雅退出时不该等它）
    if (typeof (timer as any)?.unref === 'function') {
      (timer as any).unref();
    }
  });
}

/**
 * 登录防爆破。
 *
 * 旧实现有三个问题：
 * 1. **把成功登录也算成一次失败**：守卫在认证之前跑，无论结果都 `count+1`，
 *    于是正常用户一分钟内登录 4 次（比如换浏览器、退出重进）就被锁在门外；
 * 2. 阈值写死 3 次 / 60 秒，设置里的 `maxRetryTimes` / `durationSeconds` 根本没被读；
 * 3. 取 IP 用的是 `getNetIp()`——它会去请求第三方 `cip.cc`，没有超时，
 *    离线环境下每次登录都要等外网。限流只需要本地 IP。
 *
 * 现在：守卫只做「是否已超限」的判断，计数由 controller 在**认证失败**时调用
 * `recordFailure()`，成功时调用 `reset()`。
 *
 * ⚠️ **计数存在 `utils/attemptLimit.ts` 那张有界的表里，不再存 `CacheProvider`。**
 *    `CacheProvider` 是一张没有任何上界、没有过期清扫的普通对象，而这里的 key 是
 *    `login-<客户端 IP>` ⇒ 攻击者只要不断换源 IP（僵尸网络，或 `VANBLOG_TRUST_FORWARDED_HEADERS=auto`
 *    下不断换 XFF 最右一跳）就能让堆单调增长直到 OOM，把容器打成 crash-loop。
 *    这是**匿名可达、不需要任何凭据**的拒绝服务。搬到 attemptLimit 之后受
 *    `MAX_BUCKETS`(20000) 与"满表按 count 淘汰最冷"的保护：洪水桶（count=1）先走，
 *    正在被限流的热桶（count>1）一条都不动。
 *    顺带的好处：成功登录不再写入任何东西（`resetAttempts` 是**删除**，
 *    而旧实现会给每个成功登录的 IP 写一条 `{count:0}` 记录）。
 */
@Injectable()
export class LoginGuard implements CanActivate {
  logger = new Logger(LoginGuard.name);
  constructor(private settingProvider: SettingProvider) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    // ⚠️ 网段白名单放在**最前面**，比 `inspect()`（要读一次设置）与 `AuthGuard('local')`
    //    （要跑一次 scrypt，约 63ms）都早：不在允许网段里的请求不该消耗任何数据库读或哈希算力。
    //    这也意味着"用不在白名单里的 IP 猛打登录"不会变成 scrypt 的放大器。
    this.assertLoginNetworkAllowed(request);
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
    // 全局节流：per-IP 桶没超限，但整站正在被大规模爆破 ⇒ 加一点延迟抬高撞库成本。
    // ⚠️ 只在"放行"的分支上做：已经被 per-IP 限制拒掉的请求立刻返回，没必要再拖 3 秒。
    const delayMs = this.globalThrottleDelayMs();
    if (delayMs > 0) {
      await sleep(delayMs);
      this.logThrottled(delayMs);
    }
    return true;
  }

  /**
   * 当前该给登录请求加多少毫秒延迟（0 = 不加）。
   * 阈值按 worker 数摊薄，与其它内存计数口径一致（每进程只看到 1/N 的失败）。
   */
  globalThrottleDelayMs(now: number = Date.now()): number {
    const configured = resolveGlobalFailThreshold();
    if (configured <= 0) return 0;
    const threshold = scaleLimit(configured);
    const capMs = envPositiveInt(
      LOGIN_THROTTLE_MAX_ENV,
      DEFAULT_LOGIN_THROTTLE_MAX_MS,
      100,
      30_000,
    );
    return computeLoginThrottleDelayMs(currentGlobalLoginFailures(now), threshold, capMs);
  }

  /** 节流期间每 10 秒最多一条 WARN（被洪水打的时候不能自己制造日志炸弹）。 */
  private logThrottled(delayMs: number, now: number = Date.now()): void {
    if (now - lastThrottleLogAt < THROTTLE_LOG_INTERVAL_MS) return;
    lastThrottleLogAt = now;
    const failures = currentGlobalLoginFailures(now);
    this.logger.warn(
      `全局登录失败速率偏高，正在给所有登录请求增加 ${delayMs}ms 延迟以抬高撞库成本` +
        `（最近 1 分钟失败 ${failures} 次，阈值 ${scaleLimit(resolveGlobalFailThreshold())}/进程）。` +
        `这不是封禁：密码正确的用户仍然能登录，只是慢一点。` +
        `调节：${LOGIN_GLOBAL_FAIL_ENV}（每分钟失败数，0=关闭）、${LOGIN_THROTTLE_MAX_ENV}（延迟封顶毫秒）。`,
    );
  }

  /**
   * 「只允许某些网段登录后台」（`VANBLOG_ADMIN_LOGIN_ALLOW_CIDR`，默认空 = 不限制）。
   *
   * ## IP 口径：为什么复用 `bruteForceClientIp()` 而不是"独立取套接字地址"
   *
   * 直觉上白名单应该用套接字地址（"不可伪造"），但在**本项目默认的一体式部署**里那是错的：
   * caddy 与 server 在同一个容器，caddy 从 `127.0.0.1` 拨到 `127.0.0.1:3000`
   * ⇒ **所有访客的套接字地址都是回环**（`utils/trustedProxy.ts:217-223` 记录了这件事，
   * 并且正是因为这个形状，防爆破计数才从套接字口径改成了 trusted 口径）。
   * 于是"独立取套接字"会让这个功能只有两种结局：
   *   - 站长填自己 VPN 的公网网段 ⇒ 永远匹配不上 ⇒ **把自己永久锁在门外**；
   *   - 站长为了能用而填 `127.0.0.1/32` ⇒ 匹配所有访客 ⇒ **白名单形同不存在**，
   *     而且它会显示为"已启用"，比没配更危险。
   *
   * `bruteForceClientIp()` 已经把这件事处理对了：默认 `auto` 模式下，只有当套接字对端是
   * 回环/私网（= 我自己的反代）时才采信 `X-Forwarded-For`，而且取的是**最右一跳**
   * （可信代理亲手追加的那个），客户端自己塞的伪造值会落在它左边、取不到；
   * 站点直接暴露时（对端是公网地址）转发头一律不采信 ⇒ 用的就是套接字地址。
   *
   * ## 复用同一个口径带来的另一个好处
   *
   * `VANBLOG_BRUTE_FORCE_IP_SOURCE=socket` 这个既有旋钮会**同时**作用于白名单
   * （因为两者调的是同一个函数）。这正是想要的：全站只有一种"客户端 IP"的定义，
   * 不会出现"限流按 A 口径、白名单按 B 口径"这种谁也说不清的分裂。
   *
   * ## 如实说明边界（会写进文档）
   *
   * 白名单的强度**取决于转发头的可信度**：如果运维把 `VANBLOG_TRUST_FORWARDED_HEADERS`
   * 设成 `always` 而站点又是直接暴露的，或者反代是"原样透传客户端给的 XFF"而不是
   * "追加自己看到的对端"，那么攻击者可以伪造一个白名单内的 IP 绕过。
   * 这两种情况下的正确做法是把 `VANBLOG_BRUTE_FORCE_IP_SOURCE` 设成 `socket`
   * （前提是 Node 能直接看到真实对端，也就是**不是**一体式容器内 caddy 那种拓扑）。
   */
  private assertLoginNetworkAllowed(req: any): void {
    const policy = resolveAdminLoginCidrPolicy();
    if (policy.kind === 'disabled') {
      return;
    }
    const ip = bruteForceClientIp(req);
    if (policy.kind === 'invalid') {
      this.logCidrDenied(ip, policy.ranges, policy.invalid);
      throw new ForbiddenException({
        statusCode: 403,
        message: LOGIN_CIDR_DENIED_MESSAGE,
      });
    }
    if (isIpAllowedByPolicy(policy, ip)) {
      return;
    }
    this.logCidrDenied(ip, policy.ranges, null);
    throw new ForbiddenException({
      statusCode: 403,
      message: LOGIN_CIDR_DENIED_MESSAGE,
    });
  }

  /**
   * 网段拒绝的 WARN：每 10 秒最多一条，但**累计条数会带在下一条里**（被扫的量级不能丢）。
   *
   * ⚠️ 这里特意多给一条排障提示：如果被拒的"客户端 IP"是回环/私网，而站长配的网段里没有
   * 任何私网段，那几乎一定是转发头没被采信（`VANBLOG_TRUST_FORWARDED_HEADERS=never`，
   * 或反代覆盖 XFF）—— 这正是"我明明配对了却把自己锁在门外"最常见的原因。
   */
  private logCidrDenied(ip: string, ranges: string[], invalid: string[] | null): void {
    const now = Date.now();
    if (now - cidrDenyLog.at < CIDR_DENY_LOG_INTERVAL_MS) {
      cidrDenyLog = { at: cidrDenyLog.at, suppressed: cidrDenyLog.suppressed + 1 };
      return;
    }
    const suppressed = cidrDenyLog.suppressed;
    cidrDenyLog = { at: now, suppressed: 0 };
    if (invalid) {
      this.logger.error(
        `${ADMIN_LOGIN_ALLOW_CIDR_ENV} 配置里有非法项，登录已**全部拒绝**（失败关闭）：` +
          `非法=${JSON.stringify(invalid)}；已解析出的合法项=${JSON.stringify(ranges)}。` +
          `请修正后重启（或清空该变量以取消限制）。合法形状：` +
          `203.0.113.0/24、198.51.100.7/32、198.51.100.7（裸 IP 等价 /32）、2001:db8::/32。`,
      );
      return;
    }
    const hint =
      isPrivateOrLoopback(ip) && !ranges.some((range) => isPrivateOrLoopback(range.split('/')[0]))
        ? '⚠️ 判定到的客户端地址是回环/私网，而白名单里没有私网段：如果你不是在容器内本地登录，' +
          '这通常意味着转发头没被采信（检查 VANBLOG_TRUST_FORWARDED_HEADERS，或反代是否在覆盖而不是追加 X-Forwarded-For）。'
        : '';
    this.logger.warn(
      `登录被网段白名单拒绝\nip: ${ip}\n允许: ${JSON.stringify(ranges)}` +
        (suppressed > 0 ? `\n（过去 10 秒内另有 ${suppressed} 次被拒，未逐条记录）` : '') +
        (hint ? `\n${hint}` : ''),
    );
  }

  /** 取限流用的缓存 key；拿不到 IP 也不返回空串（所有无 IP 的请求共用一个桶）。 */
  /**
   * 限流的 key 必须用**不可被请求头随意左右**的来源：cf-connecting-ip / x-real-ip /
   * x-forwarded-for 这些客户端想写什么就写什么 —— 攻击者每次换一个 X-Real-IP 就能无限次
   * 试密码，反过来还能用受害者的真实 IP 把对方锁在门外。
   * 部署在反代后面时套接字地址是反代本身，此时所有请求共用一个桶（更严格，不会更松）。
   */
  private keyOf(req: any): string {
    // ⚠️ 以前这里固定用套接字地址，理由是"不可伪造"，而那个理由在一体式部署下是错的：
    // caddy 从 127.0.0.1 拨过来 ⇒ 所有访客共用一个桶 ⇒
    // 5 个请求就能把**带正确密码的人**锁在门外，且每 5 分钟可续期（后台永久 DoS）。
    // 现在走 bruteForceClientIp()：默认 trusted（auto 模式下取 XFF 最右一跳，
    // 客户端伪造的头会被 caddy 追加到自己 IP 的左边，所以既绕不过也栽赃不了），
    // 反代是"覆盖 XFF"而不是"追加"的部署可以用 VANBLOG_BRUTE_FORCE_IP_SOURCE=socket 退回去。
    const ip = bruteForceClientIp(req);
    return ip ? `login-${ip}` : 'login-unknown';
  }

  /** 设置里没有登录配置时默认开启（老站点显式关掉的仍然尊重其选择）。 */
  private async resolveLimits() {
    const setting = await this.settingProvider.getLoginSetting();
    const enabled = setting ? setting.enableMaxLoginRetry !== false : true;
    // ⚠️ 失败计数是**每进程内存**里的：多进程部署时同一个 IP 的尝试会被轮流分到 N 个
    // worker，每个都只看到 1/N ⇒ 实际的爆破预算变成 N 倍。这里按 worker 数摊薄
    // （单进程时除数是 1，值不变）；摊薄是近似的，但偏差方向是"更严"，
    // 对防爆破来说是安全的那一侧。
    const configuredMax =
      Number(setting?.maxRetryTimes) > 0
        ? Number(setting.maxRetryTimes)
        : DEFAULT_MAX_LOGIN_RETRY;
    const max = scaleLimit(configuredMax);
    const windowSeconds =
      Number(setting?.durationSeconds) > 0
        ? Number(setting.durationSeconds)
        : DEFAULT_LOGIN_WINDOW_SECONDS;
    return { enabled, max, windowSeconds };
  }

  /** 只读判断：当前是否还允许尝试登录。 */
  async inspect(req: any): Promise<{ allowed: boolean; ip: string; count: number; retryAfterSeconds: number }> {
    const ip = bruteForceClientIp(req);
    const key = this.keyOf(req);
    const { enabled, max, windowSeconds } = await this.resolveLimits();
    if (!enabled || !key) {
      return { allowed: true, ip, count: 0, retryAfterSeconds: 0 };
    }
    // `peekAttempts` 是只读的：不建桶、不计数。判定发生在**认证之前**，
    // 计数发生在**认证失败之后**（`recordFailure`）——两件事必须分开，
    // 否则成功登录也会被算成一次失败（见文件头注释的第 1 条）。
    const snapshot = peekAttempts(key, { max, windowMs: windowSeconds * 1000 });
    return {
      allowed: !snapshot.blocked,
      ip,
      count: snapshot.count,
      retryAfterSeconds: snapshot.retryAfterSeconds,
    };
  }

  /** 认证失败时调用：开新窗口或累加，并计入全局节流窗口。返回该 IP 的累计失败数。 */
  async recordFailure(req: any): Promise<number> {
    const key = this.keyOf(req);
    // 全局计数**无条件**记：它衡量的是"整站正在承受多少撞库压力"，
    // 与 per-IP 限制有没有开、这个 IP 有没有超限都无关。
    noteGlobalLoginFailure();
    if (!key) {
      return 0;
    }
    const { enabled, windowSeconds } = await this.resolveLimits();
    if (!enabled) {
      return 0;
    }
    return recordFailureAttempt(key, { windowMs: windowSeconds * 1000 });
  }

  /** 登录成功时调用：删掉这个 IP 的失败窗口，避免正常用户被历史失败拖累。 */
  async reset(req: any): Promise<void> {
    const key = this.keyOf(req);
    if (key) {
      // ⚠️ 是**删除**而不是写一条 `{count:0}`：旧实现给每个成功登录的 IP 都留了一条记录，
      //    那本身就是无界增长的一个来源（虽然比失败那条慢）。
      // ⚠️ 不动全局窗口：一次成功登录不该把"整站正在被打"的证据抹掉
      //    （否则攻击者只要有一个能登进去的号就能一直清空节流）。
      resetAttempts(key);
    }
  }
}
