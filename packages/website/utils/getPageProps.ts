import { getPublicMeta } from "../api/getAllData";
import { IndexPageProps } from "../pages/index";
import { TagPageProps } from "../pages/tag";
import { TimeLinePageProps } from "../pages/timeline";
import { CategoryPageProps } from "../pages/category";
import { getAuthorCardProps, getLayoutProps } from "./getLayoutProps";
import { sanitizeArticlesPerPage } from "./articlesPerPage";
import { washArticlesByKey } from "./washArticles";
import { AboutPageProps } from "../pages/about";
import { TagPagesProps } from "../pages/tag/[tag]";
import { PostPagesProps } from "../pages/post/[id]";
import { PagePagesProps } from "../pages/page/[p]";
import { CategoryPagesProps } from "../pages/category/[category]";
import {
  getArticleByIdOrPathname,
  getArticlesByCategory,
  getArticlesByOption,
  getArticlesByTimeLine,
} from "../api/getArticles";
import { LinkPageProps } from "../pages/link";
import { isListedPublicCategory } from "./publicCategories";
import { groupTimelineByYearAndMonth } from "./timelineMonths";
import { Article } from "../types/article";

export async function getIndexPageProps(): Promise<IndexPageProps> {
  const data = await getPublicMeta();
  const layoutProps = getLayoutProps(data);
  const authorCardProps = getAuthorCardProps(data);
  const pageSize = sanitizeArticlesPerPage(data.meta.siteInfo?.articlesPerPage);
  const { articles } = await getArticlesByOption({
    page: 1,
    // 列表卡只需要摘要和首图，让 server 直接算好（withExcerpt）并把全文 content 剥掉：
    // 首页以前把 5 篇全文（25,053 B）塞进 __NEXT_DATA__，而卡片只渲染 3,263 B 摘要，
    // 87% 白送（__NEXT_DATA__ 占首页 gzip 体积 54.8%）。
    toListView: true,
    withExcerpt: true,
    pageSize,
  });
  return {
    layoutProps,
    articles,
    currPage: 1,
    authorCardProps,
  };
}

export async function getTimeLinePageProps(): Promise<TimeLinePageProps> {
  const data = await getPublicMeta();
  const layoutProps = getLayoutProps(data);
  const authorCardProps = getAuthorCardProps(data);
  // /api/public/timeline 返回「年份 → 该年文章列表」。显式标注元素类型：
  // 取数函数没有返回类型时结果是 any，TS 5.9 不再把 T 推断成 any，而是回退到
  // 约束上界 TimelineArticleLike，与 TimeLinePageProps 声明的
  // TimelineYearGroup<Article>[] 对不上（content 可选 vs 必填）。
  // 这里的标注与 server 端 getTimeLineInfo 自己的 `Record<string, Article[]>`
  // 以及下游组件（TimelineArchives/TimeLineItem/ArticleList）的既有契约一致。
  const sortedArticles: Record<string, Article[]> =
    (await getArticlesByTimeLine()) || {};
  const yearGroups = groupTimelineByYearAndMonth(sortedArticles);
  const wordTotal = data.totalWordCount;
  return {
    layoutProps,
    authorCardProps,
    // sortedArticles 不再往 pageProps 里塞：它已经被 yearGroups 完整表达，
    // 多塞一份等于让每个访客下载 21KB 没人读的数据（见 TimeLinePageProps 的说明）。
    yearGroups,
    wordTotal,
  };
}
export async function getTagPageProps(): Promise<TagPageProps> {
  const data = await getPublicMeta();
  const layoutProps = getLayoutProps(data);
  const authorCardProps = getAuthorCardProps(data);
  const tags = data.tags;
  return {
    layoutProps,
    authorCardProps,
    tags,
  };
}
export async function getCategoryPageProps(): Promise<CategoryPageProps> {
  const data = await getPublicMeta();
  const layoutProps = getLayoutProps(data);
  const authorCardProps = getAuthorCardProps(data);
  const wordTotal = data.totalWordCount;
  const sortedArticles = await getArticlesByCategory();
  return {
    layoutProps,
    authorCardProps,
    wordTotal,
    sortedArticles,
  };
}
export async function getLinkPageProps(): Promise<LinkPageProps> {
  const data = await getPublicMeta();
  const layoutProps = getLayoutProps(data);
  const authorCardProps = getAuthorCardProps(data);
  return {
    layoutProps,
    authorCardProps,
    links: data.meta.links,
  };
}
export async function getAboutPageProps(): Promise<AboutPageProps> {
  const data = await getPublicMeta();
  const layoutProps = getLayoutProps(data);
  const authorCardProps = getAuthorCardProps(data);
  const about = data.meta.about;
  let showDonateInfo: "true" | "false" = "true";
  if (data.meta.siteInfo?.showDonateInfo == "false") {
    showDonateInfo = "false";
  }
  let showDonateInAbout: "true" | "false" = "false";

  if (data.meta.siteInfo?.showDonateInAbout == "true") {
    showDonateInAbout = "true";
  }
  if (data.meta.siteInfo?.showDonateButton == "false") {
    showDonateInAbout = "false";
  }
  const payProps = {
    pay: [
      data.meta.siteInfo?.payAliPay || "",
      data.meta.siteInfo?.payWechat || "",
    ],
    payDark: [
      data.meta.siteInfo?.payAliPayDark || "",
      data.meta.siteInfo?.payWechatDark || "",
    ],
  };
  return {
    showDonateInfo,
    layoutProps,
    authorCardProps,
    about,
    donates: data.meta?.rewards || [],
    showDonateInAbout,
    ...payProps,
  };
}
export async function getTagPagesProps(
  currTag: string
): Promise<TagPagesProps> {
  const data = await getPublicMeta();
  const layoutProps = getLayoutProps(data);
  const authorCardProps = getAuthorCardProps(data);
  const {
    articles: articlesInThisTag,
    total,
    totalWordCount,
  } = await getArticlesByOption({
    page: 1,
    pageSize: -1,
    tags: currTag,
    withWordCount: true,
    toListView: true,
  });
  const wordTotal = totalWordCount || 0;
  const curNum = total;
  const sortedArticles = washArticlesByKey(
    articlesInThisTag,
    (each) => new Date(each.createdAt).getFullYear(),
    false
  );
  return {
    layoutProps,
    authorCardProps,
    currTag,
    sortedArticles,
    curNum,
    wordTotal,
  };
}

export async function getPostPagesProps(
  curId: string
): Promise<PostPagesProps> {
  const data = await getPublicMeta();
  const layoutProps = getLayoutProps(data);
  const payProps = {
    pay: [
      data.meta.siteInfo?.payAliPay || "",
      data.meta.siteInfo?.payWechat || "",
    ],
    payDark: [
      data.meta.siteInfo?.payAliPayDark || "",
      data.meta.siteInfo?.payWechatDark || "",
    ],
  };
  const currArticleProps = await getArticleByIdOrPathname(curId);
  const { article } = currArticleProps;
  const author = article?.author || data.meta.siteInfo.author;
  return {
    layoutProps,
    ...currArticleProps,
    ...payProps,
    author,
    showSubMenu: layoutProps.showSubMenu,
    siteUrl: data.meta.siteInfo?.baseUrl || "",
  };
}
export async function getPagePagesProps(
  curId: string
): Promise<PagePagesProps> {
  const data = await getPublicMeta();
  const layoutProps = getLayoutProps(data);
  const authorCardProps = getAuthorCardProps(data);
  const currPage = parseInt(curId);
  const pageSize = sanitizeArticlesPerPage(data.meta.siteInfo?.articlesPerPage);
  const { articles } = await getArticlesByOption({
    page: currPage,
    // 同 getIndexPageProps：分页页也是列表卡，只要摘要不要全文
    toListView: true,
    withExcerpt: true,
    pageSize,
  });
  return {
    layoutProps,
    articles,
    currPage,
    authorCardProps,
  };
}
export async function getCategoryPagesProps(
  curCategory: string
): Promise<CategoryPagesProps | { notFound: true }> {
  const data = await getPublicMeta();
  if (!isListedPublicCategory(curCategory, data.meta.categories)) {
    return { notFound: true };
  }
  const authorCardProps = getAuthorCardProps(data);
  const layoutProps = getLayoutProps(data);
  const {
    articles: articlesInThisCategory,
    total,
    totalWordCount,
  } = await getArticlesByOption({
    page: 1,
    pageSize: -1,
    category: curCategory,
    withWordCount: true,
    toListView: true,
  });

  const wordTotal = totalWordCount as number;
  const curNum = total;
  const sortedArticles = washArticlesByKey(
    articlesInThisCategory,
    (each) => each.category,
    false
  );
  return {
    layoutProps,
    curCategory,
    sortedArticles,
    authorCardProps,
    wordTotal,
    curNum,
  };
}
