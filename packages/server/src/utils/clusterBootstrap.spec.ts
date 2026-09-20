import {
  ClusterPrimaryLike,
  ClusterWorkerLike,
  startClusterPrimary,
  TimerHandle,
} from './clusterBootstrap';
import { CLUSTER_ENV, CLUSTER_ROLE_ENV, CLUSTER_ROLE_LEADER, CLUSTER_ROLE_WORKER} from './clusterRole';

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

  it('按数量 fork，并把 worker 数与角色塞进子进程环境（🔴 恰好一个 leader）', () => {
    const { cluster, forked } = createFakeCluster();
    const { hooks } = createHooks();
    startClusterPrimary(3, cluster, hooks);
    expect(forked).toHaveLength(3);
    // 🔴 这条断言在 2026-09-20 之前是「每个 worker 的角色都是 'worker'」，而那正是缺陷本身：
    //    集群主进程不跑 Nest（main.ts 的入口分支只调 startPrimary()），所以如果**没有任何** worker
    //    被标成 leader，`isPrimaryInstance()` 在所有 Nest 进程里都是 false ⇒ 那些"只能跑一次"的
    //    启动任务没有任何进程会执行（活体实测：setup.key 不生成 ⇒ 初始化与归档恢复都 500；
    //    WebsiteProvider.doRun() 直接 return ⇒ 前台 Next 子进程没人拉起，`/` 与 `/post/*` 全 502）。
    //    ⇒ 断言升级为「**恰好一个** leader，其余是 worker」，这才是设计意图（避免 N 个 worker
    //    各生成一把密钥互相覆盖），同时保证集群模式下真的有一个 Nest 侧的主实例。
    const leaders = forked.filter((w) => w.env?.[CLUSTER_ROLE_ENV] === CLUSTER_ROLE_LEADER);
    const workers = forked.filter((w) => w.env?.[CLUSTER_ROLE_ENV] === CLUSTER_ROLE_WORKER);
    expect(leaders).toHaveLength(1);
    expect(workers).toHaveLength(2);
    // leader 必须是**第一个** fork 出来的（确定性，便于排查）
    expect(leaders[0]).toBe(forked[0]);
    for (const worker of forked) {
      expect(worker.env?.[CLUSTER_ENV]).toBe('3');
      // 角色只能是这两个值之一（防拼写漂移成 'Leader'/'primary' 这种没人认的形状）
      expect([CLUSTER_ROLE_LEADER, CLUSTER_ROLE_WORKER]).toContain(
        worker.env?.[CLUSTER_ROLE_ENV],
      );
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

  it('worker 不退就在超时后 SIGKILL，然后主进程**以非 0 退出**（强杀不是干净停机）', async () => {
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
    // ⚠️ 以前这里断言的是 `[0]`：worker 被强杀了，主进程却报"干净退出"，
    //    编排系统（docker inspect 的 ExitCode / k8s 的 Completed）看不出任何异常。
    //    现在必须是**非 0**，并且日志里要有 FATAL 与卡住的 worker 数。
    expect(exits).toHaveLength(1);
    expect(exits[0]).not.toBe(0);
    expect(exits[0]).toBe(1);
    // 不用 137：docker 会把 137 显示成 OOMKilled，那是另一种故障，会带偏排查
    expect(exits[0]).not.toBe(137);
    const joined = errors.join('\n');
    expect(joined).toContain('FATAL');
    expect(joined).toContain('SIGKILL');
    // ⚠️ 消息里必须说清"卡住的 worker 数"与"宽限期是多少"，否则运维只看到一句 FATAL；
    //    但**不许**指向一个不存在的环境变量 —— 第一版写了 VANBLOG_SHUTDOWN_TIMEOUT_MS，
    //    而那个变量全仓库没有任何读取点（实际是 hooks.shutdownTimeoutMs ?? 10000），
    //    被 utils/envVarMentions.spec.ts 抓住。照着设一个没人读的变量 = 运维白忙一场。
    expect(joined).toContain('1 个 worker');
    expect(joined).toContain('3000ms');
    expect(joined).toContain('shutdownTimeoutMs');
    expect(joined).not.toContain('VANBLOG_SHUTDOWN_TIMEOUT_MS');
    // 空转反证：上面那条"不存在"的断言确实能命中旧写法（否则它是恒真的）
    expect('或用 VANBLOG_SHUTDOWN_TIMEOUT_MS 放宽宽限期').toContain(
      'VANBLOG_SHUTDOWN_TIMEOUT_MS',
    );
    void cluster;
  });

  it('反证：正常停机（所有 worker 在宽限期内退出）仍然 exit(0)，不能被上面那条带歪', async () => {
    // ⚠️ 这条是"非 0 退出"改动的**负向对照**：如果哪天有人把所有退出路径都改成非 0，
    //    `docker stop` / `compose down` 就会被记成失败退出 —— 那比原来的问题更吵。
    const { cluster, forked } = createFakeCluster();
    const { hooks, exits, errors, signals } = createHooks();
    startClusterPrimary(2, cluster, hooks);
    signals.SIGTERM[0]();
    cluster.emitExit(forked[0], 0, 'SIGTERM');
    cluster.emitExit(forked[1], 0, 'SIGTERM');
    jest.advanceTimersByTime(200);
    await flush();
    expect(exits).toEqual([0]);
    expect(errors.join('\n')).not.toContain('FATAL');
    expect(errors.join('\n')).not.toContain('强制 SIGKILL');
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
