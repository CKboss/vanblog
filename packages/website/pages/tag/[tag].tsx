import { getPublicMeta } from "../../api/getAllData";
import AuthorCard, { AuthorCardProps } from "../../components/AuthorCard";
import Layout from "../../components/Layout";
import TimeLineItem from "../../components/TimeLineItem";
import { LayoutProps } from "../../utils/getLayoutProps";
// ⚠️ 窄类型：同 /category，这一页的文章只经 TimeLineItem → ArticleList 渲染，每篇只读 4 个字段
import { type TimelineArticleRef } from "../../utils/timelineMonths";
import { getTagPagesProps } from "../../utils/getPageProps";
import { revalidate } from "../../utils/loadConfig";
import Custom404 from "../404";
import useT from "../../hooks/useT";
export interface TagPagesProps {
  layoutProps: LayoutProps;
  authorCardProps: AuthorCardProps;
  currTag: string;
  sortedArticles: Record<string, TimelineArticleRef[]>;
  curNum: number;
  wordTotal: number;
}
const TagPages = (props: TagPagesProps) => {
  // 🔴 期 10 第十四批：走 i18n 接缝。
  // ⚠️ 这一行必须在**所有 early return 之前**（这个组件开头就有 `if (…) return <Custom404 …/>`）——
  // 🔴 rules of hooks：hook 的调用顺序在每次渲染必须一致，放到 early return 之后就会
  //    "有时调有时不调" ⇒ React 报 "Rendered fewer hooks than expected" 并把整棵树卸掉。
  const t = useT();
  if (Object.keys(props.sortedArticles).length == 0) {
    return <Custom404 name={t("page.tagTitle", "标签")} />;
  }
  return (
    <Layout
      option={props.layoutProps}
      title={props.currTag}
      sideBar={<AuthorCard option={props.authorCardProps}></AuthorCard>}
    >
      <div className="bg-white card-shadow dark:bg-dark dark:card-shadow-dark py-4 px-8 md:py-6 md:px-8">
        <div>
          <div className="text-2xl md:text-3xl text-gray-700 text-center dark:text-dark">
            {props.currTag}
          </div>
          <div className="text-center text-gray-600 text-sm mt-2 mb-4 font-light dark:text-dark">{t("stats.tagSummary", "{posts} 文章 × {words} 字", {
              posts: props.curNum,
              words: props.wordTotal,
            })}</div>
        </div>
        <div className="flex flex-col mt-2">
          {Object.keys(props.sortedArticles)
            .sort((a, b) => parseInt(b) - parseInt(a))
            .map((eachDate: string) => {
              return (
                <TimeLineItem
                  openArticleLinksInNewWindow={
                    props.layoutProps.openArticleLinksInNewWindow == "true"
                  }
                  defaultOpen={true}
                  key={eachDate}
                  date={eachDate}
                  articles={props.sortedArticles[eachDate]}
                ></TimeLineItem>
              );
            })}
        </div>
      </div>
    </Layout>
  );
};

export default TagPages;
export async function getStaticPaths() {
  const data = await getPublicMeta();
  const paths = data.tags.map((tag) => ({
    params: {
      tag: tag,
    },
  }));
  return {
    paths,
    fallback: "blocking",
  };
}
export async function getStaticProps({
  params,
}: any): Promise<{ props: TagPagesProps; revalidate?: number }> {
  return {
    props: await getTagPagesProps(params.tag),
    ...revalidate,
  };
}
