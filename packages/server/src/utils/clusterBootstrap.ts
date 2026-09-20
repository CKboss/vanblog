import {
  CLUSTER_ENV,
  CLUSTER_ROLE_ENV,
  CLUSTER_ROLE_LEADER,
  CLUSTER_ROLE_WORKER,
} from './clusterRole';

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
  /**
   * 当前承担"主实例"职责的 worker id（没有则 null）。
   * 🔴 集群主进程**不跑 Nest**，所以那些"只能跑一次"的启动任务（生成 setup.key /
   * restore.key、拉起前台与 waline 子进程、启动数据清洗、首轮全量渲染、各类 cron）
   * 必须由**恰好一个 worker** 承担 —— 见 clusterRole.ts 里 CLUSTER_ROLE_ENV 的注释。
   * 暴露它只是为了可测与可诊断。
   */
  leaderId(): number | null;
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

  /**
   * 🔴 当前承担"主实例"职责的 worker id。
   * `null` = 还没有 leader ⇒ 下一次 fork 出来的就是 leader。
   * ⚠️ leader 退出时要清回 null，这样重新拉起的那个 worker 会**接替** leader 职责 ——
   *    否则 leader 崩一次，那些一次性启动任务就再也没人跑了（例如前台子进程死了没人重拉）。
   *    重跑是安全的：启动清洗本身是幂等的（main.ts 的注释明写"幂等清洗与索引维护照旧每次启动都跑"），
   *    setup.key 每次重启本来就重新生成（`refreshSetupKey` 在未初始化时无条件 `generateSetupKey`）。
   */
  let leaderWorkerId: number | null = null;

  const envForWorker = (role: string): NodeJS.ProcessEnv => ({
    ...baseEnv,
    // worker 要靠它把内存限流的预算摊薄（否则 N 个进程 = N 倍阈值）
    [CLUSTER_ENV]: String(workers),
    [CLUSTER_ROLE_ENV]: role,
  });

  const forkOne = (): ClusterWorkerLike => {
    // 恰好一个 leader：第一个还没有 leader 时 fork 出来的那个
    const role = leaderWorkerId === null ? CLUSTER_ROLE_LEADER : CLUSTER_ROLE_WORKER;
    const worker = cluster.fork(envForWorker(role));
    if (role === CLUSTER_ROLE_LEADER) leaderWorkerId = worker.id;
    startedAt.set(worker.id, Date.now());
    // 稳定跑过 crashWindowMs 的 worker 退出时会把计数清零（见 'exit' 处理）
    log(
      `已启动 worker #${worker.id}（pid=${worker.process?.pid ?? '?'}，角色=${role}），共 ${workers} 个`,
    );
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
    // 🔴 leader 退出 ⇒ 让位，下一次 fork（自动重启）会接替，一次性启动任务不会永久失守。
    //    ⚠️ 必须放在 `stopping` 早退之前：停机路径上也要保持一致状态。
    if (worker.id === leaderWorkerId) {
      leaderWorkerId = null;
      log(`worker #${worker.id} 是 leader，已让位（下次重新拉起的 worker 会接替主实例职责）`);
    }
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
            // ⚠️ 以前这里是 `exitFn(0)`：worker 是被**强杀**的（可能正卡在备份写盘、
            // 统计 flush 或一轮 ISR 渲染中间），主进程却告诉编排系统"干净退出"。
            // 后果是可观测性归零 —— `docker inspect` 看到 ExitCode 0、k8s 看到 Completed，
            // 没人告警、没人去查那个卡住的 worker，而"优雅停机"这条契约其实已经破了。
            // 现在用 **1**：不用 137（128+SIGKILL）是因为 docker 会把 137 显示成 OOMKilled，
            // 那是完全不同的故障，混在一起会把排查带偏；也不用 143（128+SIGTERM），
            // 因为主进程并不是被信号打死的，是它自己决定放弃等待。
            // ⚠️ 这不会让正常的 `docker stop` / `compose down` 变成"失败退出后被反复拉起"：
            //    ① 所有 worker 在宽限期内退出时走的仍是上面那条 `exitFn(0)`；
            //    ② restart 策略对**显式停止**的容器不生效（docker 的 restart policy 只作用于
            //       非人为停止的退出），所以强杀路径的非 0 只会被记录，不会触发重启风暴。
            const stuck = aliveWorkers().length;
            error(
              `FATAL：${stuck} 个 worker 在 ${shutdownTimeoutMs}ms 内没有退出、已被 SIGKILL，` +
                '主进程以非 0 退出。这不是正常停机：请查这些 worker 卡在什么地方' +
                '（常见：整站备份写盘、浏览统计 flush、一轮 ISR 全量渲染）。' +
                // ⚠️ 这里**不能**写"用 VANBLOG_SHUTDOWN_TIMEOUT_MS 放宽宽限期"——那个环境变量
                //    根本不存在（全仓库只有 main.ts 的一句注释提到它，没有任何代码读它；
                //    实际宽限期是 `startClusterPrimary` 的 hooks.shutdownTimeoutMs ?? 10000，
                //    是代码里的默认值）。第一版就是这么写的，被 utils/envVarMentions.spec.ts
                //    当场抓住：用户可见文案里提到的环境变量名必须真有读取点，
                //    否则运维照着设一个变量、什么也不会发生，还以为是自己的问题。
                `宽限期目前是代码里的默认值（startClusterPrimary 的 shutdownTimeoutMs，${shutdownTimeoutMs}ms），` +
                '要改得改代码或让调用方传入，没有对应的环境变量',
            );
            exitFn(1);
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
    leaderId: () => leaderWorkerId,
  };
}
