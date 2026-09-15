import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readLogTailLines } from './logTail';

/**
 * 从文件尾部按块往前读。
 * 边界都在这里：块边界正好切在多字节字符中间、末尾换行、文件不存在、
 * 读到 maxLines / maxBytes 上限、以及读的过程中文件被轮转截断。
 */

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-logtail-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const file = (name: string, content: string) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
};

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join('\n') + '\n';

describe('readLogTailLines', () => {
  it('取最后 N 行，顺序与文件里一致（旧 → 新）', async () => {
    const p = file('a.log', lines(10));
    const res = await readLogTailLines(p, 3);
    expect(res.lines).toEqual(['line-8', 'line-9', 'line-10']);
    // 文件比一个块还小 => 整份都读进来了（truncated 说的是"文件还有没读到的部分"）
    expect(res.truncated).toBe(false);
  });

  it('行数少于上限时整个文件都拿到，truncated=false', async () => {
    const p = file('b.log', lines(3));
    const res = await readLogTailLines(p, 100);
    expect(res.lines).toEqual(['line-1', 'line-2', 'line-3']);
    expect(res.truncated).toBe(false);
  });

  it('文件不存在时返回空（以前会让 Promise 永远不 resolve，请求挂死）', async () => {
    const res = await readLogTailLines(path.join(tmp, 'nope.log'), 10);
    expect(res).toEqual({ lines: [], truncated: false, bytes: 0 });
  });

  it('空文件返回空', async () => {
    const p = file('empty.log', '');
    expect((await readLogTailLines(p, 10)).lines).toEqual([]);
  });

  it('没有末尾换行也能拿到最后一行', async () => {
    const p = file('c.log', 'a\nb\nc');
    const res = await readLogTailLines(p, 10);
    expect(res.lines).toEqual(['a', 'b', 'c']);
  });

  it('丢掉被块边界切断的第一行（半行 JSON 解析必然失败）', async () => {
    const p = file('d.log', lines(200, 'x'));
    // 一个块只有 1024 字节，200 行远超一个块
    const res = await readLogTailLines(p, 5, { chunkBytes: 1024 });
    expect(res.lines).toHaveLength(5);
    expect(res.lines[4]).toBe('x-200');
    expect(res.truncated).toBe(true);
    // 每一行都是完整的（不是半行）
    for (const line of res.lines) expect(line).toMatch(/^x-\d+$/);
  });

  it('块边界切在多字节 UTF-8 字符中间也不会乱码', async () => {
    const cjk = '中文日志行'.repeat(40); // 每行 1200 字节
    const content = Array.from({ length: 6 }, (_, i) => `${i}|${cjk}`).join('\n') + '\n';
    const p = file('utf8.log', content);
    const res = await readLogTailLines(p, 2, { chunkBytes: 1024 });
    expect(res.lines).toHaveLength(2);
    expect(res.lines[1]).toBe(`5|${cjk}`);
    expect(res.lines[1]).not.toContain('\uFFFD');
  });

  it('maxBytes 封顶：不会把整个大文件读进内存', async () => {
    const p = file('big.log', lines(20000, 'y'));
    const res = await readLogTailLines(p, 100000, { chunkBytes: 4096, maxBytes: 8192 });
    expect(res.bytes).toBeLessThanOrEqual(8192 + 4096);
    expect(res.truncated).toBe(true);
    expect(res.lines[res.lines.length - 1]).toBe('y-20000');
  });

  it('maxLines<=0 或路径为空时直接返回空', async () => {
    const p = file('e.log', lines(3));
    expect((await readLogTailLines(p, 0)).lines).toEqual([]);
    expect((await readLogTailLines(p, -1)).lines).toEqual([]);
    expect((await readLogTailLines('', 10)).lines).toEqual([]);
  });

  it('空行会被保留成空字符串（由调用方决定怎么跳过），不会被当成文件结束', async () => {
    const p = file('f.log', 'a\n\nb\n\n\nc\n');
    const res = await readLogTailLines(p, 10);
    expect(res.lines).toEqual(['a', '', 'b', '', '', 'c']);
  });

  it('文件读完就停：小文件只读一次', async () => {
    const p = file('g.log', lines(2));
    const res = await readLogTailLines(p, 100, { chunkBytes: 1024 });
    expect(res.bytes).toBe(fs.statSync(p).size);
    expect(res.truncated).toBe(false);
  });
});
