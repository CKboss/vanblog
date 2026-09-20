/**
 * 🔴 集群模式下"恰好一个 Nest 进程承担主实例职责"这件事的守卫。
 *
 * 缺陷背景（2026-09-20 活体实测，同镜像只差 `VANBLOG_CLUSTER_WORKERS` 一个变量的 A/B）：
 * `main.ts` 的进程入口是 `if (clusterWorkers > 1 && cluster.isPrimary) startPrimary() else main()`，
 * 而 `startPrimary()` **不创建 Nest 应用** ⇒ 集群模式下主进程里没有 `InitProvider`，
 * 而每个 worker 的 `cluster.isWorker === true` ⇒ `isPrimaryInstance()` 在**所有** Nest 进程里都是 false。
 * 实测后果：`/var/log/setup.key` 不生成（`/var/log` 本身可写）⇒ `POST /api/admin/init` **500**
 * `setupKeyUnavailable:true`、归档恢复同样失效；`GET /` **502** 且进程表里**没有 next-server**
 * （`WebsiteProvider.doRun()` 第一行就 return）；日志里 `初始化密钥`/`setup.key` **0 命中**、
 * `cluster worker：跳过启动 website` 每 worker 一次。对照的单 worker 栈：setup.key 存在（0600/44B）、
 * init 返回 **400**「请求里没有初始化密钥」（= 机制正常）、`/` **200**、进程表有 `next-server`。
 *
 * 修法是给**恰好一个** worker 打上 `VANBLOG_CLUSTER_ROLE=leader`，并让 `isPrimaryInstance` 认它。
 * ⚠️ 不能简单地"去掉 isPrimaryInstance 判定"：那会让 N 个 worker 各生成一把 setup.key 互相覆盖，
 *    也会让 N 个 worker 各拉起一个前台子进程去抢 3001 端口。
 */
import * as fs from 'fs';
import * as path from 'path';
import { startClusterPrimary, ClusterPrimaryLike } from './clusterBootstrap';
import {
  CLUSTER_ENV,
  CLUSTER_ROLE_ENV,
  CLUSTER_ROLE_LEADER,
  CLUSTER_ROLE_WORKER,
  isPrimaryInstance,
} from './clusterRole';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';

interface FakeWorker {
  id: number;
  env?: NodeJS.ProcessEnv;
  process: { pid?: number; kill: jest.Mock };
}

function makeCluster() {
  const forked: FakeWorker[] = [];
  const listeners: Record<string, ((w: FakeWorker, c: number | null, s: string | null) => void)[]> = {};
  let nextId = 1;
  const cluster = {
    fork: (env?: NodeJS.ProcessEnv) => {
      const worker: FakeWorker = {
        id: nextId++,
        env,
        process: { pid: 10000 + nextId, kill: jest.fn(() => true) },
      };
      forked.push(worker);
      (cluster as any).workers[String(worker.id)] = worker;
      return worker;
    },
    on: (event: string, listener: any) => {
      (listeners[event] = listeners[event] || []).push(listener);
    },
    workers: {} as Record<string, FakeWorker | undefined>,
  } as unknown as ClusterPrimaryLike & { workers: Record<string, FakeWorker | undefined> };
  const emitExit = (worker: FakeWorker, code = 0, signal: string | null = null) => {
    delete (cluster as any).workers[String(worker.id)];
    for (const l of listeners['exit'] || []) l(worker, code, signal);
  };
  return { cluster, forked, emitExit };
}

// ⚠️ 刻意**不**覆盖 setTimeoutFn/clearTimeoutFn：默认实现就是 setTimeout/clearTimeout，
//    在 jest.useFakeTimers() 下可以用 advanceTimersByTime 精确推进"崩溃后 1000ms 重新拉起"。
//    第一版把它们换成了空实现，于是重启定时器永远不触发、leader 接替那条用例假失败。
const noopHooks = () => ({
  log: () => undefined,
  error: () => undefined,
  onSignal: () => undefined, // 别真往 process 上挂信号处理器
  exitFn: () => undefined,
});

describe('集群 leader 选举：恰好一个 Nest 进程承担主实例职责', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('3 个 worker 里恰好 1 个是 leader，其余是 worker', () => {
    const { cluster, forked } = makeCluster();
    const handle = startClusterPrimary(3, cluster, noopHooks());
    const roles = forked.map((w) => w.env?.[CLUSTER_ROLE_ENV]);
    expect(roles.filter((r) => r === CLUSTER_ROLE_LEADER)).toHaveLength(1);
    expect(roles.filter((r) => r === CLUSTER_ROLE_WORKER)).toHaveLength(2);
    expect(handle.leaderId()).toBe(forked[0].id);
  });

  it('单 worker（=1）时那个 worker 就是 leader（不会因为"只有一个"而漏掉一次性启动任务）', () => {
    const { cluster, forked } = makeCluster();
    startClusterPrimary(1, cluster, noopHooks());
    expect(forked).toHaveLength(1);
    expect(forked[0].env?.[CLUSTER_ROLE_ENV]).toBe(CLUSTER_ROLE_LEADER);
    // ⚠️ 且它带的 worker 数仍是 1，scaleLimit 不会被摊薄成 0
    expect(forked[0].env?.[CLUSTER_ENV]).toBe('1');
  });

  it('🔴 leader 崩溃后，重新拉起的 worker **接替** leader（一次性启动任务不会永久失守）', () => {
    const { cluster, forked, emitExit } = makeCluster();
    const handle = startClusterPrimary(2, cluster, noopHooks());
    const originalLeader = forked[0];
    expect(originalLeader.env?.[CLUSTER_ROLE_ENV]).toBe(CLUSTER_ROLE_LEADER);

    emitExit(originalLeader, 1, null);
    expect(handle.leaderId()).toBeNull(); // 已让位
    jest.advanceTimersByTime(2000); // 触发自动重启
    const restarted = forked[forked.length - 1];
    expect(restarted).not.toBe(originalLeader);
    expect(restarted.env?.[CLUSTER_ROLE_ENV]).toBe(CLUSTER_ROLE_LEADER);
    expect(handle.leaderId()).toBe(restarted.id);
    // ⚠️ 仍然只有一个 leader：接替不是"再加一个"
    expect(
      forked.filter((w) => w.env?.[CLUSTER_ROLE_ENV] === CLUSTER_ROLE_LEADER).length,
    ).toBe(2); // 历史上出现过 2 次（原 leader + 接替者），但**同时**只有 1 个
    expect(handle.workerCount()).toBeGreaterThan(0);
  });

  it('🔴 外部注入的 VANBLOG_CLUSTER_ROLE 不能覆盖 fork 时的赋值（否则人人都能把自己变成主实例）', () => {
    // envForWorker 的展开顺序是 {...baseEnv, [CLUSTER_ROLE_ENV]: role} ⇒ 我们的值赢。
    // 这条钉住它：如果将来有人把顺序写反，部署者（或 compose 的 environment）设一个
    // VANBLOG_CLUSTER_ROLE=leader 就会让**每个** worker 都当主实例 ⇒ N 把 setup.key 互相覆盖、
    // N 个前台子进程抢 3001 端口，而症状是"集群模式又坏了"，很难联想到一个环境变量。
    const { cluster, forked } = makeCluster();
    startClusterPrimary(3, cluster, {
      ...noopHooks(),
      env: { EXTRA: 'kept', [CLUSTER_ROLE_ENV]: CLUSTER_ROLE_LEADER } as NodeJS.ProcessEnv,
    });
    const leaders = forked.filter((w) => w.env?.[CLUSTER_ROLE_ENV] === CLUSTER_ROLE_LEADER);
    expect(leaders).toHaveLength(1);
    expect(forked.filter((w) => w.env?.[CLUSTER_ROLE_ENV] === CLUSTER_ROLE_WORKER)).toHaveLength(2);
    // 原有环境仍然要透传（config.yaml 路径、NODE_ENV 等都靠它）
    for (const w of forked) expect(w.env?.EXTRA).toBe('kept');
  });

  it('非 leader 的 worker 崩溃不会让别的 worker 变成 leader（避免两个主实例）', () => {
    const { cluster, forked, emitExit } = makeCluster();
    const handle = startClusterPrimary(3, cluster, noopHooks());
    const leader = forked[0];
    emitExit(forked[2], 1, null); // 死的是普通 worker
    jest.advanceTimersByTime(2000);
    const restarted = forked[forked.length - 1];
    expect(restarted.env?.[CLUSTER_ROLE_ENV]).toBe(CLUSTER_ROLE_WORKER);
    expect(handle.leaderId()).toBe(leader.id);
  });
});

describe('isPrimaryInstance 认 leader 角色', () => {
  const cleanEnv = (extra: NodeJS.ProcessEnv = {}) => ({ ...extra }) as NodeJS.ProcessEnv;

  it('worker 身份 + leader 角色 ⇒ true（这正是集群模式下的主实例）', () => {
    expect(
      isPrimaryInstance({ isPrimary: false, isWorker: true }, cleanEnv({ [CLUSTER_ROLE_ENV]: CLUSTER_ROLE_LEADER })),
    ).toBe(true);
  });

  it('worker 身份 + worker 角色 ⇒ false', () => {
    expect(
      isPrimaryInstance({ isPrimary: false, isWorker: true }, cleanEnv({ [CLUSTER_ROLE_ENV]: CLUSTER_ROLE_WORKER })),
    ).toBe(false);
  });

  it('🔴 角色判定必须排在 isWorker 之前（否则 leader worker 仍被判成非主实例，等于没修）', () => {
    // 这条是"修复本身"的核心：leader 一定同时是 cluster.isWorker===true
    const env = cleanEnv({ [CLUSTER_ROLE_ENV]: CLUSTER_ROLE_LEADER });
    expect(isPrimaryInstance({ isWorker: true, isPrimary: false }, env)).toBe(true);
  });

  it('非集群（角色未设）时行为与以前完全一致：isPrimary ⇒ true，isWorker ⇒ false', () => {
    expect(isPrimaryInstance({ isPrimary: true, isWorker: false }, cleanEnv())).toBe(true);
    expect(isPrimaryInstance({ isPrimary: false, isWorker: true }, cleanEnv())).toBe(false);
    expect(isPrimaryInstance(undefined, cleanEnv())).toBe(true);
  });

  it('角色值大小写/拼写不对时**不**当 leader（失败方向是"不跑一次性任务"而不是"每个进程都跑"）', () => {
    for (const bad of ['Leader', 'LEADER', 'primary', 'main', ' leader', '']) {
      expect(
        isPrimaryInstance({ isPrimary: false, isWorker: true }, cleanEnv({ [CLUSTER_ROLE_ENV]: bad })),
      ).toBe(false);
    }
  });
});

describe('跨文件一致性：所有"只能跑一次"的地方共用同一把尺子', () => {
  // __dirname = packages/server/src/utils ⇒ 退两级到 packages/server
const repoRoot = path.resolve(__dirname, '..', '..');
  const read = (rel: string) => stripCommentsForAnchor(fs.readFileSync(path.join(repoRoot, rel), 'utf-8'));

  it('setup key / restore key / 前台子进程 / waline 都用 isPrimaryInstance(cluster) 判定', () => {
    // ⚠️ 这条守卫的意义：修复是改**一处**判据（isPrimaryInstance），所以所有调用点自动受益。
    //    如果将来有人给某一处换成自己的判定（例如直接写 cluster.isPrimary），那一处会在集群模式下
    //    重新变成"永远不执行"，而**别的测试不会红** —— 所以这里逐个钉住调用形状。
    const targets: [string, string][] = [
      ['src/provider/init/init.provider.ts', 'isPrimaryInstance(cluster)'],
      ['src/provider/website/website.provider.ts', 'isPrimaryInstance(cluster)'],
      ['src/provider/waline/waline.provider.ts', 'isPrimaryInstance(cluster)'],
      ['src/main.ts', 'isPrimaryInstance(cluster)'],
    ];
    for (const [file, needle] of targets) {
      const src = read(file);
      expect({ file, hasGuard: src.includes(needle) }).toEqual({ file, hasGuard: true });
    }
  });

  it('🔴 任何地方都不许直接用 cluster.isPrimary 当"主实例"判据（集群主进程不跑 Nest）', () => {
    // main.ts 的**进程入口**分支是唯一合法例外：它要决定"这个进程是 fork 还是跑 Nest"，
    // 那本来就不是"主实例"语义。除此之外一律不许出现。
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
        const rel = path.relative(repoRoot, full);
        const src = stripCommentsForAnchor(fs.readFileSync(full, 'utf-8'));
        if (!/cluster\.isPrimary/.test(src)) continue;
        // 唯一允许的落点：main.ts 的入口分支（clusterWorkers > 1 && cluster.isPrimary）
        if (rel.endsWith('src/main.ts') && /clusterWorkers > 1 && cluster\.isPrimary/.test(src)) continue;
        offenders.push(rel);
      }
    };
    walk(path.join(repoRoot, 'src'));
    expect(offenders).toEqual([]);
  });

  it('反证：上面两条尺子真的量得到坏形状（不是恒真）', () => {
    // ① 把 isPrimaryInstance(cluster) 换成 cluster.isPrimary 的形状，必须被第二条守卫识别为 offender
    const bad = 'const x = cluster.isPrimary ? 1 : 0;';
    expect(/cluster\.isPrimary/.test(bad)).toBe(true);
    expect(/clusterWorkers > 1 && cluster\.isPrimary/.test(bad)).toBe(false);
    // ② 调用形状尺子对"没有守卫"的源码必须判 false
    expect(stripCommentsForAnchor('const a = 1;').includes('isPrimaryInstance(cluster)')).toBe(false);
    // ③ 剥注释器真的在工作：注释里的形状不该被算进来
    expect(stripCommentsForAnchor('// isPrimaryInstance(cluster)\nconst a = 1;').includes('isPrimaryInstance(cluster)')).toBe(false);
    expect(stripCommentsForAnchor('isPrimaryInstance(cluster);').includes('isPrimaryInstance(cluster)')).toBe(true);
  });
});
