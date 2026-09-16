/**
 * 「初始化页上传整站备份恢复」的真库量具：用**真实归档**跑一遍完整的处理器链路。
 *
 * 覆盖的是 HTTP 之下的全部真东西：`checkHasInited()` 闸门 → 文件名白名单 →
 * 读 manifest → 归档成员穿越检查 → `FullBackupProvider.restore()`（真 mongod、
 * 真 zstd/tar 解包、真 BSON 解码）→ 缓存作废 → 返回信封里的数字。
 * 只有 multipart 解析那一层不在这里（它由 `RESTORE_UPLOAD_OPTIONS` 与后台那条
 * 已鉴权的恢复接口**共用同一份**，源码级钉子见
 * `src/audit-hardening-round3-initrestore.spec.ts`）。
 *
 * ⚠️ 默认**整套跳过**。要跑就给一个**一次性库名**（会 dropDatabase，硬护栏拒绝真实库名）
 * 和一份真实的整站备份归档：
 *
 *   VANBLOG_INIT_RESTORE_URL='mongodb://127.0.0.1:27018/?directConnection=true' \
 *   VANBLOG_INIT_RESTORE_ARCHIVE=/path/to/vanblog-full-YYYYMMDD-HHMMSS.tar.zst \
 *     ./node_modules/.bin/jest --config ./test/jest-init-restore.json
 *
 * ⚠️ URL 必须是**独立的 mongod**（不是开发栈那个）：恢复是按 manifest 里的库名写库的
 * （`vanBlog` / `waline`），指到开发库上等于把真数据覆盖掉。护栏会检查端口不是 27017。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import mongoose from 'mongoose';

import { InitController } from 'src/controller/admin/init/init.controller';
import { InitProvider } from 'src/provider/init/init.provider';
import { FullBackupProvider } from 'src/provider/backup/fullBackup.provider';
import { ViewStatsProvider } from 'src/provider/stats/viewStats.provider';
import { CacheProvider } from 'src/provider/cache/cache.provider';
import { Meta, MetaSchema } from 'src/scheme/meta.schema';
import { User, UserSchema } from 'src/scheme/user.schema';
import { Category, CategorySchema } from 'src/scheme/category.schema';
import { CustomPage, CustomPageSchema } from 'src/scheme/customPage.schema';
import { Article, ArticleSchema } from 'src/scheme/article.schema';
import { Viewer, ViewerSchema } from 'src/scheme/viewer.schema';
import { Visit, VisitSchema } from 'src/scheme/visit.schema';

const URL = process.env.VANBLOG_INIT_RESTORE_URL || '';
const ARCHIVE = process.env.VANBLOG_INIT_RESTORE_ARCHIVE || '';
const d = URL ? describe : describe.skip;

d('POST /api/admin/init/restore against a real mongod + a real archive', () => {
  jest.setTimeout(600000);
  let conn: mongoose.Connection;
  let root = '';
  let staticPath = '';
  let controller: InitController;
  let stubs: {
    waline: { init: jest.Mock };
    website: { restart: jest.Mock };
    isr: { activeAll: jest.Mock };
    viewStats: ViewStatsProvider;
    initProvider: InitProvider;
  };
  let uploadedCopy = '';

  beforeAll(async () => {
    // 硬护栏：恢复是**按 manifest 里的库名**写库的（vanBlog / waline），
    // 所以真正决定安全与否的是"连到哪台 mongod"，不是 URL 里的库名。
    // 只允许本机的独立实例，并且**绝不许**是开发栈那个 27017。
    if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):/.test(URL)) {
      throw new Error(`VANBLOG_INIT_RESTORE_URL 必须是本机独立 mongod（当前：${URL}）`);
    }
    if (/:27017(\/|\?|$)/.test(URL)) {
      throw new Error(
        'VANBLOG_INIT_RESTORE_URL 指向 27017（开发栈的真库）—— 恢复会覆盖 vanBlog/waline，拒绝执行',
      );
    }
    conn = mongoose.createConnection(URL, {
      serverSelectionTimeoutMS: 5000,
      autoIndex: false,
    } as any);
    await conn.asPromise();
    // 全新站点：库里什么都没有 ⇒ checkHasInited() 为 false
    await conn.db.dropDatabase();
    try {
      await conn.useDb('waline').dropDatabase();
    } catch {
      // 本来就没有
    }

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vanblog-init-restore-'));
    staticPath = path.join(root, 'static');
    fs.mkdirSync(staticPath, { recursive: true });

    const metaModel = conn.model(Meta.name, MetaSchema);
    const userModel = conn.model(User.name, UserSchema);
    const categoryModel = conn.model(Category.name, CategorySchema);
    const customPageModel = conn.model(CustomPage.name, CustomPageSchema);
    const articleModel = conn.model(Article.name, ArticleSchema);
    const viewerModel = conn.model(Viewer.name, ViewerSchema);
    const visitModel = conn.model(Visit.name, VisitSchema);

    const waline = { init: jest.fn(async () => undefined) };
    const website = { restart: jest.fn(async () => undefined) };
    const isr = { activeAll: jest.fn() };
    const settingProvider = {
      getStaticSetting: jest.fn(async () => ({})),
      updateStaticSetting: jest.fn(),
      updateCommentSetting: jest.fn(),
      updateMenuSetting: jest.fn(),
    };
    const cacheProvider = new CacheProvider();
    const initProvider = new InitProvider(
      metaModel as any,
      userModel as any,
      categoryModel as any,
      customPageModel as any,
      waline as any,
      settingProvider as any,
      cacheProvider,
      website as any,
    );
    const viewStats = new ViewStatsProvider(
      metaModel as any,
      articleModel as any,
      viewerModel as any,
      visitModel as any,
    );
    const fullBackupProvider = new FullBackupProvider(conn);
    // 恢复要往 staticPath 写整棵静态树，而 FullBackupProvider 用的是 config.staticPath
    // ⇒ 这里把 config 指到临时目录（只影响本进程）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('src/config');
    config.staticPath = staticPath;
    config.backupPath = path.join(root, 'backups');
    fs.mkdirSync(config.backupPath, { recursive: true });

    controller = new InitController(
      initProvider,
      { upload: jest.fn() } as any,
      isr as any,
      fullBackupProvider,
      waline as any,
      website as any,
      viewStats,
    );
    stubs = { waline, website, isr, viewStats, initProvider };
  });

  afterAll(async () => {
    if (uploadedCopy) fs.rmSync(uploadedCopy, { force: true });
    if (conn) await conn.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('未初始化 + 真归档 ⇒ 200，信封里的数字与归档清单一致', async () => {
    if (!ARCHIVE || !fs.existsSync(ARCHIVE)) {
      // eslint-disable-next-line no-console
      console.log(`（跳过：VANBLOG_INIT_RESTORE_ARCHIVE 没给或文件不存在：${ARCHIVE}）`);
      return;
    }
    // 模拟 multer 落盘后的 file 对象：真实归档拷到 upload-tmp 下（处理器必须在 finally 里删掉它）
    const uploadTmp = path.join(root, 'backups', 'upload-tmp');
    fs.mkdirSync(uploadTmp, { recursive: true });
    uploadedCopy = path.join(uploadTmp, `restore-upload-${Date.now()}.tar.zst`);
    fs.copyFileSync(ARCHIVE, uploadedCopy);
    const originalname = path.basename(ARCHIVE);

    expect(await stubs.initProvider.checkHasInited()).toBe(false);

    const res: any = await controller.restoreFromInitPage({
      path: uploadedCopy,
      originalname,
      size: fs.statSync(ARCHIVE).size,
    } as any);

    expect(res.statusCode).toBe(200);
    expect(res.data).toBeDefined();
    // eslint-disable-next-line no-console
    console.log(
      `[init/restore] seconds=${res.data.seconds} needsRestartForPipelineDeps=${res.data.needsRestartForPipelineDeps} counts=${JSON.stringify(res.data.counts)} ` +
        `databases=${JSON.stringify(res.data.databases)} static=${JSON.stringify(res.data.static)} ` +
        `adminUserFromArchive=${res.data.adminUserFromArchive} initialized=${res.data.initialized}`,
    );
    expect(res.data.initialized).toBe(true);
    expect(res.data.adminUserFromArchive).toBe(true);
    // 这份归档里有 1 条流水线 ⇒ 全新机器上没有 codeRunner/node_modules，前台要提示"重启一次"
    expect(res.data.needsRestartForPipelineDeps).toBe(true);
    expect(res.data.counts.articles).toBeGreaterThan(0);
    expect(res.data.counts.users).toBeGreaterThan(0);
    expect(typeof res.data.backupCreatedAt).toBe('string');

    // 临时归档必须被删掉（不然每试一次泄漏一份几百 MB）
    expect(fs.existsSync(uploadedCopy)).toBe(false);

    // 恢复后的副作用
    expect(stubs.waline.init).toHaveBeenCalled();
    expect(stubs.website.restart).toHaveBeenCalled();
    // ⚠️ 第二个参数必须是 1000：`activeAll` 会把它转交给 RSS 与 sitemap 两个生成器，
    // 传 undefined 就变成"RSS 3 分钟后、sitemap 1 分钟后"才写文件，而且会被后续任何一次
    // activeAll 重置 —— 容器里实测过：刚恢复完 /app/static/rss/ 是空的、GET /feed.xml 404。
    expect(stubs.isr.activeAll).toHaveBeenCalledWith(
      expect.stringContaining('初始化页恢复整站备份'),
      1000,
      { forceActice: true },
    );
  });

  it('恢复后的库就是那份归档的内容（公开文章数 / 图床记录数 / 站点名 / 静态文件）', async () => {
    if (!ARCHIVE || !fs.existsSync(ARCHIVE)) {
      return;
    }
    const db = conn.useDb('vanBlog');
    const totalArticles = await db.collection('articles').countDocuments({});
    const publicArticles = await db.collection('articles').countDocuments({
      $and: [
        { $or: [{ deleted: false }, { deleted: { $exists: false } }] },
        { $or: [{ hidden: false }, { hidden: { $exists: false } }] },
      ],
    });
    const statics = await db.collection('statics').countDocuments({});
    const users = await db.collection('users').find({}, { projection: { name: 1, type: 1 } }).toArray();
    const meta: any = await db.collection('metas').findOne({});
    const imgFiles = fs.existsSync(path.join(staticPath, 'img'))
      ? fs.readdirSync(path.join(staticPath, 'img')).length
      : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[恢复结果] articles 总=${totalArticles} 公开=${publicArticles} statics=${statics} ` +
        `users=${users.length}(${users.map((u: any) => u.type).join(',')}) ` +
        `siteName长度=${String(meta?.siteInfo?.siteName || '').length} 静态 img 条目=${imgFiles}`,
    );
    expect(totalArticles).toBeGreaterThan(0);
    expect(publicArticles).toBeGreaterThan(0);
    expect(statics).toBeGreaterThan(0);
    expect(users.length).toBeGreaterThan(0);
    expect(String(meta?.siteInfo?.siteName || '').length).toBeGreaterThan(0);
    expect(imgFiles).toBeGreaterThan(0);
  });

  it('恢复完站点就是"已初始化"了：同一个接口再调一次必须 403', async () => {
    if (!ARCHIVE || !fs.existsSync(ARCHIVE)) {
      return;
    }
    expect(await stubs.initProvider.checkHasInited()).toBe(true);
    const p = path.join(root, 'again.tar.zst');
    fs.writeFileSync(p, 'x');
    let status = 0;
    try {
      await controller.restoreFromInitPage({
        path: p,
        originalname: 'vanblog-full-20260913-140955.tar.zst',
      } as any);
    } catch (err: any) {
      status = err?.getStatus?.() || 0;
    }
    expect(status).toBe(403);
    expect(fs.existsSync(p)).toBe(false); // 临时文件照样清理
  });
});
