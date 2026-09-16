import { BadRequestException } from '@nestjs/common';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { Db, MongoClient } from 'mongodb';
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  CollectionSummary,
  FullBackupManifest,
  backupFileName,
  encodeDoc,
  decodeDoc,
  isFullBackupManifest,
} from './backupCodec';

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
/** 只备份这些静态子目录：export（旧归档）、tmp、rss、sitemap 都是可再生的，不进去。 */
export const BACKUP_STATIC_FOLDERS = ['img', 'file', 'customPage'];
const RESTORE_SUFFIX = '__vanblog_restore';
const INSERT_BATCH = 500;

export type BackupFormat = 'zstd' | 'xz' | 'gzip';

interface CompressorSpec {
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
      compress: ['zstd', zstdLevel(), '--long=27', '-T0', '-q', '-c'],
      decompress: ['zstd', '-dc', '--long=27', '-q'],
      label: `zstd ${zstdLevel()} --long=27 -T0`,
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

/** 从文件名/魔数猜格式（恢复时用）。 */
export function detectFormat(file: string): BackupFormat | null {
  const name = path.basename(file).toLowerCase();
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

/** tar | 压缩器 > 输出文件（全异步，不阻塞事件循环）。 */
function tarCompress(stagingDir: string, outFile: string, spec: CompressorSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-cf', '-', '-C', stagingDir, '.']);
    const compressor = spawn(spec.compress[0], spec.compress.slice(1));
    const out = fs.createWriteStream(outFile);
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
    out.on('error', (err) => fail(`写入备份文件失败：${err.message}`));
    tar.on('exit', (code) => {
      // exit 1 = "file changed as we read it"：备份期间正好有图片被原地替换时会发生，
      // 归档本身仍可用，不该当成致命错误（cp -al 硬链接窗口里尤其容易碰到）
      if (code !== 0 && code !== null && code !== 1) {
        fail(`tar 退出码 ${code}：${tarErr.slice(0, 500)}`);
      }
    });
    compressor.stdout.pipe(out);
    tar.stdout.pipe(compressor.stdin);
    compressor.on('close', (code) => {
      if (code !== 0) {
        fail(`${spec.format} 压缩失败（退出码 ${code}）：${compErr.slice(0, 500)}`);
        return;
      }
      out.end();
    });
    out.on('close', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}

/** 解压缩 | tar -x -C dest（全异步）。 */
function decompressUntar(archivePath: string, destDir: string, spec: CompressorSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const decompressor = spawn(spec.decompress[0], [...spec.decompress.slice(1), archivePath]);
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
        fail(`${spec.format} 解压失败（退出码 ${code}）：${decErr.slice(0, 500)}`);
      }
    });
    tar.on('close', (code) => {
      if (code !== 0) {
        fail(`tar 解包失败（退出码 ${code}）：${tarErr.slice(0, 500)}`);
        return;
      }
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}

/** 只把归档里的某个文件解出来（读 manifest 用，不用整包解压）。 */
function extractSingleFile(archivePath: string, entry: string, spec: CompressorSpec): Promise<string | null> {
  return new Promise((resolve) => {
    const decompressor = spawn(spec.decompress[0], [...spec.decompress.slice(1), archivePath]);
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
  ensureDir(path.dirname(dst));
  const res = spawnSync('cp', ['-al', src, dst], { stdio: 'ignore' });
  if (res.status === 0) {
    return;
  }
  logger.warn(`硬链接失败（${src}），改用真实拷贝`);
  fs.cpSync(src, dst, { recursive: true, force: true, dereference: false });
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

async function dumpCollection(
  collection: any,
  ndjsonPath: string,
  indexPath: string,
): Promise<CollectionSummary> {
  let count = 0;
  let bytes = 0;
  const stream = fs.createWriteStream(ndjsonPath);
  const cursor = collection.find({});
  for await (const doc of cursor) {
    const line = `${JSON.stringify(encodeDoc(doc))}\n`;
    if (!stream.write(line)) {
      // @types/node 24 给 fs.WriteStream 的事件表加了强类型（'drain' 的监听器是 () => void），
      // 而 Promise 的 resolve 是 (value: unknown) => void，直接塞进去会报 TS2345
      // （目标签名参数太少）。包一层无参回调即可，运行时行为与原来完全一致。
      await new Promise<void>((resolve) => stream.once('drain', () => resolve()));
    }
    count += 1;
    bytes += Buffer.byteLength(line);
  }
  // 同上：原来写 `stream.end(resolve)`，运行时 Node 把函数实参当回调（行为正确），
  // 但类型上是撞进了 `end(chunk: any, cb?)` 重载 —— resolve 被当成待写数据。
  // 显式写成回调，类型与运行时语义一致，行为不变。
  await new Promise<void>((resolve) => stream.end(() => resolve()));

  let indexes: any[] = [];
  try {
    const raw = await collection.indexes();
    indexes = (raw || []).filter((item: any) => item?.name !== '_id_');
    fs.writeFileSync(indexPath, JSON.stringify(indexes.map((item) => encodeDoc(item)), null, 0));
  } catch {
    fs.writeFileSync(indexPath, '[]');
  }
  return { count, bytes, indexes: indexes.length };
}

async function dumpDatabase(client: MongoClient, dbName: string, outDir: string): Promise<{
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
  const staticPath = options.staticPath;
  const outDir = ensureDir(options.outDir);
  const workRoot = ensureDir(options.workDir || path.join(staticPath, 'tmp'));
  const staging = fs.mkdtempSync(path.join(workRoot, 'full-backup-'));

  try {
    const manifest: FullBackupManifest = {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      format: spec.format,
      compressor: spec.label,
      serverVersion: options.serverVersion,
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
      const dumped = await dumpDatabase(options.client, dbName, path.join(staging, 'db', dbName));
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

    // 3) manifest（含 sidecar，方便不解压就能列信息）
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // 4) 打包压缩
    const name = backupFileName(new Date(), spec.ext);
    const archivePath = path.join(outDir, name);
    logger.log(`打包中（${spec.label}）...`);
    await tarCompress(staging, archivePath, spec);
    const bytes = fs.statSync(archivePath).size;
    manifest.totals.archiveBytes = bytes;
    fs.writeFileSync(`${archivePath}.manifest.json`, JSON.stringify(manifest, null, 2));

    logger.log(
      `备份完成：${name}（${bytes} 字节，${manifest.totals.documents} 条文档，${manifest.totals.files} 个文件）`,
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
    };
  } finally {
    rmrf(staging);
  }
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
export const FULL_BACKUP_ARCHIVE_RE = /^vanblog-full-.+\.tar\.(zst|xz|gz)$/;

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
  const raw = await extractSingleFile(archivePath, './manifest.json', spec);
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

export interface RestoreFullBackupOptions {
  client: MongoClient;
  staticPath: string;
  archivePath: string;
  workDir?: string;
  /** 是否同时恢复静态文件（关掉就只恢复数据库） */
  withStatic?: boolean;
  logger?: BackupLogger;
}

export interface RestoreResult {
  manifest: FullBackupManifest;
  databases: Record<string, { collections: number; documents: number }>;
  static: Record<string, { files: number }>;
  ms: number;
  notes: string[];
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

/** 从整站备份恢复：数据库逐集合原子替换 + 静态文件覆盖回原目录。 */
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
  const workRoot = ensureDir(options.workDir || path.join(options.staticPath, 'tmp'));
  const staging = fs.mkdtempSync(path.join(workRoot, 'full-restore-'));
  const notes: string[] = [];

  try {
    logger.log(`解包中（${spec.label}）...`);
    try {
      await decompressUntar(archivePath, staging, spec);
    } catch (err) {
      // 下载不完整 / 文件被截断 / 用别的工具改过名，都会走到这里
      throw new BadRequestException(`备份文件解不开（可能已损坏或不完整）：${(err as Error)?.message}`);
    }

    const manifestPath = path.join(staging, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new BadRequestException('归档里没有 manifest.json，不是本功能导出的整站备份');
    }
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!isFullBackupManifest(parsed)) {
      throw new BadRequestException('manifest.json 校验失败：不是 VanBlog 整站备份，或版本过新');
    }
    const manifest = parsed;

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
        documents += await restoreCollection(
          db,
          name,
          ndjson,
          path.join(dbDir, `${name}.indexes.json`),
        );
        collections += 1;
      }
      databases[dbName] = { collections, documents };
    }

    const restoredStatic: Record<string, { files: number }> = {};
    if (options.withStatic !== false) {
      for (const folder of BACKUP_STATIC_FOLDERS) {
        const src = path.join(staging, 'static', folder);
        if (!fs.existsSync(src)) {
          continue;
        }
        const dst = path.join(options.staticPath, folder);
        ensureDir(dst);
        fs.cpSync(src, dst, { recursive: true, force: true, dereference: false });
        restoredStatic[folder] = { files: treeStats(src).files };
      }
    } else {
      notes.push('按参数要求只恢复了数据库，未覆盖静态文件');
    }

    notes.push('数据库与设置已按备份覆盖，建议重启 server 进程以清掉内存缓存');
    // tokens 表也被备份覆盖了，当前这套登录态必然失效（实测恢复后接口立刻 401）
    notes.push('登录态（tokens）与 jwt 密钥都来自备份，恢复后需要重新登录后台');

    return {
      manifest,
      databases,
      static: restoredStatic,
      ms: Date.now() - started,
      notes,
    };
  } finally {
    rmrf(staging);
  }
}
