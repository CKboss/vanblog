/**
 * 搜索相关的 **URL 约定**（单独一个文件，只为了让它足够小）。
 *
 * ⚠️ 为什么要从 `utils/searchIndex.ts` 里拆出来：
 * `components/SearchCard` 会被 `Layout` 引到**每一个页面**上，而它只需要
 * 「查看全部结果」那一个 `searchPageUrl`。放在 `utils/searchIndex.ts` 里时，
 * 那个文件的全部导出（索引校验、七种降级文案、32 MB 的体积上限常量…）
 * 都会被打进**每个页面**的 chunk —— 实测 `pages/index.js` 里能找到
 * "顶层不是一个对象"、"静态索引还没有生成" 这些只有 `/search` 页才用得着的字符串。
 * 本仓库对首屏 JS 是有预算的（AGENTS §7.10 / §7.45：首屏 JS −34%），
 * 所以把"每个页面都要背的"和"只有搜索页要的"分开。
 *
 * 这个文件**不 import 任何东西**，所以它不可能再把别的模块拖进来。
 */

/** 服务端搜索接口路径（降级路径与"全文搜索"出口共用）。参数名是 `value`，不是 `q` */
export const SERVER_SEARCH_PATH = "/api/public/search";

/** 服务端搜索的地址 */
export function serverSearchUrl(query: string): string {
  return `${SERVER_SEARCH_PATH}?value=${encodeURIComponent(query ?? "")}`;
}

/**
 * 结果页 URL：`/search?q=<query>&p=<page>`。
 * 第 1 页不写 `p`（分享出去的链接更干净），空查询不写 `q`。
 */
export function searchPageUrl(query: string, page: number): string {
  const params: string[] = [];
  const q = String(query ?? "").trim();
  if (q) {
    params.push(`q=${encodeURIComponent(q)}`);
  }
  const p = Math.max(1, Math.floor(Number(page) || 1));
  if (p > 1) {
    params.push(`p=${p}`);
  }
  return params.length ? `/search?${params.join("&")}` : "/search";
}

/** 从 router query 里读出 `(q, page)`；垃圾值一律收敛成安全的默认 */
export function readSearchQueryParams(query: Record<string, unknown>): {
  q: string;
  page: number;
} {
  const rawQ = query?.q;
  const q = Array.isArray(rawQ) ? String(rawQ[0] ?? "") : String(rawQ ?? "");
  const rawP = query?.p;
  const pText = Array.isArray(rawP) ? String(rawP[0] ?? "") : String(rawP ?? "");
  const parsed = Number.parseInt(pText, 10);
  const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  return { q, page };
}
