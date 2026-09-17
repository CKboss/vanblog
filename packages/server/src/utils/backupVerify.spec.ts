import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { verifyFullBackup } from './backupVerify';
import { FullBackupManifest } from './backupCodec';

/**
 * P2 备份写后校验 —— 用**真归档**（真 tar + 真压缩器）钉住每一项检查。
 *
 * 负控矩阵（每一项都单独构造一个坏归档，必须 ok:false 且点名对应 check）：
 *  截断归档 → readThrough；改 sidecar → sidecarMatches；totals 对不上 → countsConsistent；
 *  少一个 .ndjson 成员 → countsConsistent；静态文件数不符 → staticConsistent；
 *  空库备份 → countsNonZero。健康归档必须全绿（防止"检查永远失败"的假实现）。
 */

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-verify-'));
}

function baseManifest(): FullBackupManifest {
  return {
    kind: 'vanblog-full-backup' as const,
    version: 1,
    createdAt: new Date().toISOString(),
    format: 'gzip',
    compressor: 'gzip -9',
    databases: {
      vanBlog: {
        collections: {
          articles: { count: 2, bytes: 120, indexes: 1 },
          users: { count: 1, bytes: 60, indexes: 0 },
        },
      },
    },
    static: {
      img: { files: 2, bytes: 40 },
    },
    totals: {
      databases: 1,
      collections: 2,
      documents: 3,
      files: 2,
      staticBytes: 40,
    },
  };
}

/** 按 createFullBackup 同样的形状搭一个 staging 目录并打包（tar -cf - -C staging . | 压缩器）。 */
function buildArchive(
  dir: string,
  options: {
    manifest?: FullBackupManifest | null;
    sidecar?: FullBackupManifest | null | 'missing';
    ndjson?: Record<string, string>; // 相对 staging 的路径 -> 内容
    staticFiles?: Record<string, string>;
    name?: string;
    truncateBytes?: number;
    compress?: string; // shell 管道里的压缩命令，默认 gzip
  } = {},
): string {
  const staging = path.join(dir, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  const manifest = options.manifest === undefined ? baseManifest() : options.manifest;
  if (manifest) {
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  const ndjson = options.ndjson || {
    'db/vanBlog/articles.ndjson': '{"id":1}\n{"id":2}\n',
    'db/vanBlog/users.ndjson': '{"id":0}\n',
  };
  for (const [rel, body] of Object.entries(ndjson)) {
    const full = path.join(staging, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const staticFiles = options.staticFiles || {
    'static/img/a.webp': 'aaaa',
    'static/img/b.webp': 'bbbb',
  };
  for (const [rel, body] of Object.entries(staticFiles)) {
    const full = path.join(staging, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const name = options.name || 'vanblog-full-20260917-000000.tar.gz';
  const archivePath = path.join(dir, name);
  const compress = options.compress || 'gzip -9 -c';
  execFileSync(
    'sh',
    ['-c', `tar -cf - -C '${staging}' . | ${compress} > '${archivePath}'`],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const sidecar =
    options.sidecar === undefined
      ? { ...manifest, totals: { ...manifest?.totals, archiveBytes: fs.statSync(archivePath).size } }
      : options.sidecar;
  if (sidecar !== 'missing' && sidecar !== null) {
    fs.writeFileSync(`${archivePath}.manifest.json`, JSON.stringify(sidecar, null, 2));
  }
  if (options.truncateBytes) {
    const size = fs.statSync(archivePath).size;
    fs.truncateSync(archivePath, Math.max(0, size - options.truncateBytes));
  }
  return archivePath;
}

describe('verifyFullBackup（真归档）', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('健康归档：全部检查通过（负控：任何一项检查坏掉这条就红）', async () => {
    const archive = buildArchive(dir);
    const result = await verifyFullBackup(archive);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual({
      readThrough: true,
      manifestFromArchive: true,
      sidecarMatches: true,
      countsConsistent: true,
      staticConsistent: true,
      countsNonZero: true,
    });
    expect(result.format).toBe('gzip');
    expect(result.archiveBytes).toBe(fs.statSync(archive).size);
    expect(result.members).toBeGreaterThan(0);
    expect(typeof result.ms).toBe('number');
  });

  it('截断的归档：readThrough 失败（解压器 CRC/EOF 必然报错）', async () => {
    const archive = buildArchive(dir, { truncateBytes: 400 });
    const result = await verifyFullBackup(archive);
    expect(result.ok).toBe(false);
    expect(result.checks.readThrough).toBe(false);
    expect(result.issues.some((i) => i.check === 'readThrough')).toBe(true);
  });

  it('归档内 manifest 缺失/损坏：manifestFromArchive 失败', async () => {
    const archive = buildArchive(dir, { manifest: null });
    const result = await verifyFullBackup(archive);
    expect(result.ok).toBe(false);
    expect(result.checks.manifestFromArchive).toBe(false);
  });

  it('sidecar 被改（totals 与内部不一致）：sidecarMatches 失败', async () => {
    const manifest = baseManifest();
    const tampered = JSON.parse(JSON.stringify(manifest));
    tampered.totals.documents = 999;
    tampered.totals.archiveBytes = 1;
    const archive = buildArchive(dir, { manifest, sidecar: tampered });
    const result = await verifyFullBackup(archive);
    expect(result.ok).toBe(false);
    expect(result.checks.sidecarMatches).toBe(false);
  });

  it('sidecar 缺失：sidecarMatches 失败（后台列表页会读不到清单）', async () => {
    const archive = buildArchive(dir, { sidecar: 'missing' });
    const result = await verifyFullBackup(archive);
    expect(result.ok).toBe(false);
    expect(result.checks.sidecarMatches).toBe(false);
  });

  it('totals.documents 与逐集合求和不符：countsConsistent 失败', async () => {
    const manifest = baseManifest();
    manifest.totals.documents = 5; // 实际 2+1=3
    const archive = buildArchive(dir, { manifest });
    const result = await verifyFullBackup(archive);
    expect(result.ok).toBe(false);
    expect(result.checks.countsConsistent).toBe(false);
    expect(result.issues.some((i) => i.message.includes('totals'))).toBe(true);
  });

  it('manifest 说有 users.ndjson 但归档里没有：countsConsistent 失败并点名缺失成员', async () => {
    const archive = buildArchive(dir, {
      ndjson: { 'db/vanBlog/articles.ndjson': '{"id":1}\n{"id":2}\n' },
    });
    const result = await verifyFullBackup(archive);
    expect(result.ok).toBe(false);
    expect(result.checks.countsConsistent).toBe(false);
    expect(result.issues.some((i) => i.message.includes('db/vanBlog/users.ndjson'))).toBe(true);
  });

  it('静态文件实际写入数与 manifest 不符：staticConsistent 失败', async () => {
    const archive = buildArchive(dir, {
      staticFiles: { 'static/img/a.webp': 'aaaa' }, // manifest 记的是 2 个
    });
    const result = await verifyFullBackup(archive);
    expect(result.ok).toBe(false);
    expect(result.checks.staticConsistent).toBe(false);
  });

  it('空库归档（0 集合 0 文档）：countsNonZero 失败', async () => {
    const manifest = baseManifest();
    manifest.databases = {};
    manifest.static = {};
    manifest.totals = { databases: 0, collections: 0, documents: 0, files: 0, staticBytes: 0 };
    const archive = buildArchive(dir, { manifest, ndjson: {}, staticFiles: {} });
    const result = await verifyFullBackup(archive);
    expect(result.ok).toBe(false);
    expect(result.checks.countsNonZero).toBe(false);
  });

  it('0 张静态图但是有数据：staticConsistent/countsNonZero 都过（全新站点不该被误伤）', async () => {
    const manifest = baseManifest();
    manifest.static = {};
    manifest.totals.files = 0;
    manifest.totals.staticBytes = 0;
    const archive = buildArchive(dir, { manifest, staticFiles: {} });
    const result = await verifyFullBackup(archive);
    expect(result.ok).toBe(true);
  });

  it('不存在的文件/认不出的格式：readThrough 失败且不抛', async () => {
    const missing = path.join(dir, 'vanblog-full-19700101-000000.tar.gz');
    const result = await verifyFullBackup(missing);
    expect(result.ok).toBe(false);
    expect(result.checks.readThrough).toBe(false);
    const weird = path.join(dir, 'vanblog-full-19700101-000001.tar.gz');
    fs.writeFileSync(weird, 'not an archive at all');
    const result2 = await verifyFullBackup(weird);
    expect(result2.ok).toBe(false);
  });

  // 回归钉子：修复前 listArchiveMembers 在「tar 退出码非 0」时把 settled 先置 true 再调
  // fail()（fail 因 settled 直接 return），promise **永远不 settle** —— 本用例会挂满
  // jest 超时（红）。zstd 与 gzip 的失败顺序不同（gzip 常由解压器 close 先触发 fail 而侥幸
  // 能 settle），所以必须两种压缩器都钉。真 69MB zstd 归档截断 1MB 时本机必现。
  const hasZstd = (() => {
    try {
      execFileSync('zstd', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  (hasZstd ? it : it.skip)(
    '截断的 zstd 归档：快速判失败，绝不挂起（listArchiveMembers 的 settle 回归）',
    async () => {
      const archive = buildArchive(dir, {
        name: 'vanblog-full-20260917-000002.tar.zst',
        compress: 'zstd -3 -q -c',
        sidecar: 'missing', // 别让 sidecar 的 archiveBytes 检查抢戏，本用例只钉 readThrough
      });
      const size = fs.statSync(archive).size;
      fs.truncateSync(archive, Math.max(1, Math.floor(size * 0.6)));
      const result = await verifyFullBackup(archive); // 修复前：这一行永远不返回
      expect(result.ok).toBe(false);
      expect(result.checks.readThrough).toBe(false);
    },
    30000,
  );

  it('listArchiveMembers 对截断的 gzip 归档必须 reject（同一个 settle 回归，直接钉函数）', async () => {
    const { listArchiveMembers } = await import('./fullBackup');
    const archive = buildArchive(dir, {
      name: 'vanblog-full-20260917-000003.tar.gz',
      truncateBytes: 300,
    });
    await expect(listArchiveMembers(archive)).rejects.toThrow();
  });
});
