import dayjs from "dayjs";
import { useMemo } from "react";
import { DonateItem } from "../api/getAllData";
import AuthorCard, { AuthorCardProps } from "../components/AuthorCard";
import Layout from "../components/Layout";
import PostCard from "../components/PostCard";
import { LayoutProps, AboutTitleCopy } from "../utils/getLayoutProps";
import { getAboutPageProps } from "../utils/getPageProps";
import { revalidate } from "../utils/loadConfig";
import dynamic from "next/dynamic";

// 完整渲染器（按正文内容在 轻量/含 KaTeX+mermaid 之间挑）只由文章页/关于页引用，
// 列表页不会因此背上 KaTeX。
const FullMarkdown = dynamic(() => import("../components/Markdown"), {
  ssr: true,
});
export interface About {
  updatedAt: string;
  content: string;
}
export interface AboutPageProps {
  // ⚠️ 这一页是全站**唯一**读 aboutTitle 的地方 ⇒ 只有它带上这个字段
  layoutProps: LayoutProps & AboutTitleCopy;
  authorCardProps: AuthorCardProps;
  donates: DonateItem[];
  about: About;
  pay: string[];
  payDark: string[];
  showDonateInfo: "true" | "false";
  showDonateInAbout: "true" | "false";
}
const getDonateTableMarkdown = (donates: DonateItem[]) => {
  let content = `
## 捐赠信息

| 捐赠人 | 捐赠金额|捐赠时间|
|---|---|---|
  `;
  for (const each of donates) {
    content =
      content +
      `|${each.name}|${each.value} 元|${dayjs(each.updatedAt).format(
        "YYYY-MM-DD HH:mm:ss"
      )}|\n`;
  }
  return content;
};
const AboutPage = (props: AboutPageProps) => {
  const content = useMemo(() => {
    if (props.donates.length == 0 || props.showDonateInfo == "false") {
      return props.about.content;
    } else {
      return `${props.about.content}${getDonateTableMarkdown(props.donates)}`;
    }
    // 依赖写具体字段：props 对象每次渲染都是新引用，[props] 等于没有 memo
    // （捐赠表拼接 + dayjs 格式化会在每次重渲染时白跑一遍）
  }, [props.donates, props.showDonateInfo, props.about]);

  return (
    <Layout
      title={props.layoutProps.aboutTitle}
      option={props.layoutProps}
      sideBar={<AuthorCard option={props.authorCardProps} />}
    >
      {/* 关于页是完整正文，不能被列表页的摘要截断规则裁掉 */}
      <div className="vanblog-article-page">
      <PostCard
        markdownRenderer={FullMarkdown}
        setContent={() => {}}
        showExpirationReminder={
          props.layoutProps.showExpirationReminder == "true"
        }
        openArticleLinksInNewWindow={false}
        id={0}
        key={"about"}
        private={false}
        title={props.layoutProps.aboutTitle}
        updatedAt={new Date(props.about.updatedAt)}
        createdAt={new Date(props.about.updatedAt)}
        pay={props.pay}
        payDark={props.payDark}
        catelog={"about"}
        content={content}
        type={"about"}
        enableComment={props.layoutProps.enableComment}
        top={0}
        customCopyRight={null}
        showDonateInAbout={props.showDonateInAbout == "true"}
        copyrightAggreement={props.layoutProps.copyrightAggreement}
        showEditButton={props.layoutProps.showEditButton === "true"}
      ></PostCard>
      </div>
    </Layout>
  );
};

export default AboutPage;
export async function getStaticProps(): Promise<{
  props: AboutPageProps;
  revalidate?: number;
}> {
  return {
    props: await getAboutPageProps(),
    ...revalidate,
  };
}
