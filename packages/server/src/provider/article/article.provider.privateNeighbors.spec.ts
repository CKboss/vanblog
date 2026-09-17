import { ArticleProvider } from './article.provider';

/**
 * P8：公开导航/推荐/搜索面不再暴露加密文章（private 或加密分类）的标题与别名。
 *
 * 泄露类别与 §7.40 关掉的那三处（搜索正文、RSS、解锁口）相同：加密文章的标题
 * 往往就是全部秘密。本 spec 全部是**行为级**断言（假 mongo 真的按查询过滤），
 * 负控：把 getPre/getNext/searchByString/getRelatedArticles 里任何一处
 * `private` 过滤拆掉，对应用例立刻红（已实测，见交付报告）。
 */

type Doc = Record<string, any>;

function createModel(docs: Doc[], privateCategories: string[] = []) {
  const captured: Array<{ method: string; query?: any }> = [];
  const evalNode = (doc: Doc, node: any): boolean => {
    if (!node || typeof node !== 'object') return true;
    if (Array.isArray(node.$and)) return node.$and.every((n) => evalNode(doc, n));
    if (Array.isArray(node.$or)) return node.$or.some((n) => evalNode(doc, n));
    for (const [field, cond] of Object.entries(node)) {
      if (field.startsWith('$')) continue;
      const value = doc[field];
      if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
        const c: any = cond;
        if ('$in' in c) {
          const hit = Array.isArray(value)
            ? value.some((v) => c.$in.includes(v))
            : c.$in.includes(value);
          if (!hit) return false;
        }
        if ('$nin' in c) {
          if (Array.isArray(value) ? value.some((v) => c.$nin.includes(v)) : c.$nin.includes(value))
            return false;
        }
        if ('$ne' in c && value === c.$ne) return false;
        if ('$regex' in c) {
          const pattern = c.$regex instanceof RegExp ? c.$regex.source : String(c.$regex);
          const re = new RegExp(pattern, typeof c.$options === 'string' ? c.$options : '');
          const hay = Array.isArray(value)
            ? value.map(String).join('\n')
            : String(value ?? '');
          if (!re.test(hay)) return false;
        }
        if ('$lt' in c && !(value < c.$lt)) return false;
        if ('$gt' in c && !(value > c.$gt)) return false;
        if ('$lte' in c) {
          if (value === null || value === undefined) {
            // $lte 与 null：只有 $exists 分支负责放行缺失字段
            if (!('$lte' in c && Object.keys(c).length === 1)) return false;
            return false;
          }
          if (!(value <= c.$lte)) return false;
        }
        if ('$exists' in c) {
          const exists = value !== undefined && value !== null;
          if (exists !== (c.$exists === true)) {
            // null 在 Mongo 里算存在；这里文档用 null 表示"存在且为 null"
            if (!(c.$exists === true && value === null)) return false;
          }
        }
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  };
  const model: any = {
    captured,
    docs,
    find: (query?: any, projection?: any) => {
      captured.push({ method: 'find', query });
      const rows = docs.filter((d) => evalNode(d, query));
      const chain: any = {
        sort: (spec: Doc) => {
          const entries = Object.entries(spec);
          rows.sort((a, b) => {
            for (const [key, dir] of entries) {
              const av = a[key] instanceof Date ? a[key].getTime() : a[key];
              const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
              if (av === undefined || bv === undefined || av === bv) continue;
              return av < bv ? -(dir as number) : (dir as number);
            }
            return 0;
          });
          return chain;
        },
        skip: () => chain,
        limit: (n: number) => {
          rows.splice(n);
          return chain;
        },
        maxTimeMS: () => chain,
        lean: () => chain,
        exec: async () => rows.map((d) => ({ ...d })),
        // getPre/getNext 是 `await query.limit(1)`（不 .exec()）—— 链必须是 thenable
        then: (onFulfilled: any) => onFulfilled(rows.map((d) => ({ ...d }))),
        countDocuments: async () => rows.length,
      };
      return chain;
    },
    findOne: (query?: any) => {
      captured.push({ method: 'findOne', query });
      const hit = docs.filter((d) => evalNode(d, query))[0] || null;
      return { exec: async () => (hit ? { ...hit } : null) };
    },
    countDocuments: (query?: any) => ({
      exec: async () => docs.filter((d) => evalNode(d, query)).length,
    }),
    updateOne: () => ({ exec: async () => ({ matchedCount: 1, modifiedCount: 1 }) }),
    deleteOne: () => ({ exec: async () => ({ deletedCount: 1 }) }),
  };
  const categoryModel = {
    find: () => ({
      exec: async () => privateCategories.map((name) => ({ name, private: true })),
    }),
    findOne: () => ({ exec: async () => null }),
  };
  return { model, categoryModel };
}

function createProvider(model: any, categoryModel: any) {
  return new ArticleProvider(
    model,
    categoryModel as any,
    { updateTotalWords: () => undefined, getSiteInfo: async () => ({}) } as any,
    {} as any,
  );
}

const t = (iso: string) => new Date(iso);

function seed(): Doc[] {
  return [
    { id: 1, title: '当前', content: 'x', createdAt: t('2026-05-05'), hidden: false, deleted: false, private: false, publishAt: null, category: 'tech', tags: ['go'] },
    { id: 2, title: '更新的公开', content: 'x', createdAt: t('2026-06-01'), hidden: false, deleted: false, private: false, publishAt: null, category: 'tech', tags: ['go'] },
    { id: 3, title: '2026年裁员名单', content: 'SECRET', createdAt: t('2026-04-01'), hidden: false, deleted: false, private: true, password: 'pw', publishAt: null, category: 'tech', tags: ['go'] },
    { id: 4, title: '加密分类里的', content: 'SECRET', createdAt: t('2026-03-01'), hidden: false, deleted: false, private: false, publishAt: null, category: '私密日记', tags: ['go'] },
    { id: 5, title: '更旧的公开', content: 'x', createdAt: t('2026-02-01'), hidden: false, deleted: false, private: false, publishAt: null, category: 'tech', tags: ['db'] },
  ];
}

describe('P8 · 上一篇/下一篇不暴露加密文章', () => {
  it('公开上下文：private 文章与加密分类文章都被跳过，取到的是下一篇**公开**文章', async () => {
    const { model, categoryModel } = createModel(seed(), ['私密日记']);
    const provider = createProvider(model, categoryModel);
    const cur: any = model.docs[0]; // 2026-05-05
    const pre = await provider.getPreArticleByArticle(cur, 'list', undefined, ['私密日记']);
    const next = await provider.getNextArticleByArticle(cur, 'list', undefined, ['私密日记']);
    // 上一篇按 createdAt < 05-05 里最新的公开文章：04-01 是 private(3)、03-01 是加密分类(4)
    // → 必须跳过它们取 02-01 的公开文章(5)
    expect((pre as any)?.id).toBe(5);
    expect((next as any)?.id).toBe(2); // 06-01 公开
    const titles = [pre, next].map((a: any) => a?.title);
    expect(titles).not.toContain('2026年裁员名单');
    expect(titles).not.toContain('加密分类里的');
  });

  it('includeHidden=true（管理语境）保持旧行为：不做 private 过滤', async () => {
    const { model, categoryModel } = createModel(seed(), ['私密日记']);
    const provider = createProvider(model, categoryModel);
    const cur: any = model.docs[0];
    const pre = await provider.getPreArticleByArticle(cur, 'list', true, ['私密日记']);
    expect((pre as any)?.id).toBe(3); // private 也能当邻居（管理语境本来就能看全部）
  });

  it('getByIdOrPathnameWithPreNext：加密分类名单只查一次，pre/next 共用', async () => {
    const { model, categoryModel } = createModel(seed(), ['私密日记']);
    const findSpy = jest.spyOn(categoryModel, 'find');
    const provider = createProvider(model, categoryModel);
    await provider.getByIdOrPathnameWithPreNext(1, 'public');
    // 当前文章的分类隐私检查 1 次 + P8 名单 1 次 = 2（pre/next 不再各自查）
    expect(findSpy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(findSpy).toHaveBeenCalledWith({ private: true });
  });
});

describe('P8 · 公开搜索不返回加密文章标题', () => {
  it('private 与加密分类的文章都搜不到；includeHidden=true 时保持旧行为', async () => {
    const { model, categoryModel } = createModel(seed(), ['私密日记']);
    const provider = createProvider(model, categoryModel);
    const publicRes = await provider.searchByString('SECRET', false);
    expect(publicRes).toHaveLength(0); // 两篇加密文章标题/正文都命中关键词，但必须被过滤
    const adminRes = await provider.searchByString('SECRET', true);
    expect(adminRes.length).toBe(2); // 管理语境照旧全给
  });

  it('查询里带 private 过滤与加密分类 $nin（负控钉子：拆掉过滤这条红）', async () => {
    const { model, categoryModel } = createModel(seed(), ['私密日记']);
    const provider = createProvider(model, categoryModel);
    model.captured.length = 0;
    await provider.searchByString('x', false);
    const q = JSON.stringify(model.captured.at(-1).query);
    expect(q).toContain('"private"');
    expect(q).toContain('"$nin":["私密日记"]');
  });
});

describe('P8 · 相关文章（P6 推荐位）同样排除加密文章', () => {
  it('private 与加密分类都不进推荐；公开文章正常出现', async () => {
    const { model, categoryModel } = createModel(seed(), ['私密日记']);
    const provider = createProvider(model, categoryModel);
    const related = await provider.getRelatedArticles(model.docs[0] as any, 5, new Date('2026-09-17T00:00:00Z'));
    const ids = related.map((r) => r.id);
    expect(ids).toContain(2);
    expect(ids).toContain(5);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(1); // 自身
  });
});
