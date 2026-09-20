import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FullBackupProvider } from './fullBackup.provider';
import * as fullBackupModule from 'src/utils/fullBackup';
import * as backupVerifyModule from 'src/utils/backupVerify';
import * as backupStatusModule from 'src/utils/backupStatus';

/**
 * P2 的**接线**钉子：导出成功必须走写后校验、校验失败必须
 *  ① 记状态（stage='verify'，consecutiveFailures+1）② ERROR 带原因 ③ 对外抛 400。
 * 负控：把 doExport 里的 verify 调用拿掉，这些断言全红（已实测，见交付报告）。
 */

function fakeResult(name = 'vanblog-full-20260917-010101.tar.gz') {
  return {
    path: `/tmp/fake/${name}`,
    name,
    bytes: 2048,
    sizeText: '0.00 MB',
    format: 'gzip' as const,
    compressor: 'gzip -9',
    ms: 42,
    manifest: {
      kind: 'vanblog-full-backup' as const,
      version: 1,
      createdAt: new Date().toISOString(),
      format: 'gzip',
      compressor: 'gzip -9',
      databases: {},
      static: {},
      totals: { databases: 0, collections: 0, documents: 0, files: 0, staticBytes: 0 },
    },
  };
}

/** 校验结果的假对象：`integrity` 是 P1 之后必填的一块（老归档在真实代码里会走降级分支） */
function fakeVerifyResult(overrides: Partial<backupVerifyModule.BackupVerifyResult> = {}) {
  return {
    ok: true,
    ms: 7,
    archiveBytes: 2048,
    members: 9,
    format: 'gzip',
    checks: {} as any,
    integrity: {
      available: false,
      merkleRootOk: null,
      memberCountOk: null,
      recordedMembers: null,
      manifestCopyOk: null,
      archiveSha256Ok: null,
      archiveSha256: null,
      frameChecksumOk: null,
      frameChecksum: null,
      membersChecked: null,
      memberFindings: [],
      notes: [],
    } as any,
    issues: [],
    ...overrides,
  } as backupVerifyModule.BackupVerifyResult;
}

function createProvider(dir: string) {
  const connection = { getClient: () => ({}), name: 'vanBlogTest' } as any;
  const provider = new FullBackupProvider(connection);
  // ⚠️ 绝不让状态文件写进真实 backupPath：backupDir() 指到一次性临时目录
  jest.spyOn(provider, 'backupDir').mockReturnValue(dir);
  jest.spyOn((provider as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((provider as any).logger, 'error').mockImplementation(() => undefined);
  return provider;
}

describe('FullBackupProvider 写后校验接线', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-fbp-'));
    jest.restoreAllMocks();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('校验通过：返回带 verification，状态文件记成功（连续失败清零）', async () => {
    const provider = createProvider(dir);
    const result = fakeResult();
    jest.spyOn(fullBackupModule, 'createFullBackup').mockResolvedValue(result as any);
    const verify = jest
      .spyOn(backupVerifyModule, 'verifyFullBackup')
      .mockResolvedValue(fakeVerifyResult());

    const outcome = await provider.export();
    // 导出后默认做**成员级**深度校验（VANBLOG_BACKUP_VERIFY_DEEP，默认开）。
    // ⚠️ 这条断言**升级过**（不是放宽）：调用现在多带一个 `backupDir`，因为验签公钥可能来自
    //    `<备份目录>/signing/`（由 `POST /api/admin/backup/signing/key` 生成的那一对）。
    //    不给这个参数，"生成过密钥但没配 env"的部署会一直看到"没有配验签公钥" ⇒ 签名形同没配。
    //    本条原本保护的性质（deep 默认为 true）原样保留，而且 `toHaveBeenCalledWith` 是精确匹配，
    //    少一个键、多一个键、或 deep 变成 false 都会红 ⇒ 不是空断言。
    expect(verify).toHaveBeenCalledWith(result.path, { deep: true, backupDir: dir });
    expect(outcome.verification.ok).toBe(true);
    const status = backupStatusModule.readBackupStatus(dir);
    expect(status.lastSuccessName).toBe(result.name);
    expect(status.lastSuccessBytes).toBe(2048);
    expect(status.lastVerifyMs).toBe(7);
    expect(status.consecutiveFailures).toBe(0);
  });

  it('校验失败：抛 400 + 状态记 verify 失败（连续失败累加）+ ERROR 日志带原因', async () => {
    const provider = createProvider(dir);
    const result = fakeResult();
    jest.spyOn(fullBackupModule, 'createFullBackup').mockResolvedValue(result as any);
    jest.spyOn(backupVerifyModule, 'verifyFullBackup').mockResolvedValue(
      fakeVerifyResult({
        ok: false,
        ms: 3,
        members: 0,
        checks: { readThrough: false } as any,
        issues: [{ check: 'readThrough', message: '归档截断（CRC 失败）' }],
      }),
    );

    await expect(provider.export()).rejects.toBeInstanceOf(BadRequestException);
    const status = backupStatusModule.readBackupStatus(dir);
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastFailureStage).toBe('verify');
    expect(status.lastFailureName).toBe(result.name);
    expect(status.lastFailureMessage).toContain('归档截断');
    expect(status.lastSuccessAt).toBeNull();
    const errorCalls = ((provider as any).logger.error as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(errorCalls.some((m) => m.includes('校验失败') && m.includes('归档截断'))).toBe(true);

    // 再失败一次：连续失败数累加（cron 连坏几天要能看出来）
    await expect(provider.export()).rejects.toBeInstanceOf(BadRequestException);
    expect(backupStatusModule.readBackupStatus(dir).consecutiveFailures).toBe(2);
  });

  it('导出本身失败：状态记 export 失败并原样重抛', async () => {
    const provider = createProvider(dir);
    const boom = new Error('ENOSPC');
    jest.spyOn(fullBackupModule, 'createFullBackup').mockRejectedValue(boom);
    const verify = jest.spyOn(backupVerifyModule, 'verifyFullBackup');

    await expect(provider.export()).rejects.toBe(boom);
    expect(verify).not.toHaveBeenCalled(); // 没产出归档就不该校验
    const status = backupStatusModule.readBackupStatus(dir);
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastFailureStage).toBe('export');
    expect(status.lastFailureMessage).toContain('ENOSPC');
  });

  it('status()：状态 + staleWarnHours + stale 判定（只读，供后台专用接口）', () => {
    const provider = createProvider(dir);
    backupStatusModule.recordBackupSuccess(dir, { name: 'old.tar.gz', bytes: 1, verifyMs: 1 });
    // 把成功时间改老，制造"陈旧"
    const file = path.join(dir, backupStatusModule.BACKUP_STATUS_FILE);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.lastSuccessAt = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(parsed));

    const view = provider.status();
    expect(view.lastSuccessName).toBe('old.tar.gz');
    expect(view.staleWarnHours).toBe(48); // 默认阈值
    expect(view.stale).toBe(true);
    expect(view.staleMessage).toContain('72 小时前');
  });

  it('status() 在无状态文件时返回空状态而不是抛（全新实例）', () => {
    const provider = createProvider(dir);
    const view = provider.status();
    expect(view.lastSuccessAt).toBeNull();
    expect(view.stale).toBe(true); // 从未成功过 = 陈旧（WARN 文案给出下一步动作）
    expect(view.staleMessage).toContain('没有任何已校验成功');
  });
});
