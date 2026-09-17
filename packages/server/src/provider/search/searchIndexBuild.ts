import { articleOverviewMarkdown } from 'src/utils/articleExcerpt';
import { wordCount } from 'src/utils/wordCount';
import { envBool } from 'src/utils/envBool';
import { clampToChars, markdownToPlainText } from './markdownPlainText';

/**
 * 搜索索引的**纯构建逻辑**（没有任何 IO / Nest 依赖，可以脱离数据库单测）。
 *
 * 形状与 rss/sitemap 一致：server 生成一个静态产物，写到 `<staticPath>/search/index.json`，
 * 由既有的 `/static/**` 挂载点直接发出去（不需要新的 mount，也不需要改 caddy）。
 * 前台 `/search` 页把它整个下载下来，在浏览器里做子串匹配 + 排序 + 高亮。
 *
 * ⚠️ **键名是刻意压短的**（`u`/`t`/`s`/`c`/`g`/`d`/`w`）：这个文件是**每个打开搜索的访客
 * 都要下载**的，不是内部产物。53 篇的实测与 1000 篇的外推见 searchIndex.provider.ts 的报告注释。
 *
 * ⚠️ **绝不下发 `content`**：第四轮审计量过"列表接口带正文"是 1.69 MB/请求 的放大器
 * （AGENTS §7.42）。索引里只有 ≤ `snippetChars` 字的纯文本摘要。
 */

/** 索引文件格式版本。改任何字段语义都要 +1 —— 前台按它判断"这份索引我认不认" */
export const SEARCH_INDEX_VERSION = 1;

/** 最多收录多少篇（超出的**最新**优先保留，`truncated` 置真） */
export const SEARCH_INDEX_MAX_DOCS_ENV = 'VANBLOG_SEARCH_INDEX_MAX_DOCS';
export const SEARCH_INDEX_MAX_DOCS_DEFAULT = 2000;
/** 硬上限：这个文件是访客要下载的，给个不至于把浏览器拖死的天花板 */
export const SEARCH_INDEX_MAX_DOCS_LIMIT = 20000;

/** 摘要字符预算 */
export const SEARCH_INDEX_SNIPPET_CHARS_ENV = 'VANBLOG_SEARCH_INDEX_SNIPPET_CHARS';
export const SEARCH_INDEX_SNIPPET_CHARS_DEFAULT = 200;
export const SEARCH_INDEX_SNIPPET_CHARS_MIN = 50;
export const SEARCH_INDEX_SNIPPET_CHARS_MAX = 500;

/** 总开关：`VANBLOG_SEARCH_INDEX=false` 完全关掉生成（前台会干净地回退到服务端搜索） */
export const SEARCH_INDEX_ENABLED_ENV = 'VANBLOG_SEARCH_INDEX';

/** 每篇最多带几个标签（与 rss.provider 的 10 个同一量级；标签是搜索的一个匹配面，放宽到 20） */
export const SEARCH_INDEX_TAGS_PER_DOC = 20;

/**
 * 摘要的 markdown **过扫描倍数**。
 *
 * `articleOverviewMarkdown` 在没有 `<!-- more -->` 时按 `maxChars` 截**markdown**，
 * 而剥掉语法之后纯文本会短一截（链接 `[文字](url)` 只剩"文字"，代码块整段消失）。
 * 按 1× 截会得到一堆几十字的残摘要，所以按 4× 取 markdown、剥完再硬截到 `snippetChars`。
 * 代价是 O(4×200) 的扫描，仍然与正文长度无关（§7.55-H 的那条优化保证的正是这一点）。
 */
export const SEARCH_SNIPPET_OVERSCAN = 4;

/**
 * 剥 markdown 之前再兜一道输入上限：`<!-- more -->` 存在时 excerpt 是**标记之前的全部**
 * （可能几万字），不该让摘要计算随作者把标记放哪儿而线性变贵。
 * `snippetChars × 6 + 512` 对"要凑够 snippetChars 个纯文本字符"极其宽裕。
 */
export function snippetStripInputCap(snippetChars: number): number {
  return snippetChars * 6 + 512;
}

export interface SearchIndexDoc {
  /** 文章的数字 id（本站的身份就是 `id:number`，见 §7.57-F 的契约说明） */
  id: number;
  /** 站内路径，`/post/<pathname 或 id>`，与 sitemap 的写法逐字一致 */
  u: string;
  /** 标题 */
  t: string;
  /** ≤ snippetChars 字的**纯文本**摘要（可能为空字符串） */
  s: string;
  /** 分类名 */
  c: string;
  /** 标签 */
  g: string[];
  /** `YYYY-MM-DD`（UTC 口径的 updatedAt || createdAt） */
  d: string;
  /** 字数（与 `utils/wordCount` 同口径，也就是存量 `wordCount` 字段的算法） */
  w: number;
}

export interface SearchIndexFile {
  version: number;
  generatedAt: string;
  /** 与 `/api/public/meta` 的 `version` 同源（`utils/loadConfig` 的 `version`） */
  codeVersion: string;
  /** 文章数超过 maxDocs 被截断时为 true（前台据此提示"索引只含最近 N 篇"） */
  truncated: boolean;
  maxDocs: number;
  snippetChars: number;
  /** `docs.length` */
  count: number;
  /**
   * 合格文章的**总数**（截断之前）。
   * ⚠️ 这是我在需求给的 schema 之上**多加的一个字段**：只有 `truncated:true` 而没有总数时，
   * 前台没法诚实地说出"索引只含最近 2000 篇，全站共 5123 篇"。纯增量，老消费者不受影响。
   */
  total: number;
  docs: SearchIndexDoc[];
}

/** 构建索引需要的最小文章形状（`ArticleProvider.getAll('public', …)` 的返回值就满足） */
export interface SearchIndexArticleLike {
  id?: number | string;
  pathname?: string;
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  createdAt?: Date | string | number;
  updatedAt?: Date | string | number;
  wordCount?: number;
  [key: string]: unknown;
}

export function searchIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // 默认开；只有显式的 0/false/no/off 才关（与仓库里其它开关同口径，见 utils/envBool）
  return envBool(SEARCH_INDEX_ENABLED_ENV, true, env);
}

/**
 * 与 `utils/envNumber.envPositiveInt` **逐条同口径**的正整数解析，只是显式接受 env 对象。
 *
 * 为什么不直接用 `envPositiveInt`：它只读 `process.env`，而"临时改 process.env 再读回来"
 * 在并行的 jest worker 里是个共享可变状态（同一个 worker 内的其它 spec 会读到被改掉的值）。
 * 这里复制的是那份工具注释里写明的语义：
 *  缺失 / 空串 / 非数字 / NaN / Infinity / ≤0 ⇒ fallback；合法值夹到 [min,max] 再向下取整。
 */
function positiveIntFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env?.[name];
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  const clamped = Math.min(Math.max(n, min), max);
  return Number.isFinite(clamped) ? Math.floor(clamped) : fallback;
}

/** `VANBLOG_SEARCH_INDEX_MAX_DOCS`（默认 2000，夹在 1…20000） */
export function resolveSearchIndexMaxDocs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(
    env,
    SEARCH_INDEX_MAX_DOCS_ENV,
    SEARCH_INDEX_MAX_DOCS_DEFAULT,
    1,
    SEARCH_INDEX_MAX_DOCS_LIMIT,
  );
}

/** `VANBLOG_SEARCH_INDEX_SNIPPET_CHARS`（默认 200，夹在 50…500） */
export function resolveSearchIndexSnippetChars(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(
    env,
    SEARCH_INDEX_SNIPPET_CHARS_ENV,
    SEARCH_INDEX_SNIPPET_CHARS_DEFAULT,
    SEARCH_INDEX_SNIPPET_CHARS_MIN,
    SEARCH_INDEX_SNIPPET_CHARS_MAX,
  );
}

/**
 * 一篇文章的搜索摘要：**纯文本、长度有界、代价与正文长度无关**。
 *
 * 三段式（每一段都有明确的上界）：
 *  1. `articleOverviewMarkdown(content, snippetChars × OVERSCAN)` —— 复用全站统一的摘要口径
 *     （有 `<!-- more -->` 就用标记之前，没有就取前 N 字，并且会补全被截断的链接、
 *     不切坏 emoji 代理对）。§7.55-H 已经保证它的代价与"标记在哪"成正比而不是与正文长度成正比。
 *  2. 剥 markdown 之前按 `snippetStripInputCap` 再兜一刀（见那个常量的注释）。
 *  3. `clampToChars` 硬截到 `snippetChars`，代理对安全，真截断了就补一个 `…`。
 */
export function buildSearchSnippet(content: unknown, snippetChars: number): string {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) {
    return '';
  }
  const budget = Math.max(1, Math.floor(snippetChars));
  const excerpt = articleOverviewMarkdown(raw, budget * SEARCH_SNIPPET_OVERSCAN) || '';
  if (!excerpt) {
    return '';
  }
  const cap = snippetStripInputCap(budget);
  const bounded = excerpt.length > cap ? excerpt.slice(0, cap) : excerpt;
  const text = markdownToPlainText(bounded);
  if (!text) {
    return '';
  }
  if (text.length <= budget) {
    return text;
  }
  return `${clampToChars(text, budget - 1)}…`;
}

/**
 * `updatedAt || createdAt` → `YYYY-MM-DD`（**UTC 口径**）；都拿不到就是空串。
 *
 * ⚠️ 已知且刻意的小偏差：站点其它地方（`ArticleList` 用 dayjs）显示的是**浏览器本地**日期，
 * 而这里是 UTC 的日期部分。对 UTC+8 的站点，本地时间在 00:00–08:00 之间更新的文章，
 * 索引里的 `d` 会比站点别处显示的日子**早一天**。
 * 为什么接受它：`d` 只是搜索结果里的一个日期标签与排序 tie-break，早一天不影响任何正确性；
 * 而两个"正确"的替代方案都更贵 —— 存完整 ISO 时间戳每篇多 14 字节（1000 篇 = 多 14 KB），
 * 存 epoch 秒虽然字节数一样但要偏离约定的 `"d": "2026-01-02"` 形状。
 * 真要改成 epoch 秒，记得 `version` 要 +1（前台按它判断"这份索引我认不认"）。
 */
export function searchIndexDate(value: unknown): string {
  if (!value) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value as any);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString().slice(0, 10);
}

/** 文章的公开路径：与 `SiteMapProvider.getSiteEntries` 的 `/post/${pathname || id}` 逐字一致 */
export function searchIndexUrl(article: SearchIndexArticleLike): string {
  const raw = article as any;
  const doc = raw?._doc || raw;
  return `/post/${doc?.pathname || doc?.id}`;
}

export function toSearchIndexDoc(
  input: SearchIndexArticleLike,
  snippetChars: number,
): SearchIndexDoc {
  // mongoose 文档：`_doc` 里是纯数据（sitemap.provider 也是这么解包的）
  const article: any = (input as any)?._doc || input || {};
  const id = Number(article?.id);
  const storedWords = Number(article?.wordCount);
  return {
    id: Number.isFinite(id) ? id : 0,
    u: searchIndexUrl(article),
    t: typeof article?.title === 'string' ? article.title : String(article?.title ?? ''),
    s: buildSearchSnippet(article?.content, snippetChars),
    c: typeof article?.category === 'string' ? article.category : '',
    // 标签可能是缺失 / 非数组 / 混进非字符串（老数据、JSON 导入）—— rss.provider 也做了同样的防御
    g: (Array.isArray(article?.tags) ? article.tags : [])
      .filter((t: any) => typeof t === 'string' && t.trim())
      .slice(0, SEARCH_INDEX_TAGS_PER_DOC)
      .map((t: string) => t),
    d: searchIndexDate(article?.updatedAt || article?.createdAt),
    // 存量 `wordCount` 字段（§7.57-F）优先；公开投影（publicView）不带它，
    // 那就用**同一个** `utils/wordCount` 现算 —— 存量的写入路径正是
    // `wordCount: wordCount(content)`（article.provider.ts:244/:490/:1745），所以两种来源同值。
    w:
      Number.isFinite(storedWords) && storedWords > 0
        ? storedWords
        : wordCount(typeof article?.content === 'string' ? article.content : ''),
  };
}

export interface BuildSearchIndexOptions {
  maxDocs?: number;
  snippetChars?: number;
  codeVersion?: string;
  generatedAt?: Date | string;
}

/**
 * 把**已经筛选好、已经按新→旧排序**的文章列表构建成索引文件对象（纯函数，不写盘）。
 *
 * ⚠️ 这里**故意不做任何可见性判断**：谁是"可公开"的文章由调用方决定，
 * 而调用方复用的是 `SiteMapProvider.getSiteEntries()`（见 searchIndex.provider.ts）。
 * 在这份纯函数里再写一遍 private / hidden / publishAt 的判定，就会出现
 * "两个谓词慢慢漂开"的经典事故 —— §7.57-H 那张审计表存在的原因就是它。
 */
export function buildSearchIndex(
  articles: SearchIndexArticleLike[],
  options: BuildSearchIndexOptions = {},
): SearchIndexFile {
  const list = Array.isArray(articles) ? articles : [];
  const maxDocs = Math.max(1, Math.floor(options.maxDocs ?? SEARCH_INDEX_MAX_DOCS_DEFAULT));
  const snippetChars = Math.max(
    SEARCH_INDEX_SNIPPET_CHARS_MIN,
    Math.floor(options.snippetChars ?? SEARCH_INDEX_SNIPPET_CHARS_DEFAULT),
  );
  const generatedAt =
    options.generatedAt instanceof Date
      ? options.generatedAt
      : options.generatedAt
      ? new Date(options.generatedAt)
      : new Date();
  const kept = list.slice(0, maxDocs);
  const docs = kept.map((article) => toSearchIndexDoc(article, snippetChars));
  return {
    version: SEARCH_INDEX_VERSION,
    generatedAt: Number.isNaN(generatedAt.getTime())
      ? new Date().toISOString()
      : generatedAt.toISOString(),
    codeVersion: String(options.codeVersion || 'dev'),
    truncated: list.length > maxDocs,
    maxDocs,
    snippetChars,
    count: docs.length,
    total: list.length,
    docs,
  };
}

/**
 * 序列化成要写盘的字符串。
 *
 * 用 `JSON.stringify` 而不是任何 pretty-print：这个文件是给浏览器下载的，
 * 缩进纯粹是白送的字节（53 篇实测缩进版比紧凑版多 ~12%）。
 */
export function serializeSearchIndex(index: SearchIndexFile): string {
  return JSON.stringify(index);
}
