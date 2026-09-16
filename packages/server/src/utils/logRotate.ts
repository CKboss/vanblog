import * as fs from 'fs';
import * as path from 'path';
import { envPositiveInt } from './envNumber';

/**
 * 事件日志的大小轮转。
 *
 * 为什么需要它：`LogProvider` 用 pino 的 multistream 往 `vanblog-event.log` 里**追加**，
 * 而且是一个长开的 `a+` 流 —— 也就是这个文件**只增不减**。跑得久了它会吃掉整块磁盘，
 * 而磁盘满的表现是"备份写不出来、图片存不进去、mongod 变只读"，排查起来完全看不出根因。
 * `logTail.ts` 只限界了**读**（后台翻日志不会因为文件大而卡死），没限界**写**。
 *
 * 设计取舍：
 *  - 按**大小**轮转而不是按天：博客的日志量与流量成正比，按天轮转在流量大的站上一天就能写爆，
 *    而在几乎没人访问的站上又会留下一堆几乎空的文件。
 *  - 轮转是**同步**的（closeSync → renameSync → 重新 createWriteStream）：pino 的写入本身是同步的，
 *    异步轮转会有一个"旧流已关、新流未开"的窗口，那个窗口里的日志会丢。同步做的代价是
 *    一次 rename（微秒级），可以接受。
 *  - 保留 K 份历史（`<name>.1` … `<name>.K`），最老的直接删。总数上界 = (K+1) × maxBytes。
 */
export const EVENT_LOG_MAX_BYTES =
  envPositiveInt('VANBLOG_EVENT_LOG_MAX_MB', 20, 1, 10240) * 1024 * 1024;
export const EVENT_LOG_KEEP = envPositiveInt('VANBLOG_EVENT_LOG_KEEP', 3, 1, 100);
/**
 * 超过阈值这么多就"哪怕还有写入在飞也强制轮转"，防止日志密集时轮转被无限推迟。
 * 64 KB 相对 20 MB 的默认阈值是 0.3%，历史文件因此最多大这么一点。
 */
const ROTATE_SLACK_BYTES = 64 * 1024;

/** 轮转后第 i 份历史文件的路径（i 从 1 开始：`.1` 是最近的一份） */
export function rotatedPath(logPath: string, i: number): string {
  return `${logPath}.${i}`;
}

/**
 * 把 `<logPath>` 轮转掉：`.K` 删除、`.K-1`→`.K` … `.1`→`.2`、当前文件→`.1`。
 * 返回实际改名的份数（测试用）。任何一步失败都不抛 —— 日志轮转不该成为可用性风险，
 * 但要把错误交给调用方记一条（返回 null 表示失败）。
 */
export function rotateLogFiles(logPath: string, keep: number): number | null {
  try {
    const k = Math.max(1, Math.floor(keep));
    // 最老的一份先删（否则 rename 会撞上已存在的目标；POSIX 的 rename 会覆盖，
    // 但显式删掉更容易推理，也避免 Windows 语义差异）
    const oldest = rotatedPath(logPath, k);
    if (fs.existsSync(oldest)) {
      fs.rmSync(oldest, { force: true });
    }
    let moved = 0;
    for (let i = k - 1; i >= 1; i -= 1) {
      const from = rotatedPath(logPath, i);
      if (fs.existsSync(from)) {
        fs.renameSync(from, rotatedPath(logPath, i + 1));
        moved += 1;
      }
    }
    if (fs.existsSync(logPath)) {
      fs.renameSync(logPath, rotatedPath(logPath, 1));
      moved += 1;
    }
    return moved;
  } catch {
    return null;
  }
}

/**
 * pino.multistream 只要求目标对象有 `write(chunk)`，所以不必继承 stream ——
 * 这也让它可以被单测直接驱动（喂字符串、断言文件被轮转）。
 *
 * ⚠️ 字节数是**自己累加**的，不是每次 `statSync`：这个 write 在每条事件日志上都会跑，
 * 加一次系统调用等于给所有日志写入加税。启动时读一次现有大小作为初值（进程重启不会
 * 让计数从 0 开始，否则一个反复重启的进程永远轮转不了）。
 */
export class RotatingFileStream {
  private stream: fs.WriteStream;
  private bytes: number;
  private readonly maxBytes: number;
  private readonly keep: number;
  /** 底层流是否已经真的打开了文件（createWriteStream 是异步打开的） */
  private opened = false;
  /** 还没落盘的写入数（用 write 的回调计数） */
  private pending = 0;
  /** 已过阈值、但还不能安全轮转（流没开或还有写入在飞），等下一次机会 */
  private rotatePending = false;
  private rotating = false;
  /** 轮转过多少次（测试与排障用） */
  rotations = 0;
  /** 轮转失败时把原因交给调用方打日志（不能在 write 里抛，pino 会炸） */
  onRotateError?: (err: unknown) => void;

  constructor(
    readonly logPath: string,
    maxBytes: number = EVENT_LOG_MAX_BYTES,
    keep: number = EVENT_LOG_KEEP,
  ) {
    this.maxBytes = maxBytes > 0 ? maxBytes : EVENT_LOG_MAX_BYTES;
    this.keep = keep > 0 ? keep : EVENT_LOG_KEEP;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.bytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    this.openStream();
  }

  private openStream(): void {
    this.opened = false;
    this.stream = fs.createWriteStream(this.logPath, { flags: 'a+' });
    this.stream.once('open', () => {
      this.opened = true;
      this.maybeRotate();
    });
    this.stream.once('error', (err) => this.onRotateError?.(err));
  }

  /** pino 调用的入口。返回 false 表示"内部缓冲满了"，pino 会自己处理背压 */
  write(chunk: unknown): boolean {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    this.pending += 1;
    let ok = true;
    try {
      ok = this.stream.write(text, () => {
        this.pending = Math.max(0, this.pending - 1);
        this.maybeRotate();
      });
    } catch (err) {
      this.pending = Math.max(0, this.pending - 1);
      this.onRotateError?.(err);
    }
    this.bytes += Buffer.byteLength(text);
    if (this.bytes >= this.maxBytes) {
      this.rotatePending = true;
    }
    this.maybeRotate();
    return ok;
  }

  /**
   * ⚠️ 轮转必须等到**文件真的存在且缓冲已落盘**才能做，否则会白转一次：
   * `createWriteStream` 是异步打开文件的，如果在"流还没 open"时就 `renameSync`，
   * 那时原路径上根本没有文件可改名，随后旧流的写入会落进**新**文件里 ——
   * 历史文件是空的、当前文件混着两轮内容。而"进程重启时日志已超阈值、
   * 第一条写入就触发轮转"恰恰是现实场景（初值是从 `statSync` 读的）。
   * 所以这里改成"标记 + 在安全点执行"：流已 open 且没有在飞的写入时才真的动手，
   * 代价是最多多写几 KB 才轮转，可以接受。
   */
  private maybeRotate(): void {
    if (!this.rotatePending || this.rotating || !this.opened) {
      return;
    }
    // 正常情况下等"没有在飞的写入"再转（这样历史文件的内容是完整的一轮）。
    // ⚠️ 但不能**只**等这个条件：日志密集时 pending 可能永远不为 0，轮转就会被无限推迟，
    // 文件照样涨到几个 G。所以超过阈值一定余量就强制轮转 —— 代价是那几条在飞的写入
    // 会落进历史文件（不丢、不串，只是历史文件比 maxBytes 大一点点）。
    const overshoot = this.bytes - this.maxBytes;
    if (this.pending > 0 && overshoot < ROTATE_SLACK_BYTES) {
      return;
    }
    this.rotatePending = false;
    this.rotate();
  }

  /**
   * 等底层流把缓冲真的写进文件。
   *
   * ⚠️ `fs.createWriteStream` 的 `write()` 是**异步**的：调用返回时数据可能还在 JS 侧的缓冲里。
   * 所以"写完立刻读文件"在测试里会读到 null，在生产里则是"优雅停机前没 flush ⇒ 丢最后几条事件日志"。
   * 实现方式是发一个 0 字节写并等它的回调 —— fs 流会把回调排在之前所有写入之后。
   */
  async flush(): Promise<void> {
    await new Promise<void>((resolve) => {
      try {
        this.stream.write('', () => resolve());
      } catch {
        resolve();
      }
    });
    // flush 之后可能刚好满足了轮转条件（回调里会触发），再让出一次事件循环让它执行完
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** 关掉底层流（优雅停机用）。先 flush，否则最后几条会丢。 */
  async close(): Promise<void> {
    await this.flush();
    await new Promise<void>((resolve) => {
      try {
        this.stream.end(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private rotate(): void {
    this.rotating = true;
    try {
      // 先关掉旧流再改名：不关的话旧流的 fd 会继续指向被改名后的 inode。
      // `end()` 是异步的，但它会把已缓冲的写入刷到**同一个 fd**，而 fd 跟着 inode 走、
      // 不跟着路径走 ⇒ 那些字节仍然落在改名后的 `.1` 里（而且此时 pending 已为 0，没有待写数据）。
      this.stream.end();
      const moved = rotateLogFiles(this.logPath, this.keep);
      if (moved === null) {
        this.onRotateError?.(new Error('rotateLogFiles 返回 null'));
      }
      this.bytes = 0;
      this.rotations += 1;
      this.openStream();
    } catch (err) {
      // 轮转失败也要保证日志还能写：重新打开原路径，字节数清零（下一次到阈值再试）
      try {
        this.openStream();
      } catch {
        // 连重开都失败就没救了，交给 pino 的其它 stream（stdout）
      }
      this.bytes = 0;
      this.onRotateError?.(err);
    } finally {
      this.rotating = false;
    }
  }
}
