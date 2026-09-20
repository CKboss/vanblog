import { Injectable, Logger } from '@nestjs/common';

/**
 * 一个**极小的、只放固定几个键**的进程内键值存储。
 *
 * ⚠️ 它不是通用缓存，也**不能**当通用缓存用：这张表没有 TTL、没有 LRU、
 * 不做任何过期清扫（见下面 `MAX_ENTRIES` 的说明）。目前唯一的键是 `restoreKey`
 * （「忘记密码」流程的一次性恢复密钥，`init.provider.ts` 写、`getString()` 读）。
 *
 * ## 为什么现在有条数上限
 *
 * 这里曾经还存着**登录防爆破的失败窗口**，键形如 `login-<客户端 IP>`。
 * 那是个匿名可驱动的无界增长：攻击者不断换源 IP（僵尸网络，或
 * `VANBLOG_TRUST_FORWARDED_HEADERS=auto` 下不断换 XFF 最右一跳）就能让堆单调增长
 * 直到 OOM，把容器打成 crash-loop —— 不需要任何凭据。
 * 那份状态已经搬到 `utils/attemptLimit.ts`（有 `MAX_BUCKETS`、过期清扫、
 * 满表按 count 淘汰最冷的桶）。
 *
 * 搬走之后这张表就只剩固定键了，但**"以后有人再往这里塞一个按外部输入分桶的键"
 * 是必然会发生的**（这正是刚才那个洞的成因）。所以这里加了一道硬上限：
 * 超过 `MAX_ENTRIES` 个**不同的键**就**拒绝写入并打 ERROR**，把静默的堆增长
 * 变成一条响亮的日志。
 *
 * ⚠️ 为什么是"拒绝"而不是"淘汰最旧的"：这张表里放的是**凭据**（恢复密钥）。
 *    一旦某个键被静默淘汰，「忘记密码」这条自救通道就没了，而它恰恰是站长在
 *    后台被锁死时唯一的出路。宁可让误用者立刻在日志里看见错误，
 *    也不能让一个凭据悄无声息地消失。
 *    ⇒ 如果你需要"按 IP / 按路径 / 按文章 id 分桶"的计数或缓存，
 *      请用 `utils/attemptLimit.ts`（计数）或另写一个**带上界与过期**的结构。
 */
export const MAX_ENTRIES = 64;

/**
 * 永远可写的键（**不受上限约束**）。
 *
 * `restoreKey` 是站长被锁在后台外面时唯一的自救通道（「忘记密码」流程），
 * 它不能因为"某个未来的人把这张表塞满了"而写不进去 —— 那会把一次误用
 * 变成"管理员永久失联"。这些键名是**代码里写死的常量、不受外部输入影响**，
 * 所以豁免它们不会重新引入无界增长：攻击者没法用它们造出第 65 个键。
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['restoreKey']);

@Injectable()
export class CacheProvider {
  private logger = new Logger(CacheProvider.name);
  data: Record<string, any> = {};
  /** 因超上限被拒绝的写入次数（可观测面，别在请求路径上打日志） */
  private refused = 0;
  /** 已经为哪些键打过 ERROR，避免同一个键把日志刷满 */
  private warnedKeys = new Set<string>();

  /**
   * ⚠️ **键缺失时返回 `{}` 而不是 `undefined`** —— 历史行为，保留不动。
   *
   * 但它对**任何拿返回值做相等比较**的调用方都是陷阱：`"[object Object]" != {}` 在 JS 里是
   * **false**（对象先转原始值），于是"缓存里没有密钥"会变成"密钥校验通过"。
   * `/api/admin/auth/restore` 曾经就是这样被匿名绕过的（详见
   * `init.provider.ts` 的 `getRestoreKeyForVerification` 注释）。
   * 当年依赖这个 `{}` 的是 `login.guard.ts` 的防爆破窗口（拿到空对象后按"没有字段"处理）；
   * 那份状态已经搬到 `utils/attemptLimit.ts`，所以现在**生产代码里没有调用方**了。
   *
   * ⇒ 要取字符串类的值（密钥、令牌、路径…）请用下面的 `getString()`，它会做类型与长度校验，
   *   拿不到就返回 `null`，让调用方**失败关闭**。新代码不要再用 `get()`。
   */
  get(key: string) {
    return this.data?.[key] || {};
  }

  /**
   * 取一个字符串值；不是字符串、或长度不足 `minLength` 时返回 `null`（不返回 `{}`、不返回空串）。
   * 用途：凭据/密钥类比较。`null` 的语义是"没有这个值"，调用方必须拒绝请求而不是继续比。
   */
  getString(key: string, minLength = 32): string | null {
    const v = this.data?.[key];
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    if (trimmed.length < minLength) return null;
    return trimmed;
  }

  /**
   * 写一个键。
   *
   * @returns `true` = 写入成功；`false` = 因为超过 `MAX_ENTRIES` 被拒绝（已打 ERROR）。
   *   ⚠️ 两种写入**永远成功**：覆盖已存在的键，以及写 `RESERVED_KEYS` 里的键
   *   （`restoreKey` —— 站长被锁在门外时唯一的自救通道，不能因为表被误用塞满就写不进去）。
   *   上限只管"新增其它不同的键"，也就是只管"有人把它当通用缓存用"这一种误用。
   */
  set(key: string, value: any): boolean {
    const k = typeof key === 'string' ? key : String(key ?? '');
    if (!Object.prototype.hasOwnProperty.call(this.data, k) && !RESERVED_KEYS.has(k)) {
      const size = Object.keys(this.data).length;
      if (size >= MAX_ENTRIES) {
        this.refused += 1;
        // 每个键只打一次：被洪水打的时候，日志本身也会变成一种资源消耗
        if (!this.warnedKeys.has(k) && this.warnedKeys.size < MAX_ENTRIES) {
          this.warnedKeys.add(k);
          this.logger.error(
            `CacheProvider 已满（${size}/${MAX_ENTRIES} 个键），拒绝写入新键「${k.slice(0, 80)}」。` +
              `这不是通用缓存：它没有 TTL 也没有淘汰，按 IP / 路径 / id 之类的**外部输入**分桶会让堆无界增长` +
              `（登录防爆破窗口以前就是这么放的，攻击者换源 IP 就能把进程打到 OOM）。` +
              `计数请改用 utils/attemptLimit.ts（有 MAX_BUCKETS 与按 count 淘汰最冷），` +
              `缓存请另写一个带上界与过期的结构。`,
          );
        }
        return false;
      }
    }
    this.data[k] = value;
    return true;
  }

  /** 只读的可观测面：当前键数、上限、被拒绝的写入次数（测试与排障用）。 */
  stats(): { size: number; maxEntries: number; refused: number } {
    return {
      size: Object.keys(this.data).length,
      maxEntries: MAX_ENTRIES,
      refused: this.refused,
    };
  }

  /** 测试专用：清空表与计数（生产代码不要调）。 */
  __resetForTest(): void {
    this.data = {};
    this.refused = 0;
    this.warnedKeys = new Set<string>();
  }
}
