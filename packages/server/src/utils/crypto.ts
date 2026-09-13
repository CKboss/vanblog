/**
 * crypto 常用封装方法
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sha256 } from 'js-sha256';

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

export function hashSecret(secret: string): string {
  const value = String(secret ?? '');
  if (!value) {
    return '';
  }
  const salt = randomBytes(16);
  const derived = scryptSync(value, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    SCRYPT_PREFIX.slice(0, -1),
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function verifySecret(stored: string, secret: string): boolean {
  const value = String(secret ?? '');
  if (!value || !isScryptHash(stored)) {
    return false;
  }
  const parts = String(stored).split('$');
  if (parts.length !== 6) {
    return false;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || N <= 0 || r <= 0 || p <= 0) {
    return false;
  }
  // 参数是攻击者可控的（库被改过），所以夹一个上限，避免构造 N=2^30 让进程 OOM
  if (N > 1048576 || r > 64 || p > 64 || 128 * N * r > SCRYPT_MAXMEM) {
    return false;
  }
  let expected: Buffer;
  try {
    expected = Buffer.from(parts[5], 'base64');
    const derived = scryptSync(value, Buffer.from(parts[4], 'base64'), expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
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

export function hashAccessPassword(plain: string): string {
  const value = String(plain ?? '');
  return value ? hashSecret(value) : '';
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
