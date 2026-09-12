export const checkLogin = () => {
  // 以前第一行就 `return true`，下面真正的判断是死代码：
  // 「编辑」按钮对匿名访客也显示（点进去才被后台拦住），而且 SSR 与客户端不一致。
  if (typeof window === "undefined") return false;
  try {
    return !!window.localStorage?.getItem("token");
  } catch {
    return false;
  }
};
