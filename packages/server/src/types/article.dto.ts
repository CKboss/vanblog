import { SortOrder } from './sort';

export class CreateArticleDto {
  title: string;
  content?: string;
  tags?: string[];
  top?: number;
  category: string;
  hidden?: boolean;
  private?: boolean;
  password?: string;
  updatedAt?: Date;
  createdAt?: Date;
  author?: string;
  copyright?: string;
  pathname?: string;
  cover?: string;
}
export class UpdateArticleDto {
  title?: string;
  content?: string;
  tags?: string[];
  category?: string;
  hidden?: boolean;
  top?: number;
  private?: boolean;
  password?: string;
  deleted?: boolean;
  viewer?: number;
  visited?: number;
  updatedAt?: Date;
  author?: string;
  copyright?: string;
  pathname?: string;
  cover?: string;
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
