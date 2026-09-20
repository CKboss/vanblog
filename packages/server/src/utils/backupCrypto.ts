import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { Transform, TransformCallback, Readable } from 'stream';

/**
 * 整站备份归档的**可选**加密层（默认关闭）。
 *
 * ## 为什么要有这个东西
 * 归档是 tar+zstd，**零加密**，而它是**全库导出**：里面有 `settings{type:'jwt'}` 的
 * JWT 签名密钥、全部账号口令的 scrypt 哈希、以及 `tokens` 集合。
 * ⇒ **拿到归档就能离线伪造 `{sub:0, role:'admin'}` 的超管令牌，不需要破解任何口令。**
 * 而异地备份往往存在比源站更不安全的地方（对象存储、网盘、U 盘、别人给的备份机）。
 *
 * 本文件把"归档在别处被读到"从**致命**降级为**需要口令**。它**不**替代 0600 权限
 * （见 utils/secretFileMode.ts）：权限防的是同机用户，加密防的是归档离开这台机器之后。
 *
 * ## 设计取舍（每一条都是有意为之，改之前先读完）
 * 1. **先压缩再加密**：加密后的数据不可压缩，顺序反了归档会大好几倍。
 *    所以容器里装的是"已经 tar+zstd 过的字节流"，头部记下内层格式。
 * 2. **只用 Node 内置 crypto**（scrypt + AES-256-GCM）：不往镜像里装 age/openssl。
 *    多一个二进制 = 多一层供应链与体积，而 `openssl enc` 的默认 KDF 还弱。
 * 3. **分块 GCM，不是整包 GCM**：整包要求把认证标签留到最后，解密端得缓存整个明文
 *    （归档可以几个 GB）。分块让内存恒定在一个块大小。
 *    ⚠️ 分块必须自己防**重排/截断/丢块**——GCM 本身不管顺序，所以：
 *      - 块序号（u64）写进 AAD ⇒ 重排/丢块会让标签校验失败；
 *      - `final` 标志位写进每条记录的 AAD ⇒ 截断（少了最后一块）会被明确识别；
 *      - 解密端另外**显式**校验序号连续，出错信息比"GCM 校验失败"可诊断得多。
 * 4. **头部（含 salt/iv/KDF 参数/内层格式）进每一块的 AAD** ⇒ 头部本身也被认证：
 *    改 salt 或把内层格式从 zstd 换成别的，任何一块都验不过。
 * 5. **IV 用计数器派生**（header 里的 12 字节 base IV，后 8 字节换成块序号）而不是每块随机：
 *    随机 IV 在块数极大时有生日碰撞风险，而 GCM 的 IV 重用是**灾难级**的（可恢复认证子密钥）。
 *    计数器派生在数学上不可能重用。
 * 6. **口令绝不落盘**：不写进归档、不写进 `backup-status.json`、不写进日志、不进报错文本。
 *    日志与报错只说**长度**（沿用 `vanblog.sh` 里 setup.key 的既有做法）。
 * 7. **`.sha256` sidecar 保持明文**：不解密也能验完整性，`backup-status` 与 `verify` 的
 *    "整归档哈希"这条路不需要口令。
 *
 * ## 防"忘了口令"的四条硬规矩
 * 口令只从 env / `_FILE` / 恢复请求的 body 来（永不从库里读、永不写盘）；
 * 任何持久化产物里都不出现口令；口令要与 `restore.key` **分开**存放并进密码管理器；
 * **加密归档必须至少成功演练（drill）一次**才算"备份可用"——没验过的加密备份等于没有备份。
 */

/** 容器魔数。选 ASCII 是为了 `file`/`head -c` 一眼能认出来，且不与任何压缩格式的魔数撞。 */
export const BACKUP_ENC_MAGIC = 'VANBLOGENC1';
const MAGIC_BUF = Buffer.from(BACKUP_ENC_MAGIC, 'ascii');

/** 加密归档的文件名后缀：让运维、`ls`、以及 `zstd -t` 的失败信息都不至于骗人。 */
export const BACKUP_ENC_EXT = '.enc';

export const BACKUP_PASSPHRASE_ENV = 'VANBLOG_BACKUP_PASSPHRASE';
export const BACKUP_PASSPHRASE_FILE_ENV = 'VANBLOG_BACKUP_PASSPHRASE_FILE';

/**
 * 口令最短长度。**低于它直接拒绝备份**，而不是"警告一下然后照样写出一个弱归档"：
 * scrypt 再贵也救不了 4 个字符的口令，而一份能被离线爆破的归档会给运维**虚假的安全感**
 * ——那比明归档更危险（明归档至少没人以为它安全）。
 */
export const MIN_BACKUP_PASSPHRASE_LENGTH = 12;

/** scrypt 参数。N=2^15/r=8/p=1 ⇒ 每次派生约 32 MiB 内存、几十毫秒；写进头部以便将来升参数仍可解密。 */
export const SCRYPT_PARAMS = {
  name: 'scrypt',
  N: 32768,
  r: 8,
  p: 1,
  keyLen: 32,
  saltLen: 16,
  // ⚠️ 必须显式给：Node 的 scrypt 默认 maxmem 是 32 MiB，而 N*r*128 = 32 MiB **正好压线**，
  //    不同版本会直接报 "memory limit exceeded"。留足余量。
  maxmem: 128 * 1024 * 1024,
} as const;

/** 每块明文大小。1 MiB：内存恒定，额外开销 (1+12+16)/1MiB ≈ 0.0028%。 */
export const ENC_CHUNK_PLAIN_BYTES = 1024 * 1024;

export const ENC_CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FLAGS_BYTES = 1;
/** 每条记录的固定开销：flags + iv + tag（另加 4 字节长度前缀） */
const RECORD_OVERHEAD = FLAGS_BYTES + IV_BYTES + TAG_BYTES;
const FLAG_FINAL = 0x01;
const HEADER_VERSION = 1;
/** 头部 JSON 的长度上限：防止有人拿一个几 GB 的"头部"把解密端内存打爆。 */
const MAX_HEADER_JSON_BYTES = 64 * 1024;

export interface BackupEncryptionHeader {
  v: number;
  kdf: { name: string; N: number; r: number; p: number; saltLen: number; keyLen: number };
  /** base64，**不是**口令；salt 公开是安全的，它的作用只是让彩虹表/多目标攻击失效 */
  salt: string;
  /** base64 的 12 字节 base IV，块 IV 由它 + 块序号派生 */
  iv: string;
  cipher: string;
  chunkPlainBytes: number;
  /** 内层（加密之前）的压缩格式，恢复时靠它选解压器 */
  inner: { format: string; ext: string; label: string };
  createdAt: string;
}

/** 口令来源：`_FILE` 优先于内联，与 VANBLOG_ADMIN_PASSWORD_FILE 的既有契约一致。 */
export type PassphraseSource = 'file' | 'env' | 'request' | null;

export interface ResolvedPassphrase {
  passphrase: string | null;
  source: PassphraseSource;
  /** 只描述形状（长度），**绝不**含口令本身 */
  describe(): string;
}

/**
 * 口令的"可日志化描述"。任何日志/报错都只准用它，不许直接打印口令。
 * ⚠️ 连 salt 也不要放进来：salt 本身不机密，但把它和"口令长度"一起写进日志
 *    会让日志文件变成离线爆破的现成输入包。
 */
export function describePassphrase(passphrase: string | null): string {
  if (!passphrase) {
    return '未设置';
  }
  return `已设置（${Buffer.byteLength(passphrase, 'utf8')} 字节，不回显）`;
}

/**
 * 解析备份口令。
 *
 * 契约（与 `envBootstrap.ts` 的 admin 密码一致）：
 *  - `VANBLOG_BACKUP_PASSPHRASE_FILE`（路径，例如 Docker secret）**优先于**内联变量；
 *  - secret 文件按标准契约只 **trimEnd**（前导空白理论上可能是口令的一部分，
 *    而尾部换行几乎一定是 `echo`/编辑器带进来的）；
 *  - 内联值按字面字节使用（env 没有"尾部换行"问题）；
 *  - `explicit` 来自恢复请求的 body（**只能**走 body，不能走 query：query 会进 caddy 访问日志）。
 */
export function resolveBackupPassphrase(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string | null,
): ResolvedPassphrase {
  if (typeof explicit === 'string' && explicit.length > 0) {
    return {
      passphrase: explicit,
      source: 'request',
      describe: () => describePassphrase(explicit),
    };
  }
  const filePath = String(env[BACKUP_PASSPHRASE_FILE_ENV] ?? '').trim();
  if (filePath) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      // 设了 _FILE 却读不到 ⇒ **失败关闭**。静默回落到"没口令"会让站长以为
      // 归档是加密的，实际写出的是明文 —— 那比不做这个功能更糟。
      throw new BadRequestException(
        `读取 ${BACKUP_PASSPHRASE_FILE_ENV}（${filePath}）失败：${(err as Error)?.message || err}` +
          ` —— 已拒绝继续（不会静默回落到明文备份）。请检查路径与读权限，或改用 ${BACKUP_PASSPHRASE_ENV}。`,
      );
    }
    const value = raw.replace(/\s+$/, '');
    if (!value) {
      throw new BadRequestException(
        `${BACKUP_PASSPHRASE_FILE_ENV}（${filePath}）去掉尾部空白后是空的：拒绝用它加密备份`,
      );
    }
    return { passphrase: value, source: 'file', describe: () => describePassphrase(value) };
  }
  const inline = env[BACKUP_PASSPHRASE_ENV];
  if (typeof inline === 'string' && inline.length > 0) {
    return { passphrase: inline, source: 'env', describe: () => describePassphrase(inline) };
  }
  return { passphrase: null, source: null, describe: () => describePassphrase(null) };
}

/**
 * 校验口令强度。**只在加密时调用**（解密时不许校验：否则改短了最小长度就读不了老归档）。
 */
export function assertPassphraseUsableForEncryption(passphrase: string): void {
  const bytes = Buffer.byteLength(passphrase, 'utf8');
  if (bytes < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new BadRequestException(
      `备份口令太短（${bytes} 字节，最少 ${MIN_BACKUP_PASSPHRASE_LENGTH} 字节）：` +
        `scrypt 再贵也救不了短口令，而一份能被离线爆破的归档只会给人虚假的安全感。` +
        `请用更长的口令（一句只有你知道的话就够），或清掉 ${BACKUP_PASSPHRASE_ENV} / ` +
        `${BACKUP_PASSPHRASE_FILE_ENV} 回到明文备份（明文归档请按凭据保管，权限已是 0600）。`,
    );
  }
}

/** 这个文件头是不是我们的加密容器（只看前 11 字节，不需要口令）。 */
export function isEncryptedHead(head: Buffer): boolean {
  return head.length >= MAGIC_BUF.length && head.subarray(0, MAGIC_BUF.length).equals(MAGIC_BUF);
}

/** 文件名是不是加密归档（`.enc` 后缀）。⚠️ 只用于展示/命名，**判定一律以魔数为准**。 */
export function hasEncryptedSuffix(file: string): boolean {
  return file.toLowerCase().endsWith(BACKUP_ENC_EXT);
}

/**
 * 读并解析容器头部。**不需要口令**（头部是明文，但被每一块的 AAD 认证，改不了）。
 * 返回 null 表示"这不是加密归档"。
 */
export function readEncryptionHeader(archivePath: string): BackupEncryptionHeader | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(archivePath, 'r');
    const magic = Buffer.alloc(MAGIC_BUF.length);
    const gotMagic = fs.readSync(fd, magic, 0, MAGIC_BUF.length, 0);
    if (gotMagic < MAGIC_BUF.length || !isEncryptedHead(magic)) {
      return null;
    }
    const lenBuf = Buffer.alloc(5); // 1 字节 headerVersion + 4 字节 headerLen
    const gotLen = fs.readSync(fd, lenBuf, 0, 5, MAGIC_BUF.length);
    if (gotLen < 5) {
      throw new BadRequestException(`加密归档头部被截断（${archivePath}）：读不到版本/长度字段`);
    }
    const version = lenBuf[0];
    if (version !== HEADER_VERSION) {
      throw new BadRequestException(
        `不支持的加密归档版本 ${version}（本程序只认 ${HEADER_VERSION}）：${archivePath}`,
      );
    }
    const headerLen = lenBuf.readUInt32LE(1);
    if (headerLen <= 0 || headerLen > MAX_HEADER_JSON_BYTES) {
      throw new BadRequestException(
        `加密归档头部长度非法（${headerLen} 字节，上限 ${MAX_HEADER_JSON_BYTES}）：${archivePath}`,
      );
    }
    const jsonBuf = Buffer.alloc(headerLen);
    const gotJson = fs.readSync(fd, jsonBuf, 0, headerLen, MAGIC_BUF.length + 5);
    if (gotJson < headerLen) {
      throw new BadRequestException(`加密归档头部被截断（${archivePath}）：JSON 不完整`);
    }
    const header = JSON.parse(jsonBuf.toString('utf8')) as BackupEncryptionHeader;
    assertHeaderShape(header, archivePath);
    return header;
  } catch (err) {
    if (err instanceof BadRequestException) {
      throw err;
    }
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw new BadRequestException(
      `读不出加密归档头部（${archivePath}）：${(err as Error)?.message || err}`,
    );
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 头部形状校验。⚠️ 这不是洁癖：头部里的 `N/r/p/keyLen/chunkPlainBytes` 会直接喂给
 * scrypt 与解密循环，一个被替换的头部（例如 `keyLen: 1`）会让解密端做出蠢事。
 * 虽然 GCM 最终会拒绝，但**在花钱派生密钥之前**就把话说清楚更好。
 */
function assertHeaderShape(header: any, archivePath: string): void {
  const bad = (why: string): never => {
    throw new BadRequestException(`加密归档头部不可信（${why}）：${archivePath}`);
  };
  if (!header || typeof header !== 'object') bad('不是对象');
  if (header.v !== HEADER_VERSION) bad(`版本 ${header.v} != ${HEADER_VERSION}`);
  if (header.cipher !== ENC_CIPHER) bad(`未知 cipher ${String(header.cipher)}`);
  const kdf = header.kdf;
  if (!kdf || typeof kdf !== 'object') bad('缺 kdf');
  if (kdf.name !== 'scrypt') bad(`未知 kdf ${String(kdf.name)}`);
  for (const key of ['N', 'r', 'p', 'keyLen', 'saltLen'] as const) {
    const n = kdf[key];
    if (!Number.isInteger(n) || n <= 0) bad(`kdf.${key} 非法（${String(n)}）`);
  }
  // 上限：防止一个恶意头部让解密端申请天文数字的内存（scrypt 的 N 必须是 2 的幂）
  if (kdf.N > 2 ** 21) bad(`kdf.N 过大（${kdf.N}）`);
  if (kdf.keyLen !== 32) bad(`kdf.keyLen 必须是 32（AES-256），实际 ${kdf.keyLen}`);
  if (kdf.saltLen !== 16) bad(`kdf.saltLen 必须是 16，实际 ${kdf.saltLen}`);
  if (typeof header.salt !== 'string' || Buffer.from(header.salt, 'base64').length !== kdf.saltLen) {
    bad('salt 不是合法 base64 或长度不符');
  }
  if (typeof header.iv !== 'string' || Buffer.from(header.iv, 'base64').length !== IV_BYTES) {
    bad(`iv 必须是 ${IV_BYTES} 字节的 base64`);
  }
  if (!Number.isInteger(header.chunkPlainBytes) || header.chunkPlainBytes <= 0) {
    bad(`chunkPlainBytes 非法（${String(header.chunkPlainBytes)}）`);
  }
  if (!header.inner || typeof header.inner.format !== 'string') bad('缺 inner.format');
}

/** 序列化头部为"进 AAD 的那份字节"（必须与写盘那份逐字节相同）。 */
function encodeHeaderBytes(header: BackupEncryptionHeader): { prefix: Buffer; json: Buffer } {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(MAGIC_BUF.length + 1 + 4);
  MAGIC_BUF.copy(prefix, 0);
  prefix[MAGIC_BUF.length] = HEADER_VERSION;
  prefix.writeUInt32LE(json.length, MAGIC_BUF.length + 1);
  return { prefix, json };
}

/** 每块的 AAD：魔数+版本+头部长度+头部 JSON+块序号+flags。 */
function chunkAad(headerPrefix: Buffer, headerJson: Buffer, index: number, flags: number): Buffer {
  const tail = Buffer.alloc(8 + 1);
  tail.writeBigUInt64BE(BigInt(index), 0);
  tail[8] = flags;
  return Buffer.concat([headerPrefix, headerJson, tail]);
}

/** 块 IV = base IV 的前 4 字节 + 块序号（BE u64）。计数器派生 ⇒ 永不重用。 */
function chunkIv(baseIv: Buffer, index: number): Buffer {
  const iv = Buffer.alloc(IV_BYTES);
  baseIv.subarray(0, IV_BYTES - 8).copy(iv, 0);
  iv.writeBigUInt64BE(BigInt(index), IV_BYTES - 8);
  return iv;
}

/**
 * 异步派生密钥。
 *
 * ⚠️ **一律用异步版**，不要用 `crypto.scryptSync`：本仓库已经有一条漂移守卫
 * （`utils/cryptoUsageDrift.spec.ts`）在盯"同步 scrypt 阻塞事件循环"这件事，理由是
 * 单次同步 scrypt 实测约 63 ms（而这里 N=2^15 更贵），期间**整个 worker 的事件循环停摆**
 * —— 健康检查会超时、在途请求全部排队。备份本来就是分钟级的长任务，
 * 没有理由为了省一个 await 去阻塞它。
 */
export function deriveBackupKey(
  passphrase: string,
  params: { salt: Buffer; N: number; r: number; p: number; keyLen: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(passphrase, 'utf8'),
      params.salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_PARAMS.maxmem },
      (err, derived) => {
        if (err) {
          // ⚠️ 不要把 err.message 原样抛给用户：某些错误路径会带上参数细节。
          reject(new BadRequestException(`派生备份密钥失败：${(err as Error)?.name || 'scrypt error'}`));
          return;
        }
        resolve(derived);
      },
    );
  });
}

/** 从头部取派生参数（解密侧用；参数来自归档自己，所以将来改默认值也解得开老归档）。 */
export function deriveBackupKeyFromHeader(
  passphrase: string,
  header: BackupEncryptionHeader,
): Promise<Buffer> {
  return deriveBackupKey(passphrase, {
    salt: Buffer.from(header.salt, 'base64'),
    N: header.kdf.N,
    r: header.kdf.r,
    p: header.kdf.p,
    keyLen: header.kdf.keyLen,
  });
}

export interface EncryptorOptions {
  passphrase: string;
  inner: { format: string; ext: string; label: string };
  /** 测试可注入固定 salt/iv；生产一律随机 */
  salt?: Buffer;
  baseIv?: Buffer;
  now?: Date;
  /**
   * ⚠️ **只给测试用**：调低 scrypt 的 N/r/p。
   *
   * 为什么需要它：生产参数（N=2^15）单次派生约 100 ms，而端到端用例里
   * "加密一次 + 解密一次"要跑十几遍，累积起来就是秒级——本仓库的规矩是
   * **回归要快速失败**，一个几分钟的单测会拖垮 CI 并让并行验证频繁假红。
   * 因为参数会写进头部、解密侧按头部派生，所以调低 N 不影响往返正确性，
   * 只是让测试里"抗爆破"这一性质变弱（那不是测试要验证的东西）。
   * 生产调用点**不许**传这个字段（有一条断言盯着默认值）。
   */
  kdf?: { N?: number; r?: number; p?: number };
}

export interface Encryptor {
  header: BackupEncryptionHeader;
  transform: Transform;
}

/**
 * 造一个加密 Transform：**输入是压缩后的字节，输出是完整容器（含头部）**。
 * 用法：`compressor.stdout.pipe(createEncryptor(...).transform).pipe(outFileStream)`。
 */
export async function createEncryptor(options: EncryptorOptions): Promise<Encryptor> {
  assertPassphraseUsableForEncryption(options.passphrase);
  const salt = options.salt ?? crypto.randomBytes(SCRYPT_PARAMS.saltLen);
  const baseIv = options.baseIv ?? crypto.randomBytes(IV_BYTES);
  const kdf = {
    N: options.kdf?.N ?? SCRYPT_PARAMS.N,
    r: options.kdf?.r ?? SCRYPT_PARAMS.r,
    p: options.kdf?.p ?? SCRYPT_PARAMS.p,
  };
  const header: BackupEncryptionHeader = {
    v: HEADER_VERSION,
    kdf: {
      name: SCRYPT_PARAMS.name,
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      saltLen: SCRYPT_PARAMS.saltLen,
      keyLen: SCRYPT_PARAMS.keyLen,
    },
    salt: salt.toString('base64'),
    iv: baseIv.toString('base64'),
    cipher: ENC_CIPHER,
    chunkPlainBytes: ENC_CHUNK_PLAIN_BYTES,
    inner: options.inner,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  const { prefix, json } = encodeHeaderBytes(header);
  const headerBytes = Buffer.concat([prefix, json]);
  const key = await deriveBackupKey(options.passphrase, {
    salt,
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    keyLen: SCRYPT_PARAMS.keyLen,
  });

  let index = 0;
  let pending = Buffer.alloc(0);
  let headerWritten = false;

  const transform = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        if (!headerWritten) {
          headerWritten = true;
          this.push(headerBytes);
        }
        pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
        while (pending.length >= ENC_CHUNK_PLAIN_BYTES) {
          const plain = pending.subarray(0, ENC_CHUNK_PLAIN_BYTES);
          pending = pending.subarray(ENC_CHUNK_PLAIN_BYTES);
          this.push(encryptRecord(key, baseIv, prefix, json, index, plain, 0));
          index += 1;
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!headerWritten) {
          headerWritten = true;
          this.push(headerBytes);
        }
        // ⚠️ 即使 pending 是空的也要写一条 final 记录：明文长度正好是块大小整数倍时，
        //    "最后一块"就是这块空记录，少了它解密端会判定"归档被截断"。
        this.push(encryptRecord(key, baseIv, prefix, json, index, pending, FLAG_FINAL));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
  return { header, transform };
}

function encryptRecord(
  key: Buffer,
  baseIv: Buffer,
  headerPrefix: Buffer,
  headerJson: Buffer,
  index: number,
  plain: Buffer,
  flags: number,
): Buffer {
  const iv = chunkIv(baseIv, index);
  const cipher = crypto.createCipheriv(ENC_CIPHER, key, iv);
  cipher.setAAD(chunkAad(headerPrefix, headerJson, index, flags));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const bodyLen = FLAGS_BYTES + IV_BYTES + ct.length + TAG_BYTES;
  const out = Buffer.alloc(4 + bodyLen);
  out.writeUInt32LE(bodyLen, 0);
  out[4] = flags;
  iv.copy(out, 4 + FLAGS_BYTES);
  ct.copy(out, 4 + FLAGS_BYTES + IV_BYTES);
  tag.copy(out, 4 + FLAGS_BYTES + IV_BYTES + ct.length);
  return out;
}

/**
 * 解密流：输入是容器字节（从魔数开始），输出是**压缩后的**字节（还没解压）。
 *
 * ⚠️ 失败一律 `destroy(err)`，由调用方转成 BadRequestException。绝不允许
 * "解密失败但已经把部分明文吐出去了"——调用方可能已经把它喂给 tar，
 * 于是半份数据被解包进暂存目录。GCM 的分块设计天然保证：任何一块验不过，
 * 那一块**一个字节都不会**被 push（先 final() 校验，再 push）。
 */
export function createDecryptStream(header: BackupEncryptionHeader, key: Buffer): Transform {
  const { prefix, json } = encodeHeaderBytes(header);
  const baseIv = Buffer.from(header.iv, 'base64');
  let buf = Buffer.alloc(0);
  let index = 0;
  let sawFinal = false;
  let magicConsumed = false;

  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
        if (!magicConsumed) {
          // 调用方可能把整个文件（含魔数与头部）喂进来，也可能已经剥掉了头部。
          // 两种都支持：能对上魔数就吃掉 magic+version+len+json。
          if (buf.length < MAGIC_BUF.length) {
            cb();
            return;
          }
          if (isEncryptedHead(buf)) {
            const total = MAGIC_BUF.length + 1 + 4 + json.length;
            if (buf.length < total) {
              cb();
              return;
            }
            const declared = buf.readUInt32LE(MAGIC_BUF.length + 1);
            if (declared !== json.length) {
              cb(
                new BadRequestException(
                  '加密归档头部与内容不符（声明长度与解析出的头部不一致）：归档可能已被篡改',
                ),
              );
              return;
            }
            buf = buf.subarray(total);
          }
          magicConsumed = true;
        }
        for (;;) {
          if (sawFinal) {
            if (buf.length > 0) {
              cb(
                new BadRequestException(
                  '加密归档在结束标记之后还有多余字节：归档可能已被篡改或拼接',
                ),
              );
              return;
            }
            break;
          }
          if (buf.length < 4) break;
          const bodyLen = buf.readUInt32LE(0);
          if (bodyLen < RECORD_OVERHEAD) {
            cb(new BadRequestException(`加密归档记录长度非法（${bodyLen} 字节）：归档已损坏`));
            return;
          }
          if (buf.length < 4 + bodyLen) break;
          const flags = buf[4];
          const iv = buf.subarray(4 + FLAGS_BYTES, 4 + FLAGS_BYTES + IV_BYTES);
          const ct = buf.subarray(4 + FLAGS_BYTES + IV_BYTES, 4 + bodyLen - TAG_BYTES);
          const tag = buf.subarray(4 + bodyLen - TAG_BYTES, 4 + bodyLen);
          const plain = decryptRecord(key, baseIv, iv, prefix, json, index, flags, ct, tag);
          buf = buf.subarray(4 + bodyLen);
          index += 1;
          if (plain.length > 0) {
            this.push(plain);
          }
          if ((flags & FLAG_FINAL) !== 0) {
            sawFinal = true;
          }
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      if (!sawFinal) {
        cb(
          new BadRequestException(
            '加密归档被截断：没有读到带结束标记的最后一块（文件不完整，或下载/拷贝中断）',
          ),
        );
        return;
      }
      cb();
    },
  });
}

function decryptRecord(
  key: Buffer,
  baseIv: Buffer,
  iv: Buffer,
  headerPrefix: Buffer,
  headerJson: Buffer,
  index: number,
  flags: number,
  ct: Buffer,
  tag: Buffer,
): Buffer {
  // ⚠️ 先做可诊断的结构性校验，再落到 GCM。
  // 块 IV 必须由 base IV + 序号派生，所以「IV 与序号对不上」只可能是块被重排或丢失。
  // GCM 本来也会因 AAD 里的序号不符而失败，但那条错误只会说「校验失败」，运维分不清
  // 是「口令错了」还是「归档被重排了」—— 这两种情况的处置完全不同（前者去找口令，
  // 后者去查拷贝/传输链路）。
  const expectedIv = chunkIv(baseIv, index);
  if (!iv.equals(expectedIv)) {
    throw new BadRequestException(
      `加密归档的块顺序不对（第 ${index + 1} 块的 IV 与序号不匹配）：` +
        '归档可能被重排、丢块，或截断后又被拼接过。',
    );
  }
  const decipher = crypto.createDecipheriv(ENC_CIPHER, key, iv);
  decipher.setAAD(chunkAad(headerPrefix, headerJson, index, flags));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new BadRequestException(
      `解密失败（第 ${index + 1} 块）：口令不正确，或归档已被篡改/损坏` +
        `（${ENC_CIPHER} 认证未通过）。口令与 salt 都不会写进日志。`,
    );
  }
}

/**
 * 打开一个归档用于**解压**：返回该喂给解压器 stdin 的流，或 null（表示"未加密，
 * 照旧把文件路径当命令行参数传给解压器"，保持既有行为逐字节不变）。
 *
 * ⚠️ 口令解析顺序：显式传入（恢复请求的 body）> env/_FILE。
 *    这样"服务器上配了口令"与"恢复一份别人给的、口令不同的归档"两种场景都能工作。
 */
export async function openDecryptedSource(
  archivePath: string,
  explicitPassphrase?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ source: Readable | null; header: BackupEncryptionHeader | null }> {
  const header = readEncryptionHeader(archivePath);
  if (!header) {
    return { source: null, header: null };
  }
  const resolved = resolveBackupPassphrase(env, explicitPassphrase);
  if (!resolved.passphrase) {
    throw new BadRequestException(
      `这份归档是加密的（${BACKUP_ENC_MAGIC}，scrypt + ${ENC_CIPHER}），但当前没有可用的解密口令。` +
        `两个办法任选：①在恢复请求的 body 里带 \`backupPassphrase\`（只走 body，不会进 URL 或访问日志）；` +
        `②给 server 设置 ${BACKUP_PASSPHRASE_ENV} 或 ${BACKUP_PASSPHRASE_FILE_ENV} 后重试。` +
        `（口令不会被回显，报错与日志里只有长度。）`,
    );
  }
  const key = await deriveBackupKeyFromHeader(resolved.passphrase, header);
  const fileStream = fs.createReadStream(archivePath);
  const decrypt = createDecryptStream(header, key);
  // ⚠️ 读文件出错必须转成一次失败，不能让 fs 流的 error 变成 unhandledRejection
  //    （Node 20 会直接退出进程；本仓库已经为"流没有 error 监听"栽过跟头）。
  const wrapped = fileStream.pipe(decrypt);
  fileStream.on('error', (err: Error) => {
    decrypt.destroy(
      new BadRequestException(`读取加密归档失败（${archivePath}）：${err.message}`),
    );
  });
  return { source: wrapped, header };
}

/**
 * 给 `backup-status.json` 与 manifest 用的**非机密**摘要。
 *
 * ⚠️ 这里可以放 salt（salt 公开是安全的，它只防多目标攻击），但**绝不能**放口令、
 * 派生出的密钥、或任何能从这两个推出来的东西。这份摘要会被写进随归档一起拷走的
 * sidecar 清单，也会被后台的备份列表接口返回。
 */
export interface BackupEncryptionSummary {
  encrypted: true;
  container: string;
  cipher: string;
  kdf: { name: string; N: number; r: number; p: number; saltLen: number; keyLen: number };
  saltBase64: string;
  chunkPlainBytes: number;
  inner: { format: string; ext: string; label: string };
}

// ⚠️ 重载而不是返回联合类型：调用方在"已经确定加密了"的分支里拿到的必须是
//    `BackupEncryptionSummary`，否则 manifest 那个可选字段赋值不过类型检查
//    （联合类型里的 `{encrypted:false}` 分支塞不进 `encryption?: BackupEncryptionSummary`）。
export function encryptionSummary(header: BackupEncryptionHeader): BackupEncryptionSummary;
export function encryptionSummary(header: null): { encrypted: false };
export function encryptionSummary(
  header: BackupEncryptionHeader | null,
): { encrypted: false } | BackupEncryptionSummary {
  if (!header) {
    return { encrypted: false };
  }
  return {
    encrypted: true,
    container: BACKUP_ENC_MAGIC,
    cipher: header.cipher,
    kdf: { ...header.kdf },
    saltBase64: header.salt,
    chunkPlainBytes: header.chunkPlainBytes,
    inner: { ...header.inner },
  };
}

/**
 * 明文归档（未加密）成功后要打的 WARN 文案。
 *
 * ⚠️ 写成"事实 + 怎么开"，不要写成恐吓：站长可能就是想在内网里存明归档，
 *    那是他的选择；我们要保证的是他**知道**这份文件里有什么。
 */
export function plaintextArchiveWarning(archiveName: string): string {
  return (
    `备份成功，但这份归档是**明文**的（${archiveName}）：里面含 JWT 签名密钥、` +
    `全部账号口令的 scrypt 哈希、以及 API Token —— 拿到它就能离线伪造管理员令牌，不需要破解口令。` +
    `文件权限已收紧到 0600（同机其他用户读不到），但**归档一旦被复制走就不再受保护**。` +
    `要加密就给容器设置 ${BACKUP_PASSPHRASE_ENV}（或 ${BACKUP_PASSPHRASE_FILE_ENV} 指向一个 secret 文件，` +
    `至少 ${MIN_BACKUP_PASSPHRASE_LENGTH} 字节），下次备份起自动生效；` +
    `⚠️ 口令丢失 = 归档不可恢复，请与 restore.key 分开存进密码管理器，并先做一次恢复演练确认能解开。`
  );
}
