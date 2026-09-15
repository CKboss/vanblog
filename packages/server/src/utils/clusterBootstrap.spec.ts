import {
  ClusterPrimaryLike,
  ClusterWorkerLike,
  startClusterPrimary,
  TimerHandle,
} from './clusterBootstrap';
import { CLUSTER_ENV } from './clusterRole';

/**
 * cluster 主进程的编排：fork、崩溃重启、停机。
 *
 * 三个必须对的行为（都在改动前不存在，因为根本没有多进程这条路）：
 *  1. **信号不会自动传给 worker**：`docker stop` 的 SIGTERM 只到 PID 1，
 *     worker 收不到 ⇒ 攒在内存里的浏览统计就丢了。主进程必须转发并等它们退出。
 *  2. **停机途中不能再重启 worker**：否则主进程一边等、一边把刚死的 worker 拉回来，
 *     docker 只能等满宽限期再 SIGKILL（website.provider 以前就栽在同一个坑上）。
 *  3. **崩溃重启要有界**：连续秒退若干次之后放弃，并且在一个 worker 都不剩时以非 0 退出，
 *     好让容器的 restart 策略接管。
 */

interface FakeWorker extends ClusterWorkerLike {
  signals: string[];
  env?: NodeJS.ProcessEnv;
}

function createFakeCluster() {
  const workers: Record<string, FakeWorker | undefined> = {};
  const handlers: Record<string, Array<(...args: any[]) => void>> = {};
  const forked: FakeWorker[] = [];
  let nextId = 1;
  const cluster: ClusterPrimaryLike & {
    emitExit: (w: FakeWorker, code?: number | null, signal?: string | null) => void;
  } = {
    workers,
    fork: (env?: NodeJS.ProcessEnv) => {
      const id = nextId++;
      const worker: FakeWorker = {
        id,
        env,
        signals: [],
        process: {
          pid: 10000 + id,
          kill: (signal?: string | number) => {
            worker.signals.push(String(signal));
            return true;
          },
        },
      };
      workers[String(id)] = worker;
      forked.push(worker);
      return worker;
    },
    on: (event, listener) => {
      (handlers[event] = handlers[event] || []).push(listener as any);
    },
    emitExit: (worker, code = 0, signal = null) => {
      delete workers[String(worker.id)];
      for (const cb of handlers['exit'] || []) cb(worker, code, signal);
    },
  };
  return { cluster, forked, workers };
}

function createHooks(options: { env?: NodeJS.ProcessEnv } = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const signals: Record<string, Array<() => void>> = {};
  const hooks = {
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
    exitFn: (code: number) => exits.push(code),
    onSignal: (signal: string, handler: () => void) => {
      (signals[signal] = signals[signal] || []).push(handler);
    },
    env: options.env || { PATH: '/usr/bin', EXTRA: 'kept' },
    restartDelayMs: 1000,
    maxFastCrashes: 3,
    crashWindowMs: 10000,
    shutdownTimeoutMs: 3000,
  };
  return { hooks, logs, errors, exits, signals };
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('startClusterPrimary：fork', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('按数量 fork，并把 worker 数与角色塞进子进程环境', () => {
    const { cluster, forked } = createFakeCluster();
    const { hooks } = createHooks();
    startClusterPrimary(3, cluster, hooks);
    expect(forked).toHaveLength(3);
    for (const worker of forked) {
      expect(worker.env?.[CLUSTER_ENV]).toBe('3');
      expect(worker.env?.VANBLOG_CLUSTER_ROLE).toBe('worker');
      // 原有环境不能丢（config.yaml 路径、NODE_ENV 等都靠它）
      expect(worker.env?.EXTRA).toBe('kept');
    }
  });

  it('注册 SIGTERM / SIGINT / SIGHUP 三个信号', () => {
    const { cluster } = createFakeCluster();
    const { hooks, signals } = createHooks();
    startClusterPrimary(1, cluster, hooks);
    expect(Object.keys(signals).sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
  });
});

describe('startClusterPrimary：worker 崩溃重启', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('意外退出后按延迟重新拉起', async () => {
    const { cluster, forked } = createFakeCluster();
    const { hooks } = createHooks();
    const primary = startClusterPrimary(2, cluster, hooks);
    expect(primary.workerCount()).toBe(2);
    cluster.emitExit(forked[0], 1, null);
    expect(primary.workerCount()).toBe(1);
    jest.advanceTimersByTime(999);
    expect(forked).toHaveLength(2);
    jest.advanceTimersByTime(2);
    expect(forked).toHaveLength(3);
    expect(primary.workerCount()).toBe(2);
  });

  it('连续秒退超过上限就放弃，并在一个 worker 都不剩时以非 0 退出', async () => {
    const { cluster, forked } = createFakeCluster();
    const { hooks, errors, exits } = createHooks();
    startClusterPrimary(1, cluster, hooks);
    // maxFastCrashes = 3：第 4 次秒退就放弃
    for (let i = 0; i < 5; i += 1) {
      const latest = forked[forked.length - 1];
      cluster.emitExit(latest, 1, null);
      jest.advanceTimersByTime(1500);
    }
    expect(errors.join('\n')).toContain('停止自动重启');
    expect(exits).toContain(1);
    // 放弃之后不再 fork
    const count = forked.length;
    jest.advanceTimersByTime(60000);
    expect(forked).toHaveLength(count);
  });

  it('稳定跑过 crashWindow 的退出会把连击计数清零', async () => {
    const { cluster, forked } = createFakeCluster();
    const { hooks, errors, exits } = createHooks();
    startClusterPrimary(1, cluster, hooks);
    for (let i = 0; i < 3; i += 1) {
      cluster.emitExit(forked[forked.length - 1], 0, null);
      jest.advanceTimersByTime(1500);
      // 让它"稳定运行"超过 crashWindowMs，再退出不算连击
      jest.advanceTimersByTime(20000);
    }
    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
    expect(forked.length).toBeGreaterThanOrEqual(4);
  });
});

describe('startClusterPrimary：优雅停机', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('SIGTERM 转发给所有 worker，全部退出后主进程 exit(0)', async () => {
    const { cluster, forked } = createFakeCluster();
    const { hooks, exits, signals } = createHooks();
    const primary = startClusterPrimary(2, cluster, hooks);
    signals.SIGTERM[0]();
    expect(forked[0].signals).toEqual(['SIGTERM']);
    expect(forked[1].signals).toEqual(['SIGTERM']);
    expect(primary.shuttingDown()).toBe(true);
    await flush();
    expect(exits).toEqual([]); // 还有 worker 没退
    cluster.emitExit(forked[0], 0, 'SIGTERM');
    jest.advanceTimersByTime(120);
    expect(exits).toEqual([]);
    cluster.emitExit(forked[1], 0, 'SIGTERM');
    jest.advanceTimersByTime(120);
    await flush();
    expect(exits).toEqual([0]);
  });

  it('停机途中的退出不触发重启（不能一边等一边把 worker 拉回来）', async () => {
    const { cluster, forked } = createFakeCluster();
    const { hooks, signals } = createHooks();
    startClusterPrimary(2, cluster, hooks);
    const before = forked.length;
    signals.SIGTERM[0]();
    // 停机之后才"退出"的 worker：不该被重新拉起
    cluster.emitExit(forked[0], 0, 'SIGTERM');
    jest.advanceTimersByTime(60000);
    await flush();
    expect(forked).toHaveLength(before);
  });

  it('worker 不退就在超时后 SIGKILL，然后主进程退出', async () => {
    const { cluster, forked } = createFakeCluster();
    const { hooks, exits, errors, signals } = createHooks();
    startClusterPrimary(1, cluster, hooks);
    signals.SIGTERM[0]();
    expect(forked[0].signals).toEqual(['SIGTERM']);
    // shutdownTimeoutMs = 3000：超时后升级成 SIGKILL
    jest.advanceTimersByTime(3200);
    await flush();
    expect(forked[0].signals).toContain('SIGKILL');
    expect(errors.join('\n')).toContain('强制 SIGKILL');
    jest.advanceTimersByTime(400);
    await flush();
    // 超时路径不再干等：直接退出，交给容器的 restart 策略
    expect(exits).toEqual([0]);
    void cluster;
  });

  it('shutdown 是幂等的（信号重复到达只走一遍）', async () => {
    const { cluster, forked } = createFakeCluster();
    const { hooks } = createHooks();
    const primary = startClusterPrimary(2, cluster, hooks);
    const first = primary.shutdown('SIGTERM');
    const second = primary.shutdown('SIGTERM');
    expect(first).toBe(second);
    expect(forked[0].signals.filter((s) => s === 'SIGTERM')).toHaveLength(1);
    cluster.emitExit(forked[0], 0, 'SIGTERM');
    cluster.emitExit(forked[1], 0, 'SIGTERM');
    jest.advanceTimersByTime(200);
    await first;
  });
});
