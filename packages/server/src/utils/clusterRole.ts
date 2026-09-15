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
 * ⚠️ 默认 `VANBLOG_CLUSTER_WORKERS=1`，也就是**今天的行为**：
 * 单进程里 `cluster.isPrimary === true`，所有守卫都放行，一处语义都不变。
 */

export const CLUSTER_ENV = 'VANBLOG_CLUSTER_WORKERS';

/** 硬上限：再多也没意义（Node 的动态请求瓶颈在 CPU，而容器通常只给几个核） */
export const MAX_CLUSTER_WORKERS = 32;

/**
 * 解析 worker 数量。
 * 缺省 / 非法 / 0 / 负数 一律回落到 **1**（= 今天的单进程行为），
 * `max` / `cpus` / `auto` 表示按 CPU 核数开。
 */
export function resolveClusterWorkers(raw: unknown, cpuCount: number): number {
  const cpus = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 1;
  if (raw === undefined || raw === null) return 1;
  const text = String(raw).trim();
  if (!text) return 1;
  const lower = text.toLowerCase();
  if (lower === 'max' || lower === 'cpus' || lower === 'auto') {
    return Math.min(Math.max(1, cpus), MAX_CLUSTER_WORKERS);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return 1;
  const value = Math.floor(parsed);
  if (value <= 1) return 1;
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
 */
export function isPrimaryInstance(clusterLike?: {
  isPrimary?: boolean;
  isWorker?: boolean;
}): boolean {
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
