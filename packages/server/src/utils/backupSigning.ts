import { BadRequestException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SECRET_DIR_MODE, ensureSecretDir, writeSecretFileSync } from './secretFileMode';
import { recordRestoreRejection } from './restoreSecurityLog';

/**
 * 整站备份归档的**离线签名**（detached signature），用来回答一个问题：
 *
 * > 「我手上这份归档，还是当初备份出来的那一份吗？」
 *
 * ## 为什么已有的两道校验回答不了这个问题
 * 归档已经有 `integrity` 块（逐成员 sha256 + merkleRoot + zstd 帧校验）与 `.sha256` sidecar，
 * 但它们**只防意外损坏，不防有意篡改**：sidecar 与归档在**同一个目录**里，能替换归档的人
 * 也能顺手替换 sidecar 与归档内部那份 manifest —— 三者会一起变，校验自然"通过"。
 * 换句话说，现有的校验能证明"这份归档**自洽**"，证明不了"这份归档**是真的**"。
 *
 * 签名补的就是这一层：签名用**私钥**产生，验证只需要**公钥**。公钥可以被随便复制、
 * 放在对象存储/异地机器/DR 主机上，拿到公钥的人**能验、不能伪造**。于是"归档 + sidecar
 * 一起被换掉"不再够用 —— 攻击者还得拿到私钥。
 *
 * ## 🔴 信任边界（务必照实理解，别把它当成更强的东西）
 * **验签材料（公钥）必须存在主机之外**，否则这个功能等于没做。具体地：
 *  - 它防的是「归档**离开主机之后**被篡改」—— 上传到对象存储、拷进网盘、写到 U 盘、
 *    同步到异地副本、交给另一台机器去恢复：这些路径上任何一环被动手脚都能被发现。
 *  - 它**不防**已经拿到**主机 root** 的攻击者：私钥必须在主机上（否则没法签名），
 *    有 root 就能读私钥、重新签一份、把归档和 `.sig` 一起换掉，验签照样通过。
 *    同理，把公钥也存在同一台主机上（且攻击者能写）时，他可以连公钥一起换。
 *  - 所以正确用法是：**公钥的权威副本离线保存**（密码管理器 / 打印 / 另一台机器），
 *    恢复时用它来验，而不是用主机上那份。
 *
 * ## 为什么签名密钥不从备份口令派生
 * `VANBLOG_BACKUP_PASSPHRASE` 已经存在，用它 scrypt 派生一个 ed25519 种子在技术上完全可行，
 * 但**故意没有那么做**：那样"验签"就需要口令，而**任何持有口令的一方都同时能签名** ⇒
 * 异地副本/DR 主机为了验签就得拿到口令，也就获得了伪造能力，非对称签名的全部意义
 * （验证方无法伪造）当场消失。附带好处是"加密口令泄露"与"签名密钥泄露"是两件独立的事，
 * 不会一次性双双失守。
 *
 * ## 与加密的关系与顺序
 * 签名签的是**最终落盘那个文件的 sha256**：明文归档签明文，加密归档签**密文**。
 * 完整顺序是 `tar → 压缩(zstd) → 加密(可选) → 流式算 sha256 → 签名`。
 * 这样有两个好处：①**不解密也能验真实性**（DR 主机只需要公钥，不需要口令）；
 * ②与"`.sha256`/`.manifest.json` sidecar 保持明文"的既有决定一致。
 * ⚠️ 注意签名**不覆盖**机密性：加密与否是 `VANBLOG_BACKUP_PASSPHRASE` 的事，两者独立。
 *
 * ## 默认关闭
 * 没有配任何密钥时，**一个字节都不写、行为与加这个功能之前逐字节一致**（有守卫钉住）。
 */

const logger = new Logger('BackupSigning');

/** `.sig` sidecar 的后缀。⚠️ 明文归档与加密归档都用它（`xxx.tar.zst.sig` / `xxx.tar.zst.enc.sig`）。 */
export const BACKUP_SIG_EXT = '.sig';

/**
 * 签名文件的魔数与版本。选 ASCII 是为了 `head -c` 一眼能认，且不与别的格式撞。
 * ⚠️ 校验以魔数为准，**不看后缀**（与加密归档 `VANBLOGENC1` 的既有做法一致）：
 * 后缀是给人看的提示，改名不应该让一份好签名"认不出来"。
 */
export const BACKUP_SIG_MAGIC = 'VANBLOGSIG1';
export const BACKUP_SIG_VERSION = 1;

/** 签名算法。ed25519：Node 内置、签名 64 字节、无参数可配错（不像 RSA 要选 padding/哈希）。 */
export const BACKUP_SIG_ALG = 'ed25519';
/** 被签的摘要算法。签的是**已经流式算出来的整档 sha256**，不为签名再读一遍归档（归档可能几个 GB）。 */
export const BACKUP_SIG_DIGEST = 'sha256';

export const SIGNING_KEY_ENV = 'VANBLOG_BACKUP_SIGNING_KEY';
export const SIGNING_KEY_FILE_ENV = 'VANBLOG_BACKUP_SIGNING_KEY_FILE';
export const VERIFY_KEY_ENV = 'VANBLOG_BACKUP_VERIFY_KEY';
export const VERIFY_KEY_FILE_ENV = 'VANBLOG_BACKUP_VERIFY_KEY_FILE';

/**
 * `POST /api/admin/backup/signing/key` 生成的密钥对落在这里（备份目录下的 `signing/`）。
 * ⚠️ 目录 0700、文件 0600（沿用 `utils/secretFileMode.ts` 的既有约定）。
 * ⚠️ **私钥绝不经过任何 HTTP 接口返回**：生成时直接落盘，接口只回公钥与指纹。
 * 想让私钥离开备份目录（例如用 Docker secret 挂进来），改用 `VANBLOG_BACKUP_SIGNING_KEY_FILE`。
 */
export const SIGNING_KEY_DIRNAME = 'signing';
export const SIGNING_PRIVATE_KEY_FILENAME = 'backup-signing-key.pem';
export const SIGNING_PUBLIC_KEY_FILENAME = 'backup-signing-key.pub.pem';

/** 读密钥文件时允许的最大字节数：PEM 私钥几 KB，留足余量又能挡住"把一个大文件当密钥读进内存"。 */
const MAX_KEY_FILE_BYTES = 64 * 1024;
/** `.sig` 文件本身的上限（正常约 700 字节）：防止有人拿一个几 GB 的 `.sig` 打解析端。 */
const MAX_SIG_FILE_BYTES = 64 * 1024;

export type SigningKeySource = 'env-file' | 'env' | 'generated' | null;

export interface SigningKeyMaterial {
  /** PKCS#8 PEM 私钥（只用于签名；⚠️ 绝不写进日志/状态文件/接口响应） */
  privateKeyPem: string;
  /** SPKI PEM 公钥（可以从私钥导出，所以只配私钥也能验签） */
  publicKeyPem: string;
  fingerprint: string;
  source: SigningKeySource;
}

export interface VerifyKeyMaterial {
  publicKeyPem: string;
  fingerprint: string;
  source: SigningKeySource;
}

/**
 * 密钥指纹：公钥 DER 的 sha256 前 16 位十六进制。
 *
 * 与 JWT 轮换用的 `kidOf`（`utils/initJwt.ts:214`）同一思路：**指纹是密钥的纯函数**，
 * 所以不必额外存"这把钥匙的 id"，也不必做数据迁移。
 * ⚠️ 指纹会出现在 `.sig` 与接口响应里（都是公开的），所以它**不能泄露私钥** ——
 * 它是公钥的哈希，而公钥本来就可以公开。
 * ⚠️ 它的用途是**区分"拿错钥匙"与"归档被改过"**：ed25519 验签失败本身分不出这两种情况，
 * 但指纹不匹配可以。这两种情况的处置完全不同（一个是去拿对的公钥，一个是这份归档不可信），
 * 在灾难现场混成一句"校验失败"会让人做错决定。
 */
export function keyFingerprint(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** 只描述形状，绝不回显密钥内容。任何日志/报错都只准用它。 */
export function describeSigningKey(key: SigningKeyMaterial | null): string {
  if (!key) {
    return '未配置（备份不签名）';
  }
  return `已配置（${key.source}，指纹 ${key.fingerprint}，不回显）`;
}

function readKeyFile(envName: string, rawPath: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(rawPath);
  } catch (err) {
    // 设了 _FILE 却读不到 ⇒ **失败关闭**（与 `VANBLOG_BACKUP_PASSPHRASE_FILE` 同一契约）。
    // 静默回落到"没配密钥"会让站长以为归档签了名，实际没签 —— 那比不做这个功能更糟，
    // 因为他会照着"我有签名保护"去规划异地副本。
    throw new BadRequestException(
      `读取 ${envName}（${rawPath}）失败：${(err as Error)?.message || err}` +
        ` —— 已拒绝继续（不会静默回落到"不签名"）。请检查路径与读权限，或改用内联变量。`,
    );
  }
  if (stat.size > MAX_KEY_FILE_BYTES) {
    throw new BadRequestException(
      `${envName}（${rawPath}）有 ${stat.size} 字节，超过 ${MAX_KEY_FILE_BYTES} 字节上限：` +
        `这不像是一个 ed25519 PEM 密钥（正常几百字节），已拒绝读入`,
    );
  }
  const raw = fs.readFileSync(rawPath, 'utf8');
  // 只 trimEnd：与 secret-file 的既有契约一致（尾部换行几乎一定是 echo/编辑器带进来的，
  // 而前导空白理论上可能是内容的一部分 —— PEM 不会有，但契约统一比逐处特例更好）。
  const value = raw.replace(/\s+$/, '');
  if (!value) {
    throw new BadRequestException(`${envName}（${rawPath}）去掉尾部空白后是空的：拒绝把它当密钥`);
  }
  return value;
}

function toSigningMaterial(pem: string, source: SigningKeySource): SigningKeyMaterial {
  let privateKeyPem: string;
  let publicKeyPem: string;
  try {
    const priv = crypto.createPrivateKey(pem);
    if (priv.asymmetricKeyType !== 'ed25519') {
      throw new Error(`密钥类型是 ${priv.asymmetricKeyType}，本功能只支持 ed25519`);
    }
    privateKeyPem = priv.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKeyPem = crypto
      .createPublicKey(priv)
      .export({ type: 'spki', format: 'pem' })
      .toString();
  } catch (err) {
    throw new BadRequestException(
      `签名私钥不可用：${(err as Error)?.message || err}。` +
        `需要一把 ed25519 私钥（PEM，PKCS#8）；可以用 POST /api/admin/backup/signing/key 生成一对，` +
        `或 openssl genpkey -algorithm ed25519 自己生成。`,
    );
  }
  return { privateKeyPem, publicKeyPem, fingerprint: keyFingerprint(publicKeyPem), source };
}

function toVerifyMaterial(pem: string, source: SigningKeySource): VerifyKeyMaterial {
  let publicKeyPem: string;
  try {
    // ⚠️ 也接受"给了私钥当验签钥"：一体式部署里只配一把私钥最省事，公钥可以从它导出。
    //    这不是安全降级（能验签的前提是拿到公钥；拿到私钥的人当然也能验）。
    const pub = crypto.createPublicKey(pem);
    if (pub.asymmetricKeyType !== 'ed25519') {
      throw new Error(`密钥类型是 ${pub.asymmetricKeyType}，本功能只支持 ed25519`);
    }
    publicKeyPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  } catch (err) {
    // 也可能给的是私钥 PEM
    try {
      const priv = crypto.createPrivateKey(pem);
      if (priv.asymmetricKeyType !== 'ed25519') {
        throw new Error(`密钥类型是 ${priv.asymmetricKeyType}，本功能只支持 ed25519`);
      }
      publicKeyPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString();
    } catch (err2) {
      throw new BadRequestException(
        `验签公钥不可用：${(err as Error)?.message || err}（当作私钥解析也失败：${
          (err2 as Error)?.message || err2
        }）。需要一把 ed25519 公钥（PEM，SPKI）。`,
      );
    }
  }
  return { publicKeyPem, fingerprint: keyFingerprint(publicKeyPem), source };
}

function generatedKeyPaths(backupDir: string) {
  const dir = path.join(backupDir, SIGNING_KEY_DIRNAME);
  return {
    dir,
    privatePath: path.join(dir, SIGNING_PRIVATE_KEY_FILENAME),
    publicPath: path.join(dir, SIGNING_PUBLIC_KEY_FILENAME),
  };
}

/**
 * 解析**签名**密钥（备份时用）。优先级：
 *  1. `VANBLOG_BACKUP_SIGNING_KEY_FILE`（Docker secret 用；读不到就**失败关闭**）
 *  2. `VANBLOG_BACKUP_SIGNING_KEY`（内联 PEM）
 *  3. 备份目录下 `signing/backup-signing-key.pem`（由 `POST …/signing/key` 生成）
 *  4. 都没有 ⇒ `null` = **不签名**（默认；行为与加这个功能之前逐字节一致）
 */
export function resolveSigningKey(
  backupDir?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): SigningKeyMaterial | null {
  const filePath = String(env[SIGNING_KEY_FILE_ENV] ?? '').trim();
  if (filePath) {
    return toSigningMaterial(readKeyFile(SIGNING_KEY_FILE_ENV, filePath), 'env-file');
  }
  const inline = env[SIGNING_KEY_ENV];
  if (typeof inline === 'string' && inline.trim().length > 0) {
    return toSigningMaterial(inline, 'env');
  }
  const dir = String(backupDir ?? '').trim();
  if (dir) {
    const { privatePath } = generatedKeyPaths(dir);
    if (fs.existsSync(privatePath)) {
      return toSigningMaterial(readKeyFile('生成的签名密钥文件', privatePath), 'generated');
    }
  }
  return null;
}

/**
 * 解析**验签**密钥（校验与恢复时用）。优先级：
 *  1. `VANBLOG_BACKUP_VERIFY_KEY_FILE`
 *  2. `VANBLOG_BACKUP_VERIFY_KEY`
 *  3. 备份目录下 `signing/backup-signing-key.pub.pem`
 *  4. **回落到签名密钥**（一体式部署只配一把私钥时，验签用它导出的公钥）
 *  5. 都没有 ⇒ `null` = 不验签（但会**大声降级**，绝不静默当成"通过"）
 */
export function resolveVerifyKey(
  backupDir?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): VerifyKeyMaterial | null {
  const filePath = String(env[VERIFY_KEY_FILE_ENV] ?? '').trim();
  if (filePath) {
    return toVerifyMaterial(readKeyFile(VERIFY_KEY_FILE_ENV, filePath), 'env-file');
  }
  const inline = env[VERIFY_KEY_ENV];
  if (typeof inline === 'string' && inline.trim().length > 0) {
    return toVerifyMaterial(inline, 'env');
  }
  const dir = String(backupDir ?? '').trim();
  if (dir) {
    const { publicPath, privatePath } = generatedKeyPaths(dir);
    if (fs.existsSync(publicPath)) {
      return toVerifyMaterial(readKeyFile('生成的验签公钥文件', publicPath), 'generated');
    }
    if (fs.existsSync(privatePath)) {
      const signing = toSigningMaterial(readKeyFile('生成的签名密钥文件', privatePath), 'generated');
      return { publicKeyPem: signing.publicKeyPem, fingerprint: signing.fingerprint, source: 'generated' };
    }
  }
  const signing = resolveSigningKey(backupDir, env);
  if (signing) {
    return { publicKeyPem: signing.publicKeyPem, fingerprint: signing.fingerprint, source: signing.source };
  }
  return null;
}

/**
 * 生成一对新的 ed25519 密钥并**落盘**（0700 目录 / 0600 文件）。
 *
 * ⚠️ 私钥**只落盘、不返回**：调用方（controller）拿到返回值后只能把公钥与指纹发出去。
 * 这条性质有守卫钉住（"接口响应里不出现私钥"），因为一旦私钥经 HTTP 走出去，
 * 它就会留在浏览器历史、反代日志与任何中间件里，而"备份签名"的全部价值就没了。
 *
 * @param overwrite 已存在时是否覆盖。默认 **false**：覆盖等于让所有旧归档的签名**永久无法验证**
 *                  （旧 `.sig` 是旧私钥签的，而旧私钥已经被覆盖掉了），必须由调用方显式确认。
 */
export function generateSigningKeyPair(
  backupDir: string,
  options: { overwrite?: boolean } = {},
): { publicKeyPem: string; fingerprint: string; privatePath: string; publicPath: string; replaced: boolean } {
  const { dir, privatePath, publicPath } = generatedKeyPaths(backupDir);
  const existed = fs.existsSync(privatePath) || fs.existsSync(publicPath);
  if (existed && !options.overwrite) {
    // 拒绝一次"会让所有旧 .sig 永久验不过"的破坏性操作，值得留一条痕迹（warn 级别：
    // 这是站长自己没带 confirm，不是攻击形状）。⚠️ 只记路径，绝不记密钥内容。
    recordRestoreRejection(
      'signing-overwrite-refused',
      `签名密钥已存在且请求没有带显式确认，已拒绝覆盖（私钥路径 ${privatePath}）`,
    );
    throw new BadRequestException(
      `签名密钥已经存在（${privatePath}）：拒绝覆盖。` +
        `覆盖会让**所有已签名归档的 .sig 永久无法验证**（旧签名是旧私钥签的，而旧私钥会被删掉）。` +
        `确实要换密钥：先确认所有还需要验证的归档都已经用旧公钥验过（或把旧公钥也离线留一份），` +
        `再带 confirm=true 重新调用一次。`,
    );
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  ensureSecretDir(dir, SECRET_DIR_MODE);
  // ⚠️ 先写私钥再写公钥：如果反过来，中途失败会留下"有公钥没私钥"的状态，
  //    于是验签能配、签名配不上，比"两个都没有"更难排障。
  // ⚠️ 权限不用传：`writeSecretFileSync` 内部固定 0600（写入时给 mode + 事后再 chmod 一次，
  //    覆盖"文件已存在"那条路），目录由上面的 ensureSecretDir 收紧到 0700。
  writeSecretFileSync(privatePath, privatePem);
  writeSecretFileSync(publicPath, publicPem);
  logger.warn(
    `已生成新的备份签名密钥（指纹 ${keyFingerprint(publicPem)}，私钥 ${privatePath} 0600）。` +
      `⚠️ 请把**公钥**离线保存一份（密码管理器/另一台机器/打印）：验签材料只存在本机时，` +
      `拿到主机 root 的人可以连公钥一起换掉，签名就失去意义。`,
  );
  return {
    publicKeyPem: publicPem,
    fingerprint: keyFingerprint(publicPem),
    privatePath,
    publicPath,
    replaced: existed,
  };
}

export interface SignatureSidecar {
  magic: string;
  v: number;
  alg: string;
  digest: string;
  /** 被签的内容：整份归档（加密归档=密文）的 sha256 十六进制 */
  archiveSha256: string;
  archiveBytes: number;
  /** 签名密钥的指纹（公钥 sha256 前 16 位）；用来区分"拿错钥匙"与"归档被改过" */
  keyFingerprint: string;
  signedAt: string;
  /** base64 的 ed25519 签名（64 字节） */
  signature: string;
  /**
   * 归档文件名。⚠️ **只是提示，不参与签名、不参与校验**：
   * 校验一律以内容 sha256 为准，所以归档改名之后签名仍然有效
   * （运维把归档重命名成带日期的名字是很常见的操作，不该因此验不了签）。
   */
  archiveName: string;
}

export function signatureSidecarPath(archivePath: string): string {
  return `${archivePath}${BACKUP_SIG_EXT}`;
}

/**
 * **被签名的字节**：一个字段的规范化拼接，而不是整个 JSON。
 *
 * ⚠️ 为什么不能直接签 JSON 文件内容：JSON 里含签名本身（自指，没法签），
 * 而且 `JSON.stringify` 的键顺序/空白一旦变化，同一份数据就会签出不同结果。
 * 所以这里固定一个"字段顺序 + 分隔符"的串，写与验两端共用同一个函数
 * （**共用**很关键：两端各写一遍必然在某个字段上漂，而漂了就是"永远验不过"或"永远验得过"）。
 * ⚠️ `archiveName` 故意**不在**载荷里（见 SignatureSidecar.archiveName 的说明）。
 */
export function signingPayload(fields: {
  archiveSha256: string;
  archiveBytes: number;
  keyFingerprint: string;
  signedAt: string;
}): Buffer {
  return Buffer.from(
    [
      BACKUP_SIG_MAGIC,
      String(BACKUP_SIG_VERSION),
      BACKUP_SIG_ALG,
      BACKUP_SIG_DIGEST,
      fields.archiveSha256,
      String(fields.archiveBytes),
      fields.keyFingerprint,
      fields.signedAt,
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * 给一份**已经算出 sha256** 的归档写 `.sig`。
 *
 * ⚠️ 不再读一遍归档：sha256 是打包时**边写边流式算**出来的（`fullBackup.ts` 的 `tarCompress`），
 * 而且已经做过"落盘后回读复核"，所以这里的输入就是磁盘上那份内容的哈希。
 * 为签名再读一遍几个 GB 的文件是纯粹的浪费。
 *
 * @returns 写出的 `.sig` 路径；未配签名密钥时返回 `null`（调用方据此决定要不要提示）。
 */
export function signArchiveDigest(input: {
  archivePath: string;
  archiveSha256: string;
  archiveBytes: number;
  signingKey?: SigningKeyMaterial | null;
  /** 便于测试注入；生产用当前时间 */
  now?: Date;
}): string | null {
  const key = input.signingKey === undefined ? null : input.signingKey;
  if (!key) {
    return null;
  }
  if (!/^[0-9a-f]{64}$/i.test(String(input.archiveSha256 ?? ''))) {
    // 走到这里说明调用方给的哈希不是 sha256 十六进制（编程错误）。
    // ⚠️ 宁可抛也不要签一个畸形值：签出来的 `.sig` 会**永远验不过**，
    //    而那看起来像"归档被篡改了"，会把排障带到完全错误的方向。
    throw new BadRequestException(
      `拒绝签名：archiveSha256 不是 64 位十六进制的 sha256（收到 ${String(input.archiveSha256).slice(0, 20)}…）`,
    );
  }
  const signedAt = (input.now ?? new Date()).toISOString();
  const payload = signingPayload({
    archiveSha256: String(input.archiveSha256).toLowerCase(),
    archiveBytes: Number(input.archiveBytes),
    keyFingerprint: key.fingerprint,
    signedAt,
  });
  const signature = crypto.sign(null, payload, crypto.createPrivateKey(key.privateKeyPem)).toString('base64');
  const sidecar: SignatureSidecar = {
    magic: BACKUP_SIG_MAGIC,
    v: BACKUP_SIG_VERSION,
    alg: BACKUP_SIG_ALG,
    digest: BACKUP_SIG_DIGEST,
    archiveSha256: String(input.archiveSha256).toLowerCase(),
    archiveBytes: Number(input.archiveBytes),
    keyFingerprint: key.fingerprint,
    signedAt,
    signature,
    archiveName: path.basename(input.archivePath),
  };
  const sigPath = signatureSidecarPath(input.archivePath);
  // 原子写（tmp + rename）：半截 `.sig` 比没有 `.sig` 更糟 —— 没有是"这份没签过"（可诊断），
  // 半截是"签过但读不出来"（会被当成篡改）。0600：与 `.sha256`/`.manifest.json` 一致。
  const tmp = `${sigPath}.tmp-${process.pid}`;
  writeSecretFileSync(tmp, JSON.stringify(sidecar, null, 2));
  fs.renameSync(tmp, sigPath);
  return sigPath;
}

/** 验签的结论。⚠️ 五种状态**必须**能区分，因为处置完全不同（见各分支注释）。 */
export type SignatureVerifyState =
  /** 验签通过 */
  | 'ok'
  /** 签名不匹配：归档或 `.sig` 被改过 ⇒ 这份归档不可信 */
  | 'mismatch'
  /** 公钥不匹配：`.sig` 是别的密钥签的 ⇒ 拿错钥匙，去找回正确的公钥 */
  | 'key-mismatch'
  /** `.sig` 不存在：这份归档从没被签过 ⇒ 无法证明真实性（不是"被改过"） */
  | 'missing-sig'
  /** `.sig` 读不出来/形状不对 ⇒ 既不能当通过，也不该断言"被篡改" */
  | 'malformed-sig'
  /** 没配验签公钥 ⇒ 压根没验（⚠️ 绝不能当成通过） */
  | 'no-key';

export interface SignatureVerifyResult {
  state: SignatureVerifyState;
  /** 验签通过与否；`null` = 没验（no-key / missing-sig / malformed-sig） */
  ok: boolean | null;
  /** `.sig` 里记的指纹（没有则 null） */
  sigFingerprint: string | null;
  /** 本机配置的验签公钥指纹（没配则 null） */
  expectedFingerprint: string | null;
  /** `.sig` 里记的被签 sha256（没有则 null） */
  sigSha256: string | null;
  /** 实测的归档 sha256（做了实测才有） */
  actualSha256: string | null;
  /** 给人看的结论（每种 state 一套文案，见 signatureVerifyMessage） */
  message: string;
  /** 解析出来的 sidecar（malformed 时为 null） */
  sidecar: SignatureSidecar | null;
}

/** 读并校验 `.sig` 的形状。⚠️ 任何畸形都返回 null 而**不抛**：验签是"加一层判断"，不该把恢复流程炸掉。 */
export function readSignatureSidecar(sigPath: string): SignatureSidecar | null {
  try {
    const stat = fs.statSync(sigPath);
    if (stat.size > MAX_SIG_FILE_BYTES) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (parsed.magic !== BACKUP_SIG_MAGIC || parsed.v !== BACKUP_SIG_VERSION) {
      return null;
    }
    if (parsed.alg !== BACKUP_SIG_ALG || parsed.digest !== BACKUP_SIG_DIGEST) {
      // 将来支持别的算法时，这里要改成"认识就继续、不认识就明确报'算法不支持'"，
      // 而不是让 ed25519 的验签函数去吃一个 RSA 签名（那只会得到一句看不懂的报错）。
      return null;
    }
    if (typeof parsed.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(parsed.archiveSha256)) {
      return null;
    }
    if (typeof parsed.signature !== 'string' || parsed.signature.length === 0) {
      return null;
    }
    if (typeof parsed.keyFingerprint !== 'string' || parsed.keyFingerprint.length === 0) {
      return null;
    }
    if (typeof parsed.signedAt !== 'string' || parsed.signedAt.length === 0) {
      return null;
    }
    if (typeof parsed.archiveBytes !== 'number' || !Number.isFinite(parsed.archiveBytes)) {
      return null;
    }
    return parsed as SignatureSidecar;
  } catch {
    return null;
  }
}

/**
 * 每种状态的**可照做**文案。
 *
 * ⚠️ 为什么不合成一句"签名校验失败"：这三种情况在灾难现场的处置**完全相反** ——
 *  - `mismatch`：这份归档不可信，**不要**用它恢复，去找另一份；
 *  - `key-mismatch`：归档可能是好的，是**你手上的公钥不对**，去离线副本里找对的那把；
 *  - `missing-sig`：这份归档从没签过（早于本功能，或签名没配），谈不上真假 —— 按"未验证"处理。
 * 混成一句会让站长在"要不要用这份归档覆盖现有数据"这个决定上猜。
 */
export function signatureVerifyMessage(r: {
  state: SignatureVerifyState;
  sigFingerprint: string | null;
  expectedFingerprint: string | null;
  archiveName?: string;
  sigPath?: string;
}): string {
  const name = r.archiveName ? `${r.archiveName} ` : '';
  switch (r.state) {
    case 'ok':
      return `${name}签名校验通过（ed25519，密钥指纹 ${r.sigFingerprint}）：这份归档与签名时逐字节一致。`;
    case 'mismatch':
      return (
        `🔴 ${name}签名**不匹配**（密钥指纹对得上：${r.sigFingerprint}，但签名验不过）。` +
        `这说明归档或 ${BACKUP_SIG_EXT} 文件在签名之后**被改动过**（篡改、截断、或拷坏）。` +
        `⚠️ 不要用这份归档恢复：先换一份，或用 ./vanblog.sh backup-verify --all 找出最近一份校验通过的。`
      );
    case 'key-mismatch':
      return (
        `🔴 ${name}的签名是**另一把密钥**签的（.sig 里的指纹 ${r.sigFingerprint}，本机配置的验签公钥指纹 ` +
        `${r.expectedFingerprint}）。归档本身**不一定有问题** —— 更可能是你手上这把公钥不对。` +
        `请找回签名时那把密钥对应的公钥（离线副本/密码管理器），配到 ${VERIFY_KEY_ENV} 或 ` +
        `${VERIFY_KEY_FILE_ENV} 后重试；确认过公钥确实换了、且你接受风险，才考虑跳过验签。`
      );
    case 'missing-sig':
      return (
        `⚠️ ${name}没有 ${BACKUP_SIG_EXT} 签名文件：这份归档**从没被签过**（早于本功能，或备份时没有配签名密钥）。` +
        `谈不上真假 —— 只能靠 .sha256 / integrity 块证明它**自洽**，证明不了它**没被换过**。` +
        `要让以后的备份可证明：配 ${SIGNING_KEY_ENV}（或用 POST /api/admin/backup/signing/key 生成一对）。`
      );
    case 'malformed-sig':
      return (
        `🔴 ${name}的 ${BACKUP_SIG_EXT} 读不出来或形状不对（${r.sigPath || '路径未知'}）：` +
        `既不能当成"验过了"，也不该断言"被篡改"。请检查这个文件是否被截断/改格式，` +
        `或从另一份副本重新拷一个 ${BACKUP_SIG_EXT} 过来。`
      );
    case 'no-key':
    default:
      return (
        `⚠️ 没有配置验签公钥（${VERIFY_KEY_ENV} / ${VERIFY_KEY_FILE_ENV} 都为空，本机也没有生成的密钥），` +
        `所以**没有做签名校验**。⚠️ 这不等于"校验通过"：这份归档的真实性未被证明。`
      );
  }
}

/**
 * 验签。⚠️ 需要传入**实测的归档 sha256**（调用方流式算，或从 `hashFile` 拿），
 * 本函数不自己读归档 —— 因为调用方（`verifyFullBackup` / 恢复预检）本来就要读一遍。
 */
export function verifySignatureAgainstDigest(input: {
  archivePath: string;
  actualSha256: string;
  verifyKey: VerifyKeyMaterial | null;
}): SignatureVerifyResult {
  const base = {
    sigFingerprint: null as string | null,
    expectedFingerprint: input.verifyKey?.fingerprint ?? null,
    sigSha256: null as string | null,
    actualSha256: String(input.actualSha256 || '').toLowerCase() || null,
    sidecar: null as SignatureSidecar | null,
  };
  const sigPath = signatureSidecarPath(input.archivePath);
  const finish = (state: SignatureVerifyState, ok: boolean | null, extra: Partial<typeof base> = {}) => ({
    ...base,
    ...extra,
    state,
    ok,
    message: signatureVerifyMessage({
      state,
      sigFingerprint: extra.sigFingerprint ?? base.sigFingerprint,
      expectedFingerprint: base.expectedFingerprint,
      archiveName: path.basename(input.archivePath),
      sigPath,
    }),
  });

  if (!fs.existsSync(sigPath)) {
    return finish('missing-sig', null);
  }
  const sidecar = readSignatureSidecar(sigPath);
  if (!sidecar) {
    return finish('malformed-sig', null);
  }
  const withSidecar = {
    sigFingerprint: sidecar.keyFingerprint,
    sigSha256: sidecar.archiveSha256.toLowerCase(),
    sidecar,
  };
  if (!input.verifyKey) {
    // 有 .sig 但没有公钥：知道"签过"，但验不了。⚠️ 与"没有 .sig"是不同的信息，要分开报。
    return finish('no-key', null, withSidecar);
  }
  if (sidecar.keyFingerprint !== input.verifyKey.fingerprint) {
    return finish('key-mismatch', false, withSidecar);
  }
  // 先比 sha256 再做密码学验签：两者都要过。
  // ⚠️ 顺序上先比 sha256 是为了给出**更准**的结论 —— 但结论仍然报 `mismatch`（不细分），
  //    因为对站长来说"内容对不上"与"签名对不上"的处置是一样的：这份归档不可信。
  const actual = String(input.actualSha256 || '').toLowerCase();
  if (sidecar.archiveSha256.toLowerCase() !== actual) {
    return finish('mismatch', false, withSidecar);
  }
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      signingPayload({
        archiveSha256: sidecar.archiveSha256.toLowerCase(),
        archiveBytes: sidecar.archiveBytes,
        keyFingerprint: sidecar.keyFingerprint,
        signedAt: sidecar.signedAt,
      }),
      crypto.createPublicKey(input.verifyKey.publicKeyPem),
      Buffer.from(sidecar.signature, 'base64'),
    );
  } catch {
    verified = false;
  }
  return verified ? finish('ok', true, withSidecar) : finish('mismatch', false, withSidecar);
}

/**
 * 恢复前的验签闸门。
 *
 * 语义（**默认不能把既有部署弄坏**，这是硬要求）：
 *  - **配了验签公钥 且 归档有 `.sig`** ⇒ 必须验签通过，否则拒绝恢复；
 *  - **没配公钥**（绝大多数既有部署）⇒ **放行**，但返回一条 WARN 让调用方大声说出来。
 *    ⚠️ 绝不能变成"没配公钥就拒绝恢复"：那会让所有升级上来的站点在灾难现场发现恢复不了。
 *  - **配了公钥但归档没有 `.sig`** ⇒ 也**放行** + WARN（这份归档早于签名功能；
 *    拒绝的话，站长配了公钥之后就无法恢复任何**历史**归档，那是把新功能变成新的锁死来源）。
 *
 * @param skip 显式跳过验签。⚠️ 调用方必须像"破坏性恢复确认闸门"一样**只认字面 true**
 *             （见 `utils/isTrue.ts`），并且跳过时要打 WARN 说清跳过了什么。
 */
export function assertArchiveSignatureForRestore(input: {
  archivePath: string;
  actualSha256: string;
  verifyKey: VerifyKeyMaterial | null;
  skip?: boolean;
}): { checked: boolean; result: SignatureVerifyResult | null; warning: string | null } {
  const sigPath = signatureSidecarPath(input.archivePath);
  const hasSig = fs.existsSync(sigPath);
  if (input.skip === true) {
    const warn =
      `⚠️ 已按显式要求**跳过签名校验**（${path.basename(input.archivePath)}）。` +
      `这份归档的真实性未被证明：如果它是从主机之外的地方拷来的，无法排除被篡改。`;
    logger.warn(warn);
    return { checked: false, result: null, warning: warn };
  }
  if (!input.verifyKey) {
    const warn = hasSig
      ? `⚠️ 这份归档有 ${BACKUP_SIG_EXT} 签名，但本机**没有配验签公钥**（${VERIFY_KEY_ENV} / ` +
        `${VERIFY_KEY_FILE_ENV}），所以没有验签就恢复了。要让恢复前自动验真：把签名时的公钥配进来。`
      : `⚠️ 这份归档没有 ${BACKUP_SIG_EXT} 签名、本机也没配验签公钥：真实性未被证明（只校验了自洽性）。`;
    logger.warn(warn);
    return { checked: false, result: null, warning: warn };
  }
  const result = verifySignatureAgainstDigest({
    archivePath: input.archivePath,
    actualSha256: input.actualSha256,
    verifyKey: input.verifyKey,
  });
  if (!hasSig) {
    // 配了公钥、但这份归档没签过：放行 + WARN（理由见函数注释）
    const warn = `⚠️ 已配验签公钥（指纹 ${input.verifyKey.fingerprint}），但这份归档没有 ${BACKUP_SIG_EXT}：` +
      `它是签名功能启用之前做的，真实性无法证明。本次仍然放行。`;
    logger.warn(warn);
    return { checked: false, result, warning: warn };
  }
  if (result.ok !== true) {
    // 🔴 抛之前**必须先记一条日志**：这个分支以前只 throw，于是"验签不通过"这件事
    //    只存在于 HTTP 响应体里、应用日志一条都没有（实测：`不匹配`/`另一把密钥` 关键词
    //    在 298 行日志里命中 0，而**成功**路径的 `签名校验通过` 有 2 命中 ⇒ 成功/失败不对称）。
    //    后果是有人拿被换过的归档反复试探时，事后在应用日志里查不到任何痕迹，
    //    `./vanblog.sh doctor` 的近 24h ERROR 计数也看不见。见 `utils/restoreSecurityLog.ts`。
    //    ⚠️ 级别按状态分：`mismatch`/`malformed-sig` 是 error（诚实站长不会自己撞上），
    //       `key-mismatch` 是 warn（**多半是站长自己配错了公钥**，报 error 会给体检制造常态噪音）。
    recordRestoreRejection(
      result.state === 'key-mismatch'
        ? 'signature-key-mismatch'
        : result.state === 'malformed-sig'
          ? 'signature-malformed'
          : 'signature-mismatch',
      `${result.message}` +
        `（归档 ${path.basename(input.archivePath)}；本机验签公钥指纹 ${input.verifyKey.fingerprint}）`,
    );
    // 🔴 2026-09-21 修：这段"逃生口"提示以前是**无条件**追加的，而这个函数被**两条路由共用**
    //    （匿名 `POST /api/admin/init/restore` 与管理员 `POST /api/admin/backup/full/restore`），
    //    而**匿名那条刻意没有跳过验签的开关**（有守卫钉住：`initRestoreSignature.spec.ts`）。
    //    活体实测到的后果：站长在**初始化页做灾难恢复**时被文案指向一个这条路上不存在的开关，
    //    于是白试一轮 —— 在灾难现场这是最贵的误导。⚠️ 安全方向本来就是对的（匿名路没有逃生口），
    //    坏的只是**指路**。所以修法是把话说准：逃生口在哪条路上、匿名路为什么没有、以及在那里
    //    重试多少次都会得到同样的拒绝。⚠️ 不要改成"按路由传布尔进来再决定说不说"——
    //    那会把"哪条路有逃生口"这个事实分散到调用方，将来加第三条路由时又会漏。
    throw new BadRequestException(
      `拒绝恢复：${result.message}` +
        `（如果你确认公钥就是不对、且你接受风险：**登录后台**走「备份与恢复 → 整站恢复」时，` +
        `可以在请求 body 里带 skipSignatureCheck=true 显式跳过 —— 它只认字面量 true（1/yes/TRUE 都不算），` +
        `且会打一条 WARN 记录跳过了什么。` +
        `⚠️ 初始化页那个**匿名**恢复入口没有这个开关（那条路径刻意不提供跳过验签的能力），` +
        `所以在那里重试多少次都会得到同样的拒绝：要么把正确的验签公钥配上，要么改用后台的恢复入口。）`,
    );
  }
  logger.log(result.message);
  return { checked: true, result, warning: null };
}
