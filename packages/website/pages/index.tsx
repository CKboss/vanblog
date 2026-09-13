import { jsonLdString, websiteJsonLd } from "../utils/seo";
import useCommentProvider from "../hooks/useCommentProvider";
import AuthorCard, { AuthorCardProps } from "../components/AuthorCard";
import Layout from "../components/Layout";
import PageNav from "../components/PageNav";
import PostCard from "../components/PostCard";
import { Article } from "../types/article";
import { LayoutProps } from "../utils/getLayoutProps";
import { getIndexPageProps } from "../utils/getPageProps";
import { revalidate } from "../utils/loadConfig";
import Waline from "../components/WaLine";
import Head from "next/head";
import { getArticlesKeyWord } from "../utils/keywords";
import { getArticlePath } from "../utils/getArticlePath";
export interface IndexPageProps {
  layoutProps: LayoutProps;
  authorCardProps: AuthorCardProps;
  currPage: number;
  articles: Article[];
}
const Home = (props: IndexPageProps) => {
  const commentProvider = useCommentProvider();
  return (
    <Layout
      option={props.layoutProps}
      title={props.layoutProps.siteName}
      sideBar={<AuthorCard option={props.authorCardProps}></AuthorCard>}
    >
      <Head>
        {/* 首页的站点级结构化数据：告诉搜索引擎这是一个博客、作者与站点名是什么 */}
        {props.layoutProps.siteUrl ? (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: jsonLdString(
                websiteJsonLd({
                  siteName: props.layoutProps.siteName,
                  siteUrl: props.layoutProps.siteUrl,
                  description: props.layoutProps.description,
                  authorName: props.authorCardProps?.author,
                  logoUrl: props.layoutProps.logo,
                }),
              ),
            }}
          />
        ) : null}
        <meta
          name="keywords"
          content={getArticlesKeyWord(props.articles).join(",")}
        ></meta>
      </Head>
      <div className="space-y-2 md:space-y-4">
        {props.articles.map((article) => (
          <PostCard
            showEditButton={props.layoutProps.showEditButton === "true"}
            setContent={() => {}}
            showExpirationReminder={
              props.layoutProps.showExpirationReminder == "true"
            }
            openArticleLinksInNewWindow={
              props.layoutProps.openArticleLinksInNewWindow == "true"
            }
            customCopyRight={null}
            private={article.private}
            top={article.top || 0}
            id={getArticlePath(article)}
            numericId={article.id}
            key={article.id}
            title={article.title}
            updatedAt={new Date(article.updatedAt)}
            createdAt={new Date(article.createdAt)}
            catelog={article.category}
            tags={article.tags}
            content={article.content || ""}
            type={"overview"}
            enableComment={props.layoutProps.enableComment}
            copyrightAggreement={props.layoutProps.copyrightAggreement}
          ></PostCard>
        ))}
      </div>
      <PageNav
        total={props.authorCardProps.postNum}
        current={props.currPage}
        base={"/"}
        more={"/page"}
        pageSize={props.layoutProps.articlesPerPage}
      ></PageNav>
      {/* visible={false}：这里初始化 waline 客户端只为了填充卡片上的
          .waline-comment-count。内置评论模式下评论数走本站 /counts 接口（CommentCount），
          而 waline 子进程已被停掉，所以只在 waline 模式下才渲染 */}
      {commentProvider === "waline" && (
        <Waline enable={props.layoutProps.enableComment} visible={false} />
      )}
    </Layout>
  );
};

export default Home;
export async function getStaticProps(): Promise<{
  props: IndexPageProps;
  revalidate?: number;
}> {
  return {
    props: await getIndexPageProps(),
    ...revalidate,
  };
}
