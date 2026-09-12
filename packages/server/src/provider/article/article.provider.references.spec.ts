import { ArticleProvider } from './article.provider';

/** 只用到 articleModel.find()，其余依赖给空壳即可。 */
function createProvider(docs: any[]) {
  const calls: any[] = [];
  const model: any = {
    find: jest.fn(async (query: any, projection?: any) => {
      calls.push({ query, projection });
      const regex = query?.content?.$regex;
      const flags = query?.content?.$options || '';
      const re = new RegExp(regex, flags);
      return docs.filter(
        (doc) =>
          re.test(String(doc.content || '')) &&
          (doc.deleted === false || doc.deleted === undefined),
      );
    }),
  };
  const provider = new ArticleProvider(model, {} as any, { updateTotalWords: jest.fn() } as any, {} as any);
  return { provider, model, calls };
}

const A = '/static/img/aaa.image.webp';
const B = '/static/img/bbb.photo.webp';
const C = '/static/img/ccc.unused.webp';

describe('countArticlesByLinks', () => {
  const docs = [
    { id: 1, title: '第一篇', content: `看图 ![](${A}) 还有 ![](${B})`, deleted: false },
    { id: 2, title: '第二篇', content: `又见 ${A}`, deleted: false },
    { id: 3, title: '第三篇', content: `只有 ${B}`, deleted: false },
    { id: 4, title: '已删除', content: `${A}`, deleted: true },
    { id: 5, title: '老数据没有 deleted 字段', content: `${C}` },
  ];

  it('counts references per link in one query', async () => {
    const { provider, model } = createProvider(docs);

    const res = await provider.countArticlesByLinks([A, B, C]);

    expect(model.find).toHaveBeenCalledTimes(1); // 一次查完，不是每张图查一次
    expect(res[A].count).toBe(2);
    expect(res[B].count).toBe(2);
    expect(res[C].count).toBe(1); // 没有 deleted 字段的老数据也算
    expect(res[A].articles).toEqual([
      { id: 1, title: '第一篇' },
      { id: 2, title: '第二篇' },
    ]);
  });

  it('matches absolute URLs when searching by the relative path', async () => {
    const { provider } = createProvider([
      { id: 9, title: '绝对地址', content: `![](https://blog.example.com${A})`, deleted: false },
    ]);

    const res = await provider.countArticlesByLinks([A]);

    expect(res[A].count).toBe(1);
  });

  it('escapes regex metacharacters in links', async () => {
    const tricky = '/static/img/a(b)+c.webp';
    const { provider } = createProvider([
      { id: 1, title: '不该命中', content: '/static/img/axbxcc.webp', deleted: false },
      { id: 2, title: '该命中', content: tricky, deleted: false },
    ]);

    const res = await provider.countArticlesByLinks([tricky]);

    expect(res[tricky].count).toBe(1);
    expect(res[tricky].articles).toEqual([{ id: 2, title: '该命中' }]);
  });

  it('dedupes input, caps the article list and handles empty input', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      title: `文章${i + 1}`,
      content: A,
      deleted: false,
    }));
    const { provider, model } = createProvider(many);

    const res = await provider.countArticlesByLinks([A, A, '', '   ']);
    expect(res[A].count).toBe(12);
    expect(res[A].articles).toHaveLength(10); // 列表里只带前 10 篇

    expect(await provider.countArticlesByLinks([])).toEqual({});
    expect(model.find).toHaveBeenCalledTimes(1); // 空输入不查库
  });

  it('caps the number of links per request', async () => {
    const { provider, calls } = createProvider(docs);
    const links = Array.from({ length: 250 }, (_, i) => `/static/img/x${i}.webp`);

    const res = await provider.countArticlesByLinks(links);

    expect(Object.keys(res)).toHaveLength(200);
    expect(calls[0].query.content.$regex.split('|')).toHaveLength(200);
    // 投影只取需要的字段，别把整篇正文以外的东西也拉回来
    expect(calls[0].projection).toEqual({ _id: 0, id: 1, title: 1, content: 1 });
  });
});
