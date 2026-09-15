import { PipelineStage } from 'mongoose';

/**
 * 公开文章列表的排序语义 —— **一份定义，两处使用**。
 *
 * 数据库里能用聚合管道做（`$sort: topSortSpec(...)` + `$skip` + `$limit`，见
 * `ArticleProvider.findPublicPage`），但聚合万一失败要能回退到内存里做同一件事，
 * 而且两边的结果必须**逐条一致**，所以把规则抽成这两个纯函数，
 * 并用对照测试钉住（`publicArticleOrder.spec.ts`）。
 *
 * 规则（沿用改造前 JS 的行为，不改动既有语义）：
 *  1. "置顶"的判据：`top` 存在、不是空串、不是 0/false —— 也就是原来那句
 *     `Boolean(top) && top != ''`；
 *  2. 置顶组永远排在最前，组内按 `top` 的数值**降序**（原来即使传了 sortTop=asc，
 *     置顶组内部也是降序，这里保持一致，不"顺手修"）；
 *  3. 非置顶组保持传入的 sort 顺序（调用方已经排好了）；
 *  4. 拼接后再 `slice(skip, skip + limit)`。
 */

/** 判断一篇文章是不是置顶（与 Mongo 管道里 isTop 的判据一一对应） */
export function isPinnedTop(top: unknown): boolean {
  if (top === null || top === undefined) return false;
  if (top === '') return false;
  if (top === 0) return false;
  if (top === false) return false;
  return Boolean(top);
}

/** 置顶权重：置顶的取数值（转不动就当 0），非置顶一律 0（常量，不参与排序） */
export function topRankOf(top: unknown): number {
  if (!isPinnedTop(top)) return 0;
  const n = Number(top);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把聚合管道要用的 `$sort` 规格算出来：先是 isTop、topRank，再是调用方给的 sort，
 * 但要去掉其中的 `top`（置顶组已经用 topRank 排过，留着会让非置顶组的顺序被
 * `top` 的 BSON 类型顺序干扰：数字 < 字符串 < null，`''` 会跑到 0 前面去）。
 */
export function topSortSpec(sort: Record<string, 1 | -1> | undefined | null): Record<string, 1 | -1> {
  const spec: Record<string, 1 | -1> = { isTop: -1, topRank: -1 };
  for (const [key, dir] of Object.entries(sort || {})) {
    if (key === 'top' || key === 'isTop' || key === 'topRank') continue;
    spec[key] = dir;
  }
  return spec;
}

/** 内存版：与聚合管道等价（聚合失败时的回退路径，也是对照测试的参照实现） */
export function orderPublicArticles<T extends { top?: unknown; _doc?: any }>(
  articles: T[],
  skip: number,
  limit: number,
): T[] {
  const value = (a: T) => (a && (a as any)._doc ? (a as any)._doc.top : (a as any).top);
  const pinned = articles.filter((a) => isPinnedTop(value(a)));
  const rest = articles.filter((a) => !isPinnedTop(value(a)));
  pinned.sort((a, b) => topRankOf(value(b)) - topRankOf(value(a)));
  const all = [...pinned, ...rest];
  const end = skip + limit > all.length ? all.length : skip + limit;
  return all.slice(skip, end);
}

/**
 * `ArticleSchema` 里所有带 `default` 的字段与它们的默认值。
 *
 * 为什么需要它：`find()` 返回的是**经过 schema 水合的文档**，缺字段时会补上默认值；
 * 而聚合管道返回的是**原始 BSON**，老文档里根本没有 `cover` 这种后加的字段，
 * 于是同一个接口在两条路径下会给出 `cover: ""` 与"没有 cover"两种形状
 * （实测就是这个差异让 A/B 对比第一次没通过）。这里在管道里用 `$ifNull` 显式补齐。
 *
 * ⚠️ 改 `article.schema.ts` 的默认值时**必须同步这份清单**，
 * `publicArticleOrder.spec.ts` 会解析 schema 源码做对照，漏了会红。
 */
export const ARTICLE_AGG_DEFAULTS: Record<string, unknown> = {
  content: '',
  tags: [],
  top: 0,
  hidden: false,
  pathname: '',
  private: false,
  password: '',
  deleted: false,
  viewer: 0,
  visited: 0,
  cover: '',
};

/**
 * 生成"把缺失字段补成 schema 默认值"的 `$addFields` 阶段。
 * 返回类型用 mongoose 的 `PipelineStage.AddFields`，直接塞进 `aggregate([...])`
 * 不会触发 TS 的判别联合报错（用 Record<string, unknown> 会被要求带 `$unwind`）。
 */
export function articleDefaultsStage(): PipelineStage.AddFields {
  const fields: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(ARTICLE_AGG_DEFAULTS)) {
    fields[key] = { $ifNull: [`$${key}`, fallback] };
  }
  return { $addFields: fields } as PipelineStage.AddFields;
}
