import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type VisitDocument = Visit & Document;

@Schema()
export class Visit extends Document {
  @Prop()
  visited: number;

  @Prop()
  viewer: number;

  @Prop({ index: true })
  date: string;

  @Prop({ index: true })
  pathname: string;

  @Prop({ index: true })
  lastVisitedTime: Date;

  @Prop({
    index: true,
    default: () => {
      return new Date();
    },
  })
  createdAt: Date;
}

export const VisitSchema = SchemaFactory.createForClass(Visit);

// 「某个路径最近一天的访问」是热查询（公开接口 GET /api/public/article/viewer/:id 每次浏览都查，
// 写路径里的 getLastData 也查）。只有单列索引时，planner 会选 date_1 倒着扫再逐条过滤 pathname ——
// 实测一个 6 天没访问的路径要 examined=125 个索引键，天数越久扫得越多（冷路径等于扫全表）。
// 复合索引 {pathname, date:-1} 让它直接定位到该路径的最新一条。
VisitSchema.index({ pathname: 1, date: -1 });
