import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventType } from './types';

/**
 * `searchLog` 的"有界扫描"行为（响应形状必须与改动前完全一致：`{data, total}`，
 * data 从新到旧）。改动前是把整份日志从头读到尾 + 每行 JSON.parse；
 * 现在只读尾部，且文件不存在时立刻返回而不是把请求挂死。
 */

function createProvider(logPath: string, systemLogPath?: string) {
  // LogProvider 的构造函数会建 pino 写流，这里只测 searchLog，所以绕过构造函数
  let LogProviderClass: any;
  jest.isolateModules(() => {
    LogProviderClass = require('./log.provider').LogProvider;
  });
  const provider = Object.create(LogProviderClass.prototype);
  provider.logPath = logPath;
  provider.systemLogPath = systemLogPath || path.join(path.dirname(logPath), 'vanblog-stdio.log');
  return provider;
}

const writeNdjson = (file: string, rows: unknown[]) =>
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-searchlog-'));
  logPath = path.join(tmp, 'vanblog-event.log');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.VANBLOG_LOG_SCAN_MAX_LINES;
});

describe('searchLog：响应形状不变', () => {
  it('仍然是 {data, total}，data 从新到旧，total 与页码无关', async () => {
    const rows: any[] = [];
    for (let i = 1; i <= 12; i += 1) rows.push({ event: EventType.LOGIN, id: i });
    writeNdjson(logPath, rows);
    const provider = createProvider(logPath);

    const page1 = await provider.searchLog(1, 5, EventType.LOGIN);
    expect(Object.keys(page1).sort()).toEqual(['data', 'total']);
    expect(page1.total).toBe(12);
    expect(page1.data.map((r: any) => r.id)).toEqual([12, 11, 10, 9, 8]);

    const page2 = await provider.searchLog(2, 5, EventType.LOGIN);
    expect(page2.total).toBe(12);
    expect(page2.data.map((r: any) => r.id)).toEqual([7, 6, 5, 4, 3]);

    const page3 = await provider.searchLog(3, 5, EventType.LOGIN);
    expect(page3.data.map((r: any) => r.id)).toEqual([2, 1]);

    const page4 = await provider.searchLog(4, 5, EventType.LOGIN);
    expect(page4.data).toEqual([]);
    expect(page4.total).toBe(12);
  });

  it('只统计指定事件类型', async () => {
    writeNdjson(logPath, [
      { event: EventType.LOGIN, id: 1 },
      { event: EventType.RUN_PIPELINE, id: 2 },
      { event: EventType.LOGIN, id: 3 },
    ]);
    const provider = createProvider(logPath);
    const res = await provider.searchLog(1, 10, EventType.LOGIN);
    expect(res.total).toBe(2);
    expect(res.data.map((r: any) => r.id)).toEqual([3, 1]);
  });

  it('系统日志按整行返回（不做 JSON.parse）', async () => {
    const sysPath = path.join(tmp, 'vanblog-stdio.log');
    fs.writeFileSync(sysPath, 'boot line 1\nboot line 2\n', 'utf8');
    const provider = createProvider(logPath, sysPath);
    const res = await provider.searchLog(1, 10, EventType.SYSTEM);
    expect(res.total).toBe(2);
    expect(res.data).toEqual(['boot line 2', 'boot line 1']);
  });
});

describe('searchLog：健壮性（改动前会挂死或丢数据的地方）', () => {
  it('日志文件不存在时立刻返回空，而不是一直挂着', async () => {
    const provider = createProvider(path.join(tmp, 'missing.log'));
    const started = Date.now();
    const res = await provider.searchLog(1, 10, EventType.SYSTEM);
    expect(res).toEqual({ data: [], total: 0 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('空行不再让扫描提前结束（改动前遇到空行就 resolve，后面的日志全丢）', async () => {
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({ event: EventType.LOGIN, id: 1 }),
        '',
        JSON.stringify({ event: EventType.LOGIN, id: 2 }),
        '   ',
        JSON.stringify({ event: EventType.LOGIN, id: 3 }),
        '',
      ].join('\n'),
      'utf8',
    );
    const provider = createProvider(logPath);
    const res = await provider.searchLog(1, 10, EventType.LOGIN);
    expect(res.total).toBe(3);
    expect(res.data.map((r: any) => r.id)).toEqual([3, 2, 1]);
  });

  it('半行/坏 JSON 被跳过，不会让整页 500', async () => {
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({ event: EventType.LOGIN, id: 1 }),
        '{"event":"login","id":2', // 被截断的一行
        'not json at all',
        JSON.stringify({ event: EventType.LOGIN, id: 3 }),
      ].join('\n') + '\n',
      'utf8',
    );
    const provider = createProvider(logPath);
    const res = await provider.searchLog(1, 10, EventType.LOGIN);
    expect(res.data.map((r: any) => r.id)).toEqual([3, 1]);
    expect(res.total).toBe(2);
  });
});

describe('searchLog：扫描量有上限', () => {
  it('日志很长时只读尾部，total 是下界（并在日志里说明）', async () => {
    process.env.VANBLOG_LOG_SCAN_MAX_LINES = '50';
    const rows: any[] = [];
    for (let i = 1; i <= 2000; i += 1) rows.push({ event: EventType.LOGIN, id: i });
    writeNdjson(logPath, rows);
    const provider = createProvider(logPath);

    const res = await provider.searchLog(1, 10, EventType.LOGIN);
    // 最新的还是最新的那几条
    expect(res.data.map((r: any) => r.id)).toEqual([2000, 1999, 1998, 1997, 1996, 1995, 1994, 1993, 1992, 1991]);
    // 只扫了尾部 50 行，所以 total 不再等于 2000
    expect(res.total).toBe(50);
  });

  it('扫描上限之内结果与"读整份文件"完全一致', async () => {
    const rows: any[] = [];
    for (let i = 1; i <= 200; i += 1) rows.push({ event: EventType.LOGIN, id: i });
    writeNdjson(logPath, rows);
    const provider = createProvider(logPath);
    const res = await provider.searchLog(1, 10, EventType.LOGIN);
    expect(res.total).toBe(200);
    expect(res.data[0].id).toBe(200);
  });

  it('读的量随上限而不是随文件大小增长', async () => {
    process.env.VANBLOG_LOG_SCAN_MAX_LINES = '20';
    const rows: any[] = [];
    for (let i = 1; i <= 50000; i += 1) rows.push({ event: EventType.LOGIN, id: i, pad: 'x'.repeat(80) });
    writeNdjson(logPath, rows);
    const size = fs.statSync(logPath).size;
    expect(size).toBeGreaterThan(4 * 1024 * 1024);
    const provider = createProvider(logPath);
    const started = Date.now();
    const res = await provider.searchLog(1, 10, EventType.LOGIN);
    const elapsed = Date.now() - started;
    expect(res.total).toBe(20);
    expect(res.data[0].id).toBe(50000);
    // 4MB+ 的日志，只读尾部 20 行：应该是毫秒级（改动前要逐行解析 5 万条）
    expect(elapsed).toBeLessThan(2000);
  });
});
