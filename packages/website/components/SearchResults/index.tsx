import Link from "next/link";
import { FormEvent, ReactNode, useState } from "react";
import {
  SEARCH_MAX_RESULTS,
  SEARCH_RESULTS_PER_PAGE,
  SearchBackend,
  serverSearchUrl,
} from "../../utils/searchIndex";
import { RankedDoc, TIER_TAG_OR_CATEGORY, TIER_TITLE, paginate } from "../../utils/searchRank";
import { snippetWindow } from "../../utils/searchHighlight";
import { getTarget } from "../Link/tools";
import { renderHighlighted } from "./highlight";
import {
  SEARCH_JUMP_QUERY_PARAM,
  describeSearchJumpForm,
  handleSearchJumpSubmit,
} from "./jumpForm";

/**
 * `/search` 结果页的结果区。
 *
 * 设计约束（每一条都对应需求里的一句"必须"）：
 *  - **结果链接是真链接**（`next/link` → `<a href>`），不是 `onClick` 的 div：
 *    键盘能 Tab 到、能中键新开、能被读屏软件念出来、没有 JS 也能看出这是一篇文章的入口。
 *  - **结果区有 `aria-live`**：改词之后读屏软件会念出"找到 N 条结果"，
 *    而不是安静地把列表换掉。
 *  - **降级要说出来**（`notice`）：走的是静态索引还是服务端接口，用户看得见；
 *    静默降级是功能烂掉的方式。
 *  - **命中上限要说出来**（`capped`）：中文单字查询（"的"）会命中几乎整个语料库，
 *    与其渲染 2000 张卡片，不如显示前 200 条并让人加词。
 *  - **高亮只用 React 子节点**（见 ./highlight.tsx），全文件没有 `dangerouslySetInnerHTML`。
 *  - **能点下一页的地方就能输页码**（站长的硬要求）：分页那一行除了上一页/下一页，
 *    还有一个真的 GET 表单可以跳到任意页（见 ./jumpForm.ts，那里写清了为什么是 GET 表单
 *    而不是复用 `PageNavJump`、为什么页码参数叫 `p`、以及隐藏 `q` 为什么不能用 `props.query`）。
 */
export interface SearchResultsProps {
  query: string;
  page: number;
  results: RankedDoc[];
  matched: number;
  capped: boolean;
  backend: SearchBackend;
  /** 降级原因（走索引且正常时为空串） */
  notice: string;
  /** 索引侧的补充提示：truncated / 陈旧 */
  indexNotices: string[];
  loading: boolean;
  failed: boolean;
  /** 用户还没有输入过任何查询 */
  idle: boolean;
  perPage?: number;
  openInNewWindow: boolean;
  /** 生成第 N 页的 href（把页码留在 URL 里，翻页可分享、可后退） */
  pageHref: (page: number) => string;
  /**
   * 有 JS 时跳页走这里（`pages/search.tsx` 传的是浅路由，于是不整页刷新、也不重新搜索）。
   *
   * ⚠️ **刻意是可选的**：不传时跳转表单**不拦截**提交，浏览器做原生 GET 提交，URL 依然是对的。
   * 这样 ①既有调用方与测试不会因为新增必填 prop 而打红；②这个控件不会退化成
   * "只有 onClick 的壳"—— 原生表单语义始终在 HTML 里。
   */
  onJumpHref?: (href: string) => void;
}

export default function SearchResults(props: SearchResultsProps) {
  const perPage = props.perPage || SEARCH_RESULTS_PER_PAGE;
  const pagination = paginate(props.results || [], props.page, perPage);
  const statusText = buildStatusText(props, pagination.total, pagination.totalPages);

  return (
    <div>
      {/* aria-live 的那一行：结果换了就读出来。role="status" 隐含 aria-live="polite" */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-sm text-gray-500 dark:text-dark-400 mb-3"
        data-testid="search-status"
      >
        {statusText}
      </p>

      {props.notice ? (
        <p className="text-xs text-gray-500 dark:text-dark-400 mb-3 vanblog-search-notice">
          {props.notice}
          {" · "}
          <a
            className="underline"
            href={serverSearchUrl(props.query)}
            rel="noreferrer"
            target="_blank"
          >
            服务端全文搜索
          </a>
        </p>
      ) : null}

      {props.indexNotices && props.indexNotices.length ? (
        <ul className="text-xs text-gray-500 dark:text-dark-400 mb-3 list-disc pl-5">
          {props.indexNotices.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}

      {props.capped ? (
        <p className="text-xs text-gray-500 dark:text-dark-400 mb-3" data-testid="search-capped">
          {`匹配到 ${props.matched} 篇，超过上限 ${SEARCH_MAX_RESULTS} 篇：显示前 ${SEARCH_MAX_RESULTS} 条，请增加关键词`}
        </p>
      ) : null}

      {props.loading ? (
        <p className="mt-10 text-center text-gray-500 dark:text-dark-400">搜索中…</p>
      ) : props.failed ? (
        <p className="mt-10 text-center text-gray-500 dark:text-dark-400">
          搜索失败，请稍后再试
        </p>
      ) : props.idle ? (
        <p className="mt-10 text-center text-gray-500 dark:text-dark-400">
          输入关键词开始搜索（标题、标签、分类与摘要；正文深处的词请用服务端全文搜索）
        </p>
      ) : pagination.items.length === 0 ? (
        <p className="mt-10 text-center text-gray-500 dark:text-dark-400">
          没有找到与「{props.query}」相关的文章
        </p>
      ) : (
        <ol className="space-y-4" aria-label="搜索结果">
          {pagination.items.map((hit) => (
            <li key={`${hit.doc.id}-${hit.doc.u}`}>
              <Link
                href={hit.doc.u}
                target={getTarget(props.openInNewWindow)}
                className="block group"
                data-search-tier={hit.tier}
              >
                <h2 className="text-lg md:text-xl text-gray-800 dark:text-dark group-hover:text-gray-950 dark:group-hover:text-white">
                  {renderHighlighted(hit.doc.t, props.query)}
                </h2>
                {hit.doc.s ? (
                  <p className="mt-1 text-sm text-gray-600 dark:text-dark-400 leading-relaxed line-clamp-2">
                    {renderHighlighted(snippetWindow(hit.doc.s, props.query), props.query)}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-gray-400 dark:text-dark-400">
                  {metaLine(hit, props.query)}
                </p>
              </Link>
            </li>
          ))}
        </ol>
      )}

      {pagination.totalPages > 1 ? (
        <nav className="mt-6 flex flex-wrap items-center gap-2" aria-label="搜索结果分页">
          {pagination.page > 1 ? (
            <PageLink href={props.pageHref(pagination.page - 1)} label="上一页" />
          ) : null}
          <span className="text-sm text-gray-500 dark:text-dark-400">
            {`${pagination.page} / ${pagination.totalPages}`}
          </span>
          {pagination.page < pagination.totalPages ? (
            <PageLink href={props.pageHref(pagination.page + 1)} label="下一页" />
          ) : null}
          <SearchJumpForm
            total={pagination.total}
            perPage={pagination.perPage}
            totalPages={pagination.totalPages}
            pageHref={props.pageHref}
            onJumpHref={props.onJumpHref}
          />
        </nav>
      ) : null}
    </div>
  );
}

function PageLink(props: { href: string; label: string }) {
  return (
    <Link
      href={props.href}
      className="text-sm px-3 py-1 rounded border border-gray-200 dark:border-dark-2 text-gray-600 dark:text-dark hover:border-gray-400"
    >
      {props.label}
    </Link>
  );
}

/**
 * 「输入页码跳转」——搜索结果页原本只有上一页/下一页，这是站长点名要补的那一个控件。
 *
 * 🔴 它是一个**完整可用的原生 GET 表单**：有 `method="get"`、有 `action`、页码 input 有 `name`、
 * 还有一个带 `name` 的隐藏 `q`。所以**即使一行 JS 都不执行，浏览器提交它也会得到正确的
 * `/search?q=…&p=N`**（与上一页/下一页链接同一个 URL 形状，可分享、可后退）。
 * 有 JS 时 `onSubmit` 拦下原生提交改走浅路由，于是不整页刷新、也不会重新搜一遍
 * （`pages/search.tsx` 刻意让翻页不进搜索 effect 的依赖，这里保持那个性质）。
 *
 * ⚠️ 判定、文案与参数名全部来自 `./jumpForm`（那边复用 `PageNav` 的 `parseJumpPage` 与
 * `shouldShowPageNavJump`，所以"什么算合法页码""单页不显示"这两条判据全站只有一份）。
 * ⚠️ 隐藏的 `q` 取自 `pageHref` 反解出来的**真实**查询词，**不是** `props.query` ——
 * 后者是 `displayQuery()` 截断过的展示形，用它会让长查询跳页时静默搜一个被截断的词。
 */
function SearchJumpForm(props: {
  total: number;
  perPage: number;
  totalPages: number;
  pageHref: (page: number) => string;
  onJumpHref?: (href: string) => void;
}) {
  // 输入框的原始文本。放在这个子组件里而不是 SearchResults 里，好让 SearchResults 保持
  // 无状态（既有测试用 renderToStaticMarkup 直接渲染它）。
  const [raw, setRaw] = useState("");
  const model = describeSearchJumpForm(props);
  if (!model.visible) {
    return null;
  }
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const navigate = props.onJumpHref;
    if (!navigate) {
      // 没有浅路由回调就**不拦截**：让浏览器做原生 GET 提交（URL 仍然是对的）。
      return;
    }
    handleSearchJumpSubmit(event, raw, model.totalPages, navigate, props.pageHref);
  };
  return (
    <form
      method={model.form.method}
      action={model.form.action}
      aria-label={model.labels.form}
      noValidate
      onSubmit={onSubmit}
      className="flex items-center gap-1"
      {...{ [model.form.attr]: "" }}
    >
      {model.target.query !== null ? (
        <input type="hidden" name={SEARCH_JUMP_QUERY_PARAM} value={model.target.query} />
      ) : null}
      <label
        htmlFor={model.input.id}
        className="text-sm text-gray-500 dark:text-dark-400"
      >
        {model.labels.prefix}
      </label>
      <input
        id={model.input.id}
        name={model.input.name}
        type={model.input.type}
        min={model.input.min}
        max={model.input.max}
        step={model.input.step}
        inputMode={model.input.inputMode}
        aria-label={model.labels.input}
        value={raw}
        onChange={(event) => setRaw(event.target.value)}
        className="w-16 text-sm px-2 py-1 rounded border border-gray-200 dark:border-dark-2 bg-transparent text-gray-700 dark:text-dark"
        {...{ [model.input.attr]: "" }}
      />
      <span aria-hidden="true" className="text-sm text-gray-500 dark:text-dark-400">
        {model.labels.unit}
      </span>
      <button
        type={model.submit.type}
        aria-label={model.submit.ariaLabel}
        className="text-sm px-3 py-1 rounded border border-gray-200 dark:border-dark-2 text-gray-600 dark:text-dark hover:border-gray-400"
      >
        {model.submit.label}
      </button>
    </form>
  );
}

/** 日期 · 分类 · 标签 · 字数（每一块都带高亮，因为分类与标签本身就是匹配面） */
function metaLine(hit: RankedDoc, query: string): ReactNode[] {
  const parts: ReactNode[] = [];
  if (hit.doc.d) {
    parts.push(<span key="d">{hit.doc.d}</span>);
  }
  const tierLabel =
    hit.tier === TIER_TITLE ? "标题命中" : hit.tier === TIER_TAG_OR_CATEGORY ? "标签/分类命中" : "摘要命中";
  parts.push(<span key="tier">{tierLabel}</span>);
  if (hit.doc.c) {
    parts.push(<span key="c">{renderHighlighted(hit.doc.c, query)}</span>);
  }
  for (const tag of (hit.doc.g || []).slice(0, 5)) {
    parts.push(<span key={`g-${tag}`}>{renderHighlighted(tag, query)}</span>);
  }
  if (hit.doc.w > 0) {
    parts.push(<span key="w">{`${hit.doc.w} 字`}</span>);
  }
  // 用 " · " 分隔，而不是把分隔符拼进各个片段里（拼进去会被当成可匹配的文本）
  const out: ReactNode[] = [];
  parts.forEach((part, index) => {
    if (index > 0) {
      out.push(<span key={`sep-${index}`}>{" · "}</span>);
    }
    out.push(part);
  });
  return out;
}

/** 状态行的文案：读屏软件念的就是这一句，所以要包含"用哪条路搜的" */
export function buildStatusText(
  props: Pick<SearchResultsProps, "query" | "loading" | "failed" | "idle" | "matched" | "backend">,
  total: number,
  totalPages: number,
): string {
  if (props.loading) {
    return "搜索中…";
  }
  if (props.failed) {
    return "搜索失败，请稍后再试";
  }
  if (props.idle) {
    return "请输入关键词";
  }
  if (!props.query) {
    return "请输入关键词";
  }
  const source = props.backend === "index" ? "静态索引" : "服务端搜索";
  if (total === 0) {
    return `没有找到与「${props.query}」相关的文章（来源：${source}）`;
  }
  return `找到 ${total} 条结果，共 ${totalPages} 页（来源：${source}）`;
}
