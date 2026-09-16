import { useEffect } from "react";
import Headroom from "headroom.js";
import { stopHeadroom } from "../../utils/headroom";
import MarkdownTocBar from "../MarkdownTocBar";
export default function (props: {
  content: string;
  showSubMenu: "true" | "false";
}) {
  useEffect(() => {
    const el = document.querySelector("#toc-card");
    if (!el) {
      return undefined;
    }
    const headroom = new Headroom(el, {
      classes: {
        initial: `side-bar${
          props.showSubMenu == "true" ? "" : " no-submenu"
        }`,
        pinned: "side-bar-pinned",
        unpinned: "side-bar-unpinned",
        top: "side-bar-top",
        notTop: "side-bar-not-top",
      },
    });
    headroom.init();
    // ⚠️ 这个 effect 以前既没有清理函数、又带 useRef(hasInit) 门闩（和 AuthorCard
    // 修复前一模一样）：headroom 的 scrollTracker 挂在 window 上，组件卸载
    // （每次客户端路由跳走文章页）后监听还活着，闭包钉着已卸载的 #toc-card
    // 整棵 DOM —— 每跳一次文章页泄漏一个 scroll 监听 + 一棵子树。
    // 清理不能直接 headroom.destroy()，见 utils/headroom.ts 的说明。
    return () => {
      stopHeadroom(headroom);
    };
  }, [props.showSubMenu]);
  return (
    <div className="sticky" id="toc-card">
      <div
        id="toc-container"
        className="bg-white w-60 card-shadow dark:card-shadow-dark ml-2 dark:bg-dark overflow-y-auto pb-2"
        style={{ maxHeight: 'calc(100vh - 200px)' }}
      >
        <MarkdownTocBar content={props.content} headingOffset={56} />
      </div>
    </div>
  );
}
