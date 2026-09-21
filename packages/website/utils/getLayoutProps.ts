import { defaultMenu, MenuItem, PublicMetaProp } from "../api/getAllData";
import dayjs from "dayjs";
import { AuthorCardProps } from "../components/AuthorCard";
import { checkLogin } from "./auth";
import { sanitizeArticlesPerPage } from "./articlesPerPage";
import { isDefaultExpandAllCategories } from "./categoryExpand";
import { normalizeGaAnalysisId } from "../components/gaAnalysis/load";
import {
  DEFAULT_ABOUT_TITLE,
  DEFAULT_FRIEND_LINK_APPLY_CONTENT,
  DEFAULT_FRIEND_LINK_INTRO,
  resolvePageCopy,
} from "./pageCopy";
export interface LayoutProps {
  description: string;
  /** 站点绝对地址（后台「站点信息 → 网站 URL」）：canonical / og:url / JSON-LD 都要用它 */
  siteUrl: string;
  ipcNumber: string;
  since: string;
  ipcHref: string;
  // 公安备案
  gaBeianNumber: string;
  gaBeianUrl: string;
  gaBeianLogoUrl: string;
  copyrightAggreement: string;
  logo: string;
  categories: string[];
  favicon: string;
  siteName: string;
  siteDesc: string;
  baiduAnalysisID: string;
  gaAnalysisID: string;
  logoDark: string;
  version: string;
  menus: MenuItem[];
  showSubMenu: "true" | "false";
  showAdminButton: "true" | "false";
  headerLeftContent: "siteLogo" | "siteName";
  enableComment: "true" | "false";
  defaultTheme: "auto" | "dark" | "light";
  enableCustomizing: "true" | "false";
  showDonateButton: "true" | "false";
  showCopyRight: "true" | "false";
  showRSS: "true" | "false";
  showExpirationReminder: "true" | "false";
  openArticleLinksInNewWindow: "true" | "false";
  showEditButton: "true" | "false";
  /**
   * 主题 id，会写到 data-ui 上。apple（默认）/ default 是内置皮肤（见 styles/apple.css），
   * 其它值是后台「系统设置 → 主题」上传的自定义主题，样式来自 /api/public/theme.css。
   */
  uiStyle: string;
  subMenuOffset: number;
  articlesPerPage: number;
  defaultExpandAllCategories: "true" | "false";
  // 🔴 2026-09-21 移出：`friendLinkIntro` / `friendLinkApplyContent` / `aboutTitle`
  //    以前在 LayoutProps 里，于是**每一个页面**的 pageProps 都带着它们，
  //    而全仓只有两页真的读：`pages/link.tsx`（前两个）与 `pages/about.tsx`（aboutTitle）。
  //    实测（dev :3001，真数据）三者合计 **790B raw / ~750B gzip**，
  //    在 `/search` 上是 gzip 的 **5.7%**、`/about` 上 **4.9%**、`/category` 上 **3.5%**。
  //    ⇒ 改成"默认精简、需要的页面显式opt-in"（见下面的 FriendLinkCopy / AboutTitleCopy）。
  //    ⚠️ 方向是**默认精简**而不是"默认带上、各页记得删"：后者在新加页面时必然漏，
  //    而默认精简时漏掉的后果是"某页少了一段文案"，会被类型系统当场拦下（TS2339）。
  //    ⚠️ `customCss`/`customHtml`/`customHead`/`customScript` **不动**：
  //    它们被 `Layout → CustomLayout` 在**每个页面**渲染，是真的每页都要。
  customCss?: string;
  customScript?: string;
  customHtml?: string;
  customHead?: HeadTag[];
}

/** `/link` 专属的两段文案（只这一页读，见上面 LayoutProps 里的说明）。 */
export interface FriendLinkCopy {
  friendLinkIntro: string;
  friendLinkApplyContent: string;
}

/** `/about` 专属的标题（只这一页读）。 */
export interface AboutTitleCopy {
  aboutTitle: string;
}

export interface HeadTag {
  name: string;
  props: Record<string, string>;
  content: string;
}

export function getLayoutProps(data: PublicMetaProp): LayoutProps {
  // Public meta always includes siteInfo as an object; fields may be sparse.
  const siteInfo = data.meta.siteInfo;
  const showSubMenu =
    Boolean(data.meta.categories.length) && siteInfo.showSubMenu == "true";
  let headerLeftContent: "siteLogo" | "siteName" = "siteName";
  if (siteInfo.siteLogo && siteInfo.headerLeftContent == "siteLogo") {
    headerLeftContent = "siteLogo";
  }
  let showAdminButton: "true" | "false" = "true";
  if (siteInfo.showAdminButton && siteInfo.showAdminButton == "false") {
    showAdminButton = "false";
  }
  const customSetting: any = { enableCustomizing: "true" };
  if (siteInfo.enableCustomizing && siteInfo.enableCustomizing == "false") {
    customSetting.enableCustomizing = "false";
  }
  if (data?.layout?.css) {
    customSetting.customCss = data?.layout?.css;
  }
  if (data?.layout?.html) {
    customSetting.customHtml = data?.layout?.html;
  }
  if (data?.layout?.head) {
    customSetting.customHead = data?.layout?.head;
  }
  if (data?.layout?.script) {
    customSetting.customScript = data?.layout?.script;
  }
  let showDonateButton = "true";
  let showCopyRight = "true";
  if (siteInfo.showCopyRight == "false") {
    showCopyRight = "false";
  }
  if (siteInfo.showDonateButton == "false") {
    showDonateButton = "false";
  }
  let showRSS: "true" | "false" = "true";
  if (siteInfo.showRSS && siteInfo.showRSS == "false") {
    showRSS = "false";
  }
  let showExpirationReminder: "true" | "false" = "true";
  if (
    siteInfo.showExpirationReminder &&
    siteInfo.showExpirationReminder == "false"
  ) {
    showExpirationReminder = "false";
  }
  let showEditButton: "true" | "false" = "true";
  if (siteInfo.showEditButton && siteInfo.showEditButton == "false") {
    showEditButton = "false";
  }
  // ⚠️ 以前这里把除 "default" 之外的所有值都压成 "apple"，自定义主题 id 会被吃掉。
  //    现在原样透传：空值仍按历史默认 apple 处理，其它值（含自定义主题 id）保持不变。
  const uiStyle: string = String(siteInfo.uiStyle || "").trim() || "apple";
  let openArticleLinksInNewWindow: "true" | "false" = "false";
  if (
    siteInfo.openArticleLinksInNewWindow &&
    siteInfo.openArticleLinksInNewWindow == "true"
  ) {
    openArticleLinksInNewWindow = "true";
  }
  const defaultExpandAllCategories: "true" | "false" = isDefaultExpandAllCategories(
    siteInfo.defaultExpandAllCategories
  )
    ? "true"
    : "false";

  return {
    version: data?.version || "dev",
    subMenuOffset: siteInfo.subMenuOffset || 0,
    showAdminButton,
    headerLeftContent,
    copyrightAggreement: siteInfo.copyrightAggreement || "BY-NC-SA",
    ipcHref: siteInfo.beianUrl || "",
    ipcNumber: siteInfo.beianNumber || "",
    gaBeianNumber: siteInfo.gaBeianNumber || "",
    gaBeianLogoUrl: siteInfo.gaBeianLogoUrl || "",
    gaBeianUrl: siteInfo.gaBeianUrl || "",
    since: siteInfo.since || dayjs().toISOString(),
    logo: siteInfo.siteLogo || "",
    favicon: siteInfo.favicon,
    siteName: siteInfo.siteName,
    siteDesc: siteInfo.siteDesc,
    baiduAnalysisID: siteInfo.baiduAnalysisId || "",
    gaAnalysisID: normalizeGaAnalysisId(siteInfo.gaAnalysisId),
    logoDark: siteInfo.siteLogoDark || "",
    showExpirationReminder: showExpirationReminder,
    description: siteInfo.siteDesc || "",
    siteUrl: String(siteInfo.baseUrl || "").trim().replace(/\/+$/, ""),
    menus: data?.menus || defaultMenu,
    categories: data.meta.categories,
    showSubMenu: showSubMenu ? "true" : "false",
    enableComment: siteInfo.enableComment || "true",
    defaultTheme: siteInfo.defaultTheme || "auto",
    openArticleLinksInNewWindow,
    defaultExpandAllCategories,
    showCopyRight,
    showDonateButton,
    showRSS,
    showEditButton,
    uiStyle,
    articlesPerPage: sanitizeArticlesPerPage(siteInfo.articlesPerPage),
    ...customSetting,
  };
}

/**
 * `/link` 用的两段文案。⚠️ **只有 `getLinkPageProps` 该调它** —— 别的页面调了就等于
 * 把 790B 白传又装回去（守卫钉住了调用点数量）。
 *
 * 口径与移出前逐字一致：同样走 `resolvePageCopy(后台值, 内置默认值)`，
 * 所以"后台没填就用默认文案"这个既有行为没有变（`pageCopy.spec.ts` 仍绿）。
 */
export function getFriendLinkCopy(data: PublicMetaProp): FriendLinkCopy {
  const siteInfo = data.meta.siteInfo;
  return {
    friendLinkIntro: resolvePageCopy(
      siteInfo.friendLinkIntro,
      DEFAULT_FRIEND_LINK_INTRO
    ),
    friendLinkApplyContent: resolvePageCopy(
      siteInfo.friendLinkApplyContent,
      DEFAULT_FRIEND_LINK_APPLY_CONTENT
    ),
  };
}

/** `/about` 用的标题。⚠️ 同上，只有 `getAboutPageProps` 该调它。 */
export function getAboutTitleCopy(data: PublicMetaProp): AboutTitleCopy {
  // ⚠️ 必须走一个局部绑定，不要内联解引用 siteInfo 的子字段：
  //    #207 那条守卫钉的就是"这个文件里所有 siteInfo 都通过局部绑定读"，
  //    因为内联解引用在 siteInfo 缺失时会抛 TypeError（那是一次真机 500 的根因）。
  //    ⚠️ 连**注释里**也不要写出那条点号路径的字面量：该守卫只删掉绑定行、不剥注释，
  //    写出来就会把它自己打红（本仓库已多次踩到"注释触发不存在断言"这个形状）。
  const siteInfo = data.meta.siteInfo;
  return {
    aboutTitle: resolvePageCopy(siteInfo.aboutTitle, DEFAULT_ABOUT_TITLE),
  };
}

export function getAuthorCardProps(data: PublicMetaProp): AuthorCardProps {
  const siteInfo = data.meta.siteInfo;
  const showSubMenu =
    Boolean(data.meta.categories.length) && siteInfo.showSubMenu == "true";
  let showRSS: "true" | "false" = "true";
  if (siteInfo.showRSS && siteInfo.showRSS == "false") {
    showRSS = "false";
  }
  return {
    postNum: data.totalArticles,
    tagNum: data.tags.length,
    catelogNum: data.meta.categories.length,
    socials: data.meta.socials,
    author: siteInfo.author,
    desc: siteInfo.authorDesc,
    logo: siteInfo.authorLogo,
    logoDark: siteInfo.authorLogoDark || "",
    showSubMenu: showSubMenu ? "true" : "false",
    showRSS,
  };
}
