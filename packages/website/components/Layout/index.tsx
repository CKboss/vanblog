import Head from "next/head";
import BackToTopBtn from "../BackToTop";
import NavBar from "../NavBar";
import { useEffect, useRef, useState } from "react";
import BaiduAnalysis from "../BaiduAnalysis";
import GaAnalysis from "../gaAnalysis";
import { LayoutProps } from "../../utils/getLayoutProps";
// import ImageProvider from "../ImageProvider";
import { RealThemeType, ThemeContext } from "../../utils/themeContext";
import CustomLayout from "../CustomLayout";
import { APPLE_FONT_CSS_URL, APPLE_FONT_PRECONNECT_HOSTS } from "../../utils/appleFont";
import { Toaster } from "react-hot-toast";
import Footer from "../Footer";
import NavBarMobile from "../NavBarMobile";
import LayoutBody from "../LayoutBody";
export default function (props: {
  option: LayoutProps;
  title: string;
  sideBar: any;
  children: any;
}) {
  // console.log("css", props.option.customCss);
  // console.log("html", props.option.customHtml);
  // console.log("script", decode(props.option.customScript as string));
  const [isOpen, setIsOpen] = useState(false);
  const { current } = useRef({ hasInit: false });
  // Stable SSR value; ThemeButton applies the stored / default theme before paint.
  const [theme, setTheme] = useState<RealThemeType>("auto-light");
  const handleClose = () => {
    console.log("关闭或刷新页面");
    localStorage.removeItem("saidHello");
  };
  const uiStyle = props.option.uiStyle === "default" ? "default" : "apple";
  // Apple 皮肤的中文字体（Maple Mono NF CN）来自远程字体 CSS。
  //
  // ⚠️ 它**必须异步加载**：普通 <link rel="stylesheet"> 是渲染阻塞的，而这个域名
  // 在部分网络下解析不了（实测本机 `static.zeoseven.com` DNS 失败，而 zeoseven.com 正常）——
  // 阻塞加载会让首屏一直白屏等到超时。所以先用 media="print" 让浏览器以低优先级、
  // 不阻塞渲染地取下来，加载完（或水合后）再把 media 改成 all，配合字体自身的
  // font-display: swap，效果是「先按兜底字体渲染，字体到了再无缝换」。
  //
  // 另外不用 CSS 里的 @import：@import 必须位于样式表最前面，而 apple.css 是被
  // globals.css 内联进来的（前面还有 siteNameLayout.css 与 Tailwind 产物），
  // 内联后远程 @import 会被浏览器**静默丢弃**。
  const appleFontCss = APPLE_FONT_CSS_URL;
  // 皮肤挂在最外层容器的 data-ui 上（SSR 就带上，不会闪）；同时同步到 <html>，
  // 这样 overscroll 区域和 body 背景也能跟着变。
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.ui = uiStyle;
    }
  }, [uiStyle]);
  // 把 media 从 "print" 翻成 "all" 的**真正机制是这个 effect**，不是上面的 onLoad：
  // next/head 是把子元素用 document.createElement + setAttribute 搬进 <head> 的，
  // 函数类型的 prop（onLoad）根本不会被带过去；就算带过去了，命中缓存时也可能
  // 在监听挂上之前就加载完了。所以水合后统一扫一遍，onLoad 只当锦上添花。
  useEffect(() => {
    if (uiStyle !== "apple" || !appleFontCss || typeof document === "undefined") {
      return;
    }
    const links = document.querySelectorAll<HTMLLinkElement>(
      `link[rel="stylesheet"][href="${appleFontCss}"]`,
    );
    links.forEach((link) => {
      if (link.media !== "all") {
        link.media = "all";
      }
    });
  }, [uiStyle, appleFontCss]);
  useEffect(() => {
    if (!current.hasInit && !localStorage.getItem("saidHello")) {
      current.hasInit = true;
      localStorage.setItem("saidHello", "true");
      console.log("🚀欢迎使用 VanBlog 博客系统");
      console.log("当前版本：", props?.option?.version || "未知");
      console.log("项目主页：", "https://vanblog.mereith.com");
      console.log("开源地址：", "https://github.com/mereithhh/van-blog");
      console.log("喜欢的话可以给个 star 哦🙏");
      window.onbeforeunload = handleClose;
    }
    return () => {
      document.body.style.overflow = "auto";
    };
  }, [props]);
  return (
    <>
      <Head>
        <title>{props.title}</title>
        <link rel="icon" href={props.option.favicon}></link>
        <meta name="description" content={props.option.description}></meta>
        <meta name="robots" content="index, follow"></meta>
      </Head>
      <BackToTopBtn></BackToTopBtn>
      {props.option.baiduAnalysisID != "" &&
        process.env.NODE_ENV != "development" && (
          <BaiduAnalysis id={props.option.baiduAnalysisID}></BaiduAnalysis>
        )}

      {props.option.gaAnalysisID != "" &&
        process.env.NODE_ENV != "development" && (
          <GaAnalysis id={props.option.gaAnalysisID}></GaAnalysis>
        )}
      <ThemeContext.Provider
        value={{
          setTheme,
          theme,
        }}
      >
        {uiStyle === "apple" && appleFontCss ? (
          <Head>
            {APPLE_FONT_PRECONNECT_HOSTS.map((host) => (
              <link
                key={`preconnect-${host}`}
                rel="preconnect"
                href={host}
                crossOrigin="anonymous"
              />
            ))}
            <link rel="dns-prefetch" href={new URL(appleFontCss).origin} />
            <link
              rel="stylesheet"
              href={appleFontCss}
              media="print"
              onLoad={(event) => {
                const link = event.currentTarget as HTMLLinkElement;
                if (link && link.media !== "all") {
                  link.media = "all";
                }
              }}
            />
            {/* 关掉 JS 时没有水合，也就没人把 media 改成 all，这里补一份正常的 */}
            <noscript>
              <link rel="stylesheet" href={appleFontCss} />
            </noscript>
          </Head>
        ) : null}
        <div className="vb-root" data-ui={uiStyle}>
        <Toaster />
        {/* <ImageProvider> */}
          <NavBar
            openArticleLinksInNewWindow={
              props.option.openArticleLinksInNewWindow == "true"
            }
            showRSS={props.option.showRSS}
            defaultTheme={props.option.defaultTheme}
            showSubMenu={props.option.showSubMenu}
            headerLeftContent={props.option.headerLeftContent}
            subMenuOffset={props.option.subMenuOffset}
            showAdminButton={props.option.showAdminButton}
            menus={props.option.menus}
            siteName={props.option.siteName}
            logo={props.option.logo}
            categories={props.option.categories}
            isOpen={isOpen}
            setOpen={setIsOpen}
            logoDark={props.option.logoDark}
            showFriends={props.option.showFriends}
          ></NavBar>
          <NavBarMobile
            isOpen={isOpen}
            setIsOpen={setIsOpen}
            showAdminButton={props.option.showAdminButton}
            showFriends={props.option.showFriends}
            menus={props.option.menus}
          />

          <div className=" mx-auto  lg:px-6  md:py-4 py-2 px-2 md:px-4  text-gray-700 ">
            <LayoutBody children={props.children} sideBar={props.sideBar} />
            <Footer
              ipcHref={props.option.ipcHref}
              ipcNumber={props.option.ipcNumber}
              since={props.option.since}
              version={props.option.version}
              gaBeianLogoUrl={props.option.gaBeianLogoUrl}
              gaBeianNumber={props.option.gaBeianNumber}
              gaBeianUrl={props.option.gaBeianUrl}
            />
          </div>
        {/* </ImageProvider> */}
        </div>
      </ThemeContext.Provider>
      {props.option.enableCustomizing == "true" && (
        <CustomLayout
          customCss={props.option.customCss}
          customHtml={props.option.customHtml}
          customScript={props.option.customScript}
          customHead={props.option.customHead}
        />
      )}
    </>
  );
}
