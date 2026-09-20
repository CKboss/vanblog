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
import { articleThumbAvif } from "../../utils/firstImage";
import { LayoutProps } from "../../utils/getLayoutProps";
import { getPagePagesProps } from "../../utils/getPageProps";
import { getArticlesKeyWord } from "../../utils/keywords";
import { revalidate } from "../../utils/loadConfig";
import { sanitizeArticlesPerPage } from "../../utils/articlesPerPage";
import { parsePageNumberParam } from "../../utils/pageParamShape";
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
            thumbAvif={articleThumbAvif(article)}
            viewer={article.viewer}
            readingMinutes={article.readingMinutes}
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
  // 形状校验必须在取数**之前**：这个页面是 `fallback: "blocking"`，任何没在构建期生成过的路径
  // 都会在第一次被访问时现场跑一遍完整 SSR（读 meta/settings/文章列表）并往 Next 的
  // file-system-cache 写一条，而 Next 14 的 fs cache **没有淘汰上限**。攻击者只要不停地请求
  // 互不相同的随机 URL，就能同时打 CPU、Mongo 和磁盘，而且**按 IP 限流挡不住**（每个 URL 只打一次）。
  // 这里的校验是纯字符串判定：不打 server、不查库、不做 SSR。
  //
  // 历史上这里拒绝的三种形状（都曾渲染成第 1 页并返回 200、`current` 是 NaN，
  // 于是分页高亮丢失、"下一页"链接变成 /page/NaN）：/page/abc、/page/0、/page/-3。
  // 换成共用工具后还额外挡住：超长入参、控制字符（含换行 ⇒ 日志与响应头注入的原料）、
  // 路径分隔符与 `..`（`%2F` 解码后就是 `/`）、以及超过 Number.MAX_SAFE_INTEGER 的页码
  // （`parseInt("99999999999999999999")` 之后的算术不可靠，可能把 Infinity 传给 Mongo 的 skip）。
  // ⚠️ 判定逻辑抽到 utils/pageParamShape.ts，是为了让 post/[id].tsx 用**同一套**：
  //    两边各写一份必然漂移（本仓库已经因为"同名副本各自演化"吃过亏）。
  if (parsePageNumberParam(raw) === null) {
    return { notFound: true, ...revalidate };
  }
  const props = await getPagePagesProps(raw);
  if (!props?.articles?.length) {
    // 超出范围的页码给真 404，别做成 200 的软 404 污染 ISR 缓存
    return { notFound: true, ...revalidate };
  }
  return { props, ...revalidate };
}
