import Head from "next/head";
import {useEffect, useState, useMemo} from "react";
import { getArticlesByOption } from "../../api/getArticles";
import Layout from "../../components/Layout";
import PostCard from "../../components/PostCard";
import Toc from "../../components/Toc";
import { Article } from "../../types/article";
import { articleShareImageMeta } from "../../utils/articleCover";
import { encodeLocationPath } from "../../utils/encodeLocationPath";
import { getArticlePath } from "../../utils/getArticlePath";
import { articleThumbAvif } from "../../utils/firstImage";
import {
  articleJsonLd,
  breadcrumbJsonLd,
  canonicalUrl,
  jsonLdString,
  toPlainText,
} from "../../utils/seo";
import { resolveArticleCoverUrl } from "../../utils/articleCover";
import { encodeQuerystring } from "../../utils/encode";
import { LayoutProps } from "../../utils/getLayoutProps";
import { getPostPagesProps } from "../../utils/getPageProps";
import { hasToc } from "../../utils/hasToc";
import { getArticlesKeyWord } from "../../utils/keywords";
import { revalidate } from "../../utils/loadConfig";
import { RelatedArticle } from "../../utils/relatedArticles";
import { toSafeIsoString } from "../../utils/safeDate";
import Custom404 from "../404";
import dynamic from "next/dynamic";

// 完整渲染器（按正文内容在 轻量/含 KaTeX+mermaid 之间挑）只由文章页/关于页引用，
// 列表页不会因此背上 KaTeX。
const FullMarkdown = dynamic(() => import("../../components/Markdown"), {
  ssr: true,
});

export interface PostPagesProps {
  layoutProps: LayoutProps;
  article: Article;
  pay: string[];
  payDark: string[];
  author: string;
  pre: {
    id: number;
    title: string;
    pathname?: string;
  };
  next: {
    id: number;
    title: string;
    pathname?: string;
  };
  showSubMenu: "true" | "false";
  siteUrl: string;
  /**
   * 相关文章（详情 payload 的可选字段，api/getArticles.ts 已在边界 normalize：
   * 最多 5 条、脏数据已剔除）。缺失时为 undefined，RelatedArticles 整块不渲染。
   */
  relatedArticles?: RelatedArticle[];
}
const PostPages = (props: PostPagesProps) => {
  const [content, setContent] = useState(props?.article?.content || "");
  // 文章摘要（meta description / og:description 共用）：正文压成纯文本，最多 160 字
  const articleDescription = useMemo(
    () => toPlainText(props?.article?.content, 160),
    [props?.article?.content],
  );
  // Invalid Date 时 toISOString() 会抛 RangeError —— 以前直接写在 JSX 里，
  // 一条坏日期数据就能让整篇文章在 SSR 阶段 500。这里统一走 NaN 守卫。
  const publishedIso = useMemo(
    () => toSafeIsoString(props?.article?.createdAt),
    [props?.article?.createdAt],
  );
  const modifiedIso = useMemo(
    () => toSafeIsoString(props?.article?.updatedAt),
    [props?.article?.updatedAt],
  );
  // 结构化数据：BlogPosting + 面包屑。有了它搜索引擎才可能给富摘要（发布时间、作者、配图）
  const jsonLd = useMemo(() => {
    const url = canonicalUrl(props.siteUrl, `/post/${getArticlePath(props.article)}`);
    const list = [
      articleJsonLd({
        title: props.article.title,
        description: articleDescription,
        url,
        imageUrl: resolveArticleCoverUrl(props.article.cover, props.siteUrl),
        datePublished: props.article.createdAt,
        dateModified: props.article.updatedAt,
        authorName: props.author || props.layoutProps.siteName,
        category: props.article.category,
        tags: props.article.tags,
        siteName: props.layoutProps.siteName,
        siteUrl: props.siteUrl,
        logoUrl: resolveArticleCoverUrl(props.layoutProps.logo, props.siteUrl),
      }),
    ];
    const crumbs = [{ name: props.layoutProps.siteName || "首页", path: "/" }];
    if (props.article.category) {
      crumbs.push({
        name: props.article.category,
        path: `/category/${encodeQuerystring(props.article.category)}`,
      });
    }
    crumbs.push({ name: props.article.title, path: `/post/${getArticlePath(props.article)}` });
    const breadcrumb = breadcrumbJsonLd(props.siteUrl, crumbs);
    if (breadcrumb) {
      list.push(breadcrumb);
    }
    return list;
    // ⚠️ 依赖写具体字段而不是 props：props 每次渲染都是新引用，
    // 以它为依赖等于每次重渲染都把 JSON-LD 重新构建一遍
  }, [props.siteUrl, props.article, props.author, props.layoutProps, articleDescription]);
  useEffect(() => {
    // nextjs 切换页面时，不会重新设置 content ，需要手动更新
    setContent(props?.article?.content || "")
  }, [props.article])
  // hasToc 会把整篇正文过一遍 unified 管线来数标题 —— 以前直接写在 JSX 里，
  // 每次重渲染（访客统计 setState、路由事件都会触发）都全文重解析一遍
  const sideBarHasToc = useMemo(() => hasToc(content), [content]);
  if (!props.article) {
    return <Custom404 name="文章" />;
  }
  return (
    <Layout
      option={props.layoutProps}
      title={props.article.title}
      sideBar={
        sideBarHasToc ? (
          <Toc content={content} showSubMenu={props.showSubMenu} />
        ) : null
      }
    >
      <Head>
        <meta
          name="keywords"
          content={getArticlesKeyWord([props.article]).join(",")}
        ></meta>
        {/* 每篇文章自己的摘要：以前所有页面共用站点描述，搜索结果里的摘要千篇一律，
            点击率差，也浪费了正文里现成的信息 */}
        {articleDescription ? (
          <meta name="description" content={articleDescription} />
        ) : null}
        {articleDescription ? (
          <meta property="og:description" content={articleDescription} />
        ) : null}
        {articleDescription ? (
          <meta name="twitter:description" content={articleDescription} />
        ) : null}
        <meta property="og:type" content="article" />
        <meta name="twitter:title" content={props.article.title} />
        {publishedIso ? (
          <meta
            property="article:published_time"
            content={publishedIso}
          />
        ) : null}
        {modifiedIso ? (
          <meta
            property="article:modified_time"
            content={modifiedIso}
          />
        ) : null}
        {props.article.category ? (
          <meta property="article:section" content={props.article.category} />
        ) : null}
        {(props.article.tags || []).map((tag: string) => (
          <meta key={`article-tag-${tag}`} property="article:tag" content={tag} />
        ))}
        {jsonLd.map((data, index) => (
          <script
            key={`ld-${index}`}
            type="application/ld+json"
            // JSON.stringify 已经把内容转义过（jsonLdString 还会把 < 换成 \u003c），
            // 不存在从这里注入脚本的可能
            dangerouslySetInnerHTML={{ __html: jsonLdString(data) }}
          />
        ))}
        {props.article.cover ? (
          // 封面是文章页的 LCP 元素，提前 preload 省掉「HTML→CSS→发现图片」的往返
          <link rel="preload" as="image" href={props.article.cover} />
        ) : null}
        {articleShareImageMeta(props.article.cover, props.siteUrl).map(
          (tag, index) =>
            "property" in tag ? (
              <meta key={`og-${index}`} property={tag.property} content={tag.content} />
            ) : (
              <meta key={`tw-${index}`} name={tag.name} content={tag.content} />
            )
        )}
      </Head>
      {/* 皮肤作用域：styles/apple.css 用 .vanblog-article-page 收窄阅读栏宽 */}
      <div className="vanblog-article-page">
      <PostCard
        markdownRenderer={FullMarkdown}
        showEditButton={props.layoutProps.showEditButton === "true"}
        showExpirationReminder={
          props.layoutProps.showExpirationReminder == "true"
        }
        copyrightAggreement={props.layoutProps.copyrightAggreement}
        openArticleLinksInNewWindow={
          props.layoutProps.openArticleLinksInNewWindow == "true"
        }
        customCopyRight={props.article.copyright || null}
        top={props.article.top || 0}
        id={getArticlePath(props.article)}
        numericId={props.article.id}
        viewer={props.article.viewer}
        readingMinutes={props.article?.readingMinutes}
        thumbAvif={articleThumbAvif(props.article)}
        relatedArticles={props.relatedArticles}
        key={props.article.title}
        title={props.article.title}
        updatedAt={new Date(props.article.updatedAt)}
        createdAt={new Date(props.article.createdAt)}
        catelog={props.article.category}
        content={content}
        setContent={setContent}
        type={"article"}
        pay={props.pay}
        payDark={props.payDark}
        private={props.article.private}
        author={props.author}
        tags={props.article.tags}
        cover={props.article.cover}
        pre={props.pre}
        next={props.next}
        enableComment={props.layoutProps.enableComment}
        hideDonate={props.layoutProps.showDonateButton == "false"}
        hideCopyRight={props.layoutProps.showCopyRight == "false"}
      ></PostCard>
      </div>
    </Layout>
  );
};

export default PostPages;

export async function getStaticPaths() {
  const data = await getArticlesByOption({
    page: 1,
    pageSize: -1,
    toListView: true,
  });
  const paths = data.articles.map((article) => ({
    params: {
      id: String(getArticlePath(article)),
    },
  }));
  return {
    paths,
    fallback: "blocking",
  };
}

export async function getStaticProps({
  params,
}: any): Promise<{
  props?: PostPagesProps;
  notFound?: boolean;
  redirect?: { destination: string; permanent: boolean };
  revalidate?: number;
}> {
  const props = await getPostPagesProps(params.id);
  if (!props?.article) {
    // 以前是渲染 Custom404 但返回 200：既骗搜索引擎（软 404），
    // 也会在后端抖动时把 ISR 缓存里的好页面换成这个软 404
    return { notFound: true, ...revalidate };
  }
  // 一篇文章有两个入口：/post/<数字id> 和 /post/<拼音别名>，以前两个都返回 200，
  // 搜索引擎会当成重复内容、把权重拆成两份，阅读量也按 pathname 分家。
  // 现在非规范地址一律 301 到规范地址（有别名用别名，没有就用数字 id）。
  const canonical = getArticlePath(props.article);
  const requested = String(params?.id ?? "");
  if (canonical && requested !== canonical) {
    // 访问的是 /post/<数字id> 而这篇文章有别名 → 301 到别名（别名才是规范地址）。
    // Next 对 permanent:true 返回 308，搜索引擎按 301 同等处理。
    return {
      // ⚠️ 必须过 encodeLocationPath：自定义别名是中文时，Location 头里出现非 Latin-1 字符，
      //    Node 的 setHeader 会抛 "Cannot convert argument to a ByteString"，这篇文章直接 500
      //    （本地用假数据测不出来，只有真实数据里有中文别名才会踩到）。
      redirect: {
        destination: `/post/${encodeLocationPath(canonical)}`,
        permanent: true,
      },
      ...revalidate,
    };
  }
  return { props, ...revalidate };
}
