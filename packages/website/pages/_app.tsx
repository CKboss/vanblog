import "../styles/globals.css";
// GitHub 风格提示块（> [!NOTE] 等）的样式。它的图标本来是内联 <svg>，
// 但 sanitize 白名单不放行 svg（正文里能塞 svg 就等于多一个 XSS 面），
// 所以 styles/markdown-extra.css 用 ::before 补了等效的图标。
import "remark-github-blockquote-alert/alert.css";
import "../styles/markdown-extra.css";
import "../styles/side-bar.css";
import "../styles/toc.css";
import "../styles/var.css";
import "../styles/github-markdown.css";
import "../styles/tip-card.css";
import "../styles/loader.css";
import "../styles/scrollbar.css";
import "../styles/custom-container.css";
import "../styles/code-light.css";
import "../styles/code-dark.css";
import "../styles/zoom.css";
import type { AppProps } from "next/app";
import { GlobalContext, GlobalState } from "../utils/globalContext";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { getPageview, updatePageview } from "../api/pageview";
import Head from "next/head";

function MyApp({ Component, pageProps }: AppProps) {
  const { current } = useRef({ hasInit: false });

  const [globalState, setGlobalState] = useState<GlobalState>({
    viewer: 0,
    visited: 0,
  });

  const router = useRouter();
  const reloadViewer = useCallback(
    async (reason: string) => {
      const pathname = window.location.pathname;
      if (window.localStorage.getItem("noViewer")) {
        const { viewer, visited } = await getPageview(pathname)
        setGlobalState({ ...globalState, viewer: viewer, visited: visited });
        return;
      } else {
        console.log("[更新访客]", reason, pathname);
        const { viewer, visited } = await updatePageview(pathname);
        setGlobalState({ ...globalState, viewer: viewer, visited: visited });
      }

    },
    [globalState, setGlobalState]
  );
  const handleRouteChange = (
    url: string,
    { shallow }: { shallow: boolean }
  ) => {
    // 页面切换时优先保证新页面可用，统计请求排到空闲再发
    const idle =
      typeof window !== "undefined" && "requestIdleCallback" in window
        ? (window as any).requestIdleCallback
        : (cb: () => void) => window.setTimeout(cb, 800);
    idle(() => reloadViewer(`页面跳转`));
  };
  useEffect(() => {
    if (!current.hasInit) {
      current.hasInit = true;
      // 访客统计和首屏无关，等主线程空下来再发，别和水合/首次渲染抢资源
      const idle =
        typeof window !== "undefined" && "requestIdleCallback" in window
          ? (window as any).requestIdleCallback
          : (cb: () => void) => window.setTimeout(cb, 1200);
      idle(() => reloadViewer("初始化"));
      router.events.on("routeChangeComplete", handleRouteChange);
    }
  }, [current, reloadViewer]);

  return (
    <>
      <Head>
        {/* ⚠️ 不要再把 `user-scalable=no` / `maximum-scale=1` 加回来：
            禁止缩放是 WCAG 1.4.4（Resize Text）失败项，低视力用户在手机上
            就完全没法放大正文了。代价是 iOS Safari 会在聚焦 font-size < 16px
            的输入框时自动放大页面 —— 这是可接受的行为（双击/双指仍可自由缩放），
            仓库里没有任何测试或注释依赖"输入框不触发缩放"这个旧行为。 */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        />
      </Head>
      <GlobalContext.Provider
        value={{ state: globalState, setState: setGlobalState }}
      >
        <Component {...pageProps} />
      </GlobalContext.Provider>
    </>
  );
}

export default MyApp;
