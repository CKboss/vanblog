/**
 * 搜索的**排序与匹配**规则（纯函数，无 DOM / 无 React，可以直接单测）。
 *
 * ## 匹配规则（就三条，没有第四条）
 *
 * 1. **子串匹配，不分词、不模糊、不容错拼写。**
 *    中文没有词边界，分词要么引一个词典要么引一个库（本项目刻意不引任何搜索库：
 *    语料是一个个人博客，`String.indexOf` 在 2000 篇 × 200 字上就是几毫秒）。
 *    子串匹配对中文天然正确：搜"备份"能命中"整站备份"、"备份失败"、"恢复备份"。
 *    ⚠️ **代价如实说明**：打错一个字就搜不到（没有编辑距离、没有拼音、没有同义词）。
 *    拉丁文同理，搜 `dockre` 不会命中 `docker`。这是极简换来的，不是 bug。
 * 2. **大小写折叠：`String.prototype.toLowerCase()`（locale 无关）。**
 *    ⚠️ 为什么不是服务端那个 `toLocaleLowerCase()`：`toLocaleLowerCase` 跟**运行环境的
 *    locale** 走 —— 土耳其语 locale 下 `'I'.toLocaleLowerCase()` 是 `'ı'`（无点 i）而不是 `'i'`。
 *    索引在浏览器里搜，访客的 locale 我们既不知道也不该依赖：同一个查询在不同访客的机器上
 *    返回不同结果，这比"和服务端差一个字符"糟得多。`toLowerCase()` 是 Unicode 默认大小写转换，
 *    与 locale 无关 ⇒ 结果可复现。
 *    ⚠️ **因此两条路径的折叠规则确实不同，结果集可能有微小差异**（不假装它们一样）：
 *    服务端 `searchByString` 的 JS 复筛用 `toLocaleLowerCase()`，而它前面的 Mongo `$regex`
 *    用的是 `i`（另一套简单大小写折叠）。三者在 `İ`(U+0130)、`ß`、开尔文符号 `K`(U+212A)
 *    这类字符上会给出不同答案（第四轮审计记录过这一点）。落到用户身上就是：
 *    极少数带特殊字符的查询，客户端索引与服务端回退可能差一篇。**没有做统一，因为
 *    统一需要改 `article.provider.ts`（不在本轮的领地里），而改它会动到公开搜索的既有语义。**
 *    也**没有做 Unicode 归一化**（NFC/NFD）：组合字符的两种编码形式不会互相匹配 ——
 *    这与服务端一致（`toLocaleLowerCase` 与 Mongo 的 `i` 都不做归一化）。
 * 3. **多个词 = AND。** 查询按空白切成词（最多 `MAX_TERMS` 个），
 *    每个词都必须在"标题 / 标签 / 分类 / 摘要"里至少出现一次，这篇才算命中。
 *    单个词的查询就退化成第 1 条的纯子串匹配。
 *
 * ## 排序规则（写在这里，因为它就是产品语义）
 *
 * 先按**档位**，档位内按**命中次数**，再按**新近度**：
 *
 * | 档位 | 含义 |
 * | --- | --- |
 * | 1 | 标题里有词命中 |
 * | 2 | 标签或分类里有词命中（标题没有） |
 * | 3 | 只有摘要里有词命中 |
 *
 * - 一篇的档位 = 它所有命中词里**最好的那一档**（搜"docker 备份"，标题含 docker、
 *   摘要含备份 ⇒ 档位 1）。
 * - `hits` = 所有词在四个字段里出现的**总次数**（不重叠计数）。同档位内 `hits` 大的在前：
 *   一篇反复讲备份的文章，比只在结尾提了一句的更该排在前面。
 * - 最后按日期新→旧（`d` 字段是 `YYYY-MM-DD`，字符串比较即时间比较），
 *   同日期按 `id` 大→小。**必须有这两个 tie-break**：否则同分文档的顺序取决于
 *   `Array.prototype.sort` 拿到的输入顺序，翻页时会出现"同一条在第 1 页和第 2 页各出现一次"。
 *
 * ⚠️ 诚实的边界：这**不是**相关性学习，没有 TF-IDF / BM25 / 字段权重调参 / 点击反馈。
 * 它是一个三档 + 计数 + 时间的确定性排序，20 行说得完，出了问题能一眼看出为什么。
 */

import {
  SEARCH_MAX_RESULTS,
  SEARCH_RESULTS_PER_PAGE,
  SearchIndexDoc,
  ServerSearchItem,
} from "./searchIndex";

/** 一次查询最多切几个词（再多就是用户在粘贴段落，不是在搜索） */
export const MAX_TERMS = 8;

/** 查询长度上限（与服务端 `searchByString` 的 200 字截断同值） */
export const MAX_QUERY_CHARS = 200;

/** 单个词的长度上限：一个 200 字的"词"做子串匹配没有意义，还白烧 CPU */
export const MAX_TERM_CHARS = 64;

export const TIER_TITLE = 1;
export const TIER_TAG_OR_CATEGORY = 2;
export const TIER_SNIPPET = 3;

export type SearchTier = typeof TIER_TITLE | typeof TIER_TAG_OR_CATEGORY | typeof TIER_SNIPPET;

/**
 * 大小写折叠：**唯一**的一处，别的地方不许自己 `toLowerCase`。
 * locale 无关（理由见文件头）。非字符串一律当空串。
 */
export function foldCase(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * 把用户输入切成要匹配的词。
 *
 * - 先截到 `MAX_QUERY_CHARS`（与服务端同值），再按空白切；
 * - 每个词截到 `MAX_TERM_CHARS`；
 * - 折叠、去空、**去重**（"备份 备份" 不该让 hits 翻倍）；
 * - 最多 `MAX_TERMS` 个。
 *
 * ⚠️ 这里**不做任何正则转义**，因为整条搜索路径上不构造正则：
 * 匹配一律用 `indexOf`。`(a+)+b` 这种输入只是一个 6 字长的普通字符串，
 * 灾难性回溯在结构上不可能发生（`__tests__/searchHighlight.spec.ts` 有这条断言）。
 */
export function splitSearchTerms(query: unknown): string[] {
  const text = typeof query === "string" ? query : "";
  if (!text) {
    return [];
  }
  const clipped = text.slice(0, MAX_QUERY_CHARS);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const piece of clipped.split(/\s+/)) {
    const term = foldCase(piece).slice(0, MAX_TERM_CHARS);
    if (!term || seen.has(term)) {
      continue;
    }
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_TERMS) {
      break;
    }
  }
  return terms;
}

/** 不重叠地数 `needle` 在 `haystack` 里出现几次（两边都必须已经折叠过） */
export function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) {
    return 0;
  }
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) {
      return count;
    }
    count++;
    from = at + needle.length;
  }
}

/** 一篇文档里参与匹配的四块文本（已折叠，算一次给所有词复用） */
interface FoldedDoc {
  doc: SearchIndexDoc;
  title: string;
  tags: string;
  category: string;
  snippet: string;
  /** `updatedAt || createdAt` 的可比字符串（`d` 已经是 YYYY-MM-DD） */
  recency: string;
}

function foldDoc(doc: SearchIndexDoc): FoldedDoc {
  return {
    doc,
    title: foldCase(doc?.t),
    // 标签之间用 \n 隔开：免得 "ab" 跨两个标签（"a"+"b"）拼出来一个假命中
    tags: (Array.isArray(doc?.g) ? doc.g : []).map((t) => foldCase(t)).join("\n"),
    category: foldCase(doc?.c),
    snippet: foldCase(doc?.s),
    recency: typeof doc?.d === "string" ? doc.d : "",
  };
}

export interface RankedDoc {
  doc: SearchIndexDoc;
  tier: SearchTier;
  hits: number;
}

export interface IndexSearchOutcome {
  /** 已排序、已按 `SEARCH_MAX_RESULTS` 截断 */
  results: RankedDoc[];
  /** 命中总数（截断之前） */
  matched: number;
  /** 命中数超过了上限 ⇒ 前台要说"显示前 N 条，请增加关键词" */
  capped: boolean;
  terms: string[];
  backend: "index";
}

/**
 * 在索引里搜。`docs` 的顺序不要求（会重排），但通常就是索引里的新→旧。
 *
 * 复杂度：O(词数 × 文档数 × 文本长度) 的 `indexOf`，全部是原生扫描。
 * 2000 篇 × 200 字摘要 × 1 个词，实测在个位数毫秒（见 __tests__/searchRank.spec.ts 的量具断言）。
 */
export function searchIndexDocs(
  docs: SearchIndexDoc[],
  query: unknown,
  maxResults: number = SEARCH_MAX_RESULTS,
): IndexSearchOutcome {
  const terms = splitSearchTerms(query);
  if (!terms.length || !Array.isArray(docs) || !docs.length) {
    return { results: [], matched: 0, capped: false, terms, backend: "index" };
  }
  const matched: RankedDoc[] = [];
  for (const raw of docs) {
    const folded = foldDoc(raw);
    let tier: SearchTier | null = null;
    let hits = 0;
    let ok = true;
    for (const term of terms) {
      const inTitle = countOccurrences(folded.title, term);
      const inTags = countOccurrences(folded.tags, term);
      const inCategory = countOccurrences(folded.category, term);
      const inSnippet = countOccurrences(folded.snippet, term);
      const total = inTitle + inTags + inCategory + inSnippet;
      if (total === 0) {
        ok = false; // AND 语义：有一个词哪儿都没出现，这篇就出局
        break;
      }
      const termTier: SearchTier = inTitle
        ? TIER_TITLE
        : inTags || inCategory
        ? TIER_TAG_OR_CATEGORY
        : TIER_SNIPPET;
      tier = tier === null || termTier < tier ? termTier : tier;
      hits += total;
    }
    if (ok && tier !== null) {
      matched.push({ doc: raw, tier, hits });
    }
  }
  const total = matched.length;
  matched.sort(compareRankedDocs);
  const results = matched.slice(0, Math.max(0, maxResults));
  return { results, matched: total, capped: total > results.length, terms, backend: "index" };
}

/** 档位 ↑ → 命中次数 ↓ → 日期 ↓ → id ↓（最后两个是必需的 tie-break，见文件头） */
export function compareRankedDocs(a: RankedDoc, b: RankedDoc): number {
  if (a.tier !== b.tier) {
    return a.tier - b.tier;
  }
  if (a.hits !== b.hits) {
    return b.hits - a.hits;
  }
  const da = a.doc?.d || "";
  const db = b.doc?.d || "";
  if (da !== db) {
    return da < db ? 1 : -1;
  }
  const ia = Number(a.doc?.id) || 0;
  const ib = Number(b.doc?.id) || 0;
  return ib - ia;
}

export interface ServerSearchOutcome {
  results: RankedDoc[];
  matched: number;
  capped: boolean;
  terms: string[];
  backend: "server";
}

/**
 * 给服务端降级路径的返回值做**同一套排序**。
 *
 * `toSearchResult()` 只有 `{title,id,category,tags,updatedAt,createdAt}` —— 没有 `pathname`
 * 也没有摘要，所以：
 *  - 链接回落 `/post/<数字 id>`（`pages/post/[id].tsx` 认这个路径）；
 *  - 只有档位 1 与 2（没有摘要可匹配），而服务端本来就是在**全文**上匹配的，
 *    命中原因可能是正文，这时它落到档位 3（"其它"）—— 这是如实标注，不是排序错误。
 *  - 新近度用 `updatedAt || createdAt` 的日期部分。
 */
export function rankServerResults(
  items: ServerSearchItem[],
  query: unknown,
  maxResults: number = SEARCH_MAX_RESULTS,
): ServerSearchOutcome {
  const terms = splitSearchTerms(query);
  const list = Array.isArray(items) ? items : [];
  const mapped: RankedDoc[] = list.map((item, index) => {
    const doc = serverItemToIndexDoc(item, index);
    if (!terms.length) {
      return { doc, tier: TIER_SNIPPET as SearchTier, hits: 0 };
    }
    const title = foldCase(doc.t);
    const tags = (doc.g || []).map((t) => foldCase(t)).join("\n");
    const category = foldCase(doc.c);
    let tier: SearchTier = TIER_SNIPPET;
    let hits = 0;
    for (const term of terms) {
      const inTitle = countOccurrences(title, term);
      const inTags = countOccurrences(tags, term);
      const inCategory = countOccurrences(category, term);
      hits += inTitle + inTags + inCategory;
      if (inTitle && tier > TIER_TITLE) {
        tier = TIER_TITLE;
      } else if ((inTags || inCategory) && tier > TIER_TAG_OR_CATEGORY) {
        tier = TIER_TAG_OR_CATEGORY;
      }
    }
    // 服务端返回的东西一定是"匹配上了"的（它自己做过 $regex + includes 复筛），
    // 所以 hits=0 只说明命中的是正文 —— 归到最低档，但仍然保留在结果里。
    return { doc, tier, hits };
  });
  const total = mapped.length;
  mapped.sort(compareRankedDocs);
  const results = mapped.slice(0, Math.max(0, maxResults));
  return { results, matched: total, capped: total > results.length, terms, backend: "server" };
}

/** `toSearchResult` 的返回项 → 索引文档形状（复用同一套渲染与排序代码） */
export function serverItemToIndexDoc(item: ServerSearchItem, index: number): SearchIndexDoc {
  const raw = (item || {}) as Record<string, unknown>;
  const id = Number(raw.id);
  const date = toDatePrefix(raw.updatedAt) || toDatePrefix(raw.createdAt);
  return {
    id: Number.isFinite(id) ? id : index,
    // toSearchResult 不给 pathname，只能用数字 id（`/post/<id>` 是合法路径）
    u: `/post/${Number.isFinite(id) ? id : index}`,
    t: typeof raw.title === "string" ? raw.title : "",
    s: "",
    c: typeof raw.category === "string" ? raw.category : "",
    g: Array.isArray(raw.tags) ? (raw.tags.filter((t) => typeof t === "string") as string[]) : [],
    d: date,
    w: 0,
  };
}

function toDatePrefix(value: unknown): string {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value as any);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

export interface Pagination<T> {
  items: T[];
  page: number;
  totalPages: number;
  total: number;
  perPage: number;
  /** 请求的页码超出了范围（比如手改 URL 到 p=99）：已经夹回合法范围 */
  clamped: boolean;
}

/**
 * 客户端分页。`page` 越界一律**夹回**而不是返回空页：
 * 用户手改 URL 到 `p=99`、或者搜索结果从 3 页缩到 1 页时，看到空白页是错的。
 */
export function paginate<T>(
  items: T[],
  page: number,
  perPage: number = SEARCH_RESULTS_PER_PAGE,
): Pagination<T> {
  const list = Array.isArray(items) ? items : [];
  // 与 utils/envNumber.envPositiveInt 同口径：缺失 / 非数字 / NaN / ≤0 一律回落默认值。
  // ⚠️ 不能写成 `Math.max(1, perPage)`：perPage=-5 会得到"每页 1 条"，
  // 那是一种静默的、看起来像 bug 的行为（45 条结果变成 45 页）。
  const requestedSize = Number(perPage);
  const size =
    Number.isFinite(requestedSize) && requestedSize > 0
      ? Math.floor(requestedSize)
      : SEARCH_RESULTS_PER_PAGE;
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const requested = Math.floor(Number(page));
  const safe = Number.isFinite(requested) && requested > 0 ? requested : 1;
  const clamped = safe !== Math.min(safe, totalPages);
  const current = Math.min(Math.max(1, safe), totalPages);
  const start = (current - 1) * size;
  return {
    items: list.slice(start, start + size),
    page: current,
    totalPages,
    total,
    perPage: size,
    clamped,
  };
}
