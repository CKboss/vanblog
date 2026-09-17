/**
 * 文章详情页「相关文章」的 payload 收敛。
 *
 * 契约（server 侧另一个代理在实现，前台按防御式写）：公开文章详情 payload 上挂
 * `relatedArticles: [{ _id, title, pathname, cover, updatedAt, readingMinutes }]`，
 * **最多 5 条**。字段整体可选：缺失 / 不是数组 / 空数组 / 全是脏数据时，
 * normalize 后得到 `[]`，UI 整块不渲染（不报错、不渲染空壳标题）。
 *
 * ⚠️ 链接目标的取舍：公开路由 /post/<param> 只认**数字 id** 与 **pathname 别名**
 * （server 的 getByIdOrPathname）。契约里的 `_id` 是 Mongo ObjectId（24 位 hex），
 * 直接拿去当链接会 404 —— 所以 href 优先 pathname，其次数字 id；两者都没有就
 * 只渲染标题文本，宁可不给链接也不给一个必 404 的链接。
 */
import { isUsableImageUrl } from "./firstImage";

export interface RelatedArticle {
  _id?: string;
  id?: number | string;
  title?: string;
  pathname?: string;
  cover?: string;
  updatedAt?: string | Date;
  readingMinutes?: number | string | null;
}

/** 契约上限；server 多发也只在本地截断（渲染层永远不超过 5 条） */
export const RELATED_ARTICLES_MAX = 5;

const nonEmptyString = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
};

/** 数字 id 才算可链接（"12" 可，ObjectId hex 不可）；返回规范形式或 null */
function numericIdOf(item: RelatedArticle): string | null {
  for (const cand of [item.id, item._id]) {
    if (typeof cand === "number" && Number.isInteger(cand) && cand > 0) {
      return String(cand);
    }
    const s = nonEmptyString(cand);
    if (s != null && /^\d+$/.test(s)) {
      return s;
    }
  }
  return null;
}

/** 详情页链接：pathname 优先（规范地址，数字 id 会被 server 301 过来）；不可链接返回 null */
export function relatedArticleHref(item: RelatedArticle): string | null {
  const pathname = nonEmptyString(item?.pathname);
  if (pathname) {
    return `/post/${encodeURIComponent(pathname)}`;
  }
  const numeric = numericIdOf(item);
  return numeric ? `/post/${numeric}` : null;
}

/**
 * 把任意 payload 收敛成"可以直接渲染"的数组：
 * 只保留对象条目；title 与 pathname 至少要有一个；cover 只留可用 URL；最多 5 条。
 * 纯函数，无副作用，SSR/ISR 与客户端渲染结果一致（不产生 hydration 偏差）。
 *
 * ⚠️ 输出对象**绝不带值为 undefined 的键**：这份数据会经 getStaticProps 进
 * __NEXT_DATA__，而 Next 的序列化器遇到 undefined 值直接抛
 * "Error serializing `.relatedArticles[i].xxx`" → 整页 500（本机实测踩过：
 * 真实 payload 里 cover 是**空串**）。JSON.stringify 和 React 渲染都会静默容忍
 * undefined，所以测试必须显式断言"没有 undefined 值的键"（见 relatedArticles.spec）。
 */
export function normalizeRelatedArticles(raw: unknown): RelatedArticle[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: RelatedArticle[] = [];
  for (const entry of raw) {
    if (out.length >= RELATED_ARTICLES_MAX) {
      break;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const title = nonEmptyString(item.title);
    const pathname = nonEmptyString(item.pathname);
    if (!title && !pathname) {
      continue; // 既没标题也没别名/数字 id 可展示的东西 —— 跳过而不是渲染空行
    }
    const normalized: RelatedArticle = {};
    const mongoId = nonEmptyString(item._id);
    if (mongoId != null) {
      normalized._id = mongoId;
    }
    if (typeof item.id === "number" || nonEmptyString(item.id) != null) {
      normalized.id = item.id as number | string;
    }
    if (title != null) {
      normalized.title = title;
    }
    if (pathname != null) {
      normalized.pathname = pathname;
    }
    const cover = nonEmptyString(item.cover);
    if (cover != null && isUsableImageUrl(cover)) {
      normalized.cover = cover;
    }
    if (item.updatedAt != null && item.updatedAt !== "") {
      normalized.updatedAt = item.updatedAt as string | Date;
    }
    if (item.readingMinutes != null && item.readingMinutes !== "") {
      normalized.readingMinutes = item.readingMinutes as number | string;
    }
    if (!normalized.title && !relatedArticleHref(normalized)) {
      continue;
    }
    out.push(normalized);
  }
  return out;
}
