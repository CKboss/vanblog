import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as zlib from 'zlib';
import { openDecryptedSource } from './backupCrypto';
import { ObjectId, Decimal128 } from 'mongodb';
import {
  BACKUP_STATIC_FOLDERS,
  EXPORT_TEMP_RE,
  FULL_BACKUP_ARCHIVE_RE,
  availableFormats,
  createFullBackup,
  detectFormat,
  listFullBackups,
  pickSpec,
  restoreFullBackup,
} from './fullBackup';
import { verifyFullBackup } from './backupVerify';

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

// ---------------------------------------------------------------------------
// 可选的归档加密（默认关）
//
// ⚠️ 这一组是**端到端**的：真的跑 tar + 压缩器 + scrypt + AES-256-GCM，真的写盘，
// 真的恢复进另一个内存库。加密这种东西最容易"看起来做了"（只加密了头部、标签没校验、
// 恢复路径根本没走到解密），所以这里每条都断言**结果**，不断言源码文本。
// ---------------------------------------------------------------------------
describe('整站备份加密（可选，默认关）', () => {
  /** 只解密、不解压：用来断言"解密之后得到的是一个完好的 gzip 流" */
  async function decryptToBuffer(archivePath: string, passphrase: string): Promise<Buffer> {
    const { source } = await openDecryptedSource(archivePath, passphrase, {});
    const chunks: Buffer[] = [];
    source!.on('data', (c: Buffer) => chunks.push(c));
    await new Promise<void>((resolve, reject) => {
      source!.on('end', () => resolve());
      source!.on('error', reject);
    });
    return Buffer.concat(chunks);
  }

  /** 一个"像真的"的 jwt 密钥：用来证明它不出现在密文里（这是本功能存在的唯一理由） */
  const FAKE_JWT_SECRET = 'FAKE-JWT-SECRET-9d3f1a7c5e8b2046';
  const PASSPHRASE = 'correct-horse-battery-staple-42';

  /** 建一个含 `settings{type:'jwt'}` 与 `tokens` 的源库 —— 也就是"归档=站点凭据"的那部分 */
  function makeSource() {
    return createFakeMongo({
      vanBlog: {
        articles: [{ _id: new ObjectId(), title: '加密往返', content: '正文', pathname: 'enc-round-trip' }],
        settings: [
          { _id: new ObjectId(), type: 'jwt', value: { secret: FAKE_JWT_SECRET } },
          { _id: new ObjectId(), type: 'login', value: { expiresIn: 604800 } },
        ],
        tokens: [{ _id: new ObjectId(), userId: 666666, name: 'api-token', token: 'FAKE-API-TOKEN-VALUE' }],
      },
      waline: {
        Comment: [{ _id: new ObjectId(), nick: '某人', comment: '评论内容' }],
      },
    });
  }

  const roots: string[] = [];
  const track = (dir: string) => {
    roots.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of roots) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.VANBLOG_BACKUP_PASSPHRASE;
    delete process.env.VANBLOG_BACKUP_PASSPHRASE_FILE;
  });

  async function makeBackup(opts: { passphrase?: string | null; env?: string | null } = {}) {
    const source = makeSource();
    const staticRoot = track(makeStaticRoot());
    const outDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-enc-')));
    const prevEnv = process.env.VANBLOG_BACKUP_PASSPHRASE;
    if (opts.env === null) {
      delete process.env.VANBLOG_BACKUP_PASSPHRASE;
    } else if (opts.env !== undefined) {
      process.env.VANBLOG_BACKUP_PASSPHRASE = opts.env;
    }
    try {
      const result = await createFullBackup({
        client: source.client,
        staticPath: staticRoot,
        dbName: 'vanBlog',
        walineDbName: 'waline',
        format: 'gzip',
        outDir,
        passphrase: opts.passphrase,
      });
      return { result, outDir, staticRoot };
    } finally {
      if (prevEnv === undefined) {
        delete process.env.VANBLOG_BACKUP_PASSPHRASE;
      } else {
        process.env.VANBLOG_BACKUP_PASSPHRASE = prevEnv;
      }
    }
  }

  it('配了口令 ⇒ 名字带 .enc、内容是加密容器、**且密文里搜不到 jwt 密钥**', async () => {
    const { result } = await makeBackup({ passphrase: PASSPHRASE });
    expect(result.encrypted).toBe(true);
    expect(result.name.endsWith('.tar.gz.enc')).toBe(true);
    expect(result.plaintextWarning).toBeNull();

    const bytes = fs.readFileSync(result.path);
    // 魔数
    expect(bytes.subarray(0, 11).toString('ascii')).toBe('VANBLOGENC1');
    expect(bytes.includes(Buffer.from(FAKE_JWT_SECRET, 'utf8'))).toBe(false);
    expect(bytes.includes(Buffer.from('FAKE-API-TOKEN-VALUE', 'utf8'))).toBe(false);
    expect(bytes.includes(Buffer.from(PASSPHRASE, 'utf8'))).toBe(false);
    // ⚠️⚠️ 上面三条**单独看是空断言**：归档是 gzip 压过的，明文字符串本来就不会出现
    //    （对照组实测：明文归档里同样搜不到 FAKE_JWT_SECRET）。真正有意义的是下面这一组：
    //    ①加密归档不是 gzip 流，直接解压必须失败；
    //    ②解密**之后**能得到 gzip 流，且解压出来搜得到 jwt 密钥（证明数据在里面、只是被保护）；
    //    ③明文归档解压出来搜得到 jwt 密钥（这就是加密要解决的事本身）。
    expect(() => zlib.gunzipSync(bytes)).toThrow();
    const inner = await decryptToBuffer(result.path, PASSPHRASE);
    expect(inner.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(true);
    expect(zlib.gunzipSync(inner).includes(Buffer.from(FAKE_JWT_SECRET, 'utf8'))).toBe(true);
    // 不能是"只加密了头部"：偏移 0 处必须是我们的魔数，而不是内层 gzip 的魔数。
    // ⚠️ 这里**不能**写成"整个文件里搜不到 1f 8b"—— 那是个统计学上站不住的断言：
    //    一个指定的 2 字节序列在 ~100 KB 的随机数据里平均会出现 1.5 次，
    //    所以它第一次跑"过了"纯属运气（实测第二次就红了）。
    //    "内层 gzip 完好"由下面那条端到端恢复用例证明，比搜字节强得多。
    expect(bytes[0]).not.toBe(0x1f);
    expect(bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(false);

    // 清单里记了加密参数（将来换默认参数也解得开），但**没有**口令
    expect(result.manifest.encryption?.encrypted).toBe(true);
    expect(result.manifest.encryption?.cipher).toBe('aes-256-gcm');
    expect(result.manifest.encryption?.kdf.name).toBe('scrypt');
    expect(JSON.stringify(result.manifest)).not.toContain(PASSPHRASE);
    expect(detectFormat(result.path)).toBe('gzip'); // 看穿容器拿到内层格式
  });

  it('对照：明文归档能直接 gunzip，且解压后**搜得到 jwt 密钥**（这就是加密要解决的事）', async () => {
    const { result } = await makeBackup({ env: null });
    const bytes = fs.readFileSync(result.path);
    expect(bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(true);
    // ⚠️ 注意：**压缩后的字节里搜不到**这个密钥（gzip 把它压掉了），
    //    所以"归档文件里搜不到明文密钥"这句话对明文归档同样成立 ⇒ 那条断言本身证明不了加密生效。
    //    必须解压之后再比，这正是本用例存在的理由。
    expect(bytes.includes(Buffer.from(FAKE_JWT_SECRET, 'utf8'))).toBe(false);
    const decompressed = zlib.gunzipSync(bytes);
    expect(decompressed.includes(Buffer.from(FAKE_JWT_SECRET, 'utf8'))).toBe(true);
    expect(decompressed.includes(Buffer.from('FAKE-API-TOKEN-VALUE', 'utf8'))).toBe(true);
  });

  it('⚠️ 加密归档能原样恢复（端到端往返：库、waline、静态文件都对得上）', async () => {
    const { result, staticRoot } = await makeBackup({ passphrase: PASSPHRASE });
    const target = createFakeMongo({});
    const targetStatic = track(fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-enc-restore-')));
    const res = await restoreFullBackup({
      client: target.client,
      staticPath: targetStatic,
      archivePath: result.path,
      passphrase: PASSPHRASE,
    });
    expect(res.databases.vanBlog).toEqual({ collections: 3, documents: 4 });
    expect(res.databases.waline).toEqual({ collections: 1, documents: 1 });
    // 静态文件真的落盘了
    expect(fs.readFileSync(path.join(targetStatic, 'img', 'aa11.webp'), 'utf8')).toBe('image-bytes');
    // jwt 密钥原样回来了（恢复的目的就是这个）
    // ⚠️ 用假 mongo 暴露的 `state`，不是 cursor：这个内存假件只实现了备份/恢复用到的
    //    那几个方法，`find()` 返回的是 async generator，没有 `.toArray()`。
    const settings = target.state.vanBlog?.settings || [];
    expect(settings.some((d: any) => d?.value?.secret === FAKE_JWT_SECRET)).toBe(true);
    const tokens = target.state.vanBlog?.tokens || [];
    expect(tokens.some((d: any) => d?.token === 'FAKE-API-TOKEN-VALUE')).toBe(true);
    void staticRoot;
  });

  it('env 里配了口令 ⇒ 恢复时不用显式传（服务器上恢复自己的归档）', async () => {
    const { result } = await makeBackup({ env: PASSPHRASE });
    expect(result.encrypted).toBe(true);
    // ⚠️ makeBackup 用完会把 env 复原（免得污染别的用例），所以这里要**重新**设上：
    // 这条测的正是"服务器上配了 env ⇒ 恢复自己的归档不用显式传口令"。
    process.env.VANBLOG_BACKUP_PASSPHRASE = PASSPHRASE;
    try {
      const target = createFakeMongo({});
      const targetStatic = track(fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-enc-restore-')));
      const res = await restoreFullBackup({
        client: target.client,
        staticPath: targetStatic,
        archivePath: result.path,
      });
      expect(res.databases.vanBlog.documents).toBe(4);
      expect((target.state.vanBlog?.settings || []).some((d: any) => d?.value?.secret === FAKE_JWT_SECRET)).toBe(true);
    } finally {
      delete process.env.VANBLOG_BACKUP_PASSPHRASE;
    }
  });

  it('没有口令 ⇒ 恢复被拒，报错可照做，且**目标库里一个字都没写**', async () => {
    const { result } = await makeBackup({ passphrase: PASSPHRASE });
    const target = createFakeMongo({});
    const targetStatic = track(fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-enc-restore-')));
    let message = '';
    await expect(
      (async () => {
        try {
          await restoreFullBackup({
            client: target.client,
            staticPath: targetStatic,
            archivePath: result.path,
          });
        } catch (err) {
          message = (err as Error).message;
          throw err;
        }
      })(),
    ).rejects.toThrow();
    expect(message).toContain('这份归档是加密的');
    expect(message).toContain('VANBLOG_BACKUP_PASSPHRASE');
    expect(message).toContain('backupPassphrase');
    expect(message).toContain('body');
    // ⚠️ 不回显口令与 salt
    expect(message).not.toContain(PASSPHRASE);
    // 目标库必须还是空的（失败发生在解包之前，不留半份数据）
    expect(target.state.vanBlog?.articles || []).toEqual([]);
    expect(target.state.vanBlog?.settings || []).toEqual([]);
    expect(fs.existsSync(path.join(targetStatic, 'img'))).toBe(false);
  });

  it('口令错了 ⇒ 恢复被拒，且**不留半份数据**', async () => {
    const { result } = await makeBackup({ passphrase: PASSPHRASE });
    const target = createFakeMongo({});
    const targetStatic = track(fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-enc-restore-')));
    let message = '';
    await expect(
      (async () => {
        try {
          await restoreFullBackup({
            client: target.client,
            staticPath: targetStatic,
            archivePath: result.path,
            passphrase: 'an-entirely-wrong-passphrase',
          });
        } catch (err) {
          message = (err as Error).message;
          throw err;
        }
      })(),
    ).rejects.toThrow();
    expect(message).toMatch(/口令不正确|解密失败/);
    expect(message).not.toContain('an-entirely-wrong-passphrase');
    // ⚠️ 这条用例本身就是一道"不许挂死"的守卫：实现里如果漏掉"上游 error 时收掉解压器"，
    //    这里会一直等到 jest 的 30s 超时（曾经的真实症状），而不是拿到一条错误信息。
    expect(target.state.vanBlog?.articles || []).toEqual([]);
    expect(target.state.vanBlog?.settings || []).toEqual([]);
  });

  it('归档被截断 ⇒ 恢复失败（GCM 的 final 标记兜住了"少一块"）', async () => {
    const { result } = await makeBackup({ passphrase: PASSPHRASE });
    const bytes = fs.readFileSync(result.path);
    fs.writeFileSync(result.path, bytes.subarray(0, bytes.length - 200));
    const target = createFakeMongo({});
    const targetStatic = track(fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-enc-restore-')));
    await expect(
      restoreFullBackup({
        client: target.client,
        staticPath: targetStatic,
        archivePath: result.path,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toThrow(/截断|解密失败|损坏|块顺序/);
  });

  it('sidecar 是明文的：不需要口令就能读，且不含口令', async () => {
    const { result } = await makeBackup({ passphrase: PASSPHRASE });
    const sha = `${result.path}.sha256`;
    const manifestSidecar = `${result.path}.manifest.json`;
    expect(fs.existsSync(sha)).toBe(true);
    expect(fs.existsSync(manifestSidecar)).toBe(true);
    const shaText = fs.readFileSync(sha, 'utf8');
    // `sha256sum -c` 能吃的格式："<hex>  <文件名>"
    expect(shaText).toMatch(new RegExp(`^[0-9a-f]{64}\\s+${result.name.replace(/\./g, '\\.')}`));
    expect(shaText).not.toContain(PASSPHRASE);
    const parsed = JSON.parse(fs.readFileSync(manifestSidecar, 'utf8'));
    expect(parsed.encryption.encrypted).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain(PASSPHRASE);
    // 整归档 sha256 对得上（sidecar 记的是**密文**的哈希）
    const digest = require('crypto').createHash('sha256').update(fs.readFileSync(result.path)).digest('hex');
    expect(shaText.startsWith(digest)).toBe(true);
    // 权限仍然是 0600（加密不替代权限，两层都要有）
    expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it('备份列表认得 .enc 归档（否则加密归档会从后台列表里消失）', async () => {
    const { result, outDir } = await makeBackup({ passphrase: PASSPHRASE });
    const listed = listFullBackups(outDir);
    expect(listed.some((item) => item.name === result.name)).toBe(true);
    // 半成品临时名（同样带 .enc）不许被当成归档
    expect(FULL_BACKUP_ARCHIVE_RE.test('.vanblog-export-abc123.tar.gz.enc')).toBe(false);
    expect(EXPORT_TEMP_RE.test('.vanblog-export-abc123.tar.gz.enc')).toBe(true);
  });

  it('未配口令 ⇒ 行为与改动前一致：真 gzip、名字不带 .enc、并给出明文 WARN', async () => {
    const { result } = await makeBackup({ env: null });
    expect(result.encrypted).toBe(false);
    expect(result.name.endsWith('.enc')).toBe(false);
    expect(result.manifest.encryption).toBeUndefined();
    const bytes = fs.readFileSync(result.path);
    // 真 gzip 魔数（对照上一条：加密时它必须**不**出现）
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    // WARN 文案说清"里面有什么"与"怎么开加密"
    expect(result.plaintextWarning).toContain('JWT 签名密钥');
    expect(result.plaintextWarning).toContain('VANBLOG_BACKUP_PASSPHRASE');
    expect(result.plaintextWarning).toContain(result.name);
    // 明文归档照常恢复（向后兼容）
    const target = createFakeMongo({});
    const targetStatic = track(fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-enc-restore-')));
    const res = await restoreFullBackup({
      client: target.client,
      staticPath: targetStatic,
      archivePath: result.path,
    });
    expect(res.databases.vanBlog.documents).toBe(4);
  });

  it('passphrase: null ⇒ 强制明文（"导出给站长下载"不该产出 .enc）', async () => {
    const { result } = await makeBackup({ env: PASSPHRASE, passphrase: null });
    expect(result.encrypted).toBe(false);
    expect(result.name.endsWith('.enc')).toBe(false);
  });

  it('口令太短 ⇒ 备份**失败**（不写出一份能离线爆破的弱归档）', async () => {
    await expect(makeBackup({ passphrase: 'short' })).rejects.toThrow(/太短/);
  });

  it('_FILE 读不到 ⇒ 备份失败关闭，绝不静默降级成明文', async () => {
    process.env.VANBLOG_BACKUP_PASSPHRASE_FILE = '/nonexistent/backup-passphrase-file';
    try {
      await expect(makeBackup({ env: null })).rejects.toThrow(/不会静默回落到明文备份/);
    } finally {
      delete process.env.VANBLOG_BACKUP_PASSPHRASE_FILE;
    }
  });

  it('verifyFullBackup 在加密归档上仍然可用（env 里有口令）', async () => {
    const { result } = await makeBackup({ env: PASSPHRASE });
    // ⚠️ 同上：backupVerify 不在我的改动范围内、也不会显式传口令，它靠的是
    //    `extractSingleFile` / `hashArchiveMembers` 内部对 env 的回落解析。
    //    这条用例就是在钉"配了 env 的服务器上，verify 与 backup-verify 照常工作"。
    process.env.VANBLOG_BACKUP_PASSPHRASE = PASSPHRASE;
    const verification = await verifyFullBackup(result.path, { deep: true });
    delete process.env.VANBLOG_BACKUP_PASSPHRASE;
    // ⚠️ 断言里带上 issues/checks：这条失败时能直接看出是哪一项不认加密归档，
    //    否则只有一个孤零零的 "Expected: true, Received: false"。
    expect({ issues: verification.issues, checks: verification.checks }).toEqual({ issues: [], checks: verification.checks });
    expect(verification.ok).toBe(true);
    expect(verification.checks.readThrough).toBe(true);
    expect(verification.checks.manifestFromArchive).toBe(true);
    expect(verification.checks.sidecarMatches).toBe(true);
    // 加密归档读不到压缩器帧头 ⇒ 这一项是"未知"，但**不该**被算成问题
    expect(verification.integrity.frameChecksumOk).not.toBe(false);
  });
});
