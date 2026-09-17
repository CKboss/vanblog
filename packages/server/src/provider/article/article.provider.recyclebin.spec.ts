import { ArticleProvider } from './article.provider';
import { DraftProvider } from '../draft/draft.provider';

/**
 * P3 回收站（provider 层）：
 *  - deleteById 打上 deleted+deletedAt（软删，绝不 deleteOne）；
 *  - getDeleted 只列软删文档，投影**不含 content/password**（这是任务里的硬要求），分页+total；
 *  - restoreById 只恢复软删文档、清 deletedAt、触发字数重算；
 *  - purgeById **只**硬删软删文档（filter 带 deleted:true —— 未进回收站的文章 purge 不动它）。
 * 负控：把 deleteOne 的 filter 里 deleted:true 拿掉，"purge 不碰未删文章"这条立刻红。
 */

type Doc = Record<string, any>;

function createMemoryArticleModel(initial: Doc[] = []) {
  const docs = initial.map((d) => ({ ...d }));
  const match = (query: any) => {
    const q = query || {};
    return docs.filter((d) =>
      Object.entries(q).every(([k, v]) => {
        if (k === '$and' || k === '$or') return true; // 本 spec 的查询里没有
        return d[k] === v;
      }),
    );
  };
  const model: any = {
    docs,
    findOne: jest.fn((query: any, projection?: any) => ({
      exec: async () => {
        const hit = match(query)[0] || null;
        if (!hit || !projection) return hit ? { ...hit } : null;
        const out: Doc = {};
        for (const [k, v] of Object.entries(hit)) {
          if ((projection as any)[k] === 1) out[k] = v;
        }
        return out;
      },
    })),
    find: jest.fn((query: any, projection?: any) => {
      let rows = match(query);
      const chain: any = {
        sort: (spec: Doc) => {
          const keys = Object.entries(spec);
          rows = [...rows].sort((a, b) => {
            for (const [key, dir] of keys) {
              const norm = (v: any) => (v === null || v === undefined ? 0 : key === 'deletedAt' || key === 'updatedAt' ? new Date(v).getTime() : v);
              const av = norm(a[key]);
              const bv = norm(b[key]);
              if (av < bv) return -(dir as number);
              if (av > bv) return dir as number;
            }
            return 0;
          });
          return chain;
        },
        skip: (n: number) => {
          rows = rows.slice(n);
          return chain;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return chain;
        },
        exec: async () =>
          rows.map((d) => {
            if (!projection) return { ...d };
            const out: Doc = {};
            for (const [k, v] of Object.entries(d)) {
              if ((projection as any)[k] === 1) out[k] = v;
            }
            return out;
          }),
      };
      return chain;
    }),
    countDocuments: jest.fn((query: any) => ({
      exec: async () => match(query).length,
    })),
    updateOne: jest.fn((query: any, patch: any) => ({
      exec: async () => {
        const target = match(query)[0];
        if (!target) return { matchedCount: 0, modifiedCount: 0 };
        Object.assign(target, patch);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    })),
    deleteOne: jest.fn((query: any) => ({
      exec: async () => {
        const target = match(query)[0];
        if (!target) return { deletedCount: 0 };
        docs.splice(docs.indexOf(target), 1);
        return { deletedCount: 1 };
      },
    })),
  };
  return model;
}

function createProvider(model: any, extras: { revisions?: any } = {}) {
  const meta = { updateTotalWords: jest.fn() };
  const provider = new ArticleProvider(
    model,
    {} as any,
    meta as any,
    {} as any,
    extras.revisions,
  );
  return { provider, meta };
}

const seed = () => [
  { id: 1, title: '活文章', content: 'live', pathname: 'live', deleted: false, deletedAt: null, wordCount: 4, updatedAt: new Date(1700000001000) },
  { id: 2, title: '已删文章', content: 'SECRET-BODY', pathname: 'dead', deleted: true, deletedAt: new Date(1700000003000), wordCount: 11, updatedAt: new Date(1700000002000), password: 'pw' },
  { id: 3, title: '另一篇已删', content: 'x', pathname: 'dead2', deleted: true, deletedAt: new Date(1700000002000), wordCount: 1, updatedAt: new Date(1700000001000) },
];

describe('ArticleProvider 回收站', () => {
  it('deleteById 是软删：deleted+deletedAt，文档还在（绝不 deleteOne）', async () => {
    const model = createMemoryArticleModel(seed());
    const { provider, meta } = createProvider(model);
    await provider.deleteById(1);
    expect(model.deleteOne).not.toHaveBeenCalled();
    const doc = model.docs.find((d: Doc) => d.id === 1);
    expect(doc.deleted).toBe(true);
    expect(doc.deletedAt).toBeInstanceOf(Date);
    expect(doc.content).toBe('live'); // 正文原样保留 —— 可恢复的底气
    expect(meta.updateTotalWords).toHaveBeenCalledWith('删除文章');
  });

  it('getDeleted：只列软删、最近删除在前、投影不含 content/password、total 正确', async () => {
    const model = createMemoryArticleModel(seed());
    const { provider } = createProvider(model);
    const res = await provider.getDeleted(1, 10);
    expect(res.total).toBe(2);
    expect(res.articles.map((a: any) => a.id)).toEqual([2, 3]); // deletedAt 倒序
    for (const a of res.articles as any[]) {
      expect(a.content).toBeUndefined(); // ⚠️ 硬要求：列表不下发正文
      expect(a.password).toBeUndefined();
      expect(a.title).toBeTruthy();
      expect(typeof a.wordCount).toBe('number');
    }
    // 投影对象本身钉死（负控：往 deletedListView 里加 content:1 这条就红）
    const projection = model.find.mock.calls[0][1];
    expect(projection.content).toBeUndefined();
    expect(projection.password).toBeUndefined();
    expect(projection).toMatchObject({ id: 1, title: 1, pathname: 1, deletedAt: 1, wordCount: 1 });
  });

  it('getDeleted 分页：skip/limit 生效', async () => {
    const model = createMemoryArticleModel(seed());
    const { provider } = createProvider(model);
    const page2 = await provider.getDeleted(2, 1);
    expect(page2.total).toBe(2);
    expect(page2.articles).toHaveLength(1);
    expect((page2.articles[0] as any).id).toBe(3);
  });

  it('restoreById：恢复软删文章、清 deletedAt、触发字数重算；活文章返回 null', async () => {
    const model = createMemoryArticleModel(seed());
    const { provider, meta } = createProvider(model);
    const restored: any = await provider.restoreById(2);
    expect(restored).not.toBeNull();
    expect(restored.id).toBe(2);
    const doc = model.docs.find((d: Doc) => d.id === 2);
    expect(doc.deleted).toBe(false);
    expect(doc.deletedAt).toBeNull();
    expect(doc.content).toBe('SECRET-BODY');
    expect(meta.updateTotalWords).toHaveBeenCalledWith('恢复文章');
    // 没被删的文章 restore → null（controller 转 404），一个字都不改
    meta.updateTotalWords.mockClear();
    expect(await provider.restoreById(1)).toBeNull();
    expect(meta.updateTotalWords).not.toHaveBeenCalled();
    expect(model.docs.find((d: Doc) => d.id === 1).deleted).toBe(false);
  });

  it('purgeById：只硬删**已在回收站**的文章；活文章分毫不动（负控钉子）', async () => {
    const model = createMemoryArticleModel(seed());
    const revisions = { deleteForArticle: jest.fn(async () => 2) };
    const { provider, meta } = createProvider(model, { revisions });
    // 活文章：filter {id,deleted:true} 不命中 → purged:false，文档还在
    const alive = await provider.purgeById(1);
    expect(alive.purged).toBe(false);
    expect(model.docs.find((d: Doc) => d.id === 1)).toBeDefined();
    expect(revisions.deleteForArticle).not.toHaveBeenCalled();
    // 软删文章：真的没了 + 字数重算 + 历史版本连带清理
    const dead = await provider.purgeById(2);
    expect(dead.purged).toBe(true);
    expect(model.docs.find((d: Doc) => d.id === 2)).toBeUndefined();
    expect(meta.updateTotalWords).toHaveBeenCalledWith('彻底删除文章');
    expect(revisions.deleteForArticle).toHaveBeenCalledWith(2);
  });

  it('findDeletedById：只返回软删文档', async () => {
    const model = createMemoryArticleModel(seed());
    const { provider } = createProvider(model);
    expect((await provider.findDeletedById(2))?.id).toBe(2);
    expect(await provider.findDeletedById(1)).toBeNull();
  });
});

describe('DraftProvider 回收站（草稿与文章同形状，任务要求一并覆盖）', () => {
  function createMemoryDraftModel(initial: Doc[] = []) {
    const model = createMemoryArticleModel(initial);
    return model;
  }
  const draftSeed = () => [
    { id: 1, title: '活草稿', content: 'live', deleted: false, deletedAt: null },
    { id: 2, title: '已删草稿', content: 'BODY', deleted: true, deletedAt: new Date(1700000002000) },
  ];

  it('deleteById 打 deletedAt；getDeleted 不含 content；restore/purge 与文章同语义', async () => {
    const model = createMemoryDraftModel(draftSeed());
    const provider = new DraftProvider(model, {} as any);
    await provider.deleteById(1);
    expect(model.docs.find((d: Doc) => d.id === 1).deletedAt).toBeInstanceOf(Date);

    const list = await provider.getDeleted(1, 10);
    expect(list.total).toBe(2);
    for (const d of list.drafts as any[]) {
      expect(d.content).toBeUndefined();
    }
    const projection = model.find.mock.calls[0][1];
    expect(projection.content).toBeUndefined();

    const restored: any = await provider.restoreById(1);
    expect(restored).not.toBeNull();
    expect(model.docs.find((d: Doc) => d.id === 1).deleted).toBe(false);

    expect((await provider.purgeById(1)).purged).toBe(false); // 已恢复 → purge 不动
    expect((await provider.purgeById(2)).purged).toBe(true);
    expect(model.docs.find((d: Doc) => d.id === 2)).toBeUndefined();
  });
});
