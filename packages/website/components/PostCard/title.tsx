import CommentCount from "../Comment/Count";
import useCommentProvider from "../../hooks/useCommentProvider";
import dayjs from "dayjs";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import CopyToClipboard from "react-copy-to-clipboard";
import toast from "react-hot-toast";
import { encodeQuerystring } from "../../utils/encode";
import PostViewer from "../PostViewer";
import { getTarget } from "../Link/tools";
import { checkLogin } from "../../utils/auth";
import { COUNT_LOADING_PLACEHOLDER } from "../../utils/countPlaceholder";
import { CopyIcon, LinkIcon } from "../CopyIcons";
import {
  SITE_NAME_COPY_LABEL,
  TITLE_COPY_CLASS,
  TITLE_COPY_LABEL,
  TITLE_COPY_TOAST,
  TITLE_LINK_COPY_CLASS,
  TITLE_LINK_COPY_LABEL,
  TITLE_LINK_COPY_TOAST,
  TITLE_SELECTABLE_CLASS,
  articleUrl,
} from "./titleCopyA11y";

/** Shared look for the small icon buttons that sit next to a title. */
const TITLE_ACTION_BUTTON_CLASS =
  "bg-transparent border-0 appearance-none p-1 cursor-pointer text-gray-400 hover:text-gray-700 dark:text-dark-400 dark:hover:text-dark-hover transition-colors";

export function Title(props: {
  type: "article" | "about" | "overview";
  /**
   * 数字 id，只给后台「编辑」链接用。
   * props.id 现在是拼音别名（/post/<slug>），后台编辑器只认数字 id，
   * 直接把别名塞进去会打开一个空编辑器并提示「无效的文档 ID」。
   */
  numericId?: number | string;
  id: number | string;
  title: string;
  openArticleLinksInNewWindow: boolean;
  showEditButton: boolean;
}) {
  const showEditButton = props.showEditButton && checkLogin();
  const newTab = useMemo(() => {
    if (props.type == "overview" && props.openArticleLinksInNewWindow) {
      return true;
    }
    return false;
    // 依赖写具体字段：props 对象每次渲染都是新引用，[props] 等于没有 memo
  }, [props.type, props.openArticleLinksInNewWindow]);
  const isAbout = props.type == "about";
  // The public host is unknown during SSR; the button is only clickable client-side.
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(`${location.protocol}//${location.host}`);
  }, []);
  const shareUrl = useMemo(
    () => articleUrl(origin, props.id),
    [origin, props.id]
  );
  return (
    // 三列网格：左右等宽的占位列把标题顶在正中，右侧操作列（复制按钮 + 编辑）
    // 独立成格，因此不会像绝对定位那样压在「编辑」文字上。
    <div className="grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center post-card-title group/title">
      <span aria-hidden="true" />
      {!isAbout ? (
        <Link
          href={`/post/${props.id}`}
          target={getTarget(newTab)}
          className="min-w-0 max-w-full"
          title={props.title}
        >
          <div
            className={`text-lg block font-medium overflow-hidden text-ellipsis whitespace-nowrap px-5  text-center mb-2 mt-2 dark:text-dark text-gray-700 md:text-${
              props.type == "overview" ? "xl" : "2xl"
            } ua ua-link ${TITLE_SELECTABLE_CLASS}`}
          >
            {props.title}
          </div>
        </Link>
      ) : (
        <div
          className={`text-lg block font-medium mb-2 mt-2 dark:text-dark text-gray-700 md:text-2xl ua ua-link ${TITLE_SELECTABLE_CLASS}`}
        >
          {props.title}
        </div>
      )}
      <div className="post-card-title-actions justify-self-end flex items-center shrink-0 ml-1 md:ml-2">
        <span className="flex items-center transition-opacity opacity-100 md:opacity-0 md:group-hover/title:opacity-100 md:group-focus-within/title:opacity-100">
          <CopyToClipboard
            text={props.title}
            onCopy={() => {
              toast.success(TITLE_COPY_TOAST, { className: "toast" });
            }}
          >
            <button
              type="button"
              aria-label={isAbout ? SITE_NAME_COPY_LABEL : TITLE_COPY_LABEL}
              title={isAbout ? SITE_NAME_COPY_LABEL : TITLE_COPY_LABEL}
              className={`${TITLE_ACTION_BUTTON_CLASS} ${TITLE_COPY_CLASS}`}
            >
              <CopyIcon />
            </button>
          </CopyToClipboard>
          {!isAbout && (
            <CopyToClipboard
              text={shareUrl}
              onCopy={() => {
                toast.success(TITLE_LINK_COPY_TOAST, { className: "toast" });
              }}
            >
              <button
                type="button"
                aria-label={TITLE_LINK_COPY_LABEL}
                title={TITLE_LINK_COPY_LABEL}
                className={`${TITLE_ACTION_BUTTON_CLASS} ${TITLE_LINK_COPY_CLASS}`}
              >
                <LinkIcon />
              </button>
            </CopyToClipboard>
          )}
        </span>
        {showEditButton && (
          <a
            className="flex items-center shrink-0 ml-2"
            href={
              props.type === "about"
                ? "/admin/editor?type=about"
                : `/admin/editor?type=article&id=${props.numericId ?? props.id}`
            }
            target="_blank"
          >
            <div className=" text-dark dark:text-gray-700">
              <div>编辑</div>
            </div>
          </a>
        )}
      </div>
    </div>
  );
}
export function SubTitle(props: {
  type: "article" | "about" | "overview";
  updatedAt: Date;
  createdAt: Date;
  catelog: string;
  enableComment: "true" | "false";
  id: number | string;
  /** 数字 id：内置评论用它当规范键（别名可能会改，数字 id 不会） */
  numericId?: number | string;
  /**
   * 服务端已经算好的阅读量（`article.viewer`，列表接口与文章接口都会下发）。
   * 传下去 `<PostViewer>` 就能首帧出数字：不用等 XHR，也不会闪 `...`。
   * 没有它（例如 `/about`）时 PostViewer 会在浏览器空闲时补一次请求。
   */
  viewer?: number | null;
  openArticleLinksInNewWindow: boolean;
}) {
  const iconSize = "16";
  const iconClass =
    "mr-1 fill-gray-400 dark:text-dark dark:group-hover:text-dark-hover group-hover:text-gray-900 ";

  const commentProvider = useCommentProvider();
  const dataPath = useMemo(() => {
    if (props.type == "about") {
      return "/about";
    } else {
      return "/post/" + props.id;
    }
  }, [props.type, props.id]);
  // waline 用 dataPath（保持上游行为不变，别把它已有的评论弄丢）；
  // 内置评论用数字 id 这个规范键
  const builtinCommentPath = useMemo(() => {
    if (props.type == "about") {
      return "/about";
    }
    return "/post/" + (props.numericId ?? props.id);
  }, [props.type, props.id, props.numericId]);
  return (
    <div className="text-center text-xs md:text-sm divide-x divide-gray-400 text-gray-400 dark:text-dark post-card-sub-title">
      <span className="inline-flex px-2 items-center">
        <span className={iconClass}>
          <svg
            viewBox="0 0 1024 1024"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            p-id="11557"
            width={iconSize}
            height={iconSize}
          >
            <path
              d="M853.333333 501.333333c-17.066667 0-32 14.933333-32 32v320c0 6.4-4.266667 10.666667-10.666666 10.666667H170.666667c-6.4 0-10.666667-4.266667-10.666667-10.666667V213.333333c0-6.4 4.266667-10.666667 10.666667-10.666666h320c17.066667 0 32-14.933333 32-32s-14.933333-32-32-32H170.666667c-40.533333 0-74.666667 34.133333-74.666667 74.666666v640c0 40.533333 34.133333 74.666667 74.666667 74.666667h640c40.533333 0 74.666667-34.133333 74.666666-74.666667V533.333333c0-17.066667-14.933333-32-32-32z"
              p-id="11558"
            ></path>
            <path
              d="M405.333333 484.266667l-32 125.866666c-2.133333 10.666667 0 23.466667 8.533334 29.866667 6.4 6.4 14.933333 8.533333 23.466666 8.533333h8.533334l125.866666-32c6.4-2.133333 10.666667-4.266667 14.933334-8.533333l300.8-300.8c38.4-38.4 38.4-102.4 0-140.8-38.4-38.4-102.4-38.4-140.8 0L413.866667 469.333333c-4.266667 4.266667-6.4 8.533333-8.533334 14.933334z m59.733334 23.466666L761.6 213.333333c12.8-12.8 36.266667-12.8 49.066667 0 12.8 12.8 12.8 36.266667 0 49.066667L516.266667 558.933333l-66.133334 17.066667 14.933334-68.266667z"
              p-id="11559"
            ></path>
          </svg>
        </span>
        {props.type != "about"
          ? `${dayjs(props.createdAt).format("YYYY-MM-DD")}`
          : ` ${dayjs(props.updatedAt).format("YYYY-MM-DD")}`}
      </span>

      {props.type != "about" && (
        <span className="inline-flex px-2 items-center group dark:group cursor-pointer">
          <span className={iconClass}>
            <svg
              viewBox="0 0 1024 1024"
              version="1.1"
              xmlns="http://www.w3.org/2000/svg"
              p-id="12516"
              fill="currentColor"
              width={iconSize}
              height={iconSize}
            >
              <path
                d="M810.666667 85.333333a85.333333 85.333333 0 0 1 85.333333 85.333334v152.021333c36.821333 9.493333 64 42.88 64 82.645333v405.333334a128 128 0 0 1-128 128H192a128 128 0 0 1-128-128V298.666667a85.376 85.376 0 0 1 64-82.645334V170.666667a85.333333 85.333333 0 0 1 85.333333-85.333334h597.333334zM128.149333 296.170667L128 298.666667v512a64 64 0 0 0 60.245333 63.893333L192 874.666667h640a64 64 0 0 0 63.893333-60.245334L896 810.666667V405.333333a21.333333 21.333333 0 0 0-18.837333-21.184L874.666667 384H638.165333l-122.069333-101.717333a21.333333 21.333333 0 0 0-10.688-4.736l-2.986667-0.213334H149.333333a21.333333 21.333333 0 0 0-21.184 18.837334zM535.189333 213.333333l127.978667 106.666667H832V170.666667a21.333333 21.333333 0 0 0-18.837333-21.184L810.666667 149.333333H213.333333a21.333333 21.333333 0 0 0-21.184 18.837334L192 170.666667v42.666666h343.168z"
                p-id="12517"
              ></path>
            </svg>
          </span>
          <Link
            href={`/category/${encodeQuerystring(props.catelog)}`}
            target={getTarget(props.openArticleLinksInNewWindow)}
          >
            <div className="cursor-pointer group-hover:text-gray-900 dark:group-hover:text-dark-hover hover:font-medium ">{`${props.catelog}`}</div>
          </Link>
        </span>
      )}
      <span className="inline-flex px-2 items-center">
        <span className={iconClass}>
          <svg
            viewBox="0 0 1024 1024"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            p-id="15825"
            width={iconSize}
            height={iconSize}
          >
            <path
              d="M942.2 486.2C847.4 286.5 704.1 186 512 186c-192.2 0-335.4 100.5-430.2 300.3-7.7 16.2-7.7 35.2 0 51.5C176.6 737.5 319.9 838 512 838c192.2 0 335.4-100.5 430.2-300.3 7.7-16.2 7.7-35 0-51.5zM512 766c-161.3 0-279.4-81.8-362.7-254C232.6 339.8 350.7 258 512 258c161.3 0 279.4 81.8 362.7 254C791.5 684.2 673.4 766 512 766z"
              p-id="15826"
            ></path>
            <path
              d="M508 336c-97.2 0-176 78.8-176 176s78.8 176 176 176 176-78.8 176-176-78.8-176-176-176z m0 288c-61.9 0-112-50.1-112-112s50.1-112 112-112 112 50.1 112 112-50.1 112-112 112z"
              p-id="15827"
            ></path>
          </svg>
        </span>
        <PostViewer
          shouldAddViewer={props.type != "overview"}
          id={props.id}
          initialViewer={props.viewer ?? null}
        />
      </span>
      {props.enableComment != "false" && (
        <span className="inline-flex px-2 items-center">
          <span className={iconClass}>
            <svg
              viewBox="0 0 1024 1024"
              version="1.1"
              xmlns="http://www.w3.org/2000/svg"
              p-id="13953"
              width={iconSize}
              height={iconSize}
            >
              <path
                d="M873.559 97.82h-723.12c-45.886 0-83.436 37.627-83.436 83.611v542.098c0 45.984 37.55 69.685 83.437 69.685h333.747c45.888 0 109.987 34.242 142.43 66.767l48.888 52.12c12.589 12.615 24.309 20.262 33.91 20.262 15.143 0 25.083-20.55 25.083-48.675 0-45.983 37.548-90.474 83.436-90.474h55.625c45.887 0 83.438-23.701 83.438-69.685V181.431c0-45.984-37.55-83.61-83.438-83.61z m27.813 625.71c0 15.105-12.738 15.307-27.813 15.307h-55.625c-61.382 0-113.612 46.353-132 101.74l-19.989-23.15c-42.914-43.016-121.055-78.59-181.758-78.59H150.44c-15.074 0-27.813-0.204-27.813-15.308V181.431c0-15.106 12.739-27.87 27.813-27.87h723.119c15.075 0 27.813 12.766 27.813 27.87v542.098zM261.689 348.652h278.124c15.358 0 27.812-12.48 27.812-27.87s-12.454-27.87-27.812-27.87H261.689c-15.357 0-27.812 12.48-27.812 27.87s12.455 27.87 27.812 27.87z m472.81 83.613H261.69c-15.357 0-27.812 12.48-27.812 27.87s12.455 27.87 27.812 27.87H734.5c15.357 0 27.812-12.48 27.812-27.87 0-15.392-12.455-27.87-27.812-27.87z m0 111.48H261.69c-15.357 0-27.812 12.48-27.812 27.87s12.455 27.871 27.812 27.871H734.5c15.357 0 27.812-12.48 27.812-27.87s-12.455-27.87-27.812-27.87z"
                p-id="13954"
              ></path>
            </svg>
          </span>
          {commentProvider === "builtin" ? (
            // 内置评论：评论数由本站接口批量返回（50ms 内的请求会合并成一次 /counts）
            <CommentCount path={builtinCommentPath} />
          ) : commentProvider === "off" ? null : (
            // waline：这个 span 由 @waline/client 自己填充，必须原样保留
            <span className="waline-comment-count" data-path={dataPath}>
              {COUNT_LOADING_PLACEHOLDER}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
