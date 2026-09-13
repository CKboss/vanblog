import React, { useState } from "react";
import { coverStyle } from "../../utils/coverPlaceholder";

/**
 * 列表卡右侧的封面块。
 *
 * 三种状态，永远**不留空白**：
 * 1. 有图（cover 或正文首图）→ 优先用 300px 缩略图；
 * 2. 缩略图不存在（老图没跑过「补缩略图」）→ 回退原图；
 * 3. 原图也挂了，或者这篇文章根本没有图 → **抽象渐变占位封面**（色相与光斑位置都由标题哈希得出）。
 *    刻意不放标题文字：中文标题取一个字像乱码，而标题就印在封面旁边，再写一遍是冗余。
 *
 * 只有 Apple 皮肤会显示它（CSS 里控制），默认皮肤的版面完全不变。
 */
function CoverFallback({ title }: { title: string }) {
  // aria-hidden：它是纯装饰，读屏不该念出任何东西（标题本身已经在卡片上了）
  return <div className="post-card-cover-fallback" style={coverStyle(title)} aria-hidden="true" />;
}

export default function ListThumb(props: {
  /** 没有图时传 null，直接渲染占位封面 */
  src: string | null;
  fallback: string | null;
  title: string;
}) {
  const [current, setCurrent] = useState(props.src);
  const [failed, setFailed] = useState(false);

  if (!current || failed) {
    return (
      <div className="post-card-thumb-wrap">
        <CoverFallback title={props.title} />
      </div>
    );
  }
  return (
    <div className="post-card-thumb-wrap">
      <img
        className="post-card-thumb"
        src={current}
        alt={props.title}
        loading="lazy"
        decoding="async"
        onError={() => {
          if (props.fallback && current !== props.fallback) {
            setCurrent(props.fallback);
          } else {
            // 图彻底拿不到就用占位封面，绝不留破图标或空框
            setFailed(true);
          }
        }}
      />
    </div>
  );
}
