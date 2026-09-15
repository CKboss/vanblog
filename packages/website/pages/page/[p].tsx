import useCommentProvider from "../../hooks/useCommentProvider";
import Head from "next/head";
import { getPublicMeta } from "../../api/getAllData";
import AuthorCard, { AuthorCardProps } from "../../components/AuthorCard";
import Layout from "../../components/Layout";
import PageNav from "../../components/PageNav";
import PostCard from "../../components/PostCard";
import Waline from "../../components/WaLine";
import { Article } from "../../types/article";
import { getArticlePath } from "../../utils/getArticlePath";
import { LayoutProps } from "../../utils/getLayoutProps";
import { getPagePagesProps } from "../../utils/getPageProps";
import { getArticlesKeyWord } from "../../utils/keywords";
import { revalidate } from "../../utils/loadConfig";
import { sanitizeArticlesPerPage } from "../../utils/articlesPerPage";
import { pageCount } from "../../components/PageNav/core";
import Custom404 from "../404";
export interface PagePagesProps {
  layoutProps: LayoutProps;
  authorCardProps: AuthorCardProps;
  currPage: number;
  articles: Article[];
}
const PagePages = (props: PagePagesProps) => {
  const commentProvider = useCommentProvider();
  if (props.articles.length == 0) {
    return <Custom404 name="页码" />;
  }
  return (
    <Layout
      option={props.layoutProps}
      title={props.layoutProps.siteName}
      sideBar={<AuthorCard option={props.authorCardProps}></AuthorCard>}
    >
      <Head>
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
            copyrightAggreement={props.layoutProps.copyrightAggreement}
            openArticleLinksInNewWindow={
              props.layoutProps.openArticleLinksInNewWindow == "true"
            }
            customCopyRight={null}
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
            excerpt={article.excerpt}
            firstImage={article.firstImage}
            type={"overview"}
            enableComment={props.layoutProps.enableComment}
            private={article.private}
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

export default PagePages;

export async function getStaticPaths() {
  const data = await getPublicMeta();
  const pageSize = sanitizeArticlesPerPage(data.meta.siteInfo?.articlesPerPage);
  const total = pageCount(data.totalArticles, pageSize);
  const paths = [];
  for (let i = 1; i <= total; i++) {
    paths.push({
      params: {
        p: String(i),
      },
    });
  }
  return {
    paths,
    fallback: "blocking",
  };
}

export async function getStaticProps({
  params,
}: any): Promise<{ props?: PagePagesProps; notFound?: boolean; revalidate?: number }> {
  const raw = String(params?.p ?? "");
  // /page/abc、/page/0、/page/-3 以前都会渲染成第 1 页并返回 200，
  // current 还是 NaN（分页高亮丢失、下一页链接变成 /page/NaN）
  if (!/^\d+$/.test(raw)) {
    return { notFound: true, ...revalidate };
  }
  const page = parseInt(raw, 10);
  if (!Number.isFinite(page) || page < 1) {
    return { notFound: true, ...revalidate };
  }
  const props = await getPagePagesProps(raw);
  if (!props?.articles?.length) {
    // 超出范围的页码给真 404，别做成 200 的软 404 污染 ISR 缓存
    return { notFound: true, ...revalidate };
  }
  return { props, ...revalidate };
}
