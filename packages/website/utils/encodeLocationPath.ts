/**
 * 把路径编码成可以安全放进 HTTP `Location` 头的形式。
 *
 * HTTP 头的值只能是 Latin-1（ByteString）：路径里有中文/emoji 时，直接塞进去会让
 * Node 在 `setHeader` 抛
 * `TypeError: Cannot convert argument to a ByteString because the character at index N ...`，
 * Next 的 `redirect()` 就整个失败 —— 表现是**这篇文章直接 500**，而只在真实数据里出现
 * （自定义别名是中文的那些文章），本地用假数据测根本碰不到。
 *
 * 规则：纯 ASCII 的路径原样返回（避免把已经编码过的 `%xx` 再编成 `%25xx`）；
 * 含非 ASCII 时按 `/` 分段做 `encodeURIComponent`（分段是为了不把路径分隔符也编掉）。
 */
export const encodeLocationPath = (path: string): string => {
  if (!path) {
    return path;
  }
  // 只含可打印 ASCII（不含控制字符）时不动它
  if (/^[\x20-\x7e]*$/.test(path)) {
    return path;
  }
  return path
    .split('/')
    .map((segment) => (segment ? encodeURIComponent(segment) : segment))
    .join('/');
};

export default encodeLocationPath;
