import mongoose from 'mongoose';
import * as directMongoDb from 'mongodb';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  BSON_SOURCE_LABEL,
  decodeDoc,
  encodeDoc,
  encodeNdjson,
  parseNdjson,
} from './utils/backupCodec';

/**
 * 整站备份的 **BSON 往返**钉子（P0 回归：恢复整站备份 400）。
 *
 * 事故：`utils/backupCodec.ts` 以前从 server **直接依赖的 `mongodb@5.9.1`**（bson 5.x）
 * 拿 `ObjectId` / `Binary` / … 这些构造器，而恢复走的是 **mongoose 8 自己那份驱动**
 * （mongodb 6.20.0 / bson 6.x，见 `provider/backup/fullBackup.provider.ts` 的
 * `connection.getClient()`）。bson 6 的序列化器会检查类型的"版本标记"，
 * 拿到 bson 5 的实例就抛
 * **`Unsupported BSON version, bson types must be from bson 6.x.x`** ⇒
 * 恢复第一个集合（articles）就 400，整个"整站恢复"不可用。
 *
 * mongoose 7 时代两边同为 bson 5，所以这个坑一直潜伏；而
 * `test/backup-restore.e2e-spec.ts` 只覆盖 JSON 导入导出、**没有 BSON 往返**，
 * 升级时没被测出来。这个文件补的就是那一块。
 *
 * ⚠️ 不需要真 mongod：失败发生在**序列化那一刻**（driver 把文档编码成 BSON 准备发出去），
 * 所以直接调 `mongoose.mongo.BSON.serialize()` 就能复现与验证。
 * 真库上的完整"导出→恢复"往返在 `test/backup-restore-bson.e2e-spec.ts`（env 开关，见该文件）。
 */

const BSON = (mongoose as any).mongo.BSON;

/** 一条文档过一遍"编码成 NDJSON 文本 → 解回 BSON → 用 mongoose 的驱动序列化 → 再解回来" */
function roundTripThroughDriver(doc: any) {
  const ndjson = encodeNdjson([doc]);
  const [decoded] = parseNdjson(ndjson);
  const buffer = BSON.serialize(decoded); // ← bson 5 的实例在这一步抛
  return BSON.deserialize(buffer);
}

describe('整站备份的 BSON 解码必须产出 mongoose 那份驱动认得的类型', () => {
  it('用的是 mongoose.mongo（而不是直接依赖的 mongodb@5）', () => {
    expect(BSON_SOURCE_LABEL).toBe('mongoose.mongo');
    // 反证：两份 bson 的 ObjectId 不是同一个类
    expect((mongoose as any).mongo.ObjectId).not.toBe((directMongoDb as any).ObjectId);
  });

  it('bson 5 的实例会被 mongoose 的驱动拒绝 —— 这就是那条 400 的成因（反证）', () => {
    const fromDirectDep = new (directMongoDb as any).ObjectId('64b7f1c9e4b0a1b2c3d4e5f6');
    expect(() => BSON.serialize({ _id: fromDirectDep })).toThrow(
      /Unsupported BSON version|bson types must be from bson 6/i,
    );
  });

  it('decodeDoc 造出来的 ObjectId 能被 mongoose 的驱动序列化并原样读回', () => {
    const decoded = decodeDoc({ $oid: '64b7f1c9e4b0a1b2c3d4e5f6' });
    const buffer = BSON.serialize({ _id: decoded });
    const back = BSON.deserialize(buffer);
    expect(String(back._id)).toBe('64b7f1c9e4b0a1b2c3d4e5f6');
  });

  it('全部 12 种 BSON 类型 + Date + 非有限数：完整往返（NDJSON → 解码 → driver 序列化 → 反序列化）', () => {
    const doc = {
      _id: { $oid: '64b7f1c9e4b0a1b2c3d4e5f6' },
      title: '一篇文章',
      createdAt: { $date: '2026-09-13T14:09:55.000Z' },
      bin: { $binary: { base64: Buffer.from('hello 图床').toString('base64'), subType: '00' } },
      dec: { $numberDecimal: '1.23' },
      lng: { $numberLong: '9007199254740993' },
      i32: { $numberInt: '42' },
      dbl: { $numberDouble: '1.5' },
      ts: { $timestamp: { t: 1700000000, i: 7 } },
      mn: { $minKey: 1 },
      mx: { $maxKey: 1 },
      re: { $regularExpression: { pattern: '^a', options: 'i' } },
      code: { $code: 'function () { return 1; }' },
      ref: { $dbPointer: { $ref: 'articles', $id: { $oid: '64b7f1c9e4b0a1b2c3d4e5f7' } } },
      inf: { $nonFiniteNumber: 'Infinity' },
      nested: { list: [{ $oid: '64b7f1c9e4b0a1b2c3d4e5f8' }, 'x', 3] },
    };
    const back = roundTripThroughDriver(doc);
    expect(String(back._id)).toBe('64b7f1c9e4b0a1b2c3d4e5f6');
    expect(back.title).toBe('一篇文章');
    expect(back.createdAt instanceof Date).toBe(true);
    expect(back.createdAt.toISOString()).toBe('2026-09-13T14:09:55.000Z');
    expect(Buffer.from(back.bin.buffer ?? back.bin).toString('utf8')).toBe('hello 图床');
    expect(String(back.dec)).toBe('1.23');
    expect(String(back.lng)).toBe('9007199254740993');
    expect(Number(back.i32)).toBe(42);
    expect(Number(back.dbl)).toBe(1.5);
    expect(String(back.re)).toContain('^a');
    expect(String(back.ref.collection ?? back.ref.namespace)).toBe('articles');
    expect(String(back.nested.list[0])).toBe('64b7f1c9e4b0a1b2c3d4e5f8');
    expect(back.inf).toBe(Infinity);
  });

  it('导出侧不受影响：不管实例来自哪一份 bson，encodeDoc 的结果都一样（老归档因此仍然可读）', () => {
    const hex = '64b7f1c9e4b0a1b2c3d4e5f6';
    const viaMongoose = new (mongoose as any).mongo.ObjectId(hex);
    const viaDirectDep = new (directMongoDb as any).ObjectId(hex);
    expect(encodeDoc({ _id: viaMongoose })).toEqual({ _id: { $oid: hex } });
    expect(encodeDoc({ _id: viaDirectDep })).toEqual({ _id: { $oid: hex } });
    // 两份 bson 的 Binary 也一样（encodeDoc 按 _bsontype 判别，不做 instanceof）
    const buf = Buffer.from('abc');
    expect(encodeDoc({ b: new (mongoose as any).mongo.Binary(buf, 0) })).toEqual(
      encodeDoc({ b: new (directMongoDb as any).Binary(buf, 0) }),
    );
  });

  it('原生 RegExp 也会被编码成 $regularExpression（改动前它掉进"普通对象"分支被编码成 {}，值就没了）', () => {
    // 驱动读库时把 BSON regex 提升成原生 RegExp（promoteValues 默认开），
    // 所以导出时拿到的就是原生 RegExp —— 它没有 _bsontype，Object.keys() 也是空的
    expect(encodeDoc({ re: /^a/i })).toEqual({
      re: { $regularExpression: { pattern: '^a', options: 'i' } },
    });
    const back = roundTripThroughDriver({ re: /^a/i });
    const pattern = back.re instanceof RegExp ? back.re.source : back.re?.pattern;
    expect(String(pattern)).toBe('^a');
    // 反证：改动前那条路会得到 {}
    expect(Object.keys(encodeDoc({ re: /^a/i }).re)).not.toEqual([]);
  });

  it('源码级钉子：构造器不再从直接依赖的 mongodb 里 import（剥掉注释再断言）', () => {
    const src = readFileSync(join(__dirname, 'utils/backupCodec.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    // 允许 `import * as directMongoDb from 'mongodb'` 作为兜底，但不允许再从它解构 BSON 类型
    expect(src).not.toMatch(/import\s*\{[^}]*ObjectId[^}]*\}\s*from\s*'mongodb'/);
    expect(src).toContain('mongoose.mongo');
    expect(src).toContain('pickBsonSource()');
  });
});
