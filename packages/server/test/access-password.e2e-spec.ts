/**
 * 文章 / 分类访问密码：**在真 mongod 上**验证哈希化写入、明文清洗与响应脱敏。
 *
 * 为什么不只用假 Mongo（`article.provider.accessPassword.spec.ts` 已经覆盖了规则本身）：
 * 这一组要证明的三件事**恰恰取决于真实服务器/真实 mongoose 的行为** ——
 *  1. schema 上挂的 `toJSON` transform 到底会不会把 `password` 换成 `hasPassword`，
 *     以及"投影没 select password 时响应一个字节都不变"（公开面形状不能动）；
 *  2. `toObject()` / 属性访问仍然能读到真实存储值（整站备份、markdown front matter、
 *     `getByIdWithPassword` 的校验都靠这个前提）；
 *  3. 用**原生 driver** 直接插一条明文文档（= 从旧整站备份恢复出来的形状，
 *     `utils/fullBackup.ts` 就是这么写库的）之后：能不能解锁 → 洗完还能不能用同一个
 *     密码解锁 → 库里是不是变成了哈希。
 * 顺带把 scrypt 的实测耗时打出来（哈希 / 校验 / wash 全量），供交付报告引用。
 *
 * ⚠️ 默认**整套跳过**（CI 上没有 mongod）。要跑就给一个**一次性库名**（会 dropDatabase，
 * 代码里有硬护栏：绝不允许指向 27017 上的开发库，也不允许叫 vanBlog/waline/admin/...）：
 *
 *   .tools/mongodb/bin/mongod --port 27055 --dbpath vanblog_dev/tmp/accesspw/mongo --fork \
 *     --logpath vanblog_dev/tmp/accesspw/mongod.log
 *   VANBLOG_ACCESS_PASSWORD_URL='mongodb://127.0.0.1:27055/vanblog_accesspw_scratch?directConnection=true' \
 *     ./node_modules/.bin/jest --config ./test/jest-access-password.json
 */
import mongoose from 'mongoose';

import { ArticleProvider } from 'src/provider/article/article.provider';
import { CategoryProvider } from 'src/provider/category/category.provider';
import { Article, ArticleSchema } from 'src/scheme/article.schema';
import { Category, CategorySchema } from 'src/scheme/category.schema';
import { hashAccessPassword, isScryptHash, verifyAccessPassword } from 'src/utils/crypto';

const URL = process.env.VANBLOG_ACCESS_PASSWORD_URL || '';
const d = URL ? describe : describe.skip;

d('访问密码哈希化 against a real mongod', () => {
  jest.setTimeout(180000);
  let conn: mongoose.Connection;
  let articleModel: mongoose.Model<any>;
  let categoryModel: mongoose.Model<any>;
  let articleProvider: ArticleProvider;
  let categoryProvider: CategoryProvider;
  /** 原生 driver 句柄：用来模拟"整站备份原样写回" */
  let rawArticles: any;
  let rawCategories: any;

  const metaStub: any = {
    updateTotalWords: () => undefined,
    getSiteInfo: async () => ({}),
  };
  const visitStub: any = {};
  const draftStub: any = { updateCategoryName: async () => ({ modifiedCount: 0 }) };

  beforeAll(async () => {
    const dbName = URL.replace(/^[^/]*\/\/[^/]+\//, '').split('?')[0];
    // 硬护栏 1：一次性库名
    if (!/^[A-Za-z0-9_-]+$/.test(dbName) || /^(vanBlog|waline|admin|local|config|test)$/i.test(dbName)) {
      throw new Error(`VANBLOG_ACCESS_PASSWORD_URL 必须指向一次性临时库（解析出 "${dbName}"），拒绝执行`);
    }
    // 硬护栏 2：绝不允许 27017 —— 那是开发栈的真库（有从生产导入的数据）
    if (/:27017(\/|\?|$)/.test(URL)) {
      throw new Error('VANBLOG_ACCESS_PASSWORD_URL 指向 27017（开发栈的真库），拒绝执行');
    }
    conn = mongoose.createConnection(URL, {
      serverSelectionTimeoutMS: 4000,
      autoIndex: false,
    } as any);
    await conn.asPromise();
    await conn.db.dropDatabase();
    articleModel = conn.model(Article.name, ArticleSchema);
    categoryModel = conn.model(Category.name, CategorySchema);
    rawArticles = conn.db.collection('articles');
    rawCategories = conn.db.collection('categories');
    articleProvider = new ArticleProvider(
      articleModel as any,
      categoryModel as any,
      metaStub,
      visitStub,
    );
    categoryProvider = new CategoryProvider(categoryModel as any, articleProvider, draftStub);
  });

  afterAll(async () => {
    if (conn) {
      await conn.close();
    }
  });

  // -------------------------------------------------------------------------
  // 1) 响应脱敏：toJSON transform（真 mongoose）
  // -------------------------------------------------------------------------
  describe('schema toJSON transform：密文绝不下发', () => {
    const HASH = hashAccessPassword('transform-pw');

    beforeEach(async () => {
      await rawArticles.deleteMany({});
      await rawArticles.insertOne({
        id: 1,
        title: '加密文',
        content: 'SECRET-BODY',
        category: '随笔',
        tags: [],
        hidden: false,
        deleted: false,
        private: true,
        password: HASH,
        publishAt: null,
        wordCount: 11,
        pathname: 'secret-post',
      });
    });

    it('adminView（select 了 password）⇒ JSON 里没有 password，只有 hasPassword: true', async () => {
      const doc: any = await articleModel.findOne({ id: 1 }, (articleProvider as any).adminView);
      const json = JSON.parse(JSON.stringify(doc));
      expect('password' in json).toBe(false);
      expect(json.hasPassword).toBe(true);
      expect(JSON.stringify(json)).not.toContain('scrypt$');
      // 其它字段照常（transform 只动 password 一个键）
      expect(json.title).toBe('加密文');
      expect(json.id).toBe(1);
    });

    it('adminListView（后台列表投影）⇒ 同样只有 hasPassword，且没有 content', async () => {
      const doc: any = await articleModel.findOne({ id: 1 }, (articleProvider as any).adminListView);
      const json = JSON.parse(JSON.stringify(doc));
      expect('password' in json).toBe(false);
      expect(json.hasPassword).toBe(true);
      expect('content' in json).toBe(false);
    });

    it('publicView / listView（没 select password）⇒ 响应与改造前逐字节一致：既无 password 也无 hasPassword', async () => {
      for (const viewName of ['publicView', 'listView'] as const) {
        const doc: any = await articleModel.findOne({ id: 1 }, (articleProvider as any)[viewName]);
        const json = JSON.parse(JSON.stringify(doc));
        expect('password' in json).toBe(false);
        // 关键：公开面**不能**多出一个键（前台 __NEXT_DATA__ 里多一个键都是白送体积，
        // 而且 listView 压根没取密码，写 hasPassword:false 是在撒谎）
        expect('hasPassword' in json).toBe(false);
      }
    });

    it('toObject() 与属性访问仍然读得到真实存储值（备份 / markdown 导出 / 解锁校验靠这个）', async () => {
      const doc: any = await articleModel.findOne({ id: 1 }, (articleProvider as any).adminView);
      expect(doc.password).toBe(HASH);
      expect(doc.toObject().password).toBe(HASH);
      expect(doc._doc.password).toBe(HASH);
      // 但 toJSON() 里没有
      expect('password' in doc.toJSON()).toBe(false);
    });

    it('没设密码的文章 ⇒ hasPassword: false（不是缺键）', async () => {
      await rawArticles.updateOne({ id: 1 }, { $set: { password: '' } });
      const doc: any = await articleModel.findOne({ id: 1 }, (articleProvider as any).adminView);
      const json = JSON.parse(JSON.stringify(doc));
      expect(json.hasPassword).toBe(false);
      expect('password' in json).toBe(false);
    });

    it('分类文档同规则（getAllCategories(true) 是后台分类页的取数口）', async () => {
      await rawCategories.deleteMany({});
      await rawCategories.insertOne({
        id: 1,
        name: '私密分类',
        type: 'category',
        private: true,
        hidden: false,
        order: 0,
        password: HASH,
      });
      const docs: any = await categoryProvider.getAllCategories(true);
      const json = JSON.parse(JSON.stringify(docs));
      expect(json[0].hasPassword).toBe(true);
      expect('password' in json[0]).toBe(false);
      expect(JSON.stringify(json)).not.toContain('scrypt$');
      // 内部读仍然拿得到
      expect(docs[0].password).toBe(HASH);
    });

    it('老分类文档整个 password 键都不存在 ⇒ JSON 里也没有 hasPassword（消费方按 Boolean() 读）', async () => {
      await rawCategories.deleteMany({});
      await rawCategories.insertOne({ id: 2, name: '老分类', type: 'category', private: false });
      const docs: any = await categoryProvider.getAllCategories(true);
      const json = JSON.parse(JSON.stringify(docs));
      expect('password' in json[0]).toBe(false);
      expect('hasPassword' in json[0]).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2) 端到端：写入 → 解锁 → 列表
  // -------------------------------------------------------------------------
  describe('写入即哈希 + 解锁仍然可用', () => {
    beforeEach(async () => {
      await rawArticles.deleteMany({});
      await rawCategories.deleteMany({});
    });

    it('create 存哈希；用原密码能解锁；解锁响应不带 password', async () => {
      const created: any = await articleProvider.create({
        title: '新加密文',
        content: 'BODY',
        category: '随笔',
        private: true,
        password: 'e2e-pw',
      } as any);
      const stored = await rawArticles.findOne({ id: created.id });
      expect(isScryptHash(stored.password)).toBe(true);
      expect(stored.password).not.toContain('e2e-pw');

      const unlocked: any = await articleProvider.getByIdWithPassword(created.id, 'e2e-pw');
      expect(unlocked?.content).toBe('BODY');
      expect(unlocked?.password).toBeUndefined();
      expect(await articleProvider.getByIdWithPassword(created.id, 'wrong')).toBeNull();
    });

    it('加密分类下的文章：用**分类**密码解锁（继承路径），迁移前后都成立', async () => {
      await categoryProvider.importCategories([
        { id: 1, name: '保险箱', private: true, password: 'cat-pw' } as any,
      ]);
      const catStored = await rawCategories.findOne({ name: '保险箱' });
      expect(isScryptHash(catStored.password)).toBe(true);

      const created: any = await articleProvider.create({
        title: '分类里的文章',
        content: 'CAT-BODY',
        category: '保险箱',
      } as any);
      // 文章自己没密码，但分类加密 ⇒ 必须用分类密码
      expect(await articleProvider.getByIdWithPassword(created.id, 'cat-pw')).not.toBeNull();
      expect(await articleProvider.getByIdWithPassword(created.id, 'nope')).toBeNull();
      const unlocked: any = await articleProvider.getByIdWithPassword(created.id, 'cat-pw');
      expect(unlocked.content).toBe('CAT-BODY');
    });

    it('管理端列表（toListView）⇒ 有 hasPassword、没有 password、没有 content', async () => {
      await articleProvider.create({
        title: 'A',
        content: 'AAA',
        category: 'c',
        private: true,
        password: 'pw-a',
      } as any);
      await articleProvider.create({ title: 'B', content: 'BBB', category: 'c' } as any);
      const data: any = await articleProvider.getByOption(
        { page: 1, pageSize: 10, toListView: true } as any,
        false,
      );
      const json = JSON.stringify(JSON.parse(JSON.stringify(data.articles)));
      expect(json).not.toContain('"password"');
      expect(json).not.toContain('scrypt$');
      expect(json).not.toContain('AAA');
      const byTitle: any = {};
      for (const a of data.articles) byTitle[a.title] = a;
      expect(byTitle.A.hasPassword).toBe(true);
      expect(byTitle.B.hasPassword).toBe(false);
    });

    it('公开列表形状不变：没有 password，也没有 hasPassword', async () => {
      await articleProvider.create({
        title: 'P',
        content: 'PPP',
        category: 'c',
        private: true,
        password: 'pw-p',
      } as any);
      const data: any = await articleProvider.getByOption(
        { page: 1, pageSize: -1, toListView: true } as any,
        true,
      );
      const json = JSON.stringify(JSON.parse(JSON.stringify(data.articles)));
      expect(json).not.toContain('"password"');
      expect(json).not.toContain('hasPassword');
      expect(json).not.toContain('scrypt$');
    });
  });

  // -------------------------------------------------------------------------
  // 3) JSON 备份导出的往返保真（密文必须留在归档里，否则导入到别的站点会静默解密）
  // -------------------------------------------------------------------------
  describe('导出/导入往返', () => {
    beforeEach(async () => {
      await rawArticles.deleteMany({});
      await rawCategories.deleteMany({});
    });

    it('getAllForExport() 保留存储态密码；而 JSON.stringify(文档) 会被 toJSON 抹掉', async () => {
      await articleProvider.create({
        title: '导出用',
        content: 'C',
        category: 'c',
        private: true,
        password: 'export-pw',
      } as any);
      const exported: any[] = await articleProvider.getAllForExport(true);
      expect(exported).toHaveLength(1);
      expect(isScryptHash(exported[0].password)).toBe(true);
      expect(verifyAccessPassword(exported[0].password, 'export-pw')).toBe(true);
      // 导出 JSON 里必须真的有 password（这就是 GET /api/admin/backup/export 的形状）
      const exportedJson = JSON.stringify({ articles: exported });
      expect(exportedJson).toContain('"password":"scrypt$');
      expect(exportedJson).not.toContain('export-pw');

      // 对照：直接把 mongoose 文档丢进 JSON.stringify 就会丢密码 —— 这正是那个回归
      const docs: any = await articleProvider.getAll('admin', true);
      const docJson = JSON.stringify({ articles: docs });
      expect(docJson).not.toContain('"password"');
      expect(docJson).toContain('"hasPassword":true');
    });

    it('导出的哈希再导入回来：仍然是同一个哈希（不二次哈希），原密码照样解锁', async () => {
      await articleProvider.create({
        title: '往返',
        content: 'C',
        category: 'c',
        private: true,
        password: 'round-trip',
      } as any);
      const exported: any[] = await articleProvider.getAllForExport(true);
      const storedHash = exported[0].password;

      await rawArticles.deleteMany({});
      // importArticles 就是 JSON 导入走的路径
      await articleProvider.importArticles(exported as any);
      const after: any = await rawArticles.findOne({ title: '往返' });
      expect(after.password).toBe(storedHash);
      const unlocked: any = await articleProvider.getByIdWithPassword(after.id, 'round-trip');
      expect(unlocked?.content).toBe('C');
    });

    it('分类导出/导入往返同样保真（toExportCategory 是属性访问，不走 toJSON）', async () => {
      await categoryProvider.importCategories([
        { id: 1, name: '保险箱', private: true, password: 'cat-export' } as any,
      ]);
      const docs: any = await categoryProvider.getAllCategories(true);
      // 响应形状：没有 password，只有 hasPassword
      const json = JSON.parse(JSON.stringify(docs));
      expect('password' in json[0]).toBe(false);
      expect(json[0].hasPassword).toBe(true);
      // 导出用的属性访问：拿得到存储态哈希
      const storedHash = docs[0].password;
      expect(isScryptHash(storedHash)).toBe(true);

      await categoryProvider.importCategories([
        { id: 1, name: '保险箱', private: true, password: storedHash } as any,
      ]);
      const after = await rawCategories.findOne({ name: '保险箱' });
      expect(after.password).toBe(storedHash);
      expect(verifyAccessPassword(after.password, 'cat-export')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4) 旧归档 / 历史明文：恢复 → 能解锁 → 洗完还能解锁
  // -------------------------------------------------------------------------
  describe('旧整站备份（明文密码）恢复之后的行为', () => {
    beforeEach(async () => {
      await rawArticles.deleteMany({});
      await rawCategories.deleteMany({});
    });

    it('原生 driver 写回的明文文档：立刻能解锁；洗完还是同一个密码能解锁，库里变成哈希', async () => {
      // 这就是 utils/fullBackup.ts 恢复旧归档时的形状：绕过所有 provider，原样写库
      await rawArticles.insertOne({
        id: 101,
        title: '老文章',
        content: 'OLD-BODY',
        category: '随笔',
        tags: [],
        hidden: false,
        deleted: false,
        private: true,
        password: 'legacy-plain-pw',
        publishAt: null,
      });
      await rawCategories.insertOne({
        id: 101,
        name: '老分类',
        type: 'category',
        private: true,
        password: 'legacy-cat-pw',
      });

      // 迁移之前：明文照样能解锁（向后兼容是硬要求）
      const before: any = await articleProvider.getByIdWithPassword(101, 'legacy-plain-pw');
      expect(before?.content).toBe('OLD-BODY');
      expect(await articleProvider.getByIdWithPassword(101, 'wrong')).toBeNull();

      const result = await articleProvider.washAccessPasswords();
      expect(result.articles).toBe(1);
      expect(result.categories).toBe(1);
      expect(result.washed).toBe(2);

      const articleStored = await rawArticles.findOne({ id: 101 });
      const categoryStored = await rawCategories.findOne({ name: '老分类' });
      expect(isScryptHash(articleStored.password)).toBe(true);
      expect(isScryptHash(categoryStored.password)).toBe(true);
      expect(articleStored.password).not.toContain('legacy-plain-pw');

      // 迁移之后：**同一个密码**仍然解锁（用户完全无感）
      const after: any = await articleProvider.getByIdWithPassword(101, 'legacy-plain-pw');
      expect(after?.content).toBe('OLD-BODY');
      expect(await articleProvider.getByIdWithPassword(101, 'wrong')).toBeNull();
    });

    it('幂等：第二次 wash 一条都不改（scanned 不变、washed=0、哈希没有被二次哈希）', async () => {
      await rawArticles.insertOne({ id: 201, title: 'x', category: 'c', private: true, password: 'p1' });
      const first = await articleProvider.washAccessPasswords();
      const hashAfterFirst = (await rawArticles.findOne({ id: 201 })).password;
      expect(first.washed).toBe(1);

      const second = await articleProvider.washAccessPasswords();
      expect(second.washed).toBe(0);
      expect(second.alreadyHashed).toBe(1);
      const hashAfterSecond = (await rawArticles.findOne({ id: 201 })).password;
      expect(hashAfterSecond).toBe(hashAfterFirst);
      expect(verifyAccessPassword(hashAfterSecond, 'p1')).toBe(true);
    });

    it('部分迁移的库照常工作：一半明文一半哈希，两边都能解锁', async () => {
      await rawArticles.insertMany([
        { id: 301, title: 'a', content: 'A', category: 'c', private: true, password: 'pw-a', hidden: false, deleted: false },
        { id: 302, title: 'b', content: 'B', category: 'c', private: true, password: hashAccessPassword('pw-b'), hidden: false, deleted: false },
      ]);
      const a: any = await articleProvider.getByIdWithPassword(301, 'pw-a');
      const b: any = await articleProvider.getByIdWithPassword(302, 'pw-b');
      expect(a?.content).toBe('A');
      expect(b?.content).toBe('B');
    });

    it('写时升级：一次"只改标题"的保存就把存量明文换成哈希', async () => {
      await rawArticles.insertOne({
        id: 401,
        title: '旧标题',
        content: 'C',
        category: 'c',
        private: true,
        password: 'upgrade-me',
        deleted: false,
      });
      await articleProvider.updateById(401, { title: '新标题' } as any);
      const stored = await rawArticles.findOne({ id: 401 });
      expect(isScryptHash(stored.password)).toBe(true);
      expect(verifyAccessPassword(stored.password, 'upgrade-me')).toBe(true);
      const unlocked: any = await articleProvider.getByIdWithPassword(401, 'upgrade-me');
      expect(unlocked?.title).toBe('新标题');
    });

    it('空语料：库里没有任何待洗文档时，wash 是免费的（scanned=0 / washed=0 / 毫秒级）', async () => {
      await rawArticles.deleteMany({});
      await rawCategories.deleteMany({});
      // 造几条"不需要洗"的：没密码 / 空密码 / 已经是哈希
      await rawArticles.insertMany([
        { id: 501, title: 'a', category: 'c', deleted: false },
        { id: 502, title: 'b', category: 'c', password: '', deleted: false },
        { id: 503, title: 'c', category: 'c', password: hashAccessPassword('already'), private: true, deleted: false },
      ]);
      const started = process.hrtime.bigint();
      const result = await articleProvider.washAccessPasswords();
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      expect(result.scanned).toBe(1); // 只有那条已是哈希的进了候选集
      expect(result.washed).toBe(0);
      expect(result.articles).toBe(0);
      expect(result.categories).toBe(0);
      expect(result.alreadyHashed).toBe(1);
      // 一次 scrypt 都不跑 ⇒ 只花两次集合扫描的时间。这条钉子的意义是：
      // 绝大多数站点（加密文章本来就少）不会为这个 wash 付任何启动成本。
      expect(elapsedMs).toBeLessThan(500);
      // eslint-disable-next-line no-console
      console.log(`[wash 空语料] scanned=${result.scanned} washed=${result.washed} 实测=${elapsedMs.toFixed(1)}ms`);
    });

    it('留空 = 不修改：一次没碰密码的保存**不会**把加密抹掉（这是本次语义变更的核心）', async () => {
      await articleProvider.create({
        title: '保持加密',
        content: 'C',
        category: 'c',
        private: true,
        password: 'keep-me',
      } as any);
      const before = await rawArticles.findOne({ title: '保持加密' });
      // 后台表单不再回填密码，所以每次保存都会带一个空的 password 字段
      await articleProvider.updateById(before.id, { title: '改个标题', password: '' } as any);
      const after = await rawArticles.findOne({ title: '改个标题' });
      expect(after.password).toBe(before.password);
      expect(isScryptHash(after.password)).toBe(true);
      const unlocked: any = await articleProvider.getByIdWithPassword(after.id, 'keep-me');
      expect(unlocked?.content).toBe('C');
    });

    it('没有 password 键的保存**绝不**触碰存量哈希（直接查原生集合，一个字节都不能变）', async () => {
      await articleProvider.create({
        title: '别动我的密码',
        content: 'C',
        category: 'c',
        private: true,
        password: 'do-not-touch',
      } as any);
      const before = await rawArticles.findOne({ title: '别动我的密码' });
      expect(isScryptHash(before.password)).toBe(true);

      // 编辑器自动保存 / 改置顶 / 改分类 …… 这些请求的 DTO 里根本没有 password 键
      // （不用 hidden：隐藏文章的解锁口会按既有语义直接 404，那是另一条钉子的事）
      await articleProvider.updateById(before.id, { top: 3 } as any);
      await articleProvider.updateById(before.id, { category: '别的分类' } as any);
      await articleProvider.updateById(before.id, { content: 'C' } as any);

      const after = await rawArticles.findOne({ _id: before._id });
      expect(after.password).toBe(before.password);
      expect(isScryptHash(after.password)).toBe(true);
      const unlocked: any = await articleProvider.getByIdWithPassword(before.id, 'do-not-touch');
      expect(unlocked?.content).toBe('C');
    });

    it('clearPassword: true 才真的解除加密', async () => {
      await articleProvider.create({
        title: '要解除',
        content: 'C',
        category: 'c',
        private: true,
        password: 'bye',
      } as any);
      const before = await rawArticles.findOne({ title: '要解除' });
      await articleProvider.updateById(before.id, { clearPassword: true } as any);
      const after = await rawArticles.findOne({ title: '要解除' });
      expect(after.password).toBe('');
      // 解除之后：标记为加密但没密码 ⇒ 解锁口拒绝给正文（既有语义，见 getByIdWithPassword 注释）
      expect(await articleProvider.getByIdWithPassword(before.id, 'anything')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 5) 实测耗时（交付报告要引用的数字）
  // -------------------------------------------------------------------------
  describe('scrypt 实测耗时', () => {
    it('打印 hash / verify / wash 的墙钟时间', async () => {
      const N = 20;
      let t = process.hrtime.bigint();
      for (let i = 0; i < N; i += 1) hashAccessPassword(`pw-${i}`);
      const hashNs = Number(process.hrtime.bigint() - t);

      const hash = hashAccessPassword('measure-me');
      t = process.hrtime.bigint();
      for (let i = 0; i < N; i += 1) verifyAccessPassword(hash, 'measure-me');
      const verifyNs = Number(process.hrtime.bigint() - t);

      t = process.hrtime.bigint();
      for (let i = 0; i < N; i += 1) verifyAccessPassword('legacy-plaintext', 'measure-me');
      const legacyNs = Number(process.hrtime.bigint() - t);

      // wash 在"现实规模"上的耗时：本机导入的生产库是 53 篇文章 / 1 个分类，
      // 这里按 300 条加密文档量一遍（远大于真实站点，用来给出上界）
      await rawArticles.deleteMany({});
      const docs = [];
      for (let i = 0; i < 300; i += 1) {
        docs.push({ id: 1000 + i, title: `t${i}`, category: 'c', private: true, password: `pw-${i}`, deleted: false });
      }
      await rawArticles.insertMany(docs);
      const washStart = process.hrtime.bigint();
      const result = await articleProvider.washAccessPasswords();
      const washNs = Number(process.hrtime.bigint() - washStart);

      const ms = (ns: number) => (ns / 1e6).toFixed(1);

      // 解锁口的"前后对比"：同一条 getByIdWithPassword 调用链（含 2 次真实 DB 往返），
      // 存量分别是明文与哈希。这是 POST /api/public/article/:id 的服务端成本主体
      // （控制器那一层只多一个内存里的限流计数器）。
      await rawArticles.deleteMany({});
      await rawCategories.deleteMany({});
      const hashForLatency = hashAccessPassword('latency-pw');
      await rawArticles.insertMany([
        { id: 9001, title: 'plain', content: 'X', category: 'c', private: true, password: 'latency-pw', hidden: false, deleted: false },
        { id: 9002, title: 'hashed', content: 'X', category: 'c', private: true, password: hashForLatency, hidden: false, deleted: false },
      ]);
      const timeUnlock = async (id: number, rounds: number) => {
        const start = process.hrtime.bigint();
        for (let i = 0; i < rounds; i += 1) {
          await articleProvider.getByIdWithPassword(id, 'latency-pw');
        }
        return Number(process.hrtime.bigint() - start) / 1e6 / rounds;
      };
      const ROUNDS = 10;
      const unlockPlainMs = await timeUnlock(9001, ROUNDS);
      const unlockHashMs = await timeUnlock(9002, ROUNDS);
      // 错误密码也要量：爆破时服务端付的就是这个价（限流器 20 次/10 分钟/IP）
      const wrongStart = process.hrtime.bigint();
      for (let i = 0; i < ROUNDS; i += 1) {
        await articleProvider.getByIdWithPassword(9002, 'wrong-password');
      }
      const unlockWrongMs = Number(process.hrtime.bigint() - wrongStart) / 1e6 / ROUNDS;

      // eslint-disable-next-line no-console
      console.log(
        `[scrypt 实测] 单次 hash=${ms(hashNs / N)}ms  单次 verify(哈希)=${ms(verifyNs / N)}ms  ` +
          `单次 verify(明文，常量时间比较)=${ms(legacyNs / N)}ms  ` +
          `wash ${result.washed} 条=${ms(washNs)}ms（含 DB 往返与事件循环让出）`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[解锁口延迟] 存量明文=${unlockPlainMs.toFixed(1)}ms/次  存量哈希=${unlockHashMs.toFixed(
          1,
        )}ms/次  哈希+错误密码=${unlockWrongMs.toFixed(1)}ms/次  （各 ${ROUNDS} 次均值，含 DB 往返）`,
      );
      expect(result.washed).toBe(300);
      expect(hashNs / N / 1e6).toBeGreaterThan(1);
      // 哈希化之后解锁确实变贵了（这就是"离线爆破成本提高几个数量级"的代价），
      // 但必须仍在人类可接受的范围里（一次解锁 < 1s）
      expect(unlockHashMs).toBeGreaterThan(unlockPlainMs);
      expect(unlockHashMs).toBeLessThan(1000);
    });
  });
});
