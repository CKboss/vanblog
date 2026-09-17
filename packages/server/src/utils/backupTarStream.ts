import * as crypto from 'crypto';
import * as fs from 'fs';
import { Readable, Writable } from 'stream';

/**
 * 整站归档的**防损坏**基础设施（P1）里"读 tar 流"的那一半：
 * 一个只扫一遍字节流就能给出「每个成员的名字 / 类型 / 大小 / 内容 sha256 / 头部校验和是否自洽」
 * 的解析器，外加 merkle root、单文件哈希这些纯函数。
 *
 * 为什么自己解析 tar，而不是"解包到临时目录再逐个 sha256"：
 *  - 解包要额外一份与归档等大的磁盘空间（真站 69MB 归档 ≈ 70MB 落盘），
 *    而磁盘紧张恰恰是最需要校验的时候；
 *  - 这里**边流边哈希**，任何成员都不整体缓冲（成员可能有几百 MB）⇒ 内存 O(chunk)；
 *  - 顺带白拿两样东西：tar **头部自带的八进制校验和**（头部损坏当场就发现，
 *    不必等到内容对不上）与**真实成员名**（`tar -tf` 打印什么，这里就是什么，
 *    于是 `memberCount` / `members` 的键不需要猜 GNU 与 busybox 的行为差异）。
 *
 * ⚠️ 顺手实测过 GNU tar 1.35 与 busybox 1.36.1（容器里用的就是 busybox tar，见 Dockerfile）：
 * `tar -cf - -C <dir> .` 两者成员表**逐行相同**（都有 `./` 根项、目录项带结尾 `/`、
 * 符号链接不带结尾 `/`）。但本文件**不依赖**这个结论。
 *
 * 支持的 tar 特性：ustar 的 `prefix/name` 拼接、GNU 长名（`L`）与长链接（`K`）、
 * pax 扩展头（`x`/`g`，只取 path/linkpath）、base-256 编码的长度字段、
 * 常规文件 / 目录 / 符号链接 / 硬链接 / 设备与 FIFO（后三类没有内容，哈希为 null）。
 */

/** 归档内部主清单与副本清单的成员名（副本的存在理由见 buildIntegrity）。 */
export const MANIFEST_MEMBER = './manifest.json';
export const MANIFEST_COPY_MEMBER = './MANIFEST.copy.json';
/** 副本清单在暂存目录里的文件名（打包后就是 `./MANIFEST.copy.json`） */
export const MANIFEST_COPY_FILENAME = 'MANIFEST.copy.json';
/** 整归档校验和 sidecar 的后缀（与 `scripts/vanblog.sh write_sha256_sidecar` 完全同格式） */
export const SHA256_SIDECAR_EXT = '.sha256';

export const INTEGRITY_ALGORITHM = 'sha256';

const BLOCK = 512;

export type TarEntryKind = 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';

export interface TarEntryInfo {
  /** tar 流里的成员名（与 `tar -tf` 打印的一致） */
  name: string;
  kind: TarEntryKind;
  /** 归档里实际存的数据字节数（目录 / 符号链接 / 硬链接为 0） */
  size: number;
  /**
   * 常规文件 = 内容的 sha256；
   * 符号链接 = **链接目标字符串**的 sha256（tar 存的就是目标名，不存目标内容）；
   * 硬链接 = null（内容不在归档里，同 inode 的那个成员已经哈希过了；`tar -x` 会正确还原）；
   * 设备 / FIFO / 其它 = null。
   */
  sha256: string | null;
  linkTarget: string | null;
  /** tar 头部自带的八进制校验和是否自洽（头部损坏时 false） */
  headerChecksumOk: boolean;
}

/** `manifest.integrity.members` 的值；null = 这个成员不可能有自己的哈希（见 buildIntegrity） */
export interface MemberHash {
  sha256: string | null;
  bytes: number;
}

export interface TarHashResult {
  entries: TarEntryInfo[];
  /** 非目录成员 -> 哈希；键是 tar 成员名（`./` 前缀） */
  members: Record<string, MemberHash | null>;
  /** tar 流里的成员总数（含目录项，与 `tar -tf | wc -l` 一致） */
  memberCount: number;
  /** 同名成员出现多次（正常归档不该有；有就说明暂存树或归档被动过手脚） */
  duplicateNames: string[];
  /** 头部校验和不对的成员名 */
  badHeaders: string[];
  /** 流是否正常走完（读到全零结束块） */
  complete: boolean;
  /** 读到的 tar 字节数（解压后） */
  bytes: number;
  ms: number;
}

export function sha256Hex(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * merkle root：把 `members` 按键排序，每项写成 `<成员名>\n<sha256 或字面量 null>\n`，
 * 顺序拼成一个字符串再取 sha256（十六进制小写）。
 *
 * 排序用 JS 默认的字符串比较（UTF-16 码元序）—— 成员名全是 ASCII，
 * 所以等同于字节序，任何实现都能复现（`backupTarStream.spec.ts` 里有固定测试向量）。
 * 它的作用是给"清单里那一大堆哈希"一个单一指纹：只比 merkleRoot 就能判断
 * `members` 表有没有被改/被截断，不必逐项对比。
 */
export function computeMerkleRoot(members: Record<string, MemberHash | null>): string {
  const payload = Object.keys(members || {})
    .sort()
    .map((key) => `${key}\n${members[key]?.sha256 ?? 'null'}\n`)
    .join('');
  return sha256Hex(payload);
}

/** 流式哈希一个磁盘文件（不整体读进内存）。 */
export function hashFile(file: string): Promise<MemberHash> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

function parseNumeric(field: Buffer): number | null {
  if (!field.length) {
    return 0;
  }
  // base-256（GNU 对超过八进制字段宽度的值用）：最高位为 1，次高位是符号
  if (field[0] & 0x80) {
    let out = 0;
    for (let i = 1; i < field.length; i += 1) {
      out = out * 256 + field[i];
    }
    return field[0] & 0x40 ? -out : out;
  }
  const text = field.toString('ascii').replace(/\0[\s\S]*$/, '').trim();
  if (!text) {
    return 0;
  }
  if (!/^[0-7]+$/.test(text)) {
    return null;
  }
  return parseInt(text, 8);
}

function cstring(field: Buffer): string {
  const end = field.indexOf(0);
  return (end === -1 ? field : field.subarray(0, end)).toString('utf8');
}

function headerChecksum(block: Buffer): { stored: number; computed: number } {
  const stored = parseNumeric(block.subarray(148, 156));
  let computed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    // 校验和字段本身按 8 个空格计
    computed += i >= 148 && i < 156 ? 0x20 : block[i];
  }
  return { stored: stored === null ? Number.NaN : stored, computed };
}

type FlagKind =
  | TarEntryKind
  | 'longname'
  | 'longlink'
  | 'pax'
  | 'paxglobal';

function kindOfTypeFlag(flag: number): FlagKind {
  switch (flag) {
    case 0x30: // '0'
    case 0x00: // 老式 tar 用 NUL 表示常规文件
    case 0x37: // '7' 连续文件，内容照样存着
      return 'file';
    case 0x35: // '5'
      return 'dir';
    case 0x32: // '2'
      return 'symlink';
    case 0x31: // '1'
      return 'hardlink';
    case 0x4c: // 'L' GNU 长名
      return 'longname';
    case 0x4b: // 'K' GNU 长链接名
      return 'longlink';
    case 0x78: // 'x' pax 扩展头
      return 'pax';
    case 0x67: // 'g' pax 全局头
      return 'paxglobal';
    default:
      return 'other';
  }
}

/** pax 记录形如 `<len> <key>=<value>\n`；我们只关心 path / linkpath。 */
export function parsePaxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const len = Number(data.subarray(offset, space).toString('ascii'));
    if (!Number.isFinite(len) || len <= 0 || offset + len > data.length) break;
    const record = data.subarray(space + 1, offset + len).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) {
      out[record.slice(0, eq)] = record.slice(eq + 1).replace(/\n$/, '');
    }
    offset += len;
  }
  return out;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

export interface TarHashSink extends Writable {
  badHeaders: string[];
  sawEndBlock: boolean;
}

export interface TarSinkOptions {
  /**
   * 是否计算内容 sha256（默认 true）。
   * 恢复前的成员检查只关心**成员名与类型**（能不能安全解包），不需要哈希 ——
   * 关掉它可以省下 69MB 归档约 0.4s 的 sha256 计算。
   */
  computeHashes?: boolean;
}

/**
 * 造一个「喂 tar 字节流、吐成员信息」的 Writable。
 * 一般不直接用它，用下面的 `hashTarStream()`。
 */
export function createTarHashSink(
  onEntry: (entry: TarEntryInfo) => void,
  options: TarSinkOptions = {},
): TarHashSink {
  const computeHashes = options.computeHashes !== false;
  let pending: Buffer = Buffer.alloc(0);
  let state: 'header' | 'data' | 'pad' = 'header';
  let dataRemaining = 0;
  let padRemaining = 0;
  let hash: crypto.Hash | null = null;
  let current: TarEntryInfo | null = null;
  /** 正在收集的辅助块（长名 / 长链接 / pax）；null 表示当前成员的数据就是内容 */
  let aux: 'name' | 'link' | 'pax' | 'skip' | null = null;
  let auxChunks: Buffer[] = [];
  let longName: string | null = null;
  let longLink: string | null = null;
  let paxPath: string | null = null;
  let paxLink: string | null = null;

  const sink = new Writable({
    write(chunk: Buffer, _enc: string, cb: (err?: Error) => void) {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        consume();
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  }) as TarHashSink;
  sink.badHeaders = [];
  sink.sawEndBlock = false;

  function emit(entry: TarEntryInfo) {
    if (!entry.headerChecksumOk) {
      sink.badHeaders.push(entry.name);
    }
    onEntry(entry);
  }

  function applyAux() {
    const data = Buffer.concat(auxChunks);
    auxChunks = [];
    if (aux === 'name') {
      longName = cstring(data);
    } else if (aux === 'link') {
      longLink = cstring(data);
    } else if (aux === 'pax') {
      const records = parsePaxRecords(data);
      if (records.path) paxPath = records.path;
      if (records.linkpath) paxLink = records.linkpath;
    }
    aux = null;
  }

  function finishData() {
    if (aux) {
      applyAux();
    } else if (current) {
      if (hash) {
        current.sha256 = hash.digest('hex');
        hash = null;
      }
      emit(current);
      current = null;
    }
  }

  function handleHeader(block: Buffer) {
    const { stored, computed } = headerChecksum(block);
    const headerOk = Number.isFinite(stored) && stored === computed;
    const sizeField = parseNumeric(block.subarray(124, 136));
    const size = sizeField === null || sizeField < 0 ? 0 : sizeField;
    const flag = kindOfTypeFlag(block[156]);

    if (flag === 'longname' || flag === 'longlink' || flag === 'pax' || flag === 'paxglobal') {
      // 这些数据是给**下一个**成员用的，本身不算成员
      aux = flag === 'longname' ? 'name' : flag === 'longlink' ? 'link' : flag === 'pax' ? 'pax' : 'skip';
      auxChunks = [];
      hash = null;
      current = null;
      dataRemaining = size;
      padRemaining = size % BLOCK ? BLOCK - (size % BLOCK) : 0;
      state = 'data';
      return;
    }

    const rawName = cstring(block.subarray(0, 100));
    const prefix = cstring(block.subarray(345, 500));
    let name = prefix ? `${prefix}/${rawName}` : rawName;
    if (longName) name = longName;
    if (paxPath) name = paxPath;
    const target = paxLink || longLink || cstring(block.subarray(157, 257)) || null;

    const kind: TarEntryKind =
      flag === 'file' || flag === 'dir' || flag === 'symlink' || flag === 'hardlink' ? flag : 'other';

    current = {
      name,
      kind,
      size: kind === 'file' ? size : 0,
      sha256: kind === 'symlink' ? (target === null ? null : sha256Hex(target)) : null,
      linkTarget: kind === 'symlink' || kind === 'hardlink' ? target : null,
      headerChecksumOk: headerOk,
    };
    // computeHashes=false 时 sha256 一律为 null（"没算"与"算出来是空"用 kind+size 区分）
    hash = kind === 'file' && computeHashes ? crypto.createHash('sha256') : null;

    // 长名 / pax 只对紧跟的那一个成员生效
    longName = null;
    longLink = null;
    paxPath = null;
    paxLink = null;

    dataRemaining = size;
    padRemaining = size % BLOCK ? BLOCK - (size % BLOCK) : 0;
    state = 'data';
  }

  function consume() {
    for (;;) {
      if (state === 'header') {
        if (pending.length < BLOCK) return;
        const block = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        if (isZeroBlock(block)) {
          // tar 以两个全零块结束（第二个块只是被顺带读掉）
          sink.sawEndBlock = true;
          continue;
        }
        handleHeader(block);
        continue;
      }
      if (state === 'data') {
        if (dataRemaining > 0) {
          const take = Math.min(dataRemaining, pending.length);
          if (take === 0) return;
          if (hash) {
            hash.update(pending.subarray(0, take));
          } else if (aux) {
            auxChunks.push(Buffer.from(pending.subarray(0, take)));
          }
          dataRemaining -= take;
          pending = pending.subarray(take);
          if (dataRemaining > 0) return;
        }
        finishData();
        state = 'pad';
        continue;
      }
      // state === 'pad'
      if (padRemaining === 0) {
        state = 'header';
        continue;
      }
      const take = Math.min(padRemaining, pending.length);
      if (take === 0) return;
      padRemaining -= take;
      pending = pending.subarray(take);
      if (padRemaining > 0) return;
      state = 'header';
    }
  }

  return sink;
}

/** 把一个可读的 tar 流整体喂进哈希器，返回成员表与统计。 */
export function hashTarStream(
  source: Readable,
  options: TarSinkOptions = {},
): Promise<TarHashResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const entries: TarEntryInfo[] = [];
    const members: Record<string, MemberHash | null> = {};
    const duplicateNames: string[] = [];
    let bytes = 0;
    const sink = createTarHashSink((entry) => {
      entries.push(entry);
      if (Object.prototype.hasOwnProperty.call(members, entry.name)) {
        if (!duplicateNames.includes(entry.name)) duplicateNames.push(entry.name);
      }
      if (entry.kind !== 'dir') {
        members[entry.name] = { sha256: entry.sha256, bytes: entry.size };
      }
    }, options);
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      resolve({
        entries,
        members,
        memberCount: entries.length,
        duplicateNames,
        badHeaders: sink.badHeaders,
        complete: sink.sawEndBlock,
        bytes,
        ms: Date.now() - started,
      });
    };
    source.on('error', done);
    sink.on('error', done);
    source.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    // 'finish' 是写入侧结束；等 'close' 更稳（sink 没有 fd，两者几乎同时）
    sink.on('finish', () => done());
    source.pipe(sink);
  });
}
