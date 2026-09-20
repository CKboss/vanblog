import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, HttpException } from '@nestjs/common';

import {
  InitController,
  __resetInitRestoreLockForTest,
  __resetSetupKeyGateWarnForTest,
  isInitRestoreInFlight,
} from './init.controller';
import {
  SETUP_KEY_REQUIRE_ENV,
  clearSetupKey,
  enforceSetupKey,
  generateSetupKey,
} from 'src/provider/init/setupKey';
import { INSTALL_LEDGER_KEY, InitProvider } from 'src/provider/init/init.provider';

/**
 * setup key 在两条匿名初始化路由上的**wire 契约** + `initSystem` 的单飞锁。
 *
 * 钉住的四组行为：
 *  1. `VANBLOG_INIT_REQUIRE_SETUP_KEY` 关闭（默认）时，两条路由的行为与今天
 *     **逐字节一致**：不看密钥、不加字段、成功信封一字不变 —— "默认关"是这个
 *     特性能现在就发布的全部理由，必须有测试钉住；
 *  2. 开启时：没带/带错 ⇒ 400，body 里有 `setupKeyRequired:true` 与指路消息
 *     （启动日志那一行 + `<日志目录>/setup.key`），密钥绝不回显；带对 ⇒ 照常初始化；
 *     服务端自己没密钥 ⇒ 500 `setupKeyUnavailable`（填了也没用，不骗人）；
 *  3. 单飞锁：并发 `/init` 只有一个成功（另一个 409），被拒的请求**不许**放掉
 *     正在跑那次的锁（归属检查，§7.55 B 记录在案的坑）；`/init` 与 `/init/restore`
 *     **共用一把锁**（跨路由竞态 = 归档恢复与向导初始化互相踩）；
 *  4. 安装记录：成功后 `recordInstallation` 收到 route/req/archiveName，
 *     台账 entry 是 `{key:'install:initialised', kind:'install', detail:{at,route,
 *     socketIp,trustedClientIp,userAgent,archiveName?}}`。
 *
 * restore 路径的既有护栏（403/409/归档校验/临时文件清理）在
 * src/audit-hardening-round3-initrestore.spec.ts，这里不重复、也绝不能弄红它。
 */

jest.mock('src/utils/fullBackup', () => {
  const actual = jest.requireActual('src/utils/fullBackup');
  return { ...actual, inspectFullBackup: jest.fn(), assertRestorableArchive: jest.fn() };
});
jest.mock('src/utils/publicMetaCache', () => {
  const actual = jest.requireActual('src/utils/publicMetaCache');
  return { ...actual, invalidatePublicMetaCache: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fullBackup = require('src/utils/fullBackup');
const mockedInspect = fullBackup.inspectFullBackup as jest.Mock;
const mockedAssert = fullBackup.assertRestorableArchive as jest.Mock;

const MANIFEST = {
  kind: 'vanblog-full-backup',
  version: 1,
  createdAt: '2026-09-13T14:09:55.000Z',
  databases: { vanBlog: { collections: { users: { count: 1 }, articles: { count: 3 } } } },
};

let tmp: string;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeReq() {
  return {
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
    headers: {
      'x-forwarded-for': '203.0.113.7, 198.51.100.9',
      'user-agent': 'Mozilla/5.0 (Fixture Browser)',
    },
  } as any;
}

/** 桩 provider（形状对齐 audit-hardening-round3-initrestore.spec 的用法） */
function makeStubInitProvider(over: { hasInited?: boolean | (() => Promise<boolean>) } = {}) {
  return {
    checkHasInited: jest.fn(async () =>
      typeof over.hasInited === 'function' ? over.hasInited() : Boolean(over.hasInited),
    ),
    init: jest.fn(async () => '初始化成功!'),
    invalidateInitCache: jest.fn(),
    recordInstallation: jest.fn(async () => undefined),
    // 生产 InitProvider 的闸门就是委托给模块纯函数；桩照做（wire 行为完全一致）
    assertSetupKeyAllowed: jest.fn((supplied: unknown) => enforceSetupKey(supplied)),
  };
}

function makeController(initProvider: any, over: { restore?: jest.Mock } = {}) {
  const fullBackupProvider = {
    backupDir: () => path.join(tmp, 'backups'),
    restore:
      over.restore ||
      jest.fn(async () => ({ ms: 2750, databases: {}, static: {}, manifest: MANIFEST, notes: [] })),
  };
  const controller = new InitController(
    initProvider,
    { upload: jest.fn() } as any,
    { activeAll: jest.fn() } as any,
    fullBackupProvider as any,
    { init: jest.fn(async () => undefined) } as any,
    { restart: jest.fn(async () => undefined) } as any,
    { invalidateBase: jest.fn() } as any,
  );
  return { controller, fullBackupProvider };
}

function makeRestoreFile(originalname = 'vanblog-full-20260913-140955.tar.zst') {
  const p = path.join(tmp, `upload-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, 'not-really-an-archive');
  return { path: p, originalname, size: 21 } as any;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-init-setupkey-'));
  __resetInitRestoreLockForTest();
  delete process.env[SETUP_KEY_REQUIRE_ENV];
  clearSetupKey(tmp); // 清模块内存（文件在 tmp，本来就没有）
  mockedInspect.mockReset();
  mockedAssert.mockReset();
  mockedInspect.mockResolvedValue(MANIFEST);
  mockedAssert.mockResolvedValue(12);
});

afterEach(() => {
  delete process.env[SETUP_KEY_REQUIRE_ENV];
  clearSetupKey(tmp);
  __resetInitRestoreLockForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('VANBLOG_INIT_REQUIRE_SETUP_KEY=false（显式逃生口）：行为与旧版逐字节一致', () => {
  beforeEach(() => {
    process.env[SETUP_KEY_REQUIRE_ENV] = 'false';
  });

  it('POST /init 不带密钥照常成功，信封一字不变，也没有任何新字段', async () => {
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller } = makeController(initProvider);
    const dto: any = { user: { username: 'a', password: 'b' }, siteInfo: {} };
    const res: any = await controller.initSystem(dto, undefined, fakeReq());
    expect(res).toEqual({ statusCode: 200, message: '初始化成功!' });
    expect(res.setupKeyRequired).toBeUndefined();
    expect(initProvider.init).toHaveBeenCalledWith(dto);
  });

  it('POST /init 多带一个 setupKey 字段也被无视（升级中的前端/curl 用户不会被弄坏）', async () => {
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller } = makeController(initProvider);
    const res: any = await controller.initSystem({} as any, 'whatever-not-checked', fakeReq());
    expect(res).toEqual({ statusCode: 200, message: '初始化成功!' });
    expect(initProvider.init).toHaveBeenCalledTimes(1);
  });

  it('POST /init/restore 不带密钥照常走完全程（既有护栏一个不少）', async () => {
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller, fullBackupProvider } = makeController(initProvider);
    const file = makeRestoreFile();
    const res: any = await controller.restoreFromInitPage(file, undefined, fakeReq());
    expect(res.statusCode).toBe(200);
    // ⚠️ 第三个参数是加密归档的口令：没传 `backupPassphrase` 时必须是 **null**
    //    （不是 undefined —— null 表示"明确要求走 env 回落"，语义见
    //    fullBackup.provider.ts 的 restore()）。这条断言原来钉的是两参形状，
    //    本轮加了口令参数后升级成三参，**保护的性质不变**：走完全程 + 临时文件被清理。
    expect(fullBackupProvider.restore).toHaveBeenCalledWith(file.path, true, null);
    expect(fs.existsSync(file.path)).toBe(false); // 临时文件照旧清理
  });

  it('已初始化时仍然是 500「已初始化」/ 403，不透露任何密钥相关细节', async () => {
    const initProvider = makeStubInitProvider({ hasInited: true });
    const { controller } = makeController(initProvider);
    await expect(controller.initSystem({} as any, undefined, fakeReq())).rejects.toThrow('已初始化');
    await expect(
      controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq()),
    ).rejects.toThrow(/已经初始化/);
    expect(initProvider.init).not.toHaveBeenCalled();
  });
});

describe('VANBLOG_INIT_REQUIRE_SETUP_KEY 默认（未设置 = 开）：POST /init 的密钥闸门', () => {
  beforeEach(() => {
    // ⚠️ 刻意**不设置**：这些用例钉的就是新默认（未设置 = 要求密钥）
    delete process.env[SETUP_KEY_REQUIRE_ENV];
  });

  it('没带密钥 ⇒ 400，body 有 setupKeyRequired:true + reason，消息指路（文件路径 + docker logs），init 一次都不跑', async () => {
    const { key } = generateSetupKey(tmp); // 服务端有密钥（内存），请求没带
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller } = makeController(initProvider);
    let body: any;
    try {
      await controller.initSystem({} as any, undefined, fakeReq());
      throw new Error('不该成功');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      body = (err as BadRequestException).getResponse();
    }
    expect(body.statusCode).toBe(400);
    expect(body.setupKeyRequired).toBe(true);
    expect(body.reason).toBe('setupKeyMissing');
    expect(body.message).toContain('setupKey'); // 字段名
    expect(body.message).toContain('docker logs'); // 去哪找
    expect(body.message).toContain('setup.key'); // 文件名
    expect(body.message).not.toContain(key); // 密钥绝不回显
    expect(initProvider.init).not.toHaveBeenCalled();
  });

  it('带错密钥 ⇒ 400 reason:setupKeyWrong，消息说"不正确"并同样指路', async () => {
    generateSetupKey(tmp);
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller } = makeController(initProvider);
    let body: any;
    try {
      await controller.initSystem({} as any, 'definitely-not-the-key', fakeReq());
      throw new Error('不该成功');
    } catch (err) {
      body = (err as BadRequestException).getResponse();
    }
    expect(body.statusCode).toBe(400);
    expect(body.setupKeyRequired).toBe(true);
    expect(body.reason).toBe('setupKeyWrong');
    expect(body.message).toContain('不正确');
    expect(initProvider.init).not.toHaveBeenCalled();
  });

  it('带对密钥（含尾部换行的粘贴形状）⇒ 照常初始化', async () => {
    const { key } = generateSetupKey(tmp);
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller } = makeController(initProvider);
    const res: any = await controller.initSystem({} as any, `${key}\n`, fakeReq());
    expect(res).toEqual({ statusCode: 200, message: '初始化成功!' });
    expect(initProvider.init).toHaveBeenCalledTimes(1);
  });

  it('服务端自己没有密钥（文件被删且进程没重启）⇒ 500 setupKeyUnavailable，不骗用户去填', async () => {
    clearSetupKey(tmp); // 清内存；文件在 config.log 路径 —— 确保它不存在
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('src/config');
    fs.rmSync(path.join(config.log || '/var/log', 'setup.key'), { force: true });
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller } = makeController(initProvider);
    let err: any;
    try {
      await controller.initSystem({} as any, 'anything', fakeReq());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(500);
    expect(err.getResponse().setupKeyUnavailable).toBe(true);
    expect(initProvider.init).not.toHaveBeenCalled();
  });

  it('POST /init/restore 同样被闸门挡住：400 时连清单都不读、restore 一次都不跑', async () => {
    generateSetupKey(tmp);
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller, fullBackupProvider } = makeController(initProvider);
    const file = makeRestoreFile();
    let body: any;
    try {
      await controller.restoreFromInitPage(file, 'wrong-key', fakeReq());
    } catch (err) {
      body = (err as BadRequestException).getResponse();
    }
    expect(body.statusCode).toBe(400);
    expect(body.setupKeyRequired).toBe(true);
    expect(mockedInspect).not.toHaveBeenCalled();
    expect(fullBackupProvider.restore).not.toHaveBeenCalled();
    expect(fs.existsSync(file.path)).toBe(false); // 被拒也要清理临时文件
  });

  it('POST /init/restore 带对密钥（multipart 文本字段 setupKey）⇒ 照常恢复', async () => {
    const { key } = generateSetupKey(tmp);
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller, fullBackupProvider } = makeController(initProvider);
    const res: any = await controller.restoreFromInitPage(makeRestoreFile(), key, fakeReq());
    expect(res.statusCode).toBe(200);
    expect(fullBackupProvider.restore).toHaveBeenCalledTimes(1);
  });

  it('已初始化优先于密钥检查：403/500 的消息里不出现 setupKeyRequired（对跑着的站点不透露细节）', async () => {
    generateSetupKey(tmp);
    const initProvider = makeStubInitProvider({ hasInited: true });
    const { controller } = makeController(initProvider);
    let err: any;
    try {
      await controller.initSystem({} as any, undefined, fakeReq());
    } catch (e) {
      err = e;
    }
    expect(err.getStatus()).toBe(500);
    expect(err.getResponse()).toBe('已初始化');
    let err2: any;
    try {
      await controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq());
    } catch (e) {
      err2 = e;
    }
    expect(err2.getStatus()).toBe(403);
    expect(JSON.stringify(err2.getResponse())).not.toContain('setupKeyRequired');
  });
});

describe('POST /init 的单飞锁（与 /init/restore 共用一把）', () => {
  // 锁的用例与密钥无关：显式走逃生口，避免默认开启的闸门把断言目标换掉
  beforeEach(() => {
    process.env[SETUP_KEY_REQUIRE_ENV] = 'false';
  });

  it('并发两个 /init ⇒ 只有一个真正初始化，另一个 409；被拒的那个不许放掉别人的锁', async () => {
    let started = 0;
    const initProvider = makeStubInitProvider({ hasInited: false });
    const initGate = deferred<any>();
    initProvider.init.mockImplementation(() => {
      started += 1;
      return initGate.promise;
    });
    // ⚠️ 竞态的**决定性形状**（第一版用"两个请求卡在同一个 checkHasInited 闸门上"
    // 是抓不到"锁落在 await 之后"的：同一个 promise 的续体按注册序跑，先醒的那个
    // 总会先落锁）。真正会双初始化的时序是：
    //   B 在 A 持锁期间到达、B 的 checkHasInited 返回 false（A 还没写完库）、
    //   A 完成并释放锁**之后** B 的检查才回来 —— 锁在 await 之后的话 B 此刻看到
    //   锁是空的，直接二次初始化（两个 id:0 用户）。
    // 所以：A 的 checkHasInited 立刻回，B 的 checkHasInited 用手动闸门卡到 A 释放锁之后。
    const checkGate = deferred<boolean>();
    initProvider.checkHasInited
      .mockImplementationOnce(async () => false) // A
      .mockImplementationOnce(() => checkGate.promise as any); // B
    const { controller } = makeController(initProvider);

    const a = controller.initSystem({} as any, undefined, fakeReq());
    await new Promise((r) => setTimeout(r, 10)); // A 已落锁并卡在 init() 里
    const b = controller.initSystem({} as any, undefined, fakeReq()); // 正确实现：同步 409
    // ⚠️ 立刻挂上 rejects 断言（返回的 promise 稍后再 await）：b 在正确实现下
    // **当场**就是 rejected，裸放着会被 jest 当成 unhandledRejection 直接判失败
    const bExpect = expect(b).rejects.toThrow(/已经有一个初始化\/恢复正在进行/);
    await new Promise((r) => setTimeout(r, 10));

    // 归属检查：A 还在跑时，第三个请求也 409，而且**被拒的请求不许把 A 的锁放掉**
    await expect(controller.initSystem({} as any, undefined, fakeReq())).rejects.toThrow(
      /已经有一个初始化\/恢复正在进行/,
    );
    expect(isInitRestoreInFlight()).toBe(true);
    await expect(controller.initSystem({} as any, undefined, fakeReq())).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(isInitRestoreInFlight()).toBe(true); // 两次 409 都没把锁放掉（§7.55 B 的坑）

    initGate.resolve('初始化成功!'); // A 完成、释放锁
    const okA: any = await a;
    expect(okA).toEqual({ statusCode: 200, message: '初始化成功!' });

    checkGate.resolve(false); // B 的"未初始化"结论此刻才回来 —— 锁晚落的话 B 现在会二次初始化
    await new Promise((r) => setTimeout(r, 10));
    await bExpect;
    expect(started).toBe(1); // 决定性断言：init 只跑了一次
    expect(initProvider.init).toHaveBeenCalledTimes(1);
    expect(isInitRestoreInFlight()).toBe(false); // 成功后锁必须释放
  });

  it('init() 抛错之后锁会释放（否则接口永久 409，而站点还没初始化 ⇒ 只能重启容器）', async () => {
    const initProvider = makeStubInitProvider({ hasInited: false });
    initProvider.init.mockRejectedValueOnce(new Error('mongo 抖动'));
    const { controller } = makeController(initProvider);
    await expect(controller.initSystem({} as any, undefined, fakeReq())).rejects.toThrow(
      'mongo 抖动',
    );
    expect(isInitRestoreInFlight()).toBe(false);
    // 立刻可以重试
    const res: any = await controller.initSystem({} as any, undefined, fakeReq());
    expect(res.statusCode).toBe(200);
  });

  it('跨路由互斥：/init 在跑时 /init/restore 409；/init/restore 在跑时 /init 也 409', async () => {
    const gate = deferred<any>();
    const initProvider = makeStubInitProvider({ hasInited: false });
    initProvider.init.mockImplementation(() => gate.promise);
    const { controller } = makeController(initProvider);
    const first = controller.initSystem({} as any, undefined, fakeReq());
    await new Promise((r) => setTimeout(r, 10));
    await expect(
      controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq()),
    ).rejects.toThrow(/已经有一个恢复正在进行/);
    gate.resolve('初始化成功!');
    await first;

    // 反方向：restore 在跑时 /init 被挡
    const gate2 = deferred<any>();
    const restore2 = jest.fn(() => gate2.promise) as any;
    const initProvider2 = makeStubInitProvider({ hasInited: false });
    const c2 = makeController(initProvider2, { restore: restore2 });
    const restorePromise = c2.controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq());
    await new Promise((r) => setTimeout(r, 10));
    await expect(c2.controller.initSystem({} as any, undefined, fakeReq())).rejects.toThrow(
      /已经有一个初始化\/恢复正在进行/,
    );
    gate2.resolve({ ms: 1, databases: {}, static: {}, manifest: MANIFEST, notes: [] });
    await restorePromise;
    expect(isInitRestoreInFlight()).toBe(false);
  });

  it('源码级钉子：锁在**第一个 await 之前**同步拿到，finally 里带归属检查释放', () => {
    const src = fs.readFileSync(path.join(__dirname, 'init.controller.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    const initHandler = src.slice(src.indexOf("@Post('/init')"), src.indexOf("@Post('/init/upload')"));
    // ⚠️ 2026-09-19 起锁是两道的（进程内令牌 + DB 级 TTL 锁），原来钉的
    // `initRestoreRunning = true` 是每进程一份的布尔量，cluster>1 时不互斥。
    expect(initHandler).toContain('claimLocalInitRestoreLock()');
    expect(initHandler.indexOf('claimLocalInitRestoreLock()')).toBeLessThan(
      initHandler.indexOf('await this.initProvider.checkHasInited()'),
    );
    // 跨进程那把也必须落在 checkHasInited 之前
    expect(initHandler.indexOf('acquireCrossProcessInitLock(')).toBeLessThan(
      initHandler.indexOf('await this.initProvider.checkHasInited()'),
    );
    expect(initHandler).toContain('if (claimedLock)');
    expect(src).not.toContain('let initRestoreRunning');
    // 两条路由都必须过 setup key 闸门（经由 provider，桩容忍见下），且成功路径都记安装台账
    expect(src.split('runSetupKeyGate(this.initProvider, setupKey, this.logger)').length - 1).toBe(2);
    // 生产的 InitProvider 必须有闸门方法（否则 ?.() 会静默跳过 —— 两侧都钉住才闭环）
    expect(typeof InitProvider.prototype.assertSetupKeyAllowed).toBe('function');
    expect(src.split('recordInstallation?.(').length - 1).toBe(2);
    // restore 成功后清密钥必须只在 initialized 时（归档没带 users 时向导还要用）
    expect(src).toContain('if (initialized) {');
    // InitController 整个不挂 AdminGuard（匿名可达是设计如此，护栏在处理器里）
    expect(src).not.toMatch(/@UseGuards/);
  });
});

describe('闸门的桩容忍分支（仅非标准构造路径会走到）', () => {
  it('桩 InitProvider 没有 assertSetupKeyAllowed → 跳过校验并每进程 WARN 一次（既有 pinned specs 的兼容面）', async () => {
    __resetSetupKeyGateWarnForTest();
    const bare: any = {
      checkHasInited: jest.fn(async () => false),
      init: jest.fn(async () => '初始化成功!'),
      invalidateInitCache: jest.fn(),
    };
    const { controller } = makeController(bare);
    const res: any = await controller.initSystem({} as any, undefined, fakeReq());
    expect(res).toEqual({ statusCode: 200, message: '初始化成功!' });
    // 第二次不再 WARN（每进程一次，绝不刷屏也绝不静默）
    const warn = jest.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
    await controller.initSystem({} as any, undefined, fakeReq());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    __resetSetupKeyGateWarnForTest();
  });

  it('显式 true 与默认（未设置）行为一致：都要求密钥', async () => {
    const { key } = generateSetupKey(tmp);
    process.env[SETUP_KEY_REQUIRE_ENV] = 'true';
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller } = makeController(initProvider);
    let body: any;
    try {
      await controller.initSystem({} as any, 'nope', fakeReq());
    } catch (err) {
      body = (err as BadRequestException).getResponse();
    }
    expect(body.setupKeyRequired).toBe(true);
    const ok: any = await controller.initSystem({} as any, key, fakeReq());
    expect(ok.statusCode).toBe(200);
    delete process.env[SETUP_KEY_REQUIRE_ENV];
  });
});

describe('安装记录：两条路由成功后都进迁移台账（key=install:initialised）', () => {
  // 台账的用例与密钥无关：显式走逃生口，让断言只盯着 recordInstallation
  beforeEach(() => {
    process.env[SETUP_KEY_REQUIRE_ENV] = 'false';
  });

  it('/init 成功 ⇒ recordInstallation(route:init, req) ⇒ 台账 detail 含两种 IP 与 UA，密码绝不出现', async () => {
    const recorded: any[] = [];
    const recorder = {
      record: jest.fn(async (e: any) => recorded.push(e)),
      recordSkipped: jest.fn(),
      run: jest.fn(),
      list: jest.fn(),
      warnAboutErrors: jest.fn(),
    };
    // 真 InitProvider（桩 model）+ 假台账：连 recordInstallation 的真实实现一起验
    const userModel: any = {
      findOne: jest.fn(() => ({ lean: () => ({ exec: async () => null }) })),
      create: jest.fn(async (d: any) => d),
    };
    const provider = new InitProvider(
      { create: jest.fn(async () => ({})), findOne: jest.fn(async () => null) } as any,
      userModel,
      {} as any,
      {} as any,
      { init: jest.fn(async () => undefined) } as any,
      {
        updateCommentSetting: jest.fn(async () => undefined),
        updateMenuSetting: jest.fn(async () => undefined),
      } as any,
      { set: jest.fn() } as any,
      { restart: jest.fn() } as any,
      recorder as any,
    );
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const { controller } = makeController(provider);
    const dto: any = {
      user: { username: 'OwnerFixture', password: 'browser-derived-fixture' },
      siteInfo: {},
    };
    const res: any = await controller.initSystem(dto, undefined, fakeReq());
    expect(res).toEqual({ statusCode: 200, message: '初始化成功!' });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].key).toBe(INSTALL_LEDGER_KEY);
    expect(recorded[0].kind).toBe('install');
    expect(recorded[0].detail).toMatchObject({
      route: 'init',
      socketIp: '127.0.0.1',
      trustedClientIp: '198.51.100.9',
      userAgent: 'Mozilla/5.0 (Fixture Browser)',
    });
    // WARN 的安装日志与台账里都不许出现密码（哪怕是浏览器派生值）
    const warnText = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).toContain('"route":"init"');
    expect(warnText).not.toContain('browser-derived-fixture');
    expect(JSON.stringify(recorded[0].detail)).not.toContain('browser-derived-fixture');
    warn.mockRestore();
  });

  it('/init/restore 成功 ⇒ 台账带 archiveName；桩 provider 没有该方法时也绝不弄坏恢复（?. 调用）', async () => {
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller } = makeController(initProvider);
    await controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq());
    expect(initProvider.recordInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'init/restore', archiveName: 'vanblog-full-20260913-140955.tar.zst' }),
    );
    // 没有 recordInstallation 的老桩（既有测试的形状）：恢复照常成功
    const bare: any = {
      checkHasInited: jest.fn(async () => false),
      invalidateInitCache: jest.fn(),
    };
    const c2 = makeController(bare);
    const res: any = await c2.controller.restoreFromInitPage(makeRestoreFile(), undefined, fakeReq());
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 加密归档的口令贯穿（body → 体积闸门 → 恢复）
//
// ⚠️ 这组用例钉的是**参数位置**与"口令只从 body 来、绝不进响应/日志"这两件事。
// 前者不是洁癖：`restoreFromInitPage` 在测试里是按位置调用的，本轮新增口令参数时
// 一度插在 `req` 之前，结果既有调用把 `req` 喂进了口令位、把 `undefined` 喂进了 req 位 ——
// **不报错**，只是 `recordInstallation` 静默少记了来源 IP。插回末尾并加了下面第三条守卫。
// ---------------------------------------------------------------------------
describe('加密归档的口令贯穿（body → 前置闸门 → 恢复）', () => {
  beforeEach(() => {
    process.env[SETUP_KEY_REQUIRE_ENV] = 'false';
  });

  it('body 带了 backupPassphrase ⇒ 体积闸门与恢复都拿到它，且响应里不含口令', async () => {
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller, fullBackupProvider } = makeController(initProvider);
    const file = makeRestoreFile('vanblog-full-20260920-010101.tar.gz.enc');
    const passphrase = 'a-passphrase-that-came-from-the-body';
    const res: any = await controller.restoreFromInitPage(file, undefined, fakeReq(), passphrase);
    expect(res.statusCode).toBe(200);
    // 前置闸门必须拿到口令：否则"数成员总字节"要在解密后才能做，没口令就会失败在
    // 一个说不清原因的地方（而不是那句"这份归档是加密的 + 两条可照做的办法"）
    // ⚠️ 2026-09-20 起第二个参数多了一个 `backupDir`：匿名恢复路径以前**没传**它，
    //    于是"用 POST /api/admin/backup/signing/key 生成过密钥、但没配 env"的部署
    //    在灾难恢复路径上永远只能得到 no-key（放行 + WARN）⇒ 验签静默失效。
    //    这里按"升级而非放宽"处理：仍然精确匹配（多一个键/少一个键/passphrase 变了都会红），
    //    并额外钉住 backupDir 来自 provider（不是硬编码的假路径）。
    expect(mockedAssert).toHaveBeenCalledWith(file.path, {
      passphrase,
      backupDir: fullBackupProvider.backupDir(),
    });
    expect(fullBackupProvider.restore).toHaveBeenCalledWith(file.path, true, passphrase);
    // ⚠️ 口令绝不许出现在响应体里（它会进后台的日志与浏览器历史）
    expect(JSON.stringify(res)).not.toContain(passphrase);
  });

  it('没带口令 ⇒ 两处都是 null（回落到 env），不是 undefined', async () => {
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller, fullBackupProvider } = makeController(initProvider);
    const file = makeRestoreFile('vanblog-full-20260920-010101.tar.gz.enc');
    const res: any = await controller.restoreFromInitPage(file, undefined, fakeReq());
    expect(res.statusCode).toBe(200);
    expect(mockedAssert).toHaveBeenCalledWith(file.path, {
      passphrase: null,
      backupDir: fullBackupProvider.backupDir(),
    });
    expect(fullBackupProvider.restore).toHaveBeenCalledWith(file.path, true, null);
  });

  it('⚠️ 参数顺序守卫：第三个位置参数仍然是 req（新增参数只许加在末尾）', async () => {
    const initProvider = makeStubInitProvider({ hasInited: false });
    const { controller } = makeController(initProvider);
    const file = makeRestoreFile('vanblog-full-20260920-010101.tar.gz.enc');
    const req = fakeReq();
    await controller.restoreFromInitPage(file, undefined, req);
    // 安装台账要拿到**那个 req**（它从里面取来源 IP）。
    // 如果有人把口令参数插回 req 之前，这里会收到 undefined ⇒ 台账静默丢掉来源 IP，
    // 而所有其它断言仍然是绿的。这条就是为了在那一刻变红。
    expect(initProvider.recordInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'init/restore', req }),
    );
  });
});
