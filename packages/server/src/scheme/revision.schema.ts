import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RevisionDocument = ArticleRevision & Document;

/**
 * 文章历史版本（极简版）：只存"最近 N 次保存前的状态"，可查看、可恢复。
 *
 * 设计决定：
 * - **独立集合**（`revisions`），不在 article 文档里内嵌 content 数组 ——
 *   内嵌会让每次列表查询与整站备份都背上全部历史正文。
 * - 存的是**被这次保存替换掉的旧状态**（pre-update 快照）：这样"恢复到任意一条"
 *   才有意义（最新状态永远在 articles 表里，不需要也不应该再存一份）。
 * - 恢复操作本身也会先给"恢复前的当前状态"记一条（reason='pre-restore'），
 *   所以恢复也是可撤销的。
 * - 每篇文章的条数上限由 `VANBLOG_ARTICLE_REVISIONS_KEEP` 控制（默认 10，0=关闭），
 *   超限淘汰最旧的（见 revision.provider）。
 */
@Schema()
export class ArticleRevision extends Document {
  /** 文章的数字 id（articles.id，不是 ObjectId） */
  @Prop({ required: true, index: true })
  articleId: number;

  @Prop({
    required: true,
    index: true,
    default: () => new Date(),
  })
  savedAt: Date;

  @Prop({ default: '' })
  title: string;

  /** 快照正文（markdown 原样） */
  @Prop({ default: '' })
  content: string;

  /** 快照正文的字数（utils/wordCount，CJK 感知） */
  @Prop({ default: 0 })
  wordCount: number;

  /** 快照正文的 UTF-8 字节数（存储成本可观测） */
  @Prop({ default: 0 })
  sizeBytes: number;

  /** 'update'（保存文章时）| 'pre-restore'（恢复历史版本前的当前状态） */
  @Prop({ default: 'update' })
  reason: string;
}

export const RevisionSchema = SchemaFactory.createForClass(ArticleRevision);
// 列表/淘汰都按 (articleId, savedAt desc) 走
RevisionSchema.index({ articleId: 1, savedAt: -1 });
