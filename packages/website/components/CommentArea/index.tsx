import React from "react";
import dynamic from "next/dynamic";
import WaLine from "../WaLine";
import useCommentProvider from "../../hooks/useCommentProvider";

/**
 * 评论区**必须动态加载**：内置评论用 bytemd 的 getProcessor 渲染 markdown，
 * 静态 import 会把 markdown 管线拖进调用方的 chunk（PostCard 在首页也用，
 * First Load JS 会立刻回涨）。Waline 那边本来也是 dynamic 的。
 */
const Comment = dynamic(() => import("../Comment"), { ssr: false });

/**
 * 评论区的统一入口：三选一由后台「评论设置」决定。
 *
 * - `builtin` → 本站内置评论（components/Comment）
 * - `waline`  → 外挂 Waline（components/WaLine）
 * - `off`     → 什么都不渲染
 *
 * ⚠️ 所有要放评论区的页面都走这里，别再直接写 `<WaLine />`：
 * 站点切到内置评论后，直接写死的地方会继续加载 waline 客户端，
 * 而 waline 子进程这时已经被停掉了，评论区就是一片报错/空白（/link 页踩过）。
 *
 * provider 只有客户端知道，首屏（含 SSR）返回 null，所以不会有水合不一致。
 */
export default function CommentArea(props: {
  /** 评论挂在哪个路径下，例如 `/post/<slug>`、`/about`、`/link` */
  path: string;
  /** 站点级的评论总开关（字符串 "true"/"false"） */
  enable: "true" | "false" | boolean;
  /** 传给 waline 的可见性开关（列表页会传 false，只为了填充评论数） */
  visible?: boolean;
}) {
  const provider = useCommentProvider();
  const enabled = String(props.enable) !== "false";

  if (!enabled || !props.path || provider === "off") {
    return null;
  }
  if (provider === "builtin") {
    return <Comment path={props.path} enable={true} />;
  }
  if (provider === "waline") {
    return <WaLine enable={"true"} visible={props.visible !== false} />;
  }
  return null;
}
