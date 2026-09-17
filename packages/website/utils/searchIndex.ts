/**
 * 构建期静态搜索索引（`/static/search/index.json`）的**前台读取与校验**部分。
 *
 * 这个文件是纯逻辑：不 fetch、不碰 DOM、不碰 React，所以可以在没有 DOM 的 vitest 里
 * 把整个"降级判定矩阵"跑一遍（见 `__tests__/searchIndex.spec.ts`）。
 * 真正的 fetch + 会话内缓存在 `api/searchIndex.ts`。
 *
 * ## 为什么要有降级矩阵，而且必须**说出来**
 *
 * 索引是一个静态产物，它可能：还没生成过（全新安装）、生成失败停在旧版本、
 * 被 `VANBLOG_SEARCH_INDEX=false` 关掉、被 CDN 缓存成半截、格式升了版而前台还是旧的。
 * 每一种都要能**干净地退回服务端 `/api/public/search`**，搜索永远不能变成一块空白。
 *
 * ⚠️ 而"静默退回"正是一个功能烂掉的方式：索引坏了半年没人知道，因为搜索看起来还能用。
 * 所以每一种降级都带一个**面向用户的理由字符串**（`explainBackend`），
 * 结果页会把它显示出来（"当前使用服务端搜索：索引文件不存在"），并且 `console.info` 一份。
 */

// URL 约定单独放在 utils/searchUrls.ts（那里不 import 任何东西），
// 因为 SearchCard 会被每个页面引用，而它只需要 searchPageUrl —— 见 searchUrls.ts 的说明。
// 这里再导出一次，好让搜索页与测试仍然只从 "utils/searchIndex" 这一个入口拿东西。
export {
  SERVER_SEARCH_PATH,
  readSearchQueryParams,
  searchPageUrl,
  serverSearchUrl,
} from "./searchUrls";

/** 与 server `provider/search/searchIndexBuild.ts` 的 `SEARCH_INDEX_VERSION` 必须同值 */
export const SEARCH_INDEX_VERSION = 1;

/** 索引文件的公开地址：`<staticPath>/search/index.json` 由既有的 `/static/**` 挂载点直接发出 */
export const SEARCH_INDEX_URL = "/static/search/index.json";

/** 每页多少条（客户端分页） */
export const SEARCH_RESULTS_PER_PAGE = 20;

/**
 * 结果条数上限。
 *
 * 为什么必须有：中文是**子串匹配、不分词**（这是极简的正确选择，见 searchRank.ts），
 * 于是"的"这种单字查询会命中几乎整个语料库。渲染 2000 条卡片既没有信息量，
 * 也会让浏览器卡住。超出上限时结果页会说"显示前 N 条，请增加关键词"。
 * 200 与 server `searchByString` 的 `SEARCH_MAX_RESULTS` 同值，两条路径的"最多几条"口径一致。
 */
export const SEARCH_MAX_RESULTS = 200;

/** 索引文件本身的体积上限（字节）。超过就当成"这不是我要的文件"（比如被错误页面顶替） */
export const SEARCH_INDEX_MAX_BYTES = 32 * 1024 * 1024;

/** 索引的新鲜度上限（毫秒）：超过就仍然用它，但如实告诉用户"索引可能不是最新的" */
export const SEARCH_INDEX_STALE_MS = 26 * 60 * 60 * 1000;

/** 索引里的一篇文档（键名是刻意压短的：这个文件每个访客都要下载） */
export interface SearchIndexDoc {
  /** 文章的数字 id */
  id: number;
  /** 站内路径 `/post/<slug 或 id>` */
  u: string;
  /** 标题 */
  t: string;
  /** ≤ snippetChars 字的纯文本摘要 */
  s: string;
  /** 分类 */
  c: string;
  /** 标签 */
  g: string[];
  /** `YYYY-MM-DD`（UTC） */
  d: string;
  /** 字数 */
  w: number;
}

export interface SearchIndexFile {
  version: number;
  generatedAt: string;
  codeVersion: string;
  truncated: boolean;
  maxDocs: number;
  snippetChars: number;
  count: number;
  /** 截断前的合格文章总数（server 侧多给的一个字段；老索引可能没有） */
  total?: number;
  docs: SearchIndexDoc[];
}

/** 服务端 `/api/public/search` 的返回项（`ArticleProvider.toSearchResult` 的形状） */
export interface ServerSearchItem {
  id: number;
  title: string;
  category?: string;
  tags?: string[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

/**
 * 索引为什么不可用。每一个值都对应降级矩阵里的一行。
 *  - `missing`    HTTP 404：全新安装还没生成过，或者被 `VANBLOG_SEARCH_INDEX=false` 关掉了
 *  - `http`       其它非 2xx（限流 429 / 网关 502…）
 *  - `network`    fetch 本身抛了（离线、DNS、CORS）
 *  - `not-json`   拿到的不是合法 JSON（半截文件、被 HTML 错误页顶替）
 *  - `version`    `version` 不是本前台认识的版本（server 升级了、前台还是旧的 ISR 缓存）
 *  - `shape`      JSON 合法但字段形状不对（docs 不是数组、文档缺关键字段）
 *  - `too-large`  超过 `SEARCH_INDEX_MAX_BYTES`
 */
export type SearchIndexFailure =
  | "missing"
  | "http"
  | "network"
  | "not-json"
  | "version"
  | "shape"
  | "too-large";

export type SearchBackend = "index" | "server";

/**
 * 加载结果。
 *
 * ⚠️ 这里刻意**不用**"判别联合"（`{ok:true;…} | {ok:false;…}`）：本包 `tsconfig` 是
 * `strict:false`（也就是 `strictNullChecks:false`），TS 在那种配置下对布尔判别式的
 * 收窄并不可靠（实测 `if (!r.ok) { r.reason }` 直接报 TS2339）。用一个所有字段都可选的
 * 单一接口，读起来一样清楚，还不用到处 `as any`。
 */
export interface SearchIndexLoadResult {
  ok: boolean;
  index?: SearchIndexFile;
  bytes?: number;
  reason?: SearchIndexFailure;
  detail?: string;
}

/** `validateSearchIndexPayload` 的返回（同样不用判别联合，理由同上） */
export interface SearchIndexValidation {
  ok: boolean;
  index?: SearchIndexFile;
  reason?: SearchIndexFailure;
  detail?: string;
}

/** 给 fetch 用的最小接口，便于在单测里注入而不去 mock 全局 */
export interface SearchIndexLoader {
  (url: string): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

/**
 * 校验一份**已经解析出来**的索引。纯函数：喂什么形状就如实报告哪里不对。
 */
export function validateSearchIndexPayload(raw: unknown): SearchIndexValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "shape", detail: "顶层不是一个对象" };
  }
  const candidate = raw as Record<string, unknown>;
  const version = candidate.version;
  if (version !== SEARCH_INDEX_VERSION) {
    return {
      ok: false,
      reason: "version",
      detail: `索引版本 ${String(version)}，前台认识的是 ${SEARCH_INDEX_VERSION}`,
    };
  }
  if (!Array.isArray(candidate.docs)) {
    return { ok: false, reason: "shape", detail: "docs 不是数组" };
  }
  const docs: SearchIndexDoc[] = [];
  for (let i = 0; i < candidate.docs.length; i++) {
    const entry = candidate.docs[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") {
      return { ok: false, reason: "shape", detail: `docs[${i}] 不是对象` };
    }
    // 只要求"能用来渲染与匹配"的那几个字段是正确类型；其余一律给安全默认值。
    // 一个字段缺失就把整份索引判死，等于让一次 server 小改动把全站搜索打回服务端。
    if (typeof entry.u !== "string" || !entry.u) {
      return { ok: false, reason: "shape", detail: `docs[${i}].u 不是非空字符串` };
    }
    docs.push(normalizeIndexDoc(entry, i));
  }
  const index: SearchIndexFile = {
    version: SEARCH_INDEX_VERSION,
    generatedAt: typeof candidate.generatedAt === "string" ? candidate.generatedAt : "",
    codeVersion: typeof candidate.codeVersion === "string" ? candidate.codeVersion : "",
    truncated: candidate.truncated === true,
    maxDocs: toFiniteNumber(candidate.maxDocs, 0),
    snippetChars: toFiniteNumber(candidate.snippetChars, 0),
    count: toFiniteNumber(candidate.count, docs.length),
    total:
      typeof candidate.total === "number" && Number.isFinite(candidate.total)
        ? candidate.total
        : undefined,
    docs,
  };
  return { ok: true, index };
}

function normalizeIndexDoc(entry: Record<string, unknown>, position: number): SearchIndexDoc {
  // id 与 w 用"宽松数字"：server 给的一定是数字，但 JSON 被手改过 / 被别的生产者写过时
  // 可能是数字字符串。它们只用于 React 的 key 与排序 tie-break，宽松一点没有风险；
  // 而因为一个字段类型不对就把整份索引判死，等于让全站搜索退回服务端 —— 那才是真损失。
  const id = toNumberish(entry.id, position);
  return {
    id,
    u: String(entry.u),
    t: typeof entry.t === "string" ? entry.t : "",
    s: typeof entry.s === "string" ? entry.s : "",
    c: typeof entry.c === "string" ? entry.c : "",
    g: Array.isArray(entry.g)
      ? (entry.g.filter((t) => typeof t === "string") as string[])
      : [],
    // `d` 仍然只认字符串：一个数字日期前缀（20260102）没有唯一解释，猜不如不用
    d: typeof entry.d === "string" ? entry.d : "",
    w: toNumberish(entry.w, 0),
  };
}

/** 有限数字或数字字符串 → 数字；其它一律 fallback */
function toNumberish(value: unknown, fallback: number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 解析 + 校验一段索引文本（`not-json` / `too-large` 在这一步就被认出来）。
 */
export function parseSearchIndexText(
  text: string,
  byteLength?: number,
): SearchIndexLoadResult {
  const bytes = typeof byteLength === "number" ? byteLength : text.length;
  if (bytes > SEARCH_INDEX_MAX_BYTES) {
    return {
      ok: false,
      reason: "too-large",
      detail: `${bytes} 字节，超过上限 ${SEARCH_INDEX_MAX_BYTES}`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: "not-json",
      detail: (err as Error)?.message || "JSON.parse 失败",
    };
  }
  const validated = validateSearchIndexPayload(raw);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason, detail: validated.detail };
  }
  return { ok: true, index: validated.index, bytes };
}

/** 把一次 fetch 的结果收敛成 `SearchIndexLoadResult`（404 → missing，其它非 2xx → http） */
export function loadResultFromResponse(
  status: number,
  text: string,
  byteLength?: number,
): SearchIndexLoadResult {
  if (status === 404) {
    return { ok: false, reason: "missing", detail: `HTTP 404（${SEARCH_INDEX_URL}）` };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: "http", detail: `HTTP ${status}` };
  }
  return parseSearchIndexText(text, byteLength);
}

/**
 * **降级判定矩阵**：给定索引的加载结果，决定这次搜索走哪条路。
 *
 * | 索引状态 | backend | 用户看到什么 |
 * | --- | --- | --- |
 * | 正常 | `index` | 结果 + 生成时间；`truncated` 时多一句"索引只含最近 N 篇" |
 * | 404 / 非 JSON / 版本不符 / 形状不对 / 太大 / 网络失败 / 其它 HTTP 错误 | `server` | 结果 + "当前使用服务端搜索：<原因>" |
 *
 * ⚠️ 没有"索引坏了一半就只用一半"这种中间态：那份文件要么整个可信，要么不用。
 * 半信半疑的索引会让"搜不到"和"确实没有"分不清 —— 那比退回服务端糟得多。
 */
export function decideSearchBackend(load: SearchIndexLoadResult): {
  backend: SearchBackend;
  reason: string;
} {
  // 两个条件都要：`ok` 为真但 `index` 缺失（理论上不该发生）时也必须降级，
  // 否则下游会在 undefined 上炸 —— 那才是真正"静默"的失败。
  if (load && load.ok && load.index) {
    return { backend: "index", reason: "" };
  }
  return {
    backend: "server",
    reason: explainIndexFailure(load?.reason || "shape", load?.detail),
  };
}

/** 每种失败原因对应的、可以直接给用户看的一句话 */
export function explainIndexFailure(
  reason: SearchIndexFailure,
  detail?: string,
): string {
  const suffix = detail ? `（${detail}）` : "";
  switch (reason) {
    case "missing":
      return `静态索引还没有生成${suffix}，已改用服务端搜索`;
    case "network":
      return `取不到静态索引${suffix}，已改用服务端搜索`;
    case "http":
      return `静态索引请求失败${suffix}，已改用服务端搜索`;
    case "not-json":
      return `静态索引不是合法的 JSON${suffix}，已改用服务端搜索`;
    case "version":
      return `静态索引版本不匹配${suffix}，已改用服务端搜索`;
    case "shape":
      return `静态索引字段形状不对${suffix}，已改用服务端搜索`;
    case "too-large":
      return `静态索引体积异常${suffix}，已改用服务端搜索`;
    default:
      return `静态索引不可用（${String(reason)}），已改用服务端搜索`;
  }
}

/** 索引"能用但可能不是最新的"：给出提示文案，不给就返回空串 */
export function staleIndexNotice(index: SearchIndexFile, now: number = Date.now()): string {
  const generated = Date.parse(index.generatedAt || "");
  if (Number.isNaN(generated)) {
    return "";
  }
  const age = now - generated;
  if (age <= SEARCH_INDEX_STALE_MS) {
    return "";
  }
  const hours = Math.round(age / 3600000);
  return `索引已有约 ${hours} 小时没有更新（每次内容变更后的 ISR 会重新生成）`;
}

/** `truncated` 时如实说明索引只含最近 N 篇 */
export function truncatedIndexNotice(index: SearchIndexFile): string {
  if (!index.truncated) {
    return "";
  }
  const total = typeof index.total === "number" && index.total > index.count ? index.total : 0;
  return total
    ? `索引只含最近 ${index.count} 篇（全站共 ${total} 篇），更早的文章请用服务端搜索`
    : `索引只含最近 ${index.count} 篇，更早的文章请用服务端搜索`;
}
