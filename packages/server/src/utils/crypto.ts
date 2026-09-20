/**
 * crypto 常用封装方法
 */

import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sha256 } from 'js-sha256';

/**
 * 异步 scrypt：把 KDF 的 CPU 与内存开销落到 **libuv 线程池**，不再阻塞事件循环。
 *
 * 为什么这件事重要（本机实测数字）：N=16384,r=8,p=1,keylen=64 的 `scryptSync` 单次
 * **63 ms**。Nest 每个 worker 是单线程事件循环，所以同步版本意味着"一次口令校验 =
 * 整个 worker 停摆 63 ms"。而"文章解锁"是**匿名可达**的，预算是 20 次/10 分钟/
 * (IP×文章) ⇒ 单个组合的一轮预算就能独占事件循环 **1.26 秒**；462 个组合在 600 秒
 * 窗口内 ≈ 97% 占空比。连锁反应更糟：`/api/public/health` 要 ping mongo，被拖超时后
 * 容器判 unhealthy ⇒ `restart: always` 触发重启风暴，而**重启不能缓解**（攻击继续）。
 *
 * 异步化之后：容量约等于 `UV_THREADPOOL_SIZE / 单次耗时` = 16 / 0.063 ≈ **254 次/秒**，
 * 超出部分只是**排队**（延迟上升），事件循环仍然能处理其它请求、健康检查照常返回。
 * `UV_THREADPOOL_SIZE=16` 已在 Dockerfile 里设对。
 */
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * 口令存储用 scrypt（内存困难型 KDF），格式自描述：
 *
 *     scrypt$N$r$p$<salt base64>$<hash base64>
 *
 * 为什么换：原来存的是 `sha256(sha256(username + 浏览器端派生值) + salt + sha256(username + salt))`，
 * 纯 sha256 是**快哈希**，拿到库之后可以用 GPU 每秒试几十亿次。scrypt 让每次尝试都要吃 16MB 内存，
 * 离线爆破成本提高几个数量级。参数写进字符串里，以后想调（或换 argon2）也能识别旧格式。
 *
 * 迁移是**透明**的：校验函数同时认新格式与旧格式，登录成功时顺手把旧的升级成 scrypt
 * （见 UserProvider.updateSalt）。不需要用户改密码，也不需要停机跑脚本。
 */
const SCRYPT_PREFIX = 'scrypt$';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
/** N*r*128 = 16MB，超过 node 默认 maxmem(32MB) 的一半，留足余量 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function isScryptHash(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(SCRYPT_PREFIX);
}

/** 不是 scrypt 格式的就是需要升级的旧哈希（或明文） */
export function needsPasswordUpgrade(stored: unknown): boolean {
  return !!stored && !isScryptHash(stored);
}

/** 常量时间比较，避免用比较耗时推测内容 */
export function safeEqual(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * 解析并**校验** `scrypt$N$r$p$salt$hash` 里的参数，同步与异步两条路径共用这一份，
 * 免得哪天只改了一边（上限被放宽、或格式判定漂移）。
 *
 * ⚠️ 这里的参数是**攻击者可控**的：哈希存在库里，而库可能已经被改过（备份恢复、
 * 导入 JSON、直接的数据库访问）。所以必须夹上限，否则构造 `N=2^30` 能让进程 OOM。
 * @returns 校验通过时的参数；任何一处不合法都返回 `null`（调用方一律当"校验失败"）。
 */
function parseScryptParams(
  stored: unknown,
): { N: number; r: number; p: number; saltB64: string; hashB64: string } | null {
  if (!isScryptHash(stored)) {
    return null;
  }
  const parts = String(stored).split('$');
  if (parts.length !== 6) {
    return null;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || N <= 0 || r <= 0 || p <= 0) {
    return null;
  }
  // 参数是攻击者可控的（库被改过），所以夹一个上限，避免构造 N=2^30 让进程 OOM
  if (N > 1048576 || r > 64 || p > 64 || 128 * N * r > SCRYPT_MAXMEM) {
    return null;
  }
  return { N, r, p, saltB64: parts[4], hashB64: parts[5] };
}

const SCRYPT_OPTS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM };

/**
 * ⚠️ **同步版会阻塞事件循环 63 ms（本机实测）**。新代码请用 `hashSecretAsync`。
 * 保留它是因为还有调用点没迁移完，而**改签名比阻塞危险得多**（见 `verifySecret` 上的说明）。
 */
export function hashSecret(secret: string): string {
  const value = String(secret ?? '');
  if (!value) {
    return '';
  }
  const salt = randomBytes(16);
  const derived = scryptSync(value, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return [
    SCRYPT_PREFIX.slice(0, -1),
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** `hashSecret` 的异步版：把 KDF 落到 libuv 线程池，事件循环不被阻塞。 */
export async function hashSecretAsync(secret: string): Promise<string> {
  const value = String(secret ?? '');
  if (!value) {
    return '';
  }
  const salt = randomBytes(16);
  const derived = await scryptAsync(value, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return [
    SCRYPT_PREFIX.slice(0, -1),
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * ⚠️ **同步版会阻塞事件循环 63 ms**，而它的调用方之一是**匿名可达**的文章解锁路径 ⇒
 * 这是一条真实的 DoS 放大链（见文件顶部 `scryptAsync` 上的算术）。新代码请用
 * `verifySecretAsync`。
 *
 * ⚠️⚠️ **为什么不能直接把它改成 async**：现有调用点是
 * `if (!verifyAccessPassword(targetPassword, supplied)) { return null; }`
 * （`provider/article/article.provider.ts`）。若返回类型悄悄变成 `Promise<boolean>` 而调用点
 * 没有同步加 `await`，`!Promise` 恒为 `false` ⇒ **任何密码都能解开任何加密文章**（未鉴权
 * 正文泄露，而且静默、无报错）。所以这里坚持"新增异步变体、同步签名一动不动"：
 * 漏改的调用点最坏只是**继续阻塞**（= 现状），绝不会退化成鉴权绕过。
 */
export function verifySecret(stored: string, secret: string): boolean {
  const value = String(secret ?? '');
  if (!value) {
    return false;
  }
  const params = parseScryptParams(stored);
  if (!params) {
    return false;
  }
  let expected: Buffer;
  try {
    expected = Buffer.from(params.hashB64, 'base64');
    const derived = scryptSync(value, Buffer.from(params.saltB64, 'base64'), expected.length, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** `verifySecret` 的异步版。校验规则与同步版**共用** `parseScryptParams`，不会漂移。 */
export async function verifySecretAsync(stored: string, secret: string): Promise<boolean> {
  const value = String(secret ?? '');
  if (!value) {
    return false;
  }
  const params = parseScryptParams(stored);
  if (!params) {
    return false;
  }
  try {
    const expected = Buffer.from(params.hashB64, 'base64');
    const derived = await scryptAsync(value, Buffer.from(params.saltB64, 'base64'), expected.length, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    // scrypt 抛错只可能是参数非法或内存不足 —— 两者都当"校验失败"，绝不向上抛
    // （抛出会让匿名接口变成 500，而 500 本身就是一种可被利用的信号）。
    return false;
  }
}

/**
 * 时序均衡用的**假哈希**：一个真实 scrypt 格式的常量，其原文是随机的 32 字节、
 * 谁也不知道（生成后丢弃）。
 *
 * 用途：登录时"用户不存在"必须在**耗时上与"密码错"不可区分**，否则可以按时序枚举
 * 用户名（存在 ≈ 63 ms，不存在 ≈ 1 ms）。做法是用户不存在时也跑一次等价成本的 scrypt
 * 并**丢弃结果**。
 *
 * ⚠️ 这条只能在 scrypt **异步化之后**做：同步的 dummy 哈希会让枚举防护本身变成
 * DoS 放大器（攻击者用不存在的用户名就能白拿 63 ms 阻塞，比真用户名更便宜）。
 * ⚠️ 调用方必须**无条件丢弃返回值**：即使理论上有人猜中原文，也不能让它变成登录成功。
 */
export const DUMMY_SCRYPT_HASH =
  'scrypt$16384$8$1$PD2oI/V6HfA/pB01IKFqMA==$OlNqihTKrFglF1q/L7GdZWPFBMSrEVAtfEWgwNusVdrcPlfA9j1LESZLwQpdo3O2vGGYVCOOY4tKp6EADRk54w==';

/**
 * 跑一次与真实校验**等价成本**的 dummy scrypt，用于抹平时序差异。
 * 永不抛错、永不返回可用信息（结果被丢弃）。
 */
export async function runDummyPasswordWork(password: string): Promise<void> {
  // 传一个非空口令，确保真的走到 scrypt（空口令会被提前挡掉，成本就不等价了）
  const input = String(password ?? '') || 'timing-equalizer';
  await verifySecretAsync(DUMMY_SCRYPT_HASH, input);
}

/**
 * 校验后台账号口令。`browserPassword` 是浏览器端派生出来的那个值
 * （与旧实现一致，客户端不需要改）。新旧两种存储格式都认。
 */
export function verifyUserPassword(
  stored: unknown,
  username: string,
  browserPassword: string,
  salt: string,
): boolean {
  if (!stored || typeof browserPassword !== 'string' || !browserPassword) {
    return false;
  }
  if (isScryptHash(stored)) {
    return verifySecret(String(stored), browserPassword);
  }
  const legacy = encryptPassword(username, browserPassword, salt);
  return !!legacy && safeEqual(legacy, stored);
}

/**
 * `verifyUserPassword` 的异步版（登录路径请用这个：它每秒都可能被匿名请求打到，
 * 而同步版每次阻塞事件循环 63 ms）。
 *
 * 语义与同步版**逐条一致**：空 stored / 非字符串或空 browserPassword 一律 false；
 * scrypt 格式走异步 KDF；旧 sha256 格式仍然认（登录成功后由 `updateSalt` 透明升级）。
 * ⚠️ 旧格式那条分支是纯 sha256，成本极低 ⇒ 时序上与 scrypt 分支不同，但那不是
 * 用户名枚举信号（同一个账号的格式是固定的，攻击者看到的是"这个账号慢/快"，
 * 而它本来就能从响应时间之外拿到更多信息）。真正的枚举防护见 `runDummyPasswordWork`。
 */
export async function verifyUserPasswordAsync(
  stored: unknown,
  username: string,
  browserPassword: string,
  salt: string,
): Promise<boolean> {
  if (!stored || typeof browserPassword !== 'string' || !browserPassword) {
    return false;
  }
  if (isScryptHash(stored)) {
    return verifySecretAsync(String(stored), browserPassword);
  }
  const legacy = encryptPassword(username, browserPassword, salt);
  return !!legacy && safeEqual(legacy, stored);
}

/**
 * 校验文章 / 分类的访问密码。历史数据是**明文**存的，这里两种都认；
 * 新写入的走 hashAccessPassword()。比较一律常量时间。
 */
export function verifyAccessPassword(stored: unknown, supplied: unknown): boolean {
  const target = String(stored ?? '');
  const input = String(supplied ?? '');
  if (!target || !input) {
    return false;
  }
  if (isScryptHash(target)) {
    return verifySecret(target, input);
  }
  return safeEqual(target, input);
}

/**
 * `verifyAccessPassword` 的异步版。
 *
 * 🔴 **这是本文件里最该被迁移的一个**：文章解锁是**匿名可达**的接口，预算 20 次/10 分钟/
 * (IP×文章)，而同步版每次阻塞事件循环 63 ms ⇒ 攻击者不需要猜中密码，只要用**很多
 * (IP×文章) 组合**就能把 worker 的事件循环打满（算术见文件顶部）。
 *
 * ⚠️ 迁移调用点时**必须同时加 `await`**（`provider/article/article.provider.ts` 的
 * `getByIdWithPassword` 本身已经是 `async`，所以只是加一个 `await`）。漏加的后果不是
 * "仍然阻塞"，而是 `!Promise` 恒为 false ⇒ **任何密码都能解开任何加密文章**。
 */
export async function verifyAccessPasswordAsync(
  stored: unknown,
  supplied: unknown,
): Promise<boolean> {
  const target = String(stored ?? '');
  const input = String(supplied ?? '');
  if (!target || !input) {
    return false;
  }
  if (isScryptHash(target)) {
    return verifySecretAsync(target, input);
  }
  // 历史明文：常量时间比较（异步版与同步版必须同语义，否则迁移会顺手改掉安全性质）
  return safeEqual(target, input);
}

/** ⚠️ 同步版阻塞 63 ms；新代码用 `hashAccessPasswordAsync`。 */
export function hashAccessPassword(plain: string): string {
  const value = String(plain ?? '');
  return value ? hashSecret(value) : '';
}

/** `hashAccessPassword` 的异步版（写入路径：建/改文章与分类的访问密码）。 */
export async function hashAccessPasswordAsync(plain: string): Promise<string> {
  const value = String(plain ?? '');
  return value ? hashSecretAsync(value) : '';
}

// 随机盐
export function makeSalt(): string {
  return randomBytes(32).toString('base64');
}

/**
 * 使用盐加密浏览器端密🐎
 * @param username 用户名
 * @param password 密码
 * @param salt 密码盐
 */
export function encryptPassword(username: string, password: string, salt: string): string {
  if (!username || !password || !salt) {
    return '';
  }
  return sha256(sha256(username + sha256(password + salt)) + salt + sha256(username + salt));
}
/**
 * 把没加过盐的密码洗成加盐的
 * @param username 用户名
 * @param password 密码
 * @param salt 密码盐
 */
export function washPassword(username: string, password: string, salt: string) {
  username = username.toLowerCase();
  const browserPassword = sha256(
    username + sha256(sha256(sha256(sha256(password))) + sha256(username)),
  );
  return encryptPassword(username, browserPassword, salt);
}

// 计算 流 MD5
export function encryptFileMD5(buffer: Buffer) {
  const md5 = createHash('md5');

  return md5.update(buffer).digest('hex');
}
