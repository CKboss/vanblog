import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ViewerDocument = Viewer & Document;

@Schema()
export class Viewer extends Document {
  @Prop()
  visited: number;

  @Prop()
  viewer: number;

  // ⚠️ 这里**故意不写 `index: true`**：`date` 上的索引由
  // `provider/stats/statsMaintenance.provider.ts` 建成**唯一**索引（同名 `date_1`）。
  // 如果 schema 也声明一份非唯一的，`autoIndex` 每次启动都会发一次
  // `createIndex({date:1})`，与那个唯一索引选项冲突（IndexOptionsConflict），日志天天报错。
  // 唯一索引是必需的：每日快照走 `updateOne({date}, ..., {upsert:true})`，
  // 没有唯一索引时并发（例如多进程部署的零点那一刻）会插出两行同日的快照。
  @Prop()
  date: string;

  @Prop({
    index: true,
    default: () => {
      return new Date();
    },
  })
  createdAt: Date;
}

export const ViewerSchema = SchemaFactory.createForClass(Viewer);
