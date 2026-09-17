import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { accessPasswordToJson } from 'src/utils/accessPassword';

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

  /**
   * 访问密码。**存的是 scrypt 哈希**（`utils/accessPassword.ts` 的写入规则），
   * 历史文档里可能还是明文 —— 校验用 `verifyAccessPassword`（两种都认，常量时间），
   * 启动 wash `wash:accessPasswords` 会把明文洗成哈希。
   * 这个字段**永不出现在任何 JSON 响应里**（见文件末尾的 toJSON transform），
   * 对外只有一个布尔 `hasPassword`。
   */
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

/**
 * 访问密码**绝不下发**：任何被 JSON 序列化的文章文档，`password` 都会被换成布尔
 * `hasPassword`（后台表单只需要知道"有没有设"；值是明文还是哈希都不能给 ——
 * 哈希一样能被离线爆破，而"表单要回填"这个前提正是明文存储一直删不掉的原因）。
 *
 * 为什么挂在 schema 的 toJSON 上，而不是逐个接口去 delete：这是一道**结构性**兜底。
 * 新建 / 更新 / 从回收站恢复 / 发布草稿这些接口今天都是把 mongoose 文档直接丢进
 * 响应体的，逐个删迟早漏一个；挂在这里，以后新加的路由也漏不出去。
 *
 * 刻意只挂 `toJSON`、不挂 `toObject`：服务端内部仍需要读到真实存储值 ——
 * `getByIdWithPassword()` 的校验、整站备份的分类导出（`toExportCategory` 读
 * `doc.password`）、markdown 导出的 front matter 都走属性访问或 `toObject()`。
 * 整站备份/恢复用的是**原生 driver**（`utils/fullBackup.ts` 的 `db.collection(name)`），
 * 完全不经过 mongoose 序列化，所以归档里的 password 原样进、原样出。
 *
 * 具体实现见 `utils/accessPassword.ts` 的 `redactPasswordInPlain`：只在投影**真的
 * select 了 password** 时才动它（键不存在就一个字节都不改），因此公开面
 * （publicView / listView 都没 select password）的响应形状与今天完全一致。
 */
ArticleSchema.set('toJSON', {
  transform: accessPasswordToJson,
});
