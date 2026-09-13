import React, { useState } from "react";

/**
 * 列表卡的缩略图。
 *
 * 优先用 300px 缩略图（`/static/img/thumb/…`），因为一屏十几张图用原图太浪费；
 * 但缩略图可能不存在（老图没跑过「补缩略图」），所以失败时回退到原图，
 * 原图也失败就**整块不渲染**——绝不留下一个破图标或空白框。
 *
 * 只有 Apple 皮肤会显示它（CSS 里控制），默认皮肤的版面完全不变。
 */
export default function ListThumb(props: {
  src: string;
  fallback: string | null;
  alt: string;
}) {
  const [current, setCurrent] = useState(props.src);
  const [failed, setFailed] = useState(false);

  if (failed || !current) {
    return null;
  }
  return (
    <div className="post-card-thumb-wrap">
      <img
        className="post-card-thumb"
        src={current}
        alt={props.alt}
        loading="lazy"
        decoding="async"
        onError={() => {
          if (props.fallback && current !== props.fallback) {
            setCurrent(props.fallback);
          } else {
            setFailed(true);
          }
        }}
      />
    </div>
  );
}
