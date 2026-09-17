import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FullBackupProvider } from './fullBackup.provider';
import * as fullBackupModule from 'src/utils/fullBackup';
import {
  BACKUP_STATUS_FILE,
  readBackupStatus,
  recordBackupSuccess,
} from 'src/utils/backupStatus';
import { RESTORE_JOURNAL_FILE } from 'src/utils/restoreJournal';

/**
 * P4（定期复验）与 P5（恢复断点）在 **provider 层的接线**钉子。
 *
 * 纯函数部分（校验器、journal 读写）各有自己的 spec；这里钉的是"谁在什么时候调它们"：
 *  - 巡检只查最新 N 份、结果进 `backup-status.json`、失败 WARN 点名归档；
 *  - 巡检**绝不删任何东西**（检测，不修复）；
 *  - 巡检失败**不计入** consecutiveFailures（那个计数器是"导出还产不产得出可用归档"）；
 *  - `VANBLOG_BACKUP_SWEEP_HOURS=0` = 完全不跑（= 今天的行为）；
 *  - 启动时发现恢复断点：WARN 点名归档 + 把快照写进状态文件（后台/脚本不必读日志）；
 *  - 启动时清掉上次崩溃留下的导出临时文件。
 */

jest.setTimeout(180000);

function createProvider(dir: string) {
  const connection = { getClient: () => ({}), name: 'vanBlogTest' } as any;
  const provider = new FullBackupProvider(connection);
  jest.spyOn(provider, 'backupDir').mockReturnValue(dir);
  const logs: string[] = [];
  const warns: string[] = [];
  jest.spyOn((provider as any).logger, 'log').mockImplementation((m: string) => logs.push(String(m)));
  jest.spyOn((provider as any).logger, 'warn').mockImplementation((m: string) => warns.push(String(m)));
  jest.spyOn((provider as any).logger, 'error').mockImplementation(() => undefined);
  return { provider, logs, warns };
}

function fakeMongo() {
  const state: Record<string, Record<string, any[]>> = {
    vanBlog: { users: [{ _id: 'u1', username: 'admin' }], metas: [{ _id: 'm1' }] },
  };
  const client: any = {
    db(name: string) {
      if (!state[name]) state[name] = {};
      return {
        databaseName: name,
        collections: async () => Object.keys(state[name]).map((c) => ({ collectionName: c })),
        createCollection: async (c: string) => {
          if (!state[name][c]) state[name][c] = [];
        },
        collection(c: string) {
          if (!state[name][c]) state[name][c] = [];
          return {
            collectionName: c,
            find: () =>
              (async function* g() {
                for (const doc of state[name][c]) yield doc;
              })(),
            indexes: async () => [],
            countDocuments: async () => state[name][c].length,
            deleteMany: async () => ({ deletedCount: 0 }),
            insertMany: async (docs: any[]) => {
              state[name][c].push(...docs);
              return { insertedCount: docs.length };
            },
            rename: async (newName: string) => {
              state[name][newName] = state[name][c];
              delete state[name][c];
              return { collectionName: newName };
            },
            createIndex: async () => 'index',
          };
        },
      };
    },
  };
  return client;
}

/**
 * 造 n 份真归档（gzip，真 tar），createdAt 依次递增，方便钉"最新的优先"。
 *
 * ⚠️ 必须**每份之间隔一秒**：归档名只精确到秒（`backupFileName`），
 * 同一秒内导出两次会得到同一个文件名（生产上导出要 28s，撞不上；测试里必须自己隔开）。
 * ⚠️ 也**不能**事后改 sidecar 里的 createdAt 来造顺序 —— 写后校验会拿 sidecar 与归档内部
 * 的清单逐字段比对，改了就变成 `sidecarMatches` 失败（这正是该校验要抓的事）。
 */
async function makeArchives(dir: string, count: number): Promise<string[]> {
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1050));
    }
    const staticPath = path.join(dir, `static-${i}`, 'img');
    fs.mkdirSync(staticPath, { recursive: true });
    fs.writeFileSync(path.join(staticPath, `a${i}.webp`), `image-${i}`);
    const result = await fullBackupModule.createFullBackup({
      client: fakeMongo(),
      staticPath: path.join(dir, `static-${i}`),
      dbName: 'vanBlog',
      format: 'gzip',
      outDir: dir,
      workDir: path.join(dir, `work-${i}`),
    } as any);
    names.push(result.name);
  }
  return names;
}

describe('FullBackupProvider 定期复验（P4）', () => {
  let dir: string;
  const OLD_ENV: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-sweep-'));
    for (const key of [
      'VANBLOG_BACKUP_SWEEP_HOURS',
      'VANBLOG_BACKUP_SWEEP_MAX',
      'VANBLOG_BACKUP_SWEEP_DEEP',
    ]) {
      OLD_ENV[key] = process.env[key];
      delete process.env[key];
    }
    jest.restoreAllMocks();
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(OLD_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('默认最多查 3 份、最新的优先，结果落进 backup-status.json', async () => {
    const names = await makeArchives(dir, 5);
    const { provider } = createProvider(dir);
    const results = await provider.runSweep('test');
    expect(results).toHaveLength(3);
    // listFullBackups 按 createdAt 倒序 ⇒ 最后造的三份
    expect(results.map((item) => item.name)).toEqual([names[4], names[3], names[2]]);
    expect(results.every((item) => item.ok)).toBe(true);

    const status = readBackupStatus(dir);
    expect(status.lastSweepArchives).toBe(3);
    expect(status.lastSweepFailures).toBe(0);
    expect(status.lastSweepResults).toHaveLength(3);
    expect(status.lastSweepResults[0].name).toBe(names[4]);
    expect(status.lastSweepMessage).toContain('3 份归档复验完成');
    expect(status.lastSweepAt).not.toBeNull();
    expect(status.lastSweepMs).toBeGreaterThan(0);
    expect(status.consecutiveFailures).toBe(0);
  });

  it('VANBLOG_BACKUP_SWEEP_MAX=1 只查最新那一份（成本可预测）', async () => {
    const names = await makeArchives(dir, 3);
    process.env.VANBLOG_BACKUP_SWEEP_MAX = '1';
    const { provider } = createProvider(dir);
    const results = await provider.runSweep('test');
    expect(results.map((item) => item.name)).toEqual([names[2]]);
    expect(readBackupStatus(dir).lastSweepArchives).toBe(1);
  });

  it('VANBLOG_BACKUP_SWEEP_HOURS=0：runSweep 什么都不做，状态文件也不写', async () => {
    const names = await makeArchives(dir, 2);
    process.env.VANBLOG_BACKUP_SWEEP_HOURS = '0';
    const { provider } = createProvider(dir);
    expect(await provider.runSweep('test')).toEqual([]);
    expect(fs.existsSync(path.join(dir, BACKUP_STATUS_FILE))).toBe(false);
    expect(names).toHaveLength(2);
  });

  it('scheduleSweep 在 0 时不排巡检定时器（= 今天的行为；启动那三件检查照旧）', () => {
    process.env.VANBLOG_BACKUP_SWEEP_HOURS = '0';
    const { provider } = createProvider(dir);
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    provider.onApplicationBootstrap();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    // 启动检查那一个 5s setTimeout 仍然在（备份陈旧 / 恢复断点 / 临时文件清理）
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it('scheduleSweep 默认排一个 24h 的定时器，且 unref（不能把进程吊住不让退出）', () => {
    const { provider } = createProvider(dir);
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    provider.onApplicationBootstrap();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 24 * 3600 * 1000);
    const timer: any = setIntervalSpy.mock.results[0].value;
    // unref 过之后 hasRef() 为 false
    expect(typeof timer.hasRef === 'function' ? timer.hasRef() : true).toBe(false);
    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it('坏归档：ok=false + WARN 点名归档 + stage=sweep，但**不删文件**、也**不加** consecutiveFailures', async () => {
    const names = await makeArchives(dir, 2);
    // 把最新那份截断：解压必然失败
    const broken = path.join(dir, names[1]);
    const size = fs.statSync(broken).size;
    fs.truncateSync(broken, Math.max(1, Math.floor(size * 0.5)));
    recordBackupSuccess(dir, { name: 'earlier.tar.gz', bytes: 1, verifyMs: 1 });
    expect(readBackupStatus(dir).consecutiveFailures).toBe(0);

    const { provider, warns } = createProvider(dir);
    const results = await provider.runSweep('test');
    expect(results.map((item) => item.name)).toEqual([names[1], names[0]]);
    expect(results[0].ok).toBe(false);
    expect(results[0].issues.length).toBeGreaterThan(0);
    expect(results[1].ok).toBe(true);

    const warnText = warns.join('\n');
    expect(warnText).toContain('备份定期复验发现问题');
    expect(warnText).toContain(names[1]); // 必须点名，否则没法行动
    expect(warnText).toContain('不会自动删除或修复');

    const status = readBackupStatus(dir);
    expect(status.lastSweepFailures).toBe(1);
    expect(status.lastFailureStage).toBe('sweep');
    expect(status.lastFailureName).toBe(names[1]);
    // 巡检失败不是"导出失败"：连续失败计数保持 0
    expect(status.consecutiveFailures).toBe(0);
    // 检测，不修复：两份归档都还在
    expect(fs.existsSync(broken)).toBe(true);
    expect(fs.existsSync(path.join(dir, names[0]))).toBe(true);
    expect(fullBackupModule.listFullBackups(dir)).toHaveLength(2);
  });

  it('VANBLOG_BACKUP_SWEEP_DEEP=on 时做成员级校验（membersChecked 有值）', async () => {
    await makeArchives(dir, 1);
    process.env.VANBLOG_BACKUP_SWEEP_DEEP = 'on';
    const { provider } = createProvider(dir);
    const results = await provider.runSweep('test');
    expect(results[0].membersChecked).toBeGreaterThan(0);
    expect(readBackupStatus(dir).lastSweepResults[0].membersChecked).toBeGreaterThan(0);
  });

  it('备份目录是空的：不报错，状态里写"没有可复验的归档"', async () => {
    const { provider } = createProvider(dir);
    expect(await provider.runSweep('test')).toEqual([]);
    const status = readBackupStatus(dir);
    expect(status.lastSweepArchives).toBe(0);
    expect(status.lastSweepMessage).toContain('没有可复验的归档');
    expect(status.lastSweepFailures).toBe(0);
  });

  it('verifyArchive(name)：后台按需复验，默认做到成员级，并拒绝目录外的名字', async () => {
    const names = await makeArchives(dir, 1);
    const { provider } = createProvider(dir);
    const result = await provider.verifyArchive(names[0]);
    expect(result.ok).toBe(true);
    expect(result.integrity.membersChecked).toBeGreaterThan(0);
    await expect(provider.verifyArchive('../../etc/passwd')).rejects.toBeTruthy();
  });
});

describe('FullBackupProvider 启动检查（P2 临时文件 + P5 恢复断点）', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-boot-'));
    process.env.VANBLOG_BACKUP_SWEEP_HOURS = '0'; // 这些用例不关心巡检
    jest.restoreAllMocks();
  });
  afterEach(() => {
    delete process.env.VANBLOG_BACKUP_SWEEP_HOURS;
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('发现恢复断点：WARN 点名归档与进度，并把快照写进 backup-status.json', () => {
    fs.writeFileSync(
      path.join(dir, RESTORE_JOURNAL_FILE),
      JSON.stringify({
        version: 1,
        startedAt: '2026-09-17T01:00:00.000Z',
        updatedAt: '2026-09-17T01:00:05.000Z',
        archivePath: '/backups/vanblog-full-20260917-010000.tar.zst',
        archiveName: 'vanblog-full-20260917-010000.tar.zst',
        archiveCreatedAt: '2026-09-16T00:00:00.000Z',
        hostname: 'h',
        pid: 4242,
        phase: 'collections',
        planned: { vanBlog: ['articles', 'users', 'metas'] },
        done: [{ db: 'vanBlog', collection: 'articles', documents: 59, at: '2026-09-17T01:00:04.000Z' }],
        error: null,
      }),
    );
    const { provider, warns } = createProvider(dir);
    (provider as any).warnIfInterruptedRestore();

    const text = warns.join('\n');
    expect(text).toContain('恢复断点告警');
    expect(text).toContain('vanblog-full-20260917-010000.tar.zst');
    expect(text).toContain('已换完 1/3 张表');
    expect(text).toContain('vanBlog.articles');

    // 状态文件里现在也有它（后台与 vanblog.sh backup-status 不必读日志）
    const raw = JSON.parse(fs.readFileSync(path.join(dir, BACKUP_STATUS_FILE), 'utf8'));
    expect(raw.restoreJournal.archiveName).toBe('vanblog-full-20260917-010000.tar.zst');
    const view = provider.status();
    expect(view.restoreJournal).not.toBeNull();
    expect(view.restoreJournalMessage).toContain('混合状态');
  });

  it('没有断点时 status().restoreJournal 是 null，且不写状态文件', () => {
    const { provider } = createProvider(dir);
    (provider as any).warnIfInterruptedRestore();
    expect(provider.status().restoreJournal).toBeNull();
    expect(provider.status().restoreJournalMessage).toBeNull();
    expect(fs.existsSync(path.join(dir, BACKUP_STATUS_FILE))).toBe(false);
  });

  it('journal 被删掉之后，状态视图立刻变回 null（读的是文件本身，不是快照）', () => {
    fs.writeFileSync(
      path.join(dir, RESTORE_JOURNAL_FILE),
      JSON.stringify({ version: 1, phase: 'failed', planned: {}, done: [], archiveName: 'a.tar.zst' }),
    );
    const { provider } = createProvider(dir);
    expect(provider.status().restoreJournal).not.toBeNull();
    fs.rmSync(path.join(dir, RESTORE_JOURNAL_FILE));
    expect(provider.status().restoreJournal).toBeNull();
  });

  it('启动清理：够旧的导出临时文件被删，真归档与 sidecar 一个不动', async () => {
    const names = await makeArchives(dir, 1);
    const temp = path.join(dir, fullBackupModule.exportTempName('.tar.gz'));
    fs.writeFileSync(temp, 'half');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(temp, twoHoursAgo, twoHoursAgo);
    const { provider, warns } = createProvider(dir);
    (provider as any).cleanupExportTemps();
    expect(fs.existsSync(temp)).toBe(false);
    expect(warns.join('\n')).toContain('导出临时文件');
    expect(fs.existsSync(path.join(dir, names[0]))).toBe(true);
    expect(fs.existsSync(`${path.join(dir, names[0])}.sha256`)).toBe(true);
  });
});
