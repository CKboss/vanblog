import {
  PAGE_NAV_JUMP_GO_LABEL,
  PAGE_NAV_JUMP_INPUT_LABEL,
  PAGE_NAV_JUMP_LABEL,
  PAGE_NAV_JUMP_PREFIX,
  PAGE_NAV_JUMP_UNIT,
  parseJumpPage,
  shouldShowPageNavJump,
} from "../PageNav/jump";

/**
 * `/search` 结果页的「输入页码跳转」——**纯逻辑**部分（不含 React，便于单测）。
 *
 * ## 为什么是一个真的 GET 表单，而不是复用 `PageNavJump`
 *
 * 三条理由，都是读代码读出来的，不是风格偏好：
 *
 *  1. `PageNavJump`（`components/PageNav/render.tsx`）渲染的 `<form>` **没有 `method`、没有
 *     `action`，input 也没有 `name`**，跳转完全靠 `onSubmit` → `preventDefault()` → `router.push`。
 *     ⇒ 没有 JS 时它提交只会重载当前页（无 action 默认 GET 当前 URL，而没有 name 的 input
 *     不产生任何查询参数）。
 *  2. `resolvePageNavJump` 把 href 硬编码成 `pageHref(base, more, page)`，产出的是 `/page/N`
 *     —— 那是**文章列表**的 URL 形状，对搜索页是错的。复用就得改 `PageNav` 的既有行为，
 *     而它有 16 条测试钉着。
 *  3. 本文件所在的 `pages/search.tsx` 已经有同一个模式：查询表单就是
 *     `action="/search" method="get"` + `onSubmit` 里 `preventDefault()` 走 shallow 路由。
 *     跳转表单沿用同一形状，读代码的人只需要理解一种约定。
 *
 * ⚠️ **但不要因此声称"无 JS 也能翻页"**：这一页的 HTML 里根本不含搜索结果
 * （`getStaticProps` 只取布局数据，搜索是浏览器里对着懒加载的静态索引做的），页面自己就带
 * `<noscript>` 说明"这一页的搜索需要 JS"。所以 GET 表单的价值是**产出正确、可分享的 URL**
 * （无 JS 时用户至少落到对的 URL 与那个 noscript 出口，而不是原地不动），不是"无 JS 可用"。
 *
 * ## 两个必须记住的口径（都已用平价守卫钉住，见 `__tests__/searchJumpForm.spec.ts`）
 *
 *  - 🔴 页码参数名是 **`p`**，不是 `page`：`utils/searchUrls.ts` 的 `searchPageUrl` 产出
 *    `/search?q=<编码>&p=<n>`，`readSearchQueryParams` 读的也是 `query.p`。写成 `page`
 *    会**静默失效**（读不到 ⇒ 永远回落第 1 页 ⇒ "看着能跳、其实没跳"）。
 *  - 🔴 隐藏 `q` 字段必须带**真实**查询词，不能带 `SearchResultsProps.query`：后者是
 *    `displayQuery()` 的展示形，会 `slice(0, MAX_QUERY_CHARS)`。GET 提交会用表单字段
 *    **整体替换**查询串，所以拿展示形当值会让长查询跳页时去搜一个被截断的词 ⇒
 *    结果集不同 ⇒ **静默的错答案**。真实查询词从 `pageHref` 反解（它本来就是真实查询词
 *    流进这个组件的唯一通道），因此**结构上不可能与链接漂移**，也不需要新增必填 prop。
 *
 * ## 越界页码
 *
 * 与 `PageNavJump` 同口径：**拒绝**（不夹取、不导航）。⚠️ 原生提交（无 JS 拦截）时浏览器
 * 照样会带上越界的 `p`，那时由 `utils/searchRank.ts` 的 `paginate()` 既有的**夹取**兜底
 * （它还会返回 `clamped`），所以不会走进死路。这两套口径的差异是**既有的**，不是本文件引入的。
 */

/** 结果页的查询词参数名（与 `searchPageUrl` 一致） */
export const SEARCH_JUMP_QUERY_PARAM = "q";
/** 结果页的页码参数名（与 `searchPageUrl` 一致）——⚠️ 是 `p`，不是 `page` */
export const SEARCH_JUMP_PAGE_PARAM = "p";
/** 跳转输入框的 id / 标记属性（供测试与样式定位；不复用 PageNav 的 id，避免同页两个控件撞 id） */
export const SEARCH_JUMP_INPUT_ID = "vanblog-search-jump";
export const SEARCH_JUMP_INPUT_ATTR = "data-search-jump-input";
export const SEARCH_JUMP_FORM_ATTR = "data-search-jump-form";

/** 反解 `pageHref` 时用的假基址：它只用于把相对 URL 变成可解析的绝对 URL，不会出现在任何产出里 */
const PARSE_BASE = "http://vanblog.invalid";

export type SearchJumpOk = {
  ok: true;
  page: number;
};

export type SearchJumpFail = {
  ok: false;
  reason: "empty" | "invalid" | "outofrange" | "unavailable";
};

export type SearchJumpResult = SearchJumpOk | SearchJumpFail;

export interface SearchJumpTarget {
  /** 表单 action：结果页的路径。⚠️ 不含查询串 —— GET 提交会用表单字段重建整个查询串 */
  action: string;
  /**
   * 真实（未被展示截断的）查询词。空查询时为 `null`，此时**不渲染**隐藏字段 ——
   * 与 `searchPageUrl` 「空查询不写 q」同口径。
   */
  query: string | null;
}

/**
 * 从 `pageHref` 反解出表单需要的 `action` 与真实查询词。
 *
 * ⚠️ 为什么是"反解"而不是新增一个 prop：`SearchResultsProps.pageHref` 已经由
 * `pages/search.tsx` 用**真实**查询词构造（`searchPageUrl(state.query || q, next)`），
 * 而 `props.query` 是展示形（被 `displayQuery` 截断过）。从 `pageHref` 取值可以
 * ①不新增必填 prop（既有测试直接渲染 `SearchResults`，加必填会打红它们）；
 * ②让隐藏字段与上一页/下一页链接**共用同一个真值来源**，结构上不可能漂移。
 */
export function readSearchJumpTarget(pageHref: (page: number) => string): SearchJumpTarget {
  const href = typeof pageHref === "function" ? String(pageHref(1) ?? "") : "";
  // 🔴 只接受**路径绝对**的 href（`searchPageUrl` 就是这种形状）。
  //
  // 为什么要先做这一步、而不是直接 `new URL(href, PARSE_BASE)`：带基址的 `new URL`
  // **几乎不抛** —— 垃圾串会被解析成一个路径（实测 `"not a url at all"` → 路径
  // `/not%20a%20url%20at%20all`），于是 catch 兜底永远不触发，表单的 action 就变成了垃圾地址。
  // 先判形状，兜底才真的兜得住。
  //
  // ⚠️ 这同时是一条安全性质：即使调用方传进来一个**外部绝对 URL**，action 也不会被指向
  // 别的源（会退回 `/search`），所以这个表单不可能被用来把用户提交到站外。
  // ⚠️ 协议相对地址（`//evil.example/…`）也要一起拒：它以 `/` 开头，但带基址解析后会变成
  // 外部源（`http://evil.example/…`），于是 `q` 会被解析成攻击者给的值。
  if (!href.startsWith("/") || href.startsWith("//")) {
    return { action: "/search", query: null };
  }
  let url: URL;
  try {
    url = new URL(href, PARSE_BASE);
  } catch {
    return { action: "/search", query: null };
  }
  const raw = url.searchParams.get(SEARCH_JUMP_QUERY_PARAM);
  const query = raw === null ? null : raw.trim();
  return {
    // 用解析出的路径而不是硬编码 "/search"：这样部署在 next `basePath` 下
    // （href 形如 /blog/search?q=…）也仍然正确。
    action: url.pathname || "/search",
    query: query ? query : null,
  };
}

/**
 * 校验用户输入的页码。与 `resolvePageNavJump` **同一套口径**（同样的四种 reason、
 * 同样拒绝越界而不是夹取），差别只在它不构造 href —— 搜索页的 href 由 `pageHref` 负责。
 */
export function resolveSearchJump(raw: string, totalPages: number): SearchJumpResult {
  const pages = Number(totalPages);
  if (!Number.isFinite(pages) || pages <= 1) {
    return { ok: false, reason: "unavailable" };
  }
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty" };
  }
  // 复用 PageNav 的解析器：整数判定只有一处真相，不在两个组件里各写一份
  const parsed = parseJumpPage(raw);
  if (parsed === null) {
    return { ok: false, reason: "invalid" };
  }
  if (parsed < 1 || parsed > pages) {
    return { ok: false, reason: "outofrange" };
  }
  return { ok: true, page: parsed };
}

/** 校验通过就用 `pageHref` 生成 href 并导航；否则什么都不做（与 `submitPageNavJump` 同形状） */
export function submitSearchJump(
  raw: string,
  totalPages: number,
  navigate: (href: string) => void,
  pageHref: (page: number) => string
): SearchJumpResult {
  const result = resolveSearchJump(raw, totalPages);
  if (result.ok) {
    navigate(pageHref(result.page));
  }
  return result;
}

/**
 * 表单提交（点「前往」，或在输入框里按回车 —— 原生表单会把回车变成 submit，
 * 所以不需要像 `PageNavJump` 那样再挂一个 keydown 处理器）。
 */
export function handleSearchJumpSubmit(
  event: { preventDefault: () => void },
  raw: string,
  totalPages: number,
  navigate: (href: string) => void,
  pageHref: (page: number) => string
): SearchJumpResult {
  // 有 JS 时拦下原生提交，改走浅路由：不整页刷新，也就不会重新拉索引、重新搜一遍
  // （`pages/search.tsx` 刻意让翻页不触发搜索 effect，这里要保持那个性质）。
  event.preventDefault();
  return submitSearchJump(raw, totalPages, navigate, pageHref);
}

export interface DescribeSearchJumpInput {
  pageHref: (page: number) => string;
  /** 结果总条数（`pagination.total`），用来复用 `shouldShowPageNavJump` 这一个判据 */
  total: number;
  /** 每页条数（`pagination.perPage`） */
  perPage: number;
  /** 总页数（`pagination.totalPages`），用来给 input 的 max 与越界判定 */
  totalPages: number;
}

/**
 * 渲染所需的**全部**属性，集中在一处：组件只负责把这些值摆到 JSX 上，
 * 于是"该不该显示""参数名叫什么""min/max 是多少"都能被单测直接钉住。
 *
 * 文案一律复用 `PAGE_NAV_JUMP_*` 常量 —— 不新写一套字符串，否则中英措辞会在两个控件间漂移。
 */
export function describeSearchJumpForm(props: DescribeSearchJumpInput) {
  const totalPages = Math.max(1, Math.floor(Number(props.totalPages) || 1));
  const target = readSearchJumpTarget(props.pageHref);
  return {
    // 单页不显示：直接复用 PageNav 的那一个判据（pageCount(total, perPage) > 1），
    // 不在这里另写一份 total/pageSize 的比较。
    visible: shouldShowPageNavJump(Number(props.total) || 0, props.perPage),
    target,
    totalPages,
    labels: {
      form: PAGE_NAV_JUMP_LABEL,
      prefix: PAGE_NAV_JUMP_PREFIX,
      unit: PAGE_NAV_JUMP_UNIT,
      input: PAGE_NAV_JUMP_INPUT_LABEL,
      go: PAGE_NAV_JUMP_GO_LABEL,
    },
    form: {
      method: "get" as const,
      action: target.action,
      attr: SEARCH_JUMP_FORM_ATTR,
    },
    input: {
      id: SEARCH_JUMP_INPUT_ID,
      name: SEARCH_JUMP_PAGE_PARAM,
      type: "number" as const,
      min: 1,
      max: totalPages,
      step: 1,
      inputMode: "numeric" as const,
      ariaLabel: PAGE_NAV_JUMP_INPUT_LABEL,
      attr: SEARCH_JUMP_INPUT_ATTR,
    },
    submit: {
      type: "submit" as const,
      ariaLabel: PAGE_NAV_JUMP_GO_LABEL,
      label: PAGE_NAV_JUMP_GO_LABEL,
    },
  };
}
