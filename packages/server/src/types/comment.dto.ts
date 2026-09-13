import { CommentStatus } from 'src/scheme/comment.schema';

/** 发表/回复评论（公开接口） */
export interface CreateCommentDto {
  path: string;
  /** 直接回复的评论 id；不传或 0 表示发顶层评论 */
  parentId?: number;
  nick: string;
  email?: string;
  site?: string;
  content: string;
  /** 蜜罐字段：真人看不见也不会填，机器人会填 → 直接判垃圾 */
  hp?: string;
}

export interface QueryCommentOption {
  path: string;
  page?: number;
  pageSize?: number;
  /** asc = 旧的在上（默认）；desc = 新的在上 */
  sort?: 'asc' | 'desc';
}

/** 返回给前台的评论（不含 ip / ua / reason / email） */
export interface PublicComment {
  id: number;
  path: string;
  rootId: number;
  parentId: number;
  replyToNick?: string;
  nick: string;
  site?: string;
  content: string;
  status: CommentStatus;
  isAuthor: boolean;
  createdAt: string;
  children?: PublicComment[];
  replyCount?: number;
}

/** 后台管理用的列表查询 */
export interface AdminCommentOption {
  page?: number;
  pageSize?: number;
  status?: CommentStatus | 'all';
  path?: string;
  keyword?: string;
}

export interface UpdateCommentDto {
  status?: CommentStatus;
  content?: string;
  nick?: string;
  isAuthor?: boolean;
}
