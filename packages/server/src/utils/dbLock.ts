/**
 * 基于 MongoDB 的 **TTL 互斥锁**（跨进程）。
 *
 * ## 为什么需要它
 *
 * 「初始化 / 初始化页恢复」这两条匿名接口原先只有一个**模块级布尔量**做单飞互斥
 * （`init.controller.ts` 里的 `initRestoreRunning`）。那是**每进程一份**的：
 * `VANBLOG_CLUSTER_WORKERS` 是文档化旋钮（支持 `auto`/`cpus`/`max`/N，多核机上 >1），
 * 两个并发请求落到不同 worker 时，两边各自的布尔量都是 false ⇒
 *  - 两个 `/init` 都通过 `checkHasInited()` ⇒ **造出两个 `id:0` 的管理员**
 *    （`getUser()` 是 `findOne({id:0})` 且**无排序**，于是"谁是管理员"随返回顺序漂移）；
 *  - 两个 `/init/restore` 同时做「临时集合 + 原子替换 + 重建索引」⇒ 互相踩，得到**半新半旧的库**。
 * init 桶限流（5 次/10 分钟/IP）只降概率，两个不同来源就够了。
 *
 * 所以互斥量必须落在**所有进程都看得见的地方** —— 也就是数据库。
 *
 * ## 实现要点（每一条都是坑，别"简化"掉）
 *
 * 1. **唯一性靠 `_id`**。锁文档的 `_id` 就是锁名，不用别的字段做唯一约束：
 *    并发 upsert 时只有插入 `_id` 成功的那一个赢，另一个必然拿到 duplicate key（E11000）。
 *    用别的字段（哪怕建了唯一索引）就得自己处理"两条文档"的收尾。
 * 2. **抢锁与接管过期锁是同一条原子语句**，不是"先查再写"：
 *    `findOneAndUpdate({_id: name, expiresAt: {$lte: now}}, {$set: {...}}, {upsert: true})`
 *    - 锁不存在 ⇒ 过滤条件匹配不到 ⇒ upsert **插入**，插入成功即持锁；
 *    - 锁存在但**已过期** ⇒ 过滤条件匹配到 ⇒ `$set` 直接改写 owner，即"接管"；
 *    - 锁存在且**仍有效** ⇒ 匹配不到 ⇒ upsert 试图插入同一个 `_id` ⇒ **E11000** ⇒ 判"没抢到"。
 *    ⚠️ 过期锁**必须**能被接管：进程被 SIGKILL / OOM 杀掉时 `finally` 不会执行，
 *    没有接管的话那把锁会永久卡住，而站点又还没初始化 ⇒ 用户既进不了后台也恢复不了，
 *    只能重启容器（这正是 §7.55 B 里"锁必须在失败后释放"那条教训的跨进程版本）。
 * 3. **释放必须校验持有者**（`owner` 是随机串）：A 的锁超时被 B 接管之后，
 *    A 姗姗来迟的 `finally` 若无条件删除，就会把 **B 正在用的锁**删掉，第三个请求又能进来。
 *    所以释放的过滤条件是 `{_id: name, owner}`，删不掉就说明已经不是自己的了。
 * 4. **不猜"插入成功"**：即使驱动返回了文档，也要核 `doc.owner === 自己的 owner`
 *    才算持锁（防御驱动/包装层在 `returnDocument` 语义上的差异）。
 *
 * ## TTL 怎么定
 *
 * 默认 **30 分钟**，可用 `VANBLOG_INIT_LOCK_TTL_MINUTES` 配（夹在 1–1440 分钟，
 * 非数字/0/负数一律回落默认，**绝不因为写错就变成"永不过期"**）。
 * 取舍：TTL 必须**大于最长的一次整站恢复**（几分钟量级，慢盘 + 大归档会更久），
 * 否则恢复途中锁过期被别人接管 ⇒ 两个恢复叠在一起；但 TTL 太长又意味着进程被硬杀之后
 * 站点要空等那么久才能重试。30 分钟对两边都够宽，真需要就调这个变量。
 *
 * ## 锁文档放在哪
 *
 * 独立集合 `vanblog_locks`，**不污染业务集合**（不用 `settings`：那是整站备份会导出、
 * 恢复会覆盖的集合，把锁状态混进去等于让归档带着锁状态跨机器传播）。
 * ⚠️ 但要知道：`fullBackup` 是遍历 `db.collections()` 全量导出的，所以这个集合**也会进归档**。
 * 后果有限且已被本实现兜住 —— 恢复出来的锁要么已过期（可接管），要么最多让目标站点
 * 在 TTL 内不能再次初始化/恢复；而恢复成功之后站点就已初始化，这两条接口本来就关了。
 */

/** 锁文档所在的集合名（独立集合，理由见文件头） */
export const DB_LOCK_COLLECTION = 'vanblog_locks';

/** 「初始化 / 初始化页恢复」共用的锁名：它们互斥的是同一件事 —— 站点身份的确立 */
export const INIT_RESTORE_LOCK_NAME = 'init-restore';

export const INIT_LOCK_TTL_MINUTES_ENV = 'VANBLOG_INIT_LOCK_TTL_MINUTES';
export const DEFAULT_INIT_LOCK_TTL_MINUTES = 30;
const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 1440; // 24 小时

/**
 * 锁需要的最小集合能力（duck-typed）。
 *
 * ⚠️ 故意不依赖 Mongoose 的类型：生产传的是 `connection.collection(...)`，
 * 测试传的是内存假实现。这样锁语义可以**真的被并发测到**，而不是只断言"调用过 findOneAndUpdate"。
 */
export interface LockCollection {
  findOneAndUpdate(filter: any, update: any, options?: any): Promise<any>;
  deleteOne(filter: any): Promise<any>;
}

export interface DbLockHandle {
  /** 锁名 */
  name: string;
  /** 持有者凭据（随机串）：释放时要用它证明"这把锁还是我的" */
  owner: string;
  /** 过期时间戳（ms）；仅用于日志与诊断 */
  expiresAt: number;
}

/** 三态结果：调用方必须能区分"被人持有"与"根本没有可用的锁后端" */
export type DbLockOutcome =
  | { kind: 'acquired'; handle: DbLockHandle }
  | { kind: 'busy'; heldBy?: string; expiresAt?: number }
  | { kind: 'unavailable'; reason: string };

/** 解析 TTL（分钟 → 毫秒）。非法值回落默认，绝不回落成"永不过期"。 */
export function initLockTtlMs(raw: unknown = process.env[INIT_LOCK_TTL_MINUTES_ENV]): number {
  const n = Number(typeof raw === 'string' ? raw.trim() : raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INIT_LOCK_TTL_MINUTES * 60_000;
  const clamped = Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.trunc(n)));
  return clamped * 60_000;
}

/** duplicate key（E11000）= 别人已经插入了同一个 `_id` = 锁被持有 */
function isDuplicateKeyError(err: any): boolean {
  if (!err) return false;
  if (err.code === 11000 || err.code === 'E11000') return true;
  // 有些包装层把 code 塞在 cause / errInfo 里
  if (err.cause && (err.cause.code === 11000 || err.cause.codeName === 'DuplicateKey')) return true;
  if (err.errInfo && err.errInfo.code === 11000) return true;
  return /E11000|duplicate key/i.test(String(err.message || err));
}

function makeOwner(prefix: string): string {
  // 不引入新依赖：进程号 + 时间 + 随机数足够唯一（同一毫秒内两个进程也不会撞）
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${rand}`;
}

/** 驱动/包装层在 `returnDocument` 语义上有差异：`{value: doc}` 与 `doc` 都要认 */
function unwrapDoc(res: any): any {
  if (!res) return null;
  if (typeof res === 'object' && 'value' in res) return (res as any).value ?? null;
  return res;
}

export interface AcquireOptions {
  ttlMs?: number;
  ownerPrefix?: string;
  /** 仅测试用：注入时钟 */
  now?: () => number;
}

/**
 * 抢锁。**不抛异常**：任何后端故障都归一成 `{kind:'unavailable'}`，
 * 由调用方决定是降级（单进程仍可安全）还是拒绝（不能安全降级时）。
 */
export async function acquireDbLock(
  coll: LockCollection | null | undefined,
  name: string,
  options: AcquireOptions = {},
): Promise<DbLockOutcome> {
  if (!coll || typeof coll.findOneAndUpdate !== 'function') {
    return { kind: 'unavailable', reason: 'no-lock-collection' };
  }
  const now = (options.now ?? Date.now)();
  const ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : initLockTtlMs();
  const owner = makeOwner(options.ownerPrefix ?? 'lock');
  const expiresAt = now + ttlMs;
  try {
    const res = await coll.findOneAndUpdate(
      // 匹配"不存在或已过期"；存在且有效时匹配不到 ⇒ upsert 撞 _id ⇒ E11000
      { _id: name, expiresAt: { $lte: now } },
      { $set: { owner, takenAt: now, expiresAt, pid: process.pid } },
      { upsert: true, returnDocument: 'after' },
    );
    const doc = unwrapDoc(res);
    //  belt-and-braces：拿回来的文档必须写着我们的 owner，否则不算持锁
    if (doc && doc.owner === owner) {
      return { kind: 'acquired', handle: { name, owner, expiresAt } };
    }
    if (doc) {
      return { kind: 'busy', heldBy: String(doc.owner ?? ''), expiresAt: Number(doc.expiresAt) || undefined };
    }
    // 驱动在"匹配不到且没插入"时可能返回 null：按"被占用"处理，绝不假设自己拿到了
    return { kind: 'busy' };
  } catch (err: any) {
    if (isDuplicateKeyError(err)) return { kind: 'busy' };
    return { kind: 'unavailable', reason: String(err?.message || err).slice(0, 200) };
  }
}

/**
 * 释放锁。**必须带 owner**：只删自己的那把。
 * @returns true = 确实删掉了自己的锁；false = 已经不是自己的了（超时被接管），这不是错误。
 */
export async function releaseDbLock(
  coll: LockCollection | null | undefined,
  name: string,
  owner: string,
): Promise<boolean> {
  if (!coll || typeof owner !== 'string' || !owner) return false;
  try {
    if (typeof coll.deleteOne === 'function') {
      const res = await coll.deleteOne({ _id: name, owner });
      const n = Number(res?.deletedCount ?? res?.result?.n ?? 0);
      return n > 0;
    }
    // 没有 deleteOne 的包装层：退化成"把 owner 清空并立刻过期"，效果等价（下一次 acquire 能接管）
    const res = await coll.findOneAndUpdate(
      { _id: name, owner },
      { $set: { owner: '', releasedAt: Date.now(), expiresAt: 0 } },
      { returnDocument: 'after' },
    );
    return unwrapDoc(res) !== null;
  } catch {
    return false;
  }
}
