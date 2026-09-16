/**
 * 环境变量里的数字：**非法值一律回落默认，绝不把 NaN 交出去**。
 *
 * 为什么值得单独一个工具：仓库里 `Number(process.env.X || 30000)` 这种写法有好几处，
 * 而它对"写错的 env"有两种静默失败，都不会报错、只会让功能悄悄变味：
 *
 *  1. `Number('30s')` / `Number('abc')` = **NaN**。
 *     - 交给 axios 的 `timeout`：NaN 是 falsy ⇒ 等于**没有超时**
 *       （正是 `getNetIp` 当初要修的 bug：离线时一次登录卡几十秒）；
 *     - 交给 `setTimeout`：NaN ⇒ Node 当成 1ms ⇒ 流水线刚起来就被"超时"杀掉，
 *       报错信息里还印着 `超过 NaNs 未返回结果`；
 *     - 交给 Mongo 驱动 / 比较运算：结果不可预测。
 *  2. `Number('0')` 与 `'' || 30000` 这类"看起来设了其实没设"的值混在一起，
 *     读代码的人分不清 0 是"关掉"还是"没配"。
 *
 * 这个 helper 的语义与 `utils/rateLimit.ts` 的 `envInt` 一致（那份是限流专用的历史实现，
 * 行为相同、只是多了 min/max 的默认值），新增的地方统一用它：
 *  - 缺失 / 空串 / 非数字 / NaN / Infinity / ≤0 ⇒ `fallback`；
 *  - 合法值夹到 `[min, max]` 再向下取整。
 */
export function envPositiveInt(
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  const clamped = Math.min(Math.max(n, min), max);
  return Number.isFinite(clamped) ? Math.floor(clamped) : fallback;
}
