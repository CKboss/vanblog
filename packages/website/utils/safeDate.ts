/**
 * 日期格式化的安全兜底。
 *
 * ⚠️ `new Date(x).toISOString()` 对 Invalid Date 会**抛 RangeError**。
 * 文章页把它直接写在 JSX 里（article:published_time / modified_time 两个 meta），
 * 一旦某篇文章的 createdAt/updatedAt 是坏值，整个页面在 SSR 阶段渲染失败 → 500。
 * "字段存在"（truthy 判断）不等于"字段能解析成日期"，这里统一判 NaN。
 */
export function toSafeIsoString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : new Date(String(value));
  const ms = date.getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  try {
    return date.toISOString();
  } catch {
    return null;
  }
}
