import { BadRequestException } from '@nestjs/common';
import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Transform } from 'stream';
import type { Db, MongoClient } from 'mongodb';
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  BackupIntegrity,
  BackupSourceInfo,
  CollectionSummary,
  FullBackupManifest,
  backupFileName,
  encodeDoc,
  decodeDoc,
  formatBytes,
  isFullBackupManifest,
} from './backupCodec';
import {
  MANIFEST_COPY_FILENAME,
  TarEntryInfo,
  TarHashResult,
  hashFile,
  hashTarStream,
} from './backupTarStream';
import { buildIntegrity, probeCompressorChecksum, writeSha256Sidecar } from './backupIntegrity';
import { RestoreJournalWriter } from './restoreJournal';
import { StaticPruneReport, formatPruneReport, pruneFolderToMatch } from './staticPrune';
import { envBool } from './envBool';
import {
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
  chmodBestEffort,
  ensureSecretDir,
  writeSecretFileSync,
} from './secretFileMode';
import {
  SignatureVerifyResult,
  assertArchiveSignatureForRestore,
  resolveSigningKey,
  resolveVerifyKey,
  signArchiveDigest,
  signatureSidecarPath,
} from './backupSigning';
import {
  BACKUP_ENC_EXT,
  BackupEncryptionHeader,
  createEncryptor,
  describePassphrase,
  encryptionSummary,
  openDecryptedSource,
  plaintextArchiveWarning,
  readEncryptionHeader,
  resolveBackupPassphrase,
} from './backupCrypto';

/**
 * 整站备份 / 恢复：把 **数据库（含 waline 评论库）+ 本地静态文件（图床 / 附件 / 自定义页面）**
 * 打成一个高压缩归档，并能从该归档把博客整体恢复出来。
 *
 * 设计要点：
 * - 不依赖 `mongodump` / `mongorestore`（官方 server tarball 与 Alpine 镜像里都没有），
 *   改用 mongodb driver 逐集合导出成 NDJSON（BSON 类型按 canonical EJSON 编码，见 `backupCodec.ts`）。
 * - 压缩优先 `zstd -19 --long`（体积/速度综合最好），其次 `xz -9e`，最后 `gzip -9`；
 *   运行时探测，产物后缀跟着变（`.tar.zst` / `.tar.xz` / `.tar.gz`）。
 * - 静态文件用 **硬链接** 进暂存目录（`cp -al`，同一文件系统上零额外空间、几乎瞬时），
 *   跨设备时自动回退成真实拷贝。
 * - 恢复时先导进 `<coll>__vanblog_restore` 临时集合，再 `rename(dropTarget:true)` 原子替换，
 *   最后按备份里的索引定义重建索引；中途失败不会留下"半张表"。
 * - 归档里含数据库（密码哈希、jwt 密钥），所以**默认放在 `config.backupPath`（`<log>/vanblog-backups`）**
 *   而不是静态目录下；下载一律走鉴权接口 `GET /api/admin/backup/full/download`。
 *   万一有人把 backupPath 配到了 staticPath 里面，`main.ts` 还有一道匿名访问拦截兜底。
 */

/** 归档目录名（实际位置由 `config.backupPath` 决定，默认 `<log>/vanblog-backups`）。 */
export const BACKUP_DIRNAME = 'vanblog-backups';
/**
 * 只备份这些静态子目录 —— 判据是「**用户数据**，删了就没了」：
 *  - `img`        图床图片与缩略图（上传的原图无法再生）
 *  - `file`       附件管理里的任意文件
 *  - `customPage` 自定义页面的 HTML/资源
 *  - `themes`     **后台上传的主题 CSS**（`provider/theme/theme.provider.ts` 的
 *                 `THEME_SUBDIR`，文件名 `<id>-<hash8>.css`）。⚠️ 这一条是补上的：
 *                 以前只有前三个，于是主题 CSS 从来不进归档，而主题的**元数据**
 *                 （settings 里的 `{type:'theme'}` 列表）与启用状态（`metas.siteInfo.uiStyle`）
 *                 都在数据库里 ⇒ 换新机器恢复之后，后台显示主题存在且已启用、
 *                 `/api/public/theme` 也照常列出它，但 `/static/themes/<id>-<hash>.css`
 *                 已经没了，`/api/public/theme.css` 404，前台**静默地**退回默认皮肤。
 *                 这是一次"看起来成功的恢复"，属于最难发现的那类数据丢失。
 *
 * 故意**不**备份的目录（都是可再生 / 临时 / 不该带走的）：
 *  - `rss`、`sitemap`：server 启动与每次改动后都会重新生成（rss.provider / sitemap.provider）
 *  - `tmp`、`upload-tmp`：上传与整站备份/恢复的暂存目录（里面可能正躺着另一个整站归档）
 *  - `export`：旧的导出归档目录，`main.ts` 现在对匿名请求直接 403，内容按需重新导出
 *
 * ⚠️ 新增静态子目录时必须同步更新这里的分类，
 * `src/audit-hardening-round3-backup.spec.ts` 会把"两边都没列到的目录"判成失败。
 */
export const BACKUP_STATIC_FOLDERS = ['img', 'file', 'customPage', 'themes'];
const RESTORE_SUFFIX = '__vanblog_restore';
const INSERT_BATCH = 500;

export type BackupFormat = 'zstd' | 'xz' | 'gzip';

export interface CompressorSpec {
  format: BackupFormat;
  ext: string;
  compress: string[];
  decompress: string[];
  label: string;
}

function zstdLevel(): string {
  const raw = Number(process.env.VANBLOG_BACKUP_ZSTD_LEVEL);
  const level = Number.isFinite(raw) && raw > 0 ? Math.min(22, Math.round(raw)) : 19;
  return `-${level}`;
}

function compressorSpecs(): CompressorSpec[] {
  return [
    {
      format: 'zstd',
      ext: '.tar.zst',
      // ⚠️ `--check` 是**显式**写的，虽然 zstd CLI 本来就默认开内容校验和。
      // 实测（本次审计）：归档帧头描述符字节是 `0x04`，bit2(Content_Checksum_flag)=1，
      // 但那是 CLI 默认值给的，不是我们要求的 —— 换个实现、或者哪天有人加了 `--no-check`，
      // 归档就静默失去唯一的自校验能力。显式写死 + `integrity.zstdFrameChecksum` 记录实测值
      // + `backupVerify` 每次都重新读帧头比对（`probeCompressorChecksum`），三处一起钉住。
      compress: ['zstd', zstdLevel(), '--long=27', '-T0', '--check', '-q', '-c'],
      decompress: ['zstd', '-dc', '--long=27', '-q'],
      label: `zstd ${zstdLevel()} --long=27 -T0 --check`,
    },
    {
      format: 'xz',
      ext: '.tar.xz',
      compress: ['xz', '-9e', '-T0', '-c'],
      decompress: ['xz', '-dc'],
      label: 'xz -9e -T0',
    },
    {
      format: 'gzip',
      ext: '.tar.gz',
      compress: ['gzip', '-9', '-c'],
      decompress: ['gzip', '-dc'],
      label: 'gzip -9',
    },
  ];
}

let cachedAvailable: BackupFormat[] | null = null;

function hasBinary(cmd: string): boolean {
  const res = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return res.status === 0 || res.status === null ? res.error === undefined : false;
}

/** 本机可用的压缩器（按压缩率/速度综合排序）。 */
export function availableFormats(force = false): BackupFormat[] {
  if (cachedAvailable && !force) {
    return cachedAvailable;
  }
  const out: BackupFormat[] = [];
  for (const spec of compressorSpecs()) {
    if (hasBinary(spec.compress[0])) {
      out.push(spec.format);
    }
  }
  cachedAvailable = out;
  return out;
}

export function specFor(format: BackupFormat): CompressorSpec | null {
  return compressorSpecs().find((spec) => spec.format === format) || null;
}

/** 'auto' 时挑本机最强的那个；指定格式但机器上没有就返回 null（调用方给出明确报错）。 */
export function pickSpec(preferred?: string): CompressorSpec | null {
  const available = availableFormats();
  if (preferred && preferred !== 'auto') {
    if (!available.includes(preferred as BackupFormat)) {
      return null;
    }
    return specFor(preferred as BackupFormat);
  }
  for (const format of available) {
    const spec = specFor(format);
    if (spec) {
      return spec;
    }
  }
  return null;
}

/**
 * 从文件名/魔数猜格式（恢复时用）。
 *
 * ⚠️ 加密归档要**看穿容器**：文件以 `VANBLOGENC1` 开头，压缩格式的魔数在密文里根本看不见，
 * 所以内层格式取自加密头部（`header.inner.format`，而头部本身被每一块的 GCM AAD 认证，
 * 改不了）。这一步**不需要口令**。
 */
export function detectFormat(file: string): BackupFormat | null {
  const encHeader = readEncryptionHeader(file);
  if (encHeader) {
    const inner = encHeader.inner?.format;
    if (inner === 'zstd' || inner === 'xz' || inner === 'gzip') {
      return inner;
    }
    return null;
  }
  // `.enc` 后缀对判定没有影响（一律以魔数为准），但为了让下面的名字判断仍然有效，
  // 先把它去掉：`x.tar.zst.enc` 的内层就是 zstd。
  const name = path.basename(file).toLowerCase().replace(/\.enc$/, '');
  if (name.endsWith('.tar.zst') || name.endsWith('.zst')) {
    return 'zstd';
  }
  if (name.endsWith('.tar.xz') || name.endsWith('.xz')) {
    return 'xz';
  }
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz') || name.endsWith('.gz')) {
    return 'gzip';
  }
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) {
      return 'zstd';
    }
    if (head[0] === 0xfd && head.slice(1, 4).toString('ascii') === '7zX') {
      return 'xz';
    }
    if (head[0] === 0x1f && head[1] === 0x8b) {
      return 'gzip';
    }
  } catch {
    // 读不了就交给调用方报错
  }
  return null;
}

export interface BackupLogger {
  log(message: string): void;
  warn(message: string): void;
}

const silentLogger: BackupLogger = { log: () => undefined, warn: () => undefined };

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(target: string) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // 清理失败不影响主流程
  }
}

/** 目标目录的剩余空间（人话）；读不到就返回 '?'，绝不让它把主流程带崩。 */
export function freeSpaceText(dir: string): string {
  try {
    // Node 18.15+ 的 statfsSync；容器与本机都是 Node 24
    const stats = (fs as any).statfsSync?.(dir);
    if (!stats || typeof stats.bavail !== 'number' || typeof stats.bsize !== 'number') {
      return '?';
    }
    return formatBytes(stats.bavail * stats.bsize);
  } catch {
    return '?';
  }
}

/**
 * tar | 压缩器 > 输出文件（全异步，不阻塞事件循环）。
 *
 * 顺带**边写边算整份归档的 sha256**（一个 `data` 监听器挂在压缩器 stdout 上，
 * 与 `pipe()` 并存，不额外缓冲、不改变数据流），所以 `.sha256` sidecar 与
 * `backup-status.json` 里那个整归档哈希是**零额外读盘**得到的。
 */
/**
 * @param encrypt 可选的加密 Transform（见 utils/backupCrypto.ts）。传入时管道变成
 *   `tar → 压缩器 → 加密 → 落盘`，即**先压缩再加密**（加密后的数据不可压缩，顺序反了
 *   归档会大好几倍）。返回的 bytes/sha256 是**最终落盘字节**的（加密后的），
 *   所以调用方的"回读复核"与 `.sha256` sidecar 都仍然对得上。
 */
function tarCompress(
  stagingDir: string,
  outFile: string,
  spec: CompressorSpec,
  signal?: AbortSignal,
  abortMessage = '备份被中止（超过整轮超时）',
  encrypt?: Transform | null,
): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-cf', '-', '-C', stagingDir, '.']);
    const compressor = spawn(spec.compress[0], spec.compress.slice(1));
    // ⚠️ mode 0600：归档落在 `<日志目录>/vanblog-backups/`，而 `<日志目录>` 是 bind mount
    // 到宿主机的 ⇒ 默认的 0644 等于宿主机上任何本地用户都能读走整库（scrypt 口令哈希、
    // `settings{type:'jwt'}` 的签名密钥、全部正文）。拿到 jwt 密钥就能伪造管理员 token，
    // 不需要破解任何口令。理由与两个 POSIX 细节见 utils/secretFileMode.ts。
    const out = fs.createWriteStream(outFile, { mode: SECRET_FILE_MODE });
    // 文件已存在时 createWriteStream 的 mode **不生效**（open 不改已有文件的权限），
    // 所以补一发 chmod；改不动（某些挂载不支持）也不该让备份失败。
    chmodBestEffort(outFile, SECRET_FILE_MODE);
    const digest = crypto.createHash('sha256');
    let streamed = 0;
    let tarErr = '';
    let compErr = '';
    let settled = false;
    const fail = (message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        out.destroy();
      } catch {
        // ignore
      }
      // 半成品归档必须删掉：否则「备份列表」里会多出一个损坏的归档，
      // 用户以为能恢复，恢复时才报错
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        // ignore
      }
      for (const child of [tar, compressor]) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      if (encrypt) {
        try {
          encrypt.destroy();
        } catch {
          // ignore
        }
      }
      // 用户可见的错误一律 BadRequestException：普通 Error 会被 Nest 变成
      // 500 + "Internal server error"，前端看不到原因
      reject(new BadRequestException(message));
    };
    // 压缩器被 OOM kill 时，往它 stdin 写会 EPIPE；没有 error 监听就是
    // unhandledRejection → Node 20 直接退出进程（整个 server 挂掉）
    compressor.stdin.on('error', (err: Error) => fail(`写入压缩器失败：${err.message}`));
    tar.stderr.on('data', (chunk) => {
      tarErr += chunk.toString();
    });
    compressor.stderr.on('data', (chunk) => {
      compErr += chunk.toString();
    });
    tar.on('error', (err) => fail(`tar 启动失败：${err.message}`));
    compressor.on('error', (err) => fail(`${spec.format} 压缩器启动失败：${err.message}`));
    out.on('error', (err: Error) => {
      // 写不下去最常见的原因就是磁盘满：把剩余空间一起说出来，
      // 否则只有一句 ENOSPC，运维得自己上机器 df
      const code = (err as NodeJS.ErrnoException)?.code;
      const free = freeSpaceText(path.dirname(outFile));
      fail(
        `写入备份文件失败：${err.message}（${outFile}；剩余空间 ${free}` +
          (code ? `；errno=${code}` : '') +
          (code === 'ENOSPC' ? ' —— 磁盘已满，归档不会留下半成品' : '') +
          '）',
      );
    });
    tar.on('exit', (code) => {
      // exit 1 = "file changed as we read it"：备份期间正好有图片被原地替换时会发生，
      // 归档本身仍可用，不该当成致命错误（cp -al 硬链接窗口里尤其容易碰到）
      if (code !== 0 && code !== null && code !== 1) {
        fail(`tar 退出码 ${code}：${tarErr.slice(0, 500)}`);
      }
    });
    // ⚠️ 这个 'data' 监听器与下面的 pipe 并存（同一个 flowing 流可以多个消费者），
    // 只为算哈希；不引入 Transform 是为了避免"多一层缓冲 → compressor 的 close
    // 比 flush 先到 → out.end() 把在途数据截断"这个隐患
    // ⚠️⚠️ 收尾逻辑在"加密"与"不加密"两条路上**必须不同**，原因写在这里，
    // 因为上面那条注释（"不引入 Transform 是为了避免 close 比 flush 先到"）正是这个坑：
    //  - 不加密：`compressor.on('close')` 时，压缩器的输出已经全部流出去了，
    //    所以手动 `out.end()` 是安全的（既有行为，一个字节都不改）。
    //  - 加密：中间多了一层 Transform，它可能还缓存着未满一块的明文。
    //    此时若在 compressor 的 close 里 `out.end()`，**在途数据会被截断** ⇒
    //    写出一份"看起来正常、末尾少一块"的归档。所以加密路走 `encrypt.pipe(out)`：
    //    pipe 会在上游 'end'（= flush 完成）之后才 end 下游，这是标准且正确的收尾。
    const countChunk = (chunk: Buffer) => {
      streamed += chunk.length;
      digest.update(chunk);
    };
    tar.stdout.pipe(compressor.stdin);
    if (encrypt) {
      compressor.stdout.pipe(encrypt);
      encrypt.on('data', countChunk);
      encrypt.pipe(out);
      encrypt.on('error', (err: Error) => fail(`加密备份流失败：${err.message}`));
      compressor.on('close', (code) => {
        if (code !== 0) {
          const free = freeSpaceText(path.dirname(outFile));
          fail(
            `${spec.format} 压缩失败（退出码 ${code}）：${compErr.slice(0, 500)}` +
              `（剩余空间 ${free}）`,
          );
        }
        // ⚠️ 这里**故意不**调 out.end()：交给 encrypt.pipe(out) 在 flush 后收尾。
      });
    } else {
      compressor.stdout.on('data', countChunk);
      compressor.stdout.pipe(out);
      compressor.on('close', (code) => {
        if (code !== 0) {
          const free = freeSpaceText(path.dirname(outFile));
          fail(
            `${spec.format} 压缩失败（退出码 ${code}）：${compErr.slice(0, 500)}` +
              `（剩余空间 ${free}）`,
          );
          return;
        }
        out.end();
      });
    }
    out.on('close', () => {
      if (!settled) {
        settled = true;
        // 再收紧一次：上面那发 chmod 可能跑在文件被创建之前（createWriteStream 的 open 是异步的），
        // 而"归档已经写完"这一刻是唯一能确定文件存在的时机。幂等，成本一次 syscall。
        chmodBestEffort(outFile, SECRET_FILE_MODE);
        resolve({ bytes: streamed, sha256: digest.digest('hex') });
      }
    });
    // 超时/取消：整轮备份有可配超时（见 provider 的 doExport），到点了必须能**真的停下来**，
    // 否则调用方 settle 了、这里还在往盘上写，磁盘满的时候连孤儿进程一起留下。
    // abort 走 fail()：它会 destroy 输出流、删掉半成品归档、SIGKILL 两个子进程。
    if (signal) {
      if (signal.aborted) {
        fail(abortMessage);
        return;
      }
      signal.addEventListener('abort', () => fail(abortMessage), { once: true });
    }
  });
}

/**
 * 打包**前**把暂存树整棵过一遍 tar 流，算出每个成员的名字与 sha256（P1）。
 *
 * 为什么用 tar 流而不是"遍历目录逐个哈希"：成员名必须是 `tar -tf` 会打印的那个字符串
 * （`./` 前缀、目录项带结尾 `/`、超过 100 字符时走 ustar prefix 或 GNU 长名），
 * 而这些规则由 tar 实现决定。直接问 tar 本身，就不用假设 GNU 与 busybox 一致
 * （实测两者一致，但不必依赖）。
 *
 * 代价：多一遍 70MB 的顺序读（实测见报告），换来的是"清单里记的就是归档里真的有的"。
 */
export function hashStagingTree(stagingDir: string): Promise<TarHashResult> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-cf', '-', '-C', stagingDir, '.']);
    let stderr = '';
    let exitCode: number | null = null;
    tar.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    tar.on('error', (err) =>
      reject(new BadRequestException(`tar 启动失败（计算成员哈希）：${err.message}`)),
    );
    const exited = new Promise<number | null>((res) => {
      tar.on('exit', (code) => {
        exitCode = code;
        res(code);
      });
      tar.on('close', () => res(exitCode));
    });
    const hashed = hashTarStream(tar.stdout);
    Promise.all([hashed, exited])
      .then(([result, code]) => {
        // 与打包那一遍同样容忍退出码 1（"file changed as we read it"）：
        // 暂存树是硬链接快照，导出期间有人原地覆盖图片时会走到这里
        if (code !== 0 && code !== null && code !== 1) {
          reject(
            new BadRequestException(
              `计算成员哈希失败（tar 退出码 ${code}）：${stderr.slice(0, 300)}`,
            ),
          );
          return;
        }
        resolve(result);
      })
      .catch(reject);
  });
}

/**
 * 把已落盘的归档**整份解压一遍**并流式算出每个成员的 sha256（校验用，不落盘、不占额外空间）。
 *
 * 解压器非零退出（截断 / 位翻转）不会立刻抛：把已经算出来的成员表一起返回，
 * 调用方才能说出"解压在哪一步炸了，而且炸之前这些成员已经对不上了"。
 */
/**
 * 起解压器，并按需接上解密流。
 *
 *  - **未加密** ⇒ 与改动前**逐字节相同**：归档路径作为命令行参数传给解压器。
 *    这条路是本仓库测得最充分的（恢复、校验、演练都走它），所以刻意一个字节都不动。
 *  - **加密** ⇒ 解压器改从 stdin 读，上游是 `文件流 → GCM 解密`。
 *
 * ⚠️ 为什么是流式而不是"先解密到临时文件"：解密到临时文件会让**明文的压缩归档**落盘
 * （虽然恢复过程本来就会把明文解包到暂存目录，但 `verify` / `listArchiveMembers` /
 * `inspectFullBackup` 这些路径原本**全程流式、明文不落盘**，不该为了省事把这个性质弄丢），
 * 而且要额外一份归档大小的磁盘空间 —— 大归档在小盘机器上会直接恢复不了。
 *
 * @param onUpstreamError 解密/读文件失败时的回调，交给各调用点**既有**的失败分支
 *   （它们的错误语义各不相同：有的 reject，有的 resolve(null)，有的记成 decompressError）。
 */
async function spawnArchiveDecompressor(
  archivePath: string,
  spec: CompressorSpec,
  onUpstreamError: (message: string) => void,
  passphrase?: string | null,
): Promise<{ child: ReturnType<typeof spawn>; encrypted: boolean; header: BackupEncryptionHeader | null }> {
  const { source, header } = await openDecryptedSource(archivePath, passphrase);
  if (!source) {
    return {
      child: spawn(spec.decompress[0], [...spec.decompress.slice(1), archivePath]),
      encrypted: false,
      header: null,
    };
  }
  const child = spawn(spec.decompress[0], spec.decompress.slice(1));
  // ⚠️ 两个 error 监听一个都不能少（本仓库已经为"流没有 error 监听"栽过跟头：
  //    EPIPE 没人接 ⇒ unhandledRejection ⇒ Node 20 直接退出整个进程）：
  //  1) child.stdin：解压器提前退出（归档损坏、格式不对）时往它写会 EPIPE；
  //  2) source：GCM 认证失败、归档被截断、读文件失败。
  child.stdin.on('error', () => {
    // 故意静默：真正的原因由 source 的 error 或解压器的 close 分支报出来，
    // 这里再报一次只会把一条清晰的错误变成两条互相干扰的。
  });
  source.on('error', (err: Error) => {
    onUpstreamError(err.message);
    // ⚠️⚠️ 必须**主动收掉解压器**，否则整个恢复会挂死：
    // Node 的 `readable.pipe(writable)` 在上游 'error' 时只会 unpipe，**不会** end 下游
    // （只有正常 'end' 才会）。于是解压器的 stdin 一直开着、它就一直等输入 ⇒
    // 既不出数据也不退出 ⇒ 调用方的 Promise 永远不 settle。
    // 实测症状：口令错了 / 归档被截断时，恢复请求**永久挂起**（而不是报错），
    // 而"挂起"比"失败"糟得多 —— 站长看到的是转圈，日志里什么都没有，
    // 而且这次恢复还占着 init/restore 那把 DB 锁直到 TTL 到期。
    // 这里 SIGKILL 解压器：它会以非 0 退出，各调用点**既有**的 close 分支随即触发，
    // 并优先报 upstreamError（口径见 hashArchiveMembers / decompressUntar 里的注释）。
    try {
      child.stdin.end();
    } catch {
      // 已经关了就算了
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // 进程可能已经没了
    }
  });
  source.pipe(child.stdin);
  return { child, encrypted: true, header };
}

export async function hashArchiveMembers(
  archivePath: string,
  spec: CompressorSpec,
  options: { computeHashes?: boolean; passphrase?: string | null } = {},
): Promise<{ result: TarHashResult; decompressError: string | null }> {
  let decErr = '';
  let exitCode: number | null = null;
  let upstreamError: string | null = null;
  const { child: decompressor } = await spawnArchiveDecompressor(
    archivePath,
    spec,
    (message) => {
      upstreamError = message;
    },
    options.passphrase,
  );
  decompressor.stderr.on('data', (chunk) => {
    decErr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    decompressor.on('error', (err) =>
      reject(new BadRequestException(`解压器起不来（${spec.decompress[0]}）：${err.message}`)),
    );
    decompressor.on('exit', (code) => {
      exitCode = code;
      resolve(code);
    });
    decompressor.on('close', () => resolve(exitCode));
  });
  const hashed = hashTarStream(decompressor.stdout, options);
  const [result, code] = await Promise.all([hashed, exited.catch(() => null)]);
  // ⚠️ 解密失败优先报：这时解压器只是"收到了 EOF"，退出码可能是 0 或 1，
  //    而真正的原因（口令不对 / 归档被截断 / 块被重排）在上游那条错误里。
  //    不这么做的话，站长看到的是"解压失败（退出码 1）"，会以为是压缩器坏了。
  const decompressError = upstreamError
    ? `解密失败：${upstreamError}`
    : code === 0
      ? null
      : `${spec.format} 解压失败（退出码 ${code}）：${decErr.slice(0, 300)}`;
  return { result, decompressError };
}

/**
 * 只列成员（名字 + **类型** + 链接目标），不算哈希 —— 恢复前的安全守卫用这个。
 *
 * 为什么不用 `listArchiveMembers()`（`tar -tf`）：那份输出**只有名字，没有类型**，
 * 而"能不能安全解包"恰恰取决于类型（符号链接会被 web 层跟随 ⇒ 匿名任意文件读）。
 * 顺带还有一个好处：成员名取自 tar 头部本身，不受 GNU/busybox 打印转义差异的影响
 * （GNU 会把名字里的控制字符转义成 `\302\233`，busybox 原样输出）。
 */
export async function listArchiveEntries(
  archivePath: string,
  options: { passphrase?: string | null } = {},
): Promise<{ entries: TarEntryInfo[]; decompressError: string | null }> {
  const format = detectFormat(archivePath);
  if (!format) {
    throw new BadRequestException('无法识别备份文件的压缩格式（支持 .tar.zst / .tar.xz / .tar.gz）');
  }
  const spec = specFor(format);
  if (!spec) {
    throw new BadRequestException(`本机没有 ${format} 解压工具，无法检查这个备份`);
  }
  const { result, decompressError } = await hashArchiveMembers(archivePath, spec, {
    computeHashes: false,
    passphrase: options.passphrase,
  });
  return { entries: result.entries, decompressError };
}

/**
 * 解压缩 | tar -x -C dest（全异步）。
 *
 * ⚠️ `await spawnArchiveDecompressor(...)` 必须在 `new Promise` **之外**：
 * Promise 的 executor 里 await 一个抛错的东西，那个 rejection 会被吞掉
 * （executor 不是 async 函数），调用方就永远等不到结果。
 */
async function decompressUntar(
  archivePath: string,
  destDir: string,
  spec: CompressorSpec,
  passphrase?: string | null,
): Promise<void> {
  let upstreamError: string | null = null;
  const { child: decompressor } = await spawnArchiveDecompressor(
    archivePath,
    spec,
    (message) => {
      upstreamError = message;
    },
    passphrase,
  );
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xf', '-', '-C', destDir]);
    let decErr = '';
    let tarErr = '';
    let settled = false;
    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        for (const child of [decompressor, tar]) {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
        reject(new BadRequestException(message));
      }
    };
    // 同导出侧：tar 提前退出会让解压器写 stdin 时 EPIPE，不挂 error 就是进程级崩溃
    tar.stdin.on('error', (err: Error) => fail(`解包写入失败：${err.message}`));
    decompressor.stderr.on('data', (c) => {
      decErr += c.toString();
    });
    tar.stderr.on('data', (c) => {
      tarErr += c.toString();
    });
    decompressor.on('error', (err) => fail(`解压失败：${err.message}`));
    tar.on('error', (err) => fail(`tar 启动失败：${err.message}`));
    decompressor.stdout.pipe(tar.stdin);
    decompressor.on('close', (code) => {
      if (code !== 0) {
        // ⚠️ 解密失败优先报（见 hashArchiveMembers 里的同款说明）：
        // 上游断了的时候解压器只是"收到 EOF"，它自己的退出码与 stderr 说明不了原因。
        fail(
          upstreamError
            ? `解密失败：${upstreamError}`
            : `${spec.format} 解压失败（退出码 ${code}）：${decErr.slice(0, 500)}`,
        );
      }
    });
    tar.on('close', (code) => {
      if (code !== 0) {
        fail(
          upstreamError
            ? `解密失败：${upstreamError}`
            : `tar 解包失败（退出码 ${code}）：${tarErr.slice(0, 500)}`,
        );
        return;
      }
      // ⚠️ 即便 tar 退出码是 0，上游报过错也必须失败：被截断的加密归档解出来的
      // 可能是"前半份完整、后半份没有"，而 tar 对"输入突然结束"在某些实现下并不报错。
      // 半份数据被解包进暂存目录，比直接失败危险得多。
      if (upstreamError) {
        fail(`解密失败：${upstreamError}`);
        return;
      }
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}

/**
 * 只把归档里的某个文件解出来（读 manifest 用，不用整包解压）。导出给 utils/backupVerify.ts 复用。
 *
 * ⚠️ 契约（**有一处刻意的变化**，backupVerify.ts 的调用方要知道）：
 *  - 归档损坏/解压器失败/成员不存在 ⇒ 仍然 `resolve(null)`（与改动前一致）；
 *  - **加密归档但拿不到口令** ⇒ **reject**（BadRequestException）。
 *    为什么区别对待：前者是"这份归档有问题"，后者是"你还没给出读取它的前提条件"。
 *    把后者也返回 null 会让站长看到"清单读不出来"，然后去怀疑一份完好无损的备份。
 *  - 解密中途失败（口令错、被截断、块被重排）⇒ `resolve(null)`，因为这个函数的
 *    调用点把它当"能不能读出这个成员"用，而失败原因会由同一次校验里的
 *    `hashArchiveMembers` 那条 `decompressError` 报出来（两处都走 openDecryptedSource）。
 */
export async function extractSingleFile(
  archivePath: string,
  entry: string,
  spec: CompressorSpec,
  passphrase?: string | null,
): Promise<string | null> {
  const { child: decompressor } = await spawnArchiveDecompressor(archivePath, spec, () => {
    // 解密中途失败：交给下面的 close 分支返回 null（见函数注释里的契约说明）
  }, passphrase);
  return new Promise((resolve) => {
    const tar = spawn('tar', ['-xOf', '-', entry]);
    let stdout = '';
    let settled = false;
    const done = (value: string | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    decompressor.on('error', () => done(null));
    tar.on('error', () => done(null));
    decompressor.stdout.pipe(tar.stdin);
    tar.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    tar.on('close', (code) => done(code === 0 && stdout ? stdout : null));
    decompressor.on('close', (code) => {
      if (code !== 0) {
        done(null);
      }
    });
  });
}

/** 硬链接整棵树到暂存目录（同一文件系统上零额外空间）；失败回退成真实拷贝。 */
function linkTree(src: string, dst: string, logger: BackupLogger): void {
  if (!fs.existsSync(src)) {
    return;
  }
  // ⚠️ src 本身可能是**指向目录的符号链接**（把图床挪到另一块盘/另一个卷的常见做法）。
  // `cp -al` 的 `-a` 含 `-d`（--no-dereference），于是它会把**链接本身**拷进暂存目录：
  // 归档里只剩一个符号链接、零字节图片，而 `treeStats()` 跟着链接数出了真实文件数
  // ⇒ 写后校验的 staticConsistent 必然失败（导出 400），也就是"图床是软链的站点根本备份不了"；
  // 而恢复侧现在还**一律拒绝符号链接成员**（见 findUnsafeArchiveEntry）。
  // 所以这里先把源解析成真实路径。实测：`cp -al static/img stage/static/img`
  // 在 img 是软链时产出的就是一个软链成员，不是目录内容。
  let realSrc = src;
  try {
    if (fs.lstatSync(src).isSymbolicLink()) {
      realSrc = fs.realpathSync(src);
      // 这条 WARN 要说清"什么都没丢"：否则运维看到"是符号链接"会以为图床没进归档
      logger.warn(
        `静态目录 ${src} 是一个符号链接，指向 ${realSrc}：已按真实路径打包，` +
          `目录里的内容照常进归档（没有丢东西）`,
      );
    }
  } catch {
    // lstat/realpath 失败就用原路径，交给 cp 报错
  }
  ensureDir(path.dirname(dst));
  const res = spawnSync('cp', ['-al', realSrc, dst], { stdio: 'ignore' });
  if (res.status === 0) {
    return;
  }
  logger.warn(`硬链接失败（${realSrc}），改用真实拷贝`);
  fs.cpSync(realSrc, dst, { recursive: true, force: true, dereference: false });
}

function treeStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // 忽略读不到的文件
        }
      }
    }
  };
  if (fs.existsSync(dir)) {
    walk(dir);
  }
  return { files, bytes };
}

/**
 * 写盘失败的人话版本：把剩余空间与 errno 一起说出来。
 * 磁盘满是备份最常见的失败原因，只给一句 ENOSPC 的话运维得自己上机器 df。
 */
function describeWriteError(err: unknown, target: string): string {
  const message = (err as Error)?.message || String(err);
  const code = (err as NodeJS.ErrnoException)?.code;
  const free = freeSpaceText(path.dirname(target));
  return (
    `写入备份文件失败：${message}（${target}；剩余空间 ${free}` +
    (code ? `；errno=${code}` : '') +
    (code === 'ENOSPC' ? ' —— 磁盘已满' : '') +
    '）'
  );
}

async function dumpCollection(
  collection: any,
  ndjsonPath: string,
  indexPath: string,
  signal?: AbortSignal,
): Promise<CollectionSummary> {
  let count = 0;
  let bytes = 0;
  // 0600：暂存目录本身是 0700，但导出物是整库明文（口令哈希、jwt 密钥），
  // 而暂存根目录在 `<static>/tmp` 下 —— 多一层权限，少一个"哪天守卫或挂载配置变了"的意外。
  const stream = fs.createWriteStream(ndjsonPath, { mode: SECRET_FILE_MODE });
  chmodBestEffort(ndjsonPath, SECRET_FILE_MODE);

  /**
   * ⚠️ 这条 error 监听是**必需的**，不是防御性冗余。
   *
   * 没有它，磁盘写满（ENOSPC）或数据卷消失时错误会以「EventEmitter 'error' 无监听者」的形式
   * 抛到进程层 —— 落到 `main.ts` 的 uncaughtException，而那里**只打印不退出**；与此同时下面
   * `drain` / `end` 的回调**永远不会来**，于是这个 Promise 永不 settle：
   *  - `backup-status.json` 永远停在"进行中"；
   *  - 归档是半截的，但没有任何一处说它坏了；
   *  - await 它的 HTTP 请求一直挂着（cron 备份看起来"还在跑"）；
   *  - SIGTERM 的优雅退出被拖到超时。
   * 用户看不到"备份失败"，只看到几行 uncaughtException。
   *
   * 同文件其它每一处流都挂了 error 监听（tar 管道、tar 成员哈希、恢复侧的解包），
   * 只有这一处漏了 —— 而它恰好是备份里**写盘量最大**的一段。
   */
  let streamError: Error | null = null;
  const errored = new Promise<never>((_resolve, reject) => {
    stream.once('error', (err: Error) => {
      streamError = err;
      reject(err);
    });
  });
  // 先挂一个空 catch：否则"错误发生但这一轮 race 已经结束"时 Node 会报 unhandledRejection
  // （Node 20+ 默认直接退出进程）。真正的错误仍然通过下面的 race 传出去。
  errored.catch(() => undefined);
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, errored]);

  const abortError = () =>
    new BadRequestException('备份被中止（超过整轮超时）：数据库导出已停止，本次备份按失败计');

  try {
    const cursor = collection.find({});
    try {
      for await (const doc of cursor) {
        // 逐条检查取消：一次超时之后继续往盘上写没有意义，而且会占着磁盘与连接
        if (signal?.aborted) {
          throw abortError();
        }
        const line = `${JSON.stringify(encodeDoc(doc))}\n`;
        if (!stream.write(line)) {
          // @types/node 24 给 fs.WriteStream 的事件表加了强类型（'drain' 的监听器是 () => void），
          // 而 Promise 的 resolve 是 (value: unknown) => void，直接塞进去会报 TS2345
          // （目标签名参数太少）。包一层无参回调即可，运行时行为与原来完全一致。
          // ⚠️ 必须 race 上 errored：流坏了 'drain' 永远不会来。
          await race(new Promise<void>((resolve) => stream.once('drain', () => resolve())));
        }
        count += 1;
        bytes += Buffer.byteLength(line);
      }
    } finally {
      try {
        await cursor.close?.();
      } catch {
        // 关不掉游标不影响结论：错误已经从别处传出去了
      }
    }
    // 同上：原来写 `stream.end(resolve)`，运行时 Node 把函数实参当回调（行为正确），
    // 但类型上是撞进了 `end(chunk: any, cb?)` 重载 —— resolve 被当成待写数据。
    // 显式写成回调，类型与运行时语义一致，行为不变。
    await race(new Promise<void>((resolve) => stream.end(() => resolve())));
  } catch (err) {
    try {
      stream.destroy();
    } catch {
      // ignore
    }
    // 半成品 NDJSON 必须删掉：留在暂存目录里会被 tar 打进归档，
    // 变成一份"看起来完整、其实少一半文档"的备份
    try {
      fs.rmSync(ndjsonPath, { force: true });
    } catch {
      // ignore
    }
    if (streamError) {
      // 用户可见的错误一律 BadRequestException：普通 Error 会被 Nest 变成
      // 500 + "Internal server error"，前端与 cron 都看不到原因
      throw new BadRequestException(describeWriteError(streamError, ndjsonPath));
    }
    throw err;
  }
  // end 的回调来了不代表没出错（错误可能在 flush 阶段才到），所以再确认一次
  if (streamError) {
    throw new BadRequestException(describeWriteError(streamError, ndjsonPath));
  }

  let indexes: any[] = [];
  try {
    const raw = await collection.indexes();
    indexes = (raw || []).filter((item: any) => item?.name !== '_id_');
    writeSecretFileSync(indexPath, JSON.stringify(indexes.map((item) => encodeDoc(item)), null, 0));
  } catch {
    writeSecretFileSync(indexPath, '[]');
  }
  return { count, bytes, indexes: indexes.length };
}

async function dumpDatabase(
  client: MongoClient,
  dbName: string,
  outDir: string,
  signal?: AbortSignal,
): Promise<{
  collections: Record<string, CollectionSummary>;
  documents: number;
}> {
  const db: Db = client.db(dbName);
  const names = (await db.collections()).map((item) => item.collectionName).sort();
  const collections: Record<string, CollectionSummary> = {};
  let documents = 0;
  ensureDir(outDir);
  for (const name of names) {
    if (name.endsWith(RESTORE_SUFFIX)) {
      continue; // 上次恢复失败留下的临时集合，不进备份
    }
    const summary = await dumpCollection(
      db.collection(name),
      path.join(outDir, `${name}.ndjson`),
      path.join(outDir, `${name}.indexes.json`),
      signal,
    );
    collections[name] = summary;
    documents += summary.count;
  }
  return { collections, documents };
}

export interface CreateFullBackupOptions {
  client: MongoClient;
  staticPath: string;
  dbName: string;
  /** 评论库（waline）；留空则不备份 */
  walineDbName?: string;
  /** 'auto' | 'zstd' | 'xz' | 'gzip' */
  format?: string;
  /** 归档输出目录（`config.backupPath`），不要在 staticPath 下面 */
  outDir: string;
  workDir?: string;
  serverVersion?: string;
  /**
   * 导出实例的身份信息（P1/P3）。留空则清单里没有 `source` 块（老调用方不受影响）。
   * 恢复时用它发现 waline 库名 / demo 模式的静默错配。
   */
  source?: BackupSourceInfo;
  /**
   * P6（可选）：caddy 的数据目录（TLS 证书与私钥）。留空 = 不打包（今天的默认行为）。
   * 调用方按 `VANBLOG_BACKUP_INCLUDE_CADDY` 决定要不要传；目录读不到只 WARN 不失败。
   */
  caddyDataPath?: string;
  /**
   * 整轮备份的超时/取消信号（provider 按 `VANBLOG_BACKUP_TIMEOUT_MINUTES` 建）。
   *
   * ⚠️ 为什么要把信号**传进来**、而不是只在调用方 `Promise.race`：race 只让调用方解脱，
   * 底下的 mongo 游标、tar 与压缩器子进程还在跑 —— 磁盘满的时候会连孤儿进程一起留下。
   * 传进来之后：导出循环逐条检查取消，tar 管道收到 abort 走 `fail()`
   * （destroy 输出流 + 删半成品归档 + SIGKILL 两个子进程），是真的停下来。
   */
  abortSignal?: AbortSignal;
  /**
   * 备份口令（可选）。
   *  - `undefined` ⇒ 按 env 解析（`VANBLOG_BACKUP_PASSPHRASE` / `..._FILE`），这是常规路径；
   *  - 字符串 ⇒ 用它（调用方从别处拿到口令，例如一次性导出）；
   *  - `null` ⇒ **明确不要加密**（用于"导出给站长下载"这种不希望产出 .enc 的场景）。
   */
  passphrase?: string | null;
  logger?: BackupLogger;
}

export interface FullBackupResult {
  path: string;
  name: string;
  bytes: number;
  sizeText: string;
  format: BackupFormat;
  compressor: string;
  ms: number;
  manifest: FullBackupManifest;
  /** 整份归档的 sha256（写出时流式算的，且已回读复核）；同时进了 `.sha256` sidecar */
  archiveSha256: string;
  /** 归档成员总数（含目录项）；关闭 integrity 时为 null */
  memberCount: number | null;
  /** 算成员哈希额外花的时间（ms）；关闭 integrity 时为 0 */
  hashMs: number;
  /** 这份归档是否加密（`name` 会带 `.enc` 后缀） */
  encrypted: boolean;
  /**
   * 未加密时的 WARN 文案（已加密则为 null）。
   *
   * ⚠️ 为什么由**这里**返回、而不是在本函数里直接 logger.warn：
   * 决定"这条提醒要不要进事件日志、要不要在后台弹一次"的是调用方
   * （provider 有事件日志与状态文件，utils 这层只有一个可选的 logger）。
   * 但文案必须在这里生成 —— 它引用了加密层的常量与最短口令长度，
   * 让调用方自己拼就会漂。
   */
  plaintextWarning: string | null;
  /**
   * 这份归档**有没有被签名**（写出了 `.sig`）。
   *
   * ⚠️ 与 `encrypted` 一样，这是"我以为开了、其实没开"最危险的那类状态：
   * 签名没生效时归档照常产出、校验照常通过，站长却以为异地副本是可证明的。
   * 所以它必须出现在结果、日志与 `backup-status.json` 里。
   */
  signed: boolean;
  /** 签名密钥的指纹（公钥 sha256 前 16 位）；未签名为 null。⚠️ 非机密，可以进日志与状态文件。 */
  signingFingerprint: string | null;
  /**
   * 未签名时的 WARN 文案（已签名则为 null）。与 `plaintextWarning` 同一个套路：
   * 文案在这里生成（引用签名层的常量与变量名才不会漂），要不要进事件日志由调用方决定。
   */
  signatureWarning: string | null;
}

/** 导出整站备份：数据库（含 waline）+ 本地静态文件 -> 一个高压缩归档。 */
export async function createFullBackup(options: CreateFullBackupOptions): Promise<FullBackupResult> {
  const logger = options.logger || silentLogger;
  const started = Date.now();
  const spec = pickSpec(options.format);
  if (!spec) {
    throw new BadRequestException(
      `没有可用的压缩器（想要 ${options.format || 'zstd/xz/gzip'}，本机可用：${
        availableFormats().join(', ') || '无'
      }；至少需要 gzip）`,
    );
  }
  // ── 可选加密：默认关，配了口令就开 ──────────────────────────────────────
  // ⚠️ 口令解析要**早**（在任何磁盘工作之前）：`_FILE` 读不到时必须失败关闭，
  //    否则会在导出了几百 MB 之后才发现"其实没加密"，白跑一轮还留下明文归档。
  const resolvedPass =
    options.passphrase === null
      ? { passphrase: null, source: null, describe: () => describePassphrase(null) }
      : resolveBackupPassphrase(process.env, options.passphrase);
  // 加密器在打包**之前**就造好：头部（salt/iv/KDF 参数）要进 manifest，
  // 而 manifest 是先写进暂存树、再被 tar 打进去的。
  const encryptor = resolvedPass.passphrase
    ? await createEncryptor({
        passphrase: resolvedPass.passphrase,
        inner: { format: spec.format, ext: spec.ext, label: spec.label },
      })
    : null;
  if (encryptor) {
    // ⚠️ 只说"加密已开启"与来源，绝不打印口令本身
    logger.log(`备份加密：已开启（scrypt + aes-256-gcm，口令来源 ${resolvedPass.source}，${resolvedPass.describe()}）`);
  }

  const staticPath = options.staticPath;
  // 0700：归档目录里是整站凭据，而它挂在宿主机上（理由见 utils/secretFileMode.ts）。
  // ⚠️ 对**已存在**的目录也会 chmod，所以老部署（现在是 0755）升级后第一次备份就收紧了。
  const outDir = ensureSecretDir(options.outDir, SECRET_DIR_MODE);
  // 暂存根目录同样收紧：它下面每个 `full-backup-*` 里都是**未压缩的整库明文**。
  const workRoot = ensureSecretDir(options.workDir || path.join(staticPath, 'tmp'), SECRET_DIR_MODE);
  const staging = fs.mkdtempSync(path.join(workRoot, 'full-backup-'));

  try {
    const manifest: FullBackupManifest = {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      format: spec.format,
      compressor: spec.label,
      serverVersion: options.serverVersion,
      // ⚠️ 必须在写盘（下面第 4 步的两份清单）之前设好：主清单与副本要**逐字节相同**，
      //    而校验时会把两份拿出来对照，任何"只改了一份"的字段都会让校验失败。
      encryption: encryptor ? encryptionSummary(encryptor.header) : undefined,
      databases: {},
      static: {},
      totals: {
        databases: 0,
        collections: 0,
        documents: 0,
        files: 0,
        staticBytes: 0,
      },
    };

    // 1) 数据库：主库 + waline 评论库
    const dbNames = [options.dbName, options.walineDbName].filter(
      (name, index, arr): name is string => Boolean(name) && arr.indexOf(name) === index,
    );
    for (const dbName of dbNames) {
      logger.log(`导出数据库 ${dbName} ...`);
      const dumped = await dumpDatabase(options.client, dbName, path.join(staging, 'db', dbName), options.abortSignal);
      if (!Object.keys(dumped.collections).length) {
        rmrf(path.join(staging, 'db', dbName));
        continue;
      }
      manifest.databases[dbName] = { collections: dumped.collections };
      manifest.totals.databases += 1;
      manifest.totals.collections += Object.keys(dumped.collections).length;
      manifest.totals.documents += dumped.documents;
    }

    // 2) 静态文件：硬链接进暂存目录（不占额外空间）
    for (const folder of BACKUP_STATIC_FOLDERS) {
      const src = path.join(staticPath, folder);
      if (!fs.existsSync(src)) {
        continue;
      }
      linkTree(src, path.join(staging, 'static', folder), logger);
      const stats = treeStats(path.join(staging, 'static', folder));
      manifest.static[folder] = stats;
      manifest.totals.files += stats.files;
      manifest.totals.staticBytes += stats.bytes;
    }

    // 2b) caddy 的 TLS 材料（P6，**默认关**：调用方按 VANBLOG_BACKUP_INCLUDE_CADDY 决定要不要传路径）
    //
    // 为什么默认关：证书与私钥住在**另一个卷**里（Dockerfile 的
    // `VOLUME /root/.local/share/caddy`），是整站唯一"离线重新造不出来"的东西 ——
    // 换新机器时它必须重新向 Let's Encrypt 申请（要 DNS、要外网、还受速率限制）。
    // 但把它打进归档，等于把 TLS 私钥放进一个**本来就是明文**、已经装着密码哈希与
    // jwt 密钥的文件里：不新增秘密的种类，但显著抬高了"归档能放在哪"的要求。
    // 所以做成显式开关，默认不动今天的归档内容。
    //
    // ⚠️ 目录不存在 / 读不动时**只记一条 WARN 就跳过**，绝不让整次备份失败：
    // "备份做不出来"比"备份里少了证书"严重得多（证书还能重签，数据没了就没了）。
    if (options.caddyDataPath) {
      const caddySrc = options.caddyDataPath;
      try {
        if (!fs.existsSync(caddySrc)) {
          logger.warn(`caddy 数据目录不存在，本次备份不含 TLS 材料：${caddySrc}`);
        } else {
          linkTree(caddySrc, path.join(staging, 'caddy'), logger);
          const stats = treeStats(path.join(staging, 'caddy'));
          manifest.caddy = stats;
          logger.log(`已把 caddy 的 TLS 材料打进归档：${stats.files} 个文件，${formatBytes(stats.bytes)}`);
        }
      } catch (err) {
        logger.warn(
          `打包 caddy 数据目录失败，本次备份不含 TLS 材料（备份本身继续）：${
            (err as Error)?.message || err
          }`,
        );
        rmrf(path.join(staging, 'caddy'));
        delete manifest.caddy;
      }
    }

    // 3) 防损坏信息（P1）：先把暂存树整棵过一遍 tar 流，算出每个成员的名字 + sha256。
    //    ⚠️ 必须**在写 manifest 之前**做完：manifest 里要记这些哈希，
    //    而两份清单自己的哈希只能是 null（清单不能包含自己的哈希，副本与它逐字节相同）。
    let integrity: BackupIntegrity | undefined;
    let hashMs = 0;
    let tarMembers: TarHashResult | null = null;
    if (integrityEnabled()) {
      const hashStarted = Date.now();
      tarMembers = await hashStagingTree(staging);
      if (!tarMembers.complete) {
        // tar 流没走到全零结束块 = 打包前的这一遍就没读完；宁可导出失败也不要一份
        // "看起来有哈希、其实哈希表本身残缺"的清单
        throw new BadRequestException(
          '计算归档成员哈希时 tar 流未正常结束（暂存目录读不完整），本次备份已中止',
        );
      }
      if (tarMembers.badHeaders.length) {
        throw new BadRequestException(
          `计算归档成员哈希时发现 tar 头部校验和不对的成员：${tarMembers.badHeaders.slice(0, 5).join(', ')}`,
        );
      }
      if (tarMembers.duplicateNames.length) {
        throw new BadRequestException(
          `暂存树里出现同名成员：${tarMembers.duplicateNames.slice(0, 5).join(', ')}`,
        );
      }
      // 压缩器的内容校验位：这里按 spec 声明（zstd 显式带 --check），
      // 打包完成后**再实测一次帧头**并比对（见下面第 5 步），对不上就是响亮失败
      const declared = declaredFrameChecksum(spec);
      integrity = buildIntegrity({
        members: tarMembers.members,
        memberCount: tarMembers.memberCount,
        frameChecksum: declared,
      });
      // 静态目录里如果有**嵌套的**符号链接（不是目录本身是软链，那种上面已经 realpath 过了），
      // 它会变成一个符号链接成员进归档 —— 而恢复侧的安全守卫现在**一律拒绝符号链接成员**
      // （见 findUnsafeArchiveEntry：软链会被拷进静态目录并被 web 层跟随 ⇒ 匿名任意文件读）。
      // 所以这里必须提前说清楚，否则用户会得到一份"导得出、恢复不了"的归档，
      // 而且要等到真需要恢复那天才发现。
      const links = tarMembers.entries.filter((entry) => entry.kind === 'symlink');
      if (links.length) {
        logger.warn(
          `静态目录里有 ${links.length} 个符号链接（${links
            .slice(0, 5)
            .map((entry) => `${entry.name} -> ${entry.linkTarget || '?'}`)
            .join(', ')}）：它们会作为链接成员进归档，而恢复时会被安全守卫拒绝` +
            `（符号链接能被 web 层跟随，等于匿名任意文件读）。请把它们换成真实文件或删掉，` +
            `否则这份归档导得出、恢复不了`,
        );
      }
      hashMs = Date.now() - hashStarted;
      manifest.integrity = integrity;
      logger.log(
        `成员哈希完成：${integrity.memberCount} 个成员（${
          Object.keys(integrity.members).length
        } 个带哈希），耗时 ${(hashMs / 1000).toFixed(2)}s，merkleRoot ${integrity.merkleRoot.slice(0, 12)}…`,
      );
    }
    if (options.source) {
      manifest.source = options.source;
    }

    // 4) manifest + **第二份副本**（含 sidecar，方便不解压就能列信息）
    const manifestText = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(staging, 'manifest.json'), manifestText);
    // 为什么要有副本：manifest.json 是归档里唯一"丢了就整份既不可校验也不可恢复"的成员
    // （恢复靠它找库名与集合名，校验靠它拿期望哈希）。多存一份逐字节相同的副本，
    // 代价是几 KB，换来的是"其中一份被位翻转/被截断时另一份还能救"。
    fs.writeFileSync(path.join(staging, MANIFEST_COPY_FILENAME), manifestText);

    // 5) 打包压缩：先写到**不可能被列表/保留策略认成归档**的临时名，成功了才 rename 就位
    // ⚠️ 后缀必须带 `.enc`：一个叫 `.tar.zst` 却是密文的文件，会让 `zstd -t`、
    //    `file`、以及任何按名字判断的工具给出完全无法理解的报错。
    const encExt = encryptor ? BACKUP_ENC_EXT : '';
    const name = backupFileName(new Date(), `${spec.ext}${encExt}`);
    const archivePath = path.join(outDir, name);
    const tempPath = path.join(outDir, exportTempName(`${spec.ext}${encExt}`));
    logger.log(`打包中（${spec.label}${encryptor ? ' + 加密' : ''}）...`);
    let streamed: { bytes: number; sha256: string };
    try {
      streamed = await tarCompress(
        staging,
        tempPath,
        spec,
        options.abortSignal,
        undefined,
        encryptor?.transform,
      );
    } catch (err) {
      rmTemp(tempPath);
      throw err;
    }
    // 回读复核：磁盘上的字节必须与刚刚流出去的字节完全一致。
    // 抓的是"写入被静默截断"（磁盘满但 FS 没报错、网络盘/容器卷的怪行为），
    // 也就是 P2 要求的"磁盘满要变成响亮的失败，而不是列表里一份看起来正常的截断归档"。
    let readBack: { sha256: string; bytes: number };
    try {
      readBack = await hashFile(tempPath);
    } catch (err) {
      rmTemp(tempPath);
      throw new BadRequestException(
        `回读刚写出的备份失败（剩余空间 ${freeSpaceText(outDir)}）：${(err as Error)?.message || err}`,
      );
    }
    if (readBack.bytes !== streamed.bytes || readBack.sha256 !== streamed.sha256) {
      rmTemp(tempPath);
      throw new BadRequestException(
        `备份文件落盘后与写出的内容不一致（写出 ${streamed.bytes} 字节 / sha256 ${streamed.sha256.slice(
          0,
          12,
        )}…，回读 ${readBack.bytes} 字节 / sha256 ${readBack.sha256.slice(0, 12)}…；` +
          `剩余空间 ${freeSpaceText(outDir)}）—— 已删除半成品，这次备份按失败计`,
      );
    }
    // 压缩器自带的内容校验位：清单里记的值必须与归档头部的实测值一致
    if (integrity && encryptor) {
      // 加密归档的帧头是我们的魔数，压缩格式的帧头在密文里 ⇒ 探测不到，也不该探测。
      // ⚠️ 这不是"少了一层校验"：GCM 对**整个密文**做密码学认证，强度远高于 zstd 的
      //    CRC32 帧校验位（后者只防随机位翻转，防不了有意篡改）。
      // 清单里那个 `zstdFrameChecksum` 仍然是"我们要求压缩器开启校验位"的**声明**，
      // 恢复时解密之后由解压链路自己校验。
      logger.log('加密归档：跳过压缩器帧校验位探测（GCM 认证已覆盖整个密文，且强度更高）');
    } else if (integrity) {
      const probe = probeCompressorChecksum(tempPath, spec.format);
      if (probe.enabled === null) {
        logger.warn(`读不出压缩器的内容校验位（${probe.detail}），清单里记的 ${integrity.zstdFrameChecksum} 未经实测复核`);
      } else if (probe.enabled !== integrity.zstdFrameChecksum) {
        rmTemp(tempPath);
        throw new BadRequestException(
          `压缩器内容校验位与清单记录不一致（清单 ${integrity.zstdFrameChecksum}，实测 ${probe.enabled}：${probe.detail}）` +
            ' —— 归档失去自校验能力，已删除半成品',
        );
      }
    }
    // 原子就位：临时名 -> 正式名（同目录 rename，读者要么看不到、要么看到完整的一份）
    try {
      fs.renameSync(tempPath, archivePath);
    } catch (err) {
      rmTemp(tempPath);
      throw new BadRequestException(
        `备份文件改名就位失败（${tempPath} -> ${archivePath}）：${(err as Error)?.message || err}`,
      );
    }
    const bytes = fs.statSync(archivePath).size;
    manifest.totals.archiveBytes = bytes;
    manifest.totals.archiveSha256 = readBack.sha256;
    // sidecar 清单：后台列表页读的 cheap path（内部那份没有 archiveBytes / archiveSha256，
    // 因为它们在打包时还不存在 —— 校验时会把这两个字段剥掉再比对）
    // 0600：清单里有全部成员路径与逐成员 sha256，和归档放在一起、一起收紧
    writeSecretFileSync(`${archivePath}.manifest.json`, JSON.stringify(manifest, null, 2));
    // 整归档 sha256 sidecar（`sha256sum -c` 与 `vanblog.sh verify` 都吃这个格式）：
    // 归档被拷去别处时把它一起带走，就能在没有 server 的机器上验完整性
    if (writeSha256Sidecar(archivePath, readBack.sha256) === null) {
      logger.warn(`写 ${name}${'.sha256'} 失败（备份本身已成功，但拷走归档时少一个外部凭据）`);
    }
    // 离线签名（detached `.sig`）：签的是**已经流式算出来、且刚回读复核过**的那个 sha256，
    // 所以这里**不再读一遍归档**（归档可能几个 GB）。加密归档签的是**密文** ⇒
    // 不解密也能验真实性，与"sidecar 保持明文"的既有决定一致。
    // ⚠️ 默认关：没配签名密钥时 `signArchiveDigest` 返回 null，一个字节都不写，
    //    产物与加这个功能之前逐字节一致（有守卫钉住）。
    const signingKey = resolveSigningKey(outDir);
    let sigPath: string | null = null;
    try {
      sigPath = signArchiveDigest({
        archivePath,
        archiveSha256: readBack.sha256,
        archiveBytes: bytes,
        signingKey,
      });
    } catch (err) {
      // ⚠️ 签名失败**不把一次成功的备份判成失败**（归档与两个 sidecar 都已经写好了），
      //    但必须大声说：否则站长以为这份归档可证明，实际不可。
      logger.warn(
        `写 ${name}.sig 失败（备份本身已成功，但这份归档**没有签名**，无法证明它离开主机后没被改过）：${
          (err as Error)?.message || err
        }`,
      );
    }
    if (sigPath) {
      logger.log(`已签名：${path.basename(sigPath)}（ed25519，密钥指纹 ${signingKey?.fingerprint}）`);
    }

    logger.log(
      `备份完成：${name}（${bytes} 字节，${manifest.totals.documents} 条文档，${manifest.totals.files} 个文件，` +
        `sha256 ${readBack.sha256.slice(0, 12)}…）`,
    );
    return {
      path: archivePath,
      name,
      bytes,
      sizeText: `${(bytes / 1024 / 1024).toFixed(2)} MB`,
      format: spec.format,
      compressor: spec.label,
      ms: Date.now() - started,
      manifest,
      archiveSha256: readBack.sha256,
      memberCount: integrity?.memberCount ?? tarMembers?.memberCount ?? null,
      hashMs,
      encrypted: Boolean(encryptor),
      plaintextWarning: encryptor ? null : plaintextArchiveWarning(name),
      signed: Boolean(sigPath),
      signingFingerprint: sigPath ? signingKey?.fingerprint ?? null : null,
      signatureWarning: sigPath
        ? null
        : `这份归档**没有签名**（没有配 ${'VANBLOG_BACKUP_SIGNING_KEY'} / ${'VANBLOG_BACKUP_SIGNING_KEY_FILE'}，` +
          `本机也没有生成过签名密钥）。它能证明自己是**自洽**的（integrity 块 + .sha256），` +
          `但证明不了"离开主机之后没被换过"—— sidecar 与归档同目录，能换归档的人也能换 sidecar。` +
          `要让它可证明：POST /api/admin/backup/signing/key 生成一对（私钥落盘 0600、只回公钥），` +
          `或把已有的 ed25519 私钥配到 VANBLOG_BACKUP_SIGNING_KEY_FILE；` +
          `⚠️ 并把**公钥离线保存**（验签材料只存在本机时，拿到主机 root 的人可以连公钥一起换掉）。`,
    };
  } finally {
    rmrf(staging);
  }
}

/**
 * 导出过程中用的临时文件名（P2）。
 *
 * ⚠️ 名字**必须**同时躲开三个东西，否则半成品会被当成一份真归档：
 *  - 后台列表 `FULL_BACKUP_ARCHIVE_RE`（`^vanblog-full-.+\.tar\.(zst|xz|gz)$`）；
 *  - `scripts/vanblog.sh prune_old_backups` 的 glob `vanblog-full-*.tar.*`
 *    （`vanblog-full-X.tar.zst.partial` **仍然匹配** ⇒ 半成品会挤掉一份好归档的保留名额）；
 *  - `vanblog.sh` 找"最新归档"的 `ls -1t vanblog-full-*.tar.*`。
 * 前缀 `.vanblog-export-` 三条都躲开了（既不以 `vanblog-full-` 开头，又是隐藏文件），
 * 而结尾仍是 `.tar.zst`，所以 `detectFormat()` 认得它（排障时能手工解开看）。
 */
export const EXPORT_TEMP_PREFIX = '.vanblog-export-';
// ⚠️ `(\.enc)?`：加密归档的名字多一个后缀，临时名同样要能被认出来并清理掉，
//    否则加密备份失败留下的半成品永远不会被 `cleanupStaleExportTemps` 扫走。
export const EXPORT_TEMP_RE = /^\.vanblog-export-[A-Za-z0-9._-]+\.tar\.(zst|xz|gz)(\.enc)?$/;

export function exportTempName(ext: string): string {
  const suffix = ext.startsWith('.') ? ext : `.${ext}`;
  return `${EXPORT_TEMP_PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${suffix}`;
}

export function isExportTempName(name: string): boolean {
  return EXPORT_TEMP_RE.test(path.basename(String(name || '')));
}

/** 默认认为超过这个年龄的临时文件是上次崩溃留下的（一次导出实测 28s，1 小时已经极其宽松） */
export const STALE_EXPORT_TEMP_MS = 60 * 60 * 1000;

/**
 * 清掉备份目录里残留的导出临时文件（启动时由主实例调用）。
 * 只碰 `.vanblog-export-*`，并且**只删超过 maxAgeMs 的**：
 * 共享卷上可能正有另一个实例在导出，删掉别人正在写的文件是最坏的行为。
 * 返回删掉的文件名（供日志）。
 */
export function cleanupStaleExportTemps(
  backupDir: string,
  maxAgeMs: number = STALE_EXPORT_TEMP_MS,
  now: number = Date.now(),
): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(backupDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!isExportTempName(name)) {
      continue;
    }
    const full = path.join(backupDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) {
        continue;
      }
      if (now - stat.mtimeMs < maxAgeMs) {
        continue; // 可能正在被写，别动
      }
      fs.rmSync(full, { force: true });
      removed.push(name);
    } catch {
      // 删不掉就留着，下次启动再试；绝不影响启动
    }
  }
  return removed;
}

/**
 * 崩溃遗留的**工作目录**（不是导出临时文件）：
 *  - `<static>/tmp/full-backup-*`  —— 备份时的暂存树（未压缩的整库明文 + 图床硬链接）
 *  - `<static>/tmp/full-restore-*` —— 恢复时的解包树（**整个站点**：NDJSON 明文、图床、主题、自定义页面）
 *  - `<backupPath>/upload-tmp/restore-upload-*` —— 从后台上传的归档暂存（单个最大 8GB）
 *
 * 正常路径在 `finally` 里 `rmrf` 掉了；但进程被杀（OOM / 容器重启 / 恢复途中崩溃）时
 * `finally` 不执行，于是**整站明文机密**留在静态目录树里，而且每崩一次泄漏一份"整站大小"的磁盘。
 * 导出侧有清道夫（`cleanupStaleExportTemps`），恢复侧没有 —— 这个不对称是遗漏，不是设计。
 *
 * ⚠️ 匿名 HTTP 读不到它们（`utils/staticGuard` 把 `export`/`tmp`/`upload-tmp` 三段拦成 403），
 * 所以这不是直接泄露；但机密长期躺在静态树里、加上磁盘被吃掉，仍然必须清。
 */
export const STALE_WORK_DIR_PREFIXES = ['full-backup-', 'full-restore-'] as const;
export const STALE_UPLOAD_PREFIXES = ['restore-upload-'] as const;

/** 超过这个小时数的工作目录/上传暂存认定为崩溃遗留；0 = 关闭清理。 */
export const BACKUP_STALE_WORK_HOURS_ENV = 'VANBLOG_BACKUP_STALE_WORK_HOURS';
export const DEFAULT_BACKUP_STALE_WORK_HOURS = 6;

/**
 * 与 `resolveStaleWarnHours` 同一套语义：缺失/空串/非数字/负数 ⇒ 回落默认；**0 = 关**；
 * 上限夹到一年，免得写错一个数字变成"永不清理"或"每次都清"。
 */
export function resolveStaleWorkHours(
  raw: string | undefined = process.env[BACKUP_STALE_WORK_HOURS_ENV],
  fallback: number = DEFAULT_BACKUP_STALE_WORK_HOURS,
): number {
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(Math.floor(n), 24 * 365);
}

export interface StaleWorkEntry {
  path: string;
  name: string;
  bytes: number;
  /** 目录还是文件（上传暂存是文件） */
  kind: 'dir' | 'file';
}

export interface StaleWorkCleanupResult {
  removed: StaleWorkEntry[];
  bytes: number;
  /** 扫了多少个候选（含"太新所以没删"的），用来判断清理器有没有在跑 */
  scanned: number;
  /** 关掉了（maxAgeMs <= 0）时为 true，调用方据此不打无意义的日志 */
  disabled: boolean;
}

/**
 * 清掉崩溃遗留的工作目录与上传暂存（启动时由主实例调用）。
 *
 * ⚠️ 铁律与 `cleanupStaleExportTemps` 一致：**只删够旧的**。共享卷上可能正有另一个实例
 * 在备份/恢复，删掉别人正在写的目录是最坏的行为（那一次的归档或恢复会莫名其妙坏掉）。
 * 默认 6 小时：实测一次整站导出 28s、恢复分钟级，6 小时已经极其宽松。
 *
 * 任何一步失败都只跳过那一个条目，绝不抛给启动流程。
 */
export function cleanupStaleWorkDirs(options: {
  staticPath: string;
  backupDir: string;
  maxAgeMs?: number;
  now?: number;
}): StaleWorkCleanupResult {
  const maxAgeMs = options.maxAgeMs ?? resolveStaleWorkHours() * 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const result: StaleWorkCleanupResult = { removed: [], bytes: 0, scanned: 0, disabled: false };
  if (!(maxAgeMs > 0)) {
    result.disabled = true;
    return result;
  }

  const targets: { dir: string; prefixes: readonly string[]; kind: 'dir' | 'file' | 'any' }[] = [
    { dir: path.join(options.staticPath || '', 'tmp'), prefixes: STALE_WORK_DIR_PREFIXES, kind: 'dir' },
    {
      dir: path.join(options.backupDir || '', 'upload-tmp'),
      prefixes: STALE_UPLOAD_PREFIXES,
      kind: 'file',
    },
  ];

  for (const target of targets) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(target.dir);
    } catch {
      continue; // 目录不存在（全新部署）就读不到，正常
    }
    for (const name of names) {
      if (!target.prefixes.some((prefix) => name.startsWith(prefix))) {
        continue;
      }
      const full = path.join(target.dir, name);
      try {
        const stat = fs.statSync(full);
        const isDir = stat.isDirectory();
        if (target.kind === 'dir' && !isDir) {
          continue; // 同名文件不是我们造的，别碰
        }
        if (target.kind === 'file' && isDir) {
          continue;
        }
        result.scanned += 1;
        // ⚠️ 用 mtime 判年龄：正在被写的那一份 mtime 一定是新的
        if (now - stat.mtimeMs < maxAgeMs) {
          continue;
        }
        const bytes = isDir ? treeStats(full).bytes : stat.size;
        fs.rmSync(full, { recursive: true, force: true });
        result.removed.push({ path: full, name, bytes, kind: isDir ? 'dir' : 'file' });
        result.bytes += bytes;
      } catch {
        // 删不掉就留着，下次启动再试；绝不影响启动
      }
    }
  }
  return result;
}

function rmTemp(tempPath: string) {
  try {
    fs.rmSync(tempPath, { force: true });
  } catch {
    // ignore
  }
}

/** `VANBLOG_BACKUP_INTEGRITY=off` 是逃生舱（默认开：这正是本轮要加的防损坏能力）。 */
export const BACKUP_INTEGRITY_ENV = 'VANBLOG_BACKUP_INTEGRITY';

export function integrityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env[BACKUP_INTEGRITY_ENV] ?? '').trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !(raw === 'off' || raw === 'false' || raw === '0' || raw === 'no');
}

/**
 * 清单里 `integrity.zstdFrameChecksum` 的**声明值**（打包前就要写进清单）。
 * zstd 的 spec 里显式带了 `--check`；xz 默认 CRC64、gzip 的 CRC32 是格式强制的。
 * ⚠️ 声明完还要实测：打包后 `probeCompressorChecksum()` 会读归档头部比对，
 * 不一致就删掉半成品并判失败（"pinned, not assumed"）。
 */
export function declaredFrameChecksum(spec: CompressorSpec): boolean {
  if (spec.format === 'zstd') {
    return spec.compress.includes('--check');
  }
  return true;
}

export interface BackupListEntry {
  name: string;
  path: string;
  bytes: number;
  sizeText: string;
  format: BackupFormat | null;
  createdAt: string | null;
  manifest?: FullBackupManifest | null;
}

/** 整站备份归档本体的文件名（不含 .manifest.json / .sha256 之类的 sidecar） */
// ⚠️ `(\.enc)?`：加密归档必须仍然出现在后台的备份列表里。
// 顺带说明为什么用"加后缀"而不是"同名不同内容"：`vanblog.sh verify` 会对归档跑
// `zstd -t`，一个叫 `.tar.zst` 却是密文的文件会得到一条完全无法理解的报错；
// 而 `.enc` 后缀让 `ls`、脚本、以及运维一眼就知道"这份要口令"。
// （`vanblog.sh` 的 glob 是 `vanblog-full-*.tar.*`，`.enc` 仍然匹配 ⇒ 保留策略与
//   "找最新归档"都不受影响；只有 `verify` 那条需要脚本侧配合，已在汇报里列出。）
export const FULL_BACKUP_ARCHIVE_RE = /^vanblog-full-.+\.tar\.(zst|xz|gz)(\.enc)?$/;

/** 列出已有的整站备份（读 sidecar，不解压）。 */
export function listFullBackups(backupDir: string): BackupListEntry[] {
  const dir = backupDir;
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    // ⚠️ 只认归档本体，别用"排除已知 sidecar"的写法：sidecar 会越来越多
    // （.manifest.json 是清单，.sha256 是 vanblog.sh 写的校验和），
    // 少排除一个就会在后台「备份恢复」列表里多出一条假归档
    // （格式认不出来，点恢复只会得到"无法识别压缩格式"）。
    .filter((name) => FULL_BACKUP_ARCHIVE_RE.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      let manifest: FullBackupManifest | null = null;
      const sidecar = `${full}.manifest.json`;
      if (fs.existsSync(sidecar)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
          manifest = isFullBackupManifest(parsed) ? parsed : null;
        } catch {
          manifest = null;
        }
      }
      return {
        name,
        path: full,
        bytes: stat.size,
        sizeText: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
        format: detectFormat(full),
        createdAt: manifest?.createdAt || stat.mtime.toISOString(),
        manifest,
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 读归档里的 manifest（优先 sidecar，否则只解出这一个文件）。 */
export async function inspectFullBackup(
  archivePath: string,
  staticPath?: string,
  /** 加密归档在"sidecar 清单也丢了"时需要口令才能解出内层清单；明文归档用不到 */
  passphrase?: string | null,
): Promise<FullBackupManifest | null> {
  const sidecar = `${archivePath}.manifest.json`;
  if (fs.existsSync(sidecar)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      if (isFullBackupManifest(parsed)) {
        return parsed;
      }
    } catch {
      // 落到解包读取
    }
  }
  const format = detectFormat(archivePath);
  if (!format) {
    return null;
  }
  const spec = specFor(format);
  if (!spec) {
    return null;
  }
  // ⚠️ 加密归档走到这里也能读：sidecar 清单是**明文**的（上面已经先试过），
  // 只有 sidecar 丢了才需要从密文里解出内层清单，那时需要口令（env 或显式传入）。
  const raw = await extractSingleFile(archivePath, './manifest.json', spec, passphrase);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return isFullBackupManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 列出归档里的成员名（只解到 `tar -t`，**不落盘**）。
 *
 * 为什么需要它：`POST /api/admin/init/restore` 是**匿名可达**的（只在站点未初始化时开放），
 * 而恢复会把归档解包到工作目录。GNU tar 默认会拒绝含 `..` 的成员
 * （`Member name contains '..'`，退出码 2 ⇒ `decompressUntar` 会失败），
 * 但容器里跑的是 **busybox tar**，行为不能靠猜 —— 所以在解包之前自己把成员名过一遍，
 * 不依赖 tar 的具体实现。
 */
export async function listArchiveMembers(
  archivePath: string,
  passphrase?: string | null,
): Promise<string[]> {
  const format = detectFormat(archivePath);
  if (!format) {
    throw new BadRequestException('无法识别备份文件的压缩格式（支持 .tar.zst / .tar.xz / .tar.gz）');
  }
  const spec = specFor(format);
  if (!spec) {
    throw new BadRequestException(`本机没有 ${format} 解压工具，无法检查这个备份`);
  }
  let upstreamError: string | null = null;
  // ⚠️ 同 decompressUntar：await 必须在 new Promise 之外，否则 executor 里的
  // rejection 会被吞掉（调用方永远等不到结果）。
  const { child: decompressor } = await spawnArchiveDecompressor(
    archivePath,
    spec,
    (message) => {
      upstreamError = message;
    },
    passphrase,
  );
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-tf', '-']);
    let out = '';
    let decErr = '';
    let tarErr = '';
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      for (const child of [decompressor, tar]) {
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程可能已经没了
        }
      }
      reject(new BadRequestException(message));
    };
    tar.stdin.on('error', (err: Error) => fail(`读取归档失败：${err.message}`));
    decompressor.stderr.on('data', (c) => {
      decErr += c.toString();
    });
    tar.stderr.on('data', (c) => {
      tarErr += c.toString();
    });
    decompressor.stdout.pipe(tar.stdin);
    tar.stdout.on('data', (c) => {
      out += c.toString();
    });
    decompressor.on('error', () => fail(`解压器起不来（${spec.decompress[0]}）`));
    tar.on('error', (err: Error) => fail(`tar 起不来：${err.message}`));
    tar.on('close', (code) => {
      if (settled) return;
      if (upstreamError) {
        fail(`解密失败：${upstreamError}`);
        return;
      }
      if (code !== 0) {
        // ⚠️ 以前的写法是先 `settled = true` 再调 fail() —— 而 fail() 的第一行就是
        // `if (settled) return`，于是**截断/损坏的归档会让这个 promise 永远不 settle**
        // （tar 退出码非 0 → fail 变 no-op → 两个子进程都死了 → 事件循环排空 → 进程静默退出）。
        // 实测：69MB 真 zstd 归档砍掉 1MB 后必现。它同时挂住 verifyFullBackup（P2）与
        // assertRestorableArchive（两条恢复路由；匿名 init/restore 还会因此**永久占着单飞锁**）。
        // fail() 自己会落 settled 标志，这里绝不能提前置位。
        fail(`读不出归档成员表（tar 退出码 ${code}）：${(tarErr || decErr).slice(0, 300)}`);
        return;
      }
      settled = true;
      resolve(
        out
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
    });
    decompressor.on('close', (code) => {
      if (code !== 0) {
        fail(`解压失败（退出码 ${code}）：${decErr.slice(0, 300)}`);
      }
    });
  });
}

/**
 * 找出会写到解包目录**之外**的成员名：绝对路径（含 Windows 盘号）或任何一段是 `..`。
 * 全都安全时返回 null。
 */
export function findUnsafeArchiveMember(members: string[]): string | null {
  for (const raw of members || []) {
    const name = String(raw);
    if (!name) continue;
    if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
      return name;
    }
    if (name.split(/[\\/]/).some((seg) => seg === '..')) {
      return name;
    }
  }
  return null;
}

/** 恢复解包前的"成员总字节"上限（环境变量名；见 restoreMaxTotalBytes） */
export const RESTORE_MAX_TOTAL_BYTES_ENV = 'VANBLOG_RESTORE_MAX_TOTAL_BYTES';
/**
 * 默认上限 100 GiB。
 *
 * 为什么需要一个上限：匿名的 `POST /api/admin/init/restore` 允许上传 **8GB** 归档
 * （`utils/restoreUpload.ts` 的 multer limits），而 `decompressUntar` 是
 * `解压器 | tar -xf - -C staging`，**没有任何体积上限**。于是一个几 MB 的 zstd 炸弹
 * （成员头里声明巨大的 size，或高压缩比的重复内容）就能把磁盘写满 —— mongo 与日志一起死，
 * 而且是匿名、限流只有 5 次/10 分钟/IP 就能做到的。
 * 100 GiB 对真实站点足够宽（图床几十万张也就这个量级），又能在**解包之前**拦掉炸弹。
 */
const RESTORE_MAX_TOTAL_BYTES_DEFAULT = 100 * 1024 * 1024 * 1024;
const RESTORE_MAX_TOTAL_BYTES_MIN = 1024 * 1024; // 1 MiB：再小就没法恢复任何真实归档了
const RESTORE_MAX_TOTAL_BYTES_LIMIT = 1024 * 1024 * 1024 * 1024; // 1 TiB 天花板

/**
 * 读 `VANBLOG_RESTORE_MAX_TOTAL_BYTES`（字节数）。
 * 语义与 `utils/envNumber.ts` 一致：缺失 / 空串 / 非数字 / ≤0 ⇒ 回落默认，
 * 合法值夹到 `[1 MiB, 1 TiB]` 再向下取整 —— **绝不因为写错而变成"不限制"**。
 */
export function restoreMaxTotalBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env[RESTORE_MAX_TOTAL_BYTES_ENV] ?? '').trim();
  if (!raw) {
    return RESTORE_MAX_TOTAL_BYTES_DEFAULT;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return RESTORE_MAX_TOTAL_BYTES_DEFAULT;
  }
  return Math.min(Math.max(Math.floor(n), RESTORE_MAX_TOTAL_BYTES_MIN), RESTORE_MAX_TOTAL_BYTES_LIMIT);
}

/**
 * 目录所在卷的**剩余字节**；读不到就返回 null（**不猜、不当成 0**）。
 *
 * ⚠️ null 与 0 必须分开：返回 0 会让所有恢复都失败（平台没有 `statfsSync`、
 * 或目录权限读不到时），而那与"磁盘真的满了"是两件事。读不到就跳过这道闸门，
 * 由成员总字节上限兜底。
 */
export function freeSpaceBytes(dir: string): number | null {
  try {
    // Node 18.15+ 的 statfsSync；容器与本机都是 Node 24
    const stats = (fs as any).statfsSync?.(dir);
    if (!stats || typeof stats.bavail !== 'number' || typeof stats.bsize !== 'number') {
      return null;
    }
    const bytes = stats.bavail * stats.bsize;
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * 解包要预留的余量：256 MiB。
 * 理由是"刚好装满"本身就是故障：日志、恢复 journal、mongo 的 journal、以及文件系统
 * 自己的元数据都要地方；把盘写到 100% 的恢复即使"成功"也会让站点起不来。
 */
const RESTORE_FREE_SPACE_RESERVE_BYTES = 256 * 1024 * 1024;

/**
 * 剩余空间够不够的**纯判定**（不碰 fs，所以边界能直接单测）。
 *
 * @param totalBytes 归档成员 size 之和（= 解包后要写的字节数）
 * @param freeBytes  目标卷剩余字节；**null = 读不到**
 * @returns 不够时返回可直接抛给用户的错误消息；够、或读不到剩余空间时返回 null
 *
 * ⚠️ `freeBytes === null` 必须返回 null（跳过这道闸门）而不是拒绝：读不到剩余空间是
 * 平台/权限差异，不是"磁盘满了"。把它当 0 会让**所有**恢复都失败。
 * 体积上限那道闸门与此无关，始终生效。
 */
export function restoreSpaceShortfallMessage(
  totalBytes: number,
  freeBytes: number | null,
  targetDir: string,
): string | null {
  if (freeBytes === null || !Number.isFinite(freeBytes)) {
    return null;
  }
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const need = total + RESTORE_FREE_SPACE_RESERVE_BYTES;
  if (freeBytes >= need) {
    return null;
  }
  return (
    `磁盘空间不够，已拒绝恢复（没有解包、没有写盘）：解包需要约 ${formatBytes(total)}` +
    `（另留 ${formatBytes(RESTORE_FREE_SPACE_RESERVE_BYTES)} 余量，合计 ${formatBytes(need)}），` +
    `而 ${targetDir} 所在卷只剩 ${formatBytes(freeBytes)}。` +
    `清出空间后再试；或给恢复指定一个更大的工作目录（编排里的静态目录 / ` +
    `VAN_BLOG_STATIC_PATH，恢复的临时解包就在它下面的 tmp/）`
  );
}

export interface RestorableArchiveOptions {
  /**
   * 解包目标目录（staging）。给了就多做一道"剩余空间够不够"的闸门；
   * 不给（例如初始化页那次**重复**的前置检查，那时还没有 staging）就只做成员总字节上限。
   */
  targetDir?: string;
  /**
   * 加密归档的口令。留空 ⇒ 按 env 解析（`VANBLOG_BACKUP_PASSPHRASE` / `..._FILE`）。
   * ⚠️ 从 HTTP 请求来时**只能**走 body，不能走 query：query 会原样进 caddy 的访问日志。
   */
  passphrase?: string | null;
  /**
   * 显式跳过签名校验。⚠️ 调用方必须**只认字面 true**（用 `utils/isTrue.ts`，与破坏性恢复的
   * `confirm` 闸门同一口径 —— `"1"`/`"yes"`/`"TRUE"` 都不算），并且跳过时打一条 WARN 记明跳过了什么。
   */
  skipSignatureCheck?: boolean;
  /**
   * 备份目录（用来找 `signing/` 下生成的密钥对）。不给就只按 env 解析验签公钥。
   */
  backupDir?: string | null;
}

/**
 * 恢复前的归档检查：不安全就抛 400，**此时还没有写任何东西**。
 * 返回成员条数（调用方可以拿去打日志）。
 *
 * 三道闸门，全部在解包之前：
 *  1. 成员名/类型（绝对路径、`..`、符号链接）—— 见 `findUnsafeArchiveEntry`；
 *  2. 成员 `size` 之和不超过 `restoreMaxTotalBytes()`（防压缩炸弹写满磁盘）；
 *  3. 目标卷剩余空间够（`total + 256 MiB` 余量）—— 读不到剩余空间就跳过这一道。
 */
/**
 * `assertRestorableArchive` 最近一次的签名降级提示（没验签/跳过验签时非 null）。
 *
 * ⚠️ 为什么用这种看起来不优雅的方式：`assertRestorableArchive` 的返回值是"成员条数"，
 * 两条恢复路由与 8 个既有 spec 都依赖这个数字，改返回形状会把一次纯增量功能变成破坏性变更。
 * 所以把"顺带的诊断信息"挂在一个显式槽里，并且**每次进入函数就先清空**（否则上一次恢复的
 * 提示会被下一次读到 —— 那种串味比没有更糟）。单进程内 `assertRestorableArchive` 由
 * init/restore 的 DB 级 TTL 锁互斥（同一时刻只有一次恢复），所以这个槽不会被并发覆盖。
 */
let restoreSignatureWarning: string | null = null;

/** 取走并清空最近一次恢复的签名降级提示（调用方在响应里带上它）。 */
export function takeRestoreSignatureWarning(): string | null {
  const value = restoreSignatureWarning;
  restoreSignatureWarning = null;
  return value;
}

export async function assertRestorableArchive(
  archivePath: string,
  options: RestorableArchiveOptions = {},
): Promise<number> {
  // 签名校验的降级提示（没验/跳过时非 null）。⚠️ 用模块级以外的方式带出去：
  //    返回值是"成员条数"这个既有契约（两个调用方都依赖它），不能改形状，
  //    所以挂在一个可被 `takeRestoreSignatureWarning()` 取走的槽里。
  restoreSignatureWarning = null;
  // 0) **签名闸门**，排在所有解包动作之前：一份验不过签名的归档，连它的成员表都不该去读。
  //    ⚠️ 只在"配了验签公钥 **且** 归档有 .sig"时才真去算整档 sha256（那是一次完整顺序读）；
  //    没配公钥或没签名时**一个字节都不多读**，所以既有部署的恢复速度完全不受影响。
  //    ⚠️ 也绝不能变成"没配公钥就拒绝恢复"：那会让所有升级上来的站点在灾难现场发现恢复不了。
  const sigPath = signatureSidecarPath(archivePath);
  const verifyKey = resolveVerifyKey(options.backupDir);
  if (fs.existsSync(sigPath) || verifyKey) {
    let actualSha256 = '';
    if (fs.existsSync(sigPath) && verifyKey && options.skipSignatureCheck !== true) {
      try {
        actualSha256 = (await hashFile(archivePath)).sha256;
      } catch (err) {
        throw new BadRequestException(
          `为验签回读归档算 sha256 失败（${archivePath}）：${(err as Error)?.message || err}` +
            ` —— 已拒绝恢复（验不了签名就不解包）`,
        );
      }
    }
    // ⚠️ 这里不再自己打日志：`assertArchiveSignatureForRestore` 内部已经用 BackupSigning
    //    这个 logger 打过 WARN 了（跳过验签、没配公钥、有 .sig 但没公钥三种情况各一条），
    //    在这里再打一遍会产生两条措辞可能漂移的重复日志。
    //    `gate.warning` 仍然返回给调用方，供恢复接口的响应体带上（站长要在**响应里**看到，
    //    而不只是去翻容器日志 —— 灾难现场他未必看得见日志）。
    const gate = assertArchiveSignatureForRestore({
      archivePath,
      actualSha256,
      verifyKey,
      skip: options.skipSignatureCheck === true,
    });
    restoreSignatureWarning = gate.warning;
  }
  const { entries, decompressError } = await listArchiveEntries(archivePath, {
    passphrase: options.passphrase,
  });
  if (decompressError) {
    // 归档解压都过不去（截断/位翻转）：这时"成员表"是不完整的，绝不能当成"检查通过"
    throw new BadRequestException(`读不出归档成员表：${decompressError}`);
  }
  const unsafe = findUnsafeArchiveEntry(entries);
  if (unsafe) {
    throw new BadRequestException(
      `备份归档里有会写到解包目录之外的成员（${unsafe.name}：${unsafe.reason}），已拒绝恢复`,
    );
  }
  // 成员 size 取自 tar 头部（`utils/backupTarStream.ts` 的 TarEntryInfo.size），
  // 所以这一步**不需要解包**就能知道要写多少字节。目录/软链/硬链的 size 是 0，天然不计。
  const totalBytes = entries.reduce(
    (sum, e) => sum + (Number.isFinite(e.size) && e.size > 0 ? e.size : 0),
    0,
  );
  const cap = restoreMaxTotalBytes();
  if (totalBytes > cap) {
    throw new BadRequestException(
      `备份归档解包后有 ${formatBytes(totalBytes)}（${entries.length} 个成员），` +
        `超过允许的 ${formatBytes(cap)}，已拒绝恢复（没有解包、没有写盘）。` +
        `这通常说明它不是本功能导出的整站备份，或是一个压缩炸弹。` +
        `确有大站要恢复：给 server 设 ${RESTORE_MAX_TOTAL_BYTES_ENV}=<字节数> 放宽上限，` +
        `并先确认磁盘够（当前需要约 ${formatBytes(totalBytes)}）`,
    );
  }
  const targetDir = String(options.targetDir ?? '').trim();
  if (targetDir) {
    // 判定抽成了纯函数 `restoreSpaceShortfallMessage`，所以"刚好够 / 差一个字节 / 读不到"
    // 这三种边界能直接单测（`fs.statfsSync` 在 jest 里不可重定义，没法 mock 出剩余空间）
    const shortfall = restoreSpaceShortfallMessage(totalBytes, freeSpaceBytes(targetDir), targetDir);
    if (shortfall) {
      throw new BadRequestException(shortfall);
    }
  }
  return entries.length;
}

/**
 * 找出**不能安全解包**的成员（安全守卫，两条恢复路由都在写盘之前调它）。
 *
 * 检查两类东西：
 *  1. **成员名**：绝对路径（含 Windows 盘号）或任何一段是 `..` —— 会写到解包目录之外；
 *  2. **成员类型**（这一条是后补的，见下）：符号链接一律拒绝，硬链接只在"目标名不安全"时拒绝。
 *
 * 为什么类型也要查：`tar -xf` 会**原样还原符号链接**，而恢复的第二步是
 * `fs.cpSync(staging/static/<folder>, staticPath/<folder>, {dereference:false})` ——
 * 于是归档里的软链会被搬进 `img/file/customPage/themes`，而 `serve-static`/`send`
 * 是**跟随**软链的、caddy 更是直发 `/static/img/*.webp`。一份来路不明的归档因此能种下
 * "指向 /etc/passwd 的 `x.webp`"，变成**匿名可达的任意文件读**（`POST /api/admin/init/restore`
 * 匿名可达；已初始化站点恢复别人给的归档同理）。
 * 任何上传接口都造不出软链（都是 `fs.writeFileSync`），所以恢复是唯一的种植路径。
 *
 * ⚠️ 这段以前还把「`customPage.controller` 的 `res.sendFile` 没有 `root` 限制」当成论据之一 ——
 * **那条论据是过时的**，已删：它传进去的 `absPath` 早已被 `resolveCustomPageAbs`
 * （`utils/customPagePath.ts` 的 `path.resolve` + `path.relative` 前缀判据）容器化校验过。
 * 结论没变、但理由必须说对：**软链能绕过字面路径校验** —— 校验通过的是"链接本身的路径"，
 * 而 `sendFile` 跟着链接读到的是目录外的目标。所以防线只能落在"解包阶段就不创建软链"这一层，
 * 不能指望下游任何路径检查。（留着这条更正，免得下一个人又拿旧论据推新结论。）
 *
 * ⚠️ **硬链接为什么不是一律拒绝**（与最初"两个都拒"的建议有意分歧，理由实测过）：
 * GNU tar 与 busybox tar **都会**把"同 inode 的第二个名字"写成硬链接成员
 * （`hrw-rw-r-- … link to ./x`）—— 也就是只要静态目录里有两份内容相同的图片被去重工具
 * （jdupes/rdfind）硬链到一起，我们自己导出的归档里就有硬链接成员。一律拒绝等于
 * "这种站点自己的备份永远恢复不了"。而硬链接的目标名只能是**归档内部**的另一个成员
 * （解包后落在解包目录里），只要目标名本身安全，它就没有逃逸能力 ——
 * 何况符号链接已经一律拒绝，解包目录里不可能先有一个软链让它去指。
 */
export function findUnsafeArchiveEntry(
  entries: Array<{ name: string; kind: string; linkTarget: string | null }>,
): { name: string; reason: string } | null {
  for (const entry of entries || []) {
    const name = String(entry?.name || '');
    if (!name) {
      continue;
    }
    const nameProblem = unsafeNameReason(name);
    if (nameProblem) {
      return { name, reason: nameProblem };
    }
    if (entry.kind === 'symlink') {
      return {
        name,
        reason: `符号链接成员（目标 ${entry.linkTarget || '?'}）：解包后会被拷进静态目录并被 web 层跟随，等于匿名任意文件读`,
      };
    }
    if (entry.kind === 'hardlink') {
      const target = String(entry.linkTarget || '');
      const targetProblem = target
        ? unsafeNameReason(target)
        : '硬链接成员没有目标名';
      if (targetProblem) {
        return { name, reason: `硬链接成员的目标不安全（${target || '(空)'}：${targetProblem}）` };
      }
    }
  }
  return null;
}

/** 名字层面的不安全原因：绝对路径（含盘号）或任何一段是 `..`；安全时返回 null */
function unsafeNameReason(name: string): string | null {
  if (name.startsWith('/')) {
    return '绝对路径';
  }
  if (/^[A-Za-z]:[\\/]/.test(name)) {
    return 'Windows 绝对路径';
  }
  if (name.split(/[\\/]/).some((seg) => seg === '..')) {
    return '含 .. 段';
  }
  return null;
}

export interface RestoreFullBackupOptions {
  client: MongoClient;
  staticPath: string;
  archivePath: string;
  workDir?: string;
  /** 是否同时恢复静态文件（关掉就只恢复数据库） */
  withStatic?: boolean;
  /**
   * 目标实例的身份（P3）：用来发现"归档来自另一套配置"的静默错配。
   * 最有价值的是 `walineDB` —— 它来自机器本地的 `config.yaml`，**不在**归档里，
   * 两边不同时 waline 那两张表会被写进一个本实例根本不读的库（评论"消失"且零报错）。
   */
  target?: {
    walineDB?: string;
    demo?: boolean;
    codeVersion?: string;
  };
  /**
   * 恢复成功后是否把静态目录**修剪**成与归档一致（P3）。
   * 留空 = 读 `VANBLOG_RESTORE_PRUNE_STATIC`（**默认开**：owner 要的是 100% 保真）。
   */
  pruneStatic?: boolean;
  /**
   * 归档里没有、目标库里却有的集合是否**删掉**（P3）。
   * 留空 = 读 `VANBLOG_RESTORE_DROP_ABSENT_COLLECTIONS`（**默认关**：
   * 删一张归档从来没装过的表比留着它更可怕；默认只报告不删）。
   */
  dropAbsentCollections?: boolean;
  /** 恢复日志（P5）路径；留空则不写 */
  journalPath?: string;
  /** caddy 数据目录（P6，`VANBLOG_BACKUP_INCLUDE_CADDY`）；留空 = 不恢复归档里的 `./caddy` 段 */
  caddyDataPath?: string;
  /**
   * 加密归档的口令。留空 ⇒ 按 env 解析；明文归档完全不看这个字段。
   *
   * ⚠️ 语义要说清：`null` 与 `undefined` 在这里**等价**（都回落到 env），
   * 因为恢复一份加密归档而没有口令是**没法工作**的，不存在"明确要求不加密"这种场景
   * （与 `CreateFullBackupOptions.passphrase` 不同，那边 `null` 表示"强制明文导出"）。
   */
  passphrase?: string | null;
  /**
   * 显式跳过签名校验（透传给 `assertRestorableArchive` 的第 0 道闸门）。
   * ⚠️ 调用方必须**只认字面 true**（`utils/isTrue.ts`，与破坏性恢复的 `confirm` 闸门同一口径），
   * 跳过时 `assertArchiveSignatureForRestore` 会打一条 WARN 说明跳过了什么。默认 false。
   */
  skipSignatureCheck?: boolean;
  /**
   * 备份目录：用来找 `signing/` 下由 `POST /api/admin/backup/signing/key` 生成的密钥对。
   * 不给就只按 env 解析验签公钥（那样"生成过密钥但没配 env"的部署会一直显示"没有配验签公钥"）。
   */
  backupDir?: string | null;
  logger?: BackupLogger;
}

export interface RestoreResult {
  manifest: FullBackupManifest;
  databases: Record<string, { collections: number; documents: number }>;
  static: Record<string, { files: number }>;
  ms: number;
  notes: string[];
  /** P3：静态目录按归档修剪的结果（每个被修剪的目录一条） */
  pruned: StaticPruneReport[];
  /** P3：目标库里有、归档里没有的集合（混合状态的可见化） */
  absentCollections: AbsentCollection[];
  /** P6：归档里 `./caddy` 段的恢复结果；没有这一段时为 null */
  caddy: { files: number; bytes: number; target: string } | null;
}

/** 目标库里存在、归档里不存在的一张表（P3） */
export interface AbsentCollection {
  db: string;
  collection: string;
  /** 这张表里的文档数（决定"要不要真的删"时最重要的一个数字） */
  documents: number;
  /** 是否已被删掉（只有 `VANBLOG_RESTORE_DROP_ABSENT_COLLECTIONS` 打开时才会是 true） */
  dropped: boolean;
}

/** P3：静态目录修剪开关（默认**开** —— owner 要的是 100% 保真，不是并集） */
export const RESTORE_PRUNE_STATIC_ENV = 'VANBLOG_RESTORE_PRUNE_STATIC';
/** P3：删掉"归档里没有的集合"开关（默认**关** —— 这是更吓人的那一侧操作） */
export const RESTORE_DROP_ABSENT_ENV = 'VANBLOG_RESTORE_DROP_ABSENT_COLLECTIONS';
/** P6：把 caddy 的 TLS 材料一起打包（默认**关** —— 见 createFullBackup 里的说明） */
export const BACKUP_INCLUDE_CADDY_ENV = 'VANBLOG_BACKUP_INCLUDE_CADDY';

export function restorePruneStaticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool(RESTORE_PRUNE_STATIC_ENV, true, env);
}

export function restoreDropAbsentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool(RESTORE_DROP_ABSENT_ENV, false, env);
}

export function backupIncludeCaddyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool(BACKUP_INCLUDE_CADDY_ENV, false, env);
}

/** 系统集合与恢复用的临时集合：任何"删表"逻辑都绝不允许碰它们 */
export function isProtectedCollectionName(name: string): boolean {
  const n = String(name || '');
  if (!n) return true;
  if (n.startsWith('system.')) return true;
  if (n.endsWith(RESTORE_SUFFIX)) return true;
  return false;
}

async function* readLines(file: string) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) {
      yield line;
    }
  }
}

async function restoreCollection(
  db: Db,
  name: string,
  ndjsonPath: string,
  indexPath: string,
): Promise<number> {
  const tmpName = `${name}${RESTORE_SUFFIX}`;
  const tmp = db.collection(tmpName);
  await tmp.deleteMany({});
  let inserted = 0;
  try {
    let batch: any[] = [];
    for await (const line of readLines(ndjsonPath)) {
      batch.push(decodeDoc(JSON.parse(line)));
      if (batch.length >= INSERT_BATCH) {
        await tmp.insertMany(batch, { ordered: false });
        inserted += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await tmp.insertMany(batch, { ordered: false });
      inserted += batch.length;
    }
    if (!inserted) {
      // 空集合（备份里 drafts / custompages / pipelines 常常是空的）：
      // 没有 insertMany 就不会创建临时集合，rename 会抛
      // "Source collection … does not exist"，于是**前面已经换好的集合留下、后面的原样不动**，
      // 变成一个看不出原因的半恢复状态。这里显式建表。
      try {
        await db.createCollection(tmpName);
      } catch {
        // 已存在就忽略
      }
    }
    // 原子替换目标集合：成功了才动原表，中途失败原数据还在
    await tmp.rename(name, { dropTarget: true });
  } catch (error) {
    // 失败要把临时表清掉，否则残留的 *__vanblog_restore 会污染下一次恢复/备份
    try {
      await tmp.drop();
    } catch {
      // 本来就不存在
    }
    throw new BadRequestException(
      `恢复集合 ${name} 失败：${(error as Error)?.message || error}`,
    );
  }

  if (fs.existsSync(indexPath)) {
    try {
      const indexes: any[] = JSON.parse(fs.readFileSync(indexPath, 'utf8')).map((item: any) =>
        decodeDoc(item),
      );
      const target = db.collection(name);
      for (const index of indexes) {
        if (!index?.key || index.name === '_id_') {
          continue;
        }
        const options: any = { ...index };
        delete options.key;
        delete options.v;
        try {
          await target.createIndex(index.key, options);
        } catch {
          // 某个索引建不起来不阻断恢复（例如版本差异）
        }
      }
    } catch {
      // 索引文件坏了也不阻断
    }
  }
  return inserted;
}

/**
 * 从整站备份恢复：数据库逐集合原子替换 + 静态文件按归档**替换**（不是合并）回原目录。
 *
 * P3（100% 保真）在这里补了三件事，每件都带明确的可见化：
 *  - **静态目录修剪**：拷贝成功之后，把归档里没有的文件删掉（`VANBLOG_RESTORE_PRUNE_STATIC`，
 *    默认**开**）。顺序是铁律：先拷完所有目录、全部成功，才开始删；一次失败的恢复不删任何东西。
 *  - **归档里没有的集合**：目标库里有、归档里没有的表 = 混合状态，报告出来
 *    （名字 + 文档数）；`VANBLOG_RESTORE_DROP_ABSENT_COLLECTIONS` 打开才真的删（默认**关**）。
 *  - **source 错配**：`walineDB` / `demo` 与目标实例不一致时在 notes 里 WARN 点名两个值
 *    （waline 库名不同 = 评论被写进一个本实例不读的库，界面上一切正常）。
 *
 * P5：整个过程写 `restore-journal.json`（每换完一张表落一次），成功删掉、失败留下，
 * 于是"恢复被打断"这件事在启动日志与 `backup-status.json` 里都看得见。
 */
export async function restoreFullBackup(
  options: RestoreFullBackupOptions,
): Promise<RestoreResult> {
  const logger = options.logger || silentLogger;
  const started = Date.now();
  const archivePath = options.archivePath;
  if (!fs.existsSync(archivePath)) {
    throw new BadRequestException(`备份文件不存在：${archivePath}`);
  }
  const format = detectFormat(archivePath);
  if (!format) {
    throw new BadRequestException('无法识别备份文件的压缩格式（支持 .tar.zst / .tar.xz / .tar.gz）');
  }
  const spec = specFor(format);
  if (!spec) {
    throw new BadRequestException(
      `本机没有 ${format} 解压工具，装一个再试（或在有该工具的机器上导出成 gzip 格式）`,
    );
  }
  const pruneEnabled = options.pruneStatic ?? restorePruneStaticEnabled();
  const dropAbsent = options.dropAbsentCollections ?? restoreDropAbsentEnabled();
  // 0700：这个目录下面就是**解包后的整站**（明文 NDJSON、含口令哈希与 jwt 密钥）。
  const workRoot = ensureSecretDir(options.workDir || path.join(options.staticPath, 'tmp'), SECRET_DIR_MODE);
  const staging = fs.mkdtempSync(path.join(workRoot, 'full-restore-'));
  const notes: string[] = [];
  const pruned: StaticPruneReport[] = [];
  const absentCollections: AbsentCollection[] = [];
  let caddyResult: RestoreResult['caddy'] = null;
  const journal = RestoreJournalWriter.open(
    options.journalPath || '',
    { archivePath },
    (message) => logger.warn(message),
  );

  try {
    journal?.setPhase('unpack');
    // ⚠️ **解包之前**先过一遍成员安全检查（名字 + 类型）。
    // 以前只有匿名的 `POST /api/admin/init/restore` 在控制器里调了 `assertRestorableArchive`，
    // 而后台那条 `POST /api/admin/backup/full/restore`（已初始化站点用的就是它，
    // 也正是"恢复一份来路不明的归档"这个场景）**直接进了解包**：
    // 归档里的符号链接会被 `tar -xf` 原样解出，再被 `cpSync(dereference:false)`
    // 搬进静态目录，然后被 web 层跟随 ⇒ 匿名任意文件读。
    // 放在这里两条路由自动一致；init 路由那一次是重复检查（多约 0.2s，值得）。
    // 另外这一遍也是"staging 里不可能出现符号链接"的保证：后面读 manifest.json /
    // 拷静态文件时，路径就不会被一个种进来的软链牵着走到解包目录外面去。
    // ⚠️ 传 staging 是为了顺带做**体积/剩余空间**闸门：解包（`解压器 | tar -xf -`）本身
    //    没有任何上限，而匿名的 init/restore 允许上传 8GB，所以一个压缩炸弹就能把盘写满。
    //    闸门必须在 `decompressUntar` 之前，也就是这里。
    const memberCount = await assertRestorableArchive(archivePath, {
      targetDir: staging,
      passphrase: options.passphrase,
    });
    logger.log(`归档成员检查通过（${memberCount} 个成员，无绝对路径 / .. / 符号链接）`);
    try {
      logger.log(`解包中（${spec.label}）...`);
      await decompressUntar(archivePath, staging, spec, options.passphrase);
    } catch (err) {
      // 下载不完整 / 文件被截断 / 用别的工具改过名，都会走到这里
      throw new BadRequestException(`备份文件解不开（可能已损坏或不完整）：${(err as Error)?.message}`);
    }

    const manifestPath = path.join(staging, 'manifest.json');
    const copyPath = path.join(staging, MANIFEST_COPY_FILENAME);
    let manifest: FullBackupManifest | null = null;
    // 主清单读不出来时**回落到副本**（这正是归档里存两份的理由）：
    // 少了这一步，副本就只是一份没人读的字节。
    for (const candidate of [manifestPath, copyPath]) {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (isFullBackupManifest(parsed)) {
          manifest = parsed;
          if (candidate === copyPath) {
            notes.push(
              `主清单 ${'./manifest.json'} 读不出来，已改用归档里的副本 ${'./MANIFEST.copy.json'}（两份本应逐字节相同，说明主清单那份已损坏）`,
            );
            logger.warn('manifest.json 解析失败，已回落到 MANIFEST.copy.json');
          }
          break;
        }
      } catch {
        // 试下一份
      }
    }
    if (!manifest) {
      if (!fs.existsSync(manifestPath) && !fs.existsSync(copyPath)) {
        throw new BadRequestException('归档里没有 manifest.json，不是本功能导出的整站备份');
      }
      throw new BadRequestException(
        'manifest.json 校验失败：不是 VanBlog 整站备份，或版本过新（副本 MANIFEST.copy.json 同样读不出）',
      );
    }

    // P3：归档里到底有哪些库/表 —— 先写进 journal，崩溃时才知道"计划换哪些、换完了哪些"
    const planned: Record<string, string[]> = {};
    for (const dbName of Object.keys(manifest.databases || {})) {
      planned[dbName] = Object.keys(manifest.databases[dbName]?.collections || {});
    }
    journal?.setPlanned(planned);
    journal?.setPhase('collections');

    const databases: Record<string, { collections: number; documents: number }> = {};
    for (const dbName of Object.keys(manifest.databases || {})) {
      const dbDir = path.join(staging, 'db', dbName);
      if (!fs.existsSync(dbDir)) {
        notes.push(`备份清单里有数据库 ${dbName}，但归档中找不到它的数据，已跳过`);
        continue;
      }
      const db = options.client.db(dbName);
      let documents = 0;
      let collections = 0;
      for (const name of Object.keys(manifest.databases[dbName].collections || {})) {
        const ndjson = path.join(dbDir, `${name}.ndjson`);
        if (!fs.existsSync(ndjson)) {
          notes.push(`${dbName}.${name} 的数据文件缺失，已跳过`);
          continue;
        }
        logger.log(`恢复 ${dbName}.${name} ...`);
        const inserted = await restoreCollection(
          db,
          name,
          ndjson,
          path.join(dbDir, `${name}.indexes.json`),
        );
        documents += inserted;
        collections += 1;
        journal?.recordCollection(dbName, name, inserted);
      }
      databases[dbName] = { collections, documents };
      await reportAbsentCollections(db, dbName, new Set(planned[dbName] || []), dropAbsent);
    }

    const restoredStatic: Record<string, { files: number }> = {};
    const copiedFolders: Array<{ folder: string; src: string; dst: string }> = [];
    if (options.withStatic !== false) {
      journal?.setPhase('static');
      for (const folder of BACKUP_STATIC_FOLDERS) {
        const src = path.join(staging, 'static', folder);
        if (!fs.existsSync(src)) {
          // ⚠️ 归档里没有这一段（例如没有 themes 的老归档）：**绝不能**修剪对应目录，
          // 否则等于"归档里没记 => 全部删掉"，那正是本功能要防的数据丢失
          notes.push(`归档里没有 static/${folder}/ 这一段，该目录原样保留（既没覆盖也没修剪）`);
          continue;
        }
        const dst = path.join(options.staticPath, folder);
        try {
          ensureDir(dst);
          fs.cpSync(src, dst, { recursive: true, force: true, dereference: false });
        } catch (err) {
          // ⚠️ 必须包成 BadRequestException：这里抛的是裸 fs 错误（ENOSPC / EEXIST / ENOTDIR），
          // Nest 会把它变成 500 + "Internal server error"，用户看不到原因；
          // 而且这句话还要说清"修剪没做"—— 拷贝失败时一个文件都不该被删（见下面的顺序铁律）
          throw new BadRequestException(
            `恢复静态目录 ${folder}/ 失败（${(err as Error)?.message || err}；` +
              `目标盘剩余空间 ${freeSpaceText(options.staticPath)}）：` +
              `数据库已恢复的部分不会回滚，静态目录**尚未修剪**（一个文件都没删）`,
          );
        }
        restoredStatic[folder] = { files: treeStats(src).files };
        copiedFolders.push({ folder, src, dst });
      }
      // 修剪必须排在**所有拷贝都成功之后**：中途抛错就一张都不删
      if (pruneEnabled) {
        journal?.setPhase('prune');
        for (const item of copiedFolders) {
          const report = pruneFolderToMatch({
            srcDir: item.src,
            dstDir: item.dst,
            folder: item.folder,
          });
          if (!report) {
            continue;
          }
          pruned.push(report);
          if (report.removedFiles || report.removedDirs || report.skipped.length || report.errors.length) {
            notes.push(formatPruneReport(report));
            logger.log(formatPruneReport(report));
          }
        }
        if (pruned.some((r) => r.removedFiles || r.removedDirs)) {
          notes.push(
            '静态目录已按归档修剪成"与备份那一刻完全一致"（VANBLOG_RESTORE_PRUNE_STATIC=off 可关掉修剪，' +
              '关掉后恢复就是并集：归档里没有、磁盘上有的文件会留下）',
          );
        }
      } else {
        notes.push(
          '未修剪静态目录（VANBLOG_RESTORE_PRUNE_STATIC=off）：归档里没有、磁盘上却有的文件仍然留着，' +
            '站点是"归档内容 + 现有文件"的并集，不等于备份那一刻',
        );
      }
    } else {
      notes.push('按参数要求只恢复了数据库，未覆盖静态文件');
    }

    // P6（可选）：归档里带 caddy 的 TLS 材料时才走到这里
    caddyResult = restoreCaddySection(staging, options, notes, journal);

    // P3：source 错配（waline 库名 / demo）——静默错配里最难发现的一类
    reportSourceMismatch(manifest, options, databases, notes);

    notes.push('数据库与设置已按备份覆盖，建议重启 server 进程以清掉内存缓存');
    // tokens 表也被备份覆盖了，当前这套登录态必然失效（实测恢复后接口立刻 401）
    notes.push('登录态（tokens）与 jwt 密钥都来自备份，恢复后需要重新登录后台');

    journal?.finish();
    return {
      manifest,
      databases,
      static: restoredStatic,
      ms: Date.now() - started,
      notes,
      pruned,
      absentCollections,
      caddy: caddyResult,
    };

    /** 目标库里有、归档里没有的表（就地填充 absentCollections） */
    async function reportAbsentCollections(
      db: Db,
      dbName: string,
      archived: Set<string>,
      drop: boolean,
    ): Promise<void> {
      let names: string[] = [];
      try {
        names = (await db.collections()).map((item: any) => item.collectionName);
      } catch (err) {
        notes.push(
          `读不出 ${dbName} 的集合列表，无法判断"归档里没有的表"：${(err as Error)?.message || err}`,
        );
        return;
      }
      const mine: AbsentCollection[] = [];
      for (const name of names) {
        if (isProtectedCollectionName(name)) {
          continue; // system.* 与 *__vanblog_restore 一律不碰
        }
        if (archived.has(name)) {
          continue;
        }
        let documents = -1;
        try {
          documents = await db.collection(name).countDocuments({});
        } catch {
          documents = -1;
        }
        const entry: AbsentCollection = { db: dbName, collection: name, documents, dropped: false };
        if (drop) {
          try {
            await db.collection(name).drop();
            entry.dropped = true;
          } catch (err) {
            notes.push(
              `删除 ${dbName}.${name} 失败（它是归档里没有的表）：${(err as Error)?.message || err}`,
            );
          }
        }
        mine.push(entry);
      }
      if (!mine.length) {
        return;
      }
      absentCollections.push(...mine);
      notes.push(
        `归档里没有的表（${dbName}）：` +
          mine
            .map(
              (item) =>
                `${item.collection}（${item.documents < 0 ? '?' : item.documents} 条${item.dropped ? '，已删' : ''}）`,
            )
            .join(', ') +
          (drop
            ? ' —— 已按 VANBLOG_RESTORE_DROP_ABSENT_COLLECTIONS 删除'
            : ' —— 未删（VANBLOG_RESTORE_DROP_ABSENT_COLLECTIONS=on 才删）：这些表仍是恢复前的内容，站点处于混合状态'),
      );
    }
  } catch (err) {
    journal?.fail((err as Error)?.message || String(err));
    throw err;
  } finally {
    rmrf(staging);
  }
}

/** P3：把 manifest.source 与目标实例的配置对一遍，不一致就在 notes 里点名 WARN。 */
function reportSourceMismatch(
  manifest: FullBackupManifest,
  options: RestoreFullBackupOptions,
  databases: Record<string, { collections: number; documents: number }>,
  notes: string[],
): void {
  const source = manifest.source;
  const target = options.target;
  if (!source || !target) {
    if (!source) {
      notes.push('这份归档没有 source 块（早于防损坏改动导出），无法比对导出实例的配置');
    }
    return;
  }
  const srcWaline = String(source.walineDB || '').trim();
  const dstWaline = String(target.walineDB || '').trim();
  // 只有归档里**真的有** waline 库时才说这件事，否则是纯噪音
  const walineRestored = srcWaline && databases[srcWaline] ? databases[srcWaline] : null;
  if (walineRestored && dstWaline && srcWaline !== dstWaline) {
    notes.push(
      `WARN waline 评论库名不一致：归档来自 "${srcWaline}"，本实例的 config.waline.db 是 "${dstWaline}"。` +
        `waline 的 ${walineRestored.collections} 张表（${walineRestored.documents} 条）已按归档写进 "${srcWaline}" 库，` +
        `而本实例读的是 "${dstWaline}" ⇒ 评论看起来"消失"了却不会有任何报错。` +
        `要恢复评论，请把本机 config.yaml 的 waline.db 改成 "${srcWaline}"（或把数据搬过去）后重启`,
    );
  }
  if (Boolean(source.demo) !== Boolean(target.demo)) {
    notes.push(
      `WARN 演示模式不一致：归档来自 demo=${Boolean(source.demo)} 的实例，本实例是 demo=${Boolean(
        target.demo,
      )}。demo=true 会禁掉备份/恢复/导入这类写操作，行为差异是配置带来的，不是数据丢了`,
    );
  }
  if (source.codeVersion && target.codeVersion && source.codeVersion !== target.codeVersion) {
    notes.push(
      `归档由 ${source.codeVersion} 导出，本实例是 ${target.codeVersion}` +
        (source.hostname ? `（源主机 ${source.hostname}）` : ''),
    );
  }
}

/**
 * P6（可选，默认关）：恢复归档里的 `./caddy` 段（TLS 证书与私钥）。
 *
 * 归档里没有这一段就返回 null；有这一段但调用方没给目标目录，就**只报告不动手**
 * （把私钥写到一个没人要求的位置是不能接受的行为）。
 */
function restoreCaddySection(
  staging: string,
  options: RestoreFullBackupOptions,
  notes: string[],
  journal: RestoreJournalWriter | null,
): RestoreResult['caddy'] {
  const src = path.join(staging, 'caddy');
  if (!fs.existsSync(src)) {
    return null;
  }
  const stats = treeStats(src);
  const target = String(options.caddyDataPath || '').trim();
  if (!target) {
    notes.push(
      `归档里有 ./caddy 段（${stats.files} 个文件，${formatBytes(stats.bytes)}，含 TLS 证书与私钥），` +
        // ⚠️ 这里以前写的是「把 VANBLOG_CADDY_DATA_PATH 配上再恢复一次」—— 那个名字**没有任何代码读**
        //    （真实的是 loadConfig('caddy.data.path') 推导出的 VAN_BLOG_CADDY_DATA_PATH，差一个下划线），
        //    而且光有路径也没用：fullBackup.provider.ts 的备份与恢复两处都是
        //    `backupIncludeCaddyEnabled() ? config.caddyDataPath : undefined`，
        //    开关不开就永远是 undefined ⇒ 用户照着提示做也恢复不了证书。
        //    现在按真实的两个旋钮写，并由 utils/envVarMentions.spec.ts 钉住
        //    （用户可见文案里出现的每个环境变量名都必须真有人读）。
        '但本次没有指定 caddy 数据目录，已跳过。要把它恢复回去：给 server 设 ' +
        'VANBLOG_BACKUP_INCLUDE_CADDY=true（备份与恢复共用这个开关，默认关）再恢复一次；' +
        '目录默认 /root/.local/share/caddy，非标准位置用 VAN_BLOG_CADDY_DATA_PATH' +
        '（或 config.yaml 里的 caddy.data.path）指定',
    );
    return null;
  }
  if (!path.isAbsolute(target) || target.split(/[\\/]/).includes('..')) {
    notes.push(`caddy 数据目录 "${target}" 不是安全的绝对路径，已跳过恢复 ./caddy 段`);
    return null;
  }
  journal?.setPhase('caddy');
  try {
    ensureDir(target);
    // ⚠️ 只覆盖、**绝不修剪** caddy 目录：删掉证书/私钥的代价远高于留下几份旧的
    fs.cpSync(src, target, { recursive: true, force: true, dereference: false });
    notes.push(
      `已把归档里的 caddy TLS 材料（${stats.files} 个文件）还原到 ${target}；` +
        'caddy 需要重启才会重新加载证书（容器里就是重启容器）',
    );
    return { files: stats.files, bytes: stats.bytes, target };
  } catch (err) {
    notes.push(`还原 caddy TLS 材料失败（数据库与静态文件不受影响）：${(err as Error)?.message || err}`);
    return null;
  }
}
