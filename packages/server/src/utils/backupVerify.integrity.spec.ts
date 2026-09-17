import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildIntegrity } from './backupIntegrity';
import { sha256Hex } from './backupTarStream';
import { FullBackupManifest } from './backupCodec';
import { hashArchiveMembers, hashStagingTree, specFor } from './fullBackup';
import { verifyFullBackup } from './backupVerify';

/**
 * P1 防损坏校验（`backupVerify.ts` 里 7..11 那几项）的钉子。
 *
 * ⚠️ 这里最关键的一条负控是「**解压器查不出来的成员篡改**」：
 * gzip/xz/zstd 自带 CRC，任何一位翻转都会让解压失败，于是 `readThrough` 就已经红了 ——
 * 那成员级哈希还有什么用？用处在于"**归档被人重新打过包**"这种情况：
 * 一个字节都没坏、CRC 全对、`tar -tf` 也正常，但里面的图已经不是清单记的那张了。
 * 下面的 `mutateAfterHash` 就是精确构造这种归档（先算哈希、再改内容、再打包），
 * 用来证明 cheap 路径 **ok:true** 而 deep 路径 **ok:false 且点名那个文件** ——
 * 如果这两条断言有一天同时变成 true，就说明成员级校验是白做的。
 */

jest.setTimeout(180000);

interface BuildOptions {
  /** 算完成员哈希之后、打包之前改暂存树（构造"归档与清单不符但压缩流完好"的样本） */
  mutateAfterHash?: (staging: string) => void;
  /** 改清单（构造 memberCount / merkleRoot / frameChecksum 不一致） */
  mutateManifest?: (manifest: FullBackupManifest) => void;
  /** 副本清单与主清单不同（构造 manifestCopy 失败） */
  copyDifferent?: boolean;
  /** 压缩命令与后缀（默认 gzip；zstd 的用例单独给） */
  compress?: string;
  ext?: string;
  name?: string;
  sha256Sidecar?: 'correct' | 'wrong' | 'none';
  /** integrity 块里记的压缩器校验位（默认按 gzip=true） */
  frameChecksum?: boolean;
}

function baseManifest(): FullBackupManifest {
  return {
    kind: 'vanblog-full-backup' as any,
    version: 1,
    createdAt: '2026-09-17T00:00:00.000Z',
    format: 'gzip',
    compressor: 'gzip -9',
    databases: {
      vanBlog: {
        collections: {
          articles: { count: 2, bytes: 16, indexes: 0 },
          users: { count: 1, bytes: 8, indexes: 0 },
        },
      },
    },
    static: { img: { files: 2, bytes: 5 } },
    totals: { databases: 1, collections: 2, documents: 3, files: 2, staticBytes: 5 },
  };
}

async function buildArchive(dir: string, options: BuildOptions = {}) {
  const staging = path.join(dir, 'staging');
  fs.mkdirSync(path.join(staging, 'db', 'vanBlog'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'static', 'img', 'thumb'), { recursive: true });
  // 2 条文档 16 字节 / 1 条文档 8 字节 / 两张图 5 字节 —— 与 baseManifest 的计数严格对齐
  fs.writeFileSync(path.join(staging, 'db', 'vanBlog', 'articles.ndjson'), '{"id":1}\n{"id":2}\n');
  fs.writeFileSync(path.join(staging, 'db', 'vanBlog', 'articles.indexes.json'), '[]');
  fs.writeFileSync(path.join(staging, 'db', 'vanBlog', 'users.ndjson'), '{"id":0}\n');
  fs.writeFileSync(path.join(staging, 'db', 'vanBlog', 'users.indexes.json'), '[]');
  fs.writeFileSync(path.join(staging, 'static', 'img', 'a.webp'), 'aaa');
  fs.writeFileSync(path.join(staging, 'static', 'img', 'thumb', 'a.webp'), 'bb');

  const manifest = baseManifest();
  const hashed = await hashStagingTree(staging);
  manifest.integrity = buildIntegrity({
    members: hashed.members,
    memberCount: hashed.memberCount,
    frameChecksum: options.frameChecksum ?? true,
  });
  const expectedHashes = JSON.parse(JSON.stringify(hashed.members));

  options.mutateAfterHash?.(staging);
  options.mutateManifest?.(manifest);

  const text = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(staging, 'manifest.json'), text);
  fs.writeFileSync(
    path.join(staging, 'MANIFEST.copy.json'),
    options.copyDifferent ? `${text}\n` : text,
  );

  const name = options.name || 'vanblog-full-20260917-000000.tar.gz';
  const archivePath = path.join(dir, name);
  const compress = options.compress || 'gzip -9 -c';
  execFileSync('sh', ['-c', `tar -cf - -C '${staging}' . | ${compress} > '${archivePath}'`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const bytes = fs.statSync(archivePath).size;
  const archiveSha256 = execFileSync('sha256sum', [archivePath], { encoding: 'utf8' }).split(' ')[0];
  // 与 createFullBackup 一致：sidecar 清单里带 archiveBytes 与 archiveSha256（内部那份没有）
  const sidecarManifest = {
    ...manifest,
    totals: { ...manifest.totals, archiveBytes: bytes, archiveSha256 },
  };
  fs.writeFileSync(`${archivePath}.manifest.json`, JSON.stringify(sidecarManifest, null, 2));
  const mode = options.sha256Sidecar ?? 'correct';
  if (mode !== 'none') {
    const hex =
      mode === 'wrong'
        ? 'f'.repeat(64)
        : execFileSync('sha256sum', [archivePath], { encoding: 'utf8' }).split(' ')[0];
    fs.writeFileSync(`${archivePath}.sha256`, `${hex}  ${name}\n`);
  }
  return { archivePath, manifest, expectedHashes, name };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-verify-int-'));
}

describe('verifyFullBackup：integrity 那一组（P1）', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('健康的归档：cheap 与 deep 都全绿，且每一项都是"查过并通过"（不是 null）', async () => {
    const { archivePath, manifest } = await buildArchive(dir);
    const cheap = await verifyFullBackup(archivePath);
    expect(cheap.issues).toEqual([]);
    expect(cheap.ok).toBe(true);
    expect(cheap.integrity).toMatchObject({
      available: true,
      merkleRootOk: true,
      memberCountOk: true,
      manifestCopyOk: true,
      archiveSha256Ok: true,
      frameChecksumOk: true,
      membersChecked: null,
    });
    expect(cheap.integrity.recordedMembers).toBe(Object.keys(manifest.integrity!.members).length);

    const deep = await verifyFullBackup(archivePath, { deep: true });
    expect(deep.issues).toEqual([]);
    expect(deep.ok).toBe(true);
    expect(deep.integrity.membersChecked).toBe(Object.keys(manifest.integrity!.members).length);
    expect(deep.integrity.memberFindings).toEqual([]);
    expect(deep.integrity.notes.join(' ')).toContain('成员级哈希全部匹配');
  });

  it('成员被换掉（压缩流完好）：cheap 全绿，deep 点名那个文件并给出期望/实际哈希', async () => {
    const { archivePath, manifest } = await buildArchive(dir, {
      mutateAfterHash: (staging) => {
        // 打包前把一张图换掉：CRC 全对、tar 正常，只有成员哈希能发现
        fs.writeFileSync(path.join(staging, 'static', 'img', 'a.webp'), 'EVIL');
      },
    });
    const cheap = await verifyFullBackup(archivePath);
    expect(cheap.ok).toBe(true); // ← 这就是"成员级哈希不是白加的"的证据
    expect(cheap.integrity.membersChecked).toBeNull();

    const deep = await verifyFullBackup(archivePath, { deep: true });
    expect(deep.ok).toBe(false);
    const issue = deep.issues.find((i) => i.check === 'memberHashes');
    expect(issue).toBeTruthy();
    expect(issue!.message).toContain('./static/img/a.webp');
    expect(issue!.message).toContain(sha256Hex('aaa').slice(0, 12));
    expect(issue!.message).toContain(sha256Hex('EVIL').slice(0, 12));
    expect(deep.integrity.memberFindings).toEqual([
      {
        kind: 'hash',
        path: './static/img/a.webp',
        expected: manifest.integrity!.members['./static/img/a.webp']!.sha256,
        actual: sha256Hex('EVIL'),
        message: 'sha256 不匹配',
      },
    ]);
  });

  it('成员被删掉：cheap 由 memberCount 抓到，deep 另外点名 missing', async () => {
    const { archivePath } = await buildArchive(dir, {
      mutateAfterHash: (staging) => {
        fs.rmSync(path.join(staging, 'static', 'img', 'thumb', 'a.webp'));
      },
    });
    const cheap = await verifyFullBackup(archivePath);
    expect(cheap.ok).toBe(false);
    expect(cheap.integrity.memberCountOk).toBe(false);
    expect(cheap.issues.some((i) => i.check === 'integrityMemberCount')).toBe(true);

    const deep = await verifyFullBackup(archivePath, { deep: true });
    expect(deep.integrity.memberFindings.map((f) => [f.kind, f.path])).toEqual([
      ['missing', './static/img/thumb/a.webp'],
    ]);
  });

  it('归档里被塞进一个清单外的成员：deep 报 unexpected（篡改/夹带的证据）', async () => {
    const { archivePath } = await buildArchive(dir, {
      mutateAfterHash: (staging) => {
        fs.writeFileSync(path.join(staging, 'static', 'img', 'shell.php'), '<?php evil();');
      },
    });
    const deep = await verifyFullBackup(archivePath, { deep: true });
    expect(deep.ok).toBe(false);
    expect(deep.integrity.memberFindings.map((f) => [f.kind, f.path])).toEqual([
      ['unexpected', './static/img/shell.php'],
    ]);
  });

  it('副本清单与主清单不一致：manifestCopyOk=false 并说明"其中一份已损坏"', async () => {
    const { archivePath } = await buildArchive(dir, { copyDifferent: true });
    const result = await verifyFullBackup(archivePath);
    expect(result.ok).toBe(false);
    expect(result.integrity.manifestCopyOk).toBe(false);
    expect(result.issues.some((i) => i.check === 'manifestCopy')).toBe(true);
    expect(result.issues.find((i) => i.check === 'manifestCopy')!.message).toContain('内容不一致');
  });

  it('归档里没有副本清单：也算发现（副本就是为"主清单坏了"准备的）', async () => {
    const { archivePath } = await buildArchive(dir);
    // 重新打一份不含 MANIFEST.copy.json 的归档（清单里仍然登记着它）
    const staging = path.join(dir, 'staging');
    fs.rmSync(path.join(staging, 'MANIFEST.copy.json'));
    const rebuilt = path.join(dir, 'vanblog-full-20260917-000001.tar.gz');
    execFileSync('sh', ['-c', `tar -cf - -C '${staging}' . | gzip -9 -c > '${rebuilt}'`]);
    const result = await verifyFullBackup(rebuilt);
    expect(result.ok).toBe(false);
    expect(result.integrity.manifestCopyOk).toBe(false);
    expect(result.issues.find((i) => i.check === 'manifestCopy')!.message).toContain('没有 ./MANIFEST.copy.json');
  });

  it('merkleRoot 被改：integrityMerkleRoot 失败（哈希表自身的指纹）', async () => {
    const { archivePath } = await buildArchive(dir, {
      mutateManifest: (manifest) => {
        manifest.integrity!.merkleRoot = '0'.repeat(64);
      },
    });
    const result = await verifyFullBackup(archivePath);
    expect(result.ok).toBe(false);
    expect(result.integrity.merkleRootOk).toBe(false);
    expect(result.issues.some((i) => i.check === 'integrityMerkleRoot')).toBe(true);
  });

  it('members 表被增删一项：merkleRoot 对不上（表本身被截断也能发现）', async () => {
    const { archivePath } = await buildArchive(dir, {
      mutateManifest: (manifest) => {
        delete manifest.integrity!.members['./static/img/a.webp'];
      },
    });
    const result = await verifyFullBackup(archivePath, { deep: true });
    expect(result.ok).toBe(false);
    expect(result.integrity.merkleRootOk).toBe(false);
    // 少了期望项 ⇒ deep 还会报"归档里多出一个清单里没有的成员"
    expect(result.integrity.memberFindings.map((f) => f.kind)).toContain('unexpected');
  });

  it('memberCount 记错：integrityMemberCount 失败', async () => {
    const { archivePath } = await buildArchive(dir, {
      mutateManifest: (manifest) => {
        manifest.integrity!.memberCount = 999;
      },
    });
    const result = await verifyFullBackup(archivePath);
    expect(result.ok).toBe(false);
    expect(result.integrity.memberCountOk).toBe(false);
  });

  it('.sha256 sidecar 与真实哈希不符：archiveSha256 失败（整份归档被改动过）', async () => {
    const { archivePath } = await buildArchive(dir, { sha256Sidecar: 'wrong' });
    const result = await verifyFullBackup(archivePath);
    expect(result.ok).toBe(false);
    expect(result.integrity.archiveSha256Ok).toBe(false);
    const message = result.issues.find((i) => i.check === 'archiveSha256')!.message;
    expect(message).toContain(`${'f'.repeat(12)}…`);
    expect(message).not.toContain('ffffffffffffffffffffffffffffffff');
  });

  it('没有 .sha256 sidecar 但清单里有 archiveSha256：仍然比对（外部凭据不止一个落脚点）', async () => {
    const { archivePath } = await buildArchive(dir, { sha256Sidecar: 'none' });
    const ok = await verifyFullBackup(archivePath);
    expect(ok.integrity.archiveSha256Ok).toBe(true);
    expect(ok.integrity.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    // 把清单里记的那个值改掉（归档本体不动）：只靠清单也能发现不一致。
    // ⚠️ 这里**不能**改归档本体 —— gzip/zstd 的 CRC 会先让 readThrough 失败并提前返回，
    // 于是这一项根本不会被查（这是设计如此：读不通的归档没必要再比哈希）
    const sidecar = JSON.parse(fs.readFileSync(`${archivePath}.manifest.json`, 'utf8'));
    sidecar.totals.archiveSha256 = 'a'.repeat(64);
    fs.writeFileSync(`${archivePath}.manifest.json`, JSON.stringify(sidecar, null, 2));
    const bad = await verifyFullBackup(archivePath);
    expect(bad.integrity.archiveSha256Ok).toBe(false);
    expect(bad.issues.some((i) => i.check === 'archiveSha256')).toBe(true);
  });

  it('没有 integrity 块的老归档：cheap/deep 都通过，只留一条"成员级检查不可用"的说明', async () => {
    const { archivePath, manifest } = await buildArchive(dir, {
      name: 'vanblog-full-20260913-000000.tar.gz',
      sha256Sidecar: 'none',
      mutateManifest: (m) => {
        delete m.integrity;
      },
    });
    // 副本是老归档里没有的东西：为了让"降级"这条路干净，把它也去掉
    fs.rmSync(path.join(dir, 'staging', 'MANIFEST.copy.json'));
    const staging = path.join(dir, 'staging');
    const rebuilt = path.join(dir, 'vanblog-full-20260913-000000.tar.gz');
    execFileSync('sh', ['-c', `tar -cf - -C '${staging}' . | gzip -9 -c > '${rebuilt}'`]);
    const sidecar = JSON.parse(fs.readFileSync(`${archivePath}.manifest.json`, 'utf8'));
    delete sidecar.integrity;
    sidecar.totals.archiveBytes = fs.statSync(rebuilt).size;
    fs.writeFileSync(`${rebuilt}.manifest.json`, JSON.stringify(sidecar, null, 2));

    for (const deep of [false, true]) {
      const result = await verifyFullBackup(rebuilt, { deep });
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.integrity.available).toBe(false);
      expect(result.integrity.merkleRootOk).toBeNull();
      expect(result.integrity.memberCountOk).toBeNull();
      expect(result.integrity.manifestCopyOk).toBeNull();
      expect(result.integrity.membersChecked).toBeNull();
      expect(result.integrity.notes.join(' ')).toContain('没有 integrity 块');
      expect(result.integrity.notes.join(' ')).toContain('成员级检查不可用');
    }
    expect(manifest.integrity).toBeUndefined();
  });

  const hasZstd = (() => {
    try {
      execFileSync('zstd', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  (hasZstd ? it : it.skip)(
    'zstd：清单说校验位开着、归档其实是 --no-check 打的 => frameChecksum 失败（钉住"以后换压缩器不能静默丢掉校验位"）',
    async () => {
      const { archivePath } = await buildArchive(dir, {
        name: 'vanblog-full-20260917-000002.tar.zst',
        compress: 'zstd -3 --no-check -q -c',
        frameChecksum: true, // 清单里谎称开着
      });
      const result = await verifyFullBackup(archivePath);
      expect(result.ok).toBe(false);
      expect(result.integrity.frameChecksum).toBe(false);
      expect(result.integrity.frameChecksumOk).toBe(false);
      expect(result.issues.some((i) => i.check === 'frameChecksum')).toBe(true);
    },
  );

  (hasZstd ? it : it.skip)('zstd 真归档：帧头实测 bit2=1，frameChecksumOk=true', async () => {
    const { archivePath } = await buildArchive(dir, {
      name: 'vanblog-full-20260917-000003.tar.zst',
      compress: 'zstd -3 --long=27 -T0 --check -q -c',
    });
    const result = await verifyFullBackup(archivePath);
    expect(result.issues).toEqual([]);
    expect(result.integrity.frameChecksum).toBe(true);
    expect(result.integrity.frameChecksumOk).toBe(true);
  });
});

describe('hashArchiveMembers（deep 校验用的那一遍流）', () => {
  it('不落盘、不解包，直接给出每个成员的哈希（内存与临时目录都不涨）', async () => {
    const dir = tmpDir();
    try {
      const { archivePath, expectedHashes } = await buildArchive(dir);
      const before = fs.readdirSync(os.tmpdir()).length;
      const { result, decompressError } = await hashArchiveMembers(archivePath, specFor('gzip')!);
      expect(decompressError).toBeNull();
      expect(result.complete).toBe(true);
      for (const [name, expected] of Object.entries(expectedHashes)) {
        expect(result.members[name]).toEqual(expected);
      }
      // 没有在临时目录里留下解包出来的东西
      expect(fs.readdirSync(os.tmpdir()).length).toBeLessThanOrEqual(before + 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('截断的归档：decompressError 有内容，但已经算出来的成员照样返回（好定位坏在哪）', async () => {
    const dir = tmpDir();
    try {
      const { archivePath } = await buildArchive(dir);
      const size = fs.statSync(archivePath).size;
      fs.truncateSync(archivePath, Math.floor(size * 0.6));
      const { result, decompressError } = await hashArchiveMembers(archivePath, specFor('gzip')!);
      expect(decompressError).toBeTruthy();
      expect(result.complete).toBe(false);
      expect(result.entries.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
