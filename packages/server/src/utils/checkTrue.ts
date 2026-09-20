import { isTrue } from './isTrue';

/**
 * @deprecated 请直接使用 `utils/isTrue.ts`。
 *
 * 保留这个别名只是为了不打断既有调用点（15 处），语义已与 `isTrue` **完全一致**：
 * 只认 boolean `true` 与字符串 `'true'`。
 *
 * ⚠️ **本函数以前的语义是错的，已修**：旧实现是
 * `if (!s) return false; if (s == 'true') return true; if (s == true) return true; return false;`
 * 其中 `s == true` 是松散比较 ⇒ `"1"`、`1`、`[1]` 都判**真**，与 `isTrue` 结果相反。
 * 而本函数正是**破坏性整站恢复的确认闸门**（`backup.controller.ts` 的 `confirm`）用的那个，
 * 于是"确认"这道闸当时是全仓库**最松**的布尔判定。
 *
 * 迁移前逐个核实过 15 个调用点，**没有一个依赖 `"1"`/`1` 判真**：
 *  - `provider/static/static.provider.ts` 8 处读的是 DB 设置项，DTO 里声明为 `boolean`
 *    （`types/setting.dto.ts`：`enableWaterMark`/`enableWebp`/`enableResize`/`enableThumb`/
 *    `enableStegoWaterMark`）；
 *  - `controller/admin/article/article.controller.ts` 与 `controller/admin/img/img.controller.ts`
 *    共 4 处读 `withWaterMark`/`force`，admin 侧送的是 `?withWaterMark=true` 与
 *    `form.append('withWaterMark','true')`；
 *  - `controller/admin/backup/backup.controller.ts` 3 处读 `deep`/`confirm`/`withStatic`，
 *    admin 送 `confirm:'true'`，`vanblog.sh` 送 `-F "confirm=true"`、`-F "withStatic=true|false"`
 *    与 `{"confirm":"true","withStatic":"true"}`；`deep` 脚本从不送（走 `undefined` 默认分支）。
 * 所以统一口径是**行为不变**的（除了把 `"1"` 这类从来没人送过的形状从"真"改成"假"）。
 */
export const checkTrue = (s: unknown): boolean => isTrue(s);
