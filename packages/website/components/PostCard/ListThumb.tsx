import React, { useState } from "react";

/**
 * 列表卡右侧的缩略图（只在**真的有图**时渲染）。
 *
 * 取图优先级：cover（后台可一键「从正文首图补封面」）→ 正文首图；
 * 本站图床的图优先用 300px 缩略图，缩略图不存在（老图没跑过「补缩略图」）就回退原图，
 * 原图也拿不到就**整块不渲染**。
 *
 * ⚠️ 不要在没图时塞「渐变占位封面」之类的假图：
 * - 按标题哈希出来的颜色**不承载任何信息**，一屏五种高饱和色只会让页面变花；
 * - 一个 16:10 带圆角阴影的色块在视觉语法上就是「这里有张缩略图」，等于对读者撒谎；
 * - Apple News 对没有配图的文章就是**纯文字卡**，节奏靠字号/字重/留白/发丝线，不靠假图。
 * 真正的解法是让文章有真图（后台「从正文首图补封面」），而不是盖一层装饰。
 *
 * 只有 Apple 皮肤会显示它（CSS 里控制），默认皮肤的版面完全不变。
 *
 * AVIF（可选契约，`article.thumbAvif`）：给了 avif 就升级成
 * `<picture><source type="image/avif" srcSet=…><img …></picture>`，支持的浏览器
 * 拿更小的 AVIF，其它浏览器照旧用 <img> 的 webp 缩略图。
 * ⚠️ **没给 avif 时输出与旧版逐字节一致**（不输出 picture/source/data-zoom-src），
 * 所以 server 那头发不发这个字段，前台行为都不会坏。
 * avif 或缩略图任一加载失败都会退出 <picture> 走原有的「缩略图→原图→不渲染」回退链
 * （<picture> 里 <source> 优先级高于 img.src，不摘掉它回退就不生效）。
 */
export default function ListThumb(props: {
  src: string;
  fallback: string | null;
  alt: string;
  /** 缩略图的 AVIF 版本；缺失时不渲染 <picture>（见文件头注释） */
  avif?: string | null;
  /** 原图地址：仅在 <picture> 分支写成 data-zoom-src（放大时 medium-zoom 用它） */
  zoomSrc?: string | null;
}) {
  const [current, setCurrent] = useState(props.src);
  const [failed, setFailed] = useState(false);
  const [avifFailed, setAvifFailed] = useState(false);

  if (failed || !current) {
    return null;
  }
  const avif = !avifFailed && props.avif ? props.avif : null;
  return (
    <div className="post-card-thumb-wrap">
      {avif ? (
        <picture>
          <source type="image/avif" srcSet={avif} />
          <img
            className="post-card-thumb"
            src={current}
            alt={props.alt}
            loading="lazy"
            decoding="async"
            data-zoom-src={props.zoomSrc || current}
            onError={() => {
              setAvifFailed(true);
              if (props.fallback && current !== props.fallback) {
                setCurrent(props.fallback);
              } else {
                setFailed(true);
              }
            }}
          />
        </picture>
      ) : (
        <img
          className="post-card-thumb"
          src={current}
          alt={props.alt}
          loading="lazy"
          decoding="async"
          onError={() => {
            setAvifFailed(true);
            if (props.fallback && current !== props.fallback) {
              setCurrent(props.fallback);
            } else {
              setFailed(true);
            }
          }}
        />
      )}
    </div>
  );
}
