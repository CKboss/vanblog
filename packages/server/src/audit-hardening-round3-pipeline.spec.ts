import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'fs';

import { FullBackupProvider } from './provider/backup/fullBackup.provider';
import { PipelineProvider } from './provider/pipeline/pipeline.provider';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

/**
 * 「恢复之后，磁盘上的流水线脚本必须跟上库里的数据」。
 *
 * 背景：流水线的脚本正文**存在磁盘上**（`<codeRunnerPath>/<id>.js`），
 * `runCodeByPipelineId` fork 的就是那个文件；它只在两处被写：启动时
 * （`PipelineProvider` 构造函数里的 `init()` → `saveAllScripts()`）与后台编辑流水线时。
 * 整站恢复会把 `pipelines` 集合整份换掉，磁盘却停在恢复前 ——
 * 全新机器上（初始化页上传备份恢复）启动时库是空的，一个脚本都没写过，
 * 于是恢复进来的流水线 fork 一个不存在的文件；而 `dispatchEvent` 是被 await 的，
 * 表现为"保存文章卡到超时"，日志里只有一条子进程错误。
 */

jest.mock('src/utils/fullBackup', () => {
  const actual = jest.requireActual('src/utils/fullBackup');
  return {
    ...actual,
    restoreFullBackup: jest.fn(async () => ({
      manifest: { createdAt: '2026-09-13T14:09:55.000Z', databases: {} },
      databases: { vanBlog: { collections: 13, documents: 9830 } },
      static: { img: { files: 1 } },
      ms: 1200,
      notes: [],
    })),
  };
});

/** restoreFullBackup 被桩掉了，但 doRestore 仍会取 `connection.getClient()` 当参数 */
const fakeConnection = () => ({ getClient: () => ({}), name: 'vanBlog' } as any);

const root = __dirname;
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const code = stripCommentsForAnchor;

/**
 * 只带 pipelineModel / logProvider 两个桩的真实 PipelineProvider（脚本写盘是真的）。
 *
 * ⚠️ 桩必须满足两点，否则构造函数里的 `init()`（它是 fire-and-forget 的）会把测试进程带崩：
 *  - `getAll()` 是 `await model.find({deleted:false})`，mongoose 的 query 是 thenable，
 *    所以桩要直接返回 Promise（返回 `{sort(){}}` 这种会让 `for...of` 抛 TypeError）；
 *  - 每条流水线都要有 `deps: []`，否则 `checkAllDeps()` 里 `for (const dep of pipeline.deps)`
 *    会在 undefined 上迭代 —— 而且真有依赖时它会去跑 `pnpm add`（测试里绝不能发生）。
 */
function makePipelineProvider(
  runnerPath: string,
  rows: Array<{ id: number; script: string; deps?: string[] }> = [],
) {
  const state = { rows: rows.map((r) => ({ deps: [], ...r })) };
  const model = { find: jest.fn(() => Promise.resolve(state.rows)) };
  const provider = new PipelineProvider(model as any, {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as any);
  (provider as any).runnerPath = runnerPath;
  return { provider, state, model };
}

/**
 * 构造期那次 `init()` 是 fire-and-forget 的（构造函数不 await），
 * 所以要先让它的微任务跑完，再装 spy / 再断言 —— 否则测到的是"启动期"那一次，
 * 而不是"恢复之后"那一次。
 */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('恢复之后重写流水线脚本', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-pipeline-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('(a) restore() 之后会按库里的流水线把每个 <id>.js 都写出来（启动时库是空的 ⇒ 一个都没写过）', async () => {
    const rows = [
      { id: 1, script: 'input.a = 1;', deps: [] },
      { id: 7, script: 'console.log("七号");', deps: [] },
    ];
    // 全新机器的真实顺序：启动时 pipelines 集合是空的，恢复之后才有数据
    const { provider: pipelines, state } = makePipelineProvider(tmp, []);
    await settle();
    expect(fs.existsSync(path.join(tmp, '1.js'))).toBe(false);
    state.rows = rows.map((r) => ({ deps: [], ...r })); // 恢复把这一份写进了库
    const backup = new FullBackupProvider(fakeConnection(), pipelines);
    const res = await backup.restore('/fake/vanblog-full-20260913-140955.tar.zst', true);
    expect(res.databases.vanBlog.documents).toBe(9830);
    for (const row of rows) {
      const file = path.join(tmp, `${row.id}.js`);
      expect(fs.existsSync(file)).toBe(true);
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toContain(row.script);
      // 落盘的是带 process.on('message') 包装的可 fork 脚本，不是裸的用户代码
      expect(text).toContain("process.on('message'");
      expect(text).toContain('process.send');
    }
  });

  it('(b) 磁盘上已有同名脚本时按**库里的内容**覆盖（库是唯一事实来源，不存在"用旧内容盖新内容"）', async () => {
    const file = path.join(tmp, '3.js');
    fs.writeFileSync(file, '这是有人手改过的旧内容 SHOULD_BE_GONE');
    const { provider: pipelines, state } = makePipelineProvider(tmp, []);
    await settle();
    state.rows = [{ id: 3, script: 'input.fromDb = true;', deps: [] }];
    await new FullBackupProvider(fakeConnection(), pipelines).restore('/fake/x.tar.zst', true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('input.fromDb = true;');
    expect(text).not.toContain('SHOULD_BE_GONE');
  });

  it('(c) 这条路径**不**装依赖：只调 saveAllScripts，不碰 checkAllDeps / init（不在请求路径上跑 pnpm add）', async () => {
    const { provider: pipelines, state } = makePipelineProvider(tmp, []);
    await settle(); // 让构造期那次 init() 先跑完，spy 才只统计恢复路径
    state.rows = [{ id: 1, script: 'x', deps: [] }];
    const checkAllDeps = jest.spyOn(pipelines, 'checkAllDeps');
    const init = jest.spyOn(pipelines, 'init');
    const addDeps = jest.spyOn(pipelines, 'addDeps');
    await new FullBackupProvider(fakeConnection(), pipelines).restore('/fake/x.tar.zst', true);
    expect(checkAllDeps).not.toHaveBeenCalled();
    expect(addDeps).not.toHaveBeenCalled();
    // init() 只在构造时跑过一次（那次是启动期，不是恢复路径）
    const callsAfterConstruct = init.mock.calls.length;
    await new FullBackupProvider(fakeConnection(), pipelines).restore('/fake/x.tar.zst', true);
    expect(init.mock.calls.length).toBe(callsAfterConstruct);

    const src = code(read('provider/backup/fullBackup.provider.ts'));
    expect(src).toContain('await this.pipelineProvider.saveAllScripts()');
    expect(src).not.toContain('this.pipelineProvider.init()');
    expect(src).not.toContain('this.pipelineProvider.checkAllDeps()');
  });

  it('(d) 文件缺失（全新机器）时被重新创建', async () => {
    const { provider: pipelines, state } = makePipelineProvider(tmp, []);
    await settle();
    expect(fs.existsSync(path.join(tmp, '42.js'))).toBe(false);
    state.rows = [{ id: 42, script: 'input.recreated = 1;', deps: [] }];
    await new FullBackupProvider(fakeConnection(), pipelines).restore('/fake/x.tar.zst', true);
    expect(fs.existsSync(path.join(tmp, '42.js'))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, '42.js'), 'utf8')).toContain('input.recreated = 1;');
  });

  it('脚本写盘失败不会让恢复失败（恢复结果已经成立），但要打 WARN', async () => {
    const { provider: pipelines } = makePipelineProvider(tmp, []);
    await settle();
    jest
      .spyOn(pipelines, 'saveAllScripts')
      .mockRejectedValue(new Error('只读文件系统') as never);
    const warn = jest
      .spyOn((pipelines as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const backup = new FullBackupProvider(fakeConnection(), pipelines);
    const backupWarn = jest
      .spyOn((backup as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const res = await backup.restore('/fake/x.tar.zst', true);
    expect(res.databases.vanBlog.documents).toBe(9830);
    expect(backupWarn).toHaveBeenCalledWith(expect.stringContaining('重写流水线脚本失败'));
    warn.mockRestore();
    backupWarn.mockRestore();
  });

  it('没注入 PipelineProvider 时（@Optional）恢复照常工作', async () => {
    const res = await new FullBackupProvider(fakeConnection()).restore('/fake/x.tar.zst', true);
    expect(res.databases.vanBlog.documents).toBe(9830);
  });

  it('启动期的 init() 只由主实例跑（多进程时不该有 N 个 pnpm add 同时改一个 node_modules）', () => {
    const src = code(read('provider/pipeline/pipeline.provider.ts'));
    expect(src).toContain('if (isPrimaryInstance(cluster))');
    expect(src).toContain('this.init();');
    expect(src.indexOf('isPrimaryInstance(cluster)')).toBeLessThan(src.indexOf('this.init();'));
  });
});
