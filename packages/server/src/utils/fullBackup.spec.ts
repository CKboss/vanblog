import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ObjectId, Decimal128 } from 'mongodb';
import {
  BACKUP_STATIC_FOLDERS,
  availableFormats,
  createFullBackup,
  detectFormat,
  listFullBackups,
  pickSpec,
  restoreFullBackup,
} from './fullBackup';

// 打包/解包要跑真实的 tar + 压缩器，别被默认 5s 卡住
jest.setTimeout(120000);

/** 内存版 MongoClient，只实现备份/恢复用到的那几个方法。 */
function createFakeMongo(
  initial: Record<string, Record<string, any[]>> = {},
  indexDefs: Record<string, any[]> = {},
) {
  // 不能用 JSON 深拷贝：那会把 ObjectId / Date / Decimal128 变成字符串，
  // 备份保真度就测不出来了。这里只做浅拷贝。
  const state: Record<string, Record<string, any[]>> = {};
  for (const dbName of Object.keys(initial)) {
    state[dbName] = {};
    for (const collectionName of Object.keys(initial[dbName])) {
      state[dbName][collectionName] = [...initial[dbName][collectionName]];
    }
  }
  const createdIndexes: any[] = [];

  const client: any = {
    db(name: string) {
      if (!state[name]) {
        state[name] = {};
      }
      return {
        databaseName: name,
        collections: async () =>
          Object.keys(state[name])
            .sort()
            .map((collectionName) => ({ collectionName })),
        collection(collectionName: string) {
          if (!state[name][collectionName]) {
            state[name][collectionName] = [];
          }
          const api: any = {
            collectionName,
            find: () =>
              (async function* generator() {
                for (const doc of state[name][collectionName]) {
                  yield doc;
                }
              })(),
            indexes: async () =>
              indexDefs[`${name}.${collectionName}`] || [{ name: '_id_', key: { _id: 1 }, v: 2 }],
            deleteMany: async () => {
              const removed = state[name][collectionName].length;
              state[name][collectionName] = [];
              return { deletedCount: removed };
            },
            insertMany: async (docs: any[]) => {
              state[name][collectionName].push(...docs);
              return { insertedCount: docs.length };
            },
            rename: async (newName: string, options?: any) => {
              if (options?.dropTarget) {
                state[name][newName] = [];
              }
              const moved = state[name][collectionName];
              delete state[name][collectionName];
              state[name][newName] = moved;
              return { collectionName: newName };
            },
            createIndex: async (key: any, options: any) => {
              createdIndexes.push({ db: name, collection: collectionName, key, options });
              return options?.name || 'index';
            },
          };
          return api;
        },
      };
    },
  };
  return { client, state, createdIndexes };
}

function makeStaticRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-static-'));
  fs.mkdirSync(path.join(root, 'img', 'thumb'), { recursive: true });
  fs.mkdirSync(path.join(root, 'file'), { recursive: true });
  fs.mkdirSync(path.join(root, 'customPage', 'about'), { recursive: true });
  // 这些目录不该进备份（可再生 / 会套娃）
  fs.mkdirSync(path.join(root, 'export'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rss'), { recursive: true });
  fs.writeFileSync(path.join(root, 'img', 'aa11.webp'), Buffer.from('image-bytes'));
  fs.writeFileSync(path.join(root, 'img', 'thumb', 'aa11.webp'), Buffer.from('thumb'));
  fs.writeFileSync(path.join(root, 'file', 'bb22.pdf'), Buffer.from('%PDF-1.4 fake'));
  fs.writeFileSync(path.join(root, 'customPage', 'about', 'index.html'), '<h1>about</h1>');
  fs.writeFileSync(path.join(root, 'export', 'export-img-2026-09-12.zip'), 'old-archive');
  fs.writeFileSync(path.join(root, 'rss', 'feed.xml'), '<rss/>');
  return root;
}

const ARTICLE = {
  _id: new ObjectId('668a41e95497d2b9081db67e'),
  id: 53,
  title: '一篇测试文章',
  content: '# hello\n\n正文里有个 {$date: "看起来像扩展 JSON"} 的对象',
  createdAt: new Date('2024-07-07T07:31:35.821Z'),
  updatedAt: new Date('2026-09-12T00:00:00.000Z'),
  deleted: false,
  visits: 12,
};

const SETTING = {
  _id: new ObjectId('668a41e95497d2b9081db67f'),
  type: 'static',
  value: {
    storageType: 'local',
    enableStegoWaterMark: true,
    stegoKey: 'super-secret-key',
    maxImageEdge: 1920,
    weirdDecimal: Decimal128.fromString('1.5'),
  },
};

describe('compression format helpers', () => {
  it('detects formats by extension and by magic bytes', () => {
    expect(detectFormat('/x/vanblog-full-1.tar.zst')).toBe('zstd');
    expect(detectFormat('/x/vanblog-full-1.tar.xz')).toBe('xz');
    expect(detectFormat('/x/vanblog-full-1.tar.gz')).toBe('gzip');
    expect(detectFormat('/x/vanblog-full-1.tgz')).toBe('gzip');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-magic-'));
    const zstdFile = path.join(dir, 'no-extension');
    fs.writeFileSync(zstdFile, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00]));
    expect(detectFormat(zstdFile)).toBe('zstd');
    const gzipFile = path.join(dir, 'gzip-unknown');
    fs.writeFileSync(gzipFile, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    expect(detectFormat(gzipFile)).toBe('gzip');
    fs.writeFileSync(path.join(dir, 'plain'), 'hello');
    expect(detectFormat(path.join(dir, 'plain'))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('always has gzip and rejects unknown formats', () => {
    expect(availableFormats()).toContain('gzip');
    expect(pickSpec('auto')).not.toBeNull();
    expect(pickSpec('gzip')?.format).toBe('gzip');
    expect(pickSpec('7z')).toBeNull();
  });

  it('never backs up regenerable static folders', () => {
    // ⚠️ 这条以前钉的是 ['img','file','customPage'] —— 那个清单**就是 bug**：
    // 后台上传的主题 CSS 在 <static>/themes/ 下，不在清单里 ⇒ 主题从来不进归档，
    // 而主题的元数据在库里，恢复后后台显示"主题在、已启用"，CSS 却 404（静默退回默认皮肤）。
    // 现在补上 themes；完整的分类守卫（含"未知新目录必须让测试红"）在
    // src/audit-hardening-round3-backup.spec.ts。
    expect(BACKUP_STATIC_FOLDERS).toEqual(['img', 'file', 'customPage', 'themes']);
    expect(BACKUP_STATIC_FOLDERS).toContain('themes');
    expect(BACKUP_STATIC_FOLDERS).not.toContain('export');
    expect(BACKUP_STATIC_FOLDERS).not.toContain('tmp');
  });
});

describe('createFullBackup + restoreFullBackup', () => {
  const source = createFakeMongo(
    {
      vanBlog: { articles: [ARTICLE], settings: [SETTING], visits: [] },
      waline: { Comment: [{ _id: new ObjectId(), comment: '<p>Hi</p>' }], Users: [] },
    },
    {
      'vanBlog.articles': [
        { name: '_id_', key: { _id: 1 }, v: 2 },
        { name: 'id_1', key: { id: 1 }, v: 2 },
        { name: 'pathname_1', key: { pathname: 1 }, unique: true, v: 2 },
      ],
    },
  );
  const staticRoot = makeStaticRoot();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-backups-'));
  let archivePath = '';
  let result: any;

  beforeAll(async () => {
    result = await createFullBackup({
      client: source.client,
      staticPath: staticRoot,
      dbName: 'vanBlog',
      walineDbName: 'waline',
      format: 'gzip', // gzip 到处都有；zstd/xz 的分支由 detectFormat/pickSpec 覆盖
      outDir,
    });
    archivePath = result.path;
  });

  afterAll(() => {
    fs.rmSync(staticRoot, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('produces a gzip archive with a manifest and a sidecar', () => {
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(archivePath.endsWith('.tar.gz')).toBe(true);
    expect(result.format).toBe('gzip');
    expect(result.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(`${archivePath}.manifest.json`)).toBe(true);

    const manifest = result.manifest;
    expect(manifest.kind).toBe('vanblog-full-backup');
    expect(manifest.databases.vanBlog.collections.articles.count).toBe(1);
    expect(manifest.databases.vanBlog.collections.settings.count).toBe(1);
    expect(manifest.databases.waline.collections.Comment.count).toBe(1);
    expect(manifest.totals.documents).toBe(3);
    expect(manifest.totals.files).toBe(4); // img + thumb + file + customPage
    expect(Object.keys(manifest.static).sort()).toEqual(['customPage', 'file', 'img']);
    expect(manifest.totals.archiveBytes).toBe(result.bytes);
  });

  it('lists backups from the sidecar without decompressing', () => {
    const items = listFullBackups(outDir);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe(result.name);
    expect(items[0].format).toBe('gzip');
    expect(items[0].manifest?.totals.documents).toBe(3);
    expect(listFullBackups(path.join(outDir, 'does-not-exist'))).toEqual([]);
  });

  it('restores documents (with BSON types), indexes and static files elsewhere', async () => {
    const target = createFakeMongo();
    const targetStatic = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-restore-'));

    const res = await restoreFullBackup({
      client: target.client,
      staticPath: targetStatic,
      archivePath,
    });

    // 数据库：条数、类型、内容都对得上
    expect(res.databases.vanBlog).toEqual({ collections: 3, documents: 2 });
    expect(res.databases.waline).toEqual({ collections: 2, documents: 1 });
    const article: any = target.state.vanBlog.articles[0];
    expect(article._id._bsontype).toBe('ObjectId');
    expect(article._id.toString()).toBe('668a41e95497d2b9081db67e');
    expect(article.createdAt instanceof Date).toBe(true);
    expect(article.createdAt.toISOString()).toBe('2024-07-07T07:31:35.821Z');
    expect(article.title).toBe('一篇测试文章');
    // 正文里那个「看起来像扩展 JSON」的对象没被误还原
    expect(article.content).toContain('{$date: "看起来像扩展 JSON"}');
    const setting: any = target.state.vanBlog.settings[0];
    expect(setting.value.stegoKey).toBe('super-secret-key');
    expect(setting.value.weirdDecimal.toString()).toBe('1.5');
    expect(target.state.waline.Comment[0].comment).toBe('<p>Hi</p>');
    expect(target.state.vanBlog.visits).toEqual([]);

    // 索引：跳过 _id_，保留 unique 等选项
    const articleIndexes = res && target.createdIndexes.filter((i) => i.collection === 'articles');
    expect(articleIndexes.map((i) => i.options.name)).toEqual(['id_1', 'pathname_1']);
    expect(articleIndexes[1].options.unique).toBe(true);

    // 静态文件：该来的都来了，可再生的目录没被搬过去
    expect(fs.readFileSync(path.join(targetStatic, 'img', 'aa11.webp'), 'utf8')).toBe('image-bytes');
    expect(fs.existsSync(path.join(targetStatic, 'img', 'thumb', 'aa11.webp'))).toBe(true);
    expect(fs.existsSync(path.join(targetStatic, 'file', 'bb22.pdf'))).toBe(true);
    expect(
      fs.readFileSync(path.join(targetStatic, 'customPage', 'about', 'index.html'), 'utf8'),
    ).toBe('<h1>about</h1>');
    expect(fs.existsSync(path.join(targetStatic, 'export'))).toBe(false);
    expect(fs.existsSync(path.join(targetStatic, 'rss'))).toBe(false);

    // 没有留下恢复用的临时集合
    expect(Object.keys(target.state.vanBlog).some((name) => name.endsWith('__vanblog_restore'))).toBe(
      false,
    );
    expect(res.notes.join(' ')).toContain('重新登录');

    fs.rmSync(targetStatic, { recursive: true, force: true });
  });

  it('can restore the database only, leaving static files alone', async () => {
    const target = createFakeMongo();
    const targetStatic = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-dbonly-'));

    const res = await restoreFullBackup({
      client: target.client,
      staticPath: targetStatic,
      archivePath,
      withStatic: false,
    });

    expect(res.static).toEqual({});
    expect(fs.existsSync(path.join(targetStatic, 'img'))).toBe(false);
    expect(target.state.vanBlog.articles).toHaveLength(1);
    expect(res.notes.join(' ')).toContain('未覆盖静态文件');

    fs.rmSync(targetStatic, { recursive: true, force: true });
  });

  it('rejects archives that are not full backups', async () => {
    // 打一个没有 manifest.json 的 tar.gz
    const junkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-junk-'));
    fs.writeFileSync(path.join(junkRoot, 'hello.txt'), 'hi');
    const junk = path.join(junkRoot, 'not-a-backup.tar.gz');
    spawnSync('sh', ['-c', `tar -cf - -C "${junkRoot}" hello.txt | gzip -9 -c > "${junk}"`]);

    const target = createFakeMongo();
    await expect(
      restoreFullBackup({
        client: target.client,
        staticPath: junkRoot,
        archivePath: junk,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      restoreFullBackup({
        client: target.client,
        staticPath: junkRoot,
        archivePath: path.join(junkRoot, 'missing.tar.gz'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    fs.writeFileSync(path.join(junkRoot, 'weird.tar.7z'), 'x');
    await expect(
      restoreFullBackup({
        client: target.client,
        staticPath: junkRoot,
        archivePath: path.join(junkRoot, 'weird.tar.7z'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    fs.rmSync(junkRoot, { recursive: true, force: true });
  });

  it('cleans up its staging directory', () => {
    const leftovers = fs
      .readdirSync(path.join(staticRoot, 'tmp'))
      .filter((name) => name.startsWith('full-backup-') || name.startsWith('full-restore-'));
    expect(leftovers).toEqual([]);
  });
});
