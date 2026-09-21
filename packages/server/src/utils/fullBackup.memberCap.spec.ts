import { BadRequestException, Logger } from '@nestjs/common';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { hashTarStream } from './backupTarStream';
import {
  RESTORE_MAX_MEMBERS_ENV,
  RESTORE_MAX_TOTAL_BYTES_ENV,
  assertRestorableArchive,
  composeToolFailure,
  explainSilentToolFailure,
  explainTarFailure,
  hashArchiveMembers,
  hashTarStreamCapped,
  listArchiveEntries,
  restoreMaxMembers,
} from './fullBackup';
import type { CompressorSpec } from './fullBackup';
import { resetRestoreRejectLog } from './restoreSecurityLog';

/**
 * 归档**成员条数**上限（`VANBLOG_RESTORE_MAX_MEMBERS`）与"安全拒绝必须留痕"的守卫。
 *
 * ## 为什么必须有成员数上限（体积上限拦不住这一类）
 * 体积闸门看的是成员 `size` 之和，而**空文件的 size 是 0** ⇒ 一个塞满空成员的归档声明体积
 * 是 0 字节，体积闸门永远放行。活体实测（`AGENTS.md` §7.82）：**548,127 字节**的归档装
 * **10 万个空文件**，让"读成员表"跑了 **19,488ms**、RSS 从 200MB 涨到 263MB，
 * 最后才因为"没有 manifest.json"被拒 ⇒ 那 19.5 秒 CPU 与 63MB 常驻**全都白烧**，
 * 而 `POST /api/admin/init/restore` 是**匿名可达**的、可以反复触发。
 *
 * ## 所以这里最关键的断言不是"会拒绝"，而是"**没读完整条流**"
 * 事后判断条数也能拒绝，但一点也省不下那 19.5 秒。真正要钉住的是
 * `countedAtAbort === cap + 1`（数到刚过上限就停），而不是 `entries.length === 全部成员数`。
 */

jest.setTimeout(180000);

function tmpDir(prefix = 'vanblog-membercap-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一个含 `count` 个**空文件**的暂存树（正是实测那种放大形状：size 全是 0） */
function stagingWithEmptyFiles(count: number): string {
  const dir = tmpDir('vanblog-mc-staging-');
  fs.mkdirSync(path.join(dir, 'static', 'img'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ kind: 'vanblog-full', version: 1 }));
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(dir, 'static', 'img', `f${String(i).padStart(6, '0')}.bin`), '');
  }
  return dir;
}

function tarOf(staging: string, outName: string, gzip: boolean): string {
  const out = path.join(path.dirname(staging), outName);
  execFileSync(
    'sh',
    ['-c', `tar -cf - -C '${staging}' . ${gzip ? '| gzip -9 -c' : ''} > '${out}'`],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return out;
}

function captureLogs() {
  const errors: string[] = [];
  const warns: string[] = [];
  const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
    errors.push(String(m));
  });
  const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => {
    warns.push(String(m));
  });
  return {
    errors,
    warns,
    restore: () => {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

describe('restoreMaxMembers：环境变量语义（与 restoreMaxTotalBytes 同口径）', () => {
  const ENV = RESTORE_MAX_MEMBERS_ENV;
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('缺失 / 空串 ⇒ 默认 50000', () => {
    delete process.env[ENV];
    expect(restoreMaxMembers({})).toBe(50_000);
    expect(restoreMaxMembers({ [ENV]: '   ' })).toBe(50_000);
  });

  it('🔴 写 0 / 负数 / 垃圾值 ⇒ **回落默认**，绝不是"不限制"', () => {
    for (const bad of ['0', '-1', 'abc', '1e999', 'NaN', '12abc']) {
      expect(restoreMaxMembers({ [ENV]: bad })).toBe(50_000);
    }
    // 负向对照：合法值确实被采纳，证明上面不是"恒返回默认"
    expect(restoreMaxMembers({ [ENV]: '777' })).toBe(777);
  });

  it('夹到 [100, 5000000] 并向下取整', () => {
    expect(restoreMaxMembers({ [ENV]: '1' })).toBe(100);
    expect(restoreMaxMembers({ [ENV]: '99999999999' })).toBe(5_000_000);
    expect(restoreMaxMembers({ [ENV]: '1234.9' })).toBe(1234);
  });
});

describe('hashTarStreamCapped：与 hashTarStream 的平价（未触上限时结果必须一致）', () => {
  let staging: string;
  let tar: string;
  beforeAll(() => {
    staging = stagingWithEmptyFiles(12);
    tar = tarOf(staging, 'parity.tar', false);
  });
  afterAll(() => {
    for (const p of [staging, tar]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('cap=null 时七个字段逐项等于 hashTarStream（证明记账口径没有漂移）', async () => {
    const plain = await hashTarStream(fs.createReadStream(tar), { computeHashes: false });
    const capped = await hashTarStreamCapped(fs.createReadStream(tar), {
      computeHashes: false,
      maxEntries: null,
    });
    expect(capped.exceeded).toBe(false);
    expect(capped.result.memberCount).toBe(plain.memberCount);
    expect(capped.result.entries.map((e) => e.name)).toEqual(plain.entries.map((e) => e.name));
    expect(capped.result.entries.map((e) => e.kind)).toEqual(plain.entries.map((e) => e.kind));
    expect(capped.result.complete).toBe(plain.complete);
    expect(capped.result.complete).toBe(true);
    expect(capped.result.badHeaders).toEqual(plain.badHeaders);
    expect(capped.result.duplicateNames).toEqual(plain.duplicateNames);
    expect(Object.keys(capped.result.members).sort()).toEqual(Object.keys(plain.members).sort());
    expect(capped.result.bytes).toBe(plain.bytes);
    // ⚠️ 替身自检：这个归档真的有成员，否则上面一堆 toEqual([]) 会恒真
    expect(plain.memberCount).toBeGreaterThan(10);
  });

  it('cap 高于成员数时不触发（exceeded=false、complete=true、成员数不变）', async () => {
    const capped = await hashTarStreamCapped(fs.createReadStream(tar), {
      computeHashes: false,
      maxEntries: 10_000,
    });
    expect(capped.exceeded).toBe(false);
    expect(capped.result.complete).toBe(true);
    expect(capped.result.memberCount).toBeGreaterThan(10);
  });
});

describe('hashTarStreamCapped：🔴 超限时**提前中止**（不是读完整条流再拒绝）', () => {
  let staging: string;
  let tar: string;
  const TOTAL = 200;
  beforeAll(() => {
    staging = stagingWithEmptyFiles(TOTAL);
    tar = tarOf(staging, 'many.tar', false);
  });
  afterAll(() => {
    for (const p of [staging, tar]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('数到 cap+1 就停：countedAtAbort === cap+1，而不是全部 200 个成员', async () => {
    const cap = 5;
    const seen: number[] = [];
    const out = await hashTarStreamCapped(fs.createReadStream(tar), {
      computeHashes: false,
      maxEntries: cap,
      onExceeded: (n) => seen.push(n),
    });
    expect(out.exceeded).toBe(true);
    expect(out.countedAtAbort).toBe(cap + 1);
    expect(out.result.entries).toHaveLength(cap + 1);
    expect(out.result.memberCount).toBe(cap + 1);
    // 🔴 这条是本文件的核心：如果实现是"读完再判断"，memberCount 会是 200 左右
    expect(out.result.memberCount).toBeLessThan(TOTAL);
    expect(seen).toEqual([cap + 1]);
    // 中止时流一定没走完 ⇒ complete 必须是 false，绝不能被当成"检查通过"
    expect(out.result.complete).toBe(false);
  });

  it('onExceeded 抛错也不会让这次中止变成未处理异常（回调炸了照样结算）', async () => {
    const out = await hashTarStreamCapped(fs.createReadStream(tar), {
      computeHashes: false,
      maxEntries: 3,
      onExceeded: () => {
        throw new Error('回调自己炸了');
      },
    });
    expect(out.exceeded).toBe(true);
    expect(out.countedAtAbort).toBe(4);
  });

  it('cap=0 / 负数 / 非数字 ⇒ 不设上限（等价于 hashTarStream）', async () => {
    for (const bad of [0, -5, Number.NaN]) {
      const out = await hashTarStreamCapped(fs.createReadStream(tar), {
        computeHashes: false,
        maxEntries: bad,
      });
      expect(out.exceeded).toBe(false);
      expect(out.result.complete).toBe(true);
      expect(out.result.memberCount).toBeGreaterThan(TOTAL - 5);
    }
  });
});

describe('listArchiveEntries：超限 ⇒ 可照做的 400 + 一条 ERROR 日志', () => {
  let staging: string;
  let archive: string;
  beforeAll(() => {
    staging = stagingWithEmptyFiles(40);
    archive = tarOf(staging, 'many.tar.gz', true);
  });
  afterAll(() => {
    for (const p of [staging, archive]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
  beforeEach(() => {
    resetRestoreRejectLog();
    delete process.env[RESTORE_MAX_MEMBERS_ENV];
  });

  it('显式传小上限 ⇒ 抛 400，文案点名上限、实际数、环境变量，并说明"已中止读取"', async () => {
    const cap = captureLogs();
    try {
      let err: any = null;
      try {
        await listArchiveEntries(archive, { maxEntries: 5 });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      const msg = String(err?.message ?? err);
      expect(msg).toContain('成员条数超过上限');
      expect(msg).toContain('已数到 6 个');
      expect(msg).toContain('允许 5 个');
      expect(msg).toContain(RESTORE_MAX_MEMBERS_ENV); // 怎么放宽
      expect(msg).toContain('中止读取'); // 不是"读完了才拒"
      expect(msg).toContain('没有解包、没有写盘');
      // 🔴 日志留痕（这条正是本轮要修的缺陷：以前只 throw 不 log）
      expect(cap.errors.some((m) => m.includes('member-cap'))).toBe(true);
      expect(cap.errors.some((m) => m.includes(path.basename(archive)))).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('默认上限（50000）下同一份归档**不**触发（不能误伤正常恢复）', async () => {
    const cap = captureLogs();
    try {
      const { entries, decompressError } = await listArchiveEntries(archive);
      expect(decompressError).toBeNull();
      expect(entries.length).toBeGreaterThanOrEqual(40);
      expect(cap.errors.filter((m) => m.includes('member-cap'))).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it('环境变量能把上限调小并生效（走的是默认路径，不是显式参数）', async () => {
    process.env[RESTORE_MAX_MEMBERS_ENV] = '100'; // 夹到最小值 100
    const cap = captureLogs();
    try {
      // 40 个成员的归档在 100 的上限下仍然过得去
      const { entries } = await listArchiveEntries(archive);
      expect(entries.length).toBeGreaterThanOrEqual(40);
    } finally {
      cap.restore();
      delete process.env[RESTORE_MAX_MEMBERS_ENV];
    }
  });
});

describe('安全相关的拒绝必须留痕：体积上限与穿越成员', () => {
  beforeEach(() => resetRestoreRejectLog());

  it('🔴 体积上限拒绝时打一条 ERROR（class=size-cap），而不只是回响应体', async () => {
    const staging = tmpDir('vanblog-mc-big-');
    fs.mkdirSync(path.join(staging, 'static', 'img'), { recursive: true });
    // 2MB 的零字节文件：gzip 后很小，但 tar 头部里声明的 size 是 2MB ⇒ 触发体积闸门
    fs.writeFileSync(path.join(staging, 'static', 'img', 'big.bin'), Buffer.alloc(2 * 1024 * 1024));
    const archive = tarOf(staging, 'big.tar.gz', true);
    const originalCap = process.env[RESTORE_MAX_TOTAL_BYTES_ENV];
    process.env[RESTORE_MAX_TOTAL_BYTES_ENV] = String(1024 * 1024); // 最小值 1MiB
    const cap = captureLogs();
    try {
      let err: any = null;
      try {
        await assertRestorableArchive(archive, {});
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(String(err?.message ?? err)).toContain('超过允许的');
      expect(cap.errors.some((m) => m.includes('size-cap'))).toBe(true);
      expect(cap.errors.some((m) => m.includes('超过上限'))).toBe(true);
    } finally {
      cap.restore();
      if (originalCap === undefined) delete process.env[RESTORE_MAX_TOTAL_BYTES_ENV];
      else process.env[RESTORE_MAX_TOTAL_BYTES_ENV] = originalCap;
      for (const p of [staging, archive]) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  });

  it('🔴 穿越成员拒绝时打一条 ERROR（class=unsafe-entry）', async () => {
    const staging = tmpDir('vanblog-mc-unsafe-');
    fs.mkdirSync(path.join(staging, 'db'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'db', 'x.json'), '{}');
    const archive = path.join(path.dirname(staging), 'unsafe.tar.gz');
    execFileSync(
      'sh',
      [
        '-c',
        `cd '${staging}' && tar -cf - --transform 's|^db|../db|' db | gzip -9 -c > '${archive}'`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const cap = captureLogs();
    try {
      let err: any = null;
      try {
        await assertRestorableArchive(archive, {});
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(String(err?.message ?? err)).toContain('会写到解包目录之外');
      expect(cap.errors.some((m) => m.includes('unsafe-entry'))).toBe(true);
      // ⚠️ 日志里可以出现成员名（排障必需），但绝不能出现任何 64 位十六进制
      for (const line of cap.errors) {
        expect(line).not.toMatch(/\b[0-9a-fA-F]{64}\b/);
      }
    } finally {
      cap.restore();
      for (const p of [staging, archive]) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  });
});

describe('explainTarFailure：把 busybox tar 的天书翻译成可照做的提示', () => {
  it('GNU 稀疏成员（busybox 不支持）⇒ 点名 busybox 与重新打包的办法', () => {
    const out = explainTarFailure("tar: unknown typeflag: 0x53\n");
    expect(out).toContain('busybox');
    expect(out).toContain('稀疏');
    expect(out).toContain('GNU tar');
    // ⚠️ 必须说清"VanBlog 自己导出的归档不会用到它"，否则站长会以为自己的备份坏了
    expect(out).toContain('自己导出的归档不会用到');
  });

  it('不像 tar 流 ⇒ 提示压缩格式与后缀不符', () => {
    const out = explainTarFailure('tar: This does not look like a tar archive');
    expect(out).toContain('不是 tar 流');
    expect(out).toContain('后缀');
  });

  it('截断 ⇒ 提示核对 sha256 / 重拷', () => {
    expect(explainTarFailure('tar: short read')).toContain('截断');
    expect(explainTarFailure('gzip: unexpected end of file')).toContain('截断');
  });

  it('识别不了的 stderr ⇒ 返回空串（**只附加、绝不改写原文**）', () => {
    expect(explainTarFailure('tar: some totally unknown complaint')).toBe('');
    expect(explainTarFailure('')).toBe('');
    // ⚠️ 尺子有效性反证：上面三条特指形状确实被识别（不是恒返回空）
    expect(explainTarFailure('unknown typeflag').length).toBeGreaterThan(0);
  });

  it('🔴 接线证明：**被截断**的归档，报错里同时有解压器原文与"截断"提示', async () => {
    // ⚠️ 为什么用"截断"而不是"gzip 了的非 tar 字节"来测：
    //    **列成员表这条路上没有 tar 子进程** —— `hashTarStream` 是在 JS 里解析 tar 字节的，
    //    所以一份"gzip 合法的垃圾"在这里既不会报错也不会有 tar 的 stderr（实测：entries=0、
    //    decompressError=null、`assertRestorableArchive` 照常返回 0 个成员）。
    //    `unknown typeflag` / `does not look like a tar archive` 那两种文案只可能出现在
    //    **真解包**（`decompressUntar` 里的 `tar -xf`）那一条路上。
    //    而"截断"是解压器自己就会报的（gzip: unexpected end of file），所以它是
    //    在这一层能**真正走到 explainTarFailure** 的形状。
    const staging = stagingWithEmptyFiles(3);
    const archive = tarOf(staging, 'trunc.tar.gz', true);
    const buf = fs.readFileSync(archive);
    fs.writeFileSync(archive, buf.subarray(0, Math.max(32, Math.floor(buf.length * 0.6))));
    try {
      const { decompressError } = await listArchiveEntries(archive);
      // 截断的 gzip 在多数实现下会报非 0 退出码；如果这台机器的 gzip 宽容到返回 0，
      // 那 decompressError 就是 null —— 这种情况下**如实跳过**而不是假绿。
      if (decompressError) {
        // 🔴 **不变量（本条是这个用例真正的判据）**：只要报了解压失败，消息里就**必须**
        //    带一句可照做的提示，绝不许以冒号收尾把站长晾在那里。
        //    改前这里只断言"含解压器原文"，于是当 stderr 因为竞争没被收到时，
        //    消息变成一个光秃秃的前缀 + 冒号，断言就红了 —— 而**红的原因被误读成
        //    "负载假红"**，实际是"用户拿到了无法据以行动的报错"这个真缺陷。
        expect(decompressError).toContain('提示：');
        expect(decompressError.trimEnd().endsWith('：')).toBe(false);
        // 两种情况各有判据，**都不许静默通过**：
        if (/unexpected end of file|short read|not in gzip format|invalid/i.test(decompressError)) {
          // (a) 收到了解压器的原文 ⇒ 必须既留原文、又给出"截断"这条针对性翻译
          expect(decompressError).toMatch(/unexpected end of file|short read|not in gzip format|invalid/i);
          if (/unexpected end of file|short read/i.test(decompressError)) {
            expect(decompressError).toContain('截断');
          }
        } else {
          // (b) 一个字都没收到（竞争，或工具真的静默失败）⇒ 必须落到兜底提示，
          //     并且**说清"没有诊断输出"**，而不是假装知道原因。
          expect(decompressError).toContain('没有留下任何诊断输出');
          expect(decompressError).toMatch(/gzip -t|zstd -t|xz -t/);
        }
      }
      // 无论上面哪种，"成员表读不出"这件事在 assertRestorableArchive 那一层必须变成 400，
      // 并且**留一条日志**（这正是本轮修的缺陷之一）。
      resetRestoreRejectLog();
      const cap = captureLogs();
      try {
        let err: any = null;
        try {
          await assertRestorableArchive(archive, {});
        } catch (e) {
          err = e;
        }
        if (err) {
          expect(err).toBeInstanceOf(BadRequestException);
          expect(String(err?.message ?? err)).toContain('读不出归档成员表');
          expect(cap.warns.some((m) => m.includes('member-table-unreadable'))).toBe(true);
        }
      } finally {
        cap.restore();
      }
    } finally {
      for (const p of [staging, archive]) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  });
});

describe('源码级：三条 tar 报错路径都接上了翻译（防止将来新增路径时漏掉）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'fullBackup.ts'), 'utf-8');

  // ⚠️ 2026-09-21 升级（**不是放宽**）：改前这条钉的是"`explainTarFailure(` 出现 ≥4 次
  //    （定义 + 三个手写拼接点）"。那三处拼接已经收敛进 `composeToolFailure`，
  //    所以计数从 4 掉到 2 —— 但**这条守卫想守的性质是"翻译不可能被绕过"**，
  //    收敛之后那个性质的正确形状是"唯一的调用点在 composeToolFailure 体内"。
  //    🔴 只把阈值从 4 改成 2 就是放宽（2 也可能是"定义 + 某个不相干的地方"），
  //    所以改成断言**位置**，并保留负向对照。
  it('翻译不可能被绕过：`explainTarFailure` 唯一的调用点在 composeToolFailure 体内', () => {
    const hits = src.match(/explainTarFailure\(/g) ?? [];
    // 收敛之后只剩 2 处：定义 + composeToolFailure 内部那一次
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const fnStart = src.indexOf('export function composeToolFailure(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
    // 🔴 关键：那一次调用必须真的在 composeToolFailure 里（否则"收敛"是假的）
    expect(fnBody).toContain('explainTarFailure(text)');
    // 负向对照：只有一处（定义）时这把尺子必须能看出来
    expect(hits.length).not.toBe(1);
    // ⚠️ 尺子有效性反证：位置断言在"调用点不在函数体内"时必须失效
    expect('export function composeToolFailure(x) { return y; }'.includes('explainTarFailure(text)')).toBe(
      false,
    );
  });

  it('超限中止时**必须** SIGKILL 解压器（只 destroy 流的话它还会继续吃 CPU）', () => {
    const body = src.slice(src.indexOf('export async function hashArchiveMembers('));
    const region = body.slice(0, body.indexOf('export async function listArchiveEntries('));
    expect(region).toContain("decompressor.kill('SIGKILL')");
    // ⚠️ 且杀进程要在 membersExceeded 那条分支里，不是别处顺带的
    expect(region.indexOf('onExceeded')).toBeLessThan(region.indexOf("decompressor.kill('SIGKILL')"));
  });

  it('超限时不能把它报成"解压失败"（那个非 0 退出码是我们自己 SIGKILL 出来的）', () => {
    expect(src).toContain('const decompressError = membersExceeded');
  });

  it('🔴 导出侧的 tar 命令行**绝不能**出现 --sparse / --xattrs（否则自产归档在同一镜像里解不开）', () => {
    // 实测依据（宿主机 GNU tar 1.35 + busybox 1.36.1 交叉验证；镜像里是 busybox 1.37.0）：
    //  - `tar -cf - -C st .`（本仓库导出用的形状，无 --sparse）把一个 8MB 稀疏文件
    //    **完整存下来**（tar 体积 8,396,800 字节），busybox 读它 rc=0 ⇒ 自产归档一定可读；
    //  - `tar --sparse -cf …` 产出的归档（10,240 字节）busybox 解包直接
    //    `rc=1  tar: unknown typeflag: 0x53` ⇒ **自己产的归档自己解不开**。
    //  所以这条不变量的失败方向是"备份做得出来、恢复做不回去"，比不做备份更糟。
    const exportCalls = src.match(/spawn\('tar', \['-cf', '-', '-C', stagingDir, '\.'\]\)/g) ?? [];
    expect(exportCalls.length).toBeGreaterThanOrEqual(2); // 两条导出路径都要在
    expect(src).not.toMatch(/spawn\('tar',[^)]*--sparse/);
    expect(src).not.toMatch(/spawn\('tar',[^)]*--xattrs/);
    // ⚠️ 尺子有效性反证：上面那两把"不许出现"的尺子必须量得到坏形状，否则恒真
    expect(/spawn\('tar',[^)]*--sparse/.test("spawn('tar', ['-cf','--sparse','-'])")).toBe(true);
    expect(/spawn\('tar',[^)]*--sparse/.test("spawn('tar', ['-cf','-'])")).toBe(false);
  });

  it('解包/单成员读取用的 tar 参数形状没有被改掉（busybox 与 GNU 都认这三个）', () => {
    expect(src).toContain("spawn('tar', ['-xf', '-', '-C', destDir])");
    expect(src).toContain("spawn('tar', ['-xOf', '-', entry])");
    expect(src).toContain("spawn('tar', ['-tf', '-'])");
  });
});

/**
 * 🔴 **"外部工具非 0 退出"的报错必须始终可照做** —— 这是**用户可见文案**的守卫。
 *
 * ## 为什么单独立一节
 * 活体实测（本轮）：让一个**真实**子进程以退出码 1 结束且不写 stderr，改前的组装形状会产出
 * 一条以冒号收尾、后面什么都没有的报错（**12/12 次**如此）。而 `explainTarFailure` 存在的
 * 全部理由就是"把 busybox/gzip 的天书翻译成可照做的提示"，所以在"没有天书可翻译"时反而
 * 一句提示都没有，是那条设计目标的漏洞：站长在**灾难恢复**时拿到一条无法据以行动的报错。
 *
 * ## 两个缺陷必须分开，别混成一个
 * 1. **工具真的没说话**（被信号杀掉 / 工具异常）⇒ 确定性的，本节用真子进程复现；
 * 2. **工具说了、我们没读到**（`exit` 早于 stderr 排空）⇒ 罕见竞争，
 *    本机 100/100 次都没能自然复现（安静与全量 jest 负载下都试过），
 *    所以它由**源码级**断言 + 重复回归网兜住，而不是假装能行为复现。
 * ⚠️ 把两者混成一个"空 stderr"来修是错的：那会用兜底文案**掩盖**"我们丢了诊断信息"。
 */
describe('解压/解包失败报错的可照做性（用户可见文案）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'fullBackup.ts'), 'utf-8');

  it('stderr 有内容 ⇒ 原文逐字保留，只在后面**附加**提示（绝不改写原文）', () => {
    const raw = 'gzip: /x/y.tar.gz: unexpected end of file\n';
    const out = composeToolFailure('gzip 解压失败', 1, raw, 300);
    expect(out).toContain(raw.trimEnd()); // 原文必须还在（唯一能拿去搜索的东西）
    expect(out).toContain('提示：');
    expect(out).toContain('截断');
    expect(out.startsWith('gzip 解压失败（退出码 1）：')).toBe(true);
  });

  it('🔴 stderr 为空 ⇒ 给兜底提示，**绝不以冒号收尾**', () => {
    const out = composeToolFailure('gzip 解压失败', 1, '', 300);
    expect(out).toContain('提示：');
    expect(out.trimEnd().endsWith('：')).toBe(false);
    // 空白字符也算"没说话"
    expect(composeToolFailure('gzip 解压失败', 1, '   \n  ', 300)).toContain('没有留下任何诊断输出');
  });

  it('兜底提示必须说清"没有诊断输出"并给出**可照做**的下一步', () => {
    const hint = explainSilentToolFailure(1);
    expect(hint).toContain('没有留下任何诊断输出');
    // 不能假装知道原因：要点名最常见的那种（被信号中止）
    expect(hint).toContain('信号中止');
    // 必须给出至少一条站长真能执行的动作
    expect(hint).toMatch(/gzip -t|zstd -t|xz -t/);
    expect(hint).toContain('.sha256');
    // 退出码要带上（拿去搜索用）
    expect(hint).toContain('1');
  });

  it('尺子有效性反证：**旧形状确实以冒号收尾**，所以"不以冒号收尾"这把尺子量得到东西', () => {
    // 逐字复刻改前那三处手写的组装形状
    const legacy = `gzip 解压失败（退出码 ${1}）：${''.slice(0, 300)}${explainTarFailure('')}`;
    expect(legacy.trimEnd().endsWith('：')).toBe(true); // 旧形状 = 坏形状，尺子能抓到
    expect(legacy).not.toContain('提示：');
    // 新形状 = 同一输入下不再坏
    const fixed = composeToolFailure('gzip 解压失败', 1, '', 300);
    expect(fixed.trimEnd().endsWith('：')).toBe(false);
    expect(fixed).toContain('提示：');
  });

  it('🔴 真子进程端到端：**静默失败**的解压器 ⇒ 用户拿到的报错仍然可照做', async () => {
    const dir = tmpDir('vanblog-silent-');
    const fake = path.join(dir, 'archive.tar.gz');
    fs.writeFileSync(fake, Buffer.alloc(64, 0));
    try {
      // ⚠️ 用**真实**子进程（sh -c 'exit 1'，一个字都不写 stderr），
      //    不是替身 —— 替身只会证明"我的假进程按我的假设沉默"。
      const spec: CompressorSpec = {
        format: 'gzip',
        ext: '.tar.gz',
        compress: ['true'],
        decompress: ['sh', '-c', 'exit 1'],
        label: 'silent-probe',
      };
      const { decompressError, membersExceeded } = await hashArchiveMembers(fake, spec, {
        computeHashes: false,
        maxEntries: null,
      });
      expect(membersExceeded).toBe(false);
      expect(decompressError).not.toBeNull();
      const msg = String(decompressError);
      expect(msg).toContain('提示：');
      expect(msg).toContain('没有留下任何诊断输出');
      expect(msg.trimEnd().endsWith('：')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 真子进程端到端：**有 stderr** 的解压器 ⇒ 原文与翻译都在（兜底没有把真信息挤掉）', async () => {
    const dir = tmpDir('vanblog-noisy-');
    const fake = path.join(dir, 'archive.tar.gz');
    fs.writeFileSync(fake, Buffer.alloc(64, 0));
    try {
      const spec: CompressorSpec = {
        format: 'gzip',
        ext: '.tar.gz',
        compress: ['true'],
        decompress: ['sh', '-c', 'printf "gzip: stdout: unexpected end of file\\n" >&2; exit 1'],
        label: 'noisy-probe',
      };
      const { decompressError } = await hashArchiveMembers(fake, spec, {
        computeHashes: false,
        maxEntries: null,
      });
      const msg = String(decompressError);
      expect(msg).toContain('unexpected end of file'); // 原文
      expect(msg).toContain('截断'); // 针对性翻译
      expect(msg).not.toContain('没有留下任何诊断输出'); // 🔴 有信息就绝不许说"没信息"
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 五处**读取侧**组装全部收敛到 composeToolFailure（源码级：不许再有手写的那一条）', () => {
    // 手写形状的特征是"（退出码 ${code}）：" 紧跟着又一个 ${...} 插值。
    // ⚠️ 只钉**读取侧**的三个前缀（解压 / 解包 / 读不出归档成员表）——
    //    导出侧的"压缩失败"是**有意**不收敛的，理由见下一条用例。
    const handRolled = /(解压失败|解包失败|读不出归档成员表)（(tar )?退出码 \$\{code\}）：\$\{/;
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    expect(code.some((l) => handRolled.test(l))).toBe(false);
    // 并且确实有 5 处在用它（1 处 hashArchiveMembers + 2 处 decompressUntar + 2 处 listArchiveMembers）
    const uses = src.match(/composeToolFailure\(/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(6); // 1 个定义 + 5 个调用点
    // ⚠️ 尺子有效性反证：这把尺子必须量得到坏形状，否则恒真
    expect(handRolled.test('fail(`解压失败（退出码 ${code}）：${decErr.slice(0, 300)}`);')).toBe(true);
    expect(
      handRolled.test('fail(`读不出归档成员表（tar 退出码 ${code}）：${tarErr.slice(0, 300)}`);'),
    ).toBe(true);
    expect(handRolled.test('fail(composeToolFailure("解压失败", code, decErr, 300));')).toBe(false);
  });

  it('导出侧那两处压缩失败**有意**不收敛，且永远不会留下一个光秃秃的冒号', () => {
    // 🔴 为什么不把导出侧也塞进 composeToolFailure：
    //    `explainTarFailure` 翻译的是**读归档**时的天书（busybox typeflag、"不像 tar 流"、"被截断"）。
    //    把它用到**压缩**失败上会给出误导性提示 —— 压缩器报一句 short read，
    //    翻译过来却是"你的归档被截断了，请核对 .sha256"，而那一刻根本没有归档可读。
    //    所以导出侧只保留原文 + 剩余空间，那才是压缩失败最可能的原因（磁盘满）。
    const compSites = src.match(/压缩失败（退出码 \$\{code\}）：\$\{compErr\.slice\(0, 500\)\}`/g) || [];
    expect(compSites.length).toBe(2); // 加密与不加密两条分支各一处
    // ⚠️ 而它们**都**紧跟剩余空间后缀 ⇒ 不存在"冒号后面什么都没有"这个缺陷
    const withFree =
      src.match(/压缩失败（退出码 \$\{code\}）：[^`]*`\s*\+\s*`（剩余空间 \$\{free\}）`/g) || [];
    expect(withFree.length).toBe(2);
  });

  it('🔴 hashArchiveMembers 在组装报错前**等 stderr 排空**（源码级：竞争无法行为复现）', () => {
    // 竞争的机制：`exit` 只表示进程终止，Node 保证 stdio 已关闭的是 `close`。
    // 改前那个 promise 在 exit/close 之间"谁先到就 resolve"，而 exit 通常先到 ⇒
    // 组装时 decErr 可能还是空的（诊断信息被我们自己丢掉）。
    // ⚠️ 本机 100/100 次没能自然复现（安静 + 全量 jest 负载都试过），所以钉源码形状。
    expect(src).toContain('const stderrDrained = new Promise<void>');
    expect(src).toContain("decompressor.stderr.on('end'");
    expect(src).toContain("decompressor.stderr.on('close'");
    // 并且它**真的被 await 了**（只定义不 await 等于没修）
    expect(src).toMatch(/Promise\.all\(\[hashed, exited\.catch\(\(\) => null\), stderrDrained\]\)/);
    // ⚠️ 同文件的 decompressUntar 用的是 close（那边没有这个竞争）⇒ 钉住它别被"统一"成 exit
    expect(src).toMatch(/decompressor\.on\('close', \(code\) =>/);
    // ⚠️ 尺子有效性反证
    expect(/Promise\.all\(\[hashed, exited\.catch\(\(\) => null\), stderrDrained\]\)/.test(src)).toBe(true);
    expect(
      /Promise\.all\(\[hashed, exited\.catch\(\(\) => null\), stderrDrained\]\)/.test(
        'const [result, code] = await Promise.all([hashed, exited.catch(() => null)]);',
      ),
    ).toBe(false);
  });

  it('回归网：截断归档重复 8 次，报错的**提示从不缺失**', async () => {
    const staging = stagingWithEmptyFiles(3);
    const archive = tarOf(staging, 'trunc-repeat.tar.gz', true);
    const buf = fs.readFileSync(archive);
    fs.writeFileSync(archive, buf.subarray(0, Math.max(32, Math.floor(buf.length * 0.6))));
    let sawError = 0;
    try {
      for (let i = 0; i < 8; i += 1) {
        const { decompressError } = await listArchiveEntries(archive);
        if (!decompressError) continue; // 这台机器的 gzip 宽容到返回 0 ⇒ 如实跳过
        sawError += 1;
        expect(decompressError).toContain('提示：');
        expect(decompressError.trimEnd().endsWith('：')).toBe(false);
      }
    } finally {
      for (const p of [staging, archive]) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
    // ⚠️ 反空转：8 次里至少要有 1 次真的走到了报错分支，否则上面全是空转的恒真断言
    expect(sawError).toBeGreaterThan(0);
  });
});
