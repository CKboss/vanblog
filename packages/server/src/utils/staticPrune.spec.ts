import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatPruneReport, pruneFolderToMatch } from './staticPrune';

/**
 * P3 的静态目录修剪 —— 这是本轮**唯一会删用户文件**的代码，所以测试的重点不是"删对了"，
 * 而是"绝不可能删到目录外面去"。
 *
 * 负控矩阵（每一条都单独构造，把对应的安全规则去掉就会红）：
 *  - 目录内多余文件被删 / 归档里有的文件留下（功能本身）；
 *  - 归档里没有这一段 => 返回 null 且**一个字节都不动**（"归档没记 => 全删"是最坏的行为）；
 *  - 指向目录外的符号链接：跳过、不删，**链接目标必须完好**；
 *  - 指向目录内的符号链接：只删链接本身，目标文件完好；
 *  - 目录本身是符号链接（`img -> /别处`）：用 realpath 后的根做包含判断，
 *    于是修剪发生在真实目录里，而"看起来在外面"的文件不会被误伤；
 *  - 符号链接指向的**目录**里的文件：一个都不能少（递归绝不跟随链接）；
 *  - 删除失败只记 errors，不抛（修剪是收尾动作，不该反过来把恢复判失败）。
 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-prune-'));
}

function tree(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

function listAll(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string, rel: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(entry.isSymbolicLink() ? `${childRel}@` : childRel);
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), childRel);
      }
    }
  };
  if (fs.existsSync(root)) {
    walk(root, '');
  }
  return out.sort();
}

describe('pruneFolderToMatch', () => {
  let root: string;
  let src: string;
  let dst: string;
  beforeEach(() => {
    root = tmpRoot();
    src = path.join(root, 'staging', 'static', 'img');
    dst = path.join(root, 'site', 'static', 'img');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dst, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('删掉归档里没有的文件与目录，留下归档里有的（含名字与计数）', () => {
    tree(src, {
      'keep.webp': 'archive-version',
      'thumb/keep.webp': 'thumb',
      'sub/deep/keep.txt': 'deep',
    });
    tree(dst, {
      'keep.webp': 'older-on-disk', // 名字相同 => 留下（拷贝阶段已经覆盖过内容）
      'thumb/keep.webp': 'thumb',
      'thumb/orphan.webp': 'orphan',
      'sub/deep/keep.txt': 'deep',
      'orphan.webp': 'uploaded-after-the-backup',
      'orphan-dir/a.txt': 'a',
      'orphan-dir/b/c.txt': 'c',
    });

    const report = pruneFolderToMatch({ srcDir: src, dstDir: dst, folder: 'img' });
    expect(report).not.toBeNull();
    expect(report!.removedFiles).toBe(4); // orphan.webp, thumb/orphan.webp, orphan-dir/a.txt, orphan-dir/b/c.txt
    expect(report!.removedDirs).toBe(2); // orphan-dir/b, orphan-dir
    expect(report!.names).toEqual(
      expect.arrayContaining(['orphan.webp', 'thumb/orphan.webp', 'orphan-dir/a.txt']),
    );
    expect(report!.names.length).toBeLessThanOrEqual(10);
    expect(report!.skipped).toEqual([]);
    expect(report!.errors).toEqual([]);
    expect(listAll(dst)).toEqual(['keep.webp', 'sub', 'sub/deep', 'sub/deep/keep.txt', 'thumb', 'thumb/keep.webp']);
    // 归档里有的文件内容不被修剪动过（内容替换是 cpSync 的事，不是修剪的事）
    expect(fs.readFileSync(path.join(dst, 'keep.webp'), 'utf8')).toBe('older-on-disk');
  });

  it('names 最多 10 个（notes 里不能被几百个文件名淹掉）', () => {
    tree(src, { 'keep.txt': 'k' });
    const many: Record<string, string> = { 'keep.txt': 'k' };
    for (let i = 0; i < 25; i += 1) many[`orphan-${i}.bin`] = 'x';
    tree(dst, many);
    const report = pruneFolderToMatch({ srcDir: src, dstDir: dst, folder: 'img' });
    expect(report!.removedFiles).toBe(25);
    expect(report!.names).toHaveLength(10);
    expect(formatPruneReport(report!)).toContain('25 个文件');
  });

  it('归档里没有这一段（src 不存在）：返回 null 且一个文件都不删', () => {
    tree(dst, { 'a.webp': 'a', 'b/c.webp': 'c' });
    const before = listAll(dst);
    const report = pruneFolderToMatch({
      srcDir: path.join(root, 'staging', 'static', 'themes'),
      dstDir: dst,
      folder: 'themes',
    });
    expect(report).toBeNull();
    expect(listAll(dst)).toEqual(before);
  });

  it('指向目录**外**的符号链接：跳过不删，链接目标完好', () => {
    tree(src, { 'keep.txt': 'k' });
    const outside = path.join(root, 'outside');
    tree(outside, { 'secret.txt': 'DO-NOT-DELETE' });
    tree(dst, { 'keep.txt': 'k' });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dst, 'escape.txt'));

    const report = pruneFolderToMatch({ srcDir: src, dstDir: dst, folder: 'img' });
    expect(report!.removedFiles).toBe(0);
    expect(report!.skipped.length).toBe(1);
    expect(report!.skipped[0]).toContain('escape.txt');
    expect(report!.skipped[0]).toContain('符号链接指向目录外');
    // 链接本身与它的目标都还在
    expect(fs.lstatSync(path.join(dst, 'escape.txt')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('DO-NOT-DELETE');
  });

  it('指向目录**内**的符号链接：只删链接，目标文件不动', () => {
    // real.txt 也在归档里 ⇒ 它必须留下；被删的只该是那个链接
    tree(src, { 'keep.txt': 'k', 'real.txt': 'real' });
    tree(dst, { 'keep.txt': 'k', 'real.txt': 'real' });
    fs.symlinkSync('real.txt', path.join(dst, 'alias.txt'));

    const report = pruneFolderToMatch({ srcDir: src, dstDir: dst, folder: 'img' });
    expect(report!.removedFiles).toBe(1);
    expect(report!.names).toEqual(['alias.txt']);
    expect(fs.existsSync(path.join(dst, 'alias.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(dst, 'real.txt'), 'utf8')).toBe('real');
  });

  it('符号链接指向目录：绝不递归进去删它的内容（自己实现的递归删除，不依赖 rmSync 的行为）', () => {
    tree(src, { 'keep.txt': 'k' });
    const outside = path.join(root, 'outside-dir');
    tree(outside, { 'x/a.txt': 'a', 'y/b.txt': 'b' });
    tree(dst, { 'keep.txt': 'k' });
    fs.symlinkSync(outside, path.join(dst, 'linked-dir'));

    const report = pruneFolderToMatch({ srcDir: src, dstDir: dst, folder: 'img' });
    expect(report!.skipped.length).toBe(1);
    expect(report!.removedFiles).toBe(0);
    expect(report!.removedDirs).toBe(0);
    // 目录外的内容一个都不能少
    expect(listAll(outside)).toEqual(['x', 'x/a.txt', 'y', 'y/b.txt']);
    expect(fs.lstatSync(path.join(dst, 'linked-dir')).isSymbolicLink()).toBe(true);
  });

  it('用 `..` 逃出去的相对链接同样被拦下', () => {
    tree(src, { 'keep.txt': 'k' });
    const outside = path.join(root, 'outside2');
    tree(outside, { 'target.txt': 'SAFE' });
    tree(dst, { 'keep.txt': 'k' });
    fs.symlinkSync(path.join('..', '..', '..', 'outside2', 'target.txt'), path.join(dst, 'tricky.txt'));

    const report = pruneFolderToMatch({ srcDir: src, dstDir: dst, folder: 'img' });
    expect(report!.skipped.length).toBe(1);
    expect(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8')).toBe('SAFE');
  });

  it('目录本身是符号链接（img -> 别处）：修剪发生在真实目录里，包含判断用 realpath', () => {
    const realImg = path.join(root, 'elsewhere', 'img');
    tree(src, { 'keep.txt': 'k' });
    tree(realImg, { 'keep.txt': 'k', 'orphan.txt': 'o' });
    fs.rmSync(dst, { recursive: true, force: true }); // beforeEach 建的是真目录，这里要换成链接
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(realImg, dst);

    const report = pruneFolderToMatch({ srcDir: src, dstDir: dst, folder: 'img' });
    expect(report).not.toBeNull();
    expect(report!.root).toBe(fs.realpathSync(realImg));
    expect(report!.removedFiles).toBe(1);
    expect(listAll(realImg)).toEqual(['keep.txt']);
  });

  it('删除失败只记 errors、不抛（收尾动作不能反过来把恢复判失败）', () => {
    tree(src, { 'keep.txt': 'k' });
    tree(dst, { 'keep.txt': 'k', 'locked-dir/orphan.txt': 'o' });
    const locked = path.join(dst, 'locked-dir');
    fs.chmodSync(locked, 0o500); // r-x：里面的文件删不掉
    let report: ReturnType<typeof pruneFolderToMatch> = null;
    try {
      report = pruneFolderToMatch({ srcDir: src, dstDir: dst, folder: 'img' });
    } finally {
      fs.chmodSync(locked, 0o700);
    }
    expect(report).not.toBeNull();
    // root 用户能无视权限位，所以这里两种结果都接受，但**绝不能抛**
    if (process.getuid?.() === 0) {
      expect(report!.removedFiles).toBe(1);
    } else {
      expect(report!.errors.length).toBeGreaterThan(0);
      expect(report!.errors[0]).toContain('删除失败');
    }
  });

  it('dst 不存在：返回 null（不创建、不抛）', () => {
    tree(src, { 'keep.txt': 'k' });
    const missing = path.join(root, 'site', 'static', 'themes');
    expect(pruneFolderToMatch({ srcDir: src, dstDir: missing, folder: 'themes' })).toBeNull();
  });

  it('空目录：归档里没有就删掉，并计入 removedDirs', () => {
    tree(src, { 'keep.txt': 'k' });
    tree(dst, { 'keep.txt': 'k' });
    fs.mkdirSync(path.join(dst, 'empty-a', 'empty-b'), { recursive: true });
    const report = pruneFolderToMatch({ srcDir: src, dstDir: dst, folder: 'img' });
    expect(report!.removedDirs).toBe(2);
    expect(report!.removedFiles).toBe(0);
    expect(report!.names).toEqual(expect.arrayContaining(['empty-a/']));
  });
});
