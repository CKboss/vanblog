import React, { useEffect, useState } from "react";
import { getCachedCount, requestCommentCount } from "../../utils/commentApi";

/**
 * 文章卡片/文章页上的评论数。
 *
 * 用 `requestCommentCount()` 的批量合并（50ms 内的请求合成一次 /counts），
 * 所以列表页十几篇卡片也只会有一个请求，不会像逐个 fetch 那样打爆后端。
 *
 * ⚠️ `undefined` = **这次没取到**（接口失败/被限流），保持 "…" 占位符；
 * 只有拿到真实数字才渲染数字。以前失败会 `setCount(0)`，把"请求失败"
 * 渲染成和"确实没有评论"一模一样的 0，而且失败还会被缓存一整个会话。
 */
export default function CommentCount({ path }: { path: string }) {
  const [count, setCount] = useState<number | null>(() => {
    const cached = getCachedCount(path);
    return cached === undefined ? null : cached;
  });

  useEffect(() => {
    let alive = true;
    requestCommentCount(path)
      .then((n) => {
        if (alive) {
          setCount(n === undefined ? null : n);
        }
      })
      .catch(() => {
        if (alive) {
          setCount(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [path]);

  if (count === null) {
    return <span className="van-comment-count">…</span>;
  }
  return <span className="van-comment-count">{count}</span>;
}
