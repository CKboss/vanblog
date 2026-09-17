/**
 * 整站备份的**100% 保真往返**（P3）：文章历史版本 / 迁移账本 / 回收站，跑在真 mongod 上。
 *
 * owner 的原话是「我想要的是 100% 恢复原站点, 恢复各类数据比如文章历史」。
 * 而"文章历史"（`revisions` 集合）恰恰是最容易在一次恢复里**静默丢失**的东西：
 * 它不在任何列表页上、丢了也不报错，只有当你想回滚某篇文章时才发现历史没了。
 * 所以这一套用真库、真 BSON、真 tar + 真压缩器，把
 *   种子数据 -> 导出 -> **dropDatabase** -> 恢复 -> 逐字段比对
 * 完整跑一遍，比对的是 `content` / `savedAt`（毫秒）/ `reason` / `wordCount` /
 * `sizeBytes` / `title` / `_id` 全部字段，而不是"条数对得上"。
 *
 * ⚠️ 默认**整套跳过**（CI 上没有 mongod）。要跑：
 *
 *   # 1) 起一个**一次性** mongod（⚠️ 不要用开发栈那个 27017：恢复按清单里的库名写库，
 *   #    指到开发实例等于覆盖真数据）
 *   .tools/mongodb/bin/mongod --port 27019 --dbpath <tmp>/mongo --bind_ip 127.0.0.1 \
 *     --logpath <tmp>/mongod.log --fork
 *
 *   # 2) 跑这一套（库名里必须有 scratch/bench/tmp，端口不能是 27017，代码里有硬护栏）
 *   VANBLOG_BACKUP_FIDELITY_URL='mongodb://127.0.0.1:27019/vanblog_fidelity_scratch?directConnection=true' \
 *     ./node_modules/.bin/jest --config ./test/jest-backup-fidelity.json
 *
 * 这一套会 **dropDatabase**（只 drop 它自己那个一次性库）并做真恢复。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import mongoose from 'mongoose';

import { createFullBackup, restoreFullBackup } from 'src/utils/fullBackup';
import { verifyFullBackup } from 'src/utils/backupVerify';
import { encodeDoc } from 'src/utils/backupCodec';
import { RevisionProvider } from 'src/provider/revision/revision.provider';
import { MigrationProvider } from 'src/provider/migration/migration.provider';
import { ArticleSchema } from 'src/scheme/article.schema';
import { RevisionSchema } from 'src/scheme/revision.schema';
import { MigrationSchema } from 'src/scheme/migration.schema';
import { RESTORE_JOURNAL_FILE, readRestoreJournal } from 'src/utils/restoreJournal';

const URL = process.env.VANBLOG_BACKUP_FIDELITY_URL || '';
const d = URL ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 加密文章在库里存的密码哈希（模块级：种子与恢复后的断言要用同一个值） */
const STORED_PASSWORD_HASH = 'scrypt$16384$8$1$saltsaltsaltsalt$' + 'a1'.repeat(32) + '==';

/** mongoose 的 Connection 类型上没有 client，用 getClient()（provider 里也是这么拿的） */
let connRef: mongoose.Connection | null = null;
function clientOf(): any {
  return (connRef as any).getClient();
}

/**
 * 逐文档逐字段比对，失败时**只报第一个不同的字段**（不要把几百行 JSON 甩进 diff 里 ——
 * jest 会打出一份几 MB 的对照，把真正的差别埋掉）。
 */
function expectSameDocs(
  label: string,
  before: any[],
  after: any[],
  sortKey: (doc: any) => string = (doc) => String(doc?._id?.toString?.() ?? doc?._id),
): void {
  const a = [...before].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1));
  const b = [...after].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1));
  if (a.length !== b.length) {
    // 条数不对时不要甩 JSON diff：一句话说清差多少
    throw new Error(`${label}: 条数不一致（备份前 ${a.length} 条，恢复后 ${b.length} 条）`);
  }
  for (let i = 0; i < a.length; i += 1) {
    const wantFields = encodeDoc(a[i].toObject ? a[i].toObject() : a[i]);
    const gotFields = encodeDoc(b[i].toObject ? b[i].toObject() : b[i]);
    const keys = Array.from(
      new Set([...Object.keys(wantFields || {}), ...Object.keys(gotFields || {})]),
    ).sort();
    for (const key of keys) {
      const want = JSON.stringify(wantFields?.[key] ?? null);
      const got = JSON.stringify(gotFields?.[key] ?? null);
      if (want !== got) {
        // 点名到"哪一条的哪个字段"，并给出两边的值（值本身可能很长，截断到 200 字）
        throw new Error(
          `${label} 第 ${i} 条（${sortKey(a[i])}）字段 ${key} 不一致：\n` +
            `  备份前 = ${want.slice(0, 200)}\n  恢复后 = ${got.slice(0, 200)}`,
        );
      }
    }
  }
}

d('整站备份 100% 保真往返（真 mongod）', () => {
  jest.setTimeout(600000);

  let conn: mongoose.Connection;
  let dbName = '';
  let walineDbName = '';
  let root = '';
  let staticPath = '';
  let outDir = '';
  let workDir = '';
  let archivePath = '';
  let Article: any;
  let revisions: RevisionProvider;
  let migrations: MigrationProvider;
  let revisionModel: any;
  let migrationModel: any;

  const beforeRevisions: any[] = [];
  const beforeMigrations: any[] = [];
  const beforeArticles: any[] = [];
  const logs: string[] = [];
  const logger = {
    log: (message: string) => logs.push(String(message)),
    warn: (message: string) => logs.push(`WARN ${message}`),
  };

  beforeAll(async () => {
    // ── 硬护栏：绝不允许指向开发/生产实例 ──────────────────────────────────────
    dbName = URL.replace(/^[^/]*\/\/[^/]+\//, '').split('?')[0];
    let port = 27017;
    const hostPort = /^[^/]*\/\/([^/?]+)/.exec(URL)?.[1] || '';
    const portMatch = /:(\d+)$/.exec(hostPort.split('@').pop() || '');
    if (portMatch) port = Number(portMatch[1]);
    if (port === 27017) {
      throw new Error(
        `拒绝执行：VANBLOG_BACKUP_FIDELITY_URL 指向 27017（开发栈那个实例）。` +
          `这一套会 dropDatabase 并做真恢复，请换一次性端口（例如 27019）。URL 端口解析为 ${port}`,
      );
    }
    if (
      !/^[A-Za-z0-9_-]+$/.test(dbName) ||
      /^(vanBlog|waline|admin|local|config|test)$/i.test(dbName) ||
      !/scratch|bench|tmp/i.test(dbName)
    ) {
      throw new Error(
        `VANBLOG_BACKUP_FIDELITY_URL 必须指向一次性临时库（库名里要有 scratch/bench/tmp，解析出 "${dbName}"），拒绝执行`,
      );
    }
    walineDbName = `${dbName}_waline`;

    conn = mongoose.createConnection(URL, {
      serverSelectionTimeoutMS: 5000,
      autoIndex: false,
    } as any);
    await conn.asPromise();
    connRef = conn;
    await conn.db.dropDatabase();
    await clientOf().db(walineDbName).dropDatabase();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-fidelity-'));
    staticPath = path.join(root, 'static');
    outDir = path.join(root, 'backups');
    workDir = path.join(root, 'work');
    for (const p of [
      staticPath,
      outDir,
      workDir,
      path.join(staticPath, 'img', 'thumb'),
      path.join(staticPath, 'themes'),
      path.join(staticPath, 'file'),
    ]) {
      fs.mkdirSync(p, { recursive: true });
    }

    Article = conn.model('Article', ArticleSchema);
    revisionModel = conn.model('Revision', RevisionSchema);
    migrationModel = conn.model('Migration', MigrationSchema);
    revisions = new RevisionProvider(revisionModel);
    migrations = new MigrationProvider(migrationModel);
  });

  afterAll(async () => {
    try {
      if (conn) {
        await conn.db.dropDatabase();
        await clientOf().db(walineDbName).dropDatabase();
        await conn.close();
      }
    } catch {
      // 收尾失败不影响测试结论
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('种子：一篇活文章 + 12 次编辑产生的历史（含 pre-restore）+ 一篇软删文章 + 迁移账本 + 静态文件', async () => {
    // 一篇正常文章（历史版本挂在它的 id 上）
    await Article.create({
      id: 1,
      title: '第一篇',
      content: '# v1\n\n正文一',
      pathname: 'di-yi-pian',
      createdAt: new Date('2024-07-07T07:31:35.821Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      deleted: false,
      deletedAt: null,
      wordCount: 6,
    });
    // 一篇软删文章（回收站）：deleted + deletedAt 都必须原样回来
    await Article.create({
      id: 2,
      title: '被删掉的那篇',
      content: '# gone\n\n这篇在回收站里',
      pathname: 'bei-shan-diao-de-na-pian',
      createdAt: new Date('2024-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-05T00:00:00.000Z'),
      deleted: true,
      deletedAt: new Date('2026-09-05T03:04:05.678Z'),
      wordCount: 11,
    });

    // 一篇**加密文章**：库里存的是密码哈希。整站备份走的是**原生 driver**
    // （`client.db().collection().find()` + `insertMany`），完全不经过 mongoose 的
    // toJSON transform，所以哈希必须原样进、原样出 —— 这一条就是那个结论的证据，
    // 而不是推理（JSON 那条 `/api/admin/backup/export` 走的是模型序列化，形状不同）。
    await Article.create({
      id: 3,
      title: '加密的那篇',
      content: '# secret\n\n只有密码能看',
      pathname: 'jia-mi-de-na-pian',
      hidden: true,
      password: STORED_PASSWORD_HASH,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-06T00:00:00.000Z'),
      deleted: false,
      deletedAt: null,
      wordCount: 8,
    });

    // 12 次"编辑"：keep 默认 10 ⇒ 会淘汰最旧的 2 条（淘汰后的状态也必须原样恢复）
    expect(revisions.keep()).toBe(10);
    let previous = { title: '第一篇', content: '# v1\n\n正文一' };
    for (let i = 2; i <= 12; i += 1) {
      const next = { title: `第一篇 v${i}`, content: `# v${i}\n\n正文 ${i} —— 中文与 ASCII mixed` };
      const written = await revisions.appendSafe(1, previous, next, 'update');
      expect(written).not.toBeNull();
      previous = next;
      // savedAt 要有先后顺序（同一毫秒会让淘汰顺序变得不可判定）
      await sleep(6);
    }
    // 一次"恢复历史版本"：控制器会先给当前状态记一条 reason='pre-restore'
    const preRestore = await revisions.append(
      1,
      { title: previous.title, content: previous.content },
      'pre-restore',
    );
    expect(preRestore?.reason).toBe('pre-restore');
    // 第二篇文章也留一条，证明淘汰是**按文章**而不是全表
    await revisions.append(2, { title: '被删掉的那篇', content: '# gone\n\n这篇在回收站里' }, 'update');

    const kept = await revisionModel.find({ articleId: 1 }).sort({ savedAt: -1 }).lean();
    expect(kept.length).toBe(10); // 12 次 update + 1 次 pre-restore，淘汰到 10 条
    expect(kept.some((doc: any) => doc.reason === 'pre-restore')).toBe(true);

    // 迁移账本（`migrations` 集合：丢了它，"哪些清洗跑过"就没有记录了）
    await migrations.record({
      key: 'wash:userSalt',
      kind: 'wash',
      outcome: 'ok',
      durationMs: 12,
      detail: { scanned: 3, changed: 1 },
      ranAt: new Date('2026-09-10T01:02:03.456Z'),
    });
    await migrations.record({
      key: 'index:visits.date_pathname.unique',
      kind: 'index',
      outcome: 'error',
      durationMs: 4,
      detail: 'E11000 duplicate key',
      ranAt: new Date('2026-09-11T04:05:06.789Z'),
    });
    await migrations.record({
      key: 'recompute:meta.totalWordCount',
      kind: 'recompute',
      outcome: 'skipped',
      durationMs: 0,
      ranAt: new Date('2026-09-12T07:08:09.000Z'),
    });

    // waline 库（第二个数据库也要往返）
    await clientOf().db(walineDbName).collection('Comment').insertOne({
      _id: new (mongoose as any).mongo.ObjectId(),
      comment: '<p>一条评论</p>',
      insertedAt: new Date('2026-09-13T10:00:00.000Z'),
    });

    // 静态文件（顺带覆盖 P3 的修剪）
    fs.writeFileSync(path.join(staticPath, 'img', 'a.webp'), 'image-a-bytes');
    fs.writeFileSync(path.join(staticPath, 'img', 'thumb', 'a.webp'), 'thumb-a');
    fs.writeFileSync(path.join(staticPath, 'themes', 'warm-12345678.css'), 'body{color:red}');
    fs.writeFileSync(path.join(staticPath, 'file', 'doc.pdf'), '%PDF-1.4');

    // 索引：连接是 autoIndex:false 起的（不让 mongoose 在测试里偷偷建索引），
    // 所以这里显式建出生产环境本来就有的那几个 —— 否则"索引往返"根本无从验起
    // （归档里只会有一条 `_id_`，恢复后自然也只有它，测试会假绿）。
    await revisionModel.collection.createIndex({ articleId: 1, savedAt: -1 });
    await revisionModel.collection.createIndex({ articleId: 1 });
    await migrationModel.collection.createIndex({ key: 1 }, { unique: true });
    await migrationModel.collection.createIndex({ ranAt: 1 });
    expect((await revisionModel.collection.indexes()).length).toBe(3);

    beforeRevisions.push(...(await revisionModel.find({}).lean()));
    beforeMigrations.push(...(await migrationModel.find({}).lean()));
    beforeArticles.push(...(await Article.find({}).lean()));
    expect(beforeRevisions.length).toBe(11); // 10（文章 1）+ 1（文章 2）
    expect(beforeMigrations.length).toBe(3);
    expect(beforeArticles.length).toBe(3);
  });

  it('导出真归档，并通过成员级校验（含 integrity 块与 .sha256 sidecar）', async () => {
    const result = await createFullBackup({
      client: clientOf(),
      staticPath,
      dbName,
      walineDbName,
      format: 'zstd',
      outDir,
      workDir,
      source: {
        codeVersion: 'v2026.9.1@test',
        walineDB: walineDbName,
        demo: false,
        hostname: os.hostname(),
        staticPath,
        codeRunnerPath: path.join(root, 'codeRunner'),
      },
      logger,
    } as any);
    archivePath = result.path;
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(fs.existsSync(`${archivePath}.sha256`)).toBe(true);
    expect(result.manifest.integrity).toBeTruthy();
    expect(result.manifest.databases[dbName].collections.revisions.count).toBe(11);
    expect(result.manifest.databases[dbName].collections.migrations.count).toBe(3);
    expect(result.manifest.databases[walineDbName].collections.Comment.count).toBe(1);

    const verification = await verifyFullBackup(archivePath, { deep: true });
    expect(verification.issues).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.integrity.membersChecked).toBeGreaterThan(0);
  });

  it('dropDatabase 之后恢复：历史版本逐字段一致（content/savedAt/reason/wordCount/sizeBytes/title/_id）', async () => {
    // 恢复之前先在目标库里放一张"归档里没有的表"，用来验 P3 的混合状态报告
    await conn.db.dropDatabase();
    await clientOf().db(walineDbName).dropDatabase();
    await conn.db.collection('post_export_junk').insertMany([{ _id: 1 }, { _id: 2 }] as any);
    // 静态目录里放一个孤儿文件（备份之后才上传的），恢复后必须被修剪掉
    fs.writeFileSync(path.join(staticPath, 'img', 'orphan-after-backup.webp'), 'orphan');

    const journalPath = path.join(outDir, RESTORE_JOURNAL_FILE);
    const result = await restoreFullBackup({
      client: clientOf(),
      staticPath,
      archivePath,
      workDir,
      journalPath,
      target: { walineDB: walineDbName, demo: false, codeVersion: 'v2026.9.1@test' },
      logger,
    } as any);

    // 历史版本：条数 + 每条的每个字段
    const afterRevisions = await revisionModel.find({}).lean();
    expectSameDocs('revisions', beforeRevisions, afterRevisions, (doc: any) =>
      String(doc._id?.toString?.() ?? doc._id),
    );
    // 关键字段再点名断言一遍（万一上面那条比对被改坏，这里也会红）
    const preRestore = afterRevisions.find((doc: any) => doc.reason === 'pre-restore');
    expect(preRestore).toBeTruthy();
    const beforePreRestore = beforeRevisions.find((doc: any) => doc.reason === 'pre-restore');
    expect(preRestore!.content).toBe(beforePreRestore!.content);
    expect((preRestore!.savedAt as Date).getTime()).toBe(
      (beforePreRestore!.savedAt as Date).getTime(),
    );
    expect(preRestore!.wordCount).toBe(beforePreRestore!.wordCount);
    expect(preRestore!.sizeBytes).toBe(beforePreRestore!.sizeBytes);
    // savedAt 必须是**真的 Date**（BSON 往返），不是字符串
    expect(preRestore!.savedAt instanceof Date).toBe(true);
    expect(afterRevisions[0]._id instanceof (mongoose as any).mongo.ObjectId).toBe(true);

    // 上限/淘汰状态自洽：恢复后仍然是每篇 ≤ keep 条，且是**同样的那 10 条**
    expect(revisions.keep()).toBe(10);
    const article1 = afterRevisions
      .filter((doc: any) => doc.articleId === 1)
      .sort((a: any, b: any) => (a.savedAt < b.savedAt ? 1 : -1));
    expect(article1.length).toBe(10);
    const beforeArticle1 = beforeRevisions
      .filter((doc: any) => doc.articleId === 1)
      .map((doc: any) => String(doc._id.toString()))
      .sort();
    expect(article1.map((doc: any) => String(doc._id.toString())).sort()).toEqual(beforeArticle1);
    // provider 自己数一遍（走的是真查询，不是我们手边的数组）
    expect(await revisions.countFor(1)).toBe(10);
    expect(await revisions.countFor(2)).toBe(1);

    // 迁移账本
    const afterMigrations = await migrationModel.find({}).lean();
    expectSameDocs('migrations', beforeMigrations, afterMigrations, (doc: any) => String(doc.key));
    const errored = afterMigrations.find((doc: any) => doc.key === 'index:visits.date_pathname.unique');
    expect(errored!.outcome).toBe('error');
    expect(errored!.lastError).toBe('E11000 duplicate key');
    expect((errored!.lastErrorAt as Date).getTime()).toBe(
      (beforeMigrations.find((doc: any) => doc.key === errored!.key)!.lastErrorAt as Date).getTime(),
    );

    // 文章（含软删那篇的 deleted / deletedAt）
    const afterArticles = await Article.find({}).lean();
    expectSameDocs('articles', beforeArticles, afterArticles, (doc: any) => String(doc.id));
    const deletedArticle = afterArticles.find((doc: any) => doc.id === 2);
    expect(deletedArticle!.deleted).toBe(true);
    expect((deletedArticle!.deletedAt as Date).toISOString()).toBe('2026-09-05T03:04:05.678Z');
    expect(deletedArticle!.deletedAt instanceof Date).toBe(true);

    // 加密文章的密码**存储值**必须逐字节回来（不是 hasPassword:true，也不是空串）
    const encrypted = afterArticles.find((doc: any) => doc.id === 3);
    expect(encrypted!.password).toBe(STORED_PASSWORD_HASH);
    expect((encrypted as any).hasPassword).toBeUndefined();

    // 第二个数据库（waline）也回来了
    const comments = await clientOf().db(walineDbName).collection('Comment').find({}).toArray();
    expect(comments.length).toBe(1);
    expect(comments[0].comment).toBe('<p>一条评论</p>');

    // 恢复结果里的计数
    expect(result.databases[dbName].collections).toBeGreaterThanOrEqual(3);
    expect(result.databases[walineDbName].documents).toBe(1);

    // P5：成功恢复之后断点日志被删掉
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(readRestoreJournal(outDir)).toBeNull();
  });

  it('静态文件回来了，备份之后才有的孤儿被修剪掉（P3）', async () => {
    expect(fs.readFileSync(path.join(staticPath, 'img', 'a.webp'), 'utf8')).toBe('image-a-bytes');
    expect(fs.readFileSync(path.join(staticPath, 'img', 'thumb', 'a.webp'), 'utf8')).toBe('thumb-a');
    expect(fs.readFileSync(path.join(staticPath, 'themes', 'warm-12345678.css'), 'utf8')).toBe(
      'body{color:red}',
    );
    expect(fs.readFileSync(path.join(staticPath, 'file', 'doc.pdf'), 'utf8')).toBe('%PDF-1.4');
    expect(fs.existsSync(path.join(staticPath, 'img', 'orphan-after-backup.webp'))).toBe(false);
  });

  it('归档里没有的表被报告出来（名字 + 条数），默认**不删**；开关打开才删', async () => {
    const mongoUrlDb = conn.db;
    const names = (await mongoUrlDb.collections()).map((item) => item.collectionName);
    expect(names).toContain('post_export_junk');

    // 再恢复一次，这次带上"归档里没有的表"的开关
    const result = await restoreFullBackup({
      client: clientOf(),
      staticPath,
      archivePath,
      workDir,
      dropAbsentCollections: true,
      target: { walineDB: walineDbName, demo: false },
      logger,
    } as any);
    const absent = result.absentCollections.filter(
      (item) => item.db === dbName && item.collection === 'post_export_junk',
    );
    expect(absent).toEqual([
      { db: dbName, collection: 'post_export_junk', documents: 2, dropped: true },
    ]);
    const after = (await mongoUrlDb.collections()).map((item) => item.collectionName);
    expect(after).not.toContain('post_export_junk');
    // revisions / migrations 这些**归档里有**的表绝不能被当成"归档里没有"删掉
    expect(after).toContain('revisions');
    expect(after).toContain('migrations');
    expect(after).toContain('articles');
    expect(await revisions.countFor(1)).toBe(10);
  });

  it('waline 库名不一致时，恢复会 WARN 点名两个值（真库上验一次）', async () => {
    const result = await restoreFullBackup({
      client: clientOf(),
      staticPath,
      archivePath,
      workDir,
      target: { walineDB: 'some_other_waline_db', demo: false },
      logger,
    } as any);
    const warn = result.notes.find((note) => note.startsWith('WARN waline'));
    expect(warn).toBeTruthy();
    expect(warn).toContain(walineDbName);
    expect(warn).toContain('some_other_waline_db');
  });

  it('索引也跟着回来了（复合索引与唯一索引都要在）', async () => {
    const revisionIndexes = await revisionModel.collection.indexes();
    const revisionKeys = revisionIndexes.map((item: any) => JSON.stringify(item.key));
    expect(revisionKeys).toContain(JSON.stringify({ articleId: 1, savedAt: -1 }));
    expect(revisionKeys).toContain(JSON.stringify({ articleId: 1 }));
    expect(revisionIndexes.length).toBe(3); // _id_ + 两个

    const migrationIndexes = await migrationModel.collection.indexes();
    const unique = migrationIndexes.find((item: any) => JSON.stringify(item.key) === JSON.stringify({ key: 1 }));
    expect(unique).toBeTruthy();
    // 唯一性这个**选项**也要跟着回来（丢了它，账本就可能写出重复 key）
    expect(unique!.unique).toBe(true);
    expect(migrationIndexes.map((item: any) => JSON.stringify(item.key))).toContain(
      JSON.stringify({ ranAt: 1 }),
    );
  });
});
