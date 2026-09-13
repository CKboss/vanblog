import {
  encryptPassword,
  hashAccessPassword,
  hashSecret,
  isScryptHash,
  makeSalt,
  needsPasswordUpgrade,
  safeEqual,
  verifyAccessPassword,
  verifySecret,
  verifyUserPassword,
} from './crypto';

describe('scrypt 口令哈希', () => {
  it('能自校验，且每次盐不同（同一口令两次哈希结果不同）', () => {
    const a = hashSecret('browser-derived-secret');
    const b = hashSecret('browser-derived-secret');
    expect(isScryptHash(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(verifySecret(a, 'browser-derived-secret')).toBe(true);
    expect(verifySecret(b, 'browser-derived-secret')).toBe(true);
    expect(verifySecret(a, 'wrong')).toBe(false);
  });

  it('格式自描述：scrypt$N$r$p$salt$hash', () => {
    const parts = hashSecret('x').split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16384);
  });

  it('空口令不会被哈希（避免写出空哈希 = 空密码可登录）', () => {
    expect(hashSecret('')).toBe('');
    expect(hashAccessPassword('')).toBe('');
  });

  it('被篡改 / 畸形 / 参数离谱的哈希一律校验失败，且不会把进程搞崩', () => {
    const good = hashSecret('secret');
    const [, n, r, p, salt, hash] = good.split('$');
    expect(verifySecret(`scrypt$${n}$${r}$${p}$${salt}$${hash.slice(0, -4)}AAAA`, 'secret')).toBe(false);
    expect(verifySecret('scrypt$1$2$3', 'secret')).toBe(false);
    expect(verifySecret('scrypt$abc$8$1$c2FsdA==$aGFzaA==', 'secret')).toBe(false);
    expect(verifySecret('不是哈希', 'secret')).toBe(false);
    expect(verifySecret('', 'secret')).toBe(false);
    // N=2^30 会让 scrypt 申请上百 GB：必须直接拒，而不是 OOM
    expect(verifySecret(`scrypt$1073741824$8$1$${salt}$${hash}`, 'secret')).toBe(false);
    expect(verifySecret(`scrypt$${n}$4096$4096$${salt}$${hash}`, 'secret')).toBe(false);
    expect(verifySecret(good, '')).toBe(false);
  });

  it('needsPasswordUpgrade 能认出旧格式', () => {
    expect(needsPasswordUpgrade(hashSecret('x'))).toBe(false);
    expect(needsPasswordUpgrade('d0d0d0f0f0')).toBe(true);
    expect(needsPasswordUpgrade('')).toBe(false);
    expect(needsPasswordUpgrade(undefined)).toBe(false);
  });
});

describe('后台账号口令校验（新旧格式都要认，否则升级会把所有人锁在门外）', () => {
  const username = 'admin';
  const browserPassword = 'sha256-derived-value-from-browser';

  it('旧的 sha256 存储仍然能登录', () => {
    const salt = makeSalt();
    const legacy = encryptPassword(username, browserPassword, salt);
    expect(legacy).not.toBe('');
    expect(verifyUserPassword(legacy, username, browserPassword, salt)).toBe(true);
    expect(verifyUserPassword(legacy, username, 'wrong', salt)).toBe(false);
    expect(verifyUserPassword(legacy, 'someoneelse', browserPassword, salt)).toBe(false);
  });

  it('新的 scrypt 存储能登录，且不依赖 salt 字段', () => {
    const stored = hashSecret(browserPassword);
    expect(verifyUserPassword(stored, username, browserPassword, '')).toBe(true);
    expect(verifyUserPassword(stored, username, browserPassword, 'any-salt')).toBe(true);
    expect(verifyUserPassword(stored, username, 'wrong', '')).toBe(false);
  });

  it('空值一律拒绝（空哈希曾经等于空密码可登录）', () => {
    expect(verifyUserPassword('', username, browserPassword, 'salt')).toBe(false);
    expect(verifyUserPassword(undefined, username, browserPassword, 'salt')).toBe(false);
    expect(verifyUserPassword(hashSecret('x'), username, '', 'salt')).toBe(false);
    expect(verifyUserPassword(hashSecret('x'), username, undefined as any, 'salt')).toBe(false);
  });
});

describe('文章 / 分类访问密码', () => {
  it('历史明文仍能解锁，新的哈希也能', () => {
    expect(verifyAccessPassword('plain-pass', 'plain-pass')).toBe(true);
    expect(verifyAccessPassword('plain-pass', 'other')).toBe(false);
    const hashed = hashAccessPassword('plain-pass');
    expect(isScryptHash(hashed)).toBe(true);
    expect(verifyAccessPassword(hashed, 'plain-pass')).toBe(true);
    expect(verifyAccessPassword(hashed, 'other')).toBe(false);
  });

  it('空密码 / 空输入都不放行（标记了加密却没设密码时不能白给正文）', () => {
    expect(verifyAccessPassword('', 'anything')).toBe(false);
    expect(verifyAccessPassword('set', '')).toBe(false);
    expect(verifyAccessPassword(undefined, 'x')).toBe(false);
  });
});

describe('常量时间比较', () => {
  it('等长才比较，不等长直接 false', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual(undefined, undefined)).toBe(true);
  });
});
