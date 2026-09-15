import { CLUSTER_ENV } from './clusterRole';

/**
 * cluster 主进程的编排：fork N 个 worker、worker 挂了重新拉起来、
 * 收到停机信号时**先让 worker 优雅退出再自己退出**。
 *
 * 为什么单独抽出来：`node:cluster` 是个单例，直接写在 `main.ts` 里没法测。
 * 这里只依赖一个"像 cluster 的东西"，于是 fork 几次、什么时候重启、
 * 停机时怎么等 worker、超时之后怎么 SIGKILL，全都能用假对象钉住。
 *
 * ⚠️ 三个必须对的点：
 *  1. **信号不会自动传给 worker**：`docker stop` 的 SIGTERM 只发给 PID 1（主进程），
 *     worker 收不到 ⇒ 浏览统计那批还没落库的增量就丢了。主进程必须显式转发。
 *  2. **停机时不能再重启 worker**：否则主进程一边等退出、一边把刚死的 worker 拉回来，
 *     `docker stop` 会等满宽限期再 SIGKILL（website.provider 以前就栽在同一个坑上）。
 *  3. **worker 崩溃要有界重启**：不能变成"崩溃-重启"死循环刷日志、把 CPU 吃满。
 */

export interface ClusterWorkerLike {
  id: number;
  process: { pid?: number; kill(signal?: string | number): boolean };
}

export interface ClusterPrimaryLike {
  fork(env?: NodeJS.ProcessEnv): ClusterWorkerLike;
  on(
    event: string,
    listener: (worker: ClusterWorkerLike, code: number | null, signal: string | null) => void,
  ): void;
  workers?: Record<string, ClusterWorkerLike | undefined>;
}

export interface TimerHandle {
  unref?: () => void;
}

export interface ClusterPrimaryHooks {
  log?: (message: string) => void;
  error?: (message: string) => void;
  setTimeoutFn?: (cb: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
  /** 注册信号处理器（默认挂在 process 上） */
  onSignal?: (signal: string, handler: () => void) => void;
  /** 所有 worker 都退出之后怎么结束主进程（默认 process.exit） */
  exitFn?: (code: number) => void;
  /** worker 崩溃后多久重新拉起来 */
  restartDelayMs?: number;
  /** 连续快速崩溃多少次之后放弃（配合 crashWindowMs） */
  maxFastCrashes?: number;
  crashWindowMs?: number;
  /** 等 worker 优雅退出的最长时间，超时后 SIGKILL */
  shutdownTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ClusterPrimaryHandle {
  workerCount(): number;
  shuttingDown(): boolean;
  shutdown(reason?: string): Promise<void>;
}

export function startClusterPrimary(
  workers: number,
  cluster: ClusterPrimaryLike,
  hooks: ClusterPrimaryHooks = {},
): ClusterPrimaryHandle {
  const log = hooks.log || (() => undefined);
  const error = hooks.error || (() => undefined);
  const setTimeoutFn = hooks.setTimeoutFn || ((cb, ms) => setTimeout(cb, ms) as unknown as TimerHandle);
  const clearTimeoutFn = hooks.clearTimeoutFn || ((h) => clearTimeout(h as any));
  const exitFn = hooks.exitFn || ((code) => process.exit(code));
  const restartDelayMs = hooks.restartDelayMs ?? 1000;
  const maxFastCrashes = hooks.maxFastCrashes ?? 5;
  const crashWindowMs = hooks.crashWindowMs ?? 10000;
  const shutdownTimeoutMs = hooks.shutdownTimeoutMs ?? 10000;
  const baseEnv = hooks.env || process.env;

  let stopping = false;
  let gaveUp = false;
  const startedAt = new Map<number, number>();
  /**
   * 连续"起来没多久就死"的次数。
   * ⚠️ 必须是**全局**计数而不是按 worker.id：Node 每次 fork 出来的 worker 都是新 id，
   * 按 id 记的话这个上限永远触发不了，崩溃循环会一直刷下去。
   */
  let consecutiveFastCrashes = 0;
  const restartTimers = new Set<TimerHandle>();

  const envForWorker = (): NodeJS.ProcessEnv => ({
    ...baseEnv,
    // worker 要靠它把内存限流的预算摊薄（否则 N 个进程 = N 倍阈值）
    [CLUSTER_ENV]: String(workers),
    VANBLOG_CLUSTER_ROLE: 'worker',
  });

  const forkOne = (): ClusterWorkerLike => {
    const worker = cluster.fork(envForWorker());
    startedAt.set(worker.id, Date.now());
    // 稳定跑过 crashWindowMs 的 worker 退出时会把计数清零（见 'exit' 处理）
    log(`已启动 worker #${worker.id}（pid=${worker.process?.pid ?? '?'}），共 ${workers} 个`);
    return worker;
  };

  const aliveWorkers = (): ClusterWorkerLike[] =>
    Object.values(cluster.workers || {}).filter(Boolean) as ClusterWorkerLike[];

  for (let i = 0; i < workers; i += 1) {
    forkOne();
  }

  cluster.on('exit', (worker, code, signal) => {
    const born = startedAt.get(worker.id);
    startedAt.delete(worker.id);
    if (stopping) {
      log(`worker #${worker.id} 已退出（code=${code} signal=${signal}）`);
      return;
    }
    const uptime = born ? Date.now() - born : crashWindowMs;
    // 起来没多久就死 = 崩溃循环：连续若干次之后放弃，别把机器刷爆
    consecutiveFastCrashes = uptime < crashWindowMs ? consecutiveFastCrashes + 1 : 0;
    if (consecutiveFastCrashes > maxFastCrashes) {
      gaveUp = true;
      error(
        `worker 连续 ${consecutiveFastCrashes} 次在 ${crashWindowMs}ms 内退出，停止自动重启。` +
          '请检查启动日志（端口占用、数据库连不上、构建产物缺失都可能）',
      );
      if (aliveWorkers().length === 0) {
        // 一个 worker 都不剩还赖着不退，容器的 restart 策略就永远不会触发
        error('没有存活的 worker，主进程以非 0 退出，交给容器重启策略处理');
        exitFn(1);
      }
      return;
    }
    log(`worker #${worker.id} 退出（code=${code} signal=${signal}），${restartDelayMs}ms 后重新拉起`);
    const handle = setTimeoutFn(() => {
      restartTimers.delete(handle);
      if (stopping || gaveUp) return;
      forkOne();
    }, restartDelayMs);
    restartTimers.add(handle);
  });

  const killAll = (signal: string) => {
    for (const worker of aliveWorkers()) {
      try {
        worker.process.kill(signal);
      } catch (err) {
        log(`给 worker #${worker.id} 发 ${signal} 失败：${(err as Error)?.message || err}`);
      }
    }
  };

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (reason = 'signal'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    for (const handle of [...restartTimers]) {
      clearTimeoutFn(handle);
    }
    restartTimers.clear();
    log(`主进程收到 ${reason}，通知 ${aliveWorkers().length} 个 worker 优雅退出`);
    // worker 自己会在 SIGTERM 里 flush 浏览统计、关掉 HTTP 服务、停掉子进程
    killAll('SIGTERM');
    shutdownPromise = new Promise<void>((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (aliveWorkers().length === 0) {
          log('所有 worker 已退出，主进程退出');
          exitFn(0);
          resolve();
          return;
        }
        if (Date.now() - started > shutdownTimeoutMs) {
          error(`等待 worker 退出超时（${shutdownTimeoutMs}ms），强制 SIGKILL`);
          killAll('SIGKILL');
          const forceHandle = setTimeoutFn(() => {
            restartTimers.delete(forceHandle);
            exitFn(0);
            resolve();
          }, 300);
          restartTimers.add(forceHandle);
          return;
        }
        const handle = setTimeoutFn(tick, 100);
        restartTimers.add(handle);
      };
      tick();
    });
    return shutdownPromise;
  };

  const onSignal =
    hooks.onSignal ||
    ((signal: string, handler: () => void) => {
      process.on(signal as NodeJS.Signals, handler);
    });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    onSignal(signal, () => void shutdown(signal));
  }

  return {
    workerCount: () => aliveWorkers().length,
    shuttingDown: () => stopping,
    shutdown,
  };
}
