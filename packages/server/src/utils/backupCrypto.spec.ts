import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import {
  BACKUP_ENC_EXT,
  BACKUP_ENC_MAGIC,
  BACKUP_PASSPHRASE_ENV,
  BACKUP_PASSPHRASE_FILE_ENV,
  ENC_CHUNK_PLAIN_BYTES,
  MIN_BACKUP_PASSPHRASE_LENGTH,
  assertPassphraseUsableForEncryption,
  createDecryptStream,
  createEncryptor,
  SCRYPT_PARAMS,
  deriveBackupKey,
  deriveBackupKeyFromHeader,
  describePassphrase,
  encryptionSummary,
  hasEncryptedSuffix,
  isEncryptedHead,
  openDecryptedSource,
  plaintextArchiveWarning,
  readEncryptionHeader,
  resolveBackupPassphrase,
} from './backupCrypto';

/**
 * 备份归档加密层的行为级测试。
 *
 * ⚠️ 这里**几乎每一条都真跑加解密**：加密这种东西最容易"看起来做了"（只加密了头部、
 *    或者 GCM 标签根本没校验），而源码锚点对这两种情况都是绿的。
 *
 * ⚠️ 例外（两类，都经过论证）：
 *    ① "报错里不许出现口令" —— 那是**行为**的可观测面，不是源码锚点；
 *    ② 文件末尾那一节的 `maxmem` 源码级尺子 —— 因为**行为级证据在这里有盲区**：
 *       本文件为了跑得快一律注入 `FAST_KDF`（N=1024 ⇒ 只需 1 MiB 内存），而
 *       "生产参数 N·r·128 = 32 MiB 正好压在 Node 默认 maxmem 上限"这条性质在小参数下
 *       **根本不可观测**。M09 变异（去掉 scrypt 调用里的 `maxmem`）因此曾经 `NOT_RED`。
 *       现在两样都有：一条用**生产参数**真派生的行为级用例（约 156ms/次），
 *       加一把"每一个 `crypto.scrypt(` 调用点都必须显式带 `maxmem`"的源码尺子
 *       （后者防的是**将来新增第二个派生点**漏掉 maxmem，行为级用例覆盖不到那种情况）。
 */

const PASS = 'a-realistically-long-passphrase';
const FIXED_SALT = Buffer.alloc(16, 7);
const FIXED_IV = Buffer.alloc(12, 9);

const FAST_KDF = { N: 1024, r: 8, p: 1 };

async function collectAsync(transform: import('stream').Transform, input: Buffer): Promise<Buffer> {
  const out: Buffer[] = [];
  transform.on('data', (c: Buffer) => out.push(c));
  const done = new Promise<void>((resolve, reject) => {
    transform.on('end', () => resolve());
    transform.on('error', reject);
  });
  transform.end(input);
  await done;
  return Buffer.concat(out);
}

function collectSync(transform: import('stream').Transform, input: Buffer): Buffer[] {
  const out: Buffer[] = [];
  transform.on('data', (c: Buffer) => out.push(c));
  transform.end(input);
  return out;
}

async function encryptAsync(plain: Buffer, passphrase = PASS): Promise<Buffer> {
  const { transform } = await createEncryptor({
    passphrase,
    inner: { format: 'zstd', ext: '.tar.zst', label: 'zstd -19' },
    salt: FIXED_SALT,
    baseIv: FIXED_IV,
    kdf: FAST_KDF,
  });
  return collectAsync(transform, plain);
}

async function decryptAsync(container: Buffer, passphrase = PASS): Promise<Buffer> {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vbenc-')), 'a.enc');
  fs.writeFileSync(tmp, container);
  try {
    const { source, header } = await openDecryptedSource(tmp, passphrase, {});
    if (!source || !header) {
      throw new Error('应当识别为加密归档');
    }
    const chunks: Buffer[] = [];
    source.on('data', (c: Buffer) => chunks.push(c));
    await new Promise<void>((resolve, reject) => {
      source.on('end', () => resolve());
      source.on('error', reject);
    });
    return Buffer.concat(chunks);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

function tmpFile(contents: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbenc-'));
  const file = path.join(dir, 'archive.tar.zst.enc');
  fs.writeFileSync(file, contents);
  return file;
}

async function expectRejects(fn: () => Promise<unknown> | unknown, re: RegExp): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    expect(message).toMatch(re);
    return message;
  }
  throw new Error(`期望抛错（${re}），但成功了`);
}

describe('备份归档加密：往返与格式', () => {
  it('多块数据能原样往返（>1 MiB，跨多个 GCM 块）', async () => {
    const plain = crypto.randomBytes(ENC_CHUNK_PLAIN_BYTES * 2 + 12345);
    const container = await encryptAsync(plain);
    expect(isEncryptedHead(container)).toBe(true);
    expect(await decryptAsync(container)).toEqual(plain);
  });

  it('明文长度正好是块大小的整数倍时也能往返（末尾那条空的 final 记录）', async () => {
    const plain = crypto.randomBytes(ENC_CHUNK_PLAIN_BYTES);
    expect(await decryptAsync(await encryptAsync(plain))).toEqual(plain);
  });

  it('空输入也能往返（只有头部 + 一条 final 空记录）', async () => {
    const container = await encryptAsync(Buffer.alloc(0));
    expect(await decryptAsync(container)).toEqual(Buffer.alloc(0));
    expect(container.length).toBeGreaterThan(BACKUP_ENC_MAGIC.length);
  });

  it('单字节输入能往返', async () => {
    expect(await decryptAsync(await encryptAsync(Buffer.from([0x42])))).toEqual(Buffer.from([0x42]));
  });

  it('容器以魔数开头，头部可被无口令解析出内层格式', async () => {
    const container = await encryptAsync(Buffer.from('hello'));
    const file = tmpFile(container);
    try {
      expect(container.subarray(0, BACKUP_ENC_MAGIC.length).toString('ascii')).toBe(BACKUP_ENC_MAGIC);
      const header = readEncryptionHeader(file);
      expect(header).not.toBeNull();
      expect(header!.inner.format).toBe('zstd');
      expect(header!.cipher).toBe('aes-256-gcm');
      expect(header!.kdf.name).toBe('scrypt');
      expect(header!.chunkPlainBytes).toBe(ENC_CHUNK_PLAIN_BYTES);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('同样的口令/salt/iv/时间 产出逐字节相同的容器（IV 是计数器派生，不是随机）', async () => {
    // ⚠️ 必须固定 createdAt：头部 JSON 里带时间戳，不固定的话两次本来就不同，
    //    这条断言就什么也证明不了（第一版就是这么写错的）。
    const plain = crypto.randomBytes(5000);
    const now = new Date('2026-09-20T00:00:00.000Z');
    const one = (baseIv = FIXED_IV) =>
      createEncryptor({
        passphrase: PASS,
        inner: { format: 'zstd', ext: '.tar.zst', label: 'zstd -19' },
        salt: FIXED_SALT,
        baseIv,
        now,
        kdf: FAST_KDF,
      }).then((enc) => collectAsync(enc.transform, plain));
    const a = await one();
    const b = await one();
    expect(a).toEqual(b);
    // 对照：换一个 base IV 就必须完全不同（证明 IV 真的参与了，而不是被忽略）
    const c = await one(Buffer.alloc(12, 3));
    expect(c.equals(a)).toBe(false);
  });

  it('⚠️ 密文里搜不到明文（这条是"真的加密了"的唯一硬证据）', async () => {
    // 用一个绝不可能随机出现的标记串，模拟归档里的 jwt 密钥
    const marker = 'JWT-SECRET-MARKER-8f3a1c9e7b5d';
    const plain = Buffer.concat([
      crypto.randomBytes(300000),
      Buffer.from(`{"value":{"secret":"${marker}"}}`, 'utf8'),
      crypto.randomBytes(300000),
    ]);
    const container = await encryptAsync(plain);
    expect(plain.includes(marker)).toBe(true); // 对照：明文里确实有
    expect(container.includes(Buffer.from(marker, 'utf8'))).toBe(false);
    // 也不能留下任何可辨认的结构：整段密文的字节分布应当是均匀的（粗略判定：
    // 取前 64 KiB，256 种字节值都出现过 —— 未压缩/未加密的数据几乎不可能做到）
    const sample = container.subarray(1024, 1024 + 65536);
    const seen = new Set<number>();
    for (const b of sample) seen.add(b);
    expect(seen.size).toBe(256);
  });

  it('.enc 后缀与魔数两种判定一致', async () => {
    const container = await encryptAsync(Buffer.from('x'));
    expect(hasEncryptedSuffix('/a/b/vanblog-full-20260920-010101.tar.zst.enc')).toBe(true);
    expect(hasEncryptedSuffix('/a/b/vanblog-full-20260920-010101.tar.zst')).toBe(false);
    expect(isEncryptedHead(container)).toBe(true);
    // ⚠️ 名字说谎也不能骗过判定：魔数才是依据
    expect(isEncryptedHead(Buffer.from('not-encrypted-at-all'))).toBe(false);
    expect(BACKUP_ENC_EXT).toBe('.enc');
  });
});

describe('备份归档加密：篡改、截断、重排一律被拒', () => {
  const plain = crypto.randomBytes(ENC_CHUNK_PLAIN_BYTES + 7777);

  it('改密文里任意一个字节 ⇒ 拒绝', async () => {
    const container = await encryptAsync(plain);
    // 挑头部之后的第一个密文字节（确保落在记录体里，而不是长度前缀）
    const at = container.length - 40;
    const tampered = Buffer.from(container);
    tampered[at] = tampered[at] ^ 0xff;
    expect(tampered.equals(container)).toBe(false); // 对照：确实改到了
    await expectRejects(() => decryptAsync(tampered), /口令不正确|已被篡改|块顺序不对/);
  });

  it('改头部的 salt ⇒ 拒绝（头部本身也被 AAD 认证）', async () => {
    const container = await encryptAsync(plain);
    const tampered = Buffer.from(container);
    // salt 在头部 JSON 里；直接改 JSON 会让长度/解析变化，所以改成"同长度替换"：
    // 找到 base64 salt 的位置并翻转一个字符
    const jsonStart = BACKUP_ENC_MAGIC.length + 5;
    const jsonLen = container.readUInt32LE(BACKUP_ENC_MAGIC.length + 1);
    const json = container.subarray(jsonStart, jsonStart + jsonLen).toString('utf8');
    const saltPos = json.indexOf('"salt":"') + '"salt":"'.length;
    const flipped = json[saltPos] === 'A' ? 'B' : 'A';
    const patched = json.slice(0, saltPos) + flipped + json.slice(saltPos + 1);
    expect(patched.length).toBe(json.length);
    Buffer.from(patched, 'utf8').copy(tampered, jsonStart);
    await expectRejects(() => decryptAsync(tampered), /口令不正确|已被篡改|头部不可信|头部与内容不符/);
  });

  it('截断（少了带 final 标记的最后一块）⇒ 明确报"被截断"', async () => {
    const container = await encryptAsync(plain);
    const truncated = container.subarray(0, container.length - 30);
    await expectRejects(() => decryptAsync(Buffer.from(truncated)), /被截断|块顺序不对|损坏/);
  });

  it('在 final 之后追加多余字节 ⇒ 拒绝', async () => {
    const container = await encryptAsync(plain);
    const padded = Buffer.concat([container, Buffer.from('garbage')]);
    await expectRejects(() => decryptAsync(padded), /多余字节/);
  });

  it('交换两条记录的顺序 ⇒ 报"块顺序不对"（可诊断，不是笼统的校验失败）', async () => {
    const container = await encryptAsync(plain);
    // 解析记录边界
    const jsonLen = container.readUInt32LE(BACKUP_ENC_MAGIC.length + 1);
    let off = BACKUP_ENC_MAGIC.length + 5 + jsonLen;
    const records: Buffer[] = [];
    while (off < container.length) {
      const bodyLen = container.readUInt32LE(off);
      records.push(container.subarray(off, off + 4 + bodyLen));
      off += 4 + bodyLen;
    }
    expect(records.length).toBeGreaterThanOrEqual(2); // 对照：确实有多块可换
    const swapped = [records[1], records[0], ...records.slice(2)];
    const rebuilt = Buffer.concat([container.subarray(0, off - records.reduce((s, r) => s + r.length, 0)), ...swapped]);
    await expectRejects(() => decryptAsync(rebuilt), /块顺序不对|口令不正确|已被篡改/);
  });

  it('口令错了 ⇒ 拒绝，且报错里**不含**口令与 salt', async () => {
    const container = await encryptAsync(plain);
    const message = await expectRejects(() => decryptAsync(container, 'wrong-passphrase-entirely'), /口令不正确/);
    expect(message).not.toContain('wrong-passphrase-entirely');
    expect(message).not.toContain(PASS);
    expect(message).not.toContain(FIXED_SALT.toString('base64'));
  });

  it('头部版本/ cipher / kdf 不认识的 ⇒ 直接拒绝，不会拿去做蠢事', () => {
    const base = {
      v: 1,
      kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, saltLen: 16, keyLen: 32 },
      salt: FIXED_SALT.toString('base64'),
      iv: FIXED_IV.toString('base64'),
      cipher: 'aes-256-gcm',
      chunkPlainBytes: ENC_CHUNK_PLAIN_BYTES,
      inner: { format: 'zstd', ext: '.tar.zst', label: 'x' },
      createdAt: new Date().toISOString(),
    };
    const make = (mutate: (h: any) => void) => {
      const header = JSON.parse(JSON.stringify(base));
      mutate(header);
      const json = Buffer.from(JSON.stringify(header), 'utf8');
      const prefix = Buffer.alloc(BACKUP_ENC_MAGIC.length + 5);
      Buffer.from(BACKUP_ENC_MAGIC, 'ascii').copy(prefix, 0);
      prefix[BACKUP_ENC_MAGIC.length] = 1;
      prefix.writeUInt32LE(json.length, BACKUP_ENC_MAGIC.length + 1);
      return tmpFile(Buffer.concat([prefix, json, Buffer.alloc(64)]));
    };
    const cases: Array<[string, (h: any) => void, RegExp]> = [
      // ⚠️ 有两个版本字段：框架字节（magic 之后那 1 字节）与头部 JSON 里的 `v`。
      //    实现里是两道检查、两种文案；两者不一致本身就是篡改信号，必须拒。
      ['JSON 里的 v 不认识', (h) => (h.v = 99), /头部不可信（版本 99 != 1）/],
      ['cipher 不认识', (h) => (h.cipher = 'aes-128-cbc'), /头部不可信/],
      ['kdf 不认识', (h) => (h.kdf.name = 'pbkdf2'), /头部不可信/],
      ['keyLen 不是 32', (h) => (h.kdf.keyLen = 16), /头部不可信/],
      ['N 大到离谱（防内存炸弹）', (h) => (h.kdf.N = 2 ** 30), /头部不可信/],
      ['salt 长度不符', (h) => (h.salt = Buffer.alloc(4, 1).toString('base64')), /头部不可信/],
      ['iv 长度不符', (h) => (h.iv = Buffer.alloc(4, 1).toString('base64')), /头部不可信/],
    ];
    // 框架版本字节不认识（这条走的是 assertHeaderShape 之前的那道检查）
    const badByteVersion = (() => {
      const json = Buffer.from(JSON.stringify(base), 'utf8');
      const prefix = Buffer.alloc(BACKUP_ENC_MAGIC.length + 5);
      Buffer.from(BACKUP_ENC_MAGIC, 'ascii').copy(prefix, 0);
      prefix[BACKUP_ENC_MAGIC.length] = 2; // ← 不认识的容器版本
      prefix.writeUInt32LE(json.length, BACKUP_ENC_MAGIC.length + 1);
      return tmpFile(Buffer.concat([prefix, json, Buffer.alloc(64)]));
    })();
    try {
      expect(() => readEncryptionHeader(badByteVersion)).toThrow(/不支持的加密归档版本 2/);
    } finally {
      fs.rmSync(path.dirname(badByteVersion), { recursive: true, force: true });
    }

    for (const [name, mutate, re] of cases) {
      const file = make(mutate);
      try {
        expect(() => readEncryptionHeader(file)).toThrow(re);
      } finally {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
      }
      void name;
    }
  });

  it('明文归档（真 zstd）不会被误认成加密归档 ⇒ 向后兼容', () => {
    // 用 zstd 魔数开头，readEncryptionHeader 必须返回 null（而不是抛错）
    const file = tmpFile(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x00, 0x01, 0x02, 0x03]));
    try {
      expect(readEncryptionHeader(file)).toBeNull();
      // ⚠️ 后缀骗人也不能改变结论：名字带 .enc 但内容是 zstd ⇒ 仍按"不是加密归档"处理
      const lying = path.join(path.dirname(file), 'vanblog-full-1.tar.zst.enc');
      fs.writeFileSync(lying, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x00]));
      expect(readEncryptionHeader(lying)).toBeNull();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('文件不存在时 readEncryptionHeader 返回 null（让调用方报"备份文件不存在"，而不是"读不出头部"）', () => {
    expect(readEncryptionHeader('/nonexistent/vanblog-full-1.tar.zst.enc')).toBeNull();
  });
});

describe('口令解析：来源优先级与失败关闭', () => {
  it('_FILE 优先于内联，且只 trimEnd（前导空白算口令的一部分）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbpass-'));
    const file = path.join(dir, 'pass');
    fs.writeFileSync(file, '  leading-matters-passphrase\n\n');
    try {
      const resolved = resolveBackupPassphrase(
        {
          [BACKUP_PASSPHRASE_FILE_ENV]: file,
          [BACKUP_PASSPHRASE_ENV]: 'inline-should-be-ignored',
        },
        null,
        );
      expect(resolved.source).toBe('file');
      expect(resolved.passphrase).toBe('  leading-matters-passphrase');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('恢复请求里的显式口令优先于 env（用于恢复别人给的归档）', () => {
    const resolved = resolveBackupPassphrase(
      { [BACKUP_PASSPHRASE_ENV]: 'from-env-value-xxxx' },
      'from-request-body-yyyy',
    );
    expect(resolved.source).toBe('request');
    expect(resolved.passphrase).toBe('from-request-body-yyyy');
  });

  it('都没有 ⇒ null（调用方据此走明文路径）', () => {
    expect(resolveBackupPassphrase({}, null).passphrase).toBeNull();
    expect(resolveBackupPassphrase({ [BACKUP_PASSPHRASE_ENV]: '' }, null).passphrase).toBeNull();
  });

  it('⚠️ _FILE 读不到 ⇒ **失败关闭**，绝不静默回落到明文备份', () => {
    expect(() =>
      resolveBackupPassphrase({ [BACKUP_PASSPHRASE_FILE_ENV]: '/nonexistent/pass-file' }, null),
    ).toThrow(/拒绝继续|不会静默回落到明文备份/);
  });

  it('_FILE 内容为空（只有换行）⇒ 拒绝', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbpass-'));
    const file = path.join(dir, 'empty');
    fs.writeFileSync(file, '\n\n  \n');
    try {
      expect(() => resolveBackupPassphrase({ [BACKUP_PASSPHRASE_FILE_ENV]: file }, null)).toThrow(
        /去掉尾部空白后是空的/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('describe()/日志文案只说长度，绝不回显口令', () => {
    const secret = 'super-secret-passphrase-value';
    const resolved = resolveBackupPassphrase({ [BACKUP_PASSPHRASE_ENV]: secret }, null);
    const text = resolved.describe();
    expect(text).not.toContain(secret);
    expect(text).toContain(String(Buffer.byteLength(secret)));
    expect(describePassphrase(null)).toBe('未设置');
    expect(describePassphrase(secret)).not.toContain(secret);
  });
});

describe('口令强度：加密时强制，解密时绝不强制', () => {
  it('短口令在**加密**时被拒绝（不写出一份能离线爆破的弱归档）', async () => {
    expect(() => assertPassphraseUsableForEncryption('short')).toThrow(/太短/);
    await expect(
      createEncryptor({ passphrase: 'short', inner: { format: 'zstd', ext: '.tar.zst', label: 'x' } }),
    ).rejects.toThrow(/太短/);
    // ⚠️ 生产默认参数不许被"为了测试快"而改小：这条盯着 SCRYPT_PARAMS 本身
    expect(SCRYPT_PARAMS.N).toBe(32768);
    expect(SCRYPT_PARAMS.keyLen).toBe(32);
    expect(MIN_BACKUP_PASSPHRASE_LENGTH).toBeGreaterThanOrEqual(12);
  });

  it('⚠️ 解密侧不做长度校验（否则将来提高下限就读不了老归档）', async () => {
    // deriveBackupKey 是解密路径用的，它不校验长度 —— 用一个短口令也能派生出密钥
    const header = {
      v: 1,
      kdf: { name: 'scrypt', N: 1024, r: 8, p: 1, saltLen: 16, keyLen: 32 },
      salt: FIXED_SALT.toString('base64'),
      iv: FIXED_IV.toString('base64'),
      cipher: 'aes-256-gcm',
      chunkPlainBytes: ENC_CHUNK_PLAIN_BYTES,
      inner: { format: 'zstd', ext: '.tar.zst', label: 'x' },
      createdAt: new Date().toISOString(),
    };
    const key = await deriveBackupKeyFromHeader('abc', header as any);
    expect(key.length).toBe(32);
  });

  it('加密归档缺口令时，报错给出两条可照做的办法，且不回显任何秘密', async () => {
    const container = await encryptAsync(Buffer.from('payload-bytes-here'));
    const file = tmpFile(container);
    try {
      const message = await expectRejects(() => openDecryptedSource(file, null, {}), /这份归档是加密的/);
      expect(message).toContain(BACKUP_PASSPHRASE_ENV);
      expect(message).toContain(BACKUP_PASSPHRASE_FILE_ENV);
      expect(message).toContain('backupPassphrase');
      expect(message).toContain('body'); // 明确"只走 body"
      expect(message).not.toContain(PASS);
      expect(message).not.toContain(FIXED_SALT.toString('base64'));
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('env 里有口令时不需要显式传入（服务器上配好就能恢复自己的加密归档）', async () => {
    const container = await encryptAsync(Buffer.from('payload-bytes-here'));
    const file = tmpFile(container);
    try {
      const { source } = await openDecryptedSource(file, null, { [BACKUP_PASSPHRASE_ENV]: PASS });
      expect(source).not.toBeNull();
      source!.destroy();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe('非机密摘要与 WARN 文案', () => {
  it('encryptionSummary 不含口令，但含解密所需的 KDF 参数', async () => {
    const container = await encryptAsync(Buffer.from('x'));
    const file = tmpFile(container);
    try {
      const header = readEncryptionHeader(file)!;
      const summary = encryptionSummary(header);
      expect(summary.encrypted).toBe(true);
      expect(JSON.stringify(summary)).not.toContain(PASS);
      // ⚠️ 断言"摘要记的就是归档头部里的参数"，而不是钉死生产默认值：
      //    测试为了快会注入小 N，钉死 32768 会与注入冲突（第一版就是这么写红的）。
      //    "生产默认值不许被改小"由 SCRYPT_PARAMS 那条断言单独盯着。
      expect((summary as any).kdf).toEqual(header.kdf);
      expect((summary as any).cipher).toBe('aes-256-gcm');
      expect(encryptionSummary(null)).toEqual({ encrypted: false });
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('明文归档的 WARN 说清"里面有什么"与"怎么开加密"，并且不吓人', () => {
    const text = plaintextArchiveWarning('vanblog-full-20260920-010101.tar.zst');
    expect(text).toContain('JWT 签名密钥');
    expect(text).toContain('scrypt');
    expect(text).toContain('伪造管理员令牌');
    expect(text).toContain('0600');
    expect(text).toContain(BACKUP_PASSPHRASE_ENV);
    expect(text).toContain(BACKUP_PASSPHRASE_FILE_ENV);
    expect(text).toContain('演练');
    expect(text).toContain('vanblog-full-20260920-010101.tar.zst');
  });

  it('⚠️ 两个环境变量都真的被读取（行为级，不是源码文本断言）', () => {
    // 源码文本断言（`expect(src).toContain(...)`）是空断言的近亲：匹配到注释或字符串
    // 字面量都会绿，而且换个写法就假红。这里直接证明"设了这个 env，行为就变"。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbknob-'));
    const file = path.join(dir, 'pass');
    fs.writeFileSync(file, 'from-file-passphrase-value');
    try {
      expect(resolveBackupPassphrase({ [BACKUP_PASSPHRASE_ENV]: 'from-env-passphrase-value' }, null).passphrase).toBe(
        'from-env-passphrase-value',
      );
      expect(resolveBackupPassphrase({ [BACKUP_PASSPHRASE_FILE_ENV]: file }, null).passphrase).toBe(
        'from-file-passphrase-value',
      );
      // 空转对照：两个名字都不设 ⇒ 拿不到口令（证明上面两条不是恒定通过）
      expect(resolveBackupPassphrase({}, null).passphrase).toBeNull();
      // 名字写错一个字母就必须失效（这条挡住"文案里的名字和代码里的名字不同源"）
      expect(resolveBackupPassphrase({ VANBLOG_BACKUP_PASSPHRASEE: 'x'.repeat(20) }, null).passphrase).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('解密流的健壮性（喂法不同也要能工作）', () => {
  it('调用方已经剥掉头部时也能解密（两种喂法都支持）', async () => {
    const plain = crypto.randomBytes(5000);
    const container = await encryptAsync(plain);
    const jsonLen = container.readUInt32LE(BACKUP_ENC_MAGIC.length + 1);
    const bodyOnly = container.subarray(BACKUP_ENC_MAGIC.length + 5 + jsonLen);
    const header = readEncryptionHeader(tmpFile(container))!;
    const key = await deriveBackupKeyFromHeader(PASS, header);
    const stream = createDecryptStream(header, key);
    const out: Buffer[] = [];
    stream.on('data', (c: Buffer) => out.push(c));
    const done = new Promise<void>((resolve, reject) => {
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    stream.end(bodyOnly);
    await done;
    expect(Buffer.concat(out)).toEqual(plain);
  });

  it('一个字节一个字节地喂也能解密（Transform 必须自己缓冲）', async () => {
    const plain = crypto.randomBytes(3000);
    const container = await encryptAsync(plain);
    const header = readEncryptionHeader(tmpFile(container))!;
    const key = await deriveBackupKeyFromHeader(PASS, header);
    const stream = createDecryptStream(header, key);
    const out: Buffer[] = [];
    stream.on('data', (c: Buffer) => out.push(c));
    for (let i = 0; i < container.length; i += 1) {
      stream.write(container.subarray(i, i + 1));
    }
    const done = new Promise<void>((resolve, reject) => {
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    stream.end();
    await done;
    expect(Buffer.concat(out)).toEqual(plain);
  });

  it('读文件出错会变成一次可诊断的失败，而不是 unhandledRejection', async () => {
    const container = await encryptAsync(Buffer.from('x'));
    const file = tmpFile(container);
    const { source } = await openDecryptedSource(file, PASS, {});
    expect(source).not.toBeNull();
    // 打开之后把文件删掉，制造读取失败
    fs.rmSync(file, { force: true });
    const err = await new Promise<any>((resolve) => {
      source!.on('error', resolve);
      source!.on('end', () => resolve(null));
      source!.resume();
    });
    expect(err).toBeInstanceOf(Error);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('BadRequestException 是用户可见错误的类型（不会被 Nest 变成 500）', async () => {
    const container = await encryptAsync(Buffer.from('x'));
    await expectRejects(() => decryptAsync(container, 'wrong-passphrase-entirely'), /口令不正确/);
    try {
      await decryptAsync(container, 'wrong-passphrase-entirely');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
    }
  });
});

// 防"空转"的对照：上面若干断言依赖 encryptAsync/decryptAsync 真的在跑加解密。
// 如果哪天 createEncryptor 变成直通（不加密），"密文里搜不到明文"那条会红；
// 如果 createDecryptStream 变成直通，"口令错了要拒绝"那条会红。
describe('对照：测试装置本身没有空转', () => {
  it('encryptAsync 的输出与输入不同（不是直通）', async () => {
    const plain = Buffer.from('plain-payload-that-must-not-survive');
    const container = await encryptAsync(plain);
    expect(container.includes(plain)).toBe(false);
    expect(container.length).toBeGreaterThan(plain.length);
  });

  it('decryptAsync 用的是 openDecryptedSource 的真实路径（Readable 而不是手搓）', async () => {
    const plain = crypto.randomBytes(100);
    const container = await encryptAsync(plain);
    const file = tmpFile(container);
    try {
      const { source } = await openDecryptedSource(file, PASS, {});
      expect(source).toBeInstanceOf(Readable);
      source!.destroy();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scrypt 的 maxmem —— 这一节是 M09 变异 `NOT_RED` 的补丁。
//
// 🔴 **不要为了提速把这一节的 KDF 参数改小。** 本文件其余部分都注入 FAST_KDF（N=1024），
//    而 maxmem 这条性质只在**生产参数**下才可观测：N·r·128 = 32768·8·128 = 32 MiB，
//    正好压在 Node 的默认 maxmem（32 MiB）上，不显式给就直接失败。改小参数会让这一节
//    重新变成空转，而且**从测试输出上完全看不出来**（全绿）—— 本仓库已实测过一次。
//
// 为什么这条性质重要：它是"匿名恢复上传不能通过加密头部的 KDF 参数做 CPU/内存放大"的兜底。
// 头部形状校验对 `r`/`p`/`chunkPlainBytes` **没有上限**，全靠 scrypt 的 maxmem 挡住；
// 实测连"绕过 N 上限的等价内存构造 N=2, r=1048576"都会在 0-1ms 被 OpenSSL 拒绝。
// ─────────────────────────────────────────────────────────────────────────────
describe('scrypt 的 maxmem：生产参数下真的会被用到（M09 曾经空转）', () => {
  const PROD_PARAMS = {
    salt: FIXED_SALT,
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    keyLen: SCRYPT_PARAMS.keyLen,
  };

  const noop = () => {
    /* 前提探测用，不关心回调 */
  };

  it('前提核实：生产参数确实超过 Node 的默认 maxmem，而 FAST_KDF 不超过', () => {
    // 这条钉的是**性质成立的前提**，不是我们的代码。实测（node v24.11.0）：
    //   crypto.scrypt(pw, salt, 32, {N:32768,r:8,p:1}, cb)
    //     → **同步抛** RangeError / ERR_CRYPTO_INVALID_SCRYPT_PARAMS
    //       "Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded"（约 1ms）
    //   同样参数带上 maxmem:128MiB → 约 156ms 成功。
    // ⚠️ 注意是**同步抛**（不是回调里给 err）：所以 deriveBackupKey 里那个 Promise executor
    //    会把它变成 rejected promise，而**不是**走到回调里那句 BadRequestException。
    // ⚠️ 如果哪天 Node 抬高了默认上限导致这条变红，说明"必须显式给 maxmem"的理由本身变了 ——
    //    那时应当**重新评估**这一节，而不是把它删掉了事。
    expect(() =>
      crypto.scrypt(Buffer.from(PASS, 'utf8'), FIXED_SALT, SCRYPT_PARAMS.keyLen, 
        { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p }, noop),
    ).toThrow(/memory limit exceeded|Invalid scrypt params/);

    // 对照：FAST_KDF 在**同样不给 maxmem** 时是成功的 ⇒ 这正是 M09 空转的原因，
    // 也是"本文件其余用例为什么发现不了 maxmem 被删"的直接证据。
    expect(() => crypto.scrypt(Buffer.from(PASS, 'utf8'), FIXED_SALT, 32, FAST_KDF, noop)).not.toThrow();
  });

  it('🔴 用**生产参数**真派生一次必须成功（这条是 maxmem 的行为级证据；约 156ms/次）', async () => {
    // 缺 maxmem 时这里会以 RangeError(ERR_CRYPTO_INVALID_SCRYPT_PARAMS) reject ⇒ 用例变红。
    const key = await deriveBackupKey(PASS, PROD_PARAMS);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(SCRYPT_PARAMS.keyLen);

    // 确定性：同口令 + 同盐 + 同参数 ⇒ 同密钥。
    // 这排除"返回了随机字节也算通过"这种假绿 —— 派生必须是口令的确定函数。
    const again = await deriveBackupKey(PASS, PROD_PARAMS);
    expect(again.equals(key)).toBe(true);

    // 不同盐必须给出不同密钥（否则派生根本没在用盐）
    const otherSalt = await deriveBackupKey(PASS, { ...PROD_PARAMS, salt: Buffer.alloc(16, 8) });
    expect(otherSalt.equals(key)).toBe(false);
  });

  it('解密侧（从归档头部取参数）在生产参数下派生出**同一个**密钥 ⇒ 两侧都带着 maxmem', async () => {
    // 核实结论：backupCrypto.ts 里 `crypto.scrypt(` **只有一个调用点**（deriveBackupKey），
    // 而解密侧的 deriveBackupKeyFromHeader 是**委托**给它的 ⇒ 加密与解密共用同一处 maxmem。
    // 这条用例把这个事实变成可观测的：解密侧在生产参数下也必须能派生（缺 maxmem 就会 reject）。
    const header = {
      v: 1,
      kdf: {
        name: 'scrypt',
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        saltLen: SCRYPT_PARAMS.saltLen,
        keyLen: SCRYPT_PARAMS.keyLen,
      },
      salt: FIXED_SALT.toString('base64'),
      iv: FIXED_IV.toString('base64'),
      cipher: 'aes-256-gcm',
      chunkPlainBytes: ENC_CHUNK_PLAIN_BYTES,
      inner: { format: 'zstd', ext: '.tar.zst', label: 'x' },
      createdAt: new Date().toISOString(),
    };
    const viaHeader = await deriveBackupKeyFromHeader(PASS, header as any);
    const direct = await deriveBackupKey(PASS, PROD_PARAMS);
    expect(viaHeader.equals(direct)).toBe(true);
  });

  it('🔴 **默认路径**（不注入 kdf）端到端加解密一轮：生产参数下归档必须能原样解回来', async () => {
    // ⚠️ 本文件其余的 round-trip 用例都注入 FAST_KDF，所以"生产默认参数能不能真跑通一轮"
    //    在此之前**没有任何覆盖** —— 而生产用的恰恰是默认路径。约 2 次派生 ≈ 312ms，值得。
    // 缺 maxmem 时这一条会在加密侧就 reject（RangeError），是最贴近真实使用的一条证据。
    const plain = Buffer.from('production-params-round-trip-payload-\u4e2d\u6587');
    const { transform, header } = await createEncryptor({
      passphrase: PASS,
      inner: { format: 'zstd', ext: '.tar.zst', label: 'zstd -19' },
      salt: FIXED_SALT,
      baseIv: FIXED_IV,
      // 刻意**不传 kdf**：走 SCRYPT_PARAMS 生产默认值
    });
    // 头部里记录的必须是生产参数（否则这条用例其实又跑成了小参数，等于空转）
    expect(header.kdf.N).toBe(SCRYPT_PARAMS.N);
    expect(header.kdf.r).toBe(SCRYPT_PARAMS.r);
    expect(header.kdf.p).toBe(SCRYPT_PARAMS.p);
    const container = await collectAsync(transform, plain);
    expect(isEncryptedHead(container)).toBe(true);
    // decryptAsync 自己管临时文件（并且解密侧从头部取参数 ⇒ 这一轮同时覆盖了两侧的派生）
    const back = await decryptAsync(container);
    expect(back.equals(plain)).toBe(true);
  });

  it('SCRYPT_PARAMS 里的 maxmem 必须真的大于生产参数所需的内存（不是随便写了个数）', () => {
    // Node 的 scrypt 内存需求约 128·N·r 字节；默认上限是 32 MiB，而生产参数正好等于 32 MiB。
    const required = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r;
    expect(SCRYPT_PARAMS.maxmem).toBeGreaterThan(required);
    expect(required).toBe(32 * 1024 * 1024); // 钉住"正好压线"这个前提本身
  });
});

describe('每一个 crypto.scrypt( 调用点都必须显式传 maxmem（源码级尺子，剥注释后）', () => {
  const FILE = path.resolve(__dirname, 'backupCrypto.ts');
  const RAW = fs.readFileSync(FILE, 'utf8');
  const SRC = stripCommentsForAnchor(RAW);

  /**
   * 取出每个 `crypto.scrypt(` 调用的**完整实参列表**（按括号配平），而不是它周围的一行文本。
   *
   * ⚠️ 为什么必须是"调用点内"而不是"文件里出现过 maxmem"：`SCRYPT_PARAMS` 的定义里就写着
   *    `maxmem:`，所以文件级 grep 在 maxmem 被从调用点删掉之后**仍然是绿的** —— 那正是 M09
   *    空转的第二个原因。判据必须是"这个调用的实参里有 maxmem"。
   * ⚠️ 局限（如实记录）：括号配平不解析字符串字面量，所以实参里的字符串若含未配对的括号会算错。
   *    当前源码不存在这种形状；真出现时这条尺子会红（而不是静默放过），失败方向是安全的。
   */
  function scryptCallArgLists(src: string): string[] {
    const needle = 'crypto.scrypt(';
    const out: string[] = [];
    let from = 0;
    for (;;) {
      const at = src.indexOf(needle, from);
      if (at < 0) break;
      let depth = 0;
      let end = -1;
      for (let j = at + needle.length - 1; j < src.length; j++) {
        const ch = src[j];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end > 0) out.push(src.slice(at + needle.length, end));
      from = at + needle.length;
    }
    return out;
  }

  const missingMaxmem = (src: string) => scryptCallArgLists(src).filter((a) => !/maxmem\s*:/.test(a));

  it('尺子没有空转：真实源码里确实找到了调用点', () => {
    // 空转的守卫比没有守卫更糟（本仓库有过 heredoc 参数写错位置、检查从未执行的先例）。
    expect(scryptCallArgLists(SRC).length).toBeGreaterThanOrEqual(1);
  });

  it('每一个调用点都带 maxmem（缺一个就报出它的实参，便于定位）', () => {
    expect({ missing: missingMaxmem(SRC) }).toEqual({ missing: [] });
  });

  it('解密侧的派生必须委托给同一个函数（否则它会自己开一个没有 maxmem 的调用点）', () => {
    expect(SRC).toMatch(
      /export function deriveBackupKeyFromHeader\([\s\S]{0,600}?return deriveBackupKey\(/,
    );
  });

  it('不许出现 scryptSync（阻塞事件循环；备份是分钟级长任务，没有理由省这个 await）', () => {
    expect(SRC).not.toMatch(/scryptSync\s*\(/);
    // 空转反证：原文里那句"不要用 crypto.scryptSync"的注释确实存在，
    // 所以上面这条 not.toMatch 必须跑在**剥注释后**的文本上才有意义。
    expect(RAW).toContain('scryptSync');
    expect(SRC).not.toContain('scryptSync');
  });

  it('负向对照：尺子抓得到"没有 maxmem 的调用点"，也抓得到"maxmem 只写在注释里"', () => {
    // (a) 没有 maxmem 的调用点必须被报出来（这就是 M09 变异后的形状）
    const bad = 'crypto.scrypt(pw, salt, 32, { N: 32768, r: 8, p: 1 }, cb);';
    expect(scryptCallArgLists(bad)).toHaveLength(1);
    expect(missingMaxmem(bad)).toHaveLength(1);

    // (b) 带 maxmem 的必须放过（否则尺子只会一律报红，等于没有判据）
    const good = 'crypto.scrypt(pw, salt, 32, { N: 1, r: 8, p: 1, maxmem: 128 }, cb);';
    expect(missingMaxmem(good)).toHaveLength(0);

    // (c) 两个调用点里只缺一个 ⇒ 必须精确报出 1 个（不是"文件里有 maxmem 就算过"）
    const mixed = `${good}\ncrypto.scrypt(pw, salt, 32, { N: 2, r: 8, p: 1 }, cb);`;
    expect(scryptCallArgLists(mixed)).toHaveLength(2);
    expect(missingMaxmem(mixed)).toHaveLength(1);

    // (d) 注释里的 maxmem 不算：剥注释前"看得见"，剥注释后必须报缺失
    const commented = '// options: { maxmem: 1 } 只是注释\ncrypto.scrypt(pw, salt, 32, { N: 1 }, cb);';
    expect(commented).toContain('maxmem'); // 反证：原文里确实有这个词
    expect(missingMaxmem(stripCommentsForAnchor(commented))).toHaveLength(1);
  });
});
