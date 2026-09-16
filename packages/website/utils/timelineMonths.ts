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

function sortByCreatedAtDesc<T extends TimelineArticleLike>(articles: T[]): T[] {
  return [...articles].sort((prev, next) => {
    const prevTime = new Date(prev.createdAt).getTime();
    const nextTime = new Date(next.createdAt).getTime();
    const safePrev = Number.isNaN(prevTime) ? 0 : prevTime;
    const safeNext = Number.isNaN(nextTime) ? 0 : nextTime;
    return safeNext - safePrev;
  });
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
          articles: sortByCreatedAtDesc(monthArticles),
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
