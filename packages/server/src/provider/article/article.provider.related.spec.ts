import { ArticleProvider, RELATED_MAX } from './article.provider';
import { wordCount } from 'src/utils/wordCount';

/**
 * P6：相关文章 + readingMinutes + wordCount 存储副本。
 *
 * 钉住的契约（前台另一个 agent 按这个写 UI）：
 *  - relatedArticles: [{_id, id, title, pathname, cover, updatedAt, readingMinutes}]，max 5；
 *  - 排序：共享标签数 → 同分类 → 更新时间倒序；
 *  - **一次查询**（find 只调一次），投影不含 content/password；
 *  - 查询过滤：自身 / 软删 / 隐藏 / 未到点的定时文章全部排除；
 *  - 公开列表（toListView）与公开详情都带 readingMinutes，私密文章不带；
 *  - admin 视图一个字节都不多（不加 readingMinutes/relatedArticles）。
 */

type Doc = Record<string, any>;

function createModel(docs: Doc[]) {
  const captured: Array<{ method: string; query?: any; projection?: any }> = [];
  const applyProjection = (doc: Doc, projection?: any) => {
    if (!projection) return { ...doc };
    const out: Doc = {};
    for (const [k, v] of Object.entries(doc)) {
      if (projection[k] === 1) out[k] = v;
    }
    return out;
  };
  const matchDoc = (doc: Doc, query: any): boolean => {
    // 只为这些用例涉及的查询形状做判定（$and/$or/$in/$ne/$lte/$exists）
    const evalNode = (node: any): boolean => {
      if (!node || typeof node !== 'object') return true;
      if (Array.isArray(node.$and)) return node.$and.every(evalNode);
      if (Array.isArray(node.$or)) return node.$or.some(evalNode);
      for (const [field, cond] of Object.entries(node)) {
        if (field.startsWith('$')) continue;
        const value = doc[field];
        if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
          const c: any = cond;
          if ('$in' in c && !(Array.isArray(value) ? value.some((v) => c.$in.includes(v)) : c.$in.includes(value))) return false;
          if ('$ne' in c && value === c.$ne) return false;
          if ('$lte' in c && !(value instanceof Date && value <= c.$lte)) return false;
          if ('$exists' in c) {
            const exists = value !== undefined;
            if (exists !== (c.$exists === true)) return false;
          }
          if ('$regex' in c) {
            const pattern = c.$regex instanceof RegExp ? c.$regex.source : String(c.$regex);
            const re = new RegExp(pattern, 'i');
            const hay = Array.isArray(value) ? value.map(String).join('\n') : String(value ?? '');
            if (!re.test(hay)) return false;
          }
        } else if (value !== cond) {
          return false;
        }
      }
      return true;
    };
    return evalNode(query);
  };
  const chainFrom = (rows: Doc[], projection?: any) => {
    let out = rows;
    const chain: any = {
      sort: (spec: Doc) => {
        const [key, dir] = Object.entries(spec)[0] as [string, number];
        out = [...out].sort((a, b) => {
          const av = a[key] instanceof Date ? a[key].getTime() : a[key];
          const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
          return av < bv ? -dir : av > bv ? dir : 0;
        });
        return chain;
      },
      skip: (n: number) => { out = out.slice(n); return chain; },
      limit: (n: number) => { out = out.slice(0, n); return chain; },
      maxTimeMS: () => chain,
      exec: async () => out.map((d) => applyProjection(d, projection)),
    };
    return chain;
  };
  const model: any = function FakeModel(dto: any) {
    Object.assign(this, dto);
    (this as any).save = async function () { return this; };
  };
  model.docs = docs;
  model.captured = captured;
  model.find = (query?: any, projection?: any) => {
    captured.push({ method: 'find', query, projection });
    return chainFrom(docs.filter((d) => matchDoc(d, query)), projection);
  };
  model.findOne = (query?: any, projection?: any) => {
    captured.push({ method: 'findOne', query, projection });
    const hit = docs.filter((d) => matchDoc(d, query))[0] || null;
    return { exec: async () => (hit ? applyProjection(hit, projection) : null) };
  };
  model.countDocuments = (query?: any) => {
    captured.push({ method: 'countDocuments', query });
    return { exec: async () => docs.filter((d) => matchDoc(d, query)).length };
  };
  model.updateOne = (query: any, patch: any) => {
    captured.push({ method: 'updateOne', query: { query, patch } });
    const target = docs.find((d) => d.id === query?.id);
    if (target) Object.assign(target, patch);
    return { exec: async () => ({ matchedCount: target ? 1 : 0, modifiedCount: target ? 1 : 0 }) };
  };
  return model;
}

function createProvider(model: any, migration?: any) {
  return new ArticleProvider(
    model,
    {
      find: () => ({ exec: async () => [] }),
      findOne: () => ({ exec: async () => null }),
    } as any,
    { updateTotalWords: () => undefined, getSiteInfo: async () => ({}) } as any,
    {} as any,
    undefined,
    migration,
  );
}

const now = new Date('2026-09-17T12:00:00Z');

function seedArticles(): Doc[] {
  return [
    // 目标文章
    { id: 1, title: '目标', content: 'x', tags: ['go', 'db'], category: 'tech', hidden: false, deleted: false, publishAt: null, updatedAt: new Date('2026-09-01'), pathname: 'target', cover: '', wordCount: 1 },
    // 共享 2 个 tag（最高分）
    { id: 2, title: '双标签', content: 'x', tags: ['go', 'db', 'zzz'], category: 'life', hidden: false, deleted: false, publishAt: null, updatedAt: new Date('2026-08-01'), pathname: 'p2', cover: '/c2.webp', wordCount: 700 },
    // 共享 1 个 tag + 同分类（次高分）
    { id: 3, title: '单标签同类', content: 'x', tags: ['go'], category: 'tech', hidden: false, deleted: false, publishAt: null, updatedAt: new Date('2026-07-01'), pathname: 'p3', cover: '', wordCount: 350 },
    // 只同分类
    { id: 4, title: '同类', content: 'x', tags: ['other'], category: 'tech', hidden: false, deleted: false, publishAt: null, updatedAt: new Date('2026-09-10'), pathname: 'p4', cover: '', wordCount: 100 },
    // 只同分类（更旧 → 排 4 后面）
    { id: 5, title: '同类更旧', content: 'SECRET', tags: ['other'], category: 'tech', hidden: false, deleted: false, publishAt: null, updatedAt: new Date('2026-01-01'), pathname: 'p5', cover: '', wordCount: 50 },
    // 以下都必须被过滤掉：
    { id: 6, title: '软删', content: 'x', tags: ['go'], category: 'tech', hidden: false, deleted: true, publishAt: null, updatedAt: new Date('2026-09-11'), pathname: 'p6', cover: '', wordCount: 1 },
    { id: 7, title: '隐藏', content: 'x', tags: ['go'], category: 'tech', hidden: true, deleted: false, publishAt: null, updatedAt: new Date('2026-09-12'), pathname: 'p7', cover: '', wordCount: 1 },
    { id: 8, title: '定时未到点', content: 'LEAK?', tags: ['go'], category: 'tech', hidden: false, deleted: false, publishAt: new Date('2030-01-01'), updatedAt: new Date('2026-09-13'), pathname: 'p8', cover: '', wordCount: 1 },
    // 第 6 篇合法候选：验证 max 5 截断
    { id: 9, title: '第六候选', content: 'x', tags: ['db'], category: 'life', hidden: false, deleted: false, publishAt: null, updatedAt: new Date('2025-01-01'), pathname: 'p9', cover: '', wordCount: 30 },
  ];
}

describe('getRelatedArticles（P6 契约）', () => {
  it('一次查询、投影不含 content/password、过滤自身/软删/隐藏/未发布', async () => {
    const model = createModel(seedArticles());
    const provider = createProvider(model);
    const target = model.docs[0];
    model.captured.length = 0;
    const related = await provider.getRelatedArticles(target as any, RELATED_MAX, now);
    const finds = model.captured.filter((c: any) => c.method === 'find');
    expect(finds).toHaveLength(1); // ⚠️ 一次查询，不是 N 次（任务硬要求）
    const projection = finds[0].projection;
    expect(projection.content).toBeUndefined();
    expect(projection.password).toBeUndefined();
    expect(projection).toMatchObject({ title: 1, pathname: 1, cover: 1, updatedAt: 1, wordCount: 1 });
    const q = JSON.stringify(finds[0].query);
    expect(q).toContain('"$ne":1'); // 排除自身
    expect(q).toContain('publishAt'); // 定时发布过滤（visiblePublishFilter）
    const ids = related.map((r) => r.id);
    for (const banned of [1, 6, 7, 8]) {
      expect(ids).not.toContain(banned);
    }
  });

  it('排序：共享标签数 → 同分类 → 更新时间倒序；max 5', async () => {
    const model = createModel(seedArticles());
    const provider = createProvider(model);
    const related = await provider.getRelatedArticles(model.docs[0] as any, RELATED_MAX, now);
    expect(related).toHaveLength(5);
    // 2: 共享2tag(200) > 3: 1tag+同类(110) > 4: 同类且更新(10, 2026-09) > 5: 同类更旧(10, 2026-01) > 9: 1tag(100)??
    // 注意 9 共享 1 个 tag（db）→ 100 分，应排在 4/5 前：期望顺序 2,3,9,4,5
    expect(related.map((r) => r.id)).toEqual([2, 3, 9, 4, 5]);
  });

  it('条目字段形状（前台契约）：_id/id/title/pathname/cover/updatedAt/readingMinutes，且无 content', async () => {
    const model = createModel(seedArticles());
    const provider = createProvider(model);
    const related = await provider.getRelatedArticles(model.docs[0] as any, RELATED_MAX, now);
    const first: any = related[0];
    expect(Object.keys(first).sort()).toEqual(
      ['_id', 'cover', 'id', 'pathname', 'readingMinutes', 'title', 'updatedAt'].sort(),
    );
    expect(first._id).toBe('2'); // 数字 id 的字符串形式
    expect(first.cover).toBe('/c2.webp');
    expect(first.readingMinutes).toBe(2); // 700 字 / 350 = 2
    expect((first as any).content).toBeUndefined();
  });

  it('没有 tags 也没有 category 时返回 []（不发查询）', async () => {
    const model = createModel(seedArticles());
    const provider = createProvider(model);
    model.captured.length = 0;
    expect(await provider.getRelatedArticles({ id: 1 } as any)).toEqual([]);
    expect(model.captured.filter((c: any) => c.method === 'find')).toHaveLength(0);
  });
});

describe('readingMinutes 出现在公开 payload 上', () => {
  it('公开列表（toListView + 存储 wordCount）：每项带 readingMinutes；私密项不带', async () => {
    const docs = [
      { id: 1, title: 'a', content: '汉'.repeat(400), tags: [], category: 'c', hidden: false, deleted: false, publishAt: null, private: false, wordCount: 400, updatedAt: now, createdAt: now, top: 0 },
      { id: 2, title: 'b', content: 'SECRET', tags: [], category: 'c', hidden: false, deleted: false, publishAt: null, private: true, password: 'pw', wordCount: 999, updatedAt: now, createdAt: now, top: 0 },
    ];
    const model = createModel(docs);
    const provider = createProvider(model);
    // 与前台真实调用一致：toListView + withExcerpt（§7.42 之后首页就这么调）
    const res = await provider.getByOption(
      { page: 1, pageSize: -1, toListView: true, withExcerpt: true } as any,
      true,
    );
    const items: any[] = res.articles as any[];
    expect(items).toHaveLength(2);
    const pub = items.find((i) => i.id === 1);
    const priv = items.find((i) => i.id === 2);
    expect(pub.readingMinutes).toBe(2); // ceil(400/350)
    expect(pub.content).toBeUndefined(); // toListView 依旧剥正文
    expect(priv.readingMinutes).toBeUndefined(); // 私密文章不给阅读时长
  });

  it('公开详情：article 带 readingMinutes，payload 带 relatedArticles', async () => {
    const model = createModel(seedArticles());
    const provider = createProvider(model);
    const res: any = await provider.getByIdOrPathnameWithPreNext(1, 'public');
    expect(res.article.readingMinutes).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.relatedArticles)).toBe(true);
    expect(res.relatedArticles.length).toBeGreaterThan(0);
    expect(res.relatedArticles.some((r: any) => r.id === 8)).toBe(false);
  });

  it('admin 视图输出不加新字段（响应形状不变）', async () => {
    const model = createModel(seedArticles());
    const provider = createProvider(model);
    const adminList = await provider.getByOption({ page: 1, pageSize: 5 } as any, false);
    for (const item of adminList.articles as any[]) {
      expect(item.readingMinutes).toBeUndefined();
    }
  });
});

describe('wordCount 存储副本的维护（P6 的数据基础）', () => {
  it('create：写入 wordCount = utils/wordCount(content)', async () => {
    const model = createModel([]);
    model.findOne = () => ({ exec: async () => null }); // isPathnameTaken
    const provider = createProvider(model);
    const content = '汉字'.repeat(100) + ' hello world';
    const created: any = await provider.create({ title: 't', category: 'c', content } as any, true, 42);
    expect(created.wordCount).toBe(wordCount(content));
  });

  it('updateById：content 变化时同步重算；不含 content 的 patch 不动它', async () => {
    const model = createModel([{ id: 1, title: 't', content: 'old', wordCount: 3 }]);
    const provider = createProvider(model);
    await provider.updateById(1, { content: '汉字'.repeat(350) } as any, true);
    // '汉字'.repeat(350) = 700 个 CJK 字符 → wordCount 口径每字算 1 → 700
    expect(model.docs[0].wordCount).toBe(700);
    await provider.updateById(1, { title: 'new title' } as any, true);
    expect(model.docs[0].wordCount).toBe(700); // 没碰 content 就不重算
  });

  it('backfillWordCounts：只补"没有 wordCount 字段"的文档，不碰 updatedAt，含软删；台账记 backfill:articleWordCount', async () => {
    const old = new Date('2020-01-01');
    const model = createModel([
      { id: 1, title: 'a', content: '汉字'.repeat(10), updatedAt: old, deleted: false }, // 无 wordCount → 补
      { id: 2, title: 'b', content: 'x', wordCount: 999, updatedAt: old, deleted: false }, // 有 → 不动
      { id: 3, title: 'c', content: 'abc def', updatedAt: old, deleted: true }, // 软删也补（回收站要显示）
    ]);
    const entries: any[] = [];
    const migration = {
      record: async (e: any) => entries.push(e),
      recordSkipped: async () => undefined,
      run: async (spec: any, task: any, opts: any) => {
        const r = await task();
        entries.push({ ...spec, outcome: 'ok', detail: opts?.detail ? opts.detail(r) : undefined });
        return r;
      },
      list: async () => [],
      warnAboutErrors: async () => [],
    };
    const provider = createProvider(model, migration);
    const result = await provider.backfillWordCounts();
    expect(result).toEqual({ scanned: 2, updated: 2 });
    expect(model.docs[0].wordCount).toBe(20);
    expect(model.docs[0].updatedAt).toBe(old); // ⚠️ 回填不是编辑，不许顶"最近更新"
    expect(model.docs[1].wordCount).toBe(999); // 已有值不覆盖
    expect(model.docs[2].wordCount).toBe(2);
    expect(entries.some((e) => e.key === 'backfill:articleWordCount' && e.kind === 'backfill')).toBe(true);
  });
});
