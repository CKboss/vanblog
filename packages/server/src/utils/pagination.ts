/**
 * Query-string page/pageSize can become NaN, Infinity, or overflow after a
 * proxy/CDN mangles them. Mongo skip is an int64 and rejects negatives;
 * NaN is serialized as Int64.MIN (−9223372036854775808).
 *
 * pageSize −1 keeps the existing “return all rows” meaning used by public
 * category/tag pages.
 */
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 5;
export const MAX_PAGE_SIZE = 100;
export const UNLIMITED_PAGE_SIZE = -1;

export type Pagination = {
  page: number;
  pageSize: number;
  skip: number;
};

export type SanitizePaginationOptions = {
  defaultPage?: number;
  defaultPageSize?: number;
  maxPageSize?: number;
  /** Keep pageSize −1 as “return all” (public category/tag lists). */
  allowUnlimited?: boolean;
};

export function coerceFiniteInt(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return Math.trunc(parsed);
  }
  return null;
}

export function sanitizePagination(
  page: unknown,
  pageSize: unknown,
  options: SanitizePaginationOptions = {},
): Pagination {
  const defaultPage = options.defaultPage ?? DEFAULT_PAGE;
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const maxPageSize = options.maxPageSize ?? MAX_PAGE_SIZE;

  const rawPageSize = coerceFiniteInt(pageSize);
  let safePageSize: number;
  if (options.allowUnlimited && rawPageSize === UNLIMITED_PAGE_SIZE) {
    safePageSize = UNLIMITED_PAGE_SIZE;
  } else if (rawPageSize === null || rawPageSize < 1) {
    safePageSize = defaultPageSize;
  } else {
    safePageSize = Math.min(rawPageSize, maxPageSize);
  }

  const rawPage = coerceFiniteInt(page);
  let safePage = rawPage === null || rawPage < 1 ? defaultPage : rawPage;

  let skip = 0;
  if (safePageSize !== UNLIMITED_PAGE_SIZE) {
    const maxPage = Math.floor(Number.MAX_SAFE_INTEGER / safePageSize) + 1;
    if (safePage > maxPage) {
      safePage = maxPage;
    }
    skip = (safePage - 1) * safePageSize;
    if (!Number.isFinite(skip) || skip < 0) {
      skip = 0;
      safePage = defaultPage;
    }
  }

  return { page: safePage, pageSize: safePageSize, skip };
}

/**
 * 「要多少条 / 多少天」这类**数量参数**的清洗（后台仪表盘的 `overviewDataNum`、
 * `viewerDataNum`、`articleTabDataNum`，以及其它同类 query 参数）。
 *
 * 为什么不能直接把 `parseInt(query)` 交给业务代码：
 *  - `?overviewDataNum=abc` → NaN → `for (let i = NaN; i >= 0; i--)` 一次都不跑 →
 *    接口回 200 + **一整屏 0**，看起来像"站点没有访问量"（错误与空结果无法区分）；
 *  - `?overviewDataNum=999999999` → 那个循环会先 `push` 十亿个日期字符串，
 *    再把十亿元素的 `$in` 发给 Mongo ⇒ 单次请求把常驻进程的堆吃光（OOM 是整进程一起死）。
 *
 * 所以：非法值（NaN / 负数 / 非数字 / 无穷）回落 `fallback`，合法值夹到 `[0, max]`。
 * `0` 是合法的（"只看今天"），与 `sanitizePagination` 里 `pageSize` 的语义不同。
 */
export const MAX_DATA_NUM = 3650;

export function sanitizeDataNum(value: unknown, fallback: number, max: number = MAX_DATA_NUM): number {
  const n = coerceFiniteInt(value);
  if (n === null || n < 0) {
    return fallback;
  }
  return Math.min(n, max);
}
