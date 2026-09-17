import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ArticleRevision, RevisionDocument } from 'src/scheme/revision.schema';
import { wordCount } from 'src/utils/wordCount';
import { sanitizePagination } from 'src/utils/pagination';
import { parseNumericId } from 'src/utils/numericId';

/**
 * 文章历史版本（极简）：只在**保存真的改了 title/content 时**记一条快照，
 * 每篇文章最多保留 `VANBLOG_ARTICLE_REVISIONS_KEEP` 条（默认 **10**，`0` = 关闭 = 老行为），
 * 超限淘汰最旧。快照存的是"被这次保存替换掉的旧状态"（见 scheme/revision.schema.ts）。
 *
 * ⚠️ append 的任何失败都**不能**把文章保存本身带崩：调用方（文章更新路径）
 * 用 `appendSafe()`，内部全捕获、只 WARN。
 */

export const REVISIONS_KEEP_ENV = 'VANBLOG_ARTICLE_REVISIONS_KEEP';
export const DEFAULT_REVISIONS_KEEP = 10;

/** 非法/缺失回落默认值；0 合法（= 关闭）；负数按 0 处理。 */
export function resolveRevisionsKeep(
  raw: string | undefined = process.env[REVISIONS_KEEP_ENV],
  fallback: number = DEFAULT_REVISIONS_KEEP,
): number {
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(0, Math.floor(n));
}

export interface RevisionSnapshot {
  title?: string;
  content?: string;
}

export interface RevisionMeta {
  _id: string;
  articleId: number;
  savedAt: Date;
  title: string;
  wordCount: number;
  sizeBytes: number;
  reason: string;
}

@Injectable()
export class RevisionProvider {
  private readonly logger = new Logger(RevisionProvider.name);

  constructor(
    @InjectModel('Revision')
    private readonly revisionModel: Model<RevisionDocument>,
  ) {}

  /** 当前保留上限（每次现读 env，测试可改；生产环境 env 不会中途变）。 */
  keep(): number {
    return resolveRevisionsKeep();
  }

  enabled(): boolean {
    return this.keep() > 0;
  }

  /**
   * title/content 真的变了才记快照（compare, don't write unconditionally）。
   * `before` 是保存前的旧值，`patch` 是这次要写入的字段（undefined = 这次没改它）。
   * 返回写入的快照（或 null：没变化 / 功能关闭 / 写入失败）。
   */
  async appendIfChanged(
    articleId: number | string,
    before: RevisionSnapshot | null | undefined,
    patch: RevisionSnapshot,
    reason = 'update',
  ): Promise<RevisionDocument | null> {
    if (!this.enabled()) {
      return null;
    }
    const titleChanged =
      typeof patch.title === 'string' && patch.title !== (before?.title ?? undefined);
    const contentChanged =
      typeof patch.content === 'string' && patch.content !== (before?.content ?? undefined);
    if (!titleChanged && !contentChanged) {
      return null;
    }
    return this.append(
      articleId,
      { title: before?.title ?? '', content: before?.content ?? '' },
      reason,
    );
  }

  /** 记一条快照并把该文章的历史修剪到 keep 条。失败抛错（调用方决定要不要吞）。 */
  async append(
    articleIdRaw: number | string,
    snapshot: { title: string; content: string },
    reason = 'update',
  ): Promise<RevisionDocument | null> {
    const keep = this.keep();
    if (keep <= 0) {
      return null;
    }
    const articleId = parseNumericId(articleIdRaw);
    const content = snapshot.content ?? '';
    const doc = await this.revisionModel.create({
      articleId,
      savedAt: new Date(),
      title: snapshot.title ?? '',
      content,
      wordCount: wordCount(content),
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      reason,
    });
    await this.prune(articleId, keep);
    return doc;
  }

  /** 保存失败不影响文章更新本身：全捕获 + WARN。 */
  async appendSafe(
    articleId: number | string,
    before: RevisionSnapshot | null | undefined,
    patch: RevisionSnapshot,
    reason = 'update',
  ): Promise<RevisionDocument | null> {
    try {
      return await this.appendIfChanged(articleId, before, patch, reason);
    } catch (err) {
      this.logger.warn(
        `写入文章历史版本失败（文章 ${articleId}，不影响本次保存）：${
          (err as Error)?.message || err
        }`,
      );
      return null;
    }
  }

  /** 淘汰最旧的，只留 keep 条（按 savedAt 倒序，_id 兜底同刻并列）。 */
  async prune(articleIdRaw: number | string, keep: number): Promise<number> {
    const articleId = parseNumericId(articleIdRaw);
    if (!Number.isFinite(keep) || keep < 0) {
      return 0;
    }
    const stale = await this.revisionModel
      .find({ articleId }, { _id: 1 })
      .sort({ savedAt: -1, _id: -1 })
      .skip(keep)
      .exec();
    if (!stale.length) {
      return 0;
    }
    const res = await this.revisionModel
      .deleteMany({ _id: { $in: stale.map((d: any) => d._id) } })
      .exec();
    return res?.deletedCount || 0;
  }

  /** 元数据列表（**不含 content**）：按 savedAt 倒序分页。 */
  async listMeta(
    articleIdRaw: number | string,
    page?: unknown,
    pageSize?: unknown,
  ): Promise<{ revisions: RevisionMeta[]; total: number }> {
    const articleId = parseNumericId(articleIdRaw);
    const paging = sanitizePagination(page, pageSize, { defaultPageSize: 20 });
    const filter = { articleId };
    const [rows, total] = await Promise.all([
      this.revisionModel
        .find(filter, { content: 0 })
        .sort({ savedAt: -1, _id: -1 })
        .skip(paging.skip)
        .limit(paging.pageSize)
        .exec(),
      this.revisionModel.countDocuments(filter).exec(),
    ]);
    return {
      revisions: rows.map((row: any) => this.toMeta(row)),
      total,
    };
  }

  /** 取单条（含 content）。revisionId 不属于这篇文章时返回 null（防跨文章越权读）。 */
  async getOne(
    articleIdRaw: number | string,
    revisionId: string,
  ): Promise<RevisionDocument | null> {
    const articleId = parseNumericId(articleIdRaw);
    if (!revisionId || !Types.ObjectId.isValid(revisionId)) {
      return null;
    }
    return this.revisionModel.findOne({ articleId, _id: revisionId }).exec();
  }

  async countFor(articleIdRaw: number | string): Promise<number> {
    return this.revisionModel.countDocuments({ articleId: parseNumericId(articleIdRaw) }).exec();
  }

  /** 文章被 purge（回收站彻底删除）时清掉它的全部历史版本。 */
  async deleteForArticle(articleIdRaw: number | string): Promise<number> {
    const res = await this.revisionModel
      .deleteMany({ articleId: parseNumericId(articleIdRaw) })
      .exec();
    return res?.deletedCount || 0;
  }

  private toMeta(row: any): RevisionMeta {
    const doc = typeof row?.toObject === 'function' ? row.toObject() : row;
    return {
      _id: String(doc?._id),
      articleId: Number(doc?.articleId),
      savedAt: doc?.savedAt,
      title: String(doc?.title ?? ''),
      wordCount: Number(doc?.wordCount) || 0,
      sizeBytes: Number(doc?.sizeBytes) || 0,
      reason: String(doc?.reason ?? ''),
    };
  }
}

/** revisionModel 上真正会用到的最小面（供测试伪造） */
export type RevisionModelLike = Pick<
  Model<ArticleRevision>,
  'create' | 'find' | 'findOne' | 'countDocuments' | 'deleteMany'
>;
