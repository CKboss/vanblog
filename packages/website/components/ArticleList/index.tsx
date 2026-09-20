import dayjs from "dayjs";
import Link from "next/link";

import { getTarget } from "../Link/tools";
// ⚠️ 这里刻意**不要** `Article`：本组件每篇只读 4 样东西（见 TimelineArticleRef 的说明），
//    声明成完整 Article 会让调用方以为"必须传整篇"，从而把没人读的字段一路带进 pageProps。
//    收窄之后传完整 `Article` 仍然合法（结构类型），但传裁剪过的 ref 也合法 —— 这才是我们要的。
import { type TimelineArticleRef } from "../../utils/timelineMonths";
import { getArticlePath } from "../../utils/getArticlePath";

export default (props: {
  articles: TimelineArticleRef[];
  showYear?: boolean;
  openArticleLinksInNewWindow: boolean;
  onClick?: () => void;
  /** Optional data-* attr on each result <a>, used by the search dialog. */
  itemAttr?: string;
}) => (
  <div className="space-y-2" onClick={props.onClick}>
    {props.articles.map((article) => (
      <Link
        href={`/post/${getArticlePath(article)}`}
        key={article.id}
        target={getTarget(props.openArticleLinksInNewWindow)}
        {...(props.itemAttr ? { [props.itemAttr]: "" } : {})}
      >
        <div className="dark:border-dark-2 dark:hover:border-nav-dark-light flex items-center border-b pb-1 border-dashed cursor-pointer group border-gray-200 hover:border-gray-400 ">
          <div className="text-gray-400 flex-grow-0 flex-shrink-0 text-sm  group-hover:text-gray-600 dark:text-dark-400 dark:group-hover:text-dark-light">
            {dayjs(article.createdAt).format(
              props.showYear ? "YYYY-MM-DD" : "MM-DD"
            )}
          </div>
          <div className="ml-2 md:ml-4 text-base flex-grow flex-shrink overflow-hidden text-gray-600 group-hover:text-gray-800 dark:text-dark dark:group-hover:text-dark">
            {article.title}
          </div>
        </div>
      </Link>
    ))}
  </div>
);
