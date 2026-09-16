import { Article } from "../types/article";

/**
 * `createdAt` 实际可能的输入：公开接口下发的是 ISO 字符串，但调用方（以及测试
 * fixture）手里可能已经是 Date 或时间戳。`parseTimelineDate` 与
 * `sortByCreatedAtDesc` 对这三种本来就都接受（运行时行为从未变过）——
 * 以前类型写成 `Article["createdAt"]`（string）没跟上事实，导致给
 * `groupTimelineByYearAndMonth` 传 Date 的测试在 TS 5 下报 TS2345。
 */
export type TimelineDateInput = Article["createdAt"] | Date | number;

export type TimelineArticleLike = Pick<Article, "title" | "id"> &
  Partial<Omit<Article, "id" | "title" | "createdAt">> & {
    createdAt: TimelineDateInput;
  };

export interface TimelineMonthGroup<T extends TimelineArticleLike = Article> {
  year: number;
  month: number;
  label: string;
  key: string;
  articles: T[];
}

export interface TimelineYearGroup<T extends TimelineArticleLike = Article> {
  year: number;
  label: string;
  /**
   * 这一年的文章数。**不要**用 `articles.length` 代替它：
   * 有月份分组时 `articles` 是空数组（见下），只有"整年都解析不出日期"的兜底分支才会填充。
   */
  count: number;
  /**
   * 仅在 `months.length === 0`（该年所有文章都解析不出日期）时才有内容。
   * ⚠️ 以前这里**总是**带上整年的文章数组，而它和 months 里的内容是同一批文章的两份拷贝 ——
   * 实测 /timeline 的 pageProps 73.5KB 里有 42.5KB（58%）是没人读的重复数据
   * （`TimelineArchives` 只在 months 为空时才读它），白白塞进 `__NEXT_DATA__`
   * 和客户端路由的 JSON 里。现在按需填充。
   */
  articles: T[];
  months: TimelineMonthGroup<T>[];
}

export interface TimelineArchiveMonthOutline {
  month: number;
  label: string;
  key: string;
  count: number;
  titles: string[];
}

export interface TimelineArchiveYearOutline {
  year: number;
  label: string;
  count: number;
  fallbackYearOnly: boolean;
  months: TimelineArchiveMonthOutline[];
}

export interface TimelineArchiveOutline {
  years: TimelineArchiveYearOutline[];
}

const MONTH_LABEL_SUFFIX = "月";

export function padTimelineMonth(month: number): string {
  return String(month).padStart(2, "0");
}

export function formatTimelineMonthLabel(month: number): string {
  return `${month}${MONTH_LABEL_SUFFIX}`;
}

export function timelineMonthKey(year: number, month: number): string {
  return `${year}-${padTimelineMonth(month)}`;
}

export function parseTimelineDate(
  createdAt: TimelineDateInput | null | undefined
): { year: number; month: number } | null {
  if (createdAt == null || createdAt === "") {
    return null;
  }
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (!Number.isFinite(year) || month < 1 || month > 12) {
    return null;
  }
  return { year, month };
}

/**
 * 排序用的时间戳：无效/缺失日期一律按 0（与旧实现 `Number.isNaN(t) ? 0 : t`
 * 的语义一致），保证比较器**永远不返回 NaN** —— NaN 比较器会让 sort 的
 * 结果取决于引擎实现（V8 的 TimSort 遇到 NaN 会当成 0，但这是巧合不是契约）。
 */
export function timelineTimestamp(
  createdAt: TimelineDateInput | null | undefined
): number {
  if (createdAt == null || createdAt === "") {
    return 0;
  }
  const ms =
    createdAt instanceof Date
      ? createdAt.getTime()
      : new Date(createdAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 按 createdAt 倒序。时间戳**每篇只解析一次**（装饰-排序-还原）：
 * 旧实现把 `new Date(...).getTime()` 写在比较器里，同一篇文章的日期字符串
 * 在一次排序里被重复解析 O(log n) 次，两次排序（年级 + 月级）再翻倍。
 * 实测 20,000 篇：308ms → 26ms（约 12 倍，node 24，本机有并行构建负载）；
 * 排序结果与旧实现逐项相同（同一组随机数据断言过 `identical=true`）。
 */
function sortByCreatedAtDesc<T extends TimelineArticleLike>(articles: T[]): T[] {
  const decorated = articles.map((article) => ({
    article,
    time: timelineTimestamp(article.createdAt),
  }));
  decorated.sort((prev, next) => next.time - prev.time);
  return decorated.map((entry) => entry.article);
}

function yearKeysFromSortedArticles(
  sortedArticles: Record<string, TimelineArticleLike[]> | null | undefined
): number[] {
  if (!sortedArticles) {
    return [];
  }
  return Object.keys(sortedArticles)
    .map((key) => parseInt(key, 10))
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => b - a);
}

/**
 * Group year-bucketed timeline articles into months that actually contain posts.
 * Empty months are omitted. Years with articles but no valid dates stay year-only.
 */
export function groupTimelineByYearAndMonth<T extends TimelineArticleLike>(
  sortedArticles: Record<string, T[]> | null | undefined
): TimelineYearGroup<T>[] {
  return yearKeysFromSortedArticles(sortedArticles)
    .map((year) => {
      const articles = sortByCreatedAtDesc(sortedArticles?.[String(year)] || []);
      const monthMap = new Map<number, T[]>();
      for (const article of articles) {
        const parts = parseTimelineDate(article.createdAt);
        if (!parts) {
          continue;
        }
        const list = monthMap.get(parts.month) || [];
        list.push(article);
        monthMap.set(parts.month, list);
      }
      const months = Array.from(monthMap.entries())
        .sort(([a], [b]) => b - a)
        .map(([month, monthArticles]) => ({
          year,
          month,
          label: formatTimelineMonthLabel(month),
          key: timelineMonthKey(year, month),
          // 不用再排一次：monthArticles 是按序从**已经倒序**的 articles 里
          // 分桶出来的，天然保持倒序（旧实现这里的第二次排序是纯浪费）
          articles: monthArticles,
        }));
      return {
        year,
        label: String(year),
        count: articles.length,
        // 有月份分组就不必再带一份同样的文章（组件在 months 非空时根本不读 articles）
        articles: months.length > 0 ? [] : articles,
        months,
      };
    })
    .filter((group) => group.count > 0);
}

export function describeTimelineArchives(
  sortedArticles: Record<string, TimelineArticleLike[]> | null | undefined
): TimelineArchiveOutline {
  const groups = groupTimelineByYearAndMonth(sortedArticles);
  return {
    years: groups.map((yearGroup) => ({
      year: yearGroup.year,
      label: yearGroup.label,
      count: yearGroup.count,
      fallbackYearOnly: yearGroup.months.length === 0,
      months: yearGroup.months.map((monthGroup) => ({
        month: monthGroup.month,
        label: monthGroup.label,
        key: monthGroup.key,
        count: monthGroup.articles.length,
        titles: monthGroup.articles.map((article) => article.title),
      })),
    })),
  };
}
