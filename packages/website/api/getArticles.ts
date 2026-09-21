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
    // 🔴 `?toListView=true`：服务端只下发列表真正需要的字段（少 `hidden`/`lastVisitedTime`/
    //    `wordCount`，实测该响应 −18.3%）。⚠️ 这是 SSR 阶段 server→website 那一跳的白传，
    //    与 `utils/timelineMonths.ts` 的 `trimArticleRecord`（拿到响应之后再裁到 4 个字段）
    //    是**两层不同的裁剪**，互不冲突：这一层省的是进程间传输，那一层省的是访客下载量。
    //    ⚠️ website 侧对那三个字段**零读者**（已全仓核实；`SearchCard/a11y.ts` 里的
    //    `setBodyOverflow?.("hidden")` 是 CSS overflow 值，不是 `article.hidden`）。
    const url = `${config.baseUrl}api/public/category?toListView=true`;
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
 * 🔴 **死代码，而且是「看起来该修、其实是陷阱」的那一类 —— 动它之前先读完这段。**（2026-09-21 核实）
 *
 * 1. **它没有任何调用方**：全仓（排除 `.next`、`.umi`、`dist`）只有这一处定义；
 *    `utils/getPageProps.ts` 从本文件导入的是 `getArticleByIdOrPathname`、`getArticlesByCategory`、
 *    `getArticlesByOption`、`getArticlesByTimeLine` 四个名字，**不含它**；也没有命名空间导入或动态引用。
 *    标签页 `pages/tag/[tag].tsx` → `getTagPagesProps(currTag)` 走的是
 *    `getArticlesByOption({ page: 1, pageSize: -1, tags: currTag, toListView: true })`
 *    ⇒ **服务端按标签过滤**。所以「渲染一个标签页却下载全部标签的文章」这条白传
 *    **实际并不存在**（`__tests__/tagPageFetchShape.spec.ts` 钉住了这一点）。
 * 2. **它忽略自己的 `tagName` 参数**（拉的是整个标签映射）⇒ 谁把它接上去，谁就**真的**引入那条白传。
 *    所以那条「零调用方」守卫是有意的：接线就会红，逼改的人先读这段。
 * 3. 🔴 **不要把它「修好」成调 `/api/public/tag/:name`** —— 那是更隐蔽的坑。实测该端点每篇只返回
 *    **7 个字段：category、createdAt、id、tags、title、top、updatedAt，没有 `pathname`**
 *    （服务端 `toPublic()` 的显式映射就是这样）。而 `utils/getArticlePath.ts` 是
 *    `pathname ? pathname : id` ⇒ 换过去之后每个链接会**静默**从 `/post/<拼音别名>` 变成
 *    `/post/<数字 id>`（多一跳 301、渲染出的 HTML 也变了），而 `pathname` 是窄类型
 *    `TimelineArticleRef` 的**必需**字段之一。⚠️ 真要做这个改造，得先让服务端那个端点补上
 *    `pathname`，而不是在前台换个 URL。
 * 4. ⚠️ **为什么还留着它**：`packages/server/src/provider/tag/tag.provider.slimListView.spec.ts`
 *    **跨包**读取本文件源码，断言里面出现带 `toListView=true` 的那个 URL 字面量（它的本意是钉住
 *    「两个 SSR 取数点都带 slim 参数」）⇒ 删掉这个函数会让**另一个包的守卫**变红。
 *    正确的清理顺序是：先把那条服务端守卫改成钉 `getArticlesByCategory`（真正被调用的那个），
 *    再删本函数。⚠️ 这也是一条守卫设计教训：**跨包的源码文本守卫会把死代码冻在原地**，
 *    让「删掉没人用的东西」看起来像回归。
 */
export const getArticlesByTag = async (tagName: string) => {
  try {
    // 🔴 同上：`?toListView=true` 让服务端少下发三个零读者字段（实测该响应 −19.0%）。
    const url = `${config.baseUrl}api/public/tag?toListView=true`;
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
