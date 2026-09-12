/**
 * Escape a user-supplied string so it can be embedded in a RegExp as a literal.
 * Search endpoints pass raw input to Mongo `$regex`; without escaping, `(` or `*`
 * would either throw a server-side pattern error or change the match semantics.
 */
export function escapeRegExp(value: unknown): string {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 用户搜索词的最大长度：超长正则会让 Mongo 做无谓的全表扫描。 */
export const MAX_SEARCH_INPUT = 200;

/**
 * 把用户输入变成可以安全塞进 `$regex` 的**字面量**模式：去首尾空白、截断、转义元字符。
 *
 * 未转义的输入有两种后果：`(`、`[`、`*`、`?`、`\`、`a{2,1}` 会让 Mongo 直接抛
 * 「regular expression is invalid」→ 接口 500（公开搜索框就能触发）；
 * `(a+)+b` 这类则可能造成灾难性回溯（未鉴权的 CPU 打满）。
 */
export function safeSearchPattern(value: unknown, maxLen = MAX_SEARCH_INPUT): string {
  return escapeRegExp(String(value ?? '').trim().slice(0, maxLen));
}
