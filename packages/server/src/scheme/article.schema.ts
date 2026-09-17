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

  /**
   * 软删（移入回收站）的时间；null = 不在回收站里。
   * 老数据没有这个字段（不需要回填）：回收站列表按 `deletedAt ?? updatedAt` 排序兜底。
   * 故意**不加索引**：回收站查询先用 `deleted:true`（有索引）过滤，剩余集合很小，
   * 在小集合上排序不值得为每次写入多维护一个索引。
   */
  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  /**
   * 定时发布时间（P5）；null = 不定时、立即可见。
   * 语义是**查询层的"到点前视为未发布"**：所有公开读路径都带
   * `publishAt <= now` 过滤（utils/publishAt.ts），到点自动可见，
   * 不依赖任何 cron 去翻 `hidden` 字段；cron（schedule/publish.task.ts）
   * 只负责到点时触发 ISR 重渲染与点名日志。
   */
  @Prop({ type: Date, default: null, index: true })
  publishAt: Date | null;

  /**
   * 正文字数（utils/wordCount，CJK 感知）的**存储副本**：
   * 让列表/相关文章/回收站这些"投影里不许带 content"的查询也能出
   * readingMinutes 与 wordCount。create/updateById 维护，老文档由
   * 启动回填（迁移台账 `backfill:articleWordCount`）补齐。
   * 故意不加索引：只做投影输出，不做过滤/排序条件。
   */
  @Prop({ default: 0 })
  wordCount: number;

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
