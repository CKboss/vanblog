import { BadRequestException } from '@nestjs/common';
import { ArticleProvider } from './article.provider';
import { titleToSlug } from 'src/utils/slug';

/**
 * Minimal in-memory stand-in for the mongoose Article model, covering exactly
 * the queries the pathname feature issues:
 *   findOne({ pathname, id? })          uniqueness probe
 *   find({ $or: [...], deleted })       backfill scan
 *   find({}).sort().limit()             getNewId
 *   updateOne({ id }, patch)            backfill / updateById writes
 */
function createArticleModelStub(initial: any[] = []) {
  const docs = initial.map((item) => ({ ...item }));

  const matchesPathnameClause = (doc: any, clause: any) => {
    if (clause === '') {
      return doc.pathname === '' || doc.pathname == null;
    }
    if (clause === null) {
      return doc.pathname == null;
    }
    if (clause && clause.$exists === false) {
      return doc.pathname === undefined;
    }
    return doc.pathname === clause;
  };

  const matches = (doc: any, query: any) => {
    if (!query) {
      return true;
    }
    if (query.pathname !== undefined && !matchesPathnameClause(doc, query.pathname)) {
      return false;
    }
    if (query.id !== undefined) {
      const idQuery = query.id;
      if (idQuery && typeof idQuery === 'object' && '$ne' in idQuery) {
        if (doc.id === idQuery.$ne) {
          return false;
        }
      } else if (doc.id !== idQuery) {
        return false;
      }
    }
    if (Array.isArray(query.$or)) {
      const hit = query.$or.some((clause: any) =>
        matchesPathnameClause(doc, clause.pathname),
      );
      if (!hit) {
        return false;
      }
    }
    if (query.deleted && query.deleted.$ne === true && doc.deleted === true) {
      return false;
    }
    return true;
  };

  const model: any = function ModelCtor(dto: any) {
    Object.assign(this, dto);
    this.save = async () => {
      docs.push(this);
      return this;
    };
  };

  model.findOne = jest.fn((query: any) => ({
    exec: async () => docs.find((doc) => matches(doc, query)) || null,
  }));

  model.updateOne = jest.fn(async (query: any, patch: any) => {
    const target = docs.find((doc) => matches(doc, query));
    if (!target) {
      return { modifiedCount: 0 };
    }
    Object.assign(target, patch);
    return { modifiedCount: 1 };
  });

  model.find = jest.fn((query: any) => {
    const chain: any = {
      sort: () => chain,
      limit: () =>
        Promise.resolve(
          docs
            .filter((doc) => matches(doc, query))
            .slice()
            .sort((a, b) => b.id - a.id)
            .slice(0, 1),
        ),
      exec: async () =>
        docs
          .filter((doc) => matches(doc, query))
          .slice()
          .sort((a, b) => a.id - b.id),
    };
    return chain;
  });

  return { model, docs };
}

function createProvider(model: any) {
  return new ArticleProvider(model, {} as any, { updateTotalWords: jest.fn() } as any, {} as any);
}

describe('ArticleProvider pathname on create', () => {
  it('derives a pinyin alias from the title', async () => {
    const { model, docs } = createArticleModelStub();
    const provider = createProvider(model);

    const article: any = await provider.create(
      { title: '快速掌握手动挡汽车驾驶的系统方法', category: '博客' } as any,
      true,
      54,
    );

    expect(article.pathname).toBe(titleToSlug('快速掌握手动挡汽车驾驶的系统方法'));
    expect(article.pathname).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(docs[0].pathname).toBe(article.pathname);
  });

  it('keeps mixed Chinese/English titles readable', async () => {
    const { model } = createArticleModelStub();
    const provider = createProvider(model);

    const article: any = await provider.create(
      { title: '为ClaudeCode接入第三方LLM', category: '博客' } as any,
      true,
      55,
    );

    expect(article.pathname).toBe('wei-claudecode-jie-ru-di-san-fang-llm');
  });

  it('suffixes duplicated titles instead of colliding', async () => {
    const { model, docs } = createArticleModelStub();
    const provider = createProvider(model);

    const first: any = await provider.create({ title: '摄影分享', category: '博客' } as any, true, 1);
    const second: any = await provider.create({ title: '摄影分享', category: '博客' } as any, true, 2);
    const third: any = await provider.create({ title: '摄影分享', category: '博客' } as any, true, 3);

    expect(first.pathname).toBe('she-ying-fen-xiang');
    expect(second.pathname).toBe('she-ying-fen-xiang-2');
    expect(third.pathname).toBe('she-ying-fen-xiang-3');
    expect(new Set(docs.map((d) => d.pathname)).size).toBe(3);
  });

  it('prefers a manually provided alias and normalizes slashes', async () => {
    const { model } = createArticleModelStub();
    const provider = createProvider(model);

    const article: any = await provider.create(
      { title: '随便一个标题', category: '博客', pathname: '/my-alias/' } as any,
      true,
      9,
    );

    expect(article.pathname).toBe('my-alias');
  });

  it('rejects a manual alias that would shadow an article id', async () => {
    const { model } = createArticleModelStub();
    const provider = createProvider(model);

    await expect(
      provider.create({ title: '标题', category: '博客', pathname: '53' } as any, true, 54),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a manual alias containing a path separator', async () => {
    const { model } = createArticleModelStub();
    const provider = createProvider(model);

    await expect(
      provider.create({ title: '标题', category: '博客', pathname: 'a/b' } as any, true, 54),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a manual alias already used by another article', async () => {
    const { model } = createArticleModelStub([{ id: 1, title: '旧文章', pathname: 'taken' }]);
    const provider = createProvider(model);

    await expect(
      provider.create({ title: '新文章', category: '博客', pathname: 'taken' } as any, true, 2),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('treats a soft-deleted alias as still occupied', async () => {
    const { model } = createArticleModelStub([
      { id: 1, title: '摄影', pathname: 'she-ying', deleted: true },
    ]);
    const provider = createProvider(model);

    const article: any = await provider.create({ title: '摄影', category: '博客' } as any, true, 2);

    // 回收站里的文章随时会被恢复，所以它的别名不会被再次发放
    expect(article.pathname).toBe('she-ying-2');

    await expect(
      provider.create({ title: '摄影', category: '博客', pathname: 'she-ying' } as any, true, 3),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('falls back to the id URL for titles without a usable slug', async () => {
    const { model } = createArticleModelStub();
    const provider = createProvider(model);

    const numeric: any = await provider.create({ title: '2024', category: '博客' } as any, true, 7);
    const emoji: any = await provider.create({ title: '🎉', category: '博客' } as any, true, 8);

    expect(numeric.pathname).toBe('');
    expect(emoji.pathname).toBe('');
  });
});

describe('ArticleProvider pathname on update', () => {
  const original = { id: 7, title: '旧标题', pathname: 'jiu-biao-ti', deleted: false };

  it('accepts an explicit alias change', async () => {
    const { model, docs } = createArticleModelStub([{ ...original }]);
    const provider = createProvider(model);

    await provider.updateById(7, { pathname: 'xin-bie-ming' } as any, true);

    expect(docs[0].pathname).toBe('xin-bie-ming');
  });

  it('clears the alias when an empty value is sent', async () => {
    const { model, docs } = createArticleModelStub([{ ...original }]);
    const provider = createProvider(model);

    await provider.updateById(7, { pathname: '   ' } as any, true);

    expect(docs[0].pathname).toBe('');
  });

  it('does not regenerate the alias when only the title changes', async () => {
    const { model, docs } = createArticleModelStub([{ ...original }]);
    const provider = createProvider(model);

    await provider.updateById(7, { title: '全新标题' } as any, true);

    expect(docs[0].pathname).toBe('jiu-biao-ti');
  });

  it('rejects an alias owned by another article but allows keeping its own', async () => {
    const { model, docs } = createArticleModelStub([
      { ...original },
      { id: 8, title: '别的文章', pathname: 'other' },
    ]);
    const provider = createProvider(model);

    await expect(provider.updateById(7, { pathname: 'other' } as any, true)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      provider.updateById(7, { pathname: 'jiu-biao-ti' } as any, true),
    ).resolves.toBeDefined();
    expect(docs[0].pathname).toBe('jiu-biao-ti');
  });
});

describe('ArticleProvider backfillPathname', () => {
  const seeded = [
    { id: 1, title: '摄影分享', pathname: '', deleted: false },
    { id: 2, title: '摄影分享', deleted: false },
    { id: 3, title: '已有别名', pathname: 'manual-slug', deleted: false },
    { id: 4, title: '回收站里的文章', pathname: '', deleted: true },
    { id: 5, title: '2024', pathname: '', deleted: false },
  ];

  it('fills empty aliases, skips manual ones and deleted articles', async () => {
    const { model, docs } = createArticleModelStub(seeded);
    const provider = createProvider(model);

    const result = await provider.backfillPathname();

    expect(result.dryRun).toBe(false);
    // 命中扫描的只有 id 1/2/5：已有别名的 3 和回收站里的 4 不在范围内
    expect(result.scanned).toBe(3);
    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(1); // id 5 标题是纯数字，生成不出可用 slug
    expect(result.items.map((i) => i.pathname)).toEqual([
      'she-ying-fen-xiang',
      'she-ying-fen-xiang-2',
    ]);
    expect(docs.find((d) => d.id === 3).pathname).toBe('manual-slug');
    expect(docs.find((d) => d.id === 4).pathname).toBe('');
    expect(docs.find((d) => d.id === 5).pathname).toBe('');
  });

  it('reports the same picks in dryRun without writing', async () => {
    const { model, docs } = createArticleModelStub(seeded);
    const provider = createProvider(model);

    const result = await provider.backfillPathname({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.items.map((i) => i.pathname)).toEqual(['she-ying-fen-xiang', 'she-ying-fen-xiang-2']);
    expect(docs.find((d) => d.id === 1).pathname).toBe('');
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const { model } = createArticleModelStub(seeded);
    const provider = createProvider(model);

    await provider.backfillPathname();
    const second = await provider.backfillPathname();

    expect(second.updated).toBe(0);
    expect(second.items).toEqual([]);
  });
});
