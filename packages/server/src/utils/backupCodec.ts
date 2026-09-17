import mongoose from 'mongoose';
import * as directMongoDb from 'mongodb';

/**
 * 整站备份用的 BSON <-> JSON 编解码（canonical EJSON 的子集，够 VanBlog 用）。
 *
 * 为什么不直接用 EJSON：`bson` 在 pnpm 的严格 node_modules 下不能从 server 直接 require，
 * `mongodb@5` 也没有再导出 EJSON。这里按 `_bsontype` 判别（比 instanceof 稳，
 * 避免 mongodb / mongoose 各自持有一份类导致判断失败），写出来的格式和 canonical EJSON 一致，
 * 所以将来换成官方 EJSON 也能读。
 *
 * 解码时遵循 EJSON 的规则：**只有当对象里仅有那一个 `$` 键时才还原成 BSON 类型**，
 * 免得把用户文章里恰好叫 `$date` 的字段误伤。
 *
 * ⚠️⚠️ **解码时必须用 mongoose 那一份驱动的 BSON 构造器**（下面 `pickBsonSource` 的说明）。
 */

/**
 * 解码要还原的 12 个 BSON 类型（与 canonical EJSON 的键一一对应）。
 */
const BSON_CTOR_NAMES = [
  'ObjectId',
  'Binary',
  'Code',
  'DBRef',
  'Decimal128',
  'Double',
  'Int32',
  'Long',
  'MaxKey',
  'MinKey',
  'BSONRegExp',
  'Timestamp',
] as const;

export type BsonCtors = Record<(typeof BSON_CTOR_NAMES)[number], any>;

/**
 * 这些构造器**必须来自 mongoose 实际在用的那份驱动**，不能来自 server 直接依赖的
 * `mongodb@5.9.1`。
 *
 * 事故现场（mongoose 7→8 升级之后才暴露，见 AGENTS §7.52）：
 *  - `provider/backup/fullBackup.provider.ts` 用的是 `connection.getClient()`，
 *    也就是 **mongoose 8 自带的 driver = mongodb 6.20.0 = bson 6.x**；
 *  - 而这个文件以前 `import { ObjectId, … } from 'mongodb'`，拿到的是
 *    **server 直接依赖的 mongodb 5.9.1 = bson 5.x**；
 *  - 于是"恢复整站备份"时，`decodeDoc()` 造出来的 `ObjectId`/`Binary` 是 bson 5 的实例，
 *    交给 driver 6 的序列化器就报
 *    **`Unsupported BSON version, bson types must be from bson 6.x.x`** ⇒ 恢复第一个集合
 *    （articles）就 400，整个恢复功能不可用。
 *  - mongoose 7 时代两边同为 bson 5，所以这个坑一直潜伏着；而
 *    `test/backup-restore.e2e-spec.ts` 只覆盖了 JSON 导入导出，**没有 BSON 往返**，
 *    所以升级时没被测出来。
 *
 * 修法：优先从 `mongoose.mongo`（mongoose 自己 require 的那份 driver 模块）取构造器 ——
 * 它的 bson 主版本**按定义**与写库时用的序列化器一致，以后再升 mongoose 也不会再漂。
 * 直接依赖的 `mongodb` 只作为"mongoose.mongo 万一缺了某个构造器"时的兜底。
 *
 * 导出侧（`encodeDoc`）本来就按 `_bsontype` 鸭子判别、不做 instanceof，
 * 所以**不管文档里的 BSON 实例来自哪一份 bson，编码结果都一样** ⇒
 * 已经写出去的归档（含线上那批）不需要重做，这次改动也不动归档格式。
 */
function pickBsonSource(): { ctors: BsonCtors; label: string } {
  const candidates: Array<{ label: string; mod: any }> = [
    { label: 'mongoose.mongo', mod: (mongoose as any)?.mongo },
    { label: 'mongodb(direct)', mod: directMongoDb },
  ];
  for (const candidate of candidates) {
    const mod = candidate.mod;
    if (mod && BSON_CTOR_NAMES.every((name) => typeof mod[name] === 'function')) {
      return { ctors: mod as BsonCtors, label: candidate.label };
    }
  }
  // 理论上到不了这里（直接依赖的 mongodb 一定有这些导出）；真到了就说明依赖树坏了，
  // 与其在恢复时才炸，不如在加载时把话说清楚。
  throw new Error(
    '无法解析 BSON 构造器：mongoose.mongo 与直接依赖的 mongodb 都缺少 ' +
      BSON_CTOR_NAMES.join('/'),
  );
}

const bsonSource = pickBsonSource();

/** 当前用的是哪一份 bson（测试与排障用；生产环境应当恒为 `mongoose.mongo`） */
export const BSON_SOURCE_LABEL = bsonSource.label;

const {
  BSONRegExp,
  Binary,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} = bsonSource.ctors;

export const BACKUP_KIND = 'vanblog-full-backup';
export const BACKUP_VERSION = 1;

export interface CollectionSummary {
  count: number;
  bytes: number;
  indexes: number;
}

export interface DatabaseSummary {
  collections: Record<string, CollectionSummary>;
}

export interface StaticSummary {
  files: number;
  bytes: number;
}

/**
 * 单个归档成员的指纹（P1 防损坏）。
 *
 * `sha256` 为 null 的成员是**不可能有内容哈希**的那几类：
 *  - `./manifest.json` 与 `./MANIFEST.copy.json`：清单不能包含自己的哈希（自指），
 *    而副本与主清单**逐字节相同**，所以它俩的哈希同样不可知 —— 两份都记 null；
 *    它们的完整性由「两份互为对照 + 各自的 JSON 能解析 + merkleRoot 覆盖这两行」保证。
 *  - 硬链接成员（tar 里 size=0，内容指向同 inode 的另一个成员，那个成员有自己的哈希）。
 *  - 设备 / FIFO 等特殊成员（VanBlog 的静态目录里不该有，真出现了也不该假装哈希过）。
 */
export interface MemberHash {
  sha256: string | null;
  bytes: number;
}

/**
 * 归档的防损坏信息（P1）。⚠️ **可选字段**：这个块出现之前的所有归档都没有它，
 * 校验侧必须"没有就降级、只说一句查不了"，绝不能拒绝老归档（见 `backupVerify.ts`）。
 */
export interface BackupIntegrity {
  /** 目前只会是 'sha256'；写成字段是为了将来换算法时老工具还能读懂 */
  algorithm: string;
  /**
   * 压缩器自带的内容校验位**实测**是否开启（不是假设）：
   * zstd 读帧头描述符字节 bit2、xz 读 stream flags 的 check 类型、gzip 的 CRC32 是格式强制的。
   * 名字里带 zstd 是历史原因（第一个实现只针对 zstd），语义是"本归档所用压缩器的内容校验位"。
   */
  zstdFrameChecksum: boolean;
  /** `members` 表的指纹（算法见 `computeMerkleRoot`）：一个值就能判断整张表有没有被改/被截断 */
  merkleRoot: string;
  /** tar 流里的成员总数（**含目录项**，等于 `tar -tf <归档> | wc -l`） */
  memberCount: number;
  /**
   * 键 = 成员名，**取自归档 tar 流本身的头部**（与 `tar -x` 落盘出来的路径逐字节一致）。
   *
   * ⚠️ 对绝大多数成员，这就是 `tar -tf` 打印的那一行（`./` 前缀）。有一处**实测到的差异**
   * 必须写清楚：成员名里含**控制字符**时，GNU tar 的 `tar -tf` 会把它转义成八进制
   * （`\302\233`）而 busybox tar 原样输出 —— 同一份归档在两种 tar 下打印结果不同
   * （本机真站就有 10 个双重编码的中文图名带 C1 控制字节，实测复现）。
   * 所以这里存**真实字节**（实现无关，也是唯一能拿去 `stat` / 解包比对的形式），
   * 而不是某个 tar 的打印形式。
   *
   * ⚠️ **目录项不在表里**（目录没有内容可哈希），所以 `Object.keys(members).length`
   * 一般小于 `memberCount`，两者之差就是目录项个数（真站实测：228 vs 239，差 11 个目录项）。
   */
  members: Record<string, MemberHash | null>;
}

/**
 * 导出这台实例的身份信息（P1/P3）：恢复时用来发现"归档来自另一套配置"的静默错配。
 *
 * 最有价值的是 `walineDB`：`config.yaml` 的 `waline.db` 是**机器本地**的，
 * 恢复按 manifest 里的库名写库 ⇒ 两边库名不同时，waline 那两张表会被写进一个
 * 本实例根本不读的库里，而界面上一切正常（评论"消失"了却零报错）。
 */
export interface BackupSourceInfo {
  codeVersion: string;
  walineDB: string;
  demo: boolean;
  hostname: string;
  staticPath: string;
  codeRunnerPath: string;
}

export interface FullBackupManifest {
  kind: typeof BACKUP_KIND;
  version: number;
  createdAt: string;
  format: string;
  compressor: string;
  serverVersion?: string;
  /** 防损坏信息；老归档没有（可选、追加，不改 version） */
  integrity?: BackupIntegrity;
  /** 导出实例的身份；老归档没有（可选、追加） */
  source?: BackupSourceInfo;
  databases: Record<string, DatabaseSummary>;
  static: Record<string, StaticSummary>;
  /**
   * P6（可选，默认关）：归档里 `./caddy` 段的内容统计（caddy 的 TLS 证书与私钥）。
   * 只有 `VANBLOG_BACKUP_INCLUDE_CADDY` 打开、且那台机器上真的读得到目录时才有这个字段。
   * ⚠️ 与 `static` 分开记：它不在 staticPath 下面，也不该混进 `totals.files/staticBytes`
   * （那两个数描述的是"站点静态资源"，运维与校验都按这个口径在用）。
   */
  caddy?: StaticSummary;
  totals: {
    databases: number;
    collections: number;
    documents: number;
    files: number;
    staticBytes: number;
    archiveBytes?: number;
    /** 整份归档文件的 sha256（导出时流式算出并**回读复核**过）。老归档没有 */
    archiveSha256?: string;
  };
}

/** 文档 -> 可 JSON.stringify 的纯对象 */
export function encodeDoc(value: any): any {
  if (value === null || value === undefined) {
    return null;
  }
  const bsonType = value && (value as any)._bsontype;
  if (bsonType) {
    switch (bsonType) {
      case 'ObjectId':
        return { $oid: value.toHexString() };
      case 'Binary': {
        const subType =
          typeof value.sub_type === 'number'
            ? value.sub_type.toString(16).padStart(2, '0')
            : String(value.sub_type ?? '00');
        return {
          $binary: {
            base64: Buffer.from(value.buffer ?? value.value(true) ?? '').toString('base64'),
            subType,
          },
        };
      }
      case 'Decimal128':
        return { $numberDecimal: value.toString() };
      case 'Long':
        return { $numberLong: value.toString() };
      case 'Int32':
        return { $numberInt: String(value.value ?? value.valueOf()) };
      case 'Double':
        return { $numberDouble: String(value.value ?? value.valueOf()) };
      case 'Timestamp':
        return {
          $timestamp: {
            t: typeof value.high === 'number' ? value.high >>> 0 : Number(value.getHighBits?.() ?? 0) >>> 0,
            i: typeof value.low === 'number' ? value.low >>> 0 : Number(value.getLowBits?.() ?? 0) >>> 0,
          },
        };
      case 'MinKey':
        return { $minKey: 1 };
      case 'MaxKey':
        return { $maxKey: 1 };
      case 'BSONRegExp':
        return {
          $regularExpression: { pattern: String(value.pattern ?? ''), options: String(value.options ?? '') },
        };
      case 'Code':
        return { $code: String(value.code ?? value.codeWithScope ?? '') };
      case 'DBRef':
        return {
          $dbPointer: {
            $ref: String(value.collection ?? value.namespace ?? ''),
            $id: encodeDoc(value.oid ?? value.objectId),
          },
        };
      default:
        // 未知 BSON 类型：退化成字符串，至少不丢数据
        return { $unknownBsonType: String(bsonType), $value: String(value) };
    }
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  if (value instanceof RegExp) {
    // ⚠️ 驱动会把库里的 BSON regex **还原成原生 RegExp**（promoteValues 默认开），
    // 而原生 RegExp 既没有 `_bsontype`、`Object.keys()` 也是空的 —— 以前它会掉进下面
    // "普通对象"那个分支被编码成 `{}`，也就是**这个字段的值被静默丢掉**
    // （恢复之后那条正则变成空对象，看不出任何报错）。
    // canonical EJSON 的写法就是 `$regularExpression`，`decodeDoc` 一直都认它。
    return { $regularExpression: { pattern: value.source, options: value.flags } };
  }
  if (Buffer.isBuffer(value)) {
    return { $binary: { base64: value.toString('base64'), subType: '00' } };
  }
  if (Array.isArray(value)) {
    return value.map(encodeDoc);
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      out[key] = encodeDoc(value[key]);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    // JSON 不支持 Infinity/NaN，转成字符串标记，解码时还原
    return { $nonFiniteNumber: String(value) };
  }
  return value;
}

/** encodeDoc 的逆操作 */
export function decodeDoc(value: any): any {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (Array.isArray(value)) {
    return value.map(decodeDoc);
  }
  if (typeof value !== 'object') {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const decoded = decodeExtendedJson(value);
    if (decoded !== NOT_EXTENDED_JSON) {
      return decoded;
    }
  }
  const out: Record<string, any> = {};
  for (const key of keys) {
    out[key] = decodeDoc(value[key]);
  }
  return out;
}

const NOT_EXTENDED_JSON = Symbol('not-extended-json');

/**
 * 单键 `$xxx` 对象 -> BSON 类型。构造失败（例如用户文章里恰好有 `{$oid: "不是合法 id"}`）
 * 时返回 NOT_EXTENDED_JSON，让上层按普通对象处理——恢复流程不能因为一条脏数据整体失败。
 */
function decodeExtendedJson(value: Record<string, any>): any {
  const key = Object.keys(value)[0];
  const inner = value[key];
  try {
    switch (key) {
      case '$oid':
        return new ObjectId(String(inner));
      case '$date': {
        const date = new Date(typeof inner === 'string' ? inner : inner?.$numberLong ?? inner);
        // `new Date('乱七八糟')` 不会抛错，只会得到 Invalid Date：
        // 直接返回会被当成 1970-01-01 写进库，之后再编码还会抛 RangeError。
        if (Number.isNaN(date.getTime())) {
          return NOT_EXTENDED_JSON;
        }
        return date;
      }
      case '$numberDecimal':
        return Decimal128.fromString(String(inner));
      case '$numberLong':
        return Long.fromString(String(inner));
      case '$numberInt':
        return new Int32(Number(inner));
      case '$numberDouble':
        return new Double(Number(inner));
      case '$nonFiniteNumber':
        return inner === 'Infinity' ? Infinity : inner === '-Infinity' ? -Infinity : NaN;
      case '$minKey':
        return new MinKey();
      case '$maxKey':
        return new MaxKey();
      case '$binary': {
        const base64 = typeof inner === 'string' ? inner : inner?.base64;
        const subType = typeof inner === 'string' ? '00' : inner?.subType ?? '00';
        return new Binary(Buffer.from(String(base64 || ''), 'base64'), parseInt(subType, 16));
      }
      case '$timestamp':
        return new Timestamp({ t: Number(inner?.t ?? 0), i: Number(inner?.i ?? 0) });
      case '$regularExpression':
        return new BSONRegExp(String(inner?.pattern ?? ''), String(inner?.options ?? ''));
      case '$code':
        return new Code(String(inner));
      case '$dbPointer':
        return new DBRef(String(inner?.$ref ?? ''), decodeDoc(inner?.$id));
      default:
        return NOT_EXTENDED_JSON;
    }
  } catch {
    return NOT_EXTENDED_JSON;
  }
}

/** 一行一个文档（NDJSON）：大集合也能流式处理，不会一次性吃满内存。 */
export function encodeNdjson(docs: any[]): string {
  return docs.map((doc) => JSON.stringify(encodeDoc(doc))).join('\n') + (docs.length ? '\n' : '');
}

export function parseNdjson(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    out.push(decodeDoc(JSON.parse(trimmed)));
  }
  return out;
}

export function isFullBackupManifest(value: any): value is FullBackupManifest {
  return Boolean(
    value &&
      value.kind === BACKUP_KIND &&
      typeof value.version === 'number' &&
      value.version <= BACKUP_VERSION &&
      value.databases &&
      typeof value.databases === 'object',
  );
}

/** 备份文件名：vanblog-full-20260912-213000.tar.zst */
export function backupFileName(createdAt: Date, ext: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}` +
    `-${pad(createdAt.getHours())}${pad(createdAt.getMinutes())}${pad(createdAt.getSeconds())}`;
  return `vanblog-full-${stamp}${ext.startsWith('.') ? ext : `.${ext}`}`;
}

export function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${units[unit]}`;
}
