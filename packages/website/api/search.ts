export async function searchArticles(str: string): Promise<any> {
  try {
    // 必须编码：搜 `C#` 会变成 value=C，搜 `a&b` 会多出一个参数
    const url = `/api/public/search?value=${encodeURIComponent(str ?? "")}`;
    const res = await fetch(url);
    const { data } = await res.json();
    return data.data;
  } catch (err) {
    console.log(err);
    throw err;
  }
}
