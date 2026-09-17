import { RevisionProvider, resolveRevisionsKeep, DEFAULT_REVISIONS_KEEP } from './revision.provider';
import { ArticleProvider } from '../article/article.provider';

/**
 * P4 文章历史版本（极简）：
 *  - 只在 title/content **真的变了**时写快照（负控：不比较的实现会让"没变也写"的用例红）；
 *  - `VANBLOG_ARTICLE_REVISIONS_KEEP`：默认 10、0=关闭=老行为、非法回落；
 *  - 超限淘汰最旧；
 *  - 快照写失败绝不影响文章保存（appendSafe 吞错）；
 *  - ArticleProvider.updateById 的接线：改内容→写 pre-update 快照；skipRevision→不写。
 */

type Doc = Record<string, any>;

function oid(n: number) {
  return `oid${String(n).padStart(4, '0')}`;
}

/** 内存假 revisions 模型：实现 provider 用到的最小面。 */
function createFakeRevisionModel(initial: Doc[] = []) {
  const docs: Doc[] = initial.map((d, i) => ({ _id: d._id || oid(i + 1), ...d }));
  let seq = docs.length;
  const model: any = {
    docs,
    create: jest.fn(async (doc: Doc) => {
      const saved = { _id: oid(++seq), ...doc };
      docs.push(saved);
      return saved;
    }),
    find: jest.fn((filter: Doc = {}, projection?: Doc) => {
      const matched = docs.filter((d) =>
        Object.entries(filter).every(([k, v]) => d[k] === v),
      );
      let rows = [...matched];
      const chain: any = {
        sort: (spec: Doc) => {
          // 多键排序（与 Mongo 语义一致）：{savedAt:-1,_id:-1} 在同毫秒时靠 _id 决胜
          const keys = Object.entries(spec);
          rows.sort((a, b) => {
            for (const [key, dir] of keys) {
              const av = key === 'savedAt' ? new Date(a[key]).getTime() : a[key];
              const bv = key === 'savedAt' ? new Date(b[key]).getTime() : b[key];
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
          rows.map((d) =>
            projection?.content === 0
              ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'content'))
              : { ...d },
          ),
      };
      return chain;
    }),
    findOne: jest.fn((filter: Doc = {}) => ({
      exec: async () => {
        const hit = docs.find((d) =>
          Object.entries(filter).every(([k, v]) => String(d[k]) === String(v)),
        );
        return hit ? { ...hit, toObject: () => ({ ...hit }) } : null;
      },
    })),
    countDocuments: jest.fn((filter: Doc = {}) => ({
      exec: async () =>
        docs.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v)).length,
    })),
    deleteMany: jest.fn((filter: Doc = {}) => ({
      exec: async () => {
        if (filter._id?.$in) {
          const ids = filter._id.$in.map(String);
          const before = docs.length;
          for (let i = docs.length - 1; i >= 0; i--) {
            if (ids.includes(String(docs[i]._id))) docs.splice(i, 1);
          }
          return { deletedCount: before - docs.length };
        }
        const match = (d: Doc) =>
          Object.entries(filter).every(([k, v]) => d[k] === v);
        const before = docs.length;
        for (let i = docs.length - 1; i >= 0; i--) {
          if (match(docs[i])) docs.splice(i, 1);
        }
        return { deletedCount: before - docs.length };
      },
    })),
  };
  return model;
}

describe('resolveRevisionsKeep（env 解析）', () => {
  it('缺失/空串回落默认 10；0 合法=关闭；非法回落；负数按 0', () => {
    expect(resolveRevisionsKeep(undefined)).toBe(DEFAULT_REVISIONS_KEEP);
    expect(resolveRevisionsKeep('')).toBe(10);
    expect(resolveRevisionsKeep('0')).toBe(0);
    expect(resolveRevisionsKeep('5')).toBe(5);
    expect(resolveRevisionsKeep('abc')).toBe(10);
    expect(resolveRevisionsKeep('-2')).toBe(0);
    expect(resolveRevisionsKeep('3.7')).toBe(3);
    expect(DEFAULT_REVISIONS_KEEP).toBe(10);
  });
});

describe('RevisionProvider', () => {
  const OLD_ENV = process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    else process.env.VANBLOG_ARTICLE_REVISIONS_KEEP = OLD_ENV;
  });

  it('KEEP=0（关闭）时 append/appendIfChanged 一律 null，一行都不写（= 老行为）', async () => {
    process.env.VANBLOG_ARTICLE_REVISIONS_KEEP = '0';
    const model = createFakeRevisionModel();
    const provider = new RevisionProvider(model);
    expect(provider.enabled()).toBe(false);
    expect(await provider.appendIfChanged(1, { title: 'a', content: 'x' }, { content: 'y' })).toBeNull();
    expect(model.create).not.toHaveBeenCalled();
  });

  it('title/content 都没变：不写快照（compare, don\'t write unconditionally）', async () => {
    delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    const model = createFakeRevisionModel();
    const provider = new RevisionProvider(model);
    const res = await provider.appendIfChanged(
      7,
      { title: '同题', content: '同文' },
      { title: '同题', content: '同文' },
    );
    expect(res).toBeNull();
    expect(model.create).not.toHaveBeenCalled();
    // 只改 tags（patch 不含 title/content）也不写
    expect(await provider.appendIfChanged(7, { title: '同题', content: '同文' }, {})).toBeNull();
    expect(model.create).not.toHaveBeenCalled();
  });

  it('content 变了：写旧状态快照，wordCount/sizeBytes 落库', async () => {
    delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    const model = createFakeRevisionModel();
    const provider = new RevisionProvider(model);
    const res = await provider.appendIfChanged(
      7,
      { title: '旧题', content: '汉字abc' },
      { content: '新内容' },
    );
    expect(res).not.toBeNull();
    expect(model.create).toHaveBeenCalledTimes(1);
    const created = model.create.mock.calls[0][0];
    expect(created.articleId).toBe(7);
    expect(created.title).toBe('旧题');
    expect(created.content).toBe('汉字abc'); // 快照是"被替换掉的旧状态"
    expect(created.reason).toBe('update');
    expect(created.wordCount).toBe(3); // 汉字2字 + abc 1 词
    expect(created.sizeBytes).toBe(Buffer.byteLength('汉字abc', 'utf8'));
    expect(created.savedAt).toBeInstanceOf(Date);
  });

  it('超过 KEEP 淘汰最旧：11 次写入后只剩 10 条且保留的是最新的', async () => {
    process.env.VANBLOG_ARTICLE_REVISIONS_KEEP = '10';
    const model = createFakeRevisionModel();
    const provider = new RevisionProvider(model);
    for (let i = 0; i < 11; i++) {
      await provider.append(3, { title: `t${i}`, content: `c${i}` });
    }
    // 同一毫秒内写完也不歧义：prune 排序是 {savedAt:-1,_id:-1}，
    // 假模型的 _id 单调递增，"最旧"有确定顺序（不 mock Date —— mock 构造器会自引用递归）
    expect(model.docs).toHaveLength(10);
    expect(model.docs.some((d: Doc) => d.title === 't0')).toBe(false); // 最旧被淘汰
    expect(model.docs.some((d: Doc) => d.title === 't10')).toBe(true);
  });

  it('appendSafe：底层写失败吞掉并返回 null（绝不影响文章保存）', async () => {
    delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    const model = createFakeRevisionModel();
    model.create.mockRejectedValueOnce(new Error('mongo 抖了'));
    const provider = new RevisionProvider(model);
    await expect(
      provider.appendSafe(1, { title: 'a', content: 'old' }, { content: 'new' }),
    ).resolves.toBeNull();
  });

  it('listMeta：投影里 content:0（**元数据列表不下发正文**），分页与 total 正确', async () => {
    delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    const docs = [
      { _id: 'r1', articleId: 5, savedAt: new Date(1700000003000), title: 'a', content: 'secret', wordCount: 1, sizeBytes: 6, reason: 'update' },
      { _id: 'r2', articleId: 5, savedAt: new Date(1700000002000), title: 'b', content: 'secret', wordCount: 1, sizeBytes: 6, reason: 'update' },
      { _id: 'r3', articleId: 5, savedAt: new Date(1700000001000), title: 'c', content: 'secret', wordCount: 1, sizeBytes: 6, reason: 'update' },
      { _id: 'r4', articleId: 6, savedAt: new Date(1700000001000), title: '别的文章', content: 'x', wordCount: 1, sizeBytes: 1, reason: 'update' },
    ];
    const model = createFakeRevisionModel(docs);
    const provider = new RevisionProvider(model);
    const res = await provider.listMeta(5, 1, 2);
    expect(res.total).toBe(3); // 只数 articleId=5
    expect(res.revisions).toHaveLength(2);
    expect(res.revisions[0]._id).toBe('r1'); // savedAt 倒序
    expect((res.revisions[0] as any).content).toBeUndefined();
    // find 的投影必须是 { content: 0 }
    const projection = model.find.mock.calls.find((c: any[]) => c[1])?.[1];
    expect(projection).toEqual({ content: 0 });
  });

  it('getOne：跨文章的 revisionId 拿不到（filter 同时带 articleId 与 _id）；非法 id 返回 null', async () => {
    delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    const model = createFakeRevisionModel([
      { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', articleId: 5, title: 'a', content: 'x' },
    ]);
    const provider = new RevisionProvider(model);
    // 合法 ObjectId 形状但属于文章 6 → null
    expect(await provider.getOne(6, 'aaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
    // 非法形状 → null（连查询都不发）
    model.findOne.mockClear();
    expect(await provider.getOne(5, '不是objectid')).toBeNull();
    expect(model.findOne).not.toHaveBeenCalled();
    // 属于文章 5 → 命中
    const hit: any = await provider.getOne(5, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(hit).not.toBeNull();
    expect(hit.content).toBe('x');
  });

  it('deleteForArticle：purge 时清掉整篇的历史', async () => {
    const model = createFakeRevisionModel([
      { _id: 'r1', articleId: 9 },
      { _id: 'r2', articleId: 9 },
      { _id: 'r3', articleId: 10 },
    ]);
    const provider = new RevisionProvider(model);
    expect(await provider.deleteForArticle(9)).toBe(2);
    expect(model.docs).toHaveLength(1);
    expect(model.docs[0].articleId).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// ArticleProvider.updateById 的接线（P4 的写入点）
// ---------------------------------------------------------------------------

function createMemoryArticleModel(initial: Doc[] = []): any {
  const docs = initial.map((d) => ({ ...d }));
  const findMatching = (query: any) => {
    if (query?.id === undefined) return null;
    return docs.find((d) => d.id === query.id) || null;
  };
  return {
    docs,
    findOne: jest.fn((query: any, projection?: any) => ({
      exec: async () => {
        const hit = findMatching(query);
        if (!hit) return null;
        if (projection) {
          return Object.fromEntries(
            Object.entries(hit).filter(([k]) => projection[k] === 1 || k === '_id'),
          );
        }
        return { ...hit };
      },
    })),
    updateOne: jest.fn(async (query: any, patch: any) => {
      const target = findMatching(query);
      if (!target) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(target, patch);
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    find: jest.fn(() => ({
      sort: () => ({ limit: async () => [] }),
      exec: async () => [],
    })),
  };
}

describe('ArticleProvider.updateById × RevisionProvider 接线', () => {
  const OLD_ENV = process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    else process.env.VANBLOG_ARTICLE_REVISIONS_KEEP = OLD_ENV;
  });

  function createArticleProvider(articleModel: any, revisionModel: any) {
    const revisions = new RevisionProvider(revisionModel);
    const provider = new ArticleProvider(
      articleModel,
      {} as any,
      { updateTotalWords: jest.fn() } as any,
      {} as any,
      revisions,
    );
    return { provider, revisions };
  }

  it('改 content：先把旧状态记成快照，再落新值', async () => {
    delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    const articleModel = createMemoryArticleModel([
      { id: 1, title: '旧标题', content: '旧正文', pathname: 'p1' },
    ]);
    const revisionModel = createFakeRevisionModel();
    const { provider } = createArticleProvider(articleModel, revisionModel);
    await provider.updateById(1, { content: '新正文' });
    expect(articleModel.docs[0].content).toBe('新正文');
    expect(revisionModel.docs).toHaveLength(1);
    expect(revisionModel.docs[0]).toMatchObject({
      articleId: 1,
      title: '旧标题',
      content: '旧正文',
      reason: 'update',
    });
  });

  it('没改 title/content（只改 tags）：不读旧正文、不写快照', async () => {
    delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    const articleModel = createMemoryArticleModel([{ id: 1, title: 't', content: 'c' }]);
    const revisionModel = createFakeRevisionModel();
    const { provider } = createArticleProvider(articleModel, revisionModel);
    await provider.updateById(1, { tags: ['x'] });
    expect(revisionModel.docs).toHaveLength(0);
    // 负控钉子：patch 不含 title/content 时连"多读一次旧文档"都不该发生
    expect(articleModel.findOne).not.toHaveBeenCalled();
  });

  it('内容没变（提交了相同 content）：不写快照', async () => {
    delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    const articleModel = createMemoryArticleModel([{ id: 1, title: 't', content: 'same' }]);
    const revisionModel = createFakeRevisionModel();
    const { provider } = createArticleProvider(articleModel, revisionModel);
    await provider.updateById(1, { content: 'same' });
    expect(revisionModel.docs).toHaveLength(0);
  });

  it('skipRevision=true（恢复历史版本流程自己记快照）：不再重复写', async () => {
    delete process.env.VANBLOG_ARTICLE_REVISIONS_KEEP;
    const articleModel = createMemoryArticleModel([{ id: 1, title: 't', content: 'old' }]);
    const revisionModel = createFakeRevisionModel();
    const { provider } = createArticleProvider(articleModel, revisionModel);
    await provider.updateById(1, { content: 'new' }, false, { skipRevision: true });
    expect(articleModel.docs[0].content).toBe('new');
    expect(revisionModel.docs).toHaveLength(0);
  });

  it('KEEP=0（关闭）：更新照常、快照零写入（= 今天的行为）', async () => {
    process.env.VANBLOG_ARTICLE_REVISIONS_KEEP = '0';
    const articleModel = createMemoryArticleModel([{ id: 1, title: 't', content: 'old' }]);
    const revisionModel = createFakeRevisionModel();
    const { provider } = createArticleProvider(articleModel, revisionModel);
    await provider.updateById(1, { content: 'new' });
    expect(articleModel.docs[0].content).toBe('new');
    expect(revisionModel.docs).toHaveLength(0);
    expect(articleModel.findOne).not.toHaveBeenCalled();
  });

  it('没注入 RevisionProvider（旧构造形状）：更新行为与从前逐字段一致', async () => {
    const articleModel = createMemoryArticleModel([{ id: 1, title: 't', content: 'old' }]);
    const provider = new ArticleProvider(
      articleModel,
      {} as any,
      { updateTotalWords: jest.fn() } as any,
      {} as any,
    );
    await provider.updateById(1, { content: 'new' });
    expect(articleModel.docs[0].content).toBe('new');
  });
});
