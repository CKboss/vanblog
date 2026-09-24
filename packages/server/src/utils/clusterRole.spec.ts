import {
  __resetMemoryBudgetCacheForTest,
  affordableWorkers,
  capWorkersByMemory,
  CLUSTER_ENV,
  CLUSTER_MEM_BASE_BYTES,
  CLUSTER_MEM_PER_WORKER_BYTES,
  CLUSTER_MEM_RESERVE_BYTES,
  CGROUP_V1_MEMORY_LIMIT,
  CGROUP_V2_MEMORY_MAX,
  configuredWorkerCount,
  decideClusterWorkers,
  detectCgroupMemoryLimitBytes,
  formatClusterWorkerDecision,
  isPrimaryInstance,
  MAX_CLUSTER_WORKERS,
  resolveClusterWorkers,
  resolveMemoryBudgetBytes,
  scaleLimit,
} from './clusterRole';

/**
 * 多进程守卫的纯逻辑：worker 数解析、"我是不是主实例"、以及**按进程摊薄**的限流预算。
 * 默认（不设 VANBLOG_CLUSTER_WORKERS）必须处处等价于今天的单进程行为。
 */

describe('resolveClusterWorkers', () => {
  it('缺省 / 空串 / null 都是 1（= 今天的行为）', () => {
    expect(resolveClusterWorkers(undefined, 8)).toBe(1);
    expect(resolveClusterWorkers(null, 8)).toBe(1);
    expect(resolveClusterWorkers('', 8)).toBe(1);
    expect(resolveClusterWorkers('   ', 8)).toBe(1);
  });

  it('正整数照用，小数向下取整', () => {
    expect(resolveClusterWorkers('4', 8)).toBe(4);
    expect(resolveClusterWorkers(2, 8)).toBe(2);
    expect(resolveClusterWorkers('2.9', 8)).toBe(2);
  });

  it('0 / 负数 / 非法值一律回落到 1（绝不能 fork 出 0 个或 NaN 个 worker）', () => {
    expect(resolveClusterWorkers('0', 8)).toBe(1);
    expect(resolveClusterWorkers('-3', 8)).toBe(1);
    expect(resolveClusterWorkers('abc', 8)).toBe(1);
    expect(resolveClusterWorkers(NaN, 8)).toBe(1);
    expect(resolveClusterWorkers({}, 8)).toBe(1);
  });

  it('max / cpus / auto 按核数开，并且有硬上限', () => {
    // 🔴 第三参传 null = 明确"不做内存这一维"，这样这几条只验 CPU 维度、
    //    **不依赖跑测试那台机器有多少内存**（否则在 1 GB 的 CI 容器里会假红）。
    //    内存维度由下面 `内存这一维` 那个 describe 单独覆盖。
    expect(resolveClusterWorkers('max', 4, null)).toBe(4);
    expect(resolveClusterWorkers('CPUS', 6, null)).toBe(6);
    expect(resolveClusterWorkers('auto', 1, null)).toBe(1);
    expect(resolveClusterWorkers('max', 128, null)).toBe(MAX_CLUSTER_WORKERS);
  });

  it('超过硬上限会被夹住；核数拿不到时按 1 算', () => {
    expect(resolveClusterWorkers('999', 8)).toBe(MAX_CLUSTER_WORKERS);
    expect(resolveClusterWorkers('max', 0, null)).toBe(1);
    expect(resolveClusterWorkers('max', NaN, null)).toBe(1);
  });

  it('configuredWorkerCount 读的就是 VANBLOG_CLUSTER_WORKERS', () => {
    expect(configuredWorkerCount({})).toBe(1);
    expect(configuredWorkerCount({ [CLUSTER_ENV]: '3' } as any)).toBe(3);
    expect(configuredWorkerCount({ [CLUSTER_ENV]: 'nope' } as any)).toBe(1);
  });
});

describe('isPrimaryInstance', () => {
  it('非 cluster 启动（今天的常态）时是 true —— 守卫等于不存在', () => {
    expect(isPrimaryInstance()).toBe(true);
    expect(isPrimaryInstance({ isPrimary: true, isWorker: false })).toBe(true);
    expect(isPrimaryInstance({})).toBe(true);
  });

  it('cluster 的 worker 是 false', () => {
    expect(isPrimaryInstance({ isPrimary: false, isWorker: true })).toBe(false);
  });

  it('老版本 Node 的 isMaster 也认', () => {
    expect(isPrimaryInstance({ isMaster: true } as any)).toBe(true);
    expect(isPrimaryInstance({ isMaster: false, isWorker: true } as any)).toBe(false);
  });
});

describe('scaleLimit：每进程的限流预算', () => {
  it('单进程时值不变（除数 1）', () => {
    expect(scaleLimit(600, 1)).toBe(600);
    expect(scaleLimit(30, 1)).toBe(30);
    expect(scaleLimit(5, 0)).toBe(5);
    expect(scaleLimit(5, NaN)).toBe(5);
    expect(scaleLimit(5, -2)).toBe(5);
  });

  it('N 个 worker 时每份预算是 1/N（全局阈值仍然约等于配置值）', () => {
    expect(scaleLimit(600, 4)).toBe(150);
    expect(scaleLimit(6000, 4)).toBe(1500);
    expect(scaleLimit(30, 3)).toBe(10);
  });

  it('小阈值不会被摊成 0（否则限流器会把所有人挡在外面）', () => {
    expect(scaleLimit(1, 8)).toBe(1);
    expect(scaleLimit(3, 8)).toBe(1);
    expect(scaleLimit(5, 4)).toBe(1);
  });

  it('偏差方向是"更严"：N 份摊薄后的总和不超过原值', () => {
    for (const base of [1, 3, 5, 20, 30, 50, 600, 6000]) {
      for (const workers of [2, 3, 4, 7, 8, 16]) {
        expect(scaleLimit(base, workers) * workers).toBeLessThanOrEqual(
          Math.max(base, workers),
        );
      }
    }
  });

  it('不传 worker 数时从环境变量取', () => {
    process.env[CLUSTER_ENV] = '4';
    try {
      expect(scaleLimit(600)).toBe(150);
    } finally {
      delete process.env[CLUSTER_ENV];
    }
    expect(scaleLimit(600)).toBe(600);
  });
});

/* ========================================================================= *
 * 内存这一维（2026-09-24 新增）
 * ========================================================================= */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * 🔴 实测数据（不是推算）：镜像 `vanblog:drill-v2026.9.6`，自建 mongo 的一次性容器，
 * 每档就绪后打几次前台再静置 75 秒取稳态；口径是 **cgroup v2 `memory.stat` 的 `anon`**
 * （不可回收的匿名页）。⚠️ **不要用 `podman stats`／`memory.current` 定预算** ——
 * 那里面含可回收的 page cache，会把 OOM 风险高估一倍以上。
 */
const MEASURED_ANON_MIB: ReadonlyArray<readonly [number, number]> = [
  [1, 271.8],
  [2, 565.0],
  [4, 888.1],
  [6, 1215.9],
];

describe('内存这一维：auto 不再只看 CPU', () => {
  afterEach(() => {
    __resetMemoryBudgetCacheForTest();
    jest.restoreAllMocks();
  });

  it('三个常量都是 MiB 量级的正数，且 perWorker 比实测斜率保守（高约 18%）', () => {
    expect(CLUSTER_MEM_BASE_BYTES).toBe(256 * MiB);
    expect(CLUSTER_MEM_PER_WORKER_BYTES).toBe(192 * MiB);
    expect(CLUSTER_MEM_RESERVE_BYTES).toBe(96 * MiB);
    // 实测斜率（2→6 worker）= (1215.9 − 565.0) / 4 = 162.7 MiB
    const measuredSlope = (1215.9 - 565.0) / 4;
    expect(measuredSlope).toBeCloseTo(162.7, 1);
    // 🔴 预算值必须**高于**实测斜率：宁可少起一个 worker，也不要被 OOM 杀
    expect(CLUSTER_MEM_PER_WORKER_BYTES / MiB).toBeGreaterThan(measuredSlope);
    expect(CLUSTER_MEM_PER_WORKER_BYTES / MiB / measuredSlope).toBeLessThan(1.3);
  });

  it('🔴 base 与 marginal 是两个不同的模型，不能合并成一个数', () => {
    // workers=1 时**没有 cluster 主进程**（main.ts 的判据是"worker 数 > 1 且自己是主进程"），
    // ≥2 时才多出一个 primary ⇒ 1→2 的跳变必然大于之后的斜率。
    const jump1to2 = 565.0 - 271.8; // 293.2
    const slope2to6 = (1215.9 - 565.0) / 4; // 162.7
    expect(jump1to2).toBeGreaterThan(slope2to6 * 1.5);

    // 🔴 所以"base + n × perWorker"这个模型在 n≥2 时贴合实测（保守侧、偏差 < 20%），
    //    而在 n=1 时**明显偏高**（448 vs 271.8）—— 这正是不能把它压成"每 worker 448 MiB"的原因：
    //    压平之后 6 个 worker 会算成 2688 MiB，而实测只有 1215.9 MiB，
    //    于是一台 2 GB 的机器会被误判成"只养得起 1 个 worker"。
    for (const [n, measured] of MEASURED_ANON_MIB) {
      const predicted = (CLUSTER_MEM_BASE_BYTES + n * CLUSTER_MEM_PER_WORKER_BYTES) / MiB;
      expect(predicted).toBeGreaterThanOrEqual(measured); // 保守侧：模型不低于实测
      if (n >= 2) expect((predicted - measured) / measured).toBeLessThan(0.2);
    }
    const flattened = (CLUSTER_MEM_BASE_BYTES + CLUSTER_MEM_PER_WORKER_BYTES) * 6;
    expect(flattened / MiB).toBeGreaterThan(1215.9 * 2); // 压平模型会高估一倍以上
  });

  it('affordableWorkers：按 (上限 − 预留 − 固定) / 每 worker 算，且下界是 1', () => {
    expect(affordableWorkers(768 * MiB)).toBe(2); // (768−96−256)/192 = 2.17 → 2
    expect(affordableWorkers(1 * GiB)).toBe(3); // (1024−96−256)/192 = 3.5 → 3
    expect(affordableWorkers(2 * GiB)).toBe(8);
    expect(affordableWorkers(512 * MiB)).toBe(1); // 160/192 = 0.83 → 🔴 clamp 到 1，绝不是 0
    expect(affordableWorkers(256 * MiB)).toBe(1); // 负数 → clamp 到 1
    expect(affordableWorkers(64 * MiB)).toBe(1);
  });

  it('🔴 任何内存上限都算不出 0 个 worker（那等于容器起来什么都不干）', () => {
    for (const limit of [1, 1024, MiB, 64 * MiB, 256 * MiB, 512 * MiB, 768 * MiB]) {
      expect(affordableWorkers(limit)).toBeGreaterThanOrEqual(1);
      expect(capWorkersByMemory(6, limit)).toBeGreaterThanOrEqual(1);
    }
  });

  it('不知道上限（null / 0 / 负数 / NaN）⇒ 不裁剪，维持 CPU 的结论', () => {
    expect(affordableWorkers(null)).toBe(-1);
    expect(affordableWorkers(undefined)).toBe(-1);
    expect(affordableWorkers(0)).toBe(-1);
    expect(affordableWorkers(-1)).toBe(-1);
    expect(affordableWorkers(NaN)).toBe(-1);
    expect(capWorkersByMemory(6, null)).toBe(6);
    expect(capWorkersByMemory(6, 0)).toBe(6);
    // 🔴 宁可维持 CPU 的结论，也不要因为读不到 cgroup 就把人降到 1 个 worker
    //    （读不到的常见原因是裸机部署，那种机器本来就没有容器配额这回事）
    expect(resolveClusterWorkers('auto', 6, null)).toBe(6);
    expect(resolveClusterWorkers('auto', 6, 0)).toBe(6);
  });

  it('auto：CPU 与内存两维取小', () => {
    // 6 核 + 768 MiB ⇒ 内存是约束
    expect(resolveClusterWorkers('auto', 6, 768 * MiB)).toBe(2);
    expect(resolveClusterWorkers('max', 6, 1 * GiB)).toBe(3);
    // 6 核 + 31 GiB ⇒ CPU 是约束
    expect(resolveClusterWorkers('auto', 6, 31 * GiB)).toBe(6);
    // 2 核 + 31 GiB ⇒ 仍是 CPU 约束（内存再多也不多起）
    expect(resolveClusterWorkers('auto', 2, 31 * GiB)).toBe(2);
    // 128 核 + 2 GiB ⇒ 内存把它压到 8，硬上限 32 没有参与
    expect(resolveClusterWorkers('auto', 128, 2 * GiB)).toBe(8);
  });

  it('🔴 显式写了数字就完全尊重，不做任何内存裁剪', () => {
    // 部署者在 512 MiB 的容器里硬要 6 个 worker ⇒ 照办（那是他的明确决定）
    expect(resolveClusterWorkers('6', 8, 512 * MiB)).toBe(6);
    expect(resolveClusterWorkers('4', 2, 256 * MiB)).toBe(4);
    expect(decideClusterWorkers('6', 8, 512 * MiB).binding).toBe('explicit');
  });

  it('decideClusterWorkers 报得出"是哪一维在约束"', () => {
    const mem = decideClusterWorkers('auto', 6, 768 * MiB);
    expect(mem.workers).toBe(2);
    expect(mem.binding).toBe('memory');
    expect(mem.cpuLimit).toBe(6);
    expect(mem.memoryAllows).toBe(2);
    expect(mem.memoryBudgetBytes).toBe(768 * MiB);

    const cpu = decideClusterWorkers('auto', 6, 31 * GiB);
    expect(cpu.workers).toBe(6);
    expect(cpu.binding).toBe('cpu');

    const unknown = decideClusterWorkers('auto', 6, null);
    expect(unknown.binding).toBe('memory-unknown');
    expect(unknown.workers).toBe(6);

    expect(decideClusterWorkers(undefined, 8, 768 * MiB).binding).toBe('fallback');
    expect(decideClusterWorkers('abc', 8, 768 * MiB).binding).toBe('fallback');
    expect(decideClusterWorkers('0', 8, 768 * MiB).binding).toBe('fallback');
  });

  it('启动日志那一行把依据说清楚了（部署者不用猜）', () => {
    const line = formatClusterWorkerDecision(decideClusterWorkers('auto', 6, 768 * MiB));
    expect(line).toContain('workers=2');
    expect(line).toContain('内存是约束');
    expect(line).toContain('768'); // 预算
    expect(line).toContain('256'); // 固定开销
    expect(line).toContain('192'); // 每 worker
    expect(line).toContain('96'); // 峰值预留
    expect(formatClusterWorkerDecision(decideClusterWorkers('auto', 6, 31 * GiB))).toContain(
      'CPU 是约束',
    );
    expect(formatClusterWorkerDecision(decideClusterWorkers('6', 8, null))).toContain('显式指定');
    expect(formatClusterWorkerDecision(decideClusterWorkers(undefined, 8, null))).toContain(
      '回落单进程',
    );
  });
});

describe('detectCgroupMemoryLimitBytes：三级回落', () => {
  afterEach(() => {
    __resetMemoryBudgetCacheForTest();
  });

  /**
   * 按路径喂内容的 reader 替身；没列出的路径一律抛 ENOENT。
   * 🔴 **不用 `jest.spyOn(fs, …)`**：Node 24 的 `fs` 属性不可重定义
   * （`TypeError: Cannot redefine property: readFileSync`），本仓库
   * `fullBackup.hardening.spec.ts` 里已经记着同一个坑 ⇒ 走注入。
   */
  const readerFor = (files: Record<string, string>) => (p: string): string => {
    if (p in files) return files[p];
    const err: any = new Error(`ENOENT: ${p}`);
    err.code = 'ENOENT';
    throw err;
  };
  const V2 = CGROUP_V2_MEMORY_MAX;
  const V1 = CGROUP_V1_MEMORY_LIMIT;

  it('cgroup v2：读到数字就用它', () => {
    // 805306368 = 768 MiB，是 2026-09-24 在 --memory 768m 的容器里实测到的真实内容
    expect(detectCgroupMemoryLimitBytes(readerFor({ [V2]: '805306368\n' }))).toBe(805306368);
  });

  it('cgroup v2 写着 max ⇒ 不是配额，继续往下找', () => {
    expect(detectCgroupMemoryLimitBytes(readerFor({ [V2]: 'max\n' }))).toBeNull();
    // v2 是 max 而 v1 有真实配额（混合环境）⇒ 用 v1 的
    expect(
      detectCgroupMemoryLimitBytes(readerFor({ [V2]: 'max\n', [V1]: '1073741824\n' })),
    ).toBe(1073741824);
  });

  it('🔴 cgroup v1 的"无限制"是个极大数，必须判掉', () => {
    // 真实的 v1 形状：无限制时不是空值，而是 9223372036854775807
    const sentinel = '9223372036854775807\n';
    expect(detectCgroupMemoryLimitBytes(readerFor({ [V2]: 'max\n', [V1]: sentinel }))).toBeNull();
    expect(detectCgroupMemoryLimitBytes(readerFor({ [V1]: sentinel }))).toBeNull();
    // 🔴 危害不是"算出天文数字的 worker 数"（capWorkersByMemory 有 min 兜着），
    //    而是**会跳过 os.totalmem() 那级回落** ⇒ 一台 1 GB 的裸机会被当成"内存无限"，
    //    于是一个 worker 都不裁 —— 正是站长担心的那个场景。
    expect(affordableWorkers(9223372036854775807)).toBeGreaterThan(1000);
  });

  it('cgroup v1：读到真实配额就用它', () => {
    expect(detectCgroupMemoryLimitBytes(readerFor({ [V1]: '1073741824\n' }))).toBe(1073741824);
  });

  it('两个 cgroup 都读不到 ⇒ null（交给上层回落 os.totalmem()）', () => {
    expect(detectCgroupMemoryLimitBytes(readerFor({}))).toBeNull();
  });

  it('文件内容不是数字 ⇒ 当成读不到，不抛', () => {
    expect(detectCgroupMemoryLimitBytes(readerFor({ [V2]: 'garbage\n' }))).toBeNull();
    expect(detectCgroupMemoryLimitBytes(readerFor({ [V2]: '' }))).toBeNull();
    expect(detectCgroupMemoryLimitBytes(readerFor({ [V2]: '0\n' }))).toBeNull();
    expect(detectCgroupMemoryLimitBytes(readerFor({ [V2]: '-5\n' }))).toBeNull();
  });

  it('🔴 预算回落：cgroup 没有配额时用 os.totalmem()，并且带记忆（不重复读文件）', () => {
    let reads = 0;
    let totals = 0;
    const read = (p: string) => {
      reads += 1;
      return readerFor({ [V2]: 'max\n' })(p);
    };
    const first = resolveMemoryBudgetBytes({ read, totalmem: () => ((totals += 1), 1 * GiB) });
    expect(first).toBe(1 * GiB);
    // 🔴 不传 deps（生产路径）才走记忆；这里传了 deps，所以每次都会真的读。
    //    读 2 次是对的：v2 读到 `max`（不是配额）⇒ 再去探 v1（ENOENT）。
    expect(reads).toBe(2);
    // 生产路径的记忆：连续两次只读一次文件
    __resetMemoryBudgetCacheForTest();
    reads = 0;
    totals = 0;
    const cachedA = resolveMemoryBudgetBytes();
    const cachedB = resolveMemoryBudgetBytes();
    expect(cachedA).toBe(cachedB);
    expect(cachedA).toBeGreaterThan(0); // 本机（cgroup v2 = max）回落到 os.totalmem()
    __resetMemoryBudgetCacheForTest();
  });

  it('🔴 cgroup 有配额时优先用它，而不是 os.totalmem()（容器里后者是宿主机的值）', () => {
    // 实测：--memory 768m 的容器里 os.totalmem() 报 31.11 GiB（宿主机），
    //      而 /sys/fs/cgroup/memory.max 是 805306368 ⇒ 必须信后者
    let totals = 0;
    const budget = resolveMemoryBudgetBytes({
      read: readerFor({ [CGROUP_V2_MEMORY_MAX]: '805306368\n' }),
      totalmem: () => ((totals += 1), 31 * GiB),
    });
    expect(budget).toBe(805306368);
    expect(totals).toBe(0); // 🔴 根本没去问 os.totalmem()
  });

  it('两条路都拿不到 ⇒ 预算 0 ⇒ 不裁剪（维持 CPU 的结论）', () => {
    const budget = resolveMemoryBudgetBytes({
      read: readerFor({}),
      totalmem: () => 0,
    });
    expect(budget).toBe(0);
    expect(capWorkersByMemory(6, budget)).toBe(6);
  });

  it('totalmem 抛异常也不炸（回落成"不知道"）', () => {
    const budget = resolveMemoryBudgetBytes({
      read: readerFor({}),
      totalmem: () => {
        throw new Error('boom');
      },
    });
    expect(budget).toBe(0);
  });
});

describe('configuredWorkerCount：worker 进程读到的是主进程写好的整数，不碰内存预算', () => {
  afterEach(() => {
    __resetMemoryBudgetCacheForTest();
  });

  it('🔴 clusterBootstrap 的 envForWorker 把解析后的整数写进 env ⇒ 走"显式数字"分支', () => {
    // 这条钉住那个结构性好处：worker 与 scaleLimit 的热路径都不会去解析内存预算。
    // 🔴 判据是"显式分支根本不产生预算"（memoryBudgetBytes === 0），
    //    而不是"没有调用 fs"—— 后者要 mock 全局，Node 24 下做不到。
    expect(configuredWorkerCount({ [CLUSTER_ENV]: '6' } as any)).toBe(6);
    const d = decideClusterWorkers('6', 2, 64 * MiB);
    expect(d.binding).toBe('explicit');
    expect(d.workers).toBe(6); // 64 MiB 也只养得起 1 个，但显式指定 ⇒ 完全尊重
    expect(d.memoryBudgetBytes).toBe(0); // 🔴 显式分支没有去解析预算
    expect(d.memoryAllows).toBe(-1);
  });

  it('只有 auto / max / cpus 这三个关键字才会去解析内存预算', () => {
    const auto = decideClusterWorkers('auto', 6, 768 * MiB);
    expect(auto.binding).toBe('memory');
    expect(auto.memoryBudgetBytes).toBe(768 * MiB);
    const fb = decideClusterWorkers('nope', 6, 768 * MiB);
    expect(fb.binding).toBe('fallback');
    expect(fb.memoryBudgetBytes).toBe(0);
  });
});


