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
export async function searchArticles(
  str: string
): Promise<SearchArticleItem[]> {
  try {
    // 必须编码：搜 `C#` 会变成 value=C，搜 `a&b` 会多出一个参数
    const url = `/api/public/search?value=${encodeURIComponent(str ?? "")}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`搜索请求失败（HTTP ${res.status}）`);
    }
    const json = await res.json();
    const list = json?.data?.data;
    if (!Array.isArray(list)) {
      throw new Error("搜索接口返回了不可用的数据");
    }
    return list as SearchArticleItem[];
  } catch (err) {
    console.log(err);
    throw err;
  }
}
