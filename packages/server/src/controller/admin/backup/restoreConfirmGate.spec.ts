import { BadRequestException } from '@nestjs/common';
import { BackupController } from './backup.controller';

/**
 * 破坏性整站恢复的**确认闸门**必须用最严的布尔口径。
 *
 * 以前这里是 `checkTrue(body?.confirm)`，而 `checkTrue` 的旧实现含 `s == true` 松散比较 ⇒
 * `confirm:"1"`、`confirm:1`、`confirm:[1]` 都算"站长已确认"。也就是说：**全仓库最该严格的一处
 * 判定，用的是最松的一套口径**。现在闸门点名 `isTrue`（只认 boolean `true` 与字符串 `'true'`），
 * 即使将来有人把 `checkTrue` 改回松散比较，这道闸门也不会跟着松。
 *
 * ⚠️ 这些是**行为级**断言：真调 controller 方法、真看它抛不抛，不是"源码里出现了 isTrue 这个词"
 * （那种子串断言在调用被 `if (false && …)` 短路时照样匹配，本仓库已因此空转过两条守卫）。
 */
function makeController() {
  const controller = Object.create(BackupController.prototype) as BackupController;
  const restore = jest.fn(async () => ({
    ms: 1200,
    databases: { vanBlog: { collections: 2, documents: 3 } },
    static: { img: { files: 1 } },
    manifest: { createdAt: '2026-09-20T00:00:00.000Z' },
    notes: [],
    pruned: [],
    absentCollections: [],
  }));
  const resolveArchive = jest.fn(() => '/tmp/vanblog-full-20260920-000000.tar.zst');
  const activeAll = jest.fn();
  (controller as any).fullBackupProvider = { restore, resolveArchive };
  (controller as any).isrProvider = { activeAll };
  (controller as any).logger = { warn() {}, log() {}, error() {}, debug() {} };
  return { controller, restore, resolveArchive, activeAll };
}

describe('整站恢复的确认闸门', () => {
  it.each([
    ['字符串 "1"', '1'],
    ['数字 1', 1],
    ['数组 [1]', [1]],
    ['字符串 "TRUE"（大写）', 'TRUE'],
    ['字符串 "yes"', 'yes'],
    ['字符串 "on"', 'on'],
    ['空串', ''],
    ['undefined（没带 confirm）', undefined],
    ['null', null],
    ['字符串 "false"', 'false'],
    ['对象 {confirm:true}', { confirm: true }],
  ])('confirm = %s ⇒ 拒绝（400），并且**不调用**恢复', async (_label, confirm) => {
    const { controller, restore } = makeController();
    await expect(
      controller.restoreFull(undefined, { name: 'x', confirm: confirm as any }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(restore).not.toHaveBeenCalled();
  });

  it('confirm = 字符串 "true" ⇒ 放行，真的执行恢复', async () => {
    const { controller, restore, activeAll } = makeController();
    const result = await controller.restoreFull(undefined, { name: 'x', confirm: 'true' });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(activeAll).toHaveBeenCalled();
    expect(result.statusCode).toBe(200);
  });

  it('confirm = boolean true ⇒ 放行（脚本/JSON 客户端可能送真布尔）', async () => {
    const { controller, restore } = makeController();
    await controller.restoreFull(undefined, { name: 'x', confirm: true as any });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('拒绝时的消息写清了**只接受哪种拼写**（可照做，而不是"参数错误"）', async () => {
    const { controller } = makeController();
    await expect(
      controller.restoreFull(undefined, { name: 'x', confirm: '1' }),
    ).rejects.toThrow(/confirm=true[\s\S]*只接受字面量 true 或字符串 "true"[\s\S]*"1"/);
  });

  it('闸门在"取归档"之前 ⇒ 被拒的请求不会去碰文件系统', async () => {
    const { controller, resolveArchive } = makeController();
    await expect(
      controller.restoreFull(undefined, { name: 'x', confirm: '1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolveArchive).not.toHaveBeenCalled();
  });

  it('没带 name 也没上传文件时，报错是"请指定要恢复的备份"而不是确认失败（两条校验没有互相掩盖）', async () => {
    const { controller } = makeController();
    await expect(controller.restoreFull(undefined, { confirm: 'true' })).rejects.toThrow(
      /请指定要恢复的备份/,
    );
  });
});
