import { BadRequestException } from '@nestjs/common';
import { loadMongoUrl } from 'src/config';
import { MongoClient } from 'mongodb';
import * as crypto from 'crypto';
import { makeSalt } from './crypto';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 读（或第一次生成）后台会话用的 jwt 密钥。
 *
 * ⚠️ 这个函数在启动时会被调用**两次**：一次来自 `main.ts`（要塞进 `global.jwtSecret`，
 * 而它必须早于 NestFactory.create），一次来自 `app.module.ts` 里 `JwtModule.registerAsync`
 * 的工厂。以前两次各建一个 `MongoClient`、连上、查一行、**然后都不 close** ——
 * 每个泄漏的 client 都带着自己的连接池与 SDAM 心跳定时器（serverSelection/monitoring），
 * 白白占着 fd、内存和一份每 10 秒一次的 hello 轮询。
 *
 * 现在：结果按 Promise 记忆化（两次调用只会真的连一次），且用完 `finally` 里关掉 client。
 * 失败时把记忆清掉，让下一次调用还能重试（否则一次网络抖动就把整个启动钉死在同一个
 * rejected promise 上）。
 */
let cached: Promise<string> | null = null;

/** 进程内的密钥态：当前密钥 + 宽限期内的上一个密钥。由 `initJwt()` 装载、`rotateJwtSecret()` 更新。 */
let keyState: JwtKeyState | null = null;

/**
 * 作废记忆化的密钥缓存。
 *
 * 两个调用场景，缺一个就会出事：
 *  1) **轮换之后**：`rotateJwtSecret` 自己会更新内存态，但 `cached` 那个 Promise
 *     仍然解析成旧密钥，任何"重启前又调了一次 initJwt"的路径都会把旧密钥装回去；
 *  2) **整站恢复之后**：库里的 `settings{type:'jwt'}` 被归档那份整体覆盖了，
 *     而本进程的内存态还是恢复前的密钥 ⇒ 继续用旧密钥签发，重启后全部失效。
 */
export function invalidateJwtSecretCache(): void {
  cached = null;
  keyState = null;
}

export const initJwt = (): Promise<string> => {
  if (!cached) {
    cached = readOrCreateJwtSecret()
      .then((state) => {
        keyState = state;
        return state.secret;
      })
      .catch((err) => {
        cached = null;
        throw err;
      });
  } else {
    // eslint-disable-next-line no-console
    console.log('[initJwt] 复用已读取的 jwt 密钥（不再新建 MongoClient）');
  }
  return cached;
};

export interface JwtPreviousKey {
  secret: string;
  /** 这个密钥**不再是当前密钥**的时刻（ISO）。宽限期从这里起算。 */
  rotatedAt: string;
  /**
   * **当次**轮换时定的宽限期（天）。
   *
   * ⚠️ 必须随记录一起存，不能在验签时现读 env：
   *  1) 传 `graceDays: 0`（"立刻踢掉所有人"）时，如果验签去看 env（默认 7 天），
   *     这个 0 就被静默忽略了 —— 实测过，旧 token 照样验得过；
   *  2) 站长事后改 env 不该**追溯**改变已经生效的那次宽限期
   *     （把 7 天改成 1 天会让在线用户在毫无预警的情况下掉线）。
   * 缺失（老记录）时回落到 env/默认值。
   */
  graceDays?: number;
}

export interface JwtKeyState {
  secret: string;
  previous: JwtPreviousKey | null;
}

const readOrCreateJwtSecret = async (): Promise<JwtKeyState> => {
  const mongoUrl = await loadMongoUrl();
  // eslint-disable-next-line no-console
  console.log('[initJwt] 连接 MongoDB 读取 jwt 密钥');
  const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 10000 });
  // ⚠️ 这是 server 启动后**第一次**碰数据库，而且发生在 unhandledRejection 兜底装上之前。
  // compose 的 depends_on 只保证"先启动 mongo 容器"，不保证 mongod 已经能接受连接
  // （首次初始化数据目录、慢磁盘都要几秒到几十秒）。以前这里只连一次，连不上就抛出
  // 未捕获的 rejection → 进程退出 → 容器 restart → 再退出，用户看到的是崩溃循环。
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await client.connect();
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < 10) {
        // eslint-disable-next-line no-console
        console.log(
          `[initJwt] 第 ${attempt} 次连接 MongoDB 失败（${(err as Error)?.message}），3 秒后重试`,
        );
        await sleep(3000);
      }
    }
  }
  if (lastError) {
    throw lastError;
  }
  try {
    const db = client.db();
    const collection = db.collection('settings');
    // ⚠️ 必须是**原子**的 upsert，不能"先 findOne、没有就 insertOne"：
    // 两个 server 进程同时启动（cluster 的多个 worker、或者 watch 重启留下的孤儿进程，
    // AGENTS §7.38.3 里实测到过两个进程同时在跑）会各自生成一个 secret 并各插一行，
    // 于是不同进程用不同密钥签 token —— 后台会话随机失效，而且极难复现。
    // `settings.type` 上有唯一索引（type_1），所以 $setOnInsert + upsert 天然互斥。
    const secret = makeSalt();
    try {
      const doc = await collection.findOneAndUpdate(
        { type: 'jwt' },
        { $setOnInsert: { type: 'jwt', value: { secret } } },
        { upsert: true, returnDocument: 'after' },
      );
      const existing = (doc?.value ?? doc) as any;
      if (existing?.value?.secret) {
        return normalizeKeyState(existing.value);
      }
    } catch (err) {
      // 全新库上唯一索引可能还没建好（mongoose 的 autoIndex 在 Nest 启动时才跑），
      // 撞车了就退回读一遍：谁先写进去就用谁的
      if ((err as any)?.code !== 11000) throw err;
    }
    const fallback = await collection.findOne({ type: 'jwt' });
    if (fallback?.value?.secret) {
      return normalizeKeyState(fallback.value);
    }
    return { secret, previous: null };
  } finally {
    // ⚠️ 一定要关：不关就漏一个 MongoClient（连接池 + SDAM 定时器）
    await client.close().catch((err) => {
      // eslint-disable-next-line no-console
      console.log(`[initJwt] 关闭 MongoDB 连接失败：${(err as Error)?.message || err}`);
    });
  }
};

// ===========================================================================
// JWT 密钥轮换（双密钥验签宽限期）
// ===========================================================================
//
// ## 为什么需要它
// 整站备份归档是**全库导出**，里面就有 `settings{type:'jwt'}` 的这一份密钥。
// 而 `initJwt` 只有 `$setOnInsert` ⇒ 密钥**从建站起永不改变**，所以：
// 归档一旦被读走（异地备份放在对象存储/网盘/U 盘、备份机被入侵、误发给别人），
// 攻击者就能**离线**伪造 `{sub:0, role:'admin'}` 的超管令牌 —— 不需要破解任何口令，
// 而且这个能力**永久有效**，除非整站重建。轮换就是给这种情况的唯一补救路径。
//
// ## 为什么是"双密钥 + 宽限期"而不是直接换掉
// 直接换掉会让**所有**已签发的令牌立刻失效：站长自己被登出（还能重新登录），
// 但 API Token（`tokens` 集合，`userId=666666`，默认 365 天）也会一起失效 ⇒
// 所有外部集成当场断掉。所以：
//  - **签发**只用当前密钥；
//  - **验签**先按 token 头里的 `kid` 选密钥：当前密钥，或宽限期内的上一个密钥；
//  - 宽限期结束后上一个密钥被丢弃，用它签的令牌自然失效。
//
// ⚠️ **API Token 会一起失效**（这是必须让站长知道的后果）：
// API Token 也是 `jwtService.sign()` 签的 JWT，用的就是这同一份密钥，
// `TokenGuard`/`checkToken` 只是额外查一次 `tokens` 表（`AuthGuard('jwt')` 先跑）。
// 所以宽限期一过，**所有**旧 API Token 全部失效，外部集成必须在后台重新签发。
// 轮换接口的响应里会带上当前 API Token 的数量，就是为了让站长在按下按钮前知道影响面。
//
// ⚠️ **恢复一份旧归档会把密钥回滚**：恢复是"临时集合 + 原子替换"，`settings` 整个
// 被归档里那份覆盖 ⇒ 密钥回到归档导出时的值，`previous` 与 `rotatedAt` 也一并被覆盖。
// 后果有两层：①如果归档已经泄露，恢复等于把泄露的密钥又装回来了（需要再轮换一次）；
// ②恢复之后**本进程内存里的密钥与库里的不一致**（`initJwt` 是记忆化的），
// 所以恢复流程必须调 `invalidateJwtSecretCache()` —— 不调的话，本进程继续用旧密钥签发，
// 而下次重启后从库里读到的是归档那份，届时这些令牌全部失效（一次"重启后才爆发"的事故）。

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/** 宽限期（天）。`0` = 不留宽限，轮换后旧密钥立即失效（外部集成会当场断，慎用）。 */
export const JWT_ROTATE_GRACE_DAYS_ENV = 'VANBLOG_JWT_ROTATE_GRACE_DAYS';
export const DEFAULT_JWT_ROTATE_GRACE_DAYS = 7;
const MAX_JWT_ROTATE_GRACE_DAYS = 365;

export function jwtRotateGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const text = env[JWT_ROTATE_GRACE_DAYS_ENV];
  // ⚠️ **空值/纯空白必须先当成"没设"**：`Number('') === 0`、`Number('  ') === 0`，
  //    直接 Number() 会把"compose 里写了个空值"解释成"宽限期 0 天"——
  //    而 0 天的语义是"轮换后立刻踢掉所有登录会话与全部 API Token"。
  //    把一次手误放大成全站下线，正是这里要避免的失败方向。
  if (typeof text !== 'string' || text.trim() === '') {
    return DEFAULT_JWT_ROTATE_GRACE_DAYS * 24 * 3600 * 1000;
  }
  const raw = Number(text);
  // 非法值同样回落到默认，而不是 0
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_JWT_ROTATE_GRACE_DAYS * 24 * 3600 * 1000;
  }
  const days = Math.min(raw, MAX_JWT_ROTATE_GRACE_DAYS);
  return days * 24 * 3600 * 1000;
}

/**
 * 密钥标识（放进 JWT 头的 `kid`）。
 *
 * 用 sha256 的前 16 位十六进制，而不是随机 id：
 *  - 它是密钥的**纯函数**，所以老归档/老库里没有这个字段也能算出来（无需数据迁移）；
 *  - 它不泄露密钥本身（sha256 单向，且只取前 64 bit）；
 *  - 同一份密钥在任何进程上算出来的 kid 都一致 ⇒ cluster 多 worker 不会各说各话。
 */
export function kidOf(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16);
}

/** 把库里的 `value` 规范化成 JwtKeyState（老文档只有 `secret`，没有 `previous`）。 */
export function normalizeKeyState(value: any): JwtKeyState {
  const secret = typeof value?.secret === 'string' ? value.secret : '';
  const prev = value?.previous;
  const previous =
    prev && typeof prev.secret === 'string' && prev.secret
      ? {
          secret: prev.secret,
          rotatedAt: typeof prev.rotatedAt === 'string' ? prev.rotatedAt : '',
          ...(Number.isFinite(Number(prev.graceDays)) && prev.graceDays !== null && prev.graceDays !== undefined
            ? { graceDays: Number(prev.graceDays) }
            : {}),
        }
      : null;
  return { secret, previous };
}

/**
 * 为一个**尚未验签**的 token 挑验签密钥。
 *
 * ⚠️ 这里读 token 头是**不验签**的（还没验呢），所以 `kid` 完全由请求方控制。
 * 这不是漏洞：`kid` 只用来在"当前密钥"与"宽限期内的上一个密钥"之间**二选一**，
 * 两个候选都是我们自己的密钥，所以伪造 `kid` 最坏的结果是验签失败（401），
 * 挑不出第三个密钥来。换句话说 `kid` 是**路由提示**，不是信任决定 ——
 * 信任只来自 HMAC 验签本身（用哪把钥匙验由 `kid` 指，但验不过就是 401）。
 *
 * ⚠️ 这个函数**绝不抛异常**：token 畸形时返回当前密钥，让 passport 走正常的 401 路径。
 * 在这里抛错会变成 500，而且会让"随便发个垃圾 token"变成一条刷错误日志的路子。
 */
export function selectJwtVerifyKey(rawToken: unknown, now: number = Date.now()): string {
  const state = keyState;
  const fallback = typeof global.jwtSecret === 'string' ? global.jwtSecret : '';
  if (!state || !state.secret) {
    return fallback;
  }
  const currentKid = kidOf(state.secret);
  const previousUsable =
    state.previous && state.previous.secret && withinGrace(state.previous, now)
      ? state.previous
      : null;

  const kid = readTokenKid(rawToken);
  if (kid === currentKid) {
    return state.secret;
  }
  if (kid && previousUsable && kid === kidOf(previousUsable.secret)) {
    return previousUsable.secret;
  }
  if (!kid) {
    // 旧 token（本功能上线之前签的）头部没有 kid。
    // 它只可能是"轮换之前的那个密钥"签的 ⇒ 宽限期内用 previous，否则用当前密钥。
    // ⚠️ 这条分支是**向后兼容的关键**：没有它，第一次轮换就会把所有在线用户与
    //    所有已签发的 API Token 当场踢掉，而这正是宽限期要避免的事。
    if (previousUsable) {
      return previousUsable.secret;
    }
    return state.secret;
  }
  // kid 指向一个我们已经丢弃的密钥（例如连续轮换两次）⇒ 用当前密钥，验签自然失败
  return state.secret;
}

function withinGrace(previous: JwtPreviousKey, now: number): boolean {
  const at = Date.parse(previous.rotatedAt);
  if (!Number.isFinite(at)) {
    // 读不出时间戳时**当作仍在宽限期内**：这里的失败方向应该是"多留一会儿旧密钥"
    // （站长还能用），而不是"当场踢掉所有人"（事故）。宽限期本身有上限，不会无限延长。
    return true;
  }
  // ⚠️ 用**当次轮换记下的**宽限期，不是现在的 env（理由见 JwtPreviousKey.graceDays）
  const graceMs =
    Number.isFinite(previous.graceDays) && (previous.graceDays as number) >= 0
      ? (previous.graceDays as number) * 24 * 3600 * 1000
      : jwtRotateGraceMs();
  // ⚠️ 必须是**严格小于**，不是 `<=`：`graceDays: 0` 的语义是"旧密钥立即失效"
  //    （站长明确要求把所有人踢下线时用），而轮换与验签落在同一毫秒时
  //    `now - at === 0`，用 `<=` 会得到 `0 <= 0 === true` ⇒ 0 天宽限被静默忽略，
  //    旧令牌照样验得过。这是本次开发中实测抓到的（两条用例同时红）。
  //    边界口径：宽限 N 天 = 到 `rotatedAt + N 天`这一刻为止有效，之后失效。
  return now - at < graceMs;
}

function readTokenKid(rawToken: unknown): string | null {
  if (typeof rawToken !== 'string' || !rawToken) {
    return null;
  }
  const head = rawToken.split('.')[0];
  if (!head) {
    return null;
  }
  try {
    const json = Buffer.from(head, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    return typeof parsed?.kid === 'string' && parsed.kid ? parsed.kid : null;
  } catch {
    return null;
  }
}

/** 当前密钥态（只读）。启动早期还没装载时返回 null。 */
export function getJwtKeyState(): JwtKeyState | null {
  return keyState ? { ...keyState, previous: keyState.previous ? { ...keyState.previous } : null } : null;
}

/** 仅供测试：直接设置内存态。 */
export function __setJwtKeyStateForTest(state: JwtKeyState | null): void {
  keyState = state;
}

export interface RotateJwtSecretResult {
  /** 新密钥的 kid（**不是**密钥本身；密钥绝不返回给调用方，也不进日志） */
  kid: string;
  previousKid: string | null;
  rotatedAt: string;
  graceDays: number;
  /**
   * 库里现存的 API Token 条数（best-effort，读不到就是 null）。
   * 给站长看影响面用的：宽限期一过这些**全部**失效，需要在后台重新签发。
   */
  apiTokensAffected: number | null;
}

/**
 * 轮换 JWT 密钥：生成新密钥，把当前密钥降级为 `previous`（带 `rotatedAt`），并更新本进程内存态。
 *
 * ⚠️ 用 **CAS**（compare-and-swap）而不是"先读后写"：两个管理员同时点轮换，
 * 或者 cluster 的两个 worker 同时收到请求时，先读后写会让其中一次的 `previous`
 * 覆盖另一次的结果，甚至把刚生成的新密钥又写回旧值。这里的过滤条件带上
 * `'value.secret': 期望的旧值`，撞车的那一次匹配不到文档 ⇒ 明确报错让调用方重试。
 *
 * @param onSigningKeySwitched 让调用方把**签发**用的密钥也切过去（见 backup.controller）。
 *   之所以用回调而不是在这里注入 JwtService：`utils/` 这层不该依赖 Nest 的 DI 容器，
 *   而 `JwtService` 把 secret 存在它自己的 options 里（模块注册时就固定了）。
 */
export async function rotateJwtSecret(options: {
  graceDays?: number;
  onSigningKeySwitched?: (secret: string) => void;
  logger?: { log(m: string): void; warn(m: string): void };
}): Promise<RotateJwtSecretResult> {
  const log = options.logger || { log: () => undefined, warn: () => undefined };
  const graceDays =
    options.graceDays === undefined
      ? jwtRotateGraceMs() / (24 * 3600 * 1000)
      : Math.min(Math.max(options.graceDays, 0), MAX_JWT_ROTATE_GRACE_DAYS);
  const mongoUrl = await loadMongoUrl();
  const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  try {
    const collection = client.db().collection('settings');
    const current = await collection.findOne({ type: 'jwt' });
    const oldSecret = (current as any)?.value?.secret;
    if (typeof oldSecret !== 'string' || !oldSecret) {
      // 站点还没初始化过（密钥是 initJwt 在建站时写的）。这时"轮换"没有意义，
      // 而且贸然插一条会把初始化流程的 $setOnInsert 语义搅乱。
      throw new BadRequestException(
        '当前库里还没有 JWT 密钥（站点可能尚未初始化）：请先完成初始化，再考虑轮换。',
      );
    }
    const newSecret = makeSalt();
    const rotatedAt = new Date().toISOString();
    const updated = await collection.findOneAndUpdate(
      // CAS：只有当密钥仍然是我们刚读到的那一份时才写入
      { type: 'jwt', 'value.secret': oldSecret },
      {
        $set: {
          'value.secret': newSecret,
          'value.previous': { secret: oldSecret, rotatedAt, graceDays },
          'value.rotatedAt': rotatedAt,
        },
      },
      { returnDocument: 'after' },
    );
    // ⚠️ 归一化要**同时**容忍两种返回形状：原生 driver 的 findOneAndUpdate 返回整个文档
    //    （`{type, value:{secret,…}}`），而某些封装/假件会直接返回 `value` 那一层。
    //    文件里上面 `readOrCreateJwtSecret` 用的就是 `doc?.value ?? doc` 这个套路，
    //    这里必须一致 —— 只认一种形状会让 CAS 校验在另一种形状下**恒不命中**，
    //    于是"轮换成功了却报'被另一个请求改动了'"（本次开发时实测踩到）。
    const returned: any = updated;
    const value: any = returned?.value ?? returned;
    if (!value || value?.secret !== newSecret) {
      throw new BadRequestException(
        'JWT 密钥在轮换过程中被另一个请求改动了（CAS 未命中）：请重新加载页面后再试一次。',
      );
    }
    // 内存态：当前 = 新密钥，previous = 刚才那份（带 rotatedAt 与**本次**的宽限期）
    const previousRecord: JwtPreviousKey = { secret: oldSecret, rotatedAt, graceDays };
    keyState = { secret: newSecret, previous: previousRecord };
    // ⚠️ 记忆化缓存必须作废：否则任何再调一次 initJwt() 的路径都会把旧密钥装回来
    cached = null;
    // waline 子进程用的是 global.jwtSecret（spawn 时读一次）；更新它至少让
    // **下一次**重启/重拉 waline 时拿到新密钥（见汇报里的 waline 说明）。
    global.jwtSecret = newSecret;
    // 签发侧切换：JwtService 的 secret 在模块注册时就固定了，必须由调用方把它换掉，
    // 否则"验签已经用新密钥、签发还在用旧密钥"，宽限期一过就有一批令牌提前失效。
    if (options.onSigningKeySwitched) {
      options.onSigningKeySwitched(newSecret);
    }
    // ⚠️ 这里**不能**调 invalidateJwtSecretCache()：它会把 keyState 一起清成 null，
    // 于是"轮换完成"到"下一次 initJwt()"之间验签只能退回 global 兜底，
    // 上一个密钥的宽限期形同虚设。要清的只有 `cached`（上面已经清了）——
    // 那个记忆化的 Promise 仍然解析成旧密钥，留着它等于把旧密钥又装回来。

    let apiTokensAffected: number | null = null;
    try {
      // best-effort：数不出来不该让轮换失败（密钥已经换成功了，回不去也不该回）
      apiTokensAffected = await client.db().collection('tokens').countDocuments({ userId: 666666 });
    } catch (err) {
      log.warn(`数不出 API Token 条数（不影响轮换结果）：${(err as Error)?.message || err}`);
    }
    // ⚠️ 日志里只出现 kid，绝不出现密钥本身
    log.log(
      `JWT 密钥已轮换：新 kid ${kidOf(newSecret)}，旧 kid ${kidOf(oldSecret)} 进入 ${graceDays} 天宽限期` +
        `（宽限期内旧令牌仍可验签；期满后所有用旧密钥签发的登录会话与 **API Token** 一律失效）`,
    );
    return {
      kid: kidOf(newSecret),
      previousKid: kidOf(oldSecret),
      rotatedAt,
      graceDays,
      apiTokensAffected,
    };
  } finally {
    await client.close().catch((err) => {
      log.warn(`关闭 MongoDB 连接失败：${(err as Error)?.message || err}`);
    });
  }
}

/**
 * 把**签发**用的密钥也切到新值。
 *
 * 为什么需要这个函数：`JwtModule.registerAsync` 的工厂在启动时把 `secret` 交给了
 * `JwtService`，之后 `jwtService.sign()` 每次都从它自己那份 options 里读
 * （实测 @nestjs/jwt 11.0.2：改 `options.secret` 立刻生效，见 jwtRotate.spec.ts 的金丝雀用例）。
 * 不切的话就是"验签已经认新密钥、签发还在用旧密钥"——宽限期一过，
 * 这段时间里登录的用户会**提前**掉线，而且没人说得清为什么。
 *
 * ⚠️ 返回 false 表示"这个版本的 @nestjs/jwt 内部形状变了，切不动"。
 * 调用方**必须**把这件事说出来（响应里带 `restartRequired: true`），
 * 绝不能静默地让签发留在旧密钥上 —— 那正是本函数要防的失败模式。
 *
 * @returns 是否切换成功
 */
export function switchJwtSigningKey(jwtService: unknown, secret: string): boolean {
  const options = (jwtService as any)?.options;
  if (!options || typeof options !== 'object') {
    return false;
  }
  // 形状金丝雀：只有"当前就是一个字符串 secret"时才敢改。
  // 如果哪天 JwtService 改成用 provider 函数或把 options 冻住，这里返回 false，
  // 于是响应里会出现 restartRequired，而不是悄悄签出一批会提前失效的令牌。
  if (typeof options.secret !== 'string') {
    return false;
  }
  options.secret = secret;
  return true;
}
