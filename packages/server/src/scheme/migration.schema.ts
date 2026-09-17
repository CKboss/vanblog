import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MigrationDocument = Migration & Document;

/**
 * 一条迁移/数据清洗台账记录。
 *
 * 背景：这个项目历来没有迁移工具，所有数据修复都是「启动时跑一遍的幂等清洗」
 * （visits 去重、建唯一索引、删冗余索引、密码加盐、菜单/分类/自定义页面清洗、
 * 总字数重算、流水线脚本落盘……）。修了什么、什么时候修的、成功没有，
 * 以前只散落在日志里，机器一换就无从查起。
 *
 * 设计决定（有测试钉住）：
 * - **每个 key 只有一行**（`key` 唯一索引），每次运行 upsert 覆盖：启动清洗每次开机都跑，
 *   若按 `key+ranAt` 记全量历史，行数会随重启次数**无界增长**（watch 模式一天能重启上百次）。
 *   一行一个 key 的总量上界 = 迁移种类数（十几条），这是最紧的界。
 * - 历史的"最小必要信息"保留在字段里：`runs`（累计运行次数）、`firstRanAt`（第一次运行时间）、
 *   `lastError` / `lastErrorAt`（最近一次失败，即使后来的运行成功了也保留 —— 失败不该被冲掉）。
 * - 未来加**破坏性**迁移时，`key` 唯一 + `runs` 就是天然的"只跑一次"闸门
 *   （跑之前查 ledger，`runs >= 1` 且 outcome==='ok' 就跳过）。
 */
@Schema()
export class Migration extends Document {
  /** 稳定标识，如 `wash:userSalt` / `index:visits.date_pathname.unique`。唯一。 */
  @Prop({ required: true, unique: true })
  key: string;

  /** wash（数据清洗）/ index（索引维护）/ backfill（回填）/ recompute（重算缓存值）/ sync（磁盘-库同步）/ prune（按保留期清理，破坏性） */
  @Prop({ required: true })
  kind: string;

  /** 最近一次运行时间 */
  @Prop({
    required: true,
    index: true,
    default: () => new Date(),
  })
  ranAt: Date;

  /** 最近一次运行耗时（毫秒） */
  @Prop({ default: 0 })
  durationMs: number;

  /** 最近一次运行结果 */
  @Prop({ default: 'ok' })
  outcome: 'ok' | 'skipped' | 'error';

  /** 人类可读的结果摘要（写入前会被截断，见 migration.provider 的 DETAIL_MAX_CHARS） */
  @Prop({ default: '' })
  detail: string;

  /** 运行时版本（VAN_BLOG_VERSION，dev 环境为 'dev'） */
  @Prop({ default: '' })
  codeVersion: string;

  /** 累计运行次数（含 skipped / error） */
  @Prop({ default: 0 })
  runs: number;

  /** 第一次运行时间（upsert 时 $setOnInsert，之后不再变） */
  @Prop({ type: Date, default: null })
  firstRanAt: Date | null;

  /** 最近一次失败的错误信息（成功后不清除：失败历史不该被冲掉） */
  @Prop({ default: '' })
  lastError: string;

  /** 最近一次失败的时间 */
  @Prop({ type: Date, default: null })
  lastErrorAt: Date | null;
}

export const MigrationSchema = SchemaFactory.createForClass(Migration);
