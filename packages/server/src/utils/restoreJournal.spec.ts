import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RESTORE_JOURNAL_FILE,
  RestoreJournalWriter,
  describeRestoreJournal,
  journalProgress,
  readRestoreJournal,
} from './restoreJournal';

/**
 * P5：恢复断点日志。
 *
 * 要钉住的是三件事：
 *  1. **每换完一张表就落一次盘**（崩溃之后能说出"换了几张、最后一张是哪张"）；
 *  2. 成功就删掉、失败就留下并带原因；
 *  3. journal 写不进去**绝不影响恢复本身**（open 返回 null，所有方法都是 no-op）。
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-journal-'));
}

describe('RestoreJournalWriter', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = tmpDir();
    file = path.join(dir, RESTORE_JOURNAL_FILE);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('open 就落盘：phase=unpack、带归档名与 pid/hostname', () => {
    const writer = RestoreJournalWriter.open(file, {
      archivePath: '/backups/vanblog-full-20260917-010101.tar.zst',
      archiveCreatedAt: '2026-09-17T01:01:01.000Z',
    });
    expect(writer).not.toBeNull();
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.phase).toBe('unpack');
    expect(onDisk.archiveName).toBe('vanblog-full-20260917-010101.tar.zst');
    expect(onDisk.archiveCreatedAt).toBe('2026-09-17T01:01:01.000Z');
    expect(onDisk.pid).toBe(process.pid);
    expect(typeof onDisk.hostname).toBe('string');
    expect(onDisk.done).toEqual([]);
  });

  it('setPlanned + recordCollection：崩溃现场能说出"计划几张、换完几张、最后一张是哪张"', () => {
    const writer = RestoreJournalWriter.open(file, { archivePath: '/b/a.tar.zst' })!;
    writer.setPlanned({ vanBlog: ['articles', 'users', 'metas'], waline: ['Comment'] });
    writer.setPhase('collections');
    writer.recordCollection('vanBlog', 'articles', 59);
    writer.recordCollection('vanBlog', 'users', 1);

    const mid = readRestoreJournal(dir)!;
    expect(mid.phase).toBe('collections');
    expect(journalProgress(mid)).toEqual({ planned: 4, done: 2 });
    expect(mid.done.map((item) => `${item.db}.${item.collection}`)).toEqual([
      'vanBlog.articles',
      'vanBlog.users',
    ]);
    expect(mid.done[0].documents).toBe(59);
    expect(new Date(mid.done[1].at).getTime()).toBeGreaterThanOrEqual(
      new Date(mid.done[0].at).getTime(),
    );

    // 模拟"进程在这里被杀"：文件里就是当时的状态，没有额外清理
    expect(fs.existsSync(file)).toBe(true);
    const text = describeRestoreJournal(mid);
    expect(text).toContain('a.tar.zst');
    expect(text).toContain('已换完 2/4 张表');
    expect(text).toContain('vanBlog.users');
    expect(text).toContain('混合状态');
  });

  it('finish()：删掉 journal（没有断点了），之后再调用都是 no-op', () => {
    const writer = RestoreJournalWriter.open(file, { archivePath: '/b/a.tar.zst' })!;
    writer.recordCollection('vanBlog', 'articles', 1);
    expect(fs.existsSync(file)).toBe(true);
    writer.finish();
    expect(fs.existsSync(file)).toBe(false);
    writer.recordCollection('vanBlog', 'users', 1); // 已关闭：不该把文件写回来
    writer.finish();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('fail()：留下 journal，phase=failed 且带错误原因', () => {
    const writer = RestoreJournalWriter.open(file, { archivePath: '/b/a.tar.zst' })!;
    writer.recordCollection('vanBlog', 'articles', 59);
    writer.fail('恢复集合 users 失败：ECONNRESET');
    const left = readRestoreJournal(dir)!;
    expect(left.phase).toBe('failed');
    expect(left.error).toContain('ECONNRESET');
    expect(journalProgress(left)).toEqual({ planned: 0, done: 1 });
    expect(describeRestoreJournal(left)).toContain('ECONNRESET');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('journal 写不进去：open 返回 null，恢复照常（每个方法都能安全地对着 null 调）', () => {
    // 在一个**文件**下面建目录 => mkdirSync 必然失败
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a dir');
    const warnings: string[] = [];
    const writer = RestoreJournalWriter.open(
      path.join(blocker, RESTORE_JOURNAL_FILE),
      { archivePath: '/b/a.tar.zst' },
      (message) => warnings.push(message),
    );
    expect(writer).toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('写恢复日志失败');
    // 空路径 = 明确不要 journal（单测里常用），既不该抛也不该写文件
    expect(RestoreJournalWriter.open('', { archivePath: '/b/a.tar.zst' })).toBeNull();
  });

  it('写失败只 WARN 一次（每张表都刷一行会把日志淹掉）', () => {
    const writer = RestoreJournalWriter.open(file, { archivePath: '/b/a.tar.zst' }, () => undefined)!;
    // 把 journal 文件换成一个目录，后续 rename 必然失败
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file, { recursive: true });
    const warnings: string[] = [];
    (writer as any).warn = (message: string) => warnings.push(message);
    writer.recordCollection('db', 'a', 1);
    writer.recordCollection('db', 'b', 2);
    writer.recordCollection('db', 'c', 3);
    expect(warnings.length).toBe(1);
  });

  it('原子写：不留 .tmp-<pid> 垃圾', () => {
    const writer = RestoreJournalWriter.open(file, { archivePath: '/b/a.tar.zst' })!;
    writer.recordCollection('db', 'a', 1);
    writer.finish();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('readRestoreJournal', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在 => null', () => {
    expect(readRestoreJournal(dir)).toBeNull();
  });

  it('JSON 坏了 => null（绝不让状态文件把启动带崩）', () => {
    fs.writeFileSync(path.join(dir, RESTORE_JOURNAL_FILE), '{ not json');
    expect(readRestoreJournal(dir)).toBeNull();
  });

  it('version 不认识 => null（不按不认识的格式乱解释）', () => {
    fs.writeFileSync(
      path.join(dir, RESTORE_JOURNAL_FILE),
      JSON.stringify({ version: 99, phase: 'collections', done: [] }),
    );
    expect(readRestoreJournal(dir)).toBeNull();
  });

  it('journalProgress 对残缺字段按 0 处理', () => {
    expect(journalProgress({} as any)).toEqual({ planned: 0, done: 0 });
    expect(journalProgress({ planned: { a: 'not-an-array' }, done: null } as any)).toEqual({
      planned: 0,
      done: 0,
    });
  });
});
