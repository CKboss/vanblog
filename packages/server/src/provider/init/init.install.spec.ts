import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  INSTALL_LEDGER_KEY,
  InitProvider,
} from './init.provider';
import {
  ENV_ADMIN_PASSWORD,
  ENV_ADMIN_PASSWORD_FILE,
  ENV_ADMIN_USER,
  deriveBrowserPassword,
} from './envBootstrap';
import { SETUP_KEY_REMIND_ENV, SETUP_KEY_REQUIRE_ENV, clearSetupKey, currentSetupKey } from './setupKey';
import { isScryptHash, verifyUserPassword } from 'src/utils/crypto';

/**
 * 安装记录（迁移台账）+ 环境变量自动初始化 + setup key 启动生命周期。
 *
 * 三件事的共同点：都发生在"站点从无到有"的那一刻，都必须是**大声的、可归因的**：
 *  - 台账一行 `install:initialised`（kind:'install'，detail 是
 *    `{at,route,socketIp,trustedClientIp,userAgent,archiveName?}` 的 JSON）+ WARN 一条；
 *  - env 引导成功 → WARN"已由环境变量自动初始化"；被拒 → ERROR 且写清后果
 *    （站点仍未初始化、匿名接口仍开放）；已初始化 → INFO"忽略"；
 *  - setup key 只在"未初始化 + 开关开"时生成（WARN 一次，含密钥，与 restore.key 同路数），
 *    其余情况清掉遗留文件。
 *
 * ⚠️ 所有密码/密钥都是夹具；所有文件操作都指向临时目录（refreshSetupKey 的 logDir 参数）。
 */

let tmp: string;

function stubDeps(userDocs: any[] = []) {
  const created: { users: any[]; metas: any[] } = { users: [], metas: [] };
  const userModel: any = {
    findOne: jest.fn(() => ({
      lean: () => ({ exec: async () => (userDocs.length ? { ...userDocs[0] } : null) }),
    })),
    create: jest.fn(async (doc: any) => {
      created.users.push(doc);
      userDocs.push(doc);
      return doc;
    }),
  };
  const metaModel: any = {
    create: jest.fn(async (doc: any) => {
      created.metas.push(doc);
      return doc;
    }),
    findOne: jest.fn(async () => null),
  };
  const deps = {
    walineProvider: { init: jest.fn(async () => undefined) },
    settingProvider: {
      updateCommentSetting: jest.fn(async () => undefined),
      updateMenuSetting: jest.fn(async () => undefined),
      getVersionSetting: jest.fn(async () => ({ version: 'test' })),
      updateVersionSetting: jest.fn(async () => undefined),
    },
    cacheProvider: { set: jest.fn(async () => undefined), get: jest.fn() },
    websiteProvider: { restart: jest.fn(async () => undefined) },
  };
  const recorded: any[] = [];
  const recorder = {
    record: jest.fn(async (entry: any) => {
      recorded.push(entry);
    }),
    recordSkipped: jest.fn(async () => undefined),
    run: jest.fn(async (_spec: any, task: any) => task()),
    list: jest.fn(async () => []),
    warnAboutErrors: jest.fn(async () => []),
  };
  const provider = new InitProvider(
    metaModel,
    userModel,
    {} as any,
    {} as any,
    deps.walineProvider as any,
    deps.settingProvider as any,
    deps.cacheProvider as any,
    deps.websiteProvider as any,
    recorder as any,
  );
  return { provider, userModel, metaModel, deps, recorded, recorder, created };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-install-'));
  delete process.env[SETUP_KEY_REQUIRE_ENV];
  delete process.env[SETUP_KEY_REMIND_ENV];
  delete process.env[ENV_ADMIN_USER];
  delete process.env[ENV_ADMIN_PASSWORD];
  delete process.env[ENV_ADMIN_PASSWORD_FILE];
  clearSetupKey(tmp);
});

afterEach(() => {
  delete process.env[SETUP_KEY_REQUIRE_ENV];
  delete process.env[SETUP_KEY_REMIND_ENV];
  delete process.env[ENV_ADMIN_USER];
  delete process.env[ENV_ADMIN_PASSWORD];
  delete process.env[ENV_ADMIN_PASSWORD_FILE];
  clearSetupKey(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('recordInstallation：安装记录进迁移台账（一次安装一条，事后可归因）', () => {
  const fakeReq = () =>
    ({
      socket: { remoteAddress: '127.0.0.1' }, // 出厂拓扑：caddy 在同一容器，从回环拨过来
      ip: '127.0.0.1',
      headers: {
        // caddy 追加真实对端：最右一项才是"可信代理亲眼看到的对端"
        'x-forwarded-for': '203.0.113.7, 198.51.100.9',
        'user-agent': 'Mozilla/5.0 (Fixture Browser)',
      },
    }) as any;

  it('向导 init：key/kind/outcome 正确，detail 是 {at,route,socketIp,trustedClientIp,userAgent} 的 JSON，且 WARN 一条', async () => {
    const { provider, recorded } = stubDeps();
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const at = new Date('2026-09-17T06:00:00.000Z');
    await provider.recordInstallation({ route: 'init', req: fakeReq(), at, durationMs: 42 });

    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    expect(entry.key).toBe(INSTALL_LEDGER_KEY);
    expect(entry.key).toBe('install:initialised');
    expect(entry.kind).toBe('install'); // MigrationKind 新增的枚举值（schema 的 kind 本来就是普通 string）
    expect(entry.outcome).toBe('ok');
    expect(entry.durationMs).toBe(42);
    expect(entry.ranAt).toEqual(at);
    // socketIp 与 trustedClientIp **分开存**：回环拓扑里只有 trusted 那个能指认安装者
    expect(entry.detail).toEqual({
      at: '2026-09-17T06:00:00.000Z',
      route: 'init',
      socketIp: '127.0.0.1',
      trustedClientIp: '198.51.100.9', // auto 模式：对端回环 ⇒ 采信 XFF 最右一项
      userAgent: 'Mozilla/5.0 (Fixture Browser)',
    });
    expect(entry.detail.archiveName).toBeUndefined();

    // WARN（不是 INFO）：必须活过"隐藏 routine 噪音"的日志级别
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    expect(text).toContain(INSTALL_LEDGER_KEY);
    expect(text).toContain('"route":"init"');
    expect(text).toContain('198.51.100.9');
    warn.mockRestore();
  });

  it('restore 路由：detail 多一个 archiveName（站长上传的归档名，归因用）', async () => {
    const { provider, recorded } = stubDeps();
    jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    await provider.recordInstallation({
      route: 'init/restore',
      req: fakeReq(),
      archiveName: 'vanblog-full-20260913-140955.tar.zst',
      durationMs: 3750,
    });
    expect(recorded[0].detail).toMatchObject({
      route: 'init/restore',
      archiveName: 'vanblog-full-20260913-140955.tar.zst',
    });
  });

  it('env-bootstrap 路由：没有请求可归属 ⇒ 三个请求侧字段是 null，route 把安装方式区分出来', async () => {
    const { provider, recorded } = stubDeps();
    jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    await provider.recordInstallation({ route: 'env-bootstrap', durationMs: 7 });
    expect(recorded[0].detail).toEqual({
      at: expect.any(String),
      route: 'env-bootstrap',
      socketIp: null,
      trustedClientIp: null,
      userAgent: null,
    });
  });

  it('超长 userAgent 截到 300 字、归档名截到 200 字（detail 上限 2000，台账不能被一条记录撑爆）', async () => {
    const { provider, recorded } = stubDeps();
    jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const req = fakeReq();
    req.headers['user-agent'] = 'U'.repeat(2000);
    await provider.recordInstallation({ route: 'init', req, archiveName: 'A'.repeat(1000) });
    expect(recorded[0].detail.userAgent).toHaveLength(300);
    expect(recorded[0].detail.archiveName).toHaveLength(200);
  });

  it('没有注入台账（老测试直接 new 8 个参数）→ 回落 NOOP，绝不抛错', async () => {
    const deps = stubDeps();
    const providerNoLedger = new InitProvider(
      deps.metaModel,
      deps.userModel,
      {} as any,
      {} as any,
      deps.deps.walineProvider as any,
      deps.deps.settingProvider as any,
      deps.deps.cacheProvider as any,
      deps.deps.websiteProvider as any,
    );
    await expect(
      providerNoLedger.recordInstallation({ route: 'init', req: fakeReq() }),
    ).resolves.toBeUndefined();
  });
});

describe('bootstrapFromEnv：容器带着凭据启动时，未初始化窗口根本不存在', () => {
  it('全新站点 + USER + PASSWORD_FILE（带尾部换行）→ 建号建站、WARN、台账记 route=env-bootstrap', async () => {
    const secretFile = path.join(tmp, 'admin-password');
    fs.writeFileSync(secretFile, 'fixture-secret-env\n', { mode: 0o600 });
    process.env[ENV_ADMIN_USER] = 'FixtureOwner';
    process.env[ENV_ADMIN_PASSWORD_FILE] = secretFile;

    const { provider, created, recorded } = stubDeps([]);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const res = await provider.bootstrapFromEnv();

    expect(res.done).toBe(true);
    // 管理员：id:0 / type:admin / scrypt 哈希，且哈希对应的是**浏览器派生值**（登录才连得上）
    expect(created.users).toHaveLength(1);
    const user = created.users[0];
    expect(user.id).toBe(0);
    expect(user.name).toBe('FixtureOwner');
    expect(user.type).toBe('admin');
    expect(isScryptHash(user.password)).toBe(true);
    expect(
      verifyUserPassword(user.password, 'FixtureOwner', deriveBrowserPassword('FixtureOwner', 'fixture-secret-env'), user.salt),
    ).toBe(true);
    // 最小站点记录也建了（与向导 initSystem 同一条路）
    expect(created.metas).toHaveLength(1);
    expect(created.metas[0].siteInfo.siteName).toBe('VanBlog');
    // 站点就此"已初始化"：缓存立即生效
    expect(await provider.checkHasInited()).toBe(true);

    // WARN 大声：自动初始化这件事必须一眼可见
    const warnText = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).toContain('自动初始化');
    expect(warnText).toContain('FixtureOwner');
    expect(warnText).toContain(ENV_ADMIN_PASSWORD_FILE); // 指明密码来源（但不含密码）

    // 台账：与向导 init 可区分
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      key: INSTALL_LEDGER_KEY,
      kind: 'install',
      outcome: 'ok',
    });
    expect(recorded[0].detail).toMatchObject({ route: 'env-bootstrap' });

    // 密码与派生值绝不出现在日志或台账里
    const derived = deriveBrowserPassword('FixtureOwner', 'fixture-secret-env');
    for (const blob of [warnText, JSON.stringify(recorded[0].detail)]) {
      expect(blob).not.toContain('fixture-secret-env');
      expect(blob).not.toContain(derived);
    }
    warn.mockRestore();
  });

  it('站点已初始化 → 忽略 env（INFO 一句，让轮换凭据的人知道为什么什么都没发生），一个字都不写', async () => {
    process.env[ENV_ADMIN_USER] = 'FixtureOwner';
    process.env[ENV_ADMIN_PASSWORD] = 'fixture-secret-env2';
    const { provider, created } = stubDeps([{ _id: 'existing' }]);
    const log = jest.spyOn((provider as any).logger, 'log').mockImplementation(() => undefined);
    const res = await provider.bootstrapFromEnv();
    expect(res).toEqual({ done: false, ignored: true });
    expect(created.users).toHaveLength(0);
    const text = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('忽略');
    expect(text).not.toContain('fixture-secret-env2');
    log.mockRestore();
  });

  it('凭据被拒（有 USER 没密码）→ ERROR 大声失败：写明站点仍未初始化、匿名接口仍开放，绝不静默跳过', async () => {
    process.env[ENV_ADMIN_USER] = 'FixtureOwner';
    const { provider, created } = stubDeps([]);
    const error = jest.spyOn((provider as any).logger, 'error').mockImplementation(() => undefined);
    const res = await provider.bootstrapFromEnv();
    expect(res.done).toBe(false);
    expect(res.rejected).toBeTruthy();
    expect(created.users).toHaveLength(0);
    const text = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('被拒绝');
    expect(text).toContain('未初始化');
    expect(text).toContain('抢先初始化');
    error.mockRestore();
  });

  it('init() 本身失败（mongo 抖动）→ ERROR 大声，done:false，且不产生无主 rejection', async () => {
    process.env[ENV_ADMIN_USER] = 'FixtureOwner';
    process.env[ENV_ADMIN_PASSWORD] = 'fixture-secret-env3';
    const deps = stubDeps([]);
    (deps.userModel.create as jest.Mock).mockRejectedValueOnce(new Error('mongo 抖动'));
    const error = jest.spyOn((deps.provider as any).logger, 'error').mockImplementation(() => undefined);
    const unhandled: any[] = [];
    const onUnhandled = (r: any) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    const res = await deps.provider.bootstrapFromEnv();
    await new Promise((r) => setTimeout(r, 20));
    process.removeListener('unhandledRejection', onUnhandled);
    expect(res.done).toBe(false);
    expect(res.rejected).toContain('初始化失败');
    const text = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('mongo 抖动'); // init() 的 catch 现在会把原因写进日志（以前整个吞掉）
    expect(text).not.toContain('fixture-secret-env3');
    expect(unhandled).toHaveLength(0);
    error.mockRestore();
  });

  it('三个变量都没设 → 什么都不发生（启动路径零日志零写入）', async () => {
    const { provider, created } = stubDeps([]);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn((provider as any).logger, 'error').mockImplementation(() => undefined);
    const res = await provider.bootstrapFromEnv();
    expect(res).toEqual({ done: false });
    expect(created.users).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('源码级钉子：onModuleInit 在主实例守卫之内做 env 引导 + setup key 生命周期（不需要改 main.ts）', () => {
    const src = fs.readFileSync(path.join(__dirname, 'init.provider.ts'), 'utf-8');
    expect(src).toContain('async onModuleInit()');
    expect(src).toContain('if (!isPrimaryInstance(cluster))');
    const hook = src.slice(src.indexOf('async onModuleInit()'));
    expect(hook.indexOf('isPrimaryInstance(cluster)')).toBeLessThan(hook.indexOf('bootstrapFromEnv()'));
    expect(hook.indexOf('bootstrapFromEnv()')).toBeLessThan(hook.indexOf('refreshSetupKey()'));
  });
});

describe('refreshSetupKey：未初始化就生成+打印（不再以开关为条件）；已初始化清遗留', () => {
  it('默认（env 全未设置）+ 未初始化 → 生成 0600 密钥文件 + WARN 视觉块 + 排上 10 分钟重印', async () => {
    const { provider } = stubDeps([]);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const si = jest.spyOn(global, 'setInterval').mockReturnValue({ unref: jest.fn() } as any);
    const res = await provider.refreshSetupKey(tmp);
    expect(res).toEqual({ generated: true, clearedStale: false, reminderMinutes: 10 });
    const filePath = path.join(tmp, 'setup.key');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    const key = fs.readFileSync(filePath, 'utf-8');
    expect(warn).toHaveBeenCalledTimes(1);
    const block = String(warn.mock.calls[0][0]);
    // 站长点名的六要素
    expect(block).toContain('尚未完成初始化');
    expect(block).toContain(key);
    expect(block).toContain(filePath);
    expect(block).toContain('docker logs <容器名> 2>&1 | grep 初始化密钥');
    expect(block).toContain('每次重启 vanblog 都会重新生成');
    expect(block).toContain('VANBLOG_INIT_REQUIRE_SETUP_KEY=false'); // 逃生口
    expect(block).toContain('setupKey'); // 接口字段名
    // 定时器：10 分钟、unref（与 ISR 对账/备份巡检同一约定）
    expect(si).toHaveBeenCalledWith(expect.any(Function), 10 * 60 * 1000);
    expect((si.mock.results[0].value as any).unref).toHaveBeenCalled();
    provider.onModuleDestroy();
    si.mockRestore();
    warn.mockRestore();
  });

  it('显式 flag=false（逃生口）→ 密钥**照常**生成并打印（块里写明当前不要求），提醒照排', async () => {
    process.env[SETUP_KEY_REQUIRE_ENV] = 'false';
    process.env[SETUP_KEY_REMIND_ENV] = '0'; // 只印启动一次
    const { provider } = stubDeps([]);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const si = jest.spyOn(global, 'setInterval');
    const res = await provider.refreshSetupKey(tmp);
    expect(res.generated).toBe(true);
    expect(res.reminderMinutes).toBe(0);
    expect(si).not.toHaveBeenCalled(); // 0 = boot only
    const block = String(warn.mock.calls[0][0]);
    expect(block).toContain('不要求');
    expect(block).toContain(fs.readFileSync(path.join(tmp, 'setup.key'), 'utf-8'));
    si.mockRestore();
    warn.mockRestore();
  });

  it('flag 是打错的值 → 按【要求密钥】处理（默认翻转后安全侧是"开"），块里点名坏值', async () => {
    process.env[SETUP_KEY_REQUIRE_ENV] = 'flase';
    process.env[SETUP_KEY_REMIND_ENV] = '0';
    const { provider } = stubDeps([]);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const res = await provider.refreshSetupKey(tmp);
    expect(res.generated).toBe(true);
    const block = String(warn.mock.calls[0][0]);
    expect(block).toContain('无法识别');
    expect(block).toContain('flase');
    expect(block).toContain('要求密钥');
    warn.mockRestore();
  });

  it('已初始化 + 有遗留文件 → 删掉 + INFO 一句，不生成不打印不排提醒', async () => {
    process.env[SETUP_KEY_REQUIRE_ENV] = 'true';
    fs.writeFileSync(path.join(tmp, 'setup.key'), 'stale-fixture-key');
    const { provider } = stubDeps([{ _id: 'existing' }]);
    const log = jest.spyOn((provider as any).logger, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const res = await provider.refreshSetupKey(tmp);
    expect(res).toEqual({ generated: false, clearedStale: true, reminderMinutes: 0 });
    expect(fs.existsSync(path.join(tmp, 'setup.key'))).toBe(false);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('已删除遗留');
    expect(warn).not.toHaveBeenCalled(); // 已初始化的站点（= 生产实况）绝不刷密钥块
    log.mockRestore();
    warn.mockRestore();
  });

  it('周期重印：tick 打的是**同一个缓存块**（零拼接、密钥不变）；已初始化后 tick 永久停表（clearInterval 真的发生）', async () => {
    process.env[SETUP_KEY_REMIND_ENV] = '10';
    // 用假定时器句柄：既不让 jest 吊着真 interval，又能断言 clearInterval 打在那个句柄上
    // （第一版这里用 REMIND=0 不排定时器，"停表"断言检查的是一个从来没被设过的
    //   null 字段 —— NC-D2 把 stopSetupKeyReminders 删掉它照样绿，等于没钉住）
    const fakeTimer = { unref: jest.fn() } as any;
    const si = jest.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);
    const ci = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
    const { provider, userModel } = stubDeps([]);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    await provider.refreshSetupKey(tmp);
    expect((provider as any).setupKeyReminderTimer).toBe(fakeTimer);
    const firstBlock = String(warn.mock.calls[0][0]);
    const keyBefore = fs.readFileSync(path.join(tmp, 'setup.key'), 'utf-8');

    const t1 = await provider.remindSetupKeyTick(tmp);
    expect(t1).toEqual({ printed: true, stopped: false, regenerated: false });
    const t2 = await provider.remindSetupKeyTick(tmp);
    expect(t2.printed).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3); // 启动 1 + 两次重印
    // 重印是同一个字符串（缓存生效，零拼接），密钥没有换
    expect(String(warn.mock.calls[1][0])).toBe(firstBlock);
    expect(String(warn.mock.calls[2][0])).toBe(firstBlock);
    expect(fs.readFileSync(path.join(tmp, 'setup.key'), 'utf-8')).toBe(keyBefore);

    // 站点完成初始化 → 下一次 tick 停表且不再打印
    (userModel.findOne as jest.Mock).mockImplementation(() => ({
      lean: () => ({ exec: async () => ({ _id: 'now-inited' }) }),
    }));
    const t3 = await provider.remindSetupKeyTick(tmp);
    expect(t3).toEqual({ printed: false, stopped: true, regenerated: false });
    expect(ci).toHaveBeenCalledWith(fakeTimer); // 决定性断言：真的 clearInterval 了
    expect((provider as any).setupKeyReminderTimer).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
    const t4 = await provider.remindSetupKeyTick(tmp);
    expect(t4.stopped).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3); // 永久停了
    warn.mockRestore();
    si.mockRestore();
    ci.mockRestore();
  });

  it('tick 自愈：密钥文件与内存都被人为清掉 → 重新生成一把并重建缓存块', async () => {
    process.env[SETUP_KEY_REMIND_ENV] = '0';
    const { provider } = stubDeps([]);
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    await provider.refreshSetupKey(tmp);
    const oldKey = fs.readFileSync(path.join(tmp, 'setup.key'), 'utf-8');
    clearSetupKey(tmp); // 模拟"文件被删 + 内存被清"
    const t = await provider.remindSetupKeyTick(tmp);
    expect(t).toEqual({ printed: true, stopped: false, regenerated: true });
    const newKey = fs.readFileSync(path.join(tmp, 'setup.key'), 'utf-8');
    expect(newKey).not.toBe(oldKey);
    const block = String(warn.mock.calls[1][0]);
    expect(block).toContain(newKey);
    expect(block).not.toBe(String(warn.mock.calls[0][0])); // 缓存块重建了
    warn.mockRestore();
  });

  it('日志管道坏掉也不抛：打印失败被吞掉（ERROR 兜底），tick 正常返回', async () => {
    process.env[SETUP_KEY_REMIND_ENV] = '0';
    const { provider } = stubDeps([]);
    const warn = jest
      .spyOn((provider as any).logger, 'warn')
      .mockImplementation(() => {
        throw new Error('日志管道断了');
      });
    const error = jest.spyOn((provider as any).logger, 'error').mockImplementation(() => undefined);
    await expect(provider.refreshSetupKey(tmp)).resolves.toMatchObject({ generated: true });
    await expect(provider.remindSetupKeyTick(tmp)).resolves.toMatchObject({ printed: true });
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('打印初始化密钥块失败');
    warn.mockRestore();
    error.mockRestore();
  });

  it('onModuleDestroy 清掉定时器（优雅停机不吊着进程）', async () => {
    const { provider } = stubDeps([]);
    jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    const fakeTimer = { unref: jest.fn() } as any;
    const si = jest.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);
    const ci = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
    await provider.refreshSetupKey(tmp);
    expect((provider as any).setupKeyReminderTimer).toBe(fakeTimer);
    provider.onModuleDestroy();
    expect(ci).toHaveBeenCalledWith(fakeTimer);
    expect((provider as any).setupKeyReminderTimer).toBeNull();
    si.mockRestore();
    ci.mockRestore();
  });

  it('init() 成功会把 setup.key 清掉（文件 + 内存）：初始化之后密钥不再授予任何东西', async () => {
    // 用 VAN_BLOG_LOG 把**真实 init() 走的 config.log** 指到临时目录（模块加载时读取），
    // 这样跑的是生产路径的 clearSetupKey()（无 logDir 参数），而不是手动补刀
    process.env.VAN_BLOG_LOG = tmp;
    process.env[SETUP_KEY_REMIND_ENV] = '0';
    let mod: typeof import('./init.provider') | undefined;
    let skMod: typeof import('./setupKey') | undefined;
    jest.isolateModules(() => {
      mod = require('./init.provider');
      skMod = require('./setupKey');
    });
    delete process.env.VAN_BLOG_LOG;

    const deps = stubDeps([]);
    const provider = new mod!.InitProvider(
      deps.metaModel,
      deps.userModel,
      {} as any,
      {} as any,
      deps.deps.walineProvider as any,
      deps.deps.settingProvider as any,
      deps.deps.cacheProvider as any,
      deps.deps.websiteProvider as any,
      deps.recorder as any,
    );
    // 默认 flag（未设置 = 开）：启动路径生成了密钥
    const refreshed = await provider.refreshSetupKey(); // 无参 → config.log（= tmp）
    expect(refreshed.generated).toBe(true);
    const filePath = path.join(tmp, 'setup.key');
    expect(fs.existsSync(filePath)).toBe(true);

    await provider.init({
      user: { username: 'FixtureOwner', password: 'derived-fixture' } as any,
      siteInfo: {} as any,
    } as any);

    // init() 成功 ⇒ 密钥文件与内存都没了（隔离模块实例的内存也必须是空的）
    expect(fs.existsSync(filePath)).toBe(false);
    expect(skMod!.currentSetupKey()).toBe(null);
  });
});

describe('默认开启 + env 自动引导 = 推荐生产组合：必须完全静音', () => {
  it('flag 未设置（默认开）+ USER/PASSWORD_FILE → onModuleInit 完成初始化：不生成密钥、不打印密钥块', async () => {
    process.env.VAN_BLOG_LOG = tmp;
    let mod: typeof import('./init.provider') | undefined;
    jest.isolateModules(() => {
      mod = require('./init.provider');
    });
    delete process.env.VAN_BLOG_LOG;
    delete process.env[SETUP_KEY_REQUIRE_ENV]; // 默认 = 开

    const secretFile = path.join(tmp, 'admin-password');
    fs.writeFileSync(secretFile, 'fixture-silent-secret\n', { mode: 0o600 });
    process.env[ENV_ADMIN_USER] = 'SilentOwner';
    process.env[ENV_ADMIN_PASSWORD_FILE] = secretFile;

    const deps = stubDeps([]);
    const provider = new mod!.InitProvider(
      deps.metaModel,
      deps.userModel,
      {} as any,
      {} as any,
      deps.deps.walineProvider as any,
      deps.deps.settingProvider as any,
      deps.deps.cacheProvider as any,
      deps.deps.websiteProvider as any,
      deps.recorder as any,
    );
    const warn = jest.spyOn((provider as any).logger, 'warn').mockImplementation(() => undefined);
    await provider.onModuleInit();

    // 站点在监听 HTTP 之前就初始化完了
    expect(await provider.checkHasInited()).toBe(true);
    expect(deps.created.users).toHaveLength(1);
    // 密钥：不生成、不打印（站点从未处于未初始化状态可供请求命中）
    expect(fs.existsSync(path.join(tmp, 'setup.key'))).toBe(false);
    const warnText = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnText).not.toContain('初始化密钥');
    expect(warnText).toContain('自动初始化'); // 但自动初始化本身仍然大声
    expect((provider as any).setupKeyReminderTimer).toBeNull();
    warn.mockRestore();
  });
});
