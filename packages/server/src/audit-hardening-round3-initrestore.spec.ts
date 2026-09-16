import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpException, BadRequestException } from '@nestjs/common';

import {
  InitController,
  __resetInitRestoreLockForTest,
  isInitRestoreInFlight,
} from './controller/admin/init/init.controller';
import { RESTORE_UPLOAD_OPTIONS } from './utils/restoreUpload';
import { readFileSync } from 'fs';

/**
 * `POST /api/admin/init/restore`：在初始化页直接上传整站备份恢复整站。
 *
 * 这条接口是**匿名可达 + 破坏性**的（覆盖 13 个集合与整棵静态目录），
 * 所以它的护栏比一般接口多，每条都要有测试：
 *  1. 已初始化 ⇒ 拒绝（而且 restore 一次都不许被调到）；
 *  2. 并发两个 ⇒ 只有一个恢复，另一个拿到明确的 409（用 deferred 卡住，不靠计时）；
 *  3. 坏归档（文件名不对 / 读不出清单 / 成员里有 `../`）⇒ 400，且不写任何数据；
 *  4. 成功路径 ⇒ 标准信封 `{statusCode,data}`、数字齐全、恢复后的副作用都做了、临时文件删掉。
 *
 * 真库上的完整往返（导出→恢复→逐字段对拍）在
 * `test/backup-restore-bson.e2e-spec.ts`（env 开关，见该文件头部）。
 */

jest.mock('src/utils/fullBackup', () => {
  const actual = jest.requireActual('src/utils/fullBackup');
  return {
    ...actual,
    inspectFullBackup: jest.fn(),
    assertRestorableArchive: jest.fn(),
  };
});
jest.mock('src/utils/publicMetaCache', () => {
  const actual = jest.requireActual('src/utils/publicMetaCache');
  return { ...actual, invalidatePublicMetaCache: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fullBackup = require('src/utils/fullBackup');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const publicMetaCache = require('src/utils/publicMetaCache');
const mockedInspect = fullBackup.inspectFullBackup as jest.Mock;
const mockedAssert = fullBackup.assertRestorableArchive as jest.Mock;
const mockedInvalidateMeta = publicMetaCache.invalidatePublicMetaCache as jest.Mock;

const root = __dirname;
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

const MANIFEST = {
  kind: 'vanblog-full-backup',
  version: 1,
  createdAt: '2026-09-13T14:09:55.000Z',
  format: 'zstd',
  compressor: 'zstd -19',
  databases: {
    vanBlog: {
      collections: {
        articles: { count: 59, bytes: 1000, indexes: 3 },
        statics: { count: 93, bytes: 200, indexes: 1 },
        users: { count: 1, bytes: 10, indexes: 1 },
        visits: { count: 8746, bytes: 300, indexes: 2 },
        viewers: { count: 796, bytes: 50, indexes: 1 },
        settings: { count: 7, bytes: 10, indexes: 1 },
      },
    },
    waline: { collections: { Comment: { count: 3 }, Users: { count: 3 } } },
  },
  static: { img: { files: 182, bytes: 1 } },
  totals: { databases: 2, collections: 8, documents: 9830, files: 182, staticBytes: 1 },
};

let tmp: string;

function makeFile(originalname = 'vanblog-full-20260913-140955.tar.zst') {
  const p = path.join(tmp, `upload-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, 'not-really-an-archive');
  return { path: p, originalname, size: 21 } as any;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeController(over: {
  hasInited?: boolean | (() => Promise<boolean>);
  restore?: jest.Mock;
} = {}) {
  const initProvider = {
    checkHasInited: jest.fn(async () =>
      typeof over.hasInited === 'function' ? over.hasInited() : Boolean(over.hasInited),
    ),
    invalidateInitCache: jest.fn(),
  };
  const fullBackupProvider = {
    backupDir: () => path.join(tmp, 'backups'),
    restore: over.restore || jest.fn(async () => ({
      ms: 2750,
      databases: { vanBlog: { collections: 13, documents: 9830 } },
      static: { img: { files: 182 } },
      manifest: MANIFEST,
      notes: ['数据库与设置已按备份覆盖'],
    })),
  };
  const walineProvider = { init: jest.fn(async () => undefined) };
  const websiteProvider = { restart: jest.fn(async () => undefined) };
  const viewStatsProvider = { invalidateBase: jest.fn() };
  const isrProvider = { activeAll: jest.fn() };
  const staticProvider = { upload: jest.fn() };
  const controller = new InitController(
    initProvider as any,
    staticProvider as any,
    isrProvider as any,
    fullBackupProvider as any,
    walineProvider as any,
    websiteProvider as any,
    viewStatsProvider as any,
  );
  return {
    controller,
    initProvider,
    fullBackupProvider,
    walineProvider,
    websiteProvider,
    viewStatsProvider,
    isrProvider,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-init-restore-'));
  __resetInitRestoreLockForTest();
  mockedInspect.mockReset();
  mockedAssert.mockReset();
  mockedInvalidateMeta.mockReset();
  mockedInspect.mockResolvedValue(MANIFEST);
  mockedAssert.mockResolvedValue(1234);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('POST /api/admin/init/restore：护栏', () => {
  it('站点已初始化 ⇒ 403，而且 restore 一次都不会被调到', async () => {
    const { controller, fullBackupProvider } = makeController({ hasInited: true });
    const file = makeFile();
    await expect(controller.restoreFromInitPage(file)).rejects.toBeInstanceOf(HttpException);
    await expect(
      controller.restoreFromInitPage(makeFile()),
    ).rejects.toThrow(/已经初始化/);
    expect(fullBackupProvider.restore).not.toHaveBeenCalled();
    // 临时文件必须删掉（multer 已经把它落盘了）
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('并发两个请求 ⇒ 只有一个恢复，另一个拿到明确的 409（不靠计时）', async () => {
    const gate = deferred<any>();
    let started = 0;
    const restore = jest.fn(() => {
      started += 1;
      return gate.promise;
    }) as any;
    // 第一个请求进入后站点仍然"未初始化"（库还没被写完），所以第二个请求
    // 只能靠互斥量挡住 —— 这正是要钉住的那条竞态
    const { controller } = makeController({ hasInited: false, restore });
    const loser = makeFile();
    const winner = makeFile();
    const first = controller.restoreFromInitPage(winner);
    // 等第一个请求真的进到 restore 里（拿到锁）
    await new Promise((r) => setTimeout(r, 10));
    await expect(controller.restoreFromInitPage(loser)).rejects.toThrow(/已经有一个恢复正在进行/);
    await expect(controller.restoreFromInitPage(makeFile())).rejects.toBeInstanceOf(HttpException);
    expect(started).toBe(1);
    expect(restore).toHaveBeenCalledTimes(1);
    // ⚠️ 被 409 挡掉的请求**不许**把正在跑那一次的锁放掉：
    // 以前 finally 里无条件 `initRestoreRunning = false`，于是第二个请求一被拒就把锁清了，
    // 第三个请求又能进来 —— 两次恢复真的会叠在一起（这条用例就是这么抓到的）。
    await expect(controller.restoreFromInitPage(makeFile())).rejects.toThrow(
      /已经有一个恢复正在进行/,
    );
    expect(isInitRestoreInFlight()).toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
    gate.resolve({
      ms: 10,
      databases: {},
      static: {},
      manifest: MANIFEST,
      notes: [],
    });
    const ok = await first;
    expect(ok.statusCode).toBe(200);
    // 跑完之后锁必须释放：失败/成功之后都不能永久 409
    expect(isInitRestoreInFlight()).toBe(false);
    expect(fs.existsSync(loser.path)).toBe(false);
  });

  it('恢复抛错之后锁会释放（否则这条接口会永久 409，而站点还没初始化 ⇒ 只能重启容器）', async () => {
    const { controller } = makeController({
      hasInited: false,
      restore: jest.fn(async () => {
        throw new Error('磁盘满了');
      }) as any,
    });
    await expect(controller.restoreFromInitPage(makeFile())).rejects.toThrow('磁盘满了');
    // 现在换一个好的：必须能立刻再试
    const { controller: c2 } = makeController({ hasInited: false });
    const res = await c2.restoreFromInitPage(makeFile());
    expect(res.statusCode).toBe(200);
  });

  it('文件名不在白名单里 ⇒ 400，且不读清单、不恢复', async () => {
    const { controller, fullBackupProvider } = makeController({ hasInited: false });
    const file = makeFile('../../../etc/passwd.tar.zst');
    await expect(controller.restoreFromInitPage(file)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockedInspect).not.toHaveBeenCalled();
    expect(fullBackupProvider.restore).not.toHaveBeenCalled();
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('读不出清单（损坏/不完整/不是本功能导出的）⇒ 400，且不恢复', async () => {
    mockedInspect.mockResolvedValue(null);
    const { controller, fullBackupProvider } = makeController({ hasInited: false });
    await expect(controller.restoreFromInitPage(makeFile())).rejects.toThrow(/读不出这个备份的清单/);
    expect(fullBackupProvider.restore).not.toHaveBeenCalled();
  });

  it('归档成员里有会写到解包目录之外的路径 ⇒ 400（匿名接口不能只靠 tar 自己拒绝）', async () => {
    mockedAssert.mockRejectedValue(
      new BadRequestException('备份归档里有会写到解包目录之外的成员（../evil.txt），已拒绝恢复'),
    );
    const { controller, fullBackupProvider } = makeController({ hasInited: false });
    await expect(controller.restoreFromInitPage(makeFile())).rejects.toThrow(/解包目录之外/);
    expect(fullBackupProvider.restore).not.toHaveBeenCalled();
  });

  it('没带文件 ⇒ 400（不是 500，也不许把 undefined 当路径用）', async () => {
    const { controller, fullBackupProvider } = makeController({ hasInited: false });
    await expect(controller.restoreFromInitPage(undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fullBackupProvider.restore).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/init/restore：成功路径', () => {
  it('回标准信封 {statusCode,data}，数字齐全，恢复后的副作用一个不落', async () => {
    const {
      controller,
      initProvider,
      fullBackupProvider,
      walineProvider,
      websiteProvider,
      viewStatsProvider,
      isrProvider,
    } = makeController({ hasInited: false });
    const file = makeFile();
    const res: any = await controller.restoreFromInitPage(file);

    expect(res.statusCode).toBe(200);
    // 后台的 umi 请求适配器只认 {statusCode,data}，data 里要有能直接展示的数字
    expect(res.data).toBeDefined();
    expect(res.data.counts).toEqual({
      articles: 59,
      statics: 93,
      users: 1,
      visits: 8746,
      viewers: 796,
      settings: 7,
      total: 59 + 93 + 1 + 8746 + 796 + 7 + 3 + 3,
    });
    expect(res.data.adminUserFromArchive).toBe(true);
    expect(res.data.seconds).toBe(2.8);
    expect(res.data.backupCreatedAt).toBe('2026-09-13T14:09:55.000Z');
    expect(res.data.databases).toEqual({ vanBlog: { collections: 13, documents: 9830 } });
    expect(res.data.static).toEqual({ img: { files: 182 } });
    expect(typeof res.data.restoredAt).toBe('string');
    expect(Array.isArray(res.data.notes)).toBe(true);

    // withStatic 必须是 true（主题/图床/自定义页面都在静态目录里）
    expect(fullBackupProvider.restore).toHaveBeenCalledWith(file.path, true);
    // 进程内缓存全部作废
    expect(initProvider.invalidateInitCache).toHaveBeenCalled();
    expect(viewStatsProvider.invalidateBase).toHaveBeenCalled();
    expect(mockedInvalidateMeta).toHaveBeenCalled();
    // 全新站点从没起过 waline，也没按恢复后的库算过前台环境变量
    expect(walineProvider.init).toHaveBeenCalled();
    expect(websiteProvider.restart).toHaveBeenCalled();
    // 全量渲染必须带 forceActice（恢复出来的 ISR 设置可能是 delay 模式）
    // ⚠️ 第二个参数必须是 1000：它是 RSS/sitemap 两个生成器的防抖时长，
    // 传 undefined 就变成"RSS 3 分钟后、sitemap 1 分钟后"才写文件（容器实测 /feed.xml 404）
    expect(isrProvider.activeAll).toHaveBeenCalledWith(
      expect.stringContaining('初始化页恢复整站备份'),
      1000,
      { forceActice: true },
    );
    // 临时归档删掉了
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('恢复后 checkHasInited 为真时 data.initialized=true（前台据此直接跳后台）', async () => {
    let inited = false;
    const { controller } = makeController({ hasInited: async () => inited });
    const restore = jest.fn(async () => {
      inited = true; // 恢复把 users 集合写回来了
      return { ms: 5, databases: {}, static: {}, manifest: MANIFEST, notes: [] };
    }) as any;
    const c = makeController({ hasInited: async () => inited, restore });
    const res: any = await c.controller.restoreFromInitPage(makeFile());
    expect(res.data.initialized).toBe(true);
    expect(controller).toBeDefined();
  });
});

describe('老版本归档：清单缺字段时是"照恢复 + 说清楚"，不是拒绝', () => {
  it('manifest 里没有 static / 某些集合 ⇒ 数字回落 0，恢复照常进行', async () => {
    // 老归档的真实形状：没有 static.themes（那时 themes 还不在清单里），
    // 也可能整份没有 static（空站），totals 的形状同样不该被依赖
    const legacyManifest = {
      kind: 'vanblog-full-backup',
      version: 1,
      createdAt: '2025-01-02T03:04:05.000Z',
      format: 'gzip',
      compressor: 'gzip',
      databases: { vanBlog: { collections: { articles: { count: 12 }, users: { count: 1 } } } },
      totals: { databases: 1, collections: 2, documents: 13, files: 0, staticBytes: 0 },
    };
    mockedInspect.mockResolvedValue(legacyManifest);
    const { controller } = makeController({ hasInited: false });
    const res: any = await controller.restoreFromInitPage(makeFile());
    expect(res.statusCode).toBe(200);
    expect(res.data.counts).toEqual({
      articles: 12,
      statics: 0,
      users: 1,
      visits: 0,
      viewers: 0,
      settings: 0,
      total: 13,
    });
    expect(res.data.adminUserFromArchive).toBe(true);
    expect(res.data.backupCreatedAt).toBe('2025-01-02T03:04:05.000Z');
  });

  it('归档里没有 users（恢复完站点仍未初始化）⇒ 200 但 initialized=false，前台据此留在初始化向导', async () => {
    mockedInspect.mockResolvedValue({
      ...MANIFEST,
      databases: { vanBlog: { collections: { articles: { count: 3 } } } },
    });
    const { controller } = makeController({ hasInited: false });
    const res: any = await controller.restoreFromInitPage(makeFile());
    expect(res.statusCode).toBe(200);
    expect(res.data.adminUserFromArchive).toBe(false);
    expect(res.data.initialized).toBe(false);
  });

  it('清单缺 databases / kind 不对 / 版本过新 ⇒ inspectFullBackup 判为无效 ⇒ 400，不写任何数据', async () => {
    const real = jest.requireActual('src/utils/backupCodec');
    const { isFullBackupManifest } = real;
    expect(isFullBackupManifest({ kind: 'vanblog-full-backup', version: 1, databases: {} })).toBe(true);
    // 版本过新：宁可不恢复，也不要按不认识的格式乱写
    expect(isFullBackupManifest({ kind: 'vanblog-full-backup', version: 2, databases: {} })).toBe(false);
    expect(isFullBackupManifest({ kind: 'something-else', version: 1, databases: {} })).toBe(false);
    expect(isFullBackupManifest({ kind: 'vanblog-full-backup', version: 1 })).toBe(false);
    expect(isFullBackupManifest(null)).toBe(false);

    mockedInspect.mockResolvedValue(null); // 上面这些情况 inspectFullBackup 都会回 null
    const { controller, fullBackupProvider } = makeController({ hasInited: false });
    await expect(controller.restoreFromInitPage(makeFile())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fullBackupProvider.restore).not.toHaveBeenCalled();
  });
});

describe('归档成员名检查（真 tar，不靠桩）', () => {
  // ⚠️ 上面 jest.mock 把 assertRestorableArchive / listArchiveMembers 换成了桩，
  // 这两条要验的是真实现，所以从 requireActual 取
  const real = jest.requireActual('src/utils/fullBackup');
  const { findUnsafeArchiveMember, assertRestorableArchive, listArchiveMembers } = real;

  it('findUnsafeArchiveMember 认得出绝对路径与 .. 段', () => {
    expect(findUnsafeArchiveMember(['manifest.json', 'db/vanBlog/articles.ndjson'])).toBe(null);
    expect(findUnsafeArchiveMember(['./db/x.ndjson', 'static/img/a.webp'])).toBe(null);
    expect(findUnsafeArchiveMember(['../evil.txt'])).toBe('../evil.txt');
    expect(findUnsafeArchiveMember(['db/../../evil.txt'])).toBe('db/../../evil.txt');
    expect(findUnsafeArchiveMember(['/etc/passwd'])).toBe('/etc/passwd');
    expect(findUnsafeArchiveMember(['C:\\windows\\system32\\x'])).toBe('C:\\windows\\system32\\x');
    // 名字里带 ".." 但不是路径段的不算（例如文章标题）
    expect(findUnsafeArchiveMember(['db/vanBlog/a..b.ndjson'])).toBe(null);
  });

  it('真做一个含 ../ 成员的 tar.gz：assertRestorableArchive 必须拒绝它', async () => {
    const staging = path.join(tmp, 'evil');
    fs.mkdirSync(path.join(staging, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'sub', 'ok.txt'), 'fine');
    // 用 --transform 造一个成员名为 ../escaped.txt 的归档
    const archive = path.join(tmp, 'evil.tar.gz');
    execFileSync(
      'tar',
      ['-czf', archive, '--transform', 's|sub/ok.txt|../escaped.txt|', '-C', staging, 'sub/ok.txt'],
      { stdio: 'pipe' },
    );
    await expect(assertRestorableArchive(archive)).rejects.toThrow(/解包目录之外/);
  });

  it('正常归档（本功能导出的形状）能通过检查', async () => {
    const staging = path.join(tmp, 'good');
    fs.mkdirSync(path.join(staging, 'db', 'vanBlog'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(MANIFEST));
    fs.writeFileSync(path.join(staging, 'db', 'vanBlog', 'articles.ndjson'), '{}\n');
    const archive = path.join(tmp, 'vanblog-full-20260916-000000.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', staging, '.'], { stdio: 'pipe' });
    const members = await listArchiveMembers(archive);
    expect(members.length).toBeGreaterThan(0);
    await expect(assertRestorableArchive(archive)).resolves.toBe(members.length);
  });
});

describe('源码级钉子（剥掉注释再断言）', () => {
  it('复用 RESTORE_UPLOAD_OPTIONS，没有自己另写一套限额', () => {
    const src = code(read('controller/admin/init/init.controller.ts'));
    expect(src).toContain("FileInterceptor('file', RESTORE_UPLOAD_OPTIONS)");
    expect(src).toContain("from 'src/utils/restoreUpload'");
    expect(src).not.toContain('diskStorage(');
    expect(src).not.toMatch(/fileSize\s*:/);
    // 后台那条恢复接口用的也是同一份
    const backup = code(read('controller/admin/backup/backup.controller.ts'));
    expect(backup).toContain("FileInterceptor('file', RESTORE_UPLOAD_OPTIONS)");
    expect(backup).toContain("from 'src/utils/restoreUpload'");
    expect(backup).not.toContain('diskStorage(');
    expect(RESTORE_UPLOAD_OPTIONS.limits.fileSize).toBe(8 * 1024 * 1024 * 1024);
  });

  it('处理器里自己再查一次 checkHasInited（不只依赖中间件/守卫）', () => {
    const src = code(read('controller/admin/init/init.controller.ts'));
    const handler = src.slice(src.indexOf("'/init/restore'"));
    expect(handler).toContain('await this.initProvider.checkHasInited()');
    expect(handler).toContain('initRestoreRunning');
    // 锁必须**先于任何 await**拿到，而且只有拿到锁的那次调用才能在 finally 里释放
    expect(handler.indexOf('initRestoreRunning = true')).toBeLessThan(
      handler.indexOf('await this.initProvider.checkHasInited()'),
    );
    expect(handler).toContain('if (claimedLock)');
    // 临时文件清理在 finally 里
    expect(handler).toContain('fs.rmSync(uploadedPath, { force: true })');
  });

  it('限流的 init 桶仍然覆盖这条路由（path.startsWith("/api/admin/init")）', () => {
    const rl = code(read('utils/rateLimit.ts'));
    expect(rl).toContain("path.startsWith('/api/admin/init')");
    // 路由前缀必须落在那个判断里
    expect('/api/admin/init/restore'.startsWith('/api/admin/init')).toBe(true);
  });

  it('InitMiddleware 放行了这条路由（否则未初始化时它自己就会被 233 挡掉）', () => {
    const whole = read('app.module.ts');
    // 只在 configure() 体内比较顺序：文件头的 import 行也含这些标识符
    const mod = whole.slice(whole.indexOf('configure(consumer: MiddlewareConsumer)'));
    expect(mod).toContain("{ path: '/api/admin/init/restore', method: RequestMethod.POST }");
    // 四处 forRoutes({ path: '*' }) 与中间件顺序不许动（Express 5 / path-to-regexp v8 会失配，见 AGENTS §7.52）
    expect((mod.match(/path: '\*'/g) || []).length).toBe(4);
    expect((mod.match(/forRoutes\(/g) || []).length).toBe(4);
    expect(mod.indexOf('makeRequestIdMiddleware')).toBeLessThan(mod.indexOf('rateLimitMiddleware'));
    expect(mod.indexOf('NoStoreCacheMiddleware')).toBeLessThan(mod.indexOf('InitMiddleware'));
  });
});
