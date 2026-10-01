import AuthorCard, { AuthorCardProps } from "../components/AuthorCard";
import CategoryList from "../components/CategoryList";
import Layout from "../components/Layout";
import { isDefaultExpandAllCategories } from "../utils/categoryExpand";
// ⚠️ 窄类型：这一页的文章只经 CategoryList → TimeLineItem → ArticleList 渲染，每篇只读 4 个字段
import { type TimelineArticleRef } from "../utils/timelineMonths";
import { LayoutProps } from "../utils/getLayoutProps";
import { getCategoryPageProps } from "../utils/getPageProps";
import { revalidate } from "../utils/loadConfig";

import useT from "../hooks/useT";
export interface CategoryPageProps {
  layoutProps: LayoutProps;
  authorCardProps: AuthorCardProps;
  sortedArticles: Record<string, TimelineArticleRef[]>;
  wordTotal: number;
}
const CategoryPage = (props: CategoryPageProps) => {
  // 🔴 期 10 第十三批：走 i18n 接缝（渲染期取）
  const t = useT();
  return (
    <Layout
      option={props.layoutProps}
      title={t("page.categoryTitle", "分类")}
      sideBar={<AuthorCard option={props.authorCardProps} />}
    >
      <div className="bg-white card-shadow dark:bg-dark dark:card-shadow-dark py-4 px-8 md:py-6 md:px-8">
        <div>
          <div className="text-2xl md:text-3xl text-gray-700 text-center dark:text-dark">
            {t("page.categoryTitle", "分类")}
          </div>
          <div className="text-center text-gray-600 text-sm mt-2 mb-4 font-light dark:text-dark">{t("stats.categorySummary", "{categories} 分类 × {posts} 文章 × {tags} 标签 × {words} 字", {
              categories: props.authorCardProps.catelogNum,
              posts: props.authorCardProps.postNum,
              tags: props.authorCardProps.tagNum,
              words: props.wordTotal,
            })}</div>
        </div>
        <CategoryList
          sortedArticles={props.sortedArticles}
          defaultExpandAll={isDefaultExpandAllCategories(
            props.layoutProps.defaultExpandAllCategories
          )}
          openArticleLinksInNewWindow={
            props.layoutProps.openArticleLinksInNewWindow == "true"
          }
        />
      </div>
    </Layout>
  );
};

export default CategoryPage;
export async function getStaticProps(): Promise<{
  props: CategoryPageProps;
  revalidate?: number;
}> {
  return {
    props: await getCategoryPageProps(),
    ...revalidate,
  };
}
