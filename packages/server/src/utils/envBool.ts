/**
 * 环境变量里的布尔值：**非法值一律回落默认，绝不把 undefined 的语义交给调用方猜**。
 *
 * 为什么值得单独一个工具（与 `utils/envNumber.ts` 同理）：仓库里既有
 * `process.env.X === 'true'`（写 `1` 就是关）、也有 `Boolean(process.env.X)`
 * （写 `false` 反而是**开**，因为非空串是 truthy）、还有 `checkTrue()`/`isTrue()`
 * （只认 boolean `true` 与字符串 `'true'`；⚠️ `checkTrue` **曾经**因为 `s == true` 松散比较
 * 而把 `"1"`/`1`/`[1]` 也判成真，与 `isTrue` 结果相反，已统一 —— 见 `utils/checkTrue.ts`）。
 * ⚠️ 注意 `envBool` 与那两个**口径不同且是有意不同**：env 是运维手写的，宽容
 * （`1/true/yes/on` 都算真、非法值回落默认）；请求体与数据库里的值应当严格。
 * 三种口径混在一起时，运维按其中一种写 env 就会得到相反的行为 —— 而备份/恢复这些开关
 * 恰恰是"写错了会删东西"的那一类，不能靠猜。
 *
 * 口径（大小写无关、两侧空白忽略）：
 *  - 真：`1` `true` `yes` `on`
 *  - 假：`0` `false` `no` `off`
 *  - 缺失 / 空串 / 任何其它值 ⇒ `fallback`（也就是"今天的默认行为"）
 */
export const ENV_TRUE_VALUES = ['1', 'true', 'yes', 'on'];
export const ENV_FALSE_VALUES = ['0', 'false', 'no', 'off'];

export function envBool(
  name: string,
  fallback: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const text = String(raw).trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  if (ENV_TRUE_VALUES.includes(text)) {
    return true;
  }
  if (ENV_FALSE_VALUES.includes(text)) {
    return false;
  }
  return fallback;
}

/** 与 `envBool` 同口径，但直接给值（用于把开关传进不读 env 的纯函数） */
export function parseBoolLike(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  if (typeof raw === 'boolean') {
    return raw;
  }
  return envBool('__inline__', fallback, { __inline__: String(raw) } as any);
}
