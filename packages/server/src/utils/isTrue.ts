/**
 * 严格布尔判定：**只认** boolean `true` 与字符串 `'true'`，其余一律 `false`。
 *
 * ## 为什么"严格"是对的方向
 * 本仓库曾经并存五套布尔口径（`process.env.X === 'true'`、`Boolean(process.env.X)`、
 * `checkTrue()`、`isTrue()`、`envBool()`），其中 `checkTrue()` 与 `isTrue()` 在
 * `"1"` / `1` / `[1]` 三个输入上**结果相反** —— 因为 `checkTrue` 用了 `s == true` 松散比较
 * （`"1" == true` ⇒ `Number("1") == Number(true)` ⇒ `1 == 1` ⇒ true）。
 * 后果不是学术问题：`checkTrue` 正是**破坏性整站恢复的确认闸门**
 * （`controller/admin/backup/backup.controller.ts`），于是 `confirm:"1"`、`confirm:1`、
 * `confirm:[1]` 都算"站长已确认"。确认闸门的语义应当是**最严**的那一个，它当时反而是最松的。
 *
 * ## 口径（写死在这里，别再派生第六套）
 *  - 真：boolean `true`、字符串 `'true'`（**区分大小写**，`'TRUE'`/`'True'` 都算假）
 *  - 假：其它一切 —— `false`、`'false'`、`'1'`、`1`、`'yes'`、`'on'`、`''`、
 *    `undefined`、`null`、数组、对象
 *  ⚠️ 大小写敏感是**有意**的：这个函数同时服务"破坏性操作的确认闸门"，
 *  闸门只应当接受一种拼写；宽松匹配会把"我的确认到底算不算"变成开放问题。
 *  仓库内所有真实调用方送的都是 boolean 或字面 `'true'`（已逐个核实：admin 送
 *  `confirm:'true'`、`withWaterMark=true`、`form.append('withWaterMark','true')`；
 *  `vanblog.sh` 送 `-F "confirm=true"` 与 `{"confirm":"true"}`；设置项在 DTO 里是 `boolean`），
 *  所以严格化不改变任何既有行为。
 *
 * ⚠️ **环境变量的口径不是这个**：env 用 `utils/envBool.ts`（认 `1/true/yes/on`，
 *  非法值回落默认）。两者服务不同来源，不要互相替换 —— 请求体/数据库里的值应当严格，
 *  运维手写的 env 可以宽容。
 *
 * @param v 运行时的任意值（声明成 `unknown` 是诚实的：调用方拿到的是 `any` 形状的
 *          请求体与 mongoose 文档，类型系统在这儿给不了任何保证）
 */
export function isTrue(v: unknown): boolean {
  if (typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'string') {
    return v === 'true';
  }
  return false;
}
