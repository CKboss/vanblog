import { ArticleProvider } from './article.provider';
import { articleOverviewMarkdown } from 'src/utils/articleExcerpt';
import { ARTICLE_AGG_DEFAULTS } from 'src/utils/publicArticleOrder';

/**
 * getByOption 的 withExcerpt 开关（服务端摘要）。
 *
 * 为什么需要它：前台首页/分页页以前把列表文章的**全文**带回浏览器塞进 __NEXT_DATA__
 * （实测首页 5 篇正文 25,053 B、卡片只渲染 3,263 B 摘要，__NEXT_DATA__ 占首页 gzip 的
 * 54.8%）。开了 withExcerpt + toListView 之后，server 现算摘要和首图、剥掉 content。
 *
 * 这里用假模型同时钉住三件事：
 *  1. 列表项带 excerpt/firstImage，content/password 被剥掉；
 *  2. **聚合分页（findPublicPage）与 find() 回退两条路径的响应形状逐字段一致**
 *     （聚合返回原始 BSON，find() 返回 schema 水合文档，两边的默认值补齐方式不同，
 *     009db46b 引入管道时就在这里翻过车：老文档一条有 cover:"" 一条没有）；
 *  3. 私密文章不泄露摘要（过滤发生在算摘要之前）。
 */

/** 按投影裁剪（1 保留；_id:0 之类的排除项忽略），模拟 mongoose/聚合的 $project */
function projectDoc(doc: any, view: any) {
  const out: any = {};
  for (const [k, v] of Object.entries(view || {})) {
    if (v === 1 && k in doc) {
      out[k] = doc[k];
    }
  }
  return out;
}

function sortRows(rows: any[], spec: Record<string, 1 | -1>) {
  const keys = Object.entries(spec);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = a[k];
      const bv = b[k];
      if (av === bv) continue;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  });
}

function createListModel(docs: any[]) {
  // 两条路径的「补默认值」方式不同但结果必须一致：find() 靠 schema 水合，
  // 聚合靠 articleDefaultsStage 的 $ifNull —— 假模型统一用 ARTICLE_AGG_DEFAULTS 补
  const hydrate = (d: any) => ({ ...ARTICLE_AGG_DEFAULTS, ...d });
  const find = jest.fn((_query: any, view: any) => {
    const q: any = {
      sort: () => q,
      skip: () => q,
      limit: () => q,
      exec: async () => docs.map(hydrate).map((d) => projectDoc(d, view)),
    };
    return q;
  });
  // 只提供 countDocuments（mongoose 8 已删掉 Model.count()）：桩上留着 count
  // 会让"provider 退回 count()"这种回归静默通过。
  const countDocuments = jest.fn(() => ({ exec: async () => docs.length }));
  const aggregate = jest.fn((pipeline: any[]) => ({
    allowDiskUse: () => ({
      exec: async () => {
        let rows = docs.map(hydrate);
        for (const stage of pipeline) {
          if (stage.$sort) rows = sortRows(rows, stage.$sort);
          else if (stage.$skip) rows = rows.slice(stage.$skip);
          else if (stage.$limit) rows = rows.slice(0, stage.$limit);
          else if (stage.$project) rows = rows.map((d) => projectDoc(d, stage.$project));
          // $match/$addFields：fixture 已按查询排好序、默认值已在 hydrate 里补齐
        }
        return rows;
      },
    }),
  }));
  return { find, countDocuments, aggregate };
}

function createProvider(model: any) {
  const provider = new ArticleProvider(
    model,
    {} as any,
    { updateTotalWords: jest.fn() } as any,
    {} as any,
  );
  jest.spyOn(provider, 'getPrivateCategoryNames').mockResolvedValue([]);
  return provider;
}

const day = (n: number) => new Date(2026, 0, n).toISOString();
// 代码块里的示例图不算首图；真正的首图是文档顺序里的第一张可用图（与前台规则一致）
const CONTENT_WITH_IMAGE = [
  '# 标题',
  '',
  '```md',
  '![示例](/static/img/decoy.webp)',
  '```',
  '',
  '![图](/static/img/real-first.webp) 正文'.concat('很'.repeat(300)),
].join('\n');

function fixtureDocs() {
  return [
    {
      // 老文档：没有 cover/pathname 这些后加字段（形状一致性的关键样本）
      id: 3,
      title: '带标记',
      content: '摘要部分\n\n<!-- more -->\n\n后面的正文',
      category: 'tech',
      tags: ['a'],
      createdAt: new Date(day(3)),
      updatedAt: new Date(day(3)),
    },
    {
      id: 2,
      title: '带图无标记',
      content: CONTENT_WITH_IMAGE,
      category: 'tech',
      tags: [],
      cover: '',
      pathname: 'with-image',
      createdAt: new Date(day(2)),
      updatedAt: new Date(day(2)),
    },
    {
      id: 1,
      title: '加密文章',
      content: '加密正文的前 200 字也不许出现在公开列表里'.repeat(20),
      category: 'tech',
      tags: [],
      private: true,
      password: 'secret',
      createdAt: new Date(day(1)),
      updatedAt: new Date(day(1)),
    },
  ];
}

describe('getByOption withExcerpt（服务端摘要）', () => {
  it('toListView + withExcerpt：列表项带 excerpt/firstImage，content 被剥掉', async () => {
    const model = createListModel(fixtureDocs());
    const provider = createProvider(model);
    const res = await provider.getByOption(
      { page: 1, pageSize: -1, toListView: true, withExcerpt: true, regMatch: false } as any,
      true,
    );
    const byId = Object.fromEntries(res.articles.map((a: any) => [a.id, a]));

    expect(byId[3].excerpt).toBe('摘要部分\n\n');
    // 摘要必须与共享实现一致（前台卡片对同一篇算出来的就是这个）
    expect(byId[3].excerpt).toBe(
      articleOverviewMarkdown('摘要部分\n\n<!-- more -->\n\n后面的正文'),
    );
    expect(byId[3].content).toBeUndefined();
    expect(byId[3].firstImage).toBeUndefined(); // 正文里没有图

    expect(byId[2].firstImage).toBe('/static/img/real-first.webp');
    expect(byId[2].excerpt).toBe(articleOverviewMarkdown(CONTENT_WITH_IMAGE));
    expect(byId[2].content).toBeUndefined();

    // JSON 响应里 content/password 这两个键必须**不存在**（undefined 会被序列化丢掉）
    const json = JSON.parse(JSON.stringify(res.articles));
    for (const a of json) {
      expect('content' in a).toBe(false);
      expect('password' in a).toBe(false);
    }
  });

  it('私密文章不泄露摘要：过滤发生在算摘要之前', async () => {
    const model = createListModel(fixtureDocs());
    const provider = createProvider(model);
    const res = await provider.getByOption(
      { page: 1, pageSize: -1, toListView: true, withExcerpt: true, regMatch: false } as any,
      true,
    );
    const locked: any = res.articles.find((a: any) => a.id === 1);
    expect(locked.private).toBe(true);
    expect(locked.content).toBeUndefined();
    expect(locked.password).toBeUndefined();
    expect(locked.excerpt).toBeUndefined();
    expect(locked.firstImage).toBeUndefined();
  });

  it('聚合分页与 find() 回退两条路径的响应形状逐字段一致', async () => {
    const docs = fixtureDocs();
    const aggModel = createListModel(docs);
    const aggRes = await createProvider(aggModel).getByOption(
      { page: 1, pageSize: 5, toListView: true, withExcerpt: true, regMatch: false } as any,
      true,
    );
    // pageSize=5（非 -1）+ isPublic → 必须走聚合（findPublicPage），否则这条对比没意义
    expect(aggModel.aggregate).toHaveBeenCalled();
    expect(aggModel.find).not.toHaveBeenCalled();

    const findModel = createListModel(docs);
    const findRes = await createProvider(findModel).getByOption(
      { page: 1, pageSize: -1, toListView: true, withExcerpt: true, regMatch: false } as any,
      true,
    );
    expect(findModel.aggregate).not.toHaveBeenCalled();

    expect(aggRes.articles.length).toBe(findRes.articles.length);
    for (let i = 0; i < aggRes.articles.length; i++) {
      const a = JSON.parse(JSON.stringify(aggRes.articles[i]));
      const b = JSON.parse(JSON.stringify(findRes.articles[i]));
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      expect(a).toEqual(b);
    }
  });

  it('不开 withExcerpt 时响应形状一个字段都不变（既有调用方零影响）', async () => {
    const model = createListModel(fixtureDocs());
    const provider = createProvider(model);
    const res = await provider.getByOption(
      { page: 1, pageSize: -1, toListView: true, regMatch: false } as any,
      true,
    );
    for (const a of res.articles as any[]) {
      expect(a.excerpt).toBeUndefined();
      expect(a.firstImage).toBeUndefined();
      expect('excerpt' in a).toBe(false);
      expect('firstImage' in a).toBe(false);
    }
    // toListView 老语义：公开文章也没有 content
    expect((res.articles as any[])[0].content).toBeUndefined();
  });

  it('withExcerpt 但没开 toListView：content 保留，摘要照样算（显式 opt-in 的语义）', async () => {
    const model = createListModel(fixtureDocs());
    const provider = createProvider(model);
    const res = await provider.getByOption(
      { page: 1, pageSize: -1, withExcerpt: true, regMatch: false } as any,
      true,
    );
    const open: any = res.articles.find((a: any) => a.id === 3);
    expect(open.content).toBe('摘要部分\n\n<!-- more -->\n\n后面的正文');
    expect(open.excerpt).toBe('摘要部分\n\n');
  });
});
