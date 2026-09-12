import { Binary, BSONRegExp, Code, DBRef, Decimal128, Long, MaxKey, MinKey, ObjectId, Timestamp } from 'mongodb';
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  backupFileName,
  decodeDoc,
  encodeDoc,
  encodeNdjson,
  formatBytes,
  isFullBackupManifest,
  parseNdjson,
} from './backupCodec';

describe('encodeDoc / decodeDoc', () => {
  it('round-trips every BSON type the dump can meet', () => {
    const doc = {
      _id: new ObjectId('668a41e95497d2b9081db67e'),
      id: 53,
      title: '标题 with "quotes" and \\ backslash',
      createdAt: new Date('2024-07-07T07:31:35.821Z'),
      binary: new Binary(Buffer.from([1, 2, 3, 250]), 0),
      decimal: Decimal128.fromString('1234.5678'),
      long: Long.fromString('9007199254740993'),
      timestamp: new Timestamp({ t: 1700000000, i: 1 }),
      minKey: new MinKey(),
      maxKey: new MaxKey(),
      regex: new BSONRegExp('^abc$', 'i'),
      code: new Code('function () { return 1; }'),
      ref: new DBRef('articles', new ObjectId('668a41e95497d2b9081db67e')),
      nested: { list: [1, 'two', { three: new Date(0) }], deep: { deeper: { x: null } } },
      plain: { a: 1, b: 1.5, c: true, d: null },
    };

    const encoded = JSON.parse(JSON.stringify(encodeDoc(doc)));
    const decoded: any = decodeDoc(encoded);

    expect(decoded._id.toString()).toBe(doc._id.toString());
    expect(decoded._id._bsontype).toBe('ObjectId');
    expect(decoded.createdAt instanceof Date).toBe(true);
    expect(decoded.createdAt.toISOString()).toBe('2024-07-07T07:31:35.821Z');
    expect(Buffer.from(decoded.binary.value(true))).toEqual(Buffer.from([1, 2, 3, 250]));
    expect(decoded.decimal.toString()).toBe('1234.5678');
    expect(decoded.long.toString()).toBe('9007199254740993');
    expect(decoded.timestamp._bsontype).toBe('Timestamp');
    expect(decoded.minKey._bsontype).toBe('MinKey');
    expect(decoded.maxKey._bsontype).toBe('MaxKey');
    expect(decoded.regex.pattern).toBe('^abc$');
    expect(decoded.code._bsontype).toBe('Code');
    expect(decoded.ref._bsontype).toBe('DBRef');
    expect(decoded.nested.list[2].three instanceof Date).toBe(true);
    expect(decoded.plain).toEqual({ a: 1, b: 1.5, c: true, d: null });
    expect(decoded.title).toBe(doc.title);
  });

  it('writes canonical EJSON shapes', () => {
    const encoded: any = encodeDoc({
      _id: new ObjectId('668a41e95497d2b9081db67e'),
      at: new Date('2026-09-12T00:00:00.000Z'),
      buf: Buffer.from('hi'),
    });
    expect(encoded._id).toEqual({ $oid: '668a41e95497d2b9081db67e' });
    expect(encoded.at).toEqual({ $date: '2026-09-12T00:00:00.000Z' });
    expect(encoded.buf.$binary.base64).toBe(Buffer.from('hi').toString('base64'));
    expect(encoded.buf.$binary.subType).toBe('00');
  });

  it('does not mistake article content for extended JSON', () => {
    // 两个键 -> 一定不是扩展 JSON
    const twoKeys = { $date: '2020-01-01', note: '正文里恰好这么写' };
    expect(decodeDoc(twoKeys)).toEqual(twoKeys);

    // 单键但内容非法 -> 退回普通对象，而不是抛错把整次恢复带崩
    const bogus = { $oid: 'not-an-object-id' };
    expect(decodeDoc(bogus)).toEqual(bogus);

    const unknown = { $whatever: 1 };
    expect(decodeDoc(unknown)).toEqual(unknown);
  });

  it('handles non-finite numbers and undefined', () => {
    expect(decodeDoc(encodeDoc({ a: Infinity, b: -Infinity, c: NaN }))).toEqual({
      a: Infinity,
      b: -Infinity,
      c: NaN,
    });
    expect(encodeDoc(undefined)).toBeNull();
  });

  it('round-trips NDJSON batches', () => {
    const docs = [
      { _id: new ObjectId(), n: 1, at: new Date('2026-01-01T00:00:00Z') },
      { _id: new ObjectId(), n: 2, at: new Date('2026-01-02T00:00:00Z') },
    ];
    const text = encodeNdjson(docs);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(2);

    const parsed: any[] = parseNdjson(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].n).toBe(1);
    expect(parsed[1].at instanceof Date).toBe(true);
    expect(parsed[1]._id.toString()).toBe(docs[1]._id.toString());
    expect(encodeNdjson([])).toBe('');
    expect(parseNdjson('')).toEqual([]);
  });
});

describe('manifest helpers', () => {
  const manifest = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    format: 'zstd',
    compressor: 'zstd -19',
    databases: { vanBlog: { collections: { articles: { count: 1, bytes: 2, indexes: 1 } } } },
    static: {},
    totals: { databases: 1, collections: 1, documents: 1, files: 0, staticBytes: 0 },
  };

  it('accepts a valid manifest only', () => {
    expect(isFullBackupManifest(manifest)).toBe(true);
    expect(isFullBackupManifest({ ...manifest, kind: 'something-else' })).toBe(false);
    expect(isFullBackupManifest({ ...manifest, version: BACKUP_VERSION + 1 })).toBe(false);
    expect(isFullBackupManifest(null)).toBe(false);
    expect(isFullBackupManifest({ kind: BACKUP_KIND })).toBe(false);
  });

  it('names archives with a sortable timestamp', () => {
    const name = backupFileName(new Date('2026-09-12T21:46:16'), '.tar.zst');
    expect(name).toBe('vanblog-full-20260912-214616.tar.zst');
    expect(backupFileName(new Date('2026-01-02T03:04:05'), 'tar.gz')).toBe(
      'vanblog-full-20260102-030405.tar.gz',
    );
    // 名字排好序 == 时间排好序
    expect(
      ['vanblog-full-20260912-214616.tar.zst', 'vanblog-full-20260912-215129.tar.zst'].sort(),
    ).toEqual(['vanblog-full-20260912-214616.tar.zst', 'vanblog-full-20260912-215129.tar.zst']);
  });

  it('formats byte counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.00 KB');
    // >=10 时保留 1 位小数，>=100 时不留（够用就好，别在 UI 上堆数字）
    expect(formatBytes(69107127)).toBe('65.9 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 1.5)).toBe('1.50 GB');
  });
});
