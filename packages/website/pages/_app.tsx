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
      // ⚠️ 三个加固：
      // 1. noViewer 的判据与 components/PostViewer 对齐（=== "true"）：
      //    以前这里是「任意非空值都算开」（noViewer="false" 也会被当成 true），
      //    同一个开关在两处语义不一致，排查统计问题时会把人绕晕。
      // 2. 整段包 try/catch：统计接口/隐私模式的 localStorage 抛错时，
      //    以前是一次**没人处理的 promise rejection**（idle 回调里没人 await），
      //    控制台只有一行栈、页脚统计静默停更。
      // 3. setGlobalState 不再展开闭包里的旧 globalState（这个 useCallback 以前
      //    依赖 globalState、每次数都会换引用，而 router.events 里注册的又是
      //    **第一次渲染**的闭包 —— 展开的永远是初始值；两个字段本来就会被覆盖，
      //    直接整体替换，语义相同且不再依赖闭包新鲜度）。
      try {
        const pathname = window.location.pathname;
        let noViewer = false;
        try {
          noViewer = window.localStorage.getItem("noViewer") === "true";
        } catch {
          noViewer = false; // 隐私模式 / 被禁用的 localStorage
        }
        if (noViewer) {
          const { viewer, visited } = await getPageview(pathname);
          setGlobalState({ viewer, visited });
          return;
        }
        console.log("[更新访客]", reason, pathname);
        const { viewer, visited } = await updatePageview(pathname);
        setGlobalState({ viewer, visited });
      } catch (err) {
        console.warn("[访客统计] 更新失败", err);
      }
    },
    []
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
