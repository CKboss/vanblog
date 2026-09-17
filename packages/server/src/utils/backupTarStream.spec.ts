import { spawn, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import {
  TarEntryInfo,
  computeMerkleRoot,
  hashFile,
  hashTarStream,
  parsePaxRecords,
  sha256Hex,
} from './backupTarStream';

/**
 * tar 流哈希器（P1 的地基）：它算出来的成员名与 sha256 会**原样写进归档清单**，
 * 之后每一次校验都拿它当期望值。所以这里的原则是"每一条都用外部权威对照"：
 *  - 成员名与条数对照真 `tar -tf`（GNU tar，本机 1.35）；
 *  - 内容哈希对照 `sha256sum`（coreutils）与 Node 自己的 `crypto`（两条独立实现）；
 *  - merkleRoot 用**预先算好的固定向量**（Python hashlib 生成），不是用被测函数自己算两遍。
 *
 * 覆盖到的 tar 特性：目录项、空文件、超长名（ustar prefix 与 GNU 长名 `L` 两条路径）、
 * 符号链接、硬链接（内容不在归档里 ⇒ 哈希必须是 null 而不是"算错了"）、
 * 文件名里的控制字符与 UTF-8、以及**任意 chunk 边界**（1 字节一片也要给出同样结果 ——
 * 这条专门盯解析器的缓冲逻辑，是最容易写错的地方）。
 */

jest.setTimeout(120000);

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256OfFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 用真 tar 打包一棵树，返回 stdout 流 */
function tarStreamOf(dir: string): Readable {
  const child = spawn('tar', ['-cf', '-', '-C', dir, '.']);
  child.stderr.resume();
  return child.stdout as unknown as Readable;
}

/** 真 tar 的成员表（外部权威） */
function tarList(dir: string): string[] {
  const out = execFileSync('sh', ['-c', `tar -cf - -C '${dir}' . | tar -tf -`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter((line) => line.trim().length > 0);
}

/** 把 buffer 按固定片长重新喂一遍（盯 chunk 边界） */
function chunked(source: Buffer, size: number): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < source.length; i += size) {
    parts.push(source.subarray(i, Math.min(source.length, i + size)));
  }
  return Readable.from(parts);
}

async function tarToBuffer(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-cf', '-', '-C', dir, '.']);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar exit ${code}`)),
    );
  });
}

describe('computeMerkleRoot（固定向量，Python hashlib 预先算出）', () => {
  it('两个成员：排序后按 "<path>\\n<sha256 或 null>\\n" 拼接再 sha256', () => {
    const root = computeMerkleRoot({
      './b/c.txt': null,
      './a.txt': { sha256: 'aaa', bytes: 3 },
    });
    // payload = "./a.txt\naaa\n./b/c.txt\nnull\n"
    expect(root).toBe('8052ec8a1f8f14c6516902ff9757ff861f47310d4b79e2ef7b0afa8d274cf8f7');
  });

  it('键的插入顺序不影响结果（必须排序）', () => {
    const a = computeMerkleRoot({
      './x': { sha256: 'x', bytes: 1 },
      './a': { sha256: 'a', bytes: 1 },
    });
    const b = computeMerkleRoot({
      './a': { sha256: 'a', bytes: 1 },
      './x': { sha256: 'x', bytes: 1 },
    });
    expect(a).toBe(b);
  });

  it('空表 = sha256("")；改一个哈希就变（不是常量实现）', () => {
    expect(computeMerkleRoot({})).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    const one = computeMerkleRoot({ './a': { sha256: 'a', bytes: 1 } });
    const two = computeMerkleRoot({ './a': { sha256: 'b', bytes: 1 } });
    expect(one).not.toBe(two);
  });

  it('sha256 为 null 的成员写成字面量 "null"（两份清单就是这种）', () => {
    const root = computeMerkleRoot({
      './MANIFEST.copy.json': null,
      './db/x.ndjson': { sha256: 'f'.repeat(64), bytes: 1 },
      './manifest.json': null,
    });
    // 排序后的 payload（Python hashlib 独立算出）：
    // './MANIFEST.copy.json\nnull\n./db/x.ndjson\n<f*64>\n./manifest.json\nnull\n'
    expect(root).toBe('ebbee0b4a390fa04a6b6e2f08dd7d10c44a0e6791d104b653b7c34626c8cd175');
  });
});

describe('parsePaxRecords', () => {
  it('解析 <len> key=value 记录', () => {
    const record = '27 path=./some/very/long/name\n';
    const buf = Buffer.from(`${Buffer.byteLength(record)} ${record.slice(record.indexOf(' ') + 1)}`);
    expect(parsePaxRecords(buf).path).toBe('./some/very/long/name');
  });
  it('垃圾输入不抛、返回空', () => {
    expect(parsePaxRecords(Buffer.from('not a pax record'))).toEqual({});
    expect(parsePaxRecords(Buffer.alloc(0))).toEqual({});
  });
});

describe('hashTarStream（真 tar 打包的树）', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir('vanblog-tarstream-');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('成员名/条数与真 tar -tf 完全一致，内容哈希与 sha256sum 一致', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(path.join(staging, 'db', 'vanBlog'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'static', 'img', 'thumb'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'manifest.json'), '{"kind":"x"}');
    fs.writeFileSync(path.join(staging, 'db', 'vanBlog', 'articles.ndjson'), '{"id":1}\n{"id":2}\n');
    fs.writeFileSync(path.join(staging, 'db', 'vanBlog', 'articles.indexes.json'), '[]');
    const big = Buffer.alloc(600 * 1024); // 跨多个 512 块 + 需要补齐
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    fs.writeFileSync(path.join(staging, 'static', 'img', 'big.webp'), big);
    fs.writeFileSync(path.join(staging, 'static', 'img', 'thumb', 'empty.webp'), '');

    const result = await hashTarStream(tarStreamOf(staging));
    const listed = tarList(staging);

    expect(result.memberCount).toBe(listed.length);
    expect(result.complete).toBe(true);
    expect(result.badHeaders).toEqual([]);
    expect(result.duplicateNames).toEqual([]);

    const names = result.entries.map((entry) => entry.name);
    // 目录项带结尾 '/'，与 tar -tf 一致
    expect(names.sort()).toEqual([...listed].sort());

    const byName = new Map<string, TarEntryInfo>(result.entries.map((e) => [e.name, e]));
    expect(byName.get('./manifest.json')?.kind).toBe('file');
    expect(byName.get('./db/')?.kind).toBe('dir');
    expect(byName.get('./static/img/thumb/')?.kind).toBe('dir');
    // 目录不进 members 表（没有内容可哈希）
    expect(Object.keys(result.members).every((key) => !key.endsWith('/'))).toBe(true);
    expect(Object.keys(result.members).length).toBe(
      listed.filter((name) => !name.endsWith('/')).length,
    );

    // 与两条独立实现对照：Node crypto 直接读文件 + coreutils sha256sum
    const bigMember = byName.get('./static/img/big.webp');
    expect(bigMember?.sha256).toBe(sha256OfFile(path.join(staging, 'static', 'img', 'big.webp')));
    expect(bigMember?.size).toBe(big.length);
    const external = execFileSync('sha256sum', [path.join(staging, 'static', 'img', 'big.webp')], {
      encoding: 'utf8',
    }).split(' ')[0];
    expect(bigMember?.sha256).toBe(external);
    // 空文件 = sha256("")，不是 null（"没内容"与"没算"必须分得开）
    expect(byName.get('./static/img/thumb/empty.webp')?.sha256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(byName.get('./static/img/thumb/empty.webp')?.size).toBe(0);
  });

  it('超长成员名：ustar prefix（>100 字符）与 GNU 长名 L（>255 字符）都要还原成真实路径', async () => {
    const staging = path.join(dir, 'staging');
    // 150 字符左右的相对路径：走 ustar 的 prefix/name 拆分
    const mid = 'static/img/' + 'd'.repeat(60) + '/' + 'e'.repeat(60) + '.webp';
    fs.mkdirSync(path.dirname(path.join(staging, mid)), { recursive: true });
    fs.writeFileSync(path.join(staging, mid), 'mid');
    // 单个路径段 205 字符（> ustar name 字段的 100）：必须走 GNU 长名（'L'）。
    // ⚠️ 不能直接写一个 400 字符的文件名：NAME_MAX=255，文件系统会 ENAMETOOLONG
    const long = 'static/img/' + 'L'.repeat(200) + '.webp';
    fs.writeFileSync(path.join(staging, long), 'long');
    expect(long.length).toBeGreaterThan(100);

    const result = await hashTarStream(tarStreamOf(staging));
    const names = result.entries.map((entry) => entry.name);
    expect(names).toContain(`./${mid}`);
    expect(names).toContain(`./${long}`);
    const listed = tarList(staging);
    expect(listed).toContain(`./${mid}`);
    expect(listed).toContain(`./${long}`);
    expect(result.memberCount).toBe(listed.length);
  });

  it('符号链接：kind=symlink，哈希是**目标字符串**的 sha256；硬链接：sha256=null', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(path.join(staging, 'img'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'img', 'real.webp'), 'real-bytes');
    fs.symlinkSync('real.webp', path.join(staging, 'img', 'link.webp'));
    fs.linkSync(path.join(staging, 'img', 'real.webp'), path.join(staging, 'img', 'hard.webp'));

    const result = await hashTarStream(tarStreamOf(staging));
    const byName = new Map<string, TarEntryInfo>(result.entries.map((e) => [e.name, e]));
    const link = byName.get('./img/link.webp');
    expect(link?.kind).toBe('symlink');
    expect(link?.linkTarget).toBe('real.webp');
    expect(link?.sha256).toBe(sha256Hex('real.webp'));
    expect(link?.size).toBe(0);

    // tar 把同 inode 的**第二个**名字写成 hardlink（size 0，内容不在归档里）。
    // 谁是"第一个"取决于 readdir 顺序，所以断言写成顺序无关的形式：
    // 两个名字里恰好一个是带内容哈希的 file，另一个是 sha256=null 的 hardlink
    const pair = [byName.get('./img/real.webp'), byName.get('./img/hard.webp')];
    const file = pair.find((e) => e?.kind === 'file');
    const hard = pair.find((e) => e?.kind === 'hardlink');
    expect(file).toBeDefined();
    expect(hard).toBeDefined();
    expect(file?.sha256).toBe(sha256Hex('real-bytes'));
    expect(file?.size).toBe(10);
    expect(hard?.sha256).toBeNull();
    expect(hard?.size).toBe(0);
    // members 表里两者都在（键是成员名，与 tar -tf 一致）
    expect(Object.keys(result.members).sort()).toEqual(['./img/hard.webp', './img/link.webp', './img/real.webp']);
  });

  it('文件名里的控制字符与 UTF-8：还原成磁盘上的真名（GNU tar -tf 会转义，这里不转义）', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(path.join(staging, 'img'), { recursive: true });
    const weird = 'ctrl\u001bname.webp'; // ESC 控制字符
    const cjk = '微信图片_test.webp';
    fs.writeFileSync(path.join(staging, 'img', weird), 'a');
    fs.writeFileSync(path.join(staging, 'img', cjk), 'b');

    const result = await hashTarStream(tarStreamOf(staging));
    const names = result.entries.map((entry) => entry.name);
    expect(names).toContain(`./img/${weird}`);
    expect(names).toContain(`./img/${cjk}`);
    // 与磁盘上的真名一致（这才是 tar -x 会写出来的路径，也是能拿去 stat 的形式）
    const onDisk = fs.readdirSync(path.join(staging, 'img')).map((n) => `./img/${n}`);
    // 目录项 './img/' 本身不在 readdir 结果里，比较时要排掉
    const listed2 = names.filter((n) => n.startsWith('./img/') && n !== './img/');
    expect(onDisk.sort()).toEqual(listed2.sort());
    // 而 GNU tar -tf 会把控制字符转义成八进制 ⇒ 两者**故意**不同（这就是不用 tar -tf 当键的原因）
    const listed = tarList(staging);
    expect(listed.some((name) => name.includes('\\033'))).toBe(true);
  });

  it('chunk 边界无关：1 字节一片、7 字节一片与整块喂进去结果完全相同', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(path.join(staging, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'manifest.json'), '{"k":1}');
    fs.writeFileSync(path.join(staging, 'a', 'one.txt'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(staging, 'a', 'b', 'two.txt'), 'y'.repeat(513)); // 513 => 需要补齐

    const raw = await tarToBuffer(staging);
    const whole = await hashTarStream(Readable.from([raw]));
    const oneByOne = await hashTarStream(chunked(raw, 1));
    const sevens = await hashTarStream(chunked(raw, 7));
    const strip = (r: typeof whole) =>
      r.entries.map((e) => [e.name, e.kind, e.size, e.sha256, e.headerChecksumOk]);
    expect(strip(oneByOne)).toEqual(strip(whole));
    expect(strip(sevens)).toEqual(strip(whole));
    expect(oneByOne.memberCount).toBe(whole.memberCount);
    expect(sevens.bytes).toBe(whole.bytes);
    expect(whole.complete).toBe(true);
  });

  it('截断的流：complete=false（不会挂起，也不会假装走完了）', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'a.txt'), 'z'.repeat(4096));
    const raw = await tarToBuffer(staging);
    const truncated = raw.subarray(0, Math.floor(raw.length * 0.5));
    const result = await hashTarStream(Readable.from([truncated]));
    expect(result.complete).toBe(false);
    expect(result.bytes).toBe(truncated.length);
  });

  it('头部被改一个字节：headerChecksumOk=false 并点名该成员', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'a.txt'), 'hello');
    const raw = Buffer.from(await tarToBuffer(staging));
    // 第二个 512 块是 ./a.txt 的头部（第一块是 './' 目录项）；改它的 mode 字段
    const headerOffset = 512;
    expect(raw.subarray(headerOffset, headerOffset + 10).toString()).toContain('a.txt');
    raw[headerOffset + 100] = (raw[headerOffset + 100] + 1) % 256;
    const result = await hashTarStream(Readable.from([raw]));
    expect(result.badHeaders).toContain('./a.txt');
    expect(result.entries.find((e) => e.name === './a.txt')?.headerChecksumOk).toBe(false);
  });

  it('members 表：目录不在里面，文件带 sha256 与 bytes', async () => {
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(path.join(staging, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'sub', 'f.txt'), 'abc');
    const result = await hashTarStream(tarStreamOf(staging));
    expect(result.members['./sub/f.txt']).toEqual({
      sha256: sha256Hex('abc'),
      bytes: 3,
    });
    expect(result.members['./sub/']).toBeUndefined();
    expect(result.members['./']).toBeUndefined();
  });
});

describe('hashFile（流式，不整体进内存）', () => {
  it('与 sha256sum 一致，并给出真实字节数', async () => {
    const dir = tmpDir('vanblog-hashfile-');
    const file = path.join(dir, 'big.bin');
    const buf = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 7) % 256;
    fs.writeFileSync(file, buf);
    const got = await hashFile(file);
    expect(got.bytes).toBe(buf.length);
    expect(got.sha256).toBe(sha256OfFile(file));
    expect(got.sha256).toBe(execFileSync('sha256sum', [file], { encoding: 'utf8' }).split(' ')[0]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在时 reject（调用方要能看见，不能静默给出 null）', async () => {
    await expect(hashFile('/nonexistent/vanblog-nope.bin')).rejects.toBeTruthy();
  });
});
