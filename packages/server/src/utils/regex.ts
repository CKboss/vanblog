/**
 * Escape a user-supplied string so it can be embedded in a RegExp as a literal.
 * Search endpoints pass raw input to Mongo `$regex`; without escaping, `(` or `*`
 * would either throw a server-side pattern error or change the match semantics.
 */
export function escapeRegExp(value: unknown): string {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
