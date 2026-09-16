/**
 * 整站备份的**完整 BSON 往返**（导出 → 恢复），跑在真 mongod 上。
 *
 * 为什么必须有它：`test/backup-restore.e2e-spec.ts` 只覆盖了 JSON 导入导出，
 * **从来没有真的把一个含 BSON 类型的文档写进归档再恢复回来**。于是
 * mongoose 7→8（driver 5→6 / bson 5→6）升级之后，`utils/backupCodec.ts` 里
 * "从直接依赖的 mongodb@5 取 BSON 构造器"这个潜伏问题一路溜到生产：
 * 恢复整站备份时报
 * `Unsupported BSON version, bson types must be from bson 6.x.x`，
 * 第一个集合（articles）就 400，整个恢复功能不可用。
 *
 * 这里用 **mongoose 的连接**（`conn.getClient()`，与
 * `provider/backup/fullBackup.provider.ts` 完全一致）跑一遍真导出 + 真恢复，
 * 所以"driver 的序列化器认不认这些类型"是被真服务器验证过的，不是推出来的。
 *
 * ⚠️ 默认**整套跳过**（CI 上没有 mongod）。要跑就给一个**一次性库名**
 * （会 dropDatabase，代码里有硬护栏，绝不允许指向真实库）：
 *
 *   VANBLOG_BACKUP_BSON_URL='mongodb://127.0.0.1:27017/vanblog_backupbson_scratch?directConnection=true' \
 *     ./node_modules/.bin/jest --config ./test/jest-backup-restore-bson.json
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import mongoose from 'mongoose';

import { createFullBackup, restoreFullBackup, availableFormats } from 'src/utils/fullBackup';
import { encodeDoc } from 'src/utils/backupCodec';

const URL = process.env.VANBLOG_BACKUP_BSON_URL || '';
const d = URL ? describe : describe.skip;

d('full backup BSON round-trip against a real mongod', () => {
  jest.setTimeout(300000);
  let conn: mongoose.Connection;
  let dbName = '';
  let root = '';
  let staticPath = '';
  let outDir = '';
  let workDir = '';
  let archivePath = '';
  const logs: string[] = [];
  const logger = {
    log: (m: string) => logs.push(String(m)),
    warn: (m: string) => logs.push(`WARN ${m}`),
    error: (m: string) => logs.push(`ERROR ${m}`),
  };

  /** mongoose 自己那份 bson（driver 6）—— 种子数据必须用它，否则连插入都会失败 */
  const bson = () => (mongoose as any).mongo;

  beforeAll(async () => {
    dbName = URL.replace(/^[^/]*\/\/[^/]+\//, '').split('?')[0];
    if (
      !/^[A-Za-z0-9_-]+$/.test(dbName) ||
      /^(vanBlog|waline|admin|local|config|test)$/i.test(dbName) ||
      !/scratch|bench|tmp/i.test(dbName)
    ) {
      throw new Error(
        `VANBLOG_BACKUP_BSON_URL 必须指向一次性临时库（库名里要有 scratch/bench/tmp，解析出 "${dbName}"），拒绝执行`,
      );
    }
    conn = mongoose.createConnection(URL, {
      serverSelectionTimeoutMS: 4000,
      autoIndex: false,
    } as any);
    await conn.asPromise();
    await conn.db.dropDatabase();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-backup-bson-'));
    staticPath = path.join(root, 'static');
    outDir = path.join(root, 'backups');
    workDir = path.join(root, 'work');
    for (const p of [staticPath, outDir, workDir, path.join(staticPath, 'img')]) {
      fs.mkdirSync(p, { recursive: true });
    }
  });

  afterAll(async () => {
    if (conn) await conn.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('本机至少有一个可用的压缩器（否则这条量具没意义）', () => {
    expect(availableFormats().length).toBeGreaterThan(0);
  });

  it('种入含全部 BSON 类型的文档 + 一个静态文件，导出成归档', async () => {
    const B = bson();
    const articles = conn.db.collection('articles');
    await articles.insertMany([
      {
        // 显式给一个 ObjectId（真实归档里每个文档都有 _id，这正是第一个炸的类型）
        _id: new B.ObjectId('64b7f1c9e4b0a1b2c3d4e5f6'),
        id: 1,
        title: '一篇带各种 BSON 类型的文章',
        content: '正文里恰好有一个 {$oid: "看起来像扩展 JSON"} 的字符串，不该被误还原',
        createdAt: new Date('2026-09-13T14:09:55.000Z'),
        viewer: 123,
        tags: ['a', 'b'],
      },
      {
        id: 2,
        title: '二进制与高精度',
        bin: new B.Binary(Buffer.from('图床二进制内容'), 0),
        dec: B.Decimal128.fromString('3.14159265358979323846'),
        lng: B.Long.fromString('9007199254740993'), // 超过 Number.MAX_SAFE_INTEGER
        i32: new B.Int32(42),
        dbl: new B.Double(1.5),
        ts: new B.Timestamp({ t: 1700000000, i: 7 }),
        re: new B.BSONRegExp('^a', 'i'),
        nested: { list: [new B.ObjectId('64b7f1c9e4b0a1b2c3d4e5f7'), 'x', 3] },
        createdAt: new Date('2026-09-14T00:00:00.000Z'),
      },
    ]);
    await conn.db.collection('metas').insertOne({
      siteInfo: { siteName: 'BSON 往返测试站', baseUrl: 'https://example.invalid/' },
      viewer: 1,
      visited: 1,
    });
    fs.writeFileSync(path.join(staticPath, 'img', 'hello.webp'), Buffer.from('fake-webp-bytes'));
    // 静态目录根下再放一个文件：恢复要连整棵静态树一起回来
    fs.writeFileSync(path.join(staticPath, 'robots-extra.txt'), 'static-round-trip');

    const res = await createFullBackup({
      client: conn.getClient() as any,
      staticPath,
      dbName,
      outDir,
      workDir,
      format: 'auto',
      serverVersion: 'e2e-bson',
      logger: logger as any,
    });
    archivePath = res.path;
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(res.bytes).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `[导出] ${res.name} ${res.sizeText}（${res.format}），articles 计数=${
        res.manifest?.databases?.[dbName]?.collections?.articles?.count
      }`,
    );
    expect(res.manifest.databases[dbName].collections.articles.count).toBe(2);
  });

  it('清库之后用 mongoose 的连接恢复：不报 Unsupported BSON version', async () => {
    // 真的清干净：恢复必须是"重新插入"，而不是"本来就在"
    await conn.db.dropDatabase();
    fs.rmSync(path.join(staticPath, 'img', 'hello.webp'), { force: true });
    expect(await conn.db.collection('articles').countDocuments({})).toBe(0);

    const res = await restoreFullBackup({
      client: conn.getClient() as any,
      staticPath,
      archivePath,
      workDir,
      withStatic: true,
      logger: logger as any,
    });
    expect(res.databases[dbName].documents).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `[恢复] 用时 ${res.ms} ms，集合 ${res.databases[dbName].collections} 个、文档 ${
        res.databases[dbName].documents
      } 条，静态文件 ${JSON.stringify(res.static)}，notes=${JSON.stringify(res.notes)}`,
    );
  });

  it('恢复回来的文档类型与值逐一相同（含 ObjectId / Binary / Decimal128 / Long / Timestamp / RegExp）', async () => {
    const rows = await conn.db.collection('articles').find({}).sort({ id: 1 }).toArray();
    expect(rows).toHaveLength(2);
    const encoded = rows.map((r) => JSON.stringify(encodeDoc(r)));
    expect(encoded[0]).toContain('"$oid":"64b7f1c9e4b0a1b2c3d4e5f6"');
    expect(encoded[0]).toContain('一篇带各种 BSON 类型的文章');
    // 正文里那个"长得像扩展 JSON"的字符串必须仍然是字符串，没被误还原
    expect((rows[0] as any).content).toContain('{$oid: "看起来像扩展 JSON"}');
    expect((rows[0] as any).createdAt instanceof Date).toBe(true);

    const second: any = rows[1];
    expect(second.bin._bsontype).toBe('Binary');
    expect(Buffer.from(second.bin.buffer ?? second.bin).toString('utf8')).toBe('图床二进制内容');
    expect(String(second.dec)).toBe('3.14159265358979323846');
    expect(String(second.lng)).toBe('9007199254740993');
    expect(Number(second.i32)).toBe(42);
    expect(Number(second.dbl)).toBe(1.5);
    expect(second.ts._bsontype).toBe('Timestamp');
    // 驱动会把 BSON regex 提升成原生 RegExp（promoteValues 默认开），两种形态都接受；
    // 关键是 pattern 与 flags 要活着回来（改动前这里会被编码成 {}，值直接没了）
    const rePattern = second.re instanceof RegExp ? second.re.source : second.re?.pattern;
    const reFlags = second.re instanceof RegExp ? second.re.flags : second.re?.options;
    expect(String(rePattern)).toBe('^a');
    expect(String(reFlags)).toContain('i');
    expect(String(second.nested.list[0])).toBe('64b7f1c9e4b0a1b2c3d4e5f7');

    const meta: any = await conn.db.collection('metas').findOne({});
    expect(meta.siteInfo.siteName).toBe('BSON 往返测试站');
    // 静态文件也回来了
    expect(fs.existsSync(path.join(staticPath, 'img', 'hello.webp'))).toBe(true);
    expect(fs.readFileSync(path.join(staticPath, 'img', 'hello.webp'), 'utf8')).toBe(
      'fake-webp-bytes',
    );
  });

  it('恢复出来的库能被 mongoose 的模型正常读写（不是"插进去了但读不出来"）', async () => {
    const model = conn.model(
      'RoundTripArticle',
      new mongoose.Schema({ id: Number, title: String, content: String }, { collection: 'articles', strict: false }),
    );
    const found = await model.findOne({ id: 1 }).exec();
    expect(found).toBeTruthy();
    expect((found as any).title).toBe('一篇带各种 BSON 类型的文章');
    await model.updateOne({ id: 1 }, { $inc: { viewer: 1 } }).exec();
    const after: any = await conn.db.collection('articles').findOne({ id: 1 });
    expect(after.viewer).toBe(124);
  });
});

/**
 * `themes` 进归档（以及**老归档没有 themes 时仍然能恢复**）。
 *
 * 事故：后台上传的主题 CSS 存在 `<static>/themes/<id>-<hash8>.css`，而
 * `BACKUP_STATIC_FOLDERS` 以前只有 img/file/customPage ⇒ 主题从来不进归档；
 * 主题的元数据在 settings、启用状态在 metas（都随库备份），所以恢复之后
 * 后台显示"主题在、已启用"，`/api/public/theme` 照常列出它，
 * 只有 CSS 文件没了 ⇒ `/api/public/theme.css` 404，前台静默退回默认皮肤。
 */
d('themes 目录的备份往返（与老归档的向后兼容）', () => {
  jest.setTimeout(300000);
  let conn: mongoose.Connection;
  let dbName = '';
  let root = '';
  let staticPath = '';
  let outDir = '';
  let workDir = '';
  let legacyArchive = '';
  let themeArchive = '';
  let themeBytes = '';
  const logger = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  beforeAll(async () => {
    dbName = URL.replace(/^[^/]*\/\/[^/]+\//, '').split('?')[0];
    if (!/scratch|bench|tmp/i.test(dbName)) {
      throw new Error(`VANBLOG_BACKUP_BSON_URL 必须指向一次性临时库（解析出 "${dbName}"）`);
    }
    conn = mongoose.createConnection(URL, {
      serverSelectionTimeoutMS: 4000,
      autoIndex: false,
    } as any);
    await conn.asPromise();
    await conn.db.dropDatabase();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-themes-'));
    staticPath = path.join(root, 'static');
    outDir = path.join(root, 'backups');
    workDir = path.join(root, 'work');
    for (const p of [staticPath, outDir, workDir, path.join(staticPath, 'img')]) {
      fs.mkdirSync(p, { recursive: true });
    }
    await conn.db.collection('articles').insertOne({ id: 1, title: '主题往返' });
  });

  afterAll(async () => {
    if (conn) await conn.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('老归档（没有 static/themes）仍然能恢复，且不声称恢复了主题', async () => {
    // 这个归档是在"themes 目录还不存在"时导出的 —— 与线上已有归档的形状一致
    const res = await createFullBackup({
      client: conn.getClient() as any,
      staticPath,
      dbName,
      outDir,
      workDir,
      format: 'auto',
      logger: logger as any,
    });
    legacyArchive = res.path;
    expect(res.manifest.static.themes).toBeUndefined();

    const target = path.join(root, 'restored-legacy');
    fs.mkdirSync(path.join(target, 'img'), { recursive: true });
    const out = await restoreFullBackup({
      client: conn.getClient() as any,
      staticPath: target,
      archivePath: legacyArchive,
      workDir,
      withStatic: true,
      logger: logger as any,
    });
    expect(out.static.themes).toBeUndefined();
    expect(out.databases[dbName].documents).toBeGreaterThan(0);
  });

  it('有主题时：themes 进归档，manifest 记对文件数与字节数', async () => {
    const themeDir = path.join(staticPath, 'themes');
    fs.mkdirSync(themeDir, { recursive: true });
    themeBytes = `/* 自定义主题 */\n[data-ui="mine"] .card { border-radius: 12px; }\n`;
    fs.writeFileSync(path.join(themeDir, 'mine-1a2b3c4d.css'), themeBytes);
    fs.writeFileSync(path.join(themeDir, 'other-9f8e7d6c.css'), '/* 第二个主题 */\n');

    const res = await createFullBackup({
      client: conn.getClient() as any,
      staticPath,
      dbName,
      outDir,
      workDir,
      format: 'auto',
      logger: logger as any,
    });
    themeArchive = res.path;
    // eslint-disable-next-line no-console
    console.log(
      `[themes] manifest.static = ${JSON.stringify(res.manifest.static)}（归档 ${res.name} ${res.sizeText}）`,
    );
    // ⚠️ 字节数按 UTF-8 算（主题里有中文），不是 String.length 的 UTF-16 码元数
    expect(res.manifest.static.themes).toEqual({
      files: 2,
      bytes: Buffer.byteLength(themeBytes) + Buffer.byteLength('/* 第二个主题 */\n'),
    });
    expect(res.manifest.totals.files).toBeGreaterThanOrEqual(2);
  });

  it('恢复到一台"新机器"（空的静态目录）：主题 CSS 的字节一模一样', async () => {
    const target = path.join(root, 'restored-fresh');
    fs.mkdirSync(target, { recursive: true });
    const out = await restoreFullBackup({
      client: conn.getClient() as any,
      staticPath: target,
      archivePath: themeArchive,
      workDir,
      withStatic: true,
      logger: logger as any,
    });
    expect(out.static.themes).toEqual({ files: 2 });
    const restored = path.join(target, 'themes', 'mine-1a2b3c4d.css');
    expect(fs.existsSync(restored)).toBe(true);
    expect(fs.readFileSync(restored, 'utf8')).toBe(themeBytes);
    expect(
      fs.readFileSync(path.join(target, 'themes', 'other-9f8e7d6c.css'), 'utf8'),
    ).toBe('/* 第二个主题 */\n');
  });
});
