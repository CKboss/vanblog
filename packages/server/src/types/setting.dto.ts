import { MenuItem } from './menu.dto';

/** 长边超过这个像素就等比缩小（"1080p 级"）。 */
export const DEFAULT_MAX_IMAGE_EDGE = 1920;
/** 图片管理列表用的缩略图宽度。 */
export const DEFAULT_THUMB_WIDTH = 300;

export const defaultStaticSetting: StaticSetting = {
  storageType: 'local',
  picgoConfig: null,
  enableWaterMark: false,
  enableWebp: true,
  compressFormat: 'webp',
  waterMarkText: null,
  picgoPlugins: null,
  enableResize: true,
  maxImageEdge: DEFAULT_MAX_IMAGE_EDGE,
  enableThumb: true,
  thumbWidth: DEFAULT_THUMB_WIDTH,
  enableStegoWaterMark: true,
  stegoWaterMarkText: null,
};

export type SettingType =
  | 'static'
  | 'https'
  | 'waline'
  | 'comment'
  | 'layout'
  | 'login'
  | 'menu'
  | 'version'
  | 'isr';

export type SettingValue =
  | StaticSetting
  | HttpsSetting
  | WalineSetting
  | CommentSetting
  | LayoutSetting
  | VersionSetting
  | ISRSetting;

/** 评论用哪一套：内置（本站 Mongo + 本站接口）/ Waline（外挂子进程）/ 关闭 */
export type CommentProvider = 'builtin' | 'waline' | 'off';

/**
 * 审核策略：
 * - `post` 先发后审：默认直接显示，命中规则（关键词 / 频率 / 蜜罐 / 带外链）自动转待审
 * - `pre`  先审后发：一律待审，后台放行才显示
 * - `none` 不审核：全部直接显示（只提供删除）
 */
export type CommentModeration = 'post' | 'pre' | 'none';

export interface CommentSetting {
  provider: CommentProvider;
  moderation: CommentModeration;
  /** 命中即转待审的关键词（大小写不敏感，支持子串） */
  keywords: string[];
  /** 是否必填邮箱 */
  requireEmail: boolean;
  /** 评论里出现外链时是否转待审 */
  pendingOnLink: boolean;
  /** 单条内容长度上限 */
  maxContentLength: number;
  /** 同一 IP 每 10 分钟最多发几条 */
  rateLimitPer10Min: number;
}

/** 可以给前台的评论设置（不含关键词等规则细节） */
export type PublicCommentSetting = Pick<
  CommentSetting,
  'provider' | 'moderation' | 'requireEmail' | 'maxContentLength'
>;

export interface ISRSetting {
  mode: 'delay' | 'onDemand';
  delay: number;
}

export interface MenuSetting {
  data: MenuItem[];
}

export type StorageType = 'picgo' | 'local';
/** `file` = 附件管理（任意文件），与图片共用 statics 表和 /static 静态服务。 */
export type StaticType = 'img' | 'customPage' | 'file';
export type CompressFormat = 'webp' | 'avif';
export interface LoginSetting {
  enableMaxLoginRetry: boolean;
  maxRetryTimes: number;
  durationSeconds: number;
  expiresIn: number;
}
export interface VersionSetting {
  version: string;
}

// export interface ScriptItem {
//   type: 'code' | 'link';
//   value: string;
// }

export interface LayoutSetting {
  script: string;
  html: string;
  css: string;
  head: string;
}

export interface HeadTag {
  name: string;
  props: Record<string, string>;
  conent: string;
}

export interface WalineSetting {
  'smtp.enabled': boolean;
  'smtp.port': number;
  'smtp.host': string;
  'smtp.user': string;
  'smtp.password': string;
  'sender.name': string;
  'sender.email': string;
  authorEmail: string;
  webhook?: string;
  forceLoginComment: boolean;
  otherConfig?: string;
}

export interface HttpsSetting {
  redirect: boolean;
}
export interface SearchStaticOption {
  staticType: StaticType;
  page: number;
  pageSize: number;
  view: 'admin' | 'public';
  /** 可选：按文件名模糊搜索（附件管理用） */
  name?: string;
}
export const StoragePath: Record<StaticType, string> = {
  img: `img`,
  customPage: `customPage`,
  file: `file`,
};
/** 缩略图放在图片目录下的这个子目录里，跟着图片一起备份/导出。 */
export const THUMB_FOLDER = 'thumb';
export class StaticSetting {
  storageType: StorageType;
  picgoConfig: any;
  picgoPlugins: string;
  enableWaterMark: boolean;
  waterMarkText: string;
  enableWebp: boolean;
  /** Output format when enableWebp is on. Default webp. */
  compressFormat?: CompressFormat;
  /** 上传时是否把大图缩到 maxImageEdge 以内（只缩不放）。 */
  enableResize?: boolean;
  /** 长边上限，0 表示不限制。默认 1920。 */
  maxImageEdge?: number;
  /** 是否为图片生成缩略图（图片管理列表用）。 */
  enableThumb?: boolean;
  /** 缩略图宽度，默认 300。 */
  thumbWidth?: number;
  /** 隐写水印（肉眼不可见，可从图片里提取回来）。 */
  enableStegoWaterMark?: boolean;
  /** 隐写内容，留空则写「域名|上传者|时间」。 */
  stegoWaterMarkText?: string;
  /** 隐写密钥，首次启用时自动生成并持久化；换密钥后旧图读不出来。 */
  stegoKey?: string;
}
