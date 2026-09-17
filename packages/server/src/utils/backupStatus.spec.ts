import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BACKUP_STATUS_FILE,
  emptyBackupStatus,
  readBackupStatus,
  recordBackupFailure,
  recordBackupSuccess,
  recordSweep,
  resolveStaleWarnHours,
  resolveSweepIntervalHours,
  resolveSweepMax,
  staleBackupWarning,
  touchBackupStatus,
} from './backupStatus';
import { RESTORE_JOURNAL_FILE } from './restoreJournal';

/** P2 备份健康状态：持久化、连续失败计数、陈旧告警阈值。 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-backupstatus-'));
}

describe('backupStatus 持久化', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('没有状态文件时读到空状态（全新实例不炸）', () => {
    const status = readBackupStatus(dir);
    expect(status).toEqual(emptyBackupStatus());
    expect(status.lastSuccessAt).toBeNull();
    expect(status.consecutiveFailures).toBe(0);
  });

  it('损坏/版本不认识的状态文件回落到空状态', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, BACKUP_STATUS_FILE), '{ 坏 JSON');
    expect(readBackupStatus(dir)).toEqual(emptyBackupStatus());
    fs.writeFileSync(
      path.join(dir, BACKUP_STATUS_FILE),
      JSON.stringify({ version: 999, lastSuccessAt: 'x' }),
    );
    expect(readBackupStatus(dir).lastSuccessAt).toBeNull();
  });

  it('失败累加 consecutiveFailures，成功清零并记下归档名/大小/校验耗时', () => {
    recordBackupFailure(dir, { stage: 'verify', message: 'CRC 错', name: 'a.tar.gz' });
    recordBackupFailure(dir, { stage: 'export', message: '磁盘满' });
    let status = readBackupStatus(dir);
    expect(status.consecutiveFailures).toBe(2);
    expect(status.lastFailureStage).toBe('export');
    expect(status.lastFailureMessage).toBe('磁盘满');
    expect(status.lastSuccessAt).toBeNull();

    recordBackupSuccess(dir, { name: 'b.tar.gz', bytes: 123, verifyMs: 456 });
    status = readBackupStatus(dir);
    expect(status.consecutiveFailures).toBe(0);
    expect(status.lastSuccessName).toBe('b.tar.gz');
    expect(status.lastSuccessBytes).toBe(123);
    expect(status.lastVerifyMs).toBe(456);
    // 失败现场保留（成功后不清零，方便回看"上次坏在哪"）
    expect(status.lastFailureMessage).toBe('磁盘满');
    expect(new Date(status.lastSuccessAt).getTime()).toBeGreaterThan(0);
  });

  it('写出来的是合法 JSON 且原子替换没留下 tmp 文件', () => {
    recordBackupSuccess(dir, { name: 'c.tar.gz', bytes: 1, verifyMs: 1 });
    const files = fs.readdirSync(dir);
    expect(files).toEqual([BACKUP_STATUS_FILE]);
    expect(() => JSON.parse(fs.readFileSync(path.join(dir, BACKUP_STATUS_FILE), 'utf8'))).not.toThrow();
  });
});

describe('staleBackupWarning / resolveStaleWarnHours', () => {
  const now = new Date('2026-09-17T12:00:00Z');

  it('阈值解析：缺失/非法回落 48，0 合法（关闭），负数回落', () => {
    expect(resolveStaleWarnHours(undefined)).toBe(48);
    expect(resolveStaleWarnHours('')).toBe(48);
    expect(resolveStaleWarnHours('abc')).toBe(48);
    expect(resolveStaleWarnHours('-3')).toBe(48);
    expect(resolveStaleWarnHours('0')).toBe(0);
    expect(resolveStaleWarnHours('12.7')).toBe(12);
  });

  it('从未成功过 → WARN；超过阈值 → WARN；新鲜 → null；阈值 0 → 永远 null', () => {
    const never = emptyBackupStatus();
    expect(staleBackupWarning(never, now, 48)).toContain('没有任何已校验成功');

    const old = { ...never, lastSuccessAt: '2026-09-14T12:00:00Z', lastSuccessName: 'x.tar.zst' };
    const message = staleBackupWarning(old, now, 48);
    expect(message).toContain('72 小时前');

    const fresh = { ...never, lastSuccessAt: '2026-09-17T10:00:00Z' };
    expect(staleBackupWarning(fresh, now, 48)).toBeNull();

    expect(staleBackupWarning(never, now, 0)).toBeNull();
    expect(staleBackupWarning(old, now, 0)).toBeNull();
  });
});

describe('P1/P4/P5 新增字段（全部可选追加，老状态文件读回来照样能用）', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('老状态文件（没有新字段）读回来会被补成默认值，version 仍然是 1', () => {
    fs.writeFileSync(
      path.join(dir, BACKUP_STATUS_FILE),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-09-13T00:00:00.000Z',
        lastSuccessAt: '2026-09-13T00:00:00.000Z',
        lastSuccessName: 'vanblog-full-20260913-000000.tar.zst',
        lastSuccessBytes: 69111118,
        lastVerifyMs: 300,
        lastFailureAt: null,
        lastFailureStage: null,
        lastFailureName: null,
        lastFailureMessage: null,
        consecutiveFailures: 0,
      }),
    );
    const status = readBackupStatus(dir);
    expect(status.lastSuccessName).toBe('vanblog-full-20260913-000000.tar.zst');
    expect(status.consecutiveFailures).toBe(0);
    expect(status.lastSuccessSha256).toBeNull();
    expect(status.lastSweepAt).toBeNull();
    expect(status.lastSweepResults).toEqual([]);
    expect(status.restoreJournal).toBeNull();
    expect(status.version).toBe(1);
  });

  it('成功备份把整归档 sha256 与成员数也记下来（外部凭据的最后一个落脚点）', () => {
    recordBackupSuccess(dir, {
      name: 'a.tar.zst',
      bytes: 10,
      verifyMs: 1,
      sha256: 'ab'.repeat(32),
      members: 239,
    });
    const status = readBackupStatus(dir);
    expect(status.lastSuccessSha256).toBe('ab'.repeat(32));
    expect(status.lastSuccessMembers).toBe(239);
    // 不传就是 null（老调用方不受影响）
    recordBackupSuccess(dir, { name: 'b.tar.zst', bytes: 1, verifyMs: 1 });
    expect(readBackupStatus(dir).lastSuccessSha256).toBeNull();
  });

  it('recordSweep：记下时间/耗时/份数/失败数与每份结果；不动 consecutiveFailures', () => {
    recordBackupFailure(dir, { stage: 'verify', message: 'x' });
    expect(readBackupStatus(dir).consecutiveFailures).toBe(1);
    recordSweep(dir, {
      ms: 1234,
      message: '3 份归档复验完成，1 份有问题',
      results: [
        { name: 'new.tar.zst', ok: false, ms: 900, bytes: 10, membersChecked: null, issues: ['[readThrough] 解压失败'] },
        { name: 'old.tar.zst', ok: true, ms: 300, bytes: 10, membersChecked: 239, issues: [] },
      ],
    });
    const status = readBackupStatus(dir);
    expect(status.lastSweepArchives).toBe(2);
    expect(status.lastSweepFailures).toBe(1);
    expect(status.lastSweepMs).toBe(1234);
    expect(status.lastSweepResults).toHaveLength(2);
    expect(status.lastSweepResults[0].issues[0]).toContain('readThrough');
    expect(status.lastSweepMessage).toContain('1 份有问题');
    // 巡检失败不等于"导出失败"：连续失败计数保持原样（上面那次 verify 失败留下的 1）
    expect(status.consecutiveFailures).toBe(1);
    // recordSweep 也不去动 lastFailure*（那是"导出/校验"的现场）；
    // 巡检自己的失败由 provider 另外用 stage='sweep' 记一条，见下面那条用例
    expect(status.lastFailureStage).toBe('verify');
    expect(status.lastFailureMessage).toBe('x');
  });

  it('sweep 失败也可以记进 lastFailure*（stage=sweep），且仍然不加连续失败计数', () => {
    recordBackupFailure(dir, { stage: 'sweep', message: 'a.tar.zst: 成员哈希不匹配', name: 'a.tar.zst' });
    const status = readBackupStatus(dir);
    expect(status.lastFailureStage).toBe('sweep');
    expect(status.lastFailureName).toBe('a.tar.zst');
    expect(status.consecutiveFailures).toBe(0);
  });

  it('巡检节奏解析：缺失/非法回落默认，0 = 关闭，超大值被夹住', () => {
    expect(resolveSweepIntervalHours(undefined)).toBe(24);
    expect(resolveSweepIntervalHours('')).toBe(24);
    expect(resolveSweepIntervalHours('abc')).toBe(24);
    expect(resolveSweepIntervalHours('-1')).toBe(24);
    expect(resolveSweepIntervalHours('0')).toBe(0);
    expect(resolveSweepIntervalHours('6.9')).toBe(6);
    expect(resolveSweepIntervalHours('999999')).toBe(24 * 365);
    expect(resolveSweepMax(undefined)).toBe(3);
    expect(resolveSweepMax('0')).toBe(0);
    expect(resolveSweepMax('-5')).toBe(3);
    expect(resolveSweepMax('1000')).toBe(100);
    expect(emptyBackupStatus().sweepIntervalHours).toBe(24);
    expect(emptyBackupStatus().sweepMaxArchives).toBe(3);
  });

  it('restoreJournal 一律从 journal 文件现取，touchBackupStatus 把快照落进状态文件', () => {
    const journal = {
      version: 1,
      startedAt: '2026-09-17T01:00:00.000Z',
      updatedAt: '2026-09-17T01:00:05.000Z',
      archivePath: '/b/a.tar.zst',
      archiveName: 'a.tar.zst',
      archiveCreatedAt: null,
      hostname: 'h',
      pid: 1,
      phase: 'collections',
      planned: { vanBlog: ['articles', 'users'] },
      done: [{ db: 'vanBlog', collection: 'articles', documents: 59, at: '2026-09-17T01:00:04.000Z' }],
      error: null,
    };
    // 状态文件里那份快照是旧的（null）
    recordBackupSuccess(dir, { name: 'x.tar.zst', bytes: 1, verifyMs: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, BACKUP_STATUS_FILE), 'utf8')).restoreJournal).toBeNull();
    // journal 出现：读的时候立刻可见（不必等下一次备份）
    fs.writeFileSync(path.join(dir, RESTORE_JOURNAL_FILE), JSON.stringify(journal));
    expect(readBackupStatus(dir).restoreJournal?.archiveName).toBe('a.tar.zst');
    // touch 之后文件里也有它（脚本读文件就够了）
    touchBackupStatus(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, BACKUP_STATUS_FILE), 'utf8')).restoreJournal.done).toHaveLength(1);
    // journal 被删（恢复成功）：读回来立刻是 null
    fs.rmSync(path.join(dir, RESTORE_JOURNAL_FILE));
    expect(readBackupStatus(dir).restoreJournal).toBeNull();
  });
});
