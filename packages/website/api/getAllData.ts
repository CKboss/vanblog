import { HeadTag } from "../utils/getLayoutProps";
import { config } from "../utils/loadConfig";
export type SocialType =
  | "bilibili"
  | "email"
  | "github"
  | "wechat"
  | "gitee"
  | "wechat-dark"
  | "custom"
  | string;
export const defaultMenu: MenuItem[] = [
  {
    id: 0,
    name: "首页",
    value: "/",
    level: 0,
  },
  {
    id: 1,
    name: "标签",
    value: "/tag",
    level: 0,
  },
  {
    id: 2,
    name: "分类",
    value: "/category",
    level: 0,
  },
  {
    id: 3,
    name: "时间线",
    value: "/timeline",
    level: 0,
  },
  {
    id: 4,
    name: "友链",
    value: "/link",
    level: 0,
  },
  {
    id: 5,
    name: "关于",
    value: "/about",
    level: 0,
  },
];
export interface CustomPageList {
  name: string;
  path: string;
}
export interface CustomPage extends CustomPageList {
  html: string;
}
export interface SocialItem {
  updatedAt: string;
  type: SocialType;
  value: string;
  dark?: string;
  label?: string;
  icon?: string;
  id?: string;
}
export interface MenuItem {
  id: number;
  name: string;
  value: string;
  level: number;
  children?: MenuItem[];
}
export interface DonateItem {
  name: string;
  value: string;
  updatedAt: string;
}
export interface LinkItem {
  name: string;
  desc: string;
  logo: string;
  url: string;
  updatedAt: string;
}
/** Public `/api/public/meta` always includes this object; some fields may be absent. */
export interface SiteInfo {
  author: string;
  authorDesc: string;
  authorLogo: string;
  authorLogoDark?: string;
  siteLogo: string;
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
  payAliPayDark?: string;
  payWechatDark?: string;
  since: string;
  baseUrl: string;
  baiduAnalysisId?: string;
  gaAnalysisId?: string;
  siteLogoDark?: string;
  copyrightAggreement: string;
  showSubMenu?: "true" | "false";
  showAdminButton?: "true" | "false";
  headerLeftContent?: "siteLogo" | "siteName";
  subMenuOffset?: number;
  showDonateInfo: "true" | "false";
  showFriends: "true" | "false";
  enableComment: "true" | "false";
  defaultTheme: "auto" | "light" | "dark";
  showDonateInAbout?: "true" | "false";
  enableCustomizing: "true" | "false";
  showDonateButton: "true" | "false";
  showCopyRight: "true" | "false";
  showRSS: "true" | "false";
  openArticleLinksInNewWindow: "true" | "false";
  showExpirationReminder: "true" | "false";
  showEditButton: "true" | "false";
  articlesPerPage?: number;
  defaultExpandAllCategories?: "true" | "false";
  friendLinkIntro?: string;
  friendLinkApplyContent?: string;
  aboutTitle?: string;  /** 前台界面风格：apple（默认）| default，见 styles/apple.css */
  /** 主题 id：default / apple（内置）或后台上传的自定义主题 id */
  uiStyle?: string;
}
export interface MetaProps {
  links: LinkItem[];
  socials: SocialItem[];
  rewards: DonateItem[];
  categories: string[];
  about: {
    updatedAt: string;
    content: string;
  };
  siteInfo: SiteInfo;
}
export interface PublicMetaProp {
  version: string;
  tags: string[];
  totalArticles: number;
  meta: MetaProps;
  menus: MenuItem[];
  totalWordCount: number;
  layout?: {
    css?: string;
    script?: string;
    html?: string;
    head?: HeadTag[];
  };
}

export const version = process.env["VAN_BLOG_VERSION"] || "dev";

const defaultMeta: MetaProps = {
  categories: [],
  links: [],
  socials: [],
  rewards: [],
  about: {
    updatedAt: new Date().toISOString(),
    content: "",
  },
  siteInfo: {
    author: "作者名字",
    authorDesc: "作者描述",
    authorLogo: "/logo.svg",
    siteLogo: "/logo.svg",
    favicon: "/logo.svg",
    siteName: "VanBlog",
    siteDesc: "Vanblog",
    copyrightAggreement: "",
    beianNumber: "",
    beianUrl: "",
    gaBeianNumber: "",
    gaBeianUrl: "",
    gaBeianLogoUrl: "",
    payAliPay: "",
    payWechat: "",
    payAliPayDark: "",
    payWechatDark: "",
    since: "",
    enableComment: "true",
    baseUrl: "",
    showDonateInfo: "true",
    showFriends: "true",
    showAdminButton: "true",
    defaultTheme: "auto",
    showDonateInAbout: "false",
    enableCustomizing: "true",
    showCopyRight: "true",
    showDonateButton: "true",
    showExpirationReminder: "true",
    showRSS: "true",
    openArticleLinksInNewWindow: "false",
    showEditButton: "false",
    articlesPerPage: 5,
    defaultExpandAllCategories: "false",
  },
};

/**
 * `/api/public/meta` 的进程内短缓存。
 *
 * 为什么需要：server 每次保存文章都会触发一次全量重渲染（ISR），
 * 一轮要渲染 ~130 个页面（每篇文章的 id 与别名两条路径 + 分页 + 分类 + 标签 + 6 个固定页），
 * 而**每个页面都会调一次 getPublicMeta** —— 同一份 8KB 的 meta 被重复拉 130 次（~1MB），
 * 而且是串行的。接口本身只发 ETag、不发 Cache-Control，undici 也没法复用。
 *
 * 5 秒 TTL 足够把一轮重渲染里的重复请求压成 1 次，又不会让后台改完站点信息看到旧数据
 * （改完本来就靠 revalidate 触发重渲染，5 秒的窗口在里面看不见）。
 * ⚠️ 只缓存**成功**的结果：构建期连不上 server 时走的是默认值分支，
 * 那个不能缓存，否则整个构建过程都会拿着空数据渲染。
 */
const META_CACHE_TTL_MS = 5000;
let metaCache: { at: number; data: PublicMetaProp } | null = null;
let metaInflight: Promise<PublicMetaProp> | null = null;

export function __resetPublicMetaCache() {
  metaCache = null;
  metaInflight = null;
}

export async function getPublicMeta(): Promise<PublicMetaProp> {
  const now = Date.now();
  if (metaCache && now - metaCache.at < META_CACHE_TTL_MS) {
    return metaCache.data;
  }
  // 并发调用共享同一个请求（一轮重渲染里多个页面是并行进来的）
  if (metaInflight) {
    return metaInflight;
  }
  metaInflight = fetchPublicMeta().then(
    (data) => {
      metaInflight = null;
      metaCache = { at: Date.now(), data };
      return data;
    },
    (err) => {
      metaInflight = null;
      throw err;
    },
  );
  return metaInflight;
}

async function fetchPublicMeta(): Promise<PublicMetaProp> {
  try {
    const url = `${config.baseUrl}api/public/meta`;
    const res = await fetch(url);
    const { statusCode, data } = await res.json();
    if (statusCode == 233) {
      return {
        version: version,
        totalWordCount: 0,
        menus: defaultMenu,
        tags: [],
        totalArticles: 0,
        meta: defaultMeta,
      };
    }
    return data;
  } catch (err) {
    if (process.env.isBuild == "t") {
      console.log("无法连接，采用默认值");
      // 给一个默认的吧。
      return {
        version: version,
        totalWordCount: 0,
        tags: [],
        menus: defaultMenu,
        totalArticles: 0,
        meta: defaultMeta,
      };
    } else {
      throw err;
    }
  }
}
export async function getAllCustomPages(): Promise<CustomPageList[]> {
  try {
    const url = `${config.baseUrl}api/public/customPage/all`;
    const res = await fetch(url);
    const { statusCode, data } = await res.json();
    if (statusCode == 200) {
      return data;
    } else {
      return [];
    }
  } catch (err) {
    if (process.env.isBuild == "t") {
      console.log("无法连接，采用默认值");
      // 给一个默认的吧。
      return [];
    } else {
      throw err;
    }
  }
}
export async function getCustomPageByPath(
  path: string
): Promise<CustomPage | null> {
  try {
    // path 必须编码：自定义页面路径里出现空格 / & / # 时原来会拼出错误的查询串
    const url = `${config.baseUrl}api/public/customPage?path=${encodeURIComponent(path)}`;
    const res = await fetch(url);
    const { statusCode, data } = await res.json();
    if (statusCode == 200) {
      return data;
    } else {
      return null;
    }
  } catch (err) {
    if (process.env.isBuild == "t") {
      console.log("无法连接，采用默认值");
      // 给一个默认的吧。
      return null;
    } else {
      throw err;
    }
  }
}
