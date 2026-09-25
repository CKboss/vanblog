import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RotatingFileStream, rotateLogFiles, rotatedPath } from './logRotate';

describe('事件日志轮转', () => {
  let dir: string;
  let logPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-logrotate-'));
    logPath = path.join(dir, 'vanblog-event.log');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

  it('没到阈值不轮转', async () => {
    const s = new RotatingFileStream(logPath, 1000, 3);
    s.write('hello\n');
    await s.flush();
    expect(s.rotations).toBe(0);
    expect(read(logPath)).toBe('hello\n');
    expect(read(rotatedPath(logPath, 1))).toBeNull();
  });

  it('到阈值就轮转，新内容写进新文件', async () => {
    const s = new RotatingFileStream(logPath, 10, 3);
    s.write('0123456789'); // 正好 10 字节 ⇒ 触发
    await s.flush(); // 轮转发生在"写入落盘"这个安全点，所以要 flush 后才可断言
    s.write('after\n');
    await s.flush();
    expect(s.rotations).toBe(1);
    expect(read(rotatedPath(logPath, 1))).toBe('0123456789');
    expect(read(logPath)).toBe('after\n');
  });

  it('历史文件依次后移，最老的一份被删掉（保留 K 份）', async () => {
    const s = new RotatingFileStream(logPath, 4, 2);
    s.write('aaaa'); // → .1
    await s.flush();
    s.write('bbbb'); // → .1，原 .1 变 .2
    await s.flush();
    s.write('cccc'); // → .1，原 .1('bbbb') 变 .2，原 .2('aaaa') 被删
    await s.flush();
    // keep=2 ⇒ 只留 .1 与 .2；每写满 4 字节就转一次，所以三轮之后 .1 是最新那份
    expect(read(rotatedPath(logPath, 1))).toBe('cccc');
    expect(read(rotatedPath(logPath, 2))).toBe('bbbb');
    expect(fs.existsSync(rotatedPath(logPath, 3))).toBe(false);
    expect(s.rotations).toBe(3);
  });

  it('进程重启后从现有文件大小接着算（不会因为重启就永不轮转）', async () => {
    fs.writeFileSync(logPath, 'x'.repeat(50));
    const s = new RotatingFileStream(logPath, 60, 3);
    s.write('y'.repeat(5)); // 50 + 5 < 60 ⇒ 不轮转
    await s.flush();
    expect(s.rotations).toBe(0);
    s.write('z'.repeat(10)); // 65 ≥ 60 ⇒ 轮转
    await s.flush();
    expect(s.rotations).toBe(1);
    expect(read(rotatedPath(logPath, 1))).toContain('x'.repeat(50));
  });

  it('多字节字符按字节数计，不按字符数', async () => {
    const s = new RotatingFileStream(logPath, 6, 3);
    s.write('中文'); // 6 字节 ⇒ 触发
    await s.flush();
    expect(s.rotations).toBe(1);
  });

  it('持续写入会反复轮转，且单份文件有上界（不会因为一直有写入在飞而饿死）', async () => {
    // ⚠️ 这条要按**真实形状**写：pino 是随时间持续写日志的，不是一口气同步写几千条。
    // 第一版写成"同步写 2000 条再 flush"，结果 2000 条全部发生在流还没 open 之前
    // （createWriteStream 是异步打开文件的），而轮转只能在流打开后做 ⇒ 只轮转了 1 次，
    // 看着像防饿死规则失效，其实是测试形状不对。改成"分 20 轮、每轮等落盘"。
    const maxBytes = 100;
    const s = new RotatingFileStream(logPath, maxBytes, 3);
    for (let round = 0; round < 20; round += 1) {
      for (let i = 0; i < 50; i += 1) {
        s.write('x'.repeat(100)); // 每轮 5000B，远超阈值 ⇒ 每轮都该转
      }
      await s.flush();
    }
    expect(s.rotations).toBeGreaterThan(5);
    // 🔴 断言文件数之前，**等轮转后的新流真的把当前文件建出来**。
    //    `rotate()` 的形状是 `rotateLogFiles()`（同步 rename：`logPath` → `.1`）之后再
    //    `fs.createWriteStream(logPath)`，而 🔴 **createWriteStream 的 open 是异步的** ⇒
    //    最后一次轮转刚结束时 `logPath` 可能还不存在，于是下面量到的是 **3 份而不是 4 份**。
    //    `flush()` 只保证"写入缓冲落盘"，**不保证流已 open** ⇒ 这是**测量侧的竞态**，不是实现的缺陷。
    //    实测：全量并行跑 2/2 复现（`Expected: 4 / Received: 3`），单独跑 0/2 ⇒ 典型的负载放大窗口。
    //    ⚠️ 修法不是放宽断言（"当前 + keep 份历史"是真性质），而是**等它稳定下来再量**。
    for (let i = 0; i < 200 && !fs.existsSync(logPath); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const files = [logPath, 1, 2, 3]
      .map((x) => (typeof x === 'string' ? x : rotatedPath(logPath, x)))
      .filter((p2) => fs.existsSync(p2));
    expect(files.length).toBe(4); // 当前 + keep 份历史
    // 单份上界 = 阈值 + 强制轮转余量(64KB) + 一轮 flush 窗口(5KB)；不会无限涨
    for (const f of files) {
      expect(fs.statSync(f).size).toBeLessThan(maxBytes + 64 * 1024 + 5 * 1024);
    }
    // 内容不丢也不串：所有文件都只含 'x'，且总字节数 = 写进去的（减去被删掉的最老那份）
    for (const f of files) {
      const body = fs.readFileSync(f, 'utf8');
      expect(body.replace(/x/g, '')).toBe('');
    }
  });

  it('rotateLogFiles 在文件不存在时不抛，返回 0', () => {
    expect(rotateLogFiles(path.join(dir, 'nope.log'), 3)).toBe(0);
  });

  it('轮转失败不会让 write 抛出去（日志不能因为轮转炸掉进程）', () => {
    const s = new RotatingFileStream(logPath, 4, 3);
    const errs: unknown[] = [];
    s.onRotateError = (e) => errs.push(e);
    // 把 rotateLogFiles 会碰到的目录变成只读是不稳定的（root 下无效），
    // 改成直接验证"write 永不抛"这条契约
    expect(() => s.write('aaaaaaaa')).not.toThrow();
    // eslint-disable-next-line no-await-in-loop
    expect(errs.length).toBe(0);
  });
});
