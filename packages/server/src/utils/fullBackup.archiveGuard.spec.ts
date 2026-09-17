import { BadRequestException } from '@nestjs/common';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ObjectId } from 'mongodb';
import { verifyFullBackup } from './backupVerify';
import {
  assertRestorableArchive,
  createFullBackup,
  findUnsafeArchiveEntry,
  findUnsafeArchiveMember,
  listArchiveEntries,
  listArchiveMembers,
  restoreFullBackup,
} from './fullBackup';

/**
 * 恢复前的**归档安全守卫**（安全审计那条：符号链接可以通过一份来路不明的归档种进静态目录，
 * 再被 web 层跟随 ⇒ 匿名任意文件读）。
 *
 * 守卫现在查两件事：成员**名字**（绝对路径 / `..` 段，原来就有）与成员**类型**
 * （符号链接一律拒绝；硬链接只在目标名不安全时拒绝）。类型信息只能从 tar 头部拿，
 * 所以走的是新的 `listArchiveEntries()`（流式解析），不是 `tar -tf`。
 *
 * ⚠️ 硬链接为什么不是一律拒绝：GNU tar 1.35 与 busybox 1.36.1 **都会**把
 * "同 inode 的第二个名字"写成硬链接成员（实测 `hrw-rw-r-- … link to ./static/img/b.webp`）。
 * 也就是说只要静态目录里有两张内容相同的图被去重工具硬链到一起，**我们自己导出的归档里
 * 就有硬链接成员**；一律拒绝等于"这种站点的备份永远恢复不了"。而符号链接已经一律拒绝，
 * 解包目录里不可能先有一个软链让硬链接去指，所以"目标名安全"的硬链接没有逃逸能力。
 */

jest.setTimeout(180000);

function tmpDir(prefix = 'vanblog-guard-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeClient(seed: Record<string, Record<string, any[]>> = {}) {
  const state: Record<string, Record<string, any[]>> = JSON.parse(JSON.stringify(seed));
  const client: any = {
    db(name: string) {
      if (!state[name]) state[name] = {};
      return {
        databaseName: name,
        collections: async () =>
          Object.keys(state[name]).map((collectionName) => ({ collectionName })),
        createCollection: async (c: string) => {
          if (!state[name][c]) state[name][c] = [];
        },
        collection(collectionName: string) {
          if (!state[name][collectionName]) state[name][collectionName] = [];
          return {
            collectionName,
            find: () =>
              (async function* generator() {
                for (const doc of state[name][collectionName]) yield doc;
              })(),
            indexes: async () => [],
            countDocuments: async () => state[name][collectionName].length,
            deleteMany: async () => {
              state[name][collectionName] = [];
              return { deletedCount: 0 };
            },
            insertMany: async (docs: any[]) => {
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
        },
      };
    },
  };
  return { client, state };
}

/** 用真 tar 打一份归档（staging 目录已经准备好） */
function pack(staging: string, archivePath: string): string {
  execFileSync('sh', ['-c', `tar -cf - -C '${staging}' . | gzip -9 -c > '${archivePath}'`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return archivePath;
}

/** 一份最小但合法的整站备份（守卫之外的检查也过得去） */
function minimalBackupStaging(root: string): string {
  const staging = path.join(root, 'staging');
  fs.mkdirSync(path.join(staging, 'db', 'vanBlog'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'static', 'img'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'db', 'vanBlog', 'users.ndjson'), '{"id":1}\n');
  fs.writeFileSync(path.join(staging, 'db', 'vanBlog', 'users.indexes.json'), '[]');
  fs.writeFileSync(path.join(staging, 'static', 'img', 'a.webp'), 'aaa');
  fs.writeFileSync(
    path.join(staging, 'manifest.json'),
    JSON.stringify({
      kind: 'vanblog-full-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      format: 'gzip',
      compressor: 'gzip -9',
      databases: { vanBlog: { collections: { users: { count: 1, bytes: 8, indexes: 0 } } } },
      static: { img: { files: 1, bytes: 3 } },
      totals: { databases: 1, collections: 1, documents: 1, files: 1, staticBytes: 3 },
    }),
  );
  return staging;
}

describe('findUnsafeArchiveEntry（纯函数：名字 + 类型）', () => {
  const file = (name: string) => ({ name, kind: 'file', linkTarget: null });
  const dir = (name: string) => ({ name, kind: 'dir', linkTarget: null });
  const link = (name: string, target: string | null) => ({ name, kind: 'symlink', linkTarget: target });
  const hard = (name: string, target: string | null) => ({ name, kind: 'hardlink', linkTarget: target });

  it('普通成员一律放行（含 ./ 前缀、目录项、中文与控制字符名）', () => {
    expect(
      findUnsafeArchiveEntry([
        dir('./'),
        file('./manifest.json'),
        file('./db/vanBlog/articles.ndjson'),
        file('./static/img/微信图片_1.webp'),
        file('./static/img/ctrl\u001bname.webp'),
      ]),
    ).toBeNull();
  });

  it('名字层面：绝对路径 / Windows 盘号 / 任何一段是 .. 都拒绝', () => {
    expect(findUnsafeArchiveEntry([file('/etc/passwd')])!.reason).toBe('绝对路径');
    expect(findUnsafeArchiveEntry([file('C:\\windows\\system32\\x')])!.reason).toBe('Windows 绝对路径');
    expect(findUnsafeArchiveEntry([file('../evil.txt')])!.reason).toBe('含 .. 段');
    expect(findUnsafeArchiveEntry([file('./db/../../evil.txt')])!.reason).toBe('含 .. 段');
    // `a..b` 不是 .. 段，不该误伤
    expect(findUnsafeArchiveEntry([file('./db/vanBlog/a..b.ndjson')])).toBeNull();
  });

  it('符号链接：一律拒绝，且理由里带上目标（这是本轮修的那个洞）', () => {
    const found = findUnsafeArchiveEntry([
      file('./manifest.json'),
      link('./static/img/evil.webp', '/etc/passwd'),
    ]);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('./static/img/evil.webp');
    expect(found!.reason).toContain('符号链接成员');
    expect(found!.reason).toContain('/etc/passwd');
    expect(found!.reason).toContain('匿名任意文件读');
    // 指向归档内部的"看起来无害"的软链也拒绝：解包后它会被 cpSync 搬进静态目录
    expect(findUnsafeArchiveEntry([link('./static/img/x.webp', 'a.webp')])!.reason).toContain('符号链接');
  });

  it('硬链接：目标名安全就放行，目标名不安全（或没有目标）才拒绝', () => {
    expect(findUnsafeArchiveEntry([hard('./static/img/a.webp', './static/img/b.webp')])).toBeNull();
    expect(findUnsafeArchiveEntry([hard('./static/img/a.webp', '/etc/passwd')])!.reason).toContain(
      '硬链接成员的目标不安全',
    );
    expect(findUnsafeArchiveEntry([hard('./static/img/a.webp', '../../etc/passwd')])!.reason).toContain(
      '硬链接成员的目标不安全',
    );
    expect(findUnsafeArchiveEntry([hard('./static/img/a.webp', null)])!.reason).toContain(
      '没有目标名',
    );
  });

  it('老的纯名字函数保持原样（round3 的钉子还在用它）', () => {
    expect(findUnsafeArchiveMember(['./db/x.ndjson', 'static/img/a.webp'])).toBeNull();
    expect(findUnsafeArchiveMember(['../evil.txt'])).toBe('../evil.txt');
  });
});

describe('assertRestorableArchive / listArchiveEntries（真归档）', () => {
  let root: string;
  beforeEach(() => {
    root = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('正常归档：通过，返回的成员数与 tar -tf 的行数一致', async () => {
    const staging = minimalBackupStaging(root);
    const archive = pack(staging, path.join(root, 'vanblog-full-20260917-000000.tar.gz'));
    const listed = await listArchiveMembers(archive);
    await expect(assertRestorableArchive(archive)).resolves.toBe(listed.length);
    const { entries, decompressError } = await listArchiveEntries(archive);
    expect(decompressError).toBeNull();
    expect(entries.length).toBe(listed.length);
    expect(entries.find((e) => e.name === './static/img/a.webp')?.kind).toBe('file');
    expect(entries.find((e) => e.name === './static/img/')?.kind).toBe('dir');
    // 只列成员时不算哈希（省 0.4s），但类型与名字齐全
    expect(entries.find((e) => e.name === './static/img/a.webp')?.sha256).toBeNull();
  });

  it('含符号链接成员的归档：拒绝，并在消息里点名成员与原因', async () => {
    const staging = minimalBackupStaging(root);
    fs.symlinkSync('/etc/passwd', path.join(staging, 'static', 'img', 'evil.webp'));
    const archive = pack(staging, path.join(root, 'vanblog-full-20260917-000001.tar.gz'));
    let caught: any = null;
    try {
      await assertRestorableArchive(archive);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(String(caught.message)).toContain('解包目录之外');
    expect(String(caught.message)).toContain('./static/img/evil.webp');
    expect(String(caught.message)).toContain('符号链接成员');
  });

  it('含 .. 成员的归档：仍然按原来的措辞拒绝（round3 的钉子钉的就是这句）', async () => {
    const staging = minimalBackupStaging(root);
    // tar 默认会拒绝把 ../ 写进成员名，用 --transform 硬造一个
    const archive = path.join(root, 'vanblog-full-20260917-000002.tar.gz');
    execFileSync(
      'sh',
      [
        '-c',
        `cd '${staging}' && tar -cf - --transform 's|^db|../db|' db | gzip -9 -c > '${archive}'`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    await expect(assertRestorableArchive(archive)).rejects.toThrow(/解包目录之外/);
  });

  it('含**安全**硬链接成员的归档：放行（这就是我们自己会导出的形状）', async () => {
    const staging = minimalBackupStaging(root);
    fs.writeFileSync(path.join(staging, 'static', 'img', 'b.webp'), 'aaa');
    fs.linkSync(
      path.join(staging, 'static', 'img', 'b.webp'),
      path.join(staging, 'static', 'img', 'dup.webp'),
    );
    const archive = pack(staging, path.join(root, 'vanblog-full-20260917-000003.tar.gz'));
    const { entries } = await listArchiveEntries(archive);
    expect(entries.some((e) => e.kind === 'hardlink')).toBe(true);
    await expect(assertRestorableArchive(archive)).resolves.toBeGreaterThan(0);
  });

  it('截断的归档：拒绝（成员表不完整时绝不能当成"检查通过"）', async () => {
    const staging = minimalBackupStaging(root);
    const archive = pack(staging, path.join(root, 'vanblog-full-20260917-000004.tar.gz'));
    const size = fs.statSync(archive).size;
    fs.truncateSync(archive, Math.max(1, Math.floor(size * 0.6)));
    await expect(assertRestorableArchive(archive)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('restoreFullBackup 自己就会挡（后台那条路由以前没有这道检查）', () => {
  let root: string;
  beforeEach(() => {
    root = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('含符号链接的归档：恢复 400，且**解包都没发生**（静态目录一个文件都没落地）', async () => {
    const staging = minimalBackupStaging(root);
    fs.symlinkSync('/etc/passwd', path.join(staging, 'static', 'img', 'evil.webp'));
    const archive = pack(staging, path.join(root, 'vanblog-full-20260917-000005.tar.gz'));

    const staticPath = path.join(root, 'site-static');
    fs.mkdirSync(staticPath, { recursive: true });
    const { client, state } = fakeClient();
    await expect(
      restoreFullBackup({
        client,
        staticPath,
        archivePath: archive,
        workDir: path.join(root, 'work'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // 静态目录空、库里也没写任何东西（守卫在第一次写之前）
    expect(fs.readdirSync(staticPath)).toEqual([]);
    expect(state.vanBlog || {}).toEqual({});
    // 工作目录里也没有留下解包出来的软链
    const work = path.join(root, 'work');
    expect(fs.existsSync(work) ? fs.readdirSync(work) : []).toEqual([]);
  });

  it('正常归档：守卫放行，恢复照旧成功（负控：把守卫去掉这条也不会红，所以要靠上一条钉）', async () => {
    const site = tmpDir('vanblog-guard-ok-');
    try {
      const staticPath = path.join(site, 'static');
      fs.mkdirSync(path.join(staticPath, 'img'), { recursive: true });
      fs.writeFileSync(path.join(staticPath, 'img', 'a.webp'), 'aaa');
      const outDir = path.join(site, 'backups');
      fs.mkdirSync(outDir, { recursive: true });
      const { client } = fakeClient({
        vanBlog: { users: [{ _id: 'u1', username: 'admin' }] },
      });
      const exported = await createFullBackup({
        client,
        staticPath,
        dbName: 'vanBlog',
        format: 'gzip',
        outDir,
        workDir: path.join(site, 'work'),
      });
      const target = fakeClient();
      const targetStatic = path.join(site, 'target-static');
      const res = await restoreFullBackup({
        client: target.client,
        staticPath: targetStatic,
        archivePath: exported.path,
        workDir: path.join(site, 'work'),
      });
      expect(res.databases.vanBlog.documents).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(targetStatic, 'img', 'a.webp'), 'utf8')).toBe('aaa');
      // 恢复出来的静态目录里不可能有符号链接（守卫已经挡在解包之前）
      const links: string[] = [];
      const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) links.push(entry.name);
          else if (entry.isDirectory()) walk(path.join(current, entry.name));
        }
      };
      walk(targetStatic);
      expect(links).toEqual([]);
    } finally {
      fs.rmSync(site, { recursive: true, force: true });
    }
  });
});

describe('linkTree：静态目录本身是符号链接时也要备份到内容', () => {
  it('img 是指向别处的软链：归档里是**真实文件**，不是一个链接成员', async () => {
    const root = tmpDir('vanblog-symlinked-static-');
    try {
      const realImg = path.join(root, 'big-disk', 'img');
      fs.mkdirSync(realImg, { recursive: true });
      fs.writeFileSync(path.join(realImg, 'a.webp'), 'real-image-bytes');
      fs.mkdirSync(path.join(realImg, 'thumb'), { recursive: true });
      fs.writeFileSync(path.join(realImg, 'thumb', 'a.webp'), 'thumb-bytes');
      fs.mkdirSync(path.join(realImg, 'deep', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(realImg, 'deep', 'nested', 'b.webp'), 'nested-bytes');
      const staticPath = path.join(root, 'static');
      fs.mkdirSync(staticPath, { recursive: true });
      fs.symlinkSync(realImg, path.join(staticPath, 'img'));

      const outDir = path.join(root, 'backups');
      fs.mkdirSync(outDir, { recursive: true });
      const warns: string[] = [];
      // 库里要有文档：否则写后校验的 countsNonZero 会（正确地）报"空备份"，抢了本用例的戏
      const { client } = fakeClient({ vanBlog: { users: [{ _id: 'u1', username: 'admin' }] } });
      const result = await createFullBackup({
        client,
        staticPath,
        dbName: 'vanBlog',
        format: 'gzip',
        outDir,
        workDir: path.join(root, 'work'),
        logger: { log: () => undefined, warn: (message) => warns.push(message) },
      });

      // 形状一：软链目录里的**真实文件**必须逐个进归档，归档里不许有任何软链成员。
      // 修复前：归档里只有 `./static/img`（一个指向 root 之外绝对路径的软链成员），
      // 一张图都没有，而 manifest.static.img.files 却跟着链接数出了真实值
      // ⇒ 写后校验 staticConsistent 失败（"图床是软链的站点根本备份不了"）。
      const { entries } = await listArchiveEntries(result.path);
      expect(entries.some((entry) => entry.kind === 'symlink')).toBe(false);
      // 目录项带结尾 '/'（与 tar -tf 一致）
      expect(entries.find((entry) => entry.name === './static/img/')?.kind).toBe('dir');
      for (const [name, body] of [
        ['./static/img/a.webp', 'real-image-bytes'],
        ['./static/img/thumb/a.webp', 'thumb-bytes'],
        ['./static/img/deep/nested/b.webp', 'nested-bytes'],
      ]) {
        const member = entries.find((entry) => entry.name === name);
        expect(member?.kind).toBe('file');
        expect(member?.size).toBe(body.length);
      }

      // 形状二：manifest 记的数量 == 归档里**实际的成员数**（不是"跟着链接数出来的数"）
      const archivedImgFiles = entries.filter(
        (entry) => entry.kind === 'file' && entry.name.startsWith('./static/img/'),
      ).length;
      expect(result.manifest.static.img.files).toBe(archivedImgFiles);
      expect(result.manifest.static.img.files).toBe(3);
      expect(result.manifest.static.img.bytes).toBe(
        'real-image-bytes'.length + 'thumb-bytes'.length + 'nested-bytes'.length,
      );
      expect(result.manifest.totals.files).toBe(archivedImgFiles);

      // 整份归档自洽（写后校验全绿），而且是**可恢复**的（含软链成员的那份会被守卫拒绝）
      const verification = await verifyFullBackup(result.path, { deep: true });
      expect(verification.issues).toEqual([]);
      expect(verification.ok).toBe(true);
      await expect(assertRestorableArchive(result.path)).resolves.toBeGreaterThan(0);

      // WARN 要能让运维看懂"什么都没丢"
      const warnText = warns.join(' | ');
      expect(warnText).toContain('是一个符号链接');
      expect(warnText).toContain(realImg);
      expect(warnText).toContain('没有丢东西');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
