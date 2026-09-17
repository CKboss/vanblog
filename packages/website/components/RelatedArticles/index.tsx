import Link from "next/link";
import { useMemo, useState } from "react";
import dayjs from "dayjs";
import { getTarget } from "../Link/tools";
import { toThumbnailUrl } from "../../utils/firstImage";
import { formatReadingTime } from "../../utils/readingTime";
import {
  normalizeRelatedArticles,
  relatedArticleHref,
  type RelatedArticle,
} from "../../utils/relatedArticles";

/**
 * 文章页末尾的「相关文章」块（数据来自详情 payload 的 `relatedArticles`，最多 5 条）。
 *
 * ISR 安全：纯 pageProps 渲染 —— 没有客户端 fetch、没有 useEffect、没有新请求瀑布；
 * 构建/重验证时是什么，页面就是什么。
 *
 * 缺字段安全（server 契约是可选的，另一个代理在并行实现）：
 * `items` 缺失 / 非数组 / 空数组 / 全是脏数据 → normalize 得到 [] → **整块不渲染**
 * （不渲染空标题、不报错）。单条缺 title 用 pathname 兜底、缺 cover 不渲染图、
 * 缺 readingMinutes/updatedAt 对应小字段消失。
 */

/** 封面小图：取不到就整块消失，绝不留破图标，也不放假占位（同 ListThumb 的纪律）。 */
function RelatedThumb(props: { cover: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return null;
  }
  // ⚠️ 必须走缩略图，绝不直连原图：AGENTS §7.38.2 记录过同一张图
  // 原图 4.57MB vs 缩略图 22KB（208 倍）的教训。老图没有缩略图时 onError 整块隐藏。
  const src = toThumbnailUrl(props.cover);
  return (
    <img
      className="related-articles-thumb w-16 h-11 md:w-20 md:h-14 rounded-md object-cover flex-shrink-0"
      src={src}
      alt={props.alt}
      width={80}
      height={56}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function relatedDateLabel(raw: RelatedArticle["updatedAt"]): string | null {
  if (raw == null || raw === "") {
    return null;
  }
  const d = dayjs(raw as string | Date);
  // Invalid Date 一律不渲染（§7.54 C-17 的教训：NaN 不能流到 UI）
  return d.isValid() ? d.format("YYYY-MM-DD") : null;
}

export default function RelatedArticles(props: {
  /** 详情 payload 的 relatedArticles；类型故意收成 unknown —— 边界上统一 normalize */
  items?: unknown;
  openArticleLinksInNewWindow?: boolean;
}) {
  const items = useMemo(
    () => normalizeRelatedArticles(props.items),
    [props.items],
  );
  if (items.length === 0) {
    return null;
  }
  return (
    <section
      className="related-articles mt-6 pt-4 border-t border-gray-100 dark:border-hr-dark"
      aria-labelledby="related-articles-heading"
      data-related-articles
    >
      <h2
        id="related-articles-heading"
        className="text-sm font-normal text-gray-400 dark:text-dark tracking-wide mb-3 select-none"
      >
        相关文章
      </h2>
      <ul className="related-articles-list space-y-3">
        {items.map((item, index) => {
          const href = relatedArticleHref(item);
          const label = item.title || item.pathname || "";
          const reading = formatReadingTime(item.readingMinutes);
          const date = relatedDateLabel(item.updatedAt);
          const meta = [reading, date].filter(Boolean).join(" · ");
          const titleNode = (
            <span className="related-articles-title block text-sm md:text-base text-gray-700 dark:text-dark truncate">
              {label}
            </span>
          );
          return (
            <li
              key={item._id || href || `${label}-${index}`}
              className="related-articles-item flex items-center space-x-3"
            >
              {item.cover ? (
                <RelatedThumb cover={item.cover} alt={label} />
              ) : null}
              <div className="min-w-0 flex-1">
                {href ? (
                  <Link
                    href={href}
                    target={getTarget(!!props.openArticleLinksInNewWindow)}
                    title={label}
                    className="related-articles-link block hover:text-gray-900 dark:hover:text-dark-hover"
                  >
                    {titleNode}
                  </Link>
                ) : (
                  // 既没有别名也没有数字 id：宁可不给链接，也不给一个必 404 的链接
                  titleNode
                )}
                {meta ? (
                  <div className="related-articles-meta text-xs text-gray-400 dark:text-dark mt-0.5">
                    {meta}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
