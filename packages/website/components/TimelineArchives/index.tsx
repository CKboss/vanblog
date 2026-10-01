import TimeLineItem from "../TimeLineItem";
import {
  TimelineYearGroup,
  type TimelineArticleRef,
} from "../../utils/timelineMonths";

import useT from "../../hooks/useT";
export default function TimelineArchives(props: {
  yearGroups: TimelineYearGroup<TimelineArticleRef>[];
  openArticleLinksInNewWindow: boolean;
}) {
  // 🔴 期 10 第十二批：走 i18n 接缝（渲染期取）
  const t = useT();
  if (!props.yearGroups.length) {
    return null;
  }
  return (
    <div className="flex flex-col mt-2 vanblog-timeline">
      {props.yearGroups.map((yearGroup) => {
        if (yearGroup.months.length === 0) {
          return (
            <section
              key={yearGroup.year}
              data-timeline-year={String(yearGroup.year)}
            >
              <TimeLineItem
                openArticleLinksInNewWindow={props.openArticleLinksInNewWindow}
                defaultOpen={true}
                date={yearGroup.label}
                articles={yearGroup.articles}
              ></TimeLineItem>
            </section>
          );
        }
        return (
          <section
            key={yearGroup.year}
            data-timeline-year={String(yearGroup.year)}
            className="mb-6 last:mb-0"
          >
            <div className="flex items-center mb-3">
              <h2 className="text-xl md:text-2xl font-bold dark:text-dark">
                {yearGroup.label}
              </h2>
              <div className="ml-2 text-sm md:text-base text-gray-400 font-normal dark:text-dark-400">{t("timeline.articleCount", "{n}篇", { n: yearGroup.count })}</div>
            </div>
            <div className="pl-3 md:pl-4 border-l border-gray-200 dark:border-dark-2">
              {yearGroup.months.map((monthGroup) => (
                <div
                  key={monthGroup.key}
                  data-timeline-month={monthGroup.key}
                >
                  <TimeLineItem
                    openArticleLinksInNewWindow={
                      props.openArticleLinksInNewWindow
                    }
                    defaultOpen={true}
                    compact={true}
                    date={monthGroup.label}
                    articles={monthGroup.articles}
                  ></TimeLineItem>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
