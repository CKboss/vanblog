import { useState } from "react";
// ⚠️ 刻意**不要** `Article`：本组件只把 sortedArticles 透传给 TimeLineItem，
//    而那条链每篇只读 4 个字段（见 utils/timelineMonths.ts 的 TimelineArticleRef）。
//    声明成完整 Article 会让调用方以为"必须传整篇"，从而把没人读的字段一路带进 pageProps
//    —— /category 改前就是这样白传了 23,795B 里的 15,291B。
import { type TimelineArticleRef } from "../../utils/timelineMonths";
import TimeLineItem from "../TimeLineItem";
import {
  CATEGORY_COLLAPSE_ALL_LABEL,
  CATEGORY_EXPAND_ALL_LABEL,
  initialCategoryOpenMap,
  setAllCategoryOpen,
} from "../../utils/categoryExpand";

export default function CategoryList(props: {
  sortedArticles: Record<string, TimelineArticleRef[]>;
  defaultExpandAll: boolean;
  openArticleLinksInNewWindow: boolean;
}) {
  const names = Object.keys(props.sortedArticles);
  const [openByName, setOpenByName] = useState(() =>
    initialCategoryOpenMap(names, props.defaultExpandAll)
  );

  return (
    <div className="flex flex-col mt-2 vanblog-category-list">
      {names.length > 0 && (
        <div className="flex justify-end gap-3 mb-3 text-sm text-gray-500 dark:text-dark-400">
          <button
            type="button"
            data-category-expand-all=""
            className="bg-transparent border-0 p-0 cursor-pointer hover:text-gray-800 dark:hover:text-dark"
            onClick={() => setOpenByName(setAllCategoryOpen(names, true))}
          >
            {CATEGORY_EXPAND_ALL_LABEL}
          </button>
          <button
            type="button"
            data-category-collapse-all=""
            className="bg-transparent border-0 p-0 cursor-pointer hover:text-gray-800 dark:hover:text-dark"
            onClick={() => setOpenByName(setAllCategoryOpen(names, false))}
          >
            {CATEGORY_COLLAPSE_ALL_LABEL}
          </button>
        </div>
      )}
      {names.map((key: string) => {
        return (
          <TimeLineItem
            openArticleLinksInNewWindow={props.openArticleLinksInNewWindow}
            defaultOpen={props.defaultExpandAll}
            open={Boolean(openByName[key])}
            onOpenChange={(open) => {
              setOpenByName((current) => ({ ...current, [key]: open }));
            }}
            key={key}
            date={key}
            articles={props.sortedArticles[key]}
            showYear={true}
          ></TimeLineItem>
        );
      })}
    </div>
  );
}
