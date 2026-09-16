import { useMemo } from "react";
import Core from "./core";
import { NavItem, parseNavStructure } from "./tools";

export default function (props: {
  content: string;
  headingOffset?: number;
  mobile?: boolean;
  onNavigate?: (item: NavItem) => void;
}) {
  // ⚠️ 依赖必须是 props.content（值）而不是 props（对象引用）：
  // parseNavStructure 会把**整篇文章**过一遍 unified 管线来提取标题，
  // 而父组件（PostCard/页面）的 props 对象每次渲染都是新引用 —— 以 [props]
  // 为依赖等于"每次重渲染都全文重解析一遍"（访客统计 setState、主题切换都会触发）。
  const navData = useMemo(() => {
    return parseNavStructure(props.content);
  }, [props.content]);
  return (
    <Core
      items={navData}
      mobile={props.mobile}
      headingOffset={props.headingOffset || 0}
      onNavigate={props.onNavigate}
    />
  );
}
