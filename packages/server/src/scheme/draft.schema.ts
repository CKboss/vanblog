import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DraftDocument = Draft & Document;

@Schema()
export class Draft extends Document {
  @Prop({ index: true, unique: true })
  id: number;

  @Prop({ index: true })
  title: string;

  @Prop({ default: '' })
  content: string;

  @Prop({ default: [], index: true })
  tags: string[];

  @Prop({ index: true })
  author: string;

  @Prop({ index: true })
  category: string;

  @Prop({ default: false, index: true })
  deleted: boolean;

  /**
   * 软删时间；null = 未删除。老数据没有该字段（不回填），列表按 `deletedAt ?? updatedAt` 兜底。
   * ⚠️ 草稿的软删有一个既有语义：**发布草稿也会软删它**（draft.provider.publish），
   * 所以回收站里会看到"已发布"的草稿 —— 恢复它不会动已发布的文章，只是把草稿副本拿回来。
   */
  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  @Prop({
    index: true,
    default: () => {
      return new Date();
    },
  })
  createdAt: Date;

  @Prop({
    index: true,
    default: () => {
      return new Date();
    },
  })
  updatedAt: Date;
}

export const DraftSchema = SchemaFactory.createForClass(Draft);
