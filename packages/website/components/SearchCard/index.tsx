import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { searchArticles } from "../../api/search";
import { useDebounce } from "react-use";
import ArticleList from "../ArticleList";
import KeyCard from "../KeyCard";
// ⚠️ 只从 utils/searchUrls 拿 URL helper：SearchCard 会被 Layout 引到每个页面上，
// 而 utils/searchIndex 里那些索引校验与降级文案只有 /search 页用得到（见 searchUrls.ts）。
import { searchPageUrl } from "../../utils/searchUrls";
import {
  SEARCH_CLEAR_BUTTON_CLASS,
  SEARCH_CLEAR_LABEL,
  SEARCH_DIALOG_INPUT_ATTR,
  SEARCH_DIALOG_LABEL,
  SEARCH_ICON_STROKE_WIDTH,
  SEARCH_INPUT_CLASS,
  SEARCH_INPUT_LABEL,
  SEARCH_RESULT_ATTR,
  SEARCH_RESULTS_LABEL,
  describeSearchDialog,
  focusSearchDialogInput,
  handleSearchDialogKeyDown,
  handleSearchShortcutKeyDown,
  openSearchFromUserGesture,
} from "./a11y";

export type SearchCardHandle = {
  openFromUserGesture: () => boolean;
};

/** 弹窗里"查看全部结果"的入口文案（单测按这个字符串找它） */
export const SEARCH_VIEW_ALL_LABEL = "查看全部结果";

/**
 * 「查看全部结果」→ `/search?q=<关键词>`。
 *
 * 为什么加它（以及为什么**只**加它，没有重写这个弹窗）：弹窗是一个即时的下拉预览，
 * 没有排序、没有分页、没有高亮，而 `/search` 页有（静态索引 + 三档排序 + `<mark>` 高亮 +
 * 分页 + 可分享的 URL）。弹窗里搜到 20 条时，用户需要一个"往下翻"的去处。
 *
 * ⚠️ 用真的 `next/link`（`<a href>`），不是 `onClick` 的 div：键盘能到、能中键新开、
 * 读屏软件念得出来。点击后关掉弹窗（`onClick` 里做的只是关弹窗，导航交给 Link）。
 */
export function ViewAllResultsLink(props: { query: string; onClick: () => void }) {
  const query = String(props.query ?? "").trim();
  if (!query) {
    return null;
  }
  return (
    <div className="mt-3 pt-2 border-t border-dashed border-gray-200 dark:border-dark-2 text-center">
      <Link
        href={searchPageUrl(query, 1)}
        onClick={props.onClick}
        className="text-sm text-gray-500 hover:text-gray-800 dark:text-dark-400 dark:hover:text-dark underline"
        data-search-view-all=""
      >
        {`${SEARCH_VIEW_ALL_LABEL}（${query}）`}
      </Link>
    </div>
  );
}

const SearchCard = forwardRef<
  SearchCardHandle,
  {
    visible: boolean;
    setVisible: (v: boolean) => void;
    openArticleLinksInNewWindow: boolean;
  }
>(function SearchCard(props, ref) {
  const [result, setResult] = useState<any>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [typing, setTyping] = useState(false);
  // 搜索失败要和「暂无结果」区分开：以前接口一挂，loading 永远停在 true，
  // 用户看到一行卡死的「搜索中...」，既不知道失败了也没法归因
  const [failed, setFailed] = useState(false);
  // 过期响应守卫：debounce 之后仍可能有两个请求在飞，
  // 慢的旧响应后到会覆盖新结果（搜 "ab" 的结果盖掉 "abc" 的）
  const seqRef = useRef(0);
  const overlayRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleRef = useRef(props.visible);
  const setVisibleRef = useRef(props.setVisible);
  visibleRef.current = props.visible;
  setVisibleRef.current = props.setVisible;

  const closeSearch = () => {
    document.body.style.overflow = "auto";
    setVisibleRef.current(false);
  };

  const openFromUserGesture = () =>
    openSearchFromUserGesture({
      overlay: overlayRef.current,
      dialog: innerRef.current,
      input: inputRef.current,
      setVisible: (v) => setVisibleRef.current(v),
      setBodyOverflow: (overflow) => {
        document.body.style.overflow = overflow;
      },
    });

  useImperativeHandle(ref, () => ({
    openFromUserGesture,
  }));

  const openSearch = () => {
    openFromUserGesture();
  };

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const shortcut = handleSearchShortcutKeyDown({
        key: ev.key,
        ctrlKey: ev.ctrlKey,
        metaKey: ev.metaKey,
        visible: visibleRef.current,
        preventDefault: () => ev.preventDefault(),
        onOpen: openSearch,
        onClose: closeSearch,
      });
      if (shortcut) return;
      if (!visibleRef.current || !innerRef.current) return;
      handleSearchDialogKeyDown({
        key: ev.key,
        shiftKey: ev.shiftKey,
        visible: true,
        currentTarget: innerRef.current,
        target: ev.target,
        preventDefault: () => ev.preventDefault(),
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useLayoutEffect(() => {
    if (props.visible) {
      focusSearchDialogInput({
        querySelector: (selector) =>
          innerRef.current?.querySelector(selector) ?? inputRef.current,
      });
    }
  }, [props.visible]);
  const onSearch = async (search: string) => {
    const seq = ++seqRef.current;
    setTyping(false);
    setLoading(true);
    try {
      const resultFromServer = await searchArticles(search);
      if (seq !== seqRef.current) {
        return; // 已经有更新的搜索在飞/完成了，这个响应作废
      }
      setResult(resultFromServer);
      setFailed(false);
    } catch {
      if (seq !== seqRef.current) {
        return;
      }
      setResult([]);
      setFailed(true);
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
      }
    }
  };
  useDebounce(
    () => {
      if (search.trim() !== "") {
        onSearch(search);
      }
    },
    500,
    [search]
  );

  const showClear = useMemo(() => {
    return search.trim() !== "";
  }, [search]);
  const renderResult = () => {
    let text = "";
    if (loading) {
      text = "搜索中...";
    } else if (failed) {
      text = "搜索失败，请稍后再试";
    } else {
      if (search.trim() == "") {
        text = "请输入并搜索";
      } else {
        // 有数字，有结果
        if (result.length) {
          text = "有结果";
        } else {
          // 可能是暂无结果或者输入中
          if (typing) {
            text = "输入中";
          } else {
            text = "暂无结果";
          }
        }
      }
    }
    if (text == "有结果") {
      return (
        <div>
          <ArticleList
            showYear={true}
            articles={result}
            itemAttr={SEARCH_RESULT_ATTR}
            openArticleLinksInNewWindow={props.openArticleLinksInNewWindow}
            onClick={closeSearch}
          ></ArticleList>
          <ViewAllResultsLink query={search} onClick={closeSearch} />
        </div>
      );
    } else {
      return (
        <div className="mt-16 text-center">
          <div className="text-gray-600 dark:text-dark select-none">{text}</div>
          {/* 没有结果时也给出口：弹窗里搜不到 ≠ 全站搜不到
              （弹窗走的是服务端 /api/public/search，而 /search 页有静态索引 + 排序 + 高亮，
              两边的匹配面与大小写折叠规则并不完全相同，见 utils/searchRank.ts 的说明） */}
          {!loading && !failed && search.trim() !== "" ? (
            <ViewAllResultsLink query={search} onClick={closeSearch} />
          ) : null}
        </div>
      );
    }
  };

  return (
    <div
      ref={overlayRef}
      className="fixed w-full h-full top-0 left-0 right-0 bottom-0  justify-center items-center flex vanblog-search-overlay"
      style={{
        zIndex: 100,
        backgroundColor: "rgba(0,0,0,0.4)",
        visibility: props.visible ? "visible" : "hidden",
      }}
      onClick={(ev) => {
        if (innerRef.current) {
          if (!innerRef.current.contains(ev.target as Node)) {
            closeSearch();
          }
        }
      }}
    >
      <div
        ref={innerRef}
        role={describeSearchDialog().role}
        aria-modal={props.visible}
        aria-label={SEARCH_DIALOG_LABEL}
        aria-hidden={!props.visible}
        className="bg-white w-3/4  p-4 rounded-xl card-shadow dark:card-shadow-dark transition-all dark:bg-dark vanblog-search-panel"
        style={{
          minHeight: "280px",
          minWidth: 360,
          maxWidth: "710px",
          transform: props.visible ? "scale(100%)" : "scale(0)",
        }}
        onTransitionEnd={() => {
          if (props.visible) {
            inputRef.current?.focus();
          }
        }}
      >
        <div className="flex items-center dark:text-dark text-gray-600">
          <svg
            viewBox="0 0 1024 1024"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            p-id="2305"
            width="24"
            height="24"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={SEARCH_ICON_STROKE_WIDTH}
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path
              d="M789.804097 737.772047 742.865042 784.699846 898.765741 940.600545 945.704796 893.672746Z"
              p-id="2306"
            ></path>
            <path
              d="M456.92259 82.893942c-209.311143 0-379.582131 170.282245-379.582131 379.582131s170.270988 379.570875 379.582131 379.570875c209.287607 0 379.558595-170.270988 379.558595-379.570875S666.210197 82.893942 456.92259 82.893942zM770.128989 462.477097c0 172.721807-140.508127 313.229934-313.206398 313.229934-172.720783 0-313.229934-140.508127-313.229934-313.229934s140.508127-313.229934 313.229934-313.229934C629.620861 149.247162 770.128989 289.75529 770.128989 462.477097z"
              p-id="2307"
            ></path>
          </svg>
          <input
            ref={inputRef}
            value={search}
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={SEARCH_INPUT_LABEL}
            {...{ [SEARCH_DIALOG_INPUT_ATTR]: "" }}
            onChange={(ev) => {
              setTyping(true);
              setSearch(ev.currentTarget.value);
              if (ev.currentTarget.value.trim() == "") {
                setResult([]);
                setFailed(false);
              }
            }}
            placeholder={SEARCH_INPUT_LABEL}
            className={`w-full ml-2 text-base ${SEARCH_INPUT_CLASS}`}
            style={{
              height: 32,
              appearance: "none",
              border: "none",
              outline: "medium",
              backgroundColor: "inherit",
            }}
          ></input>

          <button
            type="button"
            aria-label={SEARCH_CLEAR_LABEL}
            tabIndex={showClear ? 0 : -1}
            className={SEARCH_CLEAR_BUTTON_CLASS}
            style={{
              visibility: showClear ? "visible" : "hidden",
            }}
            onClick={() => {
              setSearch("");
              setResult([]);
              setFailed(false);
              inputRef.current?.focus();
            }}
          >
            <svg
              viewBox="0 0 1024 1024"
              version="1.1"
              xmlns="http://www.w3.org/2000/svg"
              fill="currentColor"
              p-id="2258"
              width="20"
              height="20"
              className="cursor-pointer"
              aria-hidden="true"
            >
              <path
                d="M512 39.384615C250.092308 39.384615 39.384615 250.092308 39.384615 512s210.707692 472.615385 472.615385 472.615385 472.615385-210.707692 472.615385-472.615385S773.907692 39.384615 512 39.384615z m96.492308 488.369231l153.6 153.6c7.876923 7.876923 7.876923 19.692308 0 27.569231l-55.138462 55.138461c-7.876923 7.876923-19.692308 7.876923-27.569231 0L525.784615 610.461538c-7.876923-7.876923-19.692308-7.876923-27.56923 0l-153.6 153.6c-7.876923 7.876923-19.692308 7.876923-27.569231 0L261.907692 708.923077c-7.876923-7.876923-7.876923-19.692308 0-27.569231l153.6-153.6c7.876923-7.876923 7.876923-19.692308 0-27.569231l-155.56923-155.56923c-7.876923-7.876923-7.876923-19.692308 0-27.569231l55.138461-55.138462c7.876923-7.876923 19.692308-7.876923 27.569231 0l155.569231 155.569231c7.876923 7.876923 19.692308 7.876923 27.56923 0l153.6-153.6c7.876923-7.876923 19.692308-7.876923 27.569231 0l55.138462 55.138462c7.876923 7.876923 7.876923 19.692308 0 27.56923l-153.6 153.6c-5.907692 7.876923-5.907692 19.692308 0 27.569231z"
                p-id="2259"
              ></path>
            </svg>
          </button>
          <KeyCard type="esc"></KeyCard>
        </div>
        <hr className="my-2 dark:border-hr-dark"></hr>
        <div
          className="dark:text-dark"
          aria-label={SEARCH_RESULTS_LABEL}
          style={{ maxHeight: 400, overflowY: "auto" }}
        >
          {renderResult()}
        </div>
      </div>
    </div>
  );
});

export default SearchCard;
