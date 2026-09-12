import Link from "next/link";
import React, { useMemo, useState } from "react";
import AlertCard from "../AlertCard";
import ArticleCover from "../ArticleCover";
import CopyRight from "../CopyRight";
import Reward from "../Reward";
import TopPinIcon from "../TopPinIcon";
import UnLockCard from "../UnLockCard";
import WaLine from "../WaLine";
import { PostBottom } from "./bottom";
import { SubTitle, Title } from "./title";
import { getTarget } from "../Link/tools";
import TocMobile from "../TocMobile";
import TocDrawer from "../TocDrawer";
import { hasToc } from "../../utils/hasToc";
import dynamic from "next/dynamic";

/**
 * 列表摘要固定用**轻量渲染器**（MarkdownBase：不含 KaTeX / mermaid）。
 * 摘要只有 200 字 / 4 行，里面不会有流程图，公式即使出现也只是显示成 `$E=mc^2$` 原文，
 * 点进文章页仍是完整渲染。
 *
 * 文章页 / 关于页要完整渲染时，由页面自己把渲染器通过 `markdownRenderer` 传进来
 * （见 pages/post/[id].tsx、pages/about.tsx）。**不要在 PostCard 里 import ../Markdown**：
 * 只要这个模块被引用，它内部声明的两个 dynamic chunk（base + rich）就都会算进
 * 每个用到 PostCard 的页面的首屏 JS —— 实测首页会因此多背 KaTeX 那 275KB。
 */
const OverviewMarkdown = dynamic(() => import("../Markdown/MarkdownBase"), {
  ssr: true,
});
import { articleOverviewMarkdown } from "../../utils/articleExcerpt";

export default function (props: {
  id: number | string;
  title: string;
  updatedAt: Date;
  createdAt: Date;
  catelog: string;
  content: string;
  setContent: (content: string) => void;
  type: "overview" | "article" | "about";
  pay?: string[];
  payDark?: string[];
  author?: string;
  tags?: string[];
  next?: { id: number; title: string; pathname?: string };
  pre?: { id: number; title: string; pathname?: string };
  enableComment: "true" | "false";
  top: number;
  private: boolean;
  showDonateInAbout?: boolean;
  hideDonate?: boolean;
  hideCopyRight?: boolean;
  openArticleLinksInNewWindow: boolean;
  copyrightAggreement: string;
  customCopyRight: string | null;
  showExpirationReminder: boolean;
  showEditButton: boolean;
  cover?: string | null;
  /** 正文渲染器；不传就用轻量版（列表摘要）。文章页会传完整版。 */
  markdownRenderer?: React.ComponentType<{ content: string }>;
}) {
  const [lock, setLock] = useState(props.type != "overview" && props.private);
  const { content, setContent } = props;
  const showDonate = useMemo(() => {
    if (lock) {
      return false;
    }
    if (props.hideDonate) {
      return false;
    }
    if (!props.pay || props.pay.length <= 0) {
      return false;
    }
    if (props.type == "article") {
      return true;
    }
    if (props.type == "about" && props.showDonateInAbout) {
      return true;
    }
    return false;
  }, [props, lock]);

  const calContent = useMemo(() => {
    if (props.type == "overview") {
      if (props.private) {
        return "该文章已加密，点击 `阅读全文` 并输入密码后方可查看。";
      }
      return articleOverviewMarkdown(content);
    } else {
      return content.replace("<!-- more -->", "");
    }
  }, [props, lock, content]);

  const showToc = useMemo(() => {
    if (!hasToc(props.content)) return false;
    if (props.type == "article") return true;
    return false;
  }, [props.type, props.content]);

  return (
    <div className="post-card-wrapper">
      <div
        style={{ position: "relative" }}
        id="post-card"
        className="overflow-hidden post-card bg-white card-shadow py-4 px-1 sm:px-3 md:py-6 md:px-5 dark:bg-dark  dark:nav-shadow-dark"
      >
        {props.type == "article" && (
          <ArticleCover src={props.cover} alt={props.title} />
        )}
        {props.top != 0 && <TopPinIcon></TopPinIcon>}
        <Title
          type={props.type}
          id={props.id}
          title={props.title}
          openArticleLinksInNewWindow={props.openArticleLinksInNewWindow}
          showEditButton={props.showEditButton}
        />

        <SubTitle
          openArticleLinksInNewWindow={props.openArticleLinksInNewWindow}
          type={props.type}
          id={props.id}
          updatedAt={props.updatedAt}
          createdAt={props.createdAt}
          catelog={props.catelog}
          enableComment={props.enableComment}
        />
        <div className="text-sm md:text-base  text-gray-600 mt-4 mx-2">
          {props.type == "article" && (
            <AlertCard
              showExpirationReminder={props.showExpirationReminder}
              updatedAt={props.updatedAt}
              createdAt={props.createdAt}
            ></AlertCard>
          )}
          {lock ? (
            <UnLockCard
              setLock={setLock}
              setContent={setContent}
              id={props.id}
            />
          ) : (
            <>
              {showToc && <TocMobile content={calContent} />}
              {showToc && <TocDrawer content={calContent} />}
              {(() => {
                const Renderer = props.markdownRenderer || OverviewMarkdown;
                return <Renderer content={calContent}></Renderer>;
              })()}
            </>
          )}
        </div>

        {props.type == "overview" && (
          <div className="w-full flex justify-center mt-4 ">
            <Link
              href={`/post/${props.id}`}
              target={getTarget(props.openArticleLinksInNewWindow)}
            >
              <div className=" dark:bg-dark dark:hover:bg-dark-light dark:hover:text-dark-r dark:border-dark dark:text-dark hover:bg-gray-800 hover:text-gray-50 border-2 border-gray-800 text-sm md:text-base text-gray-700 px-2 py-1 transition-all rounded">
                阅读全文
              </div>
            </Link>
          </div>
        )}
        {showDonate && props.pay && (
          <Reward
            aliPay={(props?.pay as any)[0]}
            weChatPay={(props?.pay as any)[1]}
            aliPayDark={(props?.payDark || ["", ""])[0]}
            weChatPayDark={(props?.payDark || ["", ""])[1]}
            author={props.author as any}
            id={props.id}
          ></Reward>
        )}
        {props.type == "article" && !lock && !props?.hideCopyRight && (
          <CopyRight
            customCopyRight={props.customCopyRight}
            author={props.author as any}
            id={props.id}
            showDonate={showDonate}
            copyrightAggreement={props.copyrightAggreement}
          ></CopyRight>
        )}

        <PostBottom
          type={props.type}
          lock={lock}
          tags={props.tags}
          next={props.next}
          pre={props.pre}
          openArticleLinksInNewWindow={props.openArticleLinksInNewWindow}
        />
        <div
          style={{
            height: props.type == "about" && !showDonate ? "16px" : "0",
          }}
        ></div>
      </div>
      {props.type != "overview" && (
        <WaLine enable={props.enableComment} visible={true} />
      )}
    </div>
  );
}
