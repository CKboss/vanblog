/**
 * 搜索的取数与降级编排（唯一一处会发请求的地方）。
 *
 * ## 懒加载 + 会话内缓存
 *
 * 索引文件是**每个打开搜索的访客都要下载**的东西，所以：
 *  - **不在模块顶层 fetch**（那会让 `/search` 页一挂载就下载，哪怕用户根本没输入）；
 *    也不放进 `getStaticProps`（那会让它进 `__NEXT_DATA__`，等于把整份索引塞进每个页面的
 *    HTML —— §7.42 修掉的正是这一类"白送的字节"，而且 ISR 缓存的页面会拿着一份越来越旧的索引）；
 *  - 第一次真的要搜的时候才取，取到之后**在内存里缓存整个会话**（单页应用里翻页/改词都不重取）；
 *  - **失败只缓存 60 秒**：全新安装的站点第一次生成索引可能就在几分钟内，
 *    把"取不到"缓存整个会话等于让那位访客一直走慢的服务端路径。
 */

import {
  SEARCH_INDEX_URL,
  SearchBackend,
  SearchIndexFile,
  SearchIndexLoadResult,
  decideSearchBackend,
  parseSearchIndexText,
  serverSearchUrl,
  staleIndexNotice,
  truncatedIndexNotice,
} from "../utils/searchIndex";
import {
  IndexSearchOutcome,
  RankedDoc,
  rankServerResults,
  searchIndexDocs,
} from "../utils/searchRank";
import { searchArticles } from "./search";

/** 失败结果的缓存时长：让"索引刚生成好"能自己被发现 */
export const SEARCH_INDEX_RETRY_MS = 60 * 1000;

/** 索引请求的超时：宁可早点退回服务端搜索，也不要让用户对着"搜索中..."等 30 秒 */
export const SEARCH_INDEX_TIMEOUT_MS = 8000;

export interface SearchExecution {
  /** 这次结果实际是哪条路给的 */
  backend: SearchBackend;
  /** 面向用户的一句话：走索引且一切正常时是空串 */
  notice: string;
  /** 走索引时给出的补充提示（truncated / 陈旧），服务端路径为空 */
  indexNotices: string[];
  results: RankedDoc[];
  matched: number;
  capped: boolean;
  terms: string[];
  index?: SearchIndexFile;
}

/** 最小 fetch 接口，便于在单测里注入而不去动全局 */
export type FetchLike = (
  url: string,
  init?: { signal?: unknown; cache?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

type CacheEntry = { at: number; result: SearchIndexLoadResult };

let cache: CacheEntry | null = null;
let inflight: Promise<SearchIndexLoadResult> | null = null;
/**
 * "走过哪条路"的账本。
 *
 * ⚠️ 存在的理由：**静默降级是一个功能烂掉的方式**。索引 404 了半年、搜索看起来还能用，
 * 没人会去查。所以每次搜索都记一笔（最多留最近 20 条），结果页把当前这一笔显示出来，
 * 单测也直接读它（`__tests__/searchIndex.spec.ts`）。
 */
const pathLog: Array<{ at: number; query: string; backend: SearchBackend; reason: string }> = [];
const PATH_LOG_MAX = 20;

export function resetSearchIndexCache(): void {
  cache = null;
  inflight = null;
  pathLog.length = 0;
}

export function searchPathLog(): ReadonlyArray<{
  at: number;
  query: string;
  backend: SearchBackend;
  reason: string;
}> {
  return pathLog;
}

function remember(query: string, backend: SearchBackend, reason: string): void {
  pathLog.push({ at: Date.now(), query, backend, reason });
  if (pathLog.length > PATH_LOG_MAX) {
    pathLog.shift();
  }
  // 只在"降级"时说一声：正常走索引不该刷屏
  if (backend === "server" && typeof console !== "undefined") {
    // eslint-disable-next-line no-console
    console.info(`[search] 走服务端搜索：${reason}`);
  }
}

/**
 * 取索引（懒加载 + 会话缓存 + 并发去重 + 超时）。
 * **永远不抛**：失败也返回一个带原因的 `SearchIndexLoadResult`，由调用方决定降级。
 */
export async function loadSearchIndex(
  fetchImpl?: FetchLike,
): Promise<SearchIndexLoadResult> {
  const now = Date.now();
  if (cache) {
    const fresh = cache.result.ok || now - cache.at < SEARCH_INDEX_RETRY_MS;
    if (fresh) {
      return cache.result;
    }
    cache = null;
  }
  if (inflight) {
    return inflight;
  }
  const doFetch = fetchImpl || ((globalThis as any).fetch as FetchLike);
  if (typeof doFetch !== "function") {
    const result: SearchIndexLoadResult = {
      ok: false,
      reason: "network",
      detail: "运行环境没有 fetch",
    };
    cache = { at: now, result };
    return result;
  }
  inflight = (async () => {
    let result: SearchIndexLoadResult;
    try {
      const controller =
        typeof AbortController === "function" ? new AbortController() : undefined;
      const timer = controller
        ? setTimeout(() => controller.abort(), SEARCH_INDEX_TIMEOUT_MS)
        : undefined;
      try {
        const res = await doFetch(SEARCH_INDEX_URL, {
          signal: controller?.signal,
          // 索引由 ISR 风暴重新生成，不该被浏览器长期钉死；交给静态层的 Cache-Control
          cache: "no-cache",
        });
        const text = await res.text();
        if (res.status === 404) {
          result = { ok: false, reason: "missing", detail: `HTTP 404（${SEARCH_INDEX_URL}）` };
        } else if (!res.ok) {
          result = { ok: false, reason: "http", detail: `HTTP ${res.status}` };
        } else {
          result = parseSearchIndexText(text, text ? text.length : 0);
        }
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      result = {
        ok: false,
        reason: "network",
        detail: (err as Error)?.message || String(err),
      };
    }
    cache = { at: Date.now(), result };
    inflight = null;
    return result;
  })();
  return inflight;
}

export interface RunSearchOptions {
  fetchImpl?: FetchLike;
  /** 单测用：跳过索引，强制走服务端（负控） */
  forceBackend?: SearchBackend;
}

/**
 * 跑一次搜索。
 *
 * 决策：**先试索引，索引不可用就退回服务端 `/api/public/search`**（矩阵见
 * `utils/searchIndex.ts` 的 `decideSearchBackend`）。两条路都失败才抛 —— 那时
 * 调用方显示"搜索失败，请稍后再试"，与"暂无结果"区分开（SearchCard 早就吃过这个亏）。
 */
export async function runSearch(
  query: string,
  options: RunSearchOptions = {},
): Promise<SearchExecution> {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) {
    return {
      backend: "index",
      notice: "",
      indexNotices: [],
      results: [],
      matched: 0,
      capped: false,
      terms: [],
    };
  }

  if (options.forceBackend !== "server") {
    const load = await loadSearchIndex(options.fetchImpl);
    const decision = decideSearchBackend(load);
    if (decision.backend === "index" && load.ok) {
      const outcome: IndexSearchOutcome = searchIndexDocs(load.index.docs, trimmed);
      const notices = [truncatedIndexNotice(load.index), staleIndexNotice(load.index)].filter(
        (n) => Boolean(n),
      );
      remember(trimmed, "index", "");
      return {
        backend: "index",
        notice: "",
        indexNotices: notices,
        results: outcome.results,
        matched: outcome.matched,
        capped: outcome.capped,
        terms: outcome.terms,
        index: load.index,
      };
    }
    // 索引不可用：如实记下原因，然后降级
    return serverFallback(trimmed, decision.reason);
  }
  return serverFallback(trimmed, "调用方要求直接走服务端搜索");
}

async function serverFallback(query: string, reason: string): Promise<SearchExecution> {
  try {
    const items = await searchArticles(query);
    const outcome = rankServerResults(items, query);
    remember(query, "server", reason);
    return {
      backend: "server",
      notice: reason,
      indexNotices: [],
      results: outcome.results,
      matched: outcome.matched,
      capped: outcome.capped,
      terms: outcome.terms,
    };
  } catch (err) {
    remember(query, "server", `${reason}；服务端搜索也失败了`);
    throw err;
  }
}

/**
 * "全文搜索"出口的地址。
 *
 * ⚠️ 这个出口不是装饰：索引里只有**标题 + 标签 + 分类 + ≤200 字摘要**，
 * 而服务端 `searchByString` 是在**整篇正文**上做 `$regex` 的。所以"只在正文深处出现过一次"
 * 的词，客户端索引结构上就搜不到（索引里不放全文是刻意的：第四轮审计量过
 * 列表接口下发正文是 1.69 MB/请求 的放大器）。这个链接让用户能自己走到全文那一条路上。
 */
export function fullTextSearchUrl(query: string): string {
  return serverSearchUrl(query);
}
