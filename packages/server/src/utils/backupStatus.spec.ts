import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BACKUP_STATUS_FILE,
  emptyBackupStatus,
  readBackupStatus,
  recordBackupFailure,
  recordBackupSuccess,
  resolveStaleWarnHours,
  staleBackupWarning,
} from './backupStatus';

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
