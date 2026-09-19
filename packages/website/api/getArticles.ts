import { Article } from "../types/article";
import { encodeQuerystring } from "../utils/encode";
import { config } from "../utils/loadConfig";
import { normalizeRelatedArticles } from "../utils/relatedArticles";
// ⚠️ 只有打 server（config.baseUrl）的 SSR 请求走这个封装；下面文章解锁那条是
// 浏览器侧的相对路径调用，**绝不能**带内部令牌（那等于把令牌交给访客）。
import { serverFetch } from "./internalFetch";
export type SortOrder = "asc" | "desc";
export interface GetArticleOption {
  page: number;
  pageSize: number;
  toListView?: boolean;
  category?: string;
  tags?: string;
  sortCreatedAt?: SortOrder;
  sortTop?: SortOrder;
  withWordCount?: boolean;
  /** 让服务端直接下发列表摘要（excerpt/firstImage），列表响应不再带全文 content */
  withExcerpt?: boolean;
}
export const getArticlesByOption = async (
  option: GetArticleOption
): Promise<{ articles: Article[]; total: number; totalWordCount?: number }> => {
  // 手拼 `k=v&` 只转义了 # 和 /（utils/encode.ts），`&` 在值里不需要转义却会截断参数：
  // 分类名 `a&b` 会变成 category=a，标签 `C++` 会被服务端按空格解出来。统一用 URLSearchParams。
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(option)) {
    if (v === undefined || v === null) {
      continue;
    }
    params.append(k, String(v));
  }
  const queryString = params.toString();
  try {
    const url = `${config.baseUrl}api/public/article?${queryString}`;
    const res = await serverFetch(url);
    const { statusCode, data } = await res.json();
    if (statusCode == 233) {
      return { articles: [], total: 0, totalWordCount: 0 };
    }
    return data;
  } catch (err) {
    if (process.env.isBuild == "t") {
      console.log("无法连接，采用默认值");
      return {
        articles: [],
        total: 0,
      };
    } else {
      throw err;
    }
  }
};
export const getArticlesByTimeLine = async () => {
  try {
    const url = `${config.baseUrl}api/public/timeline`;
    const res = await serverFetch(url);
    const { data } = await res.json();
    return data;
  } catch (err) {
    if (process.env.isBuild == "t") {
      console.log("无法连接，采用默认值");
      return {};
    } else {
      throw err;
    }
  }
};
export const getArticlesByCategory = async () => {
  try {
    const url = `${config.baseUrl}api/public/category`;
    const res = await serverFetch(url);
    const { data } = await res.json();
    return data;
  } catch (err) {
    if (process.env.isBuild == "t") {
      console.log("无法连接，采用默认值");
      return {};
    } else {
      throw err;
    }
  }
};
export const getArticlesByTag = async (tagName: string) => {
  try {
    const url = `${config.baseUrl}api/public/tag`;
    const res = await serverFetch(url);
    const { data } = await res.json();
    return data;
  } catch (err) {
    if (process.env.isBuild == "t") {
      console.log("无法连接，采用默认值");
      return {};
    } else {
      throw err;
    }
  }
};
/**
 * 文章标识只允许「一段路径」：Next 的动态参数会把 %2F 解码成 /，
 * 直接拼进后端 URL 就能让 fetch 打到 /api/admin/**（虽然还要 JWT，但没必要留这个口子）。
 */
export const isSafeArticleParam = (id: unknown): boolean => {
  const text = String(id ?? "");
  return (
    text.length > 0 &&
    text.length <= 200 &&
    !text.includes("/") &&
    !text.includes("\\") &&
    !text.includes("..") &&
    !text.includes("#") &&
    !text.includes("?")
  );
};

export const getArticleByIdOrPathname = async (id: string) => {
  if (!isSafeArticleParam(id)) {
    return {};
  }
  try {
    const url = `${config.baseUrl}api/public/article/${encodeURIComponent(String(id))}`;
    const res = await serverFetch(url);
    if (!res.ok) {
      if (res.status === 404) {
        // 确实没有这篇文章
        return {};
      }
      // 5xx / 网关错误：抛出去让 ISR 保留上一次的页面，别把好页面换成软 404
      throw new Error(`后端返回 ${res.status}`);
    }
    const { data } = await res.json();
    const { article, pre, next } = data;
    const r: any = { article };
    if (pre) {
      r.pre = { title: pre.title, id: pre.id, pathname: pre.pathname };
    }
    if (next) {
      r.next = { title: next.title, id: next.id, pathname: next.pathname };
    }
    // 相关文章（可选契约，server 侧并行实现中）：payload 级或 article 级都认，
    // 在 API 边界一次性 normalize（截到 5 条、剔脏数据），__NEXT_DATA__ 里只有干净数组；
    // 字段缺失/为空时**不加这个键** —— 老 server 下 pageProps 逐字节不变。
    const related = normalizeRelatedArticles(
      (data as any)?.relatedArticles ?? (article as any)?.relatedArticles,
    );
    if (related.length) {
      r.relatedArticles = related;
    }
    return r;
  } catch (err) {
    if (process.env.isBuild == "t") {
      console.log("无法连接，采用默认值");
      return {};
    }
    // 运行时**不要吞掉**：以前两个分支都 return {}，于是一次后端抖动
    // 就会被当成「文章不存在」，把 ISR 缓存里的好页面替换成 200 的软 404
    throw err;
  }
};
export const getArticleByIdOrPathnameWithPassword = async (
  id: number | string,
  password: string
) => {
  try {
    const url = `/api/public/article/${id}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
    const { data } = await res.json();
    return data;
  } catch (err) {
    if (process.env.isBuild == "t") {
      console.log("无法连接，采用默认值");
      return {};
    } else {
      throw err;
    }
  }
};
