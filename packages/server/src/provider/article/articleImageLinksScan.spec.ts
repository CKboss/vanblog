/**
 * 「扫描全站文章图片链接」的**资源边界**钉子。
 *
 * ## 修的是什么
 *
 * `getAllImageLinks()` 以前是一次 `find()` 把**全部未删除文章连正文**拉进堆，再逐篇跑图片链接
 * 正则。正文是库里最大的字段，所以成本随站点规模线性增长且**全部驻留内存**：
 * 5000 篇 × 300 KB ≈ **1.5 GB** ⇒ worker 被 OOMKilled。
 *
 * ⚠️ 可达性（决定严重度，已核实）：唯一调用方是 `static.provider.scanLinksOfArticles()`，
 * 由 `POST /api/admin/img/scan` 触发（处理器是 `controller/admin/img/img.controller.ts` 的
 * `scanImgsOfArticles()`；⚠️ 这里刻意用**文件 + 符号名**而不是行号指路 —— 行号必然漂移，
 * 而漂移后的行号看起来仍然像个引用、不会有任何守卫报红，本文件原先写的行号就已经漂了）。
 * 这条路由**不在 `types/access/access.ts` 的任何一张放行表里**：引导层 `bootstrapRoutes`、
 * 免权限档 `publicRoutes`、按权限档 `pathPermissionMap`（`permissionRoutes` 是它的键集）
 * 三张都逐条核实过不含它（🔴 本文件下面有一条断言把这个结论钉住），
 * 而 `/api/admin/img` **不在** `SUPER_ADMIN_ONLY_ROUTE_PREFIXES`
 * 里 ⇒ 走到 `access.guard.ts` 的 `permissions.includes('all')` 分支就放行，
 * **勾了「所有权限」的协作者可以调**。在"低权限账号按已被攻陷设计"的威胁模型下，这是
 * "一个廉价请求打死整个 worker、且可反复触发（重启后再来一次）"的放大链。
 * 🔴 **可达性论证必须穷尽所有放行表**：B′ 把免权限表拆成两层之后，`bootstrapRoutes` 也是放行表，
 * 少说一张的论证即使结论碰巧对也不成立。
 *
 * ## 现在的契约（逐条钉住）
 *  1. **分批**：按 `_id` keyset 分页，每批 50 篇 ⇒ 峰值内存只与批大小有关，与全站规模无关；
 *  2. **投影**：只取 `_id/id/title/content`，不再把整份文档（含 revisions 等大字段）拉回来；
 *  3. **诚实的上限**：撞上限时 `truncated: true` + WARN，**绝不**静默返回不完整结果；
 *  4. **对外形状不变**：`getAllImageLinks()` 仍然返回 `ArticleImageLinks[]`。
 *
 * ## 负控（已实测，见交付报告）
 * 把实现换回"一次 find 全量"⇒ 用例 1、2 变红；把 `truncated` 写死 false ⇒ 用例 5、6 变红；
 * 把投影去掉 ⇒ 用例 3 变红。
 */
import { ArticleProvider } from './article.provider';
import {
  SUPER_ADMIN_ONLY_ROUTE_PREFIXES,
  bootstrapRoutes,
  isSuperAdminOnlyRoute,
  pathPermissionMap,
  permissionRoutes,
  publicRoutes,
} from 'src/types/access/access';

/** 每批多少篇 —— 与实现里的 `IMG_LINK_SCAN_BATCH_SIZE` 对齐（改实现就要改这里，刻意的） */
const BATCH = 50;

interface FakeDoc {
  _id: number;
  id: number;
  title: string;
  content: string;
  /** 用来验证投影：这个字段**不该**被取走 */
  revisions?: string[];
  deleted?: boolean;
}

/**
 * 最小可用的假 model：支持 `find(filter, projection).sort({_id:1}).limit(n).exec()`，
 * 并且**真的**按 filter 过滤（`$or` 的 deleted 语义 + keyset 的 `_id > last`），
 * 这样"分批不漏不重"才是被证明的，而不是被假实现的宽松匹配放过的。
 */
function createFakeArticleModel(docs: FakeDoc[]) {
  const calls: Array<{ filter: any; projection: any; limit?: number }> = [];

  const matches = (doc: FakeDoc, filter: any): boolean => {
    if (!filter || typeof filter !== 'object') return true;
    // $and: 每个子句都要成立
    if (Array.isArray(filter.$and)) {
      if (!filter.$and.every((c: any) => matches(doc, c))) return false;
    }
    // $or: 至少一个成立（本例是 deleted:false 或 deleted 不存在）
    if (Array.isArray(filter.$or)) {
      const ok = filter.$or.some((c: any) => matches(doc, c));
      if (!ok) return false;
    }
    for (const [key, cond] of Object.entries(filter)) {
      if (key === '$and' || key === '$or') continue;
      const value = (doc as any)[key];
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        const ops = cond as any;
        if ('$exists' in ops && Boolean(ops.$exists) !== (value !== undefined)) return false;
        if ('$gt' in ops && !(value > ops.$gt)) return false;
        if ('$ne' in ops && value === ops.$ne) return false;
        continue;
      }
      if (value !== cond) return false;
    }
    return true;
  };

  const project = (doc: FakeDoc, projection: any) => {
    if (!projection || typeof projection !== 'object') return { ...doc };
    const keys = Object.keys(projection).filter((k) => projection[k]);
    const out: any = {};
    for (const k of keys) {
      if ((doc as any)[k] !== undefined) out[k] = (doc as any)[k];
    }
    return out;
  };

  const model = {
    find: jest.fn((filter?: any, projection?: any) => {
      const state = { limit: Number.POSITIVE_INFINITY, sortAsc: true };
      const chain: any = {
        sort: (spec: any) => {
          // 只认 {_id:1}；别的排序不模拟（实现里也只用这一种）
          state.sortAsc = spec?._id !== -1;
          return chain;
        },
        limit: (n: number) => {
          state.limit = n;
          calls.push({ filter, projection, limit: n });
          return chain;
        },
        exec: async () => {
          // 没调 limit() 就 exec() 的形状（旧实现就是这样）也要记下来
          if (!calls.length || calls[calls.length - 1].filter !== filter) {
            calls.push({ filter, projection });
          }
          const matched = docs
            .filter((d) => matches(d, filter))
            .sort((a, b) => (state.sortAsc ? a._id - b._id : b._id - a._id))
            .slice(0, state.limit)
            .map((d) => project(d, projection));
          return matched;
        },
      };
      return chain;
    }),
  };
  return { model, calls };
}

function makeDocs(n: number, opts?: { deletedEvery?: number; linksPerArticle?: number }): FakeDoc[] {
  const deletedEvery = opts?.deletedEvery ?? 0;
  const links = opts?.linksPerArticle ?? 2;
  return Array.from({ length: n }, (_, i) => {
    const idx = i + 1;
    const body = Array.from(
      { length: links },
      (_, j) => `![img${j}](https://cdn.example.com/a/${idx}-${j}.png)`,
    ).join('\n');
    const doc: FakeDoc = {
      _id: idx,
      id: idx,
      title: `文章 ${idx}`,
      content: `# t${idx}\n${body}`,
      revisions: ['不该被取走的大字段'],
    };
    if (deletedEvery && idx % deletedEvery === 0) doc.deleted = true;
    return doc;
  });
}

function buildProvider(model: any) {
  // 只需要 articleModel 与 logger，其余依赖本路径用不到
  const provider = Object.create(ArticleProvider.prototype);
  (provider as any).articleModel = model;
  const logs: string[] = [];
  const warns: string[] = [];
  (provider as any).logger = {
    log: (m: string) => logs.push(String(m)),
    warn: (m: string) => warns.push(String(m)),
    error: (m: string) => warns.push(String(m)),
  };
  return { provider, logs, warns };
}

describe('getAllImageLinks / scanAllImageLinks：分批、投影与诚实的上限', () => {
  it('120 篇 ⇒ **多次** find（分批），而不是一次全量', async () => {
    const { model, calls } = createFakeArticleModel(makeDocs(120));
    const { provider } = buildProvider(model);

    const items = await provider.getAllImageLinks();

    // 120 篇 / 每批 50 ⇒ 3 批（50 + 50 + 20）
    expect(items).toHaveLength(120);
    expect(model.find).toHaveBeenCalledTimes(3);
    expect(calls.map((c) => c.limit)).toEqual([BATCH, BATCH, BATCH]);
    // 不漏不重：articleId 恰好是 1..120 且升序
    expect(items.map((i: any) => i.articleId)).toEqual(
      Array.from({ length: 120 }, (_, i) => i + 1),
    );
  });

  it('keyset 分页：第二批的 filter 必须带 `_id > 上一批最后一个`（不是 skip）', async () => {
    const { model, calls } = createFakeArticleModel(makeDocs(120));
    const { provider } = buildProvider(model);

    await provider.scanAllImageLinks();

    // 第一批没有游标条件；第二、三批必须有 $and + _id.$gt
    expect(JSON.stringify(calls[0].filter)).not.toContain('$gt');
    for (const c of calls.slice(1)) {
      expect(Array.isArray(c.filter.$and)).toBe(true);
      const cursor = c.filter.$and.find((x: any) => x._id?.$gt !== undefined);
      expect(cursor).toBeDefined();
    }
    // 游标值必须递进（50 → 100），证明用的是 keyset 而不是固定偏移
    const gt = calls
      .slice(1)
      .map((c) => c.filter.$and.find((x: any) => x._id?.$gt !== undefined)._id.$gt);
    expect(gt).toEqual([50, 100]);
    // ⚠️ 绝不能用 skip 深分页（O(skip) ⇒ 扫全站变 O(n²)）
    expect(model.find.mock.calls.some((c: any[]) => typeof (c as any)?.skip === 'function')).toBe(
      false,
    );
  });

  it('投影只取必要字段：不取 revisions 这类大字段，但必须有 content（链接在正文里）', async () => {
    const docs = makeDocs(3);
    const { model, calls } = createFakeArticleModel(docs);
    const { provider } = buildProvider(model);

    const items = await provider.getAllImageLinks();

    expect(Object.keys(calls[0].projection).sort()).toEqual(['_id', 'content', 'id', 'title']);
    expect(calls[0].projection.content).toBe(1);
    // 链接确实是从正文解析出来的（投影没把 content 投丢）
    expect(items[0].links).toHaveLength(2);
    expect(items[0].links[0]).toContain('https://cdn.example.com/a/1-0.png');
  });

  it('软删的文章不计入（查询语义没被改动）', async () => {
    // 每 10 篇标记一篇 deleted ⇒ 120 篇里有 12 篇被排除
    const { model } = createFakeArticleModel(makeDocs(120, { deletedEvery: 10 }));
    const { provider } = buildProvider(model);

    const scan = await provider.scanAllImageLinks();

    expect(scan.scannedArticles).toBe(108);
    expect(scan.items.map((i) => i.articleId)).not.toContain(10);
    // filter 里必须仍然带着 deleted 的 $or 语义
    const firstFilter = model.find.mock.calls[0][0];
    expect(JSON.stringify(firstFilter)).toContain('$or');
    expect(JSON.stringify(firstFilter)).toContain('$exists');
  });

  it('撞上单轮上限 ⇒ truncated=true、items 只有上限那么多、并且打 WARN', async () => {
    // 上限在模块加载时读取，所以要 resetModules + 动态 import 才能改它
    jest.resetModules();
    process.env.VANBLOG_IMG_SCAN_MAX_ARTICLES = '60';
    let mod: typeof import('./article.provider');
    try {
      mod = await import('./article.provider');
    } finally {
      delete process.env.VANBLOG_IMG_SCAN_MAX_ARTICLES;
    }
    const { model } = createFakeArticleModel(makeDocs(120));
    const provider = Object.create(mod.ArticleProvider.prototype);
    (provider as any).articleModel = model;
    const warns: string[] = [];
    (provider as any).logger = { log: () => {}, warn: (m: string) => warns.push(String(m)), error: () => {} };

    const scan = await provider.scanAllImageLinks();

    expect(scan.truncated).toBe(true);
    expect(scan.scannedArticles).toBe(60);
    expect(scan.items).toHaveLength(60);
    expect(scan.articleCap).toBe(60);
    // WARN 必须说清"结果不完整"，否则调用方会以为扫全了
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('未覆盖全站');
    expect(warns[0]).toContain('不完整');
    expect(warns[0]).toContain('VANBLOG_IMG_SCAN_MAX_ARTICLES');
  });

  it('恰好扫完（篇数 == 上限、后面没有了）⇒ truncated 必须是 false，不许假报截断', async () => {
    jest.resetModules();
    process.env.VANBLOG_IMG_SCAN_MAX_ARTICLES = '100';
    let mod: typeof import('./article.provider');
    try {
      mod = await import('./article.provider');
    } finally {
      delete process.env.VANBLOG_IMG_SCAN_MAX_ARTICLES;
    }
    const { model } = createFakeArticleModel(makeDocs(100));
    const provider = Object.create(mod.ArticleProvider.prototype);
    (provider as any).articleModel = model;
    const warns: string[] = [];
    (provider as any).logger = { log: () => {}, warn: (m: string) => warns.push(String(m)), error: () => {} };

    const scan = await provider.scanAllImageLinks();

    expect(scan.scannedArticles).toBe(100);
    expect(scan.truncated).toBe(false);
    expect(warns).toHaveLength(0);
  });

  it('对外形状不变：getAllImageLinks 仍返回数组，元素是 {articleId,title,links}', async () => {
    const { model } = createFakeArticleModel(makeDocs(2));
    const { provider } = buildProvider(model);

    const res = await provider.getAllImageLinks();

    expect(Array.isArray(res)).toBe(true);
    expect(Object.keys(res[0]).sort()).toEqual(['articleId', 'links', 'title']);
    expect(typeof res[0].title).toBe('string');
    expect(Array.isArray(res[0].links)).toBe(true);
  });

  it('空库 / 只有软删文章 ⇒ 返回空数组，不抛异常', async () => {
    const { model: m1 } = createFakeArticleModel([]);
    const { provider: p1 } = buildProvider(m1);
    expect(await p1.getAllImageLinks()).toEqual([]);

    const { model: m2 } = createFakeArticleModel(makeDocs(5, { deletedEvery: 1 }));
    const { provider: p2 } = buildProvider(m2);
    expect(await p2.getAllImageLinks()).toEqual([]);
  });

  it('空转反证：上面"多次 find"那把尺子量在**旧实现**（一次全量 find）上必须判红', async () => {
    // 旧实现的形状：find(filter) 后直接 await（没有 sort/limit），一次拿全部
    const docs = makeDocs(120);
    const { model, calls } = createFakeArticleModel(docs);
    const oldImpl = async () => {
      const all: any[] = await (model.find({
        $or: [{ deleted: false }, { deleted: { $exists: false } }],
      }) as any).exec();
      return all.map((a) => ({ articleId: a.id, title: a.title, links: ['x'] }));
    };

    const items = await oldImpl();

    expect(items).toHaveLength(120);
    // ⚠️ 这就是判据：旧实现只调 1 次 find，所以"必须 3 次"的断言对它一定红
    expect(model.find).toHaveBeenCalledTimes(1);
    expect(calls[0].limit).toBeUndefined();
    expect(model.find).not.toHaveBeenCalledTimes(3);
  });
});

/**
 * 🔴 **把「可达性论证」的结论钉住，而不是钉注释措辞。**
 *
 * 上面文件头那段论证说的是：`post-/api/admin/img/scan` 不在任何一张放行表里，
 * 而 `/api/admin/img` 不在超管专属前缀里 ⇒ **勾了「所有权限」的协作者可以调**，
 * 所以这条重活必须按「低权限账号也能触发」设防。
 *
 * ⚠️ 为什么钉结论而不是钉措辞：注释是散文，改措辞不会红；而**结论一旦变化，
 * 上面那一整组「按可达性设防」的断言就失去了前提**（例如哪天这条路由被收进超管专属前缀，
 * 分批与投影就只是纵深防御、不再是必需）。钉住结论之后，改动放行表的人会立刻看到这条红，
 * 从而被强制回来重新评估严重度 —— 这正是「守卫应当钉性质、不钉字面」的取向。
 *
 * 🔴 **并且必须穷尽所有放行表**：B′ 把免权限表拆成两层之后，`bootstrapRoutes` 也是放行表，
 * 少查一张的论证即使结论碰巧正确也不成立。
 */
describe('可达性前提：post-/api/admin/img/scan 不在任何一张放行表里', () => {
  const KEY = 'post-/api/admin/img/scan';

  it('三张放行表逐个核实都不含它（引导层 / 免权限档 / 按权限档）', () => {
    expect(bootstrapRoutes).not.toContain(KEY);
    expect(publicRoutes).not.toContain(KEY);
    expect(Object.keys(pathPermissionMap)).not.toContain(KEY);
    // `permissionRoutes` 就是 `pathPermissionMap` 的键集，这里一并钉住，防止将来两者脱钩
    expect(permissionRoutes).not.toContain(KEY);
  });

  it('🔴 反空转：三张表都非空，且查表方式对**在表里的**键确实返回真（否则上面的 not.toContain 恒真）', () => {
    expect(bootstrapRoutes.length).toBeGreaterThan(0);
    expect(publicRoutes.length).toBeGreaterThan(0);
    expect(Object.keys(pathPermissionMap).length).toBeGreaterThan(0);
    // 尺子有效性：各取一个真实成员，用同一套查表方式必须命中
    expect(bootstrapRoutes).toContain(bootstrapRoutes[0]);
    expect(publicRoutes).toContain(publicRoutes[0]);
    const somePermKey = Object.keys(pathPermissionMap)[0];
    expect(permissionRoutes).toContain(somePermKey);
    expect(KEY).not.toBe(somePermKey);
  });

  it('另一半前提：/api/admin/img 不在超管专属前缀里（所以「所有权限」协作者能走到放行分支）', () => {
    expect(isSuperAdminOnlyRoute('/api/admin/img')).toBe(false);
    expect(isSuperAdminOnlyRoute('/api/admin/img/scan')).toBe(false);
    // 尺子有效性：同一把尺子对真在高危前缀下的路径必须返回真，否则上面的 false 没有意义
    expect(SUPER_ADMIN_ONLY_ROUTE_PREFIXES.length).toBeGreaterThan(0);
    expect(isSuperAdminOnlyRoute(`${SUPER_ADMIN_ONLY_ROUTE_PREFIXES[0]}/anything`)).toBe(true);
  });
});
