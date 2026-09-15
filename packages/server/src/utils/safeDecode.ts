/**
 * 安全地做 `decodeURIComponent`。
 *
 * 为什么需要它：`decodeURIComponent('%')` / `decodeURIComponent('%zz')` 会**抛 URIError**，
 * 而文章别名是从 URL 路径里来的、任何人都能构造。实测 `GET /api/public/article/%25`
 * 直接 500（未鉴权的公开接口，一个百分号就能让它报错）。
 *
 * 约定：解不开就**原样返回**（调用方接着按字面值查库，最多查不到 → 404），
 * 顺便限长，避免匿名请求往库里塞任意长的键。
 */
export function safeDecodeURIComponent(input: unknown, maxLen = 500): string {
  const raw = typeof input === 'string' ? input : input == null ? '' : String(input);
  let out = raw;
  try {
    out = decodeURIComponent(raw);
  } catch {
    out = raw;
  }
  return out.slice(0, maxLen);
}
