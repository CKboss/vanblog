import * as fs from 'fs';
import * as os from 'os';

/**
 * 多进程（cluster）相关的**纯判定**逻辑。
 *
 * 背景：单进程 Node 是动态请求的实测天花板 —— 一万条连接同时拿 caddy 直服的静态图片
 * 是 **0.8 秒全部 200**，而一万条连接同时打反代到 Node 的 `/api/public/meta`，
 * 30 秒只完成了 1600 个（AGENTS §7.44）。要再往上抬，除了把更多东西挪出 Node，
 * 就只剩"把 Node 变成多进程"这一条路。
 *
 * 但多进程不是"加个 cluster 就完事"：这个项目里有一批**只能跑一次**的东西
 * （每小时的 ISR cron、每日 viewer 结算与统计清理、waline / website 子进程、
 * 启动时那串数据清洗、整站恢复用的 restore.key），还有一批**按进程分摊就变味**的东西
 * （内存限流器、登录防爆破计数、ISR 的 in-flight 互斥量）。
 * 这个文件把"我是不是那个唯一的主进程""预算该除以几"两件事收敛成可单测的纯函数。
 *
 * ⚠️ **代码里的默认值是 `1`（读不到 `VANBLOG_CLUSTER_WORKERS` 时回落），也就是单进程行为；
 * 而镜像（`Dockerfile`）把它设成了 `auto`** ⇒ 🔴 **两个"默认值"是两件不同的事**：
 * 前者是"变量缺失时怎么回落"，后者是"镜像给容器设了什么"。以镜像为准。
 * `auto` 的语义是 🔴 **CPU 与内存两维取小**（见 `resolveClusterWorkers`），
 * 而不是"把核数用满"—— 一台 4 核 / 1 GB 的小机不会因此起 4 个 worker。
 */

export const CLUSTER_ENV = 'VANBLOG_CLUSTER_WORKERS';

/**
 * 🔴 cluster 里"谁是那个唯一的主实例"靠这个环境变量传递，**不是**靠 `cluster.isPrimary`。
 *
 * 为什么不能用 `cluster.isPrimary`：`main.ts` 的进程入口是
 * `if (clusterWorkers > 1 && cluster.isPrimary) startPrimary() else main()`，
 * 而 `startPrimary()` 只做 `initJwt()` + `startClusterPrimary()` —— **它不创建 Nest 应用**。
 * 于是集群模式下：主进程里没有 `InitProvider`（`onModuleInit` 永不执行），
 * 而每个 worker 的 `cluster.isWorker === true` ⇒ `isPrimaryInstance()` 在**所有 Nest 进程里都是 false**。
 * 后果（2026-09-20 活体实测，同镜像只差 `VANBLOG_CLUSTER_WORKERS` 一个变量的 A/B）：
 * `/var/log/setup.key` 不生成 ⇒ `POST /api/admin/init` 与归档恢复都 **500**（灾难恢复完全失效）、
 * `initRestoreKey()` 不跑 ⇒ 忘记密码救不回来、`WebsiteProvider.doRun()` 直接 return ⇒
 * **前台 Next 子进程没人拉起，`/` 与 `/post/*` 全部 502**、waline 不启、7 处启动数据清洗不跑、
 * 首轮全量 ISR 渲染不跑，以及自带同一守卫的 `isr.task`（每小时 ISR cron）、`viewer.task`、
 * `publish.task`、`searchIndex`、`statsMaintenance`、`comment`、reaper、
 * **`fullBackup.provider`（定时整站备份）** 全部跳过。
 *
 * 所以 `clusterBootstrap.ts` 会给**恰好一个** worker 打上 `leader`，由它承担这些"只能跑一次"的活。
 */
export const CLUSTER_ROLE_ENV = 'VANBLOG_CLUSTER_ROLE';
export const CLUSTER_ROLE_LEADER = 'leader';
export const CLUSTER_ROLE_WORKER = 'worker';

/** 硬上限：再多也没意义（Node 的动态请求瓶颈在 CPU，而容器通常只给几个核） */
export const MAX_CLUSTER_WORKERS = 32;

/* ------------------------------------------------------------------------- *
 * 内存这一维：为什么 `auto` 不能只看 CPU
 * ------------------------------------------------------------------------- *
 * 站长 2026-09-24 的原话：「不应该是按 CPU 确认 worker 数嘛？这样会不会默认把机器的内存占满。」
 * 这个担心是对的：`auto` 原先等于 `min(max(1, cpus), 32)`，**完全不看内存**，
 * 而 v2026.9.6 已经把 `auto` 设成**镜像默认值** ⇒ 一台 4 核 / 1 GB 的小机会开箱起 4 个 worker。
 *
 * 🔴 实测依据（2026-09-24，镜像 `vanblog:drill-v2026.9.6`，自建 mongo 的一次性容器，
 * 每档就绪后打几次前台再静置 75 秒取稳态；口径是 cgroup v2 `memory.stat` 的 **`anon`**，
 * 也就是**不可回收**的匿名页 —— ⚠️ **不要用 `podman stats`／`memory.current` 定预算**，
 * 那里面含可回收的 page cache，内存吃紧时内核会先回收它，所以那个口径会**高估** OOM 风险）：
 *
 * | worker 数 | `anon`      |
 * |-----------|-------------|
 * | 1         |  271.8 MiB  |
 * | 2         |  565.0 MiB  |
 * | 4         |  888.1 MiB  |
 * | 6         | 1215.9 MiB  |
 *
 * 斜率：2→6 是 **162.7 MiB/worker**；1→2 那一跳是 293 MiB，🔴 **因为 `workers=1` 时根本没有
 * cluster 主进程**（`main.ts` 的判据是 `clusterWorkers > 1 && cluster.isPrimary`），
 * ≥2 时多出一个 primary ⇒ 所以 base 与 marginal 必须分开建模。
 *
 * ⚠️ **同一个"6 worker"在不同时机测出过 882 / 1216 / 2113 MiB 三个数**（活体运行 40 分钟后 V8
 * 已把堆还给 OS ⇒ 882；刚启动的新栈 ⇒ 1216；上一轮压测中用 `memory.current` 读 ⇒ 2113）。
 * 🔴 **所以下面三个常量取的是"刚启动的新栈"那一档并再加约 18% 余量 —— 保守的那一侧。**
 */

/**
 * 与 worker 数无关的固定开销：`start.js` + caddy + cluster 主进程 + 共享的只读代码页。
 * 实测 1 worker 时 `anon` = 271.8 MiB（那时**没有** primary），取 256 MiB 作为固定项、
 * 把 worker 自身开销全部计入下面的 per-worker 常量。
 */
export const CLUSTER_MEM_BASE_BYTES = 256 * 1024 * 1024;

/**
 * 每多一个 worker 的边际 `anon`。实测斜率 162.7 MiB（2→6 worker），
 * 🔴 这里取 **192 MiB**（比实测高约 18%）作为预算值 —— 宁可少起一个 worker，也不要被 OOM 杀。
 */
export const CLUSTER_MEM_PER_WORKER_BYTES = 192 * 1024 * 1024;

/**
 * 预留给**峰值**的余量：整站备份导出（NDJSON + zstd）、sharp 图片处理、ISR 渲染都会短暂吃内存。
 * 🔴 实测依据：`--memory 768m` 下跑 6 个 worker 时容器**没有**被 OOM 杀
 * （`OOMKilled=false`、`RestartCount=0`、`/` 与 `/admin` 都 200），但它是靠
 * **把 page cache 榨到 4096 字节**活下来的 ⇒ **余量为零，任何一次峰值都可能推过上限**。
 * 所以这一项不是"怕算错"，而是"给峰值留位置"。
 */
export const CLUSTER_MEM_RESERVE_BYTES = 96 * 1024 * 1024;

/**
 * cgroup v1 在"无限制"时 `memory.limit_in_bytes` 不是空值而是一个极大数
 * （内核的 `PAGE_COUNTER_MAX × PAGE_SIZE`，通常 9223372036854771712）。
 * 🔴 不判掉它就会把"无限制"当成"有 8 EiB 内存"——结果一样，但**判掉它才能明确走回落分支**。
 */
const CGROUP_UNLIMITED_THRESHOLD = 2 ** 50; // 1 PiB：真实机器不可能有这么大的容器配额

/** cgroup v2（统一层级）的内存上限文件；内容是字节数，或字面量 `max` 表示无限制 */
export const CGROUP_V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max';
/** cgroup v1 的内存上限文件；⚠️ 无限制时它不是空值而是一个极大数 */
export const CGROUP_V1_MEMORY_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

/**
 * 读文本文件的最小接口。
 * 🔴 **为什么做成可注入而不是在单测里 mock `fs`**：Node 24 的 `fs` 属性**不可重定义**，
 * `jest.spyOn(fs, 'readFileSync')` 会抛 `TypeError: Cannot redefine property: readFileSync`
 * （本仓库 `fullBackup.hardening.spec.ts` 里已经记着同一个坑）。
 * 注入 reader 与本仓库既有的做法一致（`isPrimaryInstance(clusterLike?, env?)`、
 * `startClusterPrimary(workers, cluster, hooks)`），而且**生产路径就是默认参数**，没有额外分支。
 */
export type TextReader = (path: string) => string;

const readTextFile: TextReader = (p) => fs.readFileSync(p, 'utf8');

/**
 * 读**容器配额**（字节）。返回 `null` = 读不到或明确无限制（cgroup v2 写着 `max`）。
 *
 * 🔴 **为什么必须读 cgroup 而不是 `os.totalmem()`**：容器里 `os.totalmem()` 返回的是
 * **宿主机**的总内存。2026-09-24 活体实测：一个 `--memory 768m` 的容器里，
 * `os.totalmem()` = **31.11 GiB**（宿主机值），而 `/sys/fs/cgroup/memory.max` = **805306368**。
 * ⇒ 用 `os.totalmem()` 会在 768 MiB 的容器里算出"内存充足、开满 6 个 worker"，照样把余量吃光。
 *
 * 优先级：cgroup v2 → cgroup v1 → `null`。
 * ⚠️ 本机只有 cgroup v2（`/sys/fs/cgroup/memory/memory.limit_in_bytes` 不存在），
 * 所以 🔴 **v1 那条分支没有活体验证过**，只由单测覆盖（喂真实的 v1 文件内容形状，
 * 包括"无限制时它是个极大数"那一档）。
 */
export function detectCgroupMemoryLimitBytes(read: TextReader = readTextFile): number | null {
  const pick = (path: string): number | null => {
    let raw: string;
    try {
      raw = read(path).trim();
    } catch {
      return null; // 文件不存在 = 不是这一代 cgroup
    }
    if (!raw || raw === 'max') return null; // v2 用 `max` 表示无限制
    const value = Number(raw);
    // 🔴 v1 在"无限制"时给的是 9223372036854775807 这种极大数，必须判掉
    if (!Number.isFinite(value) || value <= 0 || value >= CGROUP_UNLIMITED_THRESHOLD) return null;
    return value;
  };
  return pick(CGROUP_V2_MEMORY_MAX) ?? pick(CGROUP_V1_MEMORY_LIMIT);
}

let cachedBudget: number | undefined;

function computeBudget(read: TextReader, totalmem: () => number): number {
  const fromCgroup = detectCgroupMemoryLimitBytes(read);
  if (fromCgroup !== null) return fromCgroup;
  let total = 0;
  try {
    total = totalmem() || 0;
  } catch {
    total = 0;
  }
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/**
 * 内存预算的最终取值：**容器配额优先，读不到就回落 `os.totalmem()`**。
 *
 * 🔴 **这个回落不是缺陷，两种情况都对**：
 * - **容器且设了配额** ⇒ cgroup 给的就是它真正能用的量（`os.totalmem()` 会说谎，见上）；
 * - **容器没设配额，或裸机/虚拟机直接跑** ⇒ 没有 cgroup 上限这回事，
 *   `os.totalmem()` 就是这台机器真实的内存 ⇒ **回落到的正是正确值**。
 *
 * ⚠️ 唯一不完美的情形是"多个容器共享一台没设配额的宿主机"：那时每个容器都会按整机内存算，
 * 加起来可能超发。🔴 **这是有意的取舍** —— 那种部署本来就该给容器设 `mem_limit`
 * （compose 模板里已经写了怎么设），而在这里猜"别人会用掉多少"只会让单机部署也跟着少起 worker。
 *
 * 不传 `deps` 时带记忆：容器配额在运行期不变，而 `configuredWorkerCount()` 会被 `scaleLimit()`
 * 当默认参数**每次调用都求值** ⇒ 🔴 **绝不能让它每次都读文件**。
 * ⚠️ 实际上 worker 进程读到的是主进程写进 env 的**整数**（`clusterBootstrap.ts` 的
 * `envForWorker` 里 `[CLUSTER_ENV]: String(workers)`），走的是"显式数字"分支、根本不会到这里；
 * 这一层记忆是额外的保险。传了 `deps`（单测）则**不走记忆**，否则用例之间会互相污染。
 */
export function resolveMemoryBudgetBytes(deps?: {
  read?: TextReader;
  totalmem?: () => number;
}): number {
  const read = deps?.read ?? readTextFile;
  const totalmem = deps?.totalmem ?? ((): number => os.totalmem());
  if (deps) return computeBudget(read, totalmem);
  if (cachedBudget === undefined) {
    const resolved = computeBudget(read, totalmem);
    // 0 = 两条路都拿不到 ⇒ 交给 affordableWorkers 走"不裁剪"分支
    cachedBudget = resolved > 0 ? resolved : -1;
  }
  return cachedBudget === -1 ? 0 : cachedBudget;
}

/** 🔴 只给单测用：清掉上面那层记忆（仅影响不传 deps 的生产路径）。 */
export function __resetMemoryBudgetCacheForTest(): void {
  cachedBudget = undefined;
}



/**
 * 给定内存预算，最多养得起几个 worker。返回 **`-1` 表示"不做内存这一维的裁剪"**。
 * 🔴 这是整套内存数学的**唯一**实现（`capWorkersByMemory` 与 `decideClusterWorkers`
 * 都调它），避免"算的是一套、日志说的是另一套"。
 */
export function affordableWorkers(
  limitBytes: number | null | undefined,
  budget: {
    baseBytes?: number;
    perWorkerBytes?: number;
    reserveBytes?: number;
  } = {},
): number {
  const limit = Number(limitBytes);
  if (limitBytes === null || limitBytes === undefined || !Number.isFinite(limit) || limit <= 0) {
    return -1;
  }
  const base = budget.baseBytes ?? CLUSTER_MEM_BASE_BYTES;
  const perWorker = budget.perWorkerBytes ?? CLUSTER_MEM_PER_WORKER_BYTES;
  const reserve = budget.reserveBytes ?? CLUSTER_MEM_RESERVE_BYTES;
  // 每 worker 开销被配成 0/负数时不做除法（否则会得到 Infinity），直接"不裁剪"
  if (!(perWorker > 0)) return -1;
  // 🔴 下界 1：绝不算出 0 个 worker（那等于容器起来什么都不干）
  return Math.max(1, Math.floor((limit - reserve - base) / perWorker));
}

/**
 * 按内存预算裁剪 worker 数（**纯函数**，不做任何 I/O）。
 *
 * `limitBytes` 传 `null`/非正数/NaN 表示"不知道上限" ⇒ **不裁剪**，原样返回 CPU 那一维的结果。
 * 🔴 **宁可维持 CPU 的结论，也不要因为读不到 cgroup 就把人降到 1 个 worker** ——
 * 读不到的常见原因是裸机部署，那种机器本来就没有容器配额这回事。
 */
export function capWorkersByMemory(
  cpuWorkers: number,
  limitBytes: number | null | undefined,
  budget: {
    baseBytes?: number;
    perWorkerBytes?: number;
    reserveBytes?: number;
  } = {},
): number {
  const wanted = Number.isFinite(cpuWorkers) && cpuWorkers > 0 ? Math.floor(cpuWorkers) : 1;
  const allowed = affordableWorkers(limitBytes, budget);
  if (allowed < 0) return wanted;
  return Math.max(1, Math.min(wanted, allowed));
}

/** worker 数是被哪一维定下来的 —— 只为日志与单测服务 */
export type ClusterWorkerBinding = 'fallback' | 'explicit' | 'cpu' | 'memory' | 'memory-unknown';

export interface ClusterWorkerDecision {
  workers: number;
  binding: ClusterWorkerBinding;
  /** CPU 那一维的上限（`min(max(1,cpus), MAX_CLUSTER_WORKERS)`） */
  cpuLimit: number;
  /** 内存预算（字节）。**0 = 两条路都没读到** */
  memoryBudgetBytes: number;
  /** 内存那一维允许几个。**`-1` = 不裁剪** */
  memoryAllows: number;
  baseBytes: number;
  perWorkerBytes: number;
  reserveBytes: number;
}

/**
 * 与 `resolveClusterWorkers` 同一个结论，但**连依据一起返回**，供启动日志使用。
 * 🔴 部署者一眼能看懂"为什么是这个数"，排障时也不用去猜（本项目的日志一直是排障的主要线索）。
 */
export function decideClusterWorkers(
  raw: unknown,
  cpuCount: number,
  memoryBudgetBytes?: number | null,
): ClusterWorkerDecision {
  const cpus = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 1;
  const cpuLimit = Math.min(Math.max(1, cpus), MAX_CLUSTER_WORKERS);
  const budget = {
    baseBytes: CLUSTER_MEM_BASE_BYTES,
    perWorkerBytes: CLUSTER_MEM_PER_WORKER_BYTES,
    reserveBytes: CLUSTER_MEM_RESERVE_BYTES,
  };
  const workers = resolveClusterWorkers(raw, cpuCount, memoryBudgetBytes);
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  const lower = text.toLowerCase();
  const isKeyword = lower === 'max' || lower === 'cpus' || lower === 'auto';

  // 分支一：关键字 ⇒ CPU 与内存两维取小，把依据一起报出来
  if (isKeyword) {
    const resolvedBudget =
      memoryBudgetBytes === undefined ? resolveMemoryBudgetBytes() : memoryBudgetBytes ?? 0;
    const known = Number.isFinite(resolvedBudget) && resolvedBudget > 0;
    const memoryAllows = affordableWorkers(known ? resolvedBudget : null, budget);
    return {
      ...budget,
      workers,
      binding: memoryAllows < 0 ? 'memory-unknown' : workers < cpuLimit ? 'memory' : 'cpu',
      cpuLimit,
      memoryBudgetBytes: known ? resolvedBudget : 0,
      memoryAllows,
    };
  }

  // 分支二：显式正整数 ⇒ 完全尊重部署者的决定，内存这一维不参与
  const parsed = Number(text);
  if (text && Number.isFinite(parsed) && Math.floor(parsed) >= 1) {
    return {
      ...budget,
      workers,
      binding: 'explicit',
      cpuLimit,
      memoryBudgetBytes: 0,
      memoryAllows: -1,
    };
  }

  // 分支三：缺省 / 空串 / 非法 / 0 / 负数 ⇒ 回落到单进程
  return { ...budget, workers, binding: 'fallback', cpuLimit, memoryBudgetBytes: 0, memoryAllows: -1 };
}


const MiB = 1024 * 1024;

/** 把决策渲染成一行启动日志（`decideClusterWorkers` 的展示层，不含任何判定逻辑） */
export function formatClusterWorkerDecision(d: ClusterWorkerDecision): string {
  const budgetText =
    d.memoryBudgetBytes > 0
      ? `内存预算 ${(d.memoryBudgetBytes / MiB).toFixed(0)} MiB` +
        `（固定 ${Math.round(d.baseBytes / MiB)} + 每 worker ${Math.round(d.perWorkerBytes / MiB)}` +
        ` + 峰值预留 ${Math.round(d.reserveBytes / MiB)}）`
      : '内存预算未知（cgroup 与 os.totalmem() 都没读到）';
  if (d.binding === 'fallback') return `workers=1（${CLUSTER_ENV} 缺省或非法，回落单进程）`;
  if (d.binding === 'explicit') return `workers=${d.workers}（${CLUSTER_ENV} 显式指定，不做内存裁剪）`;
  if (d.binding === 'memory-unknown') {
    return `workers=${d.workers}（由 CPU 决定：核数上限 ${d.cpuLimit}；${budgetText} ⇒ 不裁剪）`;
  }
  const why =
    d.binding === 'memory'
      ? `🔴 内存是约束：只养得起 ${d.memoryAllows} 个，少于核数上限 ${d.cpuLimit}`
      : `CPU 是约束：核数上限 ${d.cpuLimit}，内存允许 ${d.memoryAllows} 个`;
  return `workers=${d.workers}（${why}；${budgetText}）`;
}



/**
 * 解析 worker 数量。
 * 缺省 / 非法 / 0 / 负数 一律回落到 **1**（= 单进程行为），
 * `max` / `cpus` / `auto` 表示**按 CPU 核数开、再按内存预算裁一刀**（见下）。
 *
 * 🔴 **第三参 `memoryBudgetBytes` 的三种取值**（这是为了可测性，不是为了灵活）：
 * - **省略（`undefined`）** ⇒ 自己去读（cgroup 优先、回落 `os.totalmem()`）——**生产路径**；
 * - **传数字** ⇒ 用这个值 ——单测喂各种机器形状；
 * - **传 `null`** ⇒ 明确"不做内存这一维"，只按 CPU 算 ——单测里隔离 CPU 维度时用。
 *
 * 🔴 **内存这一维只作用于 `max`/`cpus`/`auto` 这条关键字分支。**
 * 显式写了数字就**完全尊重、不做任何裁剪** —— 那是部署者的明确决定，
 * 程序不该在他背后偷偷改（他可能就是要在小内存机上硬开 4 个）。
 * ⚠️ 这条区分还有一个结构性的好处：`clusterBootstrap.ts` 的 `envForWorker` 会把
 * **解析后的整数**写进每个 worker 的 `VANBLOG_CLUSTER_WORKERS`，
 * 所以 🔴 **worker 进程走的是"显式数字"分支、根本不会去读 cgroup**，
 * `scaleLimit()` 那条"每次调用都求默认参数"的热路径也就没有任何文件 I/O。
 */
export function resolveClusterWorkers(
  raw: unknown,
  cpuCount: number,
  memoryBudgetBytes?: number | null,
): number {
  const cpus = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 1;
  if (raw === undefined || raw === null) return 1;
  const text = String(raw).trim();
  if (!text) return 1;
  const lower = text.toLowerCase();
  if (lower === 'max' || lower === 'cpus' || lower === 'auto') {
    const byCpu = Math.min(Math.max(1, cpus), MAX_CLUSTER_WORKERS);
    const budget =
      memoryBudgetBytes === undefined ? resolveMemoryBudgetBytes() : memoryBudgetBytes;
    return capWorkersByMemory(byCpu, budget);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return 1;
  const value = Math.floor(parsed);
  if (value <= 1) return 1;
  // 🔴 显式数字：不做内存裁剪（见上面的注释）
  return Math.min(value, MAX_CLUSTER_WORKERS);
}


/** 当前进程认为的 worker 总数（主进程与自己 fork 出来的 worker 读到的是同一个值） */
export function configuredWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  return resolveClusterWorkers(env[CLUSTER_ENV], safeCpuCount());
}

function safeCpuCount(): number {
  try {
    return os.cpus()?.length || 1;
  } catch {
    return 1;
  }
}

/**
 * 这个进程是不是"唯一的主实例"。
 *
 * 非 cluster 启动（今天的常态）时 `cluster.isPrimary === true`、`isWorker === false`，
 * 所以返回 true —— 守卫等于不存在，行为一点不变。
 * 传入 clusterLike 只是为了可测（不用去 mock node:cluster 这个单例）。
 *
 * 🔴 **cluster 模式（`VANBLOG_CLUSTER_WORKERS>1`）下判据是 `VANBLOG_CLUSTER_ROLE==='leader'`**，
 * 而不是 `cluster.isPrimary`：主进程不跑 Nest，所以"主实例"只能是某个 worker。
 * `env` 参数默认 `process.env`，显式传入只是为了可测。
 */
export function isPrimaryInstance(
  clusterLike?: {
    isPrimary?: boolean;
    isWorker?: boolean;
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // 🔴 先判 leader 角色：集群模式下"唯一的主实例"是**被标记为 leader 的那个 worker**，
  //    因为 cluster 的主进程根本不跑 Nest（见 CLUSTER_ROLE_ENV 的注释）。
  //    ⚠️ 顺序有讲究：这一条必须在 `isWorker === true` 之前，否则 leader worker 会被判成非主实例。
  if (env && env[CLUSTER_ROLE_ENV] === CLUSTER_ROLE_LEADER) return true;
  if (!clusterLike) return true;
  if (clusterLike.isPrimary === true) return true;
  if (clusterLike.isWorker === true) return false;
  // 老版本 Node（<16）只有 isMaster
  const legacy = (clusterLike as any).isMaster;
  if (legacy === true) return true;
  if (legacy === false) return false;
  return true;
}

/**
 * 内存限流/防爆破计数是**每进程一份**的：N 个 worker 轮流接到同一个 IP 的请求，
 * 每个都只看到 1/N，于是"每分钟 600 次"实际变成了 N×600 次。
 * 这里把每进程的预算按 worker 数摊薄，让**全局**的有效阈值仍然等于配置值。
 *
 * 摊薄是近似的（round-robin 不均匀、连接复用会让某个 worker 多接一些），
 * 但**向下取整**保证 N 份加起来不会超过配置值 —— 偏差方向是"更严"而不是"更松"，
 * 对限流/防爆破来说是安全的那一侧。小阈值会被 `Math.max(1, …)` 兜住，
 * 否则 8 个 worker 摊 3 次登录尝试就成了 0 次，谁都登不进来。
 */
export function scaleLimit(base: number, workers: number = configuredWorkerCount()): number {
  const n = Number.isFinite(workers) && workers > 1 ? Math.floor(workers) : 1;
  const value = Math.floor((Number(base) || 0) / n);
  return Math.max(1, value);
}
