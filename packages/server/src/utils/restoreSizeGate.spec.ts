import { BadRequestException } from '@nestjs/common';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RESTORE_MAX_TOTAL_BYTES_ENV,
  assertRestorableArchive,
  freeSpaceBytes,
  restoreMaxTotalBytes,
  restoreSpaceShortfallMessage,
} from './fullBackup';

/**
 * 恢复前的"体积 / 剩余空间"闸门。
 *
 * 为什么需要：匿名的 `POST /api/admin/init/restore` 允许上传 **8GB** 归档
 * （`utils/restoreUpload.ts` 的 multer limits），而解包是 `解压器 | tar -xf - -C staging`，
 * **原本没有任何体积上限** ⇒ 一个几 MB 的压缩炸弹就能把磁盘写满，mongo 与日志一起死。
 * 限流只有 5 次/10 分钟/IP，挡不住"一次就够"的写满。
 *
 * 闸门用的数字来自 tar 头部里的成员 `size`（`utils/backupTarStream.ts` 的 `TarEntryInfo.size`），
 * 所以**不需要解包**就能知道要写多少字节 —— 这正是它能挡在写盘之前的原因。
 */

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一个真的 .tar.gz 归档：里面放一个 `sizeBytes` 大小的文件。 */
function makeArchive(sizeBytes: number): { archive: string; dir: string } {
  const dir = tmpDir('vanblog-gate-src-');
  fs.writeFileSync(path.join(dir, 'payload.ndjson'), Buffer.alloc(sizeBytes, 0x61));
  const archive = path.join(tmpDir('vanblog-gate-arc-'), 'backup.tar.gz');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  execFileSync('tar', ['-czf', archive, '-C', dir, '.'], { stdio: 'ignore' });
  return { archive, dir };
}

describe('restoreMaxTotalBytes：环境变量的语义', () => {
  it('没设 ⇒ 默认 100 GiB', () => {
    expect(restoreMaxTotalBytes({})).toBe(100 * GIB);
  });

  it('非法值一律回落默认，**绝不因为写错而变成不限制**', () => {
    for (const raw of ['', '   ', 'abc', '0', '-1', 'NaN', 'Infinity', '1e999']) {
      expect({ raw, cap: restoreMaxTotalBytes({ [RESTORE_MAX_TOTAL_BYTES_ENV]: raw }) }).toEqual({
        raw,
        cap: 100 * GIB,
      });
    }
  });

  it('合法值夹到 [1 MiB, 1 TiB] 并向下取整', () => {
    expect(restoreMaxTotalBytes({ [RESTORE_MAX_TOTAL_BYTES_ENV]: '1048576' })).toBe(MIB);
    expect(restoreMaxTotalBytes({ [RESTORE_MAX_TOTAL_BYTES_ENV]: '1' })).toBe(MIB); // 低于下限
    expect(restoreMaxTotalBytes({ [RESTORE_MAX_TOTAL_BYTES_ENV]: String(4096 * GIB) })).toBe(1024 * GIB); // 高于上限
    expect(restoreMaxTotalBytes({ [RESTORE_MAX_TOTAL_BYTES_ENV]: '2097152.9' })).toBe(2 * MIB);
  });
});

describe('freeSpaceBytes：读不到就返回 null（不当成 0）', () => {
  it('真实目录返回一个正数', () => {
    const dir = tmpDir('vanblog-gate-free-');
    const bytes = freeSpaceBytes(dir);
    expect(typeof bytes).toBe('number');
    expect(bytes as number).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('不存在的目录返回 null ⇒ 闸门被跳过（而不是把恢复全拒了）', () => {
    expect(freeSpaceBytes(path.join(os.tmpdir(), 'vanblog-no-such-dir-xyz'))).toBeNull();
  });

  it('垃圾输入也不抛（闸门不能反过来把恢复弄崩）', () => {
    // ⚠️ 想直接测"平台没有 statfsSync"需要 mock `fs`，而 Node 的 fs 属性在 jest 里
    //    不可重定义（`Cannot redefine property: statfsSync`，实测）。所以这里只钉
    //    **对外契约**：任何读不到的情况都返回 null，而 null 会让闸门跳过（见下面那条纯函数测试）。
    expect(freeSpaceBytes('')).toBeNull();
    expect(freeSpaceBytes('/proc/self/definitely-not-here')).toBeNull();
  });
});

describe('assertRestorableArchive：成员总字节超限必须在解包之前拒绝', () => {
  const OLD = process.env[RESTORE_MAX_TOTAL_BYTES_ENV];
  afterEach(() => {
    if (OLD === undefined) delete process.env[RESTORE_MAX_TOTAL_BYTES_ENV];
    else process.env[RESTORE_MAX_TOTAL_BYTES_ENV] = OLD;
  });

  it('超过上限 ⇒ 400，且错误信息点名环境变量与两个体积', async () => {
    const { archive } = makeArchive(2 * MIB);
    process.env[RESTORE_MAX_TOTAL_BYTES_ENV] = String(MIB); // 上限 1 MiB，归档成员 2 MiB
    await expect(assertRestorableArchive(archive)).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertRestorableArchive(archive)).rejects.toThrow(RESTORE_MAX_TOTAL_BYTES_ENV);
    await expect(assertRestorableArchive(archive)).rejects.toThrow(/没有解包、没有写盘/);
  });

  it('反证：同一个归档在上限之内就照常通过（别把正常恢复修坏）', async () => {
    const { archive } = makeArchive(2 * MIB);
    process.env[RESTORE_MAX_TOTAL_BYTES_ENV] = String(8 * MIB);
    const members = await assertRestorableArchive(archive);
    expect(members).toBeGreaterThan(0);
    delete process.env[RESTORE_MAX_TOTAL_BYTES_ENV]; // 默认 100 GiB
    expect(await assertRestorableArchive(archive)).toBe(members);
  });

  it('反证：被拒时**一个字节都没落盘**（目标目录仍然是空的）', async () => {
    const { archive } = makeArchive(2 * MIB);
    const target = tmpDir('vanblog-gate-target-');
    process.env[RESTORE_MAX_TOTAL_BYTES_ENV] = String(MIB);
    await expect(assertRestorableArchive(archive, { targetDir: target })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fs.readdirSync(target)).toEqual([]);
    fs.rmSync(target, { recursive: true, force: true });
  });
});

describe('restoreSpaceShortfallMessage：剩余空间判定的边界', () => {
  const MIB = 1024 * 1024;
  const RESERVE = 256 * MIB;

  it('不够 ⇒ 返回消息，且消息里同时有"需要多少"和"只剩多少"（用户能照着办）', () => {
    const msg = restoreSpaceShortfallMessage(2 * MIB, MIB, '/data/static/tmp');
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/磁盘空间不够/);
    expect(msg).toMatch(/没有解包、没有写盘/);
    expect(msg).toContain('/data/static/tmp');
    // formatBytes 的口径是 1024 进制但单位写作 KB/MB/GB（见 utils/backupCodec.ts）
    expect(msg).toContain('2.00 MB'); // 成员总量
    expect(msg).toContain('1.00 MB'); // 实际剩余
    expect(msg).toContain('258 MB'); // 合计需要 = 2 MB + 256 MB 余量（toFixed 在 ≥100 时不留小数）
  });

  it('刚好等于"成员 + 256 MiB 余量"⇒ 放行；差一个字节 ⇒ 拒绝（边界不能糊）', () => {
    const need = 2 * MIB + RESERVE;
    expect(restoreSpaceShortfallMessage(2 * MIB, need, '/t')).toBeNull();
    expect(restoreSpaceShortfallMessage(2 * MIB, need - 1, '/t')).toBeTruthy();
  });

  it('freeBytes 为 null（读不到）⇒ **跳过闸门**，不是拒绝', () => {
    // ⚠️ 这条最容易被写反：把"读不到"当成 0 会让所有恢复都失败（平台没有 statfsSync、
    //    或目录权限读不到时），而那与"磁盘真的满了"是两件事。
    expect(restoreSpaceShortfallMessage(1024 * MIB, null, '/t')).toBeNull();
  });

  it('成员总字节为 0 / NaN 时只要求余量，不会算出 NaN 而误判', () => {
    expect(restoreSpaceShortfallMessage(0, RESERVE, '/t')).toBeNull();
    expect(restoreSpaceShortfallMessage(0, RESERVE - 1, '/t')).toBeTruthy();
    expect(restoreSpaceShortfallMessage(NaN, RESERVE, '/t')).toBeNull();
    expect(restoreSpaceShortfallMessage(2 * MIB, NaN as any, '/t')).toBeNull(); // NaN 视同"读不到"
  });
});

describe('assertRestorableArchive：剩余空间闸门的接线', () => {
  it('targetDir 不存在（读不到剩余空间）⇒ 跳过这道闸门，恢复照常', async () => {
    const { archive } = makeArchive(MIB);
    const ghost = path.join(os.tmpdir(), 'vanblog-no-such-target-dir-xyz');
    expect(freeSpaceBytes(ghost)).toBeNull();
    await expect(assertRestorableArchive(archive, { targetDir: ghost })).resolves.toBeGreaterThan(0);
  });

  it('真实目录（空间充足）⇒ 放行', async () => {
    const { archive } = makeArchive(MIB);
    const target = tmpDir('vanblog-gate-real-');
    await expect(assertRestorableArchive(archive, { targetDir: target })).resolves.toBeGreaterThan(0);
    expect(fs.readdirSync(target)).toEqual([]); // 这一步本来就只读不写
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('不传 targetDir（初始化页那次重复的前置检查）⇒ 只做体积上限', async () => {
    const { archive } = makeArchive(MIB);
    await expect(assertRestorableArchive(archive)).resolves.toBeGreaterThan(0);
  });
});

describe('闸门不影响既有的成员安全检查', () => {
  it('解不开的文件仍然报"读不出归档成员表"（体积闸门排在它后面）', async () => {
    const dir = tmpDir('vanblog-gate-bad-');
    const bad = path.join(dir, 'broken.tar.gz');
    fs.writeFileSync(bad, Buffer.from('这不是一个归档'));
    await expect(assertRestorableArchive(bad)).rejects.toBeInstanceOf(BadRequestException);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
