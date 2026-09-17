import { SortOrder } from './sort';

export class CreateArticleDto {
  title: string;
  content?: string;
  tags?: string[];
  top?: number;
  category: string;
  hidden?: boolean;
  private?: boolean;
  /**
   * 访问密码（**明文入参**）。服务端存的是 scrypt 哈希，且任何响应都不会把它
   * （或哈希）回传，只回布尔 `hasPassword`。
   * 新建：留空/缺键 = 不加密。
   */
  password?: string;
  /**
   * 显式解除加密。因为 `password` 留空已经被定义成"不修改"（表单不再回填密文），
   * 清除必须走这个独立开关，不能复用空值 —— 否则任何一次没碰密码框的保存都会把
   * 加密悄悄抹掉。只认 `true` / `'true'`；与"填了新密码"同时出现 ⇒ 400。
   * 规则的唯一真源：utils/accessPassword.ts。
   */
  clearPassword?: boolean;
  updatedAt?: Date;
  createdAt?: Date;
  author?: string;
  copyright?: string;
  pathname?: string;
  cover?: string;
  /**
   * 定时发布（P5）：ISO 字符串 / 毫秒数 / Date；null = 显式清除；键不存在 = 不设置。
   * 未来时间 ⇒ 到点前所有公开面不可见（见 utils/publishAt.ts）。
   * 入库前由 normalizePublishAt 校验，非法值 400。
   */
  publishAt?: Date | string | number | null;
}
export class UpdateArticleDto {
  title?: string;
  content?: string;
  tags?: string[];
  category?: string;
  hidden?: boolean;
  top?: number;
  private?: boolean;
  /**
   * 访问密码（**明文入参**），存 scrypt 哈希。
   * 更新：**留空/缺键 = 不修改**（不是清空！表单不再回填密文，见 clearPassword）。
   */
  password?: string;
  /** 显式解除加密；语义与 CreateArticleDto.clearPassword 完全一致 */
  clearPassword?: boolean;
  deleted?: boolean;
  viewer?: number;
  visited?: number;
  updatedAt?: Date;
  author?: string;
  copyright?: string;
  pathname?: string;
  cover?: string;
  /** 定时发布（P5）：语义同 CreateArticleDto.publishAt（null=清除，undefined=不动） */
  publishAt?: Date | string | number | null;
}
export class SearchArticleOption {
  page: number;
  pageSize: number;
  regMatch: boolean;
  category?: string;
  tags?: string;
  title?: string;
  sortCreatedAt?: SortOrder;
  sortTop?: SortOrder;
  startTime?: string;
  endTime?: string;
  sortViewer?: string;
  toListView?: boolean;
  withWordCount?: boolean;
  /**
   * 让列表项带上服务端算好的摘要（`excerpt`）与正文首图（`firstImage`）。
   * 显式 opt-in：默认不下发，管理端与既有调用方的响应形状**一个字节都不变**。
   * 与 `toListView` 搭配时正文 `content` 会在算完摘要后剥掉 —— 前台首页/分页
   * 因此不再把全文塞进 __NEXT_DATA__（实测 5 篇正文 25,053 B，摘要只要 3,263 B）。
   */
  withExcerpt?: boolean;
  author?: string;
}

/**
 * `withExcerpt` 时公开列表项在 `Article` 之外多出的字段。
 * 不入库，`ArticleProvider.getByOption` 在查询时现算；私密文章**没有**这两个字段
 * （正文被过滤掉了，摘要也不能泄露加密内容）。
 */
export interface ArticleExcerptFields {
  /** 与前台 `articleOverviewMarkdown` 逐字符一致的摘要：`<!-- more -->` 之前；无标记取前 200 字 */
  excerpt?: string;
  /** 正文里文档顺序的第一张可用图（卡片缩略图兜底；有 cover 时前台仍优先 cover） */
  firstImage?: string;
}
