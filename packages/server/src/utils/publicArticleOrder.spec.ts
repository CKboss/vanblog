import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ARTICLE_AGG_DEFAULTS,
  articleDefaultsStage,
  isPinnedTop,
  orderPublicArticles,
  topRankOf,
  topSortSpec,
} from './publicArticleOrder';

/**
 * 公开列表的排序语义。
 *
 * 这份规则同时被两处使用：Mongo 聚合管道（`ArticleProvider.findPublicPage`）与
 * 聚合失败时的内存回退（`orderPublicArticles`）。两边必须**逐条一致**，
 * 否则一次偶发的管道失败就会让列表顺序悄悄变掉。
 */
describe('置顶判据与权重', () => {
  it('与原来那句 Boolean(top) && top != "" 一致', () => {
    for (const v of [null, undefined, '', 0, false]) {
      expect(isPinnedTop(v)).toBe(false);
    }
    for (const v of [1, 5, '3', true, -1]) {
      expect(isPinnedTop(v)).toBe(true);
    }
  });
  it('非置顶的权重恒为 0（这样它们在 $sort 里是常量，顺序由调用方的 sort 决定）', () => {
    expect(topRankOf('')).toBe(0);
    expect(topRankOf(0)).toBe(0);
    expect(topRankOf(undefined)).toBe(0);
    expect(topRankOf(7)).toBe(7);
    expect(topRankOf('12')).toBe(12);
    // 转不成数字的置顶值当 0（对应管道里的 $convert onError: 0）
    expect(topRankOf('abc')).toBe(0);
  });
});

describe('topSortSpec', () => {
  it('先 isTop、topRank，再接调用方的 sort', () => {
    expect(topSortSpec({ createdAt: -1, id: -1 })).toEqual({
      isTop: -1,
      topRank: -1,
      createdAt: -1,
      id: -1,
    });
  });
  it('去掉调用方 sort 里的 top：置顶组已经用 topRank 排过了', () => {
    // 留着 top 会让非置顶组的顺序被 BSON 类型顺序干扰（数字 < 字符串 < null，'' 会跑到 0 前面）
    expect(topSortSpec({ top: -1, id: -1 })).toEqual({ isTop: -1, topRank: -1, id: -1 });
  });
  it('空 sort 也不会炸', () => {
    expect(topSortSpec(undefined)).toEqual({ isTop: -1, topRank: -1 });
  });
});

describe('内存版排序与分页（回退路径）', () => {
  const docs = (spec: Array<[number, unknown]>) =>
    spec.map(([id, top]) => ({ id, top, createdAt: new Date(2026, 0, id).toISOString() }));

  it('置顶组排最前且按 top 降序，非置顶组保持传入顺序', () => {
    const input = docs([
      [1, 0],
      [2, 5],
      [3, ''],
      [4, 9],
      [5, 3],
    ]);
    // 传入顺序即"非置顶组已经按调用方的 sort 排好"
    expect(orderPublicArticles(input, 0, 10).map((d) => d.id)).toEqual([4, 2, 5, 1, 3]);
  });

  it('分页是在拼接之后切的（跨组翻页不会漏也不会重）', () => {
    const input = docs([
      [1, 0],
      [2, 5],
      [3, 0],
      [4, 9],
      [5, 0],
    ]);
    const all = orderPublicArticles(input, 0, 100).map((d) => d.id);
    const paged = [
      ...orderPublicArticles(input, 0, 2).map((d) => d.id),
      ...orderPublicArticles(input, 2, 2).map((d) => d.id),
      ...orderPublicArticles(input, 4, 2).map((d) => d.id),
    ];
    expect(all).toEqual([4, 2, 1, 3, 5]);
    expect(paged).toEqual(all);
  });

  it('支持 mongoose 文档（值在 _doc 上）', () => {
    const wrapped = [
      { _doc: { id: 1, top: 0 } },
      { _doc: { id: 2, top: 4 } },
    ] as any;
    expect(orderPublicArticles(wrapped, 0, 10).map((d: any) => d._doc.id)).toEqual([2, 1]);
  });
});

describe('聚合管道补的默认值要和 schema 保持一致', () => {
  // 聚合返回原始 BSON，不会应用 mongoose 的默认值；find() 会。
  // 少了这一步，公开接口在两条路径下会给出 cover:"" 与"没有 cover"两种形状
  // （实测就是这个差异让 A/B 对比第一次没通过）。
  const schema = readFileSync(join(__dirname, '../scheme/article.schema.ts'), 'utf8');

  it('schema 里每个带 default 的字段都在 ARTICLE_AGG_DEFAULTS 里', () => {
    // 解析 `@Prop({ ... default: X ... })\n  name: type;` 这样的成对写法
    const re = /@Prop\(\{([^}]*)\}\)\s*\n\s*([A-Za-z_][A-Za-z0-9_]*)\??:/g;
    const expected: Record<string, string> = {};
    let m: RegExpExecArray | null;
    while ((m = re.exec(schema))) {
      const opts = m[1];
      const field = m[2];
      const dm = /default:\s*('[^']*'|\[\]|true|false|[\d.]+)/.exec(opts);
      if (dm) {
        expected[field] = dm[1];
      }
    }
    const expectedFields = Object.keys(expected).sort();
    const actualFields = Object.keys(ARTICLE_AGG_DEFAULTS).sort();
    expect(actualFields).toEqual(expectedFields);
    // 值也要对得上（'[]' → []，"''" → ''，数字/布尔原样）
    for (const f of expectedFields) {
      const raw = expected[f];
      const want =
        raw === '[]' ? [] : raw.startsWith("'") ? raw.slice(1, -1) : JSON.parse(raw);
      expect(ARTICLE_AGG_DEFAULTS[f]).toEqual(want);
    }
  });

  it('生成的 $addFields 用 $ifNull，只在字段缺失时补', () => {
    const stage: any = articleDefaultsStage();
    expect(Object.keys(stage)).toEqual(['$addFields']);
    expect(stage.$addFields.cover).toEqual({ $ifNull: ['$cover', ''] });
    expect(stage.$addFields.viewer).toEqual({ $ifNull: ['$viewer', 0] });
    expect(Object.keys(stage.$addFields).length).toBe(Object.keys(ARTICLE_AGG_DEFAULTS).length);
  });
});

describe('管道里 $convert 的参数名', () => {
  // 踩过：写成 targetType 时 Mongo 报 "unknown argument: targetType"，
  // 而 findPublicPage 的 catch 会静默回退到内存分页 —— 功能看着正常，优化根本没生效。
  it('用的是 to，不是 targetType', () => {
    // ⚠️ 断言前必须剥注释：源码里那句解释"参数名是 to 不是 targetType"的注释
    //    本身就含 targetType，直接 not.toContain 会被自己的注释满足（本仓库第 N 次踩这个坑）。
    const strip = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
    const src = strip(
      readFileSync(join(__dirname, '../provider/article/article.provider.ts'), 'utf8'),
    );
    expect(src).toContain("$convert: { input: '$top', to: 'double'");
    expect(src).not.toContain('targetType');
  });
});
