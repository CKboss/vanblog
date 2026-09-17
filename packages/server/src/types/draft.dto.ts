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
  password?: string;
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
