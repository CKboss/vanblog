export class SiteInfo {
  author: string;
  authorLogo: string;
  authorLogoDark: string;
  authDesc: string;
  siteLogo: string;
  siteLogoDark: string;
  favicon: string;
  siteName: string;
  siteDesc: string;
  beianNumber: string;
  beianUrl: string;
  gaBeianNumber: string;
  gaBeianUrl: string;
  gaBeianLogoUrl: string;
  payAliPay: string;
  payWechat: string;
  payAliPayDark: string;
  payWechatDark: string;
  since: Date;
  baseUrl: string;
  gaAnalysisId: string;
  baiduAnalysisId: string;
  copyrightAggreement: string;
  enableComment?: 'true' | 'false';
  showSubMenu?: 'true' | 'false';
  headerLeftContent?: 'siteLogo' | 'siteName';
  subMenuOffset: number;
  showAdminButton: 'true' | 'false';
  showDonateInfo: 'true' | 'false';
  showFriends: 'true' | 'false';
  showCopyRight: 'true' | 'false';
  showDonateButton: 'true' | 'false';
  showDonateInAbout: 'true' | 'false';
  allowOpenHiddenPostByUrl: 'true' | 'false';
  defaultTheme: 'auto' | 'dark' | 'light';
  enableCustomizing: 'true' | 'false';
  showRSS: 'true' | 'false';
  openArticleLinksInNewWindow: 'true' | 'false';
  showExpirationReminder?: 'true' | 'false';
  showEditButton?: 'true' | 'false';
  /** Front home /page/n list size. Default 5, clamped to 1–50. */
  articlesPerPage?: number;
  /** Public /category list: expand every category on first load. Default collapsed. */
  defaultExpandAllCategories?: 'true' | 'false';
  /** Friend-link page intro above the cards. Empty/unset keeps the previous hardcoded line. */
  friendLinkIntro?: string;
  /** Friend-link page markdown below the cards. Empty/unset keeps the previous hardcoded apply text. */
  friendLinkApplyContent?: string;
  /** About page title. Empty/unset keeps「关于我」. Body is still edited via 编辑关于. */
  aboutTitle?: string;
  /**
   * 前台主题 id，会写到前台最外层容器与 <html> 的 `data-ui` 上。
   * - `apple`（默认）：Apple 开发者新闻页那种排版，样式打包在前台的 styles/apple.css 里；
   * - `default`：原本的卡片风格，不加任何主题样式；
   * - 其它值：后台「系统设置 → 主题」上传的**自定义主题 id**，样式由
   *   `/api/public/theme.css` 提供，主题自己用 `[data-ui="<id>"]` 收窄作用域。
   * 只影响样式，不动 DOM 结构；随时可以切回去。
   */
  uiStyle?: string;
}
export interface updateUserDto {
  username: string;
  password: string;
}
export type UpdateSiteInfoDto = Partial<SiteInfo> | Partial<updateUserDto>;
