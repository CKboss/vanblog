import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes } from 'mongoose';
import { CategoryType } from 'src/types/category.dto';
import { accessPasswordToJson } from 'src/utils/accessPassword';

export type CategoryDocument = Category & Document;

@Schema()
export class Category extends Document {
  @Prop({ index: true, unique: true })
  id: number;

  @Prop({ unique: true, index: true })
  name: string;

  @Prop({ default: 'category', index: true })
  type: CategoryType;

  @Prop({ default: false, index: true })
  private: boolean;

  @Prop({ default: false, index: true })
  hidden: boolean;

  @Prop({ default: 0, index: true })
  order: number;

  /**
   * 分类访问密码（分类加密后，**该分类下所有文章**都用它解锁，见
   * `ArticleProvider.getByIdWithPassword`）。存 scrypt 哈希，历史文档可能还是明文；
   * 校验一律走 `verifyAccessPassword`（两种都认）。字段本身永不下发（见文件末尾）。
   * 注意这里**没有 default**：老文档可能整个键都不存在，所以 `hasPassword` 也可能
   * 整个键都不出现 —— 消费方一律按 `Boolean(x)` 读。
   */
  @Prop()
  password: string;

  @Prop({ type: SchemaTypes.Mixed })
  meta?: object;
}

export const CategorySchema = SchemaFactory.createForClass(Category);

/**
 * 与 `ArticleSchema` 完全同一套脱敏：分类文档被 JSON 序列化时，`password` 换成布尔
 * `hasPassword`。理由与边界（为什么挂 toJSON、为什么内部路径不受影响、为什么整站
 * 备份不受影响）见 `scheme/article.schema.ts` 末尾那段注释与 `utils/accessPassword.ts`。
 *
 * 这条尤其重要：`GET /api/admin/category/all?detail=true` 以前把**明文密码**直接
 * 发给后台（分类编辑弹窗靠它回填），而那个路由还在 publicRoutes 里 —— 协作者分支
 * 是控制器手工 `delete plain.password` 挡的，管理员分支则一路裸奔到浏览器。
 */
CategorySchema.set('toJSON', {
  transform: accessPasswordToJson,
});
