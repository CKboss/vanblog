/**
 * 三项初始化加固的**活体量具**（真 mongod + 真 Nest HTTP 栈 + supertest）：
 *
 *  1. 安装记录：`/init`、`/init/restore`、env 自动引导成功后，迁移台账里都有一条
 *     `install:initialised`（kind:'install'），detail = `{at,route,socketIp,
 *     trustedClientIp,userAgent,archiveName?}`，并 WARN 一条；
 *  2. setup key：`VANBLOG_INIT_REQUIRE_SETUP_KEY=true` 时两条匿名路由必须带
 *     `setupKey`；没带/带错 → 400 指路消息；**关闭时行为与今天逐字节一致**
 *     （信封一个字段都不多、不生成任何文件）；`/init` 有单飞锁（并发只产生一个
 *     id:0 用户）；初始化成功后 setup.key 被删除；
 *  3. env 自动引导：`VANBLOG_ADMIN_USER` + `VANBLOG_ADMIN_PASSWORD(_FILE)` 让全新
 *     站点在 onModuleInit（监听 HTTP 之前）就完成初始化 —— 未初始化窗口不存在；
 *     凭据被拒时大声失败且向导仍可用；已初始化时忽略并 INFO。
 *
 * ⚠️ 默认**整套跳过**。要跑就给一个**一次性 mongod**（硬护栏拒绝 27017 开发库）：
 *
 *   .tools/mongodb/bin/mongod --dbpath <一次性目录> --port 27019 &
 *   VANBLOG_SETUPKEY_URL='mongodb://127.0.0.1:27019/vanblog_setupkey_e2e?directConnection=true' \
 *   VAN_BLOG_LOG=<一次性日志目录> VAN_BLOG_BACKUP_PATH=<一次性备份目录> \
 *     ./node_modules/.bin/jest --config ./test/jest-setup-key-init.json
 *
 * ⚠️ VAN_BLOG_LOG / VAN_BLOG_BACKUP_PATH 必须在**启动 jest 的命令行**上给：
 * src/config 在模块加载时读取它们（setup.key 与 multer 落盘都按这两个目录走）。
 * ⚠️ 全程只碰这个一次性 mongod 与一次性目录；**绝不打开发栈 :3000/:27017**。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import mongoose from 'mongoose';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { InitController } from 'src/controller/admin/init/init.controller';
import { InitProvider } from 'src/provider/init/init.provider';
import { MigrationProvider } from 'src/provider/migration/migration.provider';
import { CacheProvider } from 'src/provider/cache/cache.provider';
import { StaticProvider } from 'src/provider/static/static.provider';
import { ISRProvider } from 'src/provider/isr/isr.provider';
import { FullBackupProvider } from 'src/provider/backup/fullBackup.provider';
import { WalineProvider } from 'src/provider/waline/waline.provider';
import { WebsiteProvider } from 'src/provider/website/website.provider';
import { ViewStatsProvider } from 'src/provider/stats/viewStats.provider';
import { Meta, MetaSchema } from 'src/scheme/meta.schema';
import { User, UserSchema } from 'src/scheme/user.schema';
import { Category, CategorySchema } from 'src/scheme/category.schema';
import { CustomPage, CustomPageSchema } from 'src/scheme/customPage.schema';
import { Migration, MigrationSchema } from 'src/scheme/migration.schema';
import { config } from 'src/config';
import {
  INSTALL_LEDGER_KEY,
} from 'src/provider/init/init.provider';
import {
  SETUP_KEY_FILE_NAME,
  SETUP_KEY_REMIND_ENV,
  SETUP_KEY_REQUIRE_ENV,
  clearSetupKey,
  setupKeyFilePath,
} from 'src/provider/init/setupKey';
import {
  ENV_ADMIN_PASSWORD,
  ENV_ADMIN_PASSWORD_FILE,
  ENV_ADMIN_USER,
  deriveBrowserPassword,
} from 'src/provider/init/envBootstrap';
import { hashSecret, verifyUserPassword } from 'src/utils/crypto';

// restore 场景不需要真归档：清单检查与成员检查打桩（真实行为在
// test/init-restore.e2e-spec.ts / backup-restore-bson.e2e-spec.ts 里量过），
// 这里量的是**密钥闸门与安装记录**在真 HTTP 栈上的行为。
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
const mockedInspect = fullBackup.inspectFullBackup as jest.Mock;
const mockedAssert = fullBackup.assertRestorableArchive as jest.Mock;

const URL = process.env.VANBLOG_SETUPKEY_URL || '';
const d = URL ? describe : describe.skip;

const MANIFEST_WITH_USERS = {
  kind: 'vanblog-full-backup',
  version: 1,
  createdAt: '2026-09-17T00:00:00.000Z',
  databases: {
    vanBlog: { collections: { users: { count: 1 }, articles: { count: 3 } } },
  },
};
const MANIFEST_NO_USERS = {
  kind: 'vanblog-full-backup',
  version: 1,
  createdAt: '2026-09-17T00:00:00.000Z',
  databases: { vanBlog: { collections: { articles: { count: 3 } } } },
};

d('初始化加固三件套：真 mongod + 真 HTTP 栈', () => {
  jest.setTimeout(180000);
  let conn: mongoose.Connection;
  let app: any;
  let server: any;
  let initProvider: InitProvider;
  let migrationProvider: MigrationProvider;
  let userModel: any;
  let workDir: string;
  const restoreBehavior = { insertUser: false };

  beforeAll(async () => {
    // 硬护栏：只允许本机一次性实例，绝不许是开发栈的 27017（那上面有真数据，
    // 而且 /api/admin/init* 的限流桶是别人在用的）
    if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(URL)) {
      throw new Error(`VANBLOG_SETUPKEY_URL 必须是本机一次性 mongod（当前：${URL}）`);
    }
    if (/:27017(\/|\?|$)/.test(URL)) {
      throw new Error('VANBLOG_SETUPKEY_URL 指向 27017（开发栈真库）—— 拒绝执行');
    }
    // setup.key / multer 落盘必须指到一次性目录（命令行 env 给，见文件头）
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-setupkey-e2e-'));
    if (!config.log || config.log.includes('vanblog_dev/logs')) {
      throw new Error(
        `VAN_BLOG_LOG 必须指到一次性目录（当前 config.log=${config.log}）：` +
          `本量具会往里写/删 setup.key，不许碰开发栈日志目录`,
      );
    }
    fs.mkdirSync(config.log, { recursive: true });
    fs.mkdirSync(path.join(config.backupPath || workDir, 'upload-tmp'), { recursive: true });

    conn = mongoose.createConnection(URL, {
      serverSelectionTimeoutMS: 5000,
      autoIndex: false,
    } as any);
    await conn.asPromise();
    await conn.db.dropDatabase();

    const metaModel = conn.model(Meta.name, MetaSchema);
    userModel = conn.model(User.name, UserSchema);
    const categoryModel = conn.model(Category.name, CategorySchema);
    const customPageModel = conn.model(CustomPage.name, CustomPageSchema);
    const migrationModel = conn.model(Migration.name, MigrationSchema);

    migrationProvider = new MigrationProvider(migrationModel as any);
    initProvider = new InitProvider(
      metaModel as any,
      userModel as any,
      categoryModel as any,
      customPageModel as any,
      { init: jest.fn(async () => undefined) } as any,
      {
        updateCommentSetting: jest.fn(async () => undefined),
        updateMenuSetting: jest.fn(async () => undefined),
      } as any,
      new CacheProvider(),
      { restart: jest.fn(async () => undefined) } as any,
      migrationProvider,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [InitController],
      providers: [
        { provide: InitProvider, useValue: initProvider },
        { provide: StaticProvider, useValue: { upload: jest.fn() } },
        { provide: ISRProvider, useValue: { activeAll: jest.fn() } },
        {
          provide: FullBackupProvider,
          useValue: {
            backupDir: () => path.join(workDir, 'backups'),
            restore: jest.fn(async () => {
              if (restoreBehavior.insertUser) {
                // 模拟"归档里带了管理员账号"：恢复完成后库里有 users
                await userModel.create({
                  id: 0,
                  name: 'ArchiveOwner',
                  password: hashSecret('archive-derived-fixture'),
                  mickname: 'ArchiveOwner',
                  type: 'admin',
                  salt: 'fixture-salt',
                });
              }
              return { ms: 5, databases: {}, static: {}, notes: [] };
            }),
          },
        },
        { provide: WalineProvider, useValue: { init: jest.fn(async () => undefined) } },
        { provide: WebsiteProvider, useValue: { restart: jest.fn(async () => undefined) } },
        { provide: ViewStatsProvider, useValue: { invalidateBase: jest.fn() } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
    } catch {
      // 关不掉也不该让量具报错
    }
    try {
      if (conn) await conn.close();
    } catch {
      // ignore
    }
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  async function freshSite() {
    await conn.db.dropDatabase();
    initProvider.invalidateInitCache();
    clearSetupKey(); // 清内存 + config.log（一次性目录）里的文件
    delete process.env[SETUP_KEY_REQUIRE_ENV];
    delete process.env[SETUP_KEY_REMIND_ENV];
    delete process.env[ENV_ADMIN_USER];
    delete process.env[ENV_ADMIN_PASSWORD];
    delete process.env[ENV_ADMIN_PASSWORD_FILE];
    restoreBehavior.insertUser = false;
    mockedInspect.mockReset();
    mockedAssert.mockReset();
    mockedInspect.mockResolvedValue(MANIFEST_WITH_USERS);
    mockedAssert.mockResolvedValue(7);
  }

  async function ledgerRow() {
    const rows: any[] = await migrationProvider.list();
    return rows.find((r: any) => r.key === INSTALL_LEDGER_KEY) || null;
  }

  function initPayload(username = 'LiveOwner', password = 'derived-browser-fixture') {
    return {
      user: { username, password },
      siteInfo: { siteName: 'LiveProof', author: username, baseUrl: 'http://127.0.0.1:9' },
    };
  }

  describe('① 新默认（env 未设置 = 要求密钥）+ 安装记录 + 显式关的逃生口', () => {
    it('默认启动：onModuleInit 生成 0600 密钥并 WARN 视觉块；没带密钥的 POST /init 直接 400（默认即保护）', async () => {
      await freshSite(); // 所有相关 env 都清空 = 生产默认
      const warn = jest
        .spyOn((initProvider as any).logger, 'warn')
        .mockImplementation(() => undefined);
      await initProvider.onModuleInit();

      const filePath = setupKeyFilePath();
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      const key = fs.readFileSync(filePath, 'utf-8');
      const block = warn.mock.calls.map((c) => String(c[0])).join('\n');
      // 站长点名的块要素：未初始化事实 / 密钥 / 文件路径 / docker logs 配方 / 重启重新生成 / 逃生口
      expect(block).toContain('尚未完成初始化');
      expect(block).toContain(key);
      expect(block).toContain(filePath);
      expect(block).toContain('docker logs <容器名> 2>&1 | grep 初始化密钥');
      expect(block).toContain('每次重启 vanblog 都会重新生成');
      expect(block).toContain('VANBLOG_INIT_REQUIRE_SETUP_KEY=false');
      // 启动本身不写任何数据
      expect(await userModel.countDocuments({})).toBe(0);
      expect(await ledgerRow()).toBeNull();

      // 默认开启的 wire 行为：没带密钥 ⇒ 400 指路
      const noKey = await request(server)
        .post('/api/admin/init')
        .set('User-Agent', 'live-proof-agent/1.0')
        .send(initPayload('NoKeyOwner'));
      expect(noKey.status).toBe(400);
      expect(noKey.body.setupKeyRequired).toBe(true);
      expect(noKey.body.reason).toBe('setupKeyMissing');
      expect(noKey.body.message).toContain(filePath);
      expect(noKey.body.message).toContain('docker logs');
      expect(noKey.body.message).not.toContain(key);
      expect(await userModel.countDocuments({})).toBe(0);

      // 带对密钥 ⇒ 信封与旧版逐字节一致（HTTP 201 + 两字段），密钥文件随即被删
      const ok = await request(server)
        .post('/api/admin/init')
        .set('User-Agent', 'live-proof-agent/1.0')
        .send({ ...initPayload(), setupKey: key });
      expect(ok.status).toBe(201);
      expect(ok.body).toEqual({ statusCode: 200, message: '初始化成功!' });
      expect(ok.text).not.toContain('setupKeyRequired');
      expect(fs.existsSync(filePath)).toBe(false);
      expect(await userModel.countDocuments({})).toBe(1);

      // 台账：安装记录无条件生效（与开关无关）
      const row = await ledgerRow();
      expect(row).not.toBeNull();
      expect(row.kind).toBe('install');
      expect(row.outcome).toBe('ok');
      expect(row.runs).toBe(1);
      expect(row.firstRanAt).toBeInstanceOf(Date);
      const detail = JSON.parse(row.detail);
      expect(detail.route).toBe('init');
      expect(['127.0.0.1', '::1']).toContain(detail.socketIp);
      expect(['127.0.0.1', '::1']).toContain(detail.trustedClientIp);
      expect(detail.userAgent).toBe('live-proof-agent/1.0');
      expect(detail.archiveName).toBeUndefined();
      expect(row.detail).not.toContain('derived-browser-fixture');

      const again = await request(server).post('/api/admin/init').send(initPayload());
      expect(again.status).toBe(500);
      expect(again.text).toContain('已初始化');
      expect(await userModel.countDocuments({})).toBe(1); // 没有第二个 id:0
      warn.mockRestore();
    });

    it('显式 VANBLOG_INIT_REQUIRE_SETUP_KEY=false（逃生口）：不带密钥照常成功，信封逐字节 = 旧版，无任何新字段', async () => {
      await freshSite();
      process.env[SETUP_KEY_REQUIRE_ENV] = 'false';
      const res = await request(server)
        .post('/api/admin/init')
        .set('User-Agent', 'live-proof-agent/1.0')
        .send(initPayload());
      expect(res.status).toBe(201); // Nest POST 默认 201（与审计时活体观测一致）
      expect(res.body).toEqual({ statusCode: 200, message: '初始化成功!' });
      expect(res.text).not.toContain('setupKey');
      expect(res.text).not.toContain('setup.key');
      expect(await userModel.countDocuments({})).toBe(1);
      // 安装记录仍然无条件写（可归因性与开关无关）
      const row = await ledgerRow();
      expect(JSON.parse(row.detail).route).toBe('init');
    });
  });

  describe('② setup key：flag 开时两条匿名路由都必须带密钥', () => {
    it('启动生成 <log>/setup.key（0600）；没带密钥 → 400 指路；带错 → 400；带对 → 成功且文件被删', async () => {
      await freshSite();
      process.env[SETUP_KEY_REQUIRE_ENV] = 'true';
      const refreshed = await initProvider.refreshSetupKey();
      expect(refreshed.generated).toBe(true);
      const filePath = setupKeyFilePath();
      expect(filePath).toBe(path.join(config.log, SETUP_KEY_FILE_NAME));
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      const key = fs.readFileSync(filePath, 'utf-8');

      const noKey = await request(server)
        .post('/api/admin/init')
        .send(initPayload('NoKeyOwner'));
      expect(noKey.status).toBe(400);
      expect(noKey.body.setupKeyRequired).toBe(true);
      expect(noKey.body.reason).toBe('setupKeyMissing');
      expect(noKey.body.message).toContain('docker logs');
      expect(noKey.body.message).toContain(filePath); // 指到真实路径
      expect(noKey.body.message).toContain('setupKey'); // 字段名
      expect(noKey.body.message).not.toContain(key); // 密钥绝不回显
      expect(await userModel.countDocuments({})).toBe(0);

      const wrongKey = await request(server)
        .post('/api/admin/init')
        .send({ ...initPayload('WrongKeyOwner'), setupKey: 'definitely-not-the-key' });
      expect(wrongKey.status).toBe(400);
      expect(wrongKey.body.reason).toBe('setupKeyWrong');
      expect(wrongKey.body.message).toContain('不正确');
      expect(await userModel.countDocuments({})).toBe(0);

      const ok = await request(server)
        .post('/api/admin/init')
        .send({ ...initPayload('KeyOwner'), setupKey: key });
      expect(ok.status).toBe(201);
      expect(ok.body).toEqual({ statusCode: 200, message: '初始化成功!' });
      expect(await userModel.countDocuments({})).toBe(1);
      // 初始化成功 ⇒ setup.key 使命结束：文件删掉（挂载日志卷里不留死密钥）
      expect(fs.existsSync(filePath)).toBe(false);
      const row = await ledgerRow();
      expect(JSON.parse(row.detail).route).toBe('init');
    });

    it('/init/restore：没带密钥 → 400（在解析归档**之前**就被挡）；带对密钥 → 恢复成功且文件被删、台账带 archiveName', async () => {
      await freshSite();
      process.env[SETUP_KEY_REQUIRE_ENV] = 'true';
      await initProvider.refreshSetupKey();
      const key = fs.readFileSync(setupKeyFilePath(), 'utf-8');

      const noKey = await request(server)
        .post('/api/admin/init/restore')
        .attach('file', Buffer.from('fake-archive'), 'vanblog-full-20260917-000000.tar.zst');
      expect(noKey.status).toBe(400);
      expect(noKey.body.setupKeyRequired).toBe(true);
      expect(mockedInspect).not.toHaveBeenCalled(); // 闸门在归档处理之前

      restoreBehavior.insertUser = true; // 归档里带管理员
      const ok = await request(server)
        .post('/api/admin/init/restore')
        .field('setupKey', key) // multipart 文本字段，与 JSON 路由同名
        .attach('file', Buffer.from('fake-archive'), 'vanblog-full-20260917-000000.tar.zst');
      expect(ok.status).toBe(201);
      expect(ok.body.statusCode).toBe(200);
      expect(ok.body.data.initialized).toBe(true);
      expect(ok.body.data.adminUserFromArchive).toBe(true);
      expect(fs.existsSync(setupKeyFilePath())).toBe(false); // initialized ⇒ 删密钥
      const row = await ledgerRow();
      const detail = JSON.parse(row.detail);
      expect(detail.route).toBe('init/restore');
      expect(detail.archiveName).toBe('vanblog-full-20260917-000000.tar.zst');

      const after = await request(server)
        .post('/api/admin/init/restore')
        .field('setupKey', key)
        .attach('file', Buffer.from('fake-archive'), 'vanblog-full-20260917-000001.tar.zst');
      expect(after.status).toBe(403); // 已初始化：密钥对不对都不再看
    });

    it('归档里没有 users（恢复完仍未初始化）→ 密钥**保留**，向导还能用它完成初始化', async () => {
      await freshSite();
      process.env[SETUP_KEY_REQUIRE_ENV] = 'true';
      await initProvider.refreshSetupKey();
      const key = fs.readFileSync(setupKeyFilePath(), 'utf-8');
      mockedInspect.mockResolvedValue(MANIFEST_NO_USERS);
      restoreBehavior.insertUser = false;

      const res = await request(server)
        .post('/api/admin/init/restore')
        .field('setupKey', key)
        .attach('file', Buffer.from('fake-archive'), 'vanblog-full-20260917-000002.tar.zst');
      expect(res.status).toBe(201);
      expect(res.body.data.initialized).toBe(false);
      // 站点仍未初始化 ⇒ 密钥必须还在（删了等于把站长锁死，只能重启容器）
      expect(fs.existsSync(setupKeyFilePath())).toBe(true);

      const wizard = await request(server)
        .post('/api/admin/init')
        .send({ ...initPayload('AfterRestoreOwner'), setupKey: key });
      expect(wizard.status).toBe(201);
      expect(fs.existsSync(setupKeyFilePath())).toBe(false); // 现在才删
      expect(await userModel.countDocuments({})).toBe(1);
    });

    it('并发两个带对密钥的 /init ⇒ 恰好一个 201、库里恰好一个用户（单飞锁，另一个 409/500）', async () => {
      await freshSite();
      process.env[SETUP_KEY_REQUIRE_ENV] = 'true';
      await initProvider.refreshSetupKey();
      const key = fs.readFileSync(setupKeyFilePath(), 'utf-8');
      const [r1, r2] = await Promise.all([
        request(server).post('/api/admin/init').send({ ...initPayload('Racer1'), setupKey: key }),
        request(server).post('/api/admin/init').send({ ...initPayload('Racer2'), setupKey: key }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      for (const s of statuses) {
        expect([201, 409, 500]).toContain(s);
      }
      // 决定性不变量：绝不允许出现两个 id:0 的管理员
      expect(await userModel.countDocuments({})).toBe(1);
      expect(await userModel.countDocuments({ id: 0 })).toBe(1);
    });
  });

  describe('③ env 自动引导：站点从不暴露在未初始化状态', () => {
    it('USER + PASSWORD_FILE（带尾部换行）→ onModuleInit 就完成初始化：登录可用、台账 env-bootstrap、不生成密钥、匿名 /init 直接 500', async () => {
      await freshSite();
      const secretPath = path.join(workDir, 'admin-password');
      fs.writeFileSync(secretPath, 'live-env-secret\n', { mode: 0o600 });
      // ⚠️ 刻意**不设置** SETUP_KEY_REQUIRE_ENV：默认（开）+ env 引导 = 推荐生产组合，
      // 必须完全静音（不生成密钥、不打印密钥块）
      process.env[ENV_ADMIN_USER] = 'EnvOwner';
      process.env[ENV_ADMIN_PASSWORD_FILE] = secretPath;

      const warn = jest.spyOn((initProvider as any).logger, 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn((initProvider as any).logger, 'error').mockImplementation(() => undefined);
      await initProvider.onModuleInit(); // 生产里由 Nest 在 app.listen 之前调用

      const warnText = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnText).toContain('自动初始化');
      expect(warnText).toContain('EnvOwner');
      // 密码（原文与派生值）绝不出现在任何日志里
      const allLogs = warnText + error.mock.calls.map((c) => String(c[0])).join('\n');
      expect(allLogs).not.toContain('live-env-secret');
      expect(allLogs).not.toContain(deriveBrowserPassword('EnvOwner', 'live-env-secret'));

      const user = await userModel.findOne({ name: 'EnvOwner' }).lean();
      expect(user).not.toBeNull();
      expect(user.id).toBe(0);
      expect(user.type).toBe('admin');
      // 登录链路可用：存的哈希认"浏览器派生值"
      expect(
        verifyUserPassword(
          user.password,
          'EnvOwner',
          deriveBrowserPassword('EnvOwner', 'live-env-secret'),
          user.salt,
        ),
      ).toBe(true);

      // flag 开着但站点已初始化 ⇒ 不生成 setup.key
      expect(fs.existsSync(setupKeyFilePath())).toBe(false);

      const row = await ledgerRow();
      const detail = JSON.parse(row.detail);
      expect(detail.route).toBe('env-bootstrap');
      expect(detail.socketIp).toBeNull();
      expect(row.detail).not.toContain('live-env-secret');

      // 窗口从未打开：匿名 /init 直接 500，/init/restore 403
      const init = await request(server).post('/api/admin/init').send(initPayload('Attacker'));
      expect(init.status).toBe(500);
      const restore = await request(server)
        .post('/api/admin/init/restore')
        .attach('file', Buffer.from('fake'), 'vanblog-full-20260917-000003.tar.zst');
      expect(restore.status).toBe(403);
      expect(await userModel.countDocuments({})).toBe(1);

      warn.mockRestore();
      error.mockRestore();
    });

    it('凭据被拒（有 USER 没密码）→ ERROR 大声失败，站点保持未初始化且向导仍可用（绝不静默锁死）', async () => {
      await freshSite();
      process.env[ENV_ADMIN_USER] = 'EnvOwner';
      const error = jest.spyOn((initProvider as any).logger, 'error').mockImplementation(() => undefined);
      await initProvider.onModuleInit();
      const text = error.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toContain('被拒绝');
      expect(text).toContain('未初始化');
      expect(await userModel.countDocuments({})).toBe(0);

      // 大声失败之后站点照常可走向导（默认开启 ⇒ 带上新启动生成的密钥）：
      // 拒绝 env 凭据 ≠ 锁死安装
      await initProvider.refreshSetupKey();
      const key = fs.readFileSync(setupKeyFilePath(), 'utf-8');
      const res = await request(server)
        .post('/api/admin/init')
        .send({ ...initPayload('WizardAfterReject'), setupKey: key });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ statusCode: 200, message: '初始化成功!' });
      error.mockRestore();
    });

    it('站点已初始化 → env 被忽略（INFO 一句），一个字都不写，也不再打印密钥块', async () => {
      await freshSite();
      process.env[SETUP_KEY_REQUIRE_ENV] = 'false'; // 用逃生口快速完成首次初始化
      const res = await request(server).post('/api/admin/init').send(initPayload('FirstOwner'));
      expect(res.status).toBe(201);
      delete process.env[SETUP_KEY_REQUIRE_ENV]; // 回到默认（开）
      process.env[ENV_ADMIN_USER] = 'RotatedOwner';
      process.env[ENV_ADMIN_PASSWORD] = 'rotated-fixture-secret';
      const log = jest.spyOn((initProvider as any).logger, 'log').mockImplementation(() => undefined);
      const warn = jest.spyOn((initProvider as any).logger, 'warn').mockImplementation(() => undefined);
      await initProvider.onModuleInit();
      const text = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toContain('忽略');
      expect(text).not.toContain('rotated-fixture-secret');
      expect(await userModel.countDocuments({})).toBe(1);
      expect(await userModel.findOne({ name: 'RotatedOwner' })).toBeNull();
      // 已初始化的站点（= 生产实况）：默认开启也绝不刷密钥块、不生成文件
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('初始化密钥');
      expect(fs.existsSync(setupKeyFilePath())).toBe(false);
      log.mockRestore();
      warn.mockRestore();
    });
  });
});
