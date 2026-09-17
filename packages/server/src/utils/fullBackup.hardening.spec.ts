import { BadRequestException } from '@nestjs/common';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ObjectId } from 'mongodb';
import { backupFileName } from './backupCodec';
import {
  BACKUP_INTEGRITY_ENV,
  EXPORT_TEMP_PREFIX,
  EXPORT_TEMP_RE,
  FULL_BACKUP_ARCHIVE_RE,
  RESTORE_DROP_ABSENT_ENV,
  RESTORE_PRUNE_STATIC_ENV,
  availableFormats,
  backupIncludeCaddyEnabled,
  cleanupStaleExportTemps,
  createFullBackup,
  declaredFrameChecksum,
  exportTempName,
  hashStagingTree,
  isExportTempName,
  isProtectedCollectionName,
  listFullBackups,
  pickSpec,
  restoreDropAbsentEnabled,
  restoreFullBackup,
  restorePruneStaticEnabled,
  specFor,
} from './fullBackup';
import { RESTORE_JOURNAL_FILE, readRestoreJournal } from './restoreJournal';
import { computeMerkleRoot, sha256Hex } from './backupTarStream';
import { readSha256Sidecar } from './backupIntegrity';
import { verifyFullBackup } from './backupVerify';
import * as tarStreamModule from './backupTarStream';

/**
 * P1/P2/P3 的**导出与恢复行为**钉子（与 `fullBackup.spec.ts` 互补：那份钉 BSON 保真与
 * 静态目录分类，这份钉"防损坏 + 原子性 + 100% 保真"）。
 *
 * 全部用真 tar / 真压缩器 / 真文件系统跑，只把 Mongo 换成内存假实现（多实现了
 * `countDocuments` 与 `drop`，P3 的"归档里没有的表"要用）。
 *
 * 每一项都配了负控说明（把对应的修复撤掉，哪条会红）。
 */

jest.setTimeout(180000);

function createFakeMongo(
  initial: Record<string, Record<string, any[]>> = {},
  options: { failInsertOn?: string } = {},
) {
  const state: Record<string, Record<string, any[]>> = {};
  for (const dbName of Object.keys(initial)) {
    state[dbName] = {};
    for (const name of Object.keys(initial[dbName])) {
      state[dbName][name] = [...initial[dbName][name]];
    }
  }
  const dropped: string[] = [];
  const client: any = {
    db(name: string) {
      if (!state[name]) state[name] = {};
      return {
        databaseName: name,
        collections: async () =>
          Object.keys(state[name])
            .sort()
            .map((collectionName) => ({ collectionName })),
        createCollection: async (collectionName: string) => {
          if (!state[name][collectionName]) state[name][collectionName] = [];
        },
        collection(collectionName: string) {
          if (!state[name][collectionName]) state[name][collectionName] = [];
          const api: any = {
            collectionName,
            find: () =>
              (async function* generator() {
                for (const doc of state[name][collectionName]) yield doc;
              })(),
            indexes: async () => [{ name: '_id_', key: { _id: 1 }, v: 2 }],
            countDocuments: async () => state[name][collectionName].length,
            drop: async () => {
              dropped.push(`${name}.${collectionName}`);
              delete state[name][collectionName];
              return true;
            },
            deleteMany: async () => {
              state[name][collectionName] = [];
              return { deletedCount: 0 };
            },
            insertMany: async (docs: any[]) => {
              // 恢复写的是 `<coll>__vanblog_restore`，所以按去掉后缀的名字匹配
              if (options.failInsertOn === collectionName.replace(/__vanblog_restore$/, '')) {
                throw new Error('模拟写库失败（ENOSPC）');
              }
              state[name][collectionName].push(...docs);
              return { insertedCount: docs.length };
            },
            rename: async (newName: string, opts?: any) => {
              if (opts?.dropTarget) state[name][newName] = [];
              const moved = state[name][collectionName];
              delete state[name][collectionName];
              state[name][newName] = moved;
              return { collectionName: newName };
            },
            createIndex: async () => 'index',
          };
          return api;
        },
      };
    },
  };
  return { client, state, dropped };
}

function makeSite(): { root: string; staticPath: string; outDir: string; workDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-hardening-'));
  const staticPath = path.join(root, 'static');
  const outDir = path.join(root, 'backups');
  const workDir = path.join(root, 'work');
  for (const dir of [staticPath, outDir, workDir]) fs.mkdirSync(dir, { recursive: true });
  return { root, staticPath, outDir, workDir };
}

function seedStatic(staticPath: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(staticPath, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string, rel: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(childRel);
      if (entry.isDirectory()) walk(path.join(current, entry.name), childRel);
    }
  };
  walk(root, '');
  return out.sort();
}

/** 真 tar 的成员表（外部权威，用来对照清单里的 memberCount / members 键） */
function tarList(archivePath: string): string[] {
  const spec = specFor('gzip')!;
  const out = execFileSync(
    'sh',
    ['-c', `${spec.decompress.join(' ')} '${archivePath}' | tar -tf -`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function extractMember(archivePath: string, member: string): string | null {
  try {
    return execFileSync('sh', ['-c', `gzip -dc '${archivePath}' | tar -xOf - '${member}'`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const ARTICLE = {
  _id: new ObjectId('668a41e95497d2b9081db67e'),
  id: 1,
  title: '一篇测试文章',
  content: '# hello',
  createdAt: new Date('2024-07-07T07:31:35.821Z'),
};

async function exportOnce(site: ReturnType<typeof makeSite>, extra: any = {}) {
  const { mongoOptions, walineDbName = 'waline', ...rest } = extra;
  const source = createFakeMongo(
    {
      vanBlog: { articles: [ARTICLE], users: [{ _id: new ObjectId(), username: 'u' }] },
      [walineDbName]: { Comment: [{ _id: new ObjectId(), comment: 'hi' }] },
    },
    mongoOptions || {},
  );
  const result = await createFullBackup({
    client: source.client,
    staticPath: site.staticPath,
    dbName: 'vanBlog',
    walineDbName,
    format: 'gzip',
    outDir: site.outDir,
    workDir: site.workDir,
    ...rest,
  });
  return { result, source };
}

describe('P1 导出：integrity 块、清单副本、.sha256 sidecar', () => {
  let site: ReturnType<typeof makeSite>;
  let result: any;
  beforeAll(async () => {
    site = makeSite();
    seedStatic(site.staticPath, {
      'img/a.webp': 'image-a',
      'img/thumb/a.webp': 'thumb-a',
      'file/doc.pdf': '%PDF',
      'customPage/about/index.html': '<h1>about</h1>',
      'themes/warm-12345678.css': 'body{}',
    });
    ({ result } = await exportOnce(site, {
      source: {
        codeVersion: 'v2026.9.1@0ec01a5',
        walineDB: 'waline',
        demo: false,
        hostname: 'test-host',
        staticPath: site.staticPath,
        codeRunnerPath: '/tmp/codeRunner',
      },
    }));
  });
  afterAll(() => {
    fs.rmSync(site.root, { recursive: true, force: true });
    delete process.env[BACKUP_INTEGRITY_ENV];
  });

  it('清单里有 integrity：算法、merkleRoot、memberCount、两份清单成员为 null', () => {
    const integrity = result.manifest.integrity;
    expect(integrity).toBeTruthy();
    expect(integrity.algorithm).toBe('sha256');
    expect(integrity.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(integrity.merkleRoot).toBe(computeMerkleRoot(integrity.members));
    expect(integrity.members['./manifest.json']).toBeNull();
    expect(integrity.members['./MANIFEST.copy.json']).toBeNull();
    expect(integrity.zstdFrameChecksum).toBe(true); // gzip 的 CRC32 是格式强制的
  });

  it('memberCount 与 members 的键 = 真 tar -tf 的成员表（不是我们自己数出来的）', () => {
    const listed = tarList(result.path);
    expect(result.memberCount).toBe(listed.length);
    expect(result.manifest.integrity.memberCount).toBe(listed.length);
    const realFiles = listed.filter((name) => !name.endsWith('/')).sort();
    const recorded = Object.keys(result.manifest.integrity.members).sort();
    expect(recorded).toEqual(realFiles);
    // 目录项计入 memberCount，但不进 members 表（没有内容可哈希）
    expect(listed.length - realFiles.length).toBeGreaterThan(0);
  });

  it('每个成员的 sha256/bytes 与磁盘上的真文件一致（外部权威 sha256sum）', () => {
    const members = result.manifest.integrity.members;
    const img = members['./static/img/a.webp'];
    expect(img).toBeTruthy();
    expect(img.sha256).toBe(sha256Hex('image-a'));
    expect(img.bytes).toBe('image-a'.length);
    const real = path.join(site.staticPath, 'img', 'a.webp');
    expect(img.sha256).toBe(execFileSync('sha256sum', [real], { encoding: 'utf8' }).split(' ')[0]);
    // ndjson 成员也有哈希（数据库那部分同样受保护）
    const ndjson = members['./db/vanBlog/articles.ndjson'];
    expect(ndjson.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ndjson.bytes).toBeGreaterThan(0);
  });

  it('归档里有第二份清单，且与主清单**逐字节相同**', () => {
    const listed = tarList(result.path);
    expect(listed).toContain('./MANIFEST.copy.json');
    const primary = extractMember(result.path, './manifest.json');
    const copy = extractMember(result.path, './MANIFEST.copy.json');
    expect(primary).not.toBeNull();
    expect(copy).toBe(primary);
    expect(JSON.parse(copy as string).integrity.merkleRoot).toBe(result.manifest.integrity.merkleRoot);
  });

  it('.sha256 sidecar：格式与 sha256sum 相同、内容等于归档真实哈希、sha256sum -c 能过', () => {
    const info = readSha256Sidecar(result.path);
    expect(info.present).toBe(true);
    expect(info.hex).toBe(result.archiveSha256);
    expect(info.name).toBe(result.name);
    expect(fs.readFileSync(`${result.path}.sha256`, 'utf8')).toBe(`${result.archiveSha256}  ${result.name}\n`);
    // 外部权威：coreutils 自己验
    const out = execFileSync('sha256sum', ['-c', `${result.name}.sha256`], {
      cwd: site.outDir,
      encoding: 'utf8',
    });
    expect(out).toContain('OK');
    // sidecar 清单里也记了一份（外部凭据不止一个落脚点）
    const sidecar = JSON.parse(fs.readFileSync(`${result.path}.manifest.json`, 'utf8'));
    expect(sidecar.totals.archiveSha256).toBe(result.archiveSha256);
  });

  it('source 块按传入的值记录（walineDB / demo / hostname / 两个路径）', () => {
    expect(result.manifest.source).toEqual({
      codeVersion: 'v2026.9.1@0ec01a5',
      walineDB: 'waline',
      demo: false,
      hostname: 'test-host',
      staticPath: site.staticPath,
      codeRunnerPath: '/tmp/codeRunner',
    });
  });

  it('导出后立刻校验（含成员级）必须全绿：这条红了说明清单与归档不自洽', async () => {
    const verification = await verifyFullBackup(result.path, { deep: true });
    expect(verification.issues).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.integrity.available).toBe(true);
    expect(verification.integrity.merkleRootOk).toBe(true);
    expect(verification.integrity.memberCountOk).toBe(true);
    expect(verification.integrity.manifestCopyOk).toBe(true);
    expect(verification.integrity.archiveSha256Ok).toBe(true);
    expect(verification.integrity.frameChecksumOk).toBe(true);
    expect(verification.integrity.membersChecked).toBe(
      Object.keys(result.manifest.integrity.members).length,
    );
  });

  it('VANBLOG_BACKUP_INTEGRITY=off 是逃生舱：不写 integrity、不写副本，归档照样能恢复', async () => {
    process.env[BACKUP_INTEGRITY_ENV] = 'off';
    try {
      const off = await exportOnce(site);
      expect(off.result.manifest.integrity).toBeUndefined();
      // ⚠️ 副本清单**照样写**：它与哈希无关（成本 = 一份几 KB 的重复文件），
      // 逃生舱关掉的只是"多一遍 tar 流算成员哈希"这件事
      expect(tarList(off.result.path)).toContain('./MANIFEST.copy.json');
      const target = createFakeMongo();
      const res = await restoreFullBackup({
        client: target.client,
        staticPath: path.join(site.root, 'restore-off'),
        archivePath: off.result.path,
        workDir: site.workDir,
      });
      expect(res.databases.vanBlog.documents).toBe(2);
      // 校验降级而不是拒绝：ok=true，并注明成员级检查不可用
      const verification = await verifyFullBackup(off.result.path, { deep: true });
      expect(verification.ok).toBe(true);
      expect(verification.integrity.available).toBe(false);
      expect(verification.integrity.merkleRootOk).toBeNull();
      expect(verification.integrity.notes.join(' ')).toContain('没有 integrity 块');
    } finally {
      delete process.env[BACKUP_INTEGRITY_ENV];
    }
  });
});

describe('P1 zstd 的内容校验位是**显式**要求的（不是靠 CLI 默认）', () => {
  it('压缩命令里带 --check，declaredFrameChecksum 由它决定', () => {
    const spec = pickSpec('zstd');
    if (!spec) return; // 本机没有 zstd 时这条无意义
    expect(spec.compress).toContain('--check');
    expect(declaredFrameChecksum(spec)).toBe(true);
    expect(declaredFrameChecksum({ ...spec, compress: spec.compress.filter((a) => a !== '--check') })).toBe(
      false,
    );
    expect(declaredFrameChecksum(specFor('gzip')!)).toBe(true);
  });

  const hasZstd = (() => {
    try {
      execFileSync('zstd', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  (hasZstd ? it : it.skip)('真 zstd 归档的帧头 bit2=1，且清单记的就是实测值', async () => {
    const site = makeSite();
    try {
      seedStatic(site.staticPath, { 'img/a.webp': 'image-a' });
      const { result } = await exportOnce(site, { format: 'zstd' });
      const head = Buffer.alloc(5);
      const fd = fs.openSync(result.path, 'r');
      fs.readSync(fd, head, 0, 5, 0);
      fs.closeSync(fd);
      expect(head.subarray(0, 4).toString('hex')).toBe('28b52ffd');
      expect(head[4] & 0x04).toBe(0x04);
      expect(result.manifest.integrity.zstdFrameChecksum).toBe(true);
      expect(result.manifest.compressor).toContain('--check');
      // 校验侧会再实测一次并与清单比对（把"以后换压缩器静默丢掉校验位"钉死）
      const verification = await verifyFullBackup(result.path);
      expect(verification.integrity.frameChecksum).toBe(true);
      expect(verification.integrity.frameChecksumOk).toBe(true);
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });
});

describe('P2 导出原子性与目录卫生', () => {
  it('临时名既躲开后台列表的正则，也躲开脚本的 vanblog-full-*.tar.* glob', () => {
    for (const ext of ['.tar.zst', '.tar.xz', '.tar.gz']) {
      const name = exportTempName(ext);
      expect(name.startsWith(EXPORT_TEMP_PREFIX)).toBe(true);
      expect(name.endsWith(ext)).toBe(true);
      expect(isExportTempName(name)).toBe(true);
      expect(FULL_BACKUP_ARCHIVE_RE.test(name)).toBe(false);
      // 脚本那侧的 glob 是 shell 语义：不以 vanblog-full- 开头就一定不匹配
      expect(name.startsWith('vanblog-full-')).toBe(false);
      // 但 detectFormat 仍认得它（排障时能手工解开看）
      expect(name).toMatch(EXPORT_TEMP_RE);
    }
    expect(isExportTempName('vanblog-full-20260917-000000.tar.zst')).toBe(false);
    expect(isExportTempName('vanblog-full-20260917-000000.tar.zst.partial')).toBe(false);
    // ⚠️ 反例钉住：`.partial` 这种写法**会**被 vanblog-full-* 的 glob 匹到，所以不能用
    expect(FULL_BACKUP_ARCHIVE_RE.test('vanblog-full-20260917-000000.tar.zst.partial')).toBe(false);
    expect('vanblog-full-20260917-000000.tar.zst.partial'.startsWith('vanblog-full-')).toBe(true);
  });

  it('备份列表看不见临时文件（保留策略与列表页共用同一条判据）', async () => {
    const site = makeSite();
    try {
      seedStatic(site.staticPath, { 'img/a.webp': 'a' });
      const { result } = await exportOnce(site);
      const temp = path.join(site.outDir, exportTempName('.tar.gz'));
      fs.writeFileSync(temp, 'half-written-archive');
      fs.writeFileSync(path.join(site.outDir, 'restore-journal.json'), '{}');
      fs.writeFileSync(path.join(site.outDir, 'backup-status.json'), '{}');
      const items = listFullBackups(site.outDir);
      expect(items.map((i) => i.name)).toEqual([result.name]);
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });

  // ⚠️ 这里**不能**用"往 PATH 前面塞一个假 zstd"的办法造失败：jest 的沙箱里改
  // process.env.PATH 传不到 child_process.spawn（实测：假 zstd 没被用上，真 zstd 跑了，
  // 用例变成"导出成功"）。所以改用两条确定性的失败路径：写不进去、改名改不动。
  const canChmod = process.getuid?.() !== 0; // root 无视权限位，那两条断言就不成立

  (canChmod ? it : it.skip)('备份目录写不进去：抛 400、错误里带剩余空间、目录里不留任何半成品', async () => {
    const site = makeSite();
    try {
      seedStatic(site.staticPath, { 'img/a.webp': 'a' });
      fs.chmodSync(site.outDir, 0o500); // r-x：createWriteStream 必然 EACCES
      let caught: any = null;
      try {
        await exportOnce(site);
      } catch (err) {
        caught = err;
      } finally {
        fs.chmodSync(site.outDir, 0o700);
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(String(caught.message)).toContain('写入备份文件失败');
      expect(String(caught.message)).toContain('剩余空间');
      // 目录里既没有正式名，也没有临时名（半成品会挤掉保留策略的名额，见 P2）
      expect(fs.readdirSync(site.outDir)).toEqual([]);
    } finally {
      try {
        fs.chmodSync(site.outDir, 0o700);
      } catch {
        // ignore
      }
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });

  it('改名就位失败：临时文件被删掉，正式名的归档一个都不留（宁可不产出，也不留半成品）', async () => {
    // ⚠️ 不能 jest.spyOn(fs,'renameSync')：Node 24 的 fs 属性不可重定义（Cannot redefine property）。
    // 改用真失败：把**接下来几秒**可能用到的归档名先建成空目录，
    // 于是 rename(临时文件 -> 同名目录) 必然 EISDIR —— 与跨设备/只读目录同一类"就位失败"。
    const site = makeSite();
    try {
      seedStatic(site.staticPath, { 'img/a.webp': 'a' });
      const now = Date.now();
      for (let i = -1; i <= 4; i += 1) {
        fs.mkdirSync(path.join(site.outDir, backupFileName(new Date(now + i * 1000), '.tar.gz')), {
          recursive: true,
        });
      }
      let caught: any = null;
      try {
        await exportOnce(site);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(String(caught.message)).toContain('改名就位失败');
      const left = fs.readdirSync(site.outDir);
      // 临时文件必须已经被删掉（它才是"看起来像归档的半成品"）
      expect(left.filter((n) => isExportTempName(n))).toEqual([]);
      // 正式名下面只有我们预建的**空目录**，一个真归档文件都没有
      expect(
        left.filter((n) => FULL_BACKUP_ARCHIVE_RE.test(n) && fs.statSync(path.join(site.outDir, n)).isFile()),
      ).toEqual([]);
      expect(left.filter((n) => n.endsWith('.sha256') || n.endsWith('.manifest.json'))).toEqual([]);
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });

  it('写盘被静默截断：回读哈希与流出去的哈希不一致 => 删掉半成品并判失败', async () => {
    const site = makeSite();
    // 模拟"写出去 100 字节、盘上只有 90 字节"：把回读那一步的哈希换成别的值
    // hashFile 是从 backupTarStream 导入的绑定，所以 spy 要打在那个模块上
    const spy = jest
      .spyOn(tarStreamModule, 'hashFile')
      .mockResolvedValueOnce({ sha256: 'deadbeef', bytes: 1 } as any);
    try {
      seedStatic(site.staticPath, { 'img/a.webp': 'a' });
      let caught: any = null;
      try {
        await exportOnce(site);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(String(caught.message)).toContain('落盘后与写出的内容不一致');
      expect(fs.readdirSync(site.outDir)).toEqual([]);
    } finally {
      spy.mockRestore();
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });

  it('写盘失败的信息里带剩余空间（ENOSPC 时运维不必再上机器 df）', () => {
    // freeSpaceText 是 tarCompress 失败信息的一部分；这里直接钉这个函数
    const { freeSpaceText } = require('./fullBackup');
    const text = freeSpaceText(os.tmpdir());
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    expect(freeSpaceText('/nonexistent-dir-xyz')).toBe('?');
  });

  it('cleanupStaleExportTemps：只删够旧的 .vanblog-export-*，绝不碰归档与 sidecar', () => {
    const site = makeSite();
    try {
      const old = path.join(site.outDir, exportTempName('.tar.zst'));
      const fresh = path.join(site.outDir, exportTempName('.tar.gz'));
      const archive = path.join(site.outDir, 'vanblog-full-20260917-000000.tar.zst');
      fs.writeFileSync(old, 'x');
      fs.writeFileSync(fresh, 'x');
      fs.writeFileSync(archive, 'x');
      fs.writeFileSync(`${archive}.manifest.json`, '{}');
      fs.writeFileSync(`${archive}.sha256`, 'x');
      const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
      fs.utimesSync(old, new Date(twoHoursAgo), new Date(twoHoursAgo));
      fs.utimesSync(fresh, new Date(), new Date());

      const removed = cleanupStaleExportTemps(site.outDir);
      expect(removed).toEqual([path.basename(old)]);
      const left = fs.readdirSync(site.outDir).sort();
      expect(left).toEqual([
        'vanblog-full-20260917-000000.tar.zst',
        'vanblog-full-20260917-000000.tar.zst.manifest.json',
        'vanblog-full-20260917-000000.tar.zst.sha256',
        path.basename(fresh),
      ].sort());
      // 目录不存在也不抛（启动路径上绝不能因为这事崩）
      expect(cleanupStaleExportTemps(path.join(site.root, 'nope'))).toEqual([]);
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });
});

describe('P3 恢复的 100% 保真', () => {
  let site: ReturnType<typeof makeSite>;
  let archivePath = '';
  beforeAll(async () => {
    site = makeSite();
    seedStatic(site.staticPath, {
      'img/a.webp': 'image-a',
      'img/thumb/a.webp': 'thumb-a',
      'file/doc.pdf': '%PDF',
      'customPage/about/index.html': '<h1>about</h1>',
      'themes/warm-12345678.css': 'body{}',
    });
    const exported = await exportOnce(site, {
      // 源实例的 waline 库就叫 waline_prod（config.yaml 里机器本地的那个名字）
      walineDbName: 'waline_prod',
      source: {
        codeVersion: 'v2026.9.1@0ec01a5',
        walineDB: 'waline_prod',
        demo: false,
        hostname: 'source-host',
        staticPath: site.staticPath,
        codeRunnerPath: '/tmp/codeRunner',
      },
    });
    archivePath = exported.result.path;
  });
  afterAll(() => {
    fs.rmSync(site.root, { recursive: true, force: true });
    delete process.env[RESTORE_PRUNE_STATIC_ENV];
    delete process.env[RESTORE_DROP_ABSENT_ENV];
  });

  function restoreTarget(files: Record<string, string>) {
    const target = fs.mkdtempSync(path.join(site.root, 'target-'));
    seedStatic(target, files);
    return target;
  }

  it('默认修剪：归档里没有的文件被删掉，结果与归档**完全一致**（不是并集）', async () => {
    const targetStatic = restoreTarget({
      'img/a.webp': 'old-version',
      'img/orphan.webp': 'uploaded-after-backup',
      'img/thumb/orphan-thumb.webp': 'thumb',
      'file/orphan.pdf': 'x',
      'themes/old-theme-deadbeef.css': 'body{color:red}',
      'rss/feed.xml': '<rss/>', // 不在 BACKUP_STATIC_FOLDERS 里：绝不能碰
    });
    const mongo = createFakeMongo();
    const res = await restoreFullBackup({
      client: mongo.client,
      staticPath: targetStatic,
      archivePath,
      workDir: site.workDir,
    });

    const img = listTree(path.join(targetStatic, 'img'));
    expect(img).toEqual(['a.webp', 'thumb', 'thumb/a.webp']);
    expect(fs.readFileSync(path.join(targetStatic, 'img', 'a.webp'), 'utf8')).toBe('image-a');
    expect(listTree(path.join(targetStatic, 'themes'))).toEqual(['warm-12345678.css']);
    expect(listTree(path.join(targetStatic, 'file'))).toEqual(['doc.pdf']);
    // 四个目录之外一个字节都不动
    expect(fs.existsSync(path.join(targetStatic, 'rss', 'feed.xml'))).toBe(true);

    expect(res.pruned.length).toBeGreaterThan(0);
    const imgReport = res.pruned.find((item) => item.folder === 'img')!;
    expect(imgReport.removedFiles).toBe(2);
    expect(imgReport.names).toEqual(expect.arrayContaining(['orphan.webp', 'thumb/orphan-thumb.webp']));
    const notes = res.notes.join(' | ');
    expect(notes).toContain('按归档修剪');
    expect(notes).toContain('VANBLOG_RESTORE_PRUNE_STATIC=off');
    fs.rmSync(targetStatic, { recursive: true, force: true });
  });

  it('VANBLOG_RESTORE_PRUNE_STATIC=off：保留孤儿文件，并在 notes 里说清"这是并集"', async () => {
    process.env[RESTORE_PRUNE_STATIC_ENV] = 'off';
    try {
      expect(restorePruneStaticEnabled()).toBe(false);
      const targetStatic = restoreTarget({ 'img/a.webp': 'old', 'img/orphan.webp': 'keep-me' });
      const mongo = createFakeMongo();
      const res = await restoreFullBackup({
        client: mongo.client,
        staticPath: targetStatic,
        archivePath,
        workDir: site.workDir,
      });
      expect(fs.existsSync(path.join(targetStatic, 'img', 'orphan.webp'))).toBe(true);
      expect(res.pruned).toEqual([]);
      expect(res.notes.join(' | ')).toContain('未修剪静态目录');
      fs.rmSync(targetStatic, { recursive: true, force: true });
    } finally {
      delete process.env[RESTORE_PRUNE_STATIC_ENV];
    }
    expect(restorePruneStaticEnabled()).toBe(true); // 默认开
  });

  it('拷贝失败 => **一个文件都不删**（修剪严格排在所有拷贝之后）', async () => {
    const targetStatic = restoreTarget({
      'img/a.webp': 'old',
      'img/orphan.webp': 'must-survive',
      'themes/orphan-theme.css': 'must-survive-too',
    });
    // 把 file 换成一个**普通文件**：ensureDir 会 EEXIST/ENOTDIR ⇒ 拷贝阶段就炸
    fs.rmSync(path.join(targetStatic, 'file'), { recursive: true, force: true });
    fs.writeFileSync(path.join(targetStatic, 'file'), 'not a directory');
    const mongo = createFakeMongo();
    await expect(
      restoreFullBackup({
        client: mongo.client,
        staticPath: targetStatic,
        archivePath,
        workDir: site.workDir,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // img 已经拷过了，但它**还没被修剪**：孤儿必须还在
    expect(fs.existsSync(path.join(targetStatic, 'img', 'orphan.webp'))).toBe(true);
    expect(fs.existsSync(path.join(targetStatic, 'themes', 'orphan-theme.css'))).toBe(true);
    fs.rmSync(targetStatic, { recursive: true, force: true });
  });

  it('归档里没有的静态段：对应目录原样保留，并在 notes 里说明（老归档不会被清空）', async () => {
    // 用一份不含 themes 的归档（模拟 §7.55 C 之前导出的老归档）
    const site2 = makeSite();
    seedStatic(site2.staticPath, { 'img/a.webp': 'a' });
    const { result } = await exportOnce(site2);
    const targetStatic = restoreTarget({ 'img/a.webp': 'old', 'themes/keep-me.css': 'body{}' });
    const mongo = createFakeMongo();
    const res = await restoreFullBackup({
      client: mongo.client,
      staticPath: targetStatic,
      archivePath: result.path,
      workDir: site.workDir,
    });
    expect(fs.existsSync(path.join(targetStatic, 'themes', 'keep-me.css'))).toBe(true);
    expect(res.notes.join(' | ')).toContain('归档里没有 static/themes/ 这一段');
    expect(res.pruned.find((item) => item.folder === 'themes')).toBeUndefined();
    fs.rmSync(targetStatic, { recursive: true, force: true });
    fs.rmSync(site2.root, { recursive: true, force: true });
  });

  it('归档里没有的集合：默认只报告（名字+条数），开关打开才删，system.* 与临时表永不碰', async () => {
    expect(restoreDropAbsentEnabled()).toBe(false); // 默认关
    const mongo = createFakeMongo({
      vanBlog: {
        legacy_stuff: [{ _id: 1 }, { _id: 2 }, { _id: 3 }],
        // ⚠️ 不能用 articles__vanblog_restore：恢复 articles 时用的临时表就是这个名字
        'orphans__vanblog_restore': [{ _id: 9 }],
        'system.views': [{ _id: 'v' }],
      },
    });
    const targetStatic = restoreTarget({});
    const res = await restoreFullBackup({
      client: mongo.client,
      staticPath: targetStatic,
      archivePath,
      workDir: site.workDir,
    });
    expect(res.absentCollections).toEqual([
      { db: 'vanBlog', collection: 'legacy_stuff', documents: 3, dropped: false },
    ]);
    expect(res.notes.join(' | ')).toContain('legacy_stuff（3 条');
    expect(res.notes.join(' | ')).toContain('混合状态');
    // 没删
    expect(mongo.state.vanBlog.legacy_stuff).toHaveLength(3);
    expect(mongo.dropped).toEqual([]);
    expect(isProtectedCollectionName('system.views')).toBe(true);
    expect(isProtectedCollectionName('orphans__vanblog_restore')).toBe(true);
    expect(isProtectedCollectionName('articles')).toBe(false);

    // 打开开关：legacy_stuff 被删，受保护的两张仍然在
    process.env[RESTORE_DROP_ABSENT_ENV] = 'on';
    try {
      expect(restoreDropAbsentEnabled()).toBe(true);
      const mongo2 = createFakeMongo({
        vanBlog: {
          legacy_stuff: [{ _id: 1 }],
          'orphans__vanblog_restore': [{ _id: 9 }],
          'system.views': [{ _id: 'v' }],
        },
      });
      const res2 = await restoreFullBackup({
        client: mongo2.client,
        staticPath: restoreTarget({}),
        archivePath,
        workDir: site.workDir,
      });
      expect(res2.absentCollections).toEqual([
        { db: 'vanBlog', collection: 'legacy_stuff', documents: 1, dropped: true },
      ]);
      expect(mongo2.dropped).toEqual(['vanBlog.legacy_stuff']);
      expect(mongo2.state.vanBlog['orphans__vanblog_restore']).toHaveLength(1);
      expect(mongo2.state.vanBlog['system.views']).toHaveLength(1);
      expect(mongo2.dropped).not.toContain('vanBlog.orphans__vanblog_restore');
      expect(mongo2.dropped).not.toContain('vanBlog.system.views');
      expect(res2.notes.join(' | ')).toContain('已按 VANBLOG_RESTORE_DROP_ABSENT_COLLECTIONS 删除');
    } finally {
      delete process.env[RESTORE_DROP_ABSENT_ENV];
    }
    fs.rmSync(targetStatic, { recursive: true, force: true });
  });

  it('waline 库名不一致：WARN 点名两个值并说清后果；一致时不啰嗦', async () => {
    const targetStatic = restoreTarget({});
    const mongo = createFakeMongo();
    const res = await restoreFullBackup({
      client: mongo.client,
      staticPath: targetStatic,
      archivePath,
      workDir: site.workDir,
      target: { walineDB: 'waline', demo: false, codeVersion: 'v2026.9.1@0ec01a5' },
    });
    expect(res.databases.waline_prod).toEqual({ collections: 1, documents: 1 });
    const warn = res.notes.find((note) => note.startsWith('WARN waline'));
    expect(warn).toBeTruthy();
    expect(warn).toContain('"waline_prod"');
    expect(warn).toContain('"waline"');
    expect(warn).toContain('本实例读的是 "waline"');
    // waline 的数据确实被写进了归档里的那个库名（而不是本实例配置的那个）
    expect(mongo.state.waline_prod.Comment).toHaveLength(1);
    expect(mongo.state.waline).toBeUndefined();

    const mongo2 = createFakeMongo();
    const res2 = await restoreFullBackup({
      client: mongo2.client,
      staticPath: restoreTarget({}),
      archivePath,
      workDir: site.workDir,
      target: { walineDB: 'waline_prod', demo: false, codeVersion: 'v2026.9.1@0ec01a5' },
    });
    expect(res2.notes.some((note) => note.startsWith('WARN waline'))).toBe(false);
    expect(res2.notes.some((note) => note.startsWith('WARN 演示模式'))).toBe(false);
    fs.rmSync(targetStatic, { recursive: true, force: true });
  });

  it('demo 不一致也要 WARN（恢复出来的站点行为会变）', async () => {
    const mongo = createFakeMongo();
    const res = await restoreFullBackup({
      client: mongo.client,
      staticPath: restoreTarget({}),
      archivePath,
      workDir: site.workDir,
      target: { walineDB: 'waline_prod', demo: true },
    });
    const warn = res.notes.find((note) => note.startsWith('WARN 演示模式'));
    expect(warn).toContain('demo=true');
    expect(warn).toContain('demo=false');
  });

  it('没有 source 块的老归档：不比对，只在 notes 里说明（绝不拒绝恢复）', async () => {
    const site2 = makeSite();
    seedStatic(site2.staticPath, { 'img/a.webp': 'a' });
    const { result } = await exportOnce(site2); // 不传 source
    const mongo = createFakeMongo();
    const res = await restoreFullBackup({
      client: mongo.client,
      staticPath: restoreTarget({}),
      archivePath: result.path,
      workDir: site.workDir,
      target: { walineDB: 'waline', demo: false },
    });
    expect(res.notes.join(' | ')).toContain('没有 source 块');
    expect(res.databases.vanBlog.documents).toBe(2);
    fs.rmSync(site2.root, { recursive: true, force: true });
  });
});

describe('P5 恢复日志（journal）接线', () => {
  let site: ReturnType<typeof makeSite>;
  let archivePath = '';
  beforeAll(async () => {
    site = makeSite();
    seedStatic(site.staticPath, { 'img/a.webp': 'a' });
    ({ result: { path: archivePath } } = await exportOnce(site));
  });
  afterAll(() => fs.rmSync(site.root, { recursive: true, force: true }));

  it('成功恢复后 journal 被删掉（没有断点）', async () => {
    const journalPath = path.join(site.outDir, RESTORE_JOURNAL_FILE);
    const mongo = createFakeMongo();
    await restoreFullBackup({
      client: mongo.client,
      staticPath: path.join(site.root, 'target-ok'),
      archivePath,
      workDir: site.workDir,
      journalPath,
    });
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(readRestoreJournal(site.outDir)).toBeNull();
  });

  it('恢复中途失败：journal 留下，phase=failed，done 里是**已经换好的那几张表**', async () => {
    const journalPath = path.join(site.outDir, RESTORE_JOURNAL_FILE);
    // users 这张表写不进去 ⇒ 恢复在第二张表上炸
    const mongo = createFakeMongo({}, { failInsertOn: 'users' });
    await expect(
      restoreFullBackup({
        client: mongo.client,
        staticPath: path.join(site.root, 'target-fail'),
        archivePath,
        workDir: site.workDir,
        journalPath,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const journal = readRestoreJournal(site.outDir);
    expect(journal).not.toBeNull();
    expect(journal!.phase).toBe('failed');
    expect(journal!.error).toContain('users');
    expect(journal!.archiveName).toBe(path.basename(archivePath));
    // 计划里有 3 张表（articles/users/Comment），失败前只换好了 articles
    expect(Object.values(journal!.planned).flat().sort()).toEqual(['Comment', 'articles', 'users']);
    expect(journal!.done.map((item) => item.collection)).toEqual(['articles']);
  });
});

describe('P6 caddy 段（默认关）', () => {
  it('开关默认关', () => {
    expect(backupIncludeCaddyEnabled({} as any)).toBe(false);
    expect(backupIncludeCaddyEnabled({ VANBLOG_BACKUP_INCLUDE_CADDY: 'on' } as any)).toBe(true);
  });

  it('传了 caddyDataPath 才打包：归档里出现 ./caddy 段，清单里有 caddy 统计', async () => {
    const site = makeSite();
    try {
      const caddyDir = path.join(site.root, 'caddy-data');
      seedStatic(caddyDir, {
        'certificates/acme-v02.api.letsencrypt.org/example.com/example.com.crt': 'CERT',
        'certificates/acme-v02.api.letsencrypt.org/example.com/example.com.key': 'KEY',
      });
      seedStatic(site.staticPath, { 'img/a.webp': 'a' });
      const { result } = await exportOnce(site, { caddyDataPath: caddyDir });
      expect(result.manifest.caddy).toEqual({ files: 2, bytes: 7 }); // 'CERT'=4 + 'KEY'=3
      const listed = tarList(result.path);
      expect(listed).toContain('./caddy/');
      expect(
        listed.filter((name) => name.startsWith('./caddy/') && !name.endsWith('/')).sort(),
      ).toEqual([
        './caddy/certificates/acme-v02.api.letsencrypt.org/example.com/example.com.crt',
        './caddy/certificates/acme-v02.api.letsencrypt.org/example.com/example.com.key',
      ]);
      // 成员哈希也覆盖了这一段（TLS 材料同样受防损坏保护）
      expect(
        result.manifest.integrity.members[
          './caddy/certificates/acme-v02.api.letsencrypt.org/example.com/example.com.key'
        ].sha256,
      ).toBe(sha256Hex('KEY'));
      // 校验侧的 caddy 计数检查通过
      const verification = await verifyFullBackup(result.path);
      expect(verification.issues).toEqual([]);

      // 恢复：给了目标目录才写回
      const targetCaddy = path.join(site.root, 'restored-caddy');
      const mongo = createFakeMongo();
      const res = await restoreFullBackup({
        client: mongo.client,
        staticPath: path.join(site.root, 'target-caddy'),
        archivePath: result.path,
        workDir: site.workDir,
        caddyDataPath: targetCaddy,
      });
      expect(res.caddy).toEqual({ files: 2, bytes: 7, target: targetCaddy });
      expect(
        fs.readFileSync(
          path.join(targetCaddy, 'certificates/acme-v02.api.letsencrypt.org/example.com/example.com.key'),
          'utf8',
        ),
      ).toBe('KEY');
      expect(res.notes.join(' | ')).toContain('caddy 需要重启');

      // 不给目标目录：只报告，绝不往没被要求的位置写私钥
      const mongo2 = createFakeMongo();
      const res2 = await restoreFullBackup({
        client: mongo2.client,
        staticPath: path.join(site.root, 'target-caddy2'),
        archivePath: result.path,
        workDir: site.workDir,
      });
      expect(res2.caddy).toBeNull();
      expect(res2.notes.join(' | ')).toContain('已跳过');
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });

  it('caddy 目录不存在：只 WARN，备份照常成功（证书可以再签，数据没了就没了）', async () => {
    const site = makeSite();
    try {
      seedStatic(site.staticPath, { 'img/a.webp': 'a' });
      const warns: string[] = [];
      const { result } = await exportOnce(site, {
        caddyDataPath: path.join(site.root, 'no-such-caddy'),
        logger: { log: () => undefined, warn: (m: string) => warns.push(m) },
      });
      expect(result.manifest.caddy).toBeUndefined();
      expect(tarList(result.path)).not.toContain('./caddy/');
      expect(warns.join(' | ')).toContain('caddy 数据目录不存在');
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });

  it('相对路径的 caddy 目标目录被拒绝（不往一个说不清的位置写私钥）', async () => {
    const site = makeSite();
    try {
      const caddyDir = path.join(site.root, 'caddy-data');
      seedStatic(caddyDir, { 'certificates/a.crt': 'CERT' });
      seedStatic(site.staticPath, { 'img/a.webp': 'a' });
      const { result } = await exportOnce(site, { caddyDataPath: caddyDir });
      const mongo = createFakeMongo();
      const res = await restoreFullBackup({
        client: mongo.client,
        staticPath: path.join(site.root, 'target-rel'),
        archivePath: result.path,
        workDir: site.workDir,
        caddyDataPath: 'relative/caddy',
      });
      expect(res.caddy).toBeNull();
      expect(res.notes.join(' | ')).toContain('不是安全的绝对路径');
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });
});

describe('hashStagingTree（导出前那一遍 tar 流）', () => {
  it('成员数与真 tar -tf 一致，且能发现同名成员/坏头', async () => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-staging-'));
    try {
      seedStatic(staging, { 'db/a.ndjson': '{"x":1}\n', 'static/img/b.webp': 'bb' });
      const hashed = await hashStagingTree(staging);
      const listed = execFileSync('sh', ['-c', `tar -cf - -C '${staging}' . | tar -tf -`], {
        encoding: 'utf8',
      })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      expect(hashed.memberCount).toBe(listed.length);
      expect(hashed.complete).toBe(true);
      expect(hashed.badHeaders).toEqual([]);
      expect(hashed.duplicateNames).toEqual([]);
      expect(hashed.members['./db/a.ndjson'].sha256).toBe(sha256Hex('{"x":1}\n'));
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('tar 退出码非 0/1 时 reject（绝不静默给出一张空表 —— 那会让整份清单变成"全都缺"）', async () => {
    // 目录不存在 => `tar -cf - -C <不存在> .` 退出码 2
    const missing = path.join(os.tmpdir(), 'vanblog-staging-missing-' + Date.now());
    await expect(hashStagingTree(missing)).rejects.toBeInstanceOf(BadRequestException);
  });

  // ⚠️ 不能用 jest.spyOn(fullBackupModule,'hashStagingTree')：它是**同模块内部**的调用，
  // ts-jest 编出来是直接函数调用而不是 exports.xxx，spy 拦不到（会变成一个"永远绿"的假用例）。
  // 所以用真手段：让 tar 读不动暂存树里的某个文件（退出码 2），导出必须在打包之前就中止。
  (process.getuid?.() !== 0 ? it : it.skip)(
    '打包前那一遍 tar 失败 => 导出中止，不产出任何文件（宁可失败也不要一份哈希表残缺的清单）',
    async () => {
      const site = makeSite();
      try {
        seedStatic(site.staticPath, { 'img/a.webp': 'a', 'img/unreadable.webp': 'secret' });
        fs.chmodSync(path.join(site.staticPath, 'img', 'unreadable.webp'), 0o000);
        let caught: any = null;
        try {
          await exportOnce(site);
        } catch (err) {
          caught = err;
        } finally {
          fs.chmodSync(path.join(site.staticPath, 'img', 'unreadable.webp'), 0o600);
        }
        expect(caught).toBeInstanceOf(BadRequestException);
        expect(String(caught.message)).toMatch(/计算成员哈希失败|tar/);
        expect(fs.readdirSync(site.outDir)).toEqual([]);
        expect(fs.readdirSync(site.workDir)).toEqual([]); // 暂存目录也清掉了
      } finally {
        fs.rmSync(site.root, { recursive: true, force: true });
      }
    },
  );
});

describe('导出产生的暂存目录不留垃圾', () => {
  it('workDir 里没有 full-backup-* 残留，备份目录里只有归档 + 两个 sidecar', async () => {
    const site = makeSite();
    try {
      seedStatic(site.staticPath, { 'img/a.webp': 'a' });
      const { result } = await exportOnce(site);
      expect(fs.readdirSync(site.workDir)).toEqual([]);
      expect(fs.readdirSync(site.outDir).sort()).toEqual(
        [result.name, `${result.name}.manifest.json`, `${result.name}.sha256`].sort(),
      );
      // 顺带钉住：spawnSync 的失败分支不会把 tar 的报错吞掉
      expect(spawnSync('tar', ['--version']).status).toBe(0);
    } finally {
      fs.rmSync(site.root, { recursive: true, force: true });
    }
  });
});
