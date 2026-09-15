import dynamic from "next/dynamic";

/**
 * ⚠️ `dynamic()` 必须在**模块作用域**调用，不能写在渲染函数里。
 *
 * 写在渲染体里时，每次父组件重渲染都会得到一个**全新的组件类型**
 * （`dynamic()` 每次都返回一个新的 Loadable 组件）。React 靠"类型是否相同"来决定
 * 复用还是重建子树，类型变了就**卸载旧的、挂载新的** —— 于是 `./core` 里那个
 * `useEffect` 会重新跑一遍：waline 模式下重新 `init()` 整个评论区，
 * 列表页（`visible={false}`）模式下重新 `commentCount()` 拉一遍所有卡片的评论数。
 * 而父组件（pages/index.tsx 等）会因为 `useCommentProvider()` 的异步 setState
 * 至少重渲染一次，实际观察到的就是评论组件被反复重建。
 *
 * 提到模块作用域后组件类型稳定，React 正常复用子树；`dynamic()` 本身不会触发
 * 加载（真正 `import("./core")` 发生在渲染它的时候），所以评论关闭时
 * 一个字节都不会下载，行为和以前一致。
 */
const Core = dynamic(() => import("./core"));

export default function (props: {
  enable: "true" | "false";
  visible: boolean;
}) {
  if (!props.enable || props.enable == "false") {
    return null;
  }
  return <Core enable={props.enable} visible={props.visible} />;
}
