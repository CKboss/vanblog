import {
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
} from 'mongodb';

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
 */

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

export interface FullBackupManifest {
  kind: typeof BACKUP_KIND;
  version: number;
  createdAt: string;
  format: string;
  compressor: string;
  serverVersion?: string;
  databases: Record<string, DatabaseSummary>;
  static: Record<string, StaticSummary>;
  totals: {
    databases: number;
    collections: number;
    documents: number;
    files: number;
    staticBytes: number;
    archiveBytes?: number;
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
