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

// ⚠️ `{date,pathname}` 的**唯一**索引不在这里声明，而是由
// `provider/stats/statsMaintenance.provider.ts` 在"先合并重复行、再 createIndex"之后显式建。
// 原因：老库里已经存在并发首访留下的重复行（本机实测 2 组），
// 如果交给 `autoIndex` 在启动时建，第一次启动必然因为 E11000 失败，
// 要等下一次启动才收敛；显式建则一次启动就收敛，且建好之后每次启动只花一次 listIndexes。
// 这个唯一索引是 `VisitProvider.add()` 里那段"重复键兜底"能成立的前提 ——
// 没有它，那段 catch 永远不会触发，并发首访会静默产生重复行。
