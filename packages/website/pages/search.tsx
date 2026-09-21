import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useDebounce } from "react-use";

import AuthorCard, { AuthorCardProps } from "../components/AuthorCard";
import Layout from "../components/Layout";
import SearchResults from "../components/SearchResults";
import { getPublicMeta } from "../api/getAllData";
import { SearchExecution, runSearch } from "../api/searchIndex";
import { getAuthorCardProps, getLayoutProps, LayoutProps } from "../utils/getLayoutProps";
import { revalidate } from "../utils/loadConfig";
import { readSearchQueryParams, searchPageUrl } from "../utils/searchUrls";
import { displayQuery } from "../utils/searchHighlight";

/**
 * `/search` —— 全站搜索结果页。
 *
 * ## 为什么它是一个 ISR 静态壳，而不是 `getServerSideProps`
 *
 * 这一页的 HTML 里**不含任何搜索结果**：`getStaticProps` 只取布局数据（与其它页面同一套
 * `getPublicMeta` + `getLayoutProps`），搜索在浏览器里对着静态索引做。理由：
 *  - 查询词在构建期不可知，`getStaticProps` 拿不到 `?q=`（pages router 的静态页没有 query）；
 *  - 换成 `getServerSideProps` 就等于把"每次搜索都在 website 的 Node 进程里渲染一页 +
 *    回调 server 的公开接口"重新装回来 —— 而这一轮的全部意义就是把搜索的**数据库成本降到 0**
 *    （`/api/public/search` 是匿名接口，每次按键一轮全表 `$regex` 扫描）；
 *  - 静态壳还能被 caddy / CDN 缓存，与 `/about`、`/timeline` 一个待遇。
 *
 * ## 索引为什么不在 `getStaticProps` 里取
 *
 * 两个理由，都是本仓库踩过的坑：
 *  1. 塞进 pageProps 就会进 `__NEXT_DATA__`，等于让**每个**打开这一页的人下载一整份索引
 *     （§7.42 修掉的正是"列表页把全文塞进 __NEXT_DATA__"这一类白送的字节）；
 *  2. ISR 缓存的页面会拿着一份**构建那一刻**的索引，比浏览器懒加载更旧。
 * 所以索引是**懒加载**的：第一次真的要搜的时候才 `fetch('/static/search/index.json')`，
 * 然后在内存里缓存整个会话（见 `api/searchIndex.ts`）。
 *
 * ## 没有 JS 的时候
 *
 * 这一页不会是一块空白矩形：`<noscript>` 里给了一个**真的 GET 表单**指向
 * `/api/public/search?value=…`（服务端那条路，返回 JSON）。
 * ⚠️ 这里刻意**没有**在 `getStaticProps` 里服务端渲染"前 N 篇"：那既回答不了用户的查询
 * （构建期不知道 q），又会把一份与查询无关的文章列表塞进每个访客的 HTML —— 是白送的字节。
 * 诚实的做法是给出一个能用的出口，并说清楚它返回的是 JSON。
 */
export interface SearchPageProps {
  layoutProps: LayoutProps;
  authorCardProps: AuthorCardProps;
}

interface SearchState {
  /** 已经执行过搜索的查询词（与 URL 的 q 同步） */
  query: string;
  loading: boolean;
  failed: boolean;
  execution: SearchExecution | null;
}

const IDLE_STATE: SearchState = {
  query: "",
  loading: false,
  failed: false,
  execution: null,
};

export default function SearchPage(props: SearchPageProps) {
  const router = useRouter();
  const ready = router.isReady;
  const { q, page } = readSearchQueryParams(router.query);
  const [input, setInput] = useState("");
  const [state, setState] = useState<SearchState>(IDLE_STATE);

  // URL → 输入框。只在 router 就绪后做（静态页首次客户端渲染时 router.query 还是 {}）
  useEffect(() => {
    if (ready) {
      setInput(q);
    }
  }, [ready, q]);

  // 输入框 → URL（防抖，`shallow` 所以不会整页刷新、也不会重新拉 pageProps）
  useDebounce(
    () => {
      if (!ready) {
        return;
      }
      const next = input.trim();
      if (next === q) {
        return;
      }
      router.replace(searchPageUrl(next, 1), undefined, { shallow: true });
    },
    300,
    [input, ready, q],
  );

  // URL → 搜索。`page` 故意不在依赖里：翻页是纯客户端的切片，不该重新搜一遍。
  useEffect(() => {
    if (!ready) {
      return;
    }
    const term = q.trim();
    if (!term) {
      setState(IDLE_STATE);
      return;
    }
    let cancelled = false;
    setState({ query: term, loading: true, failed: false, execution: null });
    runSearch(term).then(
      (execution) => {
        // 过期响应守卫：慢的旧响应后到会盖掉新结果（SearchCard 里同一条纪律）
        if (cancelled) {
          return;
        }
        setState({ query: term, loading: false, failed: false, execution });
      },
      () => {
        if (cancelled) {
          return;
        }
        setState({ query: term, loading: false, failed: true, execution: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ready, q]);

  const onSubmit = useCallback(
    (event: React.FormEvent) => {
      // 表单只是为了"回车能提交"与无 JS 时的语义；有 JS 时走 shallow 路由，不整页刷新
      event.preventDefault();
      const next = input.trim();
      router.replace(searchPageUrl(next, 1), undefined, { shallow: true });
    },
    [input, router],
  );

  const execution = state.execution;
  const shown = displayQuery(state.query || q);

  return (
    <Layout
      title={shown ? `搜索：${shown}` : "搜索"}
      option={props.layoutProps}
      sideBar={<AuthorCard option={props.authorCardProps} />}
    >
      <div className="bg-white card-shadow dark:bg-dark dark:card-shadow-dark py-4 px-6 md:py-6 md:px-8">
        <h1 className="text-2xl md:text-3xl text-gray-700 text-center dark:text-dark">搜索</h1>
        <p className="text-center text-gray-500 text-sm mt-2 mb-5 font-light dark:text-dark-400">
          标题、标签、分类与摘要；子串匹配，不做模糊与纠错
        </p>

        <form onSubmit={onSubmit} role="search" action="/search" method="get">
          {/* 输入框必须有真实 label（读屏软件念的就是它）；用 sr-only 藏起来但保留可访问名 */}
          <label htmlFor="vanblog-search-input" className="sr-only">
            搜索文章
          </label>
          <div className="flex items-center gap-2 border border-gray-200 dark:border-dark-2 rounded-lg px-3 py-2">
            <input
              id="vanblog-search-input"
              name="q"
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              placeholder="输入关键词，回车搜索"
              className="w-full bg-transparent outline-none border-none text-base text-gray-800 dark:text-dark"
            />
            <button
              type="submit"
              className="flex-none text-sm px-3 py-1 rounded border border-gray-200 dark:border-dark-2 text-gray-600 dark:text-dark hover:border-gray-400"
            >
              搜索
            </button>
          </div>
        </form>

        <div className="mt-6">
          <SearchResults
            query={shown}
            page={page}
            results={execution?.results ?? []}
            matched={execution?.matched ?? 0}
            capped={execution?.capped ?? false}
            backend={execution?.backend ?? "index"}
            notice={execution?.notice ?? ""}
            indexNotices={execution?.indexNotices ?? []}
            loading={state.loading}
            failed={state.failed}
            idle={!state.loading && !state.failed && !state.query}
            openInNewWindow={props.layoutProps.openArticleLinksInNewWindow == "true"}
            pageHref={(next) => searchPageUrl(state.query || q, next)}
            // 跳页走浅路由：不整页刷新，也就不会重新拉索引、重新搜一遍 —— 上面那个搜索
            // effect 刻意不把 page 放进依赖（翻页是纯客户端切片），这里保持同一个性质，
            // 手法与本文件 :152 那个查询表单一致（preventDefault + shallow replace）。
            // ⚠️ 不传这个回调也不会坏：跳转控件是完整的原生 GET 表单，浏览器会自己提交。
            onJumpHref={(href) => {
              void router.replace(href, undefined, { shallow: true });
            }}
          />
        </div>

        {/* 无 JS：给一个能用的出口，并如实说明它返回 JSON */}
        <noscript>
          <div className="mt-6 border-t border-gray-200 dark:border-dark-2 pt-4">
            <p className="text-sm text-gray-600 dark:text-dark-400">
              当前浏览器没有启用 JavaScript，这一页的搜索需要它。可以直接用服务端搜索接口：
            </p>
            <form method="get" action="/api/public/search" className="mt-2 flex gap-2">
              <label htmlFor="vanblog-search-noscript" className="text-sm text-gray-600 dark:text-dark-400">
                关键词
              </label>
              <input
                id="vanblog-search-noscript"
                name="value"
                type="search"
                className="flex-grow border border-gray-200 dark:border-dark-2 rounded px-2 py-1 bg-transparent text-gray-800 dark:text-dark"
              />
              <button
                type="submit"
                className="text-sm px-3 py-1 rounded border border-gray-200 dark:border-dark-2 text-gray-600 dark:text-dark"
              >
                搜索（返回 JSON）
              </button>
            </form>
          </div>
        </noscript>
      </div>
    </Layout>
  );
}

/**
 * 与 `/about`、`/timeline` 同一套约定：`getPublicMeta()` 自带 `isBuild=t` 的构建期兜底
 * （AGENTS §7.23），所以镜像构建时连不上 server 也不会让 `next build` 挂掉。
 *
 * ⚠️ 这里刻意不去 `utils/getPageProps.ts` 里加 `getSearchPageProps`：那个文件本轮归
 * 另一个 agent 管，而这一页需要的两行 helper 调用直接写在页面里同样清楚。
 */
export async function getStaticProps(): Promise<{
  props: SearchPageProps;
  revalidate?: number;
}> {
  const data = await getPublicMeta();
  return {
    props: {
      layoutProps: getLayoutProps(data),
      authorCardProps: getAuthorCardProps(data),
    },
    ...revalidate,
  };
}
