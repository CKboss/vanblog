export class SiteInfo {
  author: string;
  authorLogo: string;
  authorLogoDark: string;
  /**
   * 作者描述。
   *
   * ⚠️ 这个字段以前叫 `authDesc`（上游遗留的拼写错误），而**读它的一侧从来都是 `authorDesc`**：
   * 后台表单 `SiteInfoForm/index.tsx`、前台 `website/api/getAllData.ts` 与
   * `website/utils/getLayoutProps.ts` 用的都是 `authorDesc`。因为 `Meta.siteInfo` 是
   * `@Prop()` 的 Mixed 型（不做嵌套裁剪），后台存进来的 `authorDesc` 一直能落库、前台也一直读得到，
   * 所以这个错拼**没有暴露成故障**，只是让 DTO 与现实脱节：唯一真写 `authDesc` 的地方是零接触初始化
   * （`envBootstrap.minimalSiteInfo`），于是用 `VANBLOG_ADMIN_USER` + `_PASSWORD` 初始化的站点，
   * 库里躺着一个人也不读的 `authDesc: ''`，而前台要的 `authorDesc` 是 undefined
   * （`getLayoutProps` 的默认值只在整份 meta 缺失时才生效）⇒ 要等站长去后台填一次才有。
   * 现在统一成 `authorDesc`；遗留数据由 `InitProvider.washAuthorDesc()` 在启动时迁移（幂等）。
   */
  authorDesc: string;
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
