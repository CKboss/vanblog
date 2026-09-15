import Link from "next/link";
import React, { useMemo, useState } from "react";
import AlertCard from "../AlertCard";
import ArticleCover from "../ArticleCover";
import CopyRight from "../CopyRight";
import Reward from "../Reward";
import TopPinIcon from "../TopPinIcon";
import UnLockCard from "../UnLockCard";
import CommentArea from "../CommentArea";
import ListThumb from "./ListThumb";
import { listCardImage } from "../../utils/firstImage";
import { withThumbnailImages } from "../../utils/excerptThumbs";
import { tagChipStyle } from "../../utils/tagColor";
import { encodeQuerystring } from "../../utils/encode";

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
  /**
   * 服务端算好的列表摘要（列表接口带 withExcerpt 时下发，此时 content 不再进
   * __NEXT_DATA__）。语义与 articleOverviewMarkdown 逐字符一致，对照测试在
   * __tests__/articleExcerptParity.spec.ts；缺失（老缓存页）时回退本地计算。
   */
  excerpt?: string;
  /** 服务端算好的正文首图（同上）；缺失时回退本地扫 content。cover 仍然优先。 */
  firstImage?: string;
  /** 正文渲染器；不传就用轻量版（列表摘要）。文章页会传完整版。 */
  markdownRenderer?: React.ComponentType<{ content: string }>;
  /** 数字 id：后台「编辑」链接要用它（props.id 可能是拼音别名）。 */
  numericId?: number | string;
}) {
  const [lock, setLock] = useState(props.type != "overview" && props.private);
  const { content, setContent } = props;
  // 内置评论的规范键：**数字 id**。
  // 一篇文章有 /post/<数字id> 和 /post/<拼音别名> 两个访问路径，别名还可能被改；
  // 用数字 id 存评论才不会在改别名之后「评论凭空消失」（waline 时代的历史评论
  // 也正好是数字形式）。服务端查询时还会把两种路径当同一篇展开，所以老数据也认。
  const commentPath = useMemo(
    () =>
      props.type == "about"
        ? "/about"
        : "/post/" + (props.numericId ?? props.id),
    [props.type, props.id, props.numericId],
  );
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
      // 列表摘要里的图换成 300px 缩略图（原图实测能到 3.5MB，摘要里根本看不清）；
      // 点开放大仍然是原图（img.tsx 会补 data-zoom-src）。文章页正文不走这个分支。
      // 摘要优先用 server 算好的 props.excerpt（withExcerpt 的列表响应里没有 content，
      // 首页因此少背 25KB 全文）；老缓存页没有这个字段就照旧本地算，两边结果一致。
      return withThumbnailImages(props.excerpt ?? articleOverviewMarkdown(content));
    } else {
      return content.replace("<!-- more -->", "");
    }
  }, [props, lock, content]);

  const showToc = useMemo(() => {
    if (!hasToc(props.content)) return false;
    if (props.type == "article") return true;
    return false;
  }, [props.type, props.content]);

  // 列表卡的缩略图：cover 优先，没有就取**正文首图**。
  // 首图优先用 server 算好的 props.firstImage（withExcerpt 的列表响应里没有 content，
  // 本地扫不到图）；老缓存页没有这个字段才回退到本地扫完整正文 —— 都不是 calContent
  // （摘要只有 200 字，首图常常在后面）。
  // 本站 53 篇文章一张 cover 都没设，而 Apple 皮肤的列表是「白底 + 发丝线 + 灰字」，
  // 没有图就只剩黑白灰 —— 这是「看起来很单调」的主因之一。
  const listImage = useMemo(
    () =>
      props.type == "overview"
        ? listCardImage(props.cover, content, props.firstImage)
        : null,
    [props.type, props.cover, props.firstImage, content],
  );
  // 标签做成柔和的彩色胶囊（Apple 的做法：大面积中性色 + 少量低饱和彩色）
  const overviewTags = useMemo(
    () => (props.type == "overview" ? (props.tags || []).filter(Boolean).slice(0, 3) : []),
    [props.type, props.tags],
  );

  return (
    <div className="post-card-wrapper">
      <div
        style={{ position: "relative" }}
        id="post-card"
        className="overflow-hidden post-card bg-white card-shadow py-4 px-1 sm:px-3 md:py-6 md:px-5 dark:bg-dark  dark:nav-shadow-dark"
      >
        {listImage ? (
          // 桌面端 CSS 让它浮动到右侧（文字左、图右，Apple News 的排法）；窄屏时不浮动，
          // 排在标题上方。没有图的文章就是**纯文字卡**，不放假图（见 ListThumb 的注释）。
          <ListThumb
            key={listImage.src}
            src={listImage.src}
            fallback={listImage.fallback}
            alt={props.title}
          />
        ) : null}
        {props.type == "article" && (
          <ArticleCover src={props.cover} alt={props.title} />
        )}
        {props.top != 0 && <TopPinIcon></TopPinIcon>}
        <Title
          type={props.type}
          id={props.id}
          numericId={props.numericId}
          title={props.title}
          openArticleLinksInNewWindow={props.openArticleLinksInNewWindow}
          showEditButton={props.showEditButton}
        />

        <SubTitle
          openArticleLinksInNewWindow={props.openArticleLinksInNewWindow}
          type={props.type}
          id={props.id}
          numericId={props.numericId}
          updatedAt={props.updatedAt}
          createdAt={props.createdAt}
          catelog={props.catelog}
          enableComment={props.enableComment}
        />
        {overviewTags.length > 0 && (
          <div className="post-card-chips">
            {overviewTags.map((tag) => (
              <Link key={tag} href={`/tag/${encodeQuerystring(tag)}`}>
                <span className="post-card-chip" style={tagChipStyle(tag)}>
                  {tag}
                </span>
              </Link>
            ))}
          </div>
        )}
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
        // 三选一的分支逻辑收在 CommentArea 里（enableComment 是字符串 "true"/"false"，
        // 直接当条件用会对 "false" 也为真，那边做了显式比较）
        <CommentArea path={commentPath} enable={props.enableComment} visible={true} />
      )}
    </div>
  );
}
