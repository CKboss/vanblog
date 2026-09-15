import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ArticleDocument = Article & Document;

@Schema()
export class Article extends Document {
  @Prop({ index: true, unique: true })
  id: number;

  @Prop({ index: true })
  title: string;

  @Prop({ default: '' })
  content: string;

  @Prop({ default: [], index: true })
  tags: string[];

  @Prop({ default: 0, index: true })
  top: number;

  @Prop({ index: true })
  category: string;

  @Prop({ default: false, index: true })
  hidden: boolean;

  @Prop({ index: true })
  author: string;

  @Prop({ default: '', index: true })
  pathname: string;

  @Prop({ default: false, index: true })
  private: boolean;

  @Prop({ default: '' })
  password: string;

  @Prop({ default: false, index: true })
  deleted: boolean;

  // 这三个字段是后台「阅读排行 / 最近浏览」和列表按热度排序的依据，
  // 没索引时每次都是全表扫 + 内存排序（explain 里能看到 SORT 阶段），文章一多就顶不住。
  @Prop({ default: 0, index: true })
  viewer: number;

  @Prop({ default: 0, index: true })
  visited: number;

  @Prop()
  copyright?: string;

  @Prop({ default: '' })
  cover?: string;

  @Prop({ index: true })
  lastVisitedTime: Date;

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

export const ArticleSchema = SchemaFactory.createForClass(Article);
