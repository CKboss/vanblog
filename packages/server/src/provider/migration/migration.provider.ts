import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Migration, MigrationDocument } from 'src/scheme/migration.schema';
import { version } from 'src/utils/loadConfig';

/**
 * 迁移/数据清洗台账（`migrations` 集合）。
 *
 * 定位是**可观测性**，不是"跑过就跳过"的闸门：
 * - 所有启动清洗（main.ts）、统计表维护（statsMaintenance）、流水线脚本落盘（pipeline）、
 *   总字数重算（meta）、后台触发的回填（article.provider 的 backfill*）都往这里记一条；
 * - 幂等清洗与索引维护**每次启动照跑**（本 provider 绝不代替它们做"要不要跑"的决定）；
 * - 每条记录 = 一个 key 一行（upsert 覆盖），字段含义与"为什么不记全量历史"
 *   见 scheme/migration.schema.ts 顶部注释。
 *
 * ⚠️ 台账写入本身绝不能把被记录的清洗带崩：`record()` 永不抛错（写失败只 WARN）。
 * ⚠️ outcome === 'error' 时必须 WARN（任务要求：绝不静默吞掉迁移失败）。
 */

// 'install'：安装事件记录（`install:initialised`，见 provider/init/init.provider.ts 的
// recordInstallation）。它不是数据修复，但台账是**唯一**"每 key 一行、有界、后台可读
// （GET /api/admin/migration/list）、error 必 WARN"的持久记录面 —— 匿名初始化窗口被抢占时，
// 这一行是站长事后唯一能拿到的归因证据（谁、什么时候、从哪个 IP 初始化的本站）。
// schema 里 kind 本来就是普通 string（无 enum 约束），加值是向后兼容的。
export type MigrationKind =
  | 'wash'
  | 'index'
  | 'backfill'
  | 'recompute'
  | 'sync'
  | 'prune'
  | 'install';
export type MigrationOutcome = 'ok' | 'skipped' | 'error';

/** detail 落库前的截断长度：台账是给人看的，不该存下整个清洗结果集 */
export const DETAIL_MAX_CHARS = 2000;

export interface MigrationRunSpec {
  key: string;
  kind: MigrationKind;
}

export interface MigrationRecordEntry extends MigrationRunSpec {
  outcome: MigrationOutcome;
  durationMs: number;
  /** 字符串直接存；对象/数组 JSON 序列化后存；一律截断到 DETAIL_MAX_CHARS */
  detail?: unknown;
  ranAt?: Date;
}

export function detailToString(detail: unknown): string {
  if (detail === undefined || detail === null) {
    return '';
  }
  const text = typeof detail === 'string' ? detail : safeJson(detail);
  if (text.length <= DETAIL_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, DETAIL_MAX_CHARS)}…(截断，原长 ${text.length})`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // 循环引用之类的怪对象：退化成 String()，台账宁可粗糙也不能抛
    return String(value);
  }
}

@Injectable()
export class MigrationProvider {
  private readonly logger = new Logger(MigrationProvider.name);

  constructor(
    @InjectModel('Migration')
    private readonly migrationModel: Model<MigrationDocument>,
  ) {}

  /**
   * 记一条台账。**永不抛错**：写不进去（Mongo 抖动/唯一索引冲突之外的错）只 WARN，
   * 因为被记录的清洗本身可能已经成功了，台账失败不该反过来把它变成失败。
   */
  async record(entry: MigrationRecordEntry): Promise<void> {
    const ranAt = entry.ranAt || new Date();
    const detail = detailToString(entry.detail);
    try {
      const set: Record<string, unknown> = {
        kind: entry.kind,
        ranAt,
        durationMs: Math.max(0, Math.round(entry.durationMs) || 0),
        outcome: entry.outcome,
        detail,
        codeVersion: version,
      };
      if (entry.outcome === 'error') {
        set.lastError = detail || '(无错误信息)';
        set.lastErrorAt = ranAt;
      }
      await this.migrationModel.updateOne(
        { key: entry.key },
        {
          $set: set,
          $inc: { runs: 1 },
          $setOnInsert: { key: entry.key, firstRanAt: ranAt },
        },
        { upsert: true },
      );
      if (entry.outcome === 'error') {
        // 任务要求：迁移报 error 必须 WARN，绝不静默
        this.logger.warn(
          `迁移台账记录到失败：key=${entry.key} kind=${entry.kind} 耗时=${set.durationMs}ms 原因=${detail}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `写迁移台账失败（不影响清洗本身）：key=${entry.key} reason=${
          (err as Error)?.message || err
        }`,
      );
    }
  }

  /** 守卫决定不跑时记 skipped（如：唯一索引已存在、env 关闭、cluster worker）。 */
  async recordSkipped(spec: MigrationRunSpec, detail?: MigrationRecordEntry['detail']): Promise<void> {
    await this.record({ ...spec, outcome: 'skipped', durationMs: 0, detail });
  }

  /**
   * 包一段清洗逻辑：计时、成功记 ok（detail 由结果算出）、失败记 error + WARN 后**原样重抛**
   * （调用方今天的错误语义一个字不变）。
   */
  async run<T>(
    spec: MigrationRunSpec,
    task: () => Promise<T>,
    options?: {
      detail?: (result: T) => MigrationRecordEntry['detail'];
    },
  ): Promise<T> {
    const started = Date.now();
    try {
      const result = await task();
      await this.record({
        ...spec,
        outcome: 'ok',
        durationMs: Date.now() - started,
        detail: options?.detail ? options.detail(result) : undefined,
      });
      return result;
    } catch (err) {
      await this.record({
        ...spec,
        outcome: 'error',
        durationMs: Date.now() - started,
        detail: (err as Error)?.message || String(err),
      });
      throw err;
    }
  }

  /** 后台「迁移台账」列表：按最近运行时间倒序。 */
  async list(): Promise<Migration[]> {
    return this.migrationModel.find({}).sort({ ranAt: -1 }).exec();
  }

  /**
   * 启动收尾时把所有 outcome==='error' 的 key 汇总 WARN 一遍。
   *
   * 为什么还要这个（record 时已经 WARN 过）：fire-and-forget 的清洗
   * （统计表维护、流水线依赖安装）的失败可能淹没在启动日志流里，
   * 这里在启动完成点再点一次名，保证"这个实例有哪些数据修复是坏的"一眼可见。
   * 返回出错的 key 列表（供测试断言）。
   */
  async warnAboutErrors(context: string): Promise<string[]> {
    try {
      const broken = await this.migrationModel
        .find({ outcome: 'error' }, { key: 1, lastError: 1, lastErrorAt: 1 })
        .exec();
      if (broken.length) {
        this.logger.warn(
          `[${context}] 有 ${broken.length} 条迁移/清洗最近一次运行失败：${broken
            .map((b: any) => `${b.key}（${b.lastError || '无错误信息'}）`)
            .join('；')}`,
        );
      }
      return broken.map((b: any) => String(b.key));
    } catch (err) {
      this.logger.warn(`读取迁移台账失败（${context}）：${(err as Error)?.message || err}`);
      return [];
    }
  }
}

/**
 * 给"台账还没注册进 app.module / 单测里直接 new"的场景用的空实现：
 * 所有方法都是 no-op，调用方不需要判空。
 */
export const NOOP_MIGRATION_RECORDER: Pick<
  MigrationProvider,
  'record' | 'recordSkipped' | 'run' | 'list' | 'warnAboutErrors'
> = {
  async record() {
    // no-op
  },
  async recordSkipped() {
    // no-op
  },
  async run(_spec, task) {
    return task();
  },
  async list() {
    return [];
  },
  async warnAboutErrors() {
    return [];
  },
};
