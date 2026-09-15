import * as fs from 'fs';

/**
 * 只读日志文件的**尾部**。
 *
 * 为什么需要它：`LogProvider.searchLog()` 以前用 `line-reader` 把整个事件日志
 * **从头到尾**读一遍、每行 `JSON.parse` 一次，就为了取出最近的 `page*pageSize` 条。
 * 日志是只增不减的（每次登录、每次流水线执行都会追加一行），
 * 于是"后台看一眼日志"的代价随运行时间线性上涨：几 MB 的日志 = 几万次 JSON.parse，
 * 全部同步压在事件循环上（line-reader 是流式的，但解析和回调都在主线程）。
 *
 * 这里从文件末尾按块往前读，凑够需要的行数就停：
 *  - 不整份读进内存（每次只多读一个块，且总字节数封顶）；
 *  - 文件不存在时返回空数组，而不是像以前那样让 Promise 永远不 resolve（请求挂死）；
 *  - 被截断的第一行会被丢掉（半行 JSON 解析必然失败）。
 */

export interface TailResult {
  /** 最多 maxLines 行，按文件里的原始顺序（旧 → 新） */
  lines: string[];
  /** true 表示文件比取到的部分更长（前面还有没读的内容） */
  truncated: boolean;
  /** 实际读了多少字节 */
  bytes: number;
}

const NEWLINE = 0x0a;

export async function readLogTailLines(
  filePath: string,
  maxLines: number,
  options: { chunkBytes?: number; maxBytes?: number } = {},
): Promise<TailResult> {
  const chunkBytes = Math.max(1024, options.chunkBytes ?? 64 * 1024);
  const maxBytes = Math.max(chunkBytes, options.maxBytes ?? 8 * 1024 * 1024);
  const empty: TailResult = { lines: [], truncated: false, bytes: 0 };
  if (!filePath || maxLines <= 0) {
    return empty;
  }

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch (err) {
    // 系统日志（/var/log/vanblog-stdio.log）在裸机/开发机上根本不存在。
    // 以前 line-reader 遇到这种情况不会调回调，Promise 永远不 resolve ⇒ 请求一直挂着。
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return empty;
    }
    throw err;
  }

  try {
    const stat = await handle.stat();
    let position = stat.size;
    if (position <= 0) {
      return empty;
    }
    const chunks: Buffer[] = [];
    let newlines = 0;
    let bytes = 0;
    let reachedStart = false;
    while (position > 0) {
      const readSize = Math.min(chunkBytes, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      const res = await handle.read(buf, 0, readSize, position);
      if (res.bytesRead <= 0) {
        // 文件在读的过程中被截断/轮转了，别再往前挪（否则会死循环）
        reachedStart = position === 0;
        break;
      }
      bytes += res.bytesRead;
      chunks.unshift(res.bytesRead === readSize ? buf : buf.subarray(0, res.bytesRead));
      for (let i = 0; i < res.bytesRead; i += 1) {
        if (buf[i] === NEWLINE) newlines += 1;
      }
      if (position === 0) {
        reachedStart = true;
        break;
      }
      if (newlines > maxLines || bytes >= maxBytes) {
        break;
      }
    }

    const lines = Buffer.concat(chunks).toString('utf8').split('\n');
    // 末尾的换行会多切出一个空串
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    // 没读到文件开头 => 第一行很可能是半行，丢掉
    const usable = reachedStart ? lines : lines.slice(1);
    return {
      lines: usable.slice(-maxLines),
      truncated: !reachedStart,
      bytes,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
