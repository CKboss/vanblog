import { IDENTITY_T, type TFunc } from "../utils/i18n";
export interface SearchArticleItem {
  id: number;
  title: string;
  pathname?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/**
 * 全站搜索。
 *
 * ⚠️ 以前是 `const { data } = await res.json(); return data.data;`：
 * 接口非 200（错误体里没有 data）时会直接在 `data.data` 上抛 TypeError，
 * 而调用方（SearchCard）没有 catch —— loading 永远停在 true，
 * 用户看到的是一行卡死的「搜索中...」，"请求失败"和"还在搜"渲染成同一个样子。
 * 现在把失败如实抛成带语义的 Error，由 SearchCard 显示「搜索失败」。
 */
/**
 * 🔴 期 10 第十四批：错误消息接上 i18n 接缝 —— 尾参 `t: TFunc = IDENTITY_T`。
 * ⚠️ 为什么用"注入尾参"而不是在模块里直接调 `t`：这是**数据层**（不是组件），
 * 而且它同时被**渲染期**（`SearchCard` / `pages/search.tsx`）与**构建期**（`getStaticProps`）调用；
 * 构建期没有语种可言 ⇒ 默认 `IDENTITY_T`（中文）正是构建期该有的行为。
 * 🔴 这两条**是**界面文案（调用方的 catch 会把 `err.message` 显示给访客，见文件头那段注释），
 * 与 `api/getArticles.ts` 那条**不同**（那条抛给 ISR，访客永远看不到 ⇒ 永久例外）。
 */
export async function searchArticles(
  str: string,
  t: TFunc = IDENTITY_T
): Promise<SearchArticleItem[]> {
  try {
    // 必须编码：搜 `C#` 会变成 value=C，搜 `a&b` 会多出一个参数
    const url = `/api/public/search?value=${encodeURIComponent(str ?? "")}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(t("search.requestFailed", "搜索请求失败（HTTP {status}）", { status: res.status }));
    }
    const json = await res.json();
    const list = json?.data?.data;
    if (!Array.isArray(list)) {
      throw new Error(t("search.badResponseData", "搜索接口返回了不可用的数据"));
    }
    return list as SearchArticleItem[];
  } catch (err) {
    console.log(err);
    throw err;
  }
}
