/**
 * 「初始化 / 初始化页恢复」的**跨进程互斥**行为测试。
 *
 * 缺陷形状（本轮修的）：控制器原来只有一个模块级布尔量做单飞，那是**每进程一份**的。
 * `VANBLOG_CLUSTER_WORKERS>1`（文档化旋钮，多核机上 >1）时两个并发请求落到不同 worker，
 * 两边的布尔量都是 false ⇒ 两个 `/init` 双双通过 `checkHasInited()`（造出两个 `id:0` 管理员，
 * 而 `getUser()` 是 `findOne({id:0})` 且无排序 ⇒ "谁是管理员"随返回顺序漂移），
 * 或两个 `/init/restore` 同时做「临时集合 + 原子替换 + 重建索引」互相踩成半新半旧的库。
 *
 * 现在：进程内令牌（同步、保留 §7.55 B 的性质）+ DB 级 TTL 锁（跨进程、权威）。
 *
 * ⚠️ 这里的"两个进程"是**真的按跨进程形状测的**：两个独立的 InitController 实例，
 * 各自的 InitProvider 都接到**同一个内存锁集合**上（等价于两个 worker 连同一个 Mongo），
 * 锁语义走的是生产的 `acquireDbLock`/`releaseDbLock`，不是 mock 出来的返回值。
 * 只 mock `acquireInitRestoreLock` 的返回值是测不出竞态的。
 */
import { Logger, HttpException } from '@nestjs/common';
import { InitController, __resetInitRestoreLockForTest, isInitRestoreInFlight, __resetDbLockWarnForTest } from './init.controller';
import { acquireDbLock, releaseDbLock, initLockTtlMs, INIT_RESTORE_LOCK_NAME, LockCollection } from 'src/utils/dbLock';
import { stripCommentsForAnchor } from 'src/test-utils/anchorCode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 忠实模拟 Mongo 在 `findOneAndUpdate({_id, expiresAt:{$lte:now}}, {$set}, {upsert})` 上的原子语义 */
function makeLockCollection() {
  const docs = new Map<string, any>();
  const coll: LockCollection = {
    async findOneAndUpdate(filter: any, update: any, options?: any) {
      const id = String(filter?._id);
      const existing = docs.get(id);
      const set = update?.$set ?? {};
      const cond = filter?.expiresAt;
      const matches = (d: any) =>
        d && (cond && typeof cond.$lte === 'number' ? Number(d.expiresAt) <= cond.$lte : true);
      if (existing && matches(existing)) {
        Object.assign(existing, set);
        return { ...existing };
      }
      if (existing) {
        const err: any = new Error('E11000 duplicate key error collection: vanblog.vanblog_locks');
        err.code = 11000;
        throw err;
      }
      if (options?.upsert) {
        const doc = { _id: id, ...set };
        docs.set(id, doc);
        return { ...doc };
      }
      return null;
    },
    async deleteOne(filter: any) {
      const id = String(filter?._id);
      const existing = docs.get(id);
      if (!existing) return { deletedCount: 0 };
      for (const k of Object.keys(filter ?? {})) {
        if (k !== '_id' && existing[k] !== filter[k]) return { deletedCount: 0 };
      }
      docs.delete(id);
      return { deletedCount: 1 };
    },
  };
  return { coll, docs };
}

const MANIFEST = { version: 1 } as any;

/**
 * ⚠️ 关于"怎么测跨进程"的方法论（第一版在这里想错了，记下来）：
 * 同一个 jest 进程里 new 两个 InitController，它们**共享模块级的进程内闸门**
 * （`localInitRestoreOwner` 是模块变量），所以控制器级的并发用例测到的是**本地闸门**，
 * DB 锁根本不会被争用；而且桩都是立即返回的，处理器会在几毫秒内跑完并**释放**锁，
 * 于是"断言此刻锁文档存在"必然失败（第一版就是这么红的）。
 * 正确形状：让**另一个 provider 直接持锁**（等价于另一个 worker 已经拿到 DB 锁），
 * 本进程的控制器再去撞 —— 本地闸门空闲，于是真正走到 DB 锁的 `busy` 分支。
 * 锁本身的并发原子性（N 路同时抢只有一个赢）在 `utils/dbLock.spec.ts` 里用真并发形状测。
 */

/** 一个"worker"：真 InitProvider 的锁方法 + 桩的其余部分 */
function makeWorker(shared: { coll: LockCollection; docs: Map<string, any> }, over: any = {}) {
  const initCalls: any[] = [];
  const provider: any = {
    checkHasInited: over.checkHasInited ?? jest.fn(async () => false),
    init: over.init ?? jest.fn(async (dto: any) => { initCalls.push(dto); }),
    recordInstallation: jest.fn(async () => undefined),
    // ⚠️ 锁方法走**生产实现**，只是把集合换成内存版
    acquireInitRestoreLock: async () =>
      acquireDbLock(shared.coll, INIT_RESTORE_LOCK_NAME, { ttlMs: initLockTtlMs(), ownerPrefix: 'init' }),
    releaseInitRestoreLock: async (owner: string) =>
      releaseDbLock(shared.coll, INIT_RESTORE_LOCK_NAME, owner),
    ...over.providerExtra,
  };
  const restore = over.restore ?? jest.fn(async () => ({ ms: 10, databases: {}, static: {}, manifest: MANIFEST, notes: [] }));
  const fullBackupProvider: any = {
    backupDir: () => over.backupDir ?? '/tmp/vanblog-dblock-backups',
    restore,
  };
  const controller = new InitController(
    provider,
    { upload: jest.fn() } as any,
    { activeAll: jest.fn() } as any,
    fullBackupProvider,
    { init: jest.fn(async () => undefined) } as any,
    { restart: jest.fn(async () => undefined) } as any,
    { invalidateBase: jest.fn() } as any,
  );
  return { controller, provider, restore, initCalls };
}

let tmp: string;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-init-dblock-'));
  __resetInitRestoreLockForTest();
  __resetDbLockWarnForTest();
  delete process.env.VANBLOG_INIT_REQUIRE_SETUP_KEY;
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeRestoreFile(name = 'vanblog-full-20260913-140955.tar.zst') {
  const p = path.join(tmp, `up-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, 'not-really-an-archive');
  return { path: p, originalname: name, size: 21 } as any;
}

describe('DB 级 TTL 锁：/init', () => {
  it('锁被别的进程持有时 409，且**绝不执行**初始化；对方释放后立刻能成功', async () => {
    const shared = makeLockCollection();
    const holder = makeWorker(shared); // 代表"另一个 worker"
    const w = makeWorker(shared);

    const held = await holder.provider.acquireInitRestoreLock();
    expect(held.kind).toBe('acquired');
    expect(shared.docs.size).toBe(1);

    await expect(w.controller.initSystem({ username: 'b' } as any, undefined, {} as any)).rejects.toThrow(
      /已经有一个初始化\/恢复正在进行（由另一个进程持有锁）/,
    );
    await expect(w.controller.initSystem({ username: 'b' } as any, undefined, {} as any)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(w.initCalls).toHaveLength(0); // 撞锁的请求一次都没执行初始化
    expect(shared.docs.size).toBe(1); // 也没把对方的锁弄丢

    // 对方释放后，本进程立刻能正常初始化（不会因为加锁而变差）
    if (held.kind === 'acquired') {
      expect(await holder.provider.releaseInitRestoreLock(held.handle.owner)).toBe(true);
    }
    await expect(w.controller.initSystem({ username: 'b' } as any, undefined, {} as any)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(w.initCalls).toHaveLength(1);
    expect(shared.docs.size).toBe(0); // 用完就释放
  });

  it('⚠️ 跨进程真并发：两个 provider 同时抢锁，恰好一个 acquired（这才是原缺陷的形状）', async () => {
    const shared = makeLockCollection();
    const a = makeWorker(shared);
    const b = makeWorker(shared);
    const rs = await Promise.all([a.provider.acquireInitRestoreLock(), b.provider.acquireInitRestoreLock()]);
    expect(rs.filter((r) => r.kind === 'acquired')).toHaveLength(1);
    expect(rs.filter((r) => r.kind === 'busy')).toHaveLength(1);
    expect(shared.docs.size).toBe(1); // 只有一条锁文档（唯一性靠 _id）
  });

  it('同进程并发两个 /init：恰好一个成功（本地闸门 + DB 锁两道都不会双写管理员）', async () => {
    const shared = makeLockCollection();
    const a = makeWorker(shared);
    const b = makeWorker(shared);
    const results = await Promise.allSettled([
      a.controller.initSystem({ username: 'a' } as any, undefined, {} as any),
      b.controller.initSystem({ username: 'b' } as any, undefined, {} as any),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // 关键性质：**只写了一次管理员** —— 不会再出现两个 id:0
    expect(a.initCalls.length + b.initCalls.length).toBe(1);
    expect(shared.docs.size).toBe(0); // 跑完锁必须释放，否则以后永久 409
    expect(isInitRestoreInFlight()).toBe(false);
  });

  it('成功路径：拿到锁 → 执行 → 用**同一个 owner** 释放，集合里不留锁文档', async () => {
    const shared = makeLockCollection();
    const release = jest.fn(async (owner: string) => releaseDbLock(shared.coll, INIT_RESTORE_LOCK_NAME, owner));
    const w = makeWorker(shared, { providerExtra: { releaseInitRestoreLock: release } });
    const res: any = await w.controller.initSystem({ username: 'u' } as any, undefined, {} as any);
    expect(res.statusCode).toBe(200);
    expect(release).toHaveBeenCalledTimes(1);
    const owner = release.mock.calls[0][0];
    expect(typeof owner).toBe('string');
    expect(owner.length).toBeGreaterThan(8);
    expect(shared.docs.size).toBe(0);
  });

  it('处理器抛错（已初始化）时锁也在 finally 里释放，不会把接口永久卡成 409', async () => {
    const shared = makeLockCollection();
    const w = makeWorker(shared, { checkHasInited: jest.fn(async () => true) });
    await expect(w.controller.initSystem({ username: 'u' } as any, undefined, {} as any)).rejects.toThrow(/已初始化/);
    expect(shared.docs.size).toBe(0);
    // 下一次仍可正常抢锁（换成未初始化的 provider）
    const w2 = makeWorker(shared);
    await expect(w2.controller.initSystem({ username: 'u' } as any, undefined, {} as any)).resolves.toMatchObject({
      statusCode: 200,
    });
  });

  it('⚠️ 被 409 挡掉的请求**不会**把正在跑那一次的锁放掉（归属检查）', async () => {
    const shared = makeLockCollection();
    const holder = makeWorker(shared);
    const held = await holder.provider.acquireInitRestoreLock();
    if (held.kind !== 'acquired') throw new Error('前置失败：没抢到锁');
    const ownerBefore = shared.docs.get(INIT_RESTORE_LOCK_NAME)?.owner;
    expect(ownerBefore).toBeTruthy();

    // 两个"第三者"接连撞锁
    for (const w of [makeWorker(shared), makeWorker(shared)]) {
      await expect(w.controller.initSystem({ username: 'x' } as any, undefined, {} as any)).rejects.toBeInstanceOf(
        HttpException,
      );
    }
    // 锁还在、owner 没变（被拒的请求放不掉别人的锁）
    expect(shared.docs.get(INIT_RESTORE_LOCK_NAME)?.owner).toBe(ownerBefore);
    // 持有者自己能释放
    expect(await holder.provider.releaseInitRestoreLock(held.handle.owner)).toBe(true);
    expect(shared.docs.size).toBe(0);
  });

  it('锁后端不可用时**降级**为只用进程内闸门，并且 WARN 一次点名（不静默）', async () => {
    const shared = makeLockCollection();
    // 桩 provider：没有 acquireInitRestoreLock（既有的非标准构造路径就是这种形状）
    const provider: any = { checkHasInited: jest.fn(async () => false), init: jest.fn(async () => undefined) };
    const controller = new InitController(
      provider,
      { upload: jest.fn() } as any,
      { activeAll: jest.fn() } as any,
      { backupDir: () => tmp, restore: jest.fn() } as any,
      { init: jest.fn(async () => undefined) } as any,
      { restart: jest.fn(async () => undefined) } as any,
      { invalidateBase: jest.fn() } as any,
    );
    const res: any = await controller.initSystem({ username: 'u' } as any, undefined, {} as any);
    expect(res.statusCode).toBe(200); // 单进程下照常工作，没有因为加锁而变差
    expect(provider.init).toHaveBeenCalledTimes(1);
    const warns = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('acquireInitRestoreLock'));
    expect(warns.length).toBe(1); // 点名一次，不刷屏
    expect(shared.docs.size).toBe(0); // 没有锁后端时不会往集合里写东西
  });

  it('锁后端返回 unavailable（拿不到集合）时也降级 + WARN，而不是把初始化卡死', async () => {
    const provider: any = {
      checkHasInited: jest.fn(async () => false),
      init: jest.fn(async () => undefined),
      acquireInitRestoreLock: async () => ({ kind: 'unavailable', reason: 'no-lock-collection' }),
      releaseInitRestoreLock: jest.fn(async () => false),
    };
    const controller = new InitController(
      provider,
      { upload: jest.fn() } as any,
      { activeAll: jest.fn() } as any,
      { backupDir: () => tmp, restore: jest.fn() } as any,
      { init: jest.fn(async () => undefined) } as any,
      { restart: jest.fn(async () => undefined) } as any,
      { invalidateBase: jest.fn() } as any,
    );
    await expect(controller.initSystem({ username: 'u' } as any, undefined, {} as any)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(provider.releaseInitRestoreLock).not.toHaveBeenCalled(); // 没拿到锁就不该去释放
    expect(warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('跨进程锁不可用'))).toBe(true);
  });

  it('释放锁抛错时不影响接口结果（锁会按 TTL 过期），但要 ERROR 记一笔', async () => {
    const shared = makeLockCollection();
    const w = makeWorker(shared, {
      providerExtra: {
        releaseInitRestoreLock: async () => {
          throw new Error('mongo gone away');
        },
      },
    });
    await expect(w.controller.initSystem({ username: 'u' } as any, undefined, {} as any)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(errorSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('释放初始化/恢复锁失败'))).toBe(true);
  });
});

describe('DB 级 TTL 锁：/init/restore（与 /init 共用同一把锁）', () => {
  it('/init 持锁时，/init/restore 撞锁 409 且**不调用** restore（两条路由共用一把锁）', async () => {
    const shared = makeLockCollection();
    const holder = makeWorker(shared);
    const held = await holder.provider.acquireInitRestoreLock();
    expect(held.kind).toBe('acquired');

    const w = makeWorker(shared);
    await expect(w.controller.restoreFromInitPage(makeRestoreFile(), undefined, {} as any)).rejects.toThrow(
      /已经有一个恢复正在进行（由另一个进程持有锁）/,
    );
    expect(w.restore).not.toHaveBeenCalled();
    expect(shared.docs.size).toBe(1); // 撞锁者没动对方的锁
  });

  it('⚠️ 跨进程真并发：两个 provider 同时抢同一把锁，恰好一个赢（恢复不会叠成半新半旧的库）', async () => {
    const shared = makeLockCollection();
    const a = makeWorker(shared);
    const b = makeWorker(shared);
    const rs = await Promise.all([a.provider.acquireInitRestoreLock(), b.provider.acquireInitRestoreLock()]);
    expect(rs.filter((r) => r.kind === 'acquired')).toHaveLength(1);
    expect(shared.docs.size).toBe(1);
  });

  it('恢复失败时锁被释放、上传的临时文件被清理（不依赖失败发生在哪一步）', async () => {
    const shared = makeLockCollection();
    const w = makeWorker(shared, {
      restore: jest.fn(async () => {
        throw new Error('bad archive');
      }),
    });
    const f = makeRestoreFile();
    // ⚠️ 断言"必然被拒"而不断言具体错误：归档检查可能在 restore 之前就失败，
    //    两种失败路径都必须走 finally 释放锁 —— 那才是要钉的性质。
    await expect(w.controller.restoreFromInitPage(f, undefined, {} as any)).rejects.toBeDefined();
    expect(shared.docs.size).toBe(0);
    expect(fs.existsSync(f.path)).toBe(false);
    expect(isInitRestoreInFlight()).toBe(false);
  });
});

describe('源码级钉子（剥注释后断言；⚠️ 断言"符号出现"是空断言，这里断的是调用形状）', () => {
  const src = stripCommentsForAnchor(
    fs.readFileSync(path.join(__dirname, 'init.controller.ts'), 'utf-8'),
  );

  it('模块级布尔锁不许回来（每进程一份 ⇒ cluster>1 不互斥）', () => {
    expect(src).not.toContain('let initRestoreRunning');
    expect(src).not.toContain('initRestoreRunning = true');
    // 空转反证：同一把尺子量**旧形状**必须命中，否则这条断言是空的
    expect('let initRestoreRunning = false;').toContain('let initRestoreRunning');
  });

  it('两条路由都调跨进程锁，且都在 checkHasInited 之前', () => {
    for (const marker of ["@Post('/init')", "@Post('/init/restore')"]) {
      const start = src.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start);
      const acquireAt = body.indexOf('acquireCrossProcessInitLock(this.initProvider, this.logger)');
      const checkAt = body.indexOf('await this.initProvider.checkHasInited()');
      expect(acquireAt).toBeGreaterThan(-1);
      expect(checkAt).toBeGreaterThan(-1);
      expect(acquireAt).toBeLessThan(checkAt);
    }
  });

  it('两条路由都在 finally 里带归属检查地释放两把锁', () => {
    expect(src.split('await releaseCrossProcessInitLock(this.initProvider, dbLockOwner, this.logger)').length - 1).toBe(2);
    expect(src.split('releaseLocalInitRestoreLock(localOwner)').length - 1).toBeGreaterThanOrEqual(2);
    expect(src.split('if (claimedLock) {').length - 1).toBe(2);
  });

  it('InitProvider 真的实现了这两个锁方法（否则 ?.() 会静默跳过 ⇒ 跨进程互斥形同不存在）', () => {
    const prov = stripCommentsForAnchor(
      fs.readFileSync(path.join(__dirname, '../../../provider/init/init.provider.ts'), 'utf-8'),
    );
    expect(prov).toMatch(/async acquireInitRestoreLock\(\)\s*:\s*Promise<DbLockOutcome>/);
    expect(prov).toMatch(/async releaseInitRestoreLock\(owner: string\)/);
    expect(prov).toContain('acquireDbLock(coll, INIT_RESTORE_LOCK_NAME');
    expect(prov).toContain('releaseDbLock(coll, INIT_RESTORE_LOCK_NAME, owner)');
  });

  it('锁文档落在独立集合，不是 settings（settings 会被整站备份导出/恢复覆盖）', () => {
    const lock = stripCommentsForAnchor(fs.readFileSync(path.join(__dirname, '../../../utils/dbLock.ts'), 'utf-8'));
    expect(lock).toContain("export const DB_LOCK_COLLECTION = 'vanblog_locks'");
    expect(lock).not.toContain("DB_LOCK_COLLECTION = 'settings'");
  });
});
