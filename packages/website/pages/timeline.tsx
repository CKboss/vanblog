import AuthorCard, { AuthorCardProps } from "../components/AuthorCard";
import Layout from "../components/Layout";
import TimelineArchives from "../components/TimelineArchives";
import { LayoutProps } from "../utils/getLayoutProps";
import { getTimeLinePageProps } from "../utils/getPageProps";
import {
  TimelineYearGroup,
  type TimelineArticleRef,
} from "../utils/timelineMonths";
import { revalidate } from "../utils/loadConfig";
export interface TimeLinePageProps {
  layoutProps: LayoutProps;
  authorCardProps: AuthorCardProps;
  // ⚠️ 这里以前还带一个 sortedArticles（按年份分好组的全部文章），但页面只用 yearGroups，
  // 那份数据会被原样序列化进 __NEXT_DATA__ 与客户端路由的 JSON（实测 21.3KB，
  // 占 /timeline pageProps 的 29%），没有任何读者。
  //
  // 🔴 而元素类型也从完整 `Article` 收窄成了 `TimelineArticleRef`（只有
  // id/title/createdAt/pathname 四个字段）：删掉 sortedArticles 之后，yearGroups 仍然
  // 带着 53 篇**完整**文章（实测 23.7KB，占 /timeline 那份 __NEXT_DATA__ 32.1KB 的 74%），
  // 而渲染链路 TimelineArchives → TimeLineItem → ArticleList 每篇**只读那 4 个字段**。
  // ⚠️ 类型收窄本身不省字节（省字节的是 getTimeLinePageProps 里的 trimTimelineYearGroups），
  //    但它让"再往 pageProps 里塞肥对象"这件事**编译不过** —— 这才是防止被悄悄改回去的关键。
  yearGroups: TimelineYearGroup<TimelineArticleRef>[];
  wordTotal: number;
}
const TimeLine = (props: TimeLinePageProps) => {
  return (
    <Layout
      title={"时间线"}
      option={props.layoutProps}
      sideBar={<AuthorCard option={props.authorCardProps} />}
    >
      <div className="bg-white card-shadow dark:bg-dark dark:card-shadow-dark py-4 px-8 md:py-6 md:px-8">
        <div>
          <div className="text-2xl md:text-3xl text-gray-700 text-center dark:text-dark">
            时间线
          </div>
          <div className="text-center text-gray-600 text-sm mt-2 mb-4 font-light dark:text-dark">{`${props.authorCardProps.catelogNum} 分类 × ${props.authorCardProps.postNum} 文章 × ${props.authorCardProps.tagNum} 标签 × ${props.wordTotal} 字`}</div>
        </div>
        <TimelineArchives
          yearGroups={props.yearGroups}
          openArticleLinksInNewWindow={
            props.layoutProps.openArticleLinksInNewWindow == "true"
          }
        />
      </div>
    </Layout>
  );
};

export default TimeLine;
export async function getStaticProps(): Promise<{
  props: TimeLinePageProps;
  revalidate?: number;
}> {
  return {
    props: await getTimeLinePageProps(),
    ...revalidate,
  };
}
