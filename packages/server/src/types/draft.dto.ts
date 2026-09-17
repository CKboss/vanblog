import { SortOrder } from './sort';

export class CreateDraftDto {
  title: string;
  content?: string;
  tags?: string[];
  category: string;
  author?: string;
  draft?: string;
}
export class UpdateDraftDto {
  title?: string;
  content?: string;
  tags?: string[];
  category?: string;
  deleted?: boolean;
  author?: string;
  draft?: string;
}
export class PublishDraftDto {
  hidden?: boolean;
  pathname?: string;
  private?: boolean;
  /**
   * 访问密码（**明文入参**）。发布草稿 = 新建文章，所以这里**留空就是"不加密"**
   * （没有"保持原值"可言）；入库时由 articleProvider.create() 换成 scrypt 哈希。
   */
  password?: string;
  /** 与 CreateArticleDto.clearPassword 同义；发布场景下基本用不到（本来就是空的） */
  clearPassword?: boolean;
  copyright?: string;
  /** 定时发布（P5）：发布草稿时也可以直接定一个未来时间；
   *  归一化/校验发生在 articleProvider.create()（非法值 400，null=不定时）。 */
  publishAt?: Date | string | number | null;
}
export class SearchDraftOption {
  page: number;
  pageSize: number;
  category?: string;
  tags?: string;
  title?: string;
  sortCreatedAt?: SortOrder;
  startTime?: string;
  endTime?: string;
  toListView?: boolean;
}
