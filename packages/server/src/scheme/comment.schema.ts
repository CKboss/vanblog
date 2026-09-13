import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CommentDocument = NativeComment & Document;

/** 评论状态：待审 / 已通过 / 垃圾 / 已删除（软删） */
export type CommentStatus = 'pending' | 'approved' | 'spam' | 'deleted';

/**
 * 内置评论（不依赖 Waline 子进程，直接存在本站的 Mongo 里）。
 *
 * 结构是**两层**：顶层评论 `rootId = 0`；回复挂到所属顶层评论上（`rootId = 顶层 id`），
 * 同时记住直接回复的那条（`parentId` + `replyToNick`）用于显示「回复 @某人」。
 * 两层是刻意的：无限嵌套在移动端几乎没法看，也和 Waline 的表现一致。
 */
@Schema()
export class NativeComment extends Document {
  @Prop({ index: true, unique: true })
  id: number;

  /** 文章路径，与 visits 表用的 pathname 一致（`/post/<slug>` 或 `/post/<id>`） */
  @Prop({ index: true })
  path: string;

  /** 冗余的文章数字 id，便于后台按文章筛选 */
  @Prop({ index: true, default: 0 })
  articleId: number;

  /** 0 = 顶层评论；否则是所属顶层评论的 id */
  @Prop({ index: true, default: 0 })
  rootId: number;

  /** 直接回复的评论 id（0 = 不是回复） */
  @Prop({ default: 0 })
  parentId: number;

  @Prop()
  replyToNick: string;

  @Prop()
  nick: string;

  @Prop()
  email: string;

  @Prop()
  site: string;

  /** 原始 markdown；渲染在前台做（复用正文那套 sanitize，但白名单更严） */
  @Prop()
  content: string;

  @Prop({ index: true, default: 'approved' })
  status: CommentStatus;

  /** 博主自己的评论（邮箱与 siteInfo.authorEmail 一致）会有标识 */
  @Prop({ default: false })
  isAuthor: boolean;

  /** 转待审/垃圾的原因，只在后台可见 */
  @Prop()
  reason: string;

  @Prop()
  ip: string;

  @Prop()
  ua: string;

  @Prop({
    index: true,
    default: () => new Date(),
  })
  createdAt: Date;

  @Prop({
    default: () => new Date(),
  })
  updatedAt: Date;
}

export const NativeCommentSchema = SchemaFactory.createForClass(NativeComment);
